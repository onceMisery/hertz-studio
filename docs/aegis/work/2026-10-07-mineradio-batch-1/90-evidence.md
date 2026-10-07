# Mineradio 借鉴清单执行 · 第一批（F2/F7 → F1/G2 → G5/G6）+ F4/A4/D2

日期：2026-10-07 方案：`docs/research/mineradio-full-assessment.md`（§8–§11 的排期）
方式：Aegis 常规实现 + 契约检查，**不走 TDD**（用户指定）。每项实现后补行为断言并做变异验证。

## 1. 这一批改了什么

| 项 | 动作 | 落点 | 状态 |
| --- | --- | --- | --- |
| F2 | 「播放全部」不再承诺未加载的页：未取全说「播放已加载 N 首」，取全才说「播放全部 N 首」；筛选域另给一行说明 | `plugin/ui/online-playlist-view.js` `playLabel/queueLabel/scopeNote` + `online.css` | 已做（真整单续载仍未做，方案里排在其后） |
| F7 | 一次登录意图 = attempt + source + channel + ticket，取码/轮询/cookie 提交的成功·失败·收尾都核对归属；关窗即在途失效，迟到的票按它自己的 source 尽力作废 | `plugin/ui/online-login.js`（`intent`/`beginIntent`/`voidIntent`/`isCurrent`/`cancelTicket`） | 已做 |
| F1/G2 | 独立每日页消费后端已有的 `pending`/`skipped.kind`/`sources`/`age_secs`/`refreshing`：pending ≠ 失败、缓存 ≠ 刚抓、缺席来源与「已就位」同区报告，未登录旁挂「去登录」 | `plugin/ui/daily-view.js` + `style.css` `.dv-status*` | 已做 |
| G5 | `SCHEMA` 补 `aliases`，同一份表生成搜索索引；结果显示「分组 › 参数」+ 当前值，点击滚动居中 + 聚焦 + 短暂高亮；找不到给明确反馈 | `plugin/ui/stage-control.js` + `index.html` + `stage.css` | 已做 |
| G6 | 一次拖动/一段连按 = 一条历史（650ms 合并、同键合并），回退只写回改过的键，恢复默认算一笔，历史上限 40；外部 `set()` 不进视觉栈 | 同上（`beginEdit/endEdit/pushHistory/undo/applySet`） | 已做 |
| F4 | 打卡反馈措辞只承诺「已提交」，不承诺平台累计已增加（Rust 侧文档注释同口径） | `plugin/ui/app.js` `case 'scrobble'` + `state.rs:73` | 已做（耐久回执 P3，未做） |
| A4 | 一次取流加总时限 20s，到点整体取消并如实回 `upstream_timeout`（504，已有语义：Step 不跳曲、AutoNext 前进） | `online/mod.rs` `STREAM_DEADLINE`/`with_deadline` + `stream()` | 已做外层；**逐段 `min(段预算, 剩余)` 未接**（要 provider 报出自己的段，落在 8 个平台实现里） |
| D2 | 出处名负面不变量扫描：`Mineradio`/`VCPChat`/`vcp-` 整文件禁；`folia` 注释以外禁（标识符/字符串/HTML 可见文字）。进 CI | `scripts/check-lineage-names.js` + `.github/workflows/ci.yml` | 已做；顺带抓到并修掉一个真漏：`skins.js` 皮肤 `note` 把上游名写进了界面 tooltip |

## 2. 证据

前端（全部零依赖 Node 沙箱，无浏览器）：

```
check-online              243 checks, 0 failures          （+8 条 F7 竞态断言）
check-online-playlist-view 66 项全部通过                   （+4 条 F2 分页范围断言）
check-daily-view          103/103                          （+11 条 F1/G2 状态断言）
check-stage-control        89 项全部通过                   （+32 条 G5/G6；模块整块进 vm 沙箱真跑）
check-lineage-names        523 文件 / 4.0MB 零命中
check-assets 678 · check-css-tokens · check-skins 679 · check-favorites 179 · check-appearance-restore 45 ·
check-plugin-assets 52 · check-creative 341 · check-stage-idle 29 · check-obs-css 53 · check-stanza* · check-sonnet-palette · api-routes --check → 全绿
```

Rust：`cargo check -p hertz-studio` 通过；`cargo test -p hertz-studio` **294 通过 / 0 失败**（含新增 `stream_deadline_cancels_an_overrun_attempt_and_keeps_a_fast_one`）；`cargo clippy -p hertz-studio --all-targets -- -D warnings` 干净；`cargo fmt -p hertz-studio -- --check` 只剩改动前就有的两处（`online/mod.rs` 既有能力闸门测试、`playlist_common.rs:50`），本次新增行都是规范形。

变异验证（每项都确认断言会红）：
- F2：把「播放已加载」改回「播放全部」→ 2 项失败。
- F7：用 HEAD 版 `online-login.js` 跑新断言 → 5 项失败（正是方案 §11 复现的 A 覆盖 B、关窗复活轮询）。
- F1/G2：把 pending 文案改成失败文案 → 1 项失败。
- G5：删掉 chroma 的 `紫边` 别名 → 「别名命中」失败（证明走的是别名而不是 label 子串）。
- G6：断掉 `endEdit` 记账 → 7 项失败；去掉合并窗 → 「同键连按只占一条历史」+「撤销一次回到整段之前」失败。
- D2：注入 `'folia 式'` 字符串 + `// mineradio` 注释 → 两条各自被抓，而纯注释的 `folia` 放行。

## 3. 明确没做 / 边界

- F2 的真整单续载（`AppState` 持集合来源 + 游标 + 队列代际）排在文案之后，本批没动队列 owner。
- A7 的响应缓存原语（`online/memo.rs`）本批没建：现在没有正当消费者——`http.rs` 的响应多数是**按账号**的， blanket memoization 会把 A 账号的结果发给 B。要落先落权益缓存（A2），别先落通用层。
- A1/A2/A3（权益三态 / 分档 TTL / 结果侧复核）、A6 的 `reauthRequired` 三态、A9 的能力「未验证」档、B 组听感全部、C 组六个可搬单元、§5.1 帧门语义、D1/D3/D4/D5/D6/D8、F3/F5/F6、G1/G3/G4/G7–G11 未开始。
- 审计（子代理，file:line 已复核）当前状态：A1 二值（`mod.rs:350-361`，`kugou.rs:996` 缺省当非会员，`kuwo.rs:466`/`qishui.rs:927` 硬写 0）；A2 无权益缓存（`mod.rs:990-1001` 每次现拉）；A3 只有码率诚实（`progressive.rs:763-782`、`state.rs:1325` 只进 diaglog）；A5 内容键去重已在 `state.rs:2599-2611`，但 `relay_tried` 记的是虚拟 id（`state.rs:2040-2047`）；A6 安全的一半成立（`cred.rs:114-127` 只在显式退出时清），缺 `is_signed_in` 三态；A8 干净（缓存键不含凭证；副作用是 VIP 取到的无损文件会发给未登录会话）；A9 `Capability` 14 元平铺 + `gate()` 二值，「代码已接线等真机」只能摘能力位（`mod.rs:408-410`）。
- 浏览器形态检查（`check-daily-strip.js`、`check-skin-fixes.js` 等）本机 `require('playwright')` 解析不到，需要 `PLAYWRIGHT_MODULE` + 起着的服务；本批未跑，功能验收要看应用（见下）。

## 4. 用户自行验收要看哪里

1. 在线歌单详情（只加载一页时）：按钮应写「播放已加载 N 首」，筛选后下方多一行「筛选只在已加载的 N 首里查找，还有 M 首未加载」。
2. 扫码登录弹窗：连着点两个平台（第一个慢）、或取码转圈时直接关窗——不该出现「显示 A 的码却按 B 轮询」，也不该关窗后后台还在轮询。
3. 每日推荐页（在线来源）：某平台超时/未登录时，已拿到的曲目照常可播，上方一行说明缺席原因 + 「去登录」；命中缓存时写「这批推荐抓于 N 分钟前」。
4. 舞台控制舱：搜「暗角 / 紫边 / 运镜」应命中并跳转；拖一根滑块后底栏「撤销」亮起来，一次拖动退一次（Ctrl+Z 同）。
5. 网易云在线曲打卡成功后的提示应是「已提交网易云听歌记录：…」。

---

# 第二批（同一会话续做）：A6 与 A5

## 5. 这一批又改了什么

| 项 | 动作 | 落点 | 状态 |
| --- | --- | --- | --- |
| A6 | 账号探测分三态：只有 `auth_required`/401/403 才算「这台没登录」；上游 5xx、超时、无 status 的网络故障一律 `unknown` → 保留上一次身份、不清已取到的歌单、不把卡片翻回「扫码登录」、不催重扫。服务端「探测失败绝不删凭证」这一半本来就成立（`cred::clear` 只有显式退出这一个调用者） | `plugin/ui/online.js` `accountVerdict`（单一判据 owner）+ `online-playlists.js` `refreshAccount/paintProbeUnknown` + `online-login.js` `loadAccounts` + `online.css` `.op-stale` | 已做 |
| A5 | 接力去重改成**身份键**：候选排除从「按虚拟 id 记仇」改成 `normalize(title)|sorted(artists)` **+ 音源**；同一平台换个 id 的同名条目（重编码/翻唱）不算第二次机会，换一家音源仍算。选择逻辑抽成纯函数 `pick_relay_candidate` 才测得动 | `crates/hertz-studio/src/state.rs` `RelayMemory`/`relay_identity`/`pick_relay_candidate` | 已做 |

**方案的这句要修正**：§4 A5 写「去重用 `title|sorted(artists)` 内容键而非 id」，验收写「同一首歌在两平台出现只试一次」。照字面读会得出 Reading A（一首歌跨平台只许试一次）——那会当场废掉换源接力这个功能。读了参考实现本身（`11-provider-fallback.js:311-317/375-376/421-428/594-595`、`tests/playback-source-fallback-transaction.test.js:134-135/157-160`）：它用**两张表**，身份键那份只管*队列前进*（别跳到队列里另一处同一首歌），provider 尝试那份是 `身份|音源`，所以换一家当然是新机会。我们落的是后一张表的语义（本项目队列前进已有 `streak_cap` 管着，无需再叠一层身份限制）。

**A1/A2/A3 的前提不存在**（已把结论写进任务 5）：档位来自用户逐源偏好，`stream()` 全程不查权益，所以「权益探测失败 ⇒ 悄悄降档」这条路径我们走不到；照搬要先新建一个权益门。A1 真正要的「探测失败不作授权断言」已经在 A6 落到了我们唯一按账号态分支的地方。A7 的通用响应缓存同理——`http.rs` 的响应多按账号，blanket memoization 会跨账号串数据，正当消费者是权益缓存本身。

## 6. 证据（第二批）

```
check-online   269 checks, 0 failures   （+14 条 A6：分类表 / 504 保留身份 / 401 才翻面 / 弹窗 tab 两态）
cargo test -p hertz-studio  288 passed / 0 failed   （+2：relay_memory_* / relay_candidates_dedup_*）
cargo clippy -p hertz-studio --all-targets -- -D warnings  干净
cargo fmt -p hertz-studio -- --check  只剩改动前就红的三处：online/mod.rs:1714、playlist_common.rs:50、qq.rs:608（都不是本次代码，别混进提交）
```

变异验证：
- A6：注掉 `online-playlists.js` 的 unknown 分支 → 3 条断言红；注掉 `online-login.js` 的 `prev[s.id]` 保留 → 2 条红。
- A5：把 `holds_provider` 判据短路 → 「同平台换个 id 的同名条目不算第二次机会」红（`left: qq / right: netease`）。**这条第一次是空测**：候选页顺序让 netease 恰好先出现，去掉去重也还是选 netease；把 qq 排到前面并补一条「只按 id 记仇时选中 q2」的对照断言，变异才会红。
- A6 的分类表里 `capability_unsupported` 单独一档，`{}` 无 status 归 unknown：两条都直接跑在 `Online.accountVerdict` 上，不靠注释。

## 7. 第二批的用户验收点

1. 在线面板某平台账号接口挂了（拔网线/平台 5xx 再进「在线」）：账号卡应保留昵称并多一行「账号状态暂时读不到…不代表未登录」，歌单网格不许被清空；恢复后自动回到正常态。
2. 真正未登录（cookie 过期后平台回 401）：照旧翻回「扫码登录」卡，旧昵称消失。
3. 队列里某首在线曲放不了触发换源接力：若同一平台列了同名条目的第二个版本，不该再多等一轮去试它（看 `output/…/playback.log` 的 `relay.hit` 的 `to=`，或观察换源次数）。

---

# 第三批（同一会话续做）：A9 能力第三档

## 8. 改了什么

**后端**（`crates/hertz-studio/src/online/mod.rs`）
- 新增 `UNVERIFIED_CAPS` 注解表 + `unverified_caps(source)`：`caps` 说「放行吗」，这张表说「这条链路有没有真机验收记录」。三档语义写死在注释里——不在 caps = 不支持（404）；在 caps 且在这张表 = 实现了、放行、但没验过；在 caps 不在表 = 有验收记录。
- `/v1/online/sources` 载荷新增 `unverified` 字段（HTTP `routes.rs` 与 RPC `rpc/online.rs` 共用 `list_sources`，两处同时出线上）。
- `gate()` 行为**不变**：未验收不等于禁用，用户仍可试，失败按既有路径如实报错。
- 数据只填代码注释自己说「待真机」的两条：`kugou → QrLogin`（create/waiting 真机正常，confirmed 换票链路无记录）、`qq → QrLogin`（只验到 waiting）。没写「我觉得没验过」的条目。
- 为什么用叠加注解表而不是给 `SourceInfo` 加字段：加字段要改 8 个字面量，且新源可以顺手填 `&[]` 蒙过去；注解表配三条不变量测试（子集、id 必须存在、表不许空）能挡住静默失效——id 写错不会编译失败，只会让那个源悄悄变成「全验过了」，所以这条必须由测试守。

**前端**（唯一 owner 在 `online.js`）
- `Online.isUnverified(src, cap)` + `Online.markUnverified(node, src, cap)`：给按能力位生成的控件加「未验收」小标签 + title + `.is-unverified`。判重用 `node.dataset`，不用 `querySelector`（宿主与契约桩对它的实现宽窄不一，靠它判重会失灵）。
- 接入点：在线面板账号卡的「扫码登录」「cookie 登录」按钮（`online-playlists.js`），登录弹窗的源 tab（`online-login.js`）。全仓只有这三处消费 `qr_login`，皮肤没有第二个入口。
- 缺 `unverified` 字段 = 空表：旧服务端没有这条声明时不许凭空长出标注。

## 9. 证据（第三批）

```
cargo test -p hertz-studio  290 passed / 0 failed   （+2：unverified_annotations_subset / sources_payload_carries_axis）
cargo clippy -p hertz-studio --all-targets -- -D warnings  干净
cargo fmt -p hertz-studio -- --check  只剩改动前就红的三处：online/mod.rs:1807（能力闸门测试）、playlist_common.rs:50、qq.rs:608
check-online  281 checks, 0 failures               （+12 条 A9：判据表 / 标注可见 / 同源 cookie 不被连带标 / 没声明的源零标注 / 弹窗 tab 同一口径）
check-skins 679 · check-assets 686 · check-css-tokens 1846 规则 · check-plugin-assets 52 ·
check-lineage-names 524 文件零命中 · check-favorites 179 · 均绿
```

变异验证：删掉 `markUnverified(qr,…)` 调用 → 4 条红；把判据的 `src.unverified || []` 换成回落到 `src.caps` → 「没声明的源一个标注都不该有」「不许凭空长出标注」红；从 `UNVERIFIED_CAPS` 删两条表项 → Rust 两条测试同时红（含载荷断言打印出 `"unverified":[]`）。

## 10. 第三批的验收点

1. 「在线」面板里酷狗音乐与 QQ 音乐的「扫码登录」按钮：带虚线描边 + 「未验收」小标签，悬停说明是「还没有真机验收记录，可能不可用」；网易云的按钮没有标注。
2. 扫码登录弹窗未登录态的源 tab：酷狗/QQ 的 tab 上有同一个「未验收」标签。
3. 点进去仍能正常发起扫码（这一档不禁用），失败时按原有路径如实报错。

---

# 第四批（同一会话续做）：D1 聚合检查入口

## 11. 改了什么

- 新增 `scripts/check-frontend.js`：一条命令按 **语法 → 静态 guard → 行为回归 → 活体** 四阶段跑完。默认集合与原 ci.yml 那一步的 21 条严格等价（不多不少），`--extra` 加 12 条只在本地跑的无浏览器检查，`--live` 追加需要真浏览器 + 起着的服务的检查，`--only <名字>` 单跑一条。
- `.github/workflows/ci.yml` 的 `Frontend contract checks` 换成 `run: node scripts/check-frontend.js`；原来贴在那里的「这一步在防什么失败」搬进脚本的 `why` 字段（本地跑失败时连带打出来，注释不再是只有读 YAML 才看得到）。
- 语法阶段先跑的理由：一个文件写坏了会让十几个 vm 沙箱各报各的怪错，第一条红才是唯一有用的那条。

**顺带发现（未擅自改）**：`check-daily-view.js` 等一批无浏览器检查本地全绿但 **CI 不跑**，其中就包括本会话新加断言最多的那条（每日页状态解释）。把它们提进 CI 是覆盖率收益，但要先确认在 CI 环境也稳（本仓库 CI 有「一加就红」的历史），所以先放进 `--extra` 由本地跑，等用户点头再提。

## 12. 证据（第四批）

```
node scripts/check-frontend.js                 EXIT=0  通过 21 步 / 失败 0（127 个文件语法全过）
node scripts/check-frontend.js --extra         EXIT=0  通过 32 步
node scripts/check-frontend.js --extra --live  EXIT=0  活体 14 项按环境探测整体跳过，不算假红
python -c yaml.safe_load(ci.yml)               步骤序列完好（Frontend contract checks → Check formatting → Clippy）
```

聚合入口自己的三条失效路径都被测过（不是「看起来能用」）：
- 真失败会红：把 `daily-view.js` 的 pending 文案改回「这次没拿到」→ `--only check-daily-view` **EXIT=1**，并打出「这一步在防的失败：…pending ≠ 失败…」。
- 空匹配不许报绿：第一版 `--only nosuchscript` 静默 `通过 0 步，失败 0 步` 还 EXIT=0 —— 聚合入口最坏的失效就是「跑了个空却报绿」，已改成显式报错 + 列出可选名字 + EXIT=1。
- `--only` 不被 `--extra` 挡住：第一版把 EXTRA 关在 `--extra` 后面，`--only check-daily-view` 跑出 0 步。这两条都是写完才测出来的 bug，不是设计。
- 环境缺件不算产品失败：playwright 没装 / 服务没起时报 `–` 跳过并单列计数，不与 `✗` 混在一起（否则本地一条 --live 得到一排假红，人就开始忽略这套检查）。

## 13. 剩余没做（同一份方案的其余部分）

A7（响应缓存原语，正当消费者是权益缓存）、A8（已核：干净，缓存键不含凭证）、A1/A2/A3（见任务 5 的前提分析）；B1–B5 听感全部；C1–C6 六个可逐字搬的单元；§5.1 帧门整数分频语义（先要 C1 探针实测 runs/s）与 §5.2 overlay 那条无节流 rAF；D3/D4/D5（启动可观测性、注入故障时序断言、本地库崩溃一致性）、D6（ADR 决策日志，`docs/aegis/adr/` 仍空）、D7（已核：NOTICE 现有格式就是它要的模板，本会话还补了这批的出处段）、D8（票据/cookie 采集两条安全模式参照）；F2 的真整单续载、F3/F5/F6；G1/G3/G4/G7–G11。

---

# 第五批（同一会话续做）：§5.1 帧门语义 + C2 刷新率估计 + §5.2 overlay 节流

## 14. 改了什么

- **C2（零依赖，可逐字搬的那块）** 落到 `plugin/ui/stage.js`：rAF 间隔的中位数 + EMA，把 59.94/119.88/143.98 吸附回 60/120/144；异常间隔（≤2ms、≥200ms）不进样本。
- **§5.1 的语义改动**：`runGates` 从「按毫秒累积、够点清零」改成**每 N 个 rAF 给一帧**，`N = max(1, ceil(实测刷新率 / 目标))`。
  - 用 `ceil` 而不是方案写的 `round`：帧率是**预算**（弱机才往下调），`round` 会让「60Hz 上要 48」兑现成 60 —— 比用户要的多做 25% 的活；`ceil` 永远不超过预算，代价是拿不到恰好 48，而 60Hz 上本来就不存在 48fps 这个整数分频（这正是旧实现谎报档位的根因）。这一条是对方案的有意偏离，写在 `gateDivisor` 的注释里。
  - `0` 仍然是唯一的停机依据，没有采纳参考项目那套 `0 = 不封顶`（语义相反），也没有搬它的 credit 累加。
  - `tickFn` 拿到的仍是累积真实毫秒（`wait`），lerp 语义不变。
- 新增 `Stage.gateRates()` / `Stage.displayHz()`：声明值、N、实测刷新率上真正跑到的帧率。任何写「48fps」的界面文案必须改读这里，不许再读声明值。
- **档位表里除不尽的数全部换掉**（它们以前从没兑现过）：creative-stage `TIERS` 30/40/48 → **20/30/60**，暂停 trickle 8 → 6；stage-particles `TIERS` 18/26/34 → **15/20/30**；stage.js `lyricsTargetFps` 24/40 → **20/30**；stage3d 的 `stage3d-ui` 门 8 → 10；handdrawn `HZ` 16 → 15。规则：只取 60 与 120 的公因数。
- **§5.2 第一条**：`overlay.html` 那条自己起的 rAF 循环原本无任何节流（OBS 里可能跑在 144Hz 屏上、而数据 500ms 才更新一次），现在走同一条帧门规则（本地一份估计器，注释写明为什么是两份：独立文档、无构建步骤、import 不到主应用）。
- 新增 `scripts/check-frame-gates.js`（已进聚合入口，因此进 CI）：把 `sampleDisplayHz`/`gateDivisor`/`runGates`/`anyGateWants` **从 stage.js 整段抠出来执行**，钉四件事 —— 换算的上下界（对 60/72/90/120/144 × 目标 1–240 全扫）、给帧间隔恰为整 N 帧不抖不漂、报 0 停机且累加器归零、声明档位必须同时整除 60 与 120。

## 15. 一个顺带修好的意图错位

`creative-stage.js` 探测期强制满帧那条写的是「探测期间强制满帧」，实际返回的是 `TIERS[].fps`＝48 —— 探测窗口本身在被帧门掐。档位改成 60 之后这句话才成立。另外 `budget = 1000 / TIERS[tier].fps` 那条代价探测阈值随之变严（tier2 从 20.8ms 变 16.7ms，容差 ×1.35），含义变成「撑不住满帧就降 DPR」，与它上面那段「降 DPR 保帧率」的原则一致，而不是原来对着谎数标定的 28ms。

## 16. 证据（第五批）

```
node scripts/check-frame-gates.js          37 项全部通过
node scripts/check-frontend.js --extra     33 步全绿（新增这一步之后从 32 → 33）
```

变异验证（都确认会红）：`gateDivisor` 换成 `Math.round` → 上下界扫描在 5 个刷新率上同时报「超过预算」；把 creative `TIERS` 的 60 改回 48 → 「不是 60 与 120 的公因数」红。
**检查自己也被测出两个错期望**（不是产品错）：目标高于刷新率时「兑现成刷新率本身」不该算掉一半；144Hz 上 30 的最近整数分频是 5（28.8fps）而不是 round 出来的 4（36fps）—— 两条都改了断言，没改实现。
新检查还顺手抓到**我自己刚写进去的**出处名泄漏（注释里引用了那份评估记录的原始文件名），已被 `check-lineage-names` 拦住并改掉。

## 17. 还需要实机的一点

`displayHz` 估计器在真浏览器上的收敛与稳定性（rAF 抖动、外接显示器热插拔、144Hz 与 60Hz 混屏）只能靠 `--live` 那批浏览器检查或开着服务看，本地无浏览器跑不了。`Stage.gateRates()` 是这条的观测口：控制台打 `Stage.gateRates()` 应看到 `divisor` ≥1、`achieved === displayHz/divisor`、且 `achieved ≤ target`。

## 18. 剩余没做（更新后的清单）

A7、A1/A2/A3（任务 5 的决策）；B1–B3、B5 听感全部；C1（跨模块 perf 探针，本次用「抠函数执行」的检查替代了它想提供的测量，界面里的全局 `mark/markSince/topByTotal` 仍缺）、C3–C6；§5.1 的实机收敛（上一节）；D3/D4、D6；F2 真整单续载、F3/F5；G1/G3/G4/G7–G11。B4 见下一批：单调上限与可见降档已做，**同一次播放里就地重试下一档**没做。

---

# 第六批（同一会话续做）：D5 本地库崩溃一致性（封面落盘）

## 19. 改了什么（`crates/vmusic-library/src/lib.rs::save_cover`）

先核过 D5 四条在我们代码里的实际状态，只对**真有缺口**的两条动手：

| D5 的四条 | 现状 | 处置 |
| --- | --- | --- |
| staged temp → rename 两阶段 | 原来直接 `fs::write(目标路径)`：先截断再写，进程死在中间就留下半截 jpg，而库里 `has_cover=true`，症状是「封面永远碎掉」；重扫时文件签名没变，还不会重写它 | 改成同目录 `.{name}.part` 写完再 `rename`；rename 失败删临时件并回 None |
| 封面按**像素尺寸**（不只字节）拒绝 | 只有 `data.is_empty()`。ID3 里 1×1/32×32 的占位图与「图标」附件都是几百字节，按字节放得住；`complete.rs` 那条远程封面还是**按 URL 后缀猜媒体类型**，服务端回一句 HTML 也会被当 jpg 存进封面缓存 | 加图片头部解析（PNG / JPEG 含渐进式 SOF / GIF / WebP 三种子格式，不引图像解码库）：签名与声明格式不符直接拒；读得出尺寸时任一边 < 64px 拒；读不出尺寸但签名对 → 放行（宁可留糊图，也不把用户本来有的封面变成没有） |
| 变更串行化 | 扫描侧有签名比对 + `cover_edited` 保护用户封面 | 未动 |
| 「解析失败保住上一次索引与封面」写成断言 | `scan.rs:332` 起注释与实现都是「parse/stat/store 失败保留上一行」 | 已实现，本批没重复造轮子 |

**顺带修掉的孤儿泄漏**：重打标签把 jpg 变 png 时，旧那份留在 `covers/` 里再没人引用也没人删。现在写完新格式后清掉同 id 的其它扩展名；测试逐个数目录内容（`cover_names`），`.part` 残留和孤儿都会被数出来。

## 20. 证据（第六批）

```
cargo test -p vmusic-library   13 passed / 0 failed  （+3：尺寸读法、像素与签名闸门、原子写与不留孤儿）
cargo test --workspace          全绿（含 hertz-studio 290）
cargo clippy --workspace --all-targets -- -D warnings  干净
cargo fmt -p vmusic-library -- --check  无 diff（只对这个文件跑 rustfmt，改动全在 616 行之后我新写的测试里）
```

变异验证（三处各打一刀，都变红）：`MIN_COVER_EDGE 64→8`、把 `plausible_cover` 闸门退回只查 `is_empty`、删掉旧扩展名清理循环 → 后两条测试失败。

写测试时自己先错一次：合成的 PNG 签名少写一字节（7 而不是 8），尺寸读成 `307200` —— **报错的是夹具不是实现**。这类「测试红先怀疑实现」在这里是反的，记下来。

## 21. 已知边界（没假装解决）

- 「中途被杀不留半截文件」是结构性保证（先写 `.part`，`rename` 原子），我没有真崩溃注入测试——那是 D4「注入故障的启动时序断言」的活，未做。
- 封面键仍是 `track_id` 不是内容寻址：`save_cover` 注释写了理由（重扫原地覆盖、不积孤儿）。改内容寻址要动 `has_cover` / `coverUrl(id)` 与既有缓存，超出 D5 那条「缺的是断言」的判断，本批没做。



---

# 第七批（同一会话续做）：F6 持久化 DTO 的数量与长度边界

## 22. 改了什么

新增 `crates/vmusic-store/src/limits.rs`：数量/长度常量 + 两个闸门（`check_len` 按**字符**数不按字节、`check_count`），并把它们**前置**到三个可被外部载荷喂满的入口：

| 入口 | 原来有的 | 原来缺的 |
| --- | --- | --- |
| `backup::restore` | 版本闸门、必填字段校验、单事务失败整体回滚 | 任何数量与长度上限：一个字段合法但体量无限的 JSON 能安静撑大用户库（4MB 的 base64 封面字符串在 SQLite 侧完全合法） |
| `playlists::add_entries`（整盘加入歌单） | 去重、position 递增 | 批量条数与快照字段长度 |
| `backup::import_m3u` | 首行 `#` 宽松识别、按路径匹配 | 内容字节上限、歌单名长度 |

边界为什么这么定（都留了一个数量级以上的余量，不做贴身裁剪）：单歌单 20 000 首、整份备份 100 000 首、歌单 500 个、收藏 20 000 条 —— 与本仓库既有断言「几千首的歌单不该被截断」（`ONLINE_META_CAP` 的同一条理由）同级之上。`cover` 限 4096 字符是因为它只该放 URL：图本身走封面缓存目录（D5 那批），进数据库就是把缓存当数据。`settings` 只限**键数**不限单值大小 —— 单值是自由 JSON（创作预设库会成批量写进来），体积由 HTTP 层请求体上限兜，这一层管的是「键数量爆炸」那种不是自由度的东西。

原则一句话：**先验完再动手**。所有检查都在任何写入之前做完，所以越界载荷一条都进不了库。这比事务回滚更强：回滚只保证不留半成品，不保证你愿意为一次失败付出一整轮写入与锁。

## 23. 证据（第七批）

```
cargo test -p vmusic-store    44 passed / 0 failed  （+4：limits 两条 + restore/m3u/add_entries 边界三条，其中一条含「界内必须照常恢复」）
cargo test --workspace        全绿
cargo clippy --workspace --all-targets -- -D warnings  干净
cargo fmt -p vmusic-store -- --check  0 diff（HEAD 版 backup.rs/playlists.rs 先确认过是干净的，所以 rustfmt 只会动我写的行）
node scripts/check-frontend.js --extra  33 步全绿
```

变异验证：把 `check_snapshot_strings` 里的封面长度闸门换成空操作 → `restore_rejects_oversize_payloads_before_writing_anything` 立刻红（越界条目被真写进库）。

写测试时又自己错一次（记录价值在这儿）：m3u 夹具按 11 字节/行算重复次数，实际一行 9 字节，构造出的载荷**根本没越界**，于是测试慢吞吞真去导入了 70 万行才失败。补了「夹具本身要真的越过上限」这一条断言，防止同一个坑再被踩。

---

# 第八批（同一会话续做）：B4 每轨单调的运行时音质上限 + 降档可见

## 24. 改了什么

先核对现状，发现**已有一半**：`PlayOutcome.actual_quality` 走的是真正交付字节那一档（`view.actual_quality()` 优先，取流响应给的请求档兜底），HTTP/RPC 两边都回传，`online.js` 拿它写顶栏技术芯片并在档位与偏好不符时 toast。缺的是另一半：

| 缺口 | 具体形态 |
| --- | --- |
| 没有每轨上限 | `play_online` / 预取 / 解码收口 / 节拍分析找缓存文件，四处都按 `quality::get(prefs, source)` 裸算档位。一首在无损上失败过，第二次重试**原样**再撞无损：再等一次数秒的取流、再失败一次、再跳一曲 |
| 降档提示整页只说一次 | `online.js` 用 `window.__qtoast` 一个布尔做去重，第一次之后整页静默 —— 第二首被降档的歌就又变回「听着不太对」 |
| 失败与档位的因果只留在日志 | `diaglog` 有 `stream.fail` 的 code，但没有「这首之后只按低档试」这条决定，用户端一句提示都没有 |

落地：

- `online/quality.rs`：`Quality::one_down()`（借已测过的 `descending_from`，只走一格）、两个纯函数 `lower_ceiling(prev, failed_at)`（退到失败档的下一格，**只降不升**，返回 `None` 即整表不动）与 `clamp_request(want, ceiling)`（夹取只往下）。
- `state.rs`：`quality_caps: Mutex<BoundedMap<Quality>>`（`QUALITY_CEILING_CAP = 4096`，沿用 `online_meta`/`stage_beats` 那套「写入即最新」逐条淘汰）+ `online_quality_for(source, track_id)`（偏好夹上限，四个取档点唯一的入口）+ `note_quality_failure(track_id, code)`（记档并 `publish(WsEvent::QualityDowngraded)`）+ `ceiling_eligible(code)`。
- 接线：`play_online`、`spawn_prefetch`、`handle_decode_failure`、`stage_beats::resolve_audio` 四处改走 `online_quality_for`；两处失败收口（`online_failed`、`handle_decode_failure`）各记一次档。
- 前端：`app.js` 新增 `case 'quality_downgraded'`，措辞带上掉下来的那档与去处的那档；`online.js` 的去重改成按「这一首 + 这一档」（`qualityNoticeOnce`，导出以便真跑）。

三条判断值得单独记，因为它们是本批真正的决定而不是搬运：

1. **哪些失败算档位的错**。不收的三类各有理由：`upstream_timeout`/网络 —— 换档救不了网络，把一次抖动记成永久上限是白丢音质；`not_found` —— 下架的曲退到哪一档都放不了，那是接力/跳曲的活；`auth_required` —— 那是**账号**级证据，owner 是登录流程与上一批的会话三态，记到每首歌头上会让整批 VIP 曲在一次未登录尝试后被永久压低。参考项目同一条规则（`login_required` 直接不进降档重试）。收的是 `vip_required`/`upstream_rejected`/`internal`/`decode_stalled`。
2. **反复失败要一格格往下退，不是原地不动**。失败档由 `online_quality_for` 反推（`online_failed` 那里只剩错误、没有档位），所以第二次失败发生在**已被夹住的那一档**上，于是再退一格、再说一次。四档封顶，最多退三格。这让「上限只降不升」与「逐级退档」同时成立：抬高永远不发生，退档有边界。
3. **就地重试没做**。同一次播放里再发一轮低档取流听着更顺，但 `online_failed` 已经是所有在线失败的唯一收口点，且它手上还有接力（换源）这条更值钱的支路；在它之前插一条「同曲降档再来一遍」会把「谁决定失败之后干什么」拆成两个 owner。现在的形态是：失败当场记档 + 当场说清，下一次尝试（手动重播/列表循环/预取）自动按低档走。

`stage_beats` 那一处顺带修掉的不只是新账：`cache_index.find` 按精确档位找文件，阶梯降级落盘的文件早已挂在实测档位下（`relabel_key`），所以「被降档那首没有节拍镜头」这个 bug 在 B4 之前就存在，本次因为它变成了必然发生而被抓住。

## 25. 证据（第八批）

```
cargo test --workspace                 全绿（hertz-studio lib 296 passed / 0 failed）
  新增：quality.rs 三条（one_down 只走一格 / ceiling_only_moves_down 六种前值组合 / clamp_request 不许往上夹）
        state.rs 三条（ceiling_eligible 的码表 / 逐级退档整链路含提示次数 / 上限按曲目不按源）
cargo clippy --workspace --all-targets -- -D warnings  干净
rustfmt --check（只跑本批动过的四个文件）  0 diff
node scripts/check-frontend.js --extra   34 步全绿（+1：新增 check-quality-ceiling.js，已进 CI 的默认集合）
node scripts/check-quality-ceiling.js    26 项全通过
```

`check-quality-ceiling.js` 是本批新写的，因为**单元测试够不到接线**：Rust 那边是直接调用 `note_quality_failure` / `online_quality_for` 测的，少接一个失败收口点只表现为「某一类失败永不降档」，少接一个取档点只表现为「某条路径绕开上限照旧撞高档」，两种都不报错。它钉五件事：四个取档入口都走 helper（含数一遍裸读 `quality::get(&prefs` 只剩 helper 内那一处）、两处失败收口都记档、`ceiling_eligible` 的码表不许顺手复用接力那份（`auth_required`/`not_found`/`upstream_timeout` 出现即红）、serde 发出去的事件名与 `app.js` 的 `case` 对得上且措辞带两档、`window.__qtoast` 那种整页一次性抑制不许回来（`qualityNoticeOnce` 从真实模块里抠出来在 vm 里跑：同一首同一档只一次、换首照说、同一首再掉一格照说、空键不占额度、表重置后仍可再说）。

变异验证 14 条，全部让检查变红（`.mut-b4.js` 一次性驱动器，跑完已删）：

| 变异 | 抓到它的检查 |
| --- | --- |
| `online_failed` 里不记上限 | check-quality-ceiling |
| 预取绕开上限裸读偏好 | check-quality-ceiling（裸读计数 + helper 调用数） |
| 节拍分析按原始偏好找文件 | check-quality-ceiling（两处） |
| 前端分发写错事件名 / 措辞只留一句 / 不带 msg.title | check-quality-ceiling |
| 退回 `window.__qtoast` 一次性抑制 | check-quality-ceiling（负面扫描按「赋值 + 取反」的形状，注释里提这个名字放行——它记的正是这条禁令的来由） |
| 去重改成只按曲目（换档不再提示） | check-quality-ceiling（vm 真跑那条断言） |
| `auth_required` 也降档（JS 侧 + Rust 侧各一次） | check-quality-ceiling / cargo test |
| 上限允许抬高（两种写法：一律不动 / 反向比较） | cargo test（quality + ceiling 两组） |
| `clamp_request` 取较高者 | cargo test |
| 提示不带掉下来的那档 / 干脆不 publish | cargo test |

写测试时我又错两次，都是「断言按想象写、不按实现写」：一是 `lower_ceiling(Some(Exhigh), Hires)` 我按「应当降」写期望，实际已有上限更低必须不动 —— 实现是对的，夹具错了；二是我以为「同一首再失败一次」不该再退档，于是断言提示只发一条，跑出来是 Exhigh。第二次不是笔误：它暴露出失败档由 `online_quality_for` 反推时，重复失败会**逐级往下退**，而这恰好是想要的语义（每退一格都说一次，四档封顶），所以改的是测试与注释，实现一行没动。另外我顺手把 `online.js` 里一处 `///` 改成 `//`，随即退回 —— 这仓库的 JS 一直用 `///` 写成员文档（`app.js` 里 188 处），那不是笔误而是约定。

## 26. 用户在界面上怎么验收（第八批）

1. 打开入口：设置 → 在线音源 → 音质，把网易云调到 Hi-Res，然后去流年/在线搜索里点一首账号拿不到无损的曲子。两种形状都要看到：
   - **取流那一档直接失败**（`vip_required`）：第一次按 Hi-Res 请求会失败，同时弹一条 `《歌名》Hi-Res放不出来，已降到无损`；
   - **上游给得起但阶梯退档**：第一次就放响了，顶栏播放胶囊的技术芯片写 `在线 · 无损`，并 toast 一句 `该曲目实际可用：无损`（这一半是原有通路，本批只修了它的去重）。
2. **同一首再点一次**（在线面板里再按播放键）：不该再等一轮 Hi-Res 的取流 —— 体感是"秒开"而不是"又卡一下再降级"；也不该再弹同一条提示（同一首同一档只说一次，`quality.cap` 那行日志也不会重复出现）。
3. 放着不管，让自动接力/列表循环转回这首：档位仍停在被夹低的那一档，不会自己弹回 Hi-Res。
4. 换一首没失败过的同平台曲子：它照旧按 Hi-Res 试 —— 上限是按曲目记的，不牵连同源隔壁那首。
5. 反复在同一首上失败会一格格往下掉，每掉一格一条 toast，最多到「标准」为止；到最低档之后再失败不会再刷提示。
6. 开发者侧：诊断日志（设置页 → 诊断）里找 `quality.cap`，字段是 `track/source/code/from/to`；`play.online` 的 `want` 现在就是**夹之后**的档位。
7. 进程重启即忘记这些上限（只在内存里），等于给每首歌一次重新试高档的机会 —— 这条是有意的，不是漏的。

---

# 第九批（同一会话续做）：F5 节拍分析的并发预算与两种状态

## 27. 改了什么

先核对现状：`stage_beats.rs` 已经有「每键单飞」（同一缓存键全局只有一个任务）、`spawn_blocking` 跑分析、失败态允许重试。F5 说的是三件当时**不存在**的事：

| 缺口 | 当时的形态 |
| --- | --- |
| 没有总并发预算 | 每次播放提交都 `tokio::spawn` 一轮 FFT（一首几分钟音频是几秒满核）。连切 20 首 = 20 个分析同时在抢 CPU，而抢的是**正在解码那首**的 CPU。听感是声音发卡，画面一切正常，日志里也没有错 |
| 没有尝试上限 | `Failed` 态在提交路径每次都允许重试，且重试前 `insert(Analyzing)` 把次数丢了 → 一首真放不出图的文件，每次播放都重算几秒 |
| 「就绪」与「已落盘」是一种状态 | `write_cache` 失败（数据目录只读、盘满）走 `mark_failed(Reason::Failed)`：图算出来了却被扔掉，不发 `BeatmapReady`，GET 拿到 404 `reason=failed`。用户看到「这首歌根本没有节拍图」，开发者按失败去查解码器，而真正的问题是磁盘 |

落地（`stage_beats.rs` + `state.rs` + 双门面）：

- `beat_slots: Arc<Semaphore>`（`BEAT_ANALYZE_BUDGET = 2`）。`acquire_permit(state, caller, wait)`：`Caller::Commit`（提交后的顺手预热）用 `try_acquire_owned`，拿不到就**当场推迟、不排队**——排队堆的是用户已经跳走的曲子；`Caller::Demand`（界面在等）等到 `BEAT_PERMIT_WAIT = 4s` 为止，等不到回 `analyzing`（前端本来就有这一态）。额度由分析任务持有到**落盘 await 之后**，不是 `spawn_blocking` 一返回就还。
- **先拿额度、再写幂等表**。顺序反了会在表里留下一格没人真的在算的 `Analyzing`，后来者一看就在等，而这个等永远不会有结果。
- `TaskState::Analyzing { attempts }` / `Failed { reason, attempts }`：重试接着上次的次数数，`BEAT_ATTEMPTS_MAX = 3` 到顶就不再重开。`Ready`/`NotPersisted` 重开时计数从头（那是新的一次机会，不是第 N 次失败）。
- 新状态 `TaskState::NotPersisted` + `beat_volatile: Mutex<BoundedMap<Arc<BeatMap>>>`（`BEAT_VOLATILE_CAP = 8`）：落盘失败时把算好的图放进这张有界内存表，发 `BeatmapReady { persisted: false }`，`request()` 先查磁盘再查这张表 → 直接服务，不重算、不谎报失败。GET 的线字段仍叫 `cached`（`false` = 内存态），形状不变，两个门面（`routes.rs` / `rpc/playback.rs`）各自解构 `persisted`。

顺带把上一批 B4 留下的一处按原始偏好算档位的漏洞补在同一个文件里（`resolve_audio` 已改走 `online_quality_for`）。

## 28. 证据（第九批）

```
cargo test --workspace   全绿（hertz-studio lib 299 passed / 0 failed）
  改：idempotent_table_decisions（新形状 + 三次上限 + NotPersisted 重开）、idempotency_table_is_bounded
  新：commit_path_defers_when_the_budget_is_full（额度用满即推迟、腾出一格立刻能再用）
      demand_path_waits_for_a_slot_then_gives_up（20ms 后腾出的额度要等到；占满时等满超时自己收场）
      volatile_maps_table_is_bounded（内存表按写入顺序淘汰）
      ws.rs 的 beatmap_ready 线形状两条断言更新：persisted 必须出现，false 也要出现
cargo clippy --workspace --all-targets -- -D warnings  干净
rustfmt --check（本批动过的 6 个文件）  0 diff
node scripts/check-frontend.js --extra  35 步全绿（+1：新 check-beat-budget.js，已进 CI 默认集合）
node scripts/check-beat-budget.js       27 项全部通过
```

`check-beat-budget.js` 管的是单元测试够不到的接线：拿额度与写表的**顺序**、额度持有到落盘之后、落盘失败分支里必须同时出现 `NotPersisted`+`persisted: false` 且不得出现 `mark_failed`、`beat_volatile` 查询在决策之前、内存表必须有界、`persisted` 不许是 `skip_serializing_if` 字段、两个门面各自把 `persisted` 写成同一个 `cached`。

变异验证 10 条全部被抓到（`.mut-f5.js`，跑完已删）：先写表后拿额度 / 落盘失败改记 Failed / 重试从 0 数 / 上限多给一次 / `NotPersisted` 当失败 / RPC 把 `persisted` 写死 true / 不查内存表 / 内存表不设界 / 提交路径改成排队 / 额度提前还掉。前三批也各补了一次同样的纪律（B4 是 14 条）。

一处判断值得单独记：**为什么 `Commit` 不排队**。`Commit` 是「这首歌刚才真的放过」的事后预热，用户正在连切歌时它的价值最低；`Demand` 是界面已经停在「等节拍图」上，让路给它才是让路。参考项目那条「忙时等待」的规则两边都等，照搬会让提交路径把 CPU 继续吃掉，所以这里按我们的两个触发源分开定耐心，而不是复刻它的单一队列。

## 29. 剩余没做（第九批之后）

- **G7 的完整形态**：计划要的是「后台任务状态附着在任务上」的一块面板（当前曲 / 模式 / 命中磁盘还是内存 / 取消 / 重试）。本批把后端状态与两个门的诚实性做齐了（`persisted`、`attempts`、`beat.defer`/`beat.not_persisted` 日志），但**没有新建那块面板** —— 它需要一个新的界面区域与 owner 决定（放设置页还是舞台工坊），属 P2 扩展而不是缺口修复。
- A7、A1/A2/A3（等用户拍板权益门）；B1–B3、B5 听感全部；B4 的「同一次播放里就地重试下一档」；C1、C3–C6（C3/C6 见下面审计：实际已满足）；§5.1 的实机收敛；D3/D4/D6；F2 真整单续载、F3/F5 的面板侧；G1/G3/G4/G7–G11。
- 顺带一份**逐项审计结论**（子代理跑过，避免下一批把已满足的当缺口做）：C3 像素预算、C6 卡拉OK 歌词 CSS 与 dead-reckoning、G1 首页继续播放入口、G9 卡片原位更新——**已满足**；G3（它的前提是 G1 的四张任务卡，本项目没有那个形状）、D4（没有可断言的启动重试机制）——**前提不存在**；真缺口排在最前的是 G11（在线曲被两处代码明确挡住逐句歌词校准，而 `offset_ms` 的存储键形状本来就兼容）、G8（队列面板被 chrome 淡出销毁，设置页却豁免）、G10（搜索关键词历史困在流年皮肤里）、G4（长歌单整表常驻，无窗口化）、F3（接力后「用户选的出处」不可恢复）、D3（没有 panic 钩子）、C4（节拍 JSON 未打包，实测 829 拍 53KB）、D6（ADR/决策日志目录空）。

---

# 第十批（同一会话续做）：G11 在线曲接通每曲歌词校准

## 30. 改了什么

清单 §9 G11 说「歌词校准要标清当前曲目，主舞台与浮层共用同一份时间语义」。核对下来，前半件我们**已经有**（np 弹窗与舞台浮层都显示当前曲名 + ±0.1/0.5s + 归零），后半件有一处真缺口，而且比清单写的更硬：**在线曲整条校准链是关着的**。三处按 `online:` 前缀早退：

| 位置 | 原话（注释里的理由） | 事实 |
| --- | --- | --- |
| `app.js` `syncNpLyrics` | 「在线曲目歌词来自平台接口，没有导入/偏移语义」 | 导入确实没有（没有文件可写），偏移有 |
| `app.js` `case 'lyricOffset'` | 同上，与 np 弹窗同规拦截 | 同上 |
| `stage3d.js` `nudge()` | 「在线曲目没有偏移语义：源头直接拦截」 | 同上 |

那句话在存储层不成立：`track_lyrics`（`migrations/0006_track_lyrics.sql`）主键是 `track_id TEXT`、**没有外键**，在线曲的虚拟 id `online:<source>:<ref>` 是合法键；写侧 `set_offset` 自己 `INSERT … ON CONFLICT` upsert，且 `set_lyrics_offset` 端点本来就不检查曲目是否在库。缺口只在**读侧三段没去查这张表**：`/v1/online/lyric`、`/v1/overlay/lyric` 的在线分支、以及 RPC 门面。后果是用户想校正一首在线歌只能去动设置页的全局偏移，而那会把所有别的歌（本地 + 在线）一起挪走。

落地：

- `routes.rs` 新增两个 owner：`lyrics_user_offset(state, track_id)`（本地与在线同一份读法）与 `online_lyric_body(state, source, ref_id)`（取词 → 加这首的用户偏移 → `apply_offset` 一次 → 响应带 `user_offset_ms`）。HTTP 的 `online_lyric` 与 `rpc/online.rs` 的 `lyric` 都改为走 `online_lyric_body`。
- `overlay_lyric_data` 的在线分支补 `doc.offset_ms += lyrics_user_offset(state, &track_id)`；那条链末尾仍只有一次 `+= global_offset` 与一次 `apply_offset`。**记忆化存的仍是未叠加偏移的原始文档**，所以改了校准立刻生效，不用等缓存过期。
- 前端撤掉三处前缀拦截；np 弹窗的偏移控件对在线曲改为「这首真有歌词才显示」（判断依据是 `doc.lines` 而不是 id 前缀），导入/清除入口仍对在线曲隐藏。
- 补上清单点名的迟到保存守卫：`shiftLyricOffset` 在 `await` 之后复核 `state.current.id !== id` 才回填读数（原来只在失败分支靠 stage3d 的 `pendingTrackId` 隔离，np 弹窗这条路没有）。
- 全局偏移的应用位置没动：主页面链路由前端 `stageDoc` 加一次（`user_offset_ms + globalLyricOffsetMs()`），浮层链路由服务端末尾加一次。`apply_offset` 不幂等，两处各一次是这条链的既有边界，本批只是把在线曲也接进同一条边界内。

不在本批范围：接力换源后偏移不跟着走（校准记在 `online:netease:x` 上，救回到 `online:qq:x` 就是另一个键）。这是 F3（出处身份 vs 供音身份）要解决的问题，不做半套。

## 31. 证据（第十批）

```
cargo test --workspace   全绿（hertz-studio lib 300 passed / 0 failed）
  新：routes.rs per_track_offset_reads_the_same_table_for_online_ids_too
      —— 真 schema（vmusic_store::open）+ 真 store 写入，证明虚拟 id 当键可用、
         没调过读成 0、在线那首的偏移不牵动本地那首。
cargo clippy --workspace --all-targets -- -D warnings  干净
rustfmt --check（routes.rs / rpc/online.rs）  0 diff
node scripts/check-frontend.js --extra  36 步全绿（+1：新 check-lyric-calibration.js，归在 guard 阶段）
node scripts/check-lyric-calibration.js  26 项全部通过
```

`check-lyric-calibration.js` 钉的全是「不报错、只是没效果」的接线：三处 `online:` 拦截不许回来；`np.lyricOffsetMs` 的读数对两种来源同一份；迟到保存必须在 await 之后复核当前曲；`online_lyric_body` 要同时出现「查偏移 / 应用一次 / 回 user_offset_ms」，且 `apply_offset` 在该链上恰好一次；浮层在线分支要查这张表、全局偏移只在末尾加一次；RPC 门面必须共用 `online_lyric_body`；写侧端点不许长回 `get_track` 前置检查（那正是把在线曲重新关回去的最自然写法）。

变异验证 13 条全部被抓到（`.mut-g11.js`，跑完已删）。其中三条第一轮跑成 SKIP，原因是 `plugin/ui/app.js` 是 CRLF 而 `routes.rs` 是 LF，多行锚点按 `\n` 拼接在 app.js 里找不到 —— 驱动器改成按文件实际换行符重拼锚点后全部命中。**教训留给下一批**：这个仓库的换行符是混的，写一次性驱动器时别假设 `\n`。

## 32. 用户在界面上怎么验收（第十批）

1. 播一首在线歌，打开「正在播放」弹窗（点封面或顶栏曲名）：歌词那一行现在应显示 `在线` 徽标 + 一排校准控件（`−0.5s / 读数 / +0.5s`）。之前这一排在在线曲上整排消失。
2. 按两次 `+0.5s`：舞台上的歌词整行应当立刻往后挪一秒（服务端已把偏移烘进时间戳，前端再叠全局偏移那一次不变），读数显示 `+1.0s`。
3. 关掉重开弹窗、或切走再切回这首：读数还在 `+1.0s`（落库在 `track_lyrics`，键是 `online:<source>:<ref>`）。
4. 开 OBS 浮层（设置 → 浮层/_OBS_）播同一首：浮层里的歌词与主页舞台**同一套时间**，不需要再校一次。这是「主舞台与浮层共用同一份时间语义」的直接对照点。
5. 同一首歌走「原音源放不了 → 接力换源」之后：校准会显示 0（新源是新的键）。这是有意的，不是漏 —— 见本节末「不在本批范围」。
6. 连点两次中间切歌（慢网络下最容易看到）：新歌的读数不该被刚才那次的保存改成 `+0.5s`。
7. 插件形态（dbx）与独立形态（浏览器）各做一次 2–4：两边必须同样有效，因为两个门面共用同一份 `online_lyric_body`。

---

# 第十一批（同一会话续做）：D3 崩溃可观测性 + 日志裁剪两阶段写

## 33. 改了什么

清单 §4 D3 要的是「启动与崩溃可观测性：事件环形缓冲（原子写）+ 错误归类码 + `reportId` + 有界渲染恢复预算」。逐项核对：

| 子项 | 现状 | 本批 |
| --- | --- | --- |
| 错误归类码 | **已有**：`error.rs` 的码 + `request_id` 一路到界面（`app.js` 的错误文案带编号） | 不动 |
| 事件环形缓冲 | **已有**：`diag.rs` 的 2 MB 有界单文件 + 保留最新一半 | 补它的**原子写** |
| `reportId`（崩溃侧） | **没有**：全仓库 0 个 panic 钩子。进程 panic 后既没有日志行也没有编号，用户能说的只有「它自己没了」 | 新增 |
| 有界渲染恢复预算 | **没有**：`stage3d.js` 的 GL 上下文丢失后只印一句「可退出后重新进入」，没有尝试计数 | 本批后半，见 §36 |

落地：

- `diag.rs`：`CrashRecord` + `LAST_CRASH` 进程内表 + `crash(report, location, message)` + `last_crash()` + `install_panic_hook()`。崩溃行走 `write_line` **绕过 `event()`**，也就是不受诊断开关支配 —— 开关是用户为了录播放过程才按的，进程崩的那天它通常是关的；那种时候一条可交接的编号比什么都重要。钩子写完仍交回默认钩子，终端里的原始 panic 输出是给开发者自己的。编号取 uuid 前 8 位十六进制：短到口头报得出来。
- `bootstrap.rs`：钩子紧跟 `diag::init` 装好，早于任何可能 panic 的装配步骤（放在后面就正好漏掉启动期那几次）。
- `trim_if_over` 改两阶段：同目录 `.log.trim.tmp` + `rename`。原先 `File::create(path)` 先把当前日志截成 0 再重写，而裁剪恰好发生在日志最长、最可能有内容的那一刻；进程卡在中间，用户发来的就是既丢了旧现场、又可能缺了刚记下的 panic 行。
- `diagnostics_json` 带 `last_crash`；设置页多一行「上次异常退出」，显示时间、编号、位置与原因。**这一行的存在性只看有没有崩溃，不跟诊断开关联动**（跟它联动就等于把编号藏回用户没按的那个开关后面）。

## 34. 证据（第十一批）

```
cargo test --workspace  全绿（hertz-studio lib 302 passed / 0 failed）
  改：diag.rs lifecycle 用例尾部接上崩溃断言 —— 开关已关之后 crash() 仍落一行
      `panic report=… where=… msg=… log=…`、last_crash() 读得到、且没顺手把开关打开。
      （涉及落盘的断言全部并在同一个用例里，是这里既有的一次性 `init()` 纪律。）
  新：crash_reports_are_short_and_distinct（8 位十六进制、两次不同）
      trim 用例补「不留 .tmp 残骸」（logs 目录里多一个临时文件，用户就得猜哪个是当前的）
cargo clippy --workspace --all-targets -- -D warnings  干净
rustfmt --check（diag.rs / bootstrap.rs / routes.rs）  0 diff
node scripts/check-frontend.js --extra  37 步全绿（+1：新 check-crash-report.js，guard 阶段）
node scripts/check-crash-report.js      24 项全部通过
```

`check-crash-report.js` 钉的五条全是「不报错，只是崩了什么都没留下」：钩子在 `init` 之后、在装配之前；`crash()` 用 `write_line` 而不是 `event()`；取锁容忍 poisoned（panic 展开过程中拿锁正是这一行的来由）；裁剪必须 rename；设置页那一行不跟 `on` 联动、且默认 `hidden`。

变异 12 条全部被抓到（钩子没装 / 装得比 init 还早 / 崩溃行走 event / 不落盘 / 不留进程内现场 / 吞掉默认钩子 / 裁剪退回截断 / diagnostics 不带 last_crash / 崩溃提醒藏在开关后 / 只显示时间不显示编号 / 崩溃行默认展开 / Rust 侧现场没记）。踩到的一次自己的坑：负面断言 `不许 File::create(path)` 被我**自己那句解释性注释**打红（注释里写着「原先直接 `File::create(path)`」）。给这个脚本补了 `codeOnly()`（按行抹 `//` 注释）再判。同一形状的问题在 B4 那条 `__qtoast` 上也发生过一次 —— **负面不变量必须先决定注释算不算数**，并把理由写进那条断言里（这里算：注释记的是禁令的来由）。

## 35. 用户在界面上怎么验收（第十一批）

1. 崩溃现场不用人造：正常用一阵，若服务异常退出（这是本批要接住的那种），下次打开设置 → 开发者选项，最上面会出现一行「上次异常退出」，带时间、8 位编号、panic 的位置与原因。诊断开关是关着的也该看到 —— 这正是这一行不跟开关联动的原因。
2. 同一页的「日志文件」路径不变；开启开关后复现一次崩溃，`playback.log` 尾部会多一行 `panic report=<编号>`，把整份文件发出来时编号与现场对得上。
3. 日志涨过 2 MB 后看 `logs` 目录：仍然只有 `playback.log` 一个文件，没有 `*.tmp` 残留，首行是一条 `trimmed dropped_bytes=` 说明而不是半行残码。
4. 反馈时的说法从「它闪退了」变成「编号 a1b2c3d4，日志发你了」。

## 36. D3 后半：有界渲染恢复预算（`plugin/ui/stage3d.js`）

清单那条子项要的是「滚动窗口 N 次后明确报错并给日志路径」。核对现有形状：`webglcontextlost` 会 `preventDefault` + 释放资源 + 挂「正在恢复渲染」，`webglcontextrestored` 重建后处理链，重建失败就 `releaseGl()` + 一句「舞台暂时无法恢复，可退出后重新进入。」——**没有循环**（监听已摘），所以原来的毛病不是「无限重试烧 CPU」，而是两件别的：

1. 反复丢失（驱动重置、显存压力）每次都全额重建一遍着色器链与 RT，用户看到的是横幅在「正在恢复」与画面之间闪，代价全花在没人看得见的画面上；
2. 那句措辞把判断推回给用户（「可退出后重新进入」），既没说发生了什么，也没说去哪儿取证。

落地：

- 两个纯函数 `pruneRecoveries(history, now, windowMs)` 与 `takeRecovery(history, now, windowMs, max)`（记一次 = 先剪窗、再判额、再落笔，只有一条路径），配 `RECOVERY_WINDOW_MS = 120000` / `RECOVERY_MAX = 3`。
- `onContextLost` 开头判预算：用完就 `glStopped = true`、**`contextLost` 落回 false**、`releaseGl()`、显示停用文案并早退——不再假装会恢复。停用后 `!gl` 就是所有渲染路径的统一停机位（1544 / 1624 / 2953 那几处守卫本来就在看 `gl`）。
- `ensureGl()` 认 `glStopped`，但**先按窗口重评**：窗口滑走之后用户再进三维，照旧再给一次机会。一次驱动重置不该变成整场不可用。
- 措辞三态分开：`glFailed`（这台设备不支持三维）/ `glStopped`（2 分钟内丢了 3 次，已停用 + 指向设置 → 开发者选项 的日志与编号）/ `contextLost`（正在恢复）。原来只回到舞台轨时看两种，会把停用说成「正在恢复」。
- 顺手把后处理链重建失败那一句也改成同样的诚实格式（说清发生了什么 + 去哪儿取证），那条路径不记停用位（一次失败不该永久封死）。

验证：`node scripts/check-crash-report.js` 44 项全绿，其中 20 项是这一半 —— 预算那两个函数**从源码里抠出来在 vm 沙箱里按假时钟跑**（第 4 次必须拒、窗口滑走必须再可用、恰好等于窗口的记录算出窗、`max = 0` 时一次都不许试），而不是照抄一份影子实现。变异 10 条全部被抓到：`>=` 换成 `>`、`<` 换成 `<=`、不记账、先进恢复态再判额、不落 `glStopped`、停用时把 `contextLost` 留成 true、`ensureGl` 不认停用位、去掉过期重评、文案退回「可退出后重新进入」、三态分支少一支。

一次自己的错：`prune([0,10], 100000, 120000)` 我按「整窗之外」写期望，实际两条都还在窗口内 —— 是断言的算术错，实现没错，改成 `now = 200000` 后绿。这类「窗口」断言必须把 `now`、`windowMs`、记录值三个数在同一行里写出来核对，别靠语感。

---

# 第十二批（同一会话续做）：G10 搜索关键词历史归一个 owner

## 37. 改了什么

清单 §9 G10 讲的是「历史跟着搜索能力走，切平台或切皮肤时仍可复用；查询历史与结果缓存分开」。核对下来我们的问题正好是它说的那样：关键词历史住在 `skins/skin.liunian.js` 的私有键 `vmusic.ln-search-history`，规则（trim、去重、置顶、上限 10）也写在那一段里。后果：

- 顶栏曲库框、`topsearch.js` 的在线档、`online.js` 的在线搜索页敲进去的词**都不进这份历史**；
- 换到别的皮肤（浮光/清风）就没有任何历史可看，而搜索本身是共用的；
- 规则与渲染搅在皮肤里，别处想复用只能复制一份。

落地：

- 新模块 `plugin/ui/search-history.js`（`window.HertzSearchHistory`）：唯一的键 `vmusic.search-history` = `{v:1, items:[…]}`，规则集中一处 —— trim、**大小写不敏感**去重、重复使用顶回第一位、上限 10、空/非字符串不记、读侧再兜一层过滤、`localStorage` 坏了不抛。载入即一次性搬迁：把旧键内容并进新键、去重、然后**删掉旧键**（不留「两份历史哪份是当前的」）。
- 三个入口都记到这里：`online.js` 的 `search()` 开头（任何一次真的执行都算提交，含切类型后的重查）、`topsearch.js` 的 Enter、`app.js` 顶栏本地档的 Enter。**逐字输入不记**：`ui.search.oninput` 与 `onlineQ.oninput` 那条链上没有 push —— 边输边查的框每次输入都记的话，最近十条全是「周」「周杰」这种中间态。
- 流年侧只留渲染层：`readHistory/pushHistory/removeHistory` 全部委托，私有键与 `writeHistory` 摘掉，`HISTORY_KEY`/`HISTORY_MAX` 两个常量删了（不留「只是没人用」的死码）。
- 没有并进来的东西：`vmusic.palette.recent` 存的是**命令 id**，名字像但不是同一个东西，`palette.js` 一行都没改。

搬这个会连带三处注册，是仓库自己的检查抓出来的（不是我记得的）：`index.html` 的 `<script defer>`、`main.rs` 的 `include_str!` 常量、`.route("/search-history.js")`，再加 `ASSET_FINGERPRINT_INPUTS` 一项；`api-routes.js --check` 随即报 README 的内嵌资源条数从 72 变 73，跑一次 `node scripts/api-routes.js`（不带 `--check`）把生成块写回 README。少任何一处都不会报错，只会「这块界面空着」或「新代码在插件形态里根本没加载」。

## 38. 证据（第十二批）

```
node scripts/check-search-history.js   39 项全通过（新脚本，已进 CI 默认集合）
node scripts/check-skins.js            687/687
node scripts/check-assets.js           694/694
node scripts/api-routes.js --check     与源码一致
node scripts/check-frontend.js --extra 38 步全绿
cargo test --workspace / clippy -D warnings / rustfmt --check(main.rs)  全绿
```

规则那一段不读源码猜：`search-history.js` **整段在 vm 沙箱里执行**，喂一个假 localStorage，跑「大小写去重 / 空白不算两条 / 重复使用置顶不留副本 / 20 次 push 只剩 10 条且最新在最前 / 单删与清空 / 空与 null 不写进存储 / 旧键搬完即删且第二次搬 0 条 / 坏 JSON 当作没有 / 手改过的旧形状只留合法字符串项 / 没有 localStorage 时不抛」。接线那一段钉「只有一个地方写这个键」「三个入口都有 push」「两处 oninput 都没有 push」「脚本必须排在皮肤与 app.js 之前」「palette.js 不引用这个 owner」。

变异 12 条全部被抓到：上限改 1、大小写算两条、新键不带版本形状、旧键不删、不去重只 unshift、空串也记、读侧不筛空项、皮肤长回私有键、顶栏 Enter 不记、把 push 挪到 oninput、脚本排到皮肤之后、命令历史并进来。

其中一条一开始**没红**，值得记：删掉 `push()` 里的空串早退后，断言照样绿 —— 因为读侧 `isText()` 把空串过滤掉了，写入端的漏洞被兜底掩盖。补的两条把这一点钉死：一是直接查存储里的 `items.length`（写入端不许留空项），二是把读侧过滤单独变异一次。兜底掩盖写入端，是这一批里最像「测试有效」的假象。

## 39. 用户在界面上怎么验收（第十二批）

1. 在顶栏搜索框敲「周杰伦」并按 Enter；再打开流年的搜索面板（空查询时显示历史芯片那一屏）——「周杰伦」应出现在那里。原先这两个地方互不相认。
2. 在在线搜索页输入同一个词、点「搜索」或按 Enter：历史里不该多出第二条副本，只该把它顶到最前。
3. 先搜 `ab` 再搜 `AB`：只剩一条，写法是最近这一次。
4. 换皮肤（浮光 / 清风）再换回流年：历史还在 —— 这是本批最主要的那处修复。
5. 打字过程中不要产生记录：连打「周」「周杰」「周杰伦」，只有提交（Enter / 点搜索）那一次进历史。
6. 芯片上的 `×` 删单条、区块头的「清空」清全部，两者行为不变（只是现在走 owner）。
7. 原先在流年里存过记录的老用户：第一次打开后 devtools 的 localStorage 里应该只剩 `vmusic.search-history` 一个历史键，`vmusic.ln-search-history` 已被删除。
8. 命令面板（Ctrl+K）的「最近使用」列不该混进关键词：它是命令 id，另一回事。

---

# 第十三批（同一会话续做）：F3 出处身份与供音身份分开

## 40. 改了什么

清单 §8 F3 的一句话：**先保留出处，再决定业务策略**。核对下来我们缺的正是「保留」这一半：

- `try_relay` 换源时把队列那一项换成新源的虚拟 id、元数据迁到新 id 名下 —— 从此缓存键、音质、取流、播放历史、打卡全跟着**实际供音那一家**走；
- `OnlineMetaSnap` 里没有任何字段记「用户当初点的是哪家」，`WsEvent::SourceSwitched` 只把 `from_source` 用在一条瞬时 toast 里；
- 于是刷新一次、或者事后想看「我明明点的是网易云那一首」，系统里已经没有地方可查。

落地（只保留出处 + 把它说清楚，不改收藏/打卡的业务策略）：

- `OnlineMetaSnap.origin: Option<OnlineOrigin>`（`source`/`id`/`label`）。`None` = 出处就是这一项自己；`ensure_origin()` **只记第一家** —— 网易云 → QQ → 酷狗 这种多跳接力，出处仍是网易云，中间跳只在诊断日志里留痕。
- `try_relay` 迁移元数据时 `ensure_origin(失败那家的 source, 平台 id, 展示名)`，并把出处随事件发出去：`SourceSwitched` 新增 `from_track_id`、`origin_source`、`origin_id`、`origin_label`（都不许 `skip_serializing_if` —— 可缺席就把「没换过源」和「服务端没说」捏成同一个样子）。
- `AppState::online_origin(track_id)` 是唯一的出口（内部走 `origin_of` / `relayed` 两个纯方法），**两个播放门面**都在响应里回 `"origin"` + `"relayed"`：`/v1/online/play` 与 RPC 的 `online/play` 同口径。只改一边就是「独立形态看得见出处、dbx 插件形态看不见」。
- `remember_online_meta` 保留已知出处（与它原本保留 rg 标签同一条规则）：新快照没带 `origin` 不等于「没换过源」，刷新之后的重新入队不该把已经知道的事忘掉。
- 前端：`Online.relayMeta(msg)` 把那一行的元数据从旧 id 迁到新 id（`source`/`onlineId` 跟供音走，`origin` 记出处，多跳时沿用旧的 `origin`），`app.js` 在 `source_switched` 分支里调用它 —— **只有换的是当前这首才重绘**，并重推 3D 队列（歌单架只认喂给它的数据，不重推会停在占位卡）。顺带修掉一个既有缺陷：以前接力之后新虚拟 id 在前端没有元数据，队列那一行会退化成平台 id。
- 「正在播放」详情多一行出处说明（`#np-origin`，默认 `hidden`），条件是 **出处 ≠ 供音**，不是「有没有 origin 字段」。

明确没做（清单自己就要求分开决定）：收藏落到哪家、换源后要不要按原平台打卡 —— 现在这两件事仍按供音那一家走，出处只是**留着可查**。接力换源后的每曲歌词偏移也还是记在供音那家的 id 上（G11 的键），换源等于重新校准，这是既有的键形状决定的，不在本批偷偷改。

## 41. 证据（第十三批）

```
cargo test --workspace   全绿（hertz-studio lib 304 passed / 0 failed）
  新：origin_survives_the_relay_chain_and_names_the_first_source（多跳只记第一家）
      snap_without_origin_field_still_deserializes（旧 payload 缺 origin 照收）
      online_origin_answers_from_the_queue_snapshot（换过的答出第一家；没换的 relayed=false；
        重新入队不抹出处；没有快照与本地 id 都返回 None，不猜）
cargo clippy --workspace --all-targets -- -D warnings  干净（中途一次 dead_code 报警：
  origin_of/relayed 只有测试在用 —— 于是把它们接成 online_origin 这个真出口，
  再由两个门面消费；不留「为将来准备」的死 API）
rustfmt --check（state.rs / routes.rs / rpc/online.rs）  0 diff
node scripts/check-online.js      297 项全绿（+21：relayMeta 在真模块里跑迁移与多跳）
node scripts/check-source-origin.js  40 项全绿（新脚本，已进 CI 默认集合）
node scripts/check-frontend.js --extra  39 步全绿
```

`check-online.js` 那 21 条是行为：换源后 `source`/`onlineId` 跟新家、`title` 不跳、`origin` 是第一家；第二跳的 `origin` 仍是网易云而不是 QQ；`online:qq:a:b` 这种带冒号的平台 id 不被 `split(':')` 吃掉；拿不到旧快照时按事件带的字段建一条；脏事件安静地不迁。

变异共 18 条，全部被抓到：`ensure_origin` 去掉早退（两处：cargo 与契约各一次）、迁移时不补出处、事件缺 `from_track_id`、origin 字段可缺席、兼容性测试被改名、前端不迁元数据、不管是不是当前这首都重绘、不重推 3D 队列、出处行按「有没有 origin」判断、默认展开、`relayMeta` 覆盖成上一家、冒号 id 被截、两个门面各删一次出处回传、前端不吃服务端出处、重新入队抹掉出处。

一次真实事故记在这儿：变异驱动器跑到 `plugin/ui/app.js` 时 `writeFileSync` 抛 Windows `UNKNOWN (-4094)`（文件被别的东西占着），**驱动器崩在半路，把一个变异体留在了工作树里**。我先 grep 核对现场、手工改回那行，再给驱动器加上「写完立刻读回校验 + 失败重试」的写入函数，之后重跑全绿。教训：**变异驱动器必须在每次写完和恢复后都读回比对**，否则崩溃时留下的是被改过的源码，而它看起来只是「测试没跑完」。这条已经写进 [[frontend-contract-check-traps]]。

## 42. 用户在界面上怎么验收（第十三批）

1. 触发一次接力（把当前源的这首弄成放不了、另一家有同名同歌手同时长的那首）：播完/切走后，「正在播放」详情里应出现一行 `原音源：网易云音乐 · 现由 QQ 音乐 供音`。没换过源的曲子不该有这一行。
2. 换源之后队列里那一行仍应显示歌名与封面（不是一串平台 id），点它、看详情都对得上 —— 这是前端元数据迁移那一半。
3. 刷新页面（或换到另一个界面实例）再播同一首：那一行出处说明还在（服务端快照回答，不依赖前端本地暂存）。
4. 独立形态（浏览器）与 dbx 插件形态各看一次 1–3：必须同样有效（两个门面同一口径）。
5. 收藏与打卡的行为**故意不变**：换源后收藏仍落到实际供音那家、听歌记录仍报那家。出处现在只是可查，业务策略另议。

---

# 第十四批（同一会话续做）：D6 决策日志（带牙齿的那种）

## 43. 改了什么

清单 §4 D6 说的是：文档要写成**决策日志** —— 数值边界 + 该改哪个函数 + 「禁止回退」清单，并且「更适合被 check 脚本引用」。`docs/aegis/adr/` 之前是空目录，而这一路做下来（B4 / F5 / G10 / F3 / D3 / D5 / F6 / §5.1）我们已经定了十几个数字：内存表条数、并发额度、尝试次数、窗口长度、载荷上限、合并窗。它们当时只写在代码注释里，也就是**下一次改动最容易被顺手挪走、且挪走没人知道**的那种东西。

新增：

- `docs/aegis/adr/README.md`：格式约定（三段 + 表格四列 + 数值列只写纯数字）与索引。
- 六篇决策日志：`0001` 在线播放的时限与档位、`0002` 内存表的有界性与两种淘汰策略、`0003` 后台工作给交互让路、`0004` 持久化载荷的量与长度、`0005` 交互层的合并/去重/上限、`0006` 帧门的整数分频。
- `scripts/check-adrs.js`：把上面那张表**逐行核对源码**。每行的 `文件::常量` 必须在该文件里找得到定义，且字面量算出来等于文档里的数（支持 `20_000`、`6 * 1024 * 1024`、`Duration::from_secs(20)`）。缺段、缺索引、符号改名、数字漂移都报红。已进 `check-frontend.js` 的默认集合，也就是进 CI。

写法上刻意守两条：**每个数只出现一次**（文档引源码，不抄一份第二真相）；「禁止回退」每条都要写**改回去之后的失败长什么样**（「不要这样写」的清单没有价值）。清单里 D6 举的例子是 `3D_PLAYLIST_SHELF_MEMORY.md` 那种「Do Not Regress」段 —— 这次把它做成机器可查的。

## 44. 证据（第十四批）

```
node scripts/check-adrs.js                158 项全绿（核对 44 条边界 / 6 篇）
node scripts/check-frontend.js            29 步全绿（CI 默认集合，含新增这一步）
node scripts/check-frontend.js --extra    40 步全绿
node --check scripts/check-adrs.js        OK
```

变异 8 条全部被抓到：文档数字漂移（64→65）、数值列写成源码的 `20_000`、owner 符号写错、owner 指向不存在的文件、删掉「禁止回退」一节、**源码改了常量而文档没跟上**（64→96）、源码改成算不出来的写法（`5 * 1024` 与文档的 4096 不等）、索引漏一篇。

两条自己踩的坑，都值一次记录：

- 第一版检查器把一行里连写的两个常量算错（`var RECOVERY_WINDOW_MS = 120000, RECOVERY_MAX = 3` 读成了 120000），并把 Rust 的 `20_000` 判成读不出字面量。判据：**从常量名那一列开始截一段再解析**，下划线直接删掉而不是换成空格。
- 「索引漏了一篇」那条变异一开始假绿 —— 我只改了行首编号，文件名还在同一行里。真正的变异要**删掉整行**。凡是「存在性」断言，变异必须把被断言的东西整个拿掉，否则测的是自己写的字符串形状。

## 45. 剩余没做（第十四批之后）

G4（长歌单窗口化）、C4（节拍 JSON 打包，实测 829 拍 53KB）、D4（注入故障的启动时序断言）、F2 真整单续载、B1–B3/B5（听感整组）、G7 面板的完整形态、B4 的「同一次播放就地重试下一档」、A1/A2/A3 与 A7（等用户拍板）、G8（队列面板随 chrome 淡出：注释写明是刻意行为，等用户决定）、§5.1/B4/G11/F3 的 `--live` 实机收敛。
