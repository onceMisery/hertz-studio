// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! HWPK 包的 ZIP 层安全校验（设计 §6.1/§6.3，反例 C09）。
//!
//! ZIP 只是运输容器，不是信任边界：本模块在解包之前执行全部结构安全规则，
//! 并对流式读取的每个条目实际计数与求哈希——不信任中央目录声明的字节数。
//! 只接受 Store/Deflate；拒绝加密、符号链接与压缩比超过 100:1 的条目；
//! 解压总量有流式上限，超限立即终止，不分配后才检查。

use std::collections::HashSet;
use std::io::{Read, SeekFrom};

use sha2::{Digest, Sha256};
use zip::read::MetadataLimits;
use zip::ZipArchive;

use crate::manifest::{validate_manifest_bytes, Manifest, MANIFEST_PATH};
use crate::paths::validate_rel_path_ext;
use crate::{
    PackageError, Result, MAX_COMPRESSION_RATIO, MAX_FILES, MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES,
    MAX_UNCOMPRESSED_BYTES,
};

/// 校验通过的条目（路径为校验后的规范形式）。收据序列化复用该类型。
/// mime 由 manifest files 行填入；旧收据缺省为 None（serde default 兼容）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VerifiedEntry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub mime: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ValidatedPackage {
    pub manifest: Manifest,
    pub entries: Vec<VerifiedEntry>,
}

/// 一次性校验完整包：manifest 校验 + archive 结构与内容一致性。
pub fn validate_package<R: std::io::Read + std::io::Seek>(reader: R) -> Result<ValidatedPackage> {
    let mut archive = open_archive(reader)?;
    let manifest_bytes = read_manifest_bytes(&mut archive)?;
    let manifest = validate_manifest_bytes(&manifest_bytes)?;
    let entries = validate_archive_in_place(&mut archive, &manifest)?;
    validate_composition_in_place(&mut archive, &manifest)?;
    validate_resource_containers_in_place(&mut archive, &manifest)?;
    Ok(ValidatedPackage { manifest, entries })
}

/// 对已解析的 manifest 校验 archive 结构与内容（安装器的第二阶段）。
pub fn validate_archive<R: std::io::Read + std::io::Seek>(
    mut reader: R,
    manifest: &Manifest,
) -> Result<Vec<VerifiedEntry>> {
    let mut archive = open_archive(&mut reader)?;
    // Supplying an already parsed manifest must not bypass the original
    // manifest entry's physical bounds or actual inflation ratio.
    read_manifest_bytes(&mut archive)?;
    let entries = validate_archive_in_place(&mut archive, manifest)?;
    validate_composition_in_place(&mut archive, manifest)?;
    validate_resource_containers_in_place(&mut archive, manifest)?;
    Ok(entries)
}

fn validate_composition_in_place<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    manifest: &Manifest,
) -> Result<()> {
    let crate::Content::Composition { document } = &manifest.content else {
        return Ok(());
    };
    // Archive paths, lengths and hashes have already been verified by the same
    // owner. Reuse that exact immutable entry, never open an external path.
    let file = archive
        .by_name(document)
        .map_err(|error| PackageError::new("missing_document", error.to_string()))?;
    if file.size() > crate::document::MAX_DOCUMENT_BYTES as u64 {
        return Err(PackageError::new(
            "document_too_large",
            "组合文档超过 1 MiB",
        ));
    }
    let mut bytes = Vec::new();
    file.take(crate::document::MAX_DOCUMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| PackageError::new("invalid_composition", error.to_string()))?;
    crate::document::compile_document(&bytes, manifest)?;
    Ok(())
}

fn validate_resource_containers_in_place<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    manifest: &Manifest,
) -> Result<()> {
    let mut inspected = HashSet::new();
    for asset in &manifest.assets {
        let model = asset.kind == crate::AssetKind::Model;
        if !model && asset.kind != crate::AssetKind::Texture {
            continue;
        }
        for path in
            std::iter::once(&asset.source).chain(asset.variants.iter().map(|variant| &variant.file))
        {
            let entry = manifest.file(path).ok_or_else(|| {
                PackageError::new(
                    "missing_file",
                    format!("resource {} references undeclared file {path}", asset.id),
                )
            })?;
            // A file may have several asset aliases. Validate each role before
            // deduplicating the immutable file's container inspection.
            if model && entry.mime != "model/gltf-binary" {
                return Err(PackageError::new(
                    "model_container_unavailable",
                    format!("model asset {path} requires the GLB container subset"),
                ));
            }
            let ktx2 = asset.kind == crate::AssetKind::Texture && entry.mime == "image/ktx2";
            if (!model && !ktx2) || !inspected.insert(path) {
                continue;
            }
            let input = archive
                .by_name(path)
                .map_err(|error| PackageError::new("missing_file", error.to_string()))?;
            let result = if model {
                crate::model_binary::inspect_glb_resource_content(
                    input,
                    entry.bytes,
                    manifest,
                    path,
                )
                .and_then(|checked| {
                    if checked.sha256_hex() != entry.sha256 {
                        return Err(PackageError::new(
                            "hash_mismatch",
                            "model content check stream differs from the declared SHA-256",
                        ));
                    }
                    Ok(())
                })
            } else {
                crate::texture_container::inspect_ktx2(input, entry.bytes).map(|_| ())
            };
            result.map_err(|error| {
                PackageError::new(error.code, format!("resource {path}: {}", error.message))
            })?;
        }
    }
    Ok(())
}

fn open_archive<R: std::io::Read + std::io::Seek>(mut reader: R) -> Result<ZipArchive<R>> {
    let bytes = reader
        .seek(SeekFrom::End(0))
        .map_err(|error| PackageError::new("format_unsupported", error.to_string()))?;
    check_package_bytes(bytes)?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| PackageError::new("format_unsupported", error.to_string()))?;
    let metadata_bytes = usize::try_from(bytes)
        .map_err(|_| PackageError::new("package_too_large", "包长度无法在当前平台表示"))?;
    // Preserve the original manifest/directory allowance. Variable metadata
    // cannot occupy more than the physical package; these are container bounds,
    // not the native preparation workspace's separate admission budget.
    let limits = MetadataLimits {
        max_raw_entries: MAX_FILES + 8,
        max_variable_bytes: metadata_bytes,
        max_zip64_extensible_bytes: metadata_bytes,
        max_eocd_comment_bytes: u16::MAX as usize,
    };
    let archive =
        ZipArchive::with_metadata_limits(Default::default(), reader, limits).map_err(|error| {
            match error {
                zip::result::ZipError::MetadataLimitExceeded("raw entry limit exceeded") => {
                    PackageError::new("too_many_files", format!("条目数超过 {MAX_FILES} 上限"))
                }
                zip::result::ZipError::MetadataLimitExceeded(reason) => {
                    PackageError::new("zip_metadata_limit", reason)
                }
                error => PackageError::new(
                    "format_unsupported",
                    format!("不是合法的 ZIP 容器：{error}"),
                ),
            }
        })?;
    // IndexMap preserves the last decoded name. Reject hidden duplicate central
    // records before even opening the manifest, along the existing path rule.
    if archive.raw_file_count() != archive.len() {
        return Err(PackageError::new("path_collides", "中央目录包含重复条目名"));
    }
    Ok(archive)
}

fn read_manifest_bytes<R: std::io::Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Vec<u8>> {
    let directory_start = archive.central_directory_start();
    let index = archive
        .index_for_name(MANIFEST_PATH)
        .ok_or_else(|| PackageError::new("missing_manifest", "包根缺少 manifest.json"))?;
    let mut file = archive.by_index(index).map_err(|error| {
        PackageError::new(
            "format_unsupported",
            format!("manifest.json 不可读：{error}"),
        )
    })?;
    if file.compression() != zip::CompressionMethod::Stored
        && file.compression() != zip::CompressionMethod::Deflated
    {
        return Err(PackageError::new(
            "unsupported_compression",
            "manifest.json 只允许 Store/Deflate",
        ));
    }
    if file.size() > MAX_MANIFEST_BYTES as u64 {
        return Err(PackageError::new(
            "manifest_too_large",
            "manifest.json 超过大小上限",
        ));
    }
    check_compressed_range(&file, directory_start)?;
    let mut bytes = Vec::new();
    // 中央目录可以谎报尺寸，实际解压也必须在分配前截断。
    file.by_ref()
        .take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            PackageError::new(
                "format_unsupported",
                format!("manifest.json 读取失败：{error}"),
            )
        })?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(PackageError::new(
            "manifest_too_large",
            "manifest.json 超过大小上限",
        ));
    }
    check_compression_ratio(&file, bytes.len() as u64)?;
    Ok(bytes)
}

fn check_compressed_range<R: Read>(
    file: &zip::read::ZipFile<'_, R>,
    directory_start: u64,
) -> Result<()> {
    if file
        .data_start()
        .checked_add(file.compressed_size())
        .is_none_or(|end| end > directory_start)
    {
        return Err(PackageError::new(
            "invalid_compressed_range",
            format!("条目 {} 的压缩数据超出中央目录前的范围", file.name()),
        ));
    }
    Ok(())
}

fn check_compression_ratio<R: Read>(
    file: &zip::read::ZipFile<'_, R>,
    uncompressed: u64,
) -> Result<()> {
    // ceil(E / limit) <= C is exactly E <= limit * C without overflow.
    // E comes from the canonical manifest and is subsequently checked against
    // the actual stream, or is the manifest's actual bounded decoded length.
    if file.compression() == zip::CompressionMethod::Deflated
        && uncompressed.div_ceil(MAX_COMPRESSION_RATIO) > file.compressed_size()
    {
        return Err(PackageError::new(
            "ratio_exceeded",
            format!("条目 {} 压缩比超过 {MAX_COMPRESSION_RATIO}:1", file.name()),
        ));
    }
    Ok(())
}

fn validate_archive_in_place<R: std::io::Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    manifest: &Manifest,
) -> Result<Vec<VerifiedEntry>> {
    if archive.len() > MAX_FILES + 8 {
        return Err(PackageError::new(
            "too_many_files",
            format!("条目数超过 {MAX_FILES} 上限"),
        ));
    }
    let mut seen_lower: HashSet<String> = HashSet::new();
    let mut declared: HashSet<&str> = manifest
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    let mut verified = Vec::new();
    let mut total_uncompressed: u64 = 0;
    let mut saw_manifest = false;
    let directory_start = archive.central_directory_start();

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| {
            PackageError::new("format_unsupported", format!("条目不可读：{error}"))
        })?;
        let raw_name = file.name_raw().to_vec();
        let name = String::from_utf8(raw_name.clone())
            .map_err(|_| PackageError::new("invalid_path", "条目名不是合法 UTF-8"))?;
        if file.encrypted() {
            return Err(PackageError::new(
                "encrypted_entry",
                format!("条目已加密：{name}"),
            ));
        }
        match file.compression() {
            zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated => {}
            other => {
                return Err(PackageError::new(
                    "unsupported_compression",
                    format!("条目 {name} 使用不支持的压缩方法：{other:?}"),
                ));
            }
        }
        if let Some(mode) = file.unix_mode() {
            // S_IFLNK：符号链接在 ZIP 里靠 unix mode 表达；硬链接/reparse 无法在
            // 本容器中合法表达，解包一律新建文件（P1-02），这里只挡链接。
            if mode & 0o170_000 == 0o120_000 {
                return Err(PackageError::new(
                    "symlink_entry",
                    format!("条目是符号链接：{name}"),
                ));
            }
        }
        check_compressed_range(&file, directory_start)?;
        let is_dir = name.ends_with('/');
        validate_rel_path_ext(&name, is_dir)?;
        let lower = name.to_ascii_lowercase();
        if !seen_lower.insert(lower) {
            return Err(PackageError::new(
                "path_collides",
                format!("条目大小写折叠后冲突：{name}"),
            ));
        }
        if is_dir {
            continue;
        }
        if name == MANIFEST_PATH {
            saw_manifest = true;
            continue;
        }
        if !declared.remove(name.as_str()) {
            return Err(PackageError::new(
                "undeclared_file",
                format!("包内出现未在 files 声明的文件：{name}"),
            ));
        }
        let declared_entry = manifest
            .file(&name)
            .ok_or_else(|| PackageError::new("undeclared_file", format!("缺少声明：{name}")))?;
        check_compression_ratio(&file, declared_entry.bytes)?;
        // 流式读取：以声明字节数 + 1 为读上限，实际计数，杜绝「虚报大小」。
        let budget = declared_entry.bytes.saturating_add(1);
        let mut hasher = Sha256::new();
        let mut actual: u64 = 0;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let want = std::cmp::min(chunk.len() as u64, budget - actual) as usize;
            if want == 0 {
                break;
            }
            let read = file.read(&mut chunk[..want]).map_err(|error| {
                PackageError::new(
                    "format_unsupported",
                    format!("条目 {name} 读取失败：{error}"),
                )
            })?;
            if read == 0 {
                break;
            }
            hasher.update(&chunk[..read]);
            actual += read as u64;
        }
        if actual != declared_entry.bytes {
            return Err(PackageError::new(
                "size_mismatch",
                format!(
                    "条目 {name} 实际 {actual} 字节，声明 {} 字节",
                    declared_entry.bytes
                ),
            ));
        }
        check_compression_ratio(&file, actual)?;
        total_uncompressed = total_uncompressed
            .checked_add(actual)
            .ok_or_else(|| PackageError::new("package_too_large", "解压总量溢出"))?;
        if total_uncompressed > MAX_UNCOMPRESSED_BYTES {
            return Err(PackageError::new(
                "package_too_large",
                "解压总量超过 1 GiB 上限",
            ));
        }
        let digest = format!("{:x}", hasher.finalize());
        if digest != declared_entry.sha256 {
            return Err(PackageError::new(
                "hash_mismatch",
                format!("条目 {name} 的 SHA-256 与声明不符"),
            ));
        }
        verified.push(VerifiedEntry {
            mime: Some(declared_entry.mime.clone()),
            path: name,
            bytes: actual,
            sha256: digest,
        });
    }
    if !saw_manifest {
        return Err(PackageError::new(
            "missing_manifest",
            "包根缺少 manifest.json",
        ));
    }
    if let Some(remaining) = declared.iter().next() {
        return Err(PackageError::new(
            "missing_file",
            format!("声明文件在包内缺失：{remaining}"),
        ));
    }
    Ok(verified)
}

/// 包级压缩字节上限（§6.3 512 MiB）：供安装器在读入原始包字节前预检。
pub fn check_package_bytes(len: u64) -> Result<()> {
    if len > MAX_PACKAGE_BYTES {
        return Err(PackageError::new(
            "package_too_large",
            format!("压缩包超过 {MAX_PACKAGE_BYTES} 字节上限"),
        ));
    }
    Ok(())
}
