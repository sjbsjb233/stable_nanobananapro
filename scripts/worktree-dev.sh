#!/usr/bin/env bash

set -euo pipefail

log() {
  echo "==> $*"
}

die() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

abs_path() {
  python3 - "$1" "$2" <<'PY'
import os
import sys

base = sys.argv[1]
value = sys.argv[2]
if os.path.isabs(value):
    print(os.path.abspath(value))
else:
    print(os.path.abspath(os.path.join(base, value)))
PY
}

hash_files() {
  python3 - "$@" <<'PY'
import hashlib
import pathlib
import sys

hasher = hashlib.sha256()
for raw in sys.argv[1:]:
    path = pathlib.Path(raw)
    hasher.update(str(path).encode("utf-8"))
    hasher.update(b"\0")
    hasher.update(path.read_bytes())
    hasher.update(b"\0")
print(hasher.hexdigest()[:12])
PY
}

json_read() {
  local file_path="$1"
  local expr="$2"
  python3 - "$file_path" "$expr" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
expr = sys.argv[2]
if not path.exists():
    raise SystemExit(0)
data = json.loads(path.read_text())
value = eval(expr, {"__builtins__": {}}, {"data": data})
if value is None:
    raise SystemExit(0)
print(value)
PY
}

load_repo_context() {
  require_command git
  require_command python3
  require_command node
  require_command npm

  WORKTREE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Current directory is not inside a git worktree."
  WORKTREE_ROOT="$(cd "$WORKTREE_ROOT" && pwd -P)"

  local common_git_dir_rel
  common_git_dir_rel="$(git -C "$WORKTREE_ROOT" rev-parse --git-common-dir)"
  COMMON_GIT_DIR="$(abs_path "$WORKTREE_ROOT" "$common_git_dir_rel")"
  if [[ "$(basename "$COMMON_GIT_DIR")" == ".git" ]]; then
    COMMON_REPO_ROOT="$(cd "$COMMON_GIT_DIR/.." && pwd -P)"
  else
    COMMON_REPO_ROOT="$WORKTREE_ROOT"
  fi

  CODEX_DEV_ENV_DIR="$COMMON_REPO_ROOT/.codex-dev-env"
  SHARED_DIR="$CODEX_DEV_ENV_DIR/shared"
  INSTANCES_DIR="$CODEX_DEV_ENV_DIR/instances"
  LOCKS_DIR="$CODEX_DEV_ENV_DIR/locks"

  INSTANCE_HASH="$(python3 - "$WORKTREE_ROOT" <<'PY'
import hashlib
import sys

print(hashlib.sha256(sys.argv[1].encode("utf-8")).hexdigest()[:8])
PY
)"
  INSTANCE_ID="wt_${INSTANCE_HASH}"
  INSTANCE_DIR="$INSTANCES_DIR/$INSTANCE_ID"
  INSTANCE_ENV_FILE="$INSTANCE_DIR/instance.env"
  INSTANCE_JSON_FILE="$INSTANCE_DIR/instance.json"
  INSTANCE_ENV_DIR="$INSTANCE_DIR/env"
  INSTANCE_RUNTIME_DIR="$INSTANCE_DIR/runtime"
  INSTANCE_MIGRATED_DIR="$INSTANCE_RUNTIME_DIR/migrated"

  RUNTIME_BACKEND_DATA_DIR="$INSTANCE_RUNTIME_DIR/backend-data"
  RUNTIME_LOGS_DIR="$INSTANCE_RUNTIME_DIR/logs"
  RUNTIME_PIDS_DIR="$INSTANCE_RUNTIME_DIR/pids"
  RUNTIME_PLAYWRIGHT_HOME_DIR="$INSTANCE_RUNTIME_DIR/playwright-home"
  RUNTIME_PLAYWRIGHT_CLI_DIR="$INSTANCE_RUNTIME_DIR/playwright-cli"
  RUNTIME_PLAYWRIGHT_CACHE_DIR="$INSTANCE_RUNTIME_DIR/playwright-cache"
  RUNTIME_PLAYWRIGHT_OUTPUT_DIR="$INSTANCE_RUNTIME_DIR/playwright-output"
  RUNTIME_PLAYWRIGHT_TEST_RESULTS_DIR="$INSTANCE_RUNTIME_DIR/playwright-test-results"

  BACKEND_ENV_TARGET="$INSTANCE_ENV_DIR/backend.env"
  FRONTEND_ENV_TARGET="$INSTANCE_ENV_DIR/frontend.env"
  BACKEND_ENV_LINK="$WORKTREE_ROOT/backend/.env"
  FRONTEND_ENV_LINK="$WORKTREE_ROOT/frontend/.env"

  BACKEND_DATA_LINK="$WORKTREE_ROOT/backend/data"
  BACKEND_VENV_LINK="$WORKTREE_ROOT/backend/.venv"
  FRONTEND_NODE_MODULES_LINK="$WORKTREE_ROOT/frontend/node_modules"
  PLAYWRIGHT_NODE_MODULES_LINK="$WORKTREE_ROOT/tools/playwright/node_modules"
  PLAYWRIGHT_BROWSERS_LINK="$WORKTREE_ROOT/tools/playwright/.playwright-browsers"
  PLAYWRIGHT_HOME_LINK="$WORKTREE_ROOT/tools/playwright/.playwright-home"
  PLAYWRIGHT_CLI_LINK="$WORKTREE_ROOT/tools/playwright/.playwright-cli"
  PLAYWRIGHT_CACHE_LINK="$WORKTREE_ROOT/tools/playwright/.cache"
  PLAYWRIGHT_OUTPUT_LINK="$WORKTREE_ROOT/tools/playwright/output"
  PLAYWRIGHT_TEST_RESULTS_LINK="$WORKTREE_ROOT/tools/playwright/test-results"

  SHARED_PIP_CACHE_DIR="$SHARED_DIR/pip-cache"
  SHARED_NPM_CACHE_DIR="$SHARED_DIR/npm-cache"
  SHARED_PLAYWRIGHT_BROWSERS_DIR="$SHARED_DIR/playwright-browsers"

  PYTHON_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")')"
  NODE_VERSION="$(node -p 'process.version.slice(1)')"

  PYTHON_REQUIREMENTS_HASH="$(hash_files "$WORKTREE_ROOT/backend/requirements.txt" "$WORKTREE_ROOT/backend/requirements.runtime.txt")"
  FRONTEND_LOCK_HASH="$(hash_files "$WORKTREE_ROOT/frontend/package-lock.json")"
  PLAYWRIGHT_LOCK_HASH="$(hash_files "$WORKTREE_ROOT/tools/playwright/package-lock.json")"

  PYTHON_ENV_KEY="${PYTHON_VERSION}-${PYTHON_REQUIREMENTS_HASH}"
  FRONTEND_DEPS_KEY="${NODE_VERSION}-${FRONTEND_LOCK_HASH}"
  PLAYWRIGHT_DEPS_KEY="${NODE_VERSION}-${PLAYWRIGHT_LOCK_HASH}"

  SHARED_PYTHON_ENV_DIR="$SHARED_DIR/python-envs/$PYTHON_ENV_KEY"
  SHARED_FRONTEND_DEPS_ROOT="$SHARED_DIR/frontend-deps/$FRONTEND_DEPS_KEY"
  SHARED_FRONTEND_DEPS_DIR="$SHARED_FRONTEND_DEPS_ROOT/node_modules"
  SHARED_PLAYWRIGHT_DEPS_ROOT="$SHARED_DIR/playwright-deps/$PLAYWRIGHT_DEPS_KEY"
  SHARED_PLAYWRIGHT_DEPS_DIR="$SHARED_PLAYWRIGHT_DEPS_ROOT/node_modules"

  BACKEND_PID_FILE="$RUNTIME_PIDS_DIR/backend.pid"
  FRONTEND_PID_FILE="$RUNTIME_PIDS_DIR/frontend.pid"
  BACKEND_LOG_FILE="$RUNTIME_LOGS_DIR/backend.log"
  FRONTEND_LOG_FILE="$RUNTIME_LOGS_DIR/frontend.log"
  BACKEND_APP_LOG_DIR="$RUNTIME_LOGS_DIR/backend"
}

LOCK_PATHS=()

acquire_lock() {
  local name="$1"
  local lock_path="$LOCKS_DIR/${name}.lock"
  mkdir -p "$LOCKS_DIR"
  while ! mkdir "$lock_path" 2>/dev/null; do
    sleep 0.1
  done
  LOCK_PATHS+=("$lock_path")
}

release_locks() {
  local idx
  for (( idx=${#LOCK_PATHS[@]}-1; idx>=0; idx-- )); do
    rmdir "${LOCK_PATHS[idx]}" 2>/dev/null || true
  done
}

trap release_locks EXIT

port_available() {
  python3 - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(0.2)
try:
    if sock.connect_ex(("127.0.0.1", port)) == 0:
        raise SystemExit(1)
finally:
    sock.close()
PY
}

wait_for_port_busy() {
  local port="$1"
  local label="$2"
  local attempt
  for attempt in $(seq 1 60); do
    if ! port_available "$port"; then
      return 0
    fi
    sleep 0.2
  done
  die "${label} did not start listening on port ${port}."
}

wait_for_port_free() {
  local port="$1"
  local label="$2"
  local attempt
  for attempt in $(seq 1 40); do
    if port_available "$port"; then
      return 0
    fi
    sleep 0.2
  done
  die "${label} did not stop listening on port ${port}."
}

service_pid_file() {
  case "$1" in
    backend) echo "$BACKEND_PID_FILE" ;;
    frontend) echo "$FRONTEND_PID_FILE" ;;
    *) die "Unknown service: $1" ;;
  esac
}

service_pid() {
  local pid_file port
  pid_file="$(service_pid_file "$1")"
  if [[ -f "$pid_file" ]]; then
    tr -d '[:space:]' <"$pid_file"
    return 0
  fi
  port="$(service_port "$1")"
  pid_for_port "$port"
}

service_port() {
  case "$1" in
    backend) echo "$NBP_BACKEND_PORT" ;;
    frontend) echo "$NBP_FRONTEND_PORT" ;;
    *) die "Unknown service: $1" ;;
  esac
}

pid_for_port() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1
}

service_running() {
  local port
  port="$(service_port "$1")"
  ! port_available "$port"
}

cleanup_stale_pid() {
  local pid_file port
  pid_file="$(service_pid_file "$1")"
  port="$(service_port "$1")"
  if [[ -f "$pid_file" ]] && port_available "$port"; then
    rm -f "$pid_file"
  fi
}

backend_port_for_slot() {
  echo $((18000 + $1 * 10))
}

frontend_port_for_slot() {
  echo $((18001 + $1 * 10))
}

collect_reserved_slots() {
  python3 - "$INSTANCES_DIR" "$INSTANCE_ID" "$WORKTREE_ROOT" <<'PY'
import json
import sys
from pathlib import Path

instances_dir = Path(sys.argv[1])
current_id = sys.argv[2]
current_root = Path(sys.argv[3]).resolve()
reserved = set()

if instances_dir.exists():
    for instance_json in instances_dir.glob("*/instance.json"):
        try:
            data = json.loads(instance_json.read_text())
        except Exception:
            continue
        instance_id = data.get("instance_id") or instance_json.parent.name
        if instance_id == current_id:
            continue
        slot = data.get("slot")
        worktree_path = data.get("worktree_path")
        if not isinstance(slot, int) or not isinstance(worktree_path, str):
            continue
        if Path(worktree_path).exists():
            reserved.add(slot)

for slot in sorted(reserved):
    print(slot)
PY
}

RESERVED_SLOTS=""

load_reserved_slots() {
  RESERVED_SLOTS="$(collect_reserved_slots || true)"
}

slot_reserved() {
  [[ -n "$RESERVED_SLOTS" ]] && printf '%s\n' "$RESERVED_SLOTS" | grep -Fxq "$1"
}

existing_slot() {
  if [[ -f "$INSTANCE_JSON_FILE" ]]; then
    python3 - "$INSTANCE_JSON_FILE" "$WORKTREE_ROOT" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
root = Path(sys.argv[2]).resolve()
data = json.loads(path.read_text())
if Path(data.get("worktree_path", "")).resolve() == root:
    slot = data.get("slot")
    if isinstance(slot, int):
        print(slot)
PY
  fi
}

slot_is_usable() {
  local slot="$1"
  local backend_port frontend_port
  backend_port="$(backend_port_for_slot "$slot")"
  frontend_port="$(frontend_port_for_slot "$slot")"

  if slot_reserved "$slot"; then
    return 1
  fi

  if [[ -n "${CURRENT_SLOT:-}" && "$slot" == "$CURRENT_SLOT" ]] && { ! port_available "$backend_port" || ! port_available "$frontend_port"; }; then
    return 0
  fi

  port_available "$backend_port" && port_available "$frontend_port"
}

choose_slot() {
  acquire_lock "slots"
  load_reserved_slots

  CURRENT_SLOT="$(existing_slot || true)"
  local slot="${CURRENT_SLOT:-0}"
  if [[ -n "${CURRENT_SLOT:-}" ]] && slot_is_usable "$CURRENT_SLOT"; then
    SLOT="$CURRENT_SLOT"
  else
    slot=0
    while true; do
      if slot_is_usable "$slot"; then
        SLOT="$slot"
        break
      fi
      slot=$((slot + 1))
    done
  fi

  NBP_BACKEND_PORT="$(backend_port_for_slot "$SLOT")"
  NBP_FRONTEND_PORT="$(frontend_port_for_slot "$SLOT")"
  NBP_BACKEND_URL="http://127.0.0.1:${NBP_BACKEND_PORT}"
  NBP_FRONTEND_URL="http://127.0.0.1:${NBP_FRONTEND_PORT}"
}

ensure_dir() {
  mkdir -p "$1"
}

normalize_node_modules_layout() {
  local root_dir="$1"
  local node_modules_dir="$2"
  python3 - "$root_dir" "$node_modules_dir" <<'PY'
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1])
target = Path(sys.argv[2])
root.mkdir(parents=True, exist_ok=True)
if target.exists():
    raise SystemExit(0)

target.mkdir(parents=True, exist_ok=True)
for item in list(root.iterdir()):
    if item == target:
        continue
    shutil.move(str(item), target / item.name)
PY
}

root_has_flat_node_modules() {
  local root_dir="$1"
  [[ -n "$(find "$root_dir" -mindepth 1 -maxdepth 1 ! -name 'node_modules' -print -quit 2>/dev/null)" ]]
}

path_is_empty() {
  local target_path="$1"
  if [[ -d "$target_path" ]]; then
    [[ -z "$(find "$target_path" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
  elif [[ -f "$target_path" ]]; then
    [[ ! -s "$target_path" ]]
  else
    return 1
  fi
}

backup_path() {
  local original_path="$1"
  local name
  name="$(python3 - "$WORKTREE_ROOT" "$original_path" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
try:
    rel = target.relative_to(root)
except ValueError:
    rel = target.name
print(str(rel).replace("/", "__"))
PY
)"
  local backup_path="$INSTANCE_MIGRATED_DIR/${name}.$(date +%Y%m%d%H%M%S)"
  ensure_dir "$INSTANCE_MIGRATED_DIR"
  mv "$original_path" "$backup_path"
  log "Moved existing path to backup: $backup_path"
}

symlink_points_to() {
  python3 - "$1" "$2" <<'PY'
import os
import sys
from pathlib import Path

link = Path(sys.argv[1])
target = Path(sys.argv[2]).resolve()
if not link.is_symlink():
    raise SystemExit(1)
resolved = Path(os.path.realpath(link)).resolve()
if resolved == target:
    raise SystemExit(0)
raise SystemExit(1)
PY
}

ensure_symlink() {
  local link_path="$1"
  local target_path="$2"
  local kind="${3:-dir}"

  ensure_dir "$(dirname "$link_path")"
  ensure_dir "$(dirname "$target_path")"

  if [[ -L "$link_path" ]]; then
    if symlink_points_to "$link_path" "$target_path"; then
      return 0
    fi
    rm -f "$link_path"
  fi

  if [[ -e "$link_path" ]]; then
    if [[ ! -e "$target_path" ]]; then
      mv "$link_path" "$target_path"
      log "Migrated $(basename "$link_path") into $target_path"
    elif path_is_empty "$target_path"; then
      rm -rf "$target_path"
      mv "$link_path" "$target_path"
      log "Migrated $(basename "$link_path") into $target_path"
    else
      backup_path "$link_path"
    fi
  fi

  if [[ "$kind" == "dir" ]]; then
    ensure_dir "$target_path"
  elif [[ ! -e "$target_path" ]]; then
    : >"$target_path"
  fi

  ln -s "$target_path" "$link_path"
}

prepare_env_file() {
  local link_path="$1"
  local target_path="$2"
  local example_path="$3"

  ensure_dir "$(dirname "$target_path")"
  if [[ ! -e "$target_path" ]]; then
    if [[ -e "$link_path" && ! -L "$link_path" ]]; then
      mv "$link_path" "$target_path"
      log "Migrated $(basename "$link_path") into $target_path"
    elif [[ -f "$example_path" ]]; then
      cp "$example_path" "$target_path"
    else
      : >"$target_path"
    fi
  fi

  if [[ -L "$link_path" ]]; then
    if symlink_points_to "$link_path" "$target_path"; then
      return 0
    fi
    rm -f "$link_path"
  elif [[ -e "$link_path" ]]; then
    backup_path "$link_path"
  fi

  ln -s "$target_path" "$link_path"
}

dotenv_quote() {
  python3 - "$1" <<'PY'
import sys

value = sys.argv[1]
escaped = value.replace("\\", "\\\\").replace('"', '\\"')
print(f'"{escaped}"')
PY
}

upsert_env_value() {
  local file_path="$1"
  local key="$2"
  local value="$3"
  python3 - "$file_path" "$key" "$value" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
quoted = '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
line = f"{key}={quoted}"

lines = path.read_text().splitlines() if path.exists() else []
updated = []
found = False
for raw in lines:
    stripped = raw.lstrip()
    if stripped and not stripped.startswith("#") and "=" in stripped:
        current_key = stripped.split("=", 1)[0].strip()
        if current_key == key:
            updated.append(line)
            found = True
            continue
    updated.append(raw)

if not found:
    if updated and updated[-1] != "":
        updated.append("")
    updated.append(line)

path.write_text("\n".join(updated) + "\n")
PY
}

remove_env_key() {
  local file_path="$1"
  local key="$2"
  python3 - "$file_path" "$key" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
if not path.exists():
    raise SystemExit(0)

updated = []
for raw in path.read_text().splitlines():
    stripped = raw.lstrip()
    if stripped and not stripped.startswith("#") and "=" in stripped:
      current_key = stripped.split("=", 1)[0].strip()
      if current_key == key:
        continue
    updated.append(raw)

path.write_text("\n".join(updated).rstrip() + "\n")
PY
}

prepare_instance_files() {
  ensure_dir "$SHARED_DIR/python-envs"
  ensure_dir "$SHARED_DIR/frontend-deps"
  ensure_dir "$SHARED_DIR/playwright-deps"
  ensure_dir "$SHARED_PIP_CACHE_DIR"
  ensure_dir "$SHARED_NPM_CACHE_DIR"
  ensure_dir "$SHARED_PLAYWRIGHT_BROWSERS_DIR"
  ensure_dir "$INSTANCE_ENV_DIR"
  ensure_dir "$RUNTIME_BACKEND_DATA_DIR"
  ensure_dir "$RUNTIME_LOGS_DIR"
  ensure_dir "$RUNTIME_PIDS_DIR"
  ensure_dir "$RUNTIME_PLAYWRIGHT_HOME_DIR"
  ensure_dir "$RUNTIME_PLAYWRIGHT_CLI_DIR"
  ensure_dir "$RUNTIME_PLAYWRIGHT_CACHE_DIR"
  ensure_dir "$RUNTIME_PLAYWRIGHT_OUTPUT_DIR"
  ensure_dir "$RUNTIME_PLAYWRIGHT_TEST_RESULTS_DIR"
  ensure_dir "$BACKEND_APP_LOG_DIR"

  prepare_env_file "$BACKEND_ENV_LINK" "$BACKEND_ENV_TARGET" "$WORKTREE_ROOT/backend/.env.example"
  prepare_env_file "$FRONTEND_ENV_LINK" "$FRONTEND_ENV_TARGET" "$WORKTREE_ROOT/frontend/.env.example"

  remove_env_key "$BACKEND_ENV_TARGET" "GOOGLE_REPORTED_SPEND_USD"
  remove_env_key "$BACKEND_ENV_TARGET" "GOOGLE_REPORTED_REMAINING_USD"
  upsert_env_value "$BACKEND_ENV_TARGET" "DATA_DIR" "$RUNTIME_BACKEND_DATA_DIR"
  upsert_env_value "$BACKEND_ENV_TARGET" "LOG_DIR" "$BACKEND_APP_LOG_DIR"
  upsert_env_value "$BACKEND_ENV_TARGET" "CORS_ALLOW_ORIGINS" "${NBP_FRONTEND_URL},http://localhost:${NBP_FRONTEND_PORT}"

  upsert_env_value "$FRONTEND_ENV_TARGET" "VITE_API_BASE_URL" "$NBP_BACKEND_URL"
}

python_env_matches() {
  local env_dir="$1"
  [[ -x "$env_dir/bin/python" ]] || return 1
  local env_version
  env_version="$("$env_dir/bin/python" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")' 2>/dev/null || true)"
  [[ "$env_version" == "$PYTHON_VERSION" ]]
}

ensure_python_env() {
  acquire_lock "python-${PYTHON_ENV_KEY}"
  if [[ ! -d "$SHARED_PYTHON_ENV_DIR" ]]; then
    if [[ -d "$BACKEND_VENV_LINK" && ! -L "$BACKEND_VENV_LINK" ]] && python_env_matches "$BACKEND_VENV_LINK"; then
      mv "$BACKEND_VENV_LINK" "$SHARED_PYTHON_ENV_DIR"
      log "Reused existing backend virtualenv for $PYTHON_ENV_KEY"
    else
      python3 -m venv "$SHARED_PYTHON_ENV_DIR"
    fi
  fi

  ensure_symlink "$BACKEND_VENV_LINK" "$SHARED_PYTHON_ENV_DIR" "dir"

  if [[ ! -x "$SHARED_PYTHON_ENV_DIR/bin/pytest" ]]; then
    log "Installing backend Python dependencies into $SHARED_PYTHON_ENV_DIR"
    PIP_CACHE_DIR="$SHARED_PIP_CACHE_DIR" \
      "$SHARED_PYTHON_ENV_DIR/bin/pip" install --disable-pip-version-check -r "$WORKTREE_ROOT/backend/requirements.txt"
  fi
}

frontend_deps_ready() {
  [[ -x "$SHARED_FRONTEND_DEPS_DIR/.bin/vite" ]] && [[ -f "$SHARED_FRONTEND_DEPS_DIR/esbuild/package.json" ]]
}

ensure_frontend_deps() {
  acquire_lock "frontend-${FRONTEND_DEPS_KEY}"
  ensure_dir "$SHARED_FRONTEND_DEPS_ROOT"

  if [[ ! -d "$SHARED_FRONTEND_DEPS_DIR" ]]; then
    if root_has_flat_node_modules "$SHARED_FRONTEND_DEPS_ROOT"; then
      normalize_node_modules_layout "$SHARED_FRONTEND_DEPS_ROOT" "$SHARED_FRONTEND_DEPS_DIR"
    elif [[ -d "$FRONTEND_NODE_MODULES_LINK" && ! -L "$FRONTEND_NODE_MODULES_LINK" ]]; then
      mv "$FRONTEND_NODE_MODULES_LINK" "$SHARED_FRONTEND_DEPS_DIR"
      log "Reused existing frontend node_modules for $FRONTEND_DEPS_KEY"
    else
      ensure_dir "$SHARED_FRONTEND_DEPS_DIR"
    fi
  fi

  ensure_symlink "$FRONTEND_NODE_MODULES_LINK" "$SHARED_FRONTEND_DEPS_DIR" "dir"

  if ! frontend_deps_ready; then
    log "Installing frontend dependencies into $SHARED_FRONTEND_DEPS_DIR"
    (
      cd "$WORKTREE_ROOT/frontend"
      NPM_CONFIG_CACHE="$SHARED_NPM_CACHE_DIR" npm ci --no-audit --no-fund
    )
  fi
}

playwright_deps_ready() {
  [[ -x "$SHARED_PLAYWRIGHT_DEPS_DIR/.bin/playwright" ]] && [[ -f "$SHARED_PLAYWRIGHT_DEPS_DIR/playwright/package.json" ]]
}

ensure_playwright_deps() {
  acquire_lock "playwright-${PLAYWRIGHT_DEPS_KEY}"
  ensure_dir "$SHARED_PLAYWRIGHT_DEPS_ROOT"

  if [[ ! -d "$SHARED_PLAYWRIGHT_DEPS_DIR" ]]; then
    if root_has_flat_node_modules "$SHARED_PLAYWRIGHT_DEPS_ROOT"; then
      normalize_node_modules_layout "$SHARED_PLAYWRIGHT_DEPS_ROOT" "$SHARED_PLAYWRIGHT_DEPS_DIR"
    elif [[ -d "$PLAYWRIGHT_NODE_MODULES_LINK" && ! -L "$PLAYWRIGHT_NODE_MODULES_LINK" ]]; then
      mv "$PLAYWRIGHT_NODE_MODULES_LINK" "$SHARED_PLAYWRIGHT_DEPS_DIR"
      log "Reused existing Playwright node_modules for $PLAYWRIGHT_DEPS_KEY"
    else
      ensure_dir "$SHARED_PLAYWRIGHT_DEPS_DIR"
    fi
  fi

  if [[ -d "$PLAYWRIGHT_BROWSERS_LINK" && ! -L "$PLAYWRIGHT_BROWSERS_LINK" ]] && [[ -z "$(find "$SHARED_PLAYWRIGHT_BROWSERS_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    rm -rf "$SHARED_PLAYWRIGHT_BROWSERS_DIR"
    mv "$PLAYWRIGHT_BROWSERS_LINK" "$SHARED_PLAYWRIGHT_BROWSERS_DIR"
    log "Reused existing Playwright browsers cache"
  fi

  ensure_symlink "$PLAYWRIGHT_NODE_MODULES_LINK" "$SHARED_PLAYWRIGHT_DEPS_DIR" "dir"
  ensure_symlink "$PLAYWRIGHT_BROWSERS_LINK" "$SHARED_PLAYWRIGHT_BROWSERS_DIR" "dir"

  if ! playwright_deps_ready; then
    log "Installing Playwright dependencies into $SHARED_PLAYWRIGHT_DEPS_DIR"
    (
      cd "$WORKTREE_ROOT/tools/playwright"
      NPM_CONFIG_CACHE="$SHARED_NPM_CACHE_DIR" npm ci --no-audit --no-fund
    )
  fi

  if [[ -z "$(find "$SHARED_PLAYWRIGHT_BROWSERS_DIR" -maxdepth 1 \( -name 'chromium-*' -o -name 'chromium_headless_shell-*' \) -print -quit 2>/dev/null)" ]]; then
    log "Installing Playwright Chromium into $SHARED_PLAYWRIGHT_BROWSERS_DIR"
    (
      cd "$WORKTREE_ROOT/tools/playwright"
      NPM_CONFIG_CACHE="$SHARED_NPM_CACHE_DIR" \
      PLAYWRIGHT_BROWSERS_PATH="$SHARED_PLAYWRIGHT_BROWSERS_DIR" \
        npx playwright install chromium
    )
  fi
}

ensure_runtime_links() {
  ensure_symlink "$BACKEND_DATA_LINK" "$RUNTIME_BACKEND_DATA_DIR" "dir"
  ensure_symlink "$PLAYWRIGHT_HOME_LINK" "$RUNTIME_PLAYWRIGHT_HOME_DIR" "dir"
  ensure_symlink "$PLAYWRIGHT_CLI_LINK" "$RUNTIME_PLAYWRIGHT_CLI_DIR" "dir"
  ensure_symlink "$PLAYWRIGHT_CACHE_LINK" "$RUNTIME_PLAYWRIGHT_CACHE_DIR" "dir"
  ensure_symlink "$PLAYWRIGHT_OUTPUT_LINK" "$RUNTIME_PLAYWRIGHT_OUTPUT_DIR" "dir"
  ensure_symlink "$PLAYWRIGHT_TEST_RESULTS_LINK" "$RUNTIME_PLAYWRIGHT_TEST_RESULTS_DIR" "dir"
}

write_instance_env() {
  local vars=(
    "NBP_INSTANCE_ID=$INSTANCE_ID"
    "NBP_WORKTREE_PATH=$WORKTREE_ROOT"
    "NBP_COMMON_REPO_ROOT=$COMMON_REPO_ROOT"
    "NBP_SLOT=$SLOT"
    "NBP_BACKEND_PORT=$NBP_BACKEND_PORT"
    "NBP_FRONTEND_PORT=$NBP_FRONTEND_PORT"
    "NBP_BACKEND_URL=$NBP_BACKEND_URL"
    "NBP_FRONTEND_URL=$NBP_FRONTEND_URL"
    "NBP_BACKEND_DATA_DIR=$RUNTIME_BACKEND_DATA_DIR"
    "NBP_INSTANCE_DIR=$INSTANCE_DIR"
    "NBP_INSTANCE_ENV=$INSTANCE_ENV_FILE"
    "NBP_INSTANCE_JSON=$INSTANCE_JSON_FILE"
    "NBP_LOGS_DIR=$RUNTIME_LOGS_DIR"
    "NBP_PIDS_DIR=$RUNTIME_PIDS_DIR"
    "NBP_BACKEND_LOG_FILE=$BACKEND_LOG_FILE"
    "NBP_FRONTEND_LOG_FILE=$FRONTEND_LOG_FILE"
    "NBP_PYTHON_ENV_KEY=$PYTHON_ENV_KEY"
    "NBP_FRONTEND_DEPS_KEY=$FRONTEND_DEPS_KEY"
    "NBP_PLAYWRIGHT_DEPS_KEY=$PLAYWRIGHT_DEPS_KEY"
    "PIP_CACHE_DIR=$SHARED_PIP_CACHE_DIR"
    "NPM_CONFIG_CACHE=$SHARED_NPM_CACHE_DIR"
    "PLAYWRIGHT_BROWSERS_PATH=$SHARED_PLAYWRIGHT_BROWSERS_DIR"
    "PLAYWRIGHT_CLI_HOME=$RUNTIME_PLAYWRIGHT_HOME_DIR"
    "XDG_CACHE_HOME=$RUNTIME_PLAYWRIGHT_CACHE_DIR"
    "NBP_PLAYWRIGHT_CLI_DIR=$RUNTIME_PLAYWRIGHT_CLI_DIR"
    "NBP_PLAYWRIGHT_OUTPUT_DIR=$RUNTIME_PLAYWRIGHT_OUTPUT_DIR"
    "NBP_PLAYWRIGHT_TEST_RESULTS_DIR=$RUNTIME_PLAYWRIGHT_TEST_RESULTS_DIR"
  )

  : >"$INSTANCE_ENV_FILE"
  local item key value
  for item in "${vars[@]}"; do
    key="${item%%=*}"
    value="${item#*=}"
    printf 'export %s=%q\n' "$key" "$value" >>"$INSTANCE_ENV_FILE"
  done
}

write_instance_json() {
  INSTANCE_ID="$INSTANCE_ID" \
  WORKTREE_ROOT="$WORKTREE_ROOT" \
  COMMON_REPO_ROOT="$COMMON_REPO_ROOT" \
  SLOT="$SLOT" \
  BACKEND_PORT="$NBP_BACKEND_PORT" \
  FRONTEND_PORT="$NBP_FRONTEND_PORT" \
  BACKEND_URL="$NBP_BACKEND_URL" \
  FRONTEND_URL="$NBP_FRONTEND_URL" \
  BACKEND_ENV_TARGET="$BACKEND_ENV_TARGET" \
  FRONTEND_ENV_TARGET="$FRONTEND_ENV_TARGET" \
  RUNTIME_BACKEND_DATA_DIR="$RUNTIME_BACKEND_DATA_DIR" \
  RUNTIME_LOGS_DIR="$RUNTIME_LOGS_DIR" \
  PYTHON_ENV_KEY="$PYTHON_ENV_KEY" \
  FRONTEND_DEPS_KEY="$FRONTEND_DEPS_KEY" \
  PLAYWRIGHT_DEPS_KEY="$PLAYWRIGHT_DEPS_KEY" \
  INSTANCE_JSON_FILE="$INSTANCE_JSON_FILE" \
    python3 <<'PY'
import json
import os
from pathlib import Path

payload = {
    "instance_id": os.environ["INSTANCE_ID"],
    "worktree_path": os.environ["WORKTREE_ROOT"],
    "common_repo_root": os.environ["COMMON_REPO_ROOT"],
    "slot": int(os.environ["SLOT"]),
    "ports": {
        "backend": int(os.environ["BACKEND_PORT"]),
        "frontend": int(os.environ["FRONTEND_PORT"]),
    },
    "urls": {
        "backend": os.environ["BACKEND_URL"],
        "frontend": os.environ["FRONTEND_URL"],
    },
    "paths": {
        "backend_env": os.environ["BACKEND_ENV_TARGET"],
        "frontend_env": os.environ["FRONTEND_ENV_TARGET"],
        "backend_data": os.environ["RUNTIME_BACKEND_DATA_DIR"],
        "logs": os.environ["RUNTIME_LOGS_DIR"],
    },
    "deps": {
        "python_key": os.environ["PYTHON_ENV_KEY"],
        "frontend_key": os.environ["FRONTEND_DEPS_KEY"],
        "playwright_key": os.environ["PLAYWRIGHT_DEPS_KEY"],
    },
}

path = Path(os.environ["INSTANCE_JSON_FILE"])
path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n")
PY
}

bootstrap() {
  load_repo_context
  choose_slot
  cleanup_stale_pid backend
  cleanup_stale_pid frontend
  prepare_instance_files
  ensure_python_env
  ensure_frontend_deps
  ensure_playwright_deps
  ensure_runtime_links
  write_instance_env
  write_instance_json

  cat <<EOF
instance_id: $INSTANCE_ID
worktree_path: $WORKTREE_ROOT
slot: $SLOT
backend_url: $NBP_BACKEND_URL
frontend_url: $NBP_FRONTEND_URL
instance_env: $INSTANCE_ENV_FILE
instance_json: $INSTANCE_JSON_FILE
EOF
}

source_instance_env() {
  [[ -f "$INSTANCE_ENV_FILE" ]] || die "Missing $INSTANCE_ENV_FILE. Run bootstrap first."
  # shellcheck disable=SC1090
  source "$INSTANCE_ENV_FILE"
}

ensure_bootstrap() {
  load_repo_context
  if [[ ! -f "$INSTANCE_ENV_FILE" || ! -f "$INSTANCE_JSON_FILE" ]]; then
    bootstrap >/dev/null
    load_repo_context
  fi
}

spawn_detached_process() {
  local cwd="$1"
  local log_file="$2"
  local pid_file="$3"
  shift 3

  python3 - "$cwd" "$log_file" "$pid_file" "$@" <<'PY'
import os
import subprocess
import sys
from pathlib import Path

cwd = sys.argv[1]
log_file = sys.argv[2]
pid_file = sys.argv[3]
raw = sys.argv[4:]

separator = raw.index("--")
env_pairs = raw[:separator]
command = raw[separator + 1:]
env = os.environ.copy()
for item in env_pairs:
    key, value = item.split("=", 1)
    env[key] = value

Path(log_file).parent.mkdir(parents=True, exist_ok=True)
with open(log_file, "ab", buffering=0) as handle:
    proc = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

Path(pid_file).write_text(f"{proc.pid}\n")
PY
}

start_backend() {
  ensure_bootstrap
  source_instance_env
  cleanup_stale_pid backend
  if service_running backend; then
    log "Backend already running on ${NBP_BACKEND_URL} (pid $(service_pid backend))"
    return 0
  fi

  ensure_dir "$RUNTIME_LOGS_DIR"
  ensure_dir "$RUNTIME_PIDS_DIR"
  spawn_detached_process \
    "$WORKTREE_ROOT/backend" \
    "$BACKEND_LOG_FILE" \
    "$BACKEND_PID_FILE" \
    "PYTHONUNBUFFERED=1" \
    "PIP_CACHE_DIR=$PIP_CACHE_DIR" \
    -- \
    "$WORKTREE_ROOT/backend/.venv/bin/uvicorn" \
    "app.main:app" \
    "--host" \
    "127.0.0.1" \
    "--port" \
    "$NBP_BACKEND_PORT"
  wait_for_port_busy "$NBP_BACKEND_PORT" "backend"
  log "Backend started on ${NBP_BACKEND_URL}"
}

start_frontend() {
  ensure_bootstrap
  source_instance_env
  cleanup_stale_pid frontend
  if service_running frontend; then
    log "Frontend already running on ${NBP_FRONTEND_URL} (pid $(service_pid frontend))"
    return 0
  fi

  ensure_dir "$RUNTIME_LOGS_DIR"
  ensure_dir "$RUNTIME_PIDS_DIR"
  spawn_detached_process \
    "$WORKTREE_ROOT/frontend" \
    "$FRONTEND_LOG_FILE" \
    "$FRONTEND_PID_FILE" \
    "BROWSER=none" \
    "NPM_CONFIG_CACHE=$NPM_CONFIG_CACHE" \
    "NBP_FRONTEND_PORT=$NBP_FRONTEND_PORT" \
    -- \
    "$WORKTREE_ROOT/frontend/node_modules/.bin/vite" \
    "--host" \
    "127.0.0.1"
  wait_for_port_busy "$NBP_FRONTEND_PORT" "frontend"
  log "Frontend started on ${NBP_FRONTEND_URL}"
}

stop_service() {
  local name="$1"
  local pid_file pid port

  cleanup_stale_pid "$name"
  pid_file="$(service_pid_file "$name")"
  port="$(service_port "$name")"
  pid="$(service_pid "$name")"

  if [[ -z "$pid" ]] && port_available "$port"; then
    return 0
  fi

  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
    die "Unable to resolve pid for $name on port $port."
  fi

  if ! kill "$pid" 2>/dev/null; then
    if ! port_available "$port"; then
      die "Failed to stop $name (pid $pid)."
    fi
  else
    sleep 0.5
    if ! port_available "$port"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  wait_for_port_free "$port" "$name"
  rm -f "$pid_file"
  log "Stopped $name"
}

status() {
  ensure_bootstrap
  source_instance_env
  cleanup_stale_pid backend
  cleanup_stale_pid frontend

  cat <<EOF
worktree_path: $WORKTREE_ROOT
instance_id: $NBP_INSTANCE_ID
slot: $NBP_SLOT
backend_url: $NBP_BACKEND_URL
frontend_url: $NBP_FRONTEND_URL
backend_pid: $(service_pid backend || true)
frontend_pid: $(service_pid frontend || true)
backend_running: $(service_running backend && echo yes || echo no)
frontend_running: $(service_running frontend && echo yes || echo no)
backend_log: $NBP_BACKEND_LOG_FILE
frontend_log: $NBP_FRONTEND_LOG_FILE
instance_env: $NBP_INSTANCE_ENV
instance_json: $NBP_INSTANCE_JSON
python_key: $NBP_PYTHON_ENV_KEY
frontend_key: $NBP_FRONTEND_DEPS_KEY
playwright_key: $NBP_PLAYWRIGHT_DEPS_KEY
EOF
}

run_backend_tests() {
  ensure_bootstrap
  source_instance_env
  (
    cd "$WORKTREE_ROOT/backend"
    "$WORKTREE_ROOT/backend/.venv/bin/pytest" -q "$@"
  )
}

run_e2e_tests() {
  ensure_bootstrap
  source_instance_env

  if [[ -z "$(find "$WORKTREE_ROOT/tools/playwright/tests/e2e" -type f ! -name '.gitkeep' -print -quit 2>/dev/null)" ]]; then
    log "No Playwright e2e specs found under tools/playwright/tests/e2e"
    return 0
  fi

  if port_available "$NBP_BACKEND_PORT" || port_available "$NBP_FRONTEND_PORT"; then
    die "Frontend or backend is not running for this instance. Run: ./scripts/worktree-dev.sh up all"
  fi

  (
    cd "$WORKTREE_ROOT/tools/playwright"
    PW_BASE_URL="$NBP_FRONTEND_URL" \
    NPM_CONFIG_CACHE="$NPM_CONFIG_CACHE" \
    PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
      npm run test:e2e -- "$@"
  )
}

shellenv() {
  ensure_bootstrap
  cat "$INSTANCE_ENV_FILE"
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/worktree-dev.sh bootstrap
  ./scripts/worktree-dev.sh up backend
  ./scripts/worktree-dev.sh up frontend
  ./scripts/worktree-dev.sh up all
  ./scripts/worktree-dev.sh down
  ./scripts/worktree-dev.sh status
  ./scripts/worktree-dev.sh test backend [pytest args...]
  ./scripts/worktree-dev.sh test e2e [playwright args...]
  ./scripts/worktree-dev.sh shellenv
EOF
}

main() {
  local command="${1:-}"
  case "$command" in
    bootstrap)
      bootstrap
      ;;
    up)
      case "${2:-}" in
        backend) start_backend ;;
        frontend) start_frontend ;;
        all)
          start_backend
          start_frontend
          ;;
        *)
          usage
          exit 1
          ;;
      esac
      ;;
    down)
      ensure_bootstrap
      source_instance_env
      stop_service frontend
      stop_service backend
      ;;
    status)
      status
      ;;
    test)
      case "${2:-}" in
        backend)
          shift 2 || true
          run_backend_tests "$@"
          ;;
        e2e)
          shift 2 || true
          run_e2e_tests "$@"
          ;;
        *)
          usage
          exit 1
          ;;
      esac
      ;;
    shellenv)
      shellenv
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
