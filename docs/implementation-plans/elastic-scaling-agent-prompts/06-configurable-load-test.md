# Task 06: 可変同時Session数の負荷・分散テストを追加する

以下をそのまま実装Agentへの依頼文として使用する。

---

あなたはこのリポジトリの負荷試験・信頼性検証担当Agentです。作業ルートは `workspace` です。

## 依存

- Task 01: Worker Session並列化
- Task 04: Backend複数instance対応

実装済みの設定、health endpoint、WebSocket / SignalR契約を確認してください。

## 最重要ルール

1. 最初に `AGENTS.md` を読む。
2. 固定の30人テストにしない。並列Session数と時間を実行時設定にする。
3. Azure実環境へ無断で大規模負荷をかけない。
4. 通常の単体テストで長時間負荷試験を毎回走らせない。
5. 実カメラを多数必要としないfixture方式にする。
6. 認証を省略しない。各Sessionは独立したCookie / principalを持つ。
7. payload・Cookie・token・学生IDをログへ出さない。
8. `git --no-pager diff --check` は使用しない。

## 目的

Devcontainer上で動作するCLI形式の負荷生成ツールを追加し、Azureにデプロイした検証用BackendおよびWorkerを対象に、同時利用Session数を変更できる負荷・分散試験を実施できるようにしてください。

- WebSocketフレーム受信能力
- ACK / NACK
- Service Bus / ACA WorkerのSession分散・backlog autoscale
- SignalR通知のsession分離
- フレーム送信から結果通知までの遅延
- ACA Worker / Backend増減時の再配送と冪等性

## 実行トポロジー

負荷生成器はDevcontainer上のCLIとして実行する。Azure Container Appsへ負荷生成器をデプロイしてはならない。CLIが直接接続する先はAzure検証環境のBackendであり、Worker ACAへHTTPまたはWebSocketで直接接続してはならない。

```text
Devcontainer load-test CLI
→ Azure Backend（App Service等）
→ Blob Storage
→ Azure Service Bus Session queue
→ Azure Container Apps Worker
→ Backend解析結果API / Outbox
→ Azure SignalR
→ Devcontainer load-test CLI
```

この経路により、Service Bus backlogをトリガーとするWorker ACAのscale-out / scale-in、Session lock解放後の引継ぎ、Backend複数instanceとAzure SignalRを含めて検証する。`API_BASE_URL`はAzure検証用BackendのHTTPS URLを指す。ローカルBackendを対象にするのはシナリオ開発・小規模確認だけとする。

## 設定

最低限、以下に相当する設定を持たせる。

```text
CONCURRENT_SESSIONS
DURATION_SECONDS
FRAMES_PER_SECOND
FRAME_FIXTURE
API_BASE_URL
ALLOW_AZURE_LOAD_TEST
```

必要なら次も追加する。

```text
RAMP_UP_SECONDS
RESULT_TIMEOUT_SECONDS
MAX_IN_FLIGHT_FRAMES
OUTPUT_PATH
```

- 既定値はローカルで安全に実行できる小さい値にする。
- 非正値や異常な値を検証する。
- `API_BASE_URL`がAzureのHTTPS endpointを指す場合、`ALLOW_AZURE_LOAD_TEST=true`を必須とする。未指定ならAzure向け実行を拒否する。
- Azure向け高負荷実行には、上記フラグに加え、実行対象URL、同時Session数、時間、推定コスト影響を開始前に表示して確認する。
- `API_BASE_URL`、Cookie、token、学生ID、frame payloadを結果レポートまたはログへ出力しない。

## 実装方式

既存依存と開発言語を調査し、Devcontainerで実行可能な独立CLIとして最小の追加で実装する。Azure上の実行基盤やACA Jobを負荷生成器のために追加しない。

第一候補はNode.js / TypeScriptとする。Frontendの既存 `@microsoft/signalr`、WebSocket契約、TypeScriptの設定を再利用しやすく、CookieをSessionごとに分離して保持し、JSON形式の結果レポートを生成しやすいためである。

他方式を採用する場合:

- PythonでCookie jar、WebSocket、SignalR対応ライブラリを利用
- .NETの既存SignalR clientを利用

依存追加が必要なら理由を明記する。

## シナリオ

各仮想Sessionは、`API_BASE_URL`で指定されたAzure検証用Backendに対して以下を実行する。

1. `POST /api/sessions` で独立した受講Sessionを作成する。
2. レスポンスCookieをそのSession専用に保持する。
3. `/ws/sessions/{sessionId}/frames` へ接続する。
4. `/hubs/analysis-events` へ接続する。
5. `JoinSession(sessionId)` を呼ぶ。
6. 指定fpsで有効なJPEGフレームJSONを送信する。
7. ACK / NACKを記録する。
8. SignalRの解析結果を記録する。
9. 他Sessionの通知を受信していないことを検証する。
10. 終了時に接続を正常に閉じる。

## フレーム生成

既存契約に従う。

```json
{
  "sessionId": "uuid",
  "sequenceNo": 1,
  "capturedAt": "2026-06-14T10:00:00.000Z",
  "videoTimeSec": 0.0,
  "codec": "image/jpeg",
  "payloadBase64": "..."
}
```

- すべてのフレームは独立したJPEGであり、I/P、GOP、base I-frameメタデータを生成しない。
- `sequenceNo` はSessionごとに継続する。
- 再接続後もsequenceをリセットしない。
- 再接続後も次の独立JPEGを送信する。
- `videoTimeSec` は送信時点の仮想教材再生位置として生成する。

fixtureは有効なJPEGでなければならない。実画像解析を期待するE2Eでは、利用許諾された顔画像fixtureが既存にある場合だけ利用する。なければtransport負荷テストと実Worker小規模テストを分ける。

## テストを分割する

### A. Transport負荷テスト

目的:

- WebSocket
- Blob
- Service Bus enqueue
- ACK / NACK
- Backend水平スケール

実顔解析結果を必須としなくてよい。

### B. Worker Session並列テスト

fake analyzerまたは既存fixtureを用い、以下を検証する。

- 異なるSessionが並列処理される。
- 同一Sessionの順序が維持される。
- 遅いSessionが他Sessionをブロックしない。

### C. 小規模E2E

実際のAzurite、Service Bus Emulator、Redis、PostgreSQL、Worker、Backend、SignalRを使い、少数Sessionで解析結果まで確認する。

## Azure検証時の事前条件

- `API_BASE_URL`は検証専用BackendのHTTPS URLであり、Devcontainerから到達できる。
- Backendは実際のBlob Storage、Session有効Azure Service Bus queue、Redis、PostgreSQL、Azure SignalRへ接続している。
- WorkerはACA上でService Bus backlog scale rule、Session並列度、min/max replica、termination grace periodを設定済みである。
- Azureの検証用データ、Resource Group、subscription、コスト上限、cleanup担当が明確である。
- 負荷生成器はWorker ACAへ直接接続せず、Backend WebSocketとSignalRだけを使う。

## 集計項目

最低限:

- 作成Session数
- 送信フレーム数
- ACK数
- NACK数
- 再送数
- WebSocket接続失敗数
- WebSocket再接続数
- SignalR再接続数
- 解析結果受信数
- session誤配送数
- フレーム送信から解析結果までの遅延 p50 / p95 / max
- timeout数
- テスト総時間

Service Bus / Worker / Outboxの内部メトリクスが取得可能なら結果へ関連付けるが、secretを要求する複雑な監視連携は必須にしない。

## 障害注入

自動化可能な範囲で次を検証する。

1. Workerを途中停止して再起動する。
2. Backendを途中再起動する、または接続を切断する。
3. SignalR接続を切断して再接続する。
4. 一部フレームの`sequenceNo`を欠落させても、後続の独立JPEGが解析されることを確認する。
5. 同じフレームを重複送信する。

結果として以下を確認する。

- フレームがサイレントに消えない。
- Service Bus再配送またはNACKになる。
- 解析結果が重複保存されない。
- 別Sessionに通知されない。

## write scope

- 新規負荷試験ディレクトリ
- fixture
- 実行スクリプト
- 負荷試験README
- 必要なテスト補助コード

アプリケーション本体の変更は、負荷試験で発見した明確な不具合修正を除いて行わず、修正時は対象Feature / Scenarioを明記する。

## 検証

- 安全な既定値でローカル実行
- 2 Session以上で並列確認
- 設定値検証
- 結果レポート生成
- devcontainer依存サービスを使った小規模E2E

- Azure実行は、対象環境とコスト上限が明確で、`ALLOW_AZURE_LOAD_TEST=true`および開始前確認を満たす場合だけ行う。

## 完了条件

- Session数、時間、fpsを実行時変更できる。
- 各Sessionが独立認証される。
- WebSocketとSignalRの両方を検証する。
- 同一Session順序と異なるSession並列を確認できる。
- 結果が機械可読または再現可能な形式で出力される。
- 通常テストから長時間負荷試験が分離されている。
- 負荷生成CLIはDevcontainerで実行し、Azure検証用Backend経由でACA Workerの分散処理を検証する。

## 完了報告

1. 負荷試験ツールの実行方法。
2. 使用したfixtureと制約。
3. 測定項目。
4. 実行した条件と結果。
5. 発見したボトルネック。
6. Azureで実行する際の安全上・コスト上の注意点。
