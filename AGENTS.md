# AGENTS.md

このリポジトリで作業するエージェントは、LLM駆動開発における効率と人間の認知負荷を下げるため、**Feature / Scenario first** の方針で開発する。

## 基本方針

- 一次仕様は `docs/features/` と `docs/scenarios/` に置く。
- `docs/frontend/`, `docs/backend/`, `docs/worker/` は二次仕様として扱う。
- 実装は常に「どの feature / scenario を満たすための変更か」を起点にする。
- frontend / backend / worker 単位の都合だけで仕様や実装を決めない。
- 各レイヤーの仕様が衝突する場合は、feature / scenario を優先し、必要なら二次仕様を更新する。
- `git --no-pager diff --check`コマンドを使用しての差分表示は時間がかかるため避けて他の方法をしようすること。

## 仕様の優先順位

仕様や実装判断で迷った場合は、次の順に参照する。

1. `docs/features/` — ユーザー価値、目的、受け入れ条件
2. `docs/scenarios/` — 具体的な振る舞い、正常系、異常系、状態遷移
3. `docs/backend/` — API、データモデル、認可、永続化、サーバー側責務
4. `docs/frontend/` — UI、画面遷移、入力検証、表示状態
5. `docs/worker/` — 非同期処理、ジョブ、リトライ、失敗時処理
6. 既存コードの実装パターン、テスト、設定

## Feature / Scenario first

新機能、仕様変更、バグ修正では、まず対象の feature / scenario を確認する。

良い作業開始例:

```text
Scenario: ユーザーがPDFをアップロードすると、処理中ステータスで履歴に表示される

この scenario を満たすために、frontend の表示、backend の API、worker のジョブ投入を確認・変更する。
```

避けるべき作業開始例:

```text
frontend/spec.md だけを読んで画面を実装する
backend/spec.md だけを読んで API を実装する
worker/spec.md だけを読んでジョブを実装する
```

レイヤー単位の実装は必要だが、それは feature / scenario を満たすための手段である。

## Component spec の扱い

`frontend`, `backend`, `worker` の仕様は、feature / scenario を実装可能なタスクへ分解するために使う。

### frontend spec に書くこと

- 画面構成
- ユーザー操作
- 入力検証
- 表示状態
- ローディング、空状態、エラー表示
- backend API との接続方法

### backend spec に書くこと

- API 契約
- リクエスト / レスポンス
- 認証・認可
- データモデル
- 永続化
- エラーコード
- worker へのジョブ投入

### worker spec に書くこと

- ジョブの種類
- 入力 payload
- 処理手順
- 状態遷移
- リトライ方針
- 失敗時の扱い
- backend / DB への反映方法

## 変更時の手順

エージェントは、原則として以下の順に作業する。

1. 対象の feature / scenario を特定する。
2. 受け入れ条件、正常系、異常系を確認する。
3. 関連する frontend / backend / worker spec を確認する。
4. 既存実装とテストを確認する。
5. 最小限の変更で scenario を満たす。
6. 必要に応じて component spec を更新する。
7. 可能な範囲でテスト、型チェック、lint、ビルドを実行する。
8. 変更内容と検証結果を簡潔に報告する。

## 仕様が不足している場合

仕様が不足している場合は、実装を推測で進めない。

ただし、既存コード、既存テスト、既存ドキュメントから合理的に補完できる場合は、その前提を明示して最小限の変更を行ってよい。

重大な判断が必要な場合は、先に feature / scenario の更新案を提示する。

## ドキュメント更新ルール

実装によって外部挙動が変わる場合は、関連ドキュメントも更新する。

- ユーザーに見える挙動が変わる場合: `docs/features/` または `docs/scenarios/`
- API やデータ構造が変わる場合: `docs/backend/`
- UI や画面状態が変わる場合: `docs/frontend/`
- 非同期処理やジョブ仕様が変わる場合: `docs/worker/`

同じ内容を複数箇所に重複して書かない。重複が必要な場合は、一次情報がどこかを明確にする。

## LLM エージェントへの依頼単位

LLM へ作業を依頼する場合は、実装レイヤーではなく scenario 単位を基本にする。

推奨:

```text
この scenario を満たすために backend 側の変更を行う。
API 契約は docs/backend/ を参照し、UI 側の期待挙動は docs/scenarios/ を優先する。
```

非推奨:

```text
backend をいい感じに実装して。
frontend/spec.md に合わせて全部直して。
```

大きな feature の場合のみ、scenario を起点に frontend / backend / worker へ分割してよい。
その場合も、各作業の受け入れ条件は scenario に紐づける。

## 並列開発のルール

複数エージェントや複数タスクで並列開発する場合は、以下を守る。

- 共通の feature / scenario を最初に共有する。
- frontend / backend / worker の責務境界を component spec に明記する。
- API 契約、状態名、エラーコード、データモデルを先に固定する。
- 各タスクの write scope を分ける。
- 最後に scenario 単位で統合確認する。

## テスト方針

テストは、可能な限り scenario に対応させる。

- feature / scenario: 受け入れテスト、E2E、統合テスト
- frontend: コンポーネントテスト、画面状態のテスト
- backend: API テスト、ドメインロジック、認可、永続化
- worker: ジョブ処理、リトライ、失敗時処理、状態遷移

単体テストだけで scenario が満たされたと判断しない。
最終的には、ユーザー価値単位で期待挙動が成立しているか確認する。

## 実装上の注意

- 既存の設計、命名、ディレクトリ構成に従う。
- 不要な抽象化や大規模なリファクタリングを避ける。
- 関連しない問題をついでに修正しない。
- 仕様と実装がズレている場合は、どちらを変更したかを明記する。
- 破壊的変更が必要な場合は、影響範囲と移行作業を説明する。

## 判断基準

このリポジトリでは、次の考え方を採用する。

```text
何を作るか: docs/features/ と docs/scenarios/
どう分担して作るか: docs/frontend/, docs/backend/, docs/worker/
```

したがって、どちらか一方を優先しなければならない場合は、**features / scenarios を優先する**。
