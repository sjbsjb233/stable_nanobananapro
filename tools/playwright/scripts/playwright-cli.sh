#!/usr/bin/env bash

set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$TOOL_DIR/.playwright-browsers}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$TOOL_DIR/.cache}"
export PLAYWRIGHT_CLI_HOME="${PLAYWRIGHT_CLI_HOME:-$TOOL_DIR/.playwright-home}"
export PLAYWRIGHT_MCP_SANDBOX="${PLAYWRIGHT_MCP_SANDBOX:-false}"

if [ -z "${PLAYWRIGHT_MCP_EXECUTABLE_PATH:-}" ]; then
  headed_mode=0
  for arg in "$@"; do
    if [ "$arg" = "--headed" ]; then
      headed_mode=1
      break
    fi
  done

  if [ "$headed_mode" -eq 0 ]; then
    for candidate in "$TOOL_DIR"/.playwright-browsers/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell; do
      if [ -x "$candidate" ]; then
        export PLAYWRIGHT_MCP_EXECUTABLE_PATH="$candidate"
        break
      fi
    done
  fi

  for candidate in "$TOOL_DIR"/.playwright-browsers/chromium-*/chrome-mac-arm64/Google\ Chrome\ for\ Testing.app/Contents/MacOS/Google\ Chrome\ for\ Testing; do
    if [ -x "$candidate" ]; then
      if [ -z "${PLAYWRIGHT_MCP_EXECUTABLE_PATH:-}" ]; then
        export PLAYWRIGHT_MCP_EXECUTABLE_PATH="$candidate"
      fi
      break
    fi
  done
fi

if [ ! -x "$TOOL_DIR/node_modules/.bin/playwright-cli" ]; then
  echo "Local Playwright CLI is not installed."
  echo "Run: ./tools/playwright/scripts/setup-playwright.sh"
  exit 1
fi

cd "$TOOL_DIR"
mkdir -p "$PLAYWRIGHT_CLI_HOME"
exec env HOME="$PLAYWRIGHT_CLI_HOME" npm exec playwright-cli -- "$@"
