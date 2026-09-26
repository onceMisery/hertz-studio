# 按优先级补齐播放器功能 - Checkpoint

- Task ID: 2026-09-26-prioritized-completion
- Current todo: Define first execution slice.
- Active slice: initial
- Blocked on: none
- Next step: Read baseline refs and start the next safe slice.

## Checkpoint Update

- Current todo: 1 已实现，待代码审查与真实 API/UI 验证；2–14 均待实施
- Active slice: 1-pagination
- Completed todos:
- none
- Evidence refs:
- scripts/check-library.js
- scripts/check-favorites.js
- Blocked on: none
- Next step: 等待构建 session 96989 完成，然后运行 check-library-api.py；完成审查后推进目录管理

## Checkpoint Update

- Current todo: 第1项回归与审查中；2–13待实施；14用户明确移出范围
- Active slice: 1-pagination
- Completed todos:
- none
- Evidence refs:
- scripts/check-library-api.py
- Blocked on: none
- Next step: 审查权威队列回读逻辑，重编译独立测试程序后浏览器验证，推进第2项

## DriftCheckDraft

- Scope status: 1已实现审查通过；2实施；3–13待实施；14用户移出范围
- Compatibility status: 保留local-first、服务端队列权威、既有API默认排序
- Retirement status: 删除前端分页内排序与局部播放请求代际，复用后端查询与共享播放意图
- New risk signals:
- none
- Advisory decision: continue

## Checkpoint Update

- Current todo: 1完成；2目录维护验证中；3–13待实施；14用户移出范围
- Active slice: 2-library-maintenance
- Completed todos:
- 1全量排序分页和播放队列，Rust/frontend/API/UI及独立审查通过
- Evidence refs:
- scripts/check-library-api.py
- scripts/check-scan-ui.js
- Blocked on: none
- Next step: 修复旧Windows路径身份兼容，完成第2项审查和浏览器验证，接续第3项混合歌单

## Checkpoint Update

- Current todo: 1完成；2完成（审查+API+浏览器验收）；3完成（实现+回归+浏览器验收）；4–13待实施；14用户移出范围
- Active slice: 4-lyrics
- Completed todos:
- 2目录管理：scan_roots 仓储/watcher/旧Windows路径身份兼容测试通过，API 冒烟（--maintenance）与浏览器验收（添加/自动同步跳过205未变/停用/移除保留曲目）通过
- 3混合歌单：迁移0005快照列、playlists::add_entries/list_entries、路由富形态与 load meta 注入、前端加入歌单/整单播放/播放收藏混合队列/playRef 整盘打开；store 测试4项、API 冒烟（--playlists 含重启持久）、浏览器端到端（在线行加入歌单→虚拟身份入单→详情快照渲染→整单队列）通过
- Evidence refs:
- scripts/check-library-api.py（--maintenance / --playlists 两模式）
- scripts/check-favorites.js（113 项）、scripts/check-online.js（197 项，含 playRef）
- scripts/check-creative.js（268 项，扫描身份断言更新到增量扫描形态；修复 np 弹窗未初始化）
- Blocked on: 在线歌单收藏整盘打开（playRef）需真实平台登录凭据的端到端验收，保留待验证
- Next step: 推进第4项歌词（内嵌歌词读取、手动导入/关联、每曲偏移保存）

## Checkpoint Update

- Current todo: 1–4 全部完成（P1 收官）；5–13 待实施；14 用户移出范围
- Active slice: 5-library-management
- Completed todos:
- 2目录管理：scan_roots 仓储/watcher/旧Windows路径身份兼容，API 冒烟与浏览器验收通过
- 3混合歌单：快照列+富形态路由+load meta 注入+前端全链路，API/契约/浏览器端到端通过
- 4歌词：迁移0006 track_lyrics、LyricSource::Imported、内嵌提取（symphonia 标签）、来源优先级 imported>embedded>sidecar、每曲偏移叠加落库、np 弹窗导入/清除/±0.5s 控件；store 3 测试+library 2 测试（FLAC fixture）+API 冒烟+浏览器验收（徽标、偏移+1.0s 持久化、导入后回退）通过
- Evidence refs:
- scripts/check-library-api.py（--maintenance / --playlists / --lyrics 三模式）
- scripts/check-favorites.js 113 项、scripts/check-online.js 197 项、check-creative.js 268 项、check-assets.js 345 项
- Blocked on: playRef 真人凭据验收保留；无其他阻塞
- Next step: 推进第5项曲库管理（专辑/歌手浏览、标签编辑、封面替换、批量操作）

## Checkpoint Update

- Current todo: 1–5 完成；6 进行中；7–13 待实施；14 用户移出范围
- Active slice: 6-backup-restore
- Completed todos:
- 5曲库管理：迁移0007 track_edits 覆盖层（编辑重扫保留）、facets 专辑/歌手浏览、列表/计数/队列筛选与覆盖 COALESCE 一致、批量编辑/收藏/加入歌单、封面替换（cover_edited 跳过重扫落盘）、失效文件整理（missing+batch-delete）；store 3 测试、API 冒烟 --library、浏览器验收（筛选 2 首/勾选批量栏/取消隐藏）通过
- Evidence refs:
- scripts/check-library-api.py（--library）
- Blocked on: none
- Next step: 第6项备份恢复与 M3U 导入导出

## Checkpoint Update

- Current todo: 1–6 完成；7 进行中；8–13 待实施；14 用户移出范围
- Active slice: 7-system-credentials
- Completed todos:
- 6备份恢复：store backup 模块（导出 JSON 不含凭据、单事务恢复、幂等合并/去重、版本校验、M3U 导出导出）+ 路由（/v1/backup、/v1/backup/restore、/v1/playlists/{id}/m3u、import-m3u）+ 设置页备份 UI + 歌单 M3U 导出按钮；store 3 测试、API 冒烟 --backup、浏览器 UI 验收通过
- Evidence refs:
- scripts/check-library-api.py（--backup）
- Blocked on: none
- Next step: 第7项系统凭据（keyring 适配、SQLite 凭据迁移、失败不静默回退明文）

## Checkpoint Update

- Current todo: 1–8 完成；9 进行中；10–13 待实施；14 用户移出范围
- Active slice: 9-capability-matrix
- Completed todos:
- 7系统凭据：secrets.rs 抽象（OS keyring + memory）、cred put/get/clear/device 全走后端且失败明确报错、启动迁移（后台任务，失败保留旧数据记 ERROR 重试）、冒烟显式 memory 后端；迁移测试 1 项通过
- 8在线缓存：cache_stats/clear_cache（保护当前播放+保留名单豁免、支持按音源）、keep 持久化（persist::load_strings/save_strings）、路由 stats/clear/keep、设置页缓存区 UI；cache 测试、--cache 冒烟通过
- Evidence refs:
- scripts/check-library-api.py（--cache、--backup）
- Blocked on: 真实钥匙串登录登出端到端需真人凭据，保留待验证
- Next step: 第9项能力矩阵核实

## Checkpoint Update

- Current todo: 1–9 完成（9 为代码级核实）；13 完成；10–11 待实施；14 用户移出范围
- Active slice: 10-audio-dsp
- Completed todos:
- 9能力矩阵：dispatch 全部用户端点逐个 gate（playlists/detail/create/delete/add/remove/like/recommend_songs/recommend_playlists/qr_start/qr_check）；caps 表诚实标注未真机验证的能力（酷狗歌单/推荐/写操作代码已备但位关，QQ Like 未实现待 dirid=201 真机）；扫码状态机契约测试已有。真人凭据验收精确缺失：QQ 红心 dirid=201 实测、酷狗歌单读写/推荐实测、酷狗 confirmed 换票实测
- 13播放历史：list_filtered 分页+来源筛选+标题/歌手/专辑搜索（total 计数同语义），路由 HistoryQuery 扩展 limit/offset/source/q；在线面板历史区加来源筛选下拉与「加载更早」游标分页；history 4 测试通过
- Evidence refs:
- scripts/check-library-api.py（--cache --backup 联跑）
- Blocked on: none
- Next step: 第10项音频 DSP（EQ/响度归一化/限幅/交叉淡化，real 声卡测听单列），随后第11项 WebDAV

## Checkpoint Update

- Current todo: 1–10、13 完成；11–12 待实施；14 用户移出范围
- Active slice: 12-release-workflows
- Completed todos:
- 10音频DSP：core DspParams + trait 默认方法；cpal 后端 6 段 biquad EQ（RBJ peaking，采样率/增益签名惰性重建，try_lock 不阻塞音频线程）+ preamp/ReplayGain 曲目增益 + 软限幅（0.98 ceiling 之外压缩）+ 可调交叉淡化（覆盖换装淡入/尾淡出/停止淡出，0=内建默认）；迁移0008 tracks.rg_gain + 扫描读 REPLAYGAIN_TRACK_GAIN；/v1/player/dsp GET/POST 持久化并即时下发；设置页 EQ 滑杆/增益/响度开关/交叉淡化 UI；audio 4 项 DSP 测试。真实声卡测听按计划单列
- Evidence refs:
- cargo test vmusic-audio 22 项；check-library-api 四模式联跑 PASS
- Blocked on: 真实声卡测听（EQ/响度/交叉淡化主观验收）需真机，保留待验证
- Next step: 第12项 release workflows，随后第11项 WebDAV

## Checkpoint Update

- Current todo: 1–10、12、13 完成；11 待实施；14 用户移出范围
- Active slice: 11-remote-webdav
- Completed todos:
- 12发行链路：.github/workflows/release.yml（workflow_dispatch 手动触发、win/mac/linux 三平台矩阵、zip/tar 打包 + SHA256SUMS 合并、产物留 run artifacts 不自动发布）；vmusicd --version；scripts/check-update.sh 只读版本比对
- Evidence refs:
- 全仓 248 测试 0 失败（native_watcher 清理阶段一次 Windows 句柄时序 flake，重跑通过）；clippy 零警告；9 个前端契约脚本 + API 冒烟五模式全 PASS
- Blocked on: none
- Next step: 第11项 remote 来源（WebDAV 管理/浏览/导入与 HTTP 直链播放，凭据走钥匙串）

## Checkpoint Update

- Current todo: 1–13 全部完成（14 用户移出范围）
- Active slice: done（剩余为真人验收项）
- Completed todos:
- 11 remote 来源：迁移0009 remote_roots（密码只进钥匙串 remote_cred_<id>）、remote.rs（宽松 PROPFIND 解析器按本地名匹配任意命名空间、HttpRangeStream 直链播放实现 Read/Seek/media_len、按 base_url 前缀最长匹配取凭据）、路由 roots CRUD/browse/import（导入幂等 source=remote）、设置页添加/删除/浏览对话框（断网错误如实展示可重试）、迷你 DAV 服务器冒烟（207/401/Range）通过；商店 remote_roots 测试 + 解析器 4 测试通过
- 主题描述修正：午夜霓虹 note 误写「霓虹咖啡」、矿石黑误写「Mineradio 同源」、黑白简约描述如实标注冷蓝强调
- Evidence refs:
- scripts/check-library-api.py --remote（迷你 DAV 全链路）
- Blocked on: 真实 WebDAV 服务器（Nextcloud/群晖等）与真实声卡/钥匙串/QQ酷狗写操作的真人验收
