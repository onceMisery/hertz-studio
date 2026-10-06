#!/usr/bin/env bash
# 起一个隔离服务，然后跑一批「必须有活服务才能跑」的皮肤浏览器契约。
# 这些脚本在 CI 里会因为 127.0.0.1 上没有服务而 ECONNREFUSED —— 那是环境失败，
# 不是功能失败，所以要复现得先把服务拉起来。
#
# 用法：
#   bash scripts/qf-skin-checks.sh            # 默认 18790
#   PORT=18791 bash scripts/qf-skin-checks.sh
#
# 环境：
#   HERTZ_EXE  要跑的二进制（默认 ./target/debug/hertz-studio.exe）
#   NODE_PATH  playwright 所在目录（默认按托管 workspace 逐个探测）
set -u
export PATH="/usr/bin:/bin:/c/Windows/System32:/c/Program Files/Git/usr/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

PORT=${PORT:-18790}
EXE=${HERTZ_EXE:-./target/debug/hertz-studio.exe}
DIR="${TMPDIR:-/tmp}/hertz-skinfix"

if [ -z "${NODE_PATH:-}" ]; then
  for cand in \
    "$HOME/.workbuddy/binaries/node/workspace/node_modules" \
    "/c/Users/${USERNAME:-}/.workbuddy/binaries/node/workspace/node_modules"; do
    if [ -d "$cand" ]; then NODE_PATH="$cand"; break; fi
  done
fi
[ -n "${NODE_PATH:-}" ] && export NODE_PATH

if command -v node >/dev/null; then NODE_BIN=node; else
  NODE_BIN=""
  for c in "$HOME"/.workbuddy/binaries/node/versions/*/node.exe; do
    if [ -x "$c" ]; then NODE_BIN="$c"; fi
  done
fi
[ -n "$NODE_BIN" ] || { echo "找不到 node（PATH 里没有，托管版本也没找到）"; exit 1; }
[ -x "$EXE" ] || { echo "找不到二进制 $EXE（用 HERTZ_EXE 指定）"; exit 1; }

rm -rf "$DIR"; mkdir -p "$DIR" "output"

VMUSIC_BACKEND=null VMUSIC_PORT="$PORT" VMUSIC_DATA_DIR="$DIR" \
  "$EXE" --port "$PORT" > output/skinfix-service.log 2>&1 &
SVC=$!
cleanup() { kill "$SVC" 2>/dev/null; }
trap cleanup EXIT

code=000
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$PORT/" || true)
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then break; fi
  sleep 1
done
TICKET=$(grep -o 'ticket=[a-zA-Z0-9]*' output/skinfix-service.log | head -1 | cut -d= -f2)
# token 只能靠带 ticket 的首页拿到；curl 会消费掉 ticket，所以只取这一次。
TOK=$(curl -s --noproxy '*' "http://127.0.0.1:$PORT/?ticket=$TICKET" \
  | grep -o '__VMUSIC_TOKEN__ = "[^"]*"' | cut -d'"' -f2)
echo "service http=$code ticket=${TICKET:0:8}… token=${TOK:0:8}…"

rc=0
run() {
  echo "===== $1 ====="
  env "${@:2}" "$NODE_BIN" "scripts/$1.js" | tail -8
  local c=${PIPESTATUS[0]}
  echo "  → exit=$c"
  [ "$c" -ne 0 ] && rc=1
  return 0
}

run check-skin-fixes SKIN_PORT="$PORT" SKIN_TOKEN="$TOK"
run check-qf-issues  SKIN_PORT="$PORT" TK="$TOK"
# 每日推荐折叠按钮 × 五套皮肤 + 曲库行勾选框可见性。它自己拼 URL 与凭据
#（DAILY_UI_URL + VMUSIC_DATA_DIR 里的 token 文件），所以不接 SKIN_* 那两个变量。
run check-daily-collapse-browser \
  DAILY_UI_URL="http://127.0.0.1:$PORT/" VMUSIC_DATA_DIR="$DIR"
# 这几个自带服务发现逻辑或纯静态，直接跑
for f in check-daily-strip check-lib-row-actions; do
  run "$f" X=1
done
exit $rc
