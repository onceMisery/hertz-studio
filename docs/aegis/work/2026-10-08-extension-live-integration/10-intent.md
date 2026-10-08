# 扩展架构真实账号与 DBX 宿主联调续接 - Intent

## TaskIntentDraft

- Requested outcome: 完成已授权扩展架构重构的真实联调、遗留修复和本地 master 合并
- Goal: 完成已授权扩展架构重构的真实联调、遗留修复和本地 master 合并
- Success evidence:
- 最终包与当前工作树一致；原生宿主事件、换肤、舞台和真实音频播放验证；前端回归；精确记录账号和宿主外部限制
- Stop condition: 代码修复及本地合并完成；需人工扫码或宿主外部缺陷必须标明未完成边界
- Non-goals:
- 不修改其他仓库、不发布、不推送远端、不替换用户现有安装或正式账号数据
- Scope: 原工作树中遗留 DBX 事件启动修复、最低宿主版本、真实账号接口与 WebView 验收、交付文档
- Change kinds:
- integration-fix
- Risk hints:
- ArchitectureReviewRequired: yes；真实外部平台登录状态与 DBX 宿主能力

## BaselineReadSetHint

- docs/aegis/adr/0009-extension-registries.md
- docs/aegis/specs/2026-10-08-extension-architecture-design.md
- docs/aegis/BASELINE-GOVERNANCE.md

## ImpactStatementDraft

- Compatibility boundary: HTTP/RPC API 不变；最低已验收 DBX 版本设为 0.6.35
- Affected layers:
- 前端事件启动、插件发布与原生宿主
- Owners:
- HTTP 鉴权和握手票仍归服务器；DBX/mock 事件桥归各自 transport
- Invariants:
- HTTP 每次握手一张短期票；失败不回退长期 token；注册 ID、保存格式、分享 v1 不变
- Non-goals:
- 不修改其他仓库、不发布、不推送远端、不替换用户现有安装或正式账号数据

These records are Method Pack drafts / hints, not authoritative runtime decisions.
