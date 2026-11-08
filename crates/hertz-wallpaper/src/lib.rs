// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸包合同（HWPK v1）：manifest 校验、ZIP 安全解包校验与内置资格目录。
//!
//! 本 crate 是纯数据/校验层（设计 docs/desktop-wallpaper.md §3.2）：
//! 无 Windows API、无音乐服务依赖、无联网副作用；桌面宿主与社区服务共用。
//! 上限来自设计 §6.3，是准入合同而非吞吐承诺；调整必须同步边界测试。

pub mod archive;
pub mod catalog;
pub mod json;
pub mod manifest;
pub mod media;
pub mod paths;
pub mod properties;

pub use archive::{validate_archive, validate_package, ValidatedPackage, VerifiedEntry};
pub use catalog::{catalog, CatalogContract};
pub use manifest::{
    validate_manifest_bytes, AssetDescriptor, AssetKind, Content, FileEntry, License, Manifest,
    Permissions, Variant,
};
pub use paths::validate_rel_path;
pub use properties::{
    PropertyConstraints, PropertyDescriptor, PropertyTarget, PropertyType, SelectOption,
};

/// 稳定错误码（snake_case）。调用方（设置页/安装器/社区校验器）按 code 分支，
/// message 仅用于展示；新增分支必须新增 code，不得复用旧码表达新含义。
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct PackageError {
    pub code: &'static str,
    pub message: String,
}

impl PackageError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub type Result<T> = std::result::Result<T, PackageError>;

/// 压缩包总量上限（§6.3）。
pub const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
/// 解压总量上限（§6.3）。
pub const MAX_UNCOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;
/// 文件数上限（§6.3）。
pub const MAX_FILES: usize = 2048;
/// 相对路径上限：180 个 ASCII 字符（§6.3）。
pub const MAX_PATH_BYTES: usize = 180;
/// 单资源压缩输入上限（§6.3）。vector 按「文本文件」档计；texture 参照模型档。
pub const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_VIDEO_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_MODEL_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_FONT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_TEXTURE_BYTES: u64 = MAX_MODEL_BYTES;
/// manifest 自身上限（§6.1）。
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_MANIFEST_DEPTH: usize = 16;
/// 压缩比上限（§6.3）：超过 100:1 的大条目拒绝。
pub const MAX_COMPRESSION_RATIO: u64 = 100;

/// 资源/节点等局部 id 规则（§6.1）。
pub fn valid_local_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
        && id.len() <= 64
        && id[1..]
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// 64 位小写十六进制 SHA-256（§4.1 packageHash 同规则）。
pub fn valid_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// 资源 kind 对应的单资源压缩输入上限。
pub fn kind_byte_limit(kind: AssetKind) -> u64 {
    match kind {
        AssetKind::Image => MAX_IMAGE_BYTES,
        AssetKind::Video => MAX_VIDEO_BYTES,
        AssetKind::Model => MAX_MODEL_BYTES,
        AssetKind::Font => MAX_FONT_BYTES,
        AssetKind::Vector => MAX_TEXT_BYTES,
        AssetKind::Texture => MAX_TEXTURE_BYTES,
    }
}
