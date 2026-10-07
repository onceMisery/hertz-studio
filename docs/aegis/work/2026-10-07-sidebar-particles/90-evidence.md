# 右侧播放器光尘优化验证

## 修改与根因

- 原增强档基准预算为 1800 / 5200 / 10400 颗，侧栏密集铺满，改为 120 / 220 / 360 颗；标准档改为 36 / 72 / 120 颗。保留密度滑块与面积预算。
- 以封面实际几何生成柔边遮罩；从歌曲标题至播放器底部统一降低光尘亮度，歌词与进度区域更干净。封面及标题尺寸变化重新测量。
- 删除轮转高频闪点，改为慢速连续呼吸；涟漪改为细线、低亮度、小幅扩散。
- GL 原先用绝对时间乘实时音频速度，音量变化重算整段位移。回归用例复现 230.03px 跳变，改为 dt 积分后 0.09px；调漂移速度的位移为 0.13px。
- Canvas 2D 原来漏乘 dt，15/30fps 下一秒漂移分别为 0.1283/0.2566px；修复后均为 1.9007px，保持实际速度一致。
- 高频闪光原来在文字避让之后叠加，突破歌词保护；现在所有亮度统一乘避让系数。像素回读高频时歌词带 alpha 总量 240，两侧分别 1162。
- 使用既有 Stage.presentation().reduced / Stage.isStageVisible() 停止减少动效、隐藏抽屉下的帧门；补齐系统偏好下的 CSS 隐藏。

## 验证证据

环境：Windows、Microsoft Edge、Playwright，WebGL2 真正绘制与 readPixels。

| 检查 | 结果 |
| --- | --- |
| `node scripts/check-stage-particles-browser.js` | exit 0；新增位移连续性、帧率独立性、高频避让、减少动效/隐藏抽屉停帧、应用与系统 CSS 显隐；既有 DPR、生命周期、降级、探针取消均通过 |
| `node scripts/check-frame-gates.js` | exit 0，37/37 |
| `node scripts/check-assets.js` | exit 0，709/709 |
| `node scripts/check-skins.js` | exit 0，687/687 |
| `cargo build --release -p hertz-studio` | exit 0，Release 构建完成 |
| `output/playwright/sidebar-particles/visual-check.cjs` | exit 0；独立 null 音频后端、真实 HTTP/WS、1600×1000 桌面和 390×844 抽屉，增强/标准模式、封面/卡拉OK、播放/暂停、应用/系统减少动效、抽屉隐藏 |
| Release 内嵌资源逐字比较 | 三个修改的 JS/CSS 与磁盘源码相同；直接使用新二进制内置资源完成上述界面检查 |
| `git diff --check`（本次文件） | exit 0 |

浏览器检查使用全局 Playwright：`PLAYWRIGHT_MODULE=D:/dev-env/node/node_global/node_modules/@playwright/cli/node_modules/playwright`，`PLAYWRIGHT_CHANNEL=msedge`。完整界面最后一轮设置 `PARTICLE_REVISIONS=after`、`PARTICLE_EMBEDDED=1`，前端资源由 Release 服务直接提供；仅使用本地测试封面及在线推荐空数据。

截图保存在 `output/playwright/sidebar-particles/`（忽略提交的验证产物）：`comparison.png`、`after-panel.png`、`after-standard-panel.png`、`after-mobile.png`、`after-mobile-cover.png`。已逐一视觉检查，粒子集中在封面周围，文字区域无密集噪点。

## 架构与边界

架构对齐：aligned。沿用 README 与 ADR-0006 的单 Stage 帧门、已有播放时钟与偏好 owner；没有新增循环、依赖、持久化设置或渲染器。两个渲染器保留同一个输入协议，旧闪点和累计时间乘音量公式已移除，既有 GL 失效回退保留。ADR 回填：skip，本次恢复既有减少动效/隐藏停帧语义并调整局部视觉，无新架构决策。

原有其他未提交改动保留。验证使用独立测试数据与静音后端；用户正在运行的 debug 实例未重启。Release 产物为 `target/release/hertz-studio.exe`，关闭旧实例并启动该产物后生效。验证不覆盖其他浏览器/GPU；在线音源请求在测试环境中有既有 404/502/504，不影响本地粒子、播放状态及设置检查，未扩展到音源修复。
