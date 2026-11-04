# 壁纸实现审查与修复记录

日期：2026-11-01；第七至十七轮续审：2026-11-02；系统音频新鲜度、本地库引用、原生界面与视频封面续审：2026-11-03。审查基线：`0b421d4`，对照 [开发设计](desktop-wallpaper.md)。各轮实现与验证记录见下文，提交以 Git 历史为准。

## 结论

现有实现交付了 P0 的主要运行路径，以及 P1 的库导入、固定版本选择、单媒体独立预览/应用/重启恢复和若干资源内核；仍不能按 P1 完整产品验收。主要问题集中在安装失败后的收敛、媒体信任来源、UI 线程 I/O、资源释放和时钟语义。本次修复了已实现路径中的这些问题，并补充行为测试。

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
| 中 | 稳定资源引用没有原生目标规划入口；缺少目标图时只能重新导入，尚不能用已安装包补图 | 第九轮新增单媒体 TargetPlanner：核验 AssetRef 后读取固定包/实测容器元数据，选择最小足够输入；显式变体不替换，作者尺寸/用途不作真值。resolve 只查询已核验派生，缺失/损坏返回 prepare_required；ImportJobs 同一 worker 从已安装包补图，沿用写门、预算、探测和取消清理 |
| 中 | 预算将 8 MP/s 预览保留带当成纯视频硬上限，不能按真实源速率使用剩余输出总额 | 纯视频预览可使用剩余全局额度，桌面与预览共同校验 120 MP/s；GL 预览仍受 8 MP/s 限制。规划复用原生媒体成本公式；admit 取得整笔预算后才授予固定文件，失败/旧代际不改变旧权限或提前归还旧 token |
| 中 | 解析后仍可在准入时传入另一套目标；会话就绪事实与实际媒体预算/退出所有权分离 | 第十轮将规范化目标封入只读 ResolvedMedia，预算不再接收替代目标；WallpaperSession 原子准入后持有预算与精确文件 scope，只接受对应媒体后端的首帧。换代/失败/缺屏/停用先撤销并保留占用，独立 controller 关闭且全部文件读者退出后才归还该 token；Rust Drop 不冒充退出，旧回收不能清除新授权 |
| 中 | 缺屏恢复复用旧 generation，迟到握手/帧可能补齐新实例事实 | 第十轮 display_restored 为新 controller 递增代际并重新等待四事实；旧握手、首帧、关闭回执均不作用于新实例 |

## 实现边界

- 正式本地库已支持导入、固定版本选择、收藏筛选、作品/版本删除；单图片/视频可以独立预览、应用到桌面并跨重启恢复。系统输入已接入一个共享采集/分析 owner。当前实现与各轮证据分别记录，不能将这些子项等同于完整 P1 产品验收。
- Broker 按 controller/代际执行精确准入和撤销；TargetPlanner 使用实际目标与可信媒体事实，现有准备 worker 负责缺图重建与当前环境资格。单媒体候选及预览使用统一媒体预算，等 controller 关闭和文件读者退出后归还额度；全局 GL、多资源总保留和 JS 资源租约仍待接线。正式构建不接受页面自授资源的测试入口。
- 图片已有 EXIF/RGB ICC/线性透明缩放、目标像素变体和不可变派生；准备工作区上限 320 MiB、派生缓存 2 GiB、持久内容 20 GiB。支持边界及反例见各轮记录；这些成本估计不等于硬限制进程 RSS，也不证明任意 64 MP 图片或大视频可用。视频封面生成与库/设置页静态读取已验证；桌面播放/首帧故障的静态封面已接线；冷启动缺包/坏包、准备失败的已保存选择封面已接线；更多媒体格式边界及设备资格仍待验收。
- 配置日志、原生 settings 草稿与预览租约已接线。选择包版本先登记原生草稿才显示完成；删除检查全部已保存配置域、草稿、预览及活动/退出中的会话。work 草稿/编辑器、舞台持久媒体 M0–M2、多屏/轮播、P2/P3 与 AI 仍不属于已完成出口。
- 原生文件对话框正向点选、其他删除故障窗口、真实设备切换/热拔/睡眠、电池、RDP、发布候选长稳与大视频硬解仍缺完整证据。音频硬件测试默认忽略，显式运行结果与测试音使用情况见系统音频续审记录。

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

第九轮（2026-11-02）验证：新增六项规划/预算/准备集成测试，desktop/wallpaper 普通与 all-features 均为 262 项通过（desktop 243、wallpaper 19，另两项硬件测试保持忽略）；Clippy all-targets/all-features 的 `-D warnings` 和 Rust 1.88 all-targets/all-features 检查通过。覆盖按实测像素选择、确定性同尺寸排序、显式变体/不存在变体、非法逻辑引用、60 fps 编码与输出成本、纯视频预览使用剩余总额、桌面/预览交错竞争、退出前仍占额度、预算拒绝保留旧准入、迟到代际仅撤回本次额度、坏缓存要求准备、准备与导入争用同一槽、取消后实际退出与清 staging、删除源后补图且原包不变。

第九轮原生导入/规划证据：`output/playwright/wallpaper-import-native-1793579942574/evidence.json`。WebView2 `156.0.4314.58` 下 30 个原有及包内变体导入/重试场景通过；额外完成删除导入源后的 prepare_required→单槽后台准备→真实标准化图片解码→ready→相同 contentKey/URL 复用。1280×640 原图对 41×41 cover 输出 82×41；新派生通过一次真实 WebView2 探测，stagedBytes=0，准备槽/工作区/活动流均归零。作者将 80×40 变体谎报为 9999×9999、160×80 变体谎报为 1×1，自动规划仍选后者；显式选择前者保留该输入且不放大，不存在的引用明确拒绝。固定 VP8 样本的实测上界为 12.048192771 fps，960×540 预览输出为 6,245,784 px/s、64×48 编码解码为 37,013 px/s，不套用 GL 的 15 fps。

原有完整原生媒体回归随后通过（`output/playwright/wallpaper-media-native-1793579986062/media-requests.json`）：GET/HEAD/Range、50 次 seek、精确准入/撤销、真实视频中段与近尾帧、冻结恢复、释放与重挂均通过。最后恢复普通无 feature 二进制，负向原生检查确认页面不能自行授予资源访问，也没有测试命令回执；没有遗留本轮桌面测试进程。本轮未重跑 10 分钟/8 小时长播，未据此声称大视频/硬解或完整产品链路验收通过。

本轮只交付单媒体规划内核与现有 worker/Broker/账本接点；没有新增依赖、数据库迁移、配置 schema 或正式页面命令。实际显示器质量分配、多个资源的 session 总保留/子额度、app 四事实与释放屏障、JS ResourcePool、正式库 UI 和视频封面仍属后续工作。

第十轮（2026-11-02）会话前置接线验证：新增八项预算/scope/单媒体会话集成测试，desktop/wallpaper 普通与 all-features 均为 270 项通过（desktop 251、wallpaper 19，另两项硬件测试保持忽略）；Clippy all-targets/all-features 的 `-D warnings` 和 Rust 1.88 all-targets/all-features 检查通过。覆盖规范化目标准入与只读计划、桌面拒用预览额度、错误后端/准入前帧不参与就绪、三项运行事实缺一不 ready、重复/旧代际准入只回收本笔额度、预算失败保留当前授权、旧 scope 回收不撤销新权限、克隆/排队读者屏障、controller 关闭与读者退出的两种先后顺序、缺屏恢复的新代际、失败/停用与 Drop 保留未确认占用、已退出 token 的精确墓碑回收。固定 VP8 文件经原生容器探测和测试探测器安装后，双代际占满两个 decoder，旧 controller 未关闭时第三笔仍拒绝，关闭后才可获批；这是会话内核证据，尚无 app 的媒体选择/建窗/关闭端到端证明。

第十轮原生证据：`output/playwright/wallpaper-import-native-1793588723387/evidence.json`，WebView2 `156.0.4314.58` 下 30 个导入/重试场景及额外规划请求通过；回执新增固定 target，图片 41×41 与视频 preview 的规范化 960×540 均与成本申请一致。删除源后补图、实测候选选择和原有损坏/取消/超时/预算反例继续通过。完整原生媒体回归 `output/playwright/wallpaper-media-native-1793588783894/media-requests.json` 同时通过 GET/HEAD/Range、50 次 seek、真实视频中段/近尾帧、图片/视频首帧、冻结恢复、撤销与重挂。最后恢复普通无 feature 二进制，负向原生授权检查通过。新会话的 controller 关闭回执在内核集成测试中模拟，本轮原生回归验证既有导入探测/页面媒体路径，不代替尚未接入的 app 会话验收；没有重跑长播或大视频/硬解验收。

第十一轮（2026-11-02）接入正式库与导入入口。设置页新增按需展开的本地作品列表、原生导入、版本查询、任务进度与取消；重新展开可发现正在导入的任务。导入回执丢失按 requestId 查询；前端重复等待同一请求复用 Promise，异内容复用拒绝。后台严格限制四个实际排队/执行调用，文件选择单实例，令牌随机、单次、60 秒、绑定设置代际及只读文件句柄；关闭/换代立即撤销。旧对话框的迟到结果不能给新设置代际发能力，同用户管道也不能借用当前设置 owner。

install_jobs 新增 requestId 唯一索引，接受身份与 queued 状态同一事务提交；worker 复用现有单槽，失去通道时持久化失败并归还源句柄。最终状态包含包 hash 和错误，重启查询/同请求重试不会重导；未完成记录变 interrupted。查询 2 秒观察期限，初始化在独立后台继续完成，观察者超时不能重复启动恢复或阻塞其他控制请求。IPC 服务端、Rust/JS 客户端及设置页同步升级到请求 16 KiB/响应 64 KiB；列表只返回摘要，长描述在详情读取。

裸 PNG/JPEG/WebP/MP4/WebM 从固定快照按魔数识别，经同一准备槽和原生写门封装为 HWPK 后继续原校验/探测/发布流程；图片 32 MiB、视频及最终包 512 MiB 上限继续生效。流式复制使用固定缓冲并检查取消，原文件写入/删除在导入真实退出前被拒绝，终态前释放源句柄。源文件改名后二次导入仍复用首次 manifest 和包；未声明第三方授权，不把本机路径写入包。

第十一轮配置改为 schema v5：audioInput、单个/多个布局组模型、typed selection、presentation、显式 primary/fixed/unresolved 显示身份。旧 v1～v4 依顺序迁移，先完整验证、flush 原文件备份再原子替换；新字段未知/越界拒绝。旧扁平字段只在迁移或旧管理入口解码，落盘不再出现。builtin 参数从真实 registry 导出的 catalog 补全，规范化参数传入渲染器；Hertz 来源过期/不合格回到用户显式保存的等待场景。未绑定域可独立保留/恢复；新来源使用自己的默认意图，不自动拿走未绑定域。实际呈现当前只受理一个 single 组的内置/跟随场景与 none/Hertz；系统输入、多屏、作品引用等尚未接线的意图不会被静默当作普通场景绘制。

截至第十一轮并未实现配置提交日志、正式 settings 草稿/apply/preview、媒体桌面会话、视频封面或完整 P1-05 产品闭环（日志与 settings 子集由第十二轮补齐），能力返回 mediaApply=false/previewMedia=false。原生文件对话框正向选择的整条 UI 操作尚未自动驱动：正式服务测试使用真实只读句柄/token 验证导入，原生 WebView2 回归通过 debug 输入驱动同一管线；不可把这两类证据拼成完整“用户点选→媒体应用”验收。

第十一轮收齐的原生验证：v5 管理/迁移回归为 `output/playwright/desktop-management-native-1793597119608`；36 个导入/重试场景为 `output/playwright/wallpaper-import-native-1793597483673/evidence.json`，包含 PNG/JPEG/WebP/WebM 裸媒体、改名去重、非法媒体、真实坏帧、超时、取消和预算竞争。随后真实 WebView2 媒体检查及普通构建默认拒绝检查通过。正向原生文件对话框 UI 仍未自动驱动。

第十二轮（2026-11-02）补齐单活动配置日志。内部保存、旧设置入口和正式 apply 共同使用该提交边界。调用 SID、摘要、base/target revision、完整候选先 flush；配置写 lastCommit 并以 write-through 原子改名；最后结束记录，未完成期间不能接受另一提交。启动/查询按真实配置摘要协调，目标吻合补 committed，base 吻合记 not_committed，不重放候选；均不吻合则 config_conflict，保留文件并拒绝写入。原生独占文件锁覆盖跨 Windows 会话使用相同目录的交错；16 MiB/256 条/至少十分钟保留限制不能用提前淘汰规避。操作查询按 command 类别区分配置与安装，读取配置日志不会初始化作品数据库。

设置页改用正式 settings 草稿 create/update/discard、apply 与 preview acquire/update/renew/release；草稿随机 id 绑定原生设置会话/profile/基线，拥有独立修订，1–32 个类型化修改按整批校验。错误更新不改草稿，来源/配置变化不自动重设基线。应用同一配置日志；重启或原设置 owner 消失后，原 requestId/摘要仍返回保留的保存结果，异内容复用拒绝，旧成功不能把旧画面应用到较新的配置。预览租约改用原生随机句柄，事件绑定 iframe/lease；切页、关闭、来源切换、应用和到期关闭，管道不能借用当前设置 owner。保存与运行失败继续分开；动态媒体的完整资源会话/预算闭环尚未接入。

新增 `scripts/check-wallpaper-config-native.js` 已在隔离真实 WebView2/命名管道/文件系统通过：草稿/预览只读，实际配置临时路径写入失败保留原字节/revision 和原草稿，重试不重复写入，查询不建立 wallpaper.db；重启后补齐 config 已替换但 journal 尚 pending 的终态，并拒绝不匹配配置的新提交。证据 `output/playwright/wallpaper-config-native-1793603375458/report.json`。该测试构造精确的崩溃磁盘检查点再启动真实进程，不声称进行了定时断电或 OS 崩溃注入。正式管理回归为 `output/playwright/desktop-management-native-1793603398222/report.json`，原生位置调整/设置/真实 WorkerW 绘制为 `output/playwright/desktop-settings-native-1793603381783`。窗口位置脚本原来的固定 500 ms 观察偶发先于 Win32 事件完成，改为有界等待同一条件并保留 position-boundary.json；没有放宽边界断言。

第十二轮最终验证：desktop/IPC/wallpaper 普通与 all-features 均为 **336 项通过**（desktop 281、IPC 36、wallpaper 19），另两项声音硬件测试保持显式忽略。新增八项日志测试、两项草稿测试、一项正式信封测试和一项配置提交集成测试，覆盖崩溃前/后、单活动终态屏障、文件门互斥、SID/摘要去重、十分钟/256 条保留、坏日志保留、原配置/内存不被旧回执覆盖。Clippy all-targets/all-features 的 `-D warnings`、Rust 1.88 all-targets/all-features `--locked` 检查通过。设置浏览器、运行时、clock 与 76 项帧门检查通过；设置页另验证仅收到“已应用”状态消息时仍锁住在途草稿，只有对应保存回执才能解除，避免用户的新编辑被迟到消息覆盖。

再次完整运行 36 个原生导入场景（`output/playwright/wallpaper-import-native-1793603092993/evidence.json`）和原生媒体检查（`output/playwright/wallpaper-media-native-1793603127569/media-requests.json`）：实际图片/视频首帧、中段/近尾视频帧、50 次 seek、准入/撤销/旧代际、冻结恢复与卸载重挂继续通过。最后恢复普通无 feature 二进制并通过默认拒绝检查；新的配置日志/草稿检查、原生设置与 WorkerW、通用/正式管理均在普通构建下再次通过。没有据此宣称媒体应用、长稳、大视频/硬解或正向文件对话框 UI 已完成。

第十三轮（2026-11-02）补齐作品选择的后台入口 `selection_plan`：从原生 workKey/packageHash 核对 installed 版本的准确归属，使用未分页 EXISTS 查询，避免被详情页最多 100 个版本的展示上限影响。资产入口来自重新核验的原包 manifest，不能由 UI 摘要或 URL 推断。后台任务与正式管理命令共用四个 admission 名额，缺图继续提交给同一个 ImportJobs 单准备槽；取消会等待任务完成真实清理、发布终态后才回执。服务测试删除原导入文件后验证可解析与复用派生，并用会观察取消但延迟退出的探测后端验证：等待期间既不回执，也不提前归还管理和准备槽。该入口还未被 app 的正式媒体应用调用，不能据此打开 mediaApply 能力。

内置桌面 controller 现持有 WallpaperSession；原生以不可变初始化脚本签发随机会话 id 与当前 generation，页面发送类型化 pageHandshake/firstFrame。app 同时核对 IPC 所属 controller、会话 id、代际与后端；DOM/mount 完成消息不再改变正式就绪事实。GL 只有后端实际返回 submitted=true 才报告首帧，图片只在 decode 完成后报告，视频只接受 requestVideoFrameCallback；不支持此回调明确失败，不以 loadeddata 代替。host 内容先隐藏，四事实完成后原生才发 reveal；这不是 P2 的窗口 alpha 渐显，也不宣称已证明物理扫描输出。诊断新增 firstFrameReady、会话/后端及 retiringControllers，内置暂停/恢复同步到同一 Session。未握手或获准开始绘制后一直没有真实帧会进入有期限的恢复路径；策略暂停期间不累计首帧等待。

app 的停用、重建、挂载丢失和退出统一撤销文件访问并保留退出 owner；controller.Close 失败保留原 surface，成功后显式销毁 WebView 与 HWND，再等待文件读者和会话资源退出。退出 owner 未结束时不创建替代 controller，不能靠 Drop/页面 emptied/超时提前抹掉占用。当前原生验证覆盖成功关闭与重新创建；尚未注入真实 COM Close 失败，媒体预算交接及独立媒体预览仍待后续接线。内置资源使用已有宿主事实，不能把这次四事实接线称为桌面 GL/GPU 全局预算已经闭环。

第十三轮验证：普通与 all-features 均为 **337 项通过**（desktop 282、IPC 36、wallpaper 19），另两项声音硬件测试忽略；Clippy all-targets/all-features `-D warnings` 和 Rust 1.88 all-targets/all-features `--locked` 检查通过。JS 运行时增加真实提交/未提交、图片未解码、视频 loadeddata/帧回调、无帧回调引擎、显式揭幕与迟到回调的验证；设置浏览器、clock 和 76 项帧门通过。clock 的“四次心跳”原来依赖其他步骤耗时，现在直接有界等待原来的同一条件，没有降低断言。

真实 WebView2/WorkerW 设置检查为 `output/playwright/desktop-settings-native-1793606650350/native-session-lifecycle.json`：验证当前会话 GL 首帧、原生初始化身份不可改写、旧代际/异身份消息不改状态、手动暂停/恢复维持同一会话、停用使 CDP target 实际退出、再次启用取得新身份和更高代际。测试的旧命名管道在客户端之间短暂重建，脚本仅对连接尚未建立且没有发送字节的 ENOENT/ECONNREFUSED 做有界重连，已发命令/超时均不自动重放。配置日志/草稿回归为 `output/playwright/wallpaper-config-native-1793606011037`，正式管理为 `output/playwright/desktop-management-native-1793606017922`。36 个原生导入场景为 `output/playwright/wallpaper-import-native-1793606131212/evidence.json`；真实图片/视频首帧、seek、冻结恢复和卸载回归为 `output/playwright/wallpaper-media-native-1793606165018/media-requests.json`，普通构建已恢复并通过默认拒绝检查。媒体应用/预览能力仍为 false，完整导入→预览→应用→重启出口仍未完成。

第十四轮（2026-11-02）把单媒体选择接到真实桌面与独立预览：库详情的“选择此版本”只修改 settings 草稿，点击应用才把固定 workKey/packageHash 和原生物理目标提交给后台选择服务。准备/资格检查复用 ImportJobs 单 owner 和同一份控制名额；安装状态不当作当前环境永久可播证明。准备结束后再次核对原生草稿 owner、revision/profile 和显示器几何，再经原配置日志保存。暂停期间准备的媒体在挂载前也重新核对显示器，目标改变即重新规划，避免按旧尺寸准入。修复了内置替换构建失败时提前返回，导致已保存歌词/可见性等公共状态不同步的问题。

新媒体保留独立配置快照并建立候选 controller；旧桌面继续自己的呈现，当前原生身份/代际的正确后端首帧完成后才提升窗口透明度并交接。预检失败不改配置；提交后解码失败保留保存意图、实际旧画面和两套 revision，明确重试才创建新候选。原请求重放只返回原保存回执，不创建第二个 controller。冷启动从稳定版本与已安装字节恢复，不重新读取导入源。静态图片不保留 GL canvas 或连续帧循环，视频保持静音原速并按源帧率、编码尺寸、真实物理输出计账；FPS/场景质量设置不冒充视频降采样。

媒体预览复用同一 WallpaperSession 状态机，使用独立原生窗口与 controller；Preview owner 只接受预览目标，Desktop owner 只接受桌面目标，分别解释 scoped 暂停。预览 client 最大 640×360 物理像素，原生核对实际尺寸；不与设置页 iframe 共用 decoder，也不新增 GL context。设置窗口、15 秒租约和当前草稿限定它的生命周期；切页、关闭、转应用、过期、硬策略及失败均可独立回收，预览不写保存配置。桌面与视频预览实际共占两个 decoder，软暂停桌面不暂停预览且继续保留两笔占用。退出时先撤文件 scope，COM Close 成功及文件读者退出两道屏障都满足才归还额度；CDP target 已消失而文件尚在退出时，仍看到 decoder 保留是正确行为。当前 `mediaApply` 与 `previewMedia` 均为 true，不能以此覆盖视频封面、全局 GL/多资源预算或完整 P1 产品验收。

第十四轮验证：普通和 all-features 均为 **340 项通过**（desktop 285、IPC 36、wallpaper 19），另两项声音硬件测试保持忽略。Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过。设置浏览器增加真实版本按钮、只改草稿、fit、静态/视频控件语义、pending 锁定与能力控制的独立预览回归；JS 运行时、clock 与 76 项帧门通过。一次全 workspace 测试被本机正在运行的 `hertz-studio.exe` 文件锁中断；未终止该实例，上述完成范围为三个受影响 crate。

普通构建完整单媒体证据为 `output/playwright/wallpaper-presentation-native-1793613774729/presentation-report.json`（13 组验收）。素材先通过 feature 构建的真实导入/准备探测安装，原文件随后删除；正式验收恢复普通构建，从真实库按钮选图，开启独立原生图片预览并应用，核对固定文件授权与原请求幂等，重启恢复图片；验证错误 work/version 配对在保存前拒绝，保存后的候选解码失败保留旧画面与实际 revision，明确重试后新会话才接管。视频验收覆盖真实时钟推进、静音、桌面软暂停冻结/恢复、桌面与预览同时保留两个 decoder、预览转应用、丢续租后的独立回收、预览 decode 故障不关闭设置或改保存配置、重启恢复及停用后两道退出屏障。图像/视频为小型软件 fixture，不代表 1080p/4K 硬解资格；OS 文件对话框的正向点选没有包含在此自动化中。

本轮 36 个真实导入场景为 `output/playwright/wallpaper-import-native-1793613720714/evidence.json`，媒体轻后端/Range/seek/撤销与冻结恢复为 `output/playwright/wallpaper-media-native-1793613754743/media-requests.json`；已恢复普通构建，并通过 `wallpaper-media-native-1793613816653` 的默认拒绝检查。配置日志/草稿、原生设置/WorkerW 和正式管理回归分别为 `wallpaper-config-native-1793613821206`、`desktop-settings-native-1793613828260`、`desktop-management-native-1793613845382`（均在 `output/playwright/`）。本轮未创建提交。最终普通二进制 `target/debug/hertz-desktop.exe` 的 SHA-256 为 `8b0fcaaafd84f190266588467731325bbe0e36dfa52fefb34f893ace5f56bbae`；本轮呈现验收已在该产物上复跑通过。验收脚本仅对尚未建立连接、没有操作字节发出的 ENOENT/ECONNREFUSED 作有界重连，已连接请求的超时/重置不重放。

第十五轮（2026-11-02）接入系统音频输入：桌面与设置预览共用唯一 `AudioService`，由它持有 WASAPI shared/event loopback 采集、2048 点分析窗与 250 ms 环形缓冲。请求只保留最新来源，切换按“代际递增并清旧频谱 → `stop_and_join` 等旧线程真实退出 → 清空样本与分析器 → 打开新输入 → 首个合法样本生效”执行；默认设备随系统默认变化重新绑定，固定设备失联不回退其它设备，错误需显式重试。桌面暂停/隐藏只撤销桌面消费者，预览仍可独立持有同一采集；无消费者时停止并等待线程退出，桌面与预览同时运行时继续共用一个 generation。慢渲染页面每槽最多一帧在途，完成后取最新帧，旧完成不能解锁新帧。

设备通知由 `DeviceWatch` 注册 `IMMNotificationClient`，回调只递增 revision 并唤醒 owner 线程，设备枚举与 COM 打开不在 UI 线程。设备移除/恢复、默认设备切换与混合格式变化的顺序另由 fake backend 回归覆盖：固定设备失联后不跟随默认设备，恢复后才重开；格式变化会递增代际并完成真实退出屏障，任何时刻最多一个活动采集。`validate_format` 同时拒绝无法在 250 ms 缓冲内提供 2048 点分析窗的极低采样率，并保留 96 kHz 等常规格式。

第十五轮验证：普通与 all-features 均为 **351 项通过**（desktop 296、IPC 35、wallpaper 20），另两项声音硬件测试保持忽略；Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 检查通过。真实默认渲染设备的两项 ignored 采集测试通过（连续三次打开/停止/重开与无效固定 ID 拒绝，未发声、未改设备或音量）。`check-wallpaper-runtime.js`、`check-desktop-settings-browser.js` 与 `check-wallpaper-clock.js` 通过；clock 首次在负载较高的测试机上因 rAF 低于脚本阈值失败，重跑通过，未放宽断言。

原生音频证据为 `output/playwright/wallpaper-audio-native-1793617608279/audio-report.json`：13 组场景、0 errors，覆盖无系统消费者时不采集、真实预览回环频谱、预览转桌面复用同一 owner、桌面与预览共用一个 generation、桌面暂停保留预览、最后一个消费者关闭并 join、设置关闭保留桌面 owner、冲突预览不能切换桌面设备、默认与固定别名共用实际 endpoint、固定设备失败与显式重试、固定 ID 精确打开、切到 Hertz 清空系统频谱、切到 none 停止采集。该报告生成于最后一次 `sourceKey` 序列化与采样率下限小改动之前；`sourceKey` 已由运行时回归覆盖（不依赖 JSON 字段顺序），采样率下限由单测与真实设备采集生命周期测试覆盖，本轮未把这些小改动并入同一份原生报告，也未重跑原生音频。

系统音频后续仍缺真实环境证据：OS 默认设备切换、运行中热拔、系统静音与休眠恢复未自动驱动（测试脚本明确说明只操作当前默认物理 endpoint，未改 OS 默认或音量）；这些不能由 fake backend 的顺序测试代替。原生重跑另受本机正在运行的 `hertz-desktop.exe`（桌面歌词宿主）文件锁限制，未终止用户实例。

本轮未创建提交。

第十六轮（2026-11-02）补齐作品/版本删除与引用保护。管理协议新增 `wallpaper.library.deleteWork` 与 `wallpaper.library.deleteVersion`；后者必须同时给出 workKey、版本号和精确 packageHash，后台重新核对三者归属。app 在提交前汇总当前配置、未应用设置草稿、内置/媒体预览、活动/候选/准备中的壁纸与选择任务，任一仍引用该作品或包即返回 `asset_in_use`；删除进行期间拒绝 `DraftUpdate`、`Apply`、`PreviewAcquire`、`PreviewUpdate` 以及 legacy apply/preview 命令，避免检查后又新增引用。

删除顺序是：内容写门 → 只读计划遍历该作品全部版本（不受详情页 100 条展示上限影响）→ 移除不再被任何版本引用的包目录 → 库行短事务。共享包保留；删除最后一个版本时清理作品行；重复删除幂等；目录先于库行移除，崩溃后只会让包在启动恢复中标记 unavailable，而不会被重新导入成作品。设置页作品列表新增“删除版本”“删除作品”入口，确认后调用正式命令并刷新列表；`asset_in_use` 显示为可操作提示。

验证：普通与 all-features 均为 **361 项通过**（desktop 306、IPC 35、wallpaper 20），另两项声音硬件测试保持忽略；新增删除/引用回归覆盖 API 严格字段、配置引用匹配、库计划与共享包、最后版本清理、缺失版本、包目录移除，以及服务端“先删目录再删行”。Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 `--locked` 通过；设置浏览器回归覆盖删除版本/作品的请求载荷，运行时与 clock 检查继续通过。本轮未进行原生删除 UI 端到端验收（本机桌面宿主仍在运行并锁定二进制），也未注入删除中途崩溃；这两项仍属后续证据。

本轮未创建提交。

第十七轮（2026-11-02）补齐作品收藏与筛选。管理协议新增 `wallpaper.library.favorite`（workKey + 布尔收藏状态），只改 `works.favorite`，不触碰包/版本引用；`wallpaper.library.list` 增加 `favoritesOnly`，与普通列表共用同一 `created_at|work_key` 游标，收藏筛选可分页且不会把非收藏页混入。设置页作品行增加 ☆/★ 收藏按钮，切换失败保留原状态；工具栏增加“只看收藏”，取消收藏时若筛选开启则重新读取列表，普通切换只更新当前行。

验证：普通与 all-features 均为 **363 项通过**（desktop 308、IPC 35、wallpaper 20），另两项声音硬件测试保持忽略；新增收藏写入、缺失作品、收藏筛选游标以及 API 严格字段回归，服务测试同时覆盖 favorite 与 favoritesOnly。Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 `--locked` 通过；设置浏览器回归覆盖收藏请求载荷、状态更新与筛选后行数。收藏轮播、播放暂停冻结与失败停止仍待后续实现，原生收藏/删除 UI 仍受运行中宿主文件锁限制。

本轮未创建提交。

系统音频新鲜度续审（2026-11-03）：原 `Frame.captured_at` 在 FFT 分析完成时赋值，线程延迟会把旧 PCM 重新标记为新声音；环形缓冲只限制样本数，采集中断后的小包还能拼接旧历史，FFT 平滑也可能带回中断前的能量。本次将 WASAPI `GetBuffer` 的首样本 QPC 时间按实际采样率换算为末样本单调时间，沿环形缓冲、分析和分发传递。超过 250 ms 的窗口不分析；间隔超过 250 ms 或 DATA_DISCONTINUITY 清空 PCM，下一整窗重置分析器；TIMESTAMP_ERROR、无效/未来包时间、空包和倒退时间戳均不能刷新频谱。`dropped` 计入过载、过期和中断时丢弃的未消费样本，正常滑窗覆盖仍不算丢弃。仅增加现有 windows crate 的 Performance feature，未新增 crate 或迁移。

新增六项回归覆盖采集时间不被分析延迟刷新、过期窗口拒绝、断流后的完整新窗、旧包/空包不刷新、WASAPI 100 ns 单位与采样率换算，以及真实 owner 对过期/恢复/滤波的处理。普通与 all-features 测试各 **369 项通过**（desktop 314、IPC 36、wallpaper 19），两项真实设备测试另外显式运行通过；Clippy all-targets/all-features `-D warnings`、Rust 1.88 all-targets/all-features `--locked`、设置浏览器、频谱运行时、clock 和 76 项帧门检查通过。旧硬件脚本先 join 再读 PCM，实际等待会让窗口超过有效期，首次运行因此正确拒绝；脚本已改为在采集活动时验证非零频谱，然后单独验证真实退出及重开，未放宽时限。

本次普通构建的原生系统音频证据为 `output/playwright/wallpaper-audio-native-1793636262951/audio-report.json`：13 组场景、0 errors，真实 48 kHz endpoint 产生非零频谱，桌面/预览共享、暂停与最后消费者退出、固定 ID 失败/重试、none/Hertz 切换均通过。该报告包含现有 sourceKey 修复、采样率下限和本次时间戳改动，补齐第十五轮报告未在最终源码上复跑的缺口。媒体回归为 `output/playwright/wallpaper-presentation-audio-1793636244001/presentation-report.json`：13 组预览/应用/恢复/退出场景通过；素材来自旧测试库的只读 SQLite 备份与不可变包副本，原导入源已删除，本轮未重新导入。普通构建默认拒绝检查为 `output/playwright/wallpaper-media-native-1793636433357`。

本次验收普通二进制 SHA-256 为 `32d72bdd4be17090a394504638202286a7dbea279d03ad75127d68d1868dacf0`，机器可读记录见 `output/wallpaper-audio-freshness-2026-11-03.json`。测试使用独立配置，结束后没有遗留本次桌面宿主。未修改系统默认设备或音量；OS 默认设备切换、运行中热拔、系统静音、睡眠恢复及长稳仍待真实环境验收。本次未创建提交。

本地库引用与原生界面续审（2026-11-03）：新增普通构建的真实 WebView2 库验收，先复现并修复两处删除保护漏洞。第一处只检查当前活动 wallpaper，忽略非活动 profiles 和保存的 unboundDomain，导致其他来源仍引用的包被删除；现在由 Config 汇总所有保存域，停用不释放持久引用。第二处“选择此版本”原先只改页面本地草稿，直到 Preview/Apply 才登记原生引用；现在先 await 原生草稿 update，再完成页面选择，其他管道客户端同样受保护。登记期间锁住选择/删除/应用/预览，登记失败保留原草稿；此操作不提交配置。退出 owner 另保留配置引用，直到 controller 和文件读者全部退出才允许删除。错误提示改为指向相应来源、草稿和预览，避免仅提示切换当前桌面。

失败证据分别是 `output/playwright/wallpaper-library-native-1793663342304/library-failure.json`（非活动配置引用被删）与 `wallpaper-library-native-1793663513170/library-failure.json`（未应用版本选择被删）。修复后的最终证据为 `output/playwright/wallpaper-library-native-1793663912597/library-report.json`：普通构建 **11 组、0 errors**，覆盖停用/非活动图片与视频配置、活动 profile 下保存的 unboundDomain、收藏/筛选与跨重启、取消删除、未应用草稿与另一管道客户端、真实独立预览、当前桌面及重启后的引用拒绝、切回内置并排空后删除最后版本、删除作品后启动恢复不复活。拒绝场景同时核对磁盘配置未变、原包 hash 未变且版本仍为 installed；成功删除核对目标包消失、另一包保留，最后 decoder/prepareTasks 为零。

设置浏览器回归新增延迟原生草稿登记时的按钮锁定/原选择保留，以及拒绝登记不覆盖旧草稿；Config 测试覆盖 profiles/unboundDomain 跨保存、切换与解除引用。普通与 all-features Rust 测试各 **372 项通过**（desktop 317、IPC 36、wallpaper 19；硬件两项保持忽略），Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过；设置浏览器与频谱运行时通过。13 组媒体呈现回归为 `output/playwright/wallpaper-presentation-library-1793663908757/presentation-report.json`，普通构建默认拒绝证据为 `output/playwright/wallpaper-media-native-1793664010410`。最终二进制 SHA-256 为 `9229c3204c16edf0be4ea973ab7d02d0c93390ac226f681e9dd273d20b94777e`。

新增脚本 `scripts/check-wallpaper-library-native.js` 只操作隔离测试库：从既有样本库只读 SQLite backup 并复制不可变包；每次启动使用不同测试 CDP 端口，防止旧 WebView2 退出期间连到旧端口。测试拒绝已有桌面实例，结束仅关闭本次 PID；本轮没有遗留测试宿主。素材导入源已不存在，但本轮没有操作原生文件对话框，也未注入 COM Close 失败、延迟文件读者或删除中途 OS 崩溃。机器可读证据索引为 `output/wallpaper-library-review-2026-11-03.json`，本轮未创建提交。

视频封面续审（2026-11-03）：接续中断会话，完成 P1-03 的视频封面生成与 P1-05 库/设置页读取。在原有单个解码资格 controller 的中段真实帧上生成最长边 320 px、JPEG ≤24 KiB 的封面，不放大小视频；仍需近尾帧通过及原生 controller/文件读者退出后才处理回执。后台复核压缩像素、尺寸和摘要，复用同一派生缓存的不可变代际、2 GiB 额度与目录租约；失败是可选封面缺失，不修改原视频或把失败解码记为成功。重复导入复用封面与当前环境的资格证明，封面损坏时下一次显式准备会重新探测并生成新代。

新增 `wallpaper.library.poster` 只接受准确的 workKey/packageHash，以安装事务保存的有界 manifest 选择资源摘要，再校验静态缓存；不扫描、解压或重新计算视频原包摘要。后端一个阻塞读槽持续到实际 I/O 结束，页面串行读取并限制待处理键/静态缓存；列表按可见范围读取，选中视频直接显示静态封面。浏览、缺图与损坏均不申请视频 decoder，也不自动触发准备。普通构建测试会在私有测试副本中暂时移开 original.hwpkg，验证静态读取仍然成功，再恢复原包后继续真正的预览准备。

本轮另先复现并修复刷新竞态：旧的“无封面”回执跨越刷新/准备完成后仍会写入已清空的页面缓存，让新封面继续显示占位。浏览器回归挂起旧请求、刷新后再交付 null，修复前明确断言失败；现在读取绑定刷新修订，过时回执在同一队列槽内重新读取，选中作品及列表的迟到回调不改新状态。失效事件同时清掉列表旧图并重新观察可见项，封面重建后无需折叠、重开版本列表。

视频封面最终验证：普通与 all-features Rust 测试各 **376 项通过**（desktop 321、IPC 36、wallpaper 19；两项音频硬件测试保持忽略），Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过；设置浏览器、壁纸运行时与 76 项帧门检查通过。封面新增三项 Rust 测试覆盖像素/尺寸/身份验证、损坏不可变重建、缓存复用与旧代租约/配额保护、取消和解码失败；API 测试要求准确版本身份并拒绝路径。

真实导入 **36 场景**为 `output/playwright/wallpaper-import-native-1793679620686/evidence.json`（显式 `wallpaper-media-probe` 构建）：真实视频得到 64×48、1853 字节 JPEG，重复导入复用同一代；损坏首帧/中段/近尾、超时、取消、占满 decoder 与内容配额反例均通过。最终普通构建封面 **6 组、0 errors** 为 `output/playwright/wallpaper-poster-native-1793679824012/poster-report.json`，验证准确版本、静态读取不打开原包、库与选中封面无 decoder、损坏占位、显式预览重建后两处界面更新、原包摘要不变、重启恢复及实际退出后配额归零。截图为同目录 `selected-video-poster.png`。

最终普通构建的媒体呈现 **13 组**为 `output/playwright/wallpaper-presentation-native-1793679676369/presentation-report.json`，默认拒绝页面自授资源为 `output/playwright/wallpaper-media-native-1793679858648`；二进制 SHA-256 为 `becc7422c7ee335b17c12ea0a9331d60b4cfe24580bb25dec46b601fd0389aa7`。汇总索引为 `output/wallpaper-poster-review-2026-11-03.json`。测试使用刚经真实导入创建的隔离样本库；封面测试再以只读 SQLite backup 复制该库。未覆盖正向 OS 文件点选、运行时故障的桌面封面、删除中途崩溃、1080p/4K/硬解或设备长稳，不能据此宣布完整 P1 验收。本轮未创建提交。

桌面故障封面续审（2026-11-03）：视频的 ResolvedMedia 在同一后台目标解析中持有一份已校验、固定 JPEG 和目录租约，不新增故障时读盘任务或解码 owner。视频播放报错或无旧桌面的候选首帧失败后，先通过原 RetiringWallpaper 撤销视频文件 scope、关闭 controller 并等待读者退出；原预算归还后，才用同一个 WallpaperSession 的图片准入呈现封面。图片有独立 CPU/GPU/目标预算，decoder、GL context、连续像素率为零；新 scope 仅授予已固定封面，不能复用原视频 URL。动态视频选择始终保留在配置中，临时封面不写配置、不改成永久图片作品。

宿主新增 `staticPoster` 诊断，实际媒体/frameKind 为 image，并保留视频失败信息；设置页显示“视频播放失败 · 显示静态封面”和重试按钮，不显示“视频正在运行”。封面禁用鼠标动画和动态 motion；显式重试才重新准备视频，真实首帧接管后关闭封面并清错误。存在正常旧桌面时仍保留旧桌面；封面自身解码失败直接结束，不再尝试另一层封面。策略暂停/五分钟软暂停卸载保留的是固定图片引用，退出后恢复时重新准入；显示器尺寸变化重新固定原生目标，不清除失败状态或重开视频。

本次还修复恢复播放失败被静默忽略的问题：原 `applyMediaMotion` 空吞 play() rejection，现在当前播放尝试被拒会进入统一故障路径；尝试序号和媒体身份阻止主动暂停、替换媒体产生的迟到拒绝误报新会话失败。运行时回归覆盖实际拒绝与主动暂停两种相反情况。新增 Rust 测试验证封面静态成本、像素真值、写锁与目录租约、重新选定图片目标，以及无封面/图片不能再回退。

桌面故障封面最终验证：普通与 all-features Rust 测试各 **377 项通过**（desktop 322、IPC 36、wallpaper 19；两项声音硬件测试保持忽略），Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过；运行时、设置浏览器、鼠标交互浏览器与 76 项帧门检查通过。普通构建 **12 组、0 errors** 原生封面证据为 `output/playwright/wallpaper-poster-native-1793681151704/poster-report.json`，新增播放中 error、首帧 play 被拒、恢复 play 被拒、封面自身失败不循环、原配置不变、新旧文件 scope 分离、图片真实 decode/首帧、显式重试和原视频恢复。

同一脚本以 `WALLPAPER_LONG_PAUSE=1` 完成真实五分钟暂停：**300866 ms** 后旧图片 controller 实际关闭；恢复得到不同 sessionId 的图片会话，decoderSlots=0、错误与配置保持。未缩短生产超时、未替换系统时钟。桌面截图为同目录 `desktop-failure-poster.png`。测试只对尚未连接的 ENOENT/ECONNREFUSED 有界重连，已发送写请求不重放；封面静态查询在 budget_busy 时等现有读槽。

最终普通构建另通过 **13 组媒体呈现**回归 `output/playwright/wallpaper-presentation-failure-1793681233156/presentation-report.json` 和默认拒绝 `output/playwright/wallpaper-media-native-1793681512950`。SHA-256 为 `989ff7b29ac759a498f55afdad4d6e9376cb83bed4863a22266c0d90aeedda13`；汇总为 `output/wallpaper-runtime-poster-review-2026-11-03.json`。故障注入使用真实 WebView2 的 DOM error 和 play() Promise 拒绝，不等同于显卡驱动崩溃；缺包/准备前失败、实际显示器或硬暂停变化、原生文件点选、删除中途崩溃、1080p/4K/硬解和八小时长稳仍未完成。本轮未创建提交。

启动封面与删除崩溃续审（2026-11-03）：补齐缺包/坏包及准备失败的已保存视频恢复。AssetStore 的文件固定区分可选原包 pin 与资源文件 pin，缓存 JPEG 只固定自己的文件及目录租约；不用伪造原视频 DecodeInput，也不会让封面阻止原包修复。库封面查询只接受准确 work/version 的 installed/unavailable 安装记录和有界合法 manifest，缓存摘要/像素继续校验；未知或已删除版本不能凭孤缓存出现。列表允许 unavailable 视频的小图，但没有选择按钮。

同一选择后台在失败后可携带一份已校验封面，返回值依然是失败；取消不读封面，不提前归还选择槽，缺图或坏图直接保留原错误。宿主只有在当前已保存配置/revision 仍匹配、没有正常旧桌面时才显示它，新 Apply 和独立 Preview 仍失败。另修复了迟到选择失败没有核对当前配置便改错误状态的路径。不可用版本的显式重试重新核验原包/投影与当前解码资格，全部成功才恢复 installed；静态封面期间可在线修复原包。未改变保存选择或利用封面掩盖失败。

普通构建封面测试为 `output/playwright/wallpaper-poster-native-1793682082960/poster-report.json`：**18 组、0 errors**，除先前播放故障回归外，覆盖冷启动目录移开、原包损坏、准确 unavailable 元数据与列表封面、缺包重试保留同一图片会话、在线修复/重新 installed、清资格缓存后真实探测 play() 被拒、有封面但新 Apply 仍失败且配置不写、原包和封面同时损坏不循环。截图为同目录 `missing-package-poster.png`。新增 Rust 回归覆盖相同失败链、取消/异作品无封面、修复期间文件可写、成功才恢复 installed、损坏缓存与删除记录不得复活；原有单槽取消/真实退出屏障测试保持通过。

删除崩溃测试新增 `scripts/check-wallpaper-library-native.js <fixture> --crash`。在隔离库中以 Python SQLite helper 持有写事务，真实正式删除仍可读取计划并移除包，随后等待删行事务；观察到包目录消失且请求尚无回执后，只终止本次测试宿主 PID。核对终止点仍有 installed 版本行、配置及另一包摘要不变，再释放 SQL 锁并启动普通宿主。**3 组、0 errors** 证据为 `output/playwright/wallpaper-library-native-1793682199439/library-crash-report.json`：启动恢复标 unavailable 且不复活包；显式重试删除完成，第二次重启作品和包仍不存在。此为真实进程异常退出与受控 SQL 等待点，未模拟断电、OS 崩溃或递归删除每一个文件间的故障。

最终验证：普通与 all-features Rust 测试各 **378 项通过**（desktop 323、IPC 36、wallpaper 19；音频硬件两项保持忽略），Clippy all-targets/all-features `-D warnings`、Rust 1.88 all-targets/all-features `--locked`、设置浏览器与壁纸运行时通过；普通构建另通过 **13 组媒体呈现** `output/playwright/wallpaper-presentation-recovery-1793682333075/presentation-report.json`、**11 组本地库** `output/playwright/wallpaper-library-native-1793682389095/library-report.json` 和默认拒绝 `output/playwright/wallpaper-media-native-1793682402244`。二进制 SHA-256 为 `f5fe70b4c2f2672960dbeb3552c0a9eddc5e66f1876665811c81959b1310d4ea`，汇总 `output/wallpaper-recovery-review-2026-11-03.json`。本轮未创建提交。

正向原生文件点选仍未验收：已读取 Computer Use 技能及其 guidance，后者要求 “Use `node_repl` JavaScript for all Computer Use actions”；当前会话工具中没有 `node_repl`，工具检索也未提供。未启动或遗留等待人工输入的文件对话框，亦未将 Rust fileToken 测试或测试导入入口作为原生点选证据。其他设备、硬解、大媒体和八小时长稳仍按剩余清单推进。

解码竞争与最后消费者取消续审（2026-11-03）：新增 `check-wallpaper-presentation-native.js <fixture> --decoder-competition`，自动以只读 SQLite backup 和不可变包副本创建私有测试库。桌面与独立视频预览实际占满两个 decoder 时，第三个导入返回 `budget_busy: decoder_slots`，未创建第三个 controller，原有两处播放仍存活。关闭预览后，导入可占最后一个槽；此时预览准备不能抢占，取消导入须等探测 controller 与文件读者退出，才允许下一次真实导入成功。所有场景持续检查原桌面 session、实际视频时钟、保存配置和原包摘要。

另覆盖正式 preview owner 在真实资格探测期间释放最后一个消费者：只抑制探测页面首帧回调以稳定停在 preparing，不模拟原生 Close 或退出回执。释放后原 controller 关闭、prepareTasks 归零、decoderSlots 从 2 回到 1，迟到完成不能创建预览；重新申请后独立预览正常播放，再独立退出。该证据限于当前单媒体准备任务，不代表尚未实现的共享资源池多等待者或共享纹理生命周期。

本次 **18 组呈现验收（含新增 5 组竞争/取消）**通过，证据为 `output/playwright/wallpaper-presentation-native-1793683126698/presentation-report.json`，二进制 SHA-256 `8ccb6535eabd2c136c1d9d7e1c33daa778318376da481b52756d0248b45a74fd`。此报告明确为 `wallpaper-media-probe` 构建：仅由测试入口提供固定导入源并强制真实资格检查，桌面、预览、ImportJobs、全局预算与退出路径均使用实际实现，未调用虚构 decoder 预留入口；不算正向原生文件点选验收。生产 Rust/JS 未因本轮验收变更。

正常视频五分钟卸载续审（2026-11-03）：普通构建在手动暂停后持续检查同一 session 与真实 video.currentTime 冻结，每分钟核对 decoderSlots=1。实际等待 **301429.829 ms** 后，旧视频页面/控制器关闭、retiringControllers=0、decoderSlots/prepareTasks=0；继续保持隐藏时没有自动准备或重建。恢复后 sessionId 与 generation 均更新，重新取得一个 decoder、提交视频首帧并实际推进时钟；设置中心保持打开，配置摘要不变。证据为 `output/playwright/wallpaper-presentation-native-1793683185874/presentation-report.json`，包含 **14 组呈现验收**，逐分钟采样见同目录 `long-pause-progress.json`。没有缩短生产 300 秒阈值或替换时钟。

首轮脚本每秒发送新的资源查询，耗尽管理请求去重表 256 条/10 分钟额度，且没有检查失败回执便访问 result，测试提前中断；失败保留在 `wallpaper-presentation-native-1793682672845/presentation-failure.json`。修正为每分钟查询资源、每秒经现有宿主状态接口检查会话和视频时钟，并明确检查查询回执，完整重跑后通过，未更改生产协议限额。

本次源码复核同时确认单屏原位置恢复尚未接线：卸载后新媒体页面只接收 kind/url/fit，未取得上一代播放位置。上述验收证明退出/预算/重新首帧，不证明从暂停位置继续；该实现缺口已明确列入 §13.3 和剩余清单。最终普通二进制 SHA-256 为 `5bde52d8570c92d9a7a6b658e8163ea170f19f35bf64dd56620ac7c060a94f2f`，默认拒绝证据为 `output/playwright/wallpaper-media-native-1793683532831/media-requests.json`。本轮只改验收脚本和文档，Rust/浏览器运行时未改，不重复运行上一轮已通过的 Rust 全套；新增脚本语法及 diff 空白检查通过，无遗留测试宿主。汇总见 `output/wallpaper-lifecycle-review-2026-11-03.json`，未创建提交。

视频卸载位置恢复续审（2026-11-03）：补齐上一轮确认的单屏原位置缺口。当前 MediaAdmission 记录整数毫秒位置，只接受当前随机 sessionId/generation、视频类型及真实时长内的值；页面复用既有一秒心跳并在暂停时立即上报，重复 stop 不重复发送相同位置。MediaAdmission 退出或换代时该位置随本代失效，不能写入下一视频或图片。

策略卸载/几何重建保存一个不含文件、流、预算 token 的内存位置记录，绑定配置 revision、精确包/asset/variant、内容摘要、时长及旧页面绑定。旧 controller 最后的暂停回执可在回收期间补全本记录；恢复仍先完整解析/资格检查并重新准入，全部身份匹配才向新页面传位置，直到新首帧接管才消费记录。新配置、资源变化与失败封面会清掉不适用记录，位置不写磁盘配置。

媒体恢复先 metadata → 校验 duration → seek → 核对 seeked 位置 → 注册实际帧回调并 play → 原四事实揭幕。恢复时不先播放文件起点，也不把 loadeddata/seeked 当作首帧；定位越界/失败、首帧超时与播放拒绝沿已有错误/封面处理。新增 `mediaPositionMs`、`resumePositionMs` 与实际首帧时间诊断，支持核对原生记录及显示帧。设置界面、文件权限和媒体预算仍由现有 owner 持有。

普通与 all-features Rust 测试各 **380 项通过**（desktop 325、IPC 36、wallpaper 19，另两项音频硬件测试保持忽略），包括新增 typed 位置回执与身份/时长匹配测试，以及旧视频代际退出后不能再写位置的集成断言；Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过。默认和全功能日志分别为 `output/wallpaper-resume-default-2026-11-03.log`、`output/wallpaper-resume-all-features-2026-11-03.log`。运行时回归覆盖定位前不播放、不登记首帧，seek 完成仍不提前可见，旧 seek/frame 不能影响替换项，越界位置和无效类型拒绝；设置浏览器与 76 项帧门检查通过。

最终普通构建的真实五分钟验收为 `output/playwright/wallpaper-presentation-native-1793684779834/presentation-report.json`（**14 组**）：先定位到非零位置再暂停，页面冻结在 **901.9 ms**，原生位置记录与其相差不足 1 ms。持续 **300793.568 ms** 后旧 controller/读者退出，decoderSlots/prepareTasks=0；私有原包可临时移开并恢复，证明位置记录没有保留原包 pin。隐藏期间无重建，恢复后的新 session 提交 **917 ms** 的实际首帧，随后时钟继续推进；位置记录在首帧接管后清除，保存配置摘要不变。没有缩短生产超时或替换时钟。

同一最终普通二进制的故障封面回归 **18 组、0 errors** 为 `output/playwright/wallpaper-poster-native-1793685111830/poster-report.json`，覆盖播放/首帧失败、缺包/坏包与修复、准备失败及显式重试；默认拒绝证据为 `output/playwright/wallpaper-media-native-1793685132408/media-requests.json`。最终 SHA-256 `636f72bb12061f3d00db3ee1fb704650b96eae19a770eb56c71e9d1cea202dd3`，汇总 `output/wallpaper-resume-review-2026-11-03.json`。本轮未创建提交，无遗留测试宿主；硬策略及物理显示变化的位置恢复仍留在平台验收矩阵，不以此次手动暂停代替。

暂停确认与首帧候选续审（2026-11-03）：补齐 §12.1 中调用 pause 后的有期限确认。原生当前 MediaAdmission 为一次暂停保留 token 和 2 秒期限，重复 stop 不延长；页面按 200 ms 间隔有界检查 paused、currentTime 与可用 totalVideoFrames，观察稳定后发绑定 sessionId/generation/token 的回执。页面持续推进会报告 media_pause_unconfirmed；即使页面完全不发确认，原生期限仍触发相同错误、controller 关闭和静态封面路径。恢复作废未到期 token，超过期限的恢复不能抹掉待处理故障。确认只是短暂停证据，decoder 仍记账，真实 controller 和流退出之后才归还。

续审同时找到首帧前的遗漏：已开始解码但尚未收到实际帧回执的候选不进入 ready-only 暂停检查。新增普通构建反例以真实视频运行、仅抑制呈现页的帧回调，观察 loading 和推进时钟后暂停；旧构建超过 4 秒未关闭候选，失败证据为 `output/playwright/wallpaper-poster-native-1793686573439/poster-failure.json`（SHA-256 `a91bbcb1be80b6857ab768f0f69f4d3faed7c6b1be1146b83ebefa0937ff3e0f`）。现在未接管桌面的视频候选在策略暂停时直接进入真实退出屏障，恢复重新准备；不会把正常暂停记成作品失败，也不靠其尚未存在的首帧确认停止。

最终普通构建的 **22 组、0 errors** 封面/暂停验收为 `output/playwright/wallpaper-poster-native-1793686710198/poster-report.json`。新增正常短暂停确认并保留同一 session/decoder、pause() 无效、确认回执缺失、首帧前暂停四组。两种故障分别在 **2057.908 ms / 2067.640 ms** 观察到错误，在 **2724.608 ms / 2533.974 ms** 完成 controller 与读者退出、decoderSlots/prepareTasks 归零；后者包含原生轮询和实际关闭耗时，不将 2 秒决策期限表述为所有资源在 2 秒内销毁。首帧前候选 **966.690 ms** 完成退出，保持隐藏不重建，恢复后重新提交实际视频帧。保存配置保持不变，故障后显示静态封面并可明确重试。

默认与 all-features Rust 测试各 **381 项通过**（desktop 326、IPC 36、wallpaper 19，另两项真实音频设备测试保持忽略）。新回执测试覆盖错误 binding/generation、缺失/零/负数/小数/字符串 token、字段混用；集成断言覆盖首帧前/图片无需 ready 暂停确认、重复 stop 不续期、旧 token、迟到回执/恢复、确认后继续记账及实际退出才还槽。运行时覆盖时钟/帧数持续推进、pause 无效、确认后不常驻轮询、恢复/释放后的旧回调；设置浏览器和 76 项帧门检查通过。Clippy all-targets/all-features `--locked -D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过，日志为 `output/wallpaper-pause-{default,all-features,clippy,msrv}-2026-11-03.log`。

包含首帧候选修复的最终普通构建又完成真实五分钟验收：`output/playwright/wallpaper-presentation-native-1793686771556/presentation-report.json` 共 **14 组**。暂停确认后视频时间固定在 **902.3 ms**，两秒排空期限后直到卸载前，WebView2 totalVideoFrames 始终为 **18**；decoderSlots 仍记为 1。经过 **300735.360 ms**，旧 controller/读者退出、decoderSlots/prepareTasks 均归零，原包可临时移开并恢复。恢复的新 session 在 **917 ms** 提交实际首帧，位置记录在接管后消费，暂停确认清除，保存配置不变。没有缩短生产阈值、替换时钟或伪造 decoder 退出。

同一最终二进制默认拒绝检查为 `output/playwright/wallpaper-media-native-1793687103560/media-requests.json`。SHA-256 为 `7e6a2c03eb28d9daac488106095abc7b2d14328ae05a9127f6dc4a40e1a160cd`，汇总 `output/wallpaper-pause-review-2026-11-03.json`；最终 Rust 检查与原生报告均覆盖首帧候选修复。无遗留本次桌面宿主，未创建提交。帧计数证据只覆盖该可信轻后端和小 VP8 fixture；GPU 引擎实际解码、硬策略/物理显示恢复、大媒体与八小时长稳仍待平台验收。

共享纹理消费者续审（2026-11-03）：检查 P1-04 时确认两个原生接线缺口仍存在：内置桌面 GL 的 resource_admitted 仍直接填宿主事实，未向 BudgetCoordinator 取得额度；设置页 GL 预览仍共用设置 controller。未将现有媒体预算或此次 JS 租约修复等同于全局 GL 准入。先修复现有 spatialResources 的真实消费者漏洞：底层封面任务原先捕获第一个消费者的 signal，第一位取消会使仍在等待的第二位永远收不到纹理。反例日志为 `output/wallpaper-shared-resources-before-2026-11-03.log`。

封面和歌词纹理 acquire 现在返回各自独立、只读的租约视图，底层条目持有消费者集合。release 按租约身份校验，重复释放、旧条目同键重建后的释放，以及 cover/text 类型混用均不能减少别人的持有；scope abort 自动消费对应租约，最后一个消费者才取消底层加载并销毁纹理。底层 resolver 使用自己的 AbortSignal；无法立即结束的取消任务继续占用池的 12 项上限和估计字节，直到其 Promise 实际结束。退出后到达的 URL/图片回调不创建资源，不污染同键新条目；整个池销毁后拒绝新 acquire。Stage tasks 诊断包含这些实际未完成加载。

新增 `check-space-resource-leases.js` 覆盖共享加载、第一/最后消费者取消、重复/旧租约/错误类型释放、等待者已取消但 resolver 未结束、额度耗尽与真实结束后再准入、迟到回调和整池销毁。共享 bundle 及 coast/space/zodiac 三份构建 manifest 已一起重建，注册表/质量/清理、**81 次真实 Three.js 场景生命周期**、文字布局回归通过。Rust 源码未变，重新编译并运行内嵌页面大小门通过；不将上一轮 Rust 全套结果作为本轮重新运行的结果。

真实 GL 浏览器证据为 `output/wallpaper-shared-resources-browser-2026-11-03.log`：一个实际舞台 scope 和一个歌词 scope 共用一次解析，舞台 scope 先退出，歌词仍取得纹理并完成 **1 次 GL 上传**；旧租约重复释放不触发 dispose。最后消费者退出后，纹理 dispose 仅 **1 次**，Three.js 已上传纹理计数 **2 → 1**，共享池封面数 **1 → 0**。浏览器使用 SwiftShader 验证实际 GL 调用及渲染，不作为硬件显存或 GPU 性能达标证据。

封面球/封面墙的桌面、移动尺寸、替换和退出通过，证据为 `output/playwright/space-artwork/evidence.json`。原替换测试只推进一帧便要求完成场景的渐变，在旧 HEAD bundle 上也失败，见 `output/wallpaper-shared-artwork-before-2026-11-03.log`；现改为等实际加载任务结束并推进转场帧，未修改生产转场。粒子场景以新增 `--scenes-only` 运行 **6 组场景、3 组移动尺寸**，涵盖颜色替换/混合、旧图退出、取消 16 个连续请求时最多 12 个 resolver 在途、实际结束后 tasks 归零；证据为 `output/playwright/space-particles/evidence-scenes.json`。该运行未启动播放器服务，不计入该脚本后半段完整应用 UI 验收。

普通桌面构建另通过 **13 组呈现回归** `output/playwright/wallpaper-shared-presentation-1793687932276/presentation-report.json`，默认拒绝证据为 `output/playwright/wallpaper-media-native-1793687962251/media-requests.json`。最终二进制 SHA-256 为 `6dee98bbc60493c8fb1357c58de7adcf06a0cd75a3ce506b02a05d45d4300074`，共享 runtime SHA-256 为 `7aa7f2667228a8d93c4684ffb975e15531472772b8ca25b4286146cb8fe9fe85`，汇总为 `output/wallpaper-shared-resources-review-2026-11-03.json`。无遗留桌面测试宿主，未创建提交；通用资源池与原生全局/子额度、GL 预览独立退出及完整 GPU 峰值仍待完成。

独立预览续审（2026-11-03）：内置 GL、图片和视频现由同一个 `PreviewOwner` 管理，均复用原生 `WallpaperSurface`、随机 page binding、正式 settings 草稿/租约和 `RetiringWallpaper` 退出屏障。设置页删除 iframe、场景页协议入口及渲染/频谱转发；音乐快照和系统音频直接交付预览 controller。固定预览 client 最大 **640×360 物理像素**，GL 运行副本限制为 **15 fps**，用户草稿及保存的 FPS 不变；视频继续按实际源帧率计量。更新保持 leaseId，使用新 generation/sessionId，旧 controller 与文件读者未完成退出时不创建后继。旧业务预览入口也进入同一个 owner。

揭幕仅发生在原生会话的 Ready→Running 转换，不能把单次 frame receipt 当作四事实全部成立。新增普通构建验收先拦住真实 GL 首帧回执，确认页面仍隐藏；旧 `wallpaper_ready`、错误 sessionId/generation 和错误 backend 都不能揭幕，随后送达原真实帧才显示。租约及手动暂停、切页、关闭设置、原生 WM_CLOSE、媒体更新、挂载失败和心跳期限均与桌面独立。实际 `WEBGL_lose_context` 注入还暴露了已停 RAF 不再上报丢失的问题：现在丢失事件立即发送无效心跳状态，原生直接关闭该预览，另加运行时回归确认通知和停绘。

最终普通构建 **21 组呈现验收**（新增独立 GL 预览 8 组＋原媒体 13 组）为 `output/playwright/wallpaper-presentation-native-1793690072314/presentation-report.json`。新场景覆盖真实首帧与揭幕、最大物理尺寸/帧门、错误租约与第二 acquire 拒绝、桌面手动暂停不暂停预览、GL→图片→视频→GL 在同一 lease 下换代、媒体 decoder/prepareTasks 回到原桌面基线、上下文丢失、GL 初始化失败、无效 mounted 心跳、租约过期、确认 PID 后发送原生 WM_CLOSE，以及 settings owner 关闭/重开。上下文丢失后 **154.3203 ms** 完成独立预览退出；仅屏蔽续租消息而保留真实绘制/有效心跳时，**15398.1576 ms** 到期关闭，记录 3 次被丢弃的续租。截图为同目录 `builtin-independent-preview.png`。未将媒体状态查询中尚未提供的 GL/GPU 指标表述为显存验收。

最终 Rust 普通与 all-features 各 **381 项通过**（desktop 326、IPC 36、wallpaper 19；两项声音硬件测试保持忽略），Clippy all-targets/all-features `-D warnings` 和 Rust 1.88 all-targets/all-features `--locked` 通过；设置浏览器与场景运行时检查通过。普通构建真实系统音频 **13 组、0 errors** 为 `output/playwright/wallpaper-audio-native-1793690192040/audio-report.json`，验证独立预览与桌面共享同一个 WASAPI owner、频谱直达新窗口、预览退出与设置关闭的消费者边界。原生设置 owner/草稿/配置日志 **4 组** 为 `output/playwright/wallpaper-config-native-1793690272794/report.json`；原生设置窗口完整回归为 `output/playwright/desktop-settings-native-1793690317008`，涵盖新预览、切页关闭及原有保存/位置流程。普通构建默认拒绝为 `output/playwright/wallpaper-media-native-1793690279760/media-requests.json`。配置脚本补上尚未连接的 ENOENT/ECONNREFUSED 有界重试及每次启动的新 CDP 端口，已发送的写请求仍不自动重放。

最终二进制 SHA-256 为 `8356a9225f3d5930cf043c75ffe387e7e512c383e6985c192d2eb8c806a0a4c8`，机器可读汇总为 `output/wallpaper-independent-preview-review-2026-11-03.json`。测试使用既有样本库的只读 SQLite backup 与私有包副本；无遗留桌面宿主，未创建提交。GL 全局 `BudgetCoordinator` 准入、多资源总保留/子额度、通用资源租约与完整 GPU 峰值仍未接通；上下文扩展注入不等于驱动崩溃或真实平台/长稳验收。

会话资源子额度续审（2026-11-03）：先补齐全局 GL 接线所依赖的原生总保留模型。`BudgetCoordinator` 在原有同一把锁与同一份账本中保留完整 `SessionPlan`；可信 TargetPlanner 固定资源 id 及各维度上界，随后资源 acquire 仅划分父保留，不能再次计入目标/预览实例或复制全局字节。新增子 token 绑定父 token、会话、generation、allocationRevision；每资源及会话总量同时核对，未知资源、超额、溢出、错误身份、重复父保留和退出后的新申请均拒绝。无新的页面准入命令，页面状态上报不能生成计划或放大额度。

当前图片、视频与故障封面实际使用两个子资源角色：解码资源持 decoder/解码率/CPU，呈现资源持 GPU 跟踪估计/输出率。两者先从同一父计划取得额度，再授予文件 scope/加载页面。取消父级会将仍活动的子额度一并标记释放中；未结束的 I/O/decoder/上传继续占内部容量，不能在预算里假腾位。实际 controller 关闭且文件读者退出、固定句柄释放后，确认子额度退出，再归还并清理父记录。子资源单独退出只还父计划内部容量，全局保留仍在；旧/重复子 token 不会命中新申请。同会话清理增加 generation，防止旧 controller 的批量清理触及后继代际。

预算记录另有 **64 笔父/普通记录、每父最多 256 个计划资源及 256 笔子记录** 的界限，未清理墓碑继续占记录容量。诊断增加 sessionReservations、resourceAllocations、resourceReleasePending、reservationRecords、resourceRecords，以及当前媒体的 reserved/allocated 数值。新增 **8 项 Rust 回归**覆盖只扣一次、计划/身份隔离、取消仍持有、12 线程争最后子额度、溢出/重复 id、子/全局记录边界和迟到释放；现有图片/视频会话测试加验 controller 已关闭但文件读者未退时两笔子额度仍在。加入记录计数后，两处旧测试手工创建的占位 token 仅 confirm 未 forget，现补齐测试自身的墓碑清理；未通过放松生产退出规则来消除该失败。

最终普通与 all-features Rust 各 **389 项通过**（desktop 334、IPC 36、wallpaper 19；两项音频硬件测试仍忽略），Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过。普通构建 **21 组呈现回归**为 `output/playwright/wallpaper-presentation-native-1793691616763/presentation-report.json`：一个真实桌面视频为 1 笔会话保留/2 笔子额度；加入真实预览为 **2 笔会话保留/4 笔子额度、2 decoder、1 个桌面目标、1 个预览实例**。CPU/GPU/解码率/输出率恰好等于两个原生目标计划之和；软暂停保留四笔子额度，最终退出后全局额度与全部记录计数都为零。GL→图片→视频→GL 及独立预览故障/租约回归继续通过；GL 本身仍未进入此预算，不把其零计数当作资源已受控。

同一普通构建的 **22 组、0 errors** 故障封面/暂停回归为 `output/playwright/wallpaper-poster-native-1793691721399/poster-report.json`，默认拒绝为 `output/playwright/wallpaper-media-native-1793691754159/media-requests.json`。最终二进制 SHA-256 为 `838d871169e0b817cdc0605f9b5781f04be086075b46dfbca4d845bd9278ca53`，汇总为 `output/wallpaper-session-allocations-review-2026-11-03.json`。本轮未改渲染 bundle，未重复执行上一轮浏览器或音频验收，未创建提交，无遗留测试宿主。原生子额度内核及媒体接线已有证据；GL 的实际分配前准入、质量/跟随场景变化、JS/provider 的资源生命周期、完整峰值、COM Close 失败及物理平台长稳仍待完成。

复现命令（先按本机环境设置 `PLAYWRIGHT_MODULE`）：

```powershell
cargo build -p hertz-desktop --features wallpaper-media-probe
node scripts/check-wallpaper-import-native.js
# 记录 seed 命令输出的目录；随后恢复普通构建，再将同一目录传给正式呈现验收。
$presentationFixtureDir = node scripts/check-wallpaper-presentation-native.js --seed
# 私有副本内验证实际桌面/预览与导入竞争，要求显式测试 feature。
node scripts/check-wallpaper-presentation-native.js $presentationFixtureDir --decoder-competition
$env:WALLPAPER_MEDIA_SOAK_SECONDS = '600'
node scripts/check-wallpaper-media-native.js
Remove-Item Env:WALLPAPER_MEDIA_SOAK_SECONDS
cargo build -p hertz-desktop
node scripts/check-wallpaper-presentation-native.js $presentationFixtureDir
# 私有副本内等待真实五分钟视频卸载并恢复，普通构建。
node scripts/check-wallpaper-presentation-native.js $presentationFixtureDir --long-pause
$env:WALLPAPER_EXPECT_DEFAULT_DENY = '1'
node scripts/check-wallpaper-media-native.js
Remove-Item Env:WALLPAPER_EXPECT_DEFAULT_DENY
node scripts/check-wallpaper-config-native.js
node scripts/check-wallpaper-audio-native.js
node scripts/check-wallpaper-library-native.js $presentationFixtureDir
node scripts/check-wallpaper-library-native.js $presentationFixtureDir --crash
node scripts/check-wallpaper-poster-native.js $presentationFixtureDir
# GL/图片/视频统一独立预览，自动建立私有测试副本，普通构建。
node scripts/check-wallpaper-presentation-native.js $presentationFixtureDir --builtin-preview
node scripts/check-wallpaper-presentation-native.js $presentationFixtureDir --handoff
node scripts/check-wallpaper-presentation-native.js $presentationFixtureDir --follow-handoff
# 真实五分钟封面卸载/恢复（增加约五分钟）
$env:WALLPAPER_LONG_PAUSE="1"
node scripts/check-wallpaper-poster-native.js $presentationFixtureDir
Remove-Item Env:WALLPAPER_LONG_PAUSE
node scripts/check-desktop-settings-native.js
node scripts/check-desktop-management-native.js
cargo test -p hertz-desktop loopback_ -- --ignored --nocapture --test-threads=1
```

## 内置 GL 全局准入续审（2026-11-03）

受信内置 GL 已接入媒体共用的 `BudgetCoordinator`。`GlPlan` 从原生目标尺寸、刷新率、请求质量与 FPS 生成固定计划，按 `refreshHz / ceil(refreshHz / fps)` 计算有效输出率；通过总保留与一个 `gl-renderer` 子额度分配 context、GPU 跟踪资源上限及输出率。质量预算由真实 Space/Zodiac 定义导出到 `contracts/gl-budgets.json`，注册目录的 scenes 哈希算法保持不变。旧桌面与退出中 controller 继续占用，候选只在剩余额度内下调像素/质量，额度不足时拒绝；请求与实际额度可从 `glLimits` 和 `glAllocation` 诊断核对。

原生挂载命令发出前已完成保留，页面拿到冻结的 generation/子额度/上限。无 GL 授权的媒体页、旧代际额度与第二个未退出的 context 均不能创建 GL。原生页强制关闭 MSAA，并在实际 buffer、texture、renderbuffer 存储调用前核对额度；跟踪纹理 mip/立方体面/3D 层、缓冲区、离屏存储及 16 字节/像素的保守默认 framebuffer 估计。重复存储分配的旧字节保留到 GPU fence 完成；已删除对象可能仍被 VAO/FBO 引用，因此其字节和对象记录保留至 context 实际丢失。对象最多 8192 个、退休 fence 最多 256 个。GL 超额会报告原生错误并关闭相应呈现，不能悄悄切回 Zodiac。

场景间切换先等待旧 context 的真实丢失事件，最长 2 秒，才创建下一个 context；质量/FPS 和显示目标变化重新准入 controller。页面配置及 start 不能提高原生 FPS、质量和像素上限；Space/Zodiac 的实际 drawing buffer 遵守该像素上限。已发布的会话在失败/停用时标记父子额度释放中，直到原生 `Close` 成功并销毁 surface 后才清理。构造失败且尚未发布/未能收到挂载命令的保留可回滚，Rust Drop 不能替已发布 controller 确认退出。

边界：这是受信内置场景的 GPU 跟踪资源约束，不是 P3 任意网页隔离，也不是 JS 堆或驱动实测显存上限。删除资源的保守保留可能提前触及额度；此轮 GL 准入验收时，候选仍与旧动态场景并存，预算不足时保留旧画面并报告运行错误；桌面配置切换的静态帧交接随后接线，见下节。通用 assets/provider 的逐资源 lease、CPU 常驻解码资源和完整进程树/GPU 峰值、COM Close 失败与设备长稳验收仍待补齐。

新增 5 项 Rust 生命周期/规划回归，最终普通与 all-features 各 **394 项通过**（desktop 339、IPC 36、wallpaper 19；两项声音硬件测试仍忽略），Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过。**19 组浏览器 GL 检查**覆盖未授权/旧代际、实际分配前拒绝、同对象替换峰值、删除仍保留、全部 9 个桌面内置场景切换及 4K 视口。非 2 次幂纹理的 mip 层数按 WebGL 的整数转换规则规划，避免误拒绝 Three.js 的合法输入。设置、帧门/运行时、指针与 DBX 浏览器回归通过；另修复预览关闭后迟到的续租错误覆盖原生关闭原因，已加浏览器反例并通过真实心跳退出回归。

最终同一普通构建的 **23 组原生呈现**见 `output/playwright/wallpaper-presentation-native-1793694105748/presentation-report.json`，含 GL 桌面/预览原生父子额度、GL/图片/视频切换、超预算 buffer/texture/renderbuffer 与第二个 context 拒绝、质量/FPS 新 controller 准入、关闭后全部额度及元数据记录归零。**22 组封面/暂停、0 errors**见 `output/playwright/wallpaper-poster-native-1793694179667/poster-report.json`；默认拒绝见 `output/playwright/wallpaper-media-native-1793694217165/media-requests.json`。最终二进制 SHA-256 为 `80fca61a54461e91b827068e71419ad75674833c223df3a140835af74b232fc0`，汇总为 `output/wallpaper-gl-admission-review-2026-11-03.json`。使用既有规范样本的私有副本，未创建提交，无遗留测试宿主。整体目标继续保持进行中。

## 桌面静态帧交接续审（2026-11-03）

桌面选择、参数、质量/FPS 与媒体后端切换已接入“先采集上一帧、退出旧 controller、重新准入、确认新画面”的路径。采集请求来自原生随机 token 和源 sessionId/generation，页面只能返回指定尺寸的不透明 RGBA；上限 960×540、消息上限 3 MiB。GL 采集位于实际绘制后，图片/视频采集使用已就绪元素，包含亮度、适配和指针层。原生 Win32 位图窗口位于 WorkerW 内，完整图像通过 `UpdateLayeredWindow` 提交后才关闭旧场景，避免依赖 WorkerW 下不稳定的同步 WM_PAINT 触发。窗口关闭验证自身 userdata 身份，不能销毁被复用的 HWND。

静态帧沿用 `BudgetCoordinator` / `SessionPlan`，有 capture-workspace 和 static-bitmap 两个子额度。目标最高 16,777,216 物理像素，采集 C、目标 T 对应 CPU 常驻 4C、工作区 64 MiB＋4T、GPU 跟踪估计 12C＋8T 字节，覆盖有界回传、全屏 DIB 与上传/保留副本。工作区目前保守保留至源 controller 与位图均退出，不能把捕获回执或 JS Drop 当作退出确认。新场景的首帧不直接撤掉静态图，还需匹配当前原生身份的揭幕回执；采集超时保留旧 controller，揭幕超时关闭新 controller，候选失败保留静态帧和已保存选择。暂停时静态图跟随可见性策略，揭幕期限在暂停期间停止计算；快速连续选择复用原位图。静态 HWND 丢失被识别并归还已退出资源，失败状态等待显式重试，不宣称仍有旧画面。

本节记录桌面配置触发的切换；随后接通的 Follow Hertz 与独立预览见下节。工作区提前归还、物理显示变化/Explorer 重启矩阵、完整进程树和 GPU 峰值、COM Close 失败与长稳仍待完成。全屏静态位图的上传字节是跟踪估计，不是驱动显存实测；超过静态目标上限或预算不足会报告失败并保留尚未退出的原场景。

新增 6 项 Rust 回归，普通与 all-features 各 **400 项通过**（desktop 345、IPC 36、wallpaper 19；两项硬件测试忽略），Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过。浏览器验证 GL/图片/视频真实有界像素、身份/尺寸拒绝与揭幕回执；19 组 GL 边界、运行时和设置页回归通过。

最终同一普通构建的 **19 组切换/媒体验收**见 `output/playwright/wallpaper-presentation-native-1793698168266/presentation-report.json`，包含高档 GL 完整预算、旧 controller 先退出、所属位图 HWND 的真实非均匀像素、延迟首帧/揭幕、揭幕前实际选择不变、候选失败、采集超时、暂停超过三秒、揭幕超时、连续选择、所属 HWND 关闭和停用回收。另有 **23 组独立预览/呈现**（`output/playwright/wallpaper-presentation-native-1793698228494/presentation-report.json`）、**22 组封面/暂停且 0 errors**（`output/playwright/wallpaper-poster-native-1793698305359/poster-report.json`）以及普通构建默认拒绝（`output/playwright/wallpaper-media-native-1793698348898/media-requests.json`）。两个呈现套件最终预算和全部记录为零。二进制 SHA-256 为 `3807ce0e16a1be5cac6091380afe787097d726fc340f84baf68b2880253b8e13`；汇总为 `output/wallpaper-static-handoff-review-2026-11-03.json`。使用既有规范样本的私有副本，未创建提交，无遗留测试宿主。整体目标继续保持进行中。

## Follow Hertz 与预览静态交接续审（2026-11-03）

原生解析当前来源的有效且未满 3 秒快照，以现有 registry 识别场景别名、状态版本、参数范围与默认值。每个 controller 固定 runtimeBuiltin，页面配置接收固定场景投影，播放/音频 feed 仍独立送达；Follow Hertz 的持久配置不改写。参数规范化相等时不换代，真正改变场景或参数时走静态帧 → 源 controller/文件读者退出 → 最新投影准入 → 揭幕确认。断连/过期/不合格参数回到配置的 idleBuiltin；候选失败保留原静态图和保存意图，显式重试解析最新来源。原生页的任何场景挂载失败都返回宿主，不再在页面内静默选择 Zodiac。

独立预览沿用同一 Handoff、CaptureHold 与 FrameWindow。更新草稿、媒体换型或 Follow Hertz 自动换场景时，PreviewOwner 保留同一 lease 和原图；有界原生静态窗口由设置窗口拥有，位置取旧预览真实 client 坐标。旧 controller 和文件读者退出后才创建后继，匹配当前 generation 的揭幕回执才撤图。新的 PreviewFrame 预算类别只计入位图/采集工作区，不增加实时 preview instance，也不允许 context、decoder、解码/输出率或准备任务。预览更新失败保留静态帧与租约，再次更新重试；关闭/释放仍经过真实 source Close 和 HWND 退出，采集超时不能提前归还工作区。删除引用检查覆盖预览正在准备的配置、旧 surface 和保留图。

边界：静态工作区仍保守地保留到整帧退出，物理显示/Explorer 重启矩阵、COM Close 失败、进程树/GPU 峰值与 8 小时长稳未在本轮完成。此次 HTTP 来源是测试目录内的真实只读轮询入口；并不把该证据扩展成实际播放器 UI、DBX 宿主或硬件拓扑的端到端验收。

新增 4 项 Rust 回归，普通与 all-features 各 **404 项通过**（desktop 349、IPC 36、wallpaper 19；两项硬件测试忽略），Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过。19 组 GL 浏览器、运行时、设置页和 DBX renderer 回归通过。

最终同一普通构建通过 **22 组 Follow Hertz/预览及媒体验收**（`output/playwright/wallpaper-presentation-native-1793700888821/presentation-report.json`）、**19 组桌面静态交接**（`output/playwright/wallpaper-presentation-native-1793700950127/presentation-report.json`）、**23 组独立预览/呈现**（`output/playwright/wallpaper-presentation-native-1793701009736/presentation-report.json`）和 **22 组封面/暂停、0 errors**（`output/playwright/wallpaper-poster-native-1793701087421/poster-report.json`）。Follow 套件包含真实 HTTP feed、连续更新合并、断连与参数拒绝、相同参数不换代、场景参数实际换代、失败重试、桌面和预览并行交接、预览草稿跨 GL/图片/视频、过期揭幕隔离、采集超时与采集中释放。三个呈现套件最终预算和全部记录归零；普通构建默认拒绝见 `output/playwright/wallpaper-media-native-1793701127986/media-requests.json`。二进制 SHA-256 为 `8c9cfe3393f93b408262604623c07eccd7c96523a8ba5a593158d037b44d578e`，汇总为 `output/wallpaper-follow-handoff-review-2026-11-03.json`。使用私有测试目录，未创建提交，无遗留测试宿主；整体目标仍在进行中。

## 静态采集工作区提前归还续审（2026-11-03）

补齐上一轮中断时未验证的资源退役路径。原先 confirm_resource_exit 只恢复父计划内部容量，静态旧图保留期间 capture-workspace 的整笔全局额度仍被占用。现在原生 owner 可在同资源所有子额度确认退出后永久退役该计划，原子扣除其完整上界；资源 id 随父计划封存，不能在同一计划重新申请，剩余资源保留原身份和 allocationRevision。普通子资源取消/退出仍保留原有可复用语义。

桌面配置、Follow Hertz 与独立预览使用同一退出判断：有效身份的采集回执处理及其消息/解码临时存储返回、源 controller Close 成功、原生 staging DC/DIB 真实退出后，在后续事件循环 tick 归还准备工作区 64 MiB＋4T 与 GPU 上传峰值 12C。仍在显示的位图继续保留 CPU 4C、GPU 8T 和父计划，直到其 HWND/位图存储退出。采集超时、未确认回执、源未关闭或 staging 未退出均不能提前减账；连续更新只复用旧位图，不再申请已封存的工作区。诊断增加 workspaceReleased 和实际目标宽高，便于从正式状态核对账本。

真实 GDI 回归发现 DeleteObject 可对仍选中的 DIB 返回成功并延迟删除，因此删除返回值不能独立证明退出。StagingDib 在删除成功后继续用 GetObjectW（读取实际 BITMAP，不能只查类型或结构大小） 检查句柄是否失效，仍存活则保留记录；不重复删除已受理的句柄，避免后续句柄复用时误操作。实际测试覆盖另一 DC 持有 DIB、重复回收、静态 HWND 已关闭而 DIB 仍活着，以及解除真实引用后退出。正常 UpdateLayeredWindow 上传后 staging 立即退出，静态 HWND 继续显示。

范围：这里只提前归还已退出的静态采集临时资源；通用 assets/provider 逐资源租约、COM Close 失败注入、物理显示/Explorer 矩阵、完整进程树/GPU 峰值和 8 小时长稳仍待完成。GPU 字节仍是跟踪估计。

新增 **7 项 Rust 回归**，普通与 all-features 各 **411 项通过**（desktop 356、IPC 36、wallpaper 19；两项音频硬件测试忽略），Clippy all-targets/all-features `-D warnings` 与 Rust 1.88 all-targets/all-features `--locked` 通过。浏览器运行时及 **3 组 GL/图片/视频静态采集**回归通过。

最终同一普通构建通过 **19 组桌面交接**（`output/playwright/wallpaper-presentation-native-1793711677793/presentation-report.json`）、**22 组 Follow Hertz**（`output/playwright/wallpaper-presentation-native-1793711851580/presentation-report.json`）及 **23 组独立预览/呈现**（`output/playwright/wallpaper-presentation-native-1793711934036/presentation-report.json`）。桌面 2560×1600 实测中，旧源退出而静态图仍显示时，准备工作区 **83,492,864 字节**已归还，原生 `prepareCpuBytes=0`；仍显示的全屏位图 GPU 估计 **32,768,000 字节**继续保留。候选加载、候选失败、连续更新、预览揭幕及采集超时均检查提前归还或继续占用的相应状态。三个套件最终全局预算和所有记录计数归零；普通构建默认拒绝证据为 `output/playwright/wallpaper-media-native-1793712043519/media-requests.json`。二进制 SHA-256 为 `32329358136275bccc5bcd9fabeabce4ae9d5bf0a19c0f23644d8eafa180e682`，汇总为 `output/wallpaper-workspace-release-review-2026-11-03.json`。

首次 Follow Hertz 验收在状态读取时遇到 `EPIPE` / `control busy`，日志记录 management connection deadline，宿主仍存活并继续加载预览。失败记录保留于 `output/playwright/wallpaper-presentation-native-1793711750336/presentation-failure.json`；没有重放任何已连接的修改请求，同一二进制在新隔离目录完整重跑 22 组通过。此处记录该瞬时超时，不宣称已经修复其产品侧原因。未创建提交，无遗留测试宿主；整体壁纸计划仍有后续工作。

## 原生 controller Close 失败屏障续审（2026-11-03）

继续核对通用资源会话需要依赖的实际退出屏障。RetiringWallpaper 仍是关闭及会话归还的原 owner，Close 失败保留原 surface 和账本占用，后继等待；此次增加可直接从正式状态读取的逐 controller 诊断：原代际/仍存活的 sessionId、关闭尝试、当前 HRESULT、失败持续时间、最近调用耗时，以及 controller 与文件读者两道屏障的独立状态。retiringControllers 继续保留总数，retirements 明细最多 64 条，不将 Close 失败改成永久应用失败或覆盖保存意图。

显式 wallpaper-media-probe＋debug_assertions 构建增加同绑定故障注入，在实际 RetiringWallpaper Close 边界返回 E_FAIL；原生事件的来源 generation 与 payload 的 sessionId/generation 必须同时对应自己的 surface，包括正在退出的原页面。它不能由一个 controller 控制另一个，也不能由普通构建调用。验收使用真实桌面/预览/视频资源和 controller，不通过虚构预算或伪造 sourceClosed 实现故障；解除注入后仍须实际执行 COM Close、销毁 WebView/窗口及原文件读者退出才可回收。

定向反证：临时去掉生产 Close 失败分支中的退出阻挡后，真实原生验收在“Close failure keeps the captured frame and original controller”条件失败；旧 controller/退出记录已被提前清除。反证记录为 `output/wallpaper-close-mutation-review-2026-11-03.json`，其中关联具体失败目录与变异二进制 hash；随后只恢复该处变异，并核对源码恢复为原字节。

范围：此轮验证 Close 失败控制流、预算保留和真实退出后的恢复；实际 COM 故障来源、物理设备/Explorer 矩阵与长稳仍待资格验收。通用 assets/provider 逐资源租约仍待接线。上一轮的单次管理管道超时继续保留为独立观察，不能从关闭故障注入推断其原因已解决。

普通 Rust 测试 **411 项通过**（desktop 356、IPC 36、wallpaper 19），all-features **412 项通过**（desktop 357，其余相同；新增一项 debug 探针身份/载荷边界测试），两项音频硬件测试仍忽略。Clippy all-targets/all-features `-D warnings`、Rust 1.88 all-targets/all-features `--locked`、限定文件 rustfmt、三个 JS 验收脚本语法及本轮差异空白检查均通过。

恢复源码后的显式 feature 构建通过 **18 组原生 Close 故障及呈现回归**，包含五组实际桌面/预览/视频退出反例，证据为 `output/playwright/wallpaper-presentation-native-1793715672040/presentation-report.json`，二进制 SHA-256 为 `e3a8921f4712bd9c048fef8c3d254db3c5cb78306d1347f413c8491f77b548dd`。随后重新构建普通无 feature 二进制，同一构建通过 **19 组桌面交接**（`output/playwright/wallpaper-presentation-native-1793715875869/presentation-report.json`）及 **23 组独立预览/呈现**（`output/playwright/wallpaper-presentation-native-1793715964817/presentation-report.json`）。三个套件最终全部预算、分配记录及 controller/静态交接退出记录归零；普通构建默认拒绝授权、导入及 Close 故障探针，两个媒体请求均为 404，见 `output/playwright/wallpaper-media-native-1793716100543/media-requests.json`。当前普通二进制 SHA-256 为 `8888cf5d03bf4d3152d94e885453e2600387268cea5e49aa086c1995a40ee751`，汇总与源码恢复核对为 `output/wallpaper-close-failure-review-2026-11-03.json`。使用私有测试目录，未创建提交，无遗留测试宿主；整体壁纸计划仍在进行中。

## 独立解码探测 Close 失败屏障续审（2026-11-03）

继续检查 ImportJobs 导入与已安装媒体补图依赖的 ProbeHost 退出屏障。该 owner 保留自己的独立 WebView2、文件 scope 和探测预算；成功解码、取消及首帧/seek 期限都只决定结果，必须等实际 Close 和全部文件活动退出后才回执给准备 worker。正式状态增加单实例 decodeProbe 诊断，包含原 probeId、启动/结果、controller 与文件读者的独立退出状态、Close 尝试/错误/持续时间及调用耗时。修正相同 Close 错误在每次轮询时重复写日志的问题，改为只在 HRESULT 改变时记录，保留完整尝试计数。

显式 wallpaper-media-probe＋debug_assertions 构建可以在该 owner 的真实 Close 调用边界注入 E_FAIL，注入在创建探测实例时固定，避免首帧完成过快造成验收竞态；解除只接受该探测页自身 native callback 的 probeId，错误 id、普通壁纸页来源与非法载荷均不能越过屏障。新开关保留正常资格缓存管线，成功/取消案例使用只改变封装标签、保留原压缩帧的不同内容样本。验收直接检查真实 SQLite 资格与派生索引、staging、准备槽及 decoder 占用；补图案例继续使用已删除导入源的不可变已安装原包。

设计 C53 的“15 秒内终结等待”细化为在期限内结束首帧/seek 等待并进入回收，终态回执仍等待真实退出，与既有两道屏障一致。此轮增加关闭故障可观测性与去重日志，并验证既有释放规则；真实 COM 故障、通用 provider 逐资源租约、设备/Explorer 矩阵、完整峰值及长稳仍待后续验收，先前管理管道超时也尚未定位。

普通 Rust **411 项通过**（desktop 356、IPC 36、wallpaper 19），all-features **413 项通过**（desktop 358，其余相同；本轮新增一项仅 debug 的探针来源/载荷边界测试），两项音频硬件测试仍忽略。Clippy all-targets/all-features `-D warnings`、Rust 1.88 all-targets/all-features `--locked` 及限定文件格式、JS 语法与差异空白检查均通过。

显式 feature 构建通过 **36 个原有导入/重试场景及 4 组原生 Close 故障反例**，其中原有场景包含四种原始媒体正向导入、重复原始图片和错误容器拒绝。最终证据为 `output/playwright/wallpaper-import-native-1793718719501/evidence.json`，二进制 SHA-256 为 `d95528120b815eeab222624817d66999f555613b2ac9e1b4660cd7e9ac93fde2`。成功视频已收到真实首帧/中段/近尾帧、文件读者已退出时，仍保留 **1 个 decoder 与 1 个准备槽**；失败 Close 不发布包、资格或派生索引。随后取消可覆盖待发送的成功，仍保留 staging 和准备 owner，实际 Close 后才回执 cancelled。真实 15 秒首帧期限到达同样只改变结果，保留未退出实例与预算。删除导入源后的图片补图生成 **106×53** 目标，Close 受阻时保留 **44,944 字节解码 CPU 额度**与准备槽，退出后才发布索引，原包 hash 不变。最终停用测试桌面后全部全局预算、分配记录及退出记录归零。

定向反证临时移除 ProbeHost 的失败 Close 返回后，原生验收按预期在“failed Close keeps the real probe, budget and unpublished job”失败；测试私有库已经提前出现 close-success 的 original.hwpkg，确认是实际提前发布，非仅缺少诊断字段。反证为 `output/wallpaper-probe-close-mutation-review-2026-11-03.json`，随后只恢复该处源码，前后 SHA-256 均为 `046a32df35240d701b6ba9385b2eebc260c001e3aa26a637386ee43f89efc3ea`。

保留两次未完成验收的证据：首次 `output/playwright/wallpaper-import-native-1793717867349/evidence.json` 在 5000×1000 大图 CPU 准备阶段超出旧脚本 25 秒总观察窗口，尚未创建该任务的独立探测页；任务回执观察改为 60 秒，15 秒探测阶段仍单独断言，未据此宣称准备性能已优化。第二次 `output/playwright/wallpaper-import-native-1793718468267/evidence.json` 已完成全部原有场景及两组关闭反例，随后日志出现 tray rebuilt、wallpaper surface unavailable; recovering 与新桌面页；脚本原先持有的壁纸页关闭，因此第三组未完成。新的隔离目录完整通过四组；该 surface 失效的原因尚未确认，完整 Explorer/设备矩阵仍待验收。

最后恢复普通无 feature 构建，同一二进制通过 **19 组桌面交接**（`output/playwright/wallpaper-presentation-native-1793719052162/presentation-report.json`）及 **23 组独立预览/呈现**（`output/playwright/wallpaper-presentation-native-1793719126368/presentation-report.json`）。两个套件最终全部预算和资源记录归零，decodeProbe 为 null，controller 与静态交接退出记录均为空。普通构建的授权、导入与播放 controller Close 测试入口默认拒绝，两个媒体请求均为 404，见 `output/playwright/wallpaper-media-native-1793719231129/media-requests.json`。当前普通二进制 SHA-256 为 `b24efda12101a8731d28ec739452ae97e08052709f26478ac7d7cae5ad503046`，汇总、源码恢复及中断观察为 `output/wallpaper-probe-close-review-2026-11-03.json`。未创建提交，无遗留测试宿主；整体壁纸计划仍在进行中。

## 通用共享资源租约续审（2026-11-04）

补齐剩余清单中的"通用资源/JS 租约接入总保留/子额度内核"。`BudgetCoordinator` 新增独立的 `asset_cpu_bytes` 维度（专用 128 MiB 上限）：受信页面的通用共享资源不再挤占媒体解码 CPU 或准备工作区。受信内置 GL 的 `SessionPlan` 固定第二个资源计划 `shared-assets`，条目与单条字节上限来自新合同 `crates/hertz-wallpaper/contracts/shared-assets.json`（歌词纹理 7 条 × 2048×1088×4 = 62,390,272 字节；封面上限 12 × 768²×4×4/3 仅作合同真值——受信桌面页面的封面入口在资源内显式禁用，不进入会话计划）。`GlAdmission` 在准入时原子取得 gl-renderer 与 shared-assets 两个子 token；第二个分配失败按 release 级联加逐子额度退出确认回滚，`finish` 在 controller Close 屏障后确认两个子额度再归还父保留。`glLimits.sharedAssets` 随初始化脚本冻结下发，`budget.assetCpuBytes` 进入正式状态诊断。

页面侧：`wallpaper-gl-budget.js` 在原生信封存在时暴露冻结的 `HertzSharedAssets` 账本——池每次 acquire 在装载前以逐资源 token 记账（预算先于解码），淘汰或销毁按条目归还；信封耗尽按既有池语义优雅拒绝，未计划资源类型与未知/重复 token 沿 GL 预算同一致命路径（`wallpaper_gl_failed`）。信封校验延迟到 getContext 包装就位之后，拒绝时驱动零调用。`spatialResources` 池纹理由池自身打上不可写的 pool-owned 判别，替换此前散落在 `userData.spaceShared` 的临时标记约定；`scope.trackTree` 据此跳过池资源，新增 `scope.lease` 显式登记消费租约、作用域销毁只释放租约（cover-particles 工厂已改为该入口）。

边界：受信桌面注册表的 9 个内置场景当前都不装载歌词/封面纹理，原生成对验收中信封为"计划、保留、随会话真实退出归还"的零消耗前向合同；页面账本行为由节点与浏览器测试覆盖。本信封是受信页面的静态 envelope，组合引擎的通用 `AssetProvider`/`DecodeContext.reserve` 动态多资源规划仍属组合工作包。上一轮的 Close 失障注入、COM/设备矩阵、完整峰值与长稳仍待验收。

验证：普通 Rust **412 项**（desktop 357、IPC 35、wallpaper 20）、all-features **414 项**通过（desktop 359；两项音频硬件测试保持忽略），新增专用上限/记账回归与 GL 双子额度计数更新；Clippy all-targets/all-features `-D warnings`、Rust 1.88 all-targets/all-features `--locked` 与限定文件 rustfmt 通过，日志为 `output/wallpaper-shared-assets-rust-{default,all,clippy,msrv}-2026-11-04.log`。共享 bundle 由 `node tools/build-stages.mjs` 重建（space/coast/zodiac manifest 同步），场景 **81 次真实生命周期**、歌词布局、运行时与 76 项帧门通过；`check-space-resource-leases.js` 新增信封记账、耗尽拒绝、pool-owned 判别与 `scope.lease` 语义断言。GL 浏览器检查扩到 **22 组**（`output/playwright/wallpaper-gl-browser/report.json`）：缺 sharedAssets 的 GL 准入被拒且驱动零调用、账本七条记账/耗尽/重复拒绝、未计划资源类型致命失败并回执 `wallpaper_gl_failed`。

最终普通构建（SHA-256 `ada3cbefe41e6033c77060d4595ccc945ef115255a2ec6c90691d3bc507a6a19`）通过 **19 组桌面交接**（`output/playwright/wallpaper-presentation-native-1793752086554/presentation-report.json`）、**22 组 Follow Hertz**（`output/playwright/wallpaper-presentation-native-1793752155633/presentation-report.json`）、**23 组独立预览/呈现**（`output/playwright/wallpaper-presentation-native-1793752228166/presentation-report.json`）及普通构建默认拒绝（`output/playwright/wallpaper-media-native-1793752317608/media-requests.json`）。报告内核对 `glLimits.sharedAssets` 信封、GL 会话的 `assetCpuBytes=62,390,272` 与双子额度计数，最终全局预算与全部记录（含 assetCpuBytes）归零。首次 `--builtin-preview` 运行在双子额度模型更新前执行，按旧的单子额度计数失败（`output/playwright/wallpaper-presentation-native-1793751766453`），更新验收计数后同一构建完整通过；该失败是验收脚本滞后于本轮内核变化，不是产品缺陷。设置页浏览器回归当前有一处并行会话进行中的"translation 并入 next"改动导致的失败（资源已改、脚本未改），不属于本轮范围。未创建提交，无遗留测试宿主；整体壁纸计划仍在进行中。

## 后续工作与所缺证据

| 工作包 | 剩余实现 / 接线 | 已有证据与剩余验收 |
| --- | --- | --- |
| P1-02 本地库与任务 | 库/导入/固定版本选择、单媒体重启、作品/版本删除与引用保护已接线 | 固定快照、安装事务、恢复/取消/重复导入、跨实例写门及内容配额已有回归；删除共享包保留、最后版本清理、先删目录再删行及配置/草稿/预览拒绝见第十六轮。2026-11-03 已补齐普通构建原生删除/收藏、跨配置域与原生草稿引用反例；目录已删/数据库未提交时的真实进程终止已验收；正向原生文件对话框、其他文件删除故障及断电/OS 崩溃仍待验收 |
| P1-03 媒体准备 | 视频封面生成及库/设置页读取已接线；桌面播放/首帧故障封面已接线；启动缺包/坏包和准备失败封面已接线；仍待更多媒体边界与硬件验收 | 图片方向、RGB ICC、线性透明缩放、目标像素变体、元数据剥离、不可变重建、缓存与内容配额已有回归；单媒体包内候选选择及缺图准备已由规划器接通。仍需真实图像集峰值内存、更多 ICC/高位深边界、1080p/大视频内存与硬解、真实环境升级与更多设备资格 |
| P1-04 资源会话 | 媒体候选交接、实测物理目标、GL/图片/视频统一独立预览、单屏视频位置恢复、暂停确认及首帧前候选退出已接线；现有封面/歌词池已有独立消费者租约，原生会话总保留/子额度内核已接入真实媒体和受信内置 GL；静态采集工作区按实际退出提前归还；受信页面共享资源（歌词纹理池）已按 shared-assets 子额度与逐资源 token 接入内核，scope.lease 与 pool-owned 判别替换临时标记约定。仍待组合引擎通用 AssetProvider 的动态逐资源预算 | 当前代际四事实、双 decoder 交接、桌面/媒体预览/导入竞争、最后预览消费者取消、五分钟退出/位置恢复、暂停故障和首帧前退出已有实测。统一独立预览另已验证真实首帧/揭幕、跨 GL/图片/视频换代、上下文丢失和租约/心跳/原生窗口关闭。同 context 封面/歌词纹理已验证多消费者独立取消、旧租约隔离、未结束任务保留额度、实际 GL 上传与最后租约释放；原生媒体总保留/子额度另已验证只计一次、并发/取消/代际与全部记录回收；受信内置 GL 已接全局准入、分配前边界和原生关闭屏障；通用 assets/provider 仍未接通。桌面配置、Follow Hertz 与预览的静态帧交接及工作区提前归还见前几节；仍需完整峰值、硬策略/物理显示变化的位置恢复、GPU 引擎暂停计数及真实 COM 故障实测（Close 失败注入屏障见上节） |
| P1-05 本地库 UI | 已接线原生 fileToken/导入 API、库/任务 UI、版本/作品删除、config v5/日志、草稿和单媒体选择/独立预览/应用/重启；视频封面已接入库列表和选中作品；仍待 work 草稿及整包用户验收 | 普通构建真实库按钮选图并应用，原文件已删除仍可预览/恢复；无播放器可用；无效版本、回执重放、保存后候选失败与预览故障保留实际桌面；删除入口的请求载荷与引用拒绝文案已有浏览器回归。原生删除/收藏 UI 已通过 11 组验收，正向原生选文件仍未自动化验证 |
| P1-06 输入 | 单个系统采集/分析 owner 已接入配置、桌面与预览会话；设备通知与 none/Hertz/system 切换已接线 | 13 组原生场景覆盖真实回环、共享 owner、桌面暂停、设置关闭、冲突预览、固定设备失败/重试与来源切换；移除/恢复/格式变化顺序、无消费者停止和无效固定 ID 不回退已有回归。仍缺真实默认设备切换、运行中热拔、系统静音与休眠恢复验收 |
| P1-07/08 | 多屏 single/mirror/span、组时钟、收藏轮播、引用保护；收藏与“只看收藏”已接线 | 收藏写入/筛选分页与浏览器回归见第十七轮；仍缺多屏混合 DPI/负坐标/旋转/拔插、局部全屏、整机预算、轮播暂停冻结与失败停止 |
| P1-M0～M2 | 原服务舞台持久库、流租约、稳定引用保存/恢复与备份 | 删除源后恢复、原子删除重导入、跨客户端 revision；DBX 视频还需实际宿主有界流协议与发行资格，8 小时换租约 |
| P2/P3/AI | 组合 compiler、扩展节点/编辑器、安全 worker、分发与受管 AI 流程 | 按各自工作包出口验证；不以当前图片/视频轻后端覆盖这些能力 |
| 平台长稳 | 设备/拓扑矩阵与整棵进程树、GPU 引擎观测 | RDP、Explorer 重启、睡眠、电池、8 小时稳定性；小尺寸 VP8 fixture 不代表 1080p/4K 硬解达标 |
