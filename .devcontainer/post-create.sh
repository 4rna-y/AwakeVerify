#!/usr/bin/env bash
# =============================================================
# devcontainer post-create スクリプト
#   コンテナ初回起動後に VS Code が自動実行する
# =============================================================
set -euo pipefail

RESET='\033[0m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'

section() { echo -e "\n${CYAN}▶ $1${RESET}"; }
ok()      { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET} $1"; }

section "SD2 開発環境セットアップ"

# ──────────────────────────────────────────────
# バージョン確認
# ──────────────────────────────────────────────
section "ランタイムバージョン確認"
ok "Node.js  : $(node --version)"
ok "pnpm     : $(pnpm --version)"
ok "dotnet   : $(dotnet --version)"
ok "Python   : $(python3 --version)"
ok "Azure CLI: $(az --version 2>/dev/null | head -1)"

# ──────────────────────────────────────────────
# .env ファイルチェック
# ──────────────────────────────────────────────
section ".env 確認"
ENV_FILE="/workspace/.devcontainer/.env"
if [ -f "$ENV_FILE" ]; then
    ok ".env が見つかりました"
else
    warn ".env が存在しません"
    echo "     次のコマンドでテンプレートからコピーしてください:"
    echo "     cp /workspace/.devcontainer/.env.example /workspace/.devcontainer/.env"
fi

# ──────────────────────────────────────────────
# プロジェクト別依存パッケージの自動インストール（任意）
# ──────────────────────────────────────────────
section "依存パッケージのインストール"

# Python Worker
if [ -f "/workspace/src/worker/requirements.txt" ]; then
    ok "Python 依存パッケージをインストール中..."
    cd /workspace/src/worker
    python3 -m venv .venv
    # shellcheck disable=SC1091
    source .venv/bin/activate
    pip install --quiet -r requirements.txt
    ok "Python パッケージのインストール完了"
    cd /workspace
else
    warn "src/worker/requirements.txt が見つかりません（スキップ）"
fi

# Next.js Frontend
if [ -f "/workspace/src/frontend/package.json" ]; then
    ok "Node.js 依存パッケージをインストール中..."
    cd /workspace/src/frontend
    pnpm install --silent
    ok "pnpm install 完了"
    cd /workspace
else
    warn "src/frontend/package.json が見つかりません（スキップ）"
fi

# ASP.NET Core Backend
if ls /workspace/src/backend/**/*.csproj 2>/dev/null | head -1 | grep -q csproj; then
    ok ".NET パッケージをリストア中..."
    cd /workspace/src/backend
    dotnet restore --verbosity quiet
    ok "dotnet restore 完了"
    cd /workspace
else
    warn "src/backend/*.csproj が見つかりません（スキップ）"
fi

# ──────────────────────────────────────────────
# 接続文字列リファレンス表示
# ──────────────────────────────────────────────
section "ローカル接続文字列リファレンス"
cat << 'EOF'
  ┌─────────────────────────────────────────────────────────────────────┐
  │ PostgreSQL                                                          │
  │   Host=postgres;Port=5432;Database=sd2;                            │
  │   Username=<POSTGRES_USER>;Password=<POSTGRES_PASSWORD>            │
  ├─────────────────────────────────────────────────────────────────────┤
  │ Redis                                                               │
  │   redis:6379,password=<REDIS_PASSWORD>                             │
  ├─────────────────────────────────────────────────────────────────────┤
  │ Azurite – Blob                                                      │
  │   DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;      │
  │   AccountKey=<AZURITE_ACCOUNT_KEY>;                                │
  │   BlobEndpoint=http://azurite:10000/devstoreaccount1;              │
  ├─────────────────────────────────────────────────────────────────────┤
  │ Service Bus Emulator                                                │
  │   Endpoint=sb://servicebus;                                        │
  │   SharedAccessKeyName=RootManageSharedAccessKey;                   │
  │   SharedAccessKey=<SERVICEBUS_SAS_KEY>;                            │
  │   UseDevelopmentEmulator=true;                                     │
  ├─────────────────────────────────────────────────────────────────────┤
  │ SignalR (ローカル Self-hosted – Azure SignalR 不要)                 │
  │   AZURE_SIGNALR_CONNECTION_STRING を空にすれば自動フォールバック    │
  └─────────────────────────────────────────────────────────────────────┘
EOF

echo -e "\n${GREEN}✅ セットアップ完了！${RESET}\n"
