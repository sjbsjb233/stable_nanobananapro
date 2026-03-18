#!/usr/bin/env bash

set -euo pipefail

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
WORKFLOW="${2:-ci-full.yml}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI is required." >&2
  exit 1
fi

if [[ "$BRANCH" == "HEAD" ]]; then
  echo "Error: detached HEAD, pass the branch name explicitly." >&2
  exit 1
fi

PREVIOUS_RUN_ID="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"

gh workflow run "$WORKFLOW" --ref "$BRANCH"

RUN_ID=""
for _ in $(seq 1 20); do
  RUN_ID="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  if [[ -n "$RUN_ID" && "$RUN_ID" != "null" && "$RUN_ID" != "$PREVIOUS_RUN_ID" ]]; then
    break
  fi
  sleep 3
done

if [[ -z "$RUN_ID" || "$RUN_ID" == "null" || "$RUN_ID" == "$PREVIOUS_RUN_ID" ]]; then
  echo "Error: failed to resolve the newly triggered workflow run." >&2
  exit 1
fi

echo "Watching run: $RUN_ID"
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log-failed
