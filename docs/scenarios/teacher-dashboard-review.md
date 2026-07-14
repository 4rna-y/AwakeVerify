# 管理者による受講状況確認シナリオ

## 1. 目的

管理者がログインし、受講者のセッション一覧、眠気スコア時系列、停止・再開イベントをダッシュボードで確認する流れを定義する。

## 2. アクター

- 管理者
- フロントエンド
- バックエンド
- PostgreSQL
- SignalR

## 3. 前提条件

- 管理者アカウントが作成済みである。
5. 管理者は有効な `admin` HttpOnly認証Cookieを持つか、管理者ログインを完了できる。
6. 各 `learning_sessions` には受講動画を示す `video_id` が保存されている。
- 受講者の `learning_sessions`、Backend所有の `drowsiness_scores`、`playback_events` が保存済みである。
- 管理者が `/admin/login` にアクセスできる。

## 4. Feature path

1. [`12-teacher-login.md`](../features/12-teacher-login.md)
2. [`14-teacher-dashboard.md`](../features/14-teacher-dashboard.md)
3. [`09-realtime-notification.md`](../features/09-realtime-notification.md)
4. [`11-playback-event-recording.md`](../features/11-playback-event-recording.md)

## 5. E2Eフロー

1. 管理者が `/admin/login` にアクセスする。
2. 管理者が管理者IDとパスワードを入力する。
3. フロントエンドが `POST /api/admin/login` を呼び出す。
4. バックエンドが `admins` の `password_hash` と照合し、`admin` roleのHttpOnly認証Cookieを設定する。
5. 認証成功後、フロントエンドがデフォルトで `/admin/dashboard` へ遷移する。
6. フロントエンドが資格情報付きでセッション一覧APIを呼び出す。

   ```http
   GET /api/dashboard/sessions
   ```

7. バックエンドが動画IDを含むセッション一覧を返す。
8. 管理者は動画IDで一覧を絞り込み、対象セッションを選択する。
9. フロントエンドは `/admin/dashboard/sessions/{sessionId}` のセッション詳細ページへ遷移し、セッション詳細APIを呼び出す。

   ```http
   GET /api/dashboard/sessions/{sessionId}
   ```

10. フロントエンドが眠気スコア系列APIを呼び出す。

    ```http
    GET /api/dashboard/sessions/{sessionId}/scores
    ```

11. フロントエンドが停止・再開イベントAPIを呼び出す。

    ```http
    GET /api/dashboard/sessions/{sessionId}/playback-events
    ```

12. フロントエンドが以下を表示する。
    - セッション概要
    - 値軸・観測時刻・動画再生位置（秒）の二軸を持つ眠気スコア時系列グラフ（`score` は常時表示し、`PERCLOS` と `EAR` は任意表示。PERCLOS は個人別 `EAR_threshold` に基づいて算出され、EAR 表示時は `EAR_open` と `EAR_threshold` の基準線を表示する。表示中の各線のホバーで観測時刻・動画再生位置・レベル・数値・EAR基準をツールチップ表示。`videoTimeSec` が `null` の既存スコアは動画再生位置を `—` と表示し、フレーム番号は表示しない）
    - `auto_pause` から次の `resume` までをグラフ背景の網掛けに示した停止区間
    - 各スコアの `normal`、`caution`、`warning`、`danger` を色分けした「スコアタイムライン」
13. 受講が継続中の場合、フロントエンドが認証済みSignalR接続で選択セッションへ参加し、BackendのOutboxから配信された最新の眠気スコアやトラッキング状態をリアルタイム更新する。
14. SignalR再接続成功時、フロントエンドはGroup参加を復元し、一覧と選択セッションのREST APIを再取得して通知欠落を補正する。
15. 管理者が不要な受講記録を削除する場合、フロントエンドは動画ID・学籍番号と削除対象を表示して確認を求める。
16. 管理者が確認すると、フロントエンドが `DELETE /api/dashboard/sessions/{sessionId}` を呼び出す。
17. バックエンドはセッションと関連する解析・再生記録、受講者認証情報を削除し、フロントエンドは一覧と選択状態から削除済みセッションを除外する。

## 6. 期待結果

- 管理者は認証後にダッシュボードへアクセスできる。
- 動画IDごとにセッション一覧を絞り込んで確認できる。
- 選択したセッションの詳細ページで、値軸・観測時刻・動画再生位置（秒）の二軸を持つ眠気スコア系列を確認できる。FPSは契約に含まれないため、フレーム番号は表示しない。
- `PERCLOS` と `EAR` を必要なときだけ重ねて確認でき、PERCLOS の閉眼判定基準と、EAR の開眼値・閉眼閾値を比較できる。
- `score`、表示中の `PERCLOS`、表示中の `EAR` の各線上のホバーで、対象観測時刻・動画再生位置・眠気レベル・数値を確認できる。既存スコアの `videoTimeSec` が `null` の場合、動画再生位置は `—` と表示される。
- 自動停止・再開イベントを、停止中の区間としてグラフ背景の網掛けで確認できる。
- 各スコアの眠気レベルを、色分けされた「スコアタイムライン」で確認できる。
- 受講中のセッションについては、永続化済み結果がSignalR通知により表示更新される。
- SignalR通知を取り逃しても、REST再取得によりPostgreSQLの確定データへ収束する。
- 管理者が確認した受講記録は、関連記録とともに削除でき、削除後は一覧・詳細から参照できない。

## 7. 例外・分岐

- 管理者ログインに失敗した場合、ダッシュボードへ遷移しない。
- 未認証・期限切れ・失効CookieでのダッシュボードAPI／Hub参加は拒否され、ログイン画面へ遷移する。管理者以外のroleは`403`とする。
- セッションに眠気スコアが存在しない場合、グラフは空状態または読み込みなし状態として表示する。
- 停止・再開イベントが存在しない場合、グラフに自動停止区間の網掛けを表示しない。
- 削除対象がすでに存在しない場合は `404` を返し、管理者以外の削除要求は `401` または `403` とする。

## 8. 関連データ

```text
admins
- admin_id
- password_hash
- created_at

learning_sessions
- session_id
- student_id
- video_id
- started_at
- ended_at nullable

drowsiness_scores
- session_id
- scored_at
- score
- level
- perclos
- ear
- pitch_deg
- yaw_deg
- video_time_sec nullable（既存スコアは `null`、新規スコアは必須）

playback_events
- event_id
- session_id
- type
- occurred_at
- video_time_sec nullable
```
