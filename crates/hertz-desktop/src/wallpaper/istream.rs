// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 媒体文件的 COM `IStream` 包装（设计 docs/desktop-wallpaper.md §8.1、C59）。
//!
//! 交给 WebView2 `WebResourceRequested` 响应的流必须：可 seek、有界、EOF 只
//! 在真实读到末尾出现（不返回伪 EOF）、Clone 用独立游标（新句柄 + 对齐位置，
//! 此后互不影响）、对象 agile（IAgileObject——满足「流必须 agile 或在后台
//! 线程创建并正确 marshal」）。`windows` crate 与 webview2-com/wry 锁定同一
//! 0.62，接口互通。
//!
//! 并发额度（8 槽）由创建方 `StreamSlotPool` 约束；每个流实例独立打开文件
//! 句柄（只共享读），Write/SetSize 一律拒绝。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use windows::core::{implement, Result};
use windows::Win32::Foundation::{
    STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION, STG_E_INVALIDPARAMETER,
};
use windows::Win32::System::Com::{
    IAgileObject, IAgileObject_Impl, ISequentialStream_Impl, IStream, IStream_Impl,
    LOCKTYPE, STATFLAG, STATFLAG_NONAME, STATSTG, STGM_READ, STGTY_STREAM,
    STREAM_SEEK, STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET, STGC,
};

use super::media_stream::{MediaFileStream, StreamSlotPool};

/// 单个 COM 流。路径 + 池随对象保存，Clone 据此开独立句柄。
#[implement(IStream, IAgileObject)]
struct MediaIStream {
    stream: Mutex<MediaFileStream>,
    path: PathBuf,
    pool: Arc<StreamSlotPool>,
}

impl MediaIStream {
    /// 打开文件并占用一个流槽；槽由返回的 IStream 生命周期持有。
    pub fn open(
        path: &std::path::Path,
        pool: &Arc<StreamSlotPool>,
    ) -> Result<IStream> {
        let stream = MediaFileStream::open(path, pool).map_err(|error| {
            windows::core::Error::new(
                windows::core::HRESULT(0x8003_0005u32 as i32), // STG_E_ACCESSDENIED 家族
                format!("{}: {}", error.code, error.message),
            )
        })?;
        Ok(Self {
            stream: Mutex::new(stream),
            path: path.to_path_buf(),
            pool: Arc::clone(pool),
        }
        .into())
    }
}

// windows 0.62 的 ISequentialStream_Impl 以 HRESULT 直返（新式 out-param 签名）。
#[allow(non_snake_case)]
impl ISequentialStream_Impl for MediaIStream_Impl {
    fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcb_read: *mut u32) -> windows::core::HRESULT {
        if pv.is_null() || pcb_read.is_null() {
            return STG_E_INVALIDPARAMETER;
        }
        unsafe {
            *pcb_read = 0;
        }
        if cb == 0 {
            return windows::core::HRESULT(0);
        }
        let mut stream = match self.stream.lock() {
            Ok(stream) => stream,
            Err(_) => return STG_E_INVALIDFUNCTION,
        };
        let slice = unsafe { std::slice::from_raw_parts_mut(pv.cast::<u8>(), cb as usize) };
        match stream.read_bounded(slice) {
            Ok(read) => {
                unsafe {
                    *pcb_read = read as u32;
                }
                windows::core::HRESULT(0)
            }
            Err(error) => stream_error(error).into(),
        }
    }

    fn Write(&self, _pv: *const core::ffi::c_void, _cb: u32, _pcb_written: *mut u32) -> windows::core::HRESULT {
        // 只读流：壁纸媒体对呈现侧永不开放写。
        STG_E_ACCESSDENIED
    }
}

// agile 标记接口：无方法。
impl IAgileObject_Impl for MediaIStream_Impl {}

#[allow(non_snake_case)]
impl IStream_Impl for MediaIStream_Impl {
    fn Seek(&self, dlib_move: i64, origin: STREAM_SEEK, new_position: *mut u64) -> Result<()> {
        // plibnewposition 可为 null（COM 合同）：调用方不要回值时不写出。
        let mut stream = self.stream.lock().map_err(lock_poisoned)?;
        let target: i64 = if origin == STREAM_SEEK_SET {
            dlib_move
        } else if origin == STREAM_SEEK_CUR {
            stream.position() as i64 + dlib_move
        } else if origin == STREAM_SEEK_END {
            stream.total() as i64 + dlib_move
        } else {
            return Err(STG_E_INVALIDPARAMETER.into());
        };
        if target < 0 {
            return Err(STG_E_INVALIDPARAMETER.into());
        }
        stream.seek(target as u64).map_err(stream_error)?;
        if !new_position.is_null() {
            unsafe {
                *new_position = target as u64;
            }
        }
        Ok(())
    }

    fn SetSize(&self, _new_size: u64) -> Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }

    fn CopyTo(
        &self,
        _stream: windows::core::Ref<'_, IStream>,
        _cb: u64,
        _bytes_read: *mut u64,
        _bytes_written: *mut u64,
    ) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn Commit(&self, _flags: &STGC) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn Revert(&self) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn LockRegion(&self, _offset: u64, _size: u64, _lock_type: &LOCKTYPE) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn UnlockRegion(&self, _offset: u64, _size: u64, _lock_type: u32) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn Stat(&self, stat: *mut STATSTG, flag: &STATFLAG) -> Result<()> {
        if stat.is_null() {
            return Err(STG_E_INVALIDPARAMETER.into());
        }
        let stream = self.stream.lock().map_err(lock_poisoned)?;
        unsafe {
            *stat = STATSTG {
                // 名称留空：调用方免释放；诊断名由上层日志承载。
                pwcsName: windows::core::PWSTR::null(),
                r#type: STGTY_STREAM.0 as u32,
                cbSize: stream.total(),
                grfMode: STGM_READ,
                ..Default::default()
            };
        }
        if *flag == STATFLAG_NONAME {
            return Ok(());
        }
        Ok(())
    }

    /// 独立游标（§8.1/C59）：新句柄 + 对齐克隆时刻的位置，此后互不影响。
    fn Clone(&self) -> Result<IStream> {
        let position = {
            let stream = self.stream.lock().map_err(lock_poisoned)?;
            stream.position()
        };
        let clone = MediaIStream {
            stream: Mutex::new(
                MediaFileStream::open(&self.path, &self.pool).map_err(stream_error)?,
            ),
            path: self.path.clone(),
            pool: Arc::clone(&self.pool),
        };
        {
            let mut stream = clone.stream.lock().map_err(lock_poisoned)?;
            stream.seek(position).map_err(stream_error)?;
        }
        Ok(clone.into())
    }
}

fn lock_poisoned(_: std::sync::PoisonError<std::sync::MutexGuard<'_, MediaFileStream>>) -> windows::core::Error {
    windows::core::Error::from_hresult(windows::core::HRESULT(0x8003_0001u32 as i32))
}

fn stream_error(error: super::media_stream::StreamError) -> windows::core::Error {
    windows::core::Error::new(
        windows::core::HRESULT(0x8003_0005u32 as i32),
        format!("{}: {}", error.code, error.message),
    )
}

#[cfg(test)]
#[path = "istream_tests.rs"]
mod tests;
