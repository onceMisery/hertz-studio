# 当前路线的能力与发布验收矩阵

## 2026-11-19 组合图层分组与顺序编辑

本轮从 `feat/zcode-design-completion/62d2b8b` 继续，补齐组合编辑器的层级列表、父组选择、2D/3D 组创建、同组/根层排序和效果执行顺序。结构编辑进入原撤销/重做、自动保存与不可变版本流程；位置示意继承父组变换和可见性，拖动使用父组局部坐标。用法和合同见[作品说明](wallpaper-works-playlists.md#组合图层分组与顺序2026-11-19-增量)。

| 检查范围 | 已执行结果 | 证据 |
| --- | --- | --- |
| 原生结构编辑、保存/重开与不可变包 | 6 项通过；包含原子失败、CAS、空间/循环/八层边界、128 个最长 ID 排序信封 | [结构测试](../output/composition-hierarchy-20261119/native-structure-r3.log) |
| 原生完整库，Rust 1.88、`--test-threads=1` | 982 通过、0 失败、2 项设备测试按原设置忽略 | [完整回归](../output/composition-hierarchy-20261119/native-library-final.log) |
| Chromium 图层与顺序编辑 | 9 组通过、零页面错误；分组、父组拖动、撤销/重开、焦点、未知回执、冲突与 1120/520/360/320px | [界面结果](../output/composition-hierarchy-20261119/browser/results.json) |
| 原组合编辑器回归 | 14 项通过 | [原界面回归](../output/composition-hierarchy-20261119/browser-composition-ui-final.log) |
| 实际 Rust IR、已发布 bundle、SwiftShader 像素/媒体/字体 | 66 项通过；嵌套半透明组排序像素符合预期，沿用同一个 renderer | [实际渲染](../output/composition-hierarchy-20261119/renderer-r2/evidence.json) |
| 前端默认检查 | 500 文件语法、86 步通过；包含 API 216 条、ADR 418 项与脚本登记 | [聚合检查](../output/composition-hierarchy-20261119/frontend-final.log) |
| 独立 Full/native，Rust 1.88 all-targets | `cargo check --locked --offline` 通过 | [构建检查](../output/composition-hierarchy-20261119/full-native-final.log) |

完整库测试后的改动只涉及 App 无关格式恢复与渲染夹具的 `CHROME_PATH` 启动配置；事务、结构算法和其测试源码保持冻结摘要。随后 Full/native 与实际 renderer 以更新后的候选重新验证，源码身份和执行读回汇总于[本轮证据](../output/composition-hierarchy-20261119/verification.json)。原生编译仍有 5 条既有警告，测试构建有 3 条。渲染夹具日志中的故意无效 shader 属于原拒绝测试，不代表正向渲染失败。

这些结果覆盖本机结构编辑切片，包含真实 SQLite/包/编译器和 Chromium fixture；没有据此认领生产 WebView2、多设备、长稳、完整 P2/P3/A01–A10 或 G3-S 资格。原默认并发测试隔离限制和下方各次历史证据范围继续保留。

## 2026-11-19 原生社区作者与举报客户端

本轮以 `feat/zcode-design-completion/6fae95b` 为起点，补齐独立设置社区页的
“我的创作”：本地固定版本核对、作品认领、上传、单独送审和本人状态查询。
公开作品的举报绑定已签名确切版本，提交者可按原编号查询处理结果。确认绑定
当前设置窗口、来源和账号，五分钟后失效；包使用原 AssetStore 固定只读句柄与
完整 SHA-256。Hub 新增本人账号、未送审上传分页和原操作查询，读取原账本，
没有新增业务状态存储。源码、执行命令、日志和提交读回汇总于
[本轮证据](../output/design-gap-completion-20261119/verification.json)。

上传完成与送审保持两个用户动作。成功上传可从 Hub 原 uploads 账本恢复；
已经发送但回执丢失、损坏或操作取消时保留原请求定位，只查询原 UUID。
重新继续 reserved 上传仍需核对同一包并由用户明确操作。页面持久信息仅含
来源、账号及恢复定位，不含 token、文件路径、举报正文或同意票据。

| 检查范围 | 已执行结果 | 证据 |
| --- | --- | --- |
| 原生完整库，Rust 1.88、`--test-threads=1` | 976 通过、0 失败、2 项设备测试忽略 | [完整回归](../output/design-gap-completion-20261119/native-library-author-final-r3.log) |
| Hub、Signer、共享壁纸及其集成/doctest | 15 + 17 + 103 + 275 + 7，共 417 通过 | [完整套件](../output/design-gap-completion-20261119/contracts-author-final.log) |
| 原生作者传输与固定包 | 5 项真实回环 HTTP 测试通过，覆盖固定文件流、认证、取消/账号换代、坏回执和禁止重定向/重放 | [传输测试](../output/design-gap-completion-20261119/native-author-transport-r2.log) |
| 引用删除夹具的启动维护等待 | 同一原用例在 10 个独立进程全部通过 | [重复执行结果](../output/design-gap-completion-20261119/reference-fixture-loop-results.json) |
| Chromium 作者/举报流程 | 8 组通过，零页面错误和对话框；包含重载、未知结果查询、账号/来源隔离、过期、键盘和 1120/520/360/320px 布局 | [浏览器结果](../output/design-gap-completion-20261119/browser-author-resume-r3.log) |
| 前端默认检查 | 499 文件语法、86 步通过，0 失败 | [聚合检查](../output/design-gap-completion-20261119/frontend-author-final.log) |
| 独立 Full/native，Rust 1.88 all-targets | `cargo check` 通过 | [构建检查](../output/design-gap-completion-20261119/full-native-author-check-r3.log) |
| API、ADR、脚本登记及限定格式 | API 216 条、ADR 418 项和脚本登记通过；任务源码与改动片段格式核对通过 | [证据索引](../output/design-gap-completion-20261119/verification.json) |

原生全库结果限定于单线程；默认并发运行仍受全局根目录测试状态与 SQLx
准入相互干扰，原历史通过基线同样使用单线程。三处夹具前置条件已修订：
会话在实际 SQL 等待处过期；重开循环在每次真实只读检查之后等待原池退出，
避免累积自身未关闭的费用；引用删除用例等待库初始化的候选维护实际完成，
再核对原引用和版本绑定。后者曾与原维护争用内容写门并得到合法的
`budget_busy`，现在用仅测试构建存在的完成观察消除该用例的前置竞争。
这些修订不重试删除请求、不禁用维护；产品预算、准入、内容写门与退出守卫
保持。本轮不认领默认并发测试隔离已经修复。

这些结果覆盖隔离 SQLite、原生测试与 Chromium fixture，不替代真实 OIDC、
WebView2 对生产 Hub 的完整上传旅程、独立 OS 主体/Signer IPC、生产签名、
断电恢复、部署或另一台客户端验收。Full 原生库仍有 5 条编译警告，原生测试
有 3 条，Signer 有 2 条。完整 P3/A01–A10 与 G3-S 仍开放，社区 Web 上传和
执行保持关闭。下方历史记录只覆盖各自候选和当时范围。

## 2026-11-19 社区安全与恢复专用验证

本轮以 `master/51979a5` 为起点，沿原批准设计新增 58 项行为测试：Signer 17 项、
原生社区 41 项。测试使用隔离账本、信任库、实际包归档和公开测试密钥；JWT
只验证注入的缓存 JWKS，没有访问真实 OIDC 提供方。原生完整库回归通过 963 项，
零失败；另有 2 项既有测试因需要真实默认音频渲染设备而忽略。最终命令、源码
身份、日志与本地提交记录汇总于
[本轮证据](../output/continuation-20261119-security/verification.json)。

| 检查范围 | 已执行结果 | 证据 |
| --- | --- | --- |
| Signer 审批、意图、水位、检查点及工作代际恢复 | 17 通过 | [完整套件](../output/continuation-20261119-security/contracts-signer-hub-final.log) |
| 原生 trust、PKCE、JWT、订阅、安装、Config 与回滚 | 41 通过 | [专用测试](../output/continuation-20261119-security/native-community-r4.log) |
| Hub 管理及共享壁纸单元、集成、doctest | 10 + 103 + 275 + 7 通过 | [完整套件](../output/continuation-20261119-security/contracts-signer-hub-final.log) |
| 原生重开、并发 CAS、缓存、子进程中断和升级反例 | 原失败的 22 项全部通过 | [同进程回归](../output/continuation-20261119-security/native-recovery-r5.log) |
| 原生完整库回归 | 963 通过、0 失败、2 项设备测试忽略 | [完整回归](../output/continuation-20261119-security/native-library-r7.log) |

实证修复位于原 owner：Windows 祖先 ACL 识别确切 TrustedInstaller 并允许只创建
新子目录，私有对象与既有路径仍受保护；Signer 恢复拒绝等待 SQLite 关闭后返回；
PKCE 流只允许一次等待；trust 身份预检明确等待自己唯一连接的 worker 关闭，
避免把其它合法连接误算为未退出。一般池、逃逸连接和独占迁移仍用原 OS
探测保留额度。两个 AI 重启夹具现在释放整个 Library，使独立 trust 池一起退出。
懒初始化测试沿既有 SQLx 费用测试模式，在独立子进程执行完整原用例，隔离其它
夹具尚未释放的全局额度；产品预算、准入与退出守卫保持。

开发依赖仅增加已锁定的 Ed25519 2.2.0 依赖边；锁文件身份已同步，原目录分配
计量套件通过，解析版本、特性、93,603 字节冷界限与 92,067 字节保留量保持。
原生回归仍有 3 条编译警告，Signer 有 2 条、Hub 有 1 条；本轮不认领零警告。
本轮没有新增界面、真实声卡、生产 OIDC、独立 OS 账号/IPC、生产签名、断电、
部署或正式发行验收。G3-S 未合格，社区 Web 执行关闭；P3 与完整 A01–A10
仍开放。下方 2026-11-18 及更早记录只表示其对应候选与当时范围。

## 2026-11-18 DBX 桌面功能退役与开发验证

当前 `master/7a50d34` 加未提交工作区已将桌面歌词、壁纸、桌宠/迷你窗、原生设置/校准交接和壁纸 AI 接线移出 DBX Standard/Full。本轮起点为 `f3c821c`；收尾期间既有启动页/预加载改动由外部提交，随后补跑当前 HEAD 的分版、独立编译、前端和 DBX 浏览器检查。独立播放器 `desktop-host` 与原 HTTP feed 继续拥有这些能力；DBX 保留音乐、普通歌词、沉浸舞台、舞台素材持久化及原 SDK/stdio 和普通浮窗。历史 DBX Profile/授权/设置域保留，原生宿主拒绝启动或切换到 DBX 来源；无用户数据清理。新要求覆盖下方历史 DBX 可选桌面范围，旧产物/运行时证据不适用于本次候选。

本机 Rust 1.88 的实际 Standard/Full wrapper `cargo check`、依赖图和 UI 生成检查通过，两版均不引入 `hertz-desktop`、Tao/Wry/tray/WebView2。真实 Chrome `allow-scripts` opaque iframe 对原源码、生成 Standard 和生成 Full 三种页面检查通过：没有桌面 DOM/无障碍入口或桌面资源/请求，普通歌词偏移、播放和歌词呈现仍可用。校准浏览器 16 组、独立歌词设置浏览器 11 组与独立来源渲染回归通过。截图已查看；560px DBX Hertz 主界面仍有既有宽布局裁切，本轮未将其认定为响应式验收通过。

当前独立 Full/native 编译、桌面门面三种形态各 4 项、两种形态协议发现各 1 项、插件 AI capability 3 项，以及原生配置 42 项、窗口 19 项、管理 3 项和组件 1 项通过。新原生二进制的真实 WebView2 管理旅程包含 43 条请求/合同记录，实际 Windows 管道客户端 8 项边界通过；覆盖独立切源、CAS/写失败重试、来源过期与恢复、DBX 目标拒绝、历史域保留和原壁纸库合同。测试仅使用本轮隔离目录与认证 HTTP fixture，自有进程退出。

原社区接线的编译接缝已修复，Hub 管理 10 项、共享 wallpaper 103 项、集成套件及 7 项 doctest 通过；Signer 参与编译，但没有专用行为测试。完整前端 497 文件语法与 86 步契约/行为检查通过，零失败。最终工作区核对及具体日志/截图索引见[实施回执](../output/community-integration-20261118/implementation-20261118.json)，功能归属记录为[ADR-0014](adr/0014-standalone-desktop-ownership.md)。

以上是当前开发工作区的有限验证。DBX wrapper 仍有未使用代码警告，原生构建仍有警告；本轮没有生成或安装新的正式 DBXP/release 候选，没有复验真实 DBX 发行宿主、生产 OIDC/Signer OS 审批/签名、跨库中断恢复、物理显示/媒体键、长稳、净系统或其它 OS。原生 community trust/auth/subscriptions 没有专用行为测试，编译不授予其安全/恢复资格。G3-S 未合格，社区 Web 执行保持关闭，P3 与整条发布路线未完成。

## 2026-11-07 受控偏好与原生文本保存增量

2026-11-07 已完成[受控界面偏好迁移](ui-preference-transfer.md)与主窗口文本保存：18 个已知键的独立协议、导入预览、原模块校验、DBX 提交确认、异步舞台保存保护和原生保存/取消/失败回执已接通。UI 按用户指定的 design-taste-frontend 调整设置布局与窄屏比较。最终 Full/native 候选的十一组真实原生旅程、七组浏览器/DBX、100 项协议/宿主检查、前端 74 步、主程序 18 项及 Rust 1.88/Clippy 均通过；三个原生测试进程退出，完整身份与范围见[交付记录](desktop-release.md#受控界面偏好与主窗口文本保存)。主窗口恢复/辅助窗口、NSIS/签名及实机资格继续推进，整体路线仍未完成。

核对日期：2026-10-21。适用于 0.2.1 开发工作区，基于 HEAD `401a90376c0fa8391b5d60234103eeb381ef2c2c` 加未提交改动；不是该提交、已发布二进制或商店候选的验收结论。发布时必须用实际候选的源码、依赖和产物身份重跑，不能直接沿用开发工作区结果。完整范围仍由[产品路线](./product-roadmap.md)、[技术方案](./technical-roadmap.md)与[进度记录](./roadmap-progress.md)约束。

> 2026-10-30 起，`release.yml` 的独立形态只构建 Full；Standard 继续用于 DBX 商店候选与本地 Standard 验证。下文两版独立程序的历史构建记录保留当时事实，不再代表当前发布矩阵。

## 2026-11-07 本地程序更新资格增量

当前 Full/native 优化二进制接安装目录共享运行/独占更新、本地完整包及实际 exe 核验、原子恢复标记和失败/中断恢复。最终真实安装八组、ZIP/WebView2 五组和 DataDir/DBX 九组通过；17 项主程序测试、73 步前端、Rust 1.88 all-targets 与 Clippy 通过，实际二进制/ZIP 摘要及报告见[交付记录](desktop-release.md#2026-11-07-安装目录保护与本地更新)。签名仍为 `NotSigned`。此增量补齐下方 11-06 记录中的资料/程序互斥缺口；未提供 NSIS、数据库回退、远端签名更新或净系统/物理设备资格，未安装用户目录或发布。

## 2026-11-06 Windows 原生独立候选增量

Windows 独立 Full 构建已显式启用 `native-window`，配套无副作用 `--describe`、实际二进制能力/架构校验、包内摘要清单与启动入口。当前未提交工作树的优化构建、Rust 1.88 原生 all-targets 检查、前端默认 73 步和实际解压包五组旅程通过，详见[交付实施证据](desktop-release.md#windows-候选构建与包内启动证据)。签名状态为 `NotSigned`；未运行远端 release workflow，未安装到用户目录或发布。当前用户 NSIS、DataDir/安装目录互斥、升级/回退、WebView2 净系统与签名更新仍未完成，不以 ZIP 可启动替代发行资格。

## 2026-10-29 DBX 可选桌面接入增量

本节为已退役设计的历史证据。2026-11-18 起 DBX 桌面接入范围由上方迁移记录替代；下文保留当时事实。

当前 0.3.0 dirty 工作区的 D0–D2 已实现并通过分阶段独立规格及质量审查。最低/当前真实 DBX 运行时确认只读管道、可取消 I/O 与 Job 归属；组件固定用户独立启动。Standard/Full 原 stdio 冒烟分别 314/314、298/298，六种未授权/坏恢复状态、真实管理等待中的 EOF 取消、授权与配置迁移、原生只读限制及五皮肤实际 opaque sandbox 检查通过。保存默认设置视图、换肤恢复与 Escape 不触发桌面检测。

配套组件 zip 已完成清单/hash、无副作用 `--describe`、真实运行中覆盖拒绝、退出后升级和配置备份恢复检查。最终 Standard/Full unsigned 包体及配套标识核验通过，包内原回归分别 314/314、298/298，最低/当前真实运行时再次加载通过；新 Standalone 原 HTTP/native 流程通过。隔离 DBX 0.6.39 覆盖显式连接/切源及撤销/停止/正常退出的数据清空。官方最低 0.6.35 / 当前 0.6.47 两版插件另完成无组件未授权播放/seek/队列、真实一分钟定时、主题/预设持久化、工作台关闭/重开和原生歌词/真实频谱；正常退出约 1.24 / 1.26 秒清空音乐数据，组件随后正常退出。当前 Full 另通过一次真实在线取词并向原生提供 43 行文档。D3a 本地材料已准备；D3b 的物理媒体键、真实跨用户/会话、物理桌面恢复、八小时长稳、其他 OS 与签名发布仍待验，完整 D3 保持未完成。实际产物身份、既有初始化 CSP 调用栈、其余控制台错误及每项限制以[专项验证记录](./plans/2026-10-28-dbx-desktop-evidence.md)为准，不把本增量套用到历史 0.2.1 候选。

## 2026-10-23 远端自动化与构建增量

本次通过 GitHub API 核对 `origin/master` 提交 `2f2765c2867f9295ab28dd05aff21bc9ae324b17` 的远端运行结果；未在本机重跑产品测试或安装候选。以下增量只替换旧记录中相应的“远端未核对”状态，其余历史本机证据仍绑定各自源码和产物。

| 证据 | 核对结果 | 范围 |
| --- | --- | --- |
| [CI 39815799925](https://github.com/onceMisery/hertz-studio/actions/runs/39815799925) | 13/13 job 成功，`head_sha` 与当前基线一致 | Windows/Linux/macOS × Standard/Full 的 stable 格式、Clippy、测试及 Rust 1.88 全 target 检查；另有一个 Linux smoke |
| [release 构建 39815999209](https://github.com/onceMisery/hertz-studio/actions/runs/39815999209) | 13/13 job 成功，同一 `head_sha` | 两版独立程序的 Windows x64/Linux x64/macOS ARM64 构建、两版三 OS 插件打包，以及校验和汇总 |
| 上述构建的 artifact 元数据 | 12 份分项产物及 `dist-all` 汇总存在，核对时均未过期 | 只核对元数据，未下载/解包、未复算二进制 SHA-256；安装、升级/回滚、签名与 Store 不在此证据内 |

release workflow 由 `workflow_dispatch` 手动触发，只保留 artifacts；运行成功不代表自动发布。真实声卡/设备切换、正式 MCP 客户端、原生 DBX 完整旅程、实际账号、模型质量及长时资源仍分别待验。下一批候选绑定与验收任务见[开发计划](./plans/2026-10-23-next-development.md)。

## 2026-10-23 Windows 0.2.1 验收候选（本机构建）

本次在同一源码提交上生成四份 Windows x64 候选：Standard/Full 独立程序各一份、Standard/Full DBX 包各一份。只冻结候选身份并核对包体与元数据；未安装、未启动、未签名，也不代表 PLAY-01 或发布验收通过。

| 身份项 | 值 |
| --- | --- |
| 源码 | `27638bbc58af25b31b74c3a581d7c17a5ec7b2fc`（`codex/roadmap-next-steps-20261023`），构建时工作区干净 |
| `Cargo.lock` SHA-256 | `5f55b733bd121b23d539296f754929a39d0347de4938d79e406582327d466c4c` |
| 版本 | 0.2.1，Cargo 与 `plugin/manifest.json` 一致 |
| 工具链 | cargo/rustc 1.98.1，host/target `x86_64-pc-windows-msvc` |
| 构建主机 | Windows 11 `10.0.26200` x64 |
| DBX 打包 CLI | `@dbx-app/plugin-cli@0.1.2` |

| 形态 | 候选文件 | 大小（字节） | 包体 SHA-256 | 内部身份 |
| --- | --- | --- | --- | --- |
| 独立 Standard | `hertz-studio-standard-0.2.1-x86_64-pc-windows-msvc.zip` | 12,493,309 | `b67da054c809f26103c1875fd7adc4b53bb03972bc5c06229d7609072bf94392` | `hertz-studio.exe` `ebe0125c09f74dc55d68d364310e0c98f26b8dc9828f3d5af3bc60e3e33e37f0` |
| 独立 Full | `hertz-studio-full-0.2.1-x86_64-pc-windows-msvc.zip` | 13,251,517 | `09d8185088a129f3e5fbccd33fb10857cfb0b3b3ee09724692d8818b42f5522a` | `hertz-studio.exe` `d04a562d8f50897596fa1ed07f7e5140b66f617101f242da2c08de019c612ee4` |
| DBX Standard | `io.github.oncemisery.hertz-studio-0.2.1-windows-x64.dbxp` | 11,342,810 | `536cea26986a186f2c559020d7e25c3bbb047d522460bf1da9a0b0dcc4cf1fd8` | manifest `io.github.oncemisery.hertz-studio` 0.2.1；sidecar `b44fe4ccc1617ff6d51010e55655cd9ac00cb01e07f38ed561573ddfff2bd203` |
| DBX Full | `io.github.oncemisery.hertz-studio.full-0.2.1-windows-x64.dbxp` | 12,093,282 | `e56d33bce8006a48a015f55d0599886249447b083c5944e8bf97cb7ce0790335` | manifest `io.github.oncemisery.hertz-studio.full` 0.2.1；sidecar `7edf005e9a9a82b9abf6f2a144756af84ca72b9eb78c383228de36e6eaed790b` |

构建命令与当时的 `release.yml` Windows 分支一致：两版分别执行 `cargo build --locked --release -p hertz-studio --target x86_64-pc-windows-msvc`（Full 加 `--features full`），随后按 `<名称>/hertz-studio.exe + README + LICENSE` 组包；DBX 包执行 `HERTZ_EDITION=<edition> bash scripts/ci-package-plugin.sh`（未设 `PLUGIN_RELEASE`）。两版独立构建共用同一 target 路径，故每版 zip 都在对应构建结束后立即生成，表中 exe 哈希即当时产物。

同轮静态检查：`node scripts/check-editions.js` 与 `node scripts/check-release-ui.js` 通过；打包脚本逐包核对 `.artifact.json` 的 hash/size、未签名、manifest 身份、Standard 侧仅一个 sidecar 且不含 Full 协议/资源。以下仍未验证：四份候选的启动与安装、升级/回滚、签名与 Store、真实 DBX 宿主、真实声卡与播放旅程、正式 MCP 客户端、模型或任何 provider 请求。两个 `.artifact.json` 的 `url` 为裸文件名而非不可变 Release URL；它们是检视候选，不是上架候选。

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
| 桌面歌词、壁纸与原生辅助窗口 | 本地开发保留 | 独立发布形态保留 | `desktop-host`、原 HTTP feed 与原生配置/库 owner | 已移出；无桌面桥/管理/校准/壁纸接口或专属 UI | 2026-11-18 两版实际 wrapper/依赖图/生成 UI、三形态 Chrome 负例、独立 Full/native 与隔离 WebView2 管理通过；历史 DBX 数据保留。物理显示、长稳、生产安全/恢复及正式产物仍待验，见本页最新增量 |
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
