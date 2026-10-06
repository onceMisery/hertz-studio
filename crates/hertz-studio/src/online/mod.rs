// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

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
//! 对接范围是平台网页端/自家客户端**公开使用的端点**，以及用户自己账号的凭据。
//! 平台客户端自身要求的请求签名（酷狗 MD5、QQ 的 `zzc`/vkey、网易云扫码）由
//! 项目所有者明确授权实现（设计决策 D7）：只在用户本机、以用户本人凭据调用，
//! 不分发平台内容。仍然不碰的东西：
//!
//!   - DRM/加密音频的解密（CENC/加密容器一律不碰）；
//!   - 付费墙绕过与会员权益判定的模拟（VIP 曲目如实置灰）；
//!   - 伪造设备指纹、平台未公开的私有付费内容接口；
//!   - 账号池与他人凭据的存储/共享。
//!
//! 这类实现即便只存在于用户本地，越线也属于规避技术保护措施，而且会把整个分发
//! 传染成法律上有问题的版本。宁可少一个音源；能力失败如实报错，绝不伪造空成功。

mod aggregate;
pub mod cache;
mod ccmixter;
pub(crate) mod cred;
mod http;
mod jamendo;
mod kugou;
mod kuwo;
// 取流候选阶梯：Candidate 出现在 StreamInfo 与 progressive::start 的公开签名里，
// 所以对外可见；阶梯的构造规则集中在该文件。
pub mod ladder;
mod migu;
mod netease;
mod playlist_common;
pub mod progressive;
mod qishui;
mod qq;
// state.rs 的 AppState 持有 qr::Registry，routes.rs 要校验 Session 来源，
// 所以对子模块外暴露到 crate 内；平台协议细节仍关在 online 内部。
pub(crate) mod qr;
pub mod quality;
mod sign;

// 候选类型出现在 StreamInfo 与 progressive::start 的签名上，平台模块和上层都
// 直接按 online::Candidate 引用，不必写 ladder 这段路径。
pub use ladder::Candidate;

// cred 是 online 的私有子模块，routes 过滤凭据键/手动登录/登出/回读登录态
// 时需要这些入口。
pub(crate) use cred::{
    clear as cred_clear, get as cred_get, is_signed_in as cred_is_signed_in,
    put_cookie as cred_put_cookie, CRED_PREFIX,
};

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
/// 慢一点不会被误杀；渐进式下载器在 progressive 模块内自带大小封顶。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const READ_TIMEOUT: Duration = Duration::from_secs(12);

/// 进程级共享 API 客户端（连接池复用）。
fn shared_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .user_agent(UA)
            .build()
            .expect("reqwest client")
    })
}

pub fn client() -> ApiResult<reqwest::Client> {
    Ok(shared_client().clone())
}

/// 下载用客户端：读空闲超时放宽到 30s，不设整体超时（长曲目慢链路保活）。
/// 供 [`progressive`] 渐进式下载器使用。
pub fn download_client() -> ApiResult<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    Ok(CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(Duration::from_secs(30))
                .user_agent(UA)
                .build()
                .expect("reqwest download client")
        })
        .clone())
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
    #[serde(default)]
    pub vip_only: bool,
    /// 平台原始引用（QQ media_mid、酷狗 album_id/mixsongid/fileid 等）。
    #[serde(default, rename = "ref")]
    pub track_ref: TrackRef,
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

/// 音源能力位。前端 UI 全部由它驱动：没有的能力不显示入口。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    QrLogin,
    CookieLogin,
    UserPlaylists,
    PlaylistDetail,
    PlaylistWrite,
    Like,
    RecommendSongs,
    RecommendPlaylists,
    /// 私人 FM：网易云连续歌曲推荐，游客可用性由上游决定。
    PersonalFm,
    HighQuality,
    /// 在线歌单搜索：按关键词检索平台侧公开歌单（咪咕首个数据源）。
    PlaylistSearch,
    /// 在线歌手搜索：按关键词检索平台侧歌手，可进歌手页取热门歌曲。
    ArtistSearch,
    /// 在线专辑搜索：按关键词检索平台侧专辑，可进专辑页取全部曲目。
    AlbumSearch,
}

/// 平台曲目原始引用。写操作/播放取流时平台模块需要平台专有 id，
/// 归一化的 OnlineTrack 只暴露稳定 id，其余都装进这个不透明 JSON。
pub type TrackRef = serde_json::Value;

/// 写操作（spec §1.4 `tracks[]`）入站曲目：`id` 是平台稳定曲目 id（必填），
/// `track_ref` 是搜索/歌单详情结果里带回的不透明载荷（可选，JSON 字段名 ref）。
///
/// 载荷缺失时平台模块**仅用 id 尝试**；只有 id 无法替代的专有字段
/// （QQ 删曲的数字 song_id、酷狗删曲的 fileid）缺失时显式回 400，
/// 不静默丢项、不伪造部分成功。
#[derive(Debug, Clone, Deserialize)]
pub struct TrackEntry {
    pub id: String,
    #[serde(default, rename = "ref")]
    pub track_ref: Option<TrackRef>,
}

impl TrackEntry {
    /// 从 track_ref 取非空字符串字段；载荷缺失/类型不符/空串一律 None，
    /// 调用方自行决定回落（通常回落到稳定 id）还是报错。
    pub fn ref_str(&self, key: &str) -> Option<&str> {
        self.track_ref
            .as_ref()?
            .get(key)?
            .as_str()
            .filter(|s| !s.is_empty())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OnlinePlaylist {
    pub source: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    pub track_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_count: Option<u64>,
    #[serde(default)]
    pub creator: String,
    /// created | collected | liked
    pub kind: String,
    /// 歌单简介。上游多数接口不给（咪咕的歌单搜索就没有该字段），
    /// 缺省即不序列化，前端按「无简介」处理。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 在线歌单搜索结果页。与 [`SearchPage`] 对称：source/keyword/total 是页级
/// 元信息，playlists 是归一化后的条目。
#[derive(Debug, Clone, Serialize)]
pub struct PlaylistSearchPage {
    pub source: String,
    pub keyword: String,
    pub total: usize,
    pub playlists: Vec<OnlinePlaylist>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlaylistDetail {
    pub playlist: OnlinePlaylist,
    pub total: u64,
    #[serde(default)]
    pub tracks: Vec<OnlineTrack>,
}

/// 归一化后的在线歌手。字段名对齐前端卡片渲染：name 之外的一切都可缺省。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineArtist {
    pub source: String,
    pub id: String,
    pub name: String,
    /// 别名/外文名（如 "Jay Chou"）；多值折成一个串，缺省不序列化。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// 平台侧歌曲总数（搜索结果常带，进歌手页后作为分页总数）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub song_count: Option<u64>,
}

/// 歌手搜索结果页。与 [`PlaylistSearchPage`] 同构。
#[derive(Debug, Clone, Serialize)]
pub struct ArtistSearchPage {
    pub source: String,
    pub keyword: String,
    pub total: usize,
    pub artists: Vec<OnlineArtist>,
}

/// 归一化后的在线专辑。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineAlbum {
    pub source: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_count: Option<u64>,
    /// 发行时间（毫秒时间戳）；上游不给就不序列化，前端也不猜。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish_time: Option<u64>,
}

/// 专辑搜索结果页。与 [`PlaylistSearchPage`] 同构。
#[derive(Debug, Clone, Serialize)]
pub struct AlbumSearchPage {
    pub source: String,
    pub keyword: String,
    pub total: usize,
    pub albums: Vec<OnlineAlbum>,
}

/// 歌手页 / 专辑页的曲目集合详情。与 [`PlaylistDetail`] 对称但没有平台歌单
/// 的 kind/creator 语义：头部信息（name/cover）由本端点给出，曲目走与歌单
/// 详情同一套 `OnlineTrack` 渲染。
///
/// `total` 是平台侧已知总数；上游只给 `more` 布尔（不给总数）时，`total` 取
/// 「已加载数 + (more ? 1 : 0)」的保守值，`more` 原样透传——前端优先用
/// `more` 判断翻页，`total` 只作展示兜底。
#[derive(Debug, Clone, Serialize)]
pub struct CollectionDetail {
    /// artist | album
    pub kind: String,
    pub source: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// 专辑页给主歌手名，歌手页留空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    pub total: u64,
    #[serde(default)]
    pub more: bool,
    #[serde(default)]
    pub tracks: Vec<OnlineTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountInfo {
    pub source: String,
    #[serde(default)]
    pub nickname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default)]
    pub vip_level: u32,
    #[serde(default)]
    pub vip_label: String,
}

/// 路由层 /qr/poll 的响应体（platform_ticket 在 qr::Registry 兑换后不外露）。
#[derive(Debug, Clone, Serialize)]
pub struct QrPoll {
    /// waiting | scanned | confirmed | expired
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountInfo>,
}

/// 平台扫码创建结果（平台握手票 + 二维码载荷）。路由层用 qr::Registry
/// 把 platform_ticket 换成不透明 ticket 返回前端；平台模块不接触 Registry。
#[derive(Debug, Clone)]
pub struct QrPayload {
    pub platform_ticket: String,
    pub qr_text: Option<String>,
    pub qr_image: Option<String>,
    pub poll_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailedSource {
    pub source: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AggregateSearch {
    pub query: String,
    pub results: Vec<SearchPage>,
    pub failed: Vec<FailedSource>,
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
    pub caps: &'static [Capability],
}

/// caps 是前端 UI 与 dispatch 的**唯一事实表**：能力位没开的能力，dispatch
/// 的 [`gate`] 一律回 capability_unsupported——代码已实现但真机闸门（spec §4.3）
/// 没过的平台（如当前的 QQ 扫码、酷狗写操作）只摘能力位，不必删代码。
pub const SOURCES: &[SourceInfo] = &[
    SourceInfo {
        id: "netease",
        label: "网易云音乐",
        cats: netease::CATS,
        supports_cookie: true,
        caps: &[
            Capability::CookieLogin,
            Capability::QrLogin,
            Capability::UserPlaylists,
            Capability::PlaylistDetail,
            Capability::PlaylistWrite,
            Capability::Like,
            Capability::RecommendSongs,
            Capability::RecommendPlaylists,
            Capability::PersonalFm,
            Capability::HighQuality,
            // 公开网页 GET 接口（/api/search/get 带 type、/api/v1/artist、
            // /api/v1/album），无需签名、匿名可用（2026-10 实测）。歌单搜索
            // 走同一端点的 type=1000；咪咕的歌单搜索是另一条 H5 链路。
            Capability::PlaylistSearch,
            Capability::ArtistSearch,
            Capability::AlbumSearch,
        ],
    },
    SourceInfo {
        id: "qq",
        label: "QQ音乐",
        cats: &[],
        supports_cookie: true,
        // 扫码走 QQ Connect 授权链（2026-09 真机验证 waiting 态返回正常）；
        // Like 暂无平台实现（红心等价 dirid=201 加曲，待真机后补）。
        // RecommendSongs 走雷达端点（2026-09 真机验证，需登录态）：QQ 这条
        // Web CGI 上没有叫"每日推荐"的端点，但 GetRadarSong 给的就是个性化
        // 推荐歌曲，见 qq::recommend_songs 的注释。
        caps: &[
            Capability::CookieLogin,
            Capability::QrLogin,
            Capability::UserPlaylists,
            Capability::PlaylistDetail,
            Capability::PlaylistWrite,
            Capability::RecommendSongs,
            Capability::RecommendPlaylists,
            Capability::HighQuality,
        ],
    },
    SourceInfo {
        id: "kugou",
        label: "酷狗音乐",
        cats: &[],
        supports_cookie: true,
        // 扫码走 login-user.kugou.com v2 网页流（2026-09 真机验证
        // create + waiting 正常）；confirmed 换票链路待真机确认。
        // 歌单详情/用户歌单/写操作/推荐/红心端点仍待真机后逐个摘开。
        caps: &[
            Capability::CookieLogin,
            Capability::QrLogin,
            Capability::HighQuality,
        ],
    },
    SourceInfo {
        id: "kuwo",
        label: "酷我音乐",
        cats: &[],
        supports_cookie: true,
        // 登录只有 cookie 粘贴一条路（uid 判态，spike 2026-09-27 无账号
        // 实测，字段名待核对）；匿名档位上限 128k 完整曲/试听片段，登录
        // 通道对移动接口的效果待实测——不标 HighQuality（标了等于承诺
        // 拿得到无损）。
        caps: &[Capability::CookieLogin],
    },
    SourceInfo {
        id: "ccmixter",
        label: "CCmixter · CC 授权曲库",
        cats: &[],
        supports_cookie: false,
        caps: &[],
    },
    SourceInfo {
        id: "jamendo",
        label: "Jamendo · CC 授权曲库",
        cats: &[],
        // client_id 由用户注册后写入 settings（jamendo::CLIENT_ID_KEY）；
        // 未配置时 list_sources 与聚合搜索都会跳过，列表里不出现这个源。
        supports_cookie: false,
        caps: &[],
    },
    SourceInfo {
        id: "qishui",
        label: "汽水音乐",
        cats: &[],
        supports_cookie: true,
        // 登录入口有两条：粘贴 cookie，以及官方 Passport 网页接口的扫码。
        //
        // 扫码这条曾经是被排除的——参考实现的扫码桥接依赖伪造设备指纹与 JS
        // 挑战求解（bdms/sdk-glue），属于规避平台风控。实测（2026-09-22）
        // 发现官方 Passport 的 `get_qrcode` / `check_qrconnect` 裸请求即可用
        // （error_code 0，二维码由服务端下发），既不需要 a_bogus/msToken，也
        // 不需要任何设备指纹，所以「不伪造指纹、不求解 JS 挑战」这两条底线
        // 仍然守住，扫码因此可以登记。唯一做不到的是上游 2046 二次验证要跑
        // 官方 JS，遇到它回终态 mfa_required 引导走 cookie（见 qishui.rs）。
        //
        // 能力位只登记确实接通的东西：搜索/详情/歌词/取流走公共 dispatch；
        // 加密音质一律不解密（如实报 vip_required），所以连 HighQuality 都不
        // 登记——标了它等于承诺能拿到高音质，而受保护的高音质我们是拒播的。
        caps: &[Capability::CookieLogin, Capability::QrLogin],
    },
    SourceInfo {
        id: "migu",
        label: "咪咕音乐",
        cats: &[],
        supports_cookie: false,
        // 只登记「歌单搜索」这一项公开能力（咪咕 H5 端点，无需签名）。
        // 单曲搜索/详情/歌词是公共 dispatch，不占能力位；取流响应是 AES 加密
        // 密文，本项目不解密，因此**不**登记任何播放/高音质能力位，搜索结果的
        // playable 一律 false（见 migu.rs 模块文档）。
        caps: &[Capability::PlaylistSearch],
    },
];

pub fn find(source: &str) -> Option<&'static SourceInfo> {
    SOURCES.iter().find(|s| s.id == source)
}

/// 设置页里「音质可调」的音源清单。
///
/// 按 [`quality::allowed_for`] 的档位表派生，而不是按能力位：取流是公共
/// dispatch、不占能力位（见 [`SourceInfo::caps`] 的说明），而档位表本来就是
/// 「这个源能让用户选什么」的唯一事实源。之前路由里另抄了一份源名，两边就
/// 各自漏过不同的项——酷我在表里有三档却在设置页不可达，汽水取流压根不看
/// quality（`qishui::stream` 忽略入参）却占着一个设置项。
///
/// 只暴露单档的源不进这个清单：给了选项也是 `clamp_to_allowed` 夹回标准档，
/// 等于一个不生效的下拉框。
pub fn quality_sources() -> Vec<&'static str> {
    SOURCES
        .iter()
        .filter(|s| quality::allowed_for(s.id).len() > 1)
        .map(|s| s.id)
        .collect()
}

/// 平台地址常量 → `Url`，失败返回内部错误而不是 panic。
///
/// 这些地址写死在源码里，解析失败只可能是开发期笔误；但
/// `Url::parse(..).unwrap()` 在 release 构建（`panic = "abort"`）下会把
/// 「某个音源的请求发不出去」升级成「整个进程退出」——正在听的本地曲也跟着没了。
/// 降级成 `ApiError` 之后，最坏结果是这一个音源报错，其余音源与本地播放不受影响。
pub(crate) fn const_url(raw: impl AsRef<str>) -> ApiResult<reqwest::Url> {
    let raw = raw.as_ref();
    reqwest::Url::parse(raw).map_err(|e| crate::error::internal(format!("平台地址无效 {raw}: {e}")))
}

/// 下载音频时要带的 Referer。
///
/// 多个音源共用一个下载函数，而 Referer 各不相同——CCmixter 对无 Referer 的
/// 直链请求直接回 403。以前这里把网易云的地址写死，换第二个音源就会全部下载
/// 失败，所以它必须跟着音源走。
// pub(crate)：渐进式播放接入后，state.rs 的播放/预取流程也要按音源带 Referer。
pub(crate) fn referer(source: &str) -> Option<&'static str> {
    match source {
        "netease" => Some("https://music.163.com"),
        // QQ/酷狗的 CDN 直链校验 Referer，缺了直接 403（Task 15 落盘播放依赖）。
        "qq" => Some("https://y.qq.com/"),
        "kugou" => Some("https://www.kugou.com/"),
        "kuwo" => Some("https://www.kuwo.cn/"),
        "ccmixter" => Some("https://ccmixter.org/"),
        // 汽水的音频 CDN 校验来源页，缺了直接 403。
        "qishui" => Some("https://www.qishui.com/"),
        // 咪咕 H5 接口校验来源页。
        "migu" => Some("https://y.migu.cn/"),
        _ => None,
    }
}

/// 每次上游请求都要用到的上下文。目前只装设置表的连接，用来读用户自己填的
/// 凭据；音源不该再去碰 AppState，才好单独测。
#[derive(Clone)]
pub struct Ctx {
    pub db: SqlitePool,
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

/// 标准 Base64 解码（QQ/酷狗歌词接口返回 base64 文本）。填空用的简易实现，
/// 错误输入返回 None，不引外部 base64 crate。
pub(crate) fn base64_decode_std(input: &str) -> Option<Vec<u8>> {
    fn sextet(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    // 忽略填充 '='，按 4 字符组还原；其余任何非码表字符都判非法。
    let chars: Vec<u8> = input.bytes().filter(|c| *c != b'=').collect();
    let mut out = Vec::with_capacity(chars.len() / 4 * 3);
    for chunk in chars.chunks(4) {
        if chunk.len() < 2 {
            return None;
        }
        let mut v = [0u32; 4];
        for (i, &c) in chunk.iter().enumerate() {
            v[i] = sextet(c)? as u32;
        }
        let triple = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
        out.push((triple >> 16) as u8);
        if chunk.len() > 2 {
            out.push((triple >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(triple as u8);
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/// 音源当前是否可用：Jamendo 需要 client_id（用户注册后写入 settings），
/// 未配置时列表与聚合搜索都跳过它；其余音源恒可用。
async fn source_ready(ctx: &Ctx, src: &SourceInfo) -> bool {
    if src.id != jamendo::ID {
        return true;
    }
    matches!(
        vmusic_store::settings::get(&ctx.db, jamendo::CLIENT_ID_KEY).await,
        Ok(Some(v)) if v.as_str().is_some_and(|s| !s.trim().is_empty())
    )
}

/// 音源清单。`signedIn` 要查设置表，所以这一步是异步的。
pub async fn list_sources(ctx: &Ctx) -> Vec<serde_json::Value> {
    let mut out = Vec::with_capacity(SOURCES.len());
    for src in SOURCES {
        if !source_ready(ctx, src).await {
            continue;
        }
        // 登录态以 cred 包为准（扫码/手动 cookie 都落 online_cred_<src>，
        // 裸键 online_cookie_ 只是历史兜底）；各平台判定规则不同，交 cred 模块。
        let signed_in = if src.supports_cookie {
            match cred::get(&ctx.db, src.id).await {
                Ok(Some(pack)) => cred::is_signed_in(src.id, &pack),
                _ => false,
            }
        } else {
            false
        };
        out.push(serde_json::json!({
            "id": src.id,
            "label": src.label,
            "cats": src.cats.iter()
                .map(|(k, v)| serde_json::json!({"id": k, "label": v}))
                .collect::<Vec<_>>(),
            "supportsCookie": src.supports_cookie,
            "signedIn": signed_in,
            "caps": src.caps,
        }));
    }
    out
}

/// 音源在「每日推荐歌曲」这件事上的状态。
///
/// 每日推荐天生要账号（匿名拿不到个性化结果），所以「能不能去取」是三态
/// 而不是二态：能取 / 该跳过 / 跳过的原因是什么。原因在这里就定好，界面
/// 才能写「QQ 音乐未登录，已跳过」而不是笼统的「暂无推荐」。
#[derive(Debug, Clone, Serialize)]
pub struct DailySourceState {
    pub source: String,
    pub label: String,
    /// 可以去取：能力位已开、音源可用、登录态为真。
    pub ready: bool,
    /// ready 为 false 时的判别式，不是成品文案：
    /// `unavailable`（音源本身不可用，如 Jamendo 未配 client_id）、
    /// `unsupported`（没登记 RecommendSongs）、`not_signed_in`（未登录）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    pub message: String,
}

/// 逐个音源给出每日推荐的可用性快照。
///
/// 顺序与 [`SOURCES`] 一致，因此合并出来的歌单顺序是稳定的：同一天、同一
/// 批登录态下，结果不会因为并发完成顺序而变。
pub async fn daily_source_states(ctx: &Ctx) -> Vec<DailySourceState> {
    let mut out = Vec::with_capacity(SOURCES.len());
    for src in SOURCES {
        let state = if !source_ready(ctx, src).await {
            DailySourceState {
                source: src.id.to_string(),
                label: src.label.to_string(),
                ready: false,
                kind: Some("unavailable"),
                message: "该音源当前不可用".to_string(),
            }
        } else if !src.caps.contains(&Capability::RecommendSongs) {
            DailySourceState {
                source: src.id.to_string(),
                label: src.label.to_string(),
                ready: false,
                kind: Some("unsupported"),
                message: "该音源没有每日推荐歌曲接口".to_string(),
            }
        } else if !src.supports_cookie {
            DailySourceState {
                source: src.id.to_string(),
                label: src.label.to_string(),
                ready: false,
                kind: Some("not_signed_in"),
                message: "该音源不支持账号登录".to_string(),
            }
        } else {
            match cred::get(&ctx.db, src.id).await {
                // 登录态判据集中在 cred 模块，各平台规则不同（见那里）。
                Ok(Some(pack)) if cred::is_signed_in(src.id, &pack) => DailySourceState {
                    source: src.id.to_string(),
                    label: src.label.to_string(),
                    ready: true,
                    kind: None,
                    message: String::new(),
                },
                _ => DailySourceState {
                    source: src.id.to_string(),
                    label: src.label.to_string(),
                    ready: false,
                    kind: Some("not_signed_in"),
                    message: "未登录".to_string(),
                },
            }
        };
        out.push(state);
    }
    out
}

pub async fn search(ctx: &Ctx, q: SearchQuery) -> ApiResult<SearchPage> {
    if q.q.as_deref().map(str::trim).unwrap_or("").is_empty() && q.cat.is_none() {
        return Err(bad_request("需要给出搜索关键词或分类"));
    }
    match q.source.as_str() {
        "netease" => netease::search(ctx, &q).await,
        "qq" => qq::search(ctx, &q).await,
        "kugou" => kugou::search(ctx, &q).await,
        "kuwo" => kuwo::search(ctx, &q).await,
        "jamendo" => jamendo::search(ctx, &q).await,
        "ccmixter" => ccmixter::search(ctx, &q).await,
        "qishui" => qishui::search(ctx, &q).await,
        "migu" => migu::search(ctx, &q).await,
        other => Err(unsupported(other)),
    }
}

/// All 聚合搜索：并发打全部已注册音源，单源超时/失败只进 `failed`。
pub async fn search_all(ctx: &Ctx, query: &str, limit: usize) -> ApiResult<AggregateSearch> {
    if query.trim().is_empty() {
        return Err(bad_request("需要给出搜索关键词"));
    }
    let limit = limit.clamp(1, 50);
    let mut ids = Vec::new();
    for src in SOURCES {
        if source_ready(ctx, src).await {
            ids.push(src.id);
        }
    }
    // spec §2.4：单源 6s 预算，慢源不该拖慢整个聚合页。
    let agg = aggregate::collect(
        &ids,
        query.trim(),
        limit,
        move |_src, q| {
            let ctx = ctx.clone();
            Box::pin(async move {
                search(&ctx, q)
                    .await
                    .map_err(|e| (e.code.to_string(), e.message))
            })
        },
        std::time::Duration::from_secs(6),
    )
    .await;
    Ok(agg)
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
    /// 除主地址外的可用直链，按音质从高到低排（不含 `url` 自身）。
    /// 播放/落盘按 [`StreamInfo::ladder`] 的顺序降级重试（spec §2.2 QQ vkey 决策条）。
    ///
    /// 不上 wire：这些是带签名的临时地址，前端一个都不读（已核对 plugin/ui），
    /// 发出去只是把短效凭据泄给无关的调用方。
    #[serde(skip)]
    pub fallbacks: Vec<ladder::Candidate>,
    /// 上游随取流一起给的响度标签，语义与本地曲的 ReplayGain track_gain/track_peak
    /// 一致（dB / 线性峰值）。拿不到就是 None。
    ///
    /// 目前**只有网易云实测确认有这两个字段**（`/api/song/enhance/player/url` 的
    /// `data[0]` 带 `gain`/`peak`，另有 `closedGain`/`closedPeak`）；其余音源没有
    /// 观测到对应字段，一律 None —— 不猜测、不派生，没有标签就按 0 dB 播。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rg_gain_db: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rg_peak: Option<f64>,
}

/// 取流。
///
/// `track_ref` 是搜索结果里随曲目带来的不透明平台凭据（QQ 的 media_mid、
/// 酷狗的 album_id 等都在里面）；没有 ref（如旧版前端、虚拟 id 现取现播）
/// 时平台模块自行回落到 `id`，链路必须仍然可用，只是可能拿不到最优音质。
pub async fn stream(
    ctx: &Ctx,
    source: &str,
    id: &str,
    track_ref: Option<&TrackRef>,
    quality: Option<u32>,
) -> ApiResult<StreamInfo> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let q = quality.unwrap_or(320_000);
    match source {
        "netease" => netease::stream(ctx, id, q).await,
        "qq" => qq::stream(ctx, id, track_ref, q).await,
        "kugou" => kugou::stream(ctx, id, track_ref, q).await,
        "kuwo" => kuwo::stream(ctx, id, track_ref, q).await,
        "jamendo" => jamendo::stream(ctx, id, q).await,
        "ccmixter" => ccmixter::stream(ctx, id, q).await,
        "qishui" => qishui::stream(ctx, id, track_ref, q).await,
        "migu" => migu::stream(ctx, id, track_ref, q).await,
        other => Err(unsupported(other)),
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
        "qq" => qq::detail(ctx, id).await,
        "kugou" => kugou::detail(ctx, id).await,
        "kuwo" => kuwo::detail(ctx, id).await,
        "jamendo" => jamendo::detail(ctx, id).await,
        "ccmixter" => ccmixter::detail(ctx, id).await,
        "qishui" => qishui::detail(ctx, id).await,
        "migu" => migu::detail(ctx, id).await,
        other => Err(unsupported(other)),
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
        "qq" => qq::lyric(ctx, id).await,
        "kugou" => kugou::lyric(ctx, id).await,
        "kuwo" => kuwo::lyric(ctx, id).await,
        "jamendo" => jamendo::lyric(ctx, id).await,
        "ccmixter" => ccmixter::lyric(ctx, id).await,
        "qishui" => qishui::lyric(ctx, id).await,
        "migu" => migu::lyric(ctx, id).await,
        other => Err(unsupported(other)),
    }
}

/// 听歌打卡（网易云专属，state 的 ListenTracker 在有效收听满 30s 后调用）。
/// 其余音源没有等价的播放量上报端点，如实拒绝而不是静默假装成功。
pub async fn scrobble(ctx: &Ctx, source: &str, id: &str, seconds: u64) -> ApiResult<()> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    match source {
        "netease" => netease::scrobble(ctx, id, seconds).await,
        other => Err(unsupported(other)),
    }
}

// ---------------------------------------------------------------------------
// 账号 / 歌单 / 红心 / 推荐 / 扫码 dispatch
//
// 所有能力类入口先过 [gate]：以 SOURCES.caps 为唯一事实，能力位关闭（可能是
// 真机验收未过，也可能是平台根本不支持）的平台在这一步就拿到 404
// capability_unsupported，平台实现函数不会被调到。match 里仍然保留代码已就绪
// 平台的转发臂，真机闸门（spec §4.3）通过后只改 caps、不改逻辑。
// ---------------------------------------------------------------------------

/// 未知/不支持音源的统一错误：404 capability_unsupported（前端按缺能力隐藏入口）。
fn unsupported(source: &str) -> ApiError {
    ApiError::capability_unsupported(format!("不支持的音源: {source}"))
}

/// 能力闸门：音源已注册但能力位未开 → 404；音源不存在 → 同样 404，
/// 不向外区分「没这个平台」和「平台不支持该操作」，避免被当作可枚举端点。
fn gate(source: &str, cap: Capability) -> ApiResult<()> {
    let Some(info) = find(source) else {
        return Err(unsupported(source));
    };
    if info.caps.contains(&cap) {
        Ok(())
    } else {
        Err(ApiError::capability_unsupported(format!(
            "音源 {source} 当前不支持该操作"
        )))
    }
}

/// gate 已放行、下面的 match 却没有转发臂：能力表与 dispatch 不一致，
/// 属于服务端接线缺陷（500），不能对外说「不支持的音源」误导排障。
fn not_wired(source: &str, op: &'static str) -> ApiError {
    ApiError::internal(format!(
        "音源 {source} 的 {op} 能力已登记但 dispatch 未接线"
    ))
}

/// 当前登录账号信息（支持 cookie 登录的平台都可取，不挂独立能力位）。
pub async fn account(ctx: &Ctx, source: &str) -> ApiResult<AccountInfo> {
    match source {
        "netease" => netease::account(ctx).await,
        "qq" => qq::account(ctx).await,
        "kugou" => kugou::account(ctx).await,
        "kuwo" => kuwo::account(ctx).await,
        // 汽水：扫码/粘贴 cookie 之后顶栏要显示昵称头像，没有这条臂会让
        // 「登录成功但界面仍是未登录」——登录态在，回拉却没路可走。
        "qishui" => qishui::account(ctx).await,
        other => Err(unsupported(other)),
    }
}

pub async fn playlists(
    ctx: &Ctx,
    source: &str,
    scope: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<Vec<OnlinePlaylist>> {
    gate(source, Capability::UserPlaylists)?;
    match source {
        "netease" => netease::playlists(ctx, scope, offset, limit).await,
        "qq" => qq::playlists(ctx, scope, offset, limit).await,
        // 实现已就绪，真机验收通过后摘开 UserPlaylists 位即可。
        "kugou" => kugou::playlists(ctx, scope, offset, limit).await,
        other => Err(not_wired(other, "用户歌单")),
    }
}

pub async fn playlist_detail(
    ctx: &Ctx,
    source: &str,
    id: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<PlaylistDetail> {
    gate(source, Capability::PlaylistDetail)?;
    match source {
        "netease" => netease::playlist_detail(ctx, id, offset, limit).await,
        "qq" => qq::playlist_detail(ctx, id, offset, limit).await,
        // 真机验收通过后摘开 PlaylistDetail 位即可（端点要求登录）。
        "kugou" => kugou::playlist_detail(ctx, id, offset, limit).await,
        other => Err(not_wired(other, "歌单详情")),
    }
}

/// 在线歌单搜索：按关键词检索平台侧公开歌单（与「用户自己的歌单」不同，
/// 后者走 [`playlists`]）。能力位 [`Capability::PlaylistSearch`] 未开的音源
/// 在这里就拿到 404。
pub async fn search_playlists(
    ctx: &Ctx,
    source: &str,
    q: &SearchQuery,
) -> ApiResult<PlaylistSearchPage> {
    gate(source, Capability::PlaylistSearch)?;
    match source {
        "migu" => migu::search_playlists(ctx, q).await,
        "netease" => netease::search_playlists(ctx, q).await,
        other => Err(not_wired(other, "歌单搜索")),
    }
}

/// 在线歌手搜索：能力位 [`Capability::ArtistSearch`] 未开的音源在这里拿到
/// 404，前端按 caps 隐藏「歌手」入口，正常路径到不了这层报错。
pub async fn search_artists(
    ctx: &Ctx,
    source: &str,
    q: &SearchQuery,
) -> ApiResult<ArtistSearchPage> {
    gate(source, Capability::ArtistSearch)?;
    match source {
        "netease" => netease::search_artists(ctx, q).await,
        other => Err(not_wired(other, "歌手搜索")),
    }
}

/// 在线专辑搜索：能力位 [`Capability::AlbumSearch`] 同上。
pub async fn search_albums(ctx: &Ctx, source: &str, q: &SearchQuery) -> ApiResult<AlbumSearchPage> {
    gate(source, Capability::AlbumSearch)?;
    match source {
        "netease" => netease::search_albums(ctx, q).await,
        other => Err(not_wired(other, "专辑搜索")),
    }
}

/// 歌手页：该歌手的热门歌曲列表。与歌手搜索同一条能力位——搜得到歌手就
/// 应该进得去歌手页，分开两个位只会出现「卡片能搜到、点开 404」的半能力。
pub async fn artist_songs(
    ctx: &Ctx,
    source: &str,
    id: &str,
    limit: usize,
    offset: usize,
) -> ApiResult<CollectionDetail> {
    gate(source, Capability::ArtistSearch)?;
    match source {
        "netease" => netease::artist_songs(ctx, id, limit, offset).await,
        other => Err(not_wired(other, "歌手热门歌曲")),
    }
}

/// 专辑页：专辑详情 + 全部曲目。与 [`Capability::AlbumSearch`] 同一条能力位，
/// 理由同上。
pub async fn album_detail(
    ctx: &Ctx,
    source: &str,
    id: &str,
    limit: usize,
    offset: usize,
) -> ApiResult<CollectionDetail> {
    gate(source, Capability::AlbumSearch)?;
    match source {
        "netease" => netease::album_detail(ctx, id, limit, offset).await,
        other => Err(not_wired(other, "专辑详情")),
    }
}

pub async fn playlist_create(ctx: &Ctx, source: &str, name: &str) -> ApiResult<OnlinePlaylist> {
    gate(source, Capability::PlaylistWrite)?;
    match source {
        "netease" => netease::playlist_create(ctx, name).await,
        "qq" => qq::playlist_create(ctx, name).await,
        "kugou" => kugou::playlist_create(ctx, name).await,
        other => Err(not_wired(other, "新建歌单")),
    }
}

pub async fn playlist_delete(ctx: &Ctx, source: &str, id: &str) -> ApiResult<()> {
    gate(source, Capability::PlaylistWrite)?;
    match source {
        "netease" => netease::playlist_delete(ctx, id).await,
        "qq" => qq::playlist_delete(ctx, id).await,
        "kugou" => kugou::playlist_delete(ctx, id).await,
        other => Err(not_wired(other, "删除歌单")),
    }
}

pub async fn playlist_add(
    ctx: &Ctx,
    source: &str,
    id: &str,
    tracks: &[TrackEntry],
) -> ApiResult<()> {
    gate(source, Capability::PlaylistWrite)?;
    match source {
        "netease" => netease::playlist_add(ctx, id, tracks).await,
        "qq" => qq::playlist_add(ctx, id, tracks).await,
        "kugou" => kugou::playlist_add(ctx, id, tracks).await,
        other => Err(not_wired(other, "歌单加曲")),
    }
}

pub async fn playlist_remove(
    ctx: &Ctx,
    source: &str,
    id: &str,
    tracks: &[TrackEntry],
) -> ApiResult<()> {
    gate(source, Capability::PlaylistWrite)?;
    match source {
        "netease" => netease::playlist_remove(ctx, id, tracks).await,
        "qq" => qq::playlist_remove(ctx, id, tracks).await,
        "kugou" => kugou::playlist_remove(ctx, id, tracks).await,
        other => Err(not_wired(other, "歌单移除曲目")),
    }
}

/// 红心/取消红心。目前仅网易云有平台实现；QQ（dirid=201）/酷狗待真机后补。
pub async fn like(ctx: &Ctx, source: &str, id: &str, liked: bool) -> ApiResult<()> {
    gate(source, Capability::Like)?;
    match source {
        "netease" => netease::like(ctx, id, liked).await,
        other => Err(not_wired(other, "红心")),
    }
}

pub async fn recommend_songs(
    ctx: &Ctx,
    source: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<Vec<OnlineTrack>> {
    gate(source, Capability::RecommendSongs)?;
    match source {
        "netease" => netease::recommend_songs(ctx, offset, limit).await,
        // QQ 走雷达端点（一次约 10 条，内部翻页凑够 limit），需登录态。
        "qq" => qq::recommend_songs(ctx, offset, limit).await,
        // 酷狗端点无分页参数，上游一次给整页后本地切片；真机验收后摘开能力位。
        "kugou" => kugou::recommend_songs(ctx).await.map(|page| {
            page.tracks
                .into_iter()
                .skip(offset)
                .take(limit.clamp(1, 100))
                .collect()
        }),
        other => Err(not_wired(other, "每日推荐歌曲")),
    }
}

pub async fn recommend_playlists(
    ctx: &Ctx,
    source: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<Vec<OnlinePlaylist>> {
    gate(source, Capability::RecommendPlaylists)?;
    match source {
        "netease" => netease::recommend_playlists(ctx, offset, limit).await,
        "qq" => qq::recommend_playlists(ctx, offset, limit).await,
        other => Err(not_wired(other, "推荐歌单")),
    }
}

/// 发起扫码握手，返回平台握手票 + 二维码载荷；路由层负责把 platform_ticket
/// 收进 qr::Registry 换成不透明 ticket。
///
/// `channel` 仅 QQ 有意义：缺省/"qq" 走 QQ 互联码（手机 QQ 扫），"wx" 走
/// 微信开放码（微信扫），两种码确认后都换成同一套 musicid/musickey 凭据。
pub async fn qr_start(ctx: &Ctx, source: &str, channel: Option<&str>) -> ApiResult<QrPayload> {
    gate(source, Capability::QrLogin)?;
    match source {
        "netease" => netease::qr_create(ctx).await,
        "qq" => match channel {
            Some("wx") => qq::qr_create_wx(ctx).await,
            _ => qq::qr_create(ctx).await,
        },
        "kugou" => kugou::qr_create(ctx).await,
        "qishui" => qishui::qr_create(ctx).await,
        other => Err(not_wired(other, "扫码登录")),
    }
}

/// 轮询扫码结果。状态机由各平台自己归一：waiting|scanned|confirmed|expired。
pub async fn qr_poll(
    ctx: &Ctx,
    source: &str,
    platform_ticket: &str,
) -> ApiResult<(String, Option<AccountInfo>)> {
    gate(source, Capability::QrLogin)?;
    match source {
        "netease" => netease::qr_check(ctx, platform_ticket).await,
        "qq" => qq::qr_check(ctx, platform_ticket).await,
        "kugou" => kugou::qr_check(ctx, platform_ticket).await,
        "qishui" => qishui::qr_check(ctx, platform_ticket).await,
        other => Err(not_wired(other, "扫码登录")),
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

/// 连续推荐目前仅网易云提供；游客是否可用由上游响应决定。
pub async fn personal_fm(ctx: &Ctx, source: &str) -> ApiResult<Vec<OnlineTrack>> {
    gate(source, Capability::PersonalFm)?;
    netease::personal_fm(ctx)
        .await
        .map_err(|e| e.with_source(source))
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

    /// 描述表与 search dispatch 的第二张事实表。
    ///
    /// `every_source_is_dispatchable_and_described` 只验 find() 有结果；这里
    /// 确保 `search()` 对每个已注册音源都有一条转发臂，而不是落到
    /// `unsupported(other)`。加音源只改不改测就会在这里失败。
    #[test]
    fn search_dispatches_every_registered_source() {
        let dispatches = |source: &str| {
            matches!(
                source,
                "netease" | "qq" | "kugou" | "kuwo" | "jamendo" | "ccmixter" | "qishui" | "migu"
            )
        };
        for src in SOURCES {
            assert!(
                dispatches(src.id),
                "音源 {} 已注册但 search dispatch 没有转发臂",
                src.id
            );
        }
    }

    /// 汽水音乐：能力位与「本项目拒绝做什么」绑定，不能随手加。
    ///
    /// 加登录态之外的能力位（尤其是 HighQuality）等于承诺能播受保护的高音质，
    /// 而我们对加密音质是拒播的——这条断言把那个决定钉住。
    ///
    /// QrLogin 是 2026-09-22 加进来的：官方 Passport 两个端点实测裸请求可用，
    /// 不需要伪造设备指纹或求解 JS 挑战，因此不触碰本项目「不规避平台风控」
    /// 的底线（依据见 qishui.rs 模块文档与 `qr_create`/`qr_check`）。
    #[test]
    fn qishui_only_claims_the_capabilities_it_can_honestly_deliver() {
        let caps = find("qishui").unwrap().caps;
        assert_eq!(caps, &[Capability::CookieLogin, Capability::QrLogin]);
        // 仍未登记的能力位：标了就是在承诺做不到的事。
        assert!(!caps.contains(&Capability::HighQuality));
        assert!(!caps.contains(&Capability::UserPlaylists));
    }

    #[test]
    fn qishui_downloads_carry_their_own_referer() {
        // CDN 校验来源页，缺了直接 403。
        assert_eq!(referer("qishui"), Some("https://www.qishui.com/"));
    }

    #[test]
    fn cache_names_cannot_escape_the_cache_directory() {
        assert_eq!(
            cache::legacy_cache_name("netease", "123"),
            "netease-123.mp3"
        );
        // 点号不在白名单里，所以 ".." 连不成路径上跳，只能变成两个下划线。
        assert_eq!(
            cache::legacy_cache_name("ccmixter", "../../etc/passwd"),
            "ccmixter-______etc_passwd.mp3"
        );
        assert!(!cache::legacy_cache_name("a", "b/\\c:d").contains('/'));
        assert!(!cache::legacy_cache_name("a", "b/\\c:d").contains('\\'));
        assert!(!cache::legacy_cache_name("a", "..").contains(".."));
    }

    #[test]
    fn long_ids_are_truncated_without_colliding() {
        let base = "content/a/".to_string() + &"x".repeat(200);
        assert_eq!(
            cache::legacy_cache_name("ccmixter", &base).len(),
            96 + 9 + 4
        );
        // 只有尾巴不同的两条长 id，截断之后必须落到不同的文件上
        let left = cache::legacy_cache_name("ccmixter", &format!("{base}1"));
        let right = cache::legacy_cache_name("ccmixter", &format!("{base}2"));
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

    #[test]
    fn base64_std_decode_handles_padding_and_rejects_bad_length() {
        assert_eq!(base64_decode_std(""), Some(Vec::new()));
        assert_eq!(base64_decode_std("Zg=="), Some(b"f".to_vec()));
        assert_eq!(base64_decode_std("Zm9v"), Some(b"foo".to_vec()));
        // 长度 mod 4 == 1 在 base64 里不可能合法。
        assert_eq!(base64_decode_std("A"), None);
    }

    #[test]
    fn source_ids_are_unique_and_cookie_cap_matches_flag() {
        let mut ids: Vec<&str> = SOURCES.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "SOURCES 里出现了重复音源 id");
        // supports_cookie 与 CookieLogin 能力位必须同开同关：前端按能力位
        // 渲染登录入口，列表字段另算一套就会出现「能登录但没有入口」。
        for s in SOURCES {
            assert_eq!(
                s.supports_cookie,
                s.caps.contains(&Capability::CookieLogin),
                "音源 {} 的 supports_cookie 与 CookieLogin 不一致",
                s.id
            );
            // 同一能力位在一张表里出现两次会让前端收到重复 caps。
            let mut listed: Vec<Capability> = s.caps.to_vec();
            listed.sort_unstable_by_key(|c| *c as u8);
            let n = listed.len();
            listed.dedup();
            assert_eq!(n, listed.len(), "音源 {} 的 caps 有重复项", s.id);
        }
    }

    #[test]
    fn gate_passes_exactly_when_cap_is_listed() {
        // 能力位是 dispatch 与 UI 的唯一事实：gate 的判定必须与表里一致。
        let all_caps = [
            Capability::QrLogin,
            Capability::CookieLogin,
            Capability::UserPlaylists,
            Capability::PlaylistDetail,
            Capability::PlaylistWrite,
            Capability::Like,
            Capability::RecommendSongs,
            Capability::RecommendPlaylists,
            Capability::PersonalFm,
            Capability::HighQuality,
            Capability::PlaylistSearch,
        ];
        for s in SOURCES {
            for cap in all_caps {
                match gate(s.id, cap) {
                    Ok(()) => assert!(
                        s.caps.contains(&cap),
                        "gate 放行了音源 {} 未登记的能力 {:?}",
                        s.id,
                        cap
                    ),
                    Err(e) => {
                        assert!(!s.caps.contains(&cap));
                        // 未知源/缺能力一律 404，前端据此隐藏入口而不是提示重试。
                        assert_eq!(e.status, 404);
                    }
                }
            }
        }
        // 未注册音源对**全部**能力位都回 404，且与缺能力不可区分。
        for cap in all_caps {
            assert_eq!(
                gate("ghost", cap).unwrap_err().status,
                404,
                "未注册音源遇到 {cap:?} 应回 404"
            );
        }
    }

    /// 某音源的操作型能力位是否已在 dispatch 里有可达转发臂
    /// （含真机前摘位、但代码已就绪的预留臂）。
    ///
    /// 这是 caps ↔ dispatch 的第二张事实表：开能力位而没补转发臂时
    /// `every_open_cap_has_a_dispatch_backing` 会失败，防止「UI 亮入口、
    /// 点了 404/500」的漂移。新增臂时同步更新本矩阵。
    fn has_operation_arm(source: &str, cap: Capability) -> bool {
        use Capability::*;
        matches!(
            (source, cap),
            (
                "netease",
                QrLogin
                    | UserPlaylists
                    | PlaylistDetail
                    | PlaylistWrite
                    | Like
                    | RecommendSongs
                    | RecommendPlaylists
                    | PersonalFm
                    | PlaylistSearch
                    | ArtistSearch
                    | AlbumSearch
            ) | (
                // 每日推荐走雷达端点（qq::recommend_songs），2026-09 真机验证。
                "qq",
                QrLogin
                    | UserPlaylists
                    | PlaylistDetail
                    | PlaylistWrite
                    | RecommendSongs
                    | RecommendPlaylists
            ) | (
                "kugou",
                QrLogin | UserPlaylists | PlaylistDetail | PlaylistWrite | RecommendSongs
            ) | (
                // 汽水只有扫码这一条操作型能力：官方 Passport 网页接口的
                // get_qrcode/check_qrconnect，不需要设备指纹或 JS 挑战求解。
                "qishui", QrLogin
            ) | (
                // 咪咕只登记歌单搜索这一条操作型能力（H5 公开端点，无需签名）。
                "migu",
                PlaylistSearch
            )
        )
    }

    #[test]
    fn every_open_cap_has_a_dispatch_backing() {
        // CookieLogin / HighQuality 是描述型能力位：不对应某条操作 dispatch
        // （凭据走 cred 端点、音质走 stream 公共链路），无需独立转发臂。
        for s in SOURCES {
            for cap in s.caps {
                let backed = matches!(cap, Capability::CookieLogin | Capability::HighQuality)
                    || has_operation_arm(s.id, *cap);
                assert!(
                    backed,
                    "音源 {} 开了 {:?} 能力位但 dispatch 无转发臂",
                    s.id, cap
                );
            }
        }
    }

    #[test]
    fn platform_caps_match_real_machine_gate_decisions() {
        // 这组断言把 SP1 真机闸门（spec §4.3）的裁决钉死：能力位要随真机
        // 验收结论调整时，必须显式改测试，防止摘位/复位在重构中被悄悄还原。
        let caps_of = |id: &str| find(id).unwrap().caps;
        // 网易云：全部能力（含扫码）已实现，等真机验收确认而非提前摘位。
        // 歌单/歌手/专辑搜索走公开网页 GET（2026-10 实测匿名可用）。
        assert_eq!(
            caps_of("netease"),
            &[
                Capability::CookieLogin,
                Capability::QrLogin,
                Capability::UserPlaylists,
                Capability::PlaylistDetail,
                Capability::PlaylistWrite,
                Capability::Like,
                Capability::RecommendSongs,
                Capability::RecommendPlaylists,
                Capability::PersonalFm,
                Capability::HighQuality,
                Capability::PlaylistSearch,
                Capability::ArtistSearch,
                Capability::AlbumSearch,
            ]
        );
        // QQ：无红心实现；扫码走 QQ Connect 链（真机 confirmed 待验收）。
        // 每日推荐 2026-09 已真机验证：这条 Web CGI 上没有叫"每日推荐"的端点，
        // 但 GetRadarSong（雷达）给的就是个性化推荐歌曲，故开 RecommendSongs。
        assert_eq!(
            caps_of("qq"),
            &[
                Capability::CookieLogin,
                Capability::QrLogin,
                Capability::UserPlaylists,
                Capability::PlaylistDetail,
                Capability::PlaylistWrite,
                Capability::RecommendSongs,
                Capability::RecommendPlaylists,
                Capability::HighQuality,
            ]
        );
        // 酷狗：歌单/写/推荐/红心待真机；扫码 create/waiting 已真机验证。
        assert_eq!(
            caps_of("kugou"),
            &[
                Capability::CookieLogin,
                Capability::QrLogin,
                Capability::HighQuality,
            ]
        );
        // 酷我：只有 cookie 粘贴登录；匿名上限 128k/试听，登录通道效果待
        // 实测，不标 HighQuality。
        assert_eq!(caps_of("kuwo"), &[Capability::CookieLogin]);
        // ccmixter 是 CC 授权匿名曲库，没有任何账号能力。
        assert!(caps_of("ccmixter").is_empty());
        // Jamendo 同为 CC 匿名曲库；可用性由 client_id 配置决定，不占能力位。
        assert!(caps_of("jamendo").is_empty());
        // 咪咕：只有歌单搜索这一项公开能力；取流响应加密、本项目不解密，
        // 因此不登记任何播放/高音质能力位。
        assert_eq!(caps_of("migu"), &[Capability::PlaylistSearch]);
    }

    /// 设置页的音质清单由档位表派生：有多档才给入口，单档不给。
    /// 钉死它是为了防回退成手抄源名——历史上 HTTP 与 RPC 各抄一份，结果漏掉了
    /// 酷我（表里有三档却在设置页不可达），又带上了汽水（取流压根不看 quality）。
    #[test]
    fn quality_settings_lists_only_sources_with_real_tiers() {
        assert_eq!(quality_sources(), vec!["netease", "qq", "kugou", "kuwo"]);
        for id in quality_sources() {
            assert!(
                quality::allowed_for(id).len() > 1,
                "{id} 在清单里却没有多档"
            );
        }
        // 单档源不进清单：给了选项也会被 clamp_to_allowed 夹回标准档，
        // 等于摆了个不生效的下拉框。
        for id in ["migu", "jamendo", "ccmixter", "qishui"] {
            assert_eq!(
                quality::allowed_for(id),
                &[quality::Quality::Standard],
                "{id} 的档位表变了，本断言与上面的清单要一起改"
            );
            assert!(!quality_sources().contains(&id), "{id} 单档却进了清单");
        }
    }

    #[test]
    fn track_entry_wire_shape_uses_id_and_ref() {
        // spec §1.4：写操作入站是 {id, ref?}；ref 的 JSON 名必须是 ref，
        // 不能反序列化成内部字段名 track_ref。
        let full: TrackEntry =
            serde_json::from_str(r#"{"id":"42","ref":{"song_mid":"abc","song_id":7}}"#).unwrap();
        assert_eq!(full.id, "42");
        assert_eq!(full.ref_str("song_mid"), Some("abc"));
        // 非字符串字段不取（song_id 是数字），交由调用方按类型自取。
        assert_eq!(full.ref_str("song_id"), None);

        // ref 可整体缺省，平台模块此时仅用稳定 id 回落。
        let bare: TrackEntry = serde_json::from_str(r#"{"id":"7"}"#).unwrap();
        assert!(bare.track_ref.is_none());
        assert_eq!(bare.ref_str("anything"), None);

        // id 必填。
        assert!(serde_json::from_str::<TrackEntry>(r#"{"ref":{}}"#).is_err());
    }

    /// 歌单写操作的能力闸门：能力位未登记的音源（含实现已接线、等真机验收的
    /// 酷狗写歌单）与未注册音源，都必须在 dispatch 入口被 gate 拦成 404，
    /// 绝不能穿透到平台实现去做真实网络请求。
    #[tokio::test]
    async fn playlist_write_ops_stay_behind_the_capability_gate() {
        let dir = std::env::temp_dir().join(format!("vmusic-pl-gate-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let ctx = Ctx { db };

        // 酷狗转发臂已接线，但 PlaylistWrite 位未登记（真机闸门未过）→ 404。
        assert!(!find("kugou")
            .unwrap()
            .caps
            .contains(&Capability::PlaylistWrite));
        assert_eq!(playlist_create(&ctx, "kugou", "x").await.unwrap_err().status, 404);
        assert_eq!(playlist_delete(&ctx, "kugou", "1").await.unwrap_err().status, 404);
        // 未注册音源与「平台不支持」不可区分：同样 404，不泄露端点存在性。
        assert_eq!(
            playlist_remove(&ctx, "ghost", "1", &[]).await.unwrap_err().status,
            404
        );

        ctx.db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 能力位已登记却没有转发臂是服务端接线缺陷（502 upstream_error）；真·
    /// 不支持的音源走 unsupported（404 capability_unsupported）。两者不能互换，
    /// 否则排障会被「不支持的音源」误导到错误方向。
    #[test]
    fn playlist_dispatch_keeps_wiring_gaps_distinct_from_unsupported_sources() {
        let gap = not_wired("migu", "新建歌单");
        assert_eq!(gap.status, 502);
        assert!(gap.message.contains("未接线"), "{}", gap.message);
        let nope = unsupported("ghost");
        assert_eq!(nope.status, 404);
        assert!(nope.message.contains("不支持的音源"), "{}", nope.message);
    }
}
