# 在线账号修复与中文播客 - Checkpoint

- Task ID: 2026-10-08-online-accounts-podcasts
- Current todo: 汽水；播客后端；咪咕；栏目和接线；验证审查
- Active slice: 实现
- Blocked on: none
- Next step: 播客后端代理，控制器实现汽水及UI接线

## Checkpoint Update

- Current todo: 咪咕协议实现；音乐接力媒体类型；真实服务端到端；独立审查和集成
- Active slice: 兼容性验证与咪咕实现准备
- Completed todos:
- 汽水二维码移动入口与回归；Cookie-only界面和账号验证；播客服务、栏目、Provider、安全下载与HTTP/RPC
- Evidence refs:
- scripts/check-podcasts-browser.js
- crates/hertz-studio/src/routes.rs::podcast_http_and_rpc_share_subscription_paging_and_playback_identity
- Blocked on: none
- Next step: 完成后端质量审查后委派咪咕实现，控制器验共享链路

## Checkpoint Update

- Current todo: 封面公网策略修复；episode_limit接线；完整Rust与真实服务验证；最终集成
- Active slice: 审查修复与真实端到端准备
- Completed todos:
- 咪咕公开协议与Cookie入口；播客服务与页面；汽水QR手机入口；订阅并发回归
- Evidence refs:
- output/migu-live-tests.log
- output/podcasts-subscription-race-green.log
- output/podcasts-capacity-green.log
- Blocked on: none
- Next step: backend完成public_net修复后串行Cargo全套与构建；启动隔离CPAL静音服务

## Checkpoint Update

- Current todo: 实现、集成和自动验证已完成；本人手机确认与有效咪咕会话列为未覆盖
- Active slice: 交付记录与测试环境收尾
- Completed todos:
- 汽水二维码入口、参数和票据归属回归完成；真实轮询 waiting
- 咪咕 Cookie 账号验证、歌单和公开播放完成；无效账号与权限错误回归完成
- 中文播客目录、RSS、订阅、稳定单集、分页与共用播放器完成
- 独立审查问题全部修复并有 RED/GREEN；已三方合入原工作区
- 原目录 Rust 424、前端 48、DBX 280、真实浏览器、MP3/M4A 解码及重启重播通过
- Evidence refs:
- docs/aegis/work/2026-10-08-online-accounts-podcasts/90-evidence.md
- output/podcasts-integrated-rust-tests.log
- output/podcasts-integrated-frontend-final.log
- output/podcasts-integrated-sidecar.log
- output/online-podcasts-integrated-browser.log
- output/online-podcasts-restart.log
- Blocked on: none
- Next step: 交付新构建及未覆盖事项；本人使用手机确认汽水并以有效会话验证咪咕。现有 7634 实例保持。

## DriftCheckDraft

- Scope status: 符合已确认中文点播范围；功能与自动验证完成，外部账号限制明确；未发布。
- Compatibility status: Provider ID、凭据、队列及HTTP/RPC信封保持；新增podcast媒体种类、持久身份与统一public_net边界。三方合并保留首页、清风和网易并行改动。
- Retirement status: 旧汽水PNG入口、咪咕下线Referer/整源不可播假设及图片弱地址规则退出；无第二播放器或临时双owner。
- New risk signals:
- 故事FM当前音频跳转证书过期；用户手机确认和有效咪咕会话未验证。
- 全局格式和文档索引既有/并行问题已记录，不属于本轮实现故障。
- Advisory decision: continue
