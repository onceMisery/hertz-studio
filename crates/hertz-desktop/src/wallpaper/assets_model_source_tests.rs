// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::{assets::StagedPackage, library::tempfileish};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};

pub(crate) struct Fixture {
    pub(crate) store: AssetStore,
    pub(crate) root: tempfileish::TempDir,
    pub(crate) reference: AssetRef,
    pub(crate) package: StagedPackage,
    pub(crate) original: Vec<u8>,
}

pub(crate) fn package_bytes(change: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
    fn glb(generator: &str) -> Vec<u8> {
        let mut json = serde_json::to_vec(&serde_json::json!({"asset":{"version":"2.0","generator":generator},"nodes":[{}],"scenes":[{"nodes":[0]}],"scene":0})).unwrap();
        while !json.len().is_multiple_of(4) {
            json.push(b' ');
        }
        let mut bytes = b"glTF".to_vec();
        bytes.extend(2_u32.to_le_bytes());
        bytes.extend((20 + json.len() as u32).to_le_bytes());
        bytes.extend((json.len() as u32).to_le_bytes());
        bytes.extend(b"JSON");
        bytes.extend(json);
        bytes
    }
    let first = glb("first");
    let second = glb("second");
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>"#;
    let files = [
        ("models/a/source.glb", first.as_slice(), "model/gltf-binary"),
        ("models/a/low.glb", first.as_slice(), "model/gltf-binary"),
        (
            "models/b/source.glb",
            second.as_slice(),
            "model/gltf-binary",
        ),
        ("vector.svg", svg.as_slice(), "image/svg+xml"),
    ];
    let mut manifest = serde_json::json!({
        "formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Canonical models","description":"Whole original metadata survives",
        "content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[{"id":"first","kind":"model","source":"models/a/source.glb","variants":[{"id":"low","file":"models/a/low.glb","purpose":"low"}]}, {"id":"second","kind":"model","source":"models/b/source.glb","variants":[]}, {"id":"vector","kind":"vector","source":"vector.svg"}],
        "files":files.iter().map(|(path,bytes,mime)|serde_json::json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":mime})).collect::<Vec<_>>(),
        "properties":[],"permissions":{"audioSpectrum":true,"pointer":true},"license":{"code":"MIT","assets":"CC0-1.0","attribution":"Source fixture"}
    });
    change(&mut manifest);
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, bytes) in std::iter::once(("manifest.json", manifest.as_slice()))
        .chain(files.iter().map(|(path, bytes, _)| (*path, *bytes)))
    {
        zip.start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

pub(crate) fn installed(tag: &str) -> Fixture {
    let root = tempfileish::temp_dir(tag);
    let store = AssetStore::new(root.path()).unwrap();
    let original = package_bytes(|_| {});
    let input = root.path().join("user-source.hwpkg");
    std::fs::write(&input, &original).unwrap();
    let snapshot = store.snapshot_input("install-model", &input, None).unwrap();
    let package = store.validate_staged("install-model").unwrap();
    assert_eq!(snapshot.sha256, package.package_hash);
    store.unpack_projection("install-model", &package).unwrap();
    store
        .content_writer()
        .unwrap()
        .publish_staging("install-model", &package.package_hash)
        .unwrap();
    std::fs::remove_file(input).unwrap();
    drop(store);
    let store = AssetStore::new(root.path()).unwrap();
    let reference = AssetRef {
        package_hash: package.package_hash.clone(),
        asset_id: "first".into(),
        variant_id: None,
    };
    Fixture {
        store,
        root,
        reference,
        package,
        original,
    }
}

pub(crate) fn probe() -> ProbeClient {
    ProbeClient::testing(|_, _| {
        Box::pin(async { panic!("source identity must not run renderer/decoder") })
    })
}

pub(crate) fn writable(store: &AssetStore, reference: &AssetRef, entry: &str) -> bool {
    [
        store
            .package_dir(&reference.package_hash)
            .join("original.hwpkg"),
        store
            .package_dir(&reference.package_hash)
            .join("files")
            .join(entry),
    ]
    .iter()
    .all(|path| File::options().write(true).share_mode(0).open(path).is_ok())
}

#[test]
fn original_install_reopen_source_and_exact_variant_keep_distinct_canonical_paths() {
    let fixture = installed("model-source-reopen");
    let probe = probe();
    let preparation = probe.prepare_for_job("canonical-test".into(), 37).unwrap();
    let baseline = probe.budget_for_test().usage();
    let records = probe.budget_for_test().record_count_for_test();
    let source = fixture
        .store
        .pin_canonical_model_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(source.entry().path, "models/a/source.glb");
    assert_eq!(source.reference().asset_id, "first");
    assert_eq!(
        source.reservation_identity_for_test(),
        ("canonical-test", 37, "model-source")
    );
    assert_eq!(
        source.manifest().description,
        "Whole original metadata survives"
    );
    assert_eq!(source.manifest().assets.len(), 3);
    assert_eq!(source.manifest().files.len(), 4);
    assert!(source.manifest().permissions.audio_spectrum && source.manifest().permissions.pointer);
    assert_eq!(
        probe.budget_for_test().usage().cpu_bytes,
        baseline.cpu_bytes
    );
    assert!(probe.budget_for_test().usage().asset_cpu_bytes > baseline.asset_cpu_bytes);
    let mut reference = fixture.reference.clone();
    reference.variant_id = Some("low".into());
    let variant = fixture
        .store
        .pin_canonical_model_source(&reference, &probe, &preparation, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(variant.entry().path, "models/a/low.glb");
    assert_eq!(source.entry().sha256, variant.entry().sha256);
    assert_eq!(variant.reference().variant_id.as_deref(), Some("low"));
    drop(variant);
    reference.asset_id = "second".into();
    reference.variant_id = None;
    let second = fixture
        .store
        .pin_canonical_model_source(&reference, &probe, &preparation, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(second.entry().path, "models/b/source.glb");
    assert_ne!(source.entry().sha256, second.entry().sha256);
    drop(second);
    drop(source);
    assert_eq!(probe.budget_for_test().usage(), baseline);
    assert_eq!(probe.budget_for_test().record_count_for_test(), records);
    preparation.finish();
    assert_eq!(probe.stats(), (0, 0));
}

#[test]
fn last_outer_clone_keeps_files_directories_and_own_asset_ticket_until_real_drop() {
    let fixture = installed("model-source-last-anchor");
    let probe = probe();
    let preparation = probe.prepare_for_job("anchor-test".into(), 2).unwrap();
    let sibling = probe
        .job_memory(&preparation, "model-source", 0, 19)
        .unwrap();
    let baseline = probe.budget_for_test().usage();
    let records = probe.budget_for_test().record_count_for_test();
    let source = fixture
        .store
        .pin_canonical_model_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let clone = source.clone();
    let held = probe.budget_for_test().usage();
    drop(source);
    assert_eq!(probe.budget_for_test().usage(), held);
    assert!(!writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    for path in [
        fixture
            .store
            .package_dir(&fixture.reference.package_hash)
            .join("original.hwpkg"),
        fixture
            .store
            .package_dir(&fixture.reference.package_hash)
            .join("files/models/a/source.glb"),
    ] {
        assert!(std::fs::remove_file(path).is_err());
    }
    assert!(std::fs::rename(
        fixture
            .store
            .package_dir(&fixture.reference.package_hash)
            .join("files/models/a"),
        fixture
            .store
            .package_dir(&fixture.reference.package_hash)
            .join("files/models/moved")
    )
    .is_err());
    drop(clone);
    assert_eq!(probe.budget_for_test().usage(), baseline);
    assert_eq!(probe.budget_for_test().record_count_for_test(), records);
    assert!(probe.budget_for_test().stuck().is_empty());
    assert!(writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    sibling.finish();
    preparation.finish();
    assert_eq!(probe.budget_for_test().usage().asset_cpu_bytes, 0);
}

#[test]
fn initial_cancel_and_workspace_rejection_leave_no_open_files_or_ledger_mutation() {
    let fixture = installed("model-source-W-reject");
    let probe = probe();
    let preparation = probe.prepare_for_job("reject".into(), 1).unwrap();
    let budget = probe.budget_for_test();
    let before = budget.planning_snapshot();
    assert_eq!(
        fixture
            .store
            .pin_canonical_model_source(
                &fixture.reference,
                &probe,
                &preparation,
                &AtomicBool::new(true)
            )
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
    assert_eq!(budget.planning_snapshot(), before);
    let held = probe
        .image_workspace(budget::MAX_PREPARE_CPU_BYTES)
        .unwrap();
    let before = budget.planning_snapshot();
    assert_eq!(
        fixture
            .store
            .pin_canonical_model_source(
                &fixture.reference,
                &probe,
                &preparation,
                &AtomicBool::new(false)
            )
            .err()
            .unwrap()
            .code,
        "budget_busy"
    );
    assert_eq!(budget.planning_snapshot(), before);
    assert!(writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    held.finish();
    preparation.finish();
    assert!(budget.stuck().is_empty());
}

#[test]
fn retained_rejection_drops_identity_and_all_files_before_workspace_finish() {
    let fixture = installed("model-source-R-reject");
    let probe = probe();
    let preparation = probe.prepare_for_job("reject-r".into(), 1).unwrap();
    let held = probe
        .job_memory(&preparation, "model-source", 0, budget::MAX_ASSET_CPU_BYTES)
        .unwrap();
    let budget = probe.budget_for_test();
    let (revision, usage) = budget.planning_snapshot();
    let records = budget.record_count_for_test();
    let error = fixture
        .store
        .pin_canonical_model_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .err()
        .unwrap();
    assert_eq!(error.code, "budget_busy");
    assert!(error.message.contains("asset_cpu_bytes"));
    assert_eq!(budget.usage(), usage);
    assert_eq!(budget.planning_snapshot().0, revision + 8);
    assert_eq!(budget.record_count_for_test(), records);
    assert!(budget.stuck().is_empty());
    assert!(writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    held.finish();
    preparation.finish();
}

#[test]
fn nonmodel_unknown_asset_unknown_exact_variant_reject_without_fallback() {
    let fixture = installed("model-source-invalid-ref");
    let probe = probe();
    let preparation = probe.prepare_for_job("references".into(), 1).unwrap();
    let baseline = probe.budget_for_test().usage();
    for (asset, variant) in [
        ("vector", None),
        ("missing", None),
        ("first", Some("missing")),
        ("second", Some("low")),
    ] {
        let reference = AssetRef {
            asset_id: asset.into(),
            variant_id: variant.map(str::to_owned),
            ..fixture.reference.clone()
        };
        assert_eq!(
            fixture
                .store
                .pin_canonical_model_source(
                    &reference,
                    &probe,
                    &preparation,
                    &AtomicBool::new(false)
                )
                .err()
                .unwrap()
                .code,
            "package_invalid"
        );
        assert_eq!(probe.budget_for_test().usage(), baseline);
        assert!(writable(
            &fixture.store,
            &fixture.reference,
            "models/a/source.glb"
        ));
    }
    preparation.finish();
}

#[test]
fn original_hash_and_projection_length_or_hash_changes_are_real_rejections() {
    for mutation in [0, 1, 2] {
        let fixture = installed("model-source-changed");
        let probe = probe();
        let preparation = probe.prepare_for_job("changed".into(), 1).unwrap();
        let baseline = probe.budget_for_test().usage();
        let directory = fixture.store.package_dir(&fixture.reference.package_hash);
        if mutation == 0 {
            let mut bytes = fixture.original.clone();
            bytes[0] ^= 1;
            std::fs::write(directory.join("original.hwpkg"), bytes).unwrap();
        } else {
            let path = directory.join("files/models/a/source.glb");
            let mut bytes = std::fs::read(&path).unwrap();
            if mutation == 1 {
                bytes.push(0);
            } else {
                bytes[0] ^= 1;
            }
            std::fs::write(path, bytes).unwrap();
        }
        assert_eq!(
            fixture
                .store
                .pin_canonical_model_source(
                    &fixture.reference,
                    &probe,
                    &preparation,
                    &AtomicBool::new(false)
                )
                .err()
                .unwrap()
                .code,
            "hash_mismatch"
        );
        assert_eq!(probe.budget_for_test().usage(), baseline);
        assert!(writable(
            &fixture.store,
            &fixture.reference,
            "models/a/source.glb"
        ));
        preparation.finish();
    }
}

#[test]
fn actual_original_mime_and_declared_tuple_cannot_be_supplied_by_receipt_or_caller() {
    for mutation in [0, 1] {
        let fixture = installed("model-source-canonical-tuple");
        let probe = probe();
        let preparation = probe.prepare_for_job("tuple".into(), 1).unwrap();
        let bytes = package_bytes(|manifest| {
            if mutation == 0 {
                manifest["files"][0]["mime"] = "application/octet-stream".into();
            } else {
                manifest["files"][0]["sha256"] = "0".repeat(64).into();
            }
        });
        let mut reference = fixture.reference.clone();
        reference.package_hash = format!("{:x}", Sha256::digest(&bytes));
        let directory = fixture.store.package_dir(&reference.package_hash);
        std::fs::create_dir_all(directory.join("files")).unwrap();
        std::fs::write(directory.join("original.hwpkg"), bytes).unwrap();
        let error = fixture
            .store
            .pin_canonical_model_source(&reference, &probe, &preparation, &AtomicBool::new(false))
            .err()
            .unwrap();
        assert_eq!(error.code, "package_invalid");
        preparation.finish();
    }
}

#[test]
fn reparse_parent_directory_and_selected_file_are_rejected_when_symlink_privilege_exists() {
    for directory in [true, false] {
        let fixture = installed("model-source-reparse");
        let probe = probe();
        let preparation = probe.prepare_for_job("reparse".into(), 1).unwrap();
        let root = fixture
            .store
            .package_dir(&fixture.reference.package_hash)
            .join("files/models/a");
        let source = if directory {
            root
        } else {
            root.join("source.glb")
        };
        let target = source.with_extension("real");
        std::fs::rename(&source, &target).unwrap();
        let link = if directory {
            std::os::windows::fs::symlink_dir(&target, &source)
        } else {
            std::os::windows::fs::symlink_file(&target, &source)
        };
        if let Err(error) = link {
            if error.raw_os_error() == Some(1314) {
                eprintln!("conditional skip: Windows symlink privilege unavailable");
                std::fs::rename(target, source).unwrap();
                preparation.finish();
                continue;
            }
            panic!("symlink fixture: {error}");
        }
        let baseline = probe.budget_for_test().usage();
        assert_eq!(
            fixture
                .store
                .pin_canonical_model_source(
                    &fixture.reference,
                    &probe,
                    &preparation,
                    &AtomicBool::new(false)
                )
                .err()
                .unwrap()
                .code,
            "package_invalid"
        );
        assert_eq!(probe.budget_for_test().usage(), baseline);
        if directory {
            std::fs::remove_dir(source).unwrap();
        } else {
            std::fs::remove_file(source).unwrap();
        }
        preparation.finish();
    }
}

#[test]
fn checked_factory_query_has_zero_heap_activity_and_uses_actual_live_capacities() {
    let fixture = installed("model-source-query");
    let probe = probe();
    let preparation = probe.prepare_for_job("query".into(), 1).unwrap();
    let (bounds, sample) = budget::measure_requested_heap(|| {
        fixture
            .store
            .model_source_factory_bounds(&fixture.reference, &preparation)
            .unwrap()
    });
    assert_eq!(sample.peak, 0);
    assert_eq!(sample.retained, 0);
    assert!(!sample.overflow);
    assert_eq!(DIRECTORY_PINS, 92);
    println!(
        "source layout inner={} arc={} outer={} option_arc={} release_guard={} reservation={}",
        std::mem::size_of::<Inner>(),
        arc_allocation_bytes::<Inner>().unwrap(),
        std::mem::size_of::<CanonicalModelSource>(),
        std::mem::size_of::<Option<Arc<Inner>>>(),
        std::mem::size_of::<SourceReleaseGuard>(),
        std::mem::size_of::<Reservation>()
    );
    assert_eq!(
        bounds.path_capacity,
        fixture
            .store
            ._root_owner
            .root()
            .as_os_str()
            .as_encoded_bytes()
            .len()
            + 261
    );
    let full = CanonicalIdentityHeapBounds::for_package_bytes::<&mut File>(
        hertz_wallpaper::MAX_PACKAGE_BYTES,
        None,
    )
    .unwrap();
    let actual = CanonicalIdentityHeapBounds::for_package_bytes::<&mut File>(
        fixture.original.len() as u64,
        None,
    )
    .unwrap();
    assert!(full.workspace_requested_bytes() > budget::MAX_PREPARE_CPU_BYTES);
    assert!(actual.workspace_requested_bytes() + bounds.workspace < budget::MAX_PREPARE_CPU_BYTES);
    eprintln!("factory Wc={} controls={} L={} pins={} full512MiB phases={:?} W={} actual physical={} phases={:?} Wi={} limits={:?}",bounds.workspace,bounds.controls,bounds.path_capacity,DIRECTORY_PINS,full.phase_requested_bytes(),full.workspace_requested_bytes(),fixture.original.len(),actual.phase_requested_bytes(),actual.workspace_requested_bytes(),actual.effective_metadata_limits());
    assert!(bounds.controls >= fixture.store._root_owner.retained_heap_bytes().unwrap());
    preparation.finish();
}

#[test]
fn identity_workspace_rejection_after_same_original_open_drops_all_partial_owners() {
    let fixture = installed("model-source-Wi-reject");
    let probe = probe();
    let preparation = probe.prepare_for_job("reject-wi".into(), 1).unwrap();
    let bounds = fixture
        .store
        .model_source_factory_bounds(&fixture.reference, &preparation)
        .unwrap();
    let held = probe
        .image_workspace(budget::MAX_PREPARE_CPU_BYTES - bounds.workspace)
        .unwrap();
    let budget = probe.budget_for_test();
    let (revision, usage) = budget.planning_snapshot();
    let records = budget.record_count_for_test();
    let error = fixture
        .store
        .pin_canonical_model_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .err()
        .unwrap();
    assert_eq!(error.code, "budget_busy");
    assert!(error.message.contains("prepare_cpu_bytes"));
    assert_eq!(budget.usage(), usage);
    assert_eq!(budget.planning_snapshot().0, revision + 4);
    assert_eq!(budget.record_count_for_test(), records);
    assert!(writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    assert!(budget.stuck().is_empty());
    held.finish();
    preparation.finish();
}

pub(crate) fn rich_document(generator: &str) -> (Value, Vec<u8>) {
    let mut doc = json!({"asset":{"version":"2.0","generator":generator},"buffers":[{"byteLength":1}],"bufferViews":[],"accessors":[],
        "meshes":[],"nodes":[{"children":[1,2,3]},{},{"mesh":0,"skin":0,"weights":[-0.25],"translation":[-0.0,2.25,3.0],"extras":{"pivot":null}},
            {"mesh":1,"matrix":[1,0,0,0,0,1,0,0,0,0,1,0,4.25,0,0,1]}],
        "skins":[{"joints":[1],"skeleton":0}],"scenes":[{"nodes":[0]},{"nodes":[]}],"scene":0,
        "materials":[{}],"samplers":[{}],"textures":[{"source":0,"sampler":0}],
        "images":[{"uri":"tex.png"},{"uri":"tex.png"},{"uri":"other.png"}],
        "cameras":[{"type":"perspective","perspective":{"yfov":1.0,"znear":0.1}}]});
    // A separate authored root with facts outside the selected scene.
    doc["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"mesh":1,"camera":0,"weights":[0.75,-0.0],"translation":[-0.0,9.25,0.0]}));
    let mut bin = Vec::new();
    fn accessor(
        doc: &mut Value,
        bin: &mut Vec<u8>,
        component: u32,
        shape: &str,
        count: usize,
        bytes: &[u8],
        bounds: Option<(&[f64], &[f64])>,
    ) -> usize {
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        let view = doc["bufferViews"].as_array().unwrap().len();
        doc["bufferViews"]
            .as_array_mut()
            .unwrap()
            .push(json!({"buffer":0,"byteOffset":bin.len(),"byteLength":bytes.len()}));
        bin.extend(bytes);
        let index = doc["accessors"].as_array().unwrap().len();
        let mut a = json!({"bufferView":view,"componentType":component,"type":shape,"count":count});
        if let Some((min, max)) = bounds {
            a["min"] = json!(min);
            a["max"] = json!(max);
        }
        doc["accessors"].as_array_mut().unwrap().push(a);
        index
    }
    fn floats(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|n| n.to_le_bytes()).collect()
    }
    let position = accessor(
        &mut doc,
        &mut bin,
        5126,
        "VEC3",
        3,
        &floats(&[0., 0., 0., 1., 0., 0., 0., 1., 0.]),
        Some((&[0., 0., 0.], &[1., 1., 0.])),
    );
    let target = accessor(
        &mut doc,
        &mut bin,
        5126,
        "VEC3",
        3,
        &[0; 36],
        Some((&[0., 0., 0.], &[0., 0., 0.])),
    );
    let joints = accessor(&mut doc, &mut bin, 5121, "VEC4", 3, &[0; 12], None);
    let weights = accessor(
        &mut doc,
        &mut bin,
        5121,
        "VEC4",
        3,
        &[255, 0, 0, 0].repeat(3),
        None,
    );
    doc["accessors"][weights]["normalized"] = json!(true);
    for a in [joints, weights] {
        let v = doc["accessors"][a]["bufferView"].as_u64().unwrap() as usize;
        doc["bufferViews"][v]["byteStride"] = json!(4);
    }
    let indices = accessor(
        &mut doc,
        &mut bin,
        5123,
        "SCALAR",
        3,
        &[0, 0, 1, 0, 2, 0],
        None,
    );
    let inverse = accessor(
        &mut doc,
        &mut bin,
        5126,
        "MAT4",
        1,
        &floats(&[
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
        ]),
        None,
    );
    doc["skins"][0]["inverseBindMatrices"] = json!(inverse);
    let times = accessor(
        &mut doc,
        &mut bin,
        5126,
        "SCALAR",
        2,
        &floats(&[0., 1.]),
        Some((&[0.], &[1.])),
    );
    let translation = accessor(&mut doc, &mut bin, 5126, "VEC3", 2, &[0; 24], None);
    let scale = accessor(&mut doc, &mut bin, 5126, "VEC3", 2, &floats(&[1.; 6]), None);
    let mut rotation = vec![0.; 24];
    rotation[7] = 1.;
    rotation[19] = 1.;
    let rotation = accessor(
        &mut doc,
        &mut bin,
        5126,
        "VEC4",
        6,
        &floats(&rotation),
        None,
    );
    let morph = accessor(
        &mut doc,
        &mut bin,
        5126,
        "SCALAR",
        2,
        &floats(&[-0.5, 0.25]),
        None,
    );
    doc["meshes"] = json!([
        {"weights":[-0.5],"extras":{"pivot":false},"primitives":[{"attributes":{"POSITION":position,"JOINTS_0":joints,"WEIGHTS_0":weights},"indices":indices,"material":0,"mode":4,"targets":[{"POSITION":target}]}]},
        {"weights":[0.0,-0.5],"primitives":[{"attributes":{"POSITION":position,"_":position},"targets":[{},{"_":target}]}]}]);
    doc["animations"] = json!([{"name":"Full author animation","samplers":[
        {"input":times,"output":translation,"interpolation":"LINEAR"},{"input":times,"output":scale,"interpolation":"STEP"},
        {"input":times,"output":rotation,"interpolation":"CUBICSPLINE"},{"input":times,"output":morph}],
        "channels":[{"sampler":0,"target":{"node":2,"path":"translation"}},{"sampler":1,"target":{"node":2,"path":"scale"}},
            {"sampler":2,"target":{"node":2,"path":"rotation"}},{"sampler":3,"target":{"node":2,"path":"weights"}},{"sampler":0,"target":{"path":"translation"}}]}]);
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let view = doc["bufferViews"].as_array().unwrap().len();
    doc["bufferViews"]
        .as_array_mut()
        .unwrap()
        .push(json!({"buffer":0,"byteOffset":bin.len(),"byteLength":4}));
    bin.extend([1, 2, 3, 4]);
    doc["images"]
        .as_array_mut()
        .unwrap()
        .push(json!({"bufferView":view,"mimeType":"image/png"}));
    bin.extend([9, 8, 7, 6]); // deliberately unused bytes remain in the certificate
    doc["buffers"][0]["byteLength"] = json!(bin.len());
    (doc, bin)
}
pub(crate) fn rich_glb(doc: &Value, bin: &[u8]) -> Vec<u8> {
    let mut text = serde_json::to_vec(doc).unwrap();
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let mut bytes = b"glTF".to_vec();
    bytes.extend(2u32.to_le_bytes());
    bytes.extend((28 + text.len() as u32 + bin.len() as u32).to_le_bytes());
    bytes.extend((text.len() as u32).to_le_bytes());
    bytes.extend(b"JSON");
    bytes.extend(text);
    bytes.extend((bin.len() as u32).to_le_bytes());
    bytes.extend([b'B', b'I', b'N', 0]);
    bytes.extend(bin);
    bytes
}

/// Full rich model fixture, separately from the historical empty-source test.
/// invalid_resource installs identity-valid bytes intentionally without full
/// package/resource validation, to reach the original model diagnostic owner.
pub(crate) fn installed_full(tag: &str, invalid_resource: bool) -> Fixture {
    let (mut doc, bin) = rich_document("installed-rich");
    if invalid_resource {
        doc["accessors"][0]["type"] = json!("\0".repeat(20000));
    }
    let model = rich_glb(&doc, &bin);
    let image = [1, 2, 3, 4];
    let files = [
        ("models/a/source.glb", model.as_slice(), "model/gltf-binary"),
        ("models/a/low.glb", model.as_slice(), "model/gltf-binary"),
        ("models/a/tex.png", image.as_slice(), "image/png"),
        ("models/a/other.png", image.as_slice(), "image/png"),
    ];
    let manifest = json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Rich canonical model","description":"Whole original metadata survives",
        "content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[{"id":"first","kind":"model","source":"models/a/source.glb","variants":[{"id":"low","file":"models/a/low.glb","purpose":"low"}]},
            {"id":"texture","kind":"texture","source":"models/a/tex.png","variants":[{"id":"same","file":"models/a/tex.png","purpose":"low"},{"id":"other","file":"models/a/other.png","purpose":"high"}]}],
        "files":files.iter().map(|(path,bytes,mime)|json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":mime})).collect::<Vec<_>>(),
        "properties":[],"permissions":{"audioSpectrum":true,"pointer":true},"license":{"code":"MIT","assets":"CC0-1.0","attribution":"Full model fixture"}});
    let manifest_json = serde_json::to_string(&manifest).unwrap();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, bytes) in std::iter::once(("manifest.json", manifest_json.as_bytes()))
        .chain(files.iter().map(|(path, bytes, _)| (*path, *bytes)))
    {
        zip.start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    let original = zip.finish().unwrap().into_inner();
    let root = tempfileish::temp_dir(tag);
    let store = AssetStore::new(root.path()).unwrap();
    let input = root.path().join("user-source.hwpkg");
    std::fs::write(&input, &original).unwrap();
    let snapshot = store.snapshot_input("install-rich", &input, None).unwrap();
    let package = if invalid_resource {
        // This proves canonical identity only. It is deliberately NOT a
        // claim that validate_staged accepted the invalid model resource.
        let identity =
            hertz_wallpaper::archive::inspect_package_identity(Cursor::new(&original)).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(&original)).unwrap();
        let mut stored_manifest = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut stored_manifest)
            .unwrap();
        StagedPackage {
            package_hash: snapshot.sha256.clone(),
            manifest: identity.manifest().clone(),
            manifest_json: stored_manifest,
            entries: identity.entries().to_vec(),
        }
    } else {
        store.validate_staged("install-rich").unwrap()
    };
    store.unpack_projection("install-rich", &package).unwrap();
    store
        .content_writer()
        .unwrap()
        .publish_staging("install-rich", &package.package_hash)
        .unwrap();
    std::fs::remove_file(input).unwrap();
    drop(store);
    let store = AssetStore::new(root.path()).unwrap();
    let reference = AssetRef {
        package_hash: package.package_hash.clone(),
        asset_id: "first".into(),
        variant_id: None,
    };
    Fixture {
        store,
        root,
        reference,
        package,
        original,
    }
}
