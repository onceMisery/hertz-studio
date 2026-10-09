# 检查点

- 完成：读取用户引用聊天、明确本轮舞台扩展范围、核对既有登记/预置/资源架构。
- 完成：四套绘景、图库、资源接线；89 项登记/参数/保存/分享/恢复检查；真实 WebGL 三档画质与参数像素检查。
- 当前：整页验收已跑绿——9 组 journey 全过，`report.json` 无 failure、无页面错误，宽窄屏 1440/760/420/320 面板全在视口内。上一轮 `workshop fits 760` 的红在当前构建复现不出（探针见 `output/anime-760-probe.js`），判定已被同批窄屏修复带走。
- 下一步：接 `docs/dbx-store-submission.md` 上架——提交这批改动、切 `hertz-plugin-v0.1.0`、publish Release 出 5 个 target 候选，再向 `t8y2/dbx-store` 开提交 PR。
- 基线：工作目录已有其它聊天的未提交改动；仅增量修改必要共享文件。
- DriftCheckDraft: continue；无第二时钟、无新存储、无外部素材服务。
- Evidence: 90-evidence.md（新鲜命令与结果表、那条红的反证过程、CI 接线变化）；scripts/check-anime-scenes.js；scripts/check-anime-ui.js；scripts/check-anime-scenes-browser.js；output/playwright/anime-scenes/report.json。
