# バックエンド仕様書

## 1. 目的

本仕様書は、オンデマンドビデオ教材受講完了検証システムにおけるバックエンドの仕様を定義する。

バックエンドは、受講セッション管理、認証、WebSocket映像受信、Blob Storage保存、Service Bus投入、PostgreSQL記録、SignalR配信、教員ダッシュボード向けAPIを担う。

## 2. 根拠

本仕様は `docs/proposal.md` を根拠とし、企画書に明記されていない事項はユーザー承認済みの仕様決定に基づく。

### 2.1 proposal.md に基づく事項

- バックエンド技術は ASP.NET Core / WebSocket とする。
- Azure App Service 上で動作する。
- フロントエンドからWebSocket経由で映像データを受信する。
- 受信データをBlob Storageへ保存する。
- Blob参照情報をService Busへエンキューする。
- Workerの推論完了を待たず、非同期処理する。
- 眠気スコアと自動停止イベントをPostgreSQLへ保存する。
- Azure SignalR Serviceを用いてリアルタイム通知する。

### 2.2 承認済み仕様決定

- 受講者は学籍番号のみでセッション開始する。
- 教員は教員IDとパスワードでログインする。
- 教員アカウントは管理者ページから追加する。
- バックエンドは受講ごとに `sessionId` を発行する。
- WebSocketではI/Pフレームを1フレームずつ受信する。
- Iフレーム間隔は1秒、Iフレーム間はPフレームのみ、Bフレームは使用しない。
- Service Busでは `sessionId` をSession IDとして利用し、同一セッション内の順序処理を保証する。
- 停止・再開イベントはフロントエンドからAPIで受信し、PostgreSQLへ保存する。

## 3. システム内の責務

バックエンドの責務は以下である。

- 受講セッションの作成
- 受講者の学籍番号管理
- 教員ログイン認証
- 管理者による教員アカウント追加
- WebSocketによる映像フレーム受信
- Blob Storageへの映像フレーム保存
- Service Busへのフレーム参照メッセージ投入
- 停止・再開イベント保存
- ダッシュボード向けREST API提供
- SignalR配信基盤との接続

## 4. 認証・アカウント仕様

### 4.1 受講者

受講者は学籍番号のみでセッションを開始する。

受講者にはパスワードを設定しない。

### 4.2 教員

教員は教員IDとパスワードでログインする。

パスワードは平文保存せず、ハッシュ化して保存する。

### 4.3 管理者

管理者は管理者ページから教員アカウントを追加する。

管理者自身もIDとパスワードで認証される前提とする。

## 5. REST API仕様

## 5.1 セッション開始API

```http
POST /api/sessions
```

request:

```json
{
  "studentId": "string"
}
```

response:

```json
{
  "sessionId": "uuid"
}
```

処理:

1. `studentId` を受け取る。
2. `students` に存在しない場合は作成する。
3. `learning_sessions` に新規セッションを作成する。
4. `sessionId` を返却する。

### 5.2 停止・再開イベント記録API

```http
POST /api/sessions/{sessionId}/playback-events
```

request:

```json
{
  "type": "auto_pause",
  "occurredAt": "2026-06-14T10:00:00Z",
  "videoTimeSec": 123.45
}
```

`type` は以下を許可する。

```text
auto_pause
resume
```

処理:

1. `sessionId` の存在を確認する。
2. `type` を検証する。
3. `playback_events` に保存する。

### 5.3 教員ログインAPI

```http
POST /api/teacher/login
```

request:

```json
{
  "teacherId": "string",
  "password": "string"
}
```

response:

```json
{
  "success": true
}
```

認証方式の具体的なセッション管理またはトークン方式は実装設計で定義する。

### 5.4 教員アカウント追加API

```http
POST /api/admin/teachers
```

request:

```json
{
  "teacherId": "string",
  "password": "string"
}
```

処理:

1. 管理者認証を確認する。
2. `teacherId` の重複を確認する。
3. パスワードをハッシュ化する。
4. `teachers` に保存する。

## 6. WebSocket映像受信仕様

### 6.1 接続先

```text
/ws/sessions/{sessionId}/frames
```

### 6.2 受信方式

フロントエンドから、エンコード済み映像フレームを1フレームずつ受信する。

仕様:

- 1 WebSocketメッセージ = 1 エンコード済み映像フレーム
- 640×480 / 5fps相当
- Iフレーム間隔は1秒
- Iフレーム間はPフレームのみ
- Bフレームは使用しない

### 6.3 フレームメタデータ

各フレームは以下のメタデータを持つ。

```json
{
  "sessionId": "uuid",
  "sequenceNo": 1,
  "frameType": "I",
  "baseIFrameSequenceNo": 1,
  "capturedAt": "2026-06-14T10:00:00.000Z",
  "codec": "TBD"
}
```

Pフレームの場合:

```json
{
  "sessionId": "uuid",
  "sequenceNo": 2,
  "frameType": "P",
  "baseIFrameSequenceNo": 1,
  "capturedAt": "2026-06-14T10:00:00.200Z",
  "codec": "TBD"
}
```

`receivedAt` はバックエンド受信時刻として付与する。

## 7. Blob Storage保存仕様

### 7.1 保存対象

以下をBlob Storageへ保存する。

- Iフレーム
- Pフレーム

Blob本体はエンコード済みフレームのバイナリである。

### 7.2 パス形式

```text
sessions/{sessionId}/frames/{sequenceNo}_{frameType}.bin
```

例:

```text
sessions/3f8c.../frames/000001_I.bin
sessions/3f8c.../frames/000002_P.bin
sessions/3f8c.../frames/000003_P.bin
```

### 7.3 保存期間

Blob Storage上の映像フレーム保存期間・削除方針はTBDとする。

## 8. Service Bus投入仕様

Blob Storageへの保存完了後、Service Busへフレーム参照情報を投入する。

### 8.1 メッセージ形式

```json
{
  "sessionId": "uuid",
  "sequenceNo": 1,
  "frameType": "I",
  "baseIFrameSequenceNo": 1,
  "blobPath": "sessions/3f8c.../frames/000001_I.bin",
  "capturedAt": "2026-06-14T10:00:00.000Z",
  "receivedAt": "2026-06-14T10:00:00.050Z",
  "codec": "TBD"
}
```

### 8.2 Session ID

Service Busでは、`sessionId` をSession IDとして設定する。

目的:

- 同一受講セッション内のフレーム順序を保証する。
- WorkerがI/Pフレームを順次デコードできるようにする。

## 9. PostgreSQL保存仕様

### 9.1 テーブル構成

```text
students
- student_id
- created_at

learning_sessions
- session_id
- student_id
- started_at
- ended_at nullable

calibrations
- session_id
- ear_open
- ear_threshold
- calibrated_at

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

teachers
- teacher_id
- password_hash
- created_at
- created_by_admin_id nullable

admins
- admin_id
- password_hash
- created_at
```

### 9.2 補足

- 受講者は学籍番号のみのため、`students` にパスワードは持たせない。
- 教員・管理者のパスワードは `password_hash` として保存する。
- `learning_sessions` は同じ受講者の複数回受講を区別する。
- `drowsiness_scores` は1秒単位の保存結果である。
- `playback_events` は `auto_pause` / `resume` を保存する。

## 10. SignalR配信仕様

Workerが算出した眠気スコア、およびトラッキング状態をAzure SignalR Service経由で配信する。

バックエンドはSignalRの接続・配信基盤を提供する。

### 10.1 眠気スコア通知

```json
{
  "type": "drowsiness_score",
  "sessionId": "uuid",
  "scoredAt": "2026-06-14T10:00:00Z",
  "score": 0.82,
  "level": "danger",
  "perclos": 0.61,
  "ear": 0.18,
  "pitchDeg": 12.4,
  "yawDeg": 4.2,
  "shouldPause": true
}
```

### 10.2 顔未検出通知

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

## 11. ダッシュボード取得API

### 11.1 セッション一覧

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

### 11.2 セッション詳細

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

### 11.3 眠気スコア系列

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

### 11.4 停止・再開イベント

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

## 12. 未決定事項

以下は本仕様では未決定とする。

- 教員・管理者ログイン後の具体的なセッション管理方式またはトークン方式
- WebSocketメッセージ内でのメタデータとバイナリ本体の梱包方式
- エンコード済みフレームの具体的な `codec`
- Blob Storage上の映像フレーム保存期間・削除方針
