# Task 07: 弾力的スケーリングの統合・受け入れ確認を行う

以下をそのまま実装Agentへの依頼文として使用する。

---

あなたはこのリポジトリの最終統合・レビュー担当Agentです。作業ルートは `workspace` です。

## 依存

以下が完了していること。

- Task 00: Feature / Scenario契約
- Task 01: Worker Session並列化
- Task 02: 分散SignalR接続registry
- Task 03: Outbox水平スケール
- Task 04: Backend複数instance対応
- Task 05: Azure IaC / autoscale
- Task 06: 可変負荷テスト

## 最重要ルール

1. 最初に `AGENTS.md` を読む。
2. 新機能を追加するのではなく、一次仕様のscenarioを統合確認する。
3. テスト失敗を隠すために有意なコードを削除・簡略化しない。
4. 関連しない既存問題を修正しない。
5. 仕様と実装の不一致を見つけた場合、一次仕様を優先し、どちらを修正したか報告する。
6. Azureへ無断で負荷をかけない。
7. `git --no-pager diff --check` は使用しない。

## 目的

固定同時利用者数に依存せず、Session数と負荷に応じてWorker / Backendが分散可能であり、既存の受講scenarioを壊していないことを統合確認してください。

## 最初に確認する仕様

- Task 00で追加された弾力的処理Feature
- Task 00で追加された複数Session分散Scenario
- `docs/scenarios/student-learning-happy-path.md`
- `docs/scenarios/calibration-retry.md`
- `docs/scenarios/drowsiness-auto-pause-resume.md`
- `docs/scenarios/face-not-detected-warning.md`
- `docs/features/04-frame-storage-and-queue.md`
- `docs/features/08-drowsiness-scoring.md`
- `docs/features/09-realtime-notification.md`

## コードレビュー観点

### Worker

- `WORKER_SESSION_CONCURRENCY` 等の並列度が設定可能。
- 同一Sessionを複数slotが処理しない。
- 異なるSessionが並列処理される。
- analyzer / decoder / stateのownershipが明確。
- shutdown時に新しいSessionを取得しない。
- lock消失後にsettlementしない。
- Backend `202 Accepted` 前にcompleteしない。
- Redis冪等性を維持する。

### Backend SignalR

- connection registryが分散ストアを正とする。
- 別Backend instanceから同じ登録を取得できる。
- auth session失効後の接続へ通知しない。
- Redis障害時に通知成功扱いにしない。
- Azure SignalRとローカルSignalRの切替が明確。

### Outbox

- batch / poll / leaseが設定可能。
- 固定25件制限がない。
- claim transactionが短い。
- ネットワーク配信中に長時間row lockを保持しない。
- 複数dispatcherが異なるイベントを処理できる。
- crash後にlease期限で復旧できる。
- 配信成功時だけ `delivered_at` を設定する。

### Backend / Frontend接続

- WebSocket再接続先が別instanceでも継続できる。
- sequence番号を維持する。
- 再接続後もI/P関連フィールドなしの独立JPEGを送信する。
- SignalR再接続後に `JoinSession` を再実行する。
- 接続復旧前に動画・フレーム送信を再開しない。

### Azure IaC

- 同時利用者数をハードコードしていない。
- Backend / Worker min/max scaleがparameter化されている。
- WorkerにService Bus backlog scale ruleがある。
- Service Bus queueでSessionが有効。
- Azure SignalR Serviceが複数Backendの共通基盤。
- Blob Lifecycle Ruleがある。
- secret実値がない。

## 必須テスト順

変更箇所に近い順に実行する。

1. Worker unit tests
2. Worker concurrency / reliability tests
3. Backend unit tests
4. Redis connection registry tests
5. Outbox claim / lease tests
6. Backend health / readiness tests
7. Frontend type check / lint
8. Frontend WebSocket / SignalR再接続テスト
9. PostgreSQL / Redis / Azurite / Service Bus Emulatorを使った結合テスト
10. 可変Session数の負荷試験
11. scenario単位のE2Eまたは手動確認
12. Azure IaC build / validate

## scenario受け入れ条件

### 複数Session正常系

- 2以上のSessionを同時投入する。
- 異なるSessionのWorker処理時間が重なる。
- 各Sessionのsequence順序が維持される。
- 各Sessionが自分のSignalR通知だけを受信する。
- スコアとOutboxが重複保存されない。

### Worker障害

- 処理中Workerを停止する。
- lock失効またはabandon後に別slot / replicaが再配送を処理する。
- 同じ解析結果を重複保存しない。
- 次の有効な独立JPEGから直ちに解析を再開する。

### Backend障害

- SignalR接続を受けたinstanceと異なるinstance相当でOutboxを処理する。
- 対象接続へ通知される。
- Backend再起動後に未配信Outboxが再試行される。
- WebSocket / SignalR再接続後に受講を継続できる。

### 認証失効

- 接続後にauth sessionをrevokeする。
- 以後のイベントがその接続へ配信されない。
- 他SessionへのJoinと購読が拒否される。

### Outbox負荷

- 25件を超えるOutboxイベントを投入する。
- batch設定に従い継続処理される。
- 最古イベント年齢が増え続けない。
- 複数dispatcherでclaim重複がない。

### max scale到達

実Azureでなくても、Worker処理能力を意図的に制限して検証してよい。

- Queue backlogとして残る。
- フレームがサイレントに消えない。
- DLQまたはretry状態を観測できる。
- Backend ACK / NACK契約を維持する。

## 性能結果の扱い

特定人数の成功だけを完了条件にしない。

以下の形式で結果を残す。

- Session数
- fps
- duration
- Worker slot数
- Worker replica相当数
- Backend instance相当数
- ACK / NACK
- 結果通知数
- 通知遅延 p50 / p95 / max
- Queue backlog
- Outbox backlog
- エラー・再送・DLQ

この結果から、環境ごとのcapacity planningに使える情報を報告する。

## 修正範囲

統合テストで見つかった、本タスクに直接起因する問題は修正してよい。

- 1〜2回の focused attemptで直せない場合は、意味のあるコードを削除せず残課題として報告する。
- migration競合、設定名不一致、test fixture不整合は可能な範囲で解消する。
- 新しい大規模機能や無関係なUI変更は行わない。

## Azure検証

Azure資格情報と対象環境が明確な場合のみ、低い安全な負荷でsmoke testする。

資格情報がない場合:

- IaC build / validate
- parameter整合性
- secret未混入
- deployment手順レビュー

まで行い、実デプロイ未実施を明記する。

## 完了条件

- 弾力的処理Feature / Scenarioに対応するテストが存在する。
- 同一Session直列・異なるSession並列を確認した。
- Worker / Backend障害から復旧した。
- 複数Backend相当でSignalR通知が届いた。
- auth session失効後に通知されない。
- Outbox固定25件ボトルネックが解消されている。
- Azure IaCがvalidateできる。
- 既存受講scenarioが回帰していない。
- 固定人数を前提としない負荷結果が残っている。

## 完了報告

1. 検証したFeature / Scenario。
2. 実行したコマンドと結果。
3. 負荷試験条件と測定結果。
4. Worker分散とSession順序の確認結果。
5. Backend / SignalR / Outboxの複数instance確認結果。
6. 障害注入と復旧結果。
7. Azure IaC検証・実デプロイ有無。
8. 既知の残課題。
9. 容量上限を判断するため今後監視すべき指標。
