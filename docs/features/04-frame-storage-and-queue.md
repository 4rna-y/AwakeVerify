# フレーム保存・キュー投入機能仕様

## 実装優先度

- 優先度: 04
- 理由: 受信フレームを永続化し、Workerの非同期推論パイプラインへ渡すため。

## 1. 機能概要

バックエンドがWebSocketで受信したI/PフレームをBlob Storageへ保存し、Workerが非同期処理できるようService BusへBlob参照情報を投入する機能である。

## 2. 対象コンポーネント

- バックエンド
- Blob Storage
- Service Bus
- Worker

## 3. トリガー

バックエンドがWebSocketで映像フレームを受信する。

## 4. 入力

WebSocketで受信したエンコード済み映像フレームとフレームメタデータ。

バックエンドは受信時刻として `receivedAt` を付与する。

## 5. Blob Storage保存仕様

### 5.1 保存対象

- Iフレーム
- Pフレーム

Blob本体はエンコード済みフレームのバイナリである。

### 5.2 パス形式

```text
sessions/{sessionId}/frames/{sequenceNo}_{frameType}.bin
```

例:

```text
sessions/3f8c.../frames/000001_I.bin
sessions/3f8c.../frames/000002_P.bin
sessions/3f8c.../frames/000003_P.bin
```

## 6. Service Bus投入仕様

Blob Storageへの保存完了後、Service Busへフレーム参照情報を投入する。

メッセージ形式:

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

## 7. 順序保証

Service Busでは `sessionId` をSession IDとして設定する。

目的:

- 同一受講セッション内のフレーム順序を保証する。
- WorkerがI/Pフレームを順次デコードできるようにする。

## 8. 出力

- Blob Storage上のフレームバイナリ
- Service Bus上のBlob参照メッセージ

## 9. 未決定事項

- Blob Storage上の映像フレーム保存期間・削除方針
- エンコード済みフレームの具体的な `codec`
