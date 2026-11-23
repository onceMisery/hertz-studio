# 应用内版本检测与升级

在 **设置 → 工具 → 关于与更新** 中点击“检查更新”。页面显示当前版本、对应发行版的最新稳定版本和更新说明；网络错误会明确显示失败，可以重试。播放器、Standard 插件和 Full 插件各自匹配发布标签，不使用 GitHub 的全仓库 `latest`，也不把预发布或较低版本作为可安装更新。

“启动时检查更新”默认关闭。打开后，当前资料目录每天最多尝试一次启动检查；失败也计入当天的自动尝试。手动检查的成功结果缓存五分钟。普通状态读取和关闭的启动检查不访问更新服务。

## 不同运行方式

| 运行方式 | 更新操作 |
| --- | --- |
| Windows x64 Full 原生播放器，完整 release 安装包 | 下载并校验后点击“安装并重新打开”；安装版复用原 NSIS，便携版复用原程序目录事务 |
| 普通浏览器访问同一原生服务 | 可以检查、准备下载；安装必须回到该服务的原生窗口确认 |
| Windows 服务形态、开发构建或不完整程序包 | 检查版本并打开发布页面，下载完整包后更新 |
| macOS、Linux 独立播放器 | 检查版本并提供对应系统的下载链接 |
| Standard / Full DBX 插件 | 检查自身版本，复制对应插件包链接后在 DBX 中安装 |

应用内安装要求当前程序的 `standalone-build.json` 与编译身份一致，并声明原生窗口和安装目录保护能力。Windows 安装版还要求本目录的 `hertz-setup.json` 登记有效。缺少匹配附件时提供发布页面；附件缺少摘要时保留手动下载链接，应用内下载与安装不可用。

## 下载和退出

下载操作支持进度、取消和失败重试。更新连接仅使用本仓库的 GitHub 发布 API、附件 URL 和官方附件重定向域，拒绝其他重定向。网络请求有超时和响应大小限制；解压限制文件名、条目数及总字节预算。包体和解压后的总大小最多 256 MiB。SHA-256 来自 GitHub 附件摘要或同一发布中的摘要文件；下载校验失败不会进入安装状态。摘要证明内容完整性，发布者签名资格仍独立验收。

安装只能通过当前原生窗口文档的 IPC 受理，没有 HTTP/RPC 安装接口。辅助进程先核对资料、暂存目录和准确的播放器进程，并回报就绪，再进入原有舞台保存、录制收尾和退出确认流程。选择“返回播放器”、文档重载、辅助进程失效或确认失败均取消这次安装。等待过久后需要重新点击安装。

只有绑定的退出请求获准并完成正常服务清理后，主程序才写入本次安装的提交标记；单纯进程退出或崩溃不表示用户批准安装。帮助进程等待该进程退出，重新校验下载包，再取得原安装目录 owner。其他资料目录仍使用同一程序时，更新会等待最多 30 秒后拒绝替换，不结束其他进程。

程序更新继续由 [Windows 更新事务](windows-install-updates.md)或[当前用户安装器](windows-installation.md)拥有。额外程序文件与音乐资料保留。成功后重新打开同一资料目录，使用本次实际监听端口，并显式保持原生窗口需要的 `127.0.0.1` 绑定；普通退出会清理未安装的本次已下载包。

## 失败处理

日志保存在当前资料目录 `cache/updates/update-<token>.log`，结果保存在 `cache/updates/last-install.json`。下一次启动会显示最近的更新结果。下载取消或安装未批准不会写入成功记录。

未完成的程序替换沿用原恢复标记及备份，完成恢复前拒绝业务启动。便携更新可使用保留候选中的 `Update-Hertz.ps1 -Recover`，安装版可重新运行同一安装器；具体命令见上述 Windows 文档。数据库升级与程序更新分开管理，不通过换回旧 exe 自动回滚数据库，见[数据库恢复说明](database-upgrade-recovery.md)。

## 服务接口

这些接口需要现有完整播放器鉴权；只读桌面 key 和外部 AI 授权不获得更新权限。

| 接口 | 行为 |
| --- | --- |
| `GET /v1/system/updates` | 本地状态快照，不访问外网 |
| `POST /v1/system/updates/check` | `{automatic?: boolean}`，开始或复用版本检查 |
| `PUT /v1/system/updates/settings` | `{checkOnStartup: boolean}`，持久化启动偏好 |
| `POST /v1/system/updates/download` | 准备已选定的可校验更新包，仅正式原生安装上下文可用 |
| `POST /v1/system/updates/cancel` | 取消检查/下载；安装已进入退出确认时，使用原生确认中的返回按钮 |

DBX RPC 共用状态、检查、偏好与取消的 owner，不装配下载/安装程序的能力。状态阶段包括 `idle/checking/current/available/unavailable/downloading/verifying/ready/installing/cancelling/cancelled/failed`；`canDownload`、`canInstall` 与不可安装原因供界面按实际能力呈现。

实施后回归入口：`node scripts/check-app-updates-browser.js` 与 `node scripts/check-app-updates-native.js`。后者只操作隔离的 output 程序/资料目录；开发二进制需显式设置 `HERTZ_ALLOW_DEBUG_PACKAGE=1`。失败夹具使用 `NoRestart/Quiet`，成功夹具会实际自动重新打开同一资料目录和端口，并验证配置绑定冲突下的原生窗口。实际更高版本、NSIS 的本次在线交接及正式签名资格需结合 release 候选验收，软件夹具不替代这些资格。
