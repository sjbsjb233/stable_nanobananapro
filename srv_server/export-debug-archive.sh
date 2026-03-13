#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${1:-$SCRIPT_DIR}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
ARCHIVE_NAME="${2:-stable_debug_${TIMESTAMP}.7z}"

if ! command -v 7za >/dev/null 2>&1; then
  echo "Error: 7za is not installed or not in PATH." >&2
  exit 1
fi

if [ ! -d "$ROOT_DIR" ]; then
  echo "Error: root directory does not exist: $ROOT_DIR" >&2
  exit 1
fi

ARCHIVE_PATH="$ROOT_DIR/$ARCHIVE_NAME"

if [ -e "$ARCHIVE_PATH" ]; then
  echo "Error: archive already exists: $ARCHIVE_PATH" >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "Creating debug archive: $ARCHIVE_PATH"
echo "Root directory: $ROOT_DIR"
echo "Including hidden files under root and subdirectories"
echo "Excluding job image payloads under data/jobs/*/{input,result,preview}"

7za a -t7z "$ARCHIVE_PATH" \
  . \
  -x"!./$(basename "$ARCHIVE_NAME")" \
  -xr'!data/jobs/*/input' \
  -xr'!data/jobs/*/input/*' \
  -xr'!data/jobs/*/result' \
  -xr'!data/jobs/*/result/*' \
  -xr'!data/jobs/*/preview' \
  -xr'!data/jobs/*/preview/*'

echo "Archive created: $ARCHIVE_PATH"
