# 90 · 完成证据：第 14 项首期（离线提示词生成舞台）

日期：2026-09-26。所有数字均为本机实际运行输出，非计划期望值。

## 自动化命令结果

| 命令 | 实际结果 |
| --- | --- |
| `node scripts/check-creative-prompt.js` | `creative prompt: 90/90 passed`（覆盖方案 §2 全部 7 个验收输入、英文别名与词边界、NFKC 全角、120 字 code point 截断、重复别名开发期报错、确定性、防污染、退休路径与不可用场景警告、否定最后生效） |
| `node scripts/check-creative.js` | `创意舞台契约检查：297/297 全部通过`（其中新增 `StageIntent 原子写入口` 一组 22 条：坏版本/空意图/未知场景拒绝且零事件、切场景默认值与入画机位、patch 优先并钳位、跨场景 sc. 路径进 ignored、名称/cue/绑定/hand 保留、单次 preset 事件、同场景不重置、下拉参数夹档） |
| `node scripts/check-assets.js` | `前端资源接线检查：354/354 全部通过`（含新增顺序约束 `creative-stage.js → creative-prompt.js → workshop.js`） |
| `node scripts/check-css-tokens.js` | `CSS 令牌契约检查通过（5 个文件 / 1403 条规则 / 49 个受检声明）` |
| `cargo test --workspace` | 退出码 0（全部套件 0 failed） |
| `cargo clippy --workspace --all-targets -- -D warnings` | 退出码 0 |
| `cargo build -p vmusicd` | 退出码 0（内嵌资源编译通过） |
| `git diff --check` | 干净 |

## 真实浏览器验收

- 构建：`target/debug/vmusicd.exe`（dev profile），启动参数 `--port 7831 --data-dir output/evidence-prompt-stage/data`，`VMUSIC_BACKEND=null`（隔离数据目录 + null 音频后端）。
- 浏览器：ZCode 内嵌 Chromium，`Chrome/146.0.7680.80`（Electron 41）。
- 视口矩阵：1440×900 / 390×844 / 320×568。

| 验收点 | 结果 |
| --- | --- |
| §2 例 1 `梦幻星云，缓慢镜头，霓虹，跟随音乐` | 识别结果：场景 星云 / 镜头 缓慢 / 质感 霓虹 / 音乐响应 跟随音乐；`scene=nebula`、`cam.drift=18`、`cam.shake=25`、`look.grade=3`、`director=true` |
| §2 例 2 `高速隧道，强烈节拍，近景，不要颗粒` | `scene=tunnel`、`cam.dist=9`、`cam.kick=120`、`cam.drift=115`、`cam.shake=130`、`look.grain=0` |
| 解析不改动舞台 | 解析前后 `CreativeStage.preset()` 深相等 |
| 应用原子性 | 一次应用恰好 1 次 `preset` 事件 |
| 撤销完整恢复 | 应用前快照与撤销后 JSON 深相等（含名称、cue、绑定、`bg:{type:'mesh'}`、`hand:{on,jitter,frame}`） |
| 连续应用 | 应用 A→B 后撤销回到 A（只撤销最近一次），按钮随之隐藏 |
| 冲突 | `星云 隧道` 显示「隧道」与「星云」冲突警告并保留后者 |
| 未识别 | `赛博朋克蓝色海底` 显示「未识别」，不应用、按钮禁用 |
| 空白/纯标点 | 显示「没有可识别的文本」，按钮禁用 |
| 刷新保留 | 重新加载页面后 `scene=nebula`、`look.grade=3` 保留 |
| 键盘 | textarea Tab 进入下一个控件；Escape 关闭面板 |
| 关闭面板不自动撤销 | Escape 后舞台保持已应用状态，重开后撤销快照仍可用且可恢复 |
| 横向滚动 | 三个视口 `scrollWidth ≤ clientWidth`，textarea 无溢出 |
| 控制台 | 交互全程 `window.__errs` 为空 |

截图（本目录 `screenshots/`）：

- `desktop-1-parsed.png` —— 1440×900 桌面解析结果（识别摘要 + 示例短语 chips + 字符计数）
- `desktop-2-applied.png` —— 1440×900 应用后（撤销按钮出现）
- `mobile-320-long-warning.png` —— 320×568 长输入 + 按钮纵向排列
- `mobile-320-warning-detail.png` —— 320×568 冲突警告与未识别片段特写

人工确认：文本无重叠、按钮无截断（320px 下动作按钮整行可点）；舞台变化以 `preset`
数据核对（孤立实例无音源、画面帧门停走，视觉以数据为准）。

## 验收中发现并修复的缺陷

1. **撤销快照时序（apply）**：`applyIntent` 内部同步广播 `preset` 事件并触发面板重排，
   原实现重排之后才赋值 `promptState.undo`，撤销按钮不出现。修复：快照先挂上再应用，
   失败回滚。
2. **撤销快照时序（undo）**：对称问题——`setPreset` 同步重排时快照尚未清空，撤销后按钮
   残留。修复：先清快照再恢复，恢复异常时回滚。
3. **解析摘要不随重排回放**：应用/撤销触发的重排会把"识别结果"清空。修复：
   `renderResult()` 改为从 `promptState.result` 回放，`renderPrompt` 构建时调用。

以上修复均已随本轮提交；`check-creative.js` / `check-assets.js` 复跑通过。

## 边界说明

- 浏览器为 Electron 内嵌 Chromium（146），非独立 Edge/Firefox；320px 为布局下限验收，
  未覆盖更老内核（如缺 `String.prototype.normalize` 的回退路径由契约脚本以 NFKC 缺失
  分支覆盖）。
- 提示词原文不持久化、不进日志：服务端访问日志仅含 `/creative-prompt.js` 静态资源请求。
