// SPDX-License-Identifier: MIT
//! Native launch ownership. A PID is diagnostic; held handles and creation times own processes.
use super::protocol::{Bootstrap, Budget, ProcessIdentity};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::mem::{size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::{Authorization::*, Isolation::*, *};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::SystemServices::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus};

pub fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
pub fn win(ok: i32, operation: &str) -> Result<()> {
    if ok == 0 {
        bail!("{operation}: {}", std::io::Error::last_os_error());
    }
    Ok(())
}
/// A pipe read never waits in the kernel for bytes the peer has not supplied.
pub struct CancellableReader {
    file: File,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl CancellableReader {
    pub fn new(file: File, cancel: Arc<AtomicBool>) -> Self {
        Self {
            file,
            cancel,
            deadline: Instant::now() + Duration::from_secs(45),
        }
    }
}
impl Read for CancellableReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            if self.cancel.load(Ordering::Acquire) || Instant::now() > self.deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "private pipe read cancelled or expired",
                ));
            }
            let mut available = 0;
            if unsafe {
                PeekNamedPipe(
                    self.file.as_raw_handle(),
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            if available > 0 {
                let length = buffer.len().min(available as usize);
                return self.file.read(&mut buffer[..length]);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
pub fn own_thread_handle() -> Result<Handle> {
    let mut handle = null_mut();
    win(
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                GetCurrentThread(),
                GetCurrentProcess(),
                &mut handle,
                THREAD_TERMINATE | THREAD_QUERY_INFORMATION,
                0,
                0,
            )
        },
        "hold own I/O thread for cancellation",
    )?;
    Handle::new(handle, "own I/O thread")
}
pub struct Handle(pub HANDLE);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Handle {
    pub fn close(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
            self.0 = null_mut();
        }
    }
    pub fn new(handle: HANDLE, operation: &str) -> Result<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            bail!("{operation}: {}", std::io::Error::last_os_error());
        }
        Ok(Self(handle))
    }
    pub fn duplicate(&self, access: u32, inherit: bool) -> Result<Self> {
        let mut value = null_mut();
        win(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    self.0,
                    GetCurrentProcess(),
                    &mut value,
                    access,
                    inherit as i32,
                    0,
                )
            },
            "DuplicateHandle restricted",
        )?;
        Self::new(value, "DuplicateHandle")
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.close();
    }
}

fn token_buffer(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let mut length = 0;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut length);
    }
    if length == 0 || length > 64 * 1024 {
        bail!("invalid token information length {length}");
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    win(
        unsafe {
            GetTokenInformation(
                token,
                class,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * size_of::<usize>()) as u32,
                &mut length,
            )
        },
        "GetTokenInformation",
    )?;
    Ok(buffer)
}
fn sid_string(sid: PSID) -> Result<String> {
    if sid.is_null() {
        bail!("null SID");
    }
    let mut value = null_mut();
    win(
        unsafe { ConvertSidToStringSidW(sid, &mut value) },
        "ConvertSidToStringSidW",
    )?;
    let mut length = 0;
    unsafe {
        while *value.add(length) != 0 && length < 256 {
            length += 1;
        }
    }
    let result = if length == 256 {
        Err(anyhow::anyhow!("SID string too long"))
    } else {
        String::from_utf16(unsafe { std::slice::from_raw_parts(value, length) })
            .context("SID utf16")
    };
    unsafe {
        LocalFree(value.cast());
    }
    result
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEvidence {
    pub app_container: bool,
    pub sid: String,
    pub capability_count: u32,
}
pub fn inspect_token(process: HANDLE) -> Result<TokenEvidence> {
    let mut token = null_mut();
    win(
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) },
        "OpenProcessToken",
    )?;
    let token = Handle::new(token, "token")?;
    let app = token_buffer(token.0, TokenIsAppContainer)?;
    if unsafe { *(app.as_ptr().cast::<u32>()) } != 1 {
        bail!("worker token is not an AppContainer");
    }
    let caps = token_buffer(token.0, TokenCapabilities)?;
    let count = unsafe { (*(caps.as_ptr().cast::<TOKEN_GROUPS>())).GroupCount };
    if count != 0 {
        bail!("worker token has {count} capabilities");
    }
    let sid = token_buffer(token.0, TokenAppContainerSid)?;
    let sid = sid_string(unsafe {
        (*(sid.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>())).TokenAppContainer
    })?;
    Ok(TokenEvidence {
        app_container: true,
        sid,
        capability_count: count,
    })
}
fn owner_sid() -> Result<String> {
    let mut token = null_mut();
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) },
        "owner token",
    )?;
    let token = Handle::new(token, "owner token")?;
    let buffer = token_buffer(token.0, TokenUser)?;
    sid_string(unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid })
}
fn protect_directory(path: &Path, owner: &str, sid: &str, rights: &str) -> Result<()> {
    // Protected DACL: only SYSTEM, this user and this random session SID. No library ACL changes.
    let label = if rights == "0x1301bf" {
        "S:(ML;OICI;NW;;;LW)"
    } else {
        ""
    };
    let sddl = wide(format!(
        "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{owner})(A;OICI;{rights};;;{sid}){label}"
    ));
    let mut descriptor = null_mut();
    win(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        },
        "build staging DACL",
    )?;
    let information = DACL_SECURITY_INFORMATION
        | PROTECTED_DACL_SECURITY_INFORMATION
        | if label.is_empty() {
            0
        } else {
            LABEL_SECURITY_INFORMATION
        };
    let result = win(
        unsafe { SetFileSecurityW(wide(path).as_ptr(), information, descriptor) },
        "protect session directory",
    );
    unsafe {
        LocalFree(descriptor);
    }
    result
}
pub struct Profile {
    name: String,
    pub sid: PSID,
    pub sid_text: String,
    pub root: PathBuf,
    pub udf: PathBuf,
    pub staging: PathBuf,
    cleaned: bool,
}
// The SID allocation and directory/profile cleanup APIs have no thread
// affinity. Ownership moves once in the existing Launch resource bundle;
// Profile is never shared for concurrent mutation.
unsafe impl Send for Profile {}
impl Profile {
    pub fn create() -> Result<Self> {
        let name = format!("Hertz.Wallpaper.{}", uuid::Uuid::new_v4().simple());
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                wide(&name).as_ptr(),
                wide(&name).as_ptr(),
                wide("Hertz isolated wallpaper qualification").as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result < 0 {
            bail!("CreateAppContainerProfile HRESULT=0x{:08x}", result as u32);
        }
        let root = std::env::temp_dir().join(&name);
        let mut value = Self {
            name,
            sid,
            sid_text: String::new(),
            udf: root.join("udf"),
            staging: root.join("runtime"),
            root,
            cleaned: false,
        };
        value.sid_text = sid_string(sid)?;
        std::fs::create_dir(&value.root)?;
        let owner = owner_sid()?;
        protect_directory(&value.root, &owner, &value.sid_text, "GRGX")?;
        std::fs::create_dir(&value.staging)?;
        protect_directory(&value.staging, &owner, &value.sid_text, "GRGX")?;
        std::fs::create_dir(&value.udf)?;
        protect_directory(&value.udf, &owner, &value.sid_text, "0x1301bf")?;
        std::fs::create_dir(value.udf.join("tmp"))?;
        Ok(value)
    }
    pub fn cleanup(&mut self) -> Result<()> {
        if self.cleaned {
            return Ok(());
        }
        if self.root.exists() {
            std::fs::remove_dir_all(&self.root).context("remove owned session directory")?;
        }
        let result = unsafe { DeleteAppContainerProfile(wide(&self.name).as_ptr()) };
        if result < 0 {
            bail!("DeleteAppContainerProfile HRESULT=0x{:08x}", result as u32);
        }
        self.cleaned = true;
        Ok(())
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        let _ = self.cleanup();
        unsafe {
            FreeSid(self.sid);
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub path: String,
    pub sha256: String,
    pub volume: u32,
    pub file_index: u64,
    pub bytes: u64,
}
pub struct VerifiedWorker {
    pub file: File,
    pub identity: FileIdentity,
}
impl VerifiedWorker {
    pub fn open(path: &Path, expected_hash: Option<&str>) -> Result<Self> {
        let path = path.canonicalize()?;
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&path)
            .context("hold worker binary against replacement")?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) },
            "worker file identity",
        )?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            bail!("worker is a reparse point");
        }
        let mut digest = Sha256::new();
        let mut chunk = [0; 64 * 1024];
        loop {
            let count = file.read(&mut chunk)?;
            if count == 0 {
                break;
            }
            digest.update(&chunk[..count]);
        }
        let hash = format!("{:x}", digest.finalize());
        file.seek(SeekFrom::Start(0))?;
        if let Some(expected) = expected_hash {
            if hash != expected {
                bail!("worker hash mismatch");
            }
        }
        Ok(Self {
            file,
            identity: FileIdentity {
                path: path.to_string_lossy().into(),
                sha256: hash,
                volume: info.dwVolumeSerialNumber,
                file_index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
                bytes: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
            },
        })
    }
    pub fn stage(&mut self, profile: &Profile) -> Result<Self> {
        let path = profile.staging.join("hertz-desktop.exe");
        let mut destination = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        self.file.seek(SeekFrom::Start(0))?;
        std::io::copy(&mut self.file, &mut destination)?;
        destination.sync_all()?;
        drop(destination);
        Self::open(&path, Some(&self.identity.sha256))
    }
}
pub fn created(process: HANDLE) -> Result<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    win(
        unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) },
        "GetProcessTimes",
    )?;
    let value = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    if value == 0 {
        bail!("zero process creation identity");
    }
    Ok(value)
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvidence {
    pub private_commit_bytes: usize,
    pub process_limit: u32,
    pub kill_on_close: bool,
    pub breakaway: bool,
    pub cpu_flags: u32,
    pub cpu_rate: u32,
    pub logical_cpus: u32,
}
pub struct Job {
    pub handle: Handle,
    pub budget: Budget,
    terminated: Arc<AtomicBool>,
    observation: JobObservation,
}

const JOB_COMPLETION_KEY: usize = 0x48334753;
const MAX_LIFETIME_PROCESSES: usize = 32;

struct ObservedProcess {
    held: HeldProcess,
    new_receipt: bool,
    exit_receipt: bool,
    image: Option<FileIdentity>,
    physical_exit: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeldIdentityReadback {
    pid: u32,
    pid_error: Option<i32>,
    created: Option<u64>,
    creation_error: Option<i32>,
}
impl HeldIdentityReadback {
    fn capture(handle: HANDLE) -> Self {
        let pid = unsafe { GetProcessId(handle) };
        let pid_error = (pid == 0).then(|| std::io::Error::last_os_error().raw_os_error());
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok =
            unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
        let creation_error = (ok == 0).then(|| std::io::Error::last_os_error().raw_os_error());
        Self {
            pid,
            pid_error: pid_error.flatten(),
            created: (ok != 0).then_some(
                (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime),
            ),
            creation_error: creation_error.flatten(),
        }
    }
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeldWaitReceipt {
    code: u32,
    win32_error: Option<i32>,
    remaining_ms: u32,
    elapsed_ms: u64,
    physical_phase_elapsed_ms: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeldExitDiagnostic<'a> {
    stage: &'static str,
    expected: &'a ProcessIdentity,
    actual: HeldIdentityReadback,
    wait: HeldWaitReceipt,
    job_terminated: bool,
    fatal_observed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosePhaseDiagnostic {
    stage: &'static str,
    elapsed_ms: u64,
    remaining_ms: u64,
    grace_ms: u64,
    reached_zero: bool,
    job_terminated: bool,
    fatal_observed: bool,
}
fn diagnostic_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}
fn exit_diagnostic_message(prefix: &str, value: &impl Serialize) -> String {
    // Fixed typed keys, numbers and booleans only; no page/process strings.
    match serde_json::to_string(value) {
        Ok(value) => format!("{prefix}: {value}"),
        Err(_) => format!("{prefix}: diagnostic serialization failed"),
    }
}
#[derive(Default)]
struct ObservationState {
    // This is the original Job owner's only process table. SDK collections
    // merely cross-check it; exited objects are retained until the final barrier.
    processes: std::collections::HashMap<u32, ObservedProcess>,
    root: Option<ProcessIdentity>,
    runtime: Option<Arc<VerifiedWorker>>,
}
struct JobObservation {
    state: Arc<Mutex<ObservationState>>,
    cancel: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    retirement: Arc<OnceLock<ObserverRetirement>>,
    retired: Arc<OnceLock<std::result::Result<(), String>>>,
    retain_only: Arc<AtomicBool>,
    fatal: Arc<AtomicBool>,
    fatal_receipt: Arc<OnceLock<String>>,
    #[cfg(test)]
    test_delay: Arc<ObserverDelay>,
    #[cfg(test)]
    test_port: Handle,
}
struct ObserverRetirement {
    resources: Mutex<Option<LaunchResources>>,
    cleanup: bool,
    deadline: Option<Instant>,
}
#[cfg(test)]
#[derive(Default)]
struct ObserverDelay {
    before_verification: AtomicBool,
    before_retirement: AtomicBool,
    reached: AtomicBool,
    release: AtomicBool,
    after_fatal: AtomicBool,
    fatal_reached: AtomicBool,
    fatal_release: AtomicBool,
    before_cleanup_submission: AtomicBool,
    caller_reached: AtomicBool,
    caller_release: AtomicBool,
}
#[cfg(test)]
impl ObserverDelay {
    fn pause_after_fatal(&self) {
        if self.after_fatal.load(Ordering::Acquire) {
            self.fatal_reached.store(true, Ordering::Release);
            while !self.fatal_release.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    fn pause_caller(&self) {
        if self.before_cleanup_submission.load(Ordering::Acquire) {
            self.caller_reached.store(true, Ordering::Release);
            while !self.caller_release.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    fn pause(&self, retirement: bool) {
        let enabled = if retirement {
            &self.before_retirement
        } else {
            &self.before_verification
        };
        if enabled.load(Ordering::Acquire) {
            self.reached.store(true, Ordering::Release);
            while !self.release.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
}
#[derive(Debug)]
struct ObserverCancelled;
impl std::fmt::Display for ObserverCancelled {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str("original observer cancelled before table acquisition")
    }
}
impl std::error::Error for ObserverCancelled {}
fn before_deadline(deadline: Instant, operation: &str) -> Result<()> {
    if Instant::now() >= deadline {
        bail!("{operation} deadline expired");
    }
    Ok(())
}
fn table_before(
    state: &Mutex<ObservationState>,
    deadline: Instant,
) -> Result<MutexGuard<'_, ObservationState>> {
    loop {
        before_deadline(deadline, "Job lifecycle table")?;
        match state.try_lock() {
            Ok(guard) => {
                before_deadline(deadline, "Job lifecycle table")?;
                return Ok(guard);
            }
            Err(TryLockError::Poisoned(_)) => bail!("Job lifecycle table poisoned"),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(1)),
        }
    }
}
fn observer_table<'a>(
    state: &'a Mutex<ObservationState>,
    cancel: &AtomicBool,
) -> Result<MutexGuard<'a, ObservationState>> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(anyhow::Error::new(ObserverCancelled));
        }
        match state.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => bail!("Job lifecycle table poisoned"),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(1)),
        }
    }
}
impl Drop for JobObservation {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            if unsafe { WaitForSingleObject(thread.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
                let _ = thread.join();
            } // otherwise its original Arc-owned resources survive in the detached thread
        }
    }
}
impl JobObservation {
    fn associate(job: &Handle, terminated: Arc<AtomicBool>) -> Result<Self> {
        let port = Handle::new(
            unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) },
            "create original Job completion port",
        )?;
        win(
            unsafe { SetHandleInformation(port.0, HANDLE_FLAG_INHERIT, 0) },
            "make Job completion port private",
        )?;
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: JOB_COMPLETION_KEY as *mut c_void,
            CompletionPort: port.0,
        };
        win(
            unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectAssociateCompletionPortInformation,
                    (&association as *const JOBOBJECT_ASSOCIATE_COMPLETION_PORT).cast(),
                    size_of_val(&association) as u32,
                )
            },
            "associate lifecycle observer before any Job assignment",
        )?;
        let owned_job = job.duplicate(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false)?;
        #[cfg(test)]
        let test_port = {
            let mut duplicate = null_mut();
            win(
                unsafe {
                    DuplicateHandle(
                        GetCurrentProcess(),
                        port.0,
                        GetCurrentProcess(),
                        &mut duplicate,
                        0,
                        0,
                        DUPLICATE_SAME_ACCESS,
                    )
                },
                "hold original test IOCP",
            )?;
            Handle::new(duplicate, "test IOCP")?
        };
        let state = Arc::new(Mutex::new(ObservationState::default()));
        let thread_state = state.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let thread_cancel = cancel.clone();
        let retirement = Arc::new(OnceLock::<ObserverRetirement>::new());
        let thread_retirement = retirement.clone();
        let retired = Arc::new(OnceLock::new());
        let thread_retired = retired.clone();
        let retain_only = Arc::new(AtomicBool::new(false));
        let thread_retain_only = retain_only.clone();
        let fatal = Arc::new(AtomicBool::new(false));
        let thread_fatal = fatal.clone();
        let fatal_receipt = Arc::new(OnceLock::new());
        let thread_fatal_receipt = fatal_receipt.clone();
        #[cfg(test)]
        let test_delay = Arc::new(ObserverDelay::default());
        #[cfg(test)]
        let thread_test_delay = test_delay.clone();
        let thread = std::thread::spawn(move || {
            // Capture the ownership wrappers, rather than their raw HANDLE fields.
            let completion_port = port;
            let observed_job = owned_job;
            while !thread_cancel.load(Ordering::Acquire) {
                let mut message = 0;
                let mut key = 0;
                let mut value = null_mut();
                let ok = unsafe {
                    GetQueuedCompletionStatus(
                        completion_port.0,
                        &mut message,
                        &mut key,
                        &mut value,
                        25,
                    )
                };
                if ok == 0 && unsafe { GetLastError() } == WAIT_TIMEOUT {
                    continue;
                }
                let result = (|| -> Result<()> {
                    win(ok, "receive original Job lifecycle message")?;
                    if key != JOB_COMPLETION_KEY {
                        bail!("original Job completion key differs");
                    }
                    let pid = u32::try_from(value as usize).context("Job event PID overflow")?;
                    match message {
                        JOB_OBJECT_MSG_NEW_PROCESS => {
                            // Acquire the actual object before taking the table lock or
                            // hashing an image. A vanished/reused PID is never inferred.
                            let held = HeldProcess::hold_in_job(pid, observed_job.0)?;
                            let verification = HeldProcess {
                                handle: held.handle.duplicate(
                                    PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                                    false,
                                )?,
                                identity: held.identity.clone(),
                            };
                            let mut state = observer_table(&thread_state, &thread_cancel)?;
                            if let Some(previous) = state.processes.get_mut(&pid) {
                                if previous.new_receipt
                                    || previous.held.identity.created != held.identity.created
                                {
                                    bail!("duplicate or reused PID in Job NEW_PROCESS");
                                }
                                previous.new_receipt = true;
                            } else {
                                if state.processes.len() >= MAX_LIFETIME_PROCESSES {
                                    bail!("Job lifetime process set exceeds32 held objects");
                                }
                                let root =
                                    state.root.as_ref().context("Job root was not admitted")?;
                                if held.identity.created < root.created || pid == root.pid {
                                    bail!("Job descendant creation identity precedes root");
                                }
                                state.processes.insert(
                                    pid,
                                    ObservedProcess {
                                        held,
                                        new_receipt: true,
                                        exit_receipt: false,
                                        image: None,
                                        physical_exit: false,
                                    },
                                );
                                let runtime = state
                                    .runtime
                                    .as_ref()
                                    .context("runtime pin missing before child creation")?
                                    .clone();
                                drop(state);
                                #[cfg(test)]
                                thread_test_delay.pause(false);
                                let image = verification.verify_runtime(&runtime)?;
                                let mut state = observer_table(&thread_state, &thread_cancel)?;
                                state.processes.get_mut(&pid).unwrap().image = Some(image);
                            }
                        }
                        JOB_OBJECT_MSG_EXIT_PROCESS | JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS => {
                            let mut state = observer_table(&thread_state, &thread_cancel)?;
                            let process = state
                                .processes
                                .get_mut(&pid)
                                .context("Job EXIT_PROCESS has no held NEW_PROCESS object")?;
                            if !process.new_receipt
                                || process.exit_receipt
                                || created(process.held.handle.0)? != process.held.identity.created
                                || unsafe { GetProcessId(process.held.handle.0) } != pid
                            {
                                bail!("Job EXIT_PROCESS identity or receipt differs");
                            }
                            // A completion message may precede the physical exit event.
                            // The close barrier separately waits this same held handle.
                            process.exit_receipt = true;
                        }
                        JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO => {}
                        _ => bail!("Job limit or unexpected lifecycle message {message}"),
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    if error.is::<ObserverCancelled>() {
                        break;
                    }
                    // Publication cannot depend on the process-table lock or
                    // successful termination. The bit is authoritative even
                    // while its bounded diagnostic receipt is still pending.
                    thread_fatal.store(true, Ordering::Release);
                    let _ =
                        thread_fatal_receipt.set(format!("{error:#}").chars().take(1024).collect());
                    #[cfg(test)]
                    thread_test_delay.pause_after_fatal();
                    if unsafe { TerminateJobObject(observed_job.0, 0x4753) } != 0 {
                        terminated.store(true, Ordering::Release);
                    }
                    // Continue draining exits of already held objects. A failure
                    // remains sticky and can never qualify or permit file cleanup.
                }
            }
            #[cfg(test)]
            thread_test_delay.pause(true);
            let result = (|| -> Result<()> {
                let Some(retirement) = thread_retirement.get() else {
                    return Ok(());
                };
                let mut resources = retirement
                    .resources
                    .try_lock()
                    .map_err(|_| {
                        anyhow::anyhow!("original observer retirement resources unavailable")
                    })?
                    .take()
                    .context("original observer retirement resources already taken")?;
                // The same native owner retains the payload while any native
                // verification or cleanup stalls; failed callers never join it.
                if retirement.cleanup {
                    if thread_fatal.load(Ordering::Acquire) {
                        bail!("fatal original observer cannot clean session resources");
                    }
                    if thread_retain_only.load(Ordering::Acquire) {
                        bail!("original observer cleanup retained after close failure");
                    }
                    before_deadline(
                        retirement
                            .deadline
                            .context("cleanup retirement deadline missing")?,
                        "original observer cleanup",
                    )?;
                    let mut state = thread_state.try_lock().map_err(|_| {
                        anyhow::anyhow!("Job lifecycle table unavailable at retirement")
                    })?;
                    if state.processes.values().any(|p| !p.physical_exit) {
                        bail!("observer cannot clean resources without complete physical exits");
                    }
                    for process in state.processes.values_mut() {
                        process.held.handle.close();
                    }
                    drop(state);
                    resources.thread.close();
                    resources.process.close();
                    resources.staged.take();
                    resources.control_read.take();
                    resources.control_write.take();
                    resources.resource_read.take();
                    resources.resource_write.take();
                    before_deadline(retirement.deadline.unwrap(), "original observer cleanup")?;
                    resources.profile.cleaned = false;
                    if let Err(error) = resources.profile.cleanup() {
                        resources.profile.cleaned = true;
                        return Err(error);
                    }
                }
                Ok(())
            })();
            let _ = thread_retired.set(result.map_err(|error| format!("{error:#}")));
            // Keep the original payload and pinned table alive until this
            // thread's retirement tail has actually finished.
            drop(thread_retirement);
        });
        Ok(Self {
            state,
            cancel,
            thread: Some(thread),
            retirement,
            retired,
            retain_only,
            fatal,
            fatal_receipt,
            #[cfg(test)]
            test_delay,
            #[cfg(test)]
            test_port,
        })
    }
}
/// A synchronous window call must not disable the manager's stop deadline.
/// Only a non-inheritable handle to this already-admitted Job is held here.
pub struct JobDeadline {
    cancel: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<Result<bool>>>,
}
impl JobDeadline {
    pub fn finish(mut self) -> Result<bool> {
        self.cancel.take().map(|cancel| cancel.send(()));
        self.thread
            .take()
            .context("Job deadline thread already finished")?
            .join()
            .map_err(|_| anyhow::anyhow!("Job deadline thread panicked"))?
    }
}
impl Drop for JobDeadline {
    fn drop(&mut self) {
        self.cancel.take().map(|cancel| cancel.send(()));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Job {
    pub fn create() -> Result<Self> {
        let cpus = unsafe { GetActiveProcessorCount(0xffff) };
        let budget = Budget {
            private_commit_bytes: 536870912,
            process_limit: 32,
            logical_cpus: cpus,
            cpu_rate: 10000u32.checked_div(cpus).unwrap_or(0),
        };
        budget.validate()?;
        let handle = Handle::new(
            unsafe { CreateJobObjectW(null(), null()) },
            "CreateJobObjectW",
        )?;
        let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | JOB_OBJECT_LIMIT_JOB_MEMORY
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
                ActiveProcessLimit: 32,
                ..Default::default()
            },
            JobMemoryLimit: 536870912,
            ..Default::default()
        };
        win(
            unsafe {
                SetInformationJobObject(
                    handle.0,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of_val(&limits) as u32,
                )
            },
            "set Job hard limits",
        )?;
        let cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
            Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 {
                CpuRate: budget.cpu_rate,
            },
        };
        win(
            unsafe {
                SetInformationJobObject(
                    handle.0,
                    JobObjectCpuRateControlInformation,
                    (&cpu as *const JOBOBJECT_CPU_RATE_CONTROL_INFORMATION).cast(),
                    size_of_val(&cpu) as u32,
                )
            },
            "set Job CPU hard cap",
        )?;
        let terminated = Arc::new(AtomicBool::new(false));
        let observation = JobObservation::associate(&handle, terminated.clone())?;
        let value = Self {
            handle,
            budget,
            terminated,
            observation,
        };
        value.evidence()?;
        Ok(value)
    }
    pub fn evidence(&self) -> Result<JobEvidence> {
        let limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
            self.query(JobObjectExtendedLimitInformation)?;
        let cpu: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION =
            self.query(JobObjectCpuRateControlInformation)?;
        let required = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        let flags = limits.BasicLimitInformation.LimitFlags;
        if flags != required
            || limits.JobMemoryLimit != 536870912
            || limits.BasicLimitInformation.ActiveProcessLimit != 32
            || cpu.ControlFlags
                != (JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP)
            || unsafe { cpu.Anonymous.CpuRate } != self.budget.cpu_rate
        {
            bail!("Job limit readback differs from frozen contract");
        }
        Ok(JobEvidence {
            private_commit_bytes: limits.JobMemoryLimit,
            process_limit: 32,
            kill_on_close: true,
            breakaway: false,
            cpu_flags: cpu.ControlFlags,
            cpu_rate: unsafe { cpu.Anonymous.CpuRate },
            logical_cpus: self.budget.logical_cpus,
        })
    }
    fn query<T: Default>(&self, class: JOBOBJECTINFOCLASS) -> Result<T> {
        let mut value = T::default();
        let mut length = 0;
        win(
            unsafe {
                QueryInformationJobObject(
                    self.handle.0,
                    class,
                    (&mut value as *mut T).cast(),
                    size_of::<T>() as u32,
                    &mut length,
                )
            },
            "QueryInformationJobObject",
        )?;
        if length != size_of::<T>() as u32 {
            bail!("Job readback length mismatch");
        }
        Ok(value)
    }
    pub fn contains(&self, process: HANDLE) -> Result<()> {
        let mut yes = 0;
        win(
            unsafe { IsProcessInJob(process, self.handle.0, &mut yes) },
            "IsProcessInJob",
        )?;
        if yes != 1 {
            bail!("process is outside owned Job");
        }
        Ok(())
    }
    pub fn active(&self) -> Result<u32> {
        Ok(self
            .query::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(JobObjectBasicAccountingInformation)?
            .ActiveProcesses)
    }
    pub fn register_suspended_root(&self, process: HANDLE, pin: &VerifiedWorker) -> Result<()> {
        if self.active()? != 0 {
            bail!("Job root must be registered before any assignment");
        }
        let source = std::mem::ManuallyDrop::new(Handle(process));
        let handle = source.duplicate(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false)?;
        let held = HeldProcess {
            identity: ProcessIdentity {
                pid: unsafe { GetProcessId(handle.0) },
                created: created(handle.0)?,
                kind: -1,
            },
            handle,
        };
        let image = held.verify_runtime(pin)?;
        let mut state = table_before(
            &self.observation.state,
            Instant::now() + Duration::from_millis(100),
        )?;
        if state.root.is_some() || !state.processes.is_empty() {
            bail!("Job root already registered");
        }
        state.root = Some(held.identity.clone());
        state.processes.insert(
            held.identity.pid,
            ObservedProcess {
                held,
                new_receipt: false,
                exit_receipt: false,
                image: Some(image),
                physical_exit: false,
            },
        );
        Ok(())
    }
    pub fn install_runtime_pin(&self, runtime: &VerifiedWorker) -> Result<()> {
        let pin = Arc::new(VerifiedWorker {
            file: runtime
                .file
                .try_clone()
                .context("retain original runtime file pin")?,
            identity: runtime.identity.clone(),
        });
        let mut state = table_before(
            &self.observation.state,
            Instant::now() + Duration::from_millis(100),
        )?;
        if state.runtime.is_some() || state.processes.len() != 1 {
            bail!("runtime pin must be installed once before root resume");
        }
        state.runtime = Some(pin);
        Ok(())
    }
    pub fn observation_health(&self) -> Result<()> {
        self.observation_health_before(Instant::now() + Duration::from_millis(100))
    }
    fn fatal_health(&self) -> Result<()> {
        if self.observation.fatal.load(Ordering::Acquire) {
            bail!(
                "original Job fatal observation: {}",
                self.observation
                    .fatal_receipt
                    .get()
                    .map(String::as_str)
                    .unwrap_or("fatal recorded; diagnostic pending")
            );
        }
        Ok(())
    }
    pub fn qualification_clean(&self) -> bool {
        !self.observation.fatal.load(Ordering::Acquire) && !self.terminated.load(Ordering::Acquire)
    }
    fn observation_health_before(&self, deadline: Instant) -> Result<()> {
        before_deadline(deadline, "Job observation health")?;
        self.fatal_health()?;
        if self
            .observation
            .thread
            .as_ref()
            .is_none_or(|thread| thread.is_finished())
        {
            bail!("original Job lifecycle observer stopped");
        }
        self.fatal_health()?;
        before_deadline(deadline, "Job observation health")
    }
    /// Windows documents Job completion notifications as potentially lost.
    /// Cumulative accounting detects omitted NEW/EXIT messages, including a
    /// short-lived process absent from every active-PID or SDK snapshot.
    fn reconcile_observation(&self, deadline: Instant, require_exit: bool) -> Result<()> {
        loop {
            self.observation_health_before(deadline)?;
            let accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION =
                self.query(JobObjectBasicAccountingInformation)?;
            if accounting.TotalProcesses > MAX_LIFETIME_PROCESSES as u32 {
                bail!("original Job cumulative process count exceeds32");
            }
            let actual = self.pids()?;
            // TotalTerminatedProcesses counts limit violations, not ordinary
            // exits. This non-breakaway Job's lifetime total minus active count
            // is the independent count of objects which have left the tree.
            let inactive = accounting
                .TotalProcesses
                .checked_sub(accounting.ActiveProcesses)
                .context("Job active count exceeds cumulative creation count")?;
            let state = table_before(&self.observation.state, deadline)?;
            let new_count = state.processes.values().filter(|p| p.new_receipt).count();
            let exit_count = state.processes.values().filter(|p| p.exit_receipt).count();
            let matched = accounting.TotalProcesses as usize == new_count
                && (!require_exit || inactive as usize == exit_count)
                && state.processes.len() == new_count
                && state.processes.values().all(|p| p.image.is_some())
                && actual.iter().all(|pid| state.processes.contains_key(pid))
                && (!require_exit || (accounting.ActiveProcesses == 0 && new_count == exit_count));
            drop(state);
            self.fatal_health()?;
            before_deadline(deadline, "Job lifecycle accounting reconciliation")?;
            if matched {
                return Ok(());
            }
            if Instant::now() >= deadline {
                bail!("Job lifecycle messages/accounting incomplete: total={}, inactive={}, NEW={new_count}, EXIT={exit_count}",
                    accounting.TotalProcesses, inactive);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    pub fn verify_environment(&self, processes: &[ProcessIdentity]) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(2);
        self.reconcile_observation(deadline, false)?;
        let actual = self.pids()?;
        let mut state = table_before(&self.observation.state, deadline)?;
        let root_pid = state
            .root
            .as_ref()
            .context("missing original Job root")?
            .pid;
        let mut reported = std::collections::HashSet::new();
        for process in processes {
            if !reported.insert(process.pid)
                || process.pid == root_pid
                || !actual.contains(&process.pid)
            {
                bail!("duplicate or non-current Job runtime identity in SDK collection");
            }
            let held = state
                .processes
                .get_mut(&process.pid)
                .context("SDK process has no lifecycle-held object")?;
            self.contains(held.held.handle.0)?;
            if held.held.identity.created != process.created
                || held.image.is_none()
                || created(held.held.handle.0)? != process.created
            {
                bail!("SDK and held Job process creation or image identity differ");
            }
            held.held.identity.kind = process.kind;
        }
        before_deadline(deadline, "SDK process cross-check")
    }
    pub fn observed_runtime_count(&self) -> Result<usize> {
        self.observation_health()?;
        let state = table_before(
            &self.observation.state,
            Instant::now() + Duration::from_millis(100),
        )?;
        Ok(state.processes.len().saturating_sub(1))
    }
    pub fn observation_evidence(&self) -> Result<serde_json::Value> {
        self.observation_evidence_before(Instant::now() + Duration::from_millis(100))
    }
    fn observation_evidence_before(&self, deadline: Instant) -> Result<serde_json::Value> {
        before_deadline(deadline, "Job observation evidence")?;
        let accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION =
            self.query(JobObjectBasicAccountingInformation)?;
        let state = table_before(&self.observation.state, deadline)?;
        let mut processes = state.processes.values().map(|p| {
            serde_json::json!({"identity":p.held.identity,"newProcessReceipt":p.new_receipt,
                "exitProcessReceipt":p.exit_receipt,"imagePinVerified":p.image.is_some(),"actualImage":p.image,
                "physicalExitSignalled":p.physical_exit || unsafe{WaitForSingleObject(p.held.handle.0,0)}==WAIT_OBJECT_0})
        }).collect::<Vec<_>>();
        processes.sort_by_key(|p| p["identity"]["pid"].as_u64());
        let fatal = self.observation.fatal.load(Ordering::Acquire);
        let terminated = self.terminated.load(Ordering::Acquire);
        let failure = self
            .observation
            .fatal_receipt
            .get()
            .cloned()
            .or_else(|| fatal.then(|| "fatal recorded; diagnostic pending".into()));
        before_deadline(deadline, "Job observation evidence")?;
        Ok(
            serde_json::json!({"source":"originalJobCompletionPort","heldObjectLimit":32,
            "totalProcesses":accounting.TotalProcesses,"activeProcesses":accounting.ActiveProcesses,
            "inactiveProcesses":accounting.TotalProcesses.checked_sub(accounting.ActiveProcesses),
            "fatalObserved":fatal,"jobTerminated":terminated,"failure":failure,"processes":processes}),
        )
    }
    #[cfg(test)]
    pub fn wait_observed_exit(&self, deadline: Instant) -> Result<()> {
        self.wait_physical_tree_exit(deadline)?;
        self.reconcile_observation(deadline, true)?;
        Ok(())
    }
    fn wait_physical_tree_exit(&self, deadline: Instant) -> Result<bool> {
        let physical_started = Instant::now();
        // Keep the listener unblocked while active members can create children.
        // A completion EXIT packet is advisory; the retained object's signalled
        // kernel event is the physical-exit authority even for a never-run root.
        loop {
            self.reconcile_observation(deadline, false)?;
            if self.active()? == 0 {
                break;
            }
            if Instant::now() >= deadline {
                bail!("original Job physical tree exit deadline");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut state = table_before(&self.observation.state, deadline)?;
        for process in state.processes.values_mut() {
            self.fatal_health()?;
            before_deadline(deadline, "held process physical exit")?;
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(u32::MAX as u128) as u32;
            let wait_started = Instant::now();
            let wait_code = unsafe { WaitForSingleObject(process.held.handle.0, remaining) };
            // Save WAIT_FAILED's native error before any identity getter or
            // other native operation can overwrite this thread's last error.
            let wait_error = (wait_code == WAIT_FAILED)
                .then(|| std::io::Error::last_os_error().raw_os_error())
                .flatten();
            let wait = HeldWaitReceipt {
                code: wait_code,
                win32_error: wait_error,
                remaining_ms: remaining,
                elapsed_ms: diagnostic_millis(wait_started.elapsed()),
                physical_phase_elapsed_ms: diagnostic_millis(physical_started.elapsed()),
            };
            let diagnostic = || {
                exit_diagnostic_message(
                    "lifecycle-held process physical exit or creation barrier incomplete",
                    &HeldExitDiagnostic {
                        stage: "heldProcessPhysicalExit",
                        expected: &process.held.identity,
                        actual: HeldIdentityReadback::capture(process.held.handle.0),
                        wait,
                        job_terminated: self.terminated.load(Ordering::Acquire),
                        fatal_observed: self.observation.fatal.load(Ordering::Acquire),
                    },
                )
            };
            if wait_code != WAIT_OBJECT_0
                || created(process.held.handle.0).with_context(diagnostic)?
                    != process.held.identity.created
                || unsafe { GetProcessId(process.held.handle.0) } != process.held.identity.pid
            {
                bail!("{}", diagnostic());
            }
            before_deadline(deadline, "held process physical exit")?;
            self.fatal_health()?;
            process.physical_exit = true;
        }
        drop(state);
        // Once every accounted object physically exited no Job member can
        // create another child. Final accounting also catches missing tails.
        self.reconcile_observation(deadline, false)?;
        let receipt_deadline = deadline.min(Instant::now() + Duration::from_millis(100));
        let complete = self.reconcile_observation(receipt_deadline, true).is_ok();
        self.observation_health_before(deadline)?;
        // Missing EXIT notifications veto qualification. Complete held NEW
        // identity/accounting plus every physical event still proves safe
        // cleanup; unknown/missing NEW objects never reach this point.
        self.reconcile_observation(deadline, false)?;
        Ok(complete)
    }
    fn retire_before(&mut self, deadline: Instant) -> Result<()> {
        before_deadline(deadline, "original observer retirement")?;
        self.fatal_health()?;
        self.observation.cancel.store(true, Ordering::Release);
        let thread = self
            .observation
            .thread
            .as_ref()
            .context("original observer already retired")?;
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u32::MAX as u128) as u32;
        if unsafe { WaitForSingleObject(thread.as_raw_handle(), remaining) } != WAIT_OBJECT_0 {
            self.observation.retain_only.store(true, Ordering::Release);
            bail!("original observer did not physically exit before retirement deadline");
        }
        before_deadline(deadline, "original observer retirement")?;
        self.fatal_health()?;
        self.observation
            .thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| anyhow::anyhow!("Job lifecycle observer panicked"))?;
        match self
            .observation
            .retired
            .get()
            .context("observer retirement receipt missing")?
        {
            Ok(()) => {}
            Err(error) => bail!("original observer retirement failed: {error}"),
        }
        before_deadline(deadline, "original observer retirement")?;
        self.fatal_health()?;
        Ok(())
    }
    pub fn pids(&self) -> Result<Vec<u32>> {
        #[repr(C)]
        struct List {
            assigned: u32,
            count: u32,
            pids: [usize; 32],
        }
        let mut list = List {
            assigned: 0,
            count: 0,
            pids: [0; 32],
        };
        win(
            unsafe {
                QueryInformationJobObject(
                    self.handle.0,
                    JobObjectBasicProcessIdList,
                    (&mut list as *mut List).cast(),
                    size_of_val(&list) as u32,
                    null_mut(),
                )
            },
            "owned Job process list",
        )?;
        if list.count > 32 || list.assigned != list.count {
            bail!("incomplete owned Job process list");
        }
        list.pids[..list.count as usize]
            .iter()
            .map(|pid| u32::try_from(*pid).context("PID overflow"))
            .collect()
    }
    #[cfg(test)]
    pub fn wait_zero(&self, timeout: Duration) -> Result<bool> {
        self.wait_zero_before(Instant::now() + timeout)
    }
    fn wait_zero_before(&self, deadline: Instant) -> Result<bool> {
        loop {
            if Instant::now() >= deadline {
                return Ok(false);
            }
            if self.active()? == 0 {
                return Ok(Instant::now() < deadline);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    pub fn terminate(&self) -> Result<()> {
        win(
            unsafe { TerminateJobObject(self.handle.0, 0x4753) },
            "terminate only owned Job",
        )?;
        self.terminated.store(true, Ordering::Release);
        Ok(())
    }
    pub fn deadline(&self, deadline: Instant) -> Result<JobDeadline> {
        let handle = self.handle.duplicate(JOB_OBJECT_TERMINATE, false)?;
        let terminated = self.terminated.clone();
        let (cancel, receiver) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let deadline_handle = handle;
            match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Ok(false),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    win(
                        unsafe { TerminateJobObject(deadline_handle.0, 0x4753) },
                        "deadline terminates only admitted Job",
                    )?;
                    terminated.store(true, Ordering::Release);
                    Ok(true)
                }
            }
        });
        Ok(JobDeadline {
            cancel: Some(cancel),
            thread: Some(thread),
        })
    }
}
pub struct HeldProcess {
    pub handle: Handle,
    pub identity: ProcessIdentity,
}
impl HeldProcess {
    /// Enumerate and hold the actual Job tree, including runtime helpers that
    /// WebView2's environment process collection does not expose.
    #[cfg(test)]
    pub fn hold(pid: u32, job: &Job) -> Result<Self> {
        Self::hold_in_job(pid, job.handle.0)
    }
    fn hold_in_job(pid: u32, job: HANDLE) -> Result<Self> {
        let handle = Handle::new(
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) },
            "hold WebView process",
        )?;
        let mut in_job = 0;
        win(
            unsafe { IsProcessInJob(handle.0, job, &mut in_job) },
            "hold actual Job member",
        )?;
        if in_job != 1 || unsafe { GetProcessId(handle.0) } != pid {
            bail!("NEW_PROCESS PID does not identify this original Job member");
        }
        let identity = ProcessIdentity {
            pid,
            created: created(handle.0)?,
            kind: -1,
        };
        Ok(Self { handle, identity })
    }
    pub fn verify_runtime(&self, runtime: &VerifiedWorker) -> Result<FileIdentity> {
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        win(
            unsafe { QueryFullProcessImageNameW(self.handle.0, 0, path.as_mut_ptr(), &mut length) },
            "query held Job member executable",
        )?;
        let path = PathBuf::from(String::from_utf16(&path[..length as usize])?);
        // The original pin denies write/delete sharing and already owns its
        // SHA256. Reopening this held process's image must identify that same
        // immutable physical file; no child needs to reread its bytes.
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&path)
            .context("open actual held process image for physical identity")?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) },
            "actual held process physical image identity",
        )?;
        let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        let bytes = (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow);
        if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0
            || info.dwVolumeSerialNumber != runtime.identity.volume
            || index != runtime.identity.file_index
            || bytes != runtime.identity.bytes
        {
            bail!(
                "actual image {} differs from original pinned file identity/size",
                path.display()
            );
        }
        if created(self.handle.0)? != self.identity.created {
            bail!("held Job member creation identity changed");
        }
        Ok(FileIdentity {
            path: path.to_string_lossy().into(),
            sha256: runtime.identity.sha256.clone(),
            volume: info.dwVolumeSerialNumber,
            file_index: index,
            bytes,
        })
    }
}
fn pipe() -> Result<(File, File)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    win(
        unsafe { CreatePipe(&mut read, &mut write, &attributes, 64 * 1024) },
        "CreatePipe",
    )?;
    Ok(unsafe { (File::from_raw_handle(read), File::from_raw_handle(write)) })
}
fn private(file: &File) -> Result<()> {
    win(
        unsafe { SetHandleInformation(file.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) },
        "clear parent pipe inheritance",
    )
}
struct Attributes {
    _buffer: Vec<usize>,
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new() -> Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 65536 {
            bail!("invalid process attribute list size");
        }
        let mut buffer = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let pointer = buffer.as_mut_ptr().cast();
        win(
            unsafe { InitializeProcThreadAttributeList(pointer, 2, 0, &mut bytes) },
            "InitializeProcThreadAttributeList",
        )?;
        Ok(Self {
            _buffer: buffer,
            pointer,
        })
    }
    fn set(&mut self, kind: u32, data: *mut c_void, size: usize) -> Result<()> {
        win(
            unsafe {
                UpdateProcThreadAttribute(
                    self.pointer,
                    0,
                    kind as usize,
                    data,
                    size,
                    null_mut(),
                    null(),
                )
            },
            "UpdateProcThreadAttribute",
        )
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
    }
}
pub struct Launch {
    resources: Option<LaunchResources>,
    pub job: Job,
    pub closed: bool,
    close_started: bool,
}
pub struct LaunchResources {
    pub profile: Profile,
    pub source: VerifiedWorker,
    pub staged: Option<VerifiedWorker>,
    pub process: Handle,
    pub thread: Handle,
    pub parent_identity: Handle,
    pub control_read: Option<File>,
    pub control_write: Option<File>,
    pub resource_read: Option<File>,
    pub resource_write: Option<File>,
    pub token: TokenEvidence,
    pub worker: ProcessIdentity,
}
impl std::ops::Deref for Launch {
    type Target = LaunchResources;
    fn deref(&self) -> &LaunchResources {
        self.resources
            .as_ref()
            .expect("Launch resources already retired")
    }
}
impl std::ops::DerefMut for Launch {
    fn deref_mut(&mut self) -> &mut LaunchResources {
        self.resources
            .as_mut()
            .expect("Launch resources already retired")
    }
}
impl Launch {
    pub fn suspended(path: &Path, expected_hash: Option<&str>, output: &Path) -> Result<Self> {
        let mut trace = serde_json::json!({"schemaVersion":1,"phase":"sandboxFoundation","stage":"profileCreate","expectedWorkerHash":expected_hash,"parentPid":unsafe{GetCurrentProcessId()},"resumed":false});
        record_trace(output, &trace)?;
        let result = Self::suspended_traced(path, expected_hash, output, &mut trace);
        if let Err(error) = &result {
            trace["error"] = serde_json::json!(format!("{error:#}"));
            if let Some(root) = trace["profile"]["root"].as_str() {
                trace["sessionFilesRemoved"] = serde_json::json!(!Path::new(root).exists());
            }
            let _ = record_trace(output, &trace);
        }
        result
    }
    fn suspended_traced(
        path: &Path,
        expected_hash: Option<&str>,
        output: &Path,
        trace: &mut serde_json::Value,
    ) -> Result<Self> {
        let mut profile = Profile::create()?;
        trace["profile"] = serde_json::json!({"sid":profile.sid_text,"root":profile.root,"udf":profile.udf,"staging":profile.staging,"capabilityCount":0,"aclScope":"sessionDirectoriesOnly"});
        trace["stage"] = serde_json::json!("binaryAdmission");
        record_trace(output, trace)?;
        let mut source = VerifiedWorker::open(path, expected_hash)?;
        let staged = source.stage(&profile)?;
        trace["sourceBinary"] = serde_json::to_value(&source.identity)?;
        trace["stagedBinary"] = serde_json::to_value(&staged.identity)?;
        trace["stage"] = serde_json::json!("jobCreate");
        record_trace(output, trace)?;
        let job = Job::create()?;
        trace["job"] = serde_json::to_value(job.evidence()?)?;
        record_trace(output, trace)?;
        let (child_control_read, parent_control_write) = pipe()?;
        private(&parent_control_write)?;
        let (parent_control_read, child_control_write) = pipe()?;
        private(&parent_control_read)?;
        let (parent_resource_read, child_resource_write) = pipe()?;
        private(&parent_resource_read)?;
        let (child_resource_read, parent_resource_write) = pipe()?;
        private(&parent_resource_write)?;
        let parent_source = Handle::new(
            unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                    0,
                    GetCurrentProcessId(),
                )
            },
            "parent identity",
        )?;
        let parent_identity =
            parent_source.duplicate(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, true)?;
        let mut handles = [
            child_control_read.as_raw_handle(),
            child_control_write.as_raw_handle(),
            child_resource_read.as_raw_handle(),
            child_resource_write.as_raw_handle(),
            parent_identity.0,
        ];
        let mut security = SECURITY_CAPABILITIES {
            AppContainerSid: profile.sid,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        let mut attributes = Attributes::new()?;
        attributes.set(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            handles.as_mut_ptr().cast(),
            size_of_val(&handles),
        )?;
        attributes.set(
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            (&mut security as *mut SECURITY_CAPABILITIES).cast(),
            size_of_val(&security),
        )?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = attributes.pointer;
        let exe = PathBuf::from(&staged.identity.path);
        let mut command = wide(format!(
            "\"{}\" --wallpaper-worker {} {} {} {} {}",
            exe.display(),
            handles[0] as usize,
            handles[1] as usize,
            handles[2] as usize,
            handles[3] as usize,
            handles[4] as usize
        ));
        let environment = environment(&profile)?;
        let mut info = PROCESS_INFORMATION::default();
        trace["stage"] = serde_json::json!("createSuspendedAppContainer");
        trace["inheritedHandleCount"] = serde_json::json!(handles.len());
        trace["environmentKeys"] = serde_json::json!([
            "LOCALAPPDATA",
            "PATH",
            "SystemRoot",
            "TEMP",
            "TMP",
            "WINDIR"
        ]);
        record_trace(output, trace)?;
        win(
            unsafe {
                CreateProcessW(
                    wide(&exe).as_ptr(),
                    command.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                    environment.as_ptr().cast(),
                    wide(&profile.staging).as_ptr(),
                    &startup.StartupInfo,
                    &mut info,
                )
            },
            "CreateProcessW AppContainer suspended",
        )?;
        let process = Handle::new(info.hProcess, "worker process")?;
        let thread = Handle::new(info.hThread, "worker thread")?;
        // Any failure after creation kills the still-suspended process through its owned handle.
        let mut assigned_to_job = false;
        let validation = (|| -> Result<_> {
            trace["stage"] = serde_json::json!("assignJobAndInspectToken");
            trace["createdWorker"] =
                serde_json::json!({"pid":info.dwProcessId,"created":created(process.0)?});
            record_trace(output, trace)?;
            job.register_suspended_root(process.0, &staged)?;
            win(
                unsafe { AssignProcessToJobObject(job.handle.0, process.0) },
                "assign suspended worker to owned Job",
            )?;
            assigned_to_job = true;
            job.contains(process.0)?;
            job.evidence()?;
            job.reconcile_observation(Instant::now() + Duration::from_secs(2), false)?;
            let token = inspect_token(process.0)?;
            if token.sid != profile.sid_text {
                bail!("created token AppContainer SID mismatch");
            }
            let worker = ProcessIdentity {
                pid: info.dwProcessId,
                created: created(process.0)?,
                kind: -1,
            };
            Ok((token, worker))
        })();
        let (token, worker) = match validation {
            Ok(value) => value,
            Err(error) => {
                let exited = if assigned_to_job {
                    job.terminate()
                        .and_then(|_| {
                            job.wait_physical_tree_exit(Instant::now() + Duration::from_secs(5))
                                .map(|_| ())
                        })
                        .is_ok()
                } else {
                    unsafe {
                        TerminateProcess(process.0, 0x4753);
                    }
                    (unsafe { WaitForSingleObject(process.0, 5000) }) == WAIT_OBJECT_0
                };
                if !exited {
                    profile.cleaned = true;
                }
                return Err(error);
            }
        };
        drop((
            child_control_read,
            child_control_write,
            child_resource_read,
            child_resource_write,
        ));
        // Construct the existing Launch owner before fallible receipt writes:
        // every subsequent failure uses its canonical physical-exit barrier.
        let launch = Self {
            resources: Some(LaunchResources {
                profile,
                source,
                staged: Some(staged),
                process,
                thread,
                parent_identity,
                control_read: Some(parent_control_read),
                control_write: Some(parent_control_write),
                resource_read: Some(parent_resource_read),
                resource_write: Some(parent_resource_write),
                token,
                worker,
            }),
            job,
            closed: false,
            close_started: false,
        };
        win(
            unsafe { SetHandleInformation(launch.parent_identity.0, HANDLE_FLAG_INHERIT, 0) },
            "clear parent identity inheritance",
        )?;
        trace["token"] = serde_json::to_value(&launch.token)?;
        trace["worker"] = serde_json::to_value(&launch.worker)?;
        trace["jobMembershipConfirmed"] = serde_json::json!(true);
        trace["lifecycleAssociatedBeforeAssignment"] = serde_json::json!(true);
        trace["processLifecycle"] = launch.job.observation_evidence()?;
        trace["stage"] = serde_json::json!("suspendedAdmissionComplete");
        record_trace(output, trace)?;
        Ok(launch)
    }
    pub fn resume(&self) -> Result<()> {
        self.job.observation_health()?;
        if table_before(
            &self.job.observation.state,
            Instant::now() + Duration::from_millis(100),
        )?
        .runtime
        .is_none()
        {
            bail!("runtime executable pin must precede worker resume");
        }
        if unsafe { ResumeThread(self.thread.0) } != 1 {
            bail!("worker resume did not release exactly one suspension");
        }
        Ok(())
    }
    pub fn close(&mut self) -> Result<serde_json::Value> {
        self.close_before(
            Instant::now() + Duration::from_secs(10),
            Duration::from_secs(5),
        )
    }
    fn close_before(
        &mut self,
        exit_deadline: Instant,
        grace: Duration,
    ) -> Result<serde_json::Value> {
        if self.close_started {
            bail!("original Launch close already started or failed");
        }
        self.close_started = true;
        let result = self.close_owned_before(exit_deadline, grace);
        if result.is_err() {
            self.job
                .observation
                .retain_only
                .store(true, Ordering::Release);
        }
        result
    }
    fn enqueue_resources(&mut self, cleanup: bool, deadline: Option<Instant>) -> Result<()> {
        let mut resources = self
            .resources
            .take()
            .context("Launch resources already retired")?;
        // Auto-Drop may never erase a failed or deferred session. Only the
        // explicit original-observer cleanup tail may reopen this cleanup gate.
        resources.profile.cleaned = true;
        let retirement = ObserverRetirement {
            resources: Mutex::new(Some(resources)),
            cleanup,
            deadline,
        };
        if let Err(retirement) = self.job.observation.retirement.set(retirement) {
            self.resources = retirement
                .resources
                .into_inner()
                .map_err(|_| anyhow::anyhow!("unsubmitted retirement resources poisoned"))?;
            bail!("original Launch resource bundle already submitted");
        }
        Ok(())
    }
    fn close_owned_before(
        &mut self,
        exit_deadline: Instant,
        grace: Duration,
    ) -> Result<serde_json::Value> {
        let close_started = Instant::now();
        before_deadline(exit_deadline, "original Launch close")?;
        self.control_write.take();
        // One overall deadline covers graceful exit, termination, complete
        // lifecycle receipts and every held object's physical exit event.
        let reached_zero = self
            .job
            .wait_zero_before(exit_deadline.min(Instant::now() + grace))?;
        before_deadline(exit_deadline, "original Launch close")?;
        if !reached_zero {
            self.job.terminate()?;
        }
        let completion_messages_complete = self
            .job
            .wait_physical_tree_exit(exit_deadline)
            .with_context(|| {
                exit_diagnostic_message(
                    "original Launch close phase",
                    &ClosePhaseDiagnostic {
                        stage: "physicalTreeExit",
                        elapsed_ms: diagnostic_millis(close_started.elapsed()),
                        remaining_ms: diagnostic_millis(
                            exit_deadline.saturating_duration_since(Instant::now()),
                        ),
                        grace_ms: diagnostic_millis(grace),
                        reached_zero,
                        job_terminated: self.job.terminated.load(Ordering::Acquire),
                        fatal_observed: self.job.observation.fatal.load(Ordering::Acquire),
                    },
                )
            })?;
        if unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0
            || created(self.process.0)? != self.worker.created
        {
            bail!("owned worker exit event did not signal after Job zero");
        }
        let lifecycle = self.job.observation_evidence_before(exit_deadline)?;
        let mut exit = 0;
        win(
            unsafe { GetExitCodeProcess(self.process.0, &mut exit) },
            "worker exit code",
        )?;
        #[cfg(test)]
        self.job.observation.test_delay.pause_caller();
        before_deadline(exit_deadline, "original Launch close")?;
        self.job.fatal_health()?;
        self.enqueue_resources(true, Some(exit_deadline))?;
        self.job.retire_before(exit_deadline)?;
        before_deadline(exit_deadline, "original Launch close")?;
        self.job.fatal_health()?;
        let was_terminated = self.job.terminated.load(Ordering::Acquire);
        let graceful = reached_zero && !was_terminated && completion_messages_complete;
        self.closed = true;
        Ok(
            serde_json::json!({"gracefulTreeExit":graceful,"jobTerminated":was_terminated,"activeProcesses":0,"workerExitCode":exit,"profileAndDirectoriesRemoved":true,"completionMessagesComplete":completion_messages_complete,"observerPhysicalExitConfirmed":true,"processLifecycle":lifecycle}),
        )
    }
}
fn record_trace(output: &Path, trace: &serde_json::Value) -> Result<()> {
    std::fs::write(
        output.join("sandbox-foundation.json"),
        serde_json::to_vec_pretty(trace)?,
    )
    .context("save sandbox foundation evidence")
}
impl Drop for Launch {
    fn drop(&mut self) {
        if !self.closed {
            if let Some(resources) = self.resources.as_mut() {
                resources.control_write.take();
            }
            // A failed explicit close has already identified a missing barrier.
            // Do not weaken it to Job-zero-only cleanup during unwinding.
            if self.close_started {
                let _ = self.job.terminate();
                self.job
                    .observation
                    .retain_only
                    .store(true, Ordering::Release);
                if self.resources.is_some() {
                    let _ = self.enqueue_resources(false, None);
                }
                return;
            }
            let _ = self.job.terminate();
            if self.close().is_err() {
                self.job
                    .observation
                    .retain_only
                    .store(true, Ordering::Release);
                if self.resources.is_some() {
                    let _ = self.enqueue_resources(false, None);
                }
            } // retain directories if any physical exit barrier could not be proved
        }
    }
}
fn environment(profile: &Profile) -> Result<Vec<u16>> {
    let system = std::env::var_os("SystemRoot").context("SystemRoot missing")?;
    let system = PathBuf::from(system);
    if !system.is_absolute() {
        bail!("SystemRoot must be absolute");
    }
    let entries = [
        // Windows AppContainer process creation expands LOCALAPPDATA. It refers only to
        // this session's low-integrity UDF, never to the user's actual data directory.
        ("LOCALAPPDATA", profile.udf.clone()),
        ("SystemRoot", system.clone()),
        ("WINDIR", system.clone()),
        ("PATH", system.join("System32")),
        ("TEMP", profile.udf.join("tmp")),
        ("TMP", profile.udf.join("tmp")),
    ];
    let mut entries = entries
        .into_iter()
        .map(|(key, value)| format!("{key}={}", value.display()))
        .collect::<Vec<_>>();
    entries.sort_by_key(|v| v.to_ascii_uppercase());
    let mut block = Vec::new();
    for entry in entries {
        block.extend(wide(entry));
    }
    block.push(0);
    Ok(block)
}
pub fn validate_private_handles(values: &[usize]) -> Result<Vec<File>> {
    if values.len() != 5
        || values
            .iter()
            .any(|value| *value == 0 || *value == usize::MAX)
    {
        bail!("private bootstrap handles missing");
    }
    let mut unique = values.to_vec();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != 5 {
        bail!("private handles are not distinct");
    }
    for value in &values[..4] {
        if unsafe { GetFileType(*value as HANDLE) } != FILE_TYPE_PIPE {
            bail!("bootstrap handle is not a pipe");
        }
        let mut flags = 0;
        win(
            unsafe { GetHandleInformation(*value as HANDLE, &mut flags) },
            "private handle validity",
        )?;
        win(
            unsafe { SetHandleInformation(*value as HANDLE, HANDLE_FLAG_INHERIT, 0) },
            "clear worker private handle inheritance",
        )?;
    }
    Ok(values[..4]
        .iter()
        .map(|value| unsafe { File::from_raw_handle(*value as HANDLE) })
        .collect())
}
pub fn validate_bootstrap(bootstrap: &Bootstrap, parent: HANDLE) -> Result<()> {
    bootstrap.validate()?;
    if bootstrap.desktop_build_id != crate::component::BUILD_ID {
        bail!("worker/parent component build mismatch");
    }
    let token = inspect_token(unsafe { GetCurrentProcess() })?;
    if token.sid != bootstrap.app_container_sid {
        bail!("private bootstrap token SID differs");
    }
    if unsafe { GetProcessId(parent) } != bootstrap.parent_pid
        || created(parent)? != bootstrap.parent_created
    {
        bail!("private parent creation identity differs");
    }
    let binary = VerifiedWorker::open(&std::env::current_exe()?, Some(&bootstrap.worker_sha256))?;
    if binary.identity.sha256 != bootstrap.worker_sha256 {
        bail!("worker executable identity differs");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn held_exit_failure_diagnostics_are_complete_and_bounded() {
        let identity = ProcessIdentity {
            pid: u32::MAX,
            created: u64::MAX,
            kind: i32::MIN,
        };
        let held = exit_diagnostic_message(
            "lifecycle-held process physical exit or creation barrier incomplete",
            &HeldExitDiagnostic {
                stage: "heldProcessPhysicalExit",
                expected: &identity,
                actual: HeldIdentityReadback {
                    pid: u32::MAX,
                    pid_error: Some(i32::MIN),
                    created: Some(u64::MAX),
                    creation_error: Some(i32::MIN),
                },
                wait: HeldWaitReceipt {
                    code: u32::MAX,
                    win32_error: Some(i32::MIN),
                    remaining_ms: u32::MAX,
                    elapsed_ms: u64::MAX,
                    physical_phase_elapsed_ms: u64::MAX,
                },
                job_terminated: false,
                fatal_observed: false,
            },
        );
        let close = exit_diagnostic_message(
            "original Launch close phase",
            &ClosePhaseDiagnostic {
                stage: "physicalTreeExit",
                elapsed_ms: u64::MAX,
                remaining_ms: u64::MAX,
                grace_ms: u64::MAX,
                reached_zero: false,
                job_terminated: false,
                fatal_observed: false,
            },
        );
        let combined = format!("{close}: {held}");
        assert!(
            combined.len() <= 1024,
            "diagnostic bytes={}",
            combined.len()
        );
        let value: serde_json::Value = serde_json::from_str(
            held.strip_prefix(
                "lifecycle-held process physical exit or creation barrier incomplete: ",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(value["wait"]["code"], u32::MAX);
        assert_eq!(value["expected"]["created"], u64::MAX);
        assert_eq!(value["actual"]["created"], u64::MAX);
        assert_eq!(value["wait"]["win32Error"], i32::MIN);
        assert_eq!(value["jobTerminated"], false);
        assert_eq!(diagnostic_millis(Duration::MAX), u64::MAX);
    }

    const FIXTURE_TEST: &str = "wallpaper::worker::sandbox::tests::lifecycle_process_fixture";
    fn save_evidence(name: &str, evidence: &serde_json::Value) {
        if let Some(folder) = std::env::var_os("HERTZ_JOB_EVIDENCE_DIR") {
            let folder = PathBuf::from(folder);
            assert!(folder.is_absolute());
            std::fs::write(
                folder.join(name),
                serde_json::to_vec_pretty(evidence).unwrap(),
            )
            .unwrap();
        }
    }
    fn wait_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "fixture did not reach {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    struct NativeFixture {
        process: Handle,
        thread: Handle,
        root: PathBuf,
    }
    impl NativeFixture {
        fn suspended(mode: &str) -> Self {
            Self::suspended_binary(mode, &std::env::current_exe().unwrap())
        }
        fn suspended_binary(mode: &str, exe: &Path) -> Self {
            let root =
                std::env::temp_dir().join(format!("hertz-job-lifecycle-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let mut command = wide(format!(
                "\"{}\" --exact {FIXTURE_TEST} --nocapture",
                exe.display()
            ));
            let mut values = std::env::vars_os()
                .filter(|(name, _)| !name.to_string_lossy().starts_with("HERTZ_JOB_FIXTURE_"))
                .map(|(name, value)| {
                    format!("{}={}", name.to_string_lossy(), value.to_string_lossy())
                })
                .collect::<Vec<_>>();
            values.push(format!("HERTZ_JOB_FIXTURE_MODE={mode}"));
            values.push(format!("HERTZ_JOB_FIXTURE_ROOT={}", root.display()));
            values.sort_by_key(|value| value.to_ascii_uppercase());
            let mut environment = values.into_iter().flat_map(wide).collect::<Vec<_>>();
            environment.push(0);
            let startup = STARTUPINFOW {
                cb: size_of::<STARTUPINFOW>() as u32,
                ..Default::default()
            };
            let mut info = PROCESS_INFORMATION::default();
            win(
                unsafe {
                    CreateProcessW(
                        wide(exe).as_ptr(),
                        command.as_mut_ptr(),
                        null(),
                        null(),
                        0,
                        CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT,
                        environment.as_ptr().cast(),
                        null(),
                        &startup,
                        &mut info,
                    )
                },
                "spawn native lifecycle fixture",
            )
            .unwrap();
            Self {
                process: Handle::new(info.hProcess, "fixture process").unwrap(),
                thread: Handle::new(info.hThread, "fixture thread").unwrap(),
                root,
            }
        }
        fn admit(&self, job: &Job) {
            let binary = VerifiedWorker::open(&std::env::current_exe().unwrap(), None).unwrap();
            job.register_suspended_root(self.process.0, &binary)
                .unwrap();
            win(
                unsafe { AssignProcessToJobObject(job.handle.0, self.process.0) },
                "assign test root",
            )
            .unwrap();
            job.install_runtime_pin(&binary).unwrap();
            job.reconcile_observation(Instant::now() + Duration::from_secs(2), false)
                .unwrap();
        }
        fn resume(&self) {
            assert_eq!(unsafe { ResumeThread(self.thread.0) }, 1);
        }
        fn signal(&self, name: &str) {
            std::fs::write(self.root.join(name), b"1").unwrap();
        }
    }
    impl Drop for NativeFixture {
        fn drop(&mut self) {
            if unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0 {
                unsafe {
                    TerminateProcess(self.process.0, 0x4753);
                    WaitForSingleObject(self.process.0, 2000);
                }
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn lifecycle_process_fixture() {
        use std::os::windows::io::IntoRawHandle;
        use std::os::windows::process::CommandExt;
        let Some(mode) = std::env::var_os("HERTZ_JOB_FIXTURE_MODE") else {
            return;
        };
        let root = PathBuf::from(std::env::var_os("HERTZ_JOB_FIXTURE_ROOT").unwrap());
        if mode == "child" {
            std::fs::write(root.join("child-ready"), std::process::id().to_string()).unwrap();
            wait_file(&root.join("stop-child"));
        } else if mode == "root" {
            std::fs::write(root.join("root-ready"), b"1").unwrap();
            wait_file(&root.join("spawn-late"));
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", FIXTURE_TEST, "--nocapture"])
                .env("HERTZ_JOB_FIXTURE_MODE", "child")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(DETACHED_PROCESS)
                .spawn()
                .unwrap();
            // Transfer this test child from Rust's Child wait owner to the
            // original native Job owner, which holds and waits its real object.
            let child = Handle::new(
                child.into_raw_handle(),
                "transfer fixture child to Job owner",
            )
            .unwrap();
            wait_file(&root.join("stop-root"));
            if root.join("stop-child").exists() {
                assert_eq!(unsafe { WaitForSingleObject(child.0, 3000) }, WAIT_OBJECT_0);
            }
        } else if mode == "idle" {
            std::fs::write(root.join("root-ready"), b"1").unwrap();
            wait_file(&root.join("stop-root"));
        } else {
            panic!("unknown native fixture mode");
        }
    }
    fn test_launch(tag: &str) -> (Launch, PathBuf) {
        let output =
            std::env::temp_dir().join(format!("hertz-bounded-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&output).unwrap();
        (
            Launch::suspended(&std::env::current_exe().unwrap(), None, &output).unwrap(),
            output,
        )
    }
    fn observer_handle(job: &Job) -> Handle {
        let thread = job.observation.thread.as_ref().unwrap();
        let source = std::mem::ManuallyDrop::new(Handle(thread.as_raw_handle()));
        source.duplicate(SYNCHRONIZE, false).unwrap()
    }
    fn wait_flag(flag: &AtomicBool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !flag.load(Ordering::Acquire) {
            assert!(
                Instant::now() < deadline,
                "controlled observer did not reach seam"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    fn clean_retained(root: PathBuf, name: String, output: PathBuf) {
        std::fs::remove_dir_all(root).unwrap();
        assert!(unsafe { DeleteAppContainerProfile(wide(name).as_ptr()) } >= 0);
        std::fs::remove_dir_all(output).unwrap();
    }
    fn exited_native_launch() -> Launch {
        // This ordinary native test fixture exercises only the existing close
        // owner/interleaving. It is never an AppContainer or product admission.
        let fixture = NativeFixture::suspended("idle");
        let job = Job::create().unwrap();
        fixture.admit(&job);
        fixture.resume();
        wait_file(&fixture.root.join("root-ready"));
        fixture.signal("stop-root");
        job.wait_observed_exit(Instant::now() + Duration::from_secs(3))
            .unwrap();
        let worker = job.observation.state.lock().unwrap().root.clone().unwrap();
        let profile = Profile::create().unwrap();
        let mut source = VerifiedWorker::open(&std::env::current_exe().unwrap(), None).unwrap();
        let staged = source.stage(&profile).unwrap();
        let parent_identity = Handle::new(
            unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                    0,
                    GetCurrentProcessId(),
                )
            },
            "native test parent",
        )
        .unwrap();
        Launch {
            resources: Some(LaunchResources {
                profile,
                source,
                staged: Some(staged),
                process: fixture
                    .process
                    .duplicate(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false)
                    .unwrap(),
                thread: fixture.thread.duplicate(SYNCHRONIZE, false).unwrap(),
                parent_identity,
                control_read: None,
                control_write: None,
                resource_read: None,
                resource_write: None,
                token: TokenEvidence {
                    app_container: false,
                    sid: "native-close-fixture".into(),
                    capability_count: 0,
                },
                worker,
            }),
            job,
            closed: false,
            close_started: false,
        }
    }
    fn post_fatal_message(job: &Job) {
        win(
            unsafe {
                windows_sys::Win32::System::IO::PostQueuedCompletionStatus(
                    job.observation.test_port.0,
                    JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT,
                    JOB_COMPLETION_KEY,
                    null(),
                )
            },
            "inject message into original native IOCP",
        )
        .unwrap();
    }
    #[test]
    fn fatal_receipt_survives_main_table_lock_before_termination() {
        let mut launch = exited_native_launch();
        let root = launch.profile.root.clone();
        let name = launch.profile.name.clone();
        let delay = launch.job.observation.test_delay.clone();
        delay.after_fatal.store(true, Ordering::Release);
        let observer = observer_handle(&launch.job);
        let state = launch.job.observation.state.clone();
        let guard = state.lock().unwrap();
        post_fatal_message(&launch.job);
        wait_flag(&delay.fatal_reached);
        assert!(launch.job.observation.fatal.load(Ordering::Acquire));
        assert!(!launch.job.terminated.load(Ordering::Acquire));
        let started = Instant::now();
        let error = launch
            .job
            .observation_health_before(started + Duration::from_millis(30))
            .unwrap_err();
        assert!(error.to_string().contains("fatal observation"));
        assert!(started.elapsed() < Duration::from_millis(150));
        assert!(!launch.job.qualification_clean());
        drop(guard);
        let result = launch.close_before(
            Instant::now() + Duration::from_millis(250),
            Duration::from_millis(100),
        );
        assert!(result.is_err());
        assert!(root.exists());
        save_evidence(
            "fatal-under-table-lock.json",
            &serde_json::json!({"fatalPublishedWhileTableHeld":true,
            "terminationStillDelayed":true,"closeRefused":true,"directoriesRetainedBeforeCleanup":true,
            "observed":launch.job.observation_evidence().unwrap()}),
        );
        drop(launch);
        delay.fatal_release.store(true, Ordering::Release);
        assert_eq!(
            unsafe { WaitForSingleObject(observer.0, 3000) },
            WAIT_OBJECT_0
        );
        assert!(root.exists());
        std::fs::remove_dir_all(root).unwrap();
        assert!(unsafe { DeleteAppContainerProfile(wide(name).as_ptr()) } >= 0);
    }
    #[test]
    fn fatal_after_completed_snapshot_refuses_fast_close_and_late_cleanup() {
        let mut launch = exited_native_launch();
        let root = launch.profile.root.clone();
        let name = launch.profile.name.clone();
        let staged = PathBuf::from(&launch.staged.as_ref().unwrap().identity.path);
        let delay = launch.job.observation.test_delay.clone();
        delay.after_fatal.store(true, Ordering::Release);
        delay
            .before_cleanup_submission
            .store(true, Ordering::Release);
        let observer = observer_handle(&launch.job);
        let port = launch
            .job
            .observation
            .test_port
            .duplicate(SYNCHRONIZE | 2, false)
            .unwrap();
        let state = launch.job.observation.state.clone();
        let fatal = launch.job.observation.fatal.clone();
        let terminated = launch.job.terminated.clone();
        let closer = std::thread::spawn(move || {
            let result = launch.close_before(
                Instant::now() + Duration::from_secs(2),
                Duration::from_millis(100),
            );
            (launch, result)
        });
        wait_flag(&delay.caller_reached);
        let guard = state.lock().unwrap();
        win(
            unsafe {
                windows_sys::Win32::System::IO::PostQueuedCompletionStatus(
                    port.0,
                    JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT,
                    JOB_COMPLETION_KEY,
                    null(),
                )
            },
            "post fatal after native snapshot",
        )
        .unwrap();
        wait_flag(&delay.fatal_reached);
        assert!(fatal.load(Ordering::Acquire));
        assert!(!terminated.load(Ordering::Acquire));
        drop(guard);
        delay.caller_release.store(true, Ordering::Release);
        let (mut launch, result) = closer.join().unwrap();
        assert!(result.is_err());
        assert!(launch.close().is_err());
        assert!(!launch.job.qualification_clean());
        assert!(root.exists());
        assert!(OpenOptions::new().write(true).open(&staged).is_err());
        save_evidence(
            "fatal-after-native-snapshot.json",
            &serde_json::json!({"nativeSnapshotCompleteBeforeFatal":true,
            "fatalReceiptPublished":true,"terminationStillDelayed":true,"fastCloseRefused":true,
            "lateRetryRefused":true,"directoriesRetainedBeforeCleanup":true,
            "observed":launch.job.observation_evidence().unwrap()}),
        );
        drop(launch);
        assert_eq!(unsafe { WaitForSingleObject(observer.0, 0) }, WAIT_TIMEOUT);
        delay.fatal_release.store(true, Ordering::Release);
        assert_eq!(
            unsafe { WaitForSingleObject(observer.0, 3000) },
            WAIT_OBJECT_0
        );
        assert!(root.exists());
        std::fs::remove_dir_all(root).unwrap();
        assert!(unsafe { DeleteAppContainerProfile(wide(name).as_ptr()) } >= 0);
    }
    #[test]
    fn bounded_close_cannot_wait_on_a_held_lifecycle_lock() {
        let (mut launch, output) = test_launch("locked-table");
        let root = launch.profile.root.clone();
        let name = launch.profile.name.clone();
        let state = launch.job.observation.state.clone();
        let observer = observer_handle(&launch.job);
        let release = Arc::new(AtomicBool::new(false));
        let thread_release = release.clone();
        let (ready, received) = std::sync::mpsc::channel();
        let locker = std::thread::spawn(move || {
            let _guard = state.lock().unwrap();
            ready.send(()).unwrap();
            while !thread_release.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        received.recv_timeout(Duration::from_secs(2)).unwrap();
        let started = Instant::now();
        let result = launch.close_before(started + Duration::from_millis(75), Duration::ZERO);
        let elapsed = started.elapsed();
        assert!(result.is_err());
        assert!(elapsed < Duration::from_millis(350));
        let dropped = Instant::now();
        drop(launch);
        assert!(dropped.elapsed() < Duration::from_millis(200));
        assert!(root.exists());
        release.store(true, Ordering::Release);
        locker.join().unwrap();
        // The original observer has physically exited before manual recovery.
        assert_eq!(
            unsafe { WaitForSingleObject(observer.0, 3000) },
            WAIT_OBJECT_0
        );
        save_evidence(
            "bounded-locked-table.json",
            &serde_json::json!({"closeRefused":true,
            "elapsedMs":elapsed.as_millis(),"directoriesRetained":root.exists()}),
        );
        clean_retained(root, name, output);
    }
    #[test]
    fn bounded_new_verification_delay_retains_original_resources_until_thread_exit() {
        let (mut launch, output) = test_launch("new-verification");
        let root = launch.profile.root.clone();
        let name = launch.profile.name.clone();
        let staged = PathBuf::from(&launch.staged.as_ref().unwrap().identity.path);
        let binary = VerifiedWorker::open(&std::env::current_exe().unwrap(), None).unwrap();
        launch.job.install_runtime_pin(&binary).unwrap();
        drop(binary);
        let delay = launch.job.observation.test_delay.clone();
        delay.before_verification.store(true, Ordering::Release);
        let observer = observer_handle(&launch.job);
        let second = NativeFixture::suspended("idle");
        win(
            unsafe { AssignProcessToJobObject(launch.job.handle.0, second.process.0) },
            "assign delayed actual member",
        )
        .unwrap();
        wait_flag(&delay.reached);
        // Verification stalls outside the shared table, so diagnostics remain accessible.
        let observed = launch.job.observation_evidence().unwrap();
        assert!(observed["processes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["imagePinVerified"] == false));
        let started = Instant::now();
        let result = launch.close_before(started + Duration::from_millis(75), Duration::ZERO);
        let elapsed = started.elapsed();
        assert!(result.is_err());
        assert!(elapsed < Duration::from_millis(350));
        assert!(launch.close().is_err()); // no retry may turn a late snapshot into success
        let dropped = Instant::now();
        drop(launch);
        assert!(dropped.elapsed() < Duration::from_millis(200));
        assert_eq!(unsafe { WaitForSingleObject(observer.0, 0) }, WAIT_TIMEOUT);
        assert!(root.exists());
        assert!(OpenOptions::new().write(true).open(&staged).is_err());
        save_evidence(
            "bounded-new-verification.json",
            &serde_json::json!({"closeRefused":true,
            "elapsedMs":elapsed.as_millis(),"observerStillHeld":true,"stagedPinRetained":true,
            "directoriesRetained":true,"observed":observed}),
        );
        delay.release.store(true, Ordering::Release);
        assert_eq!(
            unsafe { WaitForSingleObject(observer.0, 3000) },
            WAIT_OBJECT_0
        );
        assert!(root.exists());
        assert!(OpenOptions::new().write(true).open(&staged).is_ok());
        drop(second);
        clean_retained(root, name, output);
    }
    #[test]
    fn bounded_observer_retirement_delay_cannot_clean_or_qualify_late() {
        let (mut launch, output) = test_launch("retirement");
        let root = launch.profile.root.clone();
        let name = launch.profile.name.clone();
        let staged = PathBuf::from(&launch.staged.as_ref().unwrap().identity.path);
        let delay = launch.job.observation.test_delay.clone();
        delay.before_retirement.store(true, Ordering::Release);
        let observer = observer_handle(&launch.job);
        launch.job.terminate().unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(launch.process.0, 3000) },
            WAIT_OBJECT_0
        );
        let started = Instant::now();
        let result = launch.close_before(started + Duration::from_millis(250), Duration::ZERO);
        let elapsed = started.elapsed();
        wait_flag(&delay.reached);
        assert!(result.is_err());
        assert!(elapsed < Duration::from_millis(500));
        assert!(launch.close().is_err());
        let dropped = Instant::now();
        drop(launch);
        assert!(dropped.elapsed() < Duration::from_millis(200));
        assert_eq!(unsafe { WaitForSingleObject(observer.0, 0) }, WAIT_TIMEOUT);
        assert!(root.exists());
        assert!(OpenOptions::new().write(true).open(&staged).is_err());
        save_evidence(
            "bounded-observer-retirement.json",
            &serde_json::json!({"closeRefused":true,
            "elapsedMs":elapsed.as_millis(),"observerStillHeld":true,"stagedPinRetained":true,
            "directoriesRetained":true,"lateRetryRefused":true}),
        );
        delay.release.store(true, Ordering::Release);
        assert_eq!(
            unsafe { WaitForSingleObject(observer.0, 3000) },
            WAIT_OBJECT_0
        );
        assert!(root.exists()); // the late original tail stays in retention mode
        assert!(OpenOptions::new().write(true).open(&staged).is_ok());
        clean_retained(root, name, output);
    }
    #[test]
    fn expired_matched_accounting_and_physical_snapshots_are_refused() {
        let fixture = NativeFixture::suspended("idle");
        let job = Job::create().unwrap();
        fixture.admit(&job);
        fixture.resume();
        wait_file(&fixture.root.join("root-ready"));
        fixture.signal("stop-root");
        job.wait_observed_exit(Instant::now() + Duration::from_secs(3))
            .unwrap();
        let expired = Instant::now() - Duration::from_millis(1);
        assert!(job.reconcile_observation(expired, true).is_err());
        assert!(job.wait_physical_tree_exit(expired).is_err());
        save_evidence(
            "expired-matched-refused.json",
            &serde_json::json!({"expiredAccountingRefused":true,
            "expiredPhysicalSnapshotRefused":true,"completeNativeFacts":job.observation_evidence().unwrap()}),
        );
    }
    #[test]
    fn real_job_late_child_and_early_root_exit_keep_complete_physical_receipts() {
        let fixture = NativeFixture::suspended("root");
        let job = Job::create().unwrap();
        fixture.admit(&job);
        fixture.resume();
        wait_file(&fixture.root.join("root-ready"));
        // Simulate the final SDK sample. The child is created afterwards.
        job.verify_environment(&[]).unwrap();
        fixture.signal("spawn-late");
        wait_file(&fixture.root.join("child-ready"));
        job.reconcile_observation(Instant::now() + Duration::from_secs(2), false)
            .unwrap();
        let child_pid = std::fs::read_to_string(fixture.root.join("child-ready"))
            .unwrap()
            .parse()
            .unwrap();
        let evidence = job.observation_evidence().unwrap();
        save_evidence("late-child-held.json", &evidence);
        assert_eq!(evidence["processes"].as_array().unwrap().len(), 2);
        assert_eq!(job.observed_runtime_count().unwrap(), 1);
        let identity = job.observation.state.lock().unwrap().processes[&child_pid]
            .held
            .identity
            .clone();
        job.verify_environment(std::slice::from_ref(&identity))
            .unwrap();
        let mut wrong = identity.clone();
        wrong.created += 1;
        assert!(job.verify_environment(&[wrong]).is_err());
        fixture.signal("stop-root");
        assert_eq!(
            unsafe { WaitForSingleObject(fixture.process.0, 3000) },
            WAIT_OBJECT_0
        );
        assert_eq!(job.active().unwrap(), 1);
        assert!(job
            .wait_observed_exit(Instant::now() + Duration::from_millis(50))
            .is_err());
        fixture.signal("stop-child");
        job.wait_observed_exit(Instant::now() + Duration::from_secs(3))
            .unwrap();
        let evidence = job.observation_evidence().unwrap();
        save_evidence("late-child-physical-exit.json", &evidence);
        assert!(evidence["processes"].as_array().unwrap().iter().all(|p| {
            p["newProcessReceipt"] == true
                && p["exitProcessReceipt"] == true
                && p["physicalExitSignalled"] == true
                && p["imagePinVerified"] == true
        }));
        assert!(!job.terminated.load(Ordering::Acquire));
    }
    #[test]
    fn real_job_missing_exit_receipt_is_rejected_even_after_active_zero() {
        let fixture = NativeFixture::suspended("idle");
        let job = Job::create().unwrap();
        fixture.admit(&job);
        fixture.resume();
        wait_file(&fixture.root.join("root-ready"));
        fixture.signal("stop-root");
        job.wait_observed_exit(Instant::now() + Duration::from_secs(3))
            .unwrap();
        assert_eq!(job.active().unwrap(), 0);
        // Model a lost EXIT packet at the original owner's native receipt seam.
        job.observation
            .state
            .lock()
            .unwrap()
            .processes
            .values_mut()
            .next()
            .unwrap()
            .exit_receipt = false;
        assert!(job
            .wait_observed_exit(Instant::now() + Duration::from_millis(25))
            .is_err());
        save_evidence(
            "lost-exit-message-refused.json",
            &job.observation_evidence().unwrap(),
        );
    }
    #[test]
    fn real_job_unknown_image_fails_observation_and_terminates_only_owned_tree() {
        let fixture = NativeFixture::suspended("idle");
        let job = Job::create().unwrap();
        fixture.admit(&job);
        // Runtime children may use only the original held pin. A real second
        // member running identical bytes at a different file is still refused.
        let different =
            std::env::temp_dir().join(format!("hertz-wrong-pin-{}.exe", uuid::Uuid::new_v4()));
        std::fs::copy(std::env::current_exe().unwrap(), &different).unwrap();
        let second = NativeFixture::suspended_binary("idle", &different);
        win(
            unsafe { AssignProcessToJobObject(job.handle.0, second.process.0) },
            "assign unexpected actual member",
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while job.observation_health().is_ok() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            unsafe { WaitForSingleObject(fixture.process.0, 2000) },
            WAIT_OBJECT_0
        );
        assert_eq!(
            unsafe { WaitForSingleObject(second.process.0, 2000) },
            WAIT_OBJECT_0
        );
        assert!(job
            .wait_observed_exit(Instant::now() + Duration::from_millis(25))
            .is_err());
        save_evidence(
            "actual-wrong-image-refused.json",
            &job.observation_evidence().unwrap(),
        );
        assert_eq!(
            unsafe { WaitForSingleObject(GetCurrentProcess(), 0) },
            WAIT_TIMEOUT
        );
        drop(job);
        drop(second);
        std::fs::remove_file(different).unwrap();
    }
    #[test]
    fn real_job_cumulative_count_detects_unreceived_new_process() {
        let fixture = NativeFixture::suspended("idle");
        let job = Job::create().unwrap();
        fixture.admit(&job);
        // A missing NEW receipt cannot be replaced by an active PID sample.
        job.observation
            .state
            .lock()
            .unwrap()
            .processes
            .values_mut()
            .next()
            .unwrap()
            .new_receipt = false;
        assert!(job
            .reconcile_observation(Instant::now() + Duration::from_millis(25), false)
            .is_err());
        job.terminate().unwrap();
    }
    #[test]
    fn real_launch_failed_lifecycle_close_retains_its_profile() {
        let output =
            std::env::temp_dir().join(format!("hertz-lifecycle-close-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&output).unwrap();
        let mut launch =
            Launch::suspended(&std::env::current_exe().unwrap(), None, &output).unwrap();
        let root = launch.profile.root.clone();
        let name = launch.profile.name.clone();
        let process = launch.process.duplicate(SYNCHRONIZE, false).unwrap();
        let observer = observer_handle(&launch.job);
        // Fail the original native observation seam, then exercise the real
        // explicit-close and unwind path after the actual root has exited.
        launch.job.observation.fatal.store(true, Ordering::Release);
        let _ = launch
            .job
            .observation
            .fatal_receipt
            .set("injected lost lifecycle receipt".into());
        launch.job.terminate().unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(process.0, 2000) },
            WAIT_OBJECT_0
        );
        assert!(launch.close().is_err());
        drop(launch);
        assert!(root.exists());
        assert_eq!(
            unsafe { WaitForSingleObject(observer.0, 3000) },
            WAIT_OBJECT_0
        );
        std::fs::remove_dir_all(&root).unwrap();
        assert!(unsafe { DeleteAppContainerProfile(wide(name).as_ptr()) } >= 0);
        std::fs::remove_dir_all(output).unwrap();
    }
    #[test]
    fn real_job_limit_readback_and_empty_tree() {
        let job = Job::create().unwrap();
        let evidence = job.evidence().unwrap();
        assert_eq!(evidence.private_commit_bytes, 536_870_912);
        assert_eq!(evidence.cpu_rate, 10_000 / evidence.logical_cpus);
        assert!(!evidence.breakaway);
        assert!(job.pids().unwrap().is_empty());
        assert!(job.wait_zero(Duration::from_millis(1)).unwrap());
    }
    #[test]
    fn held_binary_denies_replacement_and_wrong_hash() {
        let path =
            std::env::temp_dir().join(format!("hertz-worker-held-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"held executable admission regression").unwrap();
        let held = VerifiedWorker::open(&path, None).unwrap();
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(std::fs::remove_file(&path).is_err());
        assert!(VerifiedWorker::open(&path, Some(&"0".repeat(64))).is_err());
        drop(held);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn ordinary_process_token_is_rejected_as_worker() {
        assert!(inspect_token(unsafe { GetCurrentProcess() }).is_err());
        assert!(validate_private_handles(&[0, 0, 0, 0, 0]).is_err());
    }
    #[test]
    fn environment_contains_only_own_udf_and_os_keys() {
        let mut profile = Profile::create().unwrap();
        let block = environment(&profile).unwrap();
        let values = String::from_utf16(&block).unwrap();
        let entries = values
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 6);
        assert!(entries
            .iter()
            .any(|entry| *entry == format!("LOCALAPPDATA={}", profile.udf.display())));
        assert!(!entries.iter().any(|entry| entry.starts_with("WEBVIEW2_")
            || entry.to_ascii_uppercase().contains("PROXY")
            || entry.starts_with("USERPROFILE=")));
        let root = profile.root.clone();
        profile.cleanup().unwrap();
        assert!(!root.exists());
    }
    #[test]
    fn partial_control_frame_read_is_cancellable_with_writer_still_open() {
        use std::io::Write;
        let (read, mut write) = pipe().unwrap();
        write.write_all(&[1, 0]).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut reader = CancellableReader::new(read, worker_cancel);
            let _ = tx.send(super::super::protocol::read_frame(&mut reader, 8192));
        });
        std::thread::sleep(Duration::from_millis(25));
        cancel.store(true, Ordering::Release);
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        thread.join().unwrap();
        drop(write);
    }
    #[test]
    fn suspended_real_appcontainer_is_owned_and_only_its_job_is_terminated() {
        // This proves launch/teardown only. The child never executes its test-harness image.
        let output =
            std::env::temp_dir().join(format!("hertz-foundation-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&output).unwrap();
        let mut launch =
            Launch::suspended(&std::env::current_exe().unwrap(), None, &output).unwrap();
        assert!(launch.token.app_container);
        assert_eq!(launch.token.capability_count, 0);
        assert_eq!(launch.job.active().unwrap(), 1);
        launch.job.contains(launch.process.0).unwrap();
        let guard = launch
            .job
            .deadline(Instant::now() + Duration::from_millis(100))
            .unwrap();
        // The caller performs no polling or IPC. The independently held Job
        // deadline must still stop the exact suspended process.
        assert_eq!(
            unsafe { WaitForSingleObject(launch.process.0, 2000) },
            WAIT_OBJECT_0
        );
        assert!(guard.finish().unwrap());
        let root = launch.profile.root.clone();
        let exit = launch.close().unwrap();
        save_evidence("never-resumed-terminated-close.json", &exit);
        assert_eq!(exit["activeProcesses"], 0);
        assert_eq!(exit["jobTerminated"], true);
        assert!(!root.exists());
        std::fs::remove_dir_all(output).unwrap();
    }
    #[test]
    fn cancelled_job_deadline_does_not_terminate_the_admitted_job() {
        let job = Job::create().unwrap();
        let guard = job
            .deadline(Instant::now() + Duration::from_secs(1))
            .unwrap();
        assert!(!guard.finish().unwrap());
        assert!(!job.terminated.load(Ordering::Acquire));
    }
    #[test]
    fn job_member_must_match_the_exact_pinned_executable_file() {
        let output =
            std::env::temp_dir().join(format!("hertz-runtime-pin-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&output).unwrap();
        let mut launch =
            Launch::suspended(&std::env::current_exe().unwrap(), None, &output).unwrap();
        assert!(HeldProcess::hold(std::process::id(), &launch.job).is_err());
        let held = HeldProcess::hold(launch.worker.pid, &launch.job).unwrap();
        held.verify_runtime(launch.staged.as_ref().unwrap())
            .unwrap();
        // Identical bytes at the original path are not the admitted staged file.
        let original = VerifiedWorker::open(&std::env::current_exe().unwrap(), None).unwrap();
        assert!(held.verify_runtime(&original).is_err());
        drop(held);
        launch.close().unwrap();
        std::fs::remove_dir_all(output).unwrap();
    }
    #[test]
    fn failed_close_unwinding_retains_session_files_until_exit_is_proven() {
        let output =
            std::env::temp_dir().join(format!("hertz-failed-close-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&output).unwrap();
        let mut launch =
            Launch::suspended(&std::env::current_exe().unwrap(), None, &output).unwrap();
        let process = launch.process.duplicate(SYNCHRONIZE, false).unwrap();
        let observer = observer_handle(&launch.job);
        let root = launch.profile.root.clone();
        let name = launch.profile.name.clone();
        launch.close_started = true;
        drop(launch);
        assert!(root.exists());
        assert_eq!(
            unsafe { WaitForSingleObject(process.0, 2000) },
            WAIT_OBJECT_0
        );
        assert_eq!(
            unsafe { WaitForSingleObject(observer.0, 3000) },
            WAIT_OBJECT_0
        );
        // The exact test process exit is now proven; recover only its profile.
        std::fs::remove_dir_all(&root).unwrap();
        assert!(unsafe { DeleteAppContainerProfile(wide(name).as_ptr()) } >= 0);
        std::fs::remove_dir_all(output).unwrap();
    }
}
