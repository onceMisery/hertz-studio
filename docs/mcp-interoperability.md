# MCP SDK 互操作检查

Hertz 的外部 MCP 入口是独立程序的 `--mcp-stdio --data-dir <显式目录> --grant <grantId>` 模式。业务仍由已运行的独立服务执行；适配进程只读发现与专用授权凭据，不启动播放器、音频、数据库或 HTTP 服务。DBX 外部 MCP 桥接不在首发范围。

受限授权凭据是 `DataDir/ai/grants/<grantId>.key` 的 256 位随机 bearer，数据库只存 SHA-256 摘要，应答与日志不回显秘密。该文件是明文而不是系统钥匙串条目（只有 provider API key 走钥匙串）：Unix 上目录收为 0700、文件 0600，Windows 继承 DataDir ACL，具体 ACL 行为仍按[技术实施方案 §13：尚待实测、但不阻止当前文档落地的事项](./technical-roadmap.md#13-尚待实测但不阻止当前文档落地的事项)在 R2-G/R4-J 实测固定。轮换先写临时文件、再提交摘要、最后替换旧文件；失败时保留旧摘要和旧文件。

## 协议与工具契约

当前适配器仅支持 MCP `2025-11-25`。`ServerHandler::supported_protocol_versions` 与初始化回退版本都显式固定，避免把 SDK 默认支持的更新生命周期自动当作 Hertz 已验收的协议。客户端若请求其它版本，初始化响应会返回此基线，由客户端决定能否继续。

工具目录依据连接时的授权与开关生成，会话内不静默扩展；重新连接才能获得新增的可见工具。每次调用仍由原服务重新认证授权，因此撤权、关闭舞台工具开关会阻止已连接客户端继续调用相应能力。

六种变更工具在 `inputSchema.properties` 中公开可选字符串 `clientOperationId`。去除首尾空白后必须非空且不超过 128 UTF-8 字节；schema 的字符上限只是第一层限制，服务端仍核验实际字节。同一动作重试使用同一键，新动作使用新键；不传则适配器每次生成新键。数字、null 等错误类型会明确失败，不能静默生成新键。该字段只由适配层消费，不传入业务 DTO；只读工具不接受它。

错误保留两个层次：未知工具返回协议 `invalid params`；已登记工具的未连接、缺 scope、撤权、非法输入等返回 `isError: true` 与结构化稳定错误码。成功结果的文本 JSON 与 `structuredContent` 表达同一事实，不把 HTTP 200 本身当作已执行。

## 取消与 I/O 边界

工具转发同时监听 SDK 请求上下文、传输附加的取消信号和适配连接关闭。`notifications/cancelled` 由 SDK 解码，再映射到原请求的非 wire extension；本适配层消费该通知，不让 SDK 在响应写出前删除 responder。这样取消可立即结束本地 HTTP 等待，但该请求的额度仍跟随取消错误响应到完整 flush，避免取消后无法回收或过早回收响应占用。SDK 客户端期限也通过该通知生效；stdin EOF 停止全部本地等待。取消单个请求后会话仍可继续使用，客户端可以忽略取消响应。取消等待不回滚已发播控，不代替业务任务取消，也不承诺远端 handler 已退出。短写仍由独立服务的原执行 owner 与幂等记录负责。

保留 SDK 的 JSON-RPC 解析和帧编码。输入每行 LF 前最多 256 KiB（包括可能的 CR），超过上限即结束会话，不等待换行；发现文件读取最多 16 KiB；context、成功和错误 HTTP 回复在读取中限制为 1 MiB，声明超限也立即拒绝。HTTP 原八秒总期限继续有效。

每会话最多八个未完成请求，从 SDK 解码后、创建 handler 之前计入，覆盖 HTTP 等待、handler、排队响应和 stdout 写入，直到完整 flush 才归还。第九个请求或与未完成请求重复的 ID 直接关闭适配会话；不再为每个溢出请求创建 busy 响应任务。已有请求的本地 HTTP 等待随关闭停止，原服务副作用仍按其 owner 执行；调用方不得自动换键重放变更。八个是当前实现边界，不是已由正式客户端和弱机测量冻结的性能额度。

取消通知即使在八个额度占满时仍会处理；未知取消 ID 不扩容，不声明的 roots/progress/custom 通知与重复 initialized 不传入 SDK 创建任务，首次 initialized 仍走 SDK 握手。通知处理之间显式让出执行机会，不因连续通知让响应与关闭长期得不到调度。响应按精确 JSON 编码字节（含转义、文本和 structuredContent 双表示）先计数，LF 前最多 256 KiB，不先分配完整序列化帧。超限改发同 ID 的完整协议错误 `mcp_response_too_large`，说明动作可能已执行，不能假定失败而重发；若连错误信封和 ID 也超限则结束会话。SDK 内联无 ID 的解析错误仍由 SDK 编码，正文固定且不含输入。

stdout 单帧写入/flush 及等待其它帧写入最多八秒；SDK 在解析错误时直接写出的协议错误也受相同期限限制。短暂背压可继续发送完整帧；一旦写入超时，结束当前会话，不能在半帧后继续写下一帧。SDK 关闭写端最多再等一秒；适配进程的 runtime 关闭也最多等一秒，避免 Tokio 标准输入/输出的阻塞 OS 调用使进程退出永久等待。该策略只用于独立适配进程；退出后的 stdio 线程由进程结束回收，不声称 async future 的取消能中断 OS 调用。客户端需要重新连接，变更动作不能自动换键重试。

这些边界提供未完成请求和 wire 载荷的结构限制，不是整个进程 RSS 的固定上限。短时受控并发与取消检查不代替长时间洪泛、正式目标应用、弱机或其它 OS 的测量；原服务的业务执行额度不因适配器断开而提前释放。数值 owner 与禁止提前归还规则记入[后台预算](./adr/0003-background-work-budget.md)。

## 运行检查

```powershell
# 每次使用该次 cargo 构建的同发行版程序，不依赖手工指定的旧二进制。
# 隔离 target-dir 避免覆盖正在运行的开发播放器。
cargo test --locked -p hertz-studio --test mcp_sdk --target-dir target/mcp-sdk-check -- --test-threads=1
cargo test --locked -p hertz-studio --test mcp_sdk --target-dir target/mcp-sdk-check --features full -- --test-threads=1

# 适配层与协议协商单测
cargo test --locked -p hertz-studio --lib ai::mcp -- --test-threads=1
```

`mcp_sdk` 使用官方 Rust SDK `rmcp` 的客户端，通过真实子进程管道连接标准 stdio transport。客户端与进程管理 feature 仅为 dev dependency，不给产品增加 Node 或客户端运行时。依赖继续由根 Cargo.lock 固定。既有工作区 `cargo test` 与全 target 检查会自动纳入该集成检查；本地和 CI 均强制该子进程使用 null 音频与内存凭据后端，不访问声卡或系统钥匙串。

检查覆盖：

- 明确基线与 SDK 默认版本请求的初始化、服务身份及仅 tools 的能力声明；无发现目录时握手、空目录、`not_connected` 和无 bootstrap 落盘副作用。
- 舞台默认关闭、重新连接前目录不扩展、十工具目录与只读提示、变更工具幂等字段公开。
- 三首真实本地 WAV 与持久元数据；同键 next 结果和代际相同、队列只移动一格；错误类型、空白、过长和多字节超限键均无播放副作用。
- 已装载曲目的最小快照不泄漏标题、歌手和路径；曲库结果允许授权元数据但不暴露路径。
- 分页场景契约、仅 intent 校验、旧 hash 拒绝、关闭开关后旧会话调用失败；未知工具的协议错误。
- pause-only 的唯一工具及越权拒绝；撤权后连已缓存幂等结果也不能读取。
- SDK 关闭传输后适配器正常退出，独立服务继续运行；失败或超时时也清理并回收子进程，再删除隔离目录。
- 官方 SDK、实际适配子进程和受控慢 HTTP 门面：显式取消、SDK 期限和 stdin EOF 后观察到转发 socket 关闭，取消单个请求后目录仍可查询。该 fixture 不执行真实播控，不证明远端回滚。
- 分片输入与同时写响应、微小输出缓冲恢复后的完整帧、无换行超限、分块成功/错误回复及仅超限长度头；真实进程持续不读 stdout 的退出检查。
- SDK 解码后的在途上限、慢输出期间不归还额度、重复 ID、通知洪泛不创建 SDK 消息任务、按实际转义计算的出站边界；实际子进程的第九个/重复 ID 未转发且已有 HTTP socket 关闭。
- 同一 SDK/实际进程会话的二十四轮取消及随后按八并发发起的 1024 次目录请求，无重连清空额度；真实 HTTP 大成功/错误正文经 MCP 双表示超限时收到完整协议错误，会话仍可继续查询。

## 证据边界

2026-10-18 当前未提交 Windows 开发工作区：Standard / Full 各七项 `mcp_sdk` 集成通过；MCP 模块 21 项通过，两版 Hertz 库分别 406 / 563 项通过，另有 3 / 5 项按既有条件忽略。两版服务端全 target Clippy、Rust 1.88.0 工作区全 target 编译、fmt 与 ADR 契约检查通过。最终集成执行使用 `C:/Users/miracle/.cache/hertz-roadmap-mcp-check` 独立 target，设置 `CARGO_INCREMENTAL=0`、`CARGO_PROFILE_DEV_DEBUG=0` 与 `CARGO_PROFILE_TEST_DEBUG=0`，不覆盖原播放器；测试不调用声卡、系统钥匙串或真实模型。这是开发工作区证据，不能沿用为冻结发布候选结果。

这项检查提供真实进程与官方 SDK 的互操作证据，不能替代 Claude、Codex 等目标应用中的正式连接验收。它不验证真实声音、原生 DBX UI、更长持续压力/整个进程内存/完整取消与超时矩阵、跨平台发行候选或没有 Node 的用户机器。慢 HTTP 是受控回环 fixture，慢 stdout 由客户端主动停止读取；不能扩大为实际目标客户端验收。目标客户端、OS、发行版与候选包仍须分别记录，见[发布验收矩阵](./release-validation.md)与[路线图进度](./roadmap-progress.md)。
