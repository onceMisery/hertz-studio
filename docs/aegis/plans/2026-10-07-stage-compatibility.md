# 歌词舞台色彩、转场与设置兼容性

Goal: 修复凝彩彩色显示，减轻凝彩/商籁换句阻塞，使设置明确反映当前渲染能力，隐藏被覆盖的 3D 场景，并加强星诞电影表现。

Architecture: 保持原生 JS IIFE、StanzaTheme 调色入口、Stage 单帧循环、stage3d 设置状态和星诞元导演。设置能力由当前实际 renderer、背景、歌词显隐与 WebGL 状态派生，不另建持久化状态。

Tech Stack: Rust 内嵌静态资源、原生 JS/CSS、Pixi、Node 契约脚本、Chromium 浏览器验收。

Baseline/Authority Refs: 用户本轮五项要求（不采用 TDD）；README；docs/aegis/work/2026-10-07-stanza-premium/90-evidence.md；ADR-0006；VCPChat music-stage config/modes；folia-major visualizer settings/tempera/sonnet。

Compatibility Boundary: 保留当前未提交修改、已有配置键、独立/插件形态、暂停/seek/reduced/eco、所有歌词模式。参考项目只读。不修改音频播放业务。

Verification: 实现后运行 node scripts/check-frontend.js --extra；真实 Chromium 检查凝彩中性主题下 duo/mono/vivid 像素、换句资源复用、暂停/seek、各模式设置/背景可用性和星诞切镜。若环境限制不能覆盖，记录实际边界。

ArchitectureReviewRequired: yes

## 执行切片

- [x] 凝彩：定位 palette 输入/色彩混合，保持单色选项语义；换句复用资源，补实现后的回归检查。
- [x] 商籁/共享 FX：定位同步场景构建和纹理生成，避免换句尖峰，保留取消与销毁契约。
- [x] 设置/3D：派生能力表用于控件状态、状态提示、dock、手势与绘制；隐藏被二维背景覆盖的场景，保留偏好以便切回恢复。
- [x] 星诞：导演输出确定性的调色/光影/转场参数，由宿主统一消费；使用轻量合成层。
- [x] 集成：审查并行改动，运行全量前端检查与浏览器回归，保存证据。

## Repair / retirement

撤掉散落的 opacity/motion 禁用判断，替换为唯一能力派生；不叠加另一套偏好。移除换句路径上重复构建的资源，缓存必须有界、生命周期由现有 renderer 持有。保留舞台背景偏好，但暂不显示的背景不得继续耗费绘制资源。星诞继续只导演，不拥有第二个 renderer。

## 继续优化（用户追加授权）

ArchitectureReviewRequired: yes。沿用现有 owner、配置键与单帧循环，禁止 TDD；先诊断探针、再实现、最后补回归。

- [x] DOM 暂停/seek：流光子动画与退场寿命、心象平滑/重绘恢复播放时钟语义。
- [x] 商籁显示开关：原字形直接切换可见性，删除无效重建；凝彩 mono 全链路禁止色散和暖化。
- [x] 主机交接：`output/probe-stage-handoff.cjs` 证实进出场 380/201ms 不等、暂停后旧层仍隐藏、新层未就绪旧层已消失。由 stage3d 唯一 owner 使用 Stage.position 驱动 opacity，等待 renderer 首帧或错误提示；暂停手动切换/减弱动效在就绪时直接完成。移除 setTimeout 与整层 blur 路径。
- [x] 粒子：歌词区域避让与销毁/重建生命周期修复；旧 GL 探针和旧涟漪回调不会影响新实例。
- [x] 后验：真实 Chrome DOM、交接冷启动/暂停/seek/快速切换/隐藏/减弱动效，粒子像素/生命周期、Pixi 资源/灰阶，以及隔离后端加载当前舞台资源的整页回归均通过。
- [x] 最终打包验收：后端在途修改恢复可编译后，重新构建并完成实际内嵌资源全应用验收；README 路由清单由现有脚本同步；42步前端与8项二进制测试通过。

PatchShape: 跨 renderer 生命周期；CanonicalOwner: stage3d 交接、renderer 首帧就绪；UpwardDrillSignal: 墙钟动画和播放时钟分属两套 owner；Decision: 在宿主撤销墙钟退场，不新增调度器。保留冷启动惰性加载，不扩大预加载缓存。

## Risks

工作区含多项先前在途修改；所有结果以当前工作树为基线。GPU 时间受机器影响，使用资源计数、像素和时序行为共同验证，不能只以源码断言宣称流畅。
