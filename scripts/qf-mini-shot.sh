#!/usr/bin/env bash
# 一键：起隔离服务 → 造曲播放 → 切清风截图 → 行为验收 → 收摊。
#
# 沙箱/会话会按进程树回收后台服务，所以「起服务 → 验收」必须压进同一个进程。
#
# 用法：
#   bash scripts/qf-mini-shot.sh                      # 默认 18780 / 1440x900
#   PORT=18781 SHOT_W=1280 SHOT_H=720 bash scripts/qf-mini-shot.sh
#
# 环境：
#   HERTZ_EXE  要跑的二进制（默认 ./target/debug/hertz-studio.exe）
#   NODE_PATH  playwright 所在目录（默认按托管 workspace 逐个探测）
set -u
export PATH="/usr/bin:/bin:/c/Windows/System32:/c/Program Files/Git/usr/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

PORT=${PORT:-18780}
EXE=${HERTZ_EXE:-./target/debug/hertz-studio.exe}
DIR="${TMPDIR:-/tmp}/hertz-qfmini"

# playwright 装在隔离的托管 workspace 里，全局 node_modules 里通常没有。
# 逐个探测候选目录，找不到就让调用方自己设 —— 别写死某台机器的绝对路径。
if [ -z "${NODE_PATH:-}" ]; then
  for cand in \
    "$HOME/.workbuddy/binaries/node/workspace/node_modules" \
    "/c/Users/${USERNAME:-}/.workbuddy/binaries/node/workspace/node_modules"; do
    if [ -d "$cand" ]; then NODE_PATH="$cand"; break; fi
  done
fi
[ -n "${NODE_PATH:-}" ] && export NODE_PATH

# node 优先走 PATH，没有再退回托管版本（bash 里 PATH 常常是坏的）。
if command -v node >/dev/null; then NODE_BIN=node; else
  NODE_BIN=""
  for c in "$HOME"/.workbuddy/binaries/node/versions/*/node.exe; do
    if [ -x "$c" ]; then NODE_BIN="$c"; fi      # 取最后一个 = 版本号最大的
  done
fi
[ -n "$NODE_BIN" ] || { echo "找不到 node（PATH 里没有，托管版本也没找到）"; exit 1; }
[ -x "$EXE" ] || { echo "找不到二进制 $EXE（用 HERTZ_EXE 指定，或先 cargo build -p hertz-studio）"; exit 1; }

rm -rf "$DIR"; mkdir -p "$DIR" "output"

VMUSIC_BACKEND=null VMUSIC_PORT="$PORT" VMUSIC_DATA_DIR="$DIR" \
  "$EXE" --port "$PORT" > "output/qf-mini-service.log" 2>&1 &
SVC=$!
cleanup() { kill "$SVC" 2>/dev/null; }
trap cleanup EXIT

code=000
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$PORT/" || true)
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then break; fi
  sleep 1
done
# 首页带一次性 ticket 才 200；ticket 只能被消费一次，所以交给 node 脚本里的
# 页面自己去取 token（脚本侧 fetch 一下就把 ticket 吃掉了）。
TICKET=$(grep -o 'ticket=[a-zA-Z0-9]*' output/qf-mini-service.log | head -1 | cut -d= -f2)
echo "service http=$code ticket=${TICKET:0:8}… (pid=$SVC)"

SKIN_PORT="$PORT" TICKET="$TICKET" SHOT_TAG="${SHOT_TAG:-qfmini}" \
  SHOT_W="${SHOT_W:-1440}" SHOT_H="${SHOT_H:-900}" \
  "$NODE_BIN" scripts/qf-mini-shot.js
rc=$?
echo "shot rc=$rc"
exit $rc
