# 节拍与 UI 复核证据

## 现状与修复边界

- C4 已有 v2 信封、delta varint、量化 strength、flags、旧格式失效与文件版本校验。本轮修正解包对 u64 尾字节溢出、i64 时间转换/累计溢出、重复时间戳、保留标志位的接受；损坏载荷统一回到缓存未命中。
- F5 已有 semaphore、单飞表、次数上限、内存缓存和持久化状态。实际 `_permit` 未被 `async move` 捕获，启动函数返回就释放，原正则只检查了参数类型。现在显式移入 future，分析及落盘、状态提交结束后释放。
- 手动 retry 原先会删除正在运行的 Analyzing 格子，使同键第二个 FFT 得以启动。现在在原任务表锁下保留运行中格子并返回现有 analyzing 响应；仅终态可重置。
- 真正生效的并发预算可能将当前曲目推迟，四秒 demand 超时返回 analyzing 却没有任务、没有后续 ready 事件。StageCinema 使用原 GET 入口进行最多八次递增间隔重取；切歌清理定时器，seq + track id 防迟到；耗尽时回退 onset，后来的 ready 事件或手动重试仍能恢复。没有新增服务端任务表或前端分析 owner。
- G7 的状态行和重试入口原本已经可达。修正状态响应的序号及曲目归属，换曲立即隐藏旧结论；对 analyzing/idle 做最多十二次、间隔四秒的服务端状态读取，补足失败没有 ready 事件的路径。手动重试结果仅回写仍在播放的同一曲目，并重新唤醒 StageCinema 的读取。
- G8 已有 Q、显式队列按钮、Escape、焦点返回。先修正 silk 队列的键盘焦点保护；后续授权切片在原面板增加“固定/已固定”按钮，使用 Stage3D 自有 queuePinned 和 root class。固定时 chrome 仍可自动隐藏，队列独立保持可见；关闭/退出清理固定状态，关闭时焦点回到队列入口。不新增播放命令或队列 owner。

## 行为证据

1. 修复前 `cargo test -p hertz-studio stage_beats::tests -- --nocapture`：18 项中原 15 项通过，新增 3 项失败：许可 available=2（应为1）、忘掉运行中任务后 Action=Spawn（应为Wait）、溢出 varint 被接受。真实原函数触发，不是源码字符串断言。
2. Rust MIR 最小探针对照：未使用的 Permit 参数在创建 coroutine 后、启动函数 return 前 `drop(_1)`，佐证生命周期根因。
3. 修复前 VM 直接执行 app.js 原节拍函数：A 请求→切 B→B 返回 disk→A 迟到返回 unsupported，当前 B 行显示“这首算不出来，格式不支持”。新增 `scripts/check-beat-lifecycle.js` 在同场景先失败，修复后通过。
4. `node scripts/check-beat-lifecycle.js` 通过：跨曲目/同曲目迟到、换曲读取失败、分析失败状态刷新、重试结果归属、手动重试唤醒、有限 demand 重取、切歌清理、重取耗尽后 ready 恢复及队列焦点保护。
5. `node scripts/check-beat-budget.js` 34 项通过；`node scripts/check-stage-cinema.js` 114 项通过；app.js、stage-cinema.js、stage3d.js 的 `node --check` 通过。
6. 真实 Chrome：加载当前 stage3d.css 与原始 chromeKeyboardFocus/pokeChrome 函数，Tab 聚焦队列行，等待 3000ms（大于2600ms），测得 opacity=1、pointer-events=auto、focus=queue-row、chrome=true。此项是组件浏览器检查，未冒充完整服务端端到端。
7. 修复后 `cargo test -p hertz-studio stage_beats::tests -- --nocapture` 最终退出0，19项全部通过。包括实际四秒 click WAV 分析至落盘、阻塞状态提交期间 permit 仍占用、提交后归还；曾遇同时实施的 radio/collection、AudioEvent 接线编译中间态，接线收敛后重跑通过。

## 尚未实施与边界

- G4 后续授权切片已在 online-playlist-view.js 实施超过120项的窗口：保留 state.tracks 与 visibleTracks 的完整数据，按当前 CSS 的实测高度/列数、滚动视口及3行 overscan 计算范围。视口外持焦点行最多额外保留一行，使用原节点保持焦点，数据变化/密度变化时按稳定 id 恢复；全量播放与筛选索引不变。daily 推荐通常24项，未做无测量收益的窗口化。stage3d 队列仍全量创建，独立记录而未扩大本切片。
- G9：已向主代理交接 cover helper 迟到回填和 daily 同 id 元数据跳过问题；不在本切片重复实现。
- 不新增 HTTP/RPC 响应形状。延迟请求与状态行重取都有上限；后端任务仍为唯一状态事实。已知分析尚未结束时不会假报 ready。
- 修复轨：纠正原 owner 的许可生命周期、单飞保留、解包边界和异步 UI 提交归属。退役轨：移除无保护的状态回写、直接擦掉运行任务、未检查整数累加；兼容保留现有 analyzing/ready/unavailable 协议。

## G4/G8 后续切片的真实浏览器证据

同机 Chrome、1440×900，计时包含同步 DOM 创建与强制布局；数值为诊断样本而非跨设备性能承诺。

| 已加载项数/布局 | 修复前渲染 | 修复前条目 DOM | 窗口化后渲染 | 窗口化后条目 DOM |
| --- | --- | --- | --- | --- |
| 1000/list | 105ms | 1000（17000后代） | 19.4ms | 20（342后代） |
| 1000/cover | 32.4ms | 1000 | 8.8ms | 80（322后代） |
| 5000/list | 439.2ms | 5000（85000后代） | 2.6ms | 20（342后代） |
| 5000/cover | 135.8ms | 5000 | 2.6ms | 80（322后代） |

- `scripts/check-online-window-browser.js`：修复前首次断言因1000行全挂载而失败；修复后1000/5000两种布局都通过。覆盖末项点击的全列表+绝对索引、滚动后保留聚焦节点、Home/箭头/Tab全数据顺序、过滤得到111项仍全量播放、640px窗口、compact密度、翻页哨兵和显式“加载更多”。
- 原哨兵位于滚动容器外，会一直可见并提前抓取后续页；现在移入真实滚动尾，IntersectionObserver 的 root 使用该容器。验证顶部零抓取、滚到底一次抓取剩余50首，按钮始终保留。
- `scripts/check-stage-queue-browser.js`：执行原 Stage3D 队列/键盘/定时器函数及实际 CSS。固定后超过3秒，chrome=false而队列opacity=1、pointer-events=auto；取消固定恢复自动隐藏；Escape和关闭返回焦点并清理固定；队列数据不变、零音频指令。
- 现有 `check-online-playlist-view.js` 83项、`check-3d-interactions.js` 66项、`check-beat-lifecycle.js`、CSS令牌检查、相关JS语法检查和diff空白检查均通过。
- 改动仅 online-playlist-view.js/online.css、stage3d.js/stage3d.css 及新浏览器脚本；后续切片没有修改 app.js 或 index.html，保留所有既有用户舞台修改。
