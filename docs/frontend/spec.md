# フロントエンド仕様書

## 1. 目的

本仕様書は、オンデマンドビデオ教材受講完了検証システムにおけるフロントエンドの仕様を定義する。

フロントエンドは、受講者向け画面と管理者向け画面を提供し、Webカメラ映像の取得、動画教材の再生制御、眠気状態のリアルタイム表示、管理者ダッシュボード表示を担う。

## 2. 根拠

本仕様は二次仕様である。受け入れ条件と認証・永続化・通知の判断は `docs/features/` と `docs/scenarios/` を一次情報とし、本書はフロントエンドの接続・画面責務だけを補足する。

### 2.1 proposal.md に基づく事項

- フロントエンド技術は Next.js / TypeScript とする。
- Webカメラ映像を取得する。
- 映像は 640×480 / 5fps 相当で扱う。
- Backend の HTTPS binary frame API へ映像データを送信する。
- SignalR で眠気レベルを受信する。
- 眠気レベルが `danger` の場合、動画を自動停止する。
- `normal` に戻るまで再開ボタンを無効化する。
- 教員・管理者向けダッシュボードでは、値軸・観測時刻・動画再生位置（秒）の二軸を持つ眠気スコアの時系列グラフと自動停止区間のタイムラインを一体で表示する。FPSは契約に含まれないためフレーム番号は表示しない。

### 2.2 承認済み仕様決定

- 受講者は学籍番号のみでログイン / セッション開始する。
- 管理者ダッシュボードは管理者IDとパスワードでログインする。
- 教員ID・パスワードの追加は管理者ページから行う。
- 受講セッションごとにバックエンドが `sessionId` と当該sessionに限定したHttpOnly `student_session` Cookieを発行する。
- 教員・管理者は、HttpOnly認証Cookieとサーバー側sessionで認証する。`adminId` / `teacherId` / トークンを `sessionStorage`、`localStorage`、request bodyへ保存して認可に用いない。別オリジン開発時のCSRF値はBackendの `X-CSRF-Token` レスポンスヘッダーから取得してメモリ内だけに保持し、状態変更requestで送る。
- raw JPEG frame は `image/jpeg` の HTTP request body として送信する。解析結果通知は SignalR を使用する。
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
   SSR Frontendは実行環境変数 `LESSON_VIDEO_ID` をServer Componentから受け取り、`videoId` として送信する。未設定時は `default` を送信する。取得した `sessionId` を同一ブラウザタブ内の受講中状態として保持し、Backendが発行するHttpOnly `student_session` Cookieと組み合わせて `/student/session` へ遷移する。
2. 動画再生ページ (`/student/session`)
   - 画面全面に動画Frameを配置する。
   - 動画教材はAzure Blob Storageから配信される動画URLを `<video>` の `src` として読み込む。
   - ローカル開発ではAzuriteのBlob URLを使用し、Azureからデリバリされる動作を再現する。
   - スマホ縦向きでは、動画のアスペクト比を維持して画面中央に配置し、動画幅を画面幅に合わせる。16:9動画などで画面上下に余る領域は黒で表示し、動画を切り取らない。`md` 以上の表示は既存のPC向け全画面表示方針を維持する。
   - 画面上部をHeaderとし、左上に動画ファイル名、右上に受講者IDとカメラ送信状態のBadgeを表示する。
   - Header右上のBadge群では、マウスホバーまたはキーボードフォーカス中に直近のscoreとlevel、およびBackend通知をFrontendが受信してからの経過秒数を `更新 N秒前` として追加表示する。タッチ端末ではBadge群のタップにより同じ詳細の表示／非表示を切り替える。
   - 画面下部をFooterとし、再生スライダー、再生ボタン、再生時間をFloat表示する。
   - HeaderとFooterの背景は、動画視聴を妨げない半透明の黒とする。
   - 3秒間マウス、タッチ、キーボード操作がない場合、HeaderとFooterを150msでfade-outして非表示にする。
   - HeaderとFooterが非表示の状態でマウス、タッチ、キーボード操作があった場合、150msでfade-inして表示する。タップによるBadge詳細の切替も操作として扱い、無操作タイマーをリセットする。
3. キャリブレーションモーダル
   - Loginページから `/student/session` へ遷移した直後に表示する。
   - モーダル内にカメラ画角を表示する。
   - 開始ボタン押下後、5秒間キャリブレーション指示と進捗を表示する。
   - キャリブレーション終了後にモーダルを閉じ、画面中央の再生ボタンを表示する。受講者が押した場合にのみ動画再生とカメラ画角画像の送信を開始する。

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

### 3.2 管理者ログイン画面

管理者ログイン画面は、管理者IDとパスワードによるログインを提供する。

入力項目:

- 管理者ID
- パスワード

認証成功後、管理者ダッシュボードをデフォルトで表示する。

### 3.3 管理者ダッシュボード

管理者ダッシュボードは、受講状況をセッション単位・学習者単位で確認するための画面である。

表示内容:

- 動画IDごとのセッション一覧
- 学籍番号
- セッション開始時刻
- セッション終了時刻
- 眠気スコア時系列グラフ
- 自動停止区間を重ね合わせた眠気スコアグラフ

`/admin/dashboard` の初期表示時はREST APIから過去データを取得する。動画IDでセッションを絞り込み、各行から `/admin/dashboard/sessions/{sessionId}` のセッション詳細ページへ遷移でき、削除確認ダイアログも開ける。詳細ページはREST APIで過去データを取得し、以後はSignalR通知によりリアルタイム更新する。チャートは `score` を常時表示し、`PERCLOS` と `EAR` は初期非表示の `Checkbox` で重ね表示を切り替える。PERCLOS は保存済みキャリブレーションの `EAR_threshold` に基づく閉眼判定を反映し、`PERCLOS` または `EAR` 表示時はその閾値を明示する。EAR 表示時は `EAR_open` と `EAR_threshold` の基準線を重ねる。横軸は観測時刻と動画再生位置（秒）の二軸とし、スコア線へのホバーでは、対象観測時刻・動画再生位置・眠気レベル・`score`・`PERCLOS`・`EAR`・EAR基準をツールチップに表示する。`videoTimeSec` が `null` の既存スコアでは動画再生位置を `—` と表示する。FPSは契約に含まれないためフレーム番号を表示・算出しない。`auto_pause` から次の `resume` までを停止区間としてチャート背景に示す。「スコアタイムライン」は各スコアを次の観測時刻までの区間として描き、`normal`（緑）、`caution`（黄）、`warning`（橙）、`danger`（赤）を色分けする。スコアや停止・再開イベントを表形式で列挙しない。削除確認では動画IDと学籍番号を表示し、成功後は一覧から削除済みセッションを除外する。

### 3.4 教員アカウント管理

`/admin/teachers` のフロントエンド画面は提供しない。教員アカウント管理APIの認可・データ仕様は [`../features/13-teacher-account-management.md`](../features/13-teacher-account-management.md) を一次情報とする。

### 3.5 ルーティング

フロントエンドは以下のルーティングを提供する。

| パス | 対象 | 目的 |
| --- | --- | --- |
| `/` | 受講者 | 案内ページを挟まず、学籍番号入力のLoginモーダルを直接表示する |
| `/student` | 受講者 | 学籍番号入力、セッション開始 |
| `/student/session` | 受講者 | キャリブレーション、動画受講 |
| `/test` | 開発・検証 | カメラフレームをBackendへ送信し、Worker解析結果をBackend経由で確認する |
| `/teacher/login` | 互換URL | `/admin/login` の管理者ログインへリダイレクト |
| `/teacher/dashboard` | 互換URL | `/admin/dashboard` へリダイレクト |
| `/admin/login` | 管理者 | 管理者ID・パスワードによるログイン |
| `/admin/dashboard` | 管理者 | 動画ID別のセッション一覧、記録削除 |
| `/admin/dashboard/sessions/{sessionId}` | 管理者 | 選択したセッションの詳細、グラフ、タイムライン確認 |

未認証状態で `/admin/dashboard` または `/admin/dashboard/sessions/{sessionId}` へアクセスした場合は、`GET /api/auth/me` の `401` を受けて `/admin/login` へ遷移する。これらの画面は `admin` roleでなければ表示しない。フロントエンドは教員ログインフォームを提供せず、管理者ログインへ統一する。ログアウトは `POST /api/auth/logout` を呼び出し、クライアント側のprincipal表示状態も破棄する。

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
| 管理者ログイン画面 | `Card`, `Form`, `Input`, `Button`, `Alert` | パスワード入力は `Input type="password"` とする。 |
| 管理者ダッシュボード | `Card`, `Table`, `Badge`, `Tabs`, `Select`, `ScrollArea`, `Separator`, `Skeleton`, `Chart` | グラフは shadcn/ui の Chart パターンを使用する。 |
| 管理者ページ | `Card`, `Form`, `Input`, `Button`, `Table`, `Dialog`, `Alert` | 教員追加確認やエラー表示に使用する。 |

#### 3.6.3 共通UI状態

| 状態 | 表示仕様 | 主なコンポーネント |
| --- | --- | --- |
| 読み込み中 | 対象領域にプレースホルダーを表示する。 | `Skeleton` |
| 入力エラー | フォーム項目直下にエラーメッセージを表示する。 | `FormMessage` |
| API / 通信エラー | 画面上部または対象カード内にエラーを表示する。 | `Alert` |
| 操作不可 | ボタンを `disabled` にする。 | `Button` |
| 状態ラベル | 眠気レベル、接続状態、セッション状態をラベル表示する。 | `Badge` |

### 3.7 レスポンシブ対応

レスポンシブ対応は、既存のPC表示と受講・認証・通信の振る舞いを維持したうえで、幅が `md` 未満の画面を対象に配置と大きさを調整する。PC向けの複数カラム配置、一覧表示、動画制御、およびAPI契約をスマホ対応のために変更してはならない。

共通要件:

- 最小確認幅を320pxとし、360px、390px、768px、1024px以上で表示を確認する。
- 画面全体に意図しない横スクロールを発生させない。表・グラフなど横幅を必要とする領域だけは、領域内の横スクロールを許可する。
- モーダルとダイアログは、スマホの幅と低い横向き画面に収まり、内容が収まらない場合は内容領域を縦スクロールできるようにする。
- 動的なブラウザUIで全画面領域が隠れないよう、受講ページなどの全画面レイアウトでは動的ビューポート高を使用する。固定HeaderとFooterは安全領域を考慮する。
- shadcn/uiコンポーネントの見た目は変更せず、配置・大きさ・overflow・既存の標準sizeのみで対応する。

| 画面 | スマホでの表示要件 | `md` 以上で維持する内容 |
| --- | --- | --- |
| `/`, `/student` | Loginモーダル、入力、エラー、管理者ログイン導線を横幅・ソフトキーボード表示時ともに操作可能にする。 | 中央モーダルと既存のフォーム構成。 |
| `/student/session` | 動画は縦向きでアスペクト比を保持して中央表示し、上下余白を黒で表示する。Header/Footerは狭幅で折り返し可能にし、表示・非表示の制御を維持する。タッチでBadge詳細を切り替えられるようにする。キャリブレーション・エラー・自動停止の表示は画面外に切れないようにする。 | 現行の動画表示方針、Header/Footerの配置、マウスホバーによるBadge詳細表示。 |
| `/test` | カメラ、開始・停止操作、状態、解析結果を1カラムで読めるようにし、長いID・JSONはコンテナ内で折り返しまたはスクロールする。 | `lg` 以上のカメラと結果表示の2カラム構成。 |
| `/admin/login` | フォーム、認証エラー、ログアウト導線を狭幅・低い画面でも操作可能にする。 | 中央カードのログイン画面。 |
| `/admin/dashboard` | フィルタは1カラム化し、セッション一覧はTableの情報を省略せずコンテナ内で横スクロールさせる。削除確認は画面内に収める。 | 複数カラムのフィルタと通常のTable表示。 |
| `/admin/dashboard/sessions/{sessionId}` | 操作群と概要を縦方向に配置する。グラフとタイムラインの文字・系列を縮小して読めなくせず、専用領域で横スクロール可能にする。タッチ端末でもスコア詳細を確認可能にする。 | 操作群・概要の複数カラム表示と、コンテナ幅でのグラフ表示。 |

### 3.8 動画教材配信

動画教材は、フロントエンドの静的ファイルとして同梱せず、Azure Blob Storageから配信する。

SSR Frontendは実行環境変数 `LESSON_VIDEO_URL` をrequest時にServer Componentで取得し、Client Componentへ渡して動画教材URLとして使用する。URLはFrontend ACAのsecret参照から供給し、GHCR imageへ固定しない。

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
  "studentId": "string",
  "videoId": "string"
}
```

response:

```json
{
  "sessionId": "uuid"
}
```

フロントエンドは取得した `sessionId` を同一ブラウザタブ内の受講中状態として保持し、Backendが発行するHttpOnly `student_session` Cookieと組み合わせて `/student/session` へ遷移する。キャリブレーション成功通知を受信した場合と動画再生中の秒単位進捗も同じ状態へ記録するが、クライアント記録は再生許可の根拠にしない。

既存の認証Cookieがある状態で受講者が新規開始する場合、Frontendは先に `GET /api/auth/me` を実行し、応答の `X-CSRF-Token` を取得してから `POST /api/sessions` を送る。API originのCSRF cookieはhost-onlyであり、Frontend originのJavaScriptから直接読まない。匿名時の `401` は開始要求を妨げない。

`/student/session` の初期認証で `401`・`403`、またはCookieのセッションと保持した `sessionId` の不一致を検出した場合、フロントエンドは保持した受講中状態を削除して `/student` へ遷移する。認証確認APIの一時的な失敗は受講ページ上にエラーとして表示する。

動画の手動停止時は `manual_pause`、眠気または顔未検出による停止時は `auto_pause`、停止後の実再生開始時は `resume`、動画終了時は `completed` を `POST /api/sessions/{sessionId}/playback-events` へ送信する。動画終了時の `completed` は、タイマーと`<video>`要素の終了通知が重複しても一度だけ送信する。

`/student/session` は保持した `sessionId` を、以下に使用する。

- HTTP frame ingress への送信
- SignalR購読
- 手動停止・自動停止・再開・受講完了イベント送信
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

BackendとWorkerの起動確認に成功した場合のみ、Feature 03のHTTP binary frame ingressと解析結果のSignalR購読を開始し、キャリブレーション用のカメラframe送信を開始する。

Workerから `calibration_status: succeeded` を受信するまで、動画教材の再生を開始しない。

受講中にリロードした場合は、認証済みの当該セッションに対して `GET /api/sessions/{sessionId}/calibration` を呼び出す。`200` の保存済み成功結果を受け取った場合は、キャリブレーションモーダルを表示せず、同じタブに保存した動画進捗へ復元する。カメラとSignalRの再接続完了後に画面中央の再生ボタンを表示し、受講者が押した場合のみ受講を開始する。`204` の場合のみキャリブレーションを求める。

キャリブレーション失敗時は、受講者に再キャリブレーションを促す。

表示例:

```text
顔を正面に向けてください。キャリブレーション中です。
```

失敗時表示例:

```text
キャリブレーションに失敗しました。顔が正面から映るようにカメラ位置を調整してください。
```

## 6. HTTP binary frame送信仕様

Frame transportの一次契約は[`03-video-frame-sending.md`](../features/03-video-frame-sending.md)を正とする。frontendはraw JPEG frame用WebSocketを接続・再接続せず、次のrequestだけでframeを送信する。

```http
POST /api/sessions/{sessionId}/frames/{sequenceNo}
Content-Type: image/jpeg
X-CSRF-Token: <existing CSRF token>
X-Frame-Captured-At: <UTC timestamp>
X-Frame-Video-Time-Sec: <non-negative finite value>

<raw JPEG bytes>
```

- JPEG bodyは1 MiB以下、`sequenceNo`はcaptureごとに単調増加、`capturedAt`はUTC、`videoTimeSec`は0以上の有限値とする。
- Sessionごとに最大1 HTTP requestだけをin-flightにする。5fpsの次tickに前requestが完了していなければframeをqueueせず、captureしたsequenceをskipして`framesNotSentDueToInFlightLimit`を増やす。
- `202`はdurable acceptanceである。`503`/`429`（`Retry-After`があれば従う）だけを同じsequence、metadata、JPEG bytesで再送する。`400`/`401`/`403`/`409`/`413`はpermanent failureとして再送しない。
- SignalRの接続、再接続、`JoinSession(sessionId)`と解析結果の誤配送検出は維持するが、frame送信の状態とは独立である。

### 6.4 欠落時の前提

各JPEGは独立しているため、欠落または順序不整合があっても後続の有効JPEGを送信・解析対象から除外しない。欠落はPERCLOSのサンプル不足として扱う。

### 3.6 Worker pipeline 検証ページ

`/test` は本番受講フローではなく、Worker推論パイプラインをローカルまたは開発環境で検証するためのページである。

機能:

- `POST /api/sessions` により検証用セッションを作成する。
- ブラウザのWebカメラ映像を取得する。
- `/api/sessions/{sessionId}/frames/{sequenceNo}` にraw `image/jpeg` bodyを 640×480 / 5fps 相当でPOSTする。header、retry、1 in-flight、skipは受講者画面と同じFeature 03契約を使用し、WebSocket JSON/Base64や廃止済みframe種別・基準frame fieldを使用しない。
- `GET /api/sessions/{sessionId}/analysis-events` のSSEイベントストリームを購読する（受講者画面のSignalR接続とは独立したフォールバック経路の検証用）。
- WorkerがBackendへpublishした `drowsiness_score` / `tracking_status` / `calibration_status` を表示する。
- 表示項目はEAR、Pitch、Yaw、PERCLOS、score、level、`shouldPause`、直近イベントJSONとする。

`/test` は検証用ページであり、受講者向け自動停止制御や管理者ダッシュボードの代替にはしない。

## 7. リアルタイム通知受信仕様（SignalR / SSEフォールバック）

リアルタイム通知payloadおよびSignalR / SSEの関係の一次情報は [`09-realtime-notification.md`](../features/09-realtime-notification.md) とする。

受講者画面（`student-session-page.tsx`）は `@microsoft/signalr` の `HubConnection` で Backend の `AnalysisEventsHub`（`/hubs/analysis-events`）にCookie資格情報付きで接続し、以下の通知を受信する。接続確立後、または再接続成功後は必ず `JoinSession(sessionId)` を呼び出す。BackendがCookie principalと`sessionId`を照合するため、クライアントは認可情報をHub引数へ渡さない。クライアントメソッド `ReceiveAnalysisEvent` で受信したpayloadは、既存の `handleAnalysisEvent()` にそのまま渡し、SSE時代と同じ受信後処理（動画制御、Popup表示、眠気レベル表示）を再利用する。

`/test` ページなどSignalRクライアントへ未移行のローカル検証ツールは、引き続き `EventSource` で `GET /api/sessions/{sessionId}/analysis-events` のServer-Sent Eventsを購読できる。SSEの `data:` はSignalRと同じJSON構造のpayloadであり、同じTypeScript受信イベント型として扱う。

### 7.0 SignalR接続状態とエラー時のUI

- 受講者画面は接続状態（`idle` / `connecting` / `connected` / `error`）を保持する。この状態はSSE購読時代の `resultStreamState` を引き継いだものであり、変数名・意味とも同一である。
- キャリブレーション開始ボタンは、接続状態が `connected` の場合のみ有効化する。
- `HubConnection` の切断（`onclose`）または再接続失敗時は状態を `error` にし、キャリブレーション中・受講中であればBackendの起動状態確認を促すメッセージを表示する。
- 再接続成功時（`onreconnected`）は `JoinSession(sessionId)` を再実行し、成功後に状態を `connected` に戻す。
- SignalRの初回接続または再接続に失敗した場合、キャリブレーション開始を無効化し、受講中の動画とカメラFrame送信を停止する。エラーPopupから再接続でき、接続済みになるまで再生を許可しない。

### 7.1 眠気スコア通知

```json
{
  "type": "drowsiness_score",
  "sessionId": "uuid",
  "scoredAt": "2026-06-14T10:00:00Z",
  "videoTimeSec": 123.45,
  "score": 0.82,
  "level": "danger",
  "perclos": 0.61,
  "ear": 0.18,
  "pitchDeg": 12.4,
  "yawDeg": 4.2,
  "shouldPause": true
}
```

新規に受信するスコアの `videoTimeSec` は必須である。既存スコアをSignalR/SSEまたはダッシュボードAPIから受信した場合は `null` を許容し、ダッシュボードでは `—` と表示する。

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
- 現在の眠気レベルは、受講ページHeader右上のBadge群にマウスホバーまたはキーボードフォーカスした場合にscoreとともに表示する。タッチ端末ではBadge群のタップで同じ詳細の表示／非表示を切り替える。

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

## 9. 管理者ダッシュボードAPI利用仕様

全Dashboard fetchはCookieを送信し、`401` ではログインへ遷移、`403` では権限エラーを表示する。管理者のprincipal IDをURL・bodyで送信しない。SignalR再接続後は選択中sessionのREST APIを再取得して、通知の取り逃しをPostgreSQLの確定データで補正する。

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
| `calibration_ready` | セッション開始・カメラ取得後 | 動画全面画面上のキャリブレーションモーダル | 開始ボタンを表示し、動画再生を禁止する。開始ボタン押下時にBackendとWorkerの起動確認を行う。 |
| `calibrating` | BackendとWorkerの起動確認成功後5秒間 | カメラ画角、進捗、案内文 | 動画再生を禁止する。 |
| `ready` | キャリブレーション成功または保存済み成功結果の復元後、SignalR接続済み | 動画Frame中央の再生ボタン、Float再生コントロール | 受講者が中央の再生ボタンを押した場合のみ再生開始を許可する。 |
| `playing` / `streaming` | キャリブレーション成功後、SignalR接続済みで動画再生中 | 動画Frame、現在の眠気レベル、トラッキング状態、カメラ録画中表示 | 動画再生に応じて HTTP binary frame を送信する。 |
| `auto_paused` | `danger`、`shouldPause`、または `face_not_detected` 受信 | 閉眼時はTitle「おきて！」、Content「眠っていますか？目が閉じているため、動画を一時停止しています。」の自動停止Popup。顔未検出時はTitle「そこにいる？」、Content「顔が検出できません。カメラの状態を確認し、顔と目がしっかり映っているか確認してください！」とWebカメラFrameを含む自動停止Popup | 再開ボタンを無効化する。 |
| `resumable` | `normal` 復帰後 | 閉眼からの復帰時はTitle「おはよう！」、Content「起きていることが確認できました。再生ボタンを押すと再開します。」の再開可能Popup。顔未検出からの復帰時はTitle「おかえり！」、Content「あなたのお顔がよくみえます！再生ボタンを押すと動画が再開します。」の再開可能Popup | 再開ボタンを有効化する。 |
| `ended` | 動画終了またはセッション終了 | Title「受講が完了しました」、Content「おつかれさまでした。動画教材の受講が完了しました。」の完了メッセージ | 再生ボタンを無効化し、ログインページへ戻る導線を表示する。 |
| `error` | 復旧不能な通信・権限エラー | エラーメッセージ | 再試行導線を表示する。 |

状態遷移の原則:

- `calibrating` が成功するまで、動画教材の再生操作はできない。
- キャリブレーション開始前にBackendとWorkerの起動確認を行い、失敗時はキャリブレーションを開始しない。
- 動画再生とカメラ画角画像送信は、キャリブレーション成功かつ SignalR の `JoinSession(sessionId)` 完了後に開始する。
- HTTP frame request は Session ごとに 1 in-flight とし、`429` / `503` だけを同一 sequence、metadata、JPEG bytes で再送する。permanent failure はエラー表示して再送しない。
- SignalRが再接続中または`JoinSession(sessionId)`再実行中も動画とFrame送信を停止する。再参加に成功するまで受講再開を許可しない。Backendの起動確認は既定で `/health/ready` を使用する。
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

### 10.4 管理者ダッシュボードレイアウト

管理者ダッシュボードは以下の領域で構成する。

| 領域 | 内容 | 主なコンポーネント |
| --- | --- | --- |
| セッション一覧 | 学籍番号、開始時刻、終了時刻 | `Table` |
| フィルタ | 学籍番号、期間、眠気レベル | `Input`, `Select`, `Button` |
| セッション概要 | 選択中セッションの基本情報 | `Card` |
| 眠気スコアグラフ | `score`, `perclos`, `ear` の時系列 | `Chart` |
| 停止・再開タイムライン | `auto_pause`, `resume` の発生位置 | `Card`, `ScrollArea` |

初期表示ではセッション一覧を表示し、セッション選択後に詳細・グラフ・タイムラインを表示する。

### 10.5 教員アカウント管理UI

`/admin/teachers` の教員アカウント管理UIは提供しない。

### 10.6 アクセシビリティ

- フォーム入力にはラベルを付与する。
- 操作不能なボタンは `disabled` を設定する。
- 自動停止、顔未検出、通信断など受講継続に影響する通知は視認しやすい位置に表示する。
- 動画が自動停止した場合は、停止理由と再開条件を文言で明示する。
- 色のみに依存せず、`正常`、`注意`、`警告`、`危険` のテキストを併記する。

## 11. 未決定事項

以下は本仕様では未決定とする。

- Blob Storage上の映像フレーム保存期間・削除方針
