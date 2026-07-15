# セッション単位の弾力的フレーム処理機能仕様

## 実装優先度

- 優先度: 15
- 理由: 同時利用者数を事前に固定せず、受講セッション数と処理負荷に応じてフレーム処理・通知基盤を安全に水平スケールするため。

## 1. 機能概要

Backend、Worker、Outbox、SignalR配信を、受講セッション単位で弾力的にスケールする機能である。対象は、環境ごとに設定した最小・最大 replica 数および Azure クォータの範囲内での水平スケールであり、無限の同時利用を保証するものではない。

本書はセッション単位の分散、停止・障害時の引継ぎ、Outbox の複数 dispatcher、複数 Backend instance における通知配信、スケールおよび保持期間の一次情報とする。frame ingressのHTTP binary payload、status、再送および受理境界は[`03-video-frame-sending.md`](./03-video-frame-sending.md)を正とし、raw JPEG frame用WebSocketまたはBase64 payloadを復活させない。眠気判定式、認証・認可、Service Bus の個別再試行分類は既存 Feature を変更しない。

## 2. 対象コンポーネント

- Backend（複数 instance）
- Azure Blob Storage
- Azure Service Bus Session 有効 queue
- Worker（複数 replica と replica 内の複数 Session slot）
- Redis
- PostgreSQL の Transactional Outbox
- Azure SignalR Service（複数 Backend instance の Azure 本番構成）

## 3. 用語

| 用語 | 定義 |
| --- | --- |
| Session | 受講セッションを表す `sessionId`。Service Bus の Session ID とする。 |
| Session slot | Worker replica が同時に所有・逐次処理できる Service Bus Session の一枠。slot 内では一つの Session だけを処理する。 |
| dispatcher | 未配信の Outbox レコードを claim し、通知基盤へ配信する Backend instance 上の実行単位。 |
| lease | 他の dispatcher が同一 Outbox レコードを同時に処理しないための期限付き所有権。 |

## 4. セッション単位の順序保証と分散

- 同時利用者数を仕様上の固定値にしない。処理可能な規模は環境設定、実行基盤の能力および Azure クォータで決まる。
- `sessionId` は、フレーム順序保証、Worker の所有権、および水平分散の単位である。
- ClientはSessionごとに最大1本のin-flight HTTP frame requestだけを許可し、durable `202` を得るまで次のsequenceを送らない。capture tickでskipしたsequenceの欠番は許容する。この送信側制約によりBackendは同一Sessionのframeをsequence順にenqueueし、HTTP/2のstream完了順には依存しない。
- Backend は各フレームの `sessionId` を Service Bus メッセージの Session ID に設定し、Session 有効 queue へ投入する。フレーム永続化・message 形式・冪等性は [`04-frame-storage-and-queue.md`](./04-frame-storage-and-queue.md) を正とする。
- 同じ `sessionId` のフレームは、一時点に一つの Worker Session slot だけが `sequenceNo` 順に直列処理する。Worker replica 内外を問わず、同じ Session を並列処理してはならない。
- 異なる `sessionId` は、異なる Session slot または異なる Worker replica で並列処理できる。特定の Session が特定の Worker に恒久的に割り当てられることは保証しない。
- 再配送された同一 `(sessionId, sequenceNo)` は、既存の永続 Redis 冪等キーにより再解析・重複保存しない。受理済み解析結果の冪等性は [`08-drowsiness-scoring.md`](./08-drowsiness-scoring.md) を正とする。
- フレームの欠落、順序不整合、またはWorker移動後も、各 `image/jpeg` フレームは独立してデコードする。Workerは後続の有効なJPEGフレームを破棄せず、再起動・移動後は次に取得した有効なJPEGフレームから処理を再開する。眠気判定式、キャリブレーションのセッション直列処理、およびRedisのPERCLOS状態は変更・消去しない。

## 5. Worker の実行・停止・障害引継ぎ

- Worker の Session 並列度は設定可能とする。既定値は後方互換性を優先し、一つの Worker replica が一つの Session slot だけを処理する値とする。
- 各 slot は `NEXT_AVAILABLE_SESSION` などで取得した一つの Session を処理し、空になった Session receiver を閉じて次の利用可能 Session を取得できるようにする。
- Service Bus Session lock の更新失敗または lock 消失を検知した後は、その lock に属するメッセージを `complete`、`abandon`、dead-letter してはならない。receiver を閉じ、当該 slot の未処理作業を中断する。Service Bus による再配送を待つ。
- 停止シグナルまたは scale-in を受けた Worker は、新しい Session の取得を直ちに止める。既に所有する Session は、lock が有効な間に処理済みメッセージだけを安全に settle し、処理中のメッセージを完了扱いにしない。猶予時間内に安全に終了できない場合は receiver を閉じて再配送に委ねる。
- Worker プロセスまたは replica の障害後、lock の期限または receiver の解放後に、別 Worker が当該 Session を再取得できなければならない。JPEGデコードに引き継ぐローカル状態はない。Redisの永続冪等キー、キャリブレーション、およびPERCLOS状態は維持する。
- `complete`、`abandon`、dead-letter の成功条件と再試行不能エラーの分類は [`04-frame-storage-and-queue.md`](./04-frame-storage-and-queue.md) を変更しない。

## 6. Backend、Outbox、リアルタイム通知の分散

- Backend は複数 instance で稼働でき、HTTPS binary frame ingress、解析結果受理、Outbox dispatcher のいずれも特定の instance へ固定しない。
- SignalR 接続と Session 購読の registry はプロセス内メモリだけに依存してはならない。registry は複数 Backend instance から参照できる共有ストアに接続 ID、購読 `sessionId`、auth session の識別子、有効期限を保持する。切断、`LeaveSession`、auth session の失効時には共有 registry から取り除く。
- 通知送信時には、共有 registry の購読情報と auth session の有効性を再確認する。失効、revoke、期限切れした auth session の接続は通知対象にしない。Hub の参加認可と payload 契約は [`09-realtime-notification.md`](./09-realtime-notification.md) を変更しない。
- Azure 本番で複数 Backend instance を配置する場合、Azure SignalR Service を必須の配信基盤とする。ローカル開発の単一 Backend instance は ASP.NET Core SignalR を使用できる。
- 複数 dispatcher は未配信かつ due の Outbox レコードを、期限切れでない lease を除外して安全に claim する。claim はトランザクションで行い、`lease_id`、`processing_owner`、`locked_until`、attempt 情報を記録する。
- lease を取得した dispatcher だけが配信成功として `delivered_at` を更新できる。dispatcher crash、lease 期限切れ、または送信後・配信済み記録前の crash では、別 dispatcher が再 claim できる。
- Outbox 配信は at-least-once とする。上記 crash 境界ではクライアントが同一イベントを重複受信し得るため、受信側は既存の解析結果冪等キーで安全に扱う。at-most-once を要求してはならない。
- SignalR 送信、共有 registry 参照、または auth session 有効性確認に失敗した場合、Outbox レコードを配信済みにしてはならない。lease 解放または期限切れ後にバックオフを伴って再試行する。
- Backend は `/health/live` と `/health/ready` を公開する。liveness はプロセス応答だけを確認し、PostgreSQL、Redisなどの一時障害では不健康にしない。readiness はPostgreSQL、Blob Storage、Service Bus sender、分散registry用Redis、および複数instance構成時のAzure SignalR設定を短いtimeoutで確認し、新規トラフィックを安全に受けられない場合は `503` を返す。responseには接続文字列その他の秘密値を含めない。
- scale-in開始時はreadinessを不健康へ遷移させ、Outbox dispatcherは新規claimを停止する。既にclaim済みの短いbatchはhostのgrace period内で完了を試み、完了できないleaseは期限後に別instanceが再取得する。

## 7. スケール、保持期間、監視

- Worker autoscale の主要トリガーは Service Bus の backlog とする。Session 有効 queue の Active message 数、処理中 Session slot 数、最大 replica 到達状況を可視化する。
- 最古の未処理メッセージ年齢は、リアルタイム性の SLO/アラート指標とする。backlog 件数だけで遅延を判断しない。
- 最大 Worker replica 数は環境設定と Azure クォータで制御する。上限到達時もフレームをサイレントに破棄せず、backlog、最古メッセージ年齢、dead-letter を可視化・通知する。
- Backend の replica 数も環境設定と Azure クォータで制御する。複数 instance へ拡張する際は、共有接続 registry と Azure SignalR Service を同時に満たす。
- フレーム Blob の保持期間と削除は環境設定および Blob Lifecycle Management Rule で制御する。削除は、通常の再配送・最大配送回数・調査に必要な期間より短くしてはならない。Lifecycle Rule と設定値が不一致のまま運用してはならない。
- 監視対象は Service Bus backlog、最古メッセージ年齢、Session lock 消失、dead-letter、Worker slot 利用率、Outbox 未配信件数と最古 Outbox 年齢、claim/lease 期限切れ、SignalR 送信失敗、Backend/Worker replica 数と上限到達である。

## 8. 設定契約

以下の値は環境設定または IaC で与える。アプリケーションコードに利用者数や環境固有の capacity を固定しない。具体的な設定名は後続実装で本表を満たす形に統一し、同義の設定を重複させない。

| 論点 | 推奨設定名 | 意味・制約 | 既定値方針 |
| --- | --- | --- | --- |
| Worker Session 並列度 | `WORKER_SESSION_CONCURRENCY` | 一つの Worker replica が同時所有できる Session slot 数。正の整数。各 slot は一つの Session を直列処理する。 | 後方互換のため 1 slot。 |
| Worker replica 下限 | `WORKER_MIN_REPLICAS` | 常時確保する Worker replica 数。0以上で、必要な待機・可用性要件を満たす。 | 既存デプロイの可用性方針を維持する値。 |
| Worker replica 上限 | `WORKER_MAX_REPLICAS` | autoscale 可能な Worker replica の上限。下限以上かつ Azure クォータ以下。 | 環境のクォータとコスト上限から IaC で決定する。 |
| queue scale threshold | `WORKER_SCALE_QUEUE_THRESHOLD` | backlog により scale-out を開始・維持する閾値。正のメッセージ数で、slot 処理能力と遅延 SLO に整合させる。 | 負荷試験で測定した Session slot 処理能力を基準に環境ごとに決定する。 |
| Outbox batch size | `OUTBOX_BATCH_SIZE` | 一つの claim transaction で取得する最大レコード数。正の整数。 | 100。単一sessionへの固定ではなく複数sessionの進捗を確保する値として開始し、DB/通知基盤の負荷で調整する。 |
| Outbox poll interval | `OUTBOX_POLL_INTERVAL_MS` | due Outbox を確認する間隔（ミリ秒）。正の整数。 | 250ms。通知遅延と空pollのDB負荷の均衡を取り、運用測定で調整する。 |
| Outbox lease duration | `OUTBOX_LEASE_SECONDS` | dispatcher の claim 所有権の有効期間（秒）。正の整数。通常の配信処理より十分長く、障害時に再取得可能な上限を持つ。 | 30秒。観測した配信処理時間の p99 に運用上の余裕を加える。 |
| Backend expected instance count | `BACKEND_EXPECTED_INSTANCE_COUNT` | IaCが与える同時にroutingされ得るBackend replica数。正の整数。2以上ではAzure SignalR ServiceとRedis registryを必須とする。 | ローカル単一process互換のため1。 |
| Backend readiness timeout | `READINESS_TIMEOUT_MS` | readinessの依存サービスごとのtimeout（ms）。正の整数。 | 2000ms。依存障害を検知しつつliveness再起動ループを避ける値。 |
| フレーム Blob 保持期間 | `FRAME_BLOB_RETENTION_DAYS` | フレーム Blob を削除対象にするまでの期間。正の duration で、再配送・dead-letter 調査期間を下回らない。 | セキュリティ・監査・障害調査要件を満たす最短期間として環境ごとに決定する。 |

`WORKER_MIN_REPLICAS`、`WORKER_MAX_REPLICAS`、`WORKER_SCALE_QUEUE_THRESHOLD`、Blob Lifecycle Rule は Container Apps 等の IaC 設定と整合させる。これらは特定の同時利用者数を表す契約ではない。

## 9. 受け入れ条件

- 同じ `sessionId` のフレームは Worker replica をまたいでも並列処理されず、`sequenceNo` 順に処理される。
- 異なる `sessionId` は複数 Session slot または複数 Worker replica で並列処理できる。
- Worker の停止・scale-in・Session lock 消失後に、処理中メッセージを誤って settle せず、別 Worker が再配送された Session を処理できる。
- Workerが再起動または移動したSessionは、次に取得した有効なJPEGフレームから処理を再開し、後続フレームを欠落のために破棄しない。
- 複数 Backend instance のいずれで接続を受け、いずれで Outbox を処理しても、認可済みの対象 Session だけに通知できる。失効した auth session には通知しない。
- 複数 dispatcher は同一 Outbox レコードを安全に claim し、送信や registry 障害では配信済みにしない。crash 境界での重複配信は許容する。
- autoscale は backlog を主に利用し、最古メッセージ年齢と Outbox 年齢を監視する。最大 replica 到達時もフレームをサイレントに失わない。
- Azure 本番の複数 Backend 構成では Azure SignalR Service を使用し、接続 registry をプロセス内メモリだけに置かない。

## 10. 関連機能・シナリオ

- [`04-frame-storage-and-queue.md`](./04-frame-storage-and-queue.md)
- [`05-frame-decoding.md`](./05-frame-decoding.md)
- [`08-drowsiness-scoring.md`](./08-drowsiness-scoring.md)
- [`09-realtime-notification.md`](./09-realtime-notification.md)
- [`../scenarios/multi-session-dynamic-distribution.md`](../scenarios/multi-session-dynamic-distribution.md)
