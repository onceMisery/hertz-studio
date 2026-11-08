# 壁纸资料升级与恢复

2026-11-07。`wallpaper.db` 的迁移集由桌面库持有，当前版本为 6；SQLite 快照、完整清单、私有权限、恢复标记和替换事务复用 `hertz-sqlite-lifecycle`，与音乐库各自使用独立目录和 kind。

## 启动与准入

独立桌面薄壳和播放器内嵌宿主共用 `run_with`，在读取/迁移桌面配置、窗口和来源线程之前取得桌面根目录共享准入并只读检查壁纸库。当前库允许多个宿主；新根保持懒建库，设置/能力查询不会提前创建数据库。既有旧库释放自身 reader 后取得独占 root、`config.commit.lock` 和既有内容写门，重新检查、建立完整恢复点、迁移并关闭临时连接池，再重新取得 reader 并复查。

锁顺序为 root → 配置提交锁 → 需要时的内容写门。配置提交锁保持原有职责；它不会反向取得 root。配置加载、提交、重试/回执和日志核对都先取得 root reader。Library 首次建库在 reader 和配置提交锁下串行；不能在活宿主 reader 下自行升级既有旧库。

宿主、AssetStore、媒体输入及 SQLx PoolInner 回调保留 root reader。pool clones 和借出的 PoolConnection 不能随 Library 提前放行。SQLx 普通 Drop 只通知后台线程关闭 SQLite，因此独占准入还用 Windows share=0 句柄确认数据库及 WAL/SHM/journal 的物理句柄已经退出；detach/raw connection 也会阻止独占操作。并发当前读者关闭侧文件时，Windows 短暂的 delete-pending ACCESS_DENIED 最多重试 75ms；持续权限错误、链接和非普通文件继续拒绝。

root 会规范化并固定目录及祖先身份，锁载体和路径不接受 symlink/junction/reparse。未来 schema、checksum/迁移前缀不符、未完成记录、损坏数据库，以及损坏或悬空链接恢复标记，均在配置写入前拒绝。

**旧版兼容边界：**旧 exe 未实现 root 准入，必须先正常退出并在升级/恢复期间保持停止。入口会拒绝已打开的 SQLite 文件和既有内容写门；这次用真实旧 SQLx schema/pool 及独立 Python 进程验证了检测，不声称能拦住任意随后启动的旧 exe 或其它未采用协议的写者。

## 恢复范围

恢复点保存全部数据库表与提交的 WAL，以及以下完整资源：

| 路径 | 用途 |
| --- | --- |
| `packages/` | 不可变原包、投影与收据，包含空目录 |
| `staging/` | 未完成任务的原输入和暂存内容 |
| `derived/` | 数据库引用的派生资源；整体保存，未假定可以安全省略 |
| `config.json` | 完整桌面配置，包括活动/非活动 profile、歌词、小窗、壁纸与轮播选择 |
| `operations/` | 与配置一致的提交意图和回执 |

配置中外部音乐 profile 路径、系统注册表/开机启动、窗口或硬件状态不随本项回退。WebView 用户缓存、诊断日志和单独的配置迁移 `.bak` 没有成为数据库资源依赖，保留在原位置。恢复配置不会重建外部音乐库、外部原输入或导出目标。

`upgrade-backups/` 与 `database-upgrade-incomplete.json` 的完整性、Windows owner/SYSTEM 私有 DACL、资源 hash/存在性/目录类型、暂存与最终复核、保留 displaced 状态和中断重试均沿用[共享机制说明](database-upgrade-recovery.md)。这些恢复点含私人历史资料，不作为普通 JSON 分享导出。

## 外部导出边界

旧导出日志中保存的输出路径和文件身份不能在回退后重新获得外部写入/清理权限。目标快照、完整暂存及目的路径验证通过后，首次替换前 flush `wallpaper-export-reset.pending`；该屏障在恢复范围之外，不能被历史快照覆盖。无效恢复请求不会发布它，成功迁移也不撤销当前导出。

随后 Library 在配置锁内把恢复出的非空导出路径记录标记为 failed 并清空路径/身份，数据库提交后才移除屏障。中断可重复这项数据库处理。它不会自动写入或清理目录外的旧文件，用户需重新选择输出位置；实际有效旧暂存文件身份也已纳入恢复测试。

## 离线命令

先正常退出使用此桌面根的所有 standalone、DBX 内嵌与旧版宿主。`--desktop-root` 必须显式给出已存在的桌面根，与音乐 `--data-dir` 分开。默认桌面根为 `%LOCALAPPDATA%\Hertz\Desktop`（可由 `HERTZ_DESKTOP_CONFIG_DIR` 指定），多个音乐 profile 可共用它。

```powershell
.\hertz-studio.exe --wallpaper-list-upgrade-backups --desktop-root 'D:\HertzDesktop'
.\hertz-studio.exe --wallpaper-recover-upgrade --desktop-root 'D:\HertzDesktop'
.\hertz-studio.exe --wallpaper-restore-upgrade-backup upgrade-<id> --accept-data-loss --desktop-root 'D:\HertzDesktop'
```

独立 `hertz-desktop.exe` 薄壳接同一个维护函数。命令在配置/GUI/feed 前分流，不装配服务；播放器入口仍持有程序安装目录 reader。列表逐 ID 给出校验错误，保留其它健康项。历史恢复需要 `--accept-data-loss`，因为数据库、原包、任务与完整桌面配置会一起回退；先保存并验证当前救援快照，输出 `rescueSnapshotId`。`--wallpaper-recover-upgrade` 只应用现存完整恢复标记。

不能删除标记来绕过检查，不能手改迁移账本。快照、救援、暂存和被替换资料都需要空间；失败保留恢复材料，不静默递归清理。程序更新器不会自动恢复此目录。

## 验证记录

运行 `node scripts/check-wallpaper-upgrade.js`，指定相同候选的 `HERTZ_BIN`/`HERTZ_DESKTOP_BIN`，需要 Windows/WebView2 与 Python SQLite，且没有其它独立桌面宿主。脚本只使用输出目录中的隔离资料并停止自建进程。存储/桌面 Rust 回归、独立审查和最新候选绑定见[工作证据](aegis/work/2026-11-07-wallpaper-upgrade-recovery/90-evidence.md)。

本机进程中断不等同物理断电或损坏磁盘资格。开发构建证据与优化/发行候选分开记录；本项不完成普通 JSON 一致性、浏览器偏好迁移、NSIS、签名或整个 A08。

最终优化验收：壁纸七组、音乐十三组、内嵌宿主六组、真实作品十五组、程序更新八组、ZIP 五组及 DataDir 八组全部通过同批候选。内嵌三轮证明活宿主阻止维护、真正停写后放行且主窗口继续运行；壁纸中断场景实际终止标记已发布的恢复进程。完整报告、来源/二进制摘要和 Rust/MSRV/Clippy 证据见[交付增量](desktop-release.md#独立壁纸恢复与同批优化候选回归)。
