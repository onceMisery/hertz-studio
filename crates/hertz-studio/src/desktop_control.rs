// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 播放器 → 桌面歌词宿主的本机管理通道（客户端）。
//!
//! 只转发有界 JSON 命令，不携带路径、脚本或窗口句柄；管道由宿主持有，
//! 默认安全描述符把访问限制在当前用户，并拒绝远程客户端。

#[cfg(windows)]
mod platform {
    use std::time::{Duration, Instant};

    use anyhow::{bail, Result};
    use serde_json::Value;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, GENERIC_READ,
        GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, ReadFile, WriteFile, FILE_SHARE_NONE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Pipes::{PeekNamedPipe, WaitNamedPipeW};

    const MAX_REQUEST_BYTES: usize = 2 * 1024;
    const MAX_RESPONSE_BYTES: usize = 8 * 1024;
    const IO_DEADLINE: Duration = Duration::from_secs(2);

    pub(crate) fn send(payload: Value) -> Result<Value> {
        let bytes = serde_json::to_vec(&payload)?;
        if bytes.len() > MAX_REQUEST_BYTES {
            bail!("控制请求超过 {MAX_REQUEST_BYTES} 字节");
        }
        let name = pipe_name();
        let handle = connect(&name)?;
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
            let error = unsafe { GetLastError() };
            unsafe { CloseHandle(handle) };
            bail!("写控制消息失败（{error}）");
        }
        unsafe { FlushFileBuffers(handle) };
        let response = read_message(handle);
        unsafe { CloseHandle(handle) };
        let response = response?;
        Ok(serde_json::from_slice(&response)?)
    }

    fn connect(name: &[u16]) -> Result<HANDLE> {
        let mut waited = false;
        loop {
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_NONE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    0,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(handle);
            }
            let error = unsafe { GetLastError() };
            if error == ERROR_FILE_NOT_FOUND {
                bail!("桌面歌词未运行");
            }
            if error == ERROR_PIPE_BUSY && !waited {
                waited = true;
                unsafe { WaitNamedPipeW(name.as_ptr(), 1000) };
                continue;
            }
            bail!("连接桌面歌词控制通道失败（{error}）");
        }
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
                bail!("读取控制回复失败（{}）", unsafe {
                    GetLastError()
                });
            }
            if available > 0 {
                if available as usize > MAX_RESPONSE_BYTES {
                    bail!("控制回复超过 {MAX_RESPONSE_BYTES} 字节");
                }
                break;
            }
            if Instant::now() >= deadline {
                bail!("等待桌面歌词回复超时");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut buffer = vec![0u8; MAX_RESPONSE_BYTES];
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
            bail!("读取控制回复失败（{}）", unsafe {
                GetLastError()
            });
        }
        buffer.truncate(read as usize);
        Ok(buffer)
    }

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
}

#[cfg(windows)]
pub(crate) use platform::send;

#[cfg(not(windows))]
pub(crate) fn send(_payload: serde_json::Value) -> anyhow::Result<serde_json::Value> {
    anyhow::bail!("桌面歌词管理通道仅支持 Windows")
}
