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
if [ -f "/workspace/src/worker/pyproject.toml" ]; then
    ok "Python 依存パッケージをインストール中..."
    cd /workspace/src/worker
    python3 -m venv .venv
    # shellcheck disable=SC1091
    source .venv/bin/activate
    pip install --quiet -e .
    ok "Python パッケージのインストール完了"
    cd /workspace
else
    warn "src/worker/pyproject.toml が見つかりません（スキップ）"
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
# Worker GUI / X11 表示確認
# ──────────────────────────────────────────────
section "Worker GUI / X11 表示確認"
DISPLAY_VALUE="${DISPLAY:-}"
if [ -n "$DISPLAY_VALUE" ]; then
    ok "DISPLAY=${DISPLAY_VALUE}"
else
    warn "DISPLAY が未設定です。ホスト画面へGUI表示する場合は .devcontainer/.env などで DISPLAY=:0 を設定してください"
fi

if ls /tmp/.X11-unix/X* >/dev/null 2>&1; then
    ok "X11 ソケットが見つかりました"
else
    warn "X11 ソケットが見つかりません。Linuxホストでは xhost +local:docker 後に devcontainer を再起動してください"
fi

if [ -e /dev/video0 ]; then
    VIDEO_GID="$(stat -c '%g' /dev/video0)"
    if id -G | tr ' ' '\n' | grep -qx "$VIDEO_GID"; then
        ok "/dev/video0 にアクセス可能なグループ GID=${VIDEO_GID} に所属しています"
    else
        warn "/dev/video0 のグループ GID=${VIDEO_GID} に現在のユーザーが所属していません"
        echo "     .devcontainer/.env に HOST_VIDEO_GID=${VIDEO_GID} を設定し、devcontainer を Rebuild/Reopen してください"
    fi
else
    warn "/dev/video0 が見つかりません。WebCamera を使う場合はホストのデバイスを devcontainer にバインドしてください"
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
