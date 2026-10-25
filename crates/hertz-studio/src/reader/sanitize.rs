// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 源内 HTML 正文的清洗与图片登记。
//!
//! 服务端 ammonia 清洗是唯一放行点：脚本、事件属性、表单、iframe、内联样式、
//! SVG/MathML 与危险协议全部剥离；`src`/`srcset` 不再指向源站，而是换成同一条目
//! 内登记的图片键，浏览器因此不会直接请求任意远程资源。图片字节不落库，由
//! HTTP 层按需代理。

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use ammonia::{Builder, UrlRelative};
use reqwest::Url;
use sha2::{Digest, Sha256};

use crate::reader::MAX_IMAGES_PER_ENTRY;

/// 清洗后正文的完整性标记；超预算（`over_budget`）由上层在合并时决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CleanStatus {
    Cached,
    Truncated,
}

/// 一条正文清洗结果。
pub(super) struct Cleaned {
    pub html: String,
    pub status: CleanStatus,
}

/// 同一条目内的图片登记表：绝对 URL → 稳定图片键。
///
/// 键取 URL 的 SHA-256 前 16 字节 hex，同一条目内同 URL 复用同键，刷新不换键；
/// 超过 [`MAX_IMAGES_PER_ENTRY`] 后新图片不再登记，`src` 置空（不发起请求）。
pub(super) struct ImageRegistry {
    pub items: Vec<(String, String)>,
    by_url: HashMap<String, String>,
}

impl ImageRegistry {
    pub(super) fn new() -> Self {
        Self {
            items: Vec::new(),
            by_url: HashMap::new(),
        }
    }

    fn register(&mut self, url: String) -> Option<String> {
        if let Some(key) = self.by_url.get(&url) {
            return Some(key.clone());
        }
        if self.items.len() >= MAX_IMAGES_PER_ENTRY {
            return None;
        }
        let key = image_key(&url);
        self.by_url.insert(url.clone(), key.clone());
        self.items.push((key.clone(), url));
        Some(key)
    }

    /// 清洗器内部登记表（attribute_filter 无法借用外部状态）汇入调用方登记表。
    fn absorb(&mut self, other: &ImageRegistry) {
        for (key, url) in &other.items {
            if !self.by_url.contains_key(url) {
                self.by_url.insert(url.clone(), key.clone());
                self.items.push((key.clone(), url.clone()));
            }
        }
    }
}

pub(super) fn image_key(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// 清洗一段源内 HTML。相对地址按 `base`（响应地址，或正文根的 xml:base）解析。
///
/// ammonia 的 attribute_filter 要求 `Fn + Send + Sync + 'static`，无法借用外部
/// 可变状态，登记表因此经由 `Arc<Mutex<>>` 在清洗后汇回。实测（相对地址改写）
/// 与 filter 同时使用会互相干扰：URL 属性统一改走 `PassThrough` + 本模块自己
/// 解析，图片 `src` 由 filter 换成裸图片键，不再被二次拼接。
pub(super) fn clean(raw: &str, base: &Url, images: &mut ImageRegistry) -> Cleaned {
    let mut builder = Builder::default();
    builder
        .url_relative(UrlRelative::PassThrough)
        .url_schemes(allowed_schemes());
    // 默认 img 白名单没有 srcset；用 add_* 追加。注意 tag_attributes 是整体
    // 替换，会顺手抹掉 <a href> 等其他标签的默认属性，不能用它。
    builder.add_tag_attributes("img", &["srcset"]);
    // ammonia 默认会给 <a> 加 rel="noopener noreferrer"，保留该行为。
    let filter_registry = Arc::new(Mutex::new(ImageRegistry::new()));
    let callback_registry = Arc::clone(&filter_registry);
    let filter_base = base.clone();
    builder.attribute_filter(move |element: &str, attribute: &str, value: &str| {
        let mut registry = callback_registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match (element, attribute) {
            ("img", "src") => register_image(&filter_base, value, &mut registry).map(Cow::Owned),
            ("img", "srcset") => Some(Cow::Owned(rewrite_srcset(
                &filter_base,
                value,
                &mut registry,
            ))),
            // 引用类 URL 属性统一解析为绝对地址；非公开地址移除属性。
            ("a", "href") | ("blockquote", "cite") | ("q", "cite") => {
                resolve_public(&filter_base, value).map(Cow::Owned)
            }
            // 其余属性（alt、title、colspan 等）原样交回。
            _ => Some(Cow::Borrowed(value)),
        }
    });
    let mut html = builder.clean(raw).to_string();
    images.absorb(
        &filter_registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    if html.len() > crate::reader::MAX_CONTENT_BYTES {
        html = truncate_balanced(&html, crate::reader::MAX_CONTENT_BYTES);
        return Cleaned {
            html,
            status: CleanStatus::Truncated,
        };
    }
    Cleaned {
        html,
        status: CleanStatus::Cached,
    }
}

fn allowed_schemes() -> HashSet<&'static str> {
    HashSet::from(["http", "https", "mailto"])
}

/// 解析并登记一张图片，返回替换 `src` 的键；非公开 HTTP(S) 或超限返回 None。
fn register_image(base: &Url, value: &str, images: &mut ImageRegistry) -> Option<String> {
    resolve_public(base, value).and_then(|url| images.register(url))
}

/// 引用类属性的统一解析：相对地址按 base 补全，只放行公开 HTTP(S)。
fn resolve_public(base: &Url, value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let absolute = base.join(trimmed).ok()?;
    if matches!(absolute.scheme(), "http" | "https") && absolute.host_str().is_some() {
        Some(absolute.to_string())
    } else {
        None
    }
}

/// best-effort 重写 `srcset` 的每个候选；含逗号的 URL 属于已知限制，整段丢弃。
fn rewrite_srcset(base: &Url, value: &str, images: &mut ImageRegistry) -> String {
    let mut out: Vec<String> = Vec::new();
    for candidate in value.split(',') {
        let candidate = candidate.trim();
        if candidate.is_empty() {
            continue;
        }
        let (url_part, descriptor) = match candidate.split_once(char::is_whitespace) {
            Some((url, rest)) => (url, Some(rest.trim())),
            None => (candidate, None),
        };
        let Some(key) = register_image(base, url_part, images) else {
            continue;
        };
        match descriptor {
            Some(d) if !d.is_empty() => out.push(format!("{key} {d}")),
            _ => out.push(key),
        }
    }
    out.join(", ")
}

const VOID_TAGS: [&str; 14] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// 在字节预算内截断清洗后 HTML：先回退到最近的标签边界，再按开标签栈补齐闭合。
/// 清洗器已移除 script/style，正文不再包含原始 '<' 文本，栈扫描是安全的。
fn truncate_balanced(html: &str, max: usize) -> String {
    if html.len() <= max {
        return html.to_string();
    }
    let cut = match html.as_bytes()[..=max].iter().rposition(|&b| b == b'>') {
        Some(pos) => pos + 1,
        None => return String::new(),
    };
    let mut kept = html[..cut].to_string();
    // 掉在标签中间的 '<' 片段会破坏结构，直接丢弃。
    let last_open = kept.rfind('<');
    if let Some(open) = last_open {
        if !kept[open..].contains('>') {
            kept.truncate(open);
        }
    }
    let mut open_tags: Vec<String> = Vec::new();
    let mut rest = kept.as_str();
    while let Some(start) = rest.find('<') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('>') else {
            break;
        };
        let tag = &after[..end];
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if tag.starts_with('/') {
            if open_tags.last().map(String::as_str) == Some(name.as_str()) {
                open_tags.pop();
            }
        } else if !tag.ends_with('/') && !VOID_TAGS.contains(&name.as_str()) {
            open_tags.push(name);
        }
        rest = &after[end + 1..];
    }
    for tag in open_tags.iter().rev() {
        kept.push_str(&format!("</{tag}>"));
    }
    kept
}

#[cfg(test)]
mod tests;
