#!/usr/bin/env bash
set -euo pipefail
set +x

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-common.sh
source "$script_dir/demo-common.sh"

readonly FRONTEND_MIN=1
readonly FRONTEND_MAX=1
readonly BACKEND_MIN=2
readonly BACKEND_MAX=2
readonly WORKER_MIN=12
readonly WORKER_MAX=15

assert_azure_context
frontend_app="$(resolve_frontend_app)" || fail "Expected Frontend Container App was not found."
assert_resource "$frontend_app" "Microsoft.App/containerApps" >/dev/null
assert_resource "$DEMO_BACKEND_APP" "Microsoft.App/containerApps" >/dev/null
assert_resource "$DEMO_WORKER_APP" "Microsoft.App/containerApps" >/dev/null
assert_resource "$DEMO_CONTAINER_ENV" "Microsoft.App/managedEnvironments" >/dev/null
assert_resource "$DEMO_SERVICE_BUS" "Microsoft.ServiceBus/namespaces" >/dev/null
require_demo_quota

frontend_image="$(current_container_image "$frontend_app")" || fail "Unable to read Frontend image."
backend_image="$(current_container_image "$DEMO_BACKEND_APP")" || fail "Unable to read Backend image."
worker_image="$(current_container_image "$DEMO_WORKER_APP")" || fail "Unable to read Worker image."
assert_expected_immutable_image "Frontend" "$frontend_image" "${DEMO_EXPECTED_FRONTEND_IMAGE:-}" >/dev/null
assert_expected_immutable_image "Backend" "$backend_image" "${DEMO_EXPECTED_BACKEND_IMAGE:-}" >/dev/null
assert_expected_immutable_image "Worker" "$worker_image" "${DEMO_EXPECTED_WORKER_IMAGE:-}" >/dev/null

printf '\nCurrent scale profile:\n'
print_containerapp_scale "$frontend_app"
print_containerapp_scale "$DEMO_BACKEND_APP"
print_containerapp_scale "$DEMO_WORKER_APP"
printf '\nRequested warm profile:\n'
printf '%-24s min=%-3s max=%-3s\n' "$frontend_app" "$FRONTEND_MIN" "$FRONTEND_MAX"
printf '%-24s min=%-3s max=%-3s\n' "$DEMO_BACKEND_APP" "$BACKEND_MIN" "$BACKEND_MAX"
printf '%-24s min=%-3s max=%-3s\n' "$DEMO_WORKER_APP" "$WORKER_MIN" "$WORKER_MAX"

[[ "${ALLOW_AZURE_DEMO_SCALE:-false}" == "true" ]] || fail "Set ALLOW_AZURE_DEMO_SCALE=true to permit the warm-up scale change."
confirm_fixed_phrase "WARM AWAVERTEST DEMO"

az containerapp update \
    --name "$frontend_app" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --min-replicas "$FRONTEND_MIN" \
    --max-replicas "$FRONTEND_MAX" \
    --query '{Name:name,Min:properties.template.scale.minReplicas,Max:properties.template.scale.maxReplicas}' \
    --output table
az containerapp update \
    --name "$DEMO_BACKEND_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --min-replicas "$BACKEND_MIN" \
    --max-replicas "$BACKEND_MAX" \
    --query '{Name:name,Min:properties.template.scale.minReplicas,Max:properties.template.scale.maxReplicas}' \
    --output table
az containerapp update \
    --name "$DEMO_WORKER_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --min-replicas "$WORKER_MIN" \
    --max-replicas "$WORKER_MAX" \
    --query '{Name:name,Min:properties.template.scale.minReplicas,Max:properties.template.scale.maxReplicas}' \
    --output table

wait_for_ready_replicas "$frontend_app" "$FRONTEND_MIN"
wait_for_ready_replicas "$DEMO_BACKEND_APP" "$BACKEND_MIN"
wait_for_ready_replicas "$DEMO_WORKER_APP" "$WORKER_MIN"

frontend_base_url="${DEMO_FRONTEND_BASE_URL:-$DEMO_FRONTEND_BASE_URL_DEFAULT}"
frontend_health_path="${DEMO_FRONTEND_HEALTH_PATH:-/}"
backend_base_url="${DEMO_BACKEND_BASE_URL:-$DEMO_BACKEND_BASE_URL_DEFAULT}"
worker_base_url="${DEMO_WORKER_BASE_URL:-$DEMO_WORKER_BASE_URL_DEFAULT}"
[[ "$frontend_health_path" == /* ]] || fail "DEMO_FRONTEND_HEALTH_PATH must start with /."
check_health_endpoint "Frontend SSR" "${frontend_base_url}${frontend_health_path}" || fail "Frontend SSR health failed after warm-up."
check_health_endpoint "Backend live" "$backend_base_url/health/live" || fail "Backend liveness failed after warm-up."
check_health_endpoint "Backend ready" "$backend_base_url/health/ready" || fail "Backend readiness failed after warm-up."
check_health_endpoint "Worker ready" "$worker_base_url/health/ready" || fail "Worker readiness failed after warm-up."
require_queue_zero
require_outbox_zero
require_demo_quota

printf '\nWarm-up complete:\n'
print_containerapp_scale "$frontend_app"
print_containerapp_scale "$DEMO_BACKEND_APP"
print_containerapp_scale "$DEMO_WORKER_APP"
