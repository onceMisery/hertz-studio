# 创意工坊真实舞台验证

日期：2026-10-07。续接原会话，遵循用户不走 TDD 的要求；实现后进行契约、真实浏览器和独立复核。

## 结果与证据

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| `cargo build -p hertz-studio --bin hertz-studio --target-dir output/workshop-stage/build` | exit 0 | 包含当前 UI 的独立构建；复制到隔离测试实例，不占用用户运行实例 |
| `node scripts/check-frontend.js --extra` | exit 0，42 步通过，0 失败 | 语法、资源、CSS、舞台、背景、歌词、创意参数与既有前端回归；其中创意契约 354 项 |
| `node scripts/check-workshop-stage-browser.js` | exit 0，7 组通过，无 pageerror | Chrome 实际内嵌页面、真实 WebGL、真实 HTTP/WebSocket 与隔离播放时钟 |
| `git diff --check -- <本任务文件>` | exit 0 | 无补丁空白错误 |
| 独立审查 + 隔离 Chrome 探针 | 无剩余重要发现 | 背景和创意场景都能影响像素；暂停圈注更新及隐藏清理；保持手绘门停机 |

浏览器环境：`NODE_PATH=C:\Users\miracle\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules`，
`VMUSIC_DATA_DIR=D:\code\github\hertz-studio\output\workshop-stage\data`，
`STAGE_VISUAL_URL=http://127.0.0.1:18779`（脚本默认值）。
测试只接受 `backend=null` 的隔离服务，并先比较 10 个舞台相关内嵌资源与工作树，避免测到旧二进制。

## 浏览器验收明细

- 所有高级场景卡真实渲染；无独立预览和展开按钮；暂停更改镜头距离会改变实际舞台像素。
- 秒级 cue 在 5.5 / 7.5 / 10.5 / 2 秒得到预期曝光值，覆盖插值、保持、后续 cue 起点和反向 seek。
- 自定义背景开启时，镜头调整仍改变画面；手绘只挂大舞台艺术层，不为应用根节点加手绘皮肤。
- 应用与系统减弱动效均冻结 shader 时间和镜头；手绘门为 0、创意门不超过 15 且只注册一次。
- 暂停后场景时间稳定；封套位于创意背景上方；暂停 seek 更新圈注、隐藏歌词清空圈注。
- 人为模拟创意引擎启动失败后，提示可见；切回沉浸来源清除对应错误提示，再次进入创意来源恢复。
- 三次开关大舞台后，creative canvas、背景与手绘各只有一个实例；关闭工坊继续演出。
- 600×900 移动布局舞台与面板不重叠；关闭大舞台恢复背景与手绘原宿主并释放大舞台 GL 画布。

日志：`output/workshop-stage/frontend-current.log`、`output/workshop-stage/browser-current.log`。
截图：`output/playwright/workshop-stage/{manga-editor,color-editor,stage-performance,sleeve-comic,mobile-editor}.png`。
已人工检查漫画编辑、完整演出与移动布局截图。

## 架构与边界

架构对齐：aligned。Stage 是唯一播放时间和帧门 owner；CreativeStage 唯一解析编排；
Stage3D 管来源、图层顺序与生命周期；Backgrounds/HandDrawn 各保留一层。
ADR Backfill：amend，已补充 ADR-0006 的创意来源、合成和暂停补画约束。

修复轨：实际舞台接线、cue 时间轴、背景合成、手绘呈现及暂停/减弱动效。
退役轨：模拟频谱预览、宽屏预览开关、预览看门狗、重复 creative 帧门及旧预览验收脚本/包装器。

置信度 B。隔离 null 后端用于确定性播放时钟和 UI 验证，不宣称覆盖物理声卡输出、所有 GPU 性能或 DBX 插件宿主实机。
当前运行中的用户旧实例需使用新构建重启后才会加载这些资源。工作区其他任务的业务修改及 Git 操作不由本次续接处理。

Goal status: satisfied；Stop state: done。授权范围已完成，无待处理实现事项。
