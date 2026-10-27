# ADR-0010 · 舞台草稿由原 owner 预览，任务历史与账本独立保留

状态：生效（2026-10-18）；2026-10-23 按 `2f2765c` 回写已实施的范围调整：用量/费用为可选能力，成功的舞台任务与提案先提交、用量独立结算，token-only 不受历史计量熔断阻塞。该回写对应[路线范围修订](../technical-roadmap.md)和[10 月 21 日实施记录](../roadmap-progress.md)，不表示真实 provider 质量或账单已验收。

## 决定

外部草稿和生成提案保存显式 create 信封：intent、schemaVersion、schemaHash 与目标场景的 basePresetHash。契约由实际前端场景和默认值生成，Rust 只验证 intent；完整物化、钳制与 codec 往返归原 CreativeStage/CreativeShareCode。旧提案不补当前版本标记。

CreativeStage 以独立临时呈现层预览候选。自动保存、分享当前舞台和收藏只读 committed preset；确认应用需同时匹配 previewId、baseRevision 和 proposalHash。切页、关闭、隐藏及普通写入丢弃预览。人工导入不创建 job，也不依赖外部接入或生成开关。

持久任务在短事务中受理，始终检查授权、并发、记录数与逻辑容量。任务记录的七天保护期内不为新任务腾位置。只有已核价模式检查金额 guard、月预算并预留费用；token-only 任务不要求价格或金额额度，但仍遵守同意、输入/输出边界、单执行槽、持久派发和不自动重放。现有实现保留账本表与快照结构，不代表产品有可任意删除这些表的无账本运行模式。

提案到期清除载荷；可选账本独立保留原受理月与 attempt 身份。已核价 unknown 超过 24 小时只转 estimated_final，不改变已记金额；未核价记录为 unpriced，不能当作免费或实际金额为零。两种状态均不表示服务商账单已核实。

逻辑数据按 AI 表每行 JSON 投影的 UTF-8 字节求和，独立于 DB/WAL 物理大小；为每个未完成任务保守预留转义后的候选与元数据空间。保留当前 UTC 月及此前十二个月的账本；仍被保留账目引用的旧月份不提前删总账。明显墙钟回跳时暂停清理和新受理，历史仍可查。

受理时冻结 provider/model、请求上界、凭据身份及计量模式，生成执行接收同一快照；已核价模式另固定费率与预留，token-only 使用未核价标记。当前计价模型只覆盖未缓存输入与包含推理的计费输出，真实计价 adapter 必须验证对应语义，不能把缓存、图片或其它收费维度悄悄归零。旧任务缺少价格依据时保留 legacy-unverified，不按当前配置补算。

任务终态和 usage 终态独立。舞台草稿成功路径先在同一事务中 CAS succeeded、插入并关联提案；竞争失败不能留下提案或复活终态。该事务提交后才由 `settle_terminal_after_commit` 独立结算用量，失败/超时不撤销已成功任务。可信 usage 尽力先写 pending 记录，后续通过 `drain_pending_usage` 幂等补记；pending 写入也失败时不能承诺所有计数都可恢复，任务结果仍保留，诊断明确未知。

上述成功路径隔离不改写其它终态路径：当前取消、失败、重启恢复与孤儿清扫仍按各路径的短事务同步提交终态及派发态结算，逐任务失败隔离及重试保持原规则。不要把“成功与用量独立”扩大成所有账本/存储异常下均无影响的承诺。

歌词情绪的生产 completion 同样登记持久 job，但由 `ai/emotion.rs::{begin_completion_job,finish_completion_job}` 处理，当前终态与用量仍同事务；它不生成舞台提案，不自动继承上述成功提交隔离。受管评测则不创建生产 job/提案/账本，结果留在显式评测报告，不能以它证明生产任务恢复已验收。

只有 provider adapter 解析的可信计数可用于统计，模型生成的 JSON 不是账单。取消/过期后的迟到 usage 只按相同 attempt 与 usage revision 校正，不生成提案。相同计数重复回调不变更账目，冲突计数不得覆盖，estimated_final 仍可接受可验证校正。已核价的差额、账本 CAS 和月份总额在同一事务中完成，不重复释放预留。

已核价金额用整数 micro-USD，输入/输出分项向上取整；金额超预留、月限额或不可表示时触发金额 guard，月限额包含其它在途预留。不能截断、溢出或乐观归零；已核价派发后没有 usage 的成功请求同样记 unknown。

provider 报告的 token 数超出本地估算只记录诊断，不触发 token 熔断；历史 token_halted 不阻塞新任务或派发，token-only 也不受历史金额 guard 阻塞。请求本身的输入/输出与流量限制继续在派发/解析边界执行；不能用事后统计替代这些限制。官方 UI 区分 unpriced、估算及已核价结果，不把未核价金额展示为真实零费用。

实现依据为 `ai/jobs.rs::{submit_owned,run_job_inner,settle_terminal_after_commit}` 与 `ai/usage.rs`；既有回归 `terminal_ledger_failure_does_not_undo_token_only_task_success`、`token_only_settlement_records_over_bound_usage_without_claiming_cost`、`token_only_generation_ignores_legacy_accounting_guards` 固定这些边界。本次只核对源码，未重跑上述测试。

`GET /v1/ai/ledger` 只在官方管理面与可信宿主 RPC 开放，跨当前实例的所有主体显示费用；受限 capability 不获得此能力。查询沿用惰性过期/保留处理，不调用 provider、不提供账单写入。月份总账与列表在同一读快照内查询，状态筛选不改变总账；金额和计数以十进制字符串返回，保留整数精度。每页使用稳定 `(sortAt,jobId)` 游标，按受理时间排序；尚未结算的 job 作为 reserved 投影，结算后仍使用相同受理时间。

新迁移 `0019_ai_ledger_browse.sql` 将 owner/principal/终态/受理时间保留到费用记录，不随 job 清除。旧库能关联到任务时回填；任务已丢失时保留 NULL，显示历史归因不完整，排序才回落到既有记账时间。诊断只返回白名单字段、规范化计数和可验证价格快照，不输出任意原始 JSON。工坊账本按需刷新、翻页和筛选；关页/隐藏作废旧响应，无后台账单轮询。

R5 的本地 Ollama adapter 由 `config.toml` 显式选择，默认保持 fake；不影响独立且默认关闭的生成开关。数字回环专用客户端无 DNS、cookie、代理、重定向、自动重试或自动解压；所有状态的响应按实际字节限流。外层响应及模型文本在转 Value 前检查重复键、危险键和深度。提示只含描述和场景契约，静态 create 以外允许拒绝；不提供工具、联网或取私有媒体能力。候选有效性和本地 prompt/eval 计数独立处理。

该 Ollama adapter 只允许本地模型，操作者在 Ollama 服务端禁用 cloud，价格与预留固定为零，不代表云模型成本或计量保证。`max_input_tokens=u64::MAX` 是零价本地未作 tokenizer 上界承诺的标记，实际请求仍有字节/输出边界。另有显式配置的 OpenAI/StepFun adapter 采用有限请求和 token-only 模式，不以核价为派发前置。配置无效不自动回落到 fake；语法/类型错误拒绝启动且错误不回显 TOML 正文。真实模型质量、硬件延迟、云 endpoint 与实际计量仍分别验收。

## 边界与 owner

| 数值 | 现在是多少 | 定义在哪 | 改它要一起改什么 |
| --- | --- | --- | --- |
| intent JSON 字节上限 | 16384 | `crates/hertz-studio/src/ai/jobs.rs::MAX_INPUT_BYTES` | 前端草稿边界、服务端契约校验、生成信封总大小与负例 |
| 排队与执行中的任务总数 | 9 | `crates/hertz-studio/src/ai/jobs.rs::QUEUE_CAPACITY` | 单执行槽、输入交接、取消、过期与容量回收 |
| 任务保护期（毫秒） | 604800000 | `crates/hertz-studio/src/ai/jobs.rs::KEY_WINDOW_MS` | 旧 key 拒绝、历史清理、校时水位与重放 |
| 提案窗口（毫秒） | 86400000 | `crates/hertz-studio/src/ai/jobs.rs::PROPOSAL_TTL_MS` | 提案读取、内容清除、应用前复查 |
| 受保护任务条数上限 | 500 | `crates/hertz-studio/src/ai/jobs.rs::HISTORY_JOB_LIMIT` | 事务内 admission、满表拒绝与七天保护 |
| AI 逻辑数据字节上限 | 20971520 | `crates/hertz-studio/src/ai/jobs.rs::HISTORY_BYTE_LIMIT` | 全部 AI 表容量统计、受理失败不预留 |
| 每个未完成任务逻辑空间预留（字节） | 36864 | `crates/hertz-studio/src/ai/jobs.rs::HISTORY_TASK_HEADROOM_BYTES` | 16 KiB 信封二次 JSON 转义最坏大小与元数据 |
| 单任务预留上界（micro-USD） | 50000 | `crates/hertz-studio/src/ai/jobs.rs::RESERVATION_MICRO_USD` | provider 报价验证、unknown 保守结算、迟到差额；真实 provider 另验完整请求上界 |
| DataDir 月预算（micro-USD） | 5000000 | `crates/hertz-studio/src/ai/jobs.rs::MONTHLY_LIMIT_MICRO_USD` | 共用总账、guard、跨月与复位 |
| 账本每页上限 | 50 | `crates/hertz-studio/src/ai/ledger.rs::PAGE_LIMIT` | store 额外取一行判断下一页；HTTP/RPC 同契约，UI 默认二十条 |
| 模型 HTTP 响应字节上限 | 262144 | `crates/hertz-studio/src/ai/provider.rs::RESPONSE_BYTES` | 含失败状态；按实际流累计，超限中止，不先完整读取 |
| 完整本地模型请求字节上限 | 131072 | `crates/hertz-studio/src/ai/provider.rs::REQUEST_BYTES` | 包含提示、契约、schema 与用户描述，不是付费 token 上界 |
| 本地模型输出 token 上限 | 512 | `crates/hertz-studio/src/ai/provider.rs::OUTPUT_TOKENS` | num_predict、截断检查、快照与真实模型评测 |

## 禁止回退

- 不用先 setPreset 再恢复实现预览，否则 400ms 定时器会持久化未经确认的候选。
- 不把当前活动预置冒充 create 基线，不对旧提案补当前 hash 后应用。
- 不把服务端 intent 校验当成完整 preset、分享往返或真实 GPU 画面已验收。
- 不在七天内 FIFO 删除任务来容纳新收费请求，不把删除后的旧 key 当作新动作。
- 不随 job 删除费用归因，不在 24 小时后释放 unknown 的估算费用。
- 不以 DB 文件或 WAL 物理体积替代定义明确的逻辑容量。
- 不在校时异常期间批量清理，不因翻月、重启或换模型解除持久 guard。

- 不把 succeeded 当作免费或已结账，不因取消/非法输出丢弃已取得的可信 usage。
- 不按新价格或当前月份重算旧请求，不在重复回调时再次释放预留。
- 不接受客户端写入费用，也不接受模型文本中的 usage 冒充 adapter 可信计数。
- 不因用量写入失败回滚已提交的成功提案，否则可用结果会被可选统计破坏；原取消/恢复事务不可据此擅自拆开。
- 不用 token 估算偏差或历史计量 guard 阻塞 token-only 任务；也不将 unpriced 伪装成真实免费调用。
