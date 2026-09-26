#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# 版本检查（只读，不下载、不安装、不发布）：
#   比较本机 mmusic-studio 版本与 GitHub 上最新 Release 的 tag。
#
#   ./scripts/check-update.sh [BASE_URL]
#
#   BASE_URL 缺省为官方仓库 Releases；自托管/离线环境可传任意 URL 覆盖。
#   退出码：0=已是最新 1=有更新 2=无法判断（网络失败等）。

set -euo pipefail

REPO_API="${1:-https://api.github.com/repos/mmusic-studio/mmusic-studio/releases/latest}"

if ! command -v curl >/dev/null 2>&1; then
  echo "需要 curl（只读请求）" >&2
  exit 2
fi

# 本机版本：本地起了服务就读 /v1/health；否则直接问二进制（cargo 环境退回 Cargo.toml 版本）。
LOCAL_VERSION=""
if curl -fsS --max-time 3 http://127.0.0.1:7899/v1/health 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])" 2>/dev/null; then
  LOCAL_VERSION="$(curl -fsS --max-time 3 http://127.0.0.1:7899/v1/health 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")"
fi
if [ -z "$LOCAL_VERSION" ]; then
  if [ -x ./target/release/vmusicd ]; then
    LOCAL_VERSION="$(./target/release/vmusicd --version 2>/dev/null || true)"
  fi
fi
if [ -z "$LOCAL_VERSION" ]; then
  LOCAL_VERSION="$(python3 -c "import tomllib;print(tomllib.load(open('Cargo.toml','rb'))['workspace']['package']['version'])" 2>/dev/null || true)"
fi
if [ -z "$LOCAL_VERSION" ]; then
  echo "无法确定本机版本" >&2
  exit 2
fi

REMOTE="$(curl -fsS --max-time 10 "$REPO_API" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('tag_name',''))" || true)"
if [ -z "$REMOTE" ]; then
  echo "无法获取远端版本（离线或仓库不可达）" >&2
  exit 2
fi

REMOTE="${REMOTE#v}"
echo "本机版本: $LOCAL_VERSION"
echo "远端版本: $REMOTE"

if [ "$LOCAL_VERSION" = "$REMOTE" ]; then
  echo "已是最新。"
  exit 0
fi
echo "有新版本可用（升级请手动前往 Releases 下载并校验 SHA256SUMS）。"
exit 1
