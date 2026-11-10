// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸资产存储（设计 docs/desktop-wallpaper.md §4.2/§7.1/§7.2）。
//!
//! 目录（root = 桌面状态根，测试/便携经 HERTZ_DESKTOP_CONFIG_DIR 整体重定向）：
//! `packages/<packageHash>/{original.hwpkg, files/, receipt.json}`、
//! `staging/<jobId>/`、`derived/<inputHash>/…`。复制进不可变包，P1 不引用
//! 原路径；已安装作品永不重新打开用户源文件。

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::wallpaper::jobs::JobError;

/// 模块内 Result 别名：错误固定为 JobError（遮蔽 prelude 双参 Result）。
type Result<T> = std::result::Result<T, JobError>;

/// staging 快照回执：后续所有检查只读这份固定输入。
#[derive(Debug, Clone)]
pub struct SnapshotReceipt {
    pub job_id: String,
    pub original: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

/// 校验通过的暂存包（字节事实 + manifest 事实）。
#[derive(Debug, Clone)]
pub struct StagedPackage {
    pub package_hash: String,
    pub manifest: hertz_wallpaper::manifest::Manifest,
    pub manifest_json: String,
    pub entries: Vec<hertz_wallpaper::VerifiedEntry>,
}

/// 已安装包的可核验事实（receipt.json + original.hwpkg 快速核对）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledReceipt {
    pub package_hash: String,
    pub installed_at: i64,
    pub entries: Vec<hertz_wallpaper::VerifiedEntry>,
}

pub struct AssetStore {
    root: PathBuf,
    content_capacity: u64,
    _root_owner: Arc<crate::root_owner::RootOwner>,
}

/// 核验缓存持有只读、拒绝写入/删除共享的句柄；命中时字节身份不能变化。
pub(crate) struct PinnedMedia {
    pub(crate) entry: hertz_wallpaper::VerifiedEntry,
    pub(crate) path: PathBuf,
    _package_pin: Option<std::fs::File>,
    _file_pin: std::fs::File,
    // 派生输入的目录租约随所有 Broker/流持有者退出，不能随准备描述符提前归还。
    _derived_lease: Option<Arc<std::fs::File>>,
    _root_owner: Arc<crate::root_owner::RootOwner>,
}

/// 结构与摘要已复核，真实解码期间持续固定这份字节。
#[derive(Clone)]
pub(crate) struct DecodeInput {
    pub(crate) package_hash: String,
    pub(crate) media: Arc<PinnedMedia>,
    pub(crate) metadata: super::media::MediaProbe,
}

impl AssetStore {
    pub fn new(root: &Path) -> Result<Self> {
        let root_owner = crate::wallpaper_upgrade::admit_config(root)
            .map_err(|error| JobError::database(format!("{error:#}")))?;
        std::fs::create_dir_all(root.join("packages"))
            .and_then(|_| std::fs::create_dir_all(root.join("staging")))
            .and_then(|_| std::fs::create_dir_all(root.join("derived")))
            .map_err(|error| JobError::io(format!("创建资产目录失败：{error}")))?;
        Ok(Self {
            root: root.to_path_buf(),
            content_capacity: super::content_quota::CAP,
            _root_owner: root_owner,
        })
    }

    pub(crate) fn content_writer(&self) -> Result<super::content_quota::Writer<'_>> {
        super::content_quota::Writer::acquire(self)
    }

    pub(crate) fn content_capacity(&self) -> u64 {
        self.content_capacity
    }

    #[cfg(any(test, all(debug_assertions, feature = "wallpaper-media-probe")))]
    pub(crate) fn with_content_capacity(mut self, bytes: u64) -> Self {
        self.content_capacity = bytes.min(super::content_quota::CAP);
        self
    }

    pub(crate) fn staging_dir(&self, job_id: &str) -> PathBuf {
        self.root.join("staging").join(job_id)
    }

    pub fn package_dir(&self, package_hash: &str) -> PathBuf {
        self.root.join("packages").join(package_hash)
    }

    /// 删除已卸载的不可变包目录。调用方必须先确认没有配置/草稿/预览引用，
    /// 并在整个操作期间持有内容写门；活动读者会让删除失败而不是静默留下半包。
    pub(crate) async fn remove_installed(&self, package_hash: &str) -> Result<()> {
        if package_hash.len() != 64 || !package_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(JobError::invalid_input("包 hash 格式无效"));
        }
        match tokio::fs::remove_dir_all(self.package_dir(package_hash)).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(JobError::new(
                "asset_in_use",
                format!("包目录仍被占用，删除未完成：{error}"),
            )),
        }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Export reads the original bytes through one fixed native handle.
    pub(crate) fn open_installed_original(&self, package_hash: &str) -> Result<std::fs::File> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        if !hertz_wallpaper::valid_sha256_hex(package_hash) {
            return Err(JobError::invalid_input("包 hash 格式无效"));
        }
        let file = std::fs::File::options()
            .read(true)
            .share_mode(1)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(self.package_dir(package_hash).join("original.hwpkg"))
            .map_err(|_| JobError::new("package_unavailable", "已安装的原始壁纸包不可读"))?;
        let metadata = file
            .metadata()
            .map_err(|error| JobError::io(error.to_string()))?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(JobError::new(
                "package_unavailable",
                "原始壁纸包不是普通文件",
            ));
        }
        hertz_wallpaper::archive::check_package_bytes(metadata.len())?;
        Ok(file)
    }

    /// A native output capability must not write back into managed storage.
    pub(crate) fn is_path_within_root(&self, path: &Path) -> Result<bool> {
        let parent = path
            .parent()
            .ok_or_else(|| JobError::invalid_input("导出路径缺少目录"))?;
        let root =
            std::fs::canonicalize(&self.root).map_err(|error| JobError::io(error.to_string()))?;
        let parent =
            std::fs::canonicalize(parent).map_err(|error| JobError::io(error.to_string()))?;
        let root = root.to_string_lossy().to_lowercase();
        let parent = parent.to_string_lossy().to_lowercase();
        Ok(parent == root || parent.starts_with(&format!("{}\\", root.trim_end_matches('\\'))))
    }

    pub(crate) fn pin_prepared(
        &self,
        input: &DecodeInput,
        path: PathBuf,
        entry: hertz_wallpaper::VerifiedEntry,
        lease: Option<Arc<std::fs::File>>,
    ) -> Result<DecodeInput> {
        self.pin_derived(
            &input.package_hash,
            input
                .media
                ._package_pin
                .as_ref()
                .map(std::fs::File::try_clone)
                .transpose()
                .map_err(|error| JobError::io(error.to_string()))?,
            path,
            entry,
            lease,
        )
    }

    /// Fixed vector/font source bytes; these are never raster DecodeInput facts.
    pub(crate) fn pin_source_entry(
        &self,
        package: &StagedPackage,
        entry: &hertz_wallpaper::VerifiedEntry,
        staging_job: Option<&str>,
    ) -> Result<Arc<PinnedMedia>> {
        let directory = staging_job.map_or_else(
            || self.package_dir(&package.package_hash),
            |job| self.staging_dir(job),
        );
        let mut original = open_immutable(&directory.join("original.hwpkg"))?;
        let mut digest = Sha256::new();
        std::io::copy(&mut original, &mut digest).map_err(|e| JobError::io(e.to_string()))?;
        if format!("{:x}", digest.finalize()) != package.package_hash {
            return Err(JobError::new("hash_mismatch", "准备前固定原包发生变化"));
        }
        if !package.entries.iter().any(|v| {
            v.path == entry.path
                && v.sha256 == entry.sha256
                && v.bytes == entry.bytes
                && v.mime == entry.mime
        }) {
            return Err(JobError::new("hash_mismatch", "准备条目不属于已核验包"));
        }
        let path = directory.join("files").join(&entry.path);
        let mut file = open_immutable(&path)?;
        if file
            .metadata()
            .map_err(|e| JobError::io(e.to_string()))?
            .len()
            != entry.bytes
        {
            return Err(JobError::new("hash_mismatch", "准备源大小发生变化"));
        }
        let mut digest = Sha256::new();
        let bytes =
            std::io::copy(&mut file, &mut digest).map_err(|e| JobError::io(e.to_string()))?;
        if bytes != entry.bytes || format!("{:x}", digest.finalize()) != entry.sha256 {
            return Err(JobError::new("hash_mismatch", "准备源哈希发生变化"));
        }
        Ok(Arc::new(PinnedMedia {
            entry: entry.clone(),
            path,
            _package_pin: Some(original),
            _file_pin: file,
            _derived_lease: None,
            _root_owner: Arc::clone(&self._root_owner),
        }))
    }

    pub(crate) fn pin_svg_png(
        &self,
        package_hash: &str,
        source: &PinnedMedia,
        path: PathBuf,
        entry: hertz_wallpaper::VerifiedEntry,
        lease: Option<Arc<std::fs::File>>,
    ) -> Result<DecodeInput> {
        self.pin_derived(
            package_hash,
            source
                ._package_pin
                .as_ref()
                .map(std::fs::File::try_clone)
                .transpose()
                .map_err(|e| JobError::io(e.to_string()))?,
            path,
            entry,
            lease,
        )
    }

    /// A verified cached JPEG can outlive its original video. It never grants access to that video.
    pub(super) fn pin_poster(
        &self,
        package_hash: &str,
        path: PathBuf,
        entry: hertz_wallpaper::VerifiedEntry,
        lease: Arc<std::fs::File>,
    ) -> Result<DecodeInput> {
        if !hertz_wallpaper::valid_sha256_hex(package_hash)
            || entry.mime.as_deref() != Some("image/jpeg")
            || entry.bytes > 24 * 1024
        {
            return Err(JobError::invalid_input("静态封面身份或大小无效"));
        }
        self.pin_derived(package_hash, None, path, entry, Some(lease))
    }

    fn pin_derived(
        &self,
        package_hash: &str,
        package_pin: Option<std::fs::File>,
        path: PathBuf,
        entry: hertz_wallpaper::VerifiedEntry,
        lease: Option<Arc<std::fs::File>>,
    ) -> Result<DecodeInput> {
        let file = open_immutable(&path)?;
        if file
            .metadata()
            .map_err(|error| JobError::io(error.to_string()))?
            .len()
            != entry.bytes
        {
            return Err(JobError::new("hash_mismatch", "派生图固定前大小发生变化"));
        }
        let mut reader = file
            .try_clone()
            .map_err(|error| JobError::io(error.to_string()))?;
        let mut digest = Sha256::new();
        let bytes = std::io::copy(
            &mut (&mut reader).take(entry.bytes.saturating_add(1)),
            &mut digest,
        )
        .map_err(|error| JobError::io(error.to_string()))?;
        if bytes != entry.bytes || format!("{:x}", digest.finalize()) != entry.sha256 {
            return Err(JobError::new("hash_mismatch", "派生图固定前字节发生变化"));
        }
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|error| JobError::io(error.to_string()))?;
        let metadata = super::media::probe(&mut reader)
            .map_err(|error| JobError::new(error.code, error.message))?;
        Ok(DecodeInput {
            package_hash: package_hash.to_string(),
            metadata,
            media: Arc::new(PinnedMedia {
                _root_owner: Arc::clone(&self._root_owner),
                entry,
                path,
                _package_pin: package_pin,
                _file_pin: file,
                _derived_lease: lease,
            }),
        })
    }

    /// ① 固定输入快照（§7.1 Probe 第一道）：以只读共享句柄打开源文件——
    /// 不授予写共享，任何并发写者在打开阶段即被拒绝；流式复制进
    /// `staging/<jobId>/original.hwpkg` 并计算 SHA-256。此后源文件移动/删除
    /// 不影响本任务。`cancel` 在复制循环内检查；取消仍等待在途 I/O 退出。
    pub fn snapshot_input(
        &self,
        job_id: &str,
        source: &Path,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<SnapshotReceipt> {
        use std::os::windows::fs::OpenOptionsExt;
        let source_file = std::fs::OpenOptions::new()
            .read(true)
            // 只共享读（FILE_SHARE_READ）：打开期间任何写入者都会撞
            // sharing violation（§7.1「句柄打开时拒绝并发写入」）。
            .share_mode(0x0000_0001)
            .open(source)
            .map_err(|error| {
                let raw = error.raw_os_error().unwrap_or(0);
                if raw == 32 {
                    JobError::new(
                        "source_busy",
                        format!(
                            "源文件正被其它进程写入，已拒绝并发读取：{}",
                            source.display()
                        ),
                    )
                } else {
                    JobError::io(format!("打开导入源失败：{error}"))
                }
            })?;
        self.snapshot_open_file(job_id, &source_file, cancel)
    }

    /// fileToken 已固定的只读文件；不再按路径重新打开，避免选择到受理之间换文件。
    pub(crate) fn snapshot_open_file(
        &self,
        job_id: &str,
        source_file: &std::fs::File,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<SnapshotReceipt> {
        use std::sync::atomic::Ordering;
        let source_bytes = source_file
            .metadata()
            .map_err(|error| JobError::io(format!("读取源大小失败：{error}")))?
            .len();
        hertz_wallpaper::archive::check_package_bytes(source_bytes)?;
        self.check_disk_space(source_bytes)?;
        let staging = self.staging_dir(job_id);
        std::fs::create_dir_all(&staging)
            .map_err(|error| JobError::io(format!("创建 staging 目录失败：{error}")))?;
        let mut reader = std::io::BufReader::with_capacity(256 * 1024, source_file);
        let target_path = staging.join("original.hwpkg");
        let target = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target_path)
            .map_err(|error| JobError::io(format!("创建快照失败：{error}")))?;
        let mut writer = std::io::BufWriter::new(target);
        let mut hasher = Sha256::new();
        let mut bytes: u64 = 0;
        let mut chunk = [0u8; 256 * 1024];
        loop {
            if let Some(cancel) = cancel {
                if cancel.load(Ordering::Relaxed) {
                    return Err(JobError::new("cancelled", "导入已被取消"));
                }
            }
            let read = reader
                .read(&mut chunk)
                .map_err(|error| JobError::io(format!("读取导入源失败：{error}")))?;
            if read == 0 {
                break;
            }
            hertz_wallpaper::archive::check_package_bytes(bytes + read as u64)?;
            hasher.update(&chunk[..read]);
            std::io::Write::write_all(&mut writer, &chunk[..read])
                .map_err(|error| JobError::io(format!("写入快照失败：{error}")))?;
            bytes += read as u64;
        }
        std::io::Write::flush(&mut writer)
            .and_then(|_| {
                let file = writer.into_inner().map_err(|error| error.into_error())?;
                file.sync_all()
            })
            .map_err(|error| JobError::io(format!("快照落盘失败：{error}")))?;
        Ok(SnapshotReceipt {
            job_id: job_id.to_string(),
            original: target_path,
            bytes,
            sha256: format!("{:x}", hasher.finalize()),
        })
    }

    /// ② 对固定快照执行完整包校验（P1-01 合同）并取回 manifest 事实。
    pub fn validate_staged(&self, job_id: &str) -> Result<StagedPackage> {
        let original = self.staging_dir(job_id).join("original.hwpkg");
        let mut file = open_immutable(&original)?;
        hertz_wallpaper::archive::check_package_bytes(
            file.metadata()
                .map_err(|error| JobError::io(error.to_string()))?
                .len(),
        )?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher)
            .map_err(|error| JobError::io(format!("读取快照失败：{error}")))?;
        let package_hash = format!("{:x}", hasher.finalize());
        let package = hertz_wallpaper::validate_package(file)?;
        let manifest_json = serde_json::to_string(&package.manifest)
            .map_err(|error| JobError::io(format!("manifest 再序列化失败：{error}")))?;
        Ok(StagedPackage {
            package_hash,
            manifest: package.manifest,
            manifest_json,
            entries: package.entries,
        })
    }

    /// 复核摘要与容器真值并固定字节；返回值必须交给 ProbeClient 完成真实解码。
    pub(crate) fn probe_staged_media(
        &self,
        job_id: &str,
        package: &StagedPackage,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<Vec<DecodeInput>> {
        self.probe_media_at(&self.staging_dir(job_id).join("files"), package, cancel)
    }

    pub(crate) fn probe_installed_media(
        &self,
        package: &StagedPackage,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<Vec<DecodeInput>> {
        self.probe_media_at(
            &self.package_dir(&package.package_hash).join("files"),
            package,
            cancel,
        )
    }

    fn probe_media_at(
        &self,
        files: &Path,
        package: &StagedPackage,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<Vec<DecodeInput>> {
        use super::media::{probe, Container};
        use hertz_wallpaper::manifest::AssetKind;
        let mut original =
            open_immutable(&files.parent().expect("package root").join("original.hwpkg"))?;
        hertz_wallpaper::archive::check_package_bytes(
            original
                .metadata()
                .map_err(|error| JobError::io(error.to_string()))?
                .len(),
        )?;
        let mut hash = Sha256::new();
        std::io::copy(&mut original, &mut hash).map_err(|error| JobError::io(error.to_string()))?;
        if format!("{:x}", hash.finalize()) != package.package_hash {
            return Err(JobError::new("hash_mismatch", "探测前固定原包字节已变化"));
        }
        let mut inputs = Vec::new();
        let mut checked = std::collections::HashSet::new();
        for asset in &package.manifest.assets {
            if !matches!(asset.kind, AssetKind::Image | AssetKind::Video) {
                continue;
            }
            for path in std::iter::once(asset.source.as_str())
                .chain(asset.variants.iter().map(|variant| variant.file.as_str()))
            {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err(JobError::new("cancelled", "媒体探测已取消"));
                }
                if !checked.insert((path, asset.kind == AssetKind::Image)) {
                    continue;
                }
                let mut file = open_immutable(&files.join(path))?;
                let entry = package
                    .entries
                    .iter()
                    .find(|entry| entry.path == path)
                    .ok_or_else(|| JobError::new("package_invalid", "媒体路径未校验"))?;
                if asset.kind == AssetKind::Image && entry.bytes > 32 * 1024 * 1024 {
                    return Err(JobError::new(
                        "probe_budget_exceeded",
                        format!("{path}: 图片压缩字节超过 32 MiB"),
                    ));
                }
                if file
                    .metadata()
                    .map_err(|error| JobError::io(error.to_string()))?
                    .len()
                    != entry.bytes
                {
                    return Err(JobError::new(
                        "hash_mismatch",
                        format!("{path}: 探测前投影大小已变化"),
                    ));
                }
                let mut hash = Sha256::new();
                let bytes = std::io::copy(&mut file, &mut hash)
                    .map_err(|error| JobError::io(error.to_string()))?;
                if bytes != entry.bytes || format!("{:x}", hash.finalize()) != entry.sha256 {
                    return Err(JobError::new(
                        "hash_mismatch",
                        format!("{path}: 探测前投影字节已变化"),
                    ));
                }
                file.seek(SeekFrom::Start(0))
                    .map_err(|error| JobError::io(error.to_string()))?;
                let metadata = probe(&mut file).map_err(|error| {
                    JobError::new(error.code, format!("{path}: {}", error.message))
                })?;
                if (asset.kind == AssetKind::Image) != (metadata.container == Container::Image) {
                    return Err(JobError::new(
                        "format_unsupported",
                        format!("{path}: 媒体真值与 asset.kind 不一致"),
                    ));
                }
                let expected_mime = match metadata.container {
                    Container::Mp4 => "video/mp4".to_string(),
                    Container::Webm => "video/webm".to_string(),
                    Container::Image => format!("image/{}", metadata.codec),
                };
                if package
                    .manifest
                    .files
                    .iter()
                    .find(|file| file.path == path)
                    .is_none_or(|file| file.mime != expected_mime)
                {
                    return Err(JobError::new(
                        "format_unsupported",
                        format!("{path}: MIME 与实际容器不一致（{expected_mime}）"),
                    ));
                }
                inputs.push(DecodeInput {
                    package_hash: package.package_hash.clone(),
                    metadata,
                    media: Arc::new(PinnedMedia {
                        _root_owner: Arc::clone(&self._root_owner),
                        entry: entry.clone(),
                        path: files.join(path),
                        _package_pin: Some(
                            original
                                .try_clone()
                                .map_err(|error| JobError::io(error.to_string()))?,
                        ),
                        _file_pin: file,
                        _derived_lease: None,
                    }),
                });
            }
        }
        Ok(inputs)
    }

    /// ③ 空间预检：剩余空间应覆盖后续新增写入及余量，现有 staging 已计入占用。
    pub fn check_disk_space(&self, required: u64) -> Result<()> {
        // free 已扣除了所有现存 staging；只申请此后还要写入的字节。
        let need = required;
        let free = free_disk_bytes(&self.root)?;
        // 余量取 64 MiB 下限：DB、WAL 与收据等簿记不在精确预测内。
        const SLACK: u64 = 64 * 1024 * 1024;
        if free < need.saturating_add(SLACK) {
            return Err(JobError::new(
                "disk_full",
                format!("磁盘剩余 {free} 字节不足（需要 {need} + 余量）"),
            ));
        }
        Ok(())
    }

    /// ④ 投影解包：files/ 只包含已声明路径（校验器已排除未声明条目）。
    pub fn unpack_projection(&self, job_id: &str, package: &StagedPackage) -> Result<()> {
        let original = self.staging_dir(job_id).join("original.hwpkg");
        let files_dir = self.staging_dir(job_id).join("files");
        std::fs::create_dir_all(&files_dir)
            .map_err(|error| JobError::io(format!("创建投影目录失败：{error}")))?;
        let mut archive = zip::ZipArchive::new(
            std::fs::File::open(&original)
                .map_err(|error| JobError::io(format!("重新打开快照失败：{error}")))?,
        )
        .map_err(|error| JobError::new("package_invalid", format!("快照不是合法 ZIP：{error}")))?;
        for entry in &package.entries {
            let mut reader = archive.by_name(&entry.path).map_err(|error| {
                JobError::new("package_invalid", format!("投影条目缺失：{error}"))
            })?;
            let target = files_dir.join(&entry.path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| JobError::io(format!("创建投影父目录失败：{error}")))?;
            }
            let mut file = std::fs::File::create(&target)
                .map_err(|error| JobError::io(format!("创建投影文件失败：{error}")))?;
            let entry_path = entry.path.clone();
            std::io::copy(&mut reader, &mut file)
                .map_err(|error| JobError::io(format!("解包条目失败：{entry_path}: {error}")))?;
            file.sync_all().map_err(|error| {
                JobError::io(format!("投影条目落盘失败：{entry_path}: {error}"))
            })?;
        }
        // ⑤ 收据：核验事实落盘（§4.2 packages 的本机验证收据）。
        let receipt_path = self.staging_dir(job_id).join("receipt.json");
        let receipt_bytes = self.projection_receipt_bytes(package)?;
        let mut file = std::fs::File::create(&receipt_path)
            .map_err(|error| JobError::io(format!("创建收据失败：{error}")))?;
        std::io::Write::write_all(&mut file, &receipt_bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| JobError::io(format!("写入收据失败：{error}")))?;
        Ok(())
    }

    pub(crate) fn projection_receipt_bytes(&self, package: &StagedPackage) -> Result<Vec<u8>> {
        serde_json::to_vec_pretty(&InstalledReceipt {
            package_hash: package.package_hash.clone(),
            installed_at: crate::wallpaper::library::now_secs(),
            entries: package.entries.clone(),
        })
        .map_err(|error| JobError::io(format!("收据序列化失败：{error}")))
    }

    /// 去重路径：同 hash 已安装时丢弃 staging（幂等导入不产生第二份物理包）。
    pub fn discard_staging(&self, job_id: &str) {
        let _ = std::fs::remove_dir_all(self.staging_dir(job_id));
    }

    /// 取消/失败后的 staging 清理（真实 I/O 已退出才调用）。
    pub fn cleanup_staging(&self, job_id: &str) {
        self.discard_staging(job_id);
    }

    /// 已安装包核验：原包验证结果是路径/MIME/摘要真值，投影逐文件核对 SHA-256。
    /// 返回 Some(收据) 表示目录与 original.hwpkg 完整可核验。
    pub fn verify_installed(&self, package_hash: &str) -> Result<Option<InstalledReceipt>> {
        let dir = self.package_dir(package_hash);
        let original = dir.join("original.hwpkg");
        if !dir.is_dir() || !original.is_file() {
            return Ok(None);
        }
        let mut hasher = Sha256::new();
        let mut file = open_immutable(&original)?;
        hertz_wallpaper::archive::check_package_bytes(
            file.metadata()
                .map_err(|error| JobError::io(error.to_string()))?
                .len(),
        )?;
        std::io::copy(&mut file, &mut hasher)
            .map_err(|error| JobError::io(format!("核对 original.hwpkg 失败：{error}")))?;
        if format!("{:x}", hasher.finalize()) != package_hash {
            return Ok(None);
        }
        let receipt_path = dir.join("receipt.json");
        if !receipt_path.is_file() {
            return Ok(None);
        }
        // 收据只提供安装时间，路径、MIME 和摘要以原包验证结果为准。
        let mut receipt_bytes = Vec::new();
        open_immutable(&receipt_path)?
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut receipt_bytes)
            .map_err(|error| JobError::io(format!("读取收据失败：{error}")))?;
        if receipt_bytes.len() > 2 * 1024 * 1024 {
            return Ok(None);
        }
        let Ok(mut receipt) = serde_json::from_slice::<InstalledReceipt>(&receipt_bytes) else {
            return Ok(None);
        };
        if receipt.package_hash != package_hash {
            return Ok(None);
        }
        let package = hertz_wallpaper::validate_package(file)?;
        for entry in &package.entries {
            let path = dir.join("files").join(&entry.path);
            let Ok(mut projection) = open_immutable(&path) else {
                return Ok(None);
            };
            if projection
                .metadata()
                .map_err(|error| JobError::io(error.to_string()))?
                .len()
                != entry.bytes
            {
                return Ok(None);
            }
            let mut digest = Sha256::new();
            std::io::copy(&mut projection, &mut digest)
                .map_err(|error| JobError::io(format!("核对投影失败：{error}")))?;
            if format!("{:x}", digest.finalize()) != entry.sha256 {
                return Ok(None);
            }
        }
        receipt.entries = package.entries;
        Ok(Some(receipt))
    }

    pub(crate) fn pin_verified_media(&self, hash: &str, path: &str) -> Result<Option<PinnedMedia>> {
        let original = open_immutable(&self.package_dir(hash).join("original.hwpkg"))?;
        let path_buf = self.package_dir(hash).join("files").join(path);
        let projection = open_immutable(&path_buf)?;
        let Some(receipt) = self.verify_installed(hash)? else {
            return Ok(None);
        };
        let Some(entry) = receipt.entries.into_iter().find(|entry| entry.path == path) else {
            return Ok(None);
        };
        Ok(Some(PinnedMedia {
            _root_owner: Arc::clone(&self._root_owner),
            entry,
            path: path_buf,
            _package_pin: Some(original),
            _file_pin: projection,
            _derived_lease: None,
        }))
    }

    /// 进程级媒体流槽池（§8.1 总并发 8）。
    pub(crate) fn stream_pool(&self) -> &'static Arc<super::media_stream::StreamSlotPool> {
        super::media_stream::global_pool()
    }

    /// packages/ 下的全部 hash 目录名。
    pub fn package_dirs(&self) -> Vec<String> {
        let mut hashes = Vec::new();
        if let Ok(entries) = std::fs::read_dir(self.root.join("packages")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if entry.path().is_dir()
                    && name.len() == 64
                    && name.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    hashes.push(name.to_ascii_lowercase());
                }
            }
        }
        hashes
    }

    /// 读取已安装包的 manifest（启动恢复入库用）。
    pub fn read_installed_manifest(&self, package_hash: &str) -> Result<StagedPackage> {
        let original = self.package_dir(package_hash).join("original.hwpkg");
        let package = hertz_wallpaper::validate_package(open_immutable(&original)?)?;
        let manifest_json = serde_json::to_string(&package.manifest)
            .map_err(|error| JobError::io(format!("manifest 再序列化失败：{error}")))?;
        Ok(StagedPackage {
            package_hash: package_hash.to_string(),
            manifest: package.manifest,
            manifest_json,
            entries: package.entries,
        })
    }

    /// 已安装包的 original.hwpkg 字节数。
    pub fn installed_bytes(&self, package_hash: &str) -> Result<u64> {
        let meta = std::fs::metadata(self.package_dir(package_hash).join("original.hwpkg"))
            .map_err(|error| JobError::io(format!("读取包大小失败：{error}")))?;
        Ok(meta.len())
    }
}

pub(super) fn open_immutable(path: &Path) -> Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(path)
        .map_err(|error| JobError::io(format!("打开只读资产失败：{error}")))
}

/// 剩余磁盘空间（Windows）。
fn free_disk_bytes(root: &Path) -> Result<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = root
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    let ok =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_to_caller, &mut total, &mut free) };
    if ok == 0 {
        return Err(JobError::io("查询磁盘剩余空间失败"));
    }
    Ok(free_to_caller)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::library::tempfileish;

    fn sample_package() -> Vec<u8> {
        // §6.1 文档 fixture：1×1 PNG（70 字节，哈希固定）。
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==")
            .unwrap();
        assert_eq!(png.len(), 70);
        let sha = format!("{:x}", Sha256::digest(&png));
        let manifest = format!(
            r#"{{"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,
                "title":"静夜","description":"","content":{{"kind":"image","asset":"background"}},
                "assets":[{{"id":"background","kind":"image","source":"assets/background.png","variants":[]}}],
                "files":[{{"path":"assets/background.png","bytes":70,"sha256":"{sha}","mime":"image/png"}}],
                "properties":[],"permissions":{{"audioSpectrum":false,"pointer":false}},
                "license":{{"code":"none","assets":"CC0-1.0","attribution":""}}}}"#
        );
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            writer
                .start_file("manifest.json", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut writer, manifest.as_bytes()).unwrap();
            writer
                .start_file(
                    "assets/background.png",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            std::io::Write::write_all(&mut writer, &png).unwrap();
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    fn store(tag: &str) -> (AssetStore, tempfileish::TempDir) {
        let dir = tempfileish::temp_dir(tag);
        let store = AssetStore::new(dir.path()).unwrap();
        (store, dir)
    }

    fn write_source(dir: &tempfileish::TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn snapshot_rejects_concurrent_writer_and_copies_exactly() {
        let (store, dir) = store("snapshot");
        let bytes = sample_package();
        let source = write_source(&dir, "src.hwpkg", &bytes);
        let receipt = store.snapshot_input("job-1", &source, None).unwrap();
        assert_eq!(receipt.bytes, bytes.len() as u64);
        assert_eq!(receipt.sha256, format!("{:x}", Sha256::digest(&bytes)));
        // 句柄拒写：独占写打开期间，快照必须得到 source_busy。
        use std::os::windows::fs::OpenOptionsExt;
        let exclusive = std::fs::OpenOptions::new()
            .write(true)
            .share_mode(0)
            .open(&source)
            .unwrap();
        let error = store.snapshot_input("job-2", &source, None).unwrap_err();
        assert_eq!(error.code, "source_busy");
        drop(exclusive);
        assert!(store.snapshot_input("job-3", &source, None).is_ok());
    }

    #[test]
    fn staged_package_validates_and_survives_source_removal() {
        let (store, dir) = store("survive");
        let bytes = sample_package();
        let source = write_source(&dir, "src.hwpkg", &bytes);
        let receipt = store.snapshot_input("job-1", &source, None).unwrap();
        // 快照完成后源文件移动/删除不影响本次任务（§7.1）。
        std::fs::remove_file(&source).unwrap();
        let staged = store.validate_staged("job-1").unwrap();
        assert_eq!(staged.package_hash, receipt.sha256);
        assert_eq!(staged.manifest.title, "静夜");
        store.unpack_projection("job-1", &staged).unwrap();
        store
            .content_writer()
            .unwrap()
            .publish_staging("job-1", &staged.package_hash)
            .unwrap();
        assert!(store
            .verify_installed(&staged.package_hash)
            .unwrap()
            .is_some());
    }

    #[test]
    fn staged_model_and_ktx2_containers_are_checked_before_projection_and_on_reopen() {
        use std::io::{Cursor, Read, Write};
        // Container fixtures only: neither proves GLTF/DFD decode admission.
        let mut glb_json = br#"{"asset":{"version":"2.0"}}"#.to_vec();
        while glb_json.len() % 4 != 0 {
            glb_json.push(b' ');
        }
        let mut glb = b"glTF".to_vec();
        glb.extend(2_u32.to_le_bytes());
        glb.extend((20_u32 + glb_json.len() as u32).to_le_bytes());
        glb.extend((glb_json.len() as u32).to_le_bytes());
        glb.extend(b"JSON");
        glb.extend(glb_json);
        let mut ktx2 = vec![0_u8; 196];
        ktx2[..12].copy_from_slice(&[
            0xab, b'K', b'T', b'X', b' ', b'2', b'0', 0xbb, 13, 10, 26, 10,
        ]);
        for (offset, value) in [
            (12, 37_u32),
            (16, 1),
            (20, 4),
            (24, 4),
            (36, 1),
            (40, 1),
            (48, 104),
            (52, 28),
            (104, 28),
        ] {
            ktx2[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (offset, value) in [(80, 132_u64), (88, 64), (96, 64)] {
            ktx2[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        }
        for (kind, mime, body, error_code) in [
            ("model", "model/gltf-binary", glb, "invalid_model_container"),
            ("texture", "image/ktx2", ktx2, "invalid_texture_container"),
        ] {
            for invalid in [false, true] {
                let (store, dir) = store("resource-container-staging");
                let mut archive = zip::ZipArchive::new(Cursor::new(sample_package())).unwrap();
                let mut manifest: serde_json::Value =
                    serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
                let mut png = Vec::new();
                archive
                    .by_name("assets/background.png")
                    .unwrap()
                    .read_to_end(&mut png)
                    .unwrap();
                let mut body = body.clone();
                if invalid {
                    body[0] = 0;
                }
                manifest["assets"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::json!({
                        "id":"resource", "kind":kind, "source":"assets/resource", "variants":[]
                    }));
                manifest["files"].as_array_mut().unwrap().push(serde_json::json!({
                    "path":"assets/resource", "bytes":body.len(), "sha256":format!("{:x}", Sha256::digest(&body)), "mime":mime
                }));
                let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
                for (path, bytes) in [
                    ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
                    ("assets/background.png", png),
                    ("assets/resource", body),
                ] {
                    writer
                        .start_file(path, zip::write::SimpleFileOptions::default())
                        .unwrap();
                    writer.write_all(&bytes).unwrap();
                }
                let bytes = writer.finish().unwrap().into_inner();
                let source = write_source(&dir, "src.hwpkg", &bytes);
                store.snapshot_input("job-1", &source, None).unwrap();
                std::fs::remove_file(source).unwrap();
                if invalid {
                    let error = store.validate_staged("job-1").unwrap_err();
                    assert_eq!(error.code, "package_invalid");
                    assert!(error.message.starts_with(error_code));
                    assert!(error.message.contains("assets/resource"));
                    assert!(!store.staging_dir("job-1").join("files").exists());
                    store.discard_staging("job-1");
                } else {
                    let staged = store.validate_staged("job-1").unwrap();
                    assert_eq!(staged.entries.len(), 2);
                    store.unpack_projection("job-1", &staged).unwrap();
                    store
                        .content_writer()
                        .unwrap()
                        .publish_staging("job-1", &staged.package_hash)
                        .unwrap();
                    assert!(store
                        .verify_installed(&staged.package_hash)
                        .unwrap()
                        .is_some());
                    assert_eq!(
                        store
                            .read_installed_manifest(&staged.package_hash)
                            .unwrap()
                            .entries
                            .len(),
                        2
                    );
                }
            }
        }
    }

    #[test]
    fn publish_rejects_existing_hash_directory() {
        let (store, dir) = store("publish");
        let bytes = sample_package();
        let source = write_source(&dir, "src.hwpkg", &bytes);
        store.snapshot_input("job-1", &source, None).unwrap();
        let staged = store.validate_staged("job-1").unwrap();
        store.unpack_projection("job-1", &staged).unwrap();
        store
            .content_writer()
            .unwrap()
            .publish_staging("job-1", &staged.package_hash)
            .unwrap();
        // 第二次发布同 hash → target_exists，绝不覆盖（§7.2）。
        store.snapshot_input("job-2", &source, None).unwrap();
        store.unpack_projection("job-2", &staged).unwrap();
        let error = store
            .content_writer()
            .unwrap()
            .publish_staging("job-2", &staged.package_hash)
            .unwrap_err();
        assert_eq!(error.code, "target_exists");
        store.discard_staging("job-2");
    }

    #[test]
    fn staged_model_structure_rejects_a_valid_glb_container_with_a_node_cycle() {
        use std::io::{Cursor, Write};
        let (store, dir) = store("model-structure-staging");
        let mut json = br#"{"asset":{"version":"2.0"},"nodes":[{"children":[0]}]}"#.to_vec();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let mut glb = b"glTF".to_vec();
        glb.extend(2_u32.to_le_bytes());
        glb.extend((20_u32 + json.len() as u32).to_le_bytes());
        glb.extend((json.len() as u32).to_le_bytes());
        glb.extend(b"JSON");
        glb.extend(json);
        hertz_wallpaper::model_container::inspect_glb(Cursor::new(&glb), glb.len() as u64)
            .expect("fixture has a valid container envelope");
        let manifest = serde_json::json!({
            "formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae",
            "version":1,"title":"Model structure","content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
            "assets":[{"id":"model","kind":"model","source":"assets/model.glb","variants":[]}],
            "files":[{"path":"assets/model.glb","bytes":glb.len(),"sha256":format!("{:x}",Sha256::digest(&glb)),"mime":"model/gltf-binary"}],
            "properties":[],"permissions":{"audioSpectrum":false,"pointer":false},
            "license":{"code":"none","assets":"CC0-1.0","attribution":""}
        });
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, bytes) in [
            ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
            ("assets/model.glb", glb),
        ] {
            writer
                .start_file(path, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(&bytes).unwrap();
        }
        let source = write_source(&dir, "cycle.hwpkg", &writer.finish().unwrap().into_inner());
        store.snapshot_input("job-cycle", &source, None).unwrap();
        std::fs::remove_file(source).unwrap();
        let error = store.validate_staged("job-cycle").unwrap_err();
        assert_eq!(error.code, "package_invalid");
        assert!(error.message.starts_with("invalid_model_structure"));
        assert!(error.message.contains("assets/model.glb"));
        assert!(!store.staging_dir("job-cycle").join("files").exists());
        store.discard_staging("job-cycle");
        assert!(!store.staging_dir("job-cycle").exists());
    }

    #[test]
    fn disk_space_check_rejects_oversize_request() {
        let (store, _dir) = store("disk");
        let error = store.check_disk_space(u64::MAX / 2).unwrap_err();
        assert_eq!(error.code, "disk_full");
    }

    #[test]
    fn verify_installed_detects_projection_tampering() {
        let (store, dir) = store("tamper");
        let bytes = sample_package();
        let source = write_source(&dir, "src.hwpkg", &bytes);
        store.snapshot_input("job-1", &source, None).unwrap();
        let staged = store.validate_staged("job-1").unwrap();
        store.unpack_projection("job-1", &staged).unwrap();
        store
            .content_writer()
            .unwrap()
            .publish_staging("job-1", &staged.package_hash)
            .unwrap();
        assert!(store
            .verify_installed(&staged.package_hash)
            .unwrap()
            .is_some());
        // 等长篡改也必须拒绝，不能只核对尺寸。
        let projection = store
            .package_dir(&staged.package_hash)
            .join("files/assets/background.png");
        std::fs::write(&projection, vec![0; 70]).unwrap();
        assert!(store
            .verify_installed(&staged.package_hash)
            .unwrap()
            .is_none());
    }

    #[test]
    fn cached_verification_pins_bytes_until_the_lease_is_dropped() {
        let (store, dir) = store("pinned");
        let source = write_source(&dir, "src.hwpkg", &sample_package());
        store.snapshot_input("job-1", &source, None).unwrap();
        let package = store.validate_staged("job-1").unwrap();
        store.unpack_projection("job-1", &package).unwrap();
        store
            .content_writer()
            .unwrap()
            .publish_staging("job-1", &package.package_hash)
            .unwrap();
        let pinned = store
            .pin_verified_media(&package.package_hash, "assets/background.png")
            .unwrap()
            .unwrap();
        let projection = pinned.path.clone();
        assert!(std::fs::write(&projection, b"tampered").is_err());
        assert!(std::fs::write(
            store
                .package_dir(&package.package_hash)
                .join("original.hwpkg"),
            b"tampered"
        )
        .is_err());
        drop(pinned);
        assert!(std::fs::write(projection, b"tampered").is_ok());
    }

    #[tokio::test]
    async fn remove_installed_rejects_invalid_hash_and_removes_only_the_named_package() {
        let (store, _dir) = store("remove-installed");
        let keep = hash_of(7);
        let drop = hash_of(8);
        for (name, bytes) in [(&keep, 11u32), (&drop, 22u32)] {
            let dir = store.package_dir(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("original.hwpkg"), vec![0; bytes as usize]).unwrap();
        }
        assert!(store.remove_installed("../escape").await.is_err());
        store.remove_installed(&drop).await.unwrap();
        assert!(!store.package_dir(&drop).exists());
        assert!(store.package_dir(&keep).exists());
        assert!(store.remove_installed(&drop).await.is_ok(), "重复删除幂等");
    }

    fn hash_of(tag: u8) -> String {
        format!("{tag:064x}")
    }
}
