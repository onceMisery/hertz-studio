# 3D 舞台体验升级（2026-09-25）

- Goal：参考 Mineradio 的空间粒子、电影镜头、玻璃控制条，让独立舞台兼具演出与完整音乐操作。
- Baseline：README.md、mineradio-stage.md、stage3d.js、stage.js、app.js；参考 Mineradio 的 01-scene 与 02-visual 源码和 index.css。
- Architecture：沿用 Stage3D 的 WebGL2 上下文、FBO 与 Stage.gate；Stage 提供只读演出数据，播放操作仍经 stage:control 交给 app.js。
- Tech stack：原生 JS / CSS / WebGL2，Rust 内嵌静态资源，无新增生产依赖。
- Compatibility：保留已有五场景的标识和数字索引，重做隧道、星球、地形；新增第六场景共振星环作为初次入口、第七场景封面浮雕；保留原播放、歌词与音频所有者。
- 实施：组织化点阵曲面、64 段局部频谱形变、起音传播波、鼠标作用场、封面采样；同步歌词和歌曲信息；增加进度、播放、音量与队列入口；统一玻璃 UI；补齐减少动态效果、焦点管理、降级与帧时间累计。
- Verification：直接实现后执行现有 Node 契约检查、cargo build、真实浏览器的七场景渲染、播放交互、窄屏、键盘、降级检查。不使用 TDD（用户明确要求）。
- ArchitectureReviewRequired: yes。重点检查：无第二个播放时钟、无额外 rAF、不可见时停止渲染、焦点不穿透、WebGL 失败仍能退出。
- 验收限制：画质与帧率依赖 GPU，浏览器实测结果记录在本文件末尾，不将设计目标当作已测结论。

## 用户中途反馈与第二轮方向

用户明确反馈「尤其是舞台效果相差甚远，需要优化」。在独立本地静态服务中实际运行 Mineradio，导入同一验证 WAV，对照月蚀圣环和星球截图。首轮差距：实体球/方块地形/随机星环不具备参考的高密度连续点阵曲面和局部音频形变。第二轮重做星环、星球、隧道、地形为有组织的音频驱动粒子曲面，并加入封面粒子浮雕、指针作用和分层环境光。保留已完成的音乐控制与偏好保存。全程不使用 TDD。

## 最终实现与验收（2026-09-26）

第二轮完成：五种组织化粒子曲面、保留极光和棱镜星系，共七个场景；移除被替代的实体球、方块地形和旧隧道实现。构图按宽高比调整，窄屏适配球体/星环主体；低性能档降低点数、DPR 和后处理采样。律动归零时抑制全部音频包络，暂停时自然衰减。舞台退出停止自身帧门，进入时暂停下层视觉绘制，共享时钟和能量门持续服务当前舞台。

实现后验证证据（退出码均为 0；Playwright CLI 另检查其结果而不只检查命令退出码）：

| 检查 | 结果与范围 |
| --- | --- |
| `cargo build -p vmusicd` | 编译通过；浏览器使用实际内嵌资源，无路由替换 |
| `node --check`（app.js / stage.js / stage3d.js） | 三文件语法检查通过 |
| `node scripts/check-assets.js` | 339/339，通过路由与资源接线 |
| `node scripts/check-css-tokens.js` | 5 文件、1183 条规则，通过令牌契约 |
| `node scripts/check-stage-cinema.js` | 114/114 |
| `node scripts/check-stage-control.js` | 74/74 |
| `node scripts/check-stage-idle.js` | 29/29 |
| `node scripts/check-creative.js` | 268/268 |
| `playwright-cli -s=hertz-stage run-code --filename=target/stage-browser-check.js` | 33 项：七场景、真实本地文件扫描、播放/暂停、seek、音量同步、逐字歌词与点击跳转、焦点、390px 布局 |
| `playwright-cli -s=hertz-stage run-code --filename=target/stage-effects-check.js` | 30 项：低/中/高频、起音、零律动、暂停衰减、封面/坏图、镜头、全屏、偏好保存/刷新恢复、减少动态效果、WebGL 丢失/恢复、销毁重建、下层视觉门控；无 JS 或 WebGL 错误 |
| `playwright-cli -s=hertz-stage run-code --filename=target/stage-compat-check.js` | 20 项：禁用 WebGL 仍可控制播放/退出；390×844、360×800、320×740、844×390 无溢出，工具条、场景坞与播放器不重叠 |

测试脚本和原始结果在 `target/stage-*-check.js`、`target/stage-*-result.txt`；截图在 `output/playwright/`，后者与 CLI 缓存仅在 `.git/info/exclude` 本地排除，不进入生产资源。验证服务使用 7645 端口、`target/stage-review` 隔离数据目录和 `VMUSIC_BACKEND=null`，不操作用户音乐库。截图、录屏中的动态频谱由验证脚本注入，封面浮雕使用本地 Canvas 生成的验证图；完成后清除注入并暂停验证曲目。此前在线账号接口的 401 属于未登录状态，与本次舞台无关。

### 架构对齐与边界

- 对齐：Stage 仍拥有曲目、歌词、时钟、音量快照和频谱；`presentation()` 与 `lyricTokens()` 只向演出层提供现有数据。所有播放操作通过 `stage:control` 交给 app.js；没有新增播放器、FFT 实现、rAF 或生产依赖。
- 对齐：独立 WebGL2 舞台继续使用原有 FBO 与 `Stage.gate()`。新增 `stage3d-ui` 低频门，确保没有 WebGL 时播放控件仍可更新。
- 兼容契约：`settings.stage3d` 保存 `scene / motion / bloom / reactivity / lyrics / cruise`，恢复时钳位并通过现有 settingsEpoch 防止旧响应覆盖用户操作。缺失设置采用默认共振星环、65% 镜头动态、80% 光晕、135% 律动。
- 生命周期：监听只绑定一次；销毁清理观察器、延后尺寸任务、帧门、GPU 资源和封面回调；重新初始化可用。
- ADR 回填：本次作为现有独立舞台的增量实现，在此记录新增表现数据与设置契约，不新建架构决策目录；README 补充入口和快捷键。
- 未覆盖：真实音频设备输出、不同硬件/浏览器的帧率、主观“与 Mineradio 同等质量”的用户验收。当前证据覆盖 Chromium 实拍、合成频谱驱动和本机无声后端控制，置信度 B。

所有实施项已完成；无遗留实现待办。视觉质量以本地实拍供用户评估，不将参考目标写成已经获得用户认可的结论。
