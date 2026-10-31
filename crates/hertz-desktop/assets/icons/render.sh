#!/usr/bin/env bash
# 把定稿 SVG 按各平台需要的尺寸渲染成透明底 PNG。
# 矢量 → 逐尺寸渲染，不做位图缩放，保证每一档都是清晰的。
set -euo pipefail

ROOT="D:/code/learning-hub/design/app-icon"
CHROME="/c/Users/miracle/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe"
OUT="$ROOT/build"
TMP="$ROOT/.render-tmp.html"

mkdir -p "$OUT/sizes"

render () {          # $1=尺寸  $2=svg相对路径  $3=输出png
  local size="$1" svg="$2" out="$3"
  cat > "$TMP" <<EOF
<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
img{display:block;width:${size}px;height:${size}px}
</style></head><body><img src="file:///D:/code/learning-hub/design/app-icon/${svg}"></body></html>
EOF
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 \
    --window-size="${size},${size}" \
    --screenshot="${out}" \
    "file:///${TMP}" >/dev/null 2>&1
}

# 小尺寸稿：16 / 24 / 32（六根减五根、加粗、去高光）
for s in 16 24 32; do
  render "$s" "svg/hertz-lyrics-small.svg" "$OUT/sizes/${s}.png"
  echo "  small ${s}px"
done

# 主稿：48 / 64 / 128 / 256 / 512 / 1024
for s in 48 64 128 256 512 1024; do
  render "$s" "svg/hertz-lyrics-glass.svg" "$OUT/sizes/${s}.png"
  echo "  main  ${s}px"
done

rm -f "$TMP"
echo "渲染完成 → $OUT/sizes"
