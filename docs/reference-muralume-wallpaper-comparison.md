# Muralume 桌面壁纸实现分析 & 对 hertz-desktop 的借鉴评估

日期：2026-10-29。分析对象：`D:\code\github\muralume`（MIT，@ 老版本 working tree）。
对照对象：本仓库 `crates/hertz-desktop`（壁纸）与 `plugin/ui/**`（前端）。
基线：本仓库设计终稿 `docs/desktop-wallpaper.md`（2026-10-28，1677 行）。

> **一句话结论：许可证不是障碍（两边都是 MIT），技术栈也不是主要障碍，真正的障碍是成本模型。**
> Muralume 最有价值的不是它的"点子"——你们自己的设计终稿已经独立写明了其中大部分（稳定屏幕键、暂停原因集合、single/mirror/span）——而是它为这些仍是纸面的设计提供了**已上架产品的运行期实证**，以及三处你们规划里没有写、它却做了的细节：拓扑宽限期、非对称去抖的数值、暂停之前的渐变降级。

---

## 1. Muralume 是什么

| 项 | 值 |
|---|---|
| 平台 | macOS 14+，Apple silicon，Mac App Store + GitHub Release 双通道 |
| 语言/框架 | Swift，SwiftUI（UI）+ AppKit（窗口）+ AVFoundation（播放）+ Core Image（模糊） |
| 规模 | 147 个 Swift 文件，约 46.6k 行产品代码 + 44.2k 行测试（`MuralumeTests` / `MuralumeUITests` 共 67 个文件） |
| 依赖 | 基本零第三方运行时依赖；第三方仅出现在 DMG 打包脚本里（`ds_store`、`mac_alias`，不进 app 包） |
| 开源许可 | MIT |
| 隐私主张 | 无账号、无上传、无 telemetry、无自动崩溃上报 |

一个值得注意的数据：**测试代码量与产品代码量接近 1:1**（44.2k vs 46.6k）。对本仓库而言，`scripts/` 下已有大量契约脚本，但那是断言式验收而非单元测试；这个比例说明"临界 behavior 靠测试钉住"它执行得很彻底。

### 1.1 分层

```
App/           3068 行   装配根、协调器、菜单
Application/  17248 行   用例层（Desktop / Library / Playback / Settings / MediaAccess）
Domain/        1705 行   纯逻辑：PlaybackGate、PlaybackSettings、Queue
Features/     10152 行   SwiftUI 视图与控制器
Infrastructure/13315 行  macOS 具体实现：窗口、store、播放器、监控
Shared/        1092 行   配置、DesignSystem
```

关键结构特征：**应用层与基础设施层之间靠协议解耦**。典型例子 `ApplicationPresenceControlling.swift` 只有 10 行，就是一个协议声明；`SystemLifecycleMonitoring.swift` 19 行，也是协议。真正调 IOKit / NSWorkspace 的实现在 `Infrastructure/macOS/`。

> **不要照搬这套分层本身。**它的切面是"AppKit 视图 vs AVFoundation"，你们的切面是"Rust 原生进程 vs WebView DOM"。把六层 DDD 脚手架搬进 `crates/hertz-desktop` 只会增加间接层。值得搬的是其中一个具体想法，见 §5.1。

---

## 2. 壁纸宿主方式（macOS 侧）

### 2.1 每屏一个 NSWindow

`MacDesktopHost` 用两级 ID：运行期 `CGDirectDisplayID` 作字典键，持久化的稳定 ID（`HostedDisplay.stableID`）作身份。每块启用且非镜像的显示器一个 `DesktopWindow`（`MacDesktopHost.swift:84-91`、`:161`）。

```swift
window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
window.backgroundColor = .black
window.ignoresMouseEvents = true
window.isOpaque = true
window.hidesOnDeactivate = false
window.level = Self.desktopVideoLevel
window.alphaValue = 0.01
window.orderFrontRegardless()
```
（`MacDesktopHost.swift:480-503`）

并且显式禁止成为主/键窗口：`canBecomeKey`/`canBecomeMain` 均返回 false（`:71-80`）。

### 2.2 窗口层级的计算方式 —— macOS 特有

```swift
let desktopLevel     = Int(CGWindowLevelForKey(.desktopWindow))
let desktopIconLevel = Int(CGWindowLevelForKey(.desktopIconWindow))
return NSWindow.Level(rawValue: min(desktopLevel + 1, desktopIconLevel - 1))
```
（`MacDesktopHost.swift:962-968`）

即：**夹在系统壁纸窗口之上、桌面图标窗口之下**。这是 macOS 版"always on bottom"。

> 对照：本仓库走的是 Windows 的经典路线——发 `0x052C` 给 `Progman` 逼出 `WorkerW`，取没有 `SHELLDLL_DefView` 的那个，然后 `SetParent` + `HWND_BOTTOM`（`crates/hertz-desktop/src/native.rs:828-945`），并去重 han-dle Explorer 重启后的存活检测 `wallpaper_alive()`（`:908`）。**两条路线是各自平台上的正解，互不适用。**本仓库不需要补 macOS 的层级概念。

### 2.3 首帧揭幕 + 指数退避

窗口先以 `alphaValue = 0.01` 存在且已 orderFront，等 surface ready 后才揭幕：

```swift
if isSurfaceReady(surface) {
    hostedDisplays[displayID]?.window.alphaValue = 1
    refreshDesktopVisibilityStates()
    return
}
```
（`MacDesktopHost.swift:577-587`）

轮询从 16 ms 起，超时后转 250 ms 并指数退避到上限 4 秒（`:590-629`）。

---

## 3. 渲染与动画

**没有 Metal、没有 SpriteKit、没有自研管线。** 全部是系统件：

| 环节 | 实现 |
|---|---|
| 播放 | `AVQueuePlayer`（默认就是，`AVFoundationPlaybackEngine.swift:69-80`） |
| 每屏独立循环 | `AVPlayerLooper` + `actionAtItemEnd = .advance`（`:200-210`） |
| 渲染面 | `AVPlayerLayer` |
| 填充 | `videoGravity`：cover=`.resizeAspectFill`，contain=`.resizeAspect` |
| 模糊背景 | 背景层最长边压到 **512 px** 后再 `CIGaussianBlur`（radius 12），再放大铺满（`DesktopPlayerLayerSurfaceView.swift:5-12`、`:267-278`） |
| 切歌淡入淡出 | 双 `AVPlayerLayer` + `CABasicAnimation(opacity)` 0.24 s；音频侧 15 步手动 volume 插值（`PlaybackPolicy.swift:19-20`） |

**"gapless loop"的真相**：`AVPlayerLooper` **只用于每屏独立循环**。普通队列到末尾仍然靠应用层 `seek(to: 0)`（`PlaybackCoordinator.swift:889-914`）。README 的说法不假，但范围是窄的。

**对我们无参考价值的部分**：视频 decoder / pixel format / HDR 全部交给系统和显示器，源码里没有任何 `wantsExtendedDynamicRangeContent` 或 tone mapping。也就是说它在 HDR 上没有做什么，不能当作"参考实现"。

---

## 4. 配置与资源加载

- **两级持久化**：显示器布局策略（`DesktopScene`）走 `UserDefaults["desktop.scene"]`，并设了硬上限——最多 64 个 assignment、display ID 最长 512 字节、整个 JSON ≤ 256 KB（`UserDefaultsDesktopSceneStore.swift:30-50`）；会话恢复用 `Application Support/Muralume/desktop-preset.json`，原子写。
- **资源导入**：添加视频/文件夹走 security-scoped bookmark 与 canonical path，库里只留引用，不复制源文件、不转换格式、不改扩展名。
- **写盘合并**（`DesktopPresetController.swift:33-45`）：状态变更合并 1 s、大快照最小间隔 60 s、失败重试 60 s、**payload 与上次相同则完全不写**。
- **并发上限**（`BoundedMediaWorkPool.swift`）：限制文件扫描/canonical 查找的并发，但 MediaLibrary 的各池 concurrency 实际都是 1。

> 对本仓库：你们已经有 `%LOCALAPPDATA%\Hertz\Desktop\config.json` 单份配置 + 原子写 + 字节上限（`config.rs:489-705`，且已有 `atomic_writer_keeps_original_when_temp_write_or_encode_fails` 测试）。**不要照搬它的"UserDefaults + JSON 双store"拆分**，那是 macOS 平台的惯例 split，对你们是净增添加一个 store。

---

## 5. 性能开销与多屏适配

### 5.1 ⭐ 意图 / 挂起原因分离（最值得移植的一处）

```swift
struct PlaybackGate {
    private(set) var intent: PlaybackIntent = .paused          // 用户意图
    private(set) var suspensionReasons: Set<PlaybackSuspensionReason> = []

    var shouldPlay: Bool {
        intent == .playing && suspensionReasons.isEmpty && !isTerminating
    }

    mutating func setSuspended(_ suspended: Bool, for reason: PlaybackSuspensionReason) -> Bool {
        if suspended { return suspensionReasons.insert(reason).inserted }
        else         { return suspensionReasons.remove(reason) != nil }
    }
}
```
（`Domain/Playback/PlaybackGate.swift`，全文 51 行）

配套：12 个挂起原因，每个带 **scope**——`.playerOnly` / `.desktopOnly` / `.allPresentations`（`PlaybackSettings.swift:129-160`）。解锁时"只移除对应 reason，绝不清集合"，因此用户手动暂停后不会因屏幕唤醒而被自动恢复。

### 5.2 遮挡检测：探针窗 + 阈值 + 非对称去抖

不是 `NSWindowDelegate`，而是每屏建 **4×3 = 12 个透明探针窗**，读 `NSWindow.occlusionState.contains(.visible)`：

```swift
static let debounceNanoseconds: UInt64 = 750_000_000          // 暂停：750 ms
static let recoveryDebounceNanoseconds: UInt64 = 150_000_000  // 恢复：150 ms
static let refreshIntervalNanoseconds: UInt64 = 200_000_000
static let requiredOccludedProbeNumerator   = 3
static let requiredOccludedProbeDenominator = 4               // 12 个里至少 9 个不可见
```
（`DesktopOcclusionMonitoring.swift:3-17`、`:93-107`）

同步模式下"**所有**显示器都遮挡才暂停共享播放器"（`DesktopSessionCoordinator.swift:682-695`）。

### 5.3 多屏拓扑

- 枚举：`NSScreen.screens` + `NSApplication.didChangeScreenParametersNotification`。**没有** `CGDisplayRegisterReconfigurationCallback`。镜像屏用 `CGDisplayMirrorsDisplay == kCGNullDirectDisplay` 过滤。
- 稳定 ID：`CGDisplayCreateUUIDFromDisplayID` → `cgdisplay:<uuid>`；失败回退 vendor+model+serial → vendor+model+noserial+物理尺寸+unit number（`MacDesktopDisplayTopology.swift:18-55`）。**这是让显示器拔掉再插回来还能认出来的关键。**
- 空拓扑宽限期：系统短暂报告 0 块屏时不信，等 500 ms 再确认（`MacDesktopHost.swift:8-13`）。
- 两种模式：`DesktopSceneMode = synchronized | perDisplay`（`DesktopScene.swift:9-12`）。

### 5.4 渐变降级 > 二值暂停

这是它最聪明的一处。二值性被打破了：

| 触发 | 动作 |
|---|---|
| 任何 energy constraint（低电量/电池/非 nominal 热/持续高负载） | **先关闭 512 px 模糊背景层**，前景视频照常跑（`DesktopSessionCoordinator.swift:594-606` → `DesktopPlayerLayerSurfaceView.swift:20-27`） |
| 电池 final warning / 持续 15 s 高负载 | 才真正暂停 |
| 热态 critical | 所有 presentation 暂停；serious/critical 只降桌面效果 |

迟滞做得很实：负载 = `getloadavg() / processorCount`；连续 3 个 5 s 样本 ≥ 0.85 → 进入 constrained（约 15 s）；连续 6 个样本 ≤ 0.60 → 恢复（约 30 s）；中间区间保持原状态（`SystemLifecycleMonitor.swift:54-60`、`:305-318`）。

另外：**动态桌面不阻止显示器睡眠**（`preventsDisplaySleepDuringVideoPlayback = surface?.id == .player`），只对前台播放窗口生效。

### 5.5 无 JWself-paced 节流

明确**没有** `preferredFramesPerSecond`、`CVDisplayLink`、`preferredPeakBitRate`。它的 cadence 节流只作用于**进度回调**（可见 0.25 s / 桌面同步 5 s / 独立循环完全不装 observer），不是视频帧率。

---

## 6. 横向对比

| 维度 | Muralume (macOS/Swift) | hertz-desktop (Windows/Rust) | 判读 |
|---|---|---|---|
| 层级 mechanism | CGWindowLevel 夹在壁纸/图标之间 | WorkerW + SetParent + HWND_BOTTOM | 各自平台正解，互不适用 |
| 每屏成本 | 一个 `AVPlayerLayer`，共享 GPU 进程 | 一个 WebView2 **渲染进程** + 独立 GPU context + 重新解析 1.69 MB runtime | ⚠ 成本模型完全不同 |
| 内容 | AVQueuePlayer + 硬件解码 | three.js WebGL + WebAudio feed | — |
| 多屏模式 | synchronized / perDisplay 两种 | 单实例单目标屏（规划稿已定义 single/mirror/span） | 待落地 |
| 稳定屏身份 | CGDisplay UUID + 三级回退 | `MONITORINFOEXW.szDevice`（`\\.\DISPLAY1`） | ⚠ 见 7.1 |
| 暂停策略 | 12 原因集合 + scope + intent 分离 | 3 个布尔的与（`Policy::renderable`） | 规划稿已定原因集合，未落地 |
| 遮挡 | 12 探针窗 + 3/4 阈值 + 750/150 ms 非对称去抖 | `SHQueryUserNotificationState` + 矩形覆盖 | Windows 侧信号更准、更便宜 |
| 降级 | 三级：降效果 → 暂停部分 → 全停 | 二值：绘制 / 停止（电池降 15 fps 仅歌词层） | ⭐ 有增量 |
| 恢复预算 | — | 已有 120 s / 3 次 | 本仓库已有 |
| 心跳看门狗 | — | 已有 10 s stale + eval 失败 3 次 → 重建 | 本仓库已有，且它没有 |
| 写盘 | UserDefaults + JSON 双 store，1 s 合并 | 单 config.json，原子写 | 保持现状 |

---

## 7. 对本仓库的具体改进建议

排序按 **收益 / 成本**。前两条其实是"追上你们自己的规划稿"，不是抄 Muralume——但它证明了这套设计在生产上跑得住。

### 7.1 显示器身份：`monitor.name` → 稳定 screen key（P0）

**现状**：`WallpaperMonitor.name` 取自 `MONITORINFOEXW.szDevice`（`native.rs:~398`），即 `\\.\DISPLAY1` 这种 GDI 名次。它被写进配置 `config.wallpaper.monitor`，重建时按 `monitor.name == surface.monitor.name` 匹配（`app.rs:601-607`）。

**问题**：GDI 设备名次会被 Windows 重排——换主屏、拔插显示器、驱动重置之后，`\\.\DISPLAY1` 可能指向另一块物理屏，于是用户保存到副屏的壁纸会悄悄跑到主屏上。这是当前代码里和用户 Yang-study 感受最直接的一处。

**改动点**：
1. `WallpaperMonitor` 增开 `device_path: Option<String>`：用 `EnumDisplayDevices` 枚举 `DISPLAY_DEVICE`，以 `DeviceName` 与 GDI 名配对，取 `DeviceID`（形如 `\Registry\...\MONITOR\DEL40A0\{...}`，含 hardware instance id）。快照题：它可以稳定到物理端口。
2. 匹配顺序改成 `device_path` → `(EDID vendor, product, serial)` → GDI name；配置里保留旧 `monitor` 字段做向后兼容迁移。
3. 三者都无法确定身份时（两块同型号无序列显示器），**不要猜测也不要交换**——保持 suspended 并在设置页显式提示，与规划稿"相同无序列显示器发生歧义时等待用户识别"一致。

**预期收益**：拔插/换主屏/重启后壁纸回到原来那块屏；同时消掉一类"看起来随机"的用户报障。成本很小（`native.rs` 内一个函数 + 匹配优先级），且这正是 `docs/desktop-wallpaper.md` §13.1 已经要求的东西。

### 7.2 `Policy` 布尔 → 挂起原因集合（P0，且是后续一切的前提）

**现状**（`app.rs:71-84`）：

```rust
fn visible(&self) -> bool {
    !self.user_hidden && !self.fullscreen && !self.session_unavailable
    && !self.display_off && !(self.locked && self.no_content)
}
fn renderable(&self) -> bool {
    !self.fullscreen && !self.session_unavailable && !self.display_off
}
```

两个谓词已经不一致了，而 `!(locked && no_content)` 这种组合条件正在往里长。

**为什么必须先做这步**：`docs/desktop-wallpaper.md` §13.2 已经定了原因集合，但它有多个目标**当前结构在数学上做不到**：
- 诊断字段 `pauseReasons`（§"最低诊断" 列表）——布尔堆叠出不来"哪几个原因"，只能事后反推；
- §13.2 的 "single/mirror 的其它屏全屏不暂停本屏"——全局布尔无法表达"这个原因只作用于 B 屏"；
- §13.2 的"目标覆盖只按对应 display/group 计算，不能再使用歌词 HWND"——同样依赖 per-target 归因。

**改动点**：照 `PlaybackGate` 的形状，把 51 行 Swift 翻成 Rust：

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Suspend {
    SessionUnavailable, DisplayOff, DisplayMissing, Battery, // 强制
    Fullscreen, Maximized, ManualPause, AiGeneration,        // 软
}

#[derive(Default)]
pub(crate) struct Gate {
    reasons: HashSet<Suspend>,
    // 按 target（未来多屏）/ surface scope 分组见下
}

impl Gate {
    fn set(&mut self, r: Suspend, on: bool) { if on { self.reasons.insert(r); } else { self.reasons.remove(&r); } }
    fn stopped(&self) -> bool { !self.reasons.is_empty() }
}
```

每个探测点在**自己的**位置调用 `gate.set(Suspend::X, bool)`：`native.rs:500` 全屏、`:757` 锁屏/会话、`:768` 息屏、电池 check（`app.rs:2502`）。**不要**再让一处代码重算整串 conjunction。

**预期收益**：新增闸门从"改结构体 + 改两个谓词 + 排查所有调用方"降为"加一个枚举值 + 一处 `set` 调用"；免费拿到 `pauseReasons` 诊断字段和设置页的"为什么没在跑"；为多屏 per-target 语义铺路。

### 7.3 拓扑宽限期 + 非对称去抖（P1，改动极小）

**现状**：`recompute_wallpaper()` 每 250 ms 被 feed 驱动一次，一旦发现目标屏名字不见就立刻 `surface.stop()`（`app.rs:601-607`）。全屏判定也没有去抖（规划稿要求 300 ms，代码尚未实现）。

**问题**：你们的误判代价特别高——一次假阳性就销毁并重建 WebView2（重新 `include_str!` 那 1.69 MB runtime、重新初始化 WebView2）。而 Windows 在显示器模式切换、驱动重置、RDP 进出时，`EnumDisplayMonitors` 确实会瞬间少报——Mac 侧对此的做法正是那 500 ms 空拓扑宽限期。

**改动点**：
1. 目标屏缺失不要立即 stop：要求连续 N 次（建议 3 次 ≈ 750 ms）未命中才判定 missing。
2. 闸门外加非对称去抖：**进入暂停慢（≈400 ms），恢复快（≈100 ms）**。恢复快是为了用户退出全屏立刻看到画面；暂停慢是为了容忍短暂抖动。
3. 已有的恢复预算要和 §13.3 的"按故障域记账"保持一致，不要因为加宽限期而放宽 120 s/3 次的恢复预算。

**预期收益**：消掉模式切换/驱动重置导致的一次无谓 WebView2 销毁重建；退出全屏的感知延迟不变。

### 7.4 ⭐ 别把"每屏一实例"照搬过来（这是必须拒绝的一条）

Muralume 的 `perDisplay` 模式是**每屏一个 NSWindow + 一个 AVPlayerLayer**，边际成本近乎只有一层 CA layer + 一个硬件 decoder 会话，全部由 WindowServer 合成——**没有额外进程**。

如果我们照字面移植，每屏一个 WebView2 意味着：
- 一个完整的 **渲染进程**（不是 thread，是 process）；
- 一份独立的 GPU context，**显存按 context 计数**（规划稿 `desktop-wallpaper.md` 第 554 行已经明说了这点）；
- `stage-runtime.js` 被重新解析一次（虽然 `include_str!` 的是同一份字节，但每个 renderer 都要 parse + JIT 一遍）；
- 以上每一项都按屏幕数翻倍。

**结论**：多屏覆盖应该走你们规划稿里的 **`span`（单窗口覆盖虚拟屏）**作为默认，`mirror`/`single` 多组走"至多 N 个实例 + 非主屏降帧"的显式选项，绝对不要默认按屏幕数开进程。Muralume 验证的是这个**产品需求**（同步 / 各屏独立）成立，不是它的**成本结构**成立。

> 这条是"不该照搬"里唯一一条有实质代价加和的，请放在第一位看。

### 7.5 暂停之前先降级（`quality: 'low'` 硬编码是现成的切入点）

**现状**：壁纸页把质量写死了——`wallpaper-scene.js:313` `quality: 'low'`，`:356` `qualityMode: 'low'`；只有 fps 来自配置（15/30/60，`app.rs:2502` 电池时降到 15）。也就是说**壁纸这条路径上没有任何自适应档位**，而 `plugin/ui/stage.js` 里本仓库其实已经有完整的三层 tier 逻辑（`detectTier()` + `TIERS + DPR` 折扣）了，只是没贯彻到壁纸页。

**改动点**：加一条降级阶梯，在"停止"之前插两级：
```
满            fps 30~60 / 当前 zoom
↓ 电池 / 远程桌面 / 低端档
省电          fps 15 + DPR 或 webview zoom 下调 + 关掉 scene 后处理
↓ 仍未满足预算 / final battery
静帧          停在最后一帧，释放 GPU scope（规划稿 §13.3 已有"暂停 5 分钟释放"）
↓
停止 / 释放实例
```
直接复用 **`stage.js` 里已有的 `detectTier()` 思想**即可，不必引进 Muralume 的代码；Muralume 给我们的只是"中间台阶存在且值得做"的证据。

**预期收益**：电池 / 集显 / 远程桌面上用户至少还有一张静止封面或低帧画面，而不是一块黑矩形——这是二值暂停最容易被差评的地方。

### 7.6 首帧揭幕 + 指数退避（P2，可选）

你们已经做了 `wallpaper_page_ready` 闸门，且注释里留了正确的教训（`app.rs:622`「页面就绪前不能把 WebView2 隐藏：隐藏会让页面不加载，dom_ready 永远不来」）。规划稿 §13.3 也已经要求 real `firstFrameReady`。

Muralume 可补的是两点小手法：**就绪轮询用指数退避（16 ms → 250 ms → 上限）**而不是固定间隔；**用透明到不透明的揭幕**代替 simple `ShowWindow`，避免用户瞥见未上色的窗口/背景色。收益中等，可作为 §7.1/7.2 落地后的收尾项。

---

## 8. 明确不适合照搬的清单

| 项 | 原因 |
|---|---|
| `CGWindowLevelForKey` 算出来的窗口层级 | macOS WindowServer 概念；Windows 无对应物，你们已有正确的 WorkerW 方案 |
| 12 个探针窗做遮挡采样 | 依赖 WindowServer 给每个 NSWindow 发布 occlusion state；Windows 已有更准更省的信号（`SHQueryUserNotificationState` + 前景窗矩形，且你们已经在用）。**可移植的只是它的策略参数（阈值 + 非对称去抖），不是探针** |
| 每屏一个原生/WebView 实例 | 成本模型差异见 §7.4。这是最重要的一条 |
| `AVPlayerLooper` gapless 循环 | 播放类型项目专属；你们的壁纸内容是 GL 场景而非视频队列，只有当 P1 引入"视频作为 native content type"时才有意义 |
| 512 px 背景做 CIGaussianBlur | Core Image 实现；浏览器侧 `filter: blur()` 的成本行为完全不同，**不要假设同样的 512 px 压降同样有效**，规划稿第 783 行已经要求实测 CSS 亮度/模糊的合成成本 |
| UserDefaults + JSON 双 store 持久化 | 平台惯例，非设计优势；你们单 config.json + 原子写更好 |
| `Config/*.xcconfig`、`Scripts/release_*.sh`、`Scripts/vendor/` | 它们的签名、notarization、DMG 打包机械，内含上游的团队标识与 plist 配置，与本项目无关，**不要复制**（可能泄漏上游身份信息） |
| 六层 App/Application/Domain/… 分层 | 切面不匹配（见 §1.1） |

## 9. 许可证结论

**许可证不构成障碍。** Muralume 为本 MIT，本仓库同为 MIT（`LICENSE`，Copyright 2026 mmusic-studio contributors），两边条款一致，互相兼容。

但请注意两点常识性义务：
1. 若真的复制任何 Swift 片段，MIT 要求保留上游版权与许可声明。上述建议中**没有一条涉及代码搬运**，全部是模式/数值层面的借鉴，因此不会产生此义务。
2. 它的 `THIRD_PARTY_NOTICES.md` 只覆盖 DMG 打包脚本的 vendored 组件（`ds_store`、`mac_alias`），这些不随二进制分发。对我们没有传染性。

**真正的阻隔是：Swift/macOS API 不可译 + WebView 每进程成本不可比。** 和许可证无关。

---

## 10. 建议的落地顺序

| # | 项 | 成本 | 依赖 | 对应本文 |
|---|---|---|---|---|
| 1 | 显示器身份换稳定 key | 小 | 无 | §7.1 |
| 2 | `Policy` → 原因集合 | 中 | 无，但它是后续一切的底座 | §7.2 |
| 3 | 拓扑宽限 + 非对称去抖 | 小 | 依赖 2 建好再改最顺 | §7.3 |
| 4 | 多屏：默认 span，**拒绝**每屏一实例 | 大 | 依赖 1、2 | §7.4 |
| 5 | 降级阶梯替代二值暂停 | 中 | 依赖 2 | §7.5 |
| 6 | 首帧揭幕 + 退避 | 小 | 无 | §7.6 |

前三项可以在不动宿主结构的前提下完成，且每一项单测都好写（`PlaybackGate` 51 行之所以好测，正因为它是纯值语义——建议把 `Gate` 设计成同样的纯值语义：`HashSet<Suspend>` + 纯函数，不要塞 `Instant` 和 HWND 进去）。
