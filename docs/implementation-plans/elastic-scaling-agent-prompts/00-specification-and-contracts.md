# Task 00: 弾力的セッション処理のFeature / Scenario契約を確定する

以下をそのまま実装Agentへの依頼文として使用する。

---

あなたはこのリポジトリの仕様整理担当Agentです。作業ルートは `workspace` です。

## 最重要ルール

1. 最初に `AGENTS.md` を読み、Feature / Scenario firstを厳守してください。
2. このタスクではアプリケーションコードを変更しないでください。write scopeは原則 `docs/**` だけです。
3. 「何人でも」は無限容量ではなく、環境ごとの設定上限とAzureクォータ内で、負荷に応じて水平スケールできることを意味します。
4. `30` など特定の同時利用者数を仕様上の固定値にしないでください。
5. 既存の受講者UI、フレームpayload、眠気判定式、認証・認可、Service Bus再試行契約を変更しないでください。
6. 同じ内容を複数仕様へ重複記載せず、一次情報を明示してください。
7. `git --no-pager diff --check` は使用しないでください。

## 目的

同時利用者数を事前に固定せず、受講セッション数と負荷に応じてBackend、Worker、Outbox、SignalRを水平スケールさせるための一次仕様と受け入れscenarioを追加してください。

この仕様は後続タスクのAPI・状態・環境変数・IaC契約の基準になります。

## 読むファイル

一次仕様:

- `docs/features/03-video-frame-sending.md`
- `docs/features/04-frame-storage-and-queue.md`
- `docs/features/05-frame-decoding.md`
- `docs/features/08-drowsiness-scoring.md`
- `docs/features/09-realtime-notification.md`
- `docs/scenarios/student-learning-happy-path.md`
- `docs/scenarios/student-session-reliability-manual-verification.md`

二次仕様・運用:

- `docs/backend/spec.md`
- `docs/worker/spec.md`
- `docs/frontend/spec.md`
- `docs/operations/production-setup.md`
- `docs/implementation-plans/scenario-completion-plan.md`

既存コードは契約上の問題確認に限って読んでよいです。とくに以下を確認してください。

- `src/worker/app/main.py`
- `src/backend/Awaver.Backend/Services/AnalysisConnectionRegistry.cs`
- `src/backend/Awaver.Backend/Services/AnalysisOutboxDispatcher.cs`
- `src/backend/Awaver.Backend/Hubs/AnalysisEventsHub.cs`

## 追加する一次仕様

既存命名規則に合わせ、以下に相当するFeatureとScenarioを追加してください。

- Feature: セッション単位の弾力的フレーム処理
- Scenario: 複数受講セッションの動的分散

ファイル名は既存の連番・命名に合わせて決定してください。

### Featureに含める契約

- 同時利用者数を固定しない。
- `sessionId` を順序保証と分散の単位にする。
- 同じSessionのフレームは常に直列処理する。
- 異なるSessionはWorker slotまたはWorker replicaをまたいで並列処理できる。
- WorkerのSession並列度は設定可能とし、既定値は後方互換性を優先する。
- Service Bus Session lock消失後にメッセージをsettleしない。
- Worker停止時は新しいSession取得を止め、処理中作業を安全に終了する。
- Worker障害後は別WorkerがSessionを再取得できる。
- ローカルデコーダ状態を失った場合、次のIフレームから最大約1秒で復旧する。
- Worker autoscaleはService Bus backlogを主要トリガーとし、最古メッセージ年齢をリアルタイム性の監視指標とする。
- Backendは複数instanceで動作でき、SignalR接続情報をプロセス内メモリだけへ依存させない。
- Azure本番の複数Backend構成ではAzure SignalR Serviceを利用する。
- Outboxは複数dispatcherが安全にclaimでき、batch size、poll間隔、leaseを設定可能にする。
- Outboxはat-least-once配信とし、crash境界の重複を許容する。
- フレームBlobの保持期間と削除は環境設定・Lifecycle Ruleで制御する。
- 最大replica数は環境設定とAzureクォータで制御し、コードへ人数を固定しない。

### Scenarioに含める正常系

1. 複数受講者が異なる `sessionId` で同時に5fps相当のフレームを送信する。
2. BackendがBlob保存とService Bus Session queueへの投入を行う。
3. Workerの複数slotまたは複数replicaが異なるSessionを並列取得する。
4. 同一Session内では `sequenceNo` 順に処理する。
5. Workerが解析結果をBackend APIへ冪等送信する。
6. 複数Backend instanceのいずれかがOutboxをclaimする。
7. SignalR接続を受けたBackend instanceとOutbox処理instanceが異なっても、対象Sessionへ通知が届く。

### Scenarioに含める異常系

- Worker停止後に別WorkerがSessionを再取得する。
- 重複配送されたフレームを再解析・重複保存しない。
- Pフレーム順序不整合は次のIフレームまで破棄する。
- Backend再起動後もOutbox未配信結果を失わない。
- SignalRまたは接続registry障害時にOutboxを配信済みにしない。
- auth session失効後の接続へ通知しない。
- scale-in時に処理中メッセージを誤ってcompleteしない。
- 最大replica数到達時はバックログとして可視化され、フレームをサイレントに失わない。

## 二次仕様の更新

一次仕様を参照する形で、必要な範囲だけ以下を更新してください。

- `docs/backend/spec.md`
  - 分散SignalR接続registry
  - 複数Outbox dispatcher
  - at-least-once配信
  - 複数Backend instance
- `docs/worker/spec.md`
  - Session slot
  - configurable concurrency
  - graceful shutdown
  - Worker autoscale
- `docs/operations/production-setup.md`
  - Azure SignalR必須条件
  - Container Apps autoscale
  - Service Bus Session queue
  - Blob Lifecycle
  - backlog / oldest-message / Outbox age監視

必要なら `docs/features/README.md` と `docs/scenarios/README.md` の一覧も更新してください。

## 未決定事項の扱い

実装で設定可能にできる値は、根拠なく固定しないでください。たとえば次は環境設定とし、仕様では意味・制約・既定値方針を定義してください。

- Worker Session並列度
- Worker min/max replica
- Service Bus queue threshold
- Outbox batch size
- Outbox poll interval
- Outbox lease duration
- Blob保持期間

## 完了条件

- 新しいFeatureとScenarioが追加されている。
- 正常系・異常系・受け入れ条件が明記されている。
- 固定人数が契約に含まれていない。
- 同一Session直列・異なるSession並列が一次仕様になっている。
- Backend / Worker / operationsの二次仕様が一次仕様を参照している。
- 既存Feature / Scenarioと矛盾していない。
- アプリケーションコードを変更していない。

## 完了報告

1. 追加・更新した仕様ファイル。
2. 確定した契約。
3. 設定値として残した項目。
4. 既存仕様との不整合と解消方法。
5. 後続実装Agentが注意すべき点。
