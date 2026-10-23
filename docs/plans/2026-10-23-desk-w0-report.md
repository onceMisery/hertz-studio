# 桌面壁纸 W0 首轮原生验证报告

日期：2026-10-23。执行：本机 Qoder agent。状态：**W0 首轮局部通过；阶段未完成，不进入 W1**。已验证 WorkerW 图标层挂载、桌面输入、策略停绘（手动与真实全屏）、视觉时钟、Explorer 重启后的窗口重建与重新挂载，以及退出露出系统壁纸；连续重启达到 10 次、托盘重建、锁屏/息屏/休眠、多屏与长稳仍未完成。这是隔离探针结论，不是生产宿主方案，也不改变[桌面壁纸方案](../desktop-wallpaper.md)与[共享宿主设计](../desktop-host.md)的草案状态。

## 1. 结论

在目标 Windows 11 x64 上，**Progman 下的 WorkerW 子窗 + WebView2** 可以作为图标层之后的壁纸宿主：

- **W0-1（挂载与输入）**：`0x052C` 在 Progman 下创建可见的 `WorkerW` 子窗；初始 Z 序为 `WorkerW[0]`、`SHELLDLL_DefView[1]`，壁纸会盖住图标并命中点击。把 WorkerW 移到 Progman 子链底部后，Z 序变为 `SHELLDLL_DefView[0]`、`WorkerW[1]`，桌面图标重新可见。桌面置前后，`(1500,360)` 的 `WindowFromPoint` 返回 `SysListView32`、根为 Progman；合成点击没有到达壁纸页，`page_clicks 0→0`。**通过。**
- **W0-2（策略停绘）**：只调用 `controller.SetIsVisible(false)` 时，页面 rAF 继续（约 165 次/秒）且仍按 30 fps 绘制；必须同时让页面停止调度。`SetIsVisible(false) + window.stopMotion()` 后 `document.hidden=true`，10 秒内无 frame 回调，`sceneTime` 冻结在 7981 ms，截图露出系统壁纸；恢复时无大 dt。另用真实 Chrome 全屏：`SHQueryUserNotificationState` 从 5 变为 2 时触发独立“全屏”原因，controller 隐藏 + 页面停绘（`sceneTime` 冻结 5993 ms）；Chrome 关闭、状态回到 5 后恢复。**通过（手动与全屏分别验证；两者叠加未测）。**
- **W0-4（时钟与预算，局部）**：30 fps 实际上约 27 次绘制/秒，15 fps 为 15 次/秒，60 fps 为约 55 次/秒；`seekSong(60000)` 只改变歌曲位置，视觉时间继续，不回退。**局部通过；15/30/60 组合、质量降档与真实场景未测。**
- **W0-3（Explorer 恢复，局部）**：首次实现前，Explorer 重启会销毁 WorkerW/壁纸窗/controller，无恢复；实现健康检查与重建后，单次重启和连续两次重启都在同一 120 秒窗口内重新探测 Progman/WorkerW、重建窗口与 WebView 并重新挂载（attempt 1、2 均成功），截图恢复星空且图标仍在上层。探针退出后残留为 0。**连续 10 次、3 次失败进入终态、托盘重建与菜单恢复未测。**
- **W0-5（退出与回收，局部）**：正常退出后壁纸窗口消失，当前系统壁纸可见，专属 WebView2 进程残留为 0。50 次启停、设置预览与恢复预算未测。

因此 W0 不能标记通过：挂载和停绘路线可成立，但**恢复层缺失**是首要阻断项。

## 2. 环境与身份

| 项 | 值 |
| --- | --- |
| 探针源码 | `2404413`（`tools/desktop-probe/src/bin/wallpaper.rs`，含 Explorer 恢复与全屏暂停；`show-desktop.ps1` 见 `cbf4347`） |
| 探针二进制 | `wallpaper.exe`，1,114,112 bytes，SHA-256 `46903091dc946d6732c03d3408844b45e9ab3ec3ca8e1c7393b391add389dc5a` |
| 工具链 | rustc/cargo 1.98.1；`cargo +1.88.0 check --release --all-targets` 通过；`cargo clippy --release --all-targets -- -D warnings` 通过 |
| OS / 架构 | Windows 11 `10.0.26200` x64 |
| WebView2 Runtime | 155.0.4283.62 |
| 屏幕 / DPI | `\\.\DISPLAY1` 单屏；逻辑 1707×1067，物理 2560×1600；窗口 DPI 144；刷新率 165 Hz |
| GPU | Intel UHD Graphics 32.0.101.7088；NVIDIA GeForce RTX 4060 Laptop 31.0.15.3753（未驱动该屏） |
| 依赖 | wry 0.57.0、tao 0.37.1、tray-icon 0.24.2、windows-sys 0.61.2；与 L0 探针共用隔离工作区 |
| 隔离 | 探针不在主 workspace；WebView2 用户数据目录指向实验输出目录；未改产品代码或发布候选 |

## 3. 实验记录

运行时间 2026-10-23 17:00–17:16。`run1/run2` 用于定位 Z 序与输入，`run3/run5` 为停绘与时钟主证据，`run4` 为恢复实现前的 Explorer 重启，`recovery2` 为恢复第一版的单次重启，`recovery4` 为加入单次尝试内等待后的连续两次重启，`fullscreen1` 为真实 Chrome 全屏。

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
| W0-3 终态预算 | 连续 3 次失败进入终止错误态并停止自动恢复 | 未执行（实现中已加入 3 次/120 秒预算）；恢复前旧实现曾因重建期 Progman 暂缺而误耗预算，已改为单次尝试内等待 |
| W0-5 正常退出 | 完成计划后退出，截图桌面 | 壁纸消失，露出当前系统壁纸；`leftover=0` |
| W0-5 50 次启停 | 应用/停止循环、设置预览、退出计数 | 未执行 |
| W0-2 真实全屏 | Chrome `--start-fullscreen` 覆盖目标屏；探针每 500 ms 轮询 `SHQueryUserNotificationState` | 5→2 触发 `fullscreen` 原因：`hidden=true`、`stopMotion`、无 frame；2→5 后 `hidden=false`，从 `sceneTime=5993 ms` 恢复，无大 dt |
| W0-2 原因叠加 | 全屏与手动暂停同时存在，解除一个原因 | 未执行；实现使用独立原因位 `0x01/0x02`，但本轮未做重叠注入 |
| W0-3 锁屏/息屏/休眠、断屏 | 各事件及恢复 | 未执行 |
| W0-3 多显示器/混合 DPI | 目标屏迁移、断开重连、任务栏工作区变化 | 未执行；本机只有一块活动屏幕 |

原始截图位于本机忽略目录（含完整桌面内容，未提交）：`output/desk-w0/2026-10-23-w0-run3/`（`running.png`、`policy-paused.png`、`resumed.png`）、`run4/after-restart.png`（恢复前）、`run5/after-exit.png`、`recovery2/recovered.png` 与 `recovery4/recovered-twice.png`（恢复后）；`w0-fullscreen1/probe.log` 记录全屏暂停/恢复的帧序列（该次截图落在随后的手动暂停期，不作为恢复画面证据）。仓库只提交可复现脚本与文本证据。

## 4. 关键发现与设计影响

1. **本机 WorkerW 是 Progman 的子窗，不是顶层兄弟窗。** 经典“顶层 WorkerW + SHELLDLL_DefView”路径不适用；需要枚举 Progman 子窗、找无 DefView 的 WorkerW。`FindWindow("Progman")` 在本机首次返回 0，枚举 `EnumWindows` 能找到，宿主发现逻辑不能只依赖 FindWindow。
2. **Z 序必须显式校正。** `0x052C` 生成的 WorkerW 初始在 DefView 之上，直接挂载会盖住图标并截获桌面输入；把 WorkerW 移到 Progman 子链底部后图标恢复可见，输入命中 SysListView32。生产宿主应把“挂载后校正 Z 序”作为挂载契约，并在每次 Explorer 重建后重做。
3. **controller 隐藏不等于停绘。** `SetIsVisible(false)` 会让 `document.hidden=true`，但页面 rAF 仍在跑；只靠 controller 会继续消耗合成/脚本资源。策略停绘必须同时停止页面调度；恢复时重新起循环并限制 dt。W0-2 的通过条件应写成“原生可见性 + 页面停绘”的组合，而不是单一 controller 调用。
4. **60 fps 上限实测约 55 次/秒。** 与 L0 的 30 fps 结果一致，简单 `1000/fps` 门限会损失约 8%；生产调度需要累计误差修正或如实报告有效预算。15 fps 本次为 15.0 次/秒。
5. **视觉时间可以独立于歌曲位置。** `seekSong(60000)` 不改变 `sceneTime`；暂停恢复从冻结值继续，没有大 dt。原型已保留“视觉时间 vs 歌曲位置”的分离，但尚未接入真实场景与频谱。
6. **Explorer 重启恢复已跑通，但恢复预算的计数语义需要谨慎。** 壁纸窗作为 WorkerW 子窗会被连带销毁，controller 失效；实现健康检查后在单次重启和连续两次重启中都完成了重新探测、重建窗口/WebView 与重新挂载（attempt 1/2 成功），截图恢复星空。第一版在 Explorer 尚未重建 Progman 时立即计一次失败，导致连续重启很快耗尽 3 次预算；改为单次尝试内等待 Progman/WorkerW 后，重建期的暂时缺失不再提前消耗预算。成功恢复不立即清空记录，仍需验证 10 次重启、终态错误态与托盘重建。
7. **正常退出露出当前系统壁纸。** 退出后窗口销毁、专属进程归零，系统壁纸没有被覆盖或回滚；这满足“不使用旧截图恢复”的方向，但崩溃路径和系统壁纸运行期改动仍未测。
8. **全屏检测可用，但仍是单屏 QUNS 近似。** 真实 Chrome 全屏使 `SHQueryUserNotificationState=2`，独立“全屏”原因触发隐藏与停绘，关闭后恢复。当前只验证单屏系统级状态；多屏目标边界、无边框/独占全屏差异、全屏与手动暂停叠加未测。生产实现应按目标屏前台窗口边界计算，不能只依赖系统级 QUNS。

## 5. 复现

```bash
cd tools/desktop-probe
cargo build --release --bin wallpaper
cargo +1.88.0 check --release --all-targets
cargo clippy --release --all-targets -- -D warnings

OUT=../../output/desk-w0/<run>
./target/release/wallpaper.exe --out "$OUT" --source <commit>
```

实验时在另一终端运行 `show-desktop.ps1` 把桌面置前；截图用同目录 `capture-screen.ps1`。全屏实验用 `fullscreen-check.ps1 -Out <OUT>\real-fullscreen`。Explorer 恢复实验在其后运行 `restart-explorer.ps1 -WaitSeconds 15`。退出后用 `check-leftovers.ps1 -UserData <OUT>\webview2` 检查专属 WebView2 残留。

## 6. 决定与下一步

- **决定：** 保留 `wallpaper` 探针作为 W0 复现入口；不把 WorkerW 挂载写成已批准生产方案，不进入 W1。W0 仍缺 10 次重启/终态、托盘重建、锁屏/息屏/休眠、多屏、50 次启停与长稳，以及全屏/手动原因叠加。策略停绘必须按“原生可见性 + 页面停止调度”实现，不能只调 controller。
- **下一轮最小任务：** ① Explorer 重启 10 次、3 次失败进入终态、托盘图标与菜单重建；② 锁屏、息屏/休眠、全屏与手动暂停叠加；③ 目标屏断开/重连与混合 DPI；④ 50 次启停、controller/WebGL 失败与进程回收；⑤ 进程树 CPU/GPU/内存采样，冻结候选预算。
- **复验触发：** Windows 构建、Explorer 桌面层级、WebView2 Runtime、wry/tao/tray-icon、DPI/刷新率或挂载算法任一变化，都必须重跑本报告对应实验。

本报告不把一次合成全屏/桌面显示当作完整 W0 通过，也不以短窗口帧率替代长稳与资源预算。
