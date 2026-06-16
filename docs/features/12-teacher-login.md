# 教員ログイン機能仕様

## 実装優先度

- 優先度: 12
- 理由: 教員ダッシュボードなど教員向け機能へのアクセス制御に必要なため。

## 1. 機能概要

教員が教員IDとパスワードでログインし、教員ダッシュボードへアクセスするための機能である。

## 2. 利用者

- 教員

## 3. 対象コンポーネント

- フロントエンド
- バックエンド
- PostgreSQL

## 4. トリガー

教員が `/teacher/login` 画面で教員IDとパスワードを入力し、ログイン操作を行う。

## 5. 入力

| 項目 | 内容 |
| --- | --- |
| `teacherId` | 教員ID |
| `password` | 教員パスワード |

パスワード入力は画面上でマスクする。

## 6. API仕様

```http
POST /api/teacher/login
```

request:

```json
{
  "teacherId": "string",
  "password": "string"
}
```

response:

```json
{
  "success": true
}
```

## 7. 処理仕様

### 7.1 フロントエンド

1. 教員IDとパスワード入力フォームを表示する。
2. 入力内容をバックエンドへ送信する。
3. 認証成功後、教員ダッシュボードへ遷移する。
4. 認証失敗または通信エラー時は `Alert` でエラーを表示する。

### 7.2 バックエンド

1. `teacherId` と `password` を受け取る。
2. `teachers` から対象教員を検索する。
3. 保存済みの `password_hash` と照合する。
4. 認証結果を返却する。

## 8. データ保存

```text
teachers
- teacher_id
- password_hash
- created_at
- created_by_admin_id nullable
```

教員パスワードは平文保存せず、ハッシュ化して保存する。

## 9. UI仕様

使用する shadcn/ui コンポーネント:

- `Card`
- `Form`
- `Input`
- `Button`
- `Alert`

## 10. 未決定事項

- 教員ログイン後の具体的なセッション管理方式またはトークン方式
