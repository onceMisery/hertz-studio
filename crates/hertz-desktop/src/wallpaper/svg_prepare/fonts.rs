// SPDX-License-Identifier: MIT
//! Exact same-package static TTF selection. No discovery or machine fallback.
use super::validate::{properties, Validated, MAX_SEGMENTS};
use super::{cancelled, error, limit, Input, Result};
use crate::wallpaper::{
    assets::open_immutable,
    font_prepare::{self, RequiredText},
};
use std::{
    collections::BTreeSet,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FontIdentity {
    pub asset_id: String,
    pub sha256: String,
    pub face_index: u32,
    pub families: Vec<String>,
    pub style: String,
    pub weight: u16,
    pub stretch: String,
    pub adapter_version: String,
}
pub(super) struct Fonts {
    pub database: Arc<usvg::fontdb::Database>,
    pub identities: Vec<FontIdentity>,
    pub cpu_bytes: u64,
    pub outline_segments: u64,
}
#[derive(Default)]
struct Outline {
    segments: u64,
}
impl skrifa::outline::OutlinePen for Outline {
    fn move_to(&mut self, _: f32, _: f32) {
        self.segments += 1;
    }
    fn line_to(&mut self, _: f32, _: f32) {
        self.segments += 1;
    }
    fn quad_to(&mut self, _: f32, _: f32, _: f32, _: f32) {
        self.segments += 1;
    }
    fn curve_to(&mut self, _: f32, _: f32, _: f32, _: f32, _: f32, _: f32) {
        self.segments += 1;
    }
    fn close(&mut self) {
        self.segments += 1;
    }
}
fn inherited(node: roxmltree::Node<'_, '_>, name: &str) -> Result<Option<String>> {
    for parent in node.ancestors().filter(roxmltree::Node::is_element) {
        if let Some(value) = properties(parent)?.get(name) {
            return Ok(Some((*value).into()));
        }
    }
    Ok(None)
}
fn nonexpanding_gsub(face: &ttf_parser::Face<'_>) -> Result<()> {
    for tag in [
        b"COLR", b"SVG ", b"sbix", b"CBDT", b"CBLC", b"EBDT", b"EBLC", b"bdat", b"bloc", b"VARC",
        b"CFF ", b"CFF2",
    ] {
        if face
            .raw_face()
            .table(ttf_parser::Tag::from_bytes(tag))
            .is_some()
        {
            return Err(super::JobError::new(
                "svg_font_shaping_unsupported",
                "SVG 字体仅准备普通静态 glyf 轮廓",
            ));
        }
    }
    if face
        .raw_face()
        .table(ttf_parser::Tag::from_bytes(b"morx"))
        .is_some()
    {
        return Err(super::JobError::new(
            "svg_font_shaping_unsupported",
            "SVG AAT morx glyph 扩张未支持",
        ));
    }
    let Some(table) = face.raw_face().table(ttf_parser::Tag::from_bytes(b"GSUB")) else {
        return Ok(());
    };
    let word = |at: usize| {
        table
            .get(at..at + 2)
            .map(|v| u16::from_be_bytes([v[0], v[1]]) as usize)
            .ok_or_else(|| error("SVG GSUB 边界损坏"))
    };
    let list = word(8)?;
    let count = word(list)?;
    if count > 1024 {
        return Err(limit("SVG GSUB lookup 超限"));
    }
    for i in 0..count {
        let lookup = list
            .checked_add(word(list + 2 + 2 * i)?)
            .ok_or_else(|| limit("SVG GSUB offset 溢出"))?;
        let kind = word(lookup)?;
        if kind == 2 || !(1..=8).contains(&kind) {
            return Err(super::JobError::new(
                "svg_font_shaping_unsupported",
                "SVG GSUB glyph 扩张 lookup 尚未支持",
            ));
        }
        if kind == 7 {
            let subs = word(lookup + 4)?;
            if subs > 1024 {
                return Err(limit("SVG GSUB extension 超限"));
            }
            for j in 0..subs {
                let sub = lookup
                    .checked_add(word(lookup + 6 + 2 * j)?)
                    .ok_or_else(|| limit("SVG GSUB offset 溢出"))?;
                if word(sub)? != 1
                    || matches!(word(sub + 2)?, 2 | 7)
                    || !(1..=8).contains(&word(sub + 2)?)
                {
                    return Err(super::JobError::new(
                        "svg_font_shaping_unsupported",
                        "SVG GSUB extension 包含扩张或递归 lookup",
                    ));
                }
            }
        }
    }
    Ok(())
}
pub(super) fn load(input: &Input, svg: &Validated<'_>, cancel: &AtomicBool) -> Result<Fonts> {
    let mut database = usvg::fontdb::Database::new();
    let mut texts = Vec::new();
    for node in svg.document.descendants().filter(|node| {
        node.is_text()
            && node
                .parent()
                .is_some_and(|p| matches!(p.tag_name().name(), "text" | "tspan"))
    }) {
        let parent = node.parent().expect("text parent");
        let family = inherited(parent, "font-family")?.ok_or_else(|| {
            super::JobError::new(
                "svg_font_dependency_missing",
                "SVG text 必须声明同包真实 font-family",
            )
        })?;
        let families = svgtypes::parse_font_families(&family).map_err(error)?;
        let named = families
            .into_iter()
            .map(|f| match f {
                svgtypes::FontFamily::Named(n) => Ok(n),
                _ => Err(super::JobError::new(
                    "svg_font_dependency_missing",
                    "SVG text 不接受 generic family 或机器字体",
                )),
            })
            .collect::<Result<Vec<_>>>()?;
        let style = inherited(parent, "font-style")?.unwrap_or_else(|| "normal".into());
        let weight = inherited(parent, "font-weight")?.unwrap_or_else(|| "400".into());
        let weight = match weight.as_str() {
            "normal" => 400,
            "bold" => 700,
            _ => weight.parse().map_err(error)?,
        };
        texts.push((named, style, weight, node.text().unwrap_or("").to_owned()));
    }
    if texts.is_empty() {
        return Ok(Fonts {
            database: Arc::new(database),
            identities: vec![],
            cpu_bytes: 0,
            outline_segments: 0,
        });
    }
    if input.fonts.is_empty() {
        return Err(super::JobError::new(
            "svg_font_dependency_missing",
            "SVG text 缺少同包精确 TTF 字体依赖；请补齐字体包或在作者工具转路径",
        ));
    }
    let mut candidates = Vec::new();
    let mut seen = BTreeSet::new();
    let mut cpu = 0u64;
    for (id, media) in &input.fonts {
        cancelled(cancel)?;
        if !seen.insert(media.entry.sha256.clone()) {
            continue;
        }
        let mut bytes = Vec::new();
        open_immutable(&media.path)?
            .take(font_prepare::MAX_FONT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(error)?;
        let metadata = font_prepare::validate_bytes_with_cancel(&media.entry, &bytes, &[], cancel)?;
        font_prepare::ensure_native_format(metadata.format)?;
        cpu = cpu
            .checked_add(metadata.cpu_budget_bytes)
            .ok_or_else(|| limit("SVG 字体工作区溢出"))?;
        let before: BTreeSet<_> = database.faces().map(|f| f.id).collect();
        database.load_font_data(bytes.clone());
        let face = database
            .faces()
            .find(|f| !before.contains(&f.id))
            .ok_or_else(|| error("SVG 字体无法提取真实名称"))?;
        let identity = FontIdentity {
            asset_id: id.clone(),
            sha256: media.entry.sha256.clone(),
            face_index: face.index,
            families: face.families.iter().map(|v| v.0.clone()).collect(),
            style: format!("{:?}", face.style).to_lowercase(),
            weight: face.weight.0,
            stretch: format!("{:?}", face.stretch),
            adapter_version: font_prepare::ADAPTER_VERSION.into(),
        };
        candidates.push((face.id, identity, bytes, media.entry.clone()));
    }
    let mut used = BTreeSet::new();
    let mut outlines = 0u64;
    let mut largest_outline = 0u64;
    for (families, style, weight, text) in texts {
        let mut chosen = None;
        for family in &families {
            let matched: Vec<_> = candidates
                .iter()
                .filter(|(_, identity, _, _)| {
                    identity.families.contains(family)
                        && identity.style == style
                        && identity.weight == weight
                        && identity.stretch == "Normal"
                })
                .collect();
            if matched.len() > 1 {
                return Err(super::JobError::new(
                    "svg_font_ambiguous",
                    "SVG 同名字体绑定多个不同字节",
                ));
            }
            if let Some(candidate) = matched.first() {
                chosen = Some(*candidate);
                break;
            }
        }
        let (id, _, bytes, entry) = chosen.ok_or_else(|| {
            super::JobError::new(
                "svg_font_dependency_missing",
                "SVG family/style/weight 必须精确匹配同包 TTF",
            )
        })?;
        font_prepare::validate_bytes_with_cancel(
            entry,
            bytes,
            &[RequiredText {
                node_id: "svg-text".into(),
                text: text.clone(),
            }],
            cancel,
        )?;
        let face = ttf_parser::Face::parse(bytes, 0).map_err(error)?;
        nonexpanding_gsub(&face)?;
        use skrifa::{
            outline::{DrawSettings, Hinting},
            prelude::{FontRef, LocationRef, Size},
            MetadataProvider,
        };
        let font = FontRef::new(bytes).map_err(error)?;
        let glyphs = font.outline_glyphs();
        let mut max_outline = 0;
        for glyph in 0..face.number_of_glyphs() {
            cancelled(cancel)?;
            if let Some(glyph) = glyphs.get(skrifa::GlyphId::new(u32::from(glyph))) {
                if glyph.draw_memory_size(Hinting::None) > 4 * 1024 * 1024 {
                    return Err(limit("SVG 字形 draw 工作区超过 4 MiB"));
                }
                let mut outline = Outline::default();
                glyph
                    .draw(
                        DrawSettings::unhinted(Size::unscaled(), LocationRef::default()),
                        &mut outline,
                    )
                    .map_err(error)?;
                max_outline = max_outline.max(outline.segments);
            }
        }
        largest_outline = largest_outline.max(max_outline);
        // All admitted substitution lookups preserve/decrease stream length.
        // Frozen harfrust Unicode17 canonical decomposition <=4; Indic/USE,
        // Thai and broken-syllable preprocessing together <=16N (audit report).
        // 32N retains conservative margin with default flags and no morx. Every possible substituted glyph uses the full-face bound.
        outlines = outlines
            .checked_add(
                max_outline
                    .checked_mul(text.chars().count() as u64 * 32)
                    .ok_or_else(|| limit("SVG 字形展开溢出"))?,
            )
            .ok_or_else(|| limit("SVG 字形展开溢出"))?;
        if outlines > MAX_SEGMENTS {
            return Err(limit("SVG 字形路径段超限"));
        }
        used.insert(*id);
    }
    outlines = largest_outline
        .checked_mul(svg.facts.text_characters * 32)
        .ok_or_else(|| limit("SVG 字形引用展开溢出"))?;
    if outlines > MAX_SEGMENTS {
        return Err(limit("SVG 引用展开字形路径段超限"));
    }
    let identities = candidates
        .iter()
        .filter(|(id, _, _, _)| used.contains(id))
        .map(|(_, identity, _, _)| identity.clone())
        .collect();
    let unused: Vec<_> = database
        .faces()
        .filter(|f| !used.contains(&f.id))
        .map(|f| f.id)
        .collect();
    for id in unused {
        database.remove_face(id);
    }
    Ok(Fonts {
        database: Arc::new(database),
        identities,
        cpu_bytes: cpu,
        outline_segments: outlines,
    })
}
pub(super) fn resolver<'a>(failed: &'a AtomicBool) -> usvg::FontResolver<'a> {
    usvg::FontResolver {
        select_font: Box::new(move |font, database| {
            let style = match font.style() {
                usvg::FontStyle::Normal => usvg::fontdb::Style::Normal,
                usvg::FontStyle::Italic => usvg::fontdb::Style::Italic,
                usvg::FontStyle::Oblique => usvg::fontdb::Style::Oblique,
            };
            let found = font.families().iter().find_map(|family| match family {
                svgtypes::FontFamily::Named(name) => database
                    .faces()
                    .find(|face| {
                        face.families.iter().any(|f| &f.0 == name)
                            && face.style == style
                            && face.weight.0 == font.weight()
                            && face.stretch == usvg::fontdb::Stretch::Normal
                    })
                    .map(|face| face.id),
                _ => None,
            });
            if found.is_none() {
                failed.store(true, Ordering::Release);
            }
            found
        }),
        select_fallback: Box::new(move |_, _, _| {
            failed.store(true, Ordering::Release);
            None
        }),
    }
}
