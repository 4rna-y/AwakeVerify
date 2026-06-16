# 停止・再開イベント記録機能仕様

## 実装優先度

- 優先度: 11
- 理由: 自動停止・再開の履歴を保存し、教員ダッシュボードで確認できるようにするため。

## 1. 機能概要

動画教材の自動停止時と再開時に、フロントエンドがバックエンドへイベントを送信し、PostgreSQLへ保存する機能である。

## 2. 対象コンポーネント

- フロントエンド
- バックエンド
- PostgreSQL

## 3. トリガー

- 眠気レベルが危険状態になり、動画が自動停止した。
- 眠気レベルが正常に戻り、受講者が再開ボタンを押した。

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

再開時:

```json
{
  "type": "resume",
  "occurredAt": "2026-06-14T10:02:00Z",
  "videoTimeSec": 123.45
}
```

`videoTimeSec` は動画教材内の再生位置である。

## 5. 入力制約

`type` は以下を許可する。

```text
auto_pause
resume
```

## 6. 処理仕様

### 6.1 フロントエンド

1. 自動停止時に `auto_pause` イベントを送信する。
2. 再開時に `resume` イベントを送信する。
3. `occurredAt` と `videoTimeSec` を付与する。

### 6.2 バックエンド

1. `sessionId` の存在を確認する。
2. `type` を検証する。
3. `playback_events` に保存する。

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
