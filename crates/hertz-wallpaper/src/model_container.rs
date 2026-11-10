// SPDX-License-Identifier: MIT
//! GLB container framing only. Geometry, dependencies and renderer admission
//! remain separate; accepting this envelope never grants a model adapter.

use serde::Deserialize;
use std::io::Read;

use crate::{
    json::{check_bounded_json, check_finite_json_values},
    resource_container_io::ContainerReader,
    PackageError, Result, MAX_MANIFEST_DEPTH, MAX_MODEL_BYTES, MAX_TEXT_BYTES,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryChunk {
    pub offset: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlbContainer {
    /// Original bounded JSON, including container padding. No semantic Value
    /// tree or executable resource is retained by this inspector.
    pub json: Vec<u8>,
    pub binary: Option<BinaryChunk>,
}

#[derive(Deserialize)]
struct DocumentHeader {
    asset: AssetHeader,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetHeader {
    version: String,
    min_version: Option<String>,
}

pub fn inspect_glb<R: Read>(input: R, declared_bytes: u64) -> Result<GlbContainer> {
    if !(20..=MAX_MODEL_BYTES).contains(&declared_bytes) || declared_bytes % 4 != 0 {
        return Err(PackageError::new(
            "invalid_model_container",
            "GLB verified length is outside the model limit or unaligned",
        ));
    }
    let mut reader = ContainerReader::new(input, declared_bytes, "invalid_model_container");
    let header = reader.fixed::<12>()?;
    if &header[..4] != b"glTF" {
        return Err(reader.error("GLB magic mismatch"));
    }
    if u32::from_le_bytes(header[4..8].try_into().expect("fixed version")) != 2 {
        return Err(PackageError::new(
            "model_container_unavailable",
            "only GLB version 2 is available",
        ));
    }
    if u64::from(u32::from_le_bytes(
        header[8..12].try_into().expect("fixed length"),
    )) != declared_bytes
    {
        return Err(reader.error("GLB total length does not match the verified entry"));
    }
    let chunk = reader.fixed::<8>()?;
    let json_length = u64::from(u32::from_le_bytes(
        chunk[..4].try_into().expect("fixed chunk length"),
    ));
    if &chunk[4..] != b"JSON" {
        return Err(reader.error("first GLB chunk must be JSON"));
    }
    if json_length == 0
        || json_length % 4 != 0
        || json_length > MAX_TEXT_BYTES
        || json_length > reader.remaining()
    {
        return Err(
            reader.error("JSON length exceeds its bounded text/container range or is unaligned")
        );
    }
    let mut json = vec![0; json_length as usize];
    reader.read_into(&mut json)?;
    check_bounded_json(&json, MAX_MANIFEST_DEPTH)
        .map_err(|error| reader.error(format!("invalid GLB JSON: {error}")))?;
    check_finite_json_values(&json)
        .map_err(|error| reader.error(format!("invalid GLB numeric value: {error}")))?;
    // serde ignores unrelated members without allocating a recursive Value.
    let metadata: DocumentHeader = serde_json::from_slice(&json)
        .map_err(|error| reader.error(format!("invalid GLB asset header: {error}")))?;
    if metadata.asset.version != "2.0"
        || metadata
            .asset
            .min_version
            .as_deref()
            .is_some_and(|version| version != "2.0")
    {
        return Err(PackageError::new(
            "model_container_unavailable",
            "GLB asset version/minVersion must be 2.0",
        ));
    }
    let binary = if reader.remaining() == 0 {
        None
    } else {
        let chunk = reader.fixed::<8>()?;
        let bytes = u64::from(u32::from_le_bytes(
            chunk[..4].try_into().expect("fixed BIN length"),
        ));
        if chunk[4..] != [b'B', b'I', b'N', 0] {
            return Err(PackageError::new(
                "model_container_unavailable",
                "only JSON followed by optional BIN is available",
            ));
        }
        if bytes % 4 != 0 || bytes != reader.remaining() {
            return Err(reader.error("BIN length must consume the remaining aligned container"));
        }
        let binary = BinaryChunk {
            offset: reader.offset(),
            bytes,
        };
        reader.skip(bytes)?;
        Some(binary)
    };
    reader.finish()?;
    Ok(GlbContainer { json, binary })
}
