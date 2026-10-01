# 皮肤、3D 与播放验证

## 改动与边界

- 公共设置视图与导航支持滚动；四套皮肤覆盖 320px 窄屏，工作台移除空白第三列，浮光为悬浮舞台预留空间，短屏曲库改为单一自然流滚动。
- 顶栏齿轮提供统一设置入口；`cover_follow` 默认开启、即时保存，关闭后恢复主题色但保留歌曲封面。Stage 单点处理取色与氛围，异步封面代次避免旧回调回染。
- 播放状态命令顺序提交，耗时换曲不阻塞停止；曲目替换代次与队列编辑版本分离。主栏、弹窗和舞台处理进度拖动取消，最新 seek 才回填；音量合并请求在失败后保留最新目标。
- MediaSession 注册播放、暂停、停止、前后曲、相对和绝对定位；修复封面 MIME 声明，离开页面不停止服务端播放。
- 3D 保留现有七场景与主题架构，修正控件/相机手势冲突、歌词拖动、触摸取消、失焦清理及实时音量；暂停降频、隐藏停帧、减少动效冻结，像素预算和 GPU 尺寸双重钳制。
- Rust 修复 EOF 后重播/seek、按实际剩余样本判定结束、停止后缓冲消费、迟到结束/解码错误，以及停止复位失败的错误传播。未领取 seek 请求有 2 秒撤销期限。

## 自动化证据

测试使用 `output/skin-playback/data`、端口 18774、24 首静音 WAV/LRC、`VMUSIC_BACKEND=null`，不触及用户音乐目录与其他播放器进程。Rust 内嵌资源通过独立 `target-verify-skin-playback` 构建；浏览器脚本检查服务资源与工作区一致，不用覆盖资源代替最终构建。

| 检查 | 结果与覆盖 |
| --- | --- |
| `node scripts/check-player-browser.js` | 67 项通过；四皮肤 × 1440/1024/390/320 宽度、设置滚轮与原生滑块拖动、曲库/队列/收藏/歌单滚动、播放链路、封面设置刷新恢复 |
| `node scripts/check-3d-browser.js` | 16 项通过；真实 WebGL、拖动/键盘、取消/失焦/换曲恢复、即时音量、设置滚轮不缩放相机、减弱动效、4K 像素上限、七场景切换 |
| `node scripts/check-player-races.js` | 9 个受控并发/失败场景通过；命令顺序、最新 seek、停止优先、队列编辑、音量和设置保存 |
| `node scripts/check-3d-interactions.js` | 66 项输入/帧门/像素与纹理预算检查通过 |
| 外观、皮肤、主题、舞台、资源接线等 Node 检查 | 通过；完整输出见 `output/skin-playback/node-checks.log` |
| `check-daily-view.js` | 两项既有函数签名字面断言失败：并发 FM 工作将 daily/online_daily 改为 pub(crate)，不属于本轮改动，未擅自修复 |
| `cargo test --workspace --target-dir target-verify-skin-playback` | 302 passed、0 failed、1 ignored；包括音频 36 项、服务 212 项 |
| `cargo fmt --all -- --check` | 未全绿：main.rs/routes.rs/state.rs 的并发 FM 与既有格式差异，未改写其他任务文件；本轮音频文件无格式差异 |
| `git diff --check` | 无空白错误 |

浏览器日志在 `output/skin-playback/*-browser.log`；四皮肤截图在 `output/playwright/player/`；3D 截图、trace 与渲染诊断在 `output/playwright/3d/`。Playwright 默认隐藏滚动条，原生滑块用例显式移除该启动参数，未通过放宽断言掩盖问题。

## 尚未证明与剩余风险

- Null 后端验证实际 HTTP/WS 与状态同步，不等同于声卡输出、听感、设备切换或长时间压力测试。CPAL 解码/缓冲行为另由 Rust 用例覆盖。
- MediaSession 测试调用浏览器注册的处理器，不等同于真实 Windows 锁屏面板、硬件媒体键或所有浏览器平台集成；需在实际使用环境手动验收。
- 3D 浏览器用固定 Stage.presentation 和控制事件捕获隔离渲染交互，写 API 被拦截；实际 REST 播放链由播放器浏览器套件验证。隐藏生命周期由事件注入，4K 和质量预算不是全硬件 FPS 保证。
- **已领取并阻塞在底层 I/O 中的 seek 仍缺少安全强制取消，可能阻塞音频 actor。** 本轮只安全撤销未领取请求；完整修复需要媒体源取消与解码线程退休协议，不能靠超时后放任旧 seek 提交伪装完成。
- 不承诺检查穷尽所有皮肤元素、在线提供商和设备组合；保留既有聚合搜索与并发 FM 修改，没有提交或创建分支。

## 架构对齐

- Baseline：README 与 listening-experience 计划；Stage 拥有表现层时钟/取色，app 拥有前端命令与设置，Rust actor 拥有真实播放。
- Result：aligned。没有第二套播放器、时钟或主题存储；皮肤仅布局、主题仅配色。命令排队仅覆盖短状态操作，不把在线取流准备塞入不可抢占队列。
- ADR Backfill：无需新 ADR；停止失败与阻塞源取消边界记录于此。
- 证据置信度：B，直接自动化覆盖主要功能，真实声卡/锁屏与阻塞源取消仍有明确边界。
