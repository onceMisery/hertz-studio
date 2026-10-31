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

## D3b：真实八小时长稳（本次中断，未通过）

冻结配套候选于 `2026-10-28T23:42:53.508Z`（北京时间 2026-10-29 07:42:53）开始八小时实跑；实际于 `2026-10-29T00:22:14.352Z` 中断，只有 75 个样本、约 38.82 分钟，未达到八小时。控制器检测到 `owned root missing: 26072`；原生监督报告 exitCode=4294967295、forced=false，只证明监督驱动没有强制结束该进程，退出原因尚未确认，不能直接归因为产品崩溃或外部操作。会话为 `output/playwright/dbx-desktop-gui-baseline-1793230719783/`；控制器 `output/dbx-desktop-d3/gui-eight-hour-soak.js`，资源采集 `sample-owned-process-tree.ps1`。DBX PID 596、独立组件 PID 26072、采样控制器 PID 27444；初始两版 sidecar PID 19012 / 1028 的 CreationDate 已写入 manifest，每次先核对相同进程仍存活，再发只读 RPC，避免 RPC 重启掩盖退出。

官方当前 0.6.47、最终 Full 来源、真实网易云曲目循环播放；真实安装、显式授权/切源/分别启用及在线取词报告保留在该会话目录。插件工作台和原生中心已由真实 UI 关闭，歌词和壁纸继续运行。每 30 秒向 `soak/samples.jsonl` 记录专属 desktop / sidecar / dbx 进程树的私有提交、工作集、CPU、句柄、线程、GPU 计数与两种真实快照/画面统计；`soak/latest.json` 为运行状态，实际结束后才生成 `soak/report.json`。2/4/6 小时分别安排原 RPC 暂停恢复、撤销重连与 seek，不替换时钟或 feed。

预定义增长门槛比较预热后 30–60 分钟与末尾 30 分钟的进程树私有提交均值，增长不超过 `max(32 MiB, 基线 10%)`。本次不足以形成完整基线或末尾窗口，2/4/6 小时干预均未执行，不能用已有样本宣称长期稳定或内存通过。绝对 CPU/GPU 发布阈值尚未冻结，只记录实测数值。设备为 Windows 11 x64 build 26200、Intel UHD / RTX 4060 Laptop、WebView2 156.0.4314.50、16 逻辑处理器；不代表全部硬件。音量为零，不包含声学听测。控制器随后请求 DBX 正常退出，监督驱动确认窗口状态恢复且日常全局文件摘要不变。**本次长稳未通过；完整 D3b 保持未完成。**

补充只读复核入口 `output/dbx-desktop-d3/analyze-eight-hour-soak.js`：从原始样本检查相同 sidecar 身份、采样间隔、两种来源 session/文档/seq、壁纸绘制计数及播放时钟，生成半小时内存均值与趋势。运行中只写 `in-progress-analysis.json` 且 passed=false；实际结束后才生成 `post-run-analysis.json`，仍需人工复核趋势和监督驱动的退出报告。30 秒样本只能发现粗粒度停滞，不证明声学连续性。长稳期间并行准备以下隔离构建，资源数值代表该实际后台工作负载，不宣称空闲设备的绝对性能基准。

## D3b：兼容性与提交基线补验（进行中）

新增 `hertz-desktop-ipc` 在现有 Windows x64 的 Rust **1.88.0** 下执行 `cargo check --locked -p hertz-desktop-ipc --all-targets -j 2`，使用独立 target 与 `-D warnings`，**22.83 秒通过**；日志 `output/dbx-desktop-d3/msrv-ipc.log`。业务库、原生组件与 sidecar 的同版 `--all-targets` 检查也已通过：Full 5 分 32 秒、Standard 1 分 10 秒，日志 `msrv-full.log` / `msrv-standard.log`。本轮默认值和平台编译修正后再验 Full 1 分 23 秒、Standard 38.65 秒通过，后者日志 `msrv-standard-after-lyrics-defaults.log`；最终 CSS 另已重新构建原生组件。上述为 Windows x64 MSRV 编译证据，不扩展到整个支持矩阵。

WSL2 Ubuntu 26.04 x64 已在任务目录准备 Rust 1.98.1、Linux C 编译/链接器、ALSA/DBus 开发库及 Node 24.11.0。deb 只下载并解包到局部 sysroot，Rust/Cargo 路径和配置显式隔离；未使用 sudo 安装、修改发行版配置或借用 Windows pkg-config。下载记录/摘要与驱动均位于 `output/dbx-desktop-d3/linux-validation/`。首轮同冻结候选的构建因 `-D warnings` 下非 Windows 未使用的 `Tab::name` 和三项私有授权占位方法失败。现已只对 Windows x64 编译该名称方法，移除其他平台没有调用方的私有占位方法；公开 unsupported 返回不变。续跑发现原 `/tmp` 副本已不存在，改在 `/var/tmp/hertz-d3-linux-lyrics-defaults/` 保存隔离副本与 target。复制时发现共享工作树的两项其他 UI 文件也已变化，重新记录当前输入并逐文件校验，未将续跑冒充旧冻结候选。新驱动 `resume-after-lyrics-defaults.sh`、输入 `source-linux-after-lyrics-defaults.json` 和 `snapshot-after-lyrics-defaults.json` 记录实际范围；当前仍在编译，尚无 Linux 产品回归通过结论。

另从 `1d042b8` 导出独立旧源码，zip SHA-256 为 `75e3cd116982e53bbd1a7f19f25cdbcd65a064224e14fca47b854aff7266f719`。`output/dbx-desktop-d3/baseline-package/` 正在以同一 Rust 1.98.1 构建两版旧 `.dbxp`，供提交基线图形差分使用；Standard 包已成功产出，Full 仍在编译，尚未开始这轮图形差分。驱动的 PowerShell 5 stderr 和 CLI SDK 路径配置失败已单列，未当成产品通过，也未修改历史产品源码或依赖 pin。此提交基线不等于最初未提交工作树的逐字重建；实际差分证据须明确比较范围。**这些进行中项目均不勾选 D3b。**

## 2026-10-29：单行无边框默认值及设置滚动条

按用户追加要求，新歌词配置和前端缺省值同步为 `layout=single`、`surface=bare`、`bilingual=false`，不覆盖已保存的显式偏好。设置面板使用 8px 滚动条、透明轨道、随深浅主题变化的圆角滑块，去除 Chromium 原生箭头并固定滚动条空间；仅纵向滚动，保留标题和完成按钮，标题使用不透明背景避免滚动文字透出。修改在独立组件配置及歌词资源内，不改变 DBX 播放、队列、房间或媒体键合同。

Rust 1.88.0 下桌面组件 **51/51** 测试通过，包括旧配置补缺省及显式三行/毛玻璃/双语设置的往返保存；窄格式检查通过。既有 `check-desktop-lyrics-browser.js` 和 `check-desktop-dbx-browser.js` 通过，新增检查实际验证新缺省值、深浅主题窄面板无横向溢出、底部宽度按钮可点击及滚动后完成按钮可见。截图 `output/playwright/desktop-lyrics/{default-lyrics,scrollbar-dark,scrollbar-light}.png`；浏览器显式保留滚动条显示，避免 headless 默认隐藏掩盖问题。

最终 CSS 构建后，真实 WebView2 原生回归通过：`output/playwright/desktop-lyrics-native-1793233997034/`。校验 Windows 标题栏样式过滤仍有效、设置扩高不压缩歌词、滚动底部无横溢出、完成按钮可见、原显式偏好持久化及独立版原句首 seek / 播放暂停 / 锁定恢复；该 fixture 不代表完整真实 DBX 图形或八小时长稳通过。

本次组件测试构建 `output/dbx-desktop-d3/msrv-target/debug/hertz-desktop.exe` 的 desktopBuildId 为 `43afabf105cf63da61f27a61c5683fc3e8429b518eec71e84f5c2cdb51838011`，SHA-256 为 `8d640c42bddad56ce49b0c352edddad1b80b6d55ca84b793ef0223eb4c47aa25`；桌面 72 项输入指纹为 `7cfc75b0cc581e046fbe48a98e2a357fdcfa83b4df8463f4259e7d5591306401`。旧 zip / `.dbxp` 不包含本轮修改，新正式配套候选尚待统一重建；旧候选的图形结果与中断长稳不能冒充新构建证据。

## D3 增量：Linux 实际回归、新组件与提交基线包

Linux 续跑已于 `2026-10-29T00:52:31Z` 完成，整体退出 0。Rust 1.98.1、WSL2 Ubuntu 26.04 x64、`-D warnings` 下 Standard / Full 实际编译分别 12 分 27 秒、1 分 23 秒成功；IPC 跨平台协议检查 **4/4**，共用 desktop 门面 **3/3** 通过。两版 ELF 的原 stdio 回归分别 **311/311**、**295/295**；相较 Windows 各少三项平台专属检查，不把数量差异当失败。原日志均位于 `output/dbx-desktop-d3/linux-validation/`，执行驱动 `resume-after-lyrics-defaults.sh`。

实际 Linux 两版进程各验证全新目录及带已有授权文件两种状态，共四组：capability supported=false / reason=unsupported-target，connect/disconnect 返回准确不支持错误；health、state、queue、settings 在前后均正常，授权与钥匙文件 hash 不变，没有生成新桥发现、钥匙或 native 配置目录，EOF 约 0.83–1.04 秒退出 0。报告 `unsupported-1793235142814/report.json`；Standard ELF SHA-256 `cc8a3b4ac19323e8d9c831564df76687db6749319c3d84cb06f094d891a9c801`，Full `6b5f1a536b71eca8f0bd456082d25b3e7bff6d2829374e58bcd2cf7aaa7863cd`。采用 null 音频后端、内存 secrets，不包含声学、Linux GUI、macOS 或 ARM64 资格验证。受测插件输入为 `79cf02d60fbb7826d764f518b2913023c2f0525266d16dacd74ca1305d145299`，不是此前旧冻结候选，也不是下文后续 Windows UI 副本。

最新歌词修改的 release 组件已重新构建并打包：`output/dbx-desktop-d3/lyrics-defaults/component/hertz-desktop-0.3.0-windows-x64.zip`，zip SHA-256 `83bfc48e186330041888990e767d11440e3524e95fdbd8631bf14d8fa8dac446`，exe SHA-256 `830535bc5ba52277f3ef417f758780b8374d4eb781dd0ca09e23d2d37f0e4ac3`，desktopBuildId `3c9ebad09b8224dedbf17b9a479b81be2f2fb5d53619336fd4e64348accd79c8`。使用 Rust 1.98.1 release、无额外 rustflags；与上文 MSRV debug 构建身份不同是预期。解包清单、每项 hash、x64 PE、两秒有界 `--describe` 与无配置副作用检查通过，报告 `lyrics-defaults/component-verified.json`。

该 release exe 的真实 WebView2 歌词回归再次通过，证据 `output/playwright/desktop-lyrics-native-1793235127924/`。真实 D0 旧 zip → 本次 zip 的隔离手工升级及备份恢复也通过：运行中覆盖实际 EBUSY、原文件与配置未变，正常退出后升级，schema 2 → 3 只迁移一次，原 double / glass / bilingual=true、字号、不透明度与两项 disabled 均保留，恢复旧包与配置后再次正常退出。报告 `output/playwright/desktop-package-upgrade-1793235008874/report.json`。不是日常目录安装或签名安装器验收。

Windows Standard / Full 新包从 `lyrics-defaults/source/` 隔离副本构建，避免其他聊天编辑共享工作树影响期间输入。`snapshot-verified.json` 核对 72 项桌面输入与 547 项插件输入；桌面指纹仍为 `7cfc75b0cc581e046fbe48a98e2a357fdcfa83b4df8463f4259e7d5591306401`，插件为 `bcf2604dad22454a5d619a535e19953e128b172d831aa1eda5e08f72ca223f62`。此副本还包含共享工作树当时的舞台 UI 修改，不归为 DBX 桥行为修改。两版新包仍在实际 CLI 构建，配套标识、包体验证、运行时及图形复验继续待验。

历史提交 `1d042b8` 的 Standard / Full `.dbxp` 已完成构建和包体校验，报告 `baseline-package/verified.json`：Standard 包 SHA-256 `ddd2fad5625be35554494d2dec79686d8f45ff9013b59dc73fa550b1366b4596`，Full `0c02bbeed0d69ee1dc22d4e1d6675e0c8221aa3752a2f88e5a0db9544a61cb86`。已在新的官方 0.6.47 隔离会话 `output/playwright/dbx-desktop-gui-baseline-1793235071238/` 安装，准备相同媒体与图形差分。首次 Full fixture 扫描恰遇根目录自动扫描返回 already-running，驱动改为等待该实际扫描完成，后续准备成功；没有更改产品扫描逻辑。该基线对应提交源码，不冒充最初 dirty 工作树。**完整 D3b 仍未通过。**

## D3 增量：提交基线的真实独立插件图形流程

官方当前 0.6.47 的同一隔离会话中，历史提交 `1d042b8` 的实际 Standard / Full 包分别通过真实 UI 播放、25% seek、单曲队列、一分钟睡眠定时、主题/预设持久化及工作台关闭/重开。实际定时分别为 61.374 / 61.536 秒；关闭后先核对同一 sidecar PID 与 CreationDate，再发 RPC，避免重启掩盖生命周期变化。关闭期间继续播放，重开保留主题和预设，并按原规则清除进行中的页面倒计时。

报告为 `output/playwright/dbx-desktop-gui-baseline-1793235071238/difference-before-standard-1793235560434.json`、`difference-before-full-1793235869480.json`，邻接保存截图。两版均实际观察到原八种 MediaSession 操作注册、零新增桌面请求、无组件安装或桥授权/发现/钥匙文件；音量为零。此项是新包对照基线，后续必须使用新实际包执行同一路径，才形成前后差分；不代替物理媒体键、声学听测或最初 dirty 工作树的重建。

## D3 增量：歌词默认值修改后的 Windows 配套候选

隔离源码的 Standard / Full release 分别约 21 分 22 秒 / 22 分 04 秒构建成功，实际 CLI 均生成 unsigned review candidate。构建后主工作树的 72 / 547 项输入仍与隔离副本一致。包体检查 `lyrics-defaults/plugin-candidates/verified.json` 通过：metadata 与每文件 checksum、无重复/越界归档项、x64 PE、原权限与最低宿主、逐字一致的分版 UI/assets；Standard 无 Full 资源/协议，两版均不夹带可选桌面 exe。

| 发行版 | 新 `.dbxp` SHA-256 | 包内 sidecar SHA-256 |
| --- | --- | --- |
| Standard | `6f7a43de4abf1fd70b19404a804c9e0f04545e98797688006006391a6abd6728` | `90b2d69579280114d0578190bb2c401cf0cf2deb5019fefc17b9de0a8d36e42a` |
| Full | `a9df9301bfb2c120120e15b6bd55725dccb600b6ff5682177e05149f8c090405` | `1a22c83809b91d9c16b62b3dfe172ad2f57b592faa09bd384e4e78485ccff955` |

直接使用新包内 exe 执行原 `scripts/check-plugin-sidecar.js`，Standard **314/314**、Full **298/298** 通过，日志 `lyrics-defaults/stdio-{standard,full}.log`。最低 0.6.35 / 当前 0.6.47 的实际 DBX PluginHost 再次加载新两版 exe，各执行未授权/已授权两种状态，共八组通过；未授权无桥文件，已授权两 scope 的真实管道快照与来源 session/发行版一致，基础 RPC 及正常停止均正常。每组还实际调用 capability，断言 `requiredDesktopBuildId` 等于新组件的 `3c9ebad09b8224dedbf17b9a479b81be2f2fb5d53619336fd4e64348accd79c8`，并非只比较打包清单。报告 `lyrics-defaults/runtime-final-1793236357451/verified.json`。

同一官方 0.6.47 隔离图形会话通过真实 `install_plugin_package` 从历史基线升级安装新两版包，保留原数据；回执 `install-1793236380539.json`。工作台刷新后已开始新包的相同图形差分。上述不包含签名、商店发布或日常安装；完整八小时及物理系统验收仍待完成。

## D3 增量：新两版包独立运行的实际前后差分通过

`output/playwright/dbx-desktop-gui-baseline-1793235071238/difference-comparison.json` 汇总同一官方 0.6.47 宿主、同一数据中历史 `1d042b8` 与本次新包的四轮相同真实 UI 流程。新 Standard / Full 均通过，实际一分钟定时分别 60.926 / 61.918 秒；新旧队列与 track id、主题/定时预设、工作台关闭期间同一 sidecar 身份及播放延续、重开倒计时清除、原八类 MediaSession 操作注册一致。两版新包在无组件/未授权使用中，均为零新增桌面请求，未生成桥文件，gate/listenerReady=false、reason=not-detected。

新报告为 `difference-after-standard-1793236403179.json`、`difference-after-full-1793236529994.json`。会话随后正常退出，监督报告 `report.json` 确认全局窗口状态恢复且日常全局普通文件摘要无变化。此差分支持已覆盖的“DBX 独立使用无行为变化”检查；不外推为物理媒体键、声学听测、最低宿主图形差分或全部 D-A16 通过。

## D3 增量：新候选原生联调通过、第二次长稳中断

全新官方 0.6.47 隔离会话 `output/playwright/dbx-desktop-gui-baseline-1793236714419/` 通过实际安装新两版包、扫描本地 WAV/LRC、真实 UI 显式授权。独立启动的新 release 组件 SHA-256 为 `830535bc5ba52277f3ef417f758780b8374d4eb781dd0ca09e23d2d37f0e4ac3`。新建 Standard / Full DBX profile 均实测两项 enabled=false、layout=single、surface=bare、bilingual=false；授权不会自动切换原生来源。显式切换并分别启用后，真实歌词文档、playing、发行版与壁纸有效 feed 一致，歌词工具条播控禁用。报告 `native-session/activate-standard-1793237143469.json`、`activate-full-1793237233428.json`，邻接保存真实 surface 截图。

原生 Full 来源在未锁定且快照新鲜时，直接向真实 IPC 发送 pause / seek / play 伪造消息，实际 DBX playing、track id 与连续进度均未被改变；同时核对实际 DOM 为 single / bare 和 lyricsControl=false。报告 `native-session/dbx-forged-controls-1793237270517.json`。新 Full 包又通过真实网易云搜索、取词、在线播放，原生收到 43 行且 documentKey 与快照一致；报告 `real-online-lyrics-1793237307301.json`。音量仍为零，不包含声学听测。

联调驱动的初次检查错误把组件状态写为不存在的 compatible 字段、忽略管理状态缓存的过期规则，并调用 FrameLocator 不支持的 waitForFunction；三个失败报告保留，未作为产品失败或通过。驱动按实际 DTO 的 component.state=ready、管理检测完成后检查及 locator enabled 条件修正，随后 Standard / Full 通过。Standard 的首次授权为此前真实 UI 手动点击，后续脚本明确记录 consentClicked=false；Full 脚本记录首次点击并检查授权前后状态，未冒充两次首次授权。

同会话于 **2026-10-29 09:29:02（北京时间）** 启动新配套候选的八小时实际长稳。DBX PID 21604、独立组件 PID 32504，控制器 PID 6992；原生中心和工作台关闭后，真实 Full 在线曲目继续播放，两 surface 同源。34 个样本、约 **17.20 分钟**后，资源采样子进程失败；控制器于 **09:47:04** 结束并主动请求双方退出。本轮未执行 2/4/6 小时干预，不具备完整资源比较窗口，**八小时未通过，D3b 未完成**。旧候选约 38.82 分钟后原生退出的失败独立保留，不能混为同一种原因。

原始样本和失败分别保存在 `soak/samples.jsonl`、`soak/report.json`。旧控制器没有保存采样失败的 code/signal/killed/stdout/stderr，不能断言是超时、产品崩溃或系统睡眠。双方监督报告均 exit=0，原生 forced=false、binaryUnchanged=true；DBX windowStateRestored=true、globalFilesChanged=[]。CIM 复核专属进程已无遗留。`soak/post-run-analysis.json` 的 findings=[]、controllerIssues=[]，33 组时钟差异均值约 14.5 ms、p95 约 41.1 ms，仅支持已采样时段，不代表长稳通过。

本地控制器 `gui-eight-hour-soak.js` 已改为保存失败诊断并直接检查原 root PID；进程仍活着时延迟五秒重试同一实例，不发可能重新启动 sidecar 的 RPC，不重置单调时钟。原 PID 明确 ESRCH 时才确认退出；大于 120 秒的采样间隔仍记录为失败。实际子进程验证通过，报告 `output/dbx-desktop-d3/observer-retry-1793239501167/report.json`：第一次 exit=9 的 stdout/stderr 和退出字段完整，约 5.11 秒后第二次观察成功，原进程仍活着；真实终止原子进程后正确拒绝。此项是驱动验证，不能当成产品长稳证据。

## D3 增量：新包故障恢复与退出屏障补验

使用本次包内原 exe，再执行六种未授权/坏恢复状态，两版共十二例通过：未授权、只有钥匙、持久撤销但钥匙残留、未来授权 schema、坏 JSON、已授权但钥匙缺失。原 SDK initialize、health/state/queue/settings 保持正常，stdout 纯 JSON，已有授权/钥匙摘要不变，无新增桥发现/锁/凭据和原生配置；EOF 约 4–8 ms 正常退出。原始报告 `output/dbx-desktop-d1/inert-standard-1793237834643/report.json`、`inert-full-1793237834660/report.json`，对应的包内 hash 与本次候选完全一致。

新两版实际管理 probe/open/v2 应答等待期间 stdin EOF 六例也通过：约 6.5–30.0 ms 退出 0，fixture 观察实际 I/O 取消，授权仅在预期 open 场景产生；报告 `output/dbx-desktop-d3/management-eof-standard-1793237834804/report.json`、`management-eof-full-1793237834804/report.json`。固定句柄 fixture 仅为受保护本机管理管道，不是第二个图形组件。

两版再以有效授权、lyrics/wallpaper 两条真实数据管道均半帧阻塞的状态执行原房间 EOF 检查，均通过：在途 SDK RPC 仍存在时关闭 stdin，sidecar 正常退出、guest 收到终止 End 并恢复静音 local、授权未被误撤销。报告 `lyrics-defaults/authorized-room-eof-{standard,full}.json`。guest 使用的独立服务 SHA-256 为 `3e98fe1bd518df953e769effd6df0b77e35a2b491cf6cd276ef6023dbbe932f8`；此处验证新包的房间屏障，不冒充新配套独立服务验收。该旧 exe 已在重建前保存为 `lyrics-defaults/previous-standalone-3e98fe1b.exe`。

新组件配套的独立 Standard 服务已以同一隔离源码和 release 参数构建，日志 `lyrics-defaults/standalone-standard-build.log`。在第二次长稳两端退出、确认无冲突实例后，保持已有实例保护，实际 HTTP/native 回归通过。完整逐项缺口见 [D-A01–D-A18 审计](./2026-10-29-dbx-desktop-acceptance-audit.md)，不因补验通过缩小范围。

配套独立 Standard 服务隔离 release 构建已在约 5 分 52 秒后成功，exe 已单独暂存到 `lyrics-defaults/standalone/bin/hertz-studio.exe`，SHA-256 `ff3bb1495c6bd709ae94024914679fb750780c0db8b4c5d42f9d666bb198055e`，相邻组件与清单逐字取自本次新组件。报告 `lyrics-defaults/standalone-http-1793238990826/report.json` passed=true、serverExitCode=0，并核对了上述服务和新组件的实际 hash：未运行时 control=503，health/state 正常；原 lyrics/wallpaper launch、管理 status、字体样式保存及来源 feed 正常，不支持的命令按原合同拒绝，正常 shutdown。`standalone/built.json` 已据报告更新 nativeHttpVerified=true。该 Standard 静音隔离回归不代表 Full、声学或物理桌面资格验证。

## D3 增量：第三次真实八小时运行（进行中）

确认前一轮监督已终止且无专属残留后，建立新的官方 0.6.47 隔离会话 `output/playwright/dbx-desktop-gui-baseline-1793239677882/`，再次实际安装相同新两版包、准备本地曲目，并独立启动同一新 release 组件。Standard / Full 两次首次授权均由真实 UI 点击且 consentClicked=true，授权未切换来源；新 profile 均为 single/bare/bilingual=false、两项 enabled=false。显式切源与启用报告为 `native-session/activate-standard-1793239833463.json`、`activate-full-1793239903006.json`；真实 Full 网易云搜索/取词/播放再次通过，原生 43 行，报告 `real-online-lyrics-1793239906949.json`。

本轮于 **2026-10-29 10:12:07.905（北京时间）** 从零开始，预计 **18:12:07.905** 后结束。DBX PID 15868、组件 PID 19636、控制器 PID 32112；监督工具会话分别为 9966、60454、40986。原生中心和工作台已实际关闭，两个原 sidecar 继续运行，Full 真实在线曲目在零输出增益下循环。`soak/manifest.json`、`soak/latest.json`、`soak/samples.jsonl` 保存身份、原时钟及每次真实观察；采样失败诊断写 `observation-errors.jsonl`，只重试原实例。原 2/4/6 小时干预、120 秒采样间隔上限及完整资源窗口仍保持。复核命令为 `node output/dbx-desktop-d3/analyze-eight-hour-soak.js output/playwright/dbx-desktop-gui-baseline-1793239677882/soak`。本条仅登记启动，不是完整长稳通过，也不覆盖前两次失败。

## 2026-10-29：点击歌词设置时原生白条的增量修复

用户再次提交原生标题栏截图，已保存在 `output/dbx-desktop-d3/nonclient-repaint/user-white-bar.png`。核对当时只有正在测试的 release 组件 PID 19636，不能归为另一个旧进程。保持原实例的 15 次设置开关及 2000 次 Win32 样式/几何观察均未捕获异常（`native-session/settings-frame-1793240480130/report.json`），只能说明 style 位和客户区没有采样到变化，不能否定间歇出现的绘制白条。

原实现仅过滤 `WM_STYLECHANGING`；增量在歌词专用窗口过程中明确让 `WM_NCCALCSIZE` 保持整个窗口为客户区，并处理 `WM_NCPAINT`，不交给系统绘制非客户区。`WM_NCACTIVATE` 仍交给原 Tao 过程，仅传文档定义的 `lParam=-1` 禁止默认框重绘，保留焦点状态处理。壁纸/设置中心/小窗不安装此专用处理；未改 DBX 播放或桥权限。

为实际验证新代码，先在 `soak/requested-stop.json` 记录有意中止，于 10:25:48 请求原组件正常退出；控制器按原规则于 10:26:09 结束，27 样本、约 13.51 分钟。native exit=0、forced=false，DBX exit=0、窗口状态恢复、globalFilesChanged=[]。事后 findings=[]、controllerIssues=[]，仍未覆盖八小时或资源窗口；不是第二轮采样故障的复发，也不归为产品自行退出。

MSRV Rust 1.88.0、`-D warnings` 的组件构建及 **51/51** native 测试通过。既有原生检查器增强为实际激活/非客户区重绘、样式刷新和重复设置开关，保留原独立版 IPC/句首 seek/播放暂停/锁定与托盘恢复检查。debug 首次检查通过后又补齐当前单行组合；最终 release 的实际 WebView2 检查通过，证据 `output/playwright/desktop-lyrics-native-1793241339089/`：旧三行/毛玻璃/深色 6 轮、单行/无边框/浅色 6 轮，共 29 次 Win32 断言，全部 frame 位为零、客户区与窗口完全重合，截图保留为 `single-bare-settings.png`。汇总 `nonclient-repaint/native-regression.json`。这不能代替完整物理显示/会话恢复或长稳。

新冻结源码位于 `nonclient-repaint/source/`，与上一批 72/547 项输入逐项比较，仅 `crates/hertz-desktop/src/native.rs` 改变；桌面指纹 `7a3ed96e5877a896d8add4314074a41e0dc0fb048b6168a2b2b64a33fe3d2928`，插件 `60cfec118666d2d5c04b2fa652353b7fd8826227815b6c112470852db5d10c4a`。release 使用本机稳定工具链 Rust **1.98.1**、空 RUSTFLAGS；显式版本别名触发重复工具链下载的初次命令已结束，再使用已安装同版本构建，未改变默认工具链或产品源码。

新组件已完成 release 构建、打包与清单/hash/PE/无副作用 describe 校验：zip SHA-256 `e8885d3c699cc908aef740682a84bc548b1a0a42a22593ca816dc194bf52851c`、exe `a204336cd3ffd2abafb8a3906005dbbd41868f1f738f338f59985fd301e00620`、desktopBuildId `433e3ea53b69b9c8b9155f27732bc261f482756ac3bc771d129d7e5855b0dce2`，报告 `nonclient-repaint/component-verified.json`。本条记录时两版新 `.dbxp` 正在 CLI 构建（工具会话 6513 / 49056），第三轮已结束；随后构建及联调结果如下，旧包不能冒充包含本修复的新配套包。

## 2026-10-29：白条修复配套包、实际联调与第四轮长稳

两版 CLI 构建均 exit=0，`nonclient-repaint/plugin-candidates/verified.json` 验包通过。Standard 包 / 包内 exe SHA-256 为 `9b91148c4778b00d184d4438ab62306b1dd0df3de3c66ff6d5c04d5ba411379f` / `9a730e22cf9fcc3f9c7d857c4f26f7db729c9526e7dbd460e4e669bff1f268b0`；Full 为 `fe9ea064a22a527288ce02cd017f3466f187407f905fd4f5b2e53118e154d60b` / `fb617addbab99c8e8d0754323affd5ba43fe40a3d20f97b4f97a7831b6096fb3`。检查 metadata/checksums、安全归档、x64 PE、原权限/最低宿主、逐字分版资源、Standard 裁剪及不夹带桌面 exe。冻结副本构建前后主树输入指纹一致。

包内原 stdio Standard **314/314**、Full **298/298**（`stdio-standard.log` / `stdio-full.log`）。Full 首次检查漏设 `HERTZ_EDITION=full`，只有发行版预期一项失败，原日志 `stdio-full-driver-edition-mismatch.log` 保留；准确指定后通过，未改产品或测试降低要求。最低 0.6.35 / 当前 0.6.47 真实 PluginHost × 两版 × 未授权/已授权的八组检查全部通过，实际 capability 断言配套 `433e…` build，报告 `runtime-final-1793241604060/verified.json`。

隔离官方 0.6.47 的新图形会话 `output/playwright/dbx-desktop-gui-baseline-1793241731703/` 安装本次两版包并准备媒体。两版首次真实 UI 授权均 `consentClicked=true` 且不切源；报告 `connect-standard-1793241832294.json`、`connect-full-1793241939743.json`。新 profile enabled=false、single/bare/bilingual=false；显式切源启用后，实际歌词文档/playing、同来源壁纸及禁播控通过，报告 `native-session/activate-standard-1793241926308.json`、`activate-full-1793241991874.json`。Full 再次真实网易云搜索/歌词/播放，组件收到 43 行（`real-online-lyrics-1793241995325.json`）。新 release 在真实 DBX 来源下 15 次设置开关、2000 次 Win32 观察无 frame/几何异常（`native-session/settings-frame-1793241996227/report.json`）；这不是对间歇绘制原因的确定复现。

第四次八小时从北京时间 **2026-10-29 10:48:30.159** 重新计时，预计 **18:48:30.159** 后结束；本次会话的 `soak/` 保存原时钟和采样。原 DBX / native / controller PID **32320 / 8980 / 27916**，工具会话 **65140 / 65039 / 50378**，记录 `nonclient-repaint/fourth-soak-handles.json`。接续核查三个原工具句柄均仍在运行。两个 sidecar 保留，Full 实际在线单曲循环、volume=0，工作台与原生中心实际关闭；按原 30 秒采样、2/4/6 小时干预和大于 120 秒间隔失败规则继续。该条登记启动和进行状态，未通过完整八小时，不累计前三轮。复核必须明确当前目录：`node output/dbx-desktop-d3/analyze-eight-hour-soak.js output/playwright/dbx-desktop-gui-baseline-1793241731703/soak`。`lyrics-defaults/` 的独立 Standard HTTP/native 报告属于上一组件 build，不能冒充此次构建。

## 2026-10-29：最终包数据管道与目录别名隔离验证

驱动 `output/dbx-desktop-d3/verify-packaged-data-pipes.js` 直接启动本次包内生产 sidecar，隔离目录、null 音频、memory secrets 和当前用户 SID ACL；不触碰运行中的长稳。`nonclient-repaint/data-pipes-1793242291983/report.json` 的两版 **54 例**通过：双 scope 零长/超长/半 header/半 body、非法 UTF-8/JSON、尾随 JSON、缺/未知字段、多帧；错误 key、scope 复用、错误 session 和写动作均无业务数据。三轮实际并发保留每 scope 两个、全局四个未完成连接，多余两个关闭时原四个仍 pending；约 2.05–2.07 秒后实际断连并恢复请求。阻塞期间 SDK health 约 12–20 毫秒；再执行 40 个有效请求，句柄 **201→201 / 227→227**。普通 EOF 约 15–20 毫秒 exit=0，授权文件保留，同目录真实重启 session 更新且原授权恢复，最终 exit=0。stdout 纯 JSON、无 native 配置。这不覆盖慢大文档、慢读回写、跨用户或图形宿主 kill 矩阵。

驱动追加 `--aliases-only` 后，两版 **6 例**通过，报告 `nonclient-repaint/data-pipes-1793242606414/report.json`：大小写、`\\?\` 扩展前缀和真实 junction 指向同一目录，原 owner 活着时第二个实际 sidecar 均 `desktop_source_conflict`、gate/listenerReady=false，health/state/queue/settings 均 200。原发现文件 hash 不变，原两 scope 可应答；非 owner 正常退出后发现仍在、授权 hash 保留、无 native 配置。两版最终句柄差值均为零，primary EOF/真实重启恢复也通过。junction 保留为证据，不随意递归清理。本结果不代替并发强杀、迟到旧 owner 清理或移动 DataDir 的完整场景；追加模式后未重复原 54 例，两份报告各自保存当时 driverSha。

## 2026-10-29：最终包拥有者恢复、撤销落盘与实际播放/慢读补验

接续时原 DBX / native / controller 三个工具句柄均确认 live，未重启长稳。下列生产 sidecar 检查各使用新的隔离目录、当前用户 SID 私有文件、null 音频和 memory secrets，不连接运行中的图形宿主或组件，不代表声学/物理恢复验收。

`output/dbx-desktop-d3/verify-packaged-owner-recovery.js` 对两版共 **8 项**通过，报告 `nonclient-repaint/owner-recovery-1793243578724/report.json`。先建立真实 owner 和冲突 sidecar，再在四个已连接半帧请求挂起期间强制终止 owner；四个客户端约 **16.78 / 15.34ms** 全部断开且零业务字节，旧发现与授权 hash 保留。新实例取得原目录独占锁，生成新 session，旧管道关闭、向新管道重用旧 session 被拒；两 scope 与基础 RPC 恢复。原来已经存活的冲突 sidecar 在新 owner 发布后才正常退出，不删除新发现。该场景是实际旧冲突实例迟到退出，不冒充把旧 owner 的清理人为延迟到独占租约释放之后。

双方正常退出后，将本轮实际目录移到同一输出根内的另一个位置；移动前验证源/目标都在本轮目录且源不是链接。重新启动包内 sidecar，规范来源目录更新、session 更新，原三份授权/钥匙 hash、设置和队列保持，两 scope 正常；旧目录不存在，最后 exit=0、发现移除且授权保留。该项不包含 native 旧 profile 重绑定、真实宿主卸载或跨卷移动。

`verify-packaged-data-pipes.js --revocation-only` 的两版 **10 项**通过，报告 `nonclient-repaint/data-pipes-1793243861708/report.json`。独立 PowerShell 进程以真实 `FileShare.Read` 持有授权文件，阻止原子替换；撤销准确返回 `desktop_revocation_incomplete`、gate/listenerReady=false、persistentRevoked=false，四个已接入半帧连接被取消，授权/钥匙 hash 不变，发现删除，基础 health/state/queue/settings 正常。真实 EOF 后重启恢复旧授权和两 scope，符合失败提示的“重启可能恢复”，不宣称未落盘的禁用已永久生效。

恢复实例再次在授权文件占用时失败，解除占用后显式重试；此时另一个真实进程持有歌词 key，持久禁用成功而 key 删除失败，准确报告 persistentRevoked=true、cleanupIncomplete=true。授权 revision=2、scopes=[]，wallpaper key 删除，lyrics key 仍在。保持该 key 占用正常退出/重启，实际仍 gate/listenerReady=false、无发现，基础 RPC 正常，不把残留钥匙当 consent。释放 key 后再撤销，清理完成、两 key 消失、持久 scopes 仍为空，最后 exit=0。这不覆盖每个提交步骤的崩溃注入或其他用户/会话。

`verify-packaged-data-pipes.js --playback-only` 的两版 **10 项**通过，报告 `nonclient-repaint/data-pipes-1793244522293/report.json`。真实扫描两份本地 WAV，经原 RPC 导入 177012 字节增强 LRC（1000 行、16000 字），再从实际生产管道取完整 **784844 字节**文档。文件偏移 +100ms、单曲 +300ms、全局 -200ms，返回 offsetMs=200，首行和首字均 1200ms，timing=presentation_applied。真实播放器 seek=5000、播放前进、暂停位置冻结；四轮 A→B→A 换曲中旧 key 均返回 409 stale_document，新文档不串曲，回到相同内容恢复相同 key。同曲改词改变 key，清词后 status=empty/key=null，旧文档再次 409。这是生产 sidecar 的本地投影，不代替图形 native 的缓冲/插值与所有在线源专项。

慢读项先暂停客户端读取实际大文档，用另一个半帧占据第二 lyrics 槽，再确认额外连接被拒，证明写入当时仍占槽；wallpaper scope 与 SDK health 仍正常，health 约 **15.73 / 14.53ms**。2 秒总期限后，在原文档客户端仍暂停读取时，两个新的 lyrics 半帧连接可同时接入且保持挂起。随后恢复读取，原文档只有 **65540 字节**并实际 EOF，未读完 784844 字节全文；两 scope 后续可再服务。端到端观察约 **2.37 / 2.38s**，不是对服务端期限增加宽限。该项证实真实取消和槽位回收；全流程还包含扫描/音频加载，句柄数 **201→209 / 227→235**，不能冒充零句柄增长或长期泄漏结论。

## 2026-10-29：新配套独立两版构建与 HTTP 回归

从同一 `nonclient-repaint/source/` 构建 Standard / Full 的独立服务，Rust stable **1.98.1**、release、x86_64-pc-windows-msvc、空 RUSTFLAGS、无 profile override。构建分别约 **5m17s / 4m37s**、exit=0。`stage-matched-standalone.js` 暂存前逐项校验冻结副本的 547 项插件输入，分别复制到 `nonclient-repaint/standalone/{standard,full}/bin/`，配套同一已验 `433e…` 组件，不替换用户目录或长稳中的 exe。

Standard 服务 SHA-256 **`3191d52c716e19e973f651a31612060101a482509d498d85c7e616007668452c`**，Full **`89176d0b4592eb9505c14cc6afa98745f78bbf48b2feceddac537e40c466960f`**。原 HTTP 驱动增加 `--http-only`，分别通过 `standalone-http-1793244203009/report.json` / `standalone-http-1793244660047/report.json`：真实 /v1/health 报告 standard/full 与 cpal、state/设置资源可读、DBX connect/disconnect 仍为 HTTP 404、status 缺实例仍为 503、capabilities 的 requiredDesktopBuildId 精确匹配，服务正常 exit=0 且发现删除；原 native 进程列表前后相同。`standalone/{edition}/built.json` 登记 httpVerified=true、nativeHttpVerified=false。未启动新 native，不把 HTTP-only 通过写成新构建 native launch/control、切回独立版或房间权限全部通过。

截至北京时间约 **11:33**，本次长稳复核 **85 样本、43.76 分钟**，findings=0、controllerIssues=[]、最大采样间隔约 33.73 秒；只是进行中复核，尚未有末 30 分钟、干预或八小时结论。原三个工具句柄本轮再次确认 live。

共享主树输入另有变化：桌面 72 项仍为 `7a3ed9…`；插件主树指纹变为 `7dc6acafeadd894b408511f83b5ff55b192a4a88a138c310f4185e2adbefd0ce`，相对冻结包新增变化为 `crates/hertz-studio/src/online_play.rs`、`plugin/ui/{app.js,online.js,space-home.js,topsearch.js}`。报告 `nonclient-repaint/source-after-owner-recovery.json`。这些共享修改保留，未回滚或混入本批构建；冻结副本仍逐项验证原 `60cfec…` 输入。验收结果不能外推到当前整棵主树，后续若纳入候选必须重新冻结并评估需重跑的范围。

## 2026-10-29 12:18：白条候选补验与 Linux 构建身份纠正

`nonclient-repaint/component-rejection-1793245733615/report.json` 两版 **10 项**通过：实际缺失组件、上一批 `3c9…` exe、损坏 exe、配套组件尚未手动启动、manifest 路径为目录导致真实读取错误，分别返回 missing/incompatible/ready/unknown 与相应可行动错误。均未授权、未建桥、未启动组件，基础 health/state/queue/settings 正常，最后 EOF exit=0。首次驱动误将 plugin/initialize 响应视作 HTTP200，失败记录 `component-rejection-1793245659666` 保留；纠正驱动后通过，未改变产品迁就检查。

`management-interleaving-1793245946202/report.json` 两版 **6 项**通过。生产包内 sidecar 对真实保护管道和协议夹具执行：错误 build 仅收到旧 status，不收到 v2 命令或授权；8 个并发 connect 只发送一次 open-center，真实挂起时 revoke 取消全部，peer 约 82ms 观察取消，迟到结果不能恢复授权；显式重新 connect 成功，后续 8 次重复不更换凭据。不启动组件、不自动切源。夹具 `desktop-management-eof-fixture.exe` SHA-256 为 `d465e4d6e960b6b77ff52155918f53d2d32b74d9e56dbf50128ba2b64814a0b9`；此项不代表实际运行旧版原生 GUI 的图形验证。

`room-eof-standard.json` / `room-eof-full.json` 使用本批包内 exe 与同源新独立服务：双 scope 实际半帧挂起，第二个 discovery 证明首个原房间 RPC 在 stdin EOF 时仍在途；sidecar 正常退出，guest 收到 End、清 membership 并恢复静音 local，持久授权保留。null 音频、loopback TLS，不扩大为完整房间权限或声学通过。`../management-eof-standard-1793246227710/report.json` / `../management-eof-full-1793246228942/report.json` 的 probe/open/v2 六例，约 4.8–33.8ms 正常退出并取消实际管理 peer 等待，已核对准确 exe/hash 与 `433e…` 要求。

索引驱动 `verify-nonclient-progress.js` 生成 `nonclient-repaint/acceptance-progress.json`，核对冻结输入、组件/两版包、7 份包内报告共 **104 项**、真实运行时八组、原生、独立 HTTP、房间/管理 EOF 与 Linux 身份。结果 identityChecksPassed=true、state=partial-acceptance、d3bComplete=false。该索引只证明证据身份与原范围一致，不能扩张单份报告的行为范围。

Linux 首轮 `linux-validation/unsupported-1793245493203/report.json` 虽然编译、311/311 和 295/295、四组 unsupported 通过，但实际两个 ELF 及 RPC 身份与上一批相同。**该轮已 superseded，不能认作本次冻结源码通过。** 发现两个 build.rs 将 `CARGO_MANIFEST_DIR` 编译进脚本，共用 target 跨源码副本时可复用旧脚本并读取旧目录。仅 `cargo clean -p hertz-studio -p dbx-plugin-hertz --target x86_64-unknown-linux-gnu` 后重新构建，未清依赖或修改旧证据。结果位于 `linux-validation/rebuild-identity/`，两版 stdio 311/311、295/295、四组 unsupported 通过；实际 RPC 和逐文件独立复算见 `linux-validation/build-identity-verified.json`。

修正身份的 Linux ELF SHA-256 为 Standard `9a84e2a5eb722830187fe8d0fd5089efa3aa61deed0de750de3911be6e6a2476`、Full `2f9edf3fa981bd5392b9e6025447b26713ed1f68cfb2a4e05e91034b53e8c280`。Linux x64 debug、Rust 1.98.1、`-D warnings`、DEV/TEST_DEBUG=0 上下文的配套要求为 `51ec9d50c61ee759fe8cd9e09d36eab5c0d024cf583586ec2979ee91f87194a4`；不能将它误比 Windows release `433e…`。独立复算按 Rust PathBuf 的路径分量排序，并保留 CARGO_ENCODED_RUSTFLAGS 的 unit separator；构建日志的显示串不足以代替实际编码。最低/当前 Windows 证据身份未因此更改。

生产修正目前已落到主树三个文件：两个 build.rs 改执行时读取目录，共用 `desktop-build.rs` 增加目录环境跟踪；rustfmt 和差分空白检查通过。`runtime-build-root/` 隔离 A 仅覆盖三项，B 另加 native.rs 证据注释，正在共用原 Linux target 不清缓存执行 A→B→A，并逐次校验实际 RPC 身份。这项源码修正尚不属于当前 `433e…` Windows 产物；须单独冻结、重建和验证后续配套候选。原真实长稳未重启：12:18 左右核对 172 样本、89.13 分钟、findings=0、controllerIssues=[]、最大间隔 33.78 秒，三个原工具句柄仍 live。尚未覆盖完整八小时与后续干预。

## 2026-10-29：构建目录修正的实际共用缓存验证

`nonclient-repaint/runtime-build-root/verified.json` 已通过。实际同一 Linux Cargo target 顺序 A→B→A，期间不清理、不修改原 A；B 只比 A 多一条 native.rs 证据注释。第二、三次实际复用同一已编译 `hertz-studio-7b06ad671d64bf4c/build-script-build`，没有重编该脚本。每次从真实 Standard sidecar 的 capability 核对插件及桌面要求，与逐文件独立复算一致；返回 A 后 ELF 字节 hash 也恢复为第一次 A 的值。三次原 health/state/queue/settings 正常并正常 EOF，返回 A 的原 stdio **311/311**。

该 debug 上下文中 A 的 desktopBuildId 为 `bfc8abc5f4d5c1f165fcc8964bf83009f44db45f3df0de8f18a860dda4f7b9e2`，B 为 `8fadb9f3afa669ec025be48560fff8e19c4e42b8e7fcd1dbf3d19186acda4727`；A ELF SHA-256 为 `40b3c7e4bd8a37eaa46b4c10b03547f0435cd45106f4935101b4993827c03416`。这证明了本次共用缓存/复用脚本的修正，不将 B 当生产候选，也不扩张为全部 Cargo 版本/平台组合。

后续配套候选另冻在 `output/dbx-desktop-d3/build-root-fix/source/`。从上一批已验冻结副本派生，仅覆盖上述三个已验证修正文件；`snapshot-verified.json` 记录 72/547 项桌面/插件输入指纹 `596f2543167f5d415978545d8b780aa339ddd6c205a241cebda1145d1777710e` / `eb6a0a732ca7b10cc01986cc7de3455ea2b1bd54dc3f89e615af96716f004143`。共享工作区后来的在线/搜索修改没有混入，B 的证据注释也没有进入候选。

新候选的 Linux Standard 使用上述已验 A ELF，Full 从同一 A 输入实际编译，ELF SHA-256 为 `c71fe540f0fb3e62d1f92deee726ccb22d5ec2aea62b70c75a476cfde04bbc8c`。两版原 stdio **311/311、295/295**；`build-root-fix/linux-validation/unsupported-1793248499753/report.json` 四组实际新/已有授权文件场景全部准确 unsupported，原 RPC 正常，无桥/原生配置创建，已有文件 hash 保留，正常 EOF exit=0。`verify-build-root-candidate.js --linux` 逐文件复算并核对每个实际 capability，报告 `linux-validation/build-identity-verified.json`；debug 上下文要求仍为 A 的 `bfc8…`。

新 Windows release 组件完成构建和只读验包，约 10m11s，zip SHA-256 `425473d41bb8dac57c2bcb090ef0796d0777934093fd20345ccbb51fb329605c`，exe `4d2906f4195c0b55cdd6df31b616225de2f30099d97acae3096e3a69ea60874a`，desktopBuildId `07d87e7635ccc3ab86217fd6fb22163547d6e1cdc4110eee5aa1f2c6c2d661fd`。未运行图形实例；两版 `.dbxp`、Rust/MSRV 检查尚在进行。旧 `433e…` 长稳继续原进程和计时，约 109.08 分钟/210 样本复核无 findings、无 controller issues，不把它登记成新 `07d…` 组件运行结果。

## 2026-10-29 13:18：构建目录修正候选完成配套包与原合同核验

新候选仍为 `build-root-fix/` 的 72/547 项冻结输入，构建完成后逐项检查字节/hash 不变，`source-after.json` 留存。Standard / Full 构建约 36m51s / 38m31s，均 exit=0；未签名、未安装用户日常目录。验包核对 metadata、checksums、x64 PE、原权限/最低宿主、逐文件分版资源及 Standard 裁剪、不夹带桌面 exe，报告 `plugin-candidates/verified.json`。

| 产物 | SHA-256 |
| --- | --- |
| 桌面 zip / exe | `425473d41bb8dac57c2bcb090ef0796d0777934093fd20345ccbb51fb329605c` / `4d2906f4195c0b55cdd6df31b616225de2f30099d97acae3096e3a69ea60874a` |
| Standard 包 / 包内 exe | `4f561d71a5c5293bab298d4dbbcf5eaadc1063a216c9b09a71cd4c0af184622b` / `63dfbb7c90b2f09652907b8e74bfdff283fe52a02d5d01faaaf1fb3746fdc9cf` |
| Full 包 / 包内 exe | `4b5985ef0b43ec1e6eae8fd44a6d0b394076541d99343ed639ecc3d13bc80175` / `98d5cfefd83e7bc33c0e725f0f56226d2da35c284ae425161f4d0cddfc502e05` |

Windows 包内原 stdio 首先显式 null，311/311、295/295 通过，分别保留 `stdio-{standard,full}-null.log`；随后以 cpal 运行原频谱断言，**314/314、298/298** 通过，见 `stdio-{standard,full}.log`。三个新增断言是实际解码频谱，不把 null 的较少检查数登记成 cpal 通过。`native-tests.log` **51/51**、`msrv-native.log` Rust **1.88.0/-D warnings** 通过。没有新增实现前测试。

`runtime-final-1793250697674/verified.json` 的最低 **0.6.35** / 当前 **0.6.47** 真实 PluginHost × 两版 × 未授权/已授权共八组通过，逐组实际配套要求均为 `07d87e…`。`windows-rpc.json` 另记录新进程的原 health/state/queue/settings、无授权/桥/原生配置和正常 EOF。`windows-build-identity-verified.json` 将实际插件 buildId（Standard `e7801bec2806ee23dc4802ec8d6ace14f922ec5c14bd3f900051e6a518e6c8c9`、Full `44914800e2238fae902faf5ddf0de322c366ce123910a26640c8118a7d6da1bf`）及桌面要求与源码独立复算一致。

独立复算第一次错误地从 manifest 的 panic=abort 推断 build-script 的 `CARGO_CFG_PANIC`，得到 `91c055…`，未通过；失败记录 `windows-identity-context-initial-failure.json` 保留。这里 Cargo build-script cfg 为 unwind，manifest 本身已作为输入哈希；纠正检查器上下文后精确匹配实际 `07d87e…`。未改产品或重建产物迁就验证。`acceptance-progress.json` 汇总新产物、身份、Linux、Rust/MSRV 和真实运行时，仍 state=partial-acceptance、d3bComplete=false、graphicalNativeVerified=false。

为保留真实单实例长稳，未启动新的 `07d…` GUI；也未构建它的配套独立服务，因此不能把原 `433e…` 的 HTTP/native、104 项生产包和长稳报告改挂到新候选。原第四轮长稳约 **120.13 分钟**执行暂停/恢复并通过。北京时间约 **13:18**，原三个工具句柄均再次确认 live；复核 **285 样本、149.08 分钟**，findings=0、controllerIssues=[]，最大采样间隔约 **48.74 秒**。仍无 4/6 小时干预、末 30 分钟资源、完整八小时及退出结论。继续原进程和单调时钟，不累计前三轮或将正常进行中的检查写成整体验收通过。

## 2026-10-29 13:49：新候选隔离补验与原长稳采样缺口

下列检查全部使用 `build-root-fix/` 新包内 exe，`supplemental-reports.json` 核对候选索引、每版 exe、配套 build 和报告 hash；共 **104 项**，不是移用原 `433e…` 的报告。

| 报告目录（新候选根下） | 两版合计 | 实际范围 |
| --- | --- | --- |
| `data-pipes-1793252092223` | 54 | 坏帧、权限、并发槽位及真实回收，句柄差值均 0 |
| `data-pipes-1793252173828` | 6 | 大小写、扩展前缀与 junction 路径别名，句柄差值均 0 |
| `data-pipes-1793252215299` | 10 | 真实文件占用下撤销失败、重启恢复、持久禁用与残留 key 清理重试 |
| `data-pipes-1793252279365` | 10 | 真实 WAV、偏移只应用一次、pause/seek、快切、同曲改词/清词及 784844 字节文档慢读；含扫描/加载的句柄差值 Standard +9、Full +8，不宣称零增长 |
| `owner-recovery-1793252092231` | 8 | 强杀 owner、接管、旧冲突实例迟到退出与实际移动目录 |
| `component-rejection-1793252047915` | 10 | 实际组件缺失、损坏、待手动启动、manifest 读取失败与旧组件；旧组件明确选用 `433e…` 产物，未启动旧 native |
| `management-interleaving-1793252047943` | 6 | 真实保护管道与协议夹具，8 并发合并、revoke 取消、旧结果不复活及显式重连 |

另有上级目录 `management-eof-standard-1793252215284/report.json` / `management-eof-full-1793252215276/report.json` 两版六例，实际取消管理等待，约 5.2–20.7ms 正常 exit=0。上述检查使用隔离数据、当前用户/会话、null 音频；不代替图形宿主 kill/重启、声学、跨身份或完整房间权限。新配套独立服务从新冻结副本顺序构建并执行 HTTP-only，原 native 长稳保持，不把待完成构建写为通过。

第四轮原长稳约 **13:19–13:28** 连续 17 次资源采样子进程触发 20 秒超时；原始 `observation-errors.jsonl` 保留 SIGTERM/killed 与空 stderr。恢复后的实际相邻样本间隔为 **538181.7275ms（8.97 分钟）**，超出原 120 秒门槛，controller 的 `sample-gap` 与分析器 `sampling-gap-or-order` 一致。**此轮即使后续满八小时，也不能登记完整长稳通过。** 13:49 的 `nonclient-repaint/soak-observation-gap.json` 核对原三个 PID 仍 live，329 样本/180.48 分钟，原进程和计时未重启；不能用恢复后的正常采样填补缺口或累计前轮。

`soak/observer-diagnostic-1793251874537/report.json` 的恢复后独立 PowerShell 启动、进程、GPU engine/memory 查询均约 0.2–0.8 秒完成，不能据此确认此前超时根因。`sample-owned-process-tree.ps1` 仅增加 stderr 的入口、进程、GPU 与序列化阶段标记，stdout 结构、20 秒期限、120 秒间隔门槛均未变；原副本与 before/after SHA 留存。`observer-phases-1793252395029/report.json` 验证仅诊断变化、原控制器仍 live，实际约 1082ms、20 个归属进程、gpuError=null。现有 4/6 小时干预、末段资源和退出继续由原控制器观察；完整合格长稳及绝对 CPU/GPU 发布预算仍待完成。

## 2026-10-29 14:04：新候选配套独立 HTTP 与房间 EOF

`build-root-fix/build-standalone.ps1` 从同一新冻结副本顺序构建 Standard/Full 独立服务，stable 1.98.1、release、Windows x64、空 RUSTFLAGS、不清共享 target；分别 13m11s / 12m44s，脚本最终 exit=0。暂存前逐项核对 547 项冻结输入，配套 exe SHA-256 为 `4d2906f4195c0b55cdd6df31b616225de2f30099d97acae3096e3a69ea60874a`、要求 build `07d87e…`。

| 发行版 | 独立服务 SHA-256 | 新候选根下的 HTTP 报告 |
| --- | --- | --- |
| Standard | `b8225ed0deeddf1e03c442478a5d96cb7a919d03e2b9fddaf09ffaf8c3e8026f` | `standalone-http-1793252801719/report.json` |
| Full | `85fa0b5fdcbe1ff58801d2b7fd78dc376fc47e7862f229ab2a011f78b68d5a9f` | `standalone-http-1793253574888/report.json` |

两份实际报告均为 HTTP-only，通过原路由、实际发行版、精确组件/build 和服务正常 exit=0；`standalone-http-verified.json` 汇总，`built.json` 更新 httpVerified=true，仍 nativeHttpVerified=false，未启动新组件或替换日常安装。随后使用各自新包 exe 与新服务运行 `verify-authorized-room-eof.py`，新根的 `room-eof-{standard,full}.json` 均通过，hash 与上表和新包一致：真实双 scope 半帧阻塞、房间 discovery 在途时 stdin EOF，正常退出并取消等待，guest 清 membership，授权保留。范围仍为 null 音频和 loopback TLS，不等于完整房间权限或 native 播控。

扩展后的 `verify-build-root-progress.js` 已实际执行通过，索引纳入准确 104 项隔离报告、两版管理 EOF 六例、独立 HTTP 和房间 EOF，联同原产物/运行时/身份核对，状态仍为 partial-acceptance、d3bComplete=false、graphicalNativeVerified=false。`build-state.json` 同步记录。原 `433e…` 长稳 14:03 核对原三个 PID 仍 live，357 样本/194.99 分钟，仍只有已知 sample-gap 一项 controller issue；原进程和计时未重启，不能作为新 `07d…` 图形或完整长稳证据。

## 2026-10-29 14:36：实际激活失败/强杀恢复与检查器保护

`build-root-fix/activation-failures-1793255575972/report.json` 使用准确新包内两版 exe，真实故障下共 **6 个组合场景**通过，每个均含失败答复、故意强杀、原目录重启、解除故障后显式重连、真实两 scope 请求、撤销与正常 EOF。管理兼容和打开中心应答使用真实保护管道协议夹具，不是原生 GUI。

| 每版各一例 | 实际故障与恢复结论 |
| --- | --- |
| 授权原子替换失败 | 私有 disabled 授权文件持有 Read/FileShare.Read 句柄，真实 rename 失败，返回 `desktop_authorization_write_failed`；两 key 已生成但 consent 仍为空，gate/listener 均关闭。强杀后重启不因 key 残留授权，显式重连后才持久授权并提供两 scope。 |
| 发现发布失败 | `desktop-source.json` 真实同名目录阻止文件替换，返回 `desktop_discovery_failed`；已持久 consent 保留但 live gate 关闭。强杀后保留故障重启仍关闭，key 字节不变；解除故障并显式重连后发布新进程发现，真实快照成功。 |
| 来源锁失败 | `desktop-source.lock` 真实同名目录使 writer 获取失败，返回 `desktop_source_conflict`；不产生 consent/key。强杀重启仍无授权；移除故障后显式连接才能授权并发布。 |

每次失败前后 health、原状态、队列、设置逐字段一致，使用显式 volume=0.27 的空闲播放器；不宣称覆盖活跃音频、图形基线差分或声学。不存在 open-center 请求或 native 配置，恢复后的实际协议请求两 scope 均 200，同 session 且发现 PID 为新 sidecar；最终授权为空、key/发现删除、EOF exit=0。故意强杀仅发生在已收到失败答复之后，不冒充任意写入指令间的完整崩溃矩阵。索引已核对准确 exe/hash 与六个组合场景，仍 d3bComplete=false。

本轮也保留两次未完成的原生尝试：`output/playwright/desktop-lyrics-native-1793254306652/` 和 `desktop-lyrics-native-1793254417217/`，子 PID 32172/7144 的实际日志均为 `another hertz-desktop instance is running; exiting`，没有新候选图形通过。最初误以为改文件名/目录即可隔离，曾临时收窄检查器进程保护；源码核对确认固定 `Local\\HertzDesktop.Singleton` 后已恢复原保护，并移除临时 exe 副本。原长稳三个 PID 复核仍 live，未重启。

检查器原 finally 无条件向共用管理管道发送 quit，存在启动失败后影响另一个宿主的风险；现改为只通过本次已连接的 WebView 退出，不在失败清理中发送共用管道命令。`build-root-fix/native-guard-verified.json` 实测既有实例下检查器在启动前拒绝，未创建新 fixture 目录，原三个 PID 保持 live；保留两次冲突日志 hash。该保护验证不覆盖成功 WebView 清理分支，新候选仍需待原单实例结束后执行完整检查。

## 2026-10-29 15:55：采样工具对照与暂停频谱修正待验

独立 `resource-observer-native.cs` 通过 Toolhelp32、System.Diagnostics 与 PDH 读取原有完整指标，不使用 CIM。`native-observer-comparison-1793258410512/report.json` 的三轮“旧→新→旧”采样均核对 20 个进程的 PID、创建时间、父级、分组、路径及 43 个 GPU 引擎/3 个 GPU 内存实例；累计 CPU 落在前后参考值之间，私有提交/工作集/句柄/线程的瞬时差异逐项保留。新工具每次约 1.38–1.39 秒，GPU 使用明确的一秒计数窗口，不能要求其百分比等于 WMI 的未知窗口。缺失根进程明确 exit=1，无业务样本。

`native-observer-soak-1793258693970/report.json` 进一步记录 **301434.64ms、61 次采样、零失败**，原根/sidecar 实例未变，GPU 指标保留。原 helper hash 仍为 `d49b91…`；原控制器 hash `d89959…` 未变。`future-soak-observer-configuration.json` 绑定另存的新控制器和新工具身份，保留八小时、30 秒间隔、20 秒子进程期限、120 秒缺口及 2/4/6 小时干预；尚未启动它，不填补当前长稳缺口，也不证明八小时稳定。新工具源码/二进制 hash 为 `867ba51e…` / `302959a5…`。

新独立服务的真实 WS 验收暴露另一问题。`build-root-fix/standalone-ws-1793259785871/report.json` 使用准确 Standard `b8225e…` 服务、cpal 和音量零；实际 token/一次票据与重放拒绝、状态/64 段频谱、pause/seek/play、壁纸不计观众及最后主观众离场暂停均已走到，但最后的暂停频谱过期断言失败。诊断尾部三帧 `playing=false`、游标相同，频谱 peak=1、age=15ms，证实旧 FFT 被当作新桌面帧刷新。该报告整体 **未通过**；Full 尚未执行，不能登记两版 WS 通过。更早的夹具漏填 scan.root、null 后端按设计不产频谱及启动/端口调用失败也保留在各自目录，不改产品迁就检查。

修正在 `state.rs` 的 AudioEvent::Spectrum 分支，仅播放中才更新桌面频谱，原 WsEvent::Spectrum 广播语句保留。`paused-spectrum/source/` 从上一冻结副本只覆盖该文件；547 项插件输入为 `ab2eee4b691dc876a122e4e4fce0d79b35a2b2cf53b08de7121b3ff9e77a5060`，72 项桌面输入仍为 `596f2543…`。原 `07d…` 组件 zip/exe 已在新目录重新核对 SHA、PE、describe 和无配置副作用，未重编相同桌面输入。两版服务/插件分别由会话 63532/92884 构建中；一次 Windows PowerShell 5 的 stderr 处理使构建调用失败，原日志另存，确认无残留 cargo 后用 PowerShell 7 启动上述实际会话。当前仅冻结与格式检查通过，修复后实际 WS 和原合同仍待验；索引 `paused-spectrum/acceptance-progress.json` 保持 building、d3bComplete=false。

15:52 原长稳三个 PID 实际仍 live，557 样本/303.71 分钟，25 次失败和两个缺口不变；6 小时干预、末段与退出仍由原控制器继续观察。该原运行不含暂停频谱修正。

## 2026-10-29 15:08：第二次采样缺口与证据边界

`nonclient-repaint/soak-observation-gap.json` 更新为本次核对：原三个 PID 均 live，474 样本/260.25 分钟。约 14:50–14:54 再有 8 次观察子进程超时，形成 **210590.92ms（3.51 分钟）** 实际采样间隔；加上早前 17 次失败和 **538181.73ms（8.97 分钟）** 缺口，共 25 次观察失败、两项 sample-gap。采样恢复不填补任一缺口，该轮即使满八小时也不能通过完整长稳。

失败观察的最后阶段标记为：17 次无标记、3 次 process-query-started、3 次 gpu-engine-query-started、1 次 gpu-memory-query-started、1 次 completed。最后一种虽已输出 JSON，子进程仍超时，照样计为失败，不回收为通过样本。标记只能定位等待范围，不能证明产品退出、系统睡眠或某个 WMI 调用是全部根因。未改变当前采样方法、20 秒期限、120 秒间隔门槛、原进程或计时；helper SHA-256 仍为 `d49b91e23b4ad0877ce4156a17aad51ad545b873bc3b34fc60b5b52e5a7534cd`。

14:51 的 `soak-interventions-2h4h.json` 保留为当时的历史记录，当时只有一个缺口；不能把后来状态伪写进该快照。六小时干预、末段及退出继续由原控制器观察；新 `07d…` 图形验证与新的完整合格长稳仍未完成。

## 2026-10-29 14:51：新配套无窗口 feed 与原四小时干预

`build-root-fix/standalone-feed-1793256517118/report.json` 使用准确新 Standard/Full 独立服务与 `4d2906…` 新组件，通过已有 `--wallpaper-feed-test` 入口读取各自真实只读 HTTP 快照。每版 5 个快照 seq=1–5、session 精确等于本服务发现、playing=false；轮询约 2.53/2.81 秒，前后原空闲播放状态一致，服务正常 exit=0。此入口在单实例和 WebView 初始化之前返回，不创建 GUI、管理 server 或桌面发现，不占用原运行中的组件。只证明新组件实际 feed 读取，不代替 WS 事件流、原生图形、壁纸运动或管理联调。

首次 `standalone-feed-1793256462044/report.json` 因检查器配置夹具漏填歌词 width 字段失败，组件明确保留坏配置并 exit=1；该轮未通过，记录保留。补齐夹具的 width/anchor/monitor 后重新执行上述成功轮次，未修改产品或产物迁就验证。

原控制器在单调时间 **14434769.88ms（240.58 分钟）** 执行四小时撤销/重连并通过：实际 disconnect/connect 均 ok，两个 surface 约 **191.38ms** 清空，显式重连约 **806.43ms** 恢复。`nonclient-repaint/soak-interventions-2h4h.json` 独立核对原组件 `433e…`、实际三份二进制字节不变、原三个 PID live，以及两次已完成干预。14:51 记录 445 样本/约 242.20 分钟；仍只有原 538181.73ms sample-gap。该结果是原候选的部分证据，不归新 `07d…`，也不修复完整长稳的不合格间隔。六小时 seek、末段资源、退出/回收仍继续原进程观察。新候选索引另行纳入两版 feed 报告，graphicalNativeVerified=false、d3bComplete=false 保持。

## 2026-10-29 16:34：暂停频谱候选的新原合同结果

新两版服务已构建，准确 SHA-256 为 Standard `47efaf36c98fd6e1373dd3a1f4d787dc9b4a5cb51198954df8e1c38a27cd6d79`、Full `600af2d2a4709b6d94aab10edc26b2813f77b6b1ced5fcd7ea364002a61a326a`。两版原 HTTP-only 与真实 cpal/WS 均通过：播放中实际频谱非零，主观众离场仍按原规则暂停，壁纸继续接收且旧频谱超过一秒后归零，重连保持暂停，显式 play 才恢复，流打开时正常退出。Standard 原房间合同 21 项及 60 秒静音 WASAPI PCM、三采样率/自然切曲、零 underrun/resync 通过。Full 房间第一次在原播放拒绝检查处出现 WinError 10053，第二次进入 PCM 后出现 1094 帧 underrun、一次 resync，均保留失败；当时并行构建仍在运行，原因未确认，不降低门槛或登记房间通过。插件 Standard 已打包、Full 仍在构建，验包/新原 stdio/真实宿主与最终图形尚待完成。之前的服务/插件证据不自动覆盖此增量。

本轮准确报告均在 `output/dbx-desktop-d3/paused-spectrum/`：

| 证据 | 实际范围 |
| --- | --- |
| `standalone-ws-1793261898771/report.json` | 两版原 WS token/一次票据与重放拒绝、原事件/播放暂停 seek、离场暂停、壁纸不计主观众、频谱自然过期、重连/显式恢复、正常 exit=0；播放峰值约 0.91/0.96，过期 age 1332/1299ms。 |
| `standalone-http-verified.json` | 核对两版准确 exe/hash、HTTP-only 报告、配套 `07d…`、原状态/能力路由与正常退出；保留原 native 进程，不代替 native launch/control。 |
| `room-contract-standard.json` | Standard 同版 host/guest 的 21 项原房间合同及真实静音 PCM；不是跨机器声学或 Full 验收。 |
| `room-contract-full.json`、`room-contract-full-attempt2.json` | 整体失败。首次在检查原播放拒绝时连接中断；第二次在约 0.707 秒 PCM 样本出现 1094 帧 underrun/1 次 resync。两次失败保留，不能归因为已确认的编译负载或改阈值跳过。第二次只增加本地服务日志保存，原请求/时限/断言/清理不变。 |
| `source-after.json`、`acceptance-progress.json` | 构建中的实际 72/547 文件复算不变，索引逐项核对源、exe、HTTP/WS/房间报告的身份/hash，分别保留成功和失败；graphicalNativeVerified=false、d3bComplete=false。 |

原 `433e…` 长稳原三个 PID 16:27 仍 live，619 样本/338.45 分钟，观察失败增至 26 次；已知两个采样缺口和原方法/时钟保持，六小时干预与最终退出继续原控制器。新候选仍未启动 GUI，不能套用原候选图形/长稳通过结论。

## 2026-10-29 17:30：新包回归、Linux 身份与授权阻塞 EOF 失败

17:30 更新：`paused-spectrum/` 的两版服务和 `.dbxp` 已构建/验包，构建后 72/547 项实际源输入仍为 `596f2543…` / `ab2eee4b…`；桌面输入与 `07d…` 组件字节未变。新包 Windows cpal 原 stdio 314/314、298/298，最低/当前真实 PluginHost 八组、独立实际 RPC 身份复算、104 项包内隔离检查、管理 EOF 六例及实际激活失败/强杀恢复六例均通过。新两版服务原 HTTP/WS、暂停后频谱自然过期和两版 21 项房间合同通过；Full PCM 第三次在构建结束后通过 60 秒、三采样率/自然切曲、零 underrun/resync，前两次连接中断/欠载失败保留，未确认其原因。新 Linux x64 两版原 stdio 311/311、295/295、四组 unsupported 和实际身份复算通过；不是 macOS/ARM64 或 Windows 图形资格。

| 产物 | SHA-256 |
| --- | --- |
| standard 包 | `f92bd3efa709b01790873c8f45189400da2cc48abf7f4569d80ec5f72e43c9cd` |
| standard 包内 exe | `ba38493ff08a3d94f55b69c7913ca1f5471f2e177e4335fee59f6a179fef2f61` |
| full 包 | `70505ce0ce56d6d87b5774e616c7e49fb2c619398262e7973eb7d518fa23deb0` |
| full 包内 exe | `a884402501b66b7c3a5954f472a6052c2d6f5b62a997c89d1a737701533c77c8` |
| Linux x64 standard debug exe | `f8731bf59ad5ad1424b1c4b0292c2432bc13230e3258f1f3e19ecbe5fabbfc28` |
| Linux x64 full debug exe | `4c40dd716919c31048b3b3c53bbbed9e1e057127079770b2ede2e2dca5081b54` |

授权阻塞下的房间 EOF 仍不合格：Full 首轮异常退出、一次复跑成功；再用三个交错对照轮次，暂停频谱修正前的 `build-root-fix` Full 失败 1/3、新 Full 失败 2/3，均保留实际退出码 `3221226505` 和 SDK worker 的 Tokio timer shutdown panic。另以提交 `1d042b8` 的准确 Full 包和新 Full 运行未改的原无授权/无阻塞 EOF 检查，各三次正常，不能据此认定提交基线也有该 panic，或完整已授权故障矩阵无变化。最初提交基线对照因夹具路径错误未启动，已单列作废，不能充作产品失败。新候选图形、原生管理播控/三来源切换、此退出缺陷和完整长稳仍待完成；没有修改 SDK、原音频或退出实现迁就检查。

准确报告均在 `output/dbx-desktop-d3/paused-spectrum/`：

| 记录 | 覆盖与限制 |
| --- | --- |
| `plugin-candidates/verified.json`、`source-after.json` | 两版 archive/PE/清单/资源逐文件核对；547 项冻结输入不变，组件仍独立可选，实际共享工作区其他 UI 变化不归本包。 |
| `windows-build-identity-verified.json`、`runtime-final-1793264069270/verified.json` | 原 cpal 合同、实际 RPC/独立复算、最低 0.6.35/当前 0.6.47 真实运行时八组；不是新的图形宿主差分。 |
| `plugin-verification.json` | 逐项绑定本批 package/hash、104 项、管理 EOF 六例和激活失败/强杀恢复六例。房间 EOF 首次 Full 失败也保留在索引，不能把索引核对成功当全部产品通过。 |
| `room-contract-full-attempt3.json` | 准确新 Full 同版 host/guest 的 21 项与 60 秒静音 PCM通过，220 样本、零 underrun/resync；`room-contract-full.json` 和 `room-contract-full-attempt2.json` 的失败继续保留。 |
| `room-eof-comparisons-verified.json` | 对照报告、实际二进制 SHA、退出记录与日志 hash 均核对；阻塞桥的前后候选 1/3、2/3 panic，原无桥合同提交基线/新包共六次正常。错误路径夹具无基线报告、未启动，单列无效；不是证明原提交没有潜在竞态。 |
| `linux-validation/build-identity-verified.json` | 新目录 `/var/tmp/hertz-d3-paused-spectrum/source` 的实际 72/547 项源指纹与冻结逐项一致；两版真正编译，原 stdio/unsupported/实际 RPC 与独立复算一致。仍为 WSL2 Linux x64 debug、null backend，不代替其他 OS/ARM64。 |
| `standalone-feed-1793263629942/report.json` | 两版准确服务+相同 `07d…` 组件的无窗口 feed CLI 通过，各五次实际 HTTP 读取；不启动 singleton/GUI，不是 WS/原生管理资格。 |

原 `433e…` 第四轮长稳的 2/4/6 小时干预已全部通过；六小时 seek 在北京时间 16:48:51 将原播放跳到 5000ms，约一秒后实际进度 6020ms，继续播放且原二进制不变。17:30 原三个 PID live，738 样本/401.48 分钟、累计 26 次观察失败；两个原采样缺口继续使该轮不能合格。末段资源、正常退出和专属进程回收继续原控制器，预计原结束点仍为 18:48:30；新候选没有运行 GUI/长稳，不能借用该轮身份或累计时间。 `nonclient-repaint/soak-interventions-2h4h6h.json` 保留原三次干预与身份，14:51 的两次干预报告保持历史内容。新索引 `acceptance-progress.json` 已纳入新包/Windows/Linux/HTTP/WS/房间与失败对照，保持 partial-acceptance、graphicalNativeVerified=false、d3bComplete=false。


18:36 接续：房间 `Discover` 已复用既有 `RoomManager::starting` 退出取消入口。原发现主体、其他房间分支、SDK、进程退出屏障及音频实现均未改；只在退出信号到达后停止轮询挂起的发现计时器。新冻结 `output/dbx-desktop-d3/shutdown-discovery/` 的插件 547 项指纹为 `171524606d174dbe68eaf07ee8b30478d98bb6a36f1197069c9b604275329daf`，桌面 72 项输入与 `07d87e…` 组件字节保持不变。`shutdown-timer-verified.json` 独立核对发现主体去空白完全相同、分支外源码完全相同。真实旧→新探针保留同样的挂起请求、第二请求 busy、服务 shutdown、销毁 runtime 后再轮询：旧实现确定性 panic，新实现返回 `room_shutting_down`。探针为 Linux debug/unwind，Windows release 实测另列。

补查保留 stderr 后，修正此前“原无授权 EOF 六次正常”的解释：准确提交 `1d042b8` 的 Full 在 **1/3** 次、暂停频谱候选在 **2/3** 次写出同一 Tokio shutdown panic，尽管六次退出码均为 0。新交错对照中旧暂停频谱 Full 也有 **3/5** 次后台 panic、五次退出码均为 0。旧报告和日志保持原样，不能只凭 exit=0 判定无 panic。该补证确认未授权的原提交也存在此退出竞态。新 Full 共 11 次 Windows 退出实测（五次交错及配套授权/未授权各三次）、新 Standard 配套授权/未授权各三次均无该 panic，授权、Host End 与 guest membership 原断言保持；索引保留原失败与日志 hash。

新两版 `.dbxp` 和配套独立服务已实际构建/验包，72/547 项 Windows、Linux 源输入前后复算一致。Windows cpal 原 stdio **314/314、298/298**、最低 0.6.35/当前 0.6.47 真实 PluginHost 八组、104 项包内隔离检查、管理 EOF 六项、激活失败/强杀恢复六项及实际 RPC 独立身份复算通过；Linux x64 原 stdio **311/311、295/295**、四组 unsupported 与实际身份通过。房间模块原有 12 项测试、两版原 HTTP/WS、暂停频谱自然过期、各 21 项房间权限及 60 秒静音 WASAPI PCM/三采样率/自然切曲/零 underrun-resync 通过。文件和 SHA 见 `shutdown-discovery/acceptance-progress.json`，状态仍为 partial-acceptance、`graphicalNativeVerified=false`、`d3bComplete=false`。

最终组件 GUI、成功 WebView 清理、独立版原生管理/播控恢复和三来源切换待验。原 `433e…` 第四轮仍保留同一进程、时钟和不合格采样缺口，不能代替本候选的完整八小时，原结束点仍为 18:48:30。CPU/GPU 绝对发布预算、物理身份/平台/桌面恢复等 D-A01–18 缺项继续保留。

最低编译器检查的输出相对路径曾多退一级，覆盖任务顶层旧 Full MSRV 日志。旧 Full 历史日志已标记不可用，不能用新结果补冒旧证据；旧 Standard 日志在覆盖前已按原 SHA 保存并完整恢复。新冻结两版实际 1.88.0/-D warnings 检查均通过，归档为新候选 `msrv-full.log` / `msrv-standard.log`；`validation-log-path-correction.json` 记录错误、原 Standard SHA 与新结果 SHA。源码及产物未变，历史资格仍按当次保留证据的实际范围使用。


18:58 接续：原第四轮于 18:48:50 按原控制器结束，实际 28820568.7423ms、890 个样本、2/4/6 小时干预全部通过；26 次观察失败和两个原采样缺口保持，`measuredEightHours=true` 但 `passed=false`，不能作为完整长稳资格。DBX 与 native 均正常 exit=0，native forced=false；DBX 窗口状态恢复、globalFilesChanged=[]，末样本的 20 个原归属进程实例经只读 Win32 查询已不存在。原内存窗口比较在原阈值内，但不据此宣称无增长或发布预算通过。报告为 `nonclient-repaint/fourth-soak-completion.json`，仍归原 `433e…` 身份。

随后最终 `07d87e…` / exe SHA `4d2906f4195c0b55cdd6df31b616225de2f30099d97acae3096e3a69ea60874a` 组件通过真实 WebView2 复验：两种样式各六轮设置开关、29 次 Win32 样式/几何/激活重绘检查；深浅主题截图经查看，单行、无边框及滚动条正确。检查器成功路径通过自己创建的 WebView 请求退出，并实际等待正常退出；`cleanup.json` 确认 forced=false、exit=0，不借用共用控制管道。证据 `output/playwright/desktop-lyrics-native-1793270931402/`，索引 `shutdown-discovery/native-regression.json`。新两版配套服务也通过真实原生启动、重复启动保持单实例、原 status/font/wallpaper-status 管理、非法命令拒绝和正常退出，原检查脚本断言未改。

这些补齐最终组件 fixture/成功清理及原独立版管理子项，不代替最终两版 DBX 图形联调、三来源切换后的原生播控恢复，或新候选完整八小时。`shutdown-discovery/acceptance-progress.json` 已绑定准确 hash、截图与报告，`graphicalNativeVerified=false`、`d3bComplete=false` 保持。

## 21:28：最终包图形子项与新八小时运行

以下只属于 `shutdown-discovery/` 最终两版包及 `07d87e…` 组件，不将历史候选的通过结果迁移到本批。独立索引 `output/dbx-desktop-d3/shutdown-discovery/final-graphical-progress.json` 核对实际安装的 Standard/Full 包内 exe、配套组件 SHA、原始报告与截图；总索引仍为 partial-acceptance、`graphicalNativeVerified=false`、`d3bComplete=false`。

本轮真实 DBX 0.6.47 会话目录为 `output/playwright/dbx-desktop-gui-baseline-1793273225596/`：

| 证据 | 实际覆盖及边界 |
| --- | --- |
| `difference-before-standard-1793273473909.json`、`difference-before-full-1793273784447.json` | 准确提交 `1d042b8` 的两版包在本次数据中通过播放、seek、队列、真实约一分钟定时、主题/预设、关闭重开时原 sidecar PID/创建时间保持及八类 MediaSession 注册；零桌面请求。它们是提交基线，不是最终包通过。 |
| `difference-after-standard-1793274003311.json` | 最终 Standard 已实际播放，随后 Playwright `slider.boundingBox()` 超时。原报告保留，原因尚未确认，最终 Full 的 after 流程尚未完成；不得据其他候选或 before 结果声明最终包图形差分通过。 |
| `native-standard-final-1793275849518.json`、`native-full-final-1793276057750.json` | 实际最终两版的同来源歌词/壁纸、对应文档、只读工具条禁用通过，两份本地文档各 18 行。授权与显式打开中心、候选身份选择分别执行；旧驱动把授权等同于选源及猜测标签的失败记录保留。 |
| `three-source-final-1793278800299.json` | 三个实际运行服务完成独立 Full → DBX Standard → DBX Full → 独立 Full 四次显式选择；切回原独立服务 session 后，原生暂停、恢复及歌词 seek 到约 30150ms 通过，DBX 播控禁用。设计指定独立 Standard 的组合仍待验；本次使用 Full 不等于它已通过。 |
| `real-online-lyrics-1793279018296.json` | 最终 Full 实际网易云搜索、播放、取词，原生收到 43 行；单一曲目不代表所有在线来源。 |
| `native-session/offline-standalone/supervised-exit.json`、会话根 `report.json` | 本次独立服务、首个 DBX 均正常 exit=0；首个 DBX 的窗口状态恢复且 globalFilesChanged=[]。本轮此前的 native 监督脚本因预设一小时期限强制终止，`native-session/report.json` 的 forced=true/SIGTERM 保留；不是产品崩溃，也不是正常清理通过。随后同组件/配置另启原生实例。 |

新完整八小时于 **2026-10-29 21:03:58.417（北京时间）** 开始，预计 **10 月 30 日 05:03:58.417** 结束；目录为上述会话的 `soak/`。controller/DBX/native PID 为 **8988/16964/1916**，工具会话分别 **92936/22229/21224**，两个根进程及 sidecar 创建时间固定记录在 manifest。新原生资源观察器 SHA-256 为 `302959a5d432bf2287181098fc6a9a81e6e5a928bc0573a854912c5ad7d3b47b`；本轮单独从零计时，未替换历史运行中的 helper 或累计其时长。21:28 通过原控制器句柄及实际进程确认仍存活，已观察 45 个样本、issues=[]；该时间点尚不能形成长期结论。2/4/6 小时干预、完整资源窗口/增长趋势、正常监督退出与全部专属进程回收仍待原运行完成后核对。

用户明确目前只有这台 Windows 设备。其他用户/交互会话、macOS、ARM64 的真实覆盖保留为缺项；物理媒体键、声学、锁屏/断屏/Explorer 恢复尚无最终候选实测证据。绝对 CPU/GPU 发布预算尚未预先冻结，不能根据本轮观测反向制定通过门槛，也不能把功能子项通过称为完整 D3b。

22:09 补验：最终 release 组件经现有 `--wallpaper-feed-test` 入口实际经过配置加载，显式指向临时离线目录，完成 **15 项**配置用例。v1 有绑定/无绑定、v2 各迁移为 v3 且 revision 只加一次，再次加载字节不变；旧 double/glass/bilingual/fontSize=44/opacity=.8 与禁用状态保留。schema3 已有/全新文件正常；坏 JSON、未来 schema、非法 UTF-8、超过 64 KiB、重复/第九来源、缺 kind、revision 溢出均拒绝且原字节不变。实际临时路径被目录占用、目标文件被共享锁阻止替换时，退出 1 并报告对应保存失败；解除故障后两种重试均成功，迁移 revision=18。报告 `shutdown-discovery/config-load-1793282435749/report.json` 与 `final-config-evidence.json` 保留原 stderr、原/新 SHA 及重试事实。

同时重新逐文件核对最终冻结桌面与 `build-root-fix/` 已测输入，**72 项**的大小/hash 全同，指纹 `596f2543…`。原 `native-tests.log` 的 SHA 与当时验收索引一致，51 项通过中含 17 项配置、8 项 DBX feed；它们以未变源码的 debug/fixture 证据归档，未冒充最终 release 新跑 GUI。该入口在单实例/窗口/管理/自启应用之前返回，原八小时 controller/DBX/native 的实际 PID/创建时间继续不变；57.31 分钟、110 个完整样本的独立只读审计 findings=[]、最大间隔约 33.80 秒，20 个专属实例仍在。仍需最终 GUI 草稿提交失败/重试、zip 备份恢复、其余图形/系统用例及八小时末段审计；总状态未改为完成。


## 2026-10-30：优先验证八小时之外的项目

本轮只使用冻结的 `shutdown-discovery/` 最终两版包和 `07d87e…` 桌面组件（exe SHA `4d2906f4…`），未从并发修改中的工作树重建。当前官方宿主为 DBX **0.6.47**（SHA `1651bff5…`）；真实最低宿主运行时已有证据，但本轮图形结果不扩展到最低宿主。独立索引 `output/dbx-desktop-d3/shutdown-discovery/final-nonsoak-verification.json` 逐份复算 **15 份通过报告**的 SHA、受测身份与关键断言，保留 **17 份失败尝试**；`completeNonSoakAcceptance=false`、`d3bComplete=false`。本轮新增的是验证与记录，产品代码/冻结产物没有为通过检查而改写。

| 本轮证据 | 实测结果 |
| --- | --- |
| `final-baseline-results.json`、`final-host-lifecycle-1793286047816.json` | 最终 Standard/Full 与原提交在当前宿主同业务数据完成核心无授权图形差分；播放/seek/队列、约一分钟定时、主题/预设、关闭重开、MediaSession 注册一致，零新增桌面请求、无桥文件、gate/listener 关闭。最小化/恢复、实际 stop/activate 保留队列/持久偏好，重启不自动播放。 |
| `final-gui-config-failure-1793284174059/report.json`、`desktop-package-upgrade-1793286321712/report.json` | 最终 Full 活动 GUI 文件共享锁失败时保留草稿、原字节、revision 与旧生效值；释放后原草稿重试成功，再经 UI 恢复原字号。最终 zip 实际升级、运行中 EBUSY 保护、schema2→3 一次迁移及旧包+配置备份恢复通过。 |
| `three-source-standard-final-1793288106530.json` | 设计指定的独立 Standard → DBX Standard → DBX Full → 独立 Standard 四次切换；每次歌词/壁纸同 session，DBX 工具条禁用，切回原独立服务后原生暂停/恢复/歌词定位正常。 |
| `final-authorized-lifecycle-1793288563286.json` | 两版各在播放中/暂停中伪造 pause/seek/play，共 12 次实际原生 IPC 全被拒绝；配置/播放真值/代际保持。两版各正常 stop/强杀 sidecar，共四次约 1.4–1.6 秒清空旧音乐数据，组件存活/环境动画继续，显式激活后新 session 重取同 key 同内容文档。实际暂停后频谱归零，环境动画继续。 |
| `final-authorized-host-exit-1793289612392.json` | 两版各真实 DBX 正常/强制退出后重启，共四次约 1.1–1.5 秒清空旧数据；旧 sidecar 实际消失，组件保持独立存活，新宿主启动后的新 session 重新取得同 key 文档。每次监督退出的全局文件差异为空，最后正常退出。 |
| `final-native-recovery-1793291196125.json` | 实际 Win32 锁定透明/no-activate 标志、设置中的位置编辑临时解锁/取消恢复、解锁后的无边框均通过。通过 CDP 使任务自己的壁纸 renderer 崩溃；约 10550ms 后实际 native watchdog 重建页面、重新挂载并恢复原 DBX session，两 surface/绑定/配置不变。重新附加观察器后，绘制和环境动画继续；恢复截图已查看。 |
| `final-wrong-running-1793291445325/report.json` | 同一管理端点实际运行历史 `433e…` 组件时，两版原生检测得到 `incompatible-host`，真实设置页明确提示不兼容且连接/打开按钮禁用；播放/队列/原共用配置保持。旧组件正常退出。固定安装目录仍为空，其 `component.state=missing` 与运行中不兼容属于两个事实。 |
| `final-ui-repeated-1793292522628.json` | 真实 UI 每轮在同一事件循环内连续触发八次检测/打开/撤销/重新检测/授权点击，每种操作仅产生一次原 IPC 请求。撤销后管理状态为 unconfirmed，按界面流程重新检测再授权；撤销 Standard 不影响所选 Full 壁纸，重新授权不切源，播放/队列不变。此记录不代表跨进程并发或丢应答已测。 |
| `final-uninstall-1793293699287.json` | 实际 Standard 卸载后包目录和进程消失，数据仍在；该操作发生在计时记录前，不声明其延迟。Full 采用实际 GUI 卸载，约 1446ms 后双 surface 清空，native 存活、环境动画继续；共用配置与组件 SHA 不变。通过实际 DBX 安装后端重装两份准确原包后，业务数据/Full 队列保留，新 session 桌面显示恢复。 |
| `final-capsule-1793286895271.json`、`final-authorized-ui-lifecycle-1793294938453.json` | 两版均完成无组件及已授权读取两组胶囊流程；后一组还覆盖展开、关闭工作台、真实宿主最小化/恢复，原 sidecar 身份/播放/同源歌词壁纸保持。重装后的宿主前端通过实际重新加载读取已安装列表，浮动页按实际 ready 状态等待。 |
| `final-nonsoak-cleanup-1793295038105.json` | 最后通过各自真实退出入口正常退出 DBX、native 与独立 Standard 服务，三者 exit=0，native forced=false；宿主全局文件无差异。记录的 **22 个**实际归属的根及后代进程实例已按原 PID/创建时间确认不存在，保存的最后一轮监督日志未发现后台 panic。 |

失败和证据边界继续保留：

- 无授权图形差分早期 Standard boundingBox 超时未改原检查器，后续原检查器通过；早期结果不能擦除或改判。
- 无授权基线之后，驱动恢复任务授权文件时使用普通复制，未保留私有 ACL，导致双方正确拒绝授权。已用原备份恢复受保护访问规则并核对原字节；`authorization-acl-restored.json` 记录此驱动错误。无钥匙或 token 输出到报告。
- 宿主矩阵驱动曾在 CDP 就绪但真实主页面尚未创建时调用失败；连接回退最多约 30 秒，初始 15 秒等待也曾失败。强退时已结束进程的系统记录/句柄尚未完全消失，重启保护误拦；后续在保持“不得并行启动另一 DBX”的前提下等待旧实例完整消失。最终通过矩阵未缩减退出/失效/重取断言。
- 一次心跳注入尝试修改只读 `window.ipc.postMessage`，实际没有拦截任何心跳，不构成有效故障覆盖。随后 CDP frozen 页未在 25 秒观察窗内取得重建，解除冻结后日志出现恢复；**原因尚未确认**，该记录保留为待查，不用后续 crash 通过替代冻结/系统恢复验收。最终 crash 注入实际触发 watchdog 并重建；新的观察器会在每次真实页面替换后重新附加。
- 重复点击驱动曾误用 FrameLocator.evaluate、在已有模态设置外点击、重复安装匿名观测器导致同一消息记三次，以及撤销后未重新检测即等待授权。这些原报告均保留；后续使用单份转发观察器，按真实 UI 流程复验。胶囊初次驱动也曾未等待浮动页面 ready，最终以实际可见展开控件为条件复验。

原最终候选八小时尝试已按用户“主要验证八小时之外”的优先级正常结束：168 样本约 **87.75 分钟**，完整八小时未通过。原 **25 条** feed 观察异常保持；其中 wallpaper renderer 在约 75 分钟时重建、原观察器未重附加，支持观察缺口的解释，但不能据此恢复缺失的原同会话观察或将原报告改成通过。原第四轮 `433e…` 的八小时失败也不合并计时。

八小时之外仍未完成的范围：实际 DBX 数据目录移动与原生重绑、系统登录自启先于 DBX、旧管理协议/丢应答/跨进程并发及完整 I/O 失败交错、真实 GUI 缓冲与慢文档/歌词修订/独立 scope 故障组合、切源后的房间权限组合、最低宿主图形差分、物理媒体键/声学/鼠标命中穿透与托盘找回、锁屏/断屏/Explorer/WorkerW 恢复、预先冻结的绝对资源发布预算及正式分发资格。其他真实用户/会话、macOS、ARM64 仍无设备证据。当前自定义目录的成功使用不能代替实际移动后的验证。

退出身份补核：原 `final-nonsoak-cleanup-1793295038105.json` 按 ParentProcessId 采集的原始树有 23 项，其中 PID 25700 的创建时间早于其所指父 PID 10440 的当前实例，属于父 PID 复用造成的误归属。`final-nonsoak-cleanup-identity-audit.json` 保留原树及该排除理由，按父子创建时间重算实际归属 **22 项**，再以原 PID+创建时间逐一确认均不存在；无论是否被重新挂接，退出判断均不依赖当前父链。原进程及报告未被删除或改写，未对该无关旧进程采取任何操作；此补核替代原始 23 项归属结论。


## 2026-10-30 02:16：八小时之外的补验结果

沿用 `shutdown-discovery/` 冻结的 Standard/Full 包及 `07d87e…` 桌面组件，exe SHA 为 `4d2906f4195c0b55cdd6df31b616225de2f30099d97acae3096e3a69ea60874a`。本轮没有重建并发修改中的产品源码。新增索引 `output/dbx-desktop-d3/shutdown-discovery/final-nonsoak-supplement.json` 独立核对六份通过报告的 hash、受测身份和关键断言，继续保持 `completeNonSoakAcceptance=false`、`d3bComplete=false`。

| 新增实测 | 结果和证据边界 |
| --- | --- |
| 整个 DBX 数据目录实际移动与重绑 | 原 DBX_DATA_DIR 在同卷实际改名，原路径始终不存在；当前真实 DBX 0.6.47 的两版按原授权启动。授权/打开中心不自动改绑；在原生中心显式选择移动后的精确路径，新 profile 默认单行/无边框、歌词/壁纸均关闭，主动启用后同来源文档和壁纸恢复，原队列及授权文件字节保持。`directory-move-1793295799856/rebind-1793296607750.json`。 |
| 桌面组件先于 DBX 启动 | 无宿主/sidecar 时手动先启动组件，保持等待来源及环境动画；随后启动宿主和显式重绑流程通过。`native-before-dbx.json`。只证明启动顺序，不代替真实 Windows 登录/自启入口。 |
| 壁纸动画循环真正停转后的 watchdog | 独立管理通道取得 17 个心跳缺失样本，tick 固定为 19781、最大心跳年龄 9934ms；约 9595ms 后原页实际关闭并重建，新页重新挂载、来源连接和绘制恢复，绑定/配置不变。`native-loop-stall-1793296855155.json`。是实际 requestAnimationFrame 停转，不能替代整个进程挂起或物理系统恢复。 |
| 独立 scope 失效/恢复与实际歌词修订 | 两版各将歌词/壁纸的一份私有钥匙暂时改名，四次分别约 190/293/495/187ms 清空对应数据，另一侧持续取得新快照；壁纸失效时频谱归零、环境动画继续。恢复原文件后双侧重新连接，歌词取得原 key/原内容，队列和配置不变；随后各实际修订歌词、删除至无词，再恢复原歌词，原生文档/文字同步。`native-scope-isolation-1793297152742.json`。不代表延迟响应、乱序投递或慢文档超时已测。 |
| 最低宿主图形基线对照 | 在全新任务目录使用真实官方 DBX 0.6.35，提交 `1d042b8` 与最终两版共四条原图形流程全部通过；播放/seek/队列、真实约一分钟定时、主题/预设、工作台关闭重开和八类 MediaSession 注册一致。最终两版均零新增桌面请求、无桥文件且 gate/listenerReady=false。四次定时约 60866/60975/61045/61057ms。`dbx-desktop-minimum-host-1793297219594/comparison-and-cleanup-1793297676441.json`。截图已查看；注册不等于物理媒体键输入，核心流程不代替全部舞台/UI。 |
| 正常退出与环境恢复 | 移动测试的 21 个、最低宿主测试的 12 个实际归属进程实例均按父子创建时间核对、通过正常入口退出并确认不存在；两个宿主监督结果 exit=0、globalFilesChanged=[]。原数据路径、三份授权文件字节、原生配置与组件 hash 均恢复，最低宿主使用的 latest 元数据也恢复原备份。`restore-1793297175108.json` 与上述最低宿主比较/清理报告。 |

冻结注入的解释已补证：`freeze-probe-1793296714620.json` 期间管理通道持续响应，tick 从 **10813 增至 14985**。因此 CDP 虽确认 frozen，也没有真正停止此 WebView2 的动画循环；该报告 `passed=false` 仅表示没有取得合格的冻结恢复证据，不能据此认定产品 watchdog 失效。后续有效停转验证独立归档，原冻结报告不删除或改成通过。最初目录重绑尝试及首次 scope 驱动误以为 GET 返回原始歌词的失败也保留；后者在改写歌词之前拒绝，已恢复钥匙，随后用已核实的原 fixture 内容完成真实修订和恢复。

**当前八小时之外仍未完成：** 真实登录自启、不同 build 并存；实际旧管理协议宿主、丢应答/跨进程管理及完整 I/O/崩溃交错；真实 GUI 缓冲、慢文档期间切曲/同 key 超时恢复、迟到/倒序响应的剩余寿命；切源后的房间权限组合与其余原舞台/UI 基线；物理媒体键/声学/实际鼠标穿透和托盘找回、锁屏/断屏/Explorer/WorkerW 恢复；预先冻结的绝对资源预算与正式分发资格。其他真实用户/会话、macOS、ARM64 仍无环境证据。八小时按用户当前优先级继续暂缓，没有累计旧轮时间或将本轮分项冒充完整发布验收。


## 2026-10-30：慢 I/O、管理兼容与房间切源补验

按用户“主要验证除八小时之外”的优先级，继续使用 `shutdown-discovery/` 最终冻结的两版包和 `07d87e…` 桌面组件（exe SHA `4d2906f4195c0b55cdd6df31b616225de2f30099d97acae3096e3a69ea60874a`）。没有重建产品或更改生产期限。新增索引 `output/dbx-desktop-d3/shutdown-discovery/final-nonsoak-fault-verification.json` 核对六份主报告、驱动/夹具、截图和产物 SHA，保留六份失败或中断证据，继续 `completeNonSoakAcceptance=false`、`d3bComplete=false`。

- 实际最终 native + 认证管道夹具六项：同 key 文档超时后重试、慢旧文档切曲取消、buffering/恢复、两 scope 回退 seq 独立过期/恢复、迟到壁纸快照保留原年龄且旧频谱归零。数据夹具保留真实 secure pipe、peer PID 和 deadline；不能代替生产 DBX 在线音频缓冲。
- 实际 native 管理三项：写入后丢应答，查询并同 requestId 重试仅一个中心；八个独立客户端进程并发复用唯一组件；停读 2800ms 时另一 status 在约 2318ms 成功。背景 feed 为夹具，完整插件 GUI 丢应答/撤销交错仍待验。
- 真实历史 `1d042b8` 源码重建的无版本旧组件：status 缺协议/build 字段；最终两版设置 UI 和 connect 均准确拒绝，原播放/队列不变，旧程序正常退出。
- 真实不同构建并存：`433e…` 配套 Standard 与最终 Full 同处官方 DBX 0.6.47，旧 Standard 桌面操作拒绝而基础播放正常，Full 原 PID/session/歌词壁纸与配置保持；准确最终 Standard 已恢复。
- 实际五次来源选择与 loopback TLS 房间：房主/访客保持现有桌面空态，九次伪造 native 播控无效；原房间 transport 无权限时 room_denied，授权后房间 pause 可用；离场后本地原生暂停恢复。null 音频/control-only；无桌面 track，未进入窄 HTTP 播控，不将空态防护冒充窄端点房间权限测试。
- 最终共用配置字节未变，两版安装 binary SHA 恢复；DBX 正常 exit=0、globalFilesChanged=[]；退出前按创建时间确定的 12 个实际归属实例全部回收。各完成报告中的 native、fixture 和房间服务均正常退出。六张截图已查看。

文件分别为 `desktop-native-feed-faults-1793298247047/report.json`、`desktop-native-management-faults-1793298731317/report.json`、原 GUI 会话下的 `final-legacy-management-1793299039854/report.json`、`final-distinct-builds-1793299316145/report.json`、`final-room-source-switch-1793299705082/report.json` 和 `final-fault-cleanup-1793299795395.json`，完整绝对路径/hash 均在新索引。

管理早期 ENOENT/control_busy、驱动未捕获预期 EPIPE 的中断、旧页 IPC readiness 的强退尝试、房间观察器漏初始事件与误用凭据的 401 均保留；中断无完整报告，不能声明当次正常清理。最终驱动仅在原期限内处理瞬时状态，未放宽产品断言。完整原因和最新剩余清单见[验收审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30慢-io管理兼容与房间切源补验)。剩余包括生产 DBX 在线缓冲、完整插件管理/I/O/崩溃交错、其余原舞台/UI、真实登录/物理输入/系统恢复、绝对资源预算及正式分发；其他用户/会话、macOS/ARM64 仍缺环境，八小时继续暂缓。

### 2026-10-30：真实在线准备缓冲与两版设置页故障

新索引 `shutdown-discovery/final-production-buffering-and-gui-faults.json` 将准确冻结产物与五份主报告、驱动/夹具、11 张原截图及五份保留失败绑定。真实最终 Full 经临时进程代理延迟音乐上游数据，八个生产 buffering 样本跨 2904ms，原 DBX `is-loading` 和 native buffering 同步；恢复后原 session 取得真实网易云 43 行歌词，位置和壁纸绘制推进。没有改系统代理、解密 TLS 或注入缓冲标志；范围为在线准备缓冲，不宣称原音频停顿或全部中途欠载/声学时序。

真实官方 DBX 0.6.47 的 Standard/Full 设置页各四项通过：2s 管理 deadline、错误 requestId、错误 target、连接中撤销并拒绝 2500ms 后的迟到结果。保留授权、明确失败、显式重试及播放/队列隔离成立；两次撤销约 740/738ms。管理对端是准确冻结 IPC/安全/期限的夹具，不能代替真实 native 中心开窗或全部 I/O/崩溃矩阵。客户端 deadline 与服务端断管竞态可分别呈现 timeout/unavailable，均记录准确错误，不把原失败报告改判。

native/夹具及两轮 DBX 都正常退出；22 个实际归属进程实例已按 PID+创建时间确认消失，全局宿主文件无差异，共用配置和原缓存 SHA 恢复。一轮早期驱动曾留下在线队列，随后恢复最初 Full 本地队列，再经实际宿主重启确认原队列且不自动播放。逐份报告路径、失败原因和更新后的未验范围见[最新审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30生产在线缓冲与真实设置页异常补验)。八小时继续暂缓，D3b 与全部非八小时验收仍未完成。

### 2026-10-30：原舞台与三维空间的真实包差分

`shutdown-discovery/final-stage-ui-baseline.json` 绑定全新任务数据目录的真实 DBX 0.6.47 历史 `1d042b8`/最终包对照。Standard、Full 在前后各完成十五项：六种沉浸歌词视觉、三种沉浸场景、沉浸队列/暂停/seek/恢复，以及三维空间首页/两场景/两种歌词/队列/暂停恢复/返回二维，共六十次通过观察。原目录、曲目/队列、十八行歌词、实际 ready/drawCalls 和播控代际增量一致；四条成功流程零桌面请求、无桥文件，最终 gate/listener 关闭，pageerror 为空。没有安装或授权桌面组件，未重建产品。

八张截图已查看，四份舞台驱动失败与两份清理包装失败保留；独立清理后 DBX 正常退出、十二个实际归属实例消失、全局文件无差异、原共用配置未变，原会话元数据恢复。上述只是有限静音流程，全部预设/交互、物理输入/声学/系统恢复、其余授权 I/O/崩溃交错和正式发布资格仍待验；完整非八小时验收和 D3b 不改为完成。范围见[舞台差分审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30两版原舞台与三维空间差分)。


### 2026-10-30：真实 GUI 授权文件故障与重启

`shutdown-discovery/final-gui-authorization-restarts.json` 绑定新任务目录中官方 DBX 0.6.47、准确冻结两版包的 16 项通过检查：探测中撤销/强退、第二钥匙创建失败、授权原子替换失败、发现发布失败、已持久授权但中心应答未到时强退、持久撤销失败及钥匙清理失败后的重启。共 14 次真实 sidecar 强制终止/激活、6 个实际 Windows FileShare.Read 锁；迟到应答均无效，钥匙本身不代表同意，持久禁用后残留钥匙不恢复授权。撤销写盘失败的真实 UI 警告与重启恢复旧同意相符。

各非重启故障保持原播放代际/曲目/队列；所有重启保留队列且不自动播放。两版最终持久撤销、gate/listener 关闭；残留钥匙最后一次重试是显式后端清理，未冒充 GUI 流程。四张截图已查看。夹具和六个锁进程正常退出，DBX 正常 exit=0、全局文件无差异，12 个实际归属进程实例回收；共用配置未变，原会话元数据按字节恢复。

没有修改或重建产品。管理夹具链接冻结生产 IPC 源码，使用独立依赖锁，未启动实际 native；有限检查点不等于逐机器指令/断电或全部交错。两份未刷新宿主安装列表导致的前置按钮定位失败保留。详细故障语义及剩余手动/环境/发布验收见[本批审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30真实设置页授权落盘故障与强退恢复)。八小时暂缓，完整非八小时验收和 D3b 仍未完成。


### 2026-10-30：真实 native 应答丢失与插件并发

`shutdown-discovery/final-gui-native-replies.json` 新增两版各五项、共十项真实链路检查：真实 open-center 应答丢失后查询/重试，一个 GUI 与七个实际宿主后端 connect 合并，打开应答 pending 时关闭工作台，真实在线 status 延迟到撤销之后，以及撤销/新授权完成后旧打开应答才到。测试代理原样转发请求，只丢弃/延迟真实 native 返回值；数据 feed 始终来自真实最终 sidecar。准确冻结产品未改或重建。

两批八个并发 connect 各仅一个真实 native open，唯一中心/配置与原授权保持；旧回复不复活撤销来源、不覆盖新授权，真实双 surface 的十八行文档与同 session 快照恢复后确认在线。十项均不改变原播放代际/曲目/队列。四张截图已查看；native 与代理正常 exit=0，DBX 正常 exit=0、全局文件无差异，共二十一个实际归属实例正常回收；原共用配置和原任务会话元数据恢复。

一次早期驱动过早要求重授权后立即在线，并错误用 DBX 禁止的 legacy quit 导致任务 native 强制清理，原失败证据保留，旧实例已补核消失。最终以真实新鲜数据为在线前提，经原页面 IPC 正常退出。代理独立依赖锁和同一真实 SID/会话的端点区分不能证明跨身份；有限并发/事件排列不替代全部交错、音频/物理系统/资源分发及其他环境验收。完整范围见[本批审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30真实插件与真实组件之间的应答丢失和并发)。八小时暂缓，D3b 未完成。


### 2026-10-30：实际歌词软件时序与稳定暂停

`shutdown-discovery/final-native-software-timing.json` 绑定准确冻结两版包、官方 DBX 0.6.47、真实最终 native 及正常清理证据。生产 API 导入明确逐词时间戳的真实歌词，实际 DOM 进度由前后真实播放器快照夹测（整段不超过 50ms、取端点最大误差），两版各 160 个有效样本、零拒收，p95 上界分别 45.5ms/44.5ms，通过 100ms 门槛。共四十次暂停、暂停中 seek、恢复、播放中 seek 和换曲均在 750ms 内反映，最长 519.50ms；八次冷换曲首次文档另计 1437–1503ms。

原播放器稳定后，两版各连续暂停超过十秒，新增 rAF 请求/回调及逐词进度变更均为零。四份原始测量失败保留并说明修正依据，未改产品或验收门槛。两张截图已查看；native/DBX 正常退出、21 个实际归属实例回收、全局文件无差异、原配置与会话元数据恢复。软件位置不代表声学时延，有限事件不代替播放中欠载、隐藏策略/五十次启停及物理系统/资源分发等验收；八小时暂缓、D3b 未完成。详见[本批审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30真实最终组件的软件歌词时序与稳定暂停)。


### 2026-10-30：五十轮组合启停与资源回收缺口

`shutdown-discovery/final-native-lifecycle.json` 记录真实两版 DBX 各五十轮歌词/壁纸启停、锁定和独立关闭。各六个同状态检查点回到十二个 HWND/原两页，原暂停/曲目/generation/队列保持；另两版实际继续播放时停用歌词超过十秒，新增 rAF 和逐词进度变更均为零，来源各前进 11380ms。产品未改或重建。

资源项未通过：独立重复的 DBX 组合流程五十轮后 Process 句柄 16 → 66，停用 61.368 秒仍保留。`final-native-lifecycle-controls.json` 记录四个独立版管理路径的五十轮负对照（无 CDP、连接 CDP、逐页 CDP 读取、单独锁定），各 15 → 15，均未复现；不能把现象归因于 CDP、壁纸重建或锁定单项，也不能外推到 DBX 单独使用。组合提交/歌词可见性/实际 DBX feed 的差异仍待隔离，`P2-native-process-handles-retained` 保持 open，完整 controller/listener 回收未计通过。

两张截图已查看。主批 36 个、独立对照 32 个实际归属实例均正常回收；宿主全局文件无差异、原配置与任务元数据恢复。两份前置驱动失败保留并补核清理，未强退产品。详细负对照、观测边界及最新剩余见[本批审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30五十轮启停锁定停绘及未通过的资源回收)。八小时暂缓，完整非八小时验收和 D3b 未完成。

### 2026-10-30：复用 WebView2 目录的无调试复现

`shutdown-discovery/final-native-lifecycle-isolation.json` 新绑定十四份实际报告。真实 DBX 的重复保存、歌词启停和锁定各十轮无增长，壁纸启停及原组合各十轮 +10；去掉观察器、再去掉空初始化脚本仍复现。新目录下不连接桌面 CDP、连接并逐页读取、完全关闭桌面调试入口的三组五十轮均无增长；新目录的空脚本、首次绘制后关闭及实际设置 IPC 各十轮也无增长，单项负对照均不豁免原失败。

同一原设置/切源流程改用新目录，十轮 Process 15 → 15；逐文件复制旧任务 WebView2 目录后，十轮 16 → 26。旧目录副本再完全关闭桌面调试入口，以真实 DBX 数据/原生心跳绘制为每轮前提，五十轮 **15 → 65**，停用六十秒仍保留；新增五十个句柄指向同一活着的 WebView2 NetworkService 子进程，目标计数 4 → 54，进程角色与 PID/创建时间已对齐。目录内容和确切持有代码尚未隔离，问题不依赖桌面调试连接；不自动清缓存、不推断 DBX 单独使用回归，`P2-native-process-handles-retained` 仍 open。

产品未改或重建。十二轮 native 正常退出并回收九十六个归属实例；两轮完全无桌面调试测量结束后明确终止自己拥有的 native，共十六个实例消失，不计正常退出通过。两个独立服务正常退出；DBX 正常退出、十个归属实例消失、全局文件无差异，共用配置及原会话元数据恢复。完整证据边界和剩余项见[本批审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30复用-webview2-目录的无调试句柄复现)。八小时暂缓，完整非八小时验收和 D3b 均未完成。

### 2026-10-30：同目录原地重启与否定的实验候选

`shutdown-discovery/final-native-restart-diagnostics.json` 新绑定十份实际报告。同一真实独立 Standard 服务/session、暂停播放器、同一配置/WebView2 目录，原最终组件首个生命周期十轮 Process 15 → 15；正常退出、八个实例回收后原地重启，第二个生命周期十轮 **16 → 26**，停用六十秒仍保留。无需 DBX、目录复制或调试连接。首启稳定不能代表复用目录通过。

冻结副本中的环境复用实验 `12e726…` 与 HTTPS 自定义协议实验 `649624…` 均在五十轮后 +50，不采纳，未改产品主树或重建最终 DBX 包。环境复用报告另因独立播放器自动循环导致末尾代际变化而整体失败，保留原失败；HTTPS 明确暂停，首阶段即失败，未运行第二阶段。有效移除子资源规则、替换 Local State 和两种 Default 分区互换也未消除增长，不归因于某个目录内容。原索引“全部来源暂停”文字已校正，旧索引另存，原报告不改写。

本机环境 26200.9711 / WebView2 156.0.4314.50；公开 [WebView2Feedback #5704](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5704) 是同类线索，尚未证明同根因，未发送消息。十一个 native 生命周期正常退出、八十八个归属实例回收，十个服务正常退出，原目录 288 个文件/共用配置/元数据及产品 app.rs 保持。详见[本批审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30同目录重启复现与未采纳的修复实验)。资源项和 D3b 仍未通过，八小时继续暂缓。

### 2026-10-30：移除 Hertz/Wry/DBX 后的最小复现

`shutdown-discovery/final-minimal-webview2.json` 绑定独立 COM/WebView2 程序及两个实际报告。只保留 anchor controller 和逐次创建的 child controller，导航本地极小 HTML 成功后取消订阅、Close、释放、销毁父窗口并持续泵送消息；没有 Hertz/Wry/Tao/DBX、业务数据、自定义协议或调试端口。首启十轮 Process **8 → 8**，同目录正常重启十轮 **9 → 19**，再次正常重启五十轮 **9 → 59**，均观察六十秒冷却。新增句柄分别使同一活着的 WebView2 NetworkService 目标计数 3 → 13、3 → 53，实际版本 156.0.4314.50。

三阶段正常 exit=0，24 个实际归属实例全部回收；原任务目录 288 项、配置/元数据和产品 app.rs 保持，未改或重建产品。初次编译的导入错误在实际运行前修正。源码、锁、准确二进制、不同版本驱动和重跑说明均保留。这是此类故障不依赖应用栈的新证据，尚非 SDK/运行时/OS 内部根因或产品修复证明；未向上游发送消息。资源问题仍 open，完整非八小时验收及 D3b 未完成，其余缺项见[本批审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30独立-webview2-最小程序复现)，八小时暂缓。


### 2026-10-30：真实播放中欠载复验与配套包

真实 Full 在线播放中暂停音频传输后，旧包在位置 28801ms 不变时仍不断刷新旧 FFT，确认 `P2-wallpaper-stalled-fft-refreshed`。仅修正桌面投影及原事件调用，用真实代际/位置阻止停滞帧重新记时；保留原音频状态、WS 广播和一秒过期，不走 TDD，改后补回归。新冻结 `stalled-spectrum/` 只纳入两个文件的对应片段，桌面输入与 `07d87e…` 组件不变，插件指纹 `ae97161c…`，共享主树其他改动排除。

`qualification.json` 绑定实际新 Full 欠载报告：持续停滞 6111ms，25 个稳定样本覆盖 4473ms，歌词 rAF 增量零，seq 持续到达，频谱均零且最小 age 1905ms，环境继续 123 帧；放行后同曲同代际恢复。native/服务正常 exit=0，9 个归属实例回收。两版新 release HTTP/WS、7 项源码回归、MSRV 1.88/-D warnings、新包原 cpal stdio 314/314 与 298/298、最低/当前真实 PluginHost 八组、实际 RPC/独立身份复算与生产数据管道回归均通过。

这是本冻结候选的限定修正资格，未重跑旧候选全部真实 GUI 或声学/物理输入矩阵；不能把旧包其他通过项移记到本批。历史清单 288 项保持，额外两个早于候选创建的 SQLite 辅助文件单列，无全目录相等承诺。句柄问题仍 open，完整非八小时验收和 D3b 未完成；八小时继续暂缓，DBX 单独使用无行为变化硬约束不变。准确新包 SHA、失败/边界及其余缺项见[本批审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30新频谱候选的配套包回归)。

### 2026-10-30：扩展检查补记退出残留失败

`stalled-spectrum/extended-regression.json` 保留新 Full 播放/大文档组合与新 Standard 路径别名组合的整体失败：各子项通过，但正常 exit=0 后留下本实例来源发现文件。重复原最终包五轮路径别名检查，2/5 轮同样失败；新候选后续一次重复播放组合通过，不覆盖先前失败。两版撤销落盘失败/重启五项通过。最小 EOF 探针在首次读管道 EPIPE 后中断，唯一实例强制清理，不计正式 EOF 样本。

新增 `P2-dbx-eof-discovery-retained` open；原新相同 main.rs 在 EOF 后启动桥清理却未等待完成，可能使 runtime 提前结束，修复尚未实施/验证。`qualification.json` 已设 `allExecutedChecksPassed=false`，保留频谱限定修正资格及核心检查范围，不能认定新候选全部通过。WebView2 句柄问题仍独立 open，完整非八小时验收和 D3b 未完成。准确失败、对照、下一步与边界见[最新审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30扩展管道检查发现正常退出残留)，八小时继续暂缓。


### 2026-10-30：进程退出等待修正及重复复验

`shutdown-barrier/` 相对 `stalled-spectrum/` 仅修改插件 `main.rs`，由进程 owner 同时等待原有界桥清理和原 AppState shutdown 完成；不新增播放 owner/接口/状态，先实现再验证。准确插件指纹 `c2ad542c584bb8cf69f16fbfc7beb875c70569fb8ecb54ebe14e180e896dc28a`，桌面输入及 `07d87e…` 组件保持。两版新包原 cpal stdio 314/314、298/298，Rust 1.88/-D warnings、实际 RPC/独立身份复算、最低/当前真实 PluginHost 八组均通过。

每版 10 轮路径别名、3 轮播放/大文档正常退出及默认/撤销组合共 15 份双版报告通过；发现清除、授权保持及重启恢复均核对。两版无授权/双 scope 阻塞房间 EOF 各三轮共 12 份、管理阻塞六例通过。当前官方 DBX 0.6.47 的历史提交基线与新包两版四次核心图形流程（播放/seek、定时暂停、主题/预设和工作台生命周期）一致；两版未授权零桌面请求/桥文件/原生配置。宿主正常退出，14 个归属实例回收，原全局文件/任务元数据保持。

新包又通过两版来源 owner 强退/接管/目录移动八项、管理并发/撤销六项及实际激活落盘失败后的强退重启恢复六项，共二十项；旧 session 拒绝、接管记录和授权保全均核对。管理对端为协议夹具，不冒充真实旧 native 或 GUI 强退资格。

`P2-dbx-eof-discovery-retained` 仅标记本冻结候选内修正通过，旧包偶发失败报告保留；有限重复不证明零故障率。房间 helper 服务沿用上一批准确二进制，频谱修正源码保持但未在本插件入口增量再次跑在线欠载，不冒充新同源服务或新 GUI 欠载证据。WebView2 句柄问题仍 open，完整非八小时验收/D3b 及物理/系统/其他身份平台/发布预算缺项仍保留；八小时暂缓。准确包 SHA、范围及其余缺项见[最新审计](./2026-10-29-dbx-desktop-acceptance-audit.md#2026-10-30进程退出等待修正及重复复验)。


### 2026-10-30：退出等待候选的已授权图形与宿主生命周期

`shutdown-barrier/authorized-qualification.json` 绑定准确新包及未变的 `07d87e…` / SHA `4d2906…` 组件。当前官方 DBX 0.6.47 两版真实首次 UI 授权、显式切源与两种 surface 启用通过；授权/打开中心未隐式切源。已授权期间胶囊→展开、关闭工作台、宿主最小化→恢复均保持原 sidecar PID/创建时间、播放及同 session 歌词/壁纸。两版播放中/暂停中各伪造 pause/seek/play，共 **12 次**原生 IPC 均拒绝；实际暂停后旧频谱归零，环境绘制继续。

两版各 stop/kill sidecar 共 **4 次**，约 **1.46–1.50 秒** 清空旧音乐数据；组件存活、环境动画继续，新 session 恢复同 key 与同内容歌词，授权保持。两版各正常/强制退出 DBX 并重启共 **4 次**，约 **1.08–1.51 秒** 清空，组件继续运行、旧 host 及其归属实例按 PID+创建时间全部消失，重启后恢复新 session 和同 key 文档。原三秒清空与恢复断言不变。组件先于 DBX 启动的实际手动顺序也通过：保留原绑定、显示等待、无播放器被启动，随后 DBX 启动可恢复；**这不是 Windows 真实登录自启资格**。

实测区分宿主退出和 sidecar 自然退出：两次正常 DBX quit 的宿主 exit=0，但 Job 内 sidecar exit=1；两次强制 DBX 退出的宿主 exit=1，sidecar 却为 exit=0。四次均可能留下准确旧 PID/session 的发现记录，原生仍按期限清空，接管后新 session 恢复。只读 .NET Process 句柄观察记录真实退出码并及时释放；本地 DBX 源码仅辅助解释，不冒充官方 exe 的源码身份。**exit=0 本身不能证明 sidecar 走完自然清理**，不能为了删除 Job 中断后的残留而修改 DBX。上一批受控 stdin EOF 的发现删除检查继续严格通过，未改阈值或移记本批结果。

首个已授权会话正常结束后，**21 个**当时归属实例消失，实际 native/host 均 exit=0；这不意味着每个 Job 子进程都是自然退出。宿主四次恢复和最终退出另逐批核对整棵归属树，原生最终正常退出且无该批 DBX/sidecar/native 进程。原用户配置、288 个历史文件与另两文件的前批明确基线、全局 DBX 文件及原全局任务元数据保持；共享 debug 服务未动。

四次未通过尝试原样保留并分类：生成器未生成入口、错误把正常宿主退出等同 sidecar EOF、观察器晚于首次文档投递、错误把强退后的 sidecar exit=0 等同自然退出。最终提前安装原透传观察器，用真实退出方式和旧 PID/session 校验残留；保留原新鲜度、播控拒绝、文档恢复及整树清理要求。全部尝试均正常清理组件和剩余宿主；没有将失败报告改为通过。截图仅辅助实际内容观察，不证明物理透明合成、鼠标穿透或声学。

`P2-native-process-handles-retained` 仍 open；完整非八小时验收、最低宿主的新包完整图形与其余 UI/故障组合、内部 controller/listener 回收、真实 Windows 登录/物理输入/锁屏与系统桌面恢复、声学和绝对资源发布预算/签名、缺设备的其他用户/会话及 macOS/ARM64 资格仍未完成。八小时继续暂缓，D3b 保持未完成；本轮无产品源码修改或重建，其他共享主树修改不归本批资格。

原首会话报告曾引用任务配置 revision 12 的摘要；后续显式切源推进到 revision 14。原报告与当前文件均不改写，按原 Rust 序列化仅替换 revision，且必须与原历史 SHA-256 `813284df…` 完全相等后才保存 `config-after-authorized-session.recovered.json`。索引显式将该历史可变状态引用映射至准确字节快照；这不是用后来状态覆盖早期记录。


### 2026-10-30：退出等待候选的最低宿主与舞台空间对照

`shutdown-barrier/graphical-coverage-qualification.json` 绑定与前批相同的准确两版新包及冻结输入；本轮没有修改或重建产品。实际官方最低宿主 **DBX 0.6.35** 中，历史提交 `1d042b8` 两版与本候选两版的 **四次核心 GUI 流程**通过：播放、seek、队列、主题/预设、工作台关闭重开及八类 MediaSession 注册一致，定时暂停分别约 **61.218 / 60.925 / 60.973 / 60.607 秒**。两版未授权时均无新增桌面请求/桥文件/原生配置，gate/listenerReady=false。旧驱动 limits 中静态 0.6.47 描述保留，实际 report.version、监督器路径、执行 exe SHA 与 zip 成员独立复算均确认本次为 0.6.35。

最低宿主首轮在历史两版通过后，直接替换仍运行的插件 exe 遇到 Windows sharing error 32；`comparison.json` 保持 failed。随后经真实宿主 `stop_plugin` 停止两版并确认旧 sidecar 消失，同一宿主及业务数据中只补跑新包两次流程，`comparison-resumed.json` 通过；停插件与升级成功记录单列，没有把安装失败改写成通过。

当前官方 **DBX 0.6.47** 又完成原有每版 **15 项舞台/空间**的历史包/新包差分，共 **60 次观察**：六种沉浸歌词、三种沉浸场景、沉浸队列/暂停/seek/恢复、两种空间场景、两种空间歌词及空间队列/暂停/恢复。原比较断言未放宽；目录、曲目队列、18 行歌词、渲染器/歌词选择及播放代际增量 5 一致，无 pageerror、桌面请求/桥文件，gate/listenerReady=false。八张实际截图及对照拼图已查看；动画相位有差别，不能认定逐像素一致，也不替代声学或物理输入。

两个宿主均正常 exit=0，分别 **14 / 13 个**当时归属 PID+创建时间实例全部消失，全局 DBX 文件与原任务元数据保持；原用户配置、288 项历史文件及另两项前批基线保持。619 项冻结输入与 **544 个绝对摘要引用、178 份 JSON**递归核对通过；原授权会话的历史可变配置仍仅按明确的准确字节快照别名解析。

本批补齐最低宿主核心无授权 GUI 和当前宿主有限舞台/空间子矩阵，不代表所有最低宿主 UI/授权/故障组合已完成。`P2-native-process-handles-retained` 仍 open；内部 controller/listener 回收、生产慢文档/切曲和完整故障交错、真实登录/锁屏/显示与 Explorer 恢复、物理媒体键/鼠标穿透/托盘找回、声学/绝对资源预算/签名，以及缺设备的其他身份与 macOS/ARM64 仍按原要求保留。八小时按用户优先级暂缓，完整非八小时验收和 D3b 仍未完成；DBX 单独使用无行为变化硬约束保持。


### 2026-10-30：退出等待候选的设置页管理故障

`shutdown-barrier/finite-gui-fault-qualification.json` 在前节最低宿主/舞台证据上追加准确新包的真实设置页故障验证。官方 DBX **0.6.47** 中，Standard / Full 各四项，共 **8 项**通过：真实两秒管理连接期限、错误应答 requestId、错误目标 profile，以及打开中心期间撤销后的迟到应答。实际新 sidecar/设置页原八项业务断言保持；管理对端是受控的已认证故障夹具，**不等于真实 native 中心的窗口资格**。

超时/坏应答没有打开中心，已有数据授权保持且界面提供重试/撤销；显式重试成功。撤销等待中的打开请求返回 `desktop_operation_cancelled`，迟到应答的 admission 无效且未发给接收端，gate 保持关闭；随后显式重新连接恢复双 scope。两版实际播放保持，代际及队列不变；Full 原本地队列从本次隔离会话捕获并恢复，未引用或改动旧在线缓冲会话。两张代表性实际设置页截图已查看，错误和撤销状态与报告一致。

故障夹具正常 exit=0，真实宿主正常 exit=0；当时 **13 个**归属 PID+创建时间实例全部消失，全局 DBX 文件/原任务元数据及原用户配置/明确的历史 profile 基线保持。最终递归检查 **604 个绝对摘要引用、192 份 JSON、619 项冻结输入**通过；292 条相对清单由声明的目录根单独核对，历史可变配置仅用原明确快照别名解析，无失败。

本轮补测没有发现这八项中的新增产品失败，也未修改/重建产品。最低宿主那次升级 sharing error 32 及此前各批失败仍保留，不能写成所有尝试都成功。完整非八小时验收/D3b 仍未完成，原生句柄保留问题 open；完整内部资源、生产慢文档/切曲与逐步骤 I/O/崩溃组合、物理/系统恢复、发布预算/签名和缺设备的身份平台边界继续保留；八小时暂缓，DBX 单独使用无行为变化硬约束不变。


### 2026-10-30：退出等待候选的真实原生应答与生产数据恢复

shutdown-barrier/real-native-qualification.json 沿用准确新包、官方 DBX **0.6.47** 及未变 07d87e… / SHA 4d2906… 原生组件，增加两版各七项共 **14 项**实际联调。每版原五项管理业务断言保持：真实 native 已处理打开但丢应答后重试、一次 GUI 加七次后端并发仅转发一次打开、native 已打开但应答前关闭工作台、真实已连接 status 在撤销后迟到，以及新授权已完成时旧打开应答才到。共十项都用原样转发的真实 native 业务回复；播放/队列和配置保持，旧应答 admission=false 且未投递，新授权不被覆盖。它不等于模拟管理业务回复的上一批夹具。最终两版均显式撤销。

新增每版一次真实生产 sidecar 全进程暂挂，辅助进程按准确 exe/PID/CIM 微秒创建时间绑定对象，持有句柄并在 finally 或八秒上限自动恢复。实际暂挂时间到歌词/壁纸清空事件约 **2073 / 2306ms**（驱动就绪后观察为 2029.68 / 2310.79ms），均符合原三秒加 150ms 观察容差；旧频谱归零、环境动画继续。恢复后原 PID/创建时间、同 session、同 key 与相同 18 行歌词保持，原授权及播放代际不变。**全进程停滞不是独立慢 document 操作，同 key 恢复可能使用 reader 缓存，不宣称重新走管道取回文档。**

每版实际导入既有上限内的 **2000 行** LRC，原生接收文档编码约 **408632 / 400632 字节**；两首真实零增益 WAV 间各三次切曲，共六次，每次歌词 key/曲目/内容 marker 与壁纸 session 匹配；两次当前曲大文档修订产生新 key 并恢复。之后恢复原曲的 18 行及队列，授权/配置/sidecar 身份保持。合成样本每 50ms 换行且文本很长，截图处于连续歌词过渡而模糊；两张代表图已查看，**该压力检查验证数据与身份，未据此判定排版可读性、声学或物理透明合成通过**。独立慢文档、切曲与超时的完整交错仍保留。

首轮 Standard 原五项已通过，新增暂挂却在动作前被创建时间精度校验拦住：CIM 仅微秒，.NET 有 100ns；只读自身对照为 9556430 / 9556431，差一个 tick。原 failed 报告/驱动/辅助程序保持；按原 CIM 精度用整数 tick 比较并继续绑定准确 exe/PID 后，新隔离会话重跑完整两版通过。首轮未实际暂挂或执行大文档，不将其记为产品恢复失败；大文档参数在重跑前按实际 2048 行/256 KiB 导词合同收敛，不改变产品门槛。

通过和失败两次会话的 native、转发进程及宿主均正常 exit=0；各次 **9 个 native + 13 个 host** 归属实例全部消失，共 44 个，旧服务未动。全局 DBX 文件、原任务元数据、原用户配置、288 项历史 profile 文件及另两项明确前批基线保持。**727 个绝对摘要引用、222 份 JSON、619 项冻结输入**递归核对通过；相对清单与历史配置快照别名仍按原明确规则解析。本轮未改产品源码或重建。

P2-native-process-handles-retained 仍 open；完整内部资源、独立慢文档/真实缓冲及其他 I/O/崩溃交错、真实登录/锁屏/显示/Explorer 恢复、物理媒体键/鼠标穿透/托盘找回、声学/绝对资源预算/签名，以及缺设备的其他身份和 macOS/ARM64 仍待验。八小时按优先级暂缓，完整非八小时验收/D3b 未完成，DBX 单独使用无行为变化硬约束保持。


### 2026-10-30：退出等待候选的真实在线准备缓冲与主树范围

shutdown-barrier/production-buffering-qualification.json 将准确新 Full 包、官方 DBX **0.6.47** 和原配套组件的真实在线准备缓冲补齐。全新隔离 DBX 数据，不移动历史缓存/业务库；只给本任务宿主及插件设置临时 loopback 代理，HTTPS 仍端到端，不注入播放器或 renderer 状态。显式测试授权由后端 connect 发起，来源由隔离配置预置；**不是首次真实 UI 同意或默认配置的新增验收**。

真实网易云“晴天(深情版)”搜索/取词后，代理实际暂存两条连接的上游字节。DBX 播放状态和真实 native 歌词快照连续 **8 个**缓冲样本，覆盖 **3282ms**；放行后恢复真实播放与 **43 行**歌词，曲目/播放代际/文档 key 和壁纸 session 匹配。之后 DBX 与原生进度继续增加、壁纸继续绘制，原生 DBX 播控仍禁用。两张缓冲/恢复实际歌词截图已查看。只覆盖首次未缓存在线准备，不扩大到所有源、后续欠载、声学或音频到显示延迟。

原队列、用户配置及明确的历史 WebView profile 基线保持；native、宿主与监督进程均正常 exit=0，**22 个**归属 PID+创建时间实例消失，全局 DBX 文件/原任务元数据不变。最终 **785 个绝对摘要引用、235 份 JSON、619 项冻结输入**核对通过，无失败，历史快照别名和相对清单继续按明确范围处理。

收尾时共享主树 app.rs 已不同于冻结副本，并在观察间继续变化。原“主树必须逐字未变”及后续一次快照稳定性检查均失败并单列，不能写成完整主树保全通过；不同观察的准确字节/摘要已保存。之后仅将**原用户状态、既有准确组件和冻结 619 项**作为本候选保全范围，主树观察明确 qualified=false；候选 exe SHA 及冻结源未变，没有构建这些主树修改，也没有回滚它们。不能把本批通过结论移给当前可变主树。原失败检查及原生应答前批创建时间驱动失败都保留。

P2-native-process-handles-retained 仍 open；独立慢文档/切曲/期限完整交错、完整内部资源和 I/O/崩溃顺序、真实登录/锁屏/显示/Explorer 恢复、物理输入/声学、绝对资源预算/签名及其他身份平台继续待验。八小时仍按用户优先级暂缓，完整非八小时验收/D3b 未完成；DBX 单独使用无行为变化硬约束保持。


### 2026-10-30：退出等待候选的独立慢文档、切曲与传输年龄

`shutdown-barrier/production-data-qualification.json` 继续绑定准确两版 `.dbxp`、官方 DBX **0.6.47** 与未变 `07d87e…` / SHA `4d2906…` 组件，每版三项共 **6 项**通过。测试转发器只在隔离 DataDir 内将发现记录的 owner PID/私有管道名换成自身，按原 SID/session/PID 规则连接真实生产插件，业务请求与响应 body 原样转发；结束逐字恢复发现记录。**这是可控传输下的真实业务数据验证，不是生产发现 owner 路径的新资格**，也未向播放器或 renderer 注入状态。

每版将真实新 document 的首次响应延迟 2500ms，原两秒期限均在 **2000ms** 结束；之后同 key 实际走生产管道再次取回，两次 body 摘要相同，共每版两次实际获取。等待期间各观察到 **4 个不同歌词 seq**，壁纸仍有效且继续绘制，播放代际与队列不变；不是全进程暂挂，也不能归为 reader 缓存恢复。

每版真实旧 document 已在生产端完成后再暂存 **1500ms**，随后切到第二首真实 WAV。新 snapshot/document key 与新曲目匹配，历史中没有在新曲目 snapshot 后应用旧 key；旧管道写入实际返回 **os error 232**，原生已取消旧读取。之后恢复原曲 **18 行**及原队列。首轮 Standard 同 key 超时测试已通过，但驱动错误要求 native 取消后服务端 admission 回调必须不发生；冻结 IPC 的回调是写入前检查，并非送达凭证。原 failed 报告/驱动不变，V2 改为核对实际 closed-pipe 写入失败，保留旧 key 拒绝、新 key、期限、播控与清理断言；不能将原失败改写为通过。

每版将真实 wallpaper 响应延迟 **1400ms**，各连续采集 **24 个**样本；其中 **21 / 13 个**收到的响应已有至少 1250ms 传输年龄，实际最低总频谱年龄约 **1418.71 / 1429.93ms**，有效来源的频谱峰值全部为零。歌词仍新鲜，环境绘制继续；解除延迟后真实非零频谱恢复，新的 snapshotAgeMs 小于 500ms。两张实际歌词截图已查看，只辅助该场景内容观察，不证明物理透明合成、鼠标穿透或声学。

通过及首轮失败会话中，native/管理转发器/宿主均正常 exit=0，各次 **9 个 native + 13 个 host** 归属 PID+创建时间实例消失；三次数据转发器均正常退出并准确恢复发现记录。原用户配置、288 项历史 profile 文件及另两项明确基线保持。最终 **929 个绝对摘要引用、271 份 JSON、619 项冻结输入**递归检查通过，292 条相对清单按声明目录根核对，历史可变配置仍只解析到准确快照别名。转发工具用独立锁文件和 Rust 1.99.1 编译；首次用 1.88 因工具 uuid 依赖版本被拒，不是产品 MSRV 失败。未重建或修改产品，当前可变主树另行观察、qualified=false。

此批补齐两版有限的独立慢文档/同 key 期限重取、切曲取消旧读取和频谱传输年龄组合，不代表所有 seq/session/I/O/崩溃顺序已完成。**P2-native-process-handles-retained 仍 open**；完整内部资源回收、房间/切源实际权限组合、剩余 I/O/崩溃矩阵、真实 Windows 登录/锁屏/显示/Explorer 恢复、物理媒体键/鼠标穿透/托盘找回、声学/绝对资源预算/签名，以及缺设备的其他身份和 macOS/ARM64 继续待验。八小时仍按用户优先级暂缓，完整非八小时验收及 D3b 保持未完成；DBX 单独使用无行为变化硬约束不变。


### 2026-10-30：退出等待候选的房间切源权限与独立播控恢复

`shutdown-barrier/room-source-qualification.json` 继续使用准确新 Standard / Full 插件、官方 DBX **0.6.47** 和原配套 native，并复用历史 `shutdown-discovery` 独立 Standard 服务 SHA `232c29…` 作为实际 loopback TLS 房主/访客。该服务及组件字节已独立复算；**不是从当前共享主树构建的新独立服务资格**。来源预置在全新隔离配置，两版通过后端显式 connect 授权，不是首次 UI 同意或默认配置的新增验收。

真实中心完成 **5 次**来源选择：独立 Standard 房主 → DBX Standard → DBX Full → 独立房主 → 独立访客。每次双 surface 的 session 匹配，两版 DBX 原生工具条禁用。回到房间后的房主、无 transport 权限访客、已授予 transport 权限访客共 **3 种状态**，各伪造 pause/play/seek，共 **9 次**实际 native IPC 均在无本地桌面 track 投影时忽略，房间 revision/当前实例保持。原访客房间命令在授权前准确返回 **403 / room_denied**；授予 transport 后原房间 pause 返回 **200 / no_op**，只证明权限接受，不能声称发生播放状态转换。离场后本地投影恢复，实际原生暂停按钮恢复可用。

**房间没有本地桌面 track，所以这九次没有进入窄 HTTP 播控端点；该端点的房间权限路径仍未验。** null 音频和 control-only 访客也不能代替 PCM、声学或物理媒体键。实际设置截图已查看，显示所选隔离访客来源与已保存状态。

内层业务报告通过，native/两台服务/宿主均正常 exit=0，**9 个 native + 12 个 host + 2 个独立服务**归属实例消失，两版最终撤销。外层汇总器最后却误查 `s.nativeConfig/config.json`，实际驱动刻意使用自己输出下的 `config/config.json`，故外层报告保持 failed。新增只读 `room-source-recorded-run-verified.json` 独立核对真实配置、原业务断言、准确产物摘要、已有 PID+创建时间整树退出与当前无残留；没有重写原失败或冒充重新执行业务。

原用户配置/历史 profile 及全局文件/元数据保持，619 项冻结输入不变，当前可变主树 qualified=false。本批最新递归核对 **1004 个绝对摘要引用、287 份 JSON、619 项冻结输入**通过，292 条相对记录和历史快照别名按既有明确范围处理，无失败。未修改或重建产品，DBX 单独使用无行为变化硬约束保持。

本批仅补齐准确新包下的有限房间切源/空态防护/原权限与本地播控恢复。P2-native-process-handles-retained、完整内部 controller/listener 回收、窄端点房间权限与剩余 I/O/崩溃/session/seq 组合、真实 Windows 登录/锁屏/显示/Explorer 恢复、物理输入/声学、绝对资源预算/签名及缺设备的其他身份平台继续待验；八小时按用户优先级暂缓，完整非八小时验收/D3b 仍未完成。
