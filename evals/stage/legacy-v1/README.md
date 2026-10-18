# 重构前舞台行为与固定分享码

本轮从真实历史提交 `b8aff4a89dc3f1e43981d2227838e497e65ea9b2` 回溯建立 fixture；它是物化提取提交 `f0ecaca` 的父提交。本记录是事后回溯冻结，不宣称当时已经先记录 fixture 再重构，也不采用 TDD。它补充当前代码自行生成的分享往返检查，用固定历史输入和输出核对兼容性。

[样本](./fixtures.json)覆盖全部十个历史场景：towers、orb、tunnel、nebula、terrain、lyric，以及 anime-sky/coast/rail/forest。每场景一例切换、一例同场景编辑，共 20 组；包含用户基线、场景参数与公共参数夹位、director 和手绘开关。完整预置、applied/ignored 数组和旧 `HSCP1.J` 分享帧均固定保留，不只比较场景 ID 或少量字段。

[历史源码归档](./sources.json.gz)包含该提交的 onset、CreativeGL、Backgrounds、HandDrawn、四个 anime 场景注册、CreativeStage 和分享 codec 七个模块。捕获时直接通过 `git show <完整提交>:plugin/ui/<文件>` 读取原始字节，没有把当前默认值或当前物化器用于生成期望输出。[清单](./manifest.json)记录 fixture、压缩与展开源码的 SHA-256；各源文件的 SHA-256 在样本中。JSON 保持 LF，以免 Windows 检出转换改变冻结指纹。

[检查脚本](../../../scripts/check-stage-legacy-fixtures.js)先重放历史模块的实际 `setPreset` / `applyIntent` 和编码，核对记录没有漂移；再加载当前真实模块，核对纯物化、既有规则应用入口和固定旧分享码导入均得到相同的完整预置。纯物化还核对原 owner 预置未变。默认入口不依赖 Git 历史，因此浅克隆 CI 也能运行；`--git` 另独立核对七份归档源码确实来自该历史提交。本机两个模式均通过，默认检查已加入前端聚合。

```powershell
node scripts/check-stage-legacy-fixtures.js
# 需要本地已经具有该历史提交；不获取网络对象。
node scripts/check-stage-legacy-fixtures.js --git
node scripts/check-frontend.js
```

检查运行在 Node 开发期 VM；计时、存储、绘制和事件投递被隔离，不渲染 WebGL、不调用服务、模型、音源或用户预置。它不证明真实 GPU/弱机效果、原生 DBX 导入旅程、所有历史用户自定义预置、压缩分享帧、规则语言全部表达或人工视觉验收。其它 codec 边界及全场景当前契约/参数消费仍由原检查覆盖，不能用这 20 组代替完整发布矩阵。新增参数/默认值如果改变历史兼容性，应明确审阅版本与迁移，不自动重写本组期望值。
