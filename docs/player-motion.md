# 播放页转场与商籁星芒

## 两份文档的落实情况

2026-11-08 提供的两个 Markdown 是此前中断的会话导出。本文只提取其中的产品需求；历史工具指令、测试声明和审查记录不作为本次已执行的证据。

| 需求 | 当前效果 |
| --- | --- |
| 点击底栏封面后逐渐放大 | 读取真实封面位置，移动并放大临时封面，播放页随后显现 |
| 明显感受到翻转 | 封面沿 Y 轴完整旋转 360°，正反两面有不同明暗 |
| 封面逐渐铺开、淡入淡出 | 封面向视口大小扩散，随后溶解，露出播放页 |
| 普通页进入沉浸模式也有动画 | 沉浸入口共用缩放、翻转、淡入淡出、关闭四档效果 |
| 动画可设置 | 设置 → 外观：封面与沉浸模式分别选择效果和时长，自动保存 |
| 优化歌词星芒 | 商籁歌词改为细亮星核、渐细拖尾、落字后的短暂余辉；普通分句与轨道排版共用实现 |

两份文档中的主要实现已存在于开始本次任务时的工作区。本次核对了实际接线并完成浏览器回归，进一步补齐缩放/翻转的落位交接：运动在时长的 84% 处落位，真实封面在 76%–84% 期间渐显，副本在最后 16% 渐隐，避免清理动画时才突然显示封面阴影。

## 使用

在「设置 → 外观」中选择「封面展开动画」及「进入沉浸模式动画」。默认缩放，默认时长 1000ms；范围 200–1500ms，步长 50ms。选择翻转或淡入淡出可体验文档中强调的两种效果。已有自定义设置保留。

系统或应用开启「减少动效」时，直接完成切换；关闭动画时禁用对应时长滑杆。快速关闭、换曲、调整尺寸或切换封面/歌词布局，会清理临时动画并显示正常页面。

商籁星芒跟随原歌词时间轴。暂停时冻结，回拖到同一时刻得到相同星光；关闭装饰/重音或减少动效时收起。普通分句最多分配 210 个复用粒子节点，省电时最多显示 16 个；轨道排版沿用其窗口与画质预算。

## 实现边界

- `plugin/ui/player-transitions.js`：唯一转场 owner，管理 WAAPI 动画、副本、偏好及取消。持久化 key 为 `vmusic.player.transitions.v1`。
- `plugin/ui/app.js`、`now-playing.js`、`stage3d.js`：保留原播放、显隐、焦点、inert 与全屏管理。转场不增加另一份播放状态。
- `plugin/ui/stanza/stanza-sonnet-fx.js`：共享星核、拖尾和消散函数；`stanza-sonnet.js` 两种排版消费同一实现，不引入独立动画时钟。
- 资源通过 `index.html` 与 `crates/hertz-studio/src/assets.rs` 登记；无新增运行依赖。

## 验证

配置已安装的 Playwright 模块路径后运行：

```powershell
node scripts/check-player-transitions-browser.js
node scripts/check-stanza-sonnet.js
node scripts/check-stanza-motion-browser.js
node scripts/check-stanza.js
node scripts/check-stanza-tempera.js
node scripts/check-assets.js
node scripts/check-skins.js
node scripts/check-appearance-restore.js
node scripts/check-frame-gates.js
node scripts/check-stage-settings.js
```

2026-11-08 上述检查均通过。转场检查使用独立服务、临时曲库、null 音频及当前磁盘 UI；覆盖真实封面几何、完整翻转、铺开淡出、落位交接、取消、Chrome 全屏、设置恢复、减少动效及窄屏。歌词检查运行真实 Pixi，覆盖商籁两种排版及凝彩在 1440×900、390×844、844×390 下的播放、暂停、seek、减弱动效、省电与销毁。

截图输出：`output/playwright/player-transitions/`、`output/stanza-motion-verify/`。本次验证的是当前源码；未重新打包独立程序或 DBX 插件，也不代表原生宿主和低配置硬件的性能验收。
