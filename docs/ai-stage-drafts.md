# 舞台意图草稿（R3）

舞台意图草稿只描述现有场景与参数，不包含代码、URL、外部资源或时间轴。工坊在本地校验并生成完整候选；确认应用前不修改已提交预置。生成任务成功只说明 intent 已验证并保存。

场景页的[内置创作模板候选](./stage-templates.md)复用此校验/临时预览/确认 owner，并以完整具名候选绑定模板身份；模板不查询 AI 提案、不调用模型，人工视觉验收仍待完成。

## 使用方式

在「创意工坊 → 高级编排 → 导出」粘贴草稿 JSON，点击「校验并预览草稿」。面板显示当前值与候选值、请求值与规范化值，以及被调整到支持范围的参数。展开详情可查看完整候选与分享码。点击「应用到当前舞台」后才提交并保存；收藏仍使用原收藏入口。

取消、切换页签、关闭工坊、隐藏页面会丢弃临时预览。普通编辑使旧预览失效。已有自动保存定时器始终保存已提交预置，分享当前舞台及收藏也读取已提交内容。预览详情里的草稿分享码则明确代表候选。

AI 提案使用同一校验、预览、确认路径，应用前重新查询提案状态、有效期与内容。旧提案如果没有生成时保存的版本信息，允许查看但需要重新生成才能应用；不会补上当前版本的 hash 来绕过兼容检查。

## 信封与版本

草稿为 UTF-8 JSON，最多 16384 字节、嵌套最多 8 层，未知字段、危险键及非有限数值一律拒绝。只支持 `create`，从同版本目标场景的规范默认值开始；本地「一句成景」保留编辑当前预置的原语义。

```json
{
  "artifactVersion": 1,
  "mode": "create",
  "intent": {
    "version": 1,
    "scene": "orb",
    "patch": { "sc.radius": 2 },
    "director": false
  },
  "schemaVersion": "从契约查询结果复制",
  "schemaHash": "从契约查询结果复制",
  "basePresetHash": "从该场景的 basePresetHashes 复制"
}
```

示例中的版本/hash 占位必须替换为契约查询返回的实际值。hash 用于版本一致性，不是作者签名。`schemaHash` 是排序对象键后的 canonical JSON 的 SHA-256，覆盖 `intentSchema`、公共参数与各场景参数的名称、范围、默认值，以及场景 id/别名/歌词归属；数组顺序保持不变。仅改动会影响校验或物化的这些约束也会使旧草稿失效。`basePresetHash` 来自原前端 owner 的 `canonicalBaseline(scene)`，Rust 不复制完整基线、物化或分享 codec。浏览器不提供 WebCrypto 时使用相同算法的本地实现。

## 外部工具

已有外部连接与授权门禁保持生效，另需通过官方设置 API 将 `ai_stage_intent_tools` 设为 `true`；此开关默认关闭。修改后重新连接 MCP 会话以刷新工具列表。关闭开关会立即阻止已有会话调用这两个工具。人工导入不依赖该开关或任何 AI API。

| 工具 | 必需 scope | 输入与结果 |
| --- | --- | --- |
| `stage_capabilities_get` | `stage:capabilities_read` | `offset` 默认 0（0–10000），`limit` 默认 5（1–10）；返回场景、通用参数、版本/hash、`nextOffset` |
| `stage_intent_validate` | `stage:intent_validate` | 输入完整草稿信封，返回 `validationStage=intent`、`validatedIntent`、版本/hash、原信封及诊断，`persisted=false/applied=false` |

两者只读，不创建任务、不调用模型、不返回完整预置或分享码、不远程应用。服务端验证路径和参数形状；前端物化时才钳制参数，并验证完整预置及 codec 往返。当前参数越界不会被服务端称为已完成完整舞台校验。

## 费用账本

打开工坊 → 高级编排 →「费用账本」，按 UTC 受理月和费用状态查看当前实例的所有费用入口。任务清理后，十三个月内的账目仍可查询。unknown/estimated_final 是保守估算，不代表供应商已经结清；released 表示未派发即终止，reported 表示收到可信计量。默认运行时为本地 fake；可显式选择实验性的本地 Ollama。StepFun 可在用户明确选择、配置密钥并开启生成后按 token-only 模式派发；金额未知不阻挡功能，也不进入金额总账。

「诊断详情」可查任务编号、主体、终态、价格版本、规范化 token 计数和费用 revision。旧库缺少可回填事实时显示历史归因或价格不完整，不按当前配置重算历史。筛选只影响列表，当月总账保持全实例口径。浏览、翻页和刷新不调用模型，不存在客户端修改费用接口。

管理接口：`GET /v1/ai/ledger?month=YYYY-MM&usage_state=reported&limit=20`；省略月份查询当前 UTC 月，状态可省略。返回 `nextCursor` 时同时传 `before_sort_at` 与 `before_job_id` 翻页。每页 1–50 条，金额和计数为精确十进制字符串。历史无月份记录可用 `month=unassigned` 查询。可信宿主 RPC 使用相同 path/query；受限 capability 凭据无权读取此接口。

## 本地 Ollama（R5 实验接入）

在 Hertz 数据目录的 `config.toml` 配置后重启服务：

```toml
[ai]
provider = "ollama"
origin = "http://127.0.0.1:11434"
model = "你的已安装本地模型名"
```

Ollama 必须已运行、已有支持结构化输出的本地模型；Hertz 不下载或选择模型、不自动启动 Ollama。需在 Ollama 服务端设置 `OLLAMA_NO_CLOUD=1`，确保本地模型别名或 Modelfile 不转交云端。Hertz 拒绝名称含 cloud 的模型；只连接显式数字回环 `127.x.x.x` 或 `[::1]` 的 HTTP(S) origin，禁止路径前缀、查询、凭据、代理和重定向。`localhost` 需改写为明确回环 IP。不会从本地失败自动切云。`ready` 仅表示本地配置有效，不是模型在线/能力探测；启动、状态与账本查询均不发模型请求。

工坊仍需单独开启生成。一次任务只发一次 `/api/chat`，非流式结果、关闭 thinking、输出上限 512 tokens；拒绝或失败不自动修复与重试。只发送用户描述、现有场景/参数/默认值/版本与静态 create 约束，不发送当前歌曲、历史、歌词、封面或音频。时序和相对编辑请求可返回 `{"unsupported":true}` 并如实失败；模型语义仍需评测，不能只凭 schema 合法宣称理解正确。

所有 HTTP 状态的响应按实际流限制为 256 KiB，领域 JSON 最多 16 KiB/深度 8。外层及模型文本先拒绝重复键、危险键、非有限数值和尾随文本，再走原 intent 校验；不从 Markdown 抽取或修补 JSON。截断、工具调用和错误模型身份不创建提案。有效的本地计量计数可独立保留，即使候选无效或已取消；缺计量保持 unknown。

任务终态提交后关闭该任务的取消信号；Ollama adapter 在首次发送前和整个 HTTP 发送/读取期间监听它。取消停止本地等待并丢弃受管请求 future，不重试 POST；执行槽仍由 worker 持有，直到 adapter 实际返回或三十秒总期限结束，不能仅凭 UI 终态提前归还。断开连接不能证明 Ollama 已停止计算，也不会凭空补出 usage；已有完整可信计量仍可独立结算，未得到计量保持 unknown。本地费用为零不改变这些事实。独立评测没有交互取消入口，仍受原总期限约束。

本地 adapter 的价格与预留为零，记录 Ollama 的 prompt/eval 计数；这不计算电费，也不是任何云模型的可靠 token/价格上界。输入 token 上限的 `u64::MAX` 仅表示该零价本地 adapter 未承诺 tokenizer 上界。StepFun 云 adapter 已支持有限请求和 token-only 账本；真实应用内 usage、其它 OS/锁定与拒绝访问、云端边界及模型评测仍待完成。

配置错误显示 provider unavailable，不回退 fake；TOML 语法或字段类型错误阻止服务启动，错误不回显文件正文。恢复 fake 需显式设 `provider = "fake"` 并重启。官方 UI 展示当前模型与数据范围，受限工具不能改变 provider 配置。

协议依据：[Ollama Chat API](https://docs.ollama.com/api/chat) 与[禁用云功能说明](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features)。目前只通过可控 HTTP fixture 验证协议边界，尚未指定或验收某个实际 Ollama 版本/模型。

协作取消增量验证（2026-10-18）：Standard / Full 完整 Hertz 库 420 / 577 项通过，另 4 / 6 项忽略；两版全 target Clippy、Rust 1.88.0 工作区全 target 编译、fmt、285 项 ADR 契约和前端默认 56 步通过。实现后新增发送前取消不建连接、TCP 对端无响应头/部分正文时观察到关闭且不重试，以及清理暂停期间执行槽不释放的回归；原取消后迟到用量校正仍通过。

最新 Standard 的 `scripts/check-ai-provider-browser.js` 通过实际 Chrome 与受控回环 HTTP 验证：取消后服务端等待的响应连接关闭、没有虚构 usage、禁用队列不派发，后续新任务可以执行；同时重跑凭据双实例/浏览器和独立评测 CLI。默认报告 `output/ai-provider-browser.json`（可用 `HERTZ_PROVIDER_BROWSER_REPORT` 改路径）记录二进制、三份 Rust 源码与脚本哈希。构建/报告在 D 盘，null 音频与显式内存凭据，没有实际 Ollama 模型或云请求；报告的受控协议成绩不能当作真实模型质量或停止计算的证明。

## 模型评测

独立评测入口复用真实 adapter、提示和校验，在播放器 bootstrap 前运行，不读取用户曲库或创建生产任务。当前语料 v3 保留 120 条开发集与 40 条预留合成样本；标签独立复核、实际模型、两轮评测和正式发布阈值仍待验收，单轮报告不会自动宣布可发布。运行命令、人工评分规则与指标分母见 [StageIntent v3](../evals/stage-intent/v3/README.md)。v1/v2 基线保留为历史证据。

## 工程验证

```powershell
node scripts/export-stage-contract.js --check
node scripts/check-stage-materialize.js
node scripts/check-stage-evaluation.js
node scripts/check-frontend.js
$env:VMUSIC_BACKEND='null'
cargo test -p hertz-studio -p vmusic-store --lib -- --test-threads=1
node scripts/check-stage-draft-browser.js
node scripts/check-ai-tasks-browser.js
node scripts/check-ai-ledger-browser.js
node scripts/check-ai-provider-browser.js
node scripts/check-ai-credential-browser.js
node scripts/check-stage-evaluation.js --live
node scripts/check-mcp-stdio.js
cargo test --locked -p hertz-studio --test mcp_sdk --target-dir target/mcp-sdk-check -- --test-threads=1
```

官方 Rust SDK 与真实 stdio 子进程的协议、授权、幂等和生命周期检查见 [MCP 互操作说明](./mcp-interoperability.md)，Standard / Full 应分别执行；SDK 检查不代替目标应用中的正式连接验收。

StepFun `step-5-preview` 已通过独立最小 Responses 连通性检查，并接入静态 create、严格输出、持久任务及 token-only 账本；OpenAI Responses 也可在显式配置 `ai.model` 后走相同有界链路。费用未知时两者均不做金额预留或金额门槛，只记录可信 token，不表示免费。默认仍使用 fake，需显式配置 provider、型号、凭据和生成同意后才会发请求；本机尚未完成真实应用内调用、真实 usage 字段或模型质量验收。凭据浏览器检查使用合成密钥与显式内存后端；StepFun 的界面路径可用 `node scripts/check-ai-credential-browser.js --stepfun` 定向检查。

浏览器检查需要 Playwright 和已构建服务，可通过 `PLAYWRIGHT_MODULE`、`HERTZ_BIN` 指定。独立账本检查另需 Python 标准库 sqlite3 写入隔离测试数据，可通过 `PYTHON` 指定解释器；产品运行不依赖 Python。生成契约时运行 `node scripts/export-stage-contract.js`，服务端 JSON 和浏览器材料必须一起更新。全场景检查加载真实 GL、动画场景、背景、手绘、舞台及分享 codec；浏览器检查覆盖待执行的 400ms 保存、取消、切页、关闭、编辑失效和确认保存。自动化结论不代替真实 DBX、弱机 GPU 或正式 MCP 客户端验收。
