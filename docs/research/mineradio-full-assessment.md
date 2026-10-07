# Mineradio 借鉴清单：只做值得做的事

- 分析对象：`D:\code\github\Mineradio`，v2.2.0，commit `328a087`（用户曾写作 `D:\tools\Mineradio-main`，该路径不存在）
- 日期：2026-10-06（两轮：全量评估 → 作者同意照搬后重估）
- 增量复核：2026-10-07，见 §8–§11；Mineradio 仍为 `328a087a14e79d5267a3de54d29108c34ed6cf60`，hertz-studio 基于 `e138a5ba1ad3f594e141c558efdd5a362e110e30` **及本地未提交改动**。§1–§7 保留原记录，涉及冲突时以 §10 的修正为准。
- 本文只列**要做的动作**。不值得做、够不到、会退步的东西集中在 §6，一条一行连原因一起留着，方便追溯而不是悄悄删掉。
- 此前已借过两轮，本文不重复：`mineradio-online.md`（音质归一 / 运行时上限 / 输出设备路由）、`mineradio-stage.md`（渲染分级 / DPR / 刷新率估计）、皮肤 `sheen`（原名 `mineradio`）。

> **实施后复核（2026-10-08）**：本地已实施多批。当前状态和本轮修复见 §12；§1–§11 是历史分析，不能把其中“目前没有”或旧实施记录的“剩余没做”直接当成当前事实。

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

---

## 8. F 组 · 服务与数据流程（补上从接口到用户动作的那一段）

本轮不重复 A 组的权益、取源 deadline、失败兜底，也不把我们已有的 SQLite、混合歌单、分页接口和后台分析重新列成新功能。增量是：**谁拥有状态、什么时候提交、结果怎样告诉用户**。以下 Mineradio 路径相对 `D:\code\github\Mineradio`；“我们侧”路径相对 `D:\code\github\hertz-studio`。优先级 P1 = 优先处理的行为或语义缺口，P2 = 有场景再扩展，P3 = 暂缓；成本继续用 S/M/L，均为估计。

| # | 可借鉴点 | 对应 Mineradio 证据 | 对当前项目的适用场景 / 判断 | 建议实施方式 | 优先级 | 潜在风险 / 成本 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | **按页面消费组织结果，但把分支失败保留在结果里** | `server.js:1699-1754` 的 `handleDiscoverHome` 并发取推荐歌单、私人推荐、每日歌曲，`Promise.allSettled` 允许部分成功；入口是 `server.js:4884` 的 `/api/discover/home`。但失败分支最终变空数组，`dailySongsComplete` 仍固定为 true | **保留我们已有后端，补消费端**。`crates/hertz-studio/src/daily.rs:613-643` 已有 `sources/skipped/pending/age_secs/stale`，比它更能区分“没有”和“还没到”；`plugin/ui/daily-view.js:213-247` 的独立每日页只在空态解释部分原因，副标题主要显示总数 | 让独立每日页消费现有状态，保留成功平台曲目，同时显示仍在加载、暂时失败、缓存时间及下一步操作。接口继续由 `daily.rs` 出结果，HTTP `routes.rs:2319-2343` 与 `rpc/recommend.rs` 共用；不再加一个复制聚合逻辑的“首页服务” | P1 | S–M。不要把它的 `dailySongsComplete=true` 当上游完整性证明；不要把前端没展示字段误判成后端没能力。验收：一个平台超时，其他曲目仍可播放，提示不要求用户反复登录 |
| F2 | **首批可播、后续按播放位置或浏览进度补齐；队列进度与列表分页分开** | `public/js/modules/06-lyrics/03-podcast-playlist-loaders.js:110-208`：同一在途 promise、`token + queueRef` 校验、接近队尾续载、失败重试；`:210-280` 首批建队列；`public/js/modules/06-lyrics/01-playlist-panel-shell.js:108-131` 显示“已准备 N/总数”“载入中断”“再载一批” | **有直接缺口，完整方案需适配**。我们 `plugin/ui/online-playlist-view.js:283-336` 已分页，但 `:345-350` 的 `visibleTracks()` 只含已加载数据，`:407-429` 却在无筛选时写“播放全部”并调用 `Online.playAll(view, 0)`。这条调用链没有带集合 id 或续页上下文，不能据此承诺整张歌单 | 第一小步把按钮写成“播放已加载 N 首”，明确筛选只作用于已加载范围。若要真整单播放，再由 `AppState` 持有集合来源、游标和队列代际；前端只发意图，服务端补入同一队列并发布进度。接入 HTTP/RPC 共用入口，复用现有 `play_generation`，不让关闭详情页终止队列续载 | P1 | 文案 S；完整续载 L。随机播放、手动换队列、重复页、空页不前进都要定义。Mineradio 的**后续页**有代际检查，但首批请求返回到 `playQueue = seedTracks` 之间没有同等的新意图校验，不整块照搬。验收：旧歌单迟到不能覆盖新队列，加载失败不丢已准备曲目 |
| F3 | **用户选中的曲目身份与实际供音身份分开** | `public/js/modules/05-playback/02-listen-stats.js:71-103` 优先用 `provider/sourceKey`，另带 `resolvedPlaybackProvider`；`server.js:4494-4527` 同样优先取账号侧来源；`tests/platform-account-sync-guard.test.js:23-32` 守的是这个字段顺序 | **先保留出处，再决定业务策略**。我们 `crates/hertz-studio/src/state.rs:2122-2146` 接力时替换队列 id、迁移元数据；`:836-843` 打卡按当前虚拟 id 判断平台。以后增加平台收藏、原歌单定位、换源解释时，仅靠播放 id 不够 | 在同一队列条目的元数据里补 `origin` 与 `resolved`，前者供详情、收藏入口和来源说明，后者供取流、音质及缓存。保持播放 actor 的唯一写入者地位；打卡暂维持现有策略，另行明确跨源播放能否、应否记到原平台，不能看到参考实现这样做就自动上报 | P2 | M。相似版本不等于同一录音；平台裸 id 不可跨源复用。快照、恢复、历史及接力都需携带身份，不能只在前端加两个标签。验收：换源后既能说明原选择，也能如实显示当前供音平台 |
| F4 | **把“已受理 / 已提交 / 对方已确认”分开；必要时持久化提交回执** | `server.js:178-209` 用平台、凭证指纹、`sessionId` 建回执键，临时文件改名并保留最近 600 项；`:4556-4563` 重复请求读回执；`:4587-4609` 区分 `submitted_unverified`、`historySynced` 与不支持时长同步 | **反馈语义可直接用，耐久回执暂按需**。我们 `state.rs:430-486` 的 `ScrobbleGate` 已有并发与频控，`:874-878` 成功后发布 `Scrobbled`；这证明接口调用成功，不能推出平台累计时长已增加。现有发送模式不值得仅为对齐而加重试队列 | 产品反馈写“已提交听歌记录”。只有引入断线重发、重启补发后，才在 SQLite 建有界会话回执，按账号身份与会话键去重，保留原频控。不要用 UI 重试绕过 `ScrobbleGate` | 语义 P1；回执 P3 | S / M。Mineradio 不是 exactly-once：远端成功与本地回执落盘之间仍有崩溃窗口，并发同键请求也未在发送前原子占位；凭证轮换会改变其账号键。它的前端 `02-listen-stats.js:120-134` 没消费响应体，所以不能把后端字段存在说成完整反馈闭环 |
| F5 | **后台分析按交互负载让路，并明确“分析就绪”和“缓存持久化”是两种状态** | `public/js/modules/03-beat/00-tempo-worker-cache-prefetch.js:195-259` 延后到播放起步之后、先查磁盘、忙时等待、分析最多尝试 3 次；`server.js:4769-4777,4840-4875` 对外报告 `disk/memory-only/reason` | **在现有任务表上补预算与状态**。我们 `crates/hertz-studio/src/stage_beats.rs:4-8,91-123` 已做每键单飞和后台分析；`:280-324` 每任务进 `spawn_blocking`，成功后若缓存写失败就记 Failed。不同歌曲快速提交仍需要总并发预算；无需再造浏览器 Worker 分析层 | 给 `stage_beats.rs` 的不同键任务加有界并发及排队状态，当前播放优先；复用现有结果接口和 `BeatmapReady`。若实测磁盘不可写影响舞台，再考虑同一任务表保留有界内存结果并注明未持久化。不要把“让任务低优先运行”落实成 UI 定时器控制音频 actor | P2 | M。运行中的 `spawn_blocking` 不能靠取消外层 future 保证中止。Mineradio `QUEUE_BEAT_AUDIO_PREFETCH_ENABLED=false`（同文件 `:88`），后面的两首队列预取只是关闭的代码路径，不能拿来证明预热收益；也不学它禁止 C 盘的产品策略 |
| F6 | **持久化 DTO 要有字段白名单，也要有数量、字节和版本边界** | `desktop/built-in-playlist-library.js:5-24,73-107,127-137`：版本 1、100 张歌单、每单 5000 首、单曲 48KB、索引 32MB；字段过滤、来源范围、按平台身份去重；`public/js/modules/06-lyrics/00-built-in-playlists.js:31-66` 经桌面桥读取 | **已有混合歌单，借的是入库边界**。`crates/vmusic-store/src/playlists.rs:11-30,90-145` 已有类型化 `TrackMeta`、虚拟 id 和去重；没有必要换成整包 JSON 或保存它的多套 provider 原字段 | 在现有歌单批量入口和备份导入处核对条目数、字符串长度、总载荷与版本迁移的边界；保持本地曲以 `tracks` 为准、在线曲用显示快照。新增断言应验证越界时没有部分入库，以及混合歌单重启后仍能显示来源 | P2 | S–M。参考的数值只证明“有上限”，不是我们的容量目标。它的白名单仍包含 `localUrl/localPath/privilege`，所以**不能声称白名单天然排除了临时能力或过期权益**；我们只持久化需要的显示字段，不把运行态授权当长期事实 |
| F7 | **取二维码、轮询、切平台和关窗属于同一次登录意图，取消定时器不等于取消在途请求** | `public/js/modules/08-account/03-login-modal-flows.js:18-19,600-604,1048-1099` 用平台 + 请求序号隔离取码结果；`:1172-1193` 的汽水轮询另有 generation，返回后再检查；`:1222-1231` 对验证中和限流给不同等待时间与解释 | **现有登录流程的 P1 缺口，沿用我们的票据服务**。`plugin/ui/online-login.js:97-99` 只清定时器，`:477-488` 取码后直接渲染，`:120-121` 又把结果票据与可变的 `currentSource` 配对；`:129-175` 轮询返回后也没验证当前意图。慢请求下可能用新平台配旧票、关窗后重启后台轮询，见 §11 的离线复现 | 在 `OnlineLogin` 内统一持有递增的 attempt、source、channel、ticket；切平台、刷新、关窗即使旧 attempt 失效。取码、轮询、手动 cookie 提交的成功、失败及收尾均核对归属后再改界面或排下一次请求。迟到的新票按它原来的 source 尽力调用现有 `/v1/online/qr/cancel`；保留 `crates/hertz-studio/src/online/qr.rs:15-29,57-102` 的 TTL、终态和作废机制，不新建第二套票据服务 | P1 | S–M。UI 失效不会撤销服务端已完成的授权；本项不声称存在跨账号凭据写入。参考也不完整：`closeLoginModal():595-598` 停轮询却不递增取码序号，`:1096-1098` 的 busy 清理也非完全按代际隔离，不整块搬。验收：A→B 后 A 迟到不覆盖 B，关窗后无新轮询，旧失败不清掉新请求的忙态 |

**接口组织的取舍**：参考项目同时有 Node HTTP（`server.js`）和 Electron 桥（`desktop/preload.js`、`06-lyrics/00-built-in-playlists.js`），这不是一份可直接复用的统一服务接口。我们已有 `routes.rs` / `rpc/` 双门面、`online/mod.rs` 能力分发和 `scripts/api-routes.js` 路由清单；本组建议都应落回既有业务模块。新加一种结果状态，要同时让浏览器和 DBX 看见，不能只改 HTTP 页。

---

## 9. G 组 · 页面、布局与交互（借操作路径，不再搬一层皮肤）

Mineradio 的入口不是传统多页面路由：`public/index.html:100-153` 是搜索与导入，`:162-278` 是 Home，`:280-304` 是平台推荐弹层，`:309-340` 是账号与视觉控制台入口；歌单、播放控制和舞台在同一壳里协作。这个组织方式值得拆开看，**不等于把我们的主导航改成隐藏面板**。

| # | 可借鉴点 | 对应 Mineradio 证据 | 对当前项目的适用场景 / 判断 | 建议实施方式 | 优先级 | 潜在风险 / 成本 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | **首页先回答“现在做什么”：继续播放是主入口，音乐库、推荐、最近播放是次入口** | `public/js/modules/05-playback/03a-home-dashboard.js:532-580` 的四张任务卡；`:601-619` 按当前队列 → 最近记录 → 每日推荐决定继续动作；`public/index.html:212-245` 把今日聆听、下一首、发现放在另一组 | **需要轻量适配**。我们 `plugin/ui/index.html:327-351` 已有明确主导航，`:401-428` 已有每日推荐条，`daily-view.js` 已有独立每日页；缺口不是再造推荐系统，而是回到应用时的连续操作入口 | 在既有曲库首屏或每日页增加一张“继续播放”卡，复用 `PlaybackIntent` 和现有播放命令；没有队列时明确写“播放最近一首”或“去曲库”，不要让按钮文案与实际回退动作分离。保留当前导航，不新增与播放器独立的首页队列 | P2 | S–M。它把本地歌曲数与歌单数相加成“项内容”（`:540-558`），我们应分开显示，不能叫“歌曲总数”。首页模块来自第三方移植（§6.1），只按行为重写；自动播放不能由渲染卡片触发 |
| G2 | **推荐来源、降级来源和下一步动作在同一区域说清楚** | `03a-home-dashboard.js:989-1080`：平台标签、载入态、失败态、未登录态；汽水 Feed 不可用时把标题改为“你的音乐”，明确是喜欢 / 最近播放。`public/index.html:291-303` 把平台切换、状态、当前平台刷新放在一起 | **直接补独立每日页的解释与操作**，数据仍用 F1。我们 `daily-view.js:227-247` 已有登录与空库文字引导，不能重复算成新功能；可增量的是成功列表仍显示缺席来源，以及提示旁能直接执行的按钮 | 把 `pending`、`skipped.kind`、`stale` 映射成少量稳定文案和动作：等待 / 刷新、去账号页、去扫描目录。已有条目保持可用；默认复用现有刷新，不宣称当前 API 支持单平台刷新。将来若展示喜欢或历史补位，标题随数据来源改变 | P1 | S–M。不显示源码里的“视窗附近渲染”等实现术语（它 `:1023` 正在这样写）。不照搬它混在配置里的失效 Spotify 入口，也不把所有网络错误都叫登录过期。验收：空库、未登录、部分成功、仍在加载各有正确动作 |
| G3 | **视觉层级用面积、字号和内容密度建立；窄屏重排任务卡** | `public/css/index.css:17539-17597`：主卡 `1.75fr`、标题 24px、封面 126px；次卡标题 18px、封面 70px、摘要最多两行。`:18103-18133` 改两列，`:18188-18228` 改单列；`:17622-17639` 的信息卡另成一层 | **借层级和重排，尺寸与效果需要适配**。我们是多皮肤 UI，已有 `style.css`、`skins/`、`theme-studio.js` 的主题与可读性逻辑；不能另建一套固定白字、重阴影、模糊玻璃样式 | 对 G1 的主动作使用现有强调色和较大面积；次入口保持一致，状态说明降低字重而不是无限降低对比度。按组件可用宽度决定列数，支持 DBX 窄容器；复用现有间距、色彩变量，核对浅色 / 深色与字体放大 | P2 | S–M。Mineradio 在窄屏仍把 Hero 设成 `minmax(360px,55vh)`，可能把任务入口推到首屏外；不照搬这项高度。固定 10.5px 次级文字和 25px backdrop blur 也不能作为可读性、性能验收标准；本轮是 CSS 结构判断，不是实机视觉评分 |
| G4 | **完整数据、可见窗口、播放索引三者解耦** | `03a-home-dashboard.js:21-23,901-969`：84px 行高、3 行 overscan、最多 24 张卡，上下占位保持滚动高度，卡片带原始绝对索引；`tests/home-daily-recommendation-virtualization.test.js` 执行窗口算法并核对全队列索引 | **长歌单适用，小推荐列表暂不必**。我们 `daily-view.js:327-347` 一次画出当前列表，`online-playlist-view.js` 已有分页但会积累已加载 DOM。分页解决取数，虚拟窗口解决 DOM 数，不能互相替代 | 优先在实测长歌单上试窗口化，数据保留在原列表状态中，播放继续用完整数据及稳定虚拟 id；先让行高服从当前密度 / 皮肤，再算窗口。保留“加载更多”作为可见入口，定位当前曲目、键盘焦点、滚动恢复都要跟随 id | P2 | M。不要照搬 84px / 24 的常量：字号放大或超高窗口会改变覆盖范围。复用节点或替换窗口时要保住焦点，不能为了减少 DOM 把播放队列裁成 24 首。它只给网易云每日区做这套窗口，不能概括成全站虚拟化 |
| G5 | **设置搜索不是筛一堆文本，而是找到控件并带用户到那里** | `public/js/modules/07-fx/09-console-workspace.js:3-29` 常用 / 界面 / 歌词 / 动效 / 歌单架 / 系统；`:572-649` 搜索别名与分组，结果带当前位置和当前值，点击切页、展开分组、滚动、聚焦并短暂高亮；尊重减少动效 | **可在现有参数表直接扩展**。我们 `plugin/ui/stage-control.js:38` 已有 `SCHEMA`，自动生成控件，`:507-528` 已有 `values/set/addGroup`。不是再造它的 `FX_CONSOLE_LAYOUT` 与 DOM 扫描器 | 给既有 schema 补 `aliases/group/order`，用同一份表生成搜索索引；搜索结果显示“分组 › 参数”和当前值，点击定位原控件。需要跨主题工坊搜索时，各模块注册自己的条目和 reveal 回调，值仍由原模块管理 | P1 | M。它 `:387-428,450-491` 是把旧 DOM 搬进新分组，靠选择器反查；我们已能声明式生成，不应退回搬节点和双份枚举。验收：隐藏分组命中后可键盘操作，清空搜索不丢参数值，找不到已移除控件时有明确反馈 |
| G6 | **一段连续调参算一次可撤销动作，回退只改动过的字段** | `09-console-workspace.js:657-660,741-769` 历史上限 40、同控件 650ms 内合并；`:928-955` 记录滑块事务前后；`:823-859` 仅恢复 changed keys；`:915-924` 排除缓存清理、外部媒体等操作 | **视觉调参值得直接补**。我们 `StageControl.values()/set()` 已是收敛入口；`theme-studio.js:747` 的 `setOptions` 管背景参数。现有保存 / 重置不等于撤销上一步 | 先只在 StageControl 做有界内存撤销：pointerdown / 键盘调整开始记 before，change / blur 记 after；一次拖动一条历史，恢复走同一个 setter。跨模块以后再做显式适配，外部文件删除、清缓存、登录等不进入视觉撤销栈 | P1 | M。不照搬伪造 `input/change` 再检查状态的回退链；先统一值校验与写入出口。连续操作、恢复默认、扩展组卸载及存储失败要定义清楚；它提供的是撤销 / 回到历史点，不能据此写成已有完整 redo 系统 |
| G7 | **后台任务状态要附着在任务上，而不是只闪一次 toast** | `public/js/modules/03-beat/03-local-beat-cache-modal.js:254-284` 展示当前歌曲、模式、缓存命中和互斥按钮；`:286-302` 取消令牌；`:304-361` 开始 / 成功 / 失败的状态文案和重试入口 | **复用现有服务端事实**。我们已有扫描进度与取消（`routes.rs:94-96`、`plugin/ui/index.html:394`），节拍分析也有 `Analyzing/Ready/Failed` 和 `BeatmapReady`（`stage_beats.rs:19-61,303-307`）。只补节拍状态的可见消费，不做第二个前端任务状态源 | 在舞台控制区域显示“等待分析 / 分析中 / 已就绪 / 当前格式不支持”，失败时保留说明与允许的重试；关联 track id，切歌后不把上一首的完成提示写到新歌上。没有实际可终止能力时只提供收起提示，不叫“取消任务” | P2 | S–M。Mineradio 的取消主要是令牌作废，不能推出底层 CPU 工作已停止；失败 catch 也没有与成功路径同等的令牌校验（`:332,342` 对比 `:354-361`）。我们应利用 F5 的任务状态，不能照搬前端布尔值互相清忙标志 |
| G8 | **临时窥视与固定面板分开；全局导航和播放动作保持稳定** | `public/js/modules/10-shell/02-peek-panels-upload.js:71-119` 区分 peek、关闭延时、固定歌单面板和沉浸 / DIY 条件；`:95-99` 打开时才刷新延迟的队列视图；入口位置见本节开头的 `public/index.html` | **只适配已有沉浸模式**。我们 `plugin/ui/index.html:327-351` 的主导航、`:1282-1314` 的舞台与 `:1323` 的播放条已分工清楚，日常浏览不用隐藏主入口；面板也不能成为播放状态的另一个 owner | 沉浸舞台可采用“临时展开 / 用户固定”两种状态，显式按钮和键盘入口始终可达；关闭只改变显示，不能清队列或重启音频。复用 `dialogs.js` 的焦点作用域及既有播放命令，退出舞台回到原页面与滚动位置 | P2 | M。边缘 hover 只能是快捷方式；触屏、键盘、缩放后的可达性要单独验证。不搬它的 peek 定时器与多组全局开关；我们的普通导航已更直接 |
| G9 | **卡片原位更新、图片解码后再切换；媒体资源有明确释放时机** | `03a-home-dashboard.js:475-528,583-598` 复用按钮并校验图片请求后提交，避免迟到封面覆盖；`:135-190` 用 IndexedDB 存视频 Blob，`:211-234,253-286` 用可见性与令牌决定挂载，卸载时清 src、load、revoke URL | **卡片更新可借；媒体持久化按需**。我们 `backgrounds.js:292-305` 已释放旧媒体，`:724-735` 明确本地文件仅 ObjectURL、不落库；`theme-studio.js` 也已有主题壁纸。增量是异步封面稳定提交、需要跨刷新保留自选视频时的资产存储，不是再实现一次 revoke | G1 的卡片保留 DOM 身份，以稳定 id 和封面 URL 校验异步回调。若产品确实需要保存视频，先给 Backgrounds 增资产引用层，Blob 与小配置分存，读取完成后复核当前选择，并保留静态背景回退 | 卡片 P2；视频持久化 P3 | S / M。视频不存成巨型 base64 塞进 settings；它的 300MB 限制不是我们应采用的预算。DBX 的存储 origin、配额和迁移需验证。它最后通过覆盖 `renderHomeDiscover` 接入（`:1274-1280`），我们改用模块注册或显式订阅，不学全局函数包裹链 |
| G10 | **搜索历史跟随搜索能力，切平台或切皮肤时仍可复用；查询历史与结果缓存分开** | `public/js/modules/05-playback/07-search.js:75-129` 将旧数组 / 分平台记录迁成一份版本化列表，大小写归一去重、最多 10 条；`:131-162` 空查询显示历史按钮、可清空，点历史沿用当前搜索模式。`tests/search-frontend-pagination.test.js:89-124` 实际执行历史读写与迁移 | **已有局部实现，适合收敛而非新增一套**。我们 `plugin/ui/skins/skin.liunian.js:49-50,650-674,688-704` 已有 10 条历史、逐项删除和清空，但 owner 在流年皮肤；`plugin/ui/online.js:309,544-549,603-611` 的则是搜索结果缓存。增量是让其他皮肤 / 搜索入口共享关键词，不能把结果缓存误当历史 | 将流年的关键词读写抽成共享的小模块，皮肤只渲染并把选中词交给原搜索入口；保留逐项删除，首次迁移旧键后只写新 owner。历史不携带曲目权益或结果快照；重放时保留用户当前选择的本地 / 在线范围，范围标签可见。若要求服务换端口后仍保留，复用服务端 settings 做持久化，避免再建一套皮肤存储 | P2 | S–M。Mineradio 的分平台旧格式合并没有逐条时间戳，不能声称迁移后仍严格按真实最近使用排序。关键词需长度 / 数量校验，清空应同时清共享状态与旧镜像，不能刷新后又迁回来。我们 `plugin/ui/host.js:95-166` 已有宿主持久化替身，不重复造兼容层 |
| G11 | **歌词校准标清“当前曲目”，让主舞台与浮层共用同一份时间语义** | `public/index.html:1391-1404` 把当前歌名、校准读数、提前 / 延后 0.1 秒和归零收在歌词按钮旁；`public/js/modules/06-lyrics/06-lyric-timing-offset.js:62-87,151-171,174-210` 按曲目键保存，变化后刷新舞台与桌面歌词；`public/js/modules/02-visual/14-stage-lyrics-rendering.js:257` 和 `public/js/modules/10-shell/04-desktop-overlay-fullscreen.js:920` 消费同一时间修正函数 | **本地校准已做，在线每曲校准需要适配**。我们 `plugin/ui/app.js:2193-2206,2241-2253,6325-6339` 和 `stage3d.js:2916-2947` 已有本地每曲偏移、持久化与部分失败回清，但在线曲目明确拦截。全局偏移另在 `index.html:844-847`；不能让用户为了校正一首在线歌而改全局设置 | 优先复用 `crates/vmusic-store/src/lyrics.rs` 的每曲偏移 owner，按 `online:<source>:<id>` 核对读写及清理边界；接通在线取词、主页面和 `/v1/lyric` 浮层的读取路径后再开放按钮，HTTP/RPC 同口径。现有弹窗 / 舞台内显示当前曲目与重置入口，文件偏移、每曲偏移、全局偏移只在约定位置各应用一次；切歌后的迟到保存不能更新新歌读数 | P2 | M。**符号不能照抄**：它在播放时间上加偏移，正数代表提前；我们 `crates/vmusic-lyrics/src/lib.rs:217-240` 在歌词时间戳上加偏移，正数代表延后。参考 `queueItemKey` 对部分来源退到裸 id / 歌名歌手，不能当我们的跨平台唯一键；换源或不同录音版本不自动继承校准。验收需覆盖逐字时间、负时间截断、重启恢复及主页 / 浮层一致性，不能只验证读数变化 |

**组件划分落点**：G1 的首页卡、G2 的来源状态、G4 的窗口列表都是“读快照、发意图”的视图；G5/G6 的搜索与历史围绕 `StageControl` 的同一份 schema 和 setter；G7 读服务端任务状态；G9 的媒体句柄仍归 `Backgrounds`；G10 的关键词历史退出皮肤私有状态，G11 的时间修正仍由歌词业务层统一提供，F7 的当前登录意图归 `OnlineLogin`。皮肤只负责布局与外观，provider 适配留在后端，播放命令回到现有 actor。这样借得到交互，也不会把 Mineradio 的单作用域与 DOM 反查依赖一起引进来。

---

## 10. 原结论的增量修正（保留旧记录，但不再按旧说法排期）

| 原位置 | 本轮核对到的事实 / 证据 | 修正建议 | 优先级 / 成本与边界 |
| --- | --- | --- | --- |
| §5.2 “我们全仓没有 MediaSession” | 当前 `plugin/ui/app.js:4540-4589` 已有元数据、播放状态、进度和媒体键绑定，`:7696` 调用 `bindMediaSession()` | 改读为**主应用已实现**，从新增功能待办移除。浏览器或 DBX 是否逐项支持属于运行环境验证；不能由主页面实现推断 `overlay.html` 也已接入 | P1 / 文档修正；本轮未做系统媒体键实机测试 |
| A7 将响应缓存原语整体落到 `online/cache.rs` | Mineradio `kugou-api.js:32-71` 是 API 响应 memoization；我们 `crates/hertz-studio/src/online/cache.rs:4-22,80-129` 是音频文件索引、质量分键和 LRU。`daily.rs` 又有自己的按天推荐抓取状态 | **区分三种缓存**：API 响应、推荐业务结果、磁盘音频。A7 的单飞 / 代际 / 响应 TTL 应先落在真正的响应缓存 owner；不把它们全塞进磁盘索引，更不把“失败不缓存”覆盖所有业务的退避策略 | P1 / 设计落点修正；实现需按 provider 复核，不能一条通用缓存清空影响当前音频 |
| A7 容易被读成“参考缓存已经同时具备 LRU、零 TTL 不缓存、清空隔离” | `kugou-api.js:32-71` 有 generation，但 `set` 用 `ttlMs \|\| defaultTtlMs`，`wrap` 没排除 0，零 TTL 仍缓存；`qishui-api.js:136-168` 的 `wrap` 排除了 0，却没有 generation，清空期间完成的请求会写回。两者 `get` 都不刷新访问时间，淘汰按写入时间，不是访问 LRU | A7 可以保留为**我们要组合实现的目标**，不能说任一参考函数已全部实现。分开验证零 TTL、清空期间完成、并发单飞和最近访问淘汰；不要只复制酷狗助手再接汽水的 TTL 回调 | P1 / 行为证据修正；本轮已用原函数沙箱和可控 Promise 复现零 TTL、淘汰及 clear 竞态，见 §11 |
| B1 把等功率重叠称作“album-gapless 那一档” | 我们 `cpal_backend.rs` 仍是尾淡；Mineradio `13-playback-start-audio.js` 的曲尾检测和 `18-cuefield-automix-integration.js:590-603` 的双路增益是提前衔接 / 重叠。两者都不足以证明无缝专辑接缝正确 | **gapless 与 crossfade 分开验收**。前者要求相邻曲目样本连续、正确处理编解码延迟 / padding；后者允许重叠并改变接缝内容。第二解码流是准备手段，不能把“听不见空白”同时当成两种功能的验收 | P1 / 规格修正；纯 gapless 是否必须同时保留两条完整解码流，留给音频实现决定，不从参考 UI 推导 |
| B2 “中段 headroom ⇒ 合成峰值不抬高” | `18-cuefield-automix-integration.js:564,594-598` 中点为两路各乘 `0.707… × (0.84 或 0.90)`。在两路同相、单位输入、`liveTarget=outgoingRatio=1` 条件下，和仍约 **1.188 / 1.273** | 保留它缓和交叉段响度的做法，但取消“保证不抬峰”承诺。验收至少同时覆盖不相关素材、相关 / 同相波形；若承诺不削波，需要峰值约束或 limiter，不能靠固定 10%–16% 留量证明 | P1 / 规格修正；这里是公式反例，不是对它真实输出发生削波的实测结论 |
| C5 “CompressionStream（Chromium 专有）” | `07-fx/00-preset-archive-data.js:884-891` 只有 `typeof CompressionStream/DecompressionStream` 特性检测；编码可不用压缩，压缩输入解码缺能力会抛错 | 改成**依赖目标宿主的压缩流能力，逐项检测**。本地代码不能支持“Chromium 专有”的浏览器归属判断；未压缩格式应作为可互通的基线，压缩码在不支持的宿主给明确说明 | P2 / 文档修正；未进行跨浏览器支持矩阵测试 |
| §6.1 GSAP “Standard License 不含再分发权能” | `public/vendor/gsap.min.js:1-8` 只声明 GSAP 3.15.0、版权和许可证链接，没有在本地头部给出这一禁止条款 | 将这句改读为**第三方资产，须核对适用许可证全文及用途；Mineradio 作者的同意不能替代第三方许可**。维持本项目无需引入 GSAP 的技术取舍，但不由文件头推出绝对禁止再分发 | P2 / 证据边界修正；本轮未作外部许可证全文核验，也不把旧判断反转成已获授权 |
| §7 的验证表述，以及“文件里有”被读成“产品已兑现” | 队列节拍预取开关为 false；报告提交前端不读回执；首页存在失效平台分支。相应位置分别见 F5、F4、G2 | §7 只描述上一轮证据。本轮明确分开**源码定义、入口可达、离线断言通过、实机体验**；测试里搜索到路由字符串不证明路由可用，定义了函数也不证明功能启用 | P1 / 文档修正；本轮置信度见 §11 |
| §6.2 “每请求重读 cookie” | `server.js:4636` 每请求调用的是 `refreshConfiguredCookieStores(false)`；`:327-340` 仅在 force 或文件路径变化时读盘，保存时同步更新内存；`:375` 为启动强制读取，`:2772` 另有 QQ 的显式 forceCookie 路径 | 删除“每请求重读”的性能指控，改读为**按配置路径缓存凭据内容，显式保存更新内存**。同路径文件被外部直接修改也不会因此自动重读，不能把“每请求调用 refresh”写成每请求 I/O。§6.2 同行的网络暴露、鉴权及写入失败吞错应分别判断，不因这一修正一并撤销 | P2 / 事实修正；已用读盘计数替身验证同路径连续调用不重读，未读取真实凭据 |

---

## 11. 本轮置信度与实施顺序

**直接核对过**：§8/§9 所列服务处理函数、任务与缓存状态、队列分页调用链、首页 HTML/CSS、控制台 schema / 搜索 / 历史、图片与视频生命周期，以及对应 hertz-studio 的页面和业务 owner。现有混合歌单、推荐分支状态、扫描取消、MediaSession、参数 schema、媒体释放均按代码视为**已有能力**，没有重复列成待建系统。

**离线验证**：2026-10-07，在 Mineradio 根目录执行：

```powershell
node --test tests/home-daily-recommendations-backend.test.js tests/home-daily-recommendation-virtualization.test.js tests/search-frontend-pagination.test.js tests/built-in-playlist-library.test.js tests/platform-account-sync-guard.test.js
```

退出码 0，**15/15 通过**。其中有真实函数沙箱执行、临时目录持久化，也有源码字符串 guard；它们验证推荐映射、窗口索引、搜索分页与身份约束、混合歌单读回，不证明平台在线可用，也不证明布局在各宿主下没有遮挡。没有启动 Electron、登录平台、发送听歌报告或进行音频听测；视觉结论来自 HTML/CSS 与事件代码，不冒充截图或性能测量。

**补充函数探针**：通过 PowerShell 的单引号 here-string 将脚本送入 `node`，用 `vm.runInNewContext` 抽取两个缓存工厂执行，未写入仓库。零 TTL 的结果：酷狗仍命中、汽水不命中；先写 A/B、读取 A、再写 C：两者仍淘汰 A；请求在途时 clear，再释放可控 Promise：酷狗不回填、汽水回填，断言通过、退出码 0。同次计算 B2 同相中点为 1.188 / 1.273。它们是原函数的受控行为证据，覆盖范围不扩大到在线服务。

**继续核对后的增量**：F7、G10、G11 来自登录弹窗、搜索历史和歌词校准的调用链；它们不把我们已有的扫码票据、搜索分页、本地歌词偏移重列成待建系统。为覆盖账号状态证据，将上面的命令追加 `tests/provider-login-state-recovery.test.js` 再执行一次，退出码 0，**25/25 通过**；包括暂时失败保留身份、过期要求重扫、确认后重新验证及共享搜索历史的离线断言。

**新做的受控复现**：在 hertz-studio 根目录用 `node` / `vm.runInNewContext` 加载完整 `plugin/ui/online-login.js`，DOM、定时器和 transport 全用替身。先发网易云 A 再发 QQ B，先释放 B 再释放 A：最终显示 A 的二维码，下一次请求却为 `source=qq&ticket=netease-fixture`；另开一次 A，在取码返回前 close，再释放 A：弹窗仍隐藏但又注册了一个轮询定时器。两组现象断言通过，说明缺口在当前意图的提交校验，不是定时器清理函数没执行；没有真实登录、授权或凭据写入，也未据此断言服务端账号串写。同次抽取 Mineradio 的 `refreshConfiguredCookieStore`，初始化读一次、同路径连续 5 次非强制调用仍只读一次，换路径及 force 各再读一次，退出码 0。

**先做这三小块**：F2 修正“播放全部”的范围承诺；F1/G2 把已有推荐状态接到独立每日页；G5/G6 在现有参数表上补搜索定位与撤销。前两块让现有能力说清楚，第三块减少调参试错成本。真正的队列续载排在文案修正之后；G4 虚拟化先有长列表测量；F4 耐久回执和 G9 视频持久化等出现实际产品需求再做。F3 不附带扩大平台上报范围的决定。

**新增排期修正**：F7 已有可控竞态复现，应与 F2 的语义修正同批优先，排在 G5/G6 体验扩展之前；不因它横跨取码与轮询就先扩平台接口。G10/G11 保持 P2，分别在统一搜索入口、改善在线歌词校准时实施，不能因本表新增便当作立即开工清单。

## 12. 实施后代码复核与本轮补齐（2026-10-08）

本节基于 `hertz-studio` 的 `09de7b7` **加当前工作区改动**，不是对旧十四批报告的转述。关联聊天用于理解意图；完成状态以代码、失败复现、当前检查与浏览器行为为准。开始时已有的工坊、粒子、手绘、本地库等未提交修改保留，本轮没有提交或推送。

### 12.1 原来哪些做得不对

| 问题 | 实际后果 | 本轮处理 |
| --- | --- | --- |
| `crossfade_ms` 原来只改变单流尾淡 | 看起来有设置，却没有两首歌重叠；暂停也可能沿用很长的歌曲淡出 | 两条独立解码缓冲由同一输出回调拼接/等功率重叠；暂停和停止固定 200ms |
| 集合首页 await 后才预留播放意图；补页取消没有归属 | 旧歌单迟到可能覆盖新队列，旧请求可能取消新会话 | HTTP/RPC 共用 `online_play.rs`；首页先预留意图，补页提交核对会话、来源、集合和游标 |
| 集合准备数使用抓取游标，重复/空页也可能被当完成 | 界面声称已准备的曲目数大于实际可播放数量 | 已准备数按真实入队项计算；异常页报中断并保留游标；2000 首上限明确显示 |
| 降档各有新 timeout，并从当前偏好推断失败档 | 一次播放反复重置等待预算，缓存命中或中途改设置后可能惩罚错误档位 | 取流降档共用总截止时间；提交实际档位及双代际，解码失败只消费匹配证据一次 |
| 普通上游故障也可能被解释成会员/档位限制 | CDN 失败造成错误“无权益”结论，后续播放被永久压低 | QQ 空 purl/CDN 失败返回上游错误；只有明确档位拒绝/解码失败可收紧每曲上限；会员未知单独呈现 |
| 换源时删除原曲元数据，且未排除队列已有目标 | 重复曲目或接力链丢失出处，覆盖另一队列项的身份 | 克隆并保留原快照，提交锁内再次核对目标未被其他槽占用；新直接播放重新建立自身出处 |
| 节拍许可没随异步任务存活；重试可删除正在运行的条目 | 名义上有并发限制，实际上额度提前释放，还可能重复分析 | 许可持有到落盘/状态裁决结束；手动重试保留在途任务；二进制缓存补溢出和非法时间校验 |
| 没拿到节拍预算时返回 analyzing，却既没任务也无后续事件 | 舞台一直等待，切歌后旧请求还可能改当前状态 | 前端有界退避重取、按曲目/请求代际作废；状态失败和手动重试均能恢复 |
| 歌单全部常驻 DOM；续载哨兵不在实际滚动容器 | 5000 首列表约 8.5 万子节点，哨兵可持续触发拉页 | 超过 120 项窗口化，保留原集合与绝对播放索引，支持焦点/键盘/重排；哨兵移入滚动容器 |
| 封面代理/解码完成后直接改元素，推荐卡只比较 id | 迟到旧封面覆盖新选择；同 id 元数据变化不更新；重排丢焦点 | 每元素意图校验，解码完成才提交，代理失败清旧图；推荐卡原位复用并保持键盘焦点 |
| Stage 每次 schedule 都清 lastFrameAt；歌词门又改写 lastDt | 真实刷新率估计被固定 60Hz/歌词累计间隔污染，30fps 档可能实跑约 82 次/秒 | 主循环保留续帧基准，以局部 frameDt 采样；HertzPerf 在既有帧门测实际次数和耗时 |
| 旧实施记录把 G1 写成已满足，把 C4/G7 又列成未做 | 后续排期重复建已有系统，却漏掉真正缺失的入口 | 重建本节状态表；继续播放卡与工坊分享码单独补齐，已有节拍打包/状态接口修正生命周期 |

### 12.2 当前状态，不把条件项混成未完成代码

| 条目 | 当前判定 | 代码或验收边界 |
| --- | --- | --- |
| A1 | 按当前授权模型适配 | `ProfileMembership::Unknown / Reported{level}` 区分资料未知与明确零级；旧 vip 字段只供显示。它不是已验证权益，不能拿来授予或拒绝音质 |
| A2/A3/A7 | 原前提尚不存在，未建立伪实现 | 当前 provider 取流响应负责授权，项目没有可证明权益范围/过期时间的统一权威端点。不能把账号资料包装成 TTL 权益表，也不能给按账号响应加跨账号通用缓存；这不是“等待用户批准”的阻塞项 |
| A4/A5/A6/A8/A9 | 已有能力保留，关键竞态已修复 | 总时限、有限接力、会话失败保留凭据、缓存键不带明文凭据、能力未验证标记；本轮重点验证 deadline、同曲重试、终结代际和错误分类。缓存不含凭据不等于本地文件自动具备跨账号重新授权语义 |
| B1/B2/B3 | 已实现可用文件的预备与衔接 | 0ms 为无重叠样本衔接，正值为等功率重叠、headroom及最终限幅；预备失败普通推进。精确 gapless 仅覆盖新旧源原生采样率均等于输出设备的情况 |
| B4 | 已补完整失败重试链 | 显示实际档位，同次取流降档及已提交流解码失败重试均有代际/预算/一次消费保护；网络故障不收紧上限 |
| B5 | 后续产品项 | automix 仍未实现；已有双流只是前置，不能据此声称节拍对齐、LRC 副歌选点和 op timeline 已完成 |
| C1/C2/C3/C4/C6；E1/E2/E3 | 已有能力保留并补齐验证 | 新全局探针和真实帧时钟；已有刷新率估计/像素预算/歌词时钟与遮罩；节拍二进制打包已存在，本轮修复非法缓存及任务生命周期 |
| C5 | 本轮已补齐 | 工坊基于 CreativeStage 原 owner 的版本化分享码；全量 payload 替代依赖可变默认值的 delta；未压缩为互通基线，gzip 逐项检测，保留 JSON 导入导出；44项字节/字段回归与浏览器竞态验证 |
| D1/D2/D3/D5/D6/D7/D8 | 复用并回归现有实现 | 聚合检查/负面不变量、panic编号与有界恢复、本地库事务/封面边界、出处记录和票据路径已有。本轮更新 ADR 与误依赖源码换行的 guard；没有声称做了真实进程崩溃注入 |
| D4 | 宿主形态不适用原断言 | 本项目是 HTTP 服务/DBX 插件，没有 Mineradio 的 Electron 主窗口 owner；“窗口先可见、导航失败重试恰好两次”应由真正创建窗口的宿主验证，不能在服务内伪造窗口时序 |
| F1/G2 | 已有，回归通过 | 每日推荐保留部分成功、按来源失败原因与跳转/重试；本轮修复卡片内容刷新和封面失败 |
| F2/F3 | 本轮补齐并修复 | 集合续载有真实计数、取消、重试、容量边界及双门面共同入口；换源保留用户选择出处，不把供音平台当原始身份 |
| F4 | 现有上报边界保留 | 有界去重/重试不等于离线持久化回执；当前没有离线补发产品要求，不新增持久化 outbox。平台实际累计仍需真实账号核对 |
| F5/G7 | 已有状态接口，生命周期已修复 | 分析、落盘、仅内存、失败、等待分开；当前曲目状态与手动重试；预算/单飞持有范围已验证 |
| F6/F7 | 已有，回归通过 | 持久化 DTO 版本/数量/字节边界；二维码与轮询使用同一登录意图，迟到结果不覆盖新平台/关闭后的界面 |
| G1/G3 | 本轮已补齐 | 曲库首屏继续入口；文案匹配队列/最近记录/空库动作；280–900px容器和双倍字号验证，复用主题令牌，不建第二套队列；完整服务验证继续播放、导航不暂停、重启后最近记录重放 |
| G4/G8 | 本轮补齐 | 长集合窗口化；队列键盘焦点保留，新增固定显示开关，独立于空闲 chrome，开关不触发播放命令 |
| G5/G6/G10/G11 | 已有，回归通过 | 参数搜索与撤销归 StageControl；关键词历史共享；在线每曲歌词校准与本地共用偏移 owner，不把全局偏移当每曲修正 |
| G9 | 卡片部分本轮修复；视频持久化仍按需 | 元素身份、代理/解码迟到和失败已覆盖；现有 ObjectURL 生命周期保留。跨刷新保存自选视频尚无产品前提，不把 Blob 塞进 settings |

### 12.3 验证口径与剩余风险

详细命令、退出码、截图和限制统一记录在 [本轮验收证据](../aegis/work/2026-10-07-mineradio-follow-through/90-evidence.md)。功能代码、离线模拟、浏览器运行和实际平台/声卡验证分别记账。

- 音频回调通过争用、样本时序、冷线程零分配/零释放测试；Shuffle、不完整缓存、采样率不适合精确拼接、响度归一化新旧增益不同等情况明确退回正常队列推进。未覆盖真实 MP3/AAC 编码延迟夹具和实体声卡听测。
- 5000 首浏览器列表对比：列表由 5000 行/约 85000 子节点/439.2ms 降至 20 行/342 子节点/约 2.6–2.8ms；封面模式保留 80 卡/322 子节点/约 2.6–3ms。它证明当前窗口化成本，不能外推所有机器的帧率。
- 探针直接测既有帧门；`gateRates().achieved` 是刷新率÷分频数的预算，不是已经执行的 runs/s。独立浏览器曾测得 163.94Hz 下 30fps 档实跑 26.9 次/秒，停止后不继续累计。
- 真实平台登录、VIP 到期、CDN 与打卡累计没有用用户账号执行破坏性或有副作用的验收。已有模拟回归不能替代这层证据。
- 服务验证使用独立构建、临时数据目录、随机端口和 null 音频后端；不关闭用户正在运行的 `target/debug/hertz-studio.exe`。

**架构对齐**：以上都是建议，未改变代码或接口；落点沿用 Rust 业务层、HTTP/RPC 双门面、audio actor 单写入、前端 IIFE 与既有 schema。没有形成新的架构决策，因而不据此新增 ADR。剩余不确定性是实机交互、音频接缝、平台返回语义和不同宿主的媒体 / 存储能力；成本与优先级仍是判断，不能当工期承诺。
