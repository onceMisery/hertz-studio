# 阅读渲染的真实文章验收

2026-10-27 在隔离数据目录中订阅公开源，通过真实服务 API 打开文章；浏览器加载当前工作区的完整 UI。验收前后各检查下列 8 篇，覆盖桌面、网页全屏、390px 窄屏、深浅主题和文章底部。

| 源 | 文章 | 覆盖 |
| --- | --- | --- |
| [少数派](https://sspai.com/feed) | 一日一技｜NAS 作为 UPS 总控，实现局域网多设备断电自动关机 | 纯文字摘要、原文入口 |
| 少数派 | 派早报：iFixit 拆解 iPhone Duo，肯定可维修性但指出内屏隐患 | 连续短段落 |
| [IT之家](https://www.ithome.com/rss/) | 救援尝试失败，NASA 正式终止雨燕空间望远镜任务 | 长标题、中文图文 |
| IT之家 | 华为 Mate 80 系列、Pura X 等机型游戏助手上新，实装弹幕通知、防误触范围自定义等功能 | 五张图片、图注、引用、嵌套列表 |
| [Julia Evans](https://jvns.ca/atom.xml) | Replacing the old battery on rechargeable bike lights | 四张图片、步骤与列表 |
| Julia Evans | Moving away from Tailwind, and learning to structure my CSS | 英文长文、十二个代码块、行内代码 |
| [This Week in Rust](https://this-week-in-rust.org/atom.xml) | This Week in Rust 673 | 宽表格、多层列表、代码与链接 |
| This Week in Rust | This Week in Rust 674 | 长篇周报、287 个链接、多级标题 |

8 篇均能滚动至底部，桌面全屏覆盖视口，窄屏没有文章横向溢出；共 10 张登记图片均经代理加载成功，没有浏览器脚本错误。少数派源实际只提供摘要，按源内容展示，不将它宣称为全文。阮一峰和 Simon Willison 的源本次通过服务拉取超时，未计入通过样本。

实际样本促成的调整：标题平衡换行，正文优先使用系统字体以改善英文标点，表格保留英文单词完整性，图片与相邻图注归入同一 figure，以及收紧嵌套列表间距。

`fragments.html` 保存图注和英文表格的最小真实片段，并加入保留原文的边界用例。确定性回归由 `node scripts/check-reader-browser.js` 执行：检查图注归属、段内文字与既有 figure 保留、图片仍按需加载，以及窄屏表格单词保持完整并在块内滚动。

本轮逐篇截图、源内容快照、结构与滚动测量保存在忽略目录 `output/playwright/reader-real/`；它们是本机验收证据，未提交为公共源的永久可用性保证。
