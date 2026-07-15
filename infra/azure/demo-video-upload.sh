#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-common.sh
source "$script_dir/demo-common.sh"

readonly VIDEO_FILE="$DEMO_WORKSPACE_ROOT/resrc/60s.mp4"
readonly VIDEO_CONTAINER="videos"
readonly VIDEO_BLOB_NAME="60s.mp4"

assert_azure_context
assert_resource "$DEMO_STORAGE_ACCOUNT" "Microsoft.Storage/storageAccounts" >/dev/null
[[ -f "$VIDEO_FILE" && -s "$VIDEO_FILE" ]] || fail "Required video is missing or empty: $VIDEO_FILE"
output_file="${DEMO_VIDEO_URL_OUTPUT_FILE:?Set DEMO_VIDEO_URL_OUTPUT_FILE to a Git-ignored file outside logs}"
[[ "$output_file" != "$DEMO_WORKSPACE_ROOT"/* ]] || fail "DEMO_VIDEO_URL_OUTPUT_FILE must be outside the repository to reduce accidental secret exposure."
require_command date

expiry="${DEMO_VIDEO_SAS_EXPIRY_UTC:-$(date -u -d '+24 hours' '+%Y-%m-%dT%H:%MZ')}"
expiry_epoch="$(date -u -d "$expiry" '+%s' 2>/dev/null)" || fail "DEMO_VIDEO_SAS_EXPIRY_UTC must be a valid UTC date."
now_epoch="$(date -u '+%s')"
(( expiry_epoch >= now_epoch + 900 )) || fail "Video SAS expiry must be at least 15 minutes in the future."
(( expiry_epoch <= now_epoch + 604800 )) || fail "Video SAS expiry must be no more than 7 days in the future."

container_exists="$(az storage container exists \
    --account-name "$DEMO_STORAGE_ACCOUNT" \
    --name "$VIDEO_CONTAINER" \
    --auth-mode login \
    --query exists \
    --output tsv 2>/dev/null)" || fail "Unable to verify the videos container with Entra authentication."
[[ "$container_exists" == "true" ]] || fail "Expected private container does not exist: $VIDEO_CONTAINER"

printf 'Upload target: %s/%s/%s\n' "$DEMO_STORAGE_ACCOUNT" "$VIDEO_CONTAINER" "$VIDEO_BLOB_NAME"
printf 'Read-only URL expiry: %s\n' "$expiry"
printf 'Secret URL output file: %s (mode 0600; URL will not be printed)\n' "$output_file"
[[ "${ALLOW_AZURE_DEMO_VIDEO_UPLOAD:-false}" == "true" ]] || fail "Set ALLOW_AZURE_DEMO_VIDEO_UPLOAD=true to permit upload and SAS generation."
confirm_fixed_phrase "UPLOAD AWAVERTEST DEMO VIDEO"

upload_args=(
    --account-name "$DEMO_STORAGE_ACCOUNT"
    --container-name "$VIDEO_CONTAINER"
    --name "$VIDEO_BLOB_NAME"
    --file "$VIDEO_FILE"
    --auth-mode login
    --only-show-errors
    --output none
)
if [[ "${DEMO_VIDEO_OVERWRITE:-false}" == "true" ]]; then
    upload_args+=(--overwrite true)
else
    upload_args+=(--overwrite false)
fi
az storage blob upload "${upload_args[@]}"

sas_token="$(az storage blob generate-sas \
    --account-name "$DEMO_STORAGE_ACCOUNT" \
    --container-name "$VIDEO_CONTAINER" \
    --name "$VIDEO_BLOB_NAME" \
    --permissions r \
    --expiry "$expiry" \
    --https-only \
    --as-user \
    --auth-mode login \
    --output tsv 2>/dev/null)" || fail "Unable to generate a user-delegation read-only SAS."
[[ -n "$sas_token" ]] || fail "Azure returned an empty SAS token."

mkdir -p "$(dirname "$output_file")"
printf 'https://%s.blob.core.windows.net/%s/%s?%s\n' \
    "$DEMO_STORAGE_ACCOUNT" "$VIDEO_CONTAINER" "$VIDEO_BLOB_NAME" "$sas_token" > "$output_file"
chmod 600 "$output_file"
unset sas_token

printf 'Video uploaded. The read-only URL was written without logging it: %s\n' "$output_file"
