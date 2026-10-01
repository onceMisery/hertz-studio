# 皮肤、3D 与播放完整性检查

- Requested outcome：修复四套皮肤的滚动与设置入口，提供持久化封面联动开关，统一交互反馈，优化已有 3D 的性能和输入行为，验证播放全链路。
- Constraints：不用 TDD 或 superpowers；直接定位、实现后回归。参考 Mineradio，不增加生产依赖，不提交或创建分支。
- BaselineReadSetHint：README.md；docs/aegis/plans/2026-09-26-listening-experience.md；app.js、style.css、stage.js、skins/*、stage3d.js；Rust actor / cpal / 播放路由；现有 Node 检查脚本。
- ImpactStatementDraft：Stage 保有表现层时钟、曲目和封面取色；app.js 保有设置、REST/WS 和前端播放控制；Rust actor 保有实际音频。布局皮肤与主题色保持正交。
- Compatibility：保留现有 app.js、online.js/css、聚合搜索文档及检查脚本中的未提交修改；测试使用独立端口和数据目录，不操作用户曲库。
- ArchitectureReviewRequired：yes。
- Verification：四套皮肤的桌面/窄屏滚动和设置可达性；封面开关即时生效、刷新恢复和异步竞态；拖动/键盘进度与音量；播放/暂停/停止/前后曲/队列；MediaSession 动作；后台播放与 3D 隐藏/减弱动效；Node 检查、Rust 测试和真实浏览器。
- Limits：当前硬件和自动化不能证明所有设备帧率或所有系统锁屏 UI；区分接口覆盖、实际音频设备和操作系统集成证据。

## 执行顺序

1. 复现公共布局与皮肤覆盖问题，定位实际滚动所有者。
2. 修复滚动/设置入口；封面联动在 Stage 内单点控制，保存到已有设置服务。
3. 修复前端播放控制和异步状态同步，统一各操作入口。
4. 并行审查 3D 的输入/性能，以及 Rust 播放状态与解码。
5. 综合回归、实机浏览器截图、整理证据与剩余平台边界。
