# 顔認識機能仕様

## 実装優先度

- 優先度: 06
- 理由: キャリブレーションと眠気スコア算出に必要なEAR・Pitch・Yawを取得するため。

## 1. 機能概要

デコード済み画像フレームから顔を検出し、顔ランドマークを推定する機能である。

本仕様における「顔認識」は、個人を識別する顔認証ではなく、眠気判定に必要な顔検出・顔ランドマーク推定を指す。

## 2. 対象コンポーネント

- Worker
- MediaPipe Face Landmarker
- OpenCV

## 3. トリガー

WorkerがI/Pフレームをデコードし、画像フレームを復元する。

## 4. 入力

I/Pフレームをデコードして得た画像フレーム。

## 5. 推論ライブラリ

MediaPipe Face Landmarkerを使用する。

## 6. 出力

推論結果から以下を算出する。

- EAR
- Pitch_deg
- Yaw_deg

これらの値は以下の機能で使用する。

- キャリブレーション
- PERCLOS計算
- 眠気スコア算出
- 顔未検出通知

## 7. 顔未検出時の扱い

顔未検出フレームはPERCLOS計算に含めない。

顔未検出フレーム単体では `drowsiness_scores` に保存しない。

顔未検出のみを理由に動画停止はしない。

次に顔が検出できた時点で推論とスコア算出を再開する。

## 8. 顔未検出通知

顔未検出時はSignalRで以下の通知を送信する。

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

受講者画面では以下の警告を表示する。

```text
顔が検出できません。カメラ位置を調整してください。
```

## 9. 関連機能

- `05-frame-decoding.md`
- `07-calibration.md`
- `08-drowsiness-scoring.md`
- `09-realtime-notification.md`
