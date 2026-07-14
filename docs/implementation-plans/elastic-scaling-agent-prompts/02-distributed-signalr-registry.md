# Task 02: SignalR接続registryを複数Backend instance対応にする

以下をそのまま実装Agentへの依頼文として使用する。

---

あなたはこのリポジトリのBackendリアルタイム通知担当Agentです。作業ルートは `workspace` です。

## 依存

Task 00の弾力的スケールFeature / Scenarioが追加済みであること。

## 最重要ルール

1. 最初に `AGENTS.md` を読む。
2. 認証失効後の接続へ通知しないという既存要件を弱めない。
3. SignalR payload、Hub method名、`JoinSession(sessionId)` 契約を変更しない。
4. Azure本番は複数Backend + Azure SignalR Service、ローカルは単一Backendでも動作させる。
5. Redis障害時にOutboxイベントを配信済み扱いにしない。
6. SSEは `/test` 用ローカルフォールバックのままとし、本番分散基盤へ昇格させない。
7. 秘密値を追加・ログ出力しない。
8. `git --no-pager diff --check` は使用しない。

## 目的

現在プロセス内 `ConcurrentDictionary` に保持されているSignalR接続情報を、複数Backend instanceから参照できる分散registryへ変更してください。

Outboxを処理したBackend instanceと、SignalR接続を受け付けたBackend instanceが異なっても、対象sessionの有効な接続へ通知できることが目標です。

## 調査対象

- `src/backend/Awaver.Backend/Services/AnalysisConnectionRegistry.cs`
- `src/backend/Awaver.Backend/Hubs/AnalysisEventsHub.cs`
- `src/backend/Awaver.Backend/Services/AnalysisOutboxDispatcher.cs`
- `src/backend/Awaver.Backend/Controllers/AuthController.cs`
- session revoke / logout / session delete処理
- `src/backend/Awaver.Backend/Program.cs`
- `src/backend/Awaver.Backend/Awaver.Backend.csproj`
- Backend tests

## 実装要件

### 1. registry abstraction

接続registryをインターフェース化する。

必要な操作:

- register
- remove connection
- remove connection + observed session
- remove auth session
- observed sessionに属する候補接続の取得
- stale connection cleanup

テストではin-memory implementationを使用できるようにする。

### 2. Redis-backed registry

Azure本番と本番相当ローカルE2EではRedis-backed implementationを使用する。

登録情報:

- `connectionId`
- `authSessionId`
- `observedSessionId`
- 登録時刻または最終更新時刻
- TTL

WorkerのPERCLOSキーと衝突しない名前空間を使用する。

例をそのまま採用する必要はないが、意味が分かるprefixにする。

```text
signalr:connection:{connectionId}
signalr:session:{observedSessionId}:connections
signalr:auth:{authSessionId}:connections
```

複数キーを更新する場合は、Lua、transaction、または安全な既存Redis操作で整合性を維持する。

### 3. lifecycle

- `JoinSession` 成功後にregisterする。
- `LeaveSession` で対象登録を削除する。
- disconnectでconnectionの全登録を削除する。
- logout、revoke、session削除でauth sessionに属する登録を削除する。
- abrupt disconnectで削除できない場合に備えTTLを設定する。
- SignalR再接続後の新しいconnection IDを正しく登録する。

### 4. 配信時認可

Outbox配信時に、registryから取得した接続の `authSessionId` をBackend所有DBで検証する。

次を満たさない接続は配信対象から除外し、registryから削除する。

- revokeされていない。
- idle expiry前。
- absolute expiry前。
- 接続が購読する `observedSessionId` とイベントのsessionが一致する。

### 5. Azure SignalR

`AZURE_SIGNALR_CONNECTION_STRING` がある場合、Azure SignalR Serviceを利用する既存設定を維持する。

分散registryから取得したconnection IDに対する送信が、Outbox処理instanceと接続受付instanceが異なる構成で動作するよう実装する。

Group配信へ変更する場合は、配信時auth session検証を満たす具体的設計を先に示すこと。単に `Clients.Group` へ置換して失効確認を削除してはならない。

### 6. 障害処理

- Redis取得・更新の一時失敗を握りつぶさない。
- registryを確認できない場合、通知を成功扱いにしない。
- Redisエラーに秘密値を含めない。
- cleanup失敗はログ・監視可能にする。

## write scope

主なwrite scope:

- Backendの接続registry
- SignalR Hub
- auth session revoke / logout連携
- DI設定
- Redis package/config
- Backend tests

`AnalysisOutboxDispatcher` は新しいregistry abstractionを利用するための最小変更だけ許可する。batch / leaseの本格変更はTask 03へ残す。

## 必須テスト

1. instance A相当でregisterし、instance B相当から取得できる。
2. 別sessionの接続を返さない。
3. disconnectで登録が削除される。
4. logout / revokeでauth sessionの登録が削除される。
5. idle expiry後は配信候補にならない。
6. absolute expiry後は配信候補にならない。
7. TTL切れのstale接続を返さない。
8. SignalR再接続後は新connection IDだけが有効になる。
9. Redis障害時にOutbox側へ失敗が伝播する。
10. ローカル単一BackendのSignalRテストが継続して通る。
11. 他sessionへの `JoinSession` 拒否が維持される。

可能ならdevcontainer Redisを使用した結合テストも追加する。

## 非対象

- Worker Session並列化
- Outbox lease migration
- Azure IaC
- Frontend UI変更

## 完了条件

- SignalR接続registryがプロセス内メモリだけに依存しない。
- 複数Backend instanceから同じ接続情報を参照できる。
- auth session失効後の接続へ通知しない。
- Redis障害時に通知成功扱いにしない。
- Azure SignalR経路とローカル単一process経路を維持する。

## 完了報告

1. registryのRedisデータ構造。
2. register / remove / TTL / cleanup手順。
3. 配信時認可の方法。
4. Azure SignalRで複数instanceを成立させる方法。
5. 実行したテストと結果。
6. Task 03が利用すべきインターフェース。
