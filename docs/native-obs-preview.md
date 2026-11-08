# 原生 OBS 歌词预览

2026-11-07 接通现有设置中的 OBS「预览」动作。依据为 desktop-client §7.2，规格与计划见 `aegis/specs/2026-11-07-native-obs-preview-brief.md` 和对应计划。实现与本机正式九组原生验收已完成；尚未据此声明正式发布完成。

原生主窗口等现有浮层只读钥匙就绪后，通过有界请求创建一个预览；再次点击更新样式并聚焦同一窗口。普通浏览器保留同步打开空页、随后导航的已有行为。原生分支退役空页和浏览器 opener，通用 `window.open` 继续拒绝。

预览由主 Tao 循环持有，浏览器资料位于 DataDir 的 `webview/obs-preview`，独立于 `webview/main`。没有主窗口登录 cookie、opener、主初始化脚本、原生 IPC、播放 owner 或系统媒体会话。只读钥匙继续由原有歌词/封面接口校验；这里没有新增业务 HTTP 接口或通用浏览器权限。

各个桌面组件 WebView 也显式持有其原有 desktop 目录 context，不再写进程级 `WEBVIEW2_USER_DATA_FOLDER`。实际歌词设置会启动进程内组件，原生验收必须在这一步之后仍确认 main、OBS 与 desktop 的资料目录分别生效。

预览自己的 WebView 使用现有石墨画布 `#141413`。只读浮层页面仍保留透明 CSS 与四种样式，供 OBS 正常叠加；原生预览用宿主底色衬出浅色歌词。实际截图和 WebView2 默认行为核对发现，未设置宿主底色时会是白底，主歌词对比度约 1.08:1。此次修正在预览 builder 内，不增加主题或浮层配置 owner。

创建和每次后续主框导航都检查实际服务 origin、精确 `/overlay` 路径、当前只读 key，以及一个可选的 full/line/karaoke/minimal 样式。全权 token、ticket、未知或重复查询参数、外部地址、用户名/密码和片段均拒绝。嵌套弹窗、下载和权限请求不开放。这是应用权限边界，不是通用网络隔离器。

请求带当前主文档身份和独立 UUID，实际创建或失败回执才结束前端等待。一个前端请求等待时再次操作会明确反馈；超时可重试，旧回执不能完成新请求。主文档就绪身份由原生固定脚本观察实际页面标记并绑定导航代际，迟到的旧 `host-ready` 或观察回调不能重新绑定旧身份。页面初始化的生命周期就绪消息在确认后重发，避免异步握手吞掉退出能力。

关闭预览只销毁它的 WebView、窗口和独立 context，不改变主窗口位置、音频、托盘或退出确认。主服务停机期间拒绝新预览，主事件循环退出时统一清理。原生外壳使用系统标题栏；设置动作和错误提示复用现有界面，遵循用户指定的 design-taste-frontend 与已有 JS/CSS/token 栈。

当前协议/页面动作七组与 URL 正负例已经验证。最终原生报告应证明真实设置按钮、延迟 key、歌词/封面读取、受限写请求与首页凭据拒绝、无 opener/原生能力、导航/弹窗/下载拒绝、重开与父进程退出清理。证据和候选身份将在完成后追加；其它 OS、签名/安装及更大设计盘点继续单独跟踪。

## 2026-11-07 现场验收停点

优化候选 `78a9d1fe…240b59` 的诊断已通过前三组，实际 main、OBS 和 desktop 资料目录/CDP 端点分离；歌词和封面可读，主窗口凭据、cookie、opener 与原生接口不进入预览，敏感写接口拒绝。该轮因 Windows 防火墙通知持有前台，不能完成复用窗口的焦点断言，见[严格前台前置失败](../output/playwright/native-obs-preview-1794029008239/report.json)。原生测试保留主窗口先成为前台、预览随后获得焦点的完整要求；没有通过放宽断言把它记为合格。

该系统通知是此前运行留下的 `FirewallNotificationDialogServer`，测试不关闭或选择它。已请求用户处理系统弹窗。失败测试的自有进程与 WebView2 均已退出；更早错误 PUT 封面的夹具已按既有 POST 接口修正，不涉及产品接口更改。

同批候选的[几何十一组](../output/playwright/main-window-geometry-native-1794028535736/report.json)、[文件与偏好十一组](../output/playwright/main-window-files-native-1794029149861/report.json)、[生命周期九组](../output/playwright/main-window-lifecycle-native-1794029221776/report.json)、[内嵌桌面六组](../output/playwright/desktop-embedded-1794029261221/verification.json)通过。独立 debug 桌面宿主另有[十五组回归](../output/playwright/wallpaper-works-native-1794029274010/report.json)，检查不再设置全局资料目录环境变量。这些证据支持资料目录修正及相关原生流程，不能替代完整 OBS 九组资格。

石墨预览底色是随后发现的独立视觉修正。[新优化候选](../output/native-obs-preview-backdrop-candidate-20261107-133608/candidate.json) SHA-256 为 `b7dcc992882727b95e33200ee6cb6a97b82be409ce5dde57bdcedd8f79054959`，十四个生产源摘要重算一致；相对上一候选仅 OBS builder 底色变更。定向 URL 测试、Rust 1.88 原生检查与 Clippy 通过。

[新候选诊断报告](../output/playwright/native-obs-preview-1794029804424/report.json)前三组通过，`diagnosisOnly=true`。[实际预览截图](../output/playwright/native-obs-preview-1794029804424/actual-read-only-preview.png)背景像素为 `(20,20,19)`，浅色歌词可读；主服务 PID 6504 正常退出并移除发现记录，受控窗口与 WebView2 已清理，源码和二进制指纹未变。该模式只覆盖前三组、截图和正常清理，不能替代正式资格；默认正式模式仍保留所有前台条件、九组检查并标记 `diagnosisOnly=false`。

## 2026-11-07 正式九组已通过

用户处理先前系统弹窗后，[正式报告](../output/playwright/native-obs-preview-1794032126388/report.json)完成全部九组，`diagnosisOnly=false`。此次使用加入[音乐选择导入](native-music-import.md)的[独立 Full/native debug 候选](../output/native-music-import-candidate-20261107/candidate.json)，SHA-256 `b204cfc32452dff6b3610f727bf1e9106ddce85dd86088e38cfb2a4fc8dbc6fa`，原生预览底色与隔离实现沿用已审查版本。旧 52 组和 b7 优化候选诊断保持原身份，没有改记成此版本通过。

实际设置动作等待只读钥匙、四种样式重用同一个前台预览；受限 origin/path/query、后续导航、弹窗、权限和下载均通过；当前与旧文档回执隔离、辅助窗口关闭/重开与父进程清理均通过。PID 19724 以 0 正常退出并移除发现记录，源码／二进制在运行期间未变。

夹具的前台准备现在通过严格检查 PID/HWND/标题和鼠标落点的真实标题栏点击，仍断言主窗口先为前台、预览随后聚焦，不操作外国窗口。WebView2 活浏览器会独占 History，下载资格改为关闭受控预览和 context 后只读检查该全新 profile 的全部下载行；仍要求无原生保存对话框、无完成下载或已写目标。启动等待改为显式读取 window 属性，避免首跳重定向期间未定义标记抛错。这些修正只涉及验收夹具。

此报告覆盖本机原生预览资格，不证明实际 OBS 安装、物理输出设备、其它 OS、签名、净系统或完整桌面产品发布。随后另一个候选产生的新防火墙提示属于音乐 OLE 验收，不能撤销或延伸本报告的九组结论。

## 原生 HTTP 策略候选的正式九组

2026-11-07 [同进程原生HTTP边界](native-http-boundary.md)启用后，在固定8af3 Full/native debug候选重新执行[正式九组](../output/playwright/native-obs-preview-1794046947110/report.json)：`diagnosisOnly=false`、exit0。真实前台准入、四样式聚焦复用、独立只读预览、后续导航/弹窗/权限/下载、主文档重载及旧回执、子窗口关闭重开和父进程清理均通过。

只读复核确认旧安全中心HWND38733436已销毁，两个PickerHost窗口列表为空，随后恢复正式测试。测试没有操作系统提示。PID19068退出0、移除发现记录，十六份来源与8af3归档/运行摘要一致；[身份/清理复核](../output/native-http-obs-formal-verification-20261107.json)通过。[实际预览截图](../output/playwright/native-obs-preview-1794046947110/actual-read-only-preview.png)已查看，石墨底色与歌词对比度保持。

同候选前三组诊断1794044954769保留其旧诊断范围，b204九组和其它旧候选也保持原身份。此轮是实际原生预览/CSP兼容资格，不证明安装OBS软件、真实设备、净系统/签名、其它OS或完整目标。

## 当前 release 的前台验收边界

新的[优化release85ab](../output/native-http-release-current-candidate-20261107/candidate.json)已通过HTTP十二组、包入口五组、NSIS十八组和原更新器八组，见[候选复核](../output/native-http-release-final-verification-20261107.json)。其[正式OBS九组](../output/playwright/native-obs-preview-1794052272976/report.json)现已通过：diagnosisOnly=false、45937终态exit0；十六份来源与release85ab一致，PID16792正常退出并移除发现，实际预览及设置按钮截图已查看。[安全中心解除](../output/native-http-release-security-resolution-20261107.json)与[身份/清理复核](../output/native-http-release-foreground-qualification-20261107.json)通过。外部OBS自身及其它环境仍须分别取得资格。

8af3 debug正式九组保持通过，与该新release停点分别记录。障碍解除后沿用固定C release路径及`HERTZ_OBS_DIAGNOSIS_ONLY=0`进行正式资格，不重新跑旧debug检查或把诊断改记为正式。
