// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 酷我音源。
//!
//! 搜索走旧式 `search.kuwo.cn/r.s`：www 系 `searchMusicBykeyWord` 实测返回
//! 空 data、kw_token/csrf 方案已死（aegis 证据 §1）。取流主通道是移动端
//! `mobi.s` 的变形 DES 载荷（[`super::sign::kuwo`]，KAT 已被真机验证），
//! 备通道是不加密的 `f=web`。
//!
//! 响应 `data.bitrate` 是**实际档位**：`1` 表示试听片段（约 60 秒低码率），
//! 会员曲匿名播放只会拿到它。这里如实回传码率，不把试听标成高音质；
//! 搜索阶段已经用 payInfo 把会员曲标成 vip_only（与 netease「VIP 曲可播、
//! 流阶段如实降级」策略对齐）。
//!
//! 边界：只做平台客户端自身的请求签名与公开端点代理；不解密加密音频，
//! 不做账号池。登录 cookie 仅做透传——对移动通道的实际效果待有账号实测
//! （见 aegis 计划「替代与风险」），失败时按登录态给诚实的错误文案。

use super::{
    bad_request, client, const_url, ApiError, ApiResult, Ctx, OnlineDetail, OnlineTrack, SearchPage,
    SearchQuery, StreamInfo,
};

pub const ID: &str = "kuwo";

const SEARCH_URL: &str = "https://search.kuwo.cn/r.s";
const MOBI_S: &str = "https://mobi.kuwo.cn/mobi.s";
/// 移动通道声明自身的客户端来源（lx-source 默认值，公开常量）。
const DES_SOURCE: &str = "kwplayerhd_ar_5.1.0.0_B_jiakong_vh.apk";
const SONG_INFO_URL: &str = "https://m.kuwo.cn/newh5/singles/songinfoandlrc";
/// 搜索结果给的是相对路径（如 `120/s3s94/93/211513640.jpg`）；img2/3/4 均
/// 可用（真机 200），统一取 500 尺寸的 img2。
// 注意末尾不带尺寸段：web_albumpic_short 自带的是「缩略图尺寸 + 路径」
// （如 120/s4s98/44/74212599.jpg），尺寸段由 cover_url 统一改写，见其注释。
const COVER_BASE: &str = "https://img2.kuwo.cn/star/albumcover/";

fn internal_store(e: vmusic_core::StoreError) -> ApiError {
    ApiError::internal(e.to_string())
}

/// 上游字段值统一取字符串（TOTAL/rate 等历史接口数字、字符串混用）。
fn val_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

pub async fn search(ctx: &Ctx, q: &SearchQuery) -> ApiResult<SearchPage> {
    let _ = ctx; // 搜索不需要凭据
    let term = q.q.clone().unwrap_or_default();
    let term = term.trim();
    if term.is_empty() {
        // 分类 chips 在界面上对这个音源是隐藏的（SOURCES 里 cats 为空），
        // 走到这里只可能是直接构造了请求。
        return Err(bad_request("酷我只支持关键词检索，请输入歌名或歌手"));
    }

    let limit = q.limit.clamp(1, 50);
    // r.s 的 pn 是页码（0 起），按 offset/rn 折算。
    let pn = (q.offset / limit).to_string();
    let rn = limit.to_string();

    let mut url = const_url(SEARCH_URL)?;
    {
        let mut p = url.query_pairs_mut();
        p.append_pair("all", term)
            .append_pair("ft", "music")
            .append_pair("itemset", "web_2018")
            .append_pair("client", "mp")
            .append_pair("pn", &pn)
            .append_pair("rn", &rn)
            .append_pair("rformat", "json")
            .append_pair("encoding", "utf8")
            .append_pair("vipver", "MUSIC_8.0.3.0_BCS2")
            .append_pair("show_copyright_off", "1")
            .append_pair("pcjson", "1");
    }
    let h = super::http::headers(None, Some("https://www.kuwo.cn/"));
    let body = super::http::get_json(&client()?, url.as_str(), h).await?;

    let items = body
        .get("abslist")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let tracks: Vec<OnlineTrack> = items.iter().filter_map(map_track).collect();
    let total = body
        .get("TOTAL")
        .and_then(val_string)
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(tracks.len());

    Ok(SearchPage {
        source: ID.into(),
        keyword: term.to_string(),
        total,
        tracks,
        warning: None,
    })
}

/// 把一条 abslist 折成曲目。会员判定用 payInfo.feeType.vip（真机样例为
/// 字符串 "1"，数字也容忍）；playable 恒 true——匿名也有试听，能不能播
/// 完整曲由取流阶段的实际码率说话（与 netease 的 fee 判法对称）。
fn map_track(item: &serde_json::Value) -> Option<OnlineTrack> {
    let rid = item.get("MUSICRID").and_then(val_string)?;
    let id = match rid.trim().strip_prefix("MUSIC_") {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return None,
    };

    let title = item
        .get("NAME")
        .and_then(val_string)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| item.get("SONGNAME").and_then(val_string))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "未知曲目".into());
    let artist = item
        .get("ARTIST")
        .and_then(val_string)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "未知艺术家".into());
    let album = item
        .get("ALBUM")
        .and_then(val_string)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_default();
    let duration_ms = item
        .get("DURATION")
        .and_then(val_string)
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
        * 1000;
    let vip_only = flag_one(item.pointer("/payInfo/feeType/vip"));
    let cover = item
        .get("web_albumpic_short")
        .and_then(val_string)
        .and_then(|s| cover_url(&s));

    Some(OnlineTrack {
        source: ID.into(),
        id,
        title,
        artist,
        album,
        duration_ms,
        cover,
        playable: true,
        vip_only,
        track_ref: serde_json::json!({}),
    })
}

/// "1"（字符串或数字）视为真。
fn flag_one(v: Option<&serde_json::Value>) -> bool {
    v.is_some_and(|v| v.as_str() == Some("1") || v.as_i64() == Some(1))
}

/// 相对路径拼成绝对地址；空值不猜。
///
/// `web_albumpic_short` 形如 `120/s4s98/44/74212599.jpg`——开头的数字段是
/// **缩略图尺寸**，属于路径的一部分。此前直接前缀 `500/` 得到
/// `/albumcover/500/120/...`，CDN 上不存在这种双层尺寸路径，全部 404，
/// 界面上酷我的封面就集体消失。正确做法：剥掉首段尺寸，换成想要的
/// 500 大图（正在播放与详情页要分辨率）；不带尺寸段的老路径保持原样。
fn cover_url(short: &str) -> Option<String> {
    let s = short.trim();
    if s.is_empty() {
        return None;
    }
    let rest = match s.split_once('/') {
        Some((head, tail)) if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) => tail,
        _ => s,
    };
    Some(format!("{COVER_BASE}500/{rest}"))
}

// ---------------------------------------------------------------------------
// 取流
// ---------------------------------------------------------------------------

/// 统一音质档位 → 酷我的 (br, format)。
fn br_of(quality: u32) -> (&'static str, &'static str) {
    match quality {
        q if q >= 700_000 => ("2000kflac", "flac"),
        q if q >= 320_000 => ("320kmp3", "mp3"),
        _ => ("128kmp3", "mp3"),
    }
}

/// 请求档位起单调下降的阶梯：上游明确拒了某一档才降下一档；bitrate 降级
/// （如匿名请求 flac 回 128k）是如实结果，不算失败、不再多发请求。
fn br_ladder(quality: u32) -> Vec<(&'static str, &'static str)> {
    match br_of(quality) {
        ("2000kflac", fmt) => vec![("2000kflac", fmt), ("320kmp3", "mp3"), ("128kmp3", "mp3")],
        ("320kmp3", fmt) => vec![("320kmp3", fmt), ("128kmp3", "mp3")],
        other => vec![other],
    }
}

#[derive(Debug, Clone, Copy)]
enum Channel {
    /// 主通道：f=kuwo，载荷变形 DES 加密（sign::kuwo）。
    Des,
    /// 备通道：f=web，明文 query。
    Web,
}

impl Channel {
    fn name(self) -> &'static str {
        match self {
            Channel::Des => "des",
            Channel::Web => "web",
        }
    }
}

/// 从取流响应取 (url, 实际码率)。code != 200 视为业务失败；bitrate=1 是
/// 试听片段标记，不是真实码率，回 None 由上层按未知档位展示。
fn play_from(j: &serde_json::Value) -> Option<(String, Option<u64>)> {
    if j.get("code").and_then(|v| v.as_i64()) != Some(200) {
        return None;
    }
    let url = j
        .pointer("/data/url")
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with("http"))?;
    let bitrate = j
        .pointer("/data/bitrate")
        .and_then(|v| v.as_i64())
        .filter(|b| *b > 1)
        .map(|b| b as u64 * 1000);
    Some((url.to_string(), bitrate))
}

async fn mobi_request(
    cl: &reqwest::Client,
    cookie: Option<&str>,
    query: Vec<(&str, &str)>,
    channel: Channel,
    br: &str,
) -> ApiResult<serde_json::Value> {
    let mut url = const_url(MOBI_S)?;
    {
        let mut p = url.query_pairs_mut();
        for (k, v) in &query {
            p.append_pair(k, v);
        }
    }
    let h = super::http::headers(cookie, Some("https://www.kuwo.cn/"));
    match super::http::get_json(cl, url.as_str(), h).await {
        Ok(j) => Ok(j),
        Err(e) => {
            tracing::debug!(
                source = ID,
                channel = channel.name(),
                br,
                "酷我取流请求失败: {e:?}"
            );
            Err(e)
        }
    }
}

async fn des_request(
    cl: &reqwest::Client,
    cookie: Option<&str>,
    rid: &str,
    br: &str,
    fmt: &str,
) -> ApiResult<serde_json::Value> {
    let plain = format!(
        "corp=kuwo&p2p=1&sig=0&notrace=0&priority=bitrate&network=WIFI&mode=down\
         &source={DES_SOURCE}&type=convert_url_with_sign&br={br}&format={fmt}&rid={rid}"
    );
    let q = super::sign::kuwo::mobi_q(&plain);
    mobi_request(cl, cookie, vec![("f", "kuwo"), ("q", &q)], Channel::Des, br).await
}

async fn web_request(
    cl: &reqwest::Client,
    cookie: Option<&str>,
    rid: &str,
    br: &str,
    fmt: &str,
) -> ApiResult<serde_json::Value> {
    mobi_request(
        cl,
        cookie,
        vec![
            ("f", "web"),
            ("type", "convert_url_with_sign"),
            ("br", br),
            ("format", fmt),
            ("rid", rid),
        ],
        Channel::Web,
        br,
    )
    .await
}

/// 按「档位阶梯 × 通道」取流：DES 主通道先行，f=web 兜底；某一档两个通道
/// 都拿不到直链才降下一档。bitrate 降级是正常结果，不做多余重试。
///
/// 错误归类：全部停在传输层时透传最后一个传输错误；拿到业务响应但始终没有
/// url，说明这首歌没有可播放的音频（会员曲无试听或已下架），按登录态给
/// 诚实的文案。日志只打 channel/br，绝不记录 url/cookie。
pub async fn stream(
    ctx: &Ctx,
    id: &str,
    _track_ref: Option<&super::TrackRef>,
    quality: u32,
) -> ApiResult<StreamInfo> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let cred = super::cred::get(&ctx.db, ID)
        .await
        .map_err(internal_store)?
        .unwrap_or_default();
    let cookie = if cred.cookie.trim().is_empty() {
        None
    } else {
        Some(cred.cookie.as_str())
    };
    let cl = client()?;

    let mut last_transport: Option<ApiError> = None;
    for (br, fmt) in br_ladder(quality) {
        for channel in [Channel::Des, Channel::Web] {
            let res = match channel {
                Channel::Des => des_request(&cl, cookie, id, br, fmt).await,
                Channel::Web => web_request(&cl, cookie, id, br, fmt).await,
            };
            match res {
                Ok(j) => {
                    if let Some((url, bitrate)) = play_from(&j) {
                        return Ok(StreamInfo {
                            url,
                            source: ID.into(),
                            id: id.to_string(),
                            bitrate,
                            expires_in_secs: None,
                            fallback_urls: Vec::new(),
                            // 酷我响应里没有观测到响度字段：按 0 dB 播。
                            rg_gain_db: None,
                            rg_peak: None,
                        });
                    }
                    tracing::debug!(
                        source = ID,
                        channel = channel.name(),
                        br,
                        "酷我取流响应无直链"
                    );
                }
                Err(e) => last_transport = Some(e),
            }
        }
    }
    match last_transport {
        Some(e) => Err(e),
        None if cookie.is_none() => Err(ApiError::vip_required(
            "酷我未返回可播放音频（会员曲目或已下架试听）".to_string(),
        )),
        None => Err(ApiError::vip_required(
            "这首歌在你的酷我账号里也没有可播放音频（会员曲目或已下架）".to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// 详情 / 歌词 / 账号
// ---------------------------------------------------------------------------

/// 没有按 id 查详情的可用接口（www 系 musicInfo 需要的 Secret 方案其搜索
/// 端点已死，songinfoandlrc 字段稀疏）。返回错误而不是编一个空壳，调用方
/// （补封面那条路径）本来就按「拿不到就算了」处理（与酷狗/ccmixter 对齐）。
pub async fn detail(_ctx: &Ctx, id: &str) -> ApiResult<OnlineDetail> {
    let _ = _ctx;
    Err(bad_request(format!(
        "酷我没有单曲详情接口，元数据以搜索结果为准（id {id}）"
    )))
}

/// 歌词走 songinfoandlrc：lrclist 的 time 是秒（可带小数），折成
/// `[mm:ss.xx]` 行喂给 LRC 解析器，后续与本地歌词共用同一渲染。
pub async fn lyric(ctx: &Ctx, id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let cred = super::cred::get(&ctx.db, ID)
        .await
        .map_err(internal_store)?
        .unwrap_or_default();
    let cookie = if cred.cookie.trim().is_empty() {
        None
    } else {
        Some(cred.cookie.as_str())
    };

    let mut url = const_url(SONG_INFO_URL)?;
    {
        let mut p = url.query_pairs_mut();
        p.append_pair("musicId", id).append_pair("httpsStatus", "1");
    }
    let h = super::http::headers(cookie, Some("https://m.kuwo.cn/"));
    let body = super::http::get_json(&client()?, url.as_str(), h).await?;
    let lines = body
        .pointer("/data/lrclist")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let text = lrc_text(&lines);
    if text.trim().is_empty() {
        return Ok(vmusic_core::LyricDocument::empty());
    }
    let mut doc = vmusic_lyrics::parse_lrc(&text);
    vmusic_lyrics::apply_offset(&mut doc);
    Ok(doc)
}

/// lrclist → LRC 文本。time 秒（"0.0" / "12.34"）；脏数据按 0 处理。
fn lrc_text(lines: &[serde_json::Value]) -> String {
    let mut out = String::new();
    for line in lines {
        let Some(text) = line.get("lineLyric").and_then(|v| v.as_str()) else {
            continue;
        };
        let t = line
            .get("time")
            .and_then(val_string)
            .and_then(|s| s.trim().parse::<f64>().ok())
            .unwrap_or(0.0)
            .max(0.0);
        let min = (t / 60.0).floor() as u64;
        let sec = t - min as f64 * 60.0;
        out.push_str(&format!("[{min:02}:{sec:05.2}]{text}\n"));
    }
    out
}

/// 登录态概要。酷我拿不到平台侧昵称（无可用用户信息端点），昵称用本地
/// 生成式占位——只表示「这是谁的账号」，不冒充平台数据。
pub async fn account(ctx: &Ctx) -> ApiResult<super::AccountInfo> {
    let cred = super::cred::get(&ctx.db, ID)
        .await
        .map_err(internal_store)?
        .unwrap_or_default();
    if !super::cred::is_signed_in(ID, &cred) {
        return Err(ApiError::auth_required("请先登录酷我".to_string()));
    }
    Ok(super::AccountInfo {
        source: ID.into(),
        nickname: format!("酷我用户 {}", cred.userid),
        avatar: None,
        vip_level: 0,
        vip_label: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/kuwo_search.json")).unwrap()
    }

    #[test]
    fn fixture_normalizes_search_items() {
        let body = fixture();
        let items = body.get("abslist").and_then(|v| v.as_array()).unwrap();
        let tracks: Vec<OnlineTrack> = items.iter().filter_map(map_track).collect();
        assert_eq!(tracks.len(), 2);
        let first = &tracks[0];
        assert_eq!(first.source, "kuwo");
        assert_eq!(first.id, "228908");
        assert_eq!(first.title, "晴天");
        assert_eq!(first.artist, "周杰伦");
        assert_eq!(first.album, "叶惠美");
        assert_eq!(first.duration_ms, 269_000);
        assert!(first.playable);
        assert!(first.vip_only, "feeType.vip=1 是会员曲");
        assert_eq!(
            first.cover.as_deref(),
            Some("https://img2.kuwo.cn/star/albumcover/500/s3s94/93/211513640.jpg")
        );
        // 第二条：免费曲、无封面。
        let second = &tracks[1];
        assert!(!second.vip_only);
        assert!(second.cover.is_none());
        assert!(second.playable);
    }

    #[test]
    fn items_without_musicrid_are_dropped() {
        assert!(map_track(&serde_json::json!({"NAME": "x"})).is_none());
        assert!(map_track(&serde_json::json!({"MUSICRID": "MUSIC_"})).is_none());
        assert!(map_track(&serde_json::json!({})).is_none());
    }

    #[test]
    fn title_falls_back_to_songname_then_placeholder() {
        let mut item = serde_json::json!({"MUSICRID": "MUSIC_1", "SONGNAME": "备用名"});
        assert_eq!(map_track(&item).unwrap().title, "备用名");
        item["SONGNAME"] = serde_json::json!("");
        assert_eq!(map_track(&item).unwrap().title, "未知曲目");
        item["ARTIST"] = serde_json::json!("  ");
        assert_eq!(map_track(&item).unwrap().artist, "未知艺术家");
    }

    #[test]
    fn relative_cover_paths_become_absolute_and_empty_stays_none() {
        // 首段数字是缩略图尺寸，要被换写成 500 大图（此前双层尺寸段 404）。
        assert_eq!(
            cover_url(" 120/a/b.jpg ").as_deref(),
            Some("https://img2.kuwo.cn/star/albumcover/500/a/b.jpg")
        );
        assert_eq!(
            cover_url("s4s98/44/74212599.jpg").as_deref(),
            Some("https://img2.kuwo.cn/star/albumcover/500/s4s98/44/74212599.jpg")
        );
        assert_eq!(cover_url(""), None);
        assert_eq!(cover_url("   "), None);
    }

    #[test]
    fn quality_maps_to_br_ladder_monotonically() {
        assert_eq!(br_ladder(128_000), vec![("128kmp3", "mp3")]);
        assert_eq!(
            br_ladder(320_000),
            vec![("320kmp3", "mp3"), ("128kmp3", "mp3")]
        );
        assert_eq!(
            br_ladder(740_000),
            vec![
                ("2000kflac", "flac"),
                ("320kmp3", "mp3"),
                ("128kmp3", "mp3")
            ]
        );
    }

    #[test]
    fn bitrate_one_means_trial_not_tier() {
        let (url, bitrate) = play_from(&serde_json::json!({
            "code": 200, "msg": "ok",
            "data": {"bitrate": 1, "url": "http://cdn.kuwo.cn/a.mp3"}
        }))
        .unwrap();
        assert_eq!(url, "http://cdn.kuwo.cn/a.mp3");
        assert_eq!(bitrate, None, "bitrate=1 是试听标记，不回填码率");

        let (_, bitrate) = play_from(&serde_json::json!({
            "code": 200,
            "data": {"bitrate": 128, "url": "http://cdn.kuwo.cn/a.mp3"}
        }))
        .unwrap();
        assert_eq!(bitrate, Some(128_000));

        // 缺 url / 非直链一律不可用。
        assert!(play_from(&serde_json::json!({"code": 200, "data": {}})).is_none());
        assert!(
            play_from(&serde_json::json!({"code": 500, "data": {"url": "http://x/a.mp3"}}))
                .is_none()
        );
    }

    #[test]
    fn des_payload_shape_is_stable() {
        // 明文里 source/rid 位置固定（KAT 锁在 sign::kuwo），这里只锁形态。
        let q = super::super::sign::kuwo::mobi_q(
            "corp=kuwo&type=convert_url_with_sign&br=128kmp3&format=mp3&rid=1",
        );
        assert!(!q.is_empty());
        assert!(q.ends_with("==") || !q.ends_with('='));
    }

    #[test]
    fn lrclist_folds_into_lrc_text() {
        let lines = serde_json::json!([
            {"lineLyric": "晴天 - 周杰伦", "time": "0.0"},
            {"lineLyric": "故事的小黄花", "time": "13.08"},
            {"lineLyric": "从出生那年就飘着", "time": "17.39"},
            {"lineLyric": "缺时间的行按第零秒保留"},
            {"time": "20"}
        ]);
        let text = lrc_text(lines.as_array().unwrap());
        assert!(text.contains("[00:00.00]晴天 - 周杰伦\n"));
        assert!(text.contains("[00:13.08]故事的小黄花\n"));
        assert!(text.contains("[00:17.39]从出生那年就飘着\n"));
        assert!(text.contains("[00:00.00]缺时间的行按第零秒保留\n"));
        // 没有 lineLyric 的行整行丢弃（纯时间戳不是歌词）。
        assert!(!text.contains("[00:20"));
    }

    #[test]
    fn kuwo_downloads_carry_their_own_referer() {
        assert_eq!(super::super::referer("kuwo"), Some("https://www.kuwo.cn/"));
    }
}
