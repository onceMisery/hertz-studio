// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! RSS 2.0 / Atom 1.0 图文条目解析。
//!
//! 只提取与身份、列表和正文相关的字段；收录规则是标题、正文、摘要或原文链接
//! 至少一项非空。音频 enclosure 一律忽略——播客领域继续独占音频语义。

use std::collections::HashSet;

use reqwest::Url;
use roxmltree::Node;
use sha1::{Digest, Sha1};
use time::OffsetDateTime;

use crate::feed_xml::{child, parse_document, plain_text, text, FeedXmlError};
use crate::reader::{MAX_AUTHOR_CHARS, MAX_ENTRIES_SCAN, MAX_SUMMARY_CHARS, MAX_TITLE_CHARS};

const ATOM_NS: &str = "http://www.w3.org/2005/Atom";
const CONTENT_NS: &str = "http://purl.org/rss/1.0/modules/content/";
const XML_BASE_NS: &str = "http://www.w3.org/XML/1998/namespace";

/// `raw_html` 保存源内可渲染的 HTML（含 RSS description），不代表已取得全文；
/// None 时只提供纯文本摘要或标题/原文链接。
pub(super) struct ParsedEntry {
    /// `guid:<sha1>` / `url:<sha1>` / `weak:<sha1>`；`weak` 表示无稳定身份。
    pub identity: String,
    pub weak: bool,
    pub title: String,
    pub author: String,
    pub published_at: Option<i64>,
    pub original_url: Option<String>,
    pub summary: String,
    /// 待清洗的源内 HTML，可为全文或摘要。
    pub raw_html: Option<String>,
    /// 正文根的 xml:base（若源提供）；清洗时优先于响应地址。
    pub content_base: Option<String>,
    /// 源是否提供了任何内容/摘要字段；false 时条目只有标题或链接。
    pub content_present: bool,
}

pub(super) struct ParsedFeedData {
    pub title: String,
    pub site_url: Option<String>,
    pub entries: Vec<ParsedEntry>,
    /// 条目扫描触及 [`MAX_ENTRIES_SCAN`]，源可能还有未扫的条目。
    pub scan_truncated: bool,
}

pub(super) fn digest(parts: &[&str]) -> String {
    let mut hash = Sha1::new();
    for part in parts {
        hash.update(part.as_bytes());
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

pub(super) fn feed_id(feed_url: &Url) -> String {
    digest(&["reader-feed-v1", feed_url.as_str()])
}

pub(super) fn parse_feed(
    feed_url: &Url,
    document_url: &Url,
    bytes: &[u8],
) -> Result<ParsedFeedData, FeedXmlError> {
    let xml = std::str::from_utf8(bytes).map_err(|_| FeedXmlError::Malformed)?;
    let document = parse_document(xml, crate::reader::MAX_XML_NODES)?;
    let root = document.root_element();
    let (channel, atom) = match root.tag_name().name() {
        "rss" => (
            child(root, "channel").ok_or(FeedXmlError::Malformed)?,
            false,
        ),
        "feed" if root.tag_name().namespace() == Some(ATOM_NS) => (root, true),
        _ => return Err(FeedXmlError::Malformed),
    };

    let mut title = plain_text(
        &child(channel, "title").map(|n| text(n)).unwrap_or_default(),
        MAX_TITLE_CHARS,
    );
    if title.is_empty() {
        title = feed_url.as_str().to_string();
    }
    let site_url = article_link(channel, document_url, atom);

    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut scanned = 0usize;
    let mut scan_truncated = false;
    for item in channel
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == if atom { "entry" } else { "item" })
    {
        scanned += 1;
        if entries.len() >= MAX_ENTRIES_SCAN {
            scan_truncated = true;
            break;
        }
        if let Some(entry) = parse_entry(item, document_url, atom) {
            if seen.insert(entry.identity.clone()) {
                entries.push(entry);
            }
        }
    }
    if scanned > MAX_ENTRIES_SCAN {
        scan_truncated = true;
    }
    Ok(ParsedFeedData {
        title,
        site_url,
        entries,
        scan_truncated,
    })
}

fn parse_entry(item: Node<'_, '_>, document_url: &Url, atom: bool) -> Option<ParsedEntry> {
    let title = plain_text(
        &child(item, "title").map(|n| text(n)).unwrap_or_default(),
        MAX_TITLE_CHARS,
    );
    let author = plain_text(
        &if atom {
            child(item, "author")
                .and_then(|a| child(a, "name"))
                .map(text)
        } else {
            child(item, "creator")
                .or_else(|| child(item, "author"))
                .map(text)
        }
        .unwrap_or_default(),
        MAX_AUTHOR_CHARS,
    );
    let published_at = if atom {
        child(item, "published")
            .or_else(|| child(item, "updated"))
            .map(text)
    } else {
        child(item, "pubDate").map(text)
    }
    .and_then(|raw| parse_timestamp(raw.trim()));
    let original_url = article_link(item, document_url, atom);

    let content = entry_content(item, atom);
    let summary_text = content.as_ref().map(|c| c.text.clone()).unwrap_or_default();
    // 收录规则：标题、正文、摘要或原文链接至少一项非空。
    if title.is_empty()
        && content.is_none()
        && summary_text.trim().is_empty()
        && original_url.is_none()
    {
        return None;
    }
    let summary = plain_text(&summary_text, MAX_SUMMARY_CHARS);
    let guid = child(item, if atom { "id" } else { "guid" })
        .map(text)
        .unwrap_or_default();
    let (identity, weak) = if !guid.trim().is_empty() {
        (format!("guid:{}", digest(&[guid.trim()])), false)
    } else if let Some(url) = &original_url {
        (format!("url:{}", digest(&[url])), false)
    } else {
        (
            format!(
                "weak:{}",
                digest(&[&title, &published_text(item, atom), &author])
            ),
            true,
        )
    };
    let (raw_html, content_base) = match &content {
        Some(value) => (value.raw_html.clone(), value.xml_base.clone()),
        None => (None, None),
    };
    Some(ParsedEntry {
        identity,
        weak,
        title: if title.is_empty() {
            "未命名文章".into()
        } else {
            title
        },
        author,
        published_at,
        original_url,
        summary,
        raw_html,
        content_base,
        content_present: content.is_some(),
    })
}

struct Content {
    /// 供摘要与清洗用的正文文本（html 或 xhtml 序列化结果）。
    text: String,
    /// 源内 HTML（待清洗）；None = 仅提供纯文本展示。
    raw_html: Option<String>,
    xml_base: Option<String>,
}

/// RSS 正文优先 `content:encoded`，其次 `description`；Atom 优先 `content`，
/// 其次 `summary`。`content src` 不自动请求；`type="text"`（含缺省）按摘要语义展示。
fn entry_content(item: Node<'_, '_>, atom: bool) -> Option<Content> {
    if atom {
        if let Some(node) = child(item, "content") {
            if node.attribute("src").is_none() {
                match node.attribute("type") {
                    // type="text"（含缺省）是纯文本：按摘要语义展示，不冒充富文本。
                    Some("text") | None => {
                        let value = text(node);
                        if !value.trim().is_empty() {
                            return Some(Content {
                                text: value,
                                raw_html: None,
                                xml_base: None,
                            });
                        }
                    }
                    _ => {
                        let value = if node.attribute("type") == Some("xhtml") {
                            serialize_children(node)
                        } else {
                            text(node)
                        };
                        if !value.trim().is_empty() {
                            return Some(Content {
                                text: value.clone(),
                                raw_html: Some(value),
                                xml_base: node.attribute((XML_BASE_NS, "base")).map(str::to_string),
                            });
                        }
                    }
                }
            }
        }
        let summary = child(item, "summary")?;
        let value = text(summary);
        if value.trim().is_empty() {
            return None;
        }
        return Some(Content {
            text: value,
            raw_html: None,
            xml_base: None,
        });
    }
    let encoded = item.children().find(|n| {
        n.is_element()
            && n.tag_name().name() == "encoded"
            && n.tag_name().namespace() == Some(CONTENT_NS)
    });
    if let Some(node) = encoded {
        let value = text(node);
        if !value.trim().is_empty() {
            return Some(Content {
                text: value.clone(),
                raw_html: Some(value),
                xml_base: node.attribute((XML_BASE_NS, "base")).map(str::to_string),
            });
        }
    }
    let description = child(item, "description")?;
    let value = text(description);
    if value.trim().is_empty() {
        return None;
    }
    Some(Content {
        text: value.clone(),
        // RSS description 允许 HTML，不能先转成纯文本，否则会丢失段落与链接。
        // 与 content:encoded 走相同的清洗、图片登记和正文预算。
        raw_html: Some(value),
        xml_base: description
            .attribute((XML_BASE_NS, "base"))
            .map(str::to_string),
    })
}

/// 原文链接：RSS `<link>` 文本；Atom `rel=alternate`（或无 rel）的 `href`。
fn article_link(node: Node<'_, '_>, document_url: &Url, atom: bool) -> Option<String> {
    if atom {
        let href = node
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "link")
            .find(|n| {
                let rel = n.attribute("rel").unwrap_or("alternate");
                rel == "alternate"
            })
            .and_then(|n| n.attribute("href"))?;
        return public_link(document_url, href);
    }
    for link in node
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "link")
    {
        if link.attribute("rel").is_some() || link.attribute("href").is_some() {
            continue; // atom:link 混入 RSS 的情形交给 enclosure/alternate 规则。
        }
        let value = text(link);
        if !value.trim().is_empty() {
            return public_link(document_url, value.trim());
        }
    }
    None
}

fn public_link(base: &Url, input: &str) -> Option<String> {
    let joined = base.join(input.trim()).ok()?;
    if matches!(joined.scheme(), "http" | "https") && joined.host_str().is_some() {
        Some(joined.to_string())
    } else {
        None
    }
}

fn published_text(item: Node<'_, '_>, atom: bool) -> String {
    let tag = if atom { "published" } else { "pubDate" };
    child(item, tag).map(|n| text(n)).unwrap_or_default()
}

/// RFC 2822（RSS pubDate）与 RFC 3339（Atom）都解析；失败返回 None（日期未知）。
fn parse_timestamp(raw: &str) -> Option<i64> {
    use time::format_description::well_known::{Rfc2822, Rfc3339};
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 128 {
        return None;
    }
    OffsetDateTime::parse(raw, &Rfc2822)
        .or_else(|_| OffsetDateTime::parse(raw, &Rfc3339))
        .ok()
        .map(|value| value.unix_timestamp())
}

/// 把 Atom `type="xhtml"` 的子树序列化回 HTML 字符串（清洗器随后统一处理）。
fn serialize_children(node: Node<'_, '_>) -> String {
    let mut out = String::new();
    for child in node.children() {
        serialize_node(child, &mut out);
    }
    out
}

fn serialize_node(node: Node<'_, '_>, out: &mut String) {
    match node.node_type() {
        roxmltree::NodeType::Text => {
            if let Some(value) = node.text() {
                out.push_str(&escape_text(value));
            }
        }
        roxmltree::NodeType::Element => {
            let name = node.tag_name().name();
            if name.is_empty() {
                return;
            }
            out.push('<');
            out.push_str(name);
            for attr in node.attributes() {
                out.push(' ');
                out.push_str(attr.name());
                out.push_str("=\"");
                out.push_str(&escape_text(attr.value()));
                out.push('"');
            }
            out.push('>');
            for child in node.children() {
                serialize_node(child, out);
            }
            out.push_str(&format!("</{name}>"));
        }
        _ => {}
    }
}

fn escape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}
