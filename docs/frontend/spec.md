# フロントエンド仕様書

## 1. 目的

本仕様書は、オンデマンドビデオ教材受講完了検証システムにおけるフロントエンドの仕様を定義する。

フロントエンドは、受講者向け画面と教員・管理者向け画面を提供し、Webカメラ映像の取得、動画教材の再生制御、眠気状態のリアルタイム表示、教員ダッシュボード表示を担う。

## 2. 根拠

本仕様は `docs/proposal.md` を根拠とし、企画書に明記されていない事項はユーザー承認済みの仕様決定に基づく。

### 2.1 proposal.md に基づく事項

- フロントエンド技術は Next.js / TypeScript とする。
- Webカメラ映像を取得する。
- 映像は 640×480 / 5fps 相当で扱う。
- App Service へ WebSocket で映像データを送信する。
- SignalR で眠気レベルを受信する。
- 眠気レベルが `danger` の場合、動画を自動停止する。
- `normal` に戻るまで再開ボタンを無効化する。
- 教員・管理者向けダッシュボードでは、眠気スコアの時系列グラフと自動停止区間のタイムラインを表示する。

### 2.2 承認済み仕様決定

- 受講者は学籍番号のみでログイン / セッション開始する。
- 教員ダッシュボードは教員IDとパスワードでログインする。
- 教員ID・パスワードの追加は管理者ページから行う。
- 受講セッションごとにバックエンドが `sessionId` を発行する。
- WebSocketではI/Pフレームを1フレームずつ送信する。
- Iフレーム間隔は1秒とする。
- Iフレーム間はPフレームのみを使用し、Bフレームは使用しない。
- 停止・再開イベントはフロントエンドからバックエンドAPIへ送信する。
- キャリブレーション成功前は動画再生を開始しない。
- 顔未検出時は閉眼時と同様に動画を一時停止し、WebカメラFrame付きPopupでユーザーにカメラ状態確認を促す。
- リアルタイム通知の最終仕様はSignalRとする。受講者画面は `@microsoft/signalr` の `HubConnection` で Backend の `AnalysisEventsHub`（`/hubs/analysis-events`）に接続し、`JoinSession(sessionId)` で該当セッションのGroupへ参加して通知を受信する。
- UIコンポーネントは shadcn/ui を使用する。
- shadcn/ui のスタイル変更は、配置と大きさに関する変更のみ許可する。

## 3. 画面構成

### 3.1 受講者画面

受講者画面は以下の順で表示する。

1. Loginページ (`/`, `/student`)
   - 画面中央にモーダルを表示する。
   - 初期状態は生徒ログインを主表示とし、学籍番号入力とログインボタンを表示する。
   - ログインボタン下のLinkTextButtonにより、同一モーダル内で教員ログインへ切り替える。
   - セッション開始後、`sessionId` を同一ブラウザタブ内の受講中状態として保持し、`/student/session` へ遷移する。
2. 動画再生ページ (`/student/session`)
   - 画面全面に動画Frameを配置する。
   - 動画教材はAzure Blob Storageから配信される動画URLを `<video>` の `src` として読み込む。
   - ローカル開発ではAzuriteのBlob URLを使用し、Azureからデリバリされる動作を再現する。
   - 画面上部をHeaderとし、左上に動画ファイル名、右上に受講者IDとカメラ送信状態のBadgeを表示する。
   - Header右上のBadge群にマウスホバーした場合のみ、直近のscoreとlevelを追加表示する。
   - 画面下部をFooterとし、再生スライダー、再生ボタン、再生時間をFloat表示する。
   - HeaderとFooterの背景は、動画視聴を妨げない半透明の黒とする。
   - 3秒間マウス、タッチ、キーボード操作がない場合、HeaderとFooterを150msでfade-outして非表示にする。
   - HeaderとFooterが非表示の状態でマウス、タッチ、キーボード操作があった場合、150msでfade-inして表示する。
3. キャリブレーションモーダル
   - Loginページから `/student/session` へ遷移した直後に表示する。
   - モーダル内にカメラ画角を表示する。
   - 開始ボタン押下後、5秒間キャリブレーション指示と進捗を表示する。
   - キャリブレーション終了後にモーダルを閉じ、動画再生とカメラ画角画像の送信を開始する。

受講者画面は以下の機能を提供する。

- 学籍番号入力
- セッション開始
- Webカメラ使用許可の取得
- キャリブレーション状態表示
- 動画教材プレーヤー
- 現在の眠気レベル表示
- 顔未検出などのトラッキング状態表示
- 自動停止時のメッセージ表示
- 再開ボタン制御

### 3.2 教員ログイン画面

教員ログイン画面は、教員IDとパスワードによるログインを提供する。

入力項目:

- 教員ID
- パスワード

認証成功後、教員ダッシュボードへ遷移する。

### 3.3 教員ダッシュボード

教員ダッシュボードは、受講状況をセッション単位・学習者単位で確認するための画面である。

表示内容:

- セッション一覧
- 学籍番号
- セッション開始時刻
- セッション終了時刻
- 最新の眠気レベル
- 眠気スコア時系列グラフ
- 自動停止・再開イベントを重ね合わせたタイムライン

初期表示時はREST APIから過去データを取得し、以後はSignalR通知によりリアルタイム更新する。

### 3.4 管理者ページ

管理者ページは、教員アカウントを追加するための画面である。

機能:

- 教員IDの追加
- 教員パスワードの設定

パスワードはフロントエンド上で平文保存しない。バックエンドへ送信後、バックエンドでハッシュ化して保存する。

### 3.5 ルーティング

フロントエンドは以下のルーティングを提供する。

| パス | 対象 | 目的 |
| --- | --- | --- |
| `/` | 受講者 | 案内ページを挟まず、学籍番号入力のLoginモーダルを直接表示する |
| `/student` | 受講者 | 学籍番号入力、セッション開始 |
| `/student/session` | 受講者 | キャリブレーション、動画受講 |
| `/test` | 開発・検証 | カメラフレームをBackendへ送信し、Worker解析結果をBackend経由で確認する |
| `/teacher/login` | 教員 | 教員ログイン |
| `/teacher/dashboard` | 教員 | セッション一覧、セッション詳細、グラフ確認 |
| `/admin/teachers` | 管理者 | 教員アカウント追加 |

未認証状態で教員・管理者向けページへアクセスした場合は、ログイン画面へ遷移する。

### 3.6 shadcn/ui 使用方針

画面上の汎用UIは shadcn/ui のコンポーネントを使用する。

例外として、以下はHTML標準要素またはブラウザAPI連携用の専用実装を許可する。

- 動画教材再生用の `<video>`
- Webカメラプレビュー用の `<video>` または `<canvas>`
- WebSocket / SignalR / MediaStream 制御に必要な非表示要素

#### 3.6.1 スタイル変更制約

shadcn/ui のスタイルは、以下を除き変更しない。

許可する変更:

- 配置: `flex`, `grid`, `gap`, `space-*`, `margin`, `position`, `inset`, `z-index`, `order`, レスポンシブ配置
- 配置補助: ページ全体、セクション、カード内の領域分割に限る `padding`
- 大きさ: `width`, `height`, `min-*`, `max-*`, `aspect-*`, `overflow`, コンテナ幅、動画・グラフ・表の表示領域サイズ

禁止する変更:

- 色、背景色、文字色、テーマカラー
- フォントファミリー、文字サイズ、文字太さ、行間
- border、角丸、影、透明度
- hover / focus / active などの状態スタイル
- アニメーション、トランジション
- shadcn/ui 生成コンポーネント内部の `className`、`variant` 定義、CSS変数、テーマトークンの変更
- shadcn/ui コンポーネントの見た目を変える目的での `style` 属性直接指定

shadcn/ui が標準提供する `variant` と `size` prop は使用してよい。ただし、独自 `variant` の追加や既存 `variant` の見た目変更は禁止する。

コンポーネント利用箇所で `className` を指定する場合も、配置または大きさの調整に限定する。例: `w-full`, `max-w-*`, `grid`, `flex`, `gap-*`。

#### 3.6.2 画面別使用コンポーネント

| 画面 | 使用する shadcn/ui コンポーネント | 備考 |
| --- | --- | --- |
| 受講者画面 | `Card`, `Form`, `Input`, `Button`, `Alert`, `Badge`, `Progress`, `Separator`, `Skeleton` | 動画教材とカメラプレビュー自体は標準HTML要素を使用する。 |
| 教員ログイン画面 | `Card`, `Form`, `Input`, `Button`, `Alert` | パスワード入力は `Input type="password"` とする。 |
| 教員ダッシュボード | `Card`, `Table`, `Badge`, `Tabs`, `Select`, `ScrollArea`, `Separator`, `Skeleton`, `Chart` | グラフは shadcn/ui の Chart パターンを使用する。 |
| 管理者ページ | `Card`, `Form`, `Input`, `Button`, `Table`, `Dialog`, `Alert` | 教員追加確認やエラー表示に使用する。 |

#### 3.6.3 共通UI状態

| 状態 | 表示仕様 | 主なコンポーネント |
| --- | --- | --- |
| 読み込み中 | 対象領域にプレースホルダーを表示する。 | `Skeleton` |
| 入力エラー | フォーム項目直下にエラーメッセージを表示する。 | `FormMessage` |
| API / 通信エラー | 画面上部または対象カード内にエラーを表示する。 | `Alert` |
| 操作不可 | ボタンを `disabled` にする。 | `Button` |
| 状態ラベル | 眠気レベル、接続状態、セッション状態をラベル表示する。 | `Badge` |

### 3.7 動画教材配信

動画教材は、フロントエンドの静的ファイルとして同梱せず、Azure Blob Storageから配信する。

フロントエンドは環境変数 `NEXT_PUBLIC_LESSON_VIDEO_URL` で指定されたURLを動画教材URLとして使用する。

ローカル開発ではAzuriteをAzure Blob Storageの代替として使用し、例として以下のURLを指定する。

```text
http://127.0.0.1:10000/devstoreaccount1/lesson-videos/sample.mp4
```

想定するBlob container:

```text
lesson-videos
```

Webカメラから送信されたフレーム保存用のBlob containerとは分離する。

```text
frames          # Webカメラフレーム保存用
lesson-videos   # 動画教材配信用
```

## 4. 受講者ログイン / セッション開始

受講者は学籍番号を入力してセッションを開始する。

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

フロントエンドは取得した `sessionId` を同一ブラウザタブ内の受講中状態として保持し、`/student/session` へ遷移する。

`/student/session` は保持した `sessionId` を、以下に使用する。

- WebSocket接続
- SignalR購読
- 停止・再開イベント送信
- 受講中状態管理

## 5. Webカメラ取得仕様

### 5.1 入力

Webカメラから以下の条件で映像を取得する。

```text
解像度: 640×480
フレームレート: 5fps相当
```

### 5.2 キャリブレーション前制御

セッション開始後、Worker解析結果に基づくキャリブレーションを実施する。

キャリブレーション開始前に、フロントエンドはBackendとWorkerが起動しているかを確認する。

BackendとWorkerの起動確認に成功した場合のみ、`/ws/sessions/{sessionId}/frames` と解析結果イベント購読を接続し、キャリブレーション用のカメラフレーム送信を開始する。

Workerから `calibration_status: succeeded` を受信するまで、動画教材の再生を開始しない。

キャリブレーション失敗時は、受講者に再キャリブレーションを促す。

表示例:

```text
顔を正面に向けてください。キャリブレーション中です。
```

失敗時表示例:

```text
キャリブレーションに失敗しました。顔が正面から映るようにカメラ位置を調整してください。
```

## 6. WebSocket映像送信仕様

### 6.1 接続先

```text
/ws/sessions/{sessionId}/frames
```

### 6.2 送信方式

WebSocketでは、エンコード済み映像フレームを1フレームずつ送信する。

```text
0.0s  I
0.2s  P
0.4s  P
0.6s  P
0.8s  P
1.0s  I
1.2s  P
...
```

仕様:

- 1 WebSocketメッセージ = 1 エンコード済み映像フレーム
- 640×480 / 5fps相当
- Iフレーム間隔は1秒
- Iフレーム間はPフレームのみ
- Bフレームは使用しない
- IフレームはGOP先頭のキーフレームとして扱う

### 6.3 メタデータ

各フレームには以下のメタデータを付与する。

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

現行実装の `codec` は `image/jpeg` とする。

WebSocketメッセージは、メタデータとフレームバイナリBase64を含むJSONとして送信する。

```json
{
  "sessionId": "uuid",
  "sequenceNo": 1,
  "frameType": "I",
  "baseIFrameSequenceNo": 1,
  "capturedAt": "2026-06-14T10:00:00.000Z",
  "codec": "image/jpeg",
  "payloadBase64": "..."
}
```

現行のブラウザ実装では、`frameType` は1秒周期のGOP境界を表すメタデータとして付与する。将来、差分Pフレーム対応codecに置き換える場合も、1メッセージ1フレームとメタデータ項目は維持する。

### 6.4 欠落時の前提

Pフレームは順序依存を持つため、欠落または順序不整合が発生した場合、そのGOP内の後続Pフレームは復元不能になる可能性がある。

復旧は次のIフレームで行う。

### 3.6 Worker pipeline 検証ページ

`/test` は本番受講フローではなく、Worker推論パイプラインをローカルまたは開発環境で検証するためのページである。

機能:

- `POST /api/sessions` により検証用セッションを作成する。
- ブラウザのWebカメラ映像を取得する。
- `/ws/sessions/{sessionId}/frames` に `image/jpeg` フレームを 640×480 / 5fps 相当で送信する。
- Iフレーム間隔は1秒、PフレームはGOP内の通常フレームとしてメタデータ付与する。
- `GET /api/sessions/{sessionId}/analysis-events` のSSEイベントストリームを購読する（受講者画面のSignalR接続とは独立したフォールバック経路の検証用）。
- WorkerがBackendへpublishした `drowsiness_score` / `tracking_status` / `calibration_status` を表示する。
- 表示項目はEAR、Pitch、Yaw、PERCLOS、score、level、`shouldPause`、直近イベントJSONとする。

`/test` は検証用ページであり、受講者向け自動停止制御や教員ダッシュボードの代替にはしない。

## 7. リアルタイム通知受信仕様（SignalR / SSEフォールバック）

リアルタイム通知payloadおよびSignalR / SSEの関係の一次情報は [`09-realtime-notification.md`](../features/09-realtime-notification.md) とする。

受講者画面（`student-session-page.tsx`）は `@microsoft/signalr` の `HubConnection` で Backend の `AnalysisEventsHub`（`/hubs/analysis-events`）に接続し、以下の通知を受信する。接続確立後、または再接続成功後は必ず `JoinSession(sessionId)` を呼び出し、該当セッションのGroupへ参加する。クライアントメソッド `ReceiveAnalysisEvent` で受信したpayloadは、既存の `handleAnalysisEvent()` にそのまま渡し、SSE時代と同じ受信後処理（動画制御、Popup表示、眠気レベル表示）を再利用する。

`/test` ページなどSignalRクライアントへ未移行のローカル検証ツールは、引き続き `EventSource` で `GET /api/sessions/{sessionId}/analysis-events` のServer-Sent Eventsを購読できる。SSEの `data:` はSignalRと同じJSON構造のpayloadであり、同じTypeScript受信イベント型として扱う。

### 7.0 SignalR接続状態とエラー時のUI

- 受講者画面は接続状態（`idle` / `connecting` / `connected` / `error`）を保持する。この状態はSSE購読時代の `resultStreamState` を引き継いだものであり、変数名・意味とも同一である。
- キャリブレーション開始ボタンは、接続状態が `connected` の場合のみ有効化する。
- `HubConnection` の切断（`onclose`）または再接続失敗時は状態を `error` にし、キャリブレーション中・受講中であればBackendの起動状態確認を促すメッセージを表示する。
- 再接続成功時（`onreconnected`）は `JoinSession(sessionId)` を再実行し、成功後に状態を `connected` に戻す。

### 7.1 眠気スコア通知

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

眠気レベル:

```text
normal:  score < 0.25
caution: 0.25 <= score < 0.50
warning: 0.50 <= score < 0.75
danger:  0.75 <= score <= 1.00
```

### 7.2 受講者画面での扱い

- `level === "danger"` または `shouldPause === true` の場合、動画を自動停止する。
- 自動停止時は動画の再生位置を停止判定時点から5秒前へ戻す。巻き戻し後の再生位置が0秒未満になる場合は0秒にする。
- 自動停止時のPopupには、Title「おきて！」、Content「眠っていますか？目が閉じているため、動画を一時停止しています。」を表示し、scoreなどの数値や詳細メトリクスを表示しない。
- `level === "normal"` に戻るまで再開ボタンを無効化する。
- `level === "normal"` 復帰後は、閉眼からの復帰時はTitle「おはよう！」、Content「起きていることが確認できました。再生ボタンを押すと再開します。」の再開可能Popupを表示する。顔未検出からの復帰時はTitle「おかえり！」、Content「あなたのお顔がよくみえます！再生ボタンを押すと動画が再開します。」の再開可能Popupを表示する。
- 再開可能Popupを表示している状態で再度 `danger` になった場合は、再開不可の自動停止Popupへ戻す。
- 現在の眠気レベルは、受講ページHeader右上のBadge群にマウスホバーした場合のみscoreとともに表示する。

### 7.3 顔未検出通知

顔未検出時は以下の通知を受信する。

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

受講者画面では、閉眼時と同様に動画を一時停止扱いにする。

顔未検出用Popupには以下を表示する。

```text
title: そこにいる？
content: 顔が検出できません。カメラの状態を確認し、顔と目がしっかり映っているか確認してください！
```

顔未検出用Popupは通常の自動停止通知Popupと同じ表示位置に表示し、Contentの下にWebカメラFrameを表示するためHeightだけ伸ばす。

## 8. 動画自動停止・再開制御

### 8.1 自動停止条件

SignalR通知で以下のいずれかを満たした場合、動画を自動停止する。

```text
level == danger
shouldPause == true
tracking_status.status == face_not_detected
```

自動停止時は動画の再生位置を停止判定時点から5秒前へ戻す。巻き戻し後の再生位置が0秒未満になる場合は0秒にする。

### 8.2 再開条件

`level == normal` に戻るまで再開ボタンを無効化する。

`normal` 復帰後、受講者が再開ボタンを押すことで動画を再開する。

### 8.3 停止・再開イベント送信

自動停止時と再開時、バックエンドへイベントを送信する。

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

## 9. 教員ダッシュボードAPI利用仕様

### 9.1 セッション一覧

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

### 9.2 セッション詳細

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

### 9.3 眠気スコア系列

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

### 9.4 停止・再開イベント

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

## 10. フロントエンド状態・UI振る舞い詳細

### 10.1 受講者画面の状態遷移

受講者画面は以下の状態を持つ。

| 状態 | 条件 | 表示 | 操作 |
| --- | --- | --- | --- |
| `idle` | 初期表示 | Loginモーダルの生徒ログインフォーム | ログインボタンと教員ログイン切り替えLinkTextButtonを表示する。 |
| `starting` | セッション作成中 | Loginモーダル内の読み込み表示 | ログインボタンを無効化する。 |
| `camera_permission_required` | `/student/session` 遷移後、カメラ権限未取得 | 動画再生ページ内のカメラ許可案内 | ブラウザの権限許可を促す。 |
| `calibration_ready` | セッション開始・カメラ取得後 | 動画全面画面上のキャリブレーションモーダル、WebSocket接続状態 | 動画再生画面でWebSocket接続を開始し、開始ボタンを表示し、動画再生を禁止する。開始ボタン押下時にBackendとWorkerの起動確認を行う。 |
| `calibrating` | BackendとWorkerの起動確認成功後5秒間 | カメラ画角、進捗、案内文、WebSocket接続状態 | 動画再生を禁止する。 |
| `ready` | キャリブレーション成功かつWebSocket接続済み | 動画Frame、Float録画状態、Float再生コントロール | 再生開始を許可する。 |
| `ws_connecting` | キャリブレーション完了時点でWebSocket接続中、または再接続中 | 動画Frame中央のSpinnerと `接続中` 表示 | 指数バックオフで最大5回まで再試行する。 |
| `playing` / `streaming` | キャリブレーション成功後、WebSocket接続済みで動画再生中 | 動画Frame、現在の眠気レベル、トラッキング状態、カメラ録画中表示 | 動画再生に応じてカメラ画角画像を送信する。 |
| `auto_paused` | `danger`、`shouldPause`、または `face_not_detected` 受信 | 閉眼時はTitle「おきて！」、Content「眠っていますか？目が閉じているため、動画を一時停止しています。」の自動停止Popup。顔未検出時はTitle「そこにいる？」、Content「顔が検出できません。カメラの状態を確認し、顔と目がしっかり映っているか確認してください！」とWebカメラFrameを含む自動停止Popup | 再開ボタンを無効化する。 |
| `resumable` | `normal` 復帰後 | 閉眼からの復帰時はTitle「おはよう！」、Content「起きていることが確認できました。再生ボタンを押すと再開します。」の再開可能Popup。顔未検出からの復帰時はTitle「おかえり！」、Content「あなたのお顔がよくみえます！再生ボタンを押すと動画が再開します。」の再開可能Popup | 再開ボタンを有効化する。 |
| `ended` | 動画終了またはセッション終了 | Title「受講が完了しました」、Content「おつかれさまでした。動画教材の受講が完了しました。」の完了メッセージ | 再生ボタンを無効化し、ログインページへ戻る導線を表示する。 |
| `error` | 復旧不能な通信・権限エラー | エラーメッセージ | 再試行導線を表示する。 |

状態遷移の原則:

- `calibrating` が成功するまで、動画教材の再生操作はできない。
- キャリブレーション開始前にBackendとWorkerの起動確認を行い、失敗時はキャリブレーションを開始しない。
- WebSocket接続は、ログイン後に `/student/session` へ遷移した時点で開始する。
- 動画再生とカメラ画角画像送信は、キャリブレーション成功かつWebSocket接続済みになってから開始する。
- キャリブレーション完了時点でWebSocket接続中の場合は、動画Frame中央にSpinnerと `接続中` を表示し、接続完了後に動画再生と送信を開始する。
- WebSocket接続は指数バックオフで最大5回まで再試行し、失敗時はエラーDialogを表示する。
- `auto_paused` では、受講者の手動操作による再生を禁止する。
- `resumable` では、受講者が明示的に再開ボタンを押した場合のみ再生する。
- 顔未検出は閉眼時と同様に `auto_paused` へ遷移し、顔が検出できるまで受講者の手動操作による再生を禁止する。

### 10.2 眠気レベル表示

眠気レベルは `Badge` で表示する。

| level | 表示文言 | Badge variant | 動画制御 |
| --- | --- | --- | --- |
| `normal` | 正常 | `default` | 再生可能 |
| `caution` | 注意 | `secondary` | 再生継続 |
| `warning` | 警告 | `outline` | 再生継続 |
| `danger` | 危険 | `destructive` | 自動停止 |

`Badge` の見た目は shadcn/ui 標準の `variant` を使用し、独自色は定義しない。

### 10.3 受講者画面レイアウト

受講者画面は以下の領域で構成する。

| 領域 | 内容 | 配置・大きさの方針 |
| --- | --- | --- |
| ヘッダー | セッション状態、学籍番号、接続状態 | 画面上部に横並びで配置する。 |
| メイン | 動画教材プレーヤー | 画面幅に応じて最大表示領域を確保する。 |
| サイド / 下部 | カメラプレビュー、キャリブレーション進捗、眠気レベル、警告 | デスクトップでは動画右側、狭幅画面では動画下に配置する。 |
| 操作領域 | アイコンボタンによる再生/一時停止、停止中メッセージ、再開ボタン、`再生分秒/動画長さ` の時間表示 | 動画直下またはカード下部に配置する。時間表示は画面右下に寄せる。 |

カメラプレビューは受講者が姿勢を確認するために表示するが、動画教材より小さく表示する。

### 10.4 教員ダッシュボードレイアウト

教員ダッシュボードは以下の領域で構成する。

| 領域 | 内容 | 主なコンポーネント |
| --- | --- | --- |
| セッション一覧 | 学籍番号、開始時刻、終了時刻、最新眠気レベル | `Table`, `Badge` |
| フィルタ | 学籍番号、期間、眠気レベル | `Input`, `Select`, `Button` |
| セッション概要 | 選択中セッションの基本情報 | `Card` |
| 眠気スコアグラフ | `score`, `perclos`, `ear` の時系列 | `Chart` |
| 停止・再開タイムライン | `auto_pause`, `resume` の発生位置 | `Card`, `ScrollArea` |

初期表示ではセッション一覧を表示し、セッション選択後に詳細・グラフ・タイムラインを表示する。

### 10.5 管理者ページの入力仕様

教員アカウント追加フォームは以下を入力項目とする。

| 項目 | 必須 | 入力制約 | 表示 |
| --- | --- | --- | --- |
| 教員ID | 必須 | 空文字不可。前後空白は送信前に除去する。 | `Input` |
| パスワード | 必須 | 空文字不可。入力内容は画面上でマスクする。 | `Input type="password"` |

送信成功時は教員一覧を更新する。送信失敗時は `Alert` でエラーを表示し、入力内容をフロントエンド永続領域へ保存しない。

### 10.6 アクセシビリティ

- フォーム入力にはラベルを付与する。
- 操作不能なボタンは `disabled` を設定する。
- 自動停止、顔未検出、通信断など受講継続に影響する通知は視認しやすい位置に表示する。
- 動画が自動停止した場合は、停止理由と再開条件を文言で明示する。
- 色のみに依存せず、`正常`、`注意`、`警告`、`危険` のテキストを併記する。

## 11. 未決定事項

以下は本仕様では未決定とする。

- WebSocketで送信するエンコード済みフレームの具体的な `codec`
- フレームメタデータとバイナリ本体の具体的なWebSocketメッセージ梱包方式
- Blob Storage上の映像フレーム保存期間・削除方針
