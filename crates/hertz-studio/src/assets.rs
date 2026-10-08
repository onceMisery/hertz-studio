// SPDX-License-Identifier: MIT
// One declaration owns each embedded UI asset, its route and fingerprint input.
// HTML and image handlers retain their existing authentication/cache semantics.

pub(super) struct UiAsset {
    pub path: &'static str,
    pub mime: &'static str,
    pub body: &'static str,
}

const JS: &str = "application/javascript; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";

macro_rules! ui_assets {
    ($($path:literal, $mime:ident => const $name:ident: &str = $body:expr;)+) => {
        $(const $name: &str = $body;)+
        pub(super) const UI_ASSETS: &[UiAsset] = &[
            $(UiAsset { path: $path, mime: $mime, body: $name },)+
        ];
        pub(super) const ASSET_FINGERPRINT_INPUTS: &[&str] = &[$($name,)+];
    };
}

ui_assets! {
    "/host.js", JS => const HOST_JS: &str = include_str!("../../../plugin/ui/host.js");
    "/dialogs.js", JS => const DIALOGS_JS: &str = include_str!("../../../plugin/ui/dialogs.js");
    "/search-history.js", JS => const SEARCH_HISTORY_JS: &str = include_str!("../../../plugin/ui/search-history.js");
    "/app.js", JS => const APP_JS: &str = include_str!("../../../plugin/ui/app.js");
    "/stage.js", JS => const STAGE_JS: &str = include_str!("../../../plugin/ui/stage.js");
    "/perf-probe.js", JS => const PERF_PROBE_JS: &str = include_str!("../../../plugin/ui/perf-probe.js");
    "/home-dashboard.js", JS => const HOME_DASHBOARD_JS: &str = include_str!("../../../plugin/ui/home-dashboard.js");
    "/home-dashboard.css", CSS => const HOME_DASHBOARD_CSS: &str = include_str!("../../../plugin/ui/home-dashboard.css");
    "/creative-share-code.js", JS => const CREATIVE_SHARE_CODE_JS: &str = include_str!("../../../plugin/ui/creative-share-code.js");
    "/onset.js", JS => const ONSET_JS: &str = include_str!("../../../plugin/ui/onset.js");
    "/stage-control.js", JS => const STAGE_CTL_JS: &str = include_str!("../../../plugin/ui/stage-control.js");
    "/stage-particles.js", JS => const STAGE_PARTICLES_JS: &str = include_str!("../../../plugin/ui/stage-particles.js");
    "/stage-particles-gl.js", JS => const STAGE_PARTICLES_GL_JS: &str = include_str!("../../../plugin/ui/stage-particles-gl.js");
    "/themes.js", JS => const THEMES_JS: &str = include_str!("../../../plugin/ui/themes.js");
    "/shelf.js", JS => const SHELF_JS: &str = include_str!("../../../plugin/ui/shelf.js");
    "/pl-covers.js", JS => const PL_COVERS_JS: &str = include_str!("../../../plugin/ui/pl-covers.js");
    "/theme-studio.js", JS => const THEME_STUDIO_JS: &str = include_str!("../../../plugin/ui/theme-studio.js");
    "/skins/skins.js", JS => const SKINS_JS: &str = include_str!("../../../plugin/ui/skins/skins.js");
    "/creative-gl.js", JS => const CREATIVE_GL_JS: &str = include_str!("../../../plugin/ui/creative-gl.js");
    "/creative-stage.js", JS => const CREATIVE_STAGE_JS: &str = include_str!("../../../plugin/ui/creative-stage.js");
    "/creative-prompt.js", JS => const CREATIVE_PROMPT_JS: &str = include_str!("../../../plugin/ui/creative-prompt.js");
    "/handdrawn.js", JS => const HANDDRAWN_JS: &str = include_str!("../../../plugin/ui/handdrawn.js");
    "/backgrounds.js", JS => const BACKGROUNDS_JS: &str = include_str!("../../../plugin/ui/backgrounds.js");
    "/bgwall.js", JS => const BGWALL_JS: &str = include_str!("../../../plugin/ui/bgwall.js");
    "/lyric3d.js", JS => const LYRIC3D_JS: &str = include_str!("../../../plugin/ui/lyric3d.js");
    "/workshop.js", JS => const WORKSHOP_JS: &str = include_str!("../../../plugin/ui/workshop.js");
    "/stage-cinema.js", JS => const STAGE_CINEMA_JS: &str = include_str!("../../../plugin/ui/stage-cinema.js");
    "/stage-freecam.js", JS => const STAGE_FREECAM_JS: &str = include_str!("../../../plugin/ui/stage-freecam.js");
    "/stage-focus.js", JS => const STAGE_FOCUS_JS: &str = include_str!("../../../plugin/ui/stage-focus.js");
    "/stage-lyrics.js", JS => const STAGE_LYRICS_JS: &str = include_str!("../../../plugin/ui/stage-lyrics.js");
    "/stage-shelf.js", JS => const STAGE_SHELF_JS: &str = include_str!("../../../plugin/ui/stage-shelf.js");
    "/stage3d.js", JS => const STAGE3D_JS: &str = include_str!("../../../plugin/ui/stage3d.js");
    "/stage-immersive.js", JS => const STAGE_IMMERSIVE_JS: &str = include_str!("../../../plugin/ui/stage-immersive.js");
    "/stanza/stanza-util.js", JS => const STANZA_UTIL_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-util.js");
    "/stanza/stanza-theme.js", JS => const STANZA_THEME_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-theme.js");
    "/stanza/stanza-textlayout.js", JS => const STANZA_TEXTLAYOUT_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-textlayout.js");
    "/stanza/stanza-bg.js", JS => const STANZA_BG_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-bg.js");
    "/stanza/stanza-subtitle.js", JS => const STANZA_SUBTITLE_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-subtitle.js");
    "/stanza/stanza-classic.js", JS => const STANZA_CLASSIC_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-classic.js");
    "/stanza/stanza-cadenza.js", JS => const STANZA_CADENZA_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-cadenza.js");
    "/stanza/stanza-sonnet-fx.js", JS => const STANZA_SONNET_FX_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-sonnet-fx.js");
    "/stanza/stanza-sonnet.js", JS => const STANZA_SONNET_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-sonnet.js");
    "/stanza/stanza-tempera.js", JS => const STANZA_TEMPERA_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-tempera.js");
    "/stanza/stanza-songform.js", JS => const STANZA_SONGFORM_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-songform.js");
    "/stanza/stanza-starborn.js", JS => const STANZA_STARBORN_JS: &str = include_str!("../../../plugin/ui/stanza/stanza-starborn.js");
    "/vendor/pixi.min.js", JS => const PIXI_JS: &str = include_str!("../../../plugin/ui/vendor/pixi.min.js");
    "/stage-settings.js", JS => const STAGE_SETTINGS_JS: &str = include_str!("../../../plugin/ui/stage-settings.js");
    "/vendor/qrcode.js", JS => const QRCODE_JS: &str = include_str!("../../../plugin/ui/vendor/qrcode.js");
    "/online-login.js", JS => const ONLINE_LOGIN_JS: &str = include_str!("../../../plugin/ui/online-login.js");
    "/online.js", JS => const ONLINE_JS: &str = include_str!("../../../plugin/ui/online.js");
    "/online-playlists.js", JS => const ONLINE_PLAYLISTS_JS: &str = include_str!("../../../plugin/ui/online-playlists.js");
    "/online-playlist-view.js", JS => const ONLINE_PLAYLIST_VIEW_JS: &str = include_str!("../../../plugin/ui/online-playlist-view.js");
    "/topsearch.js", JS => const TOPSEARCH_JS: &str = include_str!("../../../plugin/ui/topsearch.js");
    "/favorites.js", JS => const FAVORITES_JS: &str = include_str!("../../../plugin/ui/favorites.js");
    "/daily.js", JS => const DAILY_JS: &str = include_str!("../../../plugin/ui/daily.js");
    "/daily-view.js", JS => const DAILY_VIEW_JS: &str = include_str!("../../../plugin/ui/daily-view.js");
    "/palette.js", JS => const PALETTE_JS: &str = include_str!("../../../plugin/ui/palette.js");
    "/video-export.js", JS => const VIDEO_EXPORT_JS: &str = include_str!("../../../plugin/ui/video-export.js");
    "/obs-css.js", JS => const OBS_CSS_JS: &str = include_str!("../../../plugin/ui/obs-css.js");
    "/style.css", CSS => const STYLE_CSS: &str = include_str!("../../../plugin/ui/style.css");
    "/stage.css", CSS => const STAGE_CSS: &str = include_str!("../../../plugin/ui/stage.css");
    "/creative.css", CSS => const CREATIVE_CSS: &str = include_str!("../../../plugin/ui/creative.css");
    "/stage3d.css", CSS => const STAGE3D_CSS: &str = include_str!("../../../plugin/ui/stage3d.css");
    "/stanza/stanza.css", CSS => const STANZA_CSS: &str = include_str!("../../../plugin/ui/stanza/stanza.css");
    "/stanza/stanza-starborn.css", CSS => const STANZA_STARBORN_CSS: &str = include_str!("../../../plugin/ui/stanza/stanza-starborn.css");
    "/online.css", CSS => const ONLINE_CSS: &str = include_str!("../../../plugin/ui/online.css");
    "/theme-studio.css", CSS => const THEME_STUDIO_CSS: &str = include_str!("../../../plugin/ui/theme-studio.css");
    "/skins/skins.css", CSS => const SKINS_CSS: &str = include_str!("../../../plugin/ui/skins/skins.css");
    "/skins/skin.sheen.css", CSS => const SKIN_SHEEN_CSS: &str = include_str!("../../../plugin/ui/skins/skin.sheen.css");
    "/skins/skin.workbench.css", CSS => const SKIN_WORKBENCH_CSS: &str = include_str!("../../../plugin/ui/skins/skin.workbench.css");
    "/skins/skin.liunian.css", CSS => const SKIN_LIUNIAN_CSS: &str = include_str!("../../../plugin/ui/skins/skin.liunian.css");
    "/skins/skin.ios.css", CSS => const SKIN_IOS_CSS: &str = include_str!("../../../plugin/ui/skins/skin.ios.css");
    "/skins/skin.qingfeng.css", CSS => const SKIN_QINGFENG_CSS: &str = include_str!("../../../plugin/ui/skins/skin.qingfeng.css");
    "/skins/skin.chaoxi.css", CSS => const SKIN_CHAOXI_CSS: &str = include_str!("../../../plugin/ui/skins/skin.chaoxi.css");
    "/skins/skin-shared.js", JS => const SKIN_SHARED_JS: &str = include_str!("../../../plugin/ui/skins/skin-shared.js");
    "/skins/skin.liunian.js", JS => const SKIN_LIUNIAN_JS: &str = include_str!("../../../plugin/ui/skins/skin.liunian.js");
    "/skins/skin.qingfeng.js", JS => const SKIN_QINGFENG_JS: &str = include_str!("../../../plugin/ui/skins/skin.qingfeng.js");
    "/stage-themes/starfall.css", CSS => const STAGE_THEME_STARFALL_CSS: &str = include_str!("../../../plugin/ui/stage-themes/starfall.css");
    "/stage-themes/ios.css", CSS => const STAGE_THEME_IOS_CSS: &str = include_str!("../../../plugin/ui/stage-themes/ios.css");
}
