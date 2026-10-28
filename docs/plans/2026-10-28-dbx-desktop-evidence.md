# DBX 桌面接入验证记录

工作分支：`codex/dbx-desktop-design-review`。D0–D2 已通过各自两阶段审查；以下证据按实际覆盖范围记录，不代表完整 D3 或正式发布验收完成。

## D0：宿主生命周期与传输

2026-10-28，在 Windows x64、交互会话 1 下，通过隔离项目调用真实 `dbx_plugin_runtime::plugins::PluginHost`；未改写外部 DBX 源码或用户 DBX 数据。

| 宿主源码 | 版本 | 结果 |
| --- | --- | --- |
| `41698ac708812d176ba7cd0593e921bd744b2186` | 0.6.47 | 实际激活 sidecar；独立进程通过只读管道请求；核实双方真实 PID、用户 SID 与 Windows 会话 |
| `8b2bc1708b8f3625ece17f879708f43e9f27e00f`（本地 `v0.6.35` tag 归档） | 0.6.35 | 同样通过真实运行时激活及跨进程管道请求 |

两版的 `host.stop()` 都终止 sidecar 及其后代，独立启动的探针组件保持运行；停止后管道可回收，显式清理和 `stop_all()` 通过。因此冻结产品启动方式为 **`launchMode=manual`**：用户独立启动共用组件，DBX 只连接，不从 sidecar 启动组件，也不尝试 Job breakaway。

原始报告保存在忽略的本地目录，复现入口为 `tools/dbx-desktop-probe/run.ps1`：

- `tools/dbx-desktop-probe/output/d0-current-20261028-211017-030/evidence.json`
- `tools/dbx-desktop-probe/output/d0-minimum-20261028-211104-468/evidence.json`

最终两份报告还分别实测客户端取消约 61/63 ms、五秒业务等待在约 2028/2022 ms 被总请求期限取消，随后连接数为零且管道可重新建立。邻接 `source.json` 保存受测输入 SHA-256。16 项 Windows 协议/权限/资源测试与 `clippy -D warnings` 通过，独立规格审查再次复跑通过并核对了两份报告的源码摘要；独立代码质量审查通过，包含对照锁定 Tokio/Mio 源码核实取消行为与析构顺序。

这些是实际宿主运行时证据，尚未包含 DBX WebView 工作台开关流程。跨用户、跨交互会话的真实拒绝测试也未执行；当前用户 ACL、对端身份检查及协议测试不能替代这些验收。

## 基础插件回归基线

新增桥装配前，以本工作树分别构建两种发行版并运行原检查：

- Standard：`node scripts/check-plugin-sidecar.js`，314/314 通过。
- Full：`HERTZ_EDITION=full` 下原 sidecar 检查，298/298 通过。
- `python scripts/check-plugin-room-shutdown.py --plugin target/debug/dbx-plugin-hertz.exe --service target/debug/hertz-studio.exe --report output/dbx-desktop-d0/baseline-room-shutdown.json`：EOF 时有在途 SDK RPC，收到房间终止消息，恢复静音本地状态并正常退出。

报告与日志位于 `output/dbx-desktop-d0/`。这些检查证明原 stdio/业务合同基线，不替代真实双发行版的播放听测、媒体键、定时器、工作台开关及停用流程。接入完成后仍需再次执行。

原生读取与迁移接入前，`cargo test -p hertz-desktop` 的原有 32 项检查通过，日志为 `output/dbx-desktop-d0/baseline-native-unit.log`；包含旧配置、来源域、壁纸 HTTP/WS、频谱衰减及既有管理动作。它仍不是原生窗口或真实 DBX 验收。

## 组件构建身份试实现

`hertz-desktop --describe` 已在独立配置目录下验证：两秒内返回有界 JSON，包含源文件与资源输入派生的 64 位十六进制 `desktopBuildId`，没有创建配置目录或启动 UI。D0 当时的输出如实声明管理协议 1、尚无 DBX 数据桥能力；生产能力接通前不提前报告协议 2/桥协议 1。D1 已接通桥协议 1，D0 试产物保留为历史证据。

插件构建与桌面组件共享组件输入摘要，插件另有按发行版及业务/资源输入计算的 `buildId`。源码仍在变化，试验时的摘要不作为候选包标识；最终产物必须在源码稳定后统一重建、检查清单及文件 SHA-256。

`node scripts/package-desktop-component.js target/debug/hertz-desktop.exe output/dbx-desktop-d0/component-reviewed` 已生成复核后的真实试产 zip。解包后校验只包含 exe、清单、LICENSE 和 INSTALL.md；文件大小、exe SHA-256、zip 校验和与解包后 `--describe` 全部一致，描述操作未创建配置目录。产物仍为管理协议 1、无 DBX 桥能力的 D0 试产物。

`output/dbx-desktop-d0/build-identity.json` 记录 Standard / Full 两个实际构建的不同插件标识均引用组件摘要 `b4246d120b431a56f3eb977693b2e4c33463c4db6d66bc7f7d69390bdde66c1d`。独立审查还验证优化、调试、panic、ABI 及显式 profile 覆盖改变摘要，同输入与覆盖项顺序保持稳定。打包质量复查验证了源文件替换仍描述暂存文件，以及压缩超时、checksum 写入和提交失败不留下本次最终名残包；原有产物不受失败重试影响。

## 后续待验

D0 时生产授权/撤销与重启、原生配置迁移和读取、管理协议、产品 UI、真实安装/升级、双发行版完整流程以及八小时长稳均未完成。后续实现与验证逐项追加如下；未覆盖的真实环境项目继续待验，不能用窄范围通过替代。

## D1a：可选授权桥的实现后检查

实现者的 16 项定向 Windows 检查通过，包含授权恢复、拒绝非法请求、残留钥匙重启、撤销落盘/清理失败区分、规范目录冲突、发送/发布与撤销交错、慢客户端额度及真实本地歌词文档与偏移。日志为 `output/dbx-desktop-d1/bridge-final-tests.log`。独立规格审查找出旧撤销可能覆盖新授权、清理 future 中途取消可能永久卡在清理中的两项缺口；已修正代际提交检查与 RAII 任务/撤销标记恢复，并增加三个确定性交错检查。修复后 **19/19** 通过，日志为 `output/dbx-desktop-d1/bridge-review-fixes-tests.log`；同一规格审查者独立复跑 **19/19** 并复审通过。

质量审查再发现旧激活错误可覆盖新成功状态，已把错误提交也纳入当前代际检查，并补旧 connect/restore 晚到的状态断言。最终 **20/20** 通过，日志 `output/dbx-desktop-d1/bridge-quality-fixes-tests.log`；质量审查者定向复跑新增检查并复审通过。两阶段审查均无剩余已确认阻塞。

Standard 真实 sidecar 的原冒烟再次 314/314 通过，日志为 `output/dbx-desktop-d1/standard-smoke.log`；Full 此阶段完成编译检查，尚未重跑完整冒烟。

根代理另用隔离目录创建受保护的授权及两把钥匙，启动实际 Standard sidecar：原 `plugin/initialize`、`v1/health` 及歌词/壁纸数据管道 snapshot 均成功。随后保持两个 scope 的半帧连接，关闭 stdin，进程约 **8 ms** 以 0 退出、stdout 未混入日志、原有效授权保留。证据为 `output/dbx-desktop-d0/authorized-eof-standard-1793201732358/report.json`，复现脚本为同目录上级的 `verify-authorized-eof.js`。被测独立 exe 的 SHA-256 为 `d1bba11e1303e7a1fc815aa7e669fbc7bab13e852adc263eb64ffc51a7462890`；之后的 listener 异常状态修复尚需统一重建后复验，不能把这份产物当作最终候选。

2026-10-29 将 D1a 最后修订重建为隔离的 Standard exe，SHA-256 为 `9fbe9c07ca3c122c6a0b6a0ef1b5fb3f0af7d400c7dc8050242551cb43d09c2f`。原检查再次 **314/314** 通过，日志为 `output/dbx-desktop-d1/standard-current-smoke.log`；相同双 scope 半帧 EOF 检查约 **7 ms** 正常退出，见 `output/dbx-desktop-d0/authorized-eof-standard-1793208856860/report.json`。另用实际 sidecar 覆盖未授权、仅有钥匙、持久撤销但残留钥匙、未来授权 schema、坏授权 JSON、已授权但无钥匙六种启动状态，初始化/health/state/queue/settings 正常、stdout 纯净、已有文件摘要不变、无新桥文件及原生配置、EOF 5–10 ms；报告为 `output/dbx-desktop-d1/inert-standard-1793208821875/report.json`，复现入口为该目录上级 `verify-inert-startup.js`。

同一 Standard 产物还运行原 `check-plugin-room-shutdown.py` 的真实房间 EOF 流程，并在宿主创建房间前恢复有效双 scope 桥、保持两个半帧管道客户端。原房间检查通过：EOF 时 SDK RPC 仍在途，sidecar 正常退出，访客收到 terminal End、恢复静音本地状态并清除成员记录；有效授权保留。报告 `output/dbx-desktop-d1/authorized-room-eof-standard-current.json` 记录双方 exe 摘要，复现包装脚本为邻接 `verify-authorized-room-eof.py`。这些检查不替代未执行的图形宿主流程、实际跨用户/会话或最终配套构建验收。

Full 也完成同阶段重建，SHA-256 为 `c2994c7ae4dd3c04d9a2a2f57bd95ef07fd7f403d0de47fc21070f5a62557dea`。原检查 **298/298** 通过（`output/dbx-desktop-d1/full-current-smoke.log`）；相同六种启动状态全部通过（`output/dbx-desktop-d1/inert-full-1793209293241/report.json`），双 scope 半帧 EOF 约 **7 ms** 正常退出（`output/dbx-desktop-d0/authorized-eof-full-1793209293258/report.json`），有效桥与原房间 EOF 流程也通过（`output/dbx-desktop-d1/authorized-room-eof-full-current.json`）。这两份插件是 D1a 行为回归产物；原生源码仍在变化，不能作为最终配套构建。

根代理又将上述实际 Standard / Full sidecar 交给真实 DBX 运行时加载，当前 0.6.47（`41698ac7`）与归档最低 0.6.35（`8b2bc170`）各执行未授权/有效授权两种状态，共八组通过。未授权时 health/state/queue/settings 经实际宿主正常调用且无桥文件；有效授权时受保护发现、两个 scope 的真实外部管道快照、session/edition 一致性及宿主 stop/stop_all 通过。报告为 `output/dbx-desktop-d1/production-host-current-absolute-run/report.json` 与 `production-host-minimum-run/report.json`，邻接 `production-host-source.json` 记录 sidecar/fixture/宿主输入摘要；隔离驱动源码在 `production-host/`，不修改外部 DBX checkout。报告仍明确排除 WebView 工作台、跨用户/会话与最终配套 native 构建，不能据此把完整 D3 勾选完成。

## D3a：工作流准备（尚未在 GitHub 执行）

已增加共用 `desktop-component.yml`，由手动 release 与受现有 tag gate 约束的插件候选工作流调用，生成独立组件 zip/校验和供人工审核。现有五平台 `.dbxp` 发布矩阵、Standard-only 策略与钉住的 DBX workflow 不变；新组件只进入 Actions artifacts，不增加自动发布/安装。YAML 本地解析和连接关系检查通过，工作流接线的独立规格与质量审查均通过；两位审查者还核实固定上游只下载 `dbx-plugin-*`，不会把组件 artifact 纳入插件发布。未调用 GitHub Actions、发布 Release 或上传外部产物。最终协议接通后仍需实际 release 构建与清单检查；本项不等于 D3a 或完整发布验收完成。

D2c 后端的共享 IPC 改动定稿后，使用 `rustc 1.98.1 (48a229cea 2026-09-01)`、根 release profile、`x86_64-pc-windows-msvc` 独立构建组件，耗时 4 分 6 秒。组件的 72 项源码/资源输入摘要在构建前后完全一致；插件业务源码仍在变化，不能把这次组件构建当成两版已配套。实际 `desktopBuildId` 为 `97780f2e56e15cd411ba7d3217ff88b7670b5227bb5b9545d95c10238475ebe9`，声明管理协议 2、桥协议 1 与 manual。

候选 zip 位于 `output/dbx-desktop-d3/component/hertz-desktop-0.3.0-windows-x64.zip`，SHA-256 为 `74776a1fcbdf0ac9034553dcb18ab3d99f7c568dc67ff23e1dbc6109abc5b4dd`；exe 为 4,900,864 字节，SHA-256 为 `e8654068060dfa8039ece108f862e752f4842b01fd49805601eae1572b9a48be`。独立解包验证只有 exe、清单、LICENSE、INSTALL.md，zip/exe hash 与清单一致、PE 为 x64，解包后 `--describe` 与清单一致且两秒内返回，没有创建指定配置目录。报告为 `output/dbx-desktop-d3/component-verified.json`，编译日志、输入逐文件摘要及复现驱动均在邻接目录。尚未发布或安装到用户位置；两版插件、图形产品流程与 D3 其余门槛仍待完成。

随后在全新的隔离目录按真实 zip 执行手工安装/升级/恢复：先运行历史 D0 包，Windows 对运行中 exe 的覆盖实际返回 `EBUSY`，原二进制与配置摘要不变；正常退出后换入当前配套组件，schema 2 → 3 只提交一次（revision 10 → 11），歌词样式与两项 disabled 偏好保留。再次重启不重复迁移；退出后恢复旧包和配置备份，旧包仍可启动并正常退出。报告 `output/playwright/desktop-package-upgrade-1793222017986/report.json` 记录两包/驱动 SHA-256。复现入口为 `output/dbx-desktop-d3/verify-manual-upgrade.js`。这是同版本不同构建的实际手工升级与备份恢复证据，不含签名安装器、用户目录安装、自启、DBX 图形流程或跨会话验收；不据此勾选完整 D-A12/D3。

## D1b：原生读取与迁移（两阶段审查通过）

实现后的 45 项 native 检查通过，独立规格审查者复跑也通过，日志为 `output/dbx-desktop-d1/native-spec-tests.log`。原歌词、原设置页及新增 DBX browser 检查通过；新检查覆盖只读控件/键盘与切回独立版、请求及页面队列年龄、系统调时、重复 seq、频谱年龄与独立失效。原生/页面使用 `Instant` 与 `performance.now()` 的保守映射，不用墙钟刷新寿命。

独立规格审查额外构造隔离 fixture，确认三项边界：缺少活动 DBX 域时补建会错误使用 enabled=true；同 key 的文档 409 会被后续快照洗掉退避；持续约 1.6 秒的慢快照可使原生先清文档，而成功缓存不再补齐。复现报告为 `output/dbx-desktop-d1/native-spec-probe.log`。实现者已修正为按需恢复匹配文档缓存、错误之后的新快照确认与独立退避、DBX 缺域默认关闭，并将相应正向回归吸收进正式测试。规格审查者复审通过，独立复跑生产代码 **48/48，9.90 秒**，日志为 `output/dbx-desktop-d1/native-spec-review-fixed.log`；质量审查仍在进行，D1b 尚不能勾选完成。

根代理另跑前端聚合，63 步通过、1 步失败：新增 `check-desktop-dbx-browser.js` 尚未进入脚本登记；日志为 `output/dbx-desktop-d1/frontend-native-final.log`。登记已修正，根代理定向复跑 `check-scripts.js` 通过，日志为 `output/dbx-desktop-d1/script-registration-final.log`；其余已通过步骤的源码未因此改变。未运行的 119 项 live 检查不计作通过。

质量修复后根代理重新运行完整默认前端聚合，**64 步通过、0 失败**，日志为 `output/dbx-desktop-d1/frontend-quality-fixed.log`；119 项未运行 live 检查仍保持未验。

质量审查确认三处运行衔接问题：页面因排队超过新鲜度阈值而清空文档后，native 仍以为文档已送达；普通保存失败时仅回退内存配置、未回退已经生效的窗口/页面状态；无绑定旧配置把检测候选误当活动来源，导致唯一候选不能显式首次绑定。页面问题由真实内嵌 assets 的隔离 Chrome 流程复现；不能用每次快照都强制重发文档的测试辅助方法代替实际去重路径。

实现者已修正这三项，并再次通过 48 项 native、原歌词/设置与 DBX browser 检查。新增已登记的 `check-desktop-persistence-native.js` 启动两次隔离原生 WebView2：实测阻断写盘后锁定的页面/Win32 穿透、外观和同屏移动位置均恢复；失败状态明确未保存；unbound 首次绑定失败保留无活动来源及旧偏好，重试原子提交成功。证据位于 `output/playwright/desktop-persistence-native-1793213636261`。质量复审进行中；系统启动项补偿失败未注入真实系统故障，不将其记为已实测。

质量复审已批准上述三项修复，审查者独立复跑真实原生持久化检查通过，证据为 `output/playwright/desktop-persistence-native-1793213929187`。DBX browser 的壁纸失效断言存在固定 500 ms 等待的调度边缘：实际约 568.5/598 ms 观察到过期，环境 renderer 仍挂载；审查未发现生产失效问题。已仅将检查改为一秒内有界等待失效条件，保持输入剩余 TTL 400 ms、环境持续与排队过期拒绝断言；定向 DBX browser、脚本登记及 diff 检查通过。D1b 两阶段审查无剩余实质问题，D2a 管理传输开始实施。

## D2a：管理传输（两阶段审查通过）

管理通道继续使用旧名称和单条 raw JSON 消息，不采用数据桥的长度帧；当前仍声明管理协议 1。新 Windows 实现使用独立 OVERLAPPED/event，显式当前 SID ACL、真实 peer PID/token/session 验证，连接一秒、建连后读/GUI 等待/写/送达合用两秒期限。取消后先回收内核操作，再释放 OVERLAPPED、缓冲区和管道。GUI 请求携带有效期；最多一个待处理事件，超时后未取走旧事件期间新请求返回 busy，避免事件队列增长。

实现后管理检查 **14/14**、原数据 IPC **16/16**、原 native **48/48** 及独立版错误映射检查 **1/1** 通过，三 crate check 与窄格式检查通过。真实管道覆盖旧默认 byte 读客户端、新客户端连旧默认 ACL message 服务端、坏包/半包/超限、多消息、慢客户端、pending listener/read/write 取消及后续请求恢复。实际跨用户/会话拒绝仍未执行。

复验还修复两处独立版兼容问题：缺 listener 保留原“未运行”错误，busy/权限/取消不误报；旧 Node 客户端关闭后的轮询回收存在短间隔，改用 overlapped 读取关闭通知。隔离原生 WebView2 persistence 复跑通过，证据为 `output/playwright/desktop-persistence-native-1793215123592`。完整复现命令、日志及自审在 `output/dbx-desktop-d2a/implementation-review.md`；尚待独立规格及质量审查，不据此勾选 D2a。

规格审查者独立重跑 14 项实际管道检查，并直接编入实际 `pipe.rs` 验证 pending 事件的 busy/drop 恢复；均通过。另以确定性 NPFS 探针发现零长度第二条 message 不占可读字节、绕过额外消息检查，仍可进入 GUI handler；送达阶段也把成功读取零字节误当关闭。该项已退回实现者修复，未进入质量审查。实际跨用户/会话和完整图形宿主流程仍保持待验。

修复使用贯穿 GUI 等待、序列化、写和送达的额外消息读取；成功读取任意长度均拒绝，关闭只按真实管道断开错误判定。客户端也拒绝已排入的额外空回复，并在没有额外回复时取消探测并回收实际操作，不等待旧服务端关闭。新增四项确定性回归，最终 **18 项管理 + 16 项原数据** 全通过，三 crate check 与窄格式检查通过，日志为 `output/dbx-desktop-d2a/ipc-tests-zero-message-fixed.log` 等。规格审查者独立重跑全部 18 项通过；原零长探针复跑为 `InvalidData`、`handler_count=0`，客户端保持打开时约 2.2 ms 拒绝。规格复审已批准，质量审查进行中。

质量审查已批准，未发现 Critical / Important / Minor 实际问题。审查者独立通过 `cargo clippy -p hertz-desktop-ipc --all-targets -- -D warnings` 与管理 **18/18**，核对 OVERLAPPED 生命周期、取消完成竞态、统一期限、单 worker/GUI 许可及原错误语义。D2a 无剩余已确认问题；管理协议仍为 1，D2b 开始实施，不据此宣称 DBX 产品入口或完整 D3 已完成。

## D2b：原生管理 v2（两阶段审查通过）

v2 增加 `requestId`、`requiredDesktopBuildId` 与严格类型的 `targetProfile`，成功及可回复的错误均关联有效请求 ID、实际组件构建与协议；非法 ID 返回 null。响应超限以有界序列化判定，busy 也经 native 业务装饰，raw transport 的期限/取消/排队机制保持。管理协议已接通为 2，桥协议仍为 1。

本期 v2 收敛到状态、打开中心及少量有目标的壁纸运行命令；唯一配置写为带 revision 的 `wallpaper-apply`。旧标量样式、toggle、locate 与外部 profile-switch 不扩进 v2，切源继续由原生中心显式确认。legacy standalone 仍保留原形状；legacy active DBX 的无目标修改拒绝。`sourceConnected` 使用实际活动来源、认证数据时间与统一三秒新鲜度，来源 B 在线不表示请求 A 已连接；独立版健康计时与原页面呈现分开。

原 native 48 项加新增三项共 **51/51**、管理 **18/18**、数据 IPC **16/16** 及相关设置/DBX renderer browser、脚本登记和 diff 检查通过。新的 `check-desktop-management-native.js` 与已登记 fixture 使用真实 WebView2、受保护认证数据管道，覆盖 28 项负面请求无副作用、legacy 标量、候选可选、提交失败同候选重试、新 DBX 默认关闭及旧偏好保留、空曲目认证时 A=false/B=true、过期、新 session 与切源清理。

最终原生报告为 `output/playwright/desktop-management-native-1793217812905/report.json`，邻接保存 native 测试证据和 `center-after-explicit-switch.png`。该次 exe 的构建标识为 `44a2d262fbfff6e68cef4607d60f4f2a7aeef601fc2879e6fe312b371e111075`；后续源码变化仍须统一重建，不能作为最终配套版本。原持久化 native 回归也通过，证据为 `output/playwright/desktop-persistence-native-1793217601935`。当前进入独立规格审查，尚未勾选 D2b；fixture 不代表真实 DBX 图形工作台、跨用户/会话或长稳 D3 验收。

独立规格审查已批准，并定向复跑新增 management 测试 **3/3**。质量审查未发现生产 Rust 的实质缺陷，但以真实 Windows 管道复现验证脚本在完整 JSON 前正常关闭时永久等待。两个同目标 native checker 已共用有界客户端：提前 end/close 立即失败、绝对四秒总期限、累计响应最多 8192 字节，所有完成路径清理 timer 和 socket。真实关闭、半截 JSON、静默、持续碎片、超限与正常回复六例均通过；完整 management 和 persistence native 也重跑通过，分别见 `output/playwright/desktop-management-native-1793218854998/report.json`、邻接 `client-report.json` 与 `output/playwright/desktop-persistence-native-1793218871749`。质量审查者独立复跑六例通过（`output/playwright/desktop-management-native-1793218952815/client-report.json`）并批准，无剩余 Critical / Important。D2b 现已完成，D2c 后端门面开始；完整 D3 仍待验。

## D3 图形环境准备（不计产品验收）

已启动本机原有 DBX **0.6.39**，以任务专用 `DBX_DATA_DIR`、WebView2 目录与日志目录打开实际图形工作台，通过 CDP/Playwright 观察插件中心的空安装列表。全局窗口状态文件先备份、结束后恢复，原全局目录各普通文件的大小与 SHA-256 全部一致，没有加载日常插件。清理驱动已修正将 `signalCode` 退出误认为仍在运行的问题；该次宿主由驱动终止并恢复备份，不计正常退出验收。

报告：`output/playwright/dbx-desktop-gui-baseline-1793219422947/report.json`，截图为邻接 `isolated-empty-installed.png`。此项只确认后续图形测试环境与数据隔离可用，未装载最终 Standard / Full 配套候选，未验证播放、工作台关闭/重开、组件、最低/当前图形宿主或八小时长稳，D3 仍未通过。

## D2c 后端：共用门面（两阶段审查通过）

新增 `desktop/` 门面共用 HTTP/RPC，原独立版 launch/control 提取后保留原合同。HTTP 仅新增 `GET /v1/desktop/capabilities`；DBX 的 connect/disconnect 只通过 RPC 暴露。构造和缓存查询不进行组件 I/O；显式检测优先验证运行宿主，才回退固定安装位置的清单及流式 hash 校验，不执行组件。组件、管理、授权、listener 与当前来源认证分别报告，部分失败保留真实授权事实。

连接在探测前捕获桥的原始意图代际；撤销和退出取消未授权阶段的实际 I/O，旧探测不能重新授权。管理、检测及排队合用五秒预算；同类调用合并，共用一个 worker 额度，future Drop 实际取消并 join，缓存仅持弱引用。scope 在线为本次实时确认，缓存不再延长原生新鲜度；它不承诺当前授权 revision 的第一帧。原音频、页面观众和 SDK 退出屏障未改。

实现后 desktop **20/20**、原授权桥 **20/20**、管理 **18/18**、原独立版错误映射/命令白名单 **2/2** 通过，共 60 项；Standard/Full sidecar `cargo check`、`clippy --no-deps -D warnings` 与窄格式检查通过。两个新错误码按设计统一为 `desktop_component_incompatible` 和 `desktop_component_start_required`，相关三个 fixture 再次通过。代码、DTO、命令、语义与各日志位置见 `output/dbx-desktop-d2c/backend-implementation.md`。UI 尚未实施；真实候选的图形流程、跨用户/会话、实际原独立版启动、管理应答尚未送达期间的生产 sidecar EOF 与八小时长稳继续归 D3。

独立规格审查发现未授权 refresh 的第二次 v2 status 没有继续绑定原始 admission，shutdown 后仍可能等待并发布旧的管理就绪结果。已以 `Authority::Admission` / `Authorized` 贯穿取消、请求后验证、缓存发布/读取及 completion；授权成功后使用实际新 generation，合法 scope 修复内部关闭旧 gate 不会误杀后续连接。新增第二次请求阻塞/退出/迟到 completion 与缺失钥匙修复两个确定性检查，desktop **22/22**、桥 **20/20**、lib check、clippy 与窄格式通过（`admission-lifecycle-*` 日志）。同一规格审查者独立复跑这两个检查并复审批准。

全新质量审查已批准，无 Critical / Important / Minor。审查者直接使用最新测试程序独立复跑五项关键检查：上述 shutdown 与 scope 修复、授权前/后最后调用方 Drop，以及五秒共用期限，均通过；另核对 Weak owner、锁顺序、实际 worker 取消回收、固定位置完整性、部分失败及原 Standalone move 合同。D2c 后端已完成，UI 开始实施，整体 D2c 仍未完成。

根代理用实际 Standard release sidecar 验证三种管理应答未到达时的 stdin EOF：首次兼容探测、授权后的 open-center、未授权 refresh 的第二次 v2 status。三例分别约 5 / 20 / 5 ms 以 0 退出，管理服务端确认真实客户端取消（20–31 ms，早于两秒期限），stdout 保持纯 JSON；只有授权后场景产生有效同意，另外两例未生成桥授权或凭据，没有执行原生组件。报告为 `output/dbx-desktop-d3/management-eof-standard-1793222264528/report.json`，驱动及真实受保护管道 fixture 位于同级；驱动以 capability 返回的真实 DataDir 核对发行版授权位置。这份 exe 为 UI 修改前的后端集成证据（SHA-256 `4421204eea18bfa7abc5dd09868e6d128526bde8b5d1aa0c4cba70abb559cd92`），不是最终 `.dbxp`。EOF 进程退出不能替代前述 `begin_shutdown()` 后旧结果不可发布的确定性检查。

Full release sidecar 也通过同样三个真实管理 EOF 场景，分别约 6 / 20 / 5 ms 正常退出，报告为 `output/dbx-desktop-d3/management-eof-full-1793222662768/report.json`。两份后端产物分别重跑原 `check-plugin-sidecar.js`，Standard **314/314**、Full **298/298** 通过（`pre-ui-standard-smoke.log`、`pre-ui-full-smoke.log`）。这些是门面提取后的业务/stdio 回归，最终 UI、包体与配套构建身份仍须另行冻结验证。

同样两份 release sidecar 还重跑六种启动状态：未授权、只有钥匙、持久撤销但钥匙残留、未来授权 schema、坏 JSON、已授权但钥匙缺失。实际 health/state/queue/settings、stdout 纯净、已有授权/钥匙不变、无新桥文件/原生配置和正常 EOF 均通过；报告分别为 `output/dbx-desktop-d1/inert-standard-1793222711995/report.json`、`inert-full-1793222712102/report.json`。此项验证可选桌面授权故障不破坏基础 RPC，仍不代替真实工作台开关、媒体键、定时及人工听测。

## D2c UI（两阶段审查通过）

DBX 统一设置区已实现：进入设置或显式桌面动作时检测，首次连接解释只读授权，原生中心负责切源和启用；部分失败先核对真实 capability，撤销不等待连接，epoch 拒绝迟到回填。Standalone 原设置/定位/切换与缺宿主 launch/followup 流程保留。默认前端聚合 **64/64** 与实际 `allow-scripts` opaque iframe 验证通过：项目实际五套 skin 的打开/重开/底栏入口、状态及撤销竞态、指南选中回退、窄屏与零 uncaught error；受控 API 的 42 条桌面 RPC 样本见 `output/playwright/dbx-desktop-settings/evidence.json`。handoff 为 `output/dbx-desktop-d2c/ui-implementation.md`，此项不等于真实 DBX 图形宿主。

独立规格复跑先发现 checker 首屏可能仍在 about:blank，等待 `conn.textContent` 时会空引用；已改为等实际 iframe 导航与 DOMContentLoaded、null-safe 条件，并支持独立输出目录，窄检查通过，待审查者最终独立复验。规格审查还通过提取真实函数的 VM 复现：保存默认视图 `vmusic.defaultView=settings` 时，启动及换肤恢复分别触发一次桌面探测。该保存偏好属于原支持范围，违反启动/皮肤恢复不检测的硬约束；正在给程序性视图恢复增加窄跳过标记，并补预填偏好与后续真实打开的回归，不改原视图落点。D2c UI 与整体 D2c 尚未批准完成。

程序性恢复现已通过窄 `skipDesktopDetection` 标记跳过桌面 hook，覆盖三处默认视图恢复与全局 Escape，保留原视图落点和其他设置刷新。实现者的专项浏览器检查五套皮肤全部通过，外观恢复合同 **60/60** 通过。原规格审查者独立复跑两种实际 opaque sandbox 模式并批准：保存 settings 偏好时，五种初始皮肤及其各五次 mount/恢复、关闭和 Escape 均为零桌面请求；随后真实打开、重开与底栏入口各检测一次。默认完整语义集再次通过，仍为 42 条桌面 RPC、零页面异常。独立日志为 `output/dbx-desktop-d2c/spec-review/final-settings-default.log` 与 `final-browser.log`，证据 JSON 和截图在各自邻接目录。全新质量审查进行中；此处只关闭规格缺口，不代表 D3 真实宿主或发布验收通过。

全新质量审查已批准，Critical / Important / Minor 均为零。审查核对独立规格证据及实际生产入口、后端 DTO、传输重试与资源登记；确认模块职责单一、epoch 与防重覆盖迟到结果、撤销可抢占、未知 mutation 状态不伪造确认、后端内容使用 `textContent` 输出，且没有第二份配置或后台轮询。D2c 后端和 UI 两阶段审查现均完成；进入 D3 同源配套候选及真实宿主验证，完整发布门槛继续保持待验。

根代理最终默认前端聚合发现原 `check-skins.js` 的三处源码形状断言只接受无 options 调用，未适配新增恢复跳过参数；首次为 63 步通过、1 步失败（`output/dbx-desktop-d3/final-frontend.log`）。实现者只将这三处正则精确匹配到 `defaultView()` 与 `skipDesktopDetection:true`，保留三处计数及换肤/bind 上下文，生产源和 browser fixture 均未改。皮肤 **656/656**、恢复 **60/60**、默认聚合 **64/64** 全通过（`output/dbx-desktop-d2c/ui-*-checker-repair.log`）。原规格审查者独立复跑皮肤检查通过，原质量审查者复核窄差异后批准；没有为迁就检查而恢复自动桌面探测。

## 最终代码边界审查

全新最终审查者只读复核生产装配、未授权默认路径、撤销/退出代际、原生切源与配置提交、只读播控拒绝、管理目标关联、UI 触发与配套构建身份，批准本专项代码边界，未发现 Critical / Important / Minor 实际问题。审查没有运行构建或接触真实图形实例；实际同源候选、宿主流程和未覆盖环境仍以各自执行报告为准，不能把代码审查当成发布验收。

## D3a：最终同源配套候选与原合同回归

2026-10-29 使用 DBX Plugin CLI 0.1.2 完成 Windows x64 Standard / Full 实际 `.dbxp`。两版构建前后，桌面 72 项源码/资源输入摘要均为 `51887003f5ac82ce81ea0ddad38736685b3f23f981701c6bbef1ed37be6cb087`，插件 547 项输入摘要均为 `29a33146212a108a210395703ebacec9649ae6204c9b0da3b6c8c88f4483ba56`；与已验证组件输入一致。基线为 `1d042b8` 加未提交工作树，不能用提交号单独重建这些候选。

| 候选 | 包 SHA-256 | 包内 exe SHA-256 | 实际插件 buildId |
| --- | --- | --- | --- |
| Standard，13,087,585 字节 | `3c224919a3229c6d342e51d3e141f0ac64d247a43e517f7f8215d32ccd704d74` | `4bdfd10d9792e9b3bebd752b1deaf37ab0ab3b0daf5fd37795ca7e53bc00b8ca` | `407afc761c836865d83333764d37dee218e744b7a4228f11253c9bff56892433` |
| Full，13,848,964 字节 | `2595f43bb23d149effe8beca944081a9ca3fb4d26bb0eb00ccbf2b1113c944dd` | `240dd4c4fbb89ab10ee02b8694b5ed171da11e8203c765945db2d3ccfb7ba0b6` | `01d59a99d5ca88f2f4774c7c70cd5a0b8a667993678bf2646316e62cdc3ec422` |

两版真实 capability 的 `requiredDesktopBuildId` 均为组件的 `97780f2e56e15cd411ba7d3217ff88b7670b5227bb5b9545d95c10238475ebe9`。包体验证器核对 artifact 大小/hash、包内 `checksums.json` 对每项文件的完整覆盖与 hash、x64 PE、原权限与最低宿主 `>=0.6.35`、Standard 无 Full 协议指纹与专属资源、所有 UI/assets 和 prepared edition 逐字节一致，以及组件未被塞入插件包。`desktop-settings.js` 确在实际包内并被入口引用。

产物位于 `output/dbx-desktop-d3/plugin-candidates/{standard,full}/`；报告为邻接 `verified.json`，复现入口 `verify-plugin-packages.py`，源码冻结记录 `plugin-source-before.json` / `plugin-source-after.json`。构建日志为 `package-standard-final.log` / `package-full-final.log`。CLI 0.1.2 本地应传绝对 output-dir，并移除 `CARGO_BUILD_TARGET`：该版 CLI 的复制路径不兼容 target 子目录；其临时目录退出即清理，不能当作复用缓存。上述是本地打包工具限制，未修改产品行为或发布矩阵。

对实际包内提取 exe 再验：

- 原 `check-plugin-sidecar.js`：Standard **314/314**，Full **298/298**；日志 `output/dbx-desktop-d3/packaged-{standard,full}-smoke.log`。
- 六种未授权/坏授权恢复状态：两版全部通过；报告 `output/dbx-desktop-d1/inert-standard-1793226825325/report.json`、`inert-full-1793226825343/report.json`。基础 RPC 正常、stdout 纯净、已有授权/钥匙不变、无新桥文件或原生配置、EOF 正常退出。
- 三种真实管理等待中的 EOF：两版均通过，约 5–20 ms 退出；报告 `output/dbx-desktop-d3/management-eof-standard-1793226851910/report.json`、`management-eof-full-1793226851930/report.json`，真实客户端取消由 fixture 确认。
- 有效双 scope 半帧连接与原房间在途 RPC 同时存在时的 EOF：两版均通过，访客收到 terminal End 并恢复静音本地状态；报告 `packaged-standard-room-eof.json` / `packaged-full-room-eof.json`，保留授权，未改变原房间退出屏障。
- 最低 0.6.35 / 当前 0.6.47 的真实 `dbx_plugin_runtime::plugins::PluginHost` 重新加载最终两版 exe，未授权/已授权共八组通过；含实际外部管道 snapshot、身份一致与 stop/stop_all。报告 `output/dbx-desktop-d3/runtime-final-1793227718707/verified.json` 同时绑定两版候选及两份运行时 harness hash；复现入口 `verify-final-runtime.js`。外部 DBX 源码仍只读；这不等于这两版宿主的完整图形验收。

新构建的 Standard `hertz-studio.exe`（SHA-256 `3e98fe1bd518df953e769effd6df0b77e35a2b491cf6cd276ef6023dbbe932f8`）与同一配套组件又通过真实独立版 HTTP 回归：缺宿主原错误、原 lyrics/wallpaper launch、单宿主、原 font 标量落盘、wallpaper-status、未知命令拒绝、原生正常退出与服务 shutdown/发现清理。HTTP connect/disconnect 均为 404，保留 DBX-only RPC 边界。报告 `output/dbx-desktop-d3/standalone-http-1793226783137/report.json`，驱动 `verify-standalone-http.js`；已有用户独立服务未动。D3a 的本地材料至此完成，未运行远端 Actions、签名、发布或安装到日常位置。

## D3b：最终候选的真实 DBX 与原生流程（部分通过）

环境为 Windows 11 x64，build 26200，交互会话 1；真实安装版 DBX **0.6.39**。在全新的任务专属 DBX_DATA_DIR、WebView、LOCALAPPDATA、USERNAME 与原生配置目录内，通过真实 `install_plugin_package` 安装以上两份 unsigned 包；只对本次调用允许 unsigned，未修改日常安全设置。安装后的两个 exe SHA-256 与包内完全相同。组件从已验证 zip 的解包位置由独立 Node 父进程启动，DBX 仅连接。合成 WAV、18 行合成 LRC 与零音量用于观察真实音频时钟/FFT，不宣称声学听测。

| 实际场景 | 结果与证据边界 |
| --- | --- |
| 未授权启动和原本地播放 | Standard 无组件时从原界面播放/seek；Full 在组件已独立运行但未授权时播放/seek/暂停。两版启动与这些操作均无桌面 UI RPC，capability 仍 not-detected、gate=false；包内六种 inert 检查另覆盖两版无组件启动 |
| 显式检测与授权 | 仅打开桌面设置后检测；缺组件给安装说明，检测兼容运行组件不授权；显式连接后仅把当前插件加入候选，不替用户改变 activeProfile |
| 原生中心切源与设置 | 实际从离线 Standalone 切 Standard、再切 Full，新 DBX 域两项默认关闭，分别启用才显示。连接 Full 时仍保持 Standard，两个 surface 随中心切源，来源设置分开保留 |
| 真实数据与只读边界 | 两版合成歌词正文均到原生页面；Full 两 surface 的实际 server session 一致，壁纸接收真实 64 段频谱。DBX 播控按钮禁用并说明；在 Full 暂停时直接发送 native play/seek 消息，原播放、位置和 generation 保持不变 |
| 暂停、工作台关闭/重开 | Full 暂停时位置保持，壁纸环境动画继续；关闭 Full 工作台后 sidecar 和桌面仍有真实数据，重开保留播放。没有把 Standalone 离场策略强加给 DBX |
| 撤销、停止、正常 DBX 退出 | 从实际活数据状态观察，分别约 **1898 / 1534 / 1372 ms** 清空歌词和音乐响应，独立组件存活，壁纸环境动画继续。撤销后插件保持播放，重新授权按既定最多 30 秒退避恢复；闭工作台后停止才计为持续停止 |
| 正常清理与日常数据保护 | DBX 正常退出 0，两版 sidecar 均退出；之后原生组件通过自身 quit 正常退出 0，forced=false，候选 exe 未变。原日常 DBX 全局普通文件摘要变化为空，原窗口状态恢复，无本次 DBX/sidecar/native 残留 |

原始会话目录 `output/playwright/dbx-desktop-gui-baseline-1793226800813/` 包含安装、曲目准备、分阶段真实 RPC/capability、原生快照/文档的原函数透传观察、配置、截图及三份 transition 报告。`report.json` 是宿主正常退出/全局文件恢复报告，`native-session/report.json` 是组件正常退出报告。聚合复核 `output/dbx-desktop-d3/gui-verified.json` 以这些原始数据核对候选身份、未授权行为、native 播控拒绝、切源与清空时限；入口为 `verify-gui-evidence.js`。截图已查看，真实歌词与壁纸均有画面。

验证过程中保留两类未计通过的尝试：重新授权后尚处退避时，停止驱动因前置状态未恢复而拒绝执行；随后等待真实恢复才验证。另一次在工作台仍打开时调用宿主 stop，后续原 UI RPC 重新激活 sidecar；这不是持续停用通过。关闭 Full 工作台后重新停止，才得到上述通过报告。不为迁就驱动改变宿主或产品生命周期。

图形控制台存在在线源 `/v1/online/sources` 的 CSP 拒绝、平台图标 404，以及附着工具的注入错误；没有把这些归因于桌面改动，也没有证明完整线上音源/控制台无错误。相关原始控制台日志在 `.playwright-cli/console-2026-10-28T22-33-44-796Z.log`，原生中心另有 favicon 404。它们不阻止已记录的本地桌面流程，但须在完整宿主回归中对照基线定位。

上述 0.6.39 会话结束时，最低/当前图形宿主、Standard 关闭/重开、定时和真实在线取词仍未覆盖；下节继续补验，不把后续结果倒填为该次会话的证据。**完整 D3b 仍未通过。** 不同真实用户/交互会话拒绝、物理媒体键与锁屏/显示器/Explorer 恢复、八小时资源长稳、其他 OS 基础回归及签名/商店发布仍待验，继续保留“DBX 单独使用无行为变化”为发布硬门槛。

## D3b：官方最低/当前图形宿主增量

使用官方 `t8y2/dbx` 的 Windows x64 便携包，下载与解压均在任务目录内。0.6.35 zip SHA-256 为 `3fda670e405479d859f4323fb7ead23d903563ecbb635790c02ef758150d408f`，0.6.47 为 `a72714184f91eecb3929303a3f47aa6f4af5e9b600d4ab44cd44ae7b29afc01b`，大小及摘要均与官方 release metadata 相符。下载走 GitHub API asset 的 octet-stream 入口，解压前拒绝越界路径和符号链接；未运行安装器或覆盖日常宿主。下载报告 `output/dbx-desktop-d3/official-hosts/verified-downloads.json`。

三次真实隔离会话分别为：最低基础/Full 原生 `output/playwright/dbx-desktop-gui-baseline-1793228565278/`、当前完整核心流程 `...-1793229553053/`、最低 Standard 原生补验 `...-1793229911529/`。每次通过宿主实际安装最终两版 unsigned `.dbxp`，所有安装后 exe 摘要与已冻结包内 exe 相同。组件仍为原已验 zip 的 exe，由独立父进程启动。USERNAME 仅用于隔离业务路径，真实 Windows 用户/会话仍是当前用户/会话 1，不计为跨用户测试。

| 场景 | 结果与范围 |
| --- | --- |
| 最低/当前 × Standard/Full，无组件且未授权 | 四组原界面本地播放、进度条 seek 和真实单曲队列通过；授权 gate=false、无 listener 和桥文件。启动、播放、seek、定时、关闭重开均不增加桌面 UI RPC；主动进入普通设置后的一次检测是已确认契约，不混入零启动检测断言 |
| 真实睡眠定时 | 四组均通过原菜单输入 1 分钟并等待真实时间，到点由原 UI 发出 pause。三组连续采样从点击起约 61.2–61.5 秒暂停；最低 Standard 从已运行倒计时的 0:47 开始观测直至暂停，保留实际采样及 CLI 操作，不伪造完整计时起点 |
| 工作台关闭/重开与偏好 | 四组都先记录活跃 sidecar PID，关页后确认同一 PID 仍存活，才发只读状态 RPC；播放与队列保留。主题 `orbit-fog`、15 分钟预设保留，运行倒计时清除，无新桌面检测。检查先后避免 stop 后 RPC 重启造成假通过 |
| 最低/当前 × 两版原生来源 | 四组均在原生中心显式选择 DBX 来源，新域两项 disabled，分别启用后出现真实 18 行合成歌词和真实 64 段 FFT；两 surface 的 server.session 一致，歌词播控按钮禁用。截图已查看。该增量未重复伪造 native 播控拒绝，相关双层证据仍用前述 0.6.39 和专用 native 检查 |
| Full 真实在线取词 | 当前 0.6.47 的实际最终 Full 包通过既有 RPC 向真实网易云请求搜索、歌词和播放，三项 200；原生快照标为 online，返回文档 43 行且 documentKey 与快照一致。报告 `...-1793229553053/real-online-lyrics-1793229870703.json`。只覆盖一个公开来源/曲目，不宣称全部音源、账号、许可或人工听测通过 |
| 正常退出与独立组件 | 最低补验 / 当前分别约 **1237 / 1259 ms** 清空原生歌词和音乐响应，组件存活且环境动画继续。三个宿主与三个组件最终均正常退出 0，组件 forced=false；日常全局普通文件摘要无变化，窗口状态恢复，无本次 DBX/sidecar/组件进程残留 |

四组 MediaSession 真实注册均观测到 play、pause、stop、previoustrack、nexttrack、seekto、seekforward、seekbackward，观察器只透传原函数。没有直接调用 handler 冒充物理系统媒体键。`output/dbx-desktop-d3/baseline-source-boundary.json` 对照 `1d042b8`，确认 `host.js`、`online-playlists.js` 全文件以及 app.js 的 MediaSession、定时和工作台关闭钩子区段未改。

在线源 CSP 的运行时栈已确认：`DOMContentLoaded → online-playlists::loadSources → VMusicTransport → 尚未替换的 ServerTransport → fetch`，第二条为原 HTTP 重试。原基线已在 `app.js` 注释说明此首发打空路径，随后 transport 定形后的原 RPC 初始化能取得来源。未改基础业务或放宽 CSP。平台图标/原生 favicon 404、附着工具 `plugins` 注入错误及关页时宿主 callback 警告仍保留，不能宣称控制台清洁。

保留未计通过的驱动尝试：最低 Standard 定时观察第一次找错 frame；生命周期驱动最初把主动打开设置后的检测也当成零请求失败，后改为比较关页前后的增量；最低 Standard 原生选择第一次误以为候选末段总是插件 ID，实际为数据目录名 `standard`，因此选择超时且期间宿主已被提前退出。新隔离会话按实际已注册选项补验通过，不从旧失败报告推导成功。早期错误宿主路径没有启动任何进程。

聚合入口 `output/dbx-desktop-d3/verify-official-gui-evidence.js` 与报告 `official-gui-verified.json` 核对三次会话的官方宿主/安装包身份、四组基础与四组原生证据、真实在线歌词、退出时限、原始 PID 和正常清理。源码指纹 `source-after-official-gui.json` 与构建冻结完全一致：desktop `51887003f5ac82ce81ea0ddad38736685b3f23f981701c6bbef1ed37be6cb087`，plugin `29a33146212a108a210395703ebacec9649ae6204c9b0da3b6c8c88f4483ba56`。本增量只新增验证驱动和文档，无生产代码变化。

同一最终候选另在官方当前 0.6.47 做了隔离 Full 强制宿主退出：会话 `output/playwright/dbx-desktop-gui-baseline-1793230363838/` 中，先确认实际原生歌词/壁纸活跃，再终止该次 DBX PID；约 **1051 ms** 清空音乐数据，宿主与两版 sidecar 无残留，独立组件仍存活、环境动画继续。组件随后通过自身 quit 正常退出 0、forced=false，窗口状态恢复，日常全局文件摘要无变化。该次宿主 exitCode=1，明确按 Windows 强制进程结束记录，不混入前述正常退出三组；驱动最初错误要求 null，已按实际退出记录修正。报告 `transition-force-1793230467653.json`，聚合 `output/dbx-desktop-d3/forced-gui-verified.json`；图形强退样本只覆盖当前 Full，其余组合仍使用已有真实运行时边界证据。

**剩余验收：** 物理系统媒体键、声学听测、实施前图形包差分、真实跨用户/交互会话、物理锁屏/显示器/Explorer 恢复、八小时资源长稳、其他 OS 基础回归及签名/商店发布尚未完成。新增证据缩小了未验范围，完整 D3b 仍未通过。

## D3b：真实八小时长稳（进行中）

最终配套候选于 `2026-10-28T23:42:53.508Z`（北京时间 2026-10-29 07:42:53）开始八小时实跑，预计 `2026-10-29T07:42:53.508Z` 结束。会话为 `output/playwright/dbx-desktop-gui-baseline-1793230719783/`；控制器 `output/dbx-desktop-d3/gui-eight-hour-soak.js`，资源采集 `sample-owned-process-tree.ps1`。DBX PID 596、独立组件 PID 26072、采样控制器 PID 27444；初始两版 sidecar PID 19012 / 1028 的 CreationDate 已写入 manifest，每次先核对相同进程仍存活，再发只读 RPC，避免 RPC 重启掩盖崩溃。

官方当前 0.6.47、最终 Full 来源、真实网易云曲目循环播放；真实安装、显式授权/切源/分别启用及在线取词报告保留在该会话目录。插件工作台和原生中心已由真实 UI 关闭，歌词和壁纸继续运行。每 30 秒向 `soak/samples.jsonl` 记录专属 desktop / sidecar / dbx 进程树的私有提交、工作集、CPU、句柄、线程、GPU 计数与两种真实快照/画面统计；`soak/latest.json` 为运行状态，实际结束后才生成 `soak/report.json`。2/4/6 小时分别安排原 RPC 暂停恢复、撤销重连与 seek，不替换时钟或 feed。

预定义增长门槛比较预热后 30–60 分钟与末尾 30 分钟的进程树私有提交均值，增长不超过 `max(32 MiB, 基线 10%)`。结束后还需检查采样空档、播放时钟、持续增长趋势、各干预和正常退出/专属进程回收；绝对 CPU/GPU 发布阈值尚未冻结，只记录实测数值。设备为 Windows 11 x64 build 26200、Intel UHD / RTX 4060 Laptop、WebView2 156.0.4314.50、16 逻辑处理器；不代表全部硬件。音量为零，不包含声学听测。**目前仍在运行，未计通过；完整 D3b 保持未完成。**
