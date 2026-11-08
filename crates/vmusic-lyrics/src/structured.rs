// SPDX-License-Identifier: MIT
//! Explicit import validation. XML is never reinterpreted as a failed LRC file.
use roxmltree::{Document, Node, ParsingOptions};
use vmusic_core::{
    LyricAgent, LyricAgentKind, LyricDocument, LyricLine, LyricSource, LyricVocal, LyricVocalRole,
    LyricWord,
};

pub const MAX_BYTES: usize = 256 * 1024;
pub const MAX_LINES: usize = 2048;
pub const MAX_WORDS: usize = 16384;
pub const MAX_TIME_MS: u64 = 86_400_000;
pub const MAX_PRESENTATION_TIME_MS: u64 = 86_522_000;
pub const MAX_AGENTS: usize = 32;
pub const MAX_AGENT_BYTES: usize = 128;
pub const MAX_LINE_AGENTS: usize = 8;
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
    #[error("{category}（第{row}行，第{column}列：{reason}）")]
    At {
        category: ImportErrorCategory,
        row: u32,
        column: u32,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ImportErrorCategory {
    #[error("歌词超过大小或结构上限")]
    Limit,
    #[error("歌词包含暂不支持的内容")]
    Unsupported,
    #[error("歌词结构或时间轴无效")]
    Invalid,
    #[error("未找到有效的带时间歌词")]
    Empty,
}

impl ImportError {
    pub fn category(self) -> Self {
        match self {
            Self::At {
                category: ImportErrorCategory::Limit,
                ..
            } => Self::Limit,
            Self::At {
                category: ImportErrorCategory::Unsupported,
                ..
            } => Self::Unsupported,
            Self::At {
                category: ImportErrorCategory::Invalid,
                ..
            } => Self::Invalid,
            Self::At {
                category: ImportErrorCategory::Empty,
                ..
            } => Self::Empty,
            other => other,
        }
    }

    fn at(self, node: Node<'_, '_>, reason: &'static str) -> Self {
        if matches!(self, Self::At { .. }) {
            return self;
        }
        let pos = node.document().text_pos_at(node.range().start);
        let category = match self {
            Self::Limit => ImportErrorCategory::Limit,
            Self::Unsupported => ImportErrorCategory::Unsupported,
            Self::Invalid => ImportErrorCategory::Invalid,
            _ => ImportErrorCategory::Empty,
        };
        Self::At {
            category,
            row: pos.row,
            column: pos.col,
            reason,
        }
    }
}

pub fn parse_import(input: &str, format: &str) -> Result<LyricDocument, ImportError> {
    if input.len() > MAX_BYTES {
        return Err(ImportError::Limit);
    }
    let start = input.trim_start_matches('\u{feff}').trim_start();
    let prefix = &input[..input.len() - start.len()];
    let input = start.trim_end();
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
            super::parse_lrc_checked(input)?
        }
        "ttml" => parse_ttml(input).map_err(|error| match error {
            ImportError::At {
                category,
                row,
                column,
                reason,
            } => ImportError::At {
                category,
                row: row + prefix.bytes().filter(|byte| *byte == b'\n').count() as u32,
                column: column
                    + if row == 1 {
                        prefix
                            .rsplit('\n')
                            .next()
                            .unwrap_or_default()
                            .chars()
                            .count() as u32
                    } else {
                        0
                    },
                reason,
            },
            other => other,
        })?,
        _ => return Err(ImportError::Unsupported),
    };
    validate(&doc)?;
    Ok(doc)
}

pub fn validate(doc: &LyricDocument) -> Result<(), ImportError> {
    validate_timeline(doc, false)
}

pub fn validate_presentation(doc: &LyricDocument) -> Result<(), ImportError> {
    validate_timeline(doc, true)
}

pub fn valid_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_AGENT_BYTES
        && !id.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn validate_timeline(doc: &LyricDocument, presentation: bool) -> Result<(), ImportError> {
    let limit = if presentation {
        MAX_PRESENTATION_TIME_MS
    } else {
        MAX_TIME_MS
    };
    let vocals = doc.has_vocals();
    if doc.lines.is_empty() || doc.lines.iter().all(|l| l.text.trim().is_empty()) {
        return Err(ImportError::Empty);
    }
    if doc.lines.len() > MAX_LINES
        || doc.agents.len() > MAX_AGENTS
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
    if doc.offset_ms.unsigned_abs() > if presentation { 122_000 } else { 60_000 } {
        return Err(ImportError::Invalid);
    }
    let mut ids = std::collections::HashMap::new();
    for (index, agent) in doc.agents.iter().enumerate() {
        if agent.id.len() > MAX_AGENT_BYTES {
            return Err(ImportError::Limit);
        }
        if !valid_agent_id(&agent.id) || ids.insert(agent.id.as_str(), index).is_some() {
            return Err(ImportError::Invalid);
        }
        if agent
            .name
            .as_ref()
            .is_some_and(|name| name.len() > MAX_AGENT_BYTES)
        {
            return Err(ImportError::Limit);
        }
        if agent
            .name
            .as_ref()
            .is_some_and(|name| name.trim().is_empty())
        {
            return Err(ImportError::Invalid);
        }
    }
    let mut latest_end = 0;
    let mut unlabelled_end = 0;
    for line in &doc.lines {
        if line.start_ms > limit || line.end_ms.is_some_and(|e| e < line.start_ms || e > limit) {
            return Err(ImportError::Invalid);
        }
        if let Some(vocal) = &line.vocal {
            if vocal.agent_ids.is_empty() || vocal.agent_ids.len() > MAX_LINE_AGENTS {
                return Err(ImportError::Limit);
            }
            let mut previous = None;
            for id in &vocal.agent_ids {
                let index = *ids.get(id.as_str()).ok_or(ImportError::Invalid)?;
                if previous.is_some_and(|p| p >= index) {
                    return Err(ImportError::Invalid);
                }
                previous = Some(index);
            }
        }
        if vocals {
            let end = line.end_ms.ok_or(ImportError::Invalid)?;
            if (end == line.start_ms && (!presentation || end > 2000))
                || line.text.trim().is_empty()
            {
                return Err(ImportError::Invalid);
            }
            if end > line.start_ms {
                if line.start_ms < unlabelled_end
                    || (line.vocal.is_none() && line.start_ms < latest_end)
                {
                    return Err(ImportError::Invalid);
                }
                latest_end = latest_end.max(end);
                if line.vocal.is_none() {
                    unlabelled_end = unlabelled_end.max(end);
                }
            }
        }
        let mut previous = line.start_ms;
        for word in &line.words {
            if word.start_ms < previous
                || word.start_ms > limit
                || word.end_ms.is_some_and(|e| e < word.start_ms || e > limit)
                || line
                    .end_ms
                    .is_some_and(|e| word.start_ms > e || word.end_ms.is_some_and(|w| w > e))
            {
                return Err(ImportError::Invalid);
            }
            if vocals
                && (word.end_ms.is_none()
                    || (word.end_ms == Some(word.start_ms)
                        && (!presentation || word.start_ms > 2000)))
            {
                return Err(ImportError::Invalid);
            }
            previous = word.end_ms.unwrap_or(word.start_ms);
        }
        if vocals
            && !line.words.is_empty()
            && line
                .words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<String>()
                != line.text
        {
            return Err(ImportError::Invalid);
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

fn ncname(id: &str) -> bool {
    fn start(c: char) -> bool {
        matches!(c, 'A'..='Z' | 'a'..='z' | '_' | '\u{c0}'..='\u{d6}' | '\u{d8}'..='\u{f6}' | '\u{f8}'..='\u{2ff}' | '\u{370}'..='\u{37d}' | '\u{37f}'..='\u{1fff}' | '\u{200c}'..='\u{200d}' | '\u{2070}'..='\u{218f}' | '\u{2c00}'..='\u{2fef}' | '\u{3001}'..='\u{d7ff}' | '\u{f900}'..='\u{fdcf}' | '\u{fdf0}'..='\u{fffd}' | '\u{10000}'..='\u{effff}')
    }
    let mut chars = id.chars();
    chars.next().is_some_and(start) && chars.all(|c| start(c) || matches!(c, '-' | '.' | '0'..='9' | '\u{b7}' | '\u{300}'..='\u{36f}' | '\u{203f}'..='\u{2040}'))
}

fn check_structure(root: Node<'_, '_>) -> Result<(), ImportError> {
    for node in root.descendants().filter(Node::is_element) {
        if node.ancestors().filter(Node::is_element).count() > 16 {
            return Err(ImportError::Limit);
        }
        let name = node.tag_name().name();
        let namespace = node.tag_name().namespace();
        if !(namespace == Some(TT)
            && matches!(
                name,
                "tt" | "head" | "metadata" | "body" | "div" | "p" | "span" | "br"
            )
            || namespace == Some(META) && matches!(name, "agent" | "name"))
        {
            return Err(ImportError::Unsupported.at(node, "不支持的元素或命名空间"));
        }
        for attr in node.attributes() {
            let known = match attr.namespace() {
                None if namespace == Some(META) => attr.name() == "type",
                None => {
                    matches!(name, "body" | "div" | "p" | "span")
                        && matches!(attr.name(), "begin" | "end" | "dur" | "timeContainer")
                }
                Some(XML) => matches!(attr.name(), "lang" | "space" | "id"),
                Some(PARAM) => node == root && attr.name() == "timeBase" && attr.value() == "media",
                Some(META) => {
                    matches!(name, "body" | "div" | "p" | "span") && attr.name() == "agent"
                        || name == "span"
                            && attr.name() == "role"
                            && matches!(attr.value(), "x-bg" | "x-translation" | "x-roman")
                }
                _ => false,
            };
            if !known
                || attr.namespace() == Some(XML)
                    && attr.name() == "space"
                    && !matches!(attr.value(), "default" | "preserve")
                || attr.name() == "timeContainer"
                    && attr.namespace().is_none()
                    && attr.value() != "par"
            {
                return Err(ImportError::Unsupported.at(node, "不支持的属性或时间语义"));
            }
        }
        let parent = node.parent_element();
        let parent_name = parent.map(|p| p.tag_name().name());
        let parent_ns = parent.and_then(|p| p.tag_name().namespace());
        let valid = match (namespace, name) {
            (Some(TT), "tt") => node == root,
            (Some(TT), "head" | "body") => parent == Some(root),
            (Some(TT), "metadata") => parent_ns == Some(TT) && parent_name == Some("head"),
            (Some(TT), "div") => {
                parent_ns == Some(TT) && matches!(parent_name, Some("body" | "div"))
            }
            (Some(TT), "p") => parent_ns == Some(TT) && matches!(parent_name, Some("body" | "div")),
            (Some(TT), "span" | "br") => {
                parent_ns == Some(TT) && matches!(parent_name, Some("p" | "span"))
            }
            (Some(META), "agent") => {
                parent_ns == Some(TT) && matches!(parent_name, Some("head" | "metadata"))
            }
            (Some(META), "name") => parent_ns == Some(META) && parent_name == Some("agent"),
            _ => false,
        };
        if !valid {
            return Err(ImportError::Invalid.at(node, "元素所在作用域无效"));
        }
        if name == "name" && node.children().any(|n| n.is_element())
            || name == "br" && node.children().any(|n| n.is_element() || n.is_text())
            || !matches!(
                (namespace, name),
                (Some(TT), "p" | "span") | (Some(META), "name")
            ) && node
                .children()
                .any(|n| n.is_text() && !n.text().unwrap_or("").trim().is_empty())
        {
            return Err(ImportError::Invalid.at(node, "正文或姓名没有合法的唯一归属"));
        }
    }
    let children: Vec<_> = root.children().filter(Node::is_element).collect();
    if children
        .iter()
        .filter(|n| n.tag_name().name() == "body")
        .count()
        != 1
        || children
            .iter()
            .filter(|n| n.tag_name().name() == "head")
            .count()
            > 1
        || children
            .windows(2)
            .any(|w| w[0].tag_name().name() == "body" && w[1].tag_name().name() == "head")
    {
        return Err(ImportError::Invalid.at(root, "必须只有一个body，head必须置于body之前"));
    }
    Ok(())
}

fn parse_agents(root: Node<'_, '_>) -> Result<Vec<LyricAgent>, ImportError> {
    let mut agents: Vec<LyricAgent> = Vec::new();
    for node in root.descendants().filter(|n| {
        n.is_element() && n.tag_name().namespace() == Some(META) && n.tag_name().name() == "agent"
    }) {
        if agents.len() == MAX_AGENTS {
            return Err(ImportError::Limit.at(node, "声部声明超过32项"));
        }
        let id = node
            .attribute((XML, "id"))
            .ok_or_else(|| ImportError::Invalid.at(node, "agent缺少xml:id"))?;
        if id.len() > MAX_AGENT_BYTES {
            return Err(ImportError::Limit.at(node, "声部ID超过128 UTF-8字节"));
        }
        if !valid_agent_id(id) || !ncname(id) || agents.iter().any(|a| a.id == id) {
            return Err(ImportError::Invalid.at(node, "声部ID重复或不符合XML NCName"));
        }
        let kind = match node.attribute("type") {
            Some("person") => LyricAgentKind::Person,
            Some("character") => LyricAgentKind::Character,
            Some("group") => LyricAgentKind::Group,
            Some("organization") => LyricAgentKind::Organization,
            Some("other") => LyricAgentKind::Other,
            _ => return Err(ImportError::Unsupported.at(node, "agent的type缺失或不受支持")),
        };
        let mut chosen = None;
        let mut rank = 3;
        for name in node.children().filter(Node::is_element) {
            let next_rank = match name.attribute("type") {
                Some("full") => 0,
                Some("alias") => 1,
                Some("family" | "given" | "other") => 2,
                _ => return Err(ImportError::Unsupported.at(name, "name的type缺失或不受支持")),
            };
            let value = text(name);
            let value = value.trim();
            if value.len() > MAX_AGENT_BYTES {
                return Err(ImportError::Limit.at(name, "姓名超过128 UTF-8字节"));
            }
            if !value.is_empty() && next_rank < rank {
                chosen = Some(value.into());
                rank = next_rank;
            }
        }
        agents.push(LyricAgent {
            id: id.into(),
            kind,
            name: chosen,
        });
    }
    Ok(agents)
}

fn association(
    node: Node<'_, '_>,
    inherited: &[String],
    agents: &[LyricAgent],
) -> Result<Vec<String>, ImportError> {
    let Some(value) = node.attribute((META, "agent")) else {
        return Ok(inherited.to_vec());
    };
    let mut ids: Vec<_> = value.split_whitespace().collect();
    if ids.is_empty() {
        return Err(ImportError::Invalid.at(node, "声部关联不能为空"));
    }
    if ids.len() > MAX_LINE_AGENTS {
        return Err(ImportError::Limit.at(node, "联合声部超过8项"));
    }
    let mut seen = std::collections::HashSet::new();
    for id in &ids {
        if !seen.insert(*id) || !agents.iter().any(|agent| agent.id == *id) {
            return Err(ImportError::Invalid.at(node, "未知或重复声部ID引用"));
        }
    }
    ids.sort_by_key(|id| {
        agents
            .iter()
            .position(|a| a.id == *id)
            .unwrap_or(MAX_AGENTS)
    });
    Ok(ids.into_iter().map(String::from).collect())
}

#[derive(Clone)]
struct Context {
    interval: Interval,
    ids: Vec<String>,
    timed_owner: Option<usize>,
}
#[derive(Clone)]
struct Leaf {
    text: String,
    context: Context,
    position: usize,
    preserve: bool,
}
struct Row {
    line: LyricLine,
    translation: Option<String>,
    roman: Option<String>,
    positions: Vec<usize>,
    origin: usize,
}
struct Subtitle {
    scope: std::ops::Range<usize>,
    role: &'static str,
    text: String,
    origin: usize,
}

fn has_time(node: Node<'_, '_>) -> bool {
    ["begin", "end", "dur"]
        .iter()
        .any(|name| node.has_attribute(*name))
}

fn check_intervals(node: Node<'_, '_>, parent: Interval) -> Result<(), ImportError> {
    let next = if node.tag_name().namespace() == Some(TT)
        && matches!(node.tag_name().name(), "body" | "div" | "p" | "span")
    {
        interval(node, parent).map_err(|e| e.at(node, "时间表达式无效或超出父区间"))?
    } else {
        parent
    };
    for child in node.children().filter(Node::is_element) {
        check_intervals(child, next)?;
    }
    Ok(())
}

fn child_context(
    node: Node<'_, '_>,
    parent: &Context,
    agents: &[LyricAgent],
) -> Result<Context, ImportError> {
    Ok(Context {
        interval: interval(node, parent.interval)
            .map_err(|e| e.at(node, "时间区间无效或超出父区间"))?,
        ids: association(node, &parent.ids, agents)?,
        timed_owner: if has_time(node) {
            Some(node.range().start)
        } else {
            parent.timed_owner
        },
    })
}

fn gather(
    node: Node<'_, '_>,
    context: &Context,
    agents: &[LyricAgent],
    backing: bool,
    leaves: &mut Vec<Leaf>,
    subtitles: &mut Vec<Subtitle>,
    backgrounds: &mut Vec<Row>,
) -> Result<(), ImportError> {
    for child in node.children() {
        if child.is_text() {
            leaves.push(Leaf {
                text: text(child),
                context: context.clone(),
                position: child.range().start,
                preserve: preserved(child),
            });
        } else if child.is_element() {
            match child.attribute((META, "role")) {
                Some("x-translation" | "x-roman") => {
                    if child.descendants().filter(Node::is_element).any(|n| {
                        has_time(n)
                            || n.has_attribute((META, "agent"))
                            || n != child && n.has_attribute((META, "role"))
                    }) {
                        return Err(ImportError::Unsupported
                            .at(child, "副文本不能另带身份、时间或嵌套角色"));
                    }
                    subtitles.push(Subtitle {
                        scope: node.range(),
                        role: if child.attribute((META, "role")) == Some("x-roman") {
                            "roman"
                        } else {
                            "translation"
                        },
                        text: text(child).trim().into(),
                        origin: child.range().start,
                    });
                }
                Some("x-bg") => {
                    if backing {
                        return Err(ImportError::Unsupported.at(child, "不支持嵌套背景声部"));
                    }
                    let next = child_context(child, context, agents)?;
                    if next.ids.is_empty() || next.interval.end.is_none() {
                        return Err(
                            ImportError::Invalid.at(child, "背景内容必须有真实身份和有限区间")
                        );
                    }
                    backgrounds.extend(scope_rows(child, next, agents, true)?);
                }
                _ if child.tag_name().name() == "br" => leaves.push(Leaf {
                    text: "\n".into(),
                    context: context.clone(),
                    position: child.range().start,
                    preserve: true,
                }),
                _ => {
                    let next = child_context(child, context, agents)?;
                    gather(
                        child,
                        &next,
                        agents,
                        backing,
                        leaves,
                        subtitles,
                        backgrounds,
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn make_row(
    leaves: &[Leaf],
    span: Interval,
    ids: &[String],
    backing: bool,
    preserve: bool,
) -> Result<Row, ImportError> {
    let mut line = LyricLine {
        start_ms: span.start,
        end_ms: span.end,
        text: String::new(),
        words: Vec::new(),
        vocal: if ids.is_empty() {
            None
        } else {
            Some(LyricVocal {
                agent_ids: ids.to_vec(),
                role: if backing {
                    LyricVocalRole::Backing
                } else {
                    LyricVocalRole::Lead
                },
            })
        },
    };
    let mut untimed = false;
    let mut word_owner = None;
    let mut leading = String::new();
    let mut positions = Vec::new();
    for leaf in leaves {
        let mut part = String::new();
        for c in leaf.text.chars() {
            if !leaf.preserve
                && c.is_whitespace()
                && (part.ends_with([' ', '\n'])
                    || part.is_empty() && line.text.ends_with([' ', '\n']))
            {
                continue;
            }
            part.push(c);
        }
        if part.trim().is_empty() {
            line.text.push_str(&part);
            if let Some(word) = line.words.last_mut() {
                word.text.push_str(&part);
            } else {
                leading.push_str(&part);
            }
            continue;
        }
        positions.push(leaf.position);
        if let Some(owner) = leaf.context.timed_owner {
            if leaf.context.interval.end.is_none() {
                return Err(ImportError::Invalid);
            }
            if word_owner == Some(owner) {
                line.words
                    .last_mut()
                    .ok_or(ImportError::Invalid)?
                    .text
                    .push_str(&part);
            } else {
                let word_text = if line.words.is_empty() {
                    std::mem::take(&mut leading) + &part
                } else {
                    part.clone()
                };
                line.words.push(LyricWord {
                    start_ms: leaf.context.interval.start,
                    end_ms: leaf.context.interval.end,
                    text: word_text,
                });
                word_owner = Some(owner);
            }
        } else {
            untimed = true;
        }
        line.text.push_str(&part);
    }
    if untimed && !line.words.is_empty() {
        return Err(ImportError::Unsupported);
    }
    if !preserve {
        line.text = line.text.trim().into();
        if let Some(word) = line.words.first_mut() {
            word.text = word.text.trim_start().into();
        }
        if let Some(word) = line.words.last_mut() {
            word.text = word.text.trim_end().into();
        }
    }
    let origin = *positions.first().ok_or(ImportError::Empty)?;
    Ok(Row {
        line,
        translation: None,
        roman: None,
        positions,
        origin,
    })
}

fn scope_rows(
    scope: Node<'_, '_>,
    mut context: Context,
    agents: &[LyricAgent],
    backing: bool,
) -> Result<Vec<Row>, ImportError> {
    // The scope interval is a real row boundary, not an invented word timing.
    context.timed_owner = None;
    let mut leaves = Vec::new();
    let mut subtitles = Vec::new();
    let mut backgrounds = Vec::new();
    gather(
        scope,
        &context,
        agents,
        backing,
        &mut leaves,
        &mut subtitles,
        &mut backgrounds,
    )?;
    let changed = leaves
        .iter()
        .filter(|l| !l.text.trim().is_empty())
        .any(|leaf| leaf.context.ids != context.ids);
    let mut rows = Vec::new();
    if changed {
        let mut units: Vec<Vec<Leaf>> = Vec::new();
        let mut pending = Vec::new();
        for leaf in leaves {
            if leaf.text.trim().is_empty() {
                if let Some(unit) = units.last_mut() {
                    unit.push(leaf);
                } else {
                    pending.push(leaf);
                }
                continue;
            }
            let owner = leaf.context.timed_owner.ok_or_else(|| {
                ImportError::Invalid.at(scope, "换身份正文必须归入明确的定时片段")
            })?;
            if let Some(unit) = units.last_mut().filter(|unit| {
                unit.iter()
                    .find(|l| !l.text.trim().is_empty())
                    .is_some_and(|first| {
                        first.context.timed_owner == Some(owner)
                            && first.context.ids == leaf.context.ids
                    })
            }) {
                unit.push(leaf);
            } else {
                let mut unit = std::mem::take(&mut pending);
                unit.push(leaf);
                units.push(unit);
            }
        }
        for unit in units {
            let first = unit
                .iter()
                .find(|l| !l.text.trim().is_empty())
                .ok_or(ImportError::Empty)?;
            rows.push(
                make_row(
                    &unit,
                    first.context.interval,
                    &first.context.ids,
                    backing,
                    true,
                )
                .map_err(|e| e.at(scope, "片段时间或正文/词归属无效"))?,
            );
        }
        if !preserved(scope) {
            if let Some(first) = rows.first_mut() {
                first.line.text = first.line.text.trim_start().into();
                if let Some(word) = first.line.words.first_mut() {
                    word.text = word.text.trim_start().into();
                }
            }
            if let Some(last) = rows.last_mut() {
                last.line.text = last.line.text.trim_end().into();
                if let Some(word) = last.line.words.last_mut() {
                    word.text = word.text.trim_end().into();
                }
            }
        }
    } else if leaves.iter().any(|l| !l.text.trim().is_empty()) {
        let row = make_row(
            &leaves,
            context.interval,
            &context.ids,
            backing,
            preserved(scope),
        )
        .map_err(|e| e.at(scope, "正文混合了有时和无时内容"))?;
        if row.line.words.is_empty() && !scope.ancestors().any(|n| n.is_element() && has_time(n)) {
            return Err(ImportError::Invalid.at(scope, "正文缺少作者时间区间"));
        }
        rows.push(row);
    }
    // Adjacent equal-identity fragments can share a row only when no subtitle
    // boundary would be lost; different real timing units remain real words.
    if changed {
        let mut merged: Vec<Row> = Vec::new();
        for row in rows {
            if let Some(previous) = merged.last_mut().filter(|p| {
                p.line.vocal == row.line.vocal
                    && p.line.end_ms == Some(row.line.start_ms)
                    && p.translation.is_none()
                    && p.roman.is_none()
                    && row.translation.is_none()
                    && row.roman.is_none()
                    && !backgrounds.iter().any(|bg| {
                        bg.origin > *p.positions.last().unwrap_or(&p.origin)
                            && bg.origin < row.origin
                    })
                    && !subtitles.iter().any(|s| {
                        p.positions.iter().any(|pos| s.scope.contains(pos))
                            != row.positions.iter().any(|pos| s.scope.contains(pos))
                    })
            }) {
                previous.line.end_ms = row.line.end_ms;
                previous.line.text.push_str(&row.line.text);
                previous.line.words.extend(row.line.words);
                previous.positions.extend(row.positions);
            } else {
                merged.push(row);
            }
        }
        rows = merged;
    }
    for subtitle in subtitles {
        let candidates: Vec<_> = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.positions.iter().any(|pos| subtitle.scope.contains(pos)))
            .map(|(index, _)| index)
            .collect();
        if candidates.len() != 1 {
            let pos = scope.document().text_pos_at(subtitle.origin);
            return Err(ImportError::At {
                category: ImportErrorCategory::Invalid,
                row: pos.row,
                column: pos.col,
                reason: "副文本作用域没有唯一正文行",
            });
        }
        let row = &mut rows[candidates[0]];
        let target = if subtitle.role == "roman" {
            &mut row.roman
        } else {
            &mut row.translation
        };
        if target.is_some() {
            return Err(ImportError::Invalid.at(scope, "同一正文的同类副文本重复声明"));
        }
        *target = Some(subtitle.text);
    }
    rows.extend(backgrounds);
    if rows.is_empty() {
        return Err(ImportError::Empty.at(scope, "正文为空，不能部分导入其余段落"));
    }
    if rows.len() > MAX_LINES {
        return Err(ImportError::Limit.at(scope, "展开超过2048行"));
    }
    Ok(rows)
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
    .map_err(|error| {
        if matches!(error, roxmltree::Error::NodesLimitReached) {
            ImportError::Limit
        } else {
            let pos = error.pos();
            ImportError::At {
                category: ImportErrorCategory::Invalid,
                row: pos.row,
                column: pos.col,
                reason: "XML结构无效",
            }
        }
    })?;
    let root = xml.root_element();
    if root.tag_name().namespace() != Some(TT) || root.tag_name().name() != "tt" {
        return Err(ImportError::Unsupported.at(root, "根元素必须为TTML tt"));
    }
    check_structure(root)?;
    check_intervals(
        root,
        Interval {
            start: 0,
            end: None,
        },
    )?;
    let agents = parse_agents(root)?;
    // Validate all associations, including unused body/div/span and subtitle
    // attributes, so an unreferenced illegal ID cannot silently disappear.
    for node in root
        .descendants()
        .filter(|n| n.is_element() && n.has_attribute((META, "agent")))
    {
        association(node, &[], &agents)?;
    }
    let mut rows = Vec::new();
    for p in root.descendants().filter(|n| {
        n.is_element() && n.tag_name().namespace() == Some(TT) && n.tag_name().name() == "p"
    }) {
        let mut ancestors: Vec<_> = p
            .ancestors()
            .filter(|n| n.is_element() && matches!(n.tag_name().name(), "body" | "div" | "p"))
            .collect();
        ancestors.reverse();
        let mut context = Context {
            interval: Interval {
                start: 0,
                end: None,
            },
            ids: Vec::new(),
            timed_owner: None,
        };
        for node in ancestors {
            context = child_context(node, &context, &agents)?;
        }
        rows.extend(scope_rows(p, context, &agents, false)?);
        if rows.len() > MAX_LINES {
            return Err(ImportError::Limit.at(p, "展开超过2048行"));
        }
    }
    let vocals = rows.iter().any(|r| r.line.vocal.is_some());
    if !vocals
        && root
            .descendants()
            .filter(|n| n.is_element() && n.tag_name().name() == "p")
            .any(|p| {
                p.children().filter(Node::is_element).any(|child| {
                    child
                        .descendants()
                        .skip(1)
                        .any(|n| n.is_element() && (has_time(n) || n.has_attribute((META, "role"))))
                })
            })
    {
        return Err(ImportError::Unsupported.at(root, "无声部TTML保持原嵌套定时子集"));
    }
    if vocals {
        rows.sort_by_key(|r| (r.line.start_ms, r.origin));
    } else if rows.windows(2).any(|w| {
        w[0].line.start_ms >= w[1].line.start_ms
            || w[0].line.end_ms.is_some_and(|end| end > w[1].line.start_ms)
    }) {
        return Err(ImportError::Invalid.at(root, "无声部TTML仍要求严格顺序且不重叠"));
    }
    if vocals {
        let mut latest_end = 0;
        let mut unlabelled_end = 0;
        for row in &rows {
            let invalid = row.line.end_ms.is_none_or(|end| end <= row.line.start_ms)
                || row.line.start_ms < unlabelled_end
                || row.line.vocal.is_none() && row.line.start_ms < latest_end;
            if invalid {
                let pos = xml.text_pos_at(row.origin);
                return Err(ImportError::At {
                    category: ImportErrorCategory::Invalid,
                    row: pos.row,
                    column: pos.col,
                    reason: "声部行须有有限区间，重叠参与行须全部标注身份",
                });
            }
            latest_end = latest_end.max(row.line.end_ms.unwrap_or(0));
            if row.line.vocal.is_none() {
                unlabelled_end = unlabelled_end.max(row.line.end_ms.unwrap_or(0));
            }
        }
    }
    let mut doc = LyricDocument::empty();
    doc.source = LyricSource::Imported;
    doc.format = Some("ttml".into());
    doc.agents = agents;
    let mut translations = Vec::new();
    let mut romanization = Vec::new();
    for row in rows {
        doc.lines.push(row.line);
        translations.push(row.translation.unwrap_or_default());
        romanization.push(row.roman.unwrap_or_default());
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
    validate(&doc).map_err(|e| e.at(root, "展开后的词时间、文本或资源预算无效"))?;
    Ok(doc)
}
