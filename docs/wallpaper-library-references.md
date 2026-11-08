# 壁纸作品删除与引用详情

2026-11-06 增量。设置页作品和版本均提供“查看引用”，删除被阻止时直接展示当前引用来源。只读查询不释放预览、修改配置、编辑列表或删除内容；引用为空也不自动执行删除。

## 数据与界面

只读命令 `wallpaper.library.references` 接受 `{workKey, packageHash?}`。不带包摘要查询整个作品，带摘要查询该作品的固定版本。作品及包归属先校验，查询结果为：

```json
{
  "references": [
    {
      "kind": "workDraft",
      "id": "draft-id",
      "label": "海岸作品",
      "detail": "作品草稿保留此作品或版本"
    }
  ],
  "limit": 32,
  "truncated": false
}
```

删除继续返回兼容错误码 `asset_in_use`，同样的报告位于 `error.details`。不改变原请求的幂等身份；刷新使用新只读请求，旧查询不是后续删除许可。

报告最多 32 个引用来源，序列化最多 24 KiB，留出 64 KiB 响应信封余量。字段按 Unicode 边界裁切，原始 kind/id 的摘要用于去重，长标识被裁切后仍保持不同身份。`truncated` 同时表示条目省略或文字缩短；界面明确提示可在解除引用后刷新。

| kind | 来源 |
| --- | --- |
| savedConfiguration | 当前、非活动及未绑定来源的已保存显示组，包含已停用设置 |
| settingsDraft | 尚未应用的原生设置草稿 |
| desktop | 当前/候选呈现或镜像组播放 |
| preparing | 准备中的内容、选择解析和暂停保留的故障封面 |
| retiring | 退出中的 controller、文件读者或静态交接帧 |
| preview | 独立预览 |
| applying | 尚未完成的设置应用事务 |
| playlist | 持久轮播列表，重复条目合并为列表来源 |
| workDraft | 作品草稿的 work/base/published 引用 |
| publication | 正在生成或等待提交的作品版本 |

界面使用文本节点呈现名称和详情，不解释作品提供的 HTML。支持加载、空结果、查询错误、旧宿主缺少详情和有界截断状态。切换引用目标、刷新列表、切来源或关闭页面后丢弃旧回执。成功删除后始终刷新列表；若旧列表查询仍在途，完成后补读，避免已删除作品被旧快照保留在界面上。

## 删除协调

原生主线程采集运行与配置引用，后台在内容写入锁内读取持久引用并合并报告，确认无引用后才删除包目录和数据库行。三类持久来源通过同一个读事务、每类最多 33 行查询取得有界快照。保护谓词保持既有行为：整个作品按 work 匹配；版本的轮播引用按包摘要匹配，兼容不同作品共享同一包；草稿和发布记录同时匹配 work 与可选包摘要。

删除任务在途时保持设置变更保护。只有该删除 worker 的实际完成事件，或该次删除根本未被受理的提交失败，才能解除保护。重复 requestId 的拒绝响应，以及同 requestId 的其它命令提交失败，都不能提前清除原删除任务的保护。

列表和引用查询均是观察快照。调用者仍必须显式执行删除，删除路径重新核验持久引用；未退出的读取与原生资源继续使用原有文件 pin 和退出 owner。

## 验证入口

- [references.rs](../crates/hertz-desktop/src/wallpaper/references.rs)：数量、字节、Unicode、去重、共享包、重复列表位置、草稿及待发布引用测试。
- 服务与配置测试验证运行/持久报告合并、拒绝时原包字节不变、版本归属错误、非活动来源与未绑定设置，以及解除引用后删除。
- [浏览器脚本](../scripts/check-wallpaper-library-references-browser.js)使用真实 library.js/HTML 与受控桥，覆盖九组引用展示、错误、过期响应和删除后列表补读场景；1180/390/320 宽度截图已视觉核对。
- [原生旅程](../scripts/check-wallpaper-works-native.js)调用 [wallpaper-reference-checks.js](../scripts/wallpaper-reference-checks.js)，在隔离目录用真实 SQLite 写锁阻塞删除提交，验证重复请求、四个请求槽占满时的同 id 查询失败，以及后台完成后保护释放和真实内容删除。

执行结果：桌面 Rust 全库 497 项通过、2 项按原硬件条件忽略；引用专项 15 项通过；all-targets Clippy `-D warnings`、debug `wallpaper-media-probe` 构建、相关 JS 语法和 268 项脚本登记通过。设置页既有 31 项回归也通过，独立规格与质量审查均已闭环。

[原生报告](../output/playwright/wallpaper-works-native-1793937082455/report.json)包含 15 项场景、零页面错误，测试宿主与数据库锁辅助进程已退出。[删除并发证据](../output/playwright/wallpaper-works-native-1793937082455/deletion-admission.json)记录 `asset_in_use` 的结构化报告、满载时 `budget_busy`、重复删除仍为 `conflict`，以及原请求最终成功删除一个无引用版本/包。二进制 SHA-256：`3fe8c3498cda374eecabc426e8042af8e47d7b0d4fe2a0c83a9fae5fdfea5e5e`。

[引用界面报告](../output/playwright/wallpaper-library-references/report.json)九组通过。浏览器受控桥不作为原生删除并发证据；锁竞争旅程使用隔离数据目录和真实 SQLite 写锁，未改生产超时或伪造删除完成事件。
