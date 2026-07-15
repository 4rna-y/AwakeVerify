# フレーム保存・キュー投入機能仕様

## 実装優先度

- 優先度: 04
- 理由: HTTPS binary ingressで受理したframeを永続化し、Workerの非同期推論パイプラインへ渡すため。

## 1. 機能概要

BackendがFeature 03のHTTPS binary frame APIで受理した単独でデコード可能な `image/jpeg` frameをBlob Storageへ保存し、Workerが非同期処理できるようService BusへBlob参照情報を投入する機能である。raw JPEG frame用WebSocketおよびBase64 payloadは入力経路に含まない。

## 2. 対象コンポーネント

- Backend
- Blob Storage
- Service Bus
- Worker

## 3. トリガーと入力

Backendが次のHTTP requestを受理する。HTTP request、認可、CSRF、size、JPEG validation、status、client retryの一次契約は[`03-video-frame-sending.md`](./03-video-frame-sending.md)を正とする。

```http
POST /api/sessions/{sessionId}/frames/{sequenceNo}
Content-Type: image/jpeg
X-CSRF-Token: <existing CSRF token>
X-Frame-Captured-At: 2026-07-15T09:00:00.000Z
X-Frame-Video-Time-Sec: 12.4

<raw JPEG bytes>
```

Backendはraw JPEG bytesとroute/headerの `sessionId`、`sequenceNo`、UTCの `capturedAt`、0以上の有限値の `videoTimeSec` を受け、`receivedAt` を付与する。

## 4. Blob Storage保存仕様

### 4.1 保存対象

- 単独でデコード可能な `image/jpeg` のraw JPEG binary

### 4.2 パス形式

```text
sessions/{sessionId}/frames/{sequenceNo}.bin
```

現行実装では `{sequenceNo}` をゼロ埋めしてよい。

## 5. Service Bus投入仕様

Blob Storageへの保存完了後、Service Busへフレーム参照情報を投入する。

```json
{
  "sessionId": "uuid",
  "sequenceNo": 1,
  "blobPath": "sessions/3f8c.../frames/000001.bin",
  "capturedAt": "2026-07-15T09:00:00.000Z",
  "videoTimeSec": 12.4,
  "receivedAt": "2026-07-15T09:00:00.050Z",
  "codec": "image/jpeg"
}
```

`sessionId` をService Bus Session IDに設定し、queueはSession有効化を必須とする。Workerは同時に同一Sessionを複数のreceiverで処理しない。

BackendはBlob保存とqueue enqueueの両方が成功したときだけHTTP `202 Accepted` を返す。Blob保存後のqueue投入失敗などretry可能な依存障害は `503` とし、clientは同じ `(sessionId, sequenceNo)`、metadata、JPEG bytesを再送する。Backendはこの再送を冪等に処理し、同一keyへ異なるmetadataまたはbytesが来た場合は `409 Conflict` とする。BlobとService Bus messageの原子的commitはできないため、この冪等性を維持し、成功未確定のrequestを推測でacceptしてはならない。

## 6. 順序、欠番、Worker配送

同一Sessionのenqueue順はFeature 03のclientごとの1 in-flight制約によりsequence順にする。異なるSessionは並列にenqueue・処理できる。capture tickで意図的にskipされたsequenceの欠番は許容し、Workerは後続の有効JPEGを破棄しない。

Workerがmessageを `complete` できるのは、Blob取得、JPEGデコード、およびそのframeから生じた解析結果のBackend受理がすべて成功した後である。再試行可能な失敗では `abandon` して再配送する。Blobパス不正、対応外codec、必須metadata不正は非再試行エラーとしてdead-letterする。Workerの再配送・冪等性・lockの詳細は[`15-elastic-session-frame-processing.md`](./15-elastic-session-frame-processing.md)を正とする。

## 7. 開発環境方針

- ローカルE2E・手動検証はdevcontainerの**Azurite Blob Storage**と**Azure Service Bus Emulator（Session有効queue）**を標準経路とする。クラウドAzure接続は不要だが、BackendとWorkerは本番と同じBlob／Service Busアダプターを使用する。
- ローカルファイル保存またはmessageのログ出力だけのフォールバックは、個別のBackend単体テストに限るtest doubleとして許可する。受講シナリオ、Worker結合テスト、デモで使用してはならない。ログ出力をキュー投入成功として扱わない。
- Blob Storage上のframe保存期間・削除方針は、[`15-elastic-session-frame-processing.md`](./15-elastic-session-frame-processing.md)を一次情報とする。環境設定とBlob Lifecycle Management Ruleを整合させ、通常の再配送・dead-letter調査に必要な期間より短くしない。
