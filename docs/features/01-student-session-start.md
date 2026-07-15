# 受講者セッション開始機能仕様

## 実装優先度

- 優先度: 01
- 理由: 以後のWebSocket接続、SignalR購読、イベント記録で使用する `sessionId` の起点となるため。

## 1. 機能概要

受講者が学籍番号を入力し、受講セッションを開始する機能である。

バックエンドは受講ごとに `sessionId` を発行し、フロントエンドは以後のWebSocket接続、SignalR購読、停止・再開イベント送信にこの `sessionId` を使用する。

## 2. 利用者

- 受講者

## 3. 対象コンポーネント

- フロントエンド
- バックエンド
- PostgreSQL

## 4. トリガー

受講者が `/student` 画面で学籍番号を入力し、セッション開始操作を行う。

## 5. 入力

| 項目 | 内容 |
| --- | --- |
| `studentId` | 受講者の学籍番号 |
| `videoId` | 受講する動画を識別するID。未指定時は既定値 `default` を記録する。 |

受講者にはパスワードを設定しない。

## 6. API仕様

```http
POST /api/sessions
```

request:

```json
{
  "studentId": "string",
  "videoId": "string"
}
```

response:

```json
{
  "sessionId": "uuid"
}
```

## 7. 処理仕様

### 7.1 フロントエンド

1. `/` または `/student` で、画面中央にLoginモーダルを表示する。
2. 初期状態は生徒ログインを主表示とし、学籍番号入力、ログインボタン、教員ログインへ切り替えるLinkTextButtonを表示する。
3. 受講者が学籍番号を入力する。
4. SSR Frontendの実行環境変数 `LESSON_VIDEO_ID` をServer Componentから受け取り、`videoId` として `POST /api/sessions` へ送信する。未設定時は `default` を送信する。
5. レスポンスの `sessionId` を同一ブラウザタブ内の受講中状態として保持する。キャリブレーション成功を受信した場合と動画再生中の進捗も同じ状態へ記録するが、再開可否の確定には使用しない。
6. `/student/session` へ遷移し、以後のキャリブレーションと動画再生を行う。リロード時は保持した `sessionId` とHttpOnly `student_session` Cookieを照合し、成功済みキャリブレーションをBackendから取得して復元する。
7. `/student/session` の初期照合で未認証・権限なし・Cookieと保持した `sessionId` の不一致を検出した場合は、保持した受講中状態を削除して `/student` へ遷移する。一時的な認証確認失敗はエラーとして表示し、受講者が再試行できるようにする。
8. 取得した `sessionId` を以下に使用する。
   - WebSocket接続
   - SignalR購読
   - 停止・再開イベント送信
   - 受講中状態管理

### 7.2 バックエンド

1. `studentId` と `videoId` を受け取る。
2. `students` に存在しない場合は作成する。
3. `learning_sessions` に動画IDを含む新規セッションを作成する。
4. `sessionId` を返却する。

## 8. 画面状態

| 状態 | 条件 | 表示 | 操作 |
| --- | --- | --- | --- |
| `idle` | 初期表示 | Loginモーダルの生徒ログインフォーム | ログインボタンと教員ログイン切り替えLinkTextButtonを表示する。 |
| `starting` | セッション作成中 | Loginモーダル内の読み込み表示 | ログインボタンを無効化する。 |
| `camera_permission_required` | `/student/session` 遷移後、カメラ権限未取得 | カメラ許可案内 | ブラウザの権限許可を促す。 |
| `error` | 復旧不能な通信・権限エラー | エラーメッセージ | 再試行導線を表示する。 |

## 9. データ保存

```text
students
- student_id
- created_at

learning_sessions
- session_id
- student_id
- video_id
- started_at
- ended_at nullable
```

## 10. エラー・例外

- セッション作成中は開始ボタンを無効化する。
- API / 通信エラーは画面上部または対象カード内に表示する。
