# リアルタイム通知機能仕様

## 実装優先度

- 優先度: 09
- 理由: Workerの推論結果を受講者画面へ即時反映し、自動停止制御につなげるため。

## 1. 機能概要

Workerが算出した眠気スコア、および顔未検出などのトラッキング状態を、Backendの永続化済みOutboxとSignalRを経由してフロントエンドへリアルタイム通知する機能である。

SignalRは本機能の最終仕様であり、受講者画面（`student-session-page.tsx`）の一次通知経路である。バックエンドは `AddSignalR` によるASP.NET Core SignalR Hub（`AnalysisEventsHub`、`/hubs/analysis-events`）を提供する。Azure本番で複数Backend instanceを配置する場合は、`Azure:SignalR:ConnectionString` / `AZURE_SIGNALR_CONNECTION_STRING` を設定し、`AddAzureSignalR` によりAzure SignalR Serviceを配信基盤として利用する。接続文字列が未設定のローカル単一instance開発環境では、同一プロセス内のASP.NET Core SignalRとして動作する。複数instanceの接続registryとOutbox配信契約は [`15-elastic-session-frame-processing.md`](./15-elastic-session-frame-processing.md) を一次情報とする。

`GET /api/sessions/{sessionId}/analysis-events` のServer-Sent Eventsは、`/test` ページなどローカル検証用ツール向けのフォールバック経路として残す。SSEの `data:` に含めるJSON payloadはSignalR payloadと同じ構造とし、`POST /api/sessions/{sessionId}/analysis-results` で受理・Outbox保存された後に両経路へ配信する。

本章をリアルタイム通知payloadおよびSignalR / SSEの関係の一次情報とする。frontend / backend spec では、本章を参照し、各コンポーネントの接続方式と責務のみを補足する。

## 2. 対象コンポーネント

- Worker
- バックエンド
- SignalR Hub（`AnalysisEventsHub`、Azure SignalR Service または ASP.NET Core SignalR）
- Server-Sent Events（`/test` ページ等ローカル検証ツール向けフォールバック）
- フロントエンド

## 3. トリガー

以下のいずれかが発生したときに通知する。

- Workerが眠気スコアを算出した。
- Workerが顔未検出を検知した。

## 4. 通知経路

### 4.1 最終仕様

- バックエンドは `AnalysisEventsHub`（`/hubs/analysis-events`）をSignalR Hubとして公開する。
- フロントエンドは接続確立後、Hubメソッド `JoinSession(sessionId)` を呼び出し、`sessionId` 単位のSignalR Group（`session-{sessionId}`）へ参加する。
- Hubは認証必須とする。`POST /api/sessions` は新規受講セッションとともに、当該 `sessionId` に束縛された短命の `student_session` HttpOnly Cookie（セッション終了または最大8時間で失効）を発行する。受講者はこのCookieの `sessionId` と一致するGroupだけ、管理者は認証済み `admin` roleとしてダッシュボードで選択した既存セッションだけ参加できる。教員・匿名接続・他受講者のGroup参加は拒否する。
- Backendは `POST /api/sessions/{sessionId}/analysis-results` をWorkerサービス資格情報で受理し、解析結果を永続化するトランザクション内でOutboxへ登録する。Outboxディスパッチャーが該当Groupにクライアントメソッド `ReceiveAnalysisEvent` を呼び出す。保存より先に直接配信してはならない。
- Azure本番で複数Backend instanceを配置する場合は、`Azure:SignalR:ConnectionString`（または環境変数 `AZURE_SIGNALR_CONNECTION_STRING`）を必須とし、`AddAzureSignalR` によりAzure SignalR Serviceを配信基盤とする。未設定のローカル単一instance開発環境では、ASP.NET Core SignalRとして同一プロセス内で配信する。

### 4.2 SSEフォールバック（ローカル検証ツール向け）

- `/test` ページなど、SignalRクライアントへ未移行のローカル検証ツールは `EventSource` で `GET /api/sessions/{sessionId}/analysis-events` を購読できる。
- バックエンドは `text/event-stream` として解析結果イベントを返す。
- SSEの `data:` に含めるJSON payloadは、SignalRで配信するpayloadと同じ構造である。
- 受講者画面（`student-session-page.tsx`）はSSEを使用せず、SignalRのみに接続する。

## 5. 眠気スコア通知

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

`videoTimeSec` はスコアに対応する動画教材内の再生位置（秒）である。新規に保存・配信するスコアでは必須とする。既存スコア由来の再配信では `null` を許容する。

眠気レベル:

```text
normal:  score < 0.25
caution: 0.25 <= score < 0.50
warning: 0.50 <= score < 0.75
danger:  0.75 <= score <= 1.00
```

## 6. 顔未検出通知

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "sourceSequenceNo": 1,
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

## 7. キャリブレーション通知

キャリブレーションの進行表示はローカル状態で管理する。WorkerからBackendへ送信し、Outbox経由で配信する終端通知は次の `calibration_status` に限定する。失敗通知は永続化しないが、Outboxへ保存して配信失敗時に再試行する。成功通知は `calibrations` 行と同一トランザクションでOutboxへ保存する。

```json
{
  "type": "calibration_status",
  "sessionId": "uuid",
  "status": "succeeded",
  "validFrames": 18,
  "totalFrames": 25,
  "targetFrames": 25,
  "sourceSequenceNo": 25,
  "calibratedAt": "2026-06-14T10:00:05Z",
  "earOpen": 0.31,
  "earThreshold": 0.2325
}
```

`status` は `succeeded` または `failed` とする。`failed` では `validFrames`、`totalFrames`、`targetFrames` を含めるが、`sourceSequenceNo`、`calibratedAt`、`earOpen`、`earThreshold` は含めない。`succeeded` では上記の全フィールドを必須とし、`calibratedAt` が `calibrations.calibrated_at` の唯一の保存元である。旧来の `updatedAt` フィールドは送信・受理しない。

## 8. フロントエンドでの扱い

### 7.1 眠気スコア通知

- 現在の眠気レベルを画面に表示する。
- `level === "danger"` または `shouldPause === true` の場合、動画を自動停止する。
- `level === "normal"` に戻るまで再開ボタンを無効化する。

### 7.2 顔未検出通知

受講者画面では閉眼時と同様に動画を一時停止扱いにし、以下のPopupを表示する。

```text
title: そこにいる？
content: 顔が検出できません。カメラの状態を確認し、顔と目がしっかり映っているか確認してください！
```

PopupのContent下にはWebカメラFrameを表示する。

### 7.3 SignalR接続エラー時の扱い

- 受講者画面は接続状態（未接続・接続中・接続済み・エラー）を保持し、キャリブレーション開始ボタンは接続済み状態でのみ有効化する。
- `HubConnection` が切断・再接続失敗した場合は接続状態をエラーとして扱い、Backendの起動状態確認を促すメッセージを表示する。
- 再接続成功時（`onreconnected`）は、再度 `JoinSession(sessionId)` を呼び出してGroup購読を復元してから接続済み状態に戻す。
- 初回接続または再接続に失敗した場合は、キャリブレーション開始を無効化し、受講中であれば動画とフレーム送信を停止する。エラーPopupからSignalRを再接続でき、接続済みになるまで受講を再開できない。

## 9. バックエンドの責務と耐障害性

Backendは `AnalysisEventsHub` による認証済みSignalR接続・配信基盤を提供する。`POST /api/sessions/{sessionId}/analysis-results` は `analysis_worker` のみ受理し、結果を検証・永続化してから同一トランザクションに通知用Outboxレコードを作成する。Outboxディスパッチャーは未配信レコードをロックしてSignalRとSSEへ配信し、成功時のみ配信済みにする。SignalR/SSEの一時的な失敗は指数バックオフで再試行する。接続中でないクライアントへ過去イベントを再送することは保証せず、管理者ダッシュボードはREST再取得を正とする。

あわせて `/api/sessions/{sessionId}/analysis-events` のSSE購読APIを提供し、SignalR payloadと同じJSON構造の解析結果イベントを配信する。これは認証済みの `/test` ローカル検証ツール向けフォールバックであり、受講者画面の本番経路ではない。

## 10. 認可境界

- `POST /api/sessions/{sessionId}/analysis-results`: `analysis_worker` サービス資格情報のみ。
- `GET /api/sessions/{sessionId}/analysis-events` と `JoinSession(sessionId)`: 当該受講セッションの受講者、または `admin` roleのみ。
- 解析結果payloadに認可情報を含めない。接続のCookieまたはサービスBearer tokenから認可判断する。

## 11. Cookie principalの競合方針と接続失効

管理者・教員のブラウザ認証Cookieと `student_session` は同一ブラウザで共存させない。`POST /api/sessions` は既存の管理者・教員認証および旧student sessionをサーバー側で失効させ、対応するCookieを削除してから新しい `student_session` を発行する。管理者・教員ログインも既存のstudent sessionを同様に失効させる。

学生画面は、画面が保持する `sessionId` と `student_session` Cookieに束縛されたprincipalのsession IDを照合する。`sessionStorage` の値だけでWebSocket、Hub、REST APIの認可を成立させてはならない。同じブラウザで新しいstudent sessionが開始された場合、旧タブのCookieはサーバー側で失効するため、旧タブは次回の認証確認またはイベント送信でエラー画面へ遷移する。

logout、明示的revoke、idle expiry、absolute expiryで `auth_sessions` が無効になった接続は、既にGroupへ参加済みでも以後の解析イベント配信対象から除外する。Hub invocation時の認可確認に加えて、配信時にも接続のauth session有効性を確認する。再接続後は `JoinSession(sessionId)` が成功するまで接続済み・受講再開可能状態へ戻さない。

## 12. 関連機能

- `06-face-recognition.md`
- `08-drowsiness-scoring.md`
- `10-auto-pause-resume.md`
- `14-teacher-dashboard.md`
