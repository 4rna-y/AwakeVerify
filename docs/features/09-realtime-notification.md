# リアルタイム通知機能仕様

## 実装優先度

- 優先度: 09
- 理由: Workerの推論結果を受講者画面へ即時反映し、自動停止制御につなげるため。

## 1. 機能概要

Workerが算出した眠気スコア、および顔未検出などのトラッキング状態を、SignalR経由でフロントエンドへリアルタイム通知する機能である。

SignalRは本機能の最終仕様であり、受講者画面（`student-session-page.tsx`）の一次通知経路である。バックエンドは `AddSignalR` によるASP.NET Core SignalR Hub（`AnalysisEventsHub`、`/hubs/analysis-events`）を提供し、Azure SignalR接続文字列（`Azure:SignalR:ConnectionString` / `AZURE_SIGNALR_CONNECTION_STRING`）が設定されている場合は `AddAzureSignalR` によりAzure SignalR Serviceを配信基盤として利用する。接続文字列が未設定のローカル開発環境では、同一プロセス内のASP.NET Core SignalRとして動作する。

`GET /api/sessions/{sessionId}/analysis-events` のServer-Sent Eventsは、`/test` ページなどローカル検証用ツール向けのフォールバック経路として残置している。SSEの `data:` に含めるJSON payloadは、SignalRで配信するpayloadと同じ構造であり、`POST /api/sessions/{sessionId}/analysis-results` の受信時に両経路へ同時配信される。

本章をリアルタイム通知payloadおよびSignalR / SSEの関係の一次情報とする。frontend / backend spec では、本章を参照し、各コンポーネントの接続方式と責務のみを補足する。

## 2. 対象コンポーネント

- Worker
- バックエンド
- SignalR Hub（`AnalysisEventsHub`、Azure SignalR Service または ASP.NET Core SignalR）
- Server-Sent Events（`/test` ページ等ローカル検証ツール向けフォールバック）
- フロントエンド

## 3. トリガー

以下のいずれかが発生したときに通知する。

- Workerが眠気スコアを算出した。
- Workerが顔未検出を検知した。

## 4. 通知経路

### 4.1 最終仕様（実装済み）

- バックエンドは `AnalysisEventsHub`（`/hubs/analysis-events`）をSignalR Hubとして公開する。
- フロントエンドは接続確立後、Hubメソッド `JoinSession(sessionId)` を呼び出し、`sessionId` 単位のSignalR Group（`session-{sessionId}`）へ参加する。
- バックエンドは `POST /api/sessions/{sessionId}/analysis-results` を受信すると、該当Groupに対してクライアントメソッド `ReceiveAnalysisEvent` を呼び出し、解析結果payloadを配信する。
- `Azure:SignalR:ConnectionString`（または環境変数 `AZURE_SIGNALR_CONNECTION_STRING`）が設定されている場合は `AddAzureSignalR` によりAzure SignalR Serviceを配信基盤とする。未設定の場合はASP.NET Core SignalRとして同一プロセス内で配信する（ローカル開発はこちらを既定とする）。

### 4.2 SSEフォールバック（ローカル検証ツール向け）

- `/test` ページなど、SignalRクライアントへ未移行のローカル検証ツールは `EventSource` で `GET /api/sessions/{sessionId}/analysis-events` を購読できる。
- バックエンドは `text/event-stream` として解析結果イベントを返す。
- SSEの `data:` に含めるJSON payloadは、SignalRで配信するpayloadと同じ構造である。
- 受講者画面（`student-session-page.tsx`）はSSEを使用せず、SignalRのみに接続する。

## 5. 眠気スコア通知

```json
{
  "type": "drowsiness_score",
  "sessionId": "uuid",
  "scoredAt": "2026-06-14T10:00:00Z",
  "score": 0.82,
  "level": "danger",
  "perclos": 0.61,
  "ear": 0.18,
  "pitchDeg": 12.4,
  "yawDeg": 4.2,
  "shouldPause": true
}
```

眠気レベル:

```text
normal:  score < 0.25
caution: 0.25 <= score < 0.50
warning: 0.50 <= score < 0.75
danger:  0.75 <= score <= 1.00
```

## 6. 顔未検出通知

```json
{
  "type": "tracking_status",
  "sessionId": "uuid",
  "detectedAt": "2026-06-14T10:00:00Z",
  "status": "face_not_detected"
}
```

## 7. フロントエンドでの扱い

### 7.1 眠気スコア通知

- 現在の眠気レベルを画面に表示する。
- `level === "danger"` または `shouldPause === true` の場合、動画を自動停止する。
- `level === "normal"` に戻るまで再開ボタンを無効化する。

### 7.2 顔未検出通知

受講者画面では閉眼時と同様に動画を一時停止扱いにし、以下のPopupを表示する。

```text
title: そこにいる？
content: 顔が検出できません。カメラの状態を確認し、顔と目がしっかり映っているか確認してください！
```

PopupのContent下にはWebカメラFrameを表示する。

### 7.3 SignalR接続エラー時の扱い

- 受講者画面は接続状態（未接続・接続中・接続済み・エラー）を保持し、キャリブレーション開始ボタンは接続済み状態でのみ有効化する。
- `HubConnection` が切断・再接続失敗した場合は接続状態をエラーとして扱い、Backendの起動状態確認を促すメッセージを表示する。
- 再接続成功時（`onreconnected`）は、再度 `JoinSession(sessionId)` を呼び出してGroup購読を復元してから接続済み状態に戻す。

## 8. バックエンドの責務

バックエンドは `AnalysisEventsHub` によるSignalRの接続・配信基盤を提供する。`POST /api/sessions/{sessionId}/analysis-results` を受信すると、該当 `sessionId` のSignalR Groupへ即時配信する。

あわせて `/api/sessions/{sessionId}/analysis-events` のSSE購読APIを提供し、SignalR payloadと同じJSON構造の解析結果イベントを配信する。これはローカル検証ツール向けのフォールバックであり、受講者画面の本番経路ではない。

## 9. 関連機能

- `06-face-recognition.md`
- `08-drowsiness-scoring.md`
- `10-auto-pause-resume.md`
- `14-teacher-dashboard.md`
