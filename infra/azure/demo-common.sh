#!/usr/bin/env bash
set -euo pipefail
set +x

readonly DEMO_RESOURCE_GROUP="awaver-devtest-rg"
readonly DEMO_SUBSCRIPTION_NAME="Azure for Students"
readonly DEMO_NAME_PREFIX="awavertest"
readonly DEMO_SHARED_SIGNALR_NAME="awaver-signalr-devtest-436cd826"
readonly DEMO_SHARED_SIGNALR_TYPE="Microsoft.SignalRService/SignalR"
readonly DEMO_FRONTEND_APP_DEFAULT="awavertest-frontend"
readonly DEMO_FRONTEND_APP_ALTERNATE="awaverdemo-frontend"
readonly DEMO_BACKEND_APP="awavertest-backend"
readonly DEMO_WORKER_APP="awavertest-worker"
readonly DEMO_CONTAINER_ENV="awavertest-cae"
readonly DEMO_SERVICE_BUS="awavertest-servicebus"
readonly DEMO_FRAME_QUEUE_DEFAULT="frame-processing-queue-http-v2"
readonly DEMO_APP_INSIGHTS="awavertest-backend-ai"
readonly DEMO_STORAGE_ACCOUNT="awaverteststorage"
readonly DEMO_REQUIRED_MAX_CORES_DEFAULT="18"
readonly DEMO_FRONTEND_BASE_URL_DEFAULT="https://awaver.4rnay.net"
readonly DEMO_BACKEND_BASE_URL_DEFAULT="https://api.awaver.4rnay.net"
readonly DEMO_WORKER_BASE_URL_DEFAULT="https://worker.api.awaver.4rnay.net"
readonly DEMO_OUTBOX_METRIC="awaver.backend.outbox.undelivered.count"

_demo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEMO_SCRIPT_DIR="$_demo_dir"
readonly DEMO_WORKSPACE_ROOT="$(cd "$DEMO_SCRIPT_DIR/../.." && pwd)"
unset _demo_dir

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

warn() {
    printf 'WARNING: %s\n' "$*" >&2
}

info() {
    printf '%s\n' "$*"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"
}

require_azure_tools() {
    require_command az
    require_command jq
}

require_tty() {
    [[ -t 0 && -t 1 ]] || fail "This operation requires an interactive TTY on stdin and stdout."
}

confirm_fixed_phrase() {
    local expected="$1"
    local entered

    require_tty
    printf 'Type exactly "%s" to continue: ' "$expected"
    IFS= read -r entered
    [[ "$entered" == "$expected" ]] || fail "Confirmation phrase did not match. No changes were made by this step."
}

assert_azure_context() {
    require_azure_tools

    local account_id account_name account_state group_exists group_location
    account_id="$(az account show --query id --output tsv 2>/dev/null)" || fail "Unable to read the active Azure CLI account. Run az login first."
    account_name="$(az account show --query name --output tsv 2>/dev/null)" || fail "Unable to read the active Azure CLI subscription name."
    account_state="$(az account show --query state --output tsv 2>/dev/null)" || fail "Unable to read the active Azure CLI subscription state."

    [[ -n "$account_id" && "$account_name" == "$DEMO_SUBSCRIPTION_NAME" && "$account_state" == "Enabled" ]] || \
        fail "Active subscription must be the enabled '$DEMO_SUBSCRIPTION_NAME' subscription."
    if [[ -n "${AZURE_SUBSCRIPTION_ID:-}" && "$account_id" != "$AZURE_SUBSCRIPTION_ID" ]]; then
        fail "Active subscription ID does not match AZURE_SUBSCRIPTION_ID."
    fi

    group_exists="$(az group exists --name "$DEMO_RESOURCE_GROUP" --output tsv 2>/dev/null)" || fail "Unable to verify resource group $DEMO_RESOURCE_GROUP."
    [[ "$group_exists" == "true" ]] || fail "Required resource group does not exist: $DEMO_RESOURCE_GROUP"
    group_location="$(az group show --name "$DEMO_RESOURCE_GROUP" --query location --output tsv 2>/dev/null)" || fail "Unable to read resource group location."
    [[ "${group_location,,}" == "japaneast" ]] || fail "Resource group $DEMO_RESOURCE_GROUP must be in Japan East; found $group_location."

    printf 'Azure target: %s (%s) / %s / %s\n' "$account_name" "$account_id" "$DEMO_RESOURCE_GROUP" "$group_location"
}

resource_id_for() {
    local name="$1"
    local type="$2"
    az resource show \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --name "$name" \
        --resource-type "$type" \
        --query id \
        --output tsv 2>/dev/null
}

resource_exists() {
    local id
    id="$(resource_id_for "$1" "$2" || true)"
    [[ -n "$id" ]]
}

assert_resource() {
    local name="$1"
    local type="$2"
    local id
    id="$(resource_id_for "$name" "$type" || true)"
    [[ -n "$id" ]] || fail "Expected resource was not found with exact name and type: $name ($type)"
    printf '%s\n' "$id"
}

assert_shared_resources_preserved() {
    assert_resource "$DEMO_SHARED_SIGNALR_NAME" "$DEMO_SHARED_SIGNALR_TYPE" >/dev/null
}

is_allowed_frontend_app_name() {
    [[ "$1" == "$DEMO_FRONTEND_APP_DEFAULT" || "$1" == "$DEMO_FRONTEND_APP_ALTERNATE" ]]
}

resolve_frontend_app() {
    local requested="${DEMO_FRONTEND_APP_NAME:-}"
    local default_exists=false
    local alternate_exists=false

    if [[ -n "$requested" ]]; then
        is_allowed_frontend_app_name "$requested" || fail "DEMO_FRONTEND_APP_NAME must be $DEMO_FRONTEND_APP_DEFAULT or $DEMO_FRONTEND_APP_ALTERNATE."
        resource_exists "$requested" "Microsoft.App/containerApps" || return 1
        printf '%s\n' "$requested"
        return 0
    fi

    resource_exists "$DEMO_FRONTEND_APP_DEFAULT" "Microsoft.App/containerApps" && default_exists=true
    resource_exists "$DEMO_FRONTEND_APP_ALTERNATE" "Microsoft.App/containerApps" && alternate_exists=true
    if [[ "$default_exists" == "true" && "$alternate_exists" == "true" ]]; then
        fail "Both allowed Frontend Container Apps exist; set DEMO_FRONTEND_APP_NAME explicitly to avoid an ambiguous operation."
    fi
    if [[ "$default_exists" == "true" ]]; then
        printf '%s\n' "$DEMO_FRONTEND_APP_DEFAULT"
        return 0
    fi
    if [[ "$alternate_exists" == "true" ]]; then
        printf '%s\n' "$DEMO_FRONTEND_APP_ALTERNATE"
        return 0
    fi
    return 1
}

parameter_value() {
    local file="$1"
    local key="$2"
    jq -er --arg key "$key" '.parameters[$key].value // empty' "$file"
}

bicep_parameter_declared() {
    local parameter_name="$1"
    grep -Eq "^[[:space:]]*param[[:space:]]+${parameter_name}[[:space:]]+" "$DEMO_WORKSPACE_ROOT/infra/azure/main.bicep"
}

assert_bicep_parameter_declared() {
    bicep_parameter_declared "$1" || fail "main.bicep must declare the final parameter '$1' before this operation can run."
}

bicep_parameter_allows_zero() {
    local parameter_name="$1"
    local minimum_decorator
    minimum_decorator="$(awk -v target="$parameter_name" '
        /^[[:space:]]*@minValue\(/ { minimum = $0 }
        /^[[:space:]]*param[[:space:]]+/ {
            if ($2 == target) { print minimum; exit }
            minimum = ""
        }
    ' "$DEMO_WORKSPACE_ROOT/infra/azure/main.bicep")"
    [[ "$minimum_decorator" =~ @minValue\(0\) ]]
}

assert_bicep_zero_scale_contract() {
    local parameter_name="$1"
    assert_bicep_parameter_declared "$parameter_name"
    bicep_parameter_allows_zero "$parameter_name" || fail "main.bicep parameter '$parameter_name' does not allow min replicas 0."
}

assert_workload_bicep_contract() {
    local parameter_name
    for parameter_name in \
        deployFrontend imageTag frontendImage backendImage workerImage \
        frontendMinReplicas frontendMaxReplicas \
        backendMinInstances backendMaxInstances \
        workerMinReplicas workerMaxReplicas; do
        assert_bicep_parameter_declared "$parameter_name"
    done
}

assert_bicep_images_use_shared_tag() {
    local parameter_name declaration
    for parameter_name in frontendImage backendImage workerImage; do
        declaration="$(grep -E "^[[:space:]]*param[[:space:]]+${parameter_name}[[:space:]]+" "$DEMO_WORKSPACE_ROOT/infra/azure/main.bicep" || true)"
        [[ -n "$declaration" && "$declaration" == *'imageTag'* ]] || fail "main.bicep parameter '$parameter_name' must default to the shared imageTag contract."
    done
}

assert_parameter_file_image_contract() {
    local parameters_file="$1"
    local expected_tag="$2"
    local parameter_name image
    [[ -f "$parameters_file" ]] || fail "Parameter file does not exist: $parameters_file"
    for parameter_name in frontendImage backendImage workerImage; do
        image="$(parameter_value "$parameters_file" "$parameter_name" 2>/dev/null || true)"
        if [[ -n "$image" ]]; then
            assert_same_immutable_image_tag "$expected_tag" "$image" >/dev/null
        fi
    done
}

assert_demo_parameter_contract() {
    local parameters_file="$1"
    [[ -f "$parameters_file" ]] || fail "Secure parameter file does not exist: $parameters_file"

    local name_prefix storage postgres redis
    name_prefix="$(parameter_value "$parameters_file" namePrefix)" || fail "Secure parameter file must define namePrefix."
    storage="$(parameter_value "$parameters_file" storageAccountName)" || fail "Secure parameter file must define storageAccountName."
    postgres="$(parameter_value "$parameters_file" postgresServerName)" || fail "Secure parameter file must define postgresServerName."
    redis="$(parameter_value "$parameters_file" redisCacheName)" || fail "Secure parameter file must define redisCacheName."

    [[ "$name_prefix" == "$DEMO_NAME_PREFIX" ]] || fail "namePrefix must be exactly $DEMO_NAME_PREFIX."
    [[ "$storage" == "$DEMO_STORAGE_ACCOUNT" ]] || fail "storageAccountName must be exactly $DEMO_STORAGE_ACCOUNT."
    [[ "$postgres" == "awavertestpostgres" ]] || fail "postgresServerName must be exactly awavertestpostgres."
    [[ "$redis" == "awavertestredis" ]] || fail "redisCacheName must be exactly awavertestredis."
}

is_immutable_image_tag() {
    local tag="$1"
    [[ "$tag" =~ ^[0-9]{8}-[0-9a-f]{7,40}$ ||
       "$tag" =~ ^[0-9a-f]{40}$ ||
       "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{7,40}$ ]]
}

assert_immutable_image_tag() {
    local tag="$1"
    is_immutable_image_tag "$tag" || fail "AZURE_IMAGE_TAG must contain an immutable commit identifier (for example 20260715-a1b2c3d); mutable or ambiguous tags are rejected."
}

is_immutable_image_reference() {
    local image="$1"
    if [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]]; then
        return 0
    fi
    [[ "$image" == *:* ]] || return 1
    is_immutable_image_tag "${image##*:}"
}

image_tag_from_reference() {
    local image="$1"
    [[ "$image" != *@* && "$image" == *:* ]] || return 1
    printf '%s\n' "${image##*:}"
}

assert_same_immutable_image_tag() {
    local expected_tag="${1:-}"
    shift
    local image image_tag common_tag=""

    for image in "$@"; do
        is_immutable_image_reference "$image" || fail "Image reference is mutable or ambiguous: $image"
        image_tag="$(image_tag_from_reference "$image")" || fail "All Frontend/Backend/Worker images must use the same immutable tag rather than per-image digests."
        if [[ -z "$common_tag" ]]; then
            common_tag="$image_tag"
        elif [[ "$image_tag" != "$common_tag" ]]; then
            fail "Frontend, Backend, and Worker image tags do not match."
        fi
    done
    [[ -z "$expected_tag" || "$common_tag" == "$expected_tag" ]] || fail "Deployed image tag does not match expected tag $expected_tag."
    printf '%s\n' "$common_tag"
}

containerapp_domain_handoff_row() {
    local app="$1"
    local row environment_id verification_id static_ip
    row="$(az containerapp show \
        --name "$app" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --query '[properties.managedEnvironmentId,properties.customDomainVerificationId]' \
        --output tsv 2>/dev/null)" || return 1
    IFS=$'\t' read -r environment_id verification_id <<< "$row"
    [[ -n "$environment_id" && -n "$verification_id" ]] || return 1
    static_ip="$(az resource show --ids "$environment_id" --query properties.staticIp --output tsv 2>/dev/null)" || return 1
    [[ -n "$static_ip" ]] || return 1
    printf '%s\t%s\n' "$static_ip" "$verification_id"
}

queue_counts() {
    local queue_name="${DEMO_FRAME_QUEUE_NAME:-$DEMO_FRAME_QUEUE_DEFAULT}"
    local active dead_letter

    if ! resource_exists "$DEMO_SERVICE_BUS" "Microsoft.ServiceBus/namespaces"; then
        printf '0\t0\tabsent\n'
        return 0
    fi

    active="$(az servicebus queue show \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --namespace-name "$DEMO_SERVICE_BUS" \
        --name "$queue_name" \
        --query countDetails.activeMessageCount \
        --output tsv 2>/dev/null)" || return 1
    dead_letter="$(az servicebus queue show \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --namespace-name "$DEMO_SERVICE_BUS" \
        --name "$queue_name" \
        --query countDetails.deadLetterMessageCount \
        --output tsv 2>/dev/null)" || return 1
    [[ "$active" =~ ^[0-9]+$ && "$dead_letter" =~ ^[0-9]+$ ]] || return 1
    printf '%s\t%s\tpresent\n' "$active" "$dead_letter"
}

require_queue_zero() {
    local row active dead_letter state
    row="$(queue_counts)" || fail "Service Bus Active/DLQ counts could not be confirmed."
    IFS=$'\t' read -r active dead_letter state <<< "$row"
    printf 'Queue gate: Active=%s DLQ=%s namespace=%s\n' "$active" "$dead_letter" "$state"
    [[ "$active" == "0" && "$dead_letter" == "0" ]] || fail "Service Bus Active and DLQ counts must both be zero."
}

query_outbox_pending() {
    local lookback_minutes="${DEMO_OUTBOX_LOOKBACK_MINUTES:-10}"
    [[ "$lookback_minutes" =~ ^[1-9][0-9]*$ ]] || return 1
    resource_exists "$DEMO_APP_INSIGHTS" "Microsoft.Insights/components" || return 1

    local query row_json row pending last_seen
    query="customMetrics
| where timestamp >= ago(${lookback_minutes}m)
| where name == \"${DEMO_OUTBOX_METRIC}\"
| summarize arg_max(timestamp, value) by cloud_RoleInstance
| summarize Pending=max(toint(value)), LastSeen=max(timestamp)"

    row_json="$(az monitor app-insights query \
        --app "$DEMO_APP_INSIGHTS" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --analytics-query "$query" \
        --query 'tables[0].rows[0]' \
        --output json 2>/dev/null)" || return 1
    row="$(jq -r 'if type == "array" and length >= 2 then @tsv else empty end' <<< "$row_json")"
    IFS=$'\t' read -r pending last_seen <<< "$row"
    [[ "$pending" =~ ^[0-9]+$ && -n "$last_seen" ]] || return 1
    printf '%s\t%s\n' "$pending" "$last_seen"
}

require_outbox_zero() {
    local row pending last_seen
    row="$(query_outbox_pending)" || fail "Outbox could not be confirmed from fresh Application Insights metrics; refusing the operation."
    IFS=$'\t' read -r pending last_seen <<< "$row"
    printf 'Outbox gate: undelivered=%s lastMetric=%s\n' "$pending" "$last_seen"
    [[ "$pending" == "0" ]] || fail "Outbox undelivered count must be zero."
}

quota_values() {
    local usages row current limit
    resource_exists "$DEMO_CONTAINER_ENV" "Microsoft.App/managedEnvironments" || return 1
    usages="$(az containerapp env list-usages \
        --name "$DEMO_CONTAINER_ENV" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --output json 2>/dev/null)" || return 1
    row="$(jq -r '[.[] | select((((.name.localizedValue // "") + " " + (.name.value // "")) | ascii_downcase | contains("core")))] | first | if . == null then empty else [.currentValue,.limit] | @tsv end' <<< "$usages")"
    IFS=$'\t' read -r current limit <<< "$row"
    [[ "$current" =~ ^[0-9]+([.][0-9]+)?$ && "$limit" =~ ^[0-9]+([.][0-9]+)?$ ]] || return 1
    printf '%s\t%s\n' "$current" "$limit"
}

require_demo_quota() {
    local required="${DEMO_REQUIRED_MAX_CORES:-$DEMO_REQUIRED_MAX_CORES_DEFAULT}"
    local row current limit
    [[ "$required" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "DEMO_REQUIRED_MAX_CORES must be numeric."
    row="$(quota_values)" || fail "ACA consumption core quota could not be confirmed."
    IFS=$'\t' read -r current limit <<< "$row"
    printf 'ACA quota: current=%s limit=%s requiredWarmMaximum=%s cores\n' "$current" "$limit" "$required"
    awk -v limit="$limit" -v required="$required" 'BEGIN { exit !(limit >= required) }' || fail "ACA quota is below the required warm-profile maximum."
}

containerapp_scale_row() {
    az containerapp show \
        --name "$1" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --query '[name,properties.template.scale.minReplicas,properties.template.scale.maxReplicas]' \
        --output tsv 2>/dev/null
}

containerapp_scale_matches() {
    local app="$1"
    local expected_min="$2"
    local expected_max="$3"
    local row name actual_min actual_max
    row="$(containerapp_scale_row "$app")" || return 1
    IFS=$'\t' read -r name actual_min actual_max <<< "$row"
    [[ "$name" == "$app" && "$actual_min" == "$expected_min" && "$actual_max" == "$expected_max" ]]
}

print_containerapp_scale() {
    local row name minimum maximum
    row="$(containerapp_scale_row "$1")" || fail "Unable to read scale settings for $1."
    IFS=$'\t' read -r name minimum maximum <<< "$row"
    printf '%-24s min=%-3s max=%-3s\n' "$name" "$minimum" "$maximum"
}

active_revision_name() {
    az containerapp revision list \
        --name "$1" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --query '[?properties.active].name | [0]' \
        --output tsv 2>/dev/null
}

ready_replica_count() {
    local app="$1"
    local revision replicas
    revision="$(active_revision_name "$app")" || return 1
    [[ -n "$revision" ]] || return 1
    replicas="$(az containerapp replica list \
        --name "$app" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --revision "$revision" \
        --output json 2>/dev/null)" || return 1
    jq -r '[.[]
        | select(.properties.runningState == "Running")
        | select((.properties.containers // []) | length > 0)
        | select(all(.properties.containers[]; .ready == true))] | length' <<< "$replicas"
}

running_replica_count() {
    local app="$1"
    local revision replicas
    revision="$(active_revision_name "$app")" || return 1
    [[ -n "$revision" ]] || return 1
    replicas="$(az containerapp replica list \
        --name "$app" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --revision "$revision" \
        --output json 2>/dev/null)" || return 1
    jq -r '[.[] | select(.properties.runningState == "Running")] | length' <<< "$replicas"
}

wait_for_ready_replicas() {
    local app="$1"
    local expected="$2"
    local timeout="${DEMO_READY_TIMEOUT_SECONDS:-900}"
    local started now count
    [[ "$expected" =~ ^[0-9]+$ && "$timeout" =~ ^[1-9][0-9]*$ ]] || fail "Invalid replica wait settings."
    started="$(date +%s)"

    while true; do
        count="$(ready_replica_count "$app" || printf 'unknown')"
        printf 'Waiting for %s: ready=%s expected-at-least=%s\n' "$app" "$count" "$expected"
        if [[ "$count" =~ ^[0-9]+$ ]] && (( count >= expected )); then
            return 0
        fi
        now="$(date +%s)"
        (( now - started < timeout )) || fail "Timed out waiting for ready replicas of $app."
        sleep 10
    done
}

wait_for_zero_running_replicas() {
    local app="$1"
    local timeout="${DEMO_COOLDOWN_TIMEOUT_SECONDS:-600}"
    local started now count
    [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || fail "Invalid cooldown timeout."
    started="$(date +%s)"

    while true; do
        count="$(running_replica_count "$app" || printf 'unknown')"
        printf 'Waiting for %s scale-down: running=%s expected=0\n' "$app" "$count"
        if [[ "$count" == "0" ]]; then
            return 0
        fi
        now="$(date +%s)"
        (( now - started < timeout )) || fail "Timed out waiting for $app to reach zero running replicas."
        sleep 10
    done
}

check_health_endpoint() {
    local label="$1"
    local url="$2"
    local status
    require_command curl
    status="$(curl --silent --show-error --output /dev/null \
        --connect-timeout 10 --max-time 20 \
        --write-out '%{http_code}' "$url" 2>/dev/null)" || return 1
    printf '%s: %s -> HTTP %s\n' "$label" "$url" "$status"
    [[ "$status" == "200" ]]
}

print_revision_summary() {
    local app="$1"
    az containerapp revision list \
        --name "$app" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --query '[].{Revision:name,Active:properties.active,Replicas:properties.replicas,Image:properties.template.containers[0].image}' \
        --output table
}

current_container_image() {
    local app="$1"
    az containerapp show \
        --name "$app" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --query 'properties.template.containers[0].image' \
        --output tsv 2>/dev/null
}
