# 映像フレーム送信機能仕様

## 実装優先度

- 優先度: 03
- 理由: Webカメラ映像をBackendへ届け、後続の保存・キュー投入・推論処理へ接続するため。

## 1. 機能概要

フロントエンドがWebカメラ映像を、それぞれ単独でデコード可能な `image/jpeg` 画像フレームとして、動画再生中にBackendのHTTPS binary frame APIへ1フレームずつ送信する機能である。raw JPEG frame用のWebSocketは提供・使用しない。解析結果の通知はFeature 09のSignalRを維持し、frameをSignalRへ送らない。

## 2. 対象コンポーネント

- フロントエンド
- Backend HTTPS frame ingress

## 3. トリガー

受講セッション開始、Webカメラ映像取得、キャリブレーションモーダル完了後、動画再生開始に応じて送信を開始する。

## 4. Frame transport の最終契約

### 4.1 HTTP request

```http
POST /api/sessions/{sessionId}/frames/{sequenceNo}
Content-Type: image/jpeg
X-CSRF-Token: <existing CSRF token>
X-Frame-Captured-At: 2026-07-15T09:00:00.000Z
X-Frame-Video-Time-Sec: 12.4

<raw JPEG bytes>
```

- `sessionId` はroute parameterと認証CookieのSessionが一致しなければならない。
- `sequenceNo` は正の整数である。
- 同じブラウザタブで受講ページをリロードして再開する場合、Frontendは送信開始前に保存した次の `sequenceNo` から採番を再開する。未完了requestとの衝突を避けるため、直前の番号より大きい番号を用い、欠番は許容する。
- `X-Frame-Captured-At` はUTC timestamp、`X-Frame-Video-Time-Sec` は0以上の有限値である。
- codecは `Content-Type: image/jpeg` に固定する。JSON、Base64 payload、frame種別、前frame参照を受理しない。
- bodyは単独でデコード可能なJPEG binaryであり、最大1 MiBとする。proxyとASP.NET Coreの双方で上限を明示し、chunked requestでも上限を超えて読まない。JPEG validityと既存metadata制約を検証する。

### 4.2 durable acceptance、status、冪等性

- `202 Accepted` はBlob保存とService Bus Session queue enqueueの両方が成功したdurable acceptance boundaryである。単にHTTPを受信しただけでは返さない。
- `(sessionId, sequenceNo)` はframe再送の冪等性単位である。同一keyへ同一metadataと同一JPEG bytesを再送した場合は成功として `202` を返す。同一keyに異なるmetadataまたはJPEG bytesを送った場合は `409 Conflict` とする。
- 不正なJPEGまたはmetadataは `400 Bad Request`、1 MiB超過は `413 Payload Too Large`、認証・CSRF失敗は既存の `401` / `403` 契約に従う。これらおよび `409` はpermanent failureであり再送しない。
- retry可能な依存障害は `503 Service Unavailable`、明示的なBackend admission / capacity制御は `429 Too Many Requests` とする。必要なら `Retry-After` を返す。clientは同じ `sequenceNo`、metadata、JPEG bytesを用いて再送する。

### 4.3 送信順序と欠番

- clientはSessionごとに最大1 in-flight HTTP frame requestとする。`sequence N` のdurable acceptanceを受けるまで `N+1` を送らない。
- 5fpsはcapture / offered rateである。200msの次tickに前requestがin-flightなら古いframeをqueueに貯めず、そのtickのframeを送信しない。`sequenceNo` はcaptureごとに増加するため、意図的な欠番を許容する。
- 同一Sessionの順序は、この1 in-flight制約によりBackendがsequence順にService Bus Session queueへenqueueすることで維持する。HTTP/2 streamの送信順・完了順に依存しない。異なるSessionのrequestは並列に処理できる。
- 各JPEGは独立しているため、Workerは欠番または順序不整合を理由に後続の有効JPEGを破棄しない。

## 5. 受信時の責務

Backendは認可、CSRF、metadata、size、JPEG validityを検証し、受信時刻として `receivedAt` を付与する。Blob保存とService Bus Session queue enqueueの契約はFeature 04を正とする。

## 6. クライアント状態

HTTP requestの一時障害時は同一frameを再送する。permanent failure時は当該frameを再送せず、受講継続可否を画面に示す。SignalR接続の再接続と `JoinSession(sessionId)` の復元はFeature 09に従い、frame ingressの再送契約とは独立して扱う。
