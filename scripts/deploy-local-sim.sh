#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

TAG="${1:-}"

if [[ -n "${TAG}" ]]; then
  ./scripts/build-local-sim-images.sh "${TAG}"
else
  ./scripts/build-local-sim-images.sh
fi

cd srv/stable/compose
docker compose -f docker-compose.prod.yml down --remove-orphans
docker compose -f docker-compose.prod.yml up -d --force-recreate --remove-orphans
docker compose -f docker-compose.prod.yml ps
