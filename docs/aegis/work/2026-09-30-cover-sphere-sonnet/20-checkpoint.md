# 检查点

- 已批准方案并记录执行计划。
- 球形封面：已实现。silk 场景（id 保留）改为球面点云：正面立体投影盘 + 背面半球，深度测试遮挡背面，点密度/亮度按质量档受像素预算限制；标题与说明更新为「封面星球」。回归：scripts/check-cover-sphere.js（43 项）。
- 商籁色彩：已实现。folia-theme.js 新增 resolveSonnet，背景/重音/次色/第三色分色，中性源色回退「Sonnet Nocturne」而非黑白；其他歌词模式仍走 resolve 旧契约。回归：scripts/check-sonnet-palette.js（1083 组采样，活动字最低对比 7.26:1）。
- 舞台背景：已实现。复用 ThemeStudio.wallpapers() 目录；stage3d 设置单独持久化 foliaWallpaper/foliaWallpaperDim；缩略图选择、明暗滑杆、图片失败回退氛围、与主页壁纸偏好隔离。回归：scripts/check-stage-backgrounds.js（20 项）。
- 验证：已构建 target-verify-skin-playback（21:32，晚于全部 web 资源改动），端口 18774 + VMUSIC_BACKEND=null 隔离服务；scripts/check-stage-visual-browser.js 8 项浏览器检查通过（截图在 output/playwright/stage-visual/），scripts/check-3d-browser.js 16 项通过。
- 修复：check-stage-visual-browser.js 末段截图原无稳帧等待，减少动效 15fps 下拍到恢复后首帧前的黑画布；已加 readPixels 像素断言与稳帧后截图并重跑。
- 文档与证据：见 90-evidence.md；独立审查结论见该文件末节。
