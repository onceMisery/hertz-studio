# 壁纸作品公开属性

2026-11-06 增量。当前内置场景作品和导入的 Builtin/Image/Video 包支持公开属性定义、默认值和按显示组覆盖。原包不可变，覆盖只写入 `WallpaperGroup.properties`；应用、预览、重启和轮播切换使用同一共享校验与求值器。Composition/Web 执行和组合编辑器仍属后续范围。

## 合同

每项最多 2 KiB，每包最多 64 项。固定字段为 `id`、`label`、`type`、`default`、`constraints`、`target`；未知字段、重复 id 或重复目标、无效默认值及扩大真实参数范围均拒绝。id 使用包局部标识规则，label 为 1–120 字符且无控制字符。

| type | constraints | 值与目标 |
| --- | --- | --- |
| number | `min`、`max`，可选正数 `step` | 有限数值，范围不超过真实 registry；step 是控件提示，不强制离散网格 |
| boolean | `{}` | 布尔值 |
| select | `options: [{value,label}]` | 有界且不重复的字符串/布尔/数值选项，类型和值必须匹配；可收窄 registry 选项 |
| color | `{}` | `#RRGGBB` |
| text | `maxLength`，0–4096 | 按 UTF-16 长度验证，不能超过真实参数约束 |
| asset | `kind`、`options: [assetId]` | 只选同包已声明且类型兼容的资源，不接受路径或 URL |

target 继续遵守设计 §9.3 的 node/binding 联合。当前单内容包保留一个根节点 `content`：`{"kind":"node","nodeId":"content","property":"tod","component":null}` 指向内置场景真实参数；图片/视频使用同一目标的 `property:"asset"`。这些内容拒绝其它节点、非空分量和 binding。未来组合文档可使用真正的节点/绑定目标，当前不提供其执行资格。

公开 id 与 registry key 分开，例如 `disc-ring` 指向 `discRing`。未提供覆盖时使用公开定义的 default；已提供值必须通过公开约束和真实目标约束，不能静默钳位。求值在清单副本上完成，包摘要和原文件保持不变。

## 编辑和使用

“我的场景作品”可勾选公开真实参数并填写名称。默认值随该参数编辑更新；取消公开恢复普通参数编辑。重开包含收窄约束的本机作品时，控件遵循原约束。当前有桌面资格的内置场景主要提供 number/boolean/select，不凭六种类型合同捏造额外场景参数。

作品草稿仍使用独立 CAS 和一秒自动保存。`setProperty`/`removeProperty` 增量与参数增量按最多 32 操作、约 12 KiB 分批；发布从已保存草稿生成新版本。旧草稿省略 properties 等价空集合。作者归属与第三方/带资源包的重开限制继续生效。

设置页读取当前包的属性；轮播只显示全部固定版本均声明且定义完全相同的属性。输入覆盖仅作用于当前显示组，“恢复默认”删除对应覆盖。修改选择会清理该组旧覆盖，切换显示组不会修改其它组。未知已保存覆盖显示错误与恢复入口，不静默丢弃。独立预览读取相同草稿，Apply 才保存桌面配置。

查询接口：`wallpaper.draft.properties` 按草稿修订分页；`wallpaper.properties.inspect` 接受固定包或列表 selection、limit 和 cursor，返回 properties、snapshot、nextCursor。单页约 12 KiB；列表修订/完整引用与属性定义纳入快照，旧分页游标拒绝。页面串行读取并隔离切组、换版本、切来源和迟到回执。

## 提交和运行边界

Apply 在落盘前核验所有新建或改变的属性意图，包括未连接的目标及 disabled 组；轮播核验全部项目，不只检查第一项。实际内容读取已安装原包和清单，不把设置页的 metadata 检查当作执行授权。

列表编辑也会核验活动、非活动来源及未绑定配置中引用该列表的覆盖值。不兼容的列表替换在写入前拒绝；既有 Apply/playlist 写入取消和互斥保护继续生效。只改窗口运行规则仍保留当前播放和失败项。

图片/视频公开 asset 覆盖选择的资源继续通过实际准备、解码资格和预算。视频失败后的缓存封面按有效 asset 身份读取；包缺失、损坏或整列表预检失败也保留选中引用的封面路径，不能借用基础资源的封面。无效覆盖不会把健康已安装版本标记为损坏。

## 验证范围

- 共享模型测试覆盖六类型、约束、字节/数量边界、registry 收窄、asset 类型、不可变默认/覆盖求值。
- 桌面测试覆盖属性分页快照、完整列表拒绝、取消、inactive/unbound 配置保护、运行期默认/覆盖及原包字节不变；实际 red/blue PNG 像素和不同 WebM 内容身份验证资源选择及选中封面。
- [作者浏览器报告](../output/playwright/wallpaper-work-properties/report.json)：7 项通过，含 64 项分批、CAS、读取锁、标识冲突和收窄约束。
- [设置页浏览器报告](../output/playwright/wallpaper-display-settings/report.json)：31 项通过、无页面错误，含六类型控件、组隔离、分页迟到响应、错误恢复及 1180/390/320 宽度。
- 桌面 Rust 全库 489 项通过、2 项按原硬件条件忽略；共享 crate 单元测试 38 项、包集成测试 10 项全部通过。`hertz-desktop` 与 `hertz-wallpaper` 的 all-targets Clippy `-D warnings`、最终 debug 构建、相关 JS 语法、267 项脚本登记及 scoped diff 检查通过。一次既有 feed 套接字用例发生 `WouldBlock`，专项复跑及较低并发全量复跑通过。
- [原生旅程报告](../output/playwright/wallpaper-works-native-1793935613471/report.json)：13 项通过、零页面错误，测试宿主已退出。覆盖真实作者编辑/发布/重开、覆盖值独立预览与 Apply、宿主重启/恢复默认、不可变包摘要、轮播暂停/失败/重试、整列表不兼容编辑及新禁用离线配置的提交前拒绝。
- 原生报告二进制 SHA-256：`58d898e83c638f0e56027ac79f0fdcdba3576817adfbcd7a40af83ccba097f2a`。

浏览器管理桥 fixture 不代替原生执行证据；六类型模型覆盖不代表当前内置目录已有六种参数目标。此原生旅程使用单块物理显示器，双屏同时运行资格仍按显示组实施记录另行验收。
