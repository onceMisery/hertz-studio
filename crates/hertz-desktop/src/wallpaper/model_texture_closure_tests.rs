// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::budget::measure_requested_heap;
use hertz_wallpaper::model_container::BinaryChunk;
use hertz_wallpaper::model_structure::PackageImageRef;

// Independent copies of the production literals: changing either side alone
// must make these expectations fail.
const DIAGNOSTIC: &str = "canonical model texture closure failed";
const RECORD_BYTES: usize = 56;
const FILE_HANDLE_BYTES: usize = 8;

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
fn fixed_record_and_file_pin_layouts_are_the_admitted_units() {
    assert_eq!(std::mem::size_of::<ClosedTexture>(), RECORD_BYTES);
    assert_eq!(std::mem::size_of::<File>(), FILE_HANDLE_BYTES);
}

fn unreachable_build(
    images: &[ModelImage],
    entries: &[VerifiedEntry],
    budget: &Arc<budget::BudgetCoordinator>,
) -> Result<ModelTextureClosure, JobError> {
    // The validation-only failures below never touch the filesystem.
    build(
        Path::new("C:/r41-unreachable-root"),
        &"0".repeat(64),
        images,
        entries,
        budget,
        &AtomicBool::new(false),
    )
}

fn assert_rejected(images: &[ModelImage], entries: &[VerifiedEntry], code: &'static str) {
    let budget = Arc::new(budget::BudgetCoordinator::new());
    let error = unreachable_build(images, entries, &budget).err().unwrap();
    assert_eq!(error.code, code);
    assert_eq!(error.message, DIAGNOSTIC);
    assert_eq!(budget.usage(), budget::BudgetUsage::default());
}

#[test]
fn missing_entry_mismatch_and_unreachable_root_never_book() {
    let good = entry("tex.png", 4, &sha("ab"), Some("image/png"));
    let images = [package("tex.png", 4, &sha("ab"), "image/png", 1)];
    assert_rejected(&images, &[], "model_texture_missing");
    assert_rejected(
        &images,
        &[entry("other.png", 4, &sha("ab"), Some("image/png"))],
        "model_texture_missing",
    );
    for mismatch in [
        entry("tex.png", 5, &sha("ab"), Some("image/png")),
        entry("tex.png", 4, &sha("cd"), Some("image/png")),
        entry("tex.png", 4, &sha("ab"), Some("image/jpeg")),
        entry("tex.png", 4, &sha("ab"), None),
    ] {
        assert_rejected(
            &images,
            std::slice::from_ref(&mismatch),
            "model_texture_mismatch",
        );
    }
    assert_rejected(
        &[package("tex.png", 4, &sha("ab"), "image/png", 0)],
        &[good],
        "model_texture_mismatch",
    );
    // Uppercase or truncated author digests are not canonical entry tuples.
    assert_rejected(
        &[package("tex.png", 4, &"AB".repeat(32), "image/png", 1)],
        &[entry("tex.png", 4, &"AB".repeat(32), Some("image/png"))],
        "model_texture_mismatch",
    );
}

#[test]
fn record_and_source_bounds_fail_closed_with_independent_limits() {
    let two = [
        package("tex.png", 4, &sha("ab"), "image/png", 1),
        package("other.png", 6, &sha("cd"), "image/png", 1),
    ];
    let entries = [
        entry("tex.png", 4, &sha("ab"), Some("image/png")),
        entry("other.png", 6, &sha("cd"), Some("image/png")),
    ];
    for (record_limit, source_limit) in [(1, 10), (2, 9)] {
        let error = validate_records(&two, &entries, record_limit, source_limit)
            .err()
            .unwrap();
        assert_eq!(error.code, "model_texture_limit");
        assert_eq!(error.message, DIAGNOSTIC);
    }
    // Shared aliases are still bounded conservatively over their records.
    let aliased = [
        package("tex.png", 4, &sha("ab"), "image/png", 1),
        package("tex.png", 4, &sha("ab"), "image/png", 1),
    ];
    let error = validate_records(&aliased, &entries[..1], 2, 7)
        .err()
        .unwrap();
    assert_eq!(error.code, "model_texture_limit");
    // Embedded images are not package bytes.
    let mixed = [embedded(), two[0].clone()];
    assert_eq!(
        validate_records(&mixed, &entries[..1], 1, 4).unwrap(),
        (1, 4)
    );
    assert_eq!(validate_records(&two, &entries, 2, 10).unwrap(), (2, 10));
}

#[test]
fn pinned_missing_file_after_admission_refunds_every_closure_backing() {
    let budget = Arc::new(budget::BudgetCoordinator::new());
    let entries = [entry("tex.png", 4, &sha("ab"), Some("image/png"))];
    let images = [package("tex.png", 4, &sha("ab"), "image/png", 1)];
    let (error, sample) =
        measure_requested_heap(|| unreachable_build(&images, &entries, &budget).err().unwrap());
    assert!(!sample.overflow);
    assert_eq!(error.code, "model_texture_missing");
    assert_eq!(error.message, DIAGNOSTIC);
    // The admitted record/File/path backings and their charge are gone.
    assert_eq!(budget.usage(), budget::BudgetUsage::default());
}
