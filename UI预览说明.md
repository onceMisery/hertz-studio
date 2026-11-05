# HertzStudio Music Player 中文界面

2026-11-05 已将验收后的界面迁入原项目 `D:\code\github\hertz-studio`。
参照 `D:\code\github\HertzStudio Music Player` 的桌面与 H5 原型重构。
原项目已有舞台文件与用户曲库、配置均保留。

## 正式启动

- 双击 **启动播放器.cmd** 打开原生桌面窗口；**启动网页播放器.cmd** 打开浏览器。
- 正式入口使用 `output/app` 内的主程序和桌面组件，沿用 `%LOCALAPPDATA%\hertz-studio` 的曲库与配置；设置了 `VMUSIC_DATA_DIR` 时使用该目录。
- 端口沿用原配置（Full 默认 7634），不导入验收用歌曲。桌面歌词从播放器设置中启用。
- 替换前备份及文件哈希清单位于 `output/migration/20261105-003409`。

## 独立预览（可选）

- 双击 **启动桌面预览.cmd**：打开原生 WebView2 桌面窗口。
- 双击 **启动网页预览.cmd**：打开默认浏览器。
- 两个预览入口共用隔离的 `data\ui-preview`，默认端口 **18797**，使用真实音频后端 **cpal**。
- 首次打开曲库，点击 **音乐目录** 添加自己的音乐；预览启动入口没有预置虚构歌曲。
- 桌面关闭窗口后，服务继续在托盘运行；需要结束时使用托盘菜单里的 **退出**。

正式产物位于 `output\app`。后续改源码可重新构建并更新：

```powershell
cargo build --locked -p hertz-studio --features full,native-window
cargo build --locked -p hertz-desktop
New-Item -ItemType Directory -Path .\output\app -Force
Copy-Item -LiteralPath .\target\debug\hertz-studio.exe -Destination .\output\app\hertz-studio.exe
Copy-Item -LiteralPath .\target\debug\hertz-desktop.exe -Destination .\output\app\hertz-desktop.exe
```

浏览器缩窄到 899px 以下进入 H5 排版，支持 320px 宽度。
需要手机访问时，在同一局域网运行：

```powershell
.\scripts\start-ui-preview.ps1 -Mode Browser -Bind 0.0.0.0
```

先退出当前预览，再改变绑定地址。可从应用的访问二维码入口取得授权链接；手机端保留原项目的远程播放与控制行为。

## 界面与功能

- 桌面侧栏：顶部菜单按钮展开和收起，收起后内容区变宽，偏好可保存。
- 手机侧栏：顶部菜单按钮或左边缘向右滑展开；遮罩、关闭按钮、向左滑、Escape 和点击菜单都可收起。底部导航继续可用。
- 原生窗口：只保留系统标题栏的一套窗口按钮，关闭仍隐藏到托盘；页面完整使用客户区，播放器全屏与退出自动适配。
- 顶部工具：浏览模式、外观、队列、更多和账号统一成组，工具栏高度 68px，桌面右侧留白 24px。
- 应用图标：H 字母与声波共形，统一显示在 Windows 标题栏、任务栏、托盘、EXE 与浏览器页签。
- 搜索：主界面与三维空间采用统一的轻玻璃输入框，焦点描边位于外层；搜索结果与输入框对齐。
- 更多菜单：移除重复的设置、收起与退出服务入口；设置从侧栏或手机底部导航进入。
- 滚动条：深浅主题共用细滑块；实际滚动时显示、停止约 0.9 秒后隐藏，悬停不常驻，也不挤动内容。
- 首页：最近播放与精选专辑优先展示；侧栏展示真实歌单，额外业务入口集中到「更多功能」。
- 曲库：保留原歌曲列表、目录管理、筛选、分页、多选与右键操作；增加专辑与歌手分类及详情。
- 播放页：桌面封面/歌词布局、手机封面/歌词切换、队列抽屉；继续使用原播放、歌词时间轴、收藏、音量、EQ、睡眠和沉浸声场。
- 音量：主播放栏、播放页、沉浸声场和三维空间均使用竖向滑杆。点击、悬停或键盘聚焦音量按钮可调节；支持静音恢复、Escape 与点击外部关闭，手机支持触控。
- 封面模式：清风的拼接封面墙、展开让位、平移、缩放、曲源切换、歌单钻取和播放跟随；同时支持触摸与键盘。
- 封面墙控件：工具组与舞台按钮改为轻量玻璃；左下角显示当前歌曲小封面，悬停或键盘聚焦时显示播放/暂停，触屏保留小角标。
- 桌面胶囊：从更多菜单进入后，当前窗口缩为无边框置顶小窗，拖动封面或文字可移动到桌面；点击展开恢复原窗口的位置、尺寸及最大化状态。浏览器继续使用页内胶囊。
- 设置：按外观、播放、歌词、连接、工具分组。保留高级配色、自定义颜色和壁纸，默认采用原型的深浅外观。
- 在线曲库、播客、阅读、一起听、插件和原生桌面功能继续由原业务模块负责。

项目仅保留 HertzStudio 布局。已删除经典、流年、清风、黑胶与星轨的独立皮肤；清风封面墙作为共用功能保留。

## 验收记录

采用先实现、再做回归的方式，没有走 TDD。主要证据见 [UI验收记录.md](D:/code/github/hertz-studio/UI验收记录.md)。
原项目复验记录在 `output\migration-verification`，胶囊实测在 `output\playwright\native-capsule-migration`。此前副本的验收证据仍保存在副本自己的 `output` 目录。
浏览器验收生成的带中文标签的静音 WAV、封面、歌词和歌单仅属于隔离检查数据，不是正常启动的曲库。

正式 UI 浏览器检查：

```powershell
$env:PLAYWRIGHT_MODULE = 'playwright' # 或本机已安装模块的绝对路径
node .\scripts\check-hertz-ui-browser.js
$env:HERTZ_EMBEDDED = '1'
node .\scripts\check-hertz-ui-browser.js
```

第二次检查直接加载新二进制里的资源，可验证源码已经进入构建产物。
