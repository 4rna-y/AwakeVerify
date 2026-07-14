# 教員アカウント管理API仕様

## 実装優先度

- 優先度: 13
- 理由: 管理者が必要に応じて教員アカウントを登録できるようにするため。

## 1. 機能概要

管理者が認証済みAPIを通じて教員アカウントを追加・一覧取得する機能である。

`/admin/teachers` のフロントエンド画面は提供しない。ブラウザ上の管理者導線は `/admin/login` と `/admin/dashboard` のみとする。

## 2. 利用者

- 管理者

## 3. 対象コンポーネント

- バックエンド
- PostgreSQL

## 4. トリガー

認証済み管理者が教員アカウント管理APIを呼び出す。

## 5. API仕様

### 5.1 教員一覧

```http
GET /api/admin/teachers
```

### 5.2 教員追加

```http
POST /api/admin/teachers
```

request:

```json
{
  "teacherId": "string",
  "password": "string"
}
```

`adminId`、トークン、または認可情報をrequest bodyへ含めない。認可は [`12-teacher-login.md`](./12-teacher-login.md) と同じHttpOnly Cookieの `admin` principalから判定する。

## 6. バックエンド処理仕様

1. Cookieから有効な `admin` roleを確認する。request bodyのID、`sessionStorage`、クライアントが送った任意ヘッダーを認可根拠にしない。
2. `teacherId` の重複を確認する。
3. ASP.NET Core `PasswordHasher`（PBKDF2-HMAC-SHA256、Identity V3形式）でパスワードをハッシュ化する。
4. `teachers` に保存し、認証済みprincipalの `adminId` を `created_by_admin_id` として記録する。

## 7. データ保存

```text
teachers
- teacher_id
- password_hash
- created_at
- created_by_admin_id nullable

admins
- admin_id
- password_hash
- created_at
```

## 8. 管理者認証と認可

管理者ログインは `POST /api/admin/login` で行い、`admin` roleだけが `GET /api/admin/teachers` と `POST /api/admin/teachers` を実行できる。教員は作成済みアカウントの閲覧・作成・削除をできない。
