# 可変 Session 負荷・分散テスト CLI

対象一次仕様は Feature 15（`docs/features/15-elastic-session-frame-processing.md`）および「複数受講セッションの動的分散」（`docs/scenarios/multi-session-dynamic-distribution.md`）です。

このツールは **Devcontainer 内でのみ実行する CLI** です。Azure Container Apps / ACA Job にはデプロイしません。接続先は `API_BASE_URL` の Backend だけであり、Worker、Blob、Service Bus、Redis、PostgreSQL、Azure SignalR に直接は接続しません。

## セットアップと実行

依存は Frontend の既存 TypeScript / SignalR client に加え、Cookie を WebSocket upgrade に載せるための `ws` です。Devcontainer の post-create 後はインストール済みです。依存を再同期する場合は次を実行します。

```sh
pnpm --dir src/frontend install --frozen-lockfile
```

Backend、Worker、PostgreSQL、Redis、Azurite、Service Bus Emulator を起動してから、まず安全なローカル既定値（2 Session、10 秒、1 fps）で実行します。

```sh
pnpm --dir src/frontend load-test
```

結果は既定で `src/frontend/load-test-results/report.json` に JSON 出力されます。結果レポートおよび通常の完了出力には、`API_BASE_URL`、Cookie、token、学生 ID、`sessionId`、フレーム payload を含めません。

2 Session の小規模 E2E の例です。

```sh
CONCURRENT_SESSIONS=2 \
DURATION_SECONDS=15 \
FRAMES_PER_SECOND=1 \
RESULT_TIMEOUT_SECONDS=15 \
pnpm --dir src/frontend load-test
```

## 設定

| 変数 | 既定値 | 内容 |
| --- | ---: | --- |
| `CONCURRENT_SESSIONS` | `2` | 同時に作る独立受講 Session 数。正の整数。 |
| `DURATION_SECONDS` | `10` | 各仮想 Session の送信時間。正の整数。ramp-up 時間は含まない。 |
| `FRAMES_PER_SECOND` | `1` | Session ごとの requested/offered fps。有限の正数。ACK待機やローカル送信上限により実送信数が下回る場合は結果レポートで可視化する。 |
| `FRAME_FIXTURE` | `load-test/fixtures/transport-test.jpg` | 単独デコード可能な JPEG fixture のパス。 |
| `API_BASE_URL` | `http://localhost:5194` | Backend の HTTP(S) base URL。Worker を指定してはならない。 |
| `ALLOW_AZURE_LOAD_TEST` | `false` | Azure App Service / Azure Container Apps の HTTPS endpoint 実行に必要な明示 opt-in。 |
| `RAMP_UP_SECONDS` | `0` | 最初と最後の Session 作成の間隔合計。0 以上の整数。 |
| `RESULT_TIMEOUT_SECONDS` | `15` | 送信後に ACK / 解析通知を待機する時間。正の整数。 |
| `MAX_IN_FLIGHT_FRAMES` | `5` | Session ごとの未 ACK 上限。正の整数。上限到達時は primary frame を送信せず、`framesNotSentDueToInFlightLimit` に記録する。 |
| `OUTPUT_PATH` | `load-test-results/report.json` | 機械可読レポート出力先。 |
| `FAULT_INJECTION` | 空 | `signalr-reconnect`,`ws-reconnect`,`skip-sequence`,`duplicate-frame` をカンマ区切りで指定。 |

非正値、非数値、存在しない fixture、未対応の障害注入名は開始前に拒否します。Azure recognized HTTPS endpoint は `ALLOW_AZURE_LOAD_TEST=true` なしでは必ず拒否します。

Azure の高負荷条件（5 Session超、60秒超、5fps超）では、開始前に対象 URL、Session 数、時間、推定送信量、コスト影響を端末へ表示し、TTY で `START` を入力しなければ実行しません。この事前確認は永続レポートには保存しません。検証用 Resource Group、subscription、コスト上限、cleanup 担当を確認してから実行してください。

```sh
API_BASE_URL=https://your-validation-backend.azurewebsites.net \
ALLOW_AZURE_LOAD_TEST=true \
CONCURRENT_SESSIONS=10 \
DURATION_SECONDS=120 \
FRAMES_PER_SECOND=5 \
pnpm --dir src/frontend load-test
```

Azure で実行する際は、検証用 Backend の `/health/ready` が利用可能であり、Blob、Session 有効 Service Bus queue、Redis、PostgreSQL、Azure SignalR、ACA Worker の backlog scale rule、replica 範囲、termination grace period が設定済みであることを先に確認してください。Azure 実行はこの README の例をそのまま本番へ向けて実行しないでください。

## 実行する経路と認証

仮想 Session ごとに `POST /api/sessions` を行い、応答の `student_session` / CSRF Cookie をその仮想 Session 専用 Cookie jar に保存します。その Cookie を付けて次だけを実行します。

1. `/ws/sessions/{sessionId}/frames` に接続して、独立 JPEG の JSON frame を送る。
2. `/hubs/analysis-events` に SignalR 接続して `JoinSession(sessionId)` を呼ぶ。
3. ACK / retryable NACK と `ReceiveAnalysisEvent` を記録する。
4. Session ID が自分のものではない SignalR event を誤配送として記録する。
5. WebSocket と SignalR を正常 close する。

各 Session の `sequenceNo` は再接続後も継続します。`skip-sequence` 時も後続 JPEG は独立した有効 frame です。`duplicate-frame` は同じ serialized frame を再送して冪等性検証に使います。ツールは認可を省略せず、Cookie / principal を Session 間で共有しません。

## Fixture とテスト種別

`fixtures/transport-test.jpg` は 1x1 の有効 JPEG であり、顔画像ではありません。そのため通常の CLI は **A. transport 負荷テスト**（WebSocket、Blob、enqueue、ACK/NACK、Backend 水平スケール）として使用します。顔認識結果は期待しません。

- **A. Transport**: この CLI と non-face JPEG を使用する。
- **B. Worker Session 並列**: `src/worker/tests/test_session_concurrency.py` が fake analyzer で異 Session の並列、同一 Session の順序、遅い Session が別 slot を止めないことを検証する。
- **C. 小規模 E2E**: Devcontainer の Azurite / Service Bus Emulator / Redis / PostgreSQL / Backend / Worker / SignalR を起動して上の 2 Session コマンドを使う。実際の顔解析を確認する E2E は、利用許諾された顔画像 fixture が追加された場合だけ別途実施する。

## 測定値と判定

レポートの `summary` には作成 Session 数、requested/offered frame 数（`framesOffered`）、実送信 frame 数（`framesSent`）、in-flight 上限により送信されなかった offered frame 数（`framesNotSentDueToInFlightLimit`）、ACK/NACK、再送、WebSocket 接続失敗・再接続、SignalR 再接続、解析結果、誤配送、ACK timeout、総時間を記録します。`framesSent` は `duplicate-frame` 障害注入による追加送信を含むため、offered frame 数と一致しない場合があります。`frameToResultLatencyMs` は `sourceSequenceNo` を持つ解析通知だけを frame 送信時刻と対応付けて p50 / p95 / max を算出します。通知契約上すべての frame が解析通知を出すわけではないため、latency sample 数は送信数と一致しないことがあります。

`assertions` は以下を出力します。

- `sessionIsolation`: 誤配送が 0 であること。
- `sameSessionAcknowledgementOrder`: 同一 Socket 上の ACK が後退していないこと。
- `parallelSessionsActivated`: 2 以上を指定した場合に独立 Session が 2 以上作成されたこと。

Worker の実際の replica / Session slot 分散、Service Bus backlog、最古メッセージ年齢、Outbox age、ACA replica 数はこの CLI から秘密を要求して直接取得しません。Azure Monitor / ACA / Service Bus の検証環境メトリクスを、レポートの実行時刻と照合してください。

## 障害注入

クライアントだけで安全に自動化できる障害は `FAULT_INJECTION` で指定します。

```sh
FAULT_INJECTION=signalr-reconnect,ws-reconnect,skip-sequence,duplicate-frame \
pnpm --dir src/frontend load-test
```

Worker 停止・再起動、Backend 再起動は、CLI が Worker / Azure 管理 API に直接接続しない制約上、検証環境の運用者が実施します。その間 CLI を実行して、NACK / reconnect / timeout、Service Bus 再配送、Outbox の重複保存防止、Session 誤配送なしを Backend・Worker・Azure メトリクスとともに確認してください。これは本番や無承認の Azure 環境に対して実施してはいけません。

## CLI 自体のテスト

通常の unit/E2E スイートに長時間負荷は加えません。CLI の設定検証、fixture、集計だけは次で短時間に確認できます。

```sh
pnpm --dir src/frontend test:load-test
```
