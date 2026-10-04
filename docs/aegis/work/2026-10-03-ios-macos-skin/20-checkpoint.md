# 检查点

- [x] 读取 Folia iOS 布局/导航/分组/播放页和语义令牌。
- [x] 对照 Hertz 真实 DOM 与皮肤，定位 fixed 舞台与 grid 冲突、.is-on/.active 不匹配。
- [x] 完成桌面分栏、移动横排导航、系统字体、圆角/间距/表面/状态调整。
- [x] 统一 ios-light 功能强调色，保留深色主题及原切换机制。
- [x] 浏览器复查原版（120 项中 36 失败），新版最终 184/184 通过。
- [x] 检查实际截图、业务播放按钮、弹层关闭、末行滚动与切回 classic。
- [x] 相关静态检查通过；记录完整文件清单和边界。

DriftCheckDraft：aligned；无第二套主题/播放器所有者，无 DOM id 或业务事件修改。

测试修正记录：自动化浏览器需授予测试 origin 的 local-network-access；程序化 focus 不等于键盘 focus-visible，改用 Tab/Shift+Tab；stop 按既有语义保留曲目，空闲验收须启动全新测试数据目录。这些调整均位于测试脚本，没有为通过测试改变生产逻辑。

ResumeStateHint：已完成；测试图像与日志在 `output/playwright/ios/`。交付源码，未重建/替换用户使用中的二进制。
