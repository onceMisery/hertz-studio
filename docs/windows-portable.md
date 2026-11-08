# Hertz Studio Windows 便携候选

完整解压 ZIP 后双击 **Hertz Studio.cmd**，即可打开原生播放器窗口。无需安装 Rust、Cargo、Node.js 或 DBX。播放器、歌词、壁纸和小窗位于同一个 `hertz-studio.exe`；`Launch-Hertz.ps1` 只负责隐藏命令行窗口并启动它，不承载播放器服务。

需要 Windows 11 x64 与 Microsoft Edge WebView2 Evergreen Runtime。当前包不包含 WebView2 离线安装材料；缺少运行时时需从 Microsoft 官方渠道安装。首次启动按需初始化曲库，不会自动导入音乐或启用壁纸。

默认资料位于当前用户 `%LOCALAPPDATA%\hertz-studio`，与已有 Full 独立播放器共用。**便携程序不代表资料随程序目录移动**。手工选择隔离资料可运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Launch-Hertz.ps1 -DataDir 'D:\Music Profile' -Port 7634
```

关闭主窗口默认隐藏到托盘；从托盘“退出 Hertz Studio”正常结束程序。关闭、保存与退出的确认以实际界面为准。再次打开同一资料目录会恢复已有原生窗口；同资料目录的浏览器服务或 DBX 尚未退出时，不能再初始化另一份服务。不同资料目录可以使用同一程序同时运行。

升级前正常退出所有使用旧程序的窗口/服务和适配进程，备份资料，再完整解压新 ZIP 到另一目录。清单含 `windowsInstallGuard: true` 的新安装支持本地程序文件更新：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\New Hertz\Update-Hertz.ps1' -InstallDir 'D:\Hertz Studio' -Candidate 'D:\New Hertz'
```

运行中的程序、其它更新进程或外部文件占用会阻止替换。工具检查完整包、真实二进制能力与文件摘要后更新；发生文件操作错误会恢复旧程序。若更新进程被中断，保留新解压包，从其中的恢复入口运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\New Hertz\Update-Hertz.ps1' -InstallDir 'D:\Hertz Studio' -Recover
```

恢复未成功前播放器会拒绝启动；保留安装目录中的事务备份。该操作只恢复这次更新的程序文件，不读写资料目录或自动启动新程序。缺少安装保护协议的旧版本仍应退出后使用新的程序目录，不使用此工具覆盖。不要把资料塞进程序目录。

新程序迁移过数据库后，仅换回旧 exe 不保证能读取；恢复升级前资料备份会丢失备份之后的修改。当前没有自动下载升级、发布者验签更新源或自动数据库回滚。调试候选仅在专项开发验收中显式使用 `-AllowDebug`，默认更新入口接受 release 候选。

`standalone-build.json` 记录包内二进制的真实版本、edition、target、原生能力、内容构建 ID 和文件摘要。发布目录的 `.sha256` 可核验下载完整性；**摘要不是发布者签名**。清单中 `signatureStatus` 如为 `NotSigned`，该产物是未签名候选，不应作为已完成签名资格的正式安装包。带 `debug` 标记的包仅供开发验收。

CLI 仍可使用 `hertz-studio.exe --open` 打开浏览器形态，无参数运行保留服务形态。`hertz-studio.exe --describe` 只读编译身份，不启动服务或创建资料目录。当前用户 NSIS 安装已通过本机十八组检查；运行 setup 选择程序目录，从开始菜单启动，更新前退出所有使用该程序目录的进程，再运行安装器。可从 Windows 已安装应用或开始菜单卸载，资料与额外文件保留。签名更新、净系统和设备资格继续单列。
