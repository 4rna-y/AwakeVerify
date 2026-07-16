#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-common.sh
source "$script_dir/demo-common.sh"

parameters_file="${AZURE_PARAMETERS_FILE:?Set AZURE_PARAMETERS_FILE to the ignored secure parameters file}"
runtime_parameters_file=""
runtime_parameters_update_file=""
video_url_file=""
cleanup_runtime_files() {
    if [[ -n "$runtime_parameters_update_file" && -f "$runtime_parameters_update_file" ]]; then
        rm -f -- "$runtime_parameters_update_file"
    fi
    if [[ -n "$video_url_file" && -f "$video_url_file" ]]; then
        rm -f -- "$video_url_file"
    fi
    if [[ -n "$runtime_parameters_file" && -f "$runtime_parameters_file" ]]; then
        rm -f -- "$runtime_parameters_file"
    fi
}
trap cleanup_runtime_files EXIT

frontend_image="${AZURE_FRONTEND_IMAGE:?Set AZURE_FRONTEND_IMAGE to the digest-pinned Frontend image reference}"
backend_image="${AZURE_BACKEND_IMAGE:?Set AZURE_BACKEND_IMAGE to the digest-pinned Backend image reference}"
worker_image="${AZURE_WORKER_IMAGE:?Set AZURE_WORKER_IMAGE to the digest-pinned Worker image reference}"
backend_api_app_id="${AZURE_BACKEND_API_APP_ID:?Set AZURE_BACKEND_API_APP_ID to the Backend API App Registration client ID}"

assert_azure_context
assert_shared_resources_preserved
assert_demo_parameter_contract "$parameters_file"
assert_workload_bicep_contract
assert_bicep_images_use_shared_tag
assert_bicep_zero_scale_contract frontendMinReplicas
assert_bicep_zero_scale_contract backendMinInstances
assert_expected_immutable_image "Frontend requested" "$frontend_image" "$frontend_image" >/dev/null
assert_expected_immutable_image "Backend requested" "$backend_image" "$backend_image" >/dev/null
assert_expected_immutable_image "Worker requested" "$worker_image" "$worker_image" >/dev/null
assert_parameter_file_image_contract "$DEMO_WORKSPACE_ROOT/infra/azure/nonprod.parameters.json"
assert_parameter_file_image_contract "$parameters_file"

printf '\nRecreate plan (existing deployment scripts and their TTY prompts are preserved):\n'
printf '1. Bicep build and foundation validation\n'
printf '2. Foundation deployment via deploy.sh\n'
printf '3. resrc/60s.mp4 upload and read-only SAS creation via demo-video-upload.sh\n'
printf '4. Secret lessonVideoUrl and lessonVideoId=60s injection into a mode-0600 runtime parameter file\n'
printf '5. Frontend-enabled workload validation and Worker deployment at min=0 via deploy-workloads.sh\n'
printf '6. analysis_worker app-role assignment before any Worker token is issued\n'
printf '7. Worker warm-up to 12 replicas, then replica, health, lesson env contract, queue, Outbox, image, and quota checks via demo-check.sh\n'
printf 'Target: %s / prefix %s / digest-pinned Frontend, Backend, and Worker images\n' "$DEMO_RESOURCE_GROUP" "$DEMO_NAME_PREFIX"
printf 'Secure parameter values are intentionally not displayed.\n'

if [[ "${ALLOW_AZURE_DEMO_RECREATE:-false}" != "true" ]]; then
    printf '\nPREVIEW ONLY. Set ALLOW_AZURE_DEMO_RECREATE=true and run in a TTY to deploy.\n'
    exit 0
fi

confirm_fixed_phrase "RECREATE AWAVERTEST RESOURCES"

require_command mktemp
require_command stat
runtime_parameters_file="$(mktemp "${TMPDIR:-/tmp}/awaver-demo-parameters.XXXXXX.json")"
jq '
    del(.parameters.lessonVideoUrl, .parameters.lessonVideoId)
    | .parameters.deployWorkloads = {"value": false}
    | .parameters.deployFrontend = {"value": true}
    | .parameters.frontendMinReplicas = {"value": 1}
    | .parameters.frontendMaxReplicas = {"value": 1}
    | .parameters.backendMinInstances = {"value": 2}
    | .parameters.backendMaxInstances = {"value": 2}
    # A managed identity token can be cached for around 24 hours. Do not start
    # the Worker until its analysis_worker app role is present, or its first
    # token can lack the role for the whole demo window.
    | .parameters.workerMinReplicas = {"value": 0}
    | .parameters.workerMaxReplicas = {"value": 15}
' "$parameters_file" > "$runtime_parameters_file"
chmod 600 "$runtime_parameters_file"

export AZURE_RESOURCE_GROUP="$DEMO_RESOURCE_GROUP"
export AZURE_PARAMETERS_FILE="$runtime_parameters_file"
export AZURE_FRONTEND_IMAGE="$frontend_image"
export AZURE_BACKEND_IMAGE="$backend_image"
export AZURE_WORKER_IMAGE="$worker_image"

bash "$script_dir/validate.sh"
bash "$script_dir/deploy.sh"
assert_shared_resources_preserved

video_url_file="$(mktemp "${TMPDIR:-/tmp}/awaver-demo-video-url.XXXXXX")"
chmod 600 "$video_url_file"
DEMO_VIDEO_URL_OUTPUT_FILE="$video_url_file" \
ALLOW_AZURE_DEMO_VIDEO_UPLOAD=true \
DEMO_VIDEO_OVERWRITE="${DEMO_VIDEO_OVERWRITE:-true}" \
bash "$script_dir/demo-video-upload.sh"
[[ -s "$video_url_file" ]] || fail "Video upload did not produce a SAS URL file."
[[ "$(stat -c '%a' "$video_url_file")" == "600" ]] || fail "Video SAS URL file must have mode 0600."

runtime_parameters_update_file="$(mktemp "${TMPDIR:-/tmp}/awaver-demo-parameters-update.XXXXXX.json")"
jq --rawfile lesson_video_url "$video_url_file" '
    ($lesson_video_url | gsub("[\\r\\n]+$"; "")) as $url
    | if (($url | startswith("https://")) and (($url | length) > 8)) then
        .parameters.lessonVideoUrl = {"value": $url}
        | .parameters.lessonVideoId = {"value": "60s"}
      else
        error("Video SAS URL file is empty or invalid")
      end
' "$runtime_parameters_file" > "$runtime_parameters_update_file"
chmod 600 "$runtime_parameters_update_file"
mv -f -- "$runtime_parameters_update_file" "$runtime_parameters_file"
runtime_parameters_update_file=""
chmod 600 "$runtime_parameters_file"
printf 'Injected lessonVideoUrl and lessonVideoId=60s into the protected runtime parameter file without displaying the URL.\n'

az deployment group validate \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --template-file "$DEMO_WORKSPACE_ROOT/infra/azure/main.bicep" \
    --parameters "@$DEMO_WORKSPACE_ROOT/infra/azure/nonprod.parameters.json" \
    --parameters "@$runtime_parameters_file" \
    --parameters deployWorkloads=true deployFrontend=true \
    --parameters frontendImage="$frontend_image" \
    --parameters backendImage="$backend_image" \
    --parameters workerImage="$worker_image" \
    --output none
bash "$script_dir/deploy-workloads.sh"
assert_shared_resources_preserved
frontend_app="${DEMO_FRONTEND_APP_NAME:-$DEMO_FRONTEND_APP_DEFAULT}"
is_allowed_frontend_app_name "$frontend_app" || fail "Recreate Frontend target is not allow-listed: $frontend_app"
assert_resource "$frontend_app" "Microsoft.App/containerApps" >/dev/null

# Ensure a prior Worker revision cannot start and cache a token before the
# current revision's managed identity has its application role.
worker_deployed_revision="$(az containerapp show \
    --name "$DEMO_WORKER_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --query properties.latestRevisionName \
    --output tsv 2>/dev/null)" || fail "Unable to read the deployed Worker revision."
[[ -n "$worker_deployed_revision" ]] || fail "Deployed Worker revision is empty."
while IFS= read -r worker_previous_revision; do
    [[ -z "$worker_previous_revision" || "$worker_previous_revision" == "$worker_deployed_revision" ]] && continue
    az containerapp revision deactivate \
        --name "$DEMO_WORKER_APP" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --revision "$worker_previous_revision" \
        --only-show-errors \
        --output none || fail "Unable to deactivate stale Worker revision: $worker_previous_revision"
done < <(az containerapp revision list \
    --name "$DEMO_WORKER_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --query '[?properties.active].name' \
    --output tsv)

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

# The Worker was intentionally deployed at zero replicas so no role-less
# managed identity token exists. Start the warm profile only after the Graph
# assignment is visible.
az containerapp update \
    --name "$DEMO_WORKER_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --min-replicas 12 \
    --max-replicas 15 \
    --only-show-errors \
    --output none || fail "Unable to warm the Worker after assigning its app role."

worker_latest_revision="$(az containerapp show \
    --name "$DEMO_WORKER_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --query properties.latestRevisionName \
    --output tsv 2>/dev/null)" || fail "Unable to read the latest Worker revision."
[[ -n "$worker_latest_revision" ]] || fail "Latest Worker revision is empty after warm-up."
while IFS= read -r worker_previous_revision; do
    [[ -z "$worker_previous_revision" || "$worker_previous_revision" == "$worker_latest_revision" ]] && continue
    az containerapp revision deactivate \
        --name "$DEMO_WORKER_APP" \
        --resource-group "$DEMO_RESOURCE_GROUP" \
        --revision "$worker_previous_revision" \
        --only-show-errors \
        --output none || fail "Unable to deactivate stale Worker revision: $worker_previous_revision"
done < <(az containerapp revision list \
    --name "$DEMO_WORKER_APP" \
    --resource-group "$DEMO_RESOURCE_GROUP" \
    --query '[?properties.active].name' \
    --output tsv)

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
DEMO_EXPECTED_FRONTEND_IMAGE="$frontend_image" \
DEMO_EXPECTED_BACKEND_IMAGE="$backend_image" \
DEMO_EXPECTED_WORKER_IMAGE="$worker_image" \
DEMO_EXPECTED_FRONTEND_READY=1 \
DEMO_EXPECTED_FRONTEND_MAX=1 \
DEMO_EXPECTED_BACKEND_READY=2 \
DEMO_EXPECTED_BACKEND_MAX=2 \
DEMO_EXPECTED_WORKER_READY=12 \
DEMO_EXPECTED_WORKER_MAX=15 \
bash "$script_dir/demo-check.sh"

printf '\nRecreate completed. The temporary SAS URL and runtime parameter files were scheduled for cleanup. Next run demo-domain-handoff.sh; do not start the demo until DNS, managed certificates, and custom-domain checks pass.\n'
