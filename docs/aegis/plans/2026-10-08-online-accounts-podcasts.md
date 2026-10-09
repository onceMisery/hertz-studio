# 在线账号修复与中文播客实施

Goal: 汽水二维码使用正确手机授权入口，咪咕可导入 Cookie 并浏览歌单，中文播客从节目搜索/RSS 导入到单集播放可用。

Architecture: 新增播客领域服务，有限长度音频通过原 Provider/播放器；媒体类型由 Provider 注册定义，HTTP/RPC 共用业务函数。Tech stack: Rust/SQLite/reqwest/XML parser，原生 JS/CSS。

Baseline/Authority: 用户本轮需求与中文点播选择；`../specs/2026-10-08-online-accounts-podcasts-brief.md`、README、extension-guide、ADR-0001/0007/0009。

Compatibility Boundary: 音乐源稳定 ID、队列/播放意图、凭据保险库、HTTP/RPC 信封保持。旧汽水 PNG 退役；咪咕无实现的扫码入口不出现；播客不创建第二播放链路。工作在隔离分支 codex/online-podcasts，保留主目录并行清风改动。

## 任务与文件

1. 汽水：在 `online/qishui.rs` 的 QR 解析增加失败用例，证明旧图片包含下线入口；改为规范 URL 生成并返回 qr_text，保留原票和创建期 cookie。检查参数编码和上游坏响应，实际重新取码核对。
2. 播客后端：`podcasts.rs`、`migrations/0013_podcasts.sql`、crate 依赖和 lib 模块。先测试 RSS 解析/预算/持久映射，再实现目录搜索、订阅、分页和 stream/detail。独立新模块可交实现代理，控制器负责接线。节目 API 与字段以 brief 为准。
3. 咪咕：`online/migu.rs` 和 `provider.rs` 接账号、凭据规则、公开歌单详情；`online-login.js` 由能力决定扫码或 Cookie 表单。先回归 Cookie-only 源不会 POST qr/start，账号 290001/缺字段不当已登录，歌单分页正确。取流仅开放实测支持部分，不能用登录可用推断音频可播。
4. 接线：`online/provider.rs`、`online/mod.rs`、`routes.rs`、`rpc/mod.rs` 与 `rpc/podcasts.rs`。Provider 媒体类型区分音乐与播客；统一 API 数据/错误语义，音乐聚合排除播客。扩展在线 Provider 测试与 sidecar API 覆盖。
5. 栏目：`plugin/ui/podcasts.js`、`podcasts.css`、`index.html`、`assets.rs`、`app.js`。页面提供提交搜索、我的订阅/RSS 导入、单集分页/刷新/播放。使用 `Online.playAll`，防迟到响应，纯文本描述，主题 token，自适应列表。检查各皮肤入口可见与切回后状态。
6. 验证/审查：先每切片行为用例 RED/GREEN，再前端聚合、Rust online/podcast 测试、构建、HTTP/DBX 同构和真实浏览器；独立审查规范覆盖再审代码质量，按证据修复。补研究、兼容/预算 ADR 与交付记录，不自动发布或动用户账号。

## Verification

`cargo test --locked -p hertz-studio --lib online::`；`cargo test --locked -p hertz-studio --lib podcasts::`；`node scripts/check-online.js`；`node scripts/check-online-login-browser.js`；新增 `node scripts/check-podcasts-browser.js`；`node scripts/check-assets.js`；`node scripts/check-frontend.js --extra`；构建独立与 sidecar 后用隔离数据目录验收。

## 风险和复核

汽水手机安全验证和咪咕有效账号需要本人操作，不能用接口 200 代替。直播/私有付费播客不在本轮。大 RSS 只放宽专用入口；节目音频长度、码率以实际响应为准。先检查 Provider、网络、SQLite、UI 四处归属，再完成独立审查。Aegis workspace 的两份历史未索引文件已知，与本轮代码验证分别报告。
