# 舞台本地图片 / 视频持久化

2026-11-05 实施增量，对应 [壁纸设计 §8.5](desktop-wallpaper.md#85-舞台持久媒体原服务保存文件设置保存稳定引用)。当前源码接通独立版图片、视频及 DBX 图片；DBX 视频保留宿主连续流资格门。此记录不代表已经发布新安装包。

在创意工坊 → 电影风格 → 我的图片 / 视频中选择文件，系统先导入当前连接服务设备的资料目录，验证文件与浏览器解码，再提交背景选择。界面收到保存回执才显示保存成功。原始文件随后移动或删除，不影响刷新、重启服务后的恢复。“已导入素材”支持分页复用和删除，显示文件大小、状态、持久引用和使用状态；导入成功但选择保存失败时，文件仍留在库中。

## 存储与生命周期

- [StageMediaStore](../crates/hertz-studio/src/stage_media.rs) 属于原 AppState。HTTP 和 DBX RPC 使用同一个 owner，复用原监听器、SQLite 和 DataDir，不要求桌面壁纸组件。
- 原文件在 `stage-media/objects/<sha256>/source`；派生图在 `derived/<sha256>/`，单次导入使用 `staging/<importId>/`。SHA-256 是素材 ID，storeId 存在受管设置中；完整移动 DataDir 保持引用有效。
- 进程锁隔离同一素材目录的写入，锁失败仅停用素材域。启动协调中断导入、未入索引对象与带 deleteId 的删除；不全库解码。相同内容再次导入会检查实际原文件，修复缺失或损坏对象。
- 单个导入槽覆盖上传与准备。每块最大 256 KiB，偏移、长度和哈希均有持久回执；相同块可重试，异内容或异边界拒绝。上传空闲期限 60 秒，总期限 15 分钟。finish 形成持久任务，已提交任务重查返回原引用；未完成任务在重启后为 interrupted，需要重新选择文件。
- 取消先作废浏览器意图，原生结束在途 IO 后释放槽；已完成安装的素材保留。失败安装清理本次未入索引的对象，不删除先前已提交的同哈希素材。
- 原稿额度为 10 GiB / 2,000 项；派生缓存为 256 MiB。只回收未被租约占用的派生图，不自动删除原稿。派生图缺失时校验原稿哈希并有界重建。
- 删除先在数据库记 deleting/deleteId，再移入该 deleteId 的垃圾目录；清理不能影响后来重导入的同哈希对象。当前预设、预设库、显示/预览/恢复租约和未结束的文件流均阻止删除。

容器解析从桌面宿主抽到 [hertz-wallpaper::media](../crates/hertz-wallpaper/src/media.rs)，桌面宿主继续重导出同一实现。舞台的 [图片准备器](../crates/hertz-studio/src/stage_media/prepare.rs) 在单个阻塞工作槽中执行真实解码、EXIF 方向、RGB ICC 到 sRGB 的转换、目标尺寸缩放与 PNG 重编码，限制 PNG 元数据膨胀、输入分配、尺寸和输出长度，拒绝无法转换的 HDR/gamma 声明。

| 类型 | 准入边界 |
| --- | --- |
| 图片 | PNG / JPEG / 静态 WebP，原文件 ≤32 MiB、原图 ≤64 MP，解码分配预算 256 MiB；准备结果 ≤16 MP、单边 ≤8192、编码后 ≤32 MiB，按目标窗口尺寸规划 |
| 视频 | H.264 MP4、VP8/VP9 WebM，≤512 MiB；编码像素 ≤1920×1088、单边 ≤1920、可证明的最高帧率 ≤60 fps，不转码 |

背景预设只保存 `type / media / assetRef` 和既有融合参数。`Backgrounds` 独占一个图片/视频元素及运行时租约，SpaceLayers/BgWall 借用该元素。视频切换先停掉旧解码元素；新素材通过最多 15 秒的加载、实际播放、首帧、seek 和画布读取验证后才提交。图片同样验证实际解码和画布可读；设置 `crossOrigin=anonymous` 后才赋 src。失败时可明确重试或恢复之前背景。

## 预设提交与备份

[stage_presets](../crates/vmusic-store/src/stage_presets.rs) 管理 `creative_current_preset`、`creative_presets` 和 `creative_stage_state`，current/library 分别维护 revision。保存按 requestId、载荷摘要与 expectedPresetRevision 在同一 SQLite 事务中校验引用、写载荷和回执；同请求重试返回原回执，不同内容复用请求 ID 拒绝。

[前端保存队列](../plugin/ui/stage-persistence.js) 每个目标最多一项在途，只合并后续最新编辑。响应丢失先读取 lastCommit，冲突或无法确认结果时保留未保存编辑，提供重新载入和明确重试。默认值不会在 hydrate 前覆盖服务端；localStorage/DBX storage 只用于首次迁移，不再充当断线权威副本。已有服务端预设库（包括空库）优先。旧 blob 地址清理并提示重新导入；稳定但缺失/跨库的引用继续保留，允许编辑原项其它字段。

通用 settings 在任何写入之前拒绝混入受管键。JSON 备份导出排除内部版本状态；恢复在任何备份写入前校验预设，并在原恢复事务内生成新 revision，保留缺失/跨库引用。JSON 备份不含素材字节；完整备份须停止服务后复制整个 DataDir。分享码、预设 JSON 和跨机工程导出继续排除私有素材引用与字节。

## 传输入口

| 入口 | 用途 |
| --- | --- |
| `GET /v1/stage/presets` | 加载当前预设、预设库、storeId 和各自 revision/lastCommit |
| `PUT /v1/stage/presets` | `target / requestId / expectedPresetRevision / payload` 的事务保存 |
| `GET /v1/stage/media?offset=…` | 每页最多 50 项的素材与引用状态 |
| `POST /v1/stage/media` | `action` 为 `import.begin/status/finish/cancel`、`lease.acquire/renew/release/read` 或 `asset.delete` |
| `POST /v1/stage/media/import/chunk` | 二进制块；查询参数为 importId、uploadToken、offset、hash |
| `GET / HEAD /v1/stage/media/resource/<lease>` | 仅凭素材专用随机短期租约，支持单 Range、准确长度和 MIME；64 KiB 块流式读取，不压缩、不输出管理 token 或系统路径 |

除资源读取外，入口均在原完整管理认证后。DBX 沿既有方法路径/信封映射相同操作，上传先检查 base64 长度再解码。DBX 图片每次读取最多 256 KiB，完整准备图最多 32 MiB，组装一个受管 Blob URL。DBX 视频直接拒绝获取租约，不以宿主旧 `mediaUrl` 标志、整段 base64、整视频 Blob 或新 listener 代替流协议；已导入视频仍保存在库中，可在独立版使用。

## 验证证据与边界

- `cargo test -p hertz-studio stage_media --lib`：6 个定向测试，覆盖分块顺序/重试、内容去重、原文件缺失/损坏修复、进程锁、任务回执与中断恢复、删除日志重放、重新导入、CAS 与引用保护、混合 settings 拒绝、备份事务、HTTP HEAD/Range/鉴权、实际 RPC 图片读取、DBX 视频拒绝、取消，以及 ICC 转换与 alpha 保留。
- `cargo test -p vmusic-store -p hertz-wallpaper --lib`：55 个存储测试与 27 个共享契约/媒体解析测试通过，包含原备份边界和动画/异常容器拒绝。
- `node scripts/check-stage-media.js`：真实前端模块的首迁移、空库优先、保存合并、响应丢失、冲突后保留/明确重试、无 SubtleCrypto 时的分块哈希、DBX 图片组装及租约释放。
- `node scripts/check-frontend.js`：默认集合 72 步通过，包括现有工程、分享码、临时预览、场景、空间层与资源接线回归。旧工程恢复测试改为真实保存适配器和服务端回执模型。
- `node scripts/check-stage-media-persistence-browser.js`：隔离 Null 音频服务 + Windows Chrome，通过 UI 导入 JPEG 与 VP8 WebM，删除选择器原文件后刷新及重启实际服务；验证实际图片/视频解码、seek、画布可读、调融合参数不重启解码器、派生图重建、受控 DBX 分块图片路径，以及另一窗口更新后的冲突/明确重试。测试不接触用户运行中的应用或音乐资料。

尚未取得真实 DBX 宿主的视频连续流实现与发行证据，也未把 Chrome 的验证扩张为所有 WebView2/移动设备/硬件解码器的资格结论。DBX 图片已覆盖原生 RPC 和受控浏览器传输；当前实际安装宿主的完整人工旅程仍属宿主发布验收。后续 P1-M1 的 DBX 视频出口继续保持待实施/待验证。

## 2026-11-05 续审：页面存活期间的恢复与取消

首轮证据覆盖刷新/重启后的重新载入，本次补齐页面持续打开时的租约恢复与候选取消。首先用生产 [stage-media.js](../plugin/ui/stage-media.js) 复现慢续租：前一次尚未返回，90 秒内已有三个请求在途。续租现为单个一次性计时器与一个在途请求，普通控制请求期限 15 秒；失败、隐藏、被舞台遮挡和释放会停止相应计时器，重新活动先校验租约。准备图重建仍允许 75 秒，取消仍等待原生准备任务实际退出。DBX 图片取消后不再请求下一块，迟到块也不会生成 Blob URL。

[Backgrounds](../plugin/ui/backgrounds.js) 继续独占媒体元素。续租失效或原服务断线重连后按保存的 assetRef 重新取得 URL，恢复此前视频位置并遵守当前暂停/可见性策略，不改写持久预设。每次失败只作一次资源重取，后续等待重连、重新可见或用户明确重试。交接期间保留最长边 1024 像素的 canvas 静态帧，SpaceLayers 与 BgWall 借用同一来源；旧视频先清 src/load，再释放租约。后台换背景先卸载旧元素，重新可见时只加载最新选择。

解码探测的 acquire/load/play/seek/decode 各阶段检查同一代际，切换、取消或页面隐藏立即结束调用方等待，清理监听器和 15 秒探测计时器。已发出的读取/播放回执迟到时只能清理旧资源。连续失败候选保留最后一次已接受背景，明确切换或保存后释放回滚租约。导入和素材选择还检查 CreativeStage 预设版本，期间发生其它舞台修改时只保留已入库素材，不申请覆盖新编辑。

新增验证：

- `node scripts/check-stage-media.js`：慢续租不重叠、失败后不轮询、隐藏后再失败能通知当前呈现、释放后迟到回执隔离、DBX 在途块取消，以及模拟 8 小时的 960 次续租；全程最多一个计时器，释放后归零。这是模拟时钟行为检查，不是实际设备 8 小时长稳。
- `node scripts/check-stage-media-persistence-browser.js`：沿用隔离 DataDir 和 Null 音频服务，原导入/恢复旅程通过；另有 [8 组真实 Chrome 场景](../scripts/stage-media-lifecycle-checks.js)：撤销原生租约后保留视频位置、保持页面打开重启实际服务、隐藏时切换背景、连续失败候选与临时预览回滚、离开遮挡舞台恢复、取消后迟到租约回收、取消 play 探测后的旧任务隔离，以及导入期间预设修改保护。测试先比较二进制内嵌媒体脚本与当前源码哈希，报告保存到 `output/playwright/stage-media-persistence-report.json`，不记录租约 URL 或管理凭据。
- 当前源码 `node scripts/check-frontend.js` **72 步通过**，`cargo test -p hertz-studio stage_media --lib` **6 项通过**；独立服务与 DBX 插件重新构建通过。本次没有改动原生存储/容器算法，前节 82 项存储与解析结果仍属于首轮证据。

真实硬件解码、整机峰值与 8 小时稳定性、实际安装 DBX 的人工旅程及 DBX 视频流依赖仍未取得新增资格证据。本次结果不表示已发布安装包，也不宣称 §8.5 全部性能和宿主出口完成。
