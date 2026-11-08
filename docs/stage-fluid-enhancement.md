# 二维舞台流体增强

在「舞台控制 → 二维舞台场景」之后增加独立的「流体增强」分组。默认关闭；开启后在封面外沿呈现半透明流动，跟随音乐，也可响应鼠标或笔的悬停移动。文字、进度条和歌词区域不参与流体绘制。

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| 流体增强 | 关闭 | 只控制新增图层，与原滤镜、舞台粒子及节拍涟漪独立 |
| 强度 | 35% | 0–100，控制本效果的着色与输入扰动；0 会释放资源 |
| 跟随音乐 | 开启 | 消费既有频谱、能量和起音输出，不另建音频分析 |
| 指针互动 | 开启 | 只观察局部非交互区域，不接管触屏、拖动、滚轮或点击 |

关闭后保留子项设置，重新开启沿用。全部恢复默认与撤销继续使用现有控制面板机制。偏好保存在原有 `vmusic.stage.control`，不写入分享码、工程、AI 意图或 Rust settings。

## 运行范围

当前仅对独立浏览器的 high 档开放，用于普通二维 `#stage` 的 venue、diorama、tempo 场景。still、减少动态、balanced 或 eco 档会暂停并释放效果资源；请求开关仍保留。进入 Stage3D、Space3D 或创意舞台时释放二维流体，返回后按请求重建。

DBX 本轮性能验收未通过，因此明确显示「当前宿主暂不支持此效果，请使用独立浏览器」，不创建流体画布或上下文。DBX 仍通过既有存储 shim 恢复这四项偏好，但不能将偏好恢复误认为效果可运行。balanced 档也暂不开放；后续放开必须补性能与实机证据。

暂停播放会冻结现有输出；舞台抽屉关闭、页面隐藏时不再模拟或绘制，也不积累输入。恢复后重置时间增量，不补算隐藏时长。音乐频谱断供后停止音乐注入，残余流动消退后停止绘制；新输入可唤醒同一帧门。

WebGL2、浮点颜色附件、着色器或缓冲分配失败，以及 context loss，只影响此效果。界面显示状态，需点击「重试」或关闭后重开；尺寸改变不会触发自动重建。图层不接受指针命中。

这项增强没有新增二维视频录制能力，也不进入现有三维录制文件。原有录制来源限制不变。

## 所有权与实际预算

`stage-control.js` 持有设置与撤销；`stage.js` 持有唯一帧时钟。`stage-fluid.js` 只管理自己的实例、输入及可见状态，登记一次 `Stage.gate('stage-fluid', …)`。内部 WebGL 引擎接受外部时间与输入，没有 rAF、定时器、全局输入监听或 DOM 捕获。

| 实际配置 | high | balanced | eco |
| --- | --- | --- | --- |
| 帧门目标 | 20fps | 暂不启用 | 0 |
| 模拟网格 | 64² | 无 | 无 |
| 染料纹理 | 128² | 无 | 无 |
| 输出像素上限 | 1,000,000 | 无 | 无 |
| 压力迭代 / 每帧模拟步数 | 4 / 1 | 无 | 无 |

这些值低于设计上限。半拉格朗日平流直接使用封顶 50ms 的场景增量时间，衰减按时间归一化。输入总量最多 16 项，每个效果帧最多消耗 4 项。实际帧率由现有整数分频和设备负载决定；帧门的预算值不等于执行帧率。

开启最多新增一个 WebGL2 context。high 的可追踪模拟纹理约 320KiB，另外有输出缓冲和驱动开销。`StageFluid.stats()` 提供资源、输出像素、模拟／绘制次数和生命周期计数。关闭显式删除 GPU 对象并释放上下文；这些计数不能证明驱动已同步归还全部显存。

## 源码与许可

内部 solver 和 shader 提取自 Canvas UI 的 `src/lib/Liquid/LiquidVanilla.ts`，固定提交 `a04a99b235299ee79a123a16ccb2e6cf9da74b6b`。已移除框架 wrapper、HTML-in-Canvas、内容纹理、自主调度与输入监听。

派生部分保留 David Haz 署名及 **MIT + Commons Clause** 完整条款，见 [LICENSE](../tools/stage-fluid/LICENSE.md) 和 [移植说明](../tools/stage-fluid/README.md)。它作为 Hertz Studio 应用内部组成部分分发，没有独立组件包，未并入标为 MIT 的共享 Three.js runtime。此部分不能按项目纯 MIT 代码处理。

构建／校验：

```sh
node tools/build-stage-fluid.mjs
node tools/build-stage-fluid.mjs --check
node scripts/check-stage-fluid.js
```

构建使用 `tools/space-stage` 已有 esbuild，不新增整套上游站点依赖。生成文件为 `plugin/ui/vendor/stage-fluid.js`，完整许可随产物保留。独立版资产宏与 DBX 本地资源使用同一文件。

## 验证与发布边界

浏览器检查需要 Playwright 和 Chrome。完整应用检查还需要当前构建的 `hertz-studio`，可用 `HERTZ_BIN` 指向隔离验证构建。

```sh
node scripts/check-stage-fluid-browser.js
node scripts/check-stage-fluid-hidden-browser.js
node scripts/check-stage-fluid-app-browser.js
node scripts/check-stage-fluid-app-browser.js --performance
node scripts/check-stage-fluid-app-browser.js --visual
```

第一项验证真实变化像素与封面外可见像素、默认零资源、暂停／隐藏／频谱断供、减少动态、故障锁定、20 次开关、异步取消、合法偏好恢复、窄屏和真实 `host.js` 的沙箱存储路径，同时确认 DBX 不申请 GPU 资源。第二项加载完整生产界面，检查真实 Stage3D／Space3D 入口、资源交接与隐藏抽屉。

性能模式顺序检查独立版和受控 DBX 沙箱的 1080p／4K、原粒子关／开，共 8 种组合。对允许开启的组合，每一侧默认采样 60 秒，另有预热；当前开放范围约需 5 分钟。保存原始帧间隔、GPU、浏览器、实际流体帧率、质量档及资源。只有中位数增幅 ≤10%、P95 增量 ≤4ms 且效果确实在运行才通过。`HERTZ_FLUID_SAMPLE_SECONDS` 只用于明确标注的短时诊断，不能代替 60 秒验收。

未开放的宿主／档位单独核对不可用原因、零资源和零绘制，不记为流体性能通过。如采样中原 Stage 裁决为 eco，也单独记录保护暂停。可用 `HERTZ_FLUID_CASE=0..7` 单独复测一组，并用 `HERTZ_FLUID_EVIDENCE_DIR` 保留独立证据目录。

2026-11-01 的失败记录保留在 `performance-before-admission.json`：当时 DBX 1080p 原粒子开启的一组中位帧间隔增加约 31%，4K 原粒子关闭的一组 P95 增加约 17.8ms，均超过设计门槛。因此本次按设计的停用规则收窄实际开放范围，没有把这些组合标成通过。

最终 20fps 配置在 Chrome 156、Intel UHD Graphics A7A8 / ANGLE D3D11、DPR 1 下的完整应用复测：

| 独立版 1920×1080 | 关闭时中位数 → 开启时 | P95 增量 | 实际流体帧率 | 结果 |
| --- | --- | --- | --- | --- |
| 原粒子关闭 | 12.1ms → 12.0ms | -6.4ms | 13.41fps | 达到本机设计门槛 |
| 原粒子开启 | 12.2ms → 12.2ms | -0.3ms | 13.33fps | 达到本机设计门槛 |

两侧分别采样 60 秒；流体门 CPU 平均耗时约 0.20／0.21ms。负增量只是本轮测量结果，不代表流体能提高性能。实际帧率低于 20fps 预算，未将预算冒充执行频率。最终原始数据单独保存在 `output/playwright/stage-fluid-final/performance-result.json`；另外六种未开放组合只证明零资源准入限制，没有性能通过结论。本机复测不能推广为其它 GPU／浏览器的保证。

证据在 `output/playwright/stage-fluid/` 与 `output/playwright/stage-fluid-app/`，不作为发布资产。完整应用的 DBX 检查使用真实不透明 iframe 与受控 SDK；它没有运行原生 DBX 客户端，也没有验证 WebView2／WKWebView 的各版本和实体设备矩阵。不能据此宣称 DBX 实机兼容已验收。

本轮 `--visual` 的控制面板、三组受控频谱截图与短片在 `output/playwright/stage-fluid-visual/`，短片为 `standalone-controlled.webm`。最终 21 项流体浏览器场景、完整应用交接、原控制面板 27 项场景、原粒子、帧门、舞台设置、视频导出、资产／插件资源、ADR 和发布压缩检查通过；Standard／Full 暂存资源都保留完整上游许可，隔离验证二进制编译成功。仓库整体脚本登记检查另有两项既有壁纸脚本未登记，本次新增检查均已登记，未将这一项报告为全绿。

真实静谧／节奏／人声歌曲的短视频与人工视觉收益评审仍需在目标宿主进行；受控频谱只证明响应路径与真实 GPU 输出。默认关闭和明确的不可用状态用于保留用户控制，不能替代宿主与视觉验收。

## 2026-11-08 隐藏 GPU 操作修复

当前 Hertz 布局通过 CSS 隐藏旧二维舞台。流体现由自身冷路径缓存宿主非零尺寸；默认隐藏时不申请效果资源，既有实例在布局变为零时暂停。抽屉关闭、页面隐藏和零布局期间，resize、参数/配色与换曲不再重设输出或清理 GPU；恢复后的可见帧更新尺寸并按原媒体 epoch 清理，暂停换曲仅提交一帧静态输出。请求值、Stage 公共可见性语义和原质量预算保持。

[定向记录](aegis/work/2026-11-08-stage-fluid-hidden-gpu/20-checkpoint.md)保留两条实际根因、诊断失败和修复前字节。26 组真实 Chrome 定向检查通过；完整当前生产页面在隔离 R2 HTTP/null 音频服务上验证八项观察，默认隐藏零分配/零操作、受控重新显示可绘制、再次隐藏停绘、关闭释放。完整页面的重新显示是明确的诊断样式，不是新用户入口；来源脚本来自当前源码，不能算作已重建的安装候选。

本增量不代表 M1 的全部跨宿主治理、总 GPU 峰值、弱机/多 DPI 或 M2–M4 已完成；原性能样本仍保持其冻结范围。


随后新增[实际内嵌整合验证](aegis/work/2026-11-08-stage-fluid-hidden-gpu/92-embedded-review.md)：新Full/Standard原生release各自提供13个相符资源和完整页面八项通过观察，没有静态源码覆盖；两种DBX release完成编译/归档。原R2组件保持相同，八步编译/构建与729/199/1277输入复核记录在 `output/a09-current-embedded-20261108/embedded-qualification.json`。播放器回归和1440/390稳定设置截图另通过限定检查。这是新内嵌HTTP页面的资格，DBX实际PluginHost、原生托盘、实体GPU/DPI及M1–M4继续开放。前述源覆盖结果和诊断失败均保持其原范围。
