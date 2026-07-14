# 停止・再開イベント記録機能仕様

## 実装優先度

- 優先度: 11
- 理由: 自動停止・再開の履歴を保存し、教員ダッシュボードで確認できるようにするため。

## 1. 機能概要

動画教材の手動停止・自動停止・再開・受講完了時に、フロントエンドがバックエンドへイベントを送信し、PostgreSQLへ保存する機能である。受講完了イベントはセッションの終了時刻も確定する。

## 2. 対象コンポーネント

- フロントエンド
- バックエンド
- PostgreSQL

## 3. トリガー

- 受講者が動画を手動で一時停止した。
- 眠気レベルが危険状態になり、動画が自動停止した。
- 一時停止後、受講者が再生を再開した。
- 動画教材が最後まで再生された。

## 4. API仕様

```http
POST /api/sessions/{sessionId}/playback-events
```

自動停止時:

```json
{
  "type": "auto_pause",
  "occurredAt": "2026-06-14T10:00:00Z",
  "videoTimeSec": 123.45
}
```

受講完了時:

```json
{
  "type": "completed",
  "occurredAt": "2026-06-14T10:02:00Z",
  "videoTimeSec": 600
}
```

`videoTimeSec` は動画教材内の再生位置である。

## 5. 入力制約

`type` は以下を許可する。

```text
manual_pause
auto_pause
resume
completed
```

## 6. 処理仕様

### 6.1 フロントエンド

1. 受講者の手動停止時に `manual_pause`、眠気または顔未検出による停止時に `auto_pause` を送信する。
2. 手動停止または自動停止から実際に再生を再開した時点で `resume` を送信する。初回の再生開始はイベントに記録しない。
3. 動画終了時に `completed` を一度だけ送信する。
4. すべてのイベントに `occurredAt` と `videoTimeSec` を付与する。

### 6.2 バックエンド

1. `student_session` Cookieに結び付いた `sessionId` と一致することを確認する。
2. `type`、`occurredAt`、`videoTimeSec` を検証する。
3. `completed` 以外は `playback_events` に保存する。
4. 最初の `completed` は `playback_events` に保存し、同一トランザクションで `learning_sessions.ended_at` を `occurredAt` に設定する。終了済みセッションへの重複した `completed` は成功として受け入れるが、イベントと終了時刻を追加・更新しない。

## 7. データ保存

```text
playback_events
- event_id
- session_id
- type
- occurred_at
- video_time_sec nullable
```

## 8. 関連機能

- `10-auto-pause-resume.md`
- `14-teacher-dashboard.md`
