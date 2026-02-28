#!/usr/bin/env bash
set -euo pipefail

BUILDER_NAME="${1:-multi}"

if ! docker buildx inspect "${BUILDER_NAME}" >/dev/null 2>&1; then
  echo "==> Creating buildx builder: ${BUILDER_NAME}"
  docker buildx create --name "${BUILDER_NAME}" --driver docker-container >/dev/null
fi

echo "==> Switching to builder: ${BUILDER_NAME}"
docker buildx use "${BUILDER_NAME}" >/dev/null

echo "==> Bootstrapping builder"
docker buildx inspect --bootstrap
