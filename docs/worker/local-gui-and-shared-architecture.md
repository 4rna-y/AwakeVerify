# Worker shared / GUI ローカル検証設計

## 1. 目的

本ドキュメントは、Workerが担う顔トラッキング・キャリブレーション・眠気スコア算出を、ローカル上でGUIアプリケーションとして検証できるようにするための実装構成を定義する。

本番WorkerとローカルGUI検証アプリで同じ解析ロジックを使うため、`src/worker/shared` に共通ロジックを集約する。

## 2. 対象Feature / Scenario

本構成は、主に以下のFeatureを実装・検証するためのものである。

| Feature | 対象範囲 |
| --- | --- |
| `docs/features/05-frame-decoding.md` | 本番WorkerではBlobから取得したフレームをデコードする。GUIではWebカメラフレームを直接入力する。 |
| `docs/features/06-face-recognition.md` | MediaPipe Face Landmarkerにより顔検出、目ランドマーク、EAR、Pitch、Yawを算出する。 |
| `docs/features/07-calibration.md` | 5秒/25フレーム、15有効フレーム以上、`EAR_open`、`EAR_threshold` の算出を検証する。 |
| `docs/features/08-drowsiness-scoring.md` | PERCLOS、眠気スコア、眠気レベル、`shouldPause` 判定を検証する。 |
| `docs/features/09-realtime-notification.md` | 通知payloadに含める解析結果の生成までを検証する。実際のSignalR送信はBackendのOutboxが担う。 |
| `docs/features/10-auto-pause-resume.md` | Worker責務である `level == danger` または `score >= 0.75` による `shouldPause` 判定までを扱う。 |

関連Scenarioは以下である。

- `docs/scenarios/student-learning-happy-path.md`
- `docs/scenarios/calibration-retry.md`
- `docs/scenarios/face-not-detected-warning.md`
- `docs/scenarios/drowsiness-auto-pause-resume.md`

## 3. ディレクトリ構成

Worker配下は以下の3領域に分ける。

```text
src/worker/
  app/      # 本番Workerアプリケーション
  shared/   # 本番WorkerとGUI検証アプリで共通利用する解析ロジック
  gui/      # ローカルGUI検証アプリケーション
```

### 3.1 `src/worker/app`

本番Workerのエントリポイントと外部I/Oを置く。

責務:

- Service Busからのフレーム参照メッセージ受信
- Blob Storageからのフレームバイナリ取得
- 単独でデコード可能なJPEGフレームのデコード
- `shared` の顔解析・キャリブレーション・眠気スコア算出ロジック呼び出し
- RedisによるPERCLOSウィンドウ状態管理
- Backend解析結果APIへの送信（PostgreSQL保存とSignalR通知はBackendのOutboxが担う）
- 本番環境向け設定読み込み
- ヘルスチェック

`app` には、目トラッキングやスコア式などのドメインロジックを直接実装しない。これらは `shared` に置く。

### 3.2 `src/worker/shared`

本番WorkerとローカルGUI検証アプリで共通利用する解析ロジックを置く。

責務:

- MediaPipe Face Landmarkerのラップ
- 顔検出結果の正規化
- 目ランドマーク抽出
- EAR算出
- Pitch / Yaw算出
- 正面向き判定
- キャリブレーション状態管理
- `EAR_open` / `EAR_threshold` 算出
- 閉眼判定
- PERCLOS算出に必要な純粋ロジック
- 眠気スコア算出
- 眠気レベル判定
- `shouldPause` 判定
- SignalR payload相当の値生成

`shared` に置かないもの:

- Service Bus接続
- Blob Storage接続
- PostgreSQL接続
- Redis接続そのもの
- SignalR送信そのもの
- GUI描画
- Webカメラ取得

### 3.3 `src/worker/gui`

ローカル上で起動するGUI検証アプリケーションを置く。

責務:

- Webカメラ映像取得
- OpenCVなどによるローカルGUI表示
- `shared` の顔解析・キャリブレーション・眠気スコア算出ロジック呼び出し
- 顔ランドマーク、目ランドマーク、EAR、Pitch、Yaw、PERCLOS、score、level、`shouldPause` の可視化
- キャリブレーション開始/リセットなどの手動操作

`gui` では本番の外部サービスへ接続しない。

接続しないもの:

- Service Bus
- Blob Storage
- PostgreSQL
- Redis
- SignalR

## 4. shared の推奨モジュール

`shared` は、以下のような構成を基本とする。

```text
src/worker/shared/
  __init__.py
  tracking/
    __init__.py
    models.py
    eye_metrics.py
    head_pose.py
    face_analyzer.py
    calibration.py
    drowsiness.py
```

### 4.1 `models.py`

共通データ型を定義する。

例:

- `FaceMetrics`
- `CalibrationResult`
- `DrowsinessResult`
- `DrowsinessLevel`
- `TrackingStatus`

### 4.2 `eye_metrics.py`

目に関する計算を定義する。

責務:

- 左右の目ランドマークindex定義
- 片目EAR算出
- 両目平均EAR算出

### 4.3 `head_pose.py`

頭部姿勢に関する計算を定義する。

責務:

- MediaPipeのtransformation matrixからPitch / Yawを算出
- 正面向き判定に必要な値を返す

### 4.4 `face_analyzer.py`

MediaPipe Face Landmarkerの実行と解析結果の正規化を行う。

責務:

- BGR画像をMediaPipe入力へ変換
- 顔検出
- EAR / Pitch / Yaw算出
- 顔未検出時の `None` または `TrackingStatus` 返却
- GUI表示に必要なランドマーク情報の返却

### 4.5 `calibration.py`

キャリブレーション状態管理を行う。

仕様:

```text
対象: 5秒間 / 25フレーム
成功条件: 有効フレーム15以上
有効条件: 顔検出あり、|Yaw_deg| <= 15、|Pitch_deg| <= 15
EAR_open: 有効フレームEAR中央値
EAR_threshold: EAR_open * 0.75
```

### 4.6 `drowsiness.py`

眠気スコア算出を行う。

責務:

- 閉眼判定
- PERCLOS計算
- score算出
- `normal` / `caution` / `warning` / `danger` 判定
- `shouldPause` 判定

スコア式は `docs/features/08-drowsiness-scoring.md` を一次仕様とする。

## 5. ローカルGUI検証アプリのMVP

`src/worker/gui` のMVPは、OpenCV GUIで実装する。

### 5.1 起動時の処理

```text
1. Webカメラを開く
2. MediaPipe FaceAnalyzerを初期化する
3. フレーム取得ループを開始する
4. 各フレームをsharedの解析ロジックへ渡す
5. 解析結果をカメラ映像上にoverlay表示する
```

### 5.2 表示項目

GUI上では少なくとも以下を表示する。

- 目ランドマーク
- EAR
- Pitch / Yaw
- キャリブレーション状態
- 有効フレーム数 / 総フレーム数
- `EAR_open`
- `EAR_threshold`
- PERCLOS
- score
- level
- `shouldPause`

### 5.3 操作

| キー | 操作 |
| --- | --- |
| `q` | 終了 |
| `c` | キャリブレーション開始またはリセット |
| `r` | 眠気スコア状態をリセット |
| `space` | 一時停止 / 再開 |

## 6. 本番WorkerとGUIの処理差分

### 6.1 本番Worker

```text
Service Bus message
  -> Blob Storageから独立JPEGフレーム取得
  -> 単独JPEGデコード
  -> shared FaceAnalyzer
  -> shared CalibrationTracker
  -> shared DrowsinessScorer
  -> Redis / Backend解析結果API
  -> BackendのPostgreSQL / Outbox / SignalR
```

### 6.2 ローカルGUI

```text
Webカメラフレーム
  -> shared FaceAnalyzer
  -> shared CalibrationTracker
  -> shared DrowsinessScorer
  -> GUI overlay
```

GUIは本番I/Oの代替ではなく、顔トラッキングと眠気判定ロジックをローカルで観察するための検証アプリである。

## 7. 実装順序

1. 既存の顔解析ロジックを `src/worker/shared` へ移動する。
2. `shared` にキャリブレーションロジックを追加する。
3. `shared` に眠気スコア算出ロジックを追加する。
4. `src/worker/gui` にOpenCV GUI MVPを作成する。
5. GUIでEAR / Pitch / Yaw / キャリブレーション / scoreを手動確認する。
6. 本番 `src/worker/app` から `shared` を呼び出す形でService Bus / Blob / Redis / Backend解析結果APIへ接続する。DB保存とSignalR配信はBackendが所有する。

## 8. テスト方針

### 8.1 shared

ユニットテスト対象:

- EAR算出
- Pitch / Yaw算出
- 正面向き判定
- キャリブレーション成功/失敗判定
- `EAR_open` / `EAR_threshold` 算出
- PERCLOS算出
- score算出
- level判定
- `shouldPause` 判定

### 8.2 gui

GUIは手動確認を基本とする。

確認項目:

- カメラが起動する
- 顔検出状態が表示される
- 目ランドマークが表示される
- 開眼/閉眼でEARが変化する
- 顔向きでPitch / Yawが変化する
- `c` キーでキャリブレーションできる
- キャリブレーション成功後にscoreが表示される
- 閉眼継続時にPERCLOS / score / levelが上がる

### 8.3 app

本番Workerは結合テストを中心にする。

確認項目:

- Service Busメッセージを処理できる
- Blobからフレームを取得できる
- shared解析ロジックを呼び出せる
- キャリブレーション結果をBackend解析結果APIへ冪等送信できる
- 眠気スコアをBackend解析結果APIへ冪等送信できる
- Backend配信用の解析結果payloadを生成できる

## 9. モデルファイル

MediaPipe Face Landmarkerを使用するため、`.task` モデルファイルが必要である。

配置:

```text
src/worker/models/face_landmarker.task
```

ローカル GUI / Worker 開発では、モデルファイルを `src/worker/models/` に Git 管理外の実行時アセットとして配置する。Azure 向け Worker image は Docker build 時に公式 MediaPipe URL から同じモデルをダウンロードし、固定 SHA-256 を検証して `/app/models/face_landmarker.task` に含める。

## 10. 注意事項

- `shared` は本番WorkerとGUIの両方から使うため、外部サービス依存を持たせない。
- Redis版PERCLOSとGUI用オンメモリPERCLOSでスコア式が分岐しないよう、score / level / shouldPause の式は `shared` に集約する。
- GUIはローカル検証用であり、Featureの外部挙動を完成させるものではない。
- 本番での永続化・通知責務はBackendが所有し、`src/worker/app` はBackend解析結果APIへの送信を担う。
