// SPDX-License-Identifier: MIT

//! 酷狗音源。签名算法、端点与降级策略见 spec §2.3。
//!
//! 边界：只做平台客户端自身的公开摘要签名（MD5）与公开/自有账号端点代理；
//! 不做 krc/加密音频解密，不做账号池，不模拟会员权益。网关歌单/扫码能力
//! 把握度中高，真机验收不过就摘能力位（见 spec §2.4）。

use std::collections::BTreeMap;

use serde_json::json;

use super::cred::CredPack;
use super::http::absorb_cookies;
use super::playlist_common::{created_playlist, form_map, require_playlist_name, require_tracks};
use super::sign::{kugou, kugou_login};
use super::{
    bad_request, client, const_url, ApiError, ApiResult, Ctx, OnlineDetail, OnlineTrack,
    SearchPage, SearchQuery, StreamInfo,
};

pub const ID: &str = "kugou";
const SEARCH_URL: &str = "https://songsearch.kugou.com/song_search_v2";
const WEB_APPID: &str = "1014";
const PLAY_MOBILE: &str = "https://m.kugou.com/app/i/getSongInfo.php";
const PLAY_WEB: &str = "https://wwwapi.kugou.com/play/songinfo";
const PLAY_WEB_RETRY: &str = "https://wwwapiretry.kugou.com/play/songinfo";
const GATEWAY: &str = "https://gateway.kugou.com";
const LYRIC_SEARCH: &str = "https://krcs.kugou.com/search";
const LYRIC_DOWNLOAD: &str = "https://krcs.kugou.com/download";

fn anonymous_search_params(
    keyword: &str,
    page: usize,
    limit: usize,
    millis: u128,
) -> BTreeMap<String, String> {
    let mut p: BTreeMap<String, String> = [
        ("sorttype", "0"),
        ("keyword", keyword),
        ("userid", "0"),
        ("appid", "3116"),
        ("token", ""),
        ("iscorrection", "1"),
        ("uuid", "-"),
        ("dfid", "-"),
        ("clientver", "11070"),
        ("platform", "AndroidFilter"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    p.insert("page".into(), page.to_string());
    p.insert("pagesize".into(), limit.to_string());
    p.insert("clienttime".into(), (millis / 1000).to_string());
    p.insert(
        "mid".into(),
        super::sign::md5_hex(millis.to_string().as_bytes()),
    );
    let core: String = p.iter().map(|(k, v)| format!("{k}={v}")).collect();
    let salt = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";
    p.insert(
        "signature".into(),
        super::sign::md5_hex(format!("{salt}{core}{salt}").as_bytes()),
    );
    p
}

#[test]
fn guest_search_uses_public_identity_and_signed_pagination() {
    let p = anonymous_search_params("晴天", 2, 20, 1700000000123);
    assert_eq!(p["userid"], "0");
    assert_eq!(p["token"], "");
    assert_eq!(p["clienttime"], "1700000000");
    assert_eq!(p["page"], "2");
    assert_eq!(p["pagesize"], "20");
    assert_ne!(
        p["signature"],
        anonymous_search_params("晴天", 3, 20, 1700000000123)["signature"]
    );
}

async fn anonymous_search(
    keyword: &str,
    page: usize,
    limit: usize,
) -> ApiResult<serde_json::Value> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let params = anonymous_search_params(keyword, page, limit, millis);
    let mut url = const_url("https://complexsearch.kugou.com/v2/search/song")?;
    url.query_pairs_mut().extend_pairs(params.iter());
    let mut headers = super::http::headers(None, None);
    // 下面两个 unwrap 只作用于常量：key 全是本数组里的字面量（合法 header 名），
    // value 是字面量或 md5 hex / 十进制毫秒（合法 header 值），解析不可能失败。
    // 网络地址那一类「可能失败」的常量解析已统一走 const_url 降级为 ApiError。
    for (key, value) in [
        ("user-agent", "Android712-AndroidPhone-11070-18-0-Search"),
        ("kg-rec", "1"),
        ("kg-rc", "1"),
        ("x-router", "complexsearch.kugou.com"),
        ("mid", params["mid"].as_str()),
        ("kg-clienttimems", &millis.to_string()),
    ] {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(key.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    let body = super::http::get_json(&client()?, url.as_str(), headers).await?;
    if body["status"].as_i64() != Some(1) {
        return Err(ApiError::upstream_rejected("酷狗游客搜索暂不可用"));
    }
    Ok(body)
}

fn internal_store(e: vmusic_core::StoreError) -> ApiError {
    ApiError::internal(format!("设置存储失败: {e}"))
}

/// 生成设备 mid：md5(seed + 纳秒时间 + 随机 uuid)。
pub fn new_mid() -> String {
    let seed = format!(
        "kugou-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        uuid::Uuid::new_v4().simple()
    );
    super::sign::md5_hex(seed.as_bytes())
}

/// 确保有 mid/dfid 设备身份：缺 mid 则生成持久化；dfid 取不到回落 "-"。
/// 一期不做匿名注册（spec：注册失败允许 dfid="-"，搜索与移动播放不依赖 dfid）。
async fn device(ctx: &Ctx) -> ApiResult<(String, String)> {
    let mid = match super::cred::get_device(&ctx.db, ID)
        .await
        .map_err(internal_store)?
    {
        Some(m) if !m.is_empty() => m,
        _ => {
            let m = new_mid();
            let _ = super::cred::set_device(&ctx.db, ID, &m).await;
            m
        }
    };
    let dfid = super::cred::get_device(&ctx.db, &format!("{ID}_dfid"))
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "-".to_string());
    Ok((mid, dfid))
}

/// 匿名/登录请求统一的 Cookie 头：登录或手动 cookie 非空时原样使用；
/// 否则匿名请求至少带 kg_mid；两者都没有时返回空串（http::headers 会跳过）。
fn cookie_header(cred: &CredPack, mid: &str) -> String {
    if !cred.cookie.is_empty() {
        cred.cookie.clone()
    } else if !mid.is_empty() {
        format!("kg_mid={mid}")
    } else {
        String::new()
    }
}

/// 酷狗歌名含 <em> 高亮标签、%uXXXX 脏编码与 HTML 实体，展示前清洗。
fn clean_text(raw: &str) -> String {
    decode_entities(&decode_percent_u(&strip_tags(raw)))
}

/// 不引 regex：基于查找的扫描删除尖括号标签（歌名里只会出现 <em>）。
///
/// 找 '<' 再找其后第一个 '>'：中间再出现 '<' 或找不到 '>' 时，当前这个
/// '<' 当普通字符保留（如 `爱<情` 原样）；中间内容必须以 ASCII 字母或 '/'
/// 开头才算标签整体删除，否则当普通文本。
fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(lt) = rest.find('<') {
        out.push_str(&rest[..lt]);
        let after_lt = &rest[lt + 1..];
        match after_lt.find('>') {
            // 找不到 '>'：'<' 当普通字符，前进 1 字符继续扫描。
            None => {
                out.push('<');
                rest = after_lt;
            }
            Some(gt) => {
                let inner = &after_lt[..gt];
                let is_tag = !inner.contains('<')
                    && inner
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphabetic() || c == '/');
                if is_tag {
                    // 整个 <...> 删掉。
                    rest = &after_lt[gt + 1..];
                } else {
                    // 不是标签：保留 '<' 与中间内容，从 '<' 之后继续。
                    out.push('<');
                    rest = after_lt;
                }
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// %uXXXX → UTF-16 码元（酷狗历史脏编码）；支持高/低代理对；非法序列原样保留。
fn decode_percent_u(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(n) = parse_percent_u(bytes, i) {
            if (0xD800..=0xDBFF).contains(&n) {
                // 高代理项：尝试与紧邻的下一个 %uXXXX 低代理配对。
                let paired = parse_percent_u(bytes, i + 6)
                    .filter(|lo| (0xDC00..=0xDFFF).contains(lo))
                    .and_then(|lo| char::from_u32(0x10000 + ((n - 0xD800) << 10) + (lo - 0xDC00)));
                match paired {
                    Some(ch) => {
                        out.push(ch);
                        i += 12;
                        continue;
                    }
                    // 配不上对：高代理那 6 字节当原样文本。
                    None => {
                        out.push_str(&input[i..i + 6]);
                        i += 6;
                        continue;
                    }
                }
            }
            if let Some(ch) = char::from_u32(n) {
                out.push(ch);
                i += 6;
                continue;
            }
        }
        // 非 ASCII 原样拷贝一个完整字符。
        let ch_end = utf8_char_len(bytes[i]);
        out.push_str(&input[i..(i + ch_end).min(bytes.len())]);
        i += ch_end;
    }
    out
}

/// 在字节位置 i 处尝试解析 `%uXXXX`（6 字节，十六进制大小写不敏感）。
fn parse_percent_u(bytes: &[u8], i: usize) -> Option<u32> {
    if i + 6 <= bytes.len() && bytes[i] == b'%' && (bytes[i + 1] == b'u' || bytes[i + 1] == b'U') {
        let hex = std::str::from_utf8(&bytes[i + 2..i + 6]).ok()?;
        u32::from_str_radix(hex, 16).ok()
    } else {
        None
    }
}

/// 最小 HTML 实体解码（不引 crate）：五个具名实体 + &#NNNN; / &#xHHHH;。
/// 无法识别的实体原样保留。
fn decode_entities(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            let ch_end = utf8_char_len(bytes[i]);
            out.push_str(&input[i..(i + ch_end).min(bytes.len())]);
            i += ch_end;
            continue;
        }
        // 实体体很短：只在后续 12 字节内找 ';'，避免把整段文本吞掉。
        let scan_end = (i + 1 + 12).min(bytes.len());
        match bytes[i + 1..scan_end].iter().position(|&b| b == b';') {
            Some(rel) => {
                let body = &input[i + 1..i + 1 + rel];
                match decode_entity_body(body) {
                    Some(ch) => {
                        out.push(ch);
                        i += 1 + rel + 1;
                    }
                    // 识别不出：'&' 当普通字符，从下一字节继续。
                    None => {
                        out.push('&');
                        i += 1;
                    }
                }
            }
            None => {
                out.push('&');
                i += 1;
            }
        }
    }
    out
}

/// 解码单个实体体（不含 '&' 与 ';'）。
fn decode_entity_body(body: &str) -> Option<char> {
    match body {
        "amp" => Some('&'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "lt" => Some('<'),
        "gt" => Some('>'),
        _ => {
            let digits = body.strip_prefix('#')?;
            let n = if let Some(hex) = digits.strip_prefix(|c| c == 'x' || c == 'X') {
                u32::from_str_radix(hex, 16).ok()?
            } else {
                digits.parse::<u32>().ok()?
            };
            char::from_u32(n)
        }
    }
}

fn utf8_char_len(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first >> 5 == 0b110 {
        2
    } else if first >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

/// 酷狗 Duration 是秒（数字或数字字符串）；防御 0 值。
fn duration_ms(item: &serde_json::Value) -> u64 {
    item.get("Duration")
        .and_then(val_u64)
        .unwrap_or(0)
        .saturating_mul(1000)
}

/// 封面尺寸占位。酷狗下发的是模板 URL（
/// `http://imge.kugou.com/stdmusic/{size}/20230920/....jpg`），直接原样交给
/// 前端就是一张打不开的图——整列曲目会齐刷刷落到占位音符。列表里只有 40px，
/// 但舞台与歌单详情会把同一条 URL 放大到几百像素，所以取 480。
const COVER_SIZE: &str = "480";

/// 取封面：展开 `{size}` 占位并升 https。
///
/// `Image` 是搜索/歌单曲目都带的模板图；`AlbumImage` 是部分接口的专辑图
/// （实测搜索结果里它是空串，所以排在后面）；`imgurl`/`pic` 是老接口字段。
fn cover_of(item: &serde_json::Value) -> Option<String> {
    pick_str(Some(item), &["Image", "AlbumImage", "imgurl", "pic", "img"])
        .filter(|s| !s.trim().is_empty())
        .and_then(|u| super::https_url(&u.replace("{size}", COVER_SIZE)))
        .filter(|u| u.starts_with("https://"))
}

fn map_track(item: &serde_json::Value) -> OnlineTrack {
    let hash = item.get("FileHash").and_then(|v| v.as_str()).unwrap_or("");
    // 真机 MixSongID/AlbumID 可能以整数出现：val_string 统一转十进制，不丢值。
    let mix = item
        .get("MixSongID")
        .and_then(val_string)
        .unwrap_or_default();
    let album_id = item.get("AlbumID").and_then(val_string).unwrap_or_default();
    let id = if !hash.is_empty() {
        hash.to_string()
    } else {
        mix.to_string()
    };
    let privilege = item.get("Privilege").and_then(val_u64).unwrap_or(0);
    // 清洗后的歌名同时进 title 与 track_ref：写歌单 data 串需要 name 字段。
    let name = clean_text(
        item.get("SongName")
            .or_else(|| item.get("FileName"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知曲目"),
    );
    OnlineTrack {
        source: ID.into(),
        id,
        title: name.clone(),
        artist: clean_text(
            item.get("SingerName")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        ),
        album: clean_text(item.get("AlbumName").and_then(|v| v.as_str()).unwrap_or("")),
        duration_ms: duration_ms(item),
        cover: cover_of(item),
        playable: !hash.is_empty(),
        vip_only: privilege != 0,
        track_ref: json!({
            "name": name,
            "hash": hash,
            "album_id": album_id,
            "mixsongid": mix,
        }),
    }
}

pub async fn search(ctx: &Ctx, q: &SearchQuery) -> ApiResult<SearchPage> {
    let keyword = q.q.as_deref().unwrap_or("").trim();
    if keyword.is_empty() {
        return Err(bad_request("需要给出搜索关键词"));
    }
    let cred = super::cred::get(&ctx.db, ID)
        .await
        .map_err(internal_store)?
        .unwrap_or_default();
    let (mid, _dfid) = device(ctx).await?;
    let limit = q.limit.clamp(1, 20);
    let page = q.offset / limit + 1;
    let userid = if cred.userid.is_empty() {
        "-1"
    } else {
        cred.userid.as_str()
    };

    let mut url = const_url(SEARCH_URL)?;
    {
        let mut p = url.query_pairs_mut();
        p.append_pair("keyword", keyword)
            .append_pair("page", &page.to_string())
            .append_pair("pagesize", &limit.to_string())
            .append_pair("userid", userid)
            .append_pair("clientver", "2000")
            .append_pair("platform", "WebFilter")
            .append_pair("tag", "em")
            .append_pair("filter", "2")
            .append_pair("iscorrection", "1")
            .append_pair("privilege_filter", "0")
            .append_pair("appid", WEB_APPID)
            .append_pair("token", &cred.token)
            .append_pair("mid", &mid);
    }
    let cookie = cookie_header(&cred, &mid);
    let headers = super::http::headers(Some(&cookie), Some("https://www.kugou.com/"));
    let body = if !super::cred::is_signed_in(ID, &cred) {
        match anonymous_search(keyword, page, limit).await {
            Ok(body) => body,
            Err(_) => super::http::get_json(&client()?, url.as_str(), headers).await?,
        }
    } else {
        super::http::get_json(&client()?, url.as_str(), headers).await?
    };
    if !status_ok(body.get("status")) {
        return Err(ApiError::upstream_rejected(
            "酷狗搜索暂时不可用，请稍后重试".to_string(),
        ));
    }
    let tracks: Vec<OnlineTrack> = body
        .pointer("/data/lists")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(map_track)
                .filter(|t| !t.id.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let total = body
        .pointer("/data/total")
        .and_then(val_u64)
        .unwrap_or(tracks.len() as u64) as usize;

    Ok(SearchPage {
        source: ID.into(),
        keyword: keyword.to_string(),
        total,
        tracks,
        warning: None,
    })
}

fn pick_url(j: &serde_json::Value) -> Option<String> {
    j.pointer("/data/play_url")
        .or_else(|| j.pointer("/data/url"))
        .or_else(|| j.get("url"))
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with("http"))
        .map(str::to_string)
}

fn quality_param(quality_bps: u32) -> &'static str {
    match quality_bps {
        q if q >= 700_000 => "flac",
        q if q >= 320_000 => "320",
        _ => "128",
    }
}

/// H5 网关公共参数。clienttime 取毫秒（主流 H5 客户端参考实现如此；
/// spec §2.3 文字写「秒级」，毫秒与真实客户端一致，真机验收时确认）。
fn h5_base(cred: &CredPack, mid: &str, dfid: &str) -> BTreeMap<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string();
    let mut m = BTreeMap::new();
    for (k, v) in [
        ("srcappid", "2919"),
        ("clientver", "20000"),
        ("clienttime", now.as_str()),
        ("mid", mid),
        ("uuid", mid),
        ("dfid", dfid),
        ("appid", WEB_APPID),
        ("token", cred.token.as_str()),
    ] {
        m.insert(k.to_string(), v.to_string());
    }
    m.insert(
        "userid".into(),
        if cred.userid.is_empty() {
            "0".into()
        } else {
            cred.userid.clone()
        },
    );
    m
}

/// 用 BTreeMap 原始值已完成签名后构造请求 URL（append_pair 负责百分号编码）。
///
/// `base` 只由本文件的网关常量与 `format!` 拼出来，没有用户输入；即便写错也只是
/// 这一个音源报错（返回 `Err`），不会把进程带走（release 是 `panic = "abort"`）。
fn signed_url(base: &str, mut params: BTreeMap<String, String>) -> ApiResult<String> {
    // signature 必须在签名之后插入：签名输入不含 signature 键。
    let sig = kugou::h5_sign(&params, None);
    params.insert("signature".into(), sig);
    let mut url = reqwest::Url::parse(base)
        .map_err(|e| crate::error::internal(format!("酷狗网关地址无效 {base}: {e}")))?;
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in &params {
            q.append_pair(k, v);
        }
    }
    Ok(url.to_string())
}

fn stream_info(url: String, id: &str) -> StreamInfo {
    StreamInfo {
        url,
        source: ID.into(),
        id: id.to_string(),
        bitrate: None,
        expires_in_secs: None,
        fallbacks: Vec::new(),
        rg_gain_db: None,
        rg_peak: None,
    }
}

/// 仅 gateway 通道使用：只有登录网关按 `quality` 参数明确返回对应档位的直链，
/// 所以这一跳敢回填请求档位。mobile/h5 给的地址实际码率未知，回填请求档位会把
/// 128k 标成「无损」，故那两跳走普通 [`stream_info`]（bitrate=None）。
fn gateway_stream_info(url: String, hash: &str, quality: u32) -> StreamInfo {
    let mut info = stream_info(url, hash);
    info.bitrate = Some(quality as u64);
    info
}

/// 取流日志用的 status 摘要（缺失/数字/字符串均可安全展示，不含敏感信息）。
fn status_digest(b: &serde_json::Value) -> String {
    b.get("status")
        .and_then(val_string)
        .unwrap_or_else(|| "缺失".into())
}

/// 通道尝试顺序。已登录且请求 ≥320k 时登录网关排第一（能给 320/flac）；
/// 其余情况维持「移动匿名 → H5 → retry」。
fn channel_plan(signed_in: bool, quality: u32) -> Vec<&'static str> {
    if signed_in && quality >= 320_000 {
        vec!["gateway", "mobile", "h5", "h5_retry"]
    } else {
        vec!["mobile", "h5", "h5_retry"]
    }
}

/// 按 spec §2.3 顺序尝试通道：已登录且请求 ≥320k 时登录网关优先（320/flac），
/// 不通再回落移动匿名与 Web H5（含 retry 域）；其余情况移动匿名 → H5 → retry。
///
/// 错误归类：传输层失败（get_json Err）只记 debug 并续跑下一跳，全部停在
/// 传输层时透传最后一个传输错误；只要有一跳拿到业务 JSON 但都没给出 url，
/// 按登录态归类为 auth_required / vip_required。日志只打 channel/status/error，
/// 绝不记录 url/cookie/token。
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
    let (mid, dfid) = device(ctx).await?;
    let hash = id;
    // album_aid 参与部分 playInfo 签名，搜索结果里带了就透传；缺失回落 "0"
    // （匿名移动通道对 album_id 不敏感，登录网关 320k 真机在 Task 22 验收）。
    let album_id = track_ref
        .and_then(|r| r.get("album_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("0");
    // 一次构建、四跳复用，避免每跳重建 TLS/连接池客户端。
    let http = client()?;
    let signed_in = super::cred::is_signed_in(ID, &cred);
    let cookie = cookie_header(&cred, &mid);

    let mut last_transport: Option<ApiError> = None;
    let mut business_seen = false;

    let plan = channel_plan(signed_in, quality);

    macro_rules! try_mobile {
        () => {{
            let mut mobile_url = const_url(PLAY_MOBILE)?;
            mobile_url
                .query_pairs_mut()
                .append_pair("cmd", "playInfo")
                .append_pair("hash", hash)
                .append_pair("key", &kugou::mobile_key(hash))
                .append_pair("album_id", album_id)
                .append_pair("pid", "1")
                .append_pair("forceDown", "0")
                .append_pair("vip", "65530");
            let h = super::http::headers(Some(&cookie), Some("https://m.kugou.com/"));
            match super::http::get_json(&http, mobile_url.as_str(), h).await {
                Ok(b) => {
                    business_seen = true;
                    if status_ok(b.get("status")) {
                        if let Some(url) = pick_url(&b) {
                            // 移动通道不按请求档位出流，实际码率未知：不回填。
                            return Ok(stream_info(url, hash));
                        }
                    }
                    tracing::debug!(channel = "kugou_mobile", status = %status_digest(&b), "酷狗取流通道失败");
                }
                Err(e) => {
                    tracing::debug!(channel = "kugou_mobile", error = %e.message, "酷狗取流通道失败");
                    last_transport = Some(e);
                }
            }
        }};
    }

    macro_rules! try_h5 {
        ($endpoint:expr, $channel:literal) => {{
            let mut params = h5_base(&cred, &mid, &dfid);
            params.insert("platid".into(), "4".into());
            params.insert("hash".into(), hash.to_lowercase());
            params.insert("album_id".into(), album_id.into());
            let url = signed_url($endpoint, params)?;
            let h = super::http::headers(Some(&cookie), Some("https://www.kugou.com/"));
            match super::http::get_json(&http, &url, h).await {
                Ok(b) => {
                    business_seen = true;
                    if status_ok(b.get("status")) {
                        if let Some(u) = pick_url(&b) {
                            // H5 通道给的直链不保证是请求档位，实际码率未知。
                            return Ok(stream_info(u, hash));
                        }
                    }
                    tracing::debug!(channel = $channel, status = %status_digest(&b), "酷狗取流通道失败");
                }
                Err(e) => {
                    tracing::debug!(channel = $channel, error = %e.message, "酷狗取流通道失败");
                    last_transport = Some(e);
                }
            }
        }};
    }

    macro_rules! try_gateway {
        () => {{
            let mut params = h5_base(&cred, &mid, &dfid);
            params.insert("album_id".into(), album_id.into());
            params.insert("area_code".into(), "1".into());
            params.insert("hash".into(), hash.to_lowercase());
            params.insert("behavior".into(), "play".into());
            params.insert("pid".into(), "2".into());
            params.insert("cmd".into(), "26".into());
            params.insert("quality".into(), quality_param(quality).to_string());
            params.insert("key".into(), kugou::play_key(hash, &mid, &cred.userid, WEB_APPID));
            let url = signed_url(&format!("{GATEWAY}/v5/url"), params)?;
            let mut h = super::http::headers(Some(&cookie), Some("https://www.kugou.com/"));
            h.insert(
                "x-router",
                reqwest::header::HeaderValue::from_static("trackercdn.kugou.com"),
            );
            match super::http::get_json(&http, &url, h).await {
                Ok(b) => {
                    business_seen = true;
                    if status_ok(b.get("status")) {
                        if let Some(u) = pick_url(&b) {
                            return Ok(gateway_stream_info(u, hash, quality));
                        }
                    }
                    tracing::debug!(channel = "kugou_gateway", status = %status_digest(&b), "酷狗取流通道失败");
                }
                Err(e) => {
                    tracing::debug!(channel = "kugou_gateway", error = %e.message, "酷狗取流通道失败");
                    last_transport = Some(e);
                }
            }
        }};
    }

    for channel in plan {
        match channel {
            "gateway" => try_gateway!(),
            "mobile" => try_mobile!(),
            "h5" => try_h5!(PLAY_WEB, "kugou_h5"),
            "h5_retry" => try_h5!(PLAY_WEB_RETRY, "kugou_h5_retry"),
            _ => {}
        }
    }

    // 全部停在传输层（没拿到任何业务 JSON）：透传最后一个传输错误，
    // 502/504 由错误自身类型决定。
    if !business_seen {
        if let Some(e) = last_transport {
            return Err(e);
        }
    }
    // 至少一跳业务响应但都没给 url：按登录态归类。
    Err(if signed_in {
        ApiError::vip_required("该曲目在当前账号下无可用音质（可能为 VIP 专享）".to_string())
    } else {
        ApiError::auth_required("酷狗未取得试听地址，登录后可获得更多结果".to_string())
    })
}

pub async fn lyric(ctx: &Ctx, id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let cred = super::cred::get(&ctx.db, ID)
        .await
        .map_err(internal_store)?
        .unwrap_or_default();
    let (mid, _dfid) = device(ctx).await?;
    let cookie = cookie_header(&cred, &mid);

    let mut s_url = const_url(LYRIC_SEARCH)?;
    {
        let mut p = s_url.query_pairs_mut();
        p.append_pair("ver", "1")
            .append_pair("man", "yes")
            .append_pair("client", "pc")
            .append_pair("hash", id)
            .append_pair("album_audio_id", "0")
            .append_pair("duration", "0");
    }
    let h = super::http::headers(Some(&cookie), Some("https://www.kugou.com/"));
    let body = super::http::get_json(&client()?, s_url.as_str(), h).await?;
    let cand = body.pointer("/candidates/0");
    let (lid, accesskey) = match cand {
        Some(c) => (
            // 真机 candidates[].id 是整数：val_string 转十进制，不能丢。
            c.get("id").and_then(val_string).unwrap_or_default(),
            c.get("accesskey").and_then(|v| v.as_str()).unwrap_or(""),
        ),
        None => return Ok(vmusic_core::LyricDocument::empty()),
    };
    if lid.is_empty() || accesskey.is_empty() {
        return Ok(vmusic_core::LyricDocument::empty());
    }

    let mut d_url = const_url(LYRIC_DOWNLOAD)?;
    {
        let mut p = d_url.query_pairs_mut();
        p.append_pair("id", &lid)
            .append_pair("accesskey", accesskey)
            .append_pair("fmt", "lrc")
            .append_pair("charset", "utf8");
    }
    let h2 = super::http::headers(Some(&cookie), Some("https://www.kugou.com/"));
    let d = super::http::get_json(&client()?, d_url.as_str(), h2).await?;
    let content = d.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if content.is_empty() {
        return Ok(vmusic_core::LyricDocument::empty());
    }
    let decoded = super::base64_decode_std(content).unwrap_or_default();
    let text = String::from_utf8_lossy(&decoded).to_string();
    if text.trim().is_empty() {
        return Ok(vmusic_core::LyricDocument::empty());
    }
    let mut doc = vmusic_lyrics::parse_lrc(&text);
    vmusic_lyrics::apply_offset(&mut doc);
    Ok(doc)
}

/// 没有按 id 查详情的接口。返回错误而不是编一个空壳，调用方（补封面那条路径）
/// 本来就按「拿不到就算了」处理（与 ccmixter 对齐）。
pub async fn detail(_ctx: &Ctx, id: &str) -> ApiResult<OnlineDetail> {
    Err(bad_request(format!(
        "酷狗没有单曲详情接口，元数据以搜索结果为准（id {id}）"
    )))
}

// ---------------------------------------------------------------------------
// 账号 / 歌单 / 写操作 / 推荐 / 扫码（Tasks 7-8）
//
// 下列网关端点基于酷狗 H5/网关客户端的公开约定与 spec §2.3 片段；spec §2.4
// 对「酷狗网关签名能力」把握度评级为中高，x-router 路径需真机对一次。
// 统一风险标注：真机待验证（spec §2.4）：路径/字段以 2026 年客户端为准，
// Task 22 真机验收；不通则摘能力位。
// ---------------------------------------------------------------------------

/// 取登录态；酷狗登录判据 userid 非空非 0 且 token 非空。
async fn authed(ctx: &Ctx) -> ApiResult<CredPack> {
    super::cred::get(&ctx.db, ID)
        .await
        .map_err(internal_store)?
        .filter(|c| !c.userid.is_empty() && c.userid != "0" && !c.token.is_empty())
        .ok_or_else(|| ApiError::auth_required("请先登录酷狗".to_string()))
}

/// 上游业务 status 判定：数字 1 或字符串 "1" 均视为成功（防御历史脏字段）。
fn status_ok(v: Option<&serde_json::Value>) -> bool {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_i64() == Some(1),
        Some(serde_json::Value::String(s)) => s == "1",
        _ => false,
    }
}

/// 仅给 upstream_rejected 错误加中文语境前缀；auth_required/超时等原样透传。
fn reject_context(e: ApiError, label: &str) -> ApiError {
    if e.code == "upstream_rejected" {
        ApiError::upstream_rejected(format!("{label}：{}", e.message))
    } else {
        e
    }
}

/// JSON 标量转字符串：字符串原样，整数（正/负/超大无符号）转十进制。
fn val_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => n
            .as_u64()
            .map(|x| x.to_string())
            .or_else(|| n.as_i64().map(|x| x.to_string())),
        _ => None,
    }
}

/// 数字或数字字符串 → u64；浮点、负数、脏字符串返回 None。
fn val_u64(v: &serde_json::Value) -> Option<u64> {
    match v {
        serde_json::Value::Number(n) => n
            .as_u64()
            .or_else(|| n.as_i64().and_then(|i| i.try_into().ok())),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// 布尔或 1/"1" 判定为真（is_collect 等历史字段两种类型都出现过）。
fn val_true(v: Option<&serde_json::Value>) -> bool {
    match v {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(v) => val_u64(v) == Some(1),
        None => false,
    }
}

/// 依次尝试多个候选字段名，取第一个可转字符串的值。
fn pick_str(v: Option<&serde_json::Value>, keys: &[&str]) -> Option<String> {
    let v = v?;
    keys.iter().find_map(|k| v.get(*k).and_then(val_string))
}

/// 依次尝试多个候选字段名，取第一个可转 u64 的值。
fn pick_u64(v: Option<&serde_json::Value>, keys: &[&str]) -> Option<u64> {
    let v = v?;
    keys.iter().find_map(|k| v.get(*k).and_then(val_u64))
}

/// 扫码状态码匹配：数字按 i64 比，字符串按文本或数字字符串比。
fn code_matches(v: Option<&serde_json::Value>, num: i64, text: &str) -> bool {
    match v {
        Some(serde_json::Value::String(s)) => s == text || s == &num.to_string(),
        Some(serde_json::Value::Number(n)) => n.as_i64() == Some(num),
        _ => false,
    }
}

fn now_millis() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string()
}

/// H5 签名网关 GET：`{GATEWAY}{path}`，x-router 走 trackercdn。
///
/// 统一处理业务码：`status==1` 返回整个响应体，否则返回 upstream_rejected
/// （摘要带 status/err_code/error_msg），调用处只解析 data。
/// 真机待验证（spec §2.4）：路径/字段以 2026 年客户端为准，Task 22 真机
/// 验收；不通则摘能力位。
async fn h5_get(
    ctx: &Ctx,
    path: &str,
    extra: BTreeMap<String, String>,
) -> ApiResult<serde_json::Value> {
    let cred = authed(ctx).await?;
    let (mid, dfid) = device(ctx).await?;
    let mut params = h5_base(&cred, &mid, &dfid);
    for (k, v) in extra {
        params.insert(k, v);
    }
    let url = signed_url(&format!("{GATEWAY}{path}"), params)?;
    let mut h = super::http::headers(Some(&cred.cookie), Some("https://www.kugou.com/"));
    if let Ok(v) = "trackercdn.kugou.com".parse() {
        let _ = h.insert("x-router", v);
    }
    let j = super::http::get_json(&client()?, &url, h).await?;
    if status_ok(j.get("status")) {
        return Ok(j);
    }
    let mut detail = format!(
        "酷狗网关拒绝请求（path={path}, status={}",
        j.get("status")
            .and_then(val_string)
            .unwrap_or_else(|| "缺失".into())
    );
    if let Some(code) = j
        .get("err_code")
        .or_else(|| j.get("errcode"))
        .and_then(val_string)
    {
        detail.push_str(&format!(", err_code={code}"));
    }
    detail.push('）');
    let msg = j
        .get("error_msg")
        .or_else(|| j.get("err_msg"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !msg.is_empty() {
        detail.push_str(&format!("：{msg}"));
    }
    Err(ApiError::upstream_rejected(detail))
}

/// `collection_3_{uid}_{listid}_0`（恰好 5 段）取第 4 段；纯数字直用；
/// 其他形态一律 bad_request——这是客户端入参错误，不是上游拒绝。
fn parse_listid(id: &str) -> ApiResult<String> {
    let id = id.trim();
    if id.is_empty() {
        return Err(bad_request("缺少酷狗歌单 id"));
    }
    if id.chars().all(|c| c.is_ascii_digit()) {
        return Ok(id.to_string());
    }
    let seg: Vec<&str> = id.split('_').collect();
    let valid = seg.len() == 5
        && seg[0] == "collection"
        && seg[1] == "3"
        && !seg[2].is_empty()
        && seg[4] == "0"
        && !seg[3].is_empty()
        && seg[3].chars().all(|c| c.is_ascii_digit());
    if valid {
        Ok(seg[3].to_string())
    } else {
        Err(bad_request(format!("无法解析酷狗歌单 id: {id}")))
    }
}

/// 当前登录账号信息：GET `/v5/user/info`，无业务参数。
///
/// 真机待验证（spec §2.4）：路径/字段以 2026 年客户端为准，Task 22 真机
/// 验收；不通则摘能力位。昵称/头像/vip 字段名做了候选防御。
pub async fn account(ctx: &Ctx) -> ApiResult<super::AccountInfo> {
    let j = h5_get(ctx, "/v5/user/info", BTreeMap::new())
        .await
        .map_err(|e| reject_context(e, "获取酷狗账号信息失败"))?;
    let d = j.get("data");
    let nickname = pick_str(d, &["nickname", "nick_name", "user_name"]).unwrap_or_default();
    let avatar = pick_str(d, &["avatar", "head_url", "imgurl"]).and_then(|u| super::https_url(&u));
    let level = pick_u64(d, &["vip_type", "vip_level"]);
    let membership = super::ProfileMembership::from_level(level);
    let vip_level = level.and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
    Ok(super::AccountInfo {
        source: ID.into(),
        nickname,
        avatar,
        membership,
        vip_level,
        vip_label: if vip_level > 0 {
            "VIP".to_string()
        } else {
            String::new()
        },
    })
}

/// 把网关歌单项归一化；kind 按收藏标记与歌单名启发式判定。
fn map_playlist(item: &serde_json::Value) -> super::OnlinePlaylist {
    let id =
        pick_str(Some(item), &["global_collection_id", "listid", "specialid"]).unwrap_or_default();
    let name = pick_str(Some(item), &["name", "title"]).unwrap_or_default();
    let cover = pick_str(Some(item), &["imgurl", "pic", "img"]).and_then(|u| super::https_url(&u));
    let track_count =
        pick_u64(Some(item), &["song_count", "total_songs", "track_count"]).unwrap_or(0);
    let play_count = item.get("play_count").and_then(val_u64);
    let creator =
        pick_str(Some(item), &["user_name", "nickname", "create_user_name"]).unwrap_or_default();
    let collected =
        val_true(item.get("is_collect")) || item.get("type").and_then(val_u64) == Some(1);
    let kind = if name.contains("我喜欢") || name.contains("我的收藏") {
        "liked"
    } else if collected {
        "collected"
    } else {
        "created"
    };
    super::OnlinePlaylist {
        source: ID.into(),
        id,
        name,
        cover,
        track_count,
        play_count,
        creator,
        kind: kind.into(),
        description: None,
    }
}

/// 用户歌单列表：GET `/v3/playlist/special/list`，分页 page/pagesize。
///
/// 真机待验证（spec §2.4）：路径/字段以 2026 年客户端为准，Task 22 真机
/// 验收；不通则摘能力位。scope 仅在归一化后本地过滤，不带给上游。
pub async fn playlists(
    ctx: &Ctx,
    scope: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<Vec<super::OnlinePlaylist>> {
    let limit = limit.clamp(1, 100);
    let page = offset / limit + 1;
    let extra = form_map(&[
        ("page", &page.to_string()),
        ("pagesize", &limit.to_string()),
    ]);
    let j = h5_get(ctx, "/v3/playlist/special/list", extra)
        .await
        .map_err(|e| reject_context(e, "获取酷狗歌单失败"))?;
    let d = j.get("data");
    let items = ["/list", "/playlists", "/special_list"]
        .iter()
        .find_map(|p| d.and_then(|v| v.pointer(p)))
        .and_then(|v| v.as_array());
    let mut out = Vec::new();
    if let Some(items) = items {
        for item in items {
            let pl = map_playlist(item);
            // 注意：本地过滤会让单页条数缩水、分页不精确（用户歌单量小，真机验收时确认上游是否支持 scope 参数）。
            let keep = match scope {
                // created 语义：排除 collected 与 liked。
                "created" => pl.kind == "created",
                "collected" => pl.kind == "collected",
                "liked" => pl.kind == "liked",
                // 其他 scope 值（含空串）原样返回全部。
                _ => true,
            };
            if keep {
                out.push(pl);
            }
        }
    }
    Ok(out)
}

/// 歌单曲目详情：GET `/v3/playlist/special/song/list`。
///
/// 真机待验证（spec §2.4）：路径/字段以 2026 年客户端为准，Task 22 真机
/// 验收；不通则摘能力位。空列表但 status==1 属正常结果。
pub async fn playlist_detail(
    ctx: &Ctx,
    id: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<super::PlaylistDetail> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少酷狗歌单 id"));
    }
    let listid = parse_listid(id)?;
    let limit = limit.clamp(1, 100);
    let page = offset / limit + 1;
    let extra = form_map(&[
        ("global_collection_id", id),
        ("listid", &listid),
        ("page", &page.to_string()),
        ("pagesize", &limit.to_string()),
    ]);
    let j = h5_get(ctx, "/v3/playlist/special/song/list", extra)
        .await
        .map_err(|e| reject_context(e, "获取酷狗歌单详情失败"))?;
    let d = j.get("data").cloned().unwrap_or(json!(null));
    // 元信息可能内嵌 data.info / data.special，缺失时退回 data 自身。
    let info = d
        .get("info")
        .or_else(|| d.get("special"))
        .cloned()
        .unwrap_or_else(|| d.clone());
    // kind 用 map_playlist 按 info/data 计算的结果，不硬写 "created"。
    let mut playlist = map_playlist(&info);
    playlist.source = ID.into();
    playlist.id = id.to_string();

    let items = ["/songs", "/list", "/info/list"]
        .iter()
        .find_map(|p| d.pointer(p))
        .and_then(|v| v.as_array());
    let mut tracks = Vec::new();
    if let Some(items) = items {
        for item in items {
            let mut t = map_track(item);
            if t.id.is_empty() {
                continue;
            }
            // 删除接口要 fileid；歌单曲目若带 FileId/fileid 就塞进 track_ref。
            if let Some(fid) = item
                .get("FileId")
                .or_else(|| item.get("fileid"))
                .and_then(val_string)
            {
                if let Some(obj) = t.track_ref.as_object_mut() {
                    obj.insert("fileid".into(), json!(fid));
                }
            }
            tracks.push(t);
        }
    }
    let total = d
        .get("total")
        .or_else(|| d.get("total_song"))
        .and_then(val_u64)
        .unwrap_or(tracks.len() as u64);
    Ok(super::PlaylistDetail {
        playlist,
        total,
        tracks,
    })
}

/// 新建歌单：GET `/v3/playlist/special/create`（网关 H5 写操作同样走签名 GET）。
///
/// 真机待验证（spec §2.4）：路径/字段以 2026 年客户端为准，Task 22 真机
/// 验收；不通则摘能力位。
pub async fn playlist_create(ctx: &Ctx, name: &str) -> ApiResult<super::OnlinePlaylist> {
    let name = require_playlist_name(name)?;
    let extra = form_map(&[("name", name), ("type", "0")]);
    let j = h5_get(ctx, "/v3/playlist/special/create", extra)
        .await
        .map_err(|e| reject_context(e, "创建酷狗歌单失败"))?;
    // status==1 但拿不回 id 不能伪装成功：上层需要 id 才能继续操作。
    let id = pick_str(j.get("data"), &["global_collection_id", "listid"])
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::upstream_rejected("创建成功但未取得歌单 id".to_string()))?;
    Ok(created_playlist(ID, id, name))
}

/// 删除歌单：GET `/v3/playlist/special/delete`。
///
/// 真机待验证（spec §2.4）：路径/字段以 2026 年客户端为准，Task 22 真机
/// 验收；不通则摘能力位。真机可能只认 ids/listid 其中一键，验收前两键同值都带。
pub async fn playlist_delete(ctx: &Ctx, id: &str) -> ApiResult<()> {
    let listid = parse_listid(id)?;
    let extra = form_map(&[("ids", &listid), ("listid", &listid)]);
    h5_get(ctx, "/v3/playlist/special/delete", extra)
        .await
        .map_err(|e| reject_context(e, "删除酷狗歌单失败"))?;
    Ok(())
}

/// 追加曲目：GET `/v3/playlist/tracks/add`，data 为 `name|hash|album_id|mixsongid`
/// 多条英文逗号拼接（append_pair 负责百分号编码）。
///
/// 真机待验证（spec §2.4）：路径/字段以 2026 年客户端为准，Task 22 真机
/// 验收；不通则摘能力位。
pub async fn playlist_add(ctx: &Ctx, id: &str, tracks: &[super::TrackEntry]) -> ApiResult<()> {
    require_tracks(tracks, "加入")?;
    let listid = parse_listid(id)?;
    let mut lines = Vec::with_capacity(tracks.len());
    for (n, entry) in tracks.iter().enumerate() {
        // 酷狗稳定曲目 id 即 hash：ref 缺失时按 spec §1.4 仅用 id 尝试。
        // name 是专有字段无法从 id 恢复，缺失时仍拼空段交给上游裁决；
        // hash 两边都没有才提前拦下。album_id/mixsongid 允许空段。
        let hash = entry.ref_str("hash").unwrap_or(entry.id.trim());
        if hash.is_empty() {
            return Err(bad_request(format!(
                "第 {} 首缺少 hash，无法加入酷狗歌单",
                n + 1
            )));
        }
        let name = entry.ref_str("name").unwrap_or("");
        let album_id = entry.ref_str("album_id").unwrap_or("");
        let mixsongid = entry.ref_str("mixsongid").unwrap_or("");
        lines.push(format!("{name}|{hash}|{album_id}|{mixsongid}"));
    }
    let extra = form_map(&[
        ("listid", &listid),
        ("data", &lines.join(",")),
        ("type", "0"),
    ]);
    h5_get(ctx, "/v3/playlist/tracks/add", extra)
        .await
        .map_err(|e| reject_context(e, "酷狗歌单追加曲目失败"))?;
    Ok(())
}

/// 移除曲目：GET `/v3/playlist/tracks/delete`，按 fileid 列表删除。
///
/// 真机待验证（spec §2.4）：路径/字段以 2026 年客户端为准，Task 22 真机
/// 验收；不通则摘能力位。
pub async fn playlist_remove(ctx: &Ctx, id: &str, tracks: &[super::TrackEntry]) -> ApiResult<()> {
    require_tracks(tracks, "移除")?;
    let listid = parse_listid(id)?;
    // 删曲只认 fileid（hash 无法替代），且它只出现在歌单详情结果里。
    // 逐首校验：缺一首就整体 400，绝不 filter_map 静默丢项造成部分删除。
    let mut fileids = Vec::with_capacity(tracks.len());
    for (n, entry) in tracks.iter().enumerate() {
        match entry
            .track_ref
            .as_ref()
            .and_then(|r| r.get("fileid"))
            .and_then(val_string)
        {
            Some(v) if !v.is_empty() => fileids.push(v),
            _ => {
                return Err(bad_request(format!(
                    "第 {} 首缺少 fileid，请先刷新歌单详情后再删除",
                    n + 1
                )))
            }
        }
    }
    let extra = form_map(&[("listid", &listid), ("fileids", &fileids.join(","))]);
    h5_get(ctx, "/v3/playlist/tracks/delete", extra)
        .await
        .map_err(|e| reject_context(e, "酷狗歌单移除曲目失败"))?;
    Ok(())
}

/// 每日推荐：GET `/everyday/recommend`（spec §2.3 原文路径），需登录，无分页。
///
/// 真机待验证（spec §2.4）：路径/字段以 2026 年客户端为准，Task 22 真机
/// 验收；不通则摘能力位。另一项假设：推荐曲目元素字段与搜索项同构
/// （FileHash/SongName 大写键），若真机为小写键，map_track 需在验收时补别名。
pub async fn recommend_songs(ctx: &Ctx) -> ApiResult<super::SearchPage> {
    let j = h5_get(ctx, "/everyday/recommend", BTreeMap::new())
        .await
        .map_err(|e| reject_context(e, "获取酷狗每日推荐失败"))?;
    let d = j.get("data");
    let items = ["/songs", "/list", "/data"]
        .iter()
        .find_map(|p| d.and_then(|v| v.pointer(p)))
        .and_then(|v| v.as_array());
    let tracks: Vec<OnlineTrack> = items
        .map(|arr| {
            arr.iter()
                .map(map_track)
                .filter(|t| !t.id.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Ok(SearchPage {
        source: ID.into(),
        keyword: String::new(),
        total: tracks.len(),
        tracks,
        warning: None,
    })
}

// ===========================================================================
// 扫码登录（login-user.kugou.com v2 网页流程，2026-09 真机核实）：
//   GET  /v2/qrcode               取握手票 + PNG data URL
//   GET  /v2/get_userinfo_qrcode  轮询：1 等待 / 2 已扫码 / 4 已确认 / 0 失效
//   POST loginservice/v1/login_by_token_get  用 userid+token 换会话（AES+RSA）
// 公共参数需 MD5 签名（键排序、首尾夹 H5_SALT，大写）；qrcode_txt 签名用
// 原始值、发送时单次百分号编码，顺序不能反。
// ===========================================================================

const LOGIN_USER: &str = "https://login-user.kugou.com";
const LOGIN_CROSS: &str = "https://loginservice.kugou.com";
/// 扫码端点的 clientver（酷狗 2019 网页登录 SDK 固定值）。
const QR_CLIENTVER: &str = "8131";
/// 换票端点的 clientver。
const TOKEN_CLIENTVER: &str = "1000";
const QR_PLAT: &str = "4";
const QR_SRCAPPID: &str = "2919";
const QR_H5_PAGE: &str = "https://h5.kugou.com/apps/loginQRCode/html/index.html";
const LOGIN_REFERER: &str = "https://login-user.kugou.com/";

/// 对参数表求酷狗网页签名：键排序拼 k=v，首尾夹 H5_SALT，MD5 大写
/// （faultylabs.MD5 输出大写）。
fn web_signature(params: &BTreeMap<String, String>) -> String {
    kugou::h5_sign(params, None).to_uppercase()
}

/// 按键排序拼 query；值原样不编码（与网页 objectToGetParams 一致，
/// base64 的 +/= 也原样发送）。
fn raw_query(params: &BTreeMap<String, String>) -> String {
    params
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// 单次百分号编码（只编码 qrcode_txt 这种签名用原始值、发送需编码的参数）。
fn percent_encode(s: &str) -> String {
    const H: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let safe = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~');
        if safe {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(H[(b >> 4) as usize] as char);
            out.push(H[(b & 0x0f) as usize] as char);
        }
    }
    out
}

/// 创建扫码握手：GET `login-user.kugou.com/v2/qrcode`，匿名（仅需设备身份）。
/// 2026-09 真机验证返回 data:{qrcode, qrcode_img(data:image/png)}。
pub async fn qr_create(ctx: &Ctx) -> ApiResult<super::QrPayload> {
    let (mid, dfid) = device(ctx).await?;
    let qrcode_txt = format!("{QR_H5_PAGE}?appid={WEB_APPID}&name=");
    let qrcode_txt_enc = percent_encode(&qrcode_txt);
    let mut p = BTreeMap::new();
    p.insert("appid".into(), WEB_APPID.into());
    p.insert("clientver".into(), QR_CLIENTVER.into());
    p.insert("clienttime".into(), now_millis());
    p.insert("mid".into(), mid.clone());
    p.insert("uuid".into(), mid);
    p.insert("dfid".into(), dfid);
    p.insert("type".into(), "1".into());
    p.insert("plat".into(), QR_PLAT.into());
    p.insert("srcappid".into(), QR_SRCAPPID.into());
    // 签名用原始 URL；下面发送前才编码。
    p.insert("qrcode_txt".into(), qrcode_txt);
    p.insert("signature".into(), web_signature(&p));

    let mut url = const_url(format!("{LOGIN_USER}/v2/qrcode"))?;
    url.set_query(Some(&raw_query_except_encoded(
        &p,
        &[("qrcode_txt", qrcode_txt_enc)],
    )));
    let h = super::http::headers(None, Some(LOGIN_REFERER));
    let j = super::http::get_json(&client()?, url.as_str(), h).await?;
    if !status_ok(j.get("status")) {
        return Err(ApiError::upstream_rejected(format!(
            "创建酷狗扫码登录失败（status={}, error_code={}）",
            j.get("status")
                .and_then(val_string)
                .unwrap_or_else(|| "缺失".into()),
            j.get("error_code")
                .and_then(val_string)
                .unwrap_or_else(|| "-".into())
        )));
    }
    let d = j.get("data");
    let platform_ticket = pick_str(d, &["qrcode"])
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::upstream_rejected("创建酷狗扫码登录失败：未取得 qrcode 握手票".to_string())
        })?;
    // 上游直接回 data:image/png;base64，前端原样塞进 <img src>。
    let qr_image = pick_str(d, &["qrcode_img", "qrcode", "imgurl"]);
    Ok(super::QrPayload {
        platform_ticket,
        qr_text: None,
        qr_image,
        poll_ms: 1000,
    })
}

/// raw_query 的变体：个别键用替换值发送（如 qrcode_txt 的编码形态）。
fn raw_query_except_encoded(
    params: &BTreeMap<String, String>,
    overrides: &[(&str, String)],
) -> String {
    params
        .iter()
        .map(|(k, v)| {
            let val = overrides
                .iter()
                .find_map(|(ok, ov)| (ok == k).then_some(ov))
                .unwrap_or(v);
            format!("{k}={val}")
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// 用 userid+token 调 loginservice 换会话。
///
/// AES-128-CBC 加密 `{token}`（随机 key，IV=key），RSA 加密
/// `{clienttime_ms,key}`，全部参数仍走公共 MD5 签名。成功后上游通过
/// Set-Cookie 下发 t/KugooID 等会话 cookie，响应体也可能直接带 token。
async fn qr_login_by_token(
    mid: &str,
    dfid: &str,
    scan_userid: &str,
    scan_token: &str,
) -> ApiResult<CredPack> {
    let clienttime_ms = now_millis();
    let clienttime_sec = (clienttime_ms.parse::<u128>().unwrap_or(0) / 1000).to_string();
    let aes_key = kugou_login::random_key();
    let plain_token = serde_json::json!({ "token": scan_token }).to_string();
    let params_enc = kugou_login::aes_encrypt(&plain_token, &aes_key);
    let pk_plain =
        serde_json::json!({ "clienttime_ms": clienttime_ms, "key": aes_key }).to_string();
    let pk = kugou_login::rsa_encrypt(&pk_plain)?;

    let mut p = BTreeMap::new();
    p.insert("appid".into(), WEB_APPID.into());
    p.insert("clientver".into(), TOKEN_CLIENTVER.into());
    p.insert("clienttime".into(), clienttime_sec);
    p.insert("mid".into(), mid.into());
    p.insert("uuid".into(), mid.into());
    p.insert("dfid".into(), dfid.into());
    p.insert("dev".into(), "web".into());
    p.insert("userid".into(), scan_userid.into());
    p.insert("plat".into(), QR_PLAT.into());
    p.insert("clienttime_ms".into(), clienttime_ms);
    p.insert("pk".into(), pk);
    p.insert("params".into(), params_enc);
    p.insert("srcappid".into(), QR_SRCAPPID.into());
    p.insert("signature".into(), web_signature(&p));

    let url = format!("{LOGIN_CROSS}/v1/login_by_token_get?{}", raw_query(&p));
    let mut h = super::http::headers(None, Some(LOGIN_REFERER));
    h.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        ),
    );
    let resp = client()?
        .post(&url)
        .headers(h)
        .send()
        .await
        .map_err(super::http::send_error)?;
    let status = resp.status();
    let resp_headers = resp.headers().clone();
    let body = resp.bytes().await.map_err(super::http::send_error)?;
    let mut jar = BTreeMap::new();
    absorb_cookies(&resp_headers, &mut jar);
    let j: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);

    // status==0 且带 SSA-CODE 头表示触发了滑块风控：这属于设备/行为验证，
    // 红线内不做绕过，如实提示用户稍后再试或改用 cookie。
    let ssa_code = resp_headers
        .get("SSA-CODE")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty());
    if !status.is_success() || (!j.is_null() && !status_ok(j.get("status"))) {
        if ssa_code.is_some() {
            return Err(ApiError::upstream_rejected(
                "酷狗登录需要完成人机验证，已按安全边界跳过；请稍后重试或使用 cookie 登录"
                    .to_string(),
            ));
        }
        let msg = j
            .get("data")
            .and_then(|v| v.as_str())
            .or_else(|| j.get("error_msg").and_then(|v| v.as_str()))
            .unwrap_or("换票失败");
        return Err(ApiError::upstream_rejected(format!(
            "酷狗扫码登录换票失败（{}）",
            msg.chars().take(120).collect::<String>()
        )));
    }

    // token/userid：响应体优先，其次 Set-Cookie（t / KugooID），最后回落扫码票。
    let d = j.get("data");
    let token = pick_str(d, &["token", "t"])
        .or_else(|| jar.get("t").cloned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| scan_token.to_string());
    let userid = pick_str(d, &["userid", "userid_str", "uid", "KugooID"])
        .or_else(|| jar.get("KugooID").cloned())
        .filter(|s| !s.is_empty() && s != "0")
        .unwrap_or_else(|| scan_userid.to_string());
    // 设备 cookie 补齐，业务请求仍以 token+userid 鉴权。
    jar.entry("kg_mid".to_string())
        .or_insert_with(|| mid.to_string());
    let cookie = jar
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ");
    Ok(CredPack {
        token,
        userid,
        cookie,
        mid: mid.into(),
        dfid: dfid.into(),
        ..Default::default()
    })
}

/// 查询扫码状态：GET `login-user.kugou.com/v2/get_userinfo_qrcode`。
///
/// 内层 data.status：1=等待扫码，2=已扫码待确认（含头像/昵称），
/// 4=已确认（含 userid/token，走换票），0=已失效。顶层 status!=1 是请求
/// 本身被拒，不能当 waiting。
pub async fn qr_check(
    ctx: &Ctx,
    platform_ticket: &str,
) -> ApiResult<(String, Option<super::AccountInfo>)> {
    let ticket = platform_ticket.trim();
    if ticket.is_empty() {
        return Err(bad_request("缺少酷狗扫码握手票"));
    }
    let (mid, dfid) = device(ctx).await?;
    let mut p = BTreeMap::new();
    p.insert("appid".into(), WEB_APPID.into());
    p.insert("clientver".into(), QR_CLIENTVER.into());
    p.insert("clienttime".into(), now_millis());
    p.insert("mid".into(), mid.clone());
    p.insert("uuid".into(), mid.clone());
    p.insert("dfid".into(), dfid.clone());
    p.insert("plat".into(), QR_PLAT.into());
    p.insert("qrcode".into(), ticket.to_string());
    p.insert("srcappid".into(), QR_SRCAPPID.into());
    p.insert("signature".into(), web_signature(&p));

    let mut url = const_url(format!("{LOGIN_USER}/v2/get_userinfo_qrcode"))?;
    url.set_query(Some(&raw_query(&p)));
    let h = super::http::headers(None, Some(LOGIN_REFERER));
    let j = super::http::get_json(&client()?, url.as_str(), h).await?;
    if !status_ok(j.get("status")) {
        return Err(ApiError::upstream_rejected(format!(
            "查询酷狗扫码状态失败（status={}, error_code={}）",
            j.get("status")
                .and_then(val_string)
                .unwrap_or_else(|| "缺失".into()),
            j.get("error_code")
                .and_then(val_string)
                .unwrap_or_else(|| "-".into())
        )));
    }
    let d = j.get("data");
    let inner = d.and_then(|v| v.get("status"));
    // data.status==4：已确认，携带 userid/token 去换会话。
    if code_matches(inner, 4, "") {
        let userid = pick_str(d, &["userid", "uid", "userId"])
            .filter(|s| !s.is_empty() && s != "0")
            .ok_or_else(|| {
                ApiError::upstream_rejected("酷狗扫码已确认但响应缺少 userid".to_string())
            })?;
        let token = pick_str(d, &["token"])
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ApiError::upstream_rejected("酷狗扫码已确认但响应缺少 token".to_string())
            })?;
        let pack = qr_login_by_token(&mid, &dfid, &userid, &token).await?;
        if !super::cred::is_signed_in(ID, &pack) {
            return Err(ApiError::upstream_rejected(
                "酷狗扫码凭据落库前校验失败（userid/token 不完整）".to_string(),
            ));
        }
        super::cred::put(&ctx.db, ID, &pack)
            .await
            .map_err(internal_store)?;
        return match account(ctx).await {
            Ok(info) => Ok(("confirmed".to_string(), Some(info))),
            Err(e) => {
                tracing::debug!(error = %e.message, "酷狗扫码登录成功但账号信息回拉失败，稍后补拉");
                Ok(("confirmed".to_string(), None))
            }
        };
    }
    let state = if code_matches(inner, 2, "") {
        "scanned"
    } else if code_matches(inner, 0, "") {
        "expired"
    } else {
        // 1（等待）以及任何未识别码都按 waiting，绝不提前判用户的码失效。
        "waiting"
    };
    Ok((state.to_string(), None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_normalizes_search_items() {
        let body: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/kugou_search.json")).unwrap();
        let arr = body.pointer("/data/lists").unwrap().as_array().unwrap();
        let t0 = map_track(&arr[0]);
        assert_eq!(t0.source, "kugou");
        assert_eq!(t0.id, "8E10D8825DDE03BCABBDE13E5A4150D2");
        assert_eq!(t0.title, "我们应该算爱过吧");
        assert_eq!(t0.duration_ms, 213_000);
        assert!(t0.playable && !t0.vip_only);
        assert_eq!(t0.track_ref["album_id"], "67026620");

        let t1 = map_track(&arr[1]);
        assert!(!t1.playable);
        assert!(t1.vip_only);
        assert!(!t1.title.contains('<'));
        assert_eq!(t1.title, "无版权演示");
        assert_eq!(t1.duration_ms, 60_000);
    }

    #[test]
    fn cover_template_size_is_expanded_and_upgraded() {
        // 酷狗下发的是模板 URL，{size} 不展开就是一张打不开的图。
        let t = map_track(&json!({
            "FileHash": "H",
            "SongName": "晴天",
            "Duration": 240,
            "Image": "http://imge.kugou.com/stdmusic/{size}/20230920/20230920142503632013.jpg"
        }));
        assert_eq!(
            t.cover.as_deref(),
            Some("https://imge.kugou.com/stdmusic/480/20230920/20230920142503632013.jpg")
        );
    }

    #[test]
    fn cover_stays_none_when_upstream_has_none() {
        assert_eq!(cover_of(&json!({})), None);
        // 空串 / 纯空白（搜索结果里 AlbumImage 常常是空串）
        assert_eq!(cover_of(&json!({"Image": "", "AlbumImage": "  "})), None);
    }

    #[test]
    fn dirty_percent_u_text_decodes_and_tags_are_stripped() {
        assert_eq!(clean_text("%u5468%u6770%u4f26"), "周杰伦");
        assert_eq!(clean_text("<em>爱</em>情"), "爱情");
        // HTML 实体（具名 + 十进制数字）。
        assert_eq!(clean_text("a &amp; b &quot;x&#39;y"), "a & b \"x'y");
        // %uXXXX UTF-16 高/低代理对 → 😀。
        assert_eq!(clean_text("%uD83D%uDE00"), "\u{1F600}");
        // 未闭合的 '<' 当普通字符。
        assert_eq!(clean_text("爱<情"), "爱<情");
        // percent-u 与数字实体混用（22269 = 国）。
        assert_eq!(clean_text("%u4e2d&#22269;"), "中国");
    }

    #[test]
    fn listid_supports_global_collection_id_and_plain_number() {
        assert_eq!(parse_listid("12345").unwrap(), "12345");
        assert_eq!(parse_listid("collection_3_888_67890_0").unwrap(), "67890");
        assert!(parse_listid("collection_x").is_err());
        assert!(parse_listid("").is_err());
        // 严格形态：多段、版本号不对、段数不足均拒绝。
        assert!(parse_listid("collection_3_888_67890_0_extra").is_err());
        assert!(parse_listid("collection_2_888_67890_0").is_err());
        assert!(parse_listid("a_b_c_78").is_err());
    }

    #[test]
    fn channel_order_prefers_gateway_for_high_quality_when_signed_in() {
        assert_eq!(
            channel_plan(false, 128_000),
            vec!["mobile", "h5", "h5_retry"]
        );
        assert_eq!(
            channel_plan(false, 740_000),
            vec!["mobile", "h5", "h5_retry"]
        );
        assert_eq!(
            channel_plan(true, 320_000),
            vec!["gateway", "mobile", "h5", "h5_retry"]
        );
        assert_eq!(
            channel_plan(true, 740_000),
            vec!["gateway", "mobile", "h5", "h5_retry"]
        );
        assert_eq!(
            channel_plan(true, 128_000),
            vec!["mobile", "h5", "h5_retry"]
        );
    }
}
