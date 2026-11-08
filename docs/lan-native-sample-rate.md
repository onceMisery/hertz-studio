# A07 原生采样率实施与验证

2026-11-07。状态：按 r2 完成实施，软件矩阵、独立审查与当前 Windows 同机验证通过。用户明确要求不走 TDD。功能按实验性范围提供，真实多端声学与跨 OS 结果单列。依据：[批准的设计](aegis/specs/2026-11-07-lan-native-sample-rate-design.md)。

创建增加 `format_mode=fixed/native`，缺省 fixed/48 kHz。native 必须省略 `sample_rate`，从 seek 后同一解码器的实际 PCM 取得率，支持 44.1/48/88.2/96/176.4/192 kHz；明确单声道复制为双声道，多声道、32 kHz、空流、无法解释的格式和运行期损坏明确拒绝。接收端继续用原设备率，将设备转换与时钟漂移校正合为一次。

同率沿已有转场资格复用 RenderCore，跨率或同率转场资格不足时保留同一个准备源并建立新代。Producer 串行封口真实终点 E，末块截短，封口后没有同代 Next 或填零 PCM。Host 保留唯一后继和拒绝实例；Receiver 保存整数 E 与控制截止 C，真实尾齐全后补滤波前视，按同一设备网格排空，无下一 Plan 也结束授权。已提交新代的锚点不会被旧代失败改变。

默认 fixed 保留旧 Hello/Plan 和三项必需能力。native 通过 `native_rate_v1` 及 ack/confirmed 屏障，在同一总握手期限内完成确认再附加音频。PCM 令牌从网络入口连续转移至 Receiver，复制时先取得额外峰值预留；发送引用直到 await 完成才释放。

## 容量与测量边界

| 范围 | 硬上限及实际持有者 |
| --- | --- |
| 每端输入 | 共同 1.3 秒/4 MiB：client、guest、Receiver 命令及真实输入 |
| 每端全部应用 PCM | 共同 3 秒/8 MiB：入口、转换输入/历史/前视、复制、应用输出容量 |
| 每端发送 | 3 秒/8 MiB，包含排队和发送 await 引用；全房间 64 MiB |
| 每 Producer 原生 PCM | 3 秒/8 MiB，所有 decoder/deck、首次前缀、准备源、退休资源和在途 PCM 事件 |
| 解码器返回 PCM | 创建前每 decoder 保守预留 0.5 秒/1,536,000 字节，按最高率、双声道 f64；decoded 尺寸再校验，超大 packet 明确拒绝 |
| 单 deck 容量 | 0.5 秒容量预留，运行前瞻不超过 1 秒；资源真正退休后才归还 |

时长按各块所属率向上取整，跨率总量共同记账。旧尾优先，新准备只用余量；满额等待、推迟或拒绝准备，不能通过删除旧尾腾空间。

以上是应用 PCM 预留证明，不能表述为整进程 RSS 限额。转换器固定系数表为 `(1024+1)×256×4=1,049,600` 字节/代，最多两代；表是非 PCM 工作区。编码块上限 64 KiB，TLS/WebSocket/socket 缓冲、控制元数据、压缩下载缓存与驱动私有队列独立受原模块边界约束。codec 内部私有 scratch 由 Symphonia 管理，本轮只约束可见返回 PCM 和应用副本，没有取得所有 codec/OS 的 RSS 峰值测量，不能宣称任意媒体的 decoder 私有内存也在 8 MiB 内。

## 验证矩阵

最终命令、通过数和审查结果见[工作证据](aegis/work/2026-11-07-lan-native-sample-rate/90-evidence.md)。core52、LAN65、audio175和完整room187项通过；audio有2项硬件测试忽略，room有1个子进程夹具忽略。Standard构建、Full编译检查、audio/core/LAN全部目标严格Clippy和真实Chrome 360–1440px通过。下表对应软件证据入口，V15的配置资格单列。

| 编号 | 软件证据入口 |
| --- | --- |
| V01 | contract 创建参数回归；protocol fixed/native能力与 wire 兼容；UI固定四档/native省略rate |
| V02 | native_transport 的确认前音频拒绝、仅控制成员、总期限、重复/冲突 ack 与越序请求 |
| V03 | render 的六档、mono、拒绝格式、声明/实际差异、seek/trim及首次前缀测试；host_jobs 实际本地源 |
| V04 | render 途中异常/变率/nonfinite/Reset、在线下载取消/假EOF；Producer Interrupted及Host已发布截止 |
| V05 | Producer native 同率 A/B/C 与 crossfade；最终 E/末块/晚到后继/无填零 |
| V06 | 真实 TLS 七代率链 44.1→48→96→192→44.1→88.2→176.4，按代逐位 PCM 与终点 |
| V07 | core/Receiver 单帧44.1k、长Counter、相位/漂移；Scheduler近MAX拒绝；Host旧率终点与位置 |
| V08 | core/Receiver有限Ready、少于前视/20ms、末尾加入、未Commit及零设备帧屏障 |
| V09 | Receiver独立EOF/乱序/冲突/缺真实尾；Host下一代Prepare后旧E仍送达及晚加入重放 |
| V10 | Host同刻End/新开始；Receiver旧C早于已Commit B起点、取消和旧尾保持 |
| V11 | Host拒绝实例保持、显式控制；队列移除Rejected/Prepared清理原源和预算 |
| V12 | Host第三源仅意图并消费同一次选择；core快速命令及健康/慢端合同；Receiver已Commit不改期 |
| V13 | fixed/native原生Receiver及旧故障回归；transport双连接失效、旧session、无授权 |
| V14 | buffer共同预算、ingress/Producer复制峰值；发送await；decoder/deck/退休/事件及取消释放 |
| V15 | Standard/Full检查；真实Chrome 360–1440px；真实HTTP/TLS与Windows设备路径另列报告 |

Windows同机真实输出只证明报告中绑定的软件/设备路径。macOS/Linux设备、不同电脑的同钟数字/声学回录、2/4/8真实端压力与8小时真实长稳尚未取得；57项Receiver专项中的八个虚拟小时及TLS逐位证据均不能替代这些结果。

本机真实探针首次在48→96 kHz计划间隙后发现队列late-only重同步，失败报告保留。修复沿既有ScheduledPcmQueue：以已接受的绝对FIFO帧界限和同Schedule逐帧endpoint封口，合法连续回调保留future head所属单元；未改设备时钟阈值、H或Receiver计数baseline，真正缺失回调仍严格late。单帧段前后间隙、有限写入和显式silence两个入口均有回归。

最终[Windows真实报告](../output/lan-native-rate-standard.json)为passed=true、18组检查通过，绑定Standard SHA `f43962f2ad89bbe51af56a96b1982e04040d8499a45dc51b5e044f764020ca96`。26秒播放覆盖44.1/48/96k与回到44.1k，Realtek/WASAPI设备会话始终为48k双声道，无欠载/重同步。32k后继被持久拒绝，96k旧曲在8000ms/768000帧结束，输入和设备队列归零；sealed诊断与已计费的转换存储可保留至替换/关闭。观测3次计划间隙，最长0.709秒（0.2秒采样），不宣称跨率精确gapless。

源码 owner 和兼容边界见 [ADR-0011](adr/0011-lan-rendering-and-output-ownership.md)，用户操作见[使用指南](lan-listening-user-guide.md)。工作树保留用户既有修改，本轮未提交或发布。

## 2026-11-08：当前 Standard / Full release 补验

用户要求优先实施 A07 r2 后，逐项源码复核确认现有实现覆盖修订，没有新增产品代码；本轮订正过期盘点并将真实设备验证绑定到当前发行候选。729 份主程序输入、199 份桌面输入在执行前后与候选冻结清单一致。

当前 [Standard](../output/a07-r2-current-20261108/qualification/standard/report.json)（SHA `51dbb6d8528bec246bb4c07e4d7f3ea75165b661bf3d2eed617d03bd134c3bd9`）和 [Full](../output/a07-r2-current-20261108/qualification/full/report.json)（SHA `c1c73fab3b849836480a76dead8387184943e4bd3e2236dd58ad2d00b2cd7a1c`）串行各通过同一 18 项集合。每版 60 秒原生率循环覆盖 44.1/48/96k，Realtek/WASAPI 设备稳定为 48k 双声道，无欠载或重同步；32k 后继持续拒绝，旧 96k 曲在 8000ms / 768000 帧结束且队列归零。按 0.2 秒采样观测的最长计划间隙分别为 0.545 / 0.542 秒，不宣称跨率精确 gapless。

逐项核对、命令、完整身份、日志与进程清理见[本轮记录](aegis/work/2026-11-07-lan-native-sample-rate/2026-11-08-current-r2-qualification.md)。旧报告和失败证据保留；本轮两版同机设备路径通过不替代跨 OS、跨机、多端、真实八小时和 codec 私有内存资格，功能继续按实验性提供。
