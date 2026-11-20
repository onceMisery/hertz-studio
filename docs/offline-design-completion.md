# 离线设计缺口实施记录

2026-11-20，起点 `10eb65d3cf154da8d6d40ef24b44b67d2d28b2b9`，工作分支 `codex/offline-design-completion`。按用户要求直接实施后验证，不采用 TDD；测试使用隔离数据目录、受控本地生成响应和现有浏览器，不调用收费模型。下面区分已落地的软件能力与尚未通过的资格门，不能据此将所有设计验收门标为完成。

同日合回 `feat/zcode-design-completion` 时，保留原分支 `fe207e3` 的懒加载及空闲停止绘制。凤凰素材仍按需读取，由构建生成小型来源元数据，使预算检查无需提前加载大素材；读取/JSON/解压及像素数据归当前场景租约，退出或取消等待真实读取结束后释放。HTTP 页面无需额外 WebCrypto 条件。合并后的前端 87 步、桌面 Rust 1048 项（3 项忽略）、81 次实际 Three 生命周期、凤凰 21 次生命周期、11 项 HTTP 浏览器场景及三档/竖屏资源检查通过；独立合并审查已关闭兼容问题。先前工作树的 1352 份证据、检查点与候选二进制按 SHA-256 核验后保存在主工作区 `output/offline-worktree-evidence-20261120/`，索引为 `preservation-manifest.json`。这些仍是本机验证资料，不随普通克隆分发。

| 设计条目 | 当前实现 | 已执行的软件证据 |
| --- | --- | --- |
| 本地生成时暂停动态壁纸 | 默认勾选，仅本地报价生效；原生按请求和服务代际持有暂停租约；派发后的取消/失联保留未知状态，明确恢复只移除该任务原因 | generation 22、policy 17、session 13、视频 1、预览恢复 5、页面 4 组；受控 Ollama 原生完整流程 11 组，真实预览在请求期间冻结、成功后恢复；独立审查四项发现已修 |
| P2 动态组合 | 模型变换、opacity、动画权重/速度的轨道与绑定；固定求值工作区；builtin 背景与二维轨道及输出效果 | 当前共享包真实 Rust IR + Chrome 76 组、builtin 14 组、plan 18 项，原生成本 49 项；保留 builtin/model 互斥和未支持的类型边界 |
| 有许可证作品改编 | 明确“另存为新作品”，新 workId、原来源和 variant 字节、完整署名及 legal 附件；迁移 0013；ND/未知/不具资格的传递来源拒绝 | 46 项草稿回归、service 权限/重放、迁移；真实 ImportJobs 重导入新库、删原来源、重开及再次改编 |
| 组合镜像和 AI 目录 | 原目录声明 absolute/integrated；仅可重建节点及无历史效果进入镜像；实际公开值、视频区间和整个轮播均核验；原生组时钟与 typed reveal | 最终全桌面 1047 项通过、3 项按条件忽略；设置页 35、运行时回归；修复相位后的真实原生发布/首帧/暂停恢复/下一项重新计时/关闭四组通过；单物理屏 |
| M1 封面 | 原缓存和真实消费者借用；有界等待；pending 卸载、旧图回执、缓存失效按原 owner 退休 | 17 VM、14 Chrome、9 media 场景；四项独立发现已关闭 |
| M1 Coast/Zodiac/Space | 唯一 Stage 帧门、冻结与零增量恢复、显式 context 重试；来源资源预留、全部 factory 串行换场预检、原 wireframe cache 和部分构造清理 | Coast/Zodiac 9 组，Space 33 组；28 个 pinned geometry 公式、81 次原 factory 生命周期、29 场景三档/竖屏/退出账本检查；独立规格与质量复审通过 |
| M1 Pixi | 原 GL/cache/pool 分配与 typed/位图/数值源准入；全曲歌词与布局用途；probe、批次、uniform 元数据中途失败清理 | 19 组真实 Chrome、9 个验证入口；两轮独立发现均关闭 |
| M1 分享/工程数据 | 原 StageJsonSource 租约；编码、解码、gzip、工程捕获、应用、文件/剪贴板/下载等待及 retained Blob 的真实生命周期 | 16 组 Chrome、43 组 M1 Creative、477 Creative、44 codec 与工程/模板/物化回归；四项独立发现已关闭 |
| M1 视频录制 | 原 VideoExport 在默认配额内冻结 8–32 MiB 视频块容量，并预留最终 Blob 共存空间；沉浸原 owner 提供源租约与补帧；旧源失效只通知对应会话 | 9 项导出、12 项 Stage3D、20 轮真实 Chrome 编码；完整 MP4、竖屏 WebM/合成音轨、390px、容量拒绝、未创建源启动、迟到旧会话与新会话隔离；独立发现已修复并复审通过 |
| M2 频谱双模式 | `towers-flat` 平面构图与 `towers` 深度/透视共用参数定义、seed、相位及族内活动 cue；原工坊模式按钮 | 11 场景三档像素、100 次模式切换、暂停/seek/reduced-motion、真实键盘/焦点/390px 与分享往返；Rust 11 场景契约及分页验证 |
| M3 离线评测 | v4 共 172 条：127 development、45 holdout；97 candidate、75 refusal；保留 v3 原 160 行 | 原物化器结构检查及规则基线；16 KiB 合法 JSON 边界和超一字节拒绝；不等于独立语义评分或模型评测 |
| M4 参数创作工具 | 原模板/物化器、源码与工具链锁、独立受限进程、多档渲染、人工待审包及拒绝未批准入库 | 当前源锁四档渲染及回收通过；18 个无效输入、进程超时/文件权限/环境与待审拒绝通过 |
| 免费 AI-06 / MCP | 官方 SDK → 原 adapter → 服务 → 原生确认/生成/切换；MCP 输出 schema 接通双模式 metadata | AI-06 18 组、SDK 9 场景和 12 个客户端正常退出；AI 服务 253 项通过、1 个子进程 fixture 忽略；当前 schema 新构建的真实 MCP stdio 10 工具、分页、验证与陈旧 hash 拒绝通过 |
| DBX 视频传输 | 保留原分块 lease 与浏览器 MSE 解码路径 | 当前真实 Chrome 解码 WebM 五次读取和 MP4 三十次读取，隐藏恢复、释放停止读取及不支持 codec 拒绝通过；未冒充正式 DBX 宿主 |

最后的实际 Wry/WebView2 检查使用独立构建的 Standard 和 Full 开发候选，按二进制 `--describe` 的真实 edition/profile 重建并逐字核对内嵌资源。Full 七组通过，包含创意、沉浸与空间各 60 秒真实运行及退出。Standard 的创意/沉浸运行通过；同轮空间系统观察脚本曾超时，保留该失败记录，停止其它构建后单独重跑空间、暂停/seek、最小化 60 秒、恢复和资源退出六组通过。两份结果共同说明当前覆盖，不将首轮写成全部通过，也不等于发行版、弱设备或长稳资格。报告为 `output/a09-m1-20261108/native-standard-2026-11-20T06-10-41-765Z/`、`native-full-2026-11-20T06-15-08-436Z/`，首轮另在 `native-standard-2026-11-20T06-01-13-545Z/`。

最终 Full 内嵌组合生成十一组、图片生成十组通过。组合包含所选许可素材、生成/预览/保存/重开、编辑与撤销、真实原生文件导出和重新导入，核对包及全部资源哈希与署名闭包；使用的是本机受控生成响应。当前前端聚合 87 步、ADR 421 项、357 个检查脚本登记通过。前端默认聚合不自动执行全部浏览器入口，本文列出的浏览器/原生检查另行执行。

最终 Rust 桌面库（启用 `wallpaper-media-probe`、串行）1047 项通过，3 项忽略分别是两项真实系统音频测试和显式 Job 通知诊断；后者在本轮另行执行过。受影响 wallpaper 各测试套件合计 391 项通过，服务 AI 253 项通过、1 项原条件忽略。测试日志依次为 `desktop-all-delivery-final.log`、`wallpaper-all-r2.log`、`studio-ai-all-r2.log`；任务改动的 51 个 Rust 文件单独检查格式，不用全仓已有格式差异扩大任务。

三 crate 的 `cargo +1.88.0 clippy --locked --offline -p hertz-desktop -p hertz-wallpaper -p hertz-studio --all-targets --all-features` 成功，仍保留原社区代码可见性/未使用项和既有测试风格告警；与前轮告警集合一致，未使用 `allow` 隐藏，不宣称 `-D warnings` 零告警。最终记录为 `clippy-delivery-final.log`。

主要原始证据保存在 `output/offline-design-completion/`，真实浏览器报告还在 `output/a09-m1-20261108/` 和 `output/playwright/`。这些目录不随普通克隆分发，不能将其路径存在当成接收者已经取得证据。契约、检查脚本和受版本管理的本记录用于复现；发布验收仍须绑定当期构建。

资源账本约束应用可控的声明容量和有界数值/字符串 payload，不声称测得 JavaScript 对象头、GC、浏览器缓存或物理显存。取消不代表底层工作已经结束；窗口关闭、未完成解码、压缩流、编码器和共享源分别沿原生命周期释放。`StageResourcePolicy` 仍是有限候选策略，尚未冻结为设备资格。

仍需单独取得的外部或人工证据包括：真实模型/价格与服务合同，OIDC、Signer、生产更新及恢复，双物理屏/负坐标/混合 DPI/热插拔，弱机和目标驱动，真实系统音轨，歌词与运动舒适度人工评审、两轮模型和独立 holdout、长时间运行、M4 OS 总体隔离和人工入库批准。fixture 或源码审查不能代替这些条件。

G3-S 本轮源码绑定构建的普通 stop1 通过：受限 AppContainer/WebView2 挂载、实际首帧及七个进程自然退出均取得原始证据。扩展探针的 38 项 worker 回归通过、1 项显式诊断默认忽略；独立审查已关闭句柄误用和监听事实覆盖问题。父进程在子进程恢复前用有界 PSS 快照核验继承白名单；子进程不再解引用父进程的句柄数值。

扩展原生安全验收**未通过**，见 `g3s-native-current/candidate-evidence.json` 和 `g3s-native-final-r3.log`：

- 文件读取/写入/创建、危险父进程权限、通过只读父句柄复制 canary 均得到 access denied；继承白名单成立。
- TCP connect 与 UDP send 返回成功。本机 Domain、Private、Public 防火墙配置均关闭；即使父监听器当时没有取得数据，也不能据此推翻成功返回或判定隔离成立。
- 忙循环、64 MiB 触页和消息洪泛的强制 Job 终止最终都观测到七个物理进程退出，但没有完整 EXIT 消息，因此按原严格门判失败。单进程对照中自然退出和 `TerminateProcess` 有 EXIT，`TerminateJobObject` 缺 EXIT；没有伪造回执或改用 PID 扫描降低证明要求。较早的一次内存探针另曾出现 GPU 进程十秒退出超时，不能用最后一次成功退出抹掉该风险。

合回后继续补充 `--extended` 的 `memory-limit` 固定模式：最多 40 块 × 16 MiB、逐 4 KiB 触页，原 Job 512 MiB 限额不变，原生派发前设置独立十秒 Job 终止期限。只接受原 completion port 的 `JOB_OBJECT_MSG_JOB_MEMORY_LIMIT`（10）作为命中事实；页面异常、进程限额消息（9）或单纯内存峰值不能替代。IOCP 与控制管道退出的竞态由最终汇总读取原生不可变回执解决，所有严格退出判定保持。

`output/offline-integration-20261120/g3s-pressure-candidate/` 绑定当前源码与候选，实测 `nativeMemoryLimitReached=true`、原通知为 10，Job 终止且 `activeProcesses=0`，独立压力期限没有触发。报告的 Job 峰值为 540745728 字节；这证明限额通知和终止发生，不证明进程树从未瞬时超过 512 MiB。原 fatal 规则使 close 在取得完整物理退出证明前拒绝，EXIT 回执也不完整，因此本模式 `passed=false`，不能记成完整内存或 G3-S 资格通过。节点五项夹具检查、38 项 worker 回归及 1 项通知分类反例通过，独立复审已关闭报告竞态。

当前基础网络和强制退出门仍被实际环境阻挡。完整 renderer 网络协议矩阵、重复图形/解码压力仍未实现或未验；它们是后续软件验证缺口，不能描述为缺 token。物理 GPU 归属与长稳另外需要设备证据。`webEnabled` 和完整 G3-S 资格继续关闭；本次不改变机器防火墙配置。

视频录制的原 256 MiB 固定预留与 128 MiB 页面额度冲突已经修复。较大的来源配合竖屏/1080p 仍可能超出 64 MiB 解码工作区；现在在采集前给出可行动的拒绝信息，缩小窗口后可重试。较广工程、草稿及模板浏览器流程通过，草稿夹具改为符合实际格式校验的 PNG，并等待异步导入和租约释放。源式容量、系统真实音频与设备资格的区别见[视频导出](video-export.md)。
