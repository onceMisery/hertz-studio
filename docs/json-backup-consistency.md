# 普通 JSON 用户备份

2026-11-07。standalone `GET /v1/backup` 与 DBX 同名 RPC 共用 `vmusic-store::backup::export`；恢复仍使用各自已有 `/v1/backup/restore` 入口和同一事务恢复逻辑。

导出包含歌单及曲目在线快照、收藏、设置、扫描目录，以及已导入歌词的原文、每曲偏移与修订。所有查询使用一个 SQLx deferred 读取事务和同一 SQLite 连接，来自同一 WAL 读取快照。其它连接仍可提交写事务，这些后续提交由下一次导出读取。读取错误或取消由事务退出处理，不返回混合结果；读取事务持续期间可能延迟 WAL checkpoint。

歌单按实际 ID 分组，查询直接联接所属 `playlist_tracks` 行，避免相同 track_id 在不同歌单中覆盖各自标题/来源/封面。相同名称的独立歌单保留独立导出项，空歌单输出空 tracks 数组，本地条目保留空在线快照字段。顺序为歌单创建时间/ID 与曲目 position。

## 兼容与恢复

无已导入歌词时仍导出原 `version:1` 形状；含歌词时使用 `version:2` 与 `lyrics:[{track_id,content,offset_ms,revision}]`，修订为十进制字符串，避免旧版恢复静默丢词。新恢复支持1/2，拒绝携歌词的v1。扫描目录保留原 `[path, enabled]` 表示，恢复仍接受 tuple 与既有对象表示。

歌词最多2048项、原文合计2 MiB，含歌词的完整导出JSON也须符合原2 MiB恢复预算，超限整体拒绝。恢复前在原解析许可内校验全部歌词，再由原事务owner写入；不保存第二份规范文档。已有歌词内容或删除墓碑的目标保持现状，仅无歌词修订记录的目标接收源原文、偏移和修订；重复恢复不推进歌词修订。身份、时间及副文本由原解析器重建。

恢复遵守原有合并语义：歌单按名称匹配，已有歌单追加未存在 track_id，已有曲目快照保留；收藏按 kind/source/ref_id 去重；设置/目录 upsert。重复恢复同一文件安全。同名独立歌单导入时会合并，这个已有 v1 契约没有改成复制歌单身份。版本、数量、长度及受管舞台设置校验继续在整体事务写入前执行，失败不留下部分新业务数据。

凭据继续由既有凭据机制持有。settings 中遗留的 `online_cred_`、`online_cookie_`、`online_device_`、`remote_cred_` 前缀均从导出中排除；受管舞台内部状态也按既有规则排除。settings JSON 解析复用原 owner，未改变旧非法 JSON→Null 行为。JSON 不携带原曲目/舞台素材文件，也不代替[私有完整 SQLite 升级恢复点](database-upgrade-recovery.md)。

## 验证

存储 63 项通过，包括真实 WAL reader 建立快照后，另一连接原子提交歌单/条目/收藏/设置/扫描目录，原读取连接仍看到完整旧代、下一次公开导出看到完整新代；同曲多歌单快照、同名歌单、空歌单、tuple roots 的 v1 恢复和四类凭据排除均覆盖。Rust 1.88 all-targets 检查通过，限定独立审查无遗留 P1/P2。

真实 HTTP/DBX 往返使用 `scripts/check-json-backup.js`，设置同批 `HERTZ_BIN`/`HERTZ_PLUGIN_BIN`，需要 Python SQLite。脚本只创建 output 中的资料并停止自建进程；凭据排除夹具在进程启动后写入并验证仍在库内，确保不是被启动迁移提前清除。最新 release 结果和二进制/来源摘要由[工作证据](aegis/work/2026-11-07-json-backup-consistency/90-evidence.md)记录。

最终新 release 的[HTTP/SDK 七组报告](../output/json-backup-1794019754601/report.json)全部通过；播放器 lib 987 通过/7 既有忽略，Clippy all-targets 通过既有三类命令行豁免，284 个脚本登记与源码/候选摘要复核通过。新[Full ZIP](../output/json-backup-1794019754601/packages/hertz-studio-full-0.3.2-preview-x86_64-pc-windows-msvc.zip)包含本次修复；本轮验证 JSON 入口和包内身份，前一壁纸阶段的 62 组原生/更新旅程保留其独立候选记录，不混为新文件的验收。

本项没有处理浏览器/WebView 的受控界面偏好迁移、原生文件保存对话框、NSIS、签名或其它完整发行资格。
