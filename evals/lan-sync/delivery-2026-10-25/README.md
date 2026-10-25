# 局域网一起听交付记录 · 2026-10-25

源码、可运行 Windows 构建、完整房间界面和自动验收已交付；跨机声学与三平台硬件发布验收仍有待测项目。`build-identity.json` 的 `release_eligible=false` 保留这一边界，不能把本记录解释为任意设备的同步精度保证。

## 构建与实现范围

本次测试绑定源码提交 `e315d55b1fd53a0fe4cc6d3a9ac61b685bb5cf4c`，Standard 原生验收二进制 SHA-256 为 `e8fe7b12adad8d36b9b85371c266d59988ed8bbf730e0a50dd8f1da29691d978`。[构建身份](build-identity.json)包含编译器、平台、源文件原始/LF SHA-256，均对应验收时文件。最终文档提交可以位于该源码提交之后。

业务队列仍由 AppState 持有，单机和房间共用 RenderCore；原生 Receiver/ScheduledPcmQueue 负责设备网格、时钟补偿与输出退出。新增能力通过正式协议、唯一 owner 和有界生命周期扩展，见 [ADR-0011](../../../docs/adr/0011-lan-rendering-and-output-ownership.md)。本轮修复覆盖尾帧与连续交接、时钟采样竞态、有限诊断 EOS、退出注册竞争、保存音量、服务正常关闭、重复曲目实例身份，以及重连后的未知播控结果查询。

房间格式在创建时固定，支持 44.1/48/96/192kHz、双声道 f32 PCM，不增加有损编码。不同源格式、共同 DSP 和设备时钟补偿可重采样，因此不能宣称端到端 bit-perfect；逐曲切换房间格式尚未开放。完整操作、Linux 依赖、凭据服务及防火墙说明见[使用指南](../../../docs/lan-listening-user-guide.md)。

## 已执行验证

| 验证 | 本次结果 | 证据 |
| --- | --- | --- |
| Windows Standard workspace | 996 passed，0 failed，5 ignored | [verification.json](verification.json) |
| Windows Full workspace | 1153 passed，0 failed，7 ignored | 同上；包含 Full 专属用例 |
| 两版 all-targets Clippy | `-D warnings` 通过 | 同上 |
| Rustfmt | 自有 workspace 包检查通过；不改 vendor SDK | 同上 |
| 前端默认聚合 | 64 步，0 失败；默认集合未执行全部 107 项 live 检查 | [ui-acceptance.json](ui-acceptance.json) |
| 两独立 profile、真实 TLS 控制流程 | 8 项通过 | [control-acceptance.json](control-acceptance.json) |
| 插件 stdin EOF + 在途请求 | Standard/Full 各 3 项通过；Guest 收到 End 并清除凭据 | [Standard](plugin-eof-standard.json) / [Full](plugin-eof-full.json) |
| Windows 真实原生设备流程 | 15 项通过；连续 120 秒，44.1/48/96kHz 三源率，欠载/重同步均为 0 | [native-acceptance.json](native-acceptance.json) |
| 当前源码 release 数字重采样探针 | 20 个通带测点，最大绝对增益偏差 0.005174dB；代表混叠最差 -121.156dB；漂移阶跃检查通过 | [clocked-resample.json](clocked-resample.json) |

原生验收使用一台 Windows 上的两个进程、真实 `WASAPI` / `扬声器 (Realtek(R) Audio)`，输出为 48000Hz、f32、默认缓冲，本机音量设为零。时间戳能力为 `BackendEstimate`，诊断记录启动时钟 fault 水位而不假报零故障。本次凭据后端显式设为测试内存存储；不会读写个人系统凭据，也不证明操作系统凭据服务持久化已经实机验收。

默认忽略项及其原因记录在 `verification.json` 的 `ignored_tests`：包含外网 live 用例、可选压力探针和供父测试启动的回滚子进程夹具；没有把 ignored 计为 passed。

流程包含测试音、自然转场、next 与绑定实例的 seek 后真实新 epoch/呈现帧推进、播放中重排与 DSP、服务端睡眠暂停、音频端离场宽限、撤权重连、离开/结束，以及新增集成回归。逐位 PCM 一致、慢端/失联隔离、八小时虚拟队列与确定性交错由 workspace 测试覆盖；不是跨机或八端真机长稳结果。原始运行日志保留在本工作树 `output/`，提交的报告只保存有界摘要与首尾观测，不包含邀请或令牌。

原生输出与集成改动均完成独立规格审查和后续质量审查，最终无剩余 P1/P2，见[审查范围](review-acceptance.json)。质量审查发现的“插件有在途请求时 EOF 退出绕过 End”使用同一真实进程回归复现：[修复前失败](plugin-eof-before-fix.json)，修复后两版通过；进程主线程明确拥有 Runtime 和关闭屏障，不依赖 SDK worker 的析构时机。修复前报告保留当时的插件与服务二进制身份，最终两版报告绑定本次最终保留的 Standard 服务文件。

真实浏览器已操作创建/分享/加入、受限成员、纯文本聊天、原生输出、播放/暂停与离开，并验证 1440px 与 390px 布局无横向溢出。截图用于记录实际视觉布局；最后的合同修复由自动化回归覆盖。可查看[入口](../../../docs/images/lan-room/entry.png)、[房主](../../../docs/images/lan-room/host.png)、[成员](../../../docs/images/lan-room/guest.png)和[窄屏](../../../docs/images/lan-room/narrow.png)。

## 重复执行

```powershell
$env:VMUSIC_BACKEND = 'null'
cargo test --workspace
cargo test --workspace --features hertz-studio/full,dbx-plugin-hertz/full
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy --workspace --all-targets --features hertz-studio/full,dbx-plugin-hertz/full -- -D warnings
node scripts/check-frontend.js
cargo build --release -p vmusic-audio --example clocked_resample_probe
.\target\release\examples\clocked_resample_probe.exe
cargo build -p hertz-studio --bin hertz-studio
python -X utf8 scripts/check-lan-room.py --binary target/debug/hertz-studio.exe --native-output --duration 120 --report output/lan-native.json
python -X utf8 scripts/check-lan-room.py --binary target/debug/hertz-studio.exe --report output/lan-control.json
cargo build -p dbx-plugin-hertz
python scripts/check-plugin-room-shutdown.py --plugin target/debug/dbx-plugin-hertz.exe --service target/debug/hertz-studio.exe --report output/plugin-eof-standard.json
cargo build -p dbx-plugin-hertz --features full
python scripts/check-plugin-room-shutdown.py --plugin target/debug/dbx-plugin-hertz.exe --service target/debug/hertz-studio.exe --report output/plugin-eof-full.json
```

格式检查使用 CI 中列出的自有包列表。workspace 测试可能重建共享输出路径的二进制，因此先完成测试，再构建并验收最后保留的 Standard 服务；native 脚本会为自己的进程显式启用 CPAL。macOS/Linux 换用无 `.exe` 的可执行文件和对应 shell；运行 native 验收需真实可用声卡，不能用 null 后端替代。脚本支持 `--duration 28800`，但八小时参数可运行不等于本次已执行八小时。

## 支持与剩余硬件验收

| 项目 | 状态 |
| --- | --- |
| Windows Standard 原生设备及完整界面 | 上述本机配置通过 |
| Windows Full | 构建、workspace 测试和严格 Clippy 通过；原生实测使用 Standard |
| macOS / Linux | 原生实现和 Standard/Full/MSRV CI 矩阵已配置；本地环境未观察远程 CI 结果，需实际构建与设备验收 |
| 两机/跨 OS 声学同步 | 待同一采集时钟多通道录音；不以网络对时日志代替 |
| 八音频端 + 聊天/网络压力 | 待实际多端验证 |
| 八小时真实设备长稳 | 待测；虚拟时间用例不替代 |
| 热插拔、休眠唤醒、真实断网矩阵 | 自动状态机/传输故障回归已覆盖部分软件边界；硬件组合仍待测 |

因此本交付可用于功能试用和后续硬件验收，不据此发布三平台声学精度或八端八小时稳定性承诺。
