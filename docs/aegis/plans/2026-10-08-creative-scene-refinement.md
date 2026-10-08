# 创意工坊六场景收敛与歌词可读性

Goal: 按用户截图优化六个既有三维场景，收敛亮度、形变、运动并修复歌词重叠。
Architecture: CreativeGL 持有几何与材质；CreativeStage 持有参数和导演；Lyric3D 持有文字图集；Stage3D 持有显示层。保持零依赖 WebGL2、现有参数键、播放时钟与单帧门。
Tech Stack: 原生 JS / GLSL ES 3、Canvas2D、Node、Chromium。
Baseline/Authority Refs: 用户请求及截图、README、ADR-0006、creative-gl.js、creative-stage.js、lyric3d.js。
Compatibility Boundary: 保留已有未提交修改、预置/分享码/cue/绑定格式、暂停与减弱动效；不修改音频链路。
ArchitectureReviewRequired: yes

## 诊断与实施

- [x] 真实 GPU 复现：歌词面片高度约 3.75、垂直错位仅 0.42，近端 z 钳制又会让旧句重合；地形 z 随播放时间无限平移；加性面片关闭深度写入导致前后表面累积；导演 55–145 度随机跳转及统一近景机位破坏构图。
- [x] 在原 owner 修复：按文字尺寸留出行距、周围句退向远处；材质保留色彩与轮廓；地形仅滚动采样；导演基于各场景入画机位做小幅渐变。
- [x] 核验三维歌词与现有歌词叠加层，避免重复呈现当前行，保留原偏好。
- [x] 使用真实 Chromium 保存六场景前后截图，验证高能量、歌词宽度/行距边界、长播放时间、三档画质；运行相关前端回归。

Verification: `node scripts/check-creative-scenes-browser.js`、`node scripts/check-creative.js`、`node scripts/check-frontend.js --extra`。浏览器脚本通过 PLAYWRIGHT_MODULE 选择已安装运行时。

Repair / Retirement: 直接替换旧重叠排布、无界位移和随机大角度导演，不增加替代渲染器、参数格式或第二套时钟。渲染截图作为视觉证据，不能用源码阈值测试代替。

## 验证与架构复核

- `node scripts/check-frontend.js --extra`：47 步通过，无失败。
- `cargo build -p hertz-studio --bin hertz-studio --target-dir target-verify`：通过；原 `target/debug` 实例正在运行，未中断用户实例，使用独立输出目录构建。
- `node scripts/check-creative-scenes-browser.js`：六场景、三档画质、静音/满频谱共 36 组实际渲染；桌面与竖屏截图；字宽 8/16/20/32、行距 1/2.5/9、最大漂浮组合的 GPU 顶点检查通过。修复前歌词最小投影间隙为 -0.869，修复后为 +0.019；地形 10 分钟后的整体漂移从 528 降为 0。
- `node scripts/check-workshop-stage-browser.js`：隔离 null 后端与实际内嵌资源；验证歌词独占、暂停开关、切换恢复、cue/seek、减弱动效、背景合成、关闭重开与移动布局，无页面异常。
- 视觉证据：`output/playwright/creative-scenes/before/scenes.png`、`output/playwright/creative-scenes/after/scenes.png`，单场景横竖屏截图与 `metrics.json` 同目录。
- 架构对齐：保持 ADR-0006 的单帧门、播放时钟、CreativeStage 参数归属及 Stage3D 呈现归属。仅新增只读场景查询与宿主歌词可见性传递；撤掉两处重复设置 reading.hidden 的代码。未新增 renderer、依赖、持久化字段或 fallback。
- 镜头复位回归先在塔林俯角断言失败，统一使用场景入画表后六场景通过；包含 yaw/pitch/dist/height/fov 的完整复位。ADR-0006 已补充歌词呈现与机位归属。
- 退役：删除近端歌词深度钳制排布、全局自动旋转累积、地形整体平移、大角度随机切镜和星云无效的旧大点亮度补偿。三种实体材质使用深度遮挡，光环/星尘/字形保留加性混合。
- 边界：保留用户保存的参数和显式 cue，新的视觉默认值用于新预置和重新选择场景。自定义极端镜头仍由用户控制。测试使用确定性模拟频谱与隔离静音曲目，未宣称测量真实 GPU 帧率。
- 本次工作期间其它任务修改了 stage3d 的封面球材质与发布脚本；这些改动保留，非本次创意场景调整的交付范围。
