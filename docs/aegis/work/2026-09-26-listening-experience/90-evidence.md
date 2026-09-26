# 体验升级验证与架构记录

日期：2026-09-26。直接实现后验证，未使用 TDD。

## 实现与所有权

- Shelf 只消费 app 提供的歌单与 PlaylistCovers 共享封面，事件仍通过 shelf:action 交给 app。7 个 DOM 节点按歌单身份复用，未引入播放或请求逻辑。
- StageLyrics 只消费 Stage 的 lines、position、lyricTokens；挂在 Stage3D 现有帧门，没有新增 rAF 或播放时钟。旧 Stage3D 三行歌词 DOM、分词染色和事件已移除。
- Stage3D 持有 scene/motion/bloom/reactivity/lyrics/cruise/layout/lyricSize/lyricGlow；configure 静默更新，save 走既有 stage:control → app → settings.stage3d。
- Workshop 默认编辑 Stage3D；高级编排保留 CreativeStage 预置格式与全部页签，通过 workshop:target 事件由 app 激活对应渲染。未混合两套渲染器的参数所有权。
- Stage3D 按画布实际区域调整 DPR、相机比例与指针坐标，工坊桌面侧栏/手机底部抽屉占用真实布局空间。

架构对齐：aligned。基线为现有 Stage / PlaylistCovers / app / CreativeStage / Stage3D 职责与 BASELINE-GOVERNANCE.md，未修改治理文件。ADR 回填：本文登记新增展示模块与目标切换契约；无新增生产依赖或后端 API。

## 验证命令与结果

| 检查 | 结果 |
| --- | --- |
| cargo build -p vmusicd | exit 0，最终内嵌资源构建成功 |
| node scripts/check-assets.js | 345/345 |
| node scripts/check-css-tokens.js | 通过，5 文件 / 1352 规则 |
| node scripts/check-stage-cinema.js | 114/114 |
| node scripts/check-stage-control.js | 74/74 |
| node scripts/check-stage-idle.js | 29/29 |
| node --check 四个变更 JS 模块 | exit 0 |
| git diff --check | exit 0 |
| node scripts/check-creative.js | 267/268，见下述独立失败 |

Playwright CLI 会话 hertz-stage。最终运行在编译后的 7645 服务上，page.unrouteAll() 后重新验证；开发期间的本地资源覆盖已移除。

- `target/listening-check.js`：29 项通过。实际 WAV 播放器 seek、歌词原文空格、邻近行上限、逐字进度、浏览回位、点行 seek、3D 封面、实际舞台编辑、7 图卡、撤销/重做/重置、目标切换、手机布局、减少动态效果与无 pageerror。
- `target/listening-shelf-check.js`：10 项通过。稳定节点、移动、改名/数量、删除前项保持选中、pointercancel、侧卡点击、手机宽度、Home/End。
- `target/listening-edge-check.js`：14 项通过。真实拖动、横向滚轮、共享封面显示、图像加载和失败回退、select/switch 焦点保持、布局/字号刷新持久化、长句完整显示、5 秒回位、减少动态效果与无 pageerror。
- `target/stage-compat-check.js`：20 项通过。无 WebGL2 降级及返回焦点、390/360/320 宽度与 844×390 横屏的控件布局。
- `target/stage-effects-check.js`：30 项通过。合成频谱在实际 WebGL 中的分频响应、起音、零强度/暂停回落、镜头、全屏、偏好保存、context loss/restoration、destroy/init、无 JS 异常或 shader/GL 警告。原固定等待断言在高负载下不稳定，改为等待真实包络收敛；未改生产参数来迎合断言。合计浏览器 103 项通过。

截图已人工查看：`output/playwright/listening-{lyrics,sleeve,workshop,shelf}-{desktop,mobile}.png`，以及明确标记的 cover-fixture / long-lyrics 截图。

## 独立失败与验证边界

`check-creative.js` 的扫描断言硬编码旧调用 `get_track_id_by_path(&state.db, &track.path)`。另一项正在进行的扫描改造已使用 existing 映射、previous id 赋值，再以 track.id 保存封面；本轮未修改该正则或扫描实现。不能声称全仓测试全绿。

使用隔离测试数据与 null 音频后端，未验收真实声卡输出、所有 GPU 的帧率或远程封面网络可靠性。程序化封面是无图回退及显式测试夹具，不冒充实际专辑图片。用户对参考项目同等视觉质量的主观验收仍以运行页面为准。

修复记录：替换 slot 重绑定为稳定卡片身份，移除旧三行歌词 owner；保留高级编排是有明确入口的独立功能。置信度 B：直接交互、构建与相关回归有证据，设备与主观质量边界如上。
