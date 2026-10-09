# 动画绘景舞台：意图与基线

TaskIntentDraft: 将用户明确指定的动画、赛璐璐、暖白光、蓝紫阴影和克制游戏 UI 应用于四套不同构图的舞台。交付真实可用的场景、工坊选择入口、资源内嵌和视觉验收。

BaselineReadSetHint: README.md、docs/extension-guide.md、ADR-0009；CreativeGL.register、CreativeStage.setScene/setStyle/resetSettings、Workshop.renderScene、Stage 唯一帧门；引用聊天已存在的恢复默认和全局 celestial 主题改造。

ImpactStatementDraft: 新增四个内置创意场景及可选展示元数据；作用于绘制、工坊导航与 JS/CSS 打包。预置、cue、音频绑定和歌词继续由原模块管理，不修改播放业务、设置协议和分享格式。

授权依据：用户本轮提供了明确的视觉设计要求并要求扩展数套舞台。沿已存在场景接口实施这些要求，常规构图和实现选择由本任务完成，无新增发布或外部写入。

停止条件：四套实际场景可切换、可保存与恢复，真实浏览器和相关契约检查通过；若有真实环境限制则保留实现并明确证据范围。

ArchitectureReviewRequired: yes

Workspace helper: 在已安装 Aegis 技能目录中未找到工作区 helper，沿现有 docs/aegis 结构维护记录。
