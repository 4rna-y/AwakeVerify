# 教員ダッシュボード機能仕様

## 実装優先度

- 優先度: 14
- 理由: 受講セッション、眠気スコア、停止・再開イベントの蓄積後に可視化する後段機能であるため。

## 1. 機能概要

教員が受講状況をセッション単位・学習者単位で確認する機能である。

眠気スコアの時系列グラフと自動停止・再開イベントのタイムラインを表示する。

## 2. 利用者

- 教員

## 3. 対象コンポーネント

- フロントエンド
- バックエンド
- PostgreSQL
- SignalR

## 4. トリガー

教員がログイン後、`/teacher/dashboard` へアクセスする。

## 5. 表示内容

- セッション一覧
- 学籍番号
- セッション開始時刻
- セッション終了時刻
- 最新の眠気レベル
- 眠気スコア時系列グラフ
- 自動停止・再開イベントを重ね合わせたタイムライン

初期表示時はREST APIから過去データを取得し、以後はSignalR通知によりリアルタイム更新する。

## 6. レイアウト

| 領域 | 内容 | 主なコンポーネント |
| --- | --- | --- |
| セッション一覧 | 学籍番号、開始時刻、終了時刻、最新眠気レベル | `Table`, `Badge` |
| フィルタ | 学籍番号、期間、眠気レベル | `Input`, `Select`, `Button` |
| セッション概要 | 選択中セッションの基本情報 | `Card` |
| 眠気スコアグラフ | `score`, `perclos`, `ear` の時系列 | `Chart` |
| 停止・再開タイムライン | `auto_pause`, `resume` の発生位置 | `Card`, `ScrollArea` |

初期表示ではセッション一覧を表示し、セッション選択後に詳細・グラフ・タイムラインを表示する。

## 7. API仕様

### 7.1 セッション一覧

```http
GET /api/dashboard/sessions
```

response:

```json
[
  {
    "sessionId": "uuid",
    "studentId": "string",
    "startedAt": "2026-06-14T10:00:00Z",
    "endedAt": null,
    "latestLevel": "warning"
  }
]
```

### 7.2 セッション詳細

```http
GET /api/dashboard/sessions/{sessionId}
```

response:

```json
{
  "sessionId": "uuid",
  "studentId": "string",
  "startedAt": "2026-06-14T10:00:00Z",
  "endedAt": null
}
```

### 7.3 眠気スコア系列

```http
GET /api/dashboard/sessions/{sessionId}/scores
```

response:

```json
[
  {
    "scoredAt": "2026-06-14T10:00:00Z",
    "score": 0.82,
    "level": "danger",
    "perclos": 0.61,
    "ear": 0.18,
    "pitchDeg": 12.4,
    "yawDeg": 4.2
  }
]
```

### 7.4 停止・再開イベント

```http
GET /api/dashboard/sessions/{sessionId}/playback-events
```

response:

```json
[
  {
    "eventId": "uuid",
    "type": "auto_pause",
    "occurredAt": "2026-06-14T10:00:00Z",
    "videoTimeSec": 123.45
  }
]
```

## 8. リアルタイム更新

SignalR通知により以下をリアルタイム更新する。

- 眠気スコア
- 最新の眠気レベル
- トラッキング状態

## 9. 参照データ

```text
learning_sessions
- session_id
- student_id
- started_at
- ended_at nullable

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

## 10. UI仕様

使用する shadcn/ui コンポーネント:

- `Card`
- `Table`
- `Badge`
- `Tabs`
- `Select`
- `ScrollArea`
- `Separator`
- `Skeleton`
- `Chart`

グラフは shadcn/ui の Chart パターンを使用する。
