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

Workerが単独でデコード可能なJPEGフレームをデコードし、画像フレームを復元する。

## 4. 入力

単独でデコード可能なJPEGフレームをデコードして得た画像フレーム。

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

顔未検出時の動画停止・再開は、[`face-not-detected-warning.md`](../scenarios/face-not-detected-warning.md) および [`09-realtime-notification.md`](./09-realtime-notification.md) に従い、受講者画面が通知を受けて制御する。

次に顔が検出できた時点で推論とスコア算出を再開する。

## 8. 顔未検出通知

Workerは顔未検出時、以下のpayloadをBackend解析結果APIへ送信する。Backendが永続的Outboxを経由してSignalRで配信する。

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

受講者画面のPopup文言・WebカメラFrame・復帰時の明示再開は [`face-not-detected-warning.md`](../scenarios/face-not-detected-warning.md) を一次情報とする。

## 9. 関連機能

- `05-frame-decoding.md`
- `07-calibration.md`
- `08-drowsiness-scoring.md`
- `09-realtime-notification.md`
