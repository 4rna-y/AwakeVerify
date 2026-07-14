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

## 10. 顔未検出時の扱い

顔未検出フレームはPERCLOS計算に含めない。

顔未検出のみの期間は、スコア保存対象としない。

## 11. 1秒単位保存仕様と通知の整合性

Workerは `capturedAt` をUTCで秒単位に切り捨てた値を集計窓IDとして、同じ窓に属する顔検出フレームを最大5件だけ平均する。5件に満たないまま次のUTC秒へ進んだ未完了窓は破棄し、別秒のフレームと混ぜない。5件揃った時点で集計し、集計窓末尾フレームの `sourceSequenceNo`、その窓IDに対応するUTC秒の `scoredAt`、および集計窓末尾フレームの `videoTimeSec` を付与する。`videoTimeSec` は動画教材内の再生位置（秒）であり、フレーム番号またはFPSから算出しない。WorkerはPostgreSQLへ直接保存せず、サービス認証済みの `POST /api/sessions/{sessionId}/analysis-results` へ送る。Backendがデータ所有者として、スコア行と通知用Outbox行を同一PostgreSQLトランザクションで保存する。

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

同じ `sessionId` と `sourceSequenceNo` の再送は `videoTimeSec` を含む既存値と等しい場合だけ冪等成功とし、異なる値は競合として受理しない。Backendは保存済みスコアをダッシュボードREST APIの唯一の参照元とする。OutboxディスパッチャーがSignalR/SSE配信に失敗した場合は指数バックオフで再試行し、保存済みスコアを失わない。

## 12. 解析結果の受理境界

Workerからの解析結果APIは `analysis_worker` サービス資格情報だけを受け付ける。本番はAzure Managed Identityが取得するMicrosoft Entra IDのOAuth 2.0 client-credentials Bearer tokenを、Backend APIのaudienceと `analysis_worker` app roleで検証する。ローカルE2Eは環境変数で供給・ローテーションする `WORKER_API_KEY` を `X-Worker-Api-Key` で照合する。ブラウザCookie、`sessionId`、`teacherId`、`adminId` をWorker認証の代用にしてはならない。Backendはpayloadの型・必須値・`sessionId`存在・キャリブレーション済みであることを検証し、受理済みの結果だけをOutboxへ積む。Workerは接続タイムアウト、5xx、429を再試行し、4xxの入力・認可エラーは再試行せずフレームメッセージをdead-letterする。

## 13. 関連機能

- `06-face-recognition.md`
- `07-calibration.md`
- `09-realtime-notification.md`
- `10-auto-pause-resume.md`
