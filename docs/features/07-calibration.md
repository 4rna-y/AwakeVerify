# キャリブレーション機能仕様

## 実装優先度

- 優先度: 07
- 理由: 個人別の閉眼閾値を確定し、動画再生開始の前提条件となるため。

## 1. 機能概要

受講開始時に受講者の開眼状態を基準化し、個人差を反映した閉眼閾値 `EAR_threshold` を算出する機能である。

キャリブレーションが成功するまで動画教材の再生を開始しない。

## 2. 利用者

- 受講者

## 3. 対象コンポーネント

- フロントエンド
- Worker
- PostgreSQL

## 4. トリガー

受講セッション開始後、5秒間のキャリブレーションを実施する。

## 5. 入力

Webカメラ映像から復元された画像フレームを入力とする。

5fps相当であるため、対象は25フレームである。

## 6. 有効フレーム条件

キャリブレーションに使用する有効フレームは以下を満たす。

```text
顔が検出できる
|Yaw_deg| <= 15
|Pitch_deg| <= 15
```

## 7. 成功条件

5秒間で有効フレームが15フレーム以上の場合、キャリブレーション成功とする。

## 8. 失敗条件

有効フレームが15フレーム未満の場合、キャリブレーション失敗とする。

失敗時は、フロントエンドに再キャリブレーションを促す。

## 9. 閾値算出

有効フレームのEAR中央値を `EAR_open` としてDB保存する。

閉眼閾値は以下で算出する。

```text
EAR_threshold = EAR_open × 0.75
```

## 10. フロントエンド表示

Loginページから `/student/session` の動画再生ページへ遷移した直後、動画Frame上にキャリブレーションモーダルを表示する。

モーダルではカメラ画角を表示し、開始ボタンを押すと、フロントエンドはBackendとWorkerが起動しているかを確認する。

BackendとWorkerの起動確認に成功した場合のみ、5秒間のキャリブレーションを開始する。

起動確認に失敗した場合は、キャリブレーションを開始せず、BackendとWorkerの起動確認を促す。

キャリブレーション中:

```text
顔を正面に向けてください。キャリブレーション中です。
```

失敗時:

```text
キャリブレーションに失敗しました。顔が正面から映るようにカメラ位置を調整してください。
```

### 10.1 リロード後の復帰

同一ブラウザタブで受講中にリロードした場合、フロントエンドは保持した `sessionId` とHttpOnly `student_session` Cookieを照合する。認可された当該セッションについてBackendに成功済みキャリブレーションを問い合わせ、保存結果がある場合はキャリブレーションモーダルを表示せず、同じタブに保存した動画進捗へシークする。カメラ・WebSocket・SignalRの再接続後に画面中央の再生ボタンを表示し、受講者が押した場合のみ受講を開始する。ブラウザ内の完了記録だけでは再生を許可しない。保存結果がない場合は通常どおりキャリブレーションを実施する。

## 11. 画面状態

| 状態 | 条件 | 表示 | 操作 |
| --- | --- | --- | --- |
| `calibration_ready` | セッション開始・カメラ取得後 | 動画Frame上のキャリブレーションモーダル、カメラ画角、開始ボタン、Backend/Worker起動確認状態 | 動画再生を禁止する。開始前にBackendとWorkerの起動確認を行う。 |
| `calibrating` | BackendとWorkerの起動確認成功後5秒間 | カメラ画角、進捗と案内文 | 動画再生を禁止する。 |
| `ready` | キャリブレーション成功後、または保存済み成功結果の復元後 | 動画Frame中央の再生ボタン、Float再生コントロール | モーダルを閉じる。受講者が中央の再生ボタンを押すまで動画再生とカメラ画角画像送信を開始しない。 |

## 12. データ保存と確定責務

`calibrations` は受講セッションごとに**成功したキャリブレーションを1件だけ**保持する。失敗した試行はDB保存せず、`calibration_status: failed` 通知で受講者に再試行を促す。成功済みセッションに同一結果が再送された場合は冪等成功とし、異なる閾値での上書きは拒否する。

```text
calibrations
- session_id uuid primary key, foreign key -> learning_sessions.session_id
- ear_open numeric not null
- ear_threshold numeric not null
- calibrated_at timestamptz not null
- source_sequence_no bigint not null
```

WorkerはPostgreSQLへ直接接続・直接書込みをしない。Workerは `sourceSequenceNo` を含む成功結果を、サービス認証済みの `POST /api/sessions/{sessionId}/analysis-results` へ送る。Backendがトランザクション内で `calibrations` を保存し、同じ通知payloadをTransactional Outboxへ登録する。通知配信失敗は保存済みのキャリブレーションを失わせない。詳細は [`08-drowsiness-scoring.md`](./08-drowsiness-scoring.md) と [`09-realtime-notification.md`](./09-realtime-notification.md) を一次情報とする。

## 13. 関連機能

- `02-webcam-capture.md`
- `06-face-recognition.md`
- `08-drowsiness-scoring.md`
- `10-auto-pause-resume.md`
