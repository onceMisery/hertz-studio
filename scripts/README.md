# scripts/

脚本按运行方式分四类，新增脚本前先确认自己属于哪一类。

## 1. CI 契约检查

`check-frontend.js` 是唯一聚合入口，`STEPS` 与 `.github/workflows/ci.yml`
的 Frontend contract 步骤等价；`EXTRA` 只在本地 `--extra` 时运行；`LIVE_EXTRA`
需要真实浏览器和运行中的服务（`--live`）。改 `STEPS` 时同步检查 CI 的注释与
步骤数。

## 2. 手工 / 浏览器验收

不在上面三组里的 `check-*` 必须登记在 `manual-checks.json`，至少写一行用途。
`check-scripts.js` 会拒绝未登记的新 `check-*`，也会拒绝指向缺失文件或与聚合
入口重叠的登记。浏览器类脚本优先复用 `ui-browser-fixture.js`（隔离服务、启动、
截图、断言）；`check-space-post.js` 的 `--browser` 分支是「同一条契约，纯逻辑
与真渲染两种跑法」的参考形态。

### Hertz 布局迁移后的验收

生产布局只保留 `hertz`。旧皮肤存储值的迁移仍由 `check-skins.js` 和
`check-appearance-restore.js` 验证；`classic` 歌词渲染器与 `orbit-fog` 配色不属于
已删除的布局，继续保留其检查。

以下入口承接通用功能。完整退役脚本、退役原因和覆盖映射记录在
`manual-checks.json` 的 `retiredLayouts` 中；布局专属的黑胶拖动、流年常驻搜索面板、
清风胶囊导航、Orbit 四标签原型、共享设置浮层随产品一同退役。「更多工具」保留胶囊、舞台等入口，
移除重复设置、播放条折叠与退出服务；`check-bar-browser.js` 仍验证旧折叠偏好的恢复路径。

| 验收范围 | 当前入口 |
| --- | --- |
| 首页、曲库分类与分页、专辑详情、设置分类、桌面折叠/手机侧滑、焦点与播放器边界、多选/滚动 | `check-hertz-ui-browser.js` |
| 封面墙真实曲源、播放器返回、原生触摸拖动/双指缩放、320px 源切换、重复挂载 | `check-cover-wall-browser.js` |
| 封面墙密排、展开重排、当前曲关灯、键盘与退出清理 | `check-cover-wall-layout-browser.js` |
| 收藏写入/读取竞态、失败回滚、折叠/键盘恢复与持久化 | `check-bar-browser.js` |
| 播放/暂停、seek 与取消、模式/音量、列表滚动和歌单播放 | `check-player-browser.js` |
| 全屏与弹窗、歌词请求竞态、错误/空态、键盘焦点与封面墙返回 | `check-now-playing-browser.js` |
| 在线页、顶栏与空间搜索的增量结果、重试、分页、取消、焦点和窄屏 | `check-search-journey-browser.js` |
| 每日推荐首屏、异步落位、节点复用、收起偏好、曲库多选和末行可达 | `check-daily-strip.js`、`check-daily-collapse-browser.js`、`check-daily-scroll-browser.js` |
| DBX 表单提交、行控件几何、桌面设置授权/撤销/失败/启动行为 | `check-dbx-ui-browser.js`、`check-dbx-desktop-settings-browser.js`（另跑 `--settings-default`） |
| 桌面歌词全局恢复快捷键：设置页录入/取消/清除、脏草稿互斥、失败反馈、窄窗口 | `check-recovery-hotkey-browser.js`（页面契约）；`check-recovery-hotkey-native.js`（隔离原生宿主：真实注册占用、注入按键与定向消息到解锁定位、退出释放、重启持久、启动冲突，见 `docs/desktop-host.md` §5.1） |
| 房间播放器、主题与局域网收藏、胶囊大小与对比度 | `check-room-player-browser.js`、`check-room-theme-browser.js`、`check-capsule-browser.js` |

封面墙、搜索、顶栏菜单与 `check-qf-issues.js`（历史名称，现为 Hertz 播放条检查）
通过 `ui-browser-fixture.js` 启动私有 null 后端，并由 `ui-source-assets.js` 按真实资源
注册表装载当前工作区源码。`check-cover-wall-browser.js` 同样回源当前 UI。它们验证源码
与真实服务的集成；最终交付的内嵌资源仍须使用重新构建的二进制单独验收。
浏览器模块可通过 `PLAYWRIGHT_MODULE` 指定。输出截图和证据留在忽略的 `output/`。
`check-hertz-ui-browser.js` 自建 224 首带中文标签的隔离音乐和四张歌单，越过曲库、
专辑与队列的分页边界；数据随服务结束清理。`HERTZ_EMBEDDED=1` 可直接验收新构建的
内嵌 UI，不拦截源码资源；`HERTZ_BIN` 可指定待验收的二进制。

`check-player-browser.js`、`check-now-playing-browser.js`、`check-bar-browser.js` 等已有
服务入口继续要求各自文件头声明的隔离服务 URL 与 `VMUSIC_DATA_DIR`。它们未列入默认
70 项契约检查；默认集合通过不能代替这些浏览器、真实音源或原生宿主验收。

## 3. 诊断

`diag-*`、`qf-*`、一次性视觉探针不参与登记守卫。它们不承诺长期可跑；需要保留
结论时把结论写进 docs 或对应 check，不要只留脚本。

## 4. 发布 / 测量

`benchmark-search.js`、`evaluate-ai-stage.js`、`measure-release-ui.js`、
`capture-*` 等由发布或评测流程显式调用，不进入日常 CI。运行产物按
[`evals/README.md`](../evals/README.md) 的保留规则处理，不直接堆进 git。
