# 在线账号修复与中文播客 - Intent

## TaskIntentDraft

- Requested outcome: 汽水扫码入口修复；咪咕可用能力补齐；中文点播播客搜索、单集和RSS订阅
- Goal: 汽水扫码入口修复；咪咕可用能力补齐；中文点播播客搜索、单集和RSS订阅
- Success evidence:
- 目标回归、Rust测试、前端浏览器、HTTP/RPC及真实RSS播放证据
- Stop condition: Stop when success evidence is satisfied or a blocker/risk requires pause.
- Non-goals:
- 直播电台、私有付费播客、会员权限绕过、替用户完成手机确认、自动发布不在本轮范围。
- Scope: 账号修复和中文点播播客
- Change kinds:
- bugfix,feature
- Risk hints:
- ArchitectureReviewRequired: yes

## BaselineReadSetHint

- docs/aegis/specs/2026-10-08-online-accounts-podcasts-brief.md
- docs/aegis/adr/0009-extension-registries.md
- docs/aegis/adr/0001-online-playback-limits.md

## ImpactStatementDraft

- Compatibility boundary: Provider ID、队列/播放意图、凭据保险库与 HTTP/RPC 信封保持；共用公网策略保护新增 RSS/音频/封面输入。
- Affected layers:
- Rust Provider/播客服务/SQLite/共享网络边界、HTTP 与 DBX、原生 JS 栏目和登录弹窗。
- Owners:
- `podcasts` 持有目录/RSS/订阅/单集映射，`public_net` 持有公网策略，AppState/Online 保持唯一队列和播放器。
- Invariants:
- 20 秒取流、512 MiB 音频、16 MiB RSS、2000 期、持久稳定 ID、账号验证后才报登录成功。
- Non-goals:
- 保留主目录并行首页、清风和网易改动；原有 7634 服务不在测试过程中重启。

These records are Method Pack drafts / hints, not authoritative runtime decisions.
