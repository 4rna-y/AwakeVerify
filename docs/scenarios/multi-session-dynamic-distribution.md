# 複数受講セッションの動的分散シナリオ

## 1. 目的

複数の受講者が同時に受講しても、`sessionId` 単位で順序を保ちながらフレーム解析と通知を動的に分散し、Worker・Backend・Outbox の停止、障害、scale-in/out でフレームや永続化済み結果をサイレントに失わないことを定義する。

このシナリオは特定の同時利用者数の上限を定義しない。対象環境の replica 設定および Azure クォータの範囲で、処理負荷に応じて水平スケールできることを確認する。

## 2. アクター

- 複数の受講者
- フロントエンド
- 複数の Backend instance
- Azure Blob Storage
- Service Bus Session 有効 queue
- 複数の Worker replica と Session slot
- Redis
- PostgreSQL
- Outbox dispatcher
- Azure SignalR Service

## 3. 前提条件

- 各受講者は異なる有効な `sessionId` と、その Session に束縛された有効な `student_session` を持つ。
- Backend は Blob Storage と Service Bus Session 有効 queue に接続できる。
- Worker は Blob Storage、Service Bus、Redis、Backend 解析結果 API に接続できる。
- Azure 本番で複数 Backend instance を使用する場合、Azure SignalR Service と共有接続 registry が設定済みである。
- Worker の Session 並列度、Worker min/max replica、queue scale threshold、Outbox batch/poll/lease、Blob 保持期間は、[`15-elastic-session-frame-processing.md`](../features/15-elastic-session-frame-processing.md) の設定契約を満たす環境設定と IaC により与えられている。
- 各Sessionは、Feature 03の `POST /api/sessions/{sessionId}/frames/{sequenceNo}` へ、認証CookieとCSRF headerを伴う単独でデコード可能な `image/jpeg` binary bodyを送信できる。metadata、size制限、status、冪等性および再送はFeature 03を正とする。Sessionごとに最大1 requestをin-flightにし、capture tickでskipしたsequenceの欠番を許容する。キャリブレーション、眠気判定式、認証・認可は既存Featureのままとする。

## 4. Feature path

1. [`01-student-session-start.md`](../features/01-student-session-start.md)
2. [`03-video-frame-sending.md`](../features/03-video-frame-sending.md)
3. [`04-frame-storage-and-queue.md`](../features/04-frame-storage-and-queue.md)
4. [`05-frame-decoding.md`](../features/05-frame-decoding.md)
5. [`08-drowsiness-scoring.md`](../features/08-drowsiness-scoring.md)
6. [`09-realtime-notification.md`](../features/09-realtime-notification.md)
7. [`15-elastic-session-frame-processing.md`](../features/15-elastic-session-frame-processing.md)

## 5. 正常系 E2E フロー

1. 複数の受講者がそれぞれ異なる `sessionId` で受講を開始し、各 Session が5fps相当のフレームを送信する。
2. 各受講者のフロントエンドは、対応するSessionのHTTPS binary frame APIへ認証CookieとCSRF headerを伴うraw JPEGを送信する。前requestがin-flightのcapture tickはqueueせずskipし、retry可能な応答だけを同一sequence、metadata、bytesで再送する。
3. いずれかの Backend instance がフレームを受信し、`receivedAt` を付与して Blob へ保存する。Blob保存とSession queueへのenqueueの両方が完了したときだけ`202 Accepted`を返す。
4. Backend は Blob 保存成功後、`sessionId` を Service Bus Session ID とするフレーム参照メッセージを Session 有効 queue へ投入する。
5. Worker の複数 Session slot または複数 Worker replica が、異なる Session を並列に取得する。
6. 各 slot は所有した一つの Session のフレームを `sequenceNo` 順に直列処理する。同一 Session のフレームを複数 slot で同時処理しない。
7. Worker は Blob からフレームを取得して既存のデコード・解析を実行し、解析結果をサービス資格情報付きで Backend API へ冪等送信する。
8. Backend は解析結果と通知 Outbox を同一トランザクションで保存する。
9. 複数 Backend instance のいずれかで稼働する Outbox dispatcher が、未配信レコードを lease 付きで claim する。
10. Outbox を処理する Backend instance が接続を受けた instance と異なる場合も、共有接続 registry と Azure SignalR Service を通じて、有効な認証を持つ対象 Session の接続だけへ通知する。
11. 通知成功後、lease 所有者だけが Outbox を配信済みにする。受講者画面は既存の SignalR payload により状態を更新する。

## 6. 期待結果・受け入れ条件

- 各 Session のフレーム処理順は、clientの1 in-flight制約によりenqueueされた `sequenceNo` 順であり、capture skipによる欠番は後続frameを妨げない。Session 間の処理完了順は拘束しない。
- 同一Session内のキャリブレーション、PERCLOS、解析結果の既存契約と直列処理が維持される。
- 異なる Session の処理が複数 slot/replica に分散し、単一 Worker または単一 Backend instance への固定割当にならない。
- Worker からの再送、Outbox の crash 境界による再試行でも、解析結果は既存の冪等キーにより重複保存されない。通知は at-least-once のため重複受信を許容する。
- Backend 接続 instance と Outbox 処理 instance が異なっても、対象 Session の認可済み接続へ通知が届く。
- 設定済みの最大 replica に達した場合、未処理フレームは backlog として残り、最古メッセージ年齢、Outbox 年齢、上限到達状況を監視できる。

## 7. 例外・分岐

### 7.1 Worker 停止・障害・scale-in

1. Worker が停止シグナルを受ける、または処理中に障害で終了する。
2. Worker は新しい Session を取得せず、lock が有効な処理済みメッセージだけを安全に settle する。未完了メッセージを成功として `complete` しない。
3. receiver 解放または Session lock 期限後、別 Worker の slot が同じ Session を再取得する。
4. 新しいWorkerは、次に取得した有効なJPEGフレームを単独でデコードして処理を再開する。フレームの欠落またはWorker移動を理由に後続フレームを破棄しない。

期待結果:

- 処理中メッセージが scale-in により誤って complete されない。
- 別 Worker が Session を再取得し、既存の冪等性を保って処理を継続できる。

### 7.2 Session lock 消失

1. Worker が Session lock 更新失敗または lock 消失を検知する。
2. Worker はその receiver 上のメッセージを `complete`、`abandon`、dead-letter しない。
3. receiver を閉じ、再配送後に別の取得として処理を再開する。

期待結果:

- lock を失ったメッセージを settle しようとせず、フレームをサイレントに失わない。

### 7.3 重複配送とフレーム欠落・順序不整合

1. 同じ `(sessionId, sequenceNo)` のフレームが再配送される。
2. Workerは処理済みRedis冪等キーを確認し、再解析・重複保存を行わない。
3. フレームの欠落または順序不整合を検知しても、Workerは後続の有効なJPEGフレームを単独でデコードして処理する。
4. セッション直列処理によりキャリブレーションとPERCLOS状態の更新順序を維持する。

期待結果:

- 再配送で解析結果、PERCLOS、Outboxレコードが重複しない。
- 順序不整合をdead-letterの理由とせず、後続の有効なJPEGフレームを処理できる。

### 7.4 Backend 再起動と Outbox dispatcher 障害

1. 解析結果の永続化後、SignalR 配信前または配信済み記録前に Backend/dispatcher が停止する。
2. Outbox レコードは `delivered_at` 未設定のまま残る。
3. lease の期限後、任意の Backend instance の dispatcher が再 claim して再送する。

期待結果:

- Backend 再起動後も未配信結果を失わない。
- SignalR 送信、共有 registry 参照、または認証有効性確認に失敗した場合、Outbox を配信済みにしない。
- crash 境界での通知重複は許容する。

### 7.5 接続 registry・認証の障害または失効

1. Outbox dispatcher が対象 Session の接続情報を参照する。
2. registry 障害、または接続に対応する auth session の revoke・期限切れを検知する。
3. registry 障害時は Outbox を未配信として再試行する。auth session 無効時は当該接続へ送信しない。

期待結果:

- auth session 失効後の接続へ通知しない。
- 共有 registry の障害で通知可否を確定できない場合、Outbox を配信済みにしない。

### 7.6 最大 replica 到達

1. Service Bus backlog が scale-out 条件を満たす。
2. Worker は設定済みの最大 replica 数まで scale-out する。
3. 上限到達後も backlog が残る。

期待結果:

- 上限到達を監視・アラートで確認できる。
- 未処理フレームは queue backlog として保持され、サイレントに失われない。

## 8. 関連データ・監視値

- `learning_sessions`
- Blob Storage 上のフレームバイナリ
- Service Bus Session queue の Active message、最古メッセージ年齢、dead-letter、Session lock 失敗
- Redis のフレーム冪等キーおよび PERCLOS 状態
- `drowsiness_scores`
- `analysis_event_outbox` の未配信件数、最古 Outbox 年齢、lease 所有者・期限、再試行回数
- 共有 SignalR 接続 registry
- Backend/Worker replica 数、Worker Session slot 利用率、Azure クォータ
