# Task 05: Azure IaCとautoscale設定を実装する

以下をそのまま実装Agentへの依頼文として使用する。

---

あなたはこのリポジトリのAzureインフラ・運用担当Agentです。作業ルートは `workspace` です。

## 依存

- Task 01: Worker Session並列度と設定名
- Task 04: Backend複数instance、health/readiness、SignalR設定

実装済みの環境変数とhealth endpointを確認してIaCへ反映してください。

## 最重要ルール

1. 最初に `AGENTS.md` を読む。
2. 既存IaC規約を調査し、存在すればそれに従う。
3. 規約がない場合はAzureとの親和性を優先し、Bicepを基本候補とする。
4. 同時利用者数、replica数、SKU、保持日数をコードへ固定せずparameter化する。
5. secret実値をファイル、parameter例、ログへ書かない。
6. Azureへ実デプロイする前に対象subscription、リージョン、コスト、クォータを確認する。資格情報がなければデプロイしない。
7. 開発・テスト・デモ用途として、使用後にscale-to-zeroまたは低コスト状態へ戻せる構成にする。
8. `git --no-pager diff --check` は使用しない。

## 目的

同時利用者数を固定せず、Service Bus backlogとBackend負荷に応じてAzure上で水平スケールできるIaCと運用手順を追加してください。

## 調査対象

- 既存IaCファイル
- `docs/operations/production-setup.md`
- `.devcontainer/docker-compose.yml`
- Backend / WorkerのDockerfileまたはデプロイ設定
- Task 01で追加されたWorker設定
- Task 02のRedis registry設定
- Task 03のOutbox設定
- Task 04のhealth/readiness endpoint
- `src/backend/Awaver.Backend/Program.cs`
- `src/worker/app/main.py`

## 必須Azure構成

### 1. Backend

既存仕様に適合するAzure実行基盤を使用する。

- 複数instanceへscale out可能。
- WebSocketを利用可能。
- liveness / readinessを設定。
- Azure SignalR Service接続を設定。
- 最小・最大instance数をparameter化。
- CPU、メモリ、HTTP負荷など実行基盤が正式に提供する指標でautoscale。
- scale-in時のgrace period / termination設定を可能な範囲で指定。

既存仕様がApp Serviceを要求する場合はApp Serviceを優先する。Container Appsへ変更する場合は、仕様更新と移行理由を明記する。

### 2. Worker

Azure Container Appsを基本とする。

- Service Bus queue backlogをscale triggerにする。
- `minReplicas` をparameter化する。
- `maxReplicas` をparameter化する。
- Service Bus message thresholdをparameter化する。
- `WORKER_SESSION_CONCURRENCY` を環境変数として渡す。
- Worker health endpointを設定する。
- 開発・デモ環境ではscale-to-zeroを選択可能。
- cold startを避けるデモ前warm-up手順を用意する。

KEDA / Container Appsが正式にサポートするService Bus scaler設定だけを使用する。Session有効queueで動作しない未確認設定を推測で書かない。

### 3. Service Bus

- Session対応tierを使用する。Basicは使わない。
- frame queueでSessionを有効化する。
- 最大配送回数をparameter化。
- lock durationとDLQ監視を設定または文書化。
- Backendは送信権限、Workerは受信・settlement権限に分ける。

### 4. Azure SignalR Service

- 複数Backendの共通通知基盤として作成・接続する。
- connection stringはsecretとして扱う。
- capacity / service modeをparameter化できる範囲で設定する。

### 5. Blob Storage

- frame containerを作成する。
- lifecycle management ruleでフレームを自動削除する。
- 保持期間をparameter化する。
- 動画教材containerとフレームcontainerを分離する。
- Backend書込み、Worker読取りの最小権限を維持する。

### 6. Redis

- Worker PERCLOS / 冪等キーとBackend SignalR registryが利用できる。
- キー名前空間はアプリ側設定に従う。
- TLSを有効化する。
- public accessを避ける既存運用方針を維持する。
- 接続情報はsecret参照にする。

### 7. PostgreSQL

- Backendから接続できる。
- TLS、backup、PITRの既存運用方針を維持する。
- Outbox複数dispatcherを考慮した接続数をparameter / 文書で管理する。

### 8. Secrets / Identity

- Key Vaultまたは実行基盤のsecret参照を使用する。
- Workerの解析結果APIは本番ではManaged Identity / Entra IDを使用する既存方針を維持する。
- 現行コードが接続文字列を必要とするBlob / Service Bus / Redisは、実値をIaCへ埋め込まずsecret parameterとして渡す。
- secret出力をdeployment outputに含めない。

## parameter化する項目

最低限:

- environment name
- region
- Backend min/max instance
- Worker min/max replica
- `WORKER_SESSION_CONCURRENCY`
- Service Bus queue threshold
- Outbox batch size / poll interval / lease
- Blob保持期間
- 各リソースのSKU / capacity
- container image reference

人数そのものをparameterにしない。負荷と容量を表す設定にする。

## 監視・アラート

IaCまたは運用ドキュメントで、少なくとも以下を扱う。

- Service Bus active message数
- Service Bus DLQ
- 最古メッセージ年齢
- Worker replica数 / CPU / restart
- Backend instance数 / CPU / WebSocketエラー / ACK遅延
- Outbox未配信件数
- 最古Outboxイベント年齢
- Redis memory / eviction
- PostgreSQL connection / CPU / lock
- Blob書込み・読取り失敗
- SignalR接続数 / 送信失敗

すべてを新しい監視スタックで実装する必要はない。Azure標準メトリクスと既存ログを優先する。

## デモ・開発運用

次を文書化する。

- デモ前にWorker `minReplicas` を一時的に上げてwarm-upする方法。
- デモ終了後にWorkerをscale-to-zeroへ戻す方法。
- Blob frame containerをLifecycleまたは明示操作で削除する方法。
- DLQとOutbox滞留を確認する方法。
- コスト発生リソースを停止・縮小する方法。

## write scope

- 既存IaCまたは新規 `infra/azure/**`
- Azure parameter例。secret実値は禁止。
- `docs/operations/production-setup.md`
- AzureデプロイREADME
- 必要な設定テンプレート

アプリケーションコードの変更は、IaCとの設定名不一致を直す最小限に限定する。

## 検証

- Bicep build / lint、または採用IaCのvalidate
- parameter不足の検出
- secret実値が含まれていないことの確認
- Service Bus Sessionが有効であることの静的確認
- Worker autoscale ruleの静的確認
- Backend / Workerの環境変数名が実装と一致することの確認

Azure資格情報があり、ユーザーの許可と対象環境が明確な場合だけ実デプロイを行う。

## 完了条件

- Backend / Workerのmin/max scaleがparameter化されている。
- WorkerがService Bus backlogでscale outできる。
- Azure SignalR Serviceが複数Backendに接続される。
- Service Bus Session queueが作成される。
- Blob保持期間がLifecycle Ruleで制御される。
- secret実値がない。
- デモ前warm-upと終了後scale-downが文書化されている。
- IaCの静的検証が通る。

## 完了報告

1. 採用したAzure実行基盤と理由。
2. 作成・変更したリソース。
3. autoscale triggerとparameter。
4. secret / identityの扱い。
5. IaC検証結果。
6. 実デプロイ実施有無と理由。
7. 推定コスト・クォータ上の注意点。
