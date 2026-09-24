# 3D 舞台对标 Mineradio：节拍电影相机 · 自由相机 · 焦点跟拍 · 玻璃化 UI

> 日期：2026-09-24
> 状态：已与用户分节确认，待最终审阅
> 前置调研：[mineradio-stage.md](../../research/mineradio-stage.md)
> 范围：仅舞台视觉/交互工作线。在线音源边下边播等为另一条 spec（[2026-09-23-online-audio-overhaul-design.md](2026-09-23-online-audio-overhaul-design.md)，已实施），不在此文档范围。

## 1. 背景与目标

现有舞台已具备：五个 WebGL 场景（creative-gl.js，球面轨道相机 yaw/pitch/dist/fov）、CSS 3D 歌单架（shelf.js）、星河（stage-starriver.js）、粒子封面（stage-cover-particles.js）、3D 歌词图集（lyric3d.js）、实时 onset 检测（onset.js）、能量自动导演与 cue 动画引擎（creative-stage.js）、舞台控制面板（stage-control.js，参数 localStorage 持久化）、性能三档（perfTier）。

对照 Mineradio 的最大视觉差距：
1. 镜头冲击是随机抖动（cam.shake）而非**确定性节拍电影语言**（强拍 FOV 收缩/zoom punch/roll），时机依赖实时频谱，弱拍无分型、无前瞻。
2. 相机无 roll 通道、无 WASD 自由飞行、无指针锁定环视。
3. 歌单架/队列只摆着，镜头不会"看见"它们（无焦点飞行）。
4. UI 为不透明面板，缺 Mineradio 的毛玻璃质感与按压反馈。

本轮目标（用户逐项确认，全做）：

- 服务端节拍地图（强/弱拍分型、BPM、强度），前端时间轴精确驱动电影相机；onset.js 作地图未就绪时的兜底。
- 开关式自由相机：WASD + Shift、鼠标指针锁定、Q/E 滚转、K 平滑回正；机位 localStorage 持久化。
- 歌单架/播放队列悬停焦点跟拍（仅 peek，260ms 飞行/飞回，无点击锁定）。
- 四个覆盖面的玻璃化 UI 演进（底部播放条、顶栏与下拉面板、在线曲库面板、舞台控制/工坊抽屉）。
- 接入电影相机后对存量场景做参数级对照调优。

## 2. 硬约束（沿用项目契约）

1. 前端零构建：裸 `<script>`、无打包器、无新 npm 依赖；新 JS 经 main.rs `include_str!` 内嵌。
2. 全页单一 rAF：所有相机/镜头计算挂在现有 `Stage.gate()` 帧循环，不另起定时器/rAF。
3. WebGL 渲染器（creative-gl.js）与五个场景的几何/着色器**不重写**；只扩展相机参数总线。
4. CSS 3D 元素（shelf.js）不进 WebGL 空间；焦点飞行用屏幕坐标到球坐标机位的映射。
5. 服务端为权威存储；自由相机机位属本机 UI 偏好，沿用 stage-control 的 localStorage（非服务端数据）。
6. 性能档（creative-stage 的 perfTier，0=节能/1=平衡/2=高性能）：0 档不分析节拍、不请求地图、隐藏自由相机开关，镜头行为完全回到现状。
7. Mineradio 代码为 GPL-3.0：仅行为参考，禁止拷贝其代码。
8. 不做调性/鼓点声学分类、不批量回算历史曲目、不加侧栏滑动手势、不持久化队列/曲目/进度。

## 3. 节拍地图：分析器、缓存与协议

### 3.1 新增 crate `vmusic-beats`

独立于音频 actor 的纯分析库（输入 PCM/文件路径，输出地图 JSON 结构）。依赖：symphonia（workspace 已用 0.5）、rustfft（vmusic-audio 已用，workspace 依赖可复用）。无 cpal 依赖，可在无头环境单测。

**分析管线：**

1. symphonia 解码到单声道 PCM，重采样到分析率 22050Hz（线性；时长 ≥8 分钟降为 11025Hz）。
2. 分帧：1024 样本窗、512 hop，加 Hann 窗。
3. rustfft 幅度谱；按 mel 频段（约 26 个三角带，与 onset.js 的频段思想对齐，保证前后端观感一致）取带能量。
4. 频谱通量：相邻帧各带正差分求和，经局部均值归一化得到 onset 包络。
5. 峰值选取：自适应阈值（局部中值 × 增益系数）+ 最小峰间隔 200ms；峰高归一化得到每拍 strength（0..1）。
6. BPM 估计：峰间隔直方图 + 自相关，在 60–180 BPM 内取峰峰间隔中位数微调；置信度低时 bpm 置 null（前端仍用峰点，只失去规整化）。
7. 强拍（downbeat）：4/4 启发式——从峰序列中选起点附近强度高的峰为第 0 小节，之后每 4 个峰打 downbeat；BPM 为 null 时退化为"每 4 个峰"。
8. intensity（0..3）：每拍取前后 2 拍 strength 均值，按分位数映射四档。
9. 上限分析前 12 分钟；超出部分按 BPM 周期推演补拍点（推演拍 strength 取近 8 拍均值、intensity 沿用最后值），输出 `truncated: true`。

**输出结构：**

```json
{
  "version": 1,
  "bpm": 128.4,
  "offset_ms": 0,
  "truncated": false,
  "beats": [
    { "t": 187, "strength": 0.92, "downbeat": true, "intensity": 2 }
  ]
}
```

字段约定：`t` 为相对曲目开头的毫秒；beats 按 t 升序；strength ∈ [0,1]；downbeat/intensity 为整数。

**触发时机：** 曲目在 vmusicd 真正开始播放（load + play 提交成功）后，由 AppState 在后台 `tokio::task::spawn_blocking` 触发分析；不阻塞起播、不阻塞 actor。分析读的是本地曲库路径或在线曲缓存文件（在线曲须等缓存文件存在；渐进播放期间文件已在增长——分析只在**下载完成 rename 后**才允许启动，避免读到半截）。同一曲目（缓存键）只分析一次；分析任务不随切歌取消（结果缓存对下次播放有用），进程退出即终止。

### 3.2 缓存

- 目录：`data/stage-beats/`（与 `cache/`、`data/vmusic.db` 同级，由 AppState 提供路径）。
- 文件名：`sha1(本地为规范化绝对路径；在线为虚拟 track_id)` 的十六进制 + `.json`。
- 失效：记录源文件 mtime（写在 JSON 里或 sidecar），命中时比对；mtime 变化则重算。在线缓存文件删除（LRU）不影响旧 beatmap（再次下载 mtime 不同自然失效）。
- 不做历史批量回算；仅播放时惰性生成。

### 3.3 HTTP 与 WS 协议

- `GET /v1/stage/beatmap?track=<track_id>`
  - `200`：完整地图 JSON（外加 `cached: bool`）。
  - `202`：`{ "status": "analyzing", "pct": <0..99 可选> }`——分析中，前端保持 onset 兜底。
  - `404`：`{ "status": "unavailable", "reason": "tier0" | "failed" | "unsupported" | "not_ready" }`——前端不报错，继续 onset 兜底。
  - 触发源有两个（实现为同一张"进行中/已完成"表，幂等去重，保证同一曲目同时只有一个分析任务）：①播放提交成功后服务端主动触发；②前端首次 GET 发现无缓存时触发。任一来源先到先建任务，另一来源直接看到 analyzing。
- WS 事件（沿用 WsEvent tag 协议，可选字段 skip_serializing_if）：

```json
{ "type": "beatmap_ready", "track_id": "...", "bpm": 128.4, "beats_n": 412 }
```

前端收到后若当前播放曲仍是该 track_id，则拉取地图；否则忽略。

- seek 不产生请求：前端持有地图，按新 position_ms 二分重定位拍索引。

## 4. 电影相机驱动器（stage-cinema.js）

### 4.1 相机参数扩展（creative-gl.js / creative-stage.js）

在现有相机参数总线（runtime.cam：yaw/pitch/dist/fov/tx/ty/tz/drift/shake/kick）上增加：

- `cam.roll`（度数，夹 −25..25，默认 0）：creative-gl render 中在算出 view 矩阵（lookAt）之后、`mul(viewProj, proj, view)` 之前，左乘一个绕相机前向轴（视线 = target−eye 归一化）旋转 roll 度的旋转矩阵（mat4 绕 Z 的标准旋转在视线空间等价于绕前向轴；实现时新增一个 `rollView(out, view, eye, target, rollRad)` 小函数，避免在世界轴上误转）。该参数**不进滑块**，由电影/自由相机系统独占。
- `cam.punch`（运行时态 0..1，不持久化、不进滑块）：节拍冲击量，驱动器维护、帧内指数衰减。
- 开关 `cinema`（舞台控制面板"电影镜头"，默认开）与"冲击强度"滑块（0–200%，默认 100，持久化进现有 stage localStorage values）。

### 4.2 时间轴（纯函数模块，可在 Node 测）

新增不依赖 DOM/GL 的时间轴逻辑（放在 stage-cinema.js 内的纯函数区，或同文件可导出的纯对象，便于 check 脚本 require/eval 测试）：

- **高精度播放时间 pt**：以服务端快照 position_ms（约 30Hz）为基准 + 两次 rAF 间本地 performance.now 外推（按播放速率 1.0）；每次 state 帧到达做一次重锚（漂移 >150ms 或检测到 seek 时硬对齐）。
- **拍索引游标**：地图 beats 升序，游标 lastBeatIdx 随 pt 单调推进；seek 后二分查找重定位（容差 ±60ms 内不补发）。
- **一帧多拍**：区间 `(lastPt, pt]` 内若有多拍，取 strength 最大的一个作为本帧冲击（其余忽略，避免长帧后连发）。
- **包络求值**：给定冲击拍与当前 pt，输出 `{ fovMul, distMul, rollDeg }`，均为时间的确定性函数（下节）。

### 4.3 节拍包络（挂 Stage.gate，每帧求值）

由驱动器在 resolve 管线内叠加（合成顺序见 §6）。基线来自 preset/滑块；包络为**乘法（fov/dist）/加法（roll）**：

- **强拍 downbeat**（28ms 起振、320–420ms 收）：
  - fov：28ms 内收缩到基线 ×0.94，320ms ease-out 回到 ×1.0。
  - dist：同步 zoom punch 到 ×0.975，320ms 回。
  - roll：向交替方向（相邻强拍 ± 交替）±1.2°，420ms 回 0。
- **普通拍**：fov ×0.975、140ms 回；仅当 strength > 0.8 才带 roll ±0.5°。
- **intensity == 3**：上述幅度 ×1.5，并把 cam.drift 有效上限临时放宽（具体倍数在调参任务定，初值 1.4）。
- 所有幅度再乘用户"冲击强度"滑块 /100；tunnel 场景（cam.dist≈4.2 的近机位）dist punch 幅度折半，防止穿模。
- 包络是时间确定性的，不依赖事件到达时刻；地图就绪晚于起播时，已过去的拍不补放（只从当前 pt 开始）。

### 4.4 onset 兜底与接管

- 地图状态：`absent`（未请求/tier0/失败，用现有 onset onBeat 随机 shake）→ `waiting`（202，onset）→ `active`（地图驱动）。
- waiting→active 切换：当前 shake 余量自然衰减完，自下一帧起由包络驱动；切换帧不重置相机基线、不跳变。
- cinema 开关关闭：包络段整体跳过，等同现状（onset shake 按现有 cam.shake 行为保留）。

## 5. 自由相机（stage-freecam.js）与焦点跟拍（stage-focus.js）

### 5.1 自由相机

- 入口：舞台控制面板"镜头"分组新增「自由相机」开关。与「电影镜头」互斥：开启自由相机时暂停 cinema 包络；关闭时相机以 600ms ease（inout）飞回当前导演/电影机位，若 cinema 仍开则恢复包络。
- 操控（仅开关开启时注册；Esc 或再点开关退出）：
  - W/S/A/D：水平面平移，沿相机朝向前后/左右；Shift 按下 ×2 速。基础速度 0.35×cam.dist / 秒。
  - 在舞台画布上 click → requestPointerLock；锁定期间 mousemove dx/dy 改 yaw/pitch（灵敏度取现有拖拽环灵敏度的 1/2）。
  - Q/E：持续按住 roll 以约 40°/s 线性变化，夹 ±25°。
  - K：roll 在 260ms 内平滑回 0（不退出自由模式）。
- 自由相机写入与导演相同的 cam 参数（yaw/pitch/dist/tx/tz/roll），经同一 resolve 生效，覆盖全部 5 个场景与 CSS 3D 透视。
- 持久化：退出/关闭自由模式时保存机位 `{yaw,pitch,dist,tx,tz,roll}` 到 stage-control 的 localStorage（并入现有 STORE_KEY）。再次开启自由相机时从该机位起步；**不跨曲目/不跨开关自动应用**。
- perfTier 0：隐藏开关。

### 5.2 焦点跟拍（仅悬停 peek）

- 监听对象：shelf.js 歌单卡片、app.js 播放队列行。进入悬停 120ms 确认后发起焦点请求；移出即取消。
- 目标机位映射：
  - 歌单架卡片（CSS 3D）：getBoundingClientRect 中心 → 屏幕水平位置映射 yaw 偏移、垂直位置映射 pitch；dist 推到基线 ×0.55；朝向歌单架所在方位（固定方向常量 + 元素相对偏移）。
  - 队列行（2D 侧栏）：朝侧栏方向 yaw 偏移 + dist ×0.8 的"看台"机位。
- 飞行：260ms ease-out-cubic（复用现有 cue 动画引擎，作为一类内部焦点动画，不进用户 cue 轨）；移出后飞回当前模式机位（自由模式→用户机位；电影模式→导演机位）。
- peek 期间 cinema 包络幅度压到 30%（不关闭，保证镜头基本稳定可读），移出恢复。
- 自由相机开启时不响应 peek；触屏无 hover 不触发；不拦截 shelf 卡片的点击/滚轮（只发镜头事件）。

### 6. resolve 优先级（自下而上，后者覆盖前者）

1. preset / 用户滑块基线
2. cinema 节拍包络（cinema 开且非自由模式）
3. peek 焦点飞行（飞行期；并把 cinema 压制到 30%）
4. 自由相机（开启时完全覆盖 2、3）
5. cam.shake 随机抖动（始终最后叠加）

## 7. 玻璃化 UI 体系

只演进 CSS 令牌与四个覆盖面的容器/按钮样式，不改布局结构、不引依赖。不支持 backdrop-filter 时降级为不透明背景。

### 7.1 新令牌（style.css :root，暗色/亮色各给值）

```
--glass-bg         常驻面玻璃底（暗 rgba(18,20,28,.62) / 亮 rgba(255,255,255,.66)）
--glass-bg-strong  抽屉/弹层（.78 / .82）
--glass-blur       14px（播放条/顶栏 18px）
--glass-line       rgba(255,255,255,.10) 内描边高光
--glass-shadow     0 8px 32px rgba(0,0,0,.38)
--press-scale      .97
```

### 7.2 覆盖面

1. **底部播放条**：`backdrop-filter: blur(18px) saturate(1.2)` + --glass-bg + 顶部 1px --glass-line + --glass-shadow；播放控制按钮按压缩放（80ms scale(var(--press-scale)) + 240ms 回弹）；音量 thumb 悬停放大。
2. **顶栏与下拉面板**：顶栏玻璃化；更多工具菜单、设置/账号弹层用 --glass-bg-strong + blur 14，120ms 上移淡入。
3. **在线曲库面板**：搜索框、chip、#online-quality、历史/账号/歌单卡片统一半透明玻璃底，hover 提亮沿用现有节奏；错误条（.online-errorbar）保持警示色不玻璃化。
4. **舞台控制面板 / 工坊抽屉**：容器玻璃化；滑块轨道、开关保持现有 --line/--accent 对比，仅容器变。

不做 Mineradio 式侧栏 peek 滑动手势（现有聚合菜单/抽屉交互保持）。

### 7.3 性能降级

常驻玻璃面控制在 4 个；perfTier 0/1 时 blur 降到 8px；若根节点已有 perfTier 类钩子则不支持时直接给不透明 --glass-bg-strong 实色。以 check-css-tokens.js 能识别的令牌方式书写，不写裸色值。

## 8. 存量视觉对照调优

- 各场景 sceneDefaults 相机基线复核：punch 在 tunnel（dist≈4.2）折半已内置；其余场景确认 fov/dist 收缩不穿模、不露场景边缘。
- 星河 / 粒子封面：确认它们只消费 uPulse/uAgg/频谱，与相机 roll/punch 无耦合；不新增粒子触发。
- shelf.js：确认 peek 飞行期不与卡片自身 CSS 3D transform 冲突（peek 只动相机）。
- 所有调优不改几何/着色器/文件结构，只改参数与（必要时）相机侧防护。

## 9. 错误与边界

- 分析失败/解码不支持：beatmap 返回 404 failed，前端永久停留在 onset 兜底（当曲目内不重试；下次播放可重试一次）。
- bpm=null：地图仍可用（无规整化，峰点照驱动；downbeat 退化为每 4 峰）。
- 地图 beats 为空数组：按 unsupported 处理。
- 在线曲缓存未完成不分析；缓存被 LRU 删除后 beatmap 成为孤儿（不影响播放，下次播放按 mtime/缺文件自然重算）。
- 指针锁定被浏览器拒绝（权限/非安全上下文）：自由相机的环视回落到"按住画布拖拽"（沿用现有拖拽改 yaw/pitch），WASD/QE/K 不受影响。
- localStorage 不可用（隐私模式）：自由相机机位与开关当会话内存变量处理，沿用现有 try/catch 模式。
- seek/长帧（>250ms）：只取最强一拍，不补发历史冲击。
- perfTier 切换到 0：立即停止 cinema 包络、隐藏并关闭自由相机、取消进行中的 peek。

## 10. 测试与验证

### 10.1 Rust 单测（vmusic-beats，程序合成 PCM fixture，不提交音频文件）

- 通量正差分：合成正弦脉冲序列 → 峰位置正确。
- BPM：合成 120BPM click 轨 → 估计落在 118–122。
- 强拍分型：第 0/4/8… 拍 downbeat=true；strength ∈ [0,1]。
- 截断/推演：>12 分钟输入 → truncated=true 且尾段有补点。
- 路由：beatmap 三态（首次 202/analyzing、完成后 200 cached、tier0 404）；缓存键与 mtime 失效。

### 10.2 前端契约检查

- 新增/扩展 check 脚本钉：cam.roll 通道存在、resolve 优先级（cinema<peek<freecam、shake 最后）、自由/电影互斥、peek 120ms/260ms 常量、localStorage 机位键、beatmap_ready 分支、tier0 回退 onset。
- 时间轴纯函数用合成地图 + 假时钟在 Node 断言：pt 外推、seek 二分重定位、一帧多拍取最强、强/弱拍包络幅度。
- check-css-tokens.js：新玻璃令牌被引用、无裸色值；check-assets（新 JS 被 include）/check-stage-control/check-creative 不回归。

### 10.3 真机验收（人工）

1. 强拍 punch 与鼓点同拍、无半拍延迟；弱拍差异、intensity 3 加强可见。
2. 首播 onset 兜底 → 地图就绪平滑接管。
3. 自由相机全套操控；刷新后开关内机位恢复；关闭飞回导演位；指针锁定拒绝时拖拽回落可用。
4. 歌单架/队列 peek 飞行与飞回；飞行期镜头稳定。
5. 四个玻璃面与按压反馈；低性能档降级。
6. tunnel 近机位不穿模；星河/粒子/歌单架无异常。
7. perfTier 0 全旧行为。
8. seek 快速对齐；超长曲截断后尾段仍有拍点。

## 11. 实施顺序概览（plan 细化，预计 12–14 任务）

1. vmusic-beats crate（重采样/STFT/通量/峰值/BPM/downbeat）+ 单测
2. 节拍缓存（键、mtime、tier 门）+ 播放后后台分析调度（仅缓存完成后）
3. beatmap REST 三态 + WS beatmap_ready + 前端事件分支
4. creative-gl roll 通道与参数接线
5. 时间轴纯模块（外推/重定位/包络）+ Node 测试
6. stage-cinema.js 接入 Stage.gate（开关/冲击滑块/onset 接管）
7. stage-freecam.js（开关/键鼠/回正/持久化/互斥/飞回）
8. stage-focus.js（shelf + 队列 peek 与坐标映射）
9. 玻璃令牌 + 播放条/顶栏弹层
10. 在线曲库面板玻璃化
11. 舞台控制/工坊抽屉玻璃化与降级
12. 存量场景参数对照调优
13. 契约检查、全量门与真机验收

## 12. 主要变更文件（预计）

- 新增：`crates/vmusic-beats/`（Cargo.toml + src/lib.rs 等）、`crates/vmusicd/web/stage-cinema.js`、`stage-freecam.js`、`stage-focus.js`、对应 check 脚本、beatmap 缓存模块（vmusicd/src/online 同级或 stage_beats.rs）。
- 修改：workspace Cargo.toml、vmusicd Cargo.toml/main.rs（include 新 JS + 模块注册）、routes.rs/ws.rs/state.rs（beatmap 端点、事件、分析触发）、creative-gl.js（roll）、creative-stage.js（参数总线/resolve 顺序/控制面板开关）、stage-control.js（新开关与滑块）、shelf.js/app.js（peek 事件源）、style.css/online.css/creative.css/stage.css（玻璃令牌与样式）、index.html（新 JS 引用与面板控件）。
