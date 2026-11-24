# Q1b–Q4 软件验证记录

2026-11-24，Windows / Intel i7-13620H。范围与产品限制见 [实施记录](../../../docs/audio-quality-q1b-q4.md)。直接实现后回归；没有采用 TDD。

- `build-identity.json`：原始 Git 基点、最终任务源文件 SHA-256、执行二进制 SHA-256；记录原始文件字节，Git 文本检出可能转换换行。
- `verification.json`：真实命令、退出码、覆盖范围、输出摘要及本机完整日志 SHA-256。音频 249 单元 + 7 集成、null 31、core 54、store 69、Hertz 974、内嵌资源 1；既有手动测试忽略数如实保留。Chrome 参数设置 10 组、动作 9 组，Full/DBX 构建与 ADR 430 项通过。
- `windows-silent-output.json`：实际 Realtek 48 kHz 共享和独占静音结果。s16 与 s24/32 容器成功；独占 f32 拒绝后保留共享输出，最后恢复共享。`device_qualified` 仍为 false。
- 数值检查含独立重建的 180 个频率/相位和 72 个脉冲/突发/噪声组合；扫描最坏 −1.093543 dBTP。它不是所有输入的数学保证。
- `performance.json`：最终 600.51 秒连续变更矩阵、分组范围、P99/最大值/超期限次数，以及同机旧六段基线的不同运行条件。
- `performance-before-rate-scope.json`、`build-identity-before-rate-scope.json` 和 `verification-before-rate-scope.json`：收窄前的历史结果与身份；完整 96 kHz 的两组 P99 超过 25%，不将它们改写成通过。
- `retained-attempts.json`：失败、诊断和主动停止的部分长测，保留原日志哈希。
- `review.json`：新采样率范围的独立补充审查三次因服务容量错误中断；协调者检查与实际回归如实单列，没有独立审查通过结论。
- `workspace-structure.json`：持续工作记录 bundle 通过；Aegis 全局结构检查仍报告原有旧索引与 ADR 模板问题，与上次 150 行诊断完全相同。这是结构检查，结果与已通过的 430 项项目 ADR 契约分开记录。

最终 CPU 测量按六种采样率/块长组合各运行 100 秒，包含每半秒的参数变更、历史预热和受支持率的同延迟核交接。44.1/48 kHz 使用完整增强链，96 kHz 明确关闭 IR/FIR 与饱和。全部 P99 低于块期限的 25%，六组零超期限：

| 处理率 | 块帧数 | 处理范围 | P99（ms） | P99/期限 | 最大块（ms） | 超期限次数 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 44.1 kHz | 128 | 完整链 | 0.4245 | 14.63% | 0.7459 | 0 |
| 44.1 kHz | 512 | 完整链 | 1.5733 | 13.55% | 1.9308 | 0 |
| 48 kHz | 128 | 完整链 | 0.4211 | 15.79% | 0.6412 | 0 |
| 48 kHz | 512 | 完整链 | 1.6299 | 15.28% | 1.9960 | 0 |
| 96 kHz | 128 | 无 IR/FIR 与饱和 | 0.2819 | 21.14% | 0.4895 | 0 |
| 96 kHz | 512 | 无 IR/FIR 与饱和 | 1.0262 | 19.24% | 1.4572 | 0 |

MMCSS Audio HIGH 是完整链合成探针的调度条件，并不代表设备驱动验收。旧六段同机基线另用 `renderer_quality_probe` 复测，未节拍限速、未设置 MMCSS、每 32 块改变参数，不能直接用比值解释新增处理开销。未修改系统电源计划或产品进程 CPU 亲和性。运行时其它应用负载不受控制；早期失败和临时固定核心诊断保留在 `output/audio-quality`。

主要复现命令（PowerShell，项目根目录）：

```powershell
cargo +1.88.0 test --locked --target-dir target/audio-quality-msrv -p vmusic-audio
cargo +1.88.0 test --locked --target-dir target/audio-quality-msrv -p vmusic-audio --no-default-features
cargo +1.88.0 test --locked --target-dir target/audio-quality-msrv -p vmusic-core -p vmusic-store -p hertz-studio --lib
cargo +1.88.0 test --locked --target-dir target/audio-quality-msrv -p hertz-studio --bin hertz-studio registered_ui_assets_are_served_with_their_own_content
cargo +1.88.0 check --locked --target-dir target/audio-quality-msrv -p hertz-studio --all-targets --features full
cargo +1.88.0 check --locked --target-dir target/audio-quality-msrv -p dbx-plugin-hertz --all-targets
cargo +1.88.0 check --locked --target-dir target/audio-quality-msrv -p dbx-plugin-hertz --all-targets --features full
$env:PLAYWRIGHT_EXECUTABLE_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
node scripts/check-dsp-settings-browser.js
node scripts/check-audio-quality-actions-browser.js
node scripts/check-adrs.js

$env:HERTZ_AUDIO_PROBE_PACED='1'
$env:HERTZ_AUDIO_PROBE_CHANGES='1'
$env:HERTZ_AUDIO_PROBE_SECONDS='100'
cargo test --locked -p vmusic-audio --release --lib complete_quality_chain_probe -- --ignored --nocapture --test-threads=1

cargo test --locked -p vmusic-audio --release --lib renderer_quality_probe -- --ignored --nocapture --test-threads=1
cargo test --locked -p vmusic-audio --release --lib quality_stage_cost_probe -- --ignored --nocapture --test-threads=1

$env:HERTZ_PROBE_EXCLUSIVE='1'
cargo run --locked --release -p vmusic-audio --example eq_output_probe
```

Chrome 脚本需要可解析的 Playwright 包和本机 Chrome；本轮通过 `NODE_PATH` 指向 Codex 自带依赖。共享 `target/debug` 曾发生缺少 `.rmeta/.rlib` 的构建缓存错误，因此 Rust 1.88 使用独立目录。Windows 执行中的探针会锁住 exe；必须等它结束再重建，发生过一次 LNK1104，随后误启旧二进制的尝试已终止并标为无效，未列作新实现证据。

未覆盖：合法歌曲同响度听测、USB/物理拔插、端点占用/休眠、两小时真实设备长稳、其它 OS、完整应用/DBX 的现场 UI 旅程、全进程 RSS 上限及端到端参数采用延迟资格。非 Windows 稳定来源自动采用、未知相位临时试听与同响度对比未交付；这些限制在产品状态和实施文档中保留。null 构建保留两项既有 sleep callback dead-code 警告；格式、编译及回归结果均记录其实际退出码。
