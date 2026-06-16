# 教員による受講状況確認シナリオ

## 1. 目的

教員がログインし、受講者のセッション一覧、眠気スコア時系列、停止・再開イベントをダッシュボードで確認する流れを定義する。

## 2. アクター

- 教員
- フロントエンド
- バックエンド
- PostgreSQL
- SignalR

## 3. 前提条件

- 教員アカウントが作成済みである。
- 受講者の `learning_sessions`、`drowsiness_scores`、`playback_events` が保存済みである。
- 教員が `/teacher/login` にアクセスできる。

## 4. Feature path

1. [`12-teacher-login.md`](../features/12-teacher-login.md)
2. [`14-teacher-dashboard.md`](../features/14-teacher-dashboard.md)
3. [`09-realtime-notification.md`](../features/09-realtime-notification.md)
4. [`11-playback-event-recording.md`](../features/11-playback-event-recording.md)

## 5. E2Eフロー

1. 教員が `/teacher/login` にアクセスする。
2. 教員が教員IDとパスワードを入力する。
3. フロントエンドが `POST /api/teacher/login` を呼び出す。
4. バックエンドが `teachers` の `password_hash` と照合する。
5. 認証成功後、フロントエンドが `/teacher/dashboard` へ遷移する。
6. フロントエンドがセッション一覧APIを呼び出す。

   ```http
   GET /api/dashboard/sessions
   ```

7. バックエンドがセッション一覧を返す。
8. 教員が対象セッションを選択する。
9. フロントエンドがセッション詳細APIを呼び出す。

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
    - 眠気スコア時系列グラフ
    - `auto_pause` / `resume` のタイムライン
13. 受講が継続中の場合、SignalR通知により最新の眠気スコアやトラッキング状態をリアルタイム更新する。

## 6. 期待結果

- 教員は認証後にダッシュボードへアクセスできる。
- セッション一覧を確認できる。
- 選択したセッションの眠気スコア系列を確認できる。
- 自動停止・再開イベントをタイムラインで確認できる。
- 受講中のセッションについてはSignalR通知により表示が更新される。

## 7. 例外・分岐

- 教員ログインに失敗した場合、ダッシュボードへ遷移しない。
- セッションに眠気スコアが存在しない場合、グラフは空状態または読み込みなし状態として表示する。
- 停止・再開イベントが存在しない場合、タイムラインは空状態として表示する。

## 8. 関連データ

```text
teachers
- teacher_id
- password_hash
- created_at
- created_by_admin_id nullable

learning_sessions
- session_id
- student_id
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

playback_events
- event_id
- session_id
- type
- occurred_at
- video_time_sec nullable
```
