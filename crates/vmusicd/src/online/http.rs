// SPDX-License-Identifier: MIT

//! 平台 HTTP 客户端公共件：UA、带 cookie 的请求构造、JSON 容错解析。

use std::collections::BTreeMap;

use reqwest::header::{HeaderMap, HeaderValue, COOKIE};
use reqwest::Client;

use crate::error::{ApiError, ApiResult};

/// 为一次调用构造请求头（cookie/referer 均可选）。
pub fn headers(cookie: Option<&str>, referer: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    if let Some(c) = cookie.filter(|c| !c.trim().is_empty()) {
        if let Ok(v) = HeaderValue::from_str(c) {
            h.insert(COOKIE, v);
        } else {
            // 只记录事实，绝不打印 cookie 值本身。
            tracing::debug!(
                source_cookie_invalid = true,
                "在线音源 cookie 含非法请求头字符，已跳过 Cookie 头"
            );
        }
    }
    if let Some(r) = referer {
        if let Ok(v) = HeaderValue::from_str(r) {
            h.insert(reqwest::header::REFERER, v);
        }
    }
    h
}

/// 把错误文本里 URL 的 query 段抹掉。
///
/// reqwest 的错误 Display 会带 `error sending request for url (<完整 URL>)`，
/// 而 QQ vkey / 酷狗签名直链的 query 里是签名参数与 guid，不该进日志或回前端。
/// 注意 query 里合法地可能出现裸 `)`：reqwest 的包裹形态是 `(URL)`，闭合
/// 括号是整段（到下一个空白为止）里最后一个 ')'，据此保留它及其后的标点；
/// query 内部的裸 ')' 概率极低，按安全方向随 query 一并脱敏。
pub(crate) fn redact_qs(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        // b'?' 是纯 ASCII，不可能出现在 UTF-8 多字节序列内部，按字节定位安全。
        let q = match bytes[i..].iter().position(|&b| b == b'?') {
            None => {
                out.push_str(&text[i..]);
                break;
            }
            Some(rel) => i + rel,
        };
        out.push_str(&text[i..=q]);
        let mut j = q + 1;
        while j < bytes.len() && !matches!(bytes[j], b' ' | b'\t' | b'\r' | b'\n') {
            j += 1;
        }
        // 段内最后一个 ')' 视为 reqwest 包裹 URL 的闭合括号；它及其后的
        // 标点（如 ': message' 的冒号）保留，其余整段脱敏。
        let close = bytes[q + 1..j].iter().rposition(|&b| b == b')');
        match close {
            Some(rel) => {
                if q + 1 + rel > q + 1 {
                    out.push_str("<redacted>");
                }
                out.push_str(&text[q + 1 + rel..j]);
            }
            None if j > q + 1 => out.push_str("<redacted>"),
            None => {}
        }
        i = j;
    }
    out
}

/// send 阶段的错误分类：超时 → 504，其余（连接被拒、DNS、TLS 等）→ 502。
/// 错误文本里的 URL query 先脱敏（签名参数不外泄）。
pub(crate) fn send_error(e: reqwest::Error) -> ApiError {
    if e.is_timeout() {
        ApiError::upstream_timeout(redact_qs(&format!("连接音源超时: {e}")))
    } else {
        ApiError::upstream_rejected(redact_qs(&format!("连接音源失败: {e}")))
    }
}

/// 非 2xx 响应片段：截前 200 字符，且对其中 URL query 脱敏（扫码类接口的
/// 响应体里可能出现带一次性凭据的 URL）。
fn error_snippet(bytes: &[u8]) -> String {
    let raw: String = String::from_utf8_lossy(bytes).chars().take(200).collect();
    redact_qs(&raw)
}

/// 文本/字节类响应的体积上限：二维码 PNG 通常几 KB，2MiB 足够且防止异常上游
/// 把超大响应体灌进内存（音频流不走这里，直链是交给前端播放的）。
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

/// 发 GET 请求并解析 JSON；非 2xx 或非 JSON 统一成结构化错误。
///
/// 先拿状态码和原始字节、再判状态码、最后解析 JSON：原来先 `.json()` 后判
/// 状态，上游回 403/500 的 HTML 错误页时用户只能看到一句「不是 JSON」，
/// 真正的状态码和响应片段全丢了。
pub async fn get_json(
    client: &Client,
    url: &str,
    headers: HeaderMap,
) -> ApiResult<serde_json::Value> {
    let resp = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(send_error)?;
    read_json(resp).await
}

/// 发 GET 请求，解析 JSON **并保留响应头**。
///
/// 扫码登录的会话凭据只在 `Set-Cookie` 里（网易云确认扫码时下发 MUSIC_U），
/// 走 [`get_json`] 会把它们整罐丢掉。除多返回一个 HeaderMap 外，错误分类
/// 与 [`get_json`] 完全一致。
pub async fn get_json_with_headers(
    client: &Client,
    url: &str,
    headers: HeaderMap,
) -> ApiResult<(HeaderMap, serde_json::Value)> {
    let resp = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(send_error)?;
    let status = resp.status();
    // 响应头先拷出来：resp 随后被 bytes() 消费掉。
    let resp_headers = resp.headers().clone();
    let bytes = resp.bytes().await.map_err(read_error)?;
    Ok((resp_headers, decode_json(status, &bytes)?))
}

/// 发 POST 请求并解析 JSON。Content-Type 由调用方在 headers 里给出
/// （不同平台要 `application/json` 或 `application/json;charset=UTF-8`），
/// 公共件不替调用方强塞；错误分类与 [`get_json`] 一致。
pub async fn post_json(
    client: &Client,
    url: &str,
    headers: HeaderMap,
    body: String,
) -> ApiResult<serde_json::Value> {
    let resp = client
        .post(url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(send_error)?;
    read_json(resp).await
}

/// 发 POST 请求，解析 JSON **并保留响应头**。
///
/// 与 [`get_json_with_headers`] 对称：扫码登录确认时上游把会话凭据放在
/// `Set-Cookie` 里（汽水确认扫码后下发 sessionid/sid_guard），走 [`post_json`]
/// 会把整罐 cookie 丢掉。
pub async fn post_json_with_headers(
    client: &Client,
    url: &str,
    headers: HeaderMap,
    body: String,
) -> ApiResult<(HeaderMap, serde_json::Value)> {
    let resp = client
        .post(url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(send_error)?;
    let status = resp.status();
    // 响应头先拷出来：resp 随后被 bytes() 消费掉。
    let resp_headers = resp.headers().clone();
    let bytes = resp.bytes().await.map_err(read_error)?;
    Ok((resp_headers, decode_json(status, &bytes)?))
}

/// 读取响应体的错误分类：超时 → 504，其余 → 502。
pub(crate) fn read_error(e: reqwest::Error) -> ApiError {
    if e.is_timeout() {
        ApiError::upstream_timeout(redact_qs(&format!("读取音源响应超时: {e}")))
    } else {
        ApiError::upstream_rejected(redact_qs(&format!("读取音源响应失败: {e}")))
    }
}

/// 判状态码 → 解析 JSON 的后半段，GET / POST / 带响应头的 GET 共用，保证
/// 三条通道的错误分类完全一致：非 2xx 带状态码与前 200 字符片段；非 JSON → 502。
fn decode_json(status: reqwest::StatusCode, bytes: &[u8]) -> ApiResult<serde_json::Value> {
    if !status.is_success() {
        // 错误页可能是 HTML/纯文本，截前 200 字符足够排障，也避免把整页回显。
        let snippet = error_snippet(bytes);
        return Err(ApiError::upstream_rejected(format!(
            "音源返回 HTTP {status}，响应片段: {snippet}"
        )));
    }
    serde_json::from_slice::<serde_json::Value>(bytes)
        .map_err(|e| ApiError::upstream_rejected(format!("音源响应不是 JSON: {e}")))
}

/// 取字节后交给 [`decode_json`]（GET/POST 共用）。
async fn read_json(resp: reqwest::Response) -> ApiResult<serde_json::Value> {
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(read_error)?;
    decode_json(status, &bytes)
}

/// GET 纯文本：QQ 经典 fcgi 网关部分接口回 JSONP（`callback({...})`），
/// 扫码状态回的是 JS 片段，都得先拿原文再由平台模块自己解析。
pub async fn get_text(client: &Client, url: &str, headers: HeaderMap) -> ApiResult<String> {
    let resp = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(send_error)?;
    read_text(resp).await
}

/// POST 纯文本：表单写操作（QQ 删除歌单）回 JSONP，同样需要原文。
pub async fn post_text(
    client: &Client,
    url: &str,
    headers: HeaderMap,
    body: String,
) -> ApiResult<String> {
    let resp = client
        .post(url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(send_error)?;
    read_text(resp).await
}

/// GET 原始字节 + 响应头：扫码二维码是 PNG（要校验文件头），且会话票
/// （qrsig）只在 Set-Cookie 里，JSON 助手会丢掉这两样。
pub async fn get_bytes(
    client: &Client,
    url: &str,
    headers: HeaderMap,
) -> ApiResult<(reqwest::header::HeaderMap, Vec<u8>)> {
    let resp = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(send_error)?;
    let status = resp.status();
    let resp_headers = resp.headers().clone();
    let bytes = resp.bytes().await.map_err(read_error)?;
    if !status.is_success() {
        let snippet = error_snippet(&bytes);
        return Err(ApiError::upstream_rejected(format!(
            "音源返回 HTTP {status}，响应片段: {snippet}"
        )));
    }
    if bytes.len() > MAX_TEXT_BYTES {
        let len = bytes.len();
        return Err(ApiError::upstream_rejected(format!(
            "音源响应体积超过上限（{len} 字节 > 2MiB）"
        )));
    }
    Ok((resp_headers, bytes.to_vec()))
}

async fn read_text(resp: reqwest::Response) -> ApiResult<String> {
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(read_error)?;
    if !status.is_success() {
        let snippet = error_snippet(&bytes);
        return Err(ApiError::upstream_rejected(format!(
            "音源返回 HTTP {status}，响应片段: {snippet}"
        )));
    }
    // 上游历史接口编码混杂（个别 JSONP 是 GB2312）；非 UTF-8 用 lossy
    // 替换，结构仍能解析，中文乱码只影响展示不影响 code 判定。
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

// ---------------------------------------------------------------------------
// cookie 罐
// ---------------------------------------------------------------------------
//
// 扫码登录的会话凭据只走 `Set-Cookie`，而一次握手要跨「创建 → 轮询」两次
// 请求：创建期上游种的 csrf/设备标识必须回传到轮询请求上，轮询时才下发的
// 会话凭据又要与创建期的合并成完整会话。三个平台的取法完全一样，所以这四
// 个函数放在公共件里，平台模块只负责决定「什么时候取、取到之后判什么态」。

/// 把响应头里的 `Set-Cookie` 收进 cookie 罐（同名后写覆盖）。
///
/// 只看每条的 `name=value`，属性（Path/Max-Age/Domain…）一律丢掉：回传时
/// 拼成一个 Cookie 请求头就够了，属性跟着走没有意义。
/// 空值项也丢弃——上游用空值表示删除 cookie，收进来会造出 `MUSIC_U=` 这类
/// 「看起来有、其实失效」的假登录态。
pub(crate) fn absorb_cookies(
    headers: &reqwest::header::HeaderMap,
    jar: &mut BTreeMap<String, String>,
) {
    for raw in headers
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
    {
        if let Some(pair) = raw.split(';').next() {
            if let Some((k, v)) = pair.split_once('=') {
                let (k, v) = (k.trim(), v.trim());
                if !k.is_empty() && !v.is_empty() {
                    jar.insert(k.to_string(), v.to_string());
                }
            }
        }
    }
}

/// cookie 表拼回请求头形态的串（`a=1; b=2`）。
pub(crate) fn cookie_string(jar: &BTreeMap<String, String>) -> String {
    jar.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// 把一串 cookie 解析成表；空名/空值项丢弃（理由同 [`absorb_cookies`]）。
pub(crate) fn parse_cookie(cookie: &str) -> BTreeMap<String, String> {
    let mut jar = BTreeMap::new();
    for part in cookie.split(';') {
        if let Some((k, v)) = part.split_once('=') {
            let (k, v) = (k.trim(), v.trim());
            if !k.is_empty() && !v.is_empty() {
                jar.insert(k.to_string(), v.to_string());
            }
        }
    }
    jar
}

/// 合并两罐 cookie：`base` 为底，`incoming` 同名覆盖。
///
/// 轮询只回传创建期的设备标识，确认时上游才下发会话凭据，两边合起来才是
/// 完整会话——少任何一边都会出现「手机已确认、登录态却判不出来」。
pub(crate) fn merge_cookie(base: &str, incoming: &str) -> String {
    let mut jar = parse_cookie(base);
    let fresh = parse_cookie(incoming);
    for (k, v) in fresh {
        jar.insert(k, v);
    }
    cookie_string(&jar)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_cookie_keeps_base_and_lets_fresh_pair_win() {
        // 创建期只有设备标识，确认期才下发会话凭据，两边必须都在。
        let merged = merge_cookie("did=1; csrf=old", "csrf=new; sessionid=s1");
        let jar = parse_cookie(&merged);
        assert_eq!(jar.get("did").map(String::as_str), Some("1"));
        assert_eq!(jar.get("csrf").map(String::as_str), Some("new"));
        assert_eq!(jar.get("sessionid").map(String::as_str), Some("s1"));
    }

    #[test]
    fn empty_values_are_dropped_so_no_fake_login_state() {
        // 上游用空值删 cookie；收进来会造出「看起来有凭据」的假登录态。
        let jar = parse_cookie("MUSIC_U=; did=1");
        assert!(!jar.contains_key("MUSIC_U"));
        assert_eq!(jar.get("did").map(String::as_str), Some("1"));
    }

    #[test]
    fn redact_strips_query_inside_reqwest_parens() {
        let s = "error sending request for url (https://h/p?a=secret&b=2): boom";
        assert_eq!(
            redact_qs(s),
            "error sending request for url (https://h/p?<redacted>): boom"
        );
    }

    #[test]
    fn redact_keeps_trailing_paren_but_eats_ones_inside_query() {
        // query 里的裸 ')' 是合法字符，不能让它提前结束脱敏；
        // 只有紧贴段末的闭合 ')' 保留。
        let s = "(https://h/p?cb=x(y))";
        assert_eq!(redact_qs(s), "(https://h/p?<redacted>)");
    }

    #[test]
    fn redact_handles_multiple_urls_and_empty_query() {
        let s = "u1=https://a/p?tok=1 then u2=https://b/next?z=2";
        let out = redact_qs(s);
        assert!(!out.contains("tok=1") && !out.contains("z=2"));
        // 空 query 不产出标记，普通文本原样返回。
        assert_eq!(redact_qs("no query here"), "no query here");
        assert_eq!(redact_qs("https://h/p?"), "https://h/p?");
    }
}
