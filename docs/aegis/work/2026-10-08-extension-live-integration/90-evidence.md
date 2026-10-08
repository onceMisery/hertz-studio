# 扩展架构真实账号与 DBX 宿主联调证据

日期：2026-10-08。基线 `4cbbb48`，使用原 `codex/extension-architecture` 工作树续接。
用户在原聊天中已明确授权合并 `master` 和真实平台/宿主联调；该授权取代原实施计划中的“不自动合并”。

## 修复与归属

- `app.js::openSocket` 只为 HTTP transport 签发一次性握手票，DBX 和其它非 HTTP transport 直接建立自己的事件连接。未改变 HTTP 票据参数、失败退避或长期 token 的边界。
- `check-online-transport.js` 执行真实启动函数，并执行真实 `DbxTransport`：事件过滤、重连退订、关闭订阅的迟到失败/事件抑制、活跃失败重试、恢复连接和幂等关闭。`demo` 用例仅验证启动分支，不声称有实际演示后端验收。
- 最低宿主版本设为实际验收的 DBX 0.6.35。原 0.6.29 内联 CSS 丢弃 `data-skin-css` 的历史问题不在皮肤注册表中增加补偿路径；0.6.30–0.6.34 未逐版测试。
- 修正两处早于本次重构的 sidecar 检查：非法 UUID 应返回 404/not_found，合法但缺少文件的 UUID 才是 204/null；音质设置按真实多档源派生，不再写死五项数量。对照 `ae26155` 及 `581008f`、`06d4a2c` 确认生产行为没有回归，未改变 RPC 或 Provider 来迎合测试。

## 自动检查

所有下列命令从续接工作树执行；主要日志汇总在主目录 `output/`。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `node scripts/check-frontend.js --extra` | 48 步通过，0 失败；含真实 transport 回归 | `output/extension-resume-frontend.log` |
| `cargo test --workspace --locked --target-dir D:/code/github/hertz-studio/target-extension-architecture` | 清理共享目录的旧内嵌缓存后最终复跑：510 通过、0 失败、1 忽略 | `output/extension-resume-cargo-test.log` |
| `cargo build --locked -p hertz-studio --target-dir D:/code/github/hertz-studio/target-extension-architecture` | 通过；实际 HTTP `/app.js` 与工作树 SHA-256 相同 | `output/extension-resume-build.log`、`output/extension-resume-http-assets.json` |
| `node scripts/check-plugin-sidecar.js`，`HERTZ_PLUGIN_BIN` 指向最终包解出的 exe，`VMUSIC_BACKEND=null` | 269/269；独立临时数据库、进程内凭据 | `output/extension-resume-sidecar.log` |
| `node scripts/check-workshop-stage-browser.js`，`STAGE_VISUAL_URL=http://127.0.0.1:18784` | 八组通过：真实绘制、暂停参数、歌词归属、cue/seek、图层、减弱动效、失败恢复、重开/移动布局；无页面异常 | `output/extension-resume-workshop.log` |
| 两轮独立只读审查及增量复核 | 无遗留 P1/P2；真实 HTTP 签票/退避和 DBX 生命周期独立验证通过 | 本记录中的根因与修复；相关检查脚本 |

构建过程中发现两项工具层问题并排除：DBX CLI 会向根 `Cargo.lock` 添加未使用 SDK patch 记录，该生成差异已清除；跨工作树共用的 target 曾直接复用旧 `/app.js` 内嵌内容，已仅清理本任务目标目录中的 `hertz-studio` 包后重建，重新比较实际 HTTP 响应字节。主目录原有 7634 服务未被替换。

## 最终插件包与真实 DBX

构建命令：`npx --yes @dbx-app/plugin-cli@0.1.2 package plugin --output-dir D:/code/github/hertz-studio/output/extension-resume-package`。

- 产物：`output/extension-resume-package/io.github.oncemisery.hertz-studio-0.1.0-windows-x64.dbxp`，未签名候选包，9,474,871 字节。
- 包 SHA-256：`cc0222936f874bf26171a508bcd08789d8932af9ea60e93bccd6959e0d1b367b`。
- sidecar SHA-256：`e608df1d136870c34ee06d304ae53b1afdedb070e44499160a4804864451ceac`。
- 98 个 UI/资产文件与工作树逐字相同；100 个包内校验和全部匹配。manifest 除打包器将可执行路径改为 `bin/windows-x64/dbx-plugin-hertz.exe` 外完全一致，包含 `engines.dbx >=0.6.35`。
- 宿主 exe 文件版本 0.6.35，WebView2 154；数据目录 `output/extension-live-dbx-035`，与用户原安装隔离。使用宿主安装命令安装最终包；Windows 同版本替换前需先关闭工作台并停止插件，释放 exe 文件占用。

原生宿主结果（`output/extension-resume-native-evidence.json`）：

- 服务连接成功，真实 `studio/event` 收到 `state`、`buffering`、`spectrum`。
- 六套皮肤正反共 12 次切换，每次重复选择，CSS 标记正确、业务 DOM 节点身份不变、业务桥接可用。
- 六个创意场景的默认值、参数规格、机位复位、分享归一化及歌词能力一致；七个沉浸场景可切换，WebGL2 可用，无损坏图片。
- 网易云真实搜索/歌词/播放经宿主 RPC 成功，诊断会话确认 `backend=cpal`。新音频经网络下载进入原生播放，播放位置从 42ms 推进至 2052ms。测试音量为 0，证明解码/设备/时钟/事件链路，不作为人工听音质量结论。
- 最终包安装后的启动及交互均未捕获页面异常。上一轮的匿名 `.plugins` 异常与宿主 Tauri `path/init.js` 初始化代码相符，本轮未复现；未修改 DBX 仓库或屏蔽任何页面错误。

另外实际打开创意舞台，逐个运行六个注册场景（`output/extension-resume-creative-native.json`）：全部 `render().ok=true`，画布 2355×1556，每个场景读回非空像素，GL error 均为 0。`lyric` 独占歌词，其余场景不声明此能力。截图在 `output/playwright/extension-resume-dbx/creative-*.png`；已查看 towers 与 lyric 的真实宿主截图。测试绘制探针已恢复。

## 真实平台范围

HTTP 使用隔离的 18784 服务；日志只记录状态码、数量和错误代码，不记录 cookie、令牌、账号名或取流 URL。联网探针的退出码本身不表示所有平台通过，结论以下表各项为准。

| 平台/路径 | 本次观测 | 结论 |
| --- | --- | --- |
| 网易云 | HTTP 与 DBX RPC 账号资料、个人歌单、每日推荐通过；搜索有结果；HTTP 音频下载 65,536 字节且格式头有效；DBX 原生播放推进 | 所测链路通过 |
| QQ | 资料 401 `auth_required`；歌单/推荐/搜索有结果；5 个候选取流均 502 `upstream_error` | 未通过账号/播放验收，需要手机 QQ 重新扫码；不能用本地 `signedIn=true` 或推荐成功替代 |
| 网易云、QQ、酷狗、汽水扫码 | 申请二维码、轮询 `waiting`、取消均返回 200 | 仅验证扫码握手，不代表人工授权成功 |
| 酷狗、酷我、ccMixter、咪咕搜索 | 返回数量分别为 5、5、4、20 | 所测查询有结果；未进行这些平台的账号或完整播放验收 |
| 汽水搜索 | HTTP 200、0 条 | 不计为搜索通过 |
| Jamendo | 未进入当前可用源列表 | 本轮未联调 |

用户扫码问题已异步提出，截至本记录尚未收到扫码答复。没有擅自将该项标为完成。

## 架构、工具与交付边界

架构对齐：aligned。事件、HTTP 鉴权、Provider、场景和皮肤仍由既有模块持有；恢复传输边界并移除过时测试事实，未增加源名单、宿主 CSS 解析或新的业务 owner。ADR-0009 补充已验收宿主版本与事件连接约定。

Aegis helper 已建立本次工作记录，`bundle` 成功生成结构证据包。workspace check 仍报告两份既有未索引 Markdown（`2026-10-05-hardening-and-alignment-design.md`、`2026-09-30-cover-sphere-sonnet/99-reflection.md`），不是代码失败；未改动治理文件或重写历史记录。

代码收尾和本地合并可以独立完成；真实平台全量验收仍受上述登录/配置/上游结果限制。整体证据置信度 B，不能据此宣称所有平台已验收或已发布。

## 本地集成结果

修复提交 `79857fd` 已快进合并到 `master`。合并后再次运行前端 48 步和最终包 sidecar 269 项，全部通过；主分支 98 个 UI/资产文件在归一换行后与最终包一致，manifest 的平台入口转换也匹配。日志分别为 `output/extension-resume-merged-frontend.log`、`output/extension-resume-merged-sidecar.log`、`output/extension-resume-merged-package.json`。

测试绘制探针和事件观察器已移除，隔离 DBX 插件、宿主及 18784 服务均已停止；端口检查只剩原用户服务 7634。测试数据、截图和插件包保留在 ignored output 中。后续仅收口本记录，不再更改生产代码。

## EvidenceBundleDraft

- Artifact key: native-dbx
- Type: integration
- Source: docs/aegis/work/2026-10-08-extension-live-integration/90-evidence.md
- Summary: 最终包实际安装到DBX0.6.35；事件、12次换肤、6个原生WebGL场景、7沉浸切换和静音CPAL网易云播放通过；startup及交互页面异常为零；QQ需人工重新登录
- Verifier: 主代理运行原生WebView/RPC/截图/包SHA核对，独立代理只读复核
