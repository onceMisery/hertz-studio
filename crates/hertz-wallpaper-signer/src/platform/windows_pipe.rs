// SPDX-License-Identifier: MIT
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle},
    ptr::null_mut,
};

use tokio::net::windows::named_pipe::{NamedPipeClient, NamedPipeServer, PipeMode, ServerOptions};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    Security::{
        Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
            SE_KERNEL_OBJECT,
        },
        RevertToSelf, OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    },
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, FILE_READ_ATTRIBUTES, FILE_READ_DATA,
        FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, OPEN_EXISTING, SECURITY_IDENTIFICATION,
        SECURITY_SQOS_PRESENT,
    },
    System::{
        Pipes::{GetNamedPipeServerProcessId, ImpersonateNamedPipeClient},
        Threading::{GetCurrentThread, OpenThreadToken},
    },
};

use super::windows::{self, LocalAllocation, READ_CONTROL};
use crate::{
    config::Config,
    protocol::{Error, Result},
};

pub type ServerStream = NamedPipeServer;
pub type ClientStream = NamedPipeClient;
const SYNCHRONIZE: u32 = 0x0010_0000;

pub struct Listener {
    config: Config,
    pending: Option<NamedPipeServer>,
}
impl Listener {
    pub fn bind(config: &Config) -> Result<Self> {
        Ok(Self {
            config: config.clone(),
            pending: Some(create(config, true)?),
        })
    }
    pub async fn accept(&mut self) -> Result<ServerStream> {
        let pipe = self
            .pending
            .as_ref()
            .ok_or(Error("pipe_listener_unavailable"))?;
        pipe.connect().await?;
        let next = create(&self.config, false)?;
        self.pending
            .replace(next)
            .ok_or(Error("pipe_listener_unavailable"))
    }
}

fn create(config: &Config, first: bool) -> Result<NamedPipeServer> {
    windows::validate_endpoint(&config.endpoint, None)?;
    let mut sddl = format!(
        "O:{}D:P(A;;FA;;;{})",
        config.service_identity, config.service_identity
    );
    // Do not grant FILE_CREATE_PIPE_INSTANCE (the append-data bit) to clients.
    let client_access = FILE_READ_DATA
        | FILE_WRITE_DATA
        | FILE_READ_ATTRIBUTES
        | FILE_WRITE_ATTRIBUTES
        | READ_CONTROL
        | SYNCHRONIZE;
    for subject in std::iter::once(&config.hub_identity).chain(config.approver_identities.iter()) {
        windows::validate_identity(subject)?;
        sddl.push_str(&format!("(A;;0x{client_access:08x};;;{subject})"));
    }
    let sddl = windows::wide(std::ffi::OsStr::new(&sddl))?;
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(Error("pipe_security_unavailable"));
    }
    let _allocation = LocalAllocation(descriptor);
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .pipe_mode(PipeMode::Byte)
        .max_instances(5)
        .in_buffer_size(65_536)
        .out_buffer_size(65_536);
    unsafe {
        options.create_with_security_attributes_raw(
            &config.endpoint,
            (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
        )
    }
    .map_err(Into::into)
}

pub fn peer_identity(stream: &ServerStream) -> Result<String> {
    // Called immediately after the frame header has been read, on this thread.
    // No async work occurs while a client's identification token is installed.
    if unsafe { ImpersonateNamedPipeClient(stream.as_raw_handle()) } == 0 {
        return Err(Error("pipe_peer_identity_unavailable"));
    }
    let impersonation = Impersonation;
    let result = impersonated_identity();
    drop(impersonation);
    result
}

struct Impersonation;
impl Drop for Impersonation {
    fn drop(&mut self) {
        // Also revert during unwinding, before this executor thread does any
        // service work. Revert failure cannot be recovered by continuing.
        if unsafe { RevertToSelf() } == 0 {
            std::process::abort();
        }
    }
}

fn impersonated_identity() -> Result<String> {
    let mut token = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) } == 0 {
        return Err(Error("pipe_peer_identity_unavailable"));
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    windows::token_identity(token.as_raw_handle())
}

fn server_identity(handle: HANDLE) -> Result<String> {
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(handle, &mut pid) } == 0 || pid == 0 {
        return Err(Error("pipe_server_identity_unavailable"));
    }
    let mut owner = null_mut();
    let mut descriptor = null_mut();
    if unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    } != 0
    {
        return Err(Error("pipe_server_identity_unavailable"));
    }
    let _allocation = LocalAllocation(descriptor);
    // The kernel enforces the pipe's owner SID. Other configured users have
    // READ_CONTROL, but neither owner/ACL mutation nor instance-creation rights.
    // Querying a different service account's process token need not be allowed.
    let identity = unsafe { windows::sid_text(owner)? };
    let mut verified = 0;
    if unsafe { GetNamedPipeServerProcessId(handle, &mut verified) } == 0 || verified != pid {
        return Err(Error("pipe_server_identity_changed"));
    }
    Ok(identity)
}

pub async fn connect(endpoint: &str, expected_service: &str) -> Result<ClientStream> {
    windows::validate_endpoint(endpoint, None)?;
    windows::validate_identity(expected_service)?;
    let name = windows::wide(std::ffi::OsStr::new(endpoint))?;
    let access = FILE_READ_DATA
        | FILE_WRITE_DATA
        | FILE_READ_ATTRIBUTES
        | FILE_WRITE_ATTRIBUTES
        | READ_CONTROL
        | SYNCHRONIZE;
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            0,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(Error("signer_unavailable"));
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    if server_identity(handle.as_raw_handle())? != expected_service {
        return Err(Error("service_identity_mismatch"));
    }
    unsafe { NamedPipeClient::from_raw_handle(handle.into_raw_handle()) }.map_err(Into::into)
}
