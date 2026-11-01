// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸资产存储（设计 docs/desktop-wallpaper.md §4.2/§7.1/§7.2）。
//!
//! 目录（root = 桌面状态根，测试/便携经 HERTZ_DESKTOP_CONFIG_DIR 整体重定向）：
//! `packages/<packageHash>/{original.hwpkg, files/, receipt.json}`、
//! `staging/<jobId>/`、`derived/<inputHash>/…`。复制进不可变包，P1 不引用
//! 原路径；已安装作品永不重新打开用户源文件。

use std::io::Read;
use std::path::{Path, PathBuf};

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
}

impl AssetStore {
    pub fn new(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root.join("packages"))
            .and_then(|_| std::fs::create_dir_all(root.join("staging")))
            .and_then(|_| std::fs::create_dir_all(root.join("derived")))
            .map_err(|error| JobError::io(format!("创建资产目录失败：{error}")))?;
        Ok(Self {
            root: root.to_path_buf(),
        })
    }

    fn staging_dir(&self, job_id: &str) -> PathBuf {
        self.root.join("staging").join(job_id)
    }

    pub fn package_dir(&self, package_hash: &str) -> PathBuf {
        self.root.join("packages").join(package_hash)
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
        use std::sync::atomic::Ordering;
        let staging = self.staging_dir(job_id);
        std::fs::create_dir_all(&staging)
            .map_err(|error| JobError::io(format!("创建 staging 目录失败：{error}")))?;
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
                        format!("源文件正被其它进程写入，已拒绝并发读取：{}", source.display()),
                    )
                } else {
                    JobError::io(format!("打开导入源失败：{error}"))
                }
            })?;
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
            hasher.update(&chunk[..read]);
            std::io::Write::write_all(&mut writer, &chunk[..read])
                .map_err(|error| JobError::io(format!("写入快照失败：{error}")))?;
            bytes += read as u64;
        }
        std::io::Write::flush(&mut writer).and_then(|_| {
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
        let bytes = std::fs::read(&original)
            .map_err(|error| JobError::io(format!("读取快照失败：{error}")))?;
        let package_hash = format!("{:x}", Sha256::digest(&bytes));
        hertz_wallpaper::archive::check_package_bytes(bytes.len() as u64)?;
        let package = hertz_wallpaper::validate_package(std::io::Cursor::new(bytes))?;
        let manifest_json = serde_json::to_string(&package.manifest)
            .map_err(|error| JobError::io(format!("manifest 再序列化失败：{error}")))?;
        Ok(StagedPackage {
            package_hash,
            manifest: package.manifest,
            manifest_json,
            entries: package.entries,
        })
    }

    /// ③ 空间峰值预检（§7.1 末段）：所需 = 投影字节数 + 已有 staging 占用 + 余量。
    pub fn check_disk_space(&self, required: u64) -> Result<()> {
        let staged = self.staged_total_bytes()?;
        let need = required.saturating_add(staged);
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

    fn staged_total_bytes(&self) -> Result<u64> {
        let mut total = 0u64;
        let staging = self.root.join("staging");
        let entries = std::fs::read_dir(&staging)
            .map_err(|error| JobError::io(format!("读取 staging 失败：{error}")))?;
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                total += dir_size(&entry.path())?;
            }
        }
        Ok(total)
    }

    /// ④ 投影解包：files/ 只包含已声明路径（校验器已排除未声明条目）。
    pub fn unpack_projection(
        &self,
        job_id: &str,
        package: &StagedPackage,
    ) -> Result<()> {
        let original = self.staging_dir(job_id).join("original.hwpkg");
        let files_dir = self.staging_dir(job_id).join("files");
        std::fs::create_dir_all(&files_dir)
            .map_err(|error| JobError::io(format!("创建投影目录失败：{error}")))?;
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&original).map_err(|error| {
            JobError::io(format!("重新打开快照失败：{error}"))
        })?)
        .map_err(|error| JobError::new("package_invalid", format!("快照不是合法 ZIP：{error}")))?;
        for entry in &package.entries {
            let mut reader = archive
                .by_name(&entry.path)
                .map_err(|error| JobError::new("package_invalid", format!("投影条目缺失：{error}")))?;
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
            file.sync_all()
                .map_err(|error| JobError::io(format!("投影条目落盘失败：{entry_path}: {error}")))?;
        }
        // ⑤ 收据：核验事实落盘（§4.2 packages 的本机验证收据）。
        let receipt = InstalledReceipt {
            package_hash: package.package_hash.clone(),
            installed_at: crate::wallpaper::library::now_secs(),
            entries: package.entries.clone(),
        };
        let receipt_path = self.staging_dir(job_id).join("receipt.json");
        std::fs::write(&receipt_path, serde_json::to_vec_pretty(&receipt).map_err(|error| {
            JobError::io(format!("收据序列化失败：{error}"))
        })?)
        .map_err(|error| JobError::io(format!("写入收据失败：{error}")))?;
        Ok(())
    }

    /// ⑥ 原子发布：staging 目录改名到 packages/<hash>。Windows 的 rename 在
    /// 目标存在时失败——天然拒绝覆盖另一个 hash 目录（§7.2）。
    pub fn publish_staging(&self, job_id: &str, package_hash: &str) -> Result<()> {
        let staging = self.staging_dir(job_id);
        let target = self.package_dir(package_hash);
        if target.exists() {
            return Err(JobError::new(
                "target_exists",
                format!("包目录已存在：{package_hash}"),
            ));
        }
        std::fs::rename(&staging, &target)
            .map_err(|error| JobError::io(format!("发布包目录失败：{error}")))?;
        Ok(())
    }

    /// 去重路径：同 hash 已安装时丢弃 staging（幂等导入不产生第二份物理包）。
    pub fn discard_staging(&self, job_id: &str) {
        let _ = std::fs::remove_dir_all(self.staging_dir(job_id));
    }

    /// 取消/失败后的 staging 清理（真实 I/O 已退出才调用）。
    pub fn cleanup_staging(&self, job_id: &str) {
        self.discard_staging(job_id);
    }

    /// 已安装包快速核验（§7.2：收据 + 只读目录 + 哈希核对）。
    /// 返回 Some(收据) 表示目录与 original.hwpkg 完整可核验。
    pub fn verify_installed(&self, package_hash: &str) -> Result<Option<InstalledReceipt>> {
        let dir = self.package_dir(package_hash);
        let original = dir.join("original.hwpkg");
        if !dir.is_dir() || !original.is_file() {
            return Ok(None);
        }
        let mut hasher = Sha256::new();
        let mut file = std::fs::File::open(&original)
            .map_err(|error| JobError::io(format!("打开 original.hwpkg 失败：{error}")))?;
        std::io::copy(&mut file, &mut hasher)
            .map_err(|error| JobError::io(format!("核对 original.hwpkg 失败：{error}")))?;
        if format!("{:x}", hasher.finalize()) != package_hash {
            return Ok(None);
        }
        let receipt_path = dir.join("receipt.json");
        if !receipt_path.is_file() {
            return Ok(None);
        }
        let receipt: InstalledReceipt = serde_json::from_slice(&std::fs::read(&receipt_path).map_err(|error| {
            JobError::io(format!("读取收据失败：{error}"))
        })?)
        .map_err(|error| JobError::new("package_invalid", format!("收据损坏：{error}")))?;
        if receipt.package_hash != package_hash {
            return Ok(None);
        }
        // 投影文件抽查：收据声明的每个条目都在 files/ 且大小一致。
        for entry in &receipt.entries {
            let path = dir.join("files").join(&entry.path);
            let meta = std::fs::metadata(&path).ok();
            match meta {
                Some(meta) if meta.len() == entry.bytes => {}
                _ => return Ok(None),
            }
        }
        Ok(Some(receipt))
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
    pub fn read_installed_manifest(
        &self,
        package_hash: &str,
    ) -> Result<StagedPackage> {
        let original = self.package_dir(package_hash).join("original.hwpkg");
        let bytes = std::fs::read(&original)
            .map_err(|error| JobError::io(format!("读取已安装包失败：{error}")))?;
        let package = hertz_wallpaper::validate_package(std::io::Cursor::new(bytes))?;
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

fn dir_size(path: &Path) -> Result<u64> {
    let mut total = 0u64;
    let entries = std::fs::read_dir(path).map_err(|error| JobError::io(format!("读取目录失败：{error}")))?;
    for entry in entries.flatten() {
        let meta = entry
            .metadata()
            .map_err(|error| JobError::io(format!("读取元数据失败：{error}")))?;
        if meta.is_dir() {
            total += dir_size(&entry.path())?;
        } else {
            total += meta.len();
        }
    }
    Ok(total)
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
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_to_caller,
            &mut total,
            &mut free,
        )
    };
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
                .start_file("assets/background.png", zip::write::SimpleFileOptions::default())
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
        store.publish_staging("job-1", &staged.package_hash).unwrap();
        assert!(store.verify_installed(&staged.package_hash).unwrap().is_some());
    }

    #[test]
    fn publish_rejects_existing_hash_directory() {
        let (store, dir) = store("publish");
        let bytes = sample_package();
        let source = write_source(&dir, "src.hwpkg", &bytes);
        store.snapshot_input("job-1", &source, None).unwrap();
        let staged = store.validate_staged("job-1").unwrap();
        store.unpack_projection("job-1", &staged).unwrap();
        store.publish_staging("job-1", &staged.package_hash).unwrap();
        // 第二次发布同 hash → target_exists，绝不覆盖（§7.2）。
        store.snapshot_input("job-2", &source, None).unwrap();
        store.unpack_projection("job-2", &staged).unwrap();
        let error = store
            .publish_staging("job-2", &staged.package_hash)
            .unwrap_err();
        assert_eq!(error.code, "target_exists");
        store.discard_staging("job-2");
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
        store.publish_staging("job-1", &staged.package_hash).unwrap();
        assert!(store.verify_installed(&staged.package_hash).unwrap().is_some());
        // 投影文件被截断 → 核验失败。
        let projection = store
            .package_dir(&staged.package_hash)
            .join("files/assets/background.png");
        std::fs::write(&projection, b"").unwrap();
        assert!(store.verify_installed(&staged.package_hash).unwrap().is_none());
    }
}
