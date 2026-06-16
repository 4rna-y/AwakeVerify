# 顔未検出時の警告表示シナリオ

## 1. 目的

受講中にWorkerが顔未検出を検知した場合、フロントエンドに警告を表示しつつ、顔未検出のみを理由に動画教材を停止しない流れを定義する。

## 2. アクター

- 受講者
- フロントエンド
- Worker
- SignalR

## 3. 前提条件

- 受講者セッションが開始済みである。
- Webカメラ映像が送信されている。
- Workerが画像フレームをデコードできている。
- SignalR通知を受信できる。

## 4. Feature path

1. [`02-webcam-capture.md`](../features/02-webcam-capture.md)
2. [`03-video-frame-sending.md`](../features/03-video-frame-sending.md)
3. [`04-frame-storage-and-queue.md`](../features/04-frame-storage-and-queue.md)
4. [`05-frame-decoding.md`](../features/05-frame-decoding.md)
5. [`06-face-recognition.md`](../features/06-face-recognition.md)
6. [`09-realtime-notification.md`](../features/09-realtime-notification.md)
7. [`10-auto-pause-resume.md`](../features/10-auto-pause-resume.md)

## 5. E2Eフロー

1. 受講者が動画教材を受講中である。
2. フロントエンドがWebカメラ映像をI/Pフレームとして送信する。
3. Workerがフレームをデコードし、画像フレームを復元する。
4. WorkerがMediaPipe Face Landmarkerで顔検出を試みる。
5. 顔が検出できない。
6. Workerは対象フレームをPERCLOS計算に含めない。
7. Workerは顔未検出フレーム単体を `drowsiness_scores` に保存しない。
8. WorkerがSignalRで顔未検出通知を送信する。

   ```json
   {
     "type": "tracking_status",
     "sessionId": "uuid",
     "detectedAt": "2026-06-14T10:00:00Z",
     "status": "face_not_detected"
   }
   ```

9. フロントエンドが通知を受信する。
10. フロントエンドが受講者画面に警告を表示する。

   ```text
   顔が検出できません。カメラ位置を調整してください。
   ```

11. フロントエンドは顔未検出のみを理由に動画を停止しない。
12. 次に顔が検出できた時点で、Workerが推論とスコア算出を再開する。
13. フロントエンドは必要に応じて警告表示を解除または更新する。

## 6. 期待結果

- 顔未検出時に受講者へ警告が表示される。
- 顔未検出フレームはPERCLOS計算に含まれない。
- 顔未検出フレーム単体は `drowsiness_scores` に保存されない。
- 顔未検出のみでは動画教材は自動停止しない。
- 顔検出が復帰すると推論・スコア算出が再開する。

## 7. 例外・分岐

- 顔未検出が長時間継続しても、本仕様上は顔未検出のみを理由に動画停止しない。
- 眠気スコア通知で `danger` または `shouldPause: true` を受信した場合は、顔未検出とは別に自動停止シナリオへ分岐する。

## 8. 関連データ

- SignalR `tracking_status` 通知
- Worker内部の推論状態
- Redis上のPERCLOSスライディングウィンドウ
