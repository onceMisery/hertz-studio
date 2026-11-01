// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸媒体资源的 WebView2 拦截层（设计 docs/desktop-wallpaper.md §8.1）。
//!
//! 保留域 `https://<hash前32位>.<hash后32位>.wallpaper.invalid/files/<path>`
//! 由 `WebResourceRequested` 在本机拦截，不做 DNS 请求。处理链：
//! URL 解析（hash = 两段 32hex 拼合）→ 包核验（verify_installed：original
//! 哈希 + 投影尺寸抽查）→ Range 语义（media_stream::plan_response）→
//! `MediaIStream` 窗口流（agile，浏览器读线程自取字节）→
//! `CreateWebResourceResponse` + `SetResponse`。
//!
//! 线程决策：处理器在 WebView2 UI 线程同步执行——只做 URL 解析、收据读取
//! （小 JSON）与 CreateFile（µs 级），无阻塞媒体 I/O；字节流经 agile IStream
//! 由浏览器读线程异步消费，故不需要 GetDeferral 分派（§8.1 的 deferral 要求
//! 针对「重活进播放路径」，此处按构造排除；重校验已在安装时完成）。会话级
//! 授权绑定（§8.1 controller/session/generation 准入）属 P1-04，当前阶段先
//! 服务已核验包。

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use super::assets::AssetStore;
use super::istream::MediaIStream;
use super::media_stream::{parse_range_header, plan_response};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2_2, ICoreWebView2Environment,
    ICoreWebView2WebResourceRequest, ICoreWebView2WebResourceRequestedEventArgs,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
};
use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
use windows::core::{HSTRING, Interface, PWSTR};

/// 保留域后缀（§8.1）。
const RESERVED_HOST_SUFFIX: &str = ".wallpaper.invalid";
/// 壁纸/设置页 origin 白名单（wry 把自定义协议映射到 hertz.localhost）。
const ALLOWED_ORIGINS: [&str; 2] = ["http://hertz.localhost", "https://hertz.localhost"];

/// 从 URI 解析出的媒体资源定位。
struct MediaUrl {
    package_hash: String,
    /// 包投影内的相对路径（files/ 前缀已剥离）。
    path: String,
}

impl MediaUrl {
    /// 三态解析：非本域 → NotOurDomain（passthrough）；本域但路径/身份不合法 →
    /// BadPath（404）；合法 → Ok（§8.1 + C51）。
    fn parse(uri: &str) -> MediaUrlParse {
        let (scheme, rest) = match uri.split_once("://") {
            Some(parts) => parts,
            None => return MediaUrlParse::NotOurDomain,
        };
        if !scheme.eq_ignore_ascii_case("https") {
            return MediaUrlParse::NotOurDomain;
        }
        let (host, path) = match rest.split_once('/') {
            Some(parts) => parts,
            None => return MediaUrlParse::NotOurDomain,
        };
        let host = host.split(':').next().unwrap_or(host);
        if !host.to_ascii_lowercase().ends_with(RESERVED_HOST_SUFFIX) {
            return MediaUrlParse::NotOurDomain;
        }
        let labels = host
            .strip_suffix(RESERVED_HOST_SUFFIX)
            .unwrap_or(host)
            .split('.')
            .collect::<Vec<_>>();
        if labels.len() != 2 {
            return MediaUrlParse::BadPath;
        }
        let hash = labels.concat().to_ascii_lowercase();
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return MediaUrlParse::BadPath;
        }
        // 只服务已索引投影；original.hwpkg 与 receipt.json 不暴露（§4.2）。
        match path.strip_prefix("files/") {
            Some(rel) if !rel.is_empty() => {
                MediaUrlParse::Ok(Self { package_hash: hash, path: rel.to_string() })
            }
            _ => MediaUrlParse::BadPath,
        }
    }
}

enum MediaUrlParse {
    Ok(MediaUrl),
    /// 本域但身份/路径不合法 → 404。
    BadPath,
    /// 非本域 → passthrough。
    NotOurDomain,
}

static ASSETS: OnceLock<Option<Arc<AssetStore>>> = OnceLock::new();

/// 全局 AssetStore：首次调用时创建 + 启动恢复（同步包装 current_thread 运行时）。
/// 失败缓存 None（不反复重试坏目录），后续 install 直接跳过。
fn global_assets() -> Option<&'static Arc<AssetStore>> {
    ASSETS
        .get_or_init(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()
                .and_then(|runtime| {
                    runtime.block_on(async {
                        let base = crate::config::base_dir();
                        let library = super::library::Library::open(&base).await.ok()?;
                        let assets = AssetStore::new(&base).ok()?;
                        super::jobs::reconcile_startup(&library, &assets).await.ok()?;
                        Some(Arc::new(assets))
                    })
                })
        })
        .as_ref()
}

/// 在 WebView 上安装媒体拦截。每个 WebView 调一次；重复注册会造成双重响应。
pub(crate) fn install(webview: &wry::WebView) -> Result<(), String> {
    let Some(assets) = global_assets() else {
        return Ok(()); // AssetStore 不可用：不注册拦截，.invalid 请求将自然失败
    };
    let assets = Arc::clone(assets);
    use wry::WebViewExtWindows;
    let controller = webview.controller();
    let core: ICoreWebView2 = unsafe { controller.CoreWebView2() }
        .map_err(|error| format!("取 CoreWebView2 失败：{error}"))?;
    let environment = unsafe {
        core.cast::<ICoreWebView2_2>()
            .map_err(|error| format!("取 ICoreWebView2_2 失败：{error}"))?
            .Environment()
            .map_err(|error| format!("取 Environment 失败：{error}"))?
    };

    let filter = HSTRING::from(format!("https://*{RESERVED_HOST_SUFFIX}/*"));
    unsafe {
        core.AddWebResourceRequestedFilter(
            &filter,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        )
        .map_err(|error| format!("注册媒体过滤器失败：{error}"))?;
    }

    let mut token = 0i64;
    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        handle_request(&args, &environment, &assets);
        Ok(())
    }));
    unsafe {
        core.add_WebResourceRequested(&handler, &mut token)
            .map_err(|error| format!("注册媒体拦截失败：{error}"))?;
    }
    Ok(())
}

/// 单次请求的处置结果。
enum Outcome {
    /// 已组装完整响应（含无体错误响应）。
    Resolved {
        status: i32,
        reason: &'static str,
        headers: String,
        path: Option<PathBuf>,
        window: (u64, u64),
    },
    /// 非本域请求：不置响应，放行给网络栈。
    Passthrough,
}

fn handle_request(
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    environment: &ICoreWebView2Environment,
    assets: &Arc<AssetStore>,
) {
    let outcome = resolve(args, assets);
    let result = match &outcome {
        Outcome::Passthrough => Ok(()),
        Outcome::Resolved {
            status,
            reason,
            headers,
            path,
            window,
        } => {
            let stream = match path
                .as_deref()
                .map(|path| MediaIStream::open(path, assets.stream_pool(), *window))
            {
                Some(Ok(stream)) => Some(stream),
                Some(Err(error)) => {
                    crate::app::log(&format!("wallpaper media stream open failed: {error}"));
                    None
                }
                None => None,
            };
            unsafe {
                environment
                    .CreateWebResourceResponse(
                        stream.as_ref(),
                        *status,
                        &HSTRING::from(*reason),
                        &HSTRING::from(headers.as_str()),
                    )
                    .and_then(|response| args.SetResponse(&response))
            }
        }
    };
    if let Err(error) = result {
        crate::app::log(&format!("wallpaper media response failed: {error}"));
    }
}

fn resolve(
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    assets: &Arc<AssetStore>,
) -> Outcome {
    let request = match unsafe { args.Request() } {
        Ok(request) => request,
        Err(_) => return passthrough(),
    };
    let uri = match unsafe { string_property(&request, |request, out| request.Uri(out)) } {
        Ok(uri) => uri,
        Err(_) => return passthrough(),
    };
    // Origin/Range 先于域匹配提取：本域 404 也需要 CORS 头（否则 fetch
    // 只能拿到 TypeError 而非确定性的 404）。
    let origin = unsafe {
        request_header(&request, "Origin")
    };
    let cors = origin.filter(|origin| ALLOWED_ORIGINS.contains(&origin.as_str()));
    let range = unsafe {
        request_header(&request, "Range")
    };

    // 域匹配分两层：非本域 → passthrough；本域但路径不合法 → 404（不放给
    // DNS，否则 .invalid 会报 TypeError 而非确定性的 404）。
    let media = match MediaUrl::parse(&uri) {
        MediaUrlParse::NotOurDomain => return passthrough(),
        MediaUrlParse::Ok(media) => media,
        MediaUrlParse::BadPath => return not_found(cors),
    };
    let method = unsafe {
        string_property(&request, |request, out| request.Method(out))
    }
    .unwrap_or_default();

    if method.eq_ignore_ascii_case("OPTIONS") {
        return Outcome::Resolved {
            status: 204,
            reason: "No Content",
            headers: cors_headers(cors, true),
            path: None,
            window: (0, 0),
        };
    }
    if !matches!(method.as_str(), "GET" | "HEAD") {
        return Outcome::Resolved {
            status: 405,
            reason: "Method Not Allowed",
            headers: cors_headers(cors, false),
            path: None,
            window: (0, 0),
        };
    }
    let head = method.eq_ignore_ascii_case("HEAD");

    // 包核验：original 哈希 + 投影抽查（§7.2 快速检查；重校验在安装时）。
    let Ok(Some(receipt)) = assets.verify_installed(&media.package_hash) else {
        return not_found(cors);
    };
    let Some(entry) = receipt.entries.iter().find(|entry| entry.path == media.path)
    else {
        return not_found(cors);
    };

    let range_request = parse_range_header(range.as_deref(), entry.bytes);
    let plan = plan_response(head, range_request, entry.bytes);

    let mime = entry
        .mime
        .clone()
        .unwrap_or_else(|| "application/octet-stream".into());
    let mut headers = format!("Content-Type: {mime}\r\nContent-Length: {}\r\n", plan.content_length);
    if let Some(content_range) = &plan.content_range {
        headers.push_str(&format!("Content-Range: {content_range}\r\n"));
    }
    headers.push_str(&cors_headers(cors, false));

    // 流窗口：200 → 全文件；206 → range 片段；HEAD/416/400 → 无体。
    let (path, window) = if plan.body && plan.content_length > 0 {
        let base = if plan.status == 206 {
            plan.content_range
                .as_deref()
                .and_then(|rest| rest.strip_prefix("bytes "))
                .and_then(|rest| rest.split_once('-'))
                .and_then(|(start, _)| start.parse::<u64>().ok())
                .unwrap_or(0)
        } else {
            0
        };
        let path = assets
            .package_dir(&media.package_hash)
            .join("files")
            .join(&media.path);
        (Some(path), (base, plan.content_length))
    } else {
        (None, (0, 0))
    };

    Outcome::Resolved {
        status: i32::from(plan.status),
        reason: reason_phrase(i32::from(plan.status)),
        headers,
        path,
        window,
    }
}

fn passthrough() -> Outcome {
    Outcome::Passthrough
}

fn not_found(cors: Option<String>) -> Outcome {
    Outcome::Resolved {
        status: 404,
        reason: "Not Found",
        headers: cors_headers(cors, false),
        path: None,
        window: (0, 0),
    }
}

fn cors_headers(origin: Option<String>, preflight: bool) -> String {
    let mut headers = String::new();
    if let Some(origin) = origin {
        headers.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\n"));
        headers.push_str("Vary: Origin\r\n");
        // Content-Range 不在 CORS safelist：不加 Expose-Headers 则 fetch 读不到。
        headers.push_str("Access-Control-Expose-Headers: Content-Range\r\n");
    }
    if preflight {
        headers.push_str("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
        headers.push_str("Access-Control-Allow-Headers: Range\r\n");
        headers.push_str("Access-Control-Max-Age: 600\r\n");
    }
    headers
}

fn reason_phrase(status: i32) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        _ => "OK",
    }
}

/// 从请求读一个字符串属性（Uri/Method）。
unsafe fn string_property(
    request: &ICoreWebView2WebResourceRequest,
    read: impl Fn(&ICoreWebView2WebResourceRequest, *mut PWSTR) -> windows::core::Result<()>,
) -> windows::core::Result<String> {
    let mut pwstr = PWSTR::null();
    read(request, &mut pwstr)?;
    Ok(take_pwstr(pwstr))
}

/// 读单个请求头；缺失（HRESULT 错误）返回 None。
unsafe fn request_header(
    request: &ICoreWebView2WebResourceRequest,
    name: &str,
) -> Option<String> {
    let headers = request.Headers().ok()?;
    let mut value = PWSTR::null();
    headers
        .GetHeader(&HSTRING::from(name), &mut value)
        .ok()?;
    Some(take_pwstr(value))
}
