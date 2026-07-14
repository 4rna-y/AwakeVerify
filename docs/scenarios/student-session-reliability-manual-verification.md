# 受講者セッション信頼性の手動統合確認手順

対象シナリオ:

- [`student-learning-happy-path.md`](./student-learning-happy-path.md)
- [`calibration-retry.md`](./calibration-retry.md)
- [`drowsiness-auto-pause-resume.md`](./drowsiness-auto-pause-resume.md)
- [`face-not-detected-warning.md`](./face-not-detected-warning.md)

## 前提

- devcontainerのPostgreSQL、Redis、Azurite、Azure Service Bus Emulatorを起動する。
- Backend、Worker、Frontendを起動する。接続文字列、`WORKER_API_KEY`、動画URL、MediaPipeモデルの値は環境変数またはdevcontainer設定から供給し、手順書へ秘密値を記載しない。
- ブラウザでカメラを許可し、開発者ツールのConsoleとNetwork（WebSocket／SignalR）を開く。
- 受講開始前に、Backendの`/health/ready`とWorkerの`/health`が成功することを確認する。Backendの`/health/live`は依存サービス障害時にもprocess応答だけを確認するため、受講開始判定には使用しない。

## 正常受講とキャリブレーション失敗→再試行

1. `/student`で学籍番号を入力し、`/student/session`へ遷移する。
2. Backend／Worker接続確認、WebSocket、SignalRがそれぞれ「接続済み」になり、キャリブレーション開始ボタンが有効になることを確認する。
3. 顔を正面から外した状態で開始する。失敗通知と指定の失敗文言が表示され、動画が再生されないことを確認する。
4. カメラ位置と顔の向きを調整して再度開始する。Workerの`succeeded`通知を受信後にだけキャリブレーションPopupが閉じ、動画が再生されることを確認する。
5. WebSocketの送信メッセージが `sessionId`、増加する `sequenceNo`、UTCの `capturedAt`、0以上の有限値である `videoTimeSec`、`codec: image/jpeg`、`payloadBase64` を含み、各payloadが単独でデコード可能なJPEGであることを確認する。キャリブレーション再試行で`sequenceNo`が1へ戻らないことも確認する。

## 再生状態・受講完了イベント

1. キャリブレーション後に動画を再生し、再生ボタンで手動停止する。`POST /api/sessions/{sessionId}/playback-events` のrequest bodyに `type: manual_pause` と停止位置が送信され、`playback_events` に保存されることを確認する。
2. 手動停止後に再生を再開する。実際の動画再生開始時に `type: resume` が一度だけ送信・保存されることを確認する。初回の再生開始では `resume` が送信されないことも確認する。
3. 眠気または顔未検出による自動停止・再開では、従来どおり `auto_pause` と `resume` が送信・保存されることを確認する。
4. 動画教材を最後まで再生する。`type: completed` が一度だけ送信され、`learning_sessions.ended_at` に同じ完了時刻が保存されることを確認する。
5. 管理者ダッシュボードを再取得し、完了したセッションの終了欄に「受講中」ではなく終了時刻が表示されることを確認する。

## 顔未検出→復帰

1. 正常受講中にカメラを覆う、または顔を画角外へ移動する。
2. `tracking_status: face_not_detected`受信後、動画が停止し、Title「そこにいる？」、指定のContent、Content下のカメラFrameが表示されることを確認する。
3. 顔を画角へ戻し、正常通知を受信するまで再生ボタンが無効であることを確認する。
4. Title「おかえり！」の再開可能Popupで再生ボタンを押し、動画が再開することを確認する。Backendの`playback_events`にこの停止・再開が各1件記録されることを確認する。

## danger→自動停止→normal→手動再開

1. 正常受講中にWorkerのテスト入力または検証用経路で`level: danger`または`shouldPause: true`を通知する。
2. 動画が通知時点から5秒戻って停止し、Title「おきて！」と指定のContentが表示されることを確認する。Popupにscore、EAR、Pitch、Yaw、PERCLOSなどが表示されないことを確認する。
3. `normal`通知まで再生ボタンが無効であることを確認する。
4. Title「おはよう！」の再開可能Popupで一度だけ再生ボタンを押す。動画が再開し、`playback_events`に`auto_pause`と`resume`が各1件だけ保存されることを確認する。
5. 再開可能Popup中に再度`danger`を通知し、手動再開前に再び停止状態へ戻ることを確認する。

## WebSocket／SignalR切断・再接続

1. キャリブレーション前にBackendを停止する。WebSocketが0.5、1、2、4秒間隔で最大5回試行され、5回目の失敗後にエラーDialogが表示されることを確認する。動画再生とカメラFrame送信は開始されない。
2. エラーDialogの「再試行」を押し、Backendを復旧すると接続できることを確認する。キャリブレーション成功前に動画が再生されないことを確認する。
3. 受講中にWebSocket接続を切断する。再接続中に動画が停止し、再接続成功後に送信が再開することを確認する。再接続を5回失敗させた場合は動画が継続せず、エラーDialogから復旧できることを確認する。
4. SignalRを切断し、画面の解析イベント接続状態が「接続中」から「エラー」へ遷移することを確認する。キャリブレーション開始または動画再開が有効にならず、受講中であれば動画とFrame送信が停止することを確認する。
5. SignalRを復旧して「再接続」を押す。接続済みになった後、Hubの`JoinSession(sessionId)`が再実行され、正しいセッションの解析通知を受信できることを確認する。

## 記録

各ケースについて、実施日時、commit、使用したブラウザ、Backend／Workerのログ、WebSocket close code、SignalR接続状態、DBで確認したイベント件数を記録する。外部Azure SignalR、実カメラ、Service Bus Emulatorの挙動は実行環境に依存するため、未実施の場合は「未検証」と明記する。
