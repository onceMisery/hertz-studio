# R0 / R1-S 搜索性能基线

本基线落实产品路线 §8.1 的两项测量：五万曲本地搜索 P95 ≤300 ms，以及受控 200 ms 上游下首个可点击结果 P95 ≤1 秒。它不替代真实来源、弱网、原生 DBX、弱机或跨平台验收，也不据此宣布 R0 / R1-S 完成。

## 本地查询修复

五万曲端到端测量发现，原候选 SQL 的末尾 `LIMIT 2001` 只限制 UNION 的返回条数。SQLite 仍先将三个索引分支的全部命中放入去重临时表，宽泛词命中很多曲目时，预筛成本加在后续完整 LIKE 回退之前；列表和 total 计数都会经历这一过程。本机 release 的宽泛 `Track` 查询 P95 为 492.13 ms，未达到既定 300 ms 目标。

当前把相同上限下推到 title/artist/album 三个独立 trigram 索引分支，再 UNION 去重并应用最终上限。最多有 `3 × 2001` 个候选行进入该临时表；这限制的是 UNION 的候选输入量，不承诺整个 FTS 查询或索引访问为恒定工作量。

正确性依据：如果任一列超过 2000 个不同 rowid，仅该列的前 2001 个就能证明应该回退；否则三个分支均完整，合并后的唯一 rowid 数决定是否回退。因此不会截断有效结果，也不会把同一曲目的跨字段命中重复计数。超过阈值仍走原 LIKE，短词、通配符、覆盖列、筛选、排序和分页语义保持原契约，HTTP、RPC 和完整队列 ID 查询均经过同一存储函数。

存储回归验证列内溢出、跨列各自未满但合并超限、恰好 2000 条的三列重复命中、原 LIKE 等价及实际生产 SQL 的索引计划。没有新增 API、schema、缓存或用户配置。

## 分页列表与总数共用一次匹配

双发行版持续测量暴露默认调度下的慢查询后，先核对实际 SQL 计划及 sqlx 边界。候选逐行传输与单行 JSON 聚合的交替测量仅相差约一毫秒，不能解释数百毫秒的慢查询，因此保留原候选读取。原 HTTP/RPC 每页分别调用列表和计数，各自预筛、扫描并关联编辑表，实际计划确认了重复工作。

当前两入口共用 `list_tracks_page_filtered`：内层保留原预筛/LIKE/精确筛选、四种排序及参数语义，通过 `COUNT(*) OVER()` 同时计算全部匹配行的总数，再分页；外层只为该页 rowid 点查完整元数据并重用原排序。元数据、编辑覆盖及队列 ID 入口沿用原 owner，不新增缓存、迁移、线程 affinity 或服务端额度。非空页的行和总数来自同一 SQL 语句；前置候选读取仍是独立查询，不宣称整个搜索已成为一个跨语句事务。

第一页无行且 limit 非零可直接确定总数为零；offset 已越过末尾或 limit 为零时，窗口无行不能证明曲库为空，仍走原准确计数回退。回退也是独立查询，不承诺与之前的空页具有相同数据库快照。已在实现后核对编辑/null/空白、四种排序、组合筛选、分页边界与候选阈值两侧；真实 HTTP/RPC 与新产物计时另行验收，不沿用历史二进制成绩。

## 固定合成曲库与正确性

[生成器](../evals/search/v1/corpus.py) 只接受隔离 fixture 的新临时库，拒绝非空曲库及普通数据目录。使用实际服务迁移建库、现有写入触发器建立 trigram 索引，注入 50000 条中英文元数据与 500 条用户标题覆盖，不扫描真实文件。固定时间、ID 和内容，记录逐条规范 JSON 的 SHA-256；不读取用户曲库或凭据。

14 类查询覆盖罕见 ASCII、中文、两字短词、通配符、宽泛命中、空结果、用户覆盖、内部空格、输入 trim、精确歌手/专辑筛选及空搜索 added 排序。独立的原始 LIKE 查询生成 total 和前 20 个有序 ID，不调用生产查询构造器或 FTS 预筛。每一次测量都核对结果；HTTP elapsed 包含等待响应和 JSON 解码，断言执行在计时之后。

每类先记录一次“首次观察”，另做两轮预热和 30 轮计时；轮内轮换查询顺序。首次观察仍使用刚创建并访问过的数据库，不称为 OS/磁盘冷缓存。单独的四客户端压力阶段每客户端三轮，保留每个客户端/查询的样本，不混入顺序目标的统计。P50/P95 使用最近秩 `ceil(n*p)`，同时保留全部原始样本与最大值。

## 受控来源与真实浏览器

真实 Chrome 加载隔离服务内嵌的 UI，通过原 Online 与 HertzSearch owner 执行聚合。快源等待 200 ms、慢源 1200 ms、失败源 50 ms 后返回 503；来源响应由 Playwright 拦截，不是实际 provider 或服务端 SearchGate 压测。每次使用新关键词避免 UI 查询缓存，两个预热查询后测 30 个查询。

从真实搜索按钮 click 事件开始计时，MutationObserver 观察结果，下一次 requestAnimationFrame 中确认第一行通过可见性检查、行内位置命中测试，且确有未禁用的试听动作，再记录时间。在线行本身支持点击/键盘点播，右侧按钮沿用 hover 显示，不把其它行内按钮当成试听动作。该测量证明 DOM 已有可交互目标，不证明物理显示器像素已呈现，也不实际点击播放。快源可交互时慢源仍在等待；随后验证慢源结果和单源错误保留，三源每次各一次调用、最多两个在途读。计时期间另有本地 HTTP 搜索，独立记录其延迟。

阻断浏览器第三方读取及所有播放/模型提交，核对没有这些调用、页面异常或队列变更；服务使用 null 音频后端和隔离内存凭据。后台 provider 相关 UI 读取也由 fixture 接管，不调用真实在线来源。该基线不验证声音、模型、会员账号或真实 GPU 帧性能。

## 运行与证据

复现命令、环境、源码/依赖/二进制身份、修复前后原始结果及未验范围见[固定基线记录](../evals/search/v1/README.md)。性能探针是显式本机检查，避免把无固定硬件的共享 CI 抖动当成产品回归；源代码的结果/阈值边界和索引计划仍由普通存储测试覆盖，JS 语法也进入既有前端聚合检查。

历史修复前后基线仅覆盖 Windows Standard。后续[双发行版记录](../evals/search/editions-v1/README.md)已补 Standard / Full 独立五万曲计时、五分钟本地 HTTP 查询和实际服务进程内存采样：Standard 顺序查询达标，Full 本次最慢 P95 720.44 ms 未达标；两版受控首结果均达标。交替/同核诊断显示调度条件显著影响耗时，不用诊断成绩替代默认条件验收。随后[分页修复的新产物复测](../evals/search/page-v1/README.md)在默认调度下两版顺序本地与受控首结果均过原门槛，持续五分钟逐类P95也已单列；原Full失败和工具变化导致的失效轮次均保留。长期内存、原生 DBX、其它 OS、弱机、真实账号/网络、后台扫描/写入竞争及真实元数据分布仍需独立记录。UI 的两源并发与服务端 4 执行/16 等待/2 秒入场等待/6 秒总期限继续是候选额度，不因本项测量自动冻结。

## 服务端共享额度的显式压力探针

`online::search_pressure::sustained_shared_search_budget` 是默认忽略、手动运行的服务端探针。它在隔离数据库与 null 音频下启动实际 HTTP 路由和回环上游，RPC 直接调用同一 `Rpc::call`；四种调用是 HTTP 单源、RPC 单源、HTTP 旧聚合和 RPC 旧聚合，共用同一 AppState 与原 SearchGate。测试限定的 task-local 入口只替换 registry 中已登记 provider 的网络读取，执行原 JSON 读取器；没有运行平台特有协议/归一化、实际 DBX stdio 或浏览器 UI，也不访问真实来源与凭据。该入口不编译进产品。

探针先占满四个执行槽，让 HTTP/RPC 单源等待者实际经历两秒入场超时，核对它们没有到达上游；再占满十六个等待席，核对额外请求立即返回有来源与 request_id 的 `search_busy`。取消混合调用后等待全部槽位和已转发 socket 结束。分别令四个上游停在响应头之前、响应体中途，检查六秒总期限与恢复。随后每波三十二个客户端混用四种入口，包含正常结果、503、在途取消和超额排队；每波核对全部执行/等待槽回收、上游结束、聚合未丢源及请求身份，最后再发成功查询。观测只覆盖本机受控负载，不能据此承诺远端 handler 或推理被取消。

本地执行计数由 provider future 内的 RAII guard 持有，覆盖实际网络读取和结果解析，future 结束或丢弃时才减一，峰值须不超过四。上游 socket handler 的计数独立记录：取消后的 EOF 可能晚于本地 future 结束才被远端处理，因此它的短暂峰值不等同本地执行并发。每波要求两种计数都归零，并核对已读取请求数等于完整回复与已观察断开数之和；不能只看 semaphore 余额就宣称没有脱管 I/O。

```powershell
$env:VMUSIC_BACKEND = 'null'
$env:VMUSIC_SECRETS = 'memory'
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_PROFILE_TEST_DEBUG = '0'
$env:TMP = 'D:/code/github/hertz-studio/target/search-pressure/tmp'
$env:TEMP = $env:TMP
New-Item -ItemType Directory -Force $env:TMP, output | Out-Null
# 选择尚不存在的报告文件；不会覆盖旧证据。
$env:HERTZ_SEARCH_PRESSURE_REPORT = 'D:/code/github/hertz-studio/output/search-pressure-standard.json'
cargo test --locked -p hertz-studio --lib online::search_pressure::sustained_shared_search_budget --target-dir D:/code/github/hertz-studio/target/search-pressure -- --ignored --nocapture --test-threads=1
$env:HERTZ_SEARCH_PRESSURE_REPORT = 'D:/code/github/hertz-studio/output/search-pressure-full.json'
cargo test --locked -p hertz-studio --lib online::search_pressure::sustained_shared_search_budget --features full --target-dir D:/code/github/hertz-studio/target/search-pressure -- --ignored --nocapture --test-threads=1
```

目标目录须已可写，报告父目录须存在，已有报告在数据目录和服务启动前拒绝。默认一轮六十秒；显式 `HERTZ_SEARCH_PRESSURE_LONG=1` 切换为三轮各两分钟，负载前和每轮结束各空闲十秒，总工作期限九分钟。两种模式均使用固定原额度，最多保留 65536 条紧凑记录；观测存储在基线前分配，最后一次空闲后才转为 JSON，减少探针自身逐条 JSON 分配对内存趋势的干扰。服务、客户端驱动和受控上游仍在同一测试进程，不能称为生产服务的独立内存。

报告记录逐调用原始耗时/状态、每轮恢复与阶段时间、本地执行与上游 socket 各自的峰值、上游已回复/断开与最终空闲额度、发行版、编译器和测试二进制 hash。相关源码字节嵌入测试产物，运行前后均与磁盘核对，防止源码变化后给旧产物补写新指纹。这里的 test profile 不等于 release 性能基线。另有双发行版 release 服务的五分钟本地曲库查询/工作集与私有提交量记录，但它不经过在线 SearchGate，也不代表内存预算已通过。

历史 Windows Standard / Full 的六十秒混合阶段分别完成 4032 / 4128 次客户端调用（含 busy 与取消），本地执行峰值均为四，每波回收执行槽、等待席和已转发连接；响应体实际超时约六秒，最后查询继续成功。原始逐调用记录、独立对账与统计口径见[受控压力归档](../evals/search/pressure-v1/README.md)。不把上游关闭观察峰值或聚合外层 200 解释为本地执行数、所有来源成功或实际用户体验达标。

## Windows 长时混合压力与测试进程内存

`scripts/run-search-pressure.js` 显式运行已构建的库测试产物，并用独立 PowerShell 进程每 500 ms 只采样该 PID。保留工作集、私有提交量、虚拟内存、句柄、线程和原始 JSONL；不把 Node 驱动及 PowerShell 采样器计入该 PID，但测试二进制自身的负载驱动与回环上游会计入。Windows 工作集不是 PSS，也不把私有提交量称为实际驻留内存。

阶段按探针 stdout 的接收时间关联，报告同时保存探针单调时钟与 Node 接收时钟，独立复核阶段交付偏差和最大采样间隔。每轮负载与空闲各自统计，不把结束后的 JSON 序列化/清理阶段并入空闲基线。未冻结内存预算，也没有自动强制 GC 或降低工作量来取得回落；十秒空闲窗口和单次三轮记录不足以证明无泄漏。

在上述环境变量下，先构建并选择库测试可执行文件；Full 需独立增加 `--features full`，报告文件也另取名字。构建和两版测量顺序执行，测量期间不编辑带指纹的文件。

```powershell
$artifacts = cargo test --locked -p hertz-studio --lib --no-run --message-format=json --target-dir D:/code/github/hertz-studio/target/search-pressure
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
$probe = $artifacts | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object {
    $_.reason -eq 'compiler-artifact' -and $_.target.name -eq 'hertz_studio' -and $_.profile.test -and $_.executable
}
node scripts/run-search-pressure.js --binary $probe.executable --out output/search-pressure-long-standard.json --long
if ($LASTEXITCODE -ne 0) { throw 'Probe failed; preserve its report and sidecars' }
node scripts/check-search-pressure-evidence.js output/search-pressure-long-standard.json $probe.executable --current
```

运行器在启动前拒绝任何已存在的报告或附属文件；中途失败保留失败记录、探针日志和已采样数据，不覆盖成“通过”。独立复核器重新计算逐波/逐客户端身份、四入口状态分布、三轮时长、槽位与上游对账、PID/原始采样/阶段中位数和文件身份。生产服务的独立混合负载 RSS、真实网络、长期稳定性、弱机、实际 DBX 宿主和跨 OS 仍分别待验。

当前两版各三轮负载与独立复核通过，完成24416 / 25184次调用、各799条测试进程内存采样，详见[长时压力归档](../evals/search/pressure-v2/README.md)。最终空闲私有提交量较前置分别增加约6.08 / 5.92 MiB，没有无泄漏结论。固定过载中Full HTTP单源没有成功回复，聚合外层200不等于所有来源成功；本记录证明本轮结构额度、期限和回收，不证明四入口有效吞吐、公平性或用户体验达标。

## 四入口均衡吞吐与 gate 决策

schema 6 在相同的生产 `SearchGate` 上增加 60 秒匀速探针：HTTP/RPC 单源和 HTTP/RPC 聚合各提供 16 次底层 source 操作/秒。Standard 启用 2 个 fixture source，Full 启用 8 个；聚合外层每秒分别为 8 次和 2 次，因此四入口合计均为 64 次 source 操作/秒。HTTP 经过实际 Axum 路由；RPC 直接调用 `Rpc::call`，没有 DBX stdio transport。网络响应来自回环 fixture，但会执行已登记 provider 的解析路径；没有访问真实来源、账号或凭据。

Windows x64、Rust 1.88.0 的 test profile 中，Standard 四入口 source 成功率为 65.0%、58.75%、47.71%、42.5%，Full 为 69.38%、75.31%、48.02%、26.15%（顺序均为 HTTP 单源、RPC 单源、HTTP 聚合、RPC 聚合）。全部失败的 source code 都是 `search_busy`，两版本地执行峰值为 4，结束时额度均恢复为 `[4, 16]`。聚合外层响应为 200 只表示完整返回了逐来源结果；其中部分 source 以 `search_busy` 失败。每入口 scheduled-to-response P95 约为 0.94–1.08 秒。Full 的 RPC 聚合在本轮明显低于其它入口，但一轮直接 `Rpc::call` fixture 测量不足以把差异归因于生产 transport 或作为容量目标。

Full v5 按注册顺序派发时，HTTP 聚合逐 source 成功率从 100% 递减到 21.7%，RPC 聚合从 69.2% 递减到 0.8%。v6 source 起始顺序轮换后，同类范围分别收敛到 35.8–61.7% 和 20.8–32.5%；Standard 两个 source 的聚合成功率也更接近。该单轮观察支持保留 source 顺序轮换，但不证明它提升了总吞吐：Full HTTP 聚合总体成功率由 v5 的 68.23% 降到 v6 的 48.02%，各版都没有重复轮次或真实 provider 对照。

**Gate 保持 4 执行、16 等待、2 秒入场等待、6 秒总期限，不在本轮冻结候选值。** 探针把四类入口同时压到 64 source 操作/秒，观测到的饱和与 `search_busy` 是预期的有界拒绝信号；它没有给出真实用户到达率、真实 provider 并发/限流行为或可接受的 source 成功率 SLO。扩大并发可能增加真实来源拒绝，因此当前证据不能决定安全的新容量。需要先取得真实 provider 与 DBX transport 负载、定义目标成功率/延迟，再按同一来源分布复测。逐调用结果、source 失败码、内存采样、源码和二进制指纹见[pressure-v6 记录](../evals/search/pressure-v6/README.md)；本 test-process 内存不代表生产服务 RSS，release eligibility 仍为 false。

pressure-v7 在修正入口索引循环后以相同负载复测 Standard / Full，独立核验当前源码和二进制指纹通过。四入口成功率依次为 Standard 67.40% / 59.90% / 52.81% / 46.15%，Full 71.04% / 74.27% / 49.38% / 22.81%；所有失败仍为 `search_busy`，执行峰值为 4 且容量恢复到 `[4, 16]`。这轮固定过载仍没有真实来源、正式 DBX 主机或用户 SLO，因此 gate 继续保持候选值；证据见[pressure-v7 记录](../evals/search/pressure-v7/README.md)。

pressure-v8 在隔离 D 盘 target 上为 Standard / Full 各重建同一探针二进制并各重复两轮。四轮源码与二进制指纹复核通过；Full RPC 聚合 source 成功率稳定在 31.25%–32.40%，明显低于同版 HTTP 聚合的 64.90%–66.88% 和单源入口的 84.06%–86.88%；Standard 各入口在两轮间波动更明显。所有失败仍是 `search_busy`，且执行槽、回环连接及 `[4,16]` 容量都恢复。该差异说明受控过载的结果依赖入口形状，但无法据此推出真实 provider 的安全并发值；gate 继续保持候选，等待真实 provider/DBX 测量与用户 SLO。原始报告和复核命令见[pressure-v8](../evals/search/pressure-v8/README.md)。

pressure-v9 的 schema 7 / schedule version 2 保持相同 offered load，但让单源与聚合两组的 HTTP/RPC 入口按每个配对时间窗交替先后，并由独立校验器逐条复算计划时间。Standard 两轮入口成功率为 72.40/55.31/53.85/54.90% 和 85.42/50.73/68.96/63.23%；Full 为 88.23/71.88/48.54/59.38% 和 88.13/68.44/50.00/60.73%（顺序均为 HTTP 单源、RPC 单源、HTTP 聚合、RPC 聚合）。v8 中 Full 的 HTTP 聚合优势在交错调度后反转，RPC 聚合高出 10.83/10.73 个百分点；Standard 重复间波动仍明显。四轮失败均为 source 级 `search_busy`，执行峰值四且结束后容量恢复 `[4,16]`。调度对照证明此前入口差异会受固定时序影响，但回环 fixture 仍不足以确定生产额度；gate 保持 4/16/2s/6s 候选，待真实 provider、DBX 与用户成功率/延迟 SLO。报告、源码与二进制指纹见[pressure-v9](../evals/search/pressure-v9/README.md)。
