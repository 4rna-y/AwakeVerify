# 眠気検知による自動停止と再開シナリオ

## 1. 目的

受講中に眠気スコアが危険状態になった場合、動画教材を自動停止し、眠気レベルが正常に戻った後、受講者の明示操作で再開する流れを定義する。

## 2. アクター

- 受講者
- フロントエンド
- Worker
- Redis
- PostgreSQL
- SignalR
- バックエンド

## 3. 前提条件

- 受講者セッションが開始済みである。
- キャリブレーションが成功済みである。
- 動画教材が再生中である。
- Workerが眠気スコアを算出し、Backend解析結果APIへ送信できる。BackendのOutboxがSignalR通知を配信できる。

## 4. Feature path

1. [`06-face-recognition.md`](../features/06-face-recognition.md)
2. [`07-calibration.md`](../features/07-calibration.md)
3. [`08-drowsiness-scoring.md`](../features/08-drowsiness-scoring.md)
4. [`09-realtime-notification.md`](../features/09-realtime-notification.md)
5. [`10-auto-pause-resume.md`](../features/10-auto-pause-resume.md)
6. [`11-playback-event-recording.md`](../features/11-playback-event-recording.md)

## 5. E2Eフロー

1. Workerが顔ランドマーク推論結果からEAR・Pitch・Yawを算出する。
2. Workerが `EAR_threshold` を用いて閉眼フレームを判定する。
3. WorkerがRedis上の15秒スライディングウィンドウを更新する。
4. WorkerがPERCLOSと眠気スコアを算出する。
5. Workerが以下のいずれかを満たすと自動停止対象と判定する。

   ```text
   level == danger
   または
   score >= 0.75
   ```

6. Workerが `shouldPause: true` を含む眠気スコアをサービス資格情報でBackendへ送信する。Backendがスコアと通知Outboxを同一トランザクションで保存する。
7. BackendのOutboxディスパッチャーがSignalRで通知し、フロントエンドが受信する。SignalR送信失敗時もスコアは失われず、Outboxが再試行する。フロントエンドは `scoredAt` からの経過時間が5秒以下であることを確認する。
8. 鮮度を満たす場合だけ、フロントエンドが動画教材を自動停止する。
9. フロントエンドが動画教材の再生位置を停止判定時点から5秒前へ戻す。巻き戻し後の再生位置が0秒未満になる場合は0秒にする。
10. フロントエンドが自動停止Popupを表示する。Titleは「おきて！」、Contentは「眠っていますか？目が閉じているため、動画を一時停止しています。」とし、scoreなどの数値や詳細メトリクスを表示しない。
11. フロントエンドが再開ボタンを無効化する。
12. フロントエンドがバックエンドへ自動停止イベントを送信する。

   ```http
   POST /api/sessions/{sessionId}/playback-events
   ```

   ```json
   {
     "type": "auto_pause",
     "occurredAt": "2026-06-14T10:00:00Z",
     "videoTimeSec": 123.45
   }
   ```

13. バックエンドが `playback_events` に `auto_pause` を保存する。
14. Workerが継続して眠気スコアを算出する。
15. 眠気レベルが `normal` に戻る。
16. フロントエンドが再開ボタンを有効化し、再開可能Popupを表示する。Titleは「おはよう！」、Contentは「起きていることが確認できました。再生ボタンを押すと再開します。」とする。
17. 再開可能Popup表示中に眠気レベルが再度 `danger` になった場合、フロントエンドは再開ボタンを無効化し、自動停止Popupへ戻す。
18. 受講者が再開ボタンを押す。
19. フロントエンドが動画教材を巻き戻し後の再生位置から再開する。
20. フロントエンドがバックエンドへ再開イベントを送信する。

   ```json
   {
     "type": "resume",
     "occurredAt": "2026-06-14T10:02:00Z",
     "videoTimeSec": 123.45
   }
   ```

21. バックエンドが `playback_events` に `resume` を保存する。

## 6. 期待結果

- 眠気レベルが危険状態になった場合、動画が自動停止し、停止判定時点から5秒前へ巻き戻る。
- `normal` に戻るまで再開ボタンは無効化される。
- 自動停止PopupにはTitle「おきて！」、Content「眠っていますか？目が閉じているため、動画を一時停止しています。」が表示され、scoreなどの数値や詳細メトリクスは表示されない。
- `normal` 復帰後、再開可能PopupにはTitle「おはよう！」、Content「起きていることが確認できました。再生ボタンを押すと再開します。」が表示され、受講者が明示的に再開操作した場合のみ動画が再開する。
- 再開可能Popup表示中に再度 `danger` になった場合、再開不可の自動停止状態へ戻る。
- 自動停止と再開のイベントがPostgreSQLに保存される。

## 7. 例外・分岐

- 顔未検出のみの場合も、閉眼時と同様に動画を一時停止扱いにし、顔未検出用Popupを表示する。
- SignalR通知が5秒を超えて遅延した場合、フロントエンドはその通知で動画制御または再開可否を変更せず、最後に鮮度を満たして受信した眠気レベルに基づいてUI状態を維持する。ダッシュボードはREST再取得で永続化済みスコアへ収束する。
- WorkerのBackend結果投稿が一時失敗した場合は、Workerがフレームメッセージを完了せず再配送する。入力・認可エラーはdead-letterする。
- イベント記録APIが失敗した場合でも、動画制御自体はフロントエンドで実行済みの状態を維持する。

## 8. 関連データ

```text
drowsiness_scores
- session_id
- scored_at
- score
- level
- perclos
- ear
- pitch_deg
- yaw_deg

playback_events
- event_id
- session_id
- type
- occurred_at
- video_time_sec nullable
```
