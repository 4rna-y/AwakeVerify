# バックエンド仕様書

## 1. 目的

本仕様書は、オンデマンドビデオ教材受講完了検証システムにおけるバックエンドの仕様を定義する。

バックエンドは、受講セッション管理、認証、HTTPS binary frame ingress、Blob Storage保存、Service Bus投入、PostgreSQL記録、SignalR配信、管理者ダッシュボード向けAPIを担う。

## 2. 根拠

本仕様は二次仕様である。ユーザー価値・受け入れ条件・横断的な判断は `docs/features/` と `docs/scenarios/` を一次情報とし、本書はBackendの実装責務だけを補足する。セッション単位の水平分散、Outbox lease、複数instance通知の一次情報は [`15-elastic-session-frame-processing.md`](../features/15-elastic-session-frame-processing.md) とする。

### 2.1 proposal.md に基づく事項

- バックエンド技術は ASP.NET Core とする。
- Azure Container Apps上で動作する。
- フロントエンドからHTTPS binary requestで映像データを受信する。
- 受信データをBlob Storageへ保存する。
- Blob参照情報をService Busへエンキューする。
- Workerの推論完了を待たず、非同期処理する。
- 眠気スコアと自動停止イベントをPostgreSQLへ保存する。
- Azure SignalR Serviceを用いてリアルタイム通知する。

### 2.2 承認済み仕様決定

- 受講者は学籍番号のみでセッション開始する。
- 教員は教員IDとパスワードでログインする。
- 教員アカウントは管理者ページから追加する。
- バックエンドは受講ごとに `sessionId` を発行する。
- Feature 03のHTTPS binary frame APIで、各フレームを単独でデコード可能な `image/jpeg` として1フレームずつ受信する。raw JPEG frame用WebSocketおよびBase64 payloadは提供しない。
- Service Busでは `sessionId` をSession IDとして利用し、同一セッション内の順序処理を保証する。
- 停止・再開イベントはフロントエンドからAPIで受信し、PostgreSQLへ保存する。
- ローカルE2EはdevcontainerのPostgreSQL / Redis / Azurite / Azure Service Bus Emulatorを使用し、本番と同じBlob／Service Busアダプターを通す。ファイル保存・ログ出力のみのフォールバックは単体テストのtest doubleに限る。詳細は [`04-frame-storage-and-queue.md`](../features/04-frame-storage-and-queue.md) を参照する。
- リアルタイム通知の最終仕様はSignalRとする。Azure本番で複数Backend instanceを配置する場合はAzure SignalR Serviceを必須とし、未設定のローカル単一instance開発ではASP.NET Core SignalRとして動作する。`/api/sessions/{sessionId}/analysis-events` のSSEは、SignalR未対応のローカル検証ツール向けフォールバックとして、SignalRと同じJSON payloadを配信する。

## 3. システム内の責務

バックエンドの責務は以下である。

- 受講セッションの作成
- 受講者の学籍番号管理
- 教員ログイン認証
- 管理者による教員アカウント追加
- HTTPS binary frame ingress
- Blob Storageへの映像フレーム保存
- Service Busへのフレーム参照メッセージ投入
- 停止・再開イベント保存
- ダッシュボード向けREST API提供
- SignalR Hub（`AnalysisEventsHub`）による解析結果配信
- 複数Backend instanceで共有する、認可済み接続・Session購読 registry の管理
- 複数dispatcherがleaseでclaimするTransactional Outboxの配信
- SSEによる解析結果イベントストリーム提供（ローカル検証ツール向けフォールバック）

## 4. 認証・アカウント仕様

### 4.1 受講者

受講者は学籍番号のみでセッションを開始する。

受講者にはパスワードを設定しない。

### 4.2 教員・管理者・受講者セッション

認証、パスワードハッシュ、Cookie属性、期限、ログアウト、CSRF、role境界の一次情報は [`12-teacher-login.md`](../features/12-teacher-login.md)、[`13-teacher-account-management.md`](../features/13-teacher-account-management.md)、[`09-realtime-notification.md`](../features/09-realtime-notification.md) とする。

Backendはサーバー側 `auth_sessions` と不透明なHttpOnly Cookieを実装する。教員は `teacher` role、管理者は `admin` role、受講開始APIが発行する短命Cookieは `student_session` roleを持つ。Controller、Hub、HTTP frame ingressは認証principalから認可し、request bodyの `adminId` / `teacherId` / `sessionId` を認可根拠にしない。別オリジン開発を許可する場合は、固定したCORS originに資格情報送信と `X-CSRF-Token` レスポンスヘッダー公開を限定し、認証Cookieを発行する応答と認証済み `GET /api/auth/me` でCSRF値を返す。

## 5. REST API仕様

## 5.1 セッション開始API

```http
POST /api/sessions
```

request:

```json
{
  "studentId": "string",
  "videoId": "string"
}
```

response:

```json
{
  "sessionId": "uuid"
}
```

Backendは同時に、この `sessionId` に限定した `student_session` HttpOnly Cookieを設定する。HTTP frame ingress、解析イベント購読、停止・再開イベント記録では当該Cookieの `sessionId` 一致を必須とする。

`student_session` と管理者・教員のブラウザ認証Cookieは共存させない。`POST /api/sessions` は既存のauth sessionを失効・削除してからstudent cookieを発行し、管理者・教員ログインは既存student sessionを失効・削除する。画面が保持するsession IDは表示・照合用に限り、認可根拠にはしない。

処理:

1. `studentId` と `videoId` を受け取る。`videoId` が未指定の場合は既定値 `default` を使用する。
2. `students` に存在しない場合は作成する。
3. `learning_sessions` に動画IDを含む新規セッションを作成する。
4. `sessionId` を返却する。

### 5.2 再生状態・受講完了イベント記録API

```http
POST /api/sessions/{sessionId}/playback-events
```

request:

```json
{
  "type": "auto_pause",
  "occurredAt": "2026-06-14T10:00:00Z",
  "videoTimeSec": 123.45
}
```

`type` は以下を許可する。

```text
manual_pause
auto_pause
resume
completed
```

当該受講者の `student_session` Cookieに結び付いた `sessionId` と一致する場合のみ受理する。`occurredAt` は必須で、`videoTimeSec` を指定する場合は0以上の有限値とする。

処理:

1. `sessionId` の存在とCookieに結び付いた受講者セッションとの一致を確認する。
2. `type`、`occurredAt`、`videoTimeSec` を検証する。
3. `completed` 以外は `playback_events` に保存する。
4. 最初の `completed` は `playback_events` に保存し、同じトランザクションで `learning_sessions.ended_at` をUTCの `occurredAt` に設定する。`ended_at` が設定済みの場合の重複 `completed` は `204` を返し、既存の終了時刻・イベントを変更しない。

### 5.3 教員ログインAPI

```http
POST /api/teacher/login
```

request:

```json
{
  "teacherId": "string",
  "password": "string"
}
```

response:

```json
{
  "authenticated": true,
  "principal": { "role": "teacher", "teacherId": "string", "expiresAt": "timestamp" }
}
```

成功時に `teacher` Cookie sessionを設定する。`POST /api/admin/login` も同一の応答形式で `admin` Cookie sessionを設定する。`POST /api/auth/logout` と `GET /api/auth/me` を実装する。

### 5.4 教員アカウント追加API

```http
POST /api/admin/teachers
```

request:

```json
{
  "teacherId": "string",
  "password": "string"
}
```

処理:

1. `[Authorize(Roles = "admin")]` により管理者認証を確認する。request bodyに `adminId` を設けない。
2. `teacherId` の重複を確認する。
3. パスワードをハッシュ化する。
4. `teachers` に保存する。

## 6. HTTP binary frame ingress仕様

Frame transportの一次契約は[`03-video-frame-sending.md`](../features/03-video-frame-sending.md)を正とする。本節はBackendの実装責務だけを補足し、raw JPEG frame用WebSocket route、frame ACK/NACK、JSON/Base64 payloadを提供しない。

```http
POST /api/sessions/{sessionId}/frames/{sequenceNo}
Content-Type: image/jpeg
X-CSRF-Token: <existing CSRF token>
X-Frame-Captured-At: <UTC timestamp>
X-Frame-Video-Time-Sec: <non-negative finite value>

<raw JPEG bytes>
```

- routeの`sessionId`とCookie principalのSession一致、CSRF、正の`sequenceNo`、header metadata、`Content-Type`、JPEG validityを検証する。proxyとASP.NET Coreの双方で1 MiBのbody上限を設定し、chunked bodyも上限超過まで読まない。
- Blob保存と`sessionId`をSession IDとしたService Bus enqueueの両方を完了してからだけ`202 Accepted`を返す。`(sessionId, sequenceNo)`の同一metadata・bytes再送は`202`、異なるものは`409 Conflict`とする。
- validationは`400`、size超過は`413`、既存認証・CSRF失敗は`401`/`403`、依存障害は`503`、設定済みadmission controlは`429`（必要なら`Retry-After`）とする。`503`/`429`だけをretryableとし、clientは同じframeを再送する。

## 7. Blob Storage保存仕様

### 7.1 保存対象

HTTP binary ingressで受信した、単独でデコード可能なJPEGバイナリをBlob Storageへ保存する。

### 7.2 パス形式

```text
sessions/{sessionId}/frames/{sequenceNo}.bin
```

現行実装では `{sequenceNo}` をゼロ埋めしてよい。

例:

```text
sessions/3f8c.../frames/000001.bin
sessions/3f8c.../frames/000002.bin
sessions/3f8c.../frames/000003.bin
```

### 7.3 保存期間

Blob Storage上の映像フレーム保存期間・削除方針は [`15-elastic-session-frame-processing.md`](../features/15-elastic-session-frame-processing.md) を一次情報とする。Backendは環境設定とBlob Lifecycle Management Ruleの整合を前提に、再配送・dead-letter調査に必要な期間より前にフレームを削除しない。

## 8. Service Bus投入仕様

Blob Storageへの保存完了後、Service Busへフレーム参照情報を投入する。

### 8.1 メッセージ形式

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

### 8.2 Session ID

Service Busでは、`sessionId` をSession IDとして設定する。

目的:

- 同一受講セッション内のフレーム順序を保証する。
- キャリブレーション、PERCLOS、眠気スコアのSession単位状態を順序どおり更新する。JPEGデコード自体はフレーム間状態に依存しない。

## 9. PostgreSQL保存仕様

### 9.1 テーブル構成

```text
students
- student_id
- created_at

learning_sessions
- session_id
- student_id
- video_id
- started_at
- ended_at nullable

auth_sessions
- session_id uuid primary key
- principal_type
- principal_id
- issued_at
- idle_expires_at
- absolute_expires_at
- revoked_at nullable

calibrations
- session_id uuid primary key, foreign key -> learning_sessions
- ear_open
- ear_threshold
- calibrated_at
- source_sequence_no

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
- primary key (session_id, source_sequence_no)
- unique (session_id, scored_at)

analysis_event_outbox
- event_id uuid primary key
- session_id uuid foreign key -> learning_sessions
- payload jsonb
- created_at
- delivered_at nullable
- attempt_count
- next_attempt_at
- lease_id uuid nullable
- locked_until timestamp nullable
- processing_owner varchar(128) nullable
- last_error nullable

playback_events
- event_id
- session_id
- type
- occurred_at
- video_time_sec nullable

teachers
- teacher_id
- password_hash
- created_at
- created_by_admin_id nullable

admins
- admin_id
- password_hash
- created_at
```

### 9.2 補足

- 受講者は学籍番号のみのため、`students` にパスワードは持たせない。
- 教員・管理者のパスワードは `password_hash` として保存する。
- `learning_sessions` は同じ受講者の複数回受講を区別し、`video_id` により動画ごとの受講記録を区別する。
- `drowsiness_scores` は1秒単位の保存結果であり、BackendのダッシュボードAPIだけが参照する。
- `analysis_event_outbox` は解析結果の永続化と通知の間のTransactional Outboxである。
- `playback_events` は `auto_pause` / `resume` を保存する。

## 10. リアルタイム通知配信仕様（SignalR / SSEフォールバック）

リアルタイム通知payloadおよびSignalR / SSEの関係の一次情報は [`09-realtime-notification.md`](../features/09-realtime-notification.md) とする。

Workerが算出した眠気スコア、およびトラッキング状態は、BackendがTransactional Outboxへ確定保存した後、SignalR Hub `AnalysisEventsHub`（`/hubs/analysis-events`）経由で配信する。`Azure:SignalR:ConnectionString`（または環境変数 `AZURE_SIGNALR_CONNECTION_STRING`）が設定されている場合は `AddAzureSignalR` によりAzure SignalR Serviceを配信基盤とし、未設定の場合はASP.NET Core SignalRとして同一プロセス内で配信する。

HubとSSEは認証必須とする。受講者は `student_session` の同一session、管理者は `admin` roleだけが既存sessionを購読できる。複数instance構成では、Hubが登録した接続・Session購読情報を共有 registry に保存し、dispatcher は配信時にauth sessionの有効性を再確認する。`REDIS_CONNECTION_STRING`（または `Redis:ConnectionString`）が設定された環境では、registry はRedisの `signalr:connection-registry:*` 名前空間に接続ID、auth session ID、購読session ID、登録時刻をTTL付きで保持する。未設定の単体テスト・単一process開発だけはin-memory実装を使用する。Outbox dispatcher は短いtransactionで期限付きleaseをclaimしてcommitしてからSignalR/SSEを送信し、同じlease IDを持つ行だけを成功または失敗として更新する。`OUTBOX_BATCH_SIZE`、`OUTBOX_POLL_INTERVAL_MS`、`OUTBOX_LEASE_SECONDS` は正の整数で、起動時に検証する。SignalR送信またはregistry参照に失敗した場合は配信済みにしない。claim・lease・at-least-onceの正確な契約は [`15-elastic-session-frame-processing.md`](../features/15-elastic-session-frame-processing.md) を参照する。

### 10.1 眠気スコア通知

```json
{
  "type": "drowsiness_score",
  "sessionId": "uuid",
  "sourceSequenceNo": 5,
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

新規に受理する `drowsiness_score` の `videoTimeSec` は0以上の有限値を必須とする。既存の `drowsiness_scores` 行を通知またはダッシュボードAPIで返す場合は `null` を維持して返す。

### 10.2 顔未検出通知

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "sourceSequenceNo": 1,
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

### 10.3 キャリブレーション状態通知

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

- `status` は `succeeded` / `failed` のいずれかである。進捗中の表示はフロントエンドのローカル状態で管理する。
- `failed` は `validFrames`、`totalFrames`、`targetFrames` のみを追加で持ち、`sourceSequenceNo`、`calibratedAt`、`earOpen`、`earThreshold` は含めない。
- `succeeded` は上記全フィールドを必須とする。`calibratedAt` が `calibrations.calibrated_at` の保存元であり、`updatedAt` は送信・受理しない。

### 10.4 SSE解析結果イベントストリーム（ローカル検証ツール向けフォールバック）

Backendは同一プロセス内の購読者へ解析結果を中継するSSE APIも提供する。これはWorker推論パイプライン検証ページ（`/test`）など、SignalRクライアントへ未移行のローカル検証ツール向けのフォールバックであり、受講者画面（`student-session-page.tsx`）はこのAPIを使用せずSignalRのみに接続する。

購読:

```http
GET /api/sessions/{sessionId}/analysis-events
```

- Server-Sent Events (`text/event-stream`) として配信する。
- `data:` には `drowsiness_score` 、`tracking_status` または `calibration_status` のJSONをそのまま含める。
- SSE payloadは10.1〜10.3のSignalR payloadと同じJSON構造にする。
- 本APIはローカル検証ツール向けのフォールバック経路であり、本番の一次通知経路はSignalR配信仕様とする。

WorkerからBackendへのpublish:

本番はAzure Managed IdentityのMicrosoft Entra ID Bearer token（Backend audienceかつ`analysis_worker` app role）、ローカルE2Eは環境変数の `WORKER_API_KEY` に対応する `X-Worker-Api-Key` で認証する。ブラウザCookieをこのendpointの認証に使わない。

```http
POST /api/sessions/{sessionId}/analysis-results
```

request:

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

処理:

1. `analysis_worker` サービス資格情報を検証する。ブラウザCookieや任意のIDをWorker認証として受理しない。
2. `sessionId` の存在とrequest bodyとの一致を確認する。
3. `type` と型別必須項目を検証し、キャリブレーション／スコアの冪等キーを検証する。
4. 解析結果（該当する場合）と `analysis_event_outbox` を同一DBトランザクションで保存する。
5. `202 Accepted` を返す。別のOutboxディスパッチャーが、成功時のみSignalR GroupとSSE購読者へ配信済みを記録する。

### 10.1 キャリブレーション取得

```http
GET /api/sessions/{sessionId}/calibration
```

このAPIは `analysis_worker` サービス資格情報、または対象sessionに結び付いた `student_session` principal（教員は閲覧可能なsession）を受け付ける。受講者は自身のsession以外を取得できず、他sessionは `403` とする。成功済みキャリブレーションがある場合は `200` として `earOpen`、`earThreshold`、`validFrames`、`totalFrames`、`calibratedAt`、`sourceSequenceNo` を返し、未完了の場合は `204`、存在しないsessionは `404` とする。Workerはセッション処理開始時に取得し、`200` の場合は再キャリブレーションを開始しない。受講者画面はリロード復帰時に同じAPIで保存済み結果を照合し、クライアント保存値だけで再生を許可しない。

## 11. ダッシュボード取得API

すべて `[Authorize(Roles = "admin")]` とし、スコア・イベントはPostgreSQLから取得する。Hub再接続後の再取得を前提に、Redis・Workerメモリ・SignalRバッファを履歴参照元にしない。

### 11.1 セッション一覧

```http
GET /api/dashboard/sessions
```

response:

```json
[
  {
    "sessionId": "uuid",
    "studentId": "string",
    "videoId": "string",
    "startedAt": "2026-06-14T10:00:00Z",
    "endedAt": null,
    "latestLevel": "warning"
  }
]
```

### 11.2 セッション詳細

```http
GET /api/dashboard/sessions/{sessionId}
```

response:

```json
{
  "sessionId": "uuid",
  "studentId": "string",
  "videoId": "string",
  "startedAt": "2026-06-14T10:00:00Z",
  "endedAt": null
}
```

### 11.3 セッション削除

```http
DELETE /api/dashboard/sessions/{sessionId}
```

有効な `admin` roleだけが実行できる。セッション本体と関連する `playback_events`、`calibrations`、`drowsiness_scores`、`analysis_event_outbox`、当該受講者の `auth_sessions` を同一の削除操作で除去する。成功時は `204 No Content`、存在しないセッションは `404` を返す。削除後の受講者Cookieは失効し、対応するHub接続は以後の通知対象から外す。

### 11.4 眠気スコア系列

```http
GET /api/dashboard/sessions/{sessionId}/scores
```

response:

```json
[
  {
    "scoredAt": "2026-06-14T10:00:00Z",
    "videoTimeSec": 123.45,
    "score": 0.82,
    "level": "danger",
    "perclos": 0.61,
    "ear": 0.18,
    "pitchDeg": 12.4,
    "yawDeg": 4.2
  }
]
```

### 11.5 停止・再開イベント

```http
GET /api/dashboard/sessions/{sessionId}/playback-events
```

response:

```json
[
  {
    "eventId": "uuid",
    "type": "auto_pause",
    "occurredAt": "2026-06-14T10:00:00Z",
    "videoTimeSec": 123.45
  }
]
```

## 12. 運用healthと終了処理

- `GET /health/live` はprocessが応答可能なら `200 {"status":"live"}` を返す。DB、Redis、Blob、Service Bus障害ではlivenessを失敗にしない。
- `GET /health/ready` はPostgreSQL、Blob Storageの書込み先、Service Bus sender、Redis registry（設定時）、複数instance時のAzure SignalR設定を確認する。依存ごとに短いtimeoutを設け、成功時は `200`、新規requestを安全に受けられない場合は `503` を返す。bodyは状態名だけであり、接続文字列、token、例外詳細を返さない。
- `BACKEND_EXPECTED_INSTANCE_COUNT` が2以上のときは、起動時に `AZURE_SIGNALR_CONNECTION_STRING`（または `Azure:SignalR:ConnectionString`）とRedis接続設定を必須とする。未設定なら起動を失敗させ、同一process SignalRを複数instanceへ誤用しない。未設定または1のローカル単一processではASP.NET Core SignalRを使える。
- host shutdown開始時はreadinessを `503` にしてload balancerからdrainする。Outboxは以後のclaimを開始せず、claim済みbatchの配信完了をhostのshutdown猶予まで待つ。猶予を越えたleaseは期限後に他instanceが再取得するため、未配信を失わない。

## 13. 未決定事項

- Blob Storage上の映像フレーム保存期間・削除方針
