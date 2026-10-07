# Mineradio 实施复核与补齐

- Goal：以当前工作区实际代码为准复核评估文档，修正已做错或漏接的行为，完成适用的剩余功能；条件项维持原文条件，不把代码存在当成验收通过。
- Architecture：业务状态留在 Rust 原 owner；HTTP/RPC 共用业务入口；播放 actor 单写入；前端只呈现快照和发送意图。
- Tech Stack：Rust、原生 JS/CSS、Node 行为检查、Playwright。
- Baseline / Authority Refs：用户本轮继续完成请求；`docs/research/mineradio-full-assessment.md`（§10 优先于早期结论）；`docs/aegis/BASELINE-GOVERNANCE.md`、`adr/0001`–`0006`；已读关联聊天；旧十四批记录只作为线索。沿用已记录的先实现后回归方式。
- Compatibility Boundary：保留开始时工作区全部未提交修改；不复制旧 worktree 覆盖当前代码；不引入参考项目第三方资源；未知权益不能推断授权，也不能凭空判成非会员；gapless 与 crossfade 独立验收。
- Verification：先跑 `node scripts/check-frontend.js --extra` 建立基线；逐域运行 Rust 行为测试和现有检查，新增竞态、失败、迟到与边界用例；需要界面验证的改动使用真实浏览器；最终 `cargo test --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`、前端聚合和 CI 同范围的 `cargo fmt -p hertz-studio -p vmusic-core -p vmusic-audio -p vmusic-store -p vmusic-library -p vmusic-lyrics -p vmusic-beats -p dbx-plugin-hertz -- --check`（不格式化 vendored SDK）。
- ArchitectureReviewRequired：yes。

## 执行切片

1. **事实复核**：音频 B、在线 A/F2/F3、任务与 UI C4/F5/G 分域只读审计；从代码与行为证据重建状态表。旧记录中 C4/G7 已发现过期。
2. **修复缺陷**：以可复现问题为先，在原 owner 修复；任何新增接口同时检查 HTTP/RPC。每个切片保留复现、修改范围和测试输出。
3. **补齐适用功能**：队列续载、播放降档和音频衔接按现有契约扩展；节拍任务与长列表依据当前实现缺口补齐。媒体持久化、automix 等原文条件项记录前置，不擅自扩大产品范围。
4. **独立评审与验证**：复核变更的所有权、存储兼容、双门面、旧路径退役；实测不能覆盖的真实平台权益和音频硬件必须如实记录。
5. **文档交付**：在原评估文档追加“当前实现复核”，逐项列已完成、需修复、条件项及实际证据；另存详细缺陷与验收记录。

最终核对补充：旧记录的 G1“已满足”与 C5 实际代码不符。G1/G3 在现有曲库首屏加入明确匹配动作的继续入口，沿用播放器/历史快照，不另建队列；C5 在工坊原保存页增加版本化分享码，CreativeStage 仍负责字段语义，保留 JSON 兼容。全量 payload 避免 delta 依赖可变默认值，压缩按宿主能力择优，解码和异步提交均有边界。

## 修复与退役纪律

不并存第二份队列、第二张权益真值表或第二套节拍任务状态。替换现有误导文案/状态路径时删除旧路径；保留兼容字段需注明唯一 owner 与读取规则。旧证据表保留历史，但最新复核表具有当前状态解释权。
