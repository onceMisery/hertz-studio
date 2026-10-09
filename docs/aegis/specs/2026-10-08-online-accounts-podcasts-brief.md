# 在线账号与中文点播播客

用户要求修复汽水抖音扫码“无法访问页面”、补齐咪咕接入，并已选择首批中文点播播客：搜索节目、查看单集、导入公开 RSS。2026-10-08 的“goon”继续这一范围。

## 实测与方案

- 汽水 Passport 返回的 PNG 包含 `/ucenter_web/app/sdk-next`，该地址实测 404。手机授权入口是 `/light/invoke/scan_login`，必须从同次 Passport 票生成二维码，保持现有服务端握手票和凭据归属。普通浏览器访问该手机入口会跳转 `scan_error.html`，不能用最终 HTTP 200 证明手机授权成功；真实抖音确认仍需本人验收。
- 咪咕旧 `y.migu.cn` 已下线。官方 v5 SDK 使用 cookie 中 `pacmtoken` 作为同名请求头调用账号接口；匿名/无效票实测 290001。公开歌单详情和分页歌曲接口实测成功。实现 Cookie 登录与账号验证、歌单详情；不展示未实现的扫码登录，不伪造歌曲可播或会员权益。
- 播客采用 Apple 公开中文目录 + 发布者 RSS。相比仅手工 RSS，增加节目发现；相比直接接各平台私有 API，公开 RSS 可复用已实测的小宇宙托管、故事FM、Fireside 与喜马拉雅公开播客分发。直播电台另需无限流语义，本轮不纳入。

## 界面与 API

一级“播客”栏目含节目搜索、我的订阅、RSS 导入，节目详情含封面、作者、简介、单集日期/时长和播放操作。按需加载、分页单集，搜索与切换节目防止迟到响应覆盖当前页面。沿用主题 token 和皮肤布局，不增加前端构建。描述用纯文本呈现。

- `GET /v1/podcasts/search?q=...&limit=20` → `{shows, query}`，Apple country=CN，只对明确提交查询请求，不假装支持目录 offset。
- `GET /v1/podcasts/feed?url=...&offset=0&limit=50&refresh=false` → `{show, episodes, total, episode_limit}`。上限由后端同一常量输出，到达时界面提示容量边界。Episode 直接包含 OnlineTrack 字段，另有 `published_at` 和 `description`。
- `GET /v1/podcasts/subscriptions` → `{shows}`。
- `POST /v1/podcasts/subscriptions`，`{feed_url}` → `{show}`，验证并保存 RSS。
- `DELETE /v1/podcasts/subscriptions/{id}` → `{ok:true}`，取消订阅不删除用于历史/歌单重播的单集映射。

Show 字段：`id,title,author,description,cover,feed_url,episode_count,subscribed`。Episode 的 source 固定 `podcast`，稳定 ID 由 feed 身份与 GUID 派生，GUID 缺失时使用 enclosure 身份。映射保存 SQLite，重启后仅凭队列 ID 可取详情与播放，不依赖被播放请求忽略的前端 ref。

## 归属和边界

`podcasts.rs` 负责目录、RSS、订阅和单集映射；Provider 注册 `podcast` 的详情/取流/空歌词，媒体种类由注册表描述，音乐搜索不混入节目。既有 AppState/Online.playAll 继续独占队列与播放，沿用 20 秒取流、512 MiB 单集预算和既有渐进下载。未知码率为 None，不以 RSS length 推断音质。

RSS 独立读取预算 16 MiB，限制解析节点/单集数及描述长度，不放大通用 JSON 的 2 MiB 限制。HTTP(S) 地址、凭据、重定向和非公网地址在网络边界验证。搜索缓存有界，节目有刷新 TTL。SQLite 更新原子化，不以失败刷新覆盖已有有效数据。
`public_net` 统一持有 RSS/音频/封面的公网 URL、实际 DNS 与逐跳重定向策略；封面维持仅 HTTPS，逐块读取 6 MiB。单集取流的可选 RSS 刷新最多占用共同 20 秒期限中的 3 秒；节目及分页单集从同一数据库读事务返回。界面已确认订阅写入具有独立版本，旧节目响应不能回滚它。

基线为 README、extension-guide、ADR-0001/0007/0009。ArchitectureReviewRequired: yes。不修改治理文件、用户凭据、既有音乐源 ID、HTTP/RPC 信封。旧汽水 PNG 路径退出主链路；咪咕占位能力按实际实现替换；不会新建第二播放器。

## 验收

汽水二维码解码为当前手机入口且 token 正确编码、旧 PNG 不显示；咪咕 Cookie 源无需申请二维码、无效票如实为未登录、歌单可分页；RSS 中文/CDATA/命名空间、三类时长、无音频条目、恶意/过大输入、稳定 ID 和持久重播覆盖。HTTP 与 DBX 路由同构，真实 Chrome 检查栏目搜索/订阅/单集/播放与窄屏。真实网络用中文目录和多个已核验 RSS；Null 只验证路由和队列，解码必须另用音量为零的原生后端或解码器验证。人工听音与本人账号确认分开记录。
