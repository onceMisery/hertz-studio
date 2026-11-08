# ADR-0003 · 后台工作必须给交互让路

状态：生效（首次记录 2026-10-07）

## 决定

后台任务（节拍/基频分析、打卡上报）一律有**总额度**，且额度按「谁在等」
分两种耐心：

- 顺手预热（播放提交后的分析）：拿不到额度就**当场推迟**，绝不排队。用户在连切歌时，
  队列里堆的全是他已经跳走的曲子，那些满核 FFT 抢的正是当前这首解码的 CPU。
- 界面在等（GET/RPC 要节拍图）：等一手额度，但有超时；等不到就回 `analyzing`，
  前端本来有这个状态。

额度的持有范围是**整个后台任务，含落盘 await**，不是「阻塞线程返回就算还」。

显式基频分析共用节拍的两个槽，另外以进程内单槽限制基频同时最多一份，不排队，
拿不到返回 `pitch_busy`。完整哈希、解码、计算、内存缓存发布和退出均在额度内；
三十秒期限或观察者离开只发取消信号，系统 I/O 未实际退出不提前归还。算法与缓存边界见[基频轨迹](../pitch-track.md)。

工程内容指纹另用全进程一个读取槽，不排队；本地普通文件、播放 owner 确认的在线完整缓存与用户显式允许的远程完整响应共用，不按来源扩容。完整读取最多 2 GiB、64 KiB 缓冲、十秒工作期限和十二秒调用期限；远程 GET 不重试或跟随重定向，取消后的 I/O/钥匙串工作未实际退出时不提前归还。它不运行解码/FFT，也不触发在线播放下载；详细来源和一致性边界见[工程媒体身份](../stage-projects.md)。

MCP 适配会话在 SDK 解码后、创建 handler 前限制未完成请求；额度覆盖处理、响应排队和实际 stdout flush，不因取消通知或 handler 返回提前归还。超额与未完成 ID 重复均关闭当前适配会话；取消仍可被接收，未声明的通知不会产生 SDK 任务。它限制的是单个适配进程内的未完成请求，不代替原服务的业务执行额度或释放远端副作用。出站 JSON 在 SDK 编码前按实际编码字节检查，详见[MCP 互操作](../mcp-interoperability.md)。

2026-11-08 M1 实施事实：Stage3D 与 Space 的图形上下文丢失后退休当前代际，浏览器 restored 事件不复活资源，只有用户显式重试或重新打开才能经页面准入创建新实例。原 Stage3D 恢复次数窗口和 Space 定时自动重建已退休。当前 Chrome owner 检查覆盖实际 context loss、等待超过旧定时期限及显式重试；页面上限、完整宿主覆盖和实体设备资格仍未完成，不能从这些检查推定 M1 整体验收。

2026-11-08 原生显隐实施事实：WebView2 的 controller 可见性会停住 rAF，但本机实测仍可能保持 `document.hidden=false`。原生主窗口在原事件循环中提供当前文档的呈现事实，Stage 通过 `isDocumentHidden` 合并浏览器和原生状态，原视觉 owner 据此撤回帧、解码与布局权限；保留浏览器原生属性和原连续帧门。隐藏资源继续占额，恢复首帧几何增量为零。原生观察、输入身份和未完成资格见[当前 M1 验证记录](../aegis/work/2026-11-08-stage-engine-m1/40-qualification.md)，不把 API 退休或驱动缓存观察视为整页显存上限。

2026-11-08 JSON 源实施事实：原 StagePersistence 在复制及 HTTP／DBX 读取、写出前向页面账本预留，沿用 current/library 两条 CAS 队列，读取只保留一个在途和一个最新需求。取消后额度保持到实际传输结束；快照淘汰时，Creative 的数据及缩略图借用继续保护原表示。复制被拒绝的最新编辑由原 Creative controller 在显式重试时重新准入。计量为有界传输工作及声明 JSON 数据，JS 引擎对象头、GC 和进程缓存另作观察。当前 Windows Standard/Full 的内嵌与 JSON 生命周期检查支持此子集；完整可编辑数据、封面和库隐式分配仍待迁移，候选页面上限没有冻结，详见[资源 owner 覆盖](../aegis/work/2026-11-08-stage-engine-m1/30-resource-owner-review.md)。

## 边界与 owner

| 数值 | 现在是多少 | 定义在哪 | 改它要一起改什么 |
| --- | --- | --- | --- |
| 同时在跑的节拍/基频分析总数 | 2 | `crates/hertz-studio/src/state.rs::BEAT_ANALYZE_BUDGET` | 快切歌时的 CPU 竞争与队列排空速度 |
| 一首的分析最多尝试次数 | 3 | `crates/hertz-studio/src/state.rs::BEAT_ATTEMPTS_MAX` | 到顶即放弃到进程结束；改大就等于允许反复满核重算 |
| 界面路径等额度的上限（秒） | 4 | `crates/hertz-studio/src/stage_beats.rs::BEAT_PERMIT_WAIT` | GET 的最坏响应时间；测试里用注入的短时长，别改生产值来迁就测试 |
| 状态面板列出的最近条目数 | 6 | `crates/hertz-studio/src/state.rs::BEAT_STATUS_RECENT` | 设置页那一行还读得动的上限；再大就该做成列表页，不是这条 hint |
| 打卡上报每小时上限 | 60 | `crates/hertz-studio/src/state.rs::MAX_PER_HOUR` | 平台侧频控与「已提交」提示的诚实性（接口 200 ≠ 平台累计增加） |
| MCP 会话未完成请求上限 | 8 | `crates/hertz-studio/src/ai/mcp/transport.rs::MAX_PENDING_REQUESTS` | 同时持有输入、HTTP 与响应的容量；真实客户端并发、取消与慢读检查必须一起更新 |
| MCP 入站 LF 前字节上限 | 262144 | `crates/hertz-studio/src/ai/mcp/transport.rs::MAX_INPUT_LINE_BYTES` | SDK 解码前的原始帧限制，含可能的 CR，不等同业务 JSON 额度 |
| MCP 出站 LF 前字节上限 | 262144 | `crates/hertz-studio/src/ai/mcp/transport.rs::MAX_OUTPUT_LINE_BYTES` | 按实际 JSON 转义/双表示计算，超限必须完整错误替换，不能输出半帧 |
| MCP 等待与写出单帧期限（秒） | 8 | `crates/hertz-studio/src/ai/mcp/transport.rs::WRITE_TIMEOUT` | SDK 内联协议错误、等待 writer 与实际 flush 都受边界约束 |

## 禁止回退

- 不许把 MCP 的响应写入额度在 handler 返回或收到取消通知时归还；SDK 的响应仍可能排队，慢 stdout 下会重新积累无界任务。过载后不为每个新请求继续创建一个 busy 响应任务；关闭会话后不自动重放已发变更。

- 不许「先写幂等表、再拿额度」。顺序反了会在表里留下一格没人真的在算的 `Analyzing`，
  后来者一看就在等，而这个等永远不会有结果 —— 表现是舞台一直不出节拍镜头、日志无错。
- 不许把额度在 `spawn_blocking` 一返回就还掉：那样预算只限制了「同时在解码的曲子数」，
  落盘阶段完全不受管。
- 落盘失败不许记成分析失败。两者用户后果不同（一个是「以后也有，重启就没」，一个是
  「这首歌根本没有图」），混在一起开发者就会去查错的东西。
- 后台任务的状态不许只在完成那一刻闪一条 toast。「在算 / 已落盘 / 只在这轮内存 /
  已放弃 / 还没轮到」要在 `/v1/stage/beatmap/status` 上各自可读，并且能按当前曲目问
  一句 —— 混成「没有镜头」就没人能回答「再等等还是重来」。
- 节拍任务诊断与重试入口放在设置页的开发者选项；不放在右侧歌曲标题下，也不把其他
  歌曲未完成的任务数当作当前播放错误。已就绪或正在分析时不提示重试。
- 手动重试只许忘**这一把键**的结论。清整张表会把别首正在算的任务说成没人生，同一首
  几秒的满核 FFT 于是被开两遍。
- 节拍图的三态应答体只许有一份构造函数（`routes.rs::beatmap_outcome_json` 与
  `beatmap_outcome_status`）。两个门面各写一遍的话，插件形态与独立形态迟早对同一次
  重试给出两种答复。
- 上下文丢失后不许定时自动创建新代际，也不能显示「正在恢复渲染」；显式重试通过原 owner 与当前有限资源准入。
