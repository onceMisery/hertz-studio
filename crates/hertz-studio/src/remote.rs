// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 远程来源（WebDAV / HTTP 直链）。
//!
//! 浏览走 PROPFIND Depth:1 + Basic auth；播放是真正的 HTTP 直链：
//! [`HttpRangeStream`] 实现 symphonia `MediaSource` 要求的
//! `Read + Seek + Send + Sync`，按 Range 请求按需取字节，不落盘、
//! 不起缓存线程。断网/鉴权失败以错误上抛，界面如实提示后可重试。
//!
//! XML 解析是刻意宽松的手写实现：WebDAV 服务器的命名空间五花八门
//! （`D:` / `d:` / 裸元素），全部按「标签本地名」匹配，不追求通用
//! XML 合规。

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;

/// 一个远程目录条目。
#[derive(Debug, Clone, Serialize)]
pub struct RemoteEntry {
    /// 相对根 URL 的解码路径（以 `/` 开头，目录以 `/` 结尾）。
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub mtime: Option<String>,
}

/// Basic auth 凭据（来自钥匙串）。
#[derive(Debug, Clone)]
pub struct BasicAuth {
    pub username: String,
    pub password: String,
}

/// PROPFIND 返回体 → 条目列表。返回 None 表示响应不像 207 多状态
/// （例如误配到了普通网页），调用方据此报「不是 WebDAV 目录」。
pub fn parse_propfind(body: &str, base_path: &str) -> Option<Vec<RemoteEntry>> {
    let lower = body.to_ascii_lowercase();
    if !lower.contains("multistatus") {
        return None;
    }
    let mut out = Vec::new();
    for segment in split_responses(&lower, body) {
        let Some(href) = extract_tag_value(segment, "href") else {
            continue;
        };
        let display_name = extract_tag_value(segment, "displayname");
        let segment_lower = segment.to_ascii_lowercase();
        let is_dir = segment_lower.contains("collection");
        let size = extract_tag_value(segment, "getcontentlength")
            .and_then(|v| v.trim().parse::<u64>().ok());
        let mtime = extract_tag_value(segment, "getlastmodified");

        let path = percent_decode(&href);
        // 跳过集合自身（PROPFIND Depth:1 会把请求目录本身也列出来）。
        if norm_path(&path) == norm_path(base_path) {
            continue;
        }
        let name = display_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| {
                path.trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .unwrap_or(&path)
                    .to_string()
            });
        // 目录判定：collection 标记优先，路径以 / 结尾兜底。
        let is_dir = is_dir || path.ends_with('/');
        out.push(RemoteEntry {
            path,
            name,
            is_dir,
            size,
            mtime,
        });
    }
    Some(out)
}

/// 按多状态块切分：每个本地名为 `response` 的元素，从其开标签内 `>` 之后
/// 到闭标签 `<` 之前的原文。lower 是 body 的小写副本，扫描用。
fn split_responses<'a>(lower: &str, body: &'a str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Some(rel) = lower[i..].find('<') {
        let open_abs = i + rel;
        let Some(gt) = lower[open_abs..].find('>') else {
            break;
        };
        let tag_end = open_abs + gt;
        let tag = &lower[open_abs + 1..tag_end]; // 形如 "d:response" / "response"
        let tag = tag.strip_suffix('/').unwrap_or(tag).trim();
        let local = tag.split(':').next_back().unwrap_or("").trim();
        let is_open = !tag.starts_with('/') && !tag.ends_with('?');
        if local != "response" || !is_open {
            i = tag_end + 1;
            continue;
        }
        // 找匹配的闭标签：中间可能有任意嵌套（propstat/prop/...），逐个
        // 标签扫，直到遇到本地名同为 response 的闭标签。
        let mut cursor = tag_end + 1;
        let mut close_abs = None;
        while cursor < lower.len() {
            let Some(lt) = lower[cursor..].find('<') else {
                break;
            };
            let open = cursor + lt;
            let Some(gt) = lower[open..].find('>') else {
                break;
            };
            let tag_close = &lower[open + 1..open + gt];
            let tag_close = tag_close.trim();
            let tag_local = tag_close
                .trim_start_matches('/')
                .split(':')
                .next_back()
                .unwrap_or("")
                .trim();
            let is_closing = tag_close.starts_with('/');
            if tag_local == "response" && is_closing {
                close_abs = Some(open);
                break;
            }
            cursor = open + gt + 1;
        }
        let Some(close_abs) = close_abs else {
            break;
        };
        // 值提取按标签匹配，切片多带一两个字符无害。
        let end = (close_abs + 2).min(body.len());
        out.push(&body[tag_end + 1..end]);
        i = close_abs + 2;
    }
    out
}

/// 在一段 XML 里取第一个本地名为 `name` 的元素文本值（大小写不敏感）。
fn extract_tag_value(segment: &str, name: &str) -> Option<String> {
    let lower = segment.to_ascii_lowercase();
    let mut i = 0usize;
    while let Some(rel) = lower[i..].find('<') {
        let abs = i + rel;
        let Some(gt) = lower[abs..].find('>') else {
            break;
        };
        let end = abs + gt;
        let tag = &lower[abs + 1..end];
        let tag = tag.strip_suffix('/').unwrap_or(tag).trim();
        let local = tag.split(':').next_back().unwrap_or("").trim();
        if local == name && !tag.starts_with('/') {
            let value_end = segment[end + 1..]
                .find('<')
                .map(|p| end + 1 + p)
                .unwrap_or(segment.len());
            let value = segment[end + 1..value_end].trim();
            // 容忍值里的 XML 实体（href 里主要是 &amp;）。
            return Some(
                value
                    .replace("&amp;", "&")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">"),
            );
        }
        i = end + 1;
    }
    None
}

/// 百分号解码（宽松：非法序列原样保留，`+` 视为空格）。
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = |b: u8| match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                };
                match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push((h << 4) | l);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn norm_path(p: &str) -> String {
    let mut s = percent_decode(p);
    while s.ends_with('/') && s.len() > 1 {
        s.pop();
    }
    s
}

/// 与本地曲库同一份音频扩展名事实。
pub fn is_audio_name(name: &str) -> bool {
    vmusic_library::is_audio_file(std::path::Path::new(name))
}

/// PROPFIND 一个目录（Depth:1，Basic auth 可选），返回原始 XML。
pub async fn propfind(
    base_url: &str,
    sub_path: &str,
    auth: Option<&BasicAuth>,
) -> Result<String, String> {
    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        sub_path.trim_start_matches('/')
    );
    let client = reqwest::Client::builder()
        .user_agent("hertz-studio/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
        .header("Depth", "1")
        .header(
            "Content-Type",
            "application/xml; charset=utf-8",
        )
        .body(r#"<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:displayname/></D:prop></D:propfind>"#);
    if let Some(a) = auth {
        req = req.basic_auth(&a.username, Some(&a.password));
    }
    let resp = req.send().await.map_err(|e| format!("连接失败: {e}"))?;
    let status = resp.status();
    if status.as_u16() == 401 {
        return Err("鉴权失败（401）：检查用户名与密码".into());
    }
    if status.as_u16() == 404 {
        return Err("目录不存在（404）".into());
    }
    if !status.is_success() && status.as_u16() != 207 {
        return Err(format!("服务器返回 {status}"));
    }
    resp.text().await.map_err(|e| format!("读取响应失败: {e}"))
}

/// 直链播放用的 HTTP Range 流。
///
/// symphonia `MediaSource` 要求 `Read + Seek + Send + Sync`：seek 只记位置，
/// 真正的字节在 read 时按 `Range: pos-` 拉取。网络访问全部发生在解码线程
/// （非 async 上下文），阻塞客户端在那里是安全的。
pub struct HttpRangeStream {
    inner: Arc<RangeReader>,
    pos: u64,
}

struct RangeReader {
    url: String,
    auth: Option<BasicAuth>,
    client: reqwest::blocking::Client,
    len: Option<u64>,
}

impl HttpRangeStream {
    /// 探测总长（HEAD，失败退 Range 0-0 看 Content-Range）；总长未知也能播，
    /// 只是 CBR mp3 这类容器拿不到精确时长。
    pub fn open(url: &str, auth: Option<&BasicAuth>) -> reqwest::Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("hertz-studio/0.1")
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        let mut req = client.head(url);
        if let Some(a) = auth {
            req = req.basic_auth(&a.username, Some(&a.password));
        }
        let len = match req.send() {
            Ok(resp) if resp.status().is_success() => {
                let len = resp
                    .headers()
                    .get(reqwest::header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok());
                if len.is_some() {
                    len
                } else {
                    let mut r = client.get(url);
                    if let Some(a) = auth {
                        r = r.basic_auth(&a.username, Some(&a.password));
                    }
                    r.header(reqwest::header::RANGE, "bytes=0-0")
                        .send()
                        .ok()
                        .and_then(|resp| {
                            resp.headers()
                                .get(reqwest::header::CONTENT_RANGE)
                                .and_then(|v| v.to_str().ok())
                                .and_then(|v| v.rsplit('/').next()?.parse::<u64>().ok())
                        })
                }
            }
            _ => None,
        };
        Ok(Self {
            inner: Arc::new(RangeReader {
                url: url.to_string(),
                auth: auth.cloned(),
                client,
                len,
            }),
            pos: 0,
        })
    }
}

impl Read for HttpRangeStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read_at(self.pos, buf)?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpRangeStream {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let new = match pos {
            SeekFrom::Start(o) => o as i64,
            SeekFrom::Current(d) => self.pos as i64 + d,
            SeekFrom::End(d) => match self.inner.len {
                Some(l) => l as i64 + d,
                None => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "seek from end without content length",
                    ))
                }
            },
        };
        if new < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "seek before start",
            ));
        }
        self.pos = new as u64;
        Ok(self.pos)
    }
}

impl RangeReader {
    fn read_at(&self, pos: u64, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let end = pos.saturating_add(buf.len() as u64).saturating_sub(1);
        let mut req = self
            .client
            .get(&self.url)
            .header(reqwest::header::RANGE, format!("bytes={pos}-{end}"));
        if let Some(a) = &self.auth {
            req = req.basic_auth(&a.username, Some(&a.password));
        }
        let mut resp = req.send().map_err(io_err)?;
        let status = resp.status();
        if status == reqwest::StatusCode::OK {
            // 服务器不支持 Range：pos 非 0 时无法按需取流，如实报错。
            if pos > 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "server ignored range request",
                ));
            }
        } else if status != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                format!("HTTP {status}"),
            ));
        }
        let mut filled = 0usize;
        while filled < buf.len() {
            match resp.read(&mut buf[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) => return Err(std::io::Error::new(e.kind(), e.to_string())),
            }
        }
        Ok(filled)
    }
}

fn io_err(e: reqwest::Error) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::ConnectionAborted, e.to_string())
}

/// AudioSource：后端用 DynMediaSource 适配成 MediaSourceStream。
/// media_len = HTTP Content-Length（可 seek 判定的依据）。
impl vmusic_core::AudioSource for HttpRangeStream {
    fn media_len(&self) -> Option<u64> {
        self.inner.len
    }
}

/// 为直链 URL 找 Basic auth：按 base_url 前缀最长匹配远程来源，
/// 凭据从钥匙串取（memory 后端在 CI）。
pub async fn auth_for_url(
    pool: &sqlx::SqlitePool,
    secrets: &dyn crate::secrets::SecretBackend,
    url: &str,
) -> Option<BasicAuth> {
    let roots = vmusic_store::remote_roots::list(pool).await.ok()?;
    let lowered = url.to_string();
    let best = roots
        .iter()
        .filter(|r| lowered.starts_with(&r.base_url))
        .max_by_key(|r| r.base_url.len())?;
    let entry = secrets.get(&format!("remote_cred_{}", best.id)).ok()?;
    let raw = entry.cred?;
    let (u, p) = raw.split_once(':')?;
    (!u.is_empty() || !p.is_empty()).then(|| BasicAuth {
        username: u.to_string(),
        password: p.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/Music/%E5%91%A8%E6%9D%B0%E4%BC%A6/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/Music/song%201.mp3</D:href>
    <D:propstat><D:prop>
      <D:getcontentlength>4096</D:getcontentlength>
      <D:getlastmodified>Tue, 22 Sep 2026 10:00:00 GMT</D:getlastmodified>
    </D:prop></D:propstat>
  </D:response>
</D:multistatus>"#;

    #[test]
    fn propfind_parses_collections_files_and_decodes_paths() {
        let entries = parse_propfind(SAMPLE, "/dav/").expect("multistatus");
        // 自身行被跳过，剩目录 + 文件。
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(entries[0].path, "/dav/Music/周杰伦/");
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].path, "/dav/Music/song 1.mp3");
        assert!(!entries[1].is_dir);
        assert_eq!(entries[1].size, Some(4096));
        assert!(is_audio_name(&entries[1].name));
        assert!(!is_audio_name(&entries[0].name));
    }

    #[test]
    fn non_multistatus_body_is_rejected() {
        assert!(parse_propfind("<html><body>hi</body></html>", "/").is_none());
    }

    #[test]
    fn no_namespace_tags_still_parse() {
        let body = r#"<multistatus><response><href>/x/a.flac</href>
            <propstat><prop><resourcetype/><getcontentlength>7</getcontentlength></prop></propstat>
            </response></multistatus>"#;
        let entries = parse_propfind(body, "/").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "/x/a.flac");
        assert_eq!(entries[0].size, Some(7));
    }

    #[test]
    fn percent_decode_plain() {
        assert_eq!(percent_decode("/a%20b/c%2Fd"), "/a b/c/d");
        assert_eq!(percent_decode("/plain/path"), "/plain/path");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
