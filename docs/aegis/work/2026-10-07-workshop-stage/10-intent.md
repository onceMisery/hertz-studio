# 创意工坊与真实舞台统一

用户要求：分析并移除无意义实时预览，保证大舞台消费创意编排；背景与手绘实际作用于舞台，手绘呈现漫画电影风格。明确不走 TDD；已授权子代理并行实现。

ArchitectureReviewRequired: yes

BaselineReadSet: README 创意舞台、ADR-0006、2026-10-07-stage-compatibility 计划；creative-stage/workshop/stage3d/backgrounds/handdrawn 与歌词 renderer 的当前工作树。保留已有未提交修改。

Root cause / PatchShape: 预览使用模拟频谱，场景卡写 Stage3D 而参数写 CreativeStage；背景在 body 下，手绘只挂 #stage；歌词 renderer 自带底板再次遮挡。Canonical owners: CreativeStage 持有编排/频谱解析，Stage3D 持有呈现来源和宿主生命周期，Backgrounds/HandDrawn 持有各自唯一图层。修复 owner，不映射或复制两套参数。

Plan:
1. 移除工坊独立预览、模拟频谱及看门狗；以现有 CreativeGL 引擎在大舞台渲染同一预置。
2. Stage3D 增加持久化 sceneSource（immersive/creative），控制实际背景来源、歌词背景透明和能力提示。工坊关闭后演出继续。
3. Backgrounds 单层移动至舞台；HandDrawn 单层移动至独立艺术覆盖层，漫画分镜/纸感/排线、真实音乐时钟、暂停补帧。
4. 工坊场景、参数、编排统一来源，电影风格选择保留旧字段，删掉无效和实现细节文案。
5. 实现后运行针对性 Node 检查及真实 Chromium 交互/像素/暂停/生命周期验证，审查兼容与资源生命周期。

Retirement: 移除 previewView/synthSpectrum/预览看门狗/宽屏预览模式和全应用手绘装饰。保留侧栏原增强渲染入口与现有配置、导入导出、独立/插件宿主。新来源不复制预置。
