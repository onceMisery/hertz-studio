# 分页匹配与总数合并查询：诊断与验收记录

2026-10-18，接续[双发行版五万曲记录](../editions-v1/README.md)发现的默认调度慢查询。此前 Standard 最慢类别 P95 为 124.18 ms，Full 为 720.44 ms；Full 失败完整保留。本目录记录定位、实现与新产物独立验收：**两版本轮默认调度下的顺序本地查询和受控首结果均通过原门槛**，不将单核 affinity 的诊断成绩作为产品达标依据。路线图与发布验收尚未完成。

## 定位依据

[原始诊断](./candidate-and-page-diagnostic.json.gz)在同一新建的 50000 曲 fixture 上运行实际 sqlx/SQLite。先交替比较原 bounded UNION 的 2001 行传输和单行 JSON 聚合；宽泛 Track 的八轮均值约 8.23 / 7.39 ms，差距不足以解释数百毫秒慢查询，因此没有采用候选 JSON 聚合方案。

实际 HTTP/RPC 原来分别取列表与总数，两个调用都独立预筛并关联编辑表。原执行计划均为 `SCAN t` 和编辑表索引查找，列表还排序。接着对比两个生产存储调用与合并查询：每类两轮预热、八轮观察，每轮交换先后顺序，均在默认调度下运行；合并查询返回完整 Track 元数据，并逐次核对 ID 和 total。

| 查询 | 列表与计数合计均值 | 单次分页查询均值 |
| --- | --- | --- |
| Track 宽泛匹配 | 156.35 ms | 96.00 ms |
| 中文宽泛匹配 | 150.33 ms | 76.92 ms |
| 中文短词 | 388.75 ms | 74.61 ms |
| 全通配符 | 315.28 ms | 96.33 ms |
| 无关键词，title 排序 | 277.41 ms | 88.12 ms |

这组诊断没有固定硬件/调度条件，也只有八次观察，不能用均值替代正式 30 次 P95。它证明重复匹配可以减少，不能据此声称已查明所有 Windows 调度、温度或电源影响。原始报告另有五次 HTTP 观察，只用于组件定位，不作为正式 HTTP 门槛证据。

## 实现与正确性

HTTP 和 RPC 复用存储 `list_tracks_page_filtered`。内层沿用原候选上限、LIKE 复核、精确筛选与四种排序，`COUNT(*) OVER()` 覆盖全部匹配行后再分页；外层只按该页 rowid 读取完整元数据并恢复相同顺序。没有新增 schema、缓存、owner、线程绑定或搜索额度。队列完整 ID 与单独列表/计数函数继续使用原路径。

非空页的行和总数来自同一 SQL；前置候选查询与空页后的计数回退仍是独立语句，不承诺跨语句事务快照。第一页无行且 limit 非零时 total 为零；越过末尾或 limit 为零时，不能从空窗口推断无匹配，继续准确计数回退。

实现后检查覆盖四种排序、编辑字段/null/空白、大小写与相同时间戳的稳定排序、组合筛选、短词/索引/通配符/空结果、零 limit/负 limit/负 offset/末尾后分页，以及 2000 唯一候选和合并超限两侧。真实回环 HTTP 与 `Rpc::call` 检查同样的响应、筛选总数、空页与原参数限制；这不是原生 DBX 宿主验收。

## 诊断复现与身份

需要已有 Rust、Python/FTS5 和明确的隔离服务产物，不安装模型或依赖，不访问实际来源。构建与临时数据均保存在 D 盘；启动 fixture 时使用 null 音频和内存凭据，不连接用户实例。

```powershell
New-Item -ItemType Directory -Force target/check-tmp,output/benchmarks
$env:TMP = 'D:/code/github/hertz-studio/target/check-tmp'
$env:TEMP = $env:TMP
cargo build --release --locked -p vmusic-store --example profile-search-candidates
# 确认构建成功；HERTZ_BIN 指向另行构建的独立候选，不会连接正在运行的播放器。
$env:HERTZ_BIN = (Resolve-Path target/search-validation/full/hertz-studio.exe).Path
$env:CANDIDATE_PROFILE_OUT = 'D:/code/github/hertz-studio/output/benchmarks/candidate-new.json'
node evals/search/page-v1/profile-driver.cjs
```

报告文件选择新名称，驱动拒绝覆盖已存在的文件。Rust example 只接受已有 `hertz-ui-check-*/data` fixture 目录。可用 `CANDIDATE_PROFILE_BIN` 指定自行构建的 example 产物；不得将用户库伪装成 fixture。实际诊断没有设置 affinity，也未调用真实 provider、账号、模型或音频设备。

[诊断摘要](./diagnostic-summary.json)保留原始/压缩字节 hash、example 二进制及三个源码/依赖文件指纹，均值另从原始样本重算。诊断时的 store 源码指纹与前一组冻结记录一致；测量后才接入新分页函数，不能给旧报告补写新源码指纹。[被测 example 快照](./profile-search-candidates.rs.txt)与报告对应 hash 一致；当前[复现驱动](./profile-driver.cjs)仅增加目录调整、明确产物与输出参数、时间/服务二进制记录，不冒充历史驱动的逐字快照。历史报告缺少的时间/环境字段不补造，环境沿用上组 Windows 工作区，发布资格仍为 false。

首次新 Standard 测量期间，工具源码在构建/测量交接时被修改，末尾指纹复核明确失败。因此[该报告](./invalidated-source-change-standard.json.gz)单独归档为无效证据，[失效摘要](./invalidated-source-change-summary.json)保留原因和字节身份；不提取其性能数字作为通过依据，不覆盖或修写它。后续复测固定工具源码，另选报告名称。

## 新产物的实际复测

使用相同固定 50000 曲/500 编辑语料，分别新建隔离库，Standard 后运行 Full；没有设置 affinity、电源方案或产品额度。每类两轮预热、30 轮计时；四客户端三轮并发与五分钟持续查询单列。每次本地回复核对原独立 LIKE oracle，语料 SHA-256 仍为 `835286f6fed0b719c940132d237047937c6caa99d8364b3d7673866f777999fb`。性能方法沿用[搜索说明](../../../docs/search-performance.md)，以下为新产物的独立记录，运行环境变化意味着不能将先后两组结果当作严格配对的加速倍数实验。

| 指标 | Standard | Full |
| --- | --- | --- |
| 14 类顺序查询最慢 P95 | 208.54 ms | 207.28 ms |
| 原本地 ≤300 ms 门槛 | 通过 | 通过 |
| 四客户端 168 次查询，合并 P95 | 275.78 ms | 234.04 ms |
| 受控 200 ms 快源首结果 P95 | 286.10 ms | 290.90 ms |
| 原首结果 ≤1 秒门槛 | 通过 | 通过 |
| 四客户端持续阶段实际时长 | 300.12 秒 | 300.25 秒 |
| 持续阶段核对通过次数 | 9535 | 8994 |
| 持续阶段合并 P95 | 231.75 ms | 248.43 ms |
| 持续阶段逐类最慢 P95 | 278.73 ms | 291.46 ms |

持续阶段每客户端每次完成后暂停 25 ms，轮换14类查询；这里只报告其本次分布，不另行冻结网络 SearchGate 的额度或新的负载阈值。两版浏览器均验证96次受控来源调用、最多两源在途、快源先可交互、慢源补齐和单源错误保留；没有外部浏览器读取、模型/播放器写入或队列变化。[Standard](./windows-x64-standard-20261018-partial.png) / [Full](./windows-x64-full-20261018-partial.png) 局部结果截图已检查，仅代表受控 DOM 状态。

两版实际服务进程各采集793个内存样本，最大相邻间隔分别680.52 / 682.28 ms；持续阶段各575个样本，另保留前后各十秒空闲及其它阶段。单位为 MiB，工作集表示驻留内存，私有提交量不称为托管堆；采样不包含浏览器、Node驱动与PowerShell采样器：

| 进程内存指标 | Standard | Full |
| --- | --- | --- |
| 负载前空闲工作集中位数 | 23.98 | 38.40 |
| 持续负载工作集峰值 | 52.91 | 62.33 |
| 负载后空闲工作集中位数 | 48.36 | 60.17 |
| 负载前空闲私有提交量中位数 | 13.53 | 14.22 |
| 持续负载私有提交量峰值 | 43.96 | 39.52 |
| 负载后空闲私有提交量中位数 | 39.19 | 37.50 |

负载后空闲内存仍较之前增加，本轮没有证明长期稳定或排除泄漏，也没有冻结内存预算。缓存、连接池、分配器与真实泄漏仍需更多加载/空闲周期定位，不以耗时通过替代内存验收。

## 产物与复核

两版 release 构建分别保存于 `target/search-validation/page-v1/{standard,full}/hertz-studio.exe`，命令仍为 `cargo rustc --release --locked -p hertz-studio --bin hertz-studio` 加明确 `-o`；Full另加`--features full`。环境为Windows 10.0.26200、i7-13620H、16逻辑核、约32GiB内存、Node22.14.0、rustc1.98.1，HEAD `401a90376c0fa8391b5d60234103eeb381ef2c2c` 加未提交改动。精确版本、Chrome、内嵌资源、源码/锁文件/二进制指纹在原始报告中；不是已发布版本或冻结候选包结论。

完整复现沿用[双版命令](../editions-v1/README.md#环境与复现)，构建输出改用上述两个新目录，`SEARCH_BENCH_OUT`选择新的D盘文件；保持`SEARCH_BUILD_PROFILE=release`、`SEARCH_EXPECT_EDITION`分别指定两版、`SEARCH_SUSTAINED_SECONDS=300`、`SEARCH_PROCESS_MEMORY=1`以及D盘TMP/TEMP。测量期间保持所记录的源码与工具不变。当前工具会在服务启动前拒绝覆盖既有报告或截图，相关拒绝行为已实际检查。

[Standard原始JSON](./windows-x64-standard-20261018.json.gz) / [Full原始JSON](./windows-x64-full-20261018.json.gz)经独立工具重算计时、四客户端序号与各内存阶段统计，核对源码、二进制和截图指纹，两版均返回0。[摘要](./summary.json)保留上述原文/压缩hash、全部重新计算结果及十二份[构建/验证日志](./validation/)的字节hash。当前报告额外覆盖RPC library源码；历史报告不补写这个新字段。

```powershell
node scripts/check-search-evidence.js evals/search/page-v1/windows-x64-standard-20261018.json.gz target/search-validation/page-v1/standard/hertz-studio.exe --current
node scripts/check-search-evidence.js evals/search/page-v1/windows-x64-full-20261018.json.gz target/search-validation/page-v1/full/hertz-studio.exe --current
```

实现后存储库52项、Hertz Standard421项/Full578项通过，另4/6项按既有条件忽略；两版全target Clippy与Rust1.88.0工作区全target编译通过；格式、285项ADR契约和前端57步通过，后者包含新增历史舞台fixture。检查使用隔离数据和null音频，实际源码/产物仍须随未来发布候选重跑。临时服务和fixture目录已由owner回收。

更长在线SearchGate混合压力及其RSS、长期重复加载/空闲、真实来源/弱网、弱机、其它OS、原生DBX、后台扫描/写入竞争与冻结发布候选仍需分别验收。诊断与两份正式报告均保持`releaseEligible:false`。
