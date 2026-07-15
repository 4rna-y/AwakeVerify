#!/usr/bin/env bash
set -euo pipefail
set +x

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-common.sh
source "$script_dir/demo-common.sh"

assert_azure_context
frontend_app="$(resolve_frontend_app)" || fail "Expected Frontend Container App was not found."
assert_resource "$frontend_app" "Microsoft.App/containerApps" >/dev/null
assert_resource "$DEMO_BACKEND_APP" "Microsoft.App/containerApps" >/dev/null
assert_resource "$DEMO_WORKER_APP" "Microsoft.App/containerApps" >/dev/null
assert_resource "$DEMO_CONTAINER_ENV" "Microsoft.App/managedEnvironments" >/dev/null
assert_bicep_zero_scale_contract frontendMinReplicas
assert_bicep_zero_scale_contract backendMinInstances

printf '\nCurrent scale profile:\n'
print_containerapp_scale "$frontend_app"
print_containerapp_scale "$DEMO_BACKEND_APP"
print_containerapp_scale "$DEMO_WORKER_APP"

frontend_base_url="${DEMO_FRONTEND_BASE_URL:-$DEMO_FRONTEND_BASE_URL_DEFAULT}"
frontend_health_path="${DEMO_FRONTEND_HEALTH_PATH:-/}"
backend_base_url="${DEMO_BACKEND_BASE_URL:-$DEMO_BACKEND_BASE_URL_DEFAULT}"
[[ "$frontend_health_path" == /* ]] || fail "DEMO_FRONTEND_HEALTH_PATH must start with /."
check_health_endpoint "Frontend SSR before cooldown" "${frontend_base_url}${frontend_health_path}" || fail "Frontend SSR health failed before cooldown."
check_health_endpoint "Backend ready before cooldown" "$backend_base_url/health/ready" || fail "Backend readiness failed; Outbox draining cannot be trusted."
require_queue_zero
require_outbox_zero
require_demo_quota

[[ "${ALLOW_AZURE_DEMO_SCALE:-false}" == "true" ]] || fail "Set ALLOW_AZURE_DEMO_SCALE=true to permit the cooldown scale change."
printf '\nCooldown changes Frontend, Backend, and Worker min replicas to 0 after queue/Outbox gates pass.\n'
confirm_fixed_phrase "COOLDOWN AWAVERTEST DEMO"

az containerapp update \
    --name "$frontend_app" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --min-replicas 0 \
    --query '{Name:name,Min:properties.template.scale.minReplicas,Max:properties.template.scale.maxReplicas}' \
    --output table
az containerapp update \
    --name "$DEMO_WORKER_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --min-replicas 0 \
    --query '{Name:name,Min:properties.template.scale.minReplicas,Max:properties.template.scale.maxReplicas}' \
    --output table

wait_for_zero_running_replicas "$frontend_app"
wait_for_zero_running_replicas "$DEMO_WORKER_APP"
require_queue_zero
require_outbox_zero

az containerapp update \
    --name "$DEMO_BACKEND_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --min-replicas 0 \
    --query '{Name:name,Min:properties.template.scale.minReplicas,Max:properties.template.scale.maxReplicas}' \
    --output table
wait_for_zero_running_replicas "$DEMO_BACKEND_APP"

require_queue_zero
require_outbox_zero
require_demo_quota

printf '\nCooldown complete:\n'
print_containerapp_scale "$frontend_app"
print_containerapp_scale "$DEMO_BACKEND_APP"
print_containerapp_scale "$DEMO_WORKER_APP"
