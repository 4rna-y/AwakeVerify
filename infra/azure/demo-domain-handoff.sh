#!/usr/bin/env bash
set -euo pipefail
set +x

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-common.sh
source "$script_dir/demo-common.sh"

assert_azure_context >/dev/null
frontend_app="$(resolve_frontend_app)" || fail "Expected Frontend Container App was not found."
assert_resource "$DEMO_BACKEND_APP" "Microsoft.App/containerApps" >/dev/null
assert_resource "$DEMO_WORKER_APP" "Microsoft.App/containerApps" >/dev/null

frontend_row="$(containerapp_domain_handoff_row "$frontend_app")" || fail "Unable to read Frontend static IP or verification ID."
backend_row="$(containerapp_domain_handoff_row "$DEMO_BACKEND_APP")" || fail "Unable to read Backend static IP or verification ID."
worker_row="$(containerapp_domain_handoff_row "$DEMO_WORKER_APP")" || fail "Unable to read Worker static IP or verification ID."
IFS=$'\t' read -r frontend_static_ip frontend_verification_id <<< "$frontend_row"
IFS=$'\t' read -r backend_static_ip backend_verification_id <<< "$backend_row"
IFS=$'\t' read -r worker_static_ip worker_verification_id <<< "$worker_row"

printf '| Type | Cloudflare host | Value | Proxy | TTL |\n'
printf '| --- | --- | --- | --- | --- |\n'
printf '| A | `awaver` | `%s` | DNS only | 300 |\n' "$frontend_static_ip"
printf '| TXT | `asuid.awaver` | `%s` | n/a | 300 |\n' "$frontend_verification_id"
printf '| A | `api.awaver` | `%s` | DNS only | 300 |\n' "$backend_static_ip"
printf '| TXT | `asuid.api.awaver` | `%s` | n/a | 300 |\n' "$backend_verification_id"
printf '| A | `worker.api.awaver` | `%s` | DNS only | 300 |\n' "$worker_static_ip"
printf '| TXT | `asuid.worker.api.awaver` | `%s` | n/a | 300 |\n' "$worker_verification_id"
