# 受控界面偏好迁移

设置页的「数据备份 → 界面偏好」可在浏览器、Windows 原生主窗口与 DBX 之间导出/导入已知页面偏好。选择文件后先查看当前值和将导入的值；取消不写入。确认应用后，现有舞台与预置库保存完毕、目标宿主确认偏好持久化，再重新加载页面。普通歌单/收藏/服务设置 JSON 备份仍保持原 v1 契约。

## 文件与归属

独立文件使用 `kind: hertz-ui-preferences`、文档 `schemaVersion: 1`，以及 `preferences` 数组中的 `{key, schemaVersion:1, value}`。UTF-8 文件最多 64 KiB、32 项。首版登记18项：主题/自定义三色/布局、启动页/歌单排布、首页推荐与每日推荐的来源/折叠/排布、阅读字号/字体/明暗、二维歌词模式/舞台参数、封面墙六项偏好。未知键、字段、版本、重复项、类型、原型属性和越界值整体拒绝。

导出只读取登记的主键，不枚举 localStorage。凭据、账号、搜索/房间/播放历史、在线缓存、OBS 资源、窗口坐标与胶囊状态、运行中计时器、本地素材/工程引用不进入文件。三维舞台、服务设置、歌词/壁纸配置继续由原服务或组件持有。本功能不扫描或复制浏览器/WebView profile。

`UiPreferences` 只拥有传输校验，不成为第二份偏好数据库。Theme、ThemeStudio、Skins、StageControl 和 app 对应 owner 校验值、派生一次性迁移标记；外部文件不能单独写这些标记。舞台当前版本的 enabled=false 与现有参数保留，不被旧默认值迁移改写；coverSize 已无当前控件和消费端，外部文件继续按未知字段拒绝，其无效历史迁移行已退役。自定义颜色的浮点 RGB 量化由同一 owner 保证最终 HEX 亮度边界；旧 owner 可产生的半个色值步长舍入误差向下归一化，真正亮底仍拒绝。

## 保存与失败

文本导出统一进入 `hertzHost.saveTextFile`。JSON 备份、M3U 与诊断文件复用该入口。普通浏览器和 DBX SDK 只报告已发起保存；Windows 原生使用当前主窗口作为 IFileSaveDialog 父窗口，实际文件完成回执才报告已保存。用户取消与对话框创建错误分开处理，覆盖由系统确认；不可访问的路径由系统提示并允许重选。Wry 只允许当前服务或其 blob origin，旧页面 blob 回执不能完成新页面任务。

DBX 首次读取失败时只保留临时界面，不允许默认值覆盖尚未读出的宿主数据；重新加载后成功 hydrate 才能迁移。flush 串行提交最新快照并等待 SDK。应用前保存所有目标旧值；失败只恢复本次目标且保留等待期间其它键的新修改。恢复提交仍失败会明确显示尚未确认，不刷新页面，不宣称断电或多进程事务资格。

工坊的素材导入、选择与恢复任务从事件开始到背景保存收尾持续登记。它们未完成时，偏好应用拒绝重载并允许稍后重试；DBX 偏好写入返回后再次等待舞台/预置库保存。后置保存失败时提示偏好已保存、页面暂不刷新，重试只确认舞台再重载；录制期间保持当前页面。

## 界面与验证范围

UI 按用户指定的 design-taste-frontend 参考现有设置语言：左侧说明、右侧操作，窄屏收敛单列，每项当前值/导入值纵向呈现；主题令牌、明确焦点、状态行与减少动态效果偏好保持。使用原生 JS/CSS，无新增前端框架或运行依赖。

验证入口：`node scripts/check-ui-preferences.js`、`scripts/check-ui-preferences-browser.js`、`scripts/check-main-window-files-native.js`。真实浏览器/DBX 与 Windows 候选的最终结果、源文件摘要、原生范围和清理记录统一保存在[本次工作证据](aegis/work/2026-11-07-ui-preference-transfer/90-evidence.md)。macOS 对话框错误/取消仍受 rfd Option 表示限制，Linux 本次不提供原生文件选择；这些平台没有沿用 Windows 运行资格。NSIS、签名、净系统、多 DPI、真实设备与其它设计缺口继续按总盘点跟踪。

## 2026-11-07 最终候选验证

设置入口为 Hertz 侧栏「设置 → 工具 → 界面偏好」。[最终原生报告](../output/playwright/main-window-files-native-1794024553670/report.json)十一组全部通过，使用同一 Full/native 优化候选：实际系统保存框、UTF-8/中文/CRLF 字节、取消/覆盖/路径错误/文件占用重试、真实备份按钮、外部下载拒绝与旧回执隔离，以及从 A 导出到全新 B WebView 后的预览、取消、应用重载和同源进程重启。主题 celestial、歌单 shelf、舞台 enabled=false/bokeh=5 和 owner 迁移标记在重启后保留；退役 coverSize 在写入前拒绝。三次测试启动均正常退出，两个发现文件已移除。

[浏览器报告](../output/playwright/ui-preferences-browser-evidence.json)七组通过，覆盖双 HTTP origin、opaque DBX、17 类错误文件、提交失败恢复、晚到舞台保存和工坊任务。1440/720/360 的六张截图无横向溢出、页面/渲染异常为零；[桌面设置截图](../output/playwright/ui-preferences-setting-1440.png)与[窄屏预览](../output/playwright/ui-preferences-preview-360.png)保留当前 UI。协议92/宿主8、默认前端74、原生主程序18、Rust 1.88 与 Clippy 通过，Clippy 只沿用既有三类基线豁免。

实际验收保留 WebView2 默认下载管理器，并使用真实按钮点击。纯脚本连续下载会触发浏览器的多下载门控；该诊断没有扩大产品权限、复制 profile 或更改用户浏览器设置。原生范围为本机 Windows/WebView2、null 音频、B 同源重启；程序、来源与报告摘要保存在上述工作证据中。
