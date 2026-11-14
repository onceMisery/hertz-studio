// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::assets::{
    installed_full_model_fixture, installed_full_model_fixture_with_texture,
    model_source_test_probe, model_source_writable,
};
use crate::wallpaper::session::{RecoveryLedger, SessionState, WallpaperSession};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
    time::Duration,
};

#[path = "native_release_tests.rs"]
mod native_release;

fn entry_writable(path: &Path) -> bool {
    File::options().write(true).open(path).is_ok()
}

fn assert_complete_facts(
    input: &ModelInput,
    original: &hertz_wallpaper::model_binary::CheckedGlbResource,
) {
    use super::native_facts::NativeModelImage;
    use hertz_wallpaper::model_structure::{ModelImage, ModelStructure};
    let ((), sample) = budget::measure_requested_heap(|| {
        let f = input.facts();
        let s = f.structure();
        // Destructure every original field without `..`: a new original fact
        // forces this compatibility proof to be updated at compile time.
        let ModelStructure {
            buffer_views,
            accessors,
            meshes,
            images,
            animations,
            skins,
            skin_bindings,
            skin_binding_pair_refs,
            nodes,
            scenes,
            default_scene,
            buffer_byte_length,
            material_count,
            texture_count,
            sampler_count,
            camera_count,
            static_loader_fields,
            node_morph_weights,
            mesh_triangles_upper_bound,
            instantiated_triangles_upper_bound,
            binary_content_validated,
        } = &original.resource().structure;
        assert_eq!(s.buffer_views, buffer_views);
        assert_eq!(s.accessors, accessors);
        assert_eq!(s.meshes, meshes);
        assert_eq!(s.animations, animations);
        assert_eq!(s.skins, skins);
        assert_eq!(s.skin_bindings, skin_bindings);
        assert_eq!(s.skin_binding_pair_refs, *skin_binding_pair_refs);
        assert_eq!(s.nodes, nodes);
        assert_eq!(s.scenes, scenes);
        assert_eq!(s.default_scene, *default_scene);
        assert_eq!(s.buffer_byte_length, *buffer_byte_length);
        assert_eq!(s.material_count, *material_count);
        assert_eq!(s.texture_count, *texture_count);
        assert_eq!(s.sampler_count, *sampler_count);
        assert_eq!(s.camera_count, *camera_count);
        assert_eq!(s.static_loader_fields, *static_loader_fields);
        assert_eq!(s.node_morph_weights, node_morph_weights);
        assert_eq!(s.mesh_triangles_upper_bound, *mesh_triangles_upper_bound);
        assert_eq!(
            s.instantiated_triangles_upper_bound,
            *instantiated_triangles_upper_bound
        );
        assert_eq!(s.binary_content_validated, *binary_content_validated);
        assert_eq!(s.images.len(), images.len());
        for (native, pure) in s.images.clone().zip(images) {
            match (native, pure) {
                (
                    NativeModelImage::Package {
                        path,
                        mime,
                        bytes,
                        sha256,
                        references,
                    },
                    ModelImage::Package {
                        path: p,
                        mime: m,
                        bytes: b,
                        sha256: h,
                        references: r,
                    },
                ) => {
                    assert_eq!(path, p);
                    assert_eq!(mime, m);
                    assert_eq!(bytes, *b);
                    assert_eq!(sha256, h);
                    assert_eq!(references, r.as_ref());
                }
                (
                    NativeModelImage::Embedded {
                        buffer_view,
                        range,
                        mime,
                    },
                    ModelImage::Embedded {
                        buffer_view: v,
                        range: r,
                        mime: m,
                    },
                ) => {
                    assert_eq!(buffer_view, *v);
                    assert_eq!(range, r);
                    assert_eq!(mime, m);
                }
                _ => panic!("complete image variant changed"),
            }
        }
        assert_eq!(s.images.clone().rev().count(), images.len());
        assert_eq!(f.bytes(), original.bytes());
        assert_eq!(f.sha256(), original.sha256());
        assert_eq!(f.source_path(), original.source_path());
        assert_eq!(f.binary(), original.resource().container.binary.as_ref());
        assert_eq!(
            f.json_bytes(),
            original.resource().container.json.len() as u64
        );
        assert_eq!(f.checked_accessors(), original.checked_accessors());
        assert_eq!(f.unique_layouts(), original.unique_layouts());
        assert_eq!(f.checked_elements(), original.checked_elements());
        assert_eq!(f.checked_components(), original.checked_components());
        // Exhausted iterator failure paths and copied views allocate nothing.
        let mut empty = s.images;
        for _ in empty.by_ref() {}
        assert!(empty.next().is_none());
        assert!(empty.next_back().is_none());
        let copy = f;
        assert_eq!(copy.sha256(), f.sha256());
    });
    assert_eq!(
        (sample.peak, sample.retained, sample.overflow),
        (0, 0, false)
    );
}

#[test]
fn original_installed_rich_triangle_variant_hash_facts_and_last_outer_clone() {
    let fixture = installed_full_model_fixture("model-input-full", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("input-full".into(), 73).unwrap();
    let sibling = probe
        .job_memory(&preparation, "model-source", 0, 17)
        .unwrap();
    let baseline = probe.budget_for_test().usage();
    let records = probe.budget_for_test().record_count_for_test();
    for variant in [None, Some("low")] {
        let mut reference = fixture.reference.clone();
        reference.variant_id = variant.map(str::to_owned);
        let input = fixture
            .store
            .prepare_canonical_model_input(
                &reference,
                &probe,
                &preparation,
                &AtomicBool::new(false),
            )
            .unwrap();
        let path = if variant.is_some() {
            "models/a/low.glb"
        } else {
            "models/a/source.glb"
        };
        let mut bytes = Vec::new();
        File::open(
            fixture
                .store
                .package_dir(&reference.package_hash)
                .join("files")
                .join(path),
        )
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
        let original = hertz_wallpaper::model_binary::inspect_glb_resource_content(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &fixture.package.manifest,
            path,
        )
        .unwrap();
        assert_complete_facts(&input, &original);
        assert_eq!(input.facts().sha256(), original.sha256());
        assert_eq!(
            input.facts().binary(),
            original.resource().container.binary.as_ref()
        );
        assert_eq!(input.facts().bytes(), bytes.len() as u64);
        assert_eq!(
            (
                input.facts().unique_layouts(),
                input.facts().checked_elements(),
                input.facts().checked_components()
            ),
            (
                original.unique_layouts(),
                original.checked_elements(),
                original.checked_components()
            )
        );
        assert_eq!(input.facts().structure().mesh_triangles_upper_bound, 2);
        assert_eq!(input.facts().source_path(), path);
        assert_eq!(
            input.reservation_identity_for_test(),
            ("input-full", 73, "model-input")
        );
        let clone = input.clone();
        let held = probe.budget_for_test().usage();
        drop(input);
        assert_eq!(probe.budget_for_test().usage(), held);
        assert!(!model_source_writable(&fixture.store, &reference, path));
        assert_eq!(held.prepare_cpu_bytes, 0);
        drop(clone);
        assert_eq!(probe.budget_for_test().usage(), baseline);
        assert_eq!(probe.budget_for_test().record_count_for_test(), records);
        assert!(model_source_writable(&fixture.store, &reference, path));
    }
    assert!(!fixture.root.path().join("user-source.hwpkg").exists());
    sibling.finish();
    preparation.finish();
    assert!(probe.budget_for_test().stuck().is_empty());
}

#[test]
fn installed_rich_model_binds_texture_closure_to_archive_entries() {
    let fixture = installed_full_model_fixture("model-input-textures", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("texture-closure".into(), 73).unwrap();
    let baseline = probe.budget_for_test().usage();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    // Three Package records (tex.png twice, other.png once) bind to two unique
    // archive entries; the embedded image stays inside the checked BIN facts.
    assert_eq!(input.texture_closure_for_test(), (3, 2, 8));
    let usage = probe.budget_for_test().usage();
    let path_capacity = fixture.root.path().as_os_str().as_encoded_bytes().len()
        + 10
        + 64
        + 7
        + hertz_wallpaper::MAX_PATH_BYTES;
    assert_eq!(
        usage.model_texture_closure_bytes,
        (3 * 56 + 3 * 8 + path_capacity) as u64
    );
    assert_eq!(usage.model_texture_closure_records, 1);
    // The closure owns only its own bucket; the input's source/facts R stays in
    // the original asset bucket and the prepare workspace has already exited.
    assert_eq!(usage.prepare_cpu_bytes, baseline.prepare_cpu_bytes);
    assert!(usage.asset_cpu_bytes > baseline.asset_cpu_bytes);
    let texture = fixture
        .store
        .package_dir(&fixture.reference.package_hash)
        .join("files/models/a/tex.png");
    assert!(!entry_writable(&texture));
    drop(input);
    assert!(entry_writable(&texture));
    assert_eq!(probe.budget_for_test().usage(), baseline);
    preparation.finish();
}

#[test]
fn texture_closure_record_backing_releases_before_its_last_charge() {
    let fixture = installed_full_model_fixture("model-input-texture-release", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("texture-release".into(), 74).unwrap();
    let budget = probe.budget_for_test();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let charged = budget.usage().model_texture_closure_bytes;
    let path_capacity = fixture.root.path().as_os_str().as_encoded_bytes().len()
        + 10
        + 64
        + 7
        + hertz_wallpaper::MAX_PATH_BYTES;
    assert_eq!(charged, (3 * 56 + 3 * 8 + path_capacity) as u64);
    let allocations = input
        .inner()
        .resources
        .as_ref()
        .unwrap()
        .textures
        .release_allocations_for_test();
    assert_eq!(allocations.len(), 3);
    assert_eq!(
        allocations
            .iter()
            .map(|allocation| allocation.1 as u64)
            .sum::<u64>(),
        charged
    );
    let capture = budget::PhysicalReleaseCapture::new(&allocations);
    let thread = std::thread::spawn(move || {
        let ((), sample) = budget::measure_requested_heap(|| drop(input));
        assert_eq!(
            (sample.peak, sample.retained, sample.overflow),
            (0, 0, false)
        );
    });
    // Every closure backing is inside System.dealloc / its destructor while the
    // charge stays booked; only after the last backing returns does it refund.
    for index in 0..allocations.len() {
        capture.wait_before(index);
        assert_eq!(budget.usage().model_texture_closure_bytes, charged);
        assert_eq!(budget.usage().model_texture_closure_records, 1);
        capture.free(index);
        assert_eq!(budget.usage().model_texture_closure_bytes, charged);
        capture.resume(index);
    }
    thread.join().unwrap();
    assert_eq!(budget.usage().model_texture_closure_bytes, 0);
    assert_eq!(budget.usage().model_texture_closure_records, 0);
    preparation.finish();
}

#[test]
fn same_length_installed_texture_tamper_fails_full_sha() {
    let fixture = installed_full_model_fixture("model-input-texture-sha", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("texture-sha".into(), 75).unwrap();
    let texture = fixture
        .store
        .package_dir(&fixture.reference.package_hash)
        .join("files/models/a/tex.png");
    std::fs::write(&texture, [9u8, 9, 9, 9]).unwrap();
    let error = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, "model_texture_mismatch");
    assert_eq!(
        error.job_error().message,
        "canonical model texture closure failed"
    );
    drop(error);
    assert!(model_source_writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    assert_eq!(
        probe.budget_for_test().usage().model_texture_closure_bytes,
        0
    );
    preparation.finish();
}

#[test]
fn texture_length_tamper_fails_before_hashing() {
    let fixture = installed_full_model_fixture("model-input-texture-length", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("texture-length".into(), 76).unwrap();
    let texture = fixture
        .store
        .package_dir(&fixture.reference.package_hash)
        .join("files/models/a/other.png");
    std::fs::write(&texture, [9u8; 5]).unwrap();
    let error = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, "model_texture_mismatch");
    drop(error);
    assert_eq!(
        probe.budget_for_test().usage().model_texture_closure_bytes,
        0
    );
    preparation.finish();
}

#[test]
fn missing_installed_texture_fails_closed() {
    let fixture = installed_full_model_fixture("model-input-texture-missing", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("texture-missing".into(), 77).unwrap();
    std::fs::remove_file(
        fixture
            .store
            .package_dir(&fixture.reference.package_hash)
            .join("files/models/a/other.png"),
    )
    .unwrap();
    let error = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, "model_texture_missing");
    drop(error);
    assert_eq!(
        probe.budget_for_test().usage().model_texture_closure_bytes,
        0
    );
    preparation.finish();
}

#[test]
fn texture_read_permit_reads_pinned_bytes_without_allocation() {
    let fixture = installed_full_model_fixture("model-input-texture-read", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("texture-read".into(), 78).unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let permit = input.texture_read_permit();
    assert_eq!(permit.texture_bytes(0), Some(4));
    assert_eq!(permit.texture_bytes(1), Some(4));
    assert_eq!(permit.texture_bytes(2), Some(4));
    assert_eq!(permit.texture_bytes(3), None); // embedded image
    assert_eq!(permit.texture_bytes(usize::MAX), None);
    let cancel = AtomicBool::new(false);
    let mut bytes = [0u8; 4];
    let ((), sample) =
        budget::measure_requested_heap(|| permit.read_into(0, 0, &mut bytes, &cancel).unwrap());
    assert_eq!(
        (sample.peak, sample.retained, sample.overflow),
        (0, 0, false)
    );
    assert_eq!(bytes, [1, 2, 3, 4]);
    let mut tail = [0u8; 2];
    permit.read_into(0, 2, &mut tail, &cancel).unwrap();
    assert_eq!(tail, [3, 4]);
    let mut empty = [0u8; 0];
    permit.read_into(0, 4, &mut empty, &cancel).unwrap();
    // Two permits share the same Arc input; positional reads never move a
    // shared file cursor.
    let clone = input.clone();
    let other = clone.texture_read_permit();
    let mut first = [0u8; 1];
    let mut second = [0u8; 1];
    permit.read_into(0, 0, &mut first, &cancel).unwrap();
    other.read_into(0, 3, &mut second, &cancel).unwrap();
    assert_eq!((first[0], second[0]), (1, 4));
    let mut again = [0u8; 4];
    permit.read_into(0, 0, &mut again, &cancel).unwrap();
    assert_eq!(again, [1, 2, 3, 4]);
    drop(clone);
    drop(input);
    preparation.finish();
}

#[test]
fn texture_read_permit_rejects_bounds_embedded_and_cancelled() {
    let fixture = installed_full_model_fixture("model-input-texture-read-bounds", false);
    let probe = model_source_test_probe();
    let preparation = probe
        .prepare_for_job("texture-read-bounds".into(), 79)
        .unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let permit = input.texture_read_permit();
    let cancel = AtomicBool::new(false);
    for (offset, length) in [(5u64, 1usize), (4, 1), (u64::MAX, 1), (5, 0)] {
        let mut output = vec![0u8; length];
        let error = permit
            .read_into(0, offset, &mut output, &cancel)
            .err()
            .unwrap();
        assert_eq!(error.code, "model_texture_bounds");
        assert_eq!(error.message, "canonical model texture closure failed");
    }
    let mut output = [0u8; 1];
    assert_eq!(
        permit
            .read_into(3, 0, &mut output, &cancel)
            .err()
            .unwrap()
            .code,
        "model_texture_missing"
    );
    assert_eq!(
        permit
            .read_into(99, 0, &mut output, &cancel)
            .err()
            .unwrap()
            .code,
        "model_texture_missing"
    );
    let cancelled = AtomicBool::new(true);
    assert_eq!(
        permit
            .read_into(0, 0, &mut output, &cancelled)
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
    drop(input);
    preparation.finish();
}

#[test]
fn texture_read_permit_enforces_one_mib_boundary_on_real_pinned_bytes() {
    // Incompressible bytes keep the package ZIP below the 100:1 ratio gate.
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let image: Vec<u8> = (0..1024 * 1024 + 1)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 56) as u8
        })
        .collect();
    let fixture =
        installed_full_model_fixture_with_texture("model-input-texture-read-large", false, &image);
    let probe = model_source_test_probe();
    let preparation = probe
        .prepare_for_job("texture-read-large".into(), 80)
        .unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let permit = input.texture_read_permit();
    assert_eq!(permit.texture_bytes(0), Some(1024 * 1024 + 1));
    let cancel = AtomicBool::new(false);
    let mut one_mib = vec![0u8; 1024 * 1024];
    permit.read_into(0, 1, &mut one_mib, &cancel).unwrap();
    assert_eq!(one_mib.as_slice(), &image[1..]);
    let mut over = vec![0u8; 1024 * 1024 + 1];
    assert_eq!(
        permit
            .read_into(0, 0, &mut over, &cancel)
            .err()
            .unwrap()
            .code,
        "model_texture_bounds"
    );
    drop(input);
    preparation.finish();
}

#[test]
fn texture_resource_index_lists_unique_package_entries_exactly() {
    let fixture = installed_full_model_fixture("model-input-texture-index", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("texture-index".into(), 81).unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let resources = input.texture_resources();
    assert_eq!(resources.len(), 2);
    let expected_sha: [u8; 32] = Sha256::digest([1u8, 2, 3, 4]).into();
    let mut seen = Vec::new();
    for descriptor in resources.iter() {
        seen.push((
            descriptor.path.to_owned(),
            descriptor.mime.to_owned(),
            descriptor.bytes,
            descriptor.sha256,
            descriptor.references,
            descriptor.image_index,
        ));
    }
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].0, "models/a/tex.png");
    assert_eq!(seen[0].1, "image/png");
    assert_eq!(seen[0].2, 4);
    assert_eq!(seen[0].3, expected_sha);
    assert_eq!(seen[0].4, 2);
    assert_eq!(seen[0].5, 0);
    assert_eq!(seen[1].0, "models/a/other.png");
    assert_eq!(seen[1].2, 4);
    assert_eq!(seen[1].3, expected_sha);
    assert_eq!(seen[1].4, 1);
    assert_eq!(seen[1].5, 2);
    // The model entry and the embedded image are not Package texture resources.
    assert!(resources.authorize("models/a/source.glb").is_none());
    assert!(resources.authorize("models/a/low.glb").is_none());
    drop(input);
    preparation.finish();
}

#[test]
fn texture_resource_authorize_requires_exact_indexed_path() {
    let fixture = installed_full_model_fixture("model-input-texture-authorize", false);
    let probe = model_source_test_probe();
    let preparation = probe
        .prepare_for_job("texture-authorize".into(), 82)
        .unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let resources = input.texture_resources();
    let cancel = AtomicBool::new(false);
    let tex = resources.authorize("models/a/tex.png").unwrap();
    assert_eq!(tex.bytes(), 4);
    assert_eq!(tex.image_index(), 0);
    let mut bytes = [0u8; 4];
    tex.read_into(0, &mut bytes, &cancel).unwrap();
    assert_eq!(bytes, [1, 2, 3, 4]);
    assert_eq!(
        resources
            .authorize("models/a/tex.png")
            .unwrap()
            .read_into(4, &mut [0u8; 1], &cancel)
            .err()
            .unwrap()
            .code,
        "model_texture_bounds"
    );
    assert_eq!(
        resources
            .authorize("models/a/other.png")
            .unwrap()
            .image_index(),
        2
    );
    for rejected in [
        "models/a/tex.png/",
        "models/a/tex.png/..",
        "models/a/../models/a/tex.png",
        "models/a/TEX.PNG",
        "models/a//tex.png",
        "models/a/tex.png?x=1",
        "tex.png",
        "",
        "models/a/tex.pn",
        "models/a/source.glb",
    ] {
        assert!(
            resources.authorize(rejected).is_none(),
            "unexpected authorization for {rejected:?}"
        );
    }
    drop(input);
    preparation.finish();
}

#[test]
fn texture_resource_index_and_authorize_allocate_nothing() {
    let fixture = installed_full_model_fixture("model-input-texture-index-alloc", false);
    let probe = model_source_test_probe();
    let preparation = probe
        .prepare_for_job("texture-index-alloc".into(), 83)
        .unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let ((count, totals, authorized), sample) = budget::measure_requested_heap(|| {
        let resources = input.texture_resources();
        let count = resources.len();
        let totals = resources.iter().fold((0usize, 0u64, 0u64), |totals, item| {
            (
                totals.0 + 1,
                totals.1 + item.bytes,
                totals.2 + u64::from(item.references),
            )
        });
        let authorized = resources
            .authorize("models/a/other.png")
            .map_or(0, |resource| resource.bytes());
        (count, totals, authorized)
    });
    assert_eq!(count, 2);
    assert_eq!(totals, (2, 8, 3));
    assert_eq!(authorized, 4);
    assert_eq!(
        (sample.peak, sample.retained, sample.overflow),
        (0, 0, false)
    );
    drop(input);
    preparation.finish();
}

#[test]
fn texture_plan_keeps_pins_and_charge_until_its_last_owner_drops() {
    let fixture = installed_full_model_fixture("model-input-texture-plan", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("texture-plan".into(), 84).unwrap();
    let baseline = probe.budget_for_test().usage();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let held = probe.budget_for_test().usage();
    let plan = input.grant_texture_plan("model-session", 7).unwrap();
    assert!(plan.is_active());
    assert_eq!(plan.generation(), 7);
    assert!(plan.matches("model-session", 7));
    assert!(!plan.matches("model-session", 8));
    assert!(!plan.matches("other-session", 7));
    drop(input);
    // The plan's input clone keeps the canonical source, facts, File pins and
    // closure charge alive.
    assert_eq!(probe.budget_for_test().usage(), held);
    let cancel = AtomicBool::new(false);
    let lease = plan.permit("models/a/tex.png").unwrap();
    assert_eq!(lease.image_index(), 0);
    assert_eq!(lease.bytes(), 4);
    let mut bytes = [0u8; 4];
    lease.read_into(0, &mut bytes, &cancel).unwrap();
    assert_eq!(bytes, [1, 2, 3, 4]);
    plan.revoke();
    assert!(!plan.is_active());
    assert!(plan.permit("models/a/tex.png").is_none());
    let error = lease.read_into(0, &mut bytes, &cancel).err().unwrap();
    assert_eq!(error.code, "model_texture_revoked");
    assert_eq!(error.message, "canonical model texture plan was revoked");
    drop(plan);
    assert_eq!(probe.budget_for_test().usage(), baseline);
    preparation.finish();
}

#[test]
fn texture_plan_rejects_invalid_session_and_generation() {
    let fixture = installed_full_model_fixture("model-input-texture-plan-identity", false);
    let probe = model_source_test_probe();
    let preparation = probe
        .prepare_for_job("texture-plan-identity".into(), 85)
        .unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(input.grant_texture_plan("", 1).is_none());
    assert!(input.grant_texture_plan(&"s".repeat(129), 1).is_none());
    assert!(input.grant_texture_plan("session", 0).is_none());
    let longest = "s".repeat(128);
    let plan = input.grant_texture_plan(&longest, u64::MAX).unwrap();
    assert!(plan.matches(&longest, u64::MAX));
    assert!(!plan.matches(&longest, u64::MAX - 1));
    drop(plan);
    drop(input);
    preparation.finish();
}

#[test]
fn texture_plan_grant_permit_and_read_allocate_nothing() {
    let fixture = installed_full_model_fixture("model-input-texture-plan-alloc", false);
    let probe = model_source_test_probe();
    let preparation = probe
        .prepare_for_job("texture-plan-alloc".into(), 86)
        .unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let ((bound, bytes, rejected), sample) = budget::measure_requested_heap(|| {
        let plan = input.grant_texture_plan("plan-session", 1).unwrap();
        let lease = plan.permit("models/a/other.png").unwrap();
        let mut output = [0u8; 4];
        lease
            .read_into(0, &mut output, &AtomicBool::new(false))
            .unwrap();
        let rejected = plan.permit("models/a/other.png/").is_none();
        (plan.matches("plan-session", 1), output, rejected)
    });
    assert!(bound);
    assert_eq!(bytes, [1, 2, 3, 4]);
    assert!(rejected);
    assert_eq!(
        (sample.peak, sample.retained, sample.overflow),
        (0, 0, false)
    );
    drop(input);
    preparation.finish();
}

#[test]
fn controller_replaces_only_forward_generations_and_revokes() {
    let fixture = installed_full_model_fixture("model-input-texture-controller", false);
    let probe = model_source_test_probe();
    let preparation = probe
        .prepare_for_job("texture-controller".into(), 87)
        .unwrap();
    let baseline = probe.budget_for_test().usage();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let held = probe.budget_for_test().usage();
    let input2 = input.clone();
    let controller = ModelTextureController::new();
    assert!(controller.is_empty());
    assert_eq!(controller.generation(), 0);
    assert!(!controller.matches("model-session", 1));
    assert!(controller.install(&input, "model-session", 1));
    assert_eq!(controller.generation(), 1);
    assert!(controller.matches("model-session", 1));
    assert!(!controller.matches("model-session", 2));
    let cancel = AtomicBool::new(false);
    let mut bytes = [0u8; 4];
    assert!(controller
        .read_into("models/a/tex.png", 0, &mut bytes, &cancel)
        .unwrap()
        .is_some());
    assert_eq!(bytes, [1, 2, 3, 4]);
    // Same or older generation never replaces the current plan.
    assert!(!controller.install(&input, "model-session", 1));
    assert!(!controller.install(&input, "model-session", 0));
    assert!(controller.install(&input, "model-session", 2));
    assert_eq!(controller.generation(), 2);
    drop(input);
    // The controller's plan clone keeps pins, facts and the closure charge.
    assert_eq!(probe.budget_for_test().usage(), held);
    assert!(controller
        .read_into("models/a/tex.png", 0, &mut bytes, &cancel)
        .unwrap()
        .is_some());
    assert!(controller.revoke());
    assert!(!controller.revoke());
    assert!(controller.is_empty());
    assert_eq!(controller.generation(), 0);
    assert!(controller
        .read_into("models/a/tex.png", 0, &mut bytes, &cancel)
        .unwrap()
        .is_none());
    assert!(controller.install(&input2, "model-session", 3));
    drop(input2);
    assert!(controller.revoke());
    assert_eq!(probe.budget_for_test().usage(), baseline);
    preparation.finish();
}

#[test]
fn controller_rejects_invalid_identity_and_unknown_paths() {
    let fixture = installed_full_model_fixture("model-input-texture-controller-paths", false);
    let probe = model_source_test_probe();
    let preparation = probe
        .prepare_for_job("texture-controller-paths".into(), 88)
        .unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let controller = ModelTextureController::new();
    assert!(!controller.install(&input, "", 1));
    assert!(!controller.install(&input, &"s".repeat(129), 1));
    assert!(!controller.install(&input, "session", 0));
    assert!(controller.is_empty());
    assert_eq!(controller.generation(), 0);
    assert!(controller.install(&input, "session", 1));
    let cancel = AtomicBool::new(false);
    let mut output = [0u8; 4];
    for path in [
        "",
        "models/a/tex.png/",
        "models/a/../models/a/tex.png",
        "models/a/TEX.PNG",
        "models/a/tex.png?x=1",
        "models/a/source.glb",
    ] {
        assert!(
            controller
                .read_into(path, 0, &mut output, &cancel)
                .unwrap()
                .is_none(),
            "unexpected read for {path:?}"
        );
    }
    assert!(controller
        .read_into("models/a/other.png", 0, &mut output, &cancel)
        .unwrap()
        .is_some());
    assert_eq!(output, [1, 2, 3, 4]);
    drop(input);
    preparation.finish();
}

#[test]
fn controller_install_and_read_allocate_nothing() {
    let fixture = installed_full_model_fixture("model-input-texture-controller-alloc", false);
    let probe = model_source_test_probe();
    let preparation = probe
        .prepare_for_job("texture-controller-alloc".into(), 89)
        .unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let controller = ModelTextureController::new();
    let ((ok, bytes), sample) = budget::measure_requested_heap(|| {
        let installed = controller.install(&input, "session", 1);
        let mut output = [0u8; 4];
        let read = controller
            .read_into("models/a/tex.png", 0, &mut output, &AtomicBool::new(false))
            .unwrap()
            .is_some();
        (installed && read, output)
    });
    assert!(ok);
    assert_eq!(bytes, [1, 2, 3, 4]);
    assert_eq!(
        (sample.peak, sample.retained, sample.overflow),
        (0, 0, false)
    );
    drop(input);
    preparation.finish();
}

#[test]
fn session_generation_change_revokes_texture_plan_and_releases_charge() {
    let fixture = installed_full_model_fixture("model-input-texture-session", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("texture-session".into(), 90).unwrap();
    let baseline = probe.budget_for_test().usage();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let held = probe.budget_for_test().usage();
    let recovery = RecoveryLedger::new();
    let mut session = WallpaperSession::new();
    let generation = session.apply(1, &recovery).unwrap();
    // Only an attaching current generation may install texture resources.
    assert!(!session.admit_textures(generation, &input, "model-session"));
    assert!(session.resolved(generation));
    assert!(session.prepared(generation));
    assert_eq!(session.state(), SessionState::Attaching);
    assert!(!session.admit_textures(generation + 1, &input, "model-session"));
    assert!(!session.admit_textures(generation, &input, ""));
    assert!(session.admit_textures(generation, &input, "model-session"));
    let cancel = AtomicBool::new(false);
    let mut bytes = [0u8; 4];
    assert!(session
        .read_texture("models/a/tex.png", 0, &mut bytes, &cancel)
        .unwrap()
        .is_some());
    assert_eq!(bytes, [1, 2, 3, 4]);
    // A new intent retires the previous plan before the new generation is used.
    let next = session.apply(2, &recovery).unwrap();
    assert_eq!(next, generation + 1);
    assert!(session
        .read_texture("models/a/tex.png", 0, &mut bytes, &cancel)
        .unwrap()
        .is_none());
    assert_eq!(probe.budget_for_test().usage(), held);
    // The new generation can install its own plan; disable revokes it.
    assert!(session.resolved(next));
    assert!(session.prepared(next));
    assert!(session.admit_textures(next, &input, "model-session"));
    assert!(session
        .read_texture("models/a/tex.png", 0, &mut bytes, &cancel)
        .unwrap()
        .is_some());
    session.disable();
    assert_eq!(session.state(), SessionState::Disabled);
    assert!(session
        .read_texture("models/a/tex.png", 0, &mut bytes, &cancel)
        .unwrap()
        .is_none());
    drop(input);
    assert_eq!(probe.budget_for_test().usage(), baseline);
    preparation.finish();
}

#[test]
fn source_success_then_actual_model_w_rejection_keeps_source_fee_and_pins_until_error_drop() {
    let fixture = installed_full_model_fixture("model-input-W", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("model-W".into(), 19).unwrap();
    let mut held = None;
    let mut observer = |stage| {
        if stage == ModelStage::SourceReady {
            held = Some(
                probe
                    .image_workspace(budget::MAX_PREPARE_CPU_BYTES)
                    .unwrap(),
            );
        }
    };
    let error = fixture
        .store
        .prepare_model_input_inner(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
            Some(&mut observer),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, "budget_busy");
    assert_eq!(
        error.reservation_identity_for_test(),
        Some(("model-W", 19, "model-source"))
    );
    assert!(probe.budget_for_test().usage().asset_cpu_bytes > 0);
    assert!(!model_source_writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    drop(error);
    assert_eq!(probe.budget_for_test().usage().asset_cpu_bytes, 0);
    assert!(model_source_writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    held.unwrap().finish();
    preparation.finish();
    assert_eq!(probe.budget_for_test().record_count_for_test(), 0);
}

#[test]
fn actual_compact_r_rejection_returns_w_only_guard_after_physical_source_exit() {
    let fixture = installed_full_model_fixture("model-input-R", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("model-R".into(), 29).unwrap();
    let sibling = probe
        .job_memory(&preparation, "model-source", 0, 17)
        .unwrap();
    let mut held = None;
    let mut observer = |stage| {
        if stage == ModelStage::Compacted {
            let available =
                budget::MAX_ASSET_CPU_BYTES - probe.budget_for_test().usage().asset_cpu_bytes;
            held = Some(
                probe
                    .job_memory(&preparation, "model-source", 0, available)
                    .unwrap(),
            );
        }
    };
    let error = fixture
        .store
        .prepare_model_input_inner(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
            Some(&mut observer),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, "budget_busy");
    assert_eq!(
        error.reservation_identity_for_test(),
        Some(("model-R", 29, "model-inspection"))
    );
    assert!(probe.budget_for_test().usage().prepare_cpu_bytes > 296_000_000);
    assert!(model_source_writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    let asset = probe.budget_for_test().usage().asset_cpu_bytes;
    assert!(asset >= 17);
    drop(error);
    assert_eq!(probe.budget_for_test().usage().prepare_cpu_bytes, 0);
    assert_eq!(probe.budget_for_test().usage().asset_cpu_bytes, asset);
    held.unwrap().finish();
    assert_eq!(probe.budget_for_test().usage().asset_cpu_bytes, 17);
    sibling.finish();
    preparation.finish();
    assert_eq!(probe.budget_for_test().record_count_for_test(), 0);
    assert!(probe.budget_for_test().stuck().is_empty());
}

#[test]
fn sixty_four_record_frontier_after_source_retains_source_guard_without_extra_error_grant() {
    let fixture = installed_full_model_fixture("model-input-records", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("model-records".into(), 39).unwrap();
    let mut held = Vec::new();
    let mut observer = |stage| {
        if stage == ModelStage::SourceReady {
            while probe.budget_for_test().record_count_for_test() < 64 {
                held.push(
                    probe
                        .job_memory(&preparation, "model-source", 0, 1)
                        .unwrap(),
                );
            }
        }
    };
    let error = fixture
        .store
        .prepare_model_input_inner(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
            Some(&mut observer),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, "budget_busy");
    assert!(error.job_error().message.contains("reservation_metadata"));
    assert_eq!(probe.budget_for_test().record_count_for_test(), 64);
    drop(error);
    assert_eq!(probe.budget_for_test().record_count_for_test(), 63);
    for token in held {
        token.finish();
    }
    preparation.finish();
    assert_eq!(probe.budget_for_test().record_count_for_test(), 0);
}

#[test]
fn long_invalid_resource_reaches_original_inspector_then_normalizes_under_w() {
    let fixture = installed_full_model_fixture("model-input-invalid-resource-test-install", true);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("invalid-model".into(), 49).unwrap();
    let bytes = std::fs::read(
        fixture
            .store
            .package_dir(&fixture.reference.package_hash)
            .join("files/models/a/source.glb"),
    )
    .unwrap();
    let original = hertz_wallpaper::model_binary::inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &fixture.package.manifest,
        "models/a/source.glb",
    )
    .err()
    .unwrap();
    assert!(original.message.len() > 20_000);
    let code = original.code;
    drop(original);
    let error = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, code);
    assert_eq!(error.job_error().message, MODEL_DIAGNOSTIC);
    assert_eq!(error.job_error().message.capacity(), MODEL_DIAGNOSTIC.len());
    assert_eq!(
        error.reservation_identity_for_test(),
        Some(("invalid-model", 49, "model-inspection"))
    );
    assert!(probe.budget_for_test().usage().prepare_cpu_bytes > 0);
    assert!(model_source_writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    drop(error);
    assert_eq!(probe.budget_for_test().usage().prepare_cpu_bytes, 0);
    preparation.finish();
}

#[test]
fn unique_source_refusal_precedes_read_and_real_read_return_cancel_retains_w_until_error_drop() {
    let fixture = installed_full_model_fixture("model-input-real-read", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("model-read".into(), 59).unwrap();
    let mut source = fixture
        .store
        .pin_canonical_model_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let clone = source.clone();
    let mut reads = 0;
    let error = source
        .inspect_model_content_observed(&AtomicBool::new(false), &mut || reads += 1)
        .err()
        .unwrap();
    assert_eq!(error.code, "model_source_shared");
    assert_eq!(reads, 0);
    drop(clone);
    drop(source);
    let cancel = Arc::new(AtomicBool::new(false));
    let child_cancel = Arc::clone(&cancel);
    let (entered_tx, entered) = std::sync::mpsc::channel();
    let (release_tx, release) = std::sync::mpsc::channel();
    let store = fixture.store;
    let reference = fixture.reference.clone();
    let child_probe = probe.clone();
    let thread = std::thread::spawn(move || {
        let mut reads = 0;
        let mut observer = |stage| {
            if stage == ModelStage::ReadReturned {
                reads += 1;
                if reads == 1 {
                    entered_tx.send(()).unwrap();
                    release.recv_timeout(Duration::from_secs(10)).unwrap();
                }
            }
        };
        let error = store
            .prepare_model_input_inner(
                &reference,
                &child_probe,
                &preparation,
                &child_cancel,
                Some(&mut observer),
            )
            .err()
            .unwrap();
        (error, preparation, store)
    });
    entered.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(probe.budget_for_test().usage().prepare_cpu_bytes > 0);
    assert!(probe.budget_for_test().usage().asset_cpu_bytes > 0);
    cancel.store(true, Ordering::Release);
    assert!(probe.budget_for_test().usage().prepare_cpu_bytes > 0);
    release_tx.send(()).unwrap();
    let (error, preparation, store) = thread.join().unwrap();
    assert_eq!(error.job_error().code, "cancelled");
    assert_eq!(
        error.reservation_identity_for_test(),
        Some(("model-read", 59, "model-inspection"))
    );
    assert_eq!(probe.budget_for_test().usage().asset_cpu_bytes, 0);
    assert!(model_source_writable(
        &store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    drop(error);
    preparation.finish();
    assert_eq!(probe.budget_for_test().record_count_for_test(), 0);
}

#[test]
fn model_controls_actual_native_layout_and_unchanged_original_max_j_equation() {
    let fixture = installed_full_model_fixture("model-input-layout", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("layout".into(), 69).unwrap();
    let old = fixture
        .store
        .pin_canonical_model_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let old_charge = old.retained_source_charge();
    drop(old);
    let new = fixture
        .store
        .pin_model_input_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
            model_controls().unwrap(),
        )
        .unwrap();
    assert_eq!(
        new.retained_source_charge() - old_charge,
        model_controls().unwrap()
    );
    assert_eq!(
        budget::ordinary_memory_grant_diagnostic_heap_bytes(),
        Some(987)
    );
    let model =
        ModelHeapBounds::for_json_bytes(hertz_wallpaper::MAX_TEXT_BYTES, new.manifest()).unwrap();
    let joined = model
        .workspace_with_live_base(new.retained_source_charge())
        .unwrap();
    assert_eq!(
        joined,
        model.workspace_requested_bytes() + new.retained_source_charge()
    );
    println!("native inner={} arc={} Cmodel={} query59 grant987 literal={} modelW={} sourceR={} joinedW={joined}",std::mem::size_of::<Inner>(),arc_allocation_bytes::<Inner>().unwrap(),model_controls().unwrap(),MODEL_DIAGNOSTIC.len(),model.workspace_requested_bytes(),new.retained_source_charge());
    println!("native layouts outer={} option_arc={} reservation={} error={} guard={} facts_view={} structure_view={} image_view={} image_iterator={} borrowed_stack_session=128",
        std::mem::size_of::<ModelInput>(), std::mem::size_of::<Option<Arc<Inner>>>(),
        std::mem::size_of::<Reservation>(), std::mem::size_of::<ModelPreparationError>(),
        std::mem::size_of::<ModelErrorGuard>(), std::mem::size_of::<native_facts::NativeModelFacts<'_>>(),
        std::mem::size_of::<native_facts::NativeModelStructure<'_>>(),
        std::mem::size_of::<native_facts::NativeModelImage<'_>>(),
        std::mem::size_of::<native_facts::NativeModelImages<'_>>());
    drop(new);
    preparation.finish();
}
