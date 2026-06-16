# 受講者の通常受講シナリオ

## 1. 目的

受講者が学籍番号で受講セッションを開始し、Webカメラ許可、映像送信、Worker推論、キャリブレーション成功、眠気スコア通知を経て、通常状態で動画教材を受講できることを定義する。

## 2. アクター

- 受講者
- フロントエンド
- バックエンド
- Worker
- Service Bus
- Blob Storage
- Redis
- PostgreSQL
- SignalR

## 3. 前提条件

- 受講者は `/` または `/student` にアクセスできる。
- Webカメラが利用可能である。
- バックエンド、Worker、Blob Storage、Service Bus、Redis、PostgreSQL、SignalRが利用可能である。
- 受講者の顔がWebカメラに正面から映る。

## 4. Feature path

1. [`01-student-session-start.md`](../features/01-student-session-start.md)
2. [`02-webcam-capture.md`](../features/02-webcam-capture.md)
3. [`03-video-frame-sending.md`](../features/03-video-frame-sending.md)
4. [`04-frame-storage-and-queue.md`](../features/04-frame-storage-and-queue.md)
5. [`05-frame-decoding.md`](../features/05-frame-decoding.md)
6. [`06-face-recognition.md`](../features/06-face-recognition.md)
7. [`07-calibration.md`](../features/07-calibration.md)
8. [`08-drowsiness-scoring.md`](../features/08-drowsiness-scoring.md)
9. [`09-realtime-notification.md`](../features/09-realtime-notification.md)

## 5. E2Eフロー

1. 受講者が `/` または `/student` にアクセスする。
2. フロントエンドが案内ページを挟まず、画面中央にLoginモーダルを表示する。
3. Loginモーダルは生徒ログインを主表示とし、学籍番号入力、ログインボタン、教員ログインへ切り替えるLinkTextButtonを表示する。
4. 受講者が学籍番号を入力する。
5. フロントエンドが `POST /api/sessions` を呼び出す。
6. バックエンドが `students` と `learning_sessions` を作成または更新し、`sessionId` を返す。
7. フロントエンドがWebカメラ使用許可を求める。
8. 受講者がWebカメラ使用を許可する。
9. フロントエンドがWebカメラ映像を取得する。
10. フロントエンドが画面全面の動画Frameへ遷移する。
11. フロントエンドが動画再生画面で `/ws/sessions/{sessionId}/frames` へ接続する。
12. フロントエンドが動画Frame上にキャリブレーションモーダルを表示し、カメラ画角を表示する。
13. 受講者が開始ボタンを押す。
14. フロントエンドが5秒間のキャリブレーション指示と進捗を表示する。
15. キャリブレーション終了後、フロントエンドがモーダルを閉じる。
16. WebSocket接続済みの場合は動画再生とカメラ画角画像の送信を開始し、接続中の場合は接続完了後に開始する。
17. フロントエンドがI/Pフレームを1フレームずつWebSocketで送信する。
18. バックエンドが受信フレームに `receivedAt` を付与する。
19. バックエンドがフレームをBlob Storageへ保存する。
20. バックエンドがBlob参照情報をService Busへ投入する。
21. WorkerがService BusからBlob参照情報を受信する。
22. WorkerがBlob Storageからフレームを取得する。
23. WorkerがI/Pフレームを順次デコードし、画像フレームを復元する。
24. WorkerがMediaPipe Face Landmarkerで顔ランドマークを推定する。
25. WorkerがEAR・Pitch・Yawを算出する。
26. 送信開始直後の5秒間でWorker側キャリブレーションを実施する。
27. 有効フレームが15フレーム以上の場合、Workerが `EAR_open` と `EAR_threshold` を算出する。
28. Workerがキャリブレーション結果を `calibrations` に保存する。
29. Workerが以後のフレームでPERCLOSと眠気スコアを算出する。
30. Workerが1秒単位で `drowsiness_scores` に保存する。
31. Workerまたは配信基盤がSignalRで眠気スコア通知を送信する。
32. フロントエンドが現在の眠気レベルを表示する。
33. `level` が `normal`、`caution`、または `warning` の場合、動画再生を継続する。

## 6. 期待結果

- 受講者は学籍番号のみで受講を開始できる。
- `sessionId` が発行される。
- Webカメラ映像が取得される。
- I/PフレームがWebSocket、Blob Storage、Service Bus、Workerへ流れる。
- キャリブレーションが成功する。
- 動画教材の再生が許可される。
- 眠気スコアが算出・保存・通知される。
- 危険状態でない限り動画再生は継続する。

## 7. 例外・分岐

- Webカメラ権限が拒否された場合は、受講者に権限許可を促す。
- キャリブレーションに失敗した場合は、[`calibration-retry.md`](./calibration-retry.md) に分岐する。
- 顔未検出が発生した場合は、[`face-not-detected-warning.md`](./face-not-detected-warning.md) に分岐する。
- 眠気レベルが `danger` になった場合は、[`drowsiness-auto-pause-resume.md`](./drowsiness-auto-pause-resume.md) に分岐する。

## 8. 関連データ

- `students`
- `learning_sessions`
- `calibrations`
- `drowsiness_scores`
- Blob Storage上のフレームバイナリ
- Service Busメッセージ
- Redis上のPERCLOSスライディングウィンドウ
