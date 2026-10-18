# R0 / R1-S 固定搜索基线 v1

本机 Windows Standard、独立服务、null 音频后端的合成测量。实际本地 HTTP 查询与真实 Chrome UI 使用生产入口；在线来源响应是明确 fixture，不是实际 provider、服务端搜索闸压力或原生 DBX 验收。完整方法与修复依据见[搜索性能说明](../../../docs/search-performance.md)。路线图及发布验收尚未完成。

后续[分页匹配与总数合并查询的独立复测](../page-v1/README.md)已在默认调度下通过两版本地与受控首结果门槛；本文件历史数据与失败状态保留原样，长期内存及完整发布矩阵仍未通过。

## 复现

需要已有 Node.js、Python（SQLite 支持 FTS5 trigram）、Chrome 和 Playwright。Playwright 使用仓库现有的浏览器检查方式，可用 `PLAYWRIGHT_MODULE` 指向已安装的包；本脚本不安装依赖。只使用临时曲库与回环端口，关闭时清理自己创建的服务及临时目录，不连接用户实例。

```powershell
cargo test --locked -p vmusic-store --lib
cargo rustc --release --locked -p hertz-studio --bin hertz-studio -- -o target/review-bin/hertz-perf.exe
# 先确认构建成功。以下路径以 Windows 为例，使用刚构建的隔离产物。
$env:HERTZ_BIN = (Resolve-Path target/review-bin/hertz-perf.exe).Path
$env:SEARCH_BUILD_PROFILE = 'release'
$env:SEARCH_BENCH_OUT = 'output/benchmarks/search-local.json'
# 若 require('playwright') 不可用，另设 PLAYWRIGHT_MODULE 指向已有安装。
# PYTHON 可指定有 FTS5 trigram 的 Python 可执行文件。
node scripts/benchmark-search.js
```

输出保留全部原始计时、total/有序 ID 的独立 oracle、数据集/源码/锁文件/可执行文件 SHA-256、版本、CPU/内存、浏览器及内嵌资源版本。脚本在结束前复核相关源文件和二进制未变化；阈值未过或执行失败仍保存已收集的记录并返回非零。未收集的字段不视为通过。`buildProfile` 由调用者声明，须和实际构建命令一起审阅；本记录实际使用上述 `--release` 命令，未触及用户正在运行的开发程序。

默认阈值沿用原路线：14 类查询分别取 P95 ≤300 ms，受控 200 ms 快源的第一可点播结果 P95 ≤1000 ms。固定两轮预热、每类 30 次计时，不丢弃较慢样本；四客户端压力单列，不与顺序目标混合。界面检查要求可见、命中测试通过的结果行和未禁用试听动作；不点击播放、修改队列或调用模型。所有来源每轮只查一次，UI 最多两个在途读。

## 冻结语料与实际结果

[生成器](./corpus.py) 固定 50000 条虚构曲目、500 条用户编辑，索引由原迁移和触发器建立。SHA-256 为 `835286f6fed0b719c940132d237047937c6caa99d8364b3d7673866f777999fb`。中文/短词/通配符/空结果/宽泛词/覆盖/trim/精确筛选与排序均纳入；每一次实际调用与未使用 FTS 的 LIKE oracle 核对 total 和前 20 个 ID。JSON 管道使用 ASCII 转义，避免 Windows GBK stdout 改坏查询字符；数据哈希仍按规范 UTF-8 内容计算。

保留[修复前记录](./windows-x64-20261018-before.json)与[修复后记录](./windows-x64-20261018-after.json)。使用 Windows `10.0.26200`、Intel Core i7-13620H、16 逻辑核、约 32 GiB 内存、Node 22.14.0；当前候选编译器为 rustc 1.98.1，Chrome 版本见报告。Python 3.13.2 / SQLite 3.45.3 只生成数据与 oracle；实际查询由 Rust 服务使用锁定的 bundled SQLite 执行。

| 指标 | 修复前 P95 | 修复后 P95 |
| --- | --- | --- |
| 宽泛 ASCII `Track`，49500 命中 | 492.13 ms | 139.92 ms |
| 14 类查询中最慢的 P95 | 492.13 ms，未通过 300 ms 目标 | 139.92 ms，全部通过 |
| 中文宽泛命中 | 153.11 ms | 127.05 ms |
| 四客户端并发，168 次查询 | 465.24 ms | 151.85 ms |

最终严格浏览器检查的首个可点播结果 P95 为 **227.20 ms**；30 个测量查询、两个预热查询共 96 次受控来源调用，最高在途读 2 个。快源已有 3 条可交互结果时慢源仍未返回；随后两个成功来源共 6 条结果，失败来源单独显示。该阶段另发出的 30 次真实本地 HTTP 搜索 P95 为 144.13 ms。局部结果[截图](./windows-x64-20261018-partial.png)保留，哈希与最终报告一致。

修复前的工具尚未加入最终的行可见性/命中测试和具体试听动作检查，也少了若干环境字段；修复前后表格只比较相同语料、方法和采样量的本地 HTTP 阶段，不将早期浏览器字段视为同等严格验收。两份原始结果如实保留原工具 hash，不补写或伪造历史字段。

当前源码为 HEAD `401a90376c0fa8391b5d60234103eeb381ef2c2c` 加未提交改动，不是该提交或已发布版本的结论。修复后测量产物 SHA-256 为 `5689e923b919fce18c946584ea8273e9b1194a4824f6b846e47f304b044557fd`，内嵌 UI 资源版本 `5b69fd38cfe7a9f9`。源码、工具和依赖的原始字节 hash 在报告中；更换换行也会改变它们。历史报告用于追溯这一候选，后续代码/依赖/环境改变需重新测量。

本组历史记录没有磁盘冷缓存、后台扫描与写入竞争、Full 独立计时、实际来源/弱网、原生 DBX、弱机、其它 OS、真实账号或声音的结论。后续[双发行版与五分钟本地负载记录](../editions-v1/README.md)另行保留：Standard 顺序查询达标，Full 本次未达标；两版均有实际服务进程内存采样，不能据此认定内存稳定或路线图完成。不能将合成元数据代表性推广到全部真实曲库，也不从一台机器的结果冻结服务端额度。两份报告均保留 `releaseEligible:false`。
