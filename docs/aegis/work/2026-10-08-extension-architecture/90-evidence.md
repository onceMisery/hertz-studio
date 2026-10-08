# 扩展架构验证记录

工作树：`C:/Users/miracle/.codex/worktrees/extension-architecture/hertz-studio`；分支 `codex/extension-architecture`；基线 `ae26155`。用户授权实施、不使用 TDD；先完成各实现，再补行为回归。原目录仍停在基线且无修改。

## 已验证切片

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| `node scripts/check-frontend.js --extra` | 48/48 | 默认 CI 集合及附加前端回归；包含新增真实场景注册检查 |
| `cargo test --locked --workspace` | 510 passed，1 ignored | Rust 全工作区；含真实 Provider 登记、参数/错误转发、就绪状态与资源 HTTP |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | 通过 | 主程序、共享 crates、DBX backend |
| `node scripts/check-assets.js` | 668/668 | 真实资源登记、HTML 加载顺序、路径/MIME、目录消费 |
| `node scripts/check-skins.js` | 715/715 | 注册边界、换肤顺序、恢复失败清理归属与实际宿主动作 |
| `node scripts/check-appearance-restore.js` | 45/45 | 保存的皮肤/外观恢复 |
| `node scripts/check-online.js` | 414/414 | 既有音源公共契约 |
| `node scripts/check-adrs.js` | 203/203 | 九篇 ADR 的边界数值与源码一致 |
| `SCENE_BASELINE=ae26155 node scripts/check-scene-registry.js` | 205/205 | 注册、参数/机位边界、JSON/share v1、提示词、renderer 生命周期，以及六场景旧/新对照 |
| `cargo fmt --package hertz-studio -- --check` | 通过 | 本次 Rust 包格式，未格式化 vendored SDK |

Cargo 使用独立 `CARGO_TARGET_DIR=D:/code/github/hertz-studio/target-extension-architecture`；测试使用 `VMUSIC_SECRETS=memory`。初次 online 测试暴露已有凭据测试对全局 backend 初始化顺序的依赖，已改为同一注入 backend 完成迁移与读回；生产读取复用同一函数。Clippy 发现两处回调类型过于复杂，已抽取类型别名后通过。Rustfmt 仅格式化 hertz-studio 包。

资源 HTTP 用真实 axum listener / reqwest 请求每条登记路径，比对 body、MIME、缓存头并检查未知路径 404；另一测试逐条修改输入确认全部资源参与指纹。独立审查逐项对比基线 78 条 JS/CSS 路径、MIME 与 include 源文件，完全一致。

## 浏览器与审查

真实 Chrome 连接隔离 null 音频 / memory 凭据服务，端口 18783，数据与日志位于工作树 `output/extension-service`。没有接触用户数据库或正在使用的服务。

- `scripts/check-qingfeng-wall.js`：非空队列密排、展开、操作、键盘与清理全部通过；探针包装真实 `Skins.request`。
- `scripts/check-skin-fixes.js`：重建服务上的六皮肤切换/布局/动作及部分挂载失败的真实 DOM 回归 55/55，全程无 JS 错误。
- 皮肤独立规格审查发现并修复两处旧 `qf:panel` 探针。质量审查复现并修复清风部分挂载未清理，以及旧皮肤恢复挂载失败后 owner 丢失。重新审查均通过。
- 独立 jsdom 执行真实 HTML 和皮肤源码，正反多轮切换后 stage/bar/settings/account 节点身份、父节点及相邻顺序恢复；注入 MutationObserver 分配错误后设置页回到 column，残留锚点/浮层为零。
- Provider 两阶段独立审查通过，核对八个平台元数据、能力门、函数参数顺序、质量/凭据规则及错误语义。
- 场景两阶段独立审查通过。发现并修复机位越界在 reset/import 中不一致、初始化失败未回收先前 renderer、提示词别名碰到 constructor/__proto__ 的原型属性。注册边界与消费者现在共用同一机位规则；重试/重复销毁及特殊别名均经实际入口验证。
- `scripts/check-creative-scenes-browser.js`：六场景真实 GPU、桌面/移动截图、几何与画质检查通过；新增注册场景显示像素 15606、隐藏后 0，额外绘制钩子 1 次，GL 错误 0。根代理查看了六场景组合截图及指标文件。
- `scripts/check-stage-handoff-browser.js`：桌面/移动 renderer 交接通过；`scripts/check-creative-share-code-browser.js` 完整文档分享流程通过。
- `scripts/check-workshop-stage-browser.js`：最终重建服务实际内嵌资源核对通过，真实场景绘制/选择、暂停参数像素、歌词归属/显隐、cue 插值/倒退、手绘/背景、播放/系统减少动态效果、单帧门、封套合成、启动失败恢复、重开及移动布局八组全部通过，无 pageerror。

首次 `--extra` 发现 cinema 仍读取已删除的 SCENE_CAM 字符串；现改为执行真实 CreativeGL 描述，创意 tunnel 原值 4.2 保持。没有修改视觉值迎合断言。

## 最终集成

整体独立审查通过，无未解决 P1/P2。审查发现注册参数范围与分享固定边界不一致，已统一使用 CreativeGL.parameterLimit()，保留原 ±1,000,000 边界；完整 min/max/default 与真实分享编码/解码往返通过。ADR-0006 和 HTML 的旧归属说明同时同步。

所有切片、旧/新预置对照、完整聚合、严格 Rust 检查、最终重建及内嵌服务浏览器流程均已通过。最终参数边界修复后完整前端48步与内嵌服务工作坊八组再次通过。产物与日志留在工作树的 ignored output 目录，隔离测试服务已停止。

## 边界

自动化覆盖离线契约、空音频后端与 Chrome UI；未重新联调真实第三方音乐账号、真实音频设备或 DBX 宿主 UI。平台已有未验收能力标记继续保留。

Aegis workspace helper 已执行：`check` 报告基线已有缺少 baseline 目录及两份未索引历史文件；`bundle` 不接受本工作记录的 Markdown-only 形式（缺少 task-intent-draft.json）。未为本轮代码重构修改旧治理记录；这些结构问题不作为代码测试结果。
