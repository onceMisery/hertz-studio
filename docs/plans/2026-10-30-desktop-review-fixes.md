# 桌面歌词 / DBX 审查修复记录

日期：2026-10-30。对用户提供的静态审查逐项核对后，修复以下实际问题。保留工作区原有改动。

## 已确认并修复

| 问题 | 修复后的行为 | 主要代码 |
| --- | --- | --- |
| 撤销与 connect 授权落盘竞态 | 临时文件准备完成后，在最终原子替换前持 gate 复核代际；已撤销的 connect 不提交授权 | `desktop_bridge/authorization.rs`、`lifecycle.rs`、IPC `windows.rs` |
| 请求 / 授权路径同步文件 I/O 阻塞异步线程 | 文件工作由调用方持有的 Windows worker 执行；取消时调用 `CancelSynchronousIo` 并回收线程后再释放槽位；文件阶段和锁等待检查取消 | IPC `blocking.rs`、`desktop_bridge/server.rs`、`lifecycle.rs` |
| connect 授权阶段未受总期限约束 | 检测、授权、管理请求共用剩余五秒期限，等待期间可取消 | `desktop/windows/connection.rs` |
| 单次 DBX 瞬态 / 无效快照立即清空内容 | 传输或数据格式失败只退避，由原生三秒新鲜度计时清除；授权 / 身份失效仍立即清除 | `hertz-desktop/src/dbx_feed.rs` |
| 独立版同 key 文档去重导致恢复后永久空白 | Feed 保留文档并随成功快照补发；原生只在同会话、曲目、key 已有文档时省略重复页面推送 | `hertz-desktop/src/feed.rs`、`app.rs` |
| 旧 key 可读取上一首 / 旧修订歌词 | 文档接口重新核对当前曲目、修订及偏移身份，不匹配返回 409 | `desktop_lyrics.rs` |
| 迟到的旧加载覆盖新文档 | 加载结果同时核对身份和任务序号，旧成功 / 失败均不能改变新缓存 | `desktop_lyrics.rs` |
| 本地快照每次同步 stat | sidecar 元信息在后台合并检查，间隔至少两秒；旧路径代际的结果不能覆盖新代际 | `desktop_lyrics.rs` |
| sidecar、HTTP 等先整读再限长 | 文件 / 响应先限制读取字节数；桌面歌词保留解析器限额错误并返回 `too_large` | `routes.rs`、`vmusic-lyrics`、`hertz-desktop/src/bridge.rs` |
| 独立版把响应到达时刻当新鲜度起点 | 歌词、壁纸使用实际请求 / 事件起点，已过期投递不重新获得完整寿命 | `hertz-desktop/src/app.rs` |
| show / locate 启用状态不保存；未绑定来源时设置丢失 | 启用操作安排保存；未绑定编辑合并进 `unboundStandalone`，保留迁移的旧偏好 | `hertz-desktop/src/app.rs`、`config.rs` |
| 旧 sidecar 会话使新 sidecar 误报在线 | 原生管理应答新增 `sourceSession`，门面要求它等于本次服务实例；字段缺失时保守返回未确认 | `management.rs`、`app.rs`、`desktop/windows/protocol.rs` |
| busy、路径别名、离线点路径、安装不完整的状态误判 | busy 可重试；活动来源按规范化身份比较；离线路径折叠点段；manifest 存在但 exe 缺失归为不兼容 | `desktop/windows/*`、`hertz-desktop/src/config.rs` |
| listener 失败留下发现文件 / writer；重复撤销错误覆盖已持久撤销事实 | listener 失败触发真实清理；失败重试保留已证明的持久撤销状态 | `desktop_bridge/lifecycle.rs` |
| 正常等待新会话被标记为错误 | “等待新快照”分类为 waiting | `hertz-desktop/src/app.rs` |

256 KiB 是原始歌词解析输入限额，2 MiB 是桌面序列化文档限额，两者不同。本次保留两者并正确报告超限。

## 原分析中没有作为当前缺陷修改的条目

- `Notify` 丢唤醒：误报。当前 Tokio 的 `notified()` 对创建后发生的 `notify_waiters()` 有保证，不要求先 poll 才能收到。
- 页面缺失 `lyricsControl` 时默认开放：正常生产路径始终下发该字段，DBX 原生还独立拒绝播控；未证实当前生产路径会缺失。
- 两 scope 未来协议版本独立升级：当前匹配构建均为 v1，保留为兼容性改进项；未声称已完成独立版本协商。
- 在线空歌词缓存刷新、壁纸尾音 / tap 边界、异常 worker 自动重启、跨 scope 重试策略：仍属条件性风险或策略问题，本次未以未经验证的推断修改。

## 验证

- `cargo test -p hertz-desktop --bin hertz-desktop --offline`：56 项。
- `cargo test -p hertz-studio --lib desktop --offline`：61 项；这是 desktop 相关筛选，非服务端全量测试。
- `cargo test -p hertz-desktop-ipc -p vmusic-lyrics --offline`：IPC 单元 19 + 集成 16；歌词解析单元 11 + 集成 4。
- 共 167 项通过，包括真实命名管道 / 同步读取取消、连接截止释放槽位、授权提交前撤销、listener 失败清理、同 key 恢复、旧任务隔离、超限读取和配置迁移。
- `cargo check -p hertz-desktop -p hertz-studio --offline` 和修改范围内的 `git diff --check` 通过。
- 未做真实桌面交互、慢 NAS / 文件系统过滤驱动、八小时长稳测试。`CancelSynchronousIo` 及最终原子替换仍受 Windows / 文件系统行为约束，不把测试结果解释为任意驱动故障下的硬实时保证。

## 后续非八小时验证

按用户要求继续验证当前 Windows 设备可执行的项目，八小时暂缓。冻结候选为 `output/dbx-desktop-d3/review-fixes-cleanup-1793328610061/`，与早期 `shutdown-barrier/` 分开记录，不继承旧包的完整验收结论。

- 原有 167 项专项测试通过；服务端 61 项在本候选重跑。先前失败的歌词文档用例另连续重跑五次通过。独立存储探针在二十次中十九次观察到 SQLx `close().await` 返回后仍有连接，立即删除 Windows 临时库失败；仅在 `cfg(test)` 清理中增加两秒内等待连接数归零，不修改生产代码或业务断言。初次清理修正的参数类型编译错误及此前删库失败日志均保留。
- Rust 1.88.0 对 `hertz-desktop`、`hertz-studio` 的全部 target 执行锁定依赖、离线、`-D warnings` 编译检查通过。
- 新 release 组件验包及 `--describe` 无配置副作用检查通过。四组真实 WebView2 原生检查通过：歌词、统一设置、持久化故障恢复、管理协议。歌词包含二十九次 Win32 样式/客户区观察、两种样式共十二轮设置开关及激活重绘；原生正常退出已由歌词专项记录，不将其他脚本的退出成功扩写为全部子进程正常回收。
- 已查看真实单行无边框和深色滚动条截图。歌词/设置/DBX renderer 浏览器回归通过；冻结副本的五皮肤设置入口、显式同意、撤销与部分失败、无启动检测/轮询，以及独立版原入口回归通过。浏览器夹具不代替真实 DBX 宿主。
- 当前宿主首轮历史包两版核心流程已通过，但驱动在 Full 新包验包结束前读取新清单，因文件未生成而停止；这次是驱动时序失败，记录保留，不能当作新包行为失败或完整图形对照通过。实际宿主正常退出，共用文件及原任务元数据保持。后续完整对照另行记录。
- 配套新包原 stdio 合同 Standard **314/314**、Full **298/298**；最低/当前 PluginHost、独立复算的 build 身份、未授权零桥文件/零原生配置检查通过。每版二十七项默认管道及撤销/播放/别名专项通过，默认组采样句柄差为零；播放专项另有句柄增长观察，未把这些有限采样宣称为完整资源回收资格。

完整图形对照第二轮实际发现 Standard 的曲库点击被 `.orbit-rig` 拦截。原报告为 `review-fixes-cleanup-1793328610061/gui-1793330148677/difference-after-standard-1793330351502.json`，维持失败；该轮 Full 新包流程尚未执行。真实宿主诊断确认新增的“情绪字体”入口占据星轨双列舞台的一个自动网格单元，歌曲信息与唱片落入不同排，唱片越出舞台进入曲库。主树仅为该入口增加 `grid-column: 1 / -1`，保留原入口、唱片交互与歌曲点击；不使用强制点击或放宽测试。临时 CSS 诊断只作定位证据，重新打包后的资格另行记录。

新冻结候选为 `output/dbx-desktop-d3/orbit-grid-1793331262051/`，相对前一候选只改变 `plugin/ui/skins/skin.orbit.css`。七十三项桌面组件输入完全相同，复用 SHA-256 `f224d9f0e3f961f0921a7e2f44717884dc2b7d296c1120c666226cbe2371cfbe` 的原准确组件；两版插件分别重建，不能沿用旧包的 UI 通过结论。

WebView2 复用目录的 Process 句柄累积仍未关闭，独立最小程序的复现记录见 D3 审计；本轮未以新目录通过或进程最终退出豁免该资源项。真实登录、自启、锁屏/断屏/Explorer 恢复、物理媒体键/鼠标穿透/托盘操作、声学、绝对资源发布预算、签名，以及其他用户/会话和 macOS/ARM64 仍须各自验收。完整非八小时验收与 D3b 尚未完成，“DBX 单独使用无行为变化”继续作为硬约束。

## 星轨修正后的准确新包复验

`orbit-grid-1793331262051/review-qualification.json` 汇总本轮限定通过结果，`executedQualificationPassed=true`，但 `completeNonEightHourAcceptance=false`、`d3bComplete=false`。最终重新计算主树、冻结副本与打包后输入，桌面七十三项、插件五百四十八项逐项一致；后者包含桌面输入，不能当作六百二十一项互不重复文件。

两版新包实际 SHA-256：Standard `4fa154f746efb9b3bf9ce5999de59b3c6c444506683a9c6cf4d63c4ae6595ae2`；Full `5835648d21f29ea50d8fe2a5b5f09ad1fa405b9a1ad82c5a0752c25172917080`。包内资源、校验和、PE、权限及发行版隔离验包通过。构建首次收尾因复用组件时漏复制 `native-built-source.json` 而在验包准备阶段失败；两版编译均已成功。记录保留在 `package-verifier-initial-failure.json`，补齐原样的历史原生构建快照并逐项核对桌面输入/准确 exe 后重跑验包通过，复用依据另存 `native-built-source-provenance.json`；未重建或冒称重建 native。

| 检查 | 本轮结果与范围 |
| --- | --- |
| 新包原 stdio 合同 | Standard **314/314**、Full **298/298**；两版真实 RPC、独立复算的 build 身份及未授权无桥文件/无原生配置通过。 |
| 真实 PluginHost | 最低 **0.6.35**、当前 **0.6.47** 两版运行时检查通过。 |
| 真实生产管道 | 每版默认二十七项、撤销/重启五项、播放/大文档五项、路径别名三项通过；默认及别名组句柄差零，播放组分别 **+8 / +6**，不判完整资源回收通过。 |
| 官方 DBX 图形差分 | `gui-1793332731950/comparison.json`：历史提交 `1d042b8` / 准确新包 × Standard / Full 四次流程全部通过。真实点击歌曲、播放/seek、队列、主题/定时器、关闭重开及 MediaSession 注册保持；新包星轨歌曲点击不再被唱片拦截，未使用强制点击。两版未授权均无新增桌面请求、桥文件或原生配置，gate/listenerReady=false。 |
| 退出与保全 | 本次官方宿主正常 exit=0，归属 PID+创建时间实例全部消失；全局 DBX 文件和原任务元数据保持。正常退出不豁免反复开关时的内部资源累积。 |
| 浏览器补充 | 准确冻结 UI 在 1440×1000、1000×800、640×800、390×844 实际歌曲点击与情绪字体对话框通过；五皮肤设置入口/独立版原入口通过。短曲名夹具未复现旧遮挡，旧问题的失败证据仍以真实宿主原报告为准。 |

已查看新包 Standard/Full 代表性真实宿主截图及准确 native 的深色滚动条截图。原生四组验证使用同一个未变化的 `f224d9f0…` exe，沿用各自原范围；没有把早期 `shutdown-barrier/` 的完整已授权联调、系统恢复或其他候选资格移给本批新包。

当前仍有实际开放问题 **`P2-native-process-handles-retained`**。此外，内部 controller/listener 完整回收及 I/O/崩溃/session/seq 故障矩阵、真实登录自启/锁屏/断屏/Explorer 恢复、物理媒体键/鼠标穿透/托盘找回、声学及绝对资源预算/正式签名未完成；真实其他用户/会话、macOS/ARM64 缺少环境。八小时按用户要求未启动，本轮通过不能表述为“除了八小时全部完成”。

## 已授权补验发现新鲜度清理越过期限

同一个 `orbit-grid-1793331262051/` 候选的 `authorized-1793333785518/authorized-comparison.json` **失败**，不能继续将该候选的全部已执行检查称为通过。先前 `review-qualification.json` 是补验前的有限结果，保留原文件和引用摘要，最新状态以本节为准。

本次两版实际同意授权、显式来源选择、首次默认关闭/单行/无边框、双 surface 同源显示及原生 DBX 工具条禁用已通过。两版已授权胶囊/展开、关闭工作台、主窗口最小化/恢复的原 sidecar 身份、播放和同源双 surface 也通过。随后 Standard 的停止/恢复专项在第一个 stop 场景失败：原生约 **3294.50ms** 才发送来源 waiting 与空快照，超过原 **3150ms** 门槛；新 Full 尚未执行这组生命周期检查。原歌词画面约 **1946.64ms** 已清空文字、壁纸约 **3004.97ms** 显示失效，不将可见清空和原生内部状态清理混作同一时刻。原失败和观察序列保留在 `final-authorized-lifecycle-1793333897677.json`。

源码确认宿主原来依赖 **500ms** 维护 ticker 检查三秒新鲜度，可能晚近半秒才清空内部 snapshot/document 与来源状态。修正只涉及 `crates/hertz-desktop/src/app.rs`：按歌词和 DBX 壁纸各自实际新鲜度截止时刻设置事件循环 `WaitUntil`；每次处理事件前清理过期数据；提前返回的无效事件也保留最近截止时刻；原 500ms 维护 ticker 和三秒阈值保持。独立 scope 与 request 起点不变，没有增加播放器、桥协议或 DBX 基础行为逻辑。

第一份修正构建 `source-expiry-1793334734429/` 在代码复核发现提前 return 会丢弃已安排截止时刻后，由代理终止准确归属的构建树；记录 `build-aborted.json`，不作资格产物。补齐提前 return 后冻结 **`source-expiry-1793334922641/`**，相对星轨候选仅上述 `app.rs` 改变。桌面输入指纹 `fef7f5598f9f7b386bf7e14f10f13b210c0535752b25a645fdee831e8f82ece5`；准确新 exe SHA-256 `9f21f7d70a79759fe05ee64b73f132978df7d261d9852d1c518ea60097cadaba`，build `51d392029ea981648560c9f26a95ab0615e7f4d6aa1a0aee2a32ab2a25452a35`。56 项原生单测及组件构建/验包通过，配套插件重建与相同门槛的真实已授权复验尚在进行，不预先计修正通过。

失败会话的 native/DBX 均正常退出，十九个归属 PID+创建时间实例全部消失；用户全局 DBX 文件及原任务元数据保持。原句柄累积问题不因这次退出成功关闭。八小时未启动，完整非八小时验收和 D3b 保持未完成。

`source-expiry-1793334922641/` 后续构建与配套验包完成，`build-result.json` 通过；Rust 1.88 全 target/锁定依赖/离线/`-D warnings` 通过。准确新包 Standard / Full SHA-256 分别为 `681b6e7d4cf0aeb2058789304721567412fce42b401eca50c913af69622a1146` / `ede2770a8264c40740c3082e97fa0172412c48a29a8f8c7711c08b442045611e`。原合同 314/314、298/298、两版最低/当前 PluginHost、真实 RPC/build 身份、默认/撤销/播放/路径别名生产管道均通过。默认组句柄差零，播放组 **+6 / +7** 继续保留资源限制。准确新 native 四组 WebView2 检查通过：歌词、统一设置、持久化故障恢复、管理 v2；它们不代替真实宿主联动。

首轮新包核心 GUI 对照在 `gui-1793335987153/` 失败：外层安装清单已指新包，嵌套差分驱动却仍读取星轨旧包清单，因已安装 binary 摘要不相等而在新包业务步骤前停止。实际 binary 摘要 `db3b0e34…` 与新 Standard 验包记录一致，不是安装错误或产品业务失败。旧驱动、原失败报告及 `core-path-correction.json` 保留，仅改嵌套清单路径并保持准确 binary 断言，完整对照在新隔离会话 `gui-1793336627999/` 重跑；结果另行记录，不覆盖首轮失败。

## 新鲜度修正候选的实际联调结果

`source-expiry-1793334922641/qualification.json` 已生成：`selectedRunsPassed=true`、`allHistoricalAttemptsPassed=false`、`completeNonEightHourAcceptance=false`、`d3bComplete=false`。三十七条直接证据引用包含准确构建/验包、协议、两轮实际宿主结果和旧失败；最终主树、冻结副本、native 构建及插件打包输入逐项相等。没有将此前 3.29 秒失败或首轮驱动失败改写为通过。

| 实际场景 | 结果 |
| --- | --- |
| 无授权核心图形差分 | `gui-1793336627999/comparison.json` 的历史/新包 × 两版四组通过；播放/seek、队列、主题/定时器、关闭重开及 MediaSession 注册保持，零新增桌面请求/桥文件/原生配置。十四个归属实例正常退出后消失，共用文件/原任务元数据保持。 |
| 两版授权与显式切源 | `authorized-1793337459156/authorized-comparison.json` 通过。实际同意不自动切换来源；首次 profile 两项默认关闭、歌词 single/bare；显式启用后歌词和壁纸同 session，原生 DBX 工具条禁用。 |
| 已授权 UI 生命周期 | 两版胶囊/展开、关闭工作台、DBX 最小化/恢复，原 sidecar PID+创建时间、播放及同源双 surface 保持。 |
| 原生伪造播控拒绝 | 两版播放/暂停两状态各 pause/play/seek，共十二次拒绝；原 track/generation/配置及播放意图保持。暂停后音乐频谱归零、环境动画继续。 |
| sidecar 停止/强杀/重启 | Standard 原生清空约 **2975.15 / 2896.87ms**；Full 约 **2986.47 / 3018.06ms**，均通过原 **3150ms** 门槛。独立启动的 native 存活，新 session 同 key 与相同文档恢复；原授权保持，重启不自行续播。 |
| native 先于 DBX 启动 | `host-lifecycle-1793337863542/report.json` 通过。按已保存 DBX 绑定先启动 native，歌词等待、壁纸无有效音乐数据；配置保持且没有自动拉起 DBX/sidecar。**手工验证启动顺序，不等于真实 Windows 登录自启。** |
| DBX 正常/强制退出与重启 | Standard 两种退出清空约 **2860.97 / 2864.46ms**，Full 约 **2951.31 / 2981.87ms**；原环境动画继续、组件存活。重启不自动播放，显式播放后新 session、同 key 歌词恢复。四次旧宿主进程树及最终宿主进程树均消失。 |
| 收尾与保全 | 已授权第一会话二十一个归属实例消失；宿主生命周期结束 native 正常 exit=0，九个归属 native 实例消失，最终无本批产品进程；全局 DBX 文件及原任务元数据保持。配置历史快照在后续显式切源前按原摘要保存，后续只改变明确选择和 revision。 |

真实 DBX Job 退出观察保持原边界：正常 DBX 退出后 sidecar 状态为 1，强制宿主退出时 sidecar 可为 0；四种场景都可能保留已终止 owner 的发现文件，新 owner 正确接管。**exit=0 不等于已执行有序 EOF**，不把 Job 终止误记成 controlled EOF 清理失败，也不豁免生产 EOF 专项原有“发现文件必须清除”的断言。

已查看新组件实际歌词/壁纸截图；离屏截图不证明物理鼠标穿透、声学或屏幕合成。索引首轮误要求 install/prepare-media 报告有顶层 `passed`，这些原报告实际是 `recordedAt/report` 数组；保持运行报告不变，改索引为逐版核对安装包摘要及未授权媒体准备状态，原失败另存 `qualification-index-initial-failure.json`。

**本轮修正通过的范围是上述准确候选与场景。** `P2-native-process-handles-retained` 仍 open；完整内部 controller/listener 资源回收、剩余故障交错、真实登录自启/锁屏/断屏/Explorer 恢复、物理输入/声学、绝对资源预算/签名和其他身份平台仍未完成，八小时未启动，完整验收状态继续保持未完成。

## 新鲜度候选的故障注入补验与运行时对照

接手被打断的一轮后，以下结论都绑定准确组件 SHA-256 `9f21f7d70a79759fe05ee64b73f132978df7d261d9852d1c518ea60097cadaba`（build `51d392029ea981648560c9f26a95ab0615e7f4d6aa1a0aee2a32ab2a25452a35`）与按同一冻结 IPC crate 重建的受控协议夹具 `6baebd08fedac6980e6e0a2baa13ecae9ad017fa1b871b851f92f874d29adf11`；夹具源码相对上一候选只增加逐 scope 协议版本注入，快照/文档语义未变（`native-faults-1793341204844/meta.json`）。安全校验、对端 PID 与期限保持开启。

| 补验 | 结果 |
| --- | --- |
| 数据管道故障十四项 | `output/playwright/desktop-native-feed-faults-1793341496160/report.json` **14/14 通过**。单侧持续 500 时该 scope 在 **2993.64 / 2995.19ms** 清空且另一 scope 继续更新；403 撤权分别在 **491.73 / 208.69ms** 立即失效且互不影响；瞬态 500 与畸形协议只退避、保留有效内容与 `key-NEW` 文档，恢复后同 key 歌词与壁纸序号继续推进（同 key 超时重取用例 **4885.97ms** 完成）。 |
| 管理通道异常三项 | `desktop-native-management-faults-1793341586792/report.json` 通过。丢弃原生 open-center 应答后可查询原状态并重试；**8 个**独立真实管理进程共用同一原生设置中心；不读取的持槽客户端未阻塞后续请求，**2327.17ms** 内由另一进程取回。期间原生按既有合同返回 **3 次** `control_busy` 瞬态忙，重试后成功，build 身份保持 `51d392…`。 |
| 壁纸渲染自愈两项 | `desktop-native-recovery-faults-1793341895852/report.json` 通过。归属渲染页崩溃后约 **12718.72ms** 自动重建并回到同 session/同来源；动画停转（ticks 133 → 134、draws 23 → 24 冻结）期间歌词仍 `playing=true`、未进入 buffering，约 **12244.53ms** 后重建。三组会话的原生/夹具均正常 exit=0，各 **11 个**归属 PID+创建时间实例消失、无残留，共用原生配置逐字节未变。 |

数据管道首轮 `desktop-native-feed-faults-1793341394247/report.json` **保持失败**：驱动补丁插入位置错误，第一个用例即 `0 !== 2` 停止，收尾又暴露 `processInventory is not defined`，因此那轮未执行业务断言也不计入通过；修正插入点后以准确组件与重建夹具完整重跑。三组结论只覆盖受控协议夹具下的这些场景，不代替真实 DBX 快照、真实登录/锁屏/断屏/Explorer 恢复或物理输入。

WebView2 运行时版本对照已完成并判定**不支持降级/钉版本作为修复**：`output/dbx-desktop-d3/webview2-minimal-probe/runs/runtime-contrast-1793339944515/report.json` 用支持的 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 在隔离目录中分别跑本机 **155.0.4283.62**（运行时 SHA `93acbcad…`）与 **156.0.4314.50**（`3dee67d8…`），驱动断言全部浏览器进程的 `ExecutablePath` 确实等于所选运行时。两版结果一致：全新 profile 首个生命周期十轮 Process 增量 **0**（8 → 8），同 profile 第二个生命周期十轮均为 **+10**（9 → 19），六十秒消息泵送冷却后不释放；`productChanged=false`、`diagnosticOnly=true`，每阶段八个归属实例正常退出、无残留。这只证明现象不是 155 → 156 的版本回归，不能定位内部持有代码，也不构成释放方案或产品资源资格。**`P2-native-process-handles-retained` 继续 open。**

只读 Authenticode 复核 `native-faults-1793341204844/native-authenticode.json`：准确 native `hertz-desktop.exe` 状态为 **NotSigned**、无签名者，`signedDistributionQualified=false`。这是发布签名/绝对资源预算缺口的新证据，未据此改动产品，也不把它算作 DBX Store 包签名资格。

主树输入重新指纹核对（`main-observed-takeover-1793342578.json`）：当前工作树的桌面 **73 项** `fef7f5598f9f7b386bf7e14f10f13b210c0535752b25a645fdee831e8f82ece5` 与插件 **548 项** `fa7cbb9d463fbf873c9ec318e45710af02dff876480db673ffc0761821235997` 与已验证候选逐项相等；工作区内其他任务的非输入改动保留，资格仍只归上述准确冻结产物。

## 窄 HTTP 播控端点的房间权限路径

审计原先记录“房间没有本地桌面 track，所以九次播控没进入窄 HTTP 播控端点；该端点的房间权限路径仍未验”。本轮用从**冻结候选源码**构建的独立 Standard 服务补上：`standalone/standard/built.json` 记录服务二进制 `d175937112358f705295000a0f10c85c40238c06b1ffbd280f9a862f998e204b`、build `51d392…`、rustc 1.98.1、548 项冻结输入逐项校验通过，配套 native 仍为 `9f21f7d7…`。场景是**两个真实服务进程 + 真实 loopback TLS 房间**（房主 share/invite、访客 join，权限全 false），不含 DBX 宿主与原生 surface。证据绑定见 `source-expiry-1793334922641/narrow-room-qualification.json`，原始报告 `output/playwright/dbx-desktop-expiry-narrow-room-1793344050782/report.json`。

| 用例 | 实际结果 |
| --- | --- |
| 建房前窄端点确实可用 | 同一把 `Desktop` 钥匙、同一具身结构，`play` / `pause` 各 **200** 落地，`/v1/state.playing` 实际转真再转假，曲目代际推进。 |
| 房主房间中窄端点被拒 | 接管把房主本地投影清空、代际 **4 → 5**；按建房前身份提交 `play` / `pause` / `seek` 共三次，全部 **409 `stale_playback`**，代际不再增加、`playing` 保持 false。 |
| 无 transport 权限访客 | 同样三次 **409 `stale_playback`**（代际 **2 → 3** 只来自接管）。 |
| 授予 transport 后访客 | 房间层命令实际受理（**200 / `state=no_op`**），但窄端点三次仍 **409**——房间权限不会打开这条路径。 |
| 双方离房后恢复 | 重新 load 后 `play` / `pause` 再次 **200** 生效，证明前面的拒绝来自房间态而非钥匙失效。 |

判别要点：`ModeLease::enter`（`crates/hertz-studio/src/room/manager.rs:122`）无条件 `acquire_exclusive()`，而 `EnterExclusive` 会清空 `track_id` 并把代际 +1（`crates/vmusic-audio/src/actor.rs:493`）。因此房间激活时窄端点先撞上 `routes.rs:760` 的身份闸门（409），`require_local_playback()` 的 `room_mode_requires_room_command` 分支在其后，只能经宽端点观察到——同轮交叉核对里 `/v1/player/play` 返回 **400 `bad_request`，message 含 `room_mode_requires_room_command`**。这条顺序是既有实现，本轮只补真实流量证据，**未改产品代码**。

驱动三次缺陷保留且不改写为通过：`…1793343892954` 把房间反压 **422 `room_reconnecting`** 当致命错误；`…1793343975637` 重试助手只回传 body 导致已 **200 / `no_op`** 的授权结果被误判缺 status；`…1793344016299` 在离房用例把 `{status,body}` 当快照体传入。驱动 SHA 依次为 `87d9d033…` → `b2fb2d78…` → `4662cdc8…` → 通过版 `5bfbfd0b…`，初版副本存 `verify-expiry-narrow-room-guard.initial.js`；最终一轮记录 **4 次**瞬时重连重试。两个服务均 exit=0，**2 个**归属 PID+创建时间实例消失、无残留。范围仍有限：不覆盖真实 DBX 宿主内的原生播控、物理输入与声学，也不改变 `P2-native-process-handles-retained` open、完整非八小时验收与 D3b 未完成、八小时未启动。

## 跨 scope 延迟隔离补验

按用户选择继续只推不打断的项目，新增一项交错：**歌词文档回复被拖慢时，壁纸 scope 必须照常出帧**。仍用既有夹具旋钮（`documentDelayMs`、`track`、逐 scope 强制 seq），未改产品。绑定与全部失败尝试见 `source-expiry-1793334922641/latency-isolation-qualification.json`，原始报告 `output/playwright/desktop-native-feed-faults-1793352435361/report.json`；组件 `9f21f7d7…`、夹具 `6baebd08…` 与前文一致。

在文档请求实际在途窗口内（夹具记录该次 lyrics document 请求 `delayMs=1600`），壁纸 feed 序号从 **85 推进到 90**（采样 12 点、**6 个**不同序号），窗口内完成 **7 次**壁纸应答（采样循环内 5 次），`wallpaper.debug.valid` 与两个 scope 的 `sourceScopes` 全程为真；循环结束时文档仍为 null（确实仍在途），最终 `key-LATslow` 实际落到页面。原生/夹具均 exit=0，**11 个**归属实例消失、共用配置逐字节未变。

同一轮把三条判据边界量清楚，避免后再踩：`2500ms` 延迟**超过原生两秒文档期限**，会走既有的超时重取而不是落地（`…1793352299317` 保留为失败）；“从改状态到落页”**不能当作请求起点**，它包含快照轮询与派单，实测 2559–2606ms（`…1793352374995` 保留为失败）；基线 key 不能假定为 `key-A`，前一用例留下的 track 会改变它（前两轮失败保留）。五次驱动缺陷均为量尺/预期构造错误，未放宽任何产品门槛，也未把失败改写为通过。该项只覆盖单侧文档延迟与另一侧隔离，不代表完整 I/O/崩溃/session/seq 矩阵完成；`P2` 与签名缺口不变。

## 真实 Explorer 重启与断屏恢复

用户授权占用桌面后，按最小干扰顺序先做可自愈的两项。准确 native `9f21f7d7…` + 受控夹具 `6baebd08…`，隔离 `HERTZ_DESKTOP_CONFIG_DIR` 与 WebView2 目录；证据绑定 `source-expiry-1793334922641/system-recovery-qualification.json`，原始报告 `output/playwright/dbx-desktop-expiry-system-recovery-1793359024398/report.json`。三项目全部通过：

- **Explorer 真重启**：`tools/desktop-probe/restart-explorer.ps1` 报告 shell PID `17168 → 6992`、任务栏重建；宿主进程未退出（PID+创建时间与基线相同，`exitCode=null`，收尾 exit=0）。`desktop.log` 依次出现 `wallpaper recovery begin attempt=1` → `success attempt=1`，**失败恢复 0 次、terminal 分支 0 次**，`wallpaper page dom ready`/`mounted` 由 1 次增至 2 次。窗口层级取证：壁纸窗重新挂到 **WorkerW** 子层，且 HWND 与重启前不同（`reparentedToNewWindow=true`），说明是新 shell 的重挂而不是残留在死壳上。
- **重启期间数据连续性**：歌词应答 **+10**、壁纸应答 **+21**，歌词页文本仍为 `DOCUMENT INITIAL`，壁纸 `valid/ticks/draws` 在重建后继续。
- **断屏再唤醒**：`monitor-off.ps1 -OffSeconds 6` 期间宿主存活（进程数仍为 1），歌词 **+16**、壁纸 **+31** 应答继续，唤醒后壁纸仍出有效帧、歌词文本未变，未触发新的恢复分支。

取证本身的四个坑已钉进驱动判据，不能沿用错误形状：壁纸窗是 **WorkerW 的子窗**，WorkerW 本身不是顶层窗口，`EnumWindows` 直接按 PID 找顶层会看见 `Progman`（遍历根，不是真实父窗），必须用 `GetParent` 取类名；`GetWindowRect` 在 DPI-unaware 的 PowerShell 里返回**逻辑坐标**（本机 2560×1600@150% 为 1707×1067），因此不能拿物理分辨率当阈值；`desktop-component.json` 的 `file` 只是文件名，绝对路径须自己拼并校验 SHA；恢复会**重建壁纸 WebView2**，旧 CDP page 句柄按设计失效（先记录其确实关闭，再重新解析新页）。七次失败尝试（含一次驱动在启动宿主前就崩溃、未写出任何报告）原样保留在记录的 `failedAttemptsRetained`。

**仍未完成**：注销自启需要你在场（注销会终止本次会话和代理），物理媒体键/托盘、声学与绝对发布预算/签名照原样保留；`P2-native-process-handles-retained` 仍 open，八小时未启动，完整非八小时验收与 D3b 未完成。

## 真实锁屏恢复

同一驱动加锁屏用例后重跑，四项一起通过：`output/playwright/dbx-desktop-expiry-system-recovery-1793363296861/report.json`，绑定 `source-expiry-1793334922641/lock-recovery-qualification.json`（含前序 8 次失败轮的原报告与摘要）。准确 native `9f21f7d7…`、夹具 `6baebd08…`、隔离配置目录不变。

- **锁屏确实发生**：`LockWorkStation()` 返回 `True`，`LogonUI` 进程数出现为 1；含 20 秒锁内采样在内实际锁住 22 秒，由用户本人输入凭据解锁（等待预算 480 秒未用满）。
- **锁内宿主与数据都活着**：`hertz-desktop.exe` 进程数保持 1，壁纸窗仍在 **WorkerW** 子层且 HWND 与锁屏前**同一个**（`sameWindowAsLocked=true`）——说明锁屏不需要 surface 重建，与 Explorer 重启那条路径不同；锁内歌词应答 **+44**、壁纸 **+88**，未出现任何 `wallpaper recovery fail`。
- **解锁后可见态正常**：进程数仍 1、同一 WorkerW 子层继续绘制（ticks 2250 / draws 380 / `valid=true`、scene `coast`），歌词页文本保持 `DOCUMENT INITIAL`；解锁后又继续各 +10 / +19 应答。整轮日志里的恢复记录只有**同一次 Explorer 重启**留下的 `begin attempt=1 / success attempt=1`，锁屏没有新增恢复分支。
- **同轮重复确认**：Explorer 真重启（shell `6992 → 3400,3964`、`dom ready`/`mounted` 1→2、重挂到新 HWND、失败与 terminal 分支各 0）与断屏 6 秒（应答 +10/+21，唤醒后有效帧继续）在新一次运行里再次通过；原生与夹具均 exit=0，归属进程零残留，`config.json` 逐字节未变。

这一项只覆盖**本会话的锁屏**：不是注销/重新登录、不是另一个用户会话，也不证明息屏下的显示器唤醒时序之外的电源状态（睡眠/休眠）行为。`launchAtLogin` 的真实登录自启仍待你注销一次；`P2-native-process-handles-retained`、签名（native 实测 NotSigned）、物理媒体键/托盘、声学、绝对资源预算、八小时与 D3b 全部保持原状未完成。

## P2 句柄保留定位到 controller 创建/关闭这一对调用

先清掉上一轮遗留：`--settings` 实例 PID **13996** 已用 `CloseMainWindow` 正常退出（未加 `/F`），之后 `hertz-desktop.exe` 进程数 0，HKCU `Run\HertzDesktop` 仍为空，真实配置 `launchAtLogin=False`、`revision=49` 未被这轮改动。

句柄项此前只能说到「跟着复用目录走、多余句柄指向活的 NetworkService，内部机制未隔离」。本轮把变量放进**独立探针**（`output/dbx-desktop-d3/webview2-minimal-probe`，只有 `webview2-com 0.39.1` + `windows 0.62.2`，不含 Wry/Tao/Hertz/DBX、无自定义协议/来源数据/网络服务/浏览器自动化）逐一隔开，五种周期模式共用同一次构建（探针 exe SHA-256 `105d8e27909f…`、源码 `e74cb4a66028…`、驱动 `8d799ca6a704…`），每种都是「冷目录一次生命周期 + 同目录再来一次」× 十周期 × 0/10/20/30 秒冷却：

| 模式（一个周期做什么） | 冷目录 | 复用目录 | 保留句柄目标 |
| --- | --- | --- | --- |
| 建窗口 + 建 controller + 导航到完成 + `Close` | 8 → 8 | 9 → **19** | 活的 `utility network.mojom.NetworkService` |
| 同一窗口上反复建/关 controller ×10 | 8 → 8 | 9 → **19** | 同上 |
| 建窗口 + 建 controller + `Close`，**不导航** | 8 → 16 | 9 → 22 | 多数同上，量级在两版构建间浮动 |
| 一个 controller 上导航十次 | 8 → 8 | 9 → **10** | 同上 |
| 只泵消息 600ms，不建窗口不建 controller | 8 → 8 | 9 → **9** | 无 |

判别结论：**每次 `CreateCoreWebView2Controller` + `Close` 保留一个句柄**。不是按导航（一个 controller 上十次导航只留 1）、不是按窗口（一个窗口上十个 controller 仍留 10）、也不是按时间或泵消息（负对照每周期墙钟 656ms 比参照组 364ms 更长却零增长）。条件是**复用 user-data 目录**：冷目录里同一个 controller 关掉后句柄全部回到基线——所以缺陷形状是「复用目录条件下的释放路径」，不是「每次创建多分配一个」。跳过导航并不能变便宜（不导航 ≥ 参照组），这些变体里没有更省创建路径。冷却序列在每个模式下都是平的，探针仍 exit=0 且八个归属实例全部消失，句柄只在进程退出时才回收。

同一矩阵在上一版探针二进制（`ce6a3d9ff85d…`）上跑过其中四组并复现同样的 0/10、0/1、0/0；只有「不导航」那组量级在两版间是 +3/+8（冷）与 +14/+13（复用），因此记录里只对它的**符号**和**不优于参照组**下断言，没把浮动数字写成稳定值。断言与逐条非结论由 `record-minimal-attribution.js` 从五份原始报告重算生成 `webview2-minimal-probe/lifecycle-call-attribution.json`。

产品侧对应关系：`crates/hertz-desktop/src/app.rs` 每次歌词/设置/壁纸 surface 建一个 WebView；`close_settings`→`open_settings`（app.rs:925-945）与 `recover_wallpaper`（app.rs:811-825）都是先 drop 再重建，设置里的预览共用设置的 WebView 不额外建 controller。**这条「每次重开设置约累积一个句柄」的推演已被后续实测否掉**——设置路径量到净零，只有壁纸重建路径 1:1 累积，见下一节；此处保留原始推断与被否的经过，不改写为「一开始就正确」。

## 产品上量到的两条重建路径：壁纸 1:1 累积、设置净零

把探针的结论搬到真实组件上量（准确 native `9f21f7d7…`，任务独占 `HERTZ_DESKTOP_CONFIG_DIR`，standalone 无来源无授权；**组件会自己把 `WEBVIEW2_USER_DATA_FOLDER` 改成 `<config>/webview2`**，app.rs:2934-2935，所以冷/复用两档由同一个 config 目录跨两次生命周期控制）。每档都是「生命周期一：目录还没有 → 跑 N 次重建 → quit；生命周期二：新进程落在同一目录上 → 再跑 N 次」，句柄读数沿用既有只读 duplicate-and-close 采样器，目标角色按 `--type`/`--utility-sub-type` 解析。

| 形状 | 一周期的含义 | 冷目录 | 复用目录 | 60 秒空闲 |
| --- | --- | --- | --- | --- |
| `wallpaper-recreate` ×50 | 管理通道 `wallpaper-apply` 真→等 pageReady→假：壁纸 WebView2 surface 销毁再重建，无 CDP 无调试端口 | 15 全程不动，**+0** | 16→26→36→46→56→**66**（10/20/30/40/50 周期 = +10/+20/+30/+40/+50） | 66/66/66/66 不释放 |
| `settings-reopen` ×20 | 页面里真点「关闭」销毁设置 surface，再由 `open-center` 重建（CDP page target 消失再出现，证明确实是销毁不是隐藏） | 15 全程不动，**+0** | **15→15，净 0** | 15/15/15/15 |

复用目录里壁纸保留的 50 个句柄**全部落在同一个活的 `utility network.mojom.NetworkService` 上**；两次生命周期 native 都 exit=0、八个归属实例全部消失。设置档的对称差分解释了它为什么净零：被关闭页面的 renderer 释放 3 个句柄、重开后新 renderer PID 取走 3 个，NetworkService 那一栏从头到尾没变——**报告里原始 `targetDelta` 只遍历末态，会把消失的 PID 漏成「没有负项」**，成档脚本改成用基线与末态两张表对称重算。

因此探针那句「每次 controller 创建/关闭保留一个」是**必要但不充分**：同为复用目录、同一份组件，壁纸重建累积而设置重建不累积。两者的差别（壁纸页有持续 rAF 绘制与频谱喂数、挂在 WorkerW 上、销毁前页面已完全活）这几轮**没有隔离**。会话内的累积仍然有界：壁纸恢复本身受既有预算约束（120 秒窗口三次后 terminal），且所有句柄在进程退出时归还。

留档 `source-expiry-1793334922641/surface-recreation-attrition.json`（由 `record-expiry-surface-attrition.js` 从两跑原始报告带断言重算）。两次失败尝试原样保留：`failed-folder-precondition-product-recreation-1793373467514`（把冷/复用判据押在组件根本没用到的 `output/webview2` 上，量数其实复现了 0/+50）、`dbx-desktop-product-recreation-1793374177288`（基线采样撞在暖机销毁未完成时导致 -1，且归属树 20 秒窗口不够——native exit=0 后浏览器根进程与 crashpad 活得比这更久；已改基线前沉降 4 秒、收尾窗口 90 秒并记录实际耗时，重跑后 1.9/0.6 秒清空）。本轮**产品代码零改动**，未清用户目录、未发上游。

`P2-native-process-handles-retained` 仍 open：没有受支持的释放/修复方案，未定位 WebView2 内部持有者，也未隔离壁纸与设置两条路径的分界；注销自启、物理媒体键/托盘、声学、绝对资源预算与签名（native 实测 NotSigned）、八小时与 D3b 全部照原样未完成。

## 累积绑在创建本身：fast 变体与 CDP 参照

接上一节的问题——壁纸重建那一个句柄，是绑在「controller 被创建过」还是绑在「页面真的活起来/画过帧」。给驱动加两种形状，并把壁纸页 URL（`hertz://localhost/wallpaper.html`，app.rs:3623）用 CDP target 计数变成可证条件：**每个周期都断言「确实观察到一个壁纸 page target 出现」再拆掉它**，这样零结果不能藏住「其实什么都没创建」。

| 形状 | 拆除时机 | 冷目录 | 复用目录 | 保留目标 |
| --- | --- | --- | --- | --- |
| `wallpaper-recreate-fast-cdp` ×10 | page target 一出现就拆，**十个周期全部没等到 pageReady** | 15 不动 **+0** | 16→**26** = **+10** | 全部在活的 `utility network.mojom.NetworkService` |
| `wallpaper-recreate-cdp` ×50（CDP 参照） | 等 pageReady 再拆（同无插桩参照） | 15 不动 **+0** | 16→26→…→**66** = **+50**，60 秒空闲 66/66/66/66 | 同上，delta 50 |

结论：**累积是创建绑定的**，页面就绪与画帧都不是前提。而 CDP 参照的 +50 与无插桩参照的 +50 逐位相同，说明调试端口与 target 计数既不制造也不掩盖这个增长，fast 档的数字可以和参照档放在同一把量尺上比。原计划的「ready 后再多留 3 秒绘制」变体**判为冗余没跑**：fast 档已经否掉「就绪/画帧」这条，加 dwell 不可能把创建绑定的开销变成页面寿命绑定的开销。

设置档仍不累积，而「壁纸用了自定义协议环境、设置没用」这个猜测被读码否掉：`create_settings` 同样 `with_custom_protocol(WALLPAPER_PROTOCOL)` 并 `with_url("hertz://localhost/settings.html")`（app.rs:3551、3571），与壁纸共用同一个 `hertz` 方案（app.rs:3621）。剩下没隔离的差别是壁纸窗的 WorkerW 重挂与分层/透明样式、不透明背景色、150% DPI 下的 `zoom()` 调用，以及页面持续动画喂频谱；要再切一刀，要么把独立探针做成壁纸窗那种形状，要么动产品代码做二分——这两件本轮都没做（探针仍只有 `NavigateToString`/`create_controller` 形状，产品代码零改动）。留档 `source-expiry-1793334922641/surface-recreation-isolation.json`（`record-expiry-recreation-isolation.js` 从两跑原始报告带断言重算，逐周期记录 `pageReady` 与 `wallpaperTargetsSeen`）。

**一次差点被我误判成产品卡死**：CDP 参照头两跑分别在第 30、第 12 周期抛 `connect ENOENT \\.pipe\hertz-desktop-control-…`，我当场判成「管理通道失联、宿主可能卡死」，并给驱动加了卡死取证。取证反而否掉了这个说法：抛错之后宿主还连续记了三次 `control command=status`（120.4/120.8/120.9 秒），事件循环在跑、进程活着（最后是驱动 kill 的），失联点在**驱动自己**——我把 `wallpaper-apply` 提交绕过 `cmd()` 直发，少了 pre-connect ENOENT 重试，而这个战役早就记过「listener 每次 accept 后重建管道实例，connect 可能落进空档」这个同款陷阱。补上只重试 pre-connect ENOENT 后参照档完整跑通并给出 +50。取证脚本另修了一处：`Add-Type` 的 C# 不接受 `out _` 弃元，首三轮诊断全空。留档的失败轮：`wedged-cdp-control-1793376103236`、`wedged-enoent-no-retry-1793376316958`（含 `wedge-lifetime-0.json` 的原始诊断），以及修订号竞态轮 `…1793375746526`（复用档首个 `wallpaper-apply` 被 `wallpaper_apply_failed`「设置已在其他位置变化」拒绝——闸门按设计工作，是驱动没重试）和信封写错轮 `…1793375859823`（`invalid_value`）。

`P2-native-process-handles-retained` 依旧 open：创建绑定已证，内部持有者与释放方案未知；注销自启后半、物理媒体键/托盘/鼠标穿透、声学、绝对资源发布预算与签名、八小时与 D3b、其他身份与 macOS/ARM64 全部原样保留。产品代码本轮零改动。

以上三段（探针到调用级、产品两条重建路径、创建绑定与 fast/CDP 对照）都只到定位：**没有产品代码改动、没有产品构建、没有清用户目录、没有发上游**。注销自启、物理媒体键/托盘、声学、绝对资源预算与签名、八小时与 D3b 全部保持原状。

## 绘制与帧率也排掉了

「壁纸页在持续动画喂频谱、设置页不画」曾是壁纸 vs 设置分界的头号嫌疑。在同一个探针二进制（`a007a60a29cf…`、源码 `b6673047cbab…`）里只改「拆除前页面画了几帧、画多快」：页面每画一帧就经 WebView2 消息通道回报，探针收到指定帧数后才 `Close`，帧数是**实测**不是假定。

| 模式（10 周期，冷/复用两档） | 拆除前帧数 | 复用档 | 周期墙钟 |
| --- | --- | --- | --- |
| `draw-0` | 不等任何帧 | 9 → 19 = **+10** | 203ms |
| `draw-1` | 1 帧 | **+10** | 209ms |
| `draw-30` | 30 帧（满帧率） | **+10** | 385ms |
| `draw-30-slow` | 同样 30 帧，门控到约 10fps | **+10** | 3268ms |

四档冷目录全部 0，复用档全部 +10，且增量全落在活的 `utility network.mojom.NetworkService` 上；帧率轴确实被走到——同样 30 帧慢档比满帧率慢 **8.5 倍**（3268ms vs 385ms/周期），结果一模一样。所以**绘制数量与帧率都不是触发条件**，成本只跟创建次数走。留档 `webview2-minimal-probe/frame-and-rate-attribution.json`（`record-frame-attribution.js` 从四份原始报告带断言重算，逐周期帧数入档）。

这条同时削弱了「页面必须活着」那类解释：壁纸 vs 设置的差别只剩**窗形**——WorkerW 重挂与分层/透明样式、不透明背景色、150% DPI 的 `zoom()` 调用。要再切就必须加厚探针到壁纸窗形状（关工坊/WorkerW 父窗之后建 controller），或动产品代码做二分；本轮都没做。

## 窗形三档：背景色与 zoom 都不改变结论，WorkerW 撞上探针宿主限制

按上一节的计划把探针加厚。新形状档用自注册窗口类建无边框 `WS_POPUP`（比老档的 STATIC 窗更接近产品的 tao 窗），逐项只加一个壁纸属性（探针 exe `e9db54fa7d88…`）：

| 形状 | 加了什么 | 冷目录 | 复用目录（10 周期） | 目标 |
| --- | --- | --- | --- | --- |
| `shape-plain` | 什么都不加（同窗形对照） | +0 | **+10** | 活的 `utility network.mojom.NetworkService` |
| `shape-background` | `SetDefaultBackgroundColor(3,4,5,255)` | +0 | **+8** | 同上 |
| `shape-zoom` | 导航后 `SetZoomFactor(1.5)` | +0 | **+9** | 同上 |

结论：**不透明背景色和 DPI zoom 都不抑制保留**，窗类换成自注册 `WS_POPUP` 也不改变（对照仍是 10）。参考档历来是「十次创建正好 +10」，这三档量到 10/8/9；两个偏少的差都是单个句柄，**按实测记录、没有抹平成 10**，且没有任何一档掉到 0。

**WorkerW 托管这条撞上了探针自身的限制，不是产品结论**：按产品顺序（先重挂到 WorkerW 再建 controller）第一个周期就报 `0x8007139F`（`ERROR_INVALID_STATE`）；改成「先建 controller 再重挂」之后，**第 1 个周期能过、第 2 个周期同一进程里再次 `CreateCoreWebView2Controller` 就报同一个 HRESULT**。而产品在同一进程里连续做了 50 次 WorkerW 托管重建（见 `surface-recreation-attrition.json`）——所以破裂点是这个最小宿主，不是产品。原始证据（含退出码与错误行）留档在 `webview2-minimal-probe/runs/workerw-hosting-limit/`，结论汇总在 `webview2-minimal-probe/window-shape-attribution.json`（`record-shape-attribution.js` 带断言重算：1 周期必须成功、2 周期必须带着该 HRESULT 失败）。

**因此壁纸 vs 设置的分界仍然只剩 WorkerW 托管这一项没测到**。要关掉它只有两条路：一是让宿主忠实地复刻产品窗（tao 窗口 + wry controller，而不是最小 COM 探针），二是在产品代码里做二分（如临时把壁纸窗改成不挂 WorkerW 的顶层窗跑同一组重建）。两条都会改变「零产品改动」这条约束或至少要一个新宿主，本轮到此为止；`P2-native-process-handles-retained` 保持 open。

## WorkerW 托管不是触发点（诊断构建二分）

按上一节第二条路做了一次**诊断构建二分**：从冻结候选源码复制一份（排除 `target/`、`output/`）到 `output/dbx-desktop-d3/diag-skip-workerw-1793413000000/`，**只改一处**——`crates/hertz-desktop/src/app.rs:3482` 把 `native::mount_wallpaper(hwnd, &monitor)?` 包进 `std::env::var_os("HERTZ_DIAG_SKIP_WORKERW")` 判断，走跳过分支时记一行 `diagnostic: skip WorkerW mount`。同一份源码、同一条构建命令（`cargo +stable build --offline --locked --release -p hertz-desktop --target x86_64-pc-windows-msvc`，2m18s），得到诊断 exe `f631a6e3fe907c2174b34f799b0e5a96f964520fbc1f001e6204d65b4f258adc`。**冻结候选与工作区产品代码都没动**，诊断件不参与任何候选或发布资格。

同一驱动、同一形状（`wallpaper-apply` 真→等 pageReady→假 ×50 × 冷/复用两档），唯一差别是那个环境变量：

| 条件 | 冷目录 | 复用目录 | 60 秒空闲 | 目标 |
| --- | --- | --- | --- | --- |
| A 照常挂 WorkerW（对照） | 15 全程不动 **+0** | 16→26→36→46→56→**66** = **+50** | 66/66/66/66 | 活的 `NetworkService`，delta 50 |
| B 跳过挂载（诊断分支） | 15→29 **+14** | 16→30→41→54→66→**79** = **+63** | 79/79/79/79 | 活的 `NetworkService` delta **60**，另 3 个已退出目标各 +1 |

开关确实生效：A 的 `desktop.log` 里 `diagnostic: skip WorkerW mount` 出现 **0** 次，B 出现 **122** 次；两档各有 102/122 次 surface 创建记录，两跑都 exit=0、八个归属实例清空。

**结论：WorkerW 托管不是触发点**——照常挂载的对照组精确复现候选的 +50，跳过挂载不但没归零，反而更多（+63，冷档还多出 +14，说明顶层隐藏窗这条路径另有额外持有）。所以「壁纸挂到桌面层」这个形状可以排除，`P2` 也不能靠改挂载方式来修；同时它把「跳过挂载能省」这个直觉也否掉了。

剩下最像的差别转向**页面在拆除时的网络状态**：句柄目标一直是 NetworkService，而壁纸页会连一条持续的事件流（日志里的 `wallpaper events connected seq=…`），设置页走的是普通管理请求。这条还没测，探针要加「页面持有一条持续连接再拆除」的形状才能验。留档 `diag-skip-workerw-1793413000000/workerw-bisect.json`（`record-workerw-bisect.js` 带断言重算：对照组必须恰好 +50、跳过档的日志必须出现 122 次分支、两跑退出码与归属清空；另记录两跑冷档差异，不抹平）。诊断构建目录含 664MB `target/`，需要回收时删掉整个 `diag-skip-workerw-…/` 即可（记录里的哈希与补丁文本足以重建）。

## 连接状态、同环境兄弟与设置销毁形状：三条都排掉

WorkerW 被否掉后，剩下的候选里最像的是「拆除时页面挂着一条连接」（句柄目标始终是 NetworkService，而壁纸页有持续事件流）。这一轮把它和另外两条一起量了：

- **设置重建确实是销毁重建**：之前判据只看 URL 里还有没有 `/settings.html`，而页面导航到 `about:blank` 也能满足它。改用 CDP target **数量**复核：关闭后 **2 → 1**、重开后 **1 → 2**，所以设置 WebView 每周期真的被销毁重建，早先那条「设置净零」的对照成立（`playwright/dbx-desktop-settings-close-shape-1793417364405/report.json`）。
- **拆除时的连接状态不是触发条件**：探针每周期先起一个 loopback 监听、让页面发一个请求、等服务端确认收到后再拆。`net-open`（读到请求但永不回应，拆除时 socket 仍开着）复用档 **+10**；`net-closed`（回应、shutdown 后再拆）同样 **+10**，两档冷目录都 +0，增量都在活的 NetworkService 上。每周期都记录了 accepted=1 与拆除时的 socket 状态，不是假定。
- **同环境里有没有壁纸也不是原因**：让一个壁纸 surface 整轮保持启用，再跑设置关闭/重开 ×20 × 冷/复用——复用档 **21 全程不动、净 0**（只有一组 renderer 替换的对称抵消）。所以「谁先建的环境」「同环境里几个 surface」都不解释分界。

三条合起来把问题收窄到壁纸 surface **自己**的拆除路径。还没测的候选只剩：wry 里两条 drop 路径的时序差异（设置是由页面发起的关闭链里 drop，壁纸是由管理 apply 链里 drop）、壁纸 surface 参与的周期求值/页时钟触发点、以及壁纸页本身（1.7MB 文档 + 事件流经自定义协议，探针只复刻了单次 loopback 请求）。要再往下走，要么写一个基于 wry 的探针忠实复刻两条 drop 路径，要么给产品加临时插桩——都比到目前为止的测量重，本轮到此为止。

留档 `source-expiry-1793334922641/settings-rebuild-isolation.json`（`record-settings-rebuild-isolation.js` 带断言重算：销毁形状必须 2→1→2、兄弟档必须净 0；连接状态档在 `webview2-minimal-probe/network-state-attribution.json`，两档必须各 +10）。产品代码零改动、冻结候选未动、无残留进程。`P2-native-process-handles-retained` 仍 open。

## 故障矩阵第二批，以及一次空转证据的订正

接手后先补三条能用现有夹具、零产品改动的交错：**迟于新鲜度期限的回复**、**双 scope 同时 500**、**连续两次切曲**。写 runner 时按上一批的注入方式（替换文件里第一个 `(async()=>{`）插辅助函数——**这个锚点其实落在 `fresh()` 内部**，于是执行文件里的 `fresh` 变成 `return until` 后跟两个函数声明，每次都立刻返回、从不检查页面。表现是首个用例 0.5ms「通过」、请求数为 0，正是这个缺陷在报错位置上的样子。

- 修法：把辅助函数插在 `'use strict';` 之后，并在记录脚本里断言执行文件恰好有一个完整的 `fresh` 定义、且 runner 不再用那个危险锚点。
- **受影响范围**：只依赖 `fresh()` 的断言在上一批（十四项那组）里是空转的；用显式 `until()` 谓词写的判据（过期耗时、请求序列、状态迁移）不受影响。
- **重验结果**：同一准确组件 `9f21f7d7…` + 夹具 `6baebd08…`，修好的 runner 跑**原有十四项 14/14 通过**，说明上一批结论成立，只是证据链现在才真的跑起来。

三条例外的交错（新增）全部通过：

| 新用例 | 关键读数 |
| --- | --- |
| 歌词回复迟于新鲜度期限 | 过期 **2996ms**；那一条迟到回复确实被投递并拒绝；随后 2.5 秒内容保持清空、scope 不回到在线；恢复后重取正常 |
| 双 scope 同时 500 | 两个 scope 一起过期 **3053ms**，状态回 200 后双双恢复 |
| 连续两次切曲 | D1/D2/D3 各发起一次文档请求（D1、D2 在途），最终只有 `key-D3` 落地，另两个从不落地且至少一条被取消 |

两跑都 exit=0、**11 个**归属实例全部消失、隔离 `config.json` 逐字节未变。留档 `source-expiry-1793334922641/feed-faults-fixed-runner.json`（`record-feed-faults-fixed-runner.js` 带断言：两跑必须 passed、组件/夹具 SHA 绑定、`fresh` 完好、迟到档 2500–4000ms、双 scope 2500–7000ms、三个文档键齐全）。范围仍是受控协议夹具；剩余组合、真实宿主与物理输入照旧未覆盖，`P2` 与八小时/D3b 状态不变。

## 50 轮启停：基线零漂移

进度第 3 条里能无人值守的一半先补上：同一份复用 WebView2 目录上连做 **50 轮启停**（准确组件 `9f21f7d7…`，任务独占 config）。每轮起 `--settings`、等管理通道 `status` 应答、沉降 350ms 后取句柄/线程、`quit`、要求 exit=0，再核对**每一对归属 PID+创建时间**都已消失，然后才起下一轮。

结果：50/50 轮 management 就绪、exit=0、归属树清空；**每轮基线完全相同**——进程句柄恒为 **15**（极差 0）、线程 21（仅一轮 22）、归属实例恒为 **8**；首轮创建目录、第 2 轮起复用；整轮 161.5 秒（约 3.2 秒/轮）。因为每轮都是新进程，这条界定的是**重启卫生**，不是进程内保留（P2 另记）；也**不含锁屏/显示切换**（那需要你在场），本轮也没启用壁纸 surface。

留档 `source-expiry-1793334922641/start-stop-50.json`（`record-start-stop-50.js` 带断言：句柄序列必须全等、线程极差≤1、归属数全等、首轮建目录其后复用、每轮无残留）。范围仍是本机当前 Windows 会话；其他身份/平台与物理输入照旧未覆盖。

## 结构性畸形响应：两条严格用例通过，暴露出壁纸侧的快速清空

给夹具加了逐 scope 的 `lyricsBody` / `wallpaperBody`（`missing-track` / `wrong-position` / `not-object`），只改非文档快照的响应体，文档与协议语义不动；重建后 exe `0dfc608f…`、源码 `cb432ac5…`，在准确组件 `9f21f7d7…` 上跑六条原有 + 三条新用例，**9/9 通过**。每条新用例都先确认**原生侧两个 scope 都在线**再注入畸形体。

| 用例 | 读数 | 判定 |
| --- | --- | --- |
| `lyricsBody=wrong-position`（`positionMs` 变成字符串） | 歌词 scope 在 **3048ms** 过期，壁纸保持在线，清除后恢复 | 与「数据格式失败只退避、由三秒新鲜度清空」一致 |
| `wallpaperBody=not-object`（响应体换成数组） | 壁纸 scope 在 **412ms** 就下线并清空页面（先一轮未加前置断言的量测是 442ms），歌词保持在线，清除后恢复 | **与上述合同不符，记为待判读的不对称** |
| `lyricsBody=missing-track` | 两个 scope 都在线、文档保留、宿主存活 | `track` 在本协议里是可选的，这条是**表征性记录**，不是通过/失败合同 |

机制线索：`app.rs` 的 `handle_wallpaper_feed(Err)` 会 `source_health.fail(false)`、丢 `wallpaper_last` 并清空页面；而 `dbx_feed.rs` 只在成功时发壁纸消息，两个 scope 的解析失败都只走 `retries[slot].fail()`。目前已找到的壁纸 Err 发射点只有「会话变化」那条分支，所以下一步要看**非对象响应体是否被归成身份级（`source_invalid`）失败**、以及这种归类对「内容级畸形」是否是有意为之。**这条记为 open 的不对称，不下缺陷结论**。

留档 `source-expiry-1793334922641/body-shape-faults.json`（`record-body-shape-faults.js` 带断言：两 scope 必须在线、歌词档 2500–4000ms、壁纸档 <1000ms、夹具与组件 SHA 绑定、两次量测都保留）。范围仍是受控协议夹具；`P2`、签名/预算、八小时与 D3b 状态不变。

### 那条「非对象体 412ms 清空」判读清楚了：是身份闸门误判（新发现，open）

宿主日志给出机制：注入非对象响应体后出现 `wallpaper feed dbx_source_unavailable: DBX 来源身份或组件版本不匹配`，约 1.2 秒后恢复。源码对应点：`dbx_feed.rs` 的快照槽在**类型解析之前**就检查 `response.body["server"]["session"]` 与 `["edition"]`；非对象体索引得到 `Null`，于是被判成身份/版本不匹配（`ReadError::identity()` → `source_invalid`），而合同要求「传输/数据格式失败只退避、由三秒新鲜度清空」。用 `positionMs` 改为字符串做对照时 `server` 完好、闸门放行，走的正是退避，**3056ms** 才过期——说明分界不是「壁纸 vs 歌词」，而是「响应体是否还有 server 块」。

影响面也量了（这是它比普通误判更严重的地方）：挂一个 1.5 秒延迟的歌词文档请求，再注入畸形壁纸体，第一条文档请求失败、第二条被重新发出（begins=2、首条 ok=false），歌词 scope 仍在线、壁纸 scope 失败——**`source_invalid` 的「取消全部在途」分支确实跨 scope，会把无关的歌词文档取回一起掐掉并触发重取**。

记为新开放项 `P3-malformed-snapshot-classified-as-identity`（correctness，非发布阻断）：未改产品代码；修法是先按快照校验响应体（或把缺失/非对象 server 块归为格式失败），让身份错误只留给真正的身份/版本不匹配——若要修，按老流程重建候选并重拉验收。留档 `source-expiry-1793334922641/identity-misclassification.json`（`record-identity-misclassification.js` 带断言：日志必须出现该身份错误、壁纸档 <1500ms、歌词档 >2500ms、影响面档 begins≥2 且首条失败、scope 状态如述）；其中一次量尺错误（end 未筛 `op=document`，读到 1ms 的快照事件）保留在 `desktop-native-feed-faults-1793419755537`。

P3 再补两步：**只删 `server` 块**（协议、seq、曲目等全部保留）时，**两个 scope 都在约 770/790ms 被清空**——说明这是共享身份闸门的性质，既不是「壁纸专属」也不是「非对象体专属」；而把 **409 只投给文档响应**（快照仍 200）时两个 scope 全程在线、状态清掉后文档落地——冲突处理不受这条路径影响。两条 `missing-server` 用例断言的是**当前实测行为**，将来修好闸门后必须改成「退避 + 三秒新鲜度过期」，它们是修复的回归护栏而不是对现状的认可。同一批 9/9 通过（六条原有 + 两条 missing-server + 一条 409），夹具已加 `documentStatus` 旋钮（exe `d39075121…`）。

壁纸启用态的另一半也补上了：同样 50 轮启停，但**每轮都经管理通道启用壁纸并等到 pageReady**，即每轮带一次真实 surface 创建与挂载。结果 50/50 就绪、exit=0、归属树清空；每轮基线完全相同——进程句柄恒 **21**、线程 **22**、归属实例 **9**（比无壁纸档各多一，符合多一个 surface），零漂移；155.4 秒（约 3.1 秒/轮）。这界定的是**带 churn 的重启卫生**；进程内「每次重建保留一个句柄」的 P2 结论不因此改变。留档 `source-expiry-1793334922641/start-stop-wallpaper-50.json`（`record-start-stop-wallpaper-50.js` 带断言：句柄序列全等、线程极差≤2、归属数全等、首轮建目录其后复用）。锁屏/显示切换仍需你在场。

## I/O 分类：发现文件丢失退避、钥匙文件丢失立即撤销

两条零夹具改动的 I/O 用例（同一准确组件，8/8 通过）：

| 用例 | 做法 | 读数 | 与代码分类一致 |
| --- | --- | --- | --- |
| 运行中移走 `desktop-source.json` | 改名挪开（保留私有 ACL） | 600ms 后页面内容仍在；**2379ms** 才过期；改回后 **1468ms** 恢复 | `NotFound → unavailable`，只退避 |
| 运行中移走 `desktop-lyrics-key` | 同上 | 歌词 scope **549ms** 清空、壁纸保持在线；改回后 **1939ms** 恢复 | 凭据读失败 `→ revoked`，只清该 scope |

**顺带发现的判定细节**：一开始我用「把保存的字节写回去」来恢复文件，结果宿主持续报 `dbx_source_unavailable`（身份类）且退避越拉越长、45 秒都回不来——因为私有读取检查会拒绝权限不私有的文件，而这个错误不是 `NotFound`，被归进身份类。改成改名改回后立刻恢复。这条记成**观察**（不可信文件按身份风险处理，可以理解为有意），不记缺陷；两次写回式恢复失败轮原样保留。

留档 `source-expiry-1793334922641/io-classification-faults.json`（`record-io-classification-faults.js` 带断言：600ms 内容仍在、发现文件丢失 1200–8000ms 过期、钥匙丢失 <2500ms、两者恢复 <45s、两次失败轮的错误文本必须匹配、组件与夹具 SHA 绑定）。日志只能绑到壁纸侧的 feed 行，所以这两条以**实测行为 + 代码分类**绑定，不靠错误码日志。

## 崩溃顺序：对端在请求途中被杀

挂一个 3.5 秒延迟的歌词快照请求，在它**在途时**终止夹具进程并销毁其 stdin：

- 宿主**存活**（600ms 后 `exitCode` 仍为 null），页面内容**没有被误清**；
- 两个 scope 在 **2363ms** 按三秒新鲜度过期；
- 随后在同一个数据目录上起**第二个夹具（新 session）**，宿主采纳新会话并在 **2491ms** 内恢复，两个 scope 都回到在线；整轮 `config.json` 逐字节未变、9 个归属实例退出。

这条把「对端死亡」归到 unavailable 类（退避 + 新鲜度过期），与畸形体命中的 identity 类形成对照。留档 `source-expiry-1793334922641/crash-ordering-faults.json`（`record-crash-ordering-faults.js` 带断言：宿主必须存活、内容不得即时清空、过期 1000–10000ms、恢复 <45s、恢复后两 scope 在线、配置未变、归属实例计数）。三次驱动缺陷保留：两次转义把换行写成真换行导致执行文件解析失败（无输出目录）、一次引用了 runner 侧的 `meta` 使恢复步骤抛错（宿主存活与过期断言已过）。范围仍是受控夹具——真实 DBX sidecar 的停止/强杀/重启已在授权联调里单独覆盖，不互相代替。

## 会话替换与文档撤销两条交错

- **新 session 直接替换旧 session（旧对端不退出）**：在同一个数据目录上写入第二个夹具的新发现文件，宿主在 **911ms** 内跟随新会话（快照与文档都变成 `key-NEWSEC`），两个 scope 保持在线——旧会话的文档缓存没有被继续沿用。
- **文档 403、快照仍 200**：宿主在 2 秒窗口内对该文档重新发起 **2 次**请求，但 403 的文档**从不落地**；把状态清掉后正常取回。撤销分类只挡住内容，没有把快照流一起打掉。

两跑 8/8 通过、`config.json` 逐字节未变、11 个归属实例清空。留档 `source-expiry-1793334922641/session-and-revocation-orderings.json`（`record-session-revocation-orderings.js` 带断言：跟随新会话 <20s 且两 scope 在线、403 文档必须被重取 ≥2 次且从不落地）。三次驱动缺陷保留：一次把「上一用例留下的活夹具」当前提（其实已退出）、两次从 `pages()` 顶层取 `documents`（正确位置是 `lyrics.documents`）并在页面重载期间读取。

**P3 修复原型**仍待授权（改 `dbx_feed.rs` 的校验顺序），其余无人值守项继续按故障矩阵推进。

## 交替失效与文档级 500

- **两 scope 交替失效**：先让歌词 500 → 它在 **2977ms** 按新鲜度过期（壁纸在线），清掉后 **1472ms** 回来；再让壁纸 500 → **3019ms** 过期（歌词在线），清掉后 **492ms** 回来。两次失效各在对方的健康期内，恢复也各自独立。
- **只让文档返回 500**（快照仍 200）：宿主在窗口内**重取 2 次**文档、从不落地，两 scope 全程在线；清掉状态后文档正常到达。文档级传输失败按退避重试处理，不会被当成 scope 失效。

8/8 通过、`config.json` 逐字节未变、11 个归属实例清空。留档 `source-expiry-1793334922641/alternating-scope-orderings.json`（`record-alternating-scope-orderings.js` 带断言：两次过期都在 1500–8000ms、两 scope 恢复各自 <8s、文档重取 ≥2 次且从未落地、两 scope 在线）。

## 失败分类矩阵（29 个用例 / 19 个错误类）

把已跑过的受控故障用例按「错误类」汇总，每一行都必须能在对应运行报告里找到一个**通过**的用例才允许出现——生成器会逐条断言，缺一个就失败。完整数据（含每类的关键读数）在 `source-expiry-1793334922641/failure-classification-matrix.json`，表由 `source-expiry-1793334922641/failure-classification-matrix.md` 提供，两者都由 `record-failure-matrix.js` 从运行报告重算生成：

| 错误类 | 用例数 | 结果 | 记录 |
| --- | --- | --- | --- |
| transport / unavailable (backoff, freshness expiry) | 7 | 通过 | `feed-faults-fixed-runner.json` |
| transport / late reply and simultaneous failure | 2 | 通过 | `feed-faults-fixed-runner.json` |
| authorization / revoked (immediate clear, scoped) | 2 | 通过 | `feed-faults-fixed-runner.json` |
| authorization / revoked by file (immediate clear) | 1 | 通过 | `io-classification-faults.json` |
| authorization / revoked by document reply | 1 | 通过 | `session-and-revocation-orderings.json` |
| I/O / unavailable by file loss (backoff then freshness) | 1 | 通过 | `io-classification-faults.json` |
| I/O / document-only failure (retry, no scope loss) | 1 | 通过 | `alternating-scope-orderings.json` |
| conflict / 409 on a document (scope stays online) | 1 | 通过 | `body-shape-faults.json` |
| identity / body without a server block (currently immediate clear) | 2 | 通过 | `identity-misclassification.json` |
| identity / non-object body (currently immediate clear) | 1 | 通过 | `body-shape-faults.json` |
| session / same key after a new session re-fetches (700 ms transient blank) | 1 | 通过 | `session-same-key-document.json` |
| class change / 500 -> 403 -> 500 on one scope | 3 | 通过 | `cross-class-transitions.json` |
| class change / three consecutive cycles converge | 1 | 通过 | `repeated-cross-class-cycles.json` |
| class change / wallpaper 500 -> 403 stays offline | 1 | 通过 | `wallpaper-transition-and-deferred-document.json` |
| sequence / track switch during 500 defers the document | 1 | 通过 | `wallpaper-transition-and-deferred-document.json` |
| soak / two-minute mixed faults recover | 1 | 通过 | `mixed-fault-soak.json` |
| rate / sustained failure backs off (no hot loop) | 1 | 通过 | `request-rate-backoff.json` |
| rate / unparsable document retries stay bounded | 1 | 通过 | `request-rate-backoff.json` |
| identity / genuine session mismatch (guard working as intended) | 1 | 通过 | `identity-guard-boundary.json` |
| I/O / non-object document body (guard bypassed, retried) | 1 | 通过 | `identity-guard-boundary.json` |
| identity / optional field tolerated (missing track) | 1 | 通过 | `body-shape-faults.json` |
| sequence / stale sequence never refreshes lifetime | 2 | 通过 | `feed-faults-fixed-runner.json` |
| sequence / superseded documents never land | 1 | 通过 | `feed-faults-fixed-runner.json` |
| sequence / slow old document cancelled on switch | 1 | 通过 | `feed-faults-fixed-runner.json` |
| sequence / same-key document timeout and retry | 1 | 通过 | `feed-faults-fixed-runner.json` |
| session / replacement session takes over | 1 | 通过 | `session-and-revocation-orderings.json` |
| crash / peer dies mid-request, new session recovers | 1 | 通过 | `crash-ordering-faults.json` |
| isolation / scopes fail in alternation | 1 | 通过 | `alternating-scope-orderings.json` |
| buffering / state without control commands | 1 | 通过 | `feed-faults-fixed-runner.json` |

两行是**有意的现状断言**：`identity / body without a server block` 与 `identity / non-object body` 记录的是 P3 当前的误判行为，修好闸门后这两行必须改写为「退避 + 三秒新鲜度过期」。其余行是正常合同。矩阵不含物理输入、声学、锁屏/显示切换、真实 DBX 宿主行为与 P3 修复本身——这些仍是开放项。

## 身份闸门的边界（P3 的反面证据）

两条新用例把闸门的适用范围钉住（夹具已加 `documentBody` 与逐 scope `bodySession`，exe `c9351944…`）：

| 用例 | 读数 | 含义 |
| --- | --- | --- |
| 文档体非对象（快照 200） | 文档被重取 **3 次**、从不落地、两 scope 在线；整轮宿主日志 **0 条** `dbx_source_unavailable` | 闸门只在没有文档请求时运行 → **P3 只影响快照体** |
| 快照 `server.session` 被改成别的会话 | 歌词 scope **716ms** 清空、壁纸在线；日志出现身份错误 | 闸门对**真正的会话不匹配**工作正常，立即清空是该有的行为 |

所以修法应当**保留**「会话/版本不匹配 → 立即清空」，只把「响应体无法解析或缺 `server` 块」降级为格式失败；这两个新旋钮正好让修复后能从两侧回归。留档 `source-expiry-1793334922641/identity-guard-boundary.json`（`record-identity-boundary.js` 断言：文档档 0 条身份日志、两 scope 在线、文档从不落地；快照档 ≥1 条身份日志、清空 <3000ms、壁纸在线）。首轮 v14 的前提错误（文档体本就没有 `server` 块，删它是空操作）保留在 `faults-v14.log` 对应的失败轮里。

## 请求频率：退避是真的，不是热循环

- **单 scope 持续 500 十二秒**：该 scope 的请求数按三秒窗口为 **2 → 1 → 1 → 0**（12 秒共 **4 次**），而健康 scope 在同一窗口仍发了 **48 次**——失败指数退避、健康面不受牵连，不存在忙等待。
- **文档体不可解析十秒**：文档只重取 **4 次**、从不落地，两 scope 全程在线。

留档 `source-expiry-1793334922641/request-rate-backoff.json`（`record-request-rate-backoff.js` 断言：末窗口请求数 ≤ 首窗口、12 秒总数 <60、健康 scope ≥10 次、文档重试 1–10 次、两 scope 在线）。失败分类矩阵随之更新为 **23 类 / 33 用例**。

## 两分钟混合故障浸泡

八个 15 秒相位（健康 → 歌词 500 → 壁纸 403 → 双 scope 畸形协议 → 慢文档 + 切曲 → 壁纸 500 → 双 500 → 恢复），每 2.5 秒采样一次状态与页面，每个采样点都断言宿主存活：

| 相位 | 采样 | 两 scope 在线 | 两 scope 离线 | 末次状态 |
| --- | --- | --- | --- | --- |
| healthy | 6 | 6 | 0 | 都在线 |
| lyrics-500 | 6 | 2 | 0 | 歌词离线、壁纸在线 |
| wallpaper-403 | 6 | 0 | 0 | 壁纸离线、歌词在线 |
| malformed-protocol（双） | 6 | 0 | 5 | 都离线 |
| slow-document + 切曲 | 6 | 5 | 1 | 都在线 |
| wallpaper-500 | 6 | 2 | 0 | 壁纸离线、歌词在线 |
| both-500 | 6 | 0 | 5 | 都离线 |
| recover | 6 | 5 | 1 | 都在线 |

整轮 **122.7 秒**、48 个采样、**406 次**请求（远低于任何热循环水平），宿主全程存活，结束后两 scope 在线且新文档落地，`config.json` 逐字节未变。相位顺序是脚本化的、不是随机顺序。留档 `source-expiry-1793334922641/mixed-fault-soak.json`（`record-mixed-fault-soak.js` 断言：时长 ≥110s、采样 ≥40、请求 <6000、健康相位全程在线、双 500 相位至少一次双离线、恢复相位末次在线）。矩阵更新为 **24 类 / 34 用例**。

## P2 速率在 100 次重建上仍是 1:1

同一准确组件、同一复用目录把壁纸重建从 50 提到 **100** 次：冷档进程句柄 **15 全程不动**；复用档 **16 → 116**（每个十周期采样点严格 +10），**+100 全部落在同一个活的 `NetworkService`**，60 秒空闲保持 116/116/116/116，两跑 exit=0、归属实例各 8 个清空。连同 10 次与 50 次的旧档，速率在两个数量级的重建次数上都是 **1:1**。留档 `source-expiry-1793334922641/recreation-scaling-100.json`（`record-recreation-scaling.js` 带断言：十周期标记必须严格等差、只允许一个活目标、冷却不释放）。P2 仍 open——内部持有者与受支持的释放路径都未定位。

## 同量级的反向校验：设置重建 100 次仍为零

把设置关闭→重开从 20 提到 **100** 次（同一准确组件、同一复用目录）：冷档与复用档的进程句柄**都是 15 全程不动**（净变化 0），冷却 15/15/15/15，唯一的正向变化是一组 renderer 替换（+3，净额被同量释放抵消）；两跑 exit=0、归属实例各 8 个清空。与同量级的壁纸重建（100 次 → **+100**）对照，两条产品路径在相同重建次数下完全不同——这正是 P2 记录所依赖的对比。

首轮 100 次设置档失败在**第 3 个周期**：点击「关闭」时应用正好把目标页拆掉（Playwright 报 target closed）。这本来就是该点击的预期结果，所以驱动改为「目标已关闭且设置页已消失」视为成功关闭，并在关/开之间加 150ms 沉降；失败轮保留。留档 `source-expiry-1793334922641/settings-scaling-100.json`（`record-settings-scaling.js` 断言：两档净变化 0、冷却序列唯一、只允许 renderer 出现在正向、归属实例计数、失败轮必须标记为未完成）。

## 十四项在最新夹具上的回归

夹具此后加过逐 scope 的 `lyricsBody` / `wallpaperBody` / `bodySession`、`documentStatus`、`documentBody` 等旋钮，为了确认这些增量没改变既有行为，把**原有十四项**在新夹具（`c9351944…`）上重跑：**14/14 全部通过**，宿主与夹具都 exit=0、隔离配置逐字节未变。

收尾判据上出现一个已知形态：宿主 exit=0 后，15 秒窗口内仍有 **2 个 `msedgewebview2.exe`**（浏览器根 + crashpad）存活；几分钟后复查已自行消失——与此前「复用 profile 的浏览器根会晚几十秒退出」的记录一致。所以本轮按「14/14 通过 + 收尾窗口偏紧」记录，不判产品失败；驱动里 15 秒的清理预算按此边界留档。留档 `source-expiry-1793334922641/fault-regression-new-fixture.json`（`record-fault-regression-new-fixture.js` 断言：14 项全过、夹具 SHA 必须等于当前构建、11 个归属实例、残留必须恰为 2 个且都是 WebView2）。

## 收束：P2 / P3 的一页汇总

P2 与 P3 的触发条件、全部精确读数、最小复现（含探针模式表与三个诊断变体）、代码位置、已排除项、建议修法与修复后的双侧回归旋钮，已整理成一页：`source-expiry-1793334922641/upstream-and-fix-summary.md`。页内每个数字都在本文件前面的记录里有对应 JSON，且明确列出「本页不主张的事」。当时产品代码与冻结候选均未改动；后续两节先做诊断件，文末「落地到工作区并重建候选」一节把修复并入工作区并重建了候选。

## 本次会话收尾清单

`source-expiry-1793334922641/verification-closeout.md` 列出本次会话**已验 / 仍开放 / 需要用户**三类条目，每条已验项都指向具体记录；并给出下一次接手的第一个动作（P3 修法与双侧回归步骤——后续已按该步骤执行完，见文末两节与该文第五节）。核对时逐份报告复核了用例计数：feed 14/14 与 9/9、body 9/9、io 8/8、crash 7/7、session 8/8、alternating 8/8、soak 7/7、identity 9/9 与 7/7、回归 14/14（收尾窗口边界另记）。

## 换新 session 但同 key：只短暂空白，不再永久卡住

历史上修过「同 key 文档去重导致恢复后永久空白」。本轮补测同一路径：旧 session 正在显示 `key-SAMEKEY` 的文档时，让第二个夹具用**新 session**接管、曲目与 key 不变——

- 页面在切换后空白 **700ms**（20 个 100ms 采样里前 7 个为 null），随后重新落地 `key-SAMEKEY`；
- 新 session 确实对同一 key **重新发起 1 次**文档请求；
- 收尾两 scope 在线、隔离配置逐字节未变。

所以「永久空白」确实不再出现；剩下的是**有界瞬时空白**而不是卡住的表面。两次驱动错误保留：第一次我把判据写成「绝不能空」（7 个连续 null 正是这条改成有界表征的起因），第二次把「新会话请求数」算成整条日志的第一个 `ready` 之后（应为用例开始后的第一个）。留档 `source-expiry-1793334922641/session-same-key-document.json`；矩阵更新为 **25 类 / 35 用例**。

## surface 重建 × 喂数失败（组合场景）

用一个新驱动同时起夹具与真实组件，配置里**明确绑定 DBX 来源**（管理通道因此走 v2 信封）：

| 阶段 | 内容 | 结果 |
| --- | --- | --- |
| healthy-churn | 壁纸启用→等 pageReady→禁用 ×3 | 三周期都 pageReady、禁用后 `enabled/visible=false`，两 scope 在线 |
| fault-churn | 两 scope 持续 500 的**同时**再做启用/禁用 ×3 | 表面仍能挂载并报 pageReady；第 1–2 周期壁纸 scope 已离线、第 3 周期两 scope 都离线（按新鲜度） |
| recovery | 清掉 500、再次启用 | pageReady 回来，两 scope 都恢复在线，随后正常禁用 |

宿主在每个阶段都存活；整轮 10 个归属实例（宿主树 + 夹具）在收尾后全部消失，夹具 exit=0，隔离配置 `launchAtLogin=false` 未变。**surface 反复重建与喂数失败不会互相卡死。**

**顺带记录的协议限制**：绑定 DBX 来源的宿主**没有管理通道的退出路径**——v1 `quit` 被 `source_target_required` 拒绝，v2 信封没有 `quit`（`unsupported_command`）。本驱动因此用终止进程收尾并记 `hostShutdown=terminated`；DBX 绑定下的优雅退出只能走 UI 或由其宿主带走（那条路径在既有授权联调里另测）。记为观察，不判缺陷。

留档 `source-expiry-1793334922641/churn-under-faults.json`（`record-churn-under-faults.js` 断言：健康三周期挂载/卸载、故障期仍 pageReady、双 scope 必须过期、恢复后两 scope 在线、`quit` 必须被拒且错误码为 `source_target_required`、归属实例清空）。该报告是阶段式结构而非用例列表，故不进失败分类矩阵的用例表。两次驱动错误（裸 v1 命令、先等归属树后停夹具）保留。

## 重建 × 故障 × 时间：13 次重建跨三种故障相位

同一驱动扩成五相位（冷目录、13 次壁纸重建，每个故障相位后**强制恢复**）：

| 相位 | 重建 | 结果 | 相位末句柄 |
| --- | --- | --- | --- |
| healthy | 3 | 全部挂载/卸载正常，两 scope 在线 | 15 |
| sustained-500 | 3 | 表面仍挂载，双 scope 过期，清 500 后恢复 | 15 |
| revoked-403 | 3 | 双 scope 保持清空，清 403 后恢复 | 15 |
| malformed-protocol | 3 | 双 scope 过期，清回 v1 后恢复 | 15 |
| final-recovery | 1 | 两 scope 在线 | 15 |

宿主全程存活、夹具 exit=0、归属实例清空；**进程句柄全程保持 15**——与 P2 的「冷目录为零」一致：故障交错既不破坏恢复，也不在冷 profile 上产生累积。另跑了第二遍独立的同形浸泡，结果相同。

复用目录版本尝试了三次都没接上（路径解析、报告目录、管理通道无应答各一次），均为驱动侧问题，**已搁置**——P2 的复用目录速率由专门的 10/50/100 次重建记录承担。留档 `source-expiry-1793334922641/churn-soak.json`（`record-churn-soak.js` 断言：五相位顺序、每相位预期行为、13 次创建、句柄必须为 15、归属实例清空、夹具 exit=0）。

## 跨错误类切换

同一 scope 上把故障类**换掉**（不先恢复），验证状态机不会锁死在第一个类上：

| 切换 | 8 个采样（每 250ms） | 另一 scope | 恢复 |
| --- | --- | --- | --- |
| 500 → 403 | 歌词全程离线、不闪回 | 全程在线 | 清回 200 后恢复 |
| 畸形协议 → 403 | 同上 | 同上 | 同上 |
| 403 → 500 | 同上 | 同上 | 同上 |

留档 `source-expiry-1793334922641/cross-class-transitions.json`（`record-cross-class-transitions.js` 断言：三例都必须通过、8 个采样全离线、另一 scope 全在线、最终恢复）。首轮因 `EPERM rename state.json`（Windows 瞬时文件锁）在第三例中断，重跑 9/9 通过，失败轮保留。矩阵更新为 **26 类 / 38 用例**。

## 壁纸跨类切换与「故障中途切曲」

- **壁纸 500 → 403**：切类时壁纸 scope 在 8 个采样里保持离线、不闪回，歌词全程在线；清回 200 后两 scope 恢复。
- **切曲发生在歌词 500 期间**：新曲目的文档**一次请求都没有发出**（没有快照能带回新 key），清掉 500 后新曲目的快照到达、对应文档正常落地——既不提前取，也不丢失。

留档 `source-expiry-1793334922641/wallpaper-transition-and-deferred-document.json`（`record-wallpaper-transition.js` 断言：壁纸 8 采样全离线、歌词全在线、故障期间新文档请求必须为 0、清掉后恢复）。矩阵更新为 **28 类 / 40 用例**。

## 连续三轮跨类循环

同一进程内连做三轮「500 → 403 → 200 + 切曲」：每轮跨类时都保持离线、每轮都恢复（**1341 / 4832 / 1350ms**），最终两 scope 在线、整段请求 91 次。第二轮明显更慢是退避累积所致（设计如此、仍在界内）。留档 `source-expiry-1793334922641/repeated-cross-class-cycles.json`；矩阵更新为 **29 类 / 41 用例**。

## 10 分钟健康基线

正常喂数、壁纸启用、不做任何重建，每 15 秒采样一次共 **39 个采样点 / 600 秒**：

- 两 scope **每个采样都在线**（启动前的 1 秒宽限不计入，判据改为「先等双 scope 在线再开始」）；
- 进程句柄**全程 21，零波动**；
- 线程从 18 单调回落到 13 后在尾部稳定（空闲 worker 退场，**没有增长**；判据由「极差 ≤2」改为「不高于起始且尾部稳定」）；
- 共 **3642 次**请求（约 6 次/秒，两 scope 合计），无热循环。

首轮按「极差 ≤2 + 含启动点」判失败，数据本身正常——失败轮保留，判据修正后重跑通过。留档 `source-expiry-1793334922641/healthy-baseline.json`（`record-healthy-baseline.js` 断言：时长 ≥600s、采样 ≥30、全在线、句柄零漂移、线程不增长且尾部稳定、归属实例清空、夹具 exit=0）。这是健康路径的耐力基线，**不是**八小时资格。

## 设置中心在断流期间保持打开

管理通道先 `open-center` 打开设置中心（壁纸已挂载），然后让两个 scope 同时 500 四秒、再恢复：

- 断流期间两 scope 过期，**设置中心保持打开**（`settingsOpen=true`），宿主存活；
- 恢复后两 scope 在线，**中心仍然打开**且壁纸 `pageReady`。

留档 `source-expiry-1793334922641/settings-center-under-faults.json`（`record-settings-under-faults.js` 断言：三相位顺序、断流期 `settingsOpen` 必须为真、双 scope 过期、恢复后双在线且中心仍开、夹具 exit=0、归属清空）。关闭中心仍需页面按钮，本驱动不点。

## P3 是长期行为，不是本次候选的回归

把同两条 `missing-server` 用例跑到**上一版组件**（`4d2906f4`，build `07d87e76`）上：歌词/壁纸分别在 **774 / 785ms** 被清空，宿主日志同样出现身份错误——与候选（770 / 790ms）几乎一致。所以 P3 属于**历来的分类缺陷**，修它是在修既有行为，不是回退本次新鲜度改动；修复后对两版都算行为变更。留档 `source-expiry-1793334922641/p3-cross-build.json`（`record-p3-cross-build.js` 断言：两版都必须 <1500ms 清空、日志必须出现身份分类、组件 SHA 分别绑定）。两次驱动失败（组件目录覆盖触发旧守卫、守卫替换又丢了一个反斜杠）保留。

## P2 同样不是本次候选的回归

同一壁纸重建形状（20 次，冷/复用两档）跑在**上一版组件**（`4d2906f4`）上：冷档 15 不动，复用档 **16 → 36 = +20**，全部落在同一个活的 NetworkService，60 秒不释放。与候选的 1:1 完全一致，所以 P2 也是**长期行为**，不是新鲜度候选引入的。 同一上一版上的**设置关闭→重开二十次同样为 0**（两档 15 不动，仅 renderer 替换），说明壁纸与设置的分界也是历来如此。留档 `source-expiry-1793334922641/p2-cross-build.json`（`record-p2-cross-build.js` 断言：组件 SHA 必须绑定上一版、冷档 0、复用档 +20、单活目标、冷却不释放）。

## P3 修复的诊断构建：四侧回归通过，但有一个未解释的配置写入

按用户「做不需要在场的部分」的指示，从冻结候选源码复制一份、只改 `dbx_feed.rs` 的身份闸门（server 块缺失/非对象 → `unavailable`；存在但不匹配 → `identity`），构建诊断 exe（build `1e0912e6…`），用同一驱动跑双侧回归：

| 用例 | 候选（未修） | 诊断修复构建 |
| --- | --- | --- |
| 歌词快照缺 `server` | **628ms** 清空、有身份日志 | **3054ms** 退避过期、**0 条**身份日志 |
| 壁纸快照非对象 | ≈795ms 清空、有身份日志 | **2991ms** 退避过期、**0 条**身份日志 |
| 快照 `server.session` 真不匹配 | 716ms 清空、有身份日志 | **510ms** 清空、仍有身份日志 |
| 文档体非对象 | 重取、0 条身份日志 | 重取 2 次、0 条身份日志 |

四条都符合预期：格式失败改为退避、身份失败仍立即清空。**但修复构建这一轮结束时隔离配置被写了一次（revision 1→2）**，同一驱动跑在候选上 revision 保持 1——写入只出现在修复构建。最可能路径是 feed 错误处理里的 `recompute_visibility()` 触发保存（身份路径不走那里），后续做了**同形对照**（放宽退避断言让候选也完整跑完四条）：候选的隔离配置逐字节未变（revision 1、anchor 0.5/0.65、monitor null），所以那次写入**确实属于修复路径**——差异只有 `anchorX`（0.5→0.4911）、`anchorY`（0.65→0.7868）、`monitor`（null→`\.\DISPLAY1`），即 `place(true)` 的位置保存；其中 **monitor 被钉住**会改变后续多显示器行为。并入候选前必须在过期路径上抑制这次保存，或确认它是预期。诊断件不参与任何资格；冻结候选与工作区均未改动。留档 `source-expiry-1793334922641/p3-fix-diagnostic.json`。

## P3 修复第二版：副作用消失，行为不变

第二版在分类修正之上加「无内容时不持久化位置」（`on_moved` 在 `policy.no_content` 时直接返回），诊断 build `b7e9e2d6…` / sha `7e1f1f9b…`：

| 检查 | 结果 |
| --- | --- |
| 缺 `server`（歌词/壁纸） | **2995 / 2955ms** 退避过期、**0 条**身份日志 |
| 真会话不匹配 | **342ms** 清空、仍有身份日志 |
| 文档体非对象 | 不触发身份 |
| 隔离配置 | **逐字节未变**（revision 1、anchor 0.5、monitor null）——位置保存副作用消失 |
| 十四项原组 | **14/14** 通过（整轮仅被已知收尾窗口判失败，6 个 WebView2 晚退后自行退出） |

这版是并入候选的候选形态；仍需重建候选并重跑完整回归与验收。留档 `source-expiry-1793334922641/p3-fix-diagnostic.json` 的 `fixV2` 段。

## 落地到工作区并重建候选：P3 修复进入构建

按用户「开始落地到工作区并重建候选」，两处改动落进工作区（`dbx_feed.rs` 的分类修正、`app.rs` 里 `on_moved` 的无内容守卫），再把工作区整份冻结成副本（排除 target/output/.git/node_modules）冷构建：

| 项 | 值 |
| --- | --- |
| 构建 | `cargo +stable build --offline --locked --release -p hertz-desktop --target x86_64-pc-windows-msvc`，cargo 1.98.1，2m52s 通过 |
| exe | sha `8ed73880…`、build id `ef17de41…`、4,930,048 字节（比上一版少 2,560） |
| 打包与验包 | 归档 sha `22c2b694…`；解包后 `--describe` 与清单逐字段相等、PE 机器码为 x64、`--describe` 不创建配置 |
| 源码指纹 | 桌面 73 文件 `30acb2f8…`（上一版 `fef7f559…`），**差集只有 app.rs 与 dbx_feed.rs**；构建前后指纹逐字节相同 |

落地后在工作区复核（`p3-fix-1793451059/working-tree-checks.json`）：`cargo test -p hertz-desktop -p hertz-desktop-ipc` 通过 **56 + 19 + 16** 项；`dbx_feed.rs` 整文件 `rustfmt --check` 干净，`app.rs` 的守卫行段没有新增格式 drift（同一工具链下 HEAD 版本本来就有 11 处）；定向 clippy（两 crate、`--all-targets -- -D warnings`）**红在 7 处既有 lint**（12 个报错站点：`config.rs` 一处多余 borrow + 五组测试里的 `Default::default()` 字段赋值、`dbx_feed.rs:375` 用 `slot` 索引 `slots`——那段循环 HEAD 里就有），全部不在本次两处补丁的行段内；`hertz-studio` crate 的单测这轮没跑成，`target/debug/hertz-studio.exe` 被两个 10-29 起的开发实例占用（PID 34600、3740），没有擅自停它们。

五组回归全部指向这个新构建，夹具与协议未变：

| 组 | 新候选读数 | 对照 |
| --- | --- | --- |
| 双侧 P3（10 例） | 缺 `server` **3088ms**、非对象体 **3064ms** 退避过期，身份日志 0→0；真 session 不匹配 **741ms** 清空，身份日志 0→1；文档体非对象重取 2 次、身份日志不变 | 未修候选同两条是 696/513ms 立即清空且各带一条身份日志 |
| 十四项故障 ×3 轮 | 三轮的行为断言都是 **14/14**；一轮整轮绿（隔离配置逐字节未变），两轮只在收尾配置哈希上判失败 | 旧候选同驱动两次对照都整轮绿 |
| 请求速率 | 失败 scope 三秒窗口 2→1→1→0、12 秒累计 4 次；健康 scope 同期 48 次；不可解析文档 4 次 | 与上一版逐位相同 |
| 两分钟混合浸泡 | 122.6s、48 采样、406 次请求、结束两 scope 在线、配置未变 | 上一版 122.7s / 48 / 406 |
| 10 分钟健康基线 | 39 采样全程两 scope 在线、进程句柄恒 21、线程 11–18 无增长、3666 次请求；265.5s 处一次壁纸心跳停、attempt=1 在 200ms 恢复 | 上一版 39 采样、句柄恒 21、线程同带宽、3642 次请求、0 次恢复 |

那两轮的配置不等用一条新驱动定死了归因：`verify-external-move-save.js` 由**另一个进程**真的 `SetWindowPos` 搬歌词窗，再读隔离配置——

| 阶段 | 新候选 | 上一版候选 |
| --- | --- | --- |
| 有内容时移动 | revision 1→2，保存锚点 0.5354/0.6975 与移动后的窗口位置吻合（±1px），monitor 由 null 钉成当前主显示器 | 同样 1→2，锚点逐位相同 |
| 无内容时移动 | **不写**（守卫生效） | revision 2→3（保存） |

所以「有内容时外部移动会保存锚点」是两版共有的既有行为：歌词窗未锁定时本就可拖，拖动后记住位置正是设计。修复只覆盖无内容那一段。量法上留两条教训：PowerShell 取到的是 150% DPI 的虚拟化坐标，换算必须用宿主 `place` 日志里的 scale 并容 ±2px；找窗要按 PID 枚举，隐藏窗用标题 `FindWindow` 不可靠。留档 `source-expiry-1793334922641/placement-save-boundary.json`，驱动 `output/dbx-desktop-d3/verify-external-move-save.js`。

10 分钟基线留下两条要记住的边界。其一是驱动自己的尾部判据：它要求最后五个线程采样完全相同，本轮尾部是 11→13 的一次台阶（句柄恒 21、线程 11–18 与上一版同带宽、39 采样全程在线），上一版恰好结尾连平才过——把它当产品信号是错的，记录只绑「时长、全程在线、句柄平坦、线程不增长」。其二是驱动缺陷：那条断言写在 try 里，抛错后**跳过了自己的收尾**，宿主（PID 35632）与夹具（PID 32192）继续跑了约二十分钟，才由本次会话手动终止；隔离配置最终停在 revision 4、锚点 0.6242/0.3824，其中驱动自己只做过一次 `wallpaper-apply`（revision 1→2），另两次提交发生在设置中心仍开着的空闲窗口、且宿主日志此后再无任何管理命令，只能归因于那次交互而非驱动。驱动文件保持本轮实际使用的那份不改（记录按它的 sha 绑定），改进项「收尾搬进 finally」写进 `regressions.json` 的 limits。

范围：本构建只重跑上面五组，上一版资格的 60 条引用与 14 行已验结论仍只属于旧 exe，不迁移。冻结副本里的可再生构建缓存（`source/target`）与随 tar 一起拷进来的嵌套产物（`tools/dbx-desktop-probe/output`；`--exclude=./output` 只挡根级）已按先前的清理授权删除，约 5 GiB；删除后重新指纹桌面 73 项与插件 548 项**逐位不变**（留档 `p3-fix-1793451059/fingerprint-after-cache-cleanup.json`）。**插件包也没重打**——工作区的 `plugin/ui/app.js` 另带三维歌单「当前曲」判据的改动，插件指纹由 `fa7cbb9d…` 变成 `23ead43a…`，`verify-plugin-packages.py` 会拒绝跨源码复用，插件侧合同/PluginHost/GUI 差分/授权生命周期都要按新树重做。`P2-native-process-handles-retained` 继续 open（跨构建已证 1:1，与本次重建无关）；八小时、D3b、签名分发与需用户在场的项保持未完成。资格见 `p3-fix-1793451059/qualification.json`（构建证据 `candidate.json`、回归证据 `regressions.json`）。
