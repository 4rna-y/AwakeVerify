#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-common.sh
source "$script_dir/demo-common.sh"

parameters_file="${AZURE_PARAMETERS_FILE:?Set AZURE_PARAMETERS_FILE to the ignored secure parameters file}"
runtime_parameters_file=""
cleanup_runtime_parameters() {
    if [[ -n "$runtime_parameters_file" && -f "$runtime_parameters_file" ]]; then
        rm -f -- "$runtime_parameters_file"
    fi
}
trap cleanup_runtime_parameters EXIT

image_tag="${AZURE_IMAGE_TAG:?Set AZURE_IMAGE_TAG to an immutable published GHCR tag}"
backend_api_app_id="${AZURE_BACKEND_API_APP_ID:?Set AZURE_BACKEND_API_APP_ID to the Backend API App Registration client ID}"

assert_azure_context
assert_shared_resources_preserved
assert_demo_parameter_contract "$parameters_file"
assert_workload_bicep_contract
assert_bicep_images_use_shared_tag
assert_bicep_zero_scale_contract frontendMinReplicas
assert_bicep_zero_scale_contract backendMinInstances
assert_immutable_image_tag "$image_tag"
assert_parameter_file_image_contract "$DEMO_WORKSPACE_ROOT/infra/azure/nonprod.parameters.json" "$image_tag"
assert_parameter_file_image_contract "$parameters_file" "$image_tag"

printf '\nRecreate plan (existing deployment scripts are reused):\n'
printf '1. Bicep build, foundation validation, and Frontend-enabled workload validation\n'
printf '2. Foundation deployment via deploy.sh\n'
printf '3. Frontend/Backend/Worker deployment with the same immutable tag via deploy-workloads.sh\n'
printf '4. analysis_worker app-role assignment to the new Worker managed identity\n'
printf '5. Replica, health, queue, Outbox, immutable-image, and quota checks via demo-check.sh\n'
printf 'Target: %s / prefix %s / image tag %s\n' "$DEMO_RESOURCE_GROUP" "$DEMO_NAME_PREFIX" "$image_tag"
printf 'Secure parameter values are intentionally not displayed.\n'

if [[ "${ALLOW_AZURE_DEMO_RECREATE:-false}" != "true" ]]; then
    printf '\nPREVIEW ONLY. Set ALLOW_AZURE_DEMO_RECREATE=true and run in a TTY to deploy.\n'
    exit 0
fi

confirm_fixed_phrase "RECREATE AWAVERTEST RESOURCES"

require_command mktemp
runtime_parameters_file="$(mktemp "${TMPDIR:-/tmp}/awaver-demo-parameters.XXXXXX.json")"
jq '
    .parameters.deployFrontend = {"value": true}
    | .parameters.frontendMinReplicas = {"value": 1}
    | .parameters.frontendMaxReplicas = {"value": 1}
    | .parameters.backendMinInstances = {"value": 2}
    | .parameters.backendMaxInstances = {"value": 2}
    | .parameters.workerMinReplicas = {"value": 12}
    | .parameters.workerMaxReplicas = {"value": 15}
' "$parameters_file" > "$runtime_parameters_file"
chmod 600 "$runtime_parameters_file"

export AZURE_RESOURCE_GROUP="$DEMO_RESOURCE_GROUP"
export AZURE_PARAMETERS_FILE="$runtime_parameters_file"
export AZURE_IMAGE_TAG="$image_tag"

bash "$script_dir/validate.sh"
az deployment group validate \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --template-file "$DEMO_WORKSPACE_ROOT/infra/azure/main.bicep" \
    --parameters "@$DEMO_WORKSPACE_ROOT/infra/azure/nonprod.parameters.json" \
    --parameters "@$runtime_parameters_file" \
    --parameters deployWorkloads=true deployFrontend=true imageTag="$image_tag" \
    --output none
bash "$script_dir/deploy.sh"
assert_shared_resources_preserved
bash "$script_dir/deploy-workloads.sh"
assert_shared_resources_preserved
frontend_app="${DEMO_FRONTEND_APP_NAME:-$DEMO_FRONTEND_APP_DEFAULT}"
is_allowed_frontend_app_name "$frontend_app" || fail "Recreate Frontend target is not allow-listed: $frontend_app"
assert_resource "$frontend_app" "Microsoft.App/containerApps" >/dev/null

worker_principal_id="$(az containerapp show \
    --name "$DEMO_WORKER_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --query identity.principalId \
    --output tsv 2>/dev/null)" || fail "Unable to read the Worker managed identity principal ID."
[[ -n "$worker_principal_id" ]] || fail "Worker managed identity principal ID is empty."
backend_resource_sp_id="$(az ad sp show --id "$backend_api_app_id" --query id --output tsv 2>/dev/null)" || \
    fail "Unable to resolve the Backend API service principal. Check Microsoft Graph permissions."
analysis_worker_role_id="$(az ad app show \
    --id "$backend_api_app_id" \
    --query "appRoles[?value=='analysis_worker' && contains(allowedMemberTypes, 'Application')].id | [0]" \
    --output tsv 2>/dev/null)" || fail "Unable to resolve the analysis_worker app role."
[[ -n "$backend_resource_sp_id" && -n "$analysis_worker_role_id" ]] || fail "Backend service principal or analysis_worker app role is missing."

assignments_url="https://graph.microsoft.com/v1.0/servicePrincipals/${worker_principal_id}/appRoleAssignments"
assignment_id="$(az rest \
    --method get \
    --url "$assignments_url" \
    --query "value[?resourceId=='${backend_resource_sp_id}' && appRoleId=='${analysis_worker_role_id}'].id | [0]" \
    --output tsv 2>/dev/null)" || fail "Unable to inspect Worker app-role assignments. Check Microsoft Graph permissions."
if [[ -z "$assignment_id" ]]; then
    assignment_body="{\"principalId\":\"${worker_principal_id}\",\"resourceId\":\"${backend_resource_sp_id}\",\"appRoleId\":\"${analysis_worker_role_id}\"}"
    az rest --method post --url "$assignments_url" --body "$assignment_body" --output none || \
        fail "analysis_worker assignment failed. Grant the required Microsoft Graph permission/admin consent, then rerun assignment verification."
    unset assignment_body
fi

assignment_id="$(az rest \
    --method get \
    --url "$assignments_url" \
    --query "value[?resourceId=='${backend_resource_sp_id}' && appRoleId=='${analysis_worker_role_id}'].id | [0]" \
    --output tsv 2>/dev/null)" || fail "Unable to verify the analysis_worker assignment."
[[ -n "$assignment_id" ]] || fail "analysis_worker app-role assignment is still absent."
printf 'Verified analysis_worker app-role assignment for the Worker managed identity.\n'

wait_for_ready_replicas "$frontend_app" 1
wait_for_ready_replicas "$DEMO_BACKEND_APP" 2
wait_for_ready_replicas "$DEMO_WORKER_APP" 12
frontend_fqdn="$(az containerapp show \
    --name "$frontend_app" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --query properties.configuration.ingress.fqdn \
    --output tsv 2>/dev/null)" || fail "Unable to read Frontend ACA FQDN."
[[ -n "$frontend_fqdn" ]] || fail "Frontend ACA FQDN is empty."
backend_fqdn="$(az containerapp show \
    --name "$DEMO_BACKEND_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --query properties.configuration.ingress.fqdn \
    --output tsv 2>/dev/null)" || fail "Unable to read Backend ACA FQDN."
[[ -n "$backend_fqdn" ]] || fail "Backend ACA FQDN is empty."

printf 'Waiting for a fresh Outbox metric before the final safety check.\n'
metric_deadline=$(( $(date +%s) + ${DEMO_OUTBOX_STARTUP_TIMEOUT_SECONDS:-300} ))
until query_outbox_pending >/dev/null 2>&1; do
    (( $(date +%s) < metric_deadline )) || fail "Fresh Outbox metrics did not appear before timeout."
    sleep 15
done

DEMO_FRONTEND_APP_NAME="$frontend_app" \
DEMO_FRONTEND_BASE_URL="https://${frontend_fqdn}" \
DEMO_BACKEND_BASE_URL="https://${backend_fqdn}" \
DEMO_REQUIRE_CUSTOM_DOMAINS=false \
DEMO_EXPECTED_IMAGE_TAG="$image_tag" \
DEMO_EXPECTED_FRONTEND_READY=1 \
DEMO_EXPECTED_FRONTEND_MAX=1 \
DEMO_EXPECTED_BACKEND_READY=2 \
DEMO_EXPECTED_BACKEND_MAX=2 \
DEMO_EXPECTED_WORKER_READY=12 \
DEMO_EXPECTED_WORKER_MAX=15 \
bash "$script_dir/demo-check.sh"

printf '\nRecreate completed. Next run demo-video-upload.sh and demo-domain-handoff.sh; do not start the demo until DNS, managed certificates, and custom-domain checks pass.\n'
