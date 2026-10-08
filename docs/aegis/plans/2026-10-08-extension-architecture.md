# 扩展架构实施计划

- Goal：减少新增皮肤、舞台及音源需要修改的核心接线点。
- Architecture：内置注册表、静态定义单一归属、统一生命周期，保持原呈现与播放入口。
- Tech Stack：Rust / axum / 原生 JS；不增加前端构建步骤。
- Baseline/Authority Refs：本次已授权评估、设计文档、README、ADR 0001/0006/0007/0008、BASELINE-GOVERNANCE。
- Compatibility Boundary：公开 API、保存键、场景 ID、分享 v1、单 exe、DBX、帧门与播放意图不变。
- Verification：每项实现后新增行为回归；`node scripts/check-frontend.js`；`cargo test --workspace`；`cargo clippy --workspace --all-targets -- -D warnings`；关键浏览器冒烟。

## 1. Provider 注册

文件：`crates/hertz-studio/src/online/`、相关现有检查。实现静态 Provider 描述与分组操作，迁移八个平台的分发，凭据与音质定义跟随平台登记。公共校验、错误与 timeout 保留。删除复制 source 名单的接线测试，改验证真实注册项；增加虚拟 Provider 和能力错配回归。运行 `cargo test -p hertz-studio --lib online::` 与 `node scripts/check-online.js`。

## 2. 资源登记

文件：`crates/hertz-studio/src/main.rs`、新资源模块、`scripts/check-assets.js` 及读取旧资源声明的检查。用一张清单生成 JS/CSS 内嵌数据、路径、MIME、指纹输入；保留 HTML 鉴权及图片行为。删除旧逐条 route 与独立指纹列表。测试真实资源响应、内容指纹与新增条目覆盖。运行资产检查与二进制单元测试。

## 3. 场景扩展

文件：`plugin/ui/creative-gl.js`、`creative-stage.js`、`creative-prompt.js`、`stage3d.js`、相关 stanza/设置模块及检查。以场景定义合并私有参数、默认值、机位与能力，迁移所有现有创意场景，收敛沉浸场景构造与歌词渲染器分发。新增未内置的场景通过注册后自动出现在列表、参数面板并完成预置往返；保留实际渲染和帧门。运行 creative、share、stage、stanza 检查及浏览器切换。

## 4. 皮肤生命周期

文件：`plugin/ui/skins/skins.js`、复杂皮肤 JS、`plugin/ui/app.js` 与相关检查。给 registry 增加生命周期登记，换肤按卸载→属性/CSS→挂载→广播执行；提供通用动作/快照桥接，迁移流年和清风。验证重复 apply、正反切换、失效资源、清理与原业务动作。运行 skins、appearance、player 检查及真实浏览器切换。

## 5. 集成与交付

审阅各项需求符合性，再检查代码质量与资源/生命周期残留；完成独立审查、全量检查、扩展指南和 ADR，更新证据与检查点。保留工作树和可审阅分支，不自动合并或发布。

## 风险与退役

旧源码形状检查会随声明位置变化而失效，须改为验证新真实归属，不能通过伪造旧字符串维持绿色。异步皮肤事件、WebGL 资源、字段默认值与能力表最容易发生行为偏移。每一项必须移除被替代的重复事实表，兼容只保留既有公开调用面。
