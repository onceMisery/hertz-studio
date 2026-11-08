# 主业务库升级与恢复

2026-11-07。范围是 standalone 与 DBX 共用的 `vmusic-store` 主业务库。独立壁纸库、浏览器偏好迁移及普通 JSON 导出的完整性分别跟踪；本项不能替代这些工作。

## 启动与迁移

shared bootstrap 先取得 DataDir 服务锁和旧 AI 锁，再只读检查 SQLite 完整性和 SQLx 迁移记录；检查通过后才读配置、生成 HTTP 凭据及初始化音频。数据库的未来版本、未完成迁移、checksum 不一致、缺失迁移前缀和无账本的非空旧库拒绝自动写入。SQLite 主文件及 WAL/SHM/journal 不接受链接或 Windows reparse point；DataDir 本身仍允许以规范化别名选择同一 profile。

`vmusic-store` 持有主业务 SQLx migration 集，当前最大版本为 29；通用 SQLite 快照/恢复机制在 `hertz-sqlite-lifecycle` 中只有一个实现，存储层绑定原数据库名、kind、资源根与连接限制。新库直接初始化；当前库正常打开；有待执行迁移的既有库先创建恢复点。SQLx SQLite 的 migration lock 不能代替 DataDir 内核锁，所有生产启动与维护入口均须持有后者。

一致性数据库图像使用只读连接的 `VACUUM INTO`，包含已提交 WAL，不能以复制 `vmusic.db` 替代。主库恢复点同时保存 `stage-media/objects` 的完整原始资源树，包含空目录；它不复制在线缓存、外部歌曲、系统钥匙串或独立桌面资料。

## 私有恢复点

恢复点位于同一 DataDir 的 `upgrade-backups/upgrade-<32 位小写十六进制>/`，包含：

- `database.db`：全部数据库表、索引与迁移账本的一致性图像。
- `resources/<index>/`：声明的原始资源树。
- `snapshot.json`：规范化 profile 身份、迁移 checksum、资源存在性、目录清单、文件大小与 SHA-256。

快照只接受上述三个顶层条目，拒绝 SQLite 旁置 WAL/SHM/journal、额外文件、路径穿越、跨 profile、链接/重解析点、hash 或目录范围不一致。读取快照数据库使用 immutable 连接，不能从未登记 WAL 得到验证结果。

Windows 快照根目录使用受保护、仅 owner 和 SYSTEM 具有继承权限的 DACL；Unix 根目录为 0700。文件落盘和 manifest 验证完成后才发布恢复点。**这是同 profile、本机私有的完整恢复资料，可能含历史账户、授权、任务与使用记录。它不能作为无凭据 JSON 导出分享。**系统钥匙串不随它回退，恢复后的凭据可用性由原有凭据链路裁决。

## 升级失败与中断

迁移前完整写入、flush 并原子发布 `database-upgrade-incomplete.json`。迁移发生错误时先关闭连接池，再恢复升级前数据库和素材；原迁移 28 已提交、29 随后失败也恢复到原先的 27。此次启动仍报告失败，保留恢复点供检查；再次启动不会把已失败的迁移误当成成功。

进程被终止后标记保留，下一次启动在配置和凭据前拒绝。恢复失败或中断也保留标记，不能启动半份状态。恢复先核验源和完整暂存副本，再移动当前库、WAL/SHM/journal 及资源树，最后验证恢复账本和全部素材后清除标记。被替换的文件保留在私有 `.restore-*` 工作目录，重试可以从已移动一部分文件的状态重新应用同一恢复点。

这些是本机进程中断证据；不推定物理断电、故障磁盘或网络文件系统资格。

## 离线命令

先正常退出占用该 profile 的 standalone、DBX 和桌面服务。命令要求显式、已存在的 `--data-dir`，取得同一 DataDir/AI 锁；不加载配置或钥匙串，不启动 HTTP、音频、WebView。它们仍持有程序安装目录的运行读句柄，防止自身运行时被更新覆盖。

```powershell
.\hertz-studio.exe --list-upgrade-backups --data-dir 'D:\HertzProfile'
.\hertz-studio.exe --recover-upgrade --data-dir 'D:\HertzProfile'
.\hertz-studio.exe --restore-upgrade-backup upgrade-<id> --accept-data-loss --data-dir 'D:\HertzProfile'
```

列表给出经验证的 ID、schema、时间、原因和字节数；单个坏快照给出 `verificationError`，不遮住其它健康快照。`--recover-upgrade` 只执行现存完整标记指定的恢复。历史恢复需要 `--accept-data-loss`：备份之后的逻辑修改会被替换；恢复前先建立并验证当前状态的救援快照，成功输出 `rescueSnapshotId`，可用同一历史命令恢复救援状态。

当前资料必须能被运行中的工具完整验证，才能建立历史恢复前的救援点。旧工具遇到未知未来 schema 仍拒绝历史回退，应使用能读取当前库的对应新版本完成救援与回退准备，不能修改迁移账本绕过检查。中断恢复可以使用原标记指定且受支持的升级前快照；程序回退与数据库回退是两项操作，Windows 更新器不会擅自恢复资料。

恢复点、未发布 `.pending` 和 displaced `.restore-*` 资料均不会静默递归删除，升级需要同时容纳数据库与原始素材的副本；历史恢复还需要当前救援图像和暂存空间。磁盘不足或复制/验证失败会拒绝继续或保留恢复标记。清理应在正常退出服务并核实有效恢复点后手动进行，不能删除未完成标记来绕过恢复。

## 验证入口

`scripts/check-database-upgrade.js` 调用 Python SQLite 生成真实旧迁移集，运行 Full standalone、DBX 与维护命令；所有资料属于独立测试目录，音频为 null。报告含实际 exe、插件和相关源码 SHA-256。

覆盖 WAL、28→29、部分提交后失败、异常库提前拒绝、历史恢复/救援/素材、篡改及目录祖先、未登记 SQLite 侧文件、损坏快照列表、升级中断、恢复受阻重试、活服务锁与 DBX 传输边界。Rust 测试另外直接验证源主文件字节不变；Unix 链接专项需在 Unix 实际运行，本机 Windows 结果不能替代。

## 共享机制提取

2026-11-07 为独立壁纸资料保护提取通用机制：调用方提供自己的数据库文件、kind、迁移集、文件/目录资源和连接限制；主库保留原 API/迁移集，原通用实现已移出，不能维护两套恢复 owner。旧主库资源记录缺少 `kind` 时仍按 Directory 校验与恢复，测试实际去掉此字段后完成历史恢复/救援。

共享机制支持配置单文件、操作日志/原包目录的完整 hash/存在性/目录复核；Windows 使用 ordinal 路径组件比较，拒绝混合大小写数据库、WAL/SHM/journal、备份/锁/重叠资源以及尾随点/空格和设备名。三个真实壁纸迁移 fixture 测试证明 file/directory 基础机制、部分提交失败和身份/资源类型拒绝；它们不证明壁纸宿主停写和生产接入完成。

提取后 [开发构建真实服务报告](../output/database-upgrade-1794015872036/report.json)十三组、shared core 3/3、vmusic-store 61/61、hertz lib 987 + bin 17、Rust 1.88 all-targets 与 core/store Clippy 通过。较早优化候选仍只证明当时的主库实现；独立壁纸生产库保护继续按[计划](aegis/plans/2026-11-07-wallpaper-upgrade-recovery.md)推进。
