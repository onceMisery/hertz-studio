#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# End-to-end smoke test: build, start the service, exercise the API, stop.
#
# Usage: bash scripts/smoke.sh [port]

set -euo pipefail

PORT="${1:-7899}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$(mktemp -d)"

cleanup() {
  if [[ -n "${PID:-}" ]]; then
    kill "$PID" 2>/dev/null || true
    # 等它真的退出。不等的话下面删临时目录会在 Windows 上撞开着的 SQLite 文件
    # （"Device or resource busy"），每次 CI 留一个临时目录在 %TEMP% 里。
    wait "$PID" 2>/dev/null || true
  fi
  for _ in 1 2 3 4 5; do
    rm -rf "$DATA" 2>/dev/null && break
    sleep 0.3
  done
  [[ -d "$DATA" ]] && echo "(could not remove temp dir: $DATA)"
}
trap cleanup EXIT

echo "==> building"
cargo build --manifest-path "$ROOT/Cargo.toml" --bin vmusicd

echo "==> starting on port $PORT (data dir $DATA)"
"$ROOT/target/debug/vmusicd" --port "$PORT" --data-dir "$DATA" >"$DATA/server.log" 2>&1 &
PID=$!

echo "==> waiting for health"
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

echo "==> GET /v1/health"
curl -sf "http://127.0.0.1:$PORT/v1/health" | tee /dev/stderr | grep -q '"status":"ok"'

echo "==> unauthenticated request must be rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/tracks")
[[ "$code" == "401" ]] || { echo "expected 401, got $code"; exit 1; }

TOKEN="$(cat "$DATA/token")"

echo "==> authenticated requests"
curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/tracks" | grep -q '"tracks"'
curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/state" | grep -q '"playing"'
curl -sf -H "Authorization: Bearer $TOKEN" -X POST "http://127.0.0.1:$PORT/v1/player/pause" >/dev/null
curl -sf -H "Authorization: Bearer $TOKEN" -X POST -H 'Content-Type: application/json' \
  -d '{"volume":0.5}' "http://127.0.0.1:$PORT/v1/player/volume" >/dev/null
curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/playlists" | grep -q '"playlists"'

echo "==> discovery file"
[[ -f "$DATA/vmusicd.json" ]] || { echo "missing discovery file"; exit 1; }

echo "==> ui"
curl -sf "http://127.0.0.1:$PORT/" | grep -q 'mmusic'

echo
echo "smoke test passed"
