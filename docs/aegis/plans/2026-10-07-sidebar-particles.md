# 右侧播放器光尘优化

- Goal：减少动效关闭时，右侧播放器保留柔和氛围，消除密集噪点、跳动和文字区域闪光。
- Architecture：沿用 Stage 单帧门、StageParticles 几何与参数 owner、Canvas 2D / ParticleGL 渲染器；不增加依赖、设置或渲染层。
- Tech Stack：原生 JS / CSS、Canvas 2D、WebGL2、现有 Playwright 浏览器检查。
- Baseline/Authority Refs：用户截图与优化要求、README.md、docs/aegis/adr/0006-frame-gates-and-visual-timing.md。
- Compatibility Boundary：保留参数与性能档位、封面取色、播放/暂停、减少动效、隐藏停帧、GL 降级和销毁；不修改全屏三维舞台和已有未提交改动。
- Verification：真实浏览器像素回读验证音量突变时位置连续、歌词避让、2D 时间步长；既有粒子生命周期、帧门和资源接线检查；桌面/窄屏截图。
- ArchitectureReviewRequired：yes（同一粒子子系统的两个渲染器）。无新增架构决策，无需新增 ADR。

## 执行顺序

1. 扩展 scripts/check-stage-particles-browser.js，先复现高频闪光越过歌词避让、增强模式累计时间乘实时速度引起的位置跳变、2D 忽略 dt 的帧率依赖。
2. plugin/ui/stage-particles.js：减少基础密度；用实际 dt 计算慢速漂移；移除轮转闪点；文字避让覆盖歌曲信息至歌词；缩小涟漪位移与亮度。
3. plugin/ui/stage-particles-gl.js：收敛密度与亮度；累计位移按 dt 积分；以连续呼吸取代轮转闪点；所有亮度统一经过文字避让。
4. plugin/ui/stage.css：粒子边缘柔和隐去，涟漪描边变细。复用现有取色与开关。
5. 运行粒子浏览器检查、node scripts/check-frame-gates.js、node scripts/check-assets.js；截图审视桌面与移动抽屉、应用和系统减少动效。

## 修复与退役

根因在渲染器的密度、时间积分和合成顺序，直接修复 owner。删除高频轮转闪点与绝对时间乘音频速度的旧公式；保留既有 GL 失效回退，它仍负责平台兼容。参数语义与持久化不变。视觉风险通过相同素材与时间点的截图比较检查；回退只涉及本次文件差异。
