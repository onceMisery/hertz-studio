# REST 路由清单

面向接口的参考清单，README 不收录这些内容。改了 `crates/hertz-studio/src/routes.rs`
或 `crates/hertz-studio/src/main.rs` 之后重跑生成器：

```bash
node scripts/api-routes.js          # 写回下面的生成块
node scripts/api-routes.js --check  # 只校验，不一致则退出码 1（CI 跑这一条）
```

<!-- api-routes:begin -->
<!-- 由 `node scripts/api-routes.js` 生成，勿手改；`--check` 会校验是否与源码一致。 -->

REST 路由表共 178 个「方法 + 路径」（`crates/hertz-studio/src/routes.rs` 的 146 条 `.route()`），另有 `main.rs` 挂的 6 条路由与 135 条内嵌静态资源路由。

| 方法 | 路径 |
| --- | --- |
| POST | `/v1/ai/budget-guard/reset` |
| POST | `/v1/ai/capabilities/call` |
| GET | `/v1/ai/capabilities/context` |
| POST | `/v1/ai/evaluation/case` |
| GET | `/v1/ai/evaluation/status` |
| GET | `/v1/ai/grants` |
| POST | `/v1/ai/grants` |
| DELETE | `/v1/ai/grants/{grantId}` |
| POST | `/v1/ai/grants/{grantId}/rotate` |
| GET | `/v1/ai/jobs` |
| POST | `/v1/ai/jobs` |
| GET | `/v1/ai/jobs/{jobId}` |
| POST | `/v1/ai/jobs/{jobId}/cancel` |
| GET | `/v1/ai/ledger` |
| POST | `/v1/ai/lyrics/emotion` |
| GET | `/v1/ai/lyrics/emotion/locks` |
| PUT | `/v1/ai/lyrics/emotion/locks` |
| DELETE | `/v1/ai/lyrics/emotion/locks` |
| GET | `/v1/ai/lyrics/emotion/status` |
| GET | `/v1/ai/proposals/{proposalId}` |
| POST | `/v1/ai/proposals/{proposalId}/reject` |
| GET | `/v1/ai/provider-credential` |
| PUT | `/v1/ai/provider-credential` |
| DELETE | `/v1/ai/provider-credential` |
| GET | `/v1/ai/status` |
| GET | `/v1/auth/overlay-key` |
| POST | `/v1/auth/ticket` |
| GET | `/v1/backup` |
| POST | `/v1/backup/restore` |
| GET | `/v1/desktop-lyrics/document` |
| GET | `/v1/desktop-lyrics/snapshot` |
| POST | `/v1/desktop/control` |
| POST | `/v1/desktop/lyrics/control` |
| POST | `/v1/desktop/lyrics/launch` |
| POST | `/v1/desktop/wallpaper/launch` |
| GET | `/v1/devices` |
| POST | `/v1/devices/select` |
| GET | `/v1/diagnostics` |
| POST | `/v1/diagnostics` |
| GET | `/v1/diagnostics/log` |
| DELETE | `/v1/diagnostics/log` |
| GET | `/v1/favorites` |
| POST | `/v1/favorites` |
| POST | `/v1/favorites/membership` |
| POST | `/v1/favorites/toggle` |
| DELETE | `/v1/favorites/{id}` |
| GET | `/v1/health` |
| GET | `/v1/history` |
| DELETE | `/v1/history` |
| DELETE | `/v1/history/{id}` |
| GET | `/v1/home/quote` |
| GET | `/v1/library/roots` |
| POST | `/v1/library/roots` |
| PUT | `/v1/library/roots` |
| DELETE | `/v1/library/roots` |
| POST | `/v1/library/scan` |
| POST | `/v1/library/scan/cancel` |
| GET | `/v1/library/status` |
| GET | `/v1/online/account` |
| GET | `/v1/online/album` |
| GET | `/v1/online/albums/search` |
| GET | `/v1/online/artist` |
| GET | `/v1/online/artists/search` |
| GET | `/v1/online/cache` |
| POST | `/v1/online/cache/clear` |
| POST | `/v1/online/cache/keep` |
| POST | `/v1/online/cache/limit` |
| POST | `/v1/online/collection/refresh` |
| POST | `/v1/online/cookie` |
| GET | `/v1/online/cover` |
| GET | `/v1/online/detail` |
| POST | `/v1/online/like` |
| GET | `/v1/online/lyric` |
| POST | `/v1/online/play` |
| GET | `/v1/online/playlist` |
| POST | `/v1/online/playlist` |
| DELETE | `/v1/online/playlist` |
| POST | `/v1/online/playlist/tracks/add` |
| POST | `/v1/online/playlist/tracks/remove` |
| GET | `/v1/online/playlists` |
| GET | `/v1/online/playlists/search` |
| POST | `/v1/online/qr/cancel` |
| GET | `/v1/online/qr/poll` |
| POST | `/v1/online/qr/start` |
| GET | `/v1/online/quality` |
| POST | `/v1/online/quality` |
| GET | `/v1/online/radio` |
| POST | `/v1/online/radio` |
| GET | `/v1/online/recommend/playlists` |
| GET | `/v1/online/recommend/songs` |
| GET | `/v1/online/search` |
| GET | `/v1/online/search/all` |
| GET | `/v1/online/sources` |
| GET | `/v1/online/stream` |
| GET | `/v1/overlay/lyric` |
| POST | `/v1/player/depart` |
| GET | `/v1/player/dsp` |
| POST | `/v1/player/dsp` |
| POST | `/v1/player/load` |
| POST | `/v1/player/mode` |
| POST | `/v1/player/next` |
| POST | `/v1/player/pause` |
| POST | `/v1/player/play` |
| POST | `/v1/player/previous` |
| GET | `/v1/player/queue` |
| PUT | `/v1/player/queue` |
| POST | `/v1/player/replay` |
| POST | `/v1/player/seek` |
| POST | `/v1/player/stop` |
| POST | `/v1/player/volume` |
| GET | `/v1/playlists` |
| POST | `/v1/playlists` |
| POST | `/v1/playlists/import-m3u` |
| GET | `/v1/playlists/{id}` |
| PUT | `/v1/playlists/{id}` |
| DELETE | `/v1/playlists/{id}` |
| GET | `/v1/playlists/{id}/m3u` |
| GET | `/v1/playlists/{id}/tracks` |
| POST | `/v1/playlists/{id}/tracks` |
| PUT | `/v1/playlists/{id}/tracks/order` |
| DELETE | `/v1/playlists/{id}/tracks/{track_id}` |
| GET | `/v1/podcasts/feed` |
| POST | `/v1/podcasts/progress` |
| GET | `/v1/podcasts/search` |
| GET | `/v1/podcasts/subscriptions` |
| POST | `/v1/podcasts/subscriptions` |
| DELETE | `/v1/podcasts/subscriptions/{id}` |
| GET | `/v1/reader/entries` |
| GET | `/v1/reader/entries/{id}` |
| GET | `/v1/reader/entries/{id}/images/{key}` |
| PUT | `/v1/reader/entries/{id}/state` |
| DELETE | `/v1/reader/feeds/{id}` |
| POST | `/v1/reader/feeds/{id}/refresh` |
| POST | `/v1/reader/preview` |
| GET | `/v1/reader/subscriptions` |
| POST | `/v1/reader/subscriptions` |
| DELETE | `/v1/reader/subscriptions/{id}` |
| GET | `/v1/recommend/daily` |
| GET | `/v1/recommend/daily/online` |
| GET | `/v1/remote/roots` |
| POST | `/v1/remote/roots` |
| DELETE | `/v1/remote/roots/{id}` |
| GET | `/v1/remote/roots/{id}/browse` |
| POST | `/v1/remote/roots/{id}/import` |
| GET | `/v1/room` |
| POST | `/v1/room` |
| GET | `/v1/settings` |
| PUT | `/v1/settings` |
| GET | `/v1/stage/beatmap` |
| POST | `/v1/stage/beatmap/retry` |
| GET | `/v1/stage/beatmap/status` |
| POST | `/v1/stage/pitch` |
| POST | `/v1/stage/project-media` |
| GET | `/v1/state` |
| POST | `/v1/system/shutdown` |
| GET | `/v1/tracks` |
| POST | `/v1/tracks/batch-delete` |
| POST | `/v1/tracks/batch-edit` |
| POST | `/v1/tracks/complete/apply` |
| POST | `/v1/tracks/complete/suggest` |
| GET | `/v1/tracks/facets` |
| GET | `/v1/tracks/ids` |
| GET | `/v1/tracks/missing` |
| GET | `/v1/tracks/{id}` |
| GET | `/v1/tracks/{id}/cover` |
| POST | `/v1/tracks/{id}/cover` |
| GET | `/v1/tracks/{id}/edit` |
| DELETE | `/v1/tracks/{id}/edit` |
| GET | `/v1/tracks/{id}/lyrics` |
| PUT | `/v1/tracks/{id}/lyrics` |
| DELETE | `/v1/tracks/{id}/lyrics` |
| POST | `/v1/tracks/{id}/lyrics/candidates` |
| POST | `/v1/tracks/{id}/lyrics/candidates/apply` |
| POST | `/v1/tracks/{id}/lyrics/candidates/prepare-online` |
| POST | `/v1/tracks/{id}/lyrics/candidates/search` |
| PUT | `/v1/tracks/{id}/lyrics/offset` |
| POST | `/v1/ui/notice` |
| GET | `/v1/wallpaper/snapshot` |

`main.rs` 上另有：GET `/ws`，GET `/wallpapers/{name}`，GET `/platform-icons/{name}`，GET `/space-scene-preview/{name}`，GET `/`，POST `/v1/auth/session`。

<!-- api-routes:end -->

## 房间队列与退出合同

本机 `POST /v1/room` 与插件 RPC 共用同一房间应用合同；LAN 受限通道使用线协议 **v3**，握手与 PCM 拒绝 v1/v2。邀请链接的 `hertz-listen:v1:` 是独立封装版本。

替换队列时使用 `{"action":"peer","request":{"action":"queue","operation_id":"7","expected_revision":"12","items":[{"instance_id":"31","resource_id":"<UUID>"},{"instance_id":null,"resource_id":"<UUID>"}]}}`。从 `queue_page` 读取的保留项必须原样携带 `instance_id` 与 `resource_id`；新增项显式传 `instance_id: null`，由 Host 分配新身份。相同资源可以出现多次，各有不同实例。重复使用实例、实例与资源不符、已删除或其它房间的实例会返回 `room_invalid`；过期 revision 返回 `revision_conflict`。拒绝时不改变队列或 revision。旧 `resources: [UUID]` 合同不再接受，调用方不能自行猜测重复项身份。

播控、队列等写请求不自动重试。未知播控结果使用原 `operation_id` 查询 `{"action":"peer","request":{"action":"operation","operation_id":"7"}}`。投影包含本机成员的 `member_id`；同一 `(room_id, instance_id, member_id)` 在新 `session_id` 上仍查询原操作，换房或成员后不沿用。

队列投票使用 `peer.vote {operation_id, expected_revision, instance_id, voted}`，房主排序使用 `peer.queue_order {operation_id, expected_revision, mode: "manual" | "votes"}`。条目投影的点歌人、票数和 `voted_by_me` 是只读信息；替换队列时仅提交 `instance_id/resource_id`。排序只改变可变未来后缀，保留当前播放和已冻结前缀。

歌曲聊天使用 `peer.chat_song {operation_id, resource_id}`，与 `chat_send` 共用独立聊天操作命名空间。分配序号从 `peer.chat_history.next_operation_id` 取得下界，并保持本机单调递增；控制序号从 `peer.snapshot.next_operation_id` 取得。歌曲卡片的元数据按当前分享权限解析，撤销后 `song: null`，不得缓存旧投影继续提供操作。

## 房间歌曲的个人收藏

`SharedTrack.favorite_key` 为可选的 64 位十六进制稳定引用，由持久房主身份的独立派生密钥生成；它不包含路径、本地库主键或读取授权。当前 `resource_id` 仍是会话分享资源，不能作为长期收藏键。房主本机快照的 `favorite_local_ids` 将稳定引用映射到原本地库 ID，仅供本机复用 local 收藏；该映射不进入任何 LAN peer 快照。接收端本机快照的 `fingerprint` 取自原生连接固定的证书身份，不能信任远端自行声明的来源。

个人收藏仍使用 `/v1/favorites` 存储与权限边界，接收端写 `kind: "track", source: "lan", ref_id: "<64位房主指纹>:<64位favorite_key>"`。不保存临时封面 URL；已获准的文字快照可保留到用户取消收藏。`/v1/favorites/toggle` 显式传 `favorited: true | false` 表示目标态，重复提交相同目标不会反转。写结果未知时只显示待确认，刷新 membership 后再决定下一动作。

从收藏点歌先调用 `peer.resolve_favorites {keys: ["<favorite_key>"]}`，单次 1–32 个引用，需当前队列权限。限制与共享分页对齐，使长元数据响应仍在单条传输预算内。只返回当前仍共享的 `tracks` 及分享 `revision`；不存在／撤销分享的引用不会返回歌曲。前端先核对当前房主指纹，再通过现有队列写命令加入当前资源；收藏本身不授权读取或播控。此请求是 wire v3 的增量只读能力；缺少 `favorite_key` 的旧投影不开放收藏入口，不改变 PCM 或既有请求语义。

## 房间发现、申请与邀请

`create.discoverable` 默认 `true`；房主 `discoverable {enabled}` 控制 mDNS 发布生命周期。快照的 `discoverable` 是配置意图，`discovery_available` 是当前发布状态，两者不能混为一谈。关闭发布仍可用已核验的地址和邀请加入。

公开的八位 `admission.room_code` 仅用于查找和申请。申请端调用 `apply {address, fingerprint, room_id, room_code, name}`，取得 `application_id/applicant_secret`；查询使用 `admission_status {address, fingerprint, room_id, application_id, applicant_secret}`。原生服务固定证书指纹，申请凭据只保留在页面控制器内存，不写浏览器存储、URL或日志。批准前没有成员身份、PCM、控制、聊天或资源读取权。

房主 `admission_review {application_id, approve, permissions}` 批准或拒绝，`admission_revoke {application_id}` 撤销尚未消费的批准。状态可为 `pending/rejected/approved/consumed`；`approved` 仅向持有申请秘密的查询返回一次性邀请，`consumed` 返回实际 `member_id`。批准重新给予五分钟消费窗口，不能用最初申请的本地倒计时删除已批准记录。查询失败不代表批准被撤销；加入结果不确定时先查状态，禁止自动重放 Join。已消费申请应在成员管理中移除成员，审批撤销不能替代成员撤权。

直接邀请返回无秘密的 `invitation_id`，房主或签发成员可用 `revoke_invitation {invitation_id}` 撤销未消费邀请。邀请消费与成员权限是独立生命周期。成员须持有 `permissions.invite` 才可签发，且只能授予自己当前的基础收听、读聊与发言权限；不能转授队列、播控、房间音量或邀请权。房主快照的邀请列表不包含邀请秘密。

`POST /v1/system/shutdown` 先返回退出受理，再启动与 Ctrl-C 相同的关闭流程：阻止新 Create/Join/Resume，取消尚未完成的房间启动，等待 Host End、输出租约和模式恢复，再停 audio actor 并删除发现文件。嵌入宿主使用公开的 `AppState::shutdown().await` 等待同一屏障。Guest 服务退出保留最近房间凭据，显式离开或 Host End 会清除凭据。

## 播客目录搜索

`GET /v1/podcasts/search?q=Planet%20Money&country=US&limit=30` 搜索指定地区的
Apple Podcasts 节目目录。`country` 可省略，默认 `CN`；支持 `CN`、`US`、`GB`、
`CA`、`AU`、`DE`、`FR`、`JP`、`KR`、`HK`、`TW`、`SG`，忽略大小写及首尾空格。
不支持的地区返回 400。`limit` 默认 30，范围 1–50。缓存按地区、关键词和数量隔离，
HTTP 与 DBX RPC 使用同一参数与结果。目录地区不是节目语言筛选，也不保证 RSS
或音频在用户网络下可访问；订阅和单集身份不随搜索地区变化。

## 在线搜索分页

`GET /v1/online/search` 的 `tracks` 是归一化后的结果，Jamendo 与 ccMixter 另外返回
可选的 `pagination: { next_offset, has_more }`。过滤无效文件或曲目后，`tracks.length`
可能小于实际消耗的上游条数，调用方应按 `next_offset` 请求下一页，并以 `has_more`
判断结束。没有该字段的音源保持原有分页方式；HTTP 与插件 RPC 使用同一响应结构。

开放曲库的曲目 `ref` 可包含 `license_url`、`license_name`、`webpage_url`，缺失字段
不代表无版权。Jamendo 应用 ID 使用现有 `PUT /v1/settings` 的 `jamendo_client_id`
键配置，空字符串停用；音源清单在下次读取时反映配置变化。
