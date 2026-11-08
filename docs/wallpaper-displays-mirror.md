# 壁纸显示组与镜像播放实施记录

2026-11-06，实施盘点 A02，对应[壁纸设计](desktop-wallpaper.md) §13.1、§13.2 与 P1-07。当前工作树已接通多个 single 组、span 和图片/视频 mirror，以及显示组设置、逐组预览、完整配置 Apply、组轮播与视频校时。真实桌面验证使用一块物理显示器；双屏同时呈现、混合 DPI、负坐标、跨屏边界与热拔插仍待相应硬件验收。

## 使用入口与范围

“桌面歌词与壁纸”设置的“壁纸”页新增显示组编辑器，显示 Windows 屏幕排列、各组成员和运行状态。选择组后，内容、亮度、运动、帧率、质量和预览都针对该组；“应用设置”一次提交全部显示组，配置 revision 只增加一次。

| 布局 | 当前行为 |
| --- | --- |
| single | 每组一台显示器，多个组可独立选择内容和呈现参数 |
| span | 一个呈现目标覆盖全部成员的物理联合边界，以 96 DPI 基准映射画布；成员缺失时不缩成剩余显示器 |
| mirror | 每屏独立呈现和资源额度，共享固定版本或一个轮播 Runner、逻辑时钟与切换票据 |

整机最多四个呈现目标、最多四个显示组。图片 mirror 最多四个成员；包含视频的 mirror 最多两个成员，并继续受整机两个 decoder 名额限制。离线成员也计入配置上限。内置场景、Follow Hertz 和 builtin 作品当前依赖历史积分状态，不能进入 mirror，仍可用 single/span。

显示器所有权在解析 Primary/Fixed 后核对，同一真实显示器不能同时属于两个成员。固定屏幕缺失、旧名称未解析或身份歧义不会回退到主屏。切换主屏、关闭或重建目标会按原生 generation 隔离回执。预览继续使用全局唯一租约，并携带 groupId；未知组拒绝，切组时释放旧组预览。

span 的矩形边界不能覆盖未选择的已连接显示器。例如三屏 A/B/C 排成一行，span 只选择 A/C 会被拒绝，避免覆盖 B；空白间隙和仅相接的边缘允许。拓扑宽限中保留的 span 也不能继续覆盖已被新组认领的显示器。

## 镜像内容检查与 Apply

`wallpaper.capabilities` 公布 `layouts:["single","span","mirror"]`、`multiDisplay:true` 和 `mirrorInspection:true`。`mirrorBuiltin/mirrorPackages/mirrorPlaylists:false` 表示不能按内容大类直接放行；设置页必须读取具体选择的检查结果。

`wallpaper.layout.inspect` 接收 `{selection,members}`，在原生侧核对固定版本、原包完整性、实际 manifest 和资源类型。轮播检查整个快照，不能因为当前项是图片而忽略后续视频或 builtin；重复的 `workKey + packageHash` 只核验一次。该查询不创建 decoder 或媒体准备任务，也不修改配置。

检查由一个后台 worker 持续执行。首个请求与进行中查询返回 `{pending:true}`，终态返回 `{layouts,mirrorEligible,maxMembers,reason?}`；其它 key 在 worker 退出前返回 `budget_busy`。查询的两秒期限只限制观察者，不取消正在读取文件的扫描。设置页每 500ms 轮询，pending 与 busy 都保持镜像和相应 Apply 关闭。真正查询失败最多重试三次，并显示可恢复的原因。

原生成功缓存最多 16 项、30 秒，key 包含选择、成员数、列表修订与固定引用。列表保存、删除、发布和导入变化使缓存失效；失效和服务退出会取消旧扫描，但读取槽在真实退出前不归还。普通播放准备不会取消扫描。设置页最多保留四组检查、16 个缓存结果、一个在途检查请求，并按草稿 epoch/组/选择/成员数隔离迟到回执。

Apply 在准备目标前重新核验全部启用的 mirror 组，包括所有成员离线的组，不以 UI 缓存代替原生准入。禁用时仍核验新建或更改了内容/成员的 mirror 意图；关闭未改变的已保存意图不依赖媒体健康，以便损坏的壁纸仍可关闭。列表写入在受理时取消相关 Apply，未完成的列表写入会阻止新 Apply，消除数据库提交与页面事件之间的修订竞态。

## 组播放、暂停与失败

镜像组只有一个轮播 Runner。所有成员使用同一个 index、固定引用与 switch token；每个目标另有自己的 generation。准备先收集可运行成员的隐藏首帧，再统一释放；收到真实 `presented` 才提交轮播。暂停和缺失成员不阻塞其它成员，恢复时加入当前项目，不调用下一项。

任一成员运行时组时钟推进；全部暂停时冻结。视频页面先持有隐藏首帧，原生使用 `performance.now()` 回调的有界往返样本换算页面时间，往返超过 40ms 的样本拒绝。页面通过 token 绑定的 seek 完成与新视频帧确认释放。运行中每两秒检查相位，环形偏差严格大于 100ms 才校正；不承诺跨显示器逐帧锁相。

motion=0 和暂停保持当前帧。被取消的 seek 在暂停期间完成后，恢复可能需要不超过 1 微秒的同帧 seek 重新取得帧证明；这个例外只用于释放，不改变周期校正阈值。低帧率视频的有效帧时间戳可以早于目标时间，帧证明按提交时间判断新鲜度，并继续要求 seek 完成。

成员失败会冻结整个组，保留已验证的静态画面，显式重试仍准备失败的同一个项目；对失败组成功 Apply 后也会重新开启该项。旧 surface 的媒体、GL、挂载或 watchdog 失败不能污染新票据。修改列表但首项字节相同仍使用新的 source generation；镜像只修改亮度等呈现参数则保留同修订列表的当前项。Apply 期间停止自动推进，Mirror 切换到 Single/Span 时不携带镜像组的 resume。图片暂停会重新开放呈现回执，停止前排队的旧回执按页面修订拒绝。

静态交接使用 `DesktopFrame` owner：不重复占用 presentation target，但仍计入 CPU/GPU/prepare 字节，并且最多四个静态帧。捕获工作区全局串行，旧 controller、读者与 staging 未实际退出时不能提前释放额度。视频切换先保留旧帧并释放旧 decoder，再准入新内容。

## 验证入口与证据边界

2026-11-06 窗口规则增量：最大化和指定前台应用 Pause/Stop 已按目标接入。仅修改窗口规则的 Apply 保留失败项目，不隐式重试；显式重新 Apply 或 retry 仍恢复失败原项。详见[窗口规则实施记录](wallpaper-window-policies.md)。下方数字是 A02 原有证据，最新设置页回归包含 24 项。

- [check-wallpaper-display-settings.js](../scripts/check-wallpaper-display-settings.js)：真实设置页资源与受控管理桥的 18 组 Chrome 检查，覆盖独立草稿、按组预览、手机宽度、六次 pending 和五次 busy 后恢复、迟到回执/缓存失效，以及内容损坏后关闭未改变的已保存镜像组。报告：[wallpaper-display-settings/report.json](../output/playwright/wallpaper-display-settings/report.json)。
- [check-wallpaper-runtime.js](../scripts/check-wallpaper-runtime.js)：调度、原生身份、隐藏首帧、环形偏差、两秒采样、暂停恢复、稀疏帧和取消清理的确定性回归。
- 真实 Chrome 补充验证暂停 seek 中断后恢复与约 2fps 视频，报告：[wallpaper-mirror-page-review/report.json](../output/playwright/wallpaper-mirror-page-review/report.json)。
- [check-wallpaper-displays-native.js](../scripts/check-wallpaper-displays-native.js)：Windows/WebView2 显示组 Apply、缺失屏、预览、session 保留、冲突与退出；两屏首帧与 span union 只在至少两块真实屏幕时运行。
- [check-wallpaper-mirror-native.js](../scripts/check-wallpaper-mirror-native.js)：通过真实 ImportJobs/解码探针导入图片和视频，验证资格、组切换、修订、呈现参数 Apply、暂停恢复、时钟漂移、真实资源 404 后保留封面及重试、资源归零。需要带 `wallpaper-media-probe` 的 debug 二进制。
- [check-wallpaper-works-native.js](../scripts/check-wallpaper-works-native.js)：回归 A03 作品保存/发布/预览及单屏轮播。

2026-11-06 原生结果：

| 检查 | 结果与报告 |
| --- | --- |
| 显示组 | [7 项通过](../output/playwright/wallpaper-displays-native-1793907218574/report.json)，双屏首帧与 span union 明确 skipped |
| 作品与轮播 | [10 项通过](../output/playwright/wallpaper-works-native-1793907238569/report.json)，含实际宿主重启、缺包停播和原项重试 |
| 镜像 | [最终构建 14 项通过](../output/playwright/wallpaper-mirror-native-1793907657975/report.json)，包含离线/新禁用意图准入、真实视频漂移、失败静态封面、retry/Apply 恢复、视频列表修订与 next |

以上显示组与作品报告的二进制 SHA-256 为 `40dd6e372bc1d0460a6eec588a5fe5de96a6c29c8fb61642ec340578c01692e6`；最终镜像报告为 `dd26a703c361e523d6028db5ed9dbac7679f67513d78e9f47853c2fa9bb383df`。早一轮镜像[14 项报告](../output/playwright/wallpaper-mirror-native-1793907039011/report.json)保留为历史证据。最终构建已包含 span 拓扑宽限修正，该三屏分支由专项规划器回归覆盖，不把单屏原生旅程改记成三屏实测。原生报告无页面错误，测试宿主已全部退出。

Rust 全库回归 458 项通过、2 项按既有音频硬件条件忽略；最终 span 宽限修正后，显示规划器 20 项全部通过。`hertz-desktop --all-targets` Clippy `-D warnings`、最终 debug `wallpaper-media-probe` 构建、本次新增 Rust 模块格式、相关 JS 语法及脚本登记检查通过。视频页面还覆盖了图片暂停回执失效、暂停 seek 中断恢复和低帧率帧证明。

原生脚本使用独立数据目录与自己创建的宿主，不改变 Windows 显示拓扑。当前只有 `\\.\DISPLAY1`（2560×1600，144 DPI）；第二成员为离线 Fixed 引用，用于证明缺失成员不会回退或阻塞。它不能证明两块物理屏幕同时呈现或同步。

待真实硬件验收：双屏混合 DPI、负坐标和旋转、span 联合画布、逐屏全屏策略、局部暂停恢复、热拔插/换主屏、两路视频 decoder 峰值与跨屏相位、四目标整机峰值、休眠/RDP 和八小时长稳。当前实现与回归不等于发布候选已经完成这些验收。

核心实现：[display.rs](../crates/hertz-desktop/src/wallpaper/display.rs)、[group_playback.rs](../crates/hertz-desktop/src/wallpaper/group_playback.rs)、[wallpaper_mirror.rs](../crates/hertz-desktop/src/wallpaper_mirror.rs)、[wallpaper_apply.rs](../crates/hertz-desktop/src/wallpaper_apply.rs)、[selection_plan.rs](../crates/hertz-desktop/src/wallpaper/selection_plan.rs)、[service.rs](../crates/hertz-desktop/src/wallpaper/service.rs)。
