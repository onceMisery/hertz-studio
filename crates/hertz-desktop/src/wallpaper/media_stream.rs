// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸媒体流响应内核（设计 docs/desktop-wallpaper.md §8.1、反例 C49/C59）。
//!
//! 职责一：把 HTTP Range 请求解析成**确定性的响应计划**（200/206/416/400），
//! 语义按 §8.1 表与 RFC 9110 收紧——多范围/语法错误/整数溢出一律 400，
//! 有效但不可满足 → 416 + `Content-Range: bytes */N`，绝不退回整文件响应。
//! 职责二：有界文件流——单次读取最多 1 MiB、逐块累计实际字节、EOF 只在
//! 真实读到末尾出现（不返回伪 EOF）；并发由 8 槽池约束（§8.1）。
//!
//! WebView2 `WebResourceRequested` 的接线（wallpaper.invalid 保留域、
//! GetDeferral 后台线程、响应组装）属 P1-03 的呈现切片，需要真实 WebView2
//! 环境验证首帧/seek/句柄回收后接入；本模块的全部纯逻辑先被测试锁死。

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// 单流缓冲上限（§8.1：单流缓冲最多 1 MiB；WebView2 自身缓冲另计实测）。
pub const MAX_READ_BYTES: usize = 1024 * 1024;
/// 流总并发（§8.1：流总并发 8）。
pub const MAX_STREAM_SLOTS: usize = 8;

/// Range 请求的解析结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeRequest {
    /// 无 Range / 非 bytes 单位：整文件 200。
    Full,
    /// 可满足的单范围（闭区间，已按 total 裁剪末端）。
    Satisfied { start: u64, end_inclusive: u64 },
    /// 语法有效但不可满足：416 + `bytes */N`。
    Unsatisfiable,
    /// 语法错误/多范围/整数溢出：400（不拼 multipart、不退回整文件）。
    Malformed,
}

/// 解析 `Range` 头（§8.1 表；C49）。
pub fn parse_range_header(header: Option<&str>, total: u64) -> RangeRequest {
    let Some(value) = header else {
        return RangeRequest::Full;
    };
    let Some(spec) = value.strip_prefix("bytes=") else {
        // 非 bytes 单位：按 RFC 忽略（整文件）。
        return RangeRequest::Full;
    };
    if spec.contains(',') {
        // 多范围：明确拒绝（§8.1：不拼 multipart）。
        return RangeRequest::Malformed;
    }
    let Some((start_text, end_text)) = spec.split_once('-') else {
        return RangeRequest::Malformed;
    };
    let parse_bound = |text: &str| -> Option<u64> {
        if text.is_empty() {
            return None;
        }
        // 只接受纯十进制；"+" 前缀/空格/超 u64 溢出一律 Malformed。
        if !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        text.parse::<u64>().ok()
    };
    if start_text.is_empty() {
        // 后缀范围 bytes=-k。
        let Some(suffix) = parse_bound(end_text) else {
            return RangeRequest::Malformed;
        };
        if suffix == 0 {
            return RangeRequest::Unsatisfiable;
        }
        if total == 0 {
            return RangeRequest::Unsatisfiable;
        }
        let start = total.saturating_sub(suffix);
        return RangeRequest::Satisfied {
            start,
            end_inclusive: total - 1,
        };
    }
    let Some(start) = parse_bound(start_text) else {
        return RangeRequest::Malformed;
    };
    let end = match end_text.is_empty() {
        // 开放末端 bytes=a-。
        true => None,
        false => match parse_bound(end_text) {
            Some(end) => Some(end),
            None => return RangeRequest::Malformed,
        },
    };
    if let Some(end) = end {
        if end < start {
            return RangeRequest::Malformed;
        }
    }
    if total == 0 {
        return RangeRequest::Unsatisfiable;
    }
    if start >= total {
        return RangeRequest::Unsatisfiable;
    }
    let end_inclusive = end.map_or(total - 1, |end| end.min(total - 1));
    RangeRequest::Satisfied {
        start,
        end_inclusive,
    }
}

/// 响应计划：状态行与关键头的唯一真值（§8.1 表）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamPlan {
    pub status: u16,
    pub content_length: u64,
    /// `bytes start-end/total` 或 `bytes */total`（416）。
    pub content_range: Option<String>,
    /// HEAD：无响应体且不占流槽。
    pub body: bool,
}

pub fn plan_response(method_head: bool, request: RangeRequest, total: u64) -> StreamPlan {
    // RFC 9110：Range 只作用于 GET；HEAD 描述完整表示且没有响应体。
    if method_head {
        return StreamPlan {
            status: 200,
            content_length: total,
            content_range: None,
            body: false,
        };
    }
    match request {
        RangeRequest::Full => StreamPlan {
            status: 200,
            content_length: total,
            content_range: None,
            body: !method_head,
        },
        RangeRequest::Satisfied {
            start,
            end_inclusive,
        } => StreamPlan {
            status: 206,
            content_length: end_inclusive - start + 1,
            content_range: Some(format!("bytes {start}-{end_inclusive}/{total}")),
            body: !method_head,
        },
        RangeRequest::Unsatisfiable => StreamPlan {
            status: 416,
            content_length: 0,
            content_range: Some(format!("bytes */{total}")),
            body: false,
        },
        RangeRequest::Malformed => StreamPlan {
            status: 400,
            content_length: 0,
            content_range: None,
            body: false,
        },
    }
}

/// 已打开的媒体文件流：独立游标 + 有界读取。
#[derive(Debug)]
pub struct MediaFileStream {
    file: std::fs::File,
    #[allow(dead_code)]
    path: PathBuf,
    total: u64,
    position: u64,
    /// 槽随流对象生命周期持有（§8.1：EOF 不等于对象寿命结束）。
    _slot: StreamSlot,
}

impl MediaFileStream {
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn matches_read_probe_file(&self, path: &Path, bytes: u64) -> bool {
        self.path == path && self.total == bytes
    }

    /// 以只读共享打开；写共享不授予——并发写者在打开阶段即被拒。
    pub fn open(path: &Path, pool: &Arc<StreamSlotPool>) -> Result<Self, StreamError> {
        let _slot = pool.acquire()?;
        use std::os::windows::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x0000_0001)
            .open(path)
            .map_err(|error| StreamError {
                code: "io",
                message: format!("打开媒体文件失败：{error}"),
            })?;
        let total = file
            .metadata()
            .map_err(|error| StreamError {
                code: "io",
                message: format!("读取媒体大小失败：{error}"),
            })?
            .len();
        Ok(Self {
            file,
            path: path.to_path_buf(),
            total,
            position: 0,
            _slot,
        })
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn position(&self) -> u64 {
        self.position
    }

    pub fn seek(&mut self, position: u64) -> Result<(), StreamError> {
        if position > self.total {
            return Err(StreamError {
                code: "seek_out_of_range",
                message: format!(
                    "seek 到 {position} 超出文件长度 {total}",
                    total = self.total
                ),
            });
        }
        self.position = position;
        Ok(())
    }

    /// 定点读取（COM 流窗口用）：不维护自身游标，读多少由调用方的窗口管理。
    pub fn read_at(&mut self, offset: u64, out: &mut [u8]) -> Result<usize, StreamError> {
        if offset >= self.total || out.is_empty() {
            return Ok(0);
        }
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|error| StreamError {
                code: "io",
                message: format!("定位失败：{error}"),
            })?;
        let cap = out.len().min(MAX_READ_BYTES);
        self.file
            .read(&mut out[..cap])
            .map_err(|error| StreamError {
                code: "io",
                message: format!("读取失败：{error}"),
            })
    }

    /// 有界读取：单次最多 1 MiB（§8.1）；EOF 只在真实读到末尾返回 0——
    /// 不返回伪 EOF（§8.1），调用方据此区分「到头」与「暂时无数据」。
    pub fn read_bounded(&mut self, out: &mut [u8]) -> Result<usize, StreamError> {
        let cap = out.len().min(MAX_READ_BYTES);
        if cap == 0 {
            return Ok(0);
        }
        if self.position >= self.total {
            return Ok(0);
        }
        self.file
            .seek(std::io::SeekFrom::Start(self.position))
            .map_err(|error| StreamError {
                code: "io",
                message: format!("定位失败：{error}"),
            })?;
        let read = self
            .file
            .read(&mut out[..cap])
            .map_err(|error| StreamError {
                code: "io",
                message: format!("读取失败：{error}"),
            })?;
        self.position += read as u64;
        Ok(read)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamError {
    pub code: &'static str,
    pub message: String,
}

/// 流槽池：总并发 8（§8.1），达到上限返回可解释的资源忙错误；
/// 在 UI 线程等待信号量或无限排队都不允许——acquire 只做一次原子判定。
#[derive(Debug)]
pub struct StreamSlotPool {
    active: AtomicUsize,
    max: usize,
}

impl StreamSlotPool {
    pub fn new() -> Arc<Self> {
        Self::with_max(MAX_STREAM_SLOTS)
    }

    pub fn with_max(max: usize) -> Arc<Self> {
        Arc::new(Self {
            active: AtomicUsize::new(0),
            max,
        })
    }

    pub fn acquire(self: &Arc<Self>) -> Result<StreamSlot, StreamError> {
        // CAS 抢槽：失败即忙，不等待。
        loop {
            let current = self.active.load(Ordering::Relaxed);
            if current >= self.max {
                return Err(StreamError {
                    code: "stream_busy",
                    message: format!("流并发已达 {max} 上限", max = self.max),
                });
            }
            if self
                .active
                .compare_exchange(current, current + 1, Ordering::Acquire, Ordering::Relaxed)
                .is_ok()
            {
                return Ok(StreamSlot {
                    pool: Arc::clone(self),
                });
            }
        }
    }

    pub fn active(&self) -> usize {
        self.active.load(Ordering::Relaxed)
    }
}

/// 进程级流池：总并发 8（§8.1「流总并发 8」是全桌面组件的总额度）。
pub(crate) fn global_pool() -> &'static Arc<StreamSlotPool> {
    static POOL: std::sync::OnceLock<Arc<StreamSlotPool>> = std::sync::OnceLock::new();
    POOL.get_or_init(StreamSlotPool::new)
}

/// 持有的槽；Drop 归还（真实句柄关闭后才释放额度——§8.1「EOF 不等于对象
/// 寿命结束」，额度生命周期与流对象绑定而非文件偏移）。
#[derive(Debug)]
pub struct StreamSlot {
    pool: Arc<StreamSlotPool>,
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        self.pool.active.fetch_sub(1, Ordering::Release);
    }
}

#[cfg(test)]
#[path = "media_stream_tests.rs"]
mod tests;
