# 第 14 项首期：离线提示词生成舞台

- Goal：在创意工坊的“高级编排”中加入“一句话生成舞台”，让用户输入受支持的中文或英文描述，先看到可解释的匹配结果，再一次性应用到当前创意舞台；全程离线、确定性、可撤销。
- Architecture：新增纯前端 `CreativePrompt` 规则编译器，负责“文本 -> StageIntent”；`CreativeStage` 新增原子 `applyIntent`，继续独占场景默认值、参数白名单、钳位、预置持久化和渲染写入；`Workshop` 只负责输入、结果说明、应用与撤销。
- Tech Stack：原生 JavaScript / CSS；现有 `CreativeStage`、`Workshop`、内嵌静态资源与 Node 契约脚本。不新增 npm、Rust crate、模型、网络 API 或数据库表。
- Baseline/Authority Refs：`docs/aegis/plans/2026-09-26-prioritized-completion.md` 第 14 项；`创意功能方案.md` S9；`creative-stage.js` 的扁平参数表、`normalize`、`setPreset`、预置库；`workshop.js` 的高级编排页签；`main.rs` 的单 exe 资源内嵌；`BASELINE-GOVERNANCE.md`。
- Compatibility Boundary：保留当前预置 JSON `version: 1`、场景 id、参数路径、导入导出与 40 条预置库；不改变播放、频谱、WebSocket、SQLite 或沉浸声场 `Stage3D`；旧浏览器若缺少 `String.prototype.normalize` 仍可使用；未知词不猜测、不联网、不写入舞台。
- Verification：`node scripts/check-creative-prompt.js`、`node scripts/check-creative.js`、`node scripts/check-assets.js`、`node scripts/check-css-tokens.js`、`cargo build -p vmusicd`，以及桌面和 320px 手机宽度的真实浏览器交互。
- ArchitectureReviewRequired：yes。新增一个编译所有者和一个跨模块意图契约，但不新增舞台状态所有者。

## 1. 方案结论

第 14 项原文同时列出旋律轨迹、提示词预置、录制回放和 DBX 插件。四者不应放进同一实现批次：

| 候选 | 能复用的现有能力 | 新增边界 | 首期判断 |
| --- | --- | --- | --- |
| 离线提示词预置 | 参数表、预置、工坊、导入导出、WebGL 场景 | 一个纯规则编译器、一个意图写入口 | **本方案实施** |
| 旋律轨迹 | Stage 帧门、频谱、WebGL | 基频估计、实时/离线分析协议、缓存与新场景 | 独立立项 |
| 录制回放 | 舞台渲染、播放时钟 | 音视频捕获、编码、权限、文件生命周期 | 独立立项 |
| DBX 插件 | 单 exe 与同一套 UI | 宿主 ABI、sidecar 生命周期、端口发现、打包签名 | 等宿主规格后立项 |

第一性原则结论：首个交付必须让用户获得新的创作入口，同时不能建立第二份舞台 schema。最小充分路径是规则编译器生成 `StageIntent`，由 `CreativeStage` 将意图转换成现有预置。它比直接生成完整 JSON 更稳，因为场景默认值、参数范围和未来 schema 演进仍只有一个权威。

## 2. 用户流程与验收口径

高级编排增加首个页签“一句成景”。默认不自动修改舞台。

1. 用户输入不超过 120 个字符的描述，或点击一个示例短语。
2. 点击“解析”后，界面显示识别出的场景、氛围、镜头、质感和音乐响应，并单列未识别片段与冲突警告。
3. 点击“应用到当前舞台”后，一次性更新当前预置；场景、参数、导演和手绘层不能出现半应用状态。
4. 应用后显示“撤销本次应用”。撤销恢复应用前的完整预置，包括名称、cue、binding、背景和手绘设置。
5. 用户可继续手调、存进工坊或导出 JSON；生成结果不引入新预置格式。

必须验收的例子：

| 输入 | 必须得到的意图 |
| --- | --- |
| `梦幻星云，缓慢镜头，霓虹，跟随音乐` | `scene=nebula`；低镜头漂移；`look.grade=3`；`director=true` |
| `高速隧道，强烈节拍，近景，不要颗粒` | `scene=tunnel`；高运动/抖动/低频跟随；较近机位；`look.grain=0` |
| `歌词走廊，安静，单色，固定镜头` | `scene=lyric`；低运动；`look.grade=2`；`director=false` |
| `手绘地形，远景，不要抖动` | `scene=terrain`；`hand.on=true`；远机位；`cam.shake=0` |
| `星云 隧道` | 最后出现的明确场景 `tunnel` 生效，并返回场景冲突警告 |
| `赛博朋克蓝色海底` | 只应用确实支持的词；其余内容显示为未识别，不虚构蓝色色板或海底场景 |
| 空白或纯标点 | `ok=false`，不改变当前预置 |

## 3. 所有权与数据流

```text
Workshop 输入
    -> CreativePrompt.compile(text)
        -> StageIntent + matches + unknown + warnings
    -> 用户确认
    -> CreativeStage.applyIntent(intent)
        -> 复制当前 preset
        -> 若切场景，填充该场景默认值和入画机位
        -> 应用白名单参数 / director / hand
        -> normalize + resolve + 持久化 + 单次 preset 事件
    -> Workshop 保存 before 快照，提供一次撤销
```

### 3.1 唯一所有者

| 数据/行为 | 唯一所有者 | 禁止事项 |
| --- | --- | --- |
| 词典、优先级、否定与组合规则 | `creative-prompt.js` | 不放进 `workshop.js` 或渲染器 |
| 参数路径、范围、场景默认值、写入 | `creative-stage.js` | 编译器不复制 `BASE_SPEC` / `SCENE_SPEC` |
| 输入、解释、确认、撤销 UI | `workshop.js` | UI 不直接逐项 `setParam` |
| 视觉样式 | `creative.css` | 不新增内联 style |
| 静态资源内嵌与加载顺序 | `main.rs` / `index.html` | 不从 CDN 加载脚本 |

### 3.2 `StageIntent` 契约

编译器只返回下面这个窄协议，不返回完整 preset：

```js
{
  version: 1,
  scene: 'nebula',              // 可省略；必须是 CreativeStage.scenes() 中的 id
  patch: {                      // 可省略；key 必须存在于 CreativeStage.spec()
    'cam.drift': 18,
    'cam.shake': 25,
    'look.bloom': 1.35,
    'look.grade': 3
  },
  director: true,               // 可省略
  hand: { on: false },          // 可省略；首期只控制 on
  ruleIds: ['scene.nebula', 'motion.slow', 'look.neon', 'director.follow']
}
```

`CreativePrompt.compile(text)` 返回：

```js
{
  ok: true,
  normalized: '梦幻星云 缓慢镜头 霓虹 跟随音乐',
  intent: { /* StageIntent */ },
  matches: [
    { ruleId: 'scene.nebula', label: '星云', source: '星云', group: 'scene' }
  ],
  unknown: [],
  warnings: []
}
```

失败只允许两类：`empty`（没有有效文本）和 `no_match`（一个支持词都没命中）。两类都返回 `ok:false`，不得抛异常或生成默认舞台。

## 4. 确定性编译规则

### 4.1 归一化

1. 字符串截断到 120 个 Unicode code point；UI 同时设置 `maxlength=120`。
2. 若存在 `String.prototype.normalize`，执行 `NFKC`；否则原样继续。
3. 转小写，将中英文逗号、句号、斜杠、连字符等标点统一为空格，合并连续空白。
4. 英文按词边界匹配；中文按词典短语匹配。规则按别名长度降序扫描，避免 `安静` 抢先命中 `安静镜头`。
5. 每个命中区间只归属于一个规则；同一 rule 多次命中只应用一次，但 `matches` 保留各命中位置用于解释。
6. 将命中区间替换为空格后，再删除停用词 `的/一个/一种/和/与/还有/请/要/想要/风格/舞台/the/a/an/and/with`；剩余连续片段去重后进入 `unknown`。若没有任何规则命中，整段归一化文本进入 `unknown` 并返回 `no_match`。

### 4.2 规则分组

首期词典严格限制在现有舞台能表达的语义：

| 分组 | 规则 id 与别名示例 | 输出 |
| --- | --- | --- |
| 场景 | `scene.towers` 柱阵/城市；`scene.orb` 星球/球体；`scene.tunnel` 隧道/穿梭；`scene.nebula` 星云/梦幻；`scene.terrain` 地形/山脉；`scene.lyric` 歌词走廊/文字 | `intent.scene` |
| 能量 | `energy.quiet` 安静/舒缓；`energy.pulse` 律动/强烈节拍；`energy.explosive` 爆发/炸裂 | 全局 `cam.*`、`look.*`、`stage.scale` patch |
| 镜头 | `camera.close` 近景；`camera.far` 远景；`camera.wide` 广角；`motion.slow` 缓慢；`motion.fast` 高速 | `cam.dist/fov/drift` patch |
| 影调 | `look.neon` 霓虹；`look.mono` 单色；`look.duotone` 双色；`look.film` 胶片；`look.clean` 干净 | `look.grade/grain/bloom/chroma/saturation` patch |
| 手绘 | `hand.on` 手绘/纸张；`hand.off` 不要手绘 | `intent.hand.on` 与 `look.toon/paper` |
| 导演 | `director.follow` 跟随音乐/自动导演；`director.fixed` 固定镜头/手动 | `intent.director` |
| 否定覆盖 | 不要抖动/no shake；不要颗粒/no grain；不要泛光/no bloom | 对应值强制为 0，最后应用 |

首期规则值固定如下；这些值都在当前 `BASE_SPEC` 范围内。场景规则只写 `scene`，不生成任何 `sc.*`，避免复制场景私有默认值。

| 规则 id | 精确输出 |
| --- | --- |
| `energy.quiet` | `cam.drift=12, cam.shake=15, cam.kick=35, look.bloom=.55, look.saturation=.9, stage.scale=.92` |
| `energy.pulse` | `cam.drift=65, cam.shake=95, cam.kick=120, look.bloom=1.3, look.saturation=1.2, stage.scale=1.05` |
| `energy.explosive` | `cam.drift=105, cam.shake=155, cam.kick=165, look.bloom=1.8, look.chroma=.8, look.saturation=1.35, stage.scale=1.18` |
| `camera.close` | `cam.dist=9` |
| `camera.far` | `cam.dist=24` |
| `camera.wide` | `cam.fov=72` |
| `motion.slow` | `cam.drift=18, cam.shake=25` |
| `motion.fast` | `cam.drift=115, cam.shake=130` |
| `look.neon` | `look.grade=3, look.bloom=1.55, look.chroma=.75, look.saturation=1.35` |
| `look.mono` | `look.grade=2, look.saturation=.1, look.grain=.22` |
| `look.duotone` | `look.grade=1, look.saturation=1.05` |
| `look.film` | `look.grain=.55, look.vignette=.42, look.bloom=.75` |
| `look.clean` | `look.grain=0, look.chroma=0, look.vignette=.18` |
| `hand.on` | `hand.on=true, look.toon=.75, look.paper=.65` |
| `hand.off` | `hand.on=false, look.toon=0, look.paper=0` |
| `director.follow` | `director=true` |
| `director.fixed` | `director=false` |
| `negative.shake` | `cam.shake=0` |
| `negative.grain` | `look.grain=0` |
| `negative.bloom` | `look.bloom=0` |

参数只能写 `CreativeStage.spec()` 暴露的路径。编译阶段根据运行时 spec 删除已退休路径并返回 warning；`applyIntent` 再做一次权威校验和钳位。

### 4.3 冲突与合并顺序

合并顺序固定为：`scene -> energy -> camera/motion -> look -> hand/director -> negation`。

- 同一互斥组出现多个规则时，文本中最后出现者胜出，`warnings` 记录被覆盖项。
- 不同规则写同一个数值参数时，后一个分组胜出；否定永远最后生效。
- `scene` 缺省时保留当前场景；`patch` 只改变命中的参数，用户未提到的 cue、binding、背景和名称全部保留。
- 首期不识别任意数值、颜色名、歌词内容或自定义媒体路径，避免把不受支持的文本伪装成有效参数。

## 5. 文件边界

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `crates/vmusicd/web/creative-prompt.js` | 新建 | 规则表、归一化、区间匹配、冲突合并、`compile` 与 `supported` API |
| `crates/vmusicd/web/creative-stage.js` | 修改 | 新增 `applyIntent(intent)`，原子构造并归一化当前 preset，只发一次变更事件 |
| `crates/vmusicd/web/workshop.js` | 修改 | 高级编排增加“一句成景”页签和输入/解析/解释/应用/撤销状态 |
| `crates/vmusicd/web/creative.css` | 修改 | 输入区、建议词、匹配摘要、warning、窄屏动作栏；沿用现有 token |
| `crates/vmusicd/web/index.html` | 修改 | 在 `creative-stage.js` 之后、`workshop.js` 之前加载新模块 |
| `crates/vmusicd/src/main.rs` | 修改 | `include_str!`、`/creative-prompt.js` 路由 |
| `scripts/check-creative-prompt.js` | 新建 | 无 DOM 的规则编译契约与边界测试 |
| `scripts/check-creative.js` | 修改 | `applyIntent` 原子写入、钳位、保留字段、单事件与坏意图测试 |
| `scripts/check-assets.js` | 修改 | 资源存在、MIME、加载顺序和唯一加载检查 |
| `README.md` | 修改 | 已实现能力、资源树与验证命令 |

不改 `routes.rs`、`vmusic-store`、migration、WebSocket 或预置 schema。提示词原文也不持久化；用户要保留结果时继续使用现有“存进工坊”。

## 6. 实施任务

### Task 1：建立离线编译器及契约检查

**Files**：新建 `crates/vmusicd/web/creative-prompt.js`、`scripts/check-creative-prompt.js`。

**Why**：先固定纯函数行为，避免 UI 与舞台状态掩盖解析错误。

**Impact/Compatibility**：只新增 `window.CreativePrompt`；没有 DOM、存储、网络或计时器副作用。

**Verification**：`node scripts/check-creative-prompt.js`，期望所有分组、冲突、否定、未知词和长度边界通过，进程退出码 0。

- [ ] 定义 `RULES`。每条规则完整包含 `id`、`group`、`label`、`aliases`、`apply`；alias 在模块初始化时做重复检查，重复即抛出开发期错误。
- [ ] 实现 `normalizeText(text)`、最长别名优先的 `scan(text)`、`merge(matches, supportedPaths)` 和 `compile(text, context)`；`context` 只接受 `{ scenes, paths }`，默认从 `CreativeStage.scenes/spec` 读取。
- [ ] 暴露 `CreativePrompt.compile(text)` 与 `CreativePrompt.supported()`；返回对象一律深拷贝，外部修改不能污染规则表。
- [ ] 契约脚本至少覆盖第 2 节 7 个输入、英文别名、NFKC 全角字符、120 字截断、重复 alias、结果可重复、返回值防污染、无 `fetch/localStorage/document` 依赖。
- [ ] 运行 `node scripts/check-creative-prompt.js`，确认输出类似 `creative prompt: 40/40 passed` 后提交：`git commit -m "feat(stage): add deterministic offline prompt compiler"`。

### Task 2：给 `CreativeStage` 增加唯一原子写入口

**Files**：修改 `crates/vmusicd/web/creative-stage.js`、`scripts/check-creative.js`。

**Why**：编译器不能复制舞台 schema，Workshop 也不能连续调用多个 setter 形成中间状态。

**Impact/Compatibility**：现有 API 不变，只新增 `applyIntent`；预置仍是 `version:1`。

**Verification**：`node scripts/check-creative.js`，期望新增断言与原有断言全部通过。

- [ ] 在 `CreativeStage` 内实现 `applyIntent(intent)`：拒绝非对象或 `version !== 1`；从 `deep(preset)` 开始；校验 scene；切场景时重建 `sc` 并写入 `SCENE_CAM`；只接收 `specFor(path)` 存在且值为有限数字的 patch；可选写入布尔 `director` 与布尔 `hand.on`。
- [ ] 最终只调用一次 `normalize(next)`、一次 `resolve(now())`、一次 `applyHand()`、一次 `saveLocalSoon()` 和一次 `emit('preset', preset)`；不得通过 `setScene/setParam/setHandDrawn` 串联实现。
- [ ] 返回 `{ok:true, preset:deep(preset), applied:[...paths]}`；坏版本、空意图、未知 scene 返回 `{ok:false, code, message}` 且状态零变化；未知参数放入 `ignored`，不导致整次失败。
- [ ] 测试切 scene 后 scene 私有参数来自目标默认值、数值钳位、NaN/未知路径忽略、cue/binding/bg/name/id 保留、hand 只改 on、只发一次 preset 事件、失败零写入。
- [ ] 运行 `node scripts/check-creative.js`，确认退出码 0 后提交：`git commit -m "feat(stage): apply generated stage intents atomically"`。

### Task 3：接入工坊交互与撤销

**Files**：修改 `crates/vmusicd/web/workshop.js`、`crates/vmusicd/web/creative.css`。

**Why**：用户需要在改变舞台前理解规则实际识别了什么，并能恢复原状态。

**Impact/Compatibility**：只出现在高级编排；沉浸声场默认界面和现有 7 个高级页签行为保持不变。

**Verification**：先执行两个 Node 契约脚本；浏览器中验证键盘、焦点、撤销和 320px 布局。

- [ ] 将高级 `TABS` 首项设为 `['prompt','一句成景']`，新增 `renderPrompt(body)`；只在 `target === 'advanced'` 时渲染。
- [ ] 输入使用有 `<label>` 的 textarea、`maxlength=120` 和字符计数；示例短语是可点击 chip，点击只填充不自动应用。
- [ ] “解析”调用 `CreativePrompt.compile`，渲染 scene/energy/camera/look/hand/director 六组命中摘要；warning 与 unknown 使用 `aria-live=polite`，不把 unknown 当错误。
- [ ] “应用到当前舞台”前保存 `undoPrompt = CreativeStage.preset()`；仅当 `applyIntent` 成功才替换旧 undo 快照，按钮文案变为“撤销本次应用”。连续应用时每次只撤销最近一次。
- [ ] 撤销调用 `CreativeStage.setPreset(undoPrompt)` 后清空快照；关闭面板不自动撤销，避免用户关闭后舞台突然回跳。
- [ ] 编译失败、模块未加载或 `applyIntent` 拒绝时使用现有 `flash` 显示原因，不修改舞台；解析结果失效条件为输入再次改变。
- [ ] CSS 复用现有颜色、间距和按钮 token；结果采用无嵌套卡片的分组列表；320px 时按钮纵向排列、textarea 和最长中文词不溢出；`prefers-reduced-motion` 下无新增动画。
- [ ] 运行 `node scripts/check-creative-prompt.js` 与 `node scripts/check-creative.js` 后提交：`git commit -m "feat(workshop): add explainable prompt-to-stage flow"`。

### Task 4：接入单 exe 资源并封住加载顺序

**Files**：修改 `crates/vmusicd/src/main.rs`、`crates/vmusicd/web/index.html`、`scripts/check-assets.js`。

**Why**：开发目录可用不等于发行二进制可用，静态资源必须进入 `include_str!` 和 axum 路由。

**Impact/Compatibility**：新增一个同源 JS 路由；现有 URL 与缓存行为不变。

**Verification**：`node scripts/check-assets.js` 与 `cargo build -p vmusicd` 均退出 0。

- [ ] 在 `main.rs` 增加 `CREATIVE_PROMPT_JS` 和 `/creative-prompt.js`，MIME 使用现有 `JS`。
- [ ] 在 `index.html` 按 `creative-stage.js -> creative-prompt.js -> workshop.js` 顺序加载；每个资源只出现一次。
- [ ] 在 `check-assets.js` 增加资源映射与两条顺序约束，并检查 Rust 常量、路由、HTML 三者齐全。
- [ ] 运行 `node scripts/check-assets.js`、`cargo build -p vmusicd`，确认内嵌资源构建通过后提交：`git commit -m "feat(vmusicd): embed offline stage prompt assets"`。

### Task 5：补齐回归、浏览器验收与文档

**Files**：修改 `README.md`；仅当已有 CSS 检查发现新 selector 规则缺口时修改 `scripts/check-css-tokens.js`。

**Why**：证明该功能不是只在纯函数里成立，而是在发行形态和实际工坊流程中可用。

**Impact/Compatibility**：文档将第 14 项首期标为已实现，但不宣称其余三项完成。

**Verification**：完整命令和真实浏览器矩阵如下。

- [ ] README 的已完成功能增加“离线提示词生成舞台”，资源树增加 `creative-prompt.js`，验证章节增加新脚本；路线图仍分别保留旋律轨迹、录制回放和 DBX。
- [ ] 运行：

  ```powershell
  node scripts/check-creative-prompt.js
  node scripts/check-creative.js
  node scripts/check-assets.js
  node scripts/check-css-tokens.js
  cargo test --workspace
  cargo clippy --workspace --all-targets -- -D warnings
  cargo build -p vmusicd
  git diff --check
  ```

- [ ] 用隔离数据目录和 null 音频后端启动构建后的 `vmusicd`，浏览器分别设为 1440x900、390x844、320x568；验证第 2 节所有输入、解析不改状态、应用一次事件、撤销完整恢复、刷新保留已应用 preset、键盘 Tab/Escape、无横向滚动、控制台无 error。
- [ ] 截图至少保留桌面“解析结果”、桌面“应用后”、320px“长输入+warning”三张，并人工确认文本未重叠、按钮未截断、舞台确有变化。
- [ ] 在 `docs/aegis/work/2026-09-26-offline-prompt-stage/90-evidence.md` 记录各命令实际通过数、浏览器版本、视口、截图路径和任何设备边界；不能用计划中的期望数冒充运行结果。
- [ ] 全部验证通过后提交：`git commit -m "docs: document offline prompt stage verification"`。

## 7. 失败处理、回滚与安全边界

- 编译器缺失：页签显示“提示词模块未加载”，其它工坊功能照常可用。
- 无匹配词：保留输入并显示支持的类别，不应用空意图。
- 部分路径已随版本退休：忽略该路径，显示 warning；剩余有效项可应用。
- `CreativeStage.applyIntent` 失败：状态、localStorage 与渲染均保持原样。
- 浏览器存储失败：沿用现有 `saveLocalSoon` 的降级语义，当前会话仍可使用；本功能不新增兜底存储。
- 回滚生产功能只需移除脚本标签、资源路由、Prompt 页签和 `applyIntent`；现有 preset 不含提示词专有字段，无数据迁移或清理任务。
- 文本只在本标签页内处理，不写日志、不传服务端、不嵌入导出 JSON；避免把用户输入当作 HTML，所有展示继续使用 `textContent`。

## 8. 风险与退休计划

| 风险 | 控制 |
| --- | --- |
| 用户误以为是任意自然语言 AI | 页面明确显示“已识别/未识别”，只给支持词建议，不使用“AI”或“理解”措辞 |
| 词典复制舞台能力后失配 | 编译器只持语义规则，合法 scene/path 每次从 `CreativeStage` 读取；写入再校验 |
| 多 setter 造成闪烁和中间状态 | 唯一 `applyIntent` 原子写入、单次事件 |
| 规则越来越多变成不可维护 DSL | 首期不支持自由数值、嵌套语法、用户自定义词典；新增规则必须有冲突与否定用例 |
| 提示词生成结果无法复现 | 规则表确定性、无随机数；相同输入和相同舞台 schema 必须深相等 |

Retirement Track：没有旧功能需要删除。若未来引入本地模型或云模型，必须继续输出同一 `StageIntent v1`，并把当前规则编译器保留为明确的“离线规则模式”或在新路径达到离线、解释性与确定性验收后显式退休；不得让两个实现同时直接写 preset。

## 9. Ripple Signal Triage 与 ADR 信号

- Owner：新增 `CreativePrompt` 作为文本编译唯一所有者；`CreativeStage` 的舞台状态所有权不变。
- Downstream：只扩到 Workshop、静态资源接线、契约检查和 README。
- Contract：新增内部 `StageIntent v1` 与 `CreativeStage.applyIntent`；不新增 HTTP/WS/数据库合同。
- Source of truth：参数/场景仍在 `creative-stage.js`；规则表不成为第二份参数 schema。
- Verification expansion：除纯编译器测试外，必须跑既有创意舞台契约和真实浏览器交互。
- ADR signal：这是内部前端模块边界，当前计划和完成证据足以记录；若 `StageIntent` 将来被 DBX、远程控制或服务端消费，应升级为正式 ADR 和版本化公共 schema。

## 10. 明确不做

- 不接 OpenAI、本地大模型、浏览器模型或任何远程推理服务。
- 不根据歌曲标题、歌词、封面或音频自动生成提示词。
- 不加入任意颜色解析、自由数值表达式、用户自定义规则或提示词历史。
- 不修改沉浸声场 `Stage3D`；首期只生成高级 `CreativeStage` 预置。
- 不捆绑旋律轨迹、录屏、音频导出或 DBX sidecar。
- 不回写已完成的 `2026-09-26-prioritized-completion` 历史结论；本文件是第 14 项重新立项后的独立首期计划。
