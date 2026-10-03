# 凝彩、商籁歌词动画优化

- Goal：参考 folia-major 的歌词运动节奏，让逐字入场、唱中强调与换句连续、清晰，并保留两种舞台的视觉区别。
- Architecture：沿用 Stage 播放时钟、StanzaSonnet 帧归一化、StanzaSonnetFx 排版/运动/退场及现有两套导演；不增加依赖、帧循环或设置。
- Tech Stack：原生 JavaScript、PixiJS 8、Node 检查脚本、Playwright 真实 WebGL。
- Baseline/Authority Refs：README.md；docs/aegis/BASELINE-GOVERNANCE.md；现有 stanza 三个渲染文件；folia-major 的 temperaMotion.ts、temperaEnterStyles.ts、sonnetMotion.ts。
- Compatibility Boundary：歌词原文、逐字时间、点击跳转、主题、背景选择、其他歌词模式及已有用户改动保持兼容。暂停、seek、减少动态和节能模式必须可用。
- Verification：运动边界/确定性回归、现有 stanza 检查、真实浏览器桌面/手机与短句/长句/换行截图。
- Complexity：medium；ArchitectureReviewRequired: yes。基线目录为空，以上现行 owner 与 README 作为范围内基线。

## 方案与取舍

采用现有 Pixi 管线内的针对性优化。仅调速度无法修复切色与反色层不同步；全面迁移参考项目的 React/121 种构图会扩大范围。以参考项目的短距离入场、快速可读、唱中轻强调和绝对时间求值为设计依据，不复制其框架或完整分镜系统。

## 实施步骤

1. 按用户后续明确要求，不走 TDD；直接实现、调画面，完成后运行必要回归。scripts/check-stanza-motion.js 覆盖字首字尾连续性、零时长标点、减少动态和 seek。
2. 在 stanza-sonnet-fx.js 替换共享的硬切色和 sin 弹跳；按音节时长限制入场与强调，在布局阶段保存确定性的入场样式，按舞台选用柔和抬升或印刷盖印/方向错落。
3. 扩展现有 retirement 管理有界的旧句文字退场；只在顺播相邻行时启用，seek/换曲/减少动态时清理。无额外计时器。
4. 在 stanza-tempera.js 同步反色克隆的透明度，缩小扫光前缘，避免遮住未唱字；两套 engineTuning 指明各自运动风格。
5. 执行 node scripts/check-stanza-motion.js、check-stanza-sonnet.js、check-stanza-tempera.js、check-sonnet-palette.js、check-stanza.js；真实浏览器检查两模式连续时间采样、换句、暂停、seek、移动端、长句与减少动态。

## 风险与退出条件

旧句退场必须有界，避免新旧正文叠成重影；反色层必须跟随原字，避免双影。验证通过并人工查看截图后完成，不以纯函数通过代替视觉检查。不改存储/API，也不引入需 ADR 的持久架构决策。旧的硬切色、统一弹跳逻辑直接替换，无并存路径。
