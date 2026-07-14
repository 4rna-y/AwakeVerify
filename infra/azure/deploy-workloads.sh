#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
resource_group="${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP to awaver-devtest-rg}"
parameters_file="${AZURE_PARAMETERS_FILE:?Set AZURE_PARAMETERS_FILE to the ignored secure parameters file}"
deployment_name="${AZURE_DEPLOYMENT_NAME:-awaver-workloads-$(date +%Y%m%d%H%M%S)}"
image_tag="${AZURE_IMAGE_TAG:-test}"

if [[ ! -f "$parameters_file" ]]; then
    echo "AZURE_PARAMETERS_FILE does not exist: $parameters_file" >&2
    exit 1
fi

printf 'Deploy Backend and Worker workloads to %s. Continue? [y/N] ' "$resource_group"
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
    --parameters deployWorkloads=true \
    --parameters imageTag="$image_tag"
