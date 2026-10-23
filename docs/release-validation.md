# 当前路线的能力与发布验收矩阵

核对日期：2026-10-21。适用于 0.2.1 开发工作区，基于 HEAD `401a90376c0fa8391b5d60234103eeb381ef2c2c` 加未提交改动；不是该提交、已发布二进制或商店候选的验收结论。发布时必须用实际候选的源码、依赖和产物身份重跑，不能直接沿用开发工作区结果。完整范围仍由[产品路线](./product-roadmap.md)、[技术方案](./technical-roadmap.md)与[进度记录](./roadmap-progress.md)约束。

## 2026-10-23 远端自动化与构建增量

本次通过 GitHub API 核对 `origin/master` 提交 `2f2765c2867f9295ab28dd05aff21bc9ae324b17` 的远端运行结果；未在本机重跑产品测试或安装候选。以下增量只替换旧记录中相应的“远端未核对”状态，其余历史本机证据仍绑定各自源码和产物。

| 证据 | 核对结果 | 范围 |
| --- | --- | --- |
| [CI 39815799925](https://github.com/onceMisery/hertz-studio/actions/runs/39815799925) | 13/13 job 成功，`head_sha` 与当前基线一致 | Windows/Linux/macOS × Standard/Full 的 stable 格式、Clippy、测试及 Rust 1.88 全 target 检查；另有一个 Linux smoke |
| [release 构建 39815999209](https://github.com/onceMisery/hertz-studio/actions/runs/39815999209) | 13/13 job 成功，同一 `head_sha` | 两版独立程序的 Windows x64/Linux x64/macOS ARM64 构建、两版三 OS 插件打包，以及校验和汇总 |
| 上述构建的 artifact 元数据 | 12 份分项产物及 `dist-all` 汇总存在，核对时均未过期 | 只核对元数据，未下载/解包、未复算二进制 SHA-256；安装、升级/回滚、签名与 Store 不在此证据内 |

release workflow 由 `workflow_dispatch` 手动触发，只保留 artifacts；运行成功不代表自动发布。真实声卡/设备切换、正式 MCP 客户端、原生 DBX 完整旅程、实际账号、模型质量及长时资源仍分别待验。下一批候选绑定与验收任务见[开发计划](./plans/2026-10-23-next-development.md)。

## 2026-10-21 DBX、硬件与发布验收增量

本次只验 DBX、当前机器硬件可用性和发布产物；真实模型验收不在范围内。检查基于当前 dirty 工作区，不代表 0.2.1 发布候选通过。

| 范围 | 结果 | 证据与边界 |
| --- | --- | --- |
| DBX 宿主 | Full 启动、UI 与只读 RPC 通过；Standard 未验 | 本机 DBX 0.6.39 正在运行，高于项目最低版本 0.6.35。Full 0.2.1 已安装并启动，sidecar 进程来自该版本安装目录；插件独立数据目录为 `plugin-data/io.github.oncemisery.hertz-studio.full`。DBX 页面显示“服务已连接”，并读取到播放快照和队列，证明启动、初始状态读取及状态事件接线可用。候选 `.dbxp` SHA-256 与 artifact 元数据一致；这不等于安装目录逐文件与包体逐项比对。Standard 未安装验收。 |
| 音频硬件 | 未完成真实播放验收 | Windows 声音设备枚举显示 NVIDIA High Definition Audio、Realtek High Definition Audio、Intel 智音技术与 Intel Bluetooth Audio 均为 `OK`。现有 `target/resource-optimized/debug/hertz-studio.exe` 报告 `0.2.1 (standard)`，其构建指纹含 CPAL 与 Symphonia；它早于当前源码改动，且没有播放测试信号、捕获系统回环或人工听测，因此不能判定声卡输出通过。 |
| 发布 UI 源码检查 | 通过 | `node scripts/check-release-ui.js` 的源码部分通过：经典脚本全局、跨脚本词法绑定、CSP、运行库体积、依赖顺序、生成 manifest hash 和源文件保留。 |
| Standard 嵌入 UI | 通过（开发构建） | 对 `target/resource-optimized/debug/build/hertz-studio-86b5759ed0f86685/out/ui` 执行发布 UI 检查，128 个资源的 identity/gzip 解压逐项相等；identity 5,860,441 bytes，gzip 1,823,758 bytes。该目录来自 debug profile，不是 release 候选。 |
| 第二份 Standard 嵌入 UI | 通过（旧开发构建） | 对 `target/debug/build/hertz-studio-444dd3c24aaad70c/out/ui` 执行同一检查，128 项通过；identity 5,862,571 bytes，gzip 1,824,546 bytes。它同样不是发布候选，且早于当前源码修改。 |
| Full 发布产物 | 候选包与真实宿主启动通过 | 当前源码隔离副本完成 Windows x64 Full release sidecar 与 `.dbxp` 构建；安装的 Full 0.2.1 在 DBX 中启动并显示连接状态。包 hash/构建范围见下文；仍不是签名或商店发布验收。 |
| DBX 包与签名 | unsigned 包打包与 Full 安装通过；签名未验 | Full `.dbxp` SHA-256 为 `e7cb23890f1c788cf02aff44ae13165f51da624dcd237d95ea37078de265ad2e`，与 artifact 元数据一致。DBX 安装与启动已完成；Standard 安装、升级、回滚、签名和商店发布仍未验。 |

结论：Full 0.2.1 unsigned 插件已在本机 DBX 0.6.39 中启动，页面、服务连接、初始播放快照与事件链路可用；候选包 hash 与 artifact 元数据一致。真实音频输出、Standard 插件安装、签名、升级回滚与商店发布仍未验收，因此发布验收未完成。

### 本轮 DBX 包构建更新

用户要求基于当前代码构建插件并做 DBX 真实验证。使用 `dbx-plugin 0.1.2` 在隔离副本 `target/dbx-src-20261021-132129` 为 Standard、Full 分别完成 Windows x64 release sidecar 编译和 unsigned `.dbxp` 打包；包保存在该隔离副本的 `target/dbx-candidate-retry/{standard,full}`。两个包均为当前 0.2.1 身份，artifact 元数据 SHA-256/size 与包体一致，包内各有一个 sidecar；Standard 的 Full 协议指纹检查通过。包 SHA-256：Standard `287422f89658b8cc8a3ab1526881e9c50b65fa1bc9f5fb4adb59f99e200634fc`，Full `e7cb23890f1c788cf02aff44ae13165f51da624dcd237d95ea37078de265ad2e`。

构建首次触发 `hertz-studio/build.rs` 的发布 UI 压缩步骤时失败：它通过 CLI 调用 `minify-ui.js`，但 CLI 有意拒绝 `OUT_DIR`；在当前工作树修正为调用模块 API后，隔离副本重试成功。原工作树暂存目录与历史 `plugin/dist` 均未被本轮打包覆盖。用户已开启 DBX 未签名包安装设置并自行安装 Full；本次只读取运行状态，没有更改宿主安全设置，也没有操作当前播放或队列。DBX 页面显示“服务已连接”，能够读取当前播放快照/队列。真实声卡回环与人工听测尚未执行，故仅判定宿主启动及只读 RPC/事件链路通过，不判定音频输出通过。

## 能力 × 发行版 × 形态

“已实现”只说明当前代码存在对应链路。下表的受控检查不等于该能力在所有发行版、OS 或真实宿主上已通过。

| 能力 | Standard | Full | 独立形态 | DBX 形态 | 当前证据及仍缺范围 |
| --- | --- | --- | --- | --- | --- |
| 本地曲库与播放 | 保留 | 保留 | HTTP 与原音频 owner | RPC 与同一音频 owner | 有音频/扫描回归；真实声卡、设备切换、持续播放与原生宿主须按候选再验 |
| S1 流式 sinc 重采样 | 已有增量 | 同一实现 | 原 cpal 解码线程 | 同一音频 backend；原生未验 | 有 44.1/48/96kHz 离线质量/长度、实际 PCM seek/EOF、分配与本机 release 合成探针；真实声卡/持续听测、弱机、其它 OS 与发布产物未验，见[实现边界](./audio-resampling.md) |
| 格式与错误说明 | 同源 | 同源 | 目录提示、稳定错误码 | 同一 UI 与 CoreError 映射 | 实际内存解码与 Windows Chrome 受控失败通过；逐 OS/宿主与声音未验，见[格式说明](./audio-format-support.md) |
| WebDAV 与本地导入 | 保留 | 保留 | 既有业务 | 共享 RPC 门面 | 真实服务器凭据、弱网、远程音频和恢复须验；不能从本地静音文件推断 |
| Jamendo / ccMixter / 公开播客 | 保留 | 保留 | 原 Provider 与对应媒体语义 | 同一业务 | Jamendo 需 client_id；实际来源、节目和网络条件须记录，不把公开访问当再分发授权 |
| 商业平台协议与账号 | 不编译 | 保留 | Full 原 Provider | Full 原 Provider | Standard 裁剪检查通过；Full 逐源真实登录、权益、取流与换源未完成当期验收 |
| 分源搜索与局部恢复 R1-S | 已实现 | 已实现 | 四入口、HTTP 共享额度 | 同源 UI、RPC 共享额度 | 有可控 DBX 调用与 Chrome 旅程；两版三轮各两分钟实际 HTTP/RPC/旧聚合受控压力、期限与槽位/socket 回收通过，含测试进程内存，见[长时压力归档](../evals/search/pressure-v2/README.md)；固定过载下HTTP单源大量busy，未证明有效吞吐/公平性；生产独立进程混合负载 RSS、真实账号/弱网、原生宿主、长期稳定性和弱机仍待验 |
| 搜索性能基线 R0/R1-S | 本轮顺序查询通过 | 分页修复后本轮顺序查询通过 | 两版 release、50000 条合成曲目真实 HTTP；受控来源真实 Chrome；五分钟本地负载与实际服务进程内存 | HTTP/RPC 语义一致检查通过；RPC/原生 DBX 未计时 | 默认调度最慢本地 P95 208.54 / 207.28 ms，受控首结果286.10 / 290.90 ms，均通过原门槛；更广泛运行条件稳定性、长期内存预算、真实网络混合压力、弱机/跨 OS 仍待验，见[分页修复复测](../evals/search/page-v1/README.md)；原 Full 失败仍保留 |
| 本地歌词候选导入 R1-L | 已有增量 | 同源 | LRC/窄 TTML 检查、预览与确认 | 同一服务/UI；原生未验 | Rust 解析/旧库迁移/修订并发、HTTP/RPC 与 Chrome 实际导入通过；许可、真实歌曲及全部歌词视图/导出/原生宿主待验，见[歌词导入](./lyric-import.md) |
| 手选在线歌词候选 R1-L | 不编译商业协议，无入口 | 五个既有音源，均未完成真实验收 | 显式搜索/选择/取词/预览/应用；可勾选严格自动应用 | 同一服务/UI；原生未验 | 有 Rust 存储/冲突/边界与 HTTP/RPC、真实回环响应流及受控 Chrome UI 检查；严格自动应用默认不勾选，须用户显式选择，且仅适用于无可见歌词的唯一精确匹配；真实来源/账号/许可与实际匹配质量仍待验收 |
| 受限外部 MCP R2 | 已实现 | 已实现 | IPv4 回环服务与 Rust stdio adapter | 首发不提供外部连接 | 有实际 JSON-RPC 与官方 Rust SDK 子进程检查；八个在途请求直到 flush 才归还、超载/重复 ID 关闭与出站帧上限，见[MCP 互操作](./mcp-interoperability.md)；正式目标客户端、长时间压力/进程内存与完整取消/超时、逐 OS 与候选端到端未完成 |
| 场景契约与 intent 校验 R3 | 已实现，另需开关与 scope | 同左 | 经受限 MCP 查询/窄校验 | 官方 UI 可用；不承诺外部 MCP | 十场景契约/物化与分享回归通过；新增重构前十场景20组完整预置、规则入口与固定旧分享导入回溯检查，见[历史 fixture](../evals/stage/legacy-v1/README.md)；全部历史用户预置、原生宿主、GPU/弱机与人工视觉验收仍待核对 |
| 舞台临时预览与确认 R3 | 已实现 | 已实现 | 原 owner 临时层 | 同一 UI owner | 有 Chrome 自动保存/收藏隔离回归；逐发行版原生宿主旅程待验 |
| 持久 AI 任务与事件 R4-J/E | 已实现 | 已实现 | 官方 HTTP/WS 与任务 UI | 官方 RPC 与同一任务服务 | 有 fake 完整受控旅程；各运行形态的重启、重连与异常矩阵仍待候选验收 |
| 预留、费用与独立账本 R4-B | 已实现 | 已实现 | 官方只读管理入口 | 共用账本业务 | 有迁移/CAS/迟到费用/跨月/浏览器回归；没有真实云账单核对，不代表实际模型已有可靠费用上界 |
| 本地 Ollama R5-P | 实验 | 实验 | 显式回环配置，默认 fake | 同一 Rust adapter | 有可控 HTTP fixture；已接入任务取消信号，adapter 退出后归还执行槽；无实际模型运行证据，兼容、性能和质量未验，不自动转云或下载模型 |
| 云模型与凭据 R5-P | 实验实现，待真实验收 | 同左 | OpenAI / StepFun adapter 与凭据入口 | HTTP/RPC 同源管理 | 用户选择 OpenAI、质量优先，费用未知不阻挡功能；已有固定 origin/安装 owner 绑定的钥匙串管理、存储代际/任务绑定/派发匹配/管理失效与工坊入口；Windows 两版系统钥匙串的合成值持久/隔离/删除验收通过。StepFun `/v1 + step-5-preview` 的一次真实应用任务以 HTTP 402 失败、无提案，未重试；这不是模型成功或质量验收。HTTP 状态持久化与工坊分类提示已编码，仅静态核对，新增夹具未执行。其它 OS、锁定/拒绝访问、DNS 边界、真实成功响应与数据条款仍待验收；当前没有可用 API key，不再发起模型请求；不可据此宣传真实模型已验证 |
| StageIntent 质量 R5-E | 评测入口已实现 | 同左 | 离线/Ollama CLI 与显式 loopback managed CLI | 不依赖播放器宿主 | 有冻结合成语料、离线基线和 fake loopback CLI 检查；隔离新构建服务二进制 live smoke 已通过，覆盖认证、同意、无持久任务及本机 Ollama 断连取消/不重试/槽位回收。真实模型成功响应、两轮评测、独立保留样本与人工评分缺失，发布资格为 false |
| 可编辑工程、分段与导出 R6 | 已有试点 | 同源 | Chrome 上已验证工程与原生录制；在线完整缓存/显式远程指纹 | 工程 UI/指纹业务同源；导出不承诺追平 | 有工程/seek/换曲、工坊分享码 UI 生成/导入往返、工程重开与视频解码，及实际回环 HTTP/凭据范围和 Chrome 媒体身份回归；真实 NAS/来源/系统音频、其它浏览器/画幅/GPU/宿主仍待验 |
| 三个本地创作模板 R3/R6 | 候选 | 候选 | 预览后显式应用 | 同一 UI | 固定版本/纯创建/分享回归与静音截图通过；实际歌曲和独立人工视觉验收未完成，见[模板说明](./stage-templates.md) |
| 基频候选轨迹 R6 | 实验 | 同源 | 显式本地分析与只读查看 | 同一服务/UI；原生未验 | 37 个合成信号、服务预算/缓存/双门面与实际 WAV 的 Chrome 时钟/隔离检查通过；真实歌曲、不同编码的时间对齐和弱机未验，见[基频说明](./pitch-track.md) |

R1-L 的严格自动选择已有实现，尚余来源许可、在线真实来源及自动匹配的完整质量验收；S1 已有重采样实现与离线增量，真实设备/听测与其它专项验收仍按原路线完成。工程媒体身份已有在线完整缓存与显式远程完整读取增量，真实来源/账号、内容变更语义与原生宿主仍按[工程边界](./stage-projects.md)验收。此矩阵不把它们从范围中删除，也不把手动分段、基频候选或静态模板解释为模型时序编排。

## OS × 发行版 × 验收类型

| 类型 | Windows Standard | Windows Full | Linux Standard / Full | macOS Standard / Full |
| --- | --- | --- | --- | --- |
| Rust 1.88.0，锁定依赖、工作区全部 target 的 cargo check | `2f2765c` 远端 CI 通过 | 同提交单独启用 Full，远端通过 | 两版远端 CI 通过，见 10-23 增量 | 两版远端 CI 通过，见 10-23 增量 |
| stable 格式/Clippy/测试 | `2f2765c` 远端 CI job 通过；历史本机计数见进度 | 同提交 Full CI job 通过；历史本机计数见进度 | 两版远端 CI job 通过，未逐项摘录测试计数 | 同左 |
| Standard / Full 资源与身份裁剪 | `2f2765c` CI 的 release UI / edition 检查通过 | 同左 | 两版 CI 对应检查通过 | 同左 |
| Release 独立程序构建与 DBX 插件打包 | `2f2765c` 远端 x64 独立程序及 Windows 插件构建通过 | 同左 | 两版 x64 独立程序及 Linux 插件构建通过 | 两版 ARM64 独立程序及 macOS 插件构建通过 |
| 受控 HTTP、实际 Chrome 画布与视频编解码 | 有开发工作区记录，逐次使用的形态与边界见进度 | 没有独立冻结 Full 候选的当前记录 | 未完成当期记录 | 未完成当期记录 |
| 原生 DBX UI / 权限 / 浮窗 | 待当期候选验收 | 待当期候选验收 | 待验 | 待验 |
| 实际声卡 / 系统音频 / 设备切换 / 长时间听测 | 待验 | 待验 | 待验 | 待验 |
| 实际账号 / 正式 MCP 客户端 / 真实模型 | 按能力分别待验 | 按能力分别待验 | 待验 | 待验 |
| 模型凭据系统钥匙串（合成值，null 音频） | 本机实际保存/原生值匹配/跨进程重启/隔离/删除通过 | 同左，另含旧 service 迁移及删除不复活、辅助字段清理 | 待验 | 待验 |
| 官方 Rust MCP SDK 与真实 stdio 子进程 | 历史本机七项通过；当前 CI 测试 job 通过，专项计数未另摘录；null 后端 | 同提交 Full CI 测试 job 通过；历史专项记录见进度 | 工作区测试已纳入，当前两版 CI job 通过；专项日志未另摘录 | 同左 |
| 发布候选包 hash、安装/升级/回滚与 Store 签名 | 无当期验收 | Full 不进 Store；其它待验 | 待验，Full 不进 Store | 同左 |

最低编译器检查覆盖 standalone、DBX、共享库、build scripts 和测试代码的编译；不链接或运行播放器/sidecar 产物，不启动宿主、不验证声音，构建脚本和 proc macro 仍会执行。2026-10-18 本机使用 `rustc 1.88.0 (6b00bc388 2025-06-23)`、`x86_64-pc-windows-msvc` 分别执行：

```powershell
cargo +1.88.0 check --locked --workspace --all-targets
cargo +1.88.0 check --locked --workspace --all-targets --features hertz-studio/full,dbx-plugin-hertz/full
node scripts/check-editions.js
```

两版不能用一次 `--all-features` 的结果替代。CI 的 `msrv` job 对三个 OS、两个发行版分别使用 1.88.0；stable 测试 job 继续提供新编译器下的 lint/运行回归。2026-10-18 本机增量只核对 YAML 和命令接线；2026-10-23 已取得绑定 `2f2765c` 的远端成功结果，见本页最新增量，不扩大为原生声音或安装验收。

## 发布时需绑定的证据

R5-E 后续增量（2026-10-21）：managed CLI 已覆盖应用配置的 `ollama-local`，并在新构建服务二进制上实测单样本调用与请求断连取消。该路径复用应用 provider 和授权，不要求 standalone Ollama CLI 的可执行文件指纹；真实云模型成功响应与模型质量仍未验收。

每个候选记录源码提交及 dirty 状态、Cargo.lock、发行版、形态、OS/架构、编译器、二进制/包 SHA-256、配置与使用的 backend，再附命令/运行链接、结果和明确未验范围。视觉与性能记录另带 GPU、驱动、画幅、分辨率、档位和样本；真实声音记录带设备、采样率、源格式、时长与听测人；真实账号与模型记录保留非敏感身份、模型/runtime/digest、样本与结果，不保存凭据。

开发源码检查、受控 HTTP fixture、真实画布、原生宿主、实际声音、真实账号、模型质量与候选包安装分别记录；某类通过不能填入另一类。0.1.0 的历史宿主/账号记录不覆盖当前未提交实现。当前没有满足全部发布门槛，不能据本表宣称 R0–R6 完成。

打包与升级边界见 [Standard / Full](./editions.md)，商店候选命名与签名边界见[提交手册](./dbx-store-submission.md)。打包、发布和实际外部付费调用不由这份记录自动触发。

R5-E 后续验证（2026-10-21）：在复用 target 编译的新服务二进制上，`check-stage-evaluation.js --live` 已验证受管入口鉴权、生成同意、无持久任务，以及挂起中的本机 Ollama 请求在 HTTP observer 断开后关闭 provider 连接、不重试并释放执行槽。此证据更新表格中“未在新服务二进制 smoke”的早期状态；真实云模型成功响应与质量评审仍缺失，发布资格仍为 false。
