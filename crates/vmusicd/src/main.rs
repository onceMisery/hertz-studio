// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! `vmusicd` — the mmusic-studio service.
//!
//! Run `vmusicd --help` for options. With no arguments it binds a fixed local
//! port, writes a discovery file with the token, and serves the bundled UI.

mod config;
mod daily;
mod error;
// 播放历史数据层；路由与播放记录在后续任务接入，此前暂允许 dead_code。
#[allow(dead_code)]
mod history;
mod online;
mod persist;
mod routes;
mod scan;
mod state;
mod ws;

use std::sync::Arc;

use axum::response::{Html, IntoResponse};
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
const STAGE_GL_HOST_JS: &str = include_str!("../web/stage-gl-host.js");
const STAGE_COVER_PARTICLES_JS: &str = include_str!("../web/stage-cover-particles.js");
const STAGE_STARRIVER_JS: &str = include_str!("../web/stage-starriver.js");
const VISUAL_CONTROLLER_JS: &str = include_str!("../web/visual-controller.js");
const THEMES_JS: &str = include_str!("../web/themes.js");
const STAGE_CTL_JS: &str = include_str!("../web/stage-control.js");
const SHELF_JS: &str = include_str!("../web/shelf.js");
const PL_COVERS_JS: &str = include_str!("../web/pl-covers.js");
// 起音检测。粒子层与三维层共用，所以它必须排在两者之前。
const ONSET_JS: &str = include_str!("../web/onset.js");

// 创意舞台的四件套。加载顺序即依赖顺序：内核 → 编排 → 表现层 → 工坊面板。
// creative-gl 必须先于 creative-stage（后者建引擎时读 window.CreativeGL），
// 而 handdrawn / backgrounds 只被 creative-stage 可选地调用，放前放后都行 ——
// 统一放在前面，这样任何一个失败都不会连带挡住编排层。
const CREATIVE_GL_JS: &str = include_str!("../web/creative-gl.js");
const CREATIVE_STAGE_JS: &str = include_str!("../web/creative-stage.js");
const HANDDRAWN_JS: &str = include_str!("../web/handdrawn.js");
const BACKGROUNDS_JS: &str = include_str!("../web/backgrounds.js");
const BGWALL_JS: &str = include_str!("../web/bgwall.js");
const LYRIC3D_JS: &str = include_str!("../web/lyric3d.js");
const WORKSHOP_JS: &str = include_str!("../web/workshop.js");
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

const JS: &str = "application/javascript; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

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
    let (audio, _audio_thread) = match spawn(backend).await {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!("requested backend unavailable ({e}); falling back to null");
            spawn(BackendKind::Null).await?
        }
    };
    // 音量/模式以服务端 settings 为权威；缺键才回落到 config 默认。
    let (restore_volume, restore_mode) =
        persist::load_player_prefs(&db, config.audio.volume, vmusic_core::PlayMode::Repeat).await;
    audio.set_volume(restore_volume).await.ok();
    audio.set_mode(restore_mode).await.ok();

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
        scan: Default::default(),
        qr: crate::online::qr::Registry::new(),
        play_generation: Default::default(),
        play_commit: Default::default(),
        buffering: Default::default(),
        online_meta: Default::default(),
        downloads: Default::default(),
        auto_failures: Default::default(),
        // Task 11 改为启动时从 settings 装载的偏好表；此前用缺省档位。
        quality: Default::default(),
    });
    spawn_event_pump(state.clone());

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
        .route("/stage-gl-host.js", get(|| asset(JS, STAGE_GL_HOST_JS)))
        .route(
            "/stage-cover-particles.js",
            get(|| asset(JS, STAGE_COVER_PARTICLES_JS)),
        )
        .route("/stage-starriver.js", get(|| asset(JS, STAGE_STARRIVER_JS)))
        .route(
            "/visual-controller.js",
            get(|| asset(JS, VISUAL_CONTROLLER_JS)),
        )
        .route("/themes.js", get(|| asset(JS, THEMES_JS)))
        .route("/shelf.js", get(|| asset(JS, SHELF_JS)))
        .route("/pl-covers.js", get(|| asset(JS, PL_COVERS_JS)))
        .route("/creative-gl.js", get(|| asset(JS, CREATIVE_GL_JS)))
        .route("/creative-stage.js", get(|| asset(JS, CREATIVE_STAGE_JS)))
        .route("/handdrawn.js", get(|| asset(JS, HANDDRAWN_JS)))
        .route("/backgrounds.js", get(|| asset(JS, BACKGROUNDS_JS)))
        .route("/bgwall.js", get(|| asset(JS, BGWALL_JS)))
        .route("/lyric3d.js", get(|| asset(JS, LYRIC3D_JS)))
        .route("/workshop.js", get(|| asset(JS, WORKSHOP_JS)))
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
        .route("/style.css", get(|| asset(CSS, STYLE_CSS)))
        .route("/stage.css", get(|| asset(CSS, STAGE_CSS)))
        .route("/creative.css", get(|| asset(CSS, CREATIVE_CSS)))
        .route("/online.css", get(|| asset(CSS, ONLINE_CSS)))
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

async fn index(state: Arc<AppState>) -> Html<String> {
    Html(render_index(INDEX_HTML, &state.token))
}

/// 内嵌资源的统一出口。
///
/// 每个文件不再有独立的 `serve_*`：以前加一层视觉效果要动 4 个地方（const、
/// 一个 handler、一条 route、以及那份复制粘贴的 header 拼装），漏一处就是
/// 404 或 MIME 不对导致浏览器拒绝执行。现在只剩 const 一行 + route 一行。
async fn asset(mime: &'static str, body: &'static str) -> axum::response::Response {
    ([(axum::http::header::CONTENT_TYPE, mime)], body).into_response()
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
}

impl Args {
    fn parse() -> Self {
        let mut args = Self {
            help: false,
            open: false,
            bind: None,
            port: None,
            data_dir: None,
        };
        let mut iter = std::env::args().skip(1);
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "-h" | "--help" => args.help = true,
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
        "vmusicd — mmusic-studio service\n\n\
         Usage: vmusicd [OPTIONS]\n\n\
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
