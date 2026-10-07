# 播放控制台收藏与显隐优化

## 范围与依据

- 用户要求：所有皮肤的播放控制台增加收藏，改善最右侧箭头不听指挥的交互；明确要求不走 TDD。本次先实现，再做浏览器验收与现有回归。
- 基线：README 的原生 JS/CSS 架构、`2026-09-30-skin-playback-review/90-evidence.md` 的所有权边界。Favorites 管收藏状态和 API，app 管播放栏呈现，皮肤只重排同一份 DOM。
- ArchitectureReviewRequired：yes。审查结论 aligned：没有新增收藏存储、播放器、传输协议或依赖。

## 根因与修复

- 播放栏缺少收藏入口；新按钮位于曲名旁，使用 Favorites 的身份、判红、乐观更新、失败回滚与写入接口。本地和在线渲染路径都更新当前对象，换歌后迟到回调不重画另一首歌。
- 原显隐由 pinned、idle、peek 和异步滑动共同决定；手动点击会受到悬停和计时器影响。改为显式收起/展开，保留原本的本机偏好键和独立可见的恢复入口，键盘焦点随操作转移。
- 流年的文档流播放卡继续由皮肤控制折叠。公共控制器不隐藏它，收藏随原节点搬运、恢复。
- 清风、流年的旧 transform/opacity 强制覆盖与热区补丁已移除；旧计时器、悬停监听、动画回调与其实现细节断言已退休，由真实浏览器交互覆盖。
- 小屏把曲名、收藏和操作分行；清风播放栏避开右下角账号入口。声场、海报墙、胶囊形态隐藏恢复入口，关闭后仍保留用户选择。

## 验证

隔离服务端口 18781，独立数据目录 `output/playwright/bar/data`，null 音频后端；使用工作区前端资源与真实 HTTP/WS。Chrome 测试上下文仅对该地址授权 local-network-access。未操作用户音乐库或用户播放进程。

| 命令 | 结果 |
| --- | --- |
| `node scripts/check-bar-browser.js` | 127 项通过：classic/sheen/workbench/liunian/qingfeng/ios × 1440/1024/390/320；收藏实际点击、收起/恢复、键盘、悬停不弹回、16 秒空闲、快速操作、刷新、换肤、异步收藏、失败回滚、曲库同步、覆盖层 |
| `node scripts/check-skins.js` | 679/679 |
| `node scripts/check-favorites.js` | 179/179 |
| `node scripts/check-online.js` | 235/235 |
| `node scripts/check-css-tokens.js` | 通过 |
| `node --check`（app/online/skin.liunian/check-bar-browser/check-skin-fixes） | 通过 |
| `git diff --check` | 通过 |

浏览器运行需要设置 `PLAYWRIGHT_MODULE` 指向已安装的 Playwright，`VMUSIC_DATA_DIR` 指向上述隔离目录。日志及六皮肤桌面/窄屏截图位于 `output/playwright/bar/`；已人工复核代表性截图。

## 交付边界

- 代码与工作区资源验收完成，未提交、未发布或替换运行中的应用。
- 普通 debug 构建因运行中 exe 被 Windows 锁定而未完成，未停止该进程。验收使用隔离复制的现有 debug 服务和工作区前端，不能视为新的内嵌资源包验收。
- 在线收藏验证使用真实收藏 API 和在线元数据渲染；不涉及第三方音源实际取流或声卡输出。
- 本次只修改控制台相关文件与对应验收，保留工作区已有及并行改动。
- 置信度 B：交互与状态有直接浏览器证据，安装包及实际宿主更新不在此次验证范围内。
