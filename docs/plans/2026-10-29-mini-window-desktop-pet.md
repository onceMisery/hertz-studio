# 小窗播放（桌面宠物）原型方案

日期：2026-10-29。范围：给 `hertz-desktop` 加第三个 surface（小窗播放 / 桌面宠物），
复用桌面歌词那套本机窗口与窄凭据通道。本轮只出原型与接线清单，不改既有文件。

## 1. 现状梳理：复用什么、新增什么

### 1.1 可复用（逐条对着现有代码）

| 现有模块 | 位置 | 小窗怎么用 |
|---|---|---|
| 透明无边框置顶窗 | `hertz-desktop/src/native.rs` `strip_title_bar` / `make_tool_window` / `show_no_activate` / `hide` / `raise` | 直接复用。小窗就是一扇 `WS_EX_TOPMOST + WS_EX_TOOLWINDOW + WS_EX_NOACTIVATE` 的无边框窗 |
| 整体鼠标穿透 | `native.rs` `set_locked`（`WS_EX_TRANSPARENT + WS_EX_LAYERED`）+ `set_descendants_transparent` | 语义复用，**代码不复用**（见 §6.1） |
| 显示器与工作区 | `native.rs` `monitors()` / `WorkArea` / `work_area_for_window` / `work_area_by_name` / `window_dpi` | 直接复用。吸附、贴边隐藏、DPI 换算都建在它上面 |
| 来源发现与窄凭据 | `bridge.rs` `read_discovery` / `read_key` / `get_json` | 直接复用，小窗加一把自己的钥匙 `desktop-mini-key` |
| 快照轮询节奏 | `feed.rs` `Feed::poll` 的校验顺序（协议号 → edition → 会话 → 钥匙每拍重读） | 照抄顺序，一个字不改 |
| 配置域模型 | `config.rs` `ProfileDomain`（每 profile 一份 lyrics + wallpaper，schema v2 迁移） | 加第三个域 `mini`，落在同一个 `ProfileDomain` 里 |
| 窗口拼装 | `app.rs` 的 `WindowBuilder::new().with_decorations(false).with_transparent(true).with_always_on_top(true).with_skip_taskbar(true)` + `WebViewBuilder::new().with_transparent(true).with_ipc_handler(..)` | 直接复用同一组参数 |
| 页面资源拼装 | `app.rs` `page_html()`（`include_str!` + 占位符替换） | 加一个 `mini_page_html()`，同样 `include_str!` |
| 单一实例与托盘 | `native.rs` `acquire_single_instance`；`app.rs` `build_tray` | 复用同一进程，不另起 exe |
| 服务端播控真值 | `state.rs` `resume_control_if` / `pause_control_if` / `seek_control_if` / `step_by_user` | 小窗播控直接调这几个，不另建播放实现 |
| 回主窗口的既有通道 | `routes.rs` `/v1/ui/notice` + `UI_NOTICE_ACTIONS = ["expand-capsule"]` | 小窗的「回到主窗口」复用这条广播，不新增订阅协议 |
| 前端胶囊交互 | `app.js` `initCapsuleControls` 的拖拽阈值、按钮 `stopPropagation`、host 形态交还宿主轮询 | 手感对齐：阈值 4px、过阈值才拖、抬手后抑制一次 click |

### 1.2 新增

| 新增 | 位置 | 职责 |
|---|---|---|
| `mini.rs` | `hertz-desktop/src/` | 状态机（`MiniPhase`）+ 几何（吸附 / 落位 / 贴边隐藏 / DPI 换算）。不碰 HWND，可单测 |
| `mini_native.rs` | 同上 | 按 HWND 的命中处理、区域穿透、置顶、拖拽轮询 |
| `mini_feed.rs` | 同上 | 快照轮询、封面缓存、呈现时钟 |
| `mini-player.{html,css,js}` | `hertz-desktop/assets/` | 胶囊 UI、命中区上报、右键菜单、宠物态样式 |
| `desktop_mini.rs` | `hertz-studio/src/` | 服务端快照 / 封面 / 窄播控 + 主窗口可见性判定 |

未引入的新依赖：`tao` / `wry` / `tray-icon` / `windows-sys` / `reqwest` / `tungstenite`
全在 `hertz-desktop` 现有依赖里。右键菜单画在页面里而不是 `TrackPopupMenu`，
就是为了不给 `windows-sys` 加 `Win32_UI_Shell` 之外的特性，也不新增菜单库。

## 2. 进入与退出：状态机

```
                        ┌───────────── Enter(User | MainHidden | Restored) ─────────┐
                        │                                                          │
   ┌────────┐           ▼                                                          │
   │ Hidden │ ───────────▶ ┌──────────┐   DragBegin    ┌──────────┐               │
   │        │ ◀─────────── │ Floating │ ──────────────▶│ Dragging │               │
   └────────┘   Restore    └──────────┘ ◀──────────────└──────────┘               │
       ▲        / Quit                                      │                      │
       │                                              DragEnd                      │
       │                                    ┌──────────────┴─────────────┐         │
       │                                    │ 离边 ≤28px     否则         │         │
       │                                    ▼                             ▼        │
       │                            ┌────────────┐              （回到 Floating）   │
       │      MainVisible           │   Docked   │                                 │
       │   （仅 MainHidden 进来的）  └────────────┘                                 │
       │                                    │  ▲                                   │
       │                      静止 1.2s 且   │  │ 光标进入残条 / 关掉自动隐藏        │
       │                      开了自动隐藏   ▼  │                                   │
       │                            ┌────────────┐                                 │
       └────────────────────────────│  Peeking   │ ────── DragBegin ────────────────┘
                                    └────────────┘
```

**相位是唯一权威**：不存在独立的 `visible` 布尔。`pet` / `locked` / `alwaysOnTop`
是正交属性，改它们不换相位——这是刻意的设计，否则「开启宠物态」会把窗收掉。

关键判定：

- **进入**：`Hidden → Floating | Docked` 由记忆的 `dock` 决定；已经在小窗里时
  再次 `Enter` 只 `Place`，不重建窗口。
- **退出**：`Restore` 返回 `NotifyRestore`——相位先回 `Hidden`，动作里另外带一次
  「去叫主窗口」。两者必须分开表达：小窗关掉而主窗口没回来，用户就两个都没有了。
- **自动收回**：只对 `EnterReason::MainHidden` 生效。用户手动开的小窗不该被一次
  Alt-Tab 收掉（`mini.rs` 单测 `manual_mini_window_survives_main_window_coming_back`
  钉住了这条）。
- **拖拽**：`Peeking` 也能直接拖出来，此时先把窗恢复成完整尺寸再进入 `Dragging`，
  否则拖的是一条 3px。
- **落盘时机**：只在 `DragEnd` 落盘。拖拽期间每帧写配置既没必要也会拖慢手感。

## 3. 关键接口

### 3.1 组件侧（`mini.rs` / `mini_native.rs`）

| 接口 | 说明 |
|---|---|
| `MiniHost::handle(MiniEvent) -> MiniAction` | 唯一的相位推进入口。非法迁移只记日志、不 panic |
| `MiniHost::desired_rect(dpi) -> Option<(x,y,w,h)>` | 按相位算物理矩形；`Peeking` 在这里做偏移 |
| `MiniHost::tick_peek(edge_hide, cursor_inside) -> MiniAction` | 由 app 的低频 tick 驱动贴边隐藏 |
| `snap_target(x,y,w,h,&area) -> Option<DockTarget>` | 四条边取最近的一条，>28px 不吸附 |
| `dock_position(edge, along, w, h, &area)` | 由「边 + 沿边比例」反算左上角 |
| `bounded_position(..)` | 显示器拔掉 / 分辨率变小后把窗拽回工作区 |
| `mini_native::install(hwnd)` | 装命中处理；**必须连同 WebView2 子窗一起装**（§6.2） |
| `mini_native::set_hit_regions(hwnd, regions, dpi)` | 页面上报的实心区，物理像素存 |
| `mini_native::set_pet_mode / set_locked / set_topmost` | 两档穿透 + 置顶 |
| `mini_native::begin_drag(hwnd, sink)` | 独立线程 16ms 轮询光标，左键松开或 20s 超时收尾 |

### 3.2 页面 ↔ native（IPC，与桌面歌词同一个 `window.ipc.postMessage`）

页面 → native：`ready` / `hit-regions` / `drag-begin{offsetX,offsetY}` / `control{action}` /
`menu{item,on}` / `restore`。
native → 页面：`applySnapshot` / `applyPosition{ms,durationMs}` / `applyCover(dataUrl)` /
`applyConfig` / `flash`。

### 3.3 服务端（`desktop_mini.rs`）

| 路由 | 凭据 | 说明 |
|---|---|---|
| `GET /v1/desktop-mini/snapshot` | `Desktop <desktop-mini-key>` | 轻量快照 + `main.visible` / `main.sinceMs` |
| `GET /v1/desktop-mini/cover?key=<uuid>` | 同上 | 复用 `safe_cover_id` 准入；在线曲目不给 |
| `POST /v1/desktop-mini/control` | 同上，body ≤ 2 KiB | 白名单 `play / pause / toggle / next / previous` |

组件侧控制入口沿用 `desktop_control.rs` 的命名管道形态（客户端已是现成的），
命令加上 `mini-*` 一族即可。

## 4. 播放状态与进度同步

**单一时钟原则**：由 `hertz-desktop` 的 `PresentationClock` 插值，页面只画。
两边都插值会叠加漂移，判定「谁对」比多一次 `evaluate_script` 贵得多。

- 快照 500ms（播放中）/ 2s（暂停）/ 5s（隐藏），与 `feed.rs` 同一节奏；
- 每次快照用 `sync(positionMs, durationMs, playing, generation)` 校正：
  **换曲（`generation`）、播放态变化、预测偏差 > 1200ms** 三者才重锚，
  小于 1200ms 只当网络抖动，重锚反而让进度条回跳；
- 播放中由 native 以约 4Hz 推 `applyPosition`，暂停时不推（页面停在原值上）；
- 播控带 `generation`，迟到的点击会被服务端判 `stale_playback` 拒绝——
  小窗关着的时候没有状态更新来源，不能在本地缓存播放布尔。

**主窗口最小化的检测**（本方案最不确定的一环，如实说明）：
浏览器里 `visibilitychange` 分不清「最小化」和「切标签页」，两者都是 `hidden`。
所以：

1. 主界面上报 `main-visibility`；服务端只记「上次可见到现在多久了」（`sinceMs`），
   判定阈值默认 1.2s；
2. `autoOnMainHidden` **默认关闭**，要用户显式打开——宁可不自动弹，也别在切标签页时
   忽然冒出一扇窗；
3. 不做原生 `IsIconic` / `SetWinEventHook` 探测：主窗口是哪个 HWND 取决于用户用什么
   浏览器，认错了就会跟着别人的窗口走，代价远大于收益。

## 5. 跨平台注意点

| 平台 | 结论 |
|---|---|
| Windows 11 x64 | 本方案的目标平台。`hertz-desktop` 已经是 `tao + wry` 的 Windows 组件，穿透 / 置顶 / 分层窗都验证过 |
| 其它 Windows / ARM64 | 与桌面歌词同一规则：先跑「透明合成、跨应用穿透、非激活显示、可达恢复入口、完整退出」最小验证，任一关键项不成立就不开放，不能从 x64 推断 |
| macOS | 需要用 `NSWindow` 的 `level: .floating` + `styleMask: .borderless` + `isOpaque = false` + `backgroundColor = .clear`；穿透是 `ignoresMouseEvents`（整窗级，**没有** Windows 这种按区域穿透），所以宠物态只能退化为整窗穿透或不做 |
| Linux X11 | 可用 `_NET_WM_WINDOW_TYPE` + Shape 扩展做输入形状；但桌面歌词的规则是「先最小验证」，不能照搬 |
| **Linux Wayland** | **做不了**。Wayland 没有全局坐标，客户端无法把自己放到屏幕某个位置，无边框置顶窗也没有稳定语义。必须走 `zwlr_layer_shell_v1`（且只有 wlroots 系合成器支持）或退回页内胶囊 |
| DBX / Web 宿主 | 走 `plugin/ui` 的页内胶囊（现有 `initCapsuleControls`）：拖拽、吸附、位置记忆在页面里做，透明穿透做不到——这层限制要在设置里说清楚，不能让用户以为开关坏了 |

## 6. 三个必须先知道的坑

### 6.1 `native.rs` 的穿透状态是全局静态量

`native::set_locked` 和 `install_hit_test_subclass` 靠模块级 `CLICK_THROUGH` /
`ORIGINAL_WNDPROC`。桌面歌词只有一扇窗，全局量够用；小窗是第二扇，两扇窗会互相
改写对方的穿透标记。所以 `mini_native` 按 HWND 建了独立的注册表，**没有复用**那两个
函数。后续若歌词也要多实例，照 `mini_native` 的表拆开，别再往静态量上加。

### 6.2 WebView2 的子窗才是 WM_NCHITTEST 的第一到达点

只对顶层 HWND 做子类化，返回 `HTTRANSPARENT` 的机会根本轮不到我们——命中测试先落在
WebView2 的子窗上。所以 `install` 要把同进程子窗一起挂上，且**必须在 webview 建好之后
再调一次**（子窗那时才存在）。桌面歌词靠 `set_descendants_transparent` 让子窗整体让路，
代价是按钮也一起失效；小窗要「透明处穿透、实心处可点」，只能按区域判。

### 6.3 贴边隐藏时收不到鼠标事件

`Peeking` 期间窗口可能已经是穿透的，`WM_MOUSEMOVE` 不会来。所以弹回依赖
`cursor_in_window()` 的低频轮询（约 8Hz，只在 `Peeking` 时跑），而不是等事件。
这也是不做「鼠标悬停即展开」而留 3px 触发条的原因。

## 7. 接线清单

新文件已在仓库里，但**都还没挂进模块树**，本轮不改动既有文件。
要接上去按下面的顺序改（漏一处症状各不相同）：

**服务端（`hertz-studio`）**
1. `main.rs`：`mod desktop_mini;` + 生成 `desktop-mini-key`（照 `desktop-lyrics-key`
   的 `load_or_create_secret` 抄一遍）。
2. `state.rs`：`AppState` 加 `desktop_mini_seq: AtomicU64`；**注意** `state.audio.snapshot()`
   若没有 `has_cover` 字段，`build_track` 里的 `track.has_cover` 要换成
   `vmusic_store` 的封面查询。
3. `routes.rs`：`Router` 加 `desktop_mini` 组（照 `desktop_lyrics` 那组抄：三条路由 +
   `require_desktop_mini_key` 中间件）；`desktop_mini_key_allows()` 加进
   `routes.rs` 的钥匙判定；`UI_NOTICE_ACTIONS` 加 `"main-visibility"`，并在
   `post_ui_notice` 里转成 `desktop_mini::note_main_visibility`。
4. discovery（`vmusicd.json`）加 `desktop_mini_protocol: 1`；`bridge.rs` 的
   `Discovery` 加 `desktop_mini_protocol` 字段。

**组件（`hertz-desktop`）**
5. `main.rs`：`mod mini; mod mini_feed; mod mini_native;`（都在 `#[cfg(windows)]` 下）。
6. `config.rs`：`MiniConfig`（`enabled / autoOnMainHidden / alwaysOnTop / pet / locked /
   edgeHide / geometry / scale / opacity`）+ `DockEdge`；`Config` 与 `ProfileDomain`
   各加一个 `mini` 域，`sanitize()` 里加 `sanitize_mini`（尺寸与 opacity 要 clamp）；
   schema 从 v2 升到 v3 或让 `mini` 走 `#[serde(default)]` 保持 v2 兼容——**推荐后者**，
   省一次迁移。
7. `app.rs`：`UserEvent` 加 `MiniFeed` / `MiniDrag(mini_native::DragEvent)`；tick 里
   按 `feed.poll_interval()` 排下一次拉取；`MiniAction::NotifyRestore` 落到
   `feed.control({action:"restore"})`；`DisplayChanged` 由任务栏重建 /
   `WM_DISPLAYCHANGE` 触发；`page_html()` 旁边加 `mini_page_html()`。
8. `bridge.rs` 的 `Discovery` 加字段；`feed.rs` 的 `PROTOCOL` 对照检查不变。

**前端（`plugin/ui/app.js`）**
9. 主界面在 `visibilitychange` 时上报：
   `transport.post('/v1/ui/notice', { action: 'main-visibility', hidden: document.hidden })`。
   只在 `HertzCapsuleOnly === false` 的主 surface 上挂，别让胶囊自己也在报。

## 8. 边界与验收

- 本轮是原型：`mini.rs` / `mini_feed.rs` / `desktop_mini.rs` 带的单测是纯逻辑
  （几何、时钟、可见性去抖、动作白名单），**窗口相关的行为必须真机验证**，
  不能用单测冒充。
- 自由拉伸窗口不在本轮：只做离散尺寸档（`--scale`）。理由与胶囊性能那轮一致——
  反复设原生窗口尺寸会触发 WebView 重排，收益小而抖动明显。
- 在线曲目不给封面：小窗是本机窄凭据，不该有访问公网 CDN 的能力，页面落回音符字形。
- 验收清单（真机）：无边框置顶 / 拖拽跟手 / 四边吸附 / 重启后位置与尺寸保持 /
  点击回到主窗口且主窗口真的在前台 / 主窗口最小化后按阈值自动接管 / 自动接管的小窗
  在主窗口回来后自动收 / 手动开的小窗不被收 / 宠物态下透明处点得到下面的窗口、
  实心处点得到按钮 / 右键菜单五项生效 / 贴边隐藏后碰残条能回来 / 穿透锁定后全窗
  点不到且托盘仍可解锁 / 锁屏、全屏应用、显示器拔插后不丢窗。
