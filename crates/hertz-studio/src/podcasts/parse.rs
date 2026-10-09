// SPDX-License-Identifier: MIT

use std::collections::HashSet;

use reqwest::Url;
use roxmltree::{Document, Node, ParsingOptions};
use sha1::{Digest, Sha1};

use super::{
    public_url, Episode, ParsedEpisode, ParsedFeed, Show, MAX_DESCRIPTION_CHARS, MAX_EPISODES,
    MAX_FEED_BYTES, MAX_XML_NODES,
};
use crate::error::{ApiError, ApiResult};
use crate::online::OnlineTrack;

pub(super) fn invalid_feed() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        "podcast_invalid_feed",
        "地址未返回有效的 UTF-8 RSS/Atom 播客，或 XML 超出解析预算",
    )
    .with_source("podcast")
}

pub(super) fn feed_too_large() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        "podcast_feed_too_large",
        "播客 RSS 超过 16 MiB 读取上限",
    )
    .with_source("podcast")
}

pub(super) fn digest(parts: &[&str]) -> String {
    let mut hash = Sha1::new();
    for part in parts {
        hash.update(part.as_bytes());
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

pub(super) fn show_id(feed_url: &Url) -> String {
    digest(&["podcast-show-v1", feed_url.as_str()])
}

fn child<'a, 'input>(node: Node<'a, 'input>, tag: &str) -> Option<Node<'a, 'input>> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == tag)
}

fn itunes<'a, 'input>(node: Node<'a, 'input>, tag: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|n| {
        n.is_element()
            && n.tag_name().name() == tag
            && matches!(
                n.tag_name().namespace(),
                Some(
                    "http://www.itunes.com/dtds/podcast-1.0.dtd"
                        | "https://www.itunes.com/dtds/podcast-1.0.dtd"
                )
            )
    })
}

fn text(node: Node<'_, '_>) -> String {
    let mut out = String::new();
    for part in node
        .descendants()
        .filter(|n| n.is_text())
        .filter_map(|n| n.text())
    {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(part);
    }
    out
}

fn field(node: Node<'_, '_>, tag: &str, limit: usize) -> String {
    child(node, tag)
        .map(|n| plain_text(&text(n), limit))
        .unwrap_or_default()
}

fn author(node: Node<'_, '_>, atom: bool) -> String {
    let author = if atom {
        child(node, "author").and_then(|a| child(a, "name"))
    } else {
        itunes(node, "author")
            .or_else(|| child(node, "creator"))
            .or_else(|| child(node, "author"))
    };
    author
        .map(|n| plain_text(&text(n), 256))
        .unwrap_or_default()
}

fn description(node: Node<'_, '_>, atom: bool) -> String {
    let value = if atom {
        child(node, "summary")
            .or_else(|| child(node, "content"))
            .or_else(|| child(node, "subtitle"))
    } else {
        child(node, "encoded")
            .or_else(|| child(node, "description"))
            .or_else(|| itunes(node, "summary"))
    };
    value
        .map(|n| plain_text(&text(n), MAX_DESCRIPTION_CHARS))
        .unwrap_or_default()
}

fn resource(base: &Url, input: &str) -> Option<String> {
    if input.trim().is_empty() {
        return None;
    }
    let joined = base.join(input.trim()).ok()?;
    public_url(joined.as_str()).ok().map(|u| u.to_string())
}

fn cover(node: Node<'_, '_>, base: &Url, atom: bool) -> Option<String> {
    if let Some(image) = itunes(node, "image").and_then(|n| n.attribute("href")) {
        if let Some(url) = resource(base, image) {
            return Some(url);
        }
    }
    let value = if atom {
        child(node, "logo").or_else(|| child(node, "icon"))
    } else {
        child(node, "image").and_then(|n| child(n, "url"))
    };
    value.and_then(|n| resource(base, &text(n)))
}

fn audio_enclosure(item: Node<'_, '_>, base: &Url, atom: bool) -> Option<String> {
    item.children()
        .filter(|n| {
            n.is_element()
                && if atom {
                    n.tag_name().name() == "link" && n.attribute("rel") == Some("enclosure")
                } else {
                    n.tag_name().name() == "enclosure"
                }
        })
        .find_map(|n| {
            let url = resource(base, n.attribute(if atom { "href" } else { "url" })?)?;
            let path = Url::parse(&url).ok()?.path().to_ascii_lowercase();
            if [".m3u", ".m3u8", ".pls"]
                .iter()
                .any(|ext| path.ends_with(ext))
            {
                return None;
            }
            let mime = n
                .attribute("type")
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let audio = (mime.starts_with("audio/")
                && !matches!(mime.as_str(), "audio/mpegurl" | "audio/x-mpegurl"))
                || mime == "application/ogg"
                || (matches!(mime.as_str(), "" | "application/octet-stream")
                    && [
                        ".mp3", ".m4a", ".mp4", ".aac", ".ogg", ".oga", ".flac", ".wav", ".aiff",
                        ".aif",
                    ]
                    .iter()
                    .any(|ext| path.ends_with(ext)));
            audio.then_some(url)
        })
}

fn duration_ms(value: &str) -> u64 {
    let parts = value.trim().split(':').take(4).collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 3 {
        return 0;
    }
    let mut seconds = 0u64;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return 0;
        }
        let Ok(unit) = part.parse::<u64>() else {
            return 0;
        };
        if i > 0 && unit >= 60 {
            return 0;
        }
        let Some(next) = seconds.checked_mul(60).and_then(|v| v.checked_add(unit)) else {
            return 0;
        };
        seconds = next;
    }
    seconds
        .checked_mul(1000)
        .filter(|n| *n <= i64::MAX as u64)
        .unwrap_or(0)
}

/// roxmltree 会在 nodes_limit 生效前按原始 '<'/'=' 预分配，并在单标签内线性查重属性。
/// 这里只检查资源形状，跳过 CDATA/注释/PI；合法性、实体和命名空间语义仍由 XML 库处理。
fn preflight_xml(xml: &str) -> ApiResult<()> {
    const MAX_ATTRIBUTES_PER_TAG: usize = 128;
    const MAX_DEPTH: usize = 64;
    const MAX_NAMESPACES_IN_SCOPE: usize = 64;
    const MAX_NAMESPACE_DECLARATIONS: usize = 4096;

    let mut nodes = 0u32;
    let mut attributes = 0u32;
    for byte in xml.bytes() {
        nodes += u32::from(byte == b'<');
        attributes += u32::from(byte == b'=');
        if nodes > MAX_XML_NODES || attributes > MAX_XML_NODES {
            return Err(invalid_feed());
        }
    }

    let mut scopes = Vec::with_capacity(MAX_DEPTH);
    let mut total_namespaces = 0usize;
    let mut remaining = xml;
    while let Some(start) = remaining.find('<') {
        remaining = &remaining[start..];
        if remaining.starts_with("<![CDATA[") {
            let end = remaining.find("]]>").ok_or_else(invalid_feed)?;
            remaining = &remaining[end + 3..];
            continue;
        }
        if remaining.starts_with("<!--") {
            let end = remaining.find("-->").ok_or_else(invalid_feed)?;
            remaining = &remaining[end + 3..];
            continue;
        }
        if remaining.starts_with("<?") {
            let end = remaining.find("?>").ok_or_else(invalid_feed)?;
            remaining = &remaining[end + 2..];
            continue;
        }
        if remaining.starts_with("<!") {
            return Err(invalid_feed()); // DTD 与实体声明不属于公开 RSS 支持范围。
        }
        let mut quote = None;
        let mut count = 0;
        let mut end = None;
        for (index, byte) in remaining.bytes().enumerate().skip(1) {
            if quote.is_some() {
                if quote == Some(byte) {
                    quote = None;
                }
                continue;
            }
            match byte {
                b'\'' | b'"' => quote = Some(byte),
                b'=' => {
                    count += 1;
                    if count > MAX_ATTRIBUTES_PER_TAG {
                        return Err(invalid_feed());
                    }
                }
                b'>' => {
                    end = Some(index);
                    break;
                }
                _ => {}
            }
        }
        let end = end.ok_or_else(invalid_feed)?;
        let tag = &remaining[..=end];
        if tag.starts_with("</") {
            scopes.pop().ok_or_else(invalid_feed)?;
        } else {
            // 保守统计标签中的 xmlns 标记，避免继承命名空间的累计复制放大。
            let declarations = tag.matches("xmlns").count();
            total_namespaces += declarations;
            let in_scope = scopes.last().copied().unwrap_or(0) + declarations;
            if in_scope > MAX_NAMESPACES_IN_SCOPE
                || total_namespaces > MAX_NAMESPACE_DECLARATIONS
                || scopes.len() >= MAX_DEPTH
            {
                return Err(invalid_feed());
            }
            if !tag[..end].trim_end().ends_with('/') {
                scopes.push(in_scope);
            }
        }
        remaining = &remaining[end + 1..];
    }
    Ok(())
}

pub(super) fn parse_feed(
    feed_url: &Url,
    document_url: &Url,
    bytes: &[u8],
) -> ApiResult<ParsedFeed> {
    if bytes.len() > MAX_FEED_BYTES {
        return Err(feed_too_large());
    }
    let xml = std::str::from_utf8(bytes).map_err(|_| invalid_feed())?;
    preflight_xml(xml)?;
    let document = Document::parse_with_options(
        xml.trim_start_matches('\u{feff}'),
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: MAX_XML_NODES,
            ..ParsingOptions::default()
        },
    )
    .map_err(|_| invalid_feed())?;
    let root = document.root_element();
    let (channel, atom) = match root.tag_name().name() {
        "rss" => (child(root, "channel").ok_or_else(invalid_feed)?, false),
        "feed" if root.tag_name().namespace() == Some("http://www.w3.org/2005/Atom") => {
            (root, true)
        }
        _ => return Err(invalid_feed()),
    };
    let mut title = field(channel, "title", 512);
    if title.is_empty() {
        title = "未命名播客".into();
    }
    let mut show = Show {
        id: show_id(feed_url),
        title,
        author: author(channel, atom),
        description: description(channel, atom),
        cover: cover(channel, document_url, atom),
        feed_url: feed_url.to_string(),
        episode_count: 0,
        subscribed: false,
    };
    let mut episodes = Vec::new();
    let mut seen = HashSet::new();
    for item in channel
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == if atom { "entry" } else { "item" })
        .take(MAX_EPISODES)
    {
        let Some(enclosure_url) = audio_enclosure(item, document_url, atom) else {
            continue;
        };
        let guid = child(item, if atom { "id" } else { "guid" })
            .map(text)
            .unwrap_or_default();
        // GUID 不要求为 URL/数字。仅保存固定长度的身份摘要，不让巨大 GUID 进入数据库。
        let identity = if guid.trim().is_empty() {
            format!("enclosure:{}", digest(&[&enclosure_url]))
        } else {
            format!("guid:{}", digest(&[guid.trim()]))
        };
        let id = digest(&["podcast-episode-v1", feed_url.as_str(), &identity]);
        if !seen.insert(id.clone()) {
            continue;
        }
        let mut title = field(item, "title", 512);
        if title.is_empty() {
            title = "未命名单集".into();
        }
        let artist = author(item, atom);
        let published_at = if atom {
            child(item, "published")
                .or_else(|| child(item, "updated"))
                .map(|n| plain_text(&text(n), 128))
                .unwrap_or_default()
        } else {
            field(item, "pubDate", 128)
        };
        episodes.push(ParsedEpisode {
            episode: Episode {
                track: OnlineTrack {
                    source: "podcast".into(),
                    id,
                    title,
                    artist: if artist.is_empty() {
                        show.author.clone()
                    } else {
                        artist
                    },
                    album: show.title.clone(),
                    duration_ms: itunes(item, "duration")
                        .map(|n| duration_ms(&text(n)))
                        .unwrap_or(0),
                    cover: cover(item, document_url, atom).or_else(|| show.cover.clone()),
                    playable: true,
                    vip_only: false,
                    track_ref: serde_json::Value::Null,
                },
                published_at,
                description: description(item, atom),
            },
            identity,
            enclosure_url,
        });
    }
    show.episode_count = episodes.len();
    Ok(ParsedFeed { show, episodes })
}

/// 输出只能当纯文本显示。去掉常见 HTML 标记与脚本/样式，折叠空白，并按字符限长。
pub(super) fn plain_text(input: &str, max_chars: usize) -> String {
    let mut output = String::new();
    let mut hidden: Option<String> = None;
    let mut remaining = input;
    let mut count = 0;
    let mut space = false;
    let mut scan_tags = true;
    while !remaining.is_empty() && count < max_chars {
        if scan_tags && remaining.starts_with('<') {
            let after = &remaining[1..];
            if let Some(end) = after.find('>') {
                let tag = after[..end].trim();
                let closing = tag.starts_with('/');
                let name = tag
                    .trim_start_matches('/')
                    .split(|c: char| c.is_whitespace() || c == '/')
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if matches!(name.as_str(), "script" | "style") {
                    if closing && hidden.as_deref() == Some(name.as_str()) {
                        hidden = None;
                    } else if !closing {
                        hidden = Some(name);
                    }
                }
                remaining = &after[end + 1..];
                space = !output.is_empty();
                continue;
            }
            // 后缀里已不存在 '>'，不能对每个 '<' 重复扫描同一大段文本。
            if hidden.is_some() {
                break;
            }
            scan_tags = false;
        }
        let mut character = remaining.chars().next().unwrap();
        let mut consumed = character.len_utf8();
        if character == '&' {
            if let Some(end) = remaining
                .as_bytes()
                .iter()
                .take(16)
                .position(|b| *b == b';')
            {
                if let Some(decoded) = entity(&remaining[1..end]) {
                    character = decoded;
                    consumed = end + 1;
                }
            }
        }
        remaining = &remaining[consumed..];
        if hidden.is_some() {
            continue;
        }
        if character.is_whitespace() || character.is_control() {
            space = !output.is_empty();
            continue;
        }
        if space && count + 1 < max_chars {
            output.push(' ');
            count += 1;
        }
        space = false;
        if count < max_chars {
            output.push(character);
            count += 1;
        }
    }
    output
}

fn entity(value: &str) -> Option<char> {
    match value {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => {
            let number = if let Some(hex) = value
                .strip_prefix("#x")
                .or_else(|| value.strip_prefix("#X"))
            {
                u32::from_str_radix(hex, 16).ok()?
            } else {
                value.strip_prefix('#')?.parse().ok()?
            };
            char::from_u32(number)
        }
    }
}
