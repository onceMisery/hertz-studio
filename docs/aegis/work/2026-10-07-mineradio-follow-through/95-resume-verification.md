# 续接验证与遗漏修复（2026-10-08）

基线：主目录 `10f40cf` 加已有未提交改动。关联聊天和旧实施工作树只提供历史线索；本次实现使用从当前 HEAD 建立的 `codex/mineradio-remaining` 隔离工作树。开始时的创意舞台、发布文件和 ADR 修改保留。

## 新跑的基线验证

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| `cargo test --workspace` | 退出 0；498 通过、1 忽略 | QQ 真实凭据探测仍忽略；没有声卡听测 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 退出 0 | 当前主目录源码 |
| CI 范围 `cargo fmt ... -- --check` | 退出 0 | 八个项目包，不改 vendor SDK |
| `node scripts/check-frontend.js --extra` | 退出 0；47 步、158 个 JS 文件通过 | 活体检查另外运行 |
| `node scripts/check-online-window-browser.js` | 退出 0 | 实际 Chrome；1000/5000 行、原集合绝对索引、焦点、筛选、640px 重排与哨兵续页 |
| `node scripts/check-stage-queue-browser.js` | 退出 0 | 实际 Chrome；固定/自动隐藏/关闭焦点；没有播放命令 |
| `node scripts/check-home-dashboard-browser.js` | 退出 0 | 实际 Chrome；当前/最近/空库动作、迟到封面、浅深色、280–900px 容器和双倍字号 |

浏览器使用已安装 Playwright 和 Chrome，无真实账号；组件验证不冒充完整宿主验收。Rust 日志：`output/mineradio-resume-workspace-test.log`、`output/mineradio-resume-clippy.log`。

## 独立审计与复现

### 压缩音频的精确衔接资格

同为 44100Hz 的原创合成音频，经 ffmpeg 7.1 编码，再用与生产相同的 Symphonia 0.5.5 选项解码：

| 文件 | 原始帧数 | 解码帧数 | 事实 |
| --- | ---: | ---: | --- |
| 有有效延迟信息的 MP3 | 10000 | 10000 | `delay=1105`、`padding=415`，首尾实际裁剪 |
| 无 Xing 的 MP3 | 10000 | 11520 | 没有延迟/填充元数据 |
| 有 Xing、无有效 LAME 扩展的 MP3 | 10000 | 11520 | `delay=0`、`padding=0`；仅检查 `Some` 仍会误判 |
| AAC/M4A | 10000 | 11264 | 容器 presentation duration 为 10000，实际输出保留编码延迟 1024 和尾填充 240 |

M4A 的 movie timescale 明确设为 44100，排除了默认毫秒取整。第二段 12345 帧 M4A 解码为 14336 帧。原始探针、生成命令与交叉解码结果在 `output/review-audio-compressed-20261008/REVIEW.md`。这证明同采样率不是精确 gapless 的充分条件；不能按扩展名或固定裁掉 1024 帧修补所有 AAC。

### 新集合首页失败时的旧集合归属

审计定位：`reserve_online_intent` 在新首页成功前清掉旧 `playlist_load.active`。首页报错/为空时旧队列保留，但集合续载已失效。修复应保留现有 `set_queue_locked` 的实际替换时取消规则；请求预留仍需作废旧播放意图，避免迟到首页覆盖新选择。

### 关闭重开后的登录初始化竞态

`open('netease')` 卡在 `/v1/online/sources`，关闭后重新 `open('qq')`；QQ 二维码显示后释放旧请求，结果为 `data:qq → data:netease`，取码顺序 `[qq, netease]`，新 QQ 票据被旧请求取消。对照组仅关闭、不重开时保持隐藏且无取码/轮询。主代理复跑 `node output/review-online-login-open-probe.js`，上述现象断言通过、退出 0。

根因是 `open()` 首次 await 前没有预留登录意图，末尾仅检查 `modalOpen`，且音源、账号和头像加载函数会在内部异步回写共享状态。修复须从初始化开始核对同一个意图，连同迟到的错误/空音源结果一起隔离，避免只在最终调用 `start()` 前加一道检查却留下中途回写。

## 修复与最终验证

音频切片已完成：`OpenedReader` 在原 `open_media` 计算内部资格，当前/下一曲经过原装载与转场事件传递。公开 `MediaInfo`、actor 接口和回调锁规则未改变。资格缺失只阻止 0ms 精确衔接，普通播放及正值 crossfade 保留。

- 主代理复跑 `cargo test -p vmusic-audio`：58 项通过（新增 5 项），包含 MP3 双向 10000/12345 帧逐样本拼接、无有效延迟信息 MP3/AAC 双向回退、实际 crossfade、装载/转场资格更新、零尾填充元数据边界。
- 切片 `clippy`、`fmt --check`、差异空白检查通过；独立规格评审和后续质量评审均未发现待修问题。
- 8 个原创编码夹具约 56 KiB，保存生成器、MIT 说明与 SHA-256，主代理合入时逐一核验。没有第三方录音或新的依赖。
- 主目录音频源码的 SHA-256 与开始时基线一致后才复制修复；没有复制旧实施分支。合入后完整工作区验证已与在线切片一并完成，结果见下节。

在线切片已实现：

- `reserve_online_intent` 删除提前清空集合的路径，失败/空/非法首页及在途首页均保留旧会话，实际提交由 `set_queue_locked` 取消。`online_play::tests` 7/7、`collection::tests` 9/9 通过。
- `open()` 在读取音源前取登录意图；三个 loader 先局部收集再按意图提交，`init()` 只捕获当前意图而不抢占扫码。已确认注销的身份清理与弹窗跳转分开，账号快照内的源版本阻止旧探测复活旧身份，也保护后来成功的同源登录。已无用途的 `modalOpen` 布尔值删除。
- `node scripts/check-online.js` 414/414 通过（新增 107 项检查），覆盖三个初始化阶段、迟到成功/失败/空结果、关闭重开、直接切换、启动恢复、头像迁移隔离和迟到注销；原 A6 未知身份保留检查仍通过。
- `node scripts/check-online-login-browser.js` 退出 0：使用原 HTML/CSS/完整登录模块的 Chrome 组件夹具，7 种迟到结果均不覆盖新 QQ 码、提示或票据，Esc 正常关闭，无页面异常。请求均由内存 transport 替身处理。
- 独立质量评审抓到初版注销守卫过早返回的回归：关闭后已确认注销仍保留私有账号缓存，下一次 504 会让 A6 保留旧身份。修复后补充 closed/new-platform/late-profile/new-login 四组验证，独立规格和质量复核均通过。
- 合入前逐个比对目标文件 SHA-256，三个在线源码/检查文件均仍匹配原基线；主目录 `index.html` 的并发修改完整保留。

## 主目录最终结果

| 命令 | 退出码与结果 |
| --- | --- |
| `cargo test --workspace` | 0；505 通过、1 忽略（需 QQ 真实凭据） |
| `cargo clippy --workspace --all-targets -- -D warnings` | 0 |
| `cargo fmt -p hertz-studio -p vmusic-core -p vmusic-audio -p vmusic-store -p vmusic-library -p vmusic-lyrics -p vmusic-beats -p dbx-plugin-hertz -- --check` | 0 |
| `node scripts/check-frontend.js --extra` | 0；47 步、159 个 JS 文件通过；在线检查 414 项 |
| `node scripts/check-online-login-browser.js` | 0；合入后的真实 Chrome 7 场景通过，无页面异常 |

日志：`output/mineradio-resume-final-tests.log`、`output/mineradio-resume-final-clippy.log`、`output/mineradio-resume-final-frontend.log`。差异空白检查通过；没有为了通过验证修改既有用户的创意舞台和发布改动。临时隔离工作树只用于开发和复核，修复均已合回主目录，未提交或推送主项目。

最后一次前端聚合核对了运行前后 198 个已跟踪 UI/脚本文件的 SHA-256，验证期间没有输入变化；新增登录浏览器脚本另已与评审工作树核对一致。

架构对齐：AppState、音频 backend/actor 和登录模块仍各自持有原状态；内部资格和快照版本用于提交校验，未增加服务端授权真值。ADR-0007 明确精确衔接与异步归属边界，评估文档旧收尾已更正。当前适用任务关闭，置信度 B，以下外部环境边界保持独立。

## 未覆盖与条件项

实体声卡/不同驱动听测、真实平台登录/VIP 到期/打卡累计、真实 DBX 宿主仍需相应环境。automix、离线持久化回执、视频跨刷新保存仍按原文产品条件保留；本次没有新建伪权益端点或权限缓存。
