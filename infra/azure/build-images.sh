#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
acr_name="${AZURE_ACR_NAME:?Set AZURE_ACR_NAME to the ACR created by the foundation deployment}"
image_tag="${AZURE_IMAGE_TAG:-test}"

az acr build \
    --registry "$acr_name" \
    --image "awaver-backend:$image_tag" \
    --file src/backend/Awaver.Backend/Dockerfile \
    "$workspace_root"

az acr build \
    --registry "$acr_name" \
    --image "awaver-worker:$image_tag" \
    --file src/worker/Dockerfile \
    "$workspace_root"
