# 模型密钥接入准备（OpenAI / StepFun）

本页对应 R5 的凭据管理增量。StepFun adapter 将启动配置中显式选择的模型 ID（例如 `step-5-preview`、`step-3.5-flash-2603`、`step-3.5-flash`）用于舞台生成和歌词情绪 completion；OpenAI 型号同样由配置显式指定。StepFun 模型 ID 只做格式校验，远端是否可用仍由实际 provider 结果决定。费用未知时采用 token-only 请求边界，不阻挡派发、不要求金额预留、核价或汇总。可信用量可供记录输入/输出 token，但用量与费用统计不是功能门槛。真实 key、型号兼容性、实际用量字段和模型质量仍待后续验证。保存密钥只完成本地存储操作，不代表远端鉴权成功。

## 操作

工坊 → AI 生成 →「模型密钥设置（接入准备）」中，展开时查询当前服务及绑定地址，输入后显式保存或删除。查询成功后显示 OpenAI 或 StepFun 名称；目标未确认或查询失败时禁用保存/删除，需手动重新查询。持有 DataDir AI runner 锁的实例在生成开关关闭时也能管理密钥。共享同一 DataDir 但没有拿到 runner 锁的第二实例返回 `ai_locked`（包括可能触发旧格式迁移的查询），界面提示切换到持锁实例，避免跨进程绕过凭据生命周期锁。成功仅表示本地存储操作完成，不能解释成远端已鉴权或云生成就绪。

输入为密码框，只用于本次提交；提交、收起、关闭、切页、隐藏或界面重建时清空。不放入模块状态、重试状态、localStorage/sessionStorage、设置、工程、分享或备份。保存/删除不自动重试；查询不轮询，也不自动重试。界面只展示是否已配置和稳定错误码对应的说明。

## 服务与隔离

官方全权 HTTP 与可信 RPC 共用 `ai::credential`：

| 方法 | 路径 | 输入/结果 |
| --- | --- | --- |
| GET | `/v1/ai/provider-credential` | 返回 `{provider,origin,configured}`，不含密钥或密钥摘要 |
| PUT | `/v1/ai/provider-credential` | 仅 `{api_key:string}`，返回同一安全摘要 |
| DELETE | `/v1/ai/provider-credential` | 幂等删除，返回 `configured:false` |

不接收调用方提供的 owner、provider、origin 或钥匙串 key。服务启动配置固定目标；DataDir 持久 owner、provider 与规范地址共同构成版本化 SHA-256 命名空间。OpenAI 保留原 `https://api.openai.com` 命名空间和旧记录迁移；fake/Ollama 配置继续提供该准备入口。`ai.provider = "stepfun"` 时，只接受 `https://api.stepfun.com/v1` 或 `https://api.stepfun.com/step_plan/v1`（可带一个末尾斜线）；两条 API 路径的密钥互相隔离，也不读取或迁移 OpenAI 密钥。切换服务须为对应目标重新保存自己的密钥，删除只影响该目标。非法 StepFun 地址拒绝读写。

仍复用现有 `secrets::SecretBackend`、发行版钥匙串 service，以及全进程共享的阻塞许可和生命周期锁。Standard/Full、不同安装的 owner 隔离。缺钥匙串明确失败，不回退到明文。歌词情绪 completion 已接入持久任务、派发标记与逐次用量账本；StepFun 与 OpenAI 的费用未知时均按 token-only 记录。

HTTP 请求体最多 8 KiB；key 最多 4096 字节，仅非空可见 ASCII，不猜测密钥前缀，不自动 trim。RPC 在复制 key 前检查类型和长度。重复/未知字段、非法 JSON、后端错误均不反射输入或系统诊断。`SecretEntry` 的 Debug 对凭据和设备内容脱敏。通用 settings 的 HTTP/RPC 同时拒绝并隐藏 `ai_provider_*`、`openai_api_key` 与 `ai_api_key`，沿用原音源凭据过滤。

4096 字节是接口语法上限，不保证每个系统钥匙串都能保存这个长度的版本化记录。Windows 后端对 UTF-16 blob 有额外容量限制；容量拒绝返回统一不可用错误，不回显输入、不改存明文。已存在记录在本次写入被后端长度预校验拒绝时保持原值和代际；其它部分写入失败仍按实际存储结果重新查询，不能一概推断未生效。

钥匙串访问全进程单槽、不排队，五秒调用等待；`spawn_blocking` 内持续持有许可。超时或观察者离开不假装中断系统调用、不提前归还槽；保存或删除仍可能完成，返回的超时提示要求稍后手动查询。系统工作未退出前的新请求返回 `ai_credential_busy`。该边界只约束本模块，不宣称把已有全部音源/远程钥匙串路径改成统一执行器。

受限 grant、MCP 工具、overlay key 与普通未认证 HTTP 不获得此管理权限。查询从不返回密钥或凭据代际。

## 凭据存储代际

每次显式保存生成新的随机 UUID v4 代际，包括重复保存相同密钥；删除后重新保存也使用新代际。版本、作用域、代际与密钥一起编码在原命名空间的同一个 `:cred` 字段，`:device` 不存代际。原系统后端的两个字段写入并非事务：即使辅助字段失败，已经写入的密钥与代际也保持配对，不能用两次独立写入假装原子更新。

此前的非空原始密钥在首次状态查询时原位迁移；迁移仍使用同一单槽、阻塞执行与超时边界。后续查询保留代际，不反复轮换。换行分隔的格式前缀与旧版仅可见 ASCII 的密钥没有歧义。记录读取检查长度、版本、重复/未知字段、作用域、规范 UUID v4 和密钥格式；损坏或跨 owner 搬移的记录返回统一不可用错误，不回显内容、不降级使用。迁移或保存报错后仍可能已写入完整记录，须按既有提示重新查询事实。

首个存储增量只建立存储身份；后续任务绑定与管理失效处理见下一节。云 adapter、实际网络取消和真实费用仍需完成，不把凭据准备解释成已启用云调用。

Full 的底层兼容读会在当前发行版 service 下找不到值时回读旧 `mmusic-studio` service。删除必须先清理旧副本再清理当前副本，清空 `cred` 或辅助 `device` 也遵循此顺序；失败不能假报成功。此前只删当前条目会让下次读取重新迁回旧值，已通过真实 Windows 合成条目复现并修复。Standard 不读取或修改旧 Full service。

## 任务绑定与管理失效

需要凭据的 OpenAI/StepFun provider 在受理时读取对应作用域的受管钥匙串，任务价格快照只冻结非秘密的作用域和代际，不包含密钥或密钥摘要。无凭据的 fake/Ollama 不读取模型密钥。旧的无凭据快照保持兼容；需要凭据的 provider 不接受缺少绑定的旧快照。

受理的快照读租约持有到任务事务与输入交接结束；派发前重新读取同一作用域，严格比较冻结代际，读租约覆盖派发标记事务。两次读取均使用原单槽阻塞执行边界，超时或观察者离开后，实际系统调用仍持有执行许可和生命周期锁。代际缺失/变化使任务取消且不派发，后端不可用则失败且不派发。密钥仅作为不可调试、不可序列化的内存参数交给 provider。钥匙串准备与派发耗时计入原执行期限。

显式保存（含相同值）或删除先获得不排队的生命周期写锁，再事务性取消该 owner 已有的凭据绑定任务并结算；free/local 任务独立工作。事务失败时不执行钥匙串变更。未派发任务释放预留，已标记可能发送的任务按未知费用保守结算，随后可信 usage 仍可按冻结价格校正。钥匙串变更失败也不会恢复已取消任务；用户需重新创建。管理 owner 在拿锁后由服务端持有，HTTP/RPC 等待者离开或超时不撤销已接受的管理操作。

正在运行的 provider 继续由原执行 owner 持有，槽位直到本地调用结束或执行期限终止才释放，取消终态不会变成成功提案。OpenAI/StepFun adapter 的发送前/发送中取消已有回环 fixture。StepFun 在明确选择 provider、配置模型密钥并开启应用内生成后可按 token-only 模式派发；默认仍是 fake，当前不代表已经完成真实应用内请求验收。真实 endpoint 的取消、DNS/origin、usage 字段与实际账单仍待验证。

## 验证与剩余

实现后检查涵盖隔离内存后端的 owner 作用域、脱敏错误、输入边界、超时/观察者取消后实际阻塞工作仍占槽，以及 RPC 设置过滤。存储代际另检查重复保存/删除后重建、最大转义长度旧密钥的稳定迁移、损坏/跨 owner 记录拒绝及后端部分成功后密钥与代际配对。`scripts/check-ai-credential-browser.js` 用隔离服务、显式内存凭据后端和真实 Chrome 检查管理认证、保存/删除、输入清理、无生成请求、浏览器/服务文件未保存合成密钥、错误不回显和窄屏。

上述内存后端检查不接触真实密钥或系统钥匙串，不能证明 OS 凭据服务持久性、跨 OS 兼容或 OpenAI 认证；本机 Windows 系统后端另有下节的合成条目验收。StepFun token-only 路径不等待价格核实，剩余验收集中在真实应用内调用、usage 字段、云端 DNS/请求边界、隐私/条款和模型质量；OpenAI 仍待具体模型选择及其后续验证，见[路线进度](./roadmap-progress.md)与[发布矩阵](./release-validation.md)。

入口初次增量（2026-10-18）：Standard / Full 服务端库 402 / 559 项通过（另 3 / 5 忽略），两版全 target Clippy 与 Rust 1.88.0 编译通过；前端默认 56 步、隔离 Standard 二进制的本页浏览器旅程、本地 Ollama fixture 回归及原 AI 任务面板 13 项通过。320px 与 390px 实际截图已检查。二进制构建在独立 `target/mcp-sdk-check`，未覆盖运行中的开发播放器；未提交或发布。

存储代际增量最终验证（2026-10-18）：按用户要求改回 D 盘，Standard / Full 完整库 410 / 567 项通过（另 4 / 6 忽略），各含凭据模块 9 项；两版全 target Clippy、Rust 1.88.0 工作区全 target 编译通过。重跑时发现 RPC 过滤测试的 Windows 临时目录即时删除偶发文件占用，现改为运行相同生产迁移的单连接内存 SQLite，不把文件系统清理作为该 SQL 过滤测试的前提。最新 Standard 二进制通过真实回环 HTTP 的鉴权、三字段摘要、重复保存、幂等删除、删除后重建和真实磁盘 DataDir 无合成密钥检查。HTTP 使用内存凭据与 null 音频，不触及系统钥匙串或模型；本增量没有重跑浏览器视觉验收。

最终构建与原始检查记录位于本机 `target/mcp-sdk-check`；`credential-generation-http.json` 记录二进制和凭据源码 SHA-256，库回归、Clippy、MSRV 各有对应日志。这些是本机开发检查，不能代替冻结候选、真实系统钥匙串或云端任务生命周期验收。

任务绑定与失效增量最终验证（2026-10-18）：D 盘独立 target 的 Standard / Full 完整库 417 / 574 项通过（另 4 / 6 忽略），两版全 target Clippy、Rust 1.88.0 工作区全 target 编译、fmt、285 项 ADR 契约和前端默认 56 步通过。新增检查覆盖凭据租约/旧身份拒绝、无凭据不受理、排队任务失效而 free 任务独立、运行中轮换的槽位与迟到费用、DB 失败不写钥匙串、观察者离开不撤销管理操作，以及 runner 所有权与生成开关分离。

Rust 1.88.0 下的 Windows Standard 与 Full 二进制均运行 `scripts/check-ai-credential-owner.js`：两个真实进程共享同一隔离 DataDir。生成同意开启时，未持 runner 锁的第二进程提交任务返回 `ai_locked`；持锁进程确认任务列表、预算预留和已计费用均未变化。第二进程的凭据 GET/PUT/DELETE 同样返回 `ai_locked`，持锁进程仍可管理密钥；探针同时检查鉴权、三字段摘要、重复保存、幂等删除与磁盘无合成密钥。两份报告 `target/r4-runner-admission/credential-owner.json` 与 `target/r4-runner-admission/credential-owner-full.json` 记录发行版、二进制、源码和检查脚本 SHA-256；此前的凭据生命周期报告保留在 `target/mcp-sdk-check/credential-lifecycle-http.json`。本机使用内存凭据、null 音频和零网络 provider fixture，不接触真实 OS 钥匙串或 OpenAI；不代表其它 OS、发布候选或实际云端验收。

## Windows 系统钥匙串验收

`scripts/check-ai-credential-keyring.js --windows-keyring` 是显式运行的 Windows 本机验收，默认前端/CI 检查不会访问真实系统凭据。它从新建的隔离 DataDir 取得 owner，只访问由此导出的确切 AI 条目，不枚举凭据；使用合成值、null 音频、fake provider 和关闭的生成开关，不调用 OpenAI。`scripts/windows-ai-credential-probe.ps1` 用 Win32 Credential API 独立核对存储值，输入走 stdin，输出只含匹配布尔值、是否存在和非秘密代际。

先准备两版独立二进制，例如：

```powershell
cargo build --locked -p hertz-studio --bin hertz-studio --target-dir target/keyring-standard
cargo build --locked -p hertz-studio --bin hertz-studio --features full --target-dir target/keyring-full
$env:HERTZ_STANDARD_BIN = (Resolve-Path 'target/keyring-standard/debug/hertz-studio.exe').Path
$env:HERTZ_FULL_BIN = (Resolve-Path 'target/keyring-full/debug/hertz-studio.exe').Path
node scripts/check-ai-credential-keyring.js --windows-keyring
```

也可指定已经构建的独立产物。脚本核对实际 health/discovery 发行版，不把同名二进制当作两版；PowerShell 可通过 `POWERSHELL` 指定。测试目录位于工作区 `target/keyring-validation`，报告默认为 `output/ai-credential-keyring.json`，可用 `HERTZ_KEYRING_REPORT` 改路径。成功和失败均尝试清理确切测试条目；清理未确认时测试失败并保留隔离目录，不写通过报告。报告记录两版二进制、相关 Rust 源码和两个检查脚本的 SHA-256，不保存测试密钥、系统账号或完整原始凭据。

2026-10-18 本机最终通过上述真实 Windows 检查：原生记录与提交合成值匹配、跨进程重启持久/代际稳定、相同值保存轮换代际、同 owner 的两版隔离/不同 owner 隔离、幂等删除且重启不复活、旧 service 与原始值迁移、当前/旧辅助字段清理、Standard 不触碰旧 Full 条目，以及 Windows blob 容量拒绝不覆盖原记录/不回显输入。测试数据目录与确切的合成凭据均已清理，报告 `cleanupComplete=true`；报告的两版二进制和五份源码/脚本哈希已与当前文件核对一致。

修复后 Standard / Full 完整 Hertz 库 420 / 577 项通过（另 4 / 6 忽略），两版全 target Clippy、Rust 1.88.0 工作区全 target 编译、前端默认 56 步、fmt 与 285 项 ADR 契约通过，日志位于 D 盘 `target/keyring-validation`。本增量没有重跑浏览器视觉验收；系统锁定/拒绝访问、系统重启/跨登录会话、Linux/macOS 和真实 OpenAI 认证/账单仍未验收。
