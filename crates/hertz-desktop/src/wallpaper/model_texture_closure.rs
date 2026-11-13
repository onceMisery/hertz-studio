// SPDX-License-Identifier: MIT
//! Canonical package texture closure for the checked model facts.
//!
//! Every `ModelImage::Package` record is bound to the installed package's
//! archive-verified entry tuple (path/bytes/SHA-256/MIME). Missing entries,
//! mismatched tuples and over-bound aggregates fail closed. The fixed record
//! Vec is admitted against its own ledger quota before it exists and refunded
//! only after that Vec backing has physically released.
//!
//! No File is opened here: real pins/codec work, Broker, loader, runtime and
//! GPU first-frame gates remain closed.

use super::{budget, JobError};
use hertz_wallpaper::{
    archive::VerifiedEntry,
    model_structure::{ModelImage, MAX_MODEL_IMAGE_RECORDS},
};
use std::alloc::Layout;
use std::sync::Arc;

const CLOSURE_DIAGNOSTIC: &str = "canonical model texture closure failed";

/// Aggregate upper bound over the model's Package image records. Duplicate
/// same-path records are counted conservatively; aliases share one installed
/// entry but the bound is still enforced on the record sum.
pub(super) const MAX_MODEL_TEXTURE_SOURCE_BYTES: u64 = 256 * 1024 * 1024;

#[repr(C)]
struct ClosedTexture {
    image_index: u32,
    entry_index: u32,
    bytes: u64,
    sha256: [u8; 32],
    references: u32,
}

/// One closure owns the fixed record Vec and its prior admission. Field order
/// is deliberate: `textures` physically releases before `charge` refunds.
pub(super) struct ModelTextureClosure {
    textures: Vec<ClosedTexture>,
    unique_entries: u32,
    unique_source_bytes: u64,
    charge: Option<budget::ModelTextureClosureCharge>,
}

impl ModelTextureClosure {
    pub(super) fn len(&self) -> usize {
        self.textures.len()
    }

    pub(super) fn unique_entries(&self) -> u32 {
        self.unique_entries
    }

    pub(super) fn unique_source_bytes(&self) -> u64 {
        self.unique_source_bytes
    }

    #[cfg(test)]
    pub(super) fn release_allocations_for_test(&self) -> Option<(usize, usize, usize)> {
        let capacity = self.textures.capacity();
        if capacity == 0 {
            return None;
        }
        Some((
            self.textures.as_ptr() as usize,
            capacity * std::mem::size_of::<ClosedTexture>(),
            std::mem::align_of::<ClosedTexture>(),
        ))
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

fn build_with_limits(
    images: &[ModelImage],
    entries: &[VerifiedEntry],
    budget: &Arc<budget::BudgetCoordinator>,
    record_limit: usize,
    source_limit: u64,
) -> Result<ModelTextureClosure, JobError> {
    // First pass: zero-allocation validation and bounds over every Package
    // record. Embedded images carry their bytes inside the already-checked BIN
    // and are not package closures.
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
    // Prior admission: the exact fixed-record backing request is checked and
    // booked under the original ledger lock before the Vec is allocated.
    let charge = if count == 0 {
        None
    } else {
        let requested = Layout::array::<ClosedTexture>(count)
            .map_err(|_| fixed_error("model_texture_limit"))?
            .size() as u64;
        Some(
            budget
                .admit_model_texture_closure(requested)
                .map_err(|_| fixed_error("budget_busy"))?,
        )
    };
    // Second pass repeats the same deterministic validation, then fills the
    // admitted Vec. Any defensive failure drops the Vec before the charge.
    let mut textures = Vec::with_capacity(count);
    for (image_index, image) in images.iter().enumerate() {
        if matches!(image, ModelImage::Embedded { .. }) {
            continue;
        }
        let (entry_index, entry, sha256, references) = resolve(image, entries)?;
        let image_index =
            u32::try_from(image_index).map_err(|_| fixed_error("model_texture_limit"))?;
        textures.push(ClosedTexture {
            image_index,
            entry_index,
            bytes: entry.bytes,
            sha256,
            references,
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
        unique_entries,
        unique_source_bytes,
        charge,
    })
}

pub(super) fn build(
    images: &[ModelImage],
    entries: &[VerifiedEntry],
    budget: &Arc<budget::BudgetCoordinator>,
) -> Result<ModelTextureClosure, JobError> {
    build_with_limits(
        images,
        entries,
        budget,
        MAX_MODEL_IMAGE_RECORDS,
        MAX_MODEL_TEXTURE_SOURCE_BYTES,
    )
}

#[cfg(test)]
#[path = "model_texture_closure_tests.rs"]
mod tests;
