# 局域网一起听：收藏、共用主题与原生时钟 · 2026-10-25

源码提交：`8f414b9c42c82c8aba43f015e8da0569add04bab`；分支 `codex/lan-listening-delivery`。最终 Standard 服务 SHA-256：`1dd4a33f99d6304118c7ade98392636a5e8c031a8f3f3914f307ff09adab7826`。之后的提交仅整理证据和截图。工作保留在隔离工作树，未覆盖原目录、合并或推送。

## 已交付

- 一起听保持为独立入口；房内外由既有全局 Theme 共同管理配色、主题目录与持久化。房间、大厅与窄屏可切换内置及注册主题；修改只影响本机，不属于 Host 权限或网络房间状态。原型参考布局和交互，不固定其色板。
- 播放页、共同队列、共享曲库红心与主应用“我的收藏”一致。Host 复用本地曲目身份；Guest 使用原房主指纹与稳定不透明曲目键，SQLite 保存个人文字快照，不下载音频或保留临时封面/凭据。再次点歌重新核对原房主、分享和队列权限。
- 未确认入队沿用原操作回执，不自动重放。原记录丢失时允许先取消或确认放弃本机待确认记录；它不撤销原操作，也不声称原操作未生效。
- Windows ScheduledOutput 使用原生 WASAPI 设备呈现位置、GetFrequency 和配对 QPC，复用唯一输出队列与转换器。累计故障代际撤销旧计划，实际 Stop/Reset/prime/Start 后仍需新的未来 Prepare/Commit；消费者复核解静音代际。已接受的本机音量保持同一有界 FIFO，恢复不能丢弃静音设置。
- 已有局域网邀请、发现、共享、权限、播放与音效、实例队列/投票、聊天/歌曲卡片、睡眠暂停和关闭生命周期继续通过真实服务回归。架构边界见 [ADR-0011](../../../docs/adr/0011-lan-rendering-and-output-ownership.md)，操作和设备说明见[使用指南](../../../docs/lan-listening-user-guide.md)。

## 验收结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Standard workspace | 1028 通过、0 失败、7 忽略 | [verification.json](verification.json) |
| Full workspace | 1185 通过、0 失败、9 忽略 | 同上；逐项列出忽略用例 |
| 两版 Clippy / 9 自有包 fmt | 通过；拒绝 warnings | 同上 |
| ADR / 默认前端集合 | 316 项 / 64 步通过 | 同上；默认跳过的 live 项目不计通过 |
| 收藏 HTTP/TLS 三 profile | 11 项通过 | [favorites-acceptance.json](favorites-acceptance.json) |
| 控制与生命周期双 profile | 12 项通过 | [control-acceptance.json](control-acceptance.json) |
| Realtek 原生设备 | 19 项通过；120 秒 | [native-acceptance.json](native-acceptance.json) |
| Standard / Full 插件 stdin EOF | 各 3 项通过 | [Standard](plugin-eof-standard.json) / [Full](plugin-eof-full.json) |
| 真实 Chromium 服务操作 | 收藏 7 项、主题 6 项、布局 30 项，以及创建/分享/加入/协作/播放 | [ui-acceptance.json](ui-acceptance.json) |
| 隔离主题与皮肤浏览器检查 | 生产 Theme/DOM/CSS；五皮肤、小屏、键盘、自定义主题 | [theme-browser.log](theme-browser.log) |
| 实际 WASAPI 故障注入 | Reset 网格 5376→1056、丢弃旧 PCM 480 帧、故障计数 1 保持至 Valid、旧授权拒绝、保持静音 | [native-fault-recovery.log](native-fault-recovery.log) |

全部最终服务验收绑定同一二进制 SHA-256；插件另有各自 SHA。源码清单见 [build-identity.json](build-identity.json)：`sha256` 是本次工作树原始字节（含检出换行），`sha256_git_blob` 是提交中保存的原始内容，`sha256_lf` 是 Git 内容归一到 LF 的散列。音频硬件专用测试默认忽略，手工运行记录单列；外部 API、压力和子进程夹具的忽略不计为通过。Receiver 最终针对回归为 47 项，audio 为 140 项（另 2 项专用硬件测试默认忽略）。

独立审查分别记录于[收藏审查](review-acceptance.json)、[主题审查](theme-review.json)与[音频审查](audio-review.json)；最后一轮规格与质量审查均无未解决的重要问题。审查本身不替代运行证据。

## 原失败与当前结论

CPAL 0.15 WASAPI 将可写空间用于 playback 估算；变长回调会产生假 phase jump。未扩大缓冲或放宽门禁。旧构建 `790f77ea4605b1074c60f64b859208fa22a5a70d4e9ba258ed80c746fd9159d2` 的[编译负载期间失败](native-before-fix-under-build-failure.json)和[空闲期间失败](native-before-fix-idle-failure.json)原样保留，属于旧时间戳路径，不改写为最终构建结果。

当前原生报告来自同一台 Windows 电脑的 Host/Guest 两进程，接收端显式选择 Realtek、音量为零，覆盖三种源采样率、自然换曲、跳转、队列实例和混音边界。120 秒观测期间无欠载或额外重同步。专用硬件注入只存在于测试模块，没有生产故障开关。NVIDIA 默认端点的静音时钟/打开关闭记录属于实现期间的补充检查，不替代此 Realtek 持续验收。

## 界面与复现

[当前截图目录](../../../docs/images/listening-workspace-favorites)包含深浅桌面、窄屏、主应用同主题、个人收藏、队列/聊天和已遮盖邀请。截图来自上述最终服务；文件散列在 UI 报告中。测试曲目与封面为程序生成夹具。六种尺寸为 1440×1000、1280×900、1024×768、390×844、360×800、844×390；验证无横向溢出、页面标题焦点、小屏首屏播放键、聊天键盘和草稿保留。收藏覆盖真实提交后丢响应、送达前丢请求及本机待确认恢复。

```powershell
cargo build --locked -p hertz-studio --bin hertz-studio
python scripts/check-lan-favorites.py --binary target/debug/hertz-studio.exe --report output/lan-favorites.json
python scripts/check-lan-room.py --binary target/debug/hertz-studio.exe --report output/lan-control.json
python scripts/check-lan-room.py --binary target/debug/hertz-studio.exe --native-output --output-device '扬声器 (Realtek(R) Audio)' --duration 120 --report output/lan-native.json
node scripts/check-room-theme-browser.js
```

设备名应替换为本机完整名称；不改变系统默认设备。浏览器脚本需环境可加载 Playwright（可用 `PLAYWRIGHT_MODULE` 指向已安装模块）。插件 EOF 两版本命令、凭据服务/网卡/防火墙、启动和完整人工 UI 路径见使用指南。不要把邀请、一次性 UI ticket、profile 或认证文件提交为证据。

## 明确边界

本版是电脑局域网功能和小屏响应式布局，手机独立连接/原生音频及互联网好友/异地不在范围。主题是本机全局外观，不为全房间统一强制设置。

macOS/Linux 实际构建与声卡、跨机/跨系统同钟声学采集、八真实音频端压力、八小时真机长稳、睡眠唤醒/热拔插矩阵仍待实机验收。已配置的 CI 不表示本次已经观察到远程矩阵通过。Windows 同机静音和网络时钟日志不构成两台扬声器的声学误差保证。

房间创建时固定采样率（44.1/48/96/192 kHz）、双声道 f32 PCM，不增加有损编码；混音、DSP、重采样、漂移补偿及系统混音可能改变样本，不宣称 bit-perfect。逐曲切换房间格式未开放。此前数字音质探针仍只代表其绑定的源码范围，不把本轮原生输出日志当成新的音质或声学测量。
