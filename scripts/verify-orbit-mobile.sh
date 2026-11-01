#!/usr/bin/env bash
# 星轨手机导航实测：起隔离实例 → 跑浏览器脚本 → 收摊。
# 整条链路压在一个进程里：沙箱按会话回收后台进程，分开跑必然中途死掉。
set -u

PORT="${PORT:-18826}"
DATA_DIR="${DATA_DIR:-D:/tmp/hertz-orbit-mobile}"
ROOT="D:/code/github/hertz-studio"
EXE="$ROOT/target-verify/debug/hertz-studio.exe"
NODE="C:/Users/miracle/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
NODE_PATH_DIR="C:/Users/miracle/.workbuddy/binaries/node/workspace/node_modules"

rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

echo "== 起隔离实例 :$PORT =="
VMUSIC_BACKEND=null VMUSIC_PORT="$PORT" VMUSIC_DATA_DIR="$DATA_DIR" \
  "$EXE" > "$DATA_DIR/server.log" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT

# 探活必须加 --noproxy '*'：本机代理会把 127.0.0.1 也接管，返回假响应。
for _ in $(seq 1 60); do
  if curl --noproxy '*' -s -o /dev/null "http://127.0.0.1:$PORT/v1/health"; then
    break
  fi
  sleep 1
done

if ! curl --noproxy '*' -s -o /dev/null "http://127.0.0.1:$PORT/v1/health"; then
  echo "服务没起来，日志："
  tail -30 "$DATA_DIR/server.log"
  exit 1
fi

echo "== 校验线上前端就是磁盘上那份 =="
for f in skins/skin.orbit.css skins/skin.orbit.js; do
  live=$(curl --noproxy '*' --fail --silent "http://127.0.0.1:$PORT/$f" | md5sum | cut -d' ' -f1)
  disk=$(md5sum < "$ROOT/plugin/ui/$f" | cut -d' ' -f1)
  printf "%-26s %s\n" "$f" "$([ "$live" = "$disk" ] && echo SAME || echo DIFF)"
done

echo "== 跑浏览器实测 =="
VMUSIC_DATA_DIR="$DATA_DIR" PLAYER_UI_URL="http://127.0.0.1:$PORT" \
NODE_PATH="$NODE_PATH_DIR" \
  "$NODE" "$ROOT/scripts/check-orbit-mobile-browser.js"
STATUS=$?
echo "== 服务日志尾部 =="
tail -12 "$DATA_DIR/server.log"
exit $STATUS
