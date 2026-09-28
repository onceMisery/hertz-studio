# folia 歌词模式移植设计（流光 classic / 心象 cadenza）

- 日期：2026-09-27
- 参考项目：`D:\code\github\folia-major`（React 18 + framer-motion 13 + TypeScript + Vite）
- 目标项目：hertz-studio（Rust 工作区 + 零构建零依赖 vanilla JS 静态前端，位于 `crates/vmusicd/web/`）
- 状态：待评审

## 1. 目标与范围

把 folia-major 的两种全屏歌词可视化模式高保真移植进 hertz-studio 的现有 3D 舞台，作为两个"聆听布局"项：

1. **流光 classic（Luminous）**：替换现有"星火歌词（spark）"布局；
2. **心象 cadenza（Mindscape）**：替换现有"心象歌词（scatter）"布局。

同时移植 folia common 背景体系（几何/流体/纯色三档）、底部字幕条、主题适配层、字号调节、逐模式调参面板与舞台内歌词偏移微调。

**相似度目标**：功能完整性、视觉一致性、交互体验与 folia 对应模式达到 95% 以上。验收口径见第 11 节。

### 1.1 明确不在本次范围

- **商籁 sonnet 模式：不做。** folia 的 sonnet 为 44 个文件、约 10,356 行 TypeScript，依赖 PixiJS 8、GLSL 滤镜、电影镜头调度引擎与 8 套主题变体。经确认分阶段实施：本 spec 仅覆盖流光与心象；sonnet 后续单独立项（届时再评估 vendor PixiJS / 引入构建链）。
- folia 的 AI 主题生成（generate-theme 服务）不做；
- folia 的 OBS 推流、多端同步、i18n、React 播放坞不做；
- `useLegacyLayout` 旧排版开关不暴露（固定使用新版语义排版）；
- 几何背景的 lucide 图标形状不做（数据来自 AI 主题的 lyricsIcons，hertz 无来源；圆/方/三角/十字四类构成截图主体观感）；
- 副歌涟漪（isChorus）：hertz 数据暂无副歌标记，渲染逻辑与 CSS 预留但不触发；
- 滚轮调节字号不做（避免与页面滚动冲突）。

### 1.2 集成形态（已确认）

嵌入现有全屏舞台，作为布局选择器中的两个选项。保留现有舞台外壳、播放坞、设置面板、时钟/seek、偏好持久化、封面取色与降级体系。选中流光/心象时：

- 隐藏并停止驱动多句 3D 歌词轨（`.s3d-reading`）与 GL 粒子/3D 画布层；
- 禁用拖拽旋转、滚轮缩放、巡航相机、双击复位；
- 挂载 folia 风格背景层、单行渲染器与底部字幕条；
- 播放坞、顶部 chrome、L 歌词开关、F 全屏、Esc 返回、设置面板、空格播放等全部保留；
- focus / sleeve / single 三个旧布局的代码路径与视觉完全不动。

### 1.3 技术路线（已确认）

**零依赖 vanilla JS 等价移植（方案 A）**：IIFE 模块 + 独立 CSS，沿用项目"全局命名空间 + `<script>` 顺序加载"约定。

- framer-motion 弹簧用实测等效 cubic-bezier / 关键帧复刻；
- 连续数值动画（心象 placement 插值、背景频段缩放、光束）注册到现有 `Stage.gate` rAF 门，不新增 requestAnimationFrame 循环；
- 心象文本排版自研精简排版器（canvas measureText + CJK 断行 + 词片放置），不 vendor `@chenglou/pretext`（887KB ESM、含 Unicode 数据，与零构建静态架构不兼容；歌词为短文本且以 CJK 为主，自研可控）；
- 不引入 Vite/React/ESM/importmap，不修改 Rust 静态服务与打包约定。

**开发方式（已确认）：不走 TDD。** 先实现功能，再编写检查/验证脚本与对比截图；不要求先写失败测试。

## 2. folia 源映射

| folia 源文件 | 移植到 |
|---|---|
| `visualizer/classic/Visualizer.tsx` | `folia/folia-classic.js` + `folia/folia.css` |
| `visualizer/cadenza/VisualizerCadenza.tsx`（约 1900 行） | `folia/folia-cadenza.js` + `folia/folia-textlayout.js` |
| `visualizer/runtime.ts` | `folia/folia-util.js`（active/recent/upcoming 行选择） |
| `utils/lyrics/renderHints.ts` | `folia/folia-util.js`（行转场分级，逐值复刻） |
| `utils/lyrics/graphemeTiming.ts` | `folia/folia-util.js`（词内字素时间分配） |
| `visualizer/colorMix.ts`、`visualizer/wordColoring.ts` | `folia/folia-theme.js` |
| `services/baseThemes.ts`（DEFAULT_THEME） | `folia/folia-theme.js` fallback 预设 |
| `utils/fontStacks.ts` | `folia/folia-theme.js`（字体栈字符串常量） |
| `visualizer/backgrounds/common/GeometricBackground.tsx` | `folia/folia-bg.js` |
| `visualizer/backgrounds/common/FluidBackground.tsx` | `folia/folia-bg.js` |
| `visualizer/backgrounds/common/entry.tsx` | `folia/folia-bg.js`（三档层叠） |
| `visualizer/VisualizerSubtitleOverlay.tsx` | `folia/folia-subtitle.js` |
| `utils/lyrics/cjkSemanticLayout.ts` | `folia/folia-textlayout.js` |

## 3. 模块划分

在 `crates/vmusicd/web/` 下新建 `folia/` 子目录（与 `vendor/` 同级）：

| 新文件 | 职责 |
|---|---|
| `folia/folia-util.js` | 秒/毫秒映射；行渲染提示分级；词内字素时间；确定性随机；缓动与一阶低通；颜色混合（hex/rgba） |
| `folia/folia-theme.js` | **Theme 适配层（唯一换算入口）**：hertz 封面取色/律动强度 → 冻结的内部 Theme；默认预设；字体栈；wordColor 匹配 |
| `folia/folia-textlayout.js` | canvas 测宽、CJK 语义拆词、贪心断行、词片放置、hero 选择、碰撞消解（心象专用） |
| `folia/folia-bg.js` | 背景三档：几何漂浮场 / 封面软焦流体 + 主题色压层 / 纯色；暗角；频段联动；暂停/eco 降级 |
| `folia/folia-subtitle.js` | 底部字幕条：翻译 → 最近完成句翻译 → 下两句预告；毛玻璃辉光底；进出场 |
| `folia/folia-classic.js` | 流光渲染器：单行、词三态、双层辉光、整行呼吸、行转场 |
| `folia/folia-cadenza.js` | 心象渲染器：placement 排版、DOM 文字层、canvas 光束层、rAF 插值 |
| `folia/folia.css` | 上述全部样式，命名空间统一前缀 `fl-`，不改动 stage3d.css |

修改文件：

- `index.html`：布局下拉项改名与 id 迁移；新增 `#s3d-folia` 背景/渲染/字幕容器与设置面板条件区块；按顺序引入 `folia.css` 与 7 个脚本；
- `stage3d.js`：布局 id 迁移、平面模式开关、偏好读写、渲染器挂载/销毁/驱动、偏移微调控件接线；
- `stage-control.js`：新增 `lyricOffset` 控制动作（transport 调 `PUT /v1/tracks/:id/lyrics/offset`，与普通播放页同接口）；
- `stage.js`：仅新增一个只读出口 `Stage.lyricTranslation(index)`（返回 `doc.translation[index]`），其余零改动。

## 4. 数据流与帧循环

### 4.1 单一事实来源

时间、行号、词时间轴、翻译、能量、封面、reduced 全部来自现有 Stage，渲染器不自行解析歌词文档、不自行二分时间轴：

```
音频时钟 Stage.position()（毫秒，本地插值）
   ├─ Stage.lyrics() → { lines, index }        行号直接复用
   ├─ Stage.lyricTokens(line) → [{text,start_ms,end_ms}]  现有词级时间轴（脏时长已有兜底）
   ├─ Stage.lyricTranslation(i) → string|null  新增只读出口
   ├─ Stage.energy() / Stage.spectrum()        背景/光束律动复用，不重算 FFT
   ├─ Stage.tier() / Stage.isLowFx()           eco 降级
   └─ Stage.presentation() → {track,cover,playing,reduced,position,duration}
         │
         ▼
 stage3d 现有每帧 update（不新增 rAF）
         ├─ classic：foliaClassic.update(data)，仅词状态翻转时改 class，过渡交 CSS
         ├─ cadenza：foliaCadenza.update(data)，placement 插值走 Stage.gate 注册门
         ├─ foliaBg 每帧吃 energy/spectrum
         └─ foliaSubtitle 跟随 active 行变化
```

渲染器内部统一把毫秒转秒与 folia 常量比较；seek 后所有状态以当前时间无动画重算（snap），不补放历史动画。

### 4.2 Theme 适配契约（冻结）

所有渲染器只认下列内部标准结构，folia→hertz 的换算只允许发生在 `folia-theme.js`：

```js
{
  backgroundColor,  // #rrggbb，必有；深色
  primaryColor,     // #rrggbb，必有；近白主字色
  secondaryColor,   // #rrggbb，必有；形状/次文本
  accentColor,      // #rrggbb，必有；点亮色
  wordColors: [{ word: string, color: string }], // 可为空数组
  animationIntensity: 'calm' | 'normal' | 'chaotic',
  fontStyle: 'sans' | 'serif' | 'mono'
}
```

换算规则：

1. 背景色：无取色源或源色近中性（饱和度 <20%，如默认白/灰 accent）时用 P2 默认；取色成功且为有彩色时，为胜出色相的极暗版本（S×0.5，L 8%）；
2. accentColor：读取 stage.js 写入的 `--music-highlight`（实际为 `hsl(H S% L%)` 字符串）或其 `--music-highlight-rgb` 三元组（适配层 readSourceHsl 支持 hex/hsl/rgb/三元组，畸形安全回退）；输出 S 钳 55–80%、L 钳 55–65% 的中高亮色；近中性源不注入彩色，保留 P2 白色 accent；
3. primaryColor 固定 `#f4f4f5`；secondaryColor 为同色相低饱（S×0.28）中亮（L 42%）色；
4. wordColors 默认空数组（点亮色恒为 accentColor，等同 folia 默认行为）；
5. animationIntensity 映射现有律动强度滑杆：reactivity < 0.7 → calm；> 1.6 → chaotic；其间 normal；
6. 取色异步完成后整体重着色一次（Stage.retint 风格），渲染器不轮询。

**默认预设（已确认 P2：folia 源码原版 Midnight Default）**：

```js
{ name: 'Midnight Default',
  backgroundColor: '#09090b', // zinc-950
  primaryColor:   '#f4f4f5', // zinc-100
  accentColor:    '#f4f4f5', // zinc-100
  secondaryColor: '#71717a', // zinc-500
  fontStyle: 'sans', animationIntensity: 'normal' }
```

字体栈（sans，不 vendor 字体文件）：

```
"Inter","Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif
```

字重：流光 700（主题无 fontWeight 时）；行高 1.22。

### 4.3 偏好与迁移

经现有 `preferences()`/`configure()` 通道（`stage:control` 事件持久化）：

- 布局 id 迁移：恢复偏好时 `spark → classic`、`scatter → cadenza`，一次性映射并回写；旧值 `focus/sleeve/single` 不变；
- 沿用现有：`layout / lyricSize(0.70–1.50) / lyricGlow / lyrics(显隐) / scene / motion / bloom / reactivity / cruise`；
- 新增键：
  - `foliaBg`: `'geometric' | 'fluid' | 'solid'`（默认 `'geometric'`）
  - `foliaBgOpacity`: number 0–1（默认 0.75，仅 fluid 生效）
  - `foliaVignette`: boolean（默认 true）
  - `foliaSubtitle`: boolean（默认 true）
  - `classicTuning`: `{ rotation: boolean=true, breathing: number=1, spacing: number=0.7 }`
  - `cadenzaTuning`: `{ width: number=0.72, motion: number=1, glow: number=1, beam: number=0 }`
- 歌词偏移为每曲持久化（服务端，复用现有接口与 `doc.user_offset_ms`），不属于本机舞台偏好。

## 5. 共享时间轴规则

移植 `buildLineRenderHints`，按行原始时长（endTime−startTime，秒）分三档，快歌自动加快转场：

| 档位 | 行时长 | 行转场模式 | 词显现模式 |
|---|---|---|---|
| normal | ≥ 0.18s | normal | normal |
| short | 0.10–0.18s | fast | fast |
| micro | < 0.10s | none | instant；行保底显示 67ms |

常量（逐值复刻 renderHints.ts）：

- 阈值：MICRO 0.10s、SHORT 0.18s、MICRO 保底 0.067s；
- normal 行进入：clamp(rawDur×0.34, 0.22, 0.42)s；退出：clamp(rawDur×0.18, 0.18, 0.32)s；唱完保持 0.06s；
- fast 行进入：clamp(rawDur×0.45, 0.045, 0.06)s；退出：clamp(rawDur×0.22, 0.03, 0.04)s；保持 0.03s；
- renderEndTime 按 folia 公式（passStart/exitStart 取最大，再补 exitDuration），下一行提前开始时允许截断余韵；
- 词 lookahead：normal 0.15s / fast 0.08s / instant 0.03s；
- 词 activeEnd：normal=word.endTime；fast=min(lineEnd, max(wordEnd, start+0.12))；instant=lineRenderEnd；
- 词显现最小时长：normal 0.10 / fast 0.12 / instant 0.08。

字素时间（`buildWordGraphemeTimings`）：多字词把词时长按字素权重再分配，辉光逐字错峰；单字词走整体脉冲。

确定性随机：`fract(Math.sin(seed) * 10000)`，seed = 行起始时间 + 词序号；seek/重渲染不换样。

## 6. 流光（classic）行为规格

### 6.1 画面结构

垂直居中单行：容器高 70vh、宽 100%、max-width 1152px（max-w-6xl）、padding 32px、flex-wrap；不渲染其他行；下方为独立字幕条。空状态（无 active 行）显示等待文案，字号 `clamp(1.5rem,3.5vw,2.25rem)`、secondaryColor、opacity 0.5。

### 6.2 词三态状态机

JS 仅在状态翻转时切换 class，过渡全部由 CSS 承担。

| 状态 | 触发 | 主体层 body | 布局层 layout |
|---|---|---|---|
| waiting | t < start − lookahead | 基础色 primaryColor，blur(10px)，400ms | opacity 0；scale 0.5；x = cfg.x + sin(cfg.y)·100；y = cfg.y + cos(cfg.x)·50；旋转 cfg.rotate+20（关闭旋转时 0） |
| active | [start−lookahead, activeEnd] | 激活色，去模糊；颜色按词时长**线性**过渡；去模糊 200ms（fast 120 / instant 80） | opacity 1；scale = cfg.scale×1.4；x/y 回 cfg；旋转回 cfg；弹簧 stiffness 200/damping 20 → CSS 等效 `cubic-bezier(.34,1.56,.64,1)`，约 450ms |
| passed | t > activeEnd | 回基础色：normal 800ms / fast 240ms / instant 120ms | opacity 0.82（chaotic 0.9）；scale 回 cfg.scale；旋转 cfg.rotate + cfg.passedRotate；旋转 5s 线性缓漂 |

### 6.3 双层文字与辉光

每词两个叠层：

- 辉光层：透明字（color:transparent），绝对定位铺满，仅 text-shadow；
- 主体层：真实颜色，z-10。

辉光 active 关键帧（normal）：`none → 0 0 20px 色, 0 0 40px 色（30% 处峰值）→ 0 0 20px/40px 收束（100%）`，时长 = 词时长，times [0, 0.9, 1]（单字）；

- fast：阴影 18/32px，时长 clamp(max(dur,.12), .2)，times [0,.4,1]；
- instant：14/24px，时长 min(dur,.12)，times [0,.35,1]；
- 多字词：单字时长 = dur/total，delay 取字素真实 startTime − 词 startTime（无真实字素时间时均摊），时长×6、times [0,.3,1]；
- passed：text-shadow 收 none，normal 900ms / fast 220ms / instant 120ms。

### 6.4 整行呼吸与行转场

- 呼吸（breathingFloatMultiplier，0–2，默认 1；0 关闭）：
  - calm：幅度 10px / 8.5s；normal：14px / 7s；chaotic：18px / 5.8s；
  - y 关键帧 `[0,−D,0,+0.45D,0]`，scale `[1,1+.01m,1,1−.005m,1]`，easeInOut 无限循环；
- 行容器转场（normal）：进 opacity 0→1 / scale .9→1 / blur 10→0；出 opacity 1→0 / scale 1→1.1 / blur 0→20px，300ms；
- fast：进 opacity .35/scale .96/blur 4px，160ms；出 scale 1.04/blur 10px，160ms；
- none：进出仅 120ms 快速淡出（scale 1.02、blur 6px）。

### 6.5 词布局配置

每行按 seed 重算一次（依赖 activeLine/排版词表/调参/主题/字号/视口宽）：

- animationIntensity：chaotic 散布 60、旋转 ±30、词 scale 0.8–1.4、透视 500 + seed%500、align 随机；normal 散布 20、旋转 ±5、scale 1.1–1.3；calm 零散布零旋转；
- 容器 justify（start/center/end/around/between）与 align（start/center/end）由 seed 决定；calm 固定居中；
- 随机函数 `fract(sin(wordSeed+offset)*10000)`，wordSeed = 行startTime + i；
- enableWordRotation（默认开）：关闭时 waiting/active/passed 全部旋转归零；
- 词间距（wordSpacing 默认 0.7，新版排版固定启用）：canvas 测宽后，marginRight = max(
  (chaotic 0.08 : 0.12)·fontPx·spacing,
  (本词放大溢出一半 + 下一词溢出一半 + 相邻 x 差 + 0.05·fontPx)·spacing
  )；防止词放大时重叠；
- 间奏行（hertz 空句 `· · ·` 对应 folia `......`）：居中、scale 1.5、marginRight 3rem、仅轻微纵向随机；
- 副歌涟漪：isChorus active 词中心描边圆环 scale .2→(1.5+rand·2)、0.5s 淡出。预留不触发。

### 6.6 字号

`clamp(2.25rem·fs, 6vw·fs, 4.5rem·fs)`，fs = 全局 lyricSize。等待文案与字幕字号见 6.1 与第 8 节。

## 7. 心象（cadenza）行为规格

### 7.1 画面结构

当前行 + 预热下一行；同一 placement 数据镜像到 DOM 文字层与全屏 canvas 光束层。DOM 层 absolute inset-0，canvas 同尺寸对齐。

### 7.2 排版管线（folia-textlayout.js）

1. 取 active 行词表（复用 Stage.lyricTokens；CJK 语义单元带粘性、拉丁按空格成词），canvas 按主题字体/字号测宽；
2. 最大宽度 = 容器宽 × widthRatio（默认 0.72），贪心断行；词可拆为跨线碎片，记录 fragment 在词内字素起止与碎片序号；
3. 每个 placement：x/y/width/height/rotate/scale、entryOffsetX/Y、passedRotate、passedDriftX/Y、emphasis、isInterlude；
4. hero 强调词：语义权重（CJK 0.18；拉丁 min(字素数×.08, .36)）+ 居中偏置×.18 打分；得分加成 1 + clamp(heroScore−.48, 0, .52)，即 1.0–1.52；hero 尺寸更大、优先占位；
5. 碰撞消解：碰撞带宽 max(24, lineHeight×.9)，逐词推开；行奇偶纵向 ±0.65 偏置；与 hero 最小间距 = hero 宽×.34 + 词宽×.52 + padding×2；
6. 字号：clamp(容器宽×.086, 34, 94)px 为基准；超 12 字素行缩放至 clamp(.92−(n−12)×.018, .62, .92)；再乘 cadenza fontScale 1.12 与全局 lyricSize；
7. passedRotate：±12°（chaotic ±20°）；进场步长 max(10, fontPx×.14) 错峰；纵向偏好步长 max(lineHeight×2.2, 碰撞宽×.75, 56)；
8. 下一行在预热窗口内 prepare 并缓存（normal 预热 2 行，eco 降为 1 行），切换不卡帧；尺寸/主题/调参变化时作废重排。

### 7.3 放置三态（rAF 插值，走 Stage.gate）

- 进场：opacity .65→1、scale .97→1（fast .9→1）；preEnter ≤ .1·enterDuration，错峰；y 从 entryOffset 归位；
- active：激活色线性染色；辉光 text-shadow 三层 40px（alpha .98 / .92 / .35 乘 glowIntensity，钳 1.6）：
  - 拉起：前 14%（fast）/18%（normal）easeOutCubic；
  - 平台：到 82%/90% 保持，尾段收到 .92/.9；
  - 唱完：按 (t−end)/.14（fast）或 .9（normal）二次衰减；
- passed：opacity 收至 .9·(1−fade)²（normal fade .9s / fast .12s）；scale 收 .9–.92；rotation 缓漂 ±12/±20°；沿 passedDrift 漂移；
- emphasis：hero 的 scale/辉光增量逐帧补间，变化阈值 0.001，禁止瞬变；
- motionAmount 统一缩放所有位移/漂移/旋转幅度。

### 7.4 canvas 光束层

- beamIntensity 默认 0（默认关闭，与 folia 一致），范围 0–1.2；
- 开启时对每个 placement 在 y + height×.78 处画胶囊形水平光条：高 = max(2, h×(.05 + energy×.03)×max(intensity,.12))；横向线性渐变；两端圆角半径 = 高/2（drawRoundedRect + 两端 arc）；
- energy 取 Stage.energy()，与 DOM 层同坐标对齐；resize/重排在 ResizeObserver 回调里重测；
- reduced/eco：光束静止或降帧（eco 分辨率 ×.75）。

## 8. 底部字幕条

两模式共用，锚在播放坞 `.s3d-player` 顶缘上方安全区（绝对定位、左右居中、z-20、pointer-events:none）。

内容优先级：

1. active 行的翻译（`Stage.lyricTranslation(index)`）；
2. 无 active 行时，最近完成行（currentTime 超过其 renderEndTime 的最后一行）的翻译；
3. 都无翻译时，预告接下来两行原文（active 存在时取其后两行；无 active 时取未来前两行）；
4. 过滤不含任何字母/数字（含 CJK，正则 `/[\p{L}\p{N}]/u`）的占位符行（`//`、`●●●`、短横线等）；

- 容器进出场：opacity + translateY 20px，240ms easeOut；换句内容 y 10px 轻换；
- 毛玻璃辉光底（默认开）：径向 `backgroundColor` 渐变（中心 .96 → 62% .78 → 透明），外层 blur 24px；可整体关闭；
- 翻译字号 `clamp(1.125rem·fs, 2.6vw·fs, 1.25rem·fs)`，字重 500，secondaryColor；
- 预告字号 `clamp(.875rem·fs, 2vw·fs, 1rem·fs)`，默认 blur(1px)，窄屏只显示 1 行；
- 总开关 foliaSubtitle（默认开）；无翻译的本地歌只显示预告。

## 9. 背景三档（folia-bg.js）

层叠：底色层 →（fluid 时）封面软焦层 + 主题色压层 →（geometric 时）形状/粒子层 → 暗角层。切档/切歌交叉淡入 600–1000ms。

### 9.1 geometric（默认）

- 15 个形状：类型圆/方/三角/十字按种子随机；30% 实心（填充 secondaryColor），其余 1px 描边；尺寸 40–140px；位置全屏随机；opacity .11–.19；初始旋转 0–360°；
- 形状：三角 clip-path `polygon(50% 0,0 100%,100% 100%)`；十字 `polygon(20% 0,0 20%,30% 50%,0 80%,20% 100%,50% 70%,80% 100%,100% 80%,70% 50%,100% 20%,80% 0,50% 30%)`；圆 borderRadius 50%；
- CSS 关键帧：y ±30px、x ∓15px 往返，旋转 0→360° 线性循环；时长 30–60s（形状），延迟 0–5s，半数反向；
- 频段联动：圆=bass、方=lowMid、三角=mid、十字=treble；gate 内一阶低通（等效 spring stiffness 300/damping 30）后映射 scale .95–1.45；scale 写在外层包裹元素，旋转/位移动画在内层，避免属性冲突；
- 20 个上升粒子：1–5px 圆点（accentColor），随机位置、opacity ≤.3，y 0→−100px 淡出，15–35s，延迟 0–10s；
- 暗角：`radial-gradient(circle, transparent 40%, rgba(0,0,0,.6) 100%)`，独立开关（默认开）；
- 暂停：冻结为静态场（移除无限动画，保留初始姿态）；eco：形状 8 个、粒子 10 个。

### 9.2 fluid

- 封面软焦：封面图 object-cover 铺满，显示层 blur(40px) scale(1.5)；模糊源先在离屏 canvas 降采样到长边 384px（JPEG 0.82），避免大封面 GPU 分块闪烁；
- 切歌双层交叉淡化：透明度动画在外层 wrapper，blur 层只光栅化一次；
- 上方压主题背景色层，不透明度 = foliaBgOpacity（默认 .75，滑杆 0–1）；
- 跨域封面导致 canvas tainted 时回退原图 URL + CSS blur；
- 形状层关闭，暗角保留；整体随 energy 轻微呼吸 scale 1.0–1.03；
- 降级：iOS 软焦路径为已知 WebKit 问题的特殊处理（多次离屏 drawImage 柔焦），本项目目标运行环境为桌面/安卓浏览器，**不移植 iOS 专用分支**，统一走 384px 降采样路径。

### 9.3 solid

仅主题背景色；无形状/粒子/封面层；暗角保留开关；零持续渲染开销。

## 10. 设置面板、响应式、降级与交互

### 10.1 设置面板（嵌入 #s3d-settings）

布局选择器更新为：`沉浸歌词(focus) / 心象(cadenza) / 流光(classic) / 封面与歌词(sleeve) / 简洁单句(single)`。

| 控件 | 出现条件 | 规格 |
|---|---|---|
| 歌词字号 | 始终 | 滑杆 0.70–1.50，步进 .05（现有 lyricSize） |
| 背景样式 | classic/cadenza | 三段分段开关：几何/流体/纯色 |
| 暗角 | classic/cadenza | 开关，默认开 |
| 封面底色浓度 | 仅 fluid | 滑杆 0–1，步进 .05，默认 .75 |
| 字幕条 | classic/cadenza | 开关，默认开 |
| 歌词偏移 | classic/cadenza | `−0.1s` `[+0.0s]` `+0.1s`，范围 ±60s，即时 PUT，每曲持久化 |
| 词旋转 | 仅 classic | 开关，默认开 |
| 呼吸幅度 | 仅 classic | 滑杆 0–2，步进 .05，默认 1 |
| 词间距 | 仅 classic | 滑杆 0–2，步进 .05，默认 .7 |
| 排版宽度 | 仅 cadenza | 滑杆 .5–.9，步进 .02，默认 .72 |
| 动效量 | 仅 cadenza | 滑杆 0–2，步进 .05，默认 1 |
| 辉光强度 | 仅 cadenza | 滑杆 0–1.6，步进 .05，默认 1 |
| 光束强度 | 仅 cadenza | 滑杆 0–1.2，步进 .05，默认 0 |

既有律动强度/镜头动态/光晕强度保留；classic/cadenza 下镜头动态置灰禁用。样式沿用 `.s3d-settings` 深玻璃卡片风格，不引入 folia 圆角卡片体系。所有控件即时生效；本机项走 savePreferences，偏移走服务端接口。

### 10.2 响应式

沿用项目现有 760px 主断点，字号/宽度全部 clamp 无级缩放：

- ≥760px：歌词区 70vh、max-w-1152、padding 32px；心象排版宽 72%；
- <760px：流光散布量 ×.6、active scale 1.4→1.28、padding 16px；心象 widthRatio .88、hero 尺寸上限 −15%、canvas DPR 钳 1.5；字幕条左右 32px 边距、预告 1 行；
- <380px：形状 15→6、关闭上升粒子；
- 横屏矮窗（高 <500px）：歌词容器 70vh→58vh，字幕条与播放坞间距压缩；
- 所有测量经 ResizeObserver，心象 canvas/DOM 在回调中重测对齐，手法与现有 stage-lyrics dirty 标记一致。

### 10.3 减少动态 / 暂停 / eco

- reduced（系统减少动态）：关闭整行呼吸、进场漂移/旋转、辉光脉冲、形状/粒子无限动画与光束运动；**保留逐词染色与行切换淡入淡出**；注意现有全局 `.s3d-reduced *{animation:none!important}` 会误伤染色动画，folia.css 中对染色相关属性改用 transition 或在 reduced 作用域内显式恢复所需时长；
- 暂停：循环动画冻结在当前帧，词染色保持，背景场静止；
- eco（Stage.tier()===0）：几何 8 形状/10 粒子、心象 canvas ×.75、预热 1 行、光束降帧。

### 10.4 交互

- 点击词/行 → seek(line.start_ms)：流光整行为不可见热区（容器 pointer-events:none，行可点）；心象点击 placement 命中区寻句；
- classic/cadenza 下滚轮/拖拽不操作相机；
- 键盘沿用：L 切歌词显隐、空格播放暂停、Esc 退出舞台、F 全屏；
- "回到当前句"式浏览在两个单行模式下不存在，不实现。

## 11. 测试与验收（实现后进行，非 TDD）

开发完成后再补齐验证资产，不作为先行红灯流程。

### 11.1 纯函数检查脚本 scripts/check-folia.js（沿用 check-*.js 惯例）

- renderHints：构造 .05/.15/.5s 行，断言 timingClass、进出场时长、renderEndTime 与 folia 同输入逐值一致；
- 字素时间：单字/多字词、脏时长（0ms、超长）断言起止；
- 排版器：长 CJK 断行不溢出、跨线碎片边界、hero 选中、AABB 无重叠、380px/1280px 两宽；
- wordColor：CJK 包含匹配、英文归一化、空色板回退 accent；
- Theme 适配：mock 胜出色相桶 → 背景 L≤10%、accent L∈55–65%、字段齐全。

### 11.2 视觉对比（Playwright，产物落 output/）

- folia-major 本地起 dev server（Node ≥24，`npm run dev`）；
- 自制夹具 LRC：normal/short/micro 三档行、间奏、超长句、中英混合；向两侧注入同一 mock 时钟固定 position；
- 矩阵：2 模式 × 3 背景档 × {正常段/快速说唱段} × {1440×900, 390×844}；
- 指标：pixelmatch 差异率 + SSIM（布局结构差异目标 <5%，SSIM ≥.95）；动效录像人工核对三态、呼吸、辉光、光束、行转场。

### 11.3 95% 相似度验收口径

- 可量化项（颜色值、字号 clamp、字重、三态时序常量、行转场常量、布局/背景参数、断点）：与 folia 源码 100% 同值；
- 动效手感项：SSIM ≥.95 且人工目检通过（实现者自检 + 用户确认）；
- 背景：形状/粒子数量、尺寸/透明度/时长区间、暗角渐变逐值一致。

### 11.4 交互与回归

- seek 后无补放、状态正确；五布局互切；刷新偏好恢复（含 spark/scatter 旧 id 迁移）；偏移按钮持久化；reduced 下无循环动画但保留染色；暂停冻结；切歌重着色；
- focus/sleeve/single 旧布局截对比图，视觉零变化。

### 11.5 性能

- 全页 rAF 循环数量不增加（复用 Stage.gate）；桌面 60fps、eco ≥30fps；
- 心象 DOM 节点仅 active + 预热行；连续切歌 20 次后 DOM 节点数与 canvas 数不增长；
- 流体背景只使用 ≤384px 降采样源；几何场纯 CSS 动画 + gate 低频写 scale。

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| framer-motion 弹簧手感差异 | 用 cubic-bezier(.34,1.56,.64,1) 对齐 stiffness200/damping20 的阶跃响应；以 SSIM/录像校准，必要时微调控制点 |
| 自研排版器与 pretext 断行差异 | 验收以"不溢出/不重叠/hero 观感"为准；CJK 短文本场景 pretext 高级特性（Unicode bidi/连字）用不上；夹具覆盖中英混排 |
| 全局 `.s3d-reduced *{animation:none}` 误伤染色 | 染色走 transition；reduced 作用域内显式声明保留的过渡时长 |
| 平面模式遗留 3D 手势监听 | 在 stage3d 手势入口统一以布局判定短路，并补交互回归用例 |
| 取色异步导致首帧闪色 | 先以 P2 默认主题渲染，取色完成后整体重着色；背景/文字同次切换 |
| 旧偏好 id 失效 | configure 迁移 spark→classic、scatter→cadenza 并回写 |
