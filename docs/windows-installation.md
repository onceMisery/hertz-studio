# Windows 当前用户安装

Windows 11 x64 的 Full 原生播放器提供 NSIS 安装候选。运行 `hertz-studio-full-<版本>-x86_64-pc-windows-msvc-setup.exe`，选择程序目录并完成安装，然后从桌面或开始菜单打开 Hertz Studio。安装不自动启动播放器、播放音乐或启用开机启动。

原生播放器使用 Windows GUI 子系统，从桌面或开始菜单启动时不会创建命令行窗口。

默认程序位置为 `%LOCALAPPDATA%\Programs\Hertz Studio`；默认资料位置为 `%LOCALAPPDATA%\hertz-studio`。音乐、歌单、歌词与设置保存在资料目录，卸载会保留资料及程序目录中的额外文件。自定义资料目录继续使用已有 `--data-dir` 启动选项，见[便携程序说明](windows-portable.md)。

程序需要 Microsoft Edge WebView2 Evergreen Runtime。缺少运行时时，安装器在写入程序前停止；可从安装页面打开[微软官方下载页面](https://developer.microsoft.com/microsoft-edge/webview2/)，安装运行时后重新运行安装器。此候选不附带离线运行时。

## 更新、卸载与失败重试

更新前正常退出使用该程序目录的所有播放器、后台服务和适配进程。同一程序目录可供多个资料目录使用，最后一个进程退出后才允许更新或卸载。重新运行安装器会使用当前用户已登记的位置；同一用户不能用另一个目录覆盖既有登记。

安装未完成时，根据错误和日志处理占用或依赖问题，再运行同一个安装器。初次安装标记绑定包、当前用户、目录及卸载器身份，使用另一份不同的安装器不能直接接管它。更新中断时，重新运行安装器会先恢复完整原程序，再修复登记与卸载器，最后继续更新。恢复或修复失败会保留标记和备份，完成前播放器拒绝启动。

从 Windows 的已安装应用列表或开始菜单“Uninstall Hertz Studio”卸载。卸载只移除本安装清单限定的程序文件和自己的入口，保留资料、额外文件、未知注册值及子键。卸载被占用或中断时，解除占用后重新运行卸载入口；保留恢复标记和备份，不手工递归删除整个程序目录。

安装或卸载失败会给出原因及 `%TEMP%\Hertz-Setup-<PID>-<tick>.log`。便携 ZIP 的原本地更新与 `-Recover` 命令仍可用，见[更新协议](windows-install-updates.md)；它只负责程序文件。已经发生的资料数据库升级需按[数据库恢复说明](database-upgrade-recovery.md)处理。

## 实现与恢复边界

NSIS 使用 Unicode、当前用户权限、系统安装界面和现有图标。一次性 [setup adapter](../scripts/windows/Install-Hertz.ps1)负责登记、快捷方式、初次安装及卸载；既有 [Update-Hertz.ps1](../scripts/windows/Update-Hertz.ps1)负责完整包及真实 exe 校验、共享运行／独占替换和程序事务，不增加常驻安装服务。

恢复由已验证的更新标记驱动，即使清单在替换中暂时缺失也可进入恢复。原包复算通过后，恢复提交回调在 writer 和标记仍保留时修复安装投影；投影失败保留恢复资格。归属 receipt 先于卸载器写入，便携版首次转换中断也有可验证的归属。普通卸载器修改、无归属的部分登记、其它目录登记和开始菜单／桌面目录／祖先的 reparse point 都拒绝接管。桌面快捷方式跟随当前用户的桌面已知文件夹（含 OneDrive 重定向），与开始菜单入口一样只覆盖指向本安装的快捷方式。

原命令行更新的回调默认关闭。未知注册字段不进入回滚覆盖范围，安装和卸载只操作受管字段。注册与快捷方式没有跨文件／注册表的断电原子性保证；标记和程序备份提供受控失败后的重试路径。

## 先前4f10/8ebb候选证据

| 范围 | 结果 |
| --- | --- |
| 构建与身份 | NSIS 3.11、真实 Full/native release；[候选清单](../output/nsis-installer-reviewed-v2-candidate-20261107/hertz-studio-full-0.3.2-preview-x86_64-pc-windows-msvc-setup.exe.json)绑定包、源脚本、图标和编译器 SHA-256 |
| 实际安装／卸载 | [十八组报告](../output/nsis-installer-native-1794040367555/report.json)通过：中文与特殊字符路径、多 profile 占用、重装、注册回滚、资料保留、运行时缺失注入、初次失败与重试、未知字段、部分登记、卸载中断、卸载器修改、清单缺失、投影占用、便携转换中断及菜单链接拒绝 |
| 原更新器 | [八组真实进程回归](../output/install-owner-1794040246176/report.json)通过；新恢复回调没有改变默认 ZIP/local updater 行为 |
| 工作流 | [本地 YAML 与产物检查](../output/nsis-workflow-static-20261107.json)、[实际编译器准备步骤](../output/nsis-workflow-preparation-20261107.json)通过；Windows artifact 包含 setup、清单与摘要，合并校验和包含 setup。仅手动触发并上传候选，未运行远端工作流或发布 |

[本机安装候选](../output/nsis-installer-reviewed-v2-candidate-20261107/hertz-studio-full-0.3.2-preview-x86_64-pc-windows-msvc-setup.exe)为 15,477,432 字节，SHA-256 `4f10a9dc2efb40f419b6d8dd153c762ef9de086a05db2580af01cfea8ff72b8c`。包内 exe SHA-256 `8ebb49cd4a0e018e5d829a576775cdbac0bd2dbf1ccb959e18b20bbb56248a75`，build ID `e05267588a1133592a3d95f0909db123b329f4afec4ecb08a33f964e6494cea3`。候选和包内程序均为 `NotSigned`。

NSIS 官方项目下载流程取得的 ZIP SHA-256 为 `c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1`，编译器 SHA-256 为 `f497e92deb9f179f7b8f7553fcb3bd04f511bb2949e5e4a2aee80a10f7b20431`，见[来源核对](../output/tooling/nsis-3.11-provenance-20261107.json)。摘要不代替发布者签名。

所有原生检查仅使用本机已有 Windows/WebView2、隔离的 output 程序／资料目录、null 音频和明确故障注入；结束后本轮登记及快捷方式均已移除。真实净系统、断网／离线运行时、物理断电、签名及确定的远端更新源、真实声音与设备矩阵仍需专项验收。

复现时，将 `HERTZ_BIN` 指向实际 Full/native release，将 `HERTZ_INSTALLER` 指向与当前源摘要一致的安装候选，再运行 `node scripts/check-standalone-installer-native.js`。检查会在任何安装写入前拒绝已有用户登记或快捷方式，避免接管真实安装。

## 当前HTTP边界 release 候选

当前[setup清单](../output/native-http-release-installer-candidate-20261107/hertz-studio-full-0.3.2-preview-x86_64-pc-windows-msvc-setup.exe.json)绑定安装器SHA-256 `2686bb09bed3c4b1183556ba4e9c7f68e29e4de0c2bfcbf22b5e5a56af3f5a9a`与Full/native release程序SHA-256 `85ab5e2d00ed88e31a9bb775d382a98211d9a65deb2131c6c45d42e0ef2ce46f`。使用既有、摘要核验一致的NSIS3.11，两者均NotSigned。

[真实NSIS十八组](../output/nsis-installer-native-1794048467662/report.json)与[默认更新器八组](../output/install-owner-1794048535341/report.json)通过；上述4f10/8ebb的场景范围保持，新增结果绑定当前HTTP生产源。当前程序另有HTTP十二组、解压入口五组和release UI153项检查，见[交付记录](desktop-release.md#当前源码优化-release-候选增量)。[独立复核](../output/native-http-release-final-verification-20261107.json)确认720份输入一致、登记/快捷方式及测试自有进程已清理，既有服务保留。

该结果仍属于已有Windows/WebView2主机、隔离路径、null音频和明确故障注入。当前release的正式OBS/OLE前台资格、签名/确定远端更新源、净系统/离线依赖与物理设备/其它OS仍未取得，旧候选身份不变。
