# 桌面歌词 L0 首轮原生验证报告

日期：2026-10-23。执行：本机 Qoder agent。状态：**局部通过；L0 阶段未完成，不进入 L1**。这是隔离探针的实验结论，不是已批准的生产架构，也不改变[共享宿主设计](../desktop-host.md)的草案状态。

## 1. 结论

在目标 Windows 11 x64 上，**windowed WebView2 + layered 顶层窗口**可以同时做到：透明无边框、非激活置顶、不进 Alt+Tab、锁定后整窗点击穿透、解锁后恢复点击、托盘创建与恢复路径、50 次锁定/显隐循环。但默认组合并不成立：`tao 0.37.1` 的 `with_decorations(false)` 实测仍保留 `WS_CAPTION`，且纯 `WS_EX_TRANSPARENT`、`WM_NCHITTEST=HTTRANSPARENT` 或 `EnableWindow(FALSE)` 都不能让点击穿过 WebView2 的跨进程子窗。只有 `WS_EX_LAYERED + WS_EX_TRANSPARENT + SetLayeredWindowAttributes(alpha 255)` 这一路通过了锁定穿透。

因此：

- **L0-1（透明、焦点、置顶）**：通过，但需手动去边框与重绘；工作区依赖层有已知缺陷。
- **L0-2（输入与恢复）**：合成输入和命中测试通过；托盘图标实际点击未自动化，只验证了创建与同一恢复函数。
- **L0-3 / L0-4 / L0-6**：未执行。
- **L0-5**：仅完成 50 次锁定/显隐循环，未做启停、controller 失败和完整退出。
- **H0-1（依赖/MSRV/许可）**：通过；H0-2–H0-5 未执行。

阶段退出按验证计划执行：L0 未完成，不进入 L1-A；下一步是补齐 L0-3/4/5/6，或在进入生产前明确 layered WebView2 的资源与共存代价。

## 2. 环境、依赖与身份

| 项 | 值 |
| --- | --- |
| 探针源码 | `436db8cd6827ce47112c027f56ef31823817681a`（`tools/desktop-probe/`，独立 Cargo 工作区） |
| 探针二进制 | `desktop-probe.exe`，1,113,088 bytes，SHA-256 `8e7011dfd3d9dce3e2fa14ec8ac4ed0230d3f6bb456e15cd700adcc29d3928ae` |
| 工具链 | rustc/cargo 1.98.1；`cargo +1.88.0 check --release` 通过 |
| OS / 架构 | Windows 11 `10.0.26200` x64 |
| WebView2 Runtime | 155.0.4283.62 |
| 屏幕 / DPI | `\\.\DISPLAY1` 单屏；逻辑 1707×1067，物理 2560×1600；窗口 DPI 144 |
| 依赖 | wry 0.57.0、tao 0.37.1、tray-icon 0.24.2、windows-sys 0.61.2；wry/tao `Apache-2.0 OR MIT`，tray-icon `MIT OR Apache-2.0` |
| 隔离 | 探针不在主 workspace，WebView2 用户数据目录指向实验输出目录；未改产品代码或发布候选 |

依赖的 `rust-version` 为 1.85（wry/tao），探针在 `1.88.0` 下 `cargo check --release` 通过，满足路线要求的 MSRV 约束。`cargo clippy --release -- -D warnings` 亦通过。

## 3. 实验记录

| ID | 操作与观测 | 结果 |
| --- | --- | --- |
| L0-1 合成与焦点 | 明暗棋盘背景上显示中英歌词；显示前后读取前台窗口；读取扩展样式 | 透明区域露出棋盘格，文字无整块底色；`topmost=true noactivate=true toolwindow=true appwindow=false`；前台窗口显示前后不变（`0x504c4 → 0x504c4`），未抢焦点 |
| L0-1 边框 | 记录 `with_decorations(false)` 后的 `GWL_STYLE`，再去 `WS_CAPTION/WS_THICKFRAME/WS_SYSMENU` 并重绘 | 去除前 `0x4cb0000`（含 caption），去除后 `0x4000000`；不手动去除时截图出现过白色标题条与窗口标题残影 |
| L0-2 锁定穿透 | `WS_EX_LAYERED + WS_EX_TRANSPARENT + alpha 255`；用 `SendInput` 在覆盖层中心做真实合成点击，背景页与覆盖页各记 IPC 计数 | 锁定：背景 `0→1`、覆盖 `0→0`；`WindowFromPoint` 根窗为背景；解锁：覆盖 `0→1`、背景不变 |
| L0-2 对照 | 隐藏覆盖层，直接点背景窗中心 | 背景 `1→2`，证明合成输入与背景页 IPC 本身有效 |
| L0-2 失败路径对照 | ① 仅 `WS_EX_TRANSPARENT + HTTRANSPARENT`；② 再加 `EnableWindow(FALSE)` | ① 锁定点击仍落到覆盖层；② 点击被整层吞掉（两页都不计数）。两者均不通过 |
| L0-2 托盘 | `tray-icon` 创建图标与菜单，注册 click/menu handler；调用与托盘 handler 相同的 restore 路径 | 图标创建成功；隐藏后 restore 恢复可见并解锁；**实际鼠标点击托盘未自动化** |
| L0-5 循环 | 50 次「锁定 → 解锁 → 隐藏 → 无激活显示」 | 循环后 `visible=1`，覆盖层仍有 5 个子窗，探针未崩溃；不是启停/controller 失败/退出验收 |
| L0-3 | 全屏、锁屏、息屏、休眠、隐藏原因叠加与解除 | 未执行 |
| L0-4 | 混合 DPI 迁移、断屏、任务栏工作区变化 | 未执行；本机只有单屏 144 DPI |
| L0-6 | 文本更新成本、30/15 fps 上限、停绘十秒无连续 frame/rAF | 未执行 |
| H0-2–H0-5 | 单实例/会话、IPC 容量、失联、资源阈值 | 未执行 |

截图（提交在仓库内，仅裁出探针窗口）：

![明色背景下的透明歌词窗](evidence/2026-10-23-desk-l0/light.png)

![暗色背景下的透明歌词窗](evidence/2026-10-23-desk-l0/dark.png)

## 4. 资源采样与进程树

在 layered 锁定态、启动约 1.2 s 时采样一次（`process-tree-light.txt`，2026-10-23 12:42:22）：

| 进程 | 工作集 |
| --- | --- |
| `desktop-probe.exe` | 33.6 MB |
| 7 个 `msedgewebview2.exe`（含 GPU/utility/renderer） | 合计约 423.3 MB |
| 整棵探针进程树 | 约 456.9 MB；累计 CPU 约 1.53 s |

这是启动后的单点样本，不等于稳态预算；未测 GPU、电量、帧率或 8 小时曲线，也未与“无桌面组件”状态做四态对照。不能据此冻结 L0-6 的资源阈值。

## 5. 关键发现与设计影响

1. **`tao 0.37.1` 的去边框不可直接依赖。** `with_decorations(false)` 后仍带 `WS_CAPTION`；必须在创建后手动改 `GWL_STYLE`、`SWP_FRAMECHANGED` 并 `RedrawWindow`，显示后还需再执行一次，否则透明歌词上方会残留白色标题条。生产宿主若选此组合，需要把“去边框后复核样式/重绘”写成宿主初始化契约，而不是信任 builder 选项。
2. **windowed WebView2 的输入窗在 WebView2 进程。** 探针枚举到 `Chrome_RenderWidgetHostHWND`、`Chrome_WidgetWin_1`、`Intermediate D3D Window` 的 PID 与宿主不同；宿主的 `WS_EX_TRANSPARENT` 与 `WM_NCHITTEST` 无法改变这些外部子窗的命中。`EnableWindow(FALSE)` 能让窗口不接收输入，但点击会被丢弃而不是落到下方窗口，且不是可接受的“恢复后仍可交互”的方案。
3. **layered 顶层是当前唯一通过的穿透路径。** `WS_EX_LAYERED + WS_EX_TRANSPARENT + SetLayeredWindowAttributes(alpha 255)` 在保持 WebView2 透明渲染的同时，让真实合成点击落到背景窗。代价是 layered 窗口与 WebView2/DWM 的组合特性尚未做长稳与 GPU 测量；L0-6 必须覆盖。
4. **未使用全局输入钩子，也没有为穿透关闭可见性或伪造播放状态。** 探针的点击测试只使用本进程窗口和 `SendInput`，失败路径如实保留。
5. **托盘只完成“能创建、能走恢复函数”。** 真实托盘点击、Explorer 重启后的图标重建、菜单失联尚未验收；不能据此宣称“托盘找回”已通过。

## 6. 复现与证据

```bash
cd tools/desktop-probe
cargo build --release
cargo +1.88.0 check --release
./target/release/desktop-probe.exe --out <证据目录> --source <commit>
```

默认锁定模式为 `layered`；`--lock-mode style|disable` 可复现两条失败路径。探针会在证据目录写入 `probe.log`、`stdout.log`、各阶段 `.ready` 标记。阶段就绪后可运行同目录的 `process-tree.ps1 -Out <文件>` 采集进程树、`capture-screen.ps1 -Out <png>` 截取主屏；本次证据所用的等待/裁切步骤与这两条命令等价，未另建隐藏脚本。

原始证据位于本机忽略目录 `output/desk-l0/2026-10-23-final4/`（`probe.log`、`stdout.log`、`shots/`、`process-tree-light.txt`、`metadata.txt`），按上面的命令重跑即可再生；仓库内只提交了裁切后的明暗两张截图。本次运行未发起任何 provider 请求，未使用 LLM key。

## 7. 决定与下一步

- **决定：** 保留 `tools/desktop-probe` 作为可复现实验入口；不将 layered WebView2 写成已批准的生产方案，不进入 L1-A。L0 的剩余项未完成，阶段不能标记通过。
- **下一批最小验证：** ① L0-3 全屏/锁屏/息屏/休眠与隐藏原因互不覆盖；② L0-4 第二显示器或混合 DPI；③ L0-6 文本更新与停绘十秒 frame/rAF、layered 下的 CPU/GPU 长稳；④ 真实托盘点击、Explorer 重建、controller 失败与完整退出；⑤ 依据结果决定 layered WebView2 是否可接受，或转向 composition-hosted WebView2 / 原生文字 renderer。
- **复验触发：** wry/tao/tray-icon 版本、WebView2 Runtime、Windows 构建、DPI/拓扑、锁定策略或穿透机制任一变化，都必须重跑本报告对应实验。支持矩阵仅限本机这一配置。

本报告不把合成输入通过等同于所有真实输入通过，也不以单点工作集替代资源预算。
