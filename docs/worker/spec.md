# Worker仕様書

## 1. 目的

本仕様書は、オンデマンドビデオ教材受講完了検証システムにおける画像推論Workerの仕様を定義する。

Workerは、Service Busから映像フレーム参照を受信し、Blob Storageから単独でデコード可能なJPEGフレームを取得して画像フレームを復元する。その後、MediaPipe Face Landmarkerにより顔ランドマークを取得し、EAR・Pitch・Yaw、PERCLOSベースの眠気スコアを算出する。

## 2. 根拠

本仕様は二次仕様である。処理の受け入れ条件、永続化責務、失敗処理は `docs/features/04-frame-storage-and-queue.md`、`07-calibration.md`、`08-drowsiness-scoring.md`、`09-realtime-notification.md`、`15-elastic-session-frame-processing.md` と対象scenarioを一次情報とし、本書はWorkerの実装責務だけを補足する。

### 2.1 proposal.md に基づく事項

- Worker技術は Python / MediaPipe / OpenCV とする。
- Azure Container Apps Worker上で動作する。
- Service BusからBlob参照情報を受け取る。
- Blob Storageから映像データを取得する。
- MediaPipe Face Landmarkerで顔ランドマークを取得する。
- EAR・Pitch・Yawを算出する。
- Redis上のスライディングウィンドウを用いてPERCLOSベースの眠気スコアを算出する。
- 5フレームの平均値を1秒単位で算出する。
- Backendのサービス認証済み解析結果APIを通じて、PostgreSQL保存とSignalR通知を依頼する。

### 2.2 承認済み仕様決定

- Workerは各Blobを単独でデコード可能な `image/jpeg` として処理し、フレーム間のデコーダ状態を保持しない。
- `sequenceNo` の欠落または順序不整合があっても、後続の有効JPEGフレームを破棄しない。
- Worker再起動後も、次に受信した有効JPEGフレームからただちに処理を再開する。
- RedisはPERCLOSスライディングウィンドウ、処理済みフレームの冪等性、その他の推論状態管理に使用する。
- キャリブレーションは5秒間、25フレームで行う。
- 有効フレームが15フレーム未満の場合、キャリブレーション失敗とする。
- 正面向き判定は `|Yaw_deg| <= 15` かつ `|Pitch_deg| <= 15` とする。
- 顔未検出フレームはPERCLOS計算に含めず、顔未検出通知を送信する。
- Session単位の水平分散、Session slot、graceful shutdown、autoscaleの受け入れ条件は [`15-elastic-session-frame-processing.md`](../features/15-elastic-session-frame-processing.md) を正とする。
- Workerはframe upload endpointを呼ばない。ACA環境では `WORKER_BACKEND_BASE_URL` をBackend ACA ingressへ設定し、Workerが接続するBackend HTTP endpointは`/health/ready`とサービス認証済み`/api/sessions/{sessionId}/analysis-results`だけとする。

## 3. 処理概要

```text
Service Bus
→ Blob Storageから独立JPEGフレーム取得
→ 単独JPEGデコード
→ 画像フレーム復元
→ MediaPipe Face Landmarker
→ EAR / Pitch / Yaw算出
→ Redisスライディングウィンドウ更新
→ PERCLOSベース眠気スコア算出
→ Backend解析結果API
→ BackendのPostgreSQL保存・Outbox通知
```

## 4. Service Bus処理仕様

### 4.1 メッセージ形式

WorkerはService Busから以下のメッセージを受信する。

```json
{
  "sessionId": "uuid",
  "sequenceNo": 1,
  "blobPath": "sessions/3f8c.../frames/000001.bin",
  "capturedAt": "2026-06-14T10:00:00.000Z",
  "videoTimeSec": 123.45,
  "receivedAt": "2026-06-14T10:00:00.050Z",
  "codec": "image/jpeg"
}
```

### 4.2 順序処理と完了条件

Service Busでは `sessionId` をSession IDとして使用する。WorkerはSession有効queueから同一 `sessionId` のメッセージを順序どおりに処理し、同一Sessionを並行処理しない。

- Blob取得、JPEGデコード、順序どおりのSession状態更新、およびそのフレーム由来のBackend解析結果API受理のすべてが成功した場合だけ `complete` する。
- Blob取得の一時失敗、Backendのtimeout・接続失敗・5xx・429、Redis一時障害は `abandon` して再配送する。最大配送回数に達した場合はdead-letterする。WorkerログではBackend API URL、token、payload、学生IDを出さず、timeout、接続失敗、HTTP応答を区別して記録する。
- Blob path不正、対応外codec、payload検証エラー、Worker資格情報の失効など再試行不能なエラーはdead-letterする。
- 重複配送は `sessionId` と `sequenceNo` で冪等に無視する。`sequenceNo` の欠落・順序不整合は後続の独立JPEGを破棄する理由にしない。
- `NEXT_AVAILABLE_SESSION` で受信する場合、Workerはreceiver作成時に5秒のセッション取得タイムアウトを指定する。空queueでセッションを取得できない場合、SDKは `OperationTimeoutError` を返す。これは異常ではないためWorkerはwarningを出さずreceiverを閉じ、次回pollで再試行する。これにより、セッション取得待機中にbrokerのアイドルリンク切断を受けない。
- Worker replica は正の整数の `WORKER_SESSION_CONCURRENCY` 個までの Session slot を持てる。未設定時は後方互換のため1とし、`0`、負数、非数値は起動時に失敗する。各 slot はreceiver、Session解析状態、MediaPipe Face Landmarkerを独立して所有し、一つの Session を直列処理する。JPEGデコードは状態を持たず、異なる Session だけを slot 間で並列処理する。
- 停止シグナルまたはscale-in時は新しいSessionの取得を止める。すでに開始したフレームだけはlock有効時にsettleできるが、先読み済みで未開始のメッセージはreceiverを閉じて再配送に委ねる。`WORKER_SHUTDOWN_TIMEOUT_SECONDS`（既定30秒、正のduration）を超えてslotが終了しない場合はreceiverを閉じ、Workerは無期限に待機しない。
- Workerは `AutoLockRenewer` によりセッションロックを最大5分間更新する。ロック更新失敗またはロック失効後は、そのメッセージを `complete`、`abandon`、dead-letterしない。receiverを閉じて残りの先読みメッセージの処理を中断し、次回pollでセッションを再取得してService Busの再配送を処理する。ロック失効でWorkerプロセスを停止させない。

目的:

- セッション単位のキャリブレーション、PERCLOS、眠気スコア状態を順序どおり更新する。
- 解析結果を永続化前に失わない。

## 5. Blob Storage取得仕様

WorkerはService Busメッセージ内の `blobPath` を用いて、Blob Storageからエンコード済み映像フレームを取得する。

Blobパス形式:

```text
sessions/{sessionId}/frames/{sequenceNo}.bin
```

現行実装では `{sequenceNo}` をゼロ埋めしてよい。

例:

```text
sessions/3f8c.../frames/000001.bin
sessions/3f8c.../frames/000002.bin
```

Blob Storage上の保存期間・削除方針は [`15-elastic-session-frame-processing.md`](../features/15-elastic-session-frame-processing.md) を一次情報とする。Workerは通常の再配送またはdead-letter調査に必要なフレームがLifecycle Ruleにより早期削除されない前提で処理する。

## 6. 独立JPEGフレームデコード仕様

### 6.1 デコード契約

- `codec` は `image/jpeg` でなければならない。
- 各Blobは単独でデコード可能なJPEGバイナリであり、前後のフレームまたはWorkerのデコーダ状態に依存しない。
- WorkerはOpenCVでJPEGを画像フレームへ復元してMediaPipe推論へ渡す。

### 6.2 処理手順

Workerは各メッセージについて以下を行う。

1. `sessionId`、`sequenceNo`、canonicalな `blobPath`、UTCの `capturedAt`、0以上の有限値である `videoTimeSec`、および `codec: image/jpeg` を検証する。
2. BlobからJPEGバイナリを取得する。
3. JPEGを単独でデコードして画像フレームを復元する。
4. 復元した画像フレームをMediaPipe推論へ渡す。

### 6.3 欠落・再起動時の扱い

フレームの欠落または `sequenceNo` の不連続を検知しても、Workerは後続の有効JPEGを破棄しない。欠落フレームはPERCLOSのサンプル不足として扱い、次の有効フレームから通常どおり解析する。

Worker再起動後も、次に受信した有効JPEGを過去フレームに依存せずにデコードして処理する。Service Bus Sessionによる直列処理は、キャリブレーション、PERCLOS、眠気スコア状態の順序更新とRedis冪等性のために維持する。

## 7. 顔ランドマーク推論仕様

### 7.1 推論ライブラリ

MediaPipe Face Landmarkerを使用する。

### 7.2 入力

単独でデコードしたJPEG画像フレームを入力とする。

### 7.3 出力

推論結果から以下を算出する。

- EAR
- Pitch_deg
- Yaw_deg

## 8. キャリブレーション仕様

### 8.1 実施タイミング

セッション開始時に5秒間実施する。

5fps相当であるため、対象は25フレームである。

### 8.2 有効フレーム条件

キャリブレーションに使用する有効フレームは以下を満たす。

```text
顔が検出できる
|Yaw_deg| <= 15
|Pitch_deg| <= 15
```

### 8.3 成功条件

5秒間で有効フレームが15フレーム以上の場合、キャリブレーション成功とする。

### 8.4 失敗条件

有効フレームが15フレーム未満の場合、キャリブレーション失敗とする。

失敗時は、フロントエンドに再キャリブレーションを促す。

キャリブレーション完了まで動画再生は開始しない。

### 8.5 EAR_openと閉眼閾値

有効フレームのEAR中央値を `EAR_open` として算出し、成功結果だけをBackend解析結果APIへ送る。BackendがDB保存を所有する。

閉眼閾値は以下で算出する。

```text
EAR_threshold = EAR_open × 0.75
```

payloadには `sourceSequenceNo` を含める。Backendは成功セッション当たり1件の `calibrations` を冪等保存し、通知Outboxを同一トランザクションで登録する。

## 9. 顔未検出時の扱い

顔未検出フレームはPERCLOS計算に含めない。

顔未検出フレーム単体では `drowsiness_scores` に保存しない。

Workerは以下の通知payloadをBackend解析結果APIへ送信する。SignalR配信はBackendのOutboxが担う。

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

顔未検出時の動画停止はフロントエンドが受信した `tracking_status` に基づいて行う。Workerは停止を直接制御しない。

次に顔が検出できた時点で推論とスコア算出を再開する。

## 10. PERCLOSスライディングウィンドウ仕様

### 10.1 ウィンドウ

PERCLOSは以下の条件で算出する。

```text
15秒スライディングウィンドウ
75フレーム
```

### 10.2 Redis状態管理

Redis上に `perclos:{sessionId}:frames` キーでセッションごとのスライディングウィンドウ状態を保持する。値は `sequenceNo`、`capturedAt`、閉眼判定を含み、顔未検出フレームは追加しない。別キー `processed:{sessionId}:frame:{sequenceNo}` にセッション有効期間をカバーするTTLを設定し、PERCLOSの15秒窓とは独立して処理済みフレームを永続化する。TTLは一次仕様に従い、重複 `sequenceNo` を無視する。

Luaスクリプトで原子的に以下を行う。

```text
LPUSH
LTRIM
LRANGE
EXPIRE
```

用途:

- Workerのスケールアウト時の競合防止
- セッションごとのPERCLOS状態共有

### 10.3 閉眼判定

キャリブレーションにより得た `EAR_threshold` を用いる。

```text
EAR < EAR_threshold の場合、閉眼フレームとして扱う
```

## 11. 眠気スコア算出仕様

### 11.1 スコア式

`docs/proposal.md` の式を使用する。

```text
w_yaw = max(1.0 − |Yaw_deg| / 45.0, 0.0)
EAR_score = min(PERCLOS / 0.5, 1.0) × w_yaw
score = min(EAR_score × (1 + 0.3 × min(Pitch_deg / 30.0, 1.0)), 1.0)
```

### 11.2 眠気レベル

```text
normal:  score < 0.25
caution: 0.25 <= score < 0.50
warning: 0.50 <= score < 0.75
danger:  0.75 <= score <= 1.00
```

### 11.3 自動停止判定

```text
level == danger
または
score >= 0.75
```

この場合、Backendへ送る解析結果payloadの `shouldPause` を `true` とする。

## 12. 1秒単位結果送信

Workerは `capturedAt` のUTC秒ごとに最大5件を集計し、5件未満のまま次秒へ進んだ窓は破棄する。5件揃った窓の末尾sequence、UTC秒の `scoredAt`、および末尾フレームから受け取った `videoTimeSec` を付与してBackend解析結果APIへ送る。`videoTimeSec` は動画教材内の再生位置（秒）であり、Workerがフレーム番号またはFPSから算出・補完しない。WorkerはPostgreSQLへ直接接続・直接保存しない。

Backendが所有する保存先:

```text
drowsiness_scores
- session_id
- source_sequence_no
- scored_at
- video_time_sec nullable（既存スコアは `null`、新規スコアは必須）
- score
- level
- perclos
- ear
- pitch_deg
- yaw_deg
```

Workerが送る保存対象は `sourceSequenceNo`、`videoTimeSec`、score、level、perclos、ear、pitchDeg、yawDegである。新規スコアの `videoTimeSec` は0以上の有限値を必須とする。`tracking_status` にも `sourceSequenceNo` を含める。Backendは `(session_id, source_sequence_no)` およびtrackingの冪等キーで冪等受理し、同じトランザクションで通知Outboxを作成する。顔未検出のみの期間は、スコア保存対象としない。

## 13. Backend解析結果API payload

WorkerはSignalRへ直接接続しない。`POST /api/sessions/{sessionId}/analysis-results` に、productionではAzure Managed IdentityによるOAuth 2.0 client-credentials Bearer token、localでは環境変数の `WORKER_API_KEY` を `X-Worker-Api-Key` として送る。Backendだけがこれを `analysis_worker` として認証し、保存とOutbox配信を行う。

### 13.1 眠気スコアpayload

```json
{
  "type": "drowsiness_score",
  "sessionId": "uuid",
  "scoredAt": "2026-06-14T10:00:00Z",
  "videoTimeSec": 123.45,
  "score": 0.82,
  "level": "danger",
  "perclos": 0.61,
  "ear": 0.18,
  "pitchDeg": 12.4,
  "yawDeg": 4.2,
  "shouldPause": true
}
```

### 13.2 顔未検出payload

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

## 14. 永続化境界

WorkerはPostgreSQLへ接続しない。`calibrations`、`drowsiness_scores`、`analysis_event_outbox` のschema・migration・トランザクションはBackendが所有する。WorkerはBackendが `202 Accepted` を返すまでService Busメッセージを完了しない。

## 15. 実装ディレクトリ構成

Worker実装は、以下の3領域に分ける。

```text
src/worker/
  app/      # 本番Workerアプリケーション
  shared/   # 本番WorkerとGUI検証アプリで共通利用する解析ロジック
  gui/      # ローカルGUI検証アプリケーション
```

### 15.1 app

`app` は本番Workerの外部I/Oと実行制御を担う。

主な責務:

- Service Busからのフレーム参照メッセージ受信
- Blob Storageからのフレーム取得
- 単独でデコード可能なJPEGフレームのデコード
- `shared` の顔解析・キャリブレーション・眠気スコア算出ロジック呼び出し
- RedisとBackend解析結果APIとの接続（PostgreSQLとSignalRはBackendが所有）
- 本番環境向け設定読み込み

### 15.2 shared

`shared` は本番WorkerとローカルGUI検証アプリの共通ロジックを担う。

主な責務:

- 顔検出・顔ランドマーク推定
- EAR算出
- Pitch / Yaw算出
- キャリブレーション状態管理
- `EAR_open` / `EAR_threshold` 算出
- PERCLOSおよび眠気スコア算出
- 眠気レベル判定
- `shouldPause` 判定

`shared` にはService Bus、Blob Storage、PostgreSQL、Redis、SignalR、GUI描画などの外部I/Oを置かない。

### 15.3 gui

`gui` はローカル上で起動するGUI検証アプリケーションを担う。

主な責務:

- Webカメラ映像取得
- OpenCVなどによるローカルGUI表示
- `shared` の解析ロジック呼び出し
- 顔ランドマーク、目ランドマーク、EAR、Pitch、Yaw、PERCLOS、score、level、`shouldPause` の可視化
- キャリブレーション開始/リセットなどの手動操作

`gui` はローカル検証用であり、本番のService Bus、Blob Storage、PostgreSQL、Redis、SignalRには接続しない。

詳細は `docs/worker/local-gui-and-shared-architecture.md` に定義する。

## 16. Worker app 実行仕様

`src/worker/app/main.py` は、Backendが保存・キュー投入したフレームを処理するWorker本体である。

### 16.1 入力

Azure構成では以下を使用する。

- Service Bus queue: フレーム参照メッセージ
- Blob Storage: `blobPath` のフレームバイナリ

Worker本体はService Bus / Blob Storageを必須入力とし、設定未指定時にローカル保存先へフォールバックしない。

ローカル開発では、devcontainer上のService Bus EmulatorおよびAzurite Blob Storageを接続先として設定する。

### 16.2 処理

1. フレーム参照とフレームバイナリを取得する。
2. `FrameDecoder` で `image/jpeg` を画像フレームへ復元する。
3. `FaceAnalyzer` でEAR、Pitch、Yawを算出し、画像フレームごとにINFOログを出力する。ログには `sessionId`、`sequenceNo`、顔検出有無、EAR、Pitch、Yawを含める。画像バイナリや認証情報は記録しない。
4. セッションごとに `CalibrationTracker` を保持し、初回フレームから25フレームでキャリブレーションする。
5. キャリブレーション成功後、RedisのPERCLOS状態を更新し、`DrowsinessScorer` でscore、level、`shouldPause` を算出する。
6. 顔未検出時は `tracking_status` payloadをBackendへ送る。
7. 眠気スコア算出時は `drowsiness_score` payloadをBackendへ送る。

### 16.3 出力

Workerの出力先は全環境でBackend解析結果APIである。

```http
POST /api/sessions/{sessionId}/analysis-results
```

payloadは `13.1` / `13.2` と同じ `drowsiness_score` または `tracking_status`、キャリブレーション時は `calibration_status` とする。Workerは成功したBackend受理後だけService Busメッセージを完了する。

### 16.4 設定

| 設定 | 用途 | 既定値 |
| --- | --- | --- |
| `WORKER_MODEL_PATH` | MediaPipeモデルパス | `src/worker/models/face_landmarker.task` |
| `WORKER_BACKEND_BASE_URL` | Backend publish先 | `http://localhost:5194` |
| `WORKER_BACKEND_HEALTH_URL` | Backend疎通確認先。未指定時はBackend publish先をGETする | 未設定 |
| `WORKER_POLL_INTERVAL_SECONDS` | Service Bus受信ループの待機間隔 | `0.2` |
| `WORKER_SESSION_CONCURRENCY` | 一つのWorker replicaが同時に所有するSession slot数。正の整数で、同一Sessionを複数slotで処理しない | `1`（後方互換） |
| `WORKER_POST_TIMEOUT_SECONDS` | Backend publish timeout | `3.0` |
| `WORKER_API_KEY` | ローカルでのBackend `analysis_worker` 認証用秘密値 | 必須（local） |
| `WORKER_AUTH_MODE` | WorkerのBackend認証方式。`api_key` または `entra_id` | localは`api_key`、productionは`entra_id` |
| `WORKER_BACKEND_TOKEN_SCOPE` | 本番Managed Identityが取得するBackend API audience / scope | 必須（production） |
| `REDIS_CLUSTER_MODE` | `true` の場合、Azure Managed Redis OSS Cluster 用の Redis Cluster client を使う。ローカル単一Redisでは `false` のままとする。 | `false` |
| `WORKER_BACKEND_CLIENT_ID` | User-assigned Managed Identityを選択する場合のclient ID。未設定時はDefaultAzureCredentialの既定選択 | 任意（production） |
| `REDIS_CONNECTION_STRING` | PERCLOS状態用Redis接続。`redis://` / `rediss://` / `unix://` URLを推奨する。ローカルdevcontainerのBackend共有設定である `redis:6379,password=<REDIS_PASSWORD>` もWorkerがURLへ正規化して受け付ける | 必須 |
| `WORKER_STARTUP_CHECK_TIMEOUT_SECONDS` | 起動時疎通確認timeout | `3.0` |
| `WORKER_HEALTH_HOST` | health endpoint bind host | `0.0.0.0` |
| `WORKER_HEALTH_PORT` | health endpoint port | `8000` |
| `AZURE_SERVICE_BUS_CONNECTION_STRING` / `Azure__ServiceBus__ConnectionString` / `SERVICEBUS_CONNECTION_STRING` | Service Bus接続。未設定時は起動失敗 | 必須 |
| `AZURE_SERVICE_BUS_FRAME_QUEUE_NAME` / `Azure__ServiceBus__FrameQueueName` / `SERVICEBUS_QUEUE_NAME` | フレームqueue名。未設定時は起動失敗 | 必須 |
| `AZURE_BLOB_STORAGE_CONNECTION_STRING` / `Azure__BlobStorage__ConnectionString` / `BLOB_CONNECTION_STRING` | Blob Storage接続。未設定時は起動失敗 | 必須 |
| `AZURE_BLOB_STORAGE_CONTAINER_NAME` / `Azure__BlobStorage__ContainerName` / `BLOB_CONTAINER_NAME` | Blob container名 | `frames` |

Worker起動時は、現行 `src/worker/app/main.py` が直接通信する以下の依存先に疎通確認を行う。Backend probeと解析結果publishは同じ認証providerを使う。productionのtoken取得失敗は起動時には失敗として扱い、処理中の一時的なtoken取得失敗はService Bus messageをabandonして再配送する。いずれかに接続できない場合、Workerは処理ループを開始せず、接続できない依存先と理由を表示して終了する。

- Backend: `WORKER_BACKEND_HEALTH_URL` または `WORKER_BACKEND_BASE_URL` へのHTTP GET
- Service Bus: 対象queueへの送信AMQPリンクを開く。Session queueが空の場合でも受信待ちせず、メッセージを作成・送信しない。
- Blob Storage: account information取得
- Redis: `PING`
- Backend解析結果API: Workerサービス資格情報を付けた認証可能なhealth／readiness確認

WorkerはPostgreSQLとSignalRへ直接接続しない。RedisはPERCLOS状態管理のため起動時疎通確認対象とする。Worker replicaのmin/max、backlogによるautoscale、最古メッセージ年齢の監視、および設定制約は [`15-elastic-session-frame-processing.md`](../features/15-elastic-session-frame-processing.md) を参照し、Container Apps等のIaCで設定する。

productionではAzure Managed IdentityまたはWorkload Identityを通じて `DefaultAzureCredential` から `WORKER_BACKEND_TOKEN_SCOPE` のtokenを取得し、`Authorization: Bearer <token>` を送る。Entra IDアプリ登録にはBackend APIをaudienceとする `analysis_worker` app roleを定義し、Workerのmanaged identity/service principalへApplication permissionとして割り当て、admin consentを付与する。local/E2Eではこの構成を使わず、`WORKER_API_KEY` と `X-Worker-Api-Key` を使用する。キー、接続文字列、tokenはログとリポジトリへ保存しない。

health endpoint:

```http
GET /health
OPTIONS /health
```

Frontendの `/student/session` はブラウザからWorker health endpointへ直接疎通確認を行うため、health endpoint はCORSヘッダーを返す。

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
```

## 17. 未決定事項

以下は本仕様では未決定とする。

- Workerで使用する具体的なデコードライブラリ
- Blob Storage上の映像フレーム保存期間・削除方針
- MediaPipe Face LandmarkerモデルファイルをGit管理するか、READMEでダウンロード手順を示すか

現行実装でバックエンドへ送信される `codec` は `image/jpeg` とする。
