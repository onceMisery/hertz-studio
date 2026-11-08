// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;
use crate::wallpaper::{
    config::Selection,
    image_prepare::{ImageFit, ImagePurpose, ImageTarget},
    jobs::ImportJobs,
    library::{InstallWork, LOCAL_SOURCE},
    playlist::{FixedVersion, Mode, Playlist, Repository},
    selection_plan::{self, PlaylistResume, ResolvedSelection, SelectionOptions},
};
use serde_json::{json, Map, Value};
use std::sync::Mutex;

const WORK_ID: &str = "c17ed10a-5c55-4a52-85dc-7509f9e88aae";

fn target() -> ImageTarget {
    ImageTarget {
        width: 64,
        height: 48,
        fit: ImageFit::Contain,
        purpose: ImagePurpose::Preview,
    }
}

fn properties(asset: &str) -> Map<String, Value> {
    json!({"background-choice": asset})
        .as_object()
        .unwrap()
        .clone()
}

fn videos() -> [Vec<u8>; 2] {
    let first = include_bytes!("../../../../scripts/fixtures/wallpaper-vp8.webm").to_vec();
    let mut second = first.clone();
    // Replace only the four-byte MuxingApp string. EBML lengths, cluster offsets and
    // the real VP8 packets remain intact, while the two sources have different hashes.
    let muxing_app = b"\x4d\x80\x84Lavf";
    let offset = second
        .windows(muxing_app.len())
        .position(|bytes| bytes == muxing_app)
        .expect("the checked-in WebM fixture declares its muxing application");
    second[offset + 3..offset + muxing_app.len()].copy_from_slice(b"test");
    assert_ne!(Sha256::digest(&first), Sha256::digest(&second));
    [first, second]
}

fn png(color: [u8; 4]) -> Vec<u8> {
    let pixels = image::RgbaImage::from_pixel(64, 48, image::Rgba(color));
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(pixels)
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

async fn install(jobs: &ImportJobs, kind: &str, version: u32) -> FixedVersion {
    let (sources, extension, mime) = match kind {
        "video" => (videos(), "webm", "video/webm"),
        "image" => (
            [png([255, 0, 0, 255]), png([0, 0, 255, 255])],
            "png",
            "image/png",
        ),
        _ => panic!("unsupported media fixture"),
    };
    let mut assets = Vec::new();
    let mut files = Vec::new();
    let mut payloads = Vec::new();
    for (id, bytes) in ["first", "second"].into_iter().zip(sources) {
        let path = format!("assets/{id}.{extension}");
        assets.push(json!({"id":id,"kind":kind,"source":path,"variants":[]}));
        files.push(json!({
            "path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"mime":mime
        }));
        payloads.push((path, bytes));
    }
    if kind == "image" {
        // This is a real declared resource, but it is not a compatible image option.
        let bytes = videos()[0].clone();
        assets
            .push(json!({"id":"movie","kind":"video","source":"assets/movie.webm","variants":[]}));
        files.push(json!({
            "path":"assets/movie.webm","bytes":bytes.len(),
            "sha256":format!("{:x}",Sha256::digest(&bytes)),"mime":"video/webm"
        }));
        payloads.push(("assets/movie.webm".into(), bytes));
    }
    let manifest = json!({
        "formatVersion":1,"workId":WORK_ID,"version":version,"title":"Selectable media",
        "description":"","content":{"kind":kind,"asset":"first"},
        "assets":assets,"files":files,
        "properties":[{
            "id":"background-choice","label":"Background","type":"asset","default":"first",
            "constraints":{"kind":kind,"options":["first","second"]},
            "target":{"kind":"node","nodeId":"content","property":"asset","component":null}
        }],
        "permissions":{"audioSpectrum":false,"pointer":false},
        "license":{"code":"none","assets":"none","attribution":""}
    });
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    archive.start_file("manifest.json", options).unwrap();
    archive.write_all(manifest.to_string().as_bytes()).unwrap();
    for (path, bytes) in payloads {
        archive.start_file(path, options).unwrap();
        archive.write_all(&bytes).unwrap();
    }
    let job = format!("property-media-{kind}-{version}");
    let source = jobs.assets().root().join(format!("{job}.hwpkg"));
    std::fs::write(&source, archive.finish().unwrap().into_inner()).unwrap();
    jobs.assets().snapshot_input(&job, &source, None).unwrap();
    let package = jobs.assets().validate_staged(&job).unwrap();
    jobs.assets().unpack_projection(&job, &package).unwrap();
    jobs.assets()
        .content_writer()
        .unwrap()
        .publish_staging(&job, &package.package_hash)
        .unwrap();
    let reference = FixedVersion {
        work_key: format!("local-{WORK_ID}"),
        package_hash: package.package_hash.clone(),
    };
    jobs.library()
        .install(&InstallWork {
            remote_work_id: WORK_ID.into(),
            work_key: reference.work_key.clone(),
            title: package.manifest.title,
            description: String::new(),
            kind: kind.into(),
            package_hash: package.package_hash.clone(),
            manifest_json: package.manifest_json,
            package_bytes: jobs
                .assets()
                .installed_bytes(&package.package_hash)
                .unwrap(),
            version,
            source_id: LOCAL_SOURCE.into(),
        })
        .await
        .unwrap();
    reference
}

async fn playlist(jobs: &ImportJobs, items: Vec<FixedVersion>) -> Playlist {
    Repository::new(jobs.library())
        .save(
            None,
            None,
            "Selectable media".into(),
            Mode::Sequential,
            60,
            items,
        )
        .await
        .unwrap()
}

async fn jobs(root: &Path, probe: ProbeClient) -> Arc<ImportJobs> {
    Arc::new(ImportJobs::start(
        Library::open(root).await.unwrap(),
        AssetStore::new(root).unwrap(),
        probe,
    ))
}

async fn resolve(
    jobs: &Arc<ImportJobs>,
    selection: Selection,
    properties: Map<String, Value>,
) -> std::result::Result<selection_plan::ResolvedPlan, selection_plan::Failure> {
    selection_plan::resolve_selection_with_options(
        Arc::clone(jobs),
        selection,
        target(),
        SelectionOptions {
            properties,
            ..Default::default()
        },
        Arc::new(AtomicBool::new(false)),
    )
    .await
}

async fn second_poster(jobs: &ImportJobs, reference: &FixedVersion) -> String {
    let package = jobs
        .assets()
        .read_installed_manifest(&reference.package_hash)
        .unwrap();
    let inputs = jobs
        .assets()
        .probe_installed_media(&package, &AtomicBool::new(false))
        .unwrap();
    let first = inputs
        .iter()
        .find(|input| input.media.entry.path == "assets/first.webm")
        .unwrap();
    let second = inputs
        .iter()
        .find(|input| input.media.entry.path == "assets/second.webm")
        .unwrap();
    assert_ne!(first.media.entry.sha256, second.media.entry.sha256);
    assert!(
        cached(jobs.assets(), jobs.library(), &first.media.entry.sha256)
            .await
            .unwrap()
            .is_none()
    );
    let mut poster = stage(
        jobs.assets(),
        "override-poster",
        second,
        test_frame(&second.metadata).unwrap(),
    )
    .unwrap();
    poster.publish(jobs.assets(), jobs.library()).await.unwrap();
    poster.receipt.sha256.clone()
}

#[tokio::test]
async fn asset_override_selects_and_qualifies_the_declared_video_bytes() {
    let root = tempfileish::temp_dir("property-video-selection");
    let decoded = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&decoded);
    let jobs = jobs(
        root.path(),
        ProbeClient::testing(move |input, _| {
            seen.lock().unwrap().push(input.media.entry.sha256.clone());
            Box::pin(async { Ok(()) })
        }),
    )
    .await;
    let reference = install(&jobs, "video", 1).await;
    let hashes: Vec<_> = videos()
        .iter()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        .collect();
    for (values, id, hash) in [
        (Map::new(), "first", &hashes[0]),
        (properties("second"), "second", &hashes[1]),
    ] {
        let plan = resolve(&jobs, reference.selection(), values).await.unwrap();
        let ResolvedSelection::Media(media) = plan.content else {
            panic!("expected video media")
        };
        assert_eq!(media.reference().asset_id, id);
        assert_eq!(&media.input().media.entry.sha256, hash);
        assert_eq!(
            media.input().metadata.container,
            crate::wallpaper::media::Container::Webm
        );
        assert_eq!(media.poster().unwrap().reference().asset_id, id);
    }
    assert_eq!(
        *decoded.lock().unwrap(),
        hashes,
        "the normal prepare owner must qualify each selected source"
    );
    for values in [
        properties("missing"),
        json!({"unknown-choice":"second"})
            .as_object()
            .unwrap()
            .clone(),
    ] {
        let failure = resolve(&jobs, reference.selection(), values)
            .await
            .err()
            .unwrap();
        assert_eq!(failure.error.code, "invalid_property_value");
        assert!(
            failure.poster.is_none(),
            "a rejected override cannot expose a cached default or selected poster"
        );
        assert!(jobs
            .library()
            .contains_version(&reference.work_key, &reference.package_hash)
            .await
            .unwrap());
    }
    assert_eq!(decoded.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn missing_package_and_playlist_preserve_only_the_overridden_video_poster() {
    let root = tempfileish::temp_dir("property-video-failure");
    let jobs = jobs(
        root.path(),
        ProbeClient::testing(|_, _| panic!("missing package cannot start a decoder")),
    )
    .await;
    let reference = install(&jobs, "video", 1).await;
    let list = playlist(&jobs, vec![reference.clone()]).await;
    let poster_hash = second_poster(&jobs, &reference).await;
    let original = jobs
        .assets()
        .package_dir(&reference.package_hash)
        .join("original.hwpkg");
    std::fs::rename(&original, root.path().join("held.hwpkg")).unwrap();

    for selection in [
        reference.selection(),
        Selection::Playlist {
            playlist_id: list.playlist_id,
        },
    ] {
        let failure = resolve(&jobs, selection.clone(), properties("second"))
            .await
            .err()
            .unwrap();
        assert_eq!(failure.error.code, "asset_unavailable");
        let poster = failure
            .poster
            .expect("an override must survive playlist property preflight failure");
        assert_eq!(poster.reference().asset_id, "second");
        assert_eq!(poster.reference().package_hash, reference.package_hash);
        assert_eq!(poster.input().media.entry.sha256, poster_hash);
        assert_eq!(
            poster.input().media.entry.mime.as_deref(),
            Some("image/jpeg")
        );
        let bytes = std::fs::read(&poster.input().media.path).unwrap();
        validate(&bytes, (64, 48)).unwrap();
        drop(poster);

        for values in [
            Map::new(),
            properties("missing"),
            json!({"unknown-choice":"second"})
                .as_object()
                .unwrap()
                .clone(),
        ] {
            let failure = resolve(&jobs, selection.clone(), values)
                .await
                .err()
                .unwrap();
            assert_eq!(failure.error.code, "asset_unavailable");
            assert!(
                failure.poster.is_none(),
                "defaults and invalid overrides cannot borrow the second asset's poster"
            );
        }
        let failure = selection_plan::resolve_selection_with_options(
            Arc::clone(&jobs),
            selection,
            target(),
            SelectionOptions {
                properties: properties("second"),
                ..Default::default()
            },
            Arc::new(AtomicBool::new(true)),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(failure.error.code, "cancelled");
        assert!(failure.poster.is_none());
    }
}

#[tokio::test]
async fn playlist_preflight_failure_uses_the_resumed_versions_overridden_poster() {
    let root = tempfileish::temp_dir("property-video-resume");
    let jobs = jobs(
        root.path(),
        ProbeClient::testing(|_, _| panic!("preflight failure cannot start a decoder")),
    )
    .await;
    let first = install(&jobs, "video", 1).await;
    let resumed = install(&jobs, "video", 2).await;
    let list = playlist(&jobs, vec![first.clone(), resumed.clone()]).await;
    second_poster(&jobs, &resumed).await;
    // Fail on the first entry, before preflight can inspect the resumed version.
    let original = jobs
        .assets()
        .package_dir(&first.package_hash)
        .join("original.hwpkg");
    std::fs::rename(&original, root.path().join("held.hwpkg")).unwrap();
    let failure = selection_plan::resolve_selection_with_options(
        Arc::clone(&jobs),
        Selection::Playlist {
            playlist_id: list.playlist_id,
        },
        target(),
        SelectionOptions {
            properties: properties("second"),
            resume: Some(PlaylistResume {
                revision: list.revision,
                reference: resumed.clone(),
            }),
            ..Default::default()
        },
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(failure.error.code, "asset_unavailable");
    let poster = failure.poster.unwrap();
    assert_eq!(poster.reference().package_hash, resumed.package_hash);
    assert_eq!(poster.reference().asset_id, "second");
}

#[tokio::test]
async fn image_asset_override_prepares_selected_pixels_and_rejects_incompatible_assets() {
    let root = tempfileish::temp_dir("property-image-selection");
    let decoded = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&decoded);
    let jobs = jobs(
        root.path(),
        ProbeClient::testing(move |input, _| {
            let pixels = image::open(&input.media.path).unwrap().into_rgba8();
            seen.lock().unwrap().push(pixels.get_pixel(0, 0).0);
            Box::pin(async { Ok(()) })
        }),
    )
    .await;
    let reference = install(&jobs, "image", 1).await;
    for (values, id, pixel) in [
        (Map::new(), "first", [255, 0, 0, 255]),
        (properties("second"), "second", [0, 0, 255, 255]),
    ] {
        let plan = resolve(&jobs, reference.selection(), values).await.unwrap();
        let ResolvedSelection::Media(media) = plan.content else {
            panic!("expected image media")
        };
        assert_eq!(media.reference().asset_id, id);
        assert_eq!(
            media.input().metadata.container,
            crate::wallpaper::media::Container::Image
        );
        assert!(media.input().media.entry.path.starts_with("prepared/"));
        let pixels = image::open(&media.input().media.path).unwrap().into_rgba8();
        assert_eq!(pixels.dimensions(), (64, 48));
        assert_eq!(pixels.get_pixel(0, 0).0, pixel);
        assert!(media.poster().is_none());
    }
    assert_eq!(
        *decoded.lock().unwrap(),
        vec![[255, 0, 0, 255], [0, 0, 255, 255]]
    );
    for asset in ["movie", "missing"] {
        let failure = resolve(&jobs, reference.selection(), properties(asset))
            .await
            .err()
            .unwrap();
        assert_eq!(failure.error.code, "invalid_property_value");
        assert!(failure.poster.is_none());
        assert!(
            jobs.library()
                .contains_version(&reference.work_key, &reference.package_hash)
                .await
                .unwrap(),
            "an invalid group override must not mark valid installed media unavailable"
        );
    }
    assert_eq!(
        decoded.lock().unwrap().len(),
        2,
        "invalid overrides must fail before decoding"
    );
}
