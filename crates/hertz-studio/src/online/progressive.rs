// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

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
use crate::online::cache;
use crate::online::download_client;

/// 预读基础块与封顶：max(256KB, 总长 8%)，封顶 1.5MB。
pub const FLUSH_STEP: u64 = 256 * 1024;
const PREBUFFER_CAP: u64 = 3 * 512 * 1024;
/// 单曲下载硬上限。64MiB 会误杀无损/Hi-Res（整轨 flac 常达数十 MiB），
/// 放宽到 512MiB；超限仍按「内容过大」拒绝，防止异常响应撑爆磁盘。
const MAX_AUDIO_BYTES: u64 = 512 * 1024 * 1024;

/// 开播模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamMode {
    /// 头部已含解复用元数据（mp3/flac/ogg/early-moov m4a）。
    Progressive,
    /// 元数据在文件尾（late-moov m4a），等整首下载完再播。
    WaitFull,
}

/// pub(crate)：state.rs 经 Download::inner / HttpMediaSource::open 跨模块传递
/// Arc<Inner>，类型必须在 crate 内可命名（字段与方法仍保持私有）。
///
/// 锁纪律：下面所有访问点都直接 `.lock().unwrap()`，这是有意的。临界区里只有
/// 赋值、克隆与整数算术，没有任何可能 panic 的操作（不索引、不 unwrap、不格式化），
/// 因此锁不可能中毒——`PoisonError` 在这里等价于「不可能发生」。若为了消除 unwrap
/// 把毒化降级成日志/错误，这些方法得集体换签名（其中几个是 `AudioSource` trait
/// 的实现，签名由 trait 固定），代价远大于收益，还会把真正该修的 panic 掩盖成
/// 「一次下载失败」。release 是 `panic = "abort"`，守住「临界区不 panic」就守住了
/// 这一片的安全性。
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

    /// 单次预读 tick：最多在 Condvar 上等 200ms，醒来重检谓词。
    ///
    /// 返回 `Ok(true)` = 已达预读阈值或已完成；`Ok(false)` = 超时仍未达
    /// （调用方复核代际后再来一轮）；`Err` = 已 abort 或下载出错。与
    /// [`Self::wait_for`] 的无限等待不同，本调用必然在 ~200ms 内返回，
    /// 播放流程因而能在每轮之间插入代际复核，及时中止被切歌顶掉的下载。
    fn poll_prebuffer(&self, abort: &AtomicBool) -> Result<bool, WaitError> {
        let want = prebuffer_target(self.total());
        let mut g = self.downloaded.lock().unwrap();
        if abort.load(Ordering::Relaxed) {
            return Err(WaitError::Aborted);
        }
        if let Some(e) = self.error.lock().unwrap().clone() {
            return Err(WaitError::Failed(e));
        }
        if *g >= want || *self.finished.lock().unwrap() {
            return Ok(true);
        }
        let (ng, _) = self.cv.wait_timeout(g, Duration::from_millis(200)).unwrap();
        g = ng;
        if abort.load(Ordering::Relaxed) {
            return Err(WaitError::Aborted);
        }
        if let Some(e) = self.error.lock().unwrap().clone() {
            return Err(WaitError::Failed(e));
        }
        Ok(*g >= want || *self.finished.lock().unwrap())
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

/// 显式实现（vmusic-core 不再提供 blanket impl）：把 HTTP `Content-Length`
/// 经 `media_len` 透给探测层。无 Xing/VBRI 头的 CBR mp3 只能靠总字节数
/// 估时长，缺了它 duration=None，自然结束判定永不成立、无法连播。
impl vmusic_core::AudioSource for HttpMediaSource {
    fn media_len(&self) -> Option<u64> {
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
    /// 后台下载是否已跑到完成态（注册表惰性清理用，不取 JoinHandle）。
    pub fn is_finished(&self) -> bool {
        self.inner.is_finished()
    }

    /// 廉价克隆一个播放流程用的视图（只复制 Arc/路径，所有权留在注册表）。
    pub fn view(&self) -> DownloadView {
        DownloadView {
            inner: self.inner.clone(),
            abort: self.abort.clone(),
            part_path: self.part_path.clone(),
        }
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

/// [`Download`] 的廉价克隆视图：下载注册表持有 Download 所有权（供切歌时
/// cancel / WaitFull 完成时 join），播放流程只持本视图做可被代际打断的
/// 预读轮询与进度查询。所有字段都是 Arc 共享，视图与原下载看到同一状态。
#[derive(Clone)]
pub struct DownloadView {
    /// 同 Download::inner：私有类型仅在 crate 内经 media_parts 传给
    /// HttpMediaSource::open。
    #[allow(private_interfaces)]
    inner: Arc<Inner>,
    abort: Arc<AtomicBool>,
    part_path: PathBuf,
}

impl DownloadView {
    pub fn part_path(&self) -> &Path {
        &self.part_path
    }

    /// 嗅探出的容器扩展名（预读完成后一定可用）。
    pub fn ext(&self) -> &'static str {
        self.inner.ext()
    }

    pub fn pct(&self) -> Option<u8> {
        self.inner.pct()
    }

    pub fn is_finished(&self) -> bool {
        self.inner.is_finished()
    }

    /// 构造 HttpMediaSource 所需的三件共享状态。
    #[allow(private_interfaces)]
    pub fn media_parts(&self) -> (PathBuf, Arc<Inner>, Arc<AtomicBool>) {
        (
            self.part_path.clone(),
            self.inner.clone(),
            self.abort.clone(),
        )
    }

    /// 单次预读 tick（spawn_blocking 里 Condvar 等待，不卡 async 运行时）：
    /// `Ok(true)` = 已达预读阈值/已完成；`Ok(false)` = 200ms 超时未达，
    /// 调用方复核代际后继续循环；`Err` = abort 或下载错误。
    pub async fn prebuffer_tick(&self) -> Result<bool, String> {
        let inner = self.inner.clone();
        let abort = self.abort.clone();
        tokio::task::spawn_blocking(move || {
            inner.poll_prebuffer(&abort).map_err(|e| match e {
                WaitError::Aborted => "download aborted".to_string(),
                WaitError::Failed(m) => m,
            })
        })
        .await
        .map_err(|e| e.to_string())?
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

/// 启动下载。`key` 不含扩展名（如 `qq-a1-lossless`）；urls = [主 url, fallback...]。
///
/// `index` 是缓存目录的内存索引：rename 落盘成功后要把正式文件登记进去
/// （写时增量维护），否则这次下载的成果在本次进程里查不到，会白下一次。
pub fn start(
    dir: PathBuf,
    key: String,
    urls: Vec<String>,
    referer: Option<String>,
    index: Arc<cache::CacheIndex>,
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
            crate::diaglog!(
                "download.start",
                key = key2,
                urls_total = urls.len(),
                first_url = crate::diag::redact_url(urls.first().map(String::as_str).unwrap_or("")),
                referer = referer.is_some()
            );
            for (i, url) in urls.iter().enumerate() {
                if abort.load(Ordering::Relaxed) {
                    crate::diaglog!(
                        "download.cancel",
                        key = key2,
                        url_index = i,
                        written = written
                    );
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
                        crate::diaglog!(
                            "download.retry",
                            key = key2,
                            url_index = i,
                            url = crate::diag::redact_url(url),
                            reason = e.to_string()
                        );
                        continue;
                    }
                };
                let status = resp.status();
                if status == reqwest::StatusCode::OK && written > 0 {
                    // 服务器无视 Range：从头重下。
                    crate::diaglog!(
                        "download.range_ignored",
                        key = key2,
                        url_index = i,
                        url = crate::diag::redact_url(url),
                        restart_from = written
                    );
                    written = 0;
                    head.clear();
                    inner.reset();
                } else if status != reqwest::StatusCode::OK
                    && status != reqwest::StatusCode::PARTIAL_CONTENT
                {
                    tracing::debug!("下载返回 {status}，尝试下一地址");
                    crate::diaglog!(
                        "download.retry",
                        key = key2,
                        url_index = i,
                        url = crate::diag::redact_url(url),
                        reason = format!("HTTP {status}")
                    );
                    continue;
                }
                if written == 0 {
                    let total = resp.content_length();
                    if let Some(t) = total {
                        if t > MAX_AUDIO_BYTES {
                            inner.fail("内容过大".into());
                            crate::diaglog!(
                                "download.reject",
                                key = key2,
                                url_index = i,
                                total_bytes = t,
                                reason = "内容过大"
                            );
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
                            crate::diaglog!(
                                "download.broke",
                                key = key2,
                                url_index = i,
                                url = crate::diag::redact_url(url),
                                written = written,
                                reason = e.to_string()
                            );
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
                    crate::diaglog!(
                        "download.fail",
                        key = key2,
                        url_index = i,
                        written = written,
                        reason = msg
                    );
                    let _ = std::fs::remove_file(&part_path);
                    return Err(msg);
                }
                // 截断响应（连接提前断开但没触发续传、或末个 URL 给了短体）
                // 绝不允许 rename 成正式缓存：否则 find_cached_by_key 会永久
                // 命中这个坏文件，之后每次播放都解码失败。Content-Length 已知
                // 才校验；chunked（total=None）没有可比对的总长，跳过。
                if let Some(t) = inner.total() {
                    if written != t {
                        let msg = "下载不完整".to_string();
                        inner.fail(msg.clone());
                        crate::diaglog!(
                            "download.fail",
                            key = key2,
                            url_index = i,
                            written = written,
                            total_bytes = t,
                            reason = msg
                        );
                        let _ = std::fs::remove_file(&part_path);
                        return Err(msg);
                    }
                }
                // 完成：按嗅探扩展名落正式名。Windows 终文件已存在则复用。
                let final_path = dir2.join(format!("{}.{}", key2, inner.ext()));
                match tokio::fs::rename(&part_path, &final_path).await {
                    Ok(()) => {}
                    Err(_) => {
                        let ok = matches!(tokio::fs::metadata(&final_path).await, Ok(m) if m.len() > 1024);
                        let _ = tokio::fs::remove_file(&part_path).await;
                        if !ok {
                            crate::diaglog!(
                                "download.fail",
                                key = key2,
                                url_index = i,
                                written = written,
                                reason = "落盘缓存失败"
                            );
                            return Err("落盘缓存失败".to_string());
                        }
                    }
                }
                crate::diaglog!(
                    "download.done",
                    key = key2,
                    url_index = i,
                    written = written,
                    file = final_path.file_name().unwrap_or_default().to_string_lossy()
                );
                index.note_written(&final_path).await;
                inner.finish();
                return Ok(final_path);
            }
            let msg = "所有试听地址均失败".to_string();
            inner.fail(msg.clone());
            crate::diaglog!(
                "download.fail",
                key = key2,
                urls_total = urls.len(),
                reason = msg
            );
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

    /// 落盘后必须自动进缓存索引——这是「写时增量维护」的端到端证据：少了它，
    /// 本次进程里刚下完的曲子在查找时看不见，会被判定为未缓存而重复下载。
    #[tokio::test]
    async fn finished_download_is_registered_in_the_cache_index() {
        // 本地 HTTP 服务：一段 >1024 字节的假 mp3（ID3 头让 sniff_ext 认成 mp3）。
        let payload = {
            let mut v = b"ID3\x03\x00\x00\x00\x00\x00\x00".to_vec();
            v.resize(4096, 0x55);
            v
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/audio",
            axum::routing::get(move || {
                let body = payload.clone();
                async move { body }
            }),
        );
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let dir = std::env::temp_dir().join(format!("vmusic-dl-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let index = Arc::new(cache::CacheIndex::load(dir.clone()).await);
        let dl = start(
            dir.clone(),
            "qq-a1-standard".into(),
            vec![format!("http://{addr}/audio")],
            None,
            index.clone(),
        )
        .unwrap();
        let path = dl.join().await.unwrap();

        assert!(path.exists(), "下载完成后正式缓存文件应在");
        assert_eq!(
            index.find("qq", "a1", "standard").await.as_deref(),
            Some(path.as_path()),
            "刚落盘的文件必须已被索引登记"
        );
        assert_eq!(index.stats().files, 1);
        let _ = tokio::fs::remove_dir_all(&dir).await;
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
