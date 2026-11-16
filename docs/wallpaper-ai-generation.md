# Hertz 壁纸受管 AI：生成、推荐与切换实施记录

记录 A06 工作包（设计 docs/desktop-wallpaper.md §19/§20.5）各切片的实施与
验收状态。AI-01 的批准实施细节见其检查点与 2026-11-09 的
[壁纸设计主文档](desktop-wallpaper.md)条目；本表只汇总可核验事实。

| 切片 | 状态 | 证据 |
| --- | --- | --- |
| AI-01 离线推荐与明确切换 | 2026-11-09 已实施并通过 Windows 开发候选 8 项真实验收 | [主文档条目](desktop-wallpaper.md) |
| AI-02 切片 1：生成合同纯数据层 | 2026-11-16 已实施（见下） | 本文档 + `crates/hertz-wallpaper/src/generation.rs` 测试 |
| AI-02 切片 2：capability snapshot、quote/submit、ai/jobs 注册与路由 | 2026-11-16 已实施（见下） | 本文档 + `crates/hertz-studio/src/ai/{jobs.rs,wallpaper_jobs.rs}` 测试 |
| AI-02 切片 3：短会话配对（§19.2）与桌面接线 | 2026-11-16 已实施，Windows 内嵌/独立候选各五组真实验收通过 | 下文实现与验证边界 |
| AI-03 结果交付与入库 | 未实施 | 设计 §19.6 |
| AI-04 图像 adapter 与计费 | 未实施 | 设计 §19.5、§20.5 |
| AI-05 声明式组合 | 未实施 | 设计 §19.3 |
| AI-06 外部助手申请 | 未实施 | 设计 §19.2 |

## 2026-11-16 AI-02 切片 1：生成合同纯数据层

`crates/hertz-wallpaper/src/generation.rs` 落地设计 §19.3 的纯数据类型与
确定性验证；不含 quote/submit、短会话配对、provider 调用、路由或 UI。

- `WallpaperGenerateRequest`：version=1；完整控制 JSON ≤12 KiB、brief ≤4 KiB
  （沿 ai.rs 的 `MAX_BRIEF_BYTES`）；`json.rs` 字节级扫描器的重复键拒绝与
  深度上限 + `deny_unknown_fields` 落实「拒绝重复/未知字段」；registry 与
  schema 哈希须 64 位十六进制；builtin 的 sceneId 必须在自校验资格目录内。
- `WallpaperGeneration`：kind 判别的普通结构——serde 内部 tag 枚举不支持
  `deny_unknown_fields`（本片实测发现），因此逐类别强制「只允许自己的字段
  集合」，其余类别字段出现即拒绝。image 沿设计上界最长边 4096、像素总数
  ≤8 Mi；质量枚举留给能力目录切片。
- `BuiltinSceneOutput`：模型输出 `{kind,sceneId,stateVersion,params}` ≤64 KiB
  领域上限；stateVersion 与目录逐字匹配；params 严格按场景 schema——未知
  参数、越界、select 选项表外值（目录选项为 `{value,label}` 对象）与类型
  不符均拒绝，不自动 clamp；目录三类（number/boolean/select）之外的新类型
  fail-closed。
- `WallpaperArtifact`：信封由服务按实际接收字节构造；ID 边界、sha256 十六
  进制、字节 1 B–32 MiB（§19.5 原生接收上界）与 MIME-kind 一致
  （builtin/composition→application/json；image→png/jpeg/webp）。
- 错误码 `invalid_generation`；重复键保留 `json.rs` 扫描器的 `duplicate_key`；
  跨端 `registryHash`/`generationSchemaHash` 一致性由持有两端的调用方裁决，
  本层只验格式与本地目录成员。

真实证据：`cargo +stable/+1.88.0 test -p hertz-wallpaper --lib generation`
各 5 项通过；wallpaper 全套件 357 项双工具链串行绿；桌面 lib 869/0/2 双
工具链串行绿（新模块进入依赖图后不变）；clippy `-D warnings` 与
`fmt --all -- --check` 双工具链干净。开放项：AI-02 切片 2+（quote/submit、
§19.2 配对流程、capability snapshot 服务端产生、asset-sets、ai/jobs 的
`wallpaper.generate` capability 注册与路由）、AI-03～06。

## 2026-11-16 AI-02 切片 2：capability snapshot、quote/submit 与 ai/jobs 注册

`wallpaper.generate` 以 capability 注册项接入既有 jobs 机器（admission、幂等、
runner、派发标记、CAS、取消与结算全复用，无第二个 runner）；舞台沿 60/30 秒
与原上界不变。

- **capability 注册表**（`ai/jobs.rs::GenerationCapability`）：输入上界（舞台
  16 KiB／壁纸 12 KiB，来自合同层）、队列/执行期限（均 60/30 秒）与计费预留
  上界（各 50,000 micro-USD）按能力注册；受理时校验 quote 预留不超注册上界。
  worker 输入改为 `GenerationInput` 枚举（舞台 brief／壁纸结构化请求），按
  job.capability 分派 provider 调用与输出校验。
- **provider 结构化输出模式**（§19.5）：`generate_wallpaper_builtin` 沿
  `complete()` 的默认拒绝先例——未实现的 provider 安全拒绝；fake 提供确定性
  输出（用户选定的资格目录场景、参数走目录默认；不同场景的结果被拒绝）。
  壁纸输出经 `BuiltinSceneOutput` 全量校验后落 proposal
  （schema `wallpaper.builtin:1`），不 clamp。
- **capability snapshot**（`ai/wallpaper_jobs.rs`）：服务端对「本版本能力 ∩
  已就绪 adapter」产生，snapshotId 对内容字节求 SHA-256，同内容同 id；
  generationSchemaHash 对合同规范描述（版本、输出类别、全部边界、场景目录
  哈希）求哈希。quote 创建时三者必须一致（schema/快照/目录哈希），过期即
  拒绝，不做静默降级。
- **quote**（§19.4）：本地编码/计价，不发 provider 网络请求；绑定 owner、
  请求摘要、provider/model、凭据代际与价格快照；5 分钟到期、每 owner ≤8 个、
  合计 ≤128 KiB、内存态重启即丢。
- **submit 幂等消费**：quote 先乐观标记消费再送受理（并发同 quote 只有一个
  受理），受理失败还原为未消费；已消费 quote 仅允许同键同载荷回放原 job，
  换键拒绝 `quote_consumed`；quote 绑定的 provider/model 在 submit 时复核，
  确认后换模型即拒绝。输入指纹 = 规范化请求字节的 SHA-256，与幂等回放共用。
- **路由**（全权 token，local-owner）：`GET /v1/ai/wallpaper/capabilities`、
  `POST /v1/ai/wallpaper/quote`、`POST /v1/ai/wallpaper/jobs`；已登记
  [api-routes.md](api-routes.md)。短会话配对（§19.2）与桌面接线属切片 3。

真实证据：`ai::jobs::tests::wallpaper_*` 3 项（snapshot 确定性与自绑定、
schema/快照/目录三重过期拒绝、quote→submit→worker→BuiltinSceneOutput 校验
→proposal→同键回放→换键消费拒绝的端到端）；既有 ai::jobs 75 项回归全绿
（舞台路径不变）；双工具链 fmt/clippy/三 crate 串行套件全绿；ADR 契约通过。
日志存 `output/master-gate-ai02-20261116/`。

## 2026-11-16 AI-02 切片 3：短会话配对与原生生成面板

原 `ai_grants` 增加 `native_session` 交付模式（迁移 0030），数据库只存
256 位 bearer 摘要；60 秒单次 challenge 绑定 SID/PID/进程创建代际、Profile、
协议/构建和服务实例。内嵌桌面经 HostHandle command，同进程交付；独立 exe
经原固定管理管道检查真实 PID/SID。会话最长 30 分钟，不静默续期；提交和
派发事务复核授权及期限，撤权发送实际取消信号。

壁纸路由共用全权或窄会话入口，quote/job 按 grant principal 隔离；原 file
grant、只读 wallpaper key 和其它窄 key 不能进入本入口。配对登记不需要秘密，
真正批准仍由全权官方设置完成。原生固定本机发现来源；已连接 TCP 流在发送
任何 HTTP 字节前经 Windows TCP 表核验服务 PID/创建代际，禁止重定向。

页面仅获得安全状态。原生持报价与默认 No 的真实 MessageBox，展示描述、
场景、provider/model、地址标签、数据范围、90 秒最长等待及
free/metered/token-only 费用信息。拒绝不建任务；关闭面板保留已确认回执；
隐藏页签停止轮询；身份失效停止旧会话查询。迁移 0031 将非秘密 quote/request
标识与任务同事务保存，报价到期后的原请求恢复只读取原任务；未知服务错误
保留恢复资格。换 Profile、重启与撤权需要重新配对。

执行证据：1.88 服务 AI 全套 191 passed/1 ignored；其后新增并修复的官方并发
提交反例连同壁纸回归 25 passed/1 ignored；IPC management 20 项、原生
generation 6 项（真实 TCP 身份零字节、响应边界、配对生命周期、回执保留、
身份失效、HTTP500/404 恢复）通过。stable 三 crate lib Clippy、任务 Rust
格式、API 路由、ADR 414 项及原 UI 回归通过。

Windows 内嵌与独立形态分别五组通过：实际配对、默认 No 原生许可且拒绝不建
任务、关闭重开保留已确认任务、隐藏页签停止查询、断开撤权。最终候选
studio SHA-256 `a258bcd907e5bee3ab6c48598b487ba1ebfa636e79910d656f4f81ebeca68293`，
desktop SHA-256 `e8dc2781d793d91d2ba614754344e8dd2cd50eb17bb55fd1789b73aba5b373b4`。
脚本 `scripts/check-wallpaper-generation-native.js` 的隔离结果分别位于
`output/playwright/wallpaper-generation-1794792344202/result.json` 与
`output/playwright/wallpaper-generation-1794792355677/result.json`。

真实文本 provider 尚未提供壁纸模式，仅免费 fake fixture 可用。这不构成生产
provider 资格，也不代表 AI-03 的 artifact 接收、预览或保存已经完成。
