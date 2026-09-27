# 接入酷我音乐与 Jamendo 两个在线音源

- Goal：按 online/mod.rs「三处接入」约定新增 kuwo（主流 TME 曲库补充，匿名 128k/试听如实降级）与 jamendo（CC 授权官方 API）两个音源，零前端改动。
- Architecture：复用 `crates/vmusicd/src/online/` 的注册表 + dispatch 模式。kuwo 照 kugou.rs 骨架（多通道取流、设备化身份、fixture 单测），签名进 sign.rs（lx-source 的自定义 S 盒 DES，纯本地实现）；jamendo 照 ccmixter.rs 骨架（直链播放）。凭据仍走 cred.rs/OS 钥匙串，不新增存储形态。
- Baseline：`docs/research` 无酷我记录；社区参考 lx-source（Go，DES 与 f=web 通道）、kuwoMusicApi（www API Secret 头，搜索端点已死）。spike 结论见 `docs/aegis/work/2026-09-27-kuwo-jamendo/90-evidence.md`。
- Compatibility：前端零改动（能力位驱动已验证）；mod.rs 三个事实表测试与 quality.rs 表必须同步更新；不碰 DRM/付费墙（VIP 试听片段如实标注，不解密、不模拟会员权益）。
- Verification：sign.rs KAT（spike 固化的 base64 向量）+ fixture 归一化测试；CI 等价物（fmt/clippy/test/check-online.js）；target-verify 隔离实例真机冒烟（搜索→取流→下载魔数）。用户明确不用 TDD；直接实现后验证。
- ArchitectureReviewRequired：no（沿用既有音源模式，无新边界）。

## 已确定的设计

spike 已把端点钉死（2026-09-27 实测）：

1. **搜索**：`search.kuwo.cn/r.s`（匿名可用，MUSICRID/NAME/ARTIST/ALBUM/DURATION/MINFO/payInfo/web_albumpic_short 字段齐全）。www 系 `searchMusicBykeyWord` 返回空 data、kw_token+csrf 方案已死，均不采用。
2. **取流主通道**：`mobi.kuwo.cn/mobi.s?f=kuwo&q=<DES(明文)>`（密钥 `ylzsxkwm`，自定义 S 盒；明文含 source=kwplayerhd…、type=convert_url_with_sign、br、format、rid）。备通道 `f=web`（无加密）。响应 `data.bitrate` 为实际档位：**1 = 试听片段（约 60s 低码率）**，匿名免费歌 128k 完整，320k/flac 匿名被降级——按响应如实归档，不伪造高音质。
3. **能力位**：caps = `[CookieLogin]`。不标 HighQuality——匿名拿不到无损，标了等于承诺做不到（对齐 qishui 先例）。cookie 粘贴入口保留（CredPack 透传，效果待用户实测，不阻塞上线）。quality.rs allowed = Standard/Exhigh/Lossless，default = Exhigh。
4. **歌词/详情**：`m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=`（lrclist{lineLyric,time} 折成 LRC 喂 parse_lrc；songinfo 字段稀疏，元数据以搜索为准）。
5. **封面**：`https://img2.kuwo.cn/star/albumcover/{size}/{web_albumpic_short}`（120/500 均已实测 200）。
6. **Jamendo**：api.jamendo.com/v3.0 官方接口，client_id 走 settings 键 `jamendo_client_id`，未配置时 list_sources 动态隐藏并给注册指引；caps 空。

## 实施顺序

1. sign.rs 加 `pub mod kuwo`（DES + KAT）；cred.rs is_signed_in/enrich_from_cookie 加 kuwo 臂。
2. 新建 online/kuwo.rs（search/stream/detail/lyric/account）+ mod.rs 接线（SOURCES、五个 dispatch 臂、referer）+ quality.rs 表 + fixture 测试 + 事实表测试更新 + smoke-online.ps1 加 kuwo。
3. 新建 online/jamendo.rs + 接线 + client_id 机制 + 测试。
4. CI 等价物 + target-verify 真机冒烟 + README/INDEX 登记。

## 替代与风险

DES 移植以 spike 的 JS 版为中间对照（服务器 oracle 已验证），Rust 版必须过 KAT 并真机复验；若上游废弃 DES，f=web 备通道同构可替换。酷我登录链路（VIP 无损）本轮不实现、不承诺——待用户实贴 cookie 后另行验证。r.s 为旧式接口，字段为全大写historical命名，归一化时逐字段容忍缺失。
