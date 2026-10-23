# L0「局域网一起听」P0 技术验证（Windows 单机）v1

对[lan-listening 方案](../../../docs/lan-listening.md) P0 批次（§11）的四项机器证据：CPAL 设备时钟语义、可变比 sinc 质量、对时估计器 + H 节奏回环实验、WASAPI 数字回录相关性。全部只用合成信号；本目录**不包含**两机真实链路、macOS/Linux 探针、声学录音与多端同步测量——P0 进入 P1 的其余门槛仍待三平台与第二台机器补测。

## 运行方式（仓库根目录，Windows）

```powershell
cargo test -p vmusic-core                 # 含 §8.2 计划状态机仿真（17 项）
cargo test -p vmusic-audio --lib clocked  # 可变比转换单测（11 项）
cargo run --release -p vmusic-audio --example clocked_resample_probe
cargo run --release -p vmusic-audio --example device_clock_probe -- --seconds 5
cargo run --release -p lan-probe --bin sync-experiment -- --seconds 20   # 在 tools/lan-probe
cargo run --release -p lan-probe --bin wasapi-probe -- --seconds 6       # 会放出轻微标记音
```

`tools/lan-probe` 是独立工作区（同 `tools/desktop-probe` 惯例），不进产品 CI；探针退出即关闭，不随正式包发布（§11 P0 边界）。

## 2026-10-23 本机结果（Windows 11 build 26200、Realtek 扬声器、WASAPI 共享模式、rustc 1.98.1）

| 证据 | 报告 | 关键结果 | 门禁 |
| --- | --- | --- | --- |
| §8.2 计划状态机 + 接收门禁仿真 | `cargo test -p vmusic-core`（无独立报告） | 28 项确定性用例全过：房主侧 17 项（next→next→seek→pause 合并、Commit 后前缀冻结、applied 恰好一次、同键重试不重复执行、busy/no-op/过期/乱序/revision 冲突）；接收侧 11 项（PCM 先于 Format/Plan、匹配超时丢弃重同步、无 Commit 不出声、迟到 Commit 不追播、旧会话不复活、计划 ID 不符拒绝、第三代只留意图、切换后旧代际丢弃、非法序号/重叠帧/零长块拒绝、欠载计数、等匹配窗口溢出） | 通过 |
| 可变比 sinc（`clocked_resample`） | [clocked-resample.json](./clocked-resample.json) | 15 组速率×漂移增益误差 ≤0.001dB（候选线 0.1dB）；96→48k 混叠 −135~−151dB（候选线 −90dB）；±500ppm 变比阶跃最大相邻步进为稳态 1.003 倍（无 click）；立体声 48k RTF≈0.014 | 通过 |
| CPAL 输出时间戳语义 | [device-clock.json](./device-clock.json) | `callback`（IAudioClock QPC）单调、与宿主单调钟同速率（+2.1ppm）→ **可作设备时钟锚点**；`playback` 估算有回归且斜率偏差 −5436ppm → **不可作呈现期限**，设备排队深度需原生查询 | 通过（分项判定） |
| 对时估计器 + H 节奏（回环 TCP） | [sync-experiment.json](./sync-experiment.json) | 服务端虚拟钟真值 12.5ms/50ppm，应用层 1ms±0.3ms 时延 + 5% 尖峰：偏移误差 P95 0.166ms（候选 1ms）、最大 0.303ms；1100 个 20ms 块 0 迟到、0 超 H 水位，缓冲 slack 中位 996.9ms ≈ H=1s | 通过 |
| WASAPI 设备时钟 + 回录相关性 | [wasapi-loopback.json](./wasapi-loopback.json) | 设备位置↔QPC 拟合残差 ≤0.095ms、单调；**Realtek 位置按端点内钟计数，单位比例 8.00003×（384kHz）需自标定**；22/23 标记检出，互相关峰值 0.99999996，端到端呈现时延均值 −5.74ms、std 0.019ms | 通过 |

每份报告配同名 `.meta.json`（编译器、git 身份、可执行/报告/源码 hash、`syntheticOnly:true`、`releaseEligible:false`）。源码为 HEAD `841fc1f` 加未提交改动，不是已发布提交。

## 读数口径与限制

- **同步精度未测量**：单机回环只验证估计器误差、节奏与缓冲记账；不构成 §12.2 的多端出声同步证据（那需要同一采集时钟的多通道录音与第二台机器）。
- **WASAPI 的 −5.39ms 端到端常数**是本机本驱动的回录（mix 后、DAC 前）与 IAudioClock 拟合映射之差，符号大小绑定设备/后端/采样率，属 §7.2「校准值」的输入数据，不是可移植的延迟规格。
- `playback` 估算（cpal）按「可写空间」推算且丢弃设备帧位置；接收端呈现期限应使用原生 `IAudioClock` 位置 + 排队（本探针路径），cpal 时间戳仅作 QPC 锚点。
- 对时实验的漂移估计（89 vs 真值 50ppm）受窗口跨度（32 样本 ×100ms）限制，偏移误差不受影响；生产端点应按 §7.1 用分钟级窗口估频偏。
- 6 秒窗口、单设备、单次运行；没有长稳、休眠唤醒、断连重入与无线链路数据。§12.3 的故障矩阵属 P2+。
- 探针内 `sync-experiment` 的时延整形在应用层注入（报告中 `shaping:"app-layer"`），不含 TCP 重传/排队效应。

## 与 P0 门槛（§11）的对应

| 门槛 | 状态 |
| --- | --- |
| 确认可获取可靠设备时间 | Windows 已证（CPAL callback 锚点 + 原生 IAudioClock 位置，后者需单位比例自标定）；macOS/Linux 待测 |
| 8.2 时序仿真通过 | 通过（`vmusic-core::room` 17 项确定性用例） |
| 有录音相关性证据 | Windows 数字回录已证；声学多端互相关待两机 |
| 平台缺口先解决，不先做房间 UI | 未做任何房间 UI；cpal playback 估算缺口已实证并给出原生替代路径 |
