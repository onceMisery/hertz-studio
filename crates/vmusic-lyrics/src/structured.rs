// SPDX-License-Identifier: MIT
//! Explicit import validation. XML is never reinterpreted as a failed LRC file.
use roxmltree::{Document, Node, ParsingOptions};
use vmusic_core::{LyricDocument, LyricLine, LyricSource, LyricWord};

pub const MAX_BYTES: usize = 256 * 1024;
pub const MAX_LINES: usize = 2048;
pub const MAX_WORDS: usize = 16384;
pub const MAX_TIME_MS: u64 = 86_400_000;
const TT: &str = "http://www.w3.org/ns/ttml";
const PARAM: &str = "http://www.w3.org/ns/ttml#parameter";
const META: &str = "http://www.w3.org/ns/ttml#metadata";
const XML: &str = "http://www.w3.org/XML/1998/namespace";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ImportError {
    #[error("歌词超过大小或结构上限")]
    Limit,
    #[error("歌词格式或 TTML 子集暂不支持")]
    Unsupported,
    #[error("歌词结构或时间轴无效")]
    Invalid,
    #[error("未找到有效的带时间歌词")]
    Empty,
}

pub fn parse_import(input: &str, format: &str) -> Result<LyricDocument, ImportError> {
    if input.len() > MAX_BYTES {
        return Err(ImportError::Limit);
    }
    let input = input.trim_start_matches('\u{feff}').trim();
    let format = match format {
        "auto" if input.starts_with('<') => "ttml",
        "auto" => "lrc",
        other => other,
    };
    let doc = match format {
        "lrc" => {
            // Reject partial imports while preserving the tolerant legacy reader.
            if input.starts_with('<') {
                return Err(ImportError::Unsupported);
            }
            for raw in input.lines().map(str::trim).filter(|s| !s.is_empty()) {
                if let Some(value) = super::tag_value(raw, "offset") {
                    let value = value.parse::<i64>().map_err(|_| ImportError::Invalid)?;
                    if value.unsigned_abs() > 60_000 {
                        return Err(ImportError::Invalid);
                    }
                }
                let header = raw
                    .strip_prefix('[')
                    .and_then(|s| s.strip_suffix(']'))
                    .and_then(|s| s.split_once(':'))
                    .is_some_and(|(key, _)| {
                        !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphabetic())
                    });
                if !header && super::parse_lyric_line(raw)?.is_empty() {
                    return Err(ImportError::Invalid);
                }
            }
            super::parse_lrc_bounded(input)?
        }
        "ttml" => parse_ttml(input)?,
        _ => return Err(ImportError::Unsupported),
    };
    validate(&doc)?;
    Ok(doc)
}

pub fn validate(doc: &LyricDocument) -> Result<(), ImportError> {
    if doc.lines.is_empty() || doc.lines.iter().all(|l| l.text.trim().is_empty()) {
        return Err(ImportError::Empty);
    }
    if doc.lines.len() > MAX_LINES
        || doc.lines.iter().map(|l| l.words.len()).sum::<usize>() > MAX_WORDS
        || doc
            .lines
            .iter()
            .map(|l| l.text.len() + l.words.iter().map(|w| w.text.len()).sum::<usize>())
            .sum::<usize>()
            > MAX_BYTES * 2
    {
        return Err(ImportError::Limit);
    }
    for parallel in [&doc.translation, &doc.romanization].into_iter().flatten() {
        if parallel.len() != doc.lines.len()
            || parallel.iter().map(String::len).sum::<usize>() > MAX_BYTES
        {
            return Err(ImportError::Invalid);
        }
    }
    if doc.lines.windows(2).any(|w| w[0].start_ms > w[1].start_ms) {
        return Err(ImportError::Invalid);
    }
    if doc.offset_ms.unsigned_abs() > 60_000 {
        return Err(ImportError::Invalid);
    }
    for line in &doc.lines {
        if line.start_ms > MAX_TIME_MS
            || line
                .end_ms
                .is_some_and(|e| e < line.start_ms || e > MAX_TIME_MS)
        {
            return Err(ImportError::Invalid);
        }
        let mut previous = line.start_ms;
        for word in &line.words {
            if word.start_ms < previous
                || word.start_ms > MAX_TIME_MS
                || word
                    .end_ms
                    .is_some_and(|e| e < word.start_ms || e > MAX_TIME_MS)
                || line
                    .end_ms
                    .is_some_and(|e| word.start_ms > e || word.end_ms.is_some_and(|w| w > e))
            {
                return Err(ImportError::Invalid);
            }
            previous = word.end_ms.unwrap_or(word.start_ms);
        }
    }
    Ok(())
}

fn decimal(text: &str, scale: u64) -> Result<u64, ImportError> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 3
        || (text.contains('.') && fraction.is_empty())
    {
        return Err(ImportError::Invalid);
    }
    let whole: u64 = whole.parse().map_err(|_| ImportError::Invalid)?;
    let fraction_value: u64 = if fraction.is_empty() {
        0
    } else {
        fraction.parse().map_err(|_| ImportError::Invalid)?
    };
    let denominator = 10u64.pow(fraction.len() as u32);
    // Millisecond integer model: reject sub-ms values instead of rounding away order.
    let numerator = fraction_value
        .checked_mul(scale)
        .ok_or(ImportError::Invalid)?;
    if numerator % denominator != 0 {
        return Err(ImportError::Unsupported);
    }
    whole
        .checked_mul(scale)
        .and_then(|v| v.checked_add(numerator / denominator))
        .filter(|v| *v <= MAX_TIME_MS)
        .ok_or(ImportError::Invalid)
}

fn time(text: &str) -> Result<u64, ImportError> {
    if let Some(ms) = text.strip_suffix("ms") {
        return decimal(ms, 1);
    }
    if let Some(s) = text.strip_suffix('s') {
        return decimal(s, 1000);
    }
    let fields: Vec<_> = text.split(':').collect();
    if fields.len() != 3 {
        return Err(ImportError::Unsupported);
    }
    if fields[0].len() < 2
        || fields[1].len() != 2
        || fields[2].split('.').next().unwrap_or("").len() != 2
    {
        return Err(ImportError::Invalid);
    }
    let hours = decimal(fields[0], 3_600_000)?;
    let minutes = decimal(fields[1], 60_000)?;
    let seconds = decimal(fields[2], 1000)?;
    if minutes >= 3_600_000 || seconds >= 60_000 {
        return Err(ImportError::Invalid);
    }
    hours
        .checked_add(minutes)
        .and_then(|v| v.checked_add(seconds))
        .filter(|v| *v <= MAX_TIME_MS)
        .ok_or(ImportError::Invalid)
}

#[derive(Clone, Copy)]
struct Interval {
    start: u64,
    end: Option<u64>,
}
fn interval(node: Node<'_, '_>, parent: Interval) -> Result<Interval, ImportError> {
    if node.attribute("timeContainer").is_some_and(|s| s != "par") {
        return Err(ImportError::Unsupported);
    }
    let start = parent
        .start
        .checked_add(node.attribute("begin").map(time).transpose()?.unwrap_or(0))
        .ok_or(ImportError::Invalid)?;
    let explicit_end = node
        .attribute("end")
        .map(time)
        .transpose()?
        .map(|t| parent.start.checked_add(t).ok_or(ImportError::Invalid))
        .transpose()?;
    let duration_end = node
        .attribute("dur")
        .map(time)
        .transpose()?
        .map(|t| start.checked_add(t).ok_or(ImportError::Invalid))
        .transpose()?;
    let end = match (explicit_end, duration_end) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b).or(parent.end),
    };
    if start > MAX_TIME_MS
        || end.is_some_and(|e| e <= start || e > MAX_TIME_MS)
        || parent
            .end
            .is_some_and(|p| start >= p || end.is_some_and(|e| e > p))
    {
        return Err(ImportError::Invalid);
    }
    Ok(Interval { start, end })
}

fn preserved(node: Node<'_, '_>) -> bool {
    node.ancestors()
        .find_map(|n| n.attribute((XML, "space")))
        .is_some_and(|s| s == "preserve")
}
fn text(node: Node<'_, '_>) -> String {
    let mut out = String::new();
    for n in node.descendants() {
        if n.is_text() {
            if preserved(n) {
                out.push_str(n.text().unwrap_or(""));
            } else {
                for c in n.text().unwrap_or("").chars() {
                    if c.is_whitespace() {
                        if !out.ends_with([' ', '\n']) {
                            out.push(' ');
                        }
                    } else {
                        out.push(c);
                    }
                }
            }
        } else if n.is_element() && n.tag_name().name() == "br" {
            out.push('\n');
        }
    }
    out
}

fn parse_ttml(input: &str) -> Result<LyricDocument, ImportError> {
    let xml = Document::parse_with_options(
        input,
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: 32768,
            ..Default::default()
        },
    )
    .map_err(|_| ImportError::Invalid)?;
    let root = xml.root_element();
    if root.tag_name().namespace() != Some(TT) || root.tag_name().name() != "tt" {
        return Err(ImportError::Unsupported);
    }
    if root
        .attribute((PARAM, "timeBase"))
        .is_some_and(|s| s != "media")
    {
        return Err(ImportError::Unsupported);
    }
    // Presentation, external assets, regions, animations, frame/tick/clock timing,
    // and arbitrary metadata are intentionally outside this import subset.
    for node in root.descendants().filter(Node::is_element) {
        if node.ancestors().filter(Node::is_element).count() > 16 {
            return Err(ImportError::Limit);
        }
        if node.tag_name().namespace() != Some(TT)
            || !matches!(
                node.tag_name().name(),
                "tt" | "body" | "div" | "p" | "span" | "br"
            )
        {
            return Err(ImportError::Unsupported);
        }
        for attr in node.attributes() {
            let known = match attr.namespace() {
                None => {
                    matches!(node.tag_name().name(), "body" | "div" | "p" | "span")
                        && matches!(attr.name(), "begin" | "end" | "dur" | "timeContainer")
                }
                Some(XML) => matches!(attr.name(), "lang" | "space" | "id"),
                Some(PARAM) => node == root && attr.name() == "timeBase" && attr.value() == "media",
                Some(META) => {
                    node.tag_name().name() == "span"
                        && attr.name() == "role"
                        && matches!(attr.value(), "x-translation" | "x-roman")
                }
                _ => false,
            };
            if !known {
                return Err(ImportError::Unsupported);
            }
            if attr.namespace() == Some(XML)
                && attr.name() == "space"
                && !matches!(attr.value(), "default" | "preserve")
            {
                return Err(ImportError::Unsupported);
            }
        }
        if node.attribute("timeContainer").is_some_and(|v| v != "par") {
            return Err(ImportError::Unsupported);
        }
        let parent = node.parent_element().map(|p| p.tag_name().name());
        let valid = match node.tag_name().name() {
            "tt" => node == root,
            "body" => parent == Some("tt"),
            "div" => matches!(parent, Some("body" | "div")),
            "p" => matches!(parent, Some("body" | "div")),
            "span" | "br" => matches!(parent, Some("p" | "span")),
            _ => false,
        };
        if !valid {
            return Err(ImportError::Invalid);
        }
        if !matches!(node.tag_name().name(), "p" | "span")
            && node
                .children()
                .any(|n| n.is_text() && !n.text().unwrap_or("").trim().is_empty())
        {
            return Err(ImportError::Invalid);
        }
    }
    if root
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "body")
        .count()
        != 1
    {
        return Err(ImportError::Invalid);
    }
    let mut doc = LyricDocument::empty();
    doc.source = LyricSource::Imported;
    doc.format = Some("ttml".into());
    let mut translations = Vec::new();
    let mut romanization = Vec::new();
    for p in root
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "p")
    {
        if doc.lines.len() >= MAX_LINES {
            return Err(ImportError::Limit);
        }
        let mut ancestors: Vec<_> = p.ancestors().filter(Node::is_element).collect();
        ancestors.reverse();
        let mut span = Interval {
            start: 0,
            end: None,
        };
        for n in ancestors {
            span = interval(n, span)?;
        }
        let mut line = LyricLine {
            start_ms: span.start,
            end_ms: span.end,
            text: String::new(),
            words: Vec::new(),
        };
        let mut translation = String::new();
        let mut roman = String::new();
        let mut untimed = false;
        for child in p.children() {
            if child.is_text() {
                let part = text(child);
                if !part.trim().is_empty() {
                    untimed = true;
                }
                line.text.push_str(&part);
                if part.trim().is_empty() {
                    if let Some(w) = line.words.last_mut() {
                        w.text.push_str(&part);
                    }
                }
                continue;
            }
            if !child.is_element() {
                continue;
            }
            if child.tag_name().name() == "br" {
                line.text.push('\n');
                if let Some(w) = line.words.last_mut() {
                    w.text.push('\n');
                }
                continue;
            }
            if child.descendants().skip(1).any(|n| {
                n.is_element()
                    && (n.has_attribute("begin")
                        || n.has_attribute("end")
                        || n.has_attribute("dur")
                        || n.has_attribute((META, "role")))
            }) {
                return Err(ImportError::Unsupported);
            }
            let role = child.attribute((META, "role"));
            let part = text(child);
            if let Some(role) = role {
                if child.has_attribute("begin")
                    || child.has_attribute("end")
                    || child.has_attribute("dur")
                {
                    return Err(ImportError::Unsupported);
                }
                let target = if role == "x-translation" {
                    &mut translation
                } else {
                    &mut roman
                };
                if !target.is_empty() {
                    return Err(ImportError::Invalid);
                }
                *target = part.trim().into();
                continue;
            }
            if child.has_attribute("begin")
                || child.has_attribute("end")
                || child.has_attribute("dur")
            {
                let word = interval(child, span)?;
                if word.end.is_none() || part.is_empty() {
                    return Err(ImportError::Invalid);
                }
                line.words.push(LyricWord {
                    start_ms: word.start,
                    end_ms: word.end,
                    text: part.clone(),
                });
            } else if !part.trim().is_empty() {
                untimed = true;
            }
            line.text.push_str(&part);
        }
        if !preserved(p) {
            line.text = line.text.trim().into();
            if let Some(w) = line.words.first_mut() {
                w.text = w.text.trim_start().into();
            }
            if let Some(w) = line.words.last_mut() {
                w.text = w.text.trim_end().into();
            }
        }
        if untimed && !line.words.is_empty() {
            return Err(ImportError::Unsupported);
        }
        if line.words.is_empty()
            && !p.ancestors().any(|n| {
                n.is_element()
                    && (n.has_attribute("begin")
                        || n.has_attribute("end")
                        || n.has_attribute("dur"))
            })
        {
            return Err(ImportError::Invalid);
        }
        if line.text.is_empty() {
            return Err(ImportError::Empty);
        }
        if let Some(prev) = doc.lines.last() {
            if prev.start_ms >= line.start_ms || prev.end_ms.is_some_and(|e| e > line.start_ms) {
                return Err(ImportError::Invalid);
            }
        }
        doc.lines.push(line);
        translations.push(translation);
        romanization.push(roman);
    }
    let words = doc.lines.iter().filter(|l| !l.words.is_empty()).count();
    doc.timing_precision = Some(
        if words == 0 {
            "line"
        } else if words == doc.lines.len() {
            "word"
        } else {
            "mixed"
        }
        .into(),
    );
    if translations.iter().any(|s| !s.is_empty()) {
        doc.translation = Some(translations);
    }
    if romanization.iter().any(|s| !s.is_empty()) {
        doc.romanization = Some(romanization);
    }
    Ok(doc)
}
