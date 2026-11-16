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
| AI-02 切片 4：本地 Ollama builtin adapter | 2026-11-16 已实施，受控 Ollama HTTP fixture 的 Windows 内嵌/独立各十项通过 | 下文实现与验证边界；实际版本/模型质量未验收 |
| AI-03 结果交付与入库 | 2026-11-16 builtin 候选链路已完成，Windows 内嵌/独立各九项真实验收通过 | 下文实现与验证边界 |
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

该切片收口时文本 provider 尚未提供壁纸模式，仅免费 fake fixture 可用。这不构成生产
provider 资格，也不代表 AI-03 的 artifact 接收、预览或保存已经完成。

## 2026-11-16 AI-03：不可变候选、预览与明确保存

服务生成结果接入 `ai/wallpaper_artifacts.rs` 与迁移 0032；wallpaper 不再新建
Stage proposal，旧 proposal 保留历史语义。原 jobs/usage/grants 继续拥有执行、
费用与授权，artifact 不成为第二份任务状态或活动配置。

- 受理事务先预留结果容量，每 service owner 最多八份、256 MiB、24 小时。
  固定目录的文件 flush/rename 后，available 与 job succeeded 在同一事务
  提交。文件或结果事务失败不能返回可导入结果，已发生的 usage 仍结算；
  恢复只收敛原任务与文件，不重新调用 provider。
- `GET /v1/ai/wallpaper/jobs/{jobId}` 返回安全 descriptor；固定二进制
  `/v1/ai/wallpaper/artifacts/{artifactId}` 使用 `wallpaper:read_artifact`
  scope，并复核当前绑定、service owner 和期限。最多两个活动读者，最长
  180 秒；实际文件句柄退出后才回收容量。官方全权入口可用 claimRevision
  明确认领到新配对会话；旧 jobId 本身不授予新会话读取权限。
- 原生复用 PID/进程代际已验证的本机连接及 Jobs 接收/准备槽。当前只接收
  ≤64 KiB 的 builtin 数据，按长度、SHA-256、目录和 schema 核验；接收额度
  纳入原内容预算。取消、来源变化、断流或迟到结果不建立新候选；重试只取
  同一 artifact。image/composition adapter 继续保持不可用。
- 迁移 0007 的 `ai_receipts` 将未保存候选留在候选域，接收和预览不创建普通
  work 草稿。明确保存时才转交原 WorkDrafts save/publish；安装、来源和 saved
  回执同事务提交。重复接收或保存回读原 receipt/workKey/packageHash；发布
  失败保留原已保存草稿供重试。`ai_origins` 只记录 provider/model、时间、
  输出 hash 和 AI 标记，不记录描述、费用或秘密。
- 候选面板展示静态场景参考、接收/取消、原唯一预览、作品名、保存及删除。
  关闭/隐藏释放预览并停止查询，重开恢复回执。保存后通过原“本地作品”入口
  独立选择和应用，生成与保存不会更改桌面配置。
- 服务到期回收使用单 deadline waiter；原生到期清理进入原管理 JoinSet，
  最多一个后台清理任务，候选变更通知和最早候选期限安排下一次唤醒，空库
  不新增常驻轮询；等待 SQLite 连接时仍可处理其它控制和布局查询。
  恢复桌面备份会使未保存候选 expired，已保存作品、工程和来源保持原引用。

本切片使用免费 fake fixture。Windows 内嵌/独立各九项实际验收通过，覆盖
生成、重复接收、真实 GL 首帧与预览关闭、明确保存和重开，并核对桌面设置
版本与当前场景保持原值。服务 AI 回归 199 项、desktop 串行回归 884 项、
store 回归 67 项及设置页浏览器检查通过；关闭按钮统一为右上角 X，键盘
关闭仍保留未保存修改确认。验证记录见
`docs/aegis/work/2026-11-16-ai02-generation-contract/90-evidence.md`。
真实文本模型、图像、组合及外部助手的资格继续属于 AI-02 后续 adapter
资格与 AI-04～06，fake 验收不能代替这些资格。

## 2026-11-16 AI-02 切片 4：本地 Ollama builtin 输出模式

显式配置本地 Ollama 后，壁纸生成目录可提供 builtin 模式。配置仍沿
[本地 Ollama](ai-stage-drafts.md#本地-ollamar5-实验接入)：只允许数字回环
origin 和已安装的本地型号，操作者须在 Ollama 端设置 `OLLAMA_NO_CLOUD=1`。
Hertz 不选择、下载或启动模型，配置失败不回落 fake；目录就绪只表示本地
配置有效，不通过目录/报价请求探测或调用模型。默认 provider 仍为 fake。

`ai/wallpaper_provider.rs` 从原 `hertz-wallpaper` catalog 派生所选场景的
sceneId/stateVersion 和 number/boolean/select 参数 schema、默认值、范围及
选项。请求只含本次描述和所选合同，不带 requestId、其它场景、歌曲、歌词、
音频、历史或密钥。每任务只请求一次 `/api/chat`，不流式、关闭 thinking，
拒绝非法输出、不 clamp、不修复或换场景。

专用 `quote_wallpaper_builtin` 编码完整壁纸请求，原 admission 经
`GenerationInput` 按类型重新核价。壁纸输出上限 4096 tokens，舞台保持 512；
完整请求最多 128 KiB，原受管响应仍最多 256 KiB，领域文本最多 64 KiB。
本地价格/预留为零，prompt/eval 计数由正式 response 字段独立处理；不能将
该本地计量标记当作云价或实际模型 tokenizer 保证。

生成直接复用原 Ollama 的 HTTP client、限流、envelope 解码及取消 future，
不调用 generic completion 或 StageIntent 生成入口。`WallpaperOutputError`
区分 provider 失败与合同拒绝；后者由原 jobs 终态 owner 记录 `invalid_output`。
取消、截断、工具调用、错误模型、未知/重复参数与越界输出不产生 artifact；
已获得的可信 usage 保留，派发后取消且无收据仍为 unknown。本地零金额不
改变任务派发或费用已知/未知的语义。成功结果继续进入原 AI-03 接收、唯一
预览、明确保存与来源事务，生成/预览/保存保持桌面配置版本和场景原值。

验证：Rust 1.88.0 新 adapter 八项及完整 `ai::` 207 passed/1 ignored；
Standard/Full 构建和 Clippy、前端 86 步、API214、ADR414 通过。
最终 Full Windows 候选在内嵌/独立形态各十项通过，包含报价/No 零请求、
一次确认后单次模型请求、真实 GL 首帧、重复接收/保存、重开、隐藏停查和
撤权。原生分页参数在保存后和重开后核对时段 0.72、减少动态 true；只读
检查原 artifact、已保存工程、真实安装包及 `ai_origins` 的 hash/provider/model
关联。证据位于 `output/ai02-ollama-20261116/`。

本轮 HTTP 回环响应为无费用 fixture，不连接实际 Ollama 推理进程。实际
Ollama 版本/型号的单次输出、模型质量/时长、OpenAI/StepFun 壁纸模式与
AI-04～06 仍未验收；这些边界不由 fixture 通过替代。

## 2026-11-16 AI-04：图像计费与冻结执行策略

计费数据类型在 `ai/pricing.rs`，原 `usage.rs` 继续拥有结算、pending 收据、
迟到用量 CAS 和同一 DataDir 月预算。旧 token 价格/usage JSON 保持原字段，
旧价格标签仍为不透明的冻结费率标识，不强制新增版本后缀；历史缺价格依据
仍是未验证记录，不按今天的价格补算。

新 `metered-v2` quote/usage 使用 inputTokens、outputTokens、imageOutput 三项
完整向量。每项报价明确 quantityLimit、unitPriceMicroUsd、unitScale；图像
SKU 固定宽高/qualityId，必须按完整单张价格计价。金额使用 u128 checked
乘法并逐项向上取整求和，图像预留上限 500,000 micro-USD；文本保持 50,000，
共用原 5,000,000 月预算。新 JSON 不输出旧 token 零值占位字段，版本混用、
维度缺失/重复、SKU 不符、零 scale 或金额溢出不会被当作免费结果。

取消后的已派发图像缺收据时按冻结预留记 unknown；可信收据可在原任务清理后
按原 attempt/owner/月份幂等校正。超预留用量完整计费并触发原 guard。
token-only 模式的金额始终为 null；错误类型的收据不能把它改成已核价零。
官方只读账本保留各项 quantity/rate 的十进制字符串，展示图像张数与 SKU，
不会把缺失图像维度默认为零 token。

迁移 0033 为原 jobs 新增冻结队列/执行期限及受理费用上限，历史记录维持
60/30 秒与 50,000，图像策略为 60/180 秒与 500,000。SQLite 守策略与向量
结构，完整价格计算归 Rust。worker 从取得原执行槽起使用一次单调期限，
重载、凭据及 provider 调用不会重新获得完整预算；sweep 读取任务冻结期限。

该切片只交付计费与执行策略。ImageProvider、受限图片接收/准备、原生图像
候选与生产 OpenAI Images 资格仍待后续实现；图像当前不进入可用目录。
官方资料访问返回 HTTP403/超时，未猜测型号/费率，未发真实模型或付费请求。
步骤与验收见 `docs/aegis/plans/2026-11-16-ai04-image-generation.md`。
