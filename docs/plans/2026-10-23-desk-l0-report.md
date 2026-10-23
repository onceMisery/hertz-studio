# 桌面歌词 L0 原生验证报告（首轮 + 第二轮）

日期：2026-10-23。执行：本机 Qoder agent。状态：**L0 仍未完成，不进入 L1**。第二轮补齐了全屏检测（合成窗口与真实 Chrome 全屏）、30/15 fps 更新成本、停绘采样、真实托盘点击、退出回收、同会话单实例与一次 WebView2 全进程失败注入；真实锁屏/息屏/休眠、多显示器、Explorer 重启后的托盘重建、controller API 失败和长稳仍未验收。这是隔离探针的实验结论，不是已批准的生产架构，也不改变[共享宿主设计](../desktop-host.md)的草案状态。

## 1. 结论

在目标 Windows 11 x64 上，**windowed WebView2 + layered 顶层窗口**可以同时做到：透明无边框、非激活置顶、不进 Alt+Tab、锁定后整窗点击穿透、解锁后恢复点击、托盘创建与真实鼠标点击恢复、50 次锁定/显隐循环，以及退出后专属 WebView2 进程归零。但默认组合并不成立：`tao 0.37.1` 的 `with_decorations(false)` 实测仍保留 `WS_CAPTION`，且纯 `WS_EX_TRANSPARENT`、`WM_NCHITTEST=HTTRANSPARENT` 或 `EnableWindow(FALSE)` 都不能让点击穿过 WebView2 的跨进程子窗。只有 `WS_EX_LAYERED + WS_EX_TRANSPARENT + SetLayeredWindowAttributes(alpha 255)` 这一路通过了锁定穿透。

第二轮新增结果：

- **L0-2（托盘部分）**：托盘图标默认在任务栏溢出面板中。用 UI Automation 找到“显示隐藏的图标”，发送真实鼠标点击打开溢出，再点击 `Hertz DESK-L0 probe` 图标；探针记录了两条 `tray_event`（按下/抬起），隐藏原因清零、歌词从隐藏状态恢复可见，`l0_2_tray_real_click=pass`。**Explorer 重启后的图标重建与菜单失联未执行。**
- **L0-3（全屏检测）**：一个置顶、无边框、覆盖主屏并取得前台的合成窗口使 `SHQueryUserNotificationState` 返回 `QUNS_BUSY (2)`；退出全屏后返回 `QUNS_ACCEPTS_NOTIFICATIONS (5)`。用隐藏原因位掩码验证了“全屏”和“用户隐藏”互不覆盖，解除一个原因不会提前显示；恢复后歌词窗口未取得前台。另用真实 Chrome `--start-fullscreen` 独立配置复验，同样返回 `state=2`，关闭后 `state=5`、无残留。**真实全屏应用已覆盖检测路径；锁屏、息屏、休眠未执行。**
- **L0-5（启动/停止部分）**：50 次锁定/解锁/显隐循环后窗口存活；探针正常退出后，以专属 WebView2 数据目录识别的进程及其后代为 `0`。
- **L0-5（失败注入部分）**：在 30 fps 阶段一次终止探针的 7 个 `msedgewebview2.exe` 进程。宿主进程未崩溃，后续 JS 调用返回 `HRESULT(0x8007139F)`，进程树只剩探针本身（工作集约 34 MB），WebView2 未自动重启；探针继续按计划退出，退出码 0、残留 0。**但探针没有失败检测或恢复策略：`overlay_visible=true` 的空白歌词窗一直保留到退出；controller API 失败未测试。**
- **L0-6**：5 秒窗口内 30 fps 上限实际约 27.6 次/秒文本更新，15 fps 上限约 15.0 次/秒；页面 rAF 约 165 次/秒；单行 `textContent` 更新耗时平均约 0.03 ms、最大 0.2 ms。两次运行的进程树 CPU 分别约 12.8%/18.8%（run16）和 18.1%/11.9%（run11），30 与 15 fps 的高低顺序在两次运行中相反，均值约 15.5%/15.4%；静态 0.0–0.3%，停绘 0.0–0.4%。工作集合计约 447–508 MB。GPU Engine 采样在运动中约 0.96–1.76%，静态/停绘为 0。**更新上限降低没有降低整树 CPU，成本主要由持续运行的 165 Hz rAF/合成循环决定；只有短窗口采样，不是长稳预算，也未冻结阈值。**
- **H0-2（部分）**：同一会话第二次启动被 `Local\` 命名互斥量拒绝，退出码 3。**跨用户/跨会话与 ACL 未验证。**
- **H0-3（部分）**：专属 WebView2 用户数据目录在正常退出后无残留进程；全进程失败注入后也没有残留。**controller API 失败时的回收未验证。**

阶段退出按验证计划执行：L0 未完成，不进入 L1-A；下一步是补齐 L0-3 的真实环境事件、L0-4 多显示器/混合 DPI、Explorer 重建、controller API 失败与失败后的窗口策略，再决定 layered WebView2 是否可接受。

## 2. 环境、依赖与身份

| 项 | 值 |
| --- | --- |
| 探针源码 | `14e88c7`（`tools/desktop-probe/` 第二轮改动，含托盘等待与失败注入记录）；本报告为该提交的实机结果记录 |
| 探针二进制 | `desktop-probe.exe`，1,148,416 bytes，SHA-256 `20cbb2296bc408e20ed8e75f374ed7483199854fa881a27f51cd17ab12197b31` |
| Cargo.lock | SHA-256 `ca62e6adef134f969d696bba297db6b499d1bd895c3e3d876bb1f1fe6eed113f` |
| 工具链 | rustc/cargo 1.98.1；`cargo +1.88.0 check --release` 通过；`cargo clippy --release -- -D warnings` 通过 |
| OS / 架构 | Windows 11 `10.0.26200` x64 |
| WebView2 Runtime | 155.0.4283.62 |
| 屏幕 / DPI | `\\.\DISPLAY1` 单屏；逻辑 1707×1067，物理 2560×1600；窗口 DPI 144；当前刷新率 165 Hz |
| GPU | Intel UHD Graphics 32.0.101.7088（驱动 2560×1600 屏）；NVIDIA GeForce RTX 4060 Laptop 31.0.15.3753（未驱动该屏）；另有 Todesk/GameViewer 虚拟显示适配器，未连接显示器 |
| 依赖 | wry 0.57.0、tao 0.37.1、tray-icon 0.24.2、windows-sys 0.61.2；wry/tao `Apache-2.0 OR MIT`，tray-icon `MIT OR Apache-2.0` |
| 隔离 | 探针不在主 workspace，WebView2 用户数据目录指向实验输出目录；未改产品代码或发布候选 |

依赖的 `rust-version` 为 1.85（wry/tao），探针在 `1.88.0` 下 `cargo check --release` 通过，满足路线要求的 MSRV 约束。

## 3. 实验记录

### 3.1 首轮

| ID | 操作与观测 | 结果 |
| --- | --- | --- |
| L0-1 合成与焦点 | 明暗棋盘背景上显示中英歌词；显示前后读取前台窗口；读取扩展样式 | 透明区域露出棋盘格，文字无整块底色；`topmost=true noactivate=true toolwindow=true appwindow=false`；前台窗口显示前后不变（`0x504c4 → 0x504c4`），未抢焦点 |
| L0-1 边框 | 记录 `with_decorations(false)` 后的 `GWL_STYLE`，再去 `WS_CAPTION/WS_THICKFRAME/WS_SYSMENU` 并重绘 | 去除前 `0x4cb0000`（含 caption），去除后 `0x4000000`；不手动去除时截图出现过白色标题条与窗口标题残影 |
| L0-2 锁定穿透 | `WS_EX_LAYERED + WS_EX_TRANSPARENT + alpha 255`；用 `SendInput` 在覆盖层中心做真实合成点击，背景页与覆盖页各记 IPC 计数 | 锁定：背景 `0→1`、覆盖 `0→0`；`WindowFromPoint` 根窗为背景；解锁：覆盖 `0→1`、背景不变 |
| L0-2 对照 | 隐藏覆盖层，直接点背景窗中心 | 背景 `1→2`，证明合成输入与背景页 IPC 本身有效 |
| L0-2 失败路径对照 | ① 仅 `WS_EX_TRANSPARENT + HTTRANSPARENT`；② 再加 `EnableWindow(FALSE)` | ① 锁定点击仍落到覆盖层；② 点击被整层吞掉（两页都不计数）。两者均不通过 |
| L0-2 托盘 | `tray-icon` 创建图标与菜单，注册 click/menu handler；调用与托盘 handler 相同的 restore 路径 | 图标创建成功；首轮只验证恢复函数，真实鼠标点击在第二轮补齐 |
| L0-5 循环 | 50 次「锁定 → 解锁 → 隐藏 → 无激活显示」 | 循环后 `visible=1`，覆盖层仍有 5 个子窗，探针未崩溃 |
| L0-3 / L0-4 / L0-6 | 环境策略、混合 DPI、文本更新成本 | 首轮未执行 |

### 3.2 第二轮

运行时间 2026-10-23 14:30（本机；`run11`）与 14:37（`run16`，含托盘等待）。合成输入与首轮使用同一 `SendInput` 路径。

| ID | 操作与观测 | 结果 |
| --- | --- | --- |
| L0-2 真实托盘点击 | `--tray-wait-ms 8000` 先把歌词按“用户隐藏”原因隐藏；`tray-click.ps1` 用 UIA 找到任务栏溢出按钮并发送真实鼠标点击，再点击溢出面板中的 `Hertz DESK-L0 probe` | 探针记录 Down/Up 两条 `tray_event`；`reasons=0x00`、`visible=true`，`l0_2_tray_real_click=pass` |
| L0-3 合成全屏 | 把背景窗改为覆盖主屏的置顶无边框窗口并置前台；读取 `SHQueryUserNotificationState`；用位掩码叠加“用户隐藏”和“全屏”原因 | 进入时 `state=2 (QUNS_BUSY)`，检测为全屏；维持全屏时解除用户隐藏仍不可见；退出全屏后 `state=5`，清除全屏原因才恢复可见；恢复后前台不是歌词窗口 |
| L0-5 启停与回收 | 正常启动、完成实验、退出；退出后按专属 WebView2 数据目录匹配进程及其后代 | 探针退出码 0；`leftover=0`；退出前进程树为 8 个进程（探针 + 7 个 `msedgewebview2.exe`） |
| L0-5 失败注入 | 运动阶段一次终止探针的 7 个 `msedgewebview2.exe` 进程 | 宿主存活；后续 eval 返回 `HRESULT(0x8007139F)`；进程树只剩探针（约 34 MB）；`overlay_visible=true` 且命中背景；无自动重启；退出码 0、`leftover=0`；没有失败恢复策略 |
| L0-6 30 fps | 单行文本按 30 fps 上限更新 5 秒；页面每秒上报帧/更新/绘制耗时 | 4.993 秒内 138 次更新（27.6 次/秒），825 次 rAF；绘制平均 0.028 ms、最大 0.2 ms |
| L0-6 15 fps | 同上，上限 15 fps | 4.990 秒内 75 次更新（15.0 次/秒），824 次 rAF；绘制平均 0.031 ms、最大 0.1 ms |
| L0-6 静态 | 取消 rAF，保持文本 5 秒 | 无更新；进程树 CPU 增量 0 ms（0.0%） |
| L0-6 停绘 | 保持无 JS 动画约 11.5 秒 | 无新的 motion IPC；进程树 CPU 增量 47 ms（0.4%），分布在 3 个 WebView2 进程的短计时片 |
| H0-2 双启动 | 第一实例运行时以不同输出目录启动第二实例 | 第二个实例记录 `single_instance=conflict`，退出码 3，未创建窗口 |
| H0-3 环境归属 | 专属 `WEBVIEW2_USER_DATA_FOLDER`；退出后检查残留 | 退出后 `leftover=0`；未做 controller 失败注入 |
| L0-3 真实全屏应用 | 用独立用户目录启动 Chrome `--start-fullscreen` 打开本地页面；读取 `SHQueryUserNotificationState`；关闭该实例后复查 | 全屏时 `state=2`；截图可见全屏页面；关闭后 `state=5`、匹配进程 `leftover=0` |
| L0-3 锁屏/息屏/休眠 | 锁屏、息屏、休眠与恢复 | 未执行 |
| L0-4 | 第二显示器、混合 DPI 迁移、断屏恢复、任务栏工作区变化 | 未执行；本机只有一块活动屏幕 |
| L0-2 Explorer 重建 | Explorer 重启后的托盘图标重建、菜单失联 | 未执行（真实鼠标点击本身已通过） |
| L0-5 controller API 失败 | 通过 controller 接口制造失败并观察回收 | 未执行；已做 WebView2 全进程失败注入 |

截图（首轮，提交在仓库内，仅裁出探针窗口）：

![明色背景下的透明歌词窗](evidence/2026-10-23-desk-l0/light.png)

![暗色背景下的透明歌词窗](evidence/2026-10-23-desk-l0/dark.png)

## 4. 资源采样与进程树

### 4.1 第二轮分层采样

采样边界为各阶段起止，数值是整棵探针进程树（探针 + WebView2 进程）的合计；CPU 百分比以单核为 100%，工作集为各进程 WorkingSet 之和。

| 阶段 | 时长 | run11 CPU | run16 CPU | 工作集范围 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 30 fps 更新 | 5.0 s | 906 ms / 18.1% | 641 ms / 12.8% | 481.0–507.7 MB | 两次运行高低顺序不同 |
| 15 fps 更新 | 5.0 s | 594 ms / 11.9% | 938 ms / 18.8% | 450.9–474.5 MB | 30/15 fps 均值约 15.5%/15.4% |
| 静态 | 5.0 s | 0 ms / 0.0% | 16 ms / 0.3% | 446.4–469.6 MB | 取消 rAF 后接近零 |
| 停绘 | 11.5 s | 47 ms / 0.4% | 0 ms / 0.0% | 451.1–465.2 MB | 无新的 motion IPC |

两轮的文本上限不同，但整树 CPU 没有随之下降：rAF 循环仍以约 165 次/秒运行，文本更新只是其中的一个分支。降低更新上限不能替代停止/节流动画循环本身。GPU Engine 采样（PowerShell `Get-Counter '\GPU Engine(*)\Utilization Percentage'`，每约 4 秒一个点，按探针进程树 PID 过滤）在两次运行的运动阶段均为 0.96–1.76% 的单引擎占用，静态/停绘阶段为 0。该采样只覆盖 GPU 引擎利用率，不包含显存、功耗或频率。

### 4.2 首轮单点样本

layered 锁定态、启动约 1.2 s 时：`desktop-probe.exe` 33.6 MB，7 个 `msedgewebview2.exe` 合计约 423.3 MB，整棵树约 456.9 MB，累计 CPU 约 1.53 s。

以上是启动后或短窗口样本，不等于稳态预算；未测电量、帧率或 8 小时曲线，也未与“无桌面组件”状态做四态对照。不能据此冻结 L0-6 的资源阈值。三次短运行的空闲 CPU 也有差异（`run10` 11.5 秒 328 ms / 2.9%，`run11` 47 ms / 0.4%，`run16` 0 ms / 0.0%），不足以单独判定原因或阈值。

## 5. 关键发现与设计影响

1. **`tao 0.37.1` 的去边框不可直接依赖。** `with_decorations(false)` 后仍带 `WS_CAPTION`；必须在创建后手动改 `GWL_STYLE`、`SWP_FRAMECHANGED` 并 `RedrawWindow`，显示后还需再执行一次，否则透明歌词上方会残留白色标题条。生产宿主若选此组合，需要把“去边框后复核样式/重绘”写成宿主初始化契约，而不是信任 builder 选项。
2. **windowed WebView2 的输入窗在 WebView2 进程。** 探针枚举到 `Chrome_RenderWidgetHostHWND`、`Chrome_WidgetWin_1`、`Intermediate D3D Window` 的 PID 与宿主不同；宿主的 `WS_EX_TRANSPARENT` 与 `WM_NCHITTEST` 无法改变这些外部子窗的命中。`EnableWindow(FALSE)` 能让窗口不接收输入，但点击会被丢弃而不是落到下方窗口，且不是可接受的“恢复后仍可交互”的方案。
3. **layered 顶层是当前唯一通过的穿透路径。** `WS_EX_LAYERED + WS_EX_TRANSPARENT + SetLayeredWindowAttributes(alpha 255)` 在保持 WebView2 透明渲染的同时，让真实合成点击落到背景窗。第二轮短窗口显示，该路径的 CPU/GPU 增量可见但不是数量级异常；长稳与真实 GPU/驱动组合仍未测。
4. **合成全屏和真实 Chrome 全屏都触发 `QUNS_BUSY`，但不能替代锁屏/息屏/休眠。** 置顶覆盖主屏的合成窗口与真实 Chrome `--start-fullscreen` 都返回 `state=2`，退出后恢复 `state=5`。游戏/DRM 独占全屏是否同样触发、锁屏/息屏/休眠的恢复是否抢焦点，仍须逐个实测；不能把这两次结果写成完整 L0-3 通过。
5. **30 fps 上限实测为 27.6 次/秒。** 以 rAF 计时、`1000/fps - 0.5 ms` 门限的简单调度会损失约 8%。若 L1 需要严格 30 fps 文本更新，应改用带累计误差修正的调度，或在产品口径中接受该偏差；15 fps 路径在本次为 15.0 次/秒。
6. **整树 CPU 主要由持续 rAF/合成循环决定，而不是文本更新次数。** 两次运行中把更新上限从 30 降到 15 fps，CPU 均值几乎不变（约 15.5% 对 15.4%），且高低顺序在运行间反转；单次 `textContent` 更新平均仅约 0.03 ms。静态阶段取消 rAF 后 CPU 接近零。生产控制器若要降成本，应停止或节流动画循环本身，而不是只降低文字更新频率。
7. **正常退出回收成立；WebView2 全进程失败时宿主能存活并退出，但没有失败策略。** 注入后宿主继续运行、后续 eval 返回 `0x8007139F`、WebView2 不自动重启、退出后无残留；同时空白歌词窗仍保持 `visible=true` 直到退出。生产宿主必须定义检测、隐藏、重试或报告策略，不能把“进程没崩”当作失败恢复。controller API 失败、GPU 进程崩溃、托盘退出与窗口关闭竞争仍未测。
8. **真实托盘点击已通过，重建路径未通过。** UIA 打开任务栏溢出后对图标发送真实鼠标点击，歌词可从隐藏状态恢复；Explorer 重启后的图标重建、菜单失联仍未验收，不能据此宣称完整“托盘找回”已通过。
9. **单实例只验证了同一会话。** `Local\` 命名互斥量能阻止同会话第二次启动；跨用户/跨会话的命名对象 ACL、配置写者和退出再启未验证。

## 6. 复现与证据

```bash
cd tools/desktop-probe
cargo build --release
cargo +1.88.0 check --release
cargo clippy --release -- -D warnings

OUT=../../output/desk-l0/<run>
./target/release/desktop-probe.exe --out "$OUT" --source <commit>
# 需要真实托盘点击时追加 --tray-wait-ms 8000，并在另一终端等待 tray-wait.ready 后运行：
# powershell -File tray-click.ps1 -Marker <OUT>\tray-wait.ready
```

探针会在证据目录写入 `probe.log`、`stdout.log`、各阶段 `.ready` 标记。第二轮另用以下脚本采集资源、回收与托盘点击：

```powershell
# 从 probe.log 读取第一实例的 Windows PID 后运行
powershell -File sample-gpu.ps1 -RootPid <pid> -Out <OUT>\gpu.csv
powershell -File check-leftovers.ps1 -UserData <OUT>\webview2 -Out <OUT>\leftovers.txt
powershell -File tray-click.ps1 -Marker <OUT>\tray-wait.ready -TimeoutSeconds 15
powershell -File kill-webview.ps1 -UserData <OUT>\webview2 -Marker <OUT>\motion30.ready -TimeoutSeconds 20
powershell -File fullscreen-check.ps1 -Out <OUT>\real-fullscreen
```

单实例复验：第一实例运行时用不同 `--out` 再启动一次，第二实例应记录 `single_instance=conflict` 并以退出码 3 结束。阶段就绪后仍可用同目录 `process-tree.ps1 -Out <文件>` 与 `capture-screen.ps1 -Out <png>`。托盘点击脚本按 `SystemTrayIcon` 中 x 坐标最小的按钮识别溢出入口，不依赖系统语言；若托盘图标已经在任务栏可见，则直接按名称点击。

第二轮原始证据位于本机忽略目录 `output/desk-l0/2026-10-23-run11/`（`probe.log`、`stdout.log`、`gpu.csv`、`leftovers.txt`、`single-instance.log`）、`output/desk-l0/2026-10-23-run16/`（含 `tray-click.log`、`gpu.csv`、`leftovers.txt`）、`output/desk-l0/2026-10-23-run19/`（含 `kill.log`、`after-kill.png`、`leftovers.txt`）与 `output/desk-l0/2026-10-23-real-fullscreen2/`（含 `real-fullscreen.png`），以及被拒绝的第二实例目录 `output/desk-l0/2026-10-23-run11-single/`；按上面的命令重跑即可再生。仓库内只提交裁切后的首轮明暗截图。本次运行未发起任何 provider 请求，未使用 LLM key。

## 7. 决定与下一步

- **决定：** 保留 `tools/desktop-probe` 作为可复现实验入口；layered WebView2 仍不是已批准的生产方案，不进入 L1-A。L0 的真实环境事件、多显示器、Explorer 重建、controller API 失败、失败后的窗口策略与长稳未完成，阶段不能标记通过。
- **下一批最小验证：** ① 锁屏、息屏、休眠与恢复；② 第二显示器/混合 DPI、断屏重连；③ Explorer 重启后的托盘重建、菜单失联；④ controller API 失败、WebView2 失败后的隐藏/重试/报告策略与启停竞争；⑤ 8 小时/长稳与四态资源对照，再决定 layered 是否可接受，或转向 composition-hosted WebView2 / 原生文字 renderer。
- **复验触发：** wry/tao/tray-icon 版本、WebView2 Runtime、Windows 构建、DPI/拓扑、刷新率、锁定策略或穿透机制任一变化，都必须重跑本报告对应实验。支持矩阵仅限本机这一配置。

本报告不把合成输入或合成全屏等同于所有真实输入/环境事件通过，也不以短窗口 CPU/GPU 采样替代资源预算。
