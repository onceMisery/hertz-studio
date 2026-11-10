// SPDX-License-Identifier: MIT
//! Fixed CPU render and peak-live surface accounting for resvg 0.49.
use super::{
    cancelled, error,
    fonts::{self, Fonts},
    limit,
    validate::{Validated, MAX_ELEMENTS, MAX_SEGMENTS},
    Input, Options, PreparedSvg, Receipt, Result, PIPELINE,
};
use crate::wallpaper::{
    assets::AssetStore, decode_probe::ProbeClient, image_prepare, jobs::new_job_id,
};
use resvg::tiny_skia;
use std::{
    io::Write,
    sync::atomic::{AtomicBool, Ordering},
};

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| limit("SVG 工作区溢出"))
}
fn mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b).ok_or_else(|| limit("SVG 工作区溢出"))
}
fn check_tree(
    group: &usvg::Group,
    scale: tiny_skia::Transform,
    counts: &mut (u64, u64),
    depth: u64,
    canvas: (u32, u32),
    in_clip: bool,
) -> Result<u64> {
    if depth > 64 {
        return Err(limit("SVG 规范树深度超限"));
    }
    if group.mask().is_some() || !group.filters().is_empty() {
        return Err(error("SVG mask/filter 尚无受限 surface 准备"));
    }
    // resvg clip::draw_children visits every descendant (including use and
    // flattened text groups). clip_group allocates the parent clip pixmap's
    // full dimensions, so a descendant clip cannot use ordinary group bbox
    // accounting. Reject it throughout that canonical subtree before raster.
    if in_clip && group.clip_path().is_some() {
        return Err(error("SVG clip 内嵌 clip 未支持"));
    }
    let own = if group.should_isolate() {
        let bbox = group
            .layer_bounding_box()
            .transform(scale.pre_concat(group.abs_transform()))
            .ok_or_else(|| error("SVG layer bbox 无效"))?;
        let w = (bbox.width().ceil() as u64 + 4).min(5 * u64::from(canvas.0));
        let h = (bbox.height().ceil() as u64 + 4).min(5 * u64::from(canvas.1));
        // The caller caps this by resvg's exact 5x canvas max_bbox.
        mul(w, h)?
    } else {
        0
    };
    let mut live = 0u64;
    for node in group.children() {
        counts.0 = add(counts.0, 1)?;
        let child = match node {
            usvg::Node::Group(g) => check_tree(g, scale, counts, depth + 1, canvas, in_clip)?,
            usvg::Node::Path(path) => {
                if path
                    .stroke()
                    .is_some_and(|stroke| stroke.dasharray().is_some())
                {
                    return Err(error("SVG 转换后的虚线 stroke 未支持"));
                }
                if path.stroke().is_some()
                    && path.data().segments().any(|s| {
                        matches!(
                            s,
                            tiny_skia::PathSegment::QuadTo(..)
                                | tiny_skia::PathSegment::CubicTo(..)
                        )
                    })
                {
                    return Err(error("SVG 转换后的曲线 stroke 未支持"));
                }
                counts.1 = add(counts.1, path.data().segments().count() as u64)?;
                let t = scale.pre_concat(path.abs_transform());
                for p in path.data().points() {
                    let mut p = *p;
                    t.map_point(&mut p);
                    if !p.x.is_finite()
                        || !p.y.is_finite()
                        || p.x.abs() > 32768.0
                        || p.y.abs() > 32768.0
                    {
                        return Err(limit("SVG 曲线在输出坐标的工作范围超限"));
                    }
                }
                0
            }
            usvg::Node::Text(text) => {
                check_tree(text.flattened(), scale, counts, depth + 1, canvas, in_clip)?
            }
            usvg::Node::Image(_) => return Err(error("SVG image resolver 不得产生图像节点")),
        };
        live = live.max(child);
        if counts.0 > MAX_ELEMENTS || counts.1 > MAX_SEGMENTS {
            return Err(limit("SVG 规范树展开超限"));
        }
    }
    if let Some(clip) = group.clip_path() {
        if clip.clip_path().is_some() {
            return Err(error("SVG 递归 clip 尚无受限 surface 准备"));
        }
        check_tree(clip.root(), scale, counts, depth + 1, canvas, true)?;
        // resvg::clip::apply keeps an RGBA clipping surface and alpha mask
        // beside the isolated RGBA layer. No filter/pattern/mask is admitted.
        live = live.max(own.saturating_mul(2));
    }
    add(own, live)
}
fn raster(
    tree: &usvg::Tree,
    width: u32,
    height: u32,
    probe: &ProbeClient,
    cancel: &AtomicBool,
) -> Result<image::RgbaImage> {
    // The debug barrier is explicitly outside resvg, at the real checkpoint.
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    probe.svg_barrier_for_test(
        crate::wallpaper::decode_probe::harness::SvgBarrier::BeforeCancelCheck,
    );
    let result = raster_inner(tree, width, height, probe, cancel);
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    probe.svg_event_for_test("raster_exit", None);
    result
}
fn raster_inner(
    tree: &usvg::Tree,
    width: u32,
    height: u32,
    _probe: &ProbeClient,
    cancel: &AtomicBool,
) -> Result<image::RgbaImage> {
    cancelled(cancel)?;
    let mut pixmap =
        tiny_skia::Pixmap::new(width, height).ok_or_else(|| limit("SVG pixmap 分配失败"))?;
    let transform = tiny_skia::Transform::from_scale(
        width as f32 / tree.size().width(),
        height as f32 / tree.size().height(),
    );
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    {
        _probe.svg_event_for_test("pixmap_allocated", None);
        _probe.svg_barrier_for_test(
            crate::wallpaper::decode_probe::harness::SvgBarrier::AfterCancelCheckBeforeResvg,
        );
        _probe.svg_event_for_test("resvg_enter", None);
    }
    resvg::render(tree, transform, &mut pixmap.as_mut());
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    _probe.svg_event_for_test("resvg_exit", None);
    // A synchronous third-party call keeps the slot and workspace until return.
    cancelled(cancel)?;
    for pixel in pixmap.data_mut().chunks_exact_mut(4) {
        let alpha = pixel[3] as u32;
        if alpha == 0 {
            pixel[..3].fill(0);
        } else {
            for c in &mut pixel[..3] {
                *c = ((u32::from(*c) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }
    image::RgbaImage::from_raw(width, height, pixmap.take())
        .ok_or_else(|| error("SVG RGBA 维度不一致"))
}
#[allow(clippy::too_many_arguments)] // One prepared input under the original job/workspace.
pub(super) fn generate(
    store: &AssetStore,
    job: &str,
    input: &Input,
    svg: Validated<'_>,
    fonts: Fonts,
    options: Options,
    cache_key: String,
    probe: &ProbeClient,
    cancel: &AtomicBool,
) -> Result<PreparedSvg> {
    let failed = AtomicBool::new(false);
    let opts = usvg::Options {
        dpi: 96.0,
        languages: vec!["en".into()],
        font_family: "__hertz_missing_font__".into(),
        fontdb: fonts.database,
        font_resolver: fonts::resolver(&failed),
        default_size: usvg::Size::from_wh(svg.facts.width as f32, svg.facts.height as f32)
            .ok_or_else(|| error("SVG viewport 无效"))?,
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| {
                failed.store(true, Ordering::Release);
                None
            }),
            resolve_string: Box::new(|_, _| {
                failed.store(true, Ordering::Release);
                None
            }),
        },
        ..Default::default()
    };
    cancelled(cancel)?;
    // Before conversion: admitted fill edges have at most 18 clipped edges
    // (tiny-skia 0.12 edge_clipper::MAX_VERBS). An Edge is below 128 B on
    // Windows x64; 18*128*(2x Vec capacity + 1x sort scratch) plus paths,
    // transformed clones and glyph cache is covered by 8192 B/segment.
    // Curved/dashed strokes are rejected; straight-only stroke expansion is
    // included in preflight at 128*(lines+contours), before the stroker runs.
    let conversion = mul(
        add(svg.facts.expanded_segments, fonts.outline_segments)?,
        8192,
    )?;
    if add(conversion, add(fonts.cpu_bytes, 64 * 1024 * 1024)?)?
        > crate::wallpaper::budget::MAX_PREPARE_CPU_BYTES
    {
        return Err(super::JobError::new(
            "probe_budget_exceeded",
            "SVG 转路径/曲线工作区超过 320 MiB",
        ));
    }
    let tree = usvg::Tree::from_xmltree(&svg.document, &opts).map_err(error)?;
    if failed.load(Ordering::Acquire) {
        return Err(error("SVG 外部 resolver 或字体选择失败"));
    }
    if tree.size().width() as f64 != svg.facts.width
        || tree.size().height() as f64 != svg.facts.height
    {
        // f32 conversion is expected, an absent viewport/default is not.
        if (tree.size().width() as f64 - svg.facts.width).abs() > 0.01
            || (tree.size().height() as f64 - svg.facts.height).abs() > 0.01
        {
            return Err(error("SVG viewport 与作者事实不一致"));
        }
    }
    let scale = tiny_skia::Transform::from_scale(
        options.width as f32 / tree.size().width(),
        options.height as f32 / tree.size().height(),
    );
    let mut counts = (0u64, 0u64);
    let surfaces = check_tree(
        tree.root(),
        scale,
        &mut counts,
        0,
        (options.width, options.height),
        false,
    )?;
    let render_pixels = mul(options.width as u64, options.height as u64)?;
    let thumbnail_target = super::ImageTarget {
        width: 512,
        height: 512,
        fit: super::ImageFit::Contain,
        purpose: super::ImagePurpose::High,
    };
    let (tw, th) = super::dimensions(svg.facts.width, svg.facts.height, thumbnail_target)?;
    // At most 25x output pixels per layer, from resvg max_filter_bbox; the
    // actual bbox sum provides a tighter bound for ordinary isolated groups.
    let ts = tiny_skia::Transform::from_scale(
        tw as f32 / tree.size().width(),
        th as f32 / tree.size().height(),
    );
    let thumbnail_surfaces = check_tree(tree.root(), ts, &mut (0, 0), 0, (tw, th), false)?;
    let surface_bytes = mul(surfaces.max(thumbnail_surfaces), 4)?;
    let segments = add(svg.facts.expanded_segments, fonts.outline_segments)?.max(counts.1);
    let prepare_cpu_bytes = [
        input.source.entry.bytes * 6,
        svg.facts.xml_nodes * 256,
        svg.facts.expanded_elements * 256,
        mul(segments, 8192)?,
        fonts.cpu_bytes,
        mul(render_pixels.max(mul(tw as u64, th as u64)?), 8)?,
        surface_bytes,
        32 * 1024 * 1024,
    ]
    .into_iter()
    .try_fold(0, add)?;
    if prepare_cpu_bytes > crate::wallpaper::budget::MAX_PREPARE_CPU_BYTES {
        return Err(super::JobError::new(
            "probe_budget_exceeded",
            format!("SVG 工作区需要 {prepare_cpu_bytes} 字节，超过 320 MiB"),
        ));
    }
    cancelled(cancel)?;
    store.check_disk_space(64 * 1024 * 1024 + 65536)?;
    let relative = std::path::PathBuf::from(&input.source.entry.sha256)
        .join(PIPELINE)
        .join(&cache_key)
        .join(format!("gen-{}", new_job_id()));
    let directory = store.staging_dir(job).join("derived").join(&relative);
    std::fs::create_dir_all(&directory).map_err(error)?;
    let pixels = raster(&tree, options.width, options.height, probe, cancel)?;
    let render = image_prepare::write_png(&directory.join("render.png"), &pixels, cancel)?;
    drop(pixels);
    let pixels = raster(&tree, tw, th, probe, cancel)?;
    let thumbnail = image_prepare::write_png(&directory.join("thumbnail.png"), &pixels, cancel)?;
    drop(pixels);
    let receipt = Receipt {
        cache_key,
        input_hash: input.source.entry.sha256.clone(),
        pipeline: PIPELINE.into(),
        options: options.canonical()?,
        source: svg.facts,
        fonts: fonts.identities,
        prepare_cpu_bytes,
        render,
        thumbnail,
    };
    let mut f = std::fs::File::create(directory.join("receipt.json")).map_err(error)?;
    f.write_all(&serde_json::to_vec(&receipt).map_err(error)?)
        .map_err(error)?;
    f.sync_all().map_err(error)?;
    cancelled(cancel)?;
    Ok(PreparedSvg {
        receipt,
        directory,
        relative,
        staged: true,
        lease: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn use_wrapper_cannot_hide_a_clipped_group_in_clip_tree() {
        let xml = r###"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><defs><clipPath id="inner"><rect width="1" height="1"/></clipPath><path id="p" d="M0 0L1 0L1 1L0 1Z" clip-path="url(#inner)"/><clipPath id="outer"><rect width="8" height="8"/><use href="#p"/></clipPath></defs><g clip-path="url(#outer)"><rect width="8" height="8" fill="red"/></g></svg>"###;
        let input = crate::wallpaper::svg_prepare::validate::validate(xml.as_bytes()).unwrap();
        let tree = usvg::Tree::from_xmltree(&input.document, &usvg::Options::default()).unwrap();
        fn groups(group: &usvg::Group, depth: u64, found: &mut Vec<(u64, String, Option<String>)>) {
            found.push((
                depth,
                group.id().into(),
                group.clip_path().map(|clip| clip.id().into()),
            ));
            for node in group.children() {
                if let usvg::Node::Group(group) = node {
                    groups(group, depth + 1, found);
                }
            }
        }
        let clipped = match &tree.root().children()[0] {
            usvg::Node::Group(group) => group,
            _ => panic!("real clipped group"),
        };
        let outer = clipped.clip_path().unwrap();
        let mut canonical = Vec::new();
        groups(outer.root(), 0, &mut canonical);
        println!("clip-use canonical groups: {canonical:?}");
        assert!(canonical
            .iter()
            .any(|(depth, _, clip)| *depth > 1 && clip.as_deref() == Some("inner")));
        assert!(outer
            .root()
            .children()
            .iter()
            .all(|node| !matches!(node,usvg::Node::Group(group) if group.clip_path().is_some())));
        let failure = check_tree(
            tree.root(),
            tiny_skia::Transform::identity(),
            &mut (0, 0),
            0,
            (8, 8),
            false,
        )
        .unwrap_err();
        assert_eq!(failure.code, "svg_unsupported");
        assert!(failure.message.contains("clip 内嵌 clip"));
    }

    #[test]
    fn canonical_stroke_dash_is_rejected_before_raster() {
        for (dash, supported) in [("0.000001 0.000001", false), ("none", true)] {
            let xml = format!(
                r###"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" stroke-dasharray="{dash}"><path d="M0 0L8 8" stroke="red"/></svg>"###
            );
            let tree = usvg::Tree::from_str(&xml, &usvg::Options::default()).unwrap();
            let result = check_tree(
                tree.root(),
                tiny_skia::Transform::identity(),
                &mut (0, 0),
                0,
                (8, 8),
                false,
            );
            assert_eq!(result.is_ok(), supported);
            if !supported {
                assert!(result.unwrap_err().message.contains("虚线 stroke"));
            }
        }
    }
}
