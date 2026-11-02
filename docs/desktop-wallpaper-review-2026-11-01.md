# 壁纸实现审查与修复记录

日期：2026-11-01；第七、八轮续审：2026-11-02。审查基线：`0b421d4`，对照 [开发设计](desktop-wallpaper.md)。各轮实现与验证记录见下文，提交以 Git 历史为准。

## 结论

现有实现交付了 P0 的主要运行路径，以及 P1 若干可独立测试的内核；还不能按 P1 完整产品验收。主要问题集中在安装失败后的收敛、媒体信任来源、UI 线程 I/O、资源释放和时钟语义。本次修复了已实现路径中的这些问题，并补充行为测试。

## 已修复

| 优先级 | 原问题与影响 | 修复与证据 |
| --- | --- | --- |
| 高 | WebResourceRequested 在 UI 线程同步启动恢复、哈希原包，seek 还重复校验大文件，可能冻结桌面中心 | GetDeferral → 单个有界后台 worker → 宿主 UI 事件完成响应；最多 8 个待处理请求。核验缓存最多 4 项，持有拒绝写入/删除共享的原包和媒体句柄，避免每次 seek 重读大视频；controller 销毁后取消请求并回收缓存 |
| 高 | 媒体路由信任可修改的 receipt.entries，原生冒烟甚至利用该行为追加未声明视频；同尺寸投影篡改也能通过 | 路径、MIME 和摘要以重新验证的原包为准；投影逐文件核对 SHA-256；限制收据读取大小。原生测试明确验证伪造收据返回 404，视频使用独立有效包 |
| 高 | 快照及已安装包先整段读进内存再检查 512 MiB 上限；manifest 在检查 256 KiB 上限前完整解压 | 快照复制前检查尺寸与空间，循环中再次限制实际复制量；包校验直接使用文件流；ZIP 入口检查容器长度，manifest 对声明及实际解压长度都设上限 |
| 高 | 导入失败/取消后未统一清暂存；已存在孤包返回成功却不写索引；索引存在而文件缺失时直接宣告成功 | I/O 返回后统一清理再归还任务槽；孤立目录完成索引事务；缺失包可重新导入并恢复 installed 状态。空间检查只计算后续新增字节，避免重复计算已有 staging |
| 中 | 收据损坏或孤包版本冲突会让整次启动恢复失败 | 损坏的已索引包标记 unavailable；恢复后的有效字节可恢复 installed；冲突孤包跳过并记录原因，不覆盖已有版本或阻断其他作品 |
| 高 | WASAPI 只检查 float 标签，16 位或不完整扩展头也会被当作 f32 读取；采集句柄遗失后线程可能继续运行 | 检查 32 位宽、帧对齐及扩展头长度；采集包受预分配容量限制，直接下混原始缓冲；Drop 请求停止并等待线程退出 |
| 中 | 环形缓冲把正常覆盖已消费历史也算过载，且能反复交付同一窗 PCM | 分别记录保留历史和未消费样本；无新 PCM 不返回新窗，正常 30 Hz 消费不累计 dropped |
| 中 | 一个 feed 序号前进时允许另一个倒退，随后可以重放旧帧；33 ms 节拍实际上超过 30 Hz | 同会话下任一计数器倒退均拒绝，拒绝不改高水位；频谱最短周期调整为不少于 1/30 秒 |
| 中 | 低 FPS 只把最后一次 rAF 的 dt 交给场景，运动积分随 FPS 变慢；画质修改未到达已有 renderer | 累计分频期间的 dt，暂停恢复清空积累；Zodiac 分别接收环境与 UI 的时间增量；画质变化重建对应场景后端。覆盖 15/30/60 fps 和真实 WebGL 检查 |
| 中 | 视频失败只移除元素，未 pause/清 src/load；超时后的迟到帧仍可能上报 ready；图片没有解码时限 | 失败和卸载共用完整释放顺序；帧/解码回调同时校验代际与 loading 状态；图片、视频均有首帧期限；清空媒体后恢复场景 |
| 中 | 显示器稳定身份未命中时仍按 GDI 名或主屏回退，且设置页换屏未更新 displayId | 已绑定身份缺席时等待原屏；巡检按当前配置目标解析；换屏同步写入身份，缺屏不消耗重建预算；启动身份落盘失败不提前修改已提交配置 |
| 中 | 预算的 u64 加法可溢出；新会话代际继承旧 paused_at；COM Read 拒绝可选输出指针、大请求只读 1 MiB，Seek 加法可能溢出 | 用剩余额度比较；新代际清暂停时间；Read 分块填满调用方缓冲、真实 EOF 返回 S_FALSE，游标与文件使用同一锁；Seek 使用宽整数检查，创建时验证窗口 |
| 中 | HEAD 错误应用 Range，零长度后缀被当成语法错误，缺少 no-store/nosniff/Accept-Ranges | HEAD 返回完整表示的头且无 body；零后缀返回 416；补齐响应头并验证 50 次连续 seek 的流槽回收 |
| 高 | 核验成功的 hash URL 事实上可读任意已安装包，没有会话准入 | Broker 为每个 controller 持有默认空的精确文件集合；只有原生授予的当前代际资源可读，检查发生在初始化库/读取磁盘之前，OPTIONS 也受约束，授权预检不初始化库或打开文件。正式构建不存在页面自授入口 |
| 高 | 换代后缓存及浏览器持有的旧流仍可继续读取，无法保证及时归还槽 | 许可原子撤销；后台清除旧核验缓存；COM Read/Seek/Clone 检查许可，后台在在途读取退出后关闭文件并归还槽，不依赖浏览器放下 COM 引用。新增保留原流及 Clone 引用的撤销回归 |
| 高 | 导入 worker 在 current_thread runtime 中阻塞 recv，SQLx 连接归还任务被饿死，后续库查询池超时 | 改为 Tokio 有界异步接收；导入单槽/即时受理不变，新增空闲时连续查询 20 轮的回归。完整测试暴露过该故障，修复后通过 |
| 中 | 包结构/摘要通过后直接发布，没有调用已经存在的媒体探测器 | 完整包验证、安全解包后，从固定投影读取真实容器；核对 asset.kind 和 MIME。动画/超尺寸/伪造 MIME 在发布与索引前失败并清 staging；重复导入同样复核媒体资格 |
| 中 | JPEG 尚无探测；PNG/WebP 只在前 1 MiB 搜标记，既可误拒压缩字节，也可漏掉后段动画块 | 增加 JPEG SOF/EXIF 方向；PNG/WebP 按真实块边界有界跳读，检查块/RIFF 长度及结束事实，检测前缀之外的动画。第四轮准备器补齐八种 EXIF 方向，镜像图片可标准化后导入 |
| 高 | 容器与摘要通过后仍未证明当前 WebView2 能解码；损坏的视频压缩帧可能发布入库 | `ImportJobs::start` 必须传入 ProbeClient；发布前及重复导入均执行独立可见 WebView2 的 metadata/play/首帧/中段及近尾 seek，最多 15 秒，无帧返回 probe_inconclusive。首帧、中段、尾部故意损坏的 VP8 包分别在对应阶段失败，均不发布 |
| 高 | 取消/失败若只等页面回执，可能在后台请求、核验缓存或浏览器持有文件时清 staging/提前归还 decoder | 原生精确授予单个已核验、固定句柄的 job 文件；作用域活动计数覆盖请求、缓存、响应、COM 文件与 Clone。撤销、独立 controller Close 成功及活动数归零后，才回执并归还账本配额；保留 COM 外壳不保留文件 pin。延迟退出/迟到成功、IPC 取消及真实窗口 WM_CLOSE 回归通过 |
| 中 | 实测 WebView2 将无可用像素流的 PNG 也 decode 为透明图，不能据此证明像素完整 | 后台增加 png 0.18.1 流式像素与 CRC 校验。第四轮将原图准备改为独立 320 MiB 工作区，标准化产物再使用常驻解码配额探测；压缩图片限制 32 MiB。正确 CRC 但缺失 deflate 像素流、像素及结束块 CRC 损坏均拒绝安装 |
| 中 | 原图没有方向/色彩标准化与缩略图；重复导入无法复用派生结果 | 新增 image_prepare：有界 PNG/JPEG/WebP 原生解码、八方向映射、RGB ICC→SDR sRGB、在线性光下以预乘 alpha 面积缩放，输出去除 EXIF/GPS/ICC 的 sRGB PNG；默认 render ≤4096 单边/8,294,400 像素，thumbnail ≤512 单边。按输入哈希/准备器版本/固定输出参数索引不可变代际，逐文件哈希复核后复用；坏缓存生成新代，不覆盖旧租用文件。全部媒体探测通过后才发布 |
| 中 | 缓存满时只能拒绝，损坏重建留下的旧代际和崩溃孤缓存会不断累积；按文件递归删除可能误删仍在使用的代际的一部分 | 新增 AssetStore 派生缓存回收：同根原生文件写门、拒绝删除共享的目录租约、实际文件字节计账、闲置 LRU、改名到专用回收区后删除。租约传递到媒体固定句柄及其后续持有者；缺失/非法索引只清索引，原包与作品不受缓存淘汰影响；Windows junction/伪造 DB 路径拒绝回归通过 |
| 中 | 相同内容重复导入仍每次占用独立探测容器，且没有可随环境变化失效的成功证明 | 第六轮新增 Library 成功资格缓存及独立迁移；绑定完整内容/元数据/探测器和页面版本/原生环境，最多 4096 条、7 天 TTL 与 LRU。controller/流退出后再写，环境未知或变化不写；命中不替代原包完整核验、准入或呈现预算。真实图片/视频命中及失败反例通过 |
| 中 | 只有剩余空间检查，没有执行 20 GiB 内容库上限；多 AssetStore 可并发发布，数据库原包大小不能代表完整占用 | 第七轮按 packages 的真实原包/投影/收据及孤立文件长度计量，解包前预检、改名前复核；容量不足返回 library_full，保留原内容。有效同 hash 包不重复申请容量；跨实例原生写门覆盖导入、恢复、物理退出及暂存清理，竞争失败者不删除另一任务的 staging。扫描拒绝 junction/reparse point |
| 中 | 图片始终生成固定的最大 render，预览和较小输出不能复用专用变体；缓存核验只检查尺寸上限 | 第八轮将已规划的实际像素/cover/contain 接入同一导入管线，规范化参数进入派生键，限制预览，保留原图及独立代际；核验源尺寸/方向、目标应得尺寸、PNG 实际尺寸和 hash。相同目标复用、不同目标并存、旧媒体 pin 阻止回收与 EXIF 后尺寸规划均有回归 |

## 实现边界

- P1-02 的 library/assets/jobs、P1-04 的 budget/session、P1-06 的系统采集仍主要是内核，尚未完整接入管理协议、配置选择与真实运行编排。`mod.rs` 中的 dead_code 放行和 app 现有状态字段能直接说明这一点，不能把单元测试通过写成产品闭环完成。
- `applyMedia` 和保留域拦截已能在真实 WebView2 呈现图片、视频；Broker 已强制执行每 controller/代际的精确准入集合和撤销。正式版本目前只有内置场景选择，集合保持为空；用户选择到稳定 AssetRef、TargetPlanner 授权、重启恢复仍待 P1-05 接线。原生冒烟使用显式 `wallpaper-media-probe` debug feature 驱动准入，正式及 release 构建不接受该测试命令。
- 导入已接通容器与摘要复核、PNG 像素/CRC、原生图片准备、独立可见 WebView2 的标准化图片 decode 与视频首帧/seek。Broker 对 job 的 staging 文件使用原生固定句柄，页面不能指定 staging 根路径；探测不触发已安装库初始化。PNG/JPEG/WebP 均执行原生像素解码；JPEG decoder 的容错行为不等于严格位流完整性验证。第六轮补齐持久环境资格缓存，相同字节/探测版本/本机环境在有效期内可省去重复解码，未知或变化时重新探测。启动恢复只恢复文件/索引事实，不能把 installed 当作跨环境永久可播声明；缓存也不能替代运行时坏帧处理或 TargetPlanner 的预算准入。
- 图片原图使用独立 320 MiB 工作区，按输入字节、decoder/转换缓冲、RGBA 输出和固定元数据/ICC/编码余量预检，超预算在构造 decoder 前拒绝；库 limits 为辅助约束，不宣称硬限制进程 RSS。当前没有缩放解码，64 MP 的格式上限不意味着所有 64 MP 输入都能在工作区中处理。支持 RGB ICC；无配置图片明确按 sRGB 解释，已声明但当前无法转换的 HDR/cICP、非 sRGB PNG gamma/色度、非 RGB ICC 明确拒绝。PNG 元数据解压限 8 MiB、ICC 限 1 MiB；PNG 的尾部 EXIF 与结束块 CRC 也检查。
- 第八轮图片准备器已接受原生调用方规划的目标像素与适配方式；preview 限制目标及派生像素，low/medium/high 使用调用方规划后的尺寸，不自行推断屏幕或复制质量表。不同目标变体沿用原工作区与缓存 owner；没有目标的导入继续生成通用图。真实显示器/画质到请求、从多个包内 variants 选取最小合格输入、缺少变体时的 prepare_required 调度仍属于 TargetPlanner/库 UI；当前不能称产品选择链路已完成。
- 派生缓存已经写入 derived_entries，发布前按实际文件字节执行 2 GiB 上限；第五轮补齐活动目录租约、闲置代际 LRU、旧代际/崩溃孤缓存和回收区清理。目录租约随 PreparedImage 与媒体固定句柄的最后持有者退出；先原子移入 derived/.trash，再删文件，无法退出的文件仍计账。启动及导入后台执行清理，无常驻轮询；不同 AssetStore 实例通过同一个原生文件写门协调。第七轮实现独立 20 GiB 持久内容配额；staging 峰值仍由单准备槽、有界输入和剩余空间另行约束，不对已安装内容自动淘汰。派生描述符仍待 TargetPlanner/库 UI 消费。
- 准备与探测已使用 `budget::global()` 的同一生产账本，按编码尺寸/可信 CFR 或 VFR 上界及缓冲估算先保留配额。桌面与预览的 TargetPlanner 尚未接入，因此没有声称整个产品的 decoder/GPU 预算已经闭环。管理 v2/原生选文件/P1-05 产品 UI 尚未连接 ImportJobs；本轮真实导入由明确的 debug feature 回归驱动调用同一管线，没有给正式页面增加路径导入或授权命令。
- 舞台持久媒体 M0–M2、P1-05 库 UI、多屏/轮播、P2/P3 和 AI 工作包不属于当前已实现出口。本次没有用临时 blob 或扩展旧 IPC 冒充这些能力。
- 多屏热插拔、真实设备切换/休眠、电池、发布候选长稳、真实大视频内存与硬解证据，仍需按设计验收。已存在的 loopback 发声测试保持显式忽略，本次没有播放测试音。

## 验证

第三轮 desktop/wallpaper 常规测试共 218 项通过（desktop 199、wallpaper 19），普通与 all-features 测试构建均检查；两项真实环境 loopback 测试默认忽略。第二轮显式执行其中不发声的生命周期测试并通过，发声项未运行。第一轮 studio 的 10 项 wallpaper 测试通过。原生媒体验证命令与结果见下文，测试构建与正式构建分别检查。

- `cargo test -p hertz-desktop -p hertz-wallpaper --quiet`
- `cargo test -p hertz-desktop -p hertz-wallpaper --all-features --quiet`
- `cargo test -p hertz-studio wallpaper::tests --lib`
- `cargo clippy -p hertz-desktop -p hertz-wallpaper --all-targets --all-features -- -D warnings`
- `cargo test -p hertz-desktop wallpaper::jobs::tests --quiet`：9 项导入回归单独重跑通过。
- `cargo test -p hertz-desktop wallpaper::audio_capture::tests::loopback_lifecycle_without_playback -- --ignored --exact --nocapture`：真实默认设备连续三次打开/停止/重开，以及无效固定设备 ID 拒绝；没有发声或改音量/设备。4.75 秒完成，不把无 PCM 静音误报失败。
- `node scripts/check-wallpaper-runtime.js`：新增调度、画质、释放及迟到回调检查。
- `node scripts/check-wallpaper-clock.js`：真实 Chrome/WebGL 时钟、像素读回、暂停与冻结。
- `node scripts/check-wallpaper-media-native.js`：隔离配置下真实 WorkerW/WebView2、GET/HEAD/Range、50 次 seek、图片与视频首帧、静音、冻结/恢复、伪造收据拒绝、失败及卸载。
- `node scripts/check-wallpaper-import-native.js`：真实 ImportJobs→staging Broker→独立 WebView2→关闭及物理流退出→发布；PNG/JPEG/WebP/EXIF 旋转、重复导入、坏 PNG/视频首帧/中段/尾部、15 秒无帧、IPC/原生窗口取消、两 decoder 被占满时拒绝及释放后重试。每次终态检查 staging、流数、账本配额，以及设置中心仍打开。
- `node scripts/check-wallpaper-package.js`、`node scripts/check-space-stage.js`、`node scripts/check-frame-gates.js`。
- 共享 Zodiac 运行时已通过 `node tools/build-stages.mjs` 重建；同时更新生成产物与构建 manifest。

浏览器脚本使用环境现有 Playwright 模块。原生脚本拒绝已有桌面进程，每次使用独立输出与配置目录，只清理自己启动的宿主。

原生长播使用固定的无音轨 64×48/12 fps/2 秒 VP8 fixture（生成方式及 SHA-256 见 [fixtures/README](../scripts/fixtures/README.md)），已经完整软件解码校验。替代先前依赖桌面合成的 MediaRecorder 造样本：实际发现过只生成 110 字节容器头、没有视频帧的情况，不能把该样本用于首帧或播放结论。脚本记录每次媒体请求，并对真实视频中段/近尾 seek 验证帧时间与尺寸。

长播实测（WebView2 `156.0.4314.58`，Windows `10.0.26200`）：600.009 秒、7183 次真实视频帧回调、300 次循环，浏览器统计 7247 个视频帧、0 dropped；19 个采样窗口都持续收到视频帧。9 个进程的树级 private bytes 从 538.25 MiB 到 447.66 MiB，句柄从 4195 到 4305（采样最大 4367）；这些是整棵 WebView2 进程树实测，不等于 decoded-asset 预算或显存。完整证据为 `output/playwright/wallpaper-media-native-1793527635912/video-soak.json`，请求证据为同目录 `media-requests.json`。撤销后未命中旧缓存，3 秒内可重新写开媒体文件，随后失败/卸载/重挂检查通过。

最后对 OPTIONS 免 I/O 分支再次构建并重跑完整原生冒烟，确认预检后 `wallpaper.db` 尚未创建，GET/HEAD/Range/视频 seek/撤销/重挂均通过。随后重新构建普通无 feature 二进制，`WALLPAPER_EXPECT_DEFAULT_DENY=1` 原生检查通过：页面伪造准入命令没有原生确认，也不能读取有效包。当前 `target/debug/hertz-desktop.exe` 为该普通构建。

第三轮真实导入证据：`output/playwright/wallpaper-import-native-1793534295452/evidence.json`（同目录含 `visible-probe.png` 与原生日志）。15 个导入/重试场景通过；正常 VP8 的三个回调时间为 0.000、1.000、1.833 秒，中段坏帧在 `middle_seek` 拒绝、尾部坏帧在 `tail_seek` 拒绝，之前分别已有 1 和 2 个真实帧回调。JPEG EXIF Orientation=6 从编码 3×2 正确呈现为 2×3。无帧任务约 15 秒截止并关闭 controller，包含随后缓存/流回收的最终回执为 15.273 秒；没有以超时提前归还槽。IPC 取消和向本次测试 PID 的探测窗口发送 WM_CLOSE 均为 cancelled，设置中心继续存在。

本轮随后再次完整运行原有原生媒体冒烟（GET/HEAD/Range、50 次 seek、图片/视频首帧、冻结恢复、撤销与重挂）通过。最后重新构建普通无 feature 二进制，负向原生检查确认页面既不能调用准入测试命令，也不能调用新导入测试命令；当前二进制保留为普通构建。本轮没有重跑第二轮的 10 分钟长播，也没有用这些小媒体样本宣称完成硬解、GPU 显存或大视频长稳验收。

第四轮图片准备验证：desktop/wallpaper 共 228 项测试通过（desktop 209、wallpaper 19，另两项硬件测试忽略），普通与 all-features 构建分别检查；Clippy all-targets/all-features 的 `-D warnings` 通过。新增测试覆盖八种 EXIF 的逐像素位置、预乘 alpha 消除透明色边、线性光缩放、P3 ICC 色值转换与 alpha 保留、原生导入携带 ICC/EXIF 的 PNG 后原包逐字节不变、派生元数据剥离、PNG 尾部 EXIF/CRC、工作区在真实退出前不归还、缓存复用及旧 render 被持有时的损坏重建。

第四轮原生证据：`output/playwright/wallpaper-import-native-1793539206226/evidence.json`，19 个导入/重试场景通过。5000×1000 PNG 实际生成 4096×819 render（1,741,644 字节）及 512×102 thumbnail（14,292 字节），在 WebView2 `156.0.4314.58` 中完成标准化 PNG decode。该场景 debug 构建总耗时 16.330 秒，包含原生准备；WebView2 探测的独立 15 秒期限从准备完成后开始。EXIF 2 保留 3×2，EXIF 5/6 输出 2×3；复用、损坏缓存新代发布、文件摘要与尺寸、sRGB 标记、无 EXIF/ICC/文本元数据均由脚本检查。每次终态 prepareCpuBytes/prepareTasks/activeStreams 均归零。原有完整原生媒体冒烟随后再次通过。

新增依赖限定为 image `0.25.10` 的 JPEG/PNG/WebP features 和 moxcms `0.8.1`，已锁定 Cargo.lock 并补充 NOTICE。`cargo +1.88.0 check -p hertz-desktop --all-features --locked --target-dir target/msrv-wallpaper` 在 Windows 上通过。OSV querybatch 对新增的 image/image-webp/moxcms/pxfm/zune-jpeg/zune-core/byteorder-lite/quick-error 八个锁定版本查询均无已知漏洞命中（2026-11-01）；这只覆盖新增版本，不是全仓库审计。尚未测量发布构建体积和图片准备过程的进程峰值 RSS。

第四轮结束时再次构建普通无 feature 二进制，原生负向回归通过：页面不能调用授权或导入测试命令。当前 `target/debug/hertz-desktop.exe` 保留为普通构建（17,655,296 字节；测试 feature 构建约 22.38 MB），没有遗留本轮启动的桌面进程。正式产品的 ImportJobs 管理入口尚未接线，普通构建体积不能据此代表后续完整产品的解码器成本。

第五轮缓存验证：新增六项缓存回归和一项导入/媒体租约集成回归。`cargo test -p hertz-desktop -p hertz-wallpaper --all-features --quiet` 共 235 项通过（desktop 216、wallpaper 19），另两项硬件测试保持忽略；Clippy all-targets/all-features 的 `-D warnings` 通过。本机未取得 symlink 创建权限，因此最终用无需提权的真实 Windows junction 验证缓存扫描及中间路径拒绝，没有用跳过测试替代该证据。覆盖被租用的最旧项跳过、最后引用退出后淘汰、DB 字节少报仍按文件长度计量、全被租用时 cache_full 且代际完整、崩溃回收区与缺失索引幂等恢复、原包保留及缓存重建。针对性变异临时将目录租约从 share_mode(3) 改为 share_mode(7)，保护活动代际的测试按预期失败；源码随后恢复，日志为 `output/wallpaper-cache-lease-mutation.txt`。本轮无新增依赖或数据库迁移，缓存所有权仍在 AssetStore，配置和管理协议没有新增入口。

第五轮原生证据：`output/playwright/wallpaper-import-native-1793545410615/evidence.json`，WebView2 `156.0.4314.58` 下 20 个导入/重试场景通过。新增断言实际验证闲置损坏代际删除、注入的无索引代际在下次导入时删除、当前有效缓存继续复用；原有旋转/镜像/大图、坏像素/坏视频、超时、IPC/原生窗口取消和 decoder 满额反例保持通过。每个终态的准备工作区、任务槽及活动流均归零。随后完整原生媒体冒烟通过；重新构建普通无 feature 二进制后，负向原生检查确认授权与导入测试命令均不可用，没有遗留本轮启动的桌面进程。本轮未重跑 10 分钟/8 小时长播，也未据此宣称内容库配额、完整产品 UI 或大视频硬解已经完成。

第六轮资格缓存验证：新增八项测试，普通与 all-features 的 desktop/wallpaper 均为 243 项通过（desktop 224、wallpaper 19），另两项硬件测试保持忽略；Clippy all-targets/all-features 的 `-D warnings` 和 Rust 1.88 `--all-features --locked` 检查通过。覆盖持久化后新 Library/ProbeClient 复用、环境变化失效、探测前后变化不保存、浏览器版本不匹配/未知环境不保存、内容/元数据/浏览器与环境绑定、旧 adapter 版本拒绝、TTL/时钟倒退、4096 条 LRU，以及缓存数据库故障仍实际探测；键另绑定受信页面源码摘要。解码失败、不确定、资源忙及取消后的迟到成功均不写证明。针对性变异移除环境前后相等检查后，`qualification_discards_environment_changes_during_probe` 按预期失败，源码已恢复；日志为 `output/wallpaper-qualification-environment-mutation.txt`。

第六轮原生证据：`output/playwright/wallpaper-import-native-1793547810969/evidence.json`，WebView2 `156.0.4314.58` 下 21 个导入/重试场景通过，其中 6 次资格命中；重复图片与视频均断言 cacheHits=1、probeRuns=0。每次请求创建新的 Library/ProbeClient，证明复用来自 SQLite，非客户端内存状态。原生通过 DXGI `CheckInterfaceSupport(IID_IDXGIDevice)` 查询全部 adapter 的驱动版本，不以 D3D feature level 或缺省空值代替驱动标识；实际 controller 与安装 runtime 分别读取。超时/取消/预算竞争场景通过仅 debug feature 的 forceProbe 显式执行实际探测，避免缓存命中掩盖这些反例。每次终态工作区、准备槽与活动流均归零；原有完整原生媒体冒烟随后通过。最后重新构建普通无 feature 二进制，负向原生检查确认页面无法调用授权及导入测试命令；当前二进制保留为普通构建，没有遗留本轮启动的桌面进程。真实显卡驱动升级、OS/Edge 更新、远程会话和更多硬件矩阵的实际切换仍属于平台验收，不能用注入环境测试代替。

第七轮（2026-11-02）先按用户要求检查当前项目磁盘占用，清理主 target 的旧依赖/增量缓存、target-verify、MSRV/交叉构建，以及 tools 与历史验证快照中的重复 Cargo 产物。按 D 盘可用空间差值释放 186.37 GiB，清理后可用 221.54 GiB；源码、未提交改动、验证 JSON/截图/长稳日志、临时源码快照及运行中的播放器保留。主 target 的完整 Cargo clean 因正在运行的 hertz-studio.exe 停止，后续仅清理已确认的增量与独立构建路径。记录为 `output/disk-cleanup-2026-11-02.json`；后续验证统一设置 `CARGO_INCREMENTAL=0`，不把历史多次构建继续堆入增量缓存。

第七轮内容配额验证：新增八项回归，普通与 all-features 的 desktop/wallpaper 测试均为 251 项通过（desktop 232、wallpaper 19），另两项硬件测试保持忽略；Clippy all-targets/all-features 的 `-D warnings` 和 Rust 1.88 `--all-features --locked` 检查通过。实际文件测试覆盖原包/深层投影/收据/无索引文件计量、精确满额、原内容和暂存保留、派生容量独立、跨 AssetStore 写门及 Drop 释放、路径越界拒绝、真实 Windows junction 拒绝。导入集成回归验证完整安装大小在解码前拒绝、满额去重成功、新增拒绝、预检后外部占用在发布前重新拒绝、竞争写者/启动恢复不可越过写门且不清理另一任务暂存；取消回归另断言真实解码退出之前写门不可重取。没有新增依赖或数据库迁移。

第七轮原生证据：`output/playwright/wallpaper-import-native-1793561305142/evidence.json`，WebView2 `156.0.4314.58` 下 24 个导入/重试场景通过、8 次资格命中。debug feature 将测试库上限缩小到实际已安装内容的 1247 字节，重复导入仍成功；新增 1248 字节安装被 `library_full` 在真实探测前拒绝，既有原包摘要与目录字节数均保持，恢复默认上限后重试成功。该测试复用生产配额/发布管线，容量覆盖仅在 test 或 debug probe feature 编译；没有向正式页面开放容量修改入口。原有完整原生媒体冒烟随后通过。最后重新构建普通无 feature 二进制，原生负向检查确认页面不能调用授权或导入测试命令；没有遗留本轮桌面测试进程。MSRV 临时产物随后清理，验证重建后 D 盘仍有 219.32 GiB 可用。本轮验证的是小库边界和正确性，没有用它代替百万文件扫描耗时、真实满盘 I/O 故障或产品库 UI 验收。

第八轮先按用户要求提交第五至七轮改动，提交为 `1083cd7`；其它界面改动未纳入。目标变体新增五项测试，普通与 all-features desktop/wallpaper 均为 256 项通过（desktop 237、wallpaper 19），另两项硬件测试忽略；Clippy all-targets/all-features 的 `-D warnings` 和 Rust 1.88 `--all-features --locked` 检查通过。覆盖 cover/contain、横竖图、不放大、预览及桌面限额、规范化缓存身份、不同目标并存、相同目标资格命中、实际目标收据核验和旧媒体 pin 生命周期。原像素方向/ICC/透明缩放回归继续通过，没有增加依赖或迁移。

第八轮原生证据：`output/playwright/wallpaper-import-native-1793576160044/evidence.json`，WebView2 `156.0.4314.58` 下 29 个导入/重试场景通过、9 次资格命中。1280×640 原图对 80×80 cover 生成 160×80、contain 生成 80×40；3840×2160 preview 请求规范化为 960×540，实际派生为 960×480。重复目标复用同一目录并命中成功资格，三个目标代际独立并存，原包 hash 不变；JPEG EXIF=6 的目标图实际为 1×2。所有任务终态的准备工作区、准备槽、活动流及独立 controller 均退出。目标参数仅经 debug feature 驱动同一生产管线，未新增正式页面命令。最后恢复普通无 feature 二进制，原生负向权限检查通过，没有遗留本轮桌面测试进程；MSRV 临时产物清理，继续关闭增量缓存。

复现命令（先按本机环境设置 `PLAYWRIGHT_MODULE`）：

```powershell
cargo build -p hertz-desktop --features wallpaper-media-probe
node scripts/check-wallpaper-import-native.js
$env:WALLPAPER_MEDIA_SOAK_SECONDS = '600'
node scripts/check-wallpaper-media-native.js
Remove-Item Env:WALLPAPER_MEDIA_SOAK_SECONDS
cargo build -p hertz-desktop
$env:WALLPAPER_EXPECT_DEFAULT_DENY = '1'
node scripts/check-wallpaper-media-native.js
Remove-Item Env:WALLPAPER_EXPECT_DEFAULT_DENY
```

## 后续工作与所缺证据

| 工作包 | 剩余实现 / 接线 | 已有证据与剩余验收 |
| --- | --- | --- |
| P1-02 本地库与任务 | 正式管理协议、配置选择及库 UI 接线（随 P1-05） | 固定快照、安装事务、恢复/取消/重复导入、跨 AssetStore 写门及 20 GiB 内容配额已有回归；不再列为未实施内核，用户操作与重启恢复仍需产品端到端验收 |
| P1-03 媒体准备 | 视频封面准备；更多媒体边界与硬件验收 | 图片方向、RGB ICC、线性透明缩放、目标像素变体、元数据剥离、不可变重建、派生缓存回收、环境资格缓存及 20 GiB 内容配额已有回归；仍需真实图像集峰值内存、更多 ICC/高位深边界、1080p/大视频内存与硬件解码计数，以及真实驱动/OS/runtime 升级与更多设备资格。首帧/中段/尾部坏帧、无帧 inconclusive、取消与独立容器回收已通过原生回归；真实目标/包内候选选择仍需 TargetPlanner 接线 |
| P1-04 资源会话 | TargetPlanner 接入全局 BudgetCoordinator；app 使用 WallpaperSession 四事实；JS AssetAdapter/ResourcePool/Scope 的真实租约 | 预览/导入/桌面竞争最后 decoder，取消最后等待者，共享纹理不被误 dispose，交接峰值及暂停 5 分钟释放 |
| P1-05 本地库 UI | 原生文件对话框的一次性 token、management v2、config v5、库/导入进度、预览及 AssetRef 应用 | 用户导入→预览→应用→重启恢复；不启动播放器仍可用；旧配置迁移、回执丢失、候选失败不改旧引用 |
| P1-06 输入 | 单个系统采集/分析 owner 接入配置与真实会话；设备通知及 none/Hertz/system 切换 | 真设备切换、采集中热拔失联、系统静音、休眠恢复；没有消费者时停止采集。无效固定 ID 不回退的采集内核检查已通过 |
| P1-07/08 | 多屏 single/mirror/span、组时钟、收藏轮播、引用保护 | 混合 DPI/负坐标/旋转/拔插、局部全屏、整机预算、失败停止轮播 |
| P1-M0～M2 | 原服务舞台持久库、流租约、稳定引用保存/恢复与备份 | 删除源后恢复、原子删除重导入、跨客户端 revision；DBX 视频还需实际宿主有界流协议与发行资格，8 小时换租约 |
| P2/P3/AI | 组合 compiler、扩展节点/编辑器、安全 worker、分发与受管 AI 流程 | 按各自工作包出口验证；不以当前图片/视频轻后端覆盖这些能力 |
| 平台长稳 | 设备/拓扑矩阵与整棵进程树、GPU 引擎观测 | RDP、Explorer 重启、睡眠、电池、8 小时稳定性；小尺寸 VP8 fixture 不代表 1080p/4K 硬解达标 |
