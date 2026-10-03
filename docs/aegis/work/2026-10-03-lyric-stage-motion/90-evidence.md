# 验证证据

2026-10-03，用户选择「清晰流畅，接近参考项目」，并要求不走 TDD。后续工作直接实现、视觉调节，再执行回归。

## 实现

- StanzaSonnetFx 保留唯一逐字时间/运动 owner。商籁柔和抬升，凝彩按词组选择上升、左右入场、轻盖印或小角度转入；位移按实际 fit 后字号计算。
- 字首字尾透明度和主题色连续；长音有轻微持续强调，收尾 260ms 回落；零时长和标点不触发弹跳。
- 句尾提前 160ms 收起已唱文字，当前仍在唱的字保留亮度；顺播换句借用原 retirement 生命周期在 180ms 内移走旧正文。seek、换曲、节能、减少动态不留下旧句；最多一条旧句。
- 凝彩反色克隆同步原字 alpha，扫光尖角收窄，减少未唱字被提前覆盖。
- 没有新增渲染依赖、rAF、定时器、播放时钟、存储设置或 API。

## 检查

以下命令均退出 0：

- `node scripts/check-stanza-motion.js`：字首字尾连续、长音与余韵、标点、减少动态、seek 可复现、尺度有界。
- `node scripts/check-stanza-sonnet.js`。
- `node scripts/check-stanza-tempera.js`。
- `node scripts/check-stanza.js`。
- `node scripts/check-stage-idle.js`：29/29。
- `node scripts/check-sonnet-palette.js --browser`：1083 组调色采样；真实 Chrome/Pixi 六种布景及 16 组图片模式组合，最低透明比例 0.9371。
- `node scripts/check-stanza-motion-browser.js`：商籁/凝彩 × 1440×900、390×844、844×390，共六组；暂停、seek、旧句回收、短句、长句、中英混排、减少动态、节能和销毁。凝彩额外检查反色与原字 alpha 相同。
- `node scripts/check-stanza-visual-fx.js`：四组真实 WebGL 后期/明暗层次/彩色像素/图片背景验证。日志：`output/stanza-motion-verify/postprocess.log`。
- 修改的六个 JavaScript 文件 `node --check`，相关 `git diff --check`。

浏览器依赖使用本机已有 `D:/code/github/folia-major/node_modules/playwright`，通过 PLAYWRIGHT_MODULE 或 NODE_PATH 指定；没有安装依赖。夹具使用独立 Stage 时钟，不修改用户音乐库/播放设置。

## 视觉复核与检查修正

- 截图在 `output/stanza-motion-verify/`，覆盖唱中、交接、长句、混排和减少动态。
- 人工复核发现初版旧句淡出过慢，产生明显叠字；收短并增加句尾提前收束后再次截图检查，新句清楚、旧句仅短暂淡影。
- 旧配色检查只接受两个离散 tint，与本次连续染色不兼容；改为验证颜色始终落在同一正文→强调色轴，仍排除逐字随机色。
- 图片模式检查原先仅接受 filters=null；现有未改动的 optical chain 用空数组摘除后期，故允许 null 或空数组，并保留真实透明像素验证。

## 架构与边界

- Architecture Alignment：aligned。Stage → buildFrame → 原 FX/Director 路径保持一致；正文退场由已有 retirement 管理，没有重复生命周期 owner。
- 替换旧硬切色/统一弹跳逻辑，未保留并行旧实现；新增状态最多一条旧句并明确销毁。
- ADR Backfill：skip。没有改变持久架构、公共数据契约、依赖方向或宿主兼容策略。
- Confidence：B。真实桌面 Chrome/WebGL 与模拟手机视口已验证，未测试物理低性能设备，也未重新打包 DBX 插件。用户同期的皮肤、CI、登录等修改未纳入本任务。
- Goal Closure：satisfied；停止状态 done。
