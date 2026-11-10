# builtinScene 组合实施与当前资格

2026-11-11，分支 `codex/continue-designs-final-20261110`。A04/P2 的首个 `builtinScene` 适配器已接入原生组合路径。本记录限下面的场景子集和当前 Windows 设备，完整 P2、A05/A06/A10 与 A01–A10 目标继续实施。

## 可运行范围

组合可使用一个根 `spectrum-towers`、stateVersion 1 背景，与既有 image、video、同包 text、2D group 和 particles 图层共同呈现。源 profile 固定为 low；ripples 和源九项 post 参数必须为零。medium/high 请求保留在设置中，实际准入明确降为此 low profile。

可组合资格、完整参数规格和资源计划由原 scene registry 发布，再通过原 catalog 导出给 Rust。两端检查编译器最终公开参数槽、实际结构版本及完整参数映射，缺项不补默认值。其它 28 个 scene、model、3D group、显式相机、文档 effects、tracks 和 bindings 继续返回明确不可用；不会删掉作者层或把非零效果静默归零。

## 呈现、成本与时间

目标在媒体、字体和文本准备前，根据真实显示器、物理尺寸、已核实 DPI、刷新率和原预算选择唯一栅格。媒体准备、字体栅格、目标缓存、原生投影和页面 backing 尺寸共用此结果。预览保留自己的 monitor/DPI/refresh 事实；尺寸或目标变化沿现有失效路径重新规划。

同一 renderer 先绘制三维背景，清 depth 后按作者 painter order 绘制二维层，再执行一次最终 sRGB 输出。原 factory、wrapper、scope 和资源池保持归属。四个 source buffer 在第一个 loader/factory 前预留八张独立 CPU/GPU 票据，工厂按确切 ID/字节认领；原生和页面均计入 drawing buffer、线性目标、depth、媒体、字体、shader 和私有缓冲的完整成本。输出相关 GPU 声明成本为 20P，不以单个颜色目标的 8P 代替总额。声明成本不是 GPU 硬件内存实测。

原帧时钟保持唯一。两个预分配的 75 元素 Float64 输入 bank 共 1200 字节，分别保存 pending 与最后实际 committed 输入；这个数字只表示 typed-array backing。暂停重绘恢复 committed 相位，失败输出、未完成 decoder 或旧 generation 不提交新输入。共享引擎的显式 seek 重置原 wrapper 历史后按绝对时间采样，同一 pending 请求重试只重置一次。

设置页显示原生准入画质和预算帧率上限，同时保留用户设置值；不会把 configured FPS 或实测吞吐叫作准入上限。颜色输入恢复到原保存值时，标题、页脚和禁用的 Apply/Discard 保持一致，不产生配置提交。

## 验证证据

最终 R5 由 HEAD 源码快照叠加本任务文件构建，排除了并行 phoenix 编辑并重新生成 bundle/manifest。Rust 1.88 dev、`wallpaper-media-probe`；298 个输入、构建前后及物理 snapshot 绑定到 binary SHA-256 `84df03d8f80d0087bbc50a514dea4e7764185e06a64466df799dfedf68d16823`。共享工作区的其它任务改动保留。

| 检查 | 当前结果与范围 |
| --- | --- |
| Rust / 格式 / Clippy | 桌面库 696 通过、2 个原条件 ignored；壁纸库 83 通过；两个受影响 crate fmt/Clippy 通过 |
| 合同与前端 | source contract 10、sampler、两个 exporter；干净 bundle 的 frontend extra 95 步、0 失败 |
| 规划 | 18 项，包括完整参数/版本映射、投影篡改、完整内存反例和独立相机计算 |
| 浏览器呈现 | 12 项；非饱和背景与透明图层像素、横竖三 Fit、同包字体、真实视频 reverse seek、fresh/forward/reverse/loop 输出及释放 |
| 浏览器生命周期 | 13 项；加载前七类 cap 拒绝、真实 decoder pending 后暂停、final-output 失败不 commit、延迟加载/换代、借用 renderer、实际 depth clear、forced context loss |
| 设置页 | 33 项；含 saved/header/footer 重置一致性，准入 low/27.5 与设置 high/30、实测吞吐的区别 |
| Windows R5 | 10 项；真实导入、独立预览、三 Fit、暂停恢复、重置/运行文案、自然退出重开、非零谓词拒绝保留 current、关闭后原生预算归零 |

当前设备物理 2560×1600、DPI 144（scale 1.5）、165 Hz。桌面实际准入 raster 为 1264×790，30 fps 请求的预算帧率上限为 27.5 fps；独立 high/30 预览准入 low/15。两个自有原生 PID 均自然退出 0，sourceAfter 一致，未终止既有用户进程。

报告和源码身份保存在 `output/design-final-followthrough/` 的最终验证记录，以及 `output/playwright/builtin-native-r5/report.json`。干净源码目录 `output/design-final-followthrough/builtin-commit-source-r3b/` 内保存对应 browser/plan/lifecycle 报告与候选。R3 的选择器失败、R4 的 configured/actual 文案问题保留历史归属，不能回溯改为通过。

FONT R22 的 42/31/25 三份独立原图审阅合计覆盖全部 98 张，原图哈希、尺寸及审阅集合已重新核对。其 40 个可达技术行、40 cold 和四次完整 601 秒保持属于冻结候选；UI04/D03 gap 及原 UI03 页脚 P2 保留。R5 重置截图仅证明新候选修正，不回溯授予 R22 完整资格。SVG 的冻结 native/browser/lifecycle 验收集另见[SVG 实施记录](wallpaper-svg-resources.md)。

## 保留的后续工作

原生/编辑器 seek 用户入口、其它 scene/model、GLB/KTX2、文档效果、时间线/绑定与组合编辑器仍待实施。多屏/DPI/刷新率实际切换、其它 GPU/设备、4K、设备绝对性能和长稳分别待验。浏览器 forced context loss 时没有活动 video decoder；depth 用例观察实际 GL clear mask，不等于独立 depth 像素 oracle。现有浏览器 projection 明确记录复用 native mapping，不冒充当次新原生导出。

HWPK1、documentVersion1、Config5、CAP256、TTL600、准备单槽、原权限/会话/资源/预算 owner 保持。没有付费调用、外部发布或完整产品完成结论。
