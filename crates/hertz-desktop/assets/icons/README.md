# 桌面歌词 · 图标导出包

定稿为**深色玻璃版**。矢量源在 `plugin/assets/lyrics/`，这里只放编译产物与打包脚本，
避免 `.dbxp` 插件包被二进制撑大（`prepare-edition.js` 会整目录复制 `plugin/assets`）。

## 目录内容

| 文件 | 用途 |
|---|---|
| `hertz-lyrics.iconset/` | macOS 打包源，11 个 PNG（含 @2x） |
| `hertz-lyrics.icns` | macOS 成品 |
| `hertz-lyrics.ico` | Windows 成品，含 16/24/32/48/64/128/256 七档 |
| `png/` | 通用 PNG，7 档（16 → 1024） |
| `svg/` | 随包矢量源（主稿 + 小尺寸稿） |
| `render.sh` `build-icons.js` | 换稿后重跑的生成脚本 |

## 分档规则

| 尺寸 | 用稿 | 原因 |
|---|---|---|
| 16 / 24 / 32 | `hertz-lyrics-small.svg` | 六根条在 16px 下间隙只剩 0.6px 会糊成一片，故减为五根并加粗到 2.6；去掉玻璃内描边与顶部高光，歌词行取消渐隐改实心 |
| 48 及以上 | `hertz-lyrics-glass.svg` | 保留完整的六根节奏、玻璃底板与歌词行渐隐 |

每一档都是**按该尺寸直接渲染矢量**，不是把大图缩小，所以边缘没有重采样毛边。

## 换稿流程

```bash
bash render.sh        # Chrome headless 逐尺寸渲染透明底 PNG
node build-icons.js   # 校验透明通道后生成 iconset / icns / ico / png
```

`render.sh` 依赖 Chrome/Chromium，需要按本机路径改 `CHROME` 变量。
`build-icons.js` 会校验每个 PNG 的 IHDR 尺寸与 `colorType === 6`（RGBA）——
透明通道没渲染出来就直接失败，不会产出圆角发白的坏文件。

macOS 上重新打包：`iconutil -c icns hertz-lyrics.iconset`（`iconutil` 只在 macOS 有，
Windows 侧由 `build-icons.js` 直接封装 icns，两种格式都内嵌 PNG，不需要位图库）。

## 注意：窗口图标目前还是另一套

`crates/hertz-desktop/src/app.rs` 里的 `hertz_icon_pixels()` 是**代码手绘的蓝色圆盘 + 白色 H**，
供 `window_icon()` 与 `tray_icon_image()` 使用，与本导出包**不是同一套语言**（插件侧是六根频谱）。

要统一到这套图标，需要把 `window_icon()` / `tray_icon_image()` 改成加载
`png/hertz-lyrics-{32,64}.png`（`include_bytes!` + `image` crate 解码），
而不是继续手绘像素。这一步会动到 `app.rs`，未在本次改动范围内。
