# AwakeVerify Frontend

## 開発サーバー

```bash
pnpm dev
```

`http://localhost:3000` を開きます。Backend は既定で `http://localhost:5194`、Worker health は既定で `http://localhost:8000/health` を参照します。

## E2E（Playwright）

対象シナリオは [`docs/scenarios/student-learning-happy-path.md`](../../docs/scenarios/student-learning-happy-path.md) です。

1. devcontainer の PostgreSQL、Redis、Azurite、Azure Service Bus Emulator を起動する。
2. Backend（`http://localhost:5194`）と Worker（`http://localhost:8000/health`）を起動する。
3. Chromium を初回だけ導入する。
4. E2E を実行する。

```bash
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

テスト開始時に Backend health と Worker health を確認します。Worker は起動時に Backend、Service Bus、Blob Storage、Redis への接続を確認してから `/health` を公開するため、この preflight により解析パイプラインの依存サービスが利用可能な状態であることを確認します。テスト本体は、学籍番号でのログイン、受講セッション作成、Web カメラ権限、Backend／Worker の接続確認、HTTP binary frame ingress／SignalR 接続、キャリブレーション開始可能状態までを検証します。

接続先を変える場合は、以下を指定できます。

```bash
E2E_FRONTEND_BASE_URL=http://localhost:3000 \
E2E_BACKEND_BASE_URL=http://localhost:5194 \
E2E_WORKER_HEALTH_URL=http://localhost:8000/health \
pnpm test:e2e
```
