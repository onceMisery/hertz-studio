// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::budget::measure_requested_heap;
use hertz_wallpaper::model_container::BinaryChunk;
use hertz_wallpaper::model_structure::PackageImageRef;

// Independent copies of the production literals: changing either side alone
// must make these expectations fail.
const DIAGNOSTIC: &str = "canonical model texture closure failed";
const RECORD_BYTES: u64 = 56;

fn sha(prefix: &str) -> String {
    prefix.repeat(32)
}

fn entry(path: &str, bytes: u64, sha256: &str, mime: Option<&str>) -> VerifiedEntry {
    VerifiedEntry {
        path: path.into(),
        bytes,
        sha256: sha256.into(),
        mime: mime.map(str::to_owned),
    }
}

fn package(path: &str, bytes: u64, sha256: &str, mime: &str, references: usize) -> ModelImage {
    let references: Arc<[PackageImageRef]> = (0..references)
        .map(|index| PackageImageRef {
            asset_id: format!("asset-{index}"),
            variant_id: None,
        })
        .collect::<Vec<_>>()
        .into();
    ModelImage::Package {
        path: path.into(),
        mime: mime.into(),
        bytes,
        sha256: sha256.into(),
        references,
    }
}

fn embedded() -> ModelImage {
    ModelImage::Embedded {
        buffer_view: 0,
        range: BinaryChunk {
            offset: 0,
            bytes: 4,
        },
        mime: "image/png".into(),
    }
}

#[test]
fn binds_every_package_record_and_books_exact_record_backing() {
    assert_eq!(std::mem::size_of::<ClosedTexture>(), RECORD_BYTES as usize);
    let budget = Arc::new(budget::BudgetCoordinator::new());
    let entries = [
        entry("models/a/tex.png", 4, &sha("ab"), Some("image/png")),
        entry("models/a/other.png", 6, &sha("cd"), Some("image/png")),
    ];
    let images = [
        package("models/a/tex.png", 4, &sha("ab"), "image/png", 2),
        package("models/a/tex.png", 4, &sha("ab"), "image/png", 2),
        package("models/a/other.png", 6, &sha("cd"), "image/png", 1),
        embedded(),
    ];
    let (closure, sample) = measure_requested_heap(|| build(&images, &entries, &budget).unwrap());
    assert_eq!(
        (sample.peak as u64, sample.retained as u64, sample.overflow),
        (3 * RECORD_BYTES, 3 * RECORD_BYTES, false)
    );
    assert_eq!(closure.len(), 3);
    assert_eq!(closure.unique_entries(), 2);
    assert_eq!(closure.unique_source_bytes(), 10);
    assert_eq!(budget.usage().model_texture_closure_bytes, 3 * RECORD_BYTES);
    assert_eq!(budget.usage().model_texture_closure_records, 1);
    // The closure never borrows the prepare or asset quotas.
    assert_eq!(budget.usage().prepare_cpu_bytes, 0);
    assert_eq!(budget.usage().asset_cpu_bytes, 0);

    let ((), sample) = measure_requested_heap(|| drop(closure));
    assert_eq!(
        (sample.peak, sample.retained, sample.overflow),
        (0, 0, false)
    );
    assert_eq!(budget.usage(), budget::BudgetUsage::default());
}

#[test]
fn empty_package_set_allocates_and_books_nothing() {
    let budget = Arc::new(budget::BudgetCoordinator::new());
    let images = [embedded()];
    let (closure, sample) = measure_requested_heap(|| build(&images, &[], &budget).unwrap());
    assert_eq!(
        (sample.peak, sample.retained, sample.overflow),
        (0, 0, false)
    );
    assert_eq!(closure.len(), 0);
    assert_eq!(closure.unique_entries(), 0);
    assert_eq!(budget.usage(), budget::BudgetUsage::default());
}

fn assert_rejected(
    result: Result<ModelTextureClosure, JobError>,
    code: &'static str,
    budget: &Arc<budget::BudgetCoordinator>,
) {
    let error = result.err().unwrap();
    assert_eq!(error.code, code);
    assert_eq!(error.message, DIAGNOSTIC);
    assert_eq!(budget.usage(), budget::BudgetUsage::default());
}

#[test]
fn missing_entry_mismatch_and_over_bounds_fail_closed_before_booking() {
    let budget = Arc::new(budget::BudgetCoordinator::new());
    let good = entry("tex.png", 4, &sha("ab"), Some("image/png"));
    let image = package("tex.png", 4, &sha("ab"), "image/png", 1);
    let images = [image];

    assert_rejected(
        build(&images, &[], &budget),
        "model_texture_missing",
        &budget,
    );
    assert_rejected(
        build(
            &images,
            &[entry("other.png", 4, &sha("ab"), Some("image/png"))],
            &budget,
        ),
        "model_texture_missing",
        &budget,
    );
    for mismatch in [
        entry("tex.png", 5, &sha("ab"), Some("image/png")),
        entry("tex.png", 4, &sha("cd"), Some("image/png")),
        entry("tex.png", 4, &sha("ab"), Some("image/jpeg")),
        entry("tex.png", 4, &sha("ab"), None),
    ] {
        assert_rejected(
            build(&images, std::slice::from_ref(&mismatch), &budget),
            "model_texture_mismatch",
            &budget,
        );
    }
    assert_rejected(
        build(
            &[package("tex.png", 4, &sha("ab"), "image/png", 0)],
            &[good],
            &budget,
        ),
        "model_texture_mismatch",
        &budget,
    );
    // Uppercase or truncated author digests are not canonical entry tuples.
    assert_rejected(
        build(
            &[package("tex.png", 4, &"AB".repeat(32), "image/png", 1)],
            &[entry("tex.png", 4, &"AB".repeat(32), Some("image/png"))],
            &budget,
        ),
        "model_texture_mismatch",
        &budget,
    );

    // Independent small limits prove the record and source-byte bounds.
    let two = [
        package("tex.png", 4, &sha("ab"), "image/png", 1),
        package("other.png", 6, &sha("cd"), "image/png", 1),
    ];
    let entries = [
        entry("tex.png", 4, &sha("ab"), Some("image/png")),
        entry("other.png", 6, &sha("cd"), Some("image/png")),
    ];
    assert_rejected(
        build_with_limits(&two, &entries, &budget, 1, 10),
        "model_texture_limit",
        &budget,
    );
    assert_rejected(
        build_with_limits(&two, &entries, &budget, 2, 9),
        "model_texture_limit",
        &budget,
    );
    // A shared alias is still bounded conservatively over its records.
    let aliased = [
        package("tex.png", 4, &sha("ab"), "image/png", 1),
        package("tex.png", 4, &sha("ab"), "image/png", 1),
    ];
    assert_rejected(
        build_with_limits(&aliased, &entries[..1], &budget, 2, 7),
        "model_texture_limit",
        &budget,
    );

    // The exact boundary still succeeds and books one closure record.
    let closure = build_with_limits(&two, &entries, &budget, 2, 10).unwrap();
    assert_eq!(closure.unique_source_bytes(), 10);
    assert_eq!(budget.usage().model_texture_closure_bytes, 2 * RECORD_BYTES);
    drop(closure);
    assert_eq!(budget.usage(), budget::BudgetUsage::default());
}
