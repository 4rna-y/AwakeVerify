# Worker仕様書

## 1. 目的

本仕様書は、オンデマンドビデオ教材受講完了検証システムにおける画像推論Workerの仕様を定義する。

Workerは、Service Busから映像フレーム参照を受信し、Blob Storageからエンコード済み映像フレームを取得し、I/Pフレームを順次デコードして画像フレームを復元する。その後、MediaPipe Face Landmarkerにより顔ランドマークを取得し、EAR・Pitch・Yaw、PERCLOSベースの眠気スコアを算出する。

## 2. 根拠

本仕様は `docs/proposal.md` を根拠とし、企画書に明記されていない事項はユーザー承認済みの仕様決定に基づく。

### 2.1 proposal.md に基づく事項

- Worker技術は Python / MediaPipe / OpenCV とする。
- Azure Container Apps Worker上で動作する。
- Service BusからBlob参照情報を受け取る。
- Blob Storageから映像データを取得する。
- MediaPipe Face Landmarkerで顔ランドマークを取得する。
- EAR・Pitch・Yawを算出する。
- Redis上のスライディングウィンドウを用いてPERCLOSベースの眠気スコアを算出する。
- 5フレームの平均値を1秒単位でPostgreSQLへ保存する。
- SignalRでクライアントへリアルタイム通知する。

### 2.2 承認済み仕様決定

- WorkerはI/Pフレームを順次デコードして画像フレーム列を復元する。
- Iフレーム間隔は1秒とする。
- Iフレーム間はPフレームのみで、Bフレームは使用しない。
- IフレームはRedisに保存せず、Blob Storageに永続化される。
- Workerはセッション単位でデコーダ状態を保持する。
- Pフレーム欠落・順序不整合時は次のIフレームまでPフレームを破棄する。
- RedisはPERCLOSスライディングウィンドウなどの推論状態管理に使用する。
- キャリブレーションは5秒間、25フレームで行う。
- 有効フレームが15フレーム未満の場合、キャリブレーション失敗とする。
- 正面向き判定は `|Yaw_deg| <= 15` かつ `|Pitch_deg| <= 15` とする。
- 顔未検出フレームはPERCLOS計算に含めず、顔未検出通知を送信する。

## 3. 処理概要

```text
Service Bus
→ Blob Storageからエンコード済みフレーム取得
→ I/Pフレームを順次デコード
→ 画像フレーム復元
→ MediaPipe Face Landmarker
→ EAR / Pitch / Yaw算出
→ Redisスライディングウィンドウ更新
→ PERCLOSベース眠気スコア算出
→ PostgreSQL保存
→ SignalR通知
```

## 4. Service Bus処理仕様

### 4.1 メッセージ形式

WorkerはService Busから以下のメッセージを受信する。

```json
{
  "sessionId": "uuid",
  "sequenceNo": 1,
  "frameType": "I",
  "baseIFrameSequenceNo": 1,
  "blobPath": "sessions/3f8c.../frames/000001_I.bin",
  "capturedAt": "2026-06-14T10:00:00.000Z",
  "receivedAt": "2026-06-14T10:00:00.050Z",
  "codec": "TBD"
}
```

### 4.2 順序処理

Service Busでは `sessionId` をSession IDとして使用する。

Workerは同一 `sessionId` のメッセージを順序どおりに処理する。

目的:

- Pフレームの順序依存を満たす。
- セッション単位のデコーダ状態を正しく更新する。

## 5. Blob Storage取得仕様

WorkerはService Busメッセージ内の `blobPath` を用いて、Blob Storageからエンコード済み映像フレームを取得する。

Blobパス形式:

```text
sessions/{sessionId}/frames/{sequenceNo}_{frameType}.bin
```

例:

```text
sessions/3f8c.../frames/000001_I.bin
sessions/3f8c.../frames/000002_P.bin
```

Blob Storage上の保存期間・削除方針はTBDとする。

## 6. I/Pフレームデコード仕様

### 6.1 フレーム種別

- `I`: Iフレーム。1秒間隔で送信されるキーフレーム。
- `P`: Pフレーム。直前までのデコーダ状態に依存するフレーム。

Bフレームは使用しない。

### 6.2 Iフレーム処理

WorkerがIフレームを受信した場合、以下を行う。

1. 対象 `sessionId` のデコーダ状態を初期化またはリセットする。
2. Iフレームを画像フレームとして復元する。
3. 復元した画像フレームをMediaPipe推論へ渡す。
4. 以後のPフレーム復元の基準状態としてデコーダ状態を保持する。

### 6.3 Pフレーム処理

WorkerがPフレームを受信した場合、以下を行う。

1. 対象 `sessionId` のデコーダ状態を取得する。
2. `sequenceNo` および `baseIFrameSequenceNo` により、順序不整合がないか確認する。
3. 現在のデコーダ状態を使って画像フレームを復元する。
4. 復元した画像フレームをMediaPipe推論へ渡す。
5. デコーダ状態を更新する。

### 6.4 欠落・順序不整合時の扱い

Pフレーム欠落または順序不整合を検知した場合、Workerは対象GOP内の後続Pフレームを破棄する。

次のIフレームを受信した時点でデコーダ状態を再初期化し、処理を再開する。

Iフレーム間隔は1秒であるため、復元不能状態の影響範囲は最大約1秒を想定する。

### 6.5 RedisにIフレームを保存しない理由

Pフレームは通常、直近Iフレームだけではなく、そこから現在までのPフレーム列により更新されたデコーダ状態に依存する。

そのため、Redisに最新Iフレームのみを保存しても、任意のPフレームを安全に復元できるとは限らない。

Redisは以下の用途に限定する。

- PERCLOS用スライディングウィンドウ
- セッションごとの眠気スコア状態
- 直近の眠気レベル状態

## 7. 顔ランドマーク推論仕様

### 7.1 推論ライブラリ

MediaPipe Face Landmarkerを使用する。

### 7.2 入力

I/Pフレームをデコードして得た画像フレームを入力とする。

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

有効フレームのEAR中央値を `EAR_open` としてDB保存する。

閉眼閾値は以下で算出する。

```text
EAR_threshold = EAR_open × 0.75
```

保存先:

```text
calibrations
- session_id
- ear_open
- ear_threshold
- calibrated_at
```

## 9. 顔未検出時の扱い

顔未検出フレームはPERCLOS計算に含めない。

顔未検出フレーム単体では `drowsiness_scores` に保存しない。

SignalRでは以下の通知を送信する。

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

顔未検出のみを理由に動画停止はしない。

次に顔が検出できた時点で推論とスコア算出を再開する。

## 10. PERCLOSスライディングウィンドウ仕様

### 10.1 ウィンドウ

PERCLOSは以下の条件で算出する。

```text
15秒スライディングウィンドウ
75フレーム
```

### 10.2 Redis状態管理

Redis上にセッションごとのスライディングウィンドウ状態を保持する。

proposal.md に基づき、Luaスクリプトで原子的に以下を行う。

```text
LPUSH
LTRIM
LRANGE
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

この場合、SignalR通知の `shouldPause` を `true` とする。

## 12. 1秒単位保存仕様

Workerは5フレームの平均値を1秒単位でPostgreSQLへ保存する。

保存先:

```text
drowsiness_scores
- session_id
- scored_at
- score
- level
- perclos
- ear
- pitch_deg
- yaw_deg
```

保存対象:

- score
- level
- perclos
- ear
- pitch_deg
- yaw_deg

顔未検出のみの期間は、スコア保存対象としない。

## 13. SignalR通知仕様

### 13.1 眠気スコア通知

```json
{
  "type": "drowsiness_score",
  "sessionId": "uuid",
  "scoredAt": "2026-06-14T10:00:00Z",
  "score": 0.82,
  "level": "danger",
  "perclos": 0.61,
  "ear": 0.18,
  "pitchDeg": 12.4,
  "yawDeg": 4.2,
  "shouldPause": true
}
```

### 13.2 顔未検出通知

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

## 14. PostgreSQL保存対象

### 14.1 キャリブレーション

```text
calibrations
- session_id
- ear_open
- ear_threshold
- calibrated_at
```

### 14.2 眠気スコア

```text
drowsiness_scores
- session_id
- scored_at
- score
- level
- perclos
- ear
- pitch_deg
- yaw_deg
```

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
- I/Pフレームデコード
- `shared` の顔解析・キャリブレーション・眠気スコア算出ロジック呼び出し
- Redis / PostgreSQL / SignalRとの接続
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

ローカル検証構成では、Service Bus設定がない場合にBackendのローカル保存先をポーリングする。

```text
data/blobs/sessions/{sessionId}/frames/{sequenceNo}_{frameType}.bin
```

ローカル保存ファイルにはキューメタデータが含まれないため、Workerはファイルパスから `sessionId`、`sequenceNo`、`frameType` を復元し、1秒ごとのIフレーム間隔から `baseIFrameSequenceNo` を推定する。

### 16.2 処理

1. フレーム参照とフレームバイナリを取得する。
2. `FrameDecoder` で `image/jpeg` を画像フレームへ復元する。
3. `FaceAnalyzer` でEAR、Pitch、Yawを算出する。
4. セッションごとに `CalibrationTracker` を保持し、初回フレームから25フレームでキャリブレーションする。
5. キャリブレーション成功後、`DrowsinessScorer` でPERCLOS、score、level、`shouldPause` を算出する。
6. 顔未検出時は `tracking_status` を通知する。
7. 眠気スコア算出時は `drowsiness_score` を通知する。

### 16.3 出力

本番通知経路はSignalRを一次仕様とする。

現行の開発・検証実装では、`/test` ページと接続するため、Backendの検証用APIへ解析結果をpublishする。

```http
POST /api/sessions/{sessionId}/analysis-results
```

payloadは `13.1` / `13.2` と同じ `drowsiness_score` または `tracking_status` とする。

### 16.4 設定

| 設定 | 用途 | 既定値 |
| --- | --- | --- |
| `WORKER_MODEL_PATH` | MediaPipeモデルパス | `src/worker/models/face_landmarker.task` |
| `WORKER_BACKEND_BASE_URL` | Backend publish先 | `http://localhost:5194` |
| `WORKER_LOCAL_FRAME_ROOT` | ローカルフレーム保存root | `data/blobs` |
| `WORKER_POLL_INTERVAL_SECONDS` | ローカルポーリング間隔 | `0.2` |
| `WORKER_HEALTH_HOST` | health endpoint bind host | `0.0.0.0` |
| `WORKER_HEALTH_PORT` | health endpoint port | `8000` |
| `AZURE_SERVICE_BUS_CONNECTION_STRING` / `Azure__ServiceBus__ConnectionString` | Azure Service Bus接続 | 未設定時はローカルポーリング |
| `AZURE_SERVICE_BUS_FRAME_QUEUE_NAME` / `Azure__ServiceBus__FrameQueueName` | フレームqueue名 | 未設定時はローカルポーリング |
| `AZURE_BLOB_STORAGE_CONNECTION_STRING` / `Azure__BlobStorage__ConnectionString` | Azure Blob接続 | 未設定時はローカルポーリング |
| `AZURE_BLOB_STORAGE_CONTAINER_NAME` / `Azure__BlobStorage__ContainerName` | Blob container名 | `frames` |

health endpoint:

```http
GET /health
```

## 17. 未決定事項

以下は本仕様では未決定とする。

- Workerで使用する具体的なデコードライブラリ
- Blob Storage上の映像フレーム保存期間・削除方針
- MediaPipe Face LandmarkerモデルファイルをGit管理するか、READMEでダウンロード手順を示すか

現行実装でバックエンドへ送信される `codec` は `image/jpeg` とする。
