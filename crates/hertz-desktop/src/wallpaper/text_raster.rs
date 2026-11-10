// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Pure text representation planning from the compiler's final values and
//! sealed font inputs. This does not allocate a canvas, qualify glyphs, reserve
//! a budget, or open the production composition text gate. The original font
//! preparation owner supplies proof covering the exact required final text.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};

use hertz_wallpaper::document::{CompiledDocument, FinalPublicValues, PublicTarget};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::config::Fit;
use super::font_prepare::{FontPlanFacts, PreparedFont, RequiredText};
use super::image_prepare::ImageTarget;
use super::jobs::JobError;

type Result<T> = std::result::Result<T, JobError>;

pub(crate) const ADAPTER_ID: &str = "prepared-text-raster";
pub(crate) const ADAPTER_VERSION: &str = "text-raster-v2";
pub(crate) const WRAP_VERSION: &str = "unicode-scalar-prefix-search-v2";
const SCALE_STEPS: f64 = 64.0;
const SCALE_ROUNDING_ULPS: u64 = 16;
const MAX_RASTER_EDGE: u32 = 4096;
const MAX_RASTER_PIXELS: u64 = 8_294_400;
const MAX_KEY_BYTES: usize = 32 * 1024;

/// One physical representation, shared by all listed node consumers. The
/// first consumer supplies the representative font asset ID; aliases share by
/// content identity, not by that ID.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextRasterFact {
    raster_key: String,
    font_asset_id: String,
    font_content_key: String,
    node_indices: Vec<usize>,
    logical_width: f64,
    logical_height: f64,
    width_px: u32,
    height_px: u32,
    scale: f64,
    adapter_id: &'static str,
    adapter_version: &'static str,
}

impl TextRasterFact {
    pub(crate) fn raster_key(&self) -> &str {
        &self.raster_key
    }
    pub(crate) fn font_asset_id(&self) -> &str {
        &self.font_asset_id
    }
    pub(crate) fn font_content_key(&self) -> &str {
        &self.font_content_key
    }
    pub(crate) fn node_indices(&self) -> &[usize] {
        &self.node_indices
    }
    pub(crate) fn logical_width(&self) -> f64 {
        self.logical_width
    }
    pub(crate) fn logical_height(&self) -> f64 {
        self.logical_height
    }
    pub(crate) fn width_px(&self) -> u32 {
        self.width_px
    }
    pub(crate) fn height_px(&self) -> u32 {
        self.height_px
    }
    pub(crate) fn scale(&self) -> f64 {
        self.scale
    }
    pub(crate) fn adapter_id(&self) -> &'static str {
        self.adapter_id
    }
    pub(crate) fn adapter_version(&self) -> &'static str {
        self.adapter_version
    }
}

/// Checked, deduplicated facts for the original projection/budget owner. These
/// counters are costs, not reservations or a second admission ledger.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextRasterPlan {
    text_rasters: Vec<TextRasterFact>,
    unique_raster_count: u32,
    raster_pixels: u64,
    raster_rgba_bytes: u64,
    unique_font_count: u32,
    font_cpu_bytes: u64,
}

impl TextRasterPlan {
    pub(crate) fn text_rasters(&self) -> &[TextRasterFact] {
        &self.text_rasters
    }
    pub(crate) fn unique_raster_count(&self) -> u32 {
        self.unique_raster_count
    }
    /// R in the composition cost contract.
    pub(crate) fn raster_pixels(&self) -> u64 {
        self.raster_pixels
    }
    pub(crate) fn raster_rgba_bytes(&self) -> u64 {
        self.raster_rgba_bytes
    }
    pub(crate) fn unique_font_count(&self) -> u32 {
        self.unique_font_count
    }
    /// F in the composition cost contract.
    pub(crate) fn font_cpu_bytes(&self) -> u64 {
        self.font_cpu_bytes
    }

    fn add_raster_cost(&mut self, pixels: u64) -> Result<()> {
        let bytes = pixels.checked_mul(4).ok_or_else(layout_exceeded)?;
        self.unique_raster_count = self
            .unique_raster_count
            .checked_add(1)
            .ok_or_else(layout_exceeded)?;
        self.raster_pixels = self
            .raster_pixels
            .checked_add(pixels)
            .ok_or_else(layout_exceeded)?;
        self.raster_rgba_bytes = self
            .raster_rgba_bytes
            .checked_add(bytes)
            .ok_or_else(layout_exceeded)?;
        Ok(())
    }

    fn add_font_cost(&mut self, bytes: u64) -> Result<()> {
        self.unique_font_count = self
            .unique_font_count
            .checked_add(1)
            .ok_or_else(layout_exceeded)?;
        self.font_cpu_bytes = self
            .font_cpu_bytes
            .checked_add(bytes)
            .ok_or_else(layout_exceeded)?;
        Ok(())
    }
}

/// Computes every text, including hidden/zero-scale nodes, before any resource
/// allocation. Font references must cover the compiler's final resource uses.
pub(crate) fn plan_text_rasters(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
    fonts: &BTreeMap<String, &PreparedFont>,
    target: ImageTarget,
    output_fit: Fit,
) -> Result<TextRasterPlan> {
    let facts = fonts
        .iter()
        .map(|(id, font)| Ok((id.clone(), font.input().plan_facts()?)))
        .collect::<Result<BTreeMap<_, _>>>()?;
    plan_text_rasters_from_facts(compiled, final_values, &facts, target, output_fit)
}

/// Inspection and successful preparation share every geometry, identity and
/// deduplication calculation. Sealed facts alone grant no rendering authority.
pub(crate) fn plan_text_rasters_from_facts(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
    fonts: &BTreeMap<String, FontPlanFacts<'_>>,
    target: ImageTarget,
    output_fit: Fit,
) -> Result<TextRasterPlan> {
    let values = FinalSlots::new(compiled, final_values)?;
    let required = collect_required_texts(&values, final_values)?;
    for (asset_id, texts) in &required {
        let font = fonts
            .get(asset_id)
            .filter(|font| font.reference().asset_id == *asset_id)
            .ok_or_else(|| {
                JobError::new("font_not_prepared", "最终字体资源没有确切的准备对象")
                    .with_details(serde_json::json!({"fontAssetId": asset_id}))
            })?;
        if !font.covers_required_texts(texts) {
            return Err(JobError::new(
                "font_not_prepared",
                "最终文字集合未由所选字体的原准备任务验证",
            )
            .with_details(serde_json::json!({"fontAssetId": asset_id})));
        }
    }
    let fit = Affine::target_fit(compiled, target, output_fit)?;
    let mut plan = TextRasterPlan::default();
    let mut raster_indices = BTreeMap::new();
    let mut font_keys = BTreeSet::new();
    for (index, node) in compiled.ir().nodes().iter().enumerate() {
        if node.node_type != "text" {
            continue;
        }
        let font_asset_id = final_font_asset_id(final_values, index)?;
        let font = fonts
            .get(font_asset_id)
            .filter(|font| font.reference().asset_id == font_asset_id)
            .ok_or_else(|| font_unavailable(index, "最终字体资源没有确切的准备对象"))?;
        let world = values.text_matrix(index)?;
        let scale = canonical_scale(fit.multiply(world)?.maximum_scale()?)?;
        let logical_width = values.number(index, "width")?;
        let logical_height = values.number(index, "height")?;
        let (width_px, height_px, pixels) =
            raster_dimensions(logical_width, logical_height, scale)?;
        let key = raster_key(&RasterIdentity {
            text: values.string(index, "text")?,
            font_content_key: font.content_key(),
            font_adapter_id: font.adapter_id(),
            font_adapter_version: font.adapter_version(),
            font_size: values.number(index, "fontSize")?,
            color: values.string(index, "color")?,
            align: values.string(index, "align")?,
            line_height: values.number(index, "lineHeight")?,
            logical_width,
            logical_height,
            scale,
            adapter_id: ADAPTER_ID,
            adapter_version: ADAPTER_VERSION,
            wrap_version: WRAP_VERSION,
        })?;
        if let Some(&raster_index) = raster_indices.get(&key) {
            let raster: &mut TextRasterFact = &mut plan.text_rasters[raster_index];
            raster.node_indices.push(index);
        } else {
            plan.add_raster_cost(pixels)?;
            raster_indices.insert(key.clone(), plan.text_rasters.len());
            plan.text_rasters.push(TextRasterFact {
                raster_key: key,
                font_asset_id: font_asset_id.to_owned(),
                font_content_key: font.content_key().to_owned(),
                node_indices: vec![index],
                logical_width,
                logical_height,
                width_px,
                height_px,
                scale,
                adapter_id: ADAPTER_ID,
                adapter_version: ADAPTER_VERSION,
            });
        }
        if font_keys.insert((
            font.content_key(),
            font.adapter_id(),
            font.adapter_version(),
        )) {
            plan.add_font_cost(font.sealed_metadata().cpu_budget_bytes)?;
        }
    }
    Ok(plan)
}

/// The original preparation owner can use this exact IR-derived request before
/// obtaining the fonts later consumed by plan_text_rasters. No author JSON or
/// default font fallback is interpreted here.
pub(crate) fn required_texts_by_font(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
) -> Result<BTreeMap<String, Vec<RequiredText>>> {
    collect_required_texts(&FinalSlots::new(compiled, final_values)?, final_values)
}

fn collect_required_texts(
    values: &FinalSlots<'_>,
    final_values: &FinalPublicValues,
) -> Result<BTreeMap<String, Vec<RequiredText>>> {
    let mut required = BTreeMap::<String, Vec<RequiredText>>::new();
    for (index, node) in values.compiled.ir().nodes().iter().enumerate() {
        if node.node_type == "text" {
            let asset_id = final_font_asset_id(final_values, index)?;
            required
                .entry(asset_id.to_owned())
                .or_default()
                .push(RequiredText {
                    node_id: node.id.clone(),
                    text: values.string(index, "text")?.to_owned(),
                });
        }
    }
    Ok(required)
}

fn final_font_asset_id(final_values: &FinalPublicValues, index: usize) -> Result<&str> {
    final_values
        .resource_uses()
        .iter()
        .find(|resource| {
            resource.node_index == Some(index)
                && resource.field == "fontAsset"
                && resource.usage == "font"
                && resource.effect_index.is_none()
        })
        .map(|resource| resource.asset_id.as_str())
        .ok_or_else(|| font_unavailable(index, "最终文字缺少字体资源"))
}

struct FinalSlots<'a> {
    compiled: &'a CompiledDocument,
    numbers: Vec<f64>,
    constants: Vec<&'a Value>,
}

impl<'a> FinalSlots<'a> {
    fn new(compiled: &'a CompiledDocument, final_values: &'a FinalPublicValues) -> Result<Self> {
        if compiled.ir().semantic_key() != final_values.semantic_key() {
            return Err(JobError::invalid_input(
                "文字栅格最终参数来自不同的已编译文档",
            ));
        }
        let mut numbers: Vec<_> = compiled
            .ir()
            .numeric_slots()
            .iter()
            .map(|slot| slot.value)
            .collect();
        let mut constants: Vec<_> = compiled
            .ir()
            .constant_slots()
            .iter()
            .map(|slot| &slot.value)
            .collect();
        for property in compiled.ir().public_properties() {
            let value = final_values
                .values()
                .get(&property.descriptor.id)
                .ok_or_else(|| JobError::invalid_input("文字栅格最终公开槽缺失"))?;
            match &property.target {
                PublicTarget::Numeric { slot } => {
                    numbers[*slot] = finite(value.as_f64().ok_or_else(layout_exceeded)?)?;
                }
                PublicTarget::Constant { slot } => constants[*slot] = value,
                _ => {}
            }
        }
        Ok(Self {
            compiled,
            numbers,
            constants,
        })
    }

    fn number(&self, index: usize, property: &str) -> Result<f64> {
        let node = &self.compiled.ir().nodes()[index];
        let slot = node
            .property_slots
            .get(property)
            .and_then(|slots| slots.first())
            .and_then(|slot| self.numbers.get(*slot))
            .ok_or_else(|| JobError::invalid_input("文字栅格数值槽缺失"))?;
        finite(*slot)
    }

    fn string(&self, index: usize, property: &str) -> Result<&str> {
        self.compiled.ir().nodes()[index]
            .constant_slots
            .get(property)
            .and_then(|slot| self.constants.get(*slot))
            .and_then(|value| value.as_str())
            .ok_or_else(|| JobError::invalid_input("文字栅格常量槽缺失"))
    }

    fn text_matrix(&self, index: usize) -> Result<Affine> {
        let mut chain = Vec::new();
        let mut current = Some(index);
        while let Some(index) = current {
            let node = self
                .compiled
                .ir()
                .nodes()
                .get(index)
                .ok_or_else(|| JobError::invalid_input("文字祖先索引无效"))?;
            if node.space != "2d" || (!chain.is_empty() && node.node_type != "group") {
                return Err(JobError::new(
                    "adapter_unavailable",
                    "文字栅格只接受完整 2D group 祖先",
                ));
            }
            if chain.len() > hertz_wallpaper::document::MAX_PARENT_DEPTH {
                return Err(JobError::invalid_input("文字祖先超过编译深度边界"));
            }
            chain.push(index);
            current = if node.parent_index < 0 {
                None
            } else {
                Some(node.parent_index as usize)
            };
        }
        let mut matrix = Affine::IDENTITY;
        for index in chain.into_iter().rev() {
            matrix = matrix.multiply(self.local_matrix(index)?)?;
        }
        Ok(matrix)
    }

    fn local_matrix(&self, index: usize) -> Result<Affine> {
        let angle = finite(self.number(index, "rotation")?.to_radians())?;
        let (sine, cosine) = angle.sin_cos();
        let sx = self.number(index, "scaleX")?;
        let sy = self.number(index, "scaleY")?;
        let a = finite(cosine * sx)?;
        let b = finite(sine * sx)?;
        let c = finite(-sine * sy)?;
        let d = finite(cosine * sy)?;
        let anchor_x = finite(self.number(index, "width")? * self.number(index, "anchorX")?)?;
        let anchor_y = finite(self.number(index, "height")? * self.number(index, "anchorY")?)?;
        Affine {
            a,
            b,
            c,
            d,
            x: finite(
                finite(self.number(index, "x")? - finite(a * anchor_x)?)? - finite(c * anchor_y)?,
            )?,
            y: finite(
                finite(self.number(index, "y")? - finite(b * anchor_x)?)? - finite(d * anchor_y)?,
            )?,
        }
        .checked()
    }
}

#[derive(Clone, Copy, Debug)]
struct Affine {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    x: f64,
    y: f64,
}

/// Shared composition canvas/ancestor transform facts for prepared vector sampling.
pub(super) fn consumer_sampling_scale(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
    index: usize,
    target: ImageTarget,
    fit: Fit,
) -> Result<f64> {
    let values = FinalSlots::new(compiled, final_values)?;
    Affine::target_fit(compiled, target, fit)?
        .multiply(values.text_matrix(index)?)?
        .maximum_scale()
}

impl Affine {
    const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        x: 0.0,
        y: 0.0,
    };

    fn checked(self) -> Result<Self> {
        for value in [self.a, self.b, self.c, self.d, self.x, self.y] {
            finite(value)?;
        }
        Ok(self)
    }

    fn target_fit(compiled: &CompiledDocument, target: ImageTarget, fit: Fit) -> Result<Self> {
        if target.width == 0 || target.height == 0 {
            return Err(layout_exceeded());
        }
        let canvas = &compiled.document().canvas;
        let sx = finite(f64::from(target.width) / f64::from(canvas.width))?;
        let sy = finite(f64::from(target.height) / f64::from(canvas.height))?;
        let (sx, sy) = match fit {
            Fit::Stretch => (sx, sy),
            Fit::Contain => (sx.min(sy), sx.min(sy)),
            Fit::Cover => (sx.max(sy), sx.max(sy)),
        };
        Self {
            a: sx,
            d: sy,
            x: finite((f64::from(target.width) - f64::from(canvas.width) * sx) / 2.0)?,
            y: finite((f64::from(target.height) - f64::from(canvas.height) * sy) / 2.0)?,
            ..Self::IDENTITY
        }
        .checked()
    }

    fn multiply(self, rhs: Self) -> Result<Self> {
        self.checked()?;
        rhs.checked()?;
        Self {
            a: finite(finite(self.a * rhs.a)? + finite(self.c * rhs.b)?)?,
            b: finite(finite(self.b * rhs.a)? + finite(self.d * rhs.b)?)?,
            c: finite(finite(self.a * rhs.c)? + finite(self.c * rhs.d)?)?,
            d: finite(finite(self.b * rhs.c)? + finite(self.d * rhs.d)?)?,
            x: finite(finite(finite(self.a * rhs.x)? + finite(self.c * rhs.y)?)? + self.x)?,
            y: finite(finite(finite(self.b * rhs.x)? + finite(self.d * rhs.y)?)? + self.y)?,
        }
        .checked()
    }

    fn maximum_scale(self) -> Result<f64> {
        self.checked()?;
        let aa_bb = finite(finite(self.a * self.a)? + finite(self.b * self.b)?)?;
        let cc_dd = finite(finite(self.c * self.c)? + finite(self.d * self.d)?)?;
        let difference = finite(aa_bb - cc_dd)?;
        let cross = finite(finite(self.a * self.c)? + finite(self.b * self.d)?)?;
        let discriminant =
            finite(finite(difference * difference)? + finite(4.0 * finite(cross * cross)?)?)?;
        let q = finite(aa_bb + cc_dd)?;
        finite((finite(q + discriminant.sqrt())? / 2.0).sqrt())
    }
}

fn finite(value: f64) -> Result<f64> {
    if value.is_finite() {
        Ok(if value == 0.0 { 0.0 } else { value })
    } else {
        Err(layout_exceeded())
    }
}

fn canonical_scale(sigma: f64) -> Result<f64> {
    let sigma = finite(sigma)?;
    if sigma < 0.0 {
        return Err(layout_exceeded());
    }
    let scaled = finite(sigma * SCALE_STEPS)?;
    let lower = scaled.floor();
    // Trigonometry, affine products and the singular-value calculation can
    // leave a few ULPs above an exact 1/64 grid point. An unconditional ceil
    // would magnify that residue into an entire raster step. Multiplication by
    // 64 is exact at these normal values; positive f64 bit order measures the
    // residue without an absolute epsilon or a tolerance on texture limits.
    // Treat at most 16 representable values immediately above the grid as
    // numerically equivalent. At sigma=3 this is <=7.11e-15 scale, or <1e-11
    // pixels for width 1360. An author increment within that window is equally
    // indistinguishable; every excess outside it retains upward quantization.
    let rounded = if lower >= 1.0
        && scaled > lower
        && scaled
            .to_bits()
            .checked_sub(lower.to_bits())
            .is_some_and(|ulps| ulps <= SCALE_ROUNDING_ULPS)
    {
        lower
    } else {
        scaled
    };
    finite(rounded.ceil().max(1.0) / SCALE_STEPS)
}

fn raster_dimensions(width: f64, height: f64, scale: f64) -> Result<(u32, u32, u64)> {
    fn edge(logical: f64, scale: f64) -> Result<u32> {
        if finite(logical)? <= 0.0 || finite(scale)? < 1.0 / SCALE_STEPS {
            return Err(layout_exceeded());
        }
        let value = finite(logical * scale)?.ceil().max(1.0);
        if value > f64::from(MAX_RASTER_EDGE) {
            return Err(layout_exceeded());
        }
        Ok(value as u32)
    }
    let width = edge(width, scale)?;
    let height = edge(height, scale)?;
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .filter(|pixels| *pixels <= MAX_RASTER_PIXELS)
        .ok_or_else(layout_exceeded)?;
    Ok((width, height, pixels))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RasterIdentity<'a> {
    text: &'a str,
    font_content_key: &'a str,
    font_adapter_id: &'a str,
    font_adapter_version: &'a str,
    font_size: f64,
    color: &'a str,
    align: &'a str,
    line_height: f64,
    logical_width: f64,
    logical_height: f64,
    scale: f64,
    adapter_id: &'a str,
    adapter_version: &'a str,
    wrap_version: &'a str,
}

struct KeyWriter {
    hash: Sha256,
    written: usize,
}

impl Write for KeyWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.written = self
            .written
            .checked_add(bytes.len())
            .filter(|written| *written <= MAX_KEY_BYTES)
            .ok_or_else(|| io::Error::other("文字栅格身份超过固定字节边界"))?;
        self.hash.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn raster_key(identity: &RasterIdentity<'_>) -> Result<String> {
    for number in [
        identity.font_size,
        identity.line_height,
        identity.logical_width,
        identity.logical_height,
        identity.scale,
    ] {
        finite(number)?;
    }
    let mut writer = KeyWriter {
        hash: Sha256::new(),
        written: 0,
    };
    serde_json::to_writer(&mut writer, identity).map_err(|_| layout_exceeded())?;
    Ok(format!("{:x}", writer.hash.finalize()))
}

fn layout_exceeded() -> JobError {
    JobError::new(
        "text_layout_budget_exceeded",
        "文字栅格尺寸、像素或成本计算超过固定边界",
    )
}

fn font_unavailable(index: usize, message: &str) -> JobError {
    JobError::new("font_not_prepared", message)
        .with_details(serde_json::json!({"nodeIndex": index}))
}

#[cfg(test)]
#[path = "text_raster_tests.rs"]
mod tests;
