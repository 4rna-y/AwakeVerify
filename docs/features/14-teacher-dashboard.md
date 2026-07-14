# 管理者ダッシュボード機能仕様

## 実装優先度

- 優先度: 14
- 理由: 受講セッション、眠気スコア、停止・再開イベントの蓄積後に可視化する後段機能であるため。

## 1. 機能概要

管理者が受講状況を動画単位・セッション単位・学習者単位で確認・管理する機能である。

眠気スコアの時系列グラフと自動停止・再開イベントのタイムラインを表示する。

## 2. 利用者

- 管理者

## 3. 対象コンポーネント

- フロントエンド
- バックエンド
- PostgreSQL
- SignalR

## 4. トリガー

管理者がログイン後、`/admin/dashboard` へアクセスする。セッションを選択すると `/admin/dashboard/sessions/{sessionId}` のセッション詳細ページへ遷移する。旧 `/teacher/dashboard` は `/admin/dashboard` へリダイレクトする。

## 5. 表示内容

- 動画IDごとのセッション一覧
- 学籍番号
- セッション開始時刻
- セッション終了時刻
- 眠気スコア時系列グラフ
- 自動停止区間を重ね合わせた眠気スコアグラフ

初期表示時はREST APIから過去データを取得し、以後はSignalR通知によりリアルタイム更新する。

## 6. レイアウト

| 領域 | 内容 | 主なコンポーネント |
| --- | --- | --- |
| セッション一覧 | 動画ID、学籍番号、開始時刻、終了時刻、詳細ページへの遷移、削除操作 | `Table`, `Button` |
| フィルタ | 動画ID、学籍番号、期間、眠気レベル | `Input`, `Select`, `Button` |
| セッション詳細ページ | 選択したセッションの基本情報 | `Card` |
| 眠気スコアグラフ | `score` の時系列を常時表示し、`perclos` と `ear` は表示を切り替えられる。縦軸は値、横軸は観測時刻と動画再生位置（秒）の二軸を示す。PERCLOS は個人別 `EAR_threshold` に基づく閉眼判定から算出し、EAR 表示時は `EAR_open` と `EAR_threshold` の基準線を重ねる。表示中の `score`、`perclos`、`ear` の各線へのホバーで観測時刻・動画再生位置・レベル・各数値・EAR基準をツールチップ表示する。`videoTimeSec` が `null` の既存スコアでは動画再生位置を `—` と表示する。フレーム番号は表示しない。 | `Chart`, `Checkbox` |

| スコアタイムライン | 各スコアを次の観測時刻までの区間として表示し、`normal`、`caution`、`warning`、`danger` をレベルごとの色で示す。スコア・イベントを表形式で列挙しない。 | `Chart` |

`/admin/dashboard` の初期表示ではセッション一覧を表示する。セッション選択後は `/admin/dashboard/sessions/{sessionId}` へ遷移し、詳細・グラフ・スコアタイムラインを表示する。

## 7. API仕様

以下の全APIは有効な `admin` roleを必須とする。`adminId` をquery、path、request bodyで指定して認可してはならない。未認証は `401`、管理者以外は `403`、存在しない `sessionId` は `404` を返す。取得結果の唯一の参照元はBackend所有のPostgreSQLであり、WorkerやRedisを直接参照しない。

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
    "videoId": "string",
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
  "videoId": "string",
  "startedAt": "2026-06-14T10:00:00Z",
  "endedAt": null
}
```

### 7.3 セッション削除

```http
DELETE /api/dashboard/sessions/{sessionId}
```

管理者だけが実行できる。削除時は対象セッション、眠気スコア、停止・再開イベント、キャリブレーション、未配信の解析イベント、および当該受講者セッション用の認証情報を削除する。成功時は `204`、存在しない `sessionId` は `404` を返す。削除は取り消せないため、フロントエンドは対象の動画ID・学籍番号を明示して確認操作を求める。

### 7.4 眠気スコア系列

```http
GET /api/dashboard/sessions/{sessionId}/scores
```

response:

```json
[
  {
    "scoredAt": "2026-06-14T10:00:00Z",
    "videoTimeSec": 123.45,
    "score": 0.82,
    "level": "danger",
    "perclos": 0.61,
    "ear": 0.18,
    "pitchDeg": 12.4,
    "yawDeg": 4.2
  }
]
```

スコアAPIはすべての行で `videoTimeSec` プロパティを返す。新規スコアでは0以上の有限値、既存スコアでは `null` を返す。

### 7.5 停止・再開イベント

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

## 9. 参照データと整合性

```text
learning_sessions
- session_id
- student_id
- video_id
- started_at
- ended_at nullable

drowsiness_scores
- session_id
- source_sequence_no
- scored_at
- video_time_sec nullable（既存スコアは `null`、新規スコアは必須）
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

スコア行は `(session_id, source_sequence_no)` により一意であり、同一UTC秒の重複は許可しない。初期REST取得は永続化済みデータを返す。リアルタイム通知の欠落・再接続時は、一覧と選択中詳細を再取得して整合させる。削除済みセッションは一覧・詳細・通知対象から除外する。

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

グラフは shadcn/ui の Chart パターンを使用する。`score` は常時表示し、`PERCLOS` と `EAR` は初期非表示の `Checkbox` による任意表示とする。PERCLOS は保存済みキャリブレーションの `EAR_threshold` による閉眼判定を反映した値であり、`PERCLOS` または `EAR` 表示時にその閾値を明示する。EAR 表示時は `EAR_open` と `EAR_threshold` の破線基準を重ねる。横軸は観測時刻と動画再生位置（秒）を併記する二軸とし、FPSは契約に含まれないためフレーム番号を表示・算出しない。スコア線へホバーした場合は、当該観測時刻、動画再生位置（`videoTimeSec` が `null` の場合は `—`）、眠気レベル、`score`、`PERCLOS`、`EAR`、EAR基準をツールチップに表示する。停止区間は `auto_pause` と次の `resume` を対応付けてチャート背景に表示する。「スコアタイムライン」は各スコアのレベルを `normal`（緑）、`caution`（黄）、`warning`（橙）、`danger`（赤）で表示する。
