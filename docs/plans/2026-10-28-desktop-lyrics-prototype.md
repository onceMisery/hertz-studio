# 桌面歌词原型落地

日期：2026-10-28。设计依据：用户指定的 `D:/code/learning-hub/desktop-lyrics-prototype.html`，本次要求为按该原型实现既有桌面歌词。

## 意图与验收

用原型替换歌词 surface 的视觉和交互：景深行组、当前行 1em / 相邻行 .66em 与 .40 透明度、译文 .46em、22px 圆角、三档材质、深浅/自动主题、悬停胶囊工具条、620ms 换行和 560ms 入场。自动主题以系统明暗为依据，玻璃使用透明材质与 CSS backdrop-filter，不承诺 WebView2 能模糊跨窗口的桌面像素。

默认三行、30 DIP、550 DIP 宽；旧配置保留原值。设置应即时生效并持久化至现有 profile 域。打开设置仅增加原生窗口高度；屏幕空间不足时滚动面板。单、双、三行分别显示当前、当前+下一句、上一句+当前+下一句，双语为各行组的辅助文本。长正文最多两行，周边正文及辅助文本静态省略，不跑马灯。

工具条提供拖动、上一句、播放/暂停、下一句、锁定、设置和隐藏。窗口内空格/左右键发真实播控；输入控件和按钮保留原生键盘行为。锁定后所有鼠标事件穿透，依赖已有托盘恢复；不注册全局 L 键。关闭按钮隐藏歌词，不暂停音乐。

## 基线与影响

已读：`docs/aegis/baseline/2026-10-26-initial-baseline.md`、`docs/desktop-lyrics.md`、`docs/desktop-host.md`、原歌词资源、宿主配置与 feed、服务路由和共享播控入口。现有窗口、托盘、来源和配置所有权与基线相符；原型替换呈现契约并增加显式窄播控，不引入播放、配置、取词或窗口的第二个 owner。

- 呈现：`crates/hertz-desktop/assets/desktop-lyrics.*`。保留 `window.hertzLyrics` 桥；最多七个行组，按真实词时间双层 mask 扫色；普通 LRC 整行点亮。暂停、缓冲、身份变化和过期快照不能继续虚构进度。电池帧预算为 15 fps 时关闭背景模糊与环境光效。
- 配置：`config.rs`，schema v2 添加具备默认值的固定枚举/布尔字段；旧配置直接可读，按 profile 保存。中心增加三行预设，草稿仍只在“应用设置”提交。
- 宿主：`app.rs` / `feed.rs`，屏幕预算、面板高度、显式 IPC 和原生凭据。锁定/隐藏/来源切换继续由已有宿主管理。
- 服务：原快照/文档 GET 不变；新增窄 POST，仅 `play` / `pause` / 歌词句首 `seek`，请求上限 2 KiB。`Desktop` 凭据不会进入 WebView，不获得通用播放器 API 权限。服务复用 `AppState` 控制入口，提交锁内检查预期 track/generation，防止等待期间换曲后操作另一首歌。

## 验证与范围

浏览器检查覆盖深浅主题、材质/布局/对齐/双语、普通 LRC、真实扫色暂停、间奏、切句与播控、同 key 换曲清空、快照过期、文本注入、窄屏。原生检查使用隔离配置和本机 fixture 服务，验证真实 WebView2、IPC、窗口扩高不压缩歌词、外观落盘、带窄凭据的句首跳转/播放/暂停、锁定与托盘定位恢复；fixture 不证明真实声卡同步或底层桌面模糊。

Rust 检查覆盖旧配置迁移、外观按 profile 往返、路由鉴权/身份/动作和播控锁等待后身份复核。原设置浏览器/原生检查继续验证草稿、冲突与 Win32 位置回滚。本任务不扩展 DBX、跨平台、全局快捷键、系统媒体捕获或发布验收。

## 2026-10-28 实测记录

- `cargo test -p hertz-desktop`：32 项通过。
- `cargo test -p hertz-studio --lib desktop_`：10 项通过；同一测试产物的 `control` 过滤 4 项通过，包含等待提交锁后换曲的拒绝检查。原暂停/跳转、严格恢复和恢复失败状态保留检查也通过。
- `node scripts/check-desktop-lyrics-browser.js`：通过；包含两行布局下一句译文完整落入可见区的检查，截图位于 `output/playwright/desktop-lyrics/`。
- 最新 `cargo build -p hertz-desktop` 及 `node scripts/check-desktop-lyrics-native.js`：通过。原生窗口为 550×338 DIP，展开设置后高 834 DIP，歌词区域保持 254 DIP；IPC、外观落盘、带凭据的句首跳转/播放/暂停和锁定/托盘恢复均通过，证据位于 `output/playwright/desktop-lyrics-native-1793181541445/`。
- 原设置中心浏览器与 Windows 原生检查均通过。前端聚合检查除已修复的路由清单生成检查外，其余 63 步通过；生成后单独复核路由清单、脚本登记、Rust 格式、JS 语法和本轮差异空白检查均通过。

测试使用隔离配置与本机 fixture，未替换正在运行的用户服务。新增播控端点需配套使用重新构建的服务与桌面宿主。
