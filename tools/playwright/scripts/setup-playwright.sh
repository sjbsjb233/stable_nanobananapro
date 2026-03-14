#!/usr/bin/env bash

set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$TOOL_DIR/.npm-cache}"

cd "$TOOL_DIR"
npm install
PLAYWRIGHT_BROWSERS_PATH="$TOOL_DIR/.playwright-browsers" npx playwright install chromium
