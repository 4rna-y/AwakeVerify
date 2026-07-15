#!/usr/bin/env bash
set -euo pipefail
set +x

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-common.sh
source "$script_dir/demo-common.sh"

readonly -a DESTROY_NAMES=(
    "awavertest-frontend"
    "awaverdemo-frontend"
    "awavertest-worker"
    "awavertest-backend"
    "awavertest-backend"
    "awavertest-backend-plan-cpu-autoscale"
    "awavertest-backend-plan"
    "awavertest-cae"
    "awavertest-backend-ai"
    "awavertest-signalr"
    "awavertest-servicebus"
    "awavertestredis"
    "awavertestpostgres"
    "awaverteststorage"
    "awavertest-logs"
)
readonly -a DESTROY_TYPES=(
    "Microsoft.App/containerApps"
    "Microsoft.App/containerApps"
    "Microsoft.App/containerApps"
    "Microsoft.App/containerApps"
    "Microsoft.Web/sites"
    "Microsoft.Insights/autoscalesettings"
    "Microsoft.Web/serverFarms"
    "Microsoft.App/managedEnvironments"
    "Microsoft.Insights/components"
    "Microsoft.SignalRService/SignalR"
    "Microsoft.ServiceBus/namespaces"
    "Microsoft.Cache/redisEnterprise"
    "Microsoft.DBforPostgreSQL/flexibleServers"
    "Microsoft.Storage/storageAccounts"
    "Microsoft.OperationalInsights/workspaces"
)

print_destroy_plan() {
    local index name type id
    local found=0

    printf '\nDeletion allow-list (exact name + type, ordered):\n'
    printf '%-3s %-43s %-48s %s\n' '#' 'NAME' 'TYPE' 'RESOURCE ID / STATUS'
    for index in "${!DESTROY_NAMES[@]}"; do
        name="${DESTROY_NAMES[$index]}"
        type="${DESTROY_TYPES[$index]}"
        [[ "$name" != "$DEMO_SHARED_SIGNALR_NAME" ]] || fail "Shared SignalR appeared in the deletion allow-list."
        id="$(resource_id_for "$name" "$type" || true)"
        if [[ -n "$id" ]]; then
            found=$((found + 1))
            printf '%-3s %-43s %-48s %s\n' "$((index + 1))" "$name" "$type" "$id"
        else
            printf '%-3s %-43s %-48s %s\n' "$((index + 1))" "$name" "$type" '[absent]'
        fi
    done

    printf '\nPermanently preserved:\n'
    printf -- '- Resource group: %s\n' "$DEMO_RESOURCE_GROUP"
    printf -- '- Shared SignalR: %s (%s)\n' "$DEMO_SHARED_SIGNALR_NAME" "$DEMO_SHARED_SIGNALR_TYPE"
    printf '\nData loss: PostgreSQL, Blob Storage, Service Bus, Redis, test SignalR, logs, telemetry, app identities, and deployed workloads in the allow-list are irreversible.\n'
    printf 'Resources currently present in allow-list: %s\n' "$found"
    DESTROY_FOUND_COUNT="$found"
}

perform_ordered_delete() {
    local index name type id

    for index in "${!DESTROY_NAMES[@]}"; do
        name="${DESTROY_NAMES[$index]}"
        type="${DESTROY_TYPES[$index]}"
        id="$(resource_id_for "$name" "$type" || true)"
        if [[ -z "$id" ]]; then
            printf 'Skip absent: %s (%s)\n' "$name" "$type"
            continue
        fi

        printf 'Deleting %s (%s) ...\n' "$name" "$type"
        az resource delete --ids "$id" --output none
        if resource_exists "$name" "$type"; then
            fail "Azure still reports the resource after deletion: $name ($type)"
        fi
    done
}

assert_azure_context
assert_shared_resources_preserved
print_destroy_plan

if [[ "${ALLOW_AZURE_DEMO_DESTROY:-false}" != "true" ]]; then
    printf '\nPREVIEW ONLY. To request real deletion, set ALLOW_AZURE_DEMO_DESTROY=true and run this script in a TTY.\n'
    exit 0
fi

[[ "$DESTROY_FOUND_COUNT" != "0" ]] || {
    info "No allow-listed resources exist. Nothing to delete."
    exit 0
}

require_tty
require_queue_zero
require_outbox_zero

printf '\nFinal destructive-operation confirmation:\n'
printf -- '- New demo use must be stopped.\n'
printf -- '- Required PostgreSQL, Blob, and log data must already be exported.\n'
printf -- '- The listed data and Worker managed identity will be permanently lost.\n'
printf -- '- Resource group and shared SignalR must remain.\n'
confirm_fixed_phrase "DELETE AWAVERTEST RESOURCES"

# Re-check gates after human confirmation so stale pre-confirmation state cannot authorize deletion.
require_queue_zero
require_outbox_zero
assert_shared_resources_preserved
perform_ordered_delete

for index in "${!DESTROY_NAMES[@]}"; do
    if resource_exists "${DESTROY_NAMES[$index]}" "${DESTROY_TYPES[$index]}"; then
        fail "Post-delete verification found an allow-listed resource still present: ${DESTROY_NAMES[$index]} (${DESTROY_TYPES[$index]})"
    fi
done

assert_azure_context
assert_shared_resources_preserved
printf '\nDeletion complete. Resource group %s and shared SignalR %s are still present.\n' "$DEMO_RESOURCE_GROUP" "$DEMO_SHARED_SIGNALR_NAME"
