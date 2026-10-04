# iOS / macOS 皮肤改造

## Goal

在现有 `ios` 皮肤中落地 Folia 的语义层级与 iOS 控件规范，并采用 macOS 桌面应用的分栏密度。保持导航、播放器、主题接口和业务行为不变。用户已要求分析并完成优化，实施在当前会话进行。

## Architecture / Tech Stack

原生 CSS 覆盖 + 现有 Theme / Skins；无新增运行时依赖。`skin.ios.css` 拥有布局、形状、状态样式；`themes.js` 拥有颜色。普通右侧舞台属于应用布局；沉浸 3D 的独立主题继续保持独立。

## Baseline / Authority Refs

- 本项目 README、`docs/aegis/BASELINE-GOVERNANCE.md`、2026-09-30 skin-playback-review 记录。
- `plugin/ui/index.html`、`style.css`、`stage.css`、`skins/skins.js`、`themes.js`。
- 只读参考：`D:/code/github/folia-major/src/styles/ios.css`，以及 `src/components/app/ios/{IosRootLayout,IosTabBar,IosGroupedList,IosLargeTitleNavBar,IosNowPlayingPage}.tsx`。
- 当前无 baseline/ 快照，以上源码及现有工程文档提供基线。ArchitectureReviewRequired: yes（皮肤覆盖跨多个视觉表面，完成前检查边界）。

## 对照分析与实施决定

| 维度 | Folia 参考实现 | 当前 Hertz iOS 问题 | 本次落地 |
| --- | --- | --- | --- |
| 布局 | 内容 + Tab Bar 的正常文档流，单个内容滚动区 | 固定舞台脱流但残留三列；空闲时单列规则又把仍在流内的 rail 当内容 | 桌面 184px 侧栏 + 弹性内容 + 320px 播放面板；空闲移除第三列；平板沿用抽屉；手机横排现有入口，空间不足时横向滚动 |
| macOS 参照 | Folia 的 iOS 是移动布局，未发现单独的 macOS 皮肤 | 桌面只是放大移动圆角，没有工具栏密度与分栏关系 | 引入 macOS 风格侧栏、紧凑工具栏、分段控件和分层背景；不模拟系统红黄绿窗口按钮 |
| 配色 | label/bg/fill/separator 语义令牌，浅色加深蓝、深色提亮文字 | 有浅色主题，但激活导航是橙、主操作蓝、辅助紫；原生控件未指定方案 | 保留主题唯一所有者；iOS 浅色统一蓝色功能强调，保留红绿橙状态色；皮肤消费主题，显式浅/深 color-scheme |
| 圆角与投影 | 分组/控件/浮层分档；仅浮层较强阴影 | 大多数容器 26px，菜单也 26px；继承大面积玻璃黑影 | 控件 8–10px，分组/封面 12px，面板 16–20px；内容平面化，菜单/抽屉保留提升阴影 |
| 字体与间距 | 系统字体优先，清晰标题/正文/说明层级，44px 触控 | 继承混杂字体，标题 21px，多处微小字；行 padding 与固定 height 叠加 | 系统字体栈；28px 页标题、14px 正文、12px 说明；4/8/12/16/24 间距；桌面紧凑，触控至少 44px |
| 状态反馈 | aria-selected、disabled、active、focus-visible 与减弱动效 | rail 的 .is-on 与真实 .active 不匹配；部分禁用仍有 hover/缩放 | 对齐现有 .active / .is-on / aria 状态；统一焦点、按下、禁用；减少动效偏好生效 |
| 图标/资源 | Lucide 轮廓与填充播放图标，20–24px；真实封面 | Hertz 已有内联 SVG，以填充图标为主 | 复用已有 SVG/path、currentColor 与真实封面；统一尺寸和方圆角，不引入字体图标、图片或 SF Symbols 授权资源 |
| 适配 | safe-area 令牌、内容滚动、缩放封面 | 手机仍占左栏宽度；工具和播放栏多层堆积 | safe-area、dvh、窄屏折行、滚动区域、短屏检查、浅/深色反复切换 |

## Compatibility Boundary

不更改 DOM id、data-view、监听器、Skins/Theme 方法、持久化字段、播放器时钟、音源、API 或 Rust。保留工作区已有 `.github/workflows/ci.yml`、`skins.js`、`stage3d.js`、`check-skins.js` 修改。只调整 `skins.js` 中 iOS 说明文字以及 `check-skins.js` 中与本次结构有关的断言（如有需要）。不新增 macOS 主题入口。

## Tasks / Verification

1. 通过隔离 `VMUSIC_BACKEND=null` 实例和当前工作区资源建立 `scripts/check-ios-skin-browser.js`，先记录失败。覆盖实际导航、空闲/已载入曲目、宽屏栅格、小屏可达性、焦点、禁用、主题切换、滚动。
2. 重构 `plugin/ui/skins/skin.ios.css`：删除旧 fixed + padding-right 占位方案，使用正常网格；覆盖所有现有业务表面的样式。
3. 仅在 `themes.js` 的 ios-light 颜色表内统一强调色；必要时修正浅色表面 token。皮肤内禁止颜色字面量与重新定义主题主色。
4. 运行 `node scripts/check-skins.js`、`node scripts/check-ios-theme.js`、`node scripts/check-css-tokens.js`、`node scripts/check-stage-theme.js`、`node scripts/check-assets.js`，及浏览器矩阵和 `git diff --check`。
5. 查看浏览器截图并修复裁切、重叠或状态对比度；记录文件目的与结果。

## Risks / Retirement

CSS 特异性及 style.css/stage.css 既有规则是主要风险，通过计算样式和交互验证。废弃原 iOS 固定舞台及错误空闲单列规则；保持原 Skins 与 Theme 唯一所有者。无需新增 ADR。浏览器使用实际页面/业务代码和隔离后端，资源从工作区覆盖旧二进制内嵌资产；不据此声称发布二进制已重建或真实声卡已验收。
