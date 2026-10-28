// SPDX-License-Identifier: MIT
//! Same-user, same interactive-session Windows pipes with real peer PID verification.
//! All pipe I/O uses Tokio's overlapped handles. Deadline/cancel drops the owned handle;
//! no worker is left in a synchronous ReadFile/WriteFile/FlushFileBuffers call.
use crate::{
    frame, Profile, Request, Response, Scope, CONNECT_TIMEOUT, REQUEST_LIMIT, REQUEST_TIMEOUT,
    RESPONSE_LIMIT,
};
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    future::Future,
    io,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    sync::Arc,
};
use tokio::{
    io::AsyncReadExt,
    net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions},
    sync::watch,
    time::{timeout, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        LocalFree, ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
        HANDLE, INVALID_HANDLE_VALUE,
    },
    Globalization::{LCMapStringEx, LCMAP_LOWERCASE, LOCALE_NAME_INVARIANT},
    Security::{
        AclSizeInformation,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        GetAce, GetAclInformation, GetLengthSid, GetSecurityDescriptorControl, GetTokenInformation,
        TokenSessionId, TokenUser, ACCESS_ALLOWED_ACE, ACL_SIZE_INFORMATION,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
        SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateFileW, MoveFileExW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    },
    System::{
        Pipes::{
            DisconnectNamedPipe, GetNamedPipeClientProcessId, GetNamedPipeClientSessionId,
            GetNamedPipeServerProcessId, GetNamedPipeServerSessionId,
        },
        Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
        IO::CancelIoEx,
    },
};

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn denied(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}
fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

// Mio deliberately does not cancel pending writes in NamedPipe::drop. Explicitly cancel
// ALL overlapped operations first, including buffered writes to a non-reading client.
// The owned pipe stays alive until CancelIoEx has been issued; no detached worker owns it.
pub(crate) struct OwnedPipe<P: AsRawHandle>(pub(crate) P, pub(crate) bool);
impl<P: AsRawHandle> Drop for OwnedPipe<P> {
    fn drop(&mut self) {
        unsafe {
            CancelIoEx(self.0.as_raw_handle(), std::ptr::null());
            if self.1 {
                // Disconnect before releasing send/admission guards, even while IOCP cleanup
                // is pending. Normal completion has already observed the client's close.
                DisconnectNamedPipe(self.0.as_raw_handle());
            }
        }
    }
}
impl<P: AsRawHandle> std::ops::Deref for OwnedPipe<P> {
    type Target = P;
    fn deref(&self) -> &P {
        &self.0
    }
}
impl<P: AsRawHandle> std::ops::DerefMut for OwnedPipe<P> {
    fn deref_mut(&mut self) -> &mut P {
        &mut self.0
    }
}

/// Observed token identity, not identity fields supplied in JSON.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub user_sid: String,
    pub windows_session_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerIdentity {
    pub pid: u32,
    pub identity: Identity,
}

impl Identity {
    pub fn current() -> io::Result<Self> {
        unsafe { identity_for_process(GetCurrentProcess()) }
    }
    pub(crate) fn ensure_interactive(&self) -> io::Result<()> {
        if self.windows_session_id == 0 {
            return Err(denied(
                "desktop IPC requires an interactive Windows session",
            ));
        }
        Ok(())
    }
}

unsafe fn sid_text(sid: *mut c_void) -> io::Result<String> {
    let mut pointer = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut pointer) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _owned = LocalAllocation(pointer.cast());
    let mut length = 0;
    while unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, length) })
        .map_err(|_| invalid("invalid SID encoding"))
}

unsafe fn identity_for_process(process: HANDLE) -> io::Result<Identity> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut size = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut size,
        );
    }
    if size == 0 || size > 65_536 {
        return Err(invalid("invalid token identity length"));
    }
    // TOKEN_USER requires pointer alignment; a byte Vec is not sufficient for a typed cast.
    let mut storage = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            storage.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let user = unsafe { &*(storage.as_ptr().cast::<TOKEN_USER>()) };
    let user_sid = unsafe { sid_text(user.User.Sid)? };
    let mut session = 0u32;
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenSessionId,
            (&mut session as *mut u32).cast(),
            4,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Identity {
        user_sid,
        windows_session_id: session,
    })
}

pub(crate) fn peer(
    handle: HANDLE,
    server_end: bool,
    expected_pid: Option<u32>,
) -> io::Result<PeerIdentity> {
    let mut pid = 0;
    let mut session = 0;
    let (get_pid, get_session) = if server_end {
        (
            GetNamedPipeClientProcessId as unsafe extern "system" fn(HANDLE, *mut u32) -> i32,
            GetNamedPipeClientSessionId as unsafe extern "system" fn(HANDLE, *mut u32) -> i32,
        )
    } else {
        (
            GetNamedPipeServerProcessId as unsafe extern "system" fn(HANDLE, *mut u32) -> i32,
            GetNamedPipeServerSessionId as unsafe extern "system" fn(HANDLE, *mut u32) -> i32,
        )
    };
    if unsafe { get_pid(handle, &mut pid) } == 0
        || unsafe { get_session(handle, &mut session) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 || expected_pid.is_some_and(|expected| expected != pid) {
        return Err(denied("desktop pipe peer PID mismatch"));
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let identity = unsafe { identity_for_process(process.as_raw_handle())? };
    let local = Identity::current()?;
    local.ensure_interactive()?;
    if identity != local || identity.windows_session_id != session {
        return Err(denied("desktop pipe peer user/session mismatch"));
    }
    // Keep the process handle open until a second pipe PID read closes the PID reuse gap.
    let mut verified = 0;
    if unsafe { get_pid(handle, &mut verified) } == 0 || verified != pid {
        return Err(denied("desktop pipe peer changed"));
    }
    Ok(PeerIdentity { pid, identity })
}

pub(crate) struct PrivateSecurity {
    descriptor: LocalAllocation,
}
impl PrivateSecurity {
    pub(crate) fn new() -> io::Result<Self> {
        let identity = Identity::current()?;
        // Protected DACL, exactly the current SID. No Everyone/Authenticated Users or inherited grants.
        let sddl = format!("O:{}D:P(A;;GA;;;{})", identity.user_sid, identity.user_sid);
        let mut descriptor = std::ptr::null_mut();
        let input = wide(sddl.as_ref());
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                input.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            descriptor: LocalAllocation(descriptor),
        })
    }
    pub(crate) fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        }
    }
}

/// A latched cancellation signal. Cancelling before an operation starts also cancels it.
#[derive(Clone)]
pub struct Cancellation {
    sender: Arc<watch::Sender<bool>>,
}
impl Default for Cancellation {
    fn default() -> Self {
        Self::new()
    }
}
impl Cancellation {
    pub fn new() -> Self {
        let (sender, _) = watch::channel(false);
        Self {
            sender: Arc::new(sender),
        }
    }
    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }
    pub async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        let _ = receiver.wait_for(|cancelled| *cancelled).await;
    }
}

pub fn validate_pipe_name(name: &str) -> io::Result<()> {
    let suffix = name
        .strip_prefix(r"\\.\pipe\hertz-desktop-")
        .ok_or_else(|| invalid("invalid local desktop pipe namespace"))?;
    if suffix.is_empty()
        || name.len() > 240
        || !suffix
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(invalid("invalid local desktop pipe name"));
    }
    Ok(())
}

pub fn pipe_name(profile: &Profile, session: &str, scope: Scope) -> io::Result<String> {
    let identity = Identity::current()?;
    identity.ensure_interactive()?;
    let mut digest = Sha256::new();
    digest.update(frame::serialize_bounded(
        &profile.normalized()?,
        crate::DISCOVERY_LIMIT,
    )?);
    digest.update(identity.user_sid.as_bytes());
    digest.update(session.as_bytes());
    let hash = format!("{:x}", digest.finalize());
    Ok(format!(
        r"\\.\pipe\hertz-desktop-data-{}-{}-{}",
        identity.windows_session_id,
        &hash[..32],
        scope.as_str()
    ))
}

/// Must be called inside a Tokio runtime. Reserve the first instance before publishing discovery.
/// Caller creates replacement instances and owns the scope/global admission permits.
pub fn create_server(name: &str, first_instance: bool) -> io::Result<NamedPipeServer> {
    validate_pipe_name(name)?;
    Identity::current()?.ensure_interactive()?;
    let security = PrivateSecurity::new()?;
    let mut attributes = security.attributes();
    // Explicit flags; never rely on the default descriptor or remote-client policy.
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(first_instance)
            .reject_remote_clients(true)
            .in_buffer_size(8192)
            .out_buffer_size(65_536)
            .create_with_security_attributes_raw(
                name,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
    }
}

pub struct Connection {
    pipe: OwnedPipe<NamedPipeServer>,
    connected_at: Instant,
}

// Fields drop in declaration order. A single owner guarantees cancel/disconnect BEFORE
// deregistration on errors, deadlines, explicit future Drop, and task abort alike.
struct SendResources<G> {
    pipe: OwnedPipe<NamedPipeServer>,
    registration: Option<G>,
}

/// Cancellation drops the listening handle as well as an accepted connection.
pub async fn accept(server: NamedPipeServer, cancel: &Cancellation) -> io::Result<Connection> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(io::Error::new(io::ErrorKind::Interrupted, "desktop IPC cancelled")),
        result = server.connect() => { result?; Ok(Connection { pipe: OwnedPipe(server, true), connected_at: Instant::now() }) }
    }
}

async fn reject_buffered_extra<P>(pipe: &mut P) -> io::Result<()>
where
    P: AsRawHandle + tokio::io::AsyncRead + Unpin,
{
    // Mio prefetches into a 4 KiB buffer, including across a frame boundary. A
    // kernel Peek alone misses that buffer AND a completed read whose IOCP event
    // has not run yet. Cancel its outstanding read, then consume the completion:
    // existing bytes are detected, while an empty read completes with ABORTED.
    // This is an I/O completion barrier, with no timing-based grace period.
    unsafe {
        CancelIoEx(pipe.as_raw_handle(), std::ptr::null());
    }
    match pipe.read(&mut [0u8; 1]).await {
        Ok(0) => Ok(()),
        Ok(_) => Err(invalid("multiple desktop frames on one connection")),
        Err(error) if matches!(error.raw_os_error(), Some(code) if code == ERROR_OPERATION_ABORTED as i32 || code == ERROR_BROKEN_PIPE as i32 || code == ERROR_NO_DATA as i32) => {
            Ok(())
        }
        Err(error) => Err(error),
    }
}
impl Connection {
    pub fn peer_identity(&self) -> io::Result<PeerIdentity> {
        peer(self.pipe.as_raw_handle(), true, None)
    }

    /// Owns the full auth/work/read/write/drain deadline measured from connect (not each step).
    /// Response writes are drained by awaiting the client's close after it reads the response.
    /// Receiving additional bytes, including delayed second requests, rejects the connection.
    /// This avoids synchronous FlushFileBuffers and protects delivery from premature pipe close.
    pub async fn serve<F, Fut>(self, cancel: &Cancellation, handler: F) -> io::Result<PeerIdentity>
    where
        F: FnOnce(PeerIdentity, Request) -> Fut,
        Fut: Future<Output = io::Result<Response>>,
    {
        self.serve_with_admission(cancel, handler, |_| Ok(())).await
    }

    /// The synchronous callback runs after bounded serialization and immediately before I/O.
    /// It can register a send under the caller's revoke gate and return a guard whose Drop
    /// releases that registration. Revoke cancels this connection through `cancel`.
    pub async fn serve_with_admission<F, Fut, A, G>(
        self,
        cancel: &Cancellation,
        handler: F,
        admission: A,
    ) -> io::Result<PeerIdentity>
    where
        F: FnOnce(PeerIdentity, Request) -> Fut,
        Fut: Future<Output = io::Result<Response>>,
        A: FnOnce(&Response) -> io::Result<G>,
    {
        let deadline = self.connected_at + REQUEST_TIMEOUT;
        let mut resources = SendResources {
            pipe: self.pipe,
            registration: None,
        };
        let work = async {
            let identity = peer(resources.pipe.as_raw_handle(), true, None)?;
            let request: Request = frame::read_frame(&mut *resources.pipe, REQUEST_LIMIT).await?;
            reject_buffered_extra(&mut *resources.pipe).await?;
            let mut response = handler(identity.clone(), request.clone()).await?;
            response.validate(&request)?;
            let json = match frame::serialize_bounded(&response, RESPONSE_LIMIT) {
                Ok(bytes) => bytes,
                Err(_) => {
                    response = Response {
                        bridge_protocol: crate::BRIDGE_PROTOCOL,
                        request_id: request.request_id,
                        server_instance_id: request.server_instance_id,
                        status: 500,
                        body: serde_json::json!({"ok":false,"error":{"code":"desktop_response_too_large","message":"Desktop response exceeds the frame budget"}}),
                    };
                    frame::serialize_bounded(&response, RESPONSE_LIMIT)?
                }
            };
            if cancel.is_cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "desktop IPC cancelled",
                ));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "desktop request deadline",
                ));
            }
            resources.registration = Some(admission(&response)?);
            frame::write_frame(&mut *resources.pipe, &json, RESPONSE_LIMIT).await?;
            let mut extra = [0u8; 1];
            match resources.pipe.read(&mut extra).await {
                Ok(0) => Ok(identity),
                Err(error) if matches!(error.raw_os_error(), Some(code) if code == ERROR_BROKEN_PIPE as i32 || code == ERROR_NO_DATA as i32) => {
                    Ok(identity)
                }
                Err(error) => Err(error),
                Ok(_) => Err(invalid("multiple desktop frames on one connection")),
            }
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(io::Error::new(io::ErrorKind::Interrupted, "desktop IPC cancelled")),
            result = tokio::time::timeout_at(deadline, work) => result.unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, "desktop request deadline"))),
        };
        // Cancel all underlying operations BEFORE removing the caller's send registration.
        drop(resources);
        result
    }
}

/// Expected PID is read from a validated discovery record, never inferred from JSON responses.
pub async fn request(
    name: &str,
    expected_pid: u32,
    request: &Request,
    cancel: &Cancellation,
) -> io::Result<Response> {
    validate_pipe_name(name)?;
    if expected_pid == 0 {
        return Err(denied("missing desktop server PID"));
    }
    let connect = async {
        loop {
            match ClientOptions::new().open(name) {
                Ok(pipe) => break Ok(pipe),
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        || error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await
                }
                Err(error) => break Err(error),
            }
        }
    };
    let mut pipe = OwnedPipe(
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(io::Error::new(io::ErrorKind::Interrupted, "desktop IPC cancelled")),
            result = timeout(CONNECT_TIMEOUT, connect) => result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "desktop connect deadline"))??,
        },
        false,
    );
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    let work = async {
        peer(pipe.as_raw_handle(), false, Some(expected_pid))?;
        let json = frame::serialize_bounded(request, REQUEST_LIMIT)?;
        frame::write_frame(&mut *pipe, &json, REQUEST_LIMIT).await?;
        let response: Response = frame::read_frame(&mut *pipe, RESPONSE_LIMIT).await?;
        reject_buffered_extra(&mut *pipe).await?;
        response.validate(request)?;
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "desktop request deadline",
            ));
        }
        Ok(response)
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(io::Error::new(io::ErrorKind::Interrupted, "desktop IPC cancelled")),
        result = tokio::time::timeout_at(deadline, work) => result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "desktop request deadline"))?,
    }
}

/// Call from a desktop blocking worker, never from a Tokio async worker or a GUI thread.
/// The contained runtime has no detached tasks and is dropped only after its owned pipe closes.
pub fn request_blocking(
    name: &str,
    expected_pid: u32,
    request: &Request,
    cancel: &Cancellation,
) -> io::Result<Response> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(self::request(name, expected_pid, request, cancel))
}

pub fn normalize_directory(path: &Path) -> io::Result<String> {
    let canonical = std::fs::canonicalize(path)?;
    let text = canonical
        .into_os_string()
        .into_string()
        .map_err(|_| invalid("non-Unicode desktop directory"))?;
    let text = if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    };
    let input: Vec<u16> = text.encode_utf16().collect();
    let needed = unsafe {
        LCMapStringEx(
            LOCALE_NAME_INVARIANT,
            LCMAP_LOWERCASE,
            input.as_ptr(),
            input.len() as i32,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        )
    };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut output = vec![0; needed as usize];
    if unsafe {
        LCMapStringEx(
            LOCALE_NAME_INVARIANT,
            LCMAP_LOWERCASE,
            input.as_ptr(),
            input.len() as i32,
            output.as_mut_ptr(),
            needed,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    String::from_utf16(&output).map_err(|_| invalid("invalid desktop directory encoding"))
}

/// Bounded before allocation and JSON parsing. Rejects reparse points and broad/inherited ACLs.
pub fn read_private_bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !metadata.is_file() {
        return Err(denied("private desktop file must be a regular file"));
    }
    validate_private_file(&file)?;
    if file.metadata()?.len() > limit as u64 {
        return Err(invalid("desktop file exceeds budget"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(invalid("desktop file exceeds budget"));
    }
    Ok(bytes)
}

pub fn write_private_atomic(path: &Path, bytes: &[u8], limit: usize) -> io::Result<()> {
    use std::io::Write;
    if bytes.len() > limit {
        return Err(invalid("desktop file exceeds budget"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid("desktop file needs parent"))?;
    let temporary = parent.join(format!(".hertz-desktop-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let security = PrivateSecurity::new()?;
        let attributes = security.attributes();
        let name = wide(temporary.as_os_str());
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                0xC000_0000,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                &attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut file = unsafe { std::fs::File::from_raw_handle(handle) };
        file.write_all(bytes)?;
        file.sync_all()?;
        validate_private_file(&file)?;
        drop(file);
        let destination = wide(path.as_os_str());
        if unsafe {
            MoveFileExW(
                name.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn validate_private_file(file: &std::fs::File) -> io::Result<()> {
    let mut owner = std::ptr::null_mut();
    let mut dacl = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let _owned = LocalAllocation(descriptor);
    let identity = Identity::current()?;
    if owner.is_null() || unsafe { sid_text(owner)? } != identity.user_sid || dacl.is_null() {
        return Err(denied("private desktop file owner/DACL mismatch"));
    }
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if control & SE_DACL_PROTECTED == 0 {
        return Err(denied("private desktop file has inherited permissions"));
    }
    let mut info = ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if info.AceCount != 1 {
        return Err(denied(
            "private desktop file must have one current-user ACE",
        ));
    }
    let mut ace = std::ptr::null_mut();
    if unsafe { GetAce(dacl, 0, &mut ace) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let ace = unsafe { &*(ace.cast::<ACCESS_ALLOWED_ACE>()) };
    // ACCESS_ALLOWED_ACE_TYPE is the stable WinNT.h value zero.
    if ace.Header.AceType != 0 || ace.Header.AceFlags != 0 {
        return Err(denied("private desktop file has unexpected ACE"));
    }
    let sid = (&ace.SidStart as *const u32).cast_mut().cast();
    if unsafe { GetLengthSid(sid) } == 0 || unsafe { sid_text(sid)? } != identity.user_sid {
        return Err(denied("private desktop file grants another SID"));
    }
    Ok(())
}
