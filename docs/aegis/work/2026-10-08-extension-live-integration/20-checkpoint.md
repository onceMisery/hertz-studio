# 扩展架构真实账号与 DBX 宿主联调续接 - Checkpoint

- Task ID: 2026-10-08-extension-live-integration
- Current todo: 重建最终包并完成宿主与账号联调
- Active slice: 恢复原工作树并重验连接
- Blocked on: none
- Next step: 定位宿主异常，安装新包，检查真实播放与扩展生命周期

## DriftCheckDraft

- Scope status: 完成既有修复、原生联调和本地合并范围；未扩展上游平台协议
- Compatibility status: aligned；HTTP票据边界、RPC/API、注册ID与保存格式不变；已验收DBX最低版本0.6.35
- Retirement status: 移除DBX对HTTP票据的错误依赖及过期sidecar测试假设；不恢复旧质量源名单
- New risk signals:
- QQ扫码未答复；汽水搜索空结果；Jamendo未联调
- Advisory decision: continue

## Checkpoint Update

- Current todo: 验证通过，提交遗留修复并按既有授权本地合并master
- Active slice: 本地提交、合并和测试进程收尾
- Completed todos:
- HTTP/DBX连接边界修复与真实DbxTransport回归
- 最终DBX0.6.35包字节核对、原生换肤/场景/网易云播放验证
- 前端48、Rust510通过/1忽略、最终包sidecar269、独立服务工坊8组通过
- 两轮独立审查及增量复核，无遗留P1/P2
- Evidence refs:
- docs/aegis/work/2026-10-08-extension-live-integration/90-evidence.md
- Blocked on: QQ资料401/取流失败，人工扫码尚未收到答复；汽水搜索为空；Jamendo未联调
- Next step: 提交、ff合并master，核对合并后代码与最终包并关闭隔离测试进程
