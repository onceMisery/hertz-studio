// SPDX-License-Identifier: MIT
//! Rebuildable generations in the original derived_entries/LRU owner.
use super::{
    cancelled, error, Facts, FontIdentity, Input, Options, PreparedSvg, Receipt, Result, PIPELINE,
};
use crate::wallpaper::{
    assets::{open_immutable, AssetStore},
    derived_cache,
    library::{now_secs, Library},
};
use sha2::{Digest, Sha256};
use std::{
    io::{BufReader, Read},
    path::Path,
    sync::atomic::AtomicBool,
};
fn verify(
    directory: &Path,
    input: &Input,
    facts: &Facts,
    fonts: &[FontIdentity],
    options: &Options,
    key: &str,
) -> Result<Receipt> {
    let mut bytes = Vec::new();
    open_immutable(&directory.join("receipt.json"))?
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() > 65536 {
        return Err(error("SVG 收据超限"));
    }
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(error)?;
    if receipt.cache_key != key
        || receipt.input_hash != input.source.entry.sha256
        || receipt.pipeline != PIPELINE
        || receipt.options != options.canonical()?
        || receipt.source != *facts
        || receipt.fonts != fonts
        || receipt.prepare_cpu_bytes > crate::wallpaper::budget::MAX_PREPARE_CPU_BYTES
    {
        return Err(error("SVG 派生缓存身份不一致"));
    }
    let target = super::ImageTarget {
        width: 512,
        height: 512,
        fit: super::ImageFit::Contain,
        purpose: super::ImagePurpose::High,
    };
    for (name, out, size) in [
        (
            "render.png",
            &receipt.render,
            (options.width, options.height),
        ),
        (
            "thumbnail.png",
            &receipt.thumbnail,
            super::dimensions(facts.width, facts.height, target)?,
        ),
    ] {
        if (out.width, out.height) != size || out.bytes == 0 || out.bytes > 32 * 1024 * 1024 {
            return Err(error("SVG 派生尺寸/字节不一致"));
        }
        let mut file = open_immutable(&directory.join(name))?;
        let mut hash = Sha256::new();
        let bytes = std::io::copy(&mut file, &mut hash).map_err(error)?;
        if bytes != out.bytes || format!("{:x}", hash.finalize()) != out.sha256 {
            return Err(error("SVG PNG hash 不一致"));
        }
        let decoder = png::Decoder::new_with_limits(
            BufReader::new(open_immutable(&directory.join(name))?),
            png::Limits {
                bytes: 8 * 1024 * 1024,
            },
        );
        let mut png = decoder.read_info().map_err(error)?;
        if png.info().width != size.0
            || png.info().height != size.1
            || png.info().color_type != png::ColorType::Rgba
            || png.info().bit_depth != png::BitDepth::Eight
            || png.info().srgb.is_none()
        {
            return Err(error("SVG PNG 必须为固定 RGBA8 sRGB"));
        }
        while png.next_row().map_err(error)?.is_some() {}
        png.finish().map_err(error)?;
    }
    Ok(receipt)
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn cached(
    store: &AssetStore,
    library: &Library,
    input: &Input,
    facts: &Facts,
    fonts: &[FontIdentity],
    options: &Options,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Option<PreparedSvg>> {
    cancelled(cancel)?;
    let row: Option<(String,)> =
        sqlx::query_as("SELECT path FROM derived_entries WHERE cache_key=?")
            .bind(key)
            .fetch_optional(library.pool())
            .await
            .map_err(error)?;
    if let Some((path,)) = row {
        let relative = std::path::PathBuf::from(path);
        let prefix = std::path::PathBuf::from(&input.source.entry.sha256)
            .join(PIPELINE)
            .join(key);
        if relative.parent() == Some(prefix.as_path())
            && relative
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| {
                    n.starts_with("gen-")
                        && n.len() <= 64
                        && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
        {
            if let Ok(lease) = derived_cache::pin(store, &relative) {
                let directory = store.root().join("derived").join(&relative);
                if let Ok(receipt) = verify(&directory, input, facts, fonts, options, key) {
                    sqlx::query(
                        "UPDATE derived_entries SET last_used=? WHERE cache_key=? AND path=?",
                    )
                    .bind(now_secs())
                    .bind(key)
                    .bind(relative.to_string_lossy().as_ref())
                    .execute(library.pool())
                    .await
                    .map_err(error)?;
                    cancelled(cancel)?;
                    return Ok(Some(PreparedSvg {
                        receipt,
                        directory,
                        relative,
                        staged: false,
                        lease: Some(lease),
                    }));
                }
            }
        }
    }
    cancelled(cancel)?;
    Ok(None)
}
