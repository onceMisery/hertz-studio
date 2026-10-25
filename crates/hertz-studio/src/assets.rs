// SPDX-License-Identifier: MIT
// One declaration owns each embedded UI asset, its route and fingerprint input.
// HTML and image handlers retain their existing authentication/cache semantics.

pub(super) struct UiAsset {
    pub path: &'static str,
    pub mime: &'static str,
    pub body: &'static UiBody,
}

// Embed one compressed representation. Identity clients inflate at most once
// per asset, on demand; ordinary browser requests use the build-time gzip bytes.
pub(super) struct UiBody {
    pub gzip: &'static [u8],
    identity: std::sync::OnceLock<String>,
}

impl UiBody {
    const fn new(gzip: &'static [u8]) -> Self {
        Self {
            gzip,
            identity: std::sync::OnceLock::new(),
        }
    }

    pub fn identity(&self) -> &str {
        self.identity.get_or_init(|| {
            use std::io::Read;
            let mut text = String::new();
            flate2::read::GzDecoder::new(self.gzip)
                .read_to_string(&mut text)
                .expect("build-time gzip contains valid UI text");
            text
        })
    }
}

const JS: &str = "application/javascript; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";

macro_rules! ui_assets {
    ($($(#[$attr:meta])* $path:literal, $mime:ident => const $name:ident: &str = edition_ui!($file:literal);)+) => {
        $($(#[$attr])* static $name: UiBody = UiBody::new(include_bytes!(concat!(env!("OUT_DIR"), "/ui/", $file, ".gz")));)+
        pub(super) static UI_ASSETS: &[UiAsset] = &[
            $($(#[$attr])* UiAsset { path: $path, mime: $mime, body: &$name },)+
        ];
        pub(super) const ASSET_FINGERPRINT_INPUTS: &[&[u8]] = &[
            $($(#[$attr])* include_bytes!(concat!(env!("OUT_DIR"), "/ui/", $file, ".gz")),)+
        ];
    };
}

ui_assets! {
    "/room-transport.js", JS => const ROOM_TRANSPORT_JS: &str = edition_ui!("room-transport.js");
    "/room-workspace.js", JS => const ROOM_WORKSPACE_JS: &str = edition_ui!("room-workspace.js");
    "/room-view.js", JS => const ROOM_VIEW_JS: &str = edition_ui!("room-view.js");
    "/room.js", JS => const ROOM_JS: &str = edition_ui!("room.js");
    "/room.css", CSS => const ROOM_CSS: &str = edition_ui!("room.css");
    "/host.js", JS => const HOST_JS: &str = edition_ui!("host.js");
    "/dialogs.js", JS => const DIALOGS_JS: &str = edition_ui!("dialogs.js");
    "/search-history.js", JS => const SEARCH_HISTORY_JS: &str = edition_ui!("search-history.js");
    "/app.js", JS => const APP_JS: &str = edition_ui!("app.js");
    "/now-playing.js", JS => const NOW_PLAYING_JS: &str = edition_ui!("now-playing.js");
    "/lyric-import.js", JS => const LYRIC_IMPORT_JS: &str = edition_ui!("lyric-import.js");
    "/now-playing.css", CSS => const NOW_PLAYING_CSS: &str = edition_ui!("now-playing.css");
    "/skins/skin.classic.css", CSS => const CLASSIC_CSS: &str = edition_ui!("skins/skin.classic.css");
    "/stage.js", JS => const STAGE_JS: &str = edition_ui!("stage.js");
    "/perf-probe.js", JS => const PERF_PROBE_JS: &str = edition_ui!("perf-probe.js");
    "/home-dashboard.js", JS => const HOME_DASHBOARD_JS: &str = edition_ui!("home-dashboard.js");
    "/home-dashboard.css", CSS => const HOME_DASHBOARD_CSS: &str = edition_ui!("home-dashboard.css");
    "/home-quote.js", JS => const HOME_QUOTE_JS: &str = edition_ui!("home-quote.js");
    "/creative-contract.js", JS => const CREATIVE_CONTRACT_JS: &str = edition_ui!("creative-contract.js");
    "/creative-draft.js", JS => const CREATIVE_DRAFT_JS: &str = edition_ui!("creative-draft.js");
    "/creative-project.js", JS => const CREATIVE_PROJECT_JS: &str = edition_ui!("creative-project.js");
    "/creative-arrangement.js", JS => const CREATIVE_ARRANGEMENT_JS: &str = edition_ui!("creative-arrangement.js");
    "/creative-pitch.js", JS => const CREATIVE_PITCH_JS: &str = edition_ui!("creative-pitch.js");
    "/creative-templates.js", JS => const CREATIVE_TEMPLATES_JS: &str = edition_ui!("creative-templates.js");
    "/creative-share-code.js", JS => const CREATIVE_SHARE_CODE_JS: &str = edition_ui!("creative-share-code.js");
    "/onset.js", JS => const ONSET_JS: &str = edition_ui!("onset.js");
    "/stage-control.js", JS => const STAGE_CTL_JS: &str = edition_ui!("stage-control.js");
    "/stage-particles.js", JS => const STAGE_PARTICLES_JS: &str = edition_ui!("stage-particles.js");
    "/stage-particles-gl.js", JS => const STAGE_PARTICLES_GL_JS: &str = edition_ui!("stage-particles-gl.js");
    "/themes.js", JS => const THEMES_JS: &str = edition_ui!("themes.js");
    "/theme-picker.js", JS => const THEME_PICKER_JS: &str = edition_ui!("theme-picker.js");
    "/anime-interactions.js", JS => const ANIME_INTERACTIONS_JS: &str = edition_ui!("anime-interactions.js");
    "/shelf.js", JS => const SHELF_JS: &str = edition_ui!("shelf.js");
    "/pl-covers.js", JS => const PL_COVERS_JS: &str = edition_ui!("pl-covers.js");
    "/theme-studio.js", JS => const THEME_STUDIO_JS: &str = edition_ui!("theme-studio.js");
    "/skins/skins.js", JS => const SKINS_JS: &str = edition_ui!("skins/skins.js");
    "/creative-gl.js", JS => const CREATIVE_GL_JS: &str = edition_ui!("creative-gl.js");
    "/creative-anime.js", JS => const CREATIVE_ANIME_JS: &str = edition_ui!("creative-anime.js");
    "/creative-stage.js", JS => const CREATIVE_STAGE_JS: &str = edition_ui!("creative-stage.js");
    "/creative-prompt.js", JS => const CREATIVE_PROMPT_JS: &str = edition_ui!("creative-prompt.js");
    "/handdrawn.js", JS => const HANDDRAWN_JS: &str = edition_ui!("handdrawn.js");
    "/backgrounds.js", JS => const BACKGROUNDS_JS: &str = edition_ui!("backgrounds.js");
    "/bgwall.js", JS => const BGWALL_JS: &str = edition_ui!("bgwall.js");
    "/lyric3d.js", JS => const LYRIC3D_JS: &str = edition_ui!("lyric3d.js");
    "/lyric-glyph-sdf.js", JS => const LYRIC_GLYPH_SDF_JS: &str = edition_ui!("lyric-glyph-sdf.js");
    "/lyric-glyph-atlas.js", JS => const LYRIC_GLYPH_ATLAS_JS: &str = edition_ui!("lyric-glyph-atlas.js");
    "/lyric-glyph-gl.js", JS => const LYRIC_GLYPH_GL_JS: &str = edition_ui!("lyric-glyph-gl.js");
    "/lyric-emotion-field.js", JS => const LYRIC_EMOTION_FIELD_JS: &str = edition_ui!("lyric-emotion-field.js");
    "/lyric-emotion.js", JS => const LYRIC_EMOTION_JS: &str = edition_ui!("lyric-emotion.js");
    "/workshop.js", JS => const WORKSHOP_JS: &str = edition_ui!("workshop.js");
    "/ai-ledger.js", JS => const AI_LEDGER_JS: &str = edition_ui!("ai-ledger.js");
    "/stage-cinema.js", JS => const STAGE_CINEMA_JS: &str = edition_ui!("stage-cinema.js");
    "/stage-freecam.js", JS => const STAGE_FREECAM_JS: &str = edition_ui!("stage-freecam.js");
    "/stage-focus.js", JS => const STAGE_FOCUS_JS: &str = edition_ui!("stage-focus.js");
    "/stage-lyrics.js", JS => const STAGE_LYRICS_JS: &str = edition_ui!("stage-lyrics.js");
    "/stage-shelf.js", JS => const STAGE_SHELF_JS: &str = edition_ui!("stage-shelf.js");
    "/vendor/stage-runtime.js", JS => const STAGE_RUNTIME_JS: &str = edition_ui!("vendor/stage-runtime.js");
    "/vendor/coast-stage.js", JS => const COAST_STAGE_JS: &str = edition_ui!("vendor/coast-stage.js");
    "/stage-coast.js", JS => const STAGE_COAST_JS: &str = edition_ui!("stage-coast.js");
    "/vendor/zodiac-stage.js", JS => const ZODIAC_STAGE_JS: &str = edition_ui!("vendor/zodiac-stage.js");
    "/stage-zodiac.js", JS => const STAGE_ZODIAC_JS: &str = edition_ui!("stage-zodiac.js");
    "/stage3d.js", JS => const STAGE3D_JS: &str = edition_ui!("stage3d.js");
    "/stage-anime-svg.js", JS => const STAGE_ANIME_SVG_JS: &str = edition_ui!("stage-anime-svg.js");
    "/stage-immersive.js", JS => const STAGE_IMMERSIVE_JS: &str = edition_ui!("stage-immersive.js");
    "/space-camera.js", JS => const SPACE_CAMERA_JS: &str = edition_ui!("space-camera.js");
    "/space3d.js", JS => const SPACE3D_JS: &str = edition_ui!("space3d.js");
    "/space-home.js", JS => const SPACE_HOME_JS: &str = edition_ui!("space-home.js");
    "/vendor/space-stage.js", JS => const SPACE_STAGE_JS: &str = edition_ui!("vendor/space-stage.js");
    "/space-fields.js", JS => const SPACE_FIELDS_JS: &str = edition_ui!("space-fields.js");
    "/space-post.js", JS => const SPACE_POST_JS: &str = edition_ui!("space-post.js");
    "/space-layers.js", JS => const SPACE_LAYERS_JS: &str = edition_ui!("space-layers.js");
    "/stanza/stanza-util.js", JS => const STANZA_UTIL_JS: &str = edition_ui!("stanza/stanza-util.js");
    "/stanza/stanza-theme.js", JS => const STANZA_THEME_JS: &str = edition_ui!("stanza/stanza-theme.js");
    "/stanza/stanza-textlayout.js", JS => const STANZA_TEXTLAYOUT_JS: &str = edition_ui!("stanza/stanza-textlayout.js");
    "/stanza/stanza-bg.js", JS => const STANZA_BG_JS: &str = edition_ui!("stanza/stanza-bg.js");
    "/stanza/stanza-subtitle.js", JS => const STANZA_SUBTITLE_JS: &str = edition_ui!("stanza/stanza-subtitle.js");
    "/stanza/stanza-classic.js", JS => const STANZA_CLASSIC_JS: &str = edition_ui!("stanza/stanza-classic.js");
    "/stanza/stanza-cadenza.js", JS => const STANZA_CADENZA_JS: &str = edition_ui!("stanza/stanza-cadenza.js");
    "/stanza/stanza-sonnet-fx.js", JS => const STANZA_SONNET_FX_JS: &str = edition_ui!("stanza/stanza-sonnet-fx.js");
    "/stanza/stanza-sonnet.js", JS => const STANZA_SONNET_JS: &str = edition_ui!("stanza/stanza-sonnet.js");
    "/stanza/stanza-tempera.js", JS => const STANZA_TEMPERA_JS: &str = edition_ui!("stanza/stanza-tempera.js");
    "/stanza/stanza-glyph.js", JS => const STANZA_GLYPH_JS: &str = edition_ui!("stanza/stanza-glyph.js");
    "/stanza/stanza-songform.js", JS => const STANZA_SONGFORM_JS: &str = edition_ui!("stanza/stanza-songform.js");
    "/stanza/stanza-starborn.js", JS => const STANZA_STARBORN_JS: &str = edition_ui!("stanza/stanza-starborn.js");
    "/vendor/pixi.min.js", JS => const PIXI_JS: &str = edition_ui!("vendor/pixi.min.js");
    "/stage-settings.js", JS => const STAGE_SETTINGS_JS: &str = edition_ui!("stage-settings.js");
    #[cfg(feature = "full")]
    "/vendor/qrcode.js", JS => const QRCODE_JS: &str = edition_ui!("vendor/qrcode.js");
    #[cfg(feature = "full")]
    "/online-login.js", JS => const ONLINE_LOGIN_JS: &str = edition_ui!("online-login.js");
    "/search-session.js", JS => const SEARCH_SESSION_JS: &str = edition_ui!("search-session.js");
    "/online.js", JS => const ONLINE_JS: &str = edition_ui!("online.js");
    "/podcasts.js", JS => const PODCASTS_JS: &str = edition_ui!("podcasts.js");
    "/online-playlists.js", JS => const ONLINE_PLAYLISTS_JS: &str = edition_ui!("online-playlists.js");
    "/online-playlist-view.js", JS => const ONLINE_PLAYLIST_VIEW_JS: &str = edition_ui!("online-playlist-view.js");
    "/topsearch.js", JS => const TOPSEARCH_JS: &str = edition_ui!("topsearch.js");
    "/favorites.js", JS => const FAVORITES_JS: &str = edition_ui!("favorites.js");
    "/daily.js", JS => const DAILY_JS: &str = edition_ui!("daily.js");
    "/daily-view.js", JS => const DAILY_VIEW_JS: &str = edition_ui!("daily-view.js");
    "/palette.js", JS => const PALETTE_JS: &str = edition_ui!("palette.js");
    "/video-export.js", JS => const VIDEO_EXPORT_JS: &str = edition_ui!("video-export.js");
    "/obs-css.js", JS => const OBS_CSS_JS: &str = edition_ui!("obs-css.js");
    "/style.css", CSS => const STYLE_CSS: &str = edition_ui!("style.css");
    "/stage.css", CSS => const STAGE_CSS: &str = edition_ui!("stage.css");
    "/emotion.css", CSS => const EMOTION_CSS: &str = edition_ui!("emotion.css");
    "/creative.css", CSS => const CREATIVE_CSS: &str = edition_ui!("creative.css");
    "/creative-anime.css", CSS => const CREATIVE_ANIME_CSS: &str = edition_ui!("creative-anime.css");
    "/stage3d.css", CSS => const STAGE3D_CSS: &str = edition_ui!("stage3d.css");
    "/space3d.css", CSS => const SPACE3D_CSS: &str = edition_ui!("space3d.css");
    "/space-home.css", CSS => const SPACE_HOME_CSS: &str = edition_ui!("space-home.css");
    "/space-layers.css", CSS => const SPACE_LAYERS_CSS: &str = edition_ui!("space-layers.css");
    "/stage-anime-svg.css", CSS => const STAGE_ANIME_SVG_CSS: &str = edition_ui!("stage-anime-svg.css");
    "/stanza/stanza.css", CSS => const STANZA_CSS: &str = edition_ui!("stanza/stanza.css");
    "/stanza/stanza-starborn.css", CSS => const STANZA_STARBORN_CSS: &str = edition_ui!("stanza/stanza-starborn.css");
    "/online.css", CSS => const ONLINE_CSS: &str = edition_ui!("online.css");
    "/podcasts.css", CSS => const PODCASTS_CSS: &str = edition_ui!("podcasts.css");
    "/theme-studio.css", CSS => const THEME_STUDIO_CSS: &str = edition_ui!("theme-studio.css");
    "/anime-ui.css", CSS => const ANIME_UI_CSS: &str = edition_ui!("anime-ui.css");
    "/anime-stage.css", CSS => const ANIME_STAGE_CSS: &str = edition_ui!("anime-stage.css");
    // 赛璐璐材质覆盖。index.html 里排在 anime-ui.css 之后 —— 同特异性靠源码
    // 顺序决胜，这里只管挂路由，两件事都要做，漏一件症状完全不同
    // （漏挂路由 = 404，样式全丢；漏排顺序 = 玻璃面板把平涂盖掉，只是不平涂）。
    "/cel-ui.css", CSS => const CEL_UI_CSS: &str = edition_ui!("cel-ui.css");
    "/anime-interactions.css", CSS => const ANIME_INTERACTIONS_CSS: &str = edition_ui!("anime-interactions.css");
    "/skins/skins.css", CSS => const SKINS_CSS: &str = edition_ui!("skins/skins.css");
    "/skins/skin.liunian.css", CSS => const SKIN_LIUNIAN_CSS: &str = edition_ui!("skins/skin.liunian.css");
    "/skins/skin.qingfeng.css", CSS => const SKIN_QINGFENG_CSS: &str = edition_ui!("skins/skin.qingfeng.css");
    "/skins/skin.heijiao.css", CSS => const SKIN_HEIJIAO_CSS: &str = edition_ui!("skins/skin.heijiao.css");
    "/skins/skin-shared.js", JS => const SKIN_SHARED_JS: &str = edition_ui!("skins/skin-shared.js");
    "/skins/skin-settings-sheet.js", JS => const SKIN_SETTINGS_SHEET_JS: &str = edition_ui!("skins/skin-settings-sheet.js");
    "/skins/skin.liunian.js", JS => const SKIN_LIUNIAN_JS: &str = edition_ui!("skins/skin.liunian.js");
    "/skins/skin.qingfeng.js", JS => const SKIN_QINGFENG_JS: &str = edition_ui!("skins/skin.qingfeng.js");
    "/skins/skin.heijiao.js", JS => const SKIN_HEIJIAO_JS: &str = edition_ui!("skins/skin.heijiao.js");
    "/skins/skin.orbit.js", JS => const SKIN_ORBIT_JS: &str = edition_ui!("skins/skin.orbit.js");
    "/skins/skin.orbit.css", CSS => const SKIN_ORBIT_CSS: &str = edition_ui!("skins/skin.orbit.css");
    "/stage-themes/starfall.css", CSS => const STAGE_THEME_STARFALL_CSS: &str = edition_ui!("stage-themes/starfall.css");
    "/stage-themes/ios.css", CSS => const STAGE_THEME_IOS_CSS: &str = edition_ui!("stage-themes/ios.css");
}
