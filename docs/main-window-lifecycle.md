# 原生主窗口关闭与退出

2026-11-06，沿用 Wry/Tao 同进程路线。实现现行 11-04 主窗口设计 §2.1/§2.2 的关闭偏好与活动退出确认，不引入 Tauri、sidecar 或第二份播放状态。

2026-11-07 重复打开增量：服务先获得同 DataDir 内核锁，已有窗口通过 `POST /v1/window/focus` 的鉴权与实例校验恢复；旧端口 + 1 握手已退役。详见[资料目录所有权](data-directory-ownership.md)，关闭/退出守卫继续复用本记录的生命周期所有者。

## 行为

- 关闭按钮、标题栏 × 和 Alt+F4 默认隐藏到托盘，保持当前播放和房间状态。托盘或单实例聚焦入口恢复同一窗口。
- 原生“窗口与舞台”设置增加“关闭主窗口”：隐藏到托盘／退出播放器。偏好写入当前服务的 settings 表，键为 `native_window_close_behavior`；未知旧值回到 hide，写入失败保留原值。普通浏览器及 DBX 不显示此项。
- 托盘退出、原生页面电源键、配置为退出时的关闭动作，以及访问同一服务的 HTTP 退出请求，都交给唯一生命周期协调器。重复请求复用 pending requestId，不叠加多个退出任务。
- 本地音频正在播放或一起听会话仍活跃时显示一次退出确认。取消不提前停音乐、不关闭桌面歌词/壁纸。空闲自动批准必须在服务端再次核对真正空闲；展示前后活动变化不能绕过确认。
- 等待已有舞台 hydration、当前预置与预置库的保存队列。保存模块缺失、初始读取或保存失败时显示未知／未保存状态，允许返回处理或明确选择丢弃后退出。
- 录制需要明确结束，并等待已有 MediaRecorder 收尾。异常产生的部分视频带失败标志，不视为成功。正常生成后保留退出窗口，用户确认视频文件已经保存，再点击退出；仅发起下载不作为文件已落盘的证据。

## 所有权与协议

`WindowLifecycle` 安装在 AppState 的可选 OnceLock 中，只有 `--window` 启动时、公布监听地址之前安装。协调器反持 Weak<AppState>，持久设置、真实 audio/room 事实与最终 `exiting` watch 均沿用现有服务。

| 接口 | 原生模式 | 普通服务 |
| --- | --- | --- |
| `GET /v1/window/state` | 当前 phase、requestId、关闭偏好、活动事实 | `available:false` |
| `PUT /v1/window/settings` | 严格 `{closeBehavior:"hide"|"quit"}` | 不提供原生设置 |
| `POST /v1/system/shutdown` | 202，交给主窗口处理的请求快照 | 原有 200 exiting 语义 |

没有 HTTP/RPC 确认退出接口。受管设置键不能通过通用 settings 写入；DBX 没有安装此 owner，也不增加原生生命周期 RPC 映射。

宿主注入的窄桥使用当前文档随机身份、pending requestId 和随机 presentation token。只有同一服务 origin 的 IPC、匹配当前文档与 presentation、且页面已确认显示了可取消对话框，才接受决定。页面重载和旧回执不能提交新请求。显式批准携带宿主实际展示的活动依据，避免用户已确认活动后又重复询问；自动批准始终重新读取活动事实。

页面在八秒内未接管时，Windows 显示归属主窗口的原生确认框，默认取消并明确说明无法核对页面保存状态。超时只改变确认方式，不自动退出。原生确认不可用时请求转为 failed，可明确重试。

确认后只触发已有服务退出 watch。`main.rs` 的原清理链负责 desktop_host 收尾、房间/音频退出和发现文件移除；窗口侧不重复提前清理，也不自请求 HTTP。只有真实服务线程结束产生 `ServerExited` 并退出窗口循环。

## 验证与限制

新增生命周期模型测试覆盖并发合并、晚到宿主、取消／旧令牌、真实 audio actor 活动变化、实际展示依据、持久偏好与失败回滚、HTTP 鉴权与非原生隔离。主窗口测试覆盖文档／请求／展示 token 和 origin 比较。

[浏览器脚本](../scripts/check-main-window-lifecycle-browser.js)使用实际 UI 模块和 `exitService` 源码，控制 native bridge、保存与录制接口，验证状态、取消、保存错误、录制异常／自然完成、文件保存确认及普通浏览器/DBX 分支。证据位于 `output/main-window-lifecycle/`。原视频导出生命周期、窗口渲染、胶囊性能及进程内宿主契约另行回归。

[原生脚本](../scripts/check-main-window-lifecycle-native.js)运行隔离的 `full,native-window` 构建，使用真实 Wry/WebView2、Win32 WM_CLOSE 与原生确认框，真实本地 WAV／null 音频 actor 和本机 LAN 房间。null 后端验证业务状态，不证明真实扬声器出声。后续[后台播放与睡眠定时增量](native-background-sleep.md)已增加实际原生 owner、零页面播放和服务计时；[Windows SMTC 增量](native-system-media.md)接通系统元数据与原生播控。多 DPI、其它操作系统、物理媒体键、真实设备唤醒及正式发行安装仍为独立剩余项。

本轮验证：生命周期服务模型 8 项、窗口 token/origin 与托盘模型 3 项通过；实际 UI 浏览器检查、原视频导出生命周期、窗口渲染、胶囊性能和同进程宿主 9 组契约回归通过。`--no-default-features --lib` 检查通过，普通构建不要求启用原生窗口。新增文件格式、scoped diff、API 生成清单和脚本登记检查通过。

[原生报告](../output/playwright/main-window-lifecycle-native-1793940387716/report.json)六组全部通过、零页面错误，测试进程已退出。覆盖真实 WM_CLOSE 保留播放、HTTP/host 合并请求与取消、LAN host 单独触发确认、重载旧 token 拒绝、缺失页面处理器后的真实 Win32 兜底取消，以及关闭偏好重启保留和优雅退出。二进制 SHA-256：`bf69000a2e3d2cc91957d35156a6aa8e4fc591a4775cefa8af7c5a8dc43c6f10`。

严格 Clippy 首次被本轮未修改位置的三类新版 lint 阻断：`build.rs` 的 `manual_is_multiple_of`、`vmusic-store/stage_presets.rs` 的 `unnecessary_fold` 和 `stage_media/prepare.rs` 的 `chunks_exact_to_as_chunks`。仅在检查命令中允许这三类后，`full,native-window --all-targets -D warnings` 通过；没有为通过 lint 改写这些无关行为。该结果不等同于未加豁免的全项目严格 Clippy 已通过。
