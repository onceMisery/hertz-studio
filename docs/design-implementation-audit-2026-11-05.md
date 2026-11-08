# 设计文档与当前实现盘点（2026-11-05）

核对基线：`d40ad47` 与本次读取时的工作树。工作树另有桌面宿主进程内集成的未提交修改，相关状态单列。检索覆盖仓库文档及本机被 Git 忽略的 `docs/aegis/`、`docs/design/`、`docs/research/`、`docs/superpowers/`，并定向核对实际入口、模块、协议、配置与发布脚本。

初始盘点为静态核对，没有运行产品测试、构建、真实设备、账号或模型调用。随后按用户选择实施了 A01，并在继续开发中接通 A03、A02；新增运行证据记录于[舞台素材实施记录](stage-media-persistence.md)、[壁纸作品与轮播实施记录](wallpaper-works-playlists.md)和[显示组与镜像实施记录](wallpaper-displays-mirror.md)，其它项的历史验证范围不变。源码中存在结构体、枚举或原型页面，不直接算作用户功能已经交付。

2026-11-05 续审继续收口 A01：页面不刷新时的服务重启/失效租约恢复、视频位置保留、隐藏切换、解码取消与迟到回执隔离、预设版本保护已修复并通过 8 组真实浏览器场景；模拟 8 小时续租通过，真实长稳资格仍未完成。详见实施记录中的续审增量。

2026-11-05 A03 增量接通 work 草稿、内置场景版本发布、原包导出与单屏固定版本轮播；真实桌面验证定时切换、暂停冻结、缺包停播与原项重试、重启恢复。首版每列表最多 32 项，第三方改编和大型列表编辑仍未开放。

2026-11-06 A02 增量接通多个 single 组、span、图片/视频 mirror、完整配置 Apply、共享轮播与视频组时钟。镜像检查读取完整列表与真实包内容，后台扫描持续执行，设置页轮询结果。当前只有一块物理显示器，真实单屏与离线成员验证不能代替双屏同时呈现、混合 DPI、跨屏边界和热拔插验收。

**舞台素材持久化已完成独立版和 DBX 图片链路，壁纸作品保存/导出、轮播与显示组运行已接通并定向验证；同时多屏的真实硬件验收仍待完成。主要开发缺口有 DBX 视频宿主流、P2/P3/AI 扩展和统一舞台引擎；一起听原生采样率已实施，跨 OS 和多端硬件资格仍待验收。原生主窗口已有实现，但完整桌面产品和发布链仍未完成。R0–R6 主线的大部分剩余工作属于真实环境、质量与发布验收。**

状态口径：

- **未实施**：设计已明确，当前未找到贯通的产品实现。
- **部分实施**：已有基础或部分用户流程，仍缺指定能力。
- **进行中**：本次工作树已有改动，不能直接视为已验证的提交或发布产物。
- **待验收**：实现存在，欠缺指定环境或候选版本的证据。
- **后续提案**：文档明确后置或仍属需求池，不算当前交付漏项。

## 1. 有明确设计、仍缺实现的项目

| 编号 / 项目 | 当前判断 | 尚缺的用户结果 | 设计与源码依据 |
| --- | --- | --- | --- |
| A01 舞台本地图片/视频持久化，P1-M0～M2 | 独立版与 DBX 图片已实施并定向验证；DBX 视频受宿主门槛阻断 | DBX 视频的有界连续流协议及真实宿主发行资格；其它设备/解码器和候选安装包验收 | 2026-11-05 新增 [StageMediaStore](../crates/hertz-studio/src/stage_media.rs)、[版本化预设库](../crates/vmusic-store/src/stage_presets.rs)及[实施记录](stage-media-persistence.md)。已覆盖文件副本、稳定引用、流/租约、素材库、保存/重启、配额/删除/备份；实际 Chrome + 隔离服务通过删除原文件后的恢复。背景与歌曲 `stage_project` 身份域保持独立 |
| A02 壁纸同时多屏，P1-07 | 运行与设置已实施；单屏真实验证，双屏硬件待验收 | 双屏同时呈现、混合 DPI/负坐标/span 边界、热拔插、逐屏全屏、两路视频时钟与整机峰值 | [实施记录](wallpaper-displays-mirror.md)。全局目标注册、single/span/mirror、原子 Apply、逐组预览、共享轮播及校时已接线；最多四个呈现目标，视频 mirror 最多两成员，integrated/builtin mirror 拒绝。完整列表资格与原包核验、异步检查、暂停恢复、静态封面和退出预算已有回归；一块真实屏幕加离线成员不算双屏验收 |
| A03 壁纸作品草稿、导出与轮播，P1-05/08 | 本轮首版已实施并定向验证 | 原生保存对话框正向点击旅程与更多设备/故障资格；大型列表增量编辑、第三方许可证改编仍属后续 | [实施记录](wallpaper-works-playlists.md)。持久 work 草稿及独立 CAS、真实 schema 参数、保存/重开/不可变发布、原包导出/持久恢复、固定版本顺序/随机轮播已接线；真实桌面通过 10 组场景，含异步编辑保护、暂停冻结、失败停播、原项重试与重启。首版每列表 32 项；显示组与镜像共享轮播已在 A02 增量接入 |
| A04 壁纸组合创作引擎，P2 | 有资源底座，组合产品未实施 | 场景文档编译器、图层/遮罩/粒子/文本/受限模型、扩展资源适配、关键帧与信号绑定、编辑器、公开参数，以及通用资源动态预算 | [壁纸设计 §9、§15、§20.3](desktop-wallpaper.md)。[hertz-wallpaper](../crates/hertz-wallpaper/src/lib.rs) 提供包/清单/目录校验及共享媒体准备；[selection_plan.rs](../crates/hertz-desktop/src/wallpaper/selection_plan.rs) 的包呈现接受 Builtin/Image/Video。Composition 清单类型及既有舞台编辑器不能代替壁纸组合编译与运行；shared-assets 静态额度已接，通用 AssetProvider 动态多资源规划仍缺 |
| A05 网页壁纸隔离与社区分发，P3 | 未实施产品链 | 隔离 worker 与权限、网页包资源桥、社区服务、作者发布/审核、签名/撤销、订阅更新与回滚 | [壁纸设计 §16–18、§20.4](desktop-wallpaper.md)。Web 类型只进入包清单校验，当前呈现不接受网页内容；未找到设计中的独立 hub、网页执行隔离与社区管理入口。受信内置页面的 WebView 生命周期不等于不可信网页隔离 |
| A06 壁纸受管 AI，AI-01～06 | 未实施壁纸专用链；现有 AI 底座可复用 | 本地自然语言推荐/切换、文本场景生成、结果交付与入库、文生图、组合草稿、外部助手申请与本机确认 | [壁纸设计 §19、§20.5](desktop-wallpaper.md)。[ai/jobs.rs](../crates/hertz-studio/src/ai/jobs.rs) 当前任务能力为 `stage.intent.generate`；壁纸管理命令未接 `wallpaper.ai.*`。已有舞台静态意图生成、模型凭据和导入图片的能力，不等于壁纸 AI 工作包完成 |
| A07 一起听原生采样率模式 | 已实施，软件矩阵与Windows同机实际输出通过；实验性 | 跨 OS/不同设备、同钟回录、2/4/8端及8小时真实长稳 | [实施与V矩阵](lan-native-sample-rate.md)。创建fixed/native、六档实际率、能力确认、独立真实E、有限Ready与旧尾排空、唯一拒绝后继、跨层预算及UI已接线；完整room187通过，Standard/Full编译与真实WASAPI18组通过。固定默认48k及四档保持；设备不自动逐曲换率，不承诺跨率精确gapless或设备bit-perfect |
| A08 原生主窗口到完整桌面产品 | 窗口、关闭/退出、后台 owner、服务定时、Windows SMTC、资料/程序互斥、本地包更新、完整资料恢复、普通 JSON 一致性、受控界面偏好迁移、原生文本保存与主窗口位置恢复已实施并定向验证；OBS 九组、音乐对象与真实 OLE 十组、当前用户 NSIS 十八组通过 | Explorer 本身及其余原生交互、签名／确定的远端更新源、净系统／离线运行时、多 DPI、真实设备唤醒、物理媒体键／锁屏／跨设备及候选验收；详细范围见下一节 | 当前路线见[11-04 主窗口设计](aegis/specs/2026-11-04-r5-native-main-window-design.md)。[关闭与退出](main-window-lifecycle.md)、[后台播放／定时](native-background-sleep.md)、[系统媒体](native-system-media.md)、[程序更新](windows-install-updates.md)和[普通 JSON](json-backup-consistency.md)保留各自证据。[主窗口恢复](main-window-recovery.md)十一组及同候选文件／生命周期／内嵌桌面二十六组通过，独立桌面另有十五组。[OBS](native-obs-preview.md#2026-11-07-正式九组已通过)保持 b204 身份；[音乐导入](native-music-import.md)保持最终 5a 身份与自有 OLE 源窗范围。[NSIS 安装](windows-installation.md)的新候选另有十八组及默认 updater 八组回归；旧 Tauri/hertz-app 结构不继续作为实现要求 |
| A09 统一 2D/3D 舞台引擎，M0～M4 | M0 同帧软件合同已实施；M1～M4 未闭环 | 跨 CreativeGL/SpaceStage 的消费契约与生命周期/质量治理、一个真实双实现场景族、AI 增量语料与评测、离线创作审核入库管线 | [引擎设计 §1.3、§7](stage-engine-feasibility.md)、[M0 帧合同](stage-particles-frame-contract.md)与[本轮记录](aegis/work/2026-11-08-stage-engine-m0/20-checkpoint.md)。Stage/Canvas/GL合同23项、失败矩阵、每后端10冷/10暖及独立审查已取得；整页/合回证据限其实际身份。两套registry与AI底座仍复用；[AI 契约](../crates/hertz-studio/src/ai/contract.rs)仍为静态create，不开放生成drivers/cues。M0单层资源不等于M1跨宿主总峰值或M2真实2D/3D产品 |
| A10 桌面歌词 L2 后续阅读增强 / 非 DBX L3 | 多人声与独立退出已落地；限定本机验证通过，完整验收开放 | 原播放器校准入口已形成待审设计；非DBX L3、完整内嵌托盘/工作台和真实环境资格继续独立推进 | 当前R2为728项生产端/199项组件：[16项检查及五份发行产物](../output/a10-feature-exit-release-r2-20261108/qualification.json)、[五场独立退出/保存失败/Mini](../output/a10-native-feature-exit-fixed-r2-20261108/native-1794081018844/verification.json)、[两场可见未保存状态](../output/a10-native-feature-exit-ui-r2-20261108/native-1794081689079/verification.json)、[六组配套HTTP/实际最低及当前PluginHost](../output/a10-r2-paired-matrix-20261108/verification.json)已有分项证据。[同候选50轮](../output/a10-native-lifecycle-r2-cdp-detach-20261108/native-1794083437946/verification.json)限定退出前断开CDP，352条身份自然释放；连接CDP超时失败保留。真实正向TTML、多DPI/K、主播放器实际托盘重开、旧DBX合同/完整工作台、因果资源及长稳仍开放，见[八项退出核对](aegis/work/2026-11-08-desktop-feature-exit/91-requirement-audit.md)。[校准设计](aegis/specs/2026-11-08-desktop-lyrics-calibration-design.md)待批准，offset_ms仍为只读同步数据，不表示完整A10完成 |

2026-11-06 增量接通最大化窗口暂停和按前台应用完整路径 Pause/Stop 规则，包含设置草稿、逐屏作用、资源释放与原项恢复，见[窗口规则实施记录](wallpaper-window-policies.md)。随后补齐当前 Builtin/Image/Video 内容的作品公开属性、作者暴露/发布/重开、按组覆盖、预览与 Apply、完整轮播和离线意图校验，见[公开属性实施记录](wallpaper-public-properties.md)。删除被引用作品时的有界引用详情、只读查询及设置页展示也已完成，并验证真实 SQLite 锁竞争下的删除请求保护，见[删除引用实施记录](wallpaper-library-references.md)；最新作品原生旅程 15 项通过。组合节点/绑定属性与组合引擎仍属于 A04，不能将当前单内容属性实现视为整个 P2 已交付。

## 2. 桌面端要区分已实现、正在改和待重新定标

2026-11-08 A09 继续修复既有二维流体的隐藏 GPU 操作与当前 Hertz CSS 零尺寸准入，记录见[该修复](aegis/work/2026-11-08-stage-fluid-hidden-gpu/20-checkpoint.md)。26 项定向、21 项原流体回归和当前完整页面八项观察通过；同页两个宽度的 coast 关闭按钮实际鼠标旅程通过，旧失败保留且未改 Stage3D 产品代码。该增量是当前前端源码资格，M1 跨宿主/总峰值/设备矩阵和 M2–M4 仍开放，R2 原生候选不继承新 UI 源码资格。

### 2.1 已有的原生窗口

`hertz-studio --window` 已有同进程服务与 Wry/Tao 主窗口、独立 WebView 数据目录、一次性入口票据、重复启动聚焦、托盘、隐藏/恢复、窗口控制条和优雅退出。11-04 的后续证据已经覆盖注入拖动、贴靠和关闭等流程；最早原型记录里“托盘/正式控制条未做”也已过期。

仍有以下具体差距：

2026-11-07 主窗口位置/最大化恢复已通过十一组真实Windows场景，隐藏/最小化/胶囊不覆盖正常矩形；全局WebView2目录覆盖已退役。前一个b204的OBS九组保持原身份，见[原生预览记录](native-obs-preview.md)。新增[原生HTTP边界](native-http-boundary.md)的8af3候选已通过十二组HTTP和正式OBS九组，原系统安全窗口已确认消失；配对e778 Full DBX通过SDK/HTTP八组及Rust1.88，HTTP Full/native的Rust1.88与Clippy也通过。用户指定design-taste-frontend用于预览对比度/石墨底色；完整产品/发行资格继续开放。

同日续接另取得[当前优化release85ab的候选资格](desktop-release.md#当前源码优化-release-候选增量)：720份输入一致、release UI153项、HTTP十二组、包入口五组、setup2686/NSIS十八组、默认更新器八组和配对e778 SDK/HTTP八组均通过。[独立复核](../output/native-http-release-final-verification-20261107.json)确认摘要与自有清理，既有服务保留。新系统安全中心PID29168占据前台，release正式OBS/OLE仍待用户处理；旧debug结果不继承为新release结果，签名/净系统/设备及完整A01–A10仍开放。

| 差距 | 当前源码事实 | 状态与处理 |
| --- | --- | --- |
| 原生HTTP请求与响应边界 | 仅原生启动限制精确IPv4回环；实际端口Host/Origin/absolute URI先于票据/副作用；可信HTML显式nonce/CSP及防嵌入/无引用头 | [当前8af3十二组及OBS正式九组](native-http-boundary.md)通过，WebView2/Chrome/Pixi/Blob/style和普通LAN验证；配对e778 DBX SDK/HTTP八组及Rust1.88/Clippy通过。同候选[音乐对象/OLE十组](native-music-import.md#2026-11-07-原生-http-候选兼容增量)另已通过。普通服务/DBX不启用策略；旧NSIS及旧5a OLE报告保留原身份，新release/安装资格未覆盖 |
| Windows 原生候选交付 | Cargo 默认 feature 仍隔离；`release.yml` 的 Windows 独立 Full 构建显式使用 `full,native-window`，包内描述核验实际能力/架构/内容身份，包含启动入口、摘要和许可材料 | 2026-11-06 已接线，本地 release 构建和 Rust 1.88 all-targets 检查通过；实际解压包旅程及签名/安装/升级状态见[交付实施记录](desktop-release.md)。本地工作树验证不代表已运行远端 release workflow |
| DataDir 与安装级升级保护 | 2026-11-07 已接 shared bootstrap 的服务/旧 AI 锁兼容检查；原生恢复走鉴权/实例绑定 HTTP。程序目录另有共享运行/独占更新、实际 exe 校验、备份与原子恢复标记 | [资料目录所有权](data-directory-ownership.md)已有多宿主／竞争／失败证据；[程序更新](windows-install-updates.md)及[NSIS](windows-installation.md)分别保留默认 updater 八组和新安装候选十八组。[主业务库恢复](database-upgrade-recovery.md)十三组、[独立壁纸库恢复](wallpaper-upgrade-recovery.md)完整资源／配置及 root 准入已有记录；签名更新与实机资格仍待完成 |
| 关闭行为与退出确认 | 默认关闭隐藏到托盘，可持久选择退出；页面/托盘/HTTP 共用唯一 pending 退出请求，活动播放/房间确认、舞台保存和录制文件确认已接线 | 2026-11-06 已实施并通过六组真实原生旅程，见[记录](main-window-lifecycle.md)；后台播放与 SMTC 的后续证据单列，完整安装/发布仍未完成 |
| 原生后台播放 | 真实主窗口 RAII owner 在原播放锁内参与离场判定，renderer/WS 消失不释放；owner 退出永久关闭本地输出并进入现有服务收尾 | 2026-11-06 已实现，真实零 WebSocket 旅程通过；普通浏览器/DBX 保留三秒离场语义 |
| 原生本机睡眠定时 | 单一服务运行期定时、revision CAS、睡眠计入时钟与回调截止门控；页面只显示状态，重载不取消；房间仍使用原 host 定时 | 已实施并原生验证；真实设备在休眠前已排队音频的唤醒行为仍需物理验收，见[记录](native-background-sleep.md) |
| 原生系统媒体能力 | Windows HWND SMTC 消费服务投影；本地与房间回调按当前身份和权限执行；同一服务的主 WebView/旁开浏览器停用重复 MediaSession | 2026-11-06 已接通并完成实际 GSMTC API 旅程，见[实施记录](native-system-media.md)。物理键盘/耳机、锁屏、跨机 guest、其它 OS 和正式候选仍需专项资格；在线/房间远程封面未接入 |
| 安装/更新与实机资格 | Windows 原生 ZIP、当前用户 NSIS、共享运行／独占更新及失败／中断程序恢复已接通；主库与独立壁纸库恢复、普通 JSON 一致性已实施 | 壁纸候选的恢复／作品／内嵌／更新／ZIP／DataDir 共62组，普通 JSON HTTP／SDK七组和[偏好／原生保存十一组](ui-preference-transfer.md)分别保留候选范围；[NSIS十八组](windows-installation.md)在既有 Windows/WebView2 与 null 音频环境通过。净环境／离线安装、签名源、真实声音／录屏导出、多 DPI／长稳及其余原生体验仍待完成；macOS/Linux 需单独适配 |

10-28 [完整桌面客户端方案](desktop-client.md)的 Tauri 2、新 `hertz-app`、受管 sidecar 与 11-04 同进程方案冲突。这些旧结构不能直接作为遗漏任务。上表保留可核实的用户行为差距；继续实施前应把仍保留的产品目标回写到现行路线。

### 2.2 本次工作树正在进行的集成

[共享宿主文档](desktop-host.md)新增 2026-11-05 进程模型说明；工作树新增 `crates/hertz-desktop/src/{lib,host}.rs` 和 `crates/hertz-studio/src/desktop_host.rs`，将独立播放器的歌词/壁纸/小窗宿主改为进程内启动，合并播放器托盘，并接入退出清理。DBX 保留独立可选组件路径。

这批内容在本次核对时**尚未提交**。本轮只确认了代码接线与文档存在，没有运行其测试或核验当前二进制；应记为“进行中，集成结果待确认”，而不是“未开发”或“已经发布”。旧独立组件的验证结果不能自动覆盖新的进程、托盘与退出组合。

## 3. 已有实现，主要欠验收的项目

| 项目 | 已有基础 | 仍缺什么证据 |
| --- | --- | --- |
| 壁纸 P0、P1 已接通子项 | 亮度/运动/电池策略、稳定屏幕身份、图片/视频库、独立预览、应用/恢复、收藏/删除、视频封面、系统 loopback、鼠标水波、共享资源额度 | 正向原生文件点选完整旅程、大图/1080p/4K/硬解与峰值资源、真实设备切换/热拔/静音/休眠、RDP/显示器拓扑与八小时长稳；详见[11-04 后续表](desktop-wallpaper-review-2026-11-01.md#后续工作与所缺证据)。P0 主要待验收，P1 同时还有第 1 节的开发缺口 |
| 桌面歌词 L1-C / DBX D3b | 只读桥、授权/撤销、来源切换、原生显示、双版候选及最低/当前宿主多项流程已有记录 | 物理媒体键、真实跨用户/会话、物理桌面恢复、八小时长稳、当前候选安装/签名发布。见[发布矩阵增量](release-validation.md#2026-10-29-dbx-可选桌面接入增量)和[DBX 证据](plans/2026-10-28-dbx-desktop-evidence.md) |
| LAN 与在线一起听 | 房间、共同队列、邀请/审批、聊天、原生接收、WASAPI 时钟、在线点歌/个人舞台已接 | 两机/跨 OS 同钟声学测量、八个真实输出端、八小时真设备、macOS/Linux 当前设备、真实在线平台/账号/网络；[LAN §15](lan-listening.md)、[在线记录](plans/2026-10-26-online-listening.md) |
| 桌面/一起听 UI 产品化 | 已有前端与原生操作回归 | 六名目标用户无引导任务测试仍未完成；自动化不能代替该门槛，见[UI 方案 §8.3](plans/2026-10-26-desktop-listening-ui-productization.md) |
| R5 舞台 AI 成功与质量 | provider、凭据、持久任务、取消/恢复、受管评测均存在 | 真实模型成功候选、型号/条款、两轮评测、独立保留集与人工评分。历史 StepFun 402 是失败证据；歌词情绪分类的历史成功不是舞台生成质量验收，见[AI 草稿](ai-stage-drafts.md)、[v3 评测](../evals/stage-intent/v3/README.md) |
| R6 工程/模板/视频/基频 | 保存重开、cue、分享往返、媒体身份、录制和实验性基频已有实现 | 真实歌曲的完整成片旅程、三个模板人工视觉评审、真实系统音轨/GPU/画幅、编码时间对齐；见[工程](stage-projects.md)、[模板](stage-templates.md)、[导出](video-export.md)、[基频](pitch-track.md) |
| R0/R1/R2/S1 | 发行版裁剪、分源搜索、歌词候选、Rust MCP 和 sinc 重采样已有实现 | 当前候选矩阵、真实账号/弱网、长期混合负载/弱机、歌词来源许可、正式 MCP 客户端、真实声卡与跨 OS 听测；见[路线记录](roadmap-progress.md)、[发布矩阵](release-validation.md)、[MCP](mcp-interoperability.md)、[重采样](audio-resampling.md) |
| 空间/情绪歌词/字形/流体 | 大量渲染功能与接线已有；二维流体已在限定宿主/档位开放 | 弱机性能、真实歌曲画面与可读性、人工质量/校准。流体 DBX 性能有失败记录并保持不开放，不能算全宿主交付；见[流体实现说明](stage-fluid-enhancement.md)、[空间证据](design/space3d-implementation-evidence.md)、[情绪设计最新增量](superpowers/specs/2026-10-18-lyric-emotion-design.md) |

初始静态盘点没有取得新的运行证据；后续 A01/A03/A02 的运行证据只覆盖各自实施记录中的范围，不将上述其它“待验收”变更为通过，也不把已完成的受控验证重新归零。

## 4. 仍在文档里的后续提案

以下有范围描述或研究依据，但文档明确属于后续方向。设计成熟度并不相同，不能直接合并为本轮开发承诺。

| 方向 | 未交付范围 | 依据 / 边界 |
| --- | --- | --- |
| 音频增强 | 变速不变调、参数 EQ、WASAPI 独占、卷积/真峰值等 DSP 二期、Opus/APE/WMA 解码 | [产品需求池 §7](product-roadmap.md)、[格式支持](audio-format-support.md)；已有六段 EQ、sinc 与播放 owner 的 ExclusiveAudio 不能替代这些能力 |
| Automix | 节拍对齐、LRC 副歌选点与操作时间线 | [Mineradio 复核 B5](research/mineradio-full-assessment.md)；gapless/crossfade 已有，只是前置 |
| 外部 AI 扩展 | 外部 MCP 连接 DBX、无播放器时生成完整分享码、远程视觉 apply / 自动收藏 | [产品需求池 §7](product-roadmap.md)；与已交付的 DBX 桌面只读桥、官方工坊确认流程不同 |
| 检索与同听扩围 | 语义/氛围推荐、互联网一起听、手机音频接收、房主转移 | [产品需求池 §7](product-roadmap.md)；仍需独立需求与合同，不把响应式手机页面当成音频接收端 |
| 主窗口与桌面组件主题同步 | 主题偏好归属、来源切换、断连与多客户端冲突 | [界面架构设计 §10.2](aegis/specs/2026-11-03-ui-architecture-convergence-design.md)明确另立需求。已有共享样式和主窗口标题栏配色同步，不代表各桌面窗口共享用户主题偏好 |
| 首页每日一问 / 在线热榜 | 本地题库与问答交互；按完整播放次数计数/排行 | [每日一问二期](aegis/plans/2026-10-08-home-quote-and-daily-question.md)、[热榜研究](research/openmusic-hot-rank.md)；当前名言、平台推荐不是这些功能 |
| 三维流体/液态材质 | 选择具体场景，接既有 renderer、scope 和材质参数 | [流体设计 §12](aegis/specs/2026-11-01-stage-fluid-enhancement-design.md)要求另写增量 spec；当前只交付二维局部流体 |

云同步、云端多用户、远程 MCP、运行时热加载模型生成 JS/GLSL/SVG 等当前排除或后置方向，不算设计漏实施。

## 5. 旧清单需要纠正的状态

| 旧说法 / 所在文件 | 本次核对结果 |
| --- | --- |
| 恢复快捷键“未实现”：旧审计、产品路线 | 11-05 已实现 `RegisterHotKey/WM_HOTKEY`、配置事务、冲突反馈与退出释放；[交付记录](plans/2026-11-05-roadmap-next-recovery-hotkey.md)已有单测、浏览器和原生证据，物理键盘/锁屏等边界另计 |
| 小窗“未挂模块”；或还缺设置行、管理命令、皮肤热重载 | 均有实现：`lib.rs` 模块、`index.html` 的 `set-mini-row`、`app.js` 的开关、`management.rs` 的 `mini-toggle`、宿主 `pet_skin_signature`/`reloadSkin`；小窗原型 §7、旧审计和产品路线滞后 |
| 壁纸亮度/运动、电池、系统音频和鼠标交互“未实现” | 配置、策略、WASAPI 采集及鼠标水波已接线；硬件资格仍需分项验收。不能将原 W3 整行继续写为未实施 |
| 壁纸 P0–P3“新增阶段尚未交付”而未说明子项 | P0 主要运行路径和大量 P1 子项已实现；本次又补齐独立版与 DBX 图片的舞台持久媒体、作品保存/导出、轮播和显示组/镜像运行。同时多屏仍缺真实硬件验收，DBX 视频宿主流及后续 AI 等仍缺实现，应按工作包表达 |
| LAN“待评审、尚未实施”：README 专项表及早期进度段 | 当前 §15 和实际 room/vmusic-lan 代码已明确实施。真正开发差距是原生采样率增量；其余多为设备验收 |
| 主窗口“尚未开始”；必须新建 Tauri/hertz-app：desktop-client | 已有后续 Wry/Tao 同进程路线与窗口实现；旧技术路线不能继续作为待办真值 |
| UI 架构 R0–R4“未实施”：11-03 设计顶部 | 11-04 证据已记录外壳、动作/弹层、公共表单与布局迁移，旧搬运层退役；R5 也已有原型。页面设计的编制状态不能替代实施状态 |
| 歌词“没有预设”或情绪/字形“只有早期契约” | 歌词已有四个基础预设；情绪设计 §12 的后续增量已有分类、缓存、词级入场/强调与扩展情绪。应逐能力核对，不能只读首段或未勾选验收清单 |

原[10-28 审计](design-implementation-audit.md)、[产品路线](product-roadmap.md)、[README](../README.md)和[历史进度](roadmap-progress.md)保留各自的设计与证据价值，但不能原样复制成 11-05 待办清单。这里记录差异，不将历史测试改记为当前版本通过。

## 6. 建议的下一轮顺序

1. **先收口正在进行的进程内桌面宿主集成。** 确认启动/托盘/退出和 DBX 边界，补当前候选证据，并统一同进程桌面路线与发行配置。
2. **A01 已按用户后续选择优先实施。** 独立版图片/视频与 DBX 图片已取得保存/恢复结果，详见上方实施记录；DBX 视频继续保留宿主前置。
3. **A03 和 A02 已接通，继续补硬件验收。** work 草稿/保存/发布/导出、轮播、显示组与镜像已有本轮证据；双屏涉及混合 DPI、组时钟、解码器与整机预算，按实施记录补真实硬件矩阵。
4. **为已有能力补真实环境验收。** 桌面长稳、LAN 跨机、真实歌曲创作导出和目标 MCP 客户端按环境分别排，不继续堆同类 fixture 充当验收。
5. **P2/P3/AI、LAN 原生采样率、统一引擎分别决策。** 复用已落地底座，按依赖选择一条；不把所有后续提案合成“全部补完”，不沿用旧工期相加。

用户后续已选择 A01 并要求使用子代理继续开发，随后实施了 A03、A02；A08 的关闭/退出、后台播放、睡眠定时与 Windows SMTC 也已按后续继续指令推进，证据分别列于实施记录。第 6 节中其它方向仍是排序建议，不代表已经实施或通过验收。

## 2026-11-07 受控偏好与原生文件验收增量

后续同日完成[原生音乐选择导入](native-music-import.md)：精确文件、目录递归、复用扫描／取消、File 权限、可见错误和队列拖动已有实现；最终 5a 候选有十组实际对象／Windows OLE 和七组浏览器证据。旧系统弹窗已处理，自有源窗的文件与目录 OLE 通过；Explorer 本身继续单列。[OBS 正式九组](native-obs-preview.md#2026-11-07-正式九组已通过)保持独立 b204 身份，旧52组和诊断报告未改。[当前用户 NSIS](windows-installation.md)另有新 release 候选十八组、默认 updater 八组及本地 workflow 准备证据；签名／确定更新源、净系统、物理设备和其它设计差距仍继续跟踪。

2026-11-07 已完成[受控界面偏好迁移](ui-preference-transfer.md)与主窗口文本保存：18 个已知键的独立协议、导入预览、原模块校验、DBX 提交确认、异步舞台保存保护和原生保存/取消/失败回执已接通。UI 按用户指定的 design-taste-frontend 调整设置布局与窄屏比较。最终 Full/native 候选的十一组真实原生旅程、七组浏览器/DBX、100 项协议/宿主检查、前端 74 步、主程序 18 项及 Rust 1.88/Clippy 均通过；三个原生测试进程退出，完整身份与范围见[交付记录](desktop-release.md#受控界面偏好与主窗口文本保存)。主窗口恢复/辅助窗口、NSIS/签名及实机资格继续推进，整体路线仍未完成。
