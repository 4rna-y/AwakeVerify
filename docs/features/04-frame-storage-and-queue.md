# フレーム保存・キュー投入機能仕様

## 実装優先度

- 優先度: 04
- 理由: 受信フレームを永続化し、Workerの非同期推論パイプラインへ渡すため。

## 1. 機能概要

バックエンドがWebSocketで受信した単独でデコード可能な `image/jpeg` フレームをBlob Storageへ保存し、Workerが非同期処理できるようService BusへBlob参照情報を投入する機能である。

## 2. 対象コンポーネント

- バックエンド
- Blob Storage
- Service Bus
- Worker

## 3. トリガー

バックエンドがWebSocketで映像フレームを受信する。

## 4. 入力

WebSocketで受信したエンコード済み映像フレームとフレームメタデータ。各フレームは、送信時点の動画教材内の再生位置を秒で表す `videoTimeSec` を持つ。`videoTimeSec` は0以上の有限値であり、フレーム番号やFPSから算出しない。

WebSocket payloadのメタデータは次のとおりとする。

```json
{
  "sessionId": "uuid",
  "sequenceNo": 1,
  "capturedAt": "2026-06-14T10:00:00.000Z",
  "videoTimeSec": 123.45,
  "codec": "image/jpeg",
  "payloadBase64": "..."
}
```

バックエンドは受信時刻として `receivedAt` を付与する。

## 5. Blob Storage保存仕様

### 5.1 保存対象

- WebSocketで受信した、単独でデコード可能な `image/jpeg` フレーム

Blob本体はデコード前のJPEGバイナリである。

### 5.2 パス形式

```text
sessions/{sessionId}/frames/{sequenceNo}.bin
```

現行実装では `{sequenceNo}` をゼロ埋めして保存してよい。

例:

```text
sessions/3f8c.../frames/000001.bin
sessions/3f8c.../frames/000002.bin
sessions/3f8c.../frames/000003.bin
```

## 6. Service Bus投入仕様

Blob Storageへの保存完了後、Service Busへフレーム参照情報を投入する。

メッセージ形式:

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

## 7. 順序保証と配送完了

Service Busでは `sessionId` をSession IDとして設定する。queueはSession有効化を必須とし、Workerは同時に同一Sessionを複数の受信者で処理しない。

目的:

- 同一受講セッション内のフレーム順序を保証する。
- キャリブレーションおよびPERCLOS状態更新を同一セッション内で直列化する。

BackendはBlobのアップロード成功後にのみ送信する。Blob保存成功後の送信失敗は、WebSocket受信処理の成功として扱わず、frame単位の `frame_nack`（再送可能）を接続元へ返す。送信成功時は `frame_ack` を返す。フレームBlobとService Busメッセージの原子的コミットはできないため、同一 `sessionId` と `sequenceNo` の重複配送を許容する。Workerはこの組み合わせをセッション有効期間をカバーする永続Redis冪等キーで処理し、すでに完了したフレームは再解析しない。

Workerがメッセージを完了（`complete`）できるのは、Blob取得、JPEGデコード、およびそのフレームから生じた解析結果のBackend受理がすべて成功した後である。再試行可能な失敗では `abandon` して再配送する。Blobが一時的に取得できない場合も同様とし、配送回数がqueue設定の上限に達したときにdead-letterする。Blobパス不正、対応外codec、必須メタデータ不正は非再試行エラーとして直ちにdead-letterする。フレームの欠落・順序不整合はdead-letterの理由ではなく、後続の有効なJPEGフレームを継続して処理する。

## 8. 出力

- Blob Storage上のフレームバイナリ
- Service Bus上のBlob参照メッセージ

## 9. 開発環境方針

- 現行実装の `codec` は `image/jpeg` とする。
- WebSocket JSONの `payloadBase64` をバックエンドでバイナリへ復元し、Blob本体として保存する。
- ローカルE2E・手動検証は、devcontainerの **Azurite Blob Storage** と **Azure Service Bus Emulator（Session有効queue）** を標準経路とする。クラウドAzure接続は不要だが、BackendとWorkerは本番と同じBlob／Service Busアダプターを使用する。
- ローカルファイル保存またはメッセージのログ出力だけのフォールバックは、個別のBackend単体テストに限り明示的なtest doubleとして許可する。受講シナリオ、Worker結合テスト、デモで使用してはならない。ログ出力をキュー投入成功として扱わない。
- Blob Storage上の映像フレーム保存期間・削除方針は、[`15-elastic-session-frame-processing.md`](./15-elastic-session-frame-processing.md) を一次情報とする。環境設定とBlob Lifecycle Management Ruleを整合させ、通常の再配送・dead-letter調査に必要な期間より短くしない。
