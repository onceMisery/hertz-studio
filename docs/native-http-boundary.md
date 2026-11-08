# 原生主窗口的 HTTP 边界

2026-11-07 已在同进程 `hertz-studio --window` 路线落实 [桌面产品目标 §8.2](desktop-client.md)。HTTP 装配仍由主程序负责；入口票据、session、Bearer、OBS 只读 key 和 WS ticket 继续由既有路由验证。普通 HTTP/LAN 服务与 DBX stdio 保持原有契约。

## 使用与请求准入

原生模式的有效 bind 必须精确为 `127.0.0.1`。CLI、环境变量和配置文件中的其它值会在生成凭据、业务启动和监听之前明确报错；`localhost` 与 IPv6 回环也不作为别名接受。普通服务继续支持配置 LAN 地址。

策略使用 listener 实际端口，支持 `--port 0`。Host 必须匹配 `127.0.0.1:<实际端口>`，80 端口允许省略端口；缺失或重复 Host、别名、错误端口及冲突的 absolute-form URI 返回 421。出现 Origin 时必须精确匹配实际 HTTP origin；重复、`null`、外部 origin 或协议/端口不符返回 403。

门禁在路由 extractor、票据兑换及业务副作用之前执行，也覆盖 WS 升级。缺失 Origin 保留非浏览器客户端路径，后续路由仍要求原有有效凭据；拒绝的请求不能消耗入口或 WS 票据。

## 页面与资源策略

原生首页、凭据恢复表单和 OBS HTML 由可信编译模板显式渲染，每次生成随机 nonce，并发送 CSP、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY` 和 `X-Content-Type-Options: nosniff`。只有模板中确切的内联 script 标签获得 nonce；token 使用 JSON 字符串和 script 终止字符转义，不授权读者或用户正文中的脚本。

脚本限同源及 nonce，禁用事件属性脚本、frame、object 和 base，表单限同源。连接限同源、实际 WS 地址、Blob/Data；图片和媒体保留现有 HTTP/HTTPS 与 Blob/Data，远程图片不发送 Referer。字体限同源/Blob/Data。

本地 Pixi 的函数生成仍需要 `unsafe-eval`，其 Worker 仍需要 Blob；动态主题仍需要 inline style。这些是已验证的现有消费者权限，CSP 不能据此隔离获授权脚本自身的漏洞。原生窗口导航/能力限制及 OBS 独立只读预览仍由原 owner 管理。

## 固定候选与验证

[当前 Full/native debug 候选](../output/native-http-boundary-current-candidate-20261107/hertz-studio.exe) SHA-256 为 `8af3e3f40072c7c90a36686a0cf3995c60c22d2ec300cbb12f3f2413fbeffb93`，build ID 为 `c158b1f40ccedde0773e6544aacb8b694fd0a56bb0b9f4b1654e9d9306dd32bc`。实际运行路径固定为 `C:\Users\miracle\.cache\hertz-native-http-20261107\debug\hertz-studio.exe`，与归档逐字节一致。

| 证据 | 结果与范围 |
| --- | --- |
| [主程序测试](../output/native-http-rust-tests-current-20261107.log) | 26 通过，0 失败；覆盖请求准入时序、副作用保护、随机 nonce 和 token 转义 |
| [当前构建](../output/native-http-build-current-20261107.log)／[普通无默认 feature 检查](../output/native-http-ordinary-check-fixed-20261107.log) | 两者 exit 0；修正生命周期引用的 native-window 条件编译范围 |
| [当前源编译资格复核](../output/native-http-build-qualification-20261107.json) | Rust1.88 Full/native all-targets 与 Clippy all-targets exit0；Clippy只沿用三类已有命令级基线豁免，十五份HTTP来源摘要及固定运行二进制保持一致 |
| [当前 Full DBX/HTTP 兼容复核](../output/native-http-dbx-compatibility-verification-20261107.json) | 当前DBX构建及Rust1.88 all-targets通过；8组真实SDK/HTTP/原生恢复接口检查exit0，不发布DBX HTTP/WebView资料、SDK可用、EOF/失败/崩溃释放锁，来源与候选摘要一致、自有进程已退出。恢复接口检查不代替OS前台聚焦或完整DBX宿主资格 |
| [HTTP 运行报告](../output/playwright/native-http-boundary-1794044751270/report.json) | 12 组通过，exit 0；实际 Windows WebView2、Chrome 157、随机端口、CLI/环境/配置拒绝、票据未消费、现有凭据/WS、恢复表单、OBS 只读 HTML、CSP 阻断、Pixi/Blob/style、无 Referer 远程图片、网络发送前阻断跨源 fetch，以及普通 LAN 行为 |
| [当前原生 OBS 正式资格](../output/playwright/native-obs-preview-1794046947110/report.json) | `diagnosisOnly=false`，九组通过、exit0；真实前台输入/四样式聚焦复用、只读读取、导航/弹窗/权限/下载、旧文档隔离及父子窗口清理。PID19068正常退出0并移除发现，源/候选摘要一致 |
| [同候选历史 OBS 诊断](../output/playwright/native-obs-preview-1794044954769/report.json) | `diagnosisOnly=true`，前三组通过；仍保留原诊断范围，正式九组由上行新报告证明 |
| [同候选音乐兼容十组](../output/playwright/native-music-import-1794047526294/report.json) | 实际WebView2文件/目录对象、权限与扫描行为、来自自有源窗的Windows OLE文件/目录拖放通过；exit0、graceful=true，PID17352正常退出并移除发现。十份来源与固定8af3身份一致，Explorer本身及release包另计 |
| 静态与只读审查 | JS 语法、296 项脚本登记、相关 Rust 格式、同进程 owner 11 组通过；两轮 scoped 审查无剩余 P1/P2 |

HTTP 报告记录的源码摘要与当前来源一致，归档/运行二进制摘要一致，六个测试自有进程均已退出。已有程序和证据保留。第一轮 SHA45e1 的十二组报告保持旧身份，不能替代本表当前候选。

本轮 [Full DBX 候选](../output/native-http-dbx-current-candidate-20261107/candidate.json) SHA-256 `e77821a17c3a4baefec51bf1ca0b5b1e4aec2ff547dba6a896a9e3096031a361`，与当前8af3原生服务配对执行[8组报告](../output/data-owner-1794046590539/report.json)。使用当前源码和隔离资料/null音频；旧DBX、OLE和NSIS候选保持原身份。

原系统安全中心窗口已在只读复核中确认消失，随后同一8af3候选完成正式OBS九组，见[身份/清理复核](../output/native-http-obs-formal-verification-20261107.json)。前一个b204候选的九组保持原身份，旧诊断不改记为正式资格。新HTTP候选不继承旧OLE/NSIS或发行资格；签名与远端更新源、净系统/离线运行时、物理设备/多DPI、其它OS和完整设计盘点仍开放。

复现：设置 `HERTZ_BIN` 为上述固定运行路径，设置 `PLAYWRIGHT_MODULE` 为已有 Playwright 安装路径，`PLAYWRIGHT_BROWSER_EXECUTABLE` 为已有 Chrome，再运行 `node scripts/check-native-http-boundary.js`。完整 OBS 运行 `node scripts/check-native-obs-preview-native.js`，使用 `HERTZ_OBS_DIAGNOSIS_ONLY=0` 和已有 Python；仅在前台障碍解除后执行。报告保留隔离 DataDir 与候选/来源摘要，清理仅作用于本脚本自有进程。

## 当前优化 release 与包内运行

配套优化Full插件现在另有[release9418候选](../output/native-http-release-dbx-current-candidate-20261107/candidate.json)及[release85ab配对复核](../output/native-http-release-dbx-compatibility-verification-20261107.json)：SDK/HTTP八组terminal/exit0，721份构建输入与报告来源保持，运行/归档身份一致、自有进程退出及原生发现移除。此前e778是debug插件，原报告保留；新证据不扩展为完整DBX PluginHost、桌面组件或当前release正式OBS/OLE。

[当前Full/native release](../output/native-http-release-current-candidate-20261107/candidate.json) SHA-256为 `85ab5e2d00ed88e31a9bb775d382a98211d9a65deb2131c6c45d42e0ef2ce46f`，build ID为 `8857d0304c9e6fa16097b78167cc8b3ef54ec77b2af8fba1ec024301504b3b5e`。固定运行路径为 `C:\Users\miracle\.cache\hertz-native-http-20261107\release\hertz-studio.exe`，归档一致；720份生产输入在构建前后及当前来源未变化。保持原release优化、thin LTO与panic abort设置。

| 证据 | 结果与范围 |
| --- | --- |
| [实际release UI](../output/native-http-release-ui-current-20261107.log) | 153项identity/gzip、全局变量/来源保留、许可证、生成摘要与CSP/预算通过 |
| [HTTP](../output/playwright/native-http-boundary-1794048283363/report.json) | 十二组terminal/exit0；压缩UI、WebView2/Chrome、nonce/CSP、WS与普通LAN |
| [解压入口](../output/playwright/standalone-package-1794048330342/report.json) | 五组terminal/exit0；特殊字符路径、无Cargo/Node PATH的实际CMD启动、复用、正常退出与字节保留，截图已查看 |
| [当前用户NSIS](../output/nsis-installer-native-1794048467662/report.json) | 新setup2686/程序85ab十八组terminal/exit0；安装/卸载/资料保留与各类故障/中断恢复 |
| [本地更新器](../output/install-owner-1794048535341/report.json) | 八组terminal/exit0；默认更新路径、占用、完整标记与显式恢复 |
| [配对Full DBX](../output/data-owner-1794048953415/report.json) | 85ab与既有Full debug插件e778的SDK/HTTP八组terminal/exit0；不代替Full PluginHost或实际前台聚焦 |

[来源、身份与清理复核](../output/native-http-release-final-verification-20261107.json)通过，全部本轮handles终态，NSIS登记/快捷方式与测试自有进程已清理，既有PID6428保留。程序、ZIP与NSIS均为本地NotSigned候选；旧8af3/5a/b204/4f10/8ebb证据保留原身份。

当前release85ab现已完成[正式OBS九组](../output/playwright/native-obs-preview-1794052272976/report.json)与[音乐对象/受控OLE十组](../output/playwright/native-music-import-1794052375672/report.json)，分别diagnosisOnly=false和ole=true、均exit0。[身份/退出复核](../output/native-http-release-foreground-qualification-20261107.json)确认721输入、16/10来源、归档/运行一致，测试PID正常退出并移除发现。[原安全中心](../output/native-http-release-security-resolution-20261107.json)已实际消失。其它shell、外部OBS、完整PluginHost/组件、签名/更新源、净系统、物理设备/其它OS仍单列；A07/A10/M0设计待明确审阅批准，完整目标保持。

## 当前release的真实Explorer与同进程宿主增量

[Explorer五组](../output/playwright/native-music-explorer-1794053562171/report.json)实际从Windows Explorer拖入单文件、重复文件和目录，三个原生回执均accepted；精确范围、重复身份及嵌套目录收录通过，持久曲库只有预期三首。[同进程宿主六组](../output/playwright/desktop-embedded-1794053789399/verification.json)验证三个启停周期、每轮16并发命令、活跃维护拒绝、退出释放及主窗口保留；未启动外部hertz-desktop.exe。[独立复核](../output/native-release-explorer-embedded-verification-20261107.json)确认721来源、release85ab运行/归档、持久库内容和正常退出/发现移除，无测试窗口/进程残留，实际界面截图已查看。原受控OLE、旧候选和失败诊断保持原身份；其它shell、外部OBS、真实DBX PluginHost/工作台、可选组件、签名/净系统/物理设备/其它OS及完整目标仍分别开放。

## 当前Full真实PluginHost与配套组件包

[真实PluginHost四组](../output/native-release-full-pluginhost-20261107/verified.json)使用release9418，在0.6.47及最低0.6.35分别验证未授权/已授权、基础SDK、当前20a30e组件要求和歌词/壁纸管道身份快照。[配套组件f030](../output/native-release-desktop-component-current-candidate-20261107/candidate.json)已release构建并生成[manual ZIP](../output/native-release-desktop-component-current-candidate-20261107/package/hertz-desktop-0.3.2-preview-windows-x64.zip)，[独立复核](../output/native-release-dbx-component-verification-20261107.json)确认721生产输入、51/50宿主本地来源、四文件包内manifest/exe/许可证/安装说明、候选摘要和测试进程退出。实际DBX stop终止进程树；两份发现文件保留且原PID已不存在，不把API停止成功改记为自然退出/发现移除。下一步须在该原生组件验证旧发现拒绝、真实live绑定、两scope呈现、来源切换与退出；Standard、完整工作台、D3b、签名/净系统/设备及其它OS仍独立开放。原版本夹具失败和旧报告保留；A07/A10/M0待审、不走TDD。
