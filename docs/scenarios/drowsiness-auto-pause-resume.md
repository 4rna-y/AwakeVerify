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
- Workerが眠気スコアを算出し、SignalRで通知できる。

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

6. Workerが `shouldPause: true` を含む眠気スコア通知をSignalRで送信する。
7. フロントエンドが通知を受信する。
8. フロントエンドが動画教材を自動停止する。
9. フロントエンドが自動停止メッセージを表示する。
10. フロントエンドが再開ボタンを無効化する。
11. フロントエンドがバックエンドへ自動停止イベントを送信する。

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

12. バックエンドが `playback_events` に `auto_pause` を保存する。
13. Workerが継続して眠気スコアを算出する。
14. 眠気レベルが `normal` に戻る。
15. フロントエンドが再開ボタンを有効化し、再開可能メッセージを表示する。
16. 受講者が再開ボタンを押す。
17. フロントエンドが動画教材を再開する。
18. フロントエンドがバックエンドへ再開イベントを送信する。

   ```json
   {
     "type": "resume",
     "occurredAt": "2026-06-14T10:02:00Z",
     "videoTimeSec": 123.45
   }
   ```

19. バックエンドが `playback_events` に `resume` を保存する。

## 6. 期待結果

- 眠気レベルが危険状態になった場合、動画が自動停止する。
- `normal` に戻るまで再開ボタンは無効化される。
- `normal` 復帰後、受講者が明示的に再開操作した場合のみ動画が再開する。
- 自動停止と再開のイベントがPostgreSQLに保存される。

## 7. 例外・分岐

- 顔未検出のみの場合は自動停止しない。
- SignalR通知が遅延した場合、フロントエンドは最後に受信した眠気レベルに基づいてUI状態を維持する。
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
