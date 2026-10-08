#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 hertz-studio contributors
#
# 打一个 DBX 插件候选包（.dbxp + .artifact.json），并把元数据里的下载地址写成不可变 URL。
#
# 两条链路共用同一个脚本，避免"本地能装、上架被拒"这种分叉：
#   * .github/workflows/plugin-release.yml —— Release 触发，产出提交市场用的未签名候选。
#     这条会带 PLUGIN_RELEASE=1：候选必须落在不可变 URL 上，所以把 url 改写成
#     GitHub Release 资产地址（reviewer 要拿它核对 SHA-256）。
#   * .github/workflows/release.yml —— workflow_dispatch 手动构建，产物只供人工检视，
#     不发布，所以 url 保持裸文件名（可复用 workflow 只用它的 basename 做校验，两种都合法）。
#
# DBX_PLUGIN_TARGET 由发布矩阵注入（linux-x64 / linux-arm64 / windows-x64 / darwin-x64 /
# darwin-arm64）；不设时 CLI 按构建宿主推断 target，交叉打包会被 CLI 直接拒绝。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

# sidecar 依赖 cpal（ALSA）与 ashpd（libdbus）。Linux runner 上这两个 -dev 包缺一个就编不过，
# 而报错是 ld 层面的 "cannot find -lasound"，跟改名/协议都没关系，先补齐。
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends libasound2-dev libdbus-1-dev pkg-config
fi

if ! command -v dbx-plugin >/dev/null 2>&1; then
  echo "找不到 dbx-plugin CLI。CI 里由可复用 workflow 安装；本地请先执行：" >&2
  echo "  npm install --global @dbx-app/plugin-cli@0.1.2" >&2
  exit 1
fi

# 只清上一次的包，留着 dist/.build-rust-*：那是 CLI 给 sidecar 用的 cargo target 目录，
# 整目录删掉会让每次本地打包都从冷缓存重编 sidecar。
rm -f plugin/dist/*.dbxp plugin/dist/*.artifact.json

cd plugin
dbx-plugin package .
cd "$ROOT"

# Windows runner 上常只有 `python`（Git Bash 里 `python3` 可能不存在），别赌。
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "找不到 python3/python，无法核对候选元数据" >&2
  exit 1
fi

"$PY" - <<'PY'
import hashlib
import json
import os
import pathlib
import sys
import zipfile

release_mode = os.environ.get("PLUGIN_RELEASE") == "1"
repo = os.environ.get("GITHUB_REPOSITORY", "")
tag = os.environ.get("GITHUB_REF_NAME", "")
if release_mode and not (repo and tag):
    sys.exit(f"PLUGIN_RELEASE=1 但缺 GITHUB_REPOSITORY/GITHUB_REF_NAME（repo={repo!r} tag={tag!r}）")

base = f"https://github.com/{repo}/releases/download/{tag}"
packages = sorted(pathlib.Path("plugin/dist").glob("*.dbxp"))
metas = sorted(pathlib.Path("plugin/dist").glob("*.artifact.json"))
if len(packages) != 1 or len(metas) != 1:
    sys.exit(f"期望恰好 1 个 .dbxp 与 1 个 .artifact.json，实际 {len(packages)}/{len(metas)}")

for meta_path in metas:
    package = meta_path.with_name(meta_path.name[: -len(".artifact.json")] + ".dbxp")
    if not package.exists():
        sys.exit(f"{meta_path.name} 找不到同名包体 {package.name}")
    blob = package.read_bytes()
    data = json.loads(meta_path.read_text(encoding="utf-8"))
    # 这三项是 reviewer 与安装器唯一信任的东西：不一致就是"元数据说的和发出去的不是同一份"。
    digest = hashlib.sha256(blob).hexdigest()
    if data.get("sha256") != digest:
        sys.exit(f"{meta_path.name}: sha256 与包体不符（元数据 {data.get('sha256')} ≠ 实际 {digest}）")
    if data.get("size") != len(blob):
        sys.exit(f"{meta_path.name}: size 与包体不符（{data.get('size')} ≠ {len(blob)}）")
    if data.get("signingKeyId") is not None:
        sys.exit(f"{meta_path.name}: 候选包不得携带 signingKeyId，签名是仓库侧的事")
    names = zipfile.ZipFile(package).namelist()
    if "signature.json" in names:
        sys.exit(f"{package.name}: 候选包必须未签名（含 signature.json）")
    manifest = json.loads(zipfile.ZipFile(package).read("manifest.json"))
    for field in ("id", "name", "publisher", "version"):
        if not manifest.get(field):
            sys.exit(f"{package.name}: manifest 缺 {field}")
    data["url"] = f"{base}/{package.name}" if release_mode else package.name
    meta_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"{package.name}: target={data['target']} version={manifest['version']} "
          f"sha256={data['sha256'][:12]}… size={data['size']} url={data['url']}")
PY
