# 非本番 Azure 分散負荷テスト環境

このディレクトリは Feature 15 と [`docs/scenarios/multi-session-dynamic-distribution.md`](../../docs/scenarios/multi-session-dynamic-distribution.md) のための Azure 構成である。ローカル Docker replica 数ではなく、Azure Service Bus の実 backlog に対する Azure Container Apps (ACA) Worker のスケールを検証する。

## 構成と責務

| コンポーネント | 実行基盤 | 理由 |
| --- | --- | --- |
| Backend | Linux App Service | 既存の Backend 仕様に適合し、WebSocket・`/health/live`・`/health/ready` と App Service Plan の CPU autoscale を利用できる。 |
| Worker | Azure Container Apps | Service Bus custom scaler による scale-to-zero と backlog autoscale を利用する。Worker に ingress は設定しない。 |
| Container image | Azure Container Registry | `az acr build` で Backend / Worker image を作り、各実行基盤の Managed Identity に `AcrPull` を付与する。 |
| Frame queue | Azure Service Bus Standard/Premium | Session 有効 queue。Basic は意図的に選択できない。 |
| Frame storage | Azure Blob Storage | `frames` と `videos` container を分離し、`frames/sessions/` だけへ lifecycle 削除規則を適用する。 |
| 状態 / DB | Azure Managed Redis / PostgreSQL Flexible Server | テスト専用の TLS 有効リソースを作成する。 |
| 通知 | Azure SignalR Service | 複数 Backend instance の共通配信基盤。 |
| ログ | Log Analytics | ACA system logs と Azure 標準メトリクスの確認先。 |

`main.bicep` は上記のリソースを作成する。共有 Resource Group 内で既存リソースを変更しないよう、Resource 名は `namePrefix` によって分離する。通常設定は `nonprod.parameters.json`、実値と環境固有名は Git 管理外の secure parameter file に分離する。

## 重要な設計

- Worker は `azure-servicebus` custom scale rule を使用する。`messageCount` は `workerScaleQueueThreshold` であり、`WORKER_SESSION_CONCURRENCY` とは別の環境容量設定である。
- `activeRevisionsMode` は `Single`。古い revision が古い scale rule で backlog を消費しないようにする。
- Worker の ACA termination grace period は `workerTerminationGracePeriodSeconds`。必ず `workerShutdownTimeoutSeconds` より大きく設定する。
- Backend は `BACKEND_EXPECTED_INSTANCE_COUNT=backendMaxInstances` として起動する。このため複数 instance 時の Azure SignalR と Redis registry の必須契約が常に有効になる。
- Backend は Service Bus の `Send` 専用 SAS、Worker は `Listen` 専用 SAS を受け取る。
- Blob は Backend 用に read/add/create/write/delete/list、Worker 用に read/list の短期 Account SAS を生成する。SAS は `blobSasExpiry` で失効するため、負荷試験中に期限を過ぎない値を設定し、不要になれば Storage account ごと削除する。
- Worker と Backend は ACR pull のための System Assigned Managed Identity を持つ。Worker の `analysis_worker` app role は Entra ID の管理操作として別途割り当てる。

## Secure parameter file

実値は Git 管理外の次のファイルへ置く。

```text
infra/azure/nonprod.secrets.parameters.json
```

作成方法:

```bash
cp infra/azure/nonprod.secrets.parameters.json.example \
  infra/azure/nonprod.secrets.parameters.json
```

少なくとも以下を一意な名前と安全な一時 PostgreSQL password に置き換える。

```text
namePrefix
acrName
storageAccountName
postgresServerName
postgresAdministratorPassword
redisCacheName
workerEntraAuthority
workerEntraAudience
workerBackendTokenScope
```

`frontendOrigin` は省略できる。省略時は通常 parameter file の `https://placeholder.invalid` が使われるため、Devcontainer CLI による非ブラウザ負荷試験は可能である。ブラウザ E2E を実施する前にだけ、実際のFrontend HTTPS originで上書きする。

IaC拡張前の secure parameter file は、旧 `backendImage`、`databaseConnectionString`、`redisConnectionString`、Blob接続文字列、registry credential 等を持つため互換性がない。既存ファイルをバックアップした上で、必ず最新の `nonprod.secrets.parameters.json.example` から新規作成する。

ここには App Service / ACA へ渡す接続文字列を書かない。Storage SAS、Service Bus SAS、Redis key、SignalR key、PostgreSQL connection string は Bicep が生成して runtime configuration / ACA secret にだけ渡し、deployment output には出力しない。

## 事前準備

1. `awaver-devtest-rg`、リージョン、Service Bus / ACA / App Service / SignalR の quota とコスト上限を確認する。
2. provider を登録する。`Microsoft.App`、`Microsoft.SignalRService`、`Microsoft.ServiceBus`、`Microsoft.Web`、`Microsoft.Storage`、`Microsoft.OperationalInsights`、`Microsoft.Insights` が必要である。
3. Backend API の Entra App Registration を作成し、`analysis_worker` application role を定義する。
4. secure parameter file を作成する。実値を chat、Git、ログ、load-test report へ出力しない。

## デプロイ手順

### 1. Foundation を作成する

この段階では App Service と ACA Worker を作成しない。ACR、PostgreSQL、Azure Managed Redis、Storage、Service Bus、SignalR、Log Analytics、ACA environment を作成する。

```bash
AZURE_RESOURCE_GROUP=awaver-devtest-rg \
AZURE_PARAMETERS_FILE=infra/azure/nonprod.secrets.parameters.json \
bash infra/azure/deploy.sh
```

### 2. ACR でコンテナイメージをビルドする

`AZURE_ACR_NAME` は secure parameter file の `acrName` と同じ値にする。

```bash
AZURE_ACR_NAME=<acr-name> \
AZURE_IMAGE_TAG=test \
bash infra/azure/build-images.sh
```

このコマンドは ACR Tasks で Dockerfile をビルドする。ローカル Docker daemon は不要である。

### 3. Backend と Worker を配置する

```bash
AZURE_RESOURCE_GROUP=awaver-devtest-rg \
AZURE_PARAMETERS_FILE=infra/azure/nonprod.secrets.parameters.json \
AZURE_IMAGE_TAG=test \
bash infra/azure/deploy-workloads.sh
```

`AZURE_IMAGE_TAG` を使用する場合は、同じ tag を parameter file の `imageTag` に設定するか、`deploy-workloads.sh` 実行時に `--parameters imageTag=<tag>` を追加する。既定は `test`。

デプロイには ACR scope の role assignment 作成権限が必要である。`Contributor` だけで失敗する場合、Resource Group / ACR scope の `Owner` または `User Access Administrator` を持つ実行者が必要になる。

### 4. Entra ID app role を割り当てる

Worker Container App の system identity に Backend API の `analysis_worker` application role を割り当て、admin consent を完了する。この操作は Microsoft Graph / Entra 管理であり ARM/Bicep の対象外である。割当完了前は Worker の Backend API 投稿が失敗する。

## 静的・control-plane 検証

```bash
az bicep build --file infra/azure/main.bicep --stdout > /dev/null
```

Azure の control-plane 検証:

```bash
AZURE_RESOURCE_GROUP=awaver-devtest-rg \
AZURE_PARAMETERS_FILE=infra/azure/nonprod.secrets.parameters.json \
bash infra/azure/validate.sh
```

これは Azure リソースを作成しないが、対象 resource group に deployment validation 権限が必要である。

## 負荷試験と受け入れ確認

1. `workerMinReplicas=1` に一時更新して Worker の image pull・MediaPipe model load・依存サービス接続を warm-up する。
2. `az containerapp revision list` と Worker logs で `/health` が成功し、Worker が Service Bus / Blob / Redis / Backend へ接続できることを確認する。
3. **複数の異なる `sessionId`** で順序付き frame を投入する。同じ Session の backlog だけでは replica 間に分散しない。
4. Active message、Worker replica 数、最古メッセージ年齢、DLQ、Backend CPU、Outbox 未配信件数と最古 Outbox 年齢を観測する。
5. Worker を scale-in または revision restart し、処理中メッセージが `complete` されずに再配送され、別 replica が Session を取得することを確認する。
6. `workerMaxReplicas` 到達時に backlog が残り、フレームがサイレントに消えないことを確認する。

## 終了後の削除

`awaver-devtest-rg` は既存の Azure SignalR を含む共有 Resource Group のため、**`az group delete` を実行してはならない**。このテストで作成した prefix 付き top-level resource だけを Portal または Azure CLI で確認して削除する。

削除対象は `namePrefix` と secure parameter file に記録した名前で確認する。

```text
ACR
App Service / App Service Plan / autoscale setting
Container App / Container Apps environment
PostgreSQL Flexible Server
Azure Managed Redis
Storage account
Service Bus namespace
テスト用 Azure SignalR
Log Analytics workspace
```

削除前に Service Bus Active / DLQ message、Outbox 滞留、必要なログを確認する。削除後は一時 PostgreSQL password と secure parameter file も安全に破棄する。

## ネットワークと監視

このテンプレートは、短期間の非本番疎通・負荷試験を可能にする最小構成であり、public endpoint は Azure 認証・SAS・TLS で保護される。本番相当環境では、ACA environment と App Service の VNet integration、各データサービスの Private Endpoint、Private DNS zone を構成してから public network access を無効化する。

Azure Monitor / Log Analytics では少なくとも次をダッシュボード・アラート対象にする。

- Service Bus Active / DLQ message、最古メッセージ年齢、Session lock 失敗
- ACA Worker replica、restart、CPU / memory、max replica 到達
- App Service Backend instance、CPU、WebSocket error、5xx、`/health/ready`
- Outbox 未配信件数・最古年齢・lease expiry（アプリログ / DB 監視）
- Redis memory / eviction、PostgreSQL connection / CPU / lock、Blob 読書き失敗、SignalR 接続数・送信失敗
