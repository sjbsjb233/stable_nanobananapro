#!/bin/sh
set -eu

cat >/usr/share/nginx/html/runtime-config.js <<EOF
window.__NBP_RUNTIME_CONFIG__ = {
  apiBaseUrl: "${FRONTEND_DEFAULT_API_BASE_URL:-}",
  turnstileSiteKey: "${FRONTEND_TURNSTILE_SITE_KEY:-}"
};
EOF
