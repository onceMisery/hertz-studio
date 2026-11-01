# Design System: Hertz Desktop（桌面歌词与壁纸设置中心）

> 本文件是桌面组件 UI 的单一设计真值来源。适用范围：`crates/hertz-desktop/assets/`
> 下的设置中心与壁纸/歌词页面。生成于 stitch-design-taste 契约，经 unslop 审计校准。

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
  警示文案 `#eadba9`（底 `#322c1d` 边 `#75663e`）
- 禁止：纯黑 `#000000`、紫蓝渐变、霓虹辉光、彩色阴影、跨色相渐变、
  玻璃卡内高光。深度只来自 surface 台阶与发丝线。

## 3. Typography Rules

- **UI 栈**：`"Segoe UI","Microsoft YaHei UI",sans-serif` — Windows 11
  平台原生即本产品的品牌字体（刻意豁免 stitch 的 Inter/Geist 禁令：
  桌面组件零字体捆绑成本，且系统一致性优先）
- **Mono**：`Consolas` / `Cascadia Mono`（Win11 原生）— 路径、诊断、时间戳
- **刻度**：23（h1）/ 14（h2）/ 13（正文与控件）/ 12（次级说明/状态）/ 11（small）
- **权重**：400 正文、500 次强调、600 仅 h1/h2/主按钮；不用 700+
- 标题层级靠字号 + 颜色；小字号零负字距；数值一律 `tabular-nums`
- 禁止：Inter、衬线进工具 UI、斜体强调、全大写宽字距标签
  （`HERTZ / DESKTOP` 字标 eyebrow 为唯一保留例外）

## 4. Component Stylings

- **按钮**：平面无外辉光；6px 圆角、accent 实心主按钮（深字 `#24241f`）、
  描边次按钮；active `translateY(1px)` 触感；hover 只动 background/border
- **页签**：文字 + 2px 下划线选中态（accent 色），无药丸
- **字段**：标签在上（12px 次文本）、控件全宽、说明 small 在下；
  数字读出（`<output>`）`tabular-nums`
- **滑杆**：原生 track + `accent-color: var(--accent)`；不重造 thumb
- **状态灯**：6px 圆点；`running` 态唯一合法微脉冲（2.4s ease-out 外扩环，
  transform/opacity，`prefers-reduced-motion` 静止）；其余状态静止
- **场景卡**：左图（64×36，4px 圆角，真实场景帧 `/scene-thumbnails/`）+
  右名（13px）+ 序号元数据（10px muted）；选中 = accent 描边 + surface 台阶
- **状态片/徽标**：发丝边框 + 次文本的安静 chip（`#settings-state`），
  无辉光无药丸
- **空态**：`#preview-placeholder` 组合式引导（标题 + 一句怎么做），非 "无数据"

## 5. Layout Principles

- 应用壳满视口；工作区 `minmax(0,1fr) 300px` 双栏（预览列 + 属性栏）
- 分组节奏：组内 < 组间（字段 16px、节 20px、页签区 24px），全部 4px 栅格
- 页脚固定（状态行左、动作右）；主操作唯一（应用设置），次操作 ≤2
- 嵌套圆角：内 = 外 − padding，且 ≥4（卡片 8 · 控件 6 · 缩略 4）
- <800px 单列折叠、<420px 场景网格 2 列；文本不小于 11px

## 6. Motion & Interaction

- 只动 `transform`/`opacity`/color/background/border；一律具名 transition
  （`.15s` 反馈）；唯一 ease-out；按压 `translateY(1px)`
- 唯一常驻循环：running 状态灯外扩环（live 数据专属）
- `prefers-reduced-motion: reduce` → 全部静止

## 7. Anti-Patterns（Banned）

- 零 emoji；无 Inter/衬线；无纯黑 `#000000`；无霓虹/外辉光/彩色阴影
- 无紫蓝渐变与渐变文字；无 3×等宽模板卡片；无 "Scroll to explore" 类填充文案
- 无感叹号/句尾句号（短文案）；无未验证声明（"Loved by 10k teams" 类）
- 无悬停缩放/弹跳弹簧/视差；不重造滑杆 thumb；不改产品名与真实字标
