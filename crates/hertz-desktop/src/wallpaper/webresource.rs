// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸媒体资源的 WebView2 拦截层（设计 docs/desktop-wallpaper.md §8.1）。
//!
//! 保留域 `https://<hash前32位>.<hash后32位>.wallpaper.invalid/files/<path>`
//! 由 `WebResourceRequested` 在本机拦截，不做 DNS 请求。处理链：
//! URL 解析（hash = 两段 32hex 拼合）→ 包及投影哈希核验 → Range 语义 →
//! `MediaIStream` 窗口流（agile，浏览器读线程自取字节）→
//! `CreateWebResourceResponse` + `SetResponse`。
//!
//! UI 线程只提取有界请求并取得 GetDeferral；单个有界 worker 负责启动恢复、
//! 验证及文件打开，再通过宿主事件回 UI 组装响应并完成 deferral。媒体字节由
//! agile IStream 在浏览器读线程消费。controller 销毁时撤销待处理请求。
//! 每个 controller 只服务当前原生准入集合；集合默认空，换代立即撤销旧请求、
//! 核验缓存与流。媒体选择的 TargetPlanner 接线属 P1-05。

use crate::app::UserEvent;
use crate::native_events::EventLoopProxy;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use super::access::{MediaAccess, ReadPermit};
use super::assets::AssetStore;
use super::istream::MediaIStream;
use super::media_stream::{global_pool, parse_range_header, plan_response, MediaFileStream};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Deferral, ICoreWebView2Environment,
    ICoreWebView2WebResourceRequest, ICoreWebView2WebResourceRequestedEventArgs, ICoreWebView2_2,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
};
use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
use windows::core::{Interface, HSTRING, PWSTR};

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
        let host = host.to_ascii_lowercase();
        if !host.ends_with(RESERVED_HOST_SUFFIX) {
            return MediaUrlParse::NotOurDomain;
        }
        let labels = host
            .strip_suffix(RESERVED_HOST_SUFFIX)
            .unwrap_or(&host)
            .split('.')
            .collect::<Vec<_>>();
        if labels.len() != 2 || labels.iter().any(|label| label.len() != 32) {
            return MediaUrlParse::BadPath;
        }
        let hash = labels.concat().to_ascii_lowercase();
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return MediaUrlParse::BadPath;
        }
        // 只服务已索引投影；original.hwpkg 与 receipt.json 不暴露（§4.2）。
        match path.strip_prefix("files/") {
            Some(rel) if hertz_wallpaper::validate_rel_path(rel).is_ok() => {
                MediaUrlParse::Ok(Self {
                    package_hash: hash,
                    path: rel.to_string(),
                })
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
                        super::jobs::reconcile_startup(&library, &assets)
                            .await
                            .ok()?;
                        Some(Arc::new(assets))
                    })
                })
        })
        .as_ref()
}

/// 在 WebView 上安装媒体拦截。每个 WebView 调一次；重复注册会造成双重响应。
pub(crate) fn install(
    webview: &wry::WebView,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<MediaAccess, String> {
    install_with_access(webview,proxy,MediaAccess::new())
}

pub(crate) fn install_with_access(webview:&wry::WebView,proxy:EventLoopProxy<UserEvent>,access:MediaAccess) -> Result<MediaAccess,String> {
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
        core.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
            .map_err(|error| format!("注册媒体过滤器失败：{error}"))?;
    }

    let mut token = 0i64;
    let lifetime = ControllerRequests {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        alive: Arc::new(AtomicBool::new(true)),
        access: access.clone(),
    };
    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        handle_request(&args, &environment, &proxy, &lifetime);
        Ok(())
    }));
    unsafe {
        core.add_WebResourceRequested(&handler, &mut token)
            .map_err(|error| format!("注册媒体拦截失败：{error}"))?;
    }
    Ok(access)
}

/// 单次请求的处置结果。
enum Outcome {
    /// 已组装完整响应（含无体错误响应）。
    Resolved {
        status: i32,
        headers: String,
        path: Option<PathBuf>,
        window: (u64, u64),
    },
    /// 非本域请求：不置响应，放行给网络栈。
    Passthrough,
}

// COM 对象只在 UI 线程保留，后台仅接收纯数据和可发送的文件句柄。
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const MAX_PENDING: usize = 8;
struct Pending {
    controller: u64,
    args: ICoreWebView2WebResourceRequestedEventArgs,
    environment: ICoreWebView2Environment,
    deferral: ICoreWebView2Deferral,
    cors: Option<String>,
}
thread_local! {
    static PENDING: RefCell<HashMap<u64, Pending>> = RefCell::new(HashMap::new());
}
struct ControllerRequests {
    id: u64,
    alive: Arc<AtomicBool>,
    access: MediaAccess,
}
impl Drop for ControllerRequests {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
        self.access.revoke();
        let cancelled = PENDING.with(|pending| {
            let mut pending = pending.borrow_mut();
            let ids: Vec<_> = pending
                .iter()
                .filter(|(_, request)| request.controller == self.id)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id))
                .collect::<Vec<_>>()
        });
        for request in cancelled {
            let _ = unsafe { request.deferral.Complete() };
        }
    }
}

struct Work {
    id: u64,
    controller: u64,
    alive: Arc<AtomicBool>,
    uri: String,
    method: String,
    cors: Option<String>,
    range: Option<String>,
    proxy: EventLoopProxy<UserEvent>,
    permit: ReadPermit,
}

struct CachedMedia {
    controller: u64,
    hash: String,
    path: String,
    alive: Arc<AtomicBool>,
    media: Arc<super::assets::PinnedMedia>,
    permit: ReadPermit,
}

pub(crate) struct PreparedResponse {
    outcome: Outcome,
    stream: Option<MediaFileStream>,
    permit: Option<ReadPermit>,
}

fn worker() -> Option<&'static std::sync::mpsc::SyncSender<Work>> {
    static WORKER: OnceLock<Option<std::sync::mpsc::SyncSender<Work>>> = OnceLock::new();
    WORKER
        .get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::sync_channel::<Work>(MAX_PENDING);
            std::thread::Builder::new()
                .name("hertz-wallpaper-media".into())
                .spawn(move || {
                    let mut cache = VecDeque::<CachedMedia>::new();
                    loop {
                        // 不在 controller 关闭后永久保留核验句柄；在途 I/O 退出后清理。
                        cache.retain(|entry| {
                            entry.alive.load(Ordering::Relaxed) && entry.permit.is_active()
                        });
                        super::istream::reap_revoked_streams();
                        let work = match rx.recv_timeout(std::time::Duration::from_millis(250)) {
                            Ok(work) => work,
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                            Err(_) => break,
                        };
                        if !work.alive.load(Ordering::Relaxed) || !work.permit.is_active() {
                            let _ = work.proxy.send_event(UserEvent::WallpaperMedia(
                                work.id,
                                Box::new(PreparedResponse {
                                    outcome: error_response(404, work.cors),
                                    stream: None,
                                    permit: None,
                                }),
                            ));
                            continue;
                        }
                        let mut outcome = resolve(&work, &mut cache);
                        let stream = match &outcome {
                            Outcome::Resolved {
                                path: Some(path), ..
                            } => match MediaFileStream::open(path, global_pool()) {
                                Ok(stream) => Some(stream),
                                Err(error) => {
                                    outcome = error_response(
                                        if error.code == "stream_busy" {
                                            503
                                        } else {
                                            404
                                        },
                                        work.cors,
                                    );
                                    None
                                }
                            },
                            _ => None,
                        };
                        let _ = work.proxy.send_event(UserEvent::WallpaperMedia(
                            work.id,
                            Box::new(PreparedResponse {
                                outcome,
                                stream,
                                permit: Some(work.permit),
                            }),
                        ));
                    }
                })
                .ok()?;
            Some(tx)
        })
        .as_ref()
}

fn handle_request(
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    environment: &ICoreWebView2Environment,
    proxy: &EventLoopProxy<UserEvent>,
    controller: &ControllerRequests,
) {
    let Ok(request) = (unsafe { args.Request() }) else {
        return;
    };
    let Ok(uri) = (unsafe { string_property(&request, |request, out| request.Uri(out)) }) else {
        return;
    };
    if matches!(MediaUrl::parse(&uri), MediaUrlParse::NotOurDomain) {
        return;
    }
    let cors = unsafe { request_header(&request, "Origin") }
        .filter(|origin| ALLOWED_ORIGINS.contains(&origin.as_str()));
    let method = unsafe { string_property(&request, |request, out| request.Method(out)) }
        .unwrap_or_default();
    let range = unsafe { request_header(&request, "Range") };
    if uri.len() > 1024 || range.as_ref().is_some_and(|range| range.len() > 256) {
        respond(
            args,
            environment,
            PreparedResponse {
                outcome: error_response(400, cors),
                stream: None,
                permit: None,
            },
        );
        return;
    }
    // 授权在任何库初始化/磁盘读取前完成，OPTIONS 同样不能探测未准入资源。
    let permit = match MediaUrl::parse(&uri) {
        MediaUrlParse::Ok(media) => controller.access.permit(&media.package_hash, &media.path),
        _ => None,
    };
    let Some(permit) = permit else {
        respond(
            args,
            environment,
            PreparedResponse {
                outcome: error_response(404, cors),
                stream: None,
                permit: None,
            },
        );
        return;
    };
    // 预检只回答已准入资源的 CORS 合同，不能触发库恢复或任何文件打开。
    if method.eq_ignore_ascii_case("OPTIONS") {
        respond(
            args,
            environment,
            PreparedResponse {
                outcome: Outcome::Resolved {
                    status: 204,
                    headers: cors_headers(cors, true),
                    path: None,
                    window: (0, 0),
                },
                stream: None,
                permit: None,
            },
        );
        return;
    }
    if !matches!(method.as_str(), "GET" | "HEAD") {
        respond(
            args,
            environment,
            PreparedResponse {
                outcome: error_response(405, cors),
                stream: None,
                permit: None,
            },
        );
        return;
    }
    if PENDING.with(|pending| pending.borrow().len() >= MAX_PENDING) {
        respond(
            args,
            environment,
            PreparedResponse {
                outcome: error_response(503, cors),
                stream: None,
                permit: None,
            },
        );
        return;
    }
    let Ok(deferral) = (unsafe { args.GetDeferral() }) else {
        respond(
            args,
            environment,
            PreparedResponse {
                outcome: error_response(503, cors),
                stream: None,
                permit: None,
            },
        );
        return;
    };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    PENDING.with(|pending| {
        pending.borrow_mut().insert(
            id,
            Pending {
                controller: controller.id,
                args: args.clone(),
                environment: environment.clone(),
                deferral,
                cors: cors.clone(),
            },
        )
    });
    let work = Work {
        id,
        controller: controller.id,
        alive: Arc::clone(&controller.alive),
        uri,
        method,
        cors: cors.clone(),
        range,
        proxy: proxy.clone(),
        permit,
    };
    if !worker().is_some_and(|tx| tx.try_send(work).is_ok()) {
        complete(
            id,
            PreparedResponse {
                outcome: error_response(503, cors),
                stream: None,
                permit: None,
            },
        );
    }
}

pub(crate) fn complete(id: u64, mut response: PreparedResponse) {
    let pending = PENDING.with(|pending| pending.borrow_mut().remove(&id));
    if let Some(pending) = pending {
        if response
            .permit
            .as_ref()
            .is_some_and(|permit| !permit.is_active())
        {
            response = PreparedResponse {
                outcome: error_response(404, pending.cors),
                stream: None,
                permit: None,
            };
        }
        respond(&pending.args, &pending.environment, response);
        let _ = unsafe { pending.deferral.Complete() };
    }
    // controller 已退出时 response 随栈释放，文件与流槽不会遗留。
}

fn respond(
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    environment: &ICoreWebView2Environment,
    response: PreparedResponse,
) {
    let Outcome::Resolved {
        mut status,
        mut headers,
        path,
        window,
    } = response.outcome
    else {
        return;
    };
    let payload = response.permit.as_ref().and_then(ReadPermit::payload).cloned();
    let stream = if let Some(payload) = payload.filter(|_| window.1 > 0) {
        response.permit.and_then(|permit| MediaIStream::from_payload(payload, permit, global_pool()).ok())
    } else { response.stream.and_then(|stream| {
        MediaIStream::from_file_with_permit(
            stream,
            path.unwrap_or_default(),
            global_pool(),
            window,
            response.permit,
        )
        .ok()
    }) };
    if path_is_required(status, window) && stream.is_none() {
        status = 503;
        // 不得用成功的 Content-Length 宣告一个空响应体。
        headers = "Content-Length: 0\r\n".into();
    }
    let result = unsafe {
        environment
            .CreateWebResourceResponse(
                stream.as_ref(),
                status,
                &HSTRING::from(reason_phrase(status)),
                &HSTRING::from(headers),
            )
            .and_then(|response| args.SetResponse(&response))
    };
    if let Err(error) = result {
        crate::app::log(&format!("wallpaper media response failed: {error}"));
    }
}

fn path_is_required(status: i32, window: (u64, u64)) -> bool {
    matches!(status, 200 | 206) && window.1 > 0
}

fn error_response(status: i32, cors: Option<String>) -> Outcome {
    Outcome::Resolved {
        status,
        headers: format!("Content-Length: 0\r\n{}", cors_headers(cors, false)),
        path: None,
        window: (0, 0),
    }
}

fn resolve(work: &Work, cache: &mut VecDeque<CachedMedia>) -> Outcome {
    let (uri, method, cors, range) = (
        work.uri.as_str(),
        work.method.as_str(),
        work.cors.clone(),
        work.range.as_deref(),
    );
    // 域匹配分两层：非本域 → passthrough；本域但路径不合法 → 404（不放给
    // DNS，否则 .invalid 会报 TypeError 而非确定性的 404）。
    let media = match MediaUrl::parse(uri) {
        MediaUrlParse::NotOurDomain => return passthrough(),
        MediaUrlParse::Ok(media) => media,
        MediaUrlParse::BadPath => return not_found(cors),
    };
    let head = method.eq_ignore_ascii_case("HEAD");
    if let Some(payload) = work.permit.payload() {
        if range.is_some() { return error_response(400,cors); }
        return Outcome::Resolved { status:200,
            headers:format!("Content-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n{}",payload.len(),cors_headers(cors,false)),
            path:None, window:(0,if head {0} else {payload.len() as u64}) };
    }

    // 每个 controller 的不可变字节只核验一次，seek 不反复哈希大视频。
    // 缓存全局最多 4 项（8 个核验句柄），关闭 controller 或 LRU 淘汰时释放。
    let cached = cache.iter().position(|entry| {
        entry.controller == work.controller
            && entry.permit.generation == work.permit.generation
            && entry.hash == media.package_hash
            && entry.path == media.path
    });
    let entry = if let Some(index) = cached {
        cache.remove(index).expect("cached media index")
    } else {
        if cache.len() >= 4 {
            cache.pop_front();
        }
        let pinned = if let Some(pinned) = work.permit.pinned() {
            Arc::clone(pinned)
        } else {
            let Some(assets) = global_assets() else {
                return error_response(503, cors);
            };
            let Ok(Some(pinned)) = assets.pin_verified_media(&media.package_hash, &media.path)
            else {
                return not_found(cors);
            };
            Arc::new(pinned)
        };
        CachedMedia {
            controller: work.controller,
            hash: media.package_hash.clone(),
            path: media.path.clone(),
            alive: Arc::clone(&work.alive),
            media: pinned,
            permit: work.permit.clone(),
        }
    };
    cache.push_back(entry);
    let entry = &cache.back().expect("cached media").media.entry;

    let range_request = parse_range_header(range, entry.bytes);
    let plan = plan_response(head, range_request, entry.bytes);

    let mime = entry
        .mime
        .clone()
        .unwrap_or_else(|| "application/octet-stream".into());
    let mut headers = format!("Content-Type: {mime}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nX-Content-Type-Options: nosniff\r\n", plan.content_length);
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
        let path = cache.back().expect("cached media").media.path.clone();
        (Some(path), (base, plan.content_length))
    } else {
        (None, (0, 0))
    };

    Outcome::Resolved {
        status: i32::from(plan.status),

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

        headers: cors_headers(cors, false),
        path: None,
        window: (0, 0),
    }
}

fn cors_headers(origin: Option<String>, preflight: bool) -> String {
    let mut headers = "Cache-Control: no-store\r\n".to_string();
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
        503 => "Service Unavailable",
        _ => "OK",
    }
}

/// 已安装包内文件的保留域 URL（native→页面的媒体投影用，§8.1）。
/// hash 必须 64 位十六进制（大小写不敏感，落 URL 前规范化为小写）；path 为
/// 包内相对路径，沿用安装期的小写 ASCII 字符集（§6.3），不在此做百分号编码。
/// 生产调用方随 P1-05 的 selection 接线进入；当前由测试与冒烟钉住合同。
#[allow(dead_code)]
pub(crate) fn files_url(package_hash: &str, path: &str) -> Option<String> {
    let hash = package_hash.to_ascii_lowercase();
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let path_ok = hertz_wallpaper::validate_rel_path(path).is_ok();
    if !path_ok {
        return None;
    }
    Some(format!(
        "https://{}.{}{RESERVED_HOST_SUFFIX}/files/{}",
        &hash[..32],
        &hash[32..],
        path
    ))
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
unsafe fn request_header(request: &ICoreWebView2WebResourceRequest, name: &str) -> Option<String> {
    let headers = request.Headers().ok()?;
    let mut value = PWSTR::null();
    headers.GetHeader(&HSTRING::from(name), &mut value).ok()?;
    Some(take_pwstr(value))
}

#[cfg(test)]
mod tests {
    use super::{files_url, MediaUrl, MediaUrlParse};

    const HASH: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e";

    #[test]
    fn builds_split_label_reserved_domain() {
        let url = files_url(HASH, "assets/background.png").expect("合法 hash+path 必须出 URL");
        assert_eq!(
            url,
            format!(
                "https://{}.{}.wallpaper.invalid/files/assets/background.png",
                &HASH[..32],
                &HASH[32..]
            )
        );
    }

    #[test]
    fn normalizes_uppercase_hash() {
        let upper = HASH.to_ascii_uppercase();
        let url = files_url(&upper, "assets/bg.png").expect("大写 hash 规范化为小写");
        assert!(
            url.starts_with("https://a1b2c3d4"),
            "URL host 必须小写：{url}"
        );
    }

    #[test]
    fn round_trips_through_media_url_parse() {
        let url = files_url(HASH, "assets/background.png").expect("合法输入");
        match MediaUrl::parse(&url) {
            MediaUrlParse::Ok(parsed) => {
                assert_eq!(parsed.package_hash, HASH);
                assert_eq!(parsed.path, "assets/background.png");
            }
            _ => panic!("构造出的 URL 必须能被同层解析接受"),
        }
    }

    #[test]
    fn rejects_bad_hash() {
        assert!(files_url("a1", "assets/bg.png").is_none(), "长度不足");
        assert!(
            files_url(&"g".repeat(64), "assets/bg.png").is_none(),
            "非十六进制"
        );
    }

    #[test]
    fn rejects_bad_path() {
        assert!(files_url(HASH, "").is_none(), "空路径");
        assert!(files_url(HASH, "assets\\bg.png").is_none(), "反斜杠");
        assert!(files_url(HASH, "assets/../bg.png").is_none(), "点段");
        assert!(files_url(HASH, "assets//bg.png").is_none(), "空段");
        assert!(
            files_url(HASH, "assets/白.png").is_none(),
            "非小写 ASCII 字符集"
        );
        assert!(files_url(HASH, "/assets/bg.png").is_none(), "空首段");
    }
}
