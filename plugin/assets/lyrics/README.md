# 桌面歌词图标 · 矢量定稿

沿用本目录上一级的 `plugin.svg`（官方标识）：**六根圆头频谱条**，24 网格、
高度 `1 / 6 / 13 / 8 / 3 / 1`、品牌蓝 `#2563EB`。在此基础上加**一条横穿的歌词行**——
白色圆头条压在频谱之下，右端渐隐，对应逐字高亮。

| 文件 | 用途 |
|---|---|
| `hertz-lyrics-glass.svg` | **主稿**。深色玻璃底 + 蓝频谱 + 白歌词行，与桌面悬浮窗同源材质 |
| `hertz-lyrics-blue.svg` | 品牌蓝渐变底 + 白色图形，Dock / 插件市场辨识度最高 |
| `hertz-lyrics-line.svg` | 透明底线描版，与 `plugin.svg` 完全同规格（1.8 描边），可直接并进图标体系 |
| `hertz-lyrics-small.svg` | 32 / 16px 专用稿：六根减五根、加粗到 2.6、去玻璃高光、歌词行改实心 |

小尺寸为什么要单独出稿：六根条在 16px 下间隙只剩 0.6px，必然糊成一片；
宁可少一根，也要保住「竖条频谱」这个印象。

## 二进制导出包不放在这里

`scripts/prepare-edition.js` 会 `fs.cpSync` **整个** `plugin/assets` 打进 `.dbxp`，
所以 `.icns` / `.ico` / 各档 PNG（约 700 KB）放在
`crates/hertz-desktop/assets/icons/`——那才是窗口与托盘图标真正的消费方。
