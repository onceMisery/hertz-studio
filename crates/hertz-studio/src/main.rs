// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! `hertz-studio` — the hertz-studio service binary.
//!
//! Run `hertz-studio --help` for options. With no arguments it binds a fixed local
//! port, writes a discovery file with the token, and serves the bundled UI.

use hertz_studio::{bootstrap, config, routes, state, ws};
use std::sync::Arc;

use axum::extract::Path;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;

use state::AppState;

/// 内嵌的界面资源。
///
mod assets;

// The UI registry owns JavaScript/CSS; these pages have separate HTTP behavior.
const INDEX_HTML: &str = include_str!("../../../plugin/ui/index.html");
const OVERLAY_HTML: &str = include_str!("../../../plugin/ui/overlay.html");

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
        "celestial-sky.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/celestial-sky.jpg"),
    ),
    (
        "morning-01.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/morning-01.jpg"),
    ),
    (
        "morning-09.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/morning-09.jpg"),
    ),
    (
        "morning-14.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/morning-14.jpg"),
    ),
    (
        "afternoon-19.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/afternoon-19.jpg"),
    ),
    (
        "afternoon-07.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/afternoon-07.jpg"),
    ),
    (
        "afternoon-20.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/afternoon-20.jpg"),
    ),
    (
        "evening-12.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/evening-12.jpg"),
    ),
    (
        "evening-16.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/evening-16.jpg"),
    ),
    (
        "evening-18.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/evening-18.jpg"),
    ),
    (
        "night-02.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/night-02.jpg"),
    ),
    (
        "night-08.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/night-08.jpg"),
    ),
    (
        "night-12.jpg",
        include_bytes!("../../../plugin/ui/wallpapers/night-12.jpg"),
    ),
];

/// 在线音源平台徽标：官方 app 图标 PNG（256×256 统一规格），由前端
/// online.js 的 SOURCE_BADGE 按音源 id 取用。与壁纸同为二进制资源，走
/// `include_bytes!` 内嵌，单 exe 分发不依赖外部文件。
const PLATFORM_ICONS: &[(&str, &[u8])] = &[
    (
        "netease.png",
        include_bytes!("../../../plugin/ui/platform-icons/netease.png"),
    ),
    (
        "qq.png",
        include_bytes!("../../../plugin/ui/platform-icons/qq.png"),
    ),
    (
        "kugou.png",
        include_bytes!("../../../plugin/ui/platform-icons/kugou.png"),
    ),
    (
        "kuwo.png",
        include_bytes!("../../../plugin/ui/platform-icons/kuwo.png"),
    ),
    (
        "qishui.png",
        include_bytes!("../../../plugin/ui/platform-icons/qishui.png"),
    ),
];

const HTML: &str = "text/html; charset=utf-8";

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

    // 改名前的数据目录叫 mmusic-studio；必须在任何读写路径碰到目录之前搬完，
    // 否则 prepare 会先把新目录建成空库。
    config::migrate_legacy_data_dir();
    let data_dir = args.data_dir.unwrap_or_else(config::default_data_dir);
    let boot_config = bootstrap::prepare(&data_dir).await?;
    init_logging(&boot_config.log.level, &boot_config.log.format);

    // The token is the only thing standing between a local web page and full
    // control of playback, so it is generated once and kept with 0600 perms.
    let token = load_or_create_token(&data_dir).await?;
    // 浮层那把钥匙权限窄得多（只读浮层与封面），所以可以出现在要粘进 OBS 的
    // URL 里；token 不行。见 load_or_create_overlay_key 的注释。
    let overlay_key = load_or_create_overlay_key(&data_dir).await?;

    // `booted` 必须活到 main 结束：它持有音频 actor 的线程句柄。
    let booted = bootstrap::boot(data_dir, boot_config, token.clone(), overlay_key).await?;
    let state = booted.state.clone();
    let config = &booted.config;

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .merge(routes::router(state.clone()))
        .merge(ui_asset_router())
        .route("/wallpapers/{name}", get(wallpaper))
        .route("/platform-icons/{name}", get(platform_icon))
        .route(
            "/",
            get({
                let state = state.clone();
                move |headers: axum::http::HeaderMap, uri: axum::http::Uri| {
                    index(state.clone(), headers, uri)
                }
            }),
        )
        // 用长期令牌换会话 cookie：那一页「没有凭据」上的表单打到这里。令牌走
        // 请求体，不进 URL 历史；校验通过才发 HttpOnly cookie。
        .route(
            "/v1/auth/session",
            post({
                let state = state.clone();
                move |body: axum::Json<SessionRequest>| create_session(state.clone(), body)
            }),
        )
        // OBS 浮层页：静态壳不走鉴权（没有数据），数据端点 /v1/overlay/lyric
        // 自带 token 校验，页面从 ?token= 读。与 index 同款 no-cache。
        .route("/overlay", get(|| asset(HTML, OVERLAY_HTML)))
        // 带内容指纹的 JS/CSS 升级成长缓存；其余（含 /v1 接口）不受影响。
        .layer(axum::middleware::from_fn(asset_cache))
        .with_state(state.clone());

    let bind = args.bind.unwrap_or_else(|| config.server.bind.clone());
    let port = args.port.unwrap_or(config.server.port);
    let listener = tokio::net::TcpListener::bind((bind.as_str(), port)).await?;
    let local = listener.local_addr()?;
    let actual_port = local.port();

    let discovery = state::write_discovery(&state, actual_port).await?;
    // 打印的地址按**实际绑定**的接口来（绑 0.0.0.0 时回落到 127.0.0.1，那是本机
    // 访问的正确入口；绑具体网卡时给那个地址，否则用户会照着 127.0.0.1 去别的机器上试）。
    let shown = if local.ip().is_unspecified() {
        std::net::IpAddr::from([127, 0, 0, 1])
    } else {
        local.ip()
    };
    // 打印/打开的入口带**一次性票据**，不是长期 token：这条 URL 会进浏览器历史、
    // 终端 scrollback、日志与聊天记录。票 TTL 两分钟、只能用一次；换完这次首跳，
    // 浏览器拿到的是会话 cookie，之后的刷新与书签都不需要凭据出现在地址里。
    let entry = state.issue_entry_ticket();
    let url = format!("http://{}/?ticket={}", host_port(shown, actual_port), entry);
    tracing::info!("listening on {bind}:{actual_port}");
    println!("hertz-studio v{}", env!("CARGO_PKG_VERSION"));
    if let Some(warning) = exposure_warning(local.ip(), actual_port) {
        eprintln!("{warning}");
        tracing::warn!("{warning}");
    }
    println!("  ui       {url}");
    println!(
        "  health   http://{}/v1/health",
        host_port(shown, actual_port)
    );
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

/// Routes derive directly from the embedded registry; new assets need one entry.
fn ui_asset_router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    let mut router = Router::new();
    for entry in assets::UI_ASSETS {
        router = router.route(entry.path, get(move || asset(entry.mime, entry.body)));
    }
    router
}

/// 全部内嵌 JS/CSS 的内容指纹（进程内算一次）。
///
/// `asset()` 只能发 no-cache（内嵌资源没有 Last-Modified/ETag 可协商），于是
/// 每次打开页面都要把整套前端重下一遍。这里给内容算一个短指纹，渲染 index.html
/// 时拼进每个 JS/CSS 的 URL；`asset_cache` 中间件见到 URL 带的指纹与当前一致，
/// 就把响应升级成 immutable 长缓存。内容一改指纹就变、URL 跟着变，所以不会出现
/// 「前端修了 bug 用户拿不到」。
///
/// 用 FNV-1a：这里只要「内容变则值变」，没有对抗构造的需求，为算个缓存键引入
/// 密码学哈希不值当。
fn assets_fingerprint() -> &'static str {
    static FINGERPRINT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    FINGERPRINT.get_or_init(|| hash_inputs(assets::ASSET_FINGERPRINT_INPUTS))
}

/// FNV-1a over the given bodies, as 16 hex digits.
fn hash_inputs(inputs: &[&str]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for body in inputs {
        // 先混入长度，否则 ["ab","c"] 会与 ["a","bc"] 撞成同一个值。
        hash ^= body.len() as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        for byte in body.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

/// 只给同源、以 `.js`/`.css` 结尾的相对引用加指纹。
///
/// `href="data:,"`（空图标）是内联数据，`href="#i-play"` 是页面内锚点，
/// 都不是资源 —— 给它们加查询串只会弄坏。
fn is_versionable_asset(value: &str) -> bool {
    !value.contains("://")
        && !value.starts_with('#')
        && !value.starts_with("data:")
        && (value.ends_with(".js") || value.ends_with(".css"))
}

/// 把 index.html 里相对的 JS/CSS 引用改写成带 `?v=<指纹>` 的 URL。
///
/// 放在服务端而非手写进 index.html：指纹要运行时才算得出来；六十多处引用手抄
/// 一遍既容易漏，也会和 check-assets.js 第 3 节（引用必须精确等于路由 path）
/// 打架。
fn version_asset_urls(html: &str) -> String {
    let version = assets_fingerprint();
    let mut out = String::with_capacity(html.len() + 128);
    let mut rest = html;
    while let Some((idx, attr)) = ["href=\"", "src=\""]
        .iter()
        .filter_map(|attr| rest.find(attr).map(|i| (i, *attr)))
        .min_by_key(|(i, _)| *i)
    {
        let value_start = idx + attr.len();
        let Some(value_end) = rest[value_start..].find('"') else {
            break;
        };
        let value = &rest[value_start..value_start + value_end];
        out.push_str(&rest[..value_start]);
        out.push_str(value);
        if is_versionable_asset(value) {
            out.push_str("?v=");
            out.push_str(version);
        }
        out.push('"');
        rest = &rest[value_start + value_end + 1..];
    }
    out.push_str(rest);
    out
}

/// 查询串里某个参数的值。不做 percent-decode：这里只用来比对十六进制指纹，
/// 与 routes.rs 的 `query_token` 同一取舍。
fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then_some(v)
    })
}

/// 带正确内容指纹的 JS/CSS 响应升级为长缓存。
///
/// 只认「查询串里的 v 与当前指纹相等」这一种情况，且只作用于 JS/CSS 响应 ——
/// 免得某个恰好带 `v` 参数的接口响应被缓存一年。
async fn asset_cache(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let versioned = request
        .uri()
        .query()
        .and_then(|query| query_param(query, "v"))
        .map(|v| v == assets_fingerprint())
        .unwrap_or(false);
    let mut response = next.run(request).await;
    let is_asset = response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.starts_with("application/javascript") || value.starts_with("text/css")
        });
    if versioned && is_asset {
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    response
}

/// Placeholder in `web/index.html` that receives the session token.
///
/// It must differ from the JS variable name written next to it: replacing the
/// variable name too leaves `window.__VMUSIC_TOKEN__` undefined, and every
/// request then leaves with an empty token.
const TOKEN_PLACEHOLDER: &str = "__VMUSIC_TOKEN_VALUE__";

fn render_index(html: &str, token: &str) -> String {
    version_asset_urls(&html.replace(TOKEN_PLACEHOLDER, token))
}

/// 会话 cookie 名。`/` 认它，**接口层不认**（接口仍然要 Bearer）。
///
/// 这个分工是刻意的：cookie 只能换来「首页那份 HTML」，换不来任何写操作 —— 于是
/// 刷新与书签继续可用，而 CSRF 面没有变化（本项目没有 CORS 层，跨站表单也带不上
/// 这个 SameSite=Strict 的 cookie）。
const SESSION_COOKIE: &str = "vmusic_session";

fn session_cookie(token: &str) -> String {
    format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000")
}

/// 取 `Cookie:` 头里某个名字的值。
fn cookie_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key.trim() == name).then(|| value.trim().to_string())
    })
}

/// `/` 的凭据判定（纯函数，便于钉住行为）。
///
/// 为什么首页要凭据：`/` 原先无条件把长期 token 注进 HTML，而这条路由**不走鉴权**
/// —— 本机任何进程（绑了非回环地址时还包括同网段的人）GET 一下首页就拿到了能控制
/// 播放、读曲库、改设置的令牌。现在令牌只发给「已经出示凭据」的请求。
///
/// 判定顺序即优先级：请求头里的长期 token（前端 fetch 走这条，导航请求带不了头）
/// → 会话 cookie（刷新/书签）→ 查询串（首跳的一次性票据，以及兼容期的长期 token）。
/// 票据走 `redeem` 而不是存在性检查：它自带次数与 TTL，兑一次少一次，这条 URL 被
/// 复制出去时泄露面只剩「TTL 内剩下的那几次」。
fn credential_ok(
    token: &str,
    headers: &axum::http::HeaderMap,
    query: Option<&str>,
    redeem: impl Fn(&str) -> bool,
) -> bool {
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            headers
                .get("x-vmusic-token")
                .and_then(|value| value.to_str().ok())
        });
    presented == Some(token)
        || cookie_value(headers, SESSION_COOKIE).as_deref() == Some(token)
        || query
            .and_then(|query| query_param(query, "ticket"))
            .is_some_and(&redeem)
        || query.and_then(|query| query_param(query, "token")) == Some(token)
}

/// 首跳没凭据时给的页面。自包含（无外链），并给一条自救路径：把令牌交上来换
/// 会话 cookie —— 清了 cookie、换了浏览器、或者手敲了裸地址的用户会遇到这一页。
const NO_CREDENTIAL_HTML: &str = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>hertz-studio · 需要凭据</title>
<style>
body{background:#09090b;color:#f4f4f5;font:14px/1.6 system-ui,-apple-system,sans-serif;margin:0;
  display:flex;align-items:center;justify-content:center;min-height:100vh}
main{max-width:34rem;padding:24px;border:1px solid #27272a;border-radius:14px;background:#111113}
h1{font-size:16px;margin:0 0 12px}
p{color:#a1a1aa;margin:0 0 12px}
code{color:#e4e4e7;background:#18181b;padding:2px 6px;border-radius:6px}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #3f3f46;
  background:#18181b;color:#f4f4f5;font-family:ui-monospace,monospace;font-size:12px}
button{margin-top:12px;padding:10px 16px;border-radius:8px;border:0;background:#f4f4f5;color:#09090b;
  font-weight:600;cursor:pointer}
#err{color:#f87171;margin-top:12px;min-height:20px}
</style></head>
<body><main>
<h1>这份页面没有凭据</h1>
<p>服务只在出示凭据时把令牌写进页面 —— 否则本机任何进程打开首页就能拿到它。</p>
<p>正常情况下启动时打印的那条地址已经带了一次性票据，直接用那条打开即可。也可以把令牌粘进来：
它在启动日志的 <code>discovery</code> 文件里，或数据目录的 <code>token</code> 文件里。</p>
<form id="f"><input id="t" placeholder="粘贴服务令牌" autocomplete="off" spellcheck="false">
<button type="submit">继续</button></form>
<p id="err"></p>
</main><script>
document.getElementById('f').addEventListener('submit', async function (event) {
  event.preventDefault();
  var err = document.getElementById('err');
  err.textContent = '';
  try {
    var res = await fetch('/v1/auth/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: document.getElementById('t').value.trim() })
    });
    if (!res.ok) { err.textContent = '令牌不对，或服务重启过（令牌每次启动都会换）。'; return; }
    location.reload();
  } catch (e) { err.textContent = '取不到服务：' + e; }
});
</script></body></html>
"#;

#[derive(serde::Deserialize)]
struct SessionRequest {
    token: String,
}

/// 用长期令牌换会话 cookie。令牌走**请求体**，不进 URL 历史、不进 OBS 配置。
async fn create_session(
    state: Arc<AppState>,
    axum::Json(body): axum::Json<SessionRequest>,
) -> axum::response::Response {
    if body.token != state.token {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            [(
                axum::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )],
            "token mismatch",
        )
            .into_response();
    }
    let mut response = axum::http::StatusCode::NO_CONTENT.into_response();
    if let Ok(value) = axum::http::HeaderValue::from_str(&session_cookie(&state.token)) {
        response
            .headers_mut()
            .insert(axum::http::header::SET_COOKIE, value);
    }
    response
}

async fn index(
    state: Arc<AppState>,
    headers: axum::http::HeaderMap,
    uri: axum::http::Uri,
) -> axum::response::Response {
    if !credential_ok(&state.token, &headers, uri.query(), |id| {
        state.redeem_ticket(id)
    }) {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            [
                (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (axum::http::header::CACHE_CONTROL, "no-cache"),
            ],
            NO_CREDENTIAL_HTML,
        )
            .into_response();
    }
    let mut response = (
        [
            (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        render_index(INDEX_HTML, &state.token),
    )
        .into_response();
    if let Ok(value) = axum::http::HeaderValue::from_str(&session_cookie(&state.token)) {
        response
            .headers_mut()
            .insert(axum::http::header::SET_COOKIE, value);
    }
    response
}

/// 内嵌资源的统一出口。
///
/// 每个文件不再有独立的 `serve_*`：以前加一层视觉效果要动 4 个地方（const、
/// 一个 handler、一条 route、以及那份复制粘贴的 header 拼装），漏一处就是
/// 404 或 MIME 不对导致浏览器拒绝执行。现在只剩 const 一行 + route 一行。
///
/// 默认必须带 `Cache-Control: no-cache`：内嵌资源没有 Last-Modified/ETag 可供
/// 协商，浏览器启发式缓存会把几天前的旧 JS/CSS 一直端出来，前端修了 bug
/// 用户也拿不到（歌单视图在线分区就栽过这个）。本机回源代价可忽略。
///
/// 唯一的例外是 `asset_cache`：index.html 渲染时会给引用挂上 `?v=<内容指纹>`，
/// 那种 URL 已经随内容变化，中间件把响应升级成 immutable。裸路径（没有指纹）
/// 仍走这里的 no-cache。
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
    load_or_create_secret(&data_dir.join("token")).await
}

/// 浮层只读钥匙：给 OBS 那条 URL 用的凭据。
///
/// 为什么不是长期 token：OBS 会把浏览器源的 URL 长期留在自己的配置里，而长期
/// token 能控制播放、读曲库、改设置 —— 粘出去一次就等于把整台服务交出去。这把
/// 钥匙的权限被收窄到「GET + 浮层歌词 + 曲目封面」（见 routes.rs 的
/// `overlay_key_allows`），且**独立于 token**：真泄露了只需删掉这个文件重启，
/// 不必换 token（换 token 会踢掉所有已连上的客户端）。
async fn load_or_create_overlay_key(data_dir: &std::path::Path) -> anyhow::Result<String> {
    load_or_create_secret(&data_dir.join("overlay-key")).await
}

/// 读一个长期凭据文件，没有就生成一个（两个 `Uuid::simple()` 拼成，256 位）。
async fn load_or_create_secret(path: &std::path::Path) -> anyhow::Result<String> {
    if let Ok(existing) = tokio::fs::read_to_string(path).await {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    tokio::fs::write(path, &secret).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(secret)
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
        "hertz-studio — hertz-studio service\n\n\
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

/// `ip:port`，IPv6 要加方括号（否则 `http://::1:8080/` 不是合法 URL）。
fn host_port(ip: std::net::IpAddr, port: u16) -> String {
    if ip.is_ipv6() {
        format!("[{ip}]:{port}")
    } else {
        format!("{ip}:{port}")
    }
}

/// 绑到非回环接口时要打的警告；回环返回 None。
///
/// 为什么必须提示：这套服务的唯一凭据是一个**长期** token（也存在数据目录的
/// `token` 文件里），而 `?token=` 只对 GET 开口（`<img src>` 加不了请求头）。
/// 绑到 0.0.0.0/局域网网卡之后，同一网段里任何能访问到端口的人都读得到曲库、
/// 播放历史与设置——而用户往往只是随手把 bind 改成 0.0.0.0 图个「别的机器也能开」，
/// 不该在毫不知情的情况下把整个库交出去。这里不阻止（自托管就是要能这么跑），
/// 但日志和终端都要有一行明确的提醒。
fn exposure_warning(ip: std::net::IpAddr, port: u16) -> Option<String> {
    if ip.is_loopback() {
        return None;
    }
    Some(format!(
        "警告：服务绑定在 {}，已超出本机回环。\n  \
         它用一个长期 token 鉴权，同网段/公网内任何人访问到这个端口都能读你的曲库、播放历史与设置。\n  \
         只在本机用请改用 --bind 127.0.0.1；确实要对外提供访问，请放到反向代理 + TLS + 额外鉴权之后。",
        host_port(ip, port)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn registered_ui_assets_are_served_with_their_own_content() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, ui_asset_router::<()>())
                .await
                .unwrap();
        });
        let client = reqwest::Client::new();
        let mut paths = std::collections::HashSet::new();
        for entry in assets::UI_ASSETS {
            assert!(
                paths.insert(entry.path),
                "duplicate resource {}",
                entry.path
            );
            let response = client
                .get(format!("http://{addr}{}", entry.path))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200, "{}", entry.path);
            assert_eq!(response.headers()["content-type"], entry.mime);
            assert_eq!(response.headers()["cache-control"], "no-cache");
            assert_eq!(response.text().await.unwrap(), entry.body, "{}", entry.path);
        }
        assert_eq!(
            client
                .get(format!("http://{addr}/not-registered.js"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        server.abort();
    }

    #[test]
    fn every_registered_asset_affects_the_cache_fingerprint() {
        let original = hash_inputs(assets::ASSET_FINGERPRINT_INPUTS);
        assert_eq!(
            assets::UI_ASSETS.len(),
            assets::ASSET_FINGERPRINT_INPUTS.len()
        );
        for (i, entry) in assets::UI_ASSETS.iter().enumerate() {
            assert_eq!(assets::ASSET_FINGERPRINT_INPUTS[i], entry.body);
            let mut changed = assets::ASSET_FINGERPRINT_INPUTS.to_vec();
            changed[i] = "changed resource content";
            assert_ne!(hash_inputs(&changed), original, "{}", entry.path);
        }
    }
    use std::net::{IpAddr, Ipv6Addr};

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

    /// 回环绑定不该打扰用户——否则每次本机启动都弹一行「警告」，噪音会把真正
    /// 需要注意的那条（非回环）淹掉。
    #[test]
    fn loopback_binds_do_not_warn() {
        assert!(exposure_warning(IpAddr::from([127, 0, 0, 1]), 8080).is_none());
        assert!(exposure_warning(IpAddr::V6(Ipv6Addr::LOCALHOST), 8080).is_none());
    }

    /// 非回环必须告警，且告警里要带上用户真正需要的两个信息：地址与回环之外的
    /// 具体后果。
    #[test]
    fn exposed_binds_warn_with_the_address() {
        for ip in [
            IpAddr::from([0, 0, 0, 0]),
            IpAddr::from([192, 168, 1, 5]),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
        ] {
            let warning = exposure_warning(ip, 7899).expect("非回环必须告警");
            assert!(warning.contains("警告"), "{}", warning);
            assert!(warning.contains("7899"), "告警要带端口：{}", warning);
            assert!(
                warning.contains("127.0.0.1"),
                "要给可操作的替代方案：{}",
                warning
            );
        }
    }

    /// IPv6 要加方括号，否则打印出来的地址点不开。
    #[test]
    fn host_port_brackets_ipv6() {
        assert_eq!(
            host_port(IpAddr::from([127, 0, 0, 1]), 8080),
            "127.0.0.1:8080"
        );
        assert_eq!(
            host_port(IpAddr::V6(Ipv6Addr::LOCALHOST), 8080),
            "[::1]:8080"
        );
    }

    /// 相对引用的 JS/CSS 要带指纹；内联数据、页面锚点、外链必须原样不动
    /// ——给 `data:,` 加个查询串会把空图标弄坏。
    #[test]
    fn version_asset_urls_only_touches_relative_js_and_css() {
        let html = "<link rel=\"icon\" href=\"data:,\">\
                    <link rel=\"stylesheet\" href=\"style.css\">\
                    <use href=\"#i-play\">\
                    <script defer src=\"app.js\"></script>\
                    <script src=\"https://cdn.example.com/x.js\"></script>";
        let fp = assets_fingerprint();
        let expected = format!(
            "<link rel=\"icon\" href=\"data:,\">\
             <link rel=\"stylesheet\" href=\"style.css?v={fp}\">\
             <use href=\"#i-play\">\
             <script defer src=\"app.js?v={fp}\"></script>\
             <script src=\"https://cdn.example.com/x.js\"></script>"
        );

        assert_eq!(fp.len(), 16, "指纹应是 16 位十六进制：{fp}");
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(version_asset_urls(html), expected);
    }

    /// 指纹必须只依赖内容：同内容两次一致（缓存才有意义），内容一变就不同
    /// （否则改了前端用户拿不到）。
    #[test]
    fn fingerprint_is_content_addressed() {
        assert_eq!(assets_fingerprint(), assets_fingerprint());
        assert_ne!(hash_inputs(&["a", "b"]), hash_inputs(&["ab"]));
        assert_ne!(hash_inputs(&["x"]), hash_inputs(&["y"]));
    }

    /// `/` 的凭据闸门：四条信道任一条对上就放行，一条都没对上（或对错了值）必须拒。
    ///
    /// 这条是收紧的核心——它一旦松了，`/` 就又变成「谁都能拿到长期令牌」。
    #[test]
    fn index_credential_gate_opens_only_for_a_matching_credential() {
        const TOKEN: &str = "abc123";
        let mut headers = axum::http::HeaderMap::new();
        assert!(
            !credential_ok(TOKEN, &headers, None, |_| false),
            "裸请求必须被拒"
        );

        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer abc123".parse().unwrap(),
        );
        assert!(credential_ok(TOKEN, &headers, None, |_| false));
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer abc124".parse().unwrap(),
        );
        assert!(
            !credential_ok(TOKEN, &headers, None, |_| false),
            "前缀对但值不对不算"
        );
        headers.remove(axum::http::header::AUTHORIZATION);

        headers.insert("x-vmusic-token", "abc123".parse().unwrap());
        assert!(credential_ok(TOKEN, &headers, None, |_| false));
        headers.remove("x-vmusic-token");

        headers.insert(
            axum::http::header::COOKIE,
            "a=1; vmusic_session=abc123; b=2".parse().unwrap(),
        );
        assert!(
            credential_ok(TOKEN, &headers, None, |_| false),
            "cookie 夹在别的键里也要取得到"
        );
        headers.insert(
            axum::http::header::COOKIE,
            "vmusic_session=abc124".parse().unwrap(),
        );
        assert!(!credential_ok(TOKEN, &headers, None, |_| false));
        headers.remove(axum::http::header::COOKIE);

        // 票据走 redeem：票据表说成立才成立，光有 `?ticket=` 这个参数不算数。
        assert!(credential_ok(TOKEN, &headers, Some("ticket=t1"), |id| id == "t1"));
        assert!(!credential_ok(TOKEN, &headers, Some("ticket=t1"), |_| {
            false
        }));
        // 兼容期的长期令牌仍认，但同样要比对值。
        assert!(credential_ok(TOKEN, &headers, Some("token=abc123"), |_| {
            false
        }));
        assert!(!credential_ok(
            TOKEN,
            &headers,
            Some("token=abc124"),
            |_| false
        ));
    }

    /// 会话 cookie 的签发与回读要成对：属性少一个（HttpOnly / SameSite），
    /// 这个能换首页的凭据就会被脚本读到、或被跨站请求带上。
    #[test]
    fn session_cookie_carries_hardened_attributes_and_reads_back() {
        let header = session_cookie("tok-123");
        assert!(header.starts_with("vmusic_session=tok-123;"), "{header}");
        for attribute in ["HttpOnly", "SameSite=Strict", "Path=/"] {
            assert!(header.contains(attribute), "缺 {attribute}：{header}");
        }

        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            header.split(';').next().unwrap().parse().unwrap(),
        );
        assert_eq!(
            cookie_value(&headers, SESSION_COOKIE).as_deref(),
            Some("tok-123")
        );
        assert_eq!(cookie_value(&headers, "other"), None);
    }
}
