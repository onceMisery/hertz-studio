# StageIntent v1 评测

本目录冻结 160 条公开合成描述：120 条开发集、40 条预留集，覆盖常用、词典外、否定、冲突、数值边界、跨场景、未知场景、提示注入、长文本、时序和相对编辑。`manifest.json` 保存原始 UTF-8 JSONL 字节 hash、契约 hash、分类数量和来源。换行固定 LF；修改样本或标签应创建新版本，不能沿用旧报告。

这些样本由项目编写，**标签尚未经过独立人工复核，预留集也不是独立采集的真实使用样本**。不包含私人歌词或媒体。不能把现有材料称为已通过的独立质量验收。

## 离线检查与基线

在仓库根目录使用 Node.js 22 或更新版本；产品运行不依赖 Node。默认只检查冻结集，不调用模型：

```powershell
node scripts/evaluate-ai-stage.js --validate
node scripts/check-stage-evaluation.js
node scripts/evaluate-ai-stage.js --baseline --split development --out output/evals/baseline-dev
node scripts/evaluate-ai-stage.js --report output/evals/baseline-dev
```

输出目录必须不存在。旧离线编译器原本用于当前舞台编辑，评测将它置于明确的 canonical context；省略场景时补 `towers`、省略 patch 时补空对象，再复用实际草稿校验器和物化器。不会读用户当前预置或修改原编译器。旧编译器只处理前 120 个 Unicode code points，模型入口允许 16384 UTF-8 字节；长文本差异会如实体现在结果中。`baseline_no_match` 是无规则命中，不等同于协议中的明确拒绝。

2026-10-18 的基线证据见 [baseline-20261018.json](./baseline-20261018.json)：开发集 120 条，97 条产生候选、23 条无规则命中；70 条预期支持的输入中，66 条通过结构/物化检查，只有 32/120 条满足场景及指定参数的全部自动断言。预期必须拒绝的样本中有 31 条返回候选，关键断言失败 53 条。人工语义评分仍为 null。这是扩大后的静态 create 契约对旧规则的对照，不能推断存在工具执行或权限越界，也不能推断某个模型更好。

## 本地模型运行

先安装并启动 Ollama、安装拟评测的本地模型，并在 **Ollama 服务进程** 设置 `OLLAMA_NO_CLOUD=1`。Hertz 不安装模型、不自动启动服务、不调用收费云模型。不要把本地模型 tag 视为内容 digest；另行记录实际模型 digest、Ollama 版本、量化、硬件、OS 和冷/热加载条件。

评测使用与产品相同的专用 Ollama adapter、提示、schema、严格 JSON 和服务端 intent 校验。只向数字回环 origin 发一次 `/api/chat`，无自动重试或 JSON 修复。每条模型调用最多 30 秒；驱动子进程上限 45 秒，进程失败会保存中断记录并停止整轮。禁止把云代理伪装成本地零价服务。

```powershell
cargo rustc -p hertz-studio --bin hertz-studio -- -o target/review-bin/hertz-review.exe
node scripts/evaluate-ai-stage.js --run-local --model YOUR_INSTALLED_MODEL --origin http://127.0.0.1:11434 --round 1 --split development --binary target/review-bin/hertz-review.exe --out output/evals/model-dev-r1
```

该 CLI 在配置读取、数据迁移、数据库、音频和 HTTP 服务启动之前分流；只读取 stdin 的合成描述，不读取用户曲库或 DataDir。不创建生产任务或账本记录；这项独立评测只支持零价本地 adapter。工坊的生成同意开关不授权后台评测，显式 `--run-local` 命令本身才是本次调用的操作入口。

`--limit 2` 可做环境检查，但报告明确为不完整且 candidateChecks 失败。不要把环境检查当成一轮验收。预留集必须显式加 `--split holdout --allow-holdout`；在冻结模型、提示、正式阈值和标签复核之前不要用于调参。

## 输出与复现

每轮保存以下文件：

| 文件 | 内容 |
| --- | --- |
| `run.json` | 样本选择及完成状态、语料/契约 hash、模型 tag、回环 origin、二进制 SHA-256、评测驱动与物化代码指纹、协议指纹和结果 hash |
| `results.jsonl` | 每条结果、已验证 intent 或 null、请求 hash、规范化 token 计数、固定错误分类、耗时；不保存原始模型输出或服务端错误正文 |
| `reviews.json` | 人工评分模板；初始 pass 为 null，不预填通过 |
| `report.json` | 自动断言、结构、拒绝/接受、截断、耗时、计量缺失、人工评分及未满足的发布条件 |

`kind` 分为 candidate、refused、truncated、invalid_intent、invalid_json、invalid_protocol、transport_or_configuration、timeout；离线基线另有 baseline_no_match。错误 JSON、超时或无命中不会得到“正确拒绝”的自动匹配分。模型计量独立于候选合法性保存，计数用十进制字符串，未知为 null；价格和预留为零不表示已核对真实云账单。

每个样本单独启动 CLI；`elapsedMs` 计量 provider 调用，包含模型加载等待和返回解析，排除子进程启动、用户排队和完整 UI 旅程。离线基线计量规则编译；两者不能替代端到端性能验收。请求协议指纹包含实际模型名和完整系统契约，具体请求另有 hash。模型 tag、包版本和二进制指纹不证明 Ollama 背后的实际模型 digest。

重算报告会核对结果 hash、原样本覆盖、模型/协议/契约身份及当前物化器和驱动指纹。代码已变更时使用原 revision 复现，或创建新运行目录；不要手改 hash 把旧结果伪装成新轮次。hash 只用于一致性核查，不是签名或防篡改证明。中断后可用 `--report` 查看已保存的部分结果，仍会判为不完整；没有自动续跑或重试。

## 人工评分规则

先由独立复核者检查输入与期望标签是否符合当前静态 create 边界。遇到歧义记为语料问题，修订新版本后重新比较所有候选；不要看过模型成绩后改变原标签。开发集可用于分析，预留集应由未参与提示调优的复核者保管和评分；必要时另采集不含私人数据的独立样本。

对预期支持的每条输入，核对原文、候选 intent、从 canonical baseline 物化的实际预置，并在产品草稿导入/预览中检查有视觉含义的要求。数值不明的描述需依据预先约定的评分准则复核，不凭 schema 合法就给通过。通过必须同时满足：

1. 场景正确；明确数值、否定和相互约束全部保留，没有把“不要”执行成“要”。
2. 未指定参数来自该场景基线，没有借用当前活动舞台或偷偷替换需求。
3. v1 不支持的时序、相对编辑、非法参数或执行指令没有被静态候选冒充完成。
4. 视觉要求在目标环境预览符合预先定义的可观察标准；尚未检查的项目保留 null。

修改 `reviews.json` 中对应条目，例如：

```json
{"caseId":"dev-common-01","pass":true,"reviewer":"实际复核者标识","note":"球体场景符合；按固定基线预览，无额外运动要求。"}
```

可导出用于人工预览的材料：

```powershell
node scripts/evaluate-ai-stage.js --export-review output/evals/model-dev-r1 --out output/evals/preview-dev-r1
```

新目录的 `index.json` 包含描述、预期、自动断言结果和可导入文件名。只有经过产品原 `CreativeDraft.artifact/prepare` 的版本/hash、基线、完整物化及分享往返检查的候选才导出 `.artifact.json`；其它记录保留拒绝/失败事实。将文件正文粘贴到工坊草稿导入并临时预览，评分无需确认应用。该命令不启动产品、不修改活动舞台、不调用模型，也不会把自动检查结果代填成人工通过；评分仍填写原运行目录的 `reviews.json`。

失败时 pass=false 并记录不符合的要求。reviewer/note 必须非空，不能代填真实人工意见。模板包含拒绝类样本，也可记录其人工意见；当前 humanSemanticPassRate 仅以该 split 的全部预期支持样本为分母。没有完成全部支持样本的评分时显示 null，人工通过不能覆盖已知自动断言失败。拒绝类样本的结构与错误接受另外报告；工具不能验证复核者是否独立。

```powershell
node scripts/evaluate-ai-stage.js --report output/evals/model-dev-r1
# 若评分另存文件，显式指定；该命令不会覆盖原始评分文件。
node scripts/evaluate-ai-stage.js --report output/evals/model-dev-r1 --reviews output/evals/review-r1.json
node scripts/evaluate-ai-stage.js --compare output/evals/baseline-dev --against output/evals/model-dev-r1
```

比较命令要求同一完整 split 和样本选择，重新验证原始结果后输出双方指标、自动匹配改善/退步数量及样本编号。若双方使用外部评分文件，分别传 `--before-reviews` / `--after-reviews`。比较不会读取先前 report.json 中可能过期的分数，也不会替人工判定质量。

## 指标与发布约束

| 指标 | 分母与含义 |
| --- | --- |
| supportedSchemaRate | 预期支持的全部样本中，候选通过实际 intent 校验和物化的比例；不是语义正确率 |
| protocolStructureRate | 该 split 全部预期样本中，合法候选或明确拒绝的比例；缺结果仍留在分母 |
| autoMatched | 候选满足预期场景/全部指定参数，或应拒绝时明确拒绝的数量；未覆盖的语义仍需人工检查 |
| falseAcceptances | 预期拒绝却返回 candidate 的数量；不表示实际执行了外部指令 |
| falseRejections | 预期支持却没有 candidate，包含明确拒绝及技术失败；具体原因另见 outcomes |
| criticalFailures | 关键样本的候选违反自动断言，或候选无法合法物化的数量 |
| humanSemanticPassRate | 全部预期支持样本完成具名、有说明的评分后，人工与自动检查同时通过的比例 |
| truncationRate / P50 / P95 | 已保存结果的截断比例与 provider 延迟分位数；不完整轮次单独判失败 |

当前代码集中保存建议门槛：支持结构和全样本协议结构 ≥98%、人工语义 ≥90%、截断 ≤1%、P95 <30000ms，关键反例误接受及输出上界违反为零。这仍是建议门槛；candidateChecks 为 passed 只说明本轮满足这些检查，**所有单轮 report/comparison 的 releaseEligible 固定为 false**。

正式发布还需指定且验证实际模型 digest/runtime/硬件，独立复核标签并冻结正式阈值，完成至少两轮模型运行与独立保留样本验收，再补齐实际宿主、GPU 和产品任务链路验收。未通过时保持实验能力，不静默切换离线规则。云服务还需单独实现凭据、隐私、可靠计费上界和真实账单核对，本地零价评测不能代替。
