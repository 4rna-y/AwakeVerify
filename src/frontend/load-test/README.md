# 可変 Session 負荷・分散テスト CLI

対象一次仕様は Feature 03 の HTTP binary frame transport と「複数受講セッションの動的分散」です。

このツールは **Devcontainer 内でのみ実行する CLI** です。Azure Container Apps / ACA Job にはデプロイしません。接続先は `API_BASE_URL` の Backend だけであり、Worker、Blob、Service Bus、Redis、PostgreSQL、Azure SignalR に直接は接続しません。

## セットアップと実行

依存は Frontend の既存 TypeScript / SignalR client です。frame を送るための WebSocket client 依存はありません。

```sh
pnpm --dir src/frontend install --frozen-lockfile
pnpm --dir src/frontend load-test
```

Backend、Worker、PostgreSQL、Redis、Azurite、Service Bus Emulator を起動してから、まず安全なローカル既定値（2 Session、10 秒、1 fps）で実行します。結果は既定で `src/frontend/load-test-results/report.json` に JSON 出力されます。通常出力とレポートには API URL、Cookie、token、学生 ID、`sessionId`、raw JPEG を含めません。

## 設定

| 変数 | 既定値 | 内容 |
| --- | ---: | --- |
| `CONCURRENT_SESSIONS` | `2` | 同時に作る独立受講 Session 数。正の整数。 |
| `DURATION_SECONDS` | `10` | 各仮想 Session の送信時間。正の整数。 |
| `FRAMES_PER_SECOND` | `1` | Session ごとの capture / offered fps。有限の正数。 |
| `FRAME_FIXTURE` | `load-test/fixtures/transport-test.jpg` | 単独デコード可能な JPEG fixture。 |
| `API_BASE_URL` | `http://localhost:5194` | Backend の HTTP(S) base URL。Worker を指定してはならない。 |
| `ALLOW_AZURE_LOAD_TEST` | `false` | Azure HTTPS endpoint 実行に必要な明示 opt-in。 |
| `RAMP_UP_SECONDS` | `0` | 最初と最後の Session 作成の間隔合計。0 以上の整数。 |
| `RESULT_TIMEOUT_SECONDS` | `15` | 送信後に解析通知を待機する時間。正の整数。 |
| `OUTPUT_PATH` | `load-test-results/report.json` | 機械可読レポート出力先。 |
| `FAULT_INJECTION` | 空 | `signalr-reconnect`,`skip-sequence`,`duplicate-frame` をカンマ区切りで指定。 |

Azure の高負荷条件（5 Session超、60秒超、5fps超）では、開始前に対象 URL、Session 数、時間、推定送信量、コスト影響を端末へ表示し、`ALLOW_AZURE_LOAD_TEST=true` と TTY の `START` 入力がなければ実行しません。この事前確認は永続レポートには保存しません。

## 実行する経路と認証

仮想 Session ごとに `POST /api/sessions` を行い、応答の Session Cookie と CSRF header を専用 Cookie jar / principal に保存します。その後、同じ Cookie と CSRF header を使って次だけを実行します。

1. `POST /api/sessions/{sessionId}/frames/{sequenceNo}` に raw `image/jpeg` body、`X-Frame-Captured-At`、`X-Frame-Video-Time-Sec` を送る。
2. `/hubs/analysis-events` に SignalR 接続して `JoinSession(sessionId)` を呼ぶ。
3. `202 Accepted`、retryable / permanent HTTP rejection、`ReceiveAnalysisEvent` を集計する。
4. Session ID が自分のものではない SignalR event を誤配送として記録する。

Session ごとに最大 1 HTTP request だけを in-flight にします。次の scheduler tick が busy のときは frame を蓄積せず、`framesNotSentDueToInFlightLimit` を増やしつつ `sequenceNo` を欠番として消費します。`429` と `503` だけを、同一 sequence、captured timestamp、video time、JPEG bytes で最大 3 回まで再送します。`400`、`401`、`403`、`409`、`413` とその他の status は permanent failure として再送しません。

`skip-sequence` は後続の独立 JPEG が欠番後も受理・処理可能であることを確認します。`duplicate-frame` は同一 bytes / metadata で同じ route を再 POST して冪等性を確認します。`signalr-reconnect` は解析通知の再接続と `JoinSession` の復元を確認します。

## 測定値と判定

`summary` は `framesOffered`、`framesSent`、`framesNotSentDueToInFlightLimit`、`acceptedFrames`、`retryableRejections`、`permanentRejections`、`retransmissions`、SignalR 再接続、解析結果、誤配送、timeout、frame-to-result latency を記録します。`framesSent` には retry と duplicate injection による HTTP POST を含みます。

`assertions` は、Session 誤配送がないこと、同一 Session の accepted sequence が後退しないこと、指定した複数 Session が作成されたことを出力します。Worker replica / Session slot 分散、Service Bus backlog、Outbox age、ACA replica 数は CLI から直接取得せず、検証環境のメトリクスと実行時刻を照合してください。

## CLI 自体のテスト

```sh
pnpm --dir src/frontend test:load-test
```
