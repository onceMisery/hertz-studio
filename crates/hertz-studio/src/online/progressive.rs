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
use crate::online::ladder::Candidate;
use crate::online::quality::{self, Quality};

/// 预读基础块与封顶：max(256KB, 总长 8%)，封顶 1.5MB。
pub const FLUSH_STEP: u64 = 256 * 1024;
const PREBUFFER_CAP: u64 = 3 * 512 * 1024;
/// 单曲下载硬上限。64MiB 会误杀无损/Hi-Res（整轨 flac 常达数十 MiB），
/// 放宽到 512MiB；超限仍按「内容过大」拒绝，防止异常响应撑爆磁盘。
const MAX_AUDIO_BYTES: u64 = 512 * 1024 * 1024;
/// 同一格（同一地址）最多要几次，含第一次。
///
/// 断链的绝大多数形态是「这一条连接上的这份字节断了」（CDN 抖动、代理掐断、
/// 网易那些 20 分钟过期的直链在慢链路上被切），它们都能靠 Range 回同一个地址
/// 接着要救回来。用尽这三次才向下降级到下一格。
const RUNG_ATTEMPTS: u32 = 3;

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
    /// **实际开始交付字节的那一档**的标称码率（bps）。阶梯降级后它与主地址
    /// 的码率不同，而档位标注必须跟着真正下载的那一档走。
    bitrate: Mutex<Option<u64>>,
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
            bitrate: Mutex::new(None),
        }
    }

    fn ext(&self) -> &'static str {
        *self.ext.lock().unwrap()
    }
    fn set_ext(&self, ext: &'static str) {
        *self.ext.lock().unwrap() = ext;
    }

    /// 记下当前正在交付的档位（候选自己的标称码率，可能为 None=上游没说）。
    fn set_bitrate(&self, bps: Option<u64>) {
        *self.bitrate.lock().unwrap() = bps;
    }
    fn bitrate(&self) -> Option<u64> {
        *self.bitrate.lock().unwrap()
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
        *self.bitrate.lock().unwrap() = None;
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
            // 位置正好等于已交付长度才是文件尾。位置**越过**它只有一种解释：底层
            // 字节流被换成了一份更短的（换格时 `Inner` 记的是新格自己的长度），
            // 这个偏移往后永远等不到字节。这种「读不到」绝不能报成自然播完——
            // 上面会把它当成这一首播完了去跳下一曲，还会顺手把半首计入播放量。
            if self.pos > available {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "字节流已更换，读取位置越过了交付长度",
                ));
            }
            return Ok(0); // 干净 EOF
        }
        self.file.seek(SeekFrom::Start(self.pos))?;
        let take = readable.min(buf.len());
        let n = self.file.read(&mut buf[..take])?;
        if n == 0 {
            // `readable` 说这里还有字节，句柄却读出了文件尾：本句柄指向的文件比
            // 承诺的短（换格时旧 `.part` 被删除重建，这个打开的句柄还挂在旧那份上，
            // Windows 允许它读完残留内容）。报 EOF 等于谎称「这首播完了」，得报错。
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "缓存文件比已交付长度短",
            ));
        }
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

    /// 实际在交付字节的那一档对应的档位标注。
    ///
    /// 阶梯降级时它和请求档位不同——这才是「这一曲我到底播的是几 kbps」的
    /// 依据。还没有候选被接受时为 None（调用方自己决定要不要回落到请求值）。
    pub fn actual_quality(&self) -> Option<Quality> {
        quality::from_bitrate(self.inner.bitrate())
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

/// 键里带的档位是**请求**档位，而阶梯降级后实际交付的可能是更矮的一档。
/// 按实测字节反推档位换掉后缀：`cache_key` 的档位后缀同时就是缓存查找用的
/// 前缀键（见 [`cache::CacheIndex::find`]），不改名等于把一个 320k 的文件
/// 挂在无损名下，之后每次「无损」播放都命中它。
///
/// 时长未知、或键根本不带合法档位后缀时原样返回——宁可少标注，不猜。
/// 曲目 id 里含 `-` 也不影响：档位后缀恒在最后一段。
fn relabel_key(key: &str, duration_ms: Option<u64>, written: u64) -> String {
    let Some(d) = duration_ms.filter(|d| *d > 0) else {
        return key.to_string();
    };
    let Some((stem, suffix)) = key.rsplit_once('-') else {
        return key.to_string();
    };
    let Some(requested) = Quality::parse(suffix) else {
        return key.to_string();
    };
    match quality::from_bitrate(Some(written * 8 * 1000 / d)) {
        Some(measured) if measured != requested => format!("{stem}-{}", measured.as_str()),
        _ => key.to_string(),
    }
}

/// 判定「这条候选不行，换下一条」——本宏只做换条之前的清理，跳转由调用方紧跟着
/// 写 `continue 'rungs;`：宏体内的 `continue` 受标签卫生限制够不到函数里的
/// `'rungs`（它只看得见宏体自己声明的标签），写进宏里就编译不过。
///
/// 必须把 `written` 归零：下一个候选是从 0 开始的**另一条流**，带着旧偏移去
/// Range 续传会把两条流拼进同一个缓存文件（同一格自己的断续传不走这里，那是
/// 同一条流的延续）。偏移归零后 `Inner::reset` 让解码线程回到等待态，
/// `.part` 删掉由下一格重建。
macro_rules! reject_candidate {
    ($inner:expr, $part_path:expr, $written:expr, $head:expr) => {{
        $written = 0;
        $head.clear();
        $inner.reset();
        let _ = std::fs::remove_file($part_path);
    }};
}

/// 启动下载。`key` 不含扩展名（如 `qq-a1-lossless`）；`ladder` 是按音质
/// 从高到低排好的候选，**第一个就是主地址**（由 [`StreamInfo::ladder`] 给出）。
///
/// 每个候选自带 Referer：跨 CDN 域名时不能共用一条（音质档位本身也各自
/// 记在候选上，见 [`crate::online::ladder::Candidate`]）。
///
/// 候选按序尝试：传输层失败与内容级不合格（过大/过小/不完整/认不出容器）
/// 都是**换下一个候选**，全部用尽才算这次取流失败。
///
/// 续传只发生在**同一格内部**：[`RUNG_ATTEMPTS`] 次打的都是同一个地址，Range
/// 接着上次要到的地方继续要，断链因而不会惊动正在等的解码线程。一个候选的
/// `written` 是它自己那份字节的偏移，拿到下一格去就是两份内容的拼接，所以
/// 换格一律把偏移与嗅探头归零、`.part` 删掉从头重下。
///
/// `index` 是缓存目录的内存索引：rename 落盘成功后要把正式文件登记进去
/// （写时增量维护），否则这次下载的成果在本次进程里查不到，会白下一次。
/// `duration_ms` 是曲目的标称时长（来自平台搜索结果），只用来做两件事：
/// 校验候选是否真的交付了它所声称的码率、以及按实测反推落盘档位。缺时长
/// 时两者都跳过——绝不把「不知道」当 0。
pub fn start(
    source: &str,
    dir: PathBuf,
    key: String,
    ladder: Vec<Candidate>,
    duration_ms: Option<u64>,
    index: Arc<cache::CacheIndex>,
) -> Result<Download, ApiError> {
    let client = download_client(source, &ladder)?;
    let part_path = dir.join(format!(".{key}.part"));
    let _ = std::fs::remove_file(&part_path);
    std::fs::create_dir_all(&dir)
        .map_err(|e| ApiError::internal(format!("创建缓存目录失败: {e}")))?;
    std::fs::File::create(&part_path)
        .map_err(|e| ApiError::internal(format!("创建缓存文件失败: {e}")))?;

    let inner = Arc::new(Inner::new());
    let abort = Arc::new(AtomicBool::new(false));

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
                urls_total = ladder.len(),
                first_url =
                    crate::diag::redact_url(ladder.first().map(|c| c.url.as_str()).unwrap_or("")),
                referer = ladder.iter().any(|c| c.referer.is_some())
            );
            'rungs: for (i, cand) in ladder.iter().enumerate() {
                let url = cand.url.as_str();
                // 换格 = 换一份字节：上一格攒下的偏移对新格毫无意义。带着旧偏移去
                // Range 新格，要么把两条不同的流拼进同一个缓存文件（那是投毒缓存，
                // 之后每次播放都解不开），要么让正在读的解码器在新格更短的总长上撞到
                // 「假的文件尾」——表现就是这一首播到一半被当成播完，接着跳下一曲。
                // 只有同一格自己的续传才保留偏移（见下面 attempt 那一层）。
                if written > 0 {
                    crate::diaglog!(
                        "download.rung_restart",
                        key = key2,
                        url_index = i,
                        dropped_bytes = written
                    );
                    written = 0;
                    head.clear();
                    inner.reset();
                    let _ = std::fs::remove_file(&part_path);
                }
                for attempt in 1..=RUNG_ATTEMPTS {
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
                    if let Some(rf) = cand.referer {
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
                            continue 'rungs;
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
                        continue 'rungs;
                    }
                    // 错误页最常见的形状是 200 + text/html（限流页、登录跳转、网关
                    // 报错都这样）。不挡的话它会被改名成 {key}.mp3 永久落缓存，之后
                    // 每次播放都解码失败——这是投毒缓存，不是重试能救的。
                    if resp
                        .headers()
                        .get(reqwest::header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|ct| ct.starts_with("text/"))
                    {
                        tracing::debug!("候选返回文本内容，尝试下一地址");
                        crate::diaglog!(
                            "download.reject",
                            key = key2,
                            url_index = i,
                            url = crate::diag::redact_url(url),
                            reason = "content-type 是文本"
                        );
                        reject_candidate!(inner, &part_path, written, head);
                        continue 'rungs;
                    }
                    if written == 0 {
                        // 谁从 0 开始交付字节，这一份内容的档位就是它。降级换候选时
                        // 必须重记，否则「实际档位」还按主地址报。
                        inner.set_bitrate(cand.bitrate);
                        let total = resp.content_length();
                        if let Some(t) = total {
                            if t > MAX_AUDIO_BYTES {
                                crate::diaglog!(
                                    "download.reject",
                                    key = key2,
                                    url_index = i,
                                    total_bytes = t,
                                    reason = "内容过大"
                                );
                                reject_candidate!(inner, &part_path, written, head);
                                continue 'rungs;
                            }
                        }
                        inner.set_total(total);
                    }

                    // 阻塞写在专用下载任务里，8-64KB 的 write 不构成运行时压力。
                    // create 是必需的：内容被拒时 .part 已删掉，下一轮要能重建。
                    // 反过来 truncate 必须显式关掉——断连续传时要保留已写的头一段，
                    // 从 `written` 处覆盖写。
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(false)
                        .open(&part_path)
                        .map_err(|e| e.to_string())?;
                    file.seek(SeekFrom::Start(written))
                        .map_err(|e| e.to_string())?;
                    let mut stream = resp.bytes_stream();
                    let mut broke = false;
                    // 流中途超出硬上限：标记后先跳出内层循环，统一走候选拒绝
                    // （这里的 `continue` 只能跳出 while，换候选得靠循环外的拒绝）。
                    let mut oversize = false;
                    while let Some(chunk) = stream.next().await {
                        if abort.load(Ordering::Relaxed) {
                            drop(file);
                            let _ = std::fs::remove_file(&part_path);
                            return Err("download aborted".to_string());
                        }
                        match chunk {
                            Ok(bytes) => {
                                if written + bytes.len() as u64 > MAX_AUDIO_BYTES {
                                    oversize = true;
                                    break;
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
                        // 断的是这一格自己的连接、这一份字节：拿 Range 回同一个地址接着
                        // 要。偏移没归零、错误位没置，正在等字节的解码线程只是多等一轮
                        // poll —— 续上之后这一首照样能播完，这才是「边下边播」该有的样子。
                        if attempt < RUNG_ATTEMPTS {
                            crate::diaglog!(
                                "download.resume",
                                key = key2,
                                url_index = i,
                                attempt = attempt,
                                from_byte = written
                            );
                            continue;
                        }
                        // 三次都没能把这份字节要完：这一格放弃，向下降级。下一格的开头
                        // 会把偏移归零——那是另一份字节，旧偏移对它没有任何意义。
                        continue 'rungs;
                    }
                    if oversize {
                        crate::diaglog!(
                            "download.reject",
                            key = key2,
                            url_index = i,
                            written = written,
                            reason = "内容过大"
                        );
                        reject_candidate!(inner, &part_path, written, head);
                        continue 'rungs;
                    }
                    // 下面三条判的都是「这条候选不合格」而不是「取流失败」：还有候选就
                    // 换，全部用尽才在循环外 fail。理由只记 diaglog —— inner.fail 是
                    // 终态信号，wait_for / poll_prebuffer 一读到就把还在等字节的解码线程
                    // 判死，非终态调用它会让后来成功的下载带着残留错误。
                    if written <= 1024 {
                        crate::diaglog!(
                            "download.reject",
                            key = key2,
                            url_index = i,
                            written = written,
                            reason = "内容过小，可能已被版权限制"
                        );
                        reject_candidate!(inner, &part_path, written, head);
                        continue 'rungs;
                    }
                    // 截断响应（连接提前断开但没触发续传、或末个 URL 给了短体）
                    // 绝不允许 rename 成正式缓存：否则 find_cached_by_key 会永久
                    // 命中这个坏文件，之后每次播放都解码失败。Content-Length 已知
                    // 才校验；chunked（total=None）没有可比对的总长，跳过。
                    if let Some(t) = inner.total() {
                        if written != t {
                            crate::diaglog!(
                                "download.reject",
                                key = key2,
                                url_index = i,
                                written = written,
                                total_bytes = t,
                                reason = "下载不完整"
                            );
                            reject_candidate!(inner, &part_path, written, head);
                            continue 'rungs;
                        }
                    }
                    // 落盘名必须有容器证据。Inner 的 ext 默认值恒为 "mp3"，嗅探失败时
                    // 它仍是这个默认值——照它命名等于把一条来历不明的响应伪装成 mp3
                    // 永久缓存；plan_mode 的 WaitFull 兜底只在解码侧保守，救不了缓存命中。
                    let Some(ext) = sniff_ext(&head) else {
                        crate::diaglog!(
                            "download.reject",
                            key = key2,
                            url_index = i,
                            written = written,
                            reason = "认不出容器"
                        );
                        reject_candidate!(inner, &part_path, written, head);
                        continue 'rungs;
                    };
                    // 码率诚实闸门：这一档声称的码率得由实际交付的字节撑起 80%
                    // （0.8 是给 VBR 与容器开销留的余量）。谎称无损、实给 128k 的
                    // 直链在这里就被换掉，而不是落进缓存从此被当无损反复命中。
                    // 时长与档位任一未知都不参与——未知绝不按 0 处理。
                    if let (Some(d), Some(bps)) = (duration_ms.filter(|d| *d > 0), cand.bitrate) {
                        // 平均 bps×10 与声明 bps×8（=80%）比较；两边同乘 d 消去除法。
                        if written * 80_000 < bps * d * 8 {
                            crate::diaglog!(
                                "download.reject",
                                key = key2,
                                url_index = i,
                                written = written,
                                declared_bps = bps,
                                duration_ms = d,
                                reason = "交付字节撑不起声明的码率"
                            );
                            reject_candidate!(inner, &part_path, written, head);
                            continue 'rungs;
                        }
                    }
                    // 完成：按嗅探扩展名落正式名。Windows 终文件已存在则复用。
                    let final_path = dir2.join(format!(
                        "{}.{}",
                        relabel_key(&key2, duration_ms, written),
                        ext
                    ));
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
            }
            let msg = "所有试听地址均失败".to_string();
            inner.fail(msg.clone());
            crate::diaglog!(
                "download.fail",
                key = key2,
                urls_total = ladder.len(),
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
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        Some("wav")
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

    #[tokio::test]
    async fn podcast_download_rejects_private_enclosures_before_fetching() {
        let addr = spawn_routes(&[("/audio", "audio/mpeg", mp3_bytes(4096))]).await;
        let dir = tmp_cache_dir().await;
        let index = Arc::new(cache::CacheIndex::load(dir.clone()).await);
        match start(
            "podcast",
            dir.clone(),
            "podcast-fixture-standard".into(),
            rungs(&[format!("http://{addr}/audio")]),
            None,
            index,
        ) {
            Ok(download) => assert!(
                download.join().await.is_err(),
                "a public RSS must not fetch a private audio address"
            ),
            Err(error) => assert_eq!(error.status, 400),
        }
        let _ = std::fs::remove_dir_all(dir);
    }

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
        let mut wav = vec![0u8; 64];
        wav[0..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        assert_eq!(sniff_ext(&wav), Some("wav"));
        assert_eq!(sniff_ext(b"xxxx"), None);
    }

    /// 测试用阶梯：只有地址，档位码率与容器交给默认（未知）值。
    fn rungs(urls: &[String]) -> Vec<Candidate> {
        urls.iter().cloned().map(Candidate::bare).collect()
    }

    /// 假 mp3 载荷：ID3 头让 `sniff_ext` 认成 mp3，长度过 1024 下限。
    fn mp3_bytes(len: usize) -> Vec<u8> {
        let mut v = b"ID3\x03\x00\x00\x00\x00\x00\x00".to_vec();
        v.resize(len.max(9), 0x55);
        v
    }

    /// 起一个本地服务，把每条路径变成候选阶梯上的一格。
    ///
    /// 状态码一律 200：要构造的是「响应看着合法、内容其实不是音频」这类
    /// 内容级不合格，非 2xx 早在状态分支被换掉了，测不到这里的判定。
    async fn spawn_routes(
        routes: &[(&'static str, &'static str, Vec<u8>)],
    ) -> std::net::SocketAddr {
        let mut app = axum::Router::new();
        for (path, content_type, body) in routes {
            let body = body.clone();
            let content_type: &'static str = content_type;
            app = app.route(
                path,
                axum::routing::get(move || {
                    let body = body.clone();
                    async move { ([(axum::http::header::CONTENT_TYPE, content_type)], body) }
                }),
            );
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        addr
    }

    async fn tmp_cache_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vmusic-ladder-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        dir
    }

    /// 一条路径每次命中要怎么应答。
    ///
    /// `Truncate(n)` = 先交付 n 字节、再让 body 流报错（不给 Content-Length，
    /// 走 chunked 分帧，中断才能原样冒到客户端的 `bytes_stream()` 上）——CDN 抖动
    /// 与代理掐线的真实形状。客户端因而拿到 Err，正是下载器区分「断链」与
    /// 「内容不合格」的那条线。
    #[derive(Clone, Copy)]
    enum Serve {
        Full,
        Truncate(usize),
    }

    /// 命中日志：每次请求的 (路径, Range 头)——测试靠它断言「谁被问过、要的是哪一段」。
    type Hits = Arc<std::sync::Mutex<Vec<(String, Option<String>)>>>;

    /// 带脚本的候选服务器：每条路径是一格候选，脚本按命中次数逐条播（用尽后重复
    /// 最后一条），并认 Range。
    async fn spawn_scripted(
        routes: Vec<(&'static str, Vec<u8>, Vec<Serve>)>,
    ) -> (std::net::SocketAddr, Hits) {
        let hits: Hits = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut app = axum::Router::new();
        for (path, body, script) in routes {
            let hits = hits.clone();
            let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            app = app.route(
                path,
                axum::routing::get(move |headers: axum::http::HeaderMap| {
                    let hits = hits.clone();
                    let counter = counter.clone();
                    let body = body.clone();
                    let script = script.clone();
                    async move {
                        let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let range = headers
                            .get(axum::http::header::RANGE)
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string());
                        hits.lock().unwrap().push((path.to_string(), range.clone()));
                        let start = range
                            .as_deref()
                            .and_then(|r| r.strip_prefix("bytes="))
                            .and_then(|r| r.split('-').next())
                            .and_then(|s| s.parse::<usize>().ok())
                            .unwrap_or(0)
                            .min(body.len());
                        let status = if start > 0 {
                            axum::http::StatusCode::PARTIAL_CONTENT
                        } else {
                            axum::http::StatusCode::OK
                        };
                        let serve = *script.last().unwrap_or(&Serve::Full);
                        let serve = script.get(n).copied().unwrap_or(serve);
                        let builder = axum::response::Response::builder()
                            .status(status)
                            .header(axum::http::header::CONTENT_TYPE, "audio/mpeg");
                        let response = match serve {
                            Serve::Full => {
                                let tail: Vec<u8> = body[start..].to_vec();
                                builder.body(axum::body::Body::from(tail)).unwrap()
                            }
                            // 不写 Content-Length：hyper 因此走 chunked，流里的
                            // Err 才能原样冒到客户端的 `bytes_stream()` 上。
                            Serve::Truncate(k) => {
                                let end = start + k.min(body.len() - start);
                                let part = axum::body::Bytes::from(body[start..end].to_vec());
                                // 每段之间留一拍：响应头必须先回到客户端，之后的
                                // 中断才是「流到一半断了」，而不是整个请求失败。
                                let stream = futures::stream::iter(vec![
                                    Ok::<_, std::io::Error>(part),
                                    Err(std::io::Error::other("scripted break")),
                                ])
                                .then(|item| async move {
                                    tokio::time::sleep(Duration::from_millis(60)).await;
                                    item
                                });
                                builder.body(axum::body::Body::from_stream(stream)).unwrap()
                            }
                        };
                        response
                    }
                }),
            );
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (addr, hits)
    }

    /// 一格断链后必须在**同一个地址**上 Range 续传，而不是降级到下一格：这是
    /// 「边下边播的一首歌会不会被网络抖动腰斩」的分界线。
    #[tokio::test]
    async fn a_mid_stream_break_resumes_the_same_address() {
        let full = mp3_bytes(40_000);
        let other = {
            let mut v = b"RIFF\x00\x00\x00\x00WAVEfmt ".to_vec();
            v.resize(40_000, 0x22);
            v
        };
        let (addr, hits) = spawn_scripted(vec![
            (
                "/a",
                full.clone(),
                vec![Serve::Truncate(20_000), Serve::Full],
            ),
            ("/b", other, vec![Serve::Full]),
        ])
        .await;
        let dir = tmp_cache_dir().await;
        let index = Arc::new(cache::CacheIndex::load(dir.clone()).await);
        let dl = start(
            "netease",
            dir.clone(),
            "netease-11-exhigh".into(),
            rungs(&[format!("http://{addr}/a"), format!("http://{addr}/b")]),
            None,
            index.clone(),
        )
        .unwrap();
        let path = dl.join().await.unwrap();

        assert_eq!(
            tokio::fs::read(&path).await.unwrap(),
            full,
            "续传补完的必须是第一格自己那份完整字节"
        );
        let log = hits.lock().unwrap().clone();
        assert_eq!(
            log.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(),
            vec!["/a", "/a"],
            "同一格续传成功就不该降级：{log:?}"
        );
        assert_eq!(
            log[1].1.as_deref(),
            Some("bytes=20000-"),
            "第二次要的是断点之后的那一段"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// 降级到下一格时必须从 0 重下：上一格攒下的偏移属于**另一份字节**，拿去
    /// Range 新格会得到「旧格头部 + 新格尾部」的拼接文件。它闻起来是新格声明的
    /// 容器、总长又恰好对得上，于是会被当正式缓存永久落盘——之后每次播放都解不开。
    #[tokio::test]
    async fn a_downgrade_never_resumes_the_previous_rungs_offset() {
        let first = mp3_bytes(40_000);
        let second = {
            let mut v = b"RIFF\x00\x00\x00\x00WAVEfmt ".to_vec();
            v.resize(40_000, 0x22);
            v
        };
        // 第一格每次都掐在半途（三次用尽），第二格认 Range——旧实现正是被这里
        // 的 206 骗出拼接文件的。
        let (addr, hits) = spawn_scripted(vec![
            (
                "/a",
                first,
                vec![Serve::Truncate(20_000), Serve::Truncate(20_000)],
            ),
            ("/b", second.clone(), vec![Serve::Full]),
        ])
        .await;
        let dir = tmp_cache_dir().await;
        let index = Arc::new(cache::CacheIndex::load(dir.clone()).await);
        let dl = start(
            "netease",
            dir.clone(),
            "netease-12-hires".into(),
            rungs(&[format!("http://{addr}/a"), format!("http://{addr}/b")]),
            None,
            index.clone(),
        )
        .unwrap();
        let path = dl.join().await.unwrap();

        let log = hits.lock().unwrap().clone();
        let b = log
            .iter()
            .find(|(p, _)| p == "/b")
            .expect("降级要问到第二格");
        assert_eq!(b.1, None, "换格不许带上一格的偏移：{log:?}");
        assert_eq!(
            tokio::fs::read(&path).await.unwrap(),
            second,
            "落盘的必须完整是第二格那份字节，不能混进上一格的头部"
        );
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("wav"));
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// 200 + text/html 且长度自洽的错误页（限流页/登录跳转的真实形状）绝不能再
    /// 被改名成 `{key}.mp3`：那会永久投毒缓存，之后每次播放都解码失败。
    #[tokio::test]
    async fn text_body_is_rejected_and_the_next_candidate_wins() {
        let html = b"<html>429 Too Many Requests</html>".to_vec();
        let good = mp3_bytes(4096);
        let addr = spawn_routes(&[
            ("/bad", "text/html; charset=utf-8", html),
            ("/good", "audio/mpeg", good.clone()),
        ])
        .await;
        let dir = tmp_cache_dir().await;
        let index = Arc::new(cache::CacheIndex::load(dir.clone()).await);
        let dl = start(
            "netease",
            dir.clone(),
            "netease-1-standard".into(),
            rungs(&[format!("http://{addr}/bad"), format!("http://{addr}/good")]),
            None,
            index.clone(),
        )
        .unwrap();
        let path = dl.join().await.unwrap();

        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("mp3"));
        assert_eq!(tokio::fs::metadata(&path).await.unwrap().len(), 4096);
        assert_eq!(
            index.find("netease", "1", "standard").await.as_deref(),
            Some(path.as_path())
        );
        // 目录里只该留下这一个正式文件：拒绝路径必须清掉 .part。
        let mut left = Vec::new();
        let mut it = tokio::fs::read_dir(&dir).await.unwrap();
        while let Ok(Some(e)) = it.next_entry().await {
            left.push(e.file_name().to_string_lossy().into_owned());
        }
        assert_eq!(left, vec!["netease-1-standard.mp3".to_string()]);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// 版权限制常见的短响应（小于 1024 下限）不该掐死整条阶梯，且换到的候选
    /// 从 0 重新落：最终文件长度必须等于获胜候选自己的长度，不能把上一条的
    /// 字节接进来。
    #[tokio::test]
    async fn undersized_stub_restarts_the_offset_for_the_next_candidate() {
        let addr = spawn_routes(&[
            ("/stub", "audio/mpeg", mp3_bytes(512)),
            ("/good", "audio/mpeg", mp3_bytes(4096)),
        ])
        .await;
        let dir = tmp_cache_dir().await;
        let index = Arc::new(cache::CacheIndex::load(dir.clone()).await);
        let dl = start(
            "netease",
            dir.clone(),
            "netease-2-standard".into(),
            rungs(&[format!("http://{addr}/stub"), format!("http://{addr}/good")]),
            None,
            index.clone(),
        )
        .unwrap();
        let path = dl.join().await.unwrap();
        assert_eq!(tokio::fs::metadata(&path).await.unwrap().len(), 4096);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// 认不出容器就不许落盘：`Inner::ext` 的默认值恒为 mp3，照它命名等于给一条
    /// 来历不明的响应盖上 mp3 的皮。嗅探到 RIFF/WAVE 的候选则要按真实容器命名。
    #[tokio::test]
    async fn unknown_container_is_never_renamed_to_the_default_mp3() {
        let mut wav = b"RIFF\x00\x00\x00\x00WAVEfmt ".to_vec();
        wav.resize(4096, 0x11);
        let addr = spawn_routes(&[
            // Content-Type 说是 mp3，正文却是没有魔数的裸数据。
            ("/junk", "audio/mpeg", vec![0x55u8; 4096]),
            ("/wav", "audio/mpeg", wav),
        ])
        .await;
        let dir = tmp_cache_dir().await;
        let index = Arc::new(cache::CacheIndex::load(dir.clone()).await);
        let dl = start(
            "netease",
            dir.clone(),
            "netease-3-standard".into(),
            rungs(&[format!("http://{addr}/junk"), format!("http://{addr}/wav")]),
            None,
            index.clone(),
        )
        .unwrap();
        let path = dl.join().await.unwrap();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("wav"));

        // 全阶梯都认不出容器：报错且不留下任何正式缓存。
        let dir2 = tmp_cache_dir().await;
        let index2 = Arc::new(cache::CacheIndex::load(dir2.clone()).await);
        let dl2 = start(
            "netease",
            dir2.clone(),
            "netease-4-standard".into(),
            rungs(&[format!("http://{addr}/junk")]),
            None,
            index2.clone(),
        )
        .unwrap();
        assert!(dl2.join().await.is_err());
        assert!(index2.find("netease", "4", "standard").await.is_none());
        let mut left2 = tokio::fs::read_dir(&dir2).await.unwrap();
        assert!(
            left2.next_entry().await.unwrap().is_none(),
            "整条阶梯都被拒时不该留下任何文件，含 .part"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let _ = tokio::fs::remove_dir_all(&dir2).await;
    }

    /// 标称无损、实际只交付一小截的候选要在落盘前就被拒；换上来的低档必须按
    /// **实测**档位命名——键里那截 `-lossless` 是用户请求的档位，不是拿到手的
    /// 档位，不改名它就会成为之后每次「无损播放」的命中源。
    #[tokio::test]
    async fn lying_bitrate_is_rejected_and_the_file_uses_its_measured_tier() {
        // 时长 4s：无损 740k 要 ≥296KB，4KB 直接不合格；128k 要 ≥51.2KB，
        // 64KB 能过（实测 131072bps → 标准档）。
        let addr = spawn_routes(&[
            ("/liar", "audio/mpeg", mp3_bytes(4096)),
            ("/honest", "audio/mpeg", mp3_bytes(65_536)),
        ])
        .await;
        let rung = |path: &'static str, bps: u64| Candidate {
            url: format!("http://{addr}{path}"),
            bitrate: Some(bps),
            container: None,
            referer: None,
        };
        let dir = tmp_cache_dir().await;
        let index = Arc::new(cache::CacheIndex::load(dir.clone()).await);
        let dl = start(
            "netease",
            dir.clone(),
            "netease-6-lossless".into(),
            vec![rung("/liar", 740_000), rung("/honest", 128_000)],
            Some(4_000),
            index.clone(),
        )
        .unwrap();
        let path = dl.join().await.unwrap();
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            "netease-6-standard.mp3",
            "降级拿到的文件不能继续挂无损的键"
        );
        assert!(index.find("netease", "6", "lossless").await.is_none());
        assert_eq!(
            index.find("netease", "6", "standard").await.as_deref(),
            Some(path.as_path())
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// 时长未知时诚实闸门整个跳过：没有分母就不做除法，更不把「不知道」当 0
    /// （musicdl 的闸门正是栽在这个洞上，等于没有）。
    #[tokio::test]
    async fn honesty_gate_stays_out_when_duration_is_unknown() {
        let addr = spawn_routes(&[("/liar", "audio/mpeg", mp3_bytes(4096))]).await;
        let dir = tmp_cache_dir().await;
        let index = Arc::new(cache::CacheIndex::load(dir.clone()).await);
        let dl = start(
            "netease",
            dir.clone(),
            "netease-7-lossless".into(),
            vec![Candidate {
                url: format!("http://{addr}/liar"),
                bitrate: Some(740_000),
                container: None,
                referer: None,
            }],
            None,
            index.clone(),
        )
        .unwrap();
        let path = dl.join().await.unwrap();
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            "netease-7-lossless.mp3",
            "没有时长就没有实测档位，键保持原样"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
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
            "netease",
            dir.clone(),
            "qq-a1-standard".into(),
            rungs(&[format!("http://{addr}/audio")]),
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

    /// 读到「已交付的最后一个字节之后」才是文件尾；位置**越过**交付长度说明底层
    /// 字节流被换成了一份更短的（阶梯换格时 `Inner` 记的是新格自己的长度）。
    /// 后者必须报错：把它报成 `Ok(0)` 等于骗上面说这一首播完了，状态层据此跳下
    /// 一曲，还会顺手把半首计入播放量——正是「歌没放完就下一曲」的那条路。
    #[test]
    fn a_position_past_the_delivered_length_is_not_a_clean_eof() {
        let dir = std::env::temp_dir().join(format!("vmusic-prog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("z.part");
        std::fs::write(&part, b"0123456789").unwrap();
        let inner = Arc::new(Inner::new());
        inner.set_total(Some(10));
        inner.advance(10);
        inner.finish();
        let abort = Arc::new(AtomicBool::new(false));
        let mut src = HttpMediaSource::open(&part, inner, abort).unwrap();
        let mut out = [0u8; 4];

        src.seek(SeekFrom::Start(10)).unwrap();
        assert_eq!(src.read(&mut out).unwrap(), 0, "正好读到末尾是自然结束");

        src.seek(SeekFrom::Start(15)).unwrap();
        let e = src.read(&mut out).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `Inner` 承诺还有字节可读、句柄里的文件却已经到尾：这是换格之后旧 `.part`
    /// 被删、本句柄还挂在旧那份上（Windows 允许它读完残留）。这里读出 0 同样不能
    /// 报成文件尾——否则进度条走到三分之二的歌会当场「播完」并跳下一曲。
    #[test]
    fn a_handle_shorter_than_the_delivered_length_is_not_a_clean_eof() {
        let dir = std::env::temp_dir().join(format!("vmusic-prog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("w.part");
        std::fs::write(&part, b"0123456789").unwrap();
        let inner = Arc::new(Inner::new());
        inner.set_total(Some(100));
        inner.advance(100);
        let abort = Arc::new(AtomicBool::new(false));
        let mut src = HttpMediaSource::open(&part, inner, abort).unwrap();
        let mut out = [0u8; 32];

        assert_eq!(
            src.read(&mut out).unwrap(),
            10,
            "残留的那 10 个字节照常交付"
        );
        let e = src.read(&mut out).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
