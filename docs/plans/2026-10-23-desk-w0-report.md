# 桌面壁纸 W0 首轮原生验证报告

日期：2026-10-23。执行：本机 Qoder agent。状态：**W0 首轮局部通过；阶段未完成，不进入 W1**。已验证 WorkerW 图标层挂载、桌面输入、手动/全屏/锁屏/息屏/S3 睡眠五类暂停原因与原因叠加（含真实睡眠复测与 QUNS 防抖）、视觉时钟、Explorer 重启恢复、托盘重建与右键菜单、终态重试、10 次快速重启预算、controller 失败恢复、50 次进程级与进程内 surface churn、第二显示器挂载/混合 DPI、10 次断屏/重连与 14 次锁屏/解锁循环、设置预览租约、托盘图标回收与真实星座场景 10 次 GPU scope 循环；真实场景 context loss/8 小时长稳、预览 pending 交接、挂起通知回调和 10 次 Explorer 成功重启仍未完成。这是隔离探针结论，不是生产宿主方案，也不改变[桌面壁纸方案](../desktop-wallpaper.md)与[共享宿主设计](../desktop-host.md)的草案状态。

## 1. 结论

在目标 Windows 11 x64 上，**Progman 下的 WorkerW 子窗 + WebView2** 可以作为图标层之后的壁纸宿主：

- **W0-1（挂载与输入）**：`0x052C` 在 Progman 下创建可见的 `WorkerW` 子窗；初始 Z 序为 `WorkerW[0]`、`SHELLDLL_DefView[1]`，壁纸会盖住图标并命中点击。把 WorkerW 移到 Progman 子链底部后，Z 序变为 `SHELLDLL_DefView[0]`、`WorkerW[1]`，桌面图标重新可见。桌面置前后，`(1500,360)` 的 `WindowFromPoint` 返回 `SysListView32`、根为 Progman；合成点击没有到达壁纸页，`page_clicks 0→0`。**通过。**
- **W0-2（策略停绘）**：只调用 `controller.SetIsVisible(false)` 时，页面 rAF 继续（约 165 次/秒）且仍按 30 fps 绘制；必须同时让页面停止调度。`SetIsVisible(false) + window.stopMotion()` 后 `document.hidden=true`，10 秒内无 frame 回调，`sceneTime` 冻结在 7981 ms，截图露出系统壁纸；恢复时无大 dt。五类原因分别实测：手动、真实 Chrome 全屏（`QUNS_BUSY`）、锁屏（`QUNS_NOT_PRESENT`）、息屏（`WM_POWERBROADCAST` + `GUID_MONITOR_POWER_ON`）、S3 睡眠；锁屏复现两次，55 秒运行画面只推进约 31 秒，息屏触发 `reasons=0x08 hidden=true` 后帧停止、亮屏事件后恢复。S3 休眠期间 session 与息屏原因同时生效（`0x0c`），逐个解除不会提前恢复，唤醒后从同一 `sceneTime` 继续。**五类原因与原因叠加均通过；但传统 `PBT_APMSUSPEND` 未送达窗口。**
- **W0-2（QUNS 防抖，局部）**：真实 S3 唤醒时 QUNS 会短暂跳到 `state=2`；未防抖时曾把 session/display 原因一起清除、提前恢复约 1 秒。加入 1 秒稳定窗口后，睡眠期间 `reasons 0x08→0x0c→0x04` 始终 `hidden=true`，唤醒后只有 `state=5` 稳定 1 秒才恢复，`sceneTime` 无大 dt。
- **W0-4（时钟与预算，局部）**：30 fps 实际上约 27 次绘制/秒，15 fps 为 15 次/秒，60 fps 为约 55 次/秒；`seekSong(60000)` 只改变歌曲位置，视觉时间继续，不回退。**局部通过；15/30/60 组合、质量降档与真实场景未测。**
- **W0-4（多屏与混合 DPI，局部）**：目标屏按设备名/索引选择，WorkerW 扩到虚拟屏（0,0,4480,1600），壁纸窗落在外接屏（2560,0,4480,1080）。**窗口 DPI 仍继承主屏 144，目标屏为 96**：不补偿时页面 dpr=1.5、CSS 1280×720，文字放大 1.5 倍；加 `WebView::zoom(96/144)` 后 dpr=1、CSS 1920×1080，文字尺寸正常。外接屏输入命中 `SysListView32`/Progman，未拦截桌面。**这是探针级 workaround；生产仍需按每屏 DPI 建窗或正式补偿策略。**
- **W0-3（断屏/重连，局部）**：拔掉外接屏后 `monitor_missing` → `reasons=0x20 hidden=true`，帧冻结；插回后 `monitor_returned` → `monitor_apply` 重新定位/应用 DPI 补偿 → `hidden=false`，从冻结的 `sceneTime` 继续。随后用 `SetDisplayConfig` 自动切换 internal/extend 跑 10 轮：`missing=10`、`returned=10`、`apply=10`，无 `health_lost`/`recovery_`，退出后残留 0。**通过。**
- **W0-3（10 次锁屏/解锁）**：后台探针持续记录，实际捕获 **14 次**完整锁屏/解锁（≥10，可能多操作或系统多报）。每次 `session-absent` 隐藏/停绘、解锁后恢复，无 `health_lost`/`recovery_`，停止探针后残留 0。**通过（次数为 14，不是恰好 10）。**
- **W0-5（设置预览租约，局部）**：独立预览窗 + WebView，单实例租约 15 秒；第二次请求返回 `preview_busy` 并排队；续租延长到 15 秒；未续租时 `preview_expired` 关闭；排队请求超过 15 秒记录 `preview_pending_expired age_s=18.0` 后丢弃；随后新请求建立第 2 个租约。预览实测约 15 绘制/秒（`cap=15`），打开时进程 7→8、WebView2 6→7，关闭/退出后 `leftover=0`。**通过；旧租约提前关闭后的 pending 交接未测。**
- **W0-5（托盘图标累计）**：50 次进程级启停全部退出码 0；结束后 UIA 打开溢出面板统计同名图标 `tray_icons=0`，`wallpaper.exe`/专属 WebView2 残留均为 0。**通过。**
- **W0-5（真实场景 GPU scope，局部）**：`--scene-test` 内嵌仓库已提交的 `stage-runtime.js`/`zodiac-stage.js`，真实星座场景在桌面图标后方渲染；同一页面挂载/卸载 10 轮，每轮预热后 `geometries=118`、`textures=1`、`programs=11`，无增长；无 `scene_mount_failed`/`scene_mount_error`，退出后 `leftover=0`。**通过；context loss 恢复与 8 小时未测，`stats()` 不含 `resources/estimatedBytes`。**
- **资源基线（探针页面）**：7 个进程（探针 + 6 个 WebView2）；30 fps 阶段单核约 12.4%、工作集约 406 MB；手动暂停 0.8%；恢复 12.2%；15 fps 7.2%；60 fps 14.4%，工作集升至约 442 MB；GPU Engine 运动阶段约 5–13%，暂停为 0。**这是合成 canvas 页面的基线，不是生产星座场景；未做无壁纸对照或 8 小时曲线，不冻结发布阈值。**
- **W0-3（Explorer 恢复与托盘，局部）**：首次实现前，Explorer 重启会销毁 WorkerW/壁纸窗/controller，无恢复；实现健康检查与重建后，单次重启和连续两次重启都在同一 120 秒窗口内重新探测 Progman/WorkerW、重建窗口与 WebView 并重新挂载（attempt 1、2 均成功），截图恢复星空且图标仍在上层。Explorer 重启后托盘图标自动重建（无需宿主手工重注册），9 秒后可被 UIA 找到并真实左键点击，探针记录 Down/Up 事件且正常退出。终态后右键菜单可打开，第一项“重新挂载”可触发显式重试。**连续 10 次成功重启未达成（见终态预算）。**
- **W0-3（终态重试）**：4 次快速重启进入终态后，右键托盘选“重新挂载”：`retry_requested` → 预算清零 → `attempt=1` 恢复成功；随后第 5 次重启以 `attempt=2` 再次恢复；探针退出码 0、残留 0。**显式用户重试路径通过。**
- **W0-2（挂起通知，局部）**：`RegisterSuspendResumeNotification` 返回非零句柄；`--power-selftest` 直接向窗口投递 suspend/resume 消息，`reasons=0x10 hidden=true` 停绘、恢复后从同一 `sceneTime` 继续。**真实 S3 复测两次：`PBT_APMSUSPEND` 仍未送达（`tag=sleep` 计数 0）；有效信号是 `QUNS_NOT_PRESENT` 与 `GUID_MONITOR_POWER_ON`。**
- **W0-3（终态预算）**：`--restart-test` 连续 10 次重启 Explorer；第 1–3 次恢复成功（attempt 1/2/3），第 4 次触发 `recovery_terminal attempts>=3 window=120s`，之后不再尝试或刷健康日志；截图露出系统壁纸，探针最终退出码 0、残留 0。**快速 10 次重启在“3 次/120 秒”预算下按设计进入终态；需要重新定义 A6 的“10 次”是间隔超过窗口还是允许快速连续。**
- **W0-5（退出、失败与回收，局部）**：正常退出后壁纸窗口消失，当前系统壁纸可见，专属 WebView2 进程残留为 0。`--close-controller-after-ms` 注入 controller Close 后，周期 liveness 探测发现 `0x8007139F`，先关闭/销毁旧窗口再按统一预算重建，页面重新开始并正常退出。50 次进程级应用/停止全部退出码 0；进程内 50 次 controller/窗口重建同样零失败，每轮稳定为 7 个进程（6 个 WebView2）、工作集约 340–345 MB，无累积，退出后残留 0。**设置预览租约、场景 GPU scope/纹理释放与托盘图标累计未测。**

因此 W0 不能标记通过：挂载、停绘、恢复与进程级/进程内 surface churn 路线已成立，剩余阻断项是多屏等环境矩阵、设置预览/托盘图标累计、真实场景 GPU scope 释放、生产场景接入和长稳资源阈值。

## 2. 环境与身份

| 项 | 值 |
| --- | --- |
| 探针版本 | 锁屏策略实测于 `75e8ee4`；息屏/睡眠通知 `bae5ca3`；托盘重试 `33c7a1d`；controller 失败恢复 `25e5e7e`；进程内 churn `a379095`；QUNS 防抖 `3fe8779`；多屏/DPI/断屏 `f4584b4`；预览租约 `7092955`；当前 `ca42339`，2,276,352 bytes，SHA-256 `002239ca64ed8dc658b904a8c4f9890180e6100d4dc21d3f9d90e064ab2ff9ca`；早期轮次 `cbf4347`/`b6185eb`/`2404413`/`2214858` |
| 工具链 | rustc/cargo 1.98.1；`cargo +1.88.0 check --release --all-targets` 通过；`cargo clippy --release --all-targets -- -D warnings` 通过 |
| OS / 架构 | Windows 11 `10.0.26200` x64 |
| WebView2 Runtime | 155.0.4283.62 |
| 屏幕 / DPI | `\\.\DISPLAY1` 单屏；逻辑 1707×1067，物理 2560×1600；窗口 DPI 144；刷新率 165 Hz |
| GPU | Intel UHD Graphics 32.0.101.7088；NVIDIA GeForce RTX 4060 Laptop 31.0.15.3753（未驱动该屏） |
| 依赖 | wry 0.57.0、tao 0.37.1、tray-icon 0.24.2、windows-sys 0.61.2；与 L0 探针共用隔离工作区 |
| 隔离 | 探针不在主 workspace；WebView2 用户数据目录指向实验输出目录；未改产品代码或发布候选 |

## 3. 实验记录

运行时间 2026-10-23 17:00–2026-10-24 11:50。`run1/run2` 用于定位 Z 序与输入，`run3/run5` 为停绘与时钟主证据，`run4` 为恢复实现前的 Explorer 重启，`recovery2` 为恢复第一版的单次重启，`recovery4` 为加入单次尝试内等待后的连续两次重启，`fullscreen1` 为真实 Chrome 全屏，`tray-rebuild3` 为恢复后的托盘点击，`restart10` 为 10 次重启/终态预算，`resource1` 为资源基线，`lock-observe2`/`lock-policy1`/`lock-policy2` 为锁屏，`monitor-off1`/`monitor-off2` 为息屏，`sleep3` 为首次强制 S3，`retry3` 为终态后托盘重试，`power-selftest1` 为挂起通知自检，`controller-fail1` 为 controller 失败恢复，`cycle50` 为 50 次进程级启停，`w0-cycle-in-process1` 为 50 次进程内 churn，`sleep-real3`/`sleep-real4` 为真实 S3 与防抖复测，`monitor-ext2`/`monitor-ext3` 为外接屏挂载与 DPI 补偿，`monitor-hotplug5` 为单次拔插，`monitor-cycle10` 为 10 次自动断屏/重连，`lock-cycle10b` 为 14 次锁屏/解锁，`tray-count50` 为托盘图标统计，`preview1`/`preview2` 为预览租约，`scene1` 为真实星座 scope 循环。锁屏策略为 `75e8ee4`，息屏/睡眠通知为 `bae5ca3`，托盘重试为 `33c7a1d`，controller 失败恢复为 `25e5e7e`，进程内 churn 为 `a379095`，QUNS 防抖为 `3fe8779`，多屏/DPI/断屏为 `f4584b4`，预览租约为 `7092955`，真实场景测试为 `ca42339`。

| ID | 操作与观测 | 结果 |
| --- | --- | --- |
| W0-1 Z 序 | 枚举 Progman 子窗；发送 `0x052C`；读取 `GetWindow(GW_CHILD/GW_HWNDNEXT)` | `0x052C` 创建 WorkerW 子窗；初始 `WorkerW[0]` 在 DefView 之上，截图盖住图标；移到 `HWND_BOTTOM` 后 `DefView[0]`、`WorkerW[1]` |
| W0-1 挂载 | `SetParent(hwnd, workerw)`、`HWND_BOTTOM`、屏幕尺寸；读取父链/样式 | `parent=WorkerW`、`parent_is_workerw=true`、`visible=true`；父链 `Window Class>WorkerW>Progman`；rect `0,0,2560,1600` |
| W0-1 输入 | 桌面置前后，在 `(1500,360)` 合成点击，读取 `WindowFromPoint` 与页面 IPC | `raw=SysListView32`、`root=Progman`、`overlay_clicked=false`、`page_clicks 0→0`、`SendInput=3`；通过 |
| W0-2 controller 隐藏（单独） | `SetIsVisible(false)`，保持页面 rAF | 页面继续约 165 rAF/s、约 27 绘制/s；未停绘（`run2`，无 hidden 采样） |
| W0-2 组合停绘 | `SetIsVisible(false) + window.stopMotion()`，持续 10 秒 | `document.hidden=true`、`visibility=hidden`；无 frame 回调；`sceneTime=7981 ms`、`draws=220` 冻结；截图露出系统壁纸 |
| W0-2 恢复 | `SetIsVisible(true) + window.startMotion(30)` | `hidden=false`；帧恢复；`sceneTime 7981→8986 ms`（1 秒内），无大 dt；截图恢复星空 |
| W0-4 30/15/60 fps | 页面每秒上报 frames/draws；切换上限 | 30 fps 约 27 绘制/s；15 fps 15/s；60 fps 约 55/s；rAF 约 165/s |
| W0-4 视觉时钟 | `seekSong(60000)`；暂停 10 秒后恢复 | `songPosition=60000` 变化时 `sceneTime` 继续；恢复后从冻结值继续，无追赶 |
| W0-3 Explorer 重启（恢复前） | 运行 `restart-explorer.ps1`（Explorer `11024→8548`；taskbar 重建） | WorkerW 与壁纸窗销毁；`alive=false`、`workerw_alive=false`；后续 eval 全部 `0x8007139F`；托盘 `Error removing system tray icon`；无恢复 |
| W0-3 单次重启恢复 | 实现健康检查/重建后重启 Explorer | `health_lost` → `recovery_begin attempt=1` → `recovery_success attempt=1`；新 hwnd/WorkerW，Progman 子序仍为 DefView、WorkerW；截图星空与图标正确；`leftover=0` |
| W0-3 连续两次重启 | 第一次恢复后再次重启 Explorer | `attempt=1`、`attempt=2` 均成功；新 WorkerW 重建；截图星空与图标正确；未触发终态 |
| W0-3 托盘重建 | Explorer 重启恢复后等待 9 秒，用 UIA 打开溢出并真实左键点击托盘图标 | 图标自动重建（rect x=1954），`tray_event` Down/Up；探针正常退出、无挂起 |
| W0-3 10 次重启/终态 | `--restart-test --duration-ms 90000`；连续 10 次 `restart-explorer.ps1` | 第 1–3 次恢复成功；第 4 次 `recovery_terminal attempts>=3 window=120s`；之后无健康/恢复日志；截图露出系统壁纸；退出 0、`leftover=0` |
| W0-3 托盘右键菜单 | 终态后等待约 15 秒，`tray-menu.ps1` 真实右键并选择第一项 | `menu_window` 非空，`menu_event=1001`；第一项“重新挂载”触发 `retry_requested` |
| W0-3 终态重试 | 终态后经托盘“重新挂载”，随后第 5 次重启 Explorer | 预算清零 → `attempt=1` 恢复成功；第 5 次重启 `attempt=2` 成功；截图星空；退出 0、`leftover=0` |
| W0-2 挂起通知自检 | `--power-selftest` 向窗口投递 suspend/resume | `register_power monitor_handle`/`suspend_resume_handle` 均非零；`reasons=0x10 hidden=true` → 恢复；真实 S3 两次仍未送达 `PBT_APMSUSPEND` |
| W0-5 正常退出 | 完成计划后退出，截图桌面 | 壁纸消失，露出当前系统壁纸；`leftover=0` |
| W0-5 controller 失败 | `--close-controller-after-ms 5000` 关闭壁纸 controller | `controller_close=Ok`；周期 liveness 探测报 `0x8007139F`；`recover_destroy_old destroyed=1` → `recovery_success`；页面重启并退出 0 |
| W0-5 50 次启停（进程级） | 50 次 `--restart-test --duration-ms 1500` | 50/50 退出码 0；结束时 `wallpaper.exe` 与专属 WebView2 残留均为 0 |
| W0-5 50 次进程内 churn | `--cycle-test --cycles 50`：每轮关闭 controller、销毁旧窗、重建挂载 | 50/50 `alive=true`、`failures=0`；每轮 7 进程/6 WebView2，工作集 340–345 MB，无累积；退出后残留 0 |
| W0-2 真实全屏 | Chrome `--start-fullscreen` 覆盖目标屏；探针每 500 ms 轮询 `SHQueryUserNotificationState` | 5→2 触发 `fullscreen` 原因：`hidden=true`、`stopMotion`、无 frame；2→5 后 `hidden=false`，从 `sceneTime=5993 ms` 恢复，无大 dt |
| W0-2 原因叠加 | S3 睡眠期间 session 与息屏同时生效，再逐个解除 | `reasons=0x0c`（session+display-off）；亮屏先清 `0x08` 时仍 `hidden=true`，只有 session 解除后才恢复绘制；**通过** |
| W0-3 休眠/唤醒 | `SetSuspendState(hibernate=false)` 强制 S3，约 20 秒后唤醒 | 页面被 S3 冻结；`QUNS_NOT_PRESENT` 与息屏通知都到达；恢复后 `sceneTime` 继续，无大 dt；`tag=sleep` 计数 0 |
| W0-2 QUNS 防抖 | 真实 S3 唤醒时 QUNS 短暂跳到 `state=2`；加入 1 秒稳定窗口后复测 | 未防抖时提前恢复约 1 秒；防抖后 `0x08→0x0c→0x04` 全程 `hidden=true`，仅 `state=5` 稳定 1 秒后恢复 |
| W0-4 外接屏挂载 | `--monitor-index 2` 选择 `\\.\DISPLAY5`（2560,0,4480,1080） | WorkerW 扩到虚拟屏 0,0,4480,1600；壁纸窗 rect=2560,0,4480,1080；`WindowFromPoint` 命中 SysListView32/Progman，页面点击 0 |
| W0-4 混合 DPI | 外接屏 96 DPI，窗口继承主屏 144 DPI；对比不补偿与 `zoom=96/144` | 不补偿：dpr=1.5、CSS 1280×720、文字 1.5 倍；补偿后 dpr=1、CSS 1920×1080、文字正常；截图确认 |
| W0-3 断屏/重连 | 物理拔掉外接屏约 20 秒再插回 | `monitor_missing` → `reasons=0x20 hidden=true`、帧冻结；`monitor_returned` → 重定位/补偿 → `hidden=false`，从冻结 `sceneTime` 继续 |
| W0-3 10 次断屏/重连 | `SetDisplayConfig` internal/extend 自动切换 10 轮 | `missing=10`、`returned=10`、`apply=10`；无 `health_lost`/`recovery_`；退出后残留 0 |
| W0-3 14 次锁屏/解锁 | 后台探针持续记录用户操作 | 每次 `session-absent hidden=true` 后恢复；实测 14 次（≥10），无恢复风暴；停止后残留 0 |
| W0-5 预览租约 | `--preview-test`：15 秒租约、续租、重复请求、过期、再开 | `preview_busy` 排队 → `preview_renew` → `preview_expired`；排队 18 秒后 `preview_pending_expired`；第 2 个租约打开；15 绘制/秒；退出残留 0 |
| W0-5 托盘图标累计 | 50 次启停后 UIA 打开溢出面板统计同名图标 | `tray_icons=0`；无 `wallpaper.exe`/专属 WebView2 残留 |
| W0-5 真实星座 scope | `--scene-test` 同页挂载/卸载 10 轮，读取 renderer 统计 | 每轮预热后 `geometries=118`、`textures=1`、`programs=11`，无增长；无挂载错误；退出残留 0 |
| W0-2 锁屏（策略前） | 用户 `Win+L` 约 20 秒；探针只轮询 QUNS | `state=1` 出现并回落 5，但 53 秒帧序列无冻结——锁屏不会自动停 WorkerW 的 WebView |
| W0-2 锁屏（策略后） | 接入 `QUNS_NOT_PRESENT` 为 session 原因，复现两次 | `reasons=0x04 hidden=true` + `stopMotion`；解锁后 `hidden=false`，从同一 `sceneTime` 继续；55 秒运行画面只推进约 31 秒 |
| W0-2 息屏（策略前） | `SendMessage(HWND_BROADCAST, SC_MONITORPOWER, 2)` 关屏 | 显示器实际黑屏超过 8 秒（脚本随后阻塞在 SendMessage，被强杀）；探针帧 1→49 连续推进，QUNS 全程 5——息屏同样不会自动停绘 |
| W0-2 息屏（策略后） | 改用 `SendMessageTimeout` + 必达唤醒；订阅 `GUID_MONITOR_POWER_ON` | off 上报 `tag=display-off reasons=0x08 hidden=true` 并停绘；on 上报 `hidden=false` 后恢复；系统随后再次上报 off，已手动唤醒 |
| W0-3 多显示器/混合 DPI | 目标屏迁移、断开重连、任务栏工作区变化 | 未执行；本机只有一块活动屏幕 |

原始截图位于本机忽略目录（含完整桌面内容，未提交）：`output/desk-w0/2026-10-23-w0-run3/`（`running.png`、`policy-paused.png`、`resumed.png`）、`run4/after-restart.png`（恢复前）、`run5/after-exit.png`、`recovery2/recovered.png` 与 `recovery4/recovered-twice.png`（恢复后）、`restart10/after-r3.png` 与 `after-terminal.png`（终态前后）；`w0-fullscreen1/probe.log` 记录全屏暂停/恢复的帧序列（该次截图落在随后的手动暂停期，不作为恢复画面证据）；`resource1/gpu.csv` 与 `probe.log` 记录资源基线。仓库只提交可复现脚本与文本证据。

## 4. 资源基线（探针页面）

正常 40 秒运行，整棵进程树为 `wallpaper.exe` + 6 个 `msedgewebview2.exe`。CPU 百分比以单核为 100%，工作集为各进程 WorkingSet 之和；阶段边界来自探针日志。

| 阶段 | 时长 | 进程树 CPU | 单核百分比 | 工作集 |
| --- | --- | --- | --- | --- |
| 启动（30 fps 起步） | 3.0 s | 516 ms | 17.2% | 396.6 MB |
| 30 fps | 12.0 s | 1484 ms | 12.4% | 406.0 MB |
| 手动暂停 | 10.0 s | 78 ms | 0.8% | 387.1 MB |
| 30 fps 恢复 | 5.0 s | 609 ms | 12.2% | 435.4 MB |
| 15 fps | 5.0 s | 359 ms | 7.2% | 436.8 MB |
| 60 fps | 5.0 s | 719 ms | 14.4% | 441.5 MB |

GPU Engine 采样（`sample-gpu.ps1`，约 4 秒一个点，按探针进程树 PID 过滤）：30 fps 阶段 7.82%、7.66%、5.50%；暂停点 0；恢复/15 fps 阶段 5.55%、4.44%；60 fps 点 13.0%；末尾 0。采样点与阶段边界只是近似对齐，不包含显存、功耗或频率。

限制：这是合成 canvas 星场页面，不是生产星座/Three.js 场景；没有“无壁纸”四态对照、没有 8 小时曲线，工作集在启动/阶段间从约 301 MB 升到 441 MB，不能视为稳态或发布阈值。

## 5. 关键发现与设计影响

1. **本机 WorkerW 是 Progman 的子窗，不是顶层兄弟窗。** 经典“顶层 WorkerW + SHELLDLL_DefView”路径不适用；需要枚举 Progman 子窗、找无 DefView 的 WorkerW。`FindWindow("Progman")` 在本机首次返回 0，枚举 `EnumWindows` 能找到，宿主发现逻辑不能只依赖 FindWindow。
2. **Z 序必须显式校正。** `0x052C` 生成的 WorkerW 初始在 DefView 之上，直接挂载会盖住图标并截获桌面输入；把 WorkerW 移到 Progman 子链底部后图标恢复可见，输入命中 SysListView32。生产宿主应把“挂载后校正 Z 序”作为挂载契约，并在每次 Explorer 重建后重做。
3. **controller 隐藏不等于停绘。** `SetIsVisible(false)` 会让 `document.hidden=true`，但页面 rAF 仍在跑；只靠 controller 会继续消耗合成/脚本资源。策略停绘必须同时停止页面调度；恢复时重新起循环并限制 dt。W0-2 的通过条件应写成“原生可见性 + 页面停绘”的组合，而不是单一 controller 调用。
4. **60 fps 上限实测约 55 次/秒。** 与 L0 的 30 fps 结果一致，简单 `1000/fps` 门限会损失约 8%；生产调度需要累计误差修正或如实报告有效预算。15 fps 本次为 15.0 次/秒。
5. **视觉时间可以独立于歌曲位置。** `seekSong(60000)` 不改变 `sceneTime`；暂停恢复从冻结值继续，没有大 dt。原型已保留“视觉时间 vs 歌曲位置”的分离，但尚未接入真实场景与频谱。
6. **Explorer 重启恢复已跑通，但恢复预算的计数语义需要谨慎。** 壁纸窗作为 WorkerW 子窗会被连带销毁，controller 失效；实现健康检查后在单次重启和连续两次重启中都完成了重新探测、重建窗口/WebView 与重新挂载（attempt 1/2 成功），截图恢复星空。第一版在 Explorer 尚未重建 Progman 时立即计一次失败，导致连续重启很快耗尽 3 次预算；改为单次尝试内等待 Progman/WorkerW 后，重建期的暂时缺失不再提前消耗预算。托盘图标在 Explorer 重启后自动重建（约 9 秒后可用 UIA 找到并点击），但右键菜单路径未验。
7. **正常退出露出当前系统壁纸。** 退出后窗口销毁、专属进程归零，系统壁纸没有被覆盖或回滚；这满足“不使用旧截图恢复”的方向，但崩溃路径和系统壁纸运行期改动仍未测。
8. **全屏检测可用，但仍是单屏 QUNS 近似。** 真实 Chrome 全屏使 `SHQueryUserNotificationState=2`，独立“全屏”原因触发隐藏与停绘，关闭后恢复。当前只验证单屏系统级状态；多屏目标边界、无边框/独占全屏差异、全屏与手动暂停叠加未测。生产实现应按目标屏前台窗口边界计算，不能只依赖系统级 QUNS。
9. **托盘左键默认弹菜单会阻塞宿主消息循环。** 第一次托盘点击测试使用默认 `menu_on_left_click=true`，弹出原生菜单后探针在计划时间无法退出；显式改为 false 后左键只产生 `tray_event`，探针正常退出。右键菜单随后实测可用：终态后 `menu_window` 非空，选择第一项“重新挂载”触发重试。生产托盘必须定义左键动作与菜单执行路径，不能让模态菜单阻塞 tick、退出或恢复。
10. **3 次/120 秒预算与“10 次连续重启”验收存在口径冲突。** 快速 10 次重启中前 3 次恢复成功，第 4 次进入终态，之后不再尝试；这是当前设计（成功恢复也占预算）的结果。显式重试已验证：托盘“重新挂载”清空预算并从 attempt 1 恢复，随后第 5 次重启以 attempt 2 继续成功；终态不会被自动解除。10 次成功恢复仍需把重启间隔拉到 40 秒以上（120/3）或修改预算语义，A6 的“10 次”需要明确是间隔测试还是快速连续测试。
11. **探针页面资源基线可用于对照，但不能冻结发布阈值。** 30 fps 阶段整树 CPU 约 12.4% 单核、GPU 约 5–8%、工作集约 406 MB；手动暂停降到 0.8% CPU/0 GPU；15 fps 7.2%，60 fps 14.4%，工作集升至约 442 MB。该页面是 canvas 星场，不是生产星座/Three.js 场景，且没有无壁纸对照与 8 小时曲线。
12. **锁屏与息屏都不会自动停绘，且信号来源不同。** 锁屏只体现在 `SHQueryUserNotificationState=QUNS_NOT_PRESENT`（息屏时 QUNS 仍是 5）；息屏只能通过 `WM_POWERBROADCAST` + `GUID_MONITOR_POWER_ON` 得到。两类都必须映射为独立暂停原因并真正取消页面调度，否则显示器关闭后 WebView 仍以约 165 rAF/s 绘制。
13. **S3 睡眠不会把 `PBT_APMSUSPEND` 送达该窗口。** 强制 S3 后探针收到的是 `QUNS_NOT_PRESENT` 与 `GUID_MONITOR_POWER_ON` 的 off/on，APM 挂起/恢复分支一次都没触发（`tag=sleep` 计数 0）。页面本身被 S3 冻结、dt 上限也避免了跳变。已注册 `RegisterSuspendResumeNotification`（句柄非零、自检通过），但**真实 S3 两次仍未送达 `PBT_APMSUSPEND`**；有效信号仍是 QUNS + 显示器电源。生产应改用 `PowerRegisterSuspendResumeNotification` 回调或独立顶层消息窗，或明确以 session/显示器信号为准。
14. **controller 失效可被周期 liveness 探测捕获并重建。** 关闭 controller 后窗口仍在、父链正常，单纯窗口健康检查不会发现；用 `evaluate_script("1")` 每 2 秒探测，收到 `0x8007139F` 后关闭并销毁旧窗口，再按统一预算重建。生产实现可优先用 WebView2 的 `ProcessFailed` 事件替代轮询，但必须验证事件在 WorkerW 子窗下的送达。
15. **进程级与进程内 50 次启停均未累积。** 50 次独立启动/退出全部退出码 0，结束时 `wallpaper.exe` 与专属 WebView2 残留为 0；同一进程内 50 次关闭 controller、销毁窗口并重建，逐轮保持 7 个进程/6 个 WebView2、工作集 340–345 MB，`failures=0`，退出后残留 0。仍缺：设置预览租约、场景 GPU scope/纹理释放（探针页面是 canvas，不产生 Three.js scope）与托盘图标累计。
16. **QUNS 状态必须防抖。** 真实 S3 唤醒时 QUNS 曾短暂跳到 `state=2`，未防抖的实现会把 session/display 原因一起清除并提前恢复约 1 秒。改为状态稳定 1 秒才应用后，睡眠期间 `hidden` 全程保持，唤醒只在稳定 `state=5` 后恢复；代价是锁屏/全屏的暂停生效和恢复都多约 1 秒，生产可用 WTS 事件缩短暂停延迟。
17. **WorkerW 子窗继承主屏 DPI，混合 DPI 需要专门策略。** 外接屏 96 DPI、窗口仍 144；页面按 1280×720 CSS 放大到 1920×1080，文字偏大。`WebView::zoom(0.667)` 可把 dpr 拉回 1、CSS 拉到 1920×1080，但这只是探针 workaround；生产应评估按每屏 DPI 建独立宿主窗口，或把补偿纳入宿主契约并验证清晰度/长稳。外接屏默认不显示桌面图标，输入仍命中桌面 ListView，两者不矛盾。
18. **10 次断屏/重连与 14 次锁屏/解锁均通过。** 用 `SetDisplayConfig` 自动切换 internal/extend，`monitor_missing`/`monitor_returned`/`monitor_apply` 各 10 次，无恢复风暴、无残留；锁屏/解锁实际捕获 14 次（≥10），每次停绘/恢复。目标仍按设备名匹配，设备名变化时用“同尺寸非主屏”兜底，这不是稳定显示器身份；10 次 Explorer 成功重启仍需按 40 秒以上间隔另测。
19. **预览租约按单实例 + 有界排队实现。** 15 秒租约、续租、过期关闭；重复请求只保留一个 pending，排队超过 15 秒显式 `preview_pending_expired` 后丢弃；关闭按 WebView→窗口顺序，WebView 创建失败会释放窗口，测试结束/退出无残留。预览 15 绘制/秒，打开时多 1 个 WebView2 进程；旧租约提前关闭后的 pending 交接未测。该实现是探针级状态机，生产租约仍需在宿主配置/IPC 中按共享宿主契约实现。
20. **50 次启停后托盘图标无累计。** 每轮进程退出都移除托盘注册，溢出面板同名图标计数为 0；进程级退出仍不能替代异常退出/Explorer 重启下的托盘清理，后者已有单次重建证据。
21. **真实星座场景 10 次挂载/卸载未累积 GPU 资源。** 内嵌已提交的 `stage-runtime.js`/`zodiac-stage.js`，真实星座在桌面后方渲染；每轮预热后 `geometries=118`、`textures=1`、`programs=11` 稳定，无挂载错误、退出无残留。未注入 WebGL context loss、未做 8 小时；`stats()` 不含 `resources/estimatedBytes`，只能以 renderer 的几何/纹理/程序计数为判据。

## 6. 复现

```bash
cd tools/desktop-probe
cargo build --release --bin wallpaper
cargo +1.88.0 check --release --all-targets
cargo clippy --release --all-targets -- -D warnings

OUT=../../output/desk-w0/<run>
./target/release/wallpaper.exe --out "$OUT" --source <commit>
# 连续重启/终态预算：约 90 秒内连续重启 Explorer，前 3 次恢复、第 4 次进入终态
./target/release/wallpaper.exe --out "$OUT" --source <commit> --restart-test --duration-ms 90000
# 挂起通知自检：向自身窗口投递 suspend/resume，无需真实睡眠
./target/release/wallpaper.exe --out "$OUT" --source <commit> --restart-test --power-selftest --duration-ms 12000
# controller 失败：5 秒后关闭 controller，观察 liveness 恢复
./target/release/wallpaper.exe --out "$OUT" --source <commit> --restart-test --duration-ms 30000 --close-controller-after-ms 5000
# 50 次进程级应用/停止（共享同一输出目录便于残留检查）
for i in $(seq 1 50); do ./target/release/wallpaper.exe --out "$OUT" --source <commit> --restart-test --duration-ms 1500; done
# 50 次进程内 surface churn：同一进程反复关闭 controller、销毁窗口并重建
./target/release/wallpaper.exe --out "$OUT" --source <commit> --cycle-test --cycles 50
# 设置预览租约：开→重复请求→续租→过期→再开
./target/release/wallpaper.exe --out "$OUT" --source <commit> --preview-test
# 真实星座场景：同页挂载/卸载 10 轮，读取 renderer 统计
./target/release/wallpaper.exe --out "$OUT" --source <commit> --scene-test
node parse-scene.js <OUT>/probe.log
# 托盘图标累计：50 次启停后统计同名图标
powershell -File tray-count.ps1 -Name 'Hertz DESK-W0 probe'
# 外接屏：monitor-index 按枚举顺序，日志会打印设备与矩形；断屏测试需物理拔插
./target/release/wallpaper.exe --out "$OUT" --source <commit> --monitor-index 2 --dpi-compensate --restart-test --duration-ms 25000
powershell -File monitors.ps1
powershell -File capture-region.ps1 -X 2560 -Y 0 -Width 1920 -Height 1080 -Out <OUT>\external.png
# 自动断屏/重连 10 次（探针运行期间）
for i in $(seq 1 10); do powershell -File display-switch.ps1 -Mode internal; sleep 3; powershell -File display-switch.ps1 -Mode extend; sleep 3; done
```

实验时在另一终端运行 `show-desktop.ps1` 把桌面置前；截图用同目录 `capture-screen.ps1`。全屏实验用 `fullscreen-check.ps1 -Out <OUT>\real-fullscreen`；息屏用 `monitor-off.ps1 -OffSeconds 6`（超时广播并在 finally 唤醒）；真实 S3 用 `sleep-now.ps1`（`SetSuspendState(hibernate=false)`，返回时已唤醒）。Explorer 恢复实验运行 `restart-explorer.ps1 -WaitSeconds 15`；恢复后等待约 9 秒再运行 `tray-click.ps1 -Name 'Hertz DESK-W0 probe'` 验证托盘图标重建。终态后等待约 15 秒，用 `tray-menu.ps1 -Name 'Hertz DESK-W0 probe' -ItemIndex 0` 右键并选择“重新挂载”。退出后用 `check-leftovers.ps1 -UserData <OUT>\webview2` 检查专属 WebView2 残留；资源采样用 `sample-gpu.ps1 -RootPid <pid> -Out <OUT>\gpu.csv`，阶段 CPU/工作集在探针日志的 `cpu_mark/cpu` 行。

## 7. 决定与下一步

- **决定：** 保留 `wallpaper` 探针作为 W0 复现入口；不把 WorkerW 挂载写成已批准生产方案，不进入 W1。W0 仍缺真实场景 context loss/8 小时长稳、旧预览提前关闭后的 pending 交接、挂起通知回调与 10 次 Explorer 成功重启；真实星座 10 次 scope 循环、预览租约与托盘回收已通过。
- **下一轮最小任务：** ① 真实星座 context loss 恢复与 8 小时/资源阈值；② 预览 pending 交接与设置预览租约的宿主化；③ 挂起通知改用 `PowerRegisterSuspendResumeNotification` 回调或独立顶层消息窗；④ 10 次 Explorer 成功重启（间隔 40 秒以上）。
- **复验触发：** Windows 构建、Explorer 桌面层级、WebView2 Runtime、wry/tao/tray-icon、DPI/刷新率或挂载算法任一变化，都必须重跑本报告对应实验。

本报告不把一次全屏/快速重启或短窗口资源采样当作完整 W0 通过，也不以合成页面替代生产星座场景的长稳与预算。
