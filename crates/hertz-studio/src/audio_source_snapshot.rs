// SPDX-License-Identifier: MIT
//! Immutable bytes shared by offline measurement and the original decoder owner.
use crate::error::ApiError;
use axum::http::StatusCode;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use vmusic_audio::loudness::Control;

pub(crate) const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(crate) const MAX_SNAPSHOT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
static SNAPSHOT_BYTES: AtomicU64 = AtomicU64::new(0);

pub(crate) fn available() -> bool {
    cfg!(any(windows, unix))
}

fn changed() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "loudness_media_changed",
        "媒体字节或来源已改变，请重新分析",
    )
}
fn io_error() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "loudness_snapshot_unavailable",
        "无法建立只读媒体快照；请检查临时目录空间及文件是否正在写入",
    )
}
fn check(control: &Control) -> Result<(), ApiError> {
    control
        .check()
        .map_err(crate::audio_loudness::analysis_error)
}

fn same_identity(a: &Metadata, b: &Metadata) -> bool {
    if !a.is_file() || !b.is_file() || a.len() != b.len() || a.modified().ok() != b.modified().ok()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if a.dev() != b.dev()
            || a.ino() != b.ino()
            || a.ctime() != b.ctime()
            || a.ctime_nsec() != b.ctime_nsec()
        {
            return false;
        }
    }
    true
}

fn open_original(path: &Path) -> Result<File, ApiError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Read sharing only: the selected object cannot be written or replaced.
        options.share_mode(1);
    }
    options.open(path).map_err(|_| io_error())
}

pub(crate) fn hash_file(file: &mut File, control: &Control) -> Result<(String, u64), ApiError> {
    check(control)?;
    let before = file.metadata().map_err(|_| changed())?;
    if !before.is_file() || before.len() > MAX_SOURCE_BYTES {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "loudness_size",
            "需要不超过 2 GiB 的完整普通文件",
        ));
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| changed())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        check(control)?;
        let n = file.read(&mut buffer).map_err(|_| changed())?;
        if n == 0 {
            break;
        }
        bytes = bytes.checked_add(n as u64).ok_or_else(changed)?;
        if bytes > before.len() {
            return Err(changed());
        }
        hash.update(&buffer[..n]);
    }
    let after = file.metadata().map_err(|_| changed())?;
    if bytes != before.len() || !same_identity(&before, &after) {
        return Err(changed());
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| changed())?;
    check(control)?;
    Ok((format!("{:x}", hash.finalize()), bytes))
}

struct DiskLease(u64);
impl DiskLease {
    #[cfg(any(unix, test))]
    fn reserve(bytes: u64) -> Result<Arc<Self>, ApiError> {
        let mut used = SNAPSHOT_BYTES.load(Ordering::Acquire);
        loop {
            let next = used
                .checked_add(bytes)
                .filter(|n| *n <= MAX_SNAPSHOT_BYTES)
                .ok_or_else(|| {
                    ApiError::new(
                        StatusCode::TOO_MANY_REQUESTS,
                        "loudness_snapshot_busy",
                        "只读媒体快照已达全进程 4 GiB 临时空间预算；请结束旧曲目或稍后重试",
                    )
                })?;
            match SNAPSHOT_BYTES.compare_exchange_weak(
                used,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(Arc::new(Self(bytes))),
                Err(actual) => used = actual,
            }
        }
    }
}
impl Drop for DiskLease {
    fn drop(&mut self) {
        SNAPSHOT_BYTES.fetch_sub(self.0, Ordering::AcqRel);
    }
}

/// No writable alias is retained. On Unix the copy has no pathname before any
/// hash/decoder consumer receives it; Windows retains a read-sharing lease.
pub(crate) struct StableFile {
    // Close the actual read handle before returning its temporary disk allowance.
    file: File,
    original: PathBuf,
    identity: Metadata,
    fingerprint: Option<(String, u64)>,
    _disk: Option<Arc<DiskLease>>,
}
impl StableFile {
    pub(crate) fn open(path: &Path, control: &Control) -> Result<Self, ApiError> {
        check(control)?;
        let original = open_original(path)?;
        let identity = original.metadata().map_err(|_| changed())?;
        if !identity.is_file() || identity.len() > MAX_SOURCE_BYTES {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "loudness_size",
                "需要不超过 2 GiB 的完整普通文件",
            ));
        }
        #[cfg(windows)]
        {
            Ok(Self {
                file: original,
                original: path.to_owned(),
                identity,
                fingerprint: None,
                _disk: None,
            })
        }
        #[cfg(unix)]
        {
            Self::copy_unlinked(path, original, identity, control)
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = (original, identity);
            Err(io_error())
        }
    }

    #[cfg(any(unix, test))]
    fn copy_unlinked(
        path: &Path,
        mut original: File,
        identity: Metadata,
        control: &Control,
    ) -> Result<Self, ApiError> {
        use std::io::Write;
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(self.0.join("source"));
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        let disk = DiskLease::reserve(identity.len())?;
        let directory = std::env::temp_dir().join(format!("hertz-audio-{}", uuid::Uuid::new_v4()));
        #[allow(unused_mut)] // Only Unix exposes permission mode on DirBuilder.
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory).map_err(|_| io_error())?;
        let cleanup = Cleanup(directory);
        let named = cleanup.0.join("source");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut writer = options.open(&named).map_err(|_| io_error())?;
        let mut hash = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        let mut bytes = 0u64;
        loop {
            check(control)?;
            let n = original.read(&mut buffer).map_err(|_| changed())?;
            if n == 0 {
                break;
            }
            bytes = bytes.checked_add(n as u64).ok_or_else(changed)?;
            if bytes > identity.len() {
                return Err(changed());
            }
            writer.write_all(&buffer[..n]).map_err(|_| io_error())?;
            hash.update(&buffer[..n]);
        }
        if bytes != identity.len()
            || !same_identity(&identity, &original.metadata().map_err(|_| changed())?)
        {
            return Err(changed());
        }
        writer.flush().map_err(|_| io_error())?;
        drop(writer);
        let file = File::open(&named).map_err(|_| io_error())?;
        // No writer and no addressable path remain. This, rather than before/
        // after stat, is what keeps SHA-256, decoding and later playback identical.
        std::fs::remove_file(&named).map_err(|_| io_error())?;
        let mut result = Self {
            file,
            original: path.to_owned(),
            identity,
            fingerprint: Some((format!("{:x}", hash.finalize()), bytes)),
            _disk: Some(disk),
        };
        result.verify_original(control)?;
        drop(cleanup);
        result
            .file
            .seek(SeekFrom::Start(0))
            .map_err(|_| changed())?;
        Ok(result)
    }

    pub(crate) fn fingerprint(&mut self, control: &Control) -> Result<(String, u64), ApiError> {
        check(control)?;
        if let Some(value) = &self.fingerprint {
            self.file.seek(SeekFrom::Start(0)).map_err(|_| changed())?;
            return Ok(value.clone());
        }
        let value = hash_file(&mut self.file, control)?;
        self.fingerprint = Some(value.clone());
        Ok(value)
    }

    pub(crate) fn verify_original(&mut self, control: &Control) -> Result<(), ApiError> {
        let expected = self.fingerprint(control)?;
        let mut named = open_original(&self.original)?;
        if !same_identity(&self.identity, &named.metadata().map_err(|_| changed())?)
            || hash_file(&mut named, control)? != expected
            || !same_identity(
                &self.identity,
                &std::fs::metadata(&self.original).map_err(|_| changed())?,
            )
        {
            return Err(changed());
        }
        check(control)
    }

    pub(crate) fn try_clone(&self) -> std::io::Result<File> {
        self.file.try_clone()
    }
    pub(crate) fn len(&self) -> u64 {
        self.identity.len()
    }
}
impl Read for StableFile {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(out)
    }
}
impl Seek for StableFile {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        sync::atomic::AtomicBool,
        time::{Duration, Instant},
    };

    fn control() -> Control {
        Control {
            until: Instant::now() + Duration::from_secs(5),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    fn fixture(bytes: &[u8]) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("hertz-snapshot-test-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        path
    }
    fn copied(path: &Path, control: &Control) -> StableFile {
        let file = File::open(path).unwrap();
        let metadata = file.metadata().unwrap();
        StableFile::copy_unlinked(path, file, metadata, control).unwrap()
    }
    #[test]
    fn unlinked_copy_retains_exact_bytes_and_no_writable_handle_after_source_change() {
        let path = fixture(b"measured bytes");
        let c = control();
        let mut snapshot = copied(&path, &c);
        let fingerprint = snapshot.fingerprint(&c).unwrap();
        std::fs::write(&path, b"replaced bytes").unwrap();
        assert_eq!(
            snapshot.verify_original(&c).unwrap_err().code,
            "loudness_media_changed"
        );
        let mut data = Vec::new();
        snapshot.read_to_end(&mut data).unwrap();
        assert_eq!(data, b"measured bytes");
        assert_eq!(fingerprint.0, format!("{:x}", Sha256::digest(&data)));
        assert!(snapshot.try_clone().unwrap().write_all(b"change").is_err());
        drop(snapshot);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn cancellation_and_source_size_are_checked_before_snapshot_work() {
        let path = fixture(b"bytes");
        let c = control();
        c.cancelled.store(true, Ordering::Relaxed);
        assert_eq!(
            StableFile::open(&path, &c).err().unwrap().code,
            "loudness_cancelled"
        );
        assert!(DiskLease::reserve(MAX_SNAPSHOT_BYTES + 1).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn empty_and_nonempty_copies_can_be_rewound_for_independent_consumers() {
        for bytes in [b"".as_slice(), b"source contents".as_slice()] {
            let path = fixture(bytes);
            let c = control();
            let mut snapshot = copied(&path, &c);
            assert_eq!(snapshot.len(), bytes.len() as u64);
            for _ in 0..2 {
                snapshot.fingerprint(&c).unwrap();
                let mut read = Vec::new();
                snapshot
                    .try_clone()
                    .unwrap()
                    .read_to_end(&mut read)
                    .unwrap();
                assert_eq!(read, bytes);
                snapshot.verify_original(&c).unwrap();
            }
            drop(snapshot);
            std::fs::remove_file(path).unwrap();
        }
    }
}

impl vmusic_core::AudioSource for StableFile {
    fn media_len(&self) -> Option<u64> {
        Some(self.len())
    }
}
