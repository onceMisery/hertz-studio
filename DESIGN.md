# Design System: Hertz Desktop（桌面歌词与壁纸设置中心）

> 本文件是桌面组件 UI 的单一设计真值来源。适用范围：`crates/hertz-desktop/assets/`
> 下的设置中心、桌面歌词、壁纸场景与小窗/桌宠页面。生成于 stitch-design-taste 契约，经 unslop 审计校准。

## 1. Visual Theme & Atmosphere

**Density 6 · Variance 4 · Motion 4**（桌面工具的「Daily App Balanced」：
信息密度高于营销页、低于驾驶舱；布局对称为主、以内容的不对称细节打破；
动效限于反馈与一个合法的 live 微脉冲）。

氛围：**深夜书桌上的仪器面板**——暖色石墨表面、发丝级分隔线、
一盏暖白 accent 灯。所有视觉 richness 集中在两处内容 moment：
歌词样例卡（产品自有的已唱/未唱描边渲染）与场景九宫格（真实场景帧）。
chrome（页签、按钮、字段、状态片）永远安静。

## 2. Color Palette & Roles

- **暖夜 Canvas**（`#141413`）— 页面底色（非纯黑；带 1° 暖偏）
- **抬升 Surface**（`#1c1c19`）— 页签栏、页脚
- **控件 Fill**（`#272723`）— 按钮/输入/下拉底色；hover `#36362f`
- **发丝线**（`#34342f`）— 1px 分隔；文本色 6–10% 透明度等价物
- **主文本**（`#eeeae1`）— 一级
- **次文本**（`#aaa79c`）— 标签、说明、元数据
- **强调 Accent**（`#dfdacb`，按下/hover 边 `#b1aa95`）— 唯一 accent：
  主按钮、选中页签下划线、焦点环、选中卡片描边（`#b7ac8d`/`#343229`）
- **语义色**（降饱和入 palette）：live `#afc7a3`、错误 `#e5a395`、
  警示文案 `#eadba9`（底 `#322c1d` 边 `#75663e`）；
  错误红全家族统一 `#e5a395`（状态文字、删除按钮、invalid 字段边、状态灯 error）
- 禁止：纯黑 `#000000`、紫蓝渐变、霓虹辉光、彩色阴影、跨色相渐变、
  玻璃卡内高光。深度只来自 surface 台阶与发丝线。

### 三表面体系（Triple-Surface）

三个表面各有独立的可读性契约，共用同一签名与栅格：

- **仪器面板**（设置中心）：暖色石墨实面、暖白 accent `#dfdacb`——chrome 即界面
- **玻璃覆盖层**（桌面歌词）：中性玻璃（`rgba(14,16,20,.34)` + backdrop blur）
  悬浮于任意桌面背景之上；chrome 内的 accent 是**用户配置的已唱色**
  （`--lyric-sung`，默认 `#6fe3c2`）——richness 归内容（歌词本身），
  karaoke 辉光与环境光一律 `color-mix` 绑定该变量，随用户换色而换色
- **悬浮小窗**（mini-player/桌宠）：暖石墨胶囊（深 `rgba(28,28,25,.96)` /
  浅暖纸 `rgba(246,243,236,.98)`），与仪器面板同族而非中性灰；
  功能 accent（进度、焦点环、贴边残条）与玻璃覆盖层同规——绑用户已唱色
  `--lyric-sung`（native 随 applyConfig 下发，白默认按主题落中性色）；
  宠物素材是**内容层**，颜色归素材（如同封面），不入 chrome 契约

## 3. Typography Rules

- **UI 栈**：`"Segoe UI","Microsoft YaHei UI",sans-serif` — Windows 11
  平台原生即本产品的品牌字体（刻意豁免 stitch 的 Inter/Geist 禁令：
  桌面组件零字体捆绑成本，且系统一致性优先）
- **Mono**：`Consolas` / `Cascadia Mono`（Win11 原生）— 路径、诊断、时间戳
- **刻度**：23（h1）/ 14（h2）/ 13（正文与控件）/ 12（次级说明/状态）/ 11（small）
- **权重**：400 正文、500 次强调、600 仅 h1/h2/主按钮；UI chrome 不用 700+
  （歌词内容的可配字重（700/800）是内容样式，不受此限）
- 标题层级靠字号 + 颜色；小字号零负字距；数值一律 `tabular-nums`
- 禁止：Inter、衬线进工具 UI、斜体强调、全大写宽字距标签
  （`HERTZ / DESKTOP` 字标 eyebrow 为唯一保留例外）

## 4. Component Stylings

- **按钮**：平面无外辉光；6px 圆角、accent 实心主按钮（深字 `#24241f`）、
  描边次按钮；active `translateY(1px)` 触感；hover 只动 background/border
  （主按钮 hover 保持 accent 底、边 `#b1aa95`，不被通用 hover 灰底压过）；
  禁用主按钮退回控件 Fill + 次文本色——禁用态也要安静，不用压暗的 accent 抢眼
- **页签**：文字 + 2px 下划线选中态（accent 色），无药丸
- **字段**：标签在上（12px 次文本）、控件全宽、说明 small 在下；
  数字读出（`<output>`）`tabular-nums`；受约束数值字段 invalid 时边 `#e5a395`
  并带 `aria-invalid`，错误不只在页脚状态行
- **滑杆**：原生 track + `accent-color: var(--accent)`；不重造 thumb
- **状态灯**：6px 圆点；`running` 态唯一合法微脉冲（2.4s ease-out 外扩环，
  transform/opacity，`prefers-reduced-motion` 静止）；其余状态静止
- **场景卡**：左图（64×36，4px 圆角，真实场景帧 `/scene-thumbnails/`）+
  右名（13px）+ 序号元数据（10px muted）；选中 = accent 描边 + surface 台阶
- **状态片/徽标**：发丝边框 + 次文本的安静 chip（`#settings-state`），
  无辉光无药丸
- **图标**：一律绘制 SVG（1.5 圆头描边或实心，随所在控件体系），
  不用 Unicode 字形/emoji 顶图标
- **空态**：`#preview-placeholder` 组合式引导（标题 + 一句怎么做），非 "无数据"

## 5. Layout Principles

- 应用壳满视口；工作区 `minmax(0,1fr) 300px` 双栏（预览列 + 属性栏）
- 分组节奏：组内 < 组间（字段 16px、节 20px、页签区 24px），全部 4px 栅格
- 页脚固定（状态行左、动作右）；主操作唯一（应用设置），次操作 ≤2
- 嵌套圆角：内 = 外 − padding，且 ≥4（卡片 8 · 控件 6 · 缩略 4）
- <800px 单列折叠、<420px 场景网格 2 列；正文与控件文本不小于 11px，
  10px 仅限非必要元数据（场景卡序号、`HERTZ / DESKTOP` 字标）

## 6. Motion & Interaction

- 只动 `transform`/`opacity`/color/background/border；一律具名 transition
  （`.15s` 反馈；悬浮层——歌词/小窗——用 `160ms cubic-bezier(.22,1,.36,1)`）；
  唯一 ease-out；按压 `translateY(1px)`
- 唯一常驻循环：running 状态灯外扩环（live 数据专属）
- `prefers-reduced-motion: reduce` → 界面动效全部静止；
  壁纸场景的运动强度是用户配置（`motion`），不受 reduced-motion 约束，
  指针水波受约束

## 7. Anti-Patterns（Banned）

- 零 emoji；无 Inter/衬线；无纯黑 `#000000`；无霓虹/外辉光/彩色阴影
- 无紫蓝渐变与渐变文字；无 3×等宽模板卡片；无 "Scroll to explore" 类填充文案
- 无感叹号/句尾句号（短文案）；无未验证声明（"Loved by 10k teams" 类）
- 无悬停缩放/弹跳弹簧/视差；不重造滑杆 thumb；不改产品名与真实字标
