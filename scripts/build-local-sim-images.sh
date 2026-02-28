#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

REGISTRY="${REGISTRY:-local}"
PLATFORM="${PLATFORM:-linux/arm64}"
BUILDER="${BUILDER:-multi}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-srv/stable/compose/.env}"

TAG="${1:-$(git rev-parse --short HEAD)}"

BACKEND_IMAGE="${REGISTRY}/stable-backend"
FRONTEND_IMAGE="${REGISTRY}/stable-frontend"

echo "==> Local simulation build config"
echo "REGISTRY=${REGISTRY}"
echo "PLATFORM=${PLATFORM}"
echo "BUILDER=${BUILDER}"
echo "TAG=${TAG}"

if ! docker buildx inspect "${BUILDER}" >/dev/null 2>&1; then
  echo "==> Creating buildx builder: ${BUILDER}"
  docker buildx create --name "${BUILDER}" --driver docker-container >/dev/null
fi
docker buildx use "${BUILDER}" >/dev/null
docker buildx inspect --bootstrap >/dev/null

echo "==> Building backend image (load to local Docker)"
docker buildx build \
  --platform "${PLATFORM}" \
  -t "${BACKEND_IMAGE}:${TAG}" \
  -f backend/Dockerfile backend \
  --load

echo "==> Building frontend image (load to local Docker)"
docker buildx build \
  --platform "${PLATFORM}" \
  -t "${FRONTEND_IMAGE}:${TAG}" \
  -f frontend/Dockerfile frontend \
  --load

echo "==> Updating ${COMPOSE_ENV_FILE}"
mkdir -p "$(dirname "${COMPOSE_ENV_FILE}")"
tmp_file="$(mktemp)"
if [[ -f "${COMPOSE_ENV_FILE}" ]]; then
  awk -v registry="${REGISTRY}" -v tag="${TAG}" '
    BEGIN { has_registry = 0; has_tag = 0 }
    /^REGISTRY=/ { print "REGISTRY=" registry; has_registry = 1; next }
    /^TAG=/ { print "TAG=" tag; has_tag = 1; next }
    { print }
    END {
      if (!has_registry) print "REGISTRY=" registry
      if (!has_tag) print "TAG=" tag
    }
  ' "${COMPOSE_ENV_FILE}" > "${tmp_file}"
else
  {
    echo "REGISTRY=${REGISTRY}"
    echo "TAG=${TAG}"
  } > "${tmp_file}"
fi
mv "${tmp_file}" "${COMPOSE_ENV_FILE}"

echo "==> Done"
echo "Built images:"
echo "  ${BACKEND_IMAGE}:${TAG}"
echo "  ${FRONTEND_IMAGE}:${TAG}"
echo "Compose env updated:"
echo "  ${COMPOSE_ENV_FILE}"
echo "  REGISTRY=${REGISTRY}"
echo "  TAG=${TAG}"
echo
echo "Next step (start prod-like simulation):"
echo "  cd srv/stable/compose && docker compose -f docker-compose.prod.yml up -d --remove-orphans"
