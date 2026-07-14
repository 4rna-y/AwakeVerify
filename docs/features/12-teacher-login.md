# 管理者ログインへの置換

## 1. 機能概要

教員ログインのフロントエンド導線を廃止し、管理者ログインへ統一する。初期管理者は `.env` の `ADMIN_ID` と `ADMIN_PASSWORD` で作成され、`/admin/login` で認証した後に管理者ダッシュボードを表示する。`/admin/teachers` のフロントエンド画面は提供しない。

教員用の認証画面およびフロントエンドからの `POST /api/teacher/login` 呼び出しは提供しない。旧 `/teacher/login` へのアクセスは `/admin/login` へリダイレクトする。

## 2. 利用者

- 管理者

## 3. 画面・API

- 生徒ログイン画面には「管理者ログインはこちら」を表示し、`/admin/login` へ遷移する。
- `POST /api/admin/login` は次の資格情報を受け取る。

```json
{
  "adminId": "string",
  "password": "string"
}
```

- 認証成功時、Backendは `admin` role のHttpOnly Cookieとサーバー側 `auth_sessions` を発行し、フロントエンドは `/admin/dashboard` へ遷移する。
- 管理者ログインの詳細と教員アカウント管理は [`13-teacher-account-management.md`](./13-teacher-account-management.md) を一次情報とする。

## 4. 受け入れ条件

- `.env` の初期管理者資格情報で `/admin/login` の管理者ログインができ、認証成功後は `/admin/dashboard` を表示する。
- 生徒ログイン画面と旧 `/teacher/login` URLから、教員ログインフォームを表示せず管理者ログインへ到達できる。
- フロントエンドは `POST /api/teacher/login` を呼び出さない。
- 管理者の認証情報は `HttpOnly` Cookie以外のブラウザ永続領域へ保存しない。
