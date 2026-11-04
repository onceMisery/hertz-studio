# UI 架构收敛评审修复记录

日期：2026-11-04。修复基线：`ae1e02a`。范围是该基线评审发现的四项问题；不将本次结果扩大为整个 R0–R5 路线或原生体验验收完成。

修复在 `codex/ui-convergence-fixes` 独立分支实施。原生修复提交为 `47fa392`；UI、回归检查和本文随后提交。原工作区中其他桌面歌词、壁纸和小窗改动不属于本次修复。

## 四项修复

| 评审问题 | 修复后的行为 | 实现位置 |
| --- | --- | --- |
| P1：退出请求失败冒充服务已经结束 | 原生退出直接调用现有停机 watch 的窄句柄，不再经 HTTP 发送退出。启动期间的退出意图保留到服务就绪。只有服务线程实际结束才通知窗口循环退出。 | `crates/hertz-studio/src/state.rs`、`window.rs`、`window/lifecycle.rs` |
| P1：任何相邻端口监听者都被当作已有窗口 | 服务启动前获取 OS 实例锁，经发现文件定位临时回环端口，验证完整请求/响应身份后才发送聚焦。删除固定 `port + 1` 通道，Full/Standard 的相邻服务端口不再与握手端口规划冲突。 | `crates/hertz-studio/src/window/instance.rs` |
| P2：房间主按钮 hover 后深底深字 | 公共按钮统一持有 primary/flat/touch 及交互状态；前景背景成对定义。删除房间的重复覆盖块，皮肤改用公开默认参数，并保留键盘焦点、禁用与减少动态效果支持。 | `plugin/ui/components/button.css`、`room.css`、`skins/skins.css` |
| P2：R4 只集中任意 DOM 搬运，未建立组件边界 | 组件作者在 HTML 根节点发布组件与接收区域；皮肤提交名称和布局描述。外壳管理组件独占、私有还原锚点、响应式切换和失败回滚。旧任意节点搬运 API 及消费者已删除。 | `plugin/ui/index.html`、`shell/shell.js`、三套需装配的皮肤 |

详细 UI 接口见[界面组件与皮肤装配契约](../ui-layout-contract.md)。Standard 可以不发布账号入口，清风通过 `hasComponent('account')` 声明可选装配。描述在交给外壳时复制并冻结，调用方后续修改原数组不能改变响应式装配或绕过组件独占。

## 原生生命周期与实例发现契约

- 托盘、窗口和 WebView 的可失败初始化先于服务启动；初始化失败不会留下已启动的播放器服务。随后加载服务 URL 失败时，使用同一停机句柄请求收尾并等待服务线程完成。
- 关闭窗口和隐藏仍只影响可见性。`ExitRequest` 只请求既有服务停机，不持有第二套播放或清理逻辑；HTTP 退出入口也继续使用同一停机 watch。
- 实例身份包含规范数据目录、发行版、规范 bind 和配置端口。端口 `0` 使用配置值作为身份，不把每次随机分配的实际服务端口当作身份。
- `<data_dir>/window/` 下的 OS 锁在服务 bootstrap 前获取。发现文件指向临时 IPv4 回环监听器，握手端口不预留服务端口的相邻值，也排除本实例配置的服务端口。
- HMAC 校验协议、身份、当前实例、nonce、方向和命令/状态。连接成功、普通 HTTP 响应和未经验证的 `ok` 均不代表聚焦成功；已认证但尚未就绪的实例返回“启动中”。发现秘密不进入网络帧或日志。此协议确认本机实例身份，不提供对有权读取发现文件的同用户进程的隔离。
- JSON 帧最多 2048 字节，网络 I/O 有 500ms 期限，发现等待有界。owner 停止并回收监听、删除自己发布的发现后才释放锁；锁文件本身保留，避免删除锁文件引入多把独立锁。

原先通过 `POST /v1/system/shutdown` 的测试，只能证明 HTTP 入口及共同服务收尾链路，不能充当托盘事件路径的实测。本次用独立生命周期测试覆盖提前退出、就绪后的退出、watch 接收端关闭，以及“退出请求不产生服务完成事实”。

## 验证结果

| 检查 | 结果与边界 |
| --- | --- |
| `cargo check` / `cargo build --locked`，`hertz-studio` + `native-window` | 通过，生成可执行程序 |
| `cargo test ... --lib exit_` | 3 项通过，验证共享停机句柄 |
| `cargo test ... --bin hertz-studio window::` | 17 项通过，覆盖生命周期、真实 TCP 协议、错误/半帧/超时响应、并发锁、清理、相邻端口及不同身份 |
| `node scripts/check-frontend.js` | 默认 CI 集合 70/70；未声称运行全部 130 项活体检查 |
| `node scripts/check-shell-layout-browser.js` | Full 与生产裁剪后的 Standard 各 103 项通过 |
| `node scripts/check-skin-matrix-browser.js` | 23 主题 × 4 皮肤，92 组合通过；星轨另由上述布局回归覆盖 |
| `node scripts/check-topbar-popup-browser.js` | 顶栏弹层互斥、Escape 和外部点击关闭通过 |
| `node scripts/check-shell-navigation-browser.js` | 27 项通过 |
| `node scripts/check-settings-sheet-browser.js` | 52/52 通过 |
| 独立审查 | 原生和 UI 规格复核通过；代码质量复核发现的减少动态效果优先级问题已修复并复审通过 |

布局回归使用独立临时数据目录、真实服务和 null 音频后端。第一轮换肤确认暂停状态，第二轮启动播放并确认正在播放；每个皮肤往返后核对真实服务的曲目和播放状态。另验任意 DOM/未知组件拒绝、插入中途失败回滚、调用方修改描述、真实皮肤生命周期抛错后的恢复、节点与事件监听器保留、原顺序还原、唯一设置视图、响应式释放，以及五皮肤×深浅主题的按钮交互与减少动态效果。

运行浏览器检查时设置 `HERTZ_BIN` 指向本次构建程序，设置 `PLAYWRIGHT_MODULE` 指向本机 Playwright。布局检查默认路由工作区 UI 文件；验证 Standard 时，用 `build-support/edition-ui.rs` 的生产裁剪器生成独立目录，再以 `HERTZ_UI_ASSETS` 指向它。主题矩阵、顶栏和设置浮层检查使用程序内嵌资源。导航和设置检查由隔离 fixture 提供 `SHELL_UI_URL` / `SETTINGS_SHEET_URL` 与 `VMUSIC_DATA_DIR`。

本机检查日志位于 `output/review-fixes/`，截图位于 `output/playwright/`；它们是本次生成的本地证据，未纳入源码交付。Windows 新检出曾因 CRLF 转换被设计生成物检查误报漂移，已在 `.gitattributes` 将两份设计生成物固定为 LF。两次浏览器 fixture 启动曾被 Node 的 `bad port` 检查拒绝，重新启动隔离实例后同一检查通过；未修改产品端口语义来规避测试。

## 保留的验收边界

本次没有执行真实 WebView2 托盘点击、拖动手感、系统贴靠和跨屏 100%/125%/150% DPI 人工对照。Rust 生命周期与 TCP 测试不能替代这些原生交互证据。活动 LAN 房间的端到端原生退出也未在本轮实测。

本次完成受控组件装配和公共按钮的评审修复，不代表其他业务模块都已迁移到公共组件，也不代表主题选择在不同桌面窗口间实时同步。后续路线应按实际迁移范围和专项验收继续记录。
