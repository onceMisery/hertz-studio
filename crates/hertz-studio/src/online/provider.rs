// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Built-in providers: descriptions, callable operations and platform policy have
//! one registration. Public entry points retain input checks, gates and deadlines.

use std::{future::Future, pin::Pin, sync::OnceLock};

use super::*;

type FutureResult<'a, T> = Pin<Box<dyn Future<Output = ApiResult<T>> + Send + 'a>>;
type ContextOp<T> = for<'a> fn(&'a Ctx) -> FutureResult<'a, T>;
type IdOp<T> = for<'a> fn(&'a Ctx, &'a str) -> FutureResult<'a, T>;
type SearchOp<T> = for<'a> fn(&'a Ctx, &'a SearchQuery) -> FutureResult<'a, T>;
type PageOp<T> = for<'a> fn(&'a Ctx, usize, usize) -> FutureResult<'a, T>;
type IdPageOp<T> = for<'a> fn(&'a Ctx, &'a str, usize, usize) -> FutureResult<'a, T>;
type TrackWriteOp = for<'a> fn(&'a Ctx, &'a str, &'a [TrackEntry]) -> FutureResult<'a, ()>;
type LikeOp = for<'a> fn(&'a Ctx, &'a str, bool) -> FutureResult<'a, ()>;
type ScrobbleOp = for<'a> fn(&'a Ctx, &'a str, u64) -> FutureResult<'a, ()>;
type StreamOp =
    for<'a> fn(&'a Ctx, &'a str, Option<&'a TrackRef>, u32) -> FutureResult<'a, StreamInfo>;
type ReadyOp = for<'a> fn(&'a Ctx) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;

#[derive(Clone, Copy)]
pub(super) struct CoreOps {
    pub search: SearchOp<SearchPage>,
    pub stream: StreamOp,
    pub detail: IdOp<OnlineDetail>,
    pub lyric: IdOp<vmusic_core::LyricDocument>,
}

#[derive(Clone, Copy)]
pub(super) struct PlaylistWriteOps {
    pub create: IdOp<OnlinePlaylist>,
    pub delete: IdOp<()>,
    pub add: TrackWriteOp,
    pub remove: TrackWriteOp,
}

#[derive(Clone, Copy)]
pub(super) struct ArtistOps {
    pub search: SearchOp<ArtistSearchPage>,
    pub songs: IdPageOp<CollectionDetail>,
}

#[derive(Clone, Copy)]
pub(super) struct AlbumOps {
    pub search: SearchOp<AlbumSearchPage>,
    pub detail: IdPageOp<CollectionDetail>,
}

#[derive(Clone, Copy)]
pub(super) struct QrOps {
    pub start: for<'a> fn(&'a Ctx, Option<&'a str>) -> FutureResult<'a, QrPayload>,
    pub poll: IdOp<(String, Option<AccountInfo>)>,
}

#[derive(Clone, Copy)]
pub(super) struct CredentialRules {
    pub enrich: fn(&mut cred::CredPack),
    pub signed_in: fn(&cred::CredPack) -> bool,
}

#[derive(Clone, Copy)]
pub(super) struct QualityProfile {
    pub default: quality::Quality,
    pub allowed: &'static [quality::Quality],
}

impl QualityProfile {
    pub const STANDARD: Self = Self {
        default: quality::Quality::Standard,
        allowed: &[quality::Quality::Standard],
    };
}

#[derive(Clone, Copy)]
pub(super) struct Provider {
    pub info: SourceInfo,
    pub core: CoreOps,
    pub quality: QualityProfile,
    pub referer: Option<&'static str>,
    pub unverified: &'static [Capability],
    pub credentials: Option<CredentialRules>,
    pub ready: Option<ReadyOp>,
    pub account: Option<ContextOp<AccountInfo>>,
    pub playlists: Option<IdPageOp<Vec<OnlinePlaylist>>>,
    pub playlist_detail: Option<IdPageOp<PlaylistDetail>>,
    pub playlist_search: Option<SearchOp<PlaylistSearchPage>>,
    pub playlist_write: Option<PlaylistWriteOps>,
    pub artists: Option<ArtistOps>,
    pub albums: Option<AlbumOps>,
    pub like: Option<LikeOp>,
    pub recommend_songs: Option<PageOp<Vec<OnlineTrack>>>,
    pub recommend_playlists: Option<PageOp<Vec<OnlinePlaylist>>>,
    pub personal_fm: Option<ContextOp<Vec<OnlineTrack>>>,
    pub scrobble: Option<ScrobbleOp>,
    pub qr: Option<QrOps>,
}

impl Provider {
    const fn new(info: SourceInfo, core: CoreOps) -> Self {
        Self {
            info,
            core,
            quality: QualityProfile::STANDARD,
            referer: None,
            unverified: &[],
            credentials: None,
            ready: None,
            account: None,
            playlists: None,
            playlist_detail: None,
            playlist_search: None,
            playlist_write: None,
            artists: None,
            albums: None,
            like: None,
            recommend_songs: None,
            recommend_playlists: None,
            personal_fm: None,
            scrobble: None,
            qr: None,
        }
    }

    pub async fn is_ready(&self, ctx: &Ctx) -> bool {
        match self.ready {
            Some(ready) => ready(ctx).await,
            None => true,
        }
    }

    pub fn gate(&self, cap: Capability) -> ApiResult<()> {
        if self.info.caps.contains(&cap) {
            Ok(())
        } else {
            Err(ApiError::capability_unsupported(format!(
                "音源 {} 当前不支持该操作",
                self.info.id
            )))
        }
    }

    pub fn operation<T: Copy>(
        &self,
        cap: Capability,
        name: &'static str,
        op: Option<T>,
    ) -> ApiResult<T> {
        self.gate(cap)?;
        op.ok_or_else(|| not_wired(self.info.id, name))
    }

    fn backs(&self, cap: Capability) -> bool {
        match cap {
            Capability::CookieLogin => self.credentials.is_some() && self.account.is_some(),
            Capability::QrLogin => self.qr.is_some(),
            Capability::UserPlaylists => self.playlists.is_some(),
            Capability::PlaylistDetail => self.playlist_detail.is_some(),
            Capability::PlaylistWrite => self.playlist_write.is_some(),
            Capability::Like => self.like.is_some(),
            Capability::RecommendSongs => self.recommend_songs.is_some(),
            Capability::RecommendPlaylists => self.recommend_playlists.is_some(),
            Capability::PersonalFm => self.personal_fm.is_some(),
            Capability::HighQuality => self.quality.allowed.len() > 1,
            Capability::PlaylistSearch => self.playlist_search.is_some(),
            Capability::ArtistSearch => self.artists.is_some(),
            Capability::AlbumSearch => self.albums.is_some(),
        }
    }
}

/// Validation reads the actual callable slots, including disabled-but-implemented
/// operations. A capability may stay closed until upstream acceptance is recorded.
pub(super) struct Registry<'a> {
    providers: &'a [Provider],
}

impl<'a> Registry<'a> {
    pub fn new(providers: &'a [Provider]) -> Result<Self, String> {
        if providers.is_empty() {
            return Err("provider registry is empty".into());
        }
        for (index, provider) in providers.iter().enumerate() {
            let info = &provider.info;
            let invalid = |reason: &str| format!("provider {}: {reason}", info.id);
            if info.id.is_empty()
                || info.label.is_empty()
                || info.cats.iter().any(|(id, _)| id.is_empty())
            {
                return Err(invalid("empty description"));
            }
            if providers[..index]
                .iter()
                .any(|other| other.info.id == info.id)
            {
                return Err(invalid("duplicate id"));
            }
            if info.supports_cookie != info.caps.contains(&Capability::CookieLogin) {
                return Err(invalid("cookie flag does not match capability"));
            }
            for (index, cap) in info.caps.iter().enumerate() {
                if info.caps[..index].contains(cap) {
                    return Err(invalid("duplicate capability"));
                }
                if !provider.backs(*cap) {
                    return Err(invalid(&format!(
                        "{cap:?} has no callable operation or policy"
                    )));
                }
            }
            if provider
                .unverified
                .iter()
                .any(|cap| !info.caps.contains(cap))
            {
                return Err(invalid("unverified capability is not enabled"));
            }
            if !provider.quality.allowed.contains(&provider.quality.default) {
                return Err(invalid("default quality is not allowed"));
            }
            for (index, tier) in provider.quality.allowed.iter().enumerate() {
                if provider.quality.allowed[..index].contains(tier) {
                    return Err(invalid("duplicate quality tier"));
                }
            }
        }
        Ok(Self { providers })
    }

    pub fn find(&self, source: &str) -> Option<&'a Provider> {
        self.providers
            .iter()
            .find(|provider| provider.info.id == source)
    }

    pub fn require(&self, source: &str) -> ApiResult<&'a Provider> {
        self.find(source).ok_or_else(|| unsupported(source))
    }

    pub async fn search(&self, ctx: &Ctx, query: &SearchQuery) -> ApiResult<SearchPage> {
        (self.require(&query.source)?.core.search)(ctx, query).await
    }
}

pub(super) fn registry() -> &'static Registry<'static> {
    static REGISTRY: OnceLock<Registry<'static>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| Registry::new(PROVIDERS).expect("invalid built-in provider registration"))
}

pub(super) fn find(source: &str) -> Option<&'static Provider> {
    registry().find(source)
}

pub(super) fn require(source: &str) -> ApiResult<&'static Provider> {
    registry().require(source)
}

/// Preserve the public slice API without maintaining a second metadata list.
pub(super) const fn source_infos() -> [SourceInfo; PROVIDERS.len()] {
    let mut infos = [PROVIDERS[0].info; PROVIDERS.len()];
    let mut index = 0;
    while index < PROVIDERS.len() {
        infos[index] = PROVIDERS[index].info;
        index += 1;
    }
    infos
}

// Registration order is the source-list, default-search and aggregation order.
const PROVIDERS: &[Provider] = &[
    Provider {
        referer: Some("https://music.163.com"),
        quality: QualityProfile {
            default: quality::Quality::Hires,
            allowed: &[
                quality::Quality::Standard,
                quality::Quality::Exhigh,
                quality::Quality::Lossless,
                quality::Quality::Hires,
            ],
        },
        credentials: Some(CredentialRules {
            enrich: |_| {},
            signed_in: cred::signed_in_netease,
        }),
        account: Some(|ctx| Box::pin(netease::account(ctx))),
        playlists: Some(|ctx, scope, offset, limit| {
            Box::pin(netease::playlists(ctx, scope, offset, limit))
        }),
        playlist_detail: Some(|ctx, id, offset, limit| {
            Box::pin(netease::playlist_detail(ctx, id, offset, limit))
        }),
        playlist_write: Some(PlaylistWriteOps {
            create: |ctx, name| Box::pin(netease::playlist_create(ctx, name)),
            delete: |ctx, id| Box::pin(netease::playlist_delete(ctx, id)),
            add: |ctx, id, tracks| Box::pin(netease::playlist_add(ctx, id, tracks)),
            remove: |ctx, id, tracks| Box::pin(netease::playlist_remove(ctx, id, tracks)),
        }),
        recommend_songs: Some(|ctx, offset, limit| {
            Box::pin(netease::recommend_songs(ctx, offset, limit))
        }),
        recommend_playlists: Some(|ctx, offset, limit| {
            Box::pin(netease::recommend_playlists(ctx, offset, limit))
        }),
        qr: Some(QrOps {
            start: |ctx, _channel| Box::pin(netease::qr_create(ctx)),
            poll: |ctx, ticket| Box::pin(netease::qr_check(ctx, ticket)),
        }),
        playlist_search: Some(|ctx, q| Box::pin(netease::search_playlists(ctx, q))),
        artists: Some(ArtistOps {
            search: |ctx, q| Box::pin(netease::search_artists(ctx, q)),
            songs: |ctx, id, limit, offset| Box::pin(netease::artist_songs(ctx, id, limit, offset)),
        }),
        albums: Some(AlbumOps {
            search: |ctx, q| Box::pin(netease::search_albums(ctx, q)),
            detail: |ctx, id, limit, offset| {
                Box::pin(netease::album_detail(ctx, id, limit, offset))
            },
        }),
        like: Some(|ctx, id, liked| Box::pin(netease::like(ctx, id, liked))),
        scrobble: Some(|ctx, id, seconds| Box::pin(netease::scrobble(ctx, id, seconds))),
        personal_fm: Some(|ctx| Box::pin(netease::personal_fm(ctx))),
        ..Provider::new(
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
            CoreOps {
                search: |ctx, q| Box::pin(netease::search(ctx, q)),
                stream: |ctx, id, _track_ref, q| Box::pin(netease::stream(ctx, id, q)),
                detail: |ctx, id| Box::pin(netease::detail(ctx, id)),
                lyric: |ctx, id| Box::pin(netease::lyric(ctx, id)),
            },
        )
    },
    Provider {
        referer: Some("https://y.qq.com/"),
        quality: QualityProfile {
            default: quality::Quality::Lossless,
            allowed: &[
                quality::Quality::Standard,
                quality::Quality::Exhigh,
                quality::Quality::Lossless,
                quality::Quality::Hires,
            ],
        },
        unverified: &[Capability::QrLogin],
        credentials: Some(CredentialRules {
            enrich: cred::enrich_qq,
            signed_in: cred::signed_in_qq,
        }),
        account: Some(|ctx| Box::pin(qq::account(ctx))),
        playlists: Some(|ctx, scope, offset, limit| {
            Box::pin(qq::playlists(ctx, scope, offset, limit))
        }),
        playlist_detail: Some(|ctx, id, offset, limit| {
            Box::pin(qq::playlist_detail(ctx, id, offset, limit))
        }),
        playlist_write: Some(PlaylistWriteOps {
            create: |ctx, name| Box::pin(qq::playlist_create(ctx, name)),
            delete: |ctx, id| Box::pin(qq::playlist_delete(ctx, id)),
            add: |ctx, id, tracks| Box::pin(qq::playlist_add(ctx, id, tracks)),
            remove: |ctx, id, tracks| Box::pin(qq::playlist_remove(ctx, id, tracks)),
        }),
        recommend_songs: Some(|ctx, offset, limit| {
            Box::pin(qq::recommend_songs(ctx, offset, limit))
        }),
        recommend_playlists: Some(|ctx, offset, limit| {
            Box::pin(qq::recommend_playlists(ctx, offset, limit))
        }),
        qr: Some(QrOps {
            start: |ctx, channel| {
                Box::pin(async move {
                    match channel {
                        Some("wx") => qq::qr_create_wx(ctx).await,
                        _ => qq::qr_create(ctx).await,
                    }
                })
            },
            poll: |ctx, ticket| Box::pin(qq::qr_check(ctx, ticket)),
        }),
        ..Provider::new(
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
            CoreOps {
                search: |ctx, q| Box::pin(qq::search(ctx, q)),
                stream: |ctx, id, track_ref, q| Box::pin(qq::stream(ctx, id, track_ref, q)),
                detail: |ctx, id| Box::pin(qq::detail(ctx, id)),
                lyric: |ctx, id| Box::pin(qq::lyric(ctx, id)),
            },
        )
    },
    Provider {
        referer: Some("https://www.kugou.com/"),
        quality: QualityProfile {
            default: quality::Quality::Lossless,
            allowed: &[
                quality::Quality::Standard,
                quality::Quality::Exhigh,
                quality::Quality::Lossless,
            ],
        },
        unverified: &[Capability::QrLogin],
        credentials: Some(CredentialRules {
            enrich: cred::enrich_kugou,
            signed_in: cred::signed_in_kugou,
        }),
        account: Some(|ctx| Box::pin(kugou::account(ctx))),
        playlists: Some(|ctx, scope, offset, limit| {
            Box::pin(kugou::playlists(ctx, scope, offset, limit))
        }),
        playlist_detail: Some(|ctx, id, offset, limit| {
            Box::pin(kugou::playlist_detail(ctx, id, offset, limit))
        }),
        playlist_write: Some(PlaylistWriteOps {
            create: |ctx, name| Box::pin(kugou::playlist_create(ctx, name)),
            delete: |ctx, id| Box::pin(kugou::playlist_delete(ctx, id)),
            add: |ctx, id, tracks| Box::pin(kugou::playlist_add(ctx, id, tracks)),
            remove: |ctx, id, tracks| Box::pin(kugou::playlist_remove(ctx, id, tracks)),
        }),
        recommend_songs: Some(|ctx, offset, limit| {
            Box::pin(async move {
                kugou::recommend_songs(ctx).await.map(|page| {
                    page.tracks
                        .into_iter()
                        .skip(offset)
                        .take(limit.clamp(1, 100))
                        .collect()
                })
            })
        }),
        qr: Some(QrOps {
            start: |ctx, _channel| Box::pin(kugou::qr_create(ctx)),
            poll: |ctx, ticket| Box::pin(kugou::qr_check(ctx, ticket)),
        }),
        ..Provider::new(
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
            CoreOps {
                search: |ctx, q| Box::pin(kugou::search(ctx, q)),
                stream: |ctx, id, track_ref, q| Box::pin(kugou::stream(ctx, id, track_ref, q)),
                detail: |ctx, id| Box::pin(kugou::detail(ctx, id)),
                lyric: |ctx, id| Box::pin(kugou::lyric(ctx, id)),
            },
        )
    },
    Provider {
        referer: Some("https://www.kuwo.cn/"),
        quality: QualityProfile {
            default: quality::Quality::Exhigh,
            allowed: &[
                quality::Quality::Standard,
                quality::Quality::Exhigh,
                quality::Quality::Lossless,
            ],
        },
        credentials: Some(CredentialRules {
            enrich: cred::enrich_kuwo,
            signed_in: cred::signed_in_kuwo,
        }),
        account: Some(|ctx| Box::pin(kuwo::account(ctx))),
        ..Provider::new(
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
            CoreOps {
                search: |ctx, q| Box::pin(kuwo::search(ctx, q)),
                stream: |ctx, id, track_ref, q| Box::pin(kuwo::stream(ctx, id, track_ref, q)),
                detail: |ctx, id| Box::pin(kuwo::detail(ctx, id)),
                lyric: |ctx, id| Box::pin(kuwo::lyric(ctx, id)),
            },
        )
    },
    Provider {
        referer: Some("https://ccmixter.org/"),
        ..Provider::new(
            SourceInfo {
                id: "ccmixter",
                label: "CCmixter · CC 授权曲库",
                cats: &[],
                supports_cookie: false,
                caps: &[],
            },
            CoreOps {
                search: |ctx, q| Box::pin(ccmixter::search(ctx, q)),
                stream: |ctx, id, _track_ref, q| Box::pin(ccmixter::stream(ctx, id, q)),
                detail: |ctx, id| Box::pin(ccmixter::detail(ctx, id)),
                lyric: |ctx, id| Box::pin(ccmixter::lyric(ctx, id)),
            },
        )
    },
    Provider {
        ready: Some(|ctx| Box::pin(jamendo::ready(ctx))),
        ..Provider::new(
            SourceInfo {
                id: "jamendo",
                label: "Jamendo · CC 授权曲库",
                cats: &[],
                // client_id 由用户注册后写入 settings（jamendo::CLIENT_ID_KEY）；
                // 未配置时 list_sources 与聚合搜索都会跳过，列表里不出现这个源。
                supports_cookie: false,
                caps: &[],
            },
            CoreOps {
                search: |ctx, q| Box::pin(jamendo::search(ctx, q)),
                stream: |ctx, id, _track_ref, q| Box::pin(jamendo::stream(ctx, id, q)),
                detail: |ctx, id| Box::pin(jamendo::detail(ctx, id)),
                lyric: |ctx, id| Box::pin(jamendo::lyric(ctx, id)),
            },
        )
    },
    Provider {
        referer: Some("https://www.qishui.com/"),
        credentials: Some(CredentialRules {
            enrich: |_| {},
            signed_in: cred::signed_in_qishui,
        }),
        account: Some(|ctx| Box::pin(qishui::account(ctx))),
        qr: Some(QrOps {
            start: |ctx, _channel| Box::pin(qishui::qr_create(ctx)),
            poll: |ctx, ticket| Box::pin(qishui::qr_check(ctx, ticket)),
        }),
        ..Provider::new(
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
            CoreOps {
                search: |ctx, q| Box::pin(qishui::search(ctx, q)),
                stream: |ctx, id, track_ref, q| Box::pin(qishui::stream(ctx, id, track_ref, q)),
                detail: |ctx, id| Box::pin(qishui::detail(ctx, id)),
                lyric: |ctx, id| Box::pin(qishui::lyric(ctx, id)),
            },
        )
    },
    Provider {
        referer: Some("https://y.migu.cn/"),
        playlist_search: Some(|ctx, q| Box::pin(migu::search_playlists(ctx, q))),
        ..Provider::new(
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
            CoreOps {
                search: |ctx, q| Box::pin(migu::search(ctx, q)),
                stream: |ctx, id, track_ref, q| Box::pin(migu::stream(ctx, id, track_ref, q)),
                detail: |ctx, id| Box::pin(migu::detail(ctx, id)),
                lyric: |ctx, id| Box::pin(migu::lyric(ctx, id)),
            },
        )
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: Provider = Provider::new(
        SourceInfo {
            id: "fixture",
            label: "Fixture provider",
            cats: &[],
            supports_cookie: false,
            caps: &[],
        },
        CoreOps {
            search: |_ctx, q| {
                Box::pin(async move {
                    Ok(SearchPage {
                        source: q.source.clone(),
                        keyword: q.q.clone().unwrap_or_default(),
                        total: q.offset + q.limit,
                        tracks: vec![],
                        warning: q.cat.clone(),
                    })
                })
            },
            stream: |_ctx, id, track_ref, quality| {
                Box::pin(async move {
                    Ok(StreamInfo {
                        source: "fixture".into(),
                        id: id.into(),
                        url: track_ref
                            .and_then(|r| r["url"].as_str())
                            .unwrap_or("")
                            .into(),
                        bitrate: Some(quality.into()),
                        expires_in_secs: None,
                        fallbacks: vec![],
                        rg_gain_db: None,
                        rg_peak: None,
                    })
                })
            },
            detail: |_ctx, id| {
                Box::pin(async move {
                    Ok(OnlineDetail {
                        source: "fixture".into(),
                        id: id.into(),
                        title: "fixture detail".into(),
                        artist: String::new(),
                        album: String::new(),
                        duration_ms: 1,
                        cover: None,
                    })
                })
            },
            lyric: |_ctx, id| {
                Box::pin(async move {
                    let mut lyric = vmusic_core::LyricDocument::empty();
                    lyric.translation = Some(vec![id.into()]);
                    Ok(lyric)
                })
            },
        },
    );

    fn lazy_context() -> Ctx {
        Ctx {
            db: SqlitePool::connect_lazy("sqlite::memory:").unwrap(),
        }
    }

    #[test]
    fn builtins_validate_actual_callable_slots_and_preserve_public_order() {
        let registry = Registry::new(PROVIDERS).unwrap();
        assert_eq!(
            SOURCES.iter().map(|s| s.id).collect::<Vec<_>>(),
            ["netease", "qq", "kugou", "kuwo", "ccmixter", "jamendo", "qishui", "migu"]
        );
        for info in SOURCES {
            let provider = registry.require(info.id).unwrap();
            assert_eq!(
                serde_json::to_value(info).unwrap(),
                serde_json::to_value(provider.info).unwrap()
            );
            for cap in info.caps {
                assert!(provider.backs(*cap), "{}: {cap:?}", info.id);
            }
        }
        // These implementations remain bound while the real-machine gates stay closed.
        let kugou = registry.require("kugou").unwrap();
        assert!(kugou.playlist_write.is_some());
        assert!(kugou.recommend_songs.is_some());
        assert!(kugou.gate(Capability::PlaylistWrite).is_err());
        assert!(kugou.gate(Capability::RecommendSongs).is_err());
    }

    #[tokio::test]
    async fn an_extra_provider_dispatches_through_the_same_registry_without_source_arms() {
        let mut providers = PROVIDERS.to_vec();
        providers.push(FIXTURE);
        let registry = Registry::new(&providers).unwrap();
        let ctx = lazy_context();
        let query = SearchQuery {
            source: "fixture".into(),
            q: Some("needle".into()),
            cat: Some("category".into()),
            offset: 7,
            limit: 3,
        };
        let page = registry.search(&ctx, &query).await.unwrap();
        assert_eq!(
            (page.source.as_str(), page.keyword.as_str(), page.total),
            ("fixture", "needle", 10)
        );
        assert_eq!(page.warning.as_deref(), Some("category"));

        let provider = registry.require("fixture").unwrap();
        let track_ref = serde_json::json!({"url": "fixture://stream"});
        let stream = (provider.core.stream)(&ctx, "track:9", Some(&track_ref), 740_000)
            .await
            .unwrap();
        assert_eq!(
            (stream.id.as_str(), stream.url.as_str(), stream.bitrate),
            ("track:9", "fixture://stream", Some(740_000))
        );
        assert_eq!(
            (provider.core.detail)(&ctx, "track:9").await.unwrap().id,
            "track:9"
        );
        assert_eq!(
            (provider.core.lyric)(&ctx, "track:9")
                .await
                .unwrap()
                .translation,
            Some(vec!["track:9".into()])
        );
        assert_eq!(
            registry.require("missing").err().unwrap().code,
            "capability_unsupported"
        );
    }

    #[tokio::test]
    async fn optional_operations_require_the_gate_and_forward_arguments_and_errors() {
        let fixture = Provider {
            info: SourceInfo {
                caps: &[Capability::Like],
                ..FIXTURE.info
            },
            like: Some(|_ctx, id, liked| {
                Box::pin(async move {
                    assert_eq!((id, liked), ("liked:42", false));
                    Err(ApiError::auth_required("fixture expired"))
                })
            }),
            ..FIXTURE
        };
        let providers = [fixture];
        let registry = Registry::new(&providers).unwrap();
        let provider = registry.require("fixture").unwrap();
        let op = provider
            .operation(Capability::Like, "红心", provider.like)
            .unwrap();
        let error = op(&lazy_context(), "liked:42", false).await.unwrap_err();
        assert_eq!(error.code, "auth_required");
        assert_eq!(error.message, "fixture expired");

        let closed = Provider {
            info: FIXTURE.info,
            ..fixture
        };
        assert_eq!(
            closed
                .operation(Capability::Like, "红心", closed.like)
                .unwrap_err()
                .status,
            404
        );
        let missing = Provider {
            like: None,
            ..fixture
        };
        assert_eq!(
            missing
                .operation(Capability::Like, "红心", missing.like)
                .unwrap_err()
                .status,
            502
        );
    }

    #[test]
    fn malformed_registration_is_rejected_at_the_boundary() {
        let unbound = Provider {
            info: SourceInfo {
                caps: &[Capability::Like],
                ..FIXTURE.info
            },
            ..FIXTURE
        };
        assert!(Registry::new(&[unbound])
            .err()
            .unwrap()
            .contains("Like has no callable operation"));
        assert!(Registry::new(&[FIXTURE, FIXTURE])
            .err()
            .unwrap()
            .contains("duplicate id"));
        let invalid_quality = Provider {
            quality: QualityProfile {
                default: quality::Quality::Hires,
                ..QualityProfile::STANDARD
            },
            ..FIXTURE
        };
        assert!(Registry::new(&[invalid_quality])
            .err()
            .unwrap()
            .contains("default quality"));
        let invalid_annotation = Provider {
            unverified: &[Capability::QrLogin],
            ..FIXTURE
        };
        assert!(Registry::new(&[invalid_annotation])
            .err()
            .unwrap()
            .contains("unverified capability"));
    }

    #[tokio::test]
    async fn configured_readiness_reaches_sources_and_daily_state_without_network() {
        let dir =
            std::env::temp_dir().join(format!("hertz-provider-ready-{}", uuid::Uuid::new_v4()));
        let ctx = Ctx {
            db: vmusic_store::open(&dir).await.unwrap(),
        };
        let provider = require("jamendo").unwrap();
        assert!(!provider.is_ready(&ctx).await);
        for empty in [serde_json::json!("  "), serde_json::json!(42)] {
            vmusic_store::settings::set(&ctx.db, jamendo::CLIENT_ID_KEY, &empty)
                .await
                .unwrap();
            assert!(!provider.is_ready(&ctx).await);
        }
        assert!(!list_sources(&ctx)
            .await
            .iter()
            .any(|s| s["id"] == "jamendo"));
        assert_eq!(
            daily_source_states(&ctx)
                .await
                .iter()
                .find(|s| s.source == "jamendo")
                .unwrap()
                .kind,
            Some("unavailable")
        );
        vmusic_store::settings::set(
            &ctx.db,
            jamendo::CLIENT_ID_KEY,
            &serde_json::json!(" app-id "),
        )
        .await
        .unwrap();
        assert!(provider.is_ready(&ctx).await);
        assert!(list_sources(&ctx)
            .await
            .iter()
            .any(|s| s["id"] == "jamendo"));
        assert_eq!(
            daily_source_states(&ctx)
                .await
                .iter()
                .find(|s| s.source == "jamendo")
                .unwrap()
                .kind,
            Some("unsupported")
        );
        assert!(require("ccmixter").unwrap().is_ready(&ctx).await);
        ctx.db.close().await;
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
