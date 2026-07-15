# 非本番 Azure 分散負荷テスト環境

このディレクトリは Feature 15 と [`docs/scenarios/multi-session-dynamic-distribution.md`](../../docs/scenarios/multi-session-dynamic-distribution.md) のための Azure 構成である。Browser / load-test は Backend ACA の HTTPS binary frame API へ接続し、Backend と Worker は同一の Azure Container Apps (ACA) managed environment で実行する。ローカル Docker replica 数ではなく、Azure Service Bus の実 backlog に対する Worker ACA のスケールを検証する。

## 構成と責務

| コンポーネント | 実行基盤 | 理由 |
| --- | --- | --- |
| Backend | Azure Container Apps | external HTTPS HTTP ingress（target port `8080`）、`Single` revision、HTTP concurrent-request scale rule、`/health/live` と `/health/ready` probe を使用する。raw frame WebSocket は配置しない。 |
| Worker | Azure Container Apps | Service Bus custom scaler による scale-to-zero と backlog autoscale を利用する。Worker に ingress は設定しない。 |
| Container image | public GitHub Container Registry (GHCR) | GitHub Actions またはローカル `docker buildx build --push` で Linux/amd64 の Backend / Worker image を公開し、Azure は匿名 pull する。 |
| Frame queue | Azure Service Bus Standard/Premium | Session 有効 queue。Basic は意図的に選択できない。 |
| Frame storage | Azure Blob Storage | `frames` と `videos` container を分離し、`frames/sessions/` だけへ lifecycle 削除規則を適用する。 |
| 状態 / DB | Azure Managed Redis / PostgreSQL Flexible Server | テスト専用の TLS 有効リソースを作成する。 |
| 通知 | Azure SignalR Service | 複数 Backend instance の共通配信基盤。 |
| ログ・Backend metrics | Log Analytics + workspace-based Application Insights | ACA system logs、Azure 標準メトリクス、および Backend の metrics-only telemetry の確認先。Application Insights は同じ Log Analytics workspace にリンクする。 |

`main.bicep` は上記の Azure リソースと両方の Container App を作成し、public GHCR image を配置する。共有 Resource Group 内で既存リソースを変更しないよう、Resource 名は `namePrefix` によって分離する。通常設定は `nonprod.parameters.json`、実値と環境固有名は Git 管理外の secure parameter file に分離する。

`frameQueueName` はSession queue名である。Service Busは既存queueの`requiresDuplicateDetection`を更新できないため、HTTP ingressへ切替える既存環境では `frame-processing-queue-http-v2` のような新しい名前を設定し、BackendとWorkerを同一デプロイで切り替える。旧queueはdrain確認後まで削除しない。

## 重要な設計

- Worker は `azure-servicebus` custom scale rule を使用する。`messageCount` は `workerScaleQueueThreshold` であり、`WORKER_SESSION_CONCURRENCY` とは別の環境容量設定である。今回の nonprod 検証値は 1 CPU / 2 GiB Worker、3 Session slot/replica、最低 12・最大 15 replica、20 active messages/replica とする。最低12 replica は36 Session slot、最大15 replica は45 Session slotを提供する。30 Session × 5fpsの試験は、全最低replicaが `/health/ready` になった後に開始し、frame-to-result の p95 2秒以下・p99 5秒以下を満たすことが受け入れ条件である。最低12 replicaは、Session lock引継ぎ・短い結果送信tailのため30 Sessionに6 slotの余力を持たせる。`20` は3 slot が取得する最大 batch（各 10 message 未満）より小さいため、継続的な backlog で早めに replica を増やす保守的な閾値である。10 秒の `workerScalingPollingIntervalSeconds` により、常時容量を超える backlog を既定の 30 秒ではなく最大 10 秒で検知する。
- Backend と Worker の `activeRevisionsMode` は `Single`。Backend revision 更新時は旧 revision が frame / result を二重処理しないこと、Worker revision 更新時は古い scale rule で backlog を消費しないことを確認する。
- Worker の ACA termination grace period は `workerTerminationGracePeriodSeconds`。必ず `workerShutdownTimeoutSeconds` より大きく設定する。
- Backend は `BACKEND_EXPECTED_INSTANCE_COUNT=backendMaxInstances` として起動する。このため複数 replica 時の Azure SignalR と Redis registry の必須契約が常に有効になる。
- `nonprod.parameters.json` の既定は `backendMinInstances=2`、`backendMaxInstances=2`、`backendHttpConcurrentRequests=20`、1 vCPU / 2 GiB である。これは測定前の初期値であり、frame ingress と analysis-results の duration、CPU、memory を観測して調整する。`backendMinInstances=2` は ACA Consumption cores quota と Azure for Students credit の確認後にのみ使用する。PostgreSQL は計測結果に基づく判断まで `Standard_B1ms` のままとする。
- Backend 用 Application Insights は workspace-based として既存の `Log Analytics workspace` にリンクする。Bicep は metrics-only 用 `APPLICATIONINSIGHTS_CONNECTION_STRING` を Backend ACA secret にだけ設定し、deployment output、parameter file、ドキュメントのコマンド出力例には出力しない。
- Backend は Service Bus の `Send` 専用 SAS、Worker は `Listen` 専用 SAS を受け取る。ACA scaler は queue runtime metrics を読むため、Worker プロセスへ渡さない queue-scoped `Manage` 専用 SAS を別 secret として使用する。
- frame queue は Session と duplicate detection を有効にする。Backend は HTTP idempotency key `(sessionId, sequenceNo)` と同じ安定した Message ID を使い、`serviceBusDuplicateDetectionHistoryTimeWindow` は最大 HTTP retry horizon を必ず上回らせる。既定の `PT1H` は初期値であり、client retry policy を延長する場合は同時に見直す。
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
workerEntraValidIssuer
workerBackendTokenScope
```

`frontendOrigin` は省略できる。省略時は通常 parameter file の `https://placeholder.invalid` が使われるため、Devcontainer CLI による非ブラウザ負荷試験は可能である。ブラウザ E2E を実施する前にだけ、実際のFrontend HTTPS originで上書きする。

Backend ACA は public TLS と HTTP-to-HTTPS redirect を ACA ingress に委譲する。container target port は外部公開せず、Backend はproductionで `X-Forwarded-For` / `X-Forwarded-Proto` を処理しないため、ACA ingress proxy CIDRのparameterは不要である。

IaC拡張前の secure parameter file は、旧 `backendImage`、`databaseConnectionString`、`redisConnectionString`、Blob接続文字列、registry credential 等を持つため互換性がない。既存ファイルをバックアップした上で、必ず最新の `nonprod.secrets.parameters.json.example` から新規作成する。

ここには ACA へ渡す接続文字列を書かない。Storage SAS、Service Bus SAS、Redis key、SignalR key、PostgreSQL connection string、Application Insights connection string は Bicep が生成して ACA secret にだけ渡し、deployment output には出力しない。GHCR image は public でなければならず、PAT をこの parameter file や ACA へ保存してはならない。

## 事前準備

1. `awaver-devtest-rg`、リージョン、ACA Consumption cores / Service Bus / SignalR の quota と Azure for Students credit・コスト上限を確認する。`az containerapp env list-usages --name <namePrefix>-cae --resource-group <rg>` は foundation 作成後の read-only 確認に使える。quota不足時は deploy を強行しない。
2. provider を登録する。`Microsoft.App`、`Microsoft.SignalRService`、`Microsoft.ServiceBus`、`Microsoft.Storage`、`Microsoft.OperationalInsights`、`Microsoft.Insights` が必要である。
3. GitHub Packages で `ghcr.io/4rna-y/awaver-backend` と `ghcr.io/4rna-y/awaver-worker` を **Public** にする。private GHCR image はこの IaC ではサポートしない。
4. Backend API の Entra App Registration を作成し、`analysis_worker` application role を定義する。
5. secure parameter file を作成する。実値を chat、Git、ログ、load-test report へ出力しない。

## デプロイ手順

### 1. Foundation を作成する

この段階では Backend / Worker workload を作成しない。PostgreSQL、Azure Managed Redis、Storage、Service Bus、SignalR、Log Analytics、workspace-based Application Insights、ACA environment を作成する。

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
AZURE_IMAGE_TAG=20260715-a1b2c3d \
bash infra/azure/build-images.sh
```

### 3. Backend と Worker を配置する

```bash
AZURE_RESOURCE_GROUP=awaver-devtest-rg \
AZURE_PARAMETERS_FILE=infra/azure/nonprod.secrets.parameters.json \
AZURE_IMAGE_TAG=20260715-a1b2c3d \
bash infra/azure/deploy-workloads.sh
```

`AZURE_IMAGE_TAG` には、公開済みの immutable GHCR tag を必ず指定する。`latest`、`test`、placeholder は script が拒否する。同じ tag は command が `imageTag` parameter として渡すため、通常 parameter file の placeholder を編集しない。

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

1. Backend ACA の `az containerapp show` output に external FQDN、target port `8080`、`Single` revision、HTTP scale rule があることを確認する。`/health/live` と `/health/ready` が HTTPS で成功することを確認する。
2. 鮮度SLOを検証する同時Session数を `N`、`WORKER_SESSION_CONCURRENCY` を `C` とし、`workerMinReplicas` を少なくとも `ceil(N / C)` に設定する。全最低Worker replicaの `/health/ready` が成功し、MediaPipe model load・Backend ACA / Blob / Service Bus / Redis 接続まで完了することを確認してから試験を開始する。
3. **複数の異なる Session** で HTTPS binary frame を投入する。同じ Session の backlog だけでは replica 間に分散しない。高負荷は対象 URL、Session数、時間、推定コストを提示し、`ALLOW_AZURE_LOAD_TEST=true` と TTY の明示 `START` を得た場合だけ実行する。
4. Active message、Worker / Backend ACA replica 数、最古メッセージ年齢、DLQ、Backend CPU、frame ingress と result API timeout / latency、Outbox 未配信件数と最古 Outbox 年齢を観測する。Workerでは queue待機、Blob取得、decode/inference、結果API送信の段階別遅延を同じ試験時刻で確認する。Backend のアプリ metrics は Application Insights から同じ Log Analytics workspace で確認する。replica ごとの Outbox gauge は sum ではなく max で集計する。
5. Backend revision 更新または scale-in 時に readiness が新規 ingress を外し、Outbox lease / retry が Feature 15 契約を満たすことを確認する。Worker scale-in / revision restart でも処理中メッセージが `complete` されずに再配送されることを確認する。
6. `workerMaxReplicas` 到達時に backlog が残り、フレームがサイレントに消えないことを確認する。

## 終了後の削除

`awaver-devtest-rg` は既存の Azure SignalR を含む共有 Resource Group のため、**`az group delete` を実行してはならない**。このテストで作成した prefix 付き top-level resource だけを Portal または Azure CLI で確認して削除する。

削除対象は `namePrefix` と secure parameter file に記録した名前で確認する。

```text
Backend / Worker Container App / Container Apps environment
PostgreSQL Flexible Server
Azure Managed Redis
Storage account
Service Bus namespace
テスト用 Azure SignalR
Application Insights（Backend metrics）
Log Analytics workspace
```

削除前に Service Bus Active / DLQ message、Outbox 滞留、必要なログを確認する。削除後は一時 PostgreSQL password と secure parameter file も安全に破棄する。

> **Azure for Students のコスト注意:** Backend `minReplicas=2` は、HTTP request がなくても ACA replica の消費時間を発生させ得る。Application Insights / Log Analytics は ingestion と保持期間にも課金され、Worker replica、PostgreSQL、Redis、Service Bus、SignalR、Storage も利用量に応じて Azure for Students credit を消費する。試験前に quota・credit・上限を確認し、試験終了後は上記の prefix 付きリソースを速やかに削除する。

## ネットワークと監視

このテンプレートは、短期間の非本番疎通・負荷試験を可能にする最小構成であり、public endpoint は Azure 認証・SAS・TLS で保護される。本番相当環境では、ACA environment の VNet integration、各データサービスの Private Endpoint、Private DNS zone を構成してから public network access を無効化する。

Azure Monitor / Log Analytics では少なくとも次をダッシュボード・アラート対象にする。

- Service Bus Active / DLQ message、最古メッセージ年齢、Session lock 失敗
- Backend / Worker ACA replica、restart、CPU / memory、max replica 到達
- Backend HTTP frame ingress と result API の 5xx、401/403、429、503、応答時間、`/health/live`、`/health/ready`
- Backend Application Insights metrics: Worker result API の要求数・outcome・応答時間、結果保存と Outbox transaction の処理時間、Outbox claim・配信・状態更新・batch の処理時間、Outbox 未配信件数・最古年齢、.NET runtime metrics
- Redis memory / eviction、PostgreSQL connection / CPU / lock、Blob 読書き失敗、SignalR 接続数・送信失敗

### Backend telemetry の privacy / aggregation 契約

Backend のアプリ telemetry は **metrics-only** とする。event、trace、request body、dependency detail、例外本文などの個人データを含み得る telemetry を送信しない。Worker result API の outcome・duration、Outbox backlog / age、.NET runtime の集計値だけを送信する。

- `sessionId`、HTTP frame payload、SignalR message payload、画像・Base64、Cookie、Bearer token、API key、接続文字列、学生IDその他の識別子を telemetry の名前、dimension、値、ログに含めない。
- Backend instance ごとの gauge（例: Outbox 未配信件数、最古 Outbox 年齢、接続数）を全 instance で **sum してはならない**。環境の状態として表示・アラートする場合は **max** を使う。counter は instance ごとに増分を送信し、クエリで必要に応じて集計する。
- `logAnalyticsRetentionDays` は非本番の短期調査だけに使う保持期間として設定し、既定の 30 日を超えて不要に延長しない。workspace-based Application Insights のデータはリンク先 Log Analytics workspace に保存されるため、Application Insights と Log Analytics の ingestion 量・retention の両方を試験前後に確認する。metrics-only にしても custom metrics / Azure Monitor logs の料金が発生し得るため、不要な高頻度・高 cardinality metric を送信しない。
