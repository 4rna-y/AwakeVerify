# 眠気スコア算出機能仕様

## 実装優先度

- 優先度: 08
- 理由: 自動停止判定、リアルタイム通知、教員ダッシュボードの中核データを生成するため。

## 1. 機能概要

顔認識機能で算出したEAR・Pitch・Yawを用いて、PERCLOSベースの眠気スコアと眠気レベルを算出する機能である。

算出結果は1秒単位でPostgreSQLへ保存し、SignalR通知に使用する。

## 2. 対象コンポーネント

- Worker
- Redis
- PostgreSQL

## 3. トリガー

Workerが顔ランドマーク推論結果からEAR・Pitch・Yawを算出する。

## 4. 入力

- EAR
- Pitch_deg
- Yaw_deg
- キャリブレーションで得た `EAR_threshold`

## 5. 閉眼判定

```text
EAR < EAR_threshold の場合、閉眼フレームとして扱う
```

## 6. PERCLOSスライディングウィンドウ

PERCLOSは以下の条件で算出する。

```text
15秒スライディングウィンドウ
75フレーム
```

Redis上にセッションごとのスライディングウィンドウ状態を保持する。キーは `perclos:{sessionId}:frames` とし、値は処理済みの顔検出フレームについて `sequenceNo`、`capturedAt`、閉眼判定を含むJSONとする。Workerは各追加時に、当該フレームの `capturedAt` から15秒より古いエントリを同じLua実行内で除外し、残りを最大75フレームに制限する。TTLは受講セッション終了予定時刻から1時間後まで、最低24時間とする。JPEGフレームの欠落、順序不整合、またはWorker再起動があってもPERCLOS状態を消去しない。

Luaスクリプトで、期限切れエントリを除外し、重複した `sequenceNo` を無視したうえで以下を原子的に行う。

```text
LPUSH
LTRIM
LRANGE
EXPIRE
```

スコアリング対象外の顔未検出フレームはこのキーへ追加しない。Service Bus Sessionにより同一セッションの順序を直列化し、LuaはWorker再起動・スケールアウト時の冪等性と状態共有を担保する。

用途:

- Workerのスケールアウト時の競合防止
- セッションごとのPERCLOS状態共有

## 7. スコア式

```text
w_yaw = max(1.0 − |Yaw_deg| / 45.0, 0.0)
EAR_score = min(PERCLOS / 0.5, 1.0) × w_yaw
score = min(EAR_score × (1 + 0.3 × min(Pitch_deg / 30.0, 1.0)), 1.0)
```

## 8. 眠気レベル

```text
normal:  score < 0.25
caution: 0.25 <= score < 0.50
warning: 0.50 <= score < 0.75
danger:  0.75 <= score <= 1.00
```

## 9. 自動停止判定

```text
level == danger
または
score >= 0.75
```

この場合、SignalR通知の `shouldPause` を `true` とする。

### 9.1 自動停止通知の鮮度契約

15秒PERCLOS窓は判定に必要な観測時間であり、解析基盤の遅延許容値ではない。`drowsiness_score` と `tracking_status` の自動動画制御に使う通知は、判定に使った末尾frame時刻（それぞれ `scoredAt`、`detectedAt`）からフロントエンド受信までを測定し、`p95` を2秒以下、`p99` を5秒以下とする。通知payloadはこの時刻を必須で保持する。

この契約は負荷テストの受け入れ条件でもある。少なくとも対象同時Session数・送信時間・fpsで、HTTP frame送信開始から対応するSignalR解析通知受信までの end-to-end 値（通知時刻だけを起点とする上記測定より広い範囲）も `p95` 2秒以下、`p99` 5秒以下でなければならない。Load-test CLI はこの値を `frameToResultLatencyMs` として記録し、いずれかを超過または標本がない場合は失敗終了する。timeout、Session誤配送、同一Sessionの受理順序違反も同様に不合格とする。

フロントエンドは受信時点でこの時刻が5秒を超えて古い通知を、保存済み結果の表示・再取得には利用してよいが、動画の自動停止・再開可否の状態遷移には利用してはならない。これにより、遅延した過去の判定で受講中の動画を制御しない。

受講ページ右上のScoreBadgeは、直近の `drowsiness_score` をBackend通知としてFrontendが受信した瞬間からの経過秒数を `更新 N秒前` と表示する。これは `scoredAt` からの解析鮮度ではなく、利用者が最後に通知を確認できた時点を示す表示である。

## 10. 顔未検出時の扱い

顔未検出フレームはPERCLOS計算に含めない。

顔未検出のみの期間は、スコア保存対象としない。

## 11. 1秒単位保存仕様と通知の整合性

Workerは顔検出できたフレームごとにPERCLOSと眠気スコアを内部計算する。`capturedAt` をUTCで秒単位に切り捨てた値を集計窓IDとし、次のUTC秒の最初のframeを処理した時点で直前の窓を確定する。直前の窓に顔検出フレームが1件以上あれば、先頭から最大5件を平均した1件のscoreだけを通知・保存する。5件未満の窓も破棄せず、別秒のフレームとは混ぜない。顔未検出だけの窓はscoreを作らない。scoreには集計窓末尾フレームの `sourceSequenceNo`、その窓IDに対応するUTC秒の `scoredAt`、および末尾フレームの `videoTimeSec` を付与する。`videoTimeSec` は動画教材内の再生位置（秒）であり、フレーム番号またはFPSから算出しない。

秒集計の現在窓と、Backendが `202 Accepted` を返すまでの確定済み・未送信窓はRedisの `score-aggregation:{sessionId}:state` に保持する。WorkerはLuaで現在窓の追加、次秒への遷移、確定窓のpending化、同じ `sequenceNo` の重複除外を原子的に行う。Backend受理後にだけpending窓をackする。したがって、Session slot移動、Worker再起動、Service Bus再配送、またはack前の停止があっても、同じ `sessionId`・UTC秒について異なるscoreを再構成・送信してはならない。ack失敗後の再送は同じ保存payloadを用いるため、Backendの既存冪等受理により安全に完了する。

WorkerはPostgreSQLへ直接保存せず、サービス認証済みの `POST /api/sessions/{sessionId}/analysis-results` へ送る。Backendがデータ所有者として、スコア行と通知用Outbox行を同一PostgreSQLトランザクションで保存する。

保存対象:

- source_sequence_no
- video_time_sec
- score
- level
- perclos
- ear
- pitch_deg
- yaw_deg

保存先:

```text
drowsiness_scores
- session_id uuid not null, foreign key -> learning_sessions.session_id
- source_sequence_no bigint not null
- scored_at timestamptz not null
- video_time_sec numeric nullable（既存スコアは `null` を許容し、新規に保存するスコアでは0以上の有限値を必須とする）
- score numeric not null
- level drowsiness_level not null
- perclos numeric not null
- ear numeric not null
- pitch_deg numeric not null
- yaw_deg numeric not null
- primary key (session_id, source_sequence_no)
- unique (session_id, scored_at)
```

同じ `sessionId` と `sourceSequenceNo` の再送は `videoTimeSec` を含む既存値と等しい場合だけ冪等成功とし、異なる値は競合として受理しない。Backendは保存済みスコアをダッシュボードREST APIの唯一の参照元とする。OutboxディスパッチャーがSignalR/SSE配信に失敗した場合は指数バックオフで再試行し、保存済みスコアを失わない。再試行で鮮度上限を超えた通知も保存・配信は継続するが、Feature 09 / 10の動画制御対象にはしない。

## 12. 解析結果の受理境界

Workerからの解析結果APIは `analysis_worker` サービス資格情報だけを受け付ける。本番はAzure Managed Identityが取得するMicrosoft Entra IDのOAuth 2.0 client-credentials Bearer tokenを、Backend APIのaudienceと `analysis_worker` app roleで検証する。ローカルE2Eは環境変数で供給・ローテーションする `WORKER_API_KEY` を `X-Worker-Api-Key` で照合する。ブラウザCookie、`sessionId`、`teacherId`、`adminId` をWorker認証の代用にしてはならない。Backendはpayloadの型・必須値・`sessionId`存在・キャリブレーション済みであることを検証し、受理済みの結果だけをOutboxへ積む。Workerは接続タイムアウト、5xx、429を再試行し、4xxの入力・認可エラーは再試行せずフレームメッセージをdead-letterする。

## 13. 関連機能

- `06-face-recognition.md`
- `07-calibration.md`
- `09-realtime-notification.md`
- `10-auto-pause-resume.md`
