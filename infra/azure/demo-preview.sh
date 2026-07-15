#!/usr/bin/env bash
set -euo pipefail
set +x

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unset ALLOW_AZURE_DEMO_DESTROY
exec bash "$script_dir/demo-destroy.sh"
