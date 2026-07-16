#!/usr/bin/env bash
set -euo pipefail
set +x

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-common.sh
source "$script_dir/demo-common.sh"

status=0
expected_frontend="${DEMO_EXPECTED_FRONTEND_READY:-1}"
expected_frontend_max="${DEMO_EXPECTED_FRONTEND_MAX:-1}"
expected_backend="${DEMO_EXPECTED_BACKEND_READY:-2}"
expected_backend_max="${DEMO_EXPECTED_BACKEND_MAX:-2}"
expected_worker="${DEMO_EXPECTED_WORKER_READY:-12}"
expected_worker_max="${DEMO_EXPECTED_WORKER_MAX:-15}"
[[ "$expected_frontend" =~ ^[0-9]+$ && "$expected_frontend_max" =~ ^[0-9]+$ && \
   "$expected_backend" =~ ^[0-9]+$ && "$expected_backend_max" =~ ^[0-9]+$ && \
   "$expected_worker" =~ ^[0-9]+$ && "$expected_worker_max" =~ ^[0-9]+$ ]] || fail "Expected replica counts must be non-negative integers."

assert_azure_context
frontend_app="$(resolve_frontend_app || true)"
if [[ -z "$frontend_app" ]]; then
    warn "Expected Frontend Container App was not found."
    status=1
fi

for resource_spec in \
    "${frontend_app:-$DEMO_FRONTEND_APP_DEFAULT}|Microsoft.App/containerApps" \
    "$DEMO_BACKEND_APP|Microsoft.App/containerApps" \
    "$DEMO_WORKER_APP|Microsoft.App/containerApps" \
    "$DEMO_CONTAINER_ENV|Microsoft.App/managedEnvironments" \
    "$DEMO_SERVICE_BUS|Microsoft.ServiceBus/namespaces" \
    "$DEMO_APP_INSIGHTS|Microsoft.Insights/components"; do
    IFS='|' read -r resource_name resource_type <<< "$resource_spec"
    if ! resource_exists "$resource_name" "$resource_type"; then
        printf 'FAIL resource: %s (%s) is absent\n' "$resource_name" "$resource_type" >&2
        status=1
    fi
done

printf '\nScale and replica readiness:\n'
if [[ -n "$frontend_app" ]] && resource_exists "$frontend_app" "Microsoft.App/containerApps"; then
    print_containerapp_scale "$frontend_app"
    if ! containerapp_scale_matches "$frontend_app" "$expected_frontend" "$expected_frontend_max"; then
        printf 'FAIL scale: Frontend must be min=%s max=%s.\n' "$expected_frontend" "$expected_frontend_max" >&2
        status=1
    fi
    frontend_ready="$(ready_replica_count "$frontend_app" || printf 'unknown')"
    printf '%-24s ready=%s expected-at-least=%s\n' "$frontend_app" "$frontend_ready" "$expected_frontend"
    if [[ ! "$frontend_ready" =~ ^[0-9]+$ ]] || (( frontend_ready < expected_frontend )); then status=1; fi
    print_revision_summary "$frontend_app"
    frontend_image="$(current_container_image "$frontend_app" || true)"
    if [[ -z "$frontend_image" ]] || ! is_immutable_image_reference "$frontend_image"; then
        printf 'FAIL image: Frontend image is absent or mutable/ambiguous: %s\n' "${frontend_image:-[absent]}" >&2
        status=1
    fi

    lesson_video_id="$(az containerapp show \
        --name "$frontend_app" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --query "properties.template.containers[0].env[?name=='LESSON_VIDEO_ID'].value | [0]" \
        --output tsv 2>/dev/null || true)"
    lesson_video_secret_ref="$(az containerapp show \
        --name "$frontend_app" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --query "properties.template.containers[0].env[?name=='LESSON_VIDEO_URL'].secretRef | [0]" \
        --output tsv 2>/dev/null || true)"
    if [[ "$lesson_video_id" != "60s" ]]; then
        printf 'FAIL env: Frontend LESSON_VIDEO_ID must be 60s.\n' >&2
        status=1
    else
        printf 'Frontend LESSON_VIDEO_ID: 60s\n'
    fi
    if [[ -z "$lesson_video_secret_ref" ]]; then
        printf 'FAIL env: Frontend LESSON_VIDEO_URL must use a secretRef.\n' >&2
        status=1
    else
        printf 'Frontend LESSON_VIDEO_URL secretRef: present (secret value not read)\n'
    fi
fi
if resource_exists "$DEMO_BACKEND_APP" "Microsoft.App/containerApps"; then
    print_containerapp_scale "$DEMO_BACKEND_APP"
    if ! containerapp_scale_matches "$DEMO_BACKEND_APP" "$expected_backend" "$expected_backend_max"; then
        printf 'FAIL scale: Backend must be min=%s max=%s.\n' "$expected_backend" "$expected_backend_max" >&2
        status=1
    fi
    backend_ready="$(ready_replica_count "$DEMO_BACKEND_APP" || printf 'unknown')"
    printf '%-24s ready=%s expected-at-least=%s\n' "$DEMO_BACKEND_APP" "$backend_ready" "$expected_backend"
    if [[ ! "$backend_ready" =~ ^[0-9]+$ ]] || (( backend_ready < expected_backend )); then status=1; fi
    print_revision_summary "$DEMO_BACKEND_APP"
    backend_image="$(current_container_image "$DEMO_BACKEND_APP" || true)"
    if [[ -z "$backend_image" ]] || ! is_immutable_image_reference "$backend_image"; then
        printf 'FAIL image: Backend image is absent or mutable/ambiguous: %s\n' "${backend_image:-[absent]}" >&2
        status=1
    fi
fi
if resource_exists "$DEMO_WORKER_APP" "Microsoft.App/containerApps"; then
    print_containerapp_scale "$DEMO_WORKER_APP"
    if ! containerapp_scale_matches "$DEMO_WORKER_APP" "$expected_worker" "$expected_worker_max"; then
        printf 'FAIL scale: Worker must be min=%s max=%s.\n' "$expected_worker" "$expected_worker_max" >&2
        status=1
    fi
    worker_ready="$(ready_replica_count "$DEMO_WORKER_APP" || printf 'unknown')"
    printf '%-24s ready=%s expected-at-least=%s\n' "$DEMO_WORKER_APP" "$worker_ready" "$expected_worker"
    if [[ ! "$worker_ready" =~ ^[0-9]+$ ]] || (( worker_ready < expected_worker )); then status=1; fi
    print_revision_summary "$DEMO_WORKER_APP"
    worker_image="$(current_container_image "$DEMO_WORKER_APP" || true)"
    if [[ -z "$worker_image" ]] || ! is_immutable_image_reference "$worker_image"; then
        printf 'FAIL image: Worker image is absent or mutable/ambiguous: %s\n' "${worker_image:-[absent]}" >&2
        status=1
    fi
fi

if [[ -n "${frontend_image:-}" && -n "${backend_image:-}" && -n "${worker_image:-}" ]]; then
    assert_expected_immutable_image "Frontend" "$frontend_image" "${DEMO_EXPECTED_FRONTEND_IMAGE:-}"
    assert_expected_immutable_image "Backend" "$backend_image" "${DEMO_EXPECTED_BACKEND_IMAGE:-}"
    assert_expected_immutable_image "Worker" "$worker_image" "${DEMO_EXPECTED_WORKER_IMAGE:-}"
fi

printf '\nHealth endpoints:\n'
frontend_base_url="${DEMO_FRONTEND_BASE_URL:-$DEMO_FRONTEND_BASE_URL_DEFAULT}"
frontend_health_path="${DEMO_FRONTEND_HEALTH_PATH:-/}"
[[ "$frontend_health_path" == /* ]] || fail "DEMO_FRONTEND_HEALTH_PATH must start with /."
check_health_endpoint "Frontend SSR" "${frontend_base_url}${frontend_health_path}" || { warn "Frontend SSR health check failed."; status=1; }
backend_base_url="${DEMO_BACKEND_BASE_URL:-$DEMO_BACKEND_BASE_URL_DEFAULT}"
check_health_endpoint "Backend live" "$backend_base_url/health/live" || { warn "Backend liveness check failed."; status=1; }
check_health_endpoint "Backend ready" "$backend_base_url/health/ready" || { warn "Backend readiness check failed."; status=1; }
if [[ "${DEMO_REQUIRE_CUSTOM_DOMAINS:-true}" == "true" ]]; then
    worker_base_url="${DEMO_WORKER_BASE_URL:-$DEMO_WORKER_BASE_URL_DEFAULT}"
    check_health_endpoint "Worker ready" "$worker_base_url/health/ready" || { warn "Worker readiness endpoint failed."; status=1; }
else
    printf 'Worker public health: skipped until domain handoff; ACA replica readiness remains required.\n'
fi

printf '\nQueue and Outbox:\n'
if row="$(queue_counts)"; then
    IFS=$'\t' read -r active dead_letter queue_state <<< "$row"
    printf 'Queue: Active=%s DLQ=%s namespace=%s\n' "$active" "$dead_letter" "$queue_state"
    if [[ "$active" != "0" || "$dead_letter" != "0" || "$queue_state" != "present" ]]; then status=1; fi
else
    warn "Service Bus Active/DLQ counts could not be confirmed."
    status=1
fi
if row="$(query_outbox_pending)"; then
    IFS=$'\t' read -r pending last_seen <<< "$row"
    printf 'Outbox: undelivered=%s lastMetric=%s\n' "$pending" "$last_seen"
    if [[ "$pending" != "0" ]]; then status=1; fi
else
    warn "Fresh Outbox metrics could not be confirmed."
    status=1
fi

printf '\nACA quota:\n'
if row="$(quota_values)"; then
    IFS=$'\t' read -r current limit <<< "$row"
    required="${DEMO_REQUIRED_MAX_CORES:-$DEMO_REQUIRED_MAX_CORES_DEFAULT}"
    printf 'Consumption cores: current=%s limit=%s requiredWarmMaximum=%s\n' "$current" "$limit" "$required"
    if ! awk -v limit="$limit" -v required="$required" 'BEGIN { exit !(limit >= required) }'; then status=1; fi
else
    warn "ACA consumption core quota could not be confirmed."
    status=1
fi

printf '\nAzure for Students credit/budget must also be confirmed in Azure Portal; this script does not infer credit from quota.\n'
if (( status != 0 )); then
    fail "Demo readiness check failed. Do not start the live demo."
fi
printf '\nDemo readiness check passed.\n'
