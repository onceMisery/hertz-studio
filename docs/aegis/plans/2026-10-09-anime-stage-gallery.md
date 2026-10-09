# 动画绘景舞台扩展

Goal: 依据用户给出的动画美术规范，新增晴空云海、黄昏海岸、月下列车、森间灯火四套可选择的舞台，并保留收藏、分享和恢复默认。

Architecture: 通过 CreativeGL.register 登记二维绘景；CreativeStage 继续独占预置和帧时钟，Workshop 只读场景描述并调用现有编辑入口。每套构图使用平面着色器，平涂轮廓与分层远景产生景深，不引入三维模型或第二条动画循环。

Tech Stack: 原生 JavaScript/CSS、WebGL2、内联 SVG 导航缩略图、Rust 内嵌资源。

Baseline/Authority Refs: 用户本轮明确美术要求；所引用聊天已实现的恢复默认与电影风格；README.md；docs/extension-guide.md；docs/aegis/adr/0009-extension-registries.md；creative-gl.js、creative-stage.js、workshop.js 的现有登记和生命周期。

Compatibility Boundary: 已发布场景 ID、分享 v1、保存键、歌词所有权、播放和队列协议不变。注册描述增加可选 presentation 展示字段，旧场景继续使用原缩略图。新场景通过现有 setScene/setStyle 应用；再次点击当前绘景不覆盖已编辑参数。切换到新的绘景回到原始光影以呈现其原色。减少动效、暂停与隐藏帧门由原宿主管理。

Verification: node scripts/check-anime-scenes.js；node scripts/check-scene-registry.js；node scripts/check-creative.js；node scripts/check-creative-share-code.js；node scripts/check-creative-prompt.js；node scripts/check-assets.js；node scripts/check-anime-scenes-browser.js；cargo build --locked -p hertz-studio --bin hertz-studio；cargo test --locked -p hertz-studio --bin hertz-studio。

ArchitectureReviewRequired: yes

## 实施切片

1. 登记与往返契约：先添加真实 CreativeStage/分享码往返检查，确认未登记场景的预期失败；随后在 plugin/ui/creative-anime.js 中实现四套无外部素材依赖的绘景。共用平面抗锯齿与纸感工具，场景各自持有参数、机位、别名和展示元数据。
2. 工坊与画布：plugin/ui/workshop.js 添加动画绘景分区和键盘可达的场景卡片；plugin/ui/creative-gl.js 输出可选展示元数据；plugin/ui/creative-stage.js 将当前场景族标记到渲染容器；plugin/ui/creative-anime.css 负责该分区及绘景舞台的局部材质。图库间隔 24px、12–16px 圆角、暖金/青色细描边、240ms ease-in-out，沿用现有点击粒子反馈。
3. 资源接线：在 plugin/ui/index.html 的 CreativeGL 与 CreativeStage 之间加载新场景脚本，在 crates/hertz-studio/src/assets.rs 登记新 JS/CSS，维持独立程序与 DBX 的同源资源。
4. 验收：真实浏览器检查四套 shader、画质、宽窄屏、调参、暂停、减少动效、保存/导出/恢复，以及完整舞台中的歌词与控制可读性。截图落入 output/playwright/anime-scenes/，记录证据后交付。

## 风险与取舍

- 工作目录含引用聊天的未提交修改，保留其内容，仅在必要位置作增量接线；不提交或回滚其它工作。
- 选用现有 WebGL 场景接口，避免静态壁纸的无音乐响应和额外绘制循环的生命周期成本。
- 高光限制在暖白，阴影偏蓝紫；远景降低对比并作局部柔化，前景轮廓保持清楚。四套风景不使用人脸、霓虹堆叠或像素风。
- 不新增运行时所有者或替代路径，不需要退役既有场景。最终检查依据 ADR-0009 评估归属及资源生命周期。
