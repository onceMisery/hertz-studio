# 音质增强剩余软件增量：2026-11-24

本目录记录在 `f036e9ba29e35160e6283bc595f05e7e5e59ae89` 上完成的不可变来源、临时草稿试听、固定参考同响度比较与资源/响应测量。父设计是 [音质增强设计](../../../docs/audio-quality-enhancement-design.md)，行为及兼容范围见 [实施记录](../../../docs/audio-quality-q1b-q4.md)。首轮 `2a65a3f` 的记录保留在原目录，本目录不会把旧二进制或旧连续测量重新归给本轮源码。

本轮仅写入附加的 C 盘工作树，复用明确获准的 D 盘 `target/audio-quality-msrv`；未改动并发主 checkout。源码、执行二进制、命令和日志以 SHA-256 绑定。日志中的路径属于本次执行环境，重新运行可以使用自己的隔离 target。现有 Git 属性文件对本目录原始日志禁用换行转换，并允许测试工具输出的末尾空行；日志字节与 SHA-256 保持原样，源码与文档仍执行全部空白检查。

## 已执行的软件与界面检查

| 检查 | 当前结果 | 覆盖与限制 |
| --- | --- | --- |
| Windows Rust 1.88 四库 | Hertz 981、audio 269、core 58、store 69 通过，共 1,377；另有 16 项忽略 | 包括来源、配置、试听、延迟/EOF、睡眠与原播放回归；忽略的设备/资源探针须独立运行 |
| 音频集成与 null | 集成 7、null 31 通过 | 原重采样/调度分配及无输出的事实；不是声卡或听感验收 |
| Rust 1.88 发行形态 | Hertz Full、DBX Standard/Full all-targets check 通过 | 当前源及静态登记已编译；不等于正式安装包或真实 DBX 宿主验收 |
| Linux / WSL2 | 两库 all-targets check 通过；Hertz `audio_` 27、audio `preview` 13、`comparison` 6 通过 | 实际 GNU/Linux 编译运行，含 Unix 无路径只读快照；不是 Linux 声卡或其它 Unix 系统实机验收 |
| 实际内嵌 HTTP 资源 | 1 项通过 | 唯一资源宏登记试听脚本，实际路由逐项核对正文与压缩响应；清单为 235 方法/路径、175 静态资源 |
| 前端聚合 | 87 步通过 | 源码/资产/路由/原交互合同，锁定 Three 测试依赖 |
| Chrome 生产表单 | 试听 14、保存 10、操作 9 组通过 | 真实 Chrome 事件与生产 JS/CSS/Theme；传输及服务状态为受控夹具，覆盖键盘、迟到回执、取消、隐藏/断连、390 px/200% 与深浅主题 |
| 真实共享输出 release | 1 项通过，Realtek / CPAL WASAPI、48 kHz、双声道 f32 | 全零 PCM、播放器音量 0；HTTP 准备、DBX RPC 选择、取消/恢复、实际暂停和来源重绑定；固定 −3 dB 上下文为合成夹具，不是静音 R128 测量或有声比较 |

ADR 常量与结构 445 项、路由生成一致性及 35 个任务 Rust 文件的格式检查均通过。工作记录的初次结构检查发现本工作树缺少计划/记录索引，已按同一 helper 修复；最终按 `bundle` → `check` 顺序执行，两项均退出 0，结果与业务验收分开保存。身份见 [build-identity.json](build-identity.json)，命令/日志摘要见 [verification.json](verification.json)与 [logs.json](logs.json)，不利结果的归属见 [retained-observations.json](retained-observations.json)。

本轮父设计、实施记录、证据目录与新增引用均可读取。对改动文档的扩展链接检查还发现 11 次既有本地引用在隔离工作树不可用，均已核对为任务基点原有、未由本轮引入；具体归属记在 `verification.json`，不据此宣称全仓库文档链接完整。

图像保存在 [深色](screenshots/390-200-dark.png)和[浅色](screenshots/390-200-light.png)。两幅均由生产 Theme 实际改变渲染配色，并检查背景明度；当前浅色图已人工查看。Chrome 第五轮未加载生产 Theme 的旧“浅色通过”结论已撤回。

## 参数采用时间

Rust 1.88 release，单进程串行执行，Windows Audio 优先级，44.1/48/96 kHz、双声道、128/512 帧；每组 20 次，共 480 次。先填满实际两秒输入历史，统计控制端准备至实际 render 采用完成，记录 P95、最大耗时和失败率。它不包括 HTTP、DBX、SQLite、设备或完整应用调度时间。

| 组 | 六个组合的 P95 范围 | 最大耗时 | 失败 | 与 100 ms 候选的关系 |
| --- | --- | --- | --- | --- |
| 普通固定布局 EQ | 75.21–83.35 ms | 83.60 ms | 0/120 | 本组通过 |
| 普通参数 EQ | 45.04–55.33 ms | 55.45 ms | 0/120 | 本组通过 |
| 100 Hz / Q=8 极端组 | 405.26–408.39 ms | 409.15 ms | 0/120 | 极端参数单列，不授予普通响应保证 |
| 音色组 | 263.85–270.67 ms | 271.07 ms | 0/120 | 未达到 100 ms 候选目标 |

音色组执行现有 250 ms 采用渐变，小音量补偿还有 50 ms 时间常数。其较长响应已由源码和运行结果确认；本轮保留平滑行为，不把探针退出 0 当成该组达到 100 ms，也不宣称整个已开放参数范围均达到该目标。完整逐行数据见 [parameter-response.json](parameter-response.json)。

复现参数探针：

```powershell
cargo +1.88 test -p vmusic-audio --release --lib --locked render::resource_tests::parameter_adoption_latency_probe -- --exact --ignored --nocapture --test-threads=1
```

## 实际工作内存

使用同一 release 二进制，逐探针独立进程；Rust 分配器计量活跃分配峰值，Windows 每 2 ms 采样实际工作集和私有提交。单次分配总量不等于活跃内存，进程增量也不等于完整应用总 RSS。

| 路径 | Rust 活跃分配峰值 | 私有提交增加 | 工作集增加 | 候选预算 |
| --- | --- | --- | --- | --- |
| DSP / 44.1 kHz | 2.75 MiB | 2.83 MiB | 3.05 MiB | 16 MiB，本路径通过 |
| DSP / 48 kHz | 2.99 MiB | 3.67 MiB | 3.01 MiB | 16 MiB，本路径通过 |
| DSP / 96 kHz 基础增强 | 5.93 MiB | 6.60 MiB | 5.95 MiB | 16 MiB，本路径通过 |
| 96 kHz 双声道 60 秒 WAV 流式分析 | 2.40 MiB | 2.65 MiB | 1.13 MiB | 32 MiB，本路径通过 |
| 上述 WAV 转到 44.1 kHz、四次处理路径比较 | 13.11 MiB | 13.30 MiB | 13.32 MiB | 32 MiB，本路径通过 |

DSP 包含参数邮箱、两秒输入历史、限制器、允许的 IR/音色过渡、待处理核以及最大试听对齐；不包含既有解码器/PCM 队列或声卡。分析包含实际 WAV 解码、ebur128、参考前缀、重采样及同一 DSP 的四次处理，不包含文件缓存、数据库、完整 UI 或设备。Unix 的 4 GiB 快照是临时磁盘额度，另行核算。原始字节和采样范围见 [working-memory.json](working-memory.json)。

```powershell
cargo +1.88 test -p vmusic-audio --release --lib --locked render::resource_tests::dsp_working_memory_probe -- --exact --ignored --nocapture --test-threads=1
cargo +1.88 test -p vmusic-audio --release --lib --locked render::resource_tests::analysis_working_memory_probe -- --exact --ignored --nocapture --test-threads=1
```

## 600.52 秒连续处理链

当前同一 Rust 1.88 release 二进制完成六组合、每组 100 秒的 paced 连续变更，实际运行 600.52 秒。包含参数预热/采用、257 taps 核切换与退休、音色变化、临时固定衰减及增强/旁路算法延迟对齐。每次回调计量分配和释放；每组合实际切换试听侧 38–40 次。44.1/48 kHz 执行完整允许链，96 kHz 保留基础增强，不开启 IR/过采样饱和。

| 处理率 / 帧 | P99 回调耗时 | P99 / 块期限 | 最坏回调 | 超期限 | 回调分配 / 释放 |
| --- | --- | --- | --- | --- | --- |
| 44.1 kHz / 128 | 0.3873 ms | 13.34% | 0.6927 ms | 0 | 0 / 0 |
| 44.1 kHz / 512 | 1.1181 ms | 9.63% | 1.7961 ms | 0 | 0 / 0 |
| 48 kHz / 128 | 0.4111 ms | 15.42% | 0.8885 ms | 0 | 0 / 0 |
| 48 kHz / 512 | 1.1887 ms | 11.14% | 1.8586 ms | 0 | 0 / 0 |
| 96 kHz / 128 | 0.2684 ms | 20.13% | 0.5777 ms | 0 | 0 / 0 |
| 96 kHz / 512 | 0.9067 ms | 17.00% | 1.3050 ms | 0 | 0 / 0 |

六组均达到该条件下 P99 小于块期限 25% 的目标，最大回调 1.8586 ms，总超期限 0、分配/释放 0。原始结果见 [continuous-chain.json](continuous-chain.json)及其[实际日志](logs/remaining-preview-chain-600s-direct.log)。该矩阵执行真实 RenderCore/DSP，未打开声卡；它不是整个设置服务端响应、两小时有声实机或其它机器的保证。

复现时先结束其它大编译和性能工作，并在一个 PowerShell 会话设置以下环境后运行。此次实际执行直接向测试二进制传入等价环境；两个没有输出的 PowerShell 启动器均撤回，未用于本表。

```powershell
$env:HERTZ_AUDIO_PROBE_SECONDS = '100'
$env:HERTZ_AUDIO_PROBE_PACED = '1'
$env:HERTZ_AUDIO_PROBE_CHANGES = '1'
$env:HERTZ_AUDIO_PROBE_PREVIEW = '1'
cargo +1.88 test -p vmusic-audio --release --lib --locked render::continuity_tests::complete_quality_chain_probe -- --exact --ignored --nocapture --test-threads=1
```

## 证据限制与剩余现场资格

debug 的真实共享输出夹具在 5 秒内未完成实际暂停，记录保留；相同 release 流程通过。这一差异没有完整因果证明，不据此声称暂停缺陷已修复，也不向 debug 构建授予实时资格。Linux 首轮试听用例错误要求首次回调必须前进；实际样本 `try_lock` 可以合法争用。当前测试显式制造争用核验零消费/零堆操作，释放后以条件等待检验实际进展；生产回调没有为测试改变。

首次前端聚合发现试听脚本未进入唯一静态登记宏，旧内嵌测试只遍历已登记项，不能证明完整试听入口可加载。本轮补齐登记、存在断言和生成路由后，实际 HTTP 资源与聚合检查通过。早期编译、夹具、浏览器及空输出启动器记录均保留为历史尝试；空日志且退出 0 不算运行证据。

独立只读审查多次因模型服务容量中断，没有审查结论；本轮由协调者直接复核 owner、来源/修订、取消恢复、算法和证据范围。审查缺口不能记为通过。

以下仍需要对应现场记录：12 首合法参考曲的固定同响度偏好/ABX、耳机或音箱目标频响、USB/占用/物理拔插/休眠、至少两小时有声播放及弱机、跨 OS/跨机资格。`device_qualified` 仍为 false。96 kHz 不开放正式实时 IR 或过采样饱和，未知相位只开放临时短核；本目录不宣布整个 Q0 或音质专项已验收。
