# 窄屏顶栏与清风检查修复

Goal: 执行引用聊天中已获用户批准的双行顶栏方案，消除 320/330/390/700px 的页面横向溢出，并让清风检查独立准备播放数据。

Architecture: 布局仍归 CSS；皮肤注册表、业务节点、播放意图及 API 归属不变。测试创建独立 Null 后端实例和临时数据，关闭后清理。

Tech Stack: 原生 CSS/JS、Rust 内嵌资源、Node.js 与 Playwright/Chrome。

Baseline/Authority Refs: 用户批准的引用聊天方案；README.md；docs/extension-guide.md；docs/aegis/BASELINE-GOVERNANCE.md；docs/aegis/adr/0009-extension-registries.md；output/recheck-2026-10-09.md。

Compatibility Boundary: 保留顶栏所有按钮尺寸、动作、搜索快捷键；浮光与清风继续使用各自搜索入口；覆盖新增潮汐。保留当前未提交工作，不重启或操纵既有服务。

Verification: `node scripts/check-narrow-topbar-browser.js`、`node scripts/check-qf-issues.js`、`node scripts/check-skins.js`、`node scripts/check-appearance-restore.js`、`node scripts/check-frontend.js --extra`。浏览器使用重新构建的 `target/debug/hertz-studio.exe`，可用 HERTZ_BIN 指定；Playwright 通过 NODE_PATH 提供。

## 1. 固化重现

- 新建 `scripts/ui-browser-fixture.js`：启动随机端口、临时目录、内存凭据、Null 后端；以会话 Cookie 认证；生成带 INFO 标题及歌手的真实 WAV，扫描后验证并加载；finally 关闭进程及清理临时目录。
- 新建 `scripts/check-narrow-topbar-browser.js`：从 Skins.list() 获取皮肤，在 320/330/390/620/621/700px 测页面 scrollWidth/scrollX、按钮边界与点击命中、内容与顶栏相对位置，并实际打开搜索、菜单和皮肤选择浮层；保留截图与 JSON。
- 先运行新布局检查和旧清风检查，记录预期失败，再修改 CSS 和清风数据准备。

## 2. 修复布局

- `plugin/ui/style.css` 的手机断点：共用顶栏允许换行，搜索占第二行，连接点去除额外 padding/gap；用 `--topbar-h` 同步既有定位消费者。
- 核对 `skin.liunian.css` 的高度令牌/内边距及 `skin.chaoxi.css` 的导航定位；浮光和清风的专属布局继续由各自 CSS 管理。iOS 现有双行行为作为参照。
- PatchShape: CSS 断点修正。CanonicalOwner: 共用顶栏与各皮肤 CSS。UpwardDrillSignal: 固定按钮宽度合计超过可用行宽。Decision: 修复布局 owner，不以页面 overflow hidden 掩盖问题。
- Repair: 单行挤压改双行；Retirement: 移除旧搜索最小基准及状态点的空白占位，保留专属皮肤规则，不增加第二套控件。

## 3. 确定性清风检查

- `scripts/check-qf-issues.js` 默认自行启动测试服务，先断言空播放器正常、无错误；随后自动扫描和加载 fixture，断言精确标题和歌手、实际宽度，保留其余现有检查。
- 移除依赖外部 TK、已有歌曲和固定 8 秒等待；改为等待服务及 DOM 状态；无论断言或异常均清理浏览器及测试进程。

## 4. 交付验证

- 运行 `cargo build --locked -p hertz-studio` 后执行两组真实浏览器检查与上述前端回归；检查窄屏截图及 1440px 桌面回归。
- 运行 `git diff --check`，更新 work 记录及证据。ArchitectureReviewRequired: yes（共用 CSS 下游检查）；ADR 信号无新增，属于恢复既有布局与检查契约。
- 风险边界：验证当前七套皮肤和指定视口，不把外部账号/平台可用性计作本轮结论。不发布、不提交混合改动。
