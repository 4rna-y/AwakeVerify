#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
resource_group="${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP to the existing target resource group}"
parameters_file="${AZURE_PARAMETERS_FILE:?Set AZURE_PARAMETERS_FILE to the ignored secure parameters file}"

if [[ ! -f "$parameters_file" ]]; then
    echo "AZURE_PARAMETERS_FILE does not exist: $parameters_file" >&2
    exit 1
fi

az bicep build --file "$workspace_root/infra/azure/main.bicep" --stdout > /dev/null
az deployment group validate \
    --resource-group "$resource_group" \
    --template-file "$workspace_root/infra/azure/main.bicep" \
    --parameters "@$workspace_root/infra/azure/nonprod.parameters.json" \
    --parameters "@$parameters_file"
