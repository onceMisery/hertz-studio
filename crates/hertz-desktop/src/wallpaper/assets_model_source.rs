// SPDX-License-Identifier: MIT
//! Canonical installed model source identity, before model/runtime qualification.
//! Only AssetStore constructs this outer anchor; no File or media Arc escapes.

use super::{
    read_source_sha256, source_pin_cancelled, source_scalar_io_error, AssetStore, PinnedMedia,
    Result,
};
use crate::root_owner::arc_allocation_bytes;
use crate::wallpaper::{
    budget,
    decode_probe::{ProbeClient, Reservation},
    jobs::JobError,
    target_planner::AssetRef,
};
use hertz_wallpaper::archive::{CanonicalIdentityHeapBounds, CanonicalPackageIdentity};
use std::alloc::Layout;
use std::{
    fs::File,
    io::{Seek, SeekFrom},
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf, Prefix},
    sync::{atomic::AtomicBool, Arc},
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_SHARE_READ, FILE_SHARE_WRITE,
};

// Three fixed directories plus at most 89 parents from validated <=180-byte
// relative paths (90 one-byte segments separated by 89 slashes).
const DIRECTORY_PINS: usize = 3 + (hertz_wallpaper::MAX_PATH_BYTES / 2 - 1);

#[derive(Clone)]
pub(crate) struct CanonicalModelSource(Arc<Inner>);

struct Resources {
    reference: AssetRef,
    identity: CanonicalPackageIdentity,
    media: PinnedMedia,
    _directories: Vec<File>,
}

struct Inner {
    resources: Option<Resources>,
    retained: Option<Reservation>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        // Every File, whole canonical identity and directory pin actually exits
        // before this own token can be confirmed/forgotten.
        drop(self.resources.take());
        if let Some(retained) = self.retained.take() {
            retained.finish();
        }
    }
}

impl CanonicalModelSource {
    pub(crate) fn reference(&self) -> &AssetRef {
        &self.0.resources.as_ref().expect("live source").reference
    }

    pub(crate) fn entry(&self) -> &hertz_wallpaper::VerifiedEntry {
        &self.0.resources.as_ref().expect("live source").media.entry
    }

    pub(crate) fn manifest(&self) -> &hertz_wallpaper::manifest::Manifest {
        self.0
            .resources
            .as_ref()
            .expect("live source")
            .identity
            .manifest()
    }

    #[cfg(test)]
    pub(crate) fn reservation_identity_for_test(&self) -> (&str, u64, &str) {
        self.0.retained.as_ref().unwrap().identity_for_test()
    }
}

/// Source factory bounds only. Legacy JobRequest/history/channel/terminal
/// diagnostics and the complete Nnative/model parser are not composed here.
pub(super) struct SourceFactoryHeapBounds {
    path_capacity: usize,
    workspace: u64,
    controls: u64,
}

fn heap_error() -> JobError {
    JobError::new(
        "canonical_source_heap_limit",
        "canonical source factory heap overflow",
    )
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(heap_error)
}

fn sum(terms: &[u64]) -> Result<u64> {
    terms.iter().try_fold(0, |total, &term| add(total, term))
}

fn package_error(error: hertz_wallpaper::PackageError) -> JobError {
    JobError::new(
        if error.code == "cancelled" {
            "cancelled"
        } else {
            "package_invalid"
        },
        error.message,
    )
}

fn canonical_root(root: &Path) -> Result<()> {
    if !root.is_absolute()
        || !matches!(root.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _)))
    {
        return Err(JobError::invalid_input(
            "canonical model root requires an absolute verbatim disk/UNC prefix",
        ));
    }
    Ok(())
}

impl AssetStore {
    /// Pure checked query: actual owner/input capacities plus original bounds.
    pub(super) fn model_source_factory_bounds(
        &self,
        reference: &AssetRef,
        preparation: &Reservation,
    ) -> Result<SourceFactoryHeapBounds> {
        canonical_root(self._root_owner.root())?;
        let root_bytes = self._root_owner.root().as_os_str().as_encoded_bytes().len();
        // "\\packages\\" 10 + hash 64 + "\\files\\" 7 + canonical path 180.
        let path_capacity = root_bytes
            .checked_add(10 + 64 + 7 + hertz_wallpaper::MAX_PATH_BYTES)
            .ok_or_else(heap_error)?;
        let input = sum(&[
            reference.package_hash.capacity() as u64,
            reference.asset_id.capacity() as u64,
            reference
                .variant_id
                .as_ref()
                .map_or(0, |id| id.capacity() as u64),
        ])?;
        let live_base = sum(&[
            self.root.capacity() as u64,
            self._root_owner
                .retained_heap_bytes()
                .ok_or_else(heap_error)?,
            input,
            preparation
                .retained_control_heap_bytes()
                .ok_or_else(heap_error)?,
        ])?;
        let path = Layout::array::<u8>(path_capacity)
            .map_err(|_| heap_error())?
            .size() as u64;
        let wide_units = path_capacity.checked_add(1).ok_or_else(heap_error)?;
        let wide = Layout::array::<u16>(wide_units)
            .map_err(|_| heap_error())?
            .size() as u64;
        let directories = Layout::array::<File>(DIRECTORY_PINS)
            .map_err(|_| heap_error())?
            .size() as u64;
        // Actual clone allocation requests: String::clone copies len, not the
        // caller capacity. VerifiedEntry is borrowed from the original identity.
        let reference_clone = sum(&[
            reference.package_hash.len() as u64,
            reference.asset_id.len() as u64,
            reference
                .variant_id
                .as_ref()
                .map_or(0, |id| id.len() as u64),
        ])?;
        let selected_clone = (hertz_wallpaper::MAX_PATH_BYTES + 64 + 127) as u64;
        // Original ordinary ledger and the separate Wc/Wi/R request strings;
        // Reservation/Resources inline bodies already live in Inner's Arc.
        let tickets = 3 * (128 + 64);
        let controls = sum(&[
            live_base,
            path,
            directories,
            arc_allocation_bytes::<Inner>().ok_or_else(heap_error)?,
            reference_clone,
            selected_clone,
            budget::ordinary_grant_metadata_heap_bytes().ok_or_else(heap_error)?,
            tickets,
        ])?;
        // Two 64-byte hash Strings may overlap; scalar diagnostics allocate one
        // exact template buffer. The 64KiB SHA read array itself is on the stack.
        let diagnostics = add(
            super::SOURCE_IO_DIAGNOSTIC_MAX_BYTES as u64,
            budget::ordinary_memory_grant_diagnostic_heap_bytes().ok_or_else(heap_error)?,
        )?;
        let workspace = sum(&[controls, wide, 2 * 64, diagnostics])?;
        Ok(SourceFactoryHeapBounds {
            path_capacity,
            workspace,
            controls,
        })
    }

    pub(crate) fn pin_canonical_model_source(
        &self,
        reference: &AssetRef,
        probe: &ProbeClient,
        preparation: &Reservation,
        cancel: &AtomicBool,
    ) -> Result<CanonicalModelSource> {
        reference.validate()?;
        source_pin_cancelled(cancel)?;
        let bounds = self.model_source_factory_bounds(reference, preparation)?;
        let workspace =
            probe.job_memory(preparation, "model-source-opening", bounds.workspace, 0)?;
        // This complete inner scope drops all partial path/File/identity owners
        // on failure before the W ticket is physically confirmed below.
        let outcome = (|| {
            source_pin_cancelled(cancel)?;
            let mut path = PathBuf::with_capacity(bounds.path_capacity);
            let mut directories = Vec::with_capacity(DIRECTORY_PINS);
            reset_path(&mut path, self._root_owner.root(), bounds.path_capacity)?;
            for segment in ["packages", reference.package_hash.as_str()] {
                append_segment(&mut path, segment, bounds.path_capacity)?;
                pin_directory(&path, &mut directories)?;
                source_pin_cancelled(cancel)?;
            }
            append_segment(&mut path, "original.hwpkg", bounds.path_capacity)?;
            let mut original = open_file(&path, "open original")?;
            let metadata = original
                .metadata()
                .map_err(|error| source_scalar_io_error("metadata original", 0, &error))?;
            hertz_wallpaper::archive::check_package_bytes(metadata.len()).map_err(package_error)?;
            source_pin_cancelled(cancel)?;
            // The same ordinary immutable File supplies trusted physical length.
            // Full original container limits remain; no small metadata profile.
            let identity_bounds =
                CanonicalIdentityHeapBounds::for_package_bytes::<&mut File>(metadata.len(), None)
                    .map_err(package_error)?;
            let identity_workspace = probe.job_memory(
                preparation,
                "model-identity",
                identity_bounds.workspace_requested_bytes(),
                0,
            )?;
            // Move all partial File/path/directory owners into this FnOnce scope.
            // Error returns drop them and identity before Wi.finish, then Wc.
            let outcome = (move || {
                let (_, original_hash) = read_source_sha256(&mut original, cancel)?;
                if original_hash != reference.package_hash {
                    return Err(JobError::new(
                        "hash_mismatch",
                        "canonical original package hash changed",
                    ));
                }
                drop(original_hash);
                original
                    .seek(SeekFrom::Start(0))
                    .map_err(|error| source_scalar_io_error("seek original", 0, &error))?;
                let identity =
                    hertz_wallpaper::archive::inspect_package_identity_with_limits_and_cancel(
                        &mut original,
                        identity_bounds.effective_metadata_limits(),
                        cancel,
                    )
                    .map_err(package_error)?;
                let binding = identity
                    .model_binding(&reference.asset_id, reference.variant_id.as_deref())
                    .map_err(package_error)?;
                let declared = binding.entry();
                if declared.mime != "model/gltf-binary" {
                    return Err(JobError::new(
                        "package_invalid",
                        "canonical model source requires model/gltf-binary",
                    ));
                }
                let entry = identity
                    .entries()
                    .iter()
                    .find(|entry| {
                        entry.path == declared.path
                            && entry.bytes == declared.bytes
                            && entry.sha256 == declared.sha256
                            && entry.mime.as_deref() == Some(declared.mime.as_str())
                    })
                    .ok_or_else(|| {
                        JobError::new(
                            "hash_mismatch",
                            "canonical model mapping/entry tuple differs",
                        )
                    })?;
                reset_path(&mut path, self._root_owner.root(), bounds.path_capacity)?;
                for segment in ["packages", reference.package_hash.as_str(), "files"] {
                    append_segment(&mut path, segment, bounds.path_capacity)?;
                }
                pin_directory(&path, &mut directories)?;
                let mut segments = entry.path.split('/').peekable();
                while let Some(segment) = segments.next() {
                    append_segment(&mut path, segment, bounds.path_capacity)?;
                    if segments.peek().is_some() {
                        pin_directory(&path, &mut directories)?;
                        source_pin_cancelled(cancel)?;
                    }
                }
                let mut file = open_file(&path, "open projection")?;
                if file
                    .metadata()
                    .map_err(|error| source_scalar_io_error("metadata projection", 0, &error))?
                    .len()
                    != entry.bytes
                {
                    return Err(JobError::new(
                        "hash_mismatch",
                        "canonical model projection length changed",
                    ));
                }
                let (bytes, hash) = read_source_sha256(&mut file, cancel)?;
                if bytes != entry.bytes || hash != entry.sha256 {
                    return Err(JobError::new(
                        "hash_mismatch",
                        "canonical model projection hash changed",
                    ));
                }
                drop(hash);
                file.seek(SeekFrom::Start(0))
                    .map_err(|error| source_scalar_io_error("seek projection", 0, &error))?;
                source_pin_cancelled(cancel)?;
                // The actual original manifest-recorded identity fee is retained;
                // transfer conservatively holds W and R together. No identity clone.
                let retained_bytes = add(
                    identity
                        .retained_identity_requested_bytes()
                        .map_err(package_error)?,
                    bounds.controls,
                )?;
                let retained = probe.job_memory(preparation, "model-source", 0, retained_bytes)?;
                let mut inner = Inner {
                    resources: None,
                    retained: Some(retained),
                };
                let media = PinnedMedia {
                    entry: entry.clone(),
                    path,
                    _package_pin: Some(original),
                    _file_pin: file,
                    _derived_lease: None,
                    _root_owner: Arc::clone(&self._root_owner),
                };
                inner.resources = Some(Resources {
                    reference: reference.clone(),
                    identity,
                    media,
                    _directories: directories,
                });
                source_pin_cancelled(cancel)?;
                Ok(CanonicalModelSource(Arc::new(inner)))
            })();
            identity_workspace.finish();
            outcome
        })();
        workspace.finish();
        outcome
    }
}

fn reset_path(path: &mut PathBuf, root: &Path, capacity: usize) -> Result<()> {
    path.as_mut_os_string().clear();
    if root.as_os_str().as_encoded_bytes().len() > capacity {
        return Err(heap_error());
    }
    path.as_mut_os_string().push(root);
    Ok(())
}

fn append_segment(path: &mut PathBuf, segment: &str, capacity: usize) -> Result<()> {
    let bytes = path.as_os_str().as_encoded_bytes();
    let separator = usize::from(!matches!(bytes.last(), Some(b'\\' | b'/')));
    if bytes
        .len()
        .checked_add(separator)
        .and_then(|n| n.checked_add(segment.len()))
        .is_none_or(|n| n > capacity)
    {
        return Err(heap_error());
    }
    if separator != 0 {
        path.as_mut_os_string().push("\\");
    }
    path.as_mut_os_string().push(segment);
    Ok(())
}

fn pin_directory(path: &Path, pins: &mut Vec<File>) -> Result<()> {
    if pins.len() >= DIRECTORY_PINS || pins.len() >= pins.capacity() {
        return Err(heap_error());
    }
    let file = File::options()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| source_scalar_io_error("open directory", 0, &error))?;
    ordinary(&file, true)?;
    pins.push(file);
    Ok(())
}

fn open_file(path: &Path, operation: &'static str) -> Result<File> {
    let file = File::options()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| source_scalar_io_error(operation, 0, &error))?;
    ordinary(&file, false)?;
    Ok(file)
}

fn ordinary(file: &File, directory: bool) -> Result<()> {
    let metadata = file
        .metadata()
        .map_err(|error| source_scalar_io_error("metadata source", 0, &error))?;
    if metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
    {
        return Err(JobError::new(
            "package_invalid",
            "canonical model source requires ordinary non-reparse paths",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "assets_model_source_tests.rs"]
pub(crate) mod tests;
