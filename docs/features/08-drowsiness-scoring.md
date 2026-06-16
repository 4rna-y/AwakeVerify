# 眠気スコア算出機能仕様

## 実装優先度

- 優先度: 08
- 理由: 自動停止判定、リアルタイム通知、教員ダッシュボードの中核データを生成するため。

## 1. 機能概要

顔認識機能で算出したEAR・Pitch・Yawを用いて、PERCLOSベースの眠気スコアと眠気レベルを算出する機能である。

算出結果は1秒単位でPostgreSQLへ保存し、SignalR通知に使用する。

## 2. 対象コンポーネント

- Worker
- Redis
- PostgreSQL

## 3. トリガー

Workerが顔ランドマーク推論結果からEAR・Pitch・Yawを算出する。

## 4. 入力

- EAR
- Pitch_deg
- Yaw_deg
- キャリブレーションで得た `EAR_threshold`

## 5. 閉眼判定

```text
EAR < EAR_threshold の場合、閉眼フレームとして扱う
```

## 6. PERCLOSスライディングウィンドウ

PERCLOSは以下の条件で算出する。

```text
15秒スライディングウィンドウ
75フレーム
```

Redis上にセッションごとのスライディングウィンドウ状態を保持する。

Luaスクリプトで原子的に以下を行う。

```text
LPUSH
LTRIM
LRANGE
```

用途:

- Workerのスケールアウト時の競合防止
- セッションごとのPERCLOS状態共有

## 7. スコア式

```text
w_yaw = max(1.0 − |Yaw_deg| / 45.0, 0.0)
EAR_score = min(PERCLOS / 0.5, 1.0) × w_yaw
score = min(EAR_score × (1 + 0.3 × min(Pitch_deg / 30.0, 1.0)), 1.0)
```

## 8. 眠気レベル

```text
normal:  score < 0.25
caution: 0.25 <= score < 0.50
warning: 0.50 <= score < 0.75
danger:  0.75 <= score <= 1.00
```

## 9. 自動停止判定

```text
level == danger
または
score >= 0.75
```

この場合、SignalR通知の `shouldPause` を `true` とする。

## 10. 顔未検出時の扱い

顔未検出フレームはPERCLOS計算に含めない。

顔未検出のみの期間は、スコア保存対象としない。

## 11. 1秒単位保存仕様

Workerは5フレームの平均値を1秒単位でPostgreSQLへ保存する。

保存対象:

- score
- level
- perclos
- ear
- pitch_deg
- yaw_deg

保存先:

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
```

## 12. 関連機能

- `06-face-recognition.md`
- `07-calibration.md`
- `09-realtime-notification.md`
- `10-auto-pause-resume.md`
