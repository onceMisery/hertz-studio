# Windows 原生播放器交付实施

日期：2026-11-07。范围：设计盘点 A08 的交付链，承接 [桌面产品目标](desktop-client.md) 和 [同进程主窗口路线](aegis/specs/2026-11-04-r5-native-main-window-design.md)。整体尚未完成。

## 方向与约束

用户结果是从交付包直接打开已有播放器，并能识别其实际版本、发行版和原生能力。唯一程序仍为 `hertz-studio.exe`；窗口、音乐服务、歌词/壁纸均沿用同进程实现。DBX 的可选组件包保持其独立分发用途。

第一性原理复核：旧方案中的 Tauri 主程序、sidecar 与第二份组件目录已由后续同进程方案替代；为了安装再恢复这些程序会增加生命周期和版本协调。采用现有程序的原生 feature、包内只读描述及构建内容身份即可证明候选具备哪些能力。Git 提交号不能单独描述当前脏树；SHA-256 证明文件完整性，不能代替发布者签名。

交付按以下依赖继续，便携候选不是安装/更新的替代验收：

1. Windows Full 构建显式启用 `native-window`；增加无副作用 `--describe`，在任何数据库、音频、窗口初始化之前输出编译身份。
2. 根据实际待打包二进制核验 edition/target/profile/native 能力，生成内容摘要清单、独立启动入口、许可材料和 ZIP。只产本地/CI artifacts，现有手动发布权限不变。
3. 从解压包中的入口启动真实 WebView，验证不依赖源码/Cargo/Node、独立 DataDir、重复打开和退出；错误架构/发行版/非原生二进制、损坏和同名输出拒绝。
4. 安装升级的前置：DataDir 排他、程序目录共享运行/独占更新、运行中覆盖拒绝已接 standalone 与本地更新入口；主业务库与独立壁纸库/原包/配置升级恢复已实施，安装器后续复用相应目录准入协议。
5. 当前用户 NSIS 安装、快捷方式、卸载保留数据与失败恢复；WebView2 缺失时明确说明依赖，安装运行时需要用户许可。离线净环境资格另计。
6. 使用实际签名凭据和确定的更新源完成验签、升级与发布候选矩阵。当前未取得这些外部材料，不制造假的签名或发布地址。

macOS/Linux 暂保留已有服务产物；Windows 原生能力不能推广成其它平台的桌面交付。CI 已新增 Windows stable / Rust 1.88 的 `full,native-window` all-targets 检查，1.88 本机检查已通过；尚未触发远端 workflow。正式签名/更新、净系统、多 DPI/物理设备与其它平台的资格持续保留在 [设计盘点](design-implementation-audit-2026-11-05.md)。

## 不能被打包结果覆盖的桌面产品工作

按 `desktop-client.md` 的用户结果继续追踪，历史 Tauri 实现细节不恢复：

| 要求 | 当前可核实状态 | 后续证据 |
| --- | --- | --- |
| 原生窗口/后台/退出/SMTC | 已有独立实施记录和真实 Windows 证据 | 当前发行候选级回归与实际物理设备资格 |
| 同资料目录互斥 | 2026-11-07 已接共享 prepare/boot 的服务内核锁和旧版 AI 锁兼容检查，原生恢复走鉴权/实例绑定 HTTP，见[实施记录](data-directory-ownership.md) | 独立版/DBX、同目录不同端口、目录别名、同时启动、崩溃释放、失败配置/数据库、迁移占用和原生恢复已有真实进程证据；安装目录升级闸门另计 |
| 安装目录升级保护 | 已接共享运行、独占本地更新、实际 exe 校验、原子标记及[当前用户 NSIS](windows-installation.md) | 新 NSIS 十八组和原更新器八组通过；签名源、净系统和物理断电继续单列 |
| 窗口状态恢复 | [正常矩形与最大化持久恢复](main-window-recovery.md)已实施 | 已有十一组实际 Windows 证据；物理多屏／混合 DPI 仍需专项资格 |
| 文件操作与辅助窗口 | [原生文本保存](ui-preference-transfer.md)与[受控 OBS 预览](native-obs-preview.md)已接通 | 文件／偏好十一组及独立 OBS 正式九组分别保留候选身份；其它文件与窗口交互继续定向跟踪 |
| 原生回环与响应边界 | [仅原生模式的 bind/Host/Origin 门禁和可信 HTML nonce/CSP](native-http-boundary.md)已实施，普通 LAN 与 DBX 契约保持 | 当前8af3候选HTTP十二组、OBS正式九组、配对e778 Full DBX/HTTP八组及Rust1.88/Clippy通过，源/候选一致、自有进程已退出；旧候选结果保持各自身份 |
| 主业务数据库升级保护 | 2026-11-07 已实施一致性数据库/素材恢复点、未来/异常迁移账本拒绝、迁移失败回退与显式历史恢复/救援，见[记录](database-upgrade-recovery.md) | 优化候选真实进程十三组、独立审查与存储回归通过；独立壁纸库见[完整资源/配置恢复](wallpaper-upgrade-recovery.md) |
| 普通 JSON 备份一致性 | 2026-11-07 已接单一读取事务、歌单所属快照及空歌单导出，v1 与凭据排除保持，见[记录](json-backup-consistency.md) | 新 release 的 HTTP/SDK 七组、store63、播放器 lib987、MSRV/Clippy 与独立审查通过；界面偏好和原生文件保存继续单列 |
| 界面偏好迁移 | [受控导出、预览与白名单导入](ui-preference-transfer.md)已实施 | 十一组原生、七组浏览器／DBX 及协议边界证据分别记录；凭据仍排除 |
| 完整发行资格 | 本机优化包及当前用户 NSIS 已有候选级定向证据 | 净系统／离线运行时、签名更新、真实音频、性能／长稳和 DBX 当期候选仍待专项验收 |

以上属于 A08 内的剩余工作；P2/P3/AI、LAN 原生采样率、统一舞台引擎等其它未完成项目仍以总盘点为准。

## Windows 候选构建与包内启动证据

2026-11-06 在当前未提交工作树完成，未触发远端工作流、安装到用户目录或发布。`release.yml` 的 Windows Full 产物现显式启用 `native-window`；其它 OS 保持原服务构建。`--describe` 在窗口/MCP/配置/数据库启动前返回编译能力、Rust 编译器、target/profile、实际嵌入 UI SHA-256 和基于内容的 build ID；即使带 `--window`/`--mcp-stdio`/`--data-dir` 也不会创建资料。

[打包程序](../scripts/package-standalone-windows.js)复制确切二进制后核验 PE x64、描述协议、Full、原生能力和 release profile。旧二进制会忽略未知参数，因此在运行描述前先检查协议标识；协议标识是兼容性检查，不是发布者认证。随后从实际文件生成摘要清单、实际 Authenticode 状态、启动入口、安装说明及许可材料。ZIP/清单/校验和均拒绝覆盖已有同名输出，失败只回收本次创建的产物及验证过范围的临时目录。

| 项目 | 实际结果 |
| --- | --- |
| 优化构建 | `cargo build --locked --release -p hertz-studio --bin hertz-studio --features full,native-window` 通过；Rust 1.98.1，Windows x64 |
| 最低工具链 | `cargo +1.88.0 check --locked -p hertz-studio --all-targets --features full,native-window` 通过 |
| 编译告警 | native bin Clippy 通过，沿用前轮三类基线豁免 `manual_is_multiple_of/unnecessary_fold/chunks_exact_to_as_chunks` |
| 前端 | 默认 73 步通过，411 份 JS 语法检查通过；包准入反例、API 清单与脚本登记通过 |
| 实际包旅程 | [最终报告](../output/playwright/standalone-package-1793979171459/report.json)五组通过；实际 CMD 启动真实 WebView2，路径含中文/空格/`&`，资料路径另含单引号，PATH 无 Cargo/Node；重复打开保留原窗口，正常退出移除发现文件且程序文件摘要不变 |
| 文件证据 | 包内文件/清单摘要复算通过；错误清单拒绝；第二次打包 EEXIST 后原 ZIP 不变；[原生页面截图](../output/playwright/standalone-package-1793979171459/packaged-window.png)已查看 |

候选为 [Windows Full ZIP](../output/playwright/standalone-package-1793979171459/packages/hertz-studio-full-0.3.2-preview-x86_64-pc-windows-msvc.zip)，19,178,223 字节；ZIP SHA-256 `aa4180aad5db9506097ca0ba280bef27ede011639225996d1a6ffae7fcec428b`；exe SHA-256 `402b35e7c83079c032465902e116491e40f5031b70155c6d2e6ff292ed9cd79d`；build ID `6218dd1bf481a7434a71a76b3c3df14a99b7a3a3a0b19acbd0ce45b222459470`。签名状态 `NotSigned`，仍是未签名开发工作树候选。测试使用 null 本地音频，已有 WebView2 环境，不证明真实声音、净系统安装、离线运行时、签名、升级或回滚。

复现：设置 `HERTZ_BIN` 为实际 Full native release exe，`PLAYWRIGHT_MODULE` 为 Playwright 安装目录，再运行 `node scripts/check-standalone-package-native.js`。报告保留隔离测试资料，测试播放器已退出。

## 2026-11-07 安装目录保护与本地更新

已接程序目录共享 reader/独占 writer、完整包及真实二进制身份核验、本地文件事务、原子恢复标记、失败恢复和中断后显式 `-Recover`。实际路线与界限见[Windows 程序更新记录](windows-install-updates.md)，用户命令见[包内使用说明](windows-portable.md)。没有 PID 登记或新常驻更新服务。只读描述、帮助/版本和评测在窗口/业务启动前分流；评测组合 `--window` 不进入原生初始化。

| 最终证据 | 结果 |
| --- | --- |
| Full 原生优化构建 | `cargo build --locked --release -p hertz-studio --bin hertz-studio --features full,native-window` 通过 |
| 编译与回归 | Rust 1.88 Full/native all-targets 及 Standard 无默认 feature bin、主程序 17/17、前端默认 73 步、all-targets Clippy 通过；Clippy 沿用上节三类基线豁免，无新增豁免 |
| 安装更新 | [release 报告](../output/install-owner-1794012615730/report.json)八组通过，覆盖多 profile、运行/更新竞争、包与真实 exe 身份错误、外部占用、替换失败、恢复标记发布前后及替换过程的实际退出、重复恢复与实际启动 |
| 真实包入口 | [release 原生包报告](../output/playwright/standalone-package-1794012615951/report.json)五组通过；真实 WebView2 从中文/空格/特殊字符目录启动、重复打开和正常退出；包文件摘要逐项保持一致 |
| 资料目录回归 | [最终 release 报告](../output/data-owner-1794012615729/report.json)九组通过，含 HTTP/DBX SDK stdio、目录别名、同时启动、崩溃/EOF/失败和旧版本兼容及原生恢复；前轮 Standard/Full 十组报告源码摘要另已复核 |
| 独立审查 | 两个 P2 边界已修正并回读：完整记录原子发布、评测命令排除原生 dispatch；余下范围无可执行发现 |

实际 [Windows Full release ZIP](../output/playwright/standalone-package-1794012615951/packages/hertz-studio-full-0.3.2-preview-x86_64-pc-windows-msvc.zip)为 21,097,319 字节；ZIP SHA-256 `83d51ef1cf1282c77ced51361907fc317e37eac1923d42ffb3ec6c00a9bc379c`；exe SHA-256 `2f6d286f19a79d074f473fe02d12b155cbfb9ee2b331ce30c4ec1014e1c4f90c`；build ID `ada3520e4c8e50e3ca5b3bc373c6acd0a7e52ee4096d769716ddd45d944f7d9a`，签名 `NotSigned`。新报告绑定本轮优化二进制，旧包记录只证明当时构建。

验证只使用本机既有 Windows/WebView2、隔离程序/资料和 null 音频。更新 fixture 在同一代码版本的候选中更改 NOTICE 及其摘要，用于证明完整文件事务，不证明跨版本数据库迁移。此节是数据库保护实施前的候选证据；新的数据库/素材旅程见下一节。未安装用户程序、未运行远端 workflow、未签名或发布；NSIS、独立壁纸库保护、远端更新源和净系统/物理设备资格仍未完成。

## 2026-11-07 主业务数据库升级保护

[实施与使用说明](database-upgrade-recovery.md)明确主库/素材一致性、私有备份、SQLx 迁移 owner、锁准入、标记、错误回退及历史救援边界。数据库版本检查在配置/HTTP 凭据/音频前；维护命令复用 shared 锁，不装配服务。独立壁纸数据库和普通 JSON 一致性未据此完成。

| 本轮证据 | 结果 |
| --- | --- |
| 存储与主程序 | `vmusic-store` 61/61；hertz-studio lib 987 通过、7 既有忽略，bin 17/17；前端默认 73 步零失败 |
| 编译与静态 | Rust 1.88 Full/native/DBX/store all-targets 及 Standard 无默认 feature bin、Clippy all-targets 通过；沿用上节三类基线豁免；相关 Rust 格式通过 |
| 数据库/素材恢复 | [优化候选报告](../output/database-upgrade-1794014976061/report.json)十三组通过：真实旧 migration、WAL、部分提交失败、只读拒绝、历史/救援、素材/空目录、hash/路径/侧文件/祖先、坏快照列表、实际升级进程被终止与受占用后部分恢复重试、HTTP/DBX 锁与维护 |
| 现有交付回归 | [安装更新八组](../output/install-owner-1794014898741/report.json)、[原生 ZIP 五组](../output/playwright/standalone-package-1794014898959/report.json)、[资料互斥八组](../output/data-owner-1794014898766/report.json)通过；此轮资料回归未传入旧版本 fixture，不复用上一轮第九组作新结果 |
| 独立审查 | [审查记录](aegis/work/2026-11-07-database-upgrade-recovery/30-review.md)：SQLite 侧文件/链接、hot journal、损坏列表与 help 等发现均已修正；最新 scoped 实现无 blocking finding |

候选 exe SHA-256 `54268b19d727ce33adb3d0d13caa3d5a1378923ef0b876f8b5a23f00d883c071`，匹配的优化 DBX SHA-256 `9348768b120b2db4806e3ea99360865b222b93b7c777cfd46c73d3c68cd35f94`。真实 [Full ZIP](../output/playwright/standalone-package-1794014898959/packages/hertz-studio-full-0.3.2-preview-x86_64-pc-windows-msvc.zip) SHA-256 `ef1536fd2bfb9a50e4975a3a2edf0abafbaa9177bfe2d7866378370ba42d60ad`，build ID `446d162dee2b70f562fb9f100bc68f3ecd186237f675ae3360c2f7e609af7c30`，签名 `NotSigned`。同一代码候选配合真实 27/28 迁移 fixture 验证数据库版本升级，不声称经过跨发布版本或旧 exe 的完整升级旅程。

剩余包括独立壁纸库/资源与配置恢复、普通 JSON 一致性、界面偏好迁移、NSIS 与签名、净系统/物理设备和远端发布资格；整个 A08 和用户完整目标保持未完成。工作记录见[证据](aegis/work/2026-11-07-database-upgrade-recovery/90-evidence.md)。

## 独立壁纸恢复与同批优化候选回归

2026-11-07 增量已经完成[壁纸库生产保护](wallpaper-upgrade-recovery.md)。上节“独立壁纸库”是当时尚未实施的范围，本节更新为已实施且通过本机候选验收。共享 SQLite 机制只持有快照、标记和替换协议；音乐与壁纸各自持有迁移集、资料准入及资源范围。

桌面启动在配置、窗口和 feed 前检查既有库；当前库保留多宿主共享与首次懒建库，待升级库和离线恢复必须独占。配置写者、后台素材及仍存活的 pool/connection 都保留根准入；独占端额外检查真实 SQLite 文件句柄关闭。壁纸恢复范围是 packages、staging、derived、config.json 和 operations。历史恢复后撤销旧外部导出路径与文件身份，不自动写入或清理外部文件；无效请求和成功升级不撤销当前导出。

| 最新优化候选验收 | 证据 |
| --- | --- |
| 壁纸升级/恢复七组 | [报告](../output/wallpaper-upgrade-1794018861800/report.json)：真实旧迁移/WAL、部分提交失败、异常未来库拒绝、资源/配置/救援、外部导出屏障及实际恢复进程中断后的拒绝/恢复/重试 |
| 音乐升级/恢复十三组 | [报告](../output/database-upgrade-1794018880120/report.json)，与壁纸运行串行，均使用当前三个 release 文件 |
| 原生内嵌六组 | [报告](../output/playwright/desktop-embedded-1794019004881/verification.json)：三轮同 PID、16 并发命令，活宿主拒绝维护；实际宿主/SQLite 停止后可维护，主窗口继续运行 |
| 壁纸作品十五组 | [报告](../output/playwright/wallpaper-works-native-1794018920912/report.json)：真实 WebView2 编辑、预览、发布、公开属性、重启、轮播/暂停/缺包重试和引用删除保护 |
| 程序更新八组、DataDir 八组 | [更新报告](../output/install-owner-1794019032051/report.json)、[资料报告](../output/data-owner-1794019176149/report.json)，实际失败/中断恢复、多 profile、DBX、同时启动及原生重复打开 |
| 包内原生启动五组 | [ZIP 报告](../output/playwright/standalone-package-1794019133272/report.json)：实际解压 CMD、中文/空格/特殊字符路径、无 Cargo/Node PATH、重复打开与正常退出 |

[候选证据汇总](../output/wallpaper-release-validation.json)复核七份报告的 62 组数量、45 个相关来源文件摘要与二进制/ZIP 摘要。当前播放器 SHA-256 `d9cc00f693cecf9b4947f351354063e5c51afec1577e962a12db58097c14e115`，独立桌面 `22077f4c3ab5c38fb6a654a022a0c3fae8a2b319992132a0991311c03c19cb44`，DBX `93923799937543faf6e32a9304b44ce8306d825afd117736c5284663a7929862`。Full ZIP SHA-256 `53887271ed1a764ab3ab3362bc5eede5b05b8bb299c9386a200d5a3093c85726`，build ID `d9718d7ecc7451c376e0b1ad6e3ea97a461192d2799bd9bf9236d82ae3d45720`，签名仍为 `NotSigned`。

最终 Rust all-targets：desktop 517 通过/2 既有忽略，shared 4、store 61、hertz lib 987 通过/7 既有忽略，bin 17、integration 7；Rust 1.88 与 stable Clippy all-targets 通过。Clippy 沿用既有三类命令行豁免，没有新增代码豁免。进程内契约十组、283 个脚本登记与 CRLF-aware diff 空白检查通过。[生产独立审查](aegis/work/2026-11-07-wallpaper-upgrade-recovery/30-production-review.md)无遗留 P1/P2，raw detached connection 和关闭竞争有真实存储回归。

验收只使用隔离资料、已有 Windows/WebView2 和 null 本地音频；不证明净系统、真实扬声器、物理断电、旧版 exe 后续自行启动、签名或正式发布。此前并行夹具的一次救援快照遇到 IO5，失败发生在替换前，未据此宣称根因；最新串行音乐十三组通过。中断夹具已改用可观察的历史恢复暂存窗口，旧报告不冒充最终证据。内嵌脚本修正了 Windows 规范路径身份比较，并按已有原生生命周期契约接受 shutdown 的 202。

普通 JSON 一致性、受控界面偏好迁移、NSIS/签名、窗口与原生响应剩余项、净系统/物理设备及其它总盘点项目仍继续跟踪；整个目标保持未完成。

## 普通 JSON 一致性增量候选

2026-11-07 后续已完成[普通 JSON 一致性](json-backup-consistency.md)，更新上节当时仍待实施的范围。业务 JSON 的五部分读取同一个 deferred SQLite 快照；单次 membership 联接保留同曲不同歌单快照，歌单按 ID 分组并保留空项。v1 输出、tuple 扫描目录、按名称合并的事务恢复及秘密前缀/受管舞台过滤保持。

[真实 HTTP/SDK 报告](../output/json-backup-1794019754601/report.json)七组通过，覆盖实际序列化文件直接恢复、每歌单快照、空/同名歌单、四类凭据仍在库内时的排除、幂等、错误版本无写入，以及 DBX 无 HTTP/WebView 与 EOF 退出。来源七文件与新二进制摘要已复算。store63、播放器 lib987/7 既有忽略、Rust 1.88 和 stable Clippy all-targets 均通过；Clippy 沿用前述三类豁免。脚本登记更新为 284 项，新增[往返脚本](../scripts/check-json-backup.js)。[限定独立审查](aegis/work/2026-11-07-json-backup-consistency/30-review.md)无遗留 P1/P2。

新播放器 SHA-256 `6470172586149d95a52e4d2130f34222cc996c309b068eaaff1305dfb0762e20`，DBX `bc0e5bdea4c308f3eeb9654af757f8ecf985f8a544bc4f8d7f709c8214dceeb7`。[更新的 Full ZIP](../output/json-backup-1794019754601/packages/hertz-studio-full-0.3.2-preview-x86_64-pc-windows-msvc.zip) SHA-256 `a5af099fc7040a428ae469faf3009ccfe7aec3d25f15fc39fe7b6484444577d1`，build ID `93712be7bda27854ec5c4f557827c86ecdc49742b9722cd9a16a864b2c4b66d3`，签名仍为 `NotSigned`。包内 manifest 与实际 JSON 候选 exe 摘要相符。前节 62 组报告描述此前壁纸候选；本节新文件没有复用它们的二进制摘要，也不将包身份核验声称为重复完成新包的原生旅程。

受控界面偏好迁移、原生保存/辅助窗口、窗口恢复与响应边界、NSIS/签名、净系统/真实设备与其它总盘点项仍待完成；本增量继续完整目标。[工作证据](aegis/work/2026-11-07-json-backup-consistency/90-evidence.md)保存最终命令与续接提示。

## 受控界面偏好与主窗口文本保存

2026-11-07 已完成[受控界面偏好迁移](ui-preference-transfer.md)，更新上一节当时仍待实施的范围。普通 JSON/M3U/诊断与偏好文本统一经 hertzHost；Windows IFileSaveDialog 使用实际父窗口，只有 Wry 完成回执才显示已保存。偏好导入先预览、再提交并确认宿主和舞台保存，最后重载；服务设置与普通业务备份的原归属和 v1 契约保持。

| 最终验证 | 结果 |
| --- | --- |
| 原生文件与偏好 | [同批 Full/native 报告](../output/playwright/main-window-files-native-1794024553670/report.json)十一组通过；真实按钮、保存/取消/覆盖/失败重试、外部来源拒绝、旧回执隔离、全新 WebView 导入与重启恢复；三进程退出、发现文件移除 |
| 浏览器与 DBX | [浏览器报告](../output/playwright/ui-preferences-browser-evidence.json)七组通过；18 键、17 类拒绝、持久化失败恢复、晚到舞台保存；六张响应式截图与零页面/渲染异常 |
| 当前源码检查 | schema92/host8、前端74、原生 bin18、Rust 1.88 native-bin 和 stable Clippy 通过；Clippy 沿用既有三类基线豁免 |
| 独立审查 | [规格/架构复核](aegis/work/2026-11-07-ui-preference-transfer/30-review.md)无剩余可复现 P1/P2；配色量化与晚到舞台保存问题已修复并复验 |
| 候选身份 | [实际描述](../output/ui-preferences-final-candidate-20261107-115204/candidate.json)、报告11个来源摘要与另存21个来源摘要全部复算一致 |

优化候选 exe SHA-256：1cc6f198beeeff0e48b81b174410e5416550cbd54362d4c442d4012febd55414；build ID：fe9b75694ef8ff981266d3976829df961d6db0632a63861925c72249a5878da3。该候选没有据此重新声明此前 ZIP 的身份或运行资格。原生测试保留 WebView2 的默认下载管理器和权限，使用实际用户点击；纯程序连续调用的浏览器门控单列在诊断记录中。

本次范围是已有 Windows/WebView2 与 null 音频，目标 B 以同源重启验证持久化；其它 OS 对话框、物理设备、窗口恢复/辅助窗口、NSIS/签名及其余总盘点继续跟踪。完整用户目标保持 active；[续接记录](aegis/work/2026-11-07-ui-preference-transfer/20-checkpoint.md)与[证据](aegis/work/2026-11-07-ui-preference-transfer/90-evidence.md)已分开记录本轮完成和下一范围。

## 2026-11-07 主窗口恢复与受控 OBS 预览

[位置恢复](main-window-recovery.md)已按既有 WindowLifecycle owner 接通，正常矩形和最大化状态按 DataDir 保存，隐藏/最小化/胶囊不覆盖正常尺寸。[OBS 预览](native-obs-preview.md)使用独立资料目录、现有只读钥匙和主 Tao 生命周期；桌面组件退役全局 WebView2 目录覆盖，显式保留原目录 context。

| 验证范围 | 本轮结果与身份 |
| --- | --- |
| Full/native 组合构建 | [候选 78a9d1fe…240b59](../output/native-window-obs-profile-candidate-20261107-131434/candidate.json)，十四个源摘要稳定；主程序二十项、前端七十五步、Rust 1.88 与 all-targets Clippy 通过 |
| 真实原生回归 | [几何十一组](../output/playwright/main-window-geometry-native-1794028535736/report.json)、[文件/偏好十一组](../output/playwright/main-window-files-native-1794029149861/report.json)、[生命周期九组](../output/playwright/main-window-lifecycle-native-1794029221776/report.json)、[内嵌桌面六组](../output/playwright/desktop-embedded-1794029261221/verification.json)通过，同批三十七组 |
| 独立桌面目录回归 | [debug/probe 候选 f6972951…6696e09](../output/native-window-obs-desktop-profile-candidate-20261107/candidate.json)的[十五组实际作品/预览/轮播/重启回归](../output/playwright/wallpaper-works-native-1794029274010/report.json)通过；桌面 all-targets 五百一十九项通过、两项既有硬件忽略；该 debug 证据不冒充优化发行候选 |
| OBS 视觉修正 | [候选 b7dcc992…54959](../output/native-obs-preview-backdrop-candidate-20261107-133608/candidate.json)仅追加预览专用石墨底色；定向测试、Rust 1.88 和 Clippy 通过，[实际截图及前三组诊断](../output/playwright/native-obs-preview-1794029804424/report.json)通过并正常清理 |
| OBS 正式资格 | 完整九组仍待完成；[严格前台前置报告](../output/playwright/native-obs-preview-1794029008239/report.json)证明现有系统防火墙通知阻止主窗口聚焦，已请求用户处理。未关闭/选择该系统提示，未放宽焦点断言；`diagnosisOnly=true` 不算正式通过 |

原生三十七组与独立桌面十五组合计五十二组，各自保留实际二进制身份。随后 OBS 底色修正只使用新候选的定向/图像证据，未把旧报告的候选身份改写为新 exe。Clippy 沿用前轮三类命令级基线豁免。测试范围仍为本机 Windows/WebView2、隔离资料和 null 音频；物理多屏/DPI、实际 OBS、真实设备、NSIS/签名及更大盘点继续独立跟踪。

用户指定的 `design-taste-frontend` 已用于原生预览对比度与现有 JS/CSS/token 边界复核。以上是该轮停点；后续正式结果见下一节，[续作记录](aegis/work/2026-11-07-native-window-recovery/20-checkpoint.md)保留各轮身份和范围。

## 音乐选择导入与 OBS 正式验收

2026-11-07 已接通[音乐文件／目录选择导入](native-music-import.md)。真实 File 对象通过有界原生通道交给既有扫描 owner；精确文件不扫描兄弟、不删除旧歌曲，目录递归且不登记持续同步。初始化完成后显示原生入口，所有请求先显示曲库面板，失败、进度和取消沿用既有流程。Files 的捕获不影响 HTML 队列拖动。UI 参考用户指定 design-taste-frontend，沿用现有栈。

[最终独立 Full/native debug 候选](../output/native-music-import-final-candidate-20261107/candidate.json) SHA-256 `5a5cfefe83b7d41c796677415b50b8f65a8698c5319d0813e407faa5dd5982d8`。扫描16、主程序21、前端75、浏览器7、Rust1.88 与 Clippy 通过；[真实 WebView2／Windows OLE 十组](../output/playwright/native-music-import-1794037107916/report.json)证明实际文件／目录对象、精确范围与身份、无路径字符串后门、损坏音频、原目录扫描删除，以及来自自有源窗的实际 OLE 文件与目录拖入。宿主退出0并移除发现记录，候选与生产来源摘要未变；Explorer 本身和其它 shell 尚未据此验收。

用户处理先前防火墙弹窗后，[OBS 正式九组](../output/playwright/native-obs-preview-1794032126388/report.json)在前一个 [b204 Full/native debug 候选](../output/native-music-import-candidate-20261107/candidate.json)通过：`diagnosisOnly=false`、真实前台输入与复用、四样式、隔离／导航／弹窗／权限／下载、旧文档及父子关闭清理均完整。PID19724 退出0并移除发现记录。原52组、b7诊断、b204正式OBS与最终5a音乐导入报告都保持原始二进制身份。

`-o` 独立输出保留正在使用默认 debug exe 的另一进程；两个输出命名提示是 Cargo/rustc 生成候选路径的结果，不作为 Clippy 豁免。Clippy 仍只沿用原三类命令级豁免。新的静态审查修复可见错误、读取路径前准入与文档确认三个问题，七项架构边界无剩余行动项。本机资格不证明 NSIS/签名、净系统、物理设备、其它 OS 或完整目标完成。

此前两次被前台通知阻挡的续接保留为历史诊断，用户已处理全部旧弹窗；最新通过状态见[实际 OLE 记录](native-music-import.md#windows-ole-实际拖放)。完整 Rust 回归仍为 1005 通过、7 个既有忽略，主程序 21 通过。NSIS 编译器现已通过官方项目来源和摘要核对，当前用户安装候选结果见下一节；旧通知和未找到编译器的停点均不再作为当前阻塞。

## 当前用户 NSIS 安装候选

2026-11-07 已完成[安装使用与恢复说明](windows-installation.md)。NSIS 使用系统安装界面和当前用户权限；一次性 setup adapter 管理初次安装、卸载及登记，既有 updater 继续独占程序事务。更新恢复在清单暂时缺失时仍由标记驱动；原包复算通过后，在 writer 与标记保留期间修复投影，失败可重试。receipt 先写入，便携转换中断也能证明归属。

| 最新证据 | 结果 |
| --- | --- |
| 新候选原生验收 | [十八组](../output/nsis-installer-native-1794040367555/report.json)通过；真实中文／特殊字符安装、多 profile 阻止更新／卸载、重装、初次与投影失败、未知登记保留、部分卸载、清单缺失、受占用恢复重试、便携转换及菜单链接拒绝 |
| 默认 updater 回归 | [八组](../output/install-owner-1794040246176/report.json)通过；默认 CLI 不启用新增恢复提交回调 |
| 发行工作流 | [YAML／候选连线](../output/nsis-workflow-static-20261107.json)与[实际编译器准备步骤](../output/nsis-workflow-preparation-20261107.json)通过；setup、清单、摘要上传至 artifacts，合并校验和包含 setup；仅手动触发、contents:read |
| 归属与清理 | 验收后两项当前用户登记和两条开始菜单入口均已移除；保留两份资料、额外文件、报告及候选，exe 和源摘要符合候选清单 |

[NSIS 候选](../output/nsis-installer-reviewed-v2-candidate-20261107/hertz-studio-full-0.3.2-preview-x86_64-pc-windows-msvc-setup.exe) SHA-256 `4f10a9dc2efb40f419b6d8dd153c762ef9de086a05db2580af01cfea8ff72b8c`，15,477,432 字节；包内 release exe SHA-256 `8ebb49cd4a0e018e5d829a576775cdbac0bd2dbf1ccb959e18b20bbb56248a75`、build ID `e05267588a1133592a3d95f0909db123b329f4afec4ecb08a33f964e6494cea3`。NSIS 3.11 ZIP 和编译器的固定摘要见[官方来源记录](../output/tooling/nsis-3.11-provenance-20261107.json)。旧九组候选不用于证明审查后源码。

本轮全部验证位于自有 output 目录，使用本机已有 Windows/WebView2 和 null 音频；安装器及程序仍为 `NotSigned`。没有触发远端 workflow 或发布。净系统／离线 WebView2、真实断电、签名与远端更新源、实际声音／设备、长稳及整个设计盘点仍未完成。

## 原生 HTTP 边界增量

2026-11-07 [原生 HTTP 策略](native-http-boundary.md)已接同进程服务装配：有效 bind 在业务启动前限制为精确 `127.0.0.1`；实际端口 Host/Origin 和 absolute-form URI 门禁先于 extractor、票据兑换及写操作。可信首页/恢复表单/OBS 发送随机 nonce、CSP、no-store、no-referrer、DENY 和 nosniff；现有凭据及普通 LAN/DBX 规则保持。Pixi 函数生成、Blob Worker 和动态样式的必要权限明确记录。

当前 Full/native debug 归档 SHA-256 `8af3e3f40072c7c90a36686a0cf3995c60c22d2ec300cbb12f3f2413fbeffb93`，build ID `c158b1f40ccedde0773e6544aacb8b694fd0a56bb0b9f4b1654e9d9306dd32bc`。[十二组 HTTP/WebView2/Chrome 157 报告](../output/playwright/native-http-boundary-1794044751270/report.json)通过，当前源/归档/运行摘要一致，测试自有进程已退出。当前主程序26项及 Full/native build、普通无默认 feature check通过。

[当前原生OBS正式九组](../output/playwright/native-obs-preview-1794046947110/report.json)为 `diagnosisOnly=false`，真实前台输入与聚焦复用、四样式、隔离/导航/弹窗/权限/下载、旧文档与父子清理均通过。PID19068退出0并移除发现，十六份来源及8af3摘要一致；原安全中心窗口已确认消失。[同候选旧前三组](../output/playwright/native-obs-preview-1794044954769/report.json)继续保留诊断范围。

[当前Full DBX/HTTP八组](../output/native-http-dbx-compatibility-verification-20261107.json)配对8af3服务与e778插件，通过SDK/stdio、资料互斥/失败/EOF和原生恢复接口；插件构建及Rust1.88 all-targets通过，HTTP Full/native的Rust1.88及Clippy all-targets通过。恢复接口不推广为完整DBX宿主资格。此前b204 OBS、5a OLE、4f10 NSIS/8ebb release分别保留身份；完整产品与发行资格仍未完成。

本次续接另取得[当前8af3音乐十组](../output/playwright/native-music-import-1794047526294/report.json)与[身份/清理复核](../output/native-http-music-compatibility-verification-20261107.json)：WebView2文件/目录对象、权限/扫描回归与自有源窗实际OLE均通过，十份来源摘要一致，PID17352正常退出并移除发现，既有服务保留。该候选现在具有HTTP十二组、正式OBS九组和音乐十组的各自本地证据；旧NSIS/release身份未扩展到新候选，Explorer本身和完整发行资格继续开放。

## 当前源码优化 release 候选增量

[配套Full DBX release9418](../output/native-http-release-dbx-current-candidate-20261107/candidate.json)现已与release85ab完成[八组SDK/HTTP验收](../output/data-owner-1794051623414/report.json)，工具99080终态exit0。[输入、身份与退出复核](../output/native-http-release-dbx-compatibility-verification-20261107.json)确认721份构建输入、报告五份来源、归档/运行及旧候选一致，候选进程退出、正常原生发现移除，既有用户进程保留。新插件SHA-256为 `9418fe2a09448cd21195054a04d2f8b4f11b6ec085d4e0ce31ec885b77c3d1f1`；仅证明同一当期源码的优化Full SDK/stdio与HTTP归属兼容，不代表完整DBX PluginHost或可选桌面组件的交付资格。下列e778报告保留其debug配对身份。

[新Full/native release85ab](../output/native-http-release-current-candidate-20261107/candidate.json)完成实际release构建、720份输入核对及153项压缩资源检查。[HTTP十二组](../output/playwright/native-http-boundary-1794048283363/report.json)、[解压入口五组](../output/playwright/standalone-package-1794048330342/report.json)、[NSIS十八组](../output/nsis-installer-native-1794048467662/report.json)、[原更新器八组](../output/install-owner-1794048535341/report.json)和[配对e778 SDK/HTTP八组](../output/data-owner-1794048953415/report.json)均terminal/exit0。包内实际CMD在无Cargo/Node PATH的环境启动，复用/退出/字节保留通过，截图已查看；SDK只覆盖stdio/HTTP owner兼容。

[本地setup2686](../output/native-http-release-installer-candidate-20261107/hertz-studio-full-0.3.2-preview-x86_64-pc-windows-msvc-setup.exe)绑定85ab程序与当前脚本/编译器摘要；包和安装器均NotSigned。[来源、身份与清理复核](../output/native-http-release-final-verification-20261107.json)通过，安装登记/快捷方式和测试自有进程已移除，既有服务及旧候选保留。

当前release85ab已补齐[正式OBS九组](../output/playwright/native-obs-preview-1794052272976/report.json)和[音乐对象/受控OLE十组](../output/playwright/native-music-import-1794052375672/report.json)，diagnosisOnly=false、ole=true、均terminal/exit0。721输入、16/10报告来源及归档/运行摘要一致，两个测试PID正常退出/发现移除；见[独立复核](../output/native-http-release-foreground-qualification-20261107.json)与[旧安全中心已解除](../output/native-http-release-security-resolution-20261107.json)。其它shell、外部OBS、完整PluginHost/可选组件、签名/确定更新源、净系统/离线运行时、物理设备/其它OS及其余产品目标继续单列；A07/A10/M0设计待明确审阅批准。

## 当前release的真实Explorer与同进程宿主增量

[Explorer五组](../output/playwright/native-music-explorer-1794053562171/report.json)实际从Windows Explorer拖入单文件、重复文件和目录，三个原生回执均accepted；精确范围、重复身份及嵌套目录收录通过，持久曲库只有预期三首。[同进程宿主六组](../output/playwright/desktop-embedded-1794053789399/verification.json)验证三个启停周期、每轮16并发命令、活跃维护拒绝、退出释放及主窗口保留；未启动外部hertz-desktop.exe。[独立复核](../output/native-release-explorer-embedded-verification-20261107.json)确认721来源、release85ab运行/归档、持久库内容和正常退出/发现移除，无测试窗口/进程残留，实际界面截图已查看。原受控OLE、旧候选和失败诊断保持原身份；其它shell、外部OBS、真实DBX PluginHost/工作台、可选组件、签名/净系统/物理设备/其它OS及完整目标仍分别开放。

## 当前Full真实PluginHost与配套组件包

[真实PluginHost四组](../output/native-release-full-pluginhost-20261107/verified.json)使用release9418，在0.6.47及最低0.6.35分别验证未授权/已授权、基础SDK、当前20a30e组件要求和歌词/壁纸管道身份快照。[配套组件f030](../output/native-release-desktop-component-current-candidate-20261107/candidate.json)已release构建并生成[manual ZIP](../output/native-release-desktop-component-current-candidate-20261107/package/hertz-desktop-0.3.2-preview-windows-x64.zip)，[独立复核](../output/native-release-dbx-component-verification-20261107.json)确认721生产输入、51/50宿主本地来源、四文件包内manifest/exe/许可证/安装说明、候选摘要和测试进程退出。实际DBX stop终止进程树；两份发现文件保留且原PID已不存在，不把API停止成功改记为自然退出/发现移除。下一步须在该原生组件验证旧发现拒绝、真实live绑定、两scope呈现、来源切换与退出；Standard、完整工作台、D3b、签名/净系统/设备及其它OS仍独立开放。原版本夹具失败和旧报告保留；A07/A10/M0待审、不走TDD。
