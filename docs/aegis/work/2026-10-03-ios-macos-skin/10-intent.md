# 改造范围与基线

用户要求分析 `D:/code/github/folia-major` 的 UI 并优化当前 iOS 皮肤，同时参照 macOS 风格，保持业务功能与调用方式。设计、来源和关键差异见 [实施计划](../../plans/2026-10-03-ios-macos-skin.md)。

- TaskIntentDraft：皮肤重构、状态一致、深浅色与响应式验证；无新功能、接口或持久化字段。
- BaselineReadSetHint：README、BASELINE-GOVERNANCE、2026-09-30 skin-playback-review；实际入口 HTML、style.css、stage.css、Theme/Skins；参考项目 ios.css 与五个 iOS 组件。
- ImpactStatementDraft：只改 skin.ios.css、ios-light 颜色、iOS 皮肤说明及对应检查。Theme 仍唯一拥有颜色，Skins 仍唯一拥有皮肤切换，播放器与源数据所有者不变。
- ArchitectureReviewRequired：yes；审查范围为视觉覆盖与现有接口兼容。
- 工作区存在并发修改；不回滚或归入本任务。新增每日推荐入口由现有脚本插入，导航使用弹性/滚动布局容纳，未替换入口逻辑。

完成条件：关键差异有依据、布局不重叠、操作可达、主题可切回、相关检查通过、文件目的可追溯。
