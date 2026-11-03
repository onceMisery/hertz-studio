// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! WASAPI shared/event loopback 采集线程（设计 docs/desktop-wallpaper.md
//! §11.3，P1-06b-2）。system 输入的 native 半边：固定选择一个 render
//! endpoint 的 loopback（不是麦克风，也不是 IAudioRenderClient 输出路径）。
//!
//! 线程合同（§11.3）：采集线程只做有界格式转换（交织多声道→单声道平均）
//! 与环形缓冲写入，不分配、不写日志、不回调 JS；混合格式不是 IEEE float
//! 时明确失败——采集失败不得偷换到麦克风、Hertz 或另一块设备。静音包同样
//! 推进样本时钟（SILENT 标记按全零入环），频谱据此自然归零。设备格式变更
//! /失效以错误退线呈现，重开（重建分析器）由编排层按代际执行。
//!
//! 切换由 [`super::audio_service::AudioService`] 单一 owner 编排：代际递增并
//! 清除输出 → stop_and_join 等旧线程真实退出 → 清空样本与分析器 → 打开新输入
//! → 首个合法样本生效。所有消费者暂停/静态时关闭采集（不追旧样本）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::GUID;
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX,
    WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use super::audio::{downmix_interleaved, SampleRing, FFT_SIZE};

#[cfg(test)]
use super::audio::{SpectrumAnalyzer, BANDS};

/// WAVE_FORMAT_IEEE_FLOAT（windows crate 未在 Media::Audio 导出，已知常量）。
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
/// WAVE_FORMAT_EXTENSIBLE。
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
/// IEEE float 子格式 GUID（KSDATAFORMAT_SUBTYPE_IEEE_FLOAT）。
const SUBFORMAT_IEEE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);
/// 事件等待上限：超时回查停止旗标，连接活性由事件侧维持。
const WAIT_SLICE_MS: u32 = 2000;
/// 与播放器一致的格式边界（vmusic-audio/render.rs）。
const MAX_CHANNELS: usize = 32;
const MAX_SAMPLE_RATE: u32 = 768_000;

/// 一次采集的退出回执。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CaptureExit {
    pub(crate) generation: u64,
    /// None = 干净停止；Some = 采集失败原因（重开前展示，不自动偷换设备）。
    pub(crate) error: Option<String>,
    pub(crate) dropped: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureInfo {
    pub(crate) device_id: String,
    pub(crate) sample_rate: u32,
    pub(crate) channels: usize,
}

/// 采集线程句柄：`stop_and_join` 等旧线程真实退出后才算取消完成（§11.3）。
pub(crate) struct CaptureHandle {
    generation: u64,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<CaptureExit>>,
    info: Arc<Mutex<Option<CaptureInfo>>>,
}

impl CaptureHandle {
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }
    pub(crate) fn info(&self) -> Option<CaptureInfo> {
        self.info
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// 停止并等待真实退出。返回线程回执；线程 panic 也折叠为结构化错误。
    pub(crate) fn stop_and_join(mut self) -> CaptureExit {
        self.stop.store(true, Ordering::Relaxed);
        match self.thread.take().map(JoinHandle::join) {
            Some(Ok(exit)) => exit,
            Some(Err(_)) => CaptureExit {
                generation: self.generation,
                error: Some("采集线程 panic".into()),
                dropped: 0,
            },
            None => CaptureExit {
                generation: self.generation,
                error: None,
                dropped: 0,
            },
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 启动 system loopback 采集。`device: None` 跟随默认渲染设备（默认设备
/// 变化时由编排层按此语义重绑），`Some(id)` 为固定的 endpoint id——拿不到
/// 该设备直接失败，不回退默认或别的设备。
pub(crate) fn spawn_loopback(
    device: Option<String>,
    ring: Arc<Mutex<SampleRing>>,
    generation: u64,
) -> Result<CaptureHandle, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let info = Arc::new(Mutex::new(None));
    let thread_info = Arc::clone(&info);
    let thread = std::thread::Builder::new()
        .name("hertz-wallpaper-audio".into())
        .spawn(move || run_capture(device, ring, generation, thread_stop, thread_info))
        .map_err(|error| format!("启动采集线程失败：{error}"))?;
    Ok(CaptureHandle {
        generation,
        stop,
        thread: Some(thread),
        info,
    })
}

fn run_capture(
    device: Option<String>,
    ring: Arc<Mutex<SampleRing>>,
    generation: u64,
    stop: Arc<AtomicBool>,
    info: Arc<Mutex<Option<CaptureInfo>>>,
) -> CaptureExit {
    let result = capture_loop(&device, &ring, &stop, &info);
    let dropped = ring.lock().map(|ring| ring.dropped()).unwrap_or_default();
    match result {
        Ok(()) => CaptureExit {
            generation,
            error: None,
            dropped,
        },
        Err(error) => CaptureExit {
            generation,
            error: Some(error),
            dropped,
        },
    }
}

fn capture_loop(
    device: &Option<String>,
    ring: &Mutex<SampleRing>,
    stop: &AtomicBool,
    info: &Mutex<Option<CaptureInfo>>,
) -> Result<(), String> {
    unsafe {
        // 采集线程自有 COM 单元（MTA）；S_FALSE（此前已初始化）同样可继续，
        // 其余失败直接退出。S_OK/S_FALSE 都要配平一次 CoUninitialize。
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!("COM 初始化失败：{hr:?}"));
        }
        let outcome = open_and_capture(device, ring, stop, info);
        windows::Win32::System::Com::CoUninitialize();
        outcome
    }
}

unsafe fn open_and_capture(
    device: &Option<String>,
    ring: &Mutex<SampleRing>,
    stop: &AtomicBool,
    info: &Mutex<Option<CaptureInfo>>,
) -> Result<(), String> {
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        .map_err(|error| format!("枚举音频设备失败：{error}"))?;
    let endpoint: IMMDevice = match device {
        Some(id) => enumerator
            .GetDevice(&windows::core::HSTRING::from(id))
            .map_err(|error| format!("找不到指定渲染设备（不回退其它设备）：{error}"))?,
        None => enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(|error| format!("没有默认渲染设备：{error}"))?,
    };
    let device_id = endpoint
        .GetId()
        .map_err(|error| format!("读取渲染设备身份失败：{error}"))?;
    let id = device_id.to_string();
    CoTaskMemFree(Some(device_id.0.cast()));
    let id = id.map_err(|error| format!("读取渲染设备身份失败：{error}"))?;
    let client: IAudioClient = endpoint
        .Activate(CLSCTX_ALL, None)
        .map_err(|error| format!("激活音频客户端失败：{error}"))?;
    let format = client
        .GetMixFormat()
        .map_err(|error| format!("读取混合格式失败：{error}"))?;

    let shape = validate_format(format);
    let (channels, sample_rate) = match shape {
        Ok(shape) => shape,
        Err(message) => {
            CoTaskMemFree(Some(format.cast::<core::ffi::c_void>()));
            return Err(message);
        }
    };

    // 事件句柄与全部 COM 资源在单一出口统一清理。
    let event = match CreateEventW(None, false, false, None) {
        Ok(event) => event,
        Err(error) => {
            CoTaskMemFree(Some(format.cast::<core::ffi::c_void>()));
            return Err(format!("创建采集事件失败：{error}"));
        }
    };

    let opened = (|| -> Result<(), String> {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                0,
                0,
                format,
                None,
            )
            .map_err(|error| format!("初始化 loopback 失败：{error}"))?;
        client
            .SetEventHandle(event)
            .map_err(|error| format!("绑定采集事件失败：{error}"))?;
        Ok(())
    })();

    let run = opened.and_then(|()| {
        let capture: IAudioCaptureClient = client
            .GetService()
            .map_err(|error| format!("获取采集客户端失败：{error}"))?;
        client
            .Start()
            .map_err(|error| format!("启动采集失败：{error}"))?;
        // The source rate sets the 250 ms cap before the first captured packet.
        *ring.lock().unwrap_or_else(|error| error.into_inner()) = SampleRing::new(sample_rate);
        *info.lock().unwrap_or_else(|error| error.into_inner()) = Some(CaptureInfo {
            device_id: id,
            sample_rate,
            channels,
        });
        // 热路径零分配：线程内一次性预热 1 秒单声道 + 原始缓冲容量。
        let mut mono: Vec<f32> = Vec::with_capacity(sample_rate as usize);
        capture_packets(
            &capture,
            stop,
            ring,
            (channels, sample_rate),
            event,
            &mut mono,
        )
    });

    let _ = client.Stop();
    let _ = CloseHandle(event);
    CoTaskMemFree(Some(format.cast::<core::ffi::c_void>()));
    run
}

/// 格式合同：共享混合格式必须是 IEEE float（EXTENSIBLE 须带 float 子格式）。
/// 声道/采样率沿用播放器边界；越界或非 float 一律明确失败（§11.3 不偷换）。
/// WAVEFORMATEX/WAVEFORMATEXTENSIBLE 都是 packed(1)——字段一律
/// `addr_of!` + `read_unaligned` 取值（E0793：packed 字段引用是硬错误）。
unsafe fn validate_format(format: *mut WAVEFORMATEX) -> Result<(usize, u32), String> {
    let tag = core::ptr::addr_of!((*format).wFormatTag).read_unaligned();
    let channels_raw = core::ptr::addr_of!((*format).nChannels).read_unaligned();
    let rate = core::ptr::addr_of!((*format).nSamplesPerSec).read_unaligned();
    let bits = core::ptr::addr_of!((*format).wBitsPerSample).read_unaligned();
    let align = core::ptr::addr_of!((*format).nBlockAlign).read_unaligned();
    let extra = core::ptr::addr_of!((*format).cbSize).read_unaligned();
    let is_float = match tag {
        WAVE_FORMAT_IEEE_FLOAT => true,
        WAVE_FORMAT_EXTENSIBLE => {
            if usize::from(extra) < size_of::<WAVEFORMATEXTENSIBLE>() - size_of::<WAVEFORMATEX>() {
                return Err("混合格式扩展头不完整".into());
            }
            let ext: WAVEFORMATEXTENSIBLE = core::ptr::read_unaligned(format.cast());
            let sub_format = core::ptr::addr_of!(ext.SubFormat).read_unaligned();
            sub_format == SUBFORMAT_IEEE_FLOAT
        }
        _ => false,
    };
    if !is_float {
        return Err(format!(
            "混合格式不是 IEEE float（tag 0x{tag:04x}）；拒绝采集而非偷换"
        ));
    }
    let channels = channels_raw as usize;
    if channels == 0 || channels > MAX_CHANNELS || rate == 0 || rate > MAX_SAMPLE_RATE {
        return Err(format!("混合格式越界：{channels} 声道 @ {rate} Hz"));
    }
    if rate < (FFT_SIZE * 4) as u32 {
        return Err("采样率不足以在 250 ms 缓冲内提供 2048 点分析窗".into());
    }
    if bits != 32 || usize::from(align) != channels * size_of::<f32>() {
        return Err("IEEE float 必须为 32 位且帧对齐与声道数一致".into());
    }
    Ok((channels, rate))
}

/// 事件驱动的包循环：每包 有界转换→下混→环形缓冲（锁内 µs 级）；静音包
/// 按全零入环推进时钟。不分配、不记日志（§11.3 线程合同）。
unsafe fn capture_packets(
    capture: &IAudioCaptureClient,
    stop: &AtomicBool,
    ring: &Mutex<SampleRing>,
    shape: (usize, u32),
    event: windows::Win32::Foundation::HANDLE,
    mono: &mut Vec<f32>,
) -> Result<(), String> {
    let (channels, sample_rate) = shape;
    let mut frequency = 0;
    QueryPerformanceFrequency(&mut frequency).map_err(|error| error.to_string())?;
    if frequency <= 0 {
        return Err("采集时钟频率无效".into());
    }
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let waited = WaitForSingleObject(event, WAIT_SLICE_MS);
        if waited == WAIT_TIMEOUT {
            continue;
        }
        if waited != WAIT_OBJECT_0 {
            return Err(format!("等待采集事件失败：{waited:?}"));
        }
        loop {
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            let mut frames = capture
                .GetNextPacketSize()
                .map_err(|error| format!("读取包大小失败：{error}"))?;
            if frames == 0 {
                break;
            }
            let mut data: *mut u8 = core::ptr::null_mut();
            let mut flags: u32 = 0;
            let mut packet_qpc = 0;
            capture
                .GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    None,
                    Some(&mut packet_qpc),
                )
                .map_err(|error| format!("读取采集缓冲失败：{error}"))?;
            let mut counter = 0;
            let clock = QueryPerformanceCounter(&mut counter);
            let now = Instant::now();
            let captured_at = if clock.is_ok()
                && counter >= 0
                && flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0
            {
                // WASAPI reports the FIRST sample in 100 ns units, not raw QPC ticks.
                let qpc_now = (counter as u128 * 10_000_000 / frequency as u128) as u64;
                packet_time(now, qpc_now, packet_qpc, frames, sample_rate)
            } else {
                None
            };
            let Some(captured_at) = captured_at else {
                ring.lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .discontinue();
                capture
                    .ReleaseBuffer(frames)
                    .map_err(|error| error.to_string())?;
                continue;
            };
            if frames as usize > mono.capacity()
                || (data.is_null()
                    && frames > 0
                    && flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0)
            {
                let _ = capture.ReleaseBuffer(frames);
                return Err("采集包超过预分配容量或缺少样本数据".into());
            }
            mono.clear();
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                // 静音包：mono 帧 ×1（不是 ×channels），全零推进时钟。
                mono.resize(frames as usize, 0.0);
            } else {
                let count = frames as usize * channels;
                if count > 0 {
                    let samples = std::slice::from_raw_parts(data.cast::<f32>(), count);
                    downmix_interleaved(samples, channels, mono);
                }
            }
            if let Ok(mut guard) = ring.lock() {
                if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                    guard.discontinue();
                }
                guard.push_at(mono, captured_at);
            }
            capture
                .ReleaseBuffer(frames)
                .map_err(|error| format!("释放采集缓冲失败：{error}"))?;
        }
    }
}

fn packet_time(
    now: Instant,
    qpc_now: u64,
    first_sample: u64,
    frames: u32,
    rate: u32,
) -> Option<Instant> {
    let span = u64::from(frames.checked_sub(1)?) * 10_000_000 / u64::from(rate);
    let age = qpc_now.checked_sub(first_sample.checked_add(span)?)?;
    now.checked_sub(Duration::from_nanos(age.checked_mul(100)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_clock_uses_wasapi_first_sample_time_and_actual_rate() {
        let now = Instant::now();
        // 480 frames at 48 kHz: last sample was 9.9791 ms after the first.
        let stamp = packet_time(now, 10_000_000, 9_000_000, 480, 48_000).unwrap();
        assert_eq!(now.duration_since(stamp), Duration::from_nanos(90_020_900));
        let high_rate = packet_time(now, 10_000_000, 9_000_000, 480, 96_000).unwrap();
        assert!(high_rate < stamp);
        assert!(packet_time(now, 10_000_000, 10_000_001, 1, 48_000).is_none());
        assert!(packet_time(now, 10_000_000, 0, 0, 48_000).is_none());
        assert!(packet_time(now, u64::MAX, u64::MAX, 480, 48_000).is_none());
    }

    /// 非 float 混合格式明确拒绝（不偷换设备，§11.3）。
    #[test]
    fn format_validation_rejects_non_float() {
        let mut fmt = WAVEFORMATEX {
            wFormatTag: 1, // PCM
            nChannels: 2,
            nSamplesPerSec: 48_000,
            nAvgBytesPerSec: 48_000 * 2 * 2,
            nBlockAlign: 4,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let error = unsafe { validate_format(&mut fmt) }.unwrap_err();
        assert!(error.contains("IEEE float"), "{error}");

        fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        assert!(
            unsafe { validate_format(&mut fmt) }.is_err(),
            "16 位 float 不能按 f32 读取"
        );
        fmt.wBitsPerSample = 32;
        fmt.nBlockAlign = 8;
        assert_eq!(unsafe { validate_format(&mut fmt) }.unwrap(), (2, 48_000));
        fmt.nSamplesPerSec = 8_000;
        assert!(unsafe { validate_format(&mut fmt) }
            .unwrap_err()
            .contains("250 ms"));
        fmt.nSamplesPerSec = 96_000;
        assert_eq!(unsafe { validate_format(&mut fmt) }.unwrap(), (2, 96_000));

        fmt.nChannels = 64;
        assert!(unsafe { validate_format(&mut fmt) }
            .unwrap_err()
            .contains("越界"));
    }

    /// 只验证真实采集生命周期，不创建 render client、不发声、不改设备或音量。
    /// 没有其它渲染活动时允许没有 PCM，不能把静音当成采集失败。
    #[test]
    #[ignore = "需要真实默认渲染设备；显式运行，不播放测试音"]
    fn loopback_lifecycle_without_playback() {
        for generation in 1..=3 {
            let ring = Arc::new(Mutex::new(SampleRing::new(48_000)));
            let handle = spawn_loopback(None, Arc::clone(&ring), generation).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            let stopped = std::time::Instant::now();
            let exit = handle.stop_and_join();
            assert_eq!(exit.generation, generation);
            assert!(
                exit.error.is_none(),
                "真实默认设备初始化/停止失败：{:?}",
                exit.error
            );
            assert!(
                stopped.elapsed() < Duration::from_secs(3),
                "停止必须在一次事件等待内退出"
            );
        }
        let ring = Arc::new(Mutex::new(SampleRing::new(48_000)));
        let handle = spawn_loopback(
            Some("hertz-test-missing-endpoint".into()),
            Arc::clone(&ring),
            4,
        )
        .unwrap();
        let exit = handle.stop_and_join();
        assert!(exit
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("找不到指定渲染设备"));
        assert_eq!(
            ring.lock().unwrap().len(),
            0,
            "固定设备失联不能回退到默认设备采集"
        );
    }

    /// 真机冒烟（端到端）：自绘 440Hz 测试音 → 引擎 → loopback 采集 →
    /// 下混 → 环形缓冲 → 频带分析非零。loopback 只跟渲染活动走，测试音
    /// 同时充当「激活引擎」的渲染客户端。需要本机存在默认渲染设备。
    #[test]
    #[ignore = "需要本机默认渲染设备（真机冒烟）"]
    fn loopback_captures_clock_and_stops_cleanly() {
        let ring = Arc::new(Mutex::new(SampleRing::new(48_000)));
        let handle = spawn_loopback(None, Arc::clone(&ring), 1).expect("loopback 必须可开");
        std::thread::sleep(Duration::from_millis(200));

        // 自绘 1.2s 测试音（polled render；不动用户音量，幅度 0.02）。
        unsafe { render_tone(Duration::from_millis(1200), 440.0, 0.02) }
            .expect("测试音渲染必须成功");

        // Read while the samples are current; joining can wait through an idle device event.
        let (len, dropped) = {
            let guard = ring.lock().unwrap();
            (guard.len(), guard.dropped())
        };
        println!("loopback 冒烟：采到 {len} 样本，dropped={dropped}");
        assert!(len >= FFT_SIZE, "测试音期间 loopback 必须持续发包：{len}");

        let mut window = [0.0f32; FFT_SIZE];
        assert!(ring.lock().unwrap().take_window(&mut window));
        let mut analyzer = SpectrumAnalyzer::new();
        let mut bands = [0.0f32; BANDS];
        assert!(analyzer.analyze(&window, &mut bands));
        let peak = bands.iter().cloned().fold(0.0f32, f32::max);
        println!("频带峰值 {peak:.3}（440Hz 预期落中低频带）");
        assert!(peak > 0.05, "端到端频谱必须非平凡：peak={peak}");

        let exit = handle.stop_and_join();
        assert_eq!(exit.generation, 1);
        assert!(
            exit.error.is_none(),
            "COM/初始化路径必须干净：{:?}",
            exit.error
        );

        // 恢复重开（§11.3）：真实退出后可再次打开。
        let handle2 = spawn_loopback(None, ring, 2).expect("复绑");
        let exit2 = handle2.stop_and_join();
        assert_eq!(exit2.generation, 2);
        assert!(exit2.error.is_none(), "复绑干净退出：{:?}", exit2.error);
    }

    /// 极简 polled render：往默认渲染设备推一段正弦（仅冒烟用）。
    unsafe fn render_tone(
        duration: std::time::Duration,
        freq: f32,
        amplitude: f32,
    ) -> Result<(), String> {
        use windows::Win32::Media::Audio::IAudioRenderClient;

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|error| format!("枚举：{error}"))?;
        let endpoint: IMMDevice = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(|error| format!("端点：{error}"))?;
        let client: IAudioClient = endpoint
            .Activate(CLSCTX_ALL, None)
            .map_err(|error| format!("激活：{error}"))?;
        let format = client
            .GetMixFormat()
            .map_err(|error| format!("格式：{error}"))?;
        // 发声探针也必须遵守 f32 合同，不能把 16 位 PCM 缓冲当作 f32 写。
        let (channels, rate) = match validate_format(format) {
            Ok(shape) => shape,
            Err(error) => {
                CoTaskMemFree(Some(format.cast::<core::ffi::c_void>()));
                return Err(error);
            }
        };
        // 这台设备的引擎不吃 0 时长（AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED）：
        // 用默认设备周期对齐（×2），仍不齐再放大一档重试。
        let mut default_period = 10_000_000 / 100; // 10ms 兜底（hns）
        let _ = client.GetDevicePeriod(Some(&mut default_period), None);
        let mut initialized = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            0,
            default_period * 2,
            0,
            format,
            None,
        );
        if initialized.is_err() {
            initialized = client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                0,
                default_period * 4,
                0,
                format,
                None,
            );
        }
        initialized.map_err(|error| format!("render 初始化：{error}"))?;
        let render: IAudioRenderClient = client
            .GetService()
            .map_err(|error| format!("render 服务：{error}"))?;
        // 实际缓冲帧数以引擎分配为准（Initialize 的时长决定，不按采样率猜）。
        let buffer_frames = client
            .GetBufferSize()
            .map_err(|error| format!("缓冲大小：{error}"))? as usize;
        client
            .Start()
            .map_err(|error| format!("render 启动：{error}"))?;

        let deadline = std::time::Instant::now() + duration;
        let mut cursor = 0usize;
        loop {
            let padding = client
                .GetCurrentPadding()
                .map_err(|error| format!("padding：{error}"))?;
            let writable = buffer_frames.saturating_sub(padding as usize);
            if writable > 0 {
                let buffer = render
                    .GetBuffer(writable as u32)
                    .map_err(|error| format!("GetBuffer({writable})：{error}"))?;
                let out = std::slice::from_raw_parts_mut(
                    buffer.cast::<f32>(),
                    writable as usize * channels,
                );
                for frame in out.chunks_exact_mut(channels) {
                    let sample = amplitude
                        * (2.0 * std::f32::consts::PI * freq * cursor as f32 / rate as f32).sin();
                    for channel in frame.iter_mut() {
                        *channel = sample;
                    }
                    cursor += 1;
                }
                render
                    .ReleaseBuffer(writable as u32, 0)
                    .map_err(|error| format!("ReleaseBuffer：{error}"))?;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = client.Stop();
        CoTaskMemFree(Some(format.cast::<core::ffi::c_void>()));
        Ok(())
    }
}
