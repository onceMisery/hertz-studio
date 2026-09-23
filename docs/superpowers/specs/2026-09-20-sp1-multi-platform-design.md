# SP1 多音乐平台对接设计（网易云 / QQ音乐 / 酷狗）

> 版本：v1.0（已评审批准）
> 日期：2026-09-20
> 状态：设计定稿，待编写实施计划
> 范围：总体路线图四个子项目中的 **SP1**。SP2 沉浸式 3D 歌单架、SP3 舞台视觉、
> SP4 统一歌单/播放控制收口各自独立立项，不在本文范围内。
> 参考项目（仅作架构与端点研究参照，不直接复制代码）：
> `D:\code\github\folia-major`（AGPL-3.0，Electron+React，Node 侧车架构）、
> `D:\code\github\Mineradio`（GPL-3.0，Three.js 视觉，含酷狗/QQ 端点实现参照）

---

## 0. 背景与已确认决策

hertz-studio（mmusic-studio）是本地优先的 Rust 单进程音乐服务：axum + SQLite，
前端为零构建原生 JS（由 `include_str!` 内嵌托管）。已有网易云音源（公开网页端点 +
用户自有 cookie 转发，仅 search/stream/detail/lyric 四个能力）、在线音频落盘缓存、
CSS 3D 歌单架与手写 WebGL2 舞台。

本子项目把在线曲库从「单一音源、只能搜索试听」升级为「网易云 / QQ音乐 / 酷狗
三平台、账号登录、我的歌单、歌单写操作、红心、聚合搜索、个性化推荐」。

| 编号 | 决策 | 取值 |
|---|---|---|
| D1 | 对接路线 | **Rust 原生直连**：在 `qq.rs`/`kugou.rs` 内原生实现端点与签名，保持单二进制、零运行时外部进程；不引入 Node 侧车 |
| D2 | 登录方式 | **二维码登录 + 手动 cookie 兜底**；新增 `/v1/online/qr/*` 系列端点 |
| D3 | 能力范围 | 用户歌单浏览、歌单写操作 + 红心、All 聚合搜索、个性化推荐，全部纳入 |
| D4 | 3D 路线 | 不影响 SP1（SP2 决策：自研栈复刻 Mineradio，不引 Three.js） |
| D5 | 交付节奏 | 四子项目逐期完整交付；SP1 先行，独立走规格→计划→实现→验收 |
| D6 | 架构形态 | **演进现有「自由函数 + 能力描述表」注册表**，不引入 trait 对象 |
| D7 | 合规边界调整 | 项目所有者授权：为对接平台实现**其客户端自身使用的请求签名算法**（酷狗 MD5 签名、QQ `zzc` 搜索签名、vkey 请求）。红线不变：**不做 DRM/加密音频解密、不做账号池/凭据共享、不绕过付费权益判定**。文档与代码注释须如实更新边界声明 |

签名实现的法律/合规说明：本项目仅在用户本机、以用户自己的账号凭据调用平台公开
端点，不分发平台内容、不做商业服务。MIT 项目代码全部为原创 Rust/JS 实现，
不复制 AGPL/GPL 参考仓库的代码文本；新增 vendored 的第三方库仅限其自身许可证
允许的 MIT 组件（qrcode-generator）。

---

## 1. 架构设计

### 1.1 后端模块布局

全部收敛在 `crates/vmusicd/src/online/` 内：

```
online/
├── mod.rs        注册表 + 能力分发 + 共享归一化类型 + 音频缓存（现有，扩展）
├── cred.rs  新增 凭据保险库：每平台一份结构化凭据包，只进不出
├── qr.rs    新增 二维码会话注册表（内存 + TTL 的通用状态机）
├── sign.rs  新增 签名工具：MD5/SHA1、参数排序拼接、QQ zzc 搜索签名
├── aggregate.rs 新增 All 聚合搜索：并发 + 单源超时 + 部分失败保留
├── netease.rs    扩展：二维码登录 / 用户歌单 / 歌单详情 / 红心 / 推荐
├── qq.rs    新增 QQ音乐全量能力
├── kugou.rs 新增 酷狗音乐全量能力
└── ccmixter.rs   不动
```

### 1.2 四个可扩展接缝

1. **能力声明表驱动一切**。`SourceInfo` 增加
   `caps: &'static [Capability]`：
   `QrLogin, CookieLogin, UserPlaylists, PlaylistDetail, PlaylistWrite,
   Like, RecommendSongs, RecommendPlaylists, PersonalFm, HighQuality`。
   前端所有入口（登录按钮、平台 chips、歌单操作菜单、推荐标签）由
   `GET /v1/online/sources` 返回的 caps 生成。某平台某能力失效，后端摘掉一个
   能力位，UI 自动隐藏。新增平台仍为「一个文件 + 注册表一行 + dispatch 分支」。

2. **凭据保险库泛化**。键 `online_cred_<source>`，值为结构化 JSON：
   `{cookie?, token?, userid?, dfid?, mid?, uin?, saved_at}`。
   - `cred.rs` 提供 `get(source) -> Option<CredPack>`、`put`、`clear`
   - 兼容旧键 `online_cookie_netease`：读取时回落，首次写入时迁移到新键
   - `is_credential()` 同时过滤 `online_cookie_` 与 `online_cred_` 前缀，
     `GET /v1/settings` 永不回显任何凭据字段
   - 非密设备身份（QQ `guid`、酷狗 `mid`/`dfid`）存普通设置键
     `online_device_<source>`

3. **结构化错误码**。新增：`auth_required`(401)、`vip_required`(403)、
   `capability_unsupported`(404)、`upstream_rejected`(502)、
   `upstream_timeout`(504)。错误体带 `source` 与现有 `request_id`。
   前端按码分流，不把所有失败弹成同一种 toast。

4. **二维码通用状态机**。`qr.rs` 不管平台差异，维护
   `{ticket, state, expires_at}`，`state ∈ waiting|scanned|confirmed|expired`，
   会话存 AppState 内存 `tokio::Mutex<HashMap<String, QrSession>>`，
   TTL 3 分钟，过期惰性清理。各平台模块实现
   `qr_start(ctx) -> QrStart` 与 `qr_poll(ctx, ticket) -> QrPoll`，
   确认时由模块自身把凭据写入 cred 保险库。

### 1.3 归一化数据模型

```rust
OnlinePlaylist {
    source: String, id: String, name: String, cover: Option<String>,
    track_count: u64, play_count: Option<u64>, creator: String,
    kind: String, // "created" | "collected" | "liked"
}
PlaylistDetail { playlist: OnlinePlaylist, total: u64, tracks: Vec<OnlineTrack> }
AccountInfo    { source, nickname, avatar: Option<String>,
                 vip_level: u32, vip_label: String }
QrStart  { ticket, qr_text: Option<String>, qr_image: Option<String>, poll_ms: u32 }
QrPoll   { state: String, account: Option<AccountInfo> }
AggregateSearch { query, results: Vec<SearchPage>,
                  failed: Vec<FailedSource> }
FailedSource { source, code, message }
```

`OnlineTrack` 在现有字段上增加：

- `vip_only: bool`（会员曲搜索阶段即可灰显）
- `ref: serde_json::Value`（平台原始引用：QQ 的 media_mid、酷狗的
  album_id/mixsongid/fileid 等；写操作与播放时原样带回。该字段仅在
  前端需要时使用，常规列表渲染忽略）

现有字段（source/id/title/artist/album/duration_ms/cover/playable）保持不变，
已消费它的前端代码不受影响。

### 1.4 HTTP API 增量

全部位于 `/v1/online/*`，沿用 Bearer 鉴权与统一错误体。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/playlists?source=&scope=created\|collected&offset=&limit=` | 我的歌单列表 |
| GET | `/playlist?source=&id=&offset=&limit=` | 歌单详情（曲目分页） |
| POST | `/playlist/create` `{source,name}` | 新建歌单 |
| DELETE | `/playlist` `{source,id}` | 删除歌单 |
| POST | `/playlist/tracks/add` `{source,id,tracks:[{id,ref?}]}` | 加歌 |
| POST | `/playlist/tracks/remove` `{source,id,tracks:[{id,ref?}]}` | 移除 |
| POST | `/like` `{source,id,liked,ref?}` | 红心/取消 |
| GET | `/recommend/songs?source=` | 每日推荐歌曲（无能力/未登录按错误码处理） |
| GET | `/recommend/playlists?source=` | 推荐歌单 |
| GET | `/search/all?q=&limit=` | All 聚合；单源 6s 超时，失败进 `failed` |
| POST | `/qr/start` `{source}` | 开始扫码会话 |
| GET | `/qr/poll?source=&ticket=` | 轮询扫码状态 |
| POST | `/qr/cancel` `{source,ticket}` | 取消会话 |
| GET | `/account?source=` | 当前账号信息 |

平台无该能力时返回 `capability_unsupported`，前端隐藏入口而非报错。

`tracks[].ref` 可选：只透传搜索/歌单结果里已有的平台原始引用。
平台模块需要额外字段（酷狗加歌要 album_id/mixsongid、删歌要 fileid）时从
ref 取，取不到时仅用 id 尝试；红心统一只需要平台曲目 id。

统一 `/stream` 与 `/play` 的 `quality` 参数仍为 bps 整数（如 320000），
到平台档位的映射（QQ filename 前缀、酷狗 quality 字符串、网易 br）在各平台
模块内部完成，API 层不暴露平台专有档位。

### 1.5 在线播放队列

现有 `/v1/online/play` 把队列硬设为单曲。扩展请求体：

```json
{ "source": "qq",
  "tracks": [ { "id": "...", "title": "...", "artist": "...",
                "album": "...", "duration_ms": 0, "cover": "...", "ref": {} } ],
  "index": 0, "quality": 320000 }
```

兼容旧的单曲字段（`id` + 元数据），后端将其包装成长度 1 的 tracks。

队列存一组 `online:<source>:<id>` 虚拟 id。修改 `state.rs` 的 `play_index`：

```
track_id 以 online: 开头？
  ├─ 缓存文件存在且 >1KB        → 直接 load（现状，零网络）
  └─ 缓存不存在/已清理           → online::stream() 取 URL
                                   → 音质回落下发
                                   → fetch_to_cache() 落盘（现有函数）
                                   → audio.load(缓存路径)
```

`play_index` 通过 `AppState.db` 构造 `online::Ctx`，外部调用签名不变。
取流失败时：WS 推 `error` 事件（含错误码与 source），播放控制自动跳到下一首；
`auth_required` 的前端文案引导去登录。缓存命名、64MB 上限、`.part` 临时文件 +
rename、120s 下载超时全部复用现有实现，不改动。

### 1.6 依赖与零构建

- workspace 新增 `md-5 = "0.10"`、`sha1 = "0.10"`（RustCrypto 纯 Rust）；
  不引 hex crate，手写 ~20 行十六进制编码
- `reqwest` 增加 `cookies` feature：网易云扫码确认依赖 `Set-Cookie`，
  使用每平台独立的 `cookie::Jar`（与凭据包一起持久化 cookie 字符串）
- 前端 vendor MIT 的 qrcode-generator 单文件到 `web/vendor/qrcode.js`
  （文件头保留其 MIT LICENSE 注释），不引入 npm 工具链
- 不新增任何前端构建步骤

---

## 2. 三平台落地细节

### 2.0 凭据与设备身份

| 平台 | 登录凭据（保险库） | 匿名设备身份（普通设置键） | 登录态判据 |
|---|---|---|---|
| netease | `cookie`（含 `MUSIC_U`、`__csrf`） | 无 | cookie 含 `MUSIC_U` |
| qq | `cookie`（含 `uin`、`qm_keyst`/`p_skey`）、`uin` | `guid`：8 位随机数字 | `uin != 0 && qm_keyst` 存在 |
| kugou | `token`、`userid`、完整 `cookie`（含 `kg_mid`） | `mid=md5(seed+毫秒ts+随机)`；`dfid` 匿名注册获取，失败回落 `"-"` | `userid != 0 && token` 非空 |

### 2.1 网易云（扩展 netease.rs）

现有 search/stream/detail/lyric 不改逻辑。新增能力均走公开网页端点 +
自有 cookie 转发，Referer `https://music.163.com`，POST 为
`application/x-www-form-urlencoded`，`csrf_token`（取自 cookie 的 `__csrf`）
同时进 query 与表单体。

| 能力 | 端点 | 要点 |
|---|---|---|
| 二维码 key | `GET /api/login/qrcode/unikey` | 返回 `{unikey}` |
| 二维码内容 | `https://music.163.com/login?codekey={unikey}` | 前端本地渲染二维码 |
| 扫码轮询 | `GET /api/login/qrcode/client/login?key=&type=1` | 801 等待 / 802 已扫 / 803 确认（Set-Cookie 给 MUSIC_U/__csrf，整罐 cookie 序列化入库）/ 800 过期 |
| 账号信息 | `GET /api/nuser/account/get` | 取 uid、昵称、头像、会员等级 |
| 用户歌单 | `GET /api/user/playlist?uid=&limit=50&offset=` | `playlist[].{id,name,coverImgUrl,trackCount,playCount,creator.nickname}` |
| 歌单详情 | `GET /api/v6/playlist/detail?id=&n=1000` | `playlist.tracks[]`（ar/al/dt）；单次最多 1000 首，超过用 `/api/v6/playlist/track/all?id=&limit=100&offset=` 补取，内部对前端仍是 offset/limit 统一分页 |
| 新建/删除 | `POST /api/playlist/create`、`/api/playlist/delete` | 表单 + csrf |
| 加歌/移歌 | `POST /api/playlist/manipulate/tracks` | `op=add\|del&pid=&trackIds=[id,id]` |
| 红心 | `POST /api/song/like` | `trackId=&like=true\|false` |
| 推荐歌单 | `GET /api/personalized/playlist?limit=20` | 免登录 |
| 每日推荐 | `GET /api/v3/discovery/recommendSongs` | 需登录 |

### 2.2 QQ音乐（新建 qq.rs）

**两类请求通道**

- 匿名/登录 CGI：`POST https://u.y.qq.com/cgi-bin/musicu.fcg`，
  body `{comm:{ct:24,cv:0}, <key>:{module,method,param}}`；
  登录时 `comm.ct=19`、`comm.authst=<qm_keyst>`、`comm.uin=<uin>`
- 搜索签名通道：`POST https://u.y.qq.com/cgi-bin/musics.fcg?sign=<sign>`，
  body comm 伪装安卓客户端
  `{ct:"11",cv:"14090508",v:"14090508",tmeAppID:"qqmusic",...}`，
  UA `QQMusic 14090508(android 12)`

**zzc 搜索签名（sign.rs 中原生实现，约 40 行）**

```
sha1 = SHA1(请求 body JSON) 的十六进制字符串（40 字符，索引按字符位置）
part1 = 取 sha1 字符位置 [23,14,6,36,16,40,7,19] 拼接
part2 = 取 sha1 字符位置 [16,1,32,12,19,27,8,5] 拼接
scramble = [89,39,179,150,218,82,58,252,177,52,186,123,120,64,242,133,
            143,161,121,179]
middle = Base64( 对 i=0..19：scramble[i] XOR parse_hex(sha1[i*2..i*2+2]) )
         结果中删除字符 '/'、'+'、'='
sign = ("zzc" + part1 + middle + part2).to_lowercase()
```

**能力映射**

| 能力 | module / method | 参数与响应路径 |
|---|---|---|
| 搜索 | `music.search.SearchCgiService / DoSearchForQQMusicMobile` | param: query/page_num/num_per_page/sin；结果 `req.data.body.item_song[]`（兼容 track_info 嵌套） |
| 详情 | `music.pf_song_detail_svr / get_song_detail_yqq` | `song_mid`；`data.track_info` |
| 播放 | `vkey.GetVkeyServer / CgiGetVkey` | 见下 |
| 我的歌单 | `music.musiclist / GetMusicList` | uin、sin/num 分页；创建单与收藏单分开取 |
| 歌单详情 | `music.musiclist / GetMusicListDetail` | disstid；`cdlist[0].songlist[]` |
| 加/删歌 | `music.musiclist / AddSongList`、`MoveSongList` | 登录 authst |
| 歌词 | `music.musichallSong.PlayLyricInfo / GetPlayLyricInfo` | songMID；`lyric` 字段 Base64 解码为 LRC |
| 推荐歌单 | `music.playlist.PlayList / GetPlaylistByLabel` 等 | 免登录推荐广场 |

注：QQ 歌单类 CGI 的 module/method 名以真机响应为准（搜索与 vkey 两条主链路
已逐行核实，把握度见 §2.4）；若某条歌单子接口在当前客户端版本被改名或拒收，
摘掉对应写能力位（PlaylistWrite），不影响读歌单与播放。

曲目稳定 id 用 `songmid`，`media_mid` 存进 `OnlineTrack.ref` 供 filename 拼接。

**播放（vkey）流程**

1. `comm={uin, ct:19|24, cv:0, authst?}`，param: `{guid, songmid:[mid],
   songtype:[0], uin, loginflag:1, platform:"20", filename:[...]}`
2. filename 按候选音质从高到低：`RS01{media}.flac`(Hi-Res)、
   `F000{media}.flac`(无损)、`M800{media}.mp3`(320k)、
   `M500{media}.mp3`(128k)、`C400{media}.m4a`(AAC)
3. 响应 `data.midurlinfo[].purl` 与 `data.sip[]`，URL = `sip[0] + purl`
4. 决策：匿名 128k 通常可播；purl 全空且无登录 → `auth_required`；
   登录仍空且为付费曲 → `vip_required`
5. 不做 HTTP 探活：直接返回首个非空 purl，落盘下载失败时按候选顺序降一档
   重试（最多 5 档），全部失败才报错

**二维码登录（最高风险项）**

走 QQ 账号体系公开网页流：

1. `GET https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&
   d=72&v=4&t=<rand>`：返回 PNG（作为 qr_image 转 data URL），同时种
   `qrsig` cookie
2. `ptqrtoken = gtk33(qrsig)`：自定义哈希（基值 0，逐字符
   `h += (h<<5) + charCode`，最后 `& 2147483647`）
3. 轮询 `GET https://ssl.ptlogin2.qq.com/ptqrlogin?...&ptqrtoken=&...`：
   66 未扫 / 67 已扫未确认 / 0 成功（响应文本含跳转 URL 与昵称）
4. 成功后访问返回 URL 完成 `check_sig` 种票，换出 `uin`、`qm_keyst` 等
   cookie 入库；再调 musicu 账号 CGI 补会员信息
5. 真机验证不通过（风控/改版）时：摘掉 QQ 的 `QrLogin` 能力位，
   `/sources` 不再返回扫码入口，保留手动 cookie，不阻塞其他能力

### 2.3 酷狗（新建 kugou.rs）

**签名常量与算法（sign.rs）**

```
ANDROID_SALT = "OIlwieks28dk2k092lksi2UIkp"   // appid=1005, clientver=20489
H5_SALT      = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt" // srcappid=2919,
                                                  // clientver=20000, appid=1014
SIGN_KEY_SALT = "57ae12eb6890223e355ccfcb74edf70d"

android_sign(params, body):
  s = 按键名排序后 "k=v" 直接拼接（无分隔符，对象值 JSON 序列化）
  md5(ANDROID_SALT + s + body + ANDROID_SALT)
h5_sign(params, body_obj):
  s = 按键名排序后 "k=v" 直接拼接（body_obj 存在则追加 JSON.stringify）
  md5(H5_SALT + s + H5_SALT)
play_key(hash, mid, userid, appid=1014):
  md5(lower(hash) + SIGN_KEY_SALT + appid + mid + userid)
mobile_key(hash): md5(hash + "kgcloud")
公共参数: dfid, mid, uuid, appid, clientver, clienttime(秒级), token, userid
```

**能力映射**

| 能力 | 端点 | 鉴权 | 关键字段 |
|---|---|---|---|
| 搜索 | `https://songsearch.kugou.com/song_search_v2` | 匿名（带 kg_mid cookie） | keyword/page/pagesize/appid=1014/mid/token/userid=-1/platform=WebFilter/tag=em/filter=2；结果 `data.lists[].{FileHash,SongName,SingerName,AlbumID,MixSongID,Privilege,Duration}`；成功条件 `status==1` |
| 播放①移动 | `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=&key=mobile_key(hash)&album_id=&pid=1&vip=65530` | 匿名 128k | status==1 时取播放 URL |
| 播放②Web | `https://wwwapi.kugou.com/play/songinfo`（失败重试 wwwapiretry 域） | H5 签名 | data.bitrate 判音质 |
| 播放③网关 | `https://gateway.kugou.com/v5/url`，头 `x-router: trackercdn.kugou.com` | 登录 + play_key + H5 签名 | quality 参数取 320/flac |
| 歌词搜索 | `https://krcs.kugou.com/search?hash=&keyword=&duration=&album_audio_id=` | 匿名 | candidates[0].{id,accesskey} |
| 歌词下载 | `https://krcs.kugou.com/download?id=&accesskey=&fmt=lrc&charset=utf8` | 匿名 | content Base64 解码即 LRC；只取 lrc，不实现 krc 解密 |
| 我的歌单 | gateway.kugou.com 歌单列表（H5 签名 + x-router） | 登录 | 列表项 global_collection_id/specialid/listid、name、封面、track_count；红心歌单按名称识别（我喜欢/我的收藏） |
| 歌单歌曲 | `/playlist/track/all`（global_collection_id）或新版按 listid | 登录 | page/pagesize 分页 |
| 新建/收藏 | 网关 playlist add（name、list_create_userid、list_create_listid、type=0/1） | 登录 | — |
| 删除 | 网关 playlist del（listid） | 登录 | — |
| 加歌 | 网关 tracks add：data=`歌名\|hash\|album_id\|mixsongid`，多首逗号分隔 | 登录 | — |
| 删歌 | 网关 tracks del：fileids 逗号分隔 | 登录 | fileid 从歌单曲目 ref 取 |
| 每日推荐 | `/everyday/recommend` | 登录 | — |
| 歌单推荐 | `/top/card?card_id=1` 等 | 免登录 | — |

id 用 `FileHash`；`album_id`、`mixsongid`、`fileid` 存进 `OnlineTrack.ref`。
`global_collection_id` 形如 `collection_3_{uid}_{listid}_0`，
纯数字 listid 可直接使用；两种形态都支持。

**设备初始化**：首次使用生成 mid 并匿名注册取 dfid；失败 dfid 用 `"-"`。
搜索与移动版播放不依赖 dfid，零登录即可搜索与 128k 播放。

**二维码登录（高风险项）**

1. `https://qrcode1.kugou.com/v2/get_qr_code?appid=1014&clientver=20000&...`
   取二维码串/图片
2. 轮询 `https://www.kugou.com/app/get_qr_state.php?qrCode=...`
3. 成功回 token/userid，入库后调 user/detail 补昵称头像
4. 真机验证不通过：摘掉酷狗 `QrLogin` 能力位，手动 cookie
   （含 token、userid、kg_mid）通道兜底

### 2.4 风险分级与降级

| 链路 | 把握度 | 依据 | 失败处置 |
|---|---|---|---|
| 网易云全部能力 | 高 | 公开网页端点，生态长期验证，现有代码已通 | 报错重试 |
| 酷狗搜索/移动播放/歌词（匿名） | 高 | 盐值算法逐行核实 | 502 + 行内重试 |
| QQ 搜索/详情/vkey | 中高 | zzc 签名与 vkey 实现完整可核，风险在 comm 参数版本漂移 | 版本头更新；降级匿名通道 |
| 酷狗网关签名能力 | 中高 | 算法明确，x-router 路径需真机对一次 | 摘对应写能力位 |
| QQ/酷狗扫码登录 | 中 | 参考仓库无完整原生实现 | 摘 QrLogin 位，cookie 兜底，不阻塞发布 |

统一原则：**能力失败绝不伪造空成功**。接口不通返回结构化错误码或摘能力位；
每个平台每个能力在实现时必须过真机「登录→拉歌单→取 URL→落盘→出声」闭环
后才标记完成。连续风控（单源连续 N=5 次 502/超时）触发该源 60s 熔断，
熔断期快速失败，避免反复请求上游。

### 2.5 字段归一化

- id：网易 `id`；QQ `songmid`（ref 存 media_mid）；酷狗 `FileHash`
  （ref 存 album_id/mixsongid/fileid）
- 时长统一毫秒：QQ 秒 ×1000；酷狗 Duration ×1000；网易原已是毫秒
- 歌手：QQ `singer[].name` 顿号连接；酷狗 `SingerName`/`Singers`；
  网易 `artists[].name`
- 封面：一律 `https_url` 升级
- VIP 标记：酷狗 `Privilege` 位；QQ vkey 付费位；网易 stream 空 url
- HTML 实体/`%uXXXX` 脏文本（酷狗歌名）解码后再展示

---

## 3. 前端设计

### 3.1 文件布局

```
web/
├── vendor/qrcode.js       MIT qrcode-generator 单文件（含许可头）
├── online.js         新增 在线域：API 封装、All 聚合渲染、平台徽标、播放入队
├── online-playlists.js 新增 在线歌单视图：账号卡、歌单网格、详情抽屉、写操作
├── online-login.js   新增 扫码弹窗状态机 + 手动 cookie 兜底 + 账号卡
└── style.css（末尾追加在线域样式；如超 400 行则拆 online.css 并接线）
```

三个 JS 均为 IIFE + `'use strict'`，只经 `window.VMusicTransport` 发请求，
不持第二份 token 逻辑，不新增 requestAnimationFrame。现有内联在 app.js
（约 1828–2050 行）的在线搜索/播放/歌词代码迁入 online.js，app.js 仅保留
transport 暴露与视图切换。新文件在 index.html 中按
`online-login → online → online-playlists → app.js` 顺序加载，
并同步进 main.rs 的 `include_str!` 与路由表（check-assets.js 强制对账）。

### 3.2 UI 与交互

**在线曲库视图（扩展 #view-online）**

- 来源 chips 由 sources + caps 驱动；可用源 ≥2 时最前固定 All
- 单源保持现有列表；All 调 `/search/all`，结果按平台分组，
  组头带来源色点，`failed` 中的源显示行内重试条
- 每行：平台徽标、播放按钮、「⋯」菜单（红心/加入歌单/复制歌名，
  按 Like/PlaylistWrite caps 显隐）
- `vip_only` 行置灰加 VIP 角标，点击给明确提示

**在线歌单视图（两级）**

- 一级：平台账号卡（未登录：扫码/cookie 两个入口；已登录：头像、昵称、
  VIP 标签、刷新、退出）+ 歌单网格（封面、名称、`NN 首 · 播放 NN`、
  红心歌单置顶）；滚动到底分页加载（30/页）
- 二级：歌单详情抽屉（右侧滑出），曲目复用现有 `.track` 行栅格，
  底部「播放全部」「随机播放」，有 PlaylistWrite 时每行可移除

**扫码弹窗状态机**

```
start → 渲染二维码（qr_image 直接 <img>；qr_text 本地生成）
      → 每 poll_ms 轮询：
          waiting  提示等待扫码
          scanned  提示手机确认
          confirmed 关闭弹窗、刷新账号卡与歌单
          expired  二维码置灰 + 点击重新 start
      → 关闭/取消：清定时器 + POST /qr/cancel
```

切源或关弹窗必须停轮询，不残留请求。手动 cookie 入口常驻弹窗次要位置。

**播放入队**：「播放全部」把整盘 tracks + index 一次 POST 给
`/v1/online/play`，用返回虚拟 id 填充现有队列；上/下首、随机、单曲循环
全部走现有控件。onlineMeta 由单曲 Map 扩展为整盘元数据缓存，
封面/歌词的异步补齐沿用现有逻辑。

### 3.3 错误处理

前端按错误码分流：401 打开对应平台登录弹窗；403 灰显 VIP；
404 隐藏入口；502/504 行内重试条 + toast。不展示英文堆栈。

---

## 4. 测试与验收（分层取证）

任一层未闭合不得外推到更高层；「编译通过/脚本全绿」不等于「平台可用」。

### 4.1 第一层：Rust 单元/集成（CI，离线）

- 签名纯函数：酷狗三套签名、QQ zzc、mobile_key 的固定输入向量
  （确定性、长度、前缀、字符剔除规则）
- 归一化：三平台录制响应 JSON 夹具放 `crates/vmusicd/tests/fixtures/`，
  断言字段映射、时长单位、VIP 位、缺字段不 panic
- cred 保险库：写入后 settings 不回显、旧 cookie 键迁移、清除
- 能力表契约：caps 与 dispatch 同步（扩展现有
  `every_source_is_dispatchable_and_described`）
- 聚合搜索：注入假源验证 6s 超时收敛、部分失败保留、结果顺序
- 在线队列：NullBackend + 可注入的取流函数，验证
  「缓存缺失→取流→落盘→load」与取流失败跳曲
- `cargo test --workspace`、`cargo clippy -- -D warnings`、`cargo fmt --check`

### 4.2 第二层：前端零依赖契约脚本（CI）

- 扩展 `scripts/check-assets.js`：三个新 JS + vendor/qrcode.js +
  可选 online.css 的 include/路由/index.html 三方对账
- 新增 `scripts/check-online.js`（仿 check-creative.js，假 transport +
  可控时钟）：扫码四态全路径、关弹窗停轮询、All 分组渲染、
  错误码→UI 行为映射、caps 驱动菜单显隐
- `scripts/check-css-tokens.js` 保持通过；ci.yml 增加 check-online.js

### 4.3 第三层：真机端到端验收（人工，逐平台勾选）

新增 `scripts/smoke-online.ps1`（Windows + curl），按层验证：

1. 进程层：`cargo run --release -- --port 0` 启动，discovery 含端口/token
2. 协议层：`/v1/health` 200；`/v1/online/sources` 列三源且 caps 正确
3. 业务层（每平台）：
   - 匿名搜索返回结果；stream URL curl 下载前 64KB 校验音频魔数
     （ID3 / ftyp / fLaC）
   - 真实手机扫码登录；/account 返回昵称
   - 拉取真实歌单列表与详情
   - UI「播放全部」实际出声，上/下首正常
   - 红心/加歌在手机官方 App 中可见变更
4. QQ/酷狗扫码不通时按预案摘 QrLogin 能力位，cookie 通道补验，记录结论

---

## 5. SP1 完成定义（DoD）

1. 三平台匿名：搜索 + 实际出声播放 + 歌词（至少 128k）
2. 三平台登录后：账号信息、我的歌单、歌单详情、整盘播放、上下首、
   VIP 曲正确灰显
3. 网易云写操作全部真机可用；QQ/酷狗写操作真机验证，不通过则摘能力位
4. All 聚合搜索与推荐入口按 caps 正确显隐
5. cargo test / clippy / fmt 与 check-assets / check-online /
   check-css-tokens 全绿
6. 真机验收表逐平台勾选（QQ/酷狗扫码按预案处理并记录）
7. README「在线音源的边界」与 online/mod.rs 模块注释更新：
   如实说明已实现平台客户端签名（D7），并重申不做 DRM 解密、
   不做账号池两条红线；NOTICE 记录 qrcode-generator 的 MIT 署名

---

## 6. 非目标（明确不做）

- 不做 DRM/CENC/加密容器解密（酷狗 krc 逐字歌词、加密音频均不碰）
- 不做账号池、凭据共享、会员权益模拟
- 不做在线音源与本地歌单的跨源合并（归 SP4）
- 不做播放预取/无缝衔接（归 SP4）
- 不做 3D 歌单架改造（归 SP2）
- 不引入 Node 侧车、Electron、npm 构建链
