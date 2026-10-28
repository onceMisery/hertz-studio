# 设计文档实施缺口盘点

核对日期：2026-10-28。基线：`0330508` 与盘点时工作树。

本文保留该基线的实施盘点。专项设计修订后的目标契约不自动改变实现状态；第 3 节的“旧说法”是修订前记录，不作为新一轮开发待办。当前开发范围以各专项正文为准，历史验收证据仍按原版本与环境分别有效。

当前最明确、已有完整专项设计但尚未落地的是 **DBX 接入桌面歌词与壁纸（D0–D3）**。其他缺口主要分为桌面能力的后续扩展、一起听音频模式的设计差距，以及主线功能的真实环境与发布验收。桌面歌词、单屏壁纸、一起听工作区、在线点歌和个人舞台已经有实现，不应再按早期计划整体重做。

本轮对照 `docs/` 中现行方案、交付记录、路线图，以及 `docs/aegis/`、`docs/research/`、`docs/superpowers/` 中历史设计，并定向检查相关源码、配置和验证入口。属于静态盘点，没有重新运行构建、浏览器、音频、模型或原生验收；历史记录中的“通过”只沿用其原有范围。原工作树的 `space_previews.rs` 修改不属于本次整理。

状态含义：**未实现**＝未找到对应交付链路；**部分实现**＝已有基础但缺少设计中的具体能力；**待验收**＝已有代码或受控证据，缺真实环境/质量/发布结论；**后续提案**＝文档明确后置或仅为建议，不自动成为本轮承诺。

## 1. 有明确设计依据的开发缺口

以下按能力归并，避免同一个缺口在多份文档里重复计数。排序是本次建议，不沿用旧文档的工期估算。

| 项目 | 状态 | 尚缺什么 | 设计依据与当前代码事实 |
| --- | --- | --- | --- |
| DBX 桌面歌词与壁纸 D0–D3 | 未实现；设计草案 | D0 真实 DBX 的管道/辅助组件验证；D1 sidecar 只读数据桥、来源类型及 schema v3 迁移；D2 capability、共用管理门面、连接/撤销与 UI；D3 配套组件安装升级与候选发布 | [专项方案](desktop-dbx.md)，尤其第 9–10 节。当前 [config.rs](../crates/hertz-desktop/src/config.rs) 仍是 schema v2，Profile 只有 DataDir/edition；[bridge.rs](../crates/hertz-desktop/src/bridge.rs) 读 `vmusicd.json` 并走 HTTP；[app.js](../plugin/ui/app.js) 在 DBX 下隐藏桌面入口。已有管理管道不等于 DBX 只读数据管道已经实现 |
| 桌面歌词全局恢复快捷键 | 未实现；现有恢复路径可用 | 原生全局注册、冲突/失败反馈、配置与注销；仍须保留托盘恢复 | [共享宿主](desktop-host.md) 明确仍未完成；检查桌面源码未发现 `RegisterHotKey` / `WM_HOTKEY` 接线。[UI 方案](plans/2026-10-26-desktop-listening-ui-productization.md) 明确它不作为当前找回功能的必要条件 |
| 壁纸构图参数与电池策略 | 部分实现；存在设计差距 | 壁纸专属亮度、运动强度等参数；电池行为需对齐设计或明确修订，用户可切换策略另属后续 | [壁纸方案](desktop-wallpaper.md) §3.1 写明亮度/运动强度及默认电池停绘；[UI 方案](plans/2026-10-26-desktop-listening-ui-productization.md) §4.2/4.6 将相关控件后置。[WallpaperConfig](../crates/hertz-desktop/src/config.rs) 目前只有 enabled/fps/musicResponse/monitor/source/scene。宿主已有歌词侧电源降帧，但壁纸 `recompute_wallpaper()` 按配置 fps 与可见性策略起停，未见电池停绘条件；不能将歌词降帧当成壁纸电池策略 |
| 壁纸作品化 W2 | 部分实现；后续范围 | 专用版本化配置导入导出、参数预置/收藏/轮播，及可选歌曲/封面/简洁歌词叠层 | [壁纸方案](desktop-wallpaper.md) §3.2/§11；[UI 方案](plans/2026-10-26-desktop-listening-ui-productization.md) P2。已有九个场景、固定/跟随与实时预览；[创意工程](stage-projects.md) 与播放器壁纸设置不能直接算作桌面壁纸作品格式 |
| 壁纸系统音频、多屏与交互 W3 | 未实现；后续范围 | WASAPI loopback、设备切换；多屏同时运行/独立配置/整机预算；不干扰图标的鼠标视差 | [壁纸方案](desktop-wallpaper.md) §3.2，并明确同时多屏尚未实现。已有能力是“选择一块目标屏”，包括其混合 DPI 与恢复，不是多屏实例。现有频谱来自绑定 Hertz 服务，不是系统音频采集 |
| 一起听原生采样率优先 | 部分实现；当前交付明确缩小范围 | 按歌曲原生采样率切换房间格式、新格式代际及预缓冲；与锁定采样率连续混音的选择/提示 | [一起听方案](lan-listening.md) §6.2 设计默认原生采样率优先，但 §15 明确当前创建时固定 44.1/48/96/192kHz、双声道 f32，逐曲格式切换未开放。[创建合同](../crates/hertz-studio/src/room/contract.rs) 也使用固定 `sample_rate`。不能把整个一起听标为未实现，也不能把此音质模式算已完成 |
| 桌面歌词 L2 / 非 DBX 的 L3 | 后续提案 | 更细排版、受控主题、更多行/多人声、可选校准入口；其他 OS/ARM64 与系统媒体来源 | [桌面歌词](desktop-lyrics.md) §10。当前单/双行、译文/罗马音、样式及定位不属于缺口；系统媒体标题/系统声音也不等于已经取得歌词 |
| 统一 2D/3D 舞台引擎 M 系列 | 部分基础已有；整体方案未闭环 | 跨 CreativeGL/SpaceStage 的统一生命周期与质量治理；双实现场景族及其 StageIntent 契约；M4 离线新场景创作/审核/入库管线 | [引擎评估](stage-engine-feasibility.md) §7。现有 [CreativeGL](../plugin/ui/creative-gl.js)、[空间 registry](../tools/space-stage/src/registry.js) 与 Stage 时钟已存在；R4/R5 任务底座也已实现。不能照搬旧文“均未实现”的判断，也不能把各自有注册表视为 M0–M4 已整体交付；正式启动前须重做差距定标 |

### 可以选做，但仍未进入当前交付的提案

| 项目 | 尚缺内容与边界 | 文档 / 核查依据 |
| --- | --- | --- |
| Automix 自动混音 | 节拍对齐、副歌选点与操作时间线；现有 gapless/crossfade 只是前置能力 | [Mineradio 复核](research/mineradio-full-assessment.md) §12.2 的 B5 明确未实现；源码检索未见 automix 实现链路 |
| 播客变速不变调、参数 EQ、WASAPI 独占及 DSP 二期 | 属于独立音频项目，需算法/设备/听测设计；sinc 重采样与现有六段 EQ 已有实现 | [产品路线图](product-roadmap.md) §7、[重采样现状](audio-resampling.md)。房间的 `ExclusiveAudio` 是播放 owner 互斥，不能当成 WASAPI 独占输出 |
| Opus / APE / WMA 解码 | 逐格式选库、许可与坏文件验证，接通解码和实际输出 | [格式支持](audio-format-support.md) 与根 [Cargo.toml](../Cargo.toml) 明确当前无对应解码器；扩展名扫描不代表能播放 |
| 外部 MCP 连接 DBX | 需要独立的受限业务桥与权限/宿主验收 | [产品路线图](product-roadmap.md) §7、[MCP 说明](mcp-interoperability.md)。与前表 DBX 桌面只读桥是不同能力，不应混为同一条任务 |
| 无播放器时生成完整分享码、远程视觉 apply / 自动收藏 | 分别需要离线物化方案、目标 UI 身份/revision/确认与完成回执 | [产品路线图](product-roadmap.md) §7。当前 intent 草稿/窄校验及人工预览确认不等于上述能力 |
| 语义检索 / 氛围推荐 | 先验证结构化查询收益，再决定 embedding 等实现 | [产品路线图](product-roadmap.md) §7；现有 FTS/关键词检索不是语义检索 |
| 互联网一起听、手机音频接收、房主转移 | 需要新的部署/传输/身份与接收器设计，不是给现有界面加入口即可 | [工作区方案](plans/2026-10-25-listening-workspace-design.md)、[UI 方案](plans/2026-10-26-desktop-listening-ui-productization.md) P2；小屏适配不代表手机可收听 |
| 首页每日一问 | 本地题库、日期选题、答案展开与名言共存方式；产品问题尚待确定 | [历史方案](aegis/plans/2026-10-08-home-quote-and-daily-question.md) 第二期明确后置；当前 [home-quote.js](../plugin/ui/home-quote.js) 是名言模块，未找到题库/问答链路 |
| 按完成播放次数统计的在线热榜 | 播完计数、存储/排序/API 与展示；不能与平台推荐或热门分类混淆 | [OpenMusic 调研](research/openmusic-hot-rank.md) 的 F 节仅提出实现路径；当前迁移/服务/UI 未找到所提 `online_hot` 计数链路。仅为历史调研建议，不能直接复用文中旧目录/迁移编号 |

云同步、多用户账号、远程 MCP、运行时热加载模型生成的 JS/GLSL/SVG，以及第三方壁纸生态均属于现行路线明确后置/排除的方向，不列作当前漏实现的交付项。

## 2. 已有实现，主要缺真实环境或发布验收

这些项目应安排验收并按失败结果修复，不宜重新开一轮同名功能开发。

| 能力 / 文档 | 已有基础 | 尚缺的证据或退出条件 |
| --- | --- | --- |
| 桌面歌词 L1、壁纸 W1、统一桌面中心 | Windows 宿主、歌词只读桥、WorkerW、九场景静态图/实时预览、配置草稿事务、位置编辑和冲突反馈；已有原生 Win32/WebView2 检查 | 当前候选的物理显示器热插拔、锁屏/全屏、自启切换、GPU 恢复/长稳及安装升级；L1-C / W1-C 仍未完成。早期探针中已验证的单项不必重复归零，候选仍需绑定版本。依据：[UI 交付](plans/2026-10-27-ui-productization-delivery.md)、[歌词](desktop-lyrics.md)、[壁纸](desktop-wallpaper.md) |
| 一起听核心与 UI 产品化 | 创建/发现/审批/邀请、共同队列、点歌/投票/收藏、聊天、接收器、WASAPI 时间戳与个人舞台均有实现 | macOS/Linux 的当期构建和实际设备记录、两台机器/跨 OS 声学同步、八真实音频端压力、八小时真实设备与故障恢复；六名用户无引导任务测试。单机双进程、null 或虚拟八小时不替代这些。依据：[LAN 当前交付](lan-listening.md) §15、[交付计划](plans/2026-10-24-lan-listening-delivery.md) Task 8、[UI 交付](plans/2026-10-27-ui-productization-delivery.md) |
| 在线一起听 / 房主在线点歌 | 在线分享/入队、后台渐进准备与缓存租约；抽屉、搜索取消和待确认操作；已有受控慢网与原生双进程证据 | 真实在线平台/账号/网络下的起播与恢复，以及跨机音频表现。依据：[在线起播记录](plans/2026-10-26-online-listening.md)、[舞台与点歌记录](plans/2026-10-27-room-stage-online-followup.md) |
| R5 舞台草稿模型与生成质量 | OpenAI/StepFun/Ollama adapter、钥匙串、持久任务、取消恢复、受管评测和人工确认候选链路 | 舞台草稿的真实模型成功响应、条款/兼容性、两轮质量评测、独立保留样本与人工评分；历史 StepFun 402 不能证明当前账号状态或模型质量。歌词情绪设计另有历史联网分类成功记录，不能与舞台草稿评测混用。依据：[AI 草稿](ai-stage-drafts.md)、[凭据](ai-provider-credential.md)、[评测 v3](../evals/stage-intent/v3/README.md)。不因盘点触发付费调用 |
| R6 工程 / 模板 / 视频 / 基频 | 工程保存重开、cue 编辑、三个模板候选、录制导出、实验性 pitch 查看均有实现 | 一首真实歌曲从编辑到成片的完整作品旅程、三个模板人工视觉评分、真实系统音轨/GPU/画幅/宿主；基频的真实歌曲质量与编码时间对齐。依据：[工程](stage-projects.md)、[模板](stage-templates.md)、[视频](video-export.md)、[基频](pitch-track.md) |
| R1 搜索 / 歌词与 S1 重采样 | 渐进分源搜索、本地/在线歌词候选及严格自动应用、流式 sinc 都已有实现 | 真实账号/弱网、小时级混合负载及公平性、弱机；歌词来源许可和真实匹配质量；声卡/跨平台听测。依据：[搜索](search-performance.md)、[歌词导入](lyric-import.md)、[重采样](audio-resampling.md) |
| R2 外部 MCP | 独立服务的 Rust stdio adapter、受限能力/授权/去重与 SDK 子进程检查 | 正式目标客户端、长时压力、完整取消/超时、各 OS/候选端到端。依据：[互操作说明](mcp-interoperability.md)；DBX 外部连接另见开发缺口 |
| 三维空间、情绪歌词、字形引擎 | 空间首页/独立舞台/歌词组合、情绪场及 glyph 接线与对应检查均存在 | 空间的四核/8GB/集显性能和真实声音；情绪/glyph 按各自设计的真机画面、可读性、校准和 off/on 性能验收逐项补证，不能仅凭未打勾断言没实现。依据：[空间记录](design/space3d-implementation-evidence.md)、[情绪设计](superpowers/specs/2026-10-18-lyric-emotion-design.md)、[字形设计](superpowers/specs/2026-10-18-lyric-glyph-engine-design.md) |
| R0 与整体验收矩阵 | 两发行版裁剪、构建/检查和历史候选已有记录 | 与最新源码一致的四种 Windows 候选身份、真实音频/账号、Standard/Full 安装升级回滚与签名/商店材料；其他平台分别补证。依据：[发布验收矩阵](release-validation.md)。旧包、旧提交或旧 CI 不自动覆盖当前改动 |

## 3. 旧计划中需要纠正的状态

| 文档 / 旧说法 | 本轮核对结果 | 后续阅读依据 |
| --- | --- | --- |
| [10-23 下一阶段计划](plans/2026-10-23-next-development.md)：`crates/` 尚无桌面组件，LAN 尚待启动 | 已有 `crates/hertz-desktop`、`vmusic-lan`、房间业务与完整 UI；早期排期及门槛保留为历史，不能据此重复立项 | 10-27 两份交付记录及 LAN §15 |
| [产品路线图](product-roadmap.md) 开头：壁纸与 LAN “尚未实施” | 已被 10-24～10-27 增量覆盖；尚未完成的是具体后续能力及完整验收 | [进度](roadmap-progress.md)、本盘点第 1–2 节 |
| [壁纸](desktop-wallpaper.md)、[歌词](desktop-lyrics.md)、[原生验证计划](plans/2026-10-23-desktop-native-validation.md) 混存“尚未实施/不进入下一阶段”与后续实现记录 | 文内有时间层次冲突。按最新具体交付判断代码是否存在，保留未通过的原生/长稳门槛，不从后续编码反推早期验收通过 | [统一桌面 UI 交付](plans/2026-10-27-ui-productization-delivery.md) |
| [space3d-mode](design/space3d-mode.md)：三批次未开工，旧挂载/释放策略 | 后续五阶段与空间交互已经实施，生命周期、歌词组合等也有用户修订；不是一份可直接执行的当前待办 | [后续设计](design/space3d-home-and-threejs-stage.md)、[交互修订](design/space3d-spatial-ui-alignment.md)、[实施记录](design/space3d-implementation-evidence.md) |
| [Folia 计划](superpowers/plans/2026-09-27-folia-lyrics.md)：大量未勾选任务 | 当前对应实现已在 `plugin/ui/stanza/`，有 classic/cadenza/bg/subtitle 等模块与 `check-stanza*` 检查。路径/名称演进与未回填勾选不能当成缺功能 | [扩展指南](extension-guide.md)、[stanza 目录](../plugin/ui/stanza/) |
| [舞台引擎评估](stage-engine-feasibility.md)：R4/R5 任务/提案/评测均未实现 | 该部分已过时；现有 AI 底座应复用。统一双后端和离线创作管线仍需单独核对/设计 | [AI 草稿现状](ai-stage-drafts.md)、本盘点第 1 节 |
| [源码体量优化](resource-optimization.md)：待拆 `ai/jobs.rs` 测试、待拆 AppState | `ai/jobs.rs` 已通过 `mod tests;` 引入 `ai/jobs/tests.rs`，测试拆分不应再列未完成。AppState 已抽 `state/viewers.rs`，其他职责仍主要集中在 state.rs，属于部分推进 | [jobs.rs](../crates/hertz-studio/src/ai/jobs.rs)、[tests.rs](../crates/hertz-studio/src/ai/jobs/tests.rs)、[state.rs](../crates/hertz-studio/src/state.rs)、[viewers.rs](../crates/hertz-studio/src/state/viewers.rs) |

`docs/aegis/`、`docs/research/`、`docs/superpowers/` 中部分文档处于 Git 忽略目录，本地能读到不等于克隆仓库后一定存在。本盘点保留这些历史方案的出处；若要把其中提案转为正式开发任务，应先在受版本管理的目录整理当前契约。没有更改忽略规则或自动把历史目录加入版本管理。

## 4. 建议的后续顺序

1. **优先推进 DBX 桌面接入的 D0。** 它是当前设计最完整的新功能缺口；先确认真实宿主、只读传输、组件启动及分发，再做 D1/D2，D3 以实际候选验收结束。
2. **收敛桌面产品差距。** 将全局恢复快捷键作为可选增强；明确壁纸电池行为与亮度/运动参数的当前范围，避免文档默认行为与代码不一致。
3. **独立安排当前功能的验收清单。** 桌面 L1-C/W1-C、LAN 跨机/长稳及当前候选安装升级应按环境分别执行；AI 质量等待可用真实模型条件，不重复堆受控测试替代。
4. **一起听音质模式单独决策。** 若仍要求 §6.2 的原生采样率优先，拆为明确开发包；若接受固定房间格式，应修订首版产品范围，而不是继续保留两套相互冲突的完成口径。
5. **W2/W3、M 系列、Automix 与其他建议项按需求选一条。** 不把多年期需求池、历史调研建议与当前漏实现项合成一个“全部补完”任务，也不使用旧估时相加工期。

本文件用于后续定序；各专项的原始契约、验收门槛和历史失败证据仍由原文档维护。
