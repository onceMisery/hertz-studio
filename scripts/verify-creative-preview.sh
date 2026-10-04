#!/usr/bin/env bash
# 创意工坊预览的一键视觉验收。
#
# 为什么要这个脚本：沙箱会回收长驻进程（实测 2~15 分钟），后台起服务、
# 隔一会儿再跑浏览器脚本这条路走不通 —— 服务总在中间死掉。
# 所以这里把「起服务 → 等就绪 → 跑两个浏览器实测 → 收摊」压进**同一个进程**，
# 不跨会话存活。
#
# 用法：
#   bash scripts/verify-creative-preview.sh          # 默认 7641
#   PORT=7650 bash scripts/verify-creative-preview.sh
#
# 退出码：0 = 全部通过（服务已关闭）；非 0 = 有失败项。
# 截图落在 output/verify/。

set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-7641}"
ROOT="$PWD"
EXE="$ROOT/target/debug/hertz-studio.exe"
[ -f "$EXE" ] || EXE="$ROOT/target-verify/debug/hertz-studio.exe"

# playwright 装在**隔离的托管 node workspace** 里，不是全局 node_modules，
# 所以 require('playwright') 会失败，要靠 NODE_PATH 指过去。
#
# 别把这台机器的绝对路径写死进仓库 —— 别人 clone 下来就指向一个不存在的目录，
# 症状是 "Cannot find module 'playwright'"，看起来像依赖没装。
# 优先用调用方传入的 NODE_PATH，其次找托管 workspace，最后才退回全局。
if [ -z "${NODE_PATH:-}" ]; then
  for cand in \
    "$HOME/.workbuddy/binaries/node/workspace/node_modules" \
    "/c/Users/$USERNAME/.workbuddy/binaries/node/workspace/node_modules"
  do
    if [ -d "$cand" ]; then NODE_PATH="$cand"; break; fi
  done
fi
if [ -n "${NODE_PATH:-}" ]; then
  export NODE_PATH
  echo "NODE_PATH=$NODE_PATH"
else
  echo "提示：未找到托管 node workspace，用全局 node_modules（若 playwright 装在别处请自行设 NODE_PATH）"
fi

command -v node >/dev/null || { echo "找不到 node"; exit 1; }
[ -f "$EXE" ] || { echo "找不到可执行文件（先 cargo build）"; exit 1; }

# 后台会话可能已经占着这个端口。
#
# 两个坑，都踩过：
#  1. **必须 --noproxy。** 本机 HTTP 代理（127.0.0.1:7890）会接管对
#     127.0.0.1 的请求并**返回一个假响应**，于是 curl 退出码 0、
#     看起来"服务在跑"，紧接着浏览器就撞 ERR_CONNECTION_REFUSED。
#  2. **要探两次。** 沙箱回收服务时会经历一段"端口还 accept、进程正在退出"
#     的窗口，只探一次会误判成"已有服务"，后面全崩。
alive() {
  curl -s --noproxy '*' -o /dev/null --max-time 3 \
    "http://127.0.0.1:$PORT/v1/health" 2>/dev/null
}

if alive && alive; then
  echo "端口 $PORT 上已有服务在跑，直接复用。"
else
  "$EXE" --port "$PORT" >/tmp/ws-verify-$PORT.log 2>&1 &
  SVC=$!
  trap 'kill $SVC 2>/dev/null' EXIT
  for _ in $(seq 1 20); do
    alive && break
    sleep 0.5
  done
  if ! alive; then
    echo "服务没起来："; tail -20 "/tmp/ws-verify-$PORT.log"; exit 1
  fi
  echo "服务已起：http://127.0.0.1:$PORT/"
fi

# 起服务后等一拍再连：健康检查通了不代表首页路由已经能响应。
sleep 1

BASE="http://127.0.0.1:$PORT" node scripts/check-creative-preview-visual.js
RC1=$?
BASE="http://127.0.0.1:$PORT" node scripts/check-workshop-stanza-lock.js
RC2=$?

echo
echo "截图在 output/verify/"
[ $RC1 -eq 0 ] && [ $RC2 -eq 0 ] && echo "两组实测全部通过。" || echo "有失败项，见上方输出。"
exit $(( RC1 | RC2 ))