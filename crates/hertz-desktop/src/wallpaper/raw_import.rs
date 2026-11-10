// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 裸媒体固定快照转为 HWPK。只在既有 ImportJobs 准备槽及内容写门内运行，
//! 不产生另一条安装管线，不读取用户源路径，也不把路径写入 manifest。

use super::assets::{AssetStore, SnapshotReceipt};
use super::jobs::JobError;
use super::library::Library;
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, Ordering};

type Result<T> = std::result::Result<T, JobError>;

pub(crate) async fn ensure_package(
    assets: &AssetStore,
    library: &Library,
    receipt: SnapshotReceipt,
    name: &str,
    cancel: &AtomicBool,
) -> Result<SnapshotReceipt> {
    let mut input = super::assets::open_immutable(&receipt.original)?;
    let mut magic = [0; 4];
    input
        .read_exact(&mut magic)
        .map_err(|error| JobError::new("format_unsupported", error.to_string()))?;
    input
        .seek(SeekFrom::Start(0))
        .map_err(|error| JobError::io(error.to_string()))?;
    if magic[..2] == *b"PK" {
        return Ok(receipt);
    }
    let mut sniff = [0u8; 256];
    let sniffed = input
        .read(&mut sniff)
        .map_err(|e| JobError::io(e.to_string()))?;
    input
        .seek(SeekFrom::Start(0))
        .map_err(|e| JobError::io(e.to_string()))?;
    let prefix = &sniff[..sniffed];
    let prefix = prefix.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(prefix);
    let is_xml = prefix.iter().copied().find(|b| !b.is_ascii_whitespace()) == Some(b'<');
    let svg = if is_xml {
        if receipt.bytes > super::svg_prepare::MAX_BYTES {
            return Err(JobError::new(
                "svg_complexity_exceeded",
                "SVG 原稿超过 4 MiB",
            ));
        }
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut input)
            .take(super::svg_prepare::MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| JobError::io(e.to_string()))?;
        Some(super::svg_prepare::inspect(&bytes)?)
    } else {
        None
    };
    let (kind, extension, mime) = if svg.is_some() {
        ("vector", "svg", "image/svg+xml")
    } else {
        let metadata = super::media::probe(&mut input)
            .map_err(|error| JobError::new(error.code, error.message))?;
        match metadata.container {
            super::media::Container::Mp4 => ("video", "mp4", "video/mp4"),
            super::media::Container::Webm => ("video", "webm", "video/webm"),
            super::media::Container::Image => match metadata.codec.as_str() {
                "png" => ("image", "png", "image/png"),
                "jpeg" => ("image", "jpg", "image/jpeg"),
                "webp" => ("image", "webp", "image/webp"),
                _ => {
                    return Err(JobError::new(
                        "format_unsupported",
                        "图片导入支持 PNG、JPEG 和 WebP",
                    ))
                }
            },
        }
    };
    let kind_limit = if kind == "vector" {
        super::svg_prepare::MAX_BYTES
    } else if kind == "image" {
        hertz_wallpaper::MAX_IMAGE_BYTES
    } else {
        hertz_wallpaper::MAX_VIDEO_BYTES
    };
    if receipt.bytes > kind_limit {
        return Err(JobError::new(
            "asset_too_large",
            "媒体文件超过该类型的字节上限",
        ));
    }
    // 生成包的 manifest/ZIP 目录有确定的小上界；写入时仍检查真正的总长度。
    let maximum = receipt
        .bytes
        .checked_add(16 * 1024)
        .ok_or_else(|| JobError::invalid_input("媒体大小溢出"))?;
    hertz_wallpaper::archive::check_package_bytes(maximum)?;
    assets.check_disk_space(maximum)?;
    let mut id = receipt.sha256[..32].to_string();
    id.replace_range(12..13, "5");
    id.replace_range(16..17, "8");
    let work_id = format!(
        "{}-{}-{}-{}-{}",
        &id[..8],
        &id[8..12],
        &id[12..16],
        &id[16..20],
        &id[20..]
    );
    let path = format!("assets/background.{extension}");
    let document=svg.as_ref().map(|facts| {
        let ratio=(4096.0/facts.width.max(facts.height)).min(1.0);
        serde_json::to_vec(&serde_json::json!({"documentVersion":1,"canvas":{"width":(facts.width*ratio).ceil().max(1.0) as u32,"height":(facts.height*ratio).ceil().max(1.0) as u32,"colorSpace":"srgb","background":"#000000"},
            "nodes":[{"id":"background","type":"image","stateVersion":1,"assets":{"asset":"background"},"properties":{"x":0,"y":0,"width":(facts.width*ratio).ceil().max(1.0) as u32,"height":(facts.height*ratio).ceil().max(1.0) as u32,"anchorX":0,"anchorY":0,"fit":"contain"}}],
            "timeline":{"durationSeconds":1,"loop":true,"tracks":[]},"bindings":[]})).map_err(|e|JobError::invalid_input(e.to_string()))
    }).transpose()?;
    let mut files = vec![
        serde_json::json!({"path":path,"bytes":receipt.bytes,"sha256":receipt.sha256,"mime":mime}),
    ];
    if let Some(bytes) = &document {
        files.push(serde_json::json!({"path":"document.json","bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":"application/json"}));
    }
    let manifest = if let Some(previous) = library.local_manifest(&work_id).await? {
        let parsed: hertz_wallpaper::Manifest = serde_json::from_str(&previous)
            .map_err(|error| JobError::database(error.to_string()))?;
        if serde_json::to_value(&parsed.files).map_err(|e| JobError::database(e.to_string()))?
            != serde_json::Value::Array(files.clone())
        {
            return Err(JobError::hash_conflict("媒体身份已绑定其他字节"));
        }
        previous
    } else {
        let title: String = std::path::Path::new(name)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("本地壁纸")
            .chars()
            .filter(|ch| !ch.is_control())
            .take(120)
            .collect();
        let title = if title.trim().is_empty() {
            "本地壁纸"
        } else {
            title.trim()
        };
        let manifest: hertz_wallpaper::Manifest = serde_json::from_value(serde_json::json!({
            "formatVersion":1,"workId":work_id,"version":1,"title":title,"description":"",
            "content":if document.is_some(){serde_json::json!({"kind":"composition","document":"document.json"})}else{serde_json::json!({"kind":kind,"asset":"background"})},
            "assets":[{"id":"background","kind":kind,"source":path,"variants":[]}],
            "files":files,
            "properties":[],"permissions":{"audioSpectrum":false,"pointer":false},
            "license":{"code":"none","assets":"none","attribution":""}
        }))
        .map_err(|error| JobError::invalid_input(error.to_string()))?;
        serde_json::to_string(&manifest)
            .map_err(|error| JobError::invalid_input(error.to_string()))?
    };
    cancelled(cancel)?;
    let target_path = receipt.original.with_file_name("wrapped.hwpkg");
    let target = std::fs::OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(&target_path)
        .map_err(|error| JobError::io(error.to_string()))?;
    let mut archive = zip::ZipWriter::new(BoundedFile(target));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    archive
        .start_file("manifest.json", options)
        .map_err(|error| JobError::io(error.to_string()))?;
    archive
        .write_all(manifest.as_bytes())
        .map_err(|error| JobError::io(error.to_string()))?;
    if let Some(bytes) = &document {
        archive
            .start_file("document.json", options)
            .map_err(|e| JobError::io(e.to_string()))?;
        archive
            .write_all(bytes)
            .map_err(|e| JobError::io(e.to_string()))?;
    }
    archive
        .start_file(&path, options)
        .map_err(|error| JobError::io(error.to_string()))?;
    input
        .seek(SeekFrom::Start(0))
        .map_err(|error| JobError::io(error.to_string()))?;
    let mut buffer = [0u8; 256 * 1024];
    loop {
        cancelled(cancel)?;
        let count = input
            .read(&mut buffer)
            .map_err(|error| JobError::io(error.to_string()))?;
        if count == 0 {
            break;
        }
        archive
            .write_all(&buffer[..count])
            .map_err(|error| JobError::io(error.to_string()))?;
    }
    let mut target = archive
        .finish()
        .map_err(|error| JobError::io(error.to_string()))?
        .0;
    target
        .sync_all()
        .map_err(|error| JobError::io(error.to_string()))?;
    target
        .seek(SeekFrom::Start(0))
        .map_err(|error| JobError::io(error.to_string()))?;
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    loop {
        cancelled(cancel)?;
        let count = target
            .read(&mut buffer)
            .map_err(|error| JobError::io(error.to_string()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        bytes += count as u64;
    }
    drop(target);
    drop(input);
    cancelled(cancel)?;
    std::fs::remove_file(&receipt.original).map_err(|error| JobError::io(error.to_string()))?;
    std::fs::rename(target_path, &receipt.original)
        .map_err(|error| JobError::io(error.to_string()))?;
    Ok(SnapshotReceipt {
        bytes,
        sha256: format!("{:x}", digest.finalize()),
        ..receipt
    })
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(JobError::new("cancelled", "导入已被取消"))
    } else {
        Ok(())
    }
}

struct BoundedFile(std::fs::File);
impl Write for BoundedFile {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let position = self.0.stream_position()?;
        if bytes.len() as u64 > hertz_wallpaper::MAX_PACKAGE_BYTES.saturating_sub(position) {
            return Err(std::io::Error::other("生成的壁纸包超过字节上限"));
        }
        self.0.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}
impl Seek for BoundedFile {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.0.seek(position)
    }
}
