// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 在线曲库代理。
//!
//! 浏览器的 fetch 打不到第三方音乐接口（CORS + Referer 校验），所以搜索与
//! 试听地址解析都放在服务端做。每个音源只做「转发 + 归一化」两件事：
//!
//!   上游 JSON ──► OnlineTrack ──► 前端
//!
//! 归一化很关键：不同音源的字段名、时长单位（秒 / 毫秒 / m:ss）、歌手数组结构
//! 都不一样，前端不该为每个音源写一套解析。
//!
//! ## 加一个音源的成本
//!
//! 只需要三处，且都不碰前端：
//!
//!   1. 新建 `online/<id>.rs`，实现 `search` / `stream` / `detail` / `lyric`
//!      四个函数（音源没有的能力就返回空值，不要编造）；
//!   2. 在下面的 [`SOURCES`] 里加一条描述，并在 [`search`] 等 dispatch 函数里
//!      加一个 `match` 分支；
//!   3. 如果它需要 Referer 才能下载音频，把地址写进 [`referer`]。
//!
//! 前端的选择框、分类 chips、登录入口全部由 `GET /v1/online/sources` 驱动，
//! 所以描述表加完，界面就自动多出一个音源。
//!
//! ## 明确不做的事
//!
//! 这里只接**公开文档化的 API**和**用户自己账号的凭据**。DRM/加密音频的解密、
//! 逆向出来的反爬签名与设备指纹、厂商私有的付费内容接口都不在本项目的边界内：
//! 那类实现即便只存在于用户本地，也属于规避技术保护措施，而且会把整个分发
//! 传染成法律上有问题的版本。宁可少一个音源。

mod ccmixter;
mod netease;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{bad_request, ApiError, ApiResult};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
/// 建连与单次读取的上限，而不是「整条请求的总时长」。
///
/// 这里原来是一个 `.timeout(12s)`：reqwest 的 timeout 覆盖到响应体读完为止，
/// 所以一首几 MB 的完整曲目在慢链路上会被自己掐断，报出来是一句看不懂的
/// "error decoding response body"。拆成连接超时 + 读空闲超时之后，JSON 接口
/// 慢一点不会被误杀；下载另外再叠一个总时长上限（见 `DOWNLOAD_TIMEOUT`）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const READ_TIMEOUT: Duration = Duration::from_secs(12);

/// 单曲下载的大小上限。
const MAX_AUDIO_BYTES: u64 = 64 * 1024 * 1024;

/// 整首下载允许占用的总时长。只在下载这条路上加：一首正常的歌几十秒内一定
/// 走完，而挂死的连接必须有个地方被放弃。
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

pub fn client() -> ApiResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .user_agent(UA)
        .build()
        .map_err(|e| ApiError::internal(format!("HTTP 客户端初始化失败: {e}")))
}

/// 设置表里 cookie 键的前缀。`get_settings` 按它过滤，绝不把凭据回显给前端。
pub const COOKIE_PREFIX: &str = "online_cookie_";

/// 归一化后的在线曲目。字段名与本地 `Track` 对齐，前端可以用同一套渲染。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineTrack {
    /// 音源标识，回传给播放端点时要带上
    pub source: String,
    /// 音源内的曲目 id（字符串，兼容数字与 hash 两种形态）
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    /// 封面地址；音源不提供时为 None，前端回落到占位图
    pub cover: Option<String>,
    /// 是否有可用的试听地址（搜索阶段就能判断，用来决定按钮是否可点）
    pub playable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchPage {
    pub source: String,
    pub keyword: String,
    pub total: usize,
    pub tracks: Vec<OnlineTrack>,
    /// 上游返回的错误或降级说明；为空表示一切正常
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    /// 分类 id；与 q 二选一，都不给就取热门
    pub cat: Option<String>,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
}

fn default_source() -> String {
    SOURCES[0].id.to_string()
}
fn default_limit() -> usize {
    30
}

/// 一个音源对外界的全部自述。前端只认这张表，不硬编码任何音源名。
#[derive(Debug, Clone, Serialize)]
pub struct SourceInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// 分类浏览的候选项；空数组表示这个音源只有关键词检索。
    pub cats: &'static [(&'static str, &'static str)],
    /// 支持「用户自己的账号 cookie」，UI 才需要给出登录入口。
    pub supports_cookie: bool,
}

pub const SOURCES: &[SourceInfo] = &[
    SourceInfo {
        id: "netease",
        label: "网易云音乐",
        cats: netease::CATS,
        supports_cookie: true,
    },
    SourceInfo {
        id: "ccmixter",
        label: "CCmixter · CC 授权曲库",
        cats: &[],
        supports_cookie: false,
    },
];

pub fn find(source: &str) -> Option<&'static SourceInfo> {
    SOURCES.iter().find(|s| s.id == source)
}

/// 下载音频时要带的 Referer。
///
/// 多个音源共用一个下载函数，而 Referer 各不相同——CCmixter 对无 Referer 的
/// 直链请求直接回 403。以前这里把网易云的地址写死，换第二个音源就会全部下载
/// 失败，所以它必须跟着音源走。
fn referer(source: &str) -> Option<&'static str> {
    match source {
        "netease" => Some("https://music.163.com"),
        "ccmixter" => Some("https://ccmixter.org/"),
        _ => None,
    }
}

/// 每次上游请求都要用到的上下文。目前只装设置表的连接，用来读用户自己填的
/// 凭据；音源不该再去碰 AppState，才好单独测。
#[derive(Clone)]
pub struct Ctx {
    pub db: SqlitePool,
}

impl Ctx {
    /// 用户自己填的账号 cookie。空串与全空白都算「没登录」。
    pub async fn cookie(&self, source: &str) -> Option<String> {
        let value = vmusic_store::settings::get(&self.db, &format!("{COOKIE_PREFIX}{source}"))
            .await
            .ok()??;
        value
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
}

/// 把 reqwest 的错误链摊平。
///
/// 它的 Display 只有最外层那一句（"error decoding response body"），而真正的
/// 原因挂在 source 上（是连接被掐、是读超时、还是对方给 mp3 套了一层 gzip）。
/// 不摊开的话，用户报回来的截图就永远只有一句没用的话。
fn req_error(action: &str, err: &reqwest::Error) -> ApiError {
    let mut chain = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(inner) = source {
        chain.push_str(" ← ");
        chain.push_str(&inner.to_string());
        source = inner.source();
    }
    ApiError::internal(format!("{action}: {chain}"))
}

/// 封面地址统一升到 https。
///
/// 页面本身跑在 http 上时混用 http 图片只是不美观，但一旦跑在 https 下，
/// 浏览器会直接拦掉 http 子资源 —— 表现就是「封面怎么都不出来」。
fn https_url(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("//") {
        return Some(format!("https:{trimmed}"));
    }
    if trimmed.starts_with("http://") {
        return Some(trimmed.replacen("http://", "https://", 1));
    }
    Some(trimmed.to_string())
}

/// 把 "3:27" / "21" 这类时长写法折成毫秒。CCmixter 给的就是 m:ss。
fn parse_clock_ms(text: &str) -> u64 {
    let text = text.trim();
    if text.is_empty() {
        return 0;
    }
    text.split(':')
        .map(|part| part.trim().parse::<u64>().unwrap_or(0))
        .fold(0u64, |acc, unit| acc * 60 + unit)
        * 1000
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/// 音源清单。`signedIn` 要查设置表，所以这一步是异步的。
pub async fn list_sources(ctx: &Ctx) -> Vec<serde_json::Value> {
    let mut out = Vec::with_capacity(SOURCES.len());
    for src in SOURCES {
        let signed_in = src.supports_cookie && ctx.cookie(src.id).await.is_some();
        out.push(serde_json::json!({
            "id": src.id,
            "label": src.label,
            "cats": src.cats.iter()
                .map(|(k, v)| serde_json::json!({"id": k, "label": v}))
                .collect::<Vec<_>>(),
            "supportsCookie": src.supports_cookie,
            "signedIn": signed_in,
        }));
    }
    out
}

pub async fn search(ctx: &Ctx, q: SearchQuery) -> ApiResult<SearchPage> {
    if q.q.as_deref().map(str::trim).unwrap_or("").is_empty() && q.cat.is_none() {
        return Err(bad_request("需要给出搜索关键词或分类"));
    }
    match q.source.as_str() {
        "netease" => netease::search(ctx, &q).await,
        "ccmixter" => ccmixter::search(ctx, &q).await,
        other => Err(bad_request(format!("不支持的音源: {other}"))),
    }
}

/// 试听地址。
///
/// 失败时的错误文案由音源自己决定要不要提「登录」：只有它知道这个结果是不是
/// 因为没带凭据。前端把这句话原样显示，所以那一步提示必须在服务端就写好。
#[derive(Debug, Clone, Serialize)]
pub struct StreamInfo {
    pub url: String,
    pub source: String,
    pub id: String,
    /// 上游给的码率（bps），拿不到时为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u64>,
    pub expires_in_secs: Option<u64>,
}

pub async fn stream(
    ctx: &Ctx,
    source: &str,
    id: &str,
    quality: Option<u32>,
) -> ApiResult<StreamInfo> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let q = quality.unwrap_or(320_000);
    match source {
        "netease" => netease::stream(ctx, id, q).await,
        "ccmixter" => ccmixter::stream(ctx, id, q).await,
        other => Err(bad_request(format!("不支持的音源: {other}"))),
    }
}

/// 单曲详情。搜索接口返回的字段不全（尤其是封面），播放前用它补齐。
#[derive(Debug, Clone, Serialize)]
pub struct OnlineDetail {
    pub source: String,
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    pub cover: Option<String>,
}

pub async fn detail(ctx: &Ctx, source: &str, id: &str) -> ApiResult<OnlineDetail> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    match source {
        "netease" => netease::detail(ctx, id).await,
        "ccmixter" => ccmixter::detail(ctx, id).await,
        other => Err(bad_request(format!("不支持的音源: {other}"))),
    }
}

/// 在线歌词。返回的形状和本地 `/v1/tracks/{id}/lyrics` 完全一致，
/// 前端因此可以复用同一套渲染代码，不需要为在线歌词再写一份解析。
///
/// 「这首歌没有歌词」是正常结果而不是错误：一律返回空文档，由前端显示占位文案。
pub async fn lyric(ctx: &Ctx, source: &str, id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    match source {
        "netease" => netease::lyric(ctx, id).await,
        "ccmixter" => ccmixter::lyric(ctx, id).await,
        other => Err(bad_request(format!("不支持的音源: {other}"))),
    }
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

/// 试听用的虚拟曲目 id。
///
/// 音频后端只吃本地文件路径，所以在线试听必须先把远程流落盘。落盘之后走的
/// 是和本地曲目完全相同的 `audio.load()` 链路，只是 id 带 `online:` 前缀 ——
/// 队列、快照、进度条因此全部复用，不需要为在线播放单开一条状态机。
pub fn virtual_id(source: &str, id: &str) -> String {
    format!("online:{source}:{id}")
}

/// 从虚拟 id 反解出 (source, id)。
///
/// 上一首/下一首走到在线曲目时会用到：队列里存的是虚拟 id，播放时要能反推出
/// 缓存文件路径，否则 `play_index` 只会去本地库里查、必然查不到。
pub fn split_virtual_id(vid: &str) -> Option<(String, String)> {
    let rest = vid.strip_prefix("online:")?;
    let (source, id) = rest.split_once(':')?;
    if source.is_empty() || id.is_empty() {
        return None;
    }
    Some((source.to_string(), id.to_string()))
}

/// 缓存文件名。音源 id 可能带路径分隔符，统一洗一遍避免越权写文件。
///
/// CCmixter 的 id 是一条站内路径，长起来没有上限，而 Windows 的路径预算只有
/// 260 字符。所以超长时截断，并把完整 id 的散列拼在尾巴上：只截断的话，两个
/// 前缀相同、只差在后缀的曲目会共用同一个缓存文件，表现是「点了 A 放出 B」。
pub fn cache_name(source: &str, id: &str) -> String {
    let raw = format!("{source}-{id}");
    let safe: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stem = if safe.len() <= 96 {
        safe
    } else {
        format!("{}-{:08x}", &safe[..96], fnv1a(&raw))
    };
    format!("{stem}.mp3")
}

fn fnv1a(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// 把远程音频拉到本地缓存目录，返回可直接喂给 audio actor 的路径。
///
/// 已经在缓存里的直接复用，不重复下载。写临时文件再 rename，避免进程被杀时
/// 留下一个半截的 mp3 被下次播放当成完整文件。
pub async fn fetch_to_cache(
    dir: &std::path::Path,
    source: &str,
    id: &str,
    url: &str,
) -> ApiResult<std::path::PathBuf> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| ApiError::internal(format!("创建缓存目录失败: {e}")))?;

    let final_path = dir.join(cache_name(source, id));
    if let Ok(meta) = tokio::fs::metadata(&final_path).await {
        if meta.len() > 1024 {
            return Ok(final_path);
        }
    }

    let mut req = client()?.get(url).timeout(DOWNLOAD_TIMEOUT);
    if let Some(referer) = referer(source) {
        req = req.header("Referer", referer);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| req_error("下载试听音频失败", &e))?;
    if !resp.status().is_success() {
        return Err(ApiError::internal(format!(
            "试听地址返回 HTTP {}",
            resp.status()
        )));
    }
    // 地址是第三方给的，所以先问一句多大再往内存里收。一首歌几十 MB 已经到顶，
    // 报 64MB 以上的 Content-Length 只可能是坏了或者在耍人。
    //
    // 这只拦得住诚实的服务器：分块传输可以谎报长度。真要封顶得改成边读边计数的
    // 流式落盘，那是十几倍代码量，对一个本地回环服务不值得。
    if resp
        .content_length()
        .is_some_and(|len| len > MAX_AUDIO_BYTES)
    {
        return Err(ApiError::internal(
            "试听地址声称的内容过大，已放弃下载".to_string(),
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| req_error("读取试听音频失败", &e))?;
    if bytes.len() < 1024 {
        return Err(ApiError::internal(
            "试听地址返回的内容过小，可能已被版权限制".to_string(),
        ));
    }

    let tmp = dir.join(format!(".{}.part", cache_name(source, id)));
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| ApiError::internal(format!("写入缓存失败: {e}")))?;
    tokio::fs::rename(&tmp, &final_path)
        .await
        .map_err(|e| ApiError::internal(format!("落盘缓存失败: {e}")))?;
    Ok(final_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_source_is_dispatchable_and_described() {
        // 描述表和 dispatch 必须同步：漏了一边就是「列表里有这个音源，搜了报错」，
        // 或者反过来——能搜但界面上选不到。
        for src in SOURCES {
            assert!(!src.id.is_empty());
            assert!(!src.label.is_empty());
            assert!(!src.cats.iter().any(|(k, _)| k.is_empty()));
            assert!(find(src.id).is_some());
        }
        assert!(find("nope").is_none());
    }

    #[test]
    fn default_search_source_is_the_first_registered_one() {
        assert_eq!(default_source(), SOURCES[0].id);
    }

    #[test]
    fn cache_names_cannot_escape_the_cache_directory() {
        assert_eq!(cache_name("netease", "123"), "netease-123.mp3");
        // 点号不在白名单里，所以 ".." 连不成路径上跳，只能变成两个下划线。
        assert_eq!(
            cache_name("ccmixter", "../../etc/passwd"),
            "ccmixter-______etc_passwd.mp3"
        );
        assert!(!cache_name("a", "b/\\c:d").contains('/'));
        assert!(!cache_name("a", "b/\\c:d").contains('\\'));
        assert!(!cache_name("a", "..").contains(".."));
    }

    #[test]
    fn long_ids_are_truncated_without_colliding() {
        let base = "content/a/".to_string() + &"x".repeat(200);
        assert_eq!(cache_name("ccmixter", &base).len(), 96 + 9 + 4);
        // 只有尾巴不同的两条长 id，截断之后必须落到不同的文件上
        let left = cache_name("ccmixter", &format!("{base}1"));
        let right = cache_name("ccmixter", &format!("{base}2"));
        assert_ne!(left, right);
        // 清洗后的名字只有 ASCII，按字节切不会踩到字符边界
        assert!(left.is_ascii());
    }

    #[test]
    fn virtual_ids_roundtrip() {
        let vid = virtual_id("ccmixter", "71185");
        assert_eq!(vid, "online:ccmixter:71185");
        assert_eq!(
            split_virtual_id(&vid).unwrap(),
            ("ccmixter".into(), "71185".into())
        );
        // id 里带冒号时按第一个冒号切，后面的整体算 id
        assert_eq!(split_virtual_id("online:netease:a:b").unwrap().1, "a:b");
        assert!(split_virtual_id("local:1").is_none());
        assert!(split_virtual_id("online:").is_none());
        assert!(split_virtual_id("online:x:").is_none());
    }

    #[test]
    fn clock_strings_become_milliseconds() {
        assert_eq!(parse_clock_ms("3:27"), 207_000);
        assert_eq!(parse_clock_ms("0:21"), 21_000);
        assert_eq!(parse_clock_ms("21"), 21_000);
        assert_eq!(parse_clock_ms("1:02:03"), 3_723_000);
        assert_eq!(parse_clock_ms(""), 0);
        assert_eq!(parse_clock_ms("  "), 0);
        // 上游给脏数据时不能 panic，也不能产出负数
        assert_eq!(parse_clock_ms("a:b"), 0);
    }

    #[test]
    fn cover_urls_are_upgraded_to_https() {
        assert_eq!(
            https_url("http://a/b.jpg").as_deref(),
            Some("https://a/b.jpg")
        );
        assert_eq!(https_url("//a/b.jpg").as_deref(), Some("https://a/b.jpg"));
        assert_eq!(https_url("  "), None);
        assert_eq!(
            https_url("https://a/b.jpg").as_deref(),
            Some("https://a/b.jpg")
        );
    }

    #[test]
    fn each_download_gets_its_own_referer() {
        // CCmixter 对无 Referer 的直链回 403，网易云的 CDN 要求 music.163.com。
        assert_eq!(referer("netease"), Some("https://music.163.com"));
        assert!(referer("ccmixter")
            .unwrap()
            .starts_with("https://ccmixter.org"));
        assert_eq!(referer("nope"), None);
    }
}
