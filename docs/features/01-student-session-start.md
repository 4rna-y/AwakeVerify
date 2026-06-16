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

受講者にはパスワードを設定しない。

## 6. API仕様

```http
POST /api/sessions
```

request:

```json
{
  "studentId": "string"
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

1. 画面中央にLoginモーダルを表示する。
2. 初期状態は生徒ログインを主表示とし、学籍番号入力、ログインボタン、教員ログインへ切り替えるLinkTextButtonを表示する。
3. 受講者が学籍番号を入力する。
4. `POST /api/sessions` を呼び出す。
5. レスポンスの `sessionId` を保持する。
6. 取得した `sessionId` を以下に使用する。
   - WebSocket接続
   - SignalR購読
   - 停止・再開イベント送信
   - 受講中状態管理

### 7.2 バックエンド

1. `studentId` を受け取る。
2. `students` に存在しない場合は作成する。
3. `learning_sessions` に新規セッションを作成する。
4. `sessionId` を返却する。

## 8. 画面状態

| 状態 | 条件 | 表示 | 操作 |
| --- | --- | --- | --- |
| `idle` | 初期表示 | Loginモーダルの生徒ログインフォーム | ログインボタンと教員ログイン切り替えLinkTextButtonを表示する。 |
| `starting` | セッション作成中 | Loginモーダル内の読み込み表示 | ログインボタンを無効化する。 |
| `camera_permission_required` | カメラ権限未取得 | カメラ許可案内 | ブラウザの権限許可を促す。 |
| `error` | 復旧不能な通信・権限エラー | エラーメッセージ | 再試行導線を表示する。 |

## 9. データ保存

```text
students
- student_id
- created_at

learning_sessions
- session_id
- student_id
- started_at
- ended_at nullable
```

## 10. エラー・例外

- セッション作成中は開始ボタンを無効化する。
- API / 通信エラーは画面上部または対象カード内に表示する。
