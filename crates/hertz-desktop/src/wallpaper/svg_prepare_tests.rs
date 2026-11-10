// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::{
    budget::OwnerKind,
    config::Fit,
    jobs::{new_job_id, ImportJobs, JobState},
    library::tempfileish,
};
use serde_json::json;
use std::path::Path;

const SVG: &str = r###"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#ff0000" fill-opacity="0.5"/></svg>"###;

#[test]
fn xml_delimiter_capacity_is_rejected_before_parser_allocation() {
    for body in [
        format!("<desc>{}</desc>", "=".repeat(32769)),
        format!("<!--{}-->", "<".repeat(8193)),
    ] {
        let bytes = wrapped(&body);
        assert!(bytes.len() < MAX_BYTES as usize);
        assert_eq!(
            inspect(bytes.as_bytes()).unwrap_err().code,
            "svg_complexity_exceeded"
        );
    }
    // A malformed input must fail this admission gate before XML parsing.
    assert_eq!(
        inspect(&vec![b'='; 32769]).unwrap_err().code,
        "svg_complexity_exceeded"
    );
    let prefix = r###"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><desc>"###;
    let suffix = "</desc></svg>";
    let large = format!(
        "{prefix}{}{suffix}",
        "a".repeat(MAX_BYTES as usize - prefix.len() - suffix.len())
    );
    assert_eq!(large.len(), MAX_BYTES as usize);
    assert!(
        inspect(large.as_bytes()).is_ok(),
        "ordinary text retains the 4 MiB byte boundary"
    );
    assert!(inspect(wrapped(&format!("<desc>{}</desc>", "=".repeat(32766))).as_bytes()).is_ok());
    assert!(inspect(wrapped(&format!("<!--{}-->", "<".repeat(8189))).as_bytes()).is_ok());
}

fn wrapped(body: &str) -> String {
    format!(r###"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">{body}</svg>"###)
}
fn target(width: u32, height: u32) -> ImageTarget {
    ImageTarget {
        width,
        height,
        fit: ImageFit::Contain,
        purpose: ImagePurpose::Preview,
    }
}
#[test]
fn static_shapes_gradient_and_reference_expansion_are_bounded() {
    assert_eq!(inspect(SVG.as_bytes()).unwrap().width, 8.0);
    inspect(wrapped(r###"<defs><linearGradient id="paint"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><path id="p" d="M0 0L8 0L8 8Z"/></defs><use href="#p" fill="url(#paint)"/>"###).as_bytes()).unwrap();
    for bad in [
        r###"<script/>"###,
        r###"<foreignObject/>"###,
        r###"<animate/>"###,
        r###"<filter/>"###,
        r###"<image href="data:image/png;base64,AA=="/>"###,
        r###"<rect onclick="bad()"/>"###,
        r###"<rect fill="url(file.svg#p)"/>"###,
        r###"<style>rect {fill:red}</style>"###,
        r###"<use href="#missing"/>"###,
        r###"<defs><g id="p"><use href="#p"/></g></defs>"###,
        r###"<rect transform="scale(NaN)"/>"###,
    ] {
        assert!(inspect(wrapped(bad).as_bytes()).is_err(), "accepted {bad}");
    }
    assert!(inspect(br###"<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">&x;</svg>"###).is_err());
    assert!(inspect(br###"<svg xmlns="http://www.w3.org/2000/svg"/>"###).is_err());
    assert!(inspect(wrapped(&"<g>".repeat(65)).as_bytes()).is_err());
    assert!(inspect(wrapped(&"<rect/>".repeat(1023)).as_bytes()).is_ok());
    assert!(inspect(wrapped(&"<rect/>".repeat(1024)).as_bytes()).is_err());
    assert!(
        inspect(wrapped(&format!("<path d=\"M0 0{}\"/>", "L1 1".repeat(99999))).as_bytes()).is_ok()
    );
    assert!(
        inspect(wrapped(&format!("<path d=\"M0 0{}\"/>", "L1 1".repeat(100000))).as_bytes())
            .is_err()
    );
    assert!(inspect(&vec![b' '; MAX_BYTES as usize + 1]).is_err());
}
#[test]
fn vector_targets_upscale_and_keep_usage_fit_identity() {
    let facts = inspect(SVG.as_bytes()).unwrap();
    assert_eq!(dimensions(8.0, 8.0, target(64, 64)).unwrap(), (64, 64));
    assert_eq!(dimensions(16.0, 8.0, target(100, 100)).unwrap(), (100, 50));
    assert_ne!(
        Options::new(&facts, target(64, 64), "color")
            .unwrap()
            .canonical()
            .unwrap(),
        Options::new(&facts, target(64, 64), "sprite")
            .unwrap()
            .canonical()
            .unwrap()
    );
    assert!(Options::new(&facts, target(64, 64), "mask").is_err());
}
async fn wait(jobs: &ImportJobs, id: &str) -> JobState {
    for _ in 0..2000 {
        let status = jobs.status(id).unwrap();
        if matches!(
            status.state,
            JobState::Done | JobState::Failed | JobState::Cancelled
        ) {
            if status.state == JobState::Failed {
                panic!("job failed: {:?}", status.error);
            }
            return status.state;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("SVG job did not exit");
}
async fn env(tag: &str) -> (tempfileish::TempDir, Arc<ImportJobs>) {
    let dir = tempfileish::temp_dir(tag);
    let jobs = Arc::new(ImportJobs::start(
        Library::open(dir.path()).await.unwrap(),
        AssetStore::new(dir.path()).unwrap(),
        ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
    ));
    (dir, jobs)
}
async fn import(jobs: &ImportJobs, source: &Path) -> String {
    let id = jobs.submit(new_job_id(), source.to_owned()).unwrap();
    assert_eq!(wait(jobs, &id).await, JobState::Done);
    jobs.status(&id).unwrap().package_hash.unwrap()
}
fn package(document: serde_json::Value, properties: serde_json::Value) -> Vec<u8> {
    package_with_sources(document, properties, SVG.as_bytes(), None, None)
}
fn package_with_sources(
    document: serde_json::Value,
    properties: serde_json::Value,
    svg: &[u8],
    font: Option<&[u8]>,
    raster: Option<(&str, &[u8])>,
) -> Vec<u8> {
    use std::io::Write;
    let doc = serde_json::to_vec(&document).unwrap();
    let mut manifest = json!({"formatVersion":1,"workId":"59dcced2-2d46-49f4-b661-2e48f6e42587","version":1,"title":"SVG fixture","content":{"kind":"composition","document":"document.json"},
        "assets":[{"id":"source","kind":"vector","source":"assets/source.svg"},{"id":"alias","kind":"vector","source":"assets/source.svg"}],
        "files":[{"path":"document.json","bytes":doc.len(),"sha256":format!("{:x}",Sha256::digest(&doc)),"mime":"application/json"},{"path":"assets/source.svg","bytes":svg.len(),"sha256":format!("{:x}",Sha256::digest(svg)),"mime":"image/svg+xml"}],
        "properties":properties,"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"MIT","assets":"CC0-1.0","attribution":"Synthetic SVG fixture"}});
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    if let Some(font) = font {
        let license = include_bytes!("../../../../plugin/ui/fonts/InstrumentSerif-OFL.txt");
        manifest["assets"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"font","kind":"font","source":"assets/font.ttf"}));
        for (name, bytes, mime) in [
            ("assets/font.ttf", font, "font/ttf"),
            ("licenses/font.txt", license.as_slice(), "text/plain"),
        ] {
            manifest["files"].as_array_mut().unwrap().push(json!({"path":name,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":mime}));
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        manifest["license"]["assets"] =
            json!("OFL-1.1 (Instrument Serif font); CC0-1.0 (synthetic SVG)");
    }
    if let Some((id, bytes)) = raster {
        manifest["assets"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":id,"kind":"image","source":"assets/image.png"}));
        manifest["files"].as_array_mut().unwrap().push(json!({"path":"assets/image.png","bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":"image/png"}));
        zip.start_file("assets/image.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    for (name, bytes) in [
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("document.json", doc),
        ("assets/source.svg", svg.to_vec()),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn image_document() -> serde_json::Value {
    json!({"documentVersion":1,"canvas":{"width":64,"height":64,"colorSpace":"srgb","background":"#000000"},"nodes":[{"id":"picture","type":"image","stateVersion":1,"assets":{"asset":"source"},"properties":{"width":64,"height":64,"anchorX":0,"anchorY":0,"fit":"contain"}}],"timeline":{"durationSeconds":1,"loop":true,"tracks":[]},"bindings":[]})
}
#[test]
fn cancelled_pin_input_releases_real_staged_source_handles() {
    use std::os::windows::fs::OpenOptionsExt;
    let directory = tempfileish::temp_dir("svg-source-pin-cancel");
    let store = AssetStore::new(directory.path()).unwrap();
    let source = directory.path().join("source.hwpkg");
    std::fs::write(&source, package(image_document(), json!([]))).unwrap();
    store.snapshot_input("cancel-pin", &source, None).unwrap();
    let package = store.validate_staged("cancel-pin").unwrap();
    store.unpack_projection("cancel-pin", &package).unwrap();
    let error = pin_input(
        &store,
        &package,
        "source",
        Some("cancel-pin"),
        &AtomicBool::new(true),
    )
    .err()
    .unwrap();
    assert_eq!(error.code, "cancelled");
    for path in [
        store.staging_dir("cancel-pin").join("original.hwpkg"),
        store
            .staging_dir("cancel-pin")
            .join("files/assets/source.svg"),
    ] {
        drop(
            std::fs::OpenOptions::new()
                .write(true)
                .share_mode(0)
                .open(path)
                .unwrap(),
        );
    }
}
#[tokio::test]
async fn exact_same_package_ttf_is_used_and_missing_family_fails() {
    use base64::Engine;
    let css = include_str!("../../../../plugin/ui/fonts/brand.css");
    let encoded = css
        .split("data:font/ttf;base64,")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    let mut db = usvg::fontdb::Database::new();
    db.load_font_data(bytes.clone());
    let family = db.faces().next().unwrap().families[0].0.clone();
    let svg = wrapped(&format!(
        "<text x=\"1\" y=\"6\" font-family=\"{family}\" font-size=\"6\">H</text>"
    ));
    let (dir, jobs) = env("svg-exact-ttf").await;
    let source = dir.path().join("font.hwpkg");
    std::fs::write(
        &source,
        package_with_sources(
            image_document(),
            json!([]),
            svg.as_bytes(),
            Some(&bytes),
            None,
        ),
    )
    .unwrap();
    let hash = import(&jobs, &source).await;
    let (_, receive) = jobs
        .prepare_svg(
            new_job_id(),
            crate::wallpaper::jobs::SvgPrepareRequest {
                reference: crate::wallpaper::target_planner::AssetRef {
                    package_hash: hash.clone(),
                    asset_id: "source".into(),
                    variant_id: None,
                },
                target: target(64, 64),
                usage: "color".into(),
            },
        )
        .unwrap();
    let media = receive.await.unwrap().unwrap();
    assert_eq!(media.svg().unwrap().fonts.len(), 1);
    assert_eq!(
        media.svg().unwrap().fonts[0].sha256,
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert!(image::open(&media.input().media.path)
        .unwrap()
        .into_rgba8()
        .pixels()
        .any(|p| p.0[3] > 0));
    assert!(
        media.svg().unwrap().prepare_cpu_bytes <= crate::wallpaper::budget::MAX_PREPARE_CPU_BYTES
    );
    let manifest = jobs.assets().read_installed_manifest(&hash).unwrap();
    let input = pin_input(
        jobs.assets(),
        &manifest,
        "source",
        None,
        &AtomicBool::new(false),
    )
    .unwrap();
    for attributes in [
        "font-family=\"Absent family\"".to_owned(),
        format!("font-family=\"{family}\" font-weight=\"700\""),
    ] {
        let svg = wrapped(&format!("<text {attributes}>H</text>"));
        let validated = validate::validate(svg.as_bytes()).unwrap();
        let failure = fonts::load(&input, &validated, &AtomicBool::new(false))
            .err()
            .unwrap();
        assert_eq!(failure.code, "svg_font_dependency_missing");
    }
    assert!(ttf_parser::Face::parse(&bytes, 0)
        .unwrap()
        .glyph_index('一')
        .is_none());
    let svg = wrapped(&format!("<text font-family=\"{family}\">一</text>"));
    let validated = validate::validate(svg.as_bytes()).unwrap();
    assert!(fonts::load(&input, &validated, &AtomicBool::new(false)).is_err());
}

#[tokio::test]
async fn curve_workspace_rejection_precedes_conversion_and_decode() {
    let dir = tempfileish::temp_dir("svg-workspace-limit");
    let decoded = Arc::new(AtomicBool::new(false));
    let observed = Arc::clone(&decoded);
    let jobs = ImportJobs::start(
        Library::open(dir.path()).await.unwrap(),
        AssetStore::new(dir.path()).unwrap(),
        ProbeClient::testing(move |_, _| {
            observed.store(true, Ordering::Release);
            Box::pin(async { Ok(()) })
        }),
    );
    let bytes = wrapped(&format!("<path d=\"M0 0{}\"/>", "L1 1".repeat(40000)));
    assert!(inspect(bytes.as_bytes()).is_ok());
    let source = dir.path().join("over-budget.svg");
    std::fs::write(&source, &bytes).unwrap();
    let id = jobs.submit(new_job_id(), source.clone()).unwrap();
    let mut failure = None;
    for _ in 0..1000 {
        let status = jobs.status(&id).unwrap();
        if status.state == JobState::Failed {
            failure = status.error;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let failure = failure.expect("over-budget SVG must fail");
    assert!(failure.contains("probe_budget_exceeded"), "{failure}");
    assert!(failure.contains("转路径/曲线工作区"), "{failure}");
    assert!(!decoded.load(Ordering::Acquire));
    assert_eq!(std::fs::read_to_string(&source).unwrap(), bytes);
    std::fs::write(&source, SVG).unwrap();
    import(&jobs, &source).await;
    assert!(decoded.load(Ordering::Acquire));
}

#[tokio::test]
async fn clipped_group_opacity_keeps_straight_alpha_and_surface_budget() {
    let (dir, jobs) = env("svg-clip-opacity").await;
    let svg = wrapped(
        r###"<defs><clipPath id="half"><rect width="4" height="8"/></clipPath></defs><g clip-path="url(#half)" opacity="0.5"><rect width="8" height="8" fill="red"/></g>"###,
    );
    let source = dir.path().join("clip.svg");
    std::fs::write(&source, svg).unwrap();
    let hash = import(&jobs, &source).await;
    let (_, receive) = jobs
        .prepare_svg(
            new_job_id(),
            crate::wallpaper::jobs::SvgPrepareRequest {
                reference: crate::wallpaper::target_planner::AssetRef {
                    package_hash: hash,
                    asset_id: "background".into(),
                    variant_id: None,
                },
                target: target(64, 64),
                usage: "color".into(),
            },
        )
        .unwrap();
    let media = receive.await.unwrap().unwrap();
    let pixels = image::open(&media.input().media.path).unwrap().into_rgba8();
    assert_eq!(pixels.get_pixel(16, 32).0, [255, 0, 0, 128]);
    assert_eq!(pixels.get_pixel(48, 32).0, [0, 0, 0, 0]);
    assert!(
        media.svg().unwrap().prepare_cpu_bytes <= crate::wallpaper::budget::MAX_PREPARE_CPU_BYTES
    );
}

#[tokio::test]
async fn clip_use_references_reject_hidden_clips_and_keep_flat_clips() {
    for shape in [
        r###"<path id="p" d="M0 0L1 0L1 1L0 1Z" clip-path="url(#inner)"/>"###,
        r###"<rect id="p" width="1" height="1" clip-path="url(#inner)"/>"###,
    ] {
        let dir = tempfileish::temp_dir("svg-hidden-clip-use");
        let decoded = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&decoded);
        let probe = ProbeClient::testing(move |_, _| {
            observed.store(true, Ordering::Release);
            Box::pin(async { Ok(()) })
        });
        let budget = probe.budget_for_test();
        let jobs = ImportJobs::start(
            Library::open(dir.path()).await.unwrap(),
            AssetStore::new(dir.path()).unwrap(),
            probe,
        );
        let invalid = wrapped(&format!(
            r###"<defs><clipPath id="inner"><rect width="1" height="1"/></clipPath>{shape}<clipPath id="outer"><rect width="8" height="8"/><use href="#p"/></clipPath></defs><g clip-path="url(#outer)"><rect width="8" height="8" fill="red"/></g>"###
        ));
        assert!(
            inspect(invalid.as_bytes()).is_ok(),
            "bounded source/reference graph is admitted before canonical clip policy"
        );
        let bad_source = dir.path().join("nested.svg");
        std::fs::write(&bad_source, &invalid).unwrap();
        let id = jobs.submit(new_job_id(), bad_source.clone()).unwrap();
        let mut failure = None;
        for _ in 0..1000 {
            let status = jobs.status(&id).unwrap();
            if status.state == JobState::Failed {
                failure = status.error;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let failure = failure.expect("hidden canonical clips must fail before raster");
        assert!(failure.contains("svg_unsupported"), "{failure}");
        assert!(failure.contains("clip 内嵌 clip"), "{failure}");
        assert!(
            !decoded.load(Ordering::Acquire),
            "no PNG qualifier can see the rejected source"
        );
        assert_eq!(budget.usage().prepare_tasks, 0);
        assert_eq!(budget.usage().prepare_cpu_bytes, 0);
        assert_eq!(std::fs::read_to_string(&bad_source).unwrap(), invalid);

        let legal = wrapped(&format!(
            r###"<defs>{}<clipPath id="outer"><use href="#p"/></clipPath></defs><g clip-path="url(#outer)"><rect width="8" height="8" fill="red"/></g>"###,
            shape.replace(r###" clip-path="url(#inner)""###, "")
        ));
        let good_source = dir.path().join("flat.svg");
        std::fs::write(&good_source, legal).unwrap();
        let package_hash = import(&jobs, &good_source).await;
        assert!(
            decoded.load(Ordering::Acquire),
            "the same owner accepts the next legal use/clip"
        );
        let (_, receive) = jobs
            .prepare_svg(
                new_job_id(),
                crate::wallpaper::jobs::SvgPrepareRequest {
                    reference: crate::wallpaper::target_planner::AssetRef {
                        package_hash,
                        asset_id: "background".into(),
                        variant_id: None,
                    },
                    target: target(8, 8),
                    usage: "color".into(),
                },
            )
            .unwrap();
        let media = receive.await.unwrap().unwrap();
        let pixels = image::open(&media.input().media.path).unwrap().into_rgba8();
        assert_eq!(pixels.dimensions(), (8, 8));
        assert_eq!(pixels.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(pixels.get_pixel(7, 7).0, [0, 0, 0, 0]);
        let options: serde_json::Value =
            serde_json::from_str(&media.svg().unwrap().options).unwrap();
        assert_eq!(options["clipPolicy"], CLIP_POLICY);
        let capability = crate::wallpaper::api::svg_capability();
        assert_eq!(capability["clipPolicy"], CLIP_POLICY);
        assert!(capability["unsupported"]
            .as_array()
            .unwrap()
            .contains(&json!("nestedClip")));
    }
}

#[test]
fn clip_groups_are_rejected_before_library_can_discard_their_shapes() {
    for child in [
        r###"<g><rect width="8" height="8"/></g>"###,
        r###"<use href="#shape"/>"###,
    ] {
        let source = wrapped(&format!(
            r###"<defs><g id="shape"><rect width="8" height="8"/></g><clipPath id="outer"><rect width="1" height="1"/>{child}</clipPath></defs><g clip-path="url(#outer)"><rect width="8" height="8" fill="red"/></g>"###
        ));
        let failure = validate::validate(source.as_bytes())
            .err()
            .expect("unsupported clip source");
        assert_eq!(failure.code, "svg_unsupported");
        assert!(failure.message.contains("clipPath"));
        // A bounded differential probe preserves proof of the library gap;
        // the actual preparation owner rejects before invoking this conversion.
        let document = roxmltree::Document::parse(&source).unwrap();
        let tree = usvg::Tree::from_xmltree(&document, &usvg::Options::default()).unwrap();
        let mut pixels = resvg::tiny_skia::Pixmap::new(8, 8).unwrap();
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::identity(),
            &mut pixels.as_mut(),
        );
        let corner = pixels.pixel(0, 0).unwrap();
        let far = pixels.pixel(7, 7).unwrap();
        println!(
            "clip group rejected child={child}; unchecked library 8x8 near alpha={} far alpha={}",
            corner.alpha(),
            far.alpha()
        );
        assert_eq!(corner.alpha(), 255);
        assert_eq!(
            far.alpha(),
            0,
            "usvg discards the g's full-size shape and keeps only the direct corner shape"
        );
    }
}

#[tokio::test]
async fn clip_child_admission_preserves_normal_group_use() {
    let capability = crate::wallpaper::api::svg_capability();
    assert!(capability["clipChildren"]
        .as_array()
        .unwrap()
        .contains(&json!("use")));
    for kind in ["g", "line", "use"] {
        assert!(!capability["clipUseTargets"]
            .as_array()
            .unwrap()
            .contains(&json!(kind)));
    }
    assert!(!capability["clipChildren"]
        .as_array()
        .unwrap()
        .contains(&json!("g")));
    for child in [
        r###"<g><rect width="8" height="8"/></g>"###,
        r###"<use href="#group"/>"###,
        r###"<line x1="0" y1="0" x2="8" y2="8"/>"###,
        r###"<use href="#line"/>"###,
        r###"<tspan>H</tspan>"###,
    ] {
        let xml = wrapped(&format!(
            r###"<defs><g id="group"><rect width="8" height="8"/></g><line id="line" x1="0" y1="0" x2="8" y2="8"/><clipPath id="clip"><rect width="1" height="1"/>{child}</clipPath></defs><rect width="8" height="8" clip-path="url(#clip)"/>"###
        ));
        let failure = inspect(xml.as_bytes()).unwrap_err();
        assert_eq!(failure.code, "svg_unsupported");
        assert!(failure.message.contains("clipPath"));
    }
    // Normal g/use outside clipPath conversion remains supported, including
    // a clipped content group around that referenced g.
    let svg = wrapped(
        r###"<defs><g id="group"><rect width="8" height="8" fill="red"/></g><clipPath id="clip"><title>Flat clip</title><desc>Full canvas rectangle</desc><rect width="8" height="8"/></clipPath></defs><g clip-path="url(#clip)"><use href="#group"/></g>"###,
    );
    inspect(svg.as_bytes()).unwrap();
    let (dir, jobs) = env("svg-normal-group-use").await;
    let source = dir.path().join("group-use.svg");
    std::fs::write(&source, &svg).unwrap();
    let package_hash = import(&jobs, &source).await;
    let (_, receive) = jobs
        .prepare_svg(
            new_job_id(),
            crate::wallpaper::jobs::SvgPrepareRequest {
                reference: crate::wallpaper::target_planner::AssetRef {
                    package_hash,
                    asset_id: "background".into(),
                    variant_id: None,
                },
                target: target(8, 8),
                usage: "color".into(),
            },
        )
        .unwrap();
    let media = receive.await.unwrap().unwrap();
    let pixels = image::open(&media.input().media.path).unwrap().into_rgba8();
    assert_eq!(pixels.dimensions(), (8, 8));
    assert_eq!(pixels.get_pixel(0, 0).0, [255, 0, 0, 255]);
    assert_eq!(pixels.get_pixel(7, 7).0, [255, 0, 0, 255]);
    assert_eq!(std::fs::read_to_string(source).unwrap(), svg);
}

#[tokio::test]
async fn legacy_svg_options_cannot_reuse_current_clip_policy_cache() {
    let (dir, jobs) = env("svg-clip-cache-policy").await;
    let source = dir.path().join("source.svg");
    std::fs::write(&source, SVG).unwrap();
    let hash = import(&jobs, &source).await;
    let package = jobs.assets().read_installed_manifest(&hash).unwrap();
    let input = pin_input(
        jobs.assets(),
        &package,
        "background",
        None,
        &AtomicBool::new(false),
    )
    .unwrap();
    let library = Library::open(dir.path()).await.unwrap();
    let probe = ProbeClient::testing(|_, _| Box::pin(async { Ok(()) }));
    let cancel = AtomicBool::new(false);
    let facts = inspect(SVG.as_bytes()).unwrap();
    let options = Options::new(&facts, target(8, 8), "color").unwrap();
    let current_key = key(&input, &options, &[]).unwrap();
    let current_options = options.canonical().unwrap();
    // Reproduce the original WIP canonical bytes without a clip policy. These
    // valid SVG pixels are real native output, with the previous receipt/key
    // shape; no accepted input, PNG hash or dimensions are fabricated.
    let legacy_options = current_options.replace(&format!(",\"clipPolicy\":\"{CLIP_POLICY}\""), "");
    assert_ne!(legacy_options, current_options);
    assert!(serde_json::from_str::<serde_json::Value>(&legacy_options)
        .unwrap()
        .get("clipPolicy")
        .is_none());
    let mut digest = Sha256::new();
    for bytes in [
        input.source.entry.sha256.as_bytes(),
        b"hertz-native-svg",
        PIPELINE.as_bytes(),
        legacy_options.as_bytes(),
        b"[]",
    ] {
        digest.update(bytes);
        digest.update([0]);
    }
    let legacy_key = format!("{:x}", digest.finalize());
    assert_ne!(legacy_key, current_key);
    let mut legacy = prepare(
        jobs.assets(),
        &library,
        &probe,
        "legacy-policy",
        &input,
        target(8, 8),
        "color",
        &cancel,
    )
    .await
    .unwrap();
    assert!(legacy.staged);
    assert_eq!(legacy.receipt.cache_key, current_key);
    legacy.receipt.cache_key = legacy_key.clone();
    legacy.receipt.options = legacy_options;
    let generation = legacy.relative.file_name().unwrap().to_owned();
    legacy.relative = std::path::PathBuf::from(&input.source.entry.sha256)
        .join(PIPELINE)
        .join(&legacy_key)
        .join(generation);
    std::fs::write(
        legacy.directory.join("receipt.json"),
        serde_json::to_vec(&legacy.receipt).unwrap(),
    )
    .unwrap();
    legacy.publish(jobs.assets(), &library).await.unwrap();
    // A legacy key has a real row/generation, yet old options fail the current
    // policy verifier even if that key is supplied. Normal lookup uses the
    // distinct current key and cannot find that row at all.
    assert!(cache::cached(
        jobs.assets(),
        &library,
        &input,
        &facts,
        &[],
        &options,
        &legacy_key,
        &cancel
    )
    .await
    .unwrap()
    .is_none());
    assert!(cache::cached(
        jobs.assets(),
        &library,
        &input,
        &facts,
        &[],
        &options,
        &current_key,
        &cancel
    )
    .await
    .unwrap()
    .is_none());
    let mut current = prepare(
        jobs.assets(),
        &library,
        &probe,
        "current-policy",
        &input,
        target(8, 8),
        "color",
        &cancel,
    )
    .await
    .unwrap();
    assert!(
        current.staged,
        "current policy must rebuild, not reuse legacy output"
    );
    assert_eq!(current.receipt.cache_key, current_key);
    assert_eq!(current.receipt.options, current_options);
    current.publish(jobs.assets(), &library).await.unwrap();
    let reused = cache::cached(
        jobs.assets(),
        &library,
        &input,
        &facts,
        &[],
        &options,
        &current_key,
        &cancel,
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!reused.staged);
    assert_eq!(reused.receipt.cache_key, current_key);
    assert_eq!(std::fs::read_to_string(source).unwrap(), SVG);
}
#[test]
fn inherited_stroke_curve_dash_and_empty_contour_limits_are_explicit() {
    for svg in [
        wrapped(r###"<path d="M0 0L8 8" stroke="red"/>"###),
        wrapped(r###"<rect width="4" height="4" stroke="red" stroke-linejoin="round"/>"###),
    ] {
        assert!(inspect(svg.as_bytes()).is_ok());
    }
    for body in [
        r###"<path d="M0 0Q4 8 8 0" stroke="red"/>"###,
        r###"<g stroke="red"><path d="M0 0Q4 8 8 0"/></g>"###,
        r###"<rect rx="1" width="4" height="4" stroke="red"/>"###,
        r###"<path d="M0 0L8 8" stroke="red" stroke-dasharray="1 1"/>"###,
    ] {
        assert!(inspect(wrapped(body).as_bytes()).is_err());
    }
    assert!(inspect(wrapped(&format!("<path d=\"{}\"/>", "M0 0".repeat(65))).as_bytes()).is_err());
    assert!(inspect(
        wrapped(
            r###"<g transform="scale(1000000)"><path transform="scale(2)" d="M0 0L1 1"/></g>"###
        )
        .as_bytes()
    )
    .is_err());
}

#[test]
fn inherited_dash_declarations_are_rejected_without_a_local_stroke() {
    for declaration in [
        r###"stroke-dasharray="0.000001 0.000001""###,
        r###"style="stroke-dasharray:0.000001 0.000001""###,
    ] {
        for svg in [
            format!(
                r###"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" {declaration}><path d="M0 0L8 8" stroke="red"/></svg>"###
            ),
            wrapped(&format!(
                r###"<g {declaration}><path d="M0 0L8 8" stroke="red"/></g>"###
            )),
            wrapped(&format!(r###"<path {declaration} d="M0 0L8 8"/>"###)),
        ] {
            let failure = inspect(svg.as_bytes()).unwrap_err();
            assert_eq!(failure.code, "svg_unsupported");
            assert!(failure.message.contains("stroke-dasharray"));
        }
    }
    for declaration in [
        r###"stroke-dasharray="none""###,
        r###"style="stroke-dasharray:none""###,
    ] {
        let svg = format!(
            r###"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" {declaration}><g><path d="M0 0L8 8" stroke="red"/></g></svg>"###
        );
        inspect(svg.as_bytes()).unwrap();
    }
}

#[test]
fn inline_css_cannot_mask_original_geometry_references_or_forbidden_attributes() {
    let hidden_path = wrapped(&format!(
        r###"<path d="M0 0{}" style="d:M0 0L1 1"/>"###,
        "L1 1".repeat(40000)
    ));
    assert!(inspect(hidden_path.as_bytes())
        .unwrap_err()
        .message
        .contains("CSS presentation"));
    let mut graph =
        r###"<defs><path id="small" d="M0 0L1 1"/><g id="n0"><use href="#small"/></g>"###
            .to_owned();
    for i in 1..=11 {
        let previous = i - 1;
        graph.push_str(&format!(r###"<g id="n{i}"><use href="#n{previous}" style="href:#small"/><use href="#n{previous}" style="href:#small"/></g>"###));
    }
    graph.push_str(r###"</defs><use href="#n11" style="href:#small"/>"###);
    assert!(inspect(wrapped(&graph).as_bytes())
        .unwrap_err()
        .message
        .contains("CSS presentation"));
    for field in [
        "id",
        "href",
        "d",
        "points",
        "viewBox",
        "width",
        "gradientTransform",
    ] {
        assert!(inspect(wrapped(&format!("<rect style=\"{field}:none\"/>")).as_bytes()).is_err());
    }
    for body in [
        r###"<rect fill="url(file.svg#paint)" style="fill:red"/>"###,
        r###"<rect transform="scale(NaN)" style="transform:scale(1)"/>"###,
    ] {
        assert!(inspect(wrapped(body).as_bytes()).is_err());
    }
    inspect(wrapped(r###"<rect width="8" height="8" fill="red" style="fill:blue;opacity:0.5;transform:translate(1 1)"/>"###).as_bytes()).unwrap();
}

#[test]
fn namespace_aliases_cannot_mask_geometry_or_reference_facts() {
    for body in [
        r###"<path d="M0 0L8 8" xml:d="M0 0L1 1"/>"###,
        r###"<path d="M0 0L8 8" xlink:d="M0 0L1 1"/>"###,
        r###"<use href="#small" xml:href="#other"/>"###,
        r###"<use href="#small" xlink:href="#small"/>"###,
        r###"<rect xml:stroke="red"/>"###,
    ] {
        let xml = format!(
            r###"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 8 8"><defs><path id="small" d="M0 0L8 8"/></defs>{body}</svg>"###
        );
        assert!(inspect(xml.as_bytes()).is_err());
    }
    inspect(br###"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 8 8" xml:space="preserve"><defs><path id="small" d="M0 0L8 8"/></defs><use xlink:href="#small"/></svg>"###).unwrap();
}

#[tokio::test]
async fn internal_svg_representation_ids_cannot_collide_with_author_image_ids() {
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        8,
        8,
        image::Rgba([0, 255, 0, 255]),
    ))
    .write_to(&mut encoded, image::ImageFormat::Png)
    .unwrap();
    let encoded = encoded.into_inner();
    for vector_first in [true, false] {
        let index = if vector_first { 0 } else { 1 };
        let collision = format!("svg-use-{index}-asset");
        let vector = json!({"id":"vector","type":"image","stateVersion":1,"assets":{"asset":"source"},"properties":{"width":64,"height":64,"anchorX":0,"anchorY":0,"fit":"contain"}});
        let image = json!({"id":"bitmap","type":"image","stateVersion":1,"assets":{"asset":collision},"properties":{"width":16,"height":16,"anchorX":0,"anchorY":0,"fit":"contain"}});
        let mut document = image_document();
        document["nodes"] = json!(if vector_first {
            vec![vector, image]
        } else {
            vec![image, vector]
        });
        let (dir, jobs) = env(&format!("svg-image-id-collision-{index}")).await;
        let source = dir.path().join("mixed.hwpkg");
        std::fs::write(
            &source,
            package_with_sources(
                document,
                json!([]),
                SVG.as_bytes(),
                None,
                Some((&collision, &encoded)),
            ),
        )
        .unwrap();
        let hash = import(&jobs, &source).await;
        let prepared = crate::wallpaper::composition_plan::resolve(
            Arc::clone(&jobs),
            hash,
            serde_json::Map::new(),
            target(64, 64),
            Fit::Contain,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        let plan = prepared
            .gl_plan(OwnerKind::Preview, "svg-collision".into(), 1, 60, 15)
            .unwrap();
        let projection = prepared
            .projection("svg-collision", 1, 1, &plan.limits)
            .unwrap();
        let assets = projection["resolvedAssets"].as_array().unwrap();
        assert_eq!(assets.len(), 2);
        let bitmap = assets.iter().find(|a| a["assetId"] == collision).unwrap();
        let vector = assets.iter().find(|a| a["assetId"] == "source").unwrap();
        assert_eq!(bitmap["representationId"], collision);
        assert_eq!(bitmap["logicalKind"], "image");
        assert_eq!(bitmap["width"], 8);
        assert_eq!(bitmap["height"], 8);
        assert_eq!(
            vector["representationId"],
            format!("@svg-use/{index}/asset")
        );
        assert_eq!(vector["logicalKind"], "vector");
        assert_eq!(vector["width"], 64);
        assert_eq!(vector["height"], 64);
        assert_eq!(
            vector["sourceHash"],
            format!("{:x}", Sha256::digest(SVG.as_bytes()))
        );
        assert_ne!(bitmap["contentKey"], vector["contentKey"]);
        let uses = projection["resolvedUses"].as_array().unwrap();
        assert!(uses.contains(&bitmap["representationId"]));
        assert!(uses.contains(&vector["representationId"]));
    }
}
#[tokio::test]
async fn cancellation_retains_original_slot_until_qualification_returns() {
    let dir = tempfileish::temp_dir("svg-cancel");
    let entered = Arc::new(AtomicBool::new(false));
    let released = Arc::new(AtomicBool::new(false));
    let (started, release) = (Arc::clone(&entered), Arc::clone(&released));
    let jobs = ImportJobs::start(
        Library::open(dir.path()).await.unwrap(),
        AssetStore::new(dir.path()).unwrap(),
        ProbeClient::testing(move |_, _| {
            let (started, release) = (Arc::clone(&started), Arc::clone(&release));
            Box::pin(async move {
                started.store(true, Ordering::Release);
                while !release.load(Ordering::Acquire) {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                Ok(())
            })
        }),
    );
    let source = dir.path().join("source.svg");
    std::fs::write(&source, SVG).unwrap();
    let id = jobs.submit(new_job_id(), source.clone()).unwrap();
    for _ in 0..1000 {
        if entered.load(Ordering::Acquire) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(entered.load(Ordering::Acquire));
    jobs.cancel(&id);
    assert_eq!(
        jobs.submit(new_job_id(), source.clone()).unwrap_err().code,
        "budget_busy"
    );
    released.store(true, Ordering::Release);
    assert_eq!(wait(&jobs, &id).await, JobState::Cancelled);
    assert_eq!(std::fs::read_to_string(source).unwrap(), SVG);
}
#[tokio::test]
async fn raw_vector_keeps_original_png_alpha_and_cache_rebuild() {
    let (dir, jobs) = env("svg-raw").await;
    let source = dir.path().join("source.svg");
    std::fs::write(&source, SVG).unwrap();
    let hash = import(&jobs, &source).await;
    let package = jobs.assets().read_installed_manifest(&hash).unwrap();
    assert!(matches!(
        package.manifest.content,
        hertz_wallpaper::Content::Composition { .. }
    ));
    assert_eq!(
        package.manifest.assets[0].kind,
        hertz_wallpaper::AssetKind::Vector
    );
    assert_eq!(package.entries.len(), 2);
    assert_eq!(import(&jobs, &source).await, hash);
    std::fs::remove_file(&source).unwrap();
    let input = pin_input(
        jobs.assets(),
        &package,
        "background",
        None,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(std::fs::read(&input.source.path).unwrap(), SVG.as_bytes());
    let reference = crate::wallpaper::target_planner::AssetRef {
        package_hash: hash.clone(),
        asset_id: "background".into(),
        variant_id: None,
    };
    let prepare = crate::wallpaper::jobs::SvgPrepareRequest {
        reference,
        target: target(64, 64),
        usage: "color".into(),
    };
    let (id, receive) = jobs.prepare_svg(new_job_id(), prepare.clone()).unwrap();
    let media = receive.await.unwrap().unwrap();
    assert_eq!(jobs.status(&id).unwrap().state, JobState::Done);
    let pixels = image::open(&media.input().media.path).unwrap().into_rgba8();
    assert_eq!(pixels.dimensions(), (64, 64));
    assert_eq!(pixels.get_pixel(32, 32).0, [255, 0, 0, 128]);
    let (id, receive) = jobs.prepare_svg(new_job_id(), prepare.clone()).unwrap();
    let warm = receive.await.unwrap().unwrap();
    assert_eq!(jobs.status(&id).unwrap().state, JobState::Done);
    assert_eq!(media.content_key(), warm.content_key());
    let path = warm.input().media.path.clone();
    drop(warm);
    drop(media);
    std::fs::write(&path, b"corrupt").unwrap();
    let (_, receive) = jobs.prepare_svg(new_job_id(), prepare).unwrap();
    let rebuilt = receive.await.unwrap().unwrap();
    assert_ne!(rebuilt.input().media.path, path);
    assert_eq!(
        image::open(&rebuilt.input().media.path).unwrap().width(),
        64
    );
}
#[tokio::test]
async fn final_vector_switch_alias_and_multiple_consumer_targets_are_projected() {
    let (dir, jobs) = env("svg-consumers").await;
    let document = json!({"documentVersion":1,"canvas":{"width":64,"height":64,"colorSpace":"srgb","background":"#000000"},
        "nodes":[{"id":"picture","type":"image","stateVersion":1,"assets":{"asset":"source"},"properties":{"width":64,"height":64,"anchorX":0,"anchorY":0,"fit":"contain"}},
        {"id":"sprites","type":"particles","stateVersion":1,"assets":{"spriteAsset":"source"},"properties":{"count":1,"width":64,"height":64,"anchorX":0,"anchorY":0}}],"timeline":{"durationSeconds":1,"loop":true,"tracks":[]},"bindings":[]});
    let properties = json!([{ "id":"picture-asset","label":"Picture asset","type":"asset","default":"source","constraints":{"kind":"vector","options":["source","alias"]},"target":{"kind":"node","nodeId":"picture","property":"asset","component":null}}]);
    let source = dir.path().join("vectors.hwpkg");
    std::fs::write(&source, package(document, properties)).unwrap();
    let hash = import(&jobs, &source).await;
    let prepared = crate::wallpaper::composition_plan::resolve(
        Arc::clone(&jobs),
        hash,
        serde_json::Map::from_iter([("picture-asset".into(), json!("alias"))]),
        target(64, 64),
        Fit::Contain,
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    let plan = prepared
        .gl_plan(OwnerKind::Preview, "svg-test".into(), 1, 60, 15)
        .unwrap();
    let projection = prepared.projection("svg-test", 1, 1, &plan.limits).unwrap();
    let assets = projection["resolvedAssets"].as_array().unwrap();
    assert_eq!(assets.len(), 2);
    assert!(assets
        .iter()
        .any(|a| a["assetId"] == "alias" && a["width"] == 64));
    assert!(assets
        .iter()
        .any(|a| a["assetId"] == "source" && a["width"] == 4));
    assert!(assets.iter().all(|a| a["logicalKind"] == "vector"
        && a["representationKind"] == "image"
        && a["mime"] == "image/png"
        && a["adapterId"] == ADAPTER_ID));
    assert_ne!(assets[0]["contentKey"], assets[1]["contentKey"]);
    assert_eq!(projection["resolvedUses"].as_array().unwrap().len(), 2);
}
#[tokio::test]
async fn raw_missing_font_fails_without_modifying_user_source() {
    let (dir, jobs) = env("svg-font-missing").await;
    let bytes = wrapped(r###"<text font-family="Missing" font-size="4">Hello</text>"###);
    let source = dir.path().join("text.svg");
    std::fs::write(&source, &bytes).unwrap();
    let id = jobs.submit(new_job_id(), source.clone()).unwrap();
    for _ in 0..500 {
        let status = jobs.status(&id).unwrap();
        if status.state == JobState::Failed {
            assert!(status
                .error
                .unwrap()
                .contains("svg_font_dependency_missing"));
            assert_eq!(std::fs::read_to_string(source).unwrap(), bytes);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("missing font did not fail");
}
