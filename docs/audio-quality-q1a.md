# 音质增强 Q1a：连续六段 EQ 与采用反馈

这是[音质设计](audio-quality-enhancement-design.md)的首个实现增量。保留六个固定频率、Q=1.2、原前级/RG/crossfade 范围和末端样本限幅；没有引入参数频率/Q、自动余量、R128、真峰值、独占或 IR。实施过程遵从用户“不走 TDD 驱动”的要求，直接实现后做回归；早期已有测试保留。

## 处理与生命周期

`render/dsp.rs` 集中已有 RBJ f64 系数/历史和连续交接。控制线程发布包含六段增益及前级的完整系数快照；输出消费者持有独占可变运行态。`RenderCore` 的 pull 接口现在要求 `&mut self`；CPAL 取得自己的 `RenderOutput` 后，不再允许同一 renderer 同时 pull。业务队列、解码、重采样与房间时钟归属不变。

热路径只有不可变参数快照邮箱使用 `try_lock`：争用时旧处理继续；首次或复位后没有有效快照则静音且不消费 PCM。两组滤波状态在控制侧预分配，保存 160 ms 的两个 deck 原始贡献及对应增益/混合权重，每个实际帧最多补算 4 个历史帧，然后用 20 ms、权重和为 1 的渐变交接。满历史准备约 53.3 ms，加渐变约 73.3 ms，另有一次块边界等待；这是固定六段范围的实现，不推广到低频/高 Q 参数 EQ。

两路分别执行该路前级对应的曲目增益 clamp、混音、EQ、前级，再混合，防止相消设置在过渡中增大峰值。相同配置不重置；过渡中只保留最新候选。普通倍增计算按曲目/前级缓存；频谱 tap 仍在 EQ/前级前。声道独立历史，暂停保留，seek/load/stop 复位，gapless 保持连续。

原生 Producer 把两份 160 ms PCM 历史计入原有预算，合计 320 ms，连同增益/权重元数据全部按实际分配字节预留；48 kHz 双声道共 245760 字节，96 kHz 为 491520 字节，另有固定滤波状态。上限仍为原 3 秒/8 MiB，不扩大预算掩盖使用。回收随实际 runtime 退出完成。

设备候选流在激活前不能消费 PCM。交接先撤回旧输出权限，再由控制线程等待在途回调退出；回调只作有限原子检查。新流失败尝试恢复旧流；恢复失败使播放暂停并报不可用。失效旧流不能阻止重新选择设备，Play/Load 也不会把已失效流伪装成正常播放。睡眠门禁继续覆盖最终输出。

## 保存与界面

HTTP 和 RPC 的 `/v1/player/dsp` 共用 `player_dsp.rs`。四个旧键在同一 SQLite 事务保存，未迁移 schema。响应保留旧字段，新增 `application`：

- `saved`：偏好已保存。
- `scope: equalizer`：采用回执只覆盖连续 EQ/前级，不把它当成全部 DSP、设备呈现或听感证明。
- `state`：`applying / applied / deferred / unavailable / failed / room`。
- `eq`：请求/采用修订、输出及 reset 代际、六段值、前级、处理率和活动状态。
- `error`：保存后应用失败的 code/message/request_id。错误保留到下一次明确应用尝试，重读不会隐去失败。

无真实处理的 null 后端显示不可用；暂停后的新参数待播放采用。回执只在实际 PCM 已处理且过渡结束后成立。房间 Host 通过原 MixerTimeline 将共同处理结束帧映射到呈现时刻，成员只听一次共同 DSP。

前端 `dsp-settings.js` 管理既有控件的草稿和反馈：校验成功后禁用重复保存，失败保留输入，迟到 GET 不覆盖新编辑/提交，POST 回执丢失先 GET 核对而不自动重发。未编辑表单读取恢复后回填保存值。页面可见时最多每秒查一次状态，页面/原生窗口隐藏时停止；Q1a 采用可见设置页查询，通用推送式完整配置状态留给 Q1b。状态用 `role=status`，重置只改草稿。

## 已执行检查与资格边界

2026-11-23 最终回归结果（直接实现后验证）：

| 检查 | 结果与覆盖范围 |
| --- | --- |
| 音频默认配置 | 单元 187 通过、4 忽略；重采样集成 6 通过、定时输出零分配集成 1 通过。4 个忽略项包括 2 个原有项及单独执行的 2 个 release 性能探针 |
| null 音频配置 | 30 通过；有 2 条既有 `sleep_deadline` 未使用代码警告，不称为零警告 |
| Hertz 默认桌面配置 | 完整库 955 通过、6 忽略，含 DSP 保存/故障和房间回归 |
| 内嵌 UI 资源 | 实际主程序路由检查 1 通过，含新控制器注册与内容读取 |
| 编译 | 音频 Rust 1.88 MSRV、Hertz Full、DBX Standard / Full 均通过 |
| Chrome | 生产表单与控制器的 7 组浏览器检查通过；非完整应用或真实 DBX 界面验收 |
| release 与设备 | 2 个串行合成性能探针通过；48 kHz 全零 PCM 实际输出生命周期通过，限制见下文 |

早期尝试在 `hertz-studio --no-default-features` 下执行完整库，出现 11 项失败：10 项依赖被关闭的桌面能力，另 1 项是把内嵌资源断言放进了仅 API 的夹具。资源断言已移到实际主程序 UI 路由，最终默认配置和该路由检查通过；未宣称无默认 feature 的完整服务端套件通过。历史失败日志保留在本机 `output/audio-quality/hertz-tests.log`，最终日志在同目录，其余忽略项不计作通过。

主要复现命令：

```powershell
cargo test --locked -p vmusic-audio --lib --tests
cargo test --locked -p vmusic-audio --no-default-features
cargo test --locked -p hertz-studio --lib
cargo test --locked -p hertz-studio --bin hertz-studio registered_ui_assets
cargo +1.88.0 check --locked -p vmusic-audio --target-dir target/audio-quality-msrv
cargo check --locked -p hertz-studio --features full -p dbx-plugin-hertz --features dbx-plugin-hertz/full
cargo check --locked -p dbx-plugin-hertz
cargo check --locked -p dbx-plugin-hertz --features full
cargo test --locked -p vmusic-audio --release --lib quality_probe -- --ignored --nocapture --test-threads=1
cargo run --locked --release -p vmusic-audio --example eq_output_probe
node scripts/check-dsp-settings-browser.js
```

浏览器脚本使用项目已有的 `PLAYWRIGHT_MODULE` 覆盖机制及已安装 Chrome，实际载入生产表单/控制器，覆盖异步保存和失败、草稿、首读恢复、键盘、390 px 与 200% 缩放。HTTP 回归另检查内嵌 `/dsp-settings.js` 真正可读取；该脚本不替代完整应用的发行形态检查。

表单实现采用本次查阅的 modern-web-guidance 表单指引：有效提交后暂时禁用按钮防重复发送，以 `role=status` 宣告异步结果，保留原生约束校验。独立静态评审发现的问题已修复，最终没有剩余阻塞项；评审本身未运行测试。

离线探针分别测 DSP 本体和含输出门禁、队列、曲目增益、tap、DSP、音量/限幅的 renderer。每种 44.1/48/96 kHz、128/512 帧组合处理 30 秒合成 PCM，按最大提升/衰减切换。[串行原始结果](../evals/audio-quality/q1a-20261123/windows-synthetic.json)的 renderer P99 为 24.6–95.7 µs，六种组合未超块期限；此前并行执行时 44.1 kHz/128 帧出现两次超期限，最大约 10.84 ms。这些是普通线程离线耗时，不是声卡回调欠载或长稳资格，所有异常仍保留为限制。

[静音设备探针结果](../evals/audio-quality/q1a-20261123/windows-silent-output.json)记录本机 48 kHz 共享输出实例提交全零 PCM，检查初始待采用、播放采用、EQ 切换、暂停/续播、seek、默认设备重选通过。它不测声学质量，不替代有声听测、物理拔插、系统休眠、跨 OS/跨机或 2 小时稳定性。后续阶段按父设计的独立准入推进，不能把 Q1a 实现称为整个音质专项完成。
