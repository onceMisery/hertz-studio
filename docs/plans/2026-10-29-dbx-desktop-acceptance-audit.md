# DBX 桌面接入：D3 验收审计

日期：2026-10-29。依据：[设计的 D-A01–D-A18](../desktop-dbx.md)、[实施记录](./2026-10-28-dbx-desktop-implementation.md)及[逐次验证记录](./2026-10-28-dbx-desktop-evidence.md)。本表核对完整范围，不以已经通过的子项重新定义完成条件。

**接手轮最新状态（2026-10-30 下午）：** 被打断一轮留下的三组受控故障补验、WebView2 155/156 运行时对照与只读 Authenticode 复核均已回写；另用冻结候选源码新构建的独立服务补齐「窄 HTTP 播控端点的房间权限路径」（房间激活时九次 `409 stale_playback`、离房后恢复 `200`，驱动三次失败保留），并新增「歌词文档延迟不拖住壁纸 scope」的跨 scope 隔离补验（通过，五条量尺类失败保留）。当前准确的原生候选是 `p3-fix-1793451059/`（exe `8ed73880…`、build `ef17de41…`），其原生构建输入相对上一版只差 P3 分类修正与位置守卫两个文件；上一版 `source-expiry-1793334922641/`（exe `9f21f7d7…`）的整套资格记录仍只属于它，本轮只把五组回归重新绑到新构建，其余引用未迁移。插件包也未重打：`plugin/ui/app.js` 在工作区另有三维歌单「当前曲」判据的改动，旧包的源码指纹与新树不同，`verify-plugin-packages.py` 会拒绝跨树复用。P2/P3 的一页汇总（触发条件、读数、最小复现、代码位置、修法与双侧回归）在 `source-expiry-1793334922641/upstream-and-fix-summary.md`。**`P2-native-process-handles-retained` 仍 open，且已排除“回退/钉住旧运行时即修复”；native 实测 NotSigned。** 本轮另用独立探针把该现象降到调用级：**每次 `CreateCoreWebView2Controller` + `Close` 在复用 user-data 目录里保留一个指向活 NetworkService 的 Process 句柄**，与导航次数、窗口数、泵消息时长无关（十周期建关十个 controller → +10；一个 controller 十次导航 → +1；零 controller → +0），冷目录同一 controller 关闭后归零——是复用条件下的释放缺失，不是每次创建的额外分配。该结论随后在真实组件上分两条产品路径量过：复用目录里 `wallpaper-apply` 真/假重建壁纸 surface ×50 = **+50**（10/20/30/40/50 周期严格 1:1，全落在活的 `network.mojom.NetworkService`，60 秒空闲不释放）；真点「关闭」+ `open-center` 重开设置 surface ×20 = **净 0**（旧 renderer 释放、新 renderer 取走同量）。所以「每次 controller 创建/关闭保留一个」必要但不充分，壁纸与设置两条路径的分界（绘制循环与频谱、WorkerW 挂载、销毁前页面是否已完全活）尚未隔离；先前「设置重开也会累积」的读码推演已被实测撤回。随后一刀把累积钉到**创建本身**：page target 一出现就拆除（十个周期全没等到 pageReady）仍复用档 +10/10、冷档 +0，而等 pageReady 的 CDP 参照档 +50/50 与无插桩参照逐位相同，故调试端口既不制造也不掩盖增长；「ready 后再多留绘制时间」的变体判为冗余未跑。「壁纸用自定义协议环境而设置没用」也被读码否掉——`create_settings` 注册同一个 `hertz` 方案（app.rs:3551/3571/3621）。未隔离的壁纸 vs 设置分界只剩 WorkerW 重挂与分层透明样式、不透明背景、150% DPI 的 `zoom()`、页面持续动画喂频谱，再切需要加厚探针或动产品代码（本轮都没做）。反向对照：设置关闭→重开 100 次两档都保持 15 不变（净 0），与壁纸 100 次 +100 在同量级上完全不同；跨构建对照显示 P2 也是长期行为（上一版 20 次 → +20，与候选 1:1 一致）；P2 的速率在 **100 次重建**上再次核对：冷档 15 不动、复用档 16→116（每十周期 +10）、全部落在同一活 NetworkService、60 秒不释放，速率在两个数量级上都是 1:1。**绘制与帧率随后也排掉了**：同一探针在拆除前不等帧、1 帧、30 帧、以及同样 30 帧门控到约 10fps（每周期 3268ms vs 385ms，慢 8.5 倍），复用档全部 +10、冷档全部 0，增量仍全在活的 NetworkService——所以分界只剩窗形那三项。**窗形三档也跑了两项**：自注册 `WS_POPUP` 无边框窗对照 +10、加不透明背景色 +8、加 `SetZoomFactor(1.5)` +9，都不抑制保留（未抹平成 10，也没有一档归零）；**WorkerW 托管在探针里做不动**——按产品顺序先挂后建首周期即报 `0x8007139F`，改装成先建后挂则第 1 周期成功、第 2 周期同进程再次建 controller 报同一 HRESULT，而产品同序列连做 50 次正常，故这是最小宿主的限制而非产品结论。WorkerW 这一项随后用**诊断构建二分**关掉了：从冻结源码复制一份只加一个 `HERTZ_DIAG_SKIP_WORKERW` 开关（诊断 exe `f631a6e3…`，冻结候选与工作区未动、不参与任何资格），同一驱动跑 50 周期——对照档照常挂载精确复现 **+50**，跳过挂载反而 **+63**（冷档还多 +14），开关在 B 档日志里出现 122 次、A 档 0 次。**所以 WorkerW 托管不是触发点**，也不能靠改挂载方式修，且「跳过挂载更省」的直觉被否掉。剩下的候选随后又排掉三条：拆除时的**连接状态**（探针 loopback：未回应的请求与已回应并关闭的请求各 10 周期都是 +10）、**同环境兄弟 surface**（壁纸整轮启用时设置关闭/重开 ×20 复用档净 0），以及确认设置重建**确实是销毁重建**（CDP target 数 2→1→2，早先只看 URL 的判据可能被导航欺骗）。分界收窄到壁纸 surface 自身的拆除路径；未测候选只剩 wry 两条 drop 路径的时序差异、壁纸 surface 的周期求值/页时钟触发点、以及壁纸页本身（1.7MB 文档 + 事件流），要再往下需要 wry 级探针或产品临时插桩。 故障矩阵另补三条交错（歌词回复迟于新鲜度期限 2996ms 过期且迟到回复不复活、双 scope 同时 500 在 3053ms 一起过期后恢复、连续两次切曲只落 D3），同时发现并订正了上一批 runner 的注入缺陷——辅助函数曾被插进 `fresh()` 内部导致该函数空转，受影响的断言已用修好的 runner 重跑：原有十四项 **14/14**、新增三项全过。 另补 **50 轮启停**：复用目录上每轮都就绪、exit=0、归属树清空，基线零漂移（进程句柄恒 15、线程 21、归属实例 8）；**壁纸启用态再跑 50 轮**（每轮启用并等 pageReady）同样零漂移（21 / 22 / 9，155 秒），把带 churn 的重启卫生也量了；锁屏/显示切换仍需用户在场。 第三组「结构性畸形响应」9/9 通过（歌词 `positionMs` 类型错在 3048ms 只清该 scope、缺 `track` 被容忍），并**判读了那处看似的壁纸/歌词不对称**：分界不是 scope，而是响应体里还有没有 `server` 块——身份闸门在类型解析前读它，非对象体被读成 Null 即被判身份失败（日志 `dbx_source_unavailable`），壁纸 scope 约 0.8 秒清空而非退避；影响面实测到 `source_invalid` 的「取消全部在途」会跨 scope 掐掉在途歌词文档并触发重取。记为 **P3-malformed-snapshot-classified-as-identity**，并已在工作区落地修复、重建候选后双侧回归通过（缺 `server` 3.09s/3.06s 退避且零身份日志，真会话不匹配 741ms 仍立即清空，见修复记录「落地到工作区并重建候选」一节）。 推广检查：只删 `server` 块时两个 scope 都在约 0.77 秒被清空（非壁纸专属、非非对象专属）；把 409 只投给文档响应时两个 scope 全程在线——只有身份闸门被牵涉。 诊断修复第二版（build `b7e9e2d6…`）在不改候选的前提下把分类修正与「无内容不持久化位置」一起验证：四条双侧回归全过、配置逐字节未变、十四项 14/14；跨构建对照证明 P3 是长期行为（上一版 774/785ms，候选 770/790ms，同样有身份日志）；边界用例：文档体非对象时重取 3 次、零身份日志、两 scope 在线（闸门不管文档）；快照 session 真不匹配时 716ms 清空且有身份日志（闸门本该如此）。 请求频率也已量化：持续 500 的 scope 三秒窗口请求数 2→1→1→0（12 秒 4 次），健康 scope 同期 48 次；不可解析文档 10 秒只重试 4 次。 另有 **122.7 秒八相位混合故障浸泡**：宿主全程存活、406 次请求、每相位表现与所属错误类一致、结束时两 scope 在线且新文档落地。 另补两条 I/O 分类用例：运行中移走发现文件 → 内容保留、约 2.4 秒按新鲜度过期、改回后 1.5 秒恢复；移走歌词钥匙 → 仅该 scope 在 0.55 秒清空、壁纸在线、改回后 1.9 秒恢复；并观察到「普通写回」的恢复会被私有文件检查判成身份失败。 再有崩溃顺序用例：请求在途时杀掉夹具对端，宿主存活、内容不被误清、两 scope 在 2.36 秒按新鲜度过期，换新 session 的第二个夹具在 2.49 秒恢复。 另补两条交错：新 session 直接替换旧 session 时页面 0.91 秒跟随且不沿用旧文档缓存；同 key 换新 session 时页面只短暂空白 700ms 后重新落地（新会话重取 1 次），历史「永久空白」缺陷仍为已修。连续三轮「500→403→200+切曲」也都收敛（恢复 1.3/4.8/1.4 秒，中间一轮受退避累积影响）；跨类切换（500→403、畸形→403、403→500）也不闪回在线并能恢复；壁纸侧 500→403 同理；故障中途切曲时新文档一次都不请求，恢复后才取；设置中心在双 scope 断流四秒期间保持打开、恢复后仍开；10 分钟健康基线（39 采样）：两 scope 全程在线、句柄恒 21、线程 18→13 无增长、3642 次请求；另有 13 次重建跨 500/403/畸形协议三种故障相位（每段后强制恢复）的浸泡：每相位表现如预期、恢复均成功、进程句柄全程保持冷档基线 15；另完成组合场景：持续 500 时连续 3 次壁纸重建仍能挂载并最终恢复，且记录到 DBX 绑定宿主没有管理通道退出路径（v1 拒、v2 无此命令）；文档 403（快照 200）时文档被重取 2 次但从不落地、清状态后正常取回。 交替失效用例：两 scope 各自在约 3 秒过期、对方全程在线、恢复各 0.5–1.5 秒；文档级 500 时文档重取 2 次不落地而两 scope 不掉线。 夹具加过多个旋钮后，原有十四项在最新夹具上重跑仍 **14/14**，收尾时两个 WebView2 进程超过驱动的 15 秒清理预算但已自行退出（边界留档，不判产品失败）。现有受控故障用例已汇成**失败分类矩阵**（19 个错误类 / 29 个用例，逐条绑定到通过的报告，含两行记录 P3 现状的有意断言），见 `failure-classification-matrix.json`。中途 CDP 参照两次抛 `connect ENOENT`，我初判「宿主卡死」，取证否掉了它：宿主在抛错后仍连续服务三次 `status`、进程存活，失联点是驱动把 `wallpaper-apply` 绕过 `cmd()` 直发少了 pre-connect ENOENT 重试（该陷阱本战役已记过），补重试后完整跑通。**仍未取得受支持的释放/修复方案，也未定位 WebView2 内部持有者。完整非八小时验收与 D3b 未完成，八小时未启动。详情见文末三节及[审查修复记录](./2026-10-30-desktop-review-fixes.md)。

**当前最新结果（2026-10-30）：** `source-expiry-1793334922641/qualification.json` 已核对准确构建/输入及新包实际联调：新旧两版核心图形差分、两版授权/显式切源/胶囊与工作台生命周期、十二次伪造原生播控拒绝、sidecar 停止/强杀/同 key 恢复、native 先于 DBX 启动的等待，以及两版宿主正常/强制退出与重启全部限定通过。原生清理不再依赖 500ms 维护 tick，四次 sidecar 退出约 2.90–3.02 秒、四次宿主退出约 2.86–2.98 秒，均按原 3150ms 门槛核对；历史失败均保留。56 项原生单测、四组真实 WebView2、Rust 1.88/-D warnings、两版原合同 314/314 与 298/298、最低/当前 PluginHost、实际管道均通过。详情见[修复及验证记录](./2026-10-30-desktop-review-fixes.md)。**Process 句柄累积仍 open；完整非八小时验收/D3b 未完成；八小时未启动。** 以下按历史发生顺序保留各候选原范围，不能将其证据自动迁移到本候选。该候选随后又在本机补齐数据管道十四项、管理通道三项、壁纸自愈两项受控故障（首轮驱动失败保留），并完成 WebView2 155/156 运行时对照与只读 Authenticode 复核，见文末「新鲜度候选的故障注入与运行时版本对照」；这些都不改变句柄项 open 与签名缺口。

**本轮后续已授权补验更新：** `orbit-grid-1793331262051/` 两版授权/显式切源和胶囊/关闭工作台/最小化恢复通过，但 Standard stop 后原生内部状态约 **3294.50ms** 清理，超过原 3150ms 门槛，`authorized-1793333785518/authorized-comparison.json` 保持失败。已定位 500ms 维护 tick 的清理延迟，`source-expiry-1793334922641/` 仅改 native 事件循环按实际新鲜度截止唤醒；56 项原生单测、组件构建/验包通过，准确配套插件和真实同门槛复验仍在进行。详情及原失败见[审查修复记录](./2026-10-30-desktop-review-fixes.md)。本段取代下段补验前的候选整体状态，不覆盖其有限通过证据。完整非八小时验收/D3b 仍未完成。

**2026-10-30 本轮最新状态：** 准确新候选为 `output/dbx-desktop-d3/orbit-grid-1793331262051/`，原生输入/组件保持前一审查修复候选不变，插件仅补星轨舞台网格修正。新包原合同 314/314、298/298、最低/当前 PluginHost、真实管道及官方 0.6.47 历史包/新包两版核心图形差分全部通过；主树与冻结/打包输入逐项一致。真实宿主已正常退出且用户全局文件保持。详见[本轮审查修复记录](./2026-10-30-desktop-review-fixes.md)及该候选 `review-qualification.json`。**WebView2 Process 句柄累积仍 open；完整非八小时验收和 D3b 仍未完成，八小时未启动。** 以下保留各历史候选原范围，不能将其通过结论自动迁移至本批。

**上一轮结论：D0–D2 已实施；该轮冻结候选为 `shutdown-barrier/`，D3b 尚未完成。** 按用户要求优先验证八小时之外的项目：最终两版当前宿主核心图形差分、无授权与已授权生命周期、两版伪造播控拒绝、指定三来源切换与独立 Standard 播控恢复、GUI 保存失败/重试、zip 升级/备份恢复、真实运行中错误 build 拒绝、实际重复点击/撤销重连及卸载恢复已有新证据。壁纸渲染页崩溃后约 10.6 秒自动重建；后续确认 CDP frozen 未真正停住动画循环，有效停转注入后约 9.6 秒 watchdog 重建通过。实际目录移动/显式重绑、两版独立 scope 故障/恢复、运行中歌词修订/无词及最低宿主核心图形差分也已补齐。最新又完成真实 Full 在线准备缓冲、两版设置页八项管理异常及每版十五项原舞台/空间流程的历史包/最终包对照，见文末两节及 `final-production-buffering-and-gui-faults.json`、`final-stage-ui-baseline.json`。原长稳约 87.75 分钟后正常结束，原异常保留且不计八小时通过。用户只有这台 Windows 设备；其余故障组合、物理系统恢复、发布资源预算、身份及其他平台等缺项继续保留，历史记录中的待验项以文末最新证据更新，历史候选不混用。

2026-10-30 最新补充：shutdown-barrier/ 退出等待候选通过两版真实 native 应答/生产停滞恢复/大歌词切曲修订共十四项，现又补齐准确新 Full 的真实在线准备缓冲与 43 行歌词恢复。随后补齐两版独立慢文档/同 key 超时重取、切曲旧文档取消及频谱传输年龄共六项。又补齐新包房间切源的三种空态防护/原权限与离场后原生本地暂停恢复；窄端点房间权限路径未验。原生句柄保留仍 open，完整非八小时验收/D3b 未完成。共享主树多项修改另有变化并已留观察，不属于该冻结候选；详细范围、失败与清理见文末。

15:55 历史补充：独立采样工具通过三轮全指标对照、缺失根进程拒绝及五分钟 61 次采样，供下一轮完整运行使用，当时控制器/原 helper/计时未变。原 Standard WS 报告 `standalone-ws-1793259785871/report.json` 整体失败，暂停后连续三帧峰值 1、age 约 15ms；Full 未执行。`paused-spectrum/` 新插件指纹 `ab2eee4b…`，只改桌面频谱刷新条件，原广播保留。当时 D-A03、15、16 与完整长稳仍待新产物验证，后续结果按文末各候选的实际身份记录，不能把修正意图当通过证据。

## 受测候选与证据身份

以下第一张表保留歌词默认值阶段 `output/dbx-desktop-d3/lyrics-defaults/` 的已验产物，不包含白条增量修复。该批桌面/插件输入指纹为 `7cfc75b0cc581e046fbe48a98e2a357fdcfa83b4df8463f4259e7d5591306401` / `bcf2604dad22454a5d619a535e19953e128b172d831aa1eda5e08f72ca223f62`。本次冻结副本 `output/dbx-desktop-d3/nonclient-repaint/source/` 的 72/547 项输入指纹为 `7a3ed96e5877a896d8add4314074a41e0dc0fb048b6168a2b2b64a33fe3d2928` / `60cfec118666d2d5c04b2fa652353b7fd8826227815b6c112470852db5d10c4a`；与上一批逐项比较，仅歌词 `native.rs` 改变。共享舞台修改仍保留，不归为桥行为变更。

| 产物 | SHA-256 |
| --- | --- |
| 桌面 zip | `83bfc48e186330041888990e767d11440e3524e95fdbd8631bf14d8fa8dac446` |
| 桌面 exe | `830535bc5ba52277f3ef417f758780b8374d4eb781dd0ca09e23d2d37f0e4ac3` |
| Standard 包 | `6f7a43de4abf1fd70b19404a804c9e0f04545e98797688006006391a6abd6728` |
| Standard 包内 exe | `90b2d69579280114d0578190bb2c401cf0cf2deb5019fefc17b9de0a8d36e42a` |
| Full 包 | `a9df9301bfb2c120120e15b6bd55725dccb600b6ff5682177e05149f8c090405` |
| Full 包内 exe | `1a22c83809b91d9c16b62b3dfe172ad2f57b592faa09bd384e4e78485ccff955` |

两版实际 capability 的 `requiredDesktopBuildId` 均与组件的 `3c9ebad09b8224dedbf17b9a479b81be2f2fb5d53619336fd4e64348accd79c8` 一致，已在最低及当前真实 PluginHost 中断言。只读 `--describe`、zip/hash/PE、分版资源与权限的报告见 `component-verified.json` 和 `plugin-candidates/verified.json`。

最新白条修复后的配套候选来自 `nonclient-repaint/`：

| 产物 | SHA-256 |
| --- | --- |
| 桌面 zip | `e8885d3c699cc908aef740682a84bc548b1a0a42a22593ca816dc194bf52851c` |
| 桌面 exe | `a204336cd3ffd2abafb8a3906005dbbd41868f1f738f338f59985fd301e00620` |
| Standard 包 / 包内 exe | `9b91148c4778b00d184d4438ab62306b1dd0df3de3c66ff6d5c04d5ba411379f` / `9a730e22cf9fcc3f9c7d857c4f26f7db729c9526e7dbd460e4e669bff1f268b0` |
| Full 包 / 包内 exe | `fe9ea064a22a527288ce02cd017f3466f187407f905fd4f5b2e53118e154d60b` / `fb617addbab99c8e8d0754323affd5ba43fe40a3d20f97b4f97a7831b6096fb3` |

最新两版在最低/当前真实 PluginHost 共八组通过，实际 capability 的配套 build 为 `433e3ea53b69b9c8b9155f27732bc261f482756ac3bc771d129d7e5855b0dce2`，报告 `nonclient-repaint/runtime-final-1793241604060/verified.json`。原 stdio Standard 314/314、Full 298/298；Full 初次驱动漏传发行版预期导致一项检查失败，原日志保留，传准确 `HERTZ_EDITION=full` 后通过，未改产品迁就测试。

为保持证据范围，下面矩阵原有的“新候选/新包”仍指第一张表的歌词默认值阶段；最新白条修复构建新增结果在文末单列，不把前一批完整图形差分或 Linux ELF 冒充本批重新执行。所有报告位于任务输出目录；源码测试、协议 fixture、真实 sidecar 和图形宿主分别记录。

## D-A01–D-A18 核对

每行保留设计要求的完整范围。“仍需补齐”不因同一行已有部分通过而被豁免；尚无一份覆盖全部行、全部场景的新候选验收报告。

| 项目 | 已核对的证据及范围 | 仍需补齐 |
| --- | --- | --- |
| D-A01 本地曲与在线取词 | 最终两版的实际本地文档、播放真值及同来源壁纸通过；最终 Full 真实网易云搜索/取词/播放，原生收到 43 行。最终包内 sidecar 的真实本地歌词经文件/歌曲/全局偏移 100/300/-200ms 后，首行及首词均为 1200ms，偏移只应用一次。 | 单一公开曲目不代表所有在线源通过；不扩大当前发行版能力。 |
| D-A02 暂停、seek、快切、缓冲、歌词修订/无词 | 最终两版生产 sidecar 的真实暂停/seek/恢复、四次切曲往返、同曲修订/无词与旧 key=409 通过，见 `data-pipes-1793269486863/report.json`。原生文档恢复、换 key、迟到响应另有 native 专项覆盖。 | 最终真实 GUI 缓冲及慢文档/快切完整交错仍待验。两版真实 native 的运行中歌词修订、无词清空及原歌词恢复已通过；长稳计划干预按当前优先级暂缓。 |
| D-A03 真实频谱与失效 | 原最终两版真实 WS 的 64 段输入/自然过期及实际 native 暂停后的频谱归零通过；归零后环境动画继续。`final-authorized-lifecycle-1793288563286.json`。后续真实播放中欠载发现旧 FFT 重新记时，`stalled-spectrum/` 限定新候选的修正与真实恢复验证通过，见文末。 | 原最终包仍包含播放中欠载缺陷；新候选完整 DBX 图形联调及故障组合未全部重跑。完整长稳中的计划干预暂缓，scope 独立故障组合仍列 D-A18。 |
| D-A04 多来源与自定义目录 | 最终组件完成设计指定的独立 Standard → DBX Standard → DBX Full → 独立 Standard；每次双 surface 同 session，切回后原生暂停/恢复/歌词定位通过。实际宿主使用隔离的自定义 DBX_DATA_DIR，授权不自动切源。`three-source-standard-final-1793288106530.json`。 | 当前 Windows 实际移动整个 DBX_DATA_DIR 后，两版均经原生中心显式重绑、默认关闭与同来源双 surface 显示通过；授权/打开中心不自动改绑，原路径始终不存在，见 `rebind-1793296607750.json`。 |
| D-A05 迁移与提交失败 | 最终 release 实际加载 15 例、原子替换两种故障解除后的重试通过；51 项未变源码 native 单测保留原范围。最终 Full 活动 GUI 真实文件共享锁导致保存失败时保留草稿/旧配置/旧生效值，解除后同草稿重试成功；最终 zip 升级/schema2→3 一次迁移/旧包与配置备份恢复通过。`final-config-evidence.json`、`final-gui-config-failure-1793284174059/report.json`、`desktop-package-upgrade-1793286321712/report.json`。 | 本机加载、活动 GUI 提交失败/重试、升级和备份恢复子项已补齐；兼容结论只覆盖实际已测版本，不承诺任意旧版本直接读取 v3。 |
| D-A06 鉴权、撤销与身份隔离 | 新两版各六种无效授权恢复检查通过，文件保留且基础 RPC 正常；最低/当前真实运行时的有效双 scope 请求通过。历史授权/协议检查覆盖 scope、坏钥匙、代际与清理失败。 | 真实其他用户、其他交互会话、远程拒绝；完整逐步骤崩溃/重启及落盘失败矩阵。当前用户 SID/ACL 检查不能代替这些场景。 |
| D-A07 有界 I/O 与慢客户端 | 最终两版包内生产进程覆盖 UTF-8/JSON、零/超长/半帧、多帧、双 scope 各二/全局四个并发及超额拒绝，超时后槽位可再用；大文档不读取时实际回收两槽且不阻塞壁纸/SDK，句柄有前后观察。管理 EOF 六例取消及真实受保护管理管道中的撤销抢占通过，报告由 `plugin-verification.json` 绑定。 | 最终 native 慢文档与切曲/同 key 恢复的完整实际组合，管理 flush 阻塞的完整回收对照；协议夹具不能代替真实旧 GUI 管理宿主。 |
| D-A08 sidecar/宿主退出与恢复 | 最终两版各自正常 stop/强杀 sidecar、正常/强制退出真实 DBX 宿主并重启通过；约 1.1–1.6 秒清空旧音乐数据，组件存活且环境动画继续，新 session 重新取得同 key 文档。最终包内 EOF/旧冲突实例迟到退出另有生产进程证据。`final-authorized-lifecycle-1793288563286.json`、`final-authorized-host-exit-1793289612392.json`。 | 系统级挂起/恢复及各个 I/O 落盘失败点的完整交错矩阵仍待核对；当前正常/强制退出子矩阵不能替代所有系统状态。 |
| D-A09 工作台与宿主 UI 生命周期 | 最终两版无授权核心差分、真实浮动胶囊及最小化/恢复通过；本轮进一步完成已授权双 surface 读取期间的胶囊→展开、关闭工作台、原生宿主最小化/恢复，原 sidecar PID/创建时间及播放、同源歌词/壁纸保持。`final-authorized-ui-lifecycle-1793294938453.json`。关闭后 stop/activate 与队列/持久偏好保留另有记录。 | 当前 Windows/当前宿主的上述无授权和已授权子矩阵已补齐；最低宿主的两版核心无授权图形差分也已独立补验通过，范围及其余 UI/舞台缺项见文末。 |
| D-A10 无组件、不兼容与重复操作 | 最终无组件/未授权核心图形差分通过；真实历史组件 build 433e…运行时，两版设置页显示不兼容、禁用连接入口且原播放/队列不变。最终实际 UI 每轮连续 8 次点击在检测/打开/撤销/重新授权中各仅提交一次请求，授权不切源，撤销 Standard 不影响所选 Full。`final-wrong-running-1793291445325/report.json`、`final-ui-repeated-1793292522628.json`。 | 实际旧 management 协议宿主、丢应答和跨进程并发管理故障仍待验；历史 fixture 不替代完整真实宿主矩阵。 |
| D-A11 自启、移动与卸载 | 最终包实际卸载/重装通过：Standard 先实际卸载，Full 定时记录的 GUI 卸载后约 1.45 秒清空双 surface；原生进程/共用配置/组件字节不变，业务数据保留；两版原包重装后 Full 队列及新会话双 surface 恢复。`final-uninstall-1793293699287.json`。 | 自启早于 DBX、不同 build 并存的完整流程仍待验。Standard 卸载发生于计时前，不宣称其卸载延迟已测。 |
| D-A12 安装、配套与恢复 | 最终两版包/组件 hash、资源、权限、最低宿主/配套 build 通过；最终 zip 实际安装、运行中 EBUSY 保持旧文件、正常退出后升级、schema2→3 一次迁移及旧包+配置备份恢复通过，`desktop-package-upgrade-1793286321712/report.json`。 | 正式分发资格、运行中真实错误组件后的完整基础可用性。当前仅本地 unsigned 候选，未签名或商店发布。 |
| D-A13 原生恢复与八小时 | 最终组件默认单行无边框、深浅主题/滚动条、实际 Win32 设置开关/重绘、锁定透明/no-activate 样式、位置编辑临时解锁与取消恢复通过。真实壁纸 renderer 崩溃后约 10.6 秒 watchdog 重建，原 DBX session/绑定/配置保持。原长稳 168 样本约 87.75 分钟，按优先其他项目正常结束，非八小时通过。`final-native-recovery-1793291196125.json`。 | 完整八小时及计划干预、实际鼠标命中穿透/托盘找回、物理锁屏/断屏/Explorer/WorkerW 恢复；CPU/内存/GPU 绝对发布阈值尚未冻结。 |
| D-A14 不支持平台与旧后端 | WSL2 Linux x64 两版实际编译、原 stdio 311/311 与 295/295、全新/已有授权四组 unsupported 行为通过。既有浏览器检查覆盖缺 capability 的旧后端。 | macOS、ARM64 的当期基础插件实际构建/运行；不能以 Linux x64 或 Windows cfg 推断通过。桌面组件不因此承诺支持这些平台。 |
| D-A15 原合同与房间 | 新包原 stdio Standard 314/314、Full 298/298，双 scope 阻塞房间 EOF 及管理 EOF 均通过；Windows MSRV 1.88.0 检查通过。新配套独立 Standard 服务（SHA-256 `ff3bb1495c6bd709ae94024914679fb750780c0db8b4c5d42f9d666bb198055e`）的实际 HTTP/native launch、status、样式保存、壁纸 launch 与正常退出通过，报告 `lyrics-defaults/standalone-http-1793238990826/report.json`。 | 整理最终候选全部原合同场景；该 Standard 静音隔离回归不代替 Full、声学或完整房间/生命周期矩阵。 |
| D-A16 DBX 单独使用无行为变化 | 最终两版与本轮提交基线在相同当前宿主/数据完成核心图形差分：播放/seek/队列、约一分钟定时、主题/预设及工作台关闭重开、八类 MediaSession 注册一致；最终两版均零新增桌面请求、无桥文件、gate/listenerReady=false。原 Standard boundingBox 失败保留；未改原脚本，后续运行通过。 | 物理系统媒体键、声学、原 UI/舞台其余流程及已授权故障完整基线对照。最低宿主两版核心图形对照另已通过，见文末。注册 MediaSession 不等于媒体键输入；核心流程通过不等于整行所有场景完成。 |
| D-A17 只读播控与独立版恢复 | 最终两版实际 native 工具条禁用；两版在播放中/暂停中各伪造 pause/seek/play，共 12 次实际 IPC 均被拒绝，播放真值/进度/代际/绑定保持。指定独立 Standard 三来源切换后的原生暂停/恢复/歌词定位通过。`final-authorized-lifecycle-1793288563286.json`、`three-source-standard-final-1793288106530.json`。 | 切源后的房间权限实际组合仍待验；独立服务原房间合同不替代切源组合。 |
| D-A18 新鲜度与路径身份 | native/feed 专项覆盖慢快照、重复 seq、队列延迟、同 key 恢复及独立 scope 时钟。最终两版包内实际大小写/扩展前缀/junction 并发发布均返回来源冲突，原 owner 发现不变，基础 state/queue/settings 不受影响，报告 `data-pipes-1793269476860/report.json`。 | 真实延迟投递/重复倒退 seq 与超时交错的最终组合仍待验。两版真实 native 的歌词/壁纸独立钥匙失效、另一侧持续更新和原 key 恢复通过；此证据不等于延迟响应/投递寿命通过。 |

## 当前等待与后续顺序

新候选长稳会话为 `output/playwright/dbx-desktop-gui-baseline-1793236714419/soak/`，开始于北京时间 2026-10-29 09:29:02；34 个样本、约 17.20 分钟后资源采样子进程失败，控制器于 09:47:04 结束并主动请求两端退出。两端 exit=0、组件 forced=false、binaryUnchanged=true；宿主窗口状态恢复、globalFilesChanged=[]。旧驱动未保存 code/signal/killed/stdout/stderr，不能断言具体原因为超时、产品崩溃或系统睡眠。事后原始样本复核 findings=[]，但样本不足以形成长期结论。旧候选约 38.82 分钟后原生退出的失败报告独立保留，原因未确认，不与本次采样失败混为一谈。

观察器修复现已通过实际子进程检查：首次采样 exit=9 时保存完整失败字段，5 秒后重试，原根 PID 仍存活且未重启；原进程真实退出后按 ESRCH 拒绝。报告 `output/dbx-desktop-d3/observer-retry-1793239501167/report.json`。修复只在本地驱动，保留原单调时钟与大于 120 秒采样间隔的失败门槛。重跑必须新建完整八小时，不累计前两次分钟数；结束后复核干预、原始样本、增长和趋势，再检查双方监督退出、全局文件恢复及专属进程无残留。新配套 Standalone HTTP 已在无冲突实例时通过，切回实际在线独立版及其他缺项仍待验证。

第三次真实运行于 **2026-10-29 10:12:07（北京时间）** 开始，目录 `output/playwright/dbx-desktop-gui-baseline-1793239677882/soak/`。两版真实 UI 首次授权、默认 single/bare/bilingual=false、分别启用及 Full 43 行真实在线歌词均再次通过。用户随后提供点击设置时标题栏复现截图；15 次开关、2000 次 Win32 观察的 style/客户区均正常，不能据此否定用户截图。为验证新增非客户区绘制修复，于 **10:25:48** 记录 `requested-stop.json` 后请求原组件正常退出，控制器在 **10:26:09** 按原规则结束。共 27 个样本、约 13.51 分钟；双方 exit=0、原生 forced=false、DBX 窗口状态恢复且 globalFilesChanged=[]。事后 findings=[]，但运行时长不足，不能算长稳通过。该轮是有明确意图的验证中止，不归因为采样故障或产品崩溃。

增量修复在歌词窗口处理 `WM_NCCALCSIZE` / `WM_NCPAINT`，并以 no-repaint 参数保留原 `WM_NCACTIVATE` 焦点处理。MSRV 1.88 构建和 51 项 native 测试通过；真实 WebView2 重复设置开关、样式刷新与激活重绘检查通过，证据 `output/playwright/desktop-lyrics-native-1793240787299/`。此时第三轮已经停止，须等待新 release 配套候选重建后重新执行原生检查与真实宿主联调，再从零开始八小时；后续结果见下文。

后续新 release 组件构建、验包及原生复验已通过：`nonclient-repaint/native-regression.json`，实际 WebView2 证据 `output/playwright/desktop-lyrics-native-1793241339089/`。两种样式共 12 轮设置开关、29 次 Win32 检查通过；exe SHA-256 `a204336cd3ffd2abafb8a3906005dbbd41868f1f738f338f59985fd301e00620`，desktopBuildId `433e3ea53b69b9c8b9155f27732bc261f482756ac3bc771d129d7e5855b0dce2`。本条记录时两版配套 `.dbxp` 尚在构建；随后已完成，结果如下，长稳仍未完成。

## 白条增量候选的后续完成与第四轮长稳

`nonclient-repaint/plugin-candidates/verified.json` 已核对两版最终包的 metadata、checksums、安全归档、x64 PE、原权限与最低宿主、逐字分版资源、Standard 裁剪及不夹带桌面 exe。包内原 stdio Standard **314/314**、Full **298/298**；最低 0.6.35 / 当前 0.6.47 的真实 PluginHost × 两版 × 未授权/已授权共八组通过，实际 capability 的配套 build 为上述 `433e…`，报告 `runtime-final-1793241604060/verified.json`。这些是本次最终包的实际检查，不借用上一批包的结果。

真实图形会话 `output/playwright/dbx-desktop-gui-baseline-1793241731703/` 再次安装这两版新包。首次 Standard / Full UI 授权均 `consentClicked=true`，授权不切源；新 profile 的 single/bare/bilingual=false、两项 enabled=false 经实际读取。显式切源启用、同来源歌词/壁纸、DBX 播控拒绝及 Full 43 行真实在线歌词通过，报告为 `connect-standard-1793241832294.json`、`connect-full-1793241939743.json`、`native-session/activate-standard-1793241926308.json`、`activate-full-1793241991874.json` 和 `real-online-lyrics-1793241995325.json`。新实例的设置开关 15 次、Win32 观察 2000 次无 frame/几何异常，报告 `native-session/settings-frame-1793241996227/report.json`；不据此承诺间歇绘制问题已经绝无复发。

第四次真实八小时从北京时间 **2026-10-29 10:48:30.159** 开始，预计 **18:48:30.159** 后结束，目录为本次图形会话的 `soak/`。DBX / native / controller 原 PID 为 **32320 / 8980 / 27916**，监督工具会话为 **65140 / 65039 / 50378**，记录 `nonclient-repaint/fourth-soak-handles.json`。本次接续时已通过原三个工具句柄确认仍在运行；不重启、不累计前三轮时长。仍需原 2/4/6 小时干预、完整资源窗口与增长趋势、正常退出和专属进程回收。此前独立 Standard HTTP/native 报告属于 `3c9…` 组件，不能充作本次 `433e…` 配套构建复验。

等待期间对本次两版包内生产 sidecar 完成隔离检查，均使用当前用户 SID ACL，不触碰长稳实例。`nonclient-repaint/data-pipes-1793242291983/report.json` 的 **54 例**覆盖双 scope 的零/超长/半帧、非法 UTF-8/JSON、尾随 JSON、缺/未知字段、多帧、错误 key/scope/session 与写动作拒绝；三轮实际双 scope 各两个挂起连接、全局四个，额外连接关闭且原四个仍挂起，约 2.05–2.07 秒后断连并可再次请求。阻塞期间 SDK health 约 12–20 毫秒；后续 40 次有效请求后句柄数为 **201→201 / 227→227**。普通 EOF 两版正常 exit=0，授权保留，同目录真实重启换 session 并恢复原授权成功。

`nonclient-repaint/data-pipes-1793242606414/report.json` 的 **6 例**使用大小写、扩展路径前缀和真实 junction 指向同一目录。原 owner 活着时第二实例均准确 `desktop_source_conflict`、gate/listenerReady=false；health/state/queue/settings 正常，原发现文件 hash、两 scope 应答与授权保持。非 owner 正常退出不会清理原发现，两个版本句柄差值均为零。该结果不覆盖慢大文档/慢读回写、跨用户/会话、图形宿主 kill、迟到旧 owner 清理或移动 DataDir；D-A06–08、11、18 的其余要求仍保留。

物理媒体键、声学、其他用户/会话和 macOS/ARM64 缺少当前证据；保留原要求，不用模拟注入、源码推断或测试数量替代。签名及对外发布尚未执行，不能把本地 unsigned 包作为正式发行资格。

## 11:33 接续补验：仍属于同一白条修复候选

对本次 `nonclient-repaint/` 包新增下列实际证据；仅补齐对应子项，不把原 D-A01–18 整行改为通过：

| 对应项目 | 新实际证据 | 尚未覆盖的边界 |
| --- | --- | --- |
| D-A08、11、18 | `owner-recovery-1793243578724/report.json` 两版 8 项：四半帧下强杀 owner，约 16.78/15.34ms 全断开；原发现残留后新实例接管，旧 session/管道拒绝；旧冲突进程在新发布后退出不删新记录；实际移动隔离目录后原授权、设置/队列、两 scope 恢复，最后正常退出。 | 是真实 direct sidecar，尚缺最终图形宿主完整 kill/重启、native 旧目录重绑定、自启/卸载；旧冲突实例迟到退出不等于把旧 owner 清理越过独占租约。 |
| D-A06、07、16 | `data-pipes-1793243861708/report.json` 两版 10 项：真实授权文件占用导致持久撤销失败，但 live gate 关闭并取消四客户端；真实重启恢复旧 consent。解除占用后显式重试持久禁用，key 占用另报 cleanupIncomplete；残留 key 下真实重启仍禁用，释放后清理重试成功；原基础 RPC 均正常。 | 尚缺跨用户/会话、逐步骤崩溃矩阵，以及全部已授权故障下与历史图形基线的行为差分。 |
| D-A01、02、07 | `data-pipes-1793244522293/report.json` 两版 10 项：真实 WAV/导词/原 RPC 播放与实际管道，文件+单曲+全局偏移只应用一次；pause/seek/play、四轮换曲、同曲改词与无词通过。784844 字节实际文档停读，只收到 65540 字节后 EOF，原客户端仍暂停时两个槽位已能再接入，另一 scope 和原 RPC 正常。 | null 音频的生产 sidecar 投影，尚缺图形 native 的缓冲/投递插值、所有在线源、慢文档后同 key 的完整重试/切歌；扫描/加载前后句柄 +8，不宣称本场景句柄零增长。 |
| D-A15、17 | 同源 Standard/Full 独立服务 SHA-256 为 `3191d52c716e19e973f651a31612060101a482509d498d85c7e616007668452c` / `89176d0b4592eb9505c14cc6afa98745f78bbf48b2feceddac537e40c466960f`；`standalone-http-1793244203009/report.json` / `standalone-http-1793244660047/report.json` 验证实际发行版、HTTP 原路由、精确配套 build、正常 exit=0 和既有 native 进程保留。 | 仅 HTTP-only；本 build 的 native launch/control、显式切回实际独立版及原房间权限仍待后续无冲突场景。 |

长稳原三个工具句柄本轮确认仍 live，进行中复核 85 样本/43.76 分钟、findings=0、controllerIssues=[]。未达八小时、完整干预或末段资源窗口；发布预算及其他物理/平台要求保持。共享主工作区另有五个在线播放/搜索文件变化，清单见验证记录；本次实际包仍绑定已逐项验证的 `60cfec…` 冻结输入，不把新主树内容视为已经验收。

## 12:18 接续：补齐子项与构建身份问题

| 对应项目 | 本次证据 | 仍保留的边界 |
| --- | --- | --- |
| D-A10、12、16 | `component-rejection-1793245733615/report.json` 两版 10 项，实际缺组件、旧组件、损坏 exe、配套组件待手动启动、manifest 真读取失败，均无授权/桥/启动，基础 RPC 正常。 | 尚缺运行中的实际旧 native GUI 与响应丢失组合；不把组件文件检查当图形完整生命周期。 |
| D-A06、07、10 | `management-interleaving-1793245946202/report.json` 两版 6 项，真实保护管道与协议夹具验证错 build、8 并发只一个 open、revoke 取消、旧结果不能复活、显式重连与重复凭据稳定。 | 使用协议夹具，不是实际旧 GUI；当前用户/会话，不代替跨身份及逐步骤崩溃矩阵。 |
| D-A08、15 | 本批 `room-eof-{standard,full}.json` 与上级两版 `management-eof-…/report.json`，实际双 scope/房间 discovery/管理等待 EOF 均正常退出并取消，guest 清 membership。 | null 音频和 loopback TLS；不是完整房间权限/native 播控回归。 |
| D-A12、14 | Linux 首轮身份错误明确作废，相关两包 clean 后重新构建，两版 stdio 311/311、295/295、四组 unsupported、实际 RPC 与独立身份复算通过，见 `linux-validation/build-identity-verified.json`。 | Linux x64 WSL2 debug；不等于 Windows release 或 macOS/ARM64 资格。 |

`acceptance-progress.json` 核对准确产物及 104 项包内检查，identityChecksPassed=true、d3bComplete=false。构建身份问题的生产修正已改主树两个 build.rs 和共用身份 helper，执行时读取本次源码目录并跟踪目录环境；A→B→A 共用缓存验证仍在进行。当前 `433e…` 长稳与全部上表包证据不包含这项新源码修正；后续需另冻配套产物并评估回归，不能覆盖原身份记录。原三个监督句柄仍 live，复核 172 样本/89.13 分钟、findings=0；完整八小时、干预与发布预算仍未完成。

A→B→A 后续实际验证通过，共用 target 不清理、复用同一已编译脚本，三次实际 RPC 身份均等于对应源码独立复算，回到 A 的程序字节也相同。修正后的候选另冻 `build-root-fix/`，仅改变两个 build.rs 和共用 helper；72/547 项输入指纹为 `596f2543…` / `eb6a0a73…`。Linux 两版原 stdio、四组 unsupported 与实际身份通过；新 Windows `07d87e…` 组件已构建/验包，配套包和 Rust/MSRV 检查仍待本轮完成。未运行新组件 GUI；原 `433e…` 的约 109.08 分钟/210 样本长稳只登记在原身份下。D-A12 新配套构建、D-A13 长稳与其余完整 D3b 条件继续保留。

## 13:18：构建目录修正候选已验配套包

`build-root-fix/acceptance-progress.json` 已通过产物和证据核对，状态仍为 partial-acceptance。新桌面 build `07d87e7635ccc3ab86217fd6fb22163547d6e1cdc4110eee5aa1f2c6c2d661fd` 的组件、Standard/Full `.dbxp` 已同源验包；构建后 547 项输入不变，实际 RPC 与逐文件独立复算身份一致。51 项 native、MSRV 1.88/-D warnings、cpal 原 stdio 314/314 与 298/298、最低/当前真实 PluginHost 八组均通过，另保留 null 的 311/311、295/295。

本候选尚未运行 GUI或构建其新独立服务：原 `433e…` 组件的图形/HTTP、104 项生产包检查与长稳仍各归原身份。原长稳约 120.13 分钟的暂停/恢复通过；13:18 核查原三个句柄 live，285 样本/149.08 分钟、findings=0、controllerIssues=[]、最大采样间隔约 48.74 秒。还没有 4/6 小时干预、末 30 分钟资源或八小时/退出结论，D-A01–18 其余缺项继续保留。

## 13:49：新候选补验与长稳不合格间隔

`07d…` 新包自身已通过 104 项隔离检查：54 项坏帧/权限/回收、6 项路径别名、10 项真实文件占用撤销/重启、10 项真实 WAV/大文档、8 项 owner 接管/移动、10 项组件异常及 6 项管理并发。`build-root-fix/supplemental-reports.json` 核对每份报告的准确 candidate/hash/exe/build；两版管理 EOF 六例亦通过。管理并发仍为真实管道+协议夹具；本地播放含扫描/加载的句柄差值 +9/+8；当前用户/会话、null 音频和 direct sidecar 的限制保留。新配套独立服务正在构建/HTTP-only 复验，新图形实例仍未运行。

第四轮原 `433e…` 长稳连续 17 次资源查询超时后恢复，实际 **538181.73ms** 采样缺口超过 120 秒门槛。`nonclient-repaint/soak-observation-gap.json` 与原始控制器/分析报告一致，**该轮不能通过完整长稳验收，即使后续满八小时**。13:49 核查原三个 PID live，329 样本/180.48 分钟，原进程与单调计时保留。2 小时暂停/恢复已通过，4/6 小时干预、末段及退出仍可作为部分证据；不得填补缺口或合并前轮。采样 helper 已增加仅 stderr 阶段诊断并实测正常，未改门槛，先前超时原因未确认。D-A13 仍需准确合格候选的新完整长稳；D-A01–18 其余缺项和 CPU/GPU 绝对发布预算保持。

14:04 接续：新候选 Standard/Full 配套独立服务已构建完成，实际 HTTP 报告核对发行版、原路由、正常退出和 `07d…` 精确配套身份。两版新包+新服务的房间 EOF 亦通过，真实双 scope 半帧阻塞、房间 discovery 在途及 guest membership 清理均有原报告。`build-root-fix/acceptance-progress.json` 已核对 104 项、两版管理 EOF、HTTP/房间 EOF 的准确文件/hash，保持 partial-acceptance、d3bComplete=false、graphicalNativeVerified=false。未启动新 native，不能代替独立版切回/窄播控与完整房间权限；原长稳进程未重启。

14:36 接续：新包两版共 6 项实际激活失败/强杀/重启/显式恢复组合通过，见 `activation-failures-1793255575972/report.json`。授权替换的真实 sharing violation、发现文件被目录阻止和 writer lock 目录冲突均保持原空闲状态/队列/设置；失败后 gate/listener 关闭，key 残留不授予 consent，恢复后真实两 scope 请求成功，最终撤销与正常 EOF 通过。该结果补 D-A06/07/08/16，不能代替逐指令崩溃、图形基线或活跃声学。两次新 native 尝试在固定单实例门槛正常退出，未通过 GUI；错误的路径隔离假设已纠正、临时副本删除、检查器保护恢复，并修正失败清理的共用 quit 风险。`native-guard-verified.json` 实测保护拒绝启动、无新 fixture 目录且原三 PID live；成功 WebView 清理分支与新候选图形继续待验。

14:51 接续：新候选的两版独立服务通过新组件现有无窗口 feed CLI，各取得 5 次实际 HTTP 快照，原空闲状态与 seq/session 一致，服务正常 exit=0；报告 `standalone-feed-1793256517118/report.json`。先前夹具缺 width 的失败保留，未改产品。只补 D-A15 的实际 feed，不冒充 GUI、WS 或原生管理。原 `433e…` 长稳四小时撤销/重连通过，约 191ms 清空/806ms 恢复；`nonclient-repaint/soak-interventions-2h4h.json` 核对原三 PID live、二进制不变。原 8.97 分钟采样缺口继续使该轮不合格；六小时 seek、末段/退出仍待完成，新 `07d…` GUI 和完整长稳仍待验。

15:08 接续：原 `433e…` 长稳又出现 210590.92ms（3.51 分钟）采样间隔，连同早前 8.97 分钟缺口，共 25 次观察失败、两项 sample-gap；474 样本/260.25 分钟，原三个 PID live，仍保留原计时。阶段标记覆盖进程/GPU 查询，另有一次 completed 后超时，均保持失败，根因未确认；不补样本或放宽门槛。更新的 `soak-observation-gap.json` 反映当前状态，14:51 干预报告仍保留历史事实。D-A13 不能通过；新候选 GUI、完整长稳及全部 D3b 缺项继续待验。

## 16:34：暂停频谱新候选的实际验收边界

2026-10-29 16:34 接续：`paused-spectrum/` 两版配套独立服务已构建并通过原 HTTP-only、真实 cpal/WS；播放中实际频谱非零，主观众离场原规则暂停后 age 超过一秒、peak/energy 归零，重连保持暂停直到显式播放，打开流时正常退出。准确两版 SHA 和报告见验证记录。Standard 房间原合同 21 项、60 秒静音 WASAPI PCM/三采样率/自然切曲/零 underrun-resync 通过；Full 两次分别遇连接中断和实际 PCM underrun，保持失败待排查，未变断言或产品音频逻辑。Standard 插件已打包、Full 继续构建；547 项源输入实际复算仍为 `ab2eee4b…`。原长稳 16:27 三 PID live、619 样本/338.45 分钟、26 次观察失败，两个已知缺口继续使其不能合格。新候选最终 GUI、原生管理播控/切源及完整长稳仍待验，D3b 保持未完成。

新索引 `paused-spectrum/acceptance-progress.json` 已绑定实际两版服务 SHA、HTTP/WS 和全部房间成功/失败报告；`wsRegressionPassed=true`，`roomRegressionPassed=false`，`graphicalNativeVerified=false`、`d3bComplete=false`。Standard 的 21 项房间合同只能补 D-A15 对应发行版；Full 的连接中断及 underrun 必须保留。D-A03 已有新两版真实 WS 过期证据，但仍需最终 native 场景/环境运动验证；新插件原合同及 D-A16 图形差分尚待新产物执行，不以服务通过替代插件通过。

## 17:30：最新候选与阻塞 EOF 验收边界

17:30 更新：`paused-spectrum/` 的两版服务和 `.dbxp` 已构建/验包，构建后 72/547 项实际源输入仍为 `596f2543…` / `ab2eee4b…`；桌面输入与 `07d…` 组件字节未变。新包 Windows cpal 原 stdio 314/314、298/298，最低/当前真实 PluginHost 八组、独立实际 RPC 身份复算、104 项包内隔离检查、管理 EOF 六例及实际激活失败/强杀恢复六例均通过。新两版服务原 HTTP/WS、暂停后频谱自然过期和两版 21 项房间合同通过；Full PCM 第三次在构建结束后通过 60 秒、三采样率/自然切曲、零 underrun/resync，前两次连接中断/欠载失败保留，未确认其原因。新 Linux x64 两版原 stdio 311/311、295/295、四组 unsupported 和实际身份复算通过；不是 macOS/ARM64 或 Windows 图形资格。

授权阻塞下的房间 EOF 仍不合格：Full 首轮异常退出、一次复跑成功；再用三个交错对照轮次，暂停频谱修正前的 `build-root-fix` Full 失败 1/3、新 Full 失败 2/3，均保留实际退出码 `3221226505` 和 SDK worker 的 Tokio timer shutdown panic。另以提交 `1d042b8` 的准确 Full 包和新 Full 运行未改的原无授权/无阻塞 EOF 检查，各三次正常，不能据此认定提交基线也有该 panic，或完整已授权故障矩阵无变化。最初提交基线对照因夹具路径错误未启动，已单列作废，不能充作产品失败。新候选图形、原生管理播控/三来源切换、此退出缺陷和完整长稳仍待完成；没有修改 SDK、原音频或退出实现迁就检查。

原 `433e…` 第四轮长稳的 2/4/6 小时干预已全部通过；六小时 seek 在北京时间 16:48:51 将原播放跳到 5000ms，约一秒后实际进度 6020ms，继续播放且原二进制不变。17:30 原三个 PID live，738 样本/401.48 分钟、累计 26 次观察失败；两个原采样缺口继续使该轮不能合格。末段资源、正常退出和专属进程回收继续原控制器，预计原结束点仍为 18:48:30；新候选没有运行 GUI/长稳，不能借用该轮身份或累计时间。

D-A03 有新两版真实 WS 的有效频谱和自然过期证据；D-A15 有两版完整房间 PCM 和原无授权 EOF 的提交基线对照。D-A08/15/16 的已授权阻塞退出场景实际失败，保持待修复；没有因同轮其他检查通过而关闭整行。最终 GUI/原生管理/三来源切换及 D-A13 的新完整长稳仍未执行，D3b 保持未完成。


18:36 接续：房间 `Discover` 已复用既有 `RoomManager::starting` 退出取消入口。原发现主体、其他房间分支、SDK、进程退出屏障及音频实现均未改；只在退出信号到达后停止轮询挂起的发现计时器。新冻结 `output/dbx-desktop-d3/shutdown-discovery/` 的插件 547 项指纹为 `171524606d174dbe68eaf07ee8b30478d98bb6a36f1197069c9b604275329daf`，桌面 72 项输入与 `07d87e…` 组件字节保持不变。`shutdown-timer-verified.json` 独立核对发现主体去空白完全相同、分支外源码完全相同。真实旧→新探针保留同样的挂起请求、第二请求 busy、服务 shutdown、销毁 runtime 后再轮询：旧实现确定性 panic，新实现返回 `room_shutting_down`。探针为 Linux debug/unwind，Windows release 实测另列。

补查保留 stderr 后，修正此前“原无授权 EOF 六次正常”的解释：准确提交 `1d042b8` 的 Full 在 **1/3** 次、暂停频谱候选在 **2/3** 次写出同一 Tokio shutdown panic，尽管六次退出码均为 0。新交错对照中旧暂停频谱 Full 也有 **3/5** 次后台 panic、五次退出码均为 0。旧报告和日志保持原样，不能只凭 exit=0 判定无 panic。该补证确认未授权的原提交也存在此退出竞态。新 Full 共 11 次 Windows 退出实测（五次交错及配套授权/未授权各三次）、新 Standard 配套授权/未授权各三次均无该 panic，授权、Host End 与 guest membership 原断言保持；索引保留原失败与日志 hash。

新两版 `.dbxp` 和配套独立服务已实际构建/验包，72/547 项 Windows、Linux 源输入前后复算一致。Windows cpal 原 stdio **314/314、298/298**、最低 0.6.35/当前 0.6.47 真实 PluginHost 八组、104 项包内隔离检查、管理 EOF 六项、激活失败/强杀恢复六项及实际 RPC 独立身份复算通过；Linux x64 原 stdio **311/311、295/295**、四组 unsupported 与实际身份通过。房间模块原有 12 项测试、两版原 HTTP/WS、暂停频谱自然过期、各 21 项房间权限及 60 秒静音 WASAPI PCM/三采样率/自然切曲/零 underrun-resync 通过。文件和 SHA 见 `shutdown-discovery/acceptance-progress.json`，状态仍为 partial-acceptance、`graphicalNativeVerified=false`、`d3bComplete=false`。

最终组件 GUI、成功 WebView 清理、独立版原生管理/播控恢复和三来源切换待验。原 `433e…` 第四轮仍保留同一进程、时钟和不合格采样缺口，不能代替本候选的完整八小时，原结束点仍为 18:48:30。CPU/GPU 绝对发布预算、物理身份/平台/桌面恢复等 D-A01–18 缺项继续保留。

最低编译器检查的输出相对路径曾多退一级，覆盖任务顶层旧 Full MSRV 日志。旧 Full 历史日志已标记不可用，不能用新结果补冒旧证据；旧 Standard 日志在覆盖前已按原 SHA 保存并完整恢复。新冻结两版实际 1.88.0/-D warnings 检查均通过，归档为新候选 `msrv-full.log` / `msrv-standard.log`；`validation-log-path-correction.json` 记录错误、原 Standard SHA 与新结果 SHA。源码及产物未变，历史资格仍按当次保留证据的实际范围使用。


18:58 接续：原第四轮于 18:48:50 按原控制器结束，实际 28820568.7423ms、890 个样本、2/4/6 小时干预全部通过；26 次观察失败和两个原采样缺口保持，`measuredEightHours=true` 但 `passed=false`，不能作为完整长稳资格。DBX 与 native 均正常 exit=0，native forced=false；DBX 窗口状态恢复、globalFilesChanged=[]，末样本的 20 个原归属进程实例经只读 Win32 查询已不存在。原内存窗口比较在原阈值内，但不据此宣称无增长或发布预算通过。报告为 `nonclient-repaint/fourth-soak-completion.json`，仍归原 `433e…` 身份。

随后最终 `07d87e…` / exe SHA `4d2906f4195c0b55cdd6df31b616225de2f30099d97acae3096e3a69ea60874a` 组件通过真实 WebView2 复验：两种样式各六轮设置开关、29 次 Win32 样式/几何/激活重绘检查；深浅主题截图经查看，单行、无边框及滚动条正确。检查器成功路径通过自己创建的 WebView 请求退出，并实际等待正常退出；`cleanup.json` 确认 forced=false、exit=0，不借用共用控制管道。证据 `output/playwright/desktop-lyrics-native-1793270931402/`，索引 `shutdown-discovery/native-regression.json`。新两版配套服务也通过真实原生启动、重复启动保持单实例、原 status/font/wallpaper-status 管理、非法命令拒绝和正常退出，原检查脚本断言未改。

这些补齐最终组件 fixture/成功清理及原独立版管理子项，不代替最终两版 DBX 图形联调、三来源切换后的原生播控恢复，或新候选完整八小时。`shutdown-discovery/acceptance-progress.json` 已绑定准确 hash、截图与报告，`graphicalNativeVerified=false`、`d3bComplete=false` 保持。

## 21:28：最终候选当前结论

最终两版在真实当前宿主的同来源歌词/壁纸显示、DBX 只读工具条、Full 在线取词，以及切回实际独立 Full 后恢复同 session 原生暂停/播放/歌词定位通过。准确文件、SHA 与原始失败保留在 `shutdown-discovery/final-graphical-progress.json`；完整范围见[验证记录](./2026-10-28-dbx-desktop-evidence.md#2128最终包图形子项与新八小时运行)。本轮三来源使用独立 Full，设计指定的独立 Standard 仍待验。提交基线两版图形流程通过，但最终 Standard 的 after 流程在进度条 boundingBox 超时，最终 Full after 未完成，所以 D-A09/10/16 不得记为最终图形回归通过。

此前 native 监督脚本的一小时期限导致强制终止，原 forced=true 报告保持；不作为产品崩溃或正常清理成功。随后复用同一组件/配置的新实例与 DBX 已于北京时间 **2026-10-29 21:03:58.417** 从零开始完整八小时，预计 **10 月 30 日 05:03:58.417** 结束；controller/DBX/native PID **8988/16964/1916**，工具会话 **92936/22229/21224**。21:28 实际句柄/进程存活、45 次采样无 issues；尚未完成 2/4/6 小时干预、末段资源与退出回收审计，不能计为长稳通过。

用户确认目前只有这台 Windows 设备。其他用户/会话、macOS、ARM64 的真实验证缺项继续保留；物理媒体键、声学和最终候选的锁屏/断屏/Explorer 恢复尚无实测证据。CPU/GPU 绝对发布预算没有冻结。总状态保持 partial-acceptance、`graphicalNativeVerified=false`、`d3bComplete=false`。

22:09：D-A05 的最终 release 加载/迁移/坏文件保护与真实文件写入失败子项已补齐 15 例，两种解除故障后的重试通过。最终与原已测桌面 72 项输入逐文件相同，原 51 项单测日志 SHA 未变；17 项配置与 8 项 DBX feed 保留原 debug/fixture 范围，详见 `shutdown-discovery/final-config-evidence.json`。这补齐配置证据归档，不代替最终 GUI 草稿提交、安装备份恢复或完整发布验收。原八小时进程身份保持，完整时长、干预和结束清理继续等待原控制器。


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

继续优先验证八小时之外的项目。最终产品仍为 `shutdown-discovery/` 冻结的两版包与 `07d87e…` 组件，exe SHA `4d2906f4195c0b55cdd6df31b616225de2f30099d97acae3096e3a69ea60874a`；本批没有重建产品。新索引 `output/dbx-desktop-d3/shutdown-discovery/final-nonsoak-fault-verification.json` 复算六份主报告、产物、驱动和截图的 SHA，保留六份失败或中断证据，状态继续是 `completeNonSoakAcceptance=false`、`d3bComplete=false`。本节补充并更新上一节的待验范围，不修改历史报告。

| 对应项目 | 本次实际证据与边界 |
| --- | --- |
| D-A02、07、18 | `desktop-native-feed-faults-1793298247047/report.json` 六项通过。实际最终 native 连接受控认证管道：同 key 文档首次延迟 2300ms 超过原 2s deadline 后重试成功，等待期间快照继续；旧文档延迟 1500ms 时切曲，旧 I/O 取消且文档不进入新页；buffering 25%/恢复到达真实 renderer；歌词和壁纸各自收到回退 seq 后独立过期/恢复；壁纸慢响应保留至少 1300ms 的原年龄，旧频谱为零，不续完整寿命。**数据源是链接准确冻结 IPC crate 的测试夹具，保留真实私有管道、peer PID 检查和生产期限；不代表真实 DBX 在线音频缓冲已验。** |
| D-A07、10 | `desktop-native-management-faults-1793298731317/report.json` 三项通过。独立客户端实际写入 open-center 后不读应答并断开；查询确认已打开，同 requestId 重试仍仅一个中心。另有八个独立 Node 进程并发打开，全成功且保持一个 native/中心和原绑定。第三项客户端停读 2800ms，约 2318ms 时另一 status 已成功，feed/配置保持。实际原生管理服务受测，背景 feed 为夹具；不把它扩展为插件 GUI 的完整丢应答/撤销交错矩阵。 |
| D-A10、12、16 | `final-legacy-management-1793299039854/report.json`：从准确历史提交 `1d042b8` 归档源码、独立 target 与锁定依赖构建真实旧组件，SHA `ef70abcc…`；真实 status 不含 managementProtocol/desktopBuildId。最终 Standard/Full 都报 incompatible-host，真实设置页禁用连接/打开，直接 connect 也拒绝；旧日志无新版 open-center/切源/播控，播放代际、队列和原配置保持，旧组件正常 exit=0。这是历史 debug 程序，不是最终 release 的替代产物。 |
| D-A11、12、16 | `final-distinct-builds-1793299316145/report.json`：同一官方 DBX 0.6.47 安装真实 `433e…` 配套 Standard 与最终 Full，并连接唯一最终组件。Standard 明确不兼容、UI 与 RPC 均拒绝桌面连接，其基础播放/队列正常；Full 原 PID、session、歌词/壁纸、播放代际/队列及配置保持。通过 DBX 原安装后端恢复准确最终 Standard 包，hash/队列和兼容检测通过。是两个已知构建并存的实际验证，不宣称任意版本兼容。 |
| D-A04、15、17 | `final-room-source-switch-1793299705082/report.json`：准确最终独立 Standard 房主/访客服务、真实 loopback TLS 房间，加上最终 DBX 两版，实际中心完成五次来源选择。房间模式保持现有无本地 track 的桌面空态，工具条禁用；三个状态各伪造 pause/play/seek，共九次，原生不提交操作，房间 revision/当前实例保持。访客原房间播控无权限时准确 room_denied；授予 transport 后原房间 pause 成功，桌面仍为空态。离场后回本地播放，真实原生暂停按钮恢复。**null 音频、control-only 访客；没有房间桌面 track，故未进入窄 HTTP 播控端点，不能把 native 空态防护写成该端点的权限测试。** |
| 清理与恢复 | `final-fault-cleanup-1793299795395.json`：Standard/Full 安装文件均恢复最终 SHA，原共用 native 配置字节未变；DBX 正常 exit=0、globalFilesChanged=[]。退出前按父子创建时间确定的 12 个实际归属实例均以原 PID+创建时间确认不存在。各完成报告中的 native/fixture/房间服务也均正常 exit=0。六张本批截图已查看。 |

早期驱动失败保留：管理连接曾遇到实例重建空隙的 ENOENT、打开中心期间的短暂 control_busy，驱动后来只在原期限内重查，最终仍记录两次 busy 应答；另一次未捕获预期 EPIPE 导致 Node 驱动中断，没有完整报告，不声明该次正常清理。后续 Win32 查询确认无旧 native/fixture 后才继续。旧管理组件首次尝试只等待 CDP、未等待页面 IPC ready，导致清理强退，后续等待真实页面 API 后通过。房间首次观察器错过初始来源事件、第二次误用主 token 访问 Desktop 窄入口的 401 也保留；最终按真实切源事件和窄凭据验证，未改变产品。较早房间通过报告另存为范围较窄的证据，最终报告新增九次原生空态防护断言。

**八小时之外仍未完成：**

1. 真实 DBX 在线缓冲及音频到图形的完整时序；受控 feed 的 buffering 通过不能替代它。
2. 插件/GUI 的丢应答、connect/revoke 及逐步骤 I/O/崩溃交错完整矩阵；已测真实 native 客户端和协议夹具仅覆盖各自范围。
3. 已验证核心播放、胶囊和窗口生命周期之外的其余原舞台/UI 行为差分。
4. 真实 Windows 登录自启；物理媒体键、声学、实际鼠标命中穿透/托盘找回；锁屏、断屏、Explorer/WorkerW 恢复。
5. 预先冻结的绝对资源发布预算、签名和正式分发资格。

其他真实用户/交互会话、macOS、ARM64 仍缺环境；八小时按用户优先级暂缓。DBX 单独使用无行为变化仍是硬约束；本轮通过的只是列明子项，没有据此把 D3b 或全部非八小时验收标为完成。

## 2026-10-30：生产在线缓冲与真实设置页异常补验

继续使用准确冻结的最终两版包、官方 DBX 0.6.47 和 `07d87e…` 桌面组件，没有重建产品。新索引 `output/dbx-desktop-d3/shutdown-discovery/final-production-buffering-and-gui-faults.json` 核对五份主报告、准确产物、驱动和截图的 SHA；保留五份失败报告，`completeNonSoakAcceptance=false`、`d3bComplete=false`。

| 项目 | 实际结果与范围 |
| --- | --- |
| D-A01、02：真实生产在线准备缓冲 | `final-production-buffering-1793300595893/report.json`：最终 Full 在真实宿主中通过原在线接口选择网易云“晴天(深情版)”。只给本任务进程配置临时代理，TLS 不解密、不改系统代理；暂停音乐上游数据，使实际播放器自行进入 buffering。八个样本、跨 2904ms，同时观察到真实 `v1/state.buffering=true`、native snapshot buffering、DBX 按钮 `is-loading`/“缓冲中…”及原生播控禁用。解除延迟后真实下载/播放成功，原 session 收到准确 track/generation/key 的 43 行文档，播放位置与壁纸绘制递增。没有注入 buffering 标志。准备期间原音频可依原语义继续播放，**不声明物理声音停顿或全部播放中欠载时序已验**。 |
| D-A06、07、10、16：两版真实设置 UI | `final-gui-management-faults-1793301641668/report.json`：实际插件和设置页各四项，共八项通过：管理服务真实 2s deadline 到期、错误 requestId、错误 target，以及打开中心期间点击“取消连接并撤销授权”。前三种均没有假报成功，保留授权和可重试提示，显式重新检测/重试成功；撤销分别约 740/738ms 完成，旧 connect 返回 cancelled，2500ms 后迟到应答 admission 已失效、接收者已释放，没有恢复 gate 或成功提示；显式重连恢复。播放代际和队列保持。**管理对端为链接准确冻结生产 IPC、安全检查和期限的受控夹具；不是实际 native 中心开窗证明，也不覆盖所有 I/O/崩溃步骤。** |
| 队列持久恢复、退出与配置/缓存 | 两轮 `final-fault-cleanup-1793301749740.json`、`…1793301824205.json`：DBX 正常 exit=0、globalFilesChanged=[]，共 22 个实际归属进程实例按 PID+创建时间确认消失。native 与管理夹具也正常 exit=0，共用 native 配置字节不变。临时移出的原在线缓存逐文件核对 SHA 后恢复。一次早期缓冲驱动曾留下在线队列，已恢复最初的 Full 本地队列；`final-original-queue-restart-1793301805556.json` 再经真实宿主重启确认原队列恢复且没有自动播放，未仅以即时 RPC 回读作为恢复依据。 |

11 张原截图通过联系图查看，另查看了原尺寸撤销/错误目标截图。失败不擦除：首次缓冲驱动误用 `#play`；第二次真实“成都”缓冲和恢复成立，但实际 provider 文档为空，未满足非空歌词断言，原报告仍失败。GUI 首次观测包装了未被宿主使用的 invoke，随后改为只读关联实际 SDK request/response；另一轮要求服务端 deadline 必须映射客户端 timeout，实际关闭管道可竞态返回 unavailable，原失败保留。最终保持服务端 2s deadline、错误失败态、授权、取消、迟到和重试断言，并准确保留两种错误码。另一次驱动关闭标签页的选择器不唯一，改为按实际版本标签定位；没有改产品来通过检查。

上一节“真实 DBX 在线缓冲未测”更新为**生产在线准备缓冲已测，完整音频/播放中欠载矩阵仍待验**；“插件 GUI connect/revoke 未测”更新为**本节八项已测，逐步骤授权落盘、I/O、崩溃重启交错及其余丢应答组合待验**。其余原舞台/UI、真实登录/物理输入/系统恢复、预先冻结的绝对资源预算、签名/正式分发，以及缺设备的平台/会话仍保留，八小时继续暂缓。

## 2026-10-30：两版原舞台与三维空间差分

使用同一真实官方 DBX 0.6.47、全新任务数据目录，先装准确历史提交 `1d042b8` 的两版包，执行原 UI 流程；关闭工作台并通过真实宿主停止 sidecar、确认原实例消失后，再经实际安装后端安装准确冻结的最终两版包，重复相同流程。没有安装或启动桌面组件、没有复制任何桌面授权文件，也没有重建产品。

`output/dbx-desktop-d3/shutdown-discovery/final-stage-ui-baseline.json` 核对 `stage-before-1793302289932/report.json`、`stage-after-1793302419082/report.json`，两版在前后各完成十五项，共六十次通过观察：

- 沉浸声场六种歌词视觉：stage、classic、cadenza、sonnet、tempera、starborn；真实设置下拉选项切换、十八行原歌词、原曲目和实际非零画布尺寸均保持。
- 沉浸场景 immersive、coast、zodiac；两阶段都没有 fallback，实际呈现仍引用原曲目。
- 沉浸声场队列、暂停、四分之一位置 seek、恢复播放。
- 三维空间实际首页进入舞台，coast/zodiac 场景与 classic/sonnet 歌词选择；真实 renderer ready、有 drawCalls，文档和选中来源一致。
- 三维空间队列、暂停/恢复及返回二维；最终仍为原曲目和原队列。暂停/恢复/seek 的代际增量前后都是五，未把正常代际递增误判为行为改变。

两版目录、曲目/队列、歌词、选项与播控结果的有限差分通过；四条成功流程都为零桌面 UI 请求、无桌面发现/授权/钥匙文件，最终两版 gate/listenerReady=false，未观察到 pageerror。八张截图已通过联系图查看。该证据补 D-A16 的上述原舞台/UI 子项；是静音有限流程，不声明每个预设/交互组合、像素完全相同、声学或物理媒体键通过。

四份早期舞台驱动失败（错误控件 ID、播放中行号变化、歌词 ID 前缀，以及误要求主动 seek 前后代际不变）及两份清理包装失败均保留。清理 helper 最初将旧房间证据误定位到新目录，在退出前失败；随后独立 helper 使用准确旧报告路径，正常退出和十二个实际归属实例回收均通过，DBX exit=0、globalFilesChanged=[]，原共用 native 配置未变，原任务会话元数据已恢复。没有通过修改产品或减少十五项流程来取得结果。

**最新仍待验范围：** 完整音频到呈现/播放中欠载时序；授权落盘与各步骤 I/O/崩溃重启、其余丢应答交错；已列明有限流程之外的原 UI/预设/交互组合；真实 Windows 登录自启、物理媒体键/声学/鼠标穿透和托盘找回、锁屏/断屏/Explorer/WorkerW 恢复；预先冻结的绝对资源发布预算、签名和正式分发资格。其他真实用户/会话、macOS、ARM64 仍无设备证据。八小时暂缓，完整非八小时验收与 D3b 继续未完成。


## 2026-10-30：真实设置页授权落盘故障与强退恢复

继续按用户“主要验证除八小时之外的问题”的优先级，使用冻结的最终 Standard/Full 包和官方 DBX 0.6.47，在新建任务目录执行实际设置页流程。没有重建产品，也没有改并发工作区中的产品代码。`output/dbx-desktop-d3/shutdown-discovery/final-gui-authorization-restarts.json` 绑定准确包/安装 binary、主报告、独立管理夹具、驱动、四张原截图和正常退出报告的 SHA，保留两份早期失败。

两版各完成以下八项，共 **16 项通过、14 次真实 sidecar 强制终止/重启、6 次实际 Windows 文件共享锁**：

| 故障检查点 | 实际观察与恢复结果 |
| --- | --- |
| 提交同意前，兼容探测期间撤销 | 当时没有授权/钥匙；撤销成功、旧 connect 返回 cancelled，迟到探测 admission 失效且接收者已释放。禁用记录保持，不创建钥匙或发现记录。 |
| 提交同意前，兼容探测期间强退 | 旧禁用记录字节不变，迟到回复无效；实际重新激活插件后 gate/listener 仍关闭、无钥匙/发现文件。 |
| 第二份钥匙创建失败后强退 | 用任务目录阻止 wallpaper-key 创建，真实返回 credential unavailable；第一份钥匙已创建但同意未提交。重启保持未授权，解除障碍后显式重试复用原第一份钥匙并成功。 |
| 授权文件原子替换失败后强退 | 独立 PowerShell 进程以 FileShare.Read 持有实际授权文件，真实返回 authorization write failed；两份钥匙存在但旧禁用记录不变。重启无 listener，释放文件锁后显式重试成功。 |
| 发现记录发布失败后强退 | 用任务目录阻止发现文件发布，真实返回 discovery failed；有效同意与两份钥匙已落盘，当前 gate 关闭。障碍保留时重启仍不可用；解除后重试复用原授权/钥匙，两条真实认证数据管道均可读。 |
| 同意已持久化，打开中心应答未到时强退 | 原发现记录存在，管理请求仍 pending 时终止对应 sidecar；迟到应答不能送达。重启按原有效同意恢复 gate/listener，新发现 PID 与新 sidecar 一致，两 scope 真实读取通过。 |
| 持久撤销写盘失败后强退 | 真实文件共享锁使禁用替换失败；本进程 gate/listener 立即关闭、旧授权/钥匙保留，UI 明确提示“重启可能恢复授权”。重启确实按旧持久同意恢复；该行为与失败提示一致，不能记为永久撤销成功。 |
| 持久禁用成功、钥匙删除失败后强退 | 锁住 lyrics-key，禁用记录成功保存、wallpaper-key/发现记录删除，结果明确 cleanupIncomplete。重启即使仍有残留歌词钥匙也不恢复授权；释放锁后通过显式后端 disconnect 清理成功。此最后一次清理不声称是重启后的 GUI 重试。 |

每项非重启故障保持原播放代际/曲目/队列；每次重启均核对原队列持久保留且 `playing=false`，之后由驱动显式恢复测试播放。两版最后都持久撤销、gate/listener 关闭。进程终止严格绑定实际 exe、PID 和 Get-Process.StartTime，仅作用于本任务 sidecar；不是按名称批量结束进程。

四张真实截图已通过联系图查看。夹具与六个文件锁进程均正常 exit=0；最后经真实 DBX 退出入口正常 exit=0、globalFilesChanged=[]，**12 个**按创建时间确定的实际归属进程实例消失。共用 native 配置及准确安装包/组件 SHA 未变；本轮没有启动真实 native 或创建任务 native 配置，原会话元数据已按原字节恢复。

证据边界：管理对端链接冻结生产 IPC/安全/期限源码，但使用独立依赖锁，不宣称与生产完整依赖图相同；不能代替实际 native 中心开窗。本节是八个可观察检查点的有限故障/重启矩阵，不是逐机器指令、断电或全部丢应答交错证明。两份早期驱动失败均发生在实际宿主未刷新安装列表、找不到插件打开按钮时，尚未进入授权场景；原失败报告不擦除。

**最新剩余：** 已列检查点之外的授权/丢应答交错、完整音频到呈现与播放中欠载时序、已测有限流程之外的原 UI/预设组合；真实 Windows 登录自启、物理媒体键/声学/鼠标命中穿透和托盘找回、锁屏/断屏/Explorer/WorkerW 恢复；预先冻结的绝对资源发布预算、签名和正式分发资格。其他真实用户/会话、macOS、ARM64 仍缺环境，八小时继续暂缓。没有把部分通过扩大为全部非八小时验收或 D3b 完成；“DBX 单独使用无行为变化”仍为硬约束。


## 2026-10-30：真实插件与真实组件之间的应答丢失和并发

本批沿用冻结的最终两版包、官方 DBX 0.6.47 和准确 `07d87e…` 桌面组件；未重建或修改产品。与此前合成管理业务应答不同，本批在两端之间放置独立测试转发器：原样转发实际请求至同一真实 native 的另一个任务专用命名端点，只丢弃/延迟真实返回值。两跳均使用冻结生产 IPC 的私有 ACL、peer 校验和期限；转发器有独立依赖锁，不声称完整依赖图与生产相同。端点后缀使用任务进程环境区分，实际 Windows SID/会话相同，不是跨用户/会话证据。数据 feed 不经过该代理，始终由实际最终 sidecar 提供。

`output/dbx-desktop-d3/shutdown-discovery/final-gui-native-replies.json` 绑定准确包、组件/代理、主报告、驱动、四张原截图、联系图和正常清理报告的 SHA。两版各五项，共 **10 项通过**：

| 实际链路场景 | 结果 |
| --- | --- |
| 真实中心处理 open-center 后，丢掉实际应答 | 两次真实 native 都已成功处理并打开唯一中心；插件没有误报 centerOpened，授权/gate 仍有效、真实设置页提供重试/撤销。查询和显式重试成功，复用原中心页面及原授权/钥匙，不增加配置 revision，也不修改原播放/队列。 |
| 一个真实 GUI 请求与七个后端请求同时连接 | 每版八个实际 SDK 请求共享一个 pending operation，各批只有一次 open-center 被转发至真实 native；全部结果成功，唯一组件/中心和原授权/配置保持。共十六次连接调用、两次对应 native open；该批七个并发请求来自实际宿主后端调用，不冒充八次 UI 点击。 |
| 真实中心已处理，但打开应答尚未返回时关闭工作台 | 两版 sidecar 均保持原 PID/创建时间、原播放与授权；2500ms 后真实旧应答对应 admission 失效、接收者释放。重开真实工作台、查询/重试成功，配置与队列保持，歌词/壁纸继续从实际插件取得文档和新快照。 |
| 真实 native 已返回来源在线，将该 status 延迟到撤销之后 | 撤销成功，旧 refresh 不再发布 sourceConnected/gate/managementReady；两条实际 surface 清空文档/音乐数据，2500ms 后的旧在线应答无法送达，不把已撤销来源恢复为在线。 |
| 打开应答 pending 时撤销，立即重新授权，随后旧应答才到 | 两版新授权都在旧应答到达前完成；旧 connect 为 cancelled，迟到结果 admission 失效/无接收者。新授权文件与钥匙保持新值；等真实 feed 重新取得十八行歌词和同 session 双 scope 快照后，实际刷新确认两 scope 在线。唯一中心、配置和原播放/队列保持。 |

每个非主动播控流程都核对播放代际、曲目、playing 和队列未变；两版最终持久撤销并暂停测试曲。四张真实截图经联系图查看。本轮通过路径的 native 经自己歌词 WebView 的退出 IPC 正常 exit=0，代理正常 exit=0，native 的 **9 个**实际归属实例消失；DBX 经实际退出入口正常 exit=0、globalFilesChanged=[]，其 **12 个**实际归属实例消失，合计 **21 个正常回收**。共用原 native 配置及准确产品 SHA 未变，原任务会话元数据按字节恢复。

首次驱动失败保留：在新授权成功后、native 的指数退避尚未取得新快照时，过早要求 sourceConnected=true；产品当时准确返回 false。最终流程仍要求真实双 surface 文档/同 session 快照恢复，之后才查询并断言在线，没有将授权成功冒充已连接。首次清理又误用 DBX 来源禁止的 legacy quit，随后驱动对自己拥有的 native 强制清理；该次不能声明正常退出。原报告、配置和截图保留，原归属实例已按 PID+创建时间补核全部消失；通过路径使用原有页面退出入口。Standard 后续运行从该失败遗留的持久禁用记录开始，不声称全部场景均是首次安装。

本批补足 D-A06/07/09/10/16 中列明的真实插件—真实 native 链路子项，不承诺任意跨进程 exactly-once 或穷尽全部事件排列。其他授权/I/O 交错、完整音频到呈现/播放中欠载、未列原 UI/预设组合、真实登录/物理输入/锁屏与系统桌面恢复、资源发布预算/签名资格仍待验；其他真实用户/会话、macOS、ARM64 仍缺环境。八小时继续暂缓，完整非八小时验收及 D3b 未完成，DBX 单独使用无行为变化的硬约束不变。
## 2026-10-30：真实最终组件的软件歌词时序与稳定暂停

`output/dbx-desktop-d3/shutdown-discovery/final-native-software-timing.json` 绑定官方 DBX 0.6.47、冻结两版包和准确 `07d87e…` / SHA `4d2906…` 组件、原始报告、驱动、截图及清理报告。未修改或重建产品。真实本地 cpal 播放器静音运行，生产 API 导入具有明确五秒逐词时间戳的十八行增强 LRC；没有注入播放位置、feed 或 renderer 时钟。

以实际播放器快照 → 实际歌词 DOM 逐词进度 → 实际播放器快照夹测，整段须不超过 50ms。误差采用显示位置到两端位置偏差的较大值，不用中点拟合；仅文档 ready、同曲同 generation、播放且非缓冲样本进入稳态，拒收不依赖误差。本批两版各 160 次、全部有效，各覆盖约 19.88 秒：Standard p95 上界 **45.5ms**、最大 59.5ms；Full **44.5ms**、最大 63ms，均通过原 100ms 门槛。

两版各二十次暂停/暂停中双向 seek/恢复/播放中双向 seek/重复暂停恢复/实际换曲，共 **40 次通过**。从发送命令至实际呈现的最长时间 Standard 519.50ms、Full 515.39ms，通过 750ms 门槛。八次冷换曲均及时反映新曲目/generation 并清除旧词；首次文档另记为 1437–1503ms，按原方案与稳态/切曲反映分开，不声称首次取词在 750ms 内。

原播放器位置稳定 1200ms、再留 550ms 组件追赶后，两版分别观察稳定暂停 10113.71ms、10106.95ms；新增 rAF 请求、回调及逐词进度属性变更均为零，显示位置保持。稳定前原播放器可能继续发布一次真实位置修正，此状态不冒充稳定暂停。

四份测量驱动失败保留：选错尚未舍入到 100% 的前词、把暂停命令立即返回的位置当成永久基准、在真实原播放器尚未稳定前启动静态观察，以及误将首次文档纳入 750ms。修正测量方法后未改产品、100ms/750ms 门槛；四次 native 均正常退出，旧实例已按 PID+创建时间补核消失。两张透明 WebView 离屏截图已查看用于确认实际词内容，不以其合成背景判断原生透明效果。

通过路径 native 和 DBX 均正常 exit=0，21 个实际归属实例回收；宿主全局文件无差异、原共用配置不变、原会话元数据按字节恢复。两版最终持久撤销。该批是软件位置/有限事件时序与稳定暂停证据，声卡出声、物理扫描、播放中欠载、隐藏策略及 50 次启停/锁定仍需各自验证；物理输入和真实 Windows 系统恢复、资源发布预算/签名分发及缺环境项目仍待。八小时继续暂缓，完整非八小时验收和 D3b 保持未完成。



## 2026-10-30：五十轮启停/锁定、停绘及未通过的资源回收

本批继续使用准确冻结的最终两版包、官方 DBX 0.6.47 与 `07d87e…` / SHA `4d2906…` 桌面组件，未修改或重建产品。索引 `shutdown-discovery/final-native-lifecycle.json` 与 `final-native-lifecycle-controls.json` 绑定原始报告、准确驱动、截图、Windows 只读采样器及正常清理证据。**已执行不等于资源验收通过：`functionalChecksPassed=true`，`resourceRecoveryPassed/resourceRecoveryAccepted=false`，问题 `P2-native-process-handles-retained` 保持 open。**

真实 DBX 两版各五十轮组合流程均完成：两项启用 → 锁定 → 关闭歌词而壁纸页面保持 → 重启歌词 → 关闭壁纸而歌词保持 → 两项关闭。操作通过实际设置页当前 revision/config 的原页面 IPC，非物理鼠标输入。每版六个同状态 Windows 检查点，原生进程所属 HWND 数均回到 12，CDP 页面均回到原有歌词和设置两页；原播放器保持暂停、generation/曲目/队列不变。两版末态持久撤销，gate/listener 关闭。内部 controller/listener 数未直接暴露，发行包线程名为空，不能把零个可观察线程名说成没有读取线程。

另以两版各一轮检查在实际播放器继续播放时停用歌词：来源各前进 11380ms，连续观察 10116.09ms / 10107.21ms，新增 rAF 请求、回调和逐词进度属性变更均为零。由此补停用歌词的停绘子项，不以最初暂停中的检查替代播放中的停绘，也不扩大为全部全屏/锁屏隐藏策略。

发现尚未通过的资源现象：组合流程 Standard 总句柄 374 → 425，Full 在同一进程继续 426 → 470。独立新 native 重复 Standard 五十轮后，`Process` 类型句柄 **16 → 66**；停用后 0/10/30/61.368 秒的该类计数均为 66。总句柄在冷却末降至 419，但多出的五十个 `Process` 句柄未回收，主要重复指向同一个仍存活的 WebView2 子进程。HWND/页面稳定及进程最终退出不能替代这一项的回收证明。

为避免将观察工具或单个动作误判为根因，使用同一准确 native 的独立版/无选中来源管理路径，另完成四组五十轮及各超过六十秒冷却：

| 对照路径 | Process 句柄基线 → 末态 | 观察 |
| --- | --- | --- |
| 不启用 CDP，原管理接口启停壁纸 | 15 → 15 | 各十轮检查点均无该类增长 |
| 同一路径启用 CDP 并建立 Playwright 连接 | 15 → 15 | 没有复现增长 |
| 同一路径通过 CDP 读取每个新壁纸页面 | 15 → 15 | 没有复现增长 |
| 不启用 CDP，单独切换锁定/解锁 | 15 → 15 | 没有复现增长 |

这些负对照不能代替真实 DBX 组合流程，也不能证明“只是 CDP 问题”。当前仅确认 DBX 组合路径两版及独立重复的句柄累积；来源/feed、设置提交及歌词可见性组合尚未隔离，**尚不能归因于具体 Wry/WebView2 或应用生命周期代码**。下一步应对齐组合动作与来源状态后定位；不通过给发布预算添加容差、忽略句柄类型或仅检查进程退出而改判通过。该现象属于启用桌面组件后的路径，不据此推断 DBX 单独使用发生变化。

两张真实设置页截图已查看。本批三个 DBX/组件通过流程的 36 个实际归属实例正常回收；四组独立对照另有 32 个实例正常回收，均按 PID+创建时间确认，无强制清理。DBX 正常 exit=0、宿主全局文件无差异，原共用配置未改、原会话元数据按字节恢复。两份前置驱动失败原样保留：读取线程名不可观察，以及原始管理客户端在 listener 两次实例之间遇到尚未送达的 ENOENT；后者仅为 pre-connect ENOENT 增加有界重试，不重试超时、丢应答或业务失败。两次失败 native 均正常退出，旧实例补核消失。

**最新剩余：** 上述组合路径句柄累积与完整 P2 内部回收；播放中欠载及真实输出路径/声学时序；已测有限矩阵之外的授权 I/O/事件交错和原 UI 组合；真实 Windows 登录自启、物理媒体键、鼠标实际穿透与托盘找回、锁屏/断屏/Explorer/WorkerW 恢复；预先冻结的 CPU/内存/GPU 绝对发布预算、签名和正式分发。其他真实用户/交互会话、macOS、ARM64 仍缺环境，八小时按用户优先级暂缓。完整非八小时验收及 D3b 继续未完成，DBX 单独使用无行为变化仍是硬约束。

## 2026-10-30：复用 WebView2 目录的无调试句柄复现

继续验证八小时之外的资源问题，沿用准确冻结的最终两版包、官方 DBX 0.6.47 与 `07d87e…` / SHA `4d2906…` 组件，未修改或重建产品。`shutdown-discovery/final-native-lifecycle-isolation.json` 绑定本批 **14 份**原始报告、实际驱动、目录复制清单、只读进程角色采样与正常宿主清理报告的 SHA。报告中的执行成功只表示测量完成，**不表示资源项通过**；`P2-native-process-handles-retained` 仍为 open，完整非八小时验收和 D3b 均未完成。

| 对照 | 实际结果及范围 |
| --- | --- |
| 无选中来源，实际设置 IPC 分项 | status、重复保存、歌词启停、壁纸启停、锁定及原组合各十轮，Process 均为 15 → 15；最终冷却超过六十秒。 |
| 真实 Standard，实际设置 IPC 分项 | 重复保存、歌词启停、锁定各十轮无增长；壁纸启停十轮 16 → 26，随后原组合十轮 26 → 36。去掉 feed/动画观察器后十轮仍 16 → 26；再完全去掉空的 context init script 后十轮也为 16 → 26。 |
| 真实独立 Standard、新 WebView2 目录、无调试 | 五十轮以页面 ready 为门槛，15 → 15；另十轮逐次等待真实快照和原生心跳绘制，仍 15 → 15。均正常退出，不能由此外推真实 DBX 路径通过。 |
| 真实 DBX、新目录、相同管理接口 | 同一 native 先不连接桌面 CDP 客户端五十轮，再连接并逐页读取五十轮，两阶段各等待六十秒，均 15 → 15。另一次完全去掉桌面调试参数的五十轮也为 15 → 15。每轮均有真实 DBX 快照和原生绘制心跳。 |
| 新目录的其他有限对照 | 空 context init script、首次真实绘制后立即关闭、改走设置 WebView 的真实 apply IPC，各十轮均为 15 → 15。CDP、空脚本、提交入口或快速关闭单项均不足以解释原增长。 |
| 相同原设置/切源流程，替换目录 | 使用全新 native 配置和 WebView2 目录，十轮 15 → 15；新建配置目录并逐文件复制原任务复用的 WebView2 目录，十轮 16 → 26。复制前后完整相对路径/大小/SHA 清单一致并已保存，未删除或重置原目录。两组均不注册 context init script。 |
| 旧目录副本，完全关闭桌面调试入口 | 真实 DBX Standard、真实 v2 管理、每轮确认真实快照和原生心跳绘制，**五十轮 15 → 65**。停用后 0/10/30/六十秒的 Process 计数均保持 65。实际 native 及所属子进程命令行均无 remote-debugging 参数。 |

最后一组的只读句柄类型/目标 PID 采样与同实例进程角色采样对齐：增长的五十个句柄均指向同一个仍存活的 WebView2 `network.mojom.NetworkService` 子进程，该目标计数 **4 → 54**；PID 和创建时间与退出前归属快照一致。由此确认问题会随复用 WebView2 目录的文件内容副本复现，且**不依赖桌面调试连接**。尚未隔离具体目录内容，也未定位 SDK/应用中持有句柄的确切代码；不能把它写成已修复、泛化为所有 WebView2 环境，或推断 DBX 单独使用发生变化。新目录的负对照不能豁免既有目录的资源失败，也不以自动清缓存作为产品修复。

本批未注入业务 feed/播放时钟，DBX 测量阶段保持原暂停、曲目/generation/队列；两版最终仍持久撤销。新目录/旧目录两次完全无桌面调试运行，均在全部测量和配置检查完成后，针对自己拥有的 native 明确终止，分别核对八个实际归属实例消失，**不计正常 native 退出验收**。其余十二轮 native 均正常 exit=0，合计九十六个归属实例回收；两个独立服务正常 exit=0。最后 DBX 正常 exit=0，十个实际归属实例消失、globalFilesChanged=[]；共用原 native 配置不变，原会话元数据按字节恢复。没有新产品构建，也没有把共享主树的其他变更纳入本轮结论。

本批收窄了资源故障的复现条件，但 P2 内部 controller/listener 回收、声学/播放中欠载、真实 Windows 登录及物理输入/锁屏/断屏/Explorer 恢复、绝对发布预算/签名资格等仍按原审计保留；其他用户/会话、macOS、ARM64 缺设备，八小时继续按用户优先级暂缓。部分发现驱动沿用旧时序脚手架，实际轮数以原始 phases/cycles 及本索引为准，不以继承的 thresholds/描述字段冒充执行。

## 2026-10-30：同目录重启复现与未采纳的修复实验

`shutdown-discovery/final-native-restart-diagnostics.json` 绑定本轮十份报告、准确驱动、两个独立实验构建及公开上游问题快照。最有判别力的新证据是**原地正常重启**，不再依赖旧目录复制或 DBX：原最终组件连接同一个真实独立 Standard 服务，播放器全程暂停，使用同一配置/浏览器目录和数据源/session，首个 native 生命周期十轮 Process **15 → 15**；正常退出并确认八个归属实例消失后，原目录重启，第二个生命周期十轮 **16 → 26**，停用六十秒仍保留。两次 native 均正常 exit=0，播放器 generation 保持。首启负对照不能代表复用目录的生命周期验收通过。

| 本轮对照或候选 | 实际结果与判断 |
| --- | --- |
| 原最终组件、真实独立服务、旧目录副本 | 十轮 +10，六十秒后保留，正常退出。资源现象不要求启用 DBX。 |
| 复用歌词 WebView2 环境的实验 | 独立冻结副本仅改 `app.rs`，build `12e726…`，原依赖锁保持；壁纸/预览/设置复用歌词环境，五十轮仍 +50，故不采纳。既有 51 项 Rust 测试通过不能替代真实资源回收。该次独立服务原 load 默认播放，长测期间 180 秒曲目自动循环，末尾 generation 3 → 5 导致报告整体失败；保留失败，不能宣称原播放状态保持或完整功能验收通过。 |
| HTTPS 自定义协议源的实验 | 另一个冻结副本仅改 `app.rs`，build `649624…`，原依赖锁保持；已知正例目录副本、真实暂停数据源、无桌面调试，五十轮 **16 → 66**，六十秒后保留。第一阶段已否定修复，按驱动规定不再执行第二次启动的五十轮，报告仅一阶段；不采纳。 |
| 子资源过滤规则 | 首次移除后运行时自动重装，不能作为有效移除对照。后续两组均只在任务夹具中设置 `--disable-component-update`：保留原规则十轮 +10；移除规则并重置版本，确认结束时规则文件仍不存在、活动版本仍为空，也 +10。不能把规则缓存当作充分解释，更未将暂停更新用于产品。 |
| 状态文件与目录分区 | 旧目录换新 `Local State` 十轮 +10；新目录换旧 `Default`、旧目录换新 `Default` 两组也各 +10。互换均未得到负对照，不能由此归因于某一个文件、规则或用户资料分区。尚未定位实际持有代码。 |

本机准确环境为 Windows 11 25H2 **26200.9711 x64**、实际 WebView2 **156.0.4314.50**。只读检索发现微软官方仓库已有开放问题 [WebView2Feedback #5704](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5704)，报告在 Windows 11 上反复创建/关闭 environment/controller 后宿主句柄保留，并有 MSVC x86/x64 补验。其运行时为 151/152、具体流程也不同；仅作同类问题线索，**尚未证明与本例同根因**。原问题/评论快照已保存并绑定 SHA，没有向上游发送消息，也没有执行其附件代码。

两项实验均未应用产品主树，配套最终 DBX 包未重建，也未使用旧 build 身份伪装新组件。实验通过原独立 HTTP/管理路径取得真实数据，不冒充新构建的 DBX 配套验证。本批十一个 native 生命周期均正常退出，共八十八个实际归属实例按 PID/创建时间确认消失，十个独立服务均正常 exit=0。原任务 WebView2 目录的 288 个文件仍逐一匹配前批清单，共用 native 配置及原会话元数据保持，产品主树 `app.rs` 与原冻结候选字节一致；共享工作区的其他修改保留。

范围文字同步校正：前批索引中“全部来源暂停”的描述过宽，已收窄为 DBX 流程暂停，早期独立服务对照可能播放，以原始 `playerBaseline` 为准；改前索引另存，相关 SHA 及验证记录已更新，原报告不改写。本节原地重启及 HTTPS 实验均明确暂停，播放器代际保持。`P2-native-process-handles-retained` 仍 open，资源回收与 D3b 未通过；下一步需要更小的独立 WebView2 复现或受支持的释放/修复证据，不能通过清用户目录、关闭未知归属句柄或改松资源门槛来改判。八小时继续暂缓，其余真实 Windows/物理输入、发布预算及缺设备项目仍保留。

## 2026-10-30：独立 WebView2 最小程序复现

`shutdown-discovery/final-minimal-webview2.json` 绑定两份原始报告、各阶段准确源码/依赖锁/二进制/驱动、只读句柄采样器和环境证据。独立 Rust 小程序只依赖 `webview2-com = 0.39.1`、`windows = 0.62.2`，不包含 Hertz、Wry、Tao、DBX、数据源、前端业务、自定义协议或浏览器调试连接。使用自己的锁文件，不声称全部依赖图与产品一致；它是故障诊断，不是新的产品候选或完整资源验收。

STA 中保留一个 anchor controller，再逐轮创建隐藏 Win32 父窗口和 child controller。每次 `NavigateToString` 的极小本地 HTML 必须成功 `NavigationCompleted`，随后移除订阅、`Close`、释放 controller、销毁父窗口，并继续泵送消息；不以导航成功冒充实际绘制。三阶段都在测量后正常退出，下一阶段开始前核对原进程及浏览器归属实例全部消失，使用同一任务专用目录，不清用户缓存。

| 最小程序对照 | Process 句柄基线 → 六十秒冷却末态 | 增量目标 |
| --- | --- | --- |
| 全新目录，首个生命周期十轮 | 8 → 8 | 无该类增长 |
| 同目录正常重启，十轮 | **9 → 19** | 同一实际 NetworkService 实例，3 → 13 |
| 同目录再次正常重启，五十轮 | **9 → 59** | 同一实际 NetworkService 实例，3 → 53 |

五十轮的每十轮检查点为 19/29/39/49/59，冷却期间继续处理 Windows 消息，0/10/30/六十秒的 Process 计数均为 59。每阶段增长目标的 PID/创建时间、角色和实际运行时路径已对齐，均为 WebView2 **156.0.4314.50**。这证明此类现象**不要求 Hertz/Wry/DBX 参与，也不要求自定义协议或真实业务数据**；不能由此定位 SDK/运行时/操作系统中的确切持有代码，或认定每个产品句柄必然同根因。未采纳新的产品修复，也未向上游发送消息。

三个诊断生命周期均正常 exit=0，共 **24 个**实际归属实例按 PID/创建时间确认消失；未强制清理。原任务 WebView2 目录 288 项仍逐项匹配，共用配置/原会话元数据以及主树 `app.rs` 保持。小程序源码、可重跑步骤和冻结输入保存在 `output/dbx-desktop-d3/webview2-minimal-probe/`。初次编译有通配导入遮蔽 `Result` 的错误，修正后才开始实际运行，没有删除失败的产品测量或修改原通过门槛。

`P2-native-process-handles-retained` 保持 open，产品资源验收和完整 D3b 均未通过。下一步应取得受支持的 SDK/运行时修复或经复用目录重启验证的释放方案；仅凭最小复现不能豁免产品资源要求。其余非八小时缺项仍包括内部 controller/listener 完整回收、播放中欠载/真实输出与声学时序、原审计未覆盖的授权 I/O/事件组合、真实登录自启/物理输入/系统桌面恢复，以及冻结的资源发布预算与签名资格。其他用户/会话、macOS/ARM64 缺环境；八小时继续暂缓，DBX 单独使用无行为变化硬约束不变。

## 2026-10-30：真实播放中欠载与旧频谱刷新

`stalled-spectrum/midstream-discovery.json` 绑定两轮真实渐进下载试验及准确驱动。沿用原最终 Full 独立服务与 `07d87e…` 组件，任务专用 HTTP 代理仅按响应头及字节数，在真实预读阈值之后暂停音频响应；HTTPS 保持端到端，不修改系统代理、AppState、快照或 renderer 时钟。真实网易云 `2652820720`、43 行原歌词、cpal 静音播放。首轮代理给每次 Range 续传重新放行字节，未形成六秒持续停滞，失败报告保留；第二轮对同一次下载的续传维持同一总字节预算，实际暂停在 1155075 字节，后续 206 响应放行零字节。

第二轮播放器真实位置保持 **28801ms，连续 6134ms**，原 `playing=true` / `buffering=false`，非首次准备缓冲。稳定后另留 1500ms 追赶，27 个前后夹测样本覆盖 **4554ms**，同曲、同 generation、同 session/文档；新歌词快照 seq 64 → 73，新增 rAF 请求/回调均为零。壁纸仍绘制 124 帧，频谱峰值却持续为 **1**、`ageMs` 仅 **15–67ms**：原 FFT 被周期性重新当新帧记时，确认 `P2-wallpaper-stalled-fft-refreshed`。恢复真实传输后 1560ms 观察到原代际/原曲位置继续前进并恢复频谱。该时间不是声学恢复上界或 750ms 门槛的通过证明。

两轮 native/服务均正常 exit=0，十八个实际 native 归属实例回收。两张离屏截图已查看，仅确认词内容，不以透明 WebView 的离屏合成判断物理桌面外观。真实提供方本次是行级歌词；驱动误用 `--word-progress` 的查询为空数组，不作为逐词或渲染位置测量证据，冻结结论来自真实 rAF、播放器和文档身份。

修正仅写入桌面频谱投影及其原调用处：以真实播放代际/位置确认 PCM 仍在推进，停滞时不更新旧频谱时间，继续沿用一秒过期；原音频/播放状态/WS 频谱广播保持。`stalled-spectrum/source/` 从原冻结输入建立，只纳入 `state.rs` 的对应调用片段与 `wallpaper.rs`，桌面 72 项输入完全相同，未把共享主树其他变更纳入；修正后补回归测试，不走 TDD。新插件输入指纹 `ae97161c3880ebd5ca3bba2cc6a40c6b04d999cc97d54bc7ffabee8502cf03a9`，桌面仍为 `596f2543…` / build `07d87e…`。

新 Full/Standard 独立 release 已构建，准确 SHA 分别为 `3b9d9ce22c9da0970d20387211cf2f0aa95a1bcac951068ec9f186d503380e32`、`b5d4b5bd0a6129c84aa0c4fa56f28e3f63b1f27e18a33470e236c3029d4aaa5b`。7 项壁纸单元回归及两版 Rust 1.88 / `-D warnings` 通过。新 Full 真实欠载报告 `output/playwright/dbx-desktop-midstream-1793314437204/report.json`：位置仍停在 **28801ms，持续 6111ms**；保留 1500ms 追赶后的 25 个样本覆盖 **4473ms**，歌词 seq 64 → 73，新增 rAF 请求/回调均零，频谱全部为零、最小 age **1905ms**，环境动画继续绘制 123 帧。放行后原曲原代际推进且频谱恢复，观察间隔 1522ms，仍不计声学/750ms 资格。native/服务正常 exit=0，9 个归属实例全部回收。

新两版 `stalled-spectrum/standalone-ws-1793314493930/report.json` 通过真实本地 cpal 静音 HTTP/WS 检查：token/ticket、原 state/spectrum、播放/暂停/seek、主 viewer 离开后暂停、壁纸不增加 viewer、重连保持暂停、旧频谱过期及正常退出。两张离屏截图已查看，透明合成仅作词内容辅助；不声称物理桌面或逐词歌词验证。配套 DBX 新包及原合同回归已完成，限定结果见下一节，原最终包历史资格未移记。 原资源句柄问题、完整非八小时验收及 D3b 继续未通过；八小时暂缓，DBX 单独使用无行为变化仍为硬约束。


### 2026-10-30：新频谱候选的配套包回归

`output/dbx-desktop-d3/stalled-spectrum/qualification.json` 逐项绑定新冻结输入、准确两版产物、原始测量/驱动和日志。此索引是本次修正的限定验证，不替换 `shutdown-discovery/` 原最终候选，也不把其历史图形差分移记到本批。

| 新包 | .dbxp SHA-256 | 包内 exe SHA-256 |
| --- | --- | --- |
| standard | `d7ad534903105c915b40595407fd0a22ec1ff18a7683278d4ea347eaf3e2a4b5` | `13fcd2bb42bdedc58b8374eab2e164f336b03797b111e16c4036f4511e4a6481` |
| full | `bb2eacc8751a63002383c9ccb6b47f2c48f95bd589c85c4c0d0f60d94af4e9db` | `e9a31e8d48d8b852721dd3058520aff46683ff4a86dd5a9ea085669dc2202f12` |

两版 archive/清单/PE/资源/权限检查、原 cpal stdio **Standard 314/314、Full 298/298**、实际 RPC 与逐文件独立身份复算、最低 0.6.35/当前 0.6.47 的真实 PluginHost 八组均通过。两版默认生产管道鉴权/有界 I/O/慢发送各 27 项通过；扩展大文档/播放与路径别名检查中的退出失败另列下一节，不能把默认模式通过扩展为全部管道资格。这是当前 Windows 用户/会话中的包内生产进程，未声称其他用户隔离、完整 UI 差分、声学或全部故障交错。未启用桌面的两版基础 RPC 正常，没有桥发现/钥匙/授权文件，也未创建原生配置。DBX 单独使用无行为变化仍是硬约束。

真实 Full 欠载修正限定通过：25 个稳定样本覆盖 4473ms，歌词新增 rAF 为零、新 seq 持续到达，频谱全部归零且 age 最小 1905ms，环境继续 123 帧；放行后同曲同代际恢复。单一在线源/一首行级歌词、静音 cpal 和离屏截图不能代替声学/逐词/物理桌面测量。两版实际 HTTP/WS 合同、7 项源码回归和 Rust 1.88 / `-D warnings` 也已通过。

本批真实 native/服务正常退出，9 个实际归属实例消失；包内回归进程已结束，原共用配置/GUI 元数据及主树 app.rs 保持。历史清单的 288 个 WebView2 文件逐项匹配；另两个 SQLite 辅助文件的创建/修改时间为 22:02 UTC，早于 22:38 UTC 候选冻结，但没有它们的历史哈希基线，不宣称整个目录逐字节相同。初版保全脚本的全目录相等断言失败及更正边界留在 `preservation-initial-inventory-mismatch.json`，未删除原目录内容；脚本根目录层数错误修正后才完成 app.rs 核对。

`P2-wallpaper-stalled-fft-refreshed` 仅标记本冻结候选内修正通过；`P2-native-process-handles-retained` 仍 open。完整非八小时验收、内部 controller/listener 回收、新候选完整 DBX 图形基线、物理媒体键/鼠标穿透/托盘找回、登录自启/锁屏/断屏/Explorer 恢复、绝对资源预算/签名，以及缺设备的用户/会话和 macOS/ARM64 资格均未完成。八小时按用户要求暂缓；D3b 保持未完成，共享主树其他修改也不包含在本批资格内。

### 2026-10-30：扩展管道检查发现正常退出残留

`stalled-spectrum/extended-regression.json` 绑定四份新候选扩展报告及七份原候选对照。新候选两版实际大文档均完成 784844 字节回复、偏移只应用一次；客户端不读取时服务实际只写 65540 字节便被期限取消，两个槽位在旧客户端仍暂停时可再用，壁纸/基础 RPC 持续可用。实际暂停/seek/恢复、四次切曲往返、同曲歌词修订/无词的五个子项也均通过。Standard 整体通过；Full 正常 exit=0 后仍留下本实例 `desktop-source.json`，因此首轮整体失败。随后同候选重复两版均通过，不覆盖首轮失败。

撤销持久化失败/重启五项组合两版均通过。路径大小写/扩展前缀/junction 三项组合在新 Standard 子项通过后，同样因 exit=0 后发现文件残留失败，Full 未执行。原候选先分别通过播放组合和别名组合；再独立执行五轮原包别名组合，其中 **2/5 轮**在正常退出后的相同断言失败，3/5 通过。新旧失败报告各保留两个，残留 JSON 的 pid/session 与实际退出实例一致，不能据后续通过消除偶发失败，也不能归因于本次频谱修正。

新增 **`P2-dbx-eof-discovery-retained` open**。原新冻结 `plugin/backend/src/main.rs` 字节相同：EOF 后先启动异步桥清理，仅等待 AppState Host End/音频退出，存在 runtime 提前结束而发现清理未完成的路径。这是有源码支持的待验证假设，尚未应用或资格化修复；下一步应在冻结候选中让进程 owner 等待桥的有界清理与 AppState shutdown 都结束，再复验本次失败路径、原无授权合同及阻塞房间 EOF。此问题出现在已授权桥的退出；未证明 DBX 未授权单独使用产生行为变化。

另一个新最小探针第一条管道读取 EPIPE，尚未进入 EOF 测量便强制清理其唯一归属进程，原失败报告 `eof-race-1793316015046/report.json` 保留，标记不确定诊断，不计入上述通过/残留样本。本批其他正式管道报告中的退出均正常；最终保全再次确认没有本候选产品进程存活，用户其他 debug 服务未动。

`qualification.json` 保留频谱修正的限定资格，同时明确 `allExecutedChecksPassed=false`，链接扩展失败及旧包对照；此前仅完成核心检查时的索引另存 `qualification-before-extended-pipes.json`。两项开放问题——WebView2 Process 句柄保留、授权 EOF 发现文件残留——都阻止完整验收。八小时继续暂缓，D3b 未完成；物理/系统/跨身份与发布预算等原缺项保留。

### 2026-10-30：退出等待修正候选开始构建

针对 `P2-dbx-eof-discovery-retained`，主树及新冻结 `shutdown-barrier/source/` 的插件进程 owner 改为同时等待原桥的有界 shutdown 与 AppState Host End shutdown。相对 `stalled-spectrum/` 仅 `plugin/backend/src/main.rs` 改变；未引入新的播放 owner、协议、音频状态或原 UI 逻辑。72/547 项输入指纹为 `596f2543…` / `c2ad542c584bb8cf69f16fbfc7beb875c70569fb8ecb54ebe14e180e896dc28a`，原生组件继续不变。先实现再验证，不走 TDD。

两版 Rust 1.88 / `-D warnings` 及格式检查已通过；准确新包构建与实际 EOF 复验仍在进行，暂不计修复通过。打包器此前已删除旧临时编译目录，初始缓存 junction 实为悬空，SDK 在编译前以 error 183 拒绝；只移除本次两个 junction，未递归清理或改动原产物，随后冷构建。原失败报告继续保留。房间验证若使用上一候选的独立服务，将按其准确 SHA 记录为原样的 guest helper，不冒充本次同源重建的独立服务。


### 2026-10-30：进程退出等待修正及重复复验

`shutdown-barrier/qualification.json` 绑定相对上一候选只改插件 `main.rs` 的准确新包、619 项冻结输入、原始驱动/测量和保全记录。插件指纹 `c2ad542c584bb8cf69f16fbfc7beb875c70569fb8ecb54ebe14e180e896dc28a`；桌面输入和 `07d87e…` 组件仍不变。EOF 路径由进程 owner 并发等待原桥有界清理和原 AppState Host End shutdown；退出信号路径也等待这两者，避免 detached 桥任务随 runtime 提前结束。未新增播放 owner、接口、状态或原 UI 变更。

| 新包 | .dbxp SHA-256 | 包内 exe SHA-256 |
| --- | --- | --- |
| standard | `a40faa1a3e35485b6ccd9a998b20e1802a64fb7cb1f492edd8ae429c0af2faae` | `fb0401a62b5505743dd2295ae0cad1e6231c5bd290187e0adcc39afed8900234` |
| full | `692089ccbe4e6039e40162b6ad11e50208c984726f302c9b84cc5ffde601e837` | `b4fca17380515771d89f5dbabd9fd3c647911db25822dbbdb790a31cb6a3b684` |

两版包内实际原 cpal stdio **314/314、298/298**，基础 RPC/未授权零桥文件/零原生配置，实际构建身份与逐文件独立复算，最低 0.6.35/当前 0.6.47 的真实 PluginHost 八组均通过。两版 Rust 1.88 / `-D warnings` 与格式检查通过。每版实际执行 **10 轮路径别名退出、3 轮播放/大文档退出**，另各一轮默认 27 项与撤销失败/重启五项，15 份双版管道报告均通过；发现文件在正常退出后清除，授权保持且重启双 scope 恢复。大文档不读取会按原期限取消并回收槽位，实际暂停/seek/切曲/歌词修订子项保持。重复是有限样本，不声称故障率为零。

阻塞房间 EOF 按两版 × 原无授权/双 scope 阻塞 × 三轮，共 **12 份**实际报告通过；管理应答被阻塞时两版各三种 EOF 也通过。房间 guest helper 使用上一候选准确 SHA 的独立服务，未重建、未冒充新源码同源服务；所有插件均为本批包内 exe。

另复验两版来源 owner 强退/接管、旧冲突实例退出及数据目录移动共 **8 项**；管理错误 build、八路并发连接撤销及重连共 **6 项**；授权替换/发现替换/writer lock 实际失败后的强退重启恢复共 **6 项**，合计 **20 项**均通过。旧 session 被拒绝，接管实例的发现记录不会被旧冲突实例退出删除，授权、设置及队列保持；三种激活失败均保持 gate 关闭，显式恢复后双 scope 响应正常。管理对端是准确 SHA 的协议夹具，本项不是实际旧 native 宿主或 GUI 强退证据，也不代表穷尽崩溃时序。

当前官方 DBX **0.6.47** 新隔离会话又运行提交 `1d042b8` 基线与新包两版共四次原核心图形流程：实际播放/seek/队列、约一分钟定时暂停、主题/预设及关闭重开工作台一致，原进程身份保持，八类 MediaSession 注册保持。新包两版零新增桌面请求、gate/listenerReady=false、无桥文件和原生配置。使用原流程/断言，只替换会话输入与新包路径；不改原全局任务元数据。真实宿主正常退出，14 个 PID/创建时间确认的归属实例消失，原窗口状态文件恢复且共用文件哈希不变。截图经查看仅作实际 UI 辅助，软件注册不等于物理媒体键或声学通过。

`P2-dbx-eof-discovery-retained` 仅在本冻结候选中标记修正通过，原 `stalled-spectrum/` 及更早候选的失败保留，旧索引不改写。前批真实欠载频谱修正源码原样继承；本插件入口增量没有再次运行在线 GUI 欠载，不能把旧报告换成新包身份。

`P2-native-process-handles-retained` 仍 open。完整非八小时验收/D3b、全部新候选 GUI/故障交错、内部 controller/listener 资源回收、物理媒体键/鼠标穿透/托盘找回、登录自启/锁屏/断屏/Explorer 恢复、声学/绝对资源预算/正式签名以及缺设备的用户/会话和 macOS/ARM64 资格仍未完成；八小时继续按用户要求暂缓，共享主树其余修改未纳入本批。DBX 单独使用无行为变化硬约束保持。


### 2026-10-30：退出等待候选的已授权图形与宿主生命周期

`shutdown-barrier/authorized-qualification.json` 绑定准确新包及未变的 `07d87e…` / SHA `4d2906…` 组件。当前官方 DBX 0.6.47 两版真实首次 UI 授权、显式切源与两种 surface 启用通过；授权/打开中心未隐式切源。已授权期间胶囊→展开、关闭工作台、宿主最小化→恢复均保持原 sidecar PID/创建时间、播放及同 session 歌词/壁纸。两版播放中/暂停中各伪造 pause/seek/play，共 **12 次**原生 IPC 均拒绝；实际暂停后旧频谱归零，环境绘制继续。

两版各 stop/kill sidecar 共 **4 次**，约 **1.46–1.50 秒** 清空旧音乐数据；组件存活、环境动画继续，新 session 恢复同 key 与同内容歌词，授权保持。两版各正常/强制退出 DBX 并重启共 **4 次**，约 **1.08–1.51 秒** 清空，组件继续运行、旧 host 及其归属实例按 PID+创建时间全部消失，重启后恢复新 session 和同 key 文档。原三秒清空与恢复断言不变。组件先于 DBX 启动的实际手动顺序也通过：保留原绑定、显示等待、无播放器被启动，随后 DBX 启动可恢复；**这不是 Windows 真实登录自启资格**。

实测区分宿主退出和 sidecar 自然退出：两次正常 DBX quit 的宿主 exit=0，但 Job 内 sidecar exit=1；两次强制 DBX 退出的宿主 exit=1，sidecar 却为 exit=0。四次均可能留下准确旧 PID/session 的发现记录，原生仍按期限清空，接管后新 session 恢复。只读 .NET Process 句柄观察记录真实退出码并及时释放；本地 DBX 源码仅辅助解释，不冒充官方 exe 的源码身份。**exit=0 本身不能证明 sidecar 走完自然清理**，不能为了删除 Job 中断后的残留而修改 DBX。上一批受控 stdin EOF 的发现删除检查继续严格通过，未改阈值或移记本批结果。

首个已授权会话正常结束后，**21 个**当时归属实例消失，实际 native/host 均 exit=0；这不意味着每个 Job 子进程都是自然退出。宿主四次恢复和最终退出另逐批核对整棵归属树，原生最终正常退出且无该批 DBX/sidecar/native 进程。原用户配置、288 个历史文件与另两文件的前批明确基线、全局 DBX 文件及原全局任务元数据保持；共享 debug 服务未动。

四次未通过尝试原样保留并分类：生成器未生成入口、错误把正常宿主退出等同 sidecar EOF、观察器晚于首次文档投递、错误把强退后的 sidecar exit=0 等同自然退出。最终提前安装原透传观察器，用真实退出方式和旧 PID/session 校验残留；保留原新鲜度、播控拒绝、文档恢复及整树清理要求。全部尝试均正常清理组件和剩余宿主；没有将失败报告改为通过。截图仅辅助实际内容观察，不证明物理透明合成、鼠标穿透或声学。

`P2-native-process-handles-retained` 仍 open；完整非八小时验收、最低宿主的新包完整图形与其余 UI/故障组合、内部 controller/listener 回收、真实 Windows 登录/物理输入/锁屏与系统桌面恢复、声学和绝对资源发布预算/签名、缺设备的其他用户/会话及 macOS/ARM64 资格仍未完成。八小时继续暂缓，D3b 保持未完成；本轮无产品源码修改或重建，其他共享主树修改不归本批资格。


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


### 2026-10-30：新鲜度候选的故障注入与运行时版本对照

准确产物为本轮最新候选 `source-expiry-1793334922641/`：native SHA `9f21f7d7…` / build `51d392…`，配套受控夹具按同一冻结 IPC crate 重建为 SHA `6baebd08…`，只新增逐 scope 协议版本注入，快照/文档语义与安全校验、对端 PID、期限均未变。详细数值与首轮失败见[审查修复记录](./2026-10-30-desktop-review-fixes.md)的「新鲜度候选的故障注入补验与运行时对照」。

- 数据管道故障 **14 项**通过（`output/playwright/desktop-native-feed-faults-1793341496160/report.json`）：单侧持续 500 在 **2993.64 / 2995.19ms** 只使该 scope 过期，403 撤权在 **491.73 / 208.69ms** 只作废该 scope，另一侧持续更新；瞬态 500 与畸形协议保留内容与同 key 文档，恢复后两 scope 序号继续推进。首轮 `desktop-native-feed-faults-1793341394247` 因驱动补丁插入位置错误在第一个用例 `0 !== 2` 停止并暴露 `processInventory is not defined`，保持失败，未计入通过。
- 管理通道 **3 项**、壁纸自愈 **2 项**通过：应答丢失后可查询并重试，**8 个**独立真实进程共用一个原生中心，不读取的持槽客户端 **2327.17ms** 内由他人取回且不阻塞后续请求（期间 **3 次** `control_busy` 瞬态重试成功）；渲染页崩溃约 **12718.72ms**、动画停转约 **12244.53ms** 后自动重建并回到同 session/同来源，停转期间歌词播放状态不受影响。三组各 **11 个**归属实例按 PID/创建时间消失，共用原生配置逐字节未变。这些是受控夹具故障，不代替真实 DBX 快照与物理系统恢复。
- WebView2 运行时对照（`webview2-minimal-probe/runs/runtime-contrast-1793339944515/report.json`，`diagnosticOnly=true`、`productChanged=false`）：用受支持的 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 在各自隔离 profile 中分别运行本机 **155.0.4283.62** 与 **156.0.4314.50**，并断言所有浏览器进程 `ExecutablePath` 等于所选运行时。两版行为一致——全新 profile 首个生命周期十轮增量 **0**，同 profile 第二个生命周期十轮均 **+10**，六十秒泵送冷却后不释放，各阶段八个归属实例正常退出无残留。**因此该现象不是 155 → 156 的版本回归，回退或钉住旧运行时不构成修复**；仍不能由此定位内部持有代码。`P2-native-process-handles-retained` 保持 open，产品资源验收未通过。
- 只读 Authenticode 复核（`native-faults-1793341204844/native-authenticode.json`）：准确 native 状态 **NotSigned**、无签名者，`signedDistributionQualified=false`。这把此前笼统记作“待验”的签名缺口明确为**当前构建确实未签名**，未据此改动产品，也不与 DBX Store 包签名资格混用。
- 主树输入重新指纹（`main-observed-takeover-1793342578.json`）：桌面 **73 项** `fef7f559…`、插件 **548 项** `fa7cbb9d…` 与已验证候选逐项相等；工作区内其他任务的非输入改动保留，资格仍只归准确冻结产物。本机仍存在未关闭的缺项：真实登录自启/锁屏/断屏/Explorer 恢复、物理媒体键/鼠标穿透/托盘找回、声学、绝对资源发布预算与签名、窄 HTTP 播控端点的房间权限路径，以及缺设备的其他身份与 macOS/ARM64。八小时继续暂缓，D3b 与完整非八小时验收未完成；DBX 单独使用无行为变化硬约束不变。


### 2026-10-30：接手轮补齐窄 HTTP 播控端点的房间权限路径

上一段列出的“窄端点房间权限路径未验”已在本轮补上：从**冻结候选源码**构建独立 Standard 服务（`source-expiry-1793334922641/standalone/standard/built.json`，二进制 SHA `d1759371…`、build `51d392…`、rustc 1.98.1、548 项冻结输入逐项校验、配套 native 仍 `9f21f7d7…`），用**两个真实服务进程 + 真实 loopback TLS 房间**驱动 `/v1/desktop-lyrics/control`。**未启动 DBX 宿主，未接原生 surface，因此不新增宿主图形或物理输入资格。**

- 建房前同一把 `Desktop` 钥匙、同一具身结构的 `play`/`pause` 各 **200** 落地（`/v1/state.playing` 实际转真再转假）；离房后重新 load 再次 **200** 生效。拒绝不来自钥匙或端点失效。
- 房间激活时房主与访客各三次 `play`/`pause`/`seek` 共 **9 次**全部 **409 `stale_playback`**；接管使代际 **4 → 5**（房主）、**2 → 3**（访客），九次尝试**不额外增加代际**且 `playing` 保持 false。授予 transport 后房间层命令受理（**200 / `state=no_op`**），窄端点仍三次 409——房间权限不打开这条路径。
- 机制已核对到源码：`room/manager.rs:122` 无条件 `acquire_exclusive()`，`vmusic-audio/src/actor.rs:493` 的 `EnterExclusive` 清空 `track_id` 并 +1 代际，故 `routes.rs:760` 的身份闸门先命中；`require_local_playback()` 的 `room_mode_requires_room_command` 分支在其后，本轮同组交叉核对里宽端点 `/v1/player/play` 返回 **400 `bad_request`（message 含该码）**。这是既有实现的既有顺序，**未修改产品代码**。
- 驱动三次失败保留、不改写为通过：`dbx-desktop-expiry-narrow-room-1793343892954`（把 **422 `room_reconnecting`** 房间反压当致命）、`…1793343975637`（重试助手只回传 body，误判已 **200/no_op** 的授权结果）、`…1793344016299`（把 `{status,body}` 当快照体）；驱动 SHA `87d9d033…`→`b2fb2d78…`→`4662cdc8…`→通过版 `5bfbfd0b…`，初版副本 `verify-expiry-narrow-room-guard.initial.js`，最终轮记录 **4 次**瞬时重连重试。证据绑定 `source-expiry-1793334922641/narrow-room-qualification.json`；两服务 exit=0，**2 个**归属实例按 PID/创建时间消失、无残留。

本轮只关闭这一条缺项。`P2-native-process-handles-retained` 仍 open（155/156 对照已否定“回退运行时即修复”），native 实测 **NotSigned** 使签名缺口成为实证；真实登录自启/锁屏/断屏/Explorer 恢复、物理媒体键/鼠标穿透/托盘找回、声学、绝对资源发布预算与签名、其余 I/O/崩溃/session/seq 组合，以及缺设备的其他身份与 macOS/ARM64 继续待验。八小时仍按用户优先级暂缓，完整非八小时验收与 D3b 未完成；DBX 单独使用无行为变化硬约束不变。


### 2026-10-30：接手轮的跨 scope 延迟隔离与三条量尺边界

按用户选择「只推不打断的补验」，在准确 native `9f21f7d7…` + 受控夹具 `6baebd08…` 上补了一项交错：**歌词文档回复拖慢时壁纸必须照常出帧**。结果通过（`output/playwright/desktop-native-feed-faults-1793352435361/report.json`，绑定 `latency-isolation-qualification.json`）：该次 document 请求 `delayMs=1600`，在途窗口内壁纸 feed 序号 **85 → 90**（12 点采样、6 个不同序号）、窗口内 **7 次**壁纸应答完成，两 scope 全程在线、`wallpaper.debug.valid` 全程为真，文档最终落页；原生与夹具 exit=0，**11 个**归属实例消失，共用配置逐字节未变。

同轮把三条容易踩错的量尺钉下来，失败报告全部保留、未放宽门槛：一是 **2500ms 文档延迟超过原生两秒文档期限**，走的是既有超时重取而非落地（`…1793352299317`）；二是**「从改状态到落页」不能当请求起点**，它含快照轮询与派单，实测 2559–2606ms（`…1793352374995`）；三是**基线 key 不可假定为 `key-A`**，前一用例的 track 会改掉它（`…1793352073356`、`…1793352141039`），另有一例是在文档仍为 null 的窗口里读 `document.value.documentKey`（`…1793352251697`）。五次都是夹具侧预期/量尺构造错误，产品代码未改。

该批只覆盖单侧文档延迟与另一侧隔离这一条组合。随后同一候选又完成**真实 Explorer 重启、断屏 6 秒与真实锁屏（`LockWorkStation` + 用户本人解锁）**三项系统恢复验证：锁内宿主与两路 feed 继续、壁纸窗保持同一 WorkerW 子窗（不需重建），解锁后有效帧与歌词内容正常；Explorer 重启则确实走了 `recovery success attempt=1` 并挂到新窗口。证据见 `lock-recovery-qualification.json` 与 `system-recovery-qualification.json`，七至八次驱动失败轮全部保留。仍待验：注销登录自启（需用户注销一次）、物理媒体键/托盘、声学、绝对资源预算与签名（native 实测 NotSigned）、其余 I/O/崩溃/session/seq 组合、其他身份与 macOS/ARM64。`P2-native-process-handles-retained` 依旧 open；八小时按用户优先级暂缓，完整非八小时验收与 D3b 未完成。


### 2026-10-31：P3 修复落地与新原生候选

准确的原生候选换为 `output/dbx-desktop-d3/p3-fix-1793451059/`：native SHA `8ed73880…` / build `ef17de41…`，由工作区整份冻结副本以 `cargo +stable build --offline --locked --release -p hertz-desktop --target x86_64-pc-windows-msvc` 冷构建（cargo 1.98.1，2m52s），归档 SHA `22c2b694…`；解包验包确认 `--describe` 与清单逐字段相等、PE 为 x64、`--describe` 不创建配置。桌面源码指纹 73 项 `30acb2f8…`（上一版 `fef7f559…`），**差集只有 `crates/hertz-desktop/src/app.rs` 与 `crates/hertz-desktop/src/dbx_feed.rs`**——前者加 `on_moved` 的「无内容不持久化位置」守卫，后者把缺失/非对象 `server` 块的快照体从身份失败改判为格式失败。工作区侧复核：`hertz-desktop` 56 项 + `hertz-desktop-ipc` 19 项 + `primitives` 16 项单测通过（exit 0，`worktree-tests.log`）；`dbx_feed.rs` 整文件 `rustfmt --check` 通过，`app.rs` 在本工具链（rustfmt 1.9.0-stable）有 11 处**已提交代码**的既有 drift，守卫所在行段不在其中。定向 clippy（两 crate、`--all-targets -- -D warnings`）**红在 7 处既有 lint**（`config.rs:762` 多余 borrow、`dbx_feed.rs:375` 用 `slot` 索引 `slots`——HEAD 里就有这段，另有 5 组 `config.rs` 测试里的 `Default::default()` 字段赋值），全部落在本次两处补丁（`dbx_feed.rs` 312–330、`app.rs` 2763–2770）之外；`hertz-studio` crate 的单测这轮没跑成，`target/debug/hertz-studio.exe` 被两个 10-29 起的开发实例占着（PID 34600、3740），未擅自停止它们。

对该构建重跑并重新绑定五组（夹具 `c9351944…` 与驱动不变）：双侧 P3 十项（缺 `server` **3088ms**、非对象 **3064ms** 退避过期且 0 条身份日志；真会话不匹配 **741ms** 清空并记身份；文档体非对象重取 2 次不触发身份）、十四项故障组三轮（行为断言三轮 **14/14**）、请求速率（2→1→1→0、12 秒 4 次、健康侧 48 次、坏文档 4 次，与上一版逐位相同）、122.6 秒八相位浸泡（48 采样、406 请求、两 scope 恢复在线）、10 分钟健康基线（39 采样全程在线、进程句柄恒 21、线程 11–18 无增长、3666 次请求）。两条已定性的边界保留在产品结论之外：十四项组里有两轮只被收尾配置哈希判失败，新驱动用另一进程真 `SetWindowPos` 证明**有内容时外部移动在两个构建上都会保存锚点**（revision 1→2、锚点与移动后位置吻合、monitor 由 null 钉成主显示器），而**无内容时只有新构建拒绝保存**（旧构建继续写到 revision 3），即未锁定的歌词窗被拖动后记住位置是既有设计；基线那轮则是驱动的「最后五个线程采样必须相同」尾部判据撞上 11→13 台阶（上一版恰好结尾连平），并记录到 265.5s 一次壁纸心跳停、200ms 内由 attempt=1 恢复；同一条断言写在 try 里，抛错后驱动跳过了自己的收尾——宿主与夹具（PID 35632、32192）继续跑了约二十分钟才由本次会话终止，隔离配置最终停在 revision 4（驱动自己只做过一次 `wallpaper-apply`，另两次提交来自那个仍开着设置窗口的空闲时段），驱动文件按本轮实际使用的 sha 不改、「收尾搬进 finally」写进 `regressions.json` 的 limits。

范围：上一版 `9f21f7d7…` 的 60 条引用与 14 行已验结论不迁移，已在该记录里标注 successor；**P2 仍 open**（跨构建 1:1，与本次重建无关）。插件包未随本次重打——工作区 `plugin/ui/app.js` 另含三维歌单「当前曲」判据改动，插件指纹由 `fa7cbb9d…` 变为 `23ead43a…`，`verify-plugin-packages.py` 拒绝跨源码复用，所以原合同 314/314 与 298/298、最低/当前 PluginHost、两版 GUI 差分与授权生命周期都要在新树下重打插件包后重跑。推之前还要按 CI 口径把 `hertz-desktop` 那 7 处既有 clippy 红项收掉（其中两处 HEAD 就有），并确认 fmt 判定用的是同一 rustfmt 版本。八小时、D3b、完整非八小时验收、签名与绝对资源预算、注销自启、锁屏/显示切换、物理输入与声学仍按原清单未完成。证据：`p3-fix-1793451059/candidate.json`、`regressions.json`、`qualification.json`，`source-expiry-1793334922641/placement-save-boundary.json`，逐条读数与被取代措辞由 `record-check-doc-claims.js` 回核（85 项与记录一致，全部为断言而非目测）。
