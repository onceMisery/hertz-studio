# 按优先级补齐播放器功能

- Goal：完成用户接受的审计中第 1–13 项缺口；用户于实施中明确“创意功能和宿主扩展可不完成”，第14项移出验收范围。上下文结束不缩减其余目标。
- Architecture：沿用 Rust 单进程、音频 actor、SQLite 仓储和零构建 Web UI。数据选择与持久化归服务端，前端负责交互；舞台消费既有播放契约。
- Tech Stack：Rust / axum / sqlx / symphonia / cpal；原生 JavaScript / CSS。
- Baseline/Authority Refs：用户“按你推荐的优先级修复项目，注意不走tdd”；README 当前架构；本计划下方的代码基线。
- Compatibility Boundary：保留已有未提交舞台修改、既有曲库身份、播放模式、平台授权边界；不删除音频原文件，不替用户向平台发送写操作。不改变为云服务。
- Verification：先实现再补针对性回归；每项实际流程验证后再标完成。Rust `cargo test --workspace` / clippy；前端 `node scripts/check-*.js`；独立临时数据目录的 null 后端 API 冒烟；涉及 UI 时浏览器验收；真实平台/声卡/宿主的验收单独记录，不能由模拟检查代替。
- ArchitectureReviewRequired：yes。跨模块公共查询、曲库身份、凭据、音频和分发变更逐项核对所有者及消费者。

## 执行顺序与验收

| # | 优先级 | 工作与文件范围 | 必须证明的结果 |
|---|---|---|---|
| 1 | P1 | `vmusic-store/src/lib.rs` 排序/ID 查询；`vmusicd/src/routes.rs` 查询 API；`web/app.js` 曲库；`web/favorites.js` 收藏 | 超过 200 条能完整访问；排序先于分页；按当前筛选与排序播放全部；失败重试不跳页；过期查询不覆盖新查询 |
| 2 | P1 | `vmusic-store` roots 仓储；`vmusicd/src/scan.rs` 扫描所有者；routes / app / index | 根目录增删启停、自动文件变化扫描、未变文件跳过、取消、失败明细；不可访问目录与解析失败不误删记录；重启恢复 |
| 3 | P1 | playlists 仓储/元数据快照、routes、favorites / online / app | 本地与各在线来源混合存入自建歌单、重启后显示与顺序不丢、整单播放、收藏全部播放；在线歌单收藏正确打开整盘 |
| 4 | P1 | library / lyrics / store、歌词路由与 Web 控件 | 内嵌歌词读取、手动导入/关联、每曲偏移保存；明确来源优先级；不破坏 sidecar 与在线逐字歌词 |
| 5 | P2 | 曲库查询、元数据覆盖层、Web 曲库管理 | 专辑/歌手浏览、标签编辑、替换封面、批量操作、失效文件整理；用户编辑重扫保留 |
| 6 | P2 | 数据迁移模块、routes、设置 UI | 歌单/收藏/设置可备份恢复；M3U 导入导出；格式校验、重复处理、恢复事务；凭据不混入普通备份 |
| 7 | P2 | online/cred、系统凭据适配 | 系统凭据保存读取登出；旧 SQLite 凭据成功迁移后清理；系统钥匙串失败明确报告，不静默回退明文 |
| 8 | P2 | online/cache、routes、设置 UI | 容量/占用展示、清理、指定内容保留、离线可用状态；保护当前播放及保留文件 |
| 9 | P2 | 各平台 adapter / capabilities 与登录 UI | QQ 红心、酷狗歌单/推荐/写操作逐能力核实；扫码完整确认链路；未知端点不虚构，需真人凭据的验收保留待验证 |
| 10 | P2 | core/audio、audio backend、DSP 设置 | EQ、响度归一化、限幅；无缝与可调交叉淡化；正确保留时钟/频谱/设备语义；真实声卡测听单列 |
| 11 | P2 | remote 来源模块、服务器管理 UI | WebDAV 管理/浏览/导入与 HTTP 直链播放；凭据沿系统钥匙串；断网错误可恢复 |
| 12 | P2 | release workflows / 启动与更新工具 | 多平台打包、安装与启动、版本检查/更新流程；发行产物校验；不擅自推送/发布 |
| 13 | P3 | history 仓储/API、Web 历史视图 | 分页、搜索、来源筛选与回放，旧记录可访问 |
| 14 | 移出范围 | 创意功能与宿主扩展 | 用户明确不要求完成；不实施旋律轨迹、提示词预置、录制回放、DBX 插件 |

## 当前代码基线

- `vmusic-store/src/lib.rs::list_tracks` 固定 title 排序后分页；`app.js::sortTracks` 二次重排已加载集合；`playFromList` 只选已加载 ID。退休前端排序所有者，统一服务端查询。
- `favorites.js::load` 固定 limit=200/offset=0，收藏全部播放仅本地。保留分页而非启动时加载全部元数据，整单播放单独取全量身份。
- `scan.rs` 单次手动全扫描；`scan_roots` 表已有但无业务使用。复用此表，不再建立第二份目录配置。
- 在线身份已是 `online:<source>:<id>`，音频状态层已支持这些身份；混合歌单复用身份协议。
- 既有测试：209 个 Rust 测试及 9 个前端契约脚本通过（审计轮结果，修改后必须重新验证）。

## 持续工作规则

每项依次做：读当前状态 → 实现 → 针对性回归 → 审查契约及代码 → 更新 checkpoint/evidence。用户明确要求不走 TDD，覆盖技能中的 test-first 默认。
第1–13项保持在 checkpoint 中，第14项记录为用户移出范围。外部平台或真实设备受阻时记录精确缺失证据，继续不依赖它的授权工作；不把整个项目标成完成。
