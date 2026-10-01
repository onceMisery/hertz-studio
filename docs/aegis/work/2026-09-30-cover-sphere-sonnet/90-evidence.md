# 证据

## 构建与隔离服务

- 独立构建目录 `target-verify-skin-playback`，`vmusicd.exe` 时间戳 2026-09-30 21:32，晚于本轮全部 web 资源改动（最晚 folia-theme.js 21:31），浏览器脚本另做内嵌资源与工作台文件逐字比对。
- 隔离服务：`VMUSIC_BACKEND=null VMUSIC_PORT=18774 VMUSIC_BIND=127.0.0.1 VMUSIC_DATA_DIR=output/stage-visual/data`；health 返回 backend=null，不触及用户音乐库与日常实例。验证结束后该隔离进程已停止。

## Node 回归（2026-09-30 复跑）

- `scripts/check-cover-sphere.js`：43 项（场景 id/深度/非加性、相机参考视角、三档点数 14000/32000/54000、绘制状态机）；`--gpu` 模式 102 项，含 WebGL2 真实几何与渲染采样（renderer: WebKit WebGL）。
- `scripts/check-sonnet-palette.js`：调色来源、1083 组色相/饱和度采样、角色分色、签名刷新与旧契约；活动字最低对比 7.26:1。
- `scripts/check-stage-backgrounds.js`：20 项（目录白名单、路径/URL 越界回退、隔离、持久化、渲染与输入门、控件接线）。
- 关联回归：check-folia-sonnet、check-folia、check-folia-tempera、check-theme-studio（519 项）、check-stage-theme（28 项）、check-stage-idle（29 项）、check-assets（448 项）全部通过。
- 语法：stage3d.js / theme-studio.js / folia-theme.js / folia-sonnet.js / folia-sonnet-fx.js / stage.js `node --check` 通过；`git diff --check` 无空白错误。

## 浏览器验证

- `scripts/check-stage-visual-browser.js` 8 项通过（2026-09-30 23:5x 重跑）：球面有细节封面且无 WebGL 回退、旋转中持续渲染、中性 UI 主题下商籁仍彩色（palette: sonnet-stage-palette #10111e/#f5f3ee/#a0c6e9/#9680db/#e8d987）、壁纸与明暗独立保存且主页 ThemeStudio.state 不变、真实刷新后偏好恢复、移动端减少动效商籁不出视口、图片 404 回退氛围且无破图、切回 3D 恢复球面。
- 截图：output/playwright/stage-visual/ 下 sphere-desktop / sphere-rotated / sphere-mobile / sonnet-atmosphere / sonnet-anime / sonnet-settings / sonnet-mobile / cover-original。人工复核：球面轮廓完整、原图山形/太阳/ORBIT 字样与配色可辨、背面不透叠、无过曝光晕；二次元背景压暗后歌词仍清晰。
- `scripts/check-3d-browser.js` 16 项通过（23:25 运行，代码未再变动）：含 OS 减少动效冻结场景时间、4K 视口像素预算、七场景切换无渲染回退。

## 验证脚本自身修复

- 原 check-stage-visual-browser.js 末段「切回 3D」截图在 configure 后立即拍摄；减少动效 15fps 下截图抢在恢复后首帧之前，sphere-mobile.png 曾为黑画布，而断言只查 class 未查像素，检查名义通过。
- 聚焦复现（readPixels 跨帧取最大亮度 + 双时点截图）确认产品无缺陷：稳帧后球面正常渲染。
- 修复：新增 sphereLuma()（rAF 内 readPixels，12 帧取最大），断言 litRatio > 0.2 后再截图；重跑 8 项全过，sphere-mobile.png 已见球面。

## 独立审查

独立审查子代理（只读，30 次工具调用）结论：**无阻断项**。

- 已核对无误：silk 保留场景 id/WebGL2/帧门、无 Three.js；球面 Fibonacci+立体投影映射、facing 剔除背面、depth+depthMask 与实心点片元防透叠；uArtScale 中心裁切、mipmap LOD 按点密度；GPU 脚本断言半径/映射/背面剔除/点径/暗像素不透明与分档像素预算。resolveSonnet 四分色、正文 #f5f3ee 对比≥12:1、accent 最低 7.26:1、中性源回退彩色 Nocturne、resolve 旧契约未变。壁纸复用 ThemeStudio 目录、只写 stage3d 设置、白名单防穿越、onerror 回退、刷新恢复、主页 state 不变、covered 时底色透明不遮壁纸。
- 建议项（记录搁置，不在本轮处理）：
  1. computeDpr 去掉 0.50 下限并加 MAX_TEXTURE_SIZE 约束，影响全部场景低档 dpr——跨场景回归已由 check-3d-browser 的 4K 像素预算与七场景切换断言覆盖，暂不另补。
  2. 缩略图廊仅在空时构建一次，目录后到不刷新——壁纸目录为内嵌静态资源，运行期不变，接受现状。
  3. check-stage-backgrounds.js 打印硬编码「20 checks」——仅文案，不影响断言。
  4. 压暗层用 :has()（Chrome 105+），旧内核静默失去 dim——仅观感降级。
