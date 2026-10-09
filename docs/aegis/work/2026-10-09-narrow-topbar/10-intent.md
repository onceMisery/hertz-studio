# 窄屏双行顶栏与确定性清风检查 - Intent

## TaskIntentDraft

- Requested outcome: 按前一聊天已批准方案消除顶栏窄屏溢出，清风检查自动准备音频并独立验空态
- Goal: 按前一聊天已批准方案消除顶栏窄屏溢出，清风检查自动准备音频并独立验空态
- Success evidence:
- 七皮肤×320/330/390/620/621/700/1440px 页面无横向滚动，按钮可命中，搜索及菜单定位正确。
- 清风检查无需已有播放状态，自动验证空态和带真实标题/歌手标签的音频。
- Stop condition: 上述浏览器验收、构建、相关前端检查通过后交付代码和新构建。
- Non-goals:
- 不更改账号、播客、播放器业务或已有7634实例
- Scope: 顶栏布局与浏览器回归，覆盖当前七套皮肤
- Change kinds:
- bugfix
- Risk hints:
- 默认 exe 被既有进程占用，使用独立 target-narrow-topbar 构建；不重启现有服务。

## BaselineReadSetHint

- docs/extension-guide.md
- docs/aegis/adr/0009-extension-registries.md

## ImpactStatementDraft

- Compatibility boundary: 保留按钮尺寸、动作及搜索入口，保持皮肤生命周期与播放服务接口
- Affected layers:
- 共用顶栏 CSS、浮光搜索布局、搜索浮层定位、浏览器检查工具。
- Owners:
- plugin/ui/style.css
- scripts/check-qf-issues.js
- Invariants:
- 皮肤 ID、生命周期、播放意图、所有原有按钮尺寸和动作保持。
- 测试仅操作自建临时服务，使用 Null 音频后端与内存凭据。
- Non-goals:
- 不更改账号、播客、播放器业务或已有7634实例

These records are Method Pack drafts / hints, not authoritative runtime decisions.
