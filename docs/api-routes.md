# REST 路由清单

面向接口的参考清单，README 不收录这些内容。改了 `crates/hertz-studio/src/routes.rs`
或 `crates/hertz-studio/src/main.rs` 之后重跑生成器：

```bash
node scripts/api-routes.js          # 写回下面的生成块
node scripts/api-routes.js --check  # 只校验，不一致则退出码 1（CI 跑这一条）
```

<!-- api-routes:begin -->
<!-- 由 `node scripts/api-routes.js` 生成，勿手改；`--check` 会校验是否与源码一致。 -->

REST 路由表共 161 个「方法 + 路径」（`crates/hertz-studio/src/routes.rs` 的 130 条 `.route()`），另有 `main.rs` 挂的 6 条路由与 130 条内嵌静态资源路由。

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

`main.rs` 上另有：GET `/ws`，GET `/wallpapers/{name}`，GET `/platform-icons/{name}`，GET `/space-scene-preview/{name}`，GET `/`，POST `/v1/auth/session`。

<!-- api-routes:end -->

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
