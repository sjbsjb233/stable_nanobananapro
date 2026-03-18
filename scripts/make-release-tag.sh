#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 v<version>" >&2
  exit 1
fi

VERSION_PREFIX="$1"
SHORT_HASH="$(git rev-parse --short HEAD)"

printf '%s-%s\n' "${VERSION_PREFIX}" "${SHORT_HASH}"
