# ADR-0005 · 交互层的合并、去重与上限：按「一次意图」算

状态：生效（首次记录 2026-10-07）

## 决定

界面上的连续动作要合并成**一次可撤销的意图**，提示要按「这一件事」去重而不是
「这一页只说一次」。三条规则：

- 撤销栈只记合并后的意图：一次调参会话（一次拖动从按下到松手、一段连按到 keyup）算一笔，
  不按毫秒窗口拆；把值调回原样不产生历史记录（否则撤销会退到一个没变化的状态）。
- 提示的去重键是「对象 + 内容」，不是一个全局布尔。`window.__qtoast` 那种一次性的
  写法会把第二次的真降档吃掉 —— 失败形态不是报错，而是「听着不太对」。
- 列表/结果类 UI 的条数上限写在常数里，超了丢最旧，别无声截断到看不见。

搜索入口共用页面级协调器，初始请求、局部重试和分页都占同一额度；同源串行。
取消立即作废结果和排队任务，执行槽保留到真实 transport promise 结束，DBX 不得用
本地 abort race 提前释放。结果按会话开始时的音源顺序分组，单源失败保留错误和
requestId，只重试失败源。下列搜索额度已有[单机受控压力证据](../../evals/search/pressure-v1/README.md)，仍是待真实来源、弱机与 R0 矩阵冻结的候选值。

## 边界与 owner

| 数值 | 现在是多少 | 定义在哪 | 改它要一起改什么 |
| --- | --- | --- | --- |
| 舞台参数撤销历史上限 | 40 | `plugin/ui/stage-control.js::HIST_MAX` | 撤销按钮的可用态与内存 |
| 沉浸舞台 chrome 静止隐藏（毫秒） | 2600 | `plugin/ui/stage3d.js::CHROME_HIDE_MS` | 豁免清单（设置/工坊/队列焦点/拖拽中）；固定队列独立保留显示 |
| 搜索关键词历史上限 | 10 | `plugin/ui/search-history.js::MAX` | 流年面板的芯片渲染；键名只在这一处 |
| 页面搜索执行上限 | 2 | `plugin/ui/search-session.js::LIMIT` | 在线页、顶栏、空间与流年共用；DBX 真实结束才归还 |
| 页面搜索排队上限 | 64 | `plugin/ui/search-session.js::QUEUE_LIMIT` | 超额明确 search_busy，不静默丢弃 |
| 服务端搜索执行上限 | 4 | `crates/hertz-studio/src/online/search_gate.rs::PERMITS` | HTTP/RPC/聚合的实际单源调用共用 |
| 服务端搜索等待席 | 16 | `crates/hertz-studio/src/online/search_gate.rs::MAX_WAITERS` | 与等待时长共同限制排队 |
| 服务端搜索等待期（秒） | 2 | `crates/hertz-studio/src/online/search_gate.rs::WAIT` | 超时返回 search_busy |
| 单源搜索总期限（秒） | 6 | `crates/hertz-studio/src/online/search_gate.rs::SOURCE_DEADLINE` | 包含 admission 等待；聚合本身不占执行位 |
| 命令面板结果上限 | 10 | `plugin/ui/palette.js::MAX_RESULTS` | 置顶/最近两组的合并顺序 |
| 进度重绘节流（毫秒） | 100 | `plugin/ui/app.js::PROGRESS_PAINT_MS` | 播放条与封面跑马灯的观感 |
| 歌词行交接上限（毫秒） | 460 | `plugin/ui/stage3d.js::HANDOFF_MAX_MS` | 行切换时的重锚判定，别当缓冲时长改 |

## 禁止回退

- 不许把去重退回全局布尔（`__qtoast` 的形状）。要抑制重复就得**带上对象身份**。
- 不许让「值没变」的调参进撤销栈：那会造出一条撤了什么都没发生的假历史。
- 不许逐字输入进搜索历史：只记提交（Enter、点搜索、搜索真的执行）。否则最近十条全是
  「周」「周杰」这种中间态。
- 关键词历史不许长出第二个键或第二处写入：旧键一次性搬入并删除。
- 命令历史（`vmusic.palette.recent`，存的是命令 id）不许与关键词历史合并 —— 名字像
  但不是同一个东西。
