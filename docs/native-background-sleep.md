# 原生后台播放与睡眠定时

2026-11-06 增量，沿用 Wry/Tao 同进程主窗口与现有音频 actor。实现对应旧桌面客户端方案 §6 的用户行为，进程与控制结构采用当前原生路线。

## 后台播放所有者

真正创建主窗口后取得不可复制的 `NativeWindowOwner`，由该事件循环持有。窗口隐藏、页面重载、WebSocket 断开均不释放它。离场暂停仍在 `play_commit` 锁内检查真实页面数量和活动房间，仅额外允许有效原生所有者保活；没有增加假页面或假 WebSocket。

所有者丢失时立即关闭本地输出的永久许可，拒绝后续播放提交，并在现有服务清理通道内暂停/退出。定时器清理或重新设置不能重新打开已失去宿主的输出。普通浏览器服务和 DBX 不建立这个所有者，保留原有离场规则。

`GET /v1/window/state` 的 `backgroundPlayback` 表示当前原生后台 owner 事实，不能从 feature 编译成功或窗口曾创建过推导。

## 服务定时合同

原生窗口使用一个进程内 `WindowSleep` 和一个后台任务。空闲时等待通知；已设定时按有界间隔检查音频时钟。状态不持久化，服务重启后为空，不自动恢复播放或定时。

`GET /v1/window/sleep-timer` 返回 available、revision、phase、remainingMs、serverNowMs，以及可选显示用 deadlineUnixMs/error。`PUT` 必须为 `{seconds,expectedRevision}`：seconds 为 1–86400 秒，显式 null 取消。旧 revision 冲突只要求刷新，不重放写入；无原生 owner 时不可用。

界面沿用睡眠菜单与命令面板，分钟范围 1–1440。剩余时间按服务样本和 `performance.now()` 显示，归零后等待服务确认，页面不发送另一次暂停。断网、不可用或修改结果不明时保留未知状态，不回退为页面定时器。普通浏览器和 DBX 继续使用原来的页面定时。

进入一起听时在同一播放提交锁内取消本地定时，房间保留自己的 host 定时器。暂停失败时本地输出保持静音；必须在独占音频交接真正确认后才清除失败门控，不能依据房间预留状态提前放行。

## 到期与音频输出

Windows 使用 `GetTickCount64` 的运行时毫秒域，计入系统休眠且不受墙钟调整影响。Unix 时间只是显示估计。非 Windows 时钟采用已有平台可用时钟的尽力组合，不据此声明其它系统休眠资格。

回调只检查门控并静音无效 PCM，不修改 transport 状态。入口与末尾都校验捕获的截止时间和到期代际；在回调挂起期间发生“设置、到期、清除”也会使旧块失效。历史块失效不覆盖后来用户明确恢复的播放。

音频 actor 才负责硬暂停、拒绝到期后的 Play/PrepareNext 和禁止自然结束推进。服务随后在 `play_commit` 内使待播意图失效、等待暂停确认、恢复实际已完成切歌的游标/音质/缓存保护、取消准备并清除定时门控。到期导致的播放拒绝归为被替代，不按坏曲目触发降质、换源或跳曲。

取消/重新设置在播放锁内的最终到期检查作为接受点：检查时已到期则先协调暂停并返回 revision conflict；检查时未到期的显式变更可以获准。此边界不使用墙钟，也不把后续旧回调的保守静音当作新的暂停意图。

**硬件资格边界：**上述门控保证应用新渲染的过期音频块被静音。它不能撤回休眠前已经交给 OS／设备的缓冲；真实设备唤醒时是否重放这些缓冲，需要主宿主电源通知／设备复位与物理设备验收，当前不宣称已通过。

## 验证

音频测试使用真实无设备 RenderOutput 和可控屏障，覆盖截止边界、永久 owner 关闭、首回调不消费 PCM、不分配内存、回调途中设置/到期/清除/重新播放等交错。服务测试使用真实 Null actor，验证无页面 worker、CAS、替换/取消、暂停失败、房间交接和 owner 退出。回调时钟控制只用于测试，不缩短生产阈值。

[浏览器检查](../scripts/check-native-sleep-browser.js)使用实际模块与睡眠控件，覆盖页面不暂停、恢复读数、时钟变化、迟到请求、冲突、错误和旧运行方式隔离；报告位于 `output/native-sleep/report.json`。

[原生旅程](../scripts/check-main-window-lifecycle-native.js)调用 [native-sleep-checks.js](../scripts/native-sleep-checks.js)，让真实主窗口导航离开播放器以退出实际 WebSocket，验证三秒宽限后仍播放、无播放器页面时定时到期、重载保留暂停、替换旧定时不再触发、真实 LAN 交接和进程重启不重设定时。

执行结果：音频库全量 **153 项通过、2 项忽略**，无 playback feature 的截止专项 9 项通过。窗口/定时筛选 22 项、普通离场 2 项、切歌 6 项，以及重复 ID 后继游标/音质/缓存保护专项通过。真实音频回调的挂起交错由测试专用屏障控制，未将模拟时钟记为物理休眠证据。

[原生整合报告](../output/playwright/main-window-lifecycle-native-1793947283145/report.json)九组全部通过、无页面错误，测试宿主已退出。[无页面证据](../output/playwright/main-window-lifecycle-native-1793947283145/sleep-no-renderer.json)记录真实 viewers=0、原有 grace=3000 ms，以及到期后的 phase=expired、playing=false 和保留的曲目/16412 ms 位置。二进制 SHA-256：`066716cd14c207e26f8fb5659494e14e294f3790665f9d6ff9b4d5ac00cd8504`。

[浏览器报告](../output/native-sleep/report.json)、窗口渲染、胶囊性能、进程内宿主契约、API 清单和脚本登记通过。默认无 native-window 库构建通过。hertz-studio/vmusic-audio all-targets Clippy 沿用[上一轮记录](main-window-lifecycle.md)中的三类既有 lint 命令级豁免后通过，本轮新增警告均已修正。
