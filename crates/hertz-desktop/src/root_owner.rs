// SPDX-License-Identifier: MIT
//! Desktop-root admission precedes config.commit.lock and any data access.
//! Shared handles admit current hosts; exclusive handles admit offline upgrade
//! and recovery. Directory pins keep the canonical identity stable until drop.
use std::fs::{File, Metadata, OpenOptions};
use std::ops::Deref;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// std's repr(C) ArcInner<T>: two AtomicUsize counters followed by actual T.
/// Layout composition includes padding without mirroring the private body.
pub(crate) fn arc_allocation_bytes<T>() -> Option<u64> {
    use std::alloc::Layout;
    use std::sync::atomic::AtomicUsize;
    let counters = Layout::array::<AtomicUsize>(2).ok()?;
    let (layout, _) = counters.extend(Layout::new::<T>()).ok()?;
    u64::try_from(layout.pad_to_align().size()).ok()
}

use anyhow::{ensure, Context, Result};
use windows_sys::Win32::Foundation::GENERIC_READ;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_SHARE_READ, FILE_SHARE_WRITE,
};

const LOCK: &str = "desktop.root.lock";
/// `canonicalize` may add the verbatim prefix (`\\?\`) to the caller's bytes.
const VERBATIM_EXTRA_BYTES: u64 = 8;
/// Windows extended-length ceiling (32,767 UTF-16 units) in WTF-8 bytes; a
/// relative root canonicalizes against a CWD that this ceiling also bounds.
const MAX_RELATIVE_CWD_BYTES: u64 = 3 * 32_767;
/// Covers canonicalize's initial wide buffer and other fixed conversions that
/// are not proportional to the path length.
const PRIOR_FIXED_SLACK_BYTES: u64 = 16 * 1024;

#[derive(Debug, thiserror::Error)]
#[error("desktop_root_busy: 桌面资料正在使用或维护，请正常退出使用此目录的所有宿主后重试")]
pub(crate) struct Busy;

/// The physical desktop-root payload: canonical path, directory pins and the
/// lock handle. It exists only inside the shared lease below.
pub(crate) struct RootOwnerPin {
    root: PathBuf,
    _lock: File,
    _directories: Vec<File>,
}

/// A shared desktop-root lease. Every clone shares one physical payload and
/// one prior admission; the last clone's payload is deallocated (and its lock
/// handle closed) before the charge field refunds the admitted bytes.
pub(crate) struct RootOwner {
    owner: Arc<RootOwnerPin>,
    /// Declared after the payload handle: refund happens only after the pin's
    /// canonical path, directory Vec and Arc backing physically exit.
    charge: Arc<crate::wallpaper::budget::RootOwnerCharge>,
}

impl Clone for RootOwner {
    fn clone(&self) -> Self {
        Self {
            owner: Arc::clone(&self.owner),
            charge: Arc::clone(&self.charge),
        }
    }
}

impl Deref for RootOwner {
    type Target = RootOwnerPin;

    fn deref(&self) -> &Self::Target {
        &self.owner
    }
}

/// Conservative prior fee for one desktop-root owner, computed without any
/// allocation from caller bytes and absolute/relative kind:
/// - canonical path: input + verbatim prefix (relative roots add the bounded
///   CWD they resolve against);
/// - directory pins: at most one ancestor per two path bytes, a power-of-two
///   `Vec<File>` capacity plus the last realloc's old+new overlap;
/// - temporary lock/probe path joins and canonicalize/UTF-16 conversions at
///   six times the canonical bound, plus a fixed slack;
/// - both ArcInner blocks that the lease allocates after admission.
fn root_owner_requested_bytes(root: &Path) -> Option<u64> {
    let input = u64::try_from(root.as_os_str().len()).ok()?;
    let canonical = if root.is_absolute() {
        input.checked_add(VERBATIM_EXTRA_BYTES)?
    } else {
        input
            .checked_add(MAX_RELATIVE_CWD_BYTES)?
            .checked_add(VERBATIM_EXTRA_BYTES)?
    };
    let ancestors = canonical.checked_div(2)?.checked_add(4)?;
    let slots = ancestors.checked_next_power_of_two()?;
    let file = u64::try_from(std::mem::size_of::<File>()).ok()?;
    let pins = slots
        .checked_mul(file)?
        .checked_add(slots.checked_div(2)?.checked_mul(file)?)?;
    let temps = canonical.checked_mul(6)?;
    canonical
        .checked_add(pins)?
        .checked_add(temps)?
        .checked_add(PRIOR_FIXED_SLACK_BYTES)?
        .checked_add(arc_allocation_bytes::<RootOwnerPin>()?)?
        .checked_add(arc_allocation_bytes::<
            crate::wallpaper::budget::RootOwnerCharge,
        >()?)
}

pub(crate) fn ordinary(metadata: &Metadata) -> Result<()> {
    ensure!(
        !metadata.file_type().is_symlink()
            && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "desktop_root_path: links and reparse points are not supported"
    );
    Ok(())
}

impl RootOwnerPin {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Actual retained capacities; this query allocates and clones nothing.
    /// Both ArcInner blocks belong to the lease that owns this payload.
    pub(crate) fn retained_heap_bytes(&self) -> Option<u64> {
        let paths = u64::try_from(self.root.capacity()).ok()?;
        let pins = self
            ._directories
            .capacity()
            .checked_mul(std::mem::size_of::<File>())?;
        paths
            .checked_add(u64::try_from(pins).ok()?)?
            .checked_add(arc_allocation_bytes::<RootOwnerPin>()?)?
            .checked_add(arc_allocation_bytes::<
                crate::wallpaper::budget::RootOwnerCharge,
            >()?)
    }
}

impl RootOwner {
    pub(crate) fn shared(root: &Path) -> Result<Self> {
        Self::acquire(root, false)
    }

    pub(crate) fn exclusive(root: &Path) -> Result<Self> {
        Self::acquire(root, true)
    }

    fn acquire(root: &Path, exclusive: bool) -> Result<Self> {
        // Every owned allocation below (canonical path, pins, lock path and
        // both Arcs) is admitted against the original process ledger first.
        let requested = root_owner_requested_bytes(root)
            .context("desktop_root_budget: 桌面资料根费用计算溢出")?;
        let budget = crate::wallpaper::budget::global();
        let charge = budget
            .admit_root_owner(requested)
            .map_err(|rejection| anyhow::anyhow!("desktop_root_budget: {}", rejection.message))?;
        // Check the caller's path before canonicalization, including ancestors;
        // otherwise a junction could hide the lock's actual directory identity.
        for path in root.ancestors().filter(|path| !path.as_os_str().is_empty()) {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) => ordinary(&metadata)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        if exclusive {
            ensure!(
                root.is_dir(),
                "desktop_root_missing: --desktop-root must be an existing directory"
            );
        } else {
            std::fs::create_dir_all(root).context("创建桌面资料目录")?;
        }
        let root = std::fs::canonicalize(root).context("规范化桌面资料目录")?;
        let mut directories = Vec::new();
        for path in root.ancestors() {
            let pin = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .context("固定桌面资料目录身份")?;
            let metadata = pin.metadata()?;
            ordinary(&metadata)?;
            ensure!(metadata.is_dir(), "desktop_root_path: expected directory");
            directories.push(pin);
        }
        let path = root.join(LOCK);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => ordinary(&metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        if exclusive {
            options.share_mode(0);
        } else {
            // OPEN_ALWAYS can create the empty carrier with GENERIC_READ.
            // Every reader permits other readers, but excludes write/delete.
            options
                .access_mode(GENERIC_READ)
                .share_mode(FILE_SHARE_READ);
        }
        let file = options.open(&path).map_err(|error| {
            if matches!(error.raw_os_error(), Some(32 | 33)) {
                anyhow::Error::new(Busy)
            } else {
                anyhow::Error::new(error).context("取得桌面资料准入")
            }
        })?;
        let metadata = file.metadata()?;
        ordinary(&metadata)?;
        ensure!(
            metadata.is_file(),
            "desktop_root_path: expected regular lock file"
        );
        let owner = Self {
            owner: Arc::new(RootOwnerPin {
                root,
                _lock: file,
                _directories: directories,
            }),
            charge: Arc::new(charge),
        };
        if exclusive {
            // SQLx Drop signals its SQLite worker; physical close can happen
            // after the last PoolInner callback is dropped. Exclusive admission
            // also waits for those OS handles, including detached connections.
            probe_database_handles(owner.root())?;
        }
        Ok(owner)
    }
}

/// Read-only OS close barrier. Legacy executables must remain stopped after
/// this probe, which is released before our own SQLite connections open.
pub(crate) fn probe_database_handles(root: &Path) -> Result<()> {
    for database in ["wallpaper.db", "trust.db"] {
        probe_named_database_handles(root, database)?;
    }
    Ok(())
}

/// Each admitted pool refunds only after its own physical SQLite handles exit.
pub(crate) fn probe_named_database_handles(root: &Path, database: &str) -> Result<()> {
    anyhow::ensure!(
        matches!(database, "wallpaper.db" | "trust.db"),
        "invalid database owner"
    );
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = root.join(format!("{database}{suffix}"));
        let file = match OpenOptions::new()
            .read(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) if matches!(error.raw_os_error(), Some(5 | 32 | 33)) => {
                anyhow::bail!("desktop_legacy_busy: SQLite 文件句柄尚未关闭，请等待宿主退出；旧版或其它程序也必须保持停止")
            }
            Err(error) => return Err(error.into()),
        };
        ordinary(&file.metadata()?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::library::tempfileish;

    // Root ownership charges a process-global ledger that sibling test modules
    // also touch in parallel; exact usage assertions need a cold process.
    fn cold_child(name: &str) -> bool {
        if std::env::var("HERTZ_ROOT_OWNER_COLD_CHILD").as_deref() == Ok(name) {
            return false;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture", "--test-threads=1"])
            .env("HERTZ_ROOT_OWNER_COLD_CHILD", name)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "cold child {name} failed:\n{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        true
    }

    #[test]
    fn root_owner_admission_covers_actual_peak_and_refunds_after_physical_release() {
        if cold_child("root_owner::tests::root_owner_admission_covers_actual_peak_and_refunds_after_physical_release")
        {
            return;
        }
        use crate::wallpaper::budget::{self, measure_requested_heap, PhysicalReleaseCapture};
        use std::alloc::Layout;
        use std::sync::atomic::AtomicUsize;

        let dir = tempfileish::temp_dir("root-owner-prior");
        // The process ledger and both embedded catalogs are not part of a root
        // owner's fee; warm them before measuring this owner.
        let budget = budget::global();
        let before = budget.usage();
        let requested = root_owner_requested_bytes(dir.path()).unwrap();
        let (owner, sample) = measure_requested_heap(|| RootOwner::shared(dir.path()).unwrap());
        assert!(!sample.overflow);
        assert!(sample.peak > 0);
        assert!(
            u64::try_from(sample.peak).unwrap() <= requested,
            "peak {} exceeds prior {}",
            sample.peak,
            requested
        );
        let retained = owner.retained_heap_bytes().unwrap();
        assert!(retained <= requested);
        let held = budget.usage();
        assert_eq!(held.root_owner_bytes, before.root_owner_bytes + requested);
        assert_eq!(held.root_owner_records, before.root_owner_records + 1);
        println!(
            "root-owner prior={requested} peak={} retained={retained}",
            sample.peak
        );

        // One physical payload and one charge are shared by every clone.
        let clone = owner.clone();
        drop(owner);
        assert_eq!(
            budget.usage().root_owner_bytes,
            before.root_owner_bytes + requested
        );
        assert_eq!(
            budget.usage().root_owner_records,
            before.root_owner_records + 1
        );

        let (layout, offset) = Layout::new::<[AtomicUsize; 2]>()
            .extend(Layout::new::<RootOwnerPin>())
            .unwrap();
        let arc = Arc::as_ptr(&clone.owner) as *const () as usize - offset;
        let allocations = [
            (
                clone.root.as_os_str().as_encoded_bytes().as_ptr() as usize,
                clone.root.capacity(),
                1,
            ),
            (
                clone._directories.as_ptr() as usize,
                clone._directories.capacity() * std::mem::size_of::<File>(),
                std::mem::align_of::<File>(),
            ),
            (
                arc,
                layout.pad_to_align().size(),
                layout.pad_to_align().align(),
            ),
        ];
        // Gate every payload deallocation: the ledger must stay charged while
        // the canonical path, pins and Arc backing are still physically live.
        let capture = PhysicalReleaseCapture::new(&allocations);
        let (sender, receiver) = std::sync::mpsc::channel();
        let dropping = Arc::clone(&budget);
        let thread = std::thread::spawn(move || {
            drop(clone);
            sender.send(dropping.usage()).unwrap();
        });
        for index in 0..allocations.len() {
            capture.wait_before(index);
            assert_eq!(
                budget.usage().root_owner_bytes,
                before.root_owner_bytes + requested
            );
            assert_eq!(
                budget.usage().root_owner_records,
                before.root_owner_records + 1
            );
            capture.free(index);
            capture.resume(index);
        }
        let released = receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        assert_eq!(released.root_owner_bytes, before.root_owner_bytes);
        assert_eq!(released.root_owner_records, before.root_owner_records);
        thread.join().unwrap();
        capture.assert_complete();
        capture.log_evidence("root-owner", &allocations);
        drop(capture);

        // OS close receipt: exclusive admission (share_mode 0) succeeds only
        // after the last shared lock file handle was physically closed.
        let writer = RootOwner::exclusive(dir.path()).unwrap();
        drop(writer);
        assert_eq!(budget.usage(), before);
        // Directory pins shared read/write but not delete: a successful rename
        // is their physical exit receipt.
        let moved = dir.path().with_extension("moved");
        std::fs::rename(dir.path(), &moved).unwrap();
        std::fs::rename(&moved, dir.path()).unwrap();
    }

    #[test]
    fn rejected_and_busy_root_acquisitions_refund_the_prior_charge() {
        if cold_child(
            "root_owner::tests::rejected_and_busy_root_acquisitions_refund_the_prior_charge",
        ) {
            return;
        }
        let budget = crate::wallpaper::budget::global();
        let before = budget.usage();
        let missing = tempfileish::temp_dir("root-owner-missing");
        assert!(RootOwner::exclusive(&missing.path().join("absent")).is_err());
        assert_eq!(budget.usage(), before);

        let dir = tempfileish::temp_dir("root-owner-refund");
        let reader = RootOwner::shared(dir.path()).unwrap();
        let held = budget.usage();
        assert!(RootOwner::exclusive(dir.path()).is_err());
        assert_eq!(budget.usage(), held);
        drop(reader);
        assert_eq!(budget.usage(), before);

        let link = dir.path().join("alias");
        let actual = dir.path().join("real");
        std::fs::create_dir(&actual).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&actual)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(RootOwner::shared(&link).is_err());
        assert_eq!(budget.usage(), before);
        std::fs::remove_dir(link).unwrap();
    }

    #[test]
    fn root_owner_prior_bound_scales_with_path_bytes_and_kind() {
        let short = root_owner_requested_bytes(Path::new("C:\\a")).unwrap();
        let long = root_owner_requested_bytes(Path::new(
            "C:\\a\\bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ))
        .unwrap();
        assert!(long > short);
        // A relative root resolves against a CWD bounded by the extended-length
        // ceiling, so its prior fee is larger before any allocation.
        let relative = root_owner_requested_bytes(Path::new("a")).unwrap();
        assert!(relative > long);
        assert!(relative <= crate::wallpaper::budget::MAX_ROOT_OWNER_BYTES);
    }

    #[test]
    fn current_readers_exclude_maintenance_and_carrier_replacement_until_last_drop() {
        let dir = tempfileish::temp_dir("root-readers");
        let first = RootOwner::shared(dir.path()).unwrap();
        let second = RootOwner::shared(&dir.path().join(".")).unwrap();
        assert!(RootOwner::exclusive(dir.path()).err().unwrap().is::<Busy>());
        assert!(std::fs::remove_file(dir.path().join(LOCK)).is_err());
        assert!(std::fs::rename(dir.path(), dir.path().with_extension("moved")).is_err());
        drop(first);
        assert!(RootOwner::exclusive(dir.path()).is_err());
        drop(second);
        let writer = RootOwner::exclusive(dir.path()).unwrap();
        assert!(RootOwner::shared(dir.path()).err().unwrap().is::<Busy>());
        drop(writer);
        assert!(RootOwner::shared(dir.path()).is_ok());
    }

    #[test]
    fn shared_root_initialization_is_concurrent_and_junction_is_rejected() {
        let dir = tempfileish::temp_dir("root-first");
        std::thread::scope(|scope| {
            let readers: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| RootOwner::shared(dir.path()).unwrap()))
                .collect();
            let readers: Vec<_> = readers
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect();
            assert!(RootOwner::exclusive(dir.path()).is_err());
            drop(readers);
        });
        assert!(RootOwner::exclusive(dir.path()).is_ok());
        let link = dir.path().join("alias");
        let actual = dir.path().join("real");
        std::fs::create_dir(&actual).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&actual)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(RootOwner::shared(&link)
            .err()
            .unwrap()
            .to_string()
            .contains("desktop_root_path"));
        std::fs::remove_dir(link).unwrap();
    }

    #[test]
    fn root_child_reader() {
        let Some(root) = std::env::var_os("HERTZ_ROOT_LOCK_CHILD") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let _reader = RootOwner::shared(&root).unwrap();
        std::fs::write(root.join("child.ready"), b"ready").unwrap();
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
    }

    #[test]
    fn another_process_and_abrupt_exit_obey_the_same_root_gate() {
        let dir = tempfileish::temp_dir("root-process");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "root_owner::tests::root_child_reader",
                "--nocapture",
            ])
            .env("HERTZ_ROOT_LOCK_CHILD", dir.path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        for _ in 0..100 {
            if dir.path().join("child.ready").exists() {
                break;
            }
            assert!(
                child.try_wait().unwrap().is_none(),
                "child exited before admission"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(dir.path().join("child.ready").exists());
        assert!(RootOwner::shared(dir.path()).is_ok());
        assert!(RootOwner::exclusive(dir.path()).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(RootOwner::exclusive(dir.path()).is_ok());
    }
}
