# ADR-0004 · 会进库的载荷必须有量与长度的边界，且验在写之前

状态：生效（首次记录 2026-10-07）

## 决定

任何可被外部载荷喂满的入口（备份恢复、整盘加入歌单、m3u 导入、HTTP 请求体）都先过
**数量 + 长度**两道闸门，并且**全部验完才动手写**。取值一律留出至少一个数量级余量，
不做贴身裁剪：这些数字是「撑爆」与「正常用」之间的墙，不是产品配额。

长度按**字符**数算，不按字节：一个汉字的 base64 与一个 ASCII 字符在 SQLite 侧都只
按 TEXT 存，按字节数会把中文用户削到三分之一。

## 边界与 owner

| 数值 | 现在是多少 | 定义在哪 | 改它要一起改什么 |
| --- | --- | --- | --- |
| 一份备份里的歌单数 | 500 | `crates/vmusic-store/src/limits.rs::MAX_PLAYLISTS_PER_BACKUP` | 恢复用的临时事务大小 |
| 单个歌单的曲目数 | 20000 | `crates/vmusic-store/src/limits.rs::MAX_TRACKS_PER_PLAYLIST` | 整盘加入歌单的批量条数 `MAX_ENTRIES_PER_BATCH` |
| 一份备份的曲目总数 | 100000 | `crates/vmusic-store/src/limits.rs::MAX_TRACKS_PER_BACKUP` | 恢复耗时与 UI 的等待文案 |
| 一份备份的收藏条数 | 20000 | `crates/vmusic-store/src/limits.rs::MAX_FAVORITES_PER_BACKUP` | 收藏表口径 |
| 一份备份的扫描根数 | 100 | `crates/vmusic-store/src/limits.rs::MAX_SCAN_ROOTS_PER_BACKUP` | 远程根与本地根同表 |
| 设置键数 | 2000 | `crates/vmusic-store/src/limits.rs::MAX_SETTINGS_KEYS` | 单值是自由 JSON，**不**限单值大小：体积由 HTTP 层请求体上限兜 |
| 一次批量写入的条数 | 20000 | `crates/vmusic-store/src/limits.rs::MAX_ENTRIES_PER_BATCH` | 上面「单个歌单曲目数」同值是有意的 |
| 曲目 id 长度（字符） | 256 | `crates/vmusic-store/src/limits.rs::MAX_ID_CHARS` | 在线虚拟 id `online:<source>:<平台 id>` 要放得下 |
| 名称类字段长度（字符） | 1000 | `crates/vmusic-store/src/limits.rs::MAX_NAME_CHARS` | 标题/歌手/专辑/歌单名共用一个上限 |
| URL 字段长度（字符） | 4096 | `crates/vmusic-store/src/limits.rs::MAX_URL_CHARS` | `cover` 只该放 URL：图本身走封面缓存目录，进库就是把缓存当数据 |
| m3u 内容上限（字节） | 8388608 | `crates/vmusic-store/src/limits.rs::MAX_M3U_BYTES` | 导入的读文件循环 —— 先验长度再逐行解析 |
| HTTP 请求体上限（字节） | 6291456 | `crates/hertz-studio/src/routes.rs::MAX_BYTES` | 与上面的载荷上限相乘才是内存峰值 |
| 诊断日志单文件上限（字节） | 2097152 | `crates/hertz-studio/src/diag.rs::MAX_BYTES` | 裁剪保留最新一半；两阶段写不许退回 `File::create` |
| 诊断字段值上限（字符） | 220 | `crates/hertz-studio/src/diag.rs::MAX_VALUE_CHARS` | 上游错误消息可能整段 HTML |
| 扫描错误样本上限 | 50 | `crates/hertz-studio/src/scan.rs::MAX_ERRORS` | 进度接口的响应大小 |

## 禁止回退

- 不许把闸门挪到写入之后或「靠事务回滚兜住」。回滚只保证不留半成品，不保证你愿意为
  一次失败付出一整轮写入与锁。
- 不许给 `settings` 的单值加体积上限：那是自由 JSON（创作预设会成批量写进来），
  这一层管的是键数量爆炸那种**不是自由度**的东西。
- 不许按字节数判长度。
- 不许把 `cover` 当图片容器：4096 字符只够放 URL。
