# 酷我 / Jamendo 接入验证证据（2026-09-27）

环境：Windows + curl / Node 22（fetch），直连公网。参考实现：ZxwyWebSite/lx-source（Go，DES + f=web）、qyhqiu/kuwoMusicApi（www API）。

## 1. 搜索通道裁决

| 端点 | 结果 |
| --- | --- |
| `search.kuwo.cn/r.s?all=晴天&ft=music&itemset=web_2018&client=mp&pn=0&rn=3&rformat=json&encoding=utf8&vipver=MUSIC_8.0.3.0_BCS2&show_copyright_off=1&pcjson=1` | ✅ 200，`abslist[]` 匿名可用 |
| `www.kuwo.cn/api/www/search/searchMusicBykeyWord`（Hm_Iuvt cookie + Secret 头） | ⚠️ code 200 但 **data 为空**（端点实际已死） |
| 同端点（kw_token cookie + csrf 头，随机 token） | ❌ `{"success":false,"message":"The request is illegal!"}` |
| `www.kuwo.cn/api/www/search/searchKey` | ⚠️ 仅联想词（`key=value\r\n` 文本协议），非歌曲列表 |
| `m.kuwo.cn/searchapi/keywordsearch` | ❌ 403 |

`r.s` 关键字段（晴天，rid=228908）：`MUSICRID="MUSIC_228908"`、`NAME/SONGNAME`、`ARTIST`、`ALBUM/ALBUMID`、`DURATION="269"`（秒）、`MINFO`（各档 bitrate/format/size）、`payInfo.feeType.vip="1"`、`web_albumpic_short="120/s3s94/93/211513640.jpg"`、`TOTAL`。

## 2. 取流通道

### 主通道：DES（mobi.s f=kuwo）

明文（177 字节）：

```
corp=kuwo&p2p=1&sig=0&notrace=0&priority=bitrate&network=WIFI&mode=down&source=kwplayerhd_ar_5.1.0.0_B_jiakong_vh.apk&type=convert_url_with_sign&br=128kmp3&format=mp3&rid=311875
```

- 算法：lx-source `src/sources/custom/kw/encrypt.go` 的自定义 S 盒 DES（密钥 `ylzsxkwm`），输出 base64 作为 `q` 参数。JS 移植版（BigInt 复刻 int64 补码语义）已被服务器接受，即移植正确。
- **KAT 向量**（Rust 实现必须复现）：

```
q = NI8S5evAnmGldi4g47EsqrT7al5u+JTiJ+heOUwqOwcqvgwFyTLvnshjX+I4drxiGXu1L30BOmfLz/L75rBYbwWyAlB/g5IpFLKP5pzBz7HwnFbScG9nzFH952pO6cIz1L6UJVp37dxHHHfzQvSXS7yoB84sKV/ka1id0JcxSGP/4zX/nWSPf7Y7KQRWCXwNvpWJklhTVX1gFtPEklRJ/6WNmoyxI7Y+MVFg5NTDzq7NO9EASknnzw==
```

### 实测结果

| 请求 | code | data.bitrate | 下载 |
| --- | --- | --- | --- |
| DES rid=311875 br=128kmp3 | 200 | **128**（完整曲） | 2,844,016 B，`ID3`，audio/mpeg ✅ |
| DES rid=311875 br=320kmp3 | 200 | 128（匿名降级，如实） | 同上 2.8MB |
| DES rid=228908（晴天，VIP）br=128kmp3 | 200 | **1**（试听片段） | 185,336 B，`ID3`（≈60s 低码率） |
| f=web（无加密）rid=311875 br=128kmp3 | 200 | 128 | ✅ |

- `bitrate=1` 语义 = 试听片段（非真实码率），与 lx-source 的 `Bitrate != 1` 容错判断一致。
- CDN 下载只需 UA（未带 Referer 也 200）；`referer()` 仍按源配置 `https://www.kuwo.cn/`，无害。
- 档位映射（lx-source utils.go）：128k→mp3/`128kmp3`，320k→mp3/`320kmp3`，flac→flac/`2000kflac`。

## 3. 歌词 / 详情 / 封面

- `m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=228908`（Referer `https://m.kuwo.cn/`）→ `data.lrclist[63]`，元素 `{lineLyric, time:"0.0"}`（time 为秒）；`songinfo` 字段稀疏（album 有值，name/artist/pic 空）→ 元数据以搜索结果为准。
- 封面：`https://img{2,3,4}.kuwo.cn/star/albumcover/120/s3s94/93/211513640.jpg` → 三个 host 均 200，`500/` 尺寸亦 200。

## 4. 尚未验证 / 留待后续

- 登录 cookie 对 DES/f=web 通道的效果（无酷我账号可测）；v1 仅做 CredPack 透传，不承诺 VIP 无损。
- `www.kuwo.cn` 系 API 的 Hm_Iuvt+Secret 鉴权方案已验证可用（首页领 cookie → 网页 JS 同款算法），但对应的搜索端点已死，v1 不采用；未来端点复活时可启用。
- Jamendo：官方文档化 API（v3.0，client_id 注册制），无反爬，不列入本证据范围。

## 5. 结论

酷我按「r.s 搜索 + DES 主通道 + f=web 备通道 + songinfoandlrc 歌词」接入；能力位 caps=[CookieLogin]，quality allowed=[Standard, Exhigh, Lossless]、default=Exhigh；试听片段以 vip_only 标注 + bitrate 如实回传，与 netease「VIP 曲可播、流阶段如实降级」策略对齐。
