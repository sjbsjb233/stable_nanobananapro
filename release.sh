#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

REGISTRY="${REGISTRY:-docker.io}"
NAMESPACE="${NAMESPACE:-sjbsjb233}"
APP_NAME="${APP_NAME:-stable-nanobananapro}"
PLATFORM="${PLATFORM:-linux/amd64}"
BUILDER="${BUILDER:-multi}"
PUSH_LATEST="${PUSH_LATEST:-1}"

TAG="${1:-$(git rev-parse --short HEAD)}"

BACKEND_IMAGE="${REGISTRY}/${NAMESPACE}/${APP_NAME}-backend"
FRONTEND_IMAGE="${REGISTRY}/${NAMESPACE}/${APP_NAME}-frontend"

echo "==> Release config"
echo "REGISTRY=${REGISTRY}"
echo "NAMESPACE=${NAMESPACE}"
echo "APP_NAME=${APP_NAME}"
echo "PLATFORM=${PLATFORM}"
echo "BUILDER=${BUILDER}"
echo "TAG=${TAG}"

if ! docker buildx inspect "${BUILDER}" >/dev/null 2>&1; then
  echo "==> Creating buildx builder: ${BUILDER}"
  docker buildx create --name "${BUILDER}" --driver docker-container >/dev/null
fi
docker buildx use "${BUILDER}" >/dev/null
docker buildx inspect --bootstrap >/dev/null

BACKEND_TAGS=(-t "${BACKEND_IMAGE}:${TAG}")
FRONTEND_TAGS=(-t "${FRONTEND_IMAGE}:${TAG}")
if [[ "${PUSH_LATEST}" == "1" ]]; then
  BACKEND_TAGS+=(-t "${BACKEND_IMAGE}:latest")
  FRONTEND_TAGS+=(-t "${FRONTEND_IMAGE}:latest")
fi

echo "==> Building and pushing backend image"
docker buildx build \
  --platform "${PLATFORM}" \
  "${BACKEND_TAGS[@]}" \
  -f backend/Dockerfile backend \
  --push

echo "==> Building and pushing frontend image"
docker buildx build \
  --platform "${PLATFORM}" \
  "${FRONTEND_TAGS[@]}" \
  -f frontend/Dockerfile frontend \
  --push

echo "==> Release complete"
echo "${BACKEND_IMAGE}:${TAG}"
echo "${FRONTEND_IMAGE}:${TAG}"
if [[ "${PUSH_LATEST}" == "1" ]]; then
  echo "${BACKEND_IMAGE}:latest"
  echo "${FRONTEND_IMAGE}:latest"
fi
