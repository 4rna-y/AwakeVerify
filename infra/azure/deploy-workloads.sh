#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
resource_group="${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP to awaver-devtest-rg}"
parameters_file="${AZURE_PARAMETERS_FILE:?Set AZURE_PARAMETERS_FILE to the ignored secure parameters file}"
deployment_name="${AZURE_DEPLOYMENT_NAME:-awaver-workloads-$(date +%Y%m%d%H%M%S)}"
frontend_image="${AZURE_FRONTEND_IMAGE:?Set AZURE_FRONTEND_IMAGE to the immutable Frontend GHCR image reference}"
backend_image="${AZURE_BACKEND_IMAGE:?Set AZURE_BACKEND_IMAGE to the immutable Backend GHCR image reference}"
worker_image="${AZURE_WORKER_IMAGE:?Set AZURE_WORKER_IMAGE to the immutable Worker GHCR image reference}"

is_immutable_image_reference() {
    local image="$1"
    [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]]
}

for image in "$frontend_image" "$backend_image" "$worker_image"; do
    if ! is_immutable_image_reference "$image"; then
        echo "All AZURE_*_IMAGE values must be digest-pinned OCI references." >&2
        exit 1
    fi
done

if [[ ! -f "$parameters_file" ]]; then
    echo "AZURE_PARAMETERS_FILE does not exist: $parameters_file" >&2
    exit 1
fi

printf 'Deploy Frontend, Backend, and Worker workloads to %s using digest-pinned images. Continue? [y/N] ' "$resource_group"
read -r answer
if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "Deployment cancelled."
    exit 0
fi

az deployment group create \
    --name "$deployment_name" \
    --resource-group "$resource_group" \
    --template-file "$workspace_root/infra/azure/main.bicep" \
    --parameters "@$workspace_root/infra/azure/nonprod.parameters.json" \
    --parameters "@$parameters_file" \
    --parameters deployWorkloads=true deployFrontend=true \
    --parameters frontendImage="$frontend_image" \
    --parameters backendImage="$backend_image" \
    --parameters workerImage="$worker_image"
