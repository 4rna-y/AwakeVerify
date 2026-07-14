# Task 04: Backendを複数instanceで安全に運用できるようにする

以下をそのまま実装Agentへの依頼文として使用する。

---

あなたはこのリポジトリのBackend水平スケール・接続信頼性担当Agentです。作業ルートは `workspace` です。

## 依存

- Task 02: 分散SignalR接続registry
- Task 03: 複数dispatcher対応Outbox

両タスクの実装とテストが完了していることを確認してください。

## 最重要ルール

1. 最初に `AGENTS.md` を読む。
2. WebSocket、SignalR、認証、Frontendの既存外部契約を変更しない。
3. Backend process固有の必須状態を新たに追加しない。
4. livenessとreadinessを分け、依存サービス障害で無限再起動を起こさない。
5. 複数Backend instanceのAzure経路ではAzure SignalR Serviceを使用する。
6. ローカル単一processのASP.NET Core SignalRも維持する。
7. `git --no-pager diff --check` は使用しない。

## 目的

WebSocket接続やSignalR接続が複数Backend instanceへ分散しても、既存scenarioを維持できるようにしてください。また、Azureの負荷分散・scale-in・rolling deploymentで安全に動作するhealth/readinessと終了処理を整えてください。

## 調査対象

- `src/backend/Awaver.Backend/Program.cs`
- `src/backend/Awaver.Backend/WebSockets/FrameWebSocketEndpoint.cs`
- `src/backend/Awaver.Backend/Hubs/AnalysisEventsHub.cs`
- Task 02のregistry
- Task 03のOutbox dispatcher
- Backend health endpoint
- `src/frontend/app/student/session/student-session-page.tsx`
- Frontend SignalR / WebSocket再接続テスト
- `docs/scenarios/student-learning-happy-path.md`
- `docs/features/09-realtime-notification.md`

## 実装要件

### 1. stateless確認

- WebSocket再接続先が別instanceでも認証できる。
- `student_session` はDB所有の `auth_sessions` で検証する。
- Backend local memoryをフレーム順序や永続的な認可の唯一の参照元にしない。
- フレーム順序と重複は `sequenceNo`、Service Bus Session、Worker冪等性で扱う。
- I/Pを使わない独立JPEG契約では、再接続後も`sequenceNo`を継続し、次の独立JPEGを送信する。Iフレーム強制はしない。

### 2. Azure SignalR設定

- `AZURE_SIGNALR_CONNECTION_STRING` が設定された場合はAzure SignalR Serviceを使用する。
- 複数instanceの本番相当設定で未設定なら、起動失敗または明確なreadiness失敗にする方針を仕様・環境設定に沿って実装する。
- ローカル開発では未設定を許容し、同一process SignalRを使用する。
- Task 02の分散registryとTask 03のOutbox送信を統合確認する。

### 3. liveness / readiness

liveness:

- processが応答可能かだけを確認する。
- PostgreSQLやRedis一時障害で即座にprocess再起動を繰り返さない。

readiness:

最低限、アプリが新規トラフィックを安全に受けられるか確認する。

- PostgreSQL
- Blob Storage
- Service Bus sender
- 分散registry用Redis
- Azure SignalR設定の整合性

依存チェックには短いtimeoutを設定する。秘密値を返さない。

### 4. scale-in / shutdown

- 新規request受付停止後、既存requestの終了を待つ。
- WebSocket切断時、Frontendが既存の指数バックオフで再接続できる。
- SignalR再接続後に `JoinSession(sessionId)` を再実行する既存挙動を維持する。
- Outbox dispatcherはshutdown後に新規claimせず、進行中処理を安全に終了する。
- 未完了Outbox leaseは期限後に別instanceが再取得できる。

### 5. Frontend回帰確認

UIを変更せず、必要なテストだけ追加・修正する。

- WebSocket再接続中は動画とフレーム送信を停止。
- 再接続成功後に古いtimer / socketを残さない。
- SignalR再接続後に `JoinSession` を再実行。
- 接続済みになるまで受講再開を許可しない。

## 必須テスト

1. WebSocket接続を切断し、別Backend相当へ再接続して送信を継続できる。
2. 再接続後の `sequenceNo` がセッション内で継続する。
3. 再接続後のフレームがI/P関連フィールドを持たない独立JPEG契約に従う。
4. SignalR再接続後に `JoinSession` が再実行される。
5. Outbox処理instanceと接続受付instanceが異なっても通知対象を解決できる。
6. livenessはRedis / DB一時障害で不健康にならない。
7. readinessは必須依存障害を検知する。
8. readiness responseに秘密値を含めない。
9. shutdown後にOutboxを新規claimしない。
10. rolling restart相当で未配信Outboxが別instanceから再処理される。
11. ローカルAzure SignalR未設定構成が動作する。
12. 本番複数instance設定でAzure SignalR不足を見逃さない。

## write scope

- Backend health / readiness / shutdown
- Azure SignalR設定検証
- Backend統合テスト
- 必要最小限のFrontend再接続テスト
- component specの実装詳細補足

Task 02/03のコアアルゴリズムを不要に変更しない。

## 非対象

- Worker並列化
- Azureリソース作成
- UIデザイン変更
- payload変更

## 完了条件

- Backendを複数instanceで起動できる。
- 接続受付instanceとOutbox処理instanceの分離に耐える。
- health/readinessがAzure運用に使用できる。
- rolling restart / scale-inで未配信結果を失わない。
- Frontend再接続scenarioを維持する。

## 完了報告

1. stateless性を確認・修正した箇所。
2. liveness / readiness契約。
3. shutdown手順。
4. Azure SignalR必須判定。
5. 実行したBackend / Frontendテストと結果。
6. Task 05のIaCへ渡す設定項目。
