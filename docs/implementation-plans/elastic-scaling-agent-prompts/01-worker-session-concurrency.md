# Task 01: WorkerをService Bus Session単位で並列処理可能にする

以下をそのまま実装Agentへの依頼文として使用する。

---

あなたはこのリポジトリのWorker実装担当Agentです。作業ルートは `workspace` です。

## 依存

Task 00の仕様変更が完了していること。

- `docs/features/` の弾力的セッション処理Feature
- `docs/scenarios/` の複数受講セッション動的分散Scenario

最初に実在する追加ファイルを確認し、その受け入れ条件を一次仕様として使用してください。

## 最重要ルール

1. 最初に `AGENTS.md` を読む。
2. write scopeは原則 `src/worker/**` とWorker固有の設定例・テストだけにする。
3. Backend API、Service Bus message、SignalR payloadを変更しない。
4. 同一 `sessionId` を並列処理しない。
5. `src/worker/shared` に外部I/Oを追加しない。
6. MediaPipe Face Landmarkerを安全性未確認のまま複数threadで共有しない。
7. 既存のcomplete / abandon / dead-letter、Redis冪等性、I/P復旧契約を維持する。
8. 固定人数や固定replica数をコードへ入れない。
9. `git --no-pager diff --check` は使用しない。

## 目的

現行Workerの「1 processでreceiverを1つだけ保持する」構造を、設定可能な複数Session処理slotへ拡張してください。

次を成立させます。

- 同一Session: 直列処理
- 異なるSession: 並列処理
- Session数増加: Worker slotおよびAzure replica増加で吸収
- scale-in / shutdown: 未完了メッセージを失わない

## 調査対象

- `src/worker/app/main.py`
- `src/worker/app/analyzer/frame_decoder.py`
- `src/worker/app/perclos.py`
- `src/worker/app/auth.py`
- `src/worker/shared/**`
- `src/worker/tests/test_worker_reliability.py`
- `src/worker/tests/test_startup_checks.py`
- WorkerのrequirementsとREADME

## 実装要件

### 1. 設定可能なSession並列度

既存命名規則に合わせ、以下に相当する設定を追加する。

```text
WORKER_SESSION_CONCURRENCY
```

- 既定値は `1`。
- 正の整数だけを受理する。
- `0`、負数、非数値は起動時に明確なエラーとする。
- 設定値をログへ出してよいが、秘密値は出さない。

### 2. Session処理slot

1 Worker replica内で設定数のslotを起動する。

各slotは少なくとも以下を独立して管理する。

- `NEXT_AVAILABLE_SESSION` receiver
- receiver lifecycle
- `FrameDecoder` または担当Sessionのデコーダ状態
- `SessionAnalysisState`
- 必要なら独立した `FaceAnalyzer`

Service Bus clientなど安全に共有できるSDK clientは共有してよいが、共有可否を確認すること。

並列方式は既存ライブラリとPython実行特性を調査して決める。

- threadを使う場合、MediaPipe / analyzerをslot間共有しない。
- CPU-bound処理でthread並列が成立しない場合、process-based方式を検討する。
- 過剰なプロセス管理基盤を追加しない。

### 3. Session境界

- 1 receiverが取得したService Bus Sessionはそのslotだけが処理する。
- 同一Session内のmessageを順番に処理する。
- 1 Sessionの遅い推論・Blob取得・Backend投稿が、別slotのSessionを停止させない。
- receiverがidleになったら安全に閉じ、次のSessionを取得できる。

### 4. graceful shutdown

- shutdown signal後は新しいSession取得を停止する。
- すでに解析・投稿中のフレームは、既存契約に従って安全にsettleする。
- Session lock消失後にcomplete / abandon / dead-letterしない。
- lock消失時はreceiverを閉じ、Service Bus再配送へ委ねる。
- receiver、lock renewer、analyzer、client、health serverを確実にcloseする。
- shutdownが無期限に待機しないよう、既存運用と整合する上限を設定可能にする場合は仕様へ記載する。

### 5. 冪等性と復旧

- Backendが `202 Accepted` を返す前にcompleteしない。
- `processed:{sessionId}:frame:{sequenceNo}` の冪等性を維持する。
- Worker再起動またはSession移動後に重複結果を作らない。
- ローカルデコーダ状態を失ったPフレームは既存契約どおり破棄し、次のIフレームから復旧する。

## 必須テスト

fake source / analyzer / publisherを使い、時間制御可能なテストを追加する。

1. `WORKER_SESSION_CONCURRENCY=1` が既存挙動と互換。
2. 異なる2 Sessionの処理区間が重なる。
3. 同一Sessionの2フレームは同時実行されない。
4. Session Aを意図的に遅延させてもSession Bが完了する。
5. 不正な並列度設定で起動に失敗する。
6. shutdown後に新規Sessionを取得しない。
7. shutdown前に処理済みのmessageは正しくcompleteされる。
8. Session lock消失後にsettlementしない。
9. retryable failureはabandon、permanent failureはdead-letterになる。
10. Worker再起動相当の重複フレームを再解析しない。
11. 次のIフレームでデコーダ状態を復旧する。
12. slotごとのresource closeが実行される。

テストをsleep依存で不安定にせず、event / barrier / fake clockなどを使って決定的にする。

## 非対象

- Backendの分散SignalR registry
- Outbox migration
- Azure IaC
- Frontend UI変更
- 眠気スコア式変更

## 検証

- Worker unit tests
- Worker reliability tests
- Python lint / type checkが既存にあれば実行
- devcontainerのService Bus Emulatorを使った複数Session結合テスト
- Redis冪等性を含む再配送テスト

## 完了条件

- Session並列度を設定できる。
- 同一Sessionは直列、異なるSessionは並列。
- graceful shutdownが動作する。
- Session lock消失後に誤settlementしない。
- 冪等性とIフレーム復旧を維持する。
- 固定同時利用者数を持たない。
- 既存Workerテストが通る。

## 完了報告

1. 採用した並列方式と理由。
2. 追加した設定。
3. resource ownershipとshutdown手順。
4. 実行したテストと結果。
5. 1 replicaあたりの推奨slot数を決めるために必要な実測項目。
6. 残課題。
