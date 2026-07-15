オンデマンドビデオ教材受講完了検証システム
TK240047生山匡太
1. 企画概要
ノートPCのWebカメラとAzureクラウドを組み合わせ、オンデマンド動画教材の受講中に学習
者の覚醒状態をリアルタイムで監視するシステム。顔画像解析によってPERCLOSベースの
眠気スコアをリアルタイム算出し、危険レベル検知時には動画を自動停止することで実質未
受講区間の拡大を防ぐ。眠気スコアは1秒単位で継続記録し、自動停止イベントのタイムスタ
ンプとともに教員・管理者向けダッシュボードへグラフ・タイムライン形式で配信する。
2. 背景・目的
オンデマンド型の動画教材は、視聴完了が形式的に確認できても、受講者が実際に覚醒状
態で視聴したかどうかを客観的に把握する手段が存在しない。タブ放置・居眠りによる実質未
受講が、学習効率の低下や評価の形骸化を招いている。本システムは以下を目的とする。
・眠気危険レベル検知時に動画を自動停止し、実質未受講区間の拡大を防ぐ
・眠気スコアの推移と自動停止イベントを、教員・管理者がグラフ・タイムラインで確認できる
ダッシュボードを提供する
3. システム構造
本システムはクライアント層・Azureクラウド層の2階層で構成する。
3.1. クライアント層（データ取得・動画再生）
・WebカメラでユーザーのWebカメラ映像をキャプチャ（640×480・5fps）
・Next.js上のプレーヤーコンポーネントがオンデマンド動画の再生を制御
・HTTPS binary frame API経由でAzure Container Apps上のBackendへ映像フレームを送信
・SignalR受信により眠気レベルをリアルタイムに表示・動画停止を実行
3.2. Azureクラウド層（推論・記録・通知）
・顔画像パイプライン: Backend Container Apps → Blob Storage → Service Bus → Container Apps
Worker → Backend / PostgreSQL
・ダッシュボード配信: 眠気スコア（1秒単位）・自動停止イベントをAzure SignalR Service経
由でリアルタイムに管理ダッシュボードへ配信
4. 動作フロー
4.1. 顔画像パイプライン
受講者が学籍番号を入力してセッションを開始すると、ブラウザはgetUserMedia APIで
Webカメラを起動し、640×480・5fpsの独立JPEGフレームをHTTPS binary requestでBackend
Container Appsへ送信する。BackendはBlob Storage保存とService Bus enqueueの両方を完了した
durable acceptance時だけ`202 Accepted`を返す。Container Apps WorkerがMediaPipe Face
Landmarkerでフレームから顔ランドマークを取得してEAR・Pitch・Yawを算出する。算出
値はRedis上のスライディングウィンドウを用いてPERCLOSベースの眠気スコアに変換
され、SignalRを用いてクライアントへリアルタイム通知されるとともに、5フレームの平均
値を1秒単位でPostgreSQLへ保存する。
4.2. キャリブレーション

セッション開始時に5秒間（25フレーム）の正面向きEAR中央値をEAR_openとして個人
ごとにDB保存し、閉眼閾値をEAR_threshold = EAR_open × 0.75として動的に設定す
る。
4.3. フィードバック・自動停止
眠気レベルがdanger（score ≥ 0.75）に達した場合、SignalR経由でイベントを配信し、フ
ロントエンドが動画再生を自動停止する。scoreがNormal（< 0.25）に復帰するまで再開
ボタンを無効化し、眠気状態での即時再開を防ぐ。停止・再開のタイムスタンプはすべて
PostgreSQLに記録される。
4.4. スコア記録・ダッシュボード配信
Container Apps Workerが算出した眠気スコアは、5フレームの平均値として1秒単位で
PostgreSQLに保存する。教員・管理者向けダッシュボードでは、眠気スコアの時系列グ
ラフと自動停止区間を重ね合わせたタイムライン表示でセッション単位・学習者単位の受
講状況を確認できる。
5. 眠気スコア算出ロジック
NHTSAが自動車運転者の眠気評価に採用するPERCLOS（15秒スライディングウィンドウ・
75フレーム）を主指標とし、頭部姿勢角を複合したスコアを算出する。
w_yaw = max (1.0 − |Yaw_deg| / 45.0, 0.0)
EAR_score = min(PERCLOS / 0.5, 1.0) × w_yaw
score = min (EAR_score × (1 + 0.3 × min (Pitch_deg / 30.0, 1.0)), 1.0)
眠気レベル判定：
Normal (< 0.25) / caution (0.25〜0.50) / warning (0.50〜0.75) / danger (0.75〜1.0)
6. 技術的特徴
・個人差対応キャリブレーション
セッション開始時の5秒間でEAR_openを個人ごとに算出し、閉眼閾値を動的設定。固定閾値
で生じる誤検知を抑制する。
・PERCLOSと頭部姿勢の複合スコア
NHTSA標準のPERCLOSにPitch角（前傾増幅）とYaw角（信頼性減衰）を掛け合わせた複合
スコア設計により、顔の向きや俯き姿勢に応じた眠気推定を実現する。
・Redisによるスケールアウト対応
スライディングウィンドウ状態をAzure Cache for Redisにセッションごとに永続化し、Luaスク
リプトで原子的（LPUSH・LTRIM・LRANGE）に更新。Workerのスケールアウト時の競合を防
ぐ。
・Service BusによるAPIレスポンス性確保
Backendは推論完了を待たず、Blob保存とqueue enqueueのdurable acceptance後に応答する非同期設計。推論はContainer
Apps Workerがキューから非同期で処理し、API応答性を一定に維持する。

7.  使用する技術
表2. 使用ライブラリ
| 領域          | 技術・ライブラリ                      |     | Azureサービス                |
| ----------- | ----------------------------- | --- | ------------------------ |
| フロントエンド     | Next.js, TypeScript, SignalR  |     | -                        |
| バックエンド      | ASP.NET Core, HTTPS binary API |     | Container Apps           |
| 画像推論Worker  | Python, MediaPipe, OpenCV     |     | Container Apps           |
| メッセージキュー    |                               | -   | Service Bus              |
| 画像保管        |                               | -   | Blob Storage             |
| データベース      |                               | -   | Database for PostgreSQL  |
| ウィンドウ状態管理   |                               | -   | Azure Cache for Redis    |
| リアルタイム通知    |                               | -   | Azure SignalR Service    |

8.  まとめ
本システムはWebカメラ映像のみを入力として、オンデマンド動画教材の受講中に学習者の
覚醒状態をリアルタイムで監視する。危険レベル検知時の動画自動停止により実質未受講
区間の拡大を防ぎ、眠気スコアと自動停止イベントを教員・管理者ダッシュボードへグラフ・タ
イムライン形式で配信する。
技術的工夫点は、個人差対応キャリブレーション・PERCLOS複合スコア・Redisによるスケー
ル対応・非同期キュー設計の4点であり、既存のオンデマンド受講システムに対して眠気状態
の客観的な可視化と実質未受講防止機能を付加する。
