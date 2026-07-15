# Azure予約デモ準備シナリオ

## 1. 目的

大学の個人制作プロジェクトとしてAwakeVerifyを常時運用せず、予約されたデモ時間にAzure上のBackend、Workerおよび依存サービスを確実に利用できる状態へ準備し、主要なユーザーシナリオを実演する。

本シナリオは商用サービスの24時間SLA、複数リージョンDR、常時オンコールを要求しない。その代わり、デモ前warm-up、同一artifactでのリハーサル、依存サービス確認、失敗時の切り戻し、およびデモ後のscale-downを必須とする。

## 2. 対象シナリオ

- [`student-learning-happy-path.md`](./student-learning-happy-path.md)
- [`calibration-retry.md`](./calibration-retry.md)
- [`drowsiness-auto-pause-resume.md`](./drowsiness-auto-pause-resume.md)
- [`face-not-detected-warning.md`](./face-not-detected-warning.md)
- [`teacher-dashboard-review.md`](./teacher-dashboard-review.md)
- [`admin-teacher-onboarding.md`](./admin-teacher-onboarding.md)
- [`multi-session-dynamic-distribution.md`](./multi-session-dynamic-distribution.md)

## 3. 対象環境

- Azure subscription: 現在Azure CLIで選択されている`Azure for Students`
- Resource Group: `awaver-devtest-rg`
- Region: Japan East
- Frontend URL: `https://awaver.4rnay.net`
- Backend API / SignalR URL: `https://api.awaver.4rnay.net`
- Worker health URL: `https://worker.api.awaver.4rnay.net`
- Frontend / Backend / Worker: Azure Container Apps
- Frontend runtime: Next.js standalone SSR
- 依存サービス: PostgreSQL、Azure Managed Redis、Blob Storage、Service Bus、Azure SignalR Service

`worker.api.4rnay.net`は作成・使用しない。

FrontendとBackendは異なるoriginだが、同じ`4rnay.net` siteとして運用する。Backendが発行する`__Host-`認証Cookieは`api.awaver.4rnay.net`のhost-onlyを維持し、Frontend domainへ共有しない。Frontendは資格情報付きrequestとBackend responseの`X-CSRF-Token` headerを使用する。

### 3.1 DNSとTLS

- DNS providerは既存のCloudflareを使用する。
- 新しいデモ用ACA Environment作成後に取得したstatic public IPを、`awaver.4rnay.net`と`api.awaver.4rnay.net`のAレコードへ設定する。
- health-only Worker ingressを使用する場合は、同じstatic IPを`worker.api.awaver.4rnay.net`のAレコードへ設定する。
- 各custom domain用の`asuid` TXTレコードを、再作成したACA Environmentのverification IDで設定する。
- Cloudflare proxyは使用せず、DNS onlyとしてAzure managed certificateとWebSocket/SignalRを直接ACAへ接続する。
- DNS TTLは切替・検証中300秒を推奨する。
- managed certificateが`Succeeded`となり、各URLのcertificate chain、hostname、HTTPS redirectを確認するまでデモを開始しない。
- 現在の負荷試験用ACA Environmentは削除予定であるため、そのstatic IPやverification IDをA/TXTレコードへ使用しない。

この環境はデモ専用の非本番環境として扱う。実在する学生の運用データを蓄積する本番サービスとして扱わない。

## 4. デモデータとセキュリティ前提

- 学籍番号、教員、管理者はデモ専用の架空IDを使用する。
- カメラに映る本人からデモ利用の同意を得る。
- フレーム画像、スコア、受講履歴はデモ後に保持要否を確認し、不要なものを削除する。
- Blobは匿名公開せず、通信はTLSを使用する。
- FrontendからBackendへの資格情報付きCORSは`https://awaver.4rnay.net`だけを許可する。
- Workerの公開ingressは`GET /health`、`GET /health/live`、`GET /health/ready`とpreflightだけを提供し、frame、queue、管理操作を公開しない。
- secret、Cookie、token、接続文字列、画像を画面共有、ログ、レポートへ表示しない。
- Production用の`WORKER_API_KEY`を使用せず、WorkerはManaged IdentityとEntra IDの`analysis_worker` roleを使用する。

## 5. デモ容量契約

### 5.1 通常の実演範囲

- 同時Session: 3以下
- frame送信: 各Session 5fps以下
- Worker Session並列度: 3 slot/replica

通常のデモは1 Sessionを想定し、予備端末や管理画面確認を含めても3 Session以内とする。これを超える実演を行う場合は、デモ条件を明示して事前負荷試験を実施する。

### 5.2 重要デモのwarm profile

確実性を優先する重要デモでは、2026-07-15にAzure負荷試験で合格した構成を再利用する。

- Backend: min 2 / max 2 replica
- Worker: min 12 / max 15 replica
- Worker Session slot: 3 / replica
- Worker ready slot: 最低36
- queue polling interval: 10秒
- frame-to-result SLO: p95 2秒以下、p99 5秒以下、timeout 0

3 Sessionの実演に対して過剰な容量だが、短い予約時間だけ使用し、未検証の縮小profileによるcold startやmodel load遅延を避ける。縮小profileを採用する場合は、そのprofileでリハーサルと鮮度測定に合格してから使用する。

## 6. デモ前フロー

### T-1営業日

1. デモで使用するcommitとimmutable image tag/digestを確定する。
2. 同じartifactをAzureへ配置する。
3. `awaver.4rnay.net`、`api.awaver.4rnay.net`、使用する場合は`worker.api.awaver.4rnay.net`のDNS、custom domain、managed certificateを確認する。
4. Frontend buildの`NEXT_PUBLIC_API_BASE_URL`が`https://api.awaver.4rnay.net`で、Backend CORSが`https://awaver.4rnay.net`だけを許可することを確認する。
5. Backend 2 replica、Worker 12 replicaをreadyにする。
6. Backend `/health/live`と`/health/ready`を確認する。
7. Service Bus Active messageとDLQが0であることを確認する。
8. Managed IdentityによるWorker結果投稿、Blob、Redis、PostgreSQL、SignalRを確認する。
9. デモ用ブラウザとカメラで、通常受講、キャリブレーション、スコア通知、停止・復帰、Dashboardを通しでリハーサルする。
10. リハーサル条件、結果、artifact、問題と解消結果を記録する。

### T-60分

1. Azure CLIのsubscriptionとResource Groupを確認する。
2. 重要デモwarm profileへ設定する。
3. 全Backend/Worker replicaがRunningかつreadyになるまで待つ。
4. Backend readinessの全依存checkがhealthyであることを確認する。
5. Queue、DLQ、Outbox滞留がないことを確認する。
6. 低負荷smoke Sessionを1件実行し、HTTP frame `202`からSignalR通知まで確認する。
7. Azure quota、Azure for Students credit、主要リソース状態を確認する。

### T-15分

1. デモ端末を電源接続し、スリープ、自動更新、VPN、不要な同期処理を停止する。
2. 使用ブラウザ、カメラ権限、画角、照明、動画音量、画面共有範囲を確認する。
3. デモ用アカウントでログインし、秘密情報が画面にないことを確認する。
4. Backend、SignalR、Worker処理の最終smokeを行う。
5. デモ用Sessionを作り直し、古いCookieと途中状態を残さない。
6. fallback用の短い録画と主要画面のスクリーンショットをローカルに準備する。

## 7. デモ中の受け入れ条件

- Backend readinessが成功し、依存checkがすべてhealthyである。
- Worker ready slotがデモSession数以上である。
- キャリブレーション成功後だけ動画を再生できる。
- frame送信、Blob保存、Service Bus、Worker解析、Backend永続化、SignalR通知が成立する。
- 眠気または検証入力で自動停止し、normal復帰後の明示操作で再開できる。
- 管理画面で永続化済みスコアとイベントを取得できる。
- SignalR一時切断後に再接続し、正しいSessionへ復帰できる。
- Active message、DLQ、Outboxが増え続けない。

## 8. デモ中の異常対応

優先順位は「復旧を待ち続ける」より「デモ進行を止めない」とする。

1. Browserだけの問題なら、再読み込みせず接続再試行を先に行う。
2. CookieまたはSession状態が不整合なら、新しいデモSessionを開始する。
3. Backend readiness失敗なら、新規Session開始を止め、依存checkで原因を特定する。
4. Worker通知が来ない場合は、Worker replica、queue backlog、Backend結果API、Managed Identityを確認する。
5. 2分以内に復旧見込みがない場合、録画へ切り替えて設計・負荷試験結果を説明する。
6. デモ中にAzure resourceの削除、DB migration、secret rotation、大規模redeployを行わない。

## 9. デモ後フロー

1. Session完了、Queue Active/DLQ、Outbox滞留を確認する。
2. 必要なログとデモ結果だけを保存する。画像・識別子・secretをレポートへ含めない。
3. Workerをmin 0へ戻す。
4. Backendをscale-to-zero可能な構成にした後はmin 0へ戻す。未対応の間は、次回デモが近い場合だけ最小1を許容する。
5. 旧App Service、余分なSignalR、未使用resourceは、依存がないことを確認した別作業で停止・削除する。
6. デモ用フレームとアカウントの保持要否を確認し、不要なデータを削除する。
7. 次回まで長期間空く場合は、再作成手順と必要な証跡を残してprefix付きAzure resourceを削除する。

## 10. デモ環境の廃棄と再作成

デモ予定がない期間は、scale-to-zeroだけで課金が止まらないPostgreSQL、Redis、Service Bus、SignalR、Log Analyticsなどを含め、`awavertest`用resourceを削除する。

### 10.1 廃棄前条件

- 配置commit、image tag/digest、負荷試験結果、IaC parameter契約を保存している。
- Service Bus Active/DLQとOutbox滞留を確認している。
- PostgreSQL、Blob、ログを保存しないことを確認している。必要なデータがある場合は先にexportする。
- 削除対象をresource IDとtypeで列挙し、`awavertest`以外を含まないことを確認している。
- `awaver-devtest-rg`と共有SignalR `awaver-signalr-devtest-436cd826`を削除対象から除外している。

### 10.2 廃棄手順

1. 新規デモ利用を停止する。
2. Backend/Worker ACAと旧App Serviceを削除する。
3. App Service autoscale、App Service plan、Container Apps environmentを削除する。
4. Application Insights、テスト用SignalR、Service Bus、Redis、PostgreSQL、Storageを削除する。
5. Log Analytics workspaceは必要な証跡の保存後に最後に削除する。
6. Smart Detection action groupは、テスト用Application Insightsだけを参照していることを確認できた場合だけ削除する。
7. Worker ACA削除によりSystem Assigned Managed Identityとapp role割当も失われることを記録する。
8. 一時PostgreSQL passwordとGit管理外のsecure parameter fileを安全に破棄する。
9. Azure resource一覧を再取得し、共有resourceだけが残ることを確認する。

削除は復元不能なデータ破壊を伴うため、対象一覧と影響を表示し、ユーザーが明示承認した実行でだけ行う。Resource Group全体の削除は禁止する。

### 10.3 再作成条件

- 最新IaCのbuild/validateが成功している。
- 新しいsecure parameter fileと一時PostgreSQL passwordを作成している。
- immutable Backend/Worker imageが利用可能である。
- Foundation、workloadの順にdeployし、新Worker identityへ`analysis_worker` app roleを再割当する。
- デモ前warm-up、health、Managed Identity、主要Scenarioのリハーサルを再実施する。

## 11. No-Go条件

次の場合はライブデモを開始せず、録画または説明デモへ切り替える。

- T-1営業日の通しリハーサルを同一artifactで実施していない。
- Backend readinessまたはWorker ready確認に失敗している。
- Queue/DLQ/Outboxに原因不明の滞留がある。
- デモ端末のカメラ、ブラウザ、ネットワーク、Cookie/CORSが未確認である。
- A/TXTレコード、custom domain、managed certificateのいずれかが未設定または不健康である。
- Frontendが`https://api.awaver.4rnay.net`以外のBackendを参照している。
- 配置artifactとリハーサル済みartifactが一致しない。
- Azure quotaまたはcredit不足が予想される。
- 実在学生データ、secret、token、接続文字列を画面共有する可能性がある。

## 12. 記録

- デモ日時、場所、ネットワーク
- commit、image tag/digest、ACA revision
- Backend/Worker replicaとready状態
- health、Queue、DLQ、Outbox確認結果
- リハーサル結果と所要時間
- デモ中の問題とfallback使用有無
- デモ後のscale-downとデータ削除結果
- A/TXTレコード、ACA custom domain、certificate状態
