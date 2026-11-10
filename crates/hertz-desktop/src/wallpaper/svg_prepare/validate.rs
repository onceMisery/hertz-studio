// SPDX-License-Identifier: MIT
//! Pre-allocation admission for the supported static SVG language.
use super::{error, limit, Result, MAX_BYTES};
use roxmltree::{Document, Node};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::str::FromStr;

pub(super) const MAX_ELEMENTS: u64 = 1024;
pub(super) const MAX_SEGMENTS: u64 = 100_000;
const MAX_XML_MARKUP: usize = 8192;
const MAX_XML_ATTRIBUTES: usize = 32768;
const SVG: &str = "http://www.w3.org/2000/svg";
// Frozen usvg convert_clip_path_elements_impl converts only these graphics.
// Its use resolver applies the same conversion to the referenced element.
pub(crate) const CLIP_SHAPES: &[&str] = &[
    "path", "rect", "circle", "ellipse", "polyline", "polygon", "text",
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Facts {
    pub width: f64,
    pub height: f64,
    pub xml_nodes: u64,
    pub expanded_elements: u64,
    pub expanded_segments: u64,
    pub text_characters: u64,
}
pub(super) struct Validated<'a> {
    pub document: Document<'a>,
    pub facts: Facts,
}

fn bounded(v: f64) -> Result<f64> {
    if !v.is_finite() || v.abs() > 1_000_000.0 {
        return Err(limit("SVG 数值超过有限坐标范围"));
    }
    Ok(v)
}
fn numbers(value: &str) -> Result<Vec<f64>> {
    svgtypes::NumberListParser::from(value)
        .map(|v| bounded(v.map_err(error)?))
        .collect()
}
fn length(value: &str) -> Result<f64> {
    let v = svgtypes::Length::from_str(value).map_err(error)?;
    bounded(v.number)?;
    use svgtypes::LengthUnit::*;
    let scale = match v.unit {
        None | Px => 1.0,
        In => 96.0,
        Cm => 96.0 / 2.54,
        Mm => 96.0 / 25.4,
        Pt => 96.0 / 72.0,
        Pc => 16.0,
        _ => return Err(error("SVG 尺寸只支持固定绝对单位")),
    };
    bounded(v.number * scale)
}

fn enum_value(value: &str, choices: &[&str]) -> Result<()> {
    if choices.contains(&value) {
        Ok(())
    } else {
        Err(error(format!("未支持的 SVG 静态值：{value}")))
    }
}
pub(super) fn properties<'a>(node: Node<'a, 'a>) -> Result<BTreeMap<&'a str, &'a str>> {
    let mut result = BTreeMap::new();
    for attr in node.attributes().filter(|attr| attr.name() != "style") {
        // A CSS override cannot hide a forbidden original attribute.
        property(attr.name(), attr.value())?;
        result.insert(attr.name(), attr.value());
    }
    if let Some(style) = node.attribute("style") {
        let mut seen = BTreeSet::new();
        for declaration in style.split(';').filter(|v| !v.trim().is_empty()) {
            let (name, value) = declaration
                .split_once(':')
                .ok_or_else(|| error("SVG style 声明损坏"))?;
            let (name, value) = (name.trim(), value.trim());
            if !seen.insert(name)
                || value.is_empty()
                || value.contains(['\\', '!', '@', '{', '}', '/'])
            {
                return Err(error("SVG style 不支持转义、规则、重复或执行声明"));
            }
            // Intersection of this static subset with usvg 0.49
            // svgtree::AId::is_presentation; geometry and href are not CSS.
            if ![
                "clip-path",
                "clip-rule",
                "color",
                "display",
                "fill",
                "fill-opacity",
                "fill-rule",
                "font-family",
                "font-size",
                "font-stretch",
                "font-style",
                "font-weight",
                "opacity",
                "stop-color",
                "stop-opacity",
                "stroke",
                "stroke-dasharray",
                "stroke-dashoffset",
                "stroke-linecap",
                "stroke-linejoin",
                "stroke-miterlimit",
                "stroke-opacity",
                "stroke-width",
                "text-anchor",
                "transform",
                "visibility",
            ]
            .contains(&name)
            {
                return Err(error(format!("未支持的 SVG CSS presentation 属性：{name}")));
            }
            property(name, value)?;
            result.insert(name, value);
        }
    }
    Ok(result)
}
fn local_id(value: &str) -> Result<&str> {
    if !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(value)
    } else {
        Err(error("SVG 片段 id 非法"))
    }
}
fn fragment(value: &str) -> Result<&str> {
    value
        .strip_prefix('#')
        .filter(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or_else(|| error("SVG 仅允许同文档片段引用"))
}
fn reference<'a>(field: &str, value: &'a str) -> Result<Option<&'a str>> {
    if field == "href" {
        return fragment(value).map(Some);
    }
    if matches!(field, "fill" | "stroke") {
        return match svgtypes::Paint::from_str(value).map_err(error)? {
            svgtypes::Paint::FuncIRI(iri, _) => local_id(iri).map(Some),
            svgtypes::Paint::ContextFill | svgtypes::Paint::ContextStroke => {
                Err(error("SVG context paint 未支持"))
            }
            _ => Ok(None),
        };
    }
    if field == "clip-path" && value != "none" {
        return svgtypes::FuncIRI::from_str(value)
            .map_err(error)
            .and_then(|v| local_id(v.0))
            .map(Some);
    }
    Ok(None)
}
fn path_cost(value: &str) -> Result<u64> {
    use svgtypes::PathSegment::*;
    let mut count = 0;
    let mut pen = (0f64, 0f64);
    let mut empty_run = 0u64;
    let mut contours = 0u64;
    for segment in svgtypes::PathParser::from(value) {
        let s = segment.map_err(error)?;
        if matches!(s, MoveTo { .. } | ClosePath { .. }) {
            empty_run += 1;
            if empty_run > 64 {
                return Err(limit("SVG 连续空轮廓超过 64"));
            }
        } else {
            empty_run = 0;
        }
        if matches!(s, MoveTo { .. }) {
            contours += 1;
            if contours > 1024 {
                return Err(limit("单 SVG path 轮廓超过 1024"));
            }
        }
        let (abs, x, y, coords): (bool, f64, f64, Vec<f64>) = match s {
            MoveTo { abs, x, y } | LineTo { abs, x, y } | SmoothQuadratic { abs, x, y } => {
                (abs, x, y, vec![x, y])
            }
            HorizontalLineTo { abs, x } => (abs, x, if abs { pen.1 } else { 0.0 }, vec![x]),
            VerticalLineTo { abs, y } => (abs, if abs { pen.0 } else { 0.0 }, y, vec![y]),
            CurveTo {
                abs,
                x1,
                y1,
                x2,
                y2,
                x,
                y,
            } => (abs, x, y, vec![x1, y1, x2, y2, x, y]),
            SmoothCurveTo { abs, x2, y2, x, y } => (abs, x, y, vec![x2, y2, x, y]),
            Quadratic { abs, x1, y1, x, y } => (abs, x, y, vec![x1, y1, x, y]),
            EllipticalArc {
                abs,
                rx,
                ry,
                x_axis_rotation,
                x,
                y,
                ..
            } => (abs, x, y, vec![rx, ry, x_axis_rotation, x, y]),
            ClosePath { .. } => {
                count += 1;
                continue;
            }
        };
        for v in coords {
            bounded(v)?;
        }
        pen = if abs {
            (x, y)
        } else {
            (bounded(pen.0 + x)?, bounded(pen.1 + y)?)
        };
        // An arc can become up to four cubic segments before rendering.
        count += if matches!(s, EllipticalArc { .. }) {
            4
        } else {
            1
        };
        if count > MAX_SEGMENTS {
            return Err(limit("SVG 路径段超限"));
        }
    }
    Ok(count)
}
fn property(field: &str, value: &str) -> Result<()> {
    match field {
        "id" | "href" => {
            fragment(if field == "id" {
                return if value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    && !value.is_empty()
                {
                    Ok(())
                } else {
                    Err(error("SVG id 非法"))
                };
            } else {
                value
            })?;
        }
        "d" => {
            path_cost(value)?;
        }
        "points" | "viewBox" | "dx" | "dy" | "rotate" => {
            numbers(value)?;
        }
        "transform" | "gradientTransform" => {
            let t = svgtypes::Transform::from_str(value).map_err(error)?;
            for v in [t.a, t.b, t.c, t.d, t.e, t.f] {
                bounded(v)?;
            }
        }
        "x" | "y" | "x1" | "x2" | "y1" | "y2" | "cx" | "cy" | "r" | "rx" | "ry" | "width"
        | "height" | "font-size" | "stroke-width" => {
            length(value)?;
        }
        "fx" | "fy" | "offset" => {
            let v = svgtypes::Length::from_str(value).map_err(error)?;
            bounded(v.number)?;
        }
        "opacity" | "fill-opacity" | "stroke-opacity" | "stop-opacity" => {
            let v = value.parse::<f64>().map_err(error)?;
            if !(0.0..=1.0).contains(&v) {
                return Err(error("SVG alpha 无效"));
            }
        }
        "fill" | "clip-path" => {
            reference(field, value)?;
        }
        "stroke" => {
            reference(field, value)?;
        }
        "color" | "stop-color" => {
            svgtypes::Color::from_str(value).map_err(error)?;
        }
        "fill-rule" | "clip-rule" => enum_value(value, &["nonzero", "evenodd"])?,
        "stroke-linecap" => enum_value(value, &["butt", "round", "square"])?,
        "stroke-linejoin" => enum_value(value, &["miter", "round", "bevel"])?,
        "stroke-miterlimit" => {
            let v = value.parse::<f64>().map_err(error)?;
            if !(1.0..=64.0).contains(&v) {
                return Err(limit("SVG miter 超限"));
            }
        }
        "stroke-dasharray" => {
            if value != "none" {
                return Err(error(
                    "SVG stroke-dasharray 仅支持 none；虚线 stroke 未支持",
                ));
            }
        }
        "stroke-dashoffset" => {
            length(value)?;
        }
        "gradientUnits" | "clipPathUnits" => {
            enum_value(value, &["userSpaceOnUse", "objectBoundingBox"])?
        }
        "spreadMethod" => enum_value(value, &["pad", "reflect", "repeat"])?,
        "display" => enum_value(value, &["inline", "none"])?,
        "visibility" => enum_value(value, &["visible", "hidden", "collapse"])?,
        "font-family" => {
            if value.contains(['\\', '(', ')']) {
                return Err(error("SVG font-family 无效"));
            }
            svgtypes::parse_font_families(value).map_err(error)?;
        }
        "font-style" => enum_value(value, &["normal", "italic", "oblique"])?,
        "font-stretch" => enum_value(value, &["normal"])?,
        "font-weight" => {
            if ![
                "normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900",
            ]
            .contains(&value)
            {
                return Err(error("SVG font-weight 未支持"));
            }
        }
        "text-anchor" => enum_value(value, &["start", "middle", "end"])?,
        "preserveAspectRatio" => {
            svgtypes::AspectRatio::from_str(value).map_err(error)?;
        }
        "version" => enum_value(value, &["1.0", "1.1"])?,
        "space" => enum_value(value, &["default", "preserve"])?,
        _ => return Err(error(format!("未支持的 SVG 属性：{field}"))),
    }
    Ok(())
}

pub(super) fn validate(bytes: &[u8]) -> Result<Validated<'_>> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES as usize {
        return Err(limit("SVG 原稿必须为 1 字节至 4 MiB"));
    }
    let xml = std::str::from_utf8(bytes).map_err(error)?;
    // roxmltree 0.21 preallocates its node/attribute vectors from every raw
    // '<'/'=' byte, including comments and descriptive text, before nodes_limit
    // takes effect. Bound those capacities before invoking the parser so the
    // original 32 MiB import workspace also covers adversarial metadata.
    if bytes.iter().filter(|byte| **byte == b'<').count() > MAX_XML_MARKUP
        || bytes.iter().filter(|byte| **byte == b'=').count() > MAX_XML_ATTRIBUTES
    {
        return Err(limit("SVG XML 预分配标记或属性容量超限"));
    }
    let document = Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: MAX_XML_MARKUP as u32,
            ..Default::default()
        },
    )
    .map_err(error)?;
    let root = document.root_element();
    if root.tag_name().name() != "svg" || root.tag_name().namespace() != Some(SVG) {
        return Err(error("输入必须是 SVG namespace 根元素"));
    }
    let mut ids = BTreeMap::new();
    let mut costs = HashMap::new();
    let mut links = HashMap::new();
    let mut attrs = 0u64;
    let mut texts = 0u64;
    let xml_nodes = document.descendants().count() as u64;
    for node in document.descendants() {
        if node.ancestors().count() > 65 {
            return Err(limit("SVG XML 深度超过 64"));
        }
        if node.is_pi() {
            return Err(error("SVG processing instruction 未支持"));
        }
        if !node.is_element() {
            continue;
        }
        let tag = node.tag_name().name();
        if node.tag_name().namespace() != Some(SVG)
            || ![
                "svg",
                "g",
                "defs",
                "path",
                "rect",
                "circle",
                "ellipse",
                "line",
                "polyline",
                "polygon",
                "use",
                "linearGradient",
                "radialGradient",
                "stop",
                "clipPath",
                "text",
                "tspan",
                "title",
                "desc",
            ]
            .contains(&tag)
            || tag == "svg" && node != root
        {
            return Err(error(format!("未支持的 SVG 静态元素：{tag}")));
        }
        if node
            .parent_element()
            .is_some_and(|parent| parent.tag_name().name() == "clipPath")
            && !CLIP_SHAPES.contains(&tag)
            && !["use", "title", "desc"].contains(&tag)
        {
            return Err(error(format!("SVG clipPath 子元素未支持：{tag}")));
        }
        for ns in node.namespaces() {
            if ![
                SVG,
                "http://www.w3.org/1999/xlink",
                "http://www.w3.org/XML/1998/namespace",
            ]
            .contains(&ns.uri())
            {
                return Err(error("SVG namespace 未支持"));
            }
        }
        let mut attribute_names = BTreeSet::new();
        for a in node.attributes() {
            match (a.namespace(), a.name()) {
                (None, _)
                | (Some("http://www.w3.org/1999/xlink"), "href")
                | (Some("http://www.w3.org/XML/1998/namespace"), "space") => {}
                _ => return Err(error("SVG namespaced 属性仅支持 xlink:href 与 xml:space")),
            }
            if !attribute_names.insert(a.name()) {
                return Err(error("SVG 同本地名属性存在歧义"));
            }
        }
        attrs += node.attributes().len() as u64;
        if attrs > MAX_XML_ATTRIBUTES as u64 {
            return Err(limit("SVG 属性超限"));
        }
        let p = properties(node)?;
        if p.len() > 32768 {
            return Err(limit("SVG CSS 声明超限"));
        }
        let mut refs = Vec::new();
        for (field, value) in &p {
            if let Some(id) = reference(field, value)? {
                refs.push((*field, id));
            }
        }
        if let Some(id) = p.get("id") {
            if ids.insert(*id, node).is_some() {
                return Err(error("SVG id 重复"));
            }
        }
        let stroked = p.get("stroke").is_some_and(|v| *v != "none");
        if stroked
            && (!["path", "rect", "line", "polyline", "polygon"].contains(&tag)
                || p.contains_key("rx")
                || p.contains_key("ry")
                || tag == "path"
                    && svgtypes::PathParser::from(p.get("d").copied().unwrap_or("")).any(|v| {
                        !matches!(
                            v,
                            Ok(svgtypes::PathSegment::MoveTo { .. }
                                | svgtypes::PathSegment::LineTo { .. }
                                | svgtypes::PathSegment::HorizontalLineTo { .. }
                                | svgtypes::PathSegment::VerticalLineTo { .. }
                                | svgtypes::PathSegment::ClosePath { .. })
                        )
                    }))
        {
            return Err(error(
                "SVG stroke 只支持无dash的直线/非圆角形状；曲线stroke需作者转填充路径",
            ));
        }
        let segments = match tag {
            "path" => path_cost(p.get("d").copied().unwrap_or(""))?,
            "polyline" | "polygon" => {
                let points = numbers(p.get("points").copied().unwrap_or(""))?;
                if points.len() % 2 != 0 {
                    return Err(error("SVG points 缺坐标"));
                }
                points.len() as u64 / 2 + 1
            }
            "rect" => 10,
            "circle" | "ellipse" => 6,
            "line" => 2,
            _ => 0,
        };
        if tag == "text" || tag == "tspan" {
            texts += node
                .children()
                .filter(|n| n.is_text())
                .map(|n| n.text().unwrap_or("").chars().count() as u64)
                .sum::<u64>();
        }
        // line-only stroker: body<=2L, joins<=82L, caps/contour<=69C;
        // 128*(L+C) conservatively includes automatic close and conic quads.
        let segments = if stroked {
            segments
                .checked_mul(128)
                .ok_or_else(|| limit("SVG stroke 展开溢出"))?
        } else {
            segments
        };
        let chars = if tag == "text" || tag == "tspan" {
            node.children()
                .filter(|n| n.is_text())
                .map(|n| n.text().unwrap_or("").chars().count() as u64)
                .sum()
        } else {
            0
        };
        costs.insert(node.id(), (segments, chars));
        links.insert(node.id(), refs);
    }
    if texts > 4096 {
        return Err(limit("SVG 文本字符超过 4096"));
    }
    for node in document.descendants().filter(Node::is_element) {
        for (field, id) in &links[&node.id()] {
            let target = ids.get(id).ok_or_else(|| error("SVG 片段引用不存在"))?;
            let t = target.tag_name().name();
            let tag = node.tag_name().name();
            let matches = match *field {
                "clip-path" => t == "clipPath",
                "fill" | "stroke" => t == "linearGradient" || t == "radialGradient",
                "href" => {
                    if tag == "use" {
                        [
                            "g", "path", "rect", "circle", "ellipse", "line", "polyline",
                            "polygon", "text",
                        ]
                        .contains(&t)
                    } else {
                        (tag == "linearGradient" || tag == "radialGradient") && tag == t
                    }
                }
                _ => false,
            };
            if !matches {
                return Err(error("SVG 引用目标类型不匹配"));
            }
            if *field == "href"
                && tag == "use"
                && node
                    .parent_element()
                    .is_some_and(|parent| parent.tag_name().name() == "clipPath")
                && !CLIP_SHAPES.contains(&t)
            {
                return Err(error(format!("SVG clipPath use 目标未支持：{t}")));
            }
        }
    }
    fn count<'a>(
        node: Node<'a, 'a>,
        ids: &BTreeMap<&str, Node<'a, 'a>>,
        costs: &HashMap<roxmltree::NodeId, (u64, u64)>,
        links: &HashMap<roxmltree::NodeId, Vec<(&str, &str)>>,
        stack: &mut HashSet<roxmltree::NodeId>,
        depth: u64,
        parent: [f64; 6],
    ) -> Result<(u64, u64, u64)> {
        if depth > 64 || !stack.insert(node.id()) {
            return Err(limit("SVG 引用循环或展开深度超限"));
        }
        let props = properties(node)?;
        let t = svgtypes::Transform::from_str(
            props
                .get("transform")
                .copied()
                .unwrap_or("matrix(1 0 0 1 0 0)"),
        )
        .map_err(error)?;
        let [a, b, c, d, e, f] = parent;
        let matrix = [
            bounded(a * t.a + c * t.b)?,
            bounded(b * t.a + d * t.b)?,
            bounded(a * t.c + c * t.d)?,
            bounded(b * t.c + d * t.d)?,
            bounded(a * t.e + c * t.f + e)?,
            bounded(b * t.e + d * t.f + f)?,
        ];
        let mut total = (1u64, costs[&node.id()].0, costs[&node.id()].1);
        for child in node
            .children()
            .filter(Node::is_element)
            .chain(links[&node.id()].iter().map(|(_, id)| ids[id]))
        {
            let c = count(child, ids, costs, links, stack, depth + 1, matrix)?;
            total.0 = total
                .0
                .checked_add(c.0)
                .ok_or_else(|| limit("SVG 展开溢出"))?;
            total.1 = total
                .1
                .checked_add(c.1)
                .ok_or_else(|| limit("SVG 展开溢出"))?;
            total.2 = total
                .2
                .checked_add(c.2)
                .ok_or_else(|| limit("SVG 文本展开溢出"))?;
            if total.2 > 4096 {
                return Err(limit("SVG 引用展开文本超过 4096 字符"));
            }
            if total.0 > MAX_ELEMENTS || total.1 > MAX_SEGMENTS {
                return Err(limit("SVG 引用展开超过元素或路径段上限"));
            }
        }
        stack.remove(&node.id());
        Ok(total)
    }
    let (expanded_elements, expanded_segments, expanded_texts) = count(
        root,
        &ids,
        &costs,
        &links,
        &mut HashSet::new(),
        0,
        [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
    )?;
    let p = properties(root)?;
    let size = match (p.get("width"), p.get("height")) {
        (Some(w), Some(h)) => (length(w)?, length(h)?),
        _ => {
            let v = numbers(
                p.get("viewBox")
                    .ok_or_else(|| error("SVG 缺少固定尺寸或 viewBox"))?,
            )?;
            if v.len() != 4 {
                return Err(error("SVG viewBox 无效"));
            }
            (v[2], v[3])
        }
    };
    if let Some(v) = p.get("viewBox") {
        let v = numbers(v)?;
        if v.len() != 4 || v[2] < 1.0 / 1024.0 || v[3] < 1.0 / 1024.0 {
            return Err(error("SVG viewBox 无效"));
        }
    }
    if size.0 < 1.0 / 1024.0 || size.1 < 1.0 / 1024.0 {
        return Err(error("SVG 尺寸必须大于零"));
    }
    Ok(Validated {
        document,
        facts: Facts {
            width: size.0,
            height: size.1,
            xml_nodes,
            expanded_elements,
            expanded_segments,
            text_characters: expanded_texts,
        },
    })
}
