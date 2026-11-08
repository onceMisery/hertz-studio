# 原生音乐文件与目录导入

2026-11-07 已在 Windows 原生主窗口实现文件选择与音乐文件／目录拖入，依据 desktop-client §7.2 和继续完成剩余能力、不走 TDD 的用户要求。界面参考用户指定的 design-taste-frontend，沿用现有 JS/CSS/token 与曲库导航，不引入框架或新播放 owner。

在曲库的音乐目录面板中可选择文件，也可向主页面拖入文件或目录。请求开始时转到曲库并展开面板，准备状态、错误与原有扫描进度、取消、结果均可见。浏览器和 DBX 隐藏该原生入口。只有宿主完成当前文档确认后才显示能力，避免初始化期间的请求丢失。深浅主题、375px 布局与减少动态效果均有浏览器验证。

文件只收录本次选择，不扩展为父目录扫描；目录递归查找其中的音乐。一次最多 256 个所选对象，嵌套目录与重复文件按规范路径去重。导入不自动播放、不写队列、不登记持续同步目录，也不删除未选中的旧歌曲。持续同步仍通过原有“添加并自动同步”入口登记。

`scan.rs` 是唯一业务 owner：新增选择模式仍使用既有扫描互斥、元数据、封面编辑保护、ReplayGain、批量事务、进度、取消和库变更通知。选择扫描的 `root` 为 null，没有删除范围或目录历史写入。完整目录扫描保留原有过期歌曲删除规则。非音乐扩展名忽略；无效位置、不可读取与损坏音频进入有界失败明细。直接 UNC 在文件系统读取前拒绝，目录遍历仍不跟随链接。

WebView2 的 `postMessageWithAdditionalObjects` 只传真实 File 对象；原生从 `AdditionalObjects` 的 `ICoreWebView2File.Path` 取路径。JSON 的路径字符串不能取得导入权限。原生 adapter 只在主 origin 接收有界消息，在同一个 WebView STA 保留至多一个待处理事件；当前已确认文档、生命周期与已有请求准入通过后才取文件路径。异步回执绑定文档和请求 ID。没有新增 HTTP 导入接口、shell 命令、解析器或数据库 owner。

没有使用 Wry `with_drag_drop_handler`：0.57 在 Windows 上会禁用 HTML DnD。新增 UI 仅捕获 Files 的拖入／放下事件，文本及内部队列拖动继续原样运行。真实鼠标队列排序，以及外部 File 放到队列行时只导入、保持顺序，均有浏览器证据。

## 当前证据

| 范围 | 结果与证据 |
| --- | --- |
| 业务扫描 | [16 项](../output/native-music-import-scan-final.log)：精确文件不扫兄弟、不删除缺失旧项、重复导入身份、目录重叠、失败与取消／准入，以及原有目录扫描回归 |
| 原生宿主与资源 | [21 项](../output/native-music-import-bin-reviewed.log)通过；包括 typed 请求、文档及生命周期、资源嵌入 |
| 前端 | [75 步](../output/native-music-import-frontend-final-verified.log)通过；[七组浏览器](../output/playwright/native-music-import-browser-1794031524246/report.json)包含实际鼠标队列排序、文件落在队列行、深浅主题与窄屏 |
| 实际 WebView2／Windows OLE | [最终候选十组](../output/playwright/native-music-import-1794037107916/report.json)通过：真实文件／目录对象、精确范围与身份、权限反例、损坏音频、原目录扫描回归，以及真正的 Windows OLE 文件／目录拖放；宿主正常退出并移除发现记录 |
| 编译与检查 | [Rust 1.88](../output/native-music-import-msrv-verified.log)、[Clippy](../output/native-music-import-clippy-final.log)通过。仅沿用三个既有命令级豁免，没有新增代码豁免 |
| 独立静态审查 | [审查记录](aegis/work/2026-11-07-native-music-import/30-review.md)：隐藏失败、读取路径前准入和确认前能力显示三处问题已修正，七项架构维度无剩余行动项 |

[最终 Full/native debug 候选](../output/native-music-import-final-candidate-20261107/candidate.json) SHA-256 `5a5cfefe83b7d41c796677415b50b8f65a8698c5319d0813e407faa5dd5982d8`。它通过 Cargo `rustc -o` 生成独立输出，以保留另一个正在使用默认 debug exe 的进程；两个输出命名提示由此产生。业务／UI 源码和二进制在原生验证期间摘要不变。前一个 `b204cfc3…bc6fa` 候选的[OBS 正式九组](../output/playwright/native-obs-preview-1794032126388/report.json)独立记录，不将旧候选或旧报告改记为新版本。

## Windows OLE 实际拖放

WebView2 对象证据通过 CDP 的 `DOM.setFileInputFiles` 提供磁盘 File／目录对象；Playwright 高层文件输入在此远程上下文构造的是内存 File，会被 WebView2 拒绝。这是夹具来源的区别，不是路径字符串后门。

用户已处理先前的系统弹窗。[最终十组报告](../output/playwright/native-music-import-1794037107916/report.json)为 `passed=true`、`ole=true`、退出码 0、`graceful=true`。受控源窗通过真正的 Windows OLE FileDrop 向主窗口拖入音乐文件和目录，两组实际拖放均经既有扫描 owner 完成；发现记录已移除，候选 exe 与生产来源摘要未变。

[源夹具](../scripts/native-music-drag-fixture.ps1)在源窗与驱动线程都设置并检查 PMv2 DPI 上下文，使用主窗口旁的独立可见源窗。鼠标输入前及落点处检查精确 HWND、PID、实时物理矩形与覆盖关系，不点击系统提示。只有实际按住鼠标后才执行释放。

此前的[严格覆盖拒绝](../output/playwright/native-music-import-1794032274101/report.json)、[首次续接](../output/playwright/native-music-import-1794032828186/report.json)及[有界等待超时](../output/playwright/native-music-import-1794032972913/report.json)保留为当时的诊断。它们不代表当前仍需处理旧弹窗，最终通过报告已覆盖该停点。

这份证据来自自有 Windows OLE 源窗，尚未证明 Explorer 本身、其它 shell、其它 OS 或正式安装／签名。原有[完整 Full/native Rust 回归](../output/native-music-import-full-rust.log)为主库 1005 通过、7 个既有忽略，主程序 21 通过；不将这些结果扩展为整个桌面产品完成。

## 2026-11-07 原生 HTTP 候选兼容增量

新增HTTP边界的8af3 Full/native debug候选已完成[同候选音乐十组](../output/playwright/native-music-import-1794047526294/report.json)：真实文件/目录对象、导入范围与身份、权限反例、损坏音频、原目录扫描，以及来自自有源窗的实际OLE文件/目录拖放均通过。报告为passed=true、ole=true、exitCode=0、graceful=true。十份来源摘要和归档/固定C运行摘要一致，PID17352正常退出并移除发现，既有PID6428保留，见[身份与清理复核](../output/native-http-music-compatibility-verification-20261107.json)。

该增量验证新增HTTP策略与原生音乐路径的兼容，旧5a十组保留原身份。当前8af3的HTTP十二组、OBS正式九组和本次音乐十组各自记录；Explorer本身、release安装包、签名、净系统与其它OS继续单列。

当前另有[release85ab的构建/HTTP/ZIP/NSIS资格](desktop-release.md#当前源码优化-release-候选增量)，[release音乐对象/受控OLE十组](../output/playwright/native-music-import-1794052375672/report.json)现已通过，ole=true、exit0。十份来源与release85ab一致，PID13812正常退出并移除发现，错误展示截图已查看；[身份/清理复核](../output/native-http-release-foreground-qualification-20261107.json)通过。旧安全中心已实际消失。Explorer新增资格见下节，旧8af3十组保留原身份。

## 当前release的真实Explorer与同进程宿主增量

[Explorer五组](../output/playwright/native-music-explorer-1794053562171/report.json)实际从Windows Explorer拖入单文件、重复文件和目录，三个原生回执均accepted；精确范围、重复身份及嵌套目录收录通过，持久曲库只有预期三首。[同进程宿主六组](../output/playwright/desktop-embedded-1794053789399/verification.json)验证三个启停周期、每轮16并发命令、活跃维护拒绝、退出释放及主窗口保留；未启动外部hertz-desktop.exe。[独立复核](../output/native-release-explorer-embedded-verification-20261107.json)确认721来源、release85ab运行/归档、持久库内容和正常退出/发现移除，无测试窗口/进程残留，实际界面截图已查看。原受控OLE、旧候选和失败诊断保持原身份；其它shell、外部OBS、真实DBX PluginHost/工作台、可选组件、签名/净系统/物理设备/其它OS及完整目标仍分别开放。
