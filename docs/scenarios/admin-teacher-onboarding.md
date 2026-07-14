# 管理者による教員アカウント管理API利用シナリオ

## 1. 目的

初期管理者が管理者ログインを完了し、認証済みAPIを通じて教員アカウントを追加・一覧確認できることを定義する。`/admin/teachers` のフロントエンド画面は提供しない。

## 2. アクター

- 管理者
- APIクライアント
- バックエンド
- PostgreSQL

## 3. 前提条件

- BackendとPostgreSQLが利用可能である。
- 初回起動前に `ADMIN_ID` と `ADMIN_PASSWORD` がBackendプロセスへ設定されている。

## 4. Feature path

1. [`12-teacher-login.md`](../features/12-teacher-login.md)
2. [`13-teacher-account-management.md`](../features/13-teacher-account-management.md)

## 5. フロー

1. 管理者が生徒ログイン画面の「管理者ログインはこちら」を選択する。または旧 `/teacher/login` にアクセスする。
2. フロントエンドが `/admin/login` の管理者ログイン画面を表示する。
3. 管理者が `ADMIN_ID` と `ADMIN_PASSWORD` を入力する。
4. フロントエンドが `POST /api/admin/login` を呼び出す。
5. Backendが `admins.password_hash` と照合し、`admin` HttpOnly認証Cookieを設定する。
6. フロントエンドが `/admin/dashboard` を表示する。
7. 認証済み管理者のAPIクライアントが資格情報付きで `POST /api/admin/teachers` を呼び出す。request bodyに `adminId` は含めない。
8. Backendが `admin` sessionを確認し、教員IDの重複を確認する。
9. Backendがパスワードをハッシュ化して `teachers` に保存し、認証済み管理者IDを `created_by_admin_id` に記録する。
10. APIクライアントが `GET /api/admin/teachers` で登録結果を確認する。

## 6. 期待結果

- 初期管理者は `/admin/login` でログインでき、認証成功後は `/admin/dashboard` が表示される。
- `/admin/teachers` のフロントエンド画面は存在しない。
- 管理者は認証済みAPIを通じて教員アカウントを追加・一覧確認できる。
- 教員パスワードは平文保存・ブラウザ永続領域への保存をされない。
- `adminId` を偽装したrequest bodyだけでは教員を追加できない。

## 7. 例外・分岐

- 管理者資格情報が誤っている場合、ダッシュボードを表示しない。
- 管理者認証が失敗・期限切れ・失効している場合、教員アカウントは追加されない（`401`）。
- `teacherId` が重複している場合、教員アカウントは追加されない。
- `.env` の資格情報を変更しても、すでに作成済みの同一管理者IDのパスワードは更新されない。
