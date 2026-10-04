# iOS / macOS 改造交付与验证

## 结果

完整差异表、参考来源和实施范围见 [计划](../../plans/2026-10-03-ios-macos-skin.md)。

实际效果：桌面侧栏宽 184px，内容区弹性分配，普通播放面板宽 320px。空闲时恢复两列，不再把导航与内容纵向堆叠。平板保留原抽屉；手机主内容占满宽度，导航入口保留文字，空间不足时横向滚动，每项至少 48×52px。

视觉规范：系统字体栈；页标题 28px（手机 26px）、歌曲标题 14px、说明 12px；控件/分组/面板圆角 8/12/16px，输入框 8px、搜索框 10px；4/8/12/16/24px 间距。桌面控件 36px，触控控件 44px。iOS 浅色功能强调统一 #0A63C9，状态红/绿/橙保持语义。深色沿用所选主题，皮肤不写颜色字面量。

图标复用现有内联 SVG 与 currentColor，导航 20px、工具图标 18px；未添加外部图片、图标字体或 SF Symbols 资源。现有封面、唱片及舞台功能保留。

## 文件清单与目的

| 文件 | 本次改动目的 |
| --- | --- |
| `plugin/ui/skins/skin.ios.css` | 重构正常流分栏、工具栏/导航/列表/设置/播放栏/浮层；统一字体、间距、圆角和状态；适配移动导航、安全区、dvh、减弱动效与原生深浅色控件 |
| `plugin/ui/themes.js` | 只调整 ios-light 的辅助/选中强调色与说明，保留主题接口和其余主题 |
| `plugin/ui/skins/skins.js` | 只更新 iOS 的说明文字；该文件已有的其他改动不属于本任务 |
| `scripts/check-skins.js` | 替换强制“大圆角、1.8倍留白”的旧断言，检查分层圆角、正常流、真实 .active 状态、安全区；保留其他检查与并发改动 |
| `scripts/check-ios-skin-browser.js` | 新增真实页面、当前工作区资源、隔离 null 后端的浏览器验收；检查几何、滚动、状态、主题、播放和截图 |
| `docs/aegis/plans/2026-10-03-ios-macos-skin.md` | 参考分析、关键差异、改进项、边界和计划 |
| `docs/aegis/work/2026-10-03-ios-macos-skin/10-intent.md` | 任务范围、源码基线、所有者与兼容边界 |
| `docs/aegis/work/2026-10-03-ios-macos-skin/20-checkpoint.md` | 实施进度、验证过程和恢复位置 |
| `docs/aegis/work/2026-10-03-ios-macos-skin/90-evidence.md` | 本交付记录、文件清单、命令与验证边界 |
| `docs/aegis/work/2026-10-03-ios-macos-skin/99-reflection.md` | 架构对齐、旧方案移除和剩余边界 |
| `docs/aegis/INDEX.md` | 登记上述本任务记录，保留已有条目 |

## 验证

| 检查 | 结果 |
| --- | --- |
| `node scripts/check-skins.js` | 278/278 通过 |
| `node scripts/check-ios-theme.js` | 88/88 通过，包括 WCAG AA 颜色对比度 |
| `node scripts/check-stage-theme.js` | 52/52 通过，独立舞台主题边界保持 |
| `node scripts/check-assets.js` | 477/477 通过 |
| `node scripts/check-css-tokens.js` | 通过，6 文件 / 1581 规则 / 46 受检声明 |
| `node --check scripts/check-ios-skin-browser.js` | 语法通过 |
| `node scripts/check-ios-skin-browser.js` | 184/184 通过，浏览器异常 0 |
| `git diff --check` | 通过 |

浏览器：Windows Microsoft Edge（Playwright）。两个主题 ios-light/mineral；空闲尺寸 1440×900、1280×720、1024×768、768×1024、390×844、320×640、844×390。已载入曲目覆盖其中 5 种尺寸；验证正常分栏、抽屉完全收起、所有播放控件、弹层关闭、末首曲目可滚动到达，以及真实 null 后端的播放/暂停/下一首。另验证禁用、Tab 焦点、原生控件 light/dark/light、减少动效、切回 classic。截图检查包含默认壁纸和无壁纸。

原版对照使用保存的原 `skin.ios.css` 与同一页面/当前业务脚本：84/120 通过、36 失败，复现大屏导航占整行、窄屏文字消失、过小点击区域、选中态不一致及原生主题缺失。该对照不冒充整库历史版本。

复现方式（必须使用新的测试数据目录，stop 按设计不会卸载曲目）：

```powershell
$env:VMUSIC_BACKEND = 'null'
.\target\debug\hertz-studio.exe --port 18776 --data-dir output\ios-skin-audit\new-run
# 另一终端，PLAYWRIGHT_MODULE 指向本机安装的 playwright 模块
$env:PLAYWRIGHT_MODULE = 'D:\code\github\folia-major\node_modules\playwright'
$env:PLAYWRIGHT_CHANNEL = 'msedge'
node scripts\check-ios-skin-browser.js
```

截图/日志：`output/playwright/ios/desktop-light.png`、`desktop-dark.png`、`mobile-light.png`、`loaded-*.png`、`before-*.png`、`results.json`、`after.log`。测试数据只在 output 下。

## 验证边界

页面使用实际业务脚本、CSS、HTML和隔离 null 后端，浏览器拦截内嵌静态资产并替换成当前工作区文件；不据此声称运行二进制已重建。未更改 Rust，未重复跑音频/解码测试；未验证真实声卡、Safari/iPhone 真机、所有自定义主题或系统刘海尺寸。源码在内嵌资源版生效需要重新构建并重启。
