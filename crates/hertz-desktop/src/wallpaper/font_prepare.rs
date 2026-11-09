// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Pinned single-face SFNT facts for the original preparation worker. Parsing
//! does not establish FontFace/native qualification or grant playback access.

use std::collections::BTreeSet;
use std::io::Read;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ttf_parser::{Face, GlyphId, OutlineBuilder, Tag};

use super::assets::{open_immutable, AssetStore, PinnedMedia};
use super::decode_probe::Reservation;
use super::jobs::JobError;
use super::target_planner::AssetRef;

type Result<T> = std::result::Result<T, JobError>;
pub(crate) const ADAPTER_ID: &str = "prepared-sfnt-font";
pub(crate) const ADAPTER_VERSION: &str = "sfnt-ttf-parser-0.25.1-static-v3";
pub(crate) const MAX_FONT_BYTES: u64 = hertz_wallpaper::MAX_FONT_BYTES;
const MAX_PROBE_SCALARS: usize = 32;
const MAX_SFNT_TABLES: usize = 128;
const MAX_CMAP_RECORDS: usize = 16;
const MAX_CMAP_GROUPS: usize = 8192;
const MAX_CMAP_ITEMS: usize = 65_536;
const MAX_FONT_WORK: u64 = 16_777_216;
const MAX_OUTLINE_DEPTH: usize = 16;
const MAX_GLYPH_OUTLINE_WORK: u64 = 65_536;
const MAX_FACE_OUTLINE_WORK: u64 = 1_048_576;
const MAX_COMPOSITE_COMPONENTS: usize = 64;
const MAX_FACE_COMPONENTS: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FontFormat {
    Ttf,
    Otf,
}

impl FontFormat {
    pub(crate) fn mime(self) -> &'static str {
        match self {
            Self::Ttf => "font/ttf",
            Self::Otf => "font/otf",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FontMetadata {
    pub(crate) format: FontFormat,
    pub(crate) sfnt_bytes: u64,
    pub(crate) glyph_count: u32,
    pub(crate) cpu_budget_bytes: u64,
    pub(crate) probe_text: String,
}

/// Parsed facts from an AssetStore-verified, immutable entry. This alone is not
/// a successful native qualification and cannot construct PreparedFont.
#[derive(Clone)]
pub(crate) struct FontInput {
    original_reference: AssetRef,
    original_media: Arc<PinnedMedia>,
    original_metadata: FontMetadata,
    original_content_key: String,
    // Bounded exact node/text proofs from this input's own glyph validation.
    // Digests avoid retaining a second copy of up to 128 long text strings.
    required_text_keys: Arc<[[u8; 32]]>,
    pub(crate) package_hash: String,
    pub(crate) media: Arc<PinnedMedia>,
    pub(crate) metadata: FontMetadata,
}

/// Read-only planning facts retain the original input seal and exact glyph
/// coverage. They carry no native qualification and cannot mint PreparedFont.
pub(crate) struct FontPlanFacts<'a> {
    input: &'a FontInput,
    content_key: String,
}

impl FontInput {
    pub(crate) fn plan_facts(&self) -> Result<FontPlanFacts<'_>> {
        Ok(FontPlanFacts {
            input: self,
            content_key: content_key(self)?,
        })
    }

    pub(crate) fn covers_required_texts(&self, texts: &[RequiredText]) -> bool {
        content_key(self).is_ok()
            && texts.len() <= hertz_wallpaper::document::MAX_NODES
            && texts.iter().all(|text| {
                text.text.len() <= 4 * 4096
                    && self
                        .required_text_keys
                        .binary_search(&required_text_key(text))
                        .is_ok()
            })
    }
}

impl FontPlanFacts<'_> {
    pub(crate) fn reference(&self) -> &AssetRef {
        &self.input.original_reference
    }
    pub(crate) fn sealed_metadata(&self) -> &FontMetadata {
        &self.input.original_metadata
    }
    pub(crate) fn content_key(&self) -> &str {
        &self.content_key
    }
    pub(crate) fn adapter_id(&self) -> &'static str {
        ADAPTER_ID
    }
    pub(crate) fn adapter_version(&self) -> &'static str {
        ADAPTER_VERSION
    }
    pub(crate) fn covers_required_texts(&self, texts: &[RequiredText]) -> bool {
        self.input.covers_required_texts(texts)
    }
    pub(crate) fn url(&self) -> Result<String> {
        super::webresource::files_url(
            &self.input.original_reference.package_hash,
            &self.input.original_media.entry.path,
        )
        .ok_or_else(|| JobError::invalid_input("字体 URL 必须来自已核验包路径"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RequiredText {
    pub(crate) node_id: String,
    pub(crate) text: String,
}

/// Only the existing qualification owner can mint the proof consumed here.
/// Fields and metadata are exposed by shared immutable getters, never page input.
#[derive(Clone)]
pub(crate) struct PreparedFont {
    reference: AssetRef,
    input: FontInput,
    content_key: String,
    url: String,
}

impl PreparedFont {
    pub(crate) fn after_qualification(
        reference: AssetRef,
        input: FontInput,
        proof: super::qualification::QualifiedFont,
    ) -> Result<Self> {
        reference.validate()?;
        if reference.variant_id.is_some()
            || reference.package_hash != input.package_hash
            || reference.package_hash != input.original_reference.package_hash
            || reference.asset_id != input.original_reference.asset_id
            || reference.variant_id != input.original_reference.variant_id
        {
            return Err(JobError::invalid_input("字体引用与固定输入不一致"));
        }
        if !proof.matches(&input)? {
            return Err(JobError::new(
                "font_not_prepared",
                "字体成功资格不属于当前固定输入",
            ));
        }
        ensure_native_format(input.metadata.format)?;
        let url = super::webresource::files_url(&input.package_hash, &input.media.entry.path)
            .ok_or_else(|| JobError::invalid_input("字体 URL 必须来自已核验包路径"))?;
        let content_key = content_key(&input)?;
        Ok(Self {
            reference,
            input,
            content_key,
            url,
        })
    }

    pub(crate) fn reference(&self) -> &AssetRef {
        &self.reference
    }
    pub(crate) fn input(&self) -> &FontInput {
        &self.input
    }
    pub(crate) fn content_key(&self) -> &str {
        &self.content_key
    }
    pub(crate) fn url(&self) -> &str {
        &self.url
    }
    pub(crate) fn adapter_id(&self) -> &'static str {
        ADAPTER_ID
    }
    pub(crate) fn adapter_version(&self) -> &'static str {
        ADAPTER_VERSION
    }
    /// A content/environment qualification cannot expand the text checked by
    /// this preparation request. Only exact node/text pairs (in any order) are
    /// reusable; changed final values must go through the original worker.
    pub(crate) fn covers_required_texts(&self, texts: &[RequiredText]) -> bool {
        self.input.covers_required_texts(texts)
    }
}

fn required_text_key(text: &RequiredText) -> [u8; 32] {
    let mut digest = Sha256::new();
    for part in [text.node_id.as_bytes(), text.text.as_bytes()] {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part);
    }
    digest.finalize().into()
}

fn invalid(message: impl Into<String>) -> JobError {
    JobError::new("font_invalid", message)
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(JobError::new("cancelled", "字体准备已取消并退出"))
    } else {
        Ok(())
    }
}

/// The caller acquires this temporary workspace in ImportJobs' original slot
/// before pin_input. It covers a bounded read, directory validation and parser
/// work; it is a conservative estimate, not a third-party RSS hard limit.
pub(crate) fn prepare_workspace_bytes(encoded_bytes: u64) -> Result<u64> {
    check_size(encoded_bytes)?;
    encoded_bytes
        .checked_add(1)
        .and_then(|bytes| bytes.checked_mul(2))
        .and_then(|bytes| bytes.checked_add(96 * u64::from(u16::MAX)))
        .and_then(|bytes| bytes.checked_add(512 * 1024))
        .ok_or_else(|| JobError::new("probe_budget_exceeded", "字体准备工作区计算溢出"))
}

fn check_size(bytes: u64) -> Result<()> {
    if bytes == 0 || bytes > MAX_FONT_BYTES {
        Err(JobError::new(
            "font_size_exceeded",
            "字体必须为 1 字节至 16 MiB",
        ))
    } else {
        Ok(())
    }
}

/// Parse and validate required final text while the original preparation slot
/// and its workspace remain held. This helper never starts workers or reserves
/// resources itself. Font variants are not part of the current adapter contract.
pub(crate) fn pin_input(
    assets: &AssetStore,
    reference: &AssetRef,
    expected: &hertz_wallpaper::VerifiedEntry,
    texts: &[RequiredText],
    workspace: &Reservation,
    cancel: &AtomicBool,
) -> Result<FontInput> {
    cancelled(cancel)?;
    reference.validate()?;
    if reference.variant_id.is_some() {
        return Err(JobError::new(
            "font_format_not_prepared",
            "字体变体尚未准备",
        ));
    }
    workspace.ensure_prepare_cpu_bytes(prepare_workspace_bytes(expected.bytes)?)?;
    let package = assets.read_installed_manifest(&reference.package_hash)?;
    let asset = package
        .manifest
        .assets
        .iter()
        .find(|asset| asset.id == reference.asset_id)
        .ok_or_else(|| JobError::new("asset_not_found", "固定包不含所需字体资源"))?;
    if asset.kind != hertz_wallpaper::AssetKind::Font {
        return Err(JobError::new(
            "font_asset_kind_mismatch",
            "文字资源必须引用同包 font 资源",
        ));
    }
    if asset.source != expected.path {
        return Err(JobError::new(
            "hash_mismatch",
            "字体准备请求与固定资源路径不一致",
        ));
    }
    let media = Arc::new(
        assets
            .pin_verified_media(&reference.package_hash, &asset.source)?
            .ok_or_else(|| JobError::new("hash_mismatch", "字体条目未通过不可变包核验"))?,
    );
    if media.entry.path != expected.path
        || media.entry.bytes != expected.bytes
        || media.entry.sha256 != expected.sha256
        || media.entry.mime != expected.mime
    {
        return Err(JobError::new(
            "hash_mismatch",
            "字体准备请求与已核验条目不一致",
        ));
    }
    cancelled(cancel)?;
    let mut bytes = Vec::with_capacity(expected.bytes as usize + 1);
    open_immutable(&media.path)?
        .take(MAX_FONT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| JobError::io(format!("读取固定字体失败：{error}")))?;
    cancelled(cancel)?;
    let metadata = validate_bytes_with_cancel(&media.entry, &bytes, texts, cancel)?;
    ensure_native_format(metadata.format)?;
    cancelled(cancel)?;
    let mut required_text_keys: Vec<_> = texts.iter().map(required_text_key).collect();
    required_text_keys.sort_unstable();
    required_text_keys.dedup();
    Ok(FontInput {
        original_reference: reference.clone(),
        original_content_key: representation_key(&media, &metadata)?,
        original_media: Arc::clone(&media),
        original_metadata: metadata.clone(),
        required_text_keys: required_text_keys.into(),
        package_hash: reference.package_hash.clone(),
        media,
        metadata,
    })
}

/// OTF parsing is represented, but its native capability awaits an actual
/// licensed OTF fixture and full qualification evidence. Never forge an OTTO
/// header on a TTF to open this whitelist.
pub(crate) fn ensure_native_format(format: FontFormat) -> Result<()> {
    match format {
        FontFormat::Ttf => Ok(()),
        FontFormat::Otf => Err(JobError::new(
            "font_format_not_prepared",
            "OTF 尚无许可测试资产与本机准备证据",
        )),
    }
}

/// Exact representation identity deduplicates asset aliases and packages that
/// contain identical font bytes. Qualification adds its own environment facts.
pub(crate) fn content_key(input: &FontInput) -> Result<String> {
    if !Arc::ptr_eq(&input.media, &input.original_media)
        || input.package_hash != input.original_reference.package_hash
        || input.metadata != input.original_metadata
    {
        return Err(JobError::new(
            "font_input_changed",
            "字体固定输入在准备后被替换",
        ));
    }
    let key = representation_key(&input.media, &input.metadata)?;
    if key != input.original_content_key {
        return Err(JobError::new(
            "font_input_changed",
            "字体固定事实在准备后发生变化",
        ));
    }
    Ok(key)
}

fn representation_key(media: &PinnedMedia, info: &FontMetadata) -> Result<String> {
    let entry = &media.entry;
    if !hertz_wallpaper::valid_sha256_hex(&entry.sha256)
        || entry.bytes != info.sfnt_bytes
        || entry.mime.as_deref() != Some(info.format.mime())
        || info.probe_text.len() > 4 * MAX_PROBE_SCALARS
        || info.probe_text.chars().count() > MAX_PROBE_SCALARS
    {
        return Err(invalid("字体身份与 SFNT 事实不一致"));
    }
    let metadata =
        serde_json::to_vec(info).map_err(|error| JobError::invalid_input(error.to_string()))?;
    let encoded_bytes = entry.bytes.to_le_bytes();
    let mut digest = Sha256::new();
    for part in [
        ADAPTER_ID.as_bytes(),
        ADAPTER_VERSION.as_bytes(),
        entry.sha256.as_bytes(),
        entry.mime.as_deref().unwrap_or("").as_bytes(),
        encoded_bytes.as_slice(),
        metadata.as_slice(),
    ] {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn format(bytes: &[u8], mime: Option<&str>) -> Result<FontFormat> {
    let signature = bytes
        .get(..4)
        .ok_or_else(|| invalid("字体 SFNT 头被截断"))?;
    let format = match signature {
        b"\0\x01\0\0" => FontFormat::Ttf,
        b"OTTO" => FontFormat::Otf,
        b"ttcf" | b"wOF2" | b"wOFF" => {
            return Err(JobError::new(
                "font_format_not_prepared",
                "TTC/WOFF/WOFF2 尚无受控单 face 字体准备适配器",
            ));
        }
        _ => return Err(invalid("字体签名不是受支持的单 face SFNT")),
    };
    if mime != Some(format.mime()) {
        return Err(JobError::new(
            "font_mime_mismatch",
            "字体 MIME 与实际 SFNT 签名不一致",
        ));
    }
    Ok(format)
}

fn validate_bytes_with_cancel(
    entry: &hertz_wallpaper::VerifiedEntry,
    bytes: &[u8],
    texts: &[RequiredText],
    cancel: &AtomicBool,
) -> Result<FontMetadata> {
    let mut work = FontWork::new(cancel);
    work.spend(0)?;
    check_size(bytes.len() as u64)?;
    let mut digest = Sha256::new();
    for chunk in bytes.chunks(64 * 1024) {
        work.spend(chunk.len() as u64 / 4 + 1)?;
        digest.update(chunk);
    }
    if bytes.len() as u64 != entry.bytes || format!("{:x}", digest.finalize()) != entry.sha256 {
        return Err(JobError::new(
            "hash_mismatch",
            "字体完整长度或摘要与固定条目不一致",
        ));
    }
    let format = format(bytes, entry.mime.as_deref())?;
    ensure_native_format(format)?;
    if texts.len() > hertz_wallpaper::document::MAX_NODES {
        return Err(complexity("字体必需文字集合超过 128 个节点"));
    }
    let face = checked_face(bytes, format, &mut work)?;
    let cmap = CanonicalCmap::parse(&face, &mut work)?;
    validate_texts(&face, &cmap, texts, &mut work)?;
    let probe_text = probe_text(&face, &cmap, &mut work)?;
    let sfnt_bytes = bytes.len() as u64;
    let glyph_count = u32::from(face.number_of_glyphs());
    let cpu_budget_bytes = cpu_budget_bytes(entry.bytes, sfnt_bytes, glyph_count)?;
    Ok(FontMetadata {
        format,
        sfnt_bytes,
        glyph_count,
        cpu_budget_bytes,
        probe_text,
    })
}

#[cfg(test)]
fn validate_bytes(
    entry: &hertz_wallpaper::VerifiedEntry,
    bytes: &[u8],
    texts: &[RequiredText],
) -> Result<FontMetadata> {
    validate_bytes_with_cancel(entry, bytes, texts, &AtomicBool::new(false))
}

fn complexity(message: &str) -> JobError {
    JobError::new("font_complexity_not_prepared", message)
}

struct FontWork<'a> {
    cancel: &'a AtomicBool,
    used: u64,
    #[cfg(test)]
    cancel_at: Option<u64>,
}
impl<'a> FontWork<'a> {
    fn new(cancel: &'a AtomicBool) -> Self {
        Self {
            cancel,
            used: 0,
            #[cfg(test)]
            cancel_at: None,
        }
    }
    fn spend(&mut self, amount: u64) -> Result<()> {
        self.used = self
            .used
            .checked_add(amount)
            .ok_or_else(|| complexity("字体工作量溢出"))?;
        #[cfg(test)]
        if self.cancel_at.is_some_and(|limit| self.used >= limit) {
            self.cancel.store(true, Ordering::Release);
        }
        cancelled(self.cancel)?;
        if self.used > MAX_FONT_WORK {
            return Err(complexity("字体解析超过有界工作量"));
        }
        Ok(())
    }
}

fn cpu_budget_bytes(encoded: u64, sfnt: u64, glyphs: u32) -> Result<u64> {
    sfnt.checked_mul(4)
        .and_then(|bytes| bytes.checked_add(encoded))
        .and_then(|bytes| bytes.checked_add(u64::from(glyphs).checked_mul(64)?))
        .and_then(|bytes| bytes.checked_add(4096))
        .ok_or_else(|| JobError::new("probe_budget_exceeded", "字体 CPU 费用计算溢出"))
}

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_be_bytes(
        bytes
            .get(offset..offset + 2)
            .ok_or_else(|| invalid("字体表被截断"))?
            .try_into()
            .unwrap(),
    ))
}
fn u32_at(bytes: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_be_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or_else(|| invalid("字体表被截断"))?
            .try_into()
            .unwrap(),
    ))
}

// Validate every directory range and checksum before the parser can silently
// discard damaged optional tables. Ranges cannot overlap the header or each other.
fn check_directory(bytes: &[u8], work: &mut FontWork<'_>) -> Result<()> {
    let count = usize::from(u16_at(bytes, 4)?);
    let end = 12 + count * 16;
    if count == 0 || end > bytes.len() {
        return Err(invalid("SFNT 表目录无效"));
    }
    if count > MAX_SFNT_TABLES {
        return Err(complexity("SFNT 表数超过 128"));
    }
    let mut ranges = Vec::with_capacity(count);
    let mut previous_tag = None;
    for index in 0..count {
        work.spend(1)?;
        let record = 12 + index * 16;
        let tag = u32_at(bytes, record)?;
        if previous_tag.is_some_and(|previous| previous >= tag) {
            return Err(invalid("SFNT 表目录不是唯一有序 tag"));
        }
        previous_tag = Some(tag);
        let offset = u32_at(bytes, record + 8)? as usize;
        let length = u32_at(bytes, record + 12)? as usize;
        let table_end = offset
            .checked_add(length)
            .ok_or_else(|| invalid("字体表范围溢出"))?;
        if offset < end || !offset.is_multiple_of(4) || table_end > bytes.len() {
            return Err(invalid("SFNT 表范围或对齐无效"));
        }
        ranges.push((offset, table_end));
        let table = &bytes[offset..table_end];
        let mut checksum = 0u32;
        for (word_index, word) in table.chunks(4).enumerate() {
            if word_index.is_multiple_of(256) {
                work.spend(256)?;
            }
            let mut padded = [0u8; 4];
            padded[..word.len()].copy_from_slice(word);
            if tag == u32::from_be_bytes(*b"head") && word_index == 2 {
                padded = [0; 4];
            }
            checksum = checksum.wrapping_add(u32::from_be_bytes(padded));
        }
        if checksum != u32_at(bytes, record + 4)? {
            return Err(invalid("SFNT 表校验和不符"));
        }
        check_static_table(tag.to_be_bytes(), table)?;
    }
    ranges.sort_unstable();
    if ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(invalid("SFNT 表范围重叠"));
    }
    Ok(())
}

/// Reject variable outlines and variable-extension table versions directly in
/// the raw directory, before Face::parse can select gvar instead of glyf. The
/// same exclusion protects FontFace even if Cargo feature unification changes.
/// cmap format 14 variation sequences do not interpolate outlines and remain
/// supported by their separate bounded sequence checks.
fn check_static_table(tag: [u8; 4], table: &[u8]) -> Result<()> {
    if matches!(
        &tag,
        b"fvar"
            | b"gvar"
            | b"avar"
            | b"cvar"
            | b"VARC"
            | b"CFF2"
            | b"HVAR"
            | b"MVAR"
            | b"VVAR"
            | b"STAT"
    ) {
        return Err(complexity("当前静态 TTF 适配器不准备 variable font 表"));
    }
    let variable_extension = match &tag {
        b"GDEF" if table.len() >= 4 => u32_at(table, 0)? >= 0x0001_0003,
        b"BASE" | b"GPOS" | b"GSUB" if table.len() >= 4 => u32_at(table, 0)? >= 0x0001_0001,
        b"COLR" if table.len() >= 2 => u16_at(table, 0)? >= 1,
        _ => false,
    };
    if variable_extension {
        return Err(complexity(
            "当前静态 TTF 适配器不准备 variable-extension 表版本",
        ));
    }
    Ok(())
}

fn required_table<'a>(face: &Face<'a>, tag: &[u8; 4], min: usize) -> Result<&'a [u8]> {
    face.raw_face()
        .table(Tag::from_bytes(tag))
        .filter(|table| table.len() >= min)
        .ok_or_else(|| {
            invalid(format!(
                "字体必要表 {} 缺失或损坏",
                String::from_utf8_lossy(tag)
            ))
        })
}

fn checked_face<'a>(
    bytes: &'a [u8],
    format: FontFormat,
    work: &mut FontWork<'_>,
) -> Result<Face<'a>> {
    check_directory(bytes, work)?;
    let face =
        Face::parse(bytes, 0).map_err(|error| invalid(format!("SFNT 解析失败：{error:?}")))?;
    let head = required_table(&face, b"head", 54)?;
    if u32_at(head, 12)? != 0x5f0f_3cf5 {
        return Err(invalid("字体 head magic 无效"));
    }
    let hhea = required_table(&face, b"hhea", 36)?;
    let glyphs = usize::from(face.number_of_glyphs());
    let metrics = usize::from(u16_at(hhea, 34)?);
    if glyphs == 0 || metrics == 0 || metrics > glyphs || face.tables().hmtx.is_none() {
        return Err(invalid("字体 glyph_count/hmtx 无效"));
    }
    required_table(&face, b"hmtx", metrics * 4 + (glyphs - metrics) * 2)?;
    let maxp = required_table(
        &face,
        b"maxp",
        if format == FontFormat::Ttf { 32 } else { 6 },
    )?;
    if u32_at(maxp, 0)?
        != if format == FontFormat::Ttf {
            0x0001_0000
        } else {
            0x0000_5000
        }
    {
        return Err(invalid("字体 maxp 版本与 SFNT 格式不一致"));
    }
    match format {
        FontFormat::Ttf => {
            if face.tables().glyf.is_none() {
                return Err(invalid("字体 glyf/loca 损坏"));
            }
            let glyf = required_table(&face, b"glyf", 1)?;
            let long = match u16_at(head, 50)? {
                0 => false,
                1 => true,
                _ => return Err(invalid("字体 loca 格式无效")),
            };
            let loca = required_table(&face, b"loca", (glyphs + 1) * if long { 4 } else { 2 })?;
            let mut previous = 0;
            for glyph in 0..=glyphs {
                work.spend(1)?;
                let offset = if long {
                    u32_at(loca, glyph * 4)? as usize
                } else {
                    usize::from(u16_at(loca, glyph * 2)?) * 2
                };
                if offset < previous
                    || offset > glyf.len()
                    || (offset != previous && offset - previous < 10)
                {
                    return Err(invalid("字体 loca/glyf 范围损坏"));
                }
                previous = offset;
            }
            check_outlines(glyf, loca, long, glyphs, work)?;
        }
        FontFormat::Otf => {
            required_table(&face, b"CFF ", 4)?;
            if face.tables().cff.is_none() {
                return Err(invalid("字体 CFF 必要表损坏"));
            }
        }
    }
    Ok(face)
}

/// This adapter selects one canonical Unicode base cmap once. Its explicit
/// whitelist is formats 4/12, with optional format 14 variation proof. It does
/// not emulate a platform's fallback across arbitrarily many encoding records.
struct CanonicalCmap<'a> {
    base: ttf_parser::cmap::Subtable<'a>,
    variation: Option<ttf_parser::cmap::Subtable<'a>>,
    ranges: Vec<(u32, u32)>,
}

impl<'a> CanonicalCmap<'a> {
    fn parse(face: &Face<'a>, work: &mut FontWork<'_>) -> Result<Self> {
        let data = required_table(face, b"cmap", 4)?;
        let count = usize::from(u16_at(data, 2)?);
        if count == 0 {
            return Err(invalid("字体没有 Unicode cmap"));
        }
        if count > MAX_CMAP_RECORDS {
            return Err(complexity("cmap encoding records 超过 16"));
        }
        if u16_at(data, 0)? != 0 || 4 + count * 8 > data.len() {
            return Err(invalid("cmap encoding 目录损坏"));
        }
        let mut encodings = BTreeSet::new();
        let mut selected = None;
        let mut variation_index = None;
        for index in 0..count {
            work.spend(1)?;
            let record = 4 + index * 8;
            let platform = u16_at(data, record)?;
            let encoding = u16_at(data, record + 2)?;
            if !encodings.insert((platform, encoding)) {
                return Err(complexity("cmap 重复 platform/encoding 尚未准备"));
            }
            let offset = u32_at(data, record + 4)? as usize;
            if offset < 4 + count * 8 {
                return Err(invalid("cmap subtable 与目录重叠"));
            }
            let tail = data
                .get(offset..)
                .ok_or_else(|| invalid("cmap subtable 范围损坏"))?;
            let kind = u16_at(tail, 0)?;
            let length = match kind {
                4 => usize::from(u16_at(tail, 2)?),
                12 => u32_at(tail, 4)? as usize,
                14 => u32_at(tail, 2)? as usize,
                _ => return Err(complexity("当前字体 cmap whitelist 仅 4/12/14")),
            };
            let table = tail
                .get(..length)
                .ok_or_else(|| invalid("cmap subtable 长度损坏"))?;
            let ranges = check_cmap_ranges(table, kind, work)?;
            if kind == 14 {
                if platform != 0 || encoding != 5 {
                    return Err(complexity("variation cmap 必须为 Unicode encoding 5"));
                }
                variation_index = Some(index);
                continue;
            }
            let unicode = (platform == 0 && encoding <= 6 && encoding != 5)
                || (platform == 3 && matches!(encoding, 1 | 10));
            if !unicode {
                continue;
            }
            let priority = match (kind, platform, encoding) {
                (12, 3, 10) => 6,
                (12, 0, _) => 5,
                (12, _, _) => 4,
                (4, 3, 1) => 3,
                _ => 2,
            };
            if selected
                .as_ref()
                .is_none_or(|(_, score, _)| priority > *score)
            {
                selected = Some((index, priority, ranges));
            }
        }
        let (index, _, ranges) =
            selected.ok_or_else(|| invalid("字体没有受支持的 Unicode cmap"))?;
        let parsed = face
            .tables()
            .cmap
            .as_ref()
            .ok_or_else(|| invalid("字体 cmap 无法解析"))?;
        let base = parsed
            .subtables
            .into_iter()
            .nth(index)
            .ok_or_else(|| invalid("字体 base cmap 无法解析"))?;
        let variation = variation_index
            .map(|index| {
                parsed
                    .subtables
                    .into_iter()
                    .nth(index)
                    .ok_or_else(|| invalid("字体 variation cmap 无法解析"))
            })
            .transpose()?;
        Ok(Self {
            base,
            variation,
            ranges,
        })
    }

    fn glyph_index(&self, scalar: char) -> Option<GlyphId> {
        self.base.glyph_index(scalar as u32)
    }

    fn variation_index(&self, base: char, selector: char) -> Option<GlyphId> {
        let table = self.variation.as_ref()?;
        let ttf_parser::cmap::Format::UnicodeVariationSequences(table) = &table.format else {
            return None;
        };
        match table.glyph_index(base as u32, selector as u32)? {
            ttf_parser::cmap::GlyphVariationResult::Found(glyph) => Some(glyph),
            ttf_parser::cmap::GlyphVariationResult::UseDefault => self.glyph_index(base),
        }
    }
}

fn u24_at(bytes: &[u8], offset: usize) -> Result<u32> {
    let data = bytes
        .get(offset..offset + 3)
        .ok_or_else(|| invalid("cmap 24-bit scalar 被截断"))?;
    Ok((u32::from(data[0]) << 16) | (u32::from(data[1]) << 8) | u32::from(data[2]))
}

fn check_cmap_ranges(data: &[u8], kind: u16, work: &mut FontWork<'_>) -> Result<Vec<(u32, u32)>> {
    let mut ranges = Vec::new();
    match kind {
        4 => {
            let twice = usize::from(u16_at(data, 6)?);
            let count = twice / 2;
            if count == 0 || !twice.is_multiple_of(2) || 16 + count * 8 > data.len() {
                return Err(invalid("cmap 4 segments 损坏"));
            }
            if count > MAX_CMAP_GROUPS {
                return Err(complexity("cmap 4 segments 超过 8192"));
            }
            let mut previous = None;
            for index in 0..count {
                work.spend(1)?;
                let end = u32::from(u16_at(data, 14 + index * 2)?);
                let start = u32::from(u16_at(data, 16 + count * 2 + index * 2)?);
                if start > end || previous.is_some_and(|last| start <= last) {
                    return Err(invalid("cmap 4 ranges 不是有序不重叠区间"));
                }
                let slot = 16 + count * 6 + index * 2;
                let offset = usize::from(u16_at(data, slot)?);
                if offset != 0 {
                    let first = slot + offset;
                    let last = first + (end - start) as usize * 2 + 2;
                    if !offset.is_multiple_of(2) || first < 16 + count * 8 || last > data.len() {
                        return Err(invalid("cmap 4 glyph array 范围损坏"));
                    }
                }
                previous = Some(end);
                ranges.push((start, end));
            }
            if ranges.last().copied() != Some((0xffff, 0xffff)) {
                return Err(invalid("cmap 4 缺少终止 segment"));
            }
        }
        12 => {
            let count = u32_at(data, 12)? as usize;
            if count > MAX_CMAP_GROUPS {
                return Err(complexity("cmap 12 groups 超过 8192"));
            }
            if u16_at(data, 2)? != 0 || 16 + count * 12 > data.len() {
                return Err(invalid("cmap 12 groups 范围损坏"));
            }
            let mut previous = None;
            for index in 0..count {
                work.spend(1)?;
                let start = u32_at(data, 16 + index * 12)?;
                let end = u32_at(data, 20 + index * 12)?;
                let glyph = u32_at(data, 24 + index * 12)?;
                if start > end
                    || end > 0x10ffff
                    || previous.is_some_and(|last| start <= last)
                    || glyph
                        .checked_add(end - start)
                        .is_none_or(|last| last > u32::from(u16::MAX))
                {
                    return Err(invalid("cmap 12 scalar/glyph ranges 无效"));
                }
                previous = Some(end);
                ranges.push((start, end));
            }
        }
        14 => {
            let count = u32_at(data, 6)? as usize;
            if count > 256 {
                return Err(complexity("cmap 14 selectors 超过 256"));
            }
            if 10 + count * 11 > data.len() {
                return Err(invalid("cmap 14 selector records 损坏"));
            }
            let mut previous = None;
            let mut items = 0usize;
            for index in 0..count {
                work.spend(1)?;
                let record = 10 + index * 11;
                let selector = u24_at(data, record)?;
                if !char::from_u32(selector).is_some_and(variation_selector)
                    || previous.is_some_and(|last| selector <= last)
                {
                    return Err(invalid("cmap 14 variation selectors 无效"));
                }
                previous = Some(selector);
                for (offset_field, stride, default) in
                    [(record + 3, 4, true), (record + 7, 5, false)]
                {
                    let offset = u32_at(data, offset_field)? as usize;
                    if offset == 0 {
                        continue;
                    }
                    if offset < 10 + count * 11 {
                        return Err(invalid("cmap 14 mappings 与目录重叠"));
                    }
                    let entries = u32_at(data, offset)? as usize;
                    items = items
                        .checked_add(entries)
                        .ok_or_else(|| complexity("cmap 14 mappings 溢出"))?;
                    if entries > MAX_CMAP_GROUPS || items > MAX_CMAP_ITEMS {
                        return Err(complexity("cmap 14 mappings 超过有界数量"));
                    }
                    if offset + 4 + entries * stride > data.len() {
                        return Err(invalid("cmap 14 mapping 范围损坏"));
                    }
                    let mut last = None;
                    for mapping in 0..entries {
                        work.spend(1)?;
                        let position = offset + 4 + mapping * stride;
                        let start = u24_at(data, position)?;
                        let end = if default {
                            start + u32::from(data[position + 3])
                        } else {
                            start
                        };
                        if end > 0x10ffff || last.is_some_and(|previous| start <= previous) {
                            return Err(invalid("cmap 14 scalar ranges 无效"));
                        }
                        last = Some(end);
                    }
                }
            }
        }
        _ => unreachable!(),
    }
    Ok(ranges)
}

struct GlyphShape {
    own_work: u64,
    children: Vec<usize>,
}
#[derive(Clone, Copy)]
struct OutlineSummary {
    work: u64,
    depth: usize,
}

// Parse every glyph's compact structure, then memoize expanded work. FontFace
// never receives cyclic/deep/exponentially expanding composite classes, and no
// ttf-parser outline call occurs before this check succeeds.
fn check_outlines(
    glyf: &[u8],
    loca: &[u8],
    long: bool,
    glyphs: usize,
    work: &mut FontWork<'_>,
) -> Result<()> {
    let offset = |glyph| -> Result<usize> {
        if long {
            Ok(u32_at(loca, glyph * 4)? as usize)
        } else {
            Ok(usize::from(u16_at(loca, glyph * 2)?) * 2)
        }
    };
    let mut shapes = Vec::with_capacity(glyphs);
    let mut components = 0usize;
    for glyph in 0..glyphs {
        work.spend(1)?;
        let data = &glyf[offset(glyph)?..offset(glyph + 1)?];
        if data.is_empty() {
            shapes.push(GlyphShape {
                own_work: 1,
                children: Vec::new(),
            });
            continue;
        }
        let contours = u16_at(data, 0)? as i16;
        let mut children = Vec::new();
        let own_work = if contours >= 0 {
            let contours = contours as usize;
            let mut points = 0usize;
            for contour in 0..contours {
                work.spend(1)?;
                let end = usize::from(u16_at(data, 10 + contour * 2)?) + 1;
                if end <= points {
                    return Err(invalid("glyf contour endpoints 无效"));
                }
                points = end;
            }
            let instructions_at = 10 + contours * 2;
            let instructions = usize::from(u16_at(data, instructions_at)?);
            let mut cursor = instructions_at + 2 + instructions;
            if cursor > data.len() {
                return Err(invalid("glyf instructions 被截断"));
            }
            work.spend(instructions as u64 / 4 + 1)?;
            let mut described = 0usize;
            let mut coordinates = 0usize;
            while described < points {
                work.spend(1)?;
                let flag = *data
                    .get(cursor)
                    .ok_or_else(|| invalid("glyf point flags 被截断"))?;
                cursor += 1;
                let repeat = if flag & 8 != 0 {
                    let repeat = usize::from(
                        *data
                            .get(cursor)
                            .ok_or_else(|| invalid("glyf repeated flag 被截断"))?,
                    );
                    cursor += 1;
                    repeat + 1
                } else {
                    1
                };
                described += repeat;
                if described > points {
                    return Err(invalid("glyf point repeat 超过声明数量"));
                }
                let x = if flag & 2 != 0 {
                    1
                } else if flag & 16 != 0 {
                    0
                } else {
                    2
                };
                let y = if flag & 4 != 0 {
                    1
                } else if flag & 32 != 0 {
                    0
                } else {
                    2
                };
                coordinates += repeat * (x + y);
            }
            if cursor + coordinates > data.len() {
                return Err(invalid("glyf coordinates 被截断"));
            }
            points as u64 + 1
        } else {
            if contours != -1 {
                return Err(invalid("glyf composite contour count 无效"));
            }
            let mut cursor = 10;
            let mut instructions = false;
            loop {
                work.spend(1)?;
                let flags = u16_at(data, cursor)?;
                let child = usize::from(u16_at(data, cursor + 2)?);
                if child >= glyphs {
                    return Err(invalid("glyf component glyph 超过 glyph_count"));
                }
                children.push(child);
                components += 1;
                if children.len() > MAX_COMPOSITE_COMPONENTS || components > MAX_FACE_COMPONENTS {
                    return Err(complexity("glyf composite components 超过有界数量"));
                }
                let transforms = [8, 64, 128]
                    .into_iter()
                    .filter(|bit| flags & bit != 0)
                    .count();
                if transforms > 1 {
                    return Err(invalid("glyf composite transform flags 冲突"));
                }
                cursor += 4 + if flags & 1 != 0 { 4 } else { 2 };
                cursor += if flags & 8 != 0 {
                    2
                } else if flags & 64 != 0 {
                    4
                } else if flags & 128 != 0 {
                    8
                } else {
                    0
                };
                if cursor > data.len() {
                    return Err(invalid("glyf component arguments 被截断"));
                }
                instructions |= flags & 256 != 0;
                if flags & 32 == 0 {
                    break;
                }
            }
            if instructions {
                let length = usize::from(u16_at(data, cursor)?);
                if cursor + 2 + length > data.len() {
                    return Err(invalid("glyf composite instructions 被截断"));
                }
                work.spend(length as u64 / 4 + 1)?;
            }
            1
        };
        if own_work > MAX_GLYPH_OUTLINE_WORK {
            return Err(complexity("glyf 单字形 outline work 超限"));
        }
        shapes.push(GlyphShape { own_work, children });
    }
    let mut state = vec![0u8; glyphs];
    let mut memo = vec![None; glyphs];
    let mut total = 0u64;
    for glyph in 0..glyphs {
        let summary = summarize_outline(glyph, &shapes, &mut state, &mut memo, 1, work)?;
        total = total
            .checked_add(summary.work)
            .ok_or_else(|| complexity("glyf face outline work 溢出"))?;
        if total > MAX_FACE_OUTLINE_WORK {
            return Err(complexity("glyf face expanded outline work 超限"));
        }
    }
    Ok(())
}

fn summarize_outline(
    glyph: usize,
    shapes: &[GlyphShape],
    state: &mut [u8],
    memo: &mut [Option<OutlineSummary>],
    stack_depth: usize,
    work: &mut FontWork<'_>,
) -> Result<OutlineSummary> {
    work.spend(1)?;
    if stack_depth > MAX_OUTLINE_DEPTH {
        return Err(complexity("glyf composite depth 超过 16"));
    }
    if let Some(summary) = memo[glyph] {
        return Ok(summary);
    }
    if state[glyph] == 1 {
        return Err(invalid("glyf composite cycle"));
    }
    state[glyph] = 1;
    let mut summary = OutlineSummary {
        work: shapes[glyph].own_work,
        depth: 1,
    };
    for &child in &shapes[glyph].children {
        let child = summarize_outline(child, shapes, state, memo, stack_depth + 1, work)?;
        summary.work = summary
            .work
            .checked_add(child.work)
            .ok_or_else(|| complexity("glyf expanded outline work 溢出"))?;
        summary.depth = summary.depth.max(child.depth + 1);
        if summary.work > MAX_GLYPH_OUTLINE_WORK || summary.depth > MAX_OUTLINE_DEPTH {
            return Err(complexity("glyf expanded outline work/depth 超限"));
        }
    }
    state[glyph] = 2;
    memo[glyph] = Some(summary);
    Ok(summary)
}

/// Display-only normalization shared with the raster consumer. Author text and
/// IR values are preserved. LF is layout, TAB expands into actual space glyphs.
pub(crate) fn normalize_display_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\t', "    ")
}

fn zero_width_allowed(scalar: char) -> bool {
    matches!(scalar as u32, 0x061c | 0x200c..=0x200f | 0x202a..=0x202e | 0x2066..=0x2069)
}

fn variation_selector(scalar: char) -> bool {
    matches!(scalar as u32, 0xfe00..=0xfe0f | 0xe0100..=0xe01ef)
}

fn unsupported_control(scalar: char) -> bool {
    scalar.is_control()
        || matches!(scalar as u32,
        0x00ad | 0x0600..=0x0605 | 0x06dd | 0x070f | 0x0890..=0x0891 | 0x08e2 |
        0x180e | 0x200b..=0x200f | 0x2028..=0x202e | 0x2060..=0x206f | 0xfeff |
        0xfff9..=0xfffb | 0x110bd | 0x110cd | 0x13430..=0x1343f | 0x1bca0..=0x1bca3 |
        0x1d173..=0x1d17a | 0xe0001 | 0xe0020..=0xe007f)
}

fn glyph_error(node_id: &str, scalar: char) -> JobError {
    JobError::new(
        "font_glyph_unavailable",
        format!("文字节点 {node_id} 缺少字体字形 U+{:04X}", scalar as u32),
    )
    .with_details(
        serde_json::json!({"nodeId": node_id, "codepoint": format!("U+{:04X}", scalar as u32)}),
    )
}

fn valid_glyph(face: &Face<'_>, glyph: Option<GlyphId>) -> bool {
    glyph.is_some_and(|glyph| glyph.0 > 0 && glyph.0 < face.number_of_glyphs())
}

fn validate_texts(
    face: &Face<'_>,
    cmap: &CanonicalCmap<'_>,
    texts: &[RequiredText],
    work: &mut FontWork<'_>,
) -> Result<()> {
    if texts.len() > hertz_wallpaper::document::MAX_NODES {
        return Err(complexity("字体必需文字集合超过 128 个节点"));
    }
    for text in texts {
        work.spend(1)?;
        validate_text_with_face(face, cmap, &text.node_id, &text.text, work)?;
    }
    Ok(())
}

fn validate_text_with_face(
    face: &Face<'_>,
    cmap: &CanonicalCmap<'_>,
    node_id: &str,
    text: &str,
    work: &mut FontWork<'_>,
) -> Result<String> {
    if text.len() > 4 * 4096 {
        return Err(complexity("单节点文字超过 4096 UTF-16 单元"));
    }
    let mut units = 0;
    for scalar in text.chars() {
        work.spend(1)?;
        units += scalar.len_utf16();
        if units > 4096 {
            return Err(complexity("单节点文字超过 4096 UTF-16 单元"));
        }
    }
    let normalized = normalize_display_text(text);
    let mut previous_base = None;
    for scalar in normalized.chars() {
        work.spend(1)?;
        if scalar == '\n' || zero_width_allowed(scalar) {
            previous_base = None;
            continue;
        }
        if variation_selector(scalar) {
            if !previous_base
                .is_some_and(|base| valid_glyph(face, cmap.variation_index(base, scalar)))
            {
                return Err(glyph_error(node_id, scalar));
            }
            previous_base = None;
            continue;
        }
        if unsupported_control(scalar) {
            return Err(JobError::new("text_control_unsupported", format!("文字节点 {node_id} 不支持控制符 U+{:04X}", scalar as u32))
                .with_details(serde_json::json!({"nodeId": node_id, "codepoint": format!("U+{:04X}", scalar as u32)})));
        }
        if !valid_glyph(face, cmap.glyph_index(scalar)) {
            return Err(glyph_error(node_id, scalar));
        }
        previous_base = Some(scalar);
    }
    Ok(normalized)
}

/// Test-only slice checks. Production parsing is reachable only through
/// pin_input after its original preparation workspace has been verified.
#[cfg(test)]
fn validate_required_text(bytes: &[u8], node_id: &str, text: &str) -> Result<String> {
    check_size(bytes.len() as u64)?;
    let format = format(
        bytes,
        match bytes.get(..4) {
            Some(b"OTTO") => Some("font/otf"),
            _ => Some("font/ttf"),
        },
    )?;
    ensure_native_format(format)?;
    let cancel = AtomicBool::new(false);
    let mut work = FontWork::new(&cancel);
    let face = checked_face(bytes, format, &mut work)?;
    let cmap = CanonicalCmap::parse(&face, &mut work)?;
    validate_text_with_face(&face, &cmap, node_id, text, &mut work)
}

#[derive(Default)]
struct ProbeOutline {
    drew_segment: bool,
}
impl OutlineBuilder for ProbeOutline {
    fn move_to(&mut self, _: f32, _: f32) {}
    fn line_to(&mut self, _: f32, _: f32) {
        self.drew_segment = true;
    }
    fn quad_to(&mut self, _: f32, _: f32, _: f32, _: f32) {
        self.drew_segment = true;
    }
    fn curve_to(&mut self, _: f32, _: f32, _: f32, _: f32, _: f32, _: f32) {
        self.drew_segment = true;
    }
    fn close(&mut self) {}
}

fn probe_text(
    face: &Face<'_>,
    cmap: &CanonicalCmap<'_>,
    work: &mut FontWork<'_>,
) -> Result<String> {
    let mut text = String::new();
    let mut drawable = vec![None; usize::from(face.number_of_glyphs())];
    // Only validated, sorted, disjoint Unicode ranges are visited. Direct cached
    // base lookup is logarithmic (<=8192 groups). Each glyph is outlined once;
    // the previously checked aggregate expansion is <=1,048,576 work units.
    'ranges: for &(start, end) in &cmap.ranges {
        for codepoint in start..=end {
            work.spend(1)?;
            let Some(scalar) = char::from_u32(codepoint) else {
                continue;
            };
            if scalar.is_whitespace()
                || unsupported_control(scalar)
                || zero_width_allowed(scalar)
                || variation_selector(scalar)
            {
                continue;
            }
            let Some(glyph) = cmap
                .glyph_index(scalar)
                .filter(|glyph| valid_glyph(face, Some(*glyph)))
            else {
                continue;
            };
            let index = usize::from(glyph.0);
            let draws = match drawable[index] {
                Some(draws) => draws,
                None => {
                    let mut outline = ProbeOutline::default();
                    let draws = face
                        .outline_glyph(glyph, &mut outline)
                        .is_some_and(|bounds| {
                            bounds.x_max > bounds.x_min && bounds.y_max > bounds.y_min
                        })
                        && outline.drew_segment;
                    work.spend(1)?;
                    drawable[index] = Some(draws);
                    draws
                }
            };
            if !draws {
                continue;
            }
            text.push(scalar);
            if text.chars().count() == MAX_PROBE_SCALARS {
                break 'ranges;
            }
        }
    }
    if text.is_empty() {
        return Err(JobError::new(
            "font_probe_glyph_unavailable",
            "字体没有已证明可绘制的 probe 字形",
        ));
    }
    Ok(text)
}

#[cfg(test)]
#[path = "font_prepare_tests.rs"]
pub(super) mod tests;

#[cfg(test)]
pub(super) fn installed(
    tag: &str,
) -> (
    AssetStore,
    super::library::tempfileish::TempDir,
    AssetRef,
    hertz_wallpaper::VerifiedEntry,
) {
    tests::installed(tag)
}
