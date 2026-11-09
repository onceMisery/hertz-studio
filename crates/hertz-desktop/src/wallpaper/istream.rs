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
use std::sync::{Arc, Mutex, OnceLock, Weak};

use windows::core::{implement, Result};
use windows::Win32::Foundation::{
    STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION, STG_E_INVALIDPARAMETER, STG_E_READFAULT, S_FALSE,
    S_OK,
};
use windows::Win32::System::Com::{
    IAgileObject, IAgileObject_Impl, ISequentialStream_Impl, IStream, IStream_Impl, LOCKTYPE,
    STATFLAG, STATFLAG_NONAME, STATSTG, STGC, STGM_READ, STGTY_STREAM, STREAM_SEEK,
    STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET,
};

use super::access::ReadPermit;
use super::media_stream::{MediaFileStream, StreamSlotPool};

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[path = "istream_read_probe.rs"]
pub(crate) mod read_probe;

/// 单个 COM 流。body 是文件的窗口：200 → 全文件（base=0）；206 → 从 range
/// start 起的连续片段——流位置 0 即 body 首字节（浏览器按 body 语义消费）。
/// Clone 据此开独立句柄并对齐位置（§8.1：独立游标）。
///
/// 游标（position）必须可写：`#[implement]` 生成的 `_Impl` 只实现 `Deref`，
/// 裸字段改不动。所以它和文件流一起放进同一把锁里——同一个流本来就该
/// 串行使用（COM 侧也要求调用方自行同步），锁的粒度与文件句柄一致。
#[implement(IStream, IAgileObject)]
pub(crate) struct MediaIStream {
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    debug_read: Option<read_probe::StreamBinding>,
    stream: Arc<Mutex<StreamState>>,
    path: PathBuf,
    pool: Arc<StreamSlotPool>,
    base: u64,
    len: u64,
}

struct StreamState {
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    debug_read: Option<read_probe::StreamBinding>,
    file: Option<MediaFileStream>,
    payload: Option<Arc<[u8]>>,
    payload_slot: Option<super::media_stream::StreamSlot>,
    position: u64,
    permit: Option<ReadPermit>,
}

impl StreamState {
    fn check_access(&mut self) -> Result<()> {
        if self
            .permit
            .as_ref()
            .is_some_and(|permit| !permit.is_active())
        {
            // 此锁也包围 Read；真实读取退出后才关闭句柄、归还流槽。
            self.file.take();
            self.payload.take();
            self.payload_slot.take();
            // 浏览器可继续持有 COM 外壳；它不能继续持有 staging pin 或活动计数。
            self.permit.take();
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            if let Some(binding) = &self.debug_read {
                binding.gate.reclaimed(binding.stream_id);
            }
            return Err(STG_E_ACCESSDENIED.into());
        }
        if self.file.is_none() && self.payload.is_none() {
            return Err(STG_E_ACCESSDENIED.into());
        }
        Ok(())
    }
}

type StreamRegistry = Mutex<Vec<Weak<Mutex<StreamState>>>>;

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
impl Drop for StreamState {
    fn drop(&mut self) {
        self.file.take();
        self.payload.take();
        self.payload_slot.take();
        self.permit.take();
        if let Some(binding) = &self.debug_read {
            binding.gate.reclaimed(binding.stream_id);
        }
    }
}

fn registry() -> &'static StreamRegistry {
    static REGISTRY: OnceLock<StreamRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

/// 只在后台媒体 worker 调用。撤销本身只置原子旗标，不阻塞 UI 等待磁盘 Read。
/// 即便浏览器保留 COM 引用且不再 Read，也有界回收已撤销流的文件与槽。
pub(crate) fn reap_revoked_streams() {
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .retain(|weak| {
            let Some(stream) = weak.upgrade() else {
                return false;
            };
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            let mut stream = match stream.try_lock() {
                Ok(stream) => stream,
                Err(std::sync::TryLockError::WouldBlock) => return true,
                Err(std::sync::TryLockError::Poisoned(error)) => {
                    let stream = error.into_inner();
                    if let Some(binding) = &stream.debug_read {
                        binding
                            .gate
                            .release(read_probe::ReleaseReason::InternalFailure);
                    }
                    stream
                }
            };
            #[cfg(not(all(feature = "wallpaper-media-probe", debug_assertions)))]
            let mut stream = stream.lock().unwrap_or_else(|error| error.into_inner());
            stream.check_access().is_ok()
        });
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
        Self::from_file(stream, path.to_path_buf(), pool, window)
    }

    pub(crate) fn from_file(
        stream: MediaFileStream,
        path: PathBuf,
        pool: &Arc<StreamSlotPool>,
        window: (u64, u64),
    ) -> Result<IStream> {
        Self::from_file_with_permit(stream, path, pool, window, None)
    }

    pub(crate) fn from_file_with_permit(
        stream: MediaFileStream,
        path: PathBuf,
        pool: &Arc<StreamSlotPool>,
        window: (u64, u64),
        permit: Option<ReadPermit>,
    ) -> Result<IStream> {
        Self::from_file_bound(
            stream,
            path,
            pool,
            window,
            permit,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            None,
        )
    }

    fn from_file_bound(
        stream: MediaFileStream,
        path: PathBuf,
        pool: &Arc<StreamSlotPool>,
        window: (u64, u64),
        permit: Option<ReadPermit>,
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))] parent_stream_id: Option<
            u64,
        >,
    ) -> Result<IStream> {
        if window
            .0
            .checked_add(window.1)
            .is_none_or(|end| end > stream.total())
        {
            return Err(STG_E_INVALIDPARAMETER.into());
        }
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        let debug_read = permit
            .as_ref()
            .filter(|permit| {
                permit.pinned().is_some_and(|pin| {
                    pin.path == path && stream.matches_read_probe_file(&pin.path, pin.entry.bytes)
                })
            })
            .and_then(|permit| permit.stream_binding_for_test(window, parent_stream_id));
        let stream = Arc::new(Mutex::new(StreamState {
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            debug_read: debug_read.clone(),
            file: Some(stream),
            payload: None,
            payload_slot: None,
            position: 0,
            permit,
        }));
        stream.lock().map_err(lock_poisoned)?.check_access()?;
        {
            let mut registry = registry().lock().unwrap_or_else(|error| error.into_inner());
            registry.retain(|entry| entry.strong_count() > 0);
            registry.push(Arc::downgrade(&stream));
        }
        Ok(Self {
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            debug_read,
            stream,
            path,
            pool: Arc::clone(pool),
            base: window.0,
            len: window.1,
        }
        .into())
    }

    /// Native IR bytes share the existing read-only agile stream and eight-slot
    /// pool. Clone shares immutable bytes and acquires its own cursor/permit.
    pub(crate) fn from_payload(
        payload: Arc<[u8]>,
        permit: ReadPermit,
        pool: &Arc<StreamSlotPool>,
    ) -> Result<IStream> {
        let len = payload.len() as u64;
        let stream = Arc::new(Mutex::new(StreamState {
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            debug_read: None,
            file: None,
            payload: Some(payload),
            payload_slot: Some(pool.acquire().map_err(stream_error)?),
            position: 0,
            permit: Some(permit),
        }));
        stream.lock().map_err(lock_poisoned)?.check_access()?;
        let mut registry = registry().lock().unwrap_or_else(|error| error.into_inner());
        registry.retain(|entry| entry.strong_count() > 0);
        registry.push(Arc::downgrade(&stream));
        drop(registry);
        Ok(Self {
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            debug_read: None,
            stream,
            path: PathBuf::new(),
            pool: Arc::clone(pool),
            base: 0,
            len,
        }
        .into())
    }

    fn lock_stream(&self) -> Result<std::sync::MutexGuard<'_, StreamState>> {
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if let Some(binding) = self
            .debug_read
            .as_ref()
            .filter(|binding| binding.gate.on_ui_thread())
        {
            return match self.stream.try_lock() {
                Ok(stream) => Ok(stream),
                Err(std::sync::TryLockError::WouldBlock) => {
                    binding.gate.ui_concurrent_call();
                    Err(windows::Win32::Foundation::STG_E_INUSE.into())
                }
                Err(std::sync::TryLockError::Poisoned(error)) => {
                    binding
                        .gate
                        .release(read_probe::ReleaseReason::InternalFailure);
                    Err(lock_poisoned(error))
                }
            };
        }
        self.stream.lock().map_err(|error| {
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            if let Some(binding) = &self.debug_read {
                binding
                    .gate
                    .release(read_probe::ReleaseReason::InternalFailure);
            }
            lock_poisoned(error)
        })
    }
}

// windows 0.62 的 ISequentialStream_Impl 以 HRESULT 直返（新式 out-param 签名）。
#[allow(non_snake_case)]
impl ISequentialStream_Impl for MediaIStream_Impl {
    fn Read(
        &self,
        pv: *mut core::ffi::c_void,
        cb: u32,
        pcb_read: *mut u32,
    ) -> windows::core::HRESULT {
        if pv.is_null() && cb != 0 {
            return STG_E_INVALIDPARAMETER;
        }
        if !pcb_read.is_null() {
            unsafe {
                *pcb_read = 0;
            }
        }
        if cb == 0 {
            return windows::core::HRESULT(0);
        }
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        let mut read_exit = None;
        let mut stream = match self.lock_stream() {
            Ok(stream) => stream,
            Err(error) => return error.code(),
        };
        let result = (|| {
            if let Err(error) = stream.check_access() {
                return error.code();
            }
            let remaining = self.len.saturating_sub(stream.position);
            let want = u64::from(cb).min(remaining) as usize;
            let slice = unsafe { std::slice::from_raw_parts_mut(pv.cast::<u8>(), want) };
            let mut read = 0;
            // IStream::Read 不能把内部 1 MiB 分块误报为 EOF；直接填调用方缓冲，
            // 每次磁盘读取仍有界，无额外大分配。
            while read < want {
                if let Err(error) = stream.check_access() {
                    return error.code();
                }
                let offset = self.base + stream.position;
                if let Some(payload) = &stream.payload {
                    let count = want - read;
                    slice[read..]
                        .copy_from_slice(&payload[offset as usize..offset as usize + count]);
                    stream.position += count as u64;
                    read += count;
                    if !pcb_read.is_null() {
                        unsafe {
                            *pcb_read = read as u32;
                        }
                    }
                    continue;
                }
                match stream
                    .file
                    .as_mut()
                    .expect("active stream file")
                    .read_at(offset, &mut slice[read..])
                {
                    Ok(0) => return STG_E_READFAULT,
                    Ok(count) => {
                        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                        if let Some(binding) = &stream.debug_read {
                            let exact = stream.payload.is_none()
                                && stream.permit.as_ref().is_some_and(|permit| {
                                    permit.matches_read_gate(&binding.gate)
                                        && permit.pinned().is_some_and(|pin| {
                                            stream.file.as_ref().is_some_and(|file| {
                                                file.matches_read_probe_file(
                                                    &pin.path,
                                                    pin.entry.bytes,
                                                )
                                            })
                                        })
                                });
                            if binding.gate.claim_and_wait(
                                binding,
                                offset,
                                cb,
                                count,
                                exact,
                                &mut read_exit,
                            ) && stream
                                .permit
                                .as_ref()
                                .is_none_or(|permit| !permit.is_active())
                            {
                                // Keep original file/slot/permit until Read leaves this lock;
                                // only the original reaper may complete the Drain afterwards.
                                return STG_E_ACCESSDENIED;
                            }
                        }
                        stream.position += count as u64;
                        read += count;
                        if !pcb_read.is_null() {
                            unsafe {
                                *pcb_read = read as u32;
                            }
                        }
                    }
                    Err(error) => return stream_error(error).into(),
                }
            }
            if read < cb as usize {
                S_FALSE
            } else {
                S_OK
            }
        })();
        drop(stream);
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if let Some(exit) = &mut read_exit {
            exit.1 = Some(result.0);
        }
        result
    }

    fn Write(
        &self,
        _pv: *const core::ffi::c_void,
        _cb: u32,
        _pcb_written: *mut u32,
    ) -> windows::core::HRESULT {
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
        let mut stream = self.lock_stream()?;
        stream.check_access()?;
        let position = stream.position;
        let target: i128 = if origin == STREAM_SEEK_SET {
            i128::from(dlib_move)
        } else if origin == STREAM_SEEK_CUR {
            i128::from(position) + i128::from(dlib_move)
        } else if origin == STREAM_SEEK_END {
            i128::from(self.len) + i128::from(dlib_move)
        } else {
            return Err(STG_E_INVALIDPARAMETER.into());
        };
        if target < 0 || target > i128::from(self.len) {
            return Err(STG_E_INVALIDPARAMETER.into());
        }
        stream.position = target as u64;
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
        let (position, permit, payload) = {
            let mut stream = self.lock_stream()?;
            stream.check_access()?;
            (
                stream.position,
                stream.permit.clone(),
                stream.payload.clone(),
            )
        };
        let clone = if let Some(payload) = payload {
            MediaIStream::from_payload(payload, permit.ok_or(STG_E_ACCESSDENIED)?, &self.pool)?
        } else {
            let file = MediaFileStream::open(&self.path, &self.pool).map_err(stream_error)?;
            MediaIStream::from_file_bound(
                file,
                self.path.clone(),
                &self.pool,
                (self.base, self.len),
                permit,
                #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                self.debug_read.as_ref().map(|binding| binding.stream_id),
            )?
        };
        unsafe {
            clone.Seek(position as i64, STREAM_SEEK_SET, None)?;
        }
        Ok(clone)
    }
}

fn lock_poisoned(
    _: std::sync::PoisonError<std::sync::MutexGuard<'_, StreamState>>,
) -> windows::core::Error {
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
pub(super) mod tests;
