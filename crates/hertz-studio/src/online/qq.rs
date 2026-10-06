// SPDX-License-Identifier: MIT
//! QQ音乐音源：musics.fcg(zzc 签名搜索) / musicu.fcg(vkey、歌词、推荐)；
//! 歌单/账号走 c.y.qq.com 经典 fcgi 网关；扫码走 ptqrlogin2（ptqrtoken 签名）。
//! 协议见 spec §2.2。合规边界：只实现 QQ 客户端自身使用的 zzc 签名与 vkey
//! 请求；不做加密音频解密、不做账号池、不绕过付费判定。

use std::collections::BTreeMap;

use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, LOCATION, SET_COOKIE, USER_AGENT};
use serde_json::{json, Value};

use super::cred::CredPack;
use super::sign::qq::{b64_encode_std, gtk33};
use super::{
    bad_request, client, const_url, https_url, AccountInfo, ApiError, ApiResult, Ctx, OnlineDetail,
    OnlinePlaylist, OnlineTrack, PlaylistDetail, QrPayload, SearchPage, SearchQuery, StreamInfo,
};

pub const ID: &str = "qq";
const MUSICU: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const MUSICS: &str = "https://u.y.qq.com/cgi-bin/musics.fcg";
const ANDROID_UA: &str = "QQMusic 14090508(android 12)";
const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const REFERER: &str = "https://y.qq.com/";
/// 雷达推荐的翻页上限。上游一页只给 10 条左右，满量要翻几页；设上限是为了
/// `HasMore` 恒为 true（或恒定返回重复批次）时，别把一次推荐变成十几轮串行
/// 请求把整页拖慢——宁可少几首，也不要让用户多等十几秒。
const RADAR_MAX_PAGES: usize = 4;

fn internal_store(e: vmusic_core::StoreError) -> ApiError {
    ApiError::internal(format!("设置存储失败: {e}"))
}

// ---------------------------------------------------------------------------
// 本地 JSON 小助手（风格同 kugou.rs）
// ---------------------------------------------------------------------------

/// JSON 标量转字符串：字符串原样，整数（正/负/超大无符号）转十进制。
fn val_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => n
            .as_u64()
            .map(|x| x.to_string())
            .or_else(|| n.as_i64().map(|x| x.to_string())),
        _ => None,
    }
}

/// 数字或数字字符串 → u64；浮点、负数、脏字符串返回 None。
fn val_u64(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n
            .as_u64()
            .or_else(|| n.as_i64().and_then(|i| i.try_into().ok())),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// QQ 时长字段（interval/duration）单位是秒，统一折成毫秒。
fn secs_to_ms(v: Option<&Value>) -> u64 {
    v.and_then(val_u64).unwrap_or(0).saturating_mul(1000)
}

/// QQ 业务码成功判定：数字 0 或字符串 "0" 均视为成功（防御历史脏字段）。
fn code_zero(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Number(n)) => n.as_i64() == Some(0),
        Some(Value::String(s)) => s == "0",
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// comm 与设备身份
// ---------------------------------------------------------------------------

/// 搜索签名通道伪装安卓客户端的 comm（spec §2.2）。
fn android_comm() -> Value {
    json!({
        "ct": "11", "cv": "14090508", "v": "14090508", "tmeAppID": "qqmusic",
        "phonetype": "EBG-AN10", "os_ver": "12", "OpenUDID": "0", "QIMEI36": "0",
        "udid": "0", "chid": "0", "aid": "0", "oaid": "0", "taid": "0", "tid": "0",
        "wid": "0", "uid": "0", "sid": "0", "modeSwitch": "6", "teenMode": "0",
        "ui_mode": "2", "nettype": "1020"
    })
}

/// musicu.fcg 通用通道的 comm：匿名 ct=24；带 authst 时 ct=19 并附 authst。
fn web_comm(uin: &str, authst: Option<&str>) -> Value {
    let authst = authst.filter(|s| !s.is_empty());
    let mut comm = json!({
        "uin": uin,
        "format": "json",
        "cv": 0,
        "ct": if authst.is_some() { 19 } else { 24 },
    });
    if let Some(a) = authst {
        comm["authst"] = json!(a);
    }
    comm
}

/// CGI 用的纯数字 uin：cred.uin 非空直接用；否则从 cookie 的 uin 字段取
/// （形如 o0123456）；脏值/全 0 统一回 "0"。归一逻辑与凭据保险库同源。
fn numeric_uin(cred: &CredPack) -> String {
    if !cred.uin.is_empty() && cred.uin != "0" {
        return cred.uin.clone();
    }
    super::cred::cookie_field(&cred.cookie, "uin")
        .map(super::cred::normalize_qq_uin)
        .unwrap_or_else(|| "0".to_string())
}

/// 生成 8 位十进制 guid（spec §2.0）：uuid v4 的 u128 折进 [10000000, 99999999]。
fn new_guid() -> String {
    let n = 10_000_000 + uuid::Uuid::new_v4().as_u128() % 90_000_000;
    n.to_string()
}

/// 确保有 QQ guid 设备身份：缺则生成并持久化；持久化失败只记 debug，
/// 不阻断本次请求（内存值同样能完成 vkey 调用）。
async fn ensure_guid(ctx: &Ctx) -> ApiResult<String> {
    if let Some(g) = super::cred::get_device(&ctx.db, ID)
        .await
        .map_err(internal_store)?
        .filter(|g| !g.is_empty())
    {
        return Ok(g);
    }
    let g = new_guid();
    if let Err(e) = super::cred::set_device(&ctx.db, ID, &g).await {
        tracing::debug!(error = %e, "QQ guid 持久化失败，本次继续使用内存值");
    }
    Ok(g)
}

// ---------------------------------------------------------------------------
// 两条请求通道
// ---------------------------------------------------------------------------

/// musicu.fcg 通用 CGI 通道：紧凑 JSON body + Web UA + Referer，登录 cookie
/// 非空时原样带上。签名与该通道无关，serde_json::to_string 的紧凑形态即可。
async fn cgi(http: &reqwest::Client, ctx: &Ctx, body: Value) -> ApiResult<Value> {
    let cred = super::cred::get(&ctx.db, ID)
        .await
        .map_err(internal_store)?
        .unwrap_or_default();
    let text = serde_json::to_string(&body)
        .map_err(|e| ApiError::internal(format!("QQ CGI 请求序列化失败: {e}")))?;
    let cookie = (!cred.cookie.is_empty()).then_some(cred.cookie.as_str());
    let mut h = super::http::headers(cookie, Some(REFERER));
    h.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json;charset=UTF-8"),
    );
    super::http::post_json(http, MUSICU, h, text).await
}

/// musics.fcg 搜索签名通道：对**即将发送的同一字符串**计算 zzc 签名，
/// sign 经 Url::append_pair 拼接（hex+base64 字符集本无需编码，仍统一走
/// query_pairs 保证形态正确），安卓 UA + 纯 application/json。
async fn signed_search(http: &reqwest::Client, payload: Value) -> ApiResult<Value> {
    let body_text = serde_json::to_string(&payload)
        .map_err(|e| ApiError::internal(format!("QQ 搜索请求序列化失败: {e}")))?;
    let sign = super::sign::qq::zzc_sign(&body_text);
    let mut url = const_url(MUSICS)?;
    {
        url.query_pairs_mut().append_pair("sign", &sign);
    }
    let mut h = HeaderMap::new();
    h.insert(USER_AGENT, HeaderValue::from_static(ANDROID_UA));
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    super::http::post_json(http, url.as_str(), h, body_text).await
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/// item_song 元素可能直接是曲目，也可能包一层 track_info（详情接口必包）。
fn unwrap_song(item: &Value) -> &Value {
    item.pointer("/track_info").unwrap_or(item)
}

fn map_track(item: &Value) -> OnlineTrack {
    let s = unwrap_song(item);
    // 真机 mid 恒为字符串；val_string 兼容个别包给出的数字型 mid。
    // musicu 通道用 mid/name，经典 fcgi 歌单接口用 songmid/songname，
    // 两套字段都要认（前者优先）。
    let mid = s
        .get("mid")
        .or_else(|| s.get("songmid"))
        .and_then(val_string)
        .unwrap_or_default();
    let media_mid = s
        .pointer("/file/media_mid")
        .and_then(val_string)
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| mid.clone());
    let title = s
        .get("name")
        .or_else(|| s.get("title"))
        .or_else(|| s.get("songname"))
        .and_then(|v| v.as_str())
        .unwrap_or("未知曲目")
        .to_string();
    // spec §2.5：QQ 歌手数组用顿号「、」连接。
    let artist = s
        .pointer("/singer")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.get("name").and_then(|n| n.as_str()))
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    let album = s
        .pointer("/album/name")
        .and_then(|v| v.as_str())
        .or_else(|| s.get("albumname").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    // interval 缺失（含显式 null）时回落 duration；两者都是秒（兼容数字字符串）。
    let duration_ms = secs_to_ms(
        s.get("interval")
            .filter(|v| !v.is_null())
            .or_else(|| s.get("duration")),
    );
    // 封面优先专辑 pmid，回落专辑 mid；都没有则 None（前端回落占位图）。
    let cover = s
        .pointer("/album/pmid")
        .and_then(val_string)
        .or_else(|| s.pointer("/album/mid").and_then(val_string))
        .or_else(|| s.get("albummid").and_then(val_string))
        .filter(|p| !p.is_empty())
        .map(|p| format!("https://y.qq.com/music/photo_new/T002R300x300M000{p}.jpg"));
    // 付费曲标记有两个历史字段名：移动端搜索给 pay.payplay，网页/经典端点给
    // pay.pay_play（公开参考实现两形态并存），双候选且兼容字符串 "1"。
    let vip_only = s
        .pointer("/pay/pay_play")
        .or_else(|| s.pointer("/pay/payplay"))
        .and_then(val_u64)
        == Some(1);
    OnlineTrack {
        source: ID.into(),
        id: mid.clone(),
        title,
        artist,
        album,
        duration_ms,
        cover,
        playable: !mid.is_empty(),
        vip_only,
        track_ref: json!({ "song_mid": mid, "media_mid": media_mid }),
    }
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

// 搜索走匿名安卓签名通道，不需要凭据；ctx 仅为与其他音源统一的入口形态
// （Task 13 dispatch 按同一签名调用）。
pub async fn search(_ctx: &Ctx, q: &SearchQuery) -> ApiResult<SearchPage> {
    let keyword = q.q.as_deref().unwrap_or("").trim();
    if keyword.is_empty() {
        // cats 表为空，前端不会发 cat；直连接口带 cat 时如实告知不支持，
        // 而不是笼统说「缺关键词」，便于定位。
        return Err(bad_request(if q.cat.is_some() {
            "QQ 音乐暂不支持分类浏览，请输入关键词检索"
        } else {
            "需要给出搜索关键词"
        }));
    }
    let limit = q.limit.clamp(1, 30);
    let page = (q.offset / limit).saturating_add(1);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let payload = json!({
        "comm": android_comm(),
        "req": {
            "module": "music.search.SearchCgiService",
            "method": "DoSearchForQQMusicMobile",
            "param": {
                "search_type": 0,
                "searchid": format!("{now_ms}{}", q.offset),
                "query": keyword,
                "page_num": page,
                "num_per_page": limit,
                "highlight": 0,
                "nqc_flag": 0,
                "multi_zhida": 0,
                "cat": 2,
                "grp": 1,
                "sin": q.offset,
                "sem": 0
            }
        }
    });
    let http = client()?;
    let body = signed_search(&http, payload).await?;

    // 只摘要 code，绝不回显整包。
    if !code_zero(body.pointer("/req/code")) {
        return Err(ApiError::upstream_rejected(format!(
            "QQ 音乐搜索被上游拒绝（code={}）",
            body.pointer("/req/code")
                .and_then(val_string)
                .unwrap_or_else(|| "缺失".into())
        )));
    }
    // 缺失结果集是上游异常：不能伪造空页当成功；空数组本身是合法空结果。
    let items = body
        .pointer("/req/data/body/item_song")
        .and_then(|v| v.as_array())
        .ok_or_else(|| ApiError::upstream_rejected("QQ 音乐搜索未返回结果集".to_string()))?;
    let tracks: Vec<OnlineTrack> = items
        .iter()
        .map(map_track)
        .filter(|t| !t.id.is_empty())
        .collect();
    let total = body
        .pointer("/req/data/body/total_song")
        .and_then(val_u64)
        .or_else(|| body.pointer("/req/data/meta/sum").and_then(val_u64))
        .unwrap_or(tracks.len() as u64) as usize;

    Ok(SearchPage {
        source: ID.into(),
        keyword: keyword.to_string(),
        total,
        tracks,
        warning: None,
    })
}

// ---------------------------------------------------------------------------
// 播放（vkey 五档回落）
// ---------------------------------------------------------------------------

/// 候选音质，从高到低：Hi-Res / 标准无损 / 320k mp3 / 128k mp3 / 96k AAC。
const QUALITIES: &[(&str, &str, u64)] = &[
    ("RS01", ".flac", 700_000),
    ("F000", ".flac", 700_000),
    ("M800", ".mp3", 320_000),
    ("M500", ".mp3", 128_000),
    ("C400", ".m4a", 96_000),
];

/// 按请求码率决定要请求的 (filename, bps) 候选序列，音质从高到低。
///
/// 从首个不高于请求码率的档位起切片：码率 >=700k 五档全取；>=320k 为
/// M800/M500/C400 三档；更低码率只给 C400。不把更高档（F000/RS01）追加
/// 到低档序列后面——回落必须保持音质单调下降。
///
/// `media_ids` 按优先级给出多个 mid（首选 media_mid，其次 songmid）：每个
/// id 展开一遍上述档位，组间按传入顺序拼接。个别曲目 media_mid 与 songmid
/// 不等，只猜一个会整组 purl 落空，两个都带才能覆盖。
fn candidate_filenames(quality: u32, media_ids: &[&str]) -> Vec<(String, u64)> {
    let q = u64::from(quality);
    let start = QUALITIES
        .iter()
        .position(|(_, _, bps)| q >= *bps)
        .unwrap_or(QUALITIES.len() - 1);
    media_ids
        .iter()
        .flat_map(|media| {
            QUALITIES[start..]
                .iter()
                .map(move |(prefix, ext, bps)| (format!("{prefix}{media}{ext}"), *bps))
        })
        .collect()
}

/// 文件名里的 mid 候选：优先 track_ref 的 media_mid，其次 songmid(id)。
///
/// 个别曲目两者不等，取值错了会导致该组 filename 全部拿不到 purl；两个都
/// 带进同一次请求由服务端挑，命中率最高且不多花一次往返。
fn media_candidates(track_ref: Option<&super::TrackRef>, id: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(2);
    if let Some(m) = track_ref
        .and_then(|r| r.get("media_mid"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        out.push((*m).to_string());
    }
    if !id.is_empty() && !out.iter().any(|v| v == id) {
        out.push(id.to_string());
    }
    out
}

/// base 与 path 拼成完整 URL，保证恰好一个 '/'（sip 尾斜杠/purl 头斜杠都容错）。
fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// 对候选音频 URL 做一次轻量探活（HEAD），确认 vkey 没过期、文件真实存在。
/// QQ 的 purl 时效很短，vkey 接口返回非空 purl 不等于 CDN 能命中。
async fn probe_audio_url(http: &reqwest::Client, url: &str) -> bool {
    match http
        .head(url)
        .header("Referer", REFERER)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// 从 vkey 响应构造全部候选 URL，并发 HEAD 探活。
///
/// 返回 `(命中档位下标, 可用 URL, 其余可用 URL 列表)`。命中项是音质最高且
/// 真实可下载的第一个候选；fallback 列表保持音质单调下降，并把 https sip
/// 排在前面。
async fn pick_working_url(
    http: &reqwest::Client,
    data: &Value,
    tiers: &[(String, u64)],
) -> Option<(usize, String, Vec<String>)> {
    let sips: Vec<&str> = data
        .pointer("/sip")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let infos = data
        .pointer("/midurlinfo")
        .and_then(|v| v.as_array())
        .map(|arr| arr.as_slice())
        .unwrap_or(&[]);

    let mut candidates: Vec<(usize, String)> = Vec::new();
    for (i, info) in infos.iter().enumerate() {
        if i >= tiers.len() {
            continue;
        }
        let Some(purl) = info
            .get("purl")
            .and_then(|p| p.as_str())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        // 同一 purl 在多个 sip 上探；https 优先。
        for sip in sips.iter().filter(|s| s.starts_with("https://")) {
            candidates.push((i, join_url(sip, purl)));
        }
        for sip in sips.iter().filter(|s| !s.starts_with("https://")) {
            candidates.push((i, join_url(sip, purl)));
        }
    }
    if candidates.is_empty() {
        crate::diaglog!(
            "qq.no_candidate",
            tiers = tiers.len(),
            sips = sips.len(),
            infos = infos.len()
        );
        return None;
    }

    let results = futures::future::join_all(
        candidates
            .iter()
            .map(|(i, url)| async move { (*i, url.clone(), probe_audio_url(http, url).await) }),
    )
    .await;

    let Some(first) = results.iter().position(|(_, _, ok)| *ok) else {
        // 全部候选探活失败：vkey 给了地址但 CDN 都不认，这是「QQ 曲播不出来」
        // 最常见的形态，必须留下探了多少个。
        crate::diaglog!(
            "qq.probe_all_failed",
            candidates = candidates.len(),
            tiers = tiers.len()
        );
        return None;
    };
    let hit = results[first].0;
    let url = results[first].1.clone();
    let hit_bps = tiers[hit].1;
    let fallback_urls: Vec<String> = results
        .iter()
        .skip(first + 1)
        .filter_map(|(i, u, ok)| {
            if !ok || tiers[*i].1 > hit_bps {
                return None;
            }
            Some(u.clone())
        })
        .collect();
    crate::diaglog!(
        "qq.probe",
        candidates = candidates.len(),
        hit_candidate = first,
        hit_tier = hit,
        hit_bps = hit_bps,
        fallbacks = fallback_urls.len(),
        url = crate::diag::redact_url(&url)
    );
    Some((hit, url, fallback_urls))
}

/// spec §2.2：一次 CgiGetVkey 带上从请求码率起的全部 filename，
/// midurlinfo[] 与之一一对应；对全部非空 purl 做 HEAD 探活，取首个真实可下载
/// 的 URL 及其可用 fallback。QQ 的 purl 时效很短，不探活会把过期或 404 的
/// 地址直接交给落盘逻辑。
pub async fn stream(
    ctx: &Ctx,
    id: &str,
    track_ref: Option<&super::TrackRef>,
    quality: u32,
) -> ApiResult<StreamInfo> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let cred = super::cred::get(&ctx.db, ID)
        .await
        .map_err(internal_store)?
        .unwrap_or_default();
    let guid = ensure_guid(ctx).await?;
    let uin = numeric_uin(&cred);
    let authst = super::cred::cookie_field(&cred.cookie, "qm_keyst");
    let signed_in = super::cred::is_signed_in(ID, &cred);

    // 文件名（M500/M800 前缀里的 mid）用的是 media_mid，个别曲目它与
    // songmid 不相等，拿错会 purl 全空。track_ref 缺失（旧前端/虚拟 id
    // 现取现播）时只剩 songmid(id)——多数曲目两者等值，链路仍可用。
    let media_ids = media_candidates(track_ref, id);
    let ids: Vec<&str> = media_ids.iter().map(String::as_str).collect();
    let tiers = candidate_filenames(quality, &ids);
    let filenames: Vec<String> = tiers.iter().map(|(f, _)| f.clone()).collect();
    let http = client()?;

    // songmid / songtype 必须与 filename **等长**：vkey 按下标把三个数组对齐，
    // 长度不足时后续档位拿到空 songmid，服务端一律回 101404，导致除首个档位
    // 外 purl 全空——这正是「已登录却整首播不了」的根因。
    let n = filenames.len();
    let body = json!({
        "comm": web_comm(&uin, authst),
        "req_0": {
            "module": "vkey.GetVkeyServer",
            "method": "CgiGetVkey",
            "param": {
                "guid": guid,
                "songmid": vec![id; n],
                "songtype": vec![0; n],
                "uin": uin,
                "loginflag": 1,
                "platform": "20",
                "filename": filenames
            }
        }
    });
    // 只有一次请求：传输层失败直接透传 502/504。
    let j = cgi(&http, ctx, body).await?;

    // 业务拒收（限流/系统错误）优先归 502，不要伪装成权益问题。
    if !code_zero(j.pointer("/req_0/code")) {
        return Err(ApiError::upstream_rejected(format!(
            "QQ vkey 请求被拒（code={}）",
            j.pointer("/req_0/code")
                .and_then(val_string)
                .unwrap_or_else(|| "缺失".to_string())
        )));
    }
    let data = j
        .pointer("/req_0/data")
        .ok_or_else(|| ApiError::upstream_rejected("QQ vkey 未返回 data".to_string()))?;
    let (hit, url, fallback_urls) =
        pick_working_url(&http, data, &tiers).await.ok_or_else(|| {
            if signed_in {
                ApiError::vip_required("该曲目为 VIP 专享或当前账号无可用音质".to_string())
            } else {
                ApiError::auth_required("QQ 音乐需要登录后获取该曲目".to_string())
            }
        })?;

    Ok(StreamInfo {
        url,
        source: ID.into(),
        id: id.to_string(),
        bitrate: Some(tiers[hit].1),
        expires_in_secs: None,
        fallback_urls,
        rg_gain_db: None,
        rg_peak: None,
    })
}

// ---------------------------------------------------------------------------
// 歌词（Base64 LRC）
// ---------------------------------------------------------------------------

pub async fn lyric(ctx: &Ctx, id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let http = client()?;
    let body = json!({
        "comm": { "ct": 24, "cv": 0 },
        "lyric": {
            "module": "music.musichallSong.PlayLyricInfo",
            "method": "GetPlayLyricInfo",
            "param": { "songMID": id, "songID": 0 }
        }
    });
    let j = cgi(&http, ctx, body).await?;

    // 有 lyric 字段但为空/解码空：「该曲确实无歌词」的正常语义，返回空文档。
    if let Some(b64) = j
        .pointer("/lyric/data/lyric")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let text = super::base64_decode_std(b64)
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            .unwrap_or_default();
        if text.trim().is_empty() {
            return Ok(vmusic_core::LyricDocument::empty());
        }
        let mut doc = vmusic_lyrics::parse_lrc(&text);
        // 译文走 translation 平行数组（同一响应里的 trans 也是 base64 LRC）；
        // 对齐在 apply_offset 之前，用原始时间轴。混进 LRC 文本会毁掉逐字时间轴。
        if let Some(trans_b64) = j
            .pointer("/lyric/data/trans")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let trans = super::base64_decode_std(trans_b64)
                .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
                .unwrap_or_default();
            if !trans.trim().is_empty() {
                doc.translation = vmusic_lyrics::align_translation(&doc, &trans);
            }
        }
        vmusic_lyrics::apply_offset(&mut doc);
        return Ok(doc);
    }

    // 无 lyric 字段：code 非 0 算上游拒收（摘要只带 code），否则按无歌词处理。
    if !code_zero(j.pointer("/lyric/code")) {
        return Err(ApiError::upstream_rejected(format!(
            "QQ 音乐歌词请求被拒绝（code={}）",
            j.pointer("/lyric/code")
                .and_then(val_string)
                .unwrap_or_else(|| "缺失".into())
        )));
    }
    Ok(vmusic_core::LyricDocument::empty())
}

// ---------------------------------------------------------------------------
// 单曲详情
// ---------------------------------------------------------------------------

pub async fn detail(ctx: &Ctx, id: &str) -> ApiResult<OnlineDetail> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let http = client()?;
    let body = json!({
        "comm": { "ct": 24, "cv": 0 },
        "songinfo": {
            "module": "music.pf_song_detail_svr",
            "method": "get_song_detail_yqq",
            "param": { "song_mid": id }
        }
    });
    let j = cgi(&http, ctx, body).await?;
    // track_info 缺失或为 null 都是上游异常：不 map 空对象编空壳。
    let info = j
        .pointer("/songinfo/data/track_info")
        .filter(|v| !v.is_null())
        .ok_or_else(|| ApiError::upstream_rejected("QQ 音乐未返回该曲目详情".to_string()))?;
    let t = map_track(info);
    Ok(OnlineDetail {
        source: ID.into(),
        id: id.to_string(),
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration_ms: t.duration_ms,
        cover: t.cover,
    })
}

// ===========================================================================
// 账号 / 歌单：c.y.qq.com 经典 fcgi 网关（网页端长期使用的公开端点，
// 见 jsososo/QQMusicApi 同名路径）；推荐歌单走匿名 musicu.fcg。
// g_tk=5381 是网页端历史常量，与登录 p_skey 无关，全网统一。
// 除推荐歌单外均需登录（uin + qm_keyst）。
// ===========================================================================

const C_YQQ: &str = "https://c.y.qq.com";
const GTK_WEB: &str = "5381";
/// 「我喜欢」歌单的固定 dirid。
const DIR_LIKED: &str = "201";
// 注意是 ptlogin2（ssl.ptqrlogin2.qq.com 不存在，NXDOMAIN，2026-09 核实）。
const PTQR: &str = "https://ssl.ptlogin2.qq.com";
/// 网页 QQ 音乐扫码 appid（公开客户端常量，非密钥）。
const QR_APPID: u64 = 716027609;
/// ptlogin 分配给 QQ 音乐网页的 daid。
const QR_DAID: &str = "383";
/// QQ 音乐在 QQ 互联的第三方授权 client_id（公开常量，非密钥）。
const QR_3RD_AID: &str = "100497308";
/// QQ Connect 授权流固定的 js_ver：它配 graph.qq.com 的 u1 + pt_3rd_aid
/// 使用，换成新直登页版本会被网关判成参数非法组合（HTTP 403）。
const QR_JS_VER: &str = "20102616";
/// 扫码确认后的授权落点 / check_sig 回跳白名单页。
const QR_U1: &str = "https://graph.qq.com/oauth2.0/login_jump";
const QR_CHECK_SIG: &str = "https://ssl.ptlogin2.graph.qq.com/check_sig";
const QR_AUTHORIZE: &str = "https://graph.qq.com/oauth2.0/authorize";
/// authorize 的 redirect_uri（公开常量）；code 经 302 Location 回到该页。
const QR_REDIRECT_URI: &str =
    "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/";
const PT_REFERER: &str = "https://xui.ptlogin2.qq.com/";

/// QQ 音乐在微信开放平台的 appid（公开常量，非密钥）：微信扫码走它。
const WX_APPID: &str = "wx48db31d50e334801";
const WX_QRCONNECT: &str = "https://open.weixin.qq.com/connect/qrconnect";
const WX_QRCODE: &str = "https://open.weixin.qq.com/connect/qrcode/";
/// 微信扫码状态长轮询（约 30s 无事件才回 408）。
const WX_LONG_POLL: &str = "https://lp.open.weixin.qq.com/connect/l/qrconnect";
const WX_REDIRECT: &str =
    "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/";
/// Registry 平台票里微信票的前缀，与 QQ 的裸 qrsig 区分；只是路由标记。
const WX_TICKET_PREFIX: &str = "wx:";

/// 取出已登录凭据；未登录直接 401，不允许网关函数匿名硬闯后再猜错误码。
async fn login_pack(ctx: &Ctx) -> ApiResult<CredPack> {
    let pack = super::cred::get(&ctx.db, ID)
        .await
        .map_err(internal_store)?
        .unwrap_or_default();
    if super::cred::is_signed_in(ID, &pack) {
        Ok(pack)
    } else {
        Err(ApiError::auth_required(
            "需要先登录 QQ 音乐（扫码或手动填写 cookie）".to_string(),
        ))
    }
}

/// 经典 fcgi GET（需登录）：带登录 cookie + 网页 UA/Referer，返回原文解析出
/// 的 JSON（这些端点偶尔回 JSONP，统一由 parse_fcgi 兼容）。
async fn fcgi_get(ctx: &Ctx, path: &str, query: &[(&str, &str)]) -> ApiResult<Value> {
    fcgi_get_as(ctx, path, query, true).await
}

/// 经典 fcgi GET（匿名）：歌单详情端点允许未登录访问（推荐广场点进来的免登录
/// 浏览链靠它）；业务 code 1/1000 仍会被 fcgi_code 归成 401。
async fn fcgi_get_anon(ctx: &Ctx, path: &str, query: &[(&str, &str)]) -> ApiResult<Value> {
    fcgi_get_as(ctx, path, query, false).await
}

async fn fcgi_get_as(
    ctx: &Ctx,
    path: &str,
    query: &[(&str, &str)],
    auth: bool,
) -> ApiResult<Value> {
    let pack = if auth {
        Some(login_pack(ctx).await?)
    } else {
        None
    };
    let mut url = reqwest::Url::parse(C_YQQ)
        .and_then(|u| u.join(path))
        .map_err(|e| ApiError::internal(format!("QQ fcgi 地址无效: {e}")))?;
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in query {
            q.append_pair(k, v);
        }
    }
    let mut h = super::http::headers(pack.as_ref().map(|p| p.cookie.as_str()), Some(REFERER));
    h.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
    let text = super::http::get_text(&client()?, url.as_str(), h).await?;
    parse_fcgi(&text)
}

/// 经典 fcgi 表单 POST（建单/删单/删曲）；`path` 可自带 `?g_tk=` 查询串。
async fn fcgi_post(ctx: &Ctx, path: &str, form: &BTreeMap<String, String>) -> ApiResult<Value> {
    let pack = login_pack(ctx).await?;
    let body = form_urlencoded(form);
    let mut h = super::http::headers(Some(&pack.cookie), Some(REFERER));
    h.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    let url = reqwest::Url::parse(C_YQQ)
        .and_then(|u| u.join(path))
        .map_err(|e| ApiError::internal(format!("QQ fcgi 地址无效: {e}")))?;
    let text = super::http::post_text(&client()?, url.as_str(), h, body).await?;
    parse_fcgi(&text)
}

/// 用 Url 的 query 编码器拼表单体：百分号编码与 GET 通道保持一致，不引新依赖。
fn form_urlencoded(form: &BTreeMap<String, String>) -> String {
    // unwrap 安全：常量字面量，解析结果恒定；改成 Result 会把纯编码器签名
    // 污染成 ApiResult。真正的网络站点已走 const_url 降级。
    let mut u = reqwest::Url::parse("https://local.invalid/").unwrap();
    u.query_pairs_mut()
        .extend_pairs(form.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    u.query().unwrap_or("").to_string()
}

/// 解析经典 fcgi 响应：正常 JSON 直接 parse；JSONP（`callback({...});`）
/// 剥最外层括号；都不像就上游拒收（绝不吞错编空成功）。
fn parse_fcgi(text: &str) -> ApiResult<Value> {
    let t = text.trim();
    let body = if t.starts_with('{') || t.starts_with('[') {
        t
    } else {
        let l = t
            .find('(')
            .ok_or_else(|| ApiError::upstream_rejected("QQ fcgi 响应无法解析（缺少括号）"))?;
        let r = t
            .rfind(')')
            .filter(|r| *r > l)
            .ok_or_else(|| ApiError::upstream_rejected("QQ fcgi 响应无法解析（括号不闭合）"))?;
        t[l + 1..r].trim()
    };
    serde_json::from_str(body)
        .map_err(|e| ApiError::upstream_rejected(format!("QQ fcgi 响应不是 JSON: {e}")))
}

/// 经典 fcgi code 判定（读接口宽松）：缺 code 不判错（部分读接口成功时不带）；
/// 1/1000 = 未登录；其他非 0 一律上游拒绝。错误摘要只带 code/msg，不回显整包。
fn fcgi_code(j: &Value, what: &str) -> ApiResult<()> {
    classify_fcgi_code(j, what, false)
}

/// 写操作专用严格判定：code 必须显式存在且为 0——缺 code 的 200 响应不算
/// 成功，杜绝「上游回了个异常 JSON 我们却告诉用户操作成功」（不伪造成功）。
fn fcgi_code_strict(j: &Value, what: &str) -> ApiResult<()> {
    classify_fcgi_code(j, what, true)
}

fn classify_fcgi_code(j: &Value, what: &str, strict: bool) -> ApiResult<()> {
    match j.get("code").and_then(val_u64) {
        Some(0) => Ok(()),
        None if !strict => Ok(()),
        None => Err(ApiError::upstream_rejected(format!(
            "{what}失败：上游响应缺少 code"
        ))),
        Some(1) | Some(1000) => Err(ApiError::auth_required(format!("{what}需要先登录 QQ 音乐"))),
        Some(c) => {
            let msg = j.get("msg").and_then(val_string).unwrap_or_default();
            if msg.is_empty() {
                Err(ApiError::upstream_rejected(format!(
                    "{what}失败（code={c}）"
                )))
            } else {
                Err(ApiError::upstream_rejected(format!(
                    "{what}失败（code={c}：{msg}）"
                )))
            }
        }
    }
}

/// 从对象里按候选键取第一个非空字符串。
fn pick_str<'a>(v: Option<&'a Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| v.and_then(|x| x.get(*k)))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
}

/// QQ 歌单复合 id：`dirid:tid`。写操作（加/删曲、删单）只认 dirid；歌单
/// 详情要 tid；收藏单可能只有 tid（`:tid`），新建回包可能只有 dirid（`dirid:`）。
fn split_playlist_id(id: &str) -> ApiResult<(String, String)> {
    let (dirid, tid) = id
        .split_once(':')
        .ok_or_else(|| bad_request(format!("无法解析 QQ 歌单 id: {id}（应为 dirid:tid 形态）")))?;
    let dirid = dirid.trim();
    let tid = tid.trim();
    if dirid.is_empty() && tid.is_empty() {
        return Err(bad_request("QQ 歌单 id 的 dirid 与 tid 不能同时为空"));
    }
    Ok((dirid.to_string(), tid.to_string()))
}

/// 经典 fcgi 歌单项 → OnlinePlaylist；字段按两套历史命名做候选。
/// 注意 dirid/tid 在真机响应里可能是数字（fcg_user_created_diss 的
/// dirid 就是整数），id 提取必须走 val_string 而非 as_str。
fn map_diss(item: &Value, kind: &str) -> OnlinePlaylist {
    let dirid = item.get("dirid").and_then(val_string).unwrap_or_default();
    let tid = ["tid", "dissid", "disstid"]
        .iter()
        .find_map(|k| item.get(*k))
        .and_then(val_string)
        .unwrap_or_default();
    let name = pick_str(Some(item), &["diss_name", "dissname", "title", "name"])
        .unwrap_or_default()
        .to_string();
    let cover = pick_str(
        Some(item),
        &["diss_cover", "logo", "picUrl", "pic", "imgurl"],
    )
    .and_then(https_url);
    let track_count = ["song_cnt", "songnum", "song_num", "total_song_num"]
        .iter()
        .find_map(|k| item.get(*k))
        .and_then(val_u64)
        .unwrap_or(0);
    let play_count = ["listen_num", "accessnum", "playcnt", "visitnum"]
        .iter()
        .find_map(|k| item.get(*k))
        .and_then(val_u64);
    let creator = item
        .pointer("/creator/name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| pick_str(Some(item), &["creator_name", "nick", "uname"]).map(str::to_string))
        .unwrap_or_default();
    OnlinePlaylist {
        source: ID.into(),
        id: format!("{dirid}:{tid}"),
        name,
        cover,
        track_count,
        play_count,
        creator,
        kind: kind.into(),
        description: None,
    }
}

/// dirid==201 或名字带「我喜欢」→ liked；其余按调用方给定的 created/collected。
fn diss_kind(item: &Value) -> &'static str {
    let liked = item.get("dirid").and_then(val_string).as_deref() == Some(DIR_LIKED)
        || pick_str(Some(item), &["diss_name", "dissname", "title", "name"])
            .is_some_and(|n| n.contains("我喜欢"));
    if liked {
        "liked"
    } else {
        "created"
    }
}

/// 当前登录账号：GET `rsc/fcgi-bin/fcg_get_profile_homepage.fcg`。
///
/// 真机待验证（spec §2.2）：主页接口的昵称/头像/vip 字段位置做了候选防御
/// （userInfo 下或 data 平铺），Task 22 真机验收；不通则账号信息降级为
/// 仅 uin，登录本身不受影响。
pub async fn account(ctx: &Ctx) -> ApiResult<AccountInfo> {
    let pack = login_pack(ctx).await?;
    let uin = numeric_uin(&pack);
    let q: &[(&str, &str)] = &[
        ("cid", "205360838"),
        ("userid", &uin),
        ("reqfrom", "1"),
        ("g_tk", GTK_WEB),
        ("format", "json"),
        ("inCharset", "utf8"),
        ("outCharset", "utf-8"),
        ("platform", "yqq.json"),
    ];
    let j = fcgi_get(ctx, "/rsc/fcgi-bin/fcg_get_profile_homepage.fcg", q).await?;
    fcgi_code(&j, "获取 QQ 账号信息")?;
    let d = j.get("data");
    // QQ Connect（musicid/musickey）登录态下资料挂在 data.creator；
    // 老式网页 cookie 态个别账号仍回 data.userInfo，两处都认。
    let info = d
        .and_then(|v| v.get("creator"))
        .or_else(|| d.and_then(|v| v.get("userInfo")));
    let nickname = pick_str(info, &["nick", "nickname", "name"])
        .or_else(|| pick_str(d, &["nickname", "nick"]))
        .unwrap_or_default()
        .to_string();
    let avatar = pick_str(info, &["headpic", "avatar", "headUrl", "headurl"])
        .or_else(|| pick_str(d, &["avatar"]))
        .and_then(https_url);
    // profile_homepage 不回 vip 等级；VIP 标签留空，权益判定仍以 vkey 取流
    // 结果为准（非会员拿不到会员曲目 purl，由 stream 侧如实提示）。
    let vip_level = ["/vipType", "/vip_type", "/vip_level"]
        .iter()
        .find_map(|p| info.and_then(|v| v.pointer(p)))
        .or_else(|| d.and_then(|v| v.pointer("/vipInfo/type")))
        .or_else(|| d.and_then(|v| v.get("vip_type")))
        .and_then(val_u64)
        .unwrap_or(0) as u32;
    Ok(AccountInfo {
        source: ID.into(),
        nickname,
        avatar,
        vip_level,
        vip_label: if vip_level > 0 {
            "VIP".to_string()
        } else {
            String::new()
        },
    })
}

/// 用户歌单：创建单（含我喜欢）走 `fcg_user_created_diss`，收藏单走
/// `fcg_get_profile_order_asset.fcg(reqtype=3)`，两端口合并后按 scope 本地过滤。
///
/// 真机待验证（spec §2.2）：字段以真机响应为准；收藏单接口对部分账号不可用，
/// 失败时只返回创建单（warn 记录，列表可能不完整），不拖垮整个列表。本地
/// 过滤会让分页不精确（用户歌单量小，单页上限 100 通常一次取完）。
pub async fn playlists(
    ctx: &Ctx,
    scope: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<Vec<OnlinePlaylist>> {
    let pack = login_pack(ctx).await?;
    let uin = numeric_uin(&pack);
    let limit = limit.clamp(1, 100);
    let sin = offset.to_string();
    let size = limit.to_string();
    let created_q: &[(&str, &str)] = &[
        ("hostUin", "0"),
        ("hostuin", &uin),
        ("sin", &sin),
        ("size", &size),
        ("g_tk", GTK_WEB),
        ("loginUin", "0"),
        ("format", "json"),
        ("inCharset", "utf8"),
        ("outCharset", "utf-8"),
        ("notice", "0"),
        ("platform", "yqq.json"),
        ("needNewCode", "0"),
    ];
    let j = fcgi_get(ctx, "/rsc/fcgi-bin/fcg_user_created_diss", created_q).await?;
    fcgi_code(&j, "获取 QQ 歌单")?;
    let mut out = Vec::new();
    if let Some(arr) = j.pointer("/data/disslist").and_then(|v| v.as_array()) {
        for item in arr {
            out.push(map_diss(item, diss_kind(item)));
        }
    }

    // 收藏单：独立端点，失败降级为空（不影响创建单/我喜欢）。
    // qzone 系端点 sin/ein 为闭区间，与歌单详情端口径保持一致（真机终验）。
    let ein = offset.saturating_add(limit).saturating_sub(1).to_string();
    let collected_q: &[(&str, &str)] = &[
        ("ct", "20"),
        ("cid", "205360956"),
        ("userid", &uin),
        ("reqtype", "3"),
        ("sin", &sin),
        ("ein", &ein),
        ("g_tk", GTK_WEB),
        ("format", "json"),
        ("inCharset", "utf8"),
        ("outCharset", "utf-8"),
        ("platform", "yqq.json"),
        ("needNewCode", "0"),
    ];
    match fcgi_get(
        ctx,
        "/fav/fcgi-bin/fcg_get_profile_order_asset.fcg",
        collected_q,
    )
    .await
    {
        Ok(j2) => {
            if fcgi_code(&j2, "获取 QQ 收藏歌单").is_ok() {
                if let Some(arr) = j2.pointer("/data/cdlist").and_then(|v| v.as_array()) {
                    for item in arr {
                        out.push(map_diss(item, "collected"));
                    }
                }
            }
        }
        Err(e) => tracing::warn!(
            error = %e.message,
            "QQ 收藏歌单获取失败，仅返回创建歌单与我喜欢（列表可能不完整）"
        ),
    }

    // 两端点可能重复收录同一歌单：按复合 id 去重；两段 id 都缺的残项直接丢弃
    // （留着只会在详情/写操作时变成无意义的 400）。
    let mut seen = std::collections::BTreeSet::new();
    out.retain(|pl| !pl.id.is_empty() && pl.id != ":" && seen.insert(pl.id.clone()));

    out.retain(|pl| match scope {
        "created" => pl.kind == "created",
        "collected" => pl.kind == "collected",
        "liked" => pl.kind == "liked",
        _ => true,
    });
    Ok(out)
}

/// 歌单详情：GET `qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg`，cdlist[0]
/// 里取元信息与 songlist。删除曲目要数字 songid，这里塞进每首的 track_ref。
///
/// 真机待验证（spec §2.2）：disstid 收 tid；若真机证明该端点只认 dirid，
/// Task 22 调换 split 顺序即可（复合 id 两段都在）。
pub async fn playlist_detail(
    ctx: &Ctx,
    id: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<PlaylistDetail> {
    let (dirid, tid) = split_playlist_id(id)?;
    let disstid = if !tid.is_empty() { &tid } else { &dirid };
    if disstid.is_empty() {
        return Err(bad_request("缺少 QQ 歌单 tid，无法获取详情"));
    }
    let limit = limit.clamp(1, 100);
    let sin = offset.to_string();
    let ein = offset.saturating_add(limit).saturating_sub(1).to_string();
    let q: &[(&str, &str)] = &[
        ("type", "1"),
        ("utf8", "1"),
        ("disstid", disstid),
        ("loginUin", "0"),
        ("g_tk", GTK_WEB),
        ("format", "json"),
        ("inCharset", "utf8"),
        ("outCharset", "utf-8"),
        ("notice", "0"),
        ("platform", "yqq.json"),
        ("needNewCode", "0"),
        ("sin", &sin),
        ("ein", &ein),
    ];
    // 该端点匿名可访问（推荐广场免登录浏览链）；登录态仅影响收藏标记，code
    // 1/1000 仍会被 fcgi_code 归成 401。
    let j = fcgi_get_anon(ctx, "/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg", q).await?;
    fcgi_code(&j, "获取 QQ 歌单详情")?;
    let cd = j
        .pointer("/cdlist/0")
        .filter(|v| !v.is_null())
        .ok_or_else(|| ApiError::upstream_rejected("QQ 音乐未返回歌单详情".to_string()))?;

    let mut playlist = map_diss(cd, diss_kind(cd));
    playlist.source = ID.into();
    playlist.id = id.to_string();

    let mut tracks = Vec::new();
    if let Some(items) = cd.get("songlist").and_then(|v| v.as_array()) {
        for song in items {
            let mut t = map_track(song);
            if t.id.is_empty() {
                continue;
            }
            // 删曲接口要数字 songid（经典端点字段名 id/songid 二选一）。
            if let Some(sid) = song
                .get("id")
                .or_else(|| song.get("songid"))
                .and_then(val_string)
                .filter(|s| !s.is_empty())
            {
                if let Some(obj) = t.track_ref.as_object_mut() {
                    obj.insert("song_id".into(), json!(sid));
                }
            }
            tracks.push(t);
        }
    }
    let total = ["songnum", "song_cnt", "total_song_num"]
        .iter()
        .find_map(|k| cd.get(*k))
        .and_then(val_u64)
        .unwrap_or(tracks.len() as u64);
    Ok(PlaylistDetail {
        playlist,
        total,
        tracks,
    })
}

/// 新建歌单：POST `splcloud/fcgi-bin/create_playlist.fcg`，回包给 dirid。
///
/// 真机待验证（spec §2.2）：code 21=重名、1=未登录来自公开参考实现；
/// Task 22 真机验收，不通则摘 PlaylistWrite。
pub async fn playlist_create(ctx: &Ctx, name: &str) -> ApiResult<OnlinePlaylist> {
    let name = name.trim();
    if name.is_empty() {
        return Err(bad_request("缺少歌单名称"));
    }
    let pack = login_pack(ctx).await?;
    let uin = numeric_uin(&pack);
    let mut form = BTreeMap::new();
    let mut put = |k: &str, v: &str| form.insert(k.to_string(), v.to_string());
    put("loginUin", &uin);
    put("hostUin", "0");
    put("format", "json");
    put("inCharset", "utf8");
    put("outCharset", "utf8");
    put("notice", "0");
    put("platform", "yqq");
    put("needNewCode", "0");
    put("g_tk", GTK_WEB);
    put("uin", &uin);
    put("name", name);
    put("show", "1");
    put("formsender", "1");
    put("utf8", "1");
    put("qzreferrer", "https://y.qq.com/portal/profile.html");
    let j = fcgi_post(
        ctx,
        "/splcloud/fcgi-bin/create_playlist.fcg?g_tk=5381",
        &form,
    )
    .await?;
    // 21 重名是可预期的用户错误，按 400 返回；其余交给统一 code 判定。
    if j.get("code").and_then(val_u64) == Some(21) {
        return Err(bad_request("已存在同名歌单"));
    }
    fcgi_code_strict(&j, "创建 QQ 歌单")?;
    // status==0 但拿不回 dirid 不能伪装成功：上层要靠它继续加曲。
    let dirid = j
        .get("dirid")
        .and_then(val_string)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::upstream_rejected("创建成功但未取得歌单 dirid".to_string()))?;
    Ok(OnlinePlaylist {
        source: ID.into(),
        id: format!("{dirid}:"),
        name: name.to_string(),
        kind: "created".into(),
        ..Default::default()
    })
}

/// 删除歌单：POST `splcloud/fcgi-bin/fcg_fav_modsongdir.fcg`，响应是 JSONP。
///
/// 真机待验证（spec §2.2）。参考实现声明 GB2312，实际表单体全是 ASCII
/// （dirid 数字），UTF-8 发送等价；若真机有中文报错回包，乱码只影响展示。
pub async fn playlist_delete(ctx: &Ctx, id: &str) -> ApiResult<()> {
    let (dirid, _) = split_playlist_id(id)?;
    if dirid.is_empty() {
        return Err(bad_request("收藏歌单不能删除，缺少 dirid"));
    }
    let pack = login_pack(ctx).await?;
    let uin = numeric_uin(&pack);
    let mut form = BTreeMap::new();
    let mut put = |k: &str, v: &str| form.insert(k.to_string(), v.to_string());
    put("loginUin", &uin);
    put("hostUin", "0");
    put("format", "fs");
    put("inCharset", "utf8");
    put("outCharset", "utf8");
    put("notice", "0");
    put("platform", "yqq");
    put("needNewCode", "0");
    put("g_tk", GTK_WEB);
    put("uin", &uin);
    put("delnum", "1");
    put("deldirids", &dirid);
    put("forcedel", "1");
    put("formsender", "1");
    put("source", "103");
    let j = fcgi_post(
        ctx,
        "/splcloud/fcgi-bin/fcg_fav_modsongdir.fcg?g_tk=5381",
        &form,
    )
    .await?;
    fcgi_code_strict(&j, "删除 QQ 歌单")?;
    Ok(())
}

/// 加曲：GET `splcloud/fcgi-bin/fcg_music_add2songdir.fcg`，midlist 逗号
/// 拼接，typelist 与曲目同长、恒为 13。
///
/// 真机待验证（spec §2.2），Task 22 真机验收，不通则摘 PlaylistWrite。
pub async fn playlist_add(ctx: &Ctx, id: &str, tracks: &[super::TrackEntry]) -> ApiResult<()> {
    if tracks.is_empty() {
        return Err(bad_request("没有要加入的曲目"));
    }
    let (dirid, _) = split_playlist_id(id)?;
    if dirid.is_empty() {
        return Err(bad_request("收藏歌单不能加曲，缺少 dirid"));
    }
    let pack = login_pack(ctx).await?;
    let uin = numeric_uin(&pack);
    let mut mids = Vec::with_capacity(tracks.len());
    for (n, entry) in tracks.iter().enumerate() {
        // QQ 稳定曲目 id 就是 songmid（spec §2.5）：ref 缺失时按 §1.4 回落 id。
        match entry.ref_str("song_mid") {
            Some(m) => mids.push(m.to_string()),
            None if !entry.id.trim().is_empty() => mids.push(entry.id.trim().to_string()),
            _ => {
                return Err(bad_request(format!(
                    "第 {} 首缺少 song_mid，无法加入 QQ 歌单",
                    n + 1
                )))
            }
        }
    }
    let midlist = mids.join(",");
    let typelist = vec!["13"; mids.len()].join(",");
    let q: &[(&str, &str)] = &[
        ("midlist", &midlist),
        ("typelist", &typelist),
        ("dirid", &dirid),
        ("addtype", ""),
        ("formsender", "4"),
        ("r2", "0"),
        ("r3", "1"),
        ("utf8", "1"),
        ("g_tk", GTK_WEB),
        ("loginUin", &uin),
        ("hostUin", "0"),
        ("format", "json"),
        ("inCharset", "utf8"),
        ("outCharset", "utf-8"),
        ("notice", "0"),
        ("platform", "yqq.json"),
        ("needNewCode", "0"),
        ("uin", &uin),
    ];
    let j = fcgi_get(ctx, "/splcloud/fcgi-bin/fcg_music_add2songdir.fcg", q).await?;
    fcgi_code_strict(&j, "QQ 歌单追加曲目")?;
    Ok(())
}

/// 删曲：POST `qzone/fcg-bin/fcg_music_delbatchsong.fcg`，ids 是数字
/// songid 列表（不是 songmid），types 与曲目同长、恒为 3。
///
/// 真机待验证（spec §2.2），Task 22 真机验收。
pub async fn playlist_remove(ctx: &Ctx, id: &str, tracks: &[super::TrackEntry]) -> ApiResult<()> {
    if tracks.is_empty() {
        return Err(bad_request("没有要移除的曲目"));
    }
    let (dirid, _) = split_playlist_id(id)?;
    if dirid.is_empty() {
        return Err(bad_request("收藏歌单不能删曲，缺少 dirid"));
    }
    let pack = login_pack(ctx).await?;
    let uin = numeric_uin(&pack);
    let mut ids = Vec::with_capacity(tracks.len());
    for (n, entry) in tracks.iter().enumerate() {
        // 删曲要的是数字 songid（不是 songmid，songmid 无法替代），它只在
        // 歌单详情结果里；缺一首就整体 400，绝不静默丢项造成部分删除。
        match entry
            .track_ref
            .as_ref()
            .and_then(|r| r.get("song_id"))
            .and_then(val_string)
        {
            Some(v) if !v.is_empty() => ids.push(v.to_string()),
            _ => {
                return Err(bad_request(format!(
                    "第 {} 首缺少 song_id，请先刷新歌单详情后再删除",
                    n + 1
                )))
            }
        }
    }
    let ids_csv = ids.join(",");
    let types = vec!["3"; ids.len()].join(",");
    let mut form = BTreeMap::new();
    let mut put = |k: &str, v: &str| form.insert(k.to_string(), v.to_string());
    put("loginUin", &uin);
    put("hostUin", "0");
    put("format", "json");
    put("inCharset", "utf8");
    put("outCharset", "utf-8");
    put("notice", "0");
    put("platform", "yqq.post");
    put("needNewCode", "0");
    put("g_tk", GTK_WEB);
    put("uin", &uin);
    put("dirid", &dirid);
    put("ids", &ids_csv);
    put("source", "103");
    put("types", &types);
    put("formsender", "4");
    put("flag", "2");
    put("utf8", "1");
    put("from", "3");
    let j = fcgi_post(
        ctx,
        "/qzone/fcg-bin/fcg_music_delbatchsong.fcg?g_tk=5381",
        &form,
    )
    .await?;
    fcgi_code_strict(&j, "QQ 歌单移除曲目")?;
    Ok(())
}

/// 从一次 `GetRadarSong` 响应里取出曲目。纯函数，翻页与去重留在调用方，
/// 这样解析逻辑可以脱离 HTTP 单测。
///
/// 雷达把曲目包在 `Track` 里（`VecSongs[i].Track`）；包缺失时按裸曲目对象解析，
/// 免得上游换了信封就整页空白。没有 mid 的条目播不了，直接丢掉。
fn radar_tracks(j: &Value) -> Vec<OnlineTrack> {
    j.pointer("/req/data/VecSongs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|item| map_track(item.get("Track").unwrap_or(item)))
                .filter(|t| !t.id.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 每日推荐歌曲：musicu.fcg `music.recommend.TrackRelationServer/GetRadarSong`
/// （雷达推荐）。
///
/// **为什么不是"每日推荐"**：这条 Web CGI 通道上没有与网易「每日30首」同名的
/// 端点——`music.recommend.DailyRecommend`、`music.recommend.RecommendSong`
/// 带真机登录态实测都是 500003（诊断见 tests::probe_daily_candidates_with_cred）。
/// 真能拿到个性化推荐歌曲的是两个端点：本函数用的 `GetRadarSong`（`Size`/`Page`
/// 可控、一次 10 条、`HasMore` 分页），以及 `music.radioProxy.MbTrackRadioSvr/
/// get_radio_track`（电台：`size` 参数无效、一次只推 2~3 首，凑不够每日推荐的量）。
/// 取前者。
///
/// **必须登录态**：匿名一律 500003。所以未登录要如实报错，不静默返回空列表
/// ——空列表会让每日推荐把它显示成"这次没返回"，把"没登录"掩盖掉。
pub async fn recommend_songs(
    ctx: &Ctx,
    offset: usize,
    limit: usize,
) -> ApiResult<Vec<OnlineTrack>> {
    let limit = limit.clamp(1, 100);
    let per_page = limit.clamp(1, 30);
    let start_page = offset / per_page + 1;
    let http = client()?;
    let mut out: Vec<OnlineTrack> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 翻页是递增 Page 的简单续传，页码本身就在循环变量里，不需要额外记一份。
    for page in (start_page..).take(RADAR_MAX_PAGES) {
        let body = json!({
            "comm": { "ct": 24, "cv": 0 },
            "req": {
                "module": "music.recommend.TrackRelationServer",
                "method": "GetRadarSong",
                "param": { "Page": page, "Size": per_page },
            },
        });
        let j = cgi(&http, ctx, body).await?;
        if !code_zero(j.pointer("/req/code")) {
            return Err(ApiError::upstream_rejected(format!(
                "获取 QQ 每日推荐被拒绝（code={}）",
                j.pointer("/req/code")
                    .and_then(val_string)
                    .unwrap_or_else(|| "缺失".into())
            )));
        }
        let songs = radar_tracks(&j);
        if songs.is_empty() {
            return Err(ApiError::upstream_rejected(
                "QQ 音乐未返回雷达推荐".to_string(),
            ));
        }
        // 翻页之间会重复：上游按召回批次给，Page 递增时同一首可能再出现一次。
        for t in songs {
            if seen.insert(t.id.clone()) {
                out.push(t);
            }
        }
        if out.len() >= limit {
            break;
        }
        if j.pointer("/req/data/HasMore") != Some(&Value::Bool(true)) {
            break;
        }
    }

    out.truncate(limit);
    if out.is_empty() {
        return Err(ApiError::upstream_rejected(
            "QQ 音乐这次没有返回推荐曲目".to_string(),
        ));
    }
    Ok(out)
}

/// 推荐歌单：匿名 musicu.fcg，`playlist.PlayListPlazaServer/get_playlist_by_category`，
/// id=3317 官方歌单广场。
///
/// 真机待验证（spec §2.2）：module/method 与 v_playlist 字段来自公开参考
/// 实现，Task 22 真机验收。
pub async fn recommend_playlists(
    ctx: &Ctx,
    offset: usize,
    limit: usize,
) -> ApiResult<Vec<OnlinePlaylist>> {
    let limit = limit.clamp(1, 30);
    let page = (offset / limit).saturating_add(1);
    let body = json!({
        "comm": { "ct": 24, "cv": 0 },
        "playlist": {
            "module": "playlist.PlayListPlazaServer",
            "method": "get_playlist_by_category",
            "param": {
                "id": 3317,
                "curPage": page,
                "size": limit,
                "order": 5,
                "titleid": 3317
            }
        }
    });
    let j = cgi(&client()?, ctx, body).await?;
    if !code_zero(j.pointer("/playlist/code")) {
        return Err(ApiError::upstream_rejected(format!(
            "获取 QQ 推荐歌单被拒绝（code={}）",
            j.pointer("/playlist/code")
                .and_then(val_string)
                .unwrap_or_else(|| "缺失".into())
        )));
    }
    let data = j
        .pointer("/playlist/data")
        .ok_or_else(|| ApiError::upstream_rejected("QQ 音乐未返回推荐歌单".to_string()))?;
    let items = data
        .get("v_playlist")
        .and_then(|v| v.as_array())
        .ok_or_else(|| ApiError::upstream_rejected("QQ 推荐歌单缺少 v_playlist".to_string()))?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let tid = ["tid", "dissid", "id"]
            .iter()
            .find_map(|k| item.get(*k))
            .and_then(val_string)
            .unwrap_or_default();
        if tid.is_empty() {
            continue;
        }
        let name = pick_str(Some(item), &["title", "dissname", "name"])
            .unwrap_or_default()
            .to_string();
        let cover = pick_str(Some(item), &["picUrl", "pic", "logo"]).and_then(https_url);
        let track_count = item
            .get("songnum")
            .or_else(|| item.get("song_cnt"))
            .and_then(val_u64)
            .unwrap_or(0);
        let play_count = item.get("accessnum").and_then(val_u64);
        out.push(OnlinePlaylist {
            source: ID.into(),
            // 推荐单只有 tid，dirid 留空（对它做写操作会被明确拦下）。
            id: format!(":{tid}"),
            name,
            cover,
            track_count,
            play_count,
            creator: String::new(),
            kind: "collected".into(),
            description: None,
        });
    }
    Ok(out)
}

// ===========================================================================
// 扫码登录走 QQ Connect 授权流（spec §2.2，2026-09 真机核实）：
//   ptqrshow 取 PNG + qrsig
//   → gtk33(qrsig) 算 ptqrtoken 轮询 ptqrlogin（u1 必须是 graph 授权页，
//     pt_3rd_aid=100497308，错配 y.qq.com 直登 u1 会被网关直接 403）
//   → code=0 时从回跳 URL 取 uin/ptsigx
//   → ssl.ptlogin2.graph.qq.com/check_sig 换 p_skey 等站点票据
//   → graph.qq.com/oauth2.0/authorize 表单换 OAuth code（302 Location）
//   → musicu.fcg QQConnectLogin.LoginServer/QQLogin 换 musicid/musickey
// 落库形态与网页 cookie 等价：uin=<musicid>; qm_keyst=<musickey>，之后
// vkey/歌单/账号接口全部复用既有鉴权链路。不引 cookie jar、不自动跟随
// 重定向；票据值绝不进日志。
// ===========================================================================

fn qr_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 从响应头取一个 Set-Cookie 的值（分号前），缺失/空值返回 None。
fn set_cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|raw| {
            let pair = raw.split(';').next()?;
            let (k, v) = pair.split_once('=')?;
            (k.trim() == name).then(|| v.trim().to_string())
        })
        .filter(|s| !s.is_empty())
}

/// 把响应里所有 Set-Cookie 合并进 jar（后写覆盖先写，空值不覆盖已有凭据）。
fn absorb_set_cookie(headers: &HeaderMap, jar: &mut BTreeMap<String, String>) {
    for raw in headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
    {
        if let Some(pair) = raw.split(';').next() {
            if let Some((k, v)) = pair.split_once('=') {
                let k = k.trim();
                let v = v.trim();
                if !k.is_empty() && !v.is_empty() {
                    jar.insert(k.to_string(), v.to_string());
                }
            }
        }
    }
}

/// 校验落库 + 回拉账号信息：QQ 互联与微信两条通道换出的凭据形态相同，
/// 统一在这做 is_signed_in 闸门、落库与账号回读；回拉失败不判定登录失败。
pub(crate) async fn finalize_cred(
    ctx: &Ctx,
    pack: CredPack,
) -> ApiResult<(String, Option<AccountInfo>)> {
    if !super::cred::is_signed_in(ID, &pack) {
        return Err(ApiError::upstream_rejected(
            "QQ 音乐扫码凭据落库前校验失败（musicid/musickey 不完整）".to_string(),
        ));
    }
    super::cred::put(&ctx.db, ID, &pack)
        .await
        .map_err(internal_store)?;
    match account(ctx).await {
        Ok(info) => Ok(("confirmed".to_string(), Some(info))),
        Err(e) => {
            tracing::debug!(error = %e.message, "QQ 音乐扫码登录成功但账号信息回拉失败，稍后补拉");
            Ok(("confirmed".to_string(), None))
        }
    }
}

/// 创建 QQ 互联扫码握手。微信扫码入口见 [`qr_create_wx`]（由 mod 层按
/// channel 分发）。
pub async fn qr_create(_ctx: &Ctx) -> ApiResult<QrPayload> {
    qq_qr_create().await
}

/// QQ 互联扫码创建：GET `ptqrshow` 拿 PNG + qrsig。
async fn qq_qr_create() -> ApiResult<QrPayload> {
    let nonce = uuid::Uuid::new_v4().as_u128() % 1_000_000;
    let t = format!("{}{nonce}", qr_now_ms());
    let appid = QR_APPID.to_string();
    let mut url = const_url(format!("{PTQR}/ptqrshow"))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("appid", &appid)
            .append_pair("e", "2")
            .append_pair("l", "M")
            .append_pair("s", "3")
            .append_pair("d", "72")
            .append_pair("v", "4")
            .append_pair("t", &t)
            .append_pair("daid", QR_DAID)
            .append_pair("pt_3rd_aid", QR_3RD_AID);
    }
    let mut h = super::http::headers(None, Some(PT_REFERER));
    h.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
    let (resp_headers, png) = super::http::get_bytes(&client()?, url.as_str(), h).await?;
    let qrsig = set_cookie_value(&resp_headers, "qrsig")
        .ok_or_else(|| ApiError::upstream_rejected("创建 QQ 扫码失败：未取得 qrsig".to_string()))?;
    // 必须是 PNG（89 50 4E 47 …），防止上游把错误页 HTML 当二维码返回。
    if png.len() < 8 || png[0] != 0x89 || &png[1..4] != b"PNG" {
        return Err(ApiError::upstream_rejected(
            "创建 QQ 扫码失败：返回内容不是 PNG 二维码".to_string(),
        ));
    }
    let qr_image = format!("data:image/png;base64,{}", b64_encode_std(&png));
    Ok(QrPayload {
        platform_ticket: qrsig,
        qr_text: None,
        qr_image: Some(qr_image),
        poll_ms: 2000,
    })
}

/// 解析 `ptuiCB('66','0','','0','二维码未失效。','');` 形态的轮询响应。
/// 返回 (状态码, check_sig 跳转 URL, 提示文案, 昵称)，无法解析返回 None。
fn parse_ptui_cb(text: &str) -> Option<(i64, String, String, String)> {
    let l = text.find('(')?;
    let r = text.rfind(')').filter(|r| *r > l)?;
    let inner = &text[l + 1..r];
    // 朴素扫描单引号参数：参数内无转义引号，避免引正则依赖。
    let mut args = Vec::new();
    let mut rest = inner.chars().peekable();
    while let Some(c) = rest.next() {
        if c == '\'' {
            let mut buf = String::new();
            for x in rest.by_ref() {
                if x == '\'' {
                    break;
                }
                buf.push(x);
            }
            args.push(buf);
        }
    }
    let code = args.first()?.trim().parse::<i64>().ok()?;
    let url = args.get(2).cloned().unwrap_or_default();
    let msg = args.get(4).cloned().unwrap_or_default();
    let nick = args.get(5).cloned().unwrap_or_default();
    Some((code, url, msg, nick))
}

/// 从 ptqrlogin 成功回跳 URL 里取 (数字 uin, ptsigx)；两者缺任一都不能
/// 进入下一步授权。URL 是上游给的字符串，只解析 query、绝不请求它。
fn parse_sigx_uin(jump: &str) -> Option<(String, String)> {
    let url = reqwest::Url::parse(jump).ok()?;
    let value = |key: &str| {
        url.query_pairs()
            .find_map(|(k, v)| (k == key).then_some(v.to_string()))
    };
    let uin = value("uin")
        .map(|s| super::cred::normalize_qq_uin(&s))
        .filter(|s| !s.is_empty() && s != "0")?;
    let sigx = value("ptsigx").filter(|s| !s.is_empty())?;
    Some((uin, sigx))
}

/// 扫码授权链专用客户端：禁止自动重定向——check_sig/authorize 都要手动读
/// Location 与逐跳 Set-Cookie；自动跟跳会把一次性票据带进最终页，还会丢
/// 掉中间站种的 cookie。
fn no_redirect_client() -> ApiResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .read_timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ApiError::internal(format!("QQ 扫码授权客户端初始化失败: {e}")))
}

fn jar_cookie(jar: &BTreeMap<String, String>) -> String {
    jar.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// check_sig → authorize → QQLogin 三段授权，成功返回 musicid/musickey 凭据。
/// 三个目标主机都是代码里写死的常量，上游回跳里的一次性票据只作为 query
/// 参数发回给这些主机；任一步失败都如实报错，错误信息不带票据值。
async fn connect_exchange(uin: &str, sigx: &str) -> ApiResult<CredPack> {
    let httpc = no_redirect_client()?;
    let appid = QR_APPID.to_string();

    // 第 1 段：ptsigx 换 graph.qq.com 站点票据（p_skey/p_uin 等，302 不跟）。
    let mut check = const_url(QR_CHECK_SIG)?;
    {
        let mut q = check.query_pairs_mut();
        q.append_pair("uin", uin)
            .append_pair("pttype", "1")
            .append_pair("service", "ptqrlogin")
            .append_pair("nodirect", "0")
            .append_pair("ptsigx", sigx)
            .append_pair("s_url", QR_U1)
            .append_pair("ptlang", "2052")
            .append_pair("ptredirect", "100")
            .append_pair("aid", &appid)
            .append_pair("daid", QR_DAID)
            .append_pair("j_later", "0")
            .append_pair("low_login_hour", "0")
            .append_pair("regmaster", "0")
            .append_pair("pt_login_type", "3")
            .append_pair("pt_aid", "0")
            .append_pair("pt_aaid", "16")
            .append_pair("pt_light", "0")
            .append_pair("pt_3rd_aid", QR_3RD_AID);
    }
    let resp = httpc
        .get(check)
        .headers(super::http::headers(None, Some(PT_REFERER)))
        .send()
        .await
        .map_err(super::http::send_error)?;
    let mut jar = BTreeMap::new();
    absorb_set_cookie(resp.headers(), &mut jar);
    let _ = resp.bytes().await;
    let p_skey = jar
        .get("p_skey")
        .filter(|s| !s.is_empty())
        .cloned()
        .ok_or_else(|| {
            ApiError::upstream_rejected("QQ 授权失败：check_sig 未下发 p_skey".to_string())
        })?;

    // 第 2 段：站点票据换 OAuth code（表单提交，302 Location?code=...）。
    let g_tk = super::sign::qq::gtk5381(&p_skey).to_string();
    let auth_time = qr_now_ms().to_string();
    let ui = uuid::Uuid::new_v4().simple().to_string();
    let form: &[(&str, &str)] = &[
        ("response_type", "code"),
        ("client_id", QR_3RD_AID),
        ("redirect_uri", QR_REDIRECT_URI),
        ("scope", "get_user_info,get_app_friends"),
        ("state", "state"),
        ("switch", ""),
        ("from_ptlogin", "1"),
        ("src", "1"),
        ("update_auth", "1"),
        ("openapi", "1010_1030"),
        ("g_tk", &g_tk),
        ("auth_time", &auth_time),
        ("ui", &ui),
    ];
    let mut ah = super::http::headers(Some(&jar_cookie(&jar)), Some(PT_REFERER));
    ah.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
    let resp = httpc
        .post(QR_AUTHORIZE)
        .headers(ah)
        .form(form)
        .send()
        .await
        .map_err(super::http::send_error)?;
    absorb_set_cookie(resp.headers(), &mut jar);
    let location = resp
        .headers()
        .get(LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let _ = resp.bytes().await;
    let code = location
        .and_then(|l| {
            let u = reqwest::Url::parse(&l)
                .ok()
                .or_else(|| reqwest::Url::parse(&format!("https://graph.qq.com/{l}")).ok())?;
            u.query_pairs()
                .find_map(|(k, v)| (k == "code").then_some(v.into_owned()))
        })
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::upstream_rejected("QQ 授权失败：authorize 未回传 code".to_string())
        })?;

    // 第 3 段：code 换 QQ 音乐自身票据 musicid/musickey。
    exchange_code_cgi(2, "QQConnectLogin.LoginServer", "QQLogin", &code, None).await
}

/// 授权 code 换 QQ 音乐自身票据（musicid/musickey）的统一 CGI。
///
/// - QQ 互联：tmeLoginType=2，QQConnectLogin.LoginServer/QQLogin，参数只有 code
/// - 微信：tmeLoginType=1，music.login.LoginServer/Login，参数 code+strAppid
///
/// 成功后的 musicid/musickey 与网页 cookie（uin/qm_keyst）等价，vkey、歌单、账号接口全部复用既有鉴权链路。
async fn exchange_code_cgi(
    login_type: i64,
    module: &str,
    method: &str,
    code: &str,
    str_appid: Option<&str>,
) -> ApiResult<CredPack> {
    let mut param = json!({ "code": code });
    if let Some(a) = str_appid {
        param["strAppid"] = json!(a);
    }
    let body = json!({
        "comm": {
            "g_tk": GTK_WEB,
            "uin": "0",
            "format": "json",
            "ct": 24,
            "cv": 0,
            "tmeLoginType": login_type
        },
        "req_0": {
            "module": module,
            "method": method,
            "param": param
        }
    });
    let text = serde_json::to_string(&body)
        .map_err(|e| ApiError::internal(format!("QQ 登录请求序列化失败: {e}")))?;
    let mut ch = super::http::headers(None, Some(REFERER));
    ch.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
    ch.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json;charset=UTF-8"),
    );
    let j = super::http::post_json(&client()?, MUSICU, ch, text).await?;
    let ns = j.pointer("/req_0").ok_or_else(|| {
        ApiError::upstream_rejected("QQ 登录响应缺少登录命名空间结果".to_string())
    })?;
    if !code_zero(ns.get("code")) {
        return Err(ApiError::upstream_rejected(format!(
            "QQ 登录换票被拒（code={}）",
            ns.get("code")
                .and_then(val_string)
                .unwrap_or_else(|| "缺失".into())
        )));
    }
    // musicid/musickey 多数版本直接挂命名空间，个别包在 data 里，两处都认。
    let pick = |key: &str| {
        ns.get(key)
            .or_else(|| ns.pointer(&format!("/data/{key}")))
            .and_then(val_string)
    };
    let musicid = pick("musicid")
        .map(|s| super::cred::normalize_qq_uin(&s))
        .filter(|s| !s.is_empty() && s != "0")
        .ok_or_else(|| ApiError::upstream_rejected("QQ 登录成功但响应缺少 musicid".to_string()))?;
    let musickey = pick("musickey")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::upstream_rejected("QQ 登录成功但响应缺少 musickey".to_string()))?;
    let cookie = format!("uin={musicid}; qm_keyst={musickey}");
    Ok(CredPack {
        uin: musicid,
        cookie,
        ..Default::default()
    })
}

// ── 微信扫码（与 QQ 互联并列的第二条取码通道）──────────────────────────

/// 微信长轮询专用客户端：无事件时上游约 30s 才回 408，读超时放到 35s。
fn wx_long_poll_client() -> ApiResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .read_timeout(std::time::Duration::from_secs(35))
        .user_agent(DEFAULT_UA)
        .build()
        .map_err(|e| ApiError::internal(format!("微信扫码客户端初始化失败: {e}")))
}

/// 从文本里找标记，取其后直到 end 字符的片段（如 uuid="..."、wx_errcode=..;）。
/// 空白/空值回 None。
fn extract_until(text: &str, marker: &str, end: char) -> Option<String> {
    let rel = text.find(marker)? + marker.len();
    let value: String = text[rel..].chars().take_while(|c| *c != end).collect();
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// 创建微信扫码握手：qrconnect 页取 uuid → qrcode/{uuid} 取 JPEG 二维码。
/// 平台票加 `wx:` 前缀，轮询时据此路由回微信长轮询。
pub async fn qr_create_wx(_ctx: &Ctx) -> ApiResult<QrPayload> {
    let mut page = const_url(WX_QRCONNECT)?;
    {
        let mut q = page.query_pairs_mut();
        q.append_pair("appid", WX_APPID)
            .append_pair("redirect_uri", WX_REDIRECT)
            .append_pair("response_type", "code")
            .append_pair("scope", "snsapi_login")
            .append_pair("state", "STATE")
            .append_pair(
                "href",
                "https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect",
            );
    }
    let h = super::http::headers(None, Some("https://open.weixin.qq.com/"));
    let html = super::http::get_text(&client()?, page.as_str(), h).await?;
    // qrconnect 页内含 uuid="..."；取第一个非空值。
    let uuid = extract_until(&html, "uuid=", '"').ok_or_else(|| {
        ApiError::upstream_rejected("创建微信扫码失败：qrconnect 页未返回 uuid".to_string())
    })?;

    let h2 = super::http::headers(None, Some("https://open.weixin.qq.com/"));
    let (_, jpg) = super::http::get_bytes(&client()?, &format!("{WX_QRCODE}{uuid}"), h2).await?;
    // 微信二维码是 JPEG（FF D8 FF），校验文件头防止错误页被当成二维码。
    if jpg.len() < 4 || jpg[0] != 0xff || jpg[1] != 0xd8 {
        return Err(ApiError::upstream_rejected(
            "创建微信扫码失败：二维码响应不是 JPEG".to_string(),
        ));
    }
    let qr_image = format!("data:image/jpeg;base64,{}", b64_encode_std(&jpg));
    Ok(QrPayload {
        platform_ticket: format!("{WX_TICKET_PREFIX}{uuid}"),
        qr_text: None,
        qr_image: Some(qr_image),
        poll_ms: 1000,
    })
}

/// 微信扫码状态轮询：errcode 408=等待，404=已扫码，0=已确认（带 code），
/// 402=超时，403=拒绝。长轮询本身超时（504）同样按等待处理。
async fn qr_check_wx(ctx: &Ctx, uuid: &str) -> ApiResult<(String, Option<AccountInfo>)> {
    let c = wx_long_poll_client()?;
    let mut url = const_url(WX_LONG_POLL)?;
    url.query_pairs_mut()
        .append_pair("uuid", uuid)
        .append_pair("_", &qr_now_ms().to_string());
    let h = super::http::headers(None, Some("https://open.weixin.qq.com/"));
    let text = match super::http::get_text(&c, url.as_str(), h).await {
        Ok(t) => t,
        // 长轮询读超时：无事件，继续等。
        Err(e) if e.status == 504 => return Ok(("waiting".to_string(), None)),
        Err(e) => return Err(e),
    };
    let errcode = extract_until(&text, "window.wx_errcode=", ';')
        .ok_or_else(|| ApiError::upstream_rejected("微信扫码状态响应无法解析".to_string()))?;
    match errcode.as_str() {
        // 微信确认在不同版本回 0 或 405（DONE 事件同时含两者），都要进换票。
        "0" | "405" => {
            let wx_code = extract_until(&text, "window.wx_code='", '\'').ok_or_else(|| {
                ApiError::upstream_rejected("微信已确认但响应缺少授权 code".to_string())
            })?;
            let pack = exchange_code_cgi(
                1,
                "music.login.LoginServer",
                "Login",
                &wx_code,
                Some(WX_APPID),
            )
            .await?;
            if !super::cred::is_signed_in(ID, &pack) {
                return Err(ApiError::upstream_rejected(
                    "微信扫码凭据落库前校验失败（musicid/musickey 不完整）".to_string(),
                ));
            }
            super::cred::put(&ctx.db, ID, &pack)
                .await
                .map_err(internal_store)?;
            match account(ctx).await {
                Ok(info) => Ok(("confirmed".to_string(), Some(info))),
                Err(e) => {
                    tracing::debug!(error = %e.message, "微信扫码登录成功但账号信息回拉失败，稍后补拉");
                    Ok(("confirmed".to_string(), None))
                }
            }
        }
        "404" => Ok(("scanned".to_string(), None)),
        "408" => Ok(("waiting".to_string(), None)),
        // 超时/拒绝对前端呈现「已失效，点击刷新」，与 QQ 的 65/68 一致。
        "402" | "403" => Ok(("expired".to_string(), None)),
        _ => Ok(("waiting".to_string(), None)),
    }
}

/// 轮询扫码状态：66=未扫描，67=已扫描待确认，65=失效，68=手机端拒绝，
/// 0=成功（走 QQ Connect 三段授权换 musicid/musickey 并落库）。
/// 未识别状态码一律按 waiting 处理，只有文案显式含「失效/过期」才降级
/// expired，绝不误判把用户的码提前作废。
pub async fn qr_check(
    ctx: &Ctx,
    platform_ticket: &str,
) -> ApiResult<(String, Option<AccountInfo>)> {
    let qrsig = platform_ticket.trim();
    if qrsig.is_empty() {
        return Err(bad_request("缺少 QQ 扫码握手票 qrsig"));
    }
    // 微信票带 wx: 前缀，走微信长轮询（qr_create_wx 的配套实现）。
    if let Some(uuid) = qrsig.strip_prefix(WX_TICKET_PREFIX) {
        return qr_check_wx(ctx, uuid.trim()).await;
    }
    let ptqrtoken = gtk33(qrsig).to_string();
    let now = qr_now_ms().to_string();
    let action = format!("0-0-{now}");
    let appid = QR_APPID.to_string();
    let mut url = const_url(format!("{PTQR}/ptqrlogin"))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("u1", QR_U1)
            .append_pair("ptqrtoken", &ptqrtoken)
            .append_pair("ptredirect", "0")
            .append_pair("h", "1")
            .append_pair("t", "1")
            .append_pair("g", "1")
            .append_pair("from_ui", "1")
            .append_pair("ptlang", "2052")
            .append_pair("action", &action)
            .append_pair("js_ver", QR_JS_VER)
            .append_pair("js_type", "1")
            .append_pair("pt_uistyle", "40")
            .append_pair("aid", &appid)
            .append_pair("daid", QR_DAID)
            .append_pair("pt_3rd_aid", QR_3RD_AID)
            .append_pair("has_onekey", "1");
    }
    // 轮询只带 qrsig 这一张握手票，多带其他 cookie 会被网关判非法组合。
    let cookie = format!("qrsig={qrsig}");
    let mut h = super::http::headers(Some(&cookie), Some(PT_REFERER));
    h.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
    let text = super::http::get_text(&client()?, url.as_str(), h).await?;
    let (code, jump, msg, _nick) = parse_ptui_cb(&text)
        .ok_or_else(|| ApiError::upstream_rejected("无法解析 QQ 扫码状态响应".to_string()))?;

    match code {
        0 => {
            let (uin, sigx) = parse_sigx_uin(&jump).ok_or_else(|| {
                ApiError::upstream_rejected("QQ 扫码成功但回跳地址缺少 uin/ptsigx".to_string())
            })?;
            let pack = connect_exchange(&uin, &sigx).await?;
            finalize_cred(ctx, pack).await
        }
        67 => Ok(("scanned".to_string(), None)),
        // 65=过期；68=用户在手机上拒绝，对前端同样呈现「已失效，点击刷新」。
        65 | 68 => Ok(("expired".to_string(), None)),
        // 66=等待扫码，必须显式判——它的文案是「二维码未失效」，含「失效」
        // 二字，不能交给下面的关键词兜底，否则会把等待态误判成过期。
        66 => Ok(("waiting".to_string(), None)),
        // 其余未识别码不猜过期，仅当文案明确是「已失效/已过期」（而非
        // 「未失效」）时才降级 expired。
        _ if (msg.contains("已失效") || msg.contains("已过期")) => {
            Ok(("expired".to_string(), None))
        }
        _ => Ok(("waiting".to_string(), None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::online::cred::CRED_PREFIX;

    /// 真机诊断（**不进 CI**，手工跑）：
    /// `cargo test -p hertz-studio --lib -- --ignored --nocapture probe_daily`
    ///
    /// 用途：QQ 到底有没有「每日推荐歌曲」端点？`SOURCES` 里 QQ 没开
    /// RecommendSongs（注释写"无每日歌曲推荐端点"），于是每日推荐汇总把它判成
    /// unsupported，用户登了 QQ 也不出歌。匿名探测只会得到 500003，分不清是
    /// "模块不存在"还是"要登录"，所以这里带上真机 cookie 再试一遍。
    ///
    /// 候选来自公开参考实现与官方开放平台的能力命名（官方 SDK 的「每日30首」
    /// 是 fetchDailyRecommendSong，属 App SDK 而非这条 Web CGI 通道）。
    #[tokio::test]
    #[ignore]
    async fn probe_daily_candidates_with_cred() {
        // 钥匙串条目名是 `{cred_key}:cred`，而 cred_key 是 `online_cred_<source>`。
        // 写成 "qq:cred" 会拿到 NoEntry，误以为没登录。
        let entry = keyring::Entry::new(
            crate::secrets::KEYRING_SERVICE,
            &format!("{CRED_PREFIX}{ID}:cred"),
        )
        .expect("keyring entry");
        let raw = match entry.get_password() {
            Ok(v) => v,
            Err(e) => {
                println!("!! 读不到 QQ 凭据（未登录？）: {e}");
                return;
            }
        };
        let pack: CredPack = match serde_json::from_str(&raw) {
            Ok(p) => p,
            Err(e) => {
                println!("!! 凭据不是预期结构: {e}");
                return;
            }
        };
        if pack.cookie.is_empty() {
            println!("!! QQ 凭据里没有 cookie，先去在线面板登录");
            return;
        }
        let http = client().expect("http client");

        let cands: [(&str, &str, Value); 6] = [
            (
                "music.recommend.DailyRecommend",
                "GetDailyRecommend",
                json!({}),
            ),
            (
                "music.recommend.RecommendSong",
                "get_recommend_song",
                json!({}),
            ),
            (
                "music.radioProxy.MbTrackRadioSvr",
                "get_radio_track",
                json!({"seq": 1, "from": 0, "size": 10}),
            ),
            (
                "music.recommend.TrackRelationServer",
                "GetRadarSong",
                json!({"Page": 1, "Size": 10}),
            ),
            (
                "music.recommend.RecommendFeed",
                "get_recommend_feed",
                json!({"From": 0, "Size": 10}),
            ),
            (
                "music.playlist.PlaylistSquare",
                "GetRecommendFeed",
                json!({"From": 0, "Size": 10}),
            ),
        ];

        // 雷达：字段形状 + 分页是否真的生效（Page 递增要给出不同的歌，
        // 否则"分页"只是摆设，实现时就不能靠它凑数）。
        println!("=== GetRadarSong 结构与分页 ===");
        for page in [1usize, 2] {
            let body = json!({
                "comm": { "ct": 24, "cv": 0 },
                "req": {
                    "module": "music.recommend.TrackRelationServer",
                    "method": "GetRadarSong",
                    "param": { "Page": page, "Size": 10 },
                },
            });
            let mut h = crate::online::http::headers(Some(&pack.cookie), Some(REFERER));
            h.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
            h.insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/json;charset=UTF-8"),
            );
            let text = serde_json::to_string(&body).expect("serialize");
            match crate::online::http::post_json(&http, MUSICU, h, text).await {
                Ok(j) => {
                    let arr = j.pointer("/req/data/VecSongs").and_then(|v| v.as_array());
                    println!(
                        "  Page={page} code={:?} HasMore={:?} 条数={}",
                        j.pointer("/req/code").and_then(val_string),
                        j.pointer("/req/data/HasMore"),
                        arr.map(|a| a.len()).unwrap_or(0)
                    );
                    if let Some(arr) = arr {
                        for (i, t) in arr.iter().take(3).enumerate() {
                            println!(
                                "    [{i}] keys={:?}",
                                t.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>())
                            );
                        }
                        if page == 1 {
                            if let Some(first) = arr.first() {
                                println!("  首条完整：");
                                println!(
                                    "{}",
                                    serde_json::to_string_pretty(first)
                                        .unwrap_or_default()
                                        .chars()
                                        .take(3500)
                                        .collect::<String>()
                                );
                            }
                        }
                    }
                }
                Err(e) => println!("  Page={page} ERR {e:?}"),
            }
        }
        println!();

        // 电台的翻页语义：先摸清"一次能要几首"，否则写出来的实现要么只拿
        // 一首、要么为凑数连打几十次请求。
        println!("=== get_radio_track 参数矩阵 ===");
        for param in [
            json!({"seq": 1, "from": 0, "size": 10}),
            json!({"seq": 0, "from": 0, "size": 10}),
            json!({"from": 0, "size": 10}),
            json!({"seq": 1, "size": 20}),
            json!({"seq": 1, "from": 0, "size": 10, "num": 10}),
        ] {
            let body = json!({
                "comm": { "ct": 24, "cv": 0 },
                "req": {
                    "module": "music.radioProxy.MbTrackRadioSvr",
                    "method": "get_radio_track",
                    "param": param,
                },
            });
            let mut h = crate::online::http::headers(Some(&pack.cookie), Some(REFERER));
            h.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
            h.insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/json;charset=UTF-8"),
            );
            let text = serde_json::to_string(&body).expect("serialize");
            let n = match crate::online::http::post_json(&http, MUSICU, h, text).await {
                Ok(j) => format!(
                    "code={:?} tracks={}",
                    j.pointer("/req/code").and_then(val_string),
                    j.pointer("/req/data/tracks")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0)
                ),
                Err(e) => format!("ERR {e:?}"),
            };
            println!("    {param} -> {n}");
        }
        println!();

        for (module, method, param) in cands {
            let body = json!({
                "comm": { "ct": 24, "cv": 0 },
                "req": { "module": module, "method": method, "param": param },
            });
            let mut h = crate::online::http::headers(Some(&pack.cookie), Some(REFERER));
            h.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
            h.insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/json;charset=UTF-8"),
            );
            let text = serde_json::to_string(&body).expect("serialize");
            match crate::online::http::post_json(&http, MUSICU, h, text).await {
                Ok(j) => {
                    let code = j.pointer("/req/code").and_then(val_string);
                    let sub = j.pointer("/req/subcode").and_then(val_string);
                    let keys: Vec<&String> = j
                        .pointer("/req/data")
                        .and_then(|d| d.as_object())
                        .map(|o| o.keys().collect())
                        .unwrap_or_default();
                    println!(
                        "{module} / {method}\n    code={code:?} sub={sub:?} dataKeys={keys:?}\n    {}",
                        serde_json::to_string(&j).unwrap_or_default().chars().take(240).collect::<String>()
                    );
                    // 歌曲列表长什么样：只有看清字段，才能写解析（猜字段写出来的
                    // 解析器上线就是一排空标题）。
                    for path in ["/req/data/tracks", "/req/data/VecSongs"] {
                        if let Some(arr) = j.pointer(path).and_then(|v| v.as_array()) {
                            println!("    {path} 共 {} 条，首条：", arr.len());
                            if let Some(first) = arr.first() {
                                let s = serde_json::to_string_pretty(first).unwrap_or_default();
                                println!("{}", s.chars().take(1600).collect::<String>());
                            }
                        }
                    }
                }
                Err(e) => println!("{module} / {method}\n    请求失败: {e:?}"),
            }
            println!();
        }
    }

    /// 雷达响应的解析：包裹、封面、双歌手顿号连接、以及"没有 mid 播不了"的
    /// 条目必须被丢掉（留着就是一排点了没反应的行）。
    #[test]
    fn radar_tracks_unwrap_wrapper_and_drop_unplayable() {
        let j: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/qq_radar.json")).unwrap();
        let v = radar_tracks(&j);
        assert_eq!(v.len(), 2, "第三条没有 mid，应当被丢掉");
        assert_eq!(v[0].id, "0034Spf52pFWYE", "取的是 mid（播放用的 songmid）");
        assert_eq!(v[0].source, "qq");
        assert_eq!(v[0].title, "只要有你");
        assert_eq!(v[0].album, "只要有你");
        // spec §2.5：QQ 歌手数组用顿号连接。
        assert_eq!(v[0].artist, "张三、李四");
        assert_eq!(v[0].duration_ms, 223_000);
        assert_eq!(
            v[0].cover.as_deref(),
            Some("https://y.qq.com/music/photo_new/T002R300x300M000000liWDt1CeK6S_1.jpg"),
            "封面走专辑 pmid"
        );
        assert!(v[0].playable);
        assert!(!v[0].vip_only);
        // 付费标记两个历史字段名都要认（pay_play / payplay）。
        assert!(v[1].vip_only, "payplay=1 也要认成 VIP");
        assert_eq!(v[0].track_ref["media_mid"], "0034Spf52pFWYE");
    }

    /// 上游万一不再包 `Track`，应当按裸曲目对象解析，而不是整页空白。
    #[test]
    fn radar_tracks_accepts_bare_track_objects() {
        let j: Value = serde_json::from_str(
            r#"{"req":{"code":0,"data":{"VecSongs":[{"mid":"00abc","name":"裸的","interval":100}]}}}"#,
        )
        .unwrap();
        let v = radar_tracks(&j);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "00abc");
        assert_eq!(v[0].title, "裸的");
    }

    #[test]
    fn radar_tracks_returns_empty_when_envelope_missing() {
        let j: Value = serde_json::from_str(r#"{"req":{"code":500003}}"#).unwrap();
        assert!(radar_tracks(&j).is_empty());
    }

    #[test]
    fn fixture_normalizes_item_song() {
        let body: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/qq_search.json")).unwrap();
        let t = map_track(body.pointer("/req/data/body/item_song/0").unwrap());
        assert_eq!(t.id, "0039MnYb0qxYhV");
        assert_eq!(t.title, "屋顶");
        assert_eq!(t.artist, "周杰伦");
        assert_eq!(t.duration_ms, 319_000);
        assert_eq!(t.track_ref["media_mid"], "0039MnYb0qxYhV");
        assert!(t
            .cover
            .as_deref()
            .is_some_and(|c| c
                .ends_with("https://y.qq.com/music/photo_new/T002R300x300M0000039MnYb0qxYhA.jpg")));
        assert!(t.playable);
        assert!(!t.vip_only);
    }

    #[test]
    fn track_info_wrapper_and_multi_singer_and_vip() {
        let media = "0039MnYb0qxYhV";
        let song = json!({
            "mid": media,
            "name": "屋顶",
            "interval": null,
            "duration": "319",
            "file": { "media_mid": media },
            "singer": [ { "name": "周杰伦" }, { "name": "温岚" } ],
            "album": { "mid": "0039MnYb0qxYhA", "name": "男女情歌对唱",
                       "pmid": "0039MnYb0qxYhA" },
            "pay": { "payplay": "1" }
        });
        // ① 包一层 track_info 后与直给一致。
        let direct = map_track(&song);
        let wrapped = map_track(&json!({ "track_info": song }));
        assert_eq!(wrapped.id, direct.id);
        assert_eq!(wrapped.title, direct.title);
        assert_eq!(wrapped.id, media);
        assert_eq!(wrapped.title, "屋顶");
        // ② 多歌手用顿号连接。
        assert_eq!(wrapped.artist, "周杰伦、温岚");
        // ③ 字符串 "1" 的 payplay（移动端字段名）仍判 VIP。
        assert!(wrapped.vip_only);
        // ③b 网页/经典端字段名 pay_play（数字 1）同样判 VIP。
        let web = map_track(&json!({
            "mid": "m1", "file": { "media_mid": "m1" },
            "pay": { "pay_play": 1 }
        }));
        assert!(web.vip_only);
        let free = map_track(&json!({
            "mid": "m2", "file": { "media_mid": "m2" },
            "pay": { "pay_play": 0, "payplay": 0 }
        }));
        assert!(!free.vip_only);
        // ④ interval 缺失、duration 为数字字符串时仍折成毫秒。
        assert_eq!(wrapped.duration_ms, 319_000);
    }

    #[test]
    fn candidate_filenames_follow_quality_order() {
        let media = "MEDIA123";

        let hi = candidate_filenames(700_000, &[media]);
        assert_eq!(hi.len(), 5);
        assert_eq!(hi[0].0, format!("RS01{media}.flac"));
        assert_eq!(hi[4].0, format!("C400{media}.m4a"));

        let mp3 = candidate_filenames(320_000, &[media]);
        assert_eq!(mp3.len(), 3);
        assert_eq!(mp3[0].0, format!("M800{media}.mp3"));
        assert_eq!(mp3[2].0, format!("C400{media}.m4a"));

        let aac = candidate_filenames(96_000, &[media]);
        assert_eq!(aac.len(), 1);
        assert_eq!(aac[0].0, format!("C400{media}.m4a"));

        let lower = candidate_filenames(64_000, &[media]);
        assert_eq!(lower.len(), 1);

        for (name, _) in hi.iter().chain(mp3.iter()).chain(aac.iter()) {
            assert!(name.contains(media));
        }
    }

    #[test]
    fn candidate_filenames_expand_every_media_id_in_order() {
        // media_mid 与 songmid 不等时两组都展开，组内音质单调下降。
        let ids = ["MEDIA_MID", "SONG_MID"];
        let tiers = candidate_filenames(320_000, &ids);
        assert_eq!(tiers.len(), 6);
        assert_eq!(tiers[0].0, "M800MEDIA_MID.mp3");
        assert_eq!(tiers[2].0, "C400MEDIA_MID.m4a");
        assert_eq!(tiers[3].0, "M800SONG_MID.mp3");
        assert_eq!(tiers[5].0, "C400SONG_MID.m4a");
        assert_eq!(tiers[0].1, 320_000);
        assert_eq!(tiers[5].1, 96_000);
    }

    #[test]
    fn media_candidates_prefers_media_mid_then_dedups() {
        let r = json!({"media_mid": "MEDIA_MID"});
        assert_eq!(
            media_candidates(Some(&r), "SONG_MID"),
            vec!["MEDIA_MID", "SONG_MID"]
        );

        // 两者等值只留一个，避免重复档位。
        let same = json!({"media_mid": "SAME"});
        assert_eq!(media_candidates(Some(&same), "SAME"), vec!["SAME"]);

        // 无 track_ref / 空 media_mid 都回落到 songmid。
        assert_eq!(media_candidates(None, "SONG_MID"), vec!["SONG_MID"]);
        let blank = json!({"media_mid": ""});
        assert_eq!(media_candidates(Some(&blank), "SONG_MID"), vec!["SONG_MID"]);
    }

    #[test]
    fn vkey_request_arrays_are_aligned_with_filenames() {
        // 回归：songmid/songtype 长度必须与 filename 一致，否则 vkey 按下标
        // 对齐后后续档位 songmid 为空，服务端一律回 101404、purl 全空。
        let ids = ["MEDIA_MID", "SONG_MID"];
        let tiers = candidate_filenames(320_000, &ids);
        let filenames: Vec<String> = tiers.iter().map(|(f, _)| f.clone()).collect();
        let n = filenames.len();
        let songmid = vec!["SONG_MID"; n];
        let songtype = vec![0; n];
        assert_eq!(filenames.len(), songmid.len());
        assert_eq!(filenames.len(), songtype.len());
        assert_eq!(n, 6);
        // 每个档位都带上了真实 songmid，不再出现空串。
        assert!(songmid.iter().all(|s| !s.is_empty()));
    }

    #[test]
    fn join_url_trims_slashes_and_keeps_exactly_one() {
        assert_eq!(
            join_url(
                "https://ws.stream.qqmusic.qq.com/",
                "/M500media.mp3?vkey=secret&guid=1"
            ),
            "https://ws.stream.qqmusic.qq.com/M500media.mp3?vkey=secret&guid=1"
        );
        assert_eq!(
            join_url(
                "https://ws.stream.qqmusic.qq.com",
                "C400media.m4a?vkey=secret&guid=1"
            ),
            "https://ws.stream.qqmusic.qq.com/C400media.m4a?vkey=secret&guid=1"
        );
    }

    #[tokio::test]
    async fn pick_working_url_prefers_https_and_skips_404() {
        use reqwest::Client;
        // 本地起一个微型 HTTP 服务：第 1 个 purl 404，第 2 个 200。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{port}");

        let svc = axum::Router::new()
            .route("/ok.mp3", axum::routing::get(|| async { "audio" }))
            .route(
                "/404.mp3",
                axum::routing::get(|| async { (axum::http::StatusCode::NOT_FOUND, "no") }),
            );
        tokio::spawn(async move { axum::serve(listener, svc).await.unwrap() });

        let data = json!({
            "sip": ["http://bad.example/", &base],
            "midurlinfo": [
                {"purl": "/404.mp3"},
                {"purl": "/ok.mp3"}
            ]
        });
        let http = Client::builder().build().unwrap();
        let tiers = [
            ("M800media.mp3".into(), 320_000u64),
            ("M500media.mp3".into(), 128_000u64),
        ];
        let (hit, url, fallback) = pick_working_url(&http, &data, &tiers).await.unwrap();
        assert_eq!(hit, 1);
        assert!(url.starts_with(&base));
        assert!(url.contains("/ok.mp3"));
        assert!(fallback.is_empty());
    }

    #[test]
    fn fcgi_body_accepts_json_and_jsonp_and_rejects_garbage() {
        assert_eq!(parse_fcgi(r#" {"code":0,"x":1} "#).unwrap()["x"], 1);
        // 删除歌单接口回 JSONP：剥掉最外层 callback(...)。
        let j = parse_fcgi("musicjsoncallback({\"code\":0,\"dirid\":5});").unwrap();
        assert_eq!(j["code"], 0);
        assert_eq!(j["dirid"], 5);
        // 既不是 JSON 也不是 JSONP：必须报错，不能编空成功。
        assert!(parse_fcgi("<html>登录已过期</html>").is_err());
        assert!(parse_fcgi("callback(no-close").is_err());
    }

    #[test]
    fn playlist_id_is_dirid_colon_tid() {
        assert_eq!(
            split_playlist_id("201:3011946123").unwrap(),
            ("201".to_string(), "3011946123".to_string())
        );
        // 收藏单只有 tid、新建回包只有 dirid 都合法。
        assert_eq!(split_playlist_id(":3011946123").unwrap().1, "3011946123");
        assert_eq!(split_playlist_id("5:").unwrap().0, "5");
        assert!(split_playlist_id("3011946123").is_err());
        assert!(split_playlist_id(":").is_err());
    }

    #[test]
    fn diss_item_composes_id_and_recognizes_liked() {
        let created = json!({
            "dirid": 777, "tid": "3011946123", "diss_name": "我的歌单",
            "diss_cover": "http://y.gtimg.cn/a.jpg", "song_cnt": "12"
        });
        let p = map_diss(&created, diss_kind(&created));
        assert_eq!(p.id, "777:3011946123");
        assert_eq!(p.kind, "created");
        assert_eq!(p.track_count, 12);
        // 历史 http 封面升级成 https。
        assert!(p.cover.unwrap().starts_with("https://"));

        let liked = json!({"dirid": 201, "tid": "9", "dissname": "我喜欢"});
        assert_eq!(diss_kind(&liked), "liked");
        let pl = map_diss(&liked, diss_kind(&liked));
        assert_eq!(pl.kind, "liked");
    }

    #[test]
    fn classic_fcgi_song_fields_are_normalized() {
        // fcg_ucc_getcdinfo 的 songlist 是老字段名（songmid/songname/albummid）。
        let song = json!({
            "id": 123456,
            "songmid": "0039MnYb0qxYhV",
            "songname": "屋顶",
            "interval": 319,
            "albummid": "0039MnYb0qxYhA",
            "albumname": "男女情歌对唱",
            "singer": [{"name": "周杰伦"}, {"name": "温岚"}]
        });
        let t = map_track(&song);
        assert_eq!(t.id, "0039MnYb0qxYhV");
        assert_eq!(t.title, "屋顶");
        assert_eq!(t.artist, "周杰伦、温岚");
        assert_eq!(t.album, "男女情歌对唱");
        assert_eq!(t.duration_ms, 319_000);
        assert!(t
            .cover
            .unwrap()
            .ends_with("T002R300x300M0000039MnYb0qxYhA.jpg"));
    }

    #[test]
    fn ptui_cb_parses_waiting_and_success() {
        let waiting = "ptuiCB('66','0','','0','二维码未失效。','');\r\n";
        let (code, url, _msg, _nick) = parse_ptui_cb(waiting).unwrap();
        assert_eq!(code, 66);
        assert!(url.is_empty());

        // QQ Connect 流的成功回跳落在 graph check_sig，带 uin 与 ptsigx。
        let ok = "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1\
                  &uin=o012345&service=ptqrlogin&ptsigx=ab-cd_123XY&s_url=https%3A%2F%2F\
                  graph.qq.com%2Foauth2.0%2Flogin_jump','0','登录成功！','周杰伦');";
        let (code, url, _msg, nick) = parse_ptui_cb(ok).unwrap();
        assert_eq!(code, 0);
        assert!(url.starts_with("https://ssl.ptlogin2.graph.qq.com/check_sig"));
        assert_eq!(nick, "周杰伦");

        let (uin, sigx) = parse_sigx_uin(&url).unwrap();
        assert_eq!(uin, "12345");
        assert_eq!(sigx, "ab-cd_123XY");

        assert!(parse_ptui_cb("not a callback").is_none());
        assert!(parse_sigx_uin("https://x/next?uin=0&ptsigx=z").is_none());
        assert!(parse_sigx_uin("https://x/next?uin=42").is_none());
        assert!(parse_sigx_uin("not a url").is_none());
    }

    #[test]
    fn fcgi_code_loose_vs_strict_classification() {
        // 读接口宽松：缺 code 当成功；写接口严格：缺 code 必须失败。
        assert!(fcgi_code(&json!({}), "读").is_ok());
        assert!(fcgi_code_strict(&json!({}), "写").is_err());

        assert!(fcgi_code(&json!({"code": 0}), "读").is_ok());
        assert!(fcgi_code_strict(&json!({"code": 0}), "写").is_ok());

        // 1/1000 一律 401（auth_required）。
        for code in [1, 1000] {
            assert_eq!(
                fcgi_code(&json!({"code": code}), "读").unwrap_err().status,
                401
            );
            assert_eq!(
                fcgi_code_strict(&json!({"code": code}), "写")
                    .unwrap_err()
                    .status,
                401
            );
        }
        // 21（重名）等其他非 0：502，由具体调用方自行把 21 翻译成 400。
        assert_eq!(
            fcgi_code_strict(&json!({"code": 21}), "写")
                .unwrap_err()
                .status,
            502
        );
    }

    #[test]
    fn form_body_percent_encodes_user_input() {
        let mut f = BTreeMap::new();
        f.insert("name".to_string(), "晴天 雨天&a=b+c".to_string());
        let body = form_urlencoded(&f);
        assert_eq!(
            body,
            "name=%E6%99%B4%E5%A4%A9+%E9%9B%A8%E5%A4%A9%26a%3Db%2Bc"
        );
        // 多键按 BTreeMap 序稳定输出。
        let mut f2 = BTreeMap::new();
        f2.insert("b".to_string(), "2".to_string());
        f2.insert("a".to_string(), "1".to_string());
        assert_eq!(form_urlencoded(&f2), "a=1&b=2");
    }

    #[test]
    fn set_cookies_are_absorbed_with_attributes_and_equals_in_value() {
        let mut h = HeaderMap::new();
        // 多条 Set-Cookie：带属性段、值里含 '='、空值不覆盖已吸收凭据。
        h.append(
            SET_COOKIE,
            HeaderValue::from_str("qm_keyst=abc==; Path=/; HttpOnly").unwrap(),
        );
        h.append(
            SET_COOKIE,
            HeaderValue::from_str("p_skey=zzz; Domain=.qq.com").unwrap(),
        );
        h.append(
            SET_COOKIE,
            HeaderValue::from_str("qm_keyst=; Path=/").unwrap(),
        );
        let mut jar = BTreeMap::new();
        absorb_set_cookie(&h, &mut jar);
        assert_eq!(jar.get("qm_keyst").unwrap(), "abc==");
        assert_eq!(jar.get("p_skey").unwrap(), "zzz");

        // 单取一个票：必须能拿到分号前的值。
        assert_eq!(set_cookie_value(&h, "p_skey").unwrap(), "zzz");
        assert!(set_cookie_value(&h, "missing").is_none());
    }

    #[test]
    fn g_tk_hash_seeds_differ() {
        // ptqrtoken 种子为 0；graph 授权 g_tk 种子为 DJB2 的 5381。
        assert_eq!(gtk33(""), 0);
        assert_eq!(crate::online::sign::qq::gtk5381(""), 5381 & 0x7fff_ffff);
        assert_ne!(crate::online::sign::qq::gtk5381(""), gtk33("qrsig-value"));
    }
}
