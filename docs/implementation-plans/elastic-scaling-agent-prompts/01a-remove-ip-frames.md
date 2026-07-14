# Task 01a: I/Pフレームを撤廃し、独立JPEGフレームへ統一する

以下をそのまま実装Agentへの依頼文として使用する。

---

あなたはこのリポジトリの映像フレーム契約・Frontend・Backend・Worker横断実装担当Agentです。作業ルートは `workspace` です。

## 前提

Task 01（WorkerのSession並列化）は完了済みです。本タスクはその実装を前提に、真の差分Pフレームを導入せず、I/Pフレームという概念そのものを廃止します。

この決定は、現行Frontendが実際にはすべてのフレームを独立した `image/jpeg` として送っている事実に基づきます。

## 最重要ルール

1. 最初に `AGENTS.md` を読み、Feature / Scenario firstを厳守してください。
2. これはWebSocket、Blob、Service Bus、Worker入力の外部契約変更です。実装前に一次仕様を更新してください。
3. I/P互換モード、GOP、`frameType`、`baseIFrameSequenceNo`、Iフレーム強制、Pフレーム復旧を残さないでください。
4. `codec` は現行どおり `image/jpeg` に固定します。動画codecやWebCodecsを導入しないでください。
5. フレームはすべて独立JPEGであり、Workerは各フレームを単独でデコード・顔解析します。
6. ただし、キャリブレーション、PERCLOS、眠気スコアは引き続き `sessionId` 単位で順序どおり状態更新します。
7. Task 01で実装済みの複数Session slot、graceful shutdown、Service Bus lock、Redis冪等性を壊さないでください。
8. 同時利用者数を固定値で実装しないでください。
9. 既存の認証・認可、SignalR payload、Backend結果API、キャリブレーション、自動停止、顔未検出の外部挙動を変えないでください。
10. 開発・デモ用途でも、デプロイ中に旧Frontendと新Backendを混在させる互換レイヤーを追加しないでください。FrontendとBackendを同じreleaseで更新する前提とし、必要な破壊的変更をドキュメント化してください。
11. `git --no-pager diff --check` は使用しないでください。

## 目的

映像フレーム経路を次へ統一してください。

```text
Webカメラ
→ 独立JPEGフレーム
→ WebSocket JSON
→ Blob Storage
→ Service Bus参照メッセージ
→ Workerの単独JPEGデコード
→ 顔解析
→ Session単位のCalibration / PERCLOS / score
```

I/P差分復元、GOP、デコーダ状態、Pフレーム欠落時の次Iフレーム復旧をすべて不要にします。

## 最初に読むファイル

一次仕様:

- `docs/features/02-webcam-capture.md`
- `docs/features/03-video-frame-sending.md`
- `docs/features/04-frame-storage-and-queue.md`
- `docs/features/05-frame-decoding.md`
- `docs/features/06-face-recognition.md`
- `docs/features/07-calibration.md`
- `docs/features/08-drowsiness-scoring.md`
- `docs/scenarios/student-learning-happy-path.md`
- Task 00で追加された弾力的セッション処理Feature / Scenario

二次仕様:

- `docs/frontend/spec.md`
- `docs/backend/spec.md`
- `docs/worker/spec.md`
- `docs/operations/production-setup.md`

実装:

- `src/frontend/app/student/session/student-session-page.tsx`
- `src/frontend/app/test/page.tsx`
- `src/backend/Awaver.Backend/WebSockets/FrameMessageParser.cs`
- `src/backend/Awaver.Backend/WebSockets/FrameWebSocketEndpoint.cs`
- `src/backend/Awaver.Backend/Services/ReceivedFrame.cs`
- `src/backend/Awaver.Backend/Services/FrameQueueMessage.cs`
- `src/backend/Awaver.Backend/Services/FrameBlobPath.cs`
- `src/backend/Awaver.Backend/Services/FramePipeline.cs`
- `src/worker/app/main.py`
- `src/worker/app/analyzer/frame_decoder.py`
- 関連するBackend / Worker / Frontendテスト

作業前に、リポジトリ全体で以下を検索し、I/P前提を残さない変更範囲を確定してください。

```text
frameType
baseIFrameSequenceNo
FrameType
BaseIFrameSequenceNo
Iフレーム
Pフレーム
GOP
forceNextIFrame
```

## 新しい確定フレーム契約

### Browser → Backend WebSocket

接続先は維持します。

```text
/ws/sessions/{sessionId}/frames
```

1 WebSocket text message = 1独立JPEGフレームです。

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

削除するフィールド:

```text
frameType
baseIFrameSequenceNo
```

維持する事項:

- 640×480 / 5fps相当
- `sequenceNo` はsession内で単調増加
- `capturedAt` はUTC
- `videoTimeSec` は0以上の有限値
- `codec` は `image/jpeg`
- `payloadBase64` はBase64化された独立JPEG
- 既存のメッセージ・Base64・復元後JPEGのサイズ上限
- `frame_ack` / `frame_nack`
- WebSocket認証・認可

### Backend → Blob Storage

Blob本体は独立JPEGバイナリです。

パスはフレーム種別を含めません。

```text
sessions/{sessionId}/frames/{sequenceNo}.bin
```

既存のゼロ埋め規則は保持してよいですが、`_I` / `_P` suffixは廃止してください。

### Backend → Service Bus

Service Bus messageから以下を削除します。

```text
frameType
baseIFrameSequenceNo
```

新しい参照message:

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

以下は維持します。

- `SessionId = sessionId`
- `MessageId = sessionId:sequenceNo`
- Session有効queue
- Blob保存成功後だけenqueue
- Backend `frame_ack` はBlob保存とqueue投入成功後に返す

### Worker

- 各Blobを単独JPEGとしてOpenCV等でデコードする。
- `frame_decoder.py` にI/P状態、GOP、base I-frame、Pフレーム受理可否を残さない。
- `FrameReference` 等のモデルからI/P由来フィールドを削除する。
- `sequenceNo` は重複排除・スコア状態の順序・観測追跡に使い続ける。
- Session queueにより同一sessionを順序受信する。
- フレーム番号に欠落があっても、後続の独立JPEGを捨てない。
- 欠落フレームはPERCLOSのサンプル不足として扱い、次の有効フレームから通常どおり解析する。
- Worker再起動後も、次の独立JPEGから直ちに解析を再開できる。

## 実装手順

### T1. 一次仕様と二次仕様を更新する

以下からI/P差分フレームの契約を削除し、独立JPEGフレーム仕様へ統一してください。

- `docs/features/03-video-frame-sending.md`
- `docs/features/04-frame-storage-and-queue.md`
- `docs/features/05-frame-decoding.md`
- 必要な関連Feature
- `docs/scenarios/student-learning-happy-path.md`
- Task 00で追加したFeature / Scenario
- `docs/frontend/spec.md`
- `docs/backend/spec.md`
- `docs/worker/spec.md`
- `docs/operations/production-setup.md`

特に次を削除または置換してください。

- Iフレーム1秒周期
- Pフレーム
- Bフレーム
- GOP
- base I-frame
- Pフレーム欠落時に次Iフレームへ復旧
- I/Pデコーダ状態

`frameType` がJPEGのサイズ差を意味するかのような記述も残さないでください。

### T2. Frontend送信を独立JPEGへ統一する

- `frameType` / `baseIFrameSequenceNo` を送信しない。
- Iフレーム周期計算を削除する。
- `forceNextIFrame` および再接続時のIフレーム強制を削除する。
- 再接続後も `sequenceNo` を維持し、次の独立JPEGを送る。
- 既存の5fps、JPEG品質、送信中ガード、ACK / NACK再送、WebSocket再接続を維持する。
- `/test` ページも同じ新契約へ更新する。

### T3. Backendフレーム契約を更新する

- WebSocket parser、DTO、`ReceivedFrame`、Blob path、Queue message、pipeline、テストからI/Pフィールドを削除する。
- JPEG validation、サイズ上限、session ID一致、UTC timestamp、`videoTimeSec` validationを維持する。
- Blob pathからframe type suffixを削除する。
- Service Bus referenceの検証からframe type / base Iを削除する。
- 既存のWebSocket close code、ACK/NACK、認証・認可を維持する。
- 不要になったenumや型を削除し、死んだ分岐を残さない。

### T4. Workerを独立JPEGデコードへ更新する

- `FrameDecoder` を独立JPEGデコーダへ単純化するか、適切な名前へ置換する。
- I/Pデコーダ状態を削除する。
- WorkerのService Bus reference parserからI/P由来フィールドを削除する。
- Blob path regexを新形式へ変更する。
- 任意の有効な独立JPEGは、過去フレームに依存せず顔解析へ渡す。
- 欠落した`sequenceNo`を理由に後続フレームを破棄しない。
- Task 01の複数Session slot、graceful shutdown、lock更新、retry、dead-letter、Redis processed keyを維持する。
- Calibration / PERCLOS / scoreがsession単位で順序更新されることを維持する。

### T5. テスト・負荷試験契約を更新する

- Frontend、Backend、Workerのpayload fixtureからI/Pフィールドを削除する。
- I/P復旧テストを「フレーム欠落後も後続独立JPEGを解析する」テストへ置換する。
- WebSocket再接続後はIフレームを強制しないことを確認する。
- 可変負荷試験は、各Sessionについて連続する独立JPEGと`sequenceNo`を生成する。
- 既存のScenario E2Eが新契約で通ることを確認する。

## 必須テスト

1. Frontendが新payloadに `frameType` と `baseIFrameSequenceNo` を含めない。
2. Backendが新payloadを受理し、JPEG validationを維持する。
3. BackendがBlob pathをframe type suffixなしで保存する。
4. Service Bus messageにI/Pフィールドが含まれない。
5. Workerが独立JPEGを単独でデコードして顔解析へ渡す。
6. `sequenceNo` に欠落があっても、後続JPEGを処理する。
7. 同じ`sequenceNo`の重複配送は再解析・重複保存しない。
8. Worker再起動相当後の最初の独立JPEGを処理できる。
9. WebSocket再接続後、`sequenceNo` を継続し、I/P関連フィールドなしで送信する。
10. 既存のキャリブレーション成功・失敗、顔未検出、danger自動停止、normal復帰、Outbox通知が通る。
11. 既存のWebSocket認証・他session拒否・ACK/NACK再送が通る。
12. リポジトリの本番コード・現行仕様から、I/P契約の参照が除去されている。履歴文書や本Task自身は除外してよい。

## 破壊的変更の文書化

本変更はWebSocket payloadとService Bus messageの破壊的変更です。

- FrontendとBackendは同じreleaseで更新する。
- ローカル開発・デモでは旧queueのメッセージを処理対象にしない。
- デプロイ前に既存frame queueをdrainまたは再作成する手順をoperations documentへ追記する。
- Blob frameは短期保持であり、旧パス形式の移行を不要とする前提を明記する。異なる運用要件が既存仕様にある場合は、先に報告する。

## write scope

- 関連Feature / Scenario / component spec / operations doc
- `src/frontend/app/student/session/**`
- `src/frontend/app/test/**`
- `src/backend/Awaver.Backend/WebSockets/**`
- `src/backend/Awaver.Backend/Services/ReceivedFrame.cs`
- `src/backend/Awaver.Backend/Services/FrameQueueMessage.cs`
- `src/backend/Awaver.Backend/Services/FrameBlobPath.cs`
- `src/backend/Awaver.Backend/Services/FramePipeline.cs`
- 関連Backend tests
- `src/worker/app/**`
- 関連Worker tests
- 負荷試験・E2E fixture

Task 02以降のBackend SignalR / Outbox実装が未着手なら、そのコア実装には手を出さないでください。Task 02以降がすでに進行中なら、競合するファイルを先に調整してください。

## 非対象

- H.264、VP8、VP9、AV1などの動画codec導入
- WebCodecs導入
- バイナリWebSocket protocol化
- JPEG品質・解像度・fps変更
- 顔解析・眠気スコア式の変更
- Worker Session並列化の再設計
- SignalR / Outboxの仕様変更

## 検証

変更箇所に近い順に実行する。

- Frontend型チェック・lint・関連テスト
- Backend frame parser / WebSocket / pipeline tests
- Worker JPEG decoder / queue reference / reliability tests
- PostgreSQL / Redis / Azurite / Service Bus Emulatorを使った結合テスト
- 既存の受講者Scenario E2E
- 可変Session数の負荷試験の小規模実行

## 完了条件

- I/Pフレーム、GOP、差分デコードの実装契約がなくなっている。
- Browser、Backend、Blob、Service Bus、Workerが独立JPEG契約で一致する。
- Workerは任意の有効JPEGを過去フレームに依存せず解析できる。
- `sequenceNo` の欠落が後続フレーム破棄の理由にならない。
- Session単位のCalibration / PERCLOS / score順序処理と冪等性を維持する。
- Task 01で実装済みのWorker並列化とshutdownを壊していない。
- 破壊的変更のデプロイ手順が文書化されている。
- 関連テストが通る。

## 完了報告

1. 更新したFeature / Scenarioと新しいフレーム契約。
2. 削除したI/P関連の型・状態・分岐。
3. Frontend / Backend / Worker / Queue / Blob pathの変更。
4. 破壊的変更のデプロイ手順。
5. 実行したテストと結果。
6. 残課題。
