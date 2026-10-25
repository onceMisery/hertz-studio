// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 公开 feed 世界的公共 XML 安全层。
//!
//! 只提供与具体领域无关的三件事：解析前的字节级预算预检、带预算的
//! roxmltree 解析、以及安全的节点/纯文本提取。各领域（播客、阅读）在这里
//! 之上各自决定内容提取规则与身份算法；本模块不发网络请求，也不持有领域
//! 概念（单集、文章、订阅）。

use roxmltree::{Document, Node, ParsingOptions};

/// XML 未通过预检或解析预算；错误文案由领域自行映射。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FeedXmlError {
    /// 字节预算超限、DTD/实体、深度/属性放大或解析失败。
    Malformed,
}

/// roxmltree 会在 nodes_limit 生效前按原始 '<'/'=' 预分配，并在单标签内线性查重属性。
/// 这里只检查资源形状，跳过 CDATA/注释/PI；合法性、实体和命名空间语义仍由 XML 库处理。
pub(crate) fn preflight_xml(xml: &str, max_nodes: u32) -> Result<(), FeedXmlError> {
    const MAX_ATTRIBUTES_PER_TAG: usize = 128;
    const MAX_DEPTH: usize = 64;
    const MAX_NAMESPACES_IN_SCOPE: usize = 64;
    const MAX_NAMESPACE_DECLARATIONS: usize = 4096;

    let mut nodes = 0u32;
    let mut attributes = 0u32;
    for byte in xml.bytes() {
        nodes += u32::from(byte == b'<');
        attributes += u32::from(byte == b'=');
        if nodes > max_nodes || attributes > max_nodes {
            return Err(FeedXmlError::Malformed);
        }
    }

    let mut scopes = Vec::with_capacity(MAX_DEPTH);
    let mut total_namespaces = 0usize;
    let mut remaining = xml;
    while let Some(start) = remaining.find('<') {
        remaining = &remaining[start..];
        if remaining.starts_with("<![CDATA[") {
            let end = remaining.find("]]>").ok_or(FeedXmlError::Malformed)?;
            remaining = &remaining[end + 3..];
            continue;
        }
        if remaining.starts_with("<!--") {
            let end = remaining.find("-->").ok_or(FeedXmlError::Malformed)?;
            remaining = &remaining[end + 3..];
            continue;
        }
        if remaining.starts_with("<?") {
            let end = remaining.find("?>").ok_or(FeedXmlError::Malformed)?;
            remaining = &remaining[end + 2..];
            continue;
        }
        if remaining.starts_with("<!") {
            // DTD 与实体声明不属于公开 feed 支持范围。
            return Err(FeedXmlError::Malformed);
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
                        return Err(FeedXmlError::Malformed);
                    }
                }
                b'>' => {
                    end = Some(index);
                    break;
                }
                _ => {}
            }
        }
        let end = end.ok_or(FeedXmlError::Malformed)?;
        let tag = &remaining[..=end];
        if tag.starts_with("</") {
            scopes.pop().ok_or(FeedXmlError::Malformed)?;
        } else {
            // 保守统计标签中的 xmlns 标记，避免继承命名空间的累计复制放大。
            let declarations = tag.matches("xmlns").count();
            total_namespaces += declarations;
            let in_scope = scopes.last().copied().unwrap_or(0) + declarations;
            if in_scope > MAX_NAMESPACES_IN_SCOPE
                || total_namespaces > MAX_NAMESPACE_DECLARATIONS
                || scopes.len() >= MAX_DEPTH
            {
                return Err(FeedXmlError::Malformed);
            }
            if !tag[..end].trim_end().ends_with('/') {
                scopes.push(in_scope);
            }
        }
        remaining = &remaining[end + 1..];
    }
    Ok(())
}

/// 去掉 UTF-8 BOM 后按预算解析；DTD 永远关闭，节点数受 `max_nodes` 约束。
pub(crate) fn parse_document<'input>(
    xml: &'input str,
    max_nodes: u32,
) -> Result<Document<'input>, FeedXmlError> {
    let xml = xml.trim_start_matches('\u{feff}');
    preflight_xml(xml, max_nodes)?;
    Document::parse_with_options(
        xml,
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: max_nodes,
            ..ParsingOptions::default()
        },
    )
    .map_err(|_| FeedXmlError::Malformed)
}

/// 按本地名（忽略命名空间前缀）查找直接子元素。
pub(crate) fn child<'a, 'input>(node: Node<'a, 'input>, tag: &str) -> Option<Node<'a, 'input>> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == tag)
}

/// 拼接节点内全部文本后代；不同文本块之间以单个空格分隔。
pub(crate) fn text(node: Node<'_, '_>) -> String {
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

/// 输出只能当纯文本显示。去掉常见 HTML 标记与脚本/样式，折叠空白，并按字符限长。
pub(crate) fn plain_text(input: &str, max_chars: usize) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preflight_rejects_dtd_and_budget_breach() {
        assert_eq!(preflight_xml("<rss><channel/></rss>", 100), Ok(()));
        assert_eq!(
            preflight_xml("<!DOCTYPE rss [<!ENTITY a 'b'>]><rss/>", 100),
            Err(FeedXmlError::Malformed)
        );
        // 预检只查资源形状，不保证闭合配对；孤立闭标签在这里就拒绝。
        assert_eq!(preflight_xml("</a>", 100), Err(FeedXmlError::Malformed));
        assert_eq!(
            preflight_xml("<a><b/><c/><d/></a>", 3),
            Err(FeedXmlError::Malformed)
        );
    }

    #[test]
    fn parse_document_trims_bom_and_keeps_namespaces() {
        let document = parse_document(
            "\u{feff}<rss xmlns:ce=\"urn:c\"><channel><ce:x>1</ce:x></channel></rss>",
            100,
        )
        .unwrap();
        let channel = child(document.root_element(), "channel").unwrap();
        let node = channel.children().find(|n| n.is_element()).unwrap();
        assert_eq!(node.text(), Some("1"));
        assert!(parse_document("<rss>", 100).is_err());
    }

    #[test]
    fn plain_text_drops_script_bodies_and_decodes_entities() {
        assert_eq!(
            plain_text("a&lt;b<script>evil()</script>c&nbsp;d", 40),
            "a<b c d"
        );
        assert_eq!(plain_text("中文&nbsp;空格", 40), "中文 空格");
        // 前导空白被折叠，不保留缩进。
        assert_eq!(plain_text(" truncate me", 8), "truncate");
    }
}
