# 双发行版五万曲、持续本地查询与进程内存记录

2026-10-18，Windows 独立 release 服务、null 音频、内存凭据；Standard 后运行 Full，各自使用新建合成曲库。构建、临时数据和输出均在 D 盘，不覆盖开发播放器，不读取用户曲库、凭据或实际来源，不调用模型。方法及候选 SQL 修复见[搜索性能说明](../../../docs/search-performance.md)，历史修复前后结果见[原 v1](../v1/README.md)。**本轮 Full 本地计时失败，路线图与发布验收仍未完成。**

后续[分页匹配与总数合并查询的独立复测](../page-v1/README.md)已在默认调度下通过两版本地与受控首结果门槛；本文件历史数据与失败状态保留原样，长期内存及完整发布矩阵仍未通过。

## 实际结果

| 指标 | Standard | Full |
| --- | --- | --- |
| 14 类 ×30 次顺序查询，最慢类别 P95 | 124.18 ms，通过 300 ms 门槛 | 720.44 ms，未通过 |
| 四客户端 ×3 轮，共 168 次，合并 P95 | 159.19 ms | 435.05 ms |
| 受控 200 ms 快源首个可交互结果，30 次 P95 | 274.60 ms，通过 1 秒门槛 | 290.60 ms，通过 |
| 四客户端持续本地查询实际时长 | 300.21 秒 | 300.68 秒 |
| 持续阶段核对通过的查询数 | 11206 | 5275 |
| 持续阶段全部类别合并 P95 | 256.43 ms | 397.67 ms |
| 持续阶段最慢类别 P95 | 374.68 ms | 457.08 ms |
| 实际服务进程内存采样数 | 777 | 1012 |
| 最大相邻内存采样间隔 | 953.19 ms | 751.91 ms |

每次本地调用均与独立 LIKE oracle 核对 total 与前 20 个有序 ID。持续阶段每客户端完成查询后暂停 25 ms，轮换全部 14 类，不隐去慢样本；其混合分布不能替代逐类门槛。300 ms 原目标针对顺序查询，不能将 Standard 的顺序达标推广为持续负载也逐类达标。Full 的失败保留在原始报告 `failure` 与 `gates.local:false` 中，不重写门槛。

两版浏览器均检查 32 个关键词、96 次受控来源调用、最多两个在途读、快源先可交互、慢源后补齐、单源错误保留、无模型/播放写入、无外部浏览器读取及队列不变。截图 [Standard](./windows-x64-standard-20261018-partial.png) / [Full](./windows-x64-full-20261018-partial.png) 已检查；它们只记录局部结果阶段，不代表真实来源、声音或 GPU 性能。

## 进程内存口径

采样对象仅为本轮 fixture 启动的 Hertz 服务 PID，独立核对开始身份；不枚举其它进程，不计 Node 驱动、Chrome 和 PowerShell 采样器。WorkingSet64 是驻留工作集，PrivateMemorySize64 是私有提交量，不能称为托管堆。500 ms 为请求间隔，实际间隔和所有原始样本保留。两段空闲各等待十秒；内存中位数取排序后 `floor(n/2)` 项，耗时 P50/P95 则为最近秩，两种口径明确分开。

单位为 MiB（1048576 字节）：

| 实际服务进程指标 | Standard | Full |
| --- | --- | --- |
| 负载前空闲工作集中位数 | 37.98 | 38.94 |
| 五分钟负载工作集峰值 | 58.32 | 57.96 |
| 负载后空闲工作集中位数 | 56.00 | 56.24 |
| 负载前空闲私有提交量中位数 | 15.59 | 14.81 |
| 五分钟负载私有提交量峰值 | 37.62 | 34.91 |
| 负载后空闲私有提交量中位数 | 34.95 | 33.38 |

负载后空闲两项内存均高于负载前。记录不足以区分页缓存、连接池、分配器保留与泄漏，也未冻结内存预算；`observed:true` 只代表实际采样覆盖充分，不表示内存验收通过。更长的重复加载/空闲周期、真实网络混合负载下整个进程 RSS 仍需单独验收。

## 环境与复现

Windows 10.0.26200、Intel Core i7-13620H、16 逻辑核、约 32 GiB 内存、Node 22.14.0、rustc 1.98.1。HEAD `401a90376c0fa8391b5d60234103eeb381ef2c2c` 加未提交改动。精确环境、二进制、源码/锁文件指纹、浏览器版本及资源版本在各原始报告中；这不是已冻结的发布候选。固定语料 SHA-256 为 `835286f6fed0b719c940132d237047937c6caa99d8364b3d7673866f777999fb`。

从 D 盘工作区运行，需要现有 Python/FTS5、Chrome、Playwright 和 PowerShell，不安装依赖。以下输出文件应选择新的名称，保留旧证据：

```powershell
New-Item -ItemType Directory -Force target/check-tmp,target/search-validation/standard,target/search-validation/full,output/benchmarks
$env:TMP = 'D:/code/github/hertz-studio/target/check-tmp'
$env:TEMP = $env:TMP
cargo rustc --release --locked -p hertz-studio --bin hertz-studio -- -o target/search-validation/standard/hertz-studio.exe
# 确认 Standard 构建成功后再构建 Full，分别保留产物。
cargo rustc --release --locked -p hertz-studio --bin hertz-studio --features full -- -o target/search-validation/full/hertz-studio.exe
# 确认 Full 构建成功，再运行；不要在计时期间并行构建或更改被指纹覆盖的文件。
$env:SEARCH_BUILD_PROFILE = 'release'
$env:SEARCH_SUSTAINED_SECONDS = '300'
$env:SEARCH_PROCESS_MEMORY = '1'
$env:POWERSHELL = (Get-Command pwsh.exe).Source
# 若 require('playwright') 不可用，PLAYWRIGHT_MODULE 指向已有安装。
$env:HERTZ_BIN = (Resolve-Path target/search-validation/standard/hertz-studio.exe).Path
$env:SEARCH_EXPECT_EDITION = 'standard'
$env:SEARCH_BENCH_OUT = 'output/benchmarks/search-new-standard.json'
node scripts/benchmark-search.js
# 保留 Standard 的退出状态与报告，再独立运行 Full。
$env:HERTZ_BIN = (Resolve-Path target/search-validation/full/hertz-studio.exe).Path
$env:SEARCH_EXPECT_EDITION = 'full'
$env:SEARCH_BENCH_OUT = 'output/benchmarks/search-new-full.json'
node scripts/benchmark-search.js
```

实际本轮 Playwright 使用已安装的 Codex runtime 包，未下载浏览器；PowerShell 为 pwsh。`buildProfile` 由调用者声明，需同时核对以上实际构建日志，不能仅凭字段证明优化级别。Full 本次命令返回 1，报告仍完整保留。临时服务和 DataDir 由 fixture 自行回收。

## 默认调度与同核交替诊断

首次 Standard 后段吞吐也下降；不能只凭先后运行的两份报告断定 Full 代码更慢。随后使用同一两版二进制、各自新的固定语料，交替执行每一类查询，并逐轮交换先后顺序；两轮预热、五轮观察，每版 98 次。两次诊断都逐次核对 oracle，完整保留 [默认调度](./crosscheck.json.gz)与[同一逻辑核](./crosscheck-pinned.json.gz)的原始耗时。

| 五轮均值，仅用于诊断 | 默认 Standard / Full | 同核 Standard / Full |
| --- | --- | --- |
| 宽泛 ASCII | 304.18 / 641.49 ms | 225.80 / 239.91 ms |
| 中文短词 | 552.58 / 517.38 ms | 149.59 / 150.41 ms |
| 通配符 | 562.84 / 568.30 ms | 168.53 / 170.96 ms |

默认调度时两版都出现慢查询，同核后两版接近，说明线程放置/运行条件是需要继续定位的变量；这些观察不足以认定具体 Windows QoS、温度、电源或某段产品代码是唯一原因。只对自己创建的两个 fixture PID 设置同核 affinity，退出即结束，没有改变系统电源设置、用户播放器或产品默认行为。不能用五次均值、固定核条件或这次诊断替代原 30 次 P95，更不据此豁免 Full 失败。后续仍需在默认条件下查明并解决持续达标问题。

[诊断复现驱动](./crosscheck.cjs)是加入可选同核模式后的版本，归档时仅调整根目录/输出路径及可选二进制参数；不是原计时报告的来源指纹。两份诊断二进制身份和逐轮样本已独立核对，文件 hash 与重算均值保存在摘要中。可用 `SEARCH_STANDARD_BIN` / `SEARCH_FULL_BIN` 指定产物，`SEARCH_CROSSCHECK_OUT` 指定新的 D 盘输出，`SEARCH_CROSSCHECK_PIN=1` 开启同核诊断；缺省为默认调度。沿用上节 D 盘 TMP/TEMP 后运行：

```powershell
node evals/search/editions-v1/crosscheck.cjs
```

## 原始记录与独立复核

压缩原始 JSON：[Standard](./windows-x64-standard-20261018.json.gz) / [Full](./windows-x64-full-20261018.json.gz)。[摘要](./summary.json)保留原文/压缩文件 hash、二进制/源码/截图指纹、环境、重新计算的计时和全部内存阶段统计。

[独立复核工具](../../../scripts/check-search-evidence.js)从原始样本重算分位数、四客户端顺序/序号、持续查询逐类分布及内存中位数/峰值/间隔/空闲差额，核对截图；`--current` 另核对当前磁盘源码，可选二进制参数核对产物。它不重放 HTTP，正确性结论来自测量时的每次 oracle 断言；未来源码改变后指纹不符是预期，不能补写历史报告。

```powershell
node scripts/check-search-evidence.js evals/search/editions-v1/windows-x64-standard-20261018.json.gz target/search-validation/standard/hertz-studio.exe --current
node scripts/check-search-evidence.js evals/search/editions-v1/windows-x64-full-20261018.json.gz target/search-validation/full/hertz-studio.exe --current
```

工具退出 0 表示报告完整且两个计时门槛通过，退出 2 表示报告完整但性能目标未过，退出 1 表示记录不完整或校验不符。本轮分别为 0 / 2；没有把 Full 的完整报告当成性能通过。实现后另核对七种篡改被拒绝，以及性能未过的明确分类。

本轮五分钟阶段是本地曲库 HTTP 查询，不经过在线 SearchGate；不能替代[六十秒网络混合探针](../pressure-v1/README.md)，也未完成更长网络压力、真实 provider/弱网、后台扫描/写入竞争、弱机、原生 DBX、其它 OS 或真实声音/模型验收。两份报告均保持 `releaseEligible:false`。
