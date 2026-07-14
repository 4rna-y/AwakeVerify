#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
registry="${CONTAINER_IMAGE_REGISTRY:-ghcr.io}"
namespace="${CONTAINER_IMAGE_NAMESPACE:-4rna-y}"
image_tag="${AZURE_IMAGE_TAG:-test}"
backend_image="$registry/$namespace/awaver-backend:$image_tag"
worker_image="$registry/$namespace/awaver-worker:$image_tag"

docker buildx build \
    --platform linux/amd64 \
    --push \
    --tag "$backend_image" \
    --file src/backend/Awaver.Backend/Dockerfile \
    "$workspace_root"

docker buildx build \
    --platform linux/amd64 \
    --push \
    --tag "$worker_image" \
    --file src/worker/Dockerfile \
    "$workspace_root"
