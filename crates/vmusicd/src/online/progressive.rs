// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 渐进式下载：后台 tokio 任务顺序把远程音频写入 `.part`；同步解码线程经
//! [`HttpMediaSource`] 读到哪等到哪。下载完成原子 rename 成正式缓存。
//!
//! 桥接边界：下载是 async（reqwest 流），解码是 OS 线程上的同步 Read。
//! 两者只通过 Inner 的 Condvar + 已下载字节数通信，互不持有对方运行时。

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use futures::StreamExt;
use tokio::task::JoinHandle;

use crate::error::ApiError;
use crate::online::download_client;

/// 预读基础块与封顶：max(256KB, 总长 8%)，封顶 1.5MB。
pub const FLUSH_STEP: u64 = 256 * 1024;
const PREBUFFER_CAP: u64 = 3 * 512 * 1024;
const MAX_AUDIO_BYTES: u64 = 64 * 1024 * 1024;

/// 开播模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamMode {
    /// 头部已含解复用元数据（mp3/flac/ogg/early-moov m4a）。
    Progressive,
    /// 元数据在文件尾（late-moov m4a），等整首下载完再播。
    WaitFull,
}

// pub(crate)：state.rs 经 Download::inner / HttpMediaSource::open 跨模块传递
// Arc<Inner>，类型必须在 crate 内可命名（字段与方法仍保持私有）。
pub(crate) struct Inner {
    downloaded: Mutex<u64>,
    cv: Condvar,
    total: Mutex<Option<u64>>,
    finished: Mutex<bool>,
    error: Mutex<Option<String>>,
    /// 首块嗅探出的容器扩展名；下载完成时据此命名正式缓存。
    ext: Mutex<&'static str>,
}

impl Inner {
    fn new() -> Self {
        Self {
            downloaded: Mutex::new(0),
            cv: Condvar::new(),
            total: Mutex::new(None),
            finished: Mutex::new(false),
            error: Mutex::new(None),
            ext: Mutex::new("mp3"),
        }
    }

    fn ext(&self) -> &'static str {
        *self.ext.lock().unwrap()
    }
    fn set_ext(&self, ext: &'static str) {
        *self.ext.lock().unwrap() = ext;
    }

    fn total(&self) -> Option<u64> {
        *self.total.lock().unwrap()
    }
    fn set_total(&self, t: Option<u64>) {
        *self.total.lock().unwrap() = t;
        self.cv.notify_all();
    }
    fn advance(&self, n: u64) {
        *self.downloaded.lock().unwrap() += n;
        self.cv.notify_all();
    }
    fn reset(&self) {
        *self.downloaded.lock().unwrap() = 0;
        *self.finished.lock().unwrap() = false;
        self.cv.notify_all();
    }
    fn finish(&self) {
        *self.finished.lock().unwrap() = true;
        self.cv.notify_all();
    }
    fn is_finished(&self) -> bool {
        *self.finished.lock().unwrap()
    }
    fn fail(&self, msg: String) {
        *self.error.lock().unwrap() = Some(msg);
        self.cv.notify_all();
    }
    fn pct(&self) -> Option<u8> {
        let t = self.total()?;
        if t == 0 {
            return None;
        }
        Some(((*self.downloaded.lock().unwrap() as u128 * 100 / t as u128) as u8).min(99))
    }

    /// 阻塞等待已下载达到 want；250ms 醒一次响应 abort；提前完成/出错也返回。
    fn wait_for(&self, want: u64, abort: &AtomicBool) -> Result<u64, WaitError> {
        let mut g = self.downloaded.lock().unwrap();
        loop {
            if abort.load(Ordering::Relaxed) {
                return Err(WaitError::Aborted);
            }
            if let Some(e) = self.error.lock().unwrap().clone() {
                return Err(WaitError::Failed(e));
            }
            if *g >= want || *self.finished.lock().unwrap() {
                return Ok(*g);
            }
            let (ng, _) = self.cv.wait_timeout(g, Duration::from_millis(250)).unwrap();
            g = ng;
        }
    }
}

#[derive(Debug)]
pub enum WaitError {
    Aborted,
    Failed(String),
}

/// 解码线程读的同步源。
pub struct HttpMediaSource {
    file: File,
    pos: u64,
    inner: Arc<Inner>,
    abort: Arc<AtomicBool>,
}

impl HttpMediaSource {
    // Inner 刻意保持模块私有，仅在 crate 内经本入口传入。
    #[allow(private_interfaces)]
    pub fn open(part: &Path, inner: Arc<Inner>, abort: Arc<AtomicBool>) -> io::Result<Self> {
        Ok(Self {
            file: OpenOptions::new().read(true).open(part)?,
            pos: 0,
            inner,
            abort,
        })
    }
}

impl Read for HttpMediaSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let available = self
            .inner
            .wait_for(self.pos + 1, &self.abort)
            .map_err(|e| match e {
                WaitError::Aborted => {
                    io::Error::new(io::ErrorKind::Interrupted, "download aborted")
                }
                WaitError::Failed(m) => io::Error::new(io::ErrorKind::BrokenPipe, m),
            })?;
        let readable = available.saturating_sub(self.pos) as usize;
        if readable == 0 {
            return Ok(0); // 干净 EOF
        }
        self.file.seek(SeekFrom::Start(self.pos))?;
        let take = readable.min(buf.len());
        let n = self.file.read(&mut buf[..take])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpMediaSource {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let target = match pos {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::Current(n) => self.pos as i64 + n,
            SeekFrom::End(n) => {
                // 相对尾定位需要整首（late-moov 走 WaitFull，正常不到这）。
                let t = self
                    .inner
                    .total()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "length unknown"))?;
                self.inner
                    .wait_for(t, &self.abort)
                    .map_err(|_| io::Error::new(io::ErrorKind::Interrupted, "aborted"))?;
                t as i64 + n
            }
        };
        if target < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "negative seek"));
        }
        let target = target as u64;
        self.inner
            .wait_for(target, &self.abort)
            .map_err(|_| io::Error::new(io::ErrorKind::Interrupted, "download aborted"))?;
        self.pos = target;
        Ok(target)
    }
}

impl symphonia::core::io::MediaSource for HttpMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        self.inner.total()
    }
}

/// 一次进行中的下载。缓存键不含扩展名（扩展名首块才知道）。
pub struct Download {
    /// Inner 刻意保持模块私有，仅在 crate 内经本字段传给 HttpMediaSource。
    #[allow(private_interfaces)]
    pub inner: Arc<Inner>,
    pub abort: Arc<AtomicBool>,
    pub part_path: PathBuf,
    task: JoinHandle<Result<PathBuf, String>>,
}

impl Download {
    /// 嗅探出的容器扩展名（预读完成后一定可用）。
    pub fn ext(&self) -> &'static str {
        self.inner.ext()
    }

    /// 后台下载是否已跑到完成态（WaitFull 轮询用，不取 JoinHandle）。
    pub fn is_finished(&self) -> bool {
        self.inner.is_finished()
    }
}

// 保留计划代码「先保下限再封顶」的显式写法，语义与 clamp 等价。
#[allow(clippy::manual_clamp)]
pub fn prebuffer_target(total: Option<u64>) -> u64 {
    match total {
        Some(t) => ((t * 8 / 100).max(FLUSH_STEP)).min(PREBUFFER_CAP),
        None => FLUSH_STEP,
    }
}

impl Download {
    pub fn pct(&self) -> Option<u8> {
        self.inner.pct()
    }

    /// 等预读阈值（spawn_blocking 里阻塞，不卡 async 运行时）。
    pub async fn wait_prebuffer(&self) -> Result<u64, String> {
        let inner = self.inner.clone();
        let abort = self.abort.clone();
        let need = prebuffer_target(inner.total());
        tokio::task::spawn_blocking(move || {
            inner.wait_for(need, &abort).map_err(|e| match e {
                WaitError::Aborted => "download aborted".to_string(),
                WaitError::Failed(m) => m,
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn join(self) -> Result<PathBuf, String> {
        self.task.await.map_err(|e| e.to_string())?
    }

    /// 中止并删除 .part。
    pub fn cancel(&self) {
        self.abort.store(true, Ordering::Relaxed);
        self.task.abort();
        let _ = std::fs::remove_file(&self.part_path);
    }
}

/// 启动下载。`key` 不含扩展名（如 `qq-a1-lossless`）；urls = [主 url, fallback...]。
pub fn start(
    dir: PathBuf,
    key: String,
    urls: Vec<String>,
    referer: Option<String>,
) -> Result<Download, ApiError> {
    let part_path = dir.join(format!(".{key}.part"));
    let _ = std::fs::remove_file(&part_path);
    std::fs::create_dir_all(&dir)
        .map_err(|e| ApiError::internal(format!("创建缓存目录失败: {e}")))?;
    std::fs::File::create(&part_path)
        .map_err(|e| ApiError::internal(format!("创建缓存文件失败: {e}")))?;

    let inner = Arc::new(Inner::new());
    let abort = Arc::new(AtomicBool::new(false));
    let client = download_client()?;

    let task = tokio::task::spawn({
        let inner = inner.clone();
        let abort = abort.clone();
        let dir2 = dir.clone();
        let key2 = key.clone();
        // 任务持有 .part 路径的副本；原件随 Download 返回给调用方（cancel 用）。
        let part_path = part_path.clone();
        async move {
            let mut written: u64 = 0;
            // 累计前 32 字节用于容器嗅探。
            let mut head: Vec<u8> = Vec::with_capacity(32);
            for url in &urls {
                if abort.load(Ordering::Relaxed) {
                    let _ = std::fs::remove_file(&part_path);
                    return Err("download aborted".to_string());
                }
                let mut req = client.get(url);
                if written > 0 {
                    req = req.header(reqwest::header::RANGE, format!("bytes={written}-"));
                }
                if let Some(rf) = &referer {
                    req = req.header(reqwest::header::REFERER, rf);
                }
                let resp = match req.send().await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::debug!("下载连接失败，尝试下一地址: {e}");
                        continue;
                    }
                };
                let status = resp.status();
                if status == reqwest::StatusCode::OK && written > 0 {
                    // 服务器无视 Range：从头重下。
                    written = 0;
                    head.clear();
                    inner.reset();
                } else if status != reqwest::StatusCode::OK
                    && status != reqwest::StatusCode::PARTIAL_CONTENT
                {
                    tracing::debug!("下载返回 {status}，尝试下一地址");
                    continue;
                }
                if written == 0 {
                    let total = resp.content_length();
                    if let Some(t) = total {
                        if t > MAX_AUDIO_BYTES {
                            inner.fail("内容过大".into());
                            let _ = std::fs::remove_file(&part_path);
                            return Err("内容过大".to_string());
                        }
                    }
                    inner.set_total(total);
                }

                // 阻塞写在专用下载任务里，8-64KB 的 write 不构成运行时压力。
                let mut file = OpenOptions::new()
                    .write(true)
                    .open(&part_path)
                    .map_err(|e| e.to_string())?;
                file.seek(SeekFrom::Start(written))
                    .map_err(|e| e.to_string())?;
                let mut stream = resp.bytes_stream();
                let mut broke = false;
                while let Some(chunk) = stream.next().await {
                    if abort.load(Ordering::Relaxed) {
                        drop(file);
                        let _ = std::fs::remove_file(&part_path);
                        return Err("download aborted".to_string());
                    }
                    match chunk {
                        Ok(bytes) => {
                            if written + bytes.len() as u64 > MAX_AUDIO_BYTES {
                                inner.fail("内容过大".into());
                                let _ = std::fs::remove_file(&part_path);
                                return Err("内容过大".to_string());
                            }
                            if head.len() < 32 {
                                let take = 32 - head.len();
                                head.extend_from_slice(&bytes[..bytes.len().min(take)]);
                                if let Some(ext) = sniff_ext(&head) {
                                    inner.set_ext(ext);
                                }
                            }
                            file.write_all(&bytes).map_err(|e| {
                                inner.fail(e.to_string());
                                e.to_string()
                            })?;
                            written += bytes.len() as u64;
                            inner.advance(bytes.len() as u64);
                        }
                        Err(e) => {
                            tracing::debug!("下载中断，尝试续传: {e}");
                            broke = true;
                            break;
                        }
                    }
                }
                drop(file);
                if broke {
                    continue; // 下一个 URL 带 Range 续传
                }
                if written <= 1024 {
                    let msg = "内容过小，可能已被版权限制".to_string();
                    inner.fail(msg.clone());
                    let _ = std::fs::remove_file(&part_path);
                    return Err(msg);
                }
                // 完成：按嗅探扩展名落正式名。Windows 终文件已存在则复用。
                let final_path = dir2.join(format!("{}.{}", key2, inner.ext()));
                match tokio::fs::rename(&part_path, &final_path).await {
                    Ok(()) => {}
                    Err(_) => {
                        let ok = matches!(tokio::fs::metadata(&final_path).await, Ok(m) if m.len() > 1024);
                        let _ = tokio::fs::remove_file(&part_path).await;
                        if !ok {
                            return Err("落盘缓存失败".to_string());
                        }
                    }
                }
                inner.finish();
                return Ok(final_path);
            }
            let msg = "所有试听地址均失败".to_string();
            inner.fail(msg.clone());
            let _ = std::fs::remove_file(&part_path);
            Err(msg)
        }
    });

    Ok(Download {
        inner,
        abort,
        part_path,
        task,
    })
}

// ---------------------------------------------------------------------------
// 容器探测
// ---------------------------------------------------------------------------

/// 嗅探真实容器扩展名；认不出返回 None（调用方按 WaitFull 保守处理）。
pub fn sniff_ext(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"fLaC") {
        Some("flac")
    } else if head.starts_with(b"OggS") {
        Some("ogg")
    } else if head.starts_with(b"ID3")
        || (head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0)
    {
        Some("mp3")
    } else if head.len() > 11 && &head[4..8] == b"ftyp" {
        Some("m4a")
    } else {
        None
    }
}

/// 在 ISO BMFF 顶层 box 序列里找 moov。
pub fn mp4_has_moov(buf: &[u8]) -> bool {
    let mut i = 0usize;
    while i + 8 <= buf.len() {
        let size = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        if size < 8 {
            return false;
        }
        if &buf[i + 4..i + 8] == b"moov" {
            return true;
        }
        // size==1 是 64 位 largesize，头部场景遇不到；遇不到就停。
        if size == 1 {
            return false;
        }
        i += size;
    }
    false
}

/// 预读后判定开播模式。
pub fn plan_mode(head: &[u8]) -> (StreamMode, &'static str) {
    match sniff_ext(head) {
        Some("m4a") => {
            if mp4_has_moov(head) {
                (StreamMode::Progressive, "m4a")
            } else {
                (StreamMode::WaitFull, "m4a")
            }
        }
        Some(ext) => (StreamMode::Progressive, ext),
        None => (StreamMode::WaitFull, "mp3"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prebuffer_math() {
        assert_eq!(prebuffer_target(None), FLUSH_STEP);
        // 40MB 的 8% = 3.2MB → 被 1.5MB 封顶。
        assert_eq!(prebuffer_target(Some(40_000_000)), PREBUFFER_CAP);
        // 1MB 的 8% = 80KB → 取 256KB 下限。
        assert_eq!(prebuffer_target(Some(1_000_000)), FLUSH_STEP);
    }

    #[test]
    fn sniff_containers() {
        assert_eq!(sniff_ext(b"fLaC...."), Some("flac"));
        assert_eq!(sniff_ext(b"OggS...."), Some("ogg"));
        assert_eq!(sniff_ext(b"ID3\x03...."), Some("mp3"));
        assert_eq!(sniff_ext(&[0xFF, 0xFB, 0x90]), Some("mp3"));
        let mut mp4 = vec![0u8; 64];
        mp4[4..8].copy_from_slice(b"ftyp");
        assert_eq!(sniff_ext(&mp4), Some("m4a"));
        assert_eq!(sniff_ext(b"xxxx"), None);
    }

    #[test]
    fn moov_detection() {
        // ftyp(32) + free(16) + moov(40)
        let mut buf = vec![0u8; 88];
        buf[4..8].copy_from_slice(b"ftyp");
        buf[0..4].copy_from_slice(&32u32.to_be_bytes());
        buf[32..36].copy_from_slice(&16u32.to_be_bytes());
        buf[36..40].copy_from_slice(b"free");
        buf[48..52].copy_from_slice(&40u32.to_be_bytes());
        buf[52..56].copy_from_slice(b"moov");
        assert!(mp4_has_moov(&buf));
        assert_eq!(plan_mode(&buf).0, StreamMode::Progressive);

        // moov 不在前缀里 → WaitFull。
        let mut late = vec![0u8; 88];
        late[4..8].copy_from_slice(b"ftyp");
        late[0..4].copy_from_slice(&88u32.to_be_bytes());
        assert_eq!(plan_mode(&late).0, StreamMode::WaitFull);
    }

    #[test]
    fn media_source_blocks_until_bytes_arrive() {
        let dir = std::env::temp_dir().join(format!("vmusic-prog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("x.part");
        std::fs::write(&part, b"").unwrap();
        let inner = Arc::new(Inner::new());
        inner.set_total(Some(20));
        let abort = Arc::new(AtomicBool::new(false));

        let writer_part = part.clone();
        let w_inner = inner.clone();
        let h = std::thread::spawn(move || {
            use std::io::Write;
            std::thread::sleep(Duration::from_millis(40));
            let mut f = OpenOptions::new().append(true).open(&writer_part).unwrap();
            f.write_all(&[1u8; 10]).unwrap();
            f.flush().unwrap();
            w_inner.advance(10);
            std::thread::sleep(Duration::from_millis(40));
            f.write_all(&[2u8; 10]).unwrap();
            f.flush().unwrap();
            w_inner.advance(10);
            w_inner.finish();
        });

        let mut src = HttpMediaSource::open(&part, inner, abort).unwrap();
        let mut out = [0u8; 20];
        src.read_exact(&mut out).unwrap();
        assert_eq!(&out[..10], &[1u8; 10]);
        assert_eq!(&out[10..], &[2u8; 10]);
        h.join().unwrap();
    }

    #[test]
    fn media_source_aborts_fast() {
        let dir = std::env::temp_dir().join(format!("vmusic-prog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("y.part");
        std::fs::write(&part, b"").unwrap();
        let inner = Arc::new(Inner::new());
        inner.set_total(Some(100));
        let abort = Arc::new(AtomicBool::new(false));
        let abort2 = abort.clone();
        std::thread::spawn(move || std::thread::sleep(Duration::from_millis(50)))
            .join()
            .unwrap();
        abort2.store(true, Ordering::Relaxed);
        let mut src = HttpMediaSource::open(&part, inner, abort).unwrap();
        let mut out = [0u8; 10];
        assert!(src.read(&mut out).is_err());
    }
}
