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

/// 单个 COM 流。body 是文件的窗口：200 → 全文件（base=0）；206 → 从 range
/// start 起的连续片段——流位置 0 即 body 首字节（浏览器按 body 语义消费）。
/// Clone 据此开独立句柄并对齐位置（§8.1：独立游标）。
///
/// 游标（position）必须可写：`#[implement]` 生成的 `_Impl` 只实现 `Deref`，
/// 裸字段改不动。所以它和文件流一起放进同一把锁里——同一个流本来就该
/// 串行使用（COM 侧也要求调用方自行同步），锁的粒度与文件句柄一致。
#[implement(IStream, IAgileObject)]
pub(crate) struct MediaIStream {
    stream: Mutex<MediaFileStream>,
    path: PathBuf,
    pool: Arc<StreamSlotPool>,
    base: u64,
    len: u64,
    position: Mutex<u64>,
}

impl MediaIStream {
    /// 打开文件窗口并占用一个流槽；槽由返回的 IStream 生命周期持有。
    /// `window = (base, len)`：200 传 (0, total)，206 传 (start, body 长度)。
    pub fn open(
        path: &std::path::Path,
        pool: &Arc<StreamSlotPool>,
        window: (u64, u64),
    ) -> Result<IStream> {
        let stream = MediaFileStream::open(path, pool).map_err(stream_error)?;
        Ok(Self {
            stream: Mutex::new(stream),
            path: path.to_path_buf(),
            pool: Arc::clone(pool),
            base: window.0,
            len: window.1,
            position: Mutex::new(0),
        }
        .into())
    }

    /// 读当前游标。锁中毒按 0 处理：游标只影响"从哪继续读"，
    /// 拿不到确切值时从头读比整流失败更安全。
    fn position(&self) -> u64 {
        *self.position.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 推进游标并返回推进后的值。
    fn advance(&self, delta: u64) -> u64 {
        let mut position = self.position.lock().unwrap_or_else(|e| e.into_inner());
        *position += delta;
        *position
    }

    /// 定位到指定位置（窗口内的偏移）。
    fn set_position(&self, position: u64) {
        *self.position.lock().unwrap_or_else(|e| e.into_inner()) = position;
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
            Err(error) => return lock_poisoned(error).into(),
        };
        let position = self.position();
        let remaining = self.len.saturating_sub(position) as usize;
        let want = (cb as usize).min(remaining);
        if want == 0 {
            return windows::core::HRESULT(0);
        }
        let slice = unsafe { std::slice::from_raw_parts_mut(pv.cast::<u8>(), want) };
        match stream.read_at(self.base + position, slice) {
            Ok(read) => {
                self.advance(read as u64);
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
        let position = self.position();
        let target: i64 = if origin == STREAM_SEEK_SET {
            dlib_move
        } else if origin == STREAM_SEEK_CUR {
            position as i64 + dlib_move
        } else if origin == STREAM_SEEK_END {
            self.len as i64 + dlib_move
        } else {
            return Err(STG_E_INVALIDPARAMETER.into());
        };
        if target < 0 || target > self.len as i64 {
            return Err(STG_E_INVALIDPARAMETER.into());
        }
        self.set_position(target as u64);
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
        unsafe {
            *stat = STATSTG {
                // 名称留空：调用方免释放；诊断名由上层日志承载。
                pwcsName: windows::core::PWSTR::null(),
                r#type: STGTY_STREAM.0 as u32,
                cbSize: self.len,
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
        let clone = MediaIStream {
            stream: Mutex::new(
                MediaFileStream::open(&self.path, &self.pool).map_err(stream_error)?,
            ),
            path: self.path.clone(),
            pool: Arc::clone(&self.pool),
            base: self.base,
            len: self.len,
            position: Mutex::new(self.position()),
        };
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
