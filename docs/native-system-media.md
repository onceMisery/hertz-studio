# Windows 原生系统媒体控制

日期：2026-11-06。状态：开发工作树已实施并完成下述验证，尚未提交或发布。范围：独立播放器 `hertz-studio --window` 的 Windows SMTC；承接[完整桌面客户端目标](desktop-client.md#72-桌面能力清单)，采用[现行同进程主窗口路线](aegis/specs/2026-11-04-r5-native-main-window-design.md)。旧 Tauri/sidecar 结构不属于本实现。

## 行为与所有权

主窗口真实 HWND 通过 `ISystemMediaTransportControlsInterop::GetForWindow` 建立一个 SMTC。服务提供曲名、歌手、专辑、播放状态、进度、时长和当前可用的播控；Windows 回调只提交意图。页面重载、隐藏和 WebSocket 归零均不会销毁这条链路。

- 本地播放/暂停/停止/上一曲/下一曲/定位进入 AppState 的原播放锁及队列流程。HTTP、RPC 与系统媒体停止动作共用同一停止入口。停止保留可恢复的曲目并将位置归零；这与既有播放器 stop 语义一致，系统卡片随后显示可恢复的暂停状态。
- 一起听动作进入既有 RoomManager 与 host/guest 请求流程，服从房间权限、操作 ID 和 revision。没有音频输出端时，房间原有拒绝起播/离线暂停规则继续生效。
- 回调携带服务实例、模式、曲目和播放代际；本地提交锁内再次检查 actor 与播放意图代际。房间还绑定 room/instance/session/member、曲目实例及输出 epoch，并在接收命令的 host/guest 内复核，防止排队动作跨过重连或换房。
- 回调队列容量为 1，串行执行器另外最多持有一个正在执行的动作；入队不阻塞 Windows 回调，排队超过两秒的动作在取出时丢弃。房间操作结果未知时不自动重发。

原生适配没有独立播放状态机，也不使用假 WebSocket 保活。服务侧投影与播控见 [system_media.rs](../crates/hertz-studio/src/system_media.rs)，Windows 线程见 [windows.rs](../crates/hertz-studio/src/system_media/windows.rs)。依赖为锁定的 `windows = 0.61.1`，仅 Windows 的 `native-window` 构建启用。

## 浏览器控制权与故障

已认证的只读 `GET /v1/window/media-state` 返回 `available/owned/phase/serverInstance/error`；没有原生主窗口的服务返回 `available=false`。接口不提供 Windows 操作入口，不返回曲目路径、地址或凭据。

原生所有者在页面启动前预留会话，实际初始化成功后进入 `ready`。同一服务的主窗口和其它浏览器标签页都读取此能力；被原生持有时清空八个 MediaSession handler、元数据、进度与播放状态，并在迟到的浏览器回调里再次检查控制权。DBX/demo 不请求该接口。

初始化或更新失败，且已确认 Windows 会话禁用后，浏览器才恢复当前本地/房间元数据和操作。请求失败不代表原生 owner 消失；首次读取失败也暂缓浏览器注册，防止两份系统会话。首次读取最多自动尝试三次，页面重新可见或显式刷新可恢复。已确认支持的服务每五秒检查一次，读取共享一个在途请求和一个计时器。无法确认原生释放时保留 `owned=true` 并返回有限错误码。

Windows COM 对象及事件 token 由同一个 MTA 线程持有。退出先拒绝新回调，禁用 SMTC、解绑事件并清空显示；宿主所有者丢失同时触发既有服务收尾。初始化失败不会阻止播放器窗口启动。

## 元数据与封面边界

文本去控制字符、最多 512 个 Unicode 字符。未知时长禁用 seek，时间换算饱和处理；空媒体/空房间清空旧卡片。

封面只读取曲库 UUID 对应的已有本地缓存，最多 2 MiB，转换为内存流传给系统。不请求在线封面 URL，不暴露路径或认证信息。按文件路径、长度和修改时间判断缓存变化；换歌、缓存删除和无封面时清空旧缩略图。在线曲目和房间显示当前共享元数据，首版不另取远程或房间封面。

## 验证方法

- `cargo test -p hertz-studio --lib system_media --features full,native-window`：投影、权限、重连身份、过期回调、睡眠截止、原生 owner 丢失、停止恢复，以及六种本地动作在等待提交锁期间被新意图取代。
- [浏览器检查](../scripts/check-system-media-ownership-browser.js)：真实 Chrome 执行生产 observer/MediaSession 函数，受控传输覆盖九组控制权、失败恢复、迟到回调、单次在途请求与 DBX 隔离。
- [原生检查](../scripts/check-system-media-native.js)：隔离 DataDir、真实 Wry/WebView2 和实际 Windows 媒体会话；[独立 GSMTC 探针](../crates/hertz-studio/examples/system_media_probe.rs)只操作名称以 `smtc-fixture-` 开头、属于 hertz-studio 的测试曲目。测试曲目为静音 WAV，本地 actor 使用 null 后端，房间启用真实 Windows 输出端。

最终[原生报告](../output/playwright/system-media-native-1793976572744/report.json) **7 组全部通过**：元数据/进度、旁开真实 Chrome、同曲缓存封面替换与换歌清理、零 WebSocket 播控、上一曲/下一曲/停止、空房间清理、房间暂停/播放、重载和退出释放。报告绑定二进制、独立探针及五份实现/检查文件 SHA-256；二进制为 `fe08010a1474ebb47670a4d4ebf0bad259cce6c42b0ce86c7ac96c769c6a7b17`。

同一最终二进制的[主窗口生命周期回归](../output/playwright/main-window-lifecycle-native-1793976596104/report.json) **9 组通过**，覆盖真实 WM_CLOSE 隐藏、零页面睡眠定时、原生退出确认与重启。完整 `full,native-window` 服务库 **981 项通过、7 项按既有条件忽略**；其中系统媒体筛选 13 项通过。浏览器控制权 9 组、前端默认 72 步及 408 份 JS 语法检查通过，API 清单与脚本登记通过。窗口与系统媒体测试宿主均已退出。

Windows 开发构建、默认无 `native-window` 的库检查通过。all-targets Clippy 通过，沿用前轮记录中的 `manual_is_multiple_of`、`unnecessary_fold`、`chunks_exact_to_as_chunks` 三类命令级基线豁免，本轮新增告警已修正。上述不替代 Rust 1.88 固定工具链、其它 OS 或正式发布矩阵。

复现命令（PowerShell，路径按本机实际构建/Playwright 安装调整）：

```powershell
cargo build -p hertz-studio --bin hertz-studio --example system_media_probe --features full,native-window
cargo test -p hertz-studio --lib --features full,native-window -- --test-threads=2
$env:HERTZ_BIN = 'D:/code/github/hertz-studio/target/debug/hertz-studio.exe'
$env:PLAYWRIGHT_MODULE = 'path/to/node_modules/playwright'
node scripts/check-system-media-ownership-browser.js
node scripts/check-system-media-native.js
node scripts/check-main-window-lifecycle-native.js
node scripts/check-frontend.js
```

实际 GSMTC 调用证明 Windows 系统媒体链路，不等同于物理媒体键、蓝牙耳机按键、锁屏界面、真实声音听测或设备休眠唤醒。其它 OS、在线远程封面、跨机 guest 资格和正式安装/签名/升级仍待相应专项验收。
