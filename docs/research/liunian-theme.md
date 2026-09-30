# 「流年」主题皮肤实现说明（v2）

> 2026-09-30 续作后的布局以文末「首页与凝彩续作」为准；原三栏说明保留为历史记录。

- 日期：2026-09-29
- 参照项目：`D:\code\github\VCPChat\Musicmodules`（VCPChat 内置音乐播放器，下称 VMusic）
- 交付内容：一套布局皮肤（liunian）+ 一套同名配色主题（liunian）+ 皮肤专属 DOM 重编排模块

## 1. 设计目标

在整体视觉、元素排布、交互逻辑、功能模块组织上与 VMusic 高度一致：

```
┌───────────────────────────────────────────────────────────────┐
│ 标题栏（透明）                                                  │
├───────────┬────────────────────────────────┬──────────────────┤
│ 左栏 280  │ 中栏（弹性）                    │ 右栏 300         │
│           │                                │                  │
│ 搜索       │  播放卡（文档流玻璃卡）：        │ 频谱卡（52px）    │
│ 本地/云端  │   封面 + 标题艺术家             │                  │
│ tabs：    │   进度条 + 时间                 │ 歌词卡（弹性滚动） │
│ 全部/专辑 │   模式/上一首/播放/下一首/音量    │                  │
│ /歌手/歌单│                                │                  │
│ 歌曲列表  │  内容区（工具行 + 每日推荐/       │                  │
│ （弹性滚动）│   设置分组等，弹性滚动）          │                  │
│ +新建歌单  │                                │                  │
└───────────┴────────────────────────────────┴──────────────────┘
```

「流年」视觉意境：旧纸暖褐底、沉金强调色、残朱次色，标题衬线点缀，老照片暗角。

## 2. 文件清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `crates/vmusicd/web/skins/skin.liunian.css` | 新增 | 皮肤本体：三栏玻璃布局与组件样式 |
| `crates/vmusicd/web/skins/skin.liunian.js` | 新增 | 皮肤激活时的**可逆 DOM 重编排**（见 §4） |
| `crates/vmusicd/web/skins/skins.js` | 修改 | CATALOG 登记 liunian |
| `crates/vmusicd/web/themes.js` | 修改 | 新增「流年」配色主题 |
| `crates/vmusicd/web/index.html` | 修改 | 引入 skin.liunian.css（默认 disabled）与 skin.liunian.js |
| `crates/vmusicd/src/main.rs` | 修改 | 两个资源的 `include_str!` + 路由 |
| `scripts/check-skins.js` | 修改 | 契约扩展（157 项，含重编排 JS 的机制与顺序断言） |
| `crates/vmusicd/web/app.js` | 修改 | 修复预存 bug：`loadRemoteRoots` 作用域（见 §8） |

无新增二进制资源：背景沿用模糊封面（`#ambient`）与主题氛围光。

## 3. 架构：皮肤 × 主题正交

- 皮肤 CSS 无颜色字面量（hex/rgb/颜色关键字全禁），着色引用主题 token；
- 主题只声明 `{ token: value }`，由 themes.js 写成 `<html>` 行内变量；
- 流年皮肤可配任意主题，流年主题也可配任意皮肤。

唯一允许写 `color` 的场景：复刻 VMusic 激活态「沉金底 + 深字」——`color: var(--accent-ink)`，值只能引用主题 token（契约逐行扫描）。

## 4. DOM 重编排（skin.liunian.js）

### 为什么需要 JS

本项目是 SPA（.rail 导航 → .column 六视图 → .stage，.bar 在 body 末尾），VMusic 骨架中「歌曲列表本体在左栏、播放卡在中栏文档流、频谱歌词在右栏」无法靠 CSS 跨容器移动节点实现。

### 机制（全部可逆）

- `relocate(node, parent, before?)`：搬运前在原位插入 `<span class="ln-anchor">`，再移动节点；
- `unmount` 时 `restoreMoves()` 按**后进先出**经锚点 `insertBefore` 回原位再删锚点，原顺序严格保持；
- 新建结构节点（`.ln-*`、`.bar-row1`、`#ln-left-scrim`）卸载时 `remove`；
- 视图切换联动用 MutationObserver 观察 `.view` 的 `hidden`，不 hook 业务代码；
- 业务监听器随节点一起走，不丢；不改业务状态。

### 重编排内容

- 左栏：`.topsearch` 移入；建「本地/云端导入」按钮、四个 tab、列表区六槽；
  - `#lib-list` 等六个视图的列表本体分别入槽；
  - tab「专辑/歌手」从曲库行 DOM 聚合生成分组卡片，点卡片代理筛选 select（`#lib-artist-filter`/`#lib-album-filter` 的 onchange）；
  - 底部「+新建歌单」（仅歌单 tab 显示）；
- 中栏：`.bar` 移入 `.column` 最前；bar 内重排为 `.bar-row1`（唱片变 84px 方封面 + 曲目）→ `.bar-progress` → `.bar-controls`（模式/上一首/播放/下一首/音量；隐藏 stop）；
- 右栏：`.disc-wrap` 移到播放卡；stage 仅留频谱卡（头部 + #spectrum 52px、两侧 16px 内收）与歌词卡，kicker 文本改「Vocal Performance」（还原时恢复）。

## 5. 色彩系统

| Token | 值 | 语义 |
| --- | --- | --- |
| `--bg` | `#15110d` | 旧纸暖褐近黑底 |
| `--panel` | `rgba(38,30,22,.62)` | 暖调玻璃面板 |
| `--line` / `--line-strong` | `rgba(226,190,140,.10/.20)` | 分隔线 |
| `--text` | `#f3e8d8` | 宣纸白（对比 ≈14.8:1） |
| `--muted` | `#ab9880` | 暖灰（对比 ≈6.6:1） |
| `--accent` | `#d8ab60` | 沉金：主按钮/激活态/进度 |
| `--accent-2` | `#c0704e` | 残朱：次强调 |
| `--accent-ink` | `#241a08` | 沉金底深字（对比 ≈7.8:1） |
| `--highlight` | `#e7c687` | 高亮：歌词当前行/选中 |
| `--liunian-vignette` | `radial-gradient(125% 100% at 50% 38%, transparent 58%, rgba(18,12,6,.42) 100%)` | 老照片暗角 |

## 6. 响应式

| 宽度 | 表现 |
| --- | --- |
| ≥1241px | 完整三栏 280 / 弹性 / 300；空闲态右栏隐藏收两列 |
| 1001–1240px | 左栏 240px；右栏 translateX 抽屉 |
| ≤1000px | 左栏也抽屉化（品牌点击唤出，遮罩 #ln-left-scrim），中栏独占 |
| ≤900px | 播放卡压缩（封面 64） |
| ≤620px | 传输行隐音量、控件缩小 |

抽屉 transform 机制沿用基础样式，皮肤只报几何。

## 7. 验证记录

- `node scripts/check-skins.js`：**157/157 通过**；
- `node scripts/check-css-tokens.js`：通过（6 文件 / 1408 规则）；
- 独立构建目录 `cargo build -p vmusicd --target-dir target-verify`：成功（避开用户正在运行的 target/debug 实例的文件锁）；
- 两轮浏览器实测（独立验证库 `output/liunian-verify`，端口 19180）：
  - 首轮发现 6 个问题：重编排脚本注释致 SyntaxError、bar 内三处无锚点搬运导致切皮错位、loadRemoteRoots 报错、播放卡封面被全局规则吞掉、云端按钮黑字、stop 未隐藏；
  - 全部修复后第二轮复测逐项确认消除：自动挂载正常、切 workbench/classic 后 bar 完整还原（子序 track→controls→progress→right，mode/volume 回 bar-right，无 .ln-* 残留）、设置页正常、封面 84×84 显示、按钮可读、stop 隐藏；
  - 1440 宽屏：三栏 `280 / 766 / 300`，播放卡与中栏左右缘对齐、无侵入。

## 8. 顺带修复的预存 bug

`app.js` 的 `setView()`（顶层函数）进入设置时调用嵌套在初始化函数内的 `loadRemoteRoots()`，作用域不可见，任何皮肤下均报 ReferenceError、WebDAV 远程列表不加载。按项目已有的 `window.__loadCacheStats` / `window.__loadDspSettings` 同模式修复：定义后挂 `window.__loadRemoteRoots`，调用点走 window。

## 9. 使用方式

设置 → 界面皮肤 →「流年」；设置 → 主题色 →「流年」。分别持久化（`vmusic.skin` / `vmusic.theme.v2`），可独立搭配。窄屏下点击顶栏品牌名唤出左栏。

## 10. 交互增强（2026-09-29 追加）

### 左栏折叠/展开

- 顶部控制条 `.ln-railbar` + 切换按钮（«/»）；
- 单一状态类 `body.ln-rail-collapsed` 驱动：栅格第一轨 280→44px，内容隐藏、按钮居中成为入口；
- 过渡 240ms（grid-template-columns，ease-out）；
- **悬停 peek**：收起态 hover 窄条 → rail 以 `position:fixed` 浮出完整 280px 内容，移开即收回（不挤压布局）；
- 快捷键 **Ctrl/Cmd+B** 双向切换；
- 持久化：`vmusic.ln-rail-collapsed`，刷新/重启保持；
- 跨断点：≤1000px 左栏是抽屉，折叠按钮隐藏、collapsed 类临时解除，回宽屏按持久化恢复（resize 同步 + CSS 兜底双保险）。

实现注意：peek 时 rail fixed 离流，必须在 collapsed 态显式钉死三子元素 grid-column（1/2/3），否则 grid 自动放置把 column 塞进 44px 第一轨导致中栏塌缩（实测踩坑）。

### 设置页完善

- 滚动修复：`#view-settings { overflow-y:auto }`——设置内容为自然流，.column 是 overflow:hidden，无内部滚动容器时内容被裁剪；
- `.col-head` sticky（半透明底+模糊取 token）；
- 「← 返回」按钮：记住进入设置前最近一个视图（`lastWorkView`，reflow 时更新），点击精确回源；
- 视图入场动画 ln-view-enter 240ms（淡入+上移），打开与返回均播放；尊重 reduce-motion；
- 主题切换：`#set-theme`/`#theme-swatches` 切换后设置页滚动位置保持、配色整体跟随。

> 后续变更：① 侧栏收起态的悬停 peek 已移除（改为仅「展开」按钮/Ctrl+B 触发，避免边缘误触）；② 封面浮雕场景的播放队列已从屏幕右侧移至**左侧**竖向轨道（见 §11）。

## 11. 封面浮雕场景的布局对齐 openmusic（2026-09-29 追加）

参照 `D:\code\github\openmusic` 沉浸模式，对 `data-scene="silk"` 场景做了三处调整：

1. **歌单架默认右侧竖向**：`shelfMode` 默认值 `stage`(横向封面流) → `side`，卡片沿右缘纵向排列、当前曲放大居中；stage-shelf 的卡片拖动在 side 下改为上下滑动。
2. **锚点修复（卡片不再出屏）**：卡片以 `translate(-50%,-50%)` 把中心钉在零尺寸锚点，锚点 `right` 必须 = 卡半宽 + 净距（宽屏 `calc(clamp(106px,11vw,160px)+24px)`，各窄屏断点同步），此前 `right:-5vw` 把整列推到屏外、约 70% 被裁切。
3. **播放队列改到左侧**：`#s3d-queue-panel` 由 `right:0` 改为 `left:0`、圆角反转（`0 22px 22px 0`）、滑入动画从左缘进入；列表保持纵向滚动。

**取窗修复**：stage-shelf `setItems` 新增 `windowAround()`——以当前播放曲（playing 标记）为中心取 8 条窗口（当前曲 + 后续，窗口有余再补已播曲目），此前直接 `slice(0,MAX_CARDS)`，播放越过第 8 首后当前曲消失、歌单架退回队首。

实测（1084 与 1440 宽）：队列完整贴左、右侧歌单架当前曲完整在屏，中央点阵封面居中不被遮挡，队列列表上下滚动与当前行高亮正常。

## 12. 首页与凝彩续作（2026-09-30）

沿用已有流年皮肤与主题，不覆盖其他在途改动。首页只保留页面导航、播放卡、每日推荐与曲库；曲库排序、筛选、失效整理收进「曲库管理」。导航提供首页、在线、歌单、收藏、队列、设置，当前页面明确高亮。推荐横向展示一组曲目，并可进入完整推荐页。

桌面保留左侧本地曲库与右侧歌词。在线、收藏、歌单、队列在各自的主内容区展示，避免把列表搬到侧栏后留下空白页面。小于等于 1000px 时，本地列表、空态、分页按钮和批量操作一起回到主内容区，搜索直接显示，无需打开侧栏抽屉。切走流年时经原有锚点还原全部节点。

### 播放卡与响应式

- 「收为胶囊 / 展开」复用同一组播放、切歌和进度控件；用户选择保存在 `vmusic.ln-capsule`。未作选择时，手机宽度（≤620px）默认紧凑胶囊。
- 手机和平板使用主内容区整体滚动；短桌面窗口（高度≤760px）也使用整体滚动，播放卡不会把推荐区挤成窄条。导航保持吸附，切换页面回到顶部。
- 宽屏内容限制在 1680px 以内；320px 宽度仍可显示六个文字导航入口。
- 设置项和缓存操作允许自然换行，避免内容超宽被裁切。舞台设置面板限制高度、内部滚动，并保持关闭入口可达。

### 凝彩与舞台胶囊

补齐既有 `folia-tempera.js` 的 HTML 引用、Rust 内嵌与路由。首页「凝彩舞台」打开凝彩歌词视觉、纯色背景与星落舞台操作层；其他皮肤可从舞台设置或创意工坊选择凝彩。九种构图、三种配色、网屏、逐字反色均可调整并随舞台偏好保存、恢复。

凝彩继续消费 Stage 的播放时间、歌词、频谱和帧门；与商籁互斥显示，共用惰性加载的 PixiJS。销毁时先清理两种渲染器，再由宿主释放共享资源池；异步初始化期间销毁也会在初始化完成后正确回收。避免第一个渲染器销毁全局纹理池，导致另一个渲染器卸载文字时报错。

### 验证方式与边界

- `node scripts/check-folia-tempera.js` 验证确定性构图、色彩、扫光时间轴、异步初始化取消和资源接线。
- `check-skins.js`、`check-assets.js`、`check-css-tokens.js`、`check-folia.js`、`check-folia-sonnet.js`、`check-stage-theme.js` 等现有契约检查。
- Playwright 脚本与截图位于忽略目录 `output/ui-review/`、`output/playwright/`，覆盖各页面内部宽度、导航、胶囊、皮肤往返、凝彩参数与销毁重建。使用独立数据目录与 null 音频后端，不代表已验证真实设备音频输出。
- 扩展检查中的已有 `check-daily-view.js` 两条旧后端签名断言失败（`daily.rs` 未改动）；`check-folia-visual.js` 的独立参考站对照脚本缺少本地可 require 的 playwright 模块及参考站。本次 UI 验证使用已安装的 Playwright CLI。
