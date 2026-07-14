# JPEGフレームデコード機能仕様

## 実装優先度

- 優先度: 05
- 理由: 顔認識の入力となる画像フレームをWorkerで復元するため。

## 1. 機能概要

WorkerがService BusからBlob参照情報を受信し、Blob Storageから取得した単独でデコード可能な `image/jpeg` フレームをデコードして画像フレームを復元する機能である。

## 2. 対象コンポーネント

- Worker
- Service Bus
- Blob Storage

## 3. トリガー

WorkerがService Busからフレーム参照メッセージを受信する。

## 4. 入力

Service Busメッセージ:

```json
{
  "sessionId": "uuid",
  "sequenceNo": 1,
  "blobPath": "sessions/3f8c.../frames/000001.bin",
  "capturedAt": "2026-06-14T10:00:00.000Z",
  "videoTimeSec": 123.45,
  "receivedAt": "2026-06-14T10:00:00.050Z",
  "codec": "image/jpeg"
}
```

`blobPath` は `sessions/{sessionId}/frames/{sequenceNo}.bin` とする。現行実装では `{sequenceNo}` をゼロ埋めしてよい。

WorkerはBlob Storage上のJPEGバイナリを取得して処理する。`capturedAt` はUTC時刻、`videoTimeSec` は動画教材内の再生位置を秒で表す0以上の有限値である。

## 5. デコード契約

- `codec` は `image/jpeg` でなければならない。
- 各Blobは単独でデコード可能なJPEG画像であり、前後のフレームまたはWorkerのローカル状態を必要としない。
- WorkerはJPEGをOpenCVで画像フレームへ復元し、顔ランドマーク推論へ渡す。

## 6. フレーム処理

Workerは各メッセージについて以下を行う。

1. `sessionId`、`sequenceNo`、`blobPath`、UTCの `capturedAt`、0以上の有限値である `videoTimeSec`、および `codec: image/jpeg` を検証する。
2. BlobからJPEGバイナリを取得する。
3. JPEGを単独でデコードして画像フレームを復元する。
4. 復元した画像フレームを顔ランドマーク推論へ渡す。
5. 解析結果がBackendに受理された後、Redisの永続冪等キーを用いて同じ `(sessionId, sequenceNo)` を再解析しない。

Service Bus Sessionにより同一 `sessionId` のメッセージは直列に処理する。この直列性はキャリブレーションとPERCLOS状態の順序を守るためのものであり、JPEGデコードのフレーム間依存を意味しない。

## 7. 欠落・順序不整合時の扱い

フレームの欠落または `sequenceNo` の不連続を検知しても、Workerは後続の有効なJPEGフレームを破棄しない。それぞれを単独でデコードし、処理を継続する。

欠落、順序不整合、およびWorker再起動は、JPEGをデコードできない理由ではない。Worker再起動後も、次に取得した有効なJPEGフレームから処理を再開する。セッション直列処理、キャリブレーション、PERCLOS状態、およびRedis冪等性は維持する。

## 8. 実装設計

- 現行実装の `codec` は `image/jpeg` とする。
- Blobパス、メッセージ配送完了、再試行、dead-letter、およびRedis冪等性は [`04-frame-storage-and-queue.md`](./04-frame-storage-and-queue.md) に従う。
- 顔ランドマーク推論と顔未検出時の扱いは [`06-face-recognition.md`](./06-face-recognition.md) に従う。
