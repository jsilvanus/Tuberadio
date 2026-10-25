#!/usr/bin/env bash
# =============================================================================
# on-publish-done.sh — launched by nginx RTMP exec_publish_done when a
# publisher disconnects.
#
# Arguments:
#   $1  stream name (the RTMP application key, e.g. "stream")
#
# Environment variables:
#   STATS_API_URL          Base URL of the Node.js API  (default: http://127.0.0.1:3000)
#   STATS_SESSION_SECRET   Bearer token for /api/stats/session (optional)
#   LOG_DIR                Directory for logs            (default: /var/log/tuberadio)
# =============================================================================

set -euo pipefail

STREAM_NAME="${1:-stream}"
STATS_API_URL="${STATS_API_URL:-http://127.0.0.1:3000}"
STATS_SESSION_SECRET="${STATS_SESSION_SECRET:-}"
LOG_DIR="${LOG_DIR:-/var/log/tuberadio}"

mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/stats_$(date +"%Y-%m-%d").log"

echo "[$(date -Iseconds)] Stream done: '${STREAM_NAME}'" >> "$LOG_FILE"

if command -v curl >/dev/null 2>&1; then
  _AUTH_HEADER=""
  if [ -n "$STATS_SESSION_SECRET" ]; then
    _AUTH_HEADER="Authorization: Bearer ${STATS_SESSION_SECRET}"
  fi
  curl -sf \
    -X POST \
    -H "Content-Type: application/json" \
    ${_AUTH_HEADER:+-H "$_AUTH_HEADER"} \
    -d "{\"event\":\"end\",\"streamName\":\"${STREAM_NAME}\",\"timestamp\":\"$(date -Iseconds)\"}" \
    "${STATS_API_URL}/api/stats/session" \
    >> "$LOG_FILE" 2>&1 || true
else
  echo "[$(date -Iseconds)] curl not available — session end not recorded" >> "$LOG_FILE"
fi
