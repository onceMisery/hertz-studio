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
  # 这里必须是 cleanup 的最后一个真值命令：EXIT trap 的返回状态会顶替脚本的退出码，
  # 而 `[[ -d ]] && echo` 在「目录已成功删除」时返回 1——成功路径反而让整条 smoke
  # 退 1。Windows 上临时目录常因 SQLite 文件锁删不掉、会走到 echo 返回 0，所以这个
  # bug 只在 ubuntu 暴露：日志末尾写着 smoke test passed，步骤却判失败。
  if [[ -d "$DATA" ]]; then
    echo "(could not remove temp dir: $DATA)"
  fi
}
trap cleanup EXIT

echo "==> building"
cargo build --manifest-path "$ROOT/Cargo.toml" --bin hertz-studio

echo "==> starting on port $PORT (data dir $DATA)"
"$ROOT/target/debug/hertz-studio" --port "$PORT" --data-dir "$DATA" >"$DATA/server.log" 2>&1 &
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

AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

echo "==> 收藏：新增 / 列表 / 判红 / 开关 / 删除"
curl -sf "${AUTH[@]}" -X POST \
  -d '{"kind":"track","source":"local","ref_id":"smoke-1","title":"Smoke One","artist":"QA"}' \
  "http://127.0.0.1:$PORT/v1/favorites" | grep -q '"favorited":true'
# 重复收藏必须落在同一行上，不能变成两条。
curl -sf "${AUTH[@]}" -X POST \
  -d '{"kind":"track","source":"local","ref_id":"smoke-1","title":"Smoke One","artist":"QA"}' \
  "http://127.0.0.1:$PORT/v1/favorites" | grep -q '"favorited":true'
curl -sf "${AUTH[@]}" "http://127.0.0.1:$PORT/v1/favorites?kind=track" \
  | grep -q '"total":1'
curl -sf "${AUTH[@]}" -X POST \
  -d '{"kind":"track","source":"local","ids":["smoke-1","nope"]}' \
  "http://127.0.0.1:$PORT/v1/favorites/membership" | grep -q '"smoke-1"'
# 开关到关闭，再开回来；最终态由服务端说了算。
curl -sf "${AUTH[@]}" -X POST \
  -d '{"kind":"track","source":"local","ref_id":"smoke-1","favorited":false}' \
  "http://127.0.0.1:$PORT/v1/favorites/toggle" | grep -q '"favorited":false'
curl -sf "${AUTH[@]}" -X POST \
  -d '{"kind":"track","source":"local","ref_id":"smoke-1"}' \
  "http://127.0.0.1:$PORT/v1/favorites/toggle" | grep -q '"favorited":true'
curl -sf "${AUTH[@]}" -X DELETE \
  "http://127.0.0.1:$PORT/v1/favorites/track:local:smoke-1" | grep -q '"ok":true'
curl -sf "${AUTH[@]}" "http://127.0.0.1:$PORT/v1/favorites" | grep -q '"total":0'

echo "==> 收藏：非法类型必须 400 而不是静默吞掉"
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST \
  -d '{"kind":"album","source":"local","ref_id":"x","title":"X"}' \
  "http://127.0.0.1:$PORT/v1/favorites")
[[ "$code" == "400" ]] || { echo "expected 400 for bad kind, got $code"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST \
  -d '{"kind":"track","source":"local","ref_id":"","title":"X"}' \
  "http://127.0.0.1:$PORT/v1/favorites")
[[ "$code" == "400" ]] || { echo "expected 400 for empty ref_id, got $code"; exit 1; }

echo "==> 每日推荐：确定性与入参校验"
DAY_A="$(curl -sf "${AUTH[@]}" "http://127.0.0.1:$PORT/v1/recommend/daily" | tr -d '\n')"
grep -q '"day"' <<<"$DAY_A"
DAY_B="$(curl -sf "${AUTH[@]}" "http://127.0.0.1:$PORT/v1/recommend/daily" | tr -d '\n')"
[[ "$DAY_A" == "$DAY_B" ]] || { echo "每日推荐同一天必须完全一致"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" \
  "http://127.0.0.1:$PORT/v1/recommend/daily?limit=0")
[[ "$code" == "400" ]] || { echo "expected 400 for limit=0, got $code"; exit 1; }

echo "==> 汽水音乐：已注册且能力位如实"
curl -sf "${AUTH[@]}" "http://127.0.0.1:$PORT/v1/online/sources" | grep -q '"qishui"'
# 只登记了 CookieLogin：不承诺扫码，也不承诺高音质（受保护音质是拒播的）。
curl -sf "${AUTH[@]}" "http://127.0.0.1:$PORT/v1/online/sources" \
  | tr ',' '\n' | grep -A0 '"caps"' | head -1

echo "==> ui"
# `/` 已收紧：无凭据时它不再把长期令牌注进 HTML（那正是「本机任何进程 GET 一下
# 首页就拿到令牌」的成因），而是回一页自包含的「需要凭据」自救页。
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[[ "$code" == "401" ]] || { echo "expected 401 for bare /, got $code"; exit 1; }
# 出示凭据才渲染，且注进去的就是当前服务的令牌。
curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/" \
  | grep -qF "window.__VMUSIC_TOKEN__ = \"$TOKEN\""
# 内嵌资源：新增的两个模块必须能取到，否则界面静默少一块功能。
curl -sf "http://127.0.0.1:$PORT/favorites.js" | grep -q 'Favorites'
curl -sf "http://127.0.0.1:$PORT/daily.js" | grep -q 'Daily'

echo "==> 首跳票据：签发 → 兑换 200 → 复用 401（一次性）"
TICKET="$(curl -sf "${AUTH[@]}" -X POST -d '{}' "http://127.0.0.1:$PORT/v1/auth/ticket" \
  | sed -n 's/.*"ticket":"\([^"]*\)".*/\1/p')"
[[ -n "$TICKET" ]] || { echo "ticket issue returned no id"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/?ticket=$TICKET")
[[ "$code" == "200" ]] || { echo "expected 200 for ticket first hop, got $code"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/?ticket=$TICKET")
[[ "$code" == "401" ]] || { echo "expected 401 for replayed ticket, got $code"; exit 1; }

echo "==> 会话 cookie：令牌换 cookie，之后刷新/书签不再需要地址里带凭据"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"token":"definitely-not-the-token"}' "http://127.0.0.1:$PORT/v1/auth/session")
[[ "$code" == "401" ]] || { echo "expected 401 for a wrong token, got $code"; exit 1; }
JAR="$(mktemp)"
curl -sf -o /dev/null -c "$JAR" -X POST -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\"}" "http://127.0.0.1:$PORT/v1/auth/session"
curl -sf -b "$JAR" "http://127.0.0.1:$PORT/" | grep -qF "window.__VMUSIC_TOKEN__ = \"$TOKEN\""
rm -f "$JAR"

echo
echo "smoke test passed"
