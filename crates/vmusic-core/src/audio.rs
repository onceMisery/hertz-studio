// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! The audio backend contract.
//!
//! Deliberately **synchronous**: real backends own an OS audio callback that
//! must never block on an executor. Anything async lives one layer up, in the
//! command actor (see `vmusic_audio::actor`), which serialises commands so the
//! backend never sees two operations at once.
//!
//! Backends are intentionally **not** required to be `Send`. A cpal stream is
//! owned by the thread that created it, so the actor spawns a dedicated thread
//! and builds the backend there rather than moving it across threads.

use crate::error::AudioError;
use crate::model::DeviceInfo;

/// What a backend reports back after successfully opening a source.
#[derive(Debug, Clone, Default)]
pub struct MediaInfo {
    pub duration_ms: Option<u64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
}

/// 可流式读取的音频源：标准库 `Read + Seek + Send + Sync` 的组合。
///
/// Rust 的 trait object 只能含一个非 auto trait，无法直接写
/// `Box<dyn Read + Seek + Send>`；而 vmusic-core 又不能依赖 symphonia。
/// 故用这个超集 trait 跨 actor 边界传递媒体源，真实后端内部再适配成
/// symphonia 的 `MediaSource`（symphonia 0.5 还额外要求 `Sync`）。
///
/// 刻意**不做** `impl<T: Read + Seek + Send + Sync> AudioSource for T` 的
/// blanket impl：那样具体类型（如边下边播的 HTTP 源）就无法覆写
/// [`AudioSource::media_len`]。需要跨边界传递的类型各自显式 impl。
pub trait AudioSource: std::io::Read + std::io::Seek + Send + Sync {
    /// 媒体总字节数（已知时）。
    ///
    /// 名字避开 symphonia `MediaSource::byte_len`（vmusic-core 不依赖
    /// symphonia，不能用同名方法）。无 Xing/VBRI 头的 CBR mp3 容器里没有
    /// 总帧数/时长，symphonia 只能按「总字节 ÷ 每帧字节」估算；流式源在
    /// 这里透传 HTTP `Content-Length`，这类曲目才有 duration、才不会永远
    /// `finished()==false` 而无法连播。未知（如 chunked 传输）时返回 None。
    fn media_len(&self) -> Option<u64> {
        None
    }
}

/// DSP 处理链参数。
///
/// `eq_gains_db` 是六个峰化均衡段的增益（dB，-12..+12），频段固定为
/// 60/150/400/1k/2.4k/6k Hz。`preamp_db` 是用户手动增益，`track_gain_db`
/// 是按曲目走响度归一化时的补偿（ReplayGain 标签），两者之和组成线性
/// 增益；后面永远挂限幅器防削波。
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DspParams {
    pub eq_gains_db: [f32; 6],
    pub preamp_db: f32,
    pub track_gain_db: f32,
}

impl Default for DspParams {
    fn default() -> Self {
        Self {
            eq_gains_db: [0.0; 6],
            preamp_db: 0.0,
            track_gain_db: 0.0,
        }
    }
}

pub trait AudioBackend {
    fn name(&self) -> &'static str;

    fn devices(&self) -> Result<Vec<DeviceInfo>, AudioError>;

    fn select_device(&mut self, id: Option<&str>) -> Result<(), AudioError>;

    /// Open a source and prepare playback in a paused state.
    fn load(&mut self, uri: &str) -> Result<MediaInfo, AudioError>;

    /// 直接打开一个媒体源（边下边播用）。默认不支持，真实后端按需实现。
    fn load_source(
        &mut self,
        _source: Box<dyn AudioSource>,
        _ext: Option<String>,
    ) -> Result<MediaInfo, AudioError> {
        Err(AudioError::UnsupportedFormat(
            "该后端不支持流式媒体源".into(),
        ))
    }

    fn play(&mut self) -> Result<(), AudioError>;
    fn pause(&mut self) -> Result<(), AudioError>;
    fn stop(&mut self) -> Result<(), AudioError>;

    fn seek(&mut self, position_ms: u64) -> Result<(), AudioError>;
    fn set_volume(&mut self, volume: f32) -> Result<(), AudioError>;

    /// 更新 DSP 参数（EQ/增益）。默认忽略：null 后端没有音频链。
    fn set_dsp(&mut self, _params: DspParams) -> Result<(), AudioError> {
        Ok(())
    }

    /// 可调交叉淡化时长（毫秒）。默认忽略。
    fn set_crossfade(&mut self, _ms: u64) -> Result<(), AudioError> {
        Ok(())
    }

    fn position_ms(&self) -> u64;
    fn duration_ms(&self) -> Option<u64>;

    /// True once the current source has been fully consumed.
    fn finished(&self) -> bool;

    /// 取出并清除「解码线程异常早夭」标志。
    ///
    /// 返回 true 表示当前曲目的解码线程既不是自然播完（干净 EOF）、也不是
    /// 被主动换装/停止/seek 打断，而是因 I/O 或解码错误提前退出——典型如
    /// 边下边播时下载链路断开。actor 每个 maintain tick 调一次；取走即清零。
    /// 没有独立解码线程的后端（如 null）用默认实现，恒为 false。
    fn take_decode_failure(&mut self) -> bool {
        false
    }

    /// Fill `out` with normalized band energies (0.0..=1.0).
    ///
    /// Returns `false` when the backend cannot provide spectrum data (null
    /// backend, unsupported format, or not currently playing).
    fn spectrum(&self, out: &mut [f32]) -> bool;

    /// 每 20ms 由 actor 调一次：让后端在自己线程上完成延迟状态机
    /// （淡出后再暂停/停止、换装、尾部淡出）。默认空操作。
    fn maintain(&mut self) {}
}
