# 実装Agent用Prompt：未完了シナリオの認証・解析信頼性実装

以下をそのまま実装Agentへの依頼文として使用する。

---

あなたはこのリポジトリの実装担当Agentです。作業ルートは `workspace` です。

## 最重要ルール

1. 最初に `AGENTS.md` を読み、**Feature / Scenario first** を厳守してください。
2. 仕様の優先順位は、`docs/features/` と `docs/scenarios/`、次に `docs/backend/spec.md`、`docs/frontend/spec.md`、`docs/worker/spec.md`、最後に既存コードです。
3. このPromptおよび二次仕様だけを根拠に推測で実装しないでください。矛盾・不足を見付けた場合は一次仕様を確認し、重大な未決定事項なら実装を止めて報告してください。
4. 関連しないリファクタリング、依存関係の不必要な追加、既存ユーザー変更の上書き・削除をしないでください。
5. 変更後は、対象テストから順に実行し、最後にscenario単位の統合確認を行ってください。

## 目的

以下の未完了scenarioを、認証・解析結果永続化・Worker再試行・ローカルE2Eの観点から実装可能な状態から**実際に動作する状態**へ進めてください。

- `docs/scenarios/admin-teacher-onboarding.md`
- `docs/scenarios/teacher-dashboard-review.md`
- `docs/scenarios/student-learning-happy-path.md`
- `docs/scenarios/calibration-retry.md`
- `docs/scenarios/drowsiness-auto-pause-resume.md`
- `docs/scenarios/face-not-detected-warning.md`

実装の詳細な分割・依存関係・想定変更ファイルは、まず次を読んでください。

- `docs/implementation-plans/scenario-completion-plan.md`

以下のFeatureが、この作業の一次仕様です。必ず実装前に読んでください。

- `docs/features/04-frame-storage-and-queue.md`
- `docs/features/06-face-recognition.md`
- `docs/features/07-calibration.md`
- `docs/features/08-drowsiness-scoring.md`
- `docs/features/09-realtime-notification.md`
- `docs/features/12-teacher-login.md`
- `docs/features/13-teacher-account-management.md`
- `docs/features/14-teacher-dashboard.md`

その後、次の二次仕様を読んで実装ファイルを特定してください。

- `docs/backend/spec.md`
- `docs/frontend/spec.md`
- `docs/worker/spec.md`
- `docs/worker/local-gui-and-shared-architecture.md`

## 実装する確定契約

### 1. Browser認証と認可

- 管理者・教員は、サーバー側 `auth_sessions` と不透明なHttpOnly Cookieで認証する。
- 本番Cookieは `__Host-awaver-auth`、ローカルHTTPでは `awaver-auth` を使用する。
- Cookie属性は一次仕様に従い、`HttpOnly`、`SameSite=Lax`、`Path=/`、本番では `Secure=true` とする。
- 教員・管理者sessionの期限は、絶対8時間・アイドル30分。認証済みrequestでアイドル期限は更新してよいが、絶対期限は更新しない。
- `POST /api/auth/logout` はDB上のsessionを失効させてCookieを削除する。
- `GET /api/auth/me` は現在のprincipal、role、ID、期限を返す。
- 管理者・教員パスワードは既存のASP.NET Core `PasswordHasher`（PBKDF2-HMAC-SHA256 / Identity V3）で保存・照合し、平文を保存・ログ出力しない。
- `POST /api/admin/teachers` のrequest bodyから `adminId` を削除する。管理者IDは認証principalだけから取得する。
- `adminId` / `teacherId` / tokenを `sessionStorage`、`localStorage`、request bodyに保持して認可してはならない。
- `admin` roleだけが管理者APIを実行できる。`teacher` roleだけがDashboard APIを参照できる。
- 未認証・失効・期限切れは `401`、role不足は `403` とする。
- Cookieを使う状態変更APIはCSRF保護を実装する。同一オリジンを原則とし、別オリジン開発では固定originのCORS資格情報送信とCSRFトークン検証を行う。

### 2. 受講者session、WebSocket、SignalR認可

- `POST /api/sessions` は新規 `learning_session` とともに、その `sessionId` に束縛した短命の `student_session` HttpOnly Cookieを発行する。
- 受講者は、自身のCookieのsessionと一致する場合だけ、以下を実行できる。
  - `/ws/sessions/{sessionId}/frames`
  - `GET /api/sessions/{sessionId}/analysis-events`
  - `POST /api/sessions/{sessionId}/playback-events`
  - SignalR `JoinSession(sessionId)`
- `AnalysisEventsHub` は認証必須とする。
  - 受講者は自身のsession Groupだけ参加できる。
  - `teacher` roleは既存sessionをDashboard表示用に購読できる。
  - `admin` role、匿名、別受講者sessionのGroup参加は拒否する。
- FrontendはCookieを自動送信する接続方式でWebSocket・SignalR・fetchを利用する。Hub引数やrequest bodyへ認可情報を追加しない。

### 3. Workerサービス認証

- `POST /api/sessions/{sessionId}/analysis-results` は `analysis_worker` サービス資格情報だけを受け付ける。
- 本番はAzure Managed Identityが取得するMicrosoft Entra ID OAuth 2.0 client-credentials Bearer tokenを使用し、Backend APIのaudienceと `analysis_worker` app roleを検証する。
- ローカルE2Eは環境変数 `WORKER_API_KEY` を `X-Worker-Api-Key` で送信・検証する。秘密値をリポジトリへ追加・ログ出力しない。
- Browser Cookie、`sessionId`、`teacherId`、`adminId` をWorker認証として受理してはならない。

### 4. Backend所有の解析永続化とOutbox

WorkerはPostgreSQL・SignalRへ直接接続しない。BackendがDB schema、永続化、通知を所有する。

追加または更新するDBモデル・Migration:

- `auth_sessions`
  - `session_id`、`principal_type`、`principal_id`、`issued_at`、`idle_expires_at`、`absolute_expires_at`、`revoked_at`
- `calibrations`
  - `session_id` を主キーかつ `learning_sessions` FKにする。
  - `ear_open`、`ear_threshold`、`calibrated_at`、`source_sequence_no`。
  - 成功キャリブレーションは1 sessionにつき1件。失敗試行は保存しない。
- `drowsiness_scores`
  - `session_id`、`source_sequence_no`、`scored_at`、`score`、`level`、`perclos`、`ear`、`pitch_deg`、`yaw_deg`。
  - 主キーは `(session_id, source_sequence_no)`、`(session_id, scored_at)` は一意。
- `analysis_event_outbox`
  - `event_id`、`session_id`、`payload`、`created_at`、`delivered_at`、`attempt_count`、`next_attempt_at`、`last_error`。

`POST /api/sessions/{sessionId}/analysis-results` は以下を守る。

1. Workerサービス認証、path/bodyのsessionId一致、session存在、payload型と必須値を検証する。
2. `calibration_status: succeeded` は `sourceSequenceNo` を必須とし、同じ成功結果だけを冪等受理する。既存成功結果と異なる値は競合として拒否する。
3. `drowsiness_score` は `sourceSequenceNo` とUTC秒に丸めた `scoredAt` を必須とし、同一キーの同一内容だけを冪等受理する。
4. 解析行と `analysis_event_outbox` 行を**同一PostgreSQLトランザクション**で保存する。
5. `202 Accepted` は、結果が永続化・Outbox登録済みの場合にだけ返す。
6. SignalR/SSEへ直接送信してから保存する実装は禁止する。

Outbox dispatcherを実装する。

- 未配信レコードを並行実行しても重複配信処理しないようにロックする。
- SignalRと、認証済み`/test`用SSE購読者に同じpayloadを配信する。
- 配信成功時のみ `delivered_at` を記録する。
- 一時失敗は指数バックオフで再試行する。
- 接続していなかったクライアントへの過去イベント再送は保証しない。DashboardはREST再取得を正とする。

### 5. WorkerのRedis・Service Bus信頼性

- ローカルE2Eと本番は、Blob StorageとService Busを本番アダプターで利用する。
  - local: devcontainerのAzuriteとAzure Service Bus Emulator。
  - ファイル保存・ログ出力だけのfallbackはE2Eに使わず、必要な単体テストのtest doubleに限定する。
- Service Bus queueはSession有効とし、`sessionId` をSession IDとして使用する。
- Workerは同一sessionを並列処理しない。
- Redisには `perclos:{sessionId}:frames` を使用する。
  - 顔検出フレームの `sequenceNo`、`capturedAt`、閉眼判定を保持する。
  - 顔未検出フレームを入れない。
  - Luaで重複 `sequenceNo` を無視し、LPUSH / LTRIM(75) / LRANGE / EXPIREを原子的に行う。
  - TTLはFeature 08に従う。
- Workerは解析結果をBackend APIへ送信し、Backendの`202 Accepted`後にだけService Busメッセージを `complete` する。
- 以下は `abandon` して再配送する。
  - Blob取得の一時失敗
  - Redis一時障害
  - Backend timeout、429、5xx
- 配送回数上限に達した再試行可能失敗はdead-letterする。
- 以下は直ちにdead-letterする。
  - blob path / 必須メタデータ不正
  - 対応外codec
  - payload検証エラー
  - Worker認証・認可失敗
- 重複配送は `sessionId` と `sequenceNo` で冪等に処理する。
- Pフレーム欠落・順序不整合はdead-letter理由にせず、そのGOPの後続Pフレームを破棄して次Iフレームで復旧する。

### 6. Frontend

- `src/frontend/app/admin/teachers/admin-session-storage.ts` を削除し、管理者IDを `sessionStorage` から読まない。
- Admin / Teacher / DashboardのfetchはCookie認証を使い、`401` はログインへ遷移、`403` は権限エラーを表示する。
- `/api/auth/me` によるroute guardと、`POST /api/auth/logout` によるlogoutを実装する。
- Student画面は、`student_session` Cookie前提でWebSocketとSignalRに接続する。
- SignalR再接続後は `JoinSession(sessionId)` を再実行する。
- DashboardはSignalR再接続成功後、一覧と選択中sessionのREST APIを再取得する。
- 次の既存シナリオのUI状態・文言・動画制御を変更しない。
  - キャリブレーション成功前は再生禁止
  - `danger` / `shouldPause` で5秒巻き戻し自動停止
  - `normal` 復帰後、明示操作でのみ再開
  - 顔未検出Popup、顔復帰後の「おかえり！」Popup

## 推奨実装順序

`docs/implementation-plans/scenario-completion-plan.md` のT1〜T8を守ること。特に以下を守る。

1. T1: devcontainer Emulator構成の確認。
2. T2: 認証・認可・受講者session。
3. T3: DB migration、解析結果API、Outbox。
4. T4: Worker Redis・サービス認証・retry / DLQ。
5. T5/T6/T7: Admin/Teacher、Student、DashboardのFrontendを契約固定後に実装する。
6. T8: scenario単位の統合テスト。

T2とT3は同一DbContext/Migrationに関わるため、schema契約を先に固定して順番に実装する。T5、T6、T7を並列化する場合は、API payload・role・エラーコード・DB制約を変更しない。

## 既存コードの主な調査・変更候補

実装前に実在を確認し、既存設計に沿って変更してください。

- Backend
  - `src/backend/Awaver.Backend/Program.cs`
  - `Controllers/AdminController.cs`
  - `Controllers/TeacherController.cs`
  - `Controllers/SessionsController.cs`
  - `Controllers/AnalysisResultsController.cs`
  - `Hubs/AnalysisEventsHub.cs`
  - `WebSockets/FrameWebSocketEndpoint.cs`
  - `Data/AwaverDbContext.cs`
  - `Models/`
  - `Migrations/`
  - `Services/AnalysisResultBroadcaster.cs`
  - `Awaver.Backend.Tests/`
- Worker
  - `src/worker/app/main.py`
  - `src/worker/shared/`
  - `src/worker/tests/test_calibration.py`
  - `src/worker/tests/test_drowsiness.py`
  - `src/worker/tests/test_startup_checks.py`
- Frontend
  - `src/frontend/app/admin/teachers/admin-teachers-page.tsx`
  - `src/frontend/app/admin/teachers/admin-session-storage.ts`
  - `src/frontend/app/student/session/student-session-page.tsx`
  - `src/frontend/app/teacher/dashboard/teacher-dashboard-page.tsx`
  - 教員ログイン画面、共通API client、route guard、関連テスト
- 開発環境
  - `.devcontainer/docker-compose.yml`
  - `.devcontainer/servicebus-config.json`
  - `.devcontainer/.env.example`

## 必須テスト・受け入れ条件

以下をテストで確認してください。

1. `adminId` / `teacherId` / `sessionId` の偽装だけで、保護API・他session WebSocket・他session SignalR Groupへアクセスできない。
2. AdminがTeacherを作成し、そのTeacherがログインしてDashboardを閲覧できる。
3. logout・session失効・絶対期限・role不足が`401` / `403`として扱われる。
4. Workerの同一結果再送で、calibration・score・Outboxが重複保存されない。
5. SignalR送信失敗後も解析結果はDBに残り、Outboxが再試行する。
6. Blob / Redis / Backendの一時障害ではService Busが再配送され、恒久エラーはdead-letterされる。
7. 顔未検出はPERCLOSに含めず、UIを停止状態へ遷移させる。顔復帰後の明示再開を確認する。
8. `danger` 自動停止と `normal` 復帰後の明示再開、および `auto_pause` / `resume` 保存を確認する。
9. Dashboardは永続化済み時系列・イベントを表示し、SignalR再接続後のREST再取得で表示を収束させる。
10. ローカルE2EはAzrite / Service Bus Emulator / PostgreSQL / Redisを用い、ログ出力だけの擬似キューでは通過しない。

## 完了時の報告形式

完了時は以下を簡潔に報告してください。

1. 実装したscenarioと対応Feature。
2. 変更したファイルと責務。
3. Migrationと環境変数・シークレット設定の追加内容（秘密値自体は出力しない）。
4. 実行したテスト、結果、実行できなかったテストの理由。
5. 既知の残課題または一次仕様への確認が必要な点。

アプリケーションコード、Migration、テスト、必要な設定例まで実装し、上記の受け入れ条件を満たすまで作業を継続してください。
