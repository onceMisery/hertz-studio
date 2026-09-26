# 按优先级补齐播放器功能 - Intent

## TaskIntentDraft

- Requested outcome: 完成审计列出的第1–13项功能修复，先实现后验证，不走 TDD。
- Goal: 同上。用户于实施中明确“创意功能和宿主扩展可不完成”，第14项不再是完成条件。
- Success evidence:
- 每项均有实际实现、针对性回归与对应运行证据；外部平台/真实声卡验收不能由模拟检查代替。
- Stop condition: 全部1–13项证据成立才完成；局部完成继续推进，真实外部阻塞明确记录。
- Non-goals: 创意功能与宿主扩展；破坏用户现有舞台改动；擅自公开发布、替用户操作真实平台歌单。
- Scope: 分页、曲库维护、混合歌单、歌词、整理、迁移、凭据、缓存、在线平台、音频、远程来源、分发、历史。
- Change kinds:
- feature
- Risk hints:
- none

## BaselineReadSetHint

- README 当前架构与路线图、routes.rs API、state.rs 播放提交协议、store 查询/迁移、app.js 与 favorites.js 宿主接线。

## ImpactStatementDraft

- Compatibility boundary: local-first、SQLite持久化、单一音频actor与服务端队列权威、既有在线身份；保留原舞台改动。
- Affected layers:
- none
- Owners:
- none
- Invariants:
- none
- Non-goals:
- none

These records are Method Pack drafts / hints, not authoritative runtime decisions.
