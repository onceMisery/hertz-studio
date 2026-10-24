# L0「局域网一起听」P0 技术验证（Windows 单机）

对[lan-listening 方案](../../../docs/lan-listening.md) P0 批次（§11）的四项机器证据：CPAL 设备时钟语义、可变比 sinc 质量、对时估计器 + H 节奏回环实验、WASAPI 数字回录相关性。全部只用合成信号；本目录**不包含**两机真实链路、macOS/Linux 探针、声学录音与多端同步测量——P0 进入 P1 的其余门槛仍待三平台与第二台机器补测。

## 2026-10-24 修复与复测（当前有效证据）

Review 发现旧转换器把截止频率多乘了 0.5，1kHz 测幅掩盖了高频损失；旧 WASAPI 探针把包内帧的秒偏移直接当纳秒，延迟结果被包起始时间量化。原始 JSON/meta 保留作历史，下面的 v2 报告替代这两项结论。**旧 sinc 质量通过和 −5.74ms 延迟均值不再作为验收/校准依据。**

| 证据 | 当前结果 | 报告/范围 |
| --- | --- | --- |
| 房主计划 + 接收门禁 | 36 项房间状态机用例通过（15 房主 + 21 接收）；core 全库 39 项通过 | 覆盖提前 PCM 的原序号/部分匹配交错、及时匹配不超时、超时后匹配、未 Ready 的 Commit、已发布描述与边界冻结、四种采样率 600 秒精确期限、静音推进与迟到前缀裁剪、NoOp/Failed 水位 |
| 可变比 sinc v2 | 12 项转换单测通过；20 个通带测点最大绝对误差 0.005174dB；96→48k 三个混叠测点最差 −121.156dB；变比阶跃最大步进约稳态 1.003 倍 | [clocked-resample-v2.json](./clocked-resample-v2.json)；5 组 44.1/48/96k 组合，测点含 1k/10k/18k 及较低 Nyquist 的 90%；漂移增益另测 ±500ppm；不外推至其它转换组合 |
| WASAPI 包内时间戳 | 纳秒换算与逐帧单调回归通过；6 秒复测 22/23 标记检出，0 次 QPC 回退；设备钟拟合最大残差 0.0208ms；回录映射时差均值 +0.6835ms、std 0.0116ms | [wasapi-loopback-v2.json](./wasapi-loopback-v2.json)；48k、双声道、同一默认渲染端点；数字回录而非真实 DAC/声学延迟 |

v2 sinc 使用 256 抽头（原 128）、1024 相位子表；正确截止下 128 抽头在 96→48k、21.6kHz 仍衰减约 0.63dB，故增加抽头数而未放宽 0.1dB 候选线。输入前视变为 128 帧（48k 时约 2.667ms），接收端必须继续通过 `lookahead_frames()` 读取。当前本机 48k 立体声 RTF≈0.0128，仅供本次构建参考。

本次总计 core 39 + clocked 12 + 对时估计器 4 + WASAPI 时间戳 1 = 56 项测试通过；review 的 8 个独立复现用例也已全过。未接通产品房间网络、公共渲染器或前端，未新增对跨平台/多机同步的通过声明。

## 运行方式（仓库根目录，Windows）

```powershell
cargo test -p vmusic-core --lib           # 39 项，含房间状态机 36 项
cargo test -p vmusic-audio --lib clocked  # 可变比转换单测（12 项）
cargo run --release -p vmusic-audio --example clocked_resample_probe
cargo run --release -p vmusic-audio --example device_clock_probe -- --seconds 5
cargo run --release -p lan-probe --bin sync-experiment -- --seconds 20   # 在 tools/lan-probe
cargo run --release -p lan-probe --bin wasapi-probe -- --seconds 6       # 会放出轻微标记音
cargo test --offline --lib --bin wasapi-probe                          # 在 tools/lan-probe，无设备播放
```

`tools/lan-probe` 是独立工作区（同 `tools/desktop-probe` 惯例），不进产品 CI；探针退出即关闭，不随正式包发布（§11 P0 边界）。

## 2026-10-23 历史结果（Windows 11 build 26200、Realtek 扬声器、WASAPI 共享模式、rustc 1.98.1）

下表记录原探针运行事实；sinc/WASAPI 的通过结论已被 2026-10-24 复测替代，不代表当前版本验收。

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
- **WASAPI v2 的 +0.6835ms 映射时差**是本机本驱动的数字回录（mix 后、DAC 前）与 IAudioClock 拟合映射之差，符号大小绑定设备/后端/采样率；不能直接当成物理声卡/DAC/声学校准值。旧负延迟均值受时间戳缺陷影响，已失效。
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
