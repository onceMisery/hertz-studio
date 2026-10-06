# Mineradio 借鉴清单：只做值得做的事

- 分析对象：`D:\code\github\Mineradio`，v2.2.0，commit `328a087`（用户曾写作 `D:\tools\Mineradio-main`，该路径不存在）
- 日期：2026-10-06（两轮：全量评估 → 作者同意照搬后重估）
- 本文只列**要做的动作**。不值得做、够不到、会退步的东西集中在 §6，一条一行连原因一起留着，方便追溯而不是悄悄删掉。
- 此前已借过两轮，本文不重复：`mineradio-online.md`（音质归一 / 运行时上限 / 输出设备路由）、`mineradio-stage.md`（渲染分级 / DPR / 刷新率估计）、皮肤 `sheen`（原名 `mineradio`）。

**作者同意照搬之后，改变的东西很少**：能逐字粘贴的只有 `plugin/ui/` 那一小撮（§3，6 个单元约 700 行）；§1/§2/§4/§5 的建议全是 Rust 侧或行为侧，把 `.js` 粘进 `.rs` 不叫照搬，所以同意对它们是中性项。真正的取舍标准是形态与完成度，不是许可。

---

## 1. A 组 · 音源与权益（读不变量，在 Rust 里重新表达）

| # | 动作 | 落点 | 成本 | 证据（它的行为定义） | 验收 |
| --- | --- | --- | --- | --- | --- |
| A1 | **权益三态**：`Known{verified, source}` / `Unknown`，并规定 `Unknown` 不得当作"非会员"参与音质选择；另设一个**只能显示、不能授权**的 hint 字段 | `online/mod.rs` `AccountInfo`（现 `:358` `vip_level/vip_label` 是二值）+ 各 provider 权益缓存 | S | `kugou-api.js:574-619`；`tests/kugou-vip-hardening.test.js:19-44`（hint 不授权）；`tests/qishui-tier-rights.test.js:160-172`（TTL 设 1ms 逼立刻重探，即 unknown 不塌缩） | 一条测试：模拟权益端点失败 ⇒ 结果里既没有 VIP 音质候选，也没有"你无权益"的文案 |
| A2 | **权益 TTL 按 provider 分档**，且永远 clamp 到已验证过期时间之前；正向证据短窗内保留 | 各 provider 权益缓存 | S | 酷狗/QQ 10min（`kugou-api.js:79`、`qq-vip-api.js:132`）；汽水 10s 正向 + 20s 宽限（`qishui-api.js:180-182`）；`:1817-1824` + 测试断言 `ttl < remaining` | 断言 TTL 不可能越过已知过期时刻 |
| A3 | **结果侧复核**：拿到 URL 后、入缓存前，用权益再查一次返回的 level，超额即丢弃并如实降级回报 | 各 provider 的 URL 解析出口 | S | `kugou-api.js:1295-1320`（`rememberKugouSongUrl`，已逐行读）；`tests/kugou-api-resilience.test.js:117-130`（失败响应里带的 URL 不能授权音频） | 一条测试：上游回一个超额 level ⇒ 我们不缓存、不播放、并回报 `qualityDowngraded` |
| A4 | **取源总 deadline**：外层一个 `Deadline`，每段取 `min(phaseBudget, deadline - now)` | `online/ladder.rs` 外层 | S–M | `server.js:1224-1227, 4060-4067`；`kugou-api.js:1319-1367`；`tests/qishui-session-recovery.test.js:148-169`（冻结 setTimeout 断言精确 deadline 序列） | 冻结时钟的断言：各段都没超时、总耗时仍被上限卡住 |
| A5 | **兜底事务的三条不变量**（只搬概念，实现按我们 actor 重做）：① 去重用 `title \| sorted(artists)` **内容键**而非 id；② 硬上限（队列前进 ≤N、provider 尝试 ≤M）；③ **终结一次且幂等**，晚到的异步不能把它救活 | `state.rs` / `hertz-studio` 侧的失败跳转 | M | `05-playback/11-provider-fallback.js:302-745`；`tests/playback-source-fallback-transaction.test.js:163-193, 221-228`（手动播放取消事务且不踩新音频） | 两条测试：同一首歌在两平台出现只试一次；终结后任何迟到回调都不许改 UI |
| A6 | **会话过期 ≠ 登出**：`reauthRequired` 与 `cookieReady` 分离，凭证保留不删；瞬时 5xx ⇒ `stale` 且保留身份、不作授权断言 | `online/cred.rs` + 各 provider 会话状态 | S | `tests/qishui-session-recovery.test.js:51`；`tests/provider-login-state-recovery.test.js:65-79`；扫码确认后必须**服务端重校验**才落盘（`server.js:5308-5320`） | 断言：探测失败路径不产生任何删除凭证的副作用 |
| A7 | **缓存原语升级**：TTL + LRU + in-flight 单飞 + **代际计数**（`clear()` 后中途 resolve 不得写回）+ TTL 可以是**响应的函数**（失败 ⇒ 0，负结果永不缓存） | `online/cache.rs` | S | `kugou-api.js:32-71`；`qishui-api.js:3427`（可播 4min / 失败 0） | 一条测试：并发同键只发一次上游；`clear()` 期间完成的结果不落缓存 |
| A8 | **凭证不进缓存键**：统一用 sha1/sha256 截断指纹 | `online/cache.rs` / `cred.rs` | S | `kugou-api.js:699`、`qishui-api.js:420-425`；`tests/kugou-vip-hardening.test.js:47-62`（断言共享同一后缀的两个 token 不撞） | 那条"后缀相同不撞"的测试直接照写 |
| A9 | **能力真值表加一档"未验证"**：我们现在 `Capability` + `gate()`（ ungated ⇒ 404）已比它规整，缺的是它那种诚实标注 | `online/mod.rs` `Capability` / `/v1/online/sources` | S | `server.js:4672-4697`，里面写着 `listenReport: 'experimental-unverified'` | 未验证的 op 在 UI 上有区别，不是当成"支持" |

> 已核对我们自己有的、因此不列为待办：魔数字节与错误页判定（`progressive.rs:773` `sniff_ext` + `:539` 明确处理"200 + text/html"）、音质如实回报（`kuwo.rs:200`）、候选 ladder（`ladder.rs`）、能力票（`ticket.rs`）。差别只在它是**给 URL 之前**探，我们是**下载时**探——是否值得把探测提前，取决于"给了 URL 之后播放器静默失败"出现过几次，不预先改。

---

## 2. B 组 · 听感（这是真正缺的一块，比 automix 优先级高）

| # | 动作 | 落点 | 成本 | 证据 | 验收 |
| --- | --- | --- | --- | --- | --- |
| B1 | **真第二解码流** + 等功率重叠。先只做到 album-gapless 那一档：命中边界窗口，或用**实时电平/静音探测**提前触发 | `vmusic-audio` actor + `cpal_backend.rs` | M | 现状：`cpal_backend.rs:416, 494, 564` 的 `crossfade_ms` 是**单流尾淡**，既非 gapless 也非 crossfade。它的做法：`13-playback-start-audio.js:187-259`（analyser RMS/peak + 谱残差，三档保持 112/56/48/180ms）、`:739-790`（70ms 监视器 + 0.72s 窗口） | 同一专辑内连续两首，接缝处听不到静音垫 |
| B2 | **等功率曲线中段加 headroom**，并保证淡入淡出的驱动不受节流影响 | 同 B1 | S | `18-cuefield-automix-integration.js:556-616`：`θ = eased·π/2`，`headroom = 1 − sin(π·eased)·0.10~0.16`，rAF 与 40ms `setInterval` 双驱 + `durationMs+1800` 看门狗 | 交叉段不出现合成峰值抬高 |
| B3 | **任何不支持的混音操作一律降级，绝不因为"混不上"而卡住队列前进** | actor 的操作执行器 | S | `18:753-798`（`outgoing-<op>-bypassed` / `b-deck-graph-unavailable` / `volume-only-fallback`）；`17-cuefield-timeline-executor.js:41-67` | 关掉/缺能力时队列照常前进，只是留痕 |
| B4 | **每轨单调的运行时音质上限** + 播放失败即降档并如实回报 | `online/quality.rs` + `state.rs` | S | `00-api-quality-output.js:139-175`；`11-provider-fallback.js:181-214` | 降档对用户可见，且不会又弹回高档 |
| B5 | （后续）automix 最小版：重叠契约**表** + listening floor + 只用 LRC 的副歌检测 + op-timeline 边界校验 | `vmusic-audio` + 把 `vmusic-beats` 接进音频路径 | L | `planner-contracts.js:1-40`（13 条 recipe 的 `[min,max]` 秒区间 + `clamp(0.35×时长, 24, 72)` 封顶 `时长−12`，已逐行读）；`structure-map.js:55-78`（副歌 = 重复歌词块且 phrase 能量 ≥ 0.95× 均值）；`16-cuefield-automix-core.js:39-116`（op timeline 的可执行性校验） | **前置是 B1**。且只按行为重写：`cuefield/` 归 SLYysl（§6.1），它自己的规划器约 40% 不可达 |

> 现状一条要紧的：`vmusic-beats` 已经算出 `BeatMap`，但只有 `stage_beats.rs`（舞台镜头）消费，音频路径完全不用。也就是说 B5 缺的不是规划器，是把已有的节拍数据接到 actor。

---

## 3. C 组 · 前端可以逐字搬的 6 个单元

这是"同意照搬"唯一真正兑现成本的地方。合计约 **700 行**。每项给了确切行号和必须做的最小改动。

| # | 单元 | 它的对外依赖 | 搬过来要改什么 |
| --- | --- | --- | --- |
| C1 | **跨模块 perf 探针** `public/js/modules/00-state/09-performance-probe.js:1-223`（整个 IIFE） | 只可选调用 `collectRuntimePerfSnapshot`（typeof 守卫） | 改全局名；`snapshot()` 接我们已有的 `CS.stats()` / `Backgrounds.stats()`。我们目前只有各面板自己的统计，没有全局 `mark/markSince/count/topByTotal` |
| C2 | **显示刷新率估计器** `01-scene/00-renderer-quality.js:22-27, 39-58`（rAF gap 的 median + EMA，吸收 59.94/119.88） | **零依赖** | 直接搬。它是 §5.1 那个自查项唯一缺的输入 |
| C3 | **像素预算公式** 同文件 `:5-7, 126-147`：`min(devicePixelRatio, cap, sqrt(budget/cssPixels))` | 要 `fx.performanceQuality`、`normalizePerformanceQuality`、硬件画像、`isDeepBackgroundMode` | 把质量档换成 3 行常量表，`isDeepBackgroundMode` 换成 `document.hidden`。**不搬**它整套 `fxDefaults` |
| C4 | **节拍事件打包** `03-beat/03-local-beat-cache-modal.js:10-65`（+`:66-103` map 配对）：12 槽行 + slot8 的 bit0–5 标志位 | 只引一个 6 项数组 `LOCAL_BEAT_COMBOS`；这一对不碰 localStorage | 常量一起带上，接进 `vmusic-beats` → `stage_beats.rs` 的缓存 |
| C5 | **分享码 codec 骨架** `07-fx/00-preset-archive-data.js:853-1023`（约 170 行：校验和 / base64url / gzip 择优 / delta-vs-baseline / 剪贴板容错提取 / 解帧） | `CompressionStream`（Chromium 专有，编码有 `'J'` 回退、解码会抛） | 只搬骨架。**字段表与 normalizer 必须自己写**——那是它的 225 键迁移码，只对它的 defaults 成立。`normalizeFxArchiveSnapshot`（`:321-545`）横跨 6 个文件约 15 个助手，搬不动也不该搬 |
| C6 | **卡拉OK 歌词 CSS** `public/desktop-lyrics.html:64-121`（`background-clip:text` + `--lyric-progress`、`mask-image` 羽化、`.18px` 描边 + 两层 `drop-shadow`，并明确不用混合模式） | CSS 吃 JS 写入器（`setRootVar`、`--lyric-feather` 等）；窗口控制走 `window.desktopOverlay.*` | CSS 块可逐字搬。另外两个可搬的**点子**：1Hz 推送 + 60fps 外推的 **dead-reckoning 进度插值**（`:813-816`）、边缘羽化。`desktopOverlay` 那套管道离开 Electron 无意义，不搬 |

**C 组的使用方式**：这 6 项的价值是省下设计时间，不是省下判断。搬 C5 之前注意同一个文件里 `renderUserFxArchives`/`saveUserFxArchive` 等 8 个函数被定义了两遍（约 `:764-843` 与 `:1163-1265`），拼接作用域下后者生效、前者是死码，且两份的名字长度上限不一样（18 vs 28）——**别按行号区间整块复制**，只取 codec 那几个函数。

---

## 4. D 组 · 工程实践（对我们最便宜的一层）

| # | 动作 | 落点 | 成本 | 它的做法（可参照的量化事实） |
| --- | --- | --- | --- | --- |
| D1 | 把约 80 个 `scripts/check-*.js` 收成**一个有顺序的聚合入口**：语法检查 → 回归测试 → 全仓禁用词扫描 → 静态 guard → 活体检查 | `scripts/` + `ci.yml` | S | `scripts/quick-check.js` 5,699 行 / 562 个 `fail()`（我数过）；`:9` 全仓扫 `dlss\|fsr\|native-fg\|framegen`，把营销词禁在产品外 |
| D2 | **负面不变量测试**：断言"删掉的东西必须保持删掉"。第一个用例就把 2026-10 的改名映射（`vcp-` 前缀、`folia`、上游项目名不得出现在标识符/注释）变成 CI 断言 | `scripts/` + `ci.yml` | S | `tests/update-external-only.test.js:45-56` 用 `assert.doesNotMatch` 对原文。**注意**：要抄它 `vm.runInNewContext(source.slice(a,b), sandbox)` 那半边（抠纯函数执行），不要抄"正则匹配魔法数字 / 禁用标识名"那半边 |
| D3 | **启动与崩溃可观测性**：事件环形缓冲（原子写）+ 错误归类码 + `reportId` + **有界**渲染恢复预算（滚动窗口 N 次后明确报错并给日志路径） | `bootstrap.rs` / `diag.rs` | M | `desktop/main.js:2195-2216, 2218-2249, 2174-2185, 115, 5404-5410`；恢复故意不同步 reload（注释：Chromium 可能还在收尾死掉的 renderer，先 `await 320ms`，`:5484-5486`） |
| D4 | **注入故障的启动时序断言**：一次性数据目录 + 三处注入（服务端延迟 / 首次导航失败 / 一个永久卡住的加载），然后读回事件序列断言"恰好 1 次重试、恰好 2 次尝试、窗口可见严格早于服务就绪" | 新增 check + CI | M | `quick-check.js:5236-5317`；数据目录隔离本身还有测试守着 |
| D5 | **本地库崩溃一致性**：staged temp → rename 两阶段；封面内容寻址 + **按像素尺寸**（不只字节）拒绝；变更串行化；"一次元数据解析失败必须保住上一次的索引与封面"写成测试 | `vmusic-store` / `vmusic-library` | S–M | `desktop/local-music-library.js:594-617, 630-642, 110-162`；测试 `local-music-library-persistence.test.js:189`。我们已有 sqlx + FTS5，缺的是这类断言 |
| D6 | 文档写成**决策日志**：数值边界 + 该改哪个函数 + 「禁止回退」清单 | `docs/aegis/adr/`（目前是空的） | S | `docs/3D_PLAYLIST_SHELF_MEMORY.md:7, 16, 81`、`docs/DESKTOP_LYRICS_VISUAL.md:22`（"Do Not Regress"）。比"我们为什么选 X"更有约束力，也更适合被 check 脚本引用 |
| D7 | 出处模板：upstream / **精确 commit SHA** / license / 移植日期 / 拿了什么 / **明确没拿什么** | `NOTICE` | S | `docs/THIRD_PARTY_PORTS.md` 的格式本身是好的（问题在它漏记，见 §6.1）。我们已有 vendored `dbx-plugin-sdk` 的 byte-identical 声明，正好升级成这个格式 |
| D8 | 安全模式可参照的两条：文件导入走「主进程校验扩展名 + 拒 UNC + `realpath` → 铸一个绑定 sender 的短时效 token」；登录 cookie 采集用**隔离会话 + 域名白名单**（不做凭证抓取） | `ticket.rs` / 在线登录路径 | S | `main.js:4637-4667`；`main.js:127-135, 2479-2529` |

---

## 5. E 组 · 自查项（对比它照出来的、我们自己的问题）

### 5.1 帧门把档位数字悄悄降了一档（本轮最实的发现）

`plugin/ui/stage.js:919-930` 触发后把累加器清零，余数丢弃 ⇒ 实际帧率只能是 `displayHz` 的整数分之一，且**向下**取。逐个算我们自己的声明值（60Hz）：

| 声明 | 出处 | 60Hz 实际 | 偏差 |
| --- | --- | --- | --- |
| `48` | `creative-stage.js:32` TIERS 最高档 | **30** | −37.5% |
| `40` | `creative-stage.js:32`；`stage.js:961` `lyricsTargetFps` tier1 | **30** | −25% |
| `24` | `stage.js:961` tier0（eco 档） | **20** | −17% |
| `15` | `stage.js:960`（reduced）；`stage3d.js:1626` | **12** | −20% |
| `30 / 20 / 12 / 10 / 4` | 各 gate | 精确 | 0 |
| `48 / 40 / 30` | 同上 | 144Hz 上分别是 **48 / 36 / 28.8** | 同一档位在不同刷新率上跑出不同结果 |

`creative-stage.js:30-31` 的注释写着「快速运动的场景在 20fps 下是肉眼可见的卡顿」，而它想用 48/40 避开的东西，在最常见的 60Hz 屏上从来没被兑现过。

**这不是算术错，是两处约定在打架。** `stage3d.js:1624-1625` 写明本项目原则：「帧率必须是刷新率的整数分之一，90fps@144Hz 会因为帧间隔不均产生 judder」，stage3d 自己按这条做（返回 `240` = 每个 rAF 都给，降频在 tick 内用整数除数）。而 `lyricsTargetFps` / `TIERS` 用**绝对 fps**，交给一个只能兑现整数分频的循环 ⇒ 数字在说谎。

**要做的动作**（按顺序）：先用 C1 的 perf 探针**实测**各门的 runs/s（别拿本节手算当依据）→ 然后把帧门语义改成"每 N 个 rAF 给我一帧"，`N = max(1, round(displayHz / target))`，其中 `displayHz` 来自 C2 的估计器（零依赖，可逐字搬）。顺带加一条 check：所有 `fpsFn` 返回值必须对应某个整数分频，或干脆只允许返回 N。

**不要做的动作**：抄它的 credit 累加（`11-main-loop.js:26-65`）。它能给出精确的 40/24，代价是 60Hz 上 40fps 的帧间隔变成 16.7/33.3ms 交替——正是上面那条原则拒绝的东西。也别抄它的门本体（`10-frame-scheduler.js`）：那里的 `0` 表示**不封顶**（`:24-26`，`if (!targetFps || force)` 直接 run），而我们 `stage.js:932-933` 注释写明"报 0 是唯一停机依据"。语义正好相反，**整块粘过来会把所有子系统的停机条件变成满帧运行**。

### 5.2 其余两项

- **`overlay.html:432` 那条自己起的 rAF 循环没有任何节流**（本轮核对到，就一行）。它该接进 §5.1 的帧门，而不是独立满帧。
- **`navigator.mediaSession`**：我们全仓也没有（grep 0 命中）。这是**它没有而我们可以直接拿**的功能——系统媒体键、任务栏/锁屏播放浮层。成本一天以内；先确认 DBX 宿主是否放行，浏览器形态与 `overlay.html` 可以先用。

---

## 6. 明确不做（保留原因，方便日后不再重新讨论）

### 6.1 作者的同意够不到（不是许可问题，是他没有处分权）

`docs/THIRD_PARTY_PORTS.md` 的 `^## ` 只有 **3** 段，而仓库里实际有**至少 6 个**出处关系——所以别把那个文件当完整清单用。

| 路径 | 真正的权利人 | 证据 |
| --- | --- | --- |
| `cuefield/**`、`05-playback/16…18-cuefield*.js` | **SLYysl** `cuefield-mineradio` @ `c16f05a0…`（GPL-3.0） | `THIRD_PARTY_PORTS.md:3-8`、`NOTICE.md:16` |
| `desktop/full-desktop-mode-runtime.js`、`wallpaper-engine-{library,runtime}.js`、`05-playback/03a-home-dashboard.js` | **ww085213** `Mineradio-LX-Music`（三个不同 SHA） | `THIRD_PARTY_PORTS.md:24-30`、`NOTICE.md:17` |
| `qishui-qr-login.js` | **Wx2yZx** `Mineradio-Qishui-QR-Login` | `THIRD_PARTY_PORTS.md:56-58` + 文件头 `:3-5` |
| `public/sonic-topography-preset.js` | **yin-yizhen** `sonic-topography` @ `3ff303e`；**未申报** | 只在它自己文件头 `:3`；NOTICE 与 ports 文件里 grep 不到 |
| `public/vendor/sonic-workshop/**`（约 2.2MB，Steam 工坊 id `3747222633`） | 该工坊作品作者；**未申报** | 全仓无声明 |
| `public/vendor/gsap.min.js` | **GreenSock**，Standard License（非开源、不含再分发权能） | 文件头 `:5-6` |
| `qishui-auth-v6/bdms.js`、`sdk-glue.js` | 字节/火山风控与 passport SDK，无授权文本 | `qishui-auth-v6.js:25, 312`；`sdk-glue.js:1` banner |
| `Mineradio` 名称 / MR Logo / 界面视觉设计 | 作者主张保留；代码同意不转移身份（也与既定改名策略一致） | `README.md:113`、`NOTICE.md:29` |

### 6.2 与许可无关，仍然不碰 / 不学

| 不做 | 原因 |
| --- | --- |
| `qishui-audio-decryptor/**` 的 DRM 解密、`#auth=` 密钥侧信道 | 受禁令约束的是**规避这个行为**，技术措施的权利人是平台，任何第三方都无处分权。它还被 `scripts/quick-check.js:3180` 强制打进安装包，且与 `README.md:93` / `PRIVACY.md:32` 的自我承诺直接矛盾——是它自己的暴露面，不是可搬资产。我们 non-goal 已写对：`online/mod.rs:28-44` |
| 酷狗签名盐、`aid 386088` / UA 冒充、伪造 `msToken` | 从他人客户端反推；服务条款与商业秘密问题。盐会轮换，运营上是定时炸弹（它已经付了代价：版本钉死 + 20s readiness 自旋，厂商一升级就断登录） |
| `HOST` 默认 `0.0.0.0` + 全 API 无鉴权 + `/api/audio?url=` 不校验 + `ACAO:*` + 无 CSP + 每请求重读 cookie + `catch(_) {}` 吞掉凭证写入失败 | 反面教材，建议**转成断言**防自己漂。相关行：`server.js:122, 415, 4636, 311/319`。我们 `config.rs:73` 是 loopback，别漂 |
| 同步 XHR 拼接 loader、单作用域 927 个 `var`、257 个 inline `onclick`、436KB 单 CSS | 阻断 CSP/分割/缓存；重名遮蔽在它自己仓库里造了 9 个真 bug。我们也是零构建，教训是"配置与外观状态要么有声明式 schema，要么就会被手写五遍"（它有 5 份手写枚举 + 一个专门同步其中两遍的脚本） |
| 死供应商整块留在产品里（`/api/spotify/*` 全 404 但 16 个 handler + 62KB 模块仍打进包）；断言只查"源码含某字符串"的**空测试** | 测试绿着而什么都没保 |
| WorkerW / DefView 桌面嵌入、explorer 图标矩形读取、Wallpaper Engine 捕获 | 同意够不到（§6.1）+ 抄不动（PowerShell+Add-Type、`VirtualAllocEx` 注入 explorer 是 EDR 行为、RDP/DWM-off/第三方 shell 直接破）。值得留的只有它那份 Windows 桌面壳**失败分支清单**：每步回读校验、ack 只认 stdout 最后一行 JSON、错误码从 stderr 抽 |
| 它的帧门本体 / credit 掉帧 / 后台缩 drawing buffer / 量化 dirty key | 见 §5.1 与 §6.2 上文：语义相反、与本项目原则冲突、针对的 Electron 托盘竞态我们不存在、`renderLists` 是 three.js 专有、量化 dirty key 我们已在三处使用 |
| 手势控制（MediaPipe Hands） | 运行时从 jsdelivr 拉 wasm/模型，**离线即死**；权限链是 Electron 专用仪式；要重写约 20 个全局，而我们没有相机层 |
| `shadow-diagnostics` / `feedback-log`（约 460 行 sanitizer + 按 cohort 分桶通过率） | 采集齐了但**没有任何回读方**（`GET /api/cuefield/feedback` 前端从不调用，规划输入不来自历史）。没有消费者之前抄了就是白写。它的 `capabilityLevel` 也是记了但不 gate 任何东西 |
| 它的 cuefield 规划器与打分逻辑本体 | 约 40% 不可达：`boundary-evidence` 需要的开关渲染端从不设置，`edgeEvidence` 全仓无生产者 ⇒ 曲尾交叉淡入永远报 `EDGE_EVIDENCE_UNAVAILABLE`；`musicalProfile` / `audioMetrics` / `camelot` key / `vocalWindows` 全是"读的地方有、写的地方没有"（`adapter-mineradio.js:159` 把 `sections` 硬编码成 `[]`）。⇒ 只取 §2 B5 那三样数据化契约 |
| 路径派生 track id、`EmptyWorkingSet`/待机列表 RAM 修剪、手写 regex 解析 Range（忽略 `bytes=-500`）、整文件进内存无上限 | 移动文件 = 新歌；后者它自己默认关掉（注释："避免前台 CPU 尖峰"） |

---

## 7. 置信度

**我逐行核对过**：`index-loader.js` 同步 XHR + `Date.now()` cache-bust；`server.js:122/415`；Mineradio 全仓 `mediaSession` 计数 0；`kugou-api.js:1295-1320`；`planner-contracts.js:1-40`；`10-frame-scheduler.js:1-48` 与 `11-main-loop.js:26-65`（含两处相反的 `0` 语义）；`gsap.min.js:5-6`；`sonic-topography-preset.js:1-5` 与 NOTICE/ports 的 grep 缺失；`THIRD_PARTY_PORTS.md` 的 `^## ` = 3；`quick-check.js` 行数与 `fail()` 计数、`:9` 禁用词；各文档「禁止回退 / Do Not Regress」小节。我们侧：`stage.js:919-930 / 932-933 / 957-961`、`stage3d.js:1618-1629`、`creative-stage.js:30-32`、`overlay.html:432`、`cpal_backend.rs:416/494/564`、`progressive.rs:539/773`、`online/mod.rs:144-146/358`、`kugou.rs:579-589`、`kuwo.rs:200`、`ticket.rs`、`Cargo.toml:16`。

**子代理报告、我未逐行验证**（引用前自己打开确认）：各项"引用了多少外部全局"的计数；C5 重复定义的精确行区间；`desktop/main.js` / `local-music-library.js` / provider 端点的行号细节；WorkerW 与 explorer 图标读取的每一步；A5/A7 那些测试文件的断言细节。**§5.1 的实际帧率是我按 60/144Hz 手算的**，与 `runGates` 逻辑一致但没跑起来量过——先做 C1 再谈改档位数字。

**判断而非事实**：各表的成本档位（S/M/L）与分组顺序；§6 的"不做"结论。其中 B5 排在 B1 之后、C 组只值约几天而不是几周，这两条是我的估计。
