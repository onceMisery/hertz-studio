// SPDX-License-Identifier: MIT
//! Canonical package texture closure for the checked model facts.
//!
//! Every `ModelImage::Package` record is bound to the installed package's
//! archive-verified entry tuple (path/bytes/SHA-256/MIME) and to a pinned
//! read-only projection File whose actual length and full SHA-256 are
//! re-verified. Missing entries/files, mismatched tuples and over-bound
//! aggregates fail closed. The fixed record Vec, the File pin Vec and the
//! retained path buffer are admitted against one independent ledger quota
//! before they exist and refunded only after all three backings physically
//! release.
//!
//! No decoder, renderer or GPU owner is created here; Broker, loader, runtime
//! and GPU first-frame gates remain closed.

use super::{budget, JobError, MAX_MODEL_TEXTURE_READ_BYTES};
use crate::wallpaper::assets::{
    append_segment, open_file, read_source_sha256, reset_path, source_pin_cancelled,
    source_scalar_io_error,
};
use hertz_wallpaper::{
    archive::VerifiedEntry,
    model_structure::{ModelImage, MAX_MODEL_IMAGE_RECORDS},
    MAX_PATH_BYTES,
};
use std::alloc::Layout;
use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::os::windows::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, Arc};

const CLOSURE_DIAGNOSTIC: &str = "canonical model texture closure failed";

/// Aggregate upper bound over the model's Package image records. Duplicate
/// same-path records are counted conservatively; aliases share one installed
/// entry but the bound is still enforced on the record sum.
pub(super) const MAX_MODEL_TEXTURE_SOURCE_BYTES: u64 = 256 * 1024 * 1024;

/// "\\packages\\" 10 + 64-byte package hash + "\\files\\" 7 + canonical
/// relative path 180. The same bound as the canonical model source factory.
const PACKAGE_PATH_PREFIX_BYTES: usize = 10 + 64 + 7 + MAX_PATH_BYTES;

#[repr(C)]
struct ClosedTexture {
    image_index: u32,
    entry_index: u32,
    bytes: u64,
    sha256: [u8; 32],
    references: u32,
    file_index: u32,
}

/// Borrowed, data-only view of one unique texture record. No File, path or
/// closure owner is exposed to the resource index.
pub(super) struct TextureRecordView {
    pub(super) entry_index: u32,
    pub(super) image_index: u32,
    pub(super) bytes: u64,
    pub(super) sha256: [u8; 32],
    pub(super) references: u32,
}

pub(super) struct UniqueTextures<'a> {
    textures: &'a [ClosedTexture],
    index: usize,
}

impl Iterator for UniqueTextures<'_> {
    type Item = TextureRecordView;

    fn next(&mut self) -> Option<Self::Item> {
        while self.index < self.textures.len() {
            let index = self.index;
            self.index += 1;
            let texture = &self.textures[index];
            if self.textures[..index]
                .iter()
                .any(|previous| previous.entry_index == texture.entry_index)
            {
                continue;
            }
            return Some(TextureRecordView {
                entry_index: texture.entry_index,
                image_index: texture.image_index,
                bytes: texture.bytes,
                sha256: texture.sha256,
                references: texture.references,
            });
        }
        None
    }
}

/// One closure owns the fixed record Vec, its unique File pins and the retained
/// canonical path buffer. Field order is deliberate: every backing physically
/// releases before `charge` refunds.
pub(super) struct ModelTextureClosure {
    textures: Vec<ClosedTexture>,
    files: Vec<File>,
    path: PathBuf,
    unique_entries: u32,
    unique_source_bytes: u64,
    charge: Option<budget::ModelTextureClosureCharge>,
}

impl ModelTextureClosure {
    pub(super) fn len(&self) -> usize {
        self.textures.len()
    }

    /// Borrowed unique-entry view for the resource index. One record per
    /// installed entry; duplicate image aliases are skipped without scratch
    /// allocation.
    pub(super) fn unique_textures(&self) -> UniqueTextures<'_> {
        UniqueTextures {
            textures: &self.textures,
            index: 0,
        }
    }

    pub(super) fn unique_entries(&self) -> u32 {
        self.unique_entries
    }

    pub(super) fn unique_source_bytes(&self) -> u64 {
        self.unique_source_bytes
    }

    /// Canonical byte length for one Package image record. Embedded images and
    /// unknown indices have no closure bytes.
    pub(super) fn texture_bytes(&self, image_index: usize) -> Option<u64> {
        let image_index = u32::try_from(image_index).ok()?;
        self.textures
            .iter()
            .find(|texture| texture.image_index == image_index)
            .map(|texture| texture.bytes)
    }

    /// Bounded positional read from the retained read-only pin. The shared
    /// cursor is never used or moved, so independent readers cannot disturb
    /// each other. Success allocates nothing; only real I/O failures build the
    /// existing bounded scalar diagnostic.
    pub(super) fn read_into(
        &self,
        image_index: usize,
        offset: u64,
        output: &mut [u8],
        cancel: &AtomicBool,
    ) -> Result<(), JobError> {
        if output.len() > MAX_MODEL_TEXTURE_READ_BYTES {
            return Err(fixed_error("model_texture_bounds"));
        }
        let Ok(image_index) = u32::try_from(image_index) else {
            return Err(fixed_error("model_texture_missing"));
        };
        let texture = self
            .textures
            .iter()
            .find(|texture| texture.image_index == image_index)
            .ok_or_else(|| fixed_error("model_texture_missing"))?;
        let end = offset
            .checked_add(output.len() as u64)
            .ok_or_else(|| fixed_error("model_texture_bounds"))?;
        if end > texture.bytes {
            return Err(fixed_error("model_texture_bounds"));
        }
        let file = self
            .files
            .get(texture.file_index as usize)
            .ok_or_else(|| fixed_error("model_texture_missing"))?;
        let mut filled = 0usize;
        while filled < output.len() {
            source_pin_cancelled(cancel)?;
            let position = offset + filled as u64;
            match file.seek_read(&mut output[filled..], position) {
                Ok(0) => return Err(fixed_error("model_texture_mismatch")),
                Ok(read) => filled += read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(source_scalar_io_error("read texture", position, &error)),
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn release_allocations_for_test(&self) -> Vec<(usize, usize, usize)> {
        let records = self.textures.capacity();
        if records == 0 {
            return Vec::new();
        }
        vec![
            (
                self.textures.as_ptr() as usize,
                records * std::mem::size_of::<ClosedTexture>(),
                std::mem::align_of::<ClosedTexture>(),
            ),
            (
                self.files.as_ptr() as usize,
                self.files.capacity() * std::mem::size_of::<File>(),
                std::mem::align_of::<File>(),
            ),
            (
                self.path.as_os_str().as_encoded_bytes().as_ptr() as usize,
                self.path.capacity(),
                1,
            ),
        ]
    }
}

fn fixed_error(code: &'static str) -> JobError {
    JobError::new(code, CLOSURE_DIAGNOSTIC)
}

fn decode_sha256(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            _ => None,
        }
    }
    let mut decoded = [0u8; 32];
    for (slot, pair) in decoded.iter_mut().zip(text.as_bytes().as_chunks::<2>().0) {
        let (Some(high), Some(low)) = (nibble(pair[0]), nibble(pair[1])) else {
            return None;
        };
        *slot = high * 16 + low;
    }
    Some(decoded)
}

fn resolve<'a>(
    image: &ModelImage,
    entries: &'a [VerifiedEntry],
) -> Result<(u32, &'a VerifiedEntry, [u8; 32], u32), JobError> {
    let ModelImage::Package {
        path,
        mime,
        bytes,
        sha256,
        references,
    } = image
    else {
        return Err(fixed_error("model_texture_mismatch"));
    };
    let (index, entry) = entries
        .iter()
        .enumerate()
        .find(|(_, entry)| entry.path == *path)
        .ok_or_else(|| fixed_error("model_texture_missing"))?;
    if entry.bytes != *bytes
        || entry.sha256 != *sha256
        || entry.mime.as_deref() != Some(mime.as_str())
    {
        return Err(fixed_error("model_texture_mismatch"));
    }
    if references.is_empty() {
        return Err(fixed_error("model_texture_mismatch"));
    }
    let digest = decode_sha256(sha256).ok_or_else(|| fixed_error("model_texture_mismatch"))?;
    let index = u32::try_from(index).map_err(|_| fixed_error("model_texture_limit"))?;
    let references =
        u32::try_from(references.len()).map_err(|_| fixed_error("model_texture_limit"))?;
    Ok((index, entry, digest, references))
}

/// First pass: zero-allocation tuple validation and bounds over every Package
/// record. Embedded images carry their bytes inside the already-checked BIN.
fn validate_records(
    images: &[ModelImage],
    entries: &[VerifiedEntry],
    record_limit: usize,
    source_limit: u64,
) -> Result<(usize, u64), JobError> {
    let mut count = 0usize;
    let mut record_bytes = 0u64;
    for image in images {
        if matches!(image, ModelImage::Embedded { .. }) {
            continue;
        }
        let (_, entry, _, _) = resolve(image, entries)?;
        count += 1;
        if count > record_limit {
            return Err(fixed_error("model_texture_limit"));
        }
        record_bytes = record_bytes
            .checked_add(entry.bytes)
            .ok_or_else(|| fixed_error("model_texture_limit"))?;
        if record_bytes > source_limit {
            return Err(fixed_error("model_texture_limit"));
        }
    }
    Ok((count, record_bytes))
}

fn requested_backing_bytes(count: usize, path_capacity: usize) -> Result<u64, JobError> {
    let records = Layout::array::<ClosedTexture>(count)
        .map_err(|_| fixed_error("model_texture_limit"))?
        .size() as u64;
    let files = Layout::array::<File>(count)
        .map_err(|_| fixed_error("model_texture_limit"))?
        .size() as u64;
    let path = Layout::array::<u8>(path_capacity)
        .map_err(|_| fixed_error("model_texture_limit"))?
        .size() as u64;
    records
        .checked_add(files)
        .and_then(|total| total.checked_add(path))
        .ok_or_else(|| fixed_error("model_texture_limit"))
}

pub(super) fn build(
    root: &Path,
    package_hash: &str,
    images: &[ModelImage],
    entries: &[VerifiedEntry],
    budget: &Arc<budget::BudgetCoordinator>,
    cancel: &AtomicBool,
) -> Result<ModelTextureClosure, JobError> {
    let (count, _) = validate_records(
        images,
        entries,
        MAX_MODEL_IMAGE_RECORDS,
        MAX_MODEL_TEXTURE_SOURCE_BYTES,
    )?;
    if count == 0 {
        return Ok(ModelTextureClosure {
            textures: Vec::new(),
            files: Vec::new(),
            path: PathBuf::new(),
            unique_entries: 0,
            unique_source_bytes: 0,
            charge: None,
        });
    }
    let path_capacity = root
        .as_os_str()
        .as_encoded_bytes()
        .len()
        .checked_add(PACKAGE_PATH_PREFIX_BYTES)
        .ok_or_else(|| fixed_error("model_texture_limit"))?;
    // Prior admission: the exact record Vec, File pin Vec and retained path
    // backing request is checked and booked before any of them is allocated.
    let requested = requested_backing_bytes(count, path_capacity)?;
    let charge = Some(
        budget
            .admit_model_texture_closure(requested)
            .map_err(|_| fixed_error("budget_busy"))?,
    );
    let mut path = PathBuf::with_capacity(path_capacity);
    let mut files: Vec<File> = Vec::with_capacity(count);
    let mut textures: Vec<ClosedTexture> = Vec::with_capacity(count);
    // Second pass repeats the deterministic tuple validation, pins each unique
    // installed projection File and re-verifies its actual length/full SHA-256.
    for (image_index, image) in images.iter().enumerate() {
        if matches!(image, ModelImage::Embedded { .. }) {
            continue;
        }
        let (entry_index, entry, sha256, references) = resolve(image, entries)?;
        let existing = textures
            .iter()
            .find(|texture| texture.entry_index == entry_index)
            .map(|texture| texture.file_index);
        let file_index = match existing {
            Some(index) => index,
            None => {
                source_pin_cancelled(cancel)?;
                reset_path(&mut path, root, path_capacity)?;
                for segment in ["packages", package_hash, "files"] {
                    append_segment(&mut path, segment, path_capacity)?;
                }
                for segment in entry.path.split('/') {
                    append_segment(&mut path, segment, path_capacity)?;
                }
                match path.try_exists() {
                    Ok(true) => {}
                    Ok(false) => return Err(fixed_error("model_texture_missing")),
                    Err(error) => {
                        return Err(source_scalar_io_error("metadata texture", 0, &error))
                    }
                }
                let mut file = open_file(&path, "open texture")?;
                let metadata = file
                    .metadata()
                    .map_err(|error| source_scalar_io_error("metadata texture", 0, &error))?;
                if metadata.len() != entry.bytes {
                    return Err(fixed_error("model_texture_mismatch"));
                }
                let (bytes, hash) = read_source_sha256(&mut file, cancel)?;
                if bytes != entry.bytes || hash != entry.sha256 {
                    return Err(fixed_error("model_texture_mismatch"));
                }
                drop(hash);
                file.seek(SeekFrom::Start(0))
                    .map_err(|error| source_scalar_io_error("seek texture", 0, &error))?;
                files.push(file);
                u32::try_from(files.len() - 1).map_err(|_| fixed_error("model_texture_limit"))?
            }
        };
        let image_index =
            u32::try_from(image_index).map_err(|_| fixed_error("model_texture_limit"))?;
        textures.push(ClosedTexture {
            image_index,
            entry_index,
            bytes: entry.bytes,
            sha256,
            references,
            file_index,
        });
    }
    let mut unique_entries = 0u32;
    let mut unique_source_bytes = 0u64;
    for (index, texture) in textures.iter().enumerate() {
        if textures[..index]
            .iter()
            .any(|previous| previous.entry_index == texture.entry_index)
        {
            continue;
        }
        unique_entries += 1;
        unique_source_bytes = unique_source_bytes
            .checked_add(texture.bytes)
            .ok_or_else(|| fixed_error("model_texture_limit"))?;
    }
    Ok(ModelTextureClosure {
        textures,
        files,
        path,
        unique_entries,
        unique_source_bytes,
        charge,
    })
}

#[cfg(test)]
#[path = "model_texture_closure_tests.rs"]
mod tests;
