# 壁纸作品、导出与轮播实施记录

2026-11-05，实施盘点 A03，对应[壁纸设计](desktop-wallpaper.md) §14.2、§15 与 P1-05/08。本次在当前工作树接通内置场景作品的保存、重开、发布、原包导出和单屏固定版本轮播。2026-11-06 的 A02 增量又接入显示组与镜像共享轮播，见[显示组与镜像实施记录](wallpaper-displays-mirror.md)；组合编辑器与第三方作品改编仍按各自工作包推进。

## 使用入口

打开“桌面歌词与壁纸”的“壁纸”页：

1. 先选择固定场景，在“我的场景作品”点击“保存当前场景为作品”。标题、说明和场景参数可继续编辑；参数控件取自真实场景 schema。修改后 1 秒自动保存，也可点击“保存作品”。关闭设置页会等最后一次保存完成，失败时保留窗口与编辑内容。
2. “预览作品”使用共享的原生预览窗口以及已经应用的显示、音频设置；修改作品后可再次预览。保存和预览都不改变桌面选择。
3. 点击“生成版本”，从已保存的草稿生成一个不可变 builtin `.hwpkg`。本地作品中可“选择此版本”，然后“应用设置”；自己在本机生成的版本也可“编辑此版本”，继续生成新版本。
4. 在版本列表点击“导出此版本”，使用系统保存对话框选择一个新的本地文件名。导出复制原包，完成后显示“已导出壁纸包”。目标文件已存在时需另选名称。若显示结果待核验，关闭占用目标文件的程序，再点击“重新核验导出”。
5. 在版本列表点击“加入轮播”，在“轮播列表”中调整顺序、选择顺序或随机模式，设置 10–86400 秒间隔。点击“保存列表”“选择此列表”，再“应用设置”。可手动“下一项”；切换失败时保留旧画面并显示“重试失败项”。

草稿列表可重新打开已保存的作品；发生真实修订冲突时保留本地输入，并提供明确的“重新读取”。删除草稿不会删除已生成的版本。列表引用的是确定的版本，作品新增版本不会自动替换列表条目。

## 存储与运行约束

| 范围 | 当前实现 |
| --- | --- |
| work 草稿 | SQLite 中保存文档与独立 `draftRevision`，每个文档最多 1 MiB，每次最多 32 个类型化更新，最多 50 个草稿；列表和参数分别分页读取 |
| settings 草稿 | 继续使用原有内存草稿、设置会话与 `configRevision`；只有应用 settings 才提交桌面配置 |
| 作品发布 | 只发布已保存的当前修订；同一修订重复发布返回同一版本和 hash。builtin 可只有 `manifest.json`，不放入虚构的媒体文件；其他包类型保持原资源要求 |
| 作者归属 | `authored_versions` 按版本记录原生发布事实；导入包即使声称本地来源也不能取得编辑权限。第三方许可证改编/fork 尚未开放 |
| 输出能力 | 原生输出 token 绑定当前 owner 与包 hash，60 秒有效、单次消费，最多 4 个；页面不能提交路径，选择位置本身不创建文件 |
| 导出任务 | 单个有界 worker，和安装/删除共用内容写门；分块复制已安装的 `original.hwpkg`，核对 SHA-256，刷新并无覆盖提交。不会重新打包或解码媒体 |
| 轮播列表 | 每项固定 `workKey + packageHash`，独立列表 revision/CAS；首版每列表 1–32 项，最多 100 个列表。完整保存请求仍受 16 KiB 管理信封约束 |
| 轮播时钟 | 从实际呈现后的可绘制时间累计；暂停冻结、恢复不补切，每次只准备一个候选，随机选择不重排保存的列表 |
| 呈现与失败 | builtin、图片、视频沿同一准备/首帧/交接/退出链路；当前或候选失败会停止轮播，显式重试仍指向失败的固定版本，不自动跳过坏项 |
| 配置与引用 | 定时切换不写 Config 或递增 configRevision；保存的列表、草稿及当前/准备/候选/退出中的实际版本都参与删除保护 |

首版 32 项限制小于设计总上限 1000 项：本次使用一次有界完整保存，尚未实现大型列表的增量编辑协议。A03 原始原生证据使用单屏 single；A02 已增加显示组和图片/视频 mirror，但双屏同时呈现仍需真实硬件验证。

## 崩溃与回执恢复

作品发布先保存 `draft_publications` 意图，再写不可变包目录，最后提交版本、作者归属和回执。若进程在目录发布后、数据库提交前终止，启动核验后再次发布会完成同一版本及 hash。恢复期间该草稿禁止更改、保存或删除，避免把另一份文档冒充已经发布的内容；不同草稿发布同一作品也按作品身份串行。

导出将请求身份、目标文件身份和发布检查点写入数据库。重复请求返回同一任务；重启后可按原 `requestId` 与 `command=wallpaper.export.begin` 查询。恢复只清理可确认属于原任务的暂存文件，完成时校验最终文件身份及原包摘要。文件被其他程序锁住时保留 `export_recovery_pending`，同一服务实例可以显式重试核验；核验返回不等于任务已经成功，页面继续读取实际终态。终态记录清除内部路径，管理 API 不返回目标完整路径。

输出目录的祖先句柄在操作期间固定；拒绝 junction/reparse、ADS、设备路径和非本地磁盘目标。所有写入使用新文件名，已有文件不被覆盖。

## 管理 API 与代码位置

继续使用 protocol 2 的 16 KiB 请求、64 KiB 响应；没有为作品文档扩大传输信封。

| 命令 | 本次接线 |
| --- | --- |
| `wallpaper.draft.create` | `kind=work`，从有界 builtin document 创建，或按本人已发布的 `workKey/packageHash` 重开；`kind=settings` 保留原行为 |
| `wallpaper.draft.list/get/parameters/properties/schema` | 草稿摘要、单稿回执、按修订分页的参数/公开属性、真实场景 schema |
| `wallpaper.properties.inspect` | 固定版本/轮播共同公开属性的快照分页 |
| `wallpaper.library.references` | 删除前只读引用详情；删除被阻止时同一有界报告进入 error.details |
| `wallpaper.draft.update/save/publish/discard` | 类型化 CAS 更新、保存作品、发布不可变版本、删除草稿 |
| `wallpaper.preview.acquire/update/renew/release` | 原有 owner 租约可引用 work 草稿，设置与作品共享一个预览窗口 |
| `wallpaper.export.pick/begin/recover` | 原生选择输出能力、受理导出任务、显式重新核验未决导出 |
| `wallpaper.jobs.get/cancel` | 统一查询/取消导入及导出；不会把已完成的文件提交撤销成“未写入” |
| `wallpaper.operations.get` | 支持精确查询持久导出操作；读取不启动新的导出任务 |
| `wallpaper.playlist.list/get/save/next` | 分页摘要、固定版本快照、列表 CAS 保存、下一项或 `retry=true` 重试失败项 |
| `wallpaper.capabilities` | 公布 `workDrafts`、`export`、`nativeOutputPicker`、`builtinPackages`、`playlists`、`playlistMaxItems:32`；A02 增量公布 single/span/mirror，并通过 `wallpaper.layout.inspect` 检查具体镜像资格 |

核心实现位于 [work_drafts.rs](../crates/hertz-desktop/src/wallpaper/work_drafts.rs)、[output_tokens.rs](../crates/hertz-desktop/src/wallpaper/output_tokens.rs)、[export_jobs.rs](../crates/hertz-desktop/src/wallpaper/export_jobs.rs)、[playlist.rs](../crates/hertz-desktop/src/wallpaper/playlist.rs) 与 [wallpaper_playlist.rs](../crates/hertz-desktop/src/wallpaper_playlist.rs)，迁移为 `0004_work_drafts.sql`、`0005_exports.sql`、`0006_playlists.sql`。服务、设置页与现有桌面/预览 owner 接线复用原入口。

## 验证与证据边界

本机 Windows 原生 WebView2 验收脚本为 [check-wallpaper-works-native.js](../scripts/check-wallpaper-works-native.js)。最终普通构建的 [10 组通过报告](../output/playwright/wallpaper-works-native-1793891507466/report.json) 与[设置页截图](../output/playwright/wallpaper-works-native-1793891507466/settings.png)记录：

- 类型化编辑自动保存，作品修订独立于配置；共享预览释放后可重新取得。
- 草稿切换先保存旧输入；分别延迟原生 get、参数与 schema 回执时，旧表单和导航保持禁用，读取完成再解锁，避免覆盖切换过程中的新输入。
- 发布包 hash 与内容一致，同一修订重复发布幂等；真实进程重启恢复标题和规范化参数。
- 固定 builtin 包以其保存的参数启动，取得真实首帧和 GL 额度。
- 两个固定版本按 10 秒间隔自动切换，Config 原字节保持不变。
- 暂停 12 秒后恢复不追赶；移走下一项原包时停播并保留旧画面，修复后显式重试同一版本。
- 保存的列表在真实宿主重启后，通过同一原生准备和交接流程恢复。

报告绑定的二进制 SHA-256 为 `dfc487168434fe01ffec9fbfe3d669dd1151e4d3d57cb5b3677b4dd1b3148da5`，没有页面错误或遗留测试宿主。此前 9 组报告 `wallpaper-works-native-1793888617147` 保留为历史证据，最终 10 组已包括编辑切换竞态修复。独立复审另用当前真实 JS 检查延迟读取及 schema 失败：旧稿先保存，重复打开拒绝，失败解锁并保留旧稿继续编辑，公共 flush 等待导航结束。

后端测试包括 13 项作品草稿/发布、6 项导出、4 项输出能力、12 项轮播，以及正式 service 的创建→保存→发布→导出→重启查询集成。作品发布测试真实终止子进程于包目录已发布、SQL 未提交的边界，再运行启动核验并重试；导出测试使用实际 Windows 文件句柄与无覆盖原子提交，包含被锁目标解除后的同实例恢复。service 测试另覆盖无 owner 拒绝、不消费有效 token、路径 DTO 拒绝、原字节/hash 与幂等任务。包协议集成测试 10 项通过。

最终桌面库回归 **393 项通过、2 项按既有音频硬件条件忽略**，包含上述新增后端测试。两个 crate 的 all-targets Clippy `-D warnings`、本次 Rust 文件格式、相关 JavaScript 语法、脚本登记与差异空白检查通过。前端默认聚合的其余 71 项已通过；新增原生脚本最初未登记导致登记项失败，补充手工登记后该项复验通过，原生旅程另行执行。

原生保存对话框的正向点击旅程尚未自动化验证；当前文件操作证据来自正式 service 与实际 Windows 输出能力测试。随机时钟与选择、不重排、旧 token 隔离有核心测试，10 组桌面旅程使用顺序模式。多屏/更多显示器与硬件组合、真实断电/OS 崩溃及 8 小时长稳不在本次通过范围内。

复现原生验收需本机 Windows 桌面、WebView2 与 Playwright，指定 `HERTZ_DESKTOP_BIN`，必要时指定 `PLAYWRIGHT_MODULE`，运行 `node scripts/check-wallpaper-works-native.js`。脚本使用独立数据目录，只停止自己创建的进程；检测到既有桌面宿主时退出，避免影响使用中的实例。

2026-11-06 后续增量：当前作品公开属性与有界删除引用详情已完成；最新[作品原生旅程](../output/playwright/wallpaper-works-native-1793937082455/report.json)为 15 项通过，桌面 Rust 全库为 497 项通过、2 项忽略。上面的 393 项／10 场景属于 A03 首版历史证据。新增合同、当前二进制与具体验证范围见[公开属性记录](wallpaper-public-properties.md)和[删除引用记录](wallpaper-library-references.md)。
