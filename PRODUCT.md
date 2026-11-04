# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主要用户是**本地曲库重度听友**：自己整理本地音乐与歌词，把 Hertz 当主力听歌入口，同时想要
桌面歌词、壁纸、3D 舞台这类呈现体验——桌面组件（歌词浮层、壁纸引擎、桌宠）正是为这类人做的。
DBX 插件宿主与 MCP 接入面向的集成场景是次要入口，不主导产品决策。

## Product Purpose

Hertz Studio 是一个本地优先（local-first）的音乐服务与播放器：单个 Rust 进程负责解码、播放、
曲库与歌词，界面是零构建的原生 JS/CSS。同一份业务逻辑与同一份前端跑两种形态——独立二进制
（自带 HTTP/WebSocket，托管界面）与 DBX 插件（stdio JSON-RPC sidecar）。

成功的样子：本地曲库断网完整可用；歌词舞台与桌面组件带来可感知的体验升级；任何能力边界
（格式、音源、费用、验收状态）如实上报，不伪装成功。

## Positioning

邻居产品抄不走的组合事实：

- **本地优先 + 断网可用**，在线曲库是显式启用的附加，不上传曲库、收听记录或个人数据；
- **单 Rust 进程**承载播放/曲库/歌词/桌面组件，逻辑库一份、传输壳两个；
- **零构建原生 JS/CSS 前端**，`cargo run` 之后直接用，发布压缩不把构建步骤带回开发流；
- **能力失败如实上报**：不支持的音源直接答「不支持」，聚合失败进失败列表，费用未知不写 `$0`；
- 红线明确且长期：不碰 DRM、不绕付费墙、不伪造设备指纹、不做账号池/凭据共享。

## Operating Context

- Windows 优先：桌面歌词（L1）、壁纸引擎、桌宠皮肤层已按 Windows 落地；macOS/Linux 有数据
  目录定义但桌面组件未验收
- 双发行版同分支同步发布：**Standard**（本地 + WebDAV + 开放曲库，DBX 商店候选）与
  **Full**（额外六个平台音源）；feature 决定协议模块与界面裁剪
- 数据目录 `%LOCALAPPDATA%\hertz-studio(-standard)`：SQLite + config.toml + 系统钥匙串 +
  服务发现文件；设置不依赖 localStorage
- 安全姿态：默认只监听回环地址，入口链接带两分钟一次性票据；MCP 走独立 stdio 适配进程只读接入
- 开发流：`cargo run` 即用（Rust 1.88+），Node 22 只用于发布压缩与 3D 场景打包；
  修改场景源码需 `node tools/build-stages.mjs` 重编内嵌资源
- **文档即事实源**：`docs/` 是产品文档单一真值，状态以 `docs/roadmap-progress.md` 为准
  （勿信记忆里的旧状态）；ADR 在 `docs/adr/`；发布门槛在 `docs/release-validation.md`

## Capabilities and Constraints

已确认能力（细节以 README 与 `docs/` 为准，不在此复制）：本地播放与曲库、enhanced LRC 逐字歌词、
歌单、EQ/ReplayGain、播放历史、WebDAV、在线曲库（Full）、播客、RSS 图文阅读、主题/皮肤/壁纸、
五歌词视觉 + 七沉浸声场、三维空间十场景、创意舞台（一句成景/工程/模板/分享码/视频导出）、
桌面歌词 L1、壁纸引擎、局域网一起听 P0、桌宠皮肤层、MCP 只读接入、AI 任务底座（fake/ollama/stepfun）。

明确不做（写在路线图里，勿当待办）：云同步/云端多用户账号/远程 MCP、在线热加载 SVG/GLSL/JS、
新增皮肤与新增平台、通用 agent、动态代码生成、向量库、完整 DSP 图、用模型直接改当前舞台。

状态口径：README 路线表 + `docs/roadmap-progress.md` 是唯一状态事实源；真实声卡、真账号、
原生宿主、弱机、人工视觉等验收多处明确标注待验——引用状态前先查，不得凭印象宣称「已完成」。

已确认的产品方向（2026-11-03 用户确认）：**未来会引入独立桌面端与跨平台**。当前所有宿主
（浏览器 / WebView2 桌面壳 / DBX workbench）共用同一套 web UI；平台值维持 `web`，
直到设计语言真正按操作系统分化再重估 `adaptive`。

语言：界面与文档中文优先。

## Brand Commitments

- 名字：**Hertz Studio**（crate 前缀 `vmusic-*` / `hertz-*` 为历史命名，保留不改）
- 声音：如实、克制、无营销夸大；无感叹号、短文案不用句尾句号、无未验证声明（与 DESIGN.md 一致）
- `DESIGN.md` 已存在（设置中心与壁纸/歌词页的设计真值，含双表面体系），本文件不重复其内容

## Evidence on Hand

- `README.md`：能力清单、架构图、红线与路线状态
- `docs/`：40+ 篇专项文档（桌面歌词/壁纸/局域网一起听/音源边界/MCP/发布验收等）
- `docs/roadmap-progress.md`：最新增量（2026-10-23）；`docs/plans/` 近期计划
- `docs/images/`：真实界面截图；`docs/adr/`：现行契约
- **不存在**：用户访谈、testimonials、案例研究——未来工作不得编造

## Product Principles

1. **如实上报**：能力失败、格式边界、费用未知都直说，不伪装成空结果或零费用
2. **本地优先**：断网完整可用；在线是显式附加，个人数据不出机器
3. **一份逻辑、多形态薄壳**：业务只写一份，传输与宿主差异收敛在最小适配层
4. **有界与预算**：每条能力带明确资源预算与降级路径（帧门、LRU、容量上限、帧级降级）
5. **零构建的开发体验**：前端 `cargo run` 直接可用；复杂度只进发布管线，不进开发流

## Accessibility & Inclusion

- 主题文字色由底色按 WCAG 对比度反推，不是手写；逐套主题验 7:1 / 4.5:1
- 自动压暗后「每套主题 × 每张壁纸 × 每个强度」组合仍须达到 AA（既有验收契约）
- 动效遵守 `prefers-reduced-motion: reduce` 全静止（DESIGN.md 契约）
