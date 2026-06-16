# リアルタイム通知機能仕様

## 実装優先度

- 優先度: 09
- 理由: Workerの推論結果を受講者画面へ即時反映し、自動停止制御につなげるため。

## 1. 機能概要

Workerが算出した眠気スコア、および顔未検出などのトラッキング状態を、Azure SignalR Service経由でフロントエンドへリアルタイム通知する機能である。

## 2. 対象コンポーネント

- Worker
- バックエンド
- Azure SignalR Service
- フロントエンド

## 3. トリガー

以下のいずれかが発生したときに通知する。

- Workerが眠気スコアを算出した。
- Workerが顔未検出を検知した。

## 4. 眠気スコア通知

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

## 5. 顔未検出通知

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

## 6. フロントエンドでの扱い

### 6.1 眠気スコア通知

- 現在の眠気レベルを画面に表示する。
- `level === "danger"` または `shouldPause === true` の場合、動画を自動停止する。
- `level === "normal"` に戻るまで再開ボタンを無効化する。

### 6.2 顔未検出通知

受講者画面では以下の警告を表示する。

```text
顔が検出できません。カメラ位置を調整してください。
```

顔未検出のみを理由に動画停止はしない。

## 7. バックエンドの責務

バックエンドはSignalRの接続・配信基盤を提供する。

## 8. 関連機能

- `06-face-recognition.md`
- `08-drowsiness-scoring.md`
- `10-auto-pause-resume.md`
- `14-teacher-dashboard.md`
