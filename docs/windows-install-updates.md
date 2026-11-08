# Windows 程序目录保护与本地包更新

日期：2026-11-07。范围：A08 的安装目录升级闸门和本地程序文件事务。沿用同进程播放器；用户要求直接实现后验证，不走 TDD。

`install_owner.rs` 在 Windows standalone 的窗口、HTTP 服务或 MCP 适配进程启动前取得程序目录 `hertz-install.lock` 共享读句柄。多个 profile 共享读权限；更新程序使用同文件 `FileShare.None` 独占句柄。任一 reader 未退出时拒绝更新；writer 持有时新 player 在配置/资料/窗口初始化前返回 `install_dir_busy`。文件不能在持有期间删除或改名；系统释放退出/崩溃的句柄。DBX sidecar 使用自己的分发路径，不接 standalone 安装锁。DataDir owner 继续独立管理业务资料。

锁载体随包提供、一直保留。现有载体只需读权限即可启动，普通直接二进制启动在可写目录中可创建载体。`--describe`、帮助和版本（包括组合 `--window`）在此之前分流，不创建锁或资料。原生包启动脚本也先检查更新状态，错误通过 CMD 入口显示；启动后守卫由播放器自己继续持有。

本地更新入口为 `scripts/windows/Update-Hertz.ps1`，PowerShell 5.1 可用。它接受显式安装目录和另一完整解压候选；拒绝根路径、嵌套源/目标、reparse point、任意路径文件名和不完整清单。当前安装及候选必须是 Full Windows x64/native，声明安装协议；目标已修改的受管文件、较低数字版本和默认 debug 候选拒绝。Standard 服务锁仍可用；当前 standalone 发布矩阵继续只产 Full。

更新只涉及包清单限定的程序、入口与许可文件。受管文件的大小与 SHA-256 复算，旧 exe 协议标识在执行前检查，当前及暂存 exe 的实际 `--describe` 与清单身份/能力逐项一致。协议标识和摘要都不代表发布者认证。

独占句柄覆盖校验、外部占用探测、暂存、备份、替换、校验和错误恢复。所有目标文件先试独占写访问，不强杀任何进程。事务仅创建在已验证的安装目录内，保留旧文件完整副本；先在事务中完整写入并 flush 恢复记录，再通过同卷原子 rename 发布恢复标记，之后才替换。发布前中断会留下未使用的暂存目录，原程序仍可运行；可见标记完整可解析。安装结果匹配固定候选清单才删除标记。错误时用验证过的备份恢复完整原程序；任何恢复错误保留标记/备份。中断后显式 `-Recover` 可重试，恢复路径和备份摘要同样验证。未完成标记使新业务进程返回 `install_recovery_required`；若程序/入口恰在替换空隙缺失，可使用保留的新解压包中的更新入口恢复。

额外用户文件保留，候选来源与资料目录不修改；更新结束不自动启动程序。`-Recover` 只恢复尚未提交的本事务程序文件，不能回退已运行新版本后的数据库。历史旧程序、同用户绕过工具写文件、网络卷、断电持久性、数据库备份/schema 兼容、NSIS 与签名更新源分别验收。

实施后真实验证入口：`node scripts/check-install-owner-native.js`，设置 `HERTZ_BIN` 为匹配 Full 二进制；开发包需 `HERTZ_ALLOW_DEBUG_PACKAGE=1`。脚本复制真实 exe 并使用私有资料/null 音频，包含 reader/writer、两种崩溃释放、包更新/错误/中断恢复和当前启动。另以 `check-standalone-package-native.js` 验证真实 WebView2 和入口。

2026-11-07 最终 Full/native release [安装更新报告](../output/install-owner-1794012615730/report.json)八组通过；[实际 ZIP/WebView2 报告](../output/playwright/standalone-package-1794012615951/report.json)五组通过，[DataDir/DBX 回归](../output/data-owner-1794012615729/report.json)九组通过。主程序 17 项、前端 73 步、Rust 1.88 all-targets 和 Clippy 通过。独立代码审查指出的原子标记发布与评测/窗口组合边界已经修正并验证；无遗留可执行发现。exe/ZIP 身份和真实资格边界汇总于[交付记录](desktop-release.md#2026-11-07-安装目录保护与本地更新)。

## NSIS 提交前投影回调

同日 [当前用户安装器](windows-installation.md)复用这个程序 owner。可信 setup adapter 可提供默认关闭的提交前回调：正常更新在完整新包核验后、恢复在完整原包还原与核验后调用，均位于 writer 仍持有、标记和备份尚未清理的阶段。显式恢复投影失败时保留恢复资料，下一次安装可以重试；原 `Update-Hertz.ps1 -Recover` 命令行不自动管理 NSIS 投影。

适配器只有在这个已验证的恢复上下文允许中断卸载器与旧 receipt 的摘要不一致，修复成功后普通读取仍严格核验。没有根据清单暂时存在或单纯观察标记就放宽准入。最新 [默认 updater 八组回归](../output/install-owner-1794040246176/report.json)和[NSIS 十八组](../output/nsis-installer-native-1794040367555/report.json)通过，签名／净系统／真实断电资格继续独立保留。
