// SPDX-License-Identifier: MIT
//! Legacy raw-JSON management messages. Deliberately separate from the framed data protocol.
//!
//! A single caller-owned worker uses native overlapped operations, preserving message boundaries
//! (including ERROR_MORE_DATA). Every operation shares the connection's deadline. Cancellation
//! cancels the actual kernel operation before its OVERLAPPED and buffer can be released.
use crate::{
    frame::serialize_bounded,
    windows::{peer, Cancellation, Identity, OwnedPipe, PrivateSecurity},
    CONNECT_TIMEOUT, REQUEST_TIMEOUT,
};
use serde_json::Value;
use std::{
    io,
    mem::zeroed,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::mpsc,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_IO_INCOMPLETE, ERROR_IO_PENDING,
        ERROR_MORE_DATA, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
        ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
        INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
        OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    },
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, SetNamedPipeHandleState, PIPE_READMODE_MESSAGE,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_WAIT,
        },
        Threading::{CreateEventW, WaitForSingleObject},
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
    },
};

pub const MESSAGE_LIMIT: usize = 8192;
const POLL: Duration = Duration::from_millis(10);

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn closed(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(code) if code == ERROR_BROKEN_PIPE as i32 || code == ERROR_NO_DATA as i32 || code == ERROR_PIPE_NOT_CONNECTED as i32)
}

/// GUI admission expires even when the event loop has not yet dequeued the command.
#[derive(Clone)]
pub struct Admission {
    cancel: Cancellation,
    deadline: Instant,
}
impl Admission {
    pub fn is_valid(&self) -> bool {
        !self.cancel.is_cancelled() && Instant::now() < self.deadline
    }
}

pub fn pipe_name() -> String {
    let user = std::env::var("USERNAME").unwrap_or_default();
    let safe: String = user
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    let suffix = if safe.is_empty() { "user" } else { &safe };
    format!(r"\\.\pipe\hertz-desktop-control-{suffix}")
}
fn name_wide(name: &str) -> io::Result<Vec<u16>> {
    let suffix = name
        .strip_prefix(r"\\.\pipe\hertz-desktop-control-")
        .ok_or_else(|| invalid("invalid management pipe namespace"))?;
    if suffix.is_empty()
        || suffix.len() > 64
        || !suffix
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(invalid("invalid management pipe name"));
    }
    Ok(name.encode_utf16().chain(Some(0)).collect())
}
fn check(cancel: &Cancellation, deadline: Instant) -> io::Result<()> {
    if cancel.is_cancelled() {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "management operation cancelled",
        ));
    }
    if Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "management connection deadline",
        ));
    }
    Ok(())
}

// This handle is NOT registered with Mio/IOCP: no hidden prefetch or stream conversion.
// The operation borrows its pipe and buffer until completion, including cancellation completion.
struct Operation {
    pipe: HANDLE,
    overlapped: Box<OVERLAPPED>,
    event: OwnedHandle,
    pending: bool,
}
impl Operation {
    fn new(pipe: HANDLE) -> io::Result<Self> {
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        let event = unsafe { OwnedHandle::from_raw_handle(event) };
        let mut overlapped: Box<OVERLAPPED> = Box::new(unsafe { zeroed() });
        overlapped.hEvent = event.as_raw_handle();
        Ok(Self {
            pipe,
            overlapped,
            event,
            pending: false,
        })
    }
    fn run(
        mut self,
        cancel: &Cancellation,
        deadline: Option<Instant>,
        start: impl FnOnce(*mut OVERLAPPED) -> i32,
    ) -> io::Result<u32> {
        check(cancel, deadline.unwrap_or_else(|| Instant::now() + POLL))?;
        self.begin(start)?;
        self.wait(cancel, deadline)
    }
    fn begin(&mut self, start: impl FnOnce(*mut OVERLAPPED) -> i32) -> io::Result<()> {
        self.pending = true;
        if start(&mut *self.overlapped) == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                self.pending = false;
                return Err(error);
            }
        }
        Ok(())
    }
    fn completion(&mut self) -> io::Result<Option<u32>> {
        let mut transferred = 0;
        if unsafe { GetOverlappedResult(self.pipe, &*self.overlapped, &mut transferred, 0) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_IO_INCOMPLETE as i32) {
                return Ok(None);
            }
            self.pending = false;
            return Err(error);
        }
        self.pending = false;
        Ok(Some(transferred))
    }
    fn wait(&mut self, cancel: &Cancellation, deadline: Option<Instant>) -> io::Result<u32> {
        loop {
            check(cancel, deadline.unwrap_or_else(|| Instant::now() + POLL))?;
            let remaining = deadline.map_or(POLL, |deadline| {
                deadline.saturating_duration_since(Instant::now()).min(POLL)
            });
            match unsafe {
                WaitForSingleObject(
                    self.event.as_raw_handle(),
                    remaining.as_millis().max(1) as u32,
                )
            } {
                WAIT_OBJECT_0 => {
                    if let Some(transferred) = self.completion()? {
                        return Ok(transferred);
                    }
                }
                WAIT_TIMEOUT => {}
                WAIT_FAILED => return Err(io::Error::last_os_error()),
                _ => return Err(io::Error::other("invalid management I/O event state")),
            }
        }
    }
    fn cancel_and_reap(&mut self) -> io::Result<u32> {
        // NPFS cancellation completes even if the peer never reads/writes/closes. Reap before
        // freeing OVERLAPPED/buffer. A raced successful completion is returned to the probe.
        unsafe {
            CancelIoEx(self.pipe, &*self.overlapped);
        }
        let mut transferred = 0;
        let ok = unsafe { GetOverlappedResult(self.pipe, &*self.overlapped, &mut transferred, 1) };
        self.pending = false;
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(transferred)
    }
}

// PeekNamedPipe's byte count cannot distinguish no message from a queued zero-length message.
// Keep one real message read pending from admission through delivery. A successful read of ANY
// length (including zero) is an extra message; only a broken/disconnected pipe means close.
struct ExtraMessageRead {
    operation: Operation,
    // Declaration order ensures operation cancellation is reaped before this buffer is freed.
    _byte: Box<[u8; 1]>,
}
impl ExtraMessageRead {
    fn new(handle: HANDLE) -> io::Result<Self> {
        let mut byte = Box::new([0u8; 1]);
        let mut operation = Operation::new(handle)?;
        operation.begin(|overlapped| unsafe {
            ReadFile(
                handle,
                byte.as_mut_ptr(),
                1,
                std::ptr::null_mut(),
                overlapped,
            )
        })?;
        Ok(Self {
            operation,
            _byte: byte,
        })
    }
    fn result(result: io::Result<Option<u32>>) -> io::Result<bool> {
        match result {
            Ok(None) => Ok(true),
            Ok(Some(_)) => Err(invalid("multiple management messages on one connection")),
            Err(error) if closed(&error) => Ok(false),
            Err(error) if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) => {
                Err(invalid("multiple management messages on one connection"))
            }
            Err(error) => Err(error),
        }
    }
    fn peer_open(&mut self) -> io::Result<bool> {
        Self::result(self.operation.completion())
    }
    fn probe(&mut self) -> io::Result<()> {
        if !self.peer_open()? {
            return Ok(());
        }
        // Reap the actual cancelled read rather than silently discarding a completion that
        // races the nonblocking probe. Only our own ABORTED completion means no extra message.
        match self.operation.cancel_and_reap() {
            Err(error) if error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) => Ok(()),
            result => Self::result(result.map(Some)).map(|_| ()),
        }
    }
    fn wait_close(&mut self, cancel: &Cancellation, deadline: Instant) -> io::Result<()> {
        Self::result(self.operation.wait(cancel, Some(deadline)).map(Some))?;
        Ok(())
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if self.pending {
            let _ = self.cancel_and_reap();
        }
    }
}

pub struct Server {
    pipe: OwnedPipe<OwnedHandle>,
}
pub fn create_server(name: &str) -> io::Result<Server> {
    let name = name_wide(name)?;
    Identity::current()?.ensure_interactive()?;
    let security = PrivateSecurity::new()?;
    let attributes = security.attributes();
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            MESSAGE_LIMIT as u32,
            MESSAGE_LIMIT as u32,
            1000,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(Server {
        pipe: OwnedPipe(unsafe { OwnedHandle::from_raw_handle(handle) }, true),
    })
}
impl Server {
    /// Listening does not consume a request budget. Polling permits bounded worker shutdown.
    pub fn accept(self, cancel: &Cancellation) -> io::Result<Connection> {
        let handle = self.pipe.as_raw_handle();
        let operation = Operation::new(handle)?;
        let result = operation.run(cancel, None, |overlapped| unsafe {
            ConnectNamedPipe(handle, overlapped)
        });
        if let Err(error) = result {
            if error.raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32) {
                return Err(error);
            }
        }
        let admission = Admission {
            cancel: Cancellation::new(),
            deadline: Instant::now() + REQUEST_TIMEOUT,
        };
        Ok(Connection {
            pipe: self.pipe,
            admission,
        })
    }
}
pub struct Connection {
    pipe: OwnedPipe<OwnedHandle>,
    admission: Admission,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.admission.cancel.cancel();
    }
}

fn read_message(handle: HANDLE, cancel: &Cancellation, deadline: Instant) -> io::Result<Value> {
    let mut bytes = [0u8; MESSAGE_LIMIT];
    let read = Operation::new(handle)?
        .run(cancel, Some(deadline), |overlapped| unsafe {
            ReadFile(
                handle,
                bytes.as_mut_ptr(),
                MESSAGE_LIMIT as u32,
                std::ptr::null_mut(),
                overlapped,
            )
        })
        .map_err(|error| {
            if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) {
                invalid("management message exceeds 8192 bytes")
            } else {
                error
            }
        })?;
    let value: Value = serde_json::from_slice(&bytes[..read as usize])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if !value.is_object() {
        return Err(invalid("management JSON must be an object"));
    }
    Ok(value)
}
fn write_message(
    handle: HANDLE,
    bytes: &[u8],
    cancel: &Cancellation,
    deadline: Instant,
) -> io::Result<()> {
    let written = Operation::new(handle)?.run(cancel, Some(deadline), |overlapped| unsafe {
        WriteFile(
            handle,
            bytes.as_ptr(),
            bytes.len() as u32,
            std::ptr::null_mut(),
            overlapped,
        )
    })?;
    if written as usize != bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "incomplete management message",
        ));
    }
    Ok(())
}
#[cfg(test)]
fn peer_open_without_extra(handle: HANDLE) -> io::Result<bool> {
    let mut available = 0;
    if unsafe {
        windows_sys::Win32::System::Pipes::PeekNamedPipe(
            handle,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    } == 0
    {
        let error = io::Error::last_os_error();
        if closed(&error) {
            return Ok(false);
        }
        return Err(error);
    }
    if available != 0 {
        return Err(invalid("multiple management messages on one connection"));
    }
    Ok(true)
}
impl Connection {
    pub fn serve(
        self,
        cancel: &Cancellation,
        handler: impl FnOnce(Value, Admission) -> mpsc::Receiver<Value>,
    ) -> io::Result<()> {
        let handle = self.pipe.as_raw_handle();
        let deadline = self.admission.deadline;
        check(cancel, deadline)?;
        peer(handle, true, None)?;
        let body = read_message(handle, cancel, deadline)?;
        check(cancel, deadline)?;
        let mut extra = ExtraMessageRead::new(handle).map_err(|error| {
            if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) {
                invalid("multiple management messages on one connection")
            } else {
                error
            }
        })?;
        if !extra.peer_open()? {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "management client disconnected",
            ));
        }
        let receiver = handler(body, self.admission.clone());
        let response = loop {
            check(cancel, deadline)?;
            if !extra.peer_open()? {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "management client cancelled before reply",
                ));
            }
            match receiver.try_recv() {
                Ok(response) => break response,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "management GUI reply channel closed",
                    ))
                }
                Err(mpsc::TryRecvError::Empty) => {
                    std::thread::sleep(POLL.min(deadline.saturating_duration_since(Instant::now())))
                }
            }
        };
        if !response.is_object() {
            return Err(invalid("management reply must be an object"));
        }
        let bytes = serialize_bounded(&response, MESSAGE_LIMIT).unwrap_or_else(|_| {
            br#"{"ok":false,"error":"control response exceeds 8192 bytes"}"#.to_vec()
        });
        check(cancel, deadline)?;
        if !extra.peer_open()? {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "management client cancelled before write",
            ));
        }
        write_message(handle, &bytes, cancel, deadline)?;
        // Do not FlushFileBuffers: preserve delivery until the legacy client reads and closes,
        // but a non-reading client can hold this sole slot only until the same total deadline.
        extra.wait_close(cancel, deadline)
    }
}

/// Synchronous caller boundary, with actual overlapped cancellation for future async facades.
pub fn request(name: &str, payload: &Value, cancel: &Cancellation) -> io::Result<Value> {
    request_until(name, payload, cancel, None)
}

/// Clip both the connection and connected budgets to a caller's total deadline.
/// Cancellation still reaches the actual OVERLAPPED operations and reaps them on return.
pub fn request_until(
    name: &str,
    payload: &Value,
    cancel: &Cancellation,
    until: Option<Instant>,
) -> io::Result<Value> {
    if !payload.is_object() {
        return Err(invalid("management request must be an object"));
    }
    let bytes = serialize_bounded(payload, MESSAGE_LIMIT)?;
    let name = name_wide(name)?;
    let connecting = until.map_or_else(
        || Instant::now() + CONNECT_TIMEOUT,
        |until| until.min(Instant::now() + CONNECT_TIMEOUT),
    );
    let mut saw_busy = false;
    let pipe = loop {
        check(cancel, connecting).map_err(|error| {
            if error.kind() == io::ErrorKind::TimedOut
                && !saw_busy
                && until.is_none_or(|until| Instant::now() < until)
            {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "management listener is not running",
                )
            } else {
                error
            }
        })?;
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            break OwnedPipe(unsafe { OwnedHandle::from_raw_handle(handle) }, false);
        }
        let error = io::Error::last_os_error();
        saw_busy |= error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32);
        if !matches!(error.raw_os_error(), Some(code) if code == ERROR_FILE_NOT_FOUND as i32 || code == ERROR_PIPE_BUSY as i32)
        {
            return Err(error);
        }
        std::thread::sleep(POLL.min(connecting.saturating_duration_since(Instant::now())));
    };
    let deadline = until.map_or_else(
        || Instant::now() + REQUEST_TIMEOUT,
        |until| until.min(Instant::now() + REQUEST_TIMEOUT),
    );
    peer(pipe.as_raw_handle(), false, None)?;
    let mode = PIPE_READMODE_MESSAGE;
    if unsafe {
        SetNamedPipeHandleState(
            pipe.as_raw_handle(),
            &mode,
            std::ptr::null(),
            std::ptr::null(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    write_message(pipe.as_raw_handle(), &bytes, cancel, deadline)?;
    read_response(pipe.as_raw_handle(), cancel, deadline)
}

fn read_response(handle: HANDLE, cancel: &Cancellation, deadline: Instant) -> io::Result<Value> {
    let response = read_message(handle, cancel, deadline)?;
    check(cancel, deadline)?;
    match ExtraMessageRead::new(handle) {
        Ok(mut extra) => {
            extra.probe()?;
        }
        Err(error) if closed(&error) => {}
        Err(error) if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) => {
            return Err(invalid("multiple management messages on one connection"))
        }
        Err(error) => return Err(error),
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::thread;

    fn fixture(
        count: usize,
        mut handler: impl FnMut(Value, Admission) -> mpsc::Receiver<Value> + Send + 'static,
    ) -> (String, thread::JoinHandle<Vec<io::Result<()>>>) {
        let name = format!(
            r"\\.\pipe\hertz-desktop-control-test-{}",
            uuid::Uuid::new_v4()
        );
        let (ready, wait) = mpsc::channel();
        let server_name = name.clone();
        let worker = thread::spawn(move || {
            let cancel = Cancellation::new();
            (0..count)
                .map(|index| {
                    let server = create_server(&server_name).unwrap();
                    if index == 0 {
                        ready.send(()).unwrap();
                    }
                    server.accept(&cancel).unwrap().serve(&cancel, &mut handler)
                })
                .collect()
        });
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        (name, worker)
    }
    fn reply(value: Value) -> mpsc::Receiver<Value> {
        let (send, receive) = mpsc::channel();
        send.send(value).unwrap();
        receive
    }
    fn raw_client(name: &str, overlapped: bool) -> OwnedPipe<OwnedHandle> {
        let name = name_wide(name).unwrap();
        let deadline = Instant::now() + CONNECT_TIMEOUT;
        loop {
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    if overlapped { FILE_FLAG_OVERLAPPED } else { 0 },
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return OwnedPipe(unsafe { OwnedHandle::from_raw_handle(handle) }, false);
            }
            assert!(
                Instant::now() < deadline,
                "fixture connect: {}",
                io::Error::last_os_error()
            );
            thread::sleep(POLL);
        }
    }
    fn raw_write(pipe: &OwnedPipe<OwnedHandle>, bytes: &[u8]) -> io::Result<()> {
        write_message(
            pipe.as_raw_handle(),
            bytes,
            &Cancellation::new(),
            Instant::now() + REQUEST_TIMEOUT,
        )
    }
    fn mode_message(pipe: &OwnedPipe<OwnedHandle>) {
        assert_ne!(
            unsafe {
                SetNamedPipeHandleState(
                    pipe.as_raw_handle(),
                    &PIPE_READMODE_MESSAGE,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            0
        );
    }

    #[test]
    fn legacy_byte_read_client_and_new_client_use_raw_status_messages() {
        let (name, worker) = fixture(2, |body, _| {
            assert_eq!(body, json!({"action":"status"}));
            reply(json!({"ok":true,"managementProtocol":1}))
        });
        // Old client opens synchronously, default byte read mode, no frame prefix.
        let pipe = raw_client(&name, false);
        let bytes = br#"{"action":"status"}"#;
        let mut size = 0;
        assert_ne!(
            unsafe {
                WriteFile(
                    pipe.as_raw_handle(),
                    bytes.as_ptr(),
                    bytes.len() as u32,
                    &mut size,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let mut buffer = [0u8; MESSAGE_LIMIT];
        assert_ne!(
            unsafe {
                ReadFile(
                    pipe.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    MESSAGE_LIMIT as u32,
                    &mut size,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&buffer[..size as usize]).unwrap(),
            json!({"ok":true,"managementProtocol":1})
        );
        drop(pipe);
        assert_eq!(
            request(&name, &json!({"action":"status"}), &Cancellation::new()).unwrap()["ok"],
            true
        );
        assert!(worker
            .join()
            .unwrap()
            .into_iter()
            .all(|result| result.is_ok()));
    }

    #[test]
    fn new_client_accepts_legacy_default_acl_message_server() {
        let name = format!(
            r"\\.\pipe\hertz-desktop-control-test-{}",
            uuid::Uuid::new_v4()
        );
        let (ready, wait) = mpsc::channel();
        let server_name = name.clone();
        let worker = thread::spawn(move || {
            let wide = name_wide(&server_name).unwrap();
            // Deliberately legacy default DACL. Client authenticates actual PID/token/session.
            let handle = unsafe {
                CreateNamedPipeW(
                    wide.as_ptr(),
                    PIPE_ACCESS_DUPLEX,
                    PIPE_TYPE_MESSAGE
                        | PIPE_READMODE_MESSAGE
                        | PIPE_WAIT
                        | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    MESSAGE_LIMIT as u32,
                    MESSAGE_LIMIT as u32,
                    2000,
                    std::ptr::null(),
                )
            };
            assert_ne!(handle, INVALID_HANDLE_VALUE);
            let pipe = OwnedPipe(unsafe { OwnedHandle::from_raw_handle(handle) }, true);
            ready.send(()).unwrap();
            if unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } == 0 {
                assert_eq!(
                    io::Error::last_os_error().raw_os_error(),
                    Some(ERROR_PIPE_CONNECTED as i32)
                );
            }
            assert_eq!(peer(handle, true, None).unwrap().pid, std::process::id());
            let mut buffer = [0u8; MESSAGE_LIMIT];
            let mut size = 0;
            assert_ne!(
                unsafe {
                    ReadFile(
                        handle,
                        buffer.as_mut_ptr(),
                        MESSAGE_LIMIT as u32,
                        &mut size,
                        std::ptr::null_mut(),
                    )
                },
                0
            );
            assert_eq!(
                serde_json::from_slice::<Value>(&buffer[..size as usize]).unwrap(),
                json!({"action":"status"})
            );
            let bytes = br#"{"ok":true,"managementProtocol":1}"#;
            assert_ne!(
                unsafe {
                    WriteFile(
                        handle,
                        bytes.as_ptr(),
                        bytes.len() as u32,
                        &mut size,
                        std::ptr::null_mut(),
                    )
                },
                0
            );
            // Model the old server's flush delivery barrier; only the fixture uses this API.
            unsafe {
                windows_sys::Win32::Storage::FileSystem::FlushFileBuffers(handle);
            }
            drop(pipe);
        });
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            request(&name, &json!({"action":"status"}), &Cancellation::new()).unwrap(),
            json!({"ok":true,"managementProtocol":1})
        );
        worker.join().unwrap();
    }

    #[test]
    fn malformed_oversized_nonobject_and_multimessage_requests_never_reach_gui() {
        let cases = [
            br#"{"action":"#.to_vec(),
            vec![255],
            br#"{} {}"#.to_vec(),
            br#"{}x"#.to_vec(),
            b"[]".to_vec(),
            vec![b'x'; MESSAGE_LIMIT + 1],
        ];
        for bytes in cases {
            let (name, worker) = fixture(1, |_, _| panic!("invalid request reached GUI"));
            let pipe = raw_client(&name, true);
            let _ = raw_write(&pipe, &bytes);
            assert!(worker.join().unwrap().pop().unwrap().is_err());
        }
        // Separate pipe messages must not be silently concatenated into valid JSON.
        let (name, worker) = fixture(1, |_, _| panic!("split JSON reached GUI"));
        let pipe = raw_client(&name, true);
        raw_write(&pipe, br#"{"action":"#).unwrap();
        let _ = raw_write(&pipe, br#""status"}"#);
        assert!(worker.join().unwrap().pop().unwrap().is_err());
    }

    #[test]
    fn delayed_second_message_invalidates_waiting_gui_admission() {
        let (queued, pending) = mpsc::channel();
        let (name, worker) = fixture(1, move |_, admission| {
            let (reply, wait) = mpsc::channel();
            queued.send((admission, reply)).unwrap();
            wait
        });
        let pipe = raw_client(&name, true);
        raw_write(&pipe, b"{}").unwrap();
        let (admission, _reply) = pending.recv_timeout(Duration::from_secs(1)).unwrap();
        raw_write(&pipe, b"{}").unwrap();
        assert_eq!(
            worker.join().unwrap().pop().unwrap().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(!admission.is_valid());
    }

    #[test]
    fn prequeued_empty_or_nonempty_second_message_is_rejected_before_gui() {
        for second in [b"".as_slice(), b"{}".as_slice(), b"x".as_slice()] {
            let name = format!(
                r"\\.\pipe\hertz-desktop-control-test-{}",
                uuid::Uuid::new_v4()
            );
            let server = create_server(&name).unwrap();
            let client = raw_client(&name, true);
            // Both messages are fully queued before accept, so handler admission is deterministic.
            raw_write(&client, b"{}").unwrap();
            raw_write(&client, second).unwrap();
            let mut reached = 0;
            let result =
                server
                    .accept(&Cancellation::new())
                    .unwrap()
                    .serve(&Cancellation::new(), |_, _| {
                        reached += 1;
                        reply(json!({"ok":true}))
                    });
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
            assert_eq!(reached, 0);
            // Do not close the peer until after the rejection has completed.
            drop(client);
        }
    }

    #[test]
    fn empty_second_message_during_gui_wait_cancels_admission() {
        let (queued, pending) = mpsc::channel();
        let (name, worker) = fixture(1, move |_, admission| {
            let (reply, wait) = mpsc::channel();
            queued.send((admission, reply)).unwrap();
            wait
        });
        let client = raw_client(&name, true);
        raw_write(&client, b"{}").unwrap();
        let (admission, _reply) = pending.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(admission.is_valid());
        raw_write(&client, b"").unwrap();
        assert_eq!(
            worker.join().unwrap().pop().unwrap().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(!admission.is_valid());
        drop(client);
    }

    #[test]
    fn empty_message_during_delivery_is_rejected_and_real_close_reclaims_promptly() {
        let (queued, pending) = mpsc::channel();
        let (name, worker) = fixture(2, move |_, admission| {
            queued.send(admission).unwrap();
            reply(json!({"ok":true}))
        });
        let client = raw_client(&name, true);
        mode_message(&client);
        raw_write(&client, b"{}").unwrap();
        let admission = pending.recv_timeout(Duration::from_secs(1)).unwrap();
        let response = read_message(
            client.as_raw_handle(),
            &Cancellation::new(),
            Instant::now() + REQUEST_TIMEOUT,
        )
        .unwrap();
        assert_eq!(response["ok"], true);
        // Receipt proves that the server reached response delivery; keep this client open.
        raw_write(&client, b"").unwrap();
        let until = Instant::now() + Duration::from_secs(1);
        while admission.is_valid() {
            assert!(Instant::now() < until);
            thread::sleep(POLL);
        }
        let started = Instant::now();
        assert_eq!(
            request(&name, &json!({}), &Cancellation::new()).unwrap()["ok"],
            true
        );
        let next = pending.recv_timeout(Duration::from_secs(1)).unwrap();
        let results = worker.join().unwrap();
        assert_eq!(
            results[0].as_ref().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(results[1].is_ok());
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "normal client close waited for the total deadline"
        );
        assert!(!next.is_valid());
        drop(client);
    }

    #[test]
    fn client_probe_rejects_prequeued_empty_second_reply_without_waiting_for_close() {
        for second in [None, Some(b"".as_slice()), Some(b"{}".as_slice())] {
            let name = format!(
                r"\\.\pipe\hertz-desktop-control-test-{}",
                uuid::Uuid::new_v4()
            );
            let server = create_server(&name).unwrap();
            let client = raw_client(&name, true);
            mode_message(&client);
            let connection = server.accept(&Cancellation::new()).unwrap();
            // Queue replies completely before invoking the same response path used by request().
            let handle = connection.pipe.as_raw_handle();
            raw_write(&connection.pipe, b"{}").unwrap();
            if let Some(second) = second {
                raw_write(&connection.pipe, second).unwrap();
            }
            let started = Instant::now();
            let result = read_response(
                client.as_raw_handle(),
                &Cancellation::new(),
                started + REQUEST_TIMEOUT,
            );
            if second.is_some() {
                assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
            } else {
                assert_eq!(result.unwrap(), json!({}));
            }
            assert!(
                started.elapsed() < Duration::from_millis(250),
                "response probe waited for a still-open peer"
            );
            // Neither endpoint closes until the completed/nonblocking probe result is checked.
            assert!(peer(handle, true, None).is_ok());
            drop(client);
            drop(connection);
        }
    }

    #[test]
    fn oversized_response_becomes_complete_small_error_and_request_serialization_is_bounded() {
        let (name, worker) = fixture(1, |_, _| {
            reply(json!({"large":"x".repeat(MESSAGE_LIMIT * 2)}))
        });
        let response = request(&name, &json!({}), &Cancellation::new()).unwrap();
        assert_eq!(response["ok"], false);
        assert!(response["error"].as_str().unwrap().contains("8192"));
        assert!(worker.join().unwrap().pop().unwrap().is_ok());
        assert_eq!(
            request(
                &name,
                &json!({"large":"x".repeat(MESSAGE_LIMIT * 2)}),
                &Cancellation::new()
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::Other
        );
        assert!(request(&name, &json!([]), &Cancellation::new()).is_err());
    }

    #[test]
    fn connected_budget_covers_read_gui_write_and_late_gui_is_skipped() {
        let (queued, pending) = mpsc::channel();
        let mut first = true;
        let (name, worker) = fixture(2, move |_, admission| {
            if first {
                first = false;
                let (reply, wait) = mpsc::channel();
                queued.send((admission, reply)).unwrap();
                wait
            } else {
                reply(json!({"ok":true}))
            }
        });
        let pipe = raw_client(&name, true);
        let connected = Instant::now();
        thread::sleep(Duration::from_millis(700));
        raw_write(&pipe, b"{}").unwrap();
        let (admission, late_reply) = pending.recv_timeout(Duration::from_secs(1)).unwrap();
        while admission.is_valid() {
            thread::sleep(POLL);
        }
        assert!(
            connected.elapsed() < Duration::from_millis(2300),
            "budget restarted after request read"
        );
        let mut mutations = 0;
        if admission.is_valid() {
            mutations += 1;
        }
        assert_eq!(mutations, 0);
        let _ = late_reply.send(json!({"ok":true}));
        // Hold the original client open: recovery must not depend on its close.
        assert_eq!(
            request(&name, &json!({}), &Cancellation::new()).unwrap()["ok"],
            true
        );
        let results = worker.join().unwrap();
        assert_eq!(
            results[0].as_ref().unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert!(results[1].is_ok());
        drop(pipe);
    }

    #[test]
    fn nonreader_kept_open_cannot_hold_slot_past_deadline() {
        let (name, worker) = fixture(2, |_, _| {
            reply(json!({"ok":true,"padding":"x".repeat(8000)}))
        });
        let pipe = raw_client(&name, true);
        raw_write(&pipe, b"{}").unwrap();
        thread::sleep(Duration::from_millis(2100));
        assert_eq!(
            request(&name, &json!({}), &Cancellation::new()).unwrap()["ok"],
            true
        );
        let results = worker.join().unwrap();
        assert_eq!(
            results[0].as_ref().unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert!(results[1].is_ok());
        drop(pipe);
    }

    #[test]
    fn client_cancellation_cancels_real_read_and_invalidates_queued_work() {
        let (queued, pending) = mpsc::channel();
        let (name, worker) = fixture(1, move |_, admission| {
            let (reply, wait) = mpsc::channel();
            queued.send((admission, reply)).unwrap();
            wait
        });
        let cancel = Cancellation::new();
        let client_cancel = cancel.clone();
        let client = thread::spawn(move || request(&name, &json!({}), &client_cancel));
        let (admission, _reply) = pending.recv_timeout(Duration::from_secs(1)).unwrap();
        let stopped = Instant::now();
        cancel.cancel();
        assert_eq!(
            client.join().unwrap().unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
        assert!(worker.join().unwrap().pop().unwrap().is_err());
        assert!(stopped.elapsed() < Duration::from_millis(250));
        assert!(!admission.is_valid());
    }

    #[test]
    fn listener_and_silent_peer_read_are_really_cancelled() {
        for connected in [false, true] {
            let name = format!(
                r"\\.\pipe\hertz-desktop-control-test-{}",
                uuid::Uuid::new_v4()
            );
            let server = create_server(&name).unwrap();
            let cancel = Cancellation::new();
            let server_cancel = cancel.clone();
            let worker = thread::spawn(move || {
                server.accept(&server_cancel).and_then(|connection| {
                    connection.serve(&server_cancel, |_, _| panic!("silent peer"))
                })
            });
            let pipe = connected.then(|| raw_client(&name, true));
            thread::sleep(Duration::from_millis(30));
            let stopped = Instant::now();
            cancel.cancel();
            assert_eq!(
                worker.join().unwrap().unwrap_err().kind(),
                io::ErrorKind::Interrupted
            );
            assert!(stopped.elapsed() < Duration::from_millis(250));
            // Re-create while the old peer handle remains open.
            assert!(create_server(&name).is_ok());
            drop(pipe);
        }
    }

    #[test]
    fn pending_write_to_nonreader_is_cancelled_before_buffer_and_handle_drop() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let name = format!(
            r"\\.\pipe\hertz-desktop-control-test-{}",
            uuid::Uuid::new_v4()
        );
        let wide = name_wide(&name).unwrap();
        // A tiny quota ensures the 8192-byte write cannot complete into the kernel buffer.
        let handle = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                64,
                64,
                1000,
                std::ptr::null(),
            )
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE);
        let server = Server {
            pipe: OwnedPipe(unsafe { OwnedHandle::from_raw_handle(handle) }, true),
        };
        let (connected, accepted) = mpsc::channel();
        let (release, wait_release) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _connection = server.accept(&Cancellation::new()).unwrap();
            connected.send(()).unwrap();
            wait_release.recv_timeout(Duration::from_secs(2)).unwrap();
        });
        let client = raw_client(&name, true);
        accepted.recv_timeout(Duration::from_secs(1)).unwrap();
        let pending = Arc::new(AtomicBool::new(false));
        let observed = pending.clone();
        let cancel = Cancellation::new();
        let trigger = cancel.clone();
        let canceller = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(1);
            while !observed.load(Ordering::Acquire) {
                assert!(Instant::now() < deadline, "write did not pend");
                thread::sleep(POLL);
            }
            trigger.cancel();
        });
        let bytes = [b'x'; MESSAGE_LIMIT];
        let started = Instant::now();
        let error = Operation::new(client.as_raw_handle())
            .unwrap()
            .run(&cancel, Some(started + REQUEST_TIMEOUT), |overlapped| {
                let ok = unsafe {
                    WriteFile(
                        client.as_raw_handle(),
                        bytes.as_ptr(),
                        MESSAGE_LIMIT as u32,
                        std::ptr::null_mut(),
                        overlapped,
                    )
                };
                let error = io::Error::last_os_error();
                assert_eq!(ok, 0);
                assert_eq!(error.raw_os_error(), Some(ERROR_IO_PENDING as i32));
                pending.store(true, Ordering::Release);
                ok
            })
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "NPFS cancellation did not reclaim pending write"
        );
        canceller.join().unwrap();
        // Both peer handles are still alive when cancellation returns.
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(create_server(&name).is_ok());
        drop(client);
    }

    #[test]
    fn client_rejects_invalid_partial_oversized_and_nonobject_raw_replies() {
        for bytes in [
            vec![255],
            b"{\"ok\":".to_vec(),
            b"{} {}".to_vec(),
            b"{}x".to_vec(),
            b"[]".to_vec(),
            vec![b'x'; MESSAGE_LIMIT + 1],
        ] {
            let name = format!(
                r"\\.\pipe\hertz-desktop-control-test-{}",
                uuid::Uuid::new_v4()
            );
            let server = create_server(&name).unwrap();
            let worker = thread::spawn(move || {
                let connection = server.accept(&Cancellation::new()).unwrap();
                let deadline = connection.admission.deadline;
                read_message(
                    connection.pipe.as_raw_handle(),
                    &Cancellation::new(),
                    deadline,
                )
                .unwrap();
                let _ = write_message(
                    connection.pipe.as_raw_handle(),
                    &bytes,
                    &Cancellation::new(),
                    deadline,
                );
                // Preserve raw reply delivery until the client closes, without a blocking flush.
                while Instant::now() < deadline
                    && peer_open_without_extra(connection.pipe.as_raw_handle()).unwrap_or(false)
                {
                    thread::sleep(POLL);
                }
            });
            assert_eq!(
                request(&name, &json!({}), &Cancellation::new())
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidData
            );
            worker.join().unwrap();
        }
    }

    #[test]
    fn connection_timeout_and_latched_cancel_are_bounded() {
        let absent = format!(
            r"\\.\pipe\hertz-desktop-control-test-{}",
            uuid::Uuid::new_v4()
        );
        let started = Instant::now();
        assert_eq!(
            request(&absent, &json!({}), &Cancellation::new())
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
        assert!(started.elapsed() < Duration::from_millis(1200));
        let cancel = Cancellation::new();
        cancel.cancel();
        assert_eq!(
            request(&absent, &json!({}), &cancel).unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
        let server = create_server(&absent).unwrap();
        let _occupied = raw_client(&absent, true);
        let started = Instant::now();
        assert_eq!(
            request(&absent, &json!({}), &Cancellation::new())
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert!(started.elapsed() < Duration::from_millis(1200));
        drop(server);
    }

    #[test]
    fn message_budget_is_exact_and_whitespace_is_allowed() {
        let (name, worker) = fixture(1, |body, _| {
            assert_eq!(body["padding"].as_str().unwrap().len(), MESSAGE_LIMIT - 14);
            reply(json!({"ok":true}))
        });
        let pipe = raw_client(&name, true);
        mode_message(&pipe);
        let bytes = format!("{{\"padding\":\"{}\"}}", "x".repeat(MESSAGE_LIMIT - 14));
        assert_eq!(bytes.len(), MESSAGE_LIMIT);
        raw_write(&pipe, bytes.as_bytes()).unwrap();
        assert_eq!(
            read_message(
                pipe.as_raw_handle(),
                &Cancellation::new(),
                Instant::now() + REQUEST_TIMEOUT
            )
            .unwrap()["ok"],
            true
        );
        drop(pipe);
        assert!(worker.join().unwrap().pop().unwrap().is_ok());
        let (name, worker) = fixture(1, |_, _| reply(json!({"ok":true})));
        let pipe = raw_client(&name, true);
        mode_message(&pipe);
        raw_write(&pipe, b"  {}\r\n ").unwrap();
        assert_eq!(
            read_message(
                pipe.as_raw_handle(),
                &Cancellation::new(),
                Instant::now() + REQUEST_TIMEOUT
            )
            .unwrap()["ok"],
            true
        );
        drop(pipe);
        assert!(worker.join().unwrap().pop().unwrap().is_ok());
    }

    // 期望串也要过同一个转换器：Windows 把内置 Administrator、SYSTEM 这类 Well-known 账户
    // 渲染成 SDDL 别名（`LA`、`SY`）而不是裸 SID，把裸 SID 拼成字面量在以管理员账户运行的
    // CI runner 上必然假失败。
    fn dacl_text(descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR) -> String {
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{
                    ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1,
                },
                DACL_SECURITY_INFORMATION,
            },
        };
        let mut text = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let mut length = 0;
        while unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        let sddl = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).unwrap();
        unsafe { LocalFree(text.cast()) };
        sddl
    }

    fn rendered_dacl(sddl: &str) -> String {
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
        };
        let source: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    source.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let text = dacl_text(descriptor);
        unsafe { LocalFree(descriptor) };
        text
    }

    #[test]
    fn private_acl_and_actual_peer_token_and_session() {
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
                DACL_SECURITY_INFORMATION,
            },
        };
        let name = format!(
            r"\\.\pipe\hertz-desktop-control-test-{}",
            uuid::Uuid::new_v4()
        );
        let server = create_server(&name).unwrap();
        let handle = server.pipe.as_raw_handle();
        let mut descriptor = std::ptr::null_mut();
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    handle,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        let sddl = dacl_text(descriptor);
        unsafe { LocalFree(descriptor) };
        assert_eq!(
            sddl,
            rendered_dacl(&format!(
                "D:P(A;;FA;;;{})",
                Identity::current().unwrap().user_sid
            ))
        );
        // 变异证明：别名替换是真实行为，S-1-5-18 恒渲染成 SY。缺了这条，把期望改成
        // 原样透传也能过，就不再保证「DACL 里只有当前用户一条 FA」。
        assert_eq!(rendered_dacl("D:P(A;;FA;;;S-1-5-18)"), "D:P(A;;FA;;;SY)");
        assert!(
            create_server(&name).is_err(),
            "management must have one instance"
        );
        let worker = thread::spawn(move || {
            let connection = server.accept(&Cancellation::new()).unwrap();
            let observed = peer(connection.pipe.as_raw_handle(), true, None).unwrap();
            assert_eq!(observed.pid, std::process::id());
            assert_eq!(observed.identity, Identity::current().unwrap());
        });
        let pipe = raw_client(&name, true);
        let observed = peer(pipe.as_raw_handle(), false, None).unwrap();
        assert_eq!(observed.pid, std::process::id());
        assert_eq!(observed.identity, Identity::current().unwrap());
        worker.join().unwrap();
    }
}
