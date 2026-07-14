# Task 03: Outbox Dispatcherを複数instanceで水平スケール可能にする

以下をそのまま実装Agentへの依頼文として使用する。

---

あなたはこのリポジトリのBackend Outbox担当Agentです。作業ルートは `workspace` です。

## 依存

- Task 00のFeature / Scenarioが追加済み。
- Task 02の分散SignalR接続registryが実装済み。

Task 02が公開したregistry interfaceと障害契約を先に確認してください。

## 最重要ルール

1. 最初に `AGENTS.md` を読む。
2. 解析結果とOutboxを同一transactionで保存する既存契約を維持する。
3. `202 Accepted` は解析結果とOutboxが永続化された場合だけ返す。
4. SignalR送信成功前に `delivered_at` を設定しない。
5. Outboxはat-least-once配信とし、crash境界の重複配信を許容する。
6. payload契約を変更しない。
7. 複数dispatcherが同じイベントを通常時に同時配信しない。
8. DB transactionを保持したまま長時間ネットワークI/Oを行わない設計を優先する。
9. `git --no-pager diff --check` は使用しない。

## 目的

現行の1秒poll・`LIMIT 25`・transaction保持中SignalR送信を、設定可能で複数Backend instanceから安全に並列実行できるOutboxへ変更してください。

## 調査対象

- `src/backend/Awaver.Backend/Services/AnalysisOutboxDispatcher.cs`
- `src/backend/Awaver.Backend/Models/AnalysisEventOutbox.cs`
- `src/backend/Awaver.Backend/Data/AwaverDbContext.cs`
- `src/backend/Awaver.Backend/Controllers/AnalysisResultsController.cs`
- `src/backend/Awaver.Backend/Migrations/**`
- `src/backend/Awaver.Backend/Program.cs`
- `src/backend/Awaver.Backend.Tests/**`

## 実装要件

### 1. 設定化

既存設定規則に合わせ、以下に相当する設定を追加する。

```text
OUTBOX_BATCH_SIZE
OUTBOX_POLL_INTERVAL_MS
OUTBOX_LEASE_SECONDS
```

- 正の値だけを受理する。
- 不正値は起動時に明確なエラーとする。
- batch sizeを同時利用者数へ固定しない。
- 既定値は通常の複数Session通知を処理できる余裕を持たせるが、根拠をテストとドキュメントへ記載する。

### 2. claim / lease

短いtransactionで未配信イベントをclaimし、transactionをcommitしてからSignalRへ送信する。

必要ならOutboxに以下に相当する列を追加する。

- `lease_id` またはprocessing token
- `locked_until`
- `processing_owner`

条件:

- `delivered_at IS NULL`
- `next_attempt_at <= now`
- leaseなし、またはlease期限切れ

複数dispatcherが同時にclaimしてもイベントが重ならないよう、PostgreSQLの `FOR UPDATE SKIP LOCKED` または同等の原子的更新を使う。

### 3. 配信

- Task 02の分散registryから対象sessionの有効なconnection IDを取得する。
- Azure SignalR経由で `ReceiveAnalysisEvent` を送信する。
- 接続が0件であることはエラーにしない。過去イベント再送は保証しない既存仕様を維持する。
- Redis / registry自体を確認できない場合は配信成功にしない。
- SSEはローカル `/test` 向けとして既存挙動を維持する。
- SSE購読者が0件であることを失敗にしない。

### 4. 成功・失敗

成功:

- 対象SignalR配信処理が正常終了。
- `delivered_at` を設定。
- leaseを解除。
- `last_error` をクリア。

一時失敗:

- `attempt_count` を増やす。
- 既存方針の指数バックオフで `next_attempt_at` を更新する。
- leaseを解除または期限切れ再取得可能にする。
- `delivered_at` は設定しない。

process crash:

- lease期限後に別dispatcherが再取得できる。
- 送信後・DB更新前のcrashでは重複配信を許容する。

### 5. 観測性

秘密情報やpayload全文を出さず、少なくとも以下を観測可能にする。

- claim件数
- 配信成功件数
- 配信失敗件数
- retry回数
- 未配信件数
- 最古未配信イベント年齢
- batch処理時間

既存の監視方式があればそれに合わせる。大規模な監視基盤追加は不要。

## 必須テスト

1. 25件を超えるイベントを1回または設定どおりのbatchで処理できる。
2. 2つのdispatcherが同時実行してもclaimが重ならない。
3. 別dispatcherが異なるイベントを並列処理できる。
4. SignalR送信中にDB row lockを保持し続けない。
5. 送信失敗時に `delivered_at` が設定されない。
6. Redis registry障害時に `delivered_at` が設定されない。
7. 送信成功時だけ `delivered_at` が設定される。
8. lease期限切れイベントを別dispatcherが再取得できる。
9. 送信後・更新前crash相当で再配送可能。
10. exponential backoffが維持される。
11. 接続0件ではイベントを処理済みにできる。
12. SSE購読者0件では失敗しない。
13. 同一解析結果の再投稿でOutbox行が重複しない。
14. `drowsiness_score`、`tracking_status`、`calibration_status` のpayloadを変更していない。

可能な範囲で実PostgreSQLを使った並列claim統合テストを追加する。InMemory DBだけでlockingを検証したことにしない。

## write scope

- Outbox model / service / options
- `AwaverDbContext`
- Outbox migration
- Outbox DI設定
- Backend tests
- 必要なBackend設定例

Task 02のregistry実装を不要に書き換えない。

## 非対象

- Worker並列化
- Azure IaC
- Frontend UI変更
- SignalR payload変更

## 完了条件

- 固定25件/秒の制約がない。
- batch / poll / leaseが設定可能。
- 複数dispatcherが安全に並列処理できる。
- ネットワーク送信中に長時間DB lockを保持しない。
- crash後に再試行できる。
- auth session検証とRedis障害契約を維持する。

## 完了報告

1. claim / leaseアルゴリズム。
2. migration内容。
3. 設定値と既定値。
4. at-least-once境界。
5. 実行したテストと結果。
6. 監視可能になった指標。
