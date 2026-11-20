# ADR-0014 · 桌面功能由独立播放器拥有

状态：已实施并完成本机开发验证（2026-11-18），正式发行与生产安全/恢复资格待完成。替代 [ADR-0012](0012-dbx-desktop-readonly-boundary.md) 的 DBX 可选桌面接入决定，保留其历史设计及证据。

## 决定

用户明确要求“桌面歌词壁纸等功能从 dbx 插件形态移出”。桌面歌词、壁纸、桌宠/迷你窗、原生设置与校准交接、壁纸 AI 由独立播放器的 `desktop-host` 和原生配置/库 owner 承担。DBX Standard/Full 保留音乐、普通歌词、沉浸舞台、舞台素材持久化、SDK/stdio 及普通浮窗。

仅隐藏桌面按钮无法移出 sidecar 已链接的原生宿主，也会留下可调用的管理、校准和壁纸路径。因此按实际构建形态裁剪依赖、接口和资源：插件依赖关闭 `desktop-host`，不装配桌面 RPC、HTTP/发现协议或原生配对能力；共用 UI 的专属 DOM、脚本、样式和导航从实际生成的插件版本中排除。原 DBX 桌面桥、组件适配器及原生 DBX feed 执行路径退役，不保留第二套桌面来源 owner。

原生启动、切源和 feed 构造只接受独立来源。内嵌宿主的实际 DataDir 形成 `custom` 来源，能力查询按原来源规范化规则核对 edition、kind 和 Windows 路径别名，不能由页面另选来源取得控制权。

历史 `Profile::Dbx` 继续承担旧配置域的序列化身份，保持可读取和往返保存；它不再承担可选择或可连接的运行来源。既有授权、配置、trust.db、作品库和插件数据不删除，不自动转换为独立来源。共享 IPC 的历史序列化常量保留其原合同，不表示重新开放 DBX 数据桥。

## 边界与 owner

| 名称（含单位） | 数值 | 定义在哪 | 改它要一起改什么 |
| --- | --- | --- | --- |
| 原生配置 schema 版本 | 5 | `crates/hertz-desktop/src/config.rs::SCHEMA_VERSION` | 历史来源域读取、独立来源准入、迁移及失败保存回归 |
| 原生管理协议版本 | 2 | `crates/hertz-desktop/src/component.rs::MANAGEMENT_PROTOCOL` | 来源/构建/requestId 校验、原独立客户端互通与真实管道边界 |

功能编译边界由 `crates/hertz-studio/Cargo.toml`、`lib.rs`、`routes.rs` 和 `plugin/backend/Cargo.toml` 共同装配；UI 形态由原 `build-support/edition-ui.rs` 与资源清单产生。它们表达同一个独立桌面归属，不建立新的配置、安装、信任或播放真值。

2026-11-20 增量继续采用以上归属。本地生成的暂停状态由原生 `NativeGeneration` 按请求及服务代际持有，原呈现策略消费该原因；取消或连接失效不冒充外部推理终止，明确恢复只解除相应呈现租约。作品改编由原 `WorkDrafts` 创建独立 workId，迁移 0013 在原 Library 保存来源版本、许可证与资源闭包，后续发布和导入仍通过原包校验。组合镜像的相位归原 `GroupPlayback`，已释放的 source generation、epoch、token 共同决定时间身份；准备下一项不会继承上一项的相位。现行行为与软件验证范围见[离线实施记录](../offline-design-completion.md)，这些增量不改变 DBX 的桌面能力边界。

现行说明已同步 [桌面客户端](../desktop-client.md)、[壁纸设计](../desktop-wallpaper.md)、[API 清单](../api-routes.md)和[DBX 提交边界](../dbx-store-submission.md)。[验收矩阵](../release-validation.md)记录当前证据：两版实际 wrapper/依赖图/生成 UI、三种页面的真实 opaque iframe 负例、独立 Full/native 编译和隔离 WebView2 管理通过。完整日志及范围见 [实施回执](../../output/community-integration-20261118/implementation-20261118.json)。

这些检查不证明正式 DBX 宿主、生产 OIDC/Signer/恢复、物理显示或长稳资格；560px DBX 主界面的宽布局裁切另行保留为未完成界面验收。G3-S 未合格，社区 Web 执行仍关闭。

## 禁止回退

- 不以隐藏 UI 代替依赖、接口和资源的形态裁剪，否则插件仍可能装配桌面宿主或请求桌面能力。
- 不把历史 DBX Profile、授权文件或共享协议常量解释为运行准入，也不为退役执行路径删除用户持久数据。
- 不从页面自报来源或二进制 edition 推断内嵌宿主的实际 DataDir；来源身份由原独立 owner 核对。
- 不把音乐、普通歌词、舞台素材或普通浮窗与原生桌面功能一同移除。
- 不以本机 fixture、编译或设置保存取代真实显示、安全恢复和正式发行验收。
