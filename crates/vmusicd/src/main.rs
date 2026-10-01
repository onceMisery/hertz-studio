// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! `hertz-studio` — the mmusic-studio service binary.
//!
//! Run `hertz-studio --help` for options. With no arguments it binds a fixed local
//! port, writes a discovery file with the token, and serves the bundled UI.

mod config;
mod daily;
mod diag;
mod error;
mod history;
mod online;
mod persist;
mod radio;
mod remote;
mod routes;
mod scan;
mod secrets;
mod stage_beats;
mod state;
mod ws;

use std::sync::Arc;

use axum::extract::Path;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use tokio::sync::broadcast;
use vmusic_audio::{spawn, BackendKind};

use config::Config;
use state::{spawn_event_pump, AppState};

/// 内嵌的界面资源。
///
/// 用 `include_str!` 而不是 `ServeDir`，是为了让单个 exe 拷出构建目录还能跑
/// ——这是本地优先分发的基本前提。代价是改 web/ 下的任何文件都要重新编译。
/// 加一个文件在这里加一行、在下面的路由表里加一行，其余不用动。
const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const STYLE_CSS: &str = include_str!("../web/style.css");
const STAGE_CSS: &str = include_str!("../web/stage.css");
const CREATIVE_CSS: &str = include_str!("../web/creative.css");
const STAGE_JS: &str = include_str!("../web/stage.js");
const STAGE_PARTICLES_JS: &str = include_str!("../web/stage-particles.js");
const STAGE_PARTICLES_GL_JS: &str = include_str!("../web/stage-particles-gl.js");
const THEMES_JS: &str = include_str!("../web/themes.js");
const STAGE_CTL_JS: &str = include_str!("../web/stage-control.js");
const SHELF_JS: &str = include_str!("../web/shelf.js");
const PL_COVERS_JS: &str = include_str!("../web/pl-covers.js");
// 主题工作室：往 Theme 注册二次元主题，并铺一层壁纸背景。
const THEME_STUDIO_JS: &str = include_str!("../web/theme-studio.js");
const THEME_STUDIO_CSS: &str = include_str!("../web/theme-studio.css");
// 界面皮肤：注册表 + 每套皮肤一份 CSS。加新皮肤就在这里多 include 一份，
// 再往路由表里添一行，剩下的（切换/持久化）由 skins.js 统一处理。
const SKINS_JS: &str = include_str!("../web/skins/skins.js");
const SKINS_CSS: &str = include_str!("../web/skins/skins.css");
const SKIN_SHEEN_CSS: &str = include_str!("../web/skins/skin.sheen.css");
const SKIN_WORKBENCH_CSS: &str = include_str!("../web/skins/skin.workbench.css");
const SKIN_LIUNIAN_CSS: &str = include_str!("../web/skins/skin.liunian.css");
const SKIN_LIUNIAN_JS: &str = include_str!("../web/skins/skin.liunian.js");
// 舞台主题：只管沉浸舞台操作层的观感，与皮肤正交、可组合，常驻引入。
const STAGE_THEME_STARFALL_CSS: &str = include_str!("../web/stage-themes/starfall.css");
// 起音检测。粒子层与三维层共用，所以它必须排在两者之前。
const ONSET_JS: &str = include_str!("../web/onset.js");

// 创意舞台的四件套。加载顺序即依赖顺序：内核 → 编排 → 表现层 → 工坊面板。
// creative-gl 必须先于 creative-stage（后者建引擎时读 window.CreativeGL），
// 而 handdrawn / backgrounds 只被 creative-stage 可选地调用，放前放后都行 ——
// 统一放在前面，这样任何一个失败都不会连带挡住编排层。
const CREATIVE_GL_JS: &str = include_str!("../web/creative-gl.js");
const CREATIVE_STAGE_JS: &str = include_str!("../web/creative-stage.js");
const CREATIVE_PROMPT_JS: &str = include_str!("../web/creative-prompt.js");
const HANDDRAWN_JS: &str = include_str!("../web/handdrawn.js");
const BACKGROUNDS_JS: &str = include_str!("../web/backgrounds.js");
const BGWALL_JS: &str = include_str!("../web/bgwall.js");
const LYRIC3D_JS: &str = include_str!("../web/lyric3d.js");
const WORKSHOP_JS: &str = include_str!("../web/workshop.js");
// 舞台相机三件套（电影 → 自由 → 焦点），顺序与 camLayers priority 一致。
const STAGE_CINEMA_JS: &str = include_str!("../web/stage-cinema.js");
const STAGE_FREECAM_JS: &str = include_str!("../web/stage-freecam.js");
const STAGE_FOCUS_JS: &str = include_str!("../web/stage-focus.js");
// 沉浸式三维舞台：独占一个 WebGL2 上下文的全屏演出层，自带后处理链与舞台坞。
const STAGE_LYRICS_JS: &str = include_str!("../web/stage-lyrics.js");
// 沉浸式 3D 歌单架（封面流），移植自 openmusic GalaxyFloatingSongCard。
const STAGE_SHELF_JS: &str = include_str!("../web/stage-shelf.js");
const STAGE3D_JS: &str = include_str!("../web/stage3d.js");
const STAGE3D_CSS: &str = include_str!("../web/stage3d.css");
const STAGE_IMMERSIVE_JS: &str = include_str!("../web/stage-immersive.js");
// stanza 歌词模式（流光 classic / 心象 cadenza / 商籁 sonnet）：零依赖模块 + 样式表，
// 在 index.html 中排在 stage-lyrics.js 之前加载。
const STANZA_UTIL_JS: &str = include_str!("../web/stanza/stanza-util.js");
const STANZA_THEME_JS: &str = include_str!("../web/stanza/stanza-theme.js");
const STANZA_TEXTLAYOUT_JS: &str = include_str!("../web/stanza/stanza-textlayout.js");
const STANZA_BG_JS: &str = include_str!("../web/stanza/stanza-bg.js");
const STANZA_SUBTITLE_JS: &str = include_str!("../web/stanza/stanza-subtitle.js");
const STANZA_CLASSIC_JS: &str = include_str!("../web/stanza/stanza-classic.js");
const STANZA_CADENZA_JS: &str = include_str!("../web/stanza/stanza-cadenza.js");
// 商籁 sonnet：全屏 Pixi 电影镜头歌词。图形引擎 + 渲染器两个模块；PixiJS v8
// （MIT）随包内嵌，但前端只在首次选中商籁时才注入 <script> 惰性加载它。
const STANZA_SONNET_FX_JS: &str = include_str!("../web/stanza/stanza-sonnet-fx.js");
const STANZA_SONNET_JS: &str = include_str!("../web/stanza/stanza-sonnet.js");
const STANZA_TEMPERA_JS: &str = include_str!("../web/stanza/stanza-tempera.js");
const PIXI_JS: &str = include_str!("../web/vendor/pixi.min.js");
const STANZA_CSS: &str = include_str!("../web/stanza/stanza.css");
// 在线曲库（SP1）：vendored MIT 二维码库 + 三个在线模块与样式。
const QRCODE_JS: &str = include_str!("../web/vendor/qrcode.js");
const ONLINE_LOGIN_JS: &str = include_str!("../web/online-login.js");
const ONLINE_JS: &str = include_str!("../web/online.js");
const ONLINE_PLAYLISTS_JS: &str = include_str!("../web/online-playlists.js");
const ONLINE_PLAYLIST_VIEW_JS: &str = include_str!("../web/online-playlist-view.js");
const ONLINE_CSS: &str = include_str!("../web/online.css");
// 收藏与每日推荐。两者都先于 app.js 加载，由 app.js 在启动序列里 bind()。
const FAVORITES_JS: &str = include_str!("../web/favorites.js");
const DAILY_JS: &str = include_str!("../web/daily.js");
const DAILY_VIEW_JS: &str = include_str!("../web/daily-view.js");

// 主题壁纸。与 JS/CSS 不同，这里是二进制资源，所以用 `include_bytes!`。
//
// 为什么不走 `ServeDir`：单个 exe 拷出构建目录还能跑，是本地优先分发的基本
// 前提，壁纸不该是唯一的例外。代价就是体积——所以素材是从 naruto-wallpapers
// 里挑出来的 12 张，并已按长边 1600px / quality 72 预压过（原图每张
// 0.3–3.7 MB，直接内嵌会让二进制膨胀十几 MB），12 张合计约 1.2 MB。
//
// 这张表只负责「名字 → 字节」。哪张配哪套主题、标签叫什么、亮度多少，全部
// 归 theme-studio.js 管——那些是观感问题，改配色不该动 Rust。
const WALLPAPERS: &[(&str, &[u8])] = &[
    (
        "morning-01.jpg",
        include_bytes!("../web/wallpapers/morning-01.jpg"),
    ),
    (
        "morning-09.jpg",
        include_bytes!("../web/wallpapers/morning-09.jpg"),
    ),
    (
        "morning-14.jpg",
        include_bytes!("../web/wallpapers/morning-14.jpg"),
    ),
    (
        "afternoon-19.jpg",
        include_bytes!("../web/wallpapers/afternoon-19.jpg"),
    ),
    (
        "afternoon-07.jpg",
        include_bytes!("../web/wallpapers/afternoon-07.jpg"),
    ),
    (
        "afternoon-20.jpg",
        include_bytes!("../web/wallpapers/afternoon-20.jpg"),
    ),
    (
        "evening-12.jpg",
        include_bytes!("../web/wallpapers/evening-12.jpg"),
    ),
    (
        "evening-16.jpg",
        include_bytes!("../web/wallpapers/evening-16.jpg"),
    ),
    (
        "evening-18.jpg",
        include_bytes!("../web/wallpapers/evening-18.jpg"),
    ),
    (
        "night-02.jpg",
        include_bytes!("../web/wallpapers/night-02.jpg"),
    ),
    (
        "night-08.jpg",
        include_bytes!("../web/wallpapers/night-08.jpg"),
    ),
    (
        "night-12.jpg",
        include_bytes!("../web/wallpapers/night-12.jpg"),
    ),
];

/// 在线音源平台徽标：官方 app 图标 PNG（256×256 统一规格），由前端
/// online.js 的 SOURCE_BADGE 按音源 id 取用。与壁纸同为二进制资源，走
/// `include_bytes!` 内嵌，单 exe 分发不依赖外部文件。
const PLATFORM_ICONS: &[(&str, &[u8])] = &[
    (
        "netease.png",
        include_bytes!("../web/platform-icons/netease.png"),
    ),
    ("qq.png", include_bytes!("../web/platform-icons/qq.png")),
    (
        "kugou.png",
        include_bytes!("../web/platform-icons/kugou.png"),
    ),
    ("kuwo.png", include_bytes!("../web/platform-icons/kuwo.png")),
    (
        "qishui.png",
        include_bytes!("../web/platform-icons/qishui.png"),
    ),
];

const JS: &str = "application/javascript; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    if args.version {
        println!("hertz-studio {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.help {
        print_help();
        return Ok(());
    }

    let data_dir = args.data_dir.unwrap_or_else(config::default_data_dir);
    tokio::fs::create_dir_all(&data_dir).await?;

    let config = Config::load(&data_dir)?;
    init_logging(&config.log.level, &config.log.format);

    // The token is the only thing standing between a local web page and full
    // control of playback, so it is generated once and kept with 0600 perms.
    let token = load_or_create_token(&data_dir).await?;

    let db = vmusic_store::open(&data_dir).await?;

    let backend = match config.audio.backend.as_str() {
        "null" => BackendKind::Null,
        _ => BackendKind::cpal(),
    };
    // 实际生效的后端名要单独记：cpal 拿不到设备时会回落到 null，而「有声吗」
    // 正是播放诊断的第一问句，日志里必须写真正跑起来的那个而不是请求的那个。
    let mut backend_label = config.audio.backend.clone();
    let (audio, _audio_thread) = match spawn(backend).await {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!("requested backend unavailable ({e}); falling back to null");
            backend_label = "null".to_string();
            spawn(BackendKind::Null).await?
        }
    };
    // 开发者选项里的播放诊断日志：默认关闭，开着则跨重启继续录（settings 为权威）。
    diag::init(&data_dir, &backend_label);
    let diag_enabled = vmusic_store::settings::get(&db, diag::SETTING_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    diag::set_enabled(diag_enabled);
    // 音量/模式以服务端 settings 为权威；缺键才回落到 config 默认。
    let (restore_volume, restore_mode) =
        persist::load_player_prefs(&db, config.audio.volume, vmusic_core::PlayMode::Repeat).await;
    audio.set_volume(restore_volume).await.ok();
    audio.set_mode(restore_mode).await.ok();

    // 逐源音质偏好以 settings 为权威；缺键/坏值由 load 内部回落为缺省表。
    let quality_prefs = crate::online::quality::load(&db).await.unwrap_or_default();
    // 用户显式保留的缓存条目（跨重启保留）。
    let keep_list: Vec<String> = crate::persist::load_strings(&db, "online_keep")
        .await
        .unwrap_or_default();
    // DSP 设置：EQ/响度归一化/交叉淡化，跨重启恢复。
    let dsp_config = crate::state::DspConfig::from_settings(
        &vmusic_store::settings::get_all(&db)
            .await
            .unwrap_or_default(),
    );

    let (events, _) = broadcast::channel(128);
    let state = Arc::new(AppState {
        db,
        audio,
        config: Arc::new(config.clone()),
        data_dir: data_dir.clone(),
        token: token.clone(),
        events,
        queue: Default::default(),
        cursor: Default::default(),
        radio: Default::default(),
        radio_fetch: Default::default(),
        scan: Default::default(),
        scan_cancel: Default::default(),
        qr: crate::online::qr::Registry::new(),
        play_generation: Default::default(),
        play_commit: Default::default(),
        buffering: Default::default(),
        online_meta: Default::default(),
        downloads: Default::default(),
        protected: Default::default(),
        keep: tokio::sync::Mutex::new(keep_list),
        dsp: tokio::sync::Mutex::new(dsp_config.clone()),
        auto_failures: Default::default(),
        quality: tokio::sync::Mutex::new(quality_prefs),
        stage_beats: Default::default(),
        weak_self: Default::default(),
    });
    // 供 on_track_committed detach 'static 后台任务用；set 失败只可能是
    // 重复注入，启动路径只走一次，忽略即可。
    let _ = state.weak_self.set(std::sync::Arc::downgrade(&state));
    spawn_event_pump(state.clone());
    // DSP 即时下发（播放时再按曲目追加 track_gain）。
    let _ = state
        .audio
        .set_dsp(vmusic_core::DspParams {
            eq_gains_db: dsp_config.eq_gains_db,
            preamp_db: dsp_config.preamp_db,
            track_gain_db: 0.0,
        })
        .await;
    let _ = state.audio.set_crossfade(dsp_config.crossfade_ms).await;

    // 凭据迁移：SQLite 旧明文凭据 → 系统钥匙串。失败保留旧数据并记 ERROR。
    let db_handle = state.db.clone();
    tokio::spawn(async move {
        crate::online::cred::migrate_secrets_to_keyring(&db_handle).await;
    });
    scan::spawn_watcher(state.clone());

    // 清掉上次崩溃留下的半截下载，并按配置做一次缓存容量回收。
    {
        let cache_dir = state.online_cache_dir();
        crate::online::cache::clean_parts(&cache_dir).await;
        let max = state.config.online.cache_max_bytes;
        if let Err(e) = crate::online::cache::enforce_limit(&cache_dir, max, &[]).await {
            tracing::warn!("缓存 LRU 回收失败: {e}");
        }
    }

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .merge(routes::router(state.clone()))
        .route("/app.js", get(|| asset(JS, APP_JS)))
        .route("/stage.js", get(|| asset(JS, STAGE_JS)))
        .route("/onset.js", get(|| asset(JS, ONSET_JS)))
        .route("/stage-control.js", get(|| asset(JS, STAGE_CTL_JS)))
        .route("/stage-particles.js", get(|| asset(JS, STAGE_PARTICLES_JS)))
        .route(
            "/stage-particles-gl.js",
            get(|| asset(JS, STAGE_PARTICLES_GL_JS)),
        )
        .route("/themes.js", get(|| asset(JS, THEMES_JS)))
        .route("/shelf.js", get(|| asset(JS, SHELF_JS)))
        .route("/pl-covers.js", get(|| asset(JS, PL_COVERS_JS)))
        .route("/theme-studio.js", get(|| asset(JS, THEME_STUDIO_JS)))
        .route("/skins/skins.js", get(|| asset(JS, SKINS_JS)))
        .route("/creative-gl.js", get(|| asset(JS, CREATIVE_GL_JS)))
        .route("/creative-stage.js", get(|| asset(JS, CREATIVE_STAGE_JS)))
        .route("/creative-prompt.js", get(|| asset(JS, CREATIVE_PROMPT_JS)))
        .route("/handdrawn.js", get(|| asset(JS, HANDDRAWN_JS)))
        .route("/backgrounds.js", get(|| asset(JS, BACKGROUNDS_JS)))
        .route("/bgwall.js", get(|| asset(JS, BGWALL_JS)))
        .route("/lyric3d.js", get(|| asset(JS, LYRIC3D_JS)))
        .route("/workshop.js", get(|| asset(JS, WORKSHOP_JS)))
        .route("/stage-cinema.js", get(|| asset(JS, STAGE_CINEMA_JS)))
        .route("/stage-freecam.js", get(|| asset(JS, STAGE_FREECAM_JS)))
        .route("/stage-focus.js", get(|| asset(JS, STAGE_FOCUS_JS)))
        .route("/stage-lyrics.js", get(|| asset(JS, STAGE_LYRICS_JS)))
        .route("/stage-shelf.js", get(|| asset(JS, STAGE_SHELF_JS)))
        .route("/stage3d.js", get(|| asset(JS, STAGE3D_JS)))
        .route("/stage-immersive.js", get(|| asset(JS, STAGE_IMMERSIVE_JS)))
        .route("/stanza/stanza-util.js", get(|| asset(JS, STANZA_UTIL_JS)))
        .route("/stanza/stanza-theme.js", get(|| asset(JS, STANZA_THEME_JS)))
        .route(
            "/stanza/stanza-textlayout.js",
            get(|| asset(JS, STANZA_TEXTLAYOUT_JS)),
        )
        .route("/stanza/stanza-bg.js", get(|| asset(JS, STANZA_BG_JS)))
        .route(
            "/stanza/stanza-subtitle.js",
            get(|| asset(JS, STANZA_SUBTITLE_JS)),
        )
        .route(
            "/stanza/stanza-classic.js",
            get(|| asset(JS, STANZA_CLASSIC_JS)),
        )
        .route(
            "/stanza/stanza-cadenza.js",
            get(|| asset(JS, STANZA_CADENZA_JS)),
        )
        .route(
            "/stanza/stanza-sonnet-fx.js",
            get(|| asset(JS, STANZA_SONNET_FX_JS)),
        )
        .route("/stanza/stanza-sonnet.js", get(|| asset(JS, STANZA_SONNET_JS)))
        .route(
            "/stanza/stanza-tempera.js",
            get(|| asset(JS, STANZA_TEMPERA_JS)),
        )
        .route("/vendor/pixi.min.js", get(|| asset(JS, PIXI_JS)))
        .route("/vendor/qrcode.js", get(|| asset(JS, QRCODE_JS)))
        .route("/online-login.js", get(|| asset(JS, ONLINE_LOGIN_JS)))
        .route("/online.js", get(|| asset(JS, ONLINE_JS)))
        .route(
            "/online-playlists.js",
            get(|| asset(JS, ONLINE_PLAYLISTS_JS)),
        )
        .route(
            "/online-playlist-view.js",
            get(|| asset(JS, ONLINE_PLAYLIST_VIEW_JS)),
        )
        .route("/favorites.js", get(|| asset(JS, FAVORITES_JS)))
        .route("/daily.js", get(|| asset(JS, DAILY_JS)))
        .route("/daily-view.js", get(|| asset(JS, DAILY_VIEW_JS)))
        .route("/style.css", get(|| asset(CSS, STYLE_CSS)))
        .route("/stage.css", get(|| asset(CSS, STAGE_CSS)))
        .route("/creative.css", get(|| asset(CSS, CREATIVE_CSS)))
        .route("/stage3d.css", get(|| asset(CSS, STAGE3D_CSS)))
        .route("/stanza/stanza.css", get(|| asset(CSS, STANZA_CSS)))
        .route("/online.css", get(|| asset(CSS, ONLINE_CSS)))
        .route("/theme-studio.css", get(|| asset(CSS, THEME_STUDIO_CSS)))
        .route("/skins/skins.css", get(|| asset(CSS, SKINS_CSS)))
        .route(
            "/skins/skin.sheen.css",
            get(|| asset(CSS, SKIN_SHEEN_CSS)),
        )
        .route(
            "/skins/skin.workbench.css",
            get(|| asset(CSS, SKIN_WORKBENCH_CSS)),
        )
        .route(
            "/skins/skin.liunian.css",
            get(|| asset(CSS, SKIN_LIUNIAN_CSS)),
        )
        .route("/skins/skin.liunian.js", get(|| asset(JS, SKIN_LIUNIAN_JS)))
        .route(
            "/stage-themes/starfall.css",
            get(|| asset(CSS, STAGE_THEME_STARFALL_CSS)),
        )
        .route("/wallpapers/{name}", get(wallpaper))
        .route("/platform-icons/{name}", get(platform_icon))
        .route(
            "/",
            get({
                let state = state.clone();
                move || index(state.clone())
            }),
        )
        .with_state(state.clone());

    let bind = args.bind.unwrap_or_else(|| config.server.bind.clone());
    let port = args.port.unwrap_or(config.server.port);
    let listener = tokio::net::TcpListener::bind((bind.as_str(), port)).await?;
    let actual_port = listener.local_addr()?.port();

    let discovery = state::write_discovery(&state, actual_port).await?;
    let url = format!("http://127.0.0.1:{actual_port}/?token={token}");
    tracing::info!("listening on {bind}:{actual_port}");
    println!("mmusic-studio v{}", env!("CARGO_PKG_VERSION"));
    println!("  ui       {url}");
    println!("  health   http://127.0.0.1:{actual_port}/v1/health");
    println!("  discovery {}", discovery.display());

    if args.open {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
    }

    let shutdown_state = state.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::signal::ctrl_c().await.ok();
            tracing::info!("shutting down");
            shutdown_state.audio.shutdown();
            state::remove_discovery(&shutdown_state.data_dir).await;
        })
        .await?;

    Ok(())
}

/// Placeholder in `web/index.html` that receives the session token.
///
/// It must differ from the JS variable name written next to it: replacing the
/// variable name too leaves `window.__VMUSIC_TOKEN__` undefined, and every
/// request then leaves with an empty token.
const TOKEN_PLACEHOLDER: &str = "__VMUSIC_TOKEN_VALUE__";

fn render_index(html: &str, token: &str) -> String {
    html.replace(TOKEN_PLACEHOLDER, token)
}

async fn index(state: Arc<AppState>) -> axum::response::Response {
    (
        [
            (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        render_index(INDEX_HTML, &state.token),
    )
        .into_response()
}

/// 内嵌资源的统一出口。
///
/// 每个文件不再有独立的 `serve_*`：以前加一层视觉效果要动 4 个地方（const、
/// 一个 handler、一条 route、以及那份复制粘贴的 header 拼装），漏一处就是
/// 404 或 MIME 不对导致浏览器拒绝执行。现在只剩 const 一行 + route 一行。
///
/// 必须带 `Cache-Control: no-cache`：内嵌资源没有 Last-Modified/ETag 可供
/// 协商，浏览器启发式缓存会把几天前的旧 JS/CSS 一直端出来，前端修了 bug
/// 用户也拿不到（歌单视图在线分区就栽过这个）。本机回源代价可忽略。
async fn asset(mime: &'static str, body: &'static str) -> axum::response::Response {
    (
        [
            (axum::http::header::CONTENT_TYPE, mime),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

/// 壁纸字节出口。名字取自白名单表，查不到就是 404 —— `{name}` 只匹配单段
/// 路径，所以 `..%2f` 这类穿越在这里既到不了磁盘也不在表里，无需额外校验。
async fn wallpaper(Path(name): Path<String>) -> axum::response::Response {
    match WALLPAPERS.iter().find(|(n, _)| *n == name) {
        Some((_, bytes)) => (
            [
                (axum::http::header::CONTENT_TYPE, "image/jpeg"),
                // 与 JS/CSS 的 no-cache 相反：壁纸是按名字寻址的不可变内容，
                // 每次进设置页都重下 1.2 MB 才是浪费。换壁纸等于换文件名，
                // 不存在「缓存了旧内容」的问题。
                (
                    axum::http::header::CACHE_CONTROL,
                    "public, max-age=604800, immutable",
                ),
            ],
            *bytes,
        )
            .into_response(),
        None => (axum::http::StatusCode::NOT_FOUND, "no such wallpaper").into_response(),
    }
}

/// 平台徽标字节出口。与壁纸同一套白名单寻址：名字查不到就是 404，
/// `{name}` 只匹配单段路径，穿越既到不了磁盘也不在表里。图标按音源 id
/// 命名、内容不可变，缓存策略与壁纸一致（immutable）。
async fn platform_icon(Path(name): Path<String>) -> axum::response::Response {
    match PLATFORM_ICONS.iter().find(|(n, _)| *n == name) {
        Some((_, bytes)) => (
            [
                (axum::http::header::CONTENT_TYPE, "image/png"),
                (
                    axum::http::header::CACHE_CONTROL,
                    "public, max-age=604800, immutable",
                ),
            ],
            *bytes,
        )
            .into_response(),
        None => (axum::http::StatusCode::NOT_FOUND, "no such platform icon").into_response(),
    }
}

async fn load_or_create_token(data_dir: &std::path::Path) -> anyhow::Result<String> {
    let path = data_dir.join("token");
    if let Ok(existing) = tokio::fs::read_to_string(&path).await {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    tokio::fs::write(&path, &token).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(token)
}

fn init_logging(level: &str, format: &str) {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level));
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    match format {
        "json" => {
            let _ = builder.json().try_init();
        }
        _ => {
            let _ = builder.try_init();
        }
    }
}

struct Args {
    help: bool,
    open: bool,
    bind: Option<String>,
    port: Option<u16>,
    data_dir: Option<std::path::PathBuf>,
    version: bool,
}

impl Args {
    fn parse() -> Self {
        let mut args = Self {
            help: false,
            open: false,
            bind: None,
            port: None,
            data_dir: None,
            version: false,
        };
        let mut iter = std::env::args().skip(1);
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "-h" | "--help" => args.help = true,
                "--version" => args.version = true,
                "--open" => args.open = true,
                "--bind" => args.bind = iter.next(),
                "--port" => args.port = iter.next().and_then(|v| v.parse().ok()),
                "--data-dir" => args.data_dir = iter.next().map(std::path::PathBuf::from),
                _ => {}
            }
        }
        args
    }
}

fn print_help() {
    println!(
        "hertz-studio — mmusic-studio service\n\n\
         Usage: hertz-studio [OPTIONS]\n\n\
         Options:\n  \
         --bind ADDR      Bind address (default 127.0.0.1)\n  \
         --port PORT      Port, 0 for a random free port (default 7634)\n  \
         --data-dir DIR   Where the database, cache and token live\n  \
         --open           Open the UI in the default browser\n  \
         -h, --help       Show this help\n\n\
         Environment: VMUSIC_BIND, VMUSIC_PORT, VMUSIC_BACKEND, VMUSIC_LOG, VMUSIC_DATA_DIR"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: the placeholder used to be identical to the JS variable
    /// name, so `str::replace` also rewrote the assignment target and the page
    /// ended up with `window.<token> = "<token>"` — leaving every request
    /// unauthenticated.
    #[test]
    fn index_injects_the_token_without_renaming_the_variable() {
        let rendered = render_index(INDEX_HTML, "tok-123");

        assert!(
            rendered.contains(r#"window.__VMUSIC_TOKEN__ = "tok-123""#),
            "token was not injected into the variable"
        );
        assert!(
            !rendered.contains(TOKEN_PLACEHOLDER),
            "placeholder was left in the page"
        );
        assert!(
            !rendered.contains("window.tok-123"),
            "the variable name was rewritten"
        );
    }
}
