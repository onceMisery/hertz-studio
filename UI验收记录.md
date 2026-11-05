# HertzStudio 中文 UI 验收记录

## 2026-11-05：替换原项目

新版已迁入 `D:\code\github\hertz-studio`，原项目与副本共用基线 `0e6024f0d0f7bc90589c55a9be3c9170101ea9f7`。
迁入 77 个新增/修改文件，删除 24 个旧布局与专属检查文件。替换前文件及哈希清单位于
`output/migration/20261105-003409/manifest.json`。原项目已有的三处舞台文件保持原始字节，
没有复制预览的曲库、配置、凭据或测试歌曲，也未提交或切换原项目分支。

正式入口为根目录 `启动播放器.cmd` 和 `启动网页播放器.cmd`，调用 `scripts/start-hertz.ps1`。
正式程序与桌面组件位于 `output/app`；使用 `%LOCALAPPDATA%\hertz-studio` 或已有的
`VMUSIC_DATA_DIR`，端口沿用原配置。可选的两个「预览」入口继续使用隔离数据目录。

已在原项目重新构建：

```powershell
cargo build --locked -p hertz-studio --features full,native-window
cargo build --locked -p hertz-desktop
```

产物哈希在 `output/migration-verification/artifact-hashes.json`。
主程序 SHA256：`95DCE6256E7850BED305FA96C8B90C5F581CFB53CFC5C5848243E43A44071094`。

### 原项目复验

| 检查 | 结果 | 证据（相对原项目） |
| --- | --- | --- |
| 前端默认检查 | 70/70 通过 | `output/migration-verification/frontend.log` |
| 资源 / 布局契约 | 1172/1172、251/251 通过 | `output/migration-verification/assets.log`、`skins.log` |
| 新 EXE 内嵌界面 | 26/26 组，0 脚本错误、0 横向溢出 | `output/migration-verification/hertz-ui-results.json` |
| DBX 桌面入口与默认页恢复 | 通过；非用户操作不自动启动桌面组件 | `output/migration-verification/dbx-desktop-settings.log`、`dbx-settings-default.log` |
| 桌面歌词 / 设置浏览器 | 通过 | `output/migration-verification/desktop-lyrics-browser.log`、`desktop-settings-browser.log` |
| 原生歌词 WebView2 | 无边框、面板展开、持久外观、跳句、播放暂停、锁定恢复通过 | `output/migration-verification/lyrics-native` |
| 正式启动器 | CPAL、内嵌新布局、重复启动复用、正常退出通过 | `output/migration-verification/launcher.json` |

浏览器综合复验覆盖 1440、1024、390、320px，使用隔离的 224 首歌曲、112 张专辑、7 位歌手和4张歌单。
`check-desktop-settings-browser.js` 的旧显示值断言已与已有兼容行为对齐：旧 `translation` 在 UI 显示为 `next`，提交时仍保留原草稿值；没有修改该业务行为。

### 桌面歌词真实服务联动

真实 CPAL 联动发现并修复了一个已有问题：主播放器启动桌面组件时显式传递数据目录，
对应 `custom` profile；读取歌词允许这一绑定，播控却误要求发行版名称也等于 `custom`，
因此能显示歌词却不能从歌词窗口播放、暂停或跳句。
`crates/hertz-desktop/src/feed.rs` 现在让播控与已有读取逻辑使用相同的发行版匹配规则，
仍校验当前数据目录、协议、服务会话和窄权限钥匙，并拒绝空会话。
修复后相关 Rust 检查 33/33 通过，真实服务联动 6/6 组通过，0 脚本错误：

- 新界面设置中的歌词入口启动同目录原生组件，并打开歌词设置页。
- CPAL 服务的本地 LRC、播放器 seek 与原生歌词同步。
- 原生歌词跳句按钮实际改变播放器位置。
- 原生播放与暂停有效；实测位置从 15000ms 推进到 15630ms，暂停后稳定在 15860ms。
- 显示/隐藏改变真实 Win32 窗口可见性；锁定启用鼠标穿透，新界面「解锁并定位」恢复可交互状态。
- 主播放器页面关闭后，原生歌词仍能保持服务连接与同步。

证据：`output/migration-verification/lyrics-integration/results.json`，
`desktop-lyrics-integration-fixed.log`、`desktop-lyrics-delivery.log`、`desktop-feed-tests.log`。
最终 `output/app` 中的两个交付程序也已再做真实联动，6/6 组通过。
修复后的 `output/app/hertz-desktop.exe` SHA256：
`3BF6E15220A49EC2DB0A1F2A6FEED084763266BACD18D1D1CA01B247F1310EC8`。

### 胶囊原生验证边界

新构建在真实 Windows WebView2、150% 缩放下通过六项：图标、单一主窗口缩为无标题栏置顶
364×76 DIP 胶囊、CPAL 播放连续、展开恢复位置与尺寸、恢复最大化、之后系统还原恢复原普通尺寸。
窗口枚举确认没有残留另一块主窗口。

真实鼠标拖动在发送按下前被命中检查阻止：`PickerHost.exe` 的 `Shell_SystemDim` 覆盖整个屏幕。
只激活/前置测试窗口后仍被遮挡，没有操作该系统选择界面。
因此物理拖动尚未计入通过，完整胶囊验收仍为 `complete:false`。
证据：`output/migration-verification/capsule-native/results.json`（原始记录在 `output/playwright/native-capsule-migration`）。

## 2026-11-04：独立副本验收（历史）

以下为迁入前记录，提到的 `output` 路径均位于 `D:\code\github\hertz-studio-ui-preview`，不替代上面的原项目复验。

验收日期：2026-11-04。实现位于独立副本 `D:\code\github\hertz-studio-ui-preview`，分支 `codex/music-player-ui`。
本轮按用户七项反馈并行实施，先实现、后验收，没有采用 TDD。

## 本轮交付

1. 新应用图标采用 H 字母与声波共形，统一标题栏、任务栏、托盘、EXE、页签及侧栏标识。
2. 主播放栏、播放页、沉浸声场和三维空间统一竖向音量；支持鼠标、键盘、触摸、静音恢复与关闭返焦点。
3. 舞台关闭/设置、封面墙工具改为轻量玻璃控件，去掉厚重的多层按钮背景。
4. 封面墙左下角展示真实当前曲目小封面，悬停或聚焦才显示播放控制；触屏保留播放角标。
5. 主界面与三维空间搜索框统一材质，消除输入框内部的重复描边，结果面板与搜索框对齐。
6. 更多菜单移除「设置」「收起」「退出服务」；设置从侧栏/手机导航进入，退出服务使用系统托盘。
7. 原生胶囊复用同一 WebView，将主窗口缩为 364×76 DIP 无标题栏置顶小窗，恢复原尺寸、位置及最大化状态；浏览器保留页内胶囊。

沿用已完成的桌面与 H5 原型移植、单一 Hertz 布局、清风封面墙、中文导航、真实业务模块与独立数据目录。
静止滚动条约 0.9 秒后隐藏；悬停不常驻，显示时不挤动内容。

## 构建与入口

交付文件：`output/ui-preview/hertz-studio.exe`，由 `启动桌面预览.cmd` / `启动网页预览.cmd` 使用。

构建命令：

```powershell
cargo build --locked -p hertz-studio --features full,native-window
```

SHA256：`EF1562309C64ABA5476798C675E955B6807D304C5E21EAD0B79E17EC55B1E540`。
构建成功，启动器使用真实音频后端 `cpal`；音乐与设置保存在副本自己的 `data/ui-preview`。
图标源文件位于 `plugin/ui/icons/hertz-studio.svg`，并附 PNG 与七尺寸 ICO。

## 本轮实际验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 前端默认集合 | 70/70 通过 | `output/preview/frontend-controls-final.log` |
| 资源与重复事件接线 | 1172/1172 通过 | `node scripts/check-assets.js` |
| 布局与生命周期契约 | 251/251 通过 | `node scripts/check-skins.js` |
| 在线业务契约 | 507/507 通过 | `output/preview/online-controls.log` |
| 桌面/H5 源码综合检查 | 26 组通过 | `output/preview/hertz-controls-source.log` |
| 交付 EXE 内嵌 UI 综合检查 | 26 组通过 | `output/preview/hertz-controls-embedded.log` |
| 封面墙浏览器与布局 | 37/37；布局通过 | `output/preview/cover-controls-browser.log`、`cover-controls-layout.log` |
| 封面与舞台控件专项 | 6 组通过 | `output/playwright/controls-refinement-results.json` |
| 竖向音量 | 9 组通过 | `output/playwright/vertical-volume-results.json` |
| 三维空间搜索 | 1440/1024/390/320px 内嵌资源通过 | `output/playwright/space-search-controls.json` |
| Windows 原生图标与胶囊 | 8 项通过；物理鼠标拖动另见下方边界 | `output/playwright/native-capsule-acceptance.json` |
| 设计机械检查、补丁空白检查 | 通过 | `output/preview/design-controls-final.json`、`git diff --check` |

综合检查使用 224 首中文标签静音 WAV、112 张专辑、7 位歌手与 4 张歌单，覆盖 1440×900、1024×768、390×844、320×740 以及深浅外观。
包含歌曲/专辑/队列真实分页、播放/歌词定位/EQ、所有业务导航、侧栏触摸与键盘、滚动条静止隐藏、搜索定位及菜单移除。
源码和最终内嵌资源均无脚本错误和横向溢出。

音量专项实际验证四个入口的鼠标上下方向、键盘 ArrowUp、后端音量值、静音与恢复、Escape 和点击外部关闭。
播放页及沉浸舞台进入真实浏览器全屏后，弹层仍能开启并更改音量；Escape 优先收起音量。

原生检查使用真实 WebView2、144 DPI（150%）和 CPAL 静音音轨：

- 图标在 small/big window handles 和 EXE 资源中存在。
- 同一原生窗口缩为 364×76 DIP 并置顶，客户区边缘确认不存在系统标题栏；没有留下黑色主窗口。
- 进入胶囊前后 CPAL 播放位置连续推进。
- 展开恢复主窗口尺寸与位置。
- 从最大化进入胶囊后恢复最大化。
- 再次点击系统还原仍恢复原普通窗口矩形；已修复 Windows 记住胶囊尺寸的问题。
- CDP 指针事件已触发真实原生 `drag` 消息，Rust 日志确认收到；模拟输入本身没有移动窗口。
- 对隔离窗口定向调用 `SetWindowPos` 可将胶囊移动到原主窗口之外，证明坐标不再受网页边界限制。

## 可查看的效果

- `output/playwright/hertz-desktop-home.png`
- `output/playwright/hertz-desktop-search.png`
- `output/playwright/hertz-desktop-tools-menu.png`
- `output/playwright/hertz-mobile-home.png`
- `output/playwright/volume-main.png`
- `output/playwright/volume-mobile.png`
- `output/playwright/refined-cover-controls-desktop.png`
- `output/playwright/refined-stage-controls-desktop.png`
- `output/playwright/hertz-space-search-1440.png`
- `output/playwright/hertz-space-search-320.png`
- `output/playwright/hertz-native-capsule.png`

## 验证边界

物理鼠标拖动验收时，Windows 文件选择器 `PickerHost.exe` 覆盖了目标窗口；安全命中检查阻止了点击注入。
因此该项没有计入通过，原生验收 JSON 保留 `complete:false`、`physicalPointerBlocked` 与剩余验证项。
原生拖动消息接线和窗口越界移动已分别验证，并明确区分模拟事件、定向系统调用与物理鼠标，不混报通过。

正常预览入口不预置验收歌曲；隔离 WAV、测试封面和歌单只属于验收数据。
静音 WAV 验证音频通路与状态连续性，未用于评价听感。手机使用浏览器触控模拟，物理手机、多显示器跨 DPI 与全部外部音源账户未在本轮全面实机验证。
