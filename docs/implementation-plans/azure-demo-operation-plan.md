# Azure予約デモ環境の実装・運用計画

## 1. 目的

[`scheduled-demo-readiness.md`](../scenarios/scheduled-demo-readiness.md)を満たすため、現在Azure CLIでログインしている`Azure for Students` subscriptionの`awaver-devtest-rg`を使用する。負荷試験用resourceは一度削除し、デモ実装が完成して予約日が決まった時点でIaCから再作成することで、常時運用コストを抑えながらデモ時の確実性を優先する。

商用本番向けの専用subscription、複数リージョン、24時間オンコール、Private Endpoint全面導入は今回の必須範囲にしない。デモデータの限定、短時間warm-up、同一artifactでのリハーサル、active monitoring、scale-downを代替統制とする。

## 2. 現在のAzure状態

2026-07-16にAzure CLIと公開health endpointを読み取り専用で確認した。

| 項目 | 現在値 | 評価 |
| --- | --- | --- |
| Subscription | Azure for Students | 利用する |
| Resource Group / region | `awaver-devtest-rg` / Japan East | 利用する |
| Backend ACA | Running、min/max 2、負荷試験済みimage | デモwarm済み |
| Worker ACA | Running、min 12 / max 15、3 slot/replica | 重要デモprofile。待機中は過剰 |
| ACA quota | 14 / 100 consumption cores使用 | 現profileにquota余裕あり |
| Backend health | live/ready成功 | PostgreSQL、Blob、Service Bus、Redis registry、SignalR healthy |
| Service Bus queue | Session/duplicate detection有効、Active 0、DLQ 0 | 正常 |
| PostgreSQL | Ready、B1ms、backup 7日、public endpoint | デモ用途で継続。実データ運用には使わない |
| Blob Storage | TLS 1.2、匿名Blob公開無効、public endpoint | デモ用途で継続 |
| Redis | Balanced_B0、Ready | 継続 |
| SignalR | Standard S1、capacity 1 | 継続 |
| 旧App Service | S1 planと`awavertest-backend`がRunning | 重複コスト候補。依存確認後に停止/削除 |
| Frontend Azure配置 | なし | デモ完成の主要ブロッカー |
| Budget alert | CLI確認で設定を確認できず | Azure Portalでcredit/budget通知を設定 |

## 3. 採用するデモ方針

| ID | 決定 | 内容 |
| --- | --- | --- |
| DD-01 | 環境 | 現在の`awaver-devtest-rg`は保持し、`awavertest` resourceだけを削除・再作成する。Resource Group全体は削除しない |
| DD-02 | データ | 架空の学生・教員・管理者IDだけを使い、カメラ利用は本人同意を得る |
| DD-03 | 容量 | 通常デモは最大3 Session × 5fps。重要デモは検証済みBackend 2、Worker 12–15 profileを短時間だけ使う |
| DD-04 | 待機 | 現在の`awavertest`環境は全削除する。新しいデモ環境は短いデモ間隔ではscale-to-zeroし、長期休止ではDNSのstatic IPを維持するACA Environment以外の課金resourceを削除する |
| DD-05 | Artifact | public GHCRを継続利用するが、mutable tagを禁止し、commitとdigestを記録する |
| DD-06 | Network | 現行public endpoint + TLS + secret認証を維持する。Private Endpointは個人制作デモの必須範囲外とする |
| DD-07 | 公開host | Frontendは`awaver.4rnay.net`、Backend API/SignalRは`api.awaver.4rnay.net`、Worker healthは`worker.api.awaver.4rnay.net`を使用する。`worker.api.4rnay.net`は使用しない |
| DD-08 | Frontend配置 | Next.js SSRを独立`awaver-frontend` GHCR imageとしてbuildし、Frontend専用ACAへ配置する |
| DD-09 | Worker health | Worker ACAにport 8000のexternal ingressを追加し、health endpointだけを`worker.api.awaver.4rnay.net`で公開する。queue処理APIは公開しない |
| DD-10 | Release | 自動本番CDは作らず、clean commitから手動workflowでbuildし、同一artifactをリハーサルとデモに使う |
| DD-11 | Monitoring | 24時間alertではなく、T-60分からデモ終了までhealth、queue、DLQ、replica、Outboxをactive monitoringする |
| DD-12 | Fallback | ライブ復旧に2分以上かかる場合に備え、同一artifactで撮影した短い録画を用意する |
| DD-13 | DNS lifecycle | 現在のテストACA Environmentは削除する。新しいデモ用ACA EnvironmentはAレコードのstatic IPを維持するため通常cleanupでは保持する |
| DD-14 | 動画教材 | `resrc/60s.mp4`をデモ用Blob `videos` containerへuploadし、デモ期間だけ有効なread-only URLをFrontendへ設定する |
| DD-15 | 初期管理者 | Agentが強力な一時passwordを生成してGit管理外のsecure parameterへ保存し、初回bootstrap確認後にACA設定から削除する。値はログ・文書へ残さない |

## 4. Custom domainとBrowser境界

### 4.1 Host構成

| 用途 | URL | Azure target |
| --- | --- | --- |
| Frontend | `https://awaver.4rnay.net` | Next.js SSR Frontend ACA |
| Backend API / SignalR | `https://api.awaver.4rnay.net` | Backend ACA |
| Worker health | `https://worker.api.awaver.4rnay.net` | Worker ACA port 8000 |

`worker.api.4rnay.net`はDNS record、certificate、アプリ設定のいずれにも使用しない。

FrontendとBackendはoriginが異なるが、いずれもHTTPSかつ同じregistrable domain `4rnay.net`配下なのでsame-siteである。Production Cookieの`Secure`、`SameSite=Lax`、host-only、`__Host-`契約を維持し、Cookieを`SameSite=None`へ緩和しない。Backend CORSは`https://awaver.4rnay.net`だけを許可し、credentialsと`X-CSRF-Token` response headerを有効にする。

FrontendはNext.js standalone SSR imageとして`ghcr.io/4rna-y/awaver-frontend:<immutable-tag>`へpublishし、Frontend ACAへ配置する。BackendとWorkerも同じimmutable tagの独立imageとし、3 appを同じACA Environmentで運用する。Frontendは`NEXT_PUBLIC_API_BASE_URL=https://api.awaver.4rnay.net`、`NEXT_PUBLIC_BACKEND_HEALTH_URL=https://api.awaver.4rnay.net/health/ready`、`NEXT_PUBLIC_WORKER_HEALTH_URL=https://worker.api.awaver.4rnay.net/health/ready`でbuildする。

### 4.2 DNSとmanaged certificate

`4rnay.net`のDNS providerはCloudflareである。2026-07-16時点では`awaver.4rnay.net`と`api.awaver.4rnay.net`は未登録で、`4rnay.net`にCAA制約は確認されていない。

指定どおりAレコードを使用し、新しいデモ用ACA Environment作成後に取得したstatic public IPへ各hostを向ける。現在の削除予定`awavertest-cae`のstatic IPとverification IDは使用しない。

| Record | Cloudflare host | Value |
| --- | --- | --- |
| A | `awaver` | デモ用ACA Environment static IP |
| TXT | `asuid.awaver` | デモ用ACA Environment custom domain verification ID |
| A | `api.awaver` | 同じstatic IP |
| TXT | `asuid.api.awaver` | 同じverification ID |
| A | `worker.api.awaver` | 同じstatic IP |
| TXT | `asuid.worker.api.awaver` | 同じverification ID |

Cloudflare proxyは無効にして`DNS only`とし、TTLは切替・検証中300秒を推奨する。DNS反映後、Backend ACAへ`awaver.4rnay.net`と`api.awaver.4rnay.net`、Worker ACAへ`worker.api.awaver.4rnay.net`をbindし、各hostのAzure managed certificateを発行する。certificate status、hostname、chain、HTTPS、SignalR WebSocketを確認するまでデモreadyとしない。

将来CAA recordを追加する場合は、Azure Container Apps managed certificateの発行CAを妨げないことを事前確認する。

### 4.3 Worker公開範囲

Worker ACAはexternal ingressをport 8000へ設定するが、Worker HTTP serverが提供する`/health`、`/health/live`、`/health/ready`とOPTIONSだけを公開する。その他のpathは404を維持する。CORS wildcardは`https://awaver.4rnay.net`へ制限し、health responseへ接続文字列、queue名、model path、例外本文を含めない。Worker処理、Service Bus、Blob、Redisへの操作endpointは追加しない。

## 5. Agent実行契約

### 5.1 Agentへ任せる範囲

Agentは次を自律的に実施する。

- アプリケーション、IaC、Dockerfile、workflow、destroy/recreate/warm-up/check/cooldown scriptの実装。
- unit、integration、frontend build/lint、Playwright、Bicep build/validateの実行。
- Azure CLIのsubscription / Resource Group / quota / resource状態確認。
- 削除previewと、明示承認後のallow-list resource削除。
- Foundationとworkloadの再作成。
- PostgreSQL password、SAS、初期管理者passwordの安全な生成とsecret設定。値をGit、ログ、deployment outputへ出さない。
- `resrc/60s.mp4`のBlob uploadと、デモ期間だけ有効なread-only動画URLの設定。
- Worker Managed Identityのobject ID確認と`analysis_worker` app role割当。Graph権限不足時は必要なprincipal、app role、実行手順だけを提示して停止する。
- ACA Environment作成後、Cloudflareに設定するA/TXT recordを値付き表で提示する。
- DNS反映確認後のcustom domain bind、managed certificate発行、HTTPS/CORS/Cookie/SignalR検証。
- デモ前warm-up、smoke、負荷試験、リハーサルと結果記録。

### 5.2 ユーザーへ依頼する操作

ユーザー操作は次に限定する。

1. Azure resource削除前に、対象一覧とデータ損失を確認して明示承認する。
2. Agentが提示したA/TXT recordをCloudflareへ`DNS only`で設定し、完了を伝える。
3. Azure CLIでは実行できないEntra admin consentまたはapp role割当が発生した場合だけ、提示手順を実行する。
4. Azure for Studentsの残creditとデモ実施予定を確認する。
5. 初期管理者passwordを受け取り、初回ログイン後に変更または失効する。

### 5.3 Agentの停止点

Agentは次の場合、推測で進めずユーザーへ確認する。

- 削除対象にallow-list外または共有resourceが含まれる。
- Active/DLQ/Outboxが0でない、または保存対象データの有無を判断できない。
- Cloudflare DNSが提示値と一致しない、proxyが有効、managed certificateが発行できない。
- Entra IDの権限不足、Azure quota不足、credit不足がある。
- Next.js standalone SSR build、動画URL、Cookie/CORS、SignalRの受け入れテストが成立しない。
- destructive migration、秘密情報露出、実在利用者データを検知する。

## 6. 実装フェーズ

### Phase 0. 現在の負荷試験環境を廃棄する

- **目的:** デモ実装中の不要なAzure for Students credit消費を止める。
- **保持対象:**
  - Resource Group `awaver-devtest-rg`
  - 共有SignalR `awaver-signalr-devtest-436cd826`
  - Azure deployment history
  - GHCRのimmutable Backend/Worker image
  - リポジトリ内のIaC、負荷試験レポート
- **削除allow-list:**

| Resource | Type |
| --- | --- |
| `awavertest-worker` | `Microsoft.App/containerApps` |
| `awavertest-backend` | `Microsoft.App/containerApps` |
| `awavertest-cae` | `Microsoft.App/managedEnvironments` |
| `awavertest-backend` | `Microsoft.Web/sites` |
| `awavertest-backend-plan-cpu-autoscale` | `Microsoft.Insights/autoscalesettings` |
| `awavertest-backend-plan` | `Microsoft.Web/serverFarms` |
| `awavertest-backend-ai` | `Microsoft.Insights/components` |
| `awavertest-signalr` | `Microsoft.SignalRService/SignalR` |
| `awavertest-servicebus` | `Microsoft.ServiceBus/namespaces` |
| `awavertestredis` | `Microsoft.Cache/redisEnterprise` |
| `awavertestpostgres` | `Microsoft.DBforPostgreSQL/flexibleServers` |
| `awaverteststorage` | `Microsoft.Storage/storageAccounts` |
| `awavertest-logs` | `Microsoft.OperationalInsights/workspaces` |

`Application Insights Smart Detection` action groupはprefix外であるため、`awavertest-backend-ai`だけを参照していることを確認できた場合に限り追加削除する。

- **事前gate:**
  1. Backendの新規利用を停止する。
  2. Service Bus Active/DLQが0であることを再確認する。
  3. Outbox未配信が0であることをDBまたはmetricsで確認する。
  4. PostgreSQL、Blob、Log Analyticsのデータを放棄してよいか確認する。
  5. 現在のimage、revision、負荷試験レポート、resource一覧を保存する。
- **削除順:**
  1. Backend/Worker ACAと旧App Service。
  2. App Service autoscale、App Service plan、Container Apps environment。
  3. Application Insights。
  4. SignalR、Service Bus、Redis、PostgreSQL、Storage。
  5. Log Analytics workspace。
  6. 参照先確認済みの場合だけSmart Detection action group。
- **削除後確認:** `az resource list`でallow-listが消え、共有SignalRとResource Groupが残っていることを確認する。Worker System Assigned Managed Identityと`analysis_worker` app role割当が消えるため、再作成Taskへ引き継ぐ。
- **破棄:** 一時PostgreSQL password、期限付きSAS、Git管理外の`nonprod.secrets.parameters.json`を安全に破棄する。
- **実行制約:** 削除script実装とpreviewまでは進めてよいが、実削除は対象一覧・データ損失・保持対象を表示し、ユーザーが明示承認した場合だけ行う。`az group delete`は禁止する。

### Phase 1. SSR Frontendとcustom domainを配置する

- **対象scenario:** `student-learning-happy-path`、`admin-teacher-onboarding`、`teacher-dashboard-review`
- **作業:**
  1. Next.jsを`output: standalone`でSSR buildするFrontend Dockerfileを追加する。
  2. GitHub ActionsでFrontend、Backend、Workerの3 imageを同じimmutable tagでGHCRへpublishする。
  3. Frontend API/SignalR URLを`https://api.awaver.4rnay.net`へ固定する。
  4. Worker health URLを`https://worker.api.awaver.4rnay.net/health/ready`へ設定する。
  5. Frontend ACAをport 3000、external HTTPS ingress、min 0/max 2で追加する。
  6. Backend CORSを`https://awaver.4rnay.net`だけに固定する。
  7. Worker health CORS wildcardを`https://awaver.4rnay.net`へ制限する。
  8. Frontend ACAへ`awaver.4rnay.net`、Backend ACAへ`api.awaver.4rnay.net`、Worker ACAへ`worker.api.awaver.4rnay.net`をbindするIaCと手順を追加する。
  9. ACA managed certificateの作成・更新状態をデモcheckへ追加する。
- **受け入れ条件:** 指定した3つのHTTPS hostでSSR、dynamic Session route、Cookie/CSRF、SignalR、Worker readiness、管理画面、動画表示が成立する。
- **想定write scope:** `src/frontend/**`、Frontend Dockerfile、GitHub Actions、Azure IaC、関連テスト。

### Phase 2. warm-up / check / cooldownを自動化する

- **対象scenario:** `scheduled-demo-readiness`、`multi-session-dynamic-distribution`
- **作業:**
  - `demo-warmup.sh`: subscription/RG確認後、Backend min/max 2、Worker min 12/max 15へ変更し、全replica readyを待つ。
  - `demo-check.sh`: Backend live/ready、ACA replica、queue Active/DLQ、revision/image、quotaをsecretなしで表示する。
  - `demo-cooldown.sh`: queue/DLQ確認後、Worker min 0へ戻す。Backend min 0対応後はBackendも戻す。
  - 変更前後のscale値を表示し、対象subscription/RGと操作内容への明示確認を必須にする。
- **安全条件:** resource削除、secret表示、負荷試験をこれらのscriptから実行しない。
- **想定write scope:** `infra/azure/demo-*.sh`、`infra/azure/README.md`、demo parameter。

### Phase 3. Backend scale-to-zeroを可能にする

- `backendMinInstances`のBicep制約を0以上へ変更する。
- HTTP scalerによるcold start後にstartup/readinessが成立することを確認する。
- デモ前は必ずmin 2へ戻し、cold replicaを開始容量に数えない。
- Outbox未配信がある状態でmin 0へ落とさないguardをcooldown手順へ追加する。

### Phase 4. 安全なdestroy / recreateを自動化する

- `demo-destroy.sh`を追加し、削除allow-listをresource nameだけでなくtypeまで固定する。
- 現在の`awavertest`削除modeはテストACA Environmentを含めて削除する。
- 将来のデモcleanup modeはAレコードのstatic IPを維持するため、デモ用ACA Environment、managed certificate、最小限のLog Analyticsを既定で保持する。
- デモ用ACA Environmentまで完全削除するmodeは、custom domainをunbindし、A/TXTレコードの削除または退避を確認した場合だけ許可する。
- 既定はpreviewだけを表示し、TTYでsubscription、Resource Group、保持resource、削除resource、データ損失を確認する。
- 実削除には環境変数による明示opt-inと、固定確認文`DELETE AWAVERTEST RESOURCES`の入力を両方要求する。
- Resource Group削除コマンドをscriptへ含めない。
- Active/DLQまたはOutboxが0でない場合は削除を拒否する。
- `demo-recreate.sh`はBicep build/validate、foundation deploy、workload deploy、Worker app role再割当確認、health checkの順で実行する。
- secure parameter fileがない、image tagがmutable、共有SignalRが削除対象に含まれる場合は失敗させる。

### Phase 5. デモ環境を再作成する

1. Phase 1〜4が完了し、デモ日が決まってから開始する。
2. 最新のexampleから新しいsecure parameter fileを作り、新しい一時PostgreSQL password、初期管理者credential、一意なresource名を設定する。
3. `deploy.sh`でfoundationを作成し、provider、quota、credit、各resource状態を確認する。
4. clean commitから、指定domainをbuild設定に持つimmutable Frontend/Backend/Worker imageをbuild・publishする。動画URLとvideo IDはimageへ固定しない。
5. `resrc/60s.mp4`を`videos` containerへuploadし、デモ終了後まで有効なBlob単体read-only URLを生成する。
6. 動画URLをsecure `lessonVideoUrl`、video ID `60s`を`lessonVideoId`としてruntime parameterへ注入し、immutable imageを指定して`deploy-workloads.sh`を実行する。
7. 新Worker identityへEntra ID `analysis_worker` app roleを割り当てる。
8. 新しいデモ用ACA Environmentのstatic IPとverification IDを取得し、ユーザーへCloudflare A/TXT設定表を提示する。
9. ユーザーのDNS設定完了後、外部resolverで反映を確認する。
10. 3 hostnameをACAへbindし、managed certificateを発行する。
11. Frontend、Backend、Worker healthの各custom domain、動画再生、Cookie/CSRF/CORS、Queue/DLQ、Managed Identityを確認する。
12. 初期管理者でログインできることを確認し、bootstrap passwordをACA設定から削除する。

### Phase 6. デモリハーサルを自動・手動で確認する

1. Backend/Worker unit・integration test。
2. Frontend lint/build。
3. Playwright E2EをFrontend `awaver.4rnay.net`からBackend `api.awaver.4rnay.net`へのsame-site cross-origin構成で実行。
4. Managed IdentityのWorker結果投稿。
5. 1 Sessionの実カメラhappy path。
6. calibration retry、danger/normal、face-not-detected。
7. SignalR reconnect。
8. 管理画面のスコア・イベント取得。
9. 3 Session × 5fpsの小規模負荷試験。
10. Queue、DLQ、Outboxが0へ収束することを確認。
11. cooldown後、再warm-upして同じ手順が再現できることを確認。

## 7. 予約デモの運用タイムライン

| 時刻 | 作業 | 完了条件 |
| --- | --- | --- |
| T-1営業日 | 同一artifactで通しリハーサル | 全主要scenario合格 |
| T-60分 | warm-up、ready待機、Azure check | Backend 2、Worker 12 ready、依存healthy |
| T-30分 | smoke SessionとDashboard | frame→SignalR→DB確認 |
| T-15分 | カメラ、画面共有、Cookie、録画fallback確認 | デモ端末固定 |
| T-0 | ライブデモ開始 | No-Go項目なし |
| T+0〜終了 | active monitoring | backlog/DLQ/Outbox増加なし |
| 終了後 | 証跡保存、データ確認、cooldown | Worker min 0 |

## 8. コスト方針

- 現在の負荷試験用`awavertest` resourceはPhase 0で削除する。
- デモ再作成後、次のデモまで短期間ならWorker/Backendをscale-to-zeroする。
- PostgreSQL、Managed Redis、Service Bus、SignalRはscale-to-zeroだけでは課金が止まらないため、長期休止では再びdestroyする。
- Aレコードの切替を毎回発生させないため、新しいデモ用ACA Environmentとそのstatic IPは通常cleanupで保持する。Log Analyticsは必要最小限の保持期間とする。
- 直近に複数回デモがある期間だけデータ・メッセージングresourceを保持する。
- workloadと依存serviceの削除・再作成のたびに、データ放棄、Worker Managed Identity再割当、secure parameter再生成を行う。
- Azure PortalでAzure for Students creditを確認し、50%・80%相当の予算通知を設定する。

## 9. 今回不要とする商用本番対応

- 専用Production subscription
- 複数リージョンactive-active
- 24時間SLA・オンコール
- 全依存サービスのPrivate Endpoint
- geo-redundant database backup
- private ACR移行
- 自動production CD
- 長期監査ログと実在学生データ保持

将来、実在利用者へ継続提供する場合は、これらを再評価して`docs/operations/production-setup.md`の本番チェックリストへ戻る。

## 10. 完了条件

- CloudflareのAレコードで`awaver.4rnay.net`、`api.awaver.4rnay.net`、`worker.api.awaver.4rnay.net`がデモ用ACA Environmentのstatic IPを参照する。
- 3 hostnameがAzure managed certificate付きHTTPSで動く。
- `resrc/60s.mp4`がデモ用Blob URLから再生でき、URLの権限と有効期限がデモ用途に限定されている。
- 初期管理者をbootstrapでき、確認後に一時passwordがACA設定から削除されている。
- `worker.api.4rnay.net`を作成・参照していない。
- warm-up/check/cooldownが再現可能である。
- 重要デモ前に負荷試験済みprofileをreadyにできる。
- 同一artifactでT-1リハーサルと当日smokeが合格する。
- デモ終了後にWorkerをmin 0へ戻せる。
- `awavertest` resourceをallow-listで安全に削除し、共有SignalRとResource Groupを保持できる。
- デモ日決定後にIaCから環境を再作成し、新Worker identityへapp roleを再割当できる。
- 架空ID、同意済みカメラ、短期データだけを使用する。
- 2分以内に復旧できない場合の録画fallbackがある。
