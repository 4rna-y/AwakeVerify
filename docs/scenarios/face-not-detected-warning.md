# 顔未検出時の警告表示シナリオ

## 1. 目的

受講中にWorkerが顔未検出を検知した場合、フロントエンドが閉眼時と同様に動画教材を一時停止し、WebカメラFrame付きのPopupで受講者にカメラ状態確認を促す流れを定義する。

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
2. フロントエンドがWebカメラ映像を、単独でデコード可能な `image/jpeg` フレームとして送信する。
3. Workerがフレームをデコードし、画像フレームを復元する。
4. WorkerがMediaPipe Face Landmarkerで顔検出を試みる。
5. 顔が検出できない。
6. Workerは対象フレームをPERCLOS計算に含めない。
7. Workerは顔未検出フレーム単体を `drowsiness_scores` に保存しない。
8. Workerが顔未検出通知をサービス資格情報でBackendへ送信する。Backendは通知Outboxへ永続化してからSignalRで配信し、配信失敗時は再試行する。

   ```json
   {
     "type": "tracking_status",
     "sessionId": "uuid",
     "detectedAt": "2026-06-14T10:00:00Z",
     "status": "face_not_detected"
   }
   ```

9. フロントエンドが通知を受信する。
10. フロントエンドが動画教材を一時停止する。
11. フロントエンドが顔未検出用Popupを表示する。

   ```text
   title: そこにいる？
   content: 顔が検出できません。カメラの状態を確認し、顔と目がしっかり映っているか確認してください！
   ```

12. フロントエンドはContentの下にWebカメラFrameを表示する。
13. 顔未検出用Popupは通常の自動停止通知Popupと同じ表示位置とし、WebカメラFrame分だけHeightを伸ばす。
14. 次に顔が検出できた時点で、Workerが推論とスコア算出を再開する。
15. フロントエンドは正常復帰を確認後、顔検出復帰用の再開可能Popupを表示する。

   ```text
   title: おかえり！
   content: あなたのお顔がよくみえます！再生ボタンを押すと動画が再開します。
   ```

## 6. 期待結果

- 顔未検出時に動画教材が一時停止扱いになる。
- 顔未検出時にTitle「そこにいる？」、Content「顔が検出できません。カメラの状態を確認し、顔と目がしっかり映っているか確認してください！」のPopupが表示される。
- PopupのContent下にWebカメラFrameが表示される。
- 顔検出復帰後、Title「おかえり！」、Content「あなたのお顔がよくみえます！再生ボタンを押すと動画が再開します。」の再開可能Popupが表示される。
- 顔未検出フレームはPERCLOS計算に含まれない。
- 顔未検出フレーム単体は `drowsiness_scores` に保存されない。
- 顔未検出のみでも動画教材は一時停止扱いになる。
- 顔検出が復帰すると推論・スコア算出が再開する。
- Workerの通知投稿失敗はフレームメッセージの再配送対象であり、通知の一時的失敗で解析結果を失わない。

## 7. 例外・分岐

- 顔未検出が長時間継続した場合、顔が検出できるまで一時停止扱いを維持する。
- 眠気スコア通知で `danger` または `shouldPause: true` を受信した場合は、顔未検出とは別に自動停止シナリオへ分岐する。

## 8. 関連データ

- SignalR `tracking_status` 通知
- Worker内部の推論状態
- Redis上のPERCLOSスライディングウィンドウ
