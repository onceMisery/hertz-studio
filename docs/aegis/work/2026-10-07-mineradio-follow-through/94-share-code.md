# C5 创意预置分享码

## 范围与取舍

- 原 owner 仍为 `CreativeStage`。工坊只发出分享／载入意图，`creative-share-code.js` 只负责字节帧；不存在另一张舞台字段或默认值真值表。
- 分享范围：预置名称、场景、全部基础参数、cue、音频绑定、自动导演及原有背景／手绘设置。沉浸舞台的 `Stage3D.preferences` 不在此契约内。
- 采用**完整版本 payload**，不采用相对当前 defaults 的 delta。基础参数键从既有 `BASE_SPEC`／`SCENE_SPEC` 派生；背景和手绘的当前生效值分别由原 `Backgrounds.values()`／`HandDrawn.values()` 物化。新增分享字段或改变字段语义需要升级协议，不能借新版默认值解释旧码。
- 分享投影调用原 `normalize`，但先按安全字段构造新对象：参数和 cue 路径只接受 spec 中的键；下拉值须属于原枚举；绑定目标与音频来源须为字符串并命中原 owner；不传库 ID、缩略图、媒体 URL、文件路径或未知嵌套键。媒体背景改为主题背景，界面明确说明。主题和封面取色仍随接收者环境变化，不承诺逐像素相同。
- 原 JSON 导入／导出保持兼容，不用分享码的严格完整性要求拒绝已有稀疏 JSON。

## 版本与边界

帧：`HSCP1.<J|G>.<base64url>.<CRC32>`。

- `J` 为 UTF-8 JSON 互通基线；`G` 为 gzip。base64url 无 padding，CRC32 为传输字节的 8 位十六进制校验和，只检出损坏，不认证作者。
- 编码单独检测 `CompressionStream`，仅在压缩字节确实更短时使用 G；压缩不可用或失败则生成 J。工坊可显式选择“兼容码（不压缩）”。
- 解码单独检测 `DecompressionStream`，不支持 G 时明确要求发送者生成兼容码。未知版本、未知帧格式、损坏的校验和／base64url／UTF-8／JSON、过大的输入都有明确错误。
- 传输字节和解压结果上限均为 **128 KiB**，粘贴文本上限 **180000 字符**。解压逐块累计，超限立即取消 reader，不先读完整个输出。一次粘贴允许带周边说明，但只接受一份完整帧。
- v1 将 cue 缺省时长／缓动与绑定缺省增益物化为现有的 `600`／`out`／`1`；完整基础参数与背景／手绘字段不能由接收者当前配置补齐。

## 工坊行为

导出页新增分享码文本框、“生成并复制分享码”、“载入分享码”及兼容码选项。自动复制失败时保留并全选文本，提示手动复制。异步操作同时核对操作序号、面板会话及预置编辑代际：晚到解码不会覆盖后来的参数修改、关闭或新的粘贴；编辑导致取消时会明确更新提示。

## 验证

- `node scripts/check-creative-share-code.js`：**44 项通过**。执行真实 owner 和 codec，覆盖 J/G 往返、Unicode、周边文本提取、独立能力检测、压缩择优、坏码、版本、超限、解压炸弹及 reader 取消、unsafe 字段投影、旧 JSON 兼容。
- 独立评审发现下拉值未检查枚举、绑定数组会隐式转字符串。新增 6 条用例先观察到 `Missing expected rejection`，再由 owner 修正；44 项由评审代理独立重跑通过。
- `node scripts/check-creative.js`：**354/354 通过**，覆盖原预置／参数／cue／绑定／JSON／渲染生命周期。
- `node scripts/check-creative-share-code-browser.js`：**通过**。真实 Chrome，完整当前 HTML 与脚本，仅移除 `app.js` 自动启动，再初始化真实 Stage／CreativeStage／Stage3D／Workshop。覆盖 UI 往返、复制失败全选、坏码不写、编辑／关闭／输入竞态、G 缺能力、JSON 入口保留及 420px 布局。
- 浏览器截图：`output/playwright/creative-share-code/share-fixture-desktop.png`、`share-fixture-narrow.png`。已逐张检查。
- 嵌入资源由 UI 代理接入 `index.html`、Rust 静态路由／fingerprint 及前端检查聚合。最终隔离 null 服务模式已验证：`SHARE_CODE_URL=http://127.0.0.1:7080`、`VMUSIC_DATA_DIR=D:/code/github/hertz-studio/output/mineradio-live-48662137`，运行 `node scripts/check-creative-share-code-browser.js`，**退出 0，通过**。先逐字核对服务实际发出的三个当前 JS 文件，再验证真实 `app.js` 启动／服务已连接以及同一套分享 UI 行为；无浏览器运行时错误。
- 完整服务日志：`output/mineradio-share-live.log`；截图：`output/playwright/creative-share-code/share-live-desktop.png`、`share-live-narrow.png`。已逐张检查桌面与窄屏布局、按钮可达和复制失败提示。
- `node scripts/check-creative-prompt.js`：**90/90 通过**；本切片文件的 `git diff --check` 通过。

## 架构与剩余边界

架构对齐：字段及 normalize 归原 CreativeStage，背景／手绘默认值继续由原 owner 持有；codec 不读写播放、账户、文件或网络，不触碰 Stage3D 预置。JSON 作为既有兼容入口保留。

ADR 追加建议：记录 v1 全量帧、J 互通基线、G 独立能力检测、128 KiB 限额和媒体排除边界；由主代理汇总到本轮 ADR。

未验证真实宿主插件剪贴板桥接或跨浏览器支持矩阵；能力分支已用真实 codec 与模拟缺能力环境验证。分享码不是加密容器，也不是签名或权益凭证。
