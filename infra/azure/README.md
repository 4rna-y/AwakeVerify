# 非本番 Azure 分散負荷テスト環境

このディレクトリは Feature 15 と [`docs/scenarios/multi-session-dynamic-distribution.md`](../../docs/scenarios/multi-session-dynamic-distribution.md) のための Azure 構成である。ローカル Docker replica 数ではなく、Azure Service Bus の実 backlog に対する Azure Container Apps (ACA) Worker のスケールを検証する。

## 構成と責務

| コンポーネント | 実行基盤 | 理由 |
| --- | --- | --- |
| Backend | Linux App Service | 既存の Backend 仕様に適合し、WebSocket・`/health/live`・`/health/ready` と App Service Plan の CPU autoscale を利用できる。 |
| Worker | Azure Container Apps | Service Bus custom scaler による scale-to-zero と backlog autoscale を利用する。Worker に ingress は設定しない。 |
| Container image | public GitHub Container Registry (GHCR) | GitHub Actions またはローカル `docker buildx build --push` で Linux/amd64 の Backend / Worker image を公開し、Azure は匿名 pull する。 |
| Frame queue | Azure Service Bus Standard/Premium | Session 有効 queue。Basic は意図的に選択できない。 |
| Frame storage | Azure Blob Storage | `frames` と `videos` container を分離し、`frames/sessions/` だけへ lifecycle 削除規則を適用する。 |
| 状態 / DB | Azure Managed Redis / PostgreSQL Flexible Server | テスト専用の TLS 有効リソースを作成する。 |
| 通知 | Azure SignalR Service | 複数 Backend instance の共通配信基盤。 |
| ログ・Backend metrics | Log Analytics + workspace-based Application Insights | ACA system logs、Azure 標準メトリクス、および Backend の metrics-only telemetry の確認先。Application Insights は同じ Log Analytics workspace にリンクする。 |

`main.bicep` は上記の Azure リソースを作成し、public GHCR image を App Service と Container Apps に配置する。共有 Resource Group 内で既存リソースを変更しないよう、Resource 名は `namePrefix` によって分離する。通常設定は `nonprod.parameters.json`、実値と環境固有名は Git 管理外の secure parameter file に分離する。

## 重要な設計

- Worker は `azure-servicebus` custom scale rule を使用する。`messageCount` は `workerScaleQueueThreshold` であり、`WORKER_SESSION_CONCURRENCY` とは別の環境容量設定である。
- `activeRevisionsMode` は `Single`。古い revision が古い scale rule で backlog を消費しないようにする。
- Worker の ACA termination grace period は `workerTerminationGracePeriodSeconds`。必ず `workerShutdownTimeoutSeconds` より大きく設定する。
- Backend は `BACKEND_EXPECTED_INSTANCE_COUNT=backendMaxInstances` として起動する。このため複数 instance 時の Azure SignalR と Redis registry の必須契約が常に有効になる。
- `nonprod.parameters.json` の既定は `backendPlanSkuName=S1`、`backendMinInstances=2`、`backendMaxInstances=2` である。2 instance を常時 warm にし、5分評価窓の CPU scale-out を初期 burst 対策として待たない。CPU autoscale resource は残るが、この既定では 3 instance 以上へは拡張しない。PostgreSQL は計測結果に基づく判断まで `Standard_B1ms` のままとする。
- Backend 用 Application Insights は workspace-based として既存の `Log Analytics workspace` にリンクする。Bicep は `APPLICATIONINSIGHTS_CONNECTION_STRING` を Backend App Service の app setting だけに設定し、deployment output、parameter file、ドキュメントのコマンド出力例には出力しない。
- Backend は Service Bus の `Send` 専用 SAS、Worker は `Listen` 専用 SAS を受け取る。ACA scaler は queue runtime metrics を読むため、Worker プロセスへ渡さない queue-scoped `Manage` 専用 SAS を別 secret として使用する。
- Blob は Backend 用に read/add/create/write/delete/list、Worker 用に read/list の短期 Account SAS を生成する。SAS は `blobSasExpiry` で失効するため、負荷試験中に期限を過ぎない値を設定し、不要になれば Storage account ごと削除する。
- GHCR image は public とし、Azure の registry credential や `AcrPull` role assignment を使わない。Worker の System Assigned Managed Identity には、Entra ID の管理操作として `analysis_worker` app role を別途割り当てる。

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

ここには App Service / ACA へ渡す接続文字列を書かない。Storage SAS、Service Bus SAS、Redis key、SignalR key、PostgreSQL connection string、Application Insights connection string は Bicep が生成して runtime configuration / ACA secret にだけ渡し、deployment output には出力しない。GHCR image は public でなければならず、PAT をこの parameter file や App Service / ACA へ保存してはならない。

## 事前準備

1. `awaver-devtest-rg`、リージョン、Service Bus / ACA / App Service / SignalR の quota とコスト上限を確認する。
2. provider を登録する。`Microsoft.App`、`Microsoft.SignalRService`、`Microsoft.ServiceBus`、`Microsoft.Web`、`Microsoft.Storage`、`Microsoft.OperationalInsights`、`Microsoft.Insights` が必要である。
3. GitHub Packages で `ghcr.io/4rna-y/awaver-backend` と `ghcr.io/4rna-y/awaver-worker` を **Public** にする。private GHCR image はこの IaC ではサポートしない。
4. Backend API の Entra App Registration を作成し、`analysis_worker` application role を定義する。
5. secure parameter file を作成する。実値を chat、Git、ログ、load-test report へ出力しない。

## デプロイ手順

### 1. Foundation を作成する

この段階では App Service と ACA Worker を作成しない。PostgreSQL、Azure Managed Redis、Storage、Service Bus、SignalR、Log Analytics、workspace-based Application Insights、ACA environment を作成する。

```bash
AZURE_RESOURCE_GROUP=awaver-devtest-rg \
AZURE_PARAMETERS_FILE=infra/azure/nonprod.secrets.parameters.json \
bash infra/azure/deploy.sh
```

### 2. GHCR にコンテナイメージを公開する

`.github/workflows/publish-ghcr.yml` を `workflow_dispatch` で実行すると、GitHub-hosted runner が Linux/amd64 image を GHCR へ公開する。Worker image は公式 MediaPipe Face Landmarker model を build 時にダウンロードし、SHA-256 を検証して含める。実行後、GitHub の Packages 設定で両 image を **Public** にする。

ローカルから公開する場合は、Packages 書き込み権限を持つ GitHub PAT で先に `docker login ghcr.io` を行う。

```bash
CONTAINER_IMAGE_NAMESPACE=4rna-y \
AZURE_IMAGE_TAG=test \
bash infra/azure/build-images.sh
```

### 3. Backend と Worker を配置する

```bash
AZURE_RESOURCE_GROUP=awaver-devtest-rg \
AZURE_PARAMETERS_FILE=infra/azure/nonprod.secrets.parameters.json \
AZURE_IMAGE_TAG=test \
bash infra/azure/deploy-workloads.sh
```

`AZURE_IMAGE_TAG` を使用する場合は、同じ tag を parameter file の `imageTag` に設定するか、`deploy-workloads.sh` 実行時に `--parameters imageTag=<tag>` を追加する。既定は `test`。

public GHCR image の pull に Azure role assignment は不要である。

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
4. Active message、Worker replica 数、最古メッセージ年齢、DLQ、Backend CPU、Backend result API timeout / latency、Outbox 未配信件数と最古 Outbox 年齢を観測する。Backend のアプリ metrics は Application Insights から同じ Log Analytics workspace で確認する。
5. Worker を scale-in または revision restart し、処理中メッセージが `complete` されずに再配送され、別 replica が Session を取得することを確認する。
6. `workerMaxReplicas` 到達時に backlog が残り、フレームがサイレントに消えないことを確認する。

## 終了後の削除

`awaver-devtest-rg` は既存の Azure SignalR を含む共有 Resource Group のため、**`az group delete` を実行してはならない**。このテストで作成した prefix 付き top-level resource だけを Portal または Azure CLI で確認して削除する。

削除対象は `namePrefix` と secure parameter file に記録した名前で確認する。

```text
App Service / App Service Plan / autoscale setting
Container App / Container Apps environment
PostgreSQL Flexible Server
Azure Managed Redis
Storage account
Service Bus namespace
テスト用 Azure SignalR
Application Insights（Backend metrics）
Log Analytics workspace
```

削除前に Service Bus Active / DLQ message、Outbox 滞留、必要なログを確認する。削除後は一時 PostgreSQL password と secure parameter file も安全に破棄する。

> **Azure for Students のコスト注意:** S1 App Service Plan を 2 instance 常時稼働させると、負荷がなくても両 instance 分の compute が課金される。Application Insights / Log Analytics は ingestion と保持期間にも課金され、Service Bus、SignalR、PostgreSQL、Redis、Storage も利用量に応じて Azure for Students credit を消費する。試験終了後は上記の prefix 付きリソースを速やかに削除し、subscription の残高・利用上限を確認する。

## ネットワークと監視

このテンプレートは、短期間の非本番疎通・負荷試験を可能にする最小構成であり、public endpoint は Azure 認証・SAS・TLS で保護される。本番相当環境では、ACA environment と App Service の VNet integration、各データサービスの Private Endpoint、Private DNS zone を構成してから public network access を無効化する。

Azure Monitor / Log Analytics では少なくとも次をダッシュボード・アラート対象にする。

- Service Bus Active / DLQ message、最古メッセージ年齢、Session lock 失敗
- ACA Worker replica、restart、CPU / memory、max replica 到達
- App Service Backend instance、CPU、WebSocket error、5xx、`/health/ready`
- Backend Application Insights metrics: Worker result API の要求数・outcome・応答時間、結果保存と Outbox transaction の処理時間、Outbox claim・配信・状態更新・batch の処理時間、Outbox 未配信件数・最古年齢、.NET runtime metrics
- Redis memory / eviction、PostgreSQL connection / CPU / lock、Blob 読書き失敗、SignalR 接続数・送信失敗

### Backend telemetry の privacy / aggregation 契約

Backend のアプリ telemetry は **metrics-only** とする。event、trace、request body、dependency detail、例外本文などの個人データを含み得る telemetry を送信しない。Worker result API の outcome・duration、Outbox backlog / age、.NET runtime の集計値だけを送信する。

- `sessionId`、frame / WebSocket payload、画像・Base64、Cookie、Bearer token、API key、接続文字列、学生IDその他の識別子を telemetry の名前、dimension、値、ログに含めない。
- Backend instance ごとの gauge（例: Outbox 未配信件数、最古 Outbox 年齢、接続数）を全 instance で **sum してはならない**。環境の状態として表示・アラートする場合は **max** を使う。counter は instance ごとに増分を送信し、クエリで必要に応じて集計する。
- `logAnalyticsRetentionDays` は非本番の短期調査だけに使う保持期間として設定し、既定の 30 日を超えて不要に延長しない。workspace-based Application Insights のデータはリンク先 Log Analytics workspace に保存されるため、Application Insights と Log Analytics の ingestion 量・retention の両方を試験前後に確認する。metrics-only にしても custom metrics / Azure Monitor logs の料金が発生し得るため、不要な高頻度・高 cardinality metric を送信しない。
