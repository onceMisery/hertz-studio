// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 本机管理通道：当前用户命名管道，只接受有界 JSON 命令。
//!
//! 管道默认安全描述符把访问限制在创建者用户；`PIPE_REJECT_REMOTE_CLIENTS`
//! 拒绝远程客户端。命令本身再由 `App` 逐项校验，不提供路径、脚本或窗口句柄。

use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::Value;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    FlushFileBuffers, ReadFile, WriteFile, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PeekNamedPipe, PIPE_READMODE_MESSAGE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_WAIT,
};

const MAX_MESSAGE_BYTES: usize = 8 * 1024;
const IO_DEADLINE: Duration = Duration::from_secs(2);

pub(crate) struct PipeRequest {
    pub(crate) body: Value,
    pub(crate) reply: mpsc::Sender<Value>,
}

pub(crate) fn start(sink: impl Fn(PipeRequest) + Send + 'static) -> Result<()> {
    std::thread::Builder::new()
        .name("hertz-desktop-pipe".into())
        .spawn(move || loop {
            if let Err(error) = serve_one(&sink) {
                crate::app::log(&format!("control pipe: {error:#}"));
                std::thread::sleep(Duration::from_millis(200));
            }
        })?;
    Ok(())
}

fn serve_one(sink: &impl Fn(PipeRequest)) -> Result<()> {
    let name = pipe_name();
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            MAX_MESSAGE_BYTES as u32,
            MAX_MESSAGE_BYTES as u32,
            2000,
            std::ptr::null(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        anyhow::bail!("CreateNamedPipeW 失败（{}）", unsafe { GetLastError() });
    }
    let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
    if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
        unsafe {
            CloseHandle(handle);
        }
        anyhow::bail!("ConnectNamedPipe 失败（{}）", unsafe { GetLastError() });
    }
    let result = (|| {
        let body = read_message(handle)?;
        let request: Value = serde_json::from_slice(&body)?;
        let (reply, wait) = mpsc::channel();
        sink(PipeRequest {
            body: request,
            reply,
        });
        let response = wait
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|_| serde_json::json!({"ok": false, "error": "timeout"}));
        write_message(handle, &response)
    })();
    unsafe {
        DisconnectNamedPipe(handle);
        CloseHandle(handle);
    }
    result
}

fn read_message(handle: HANDLE) -> Result<Vec<u8>> {
    let deadline = Instant::now() + IO_DEADLINE;
    loop {
        let mut available = 0u32;
        let peeked = unsafe {
            PeekNamedPipe(
                handle,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if peeked == 0 {
            anyhow::bail!("PeekNamedPipe 失败（{}）", unsafe { GetLastError() });
        }
        if available > 0 {
            if available as usize > MAX_MESSAGE_BYTES {
                anyhow::bail!("控制消息超过 {MAX_MESSAGE_BYTES} 字节");
            }
            break;
        }
        if Instant::now() >= deadline {
            anyhow::bail!("读控制消息超时");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut buffer = vec![0u8; MAX_MESSAGE_BYTES];
    let mut read = 0u32;
    let ok = unsafe {
        ReadFile(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            &mut read,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        anyhow::bail!("ReadFile 失败（{}）", unsafe { GetLastError() });
    }
    buffer.truncate(read as usize);
    Ok(buffer)
}

fn write_message(handle: HANDLE, response: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(response)?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        anyhow::bail!("控制回复超过 {MAX_MESSAGE_BYTES} 字节");
    }
    let mut written = 0u32;
    let ok = unsafe {
        WriteFile(
            handle,
            bytes.as_ptr(),
            bytes.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        anyhow::bail!("WriteFile 失败（{}）", unsafe { GetLastError() });
    }
    unsafe { FlushFileBuffers(handle) };
    Ok(())
}

/// 与服务端 `desktop_control` 保持同名、同用户约束。
fn pipe_name() -> Vec<u16> {
    let user = std::env::var("USERNAME").unwrap_or_default();
    let safe: String = user
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .take(32)
        .collect();
    let suffix = if safe.is_empty() { "user" } else { &safe };
    format!("\\\\.\\pipe\\hertz-desktop-control-{suffix}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}
