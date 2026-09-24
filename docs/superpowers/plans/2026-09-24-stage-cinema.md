# 实施计划：3D 舞台节拍电影相机 · 自由相机 · 焦点跟拍 · 玻璃化 UI

**REQUIRED SUB-SKILL:** 执行本计划必须使用 subagent-driven-development（推荐）或 executing-plans 技能逐任务推进；每个任务结束跑全量门，再派独立只读审查代理复审。

## Goal

按已批准的 spec（[2026-09-24-stage-cinema-design.md](../../specs/2026-09-24-stage-cinema-design.md)）交付四条工作线：

1. 服务端离线节拍分析（新 crate `vmusic-beats`）+ JSON 缓存 + beatmap REST/WS 协议；
2. 相机 roll 通道与 camLayers 总线、电影相机（stage-cinema.js）、自由相机（stage-freecam.js）、焦点跟拍（stage-focus.js）；
3. 玻璃化 UI 令牌与四个覆盖面；
4. 存量场景参数级防护/调优与契约/全量门/真机验收。

## Architecture

- **分析**：`spawn_blocking` 跑 symphonia 解码 + rustfft，纯计算库与 actor/HTTP 解耦；进程内幂等表（key → Analyzing/Ready/Failed）+ `data/stage-beats/<sha1>.json` 缓存（内含 source_mtime_ms 失效）。两个触发源（播放提交 detach、前端 GET）先到先建。在线曲仅在 `find_cached_by_key` 命中（下载完成 rename 后）才分析。
- **协议**：GET 三态 200/202/404（手写 JSON 体，不走标准 ApiError）；WS 新增命名 struct 变体 `BeatmapReady`。
- **前端**：单一 rAF 不变。creative-stage 每帧构造相机 ctx，经 camLayers 按优先级 cinema(10) → peek(20) → freecam(30) 叠加；shake/drift/parallax 在层结果之上最后合成。时间轴纯函数双导出（`module.exports` + `window.StageCinemaPure`），Node 直测。
- **UI**：只新增 3 个玻璃令牌并统一四个覆盖面到令牌；lowfx 走现有 `body.stage-lowfx` 钩子降级。

## Tech Stack

Rust（symphonia 0.5 / rustfft 6.2 / num-complex 0.4 / sha1 / serde）、axum 0.8、tokio；裸 JS（零构建、零新依赖）、CSS 令牌；Node `vm`/require 契约脚本。

## Spec

[docs/superpowers/specs/2026-09-24-stage-cinema-design.md](../../specs/2026-09-24-stage-cinema-design.md)（12 节，本计划逐条落地）

## 全局约定（每个任务都必须遵守）

- 新 Rust/JS 文件首行 SPDX 头：`// SPDX-License-Identifier: MIT`（Rust 文件加第二行 `// Copyright (c) 2026 mmusic-studio contributors`）。禁止拷贝 Mineradio（GPL-3.0）代码。
- PowerShell 5：命令用 `;` 分隔（无 `&&`）；npm 用 `npm.cmd`；git 一律加 `--no-pager`。
- 全量门（每个任务结束都要全绿）：
  - `cargo fmt --all; cargo clippy --workspace --all-targets -- -D warnings; cargo test --workspace`
  - `Get-ChildItem scripts\check-*.js | ForEach-Object { node $_.FullName }`
- 提交：`git --no-pager add <精确文件>` + 中文短句提交信息；每个任务一次 commit。
- 前端代码风格：ES5 语法（`var`、`function`，无箭头函数/模板字符串之外的新语法——沿用各文件现状；新文件内可用字符串模板，保持与所在文件一致即可）、无构建步骤、不新增 npm 依赖。
- 不写占位符/TODO；所有新代码在本计划中给全。
- AppState 加字段必须同步 main.rs L122-141 的结构体构造处。

## File Structure

**新增**

- `crates/vmusic-beats/Cargo.toml`、`crates/vmusic-beats/src/lib.rs`（分析库 + 合成 PCM 单测）
- `crates/vmusicd/src/stage_beats.rs`（缓存/幂等/调度/三态）
- `crates/vmusicd/web/stage-cinema.js`（纯时间轴 IIFE + 电影相机驱动 IIFE）
- `crates/vmusicd/web/stage-freecam.js`
- `crates/vmusicd/web/stage-focus.js`
- `scripts/check-stage-cinema.js`（纯函数断言 + 跨文件契约）

**修改**

- `Cargo.toml`（workspace dep）、`crates/vmusicd/Cargo.toml`
- `crates/vmusicd/src/main.rs`（mod、include×3、asset 路由×3、weak_self 注入）
- `crates/vmusicd/src/state.rs`（WsEvent、AppState 字段、stage_beats_dir、weak_self、on_track_committed detach）
- `crates/vmusicd/src/routes.rs`（GET beatmap）
- `crates/vmusicd/src/ws.rs`（BeatmapReady 精确 JSON 断言）
- `crates/vmusicd/web/creative-gl.js`（rollView + cam.roll）
- `crates/vmusicd/web/creative-stage.js`（camLayers 总线 + 交互屏蔽钩子）
- `crates/vmusicd/web/stage-control.js`（cine 组）
- `crates/vmusicd/web/app.js`（WS 分支、换曲/快照钩子、队列行 dataset、init）
- `crates/vmusicd/web/style.css`、`online.css`、`stage.css`、`creative.css`
- `crates/vmusicd/web/index.html`（3 个 script）
- `scripts/check-assets.js`、`scripts/check-css-tokens.js`、`scripts/check-stage-control.js`

---

# 任务 1：vmusic-beats crate（解码/重采样/STFT/通量/峰值/BPM/强拍/推演）+ 单测

## Files

- Create: `crates/vmusic-beats/Cargo.toml`
- Create: `crates/vmusic-beats/src/lib.rs`
- Modify: `Cargo.toml` L23 后加一行 workspace 内部依赖（members 是 `crates/*`，无需动 L6）

## Steps

- [ ] **1.1 注册 crate**

`Cargo.toml` L23 `vmusic-lyrics = ...` 之后插入：

```toml
vmusic-beats = { path = "crates/vmusic-beats", version = "0.1.0" }
```

创建 `crates/vmusic-beats/Cargo.toml`：

```toml
# SPDX-License-Identifier: MIT
[package]
name = "vmusic-beats"
version.workspace = true
edition.workspace = true
license.workspace = true
authors.workspace = true
description = "Offline beat/downbeat analysis powering the stage cinema camera"

[dependencies]
symphonia = { workspace = true }
rustfft = { workspace = true }
num-complex = { workspace = true }
serde = { workspace = true }
```

- [ ] **1.2 写失败测试（合成 PCM，不提交音频文件）**

创建 `crates/vmusic-beats/src/lib.rs`，先只放类型声明与 `#[cfg(test)] mod tests`（此时测试编译失败：`analyze_mono`/`resample_linear` 不存在）：

```rust
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 离线节拍分析：解码 → 单声道重采样 → STFT 频谱通量 → 峰值/BPM/强拍分型。
//!
//! 纯计算库（不碰 cpal、不做网络）。分析主流程拆成 [`analyze_path`]（symphonia
//! 解码）与 [`analyze_mono`]（PCM → 地图）两段，单测直接合成 PCM 喂第二段。

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成 bpm 恒定的 click 轨：每个点击是 24ms 的 200+900Hz 双音 Hann 短脉冲。
    fn click_train(bpm: f64, beats_n: usize, lead_ms: u64, total_ms: u64, sr: u32) -> Vec<f32> {
        let period = 60_000.0 / bpm;
        let n = (total_ms as usize * sr as usize) / 1000;
        let mut buf = vec![0f32; n];
        let burst = (sr as usize * 24) / 1000;
        for k in 0..beats_n {
            let center = ((lead_ms as f64 + k as f64 * period) * sr as f64 / 1000.0).round() as usize;
            for s in 0..burst {
                let idx = center + s;
                if idx >= n {
                    break;
                }
                let ph = s as f32 / sr as f32;
                let env = 0.5 - 0.5
                    * (2.0 * std::f32::consts::PI * s as f32 / (burst as f32 - 1.0)).cos();
                let v = (2.0 * std::f32::consts::PI * 200.0 * ph).sin() * 0.6
                    + (2.0 * std::f32::consts::PI * 900.0 * ph).sin() * 0.4;
                buf[idx] += v * env;
            }
        }
        buf
    }

    #[test]
    fn resample_halves_and_keeps_rate() {
        let input: Vec<f32> = (0..2205).map(|i| (i as f32 * 0.1).sin()).collect();
        let half = resample_linear(&input, 22050, 11025);
        assert!(half.len() >= 1100 && half.len() <= 1104);
        let same = resample_linear(&input, 22050, 22050);
        assert_eq!(same.len(), input.len());
    }

    #[test]
    fn flux_peaks_land_on_clicks_and_bpm_is_120() {
        // 32 拍 × 500ms + 前导 300ms + 尾 500ms ≈ 16.8s，走 22050Hz 分析率。
        let pcm = click_train(120.0, 32, 300, 300 + 32 * 500 + 500, 22050);
        let map = analyze_mono(&pcm, 22050, (300 + 32 * 500 + 500) as u64).unwrap();
        assert!(map.bpm.is_some(), "恒定 click 轨必须给出 BPM");
        let bpm = map.bpm.unwrap();
        assert!((118.0..=122.0).contains(&bpm), "bpm={bpm}");
        assert!(map.beats.len() >= 28 && map.beats.len() <= 36, "{}", map.beats.len());
        // 至少 30 个点击在 ±60ms 内有检出峰，首拍落在前导点击附近（±80ms）。
        let mut hit = 0;
        for k in 0..32 {
            let expect = 300.0 + k as f64 * 500.0;
            if map
                .beats
                .iter()
                .any(|b| (b.t as f64 - expect).abs() <= 60.0)
            {
                hit += 1;
            }
        }
        assert!(hit >= 30, "峰位置命中 {hit}/32");
        assert!((map.beats[0].t as f64 - 300.0).abs() <= 80.0);
    }

    #[test]
    fn downbeats_anchor_at_zero_then_every_four() {
        let pcm = click_train(120.0, 32, 300, 300 + 32 * 500 + 500, 22050);
        let map = analyze_mono(&pcm, 22050, (300 + 32 * 500 + 500) as u64).unwrap();
        assert!(map.beats[0].downbeat, "等强度峰的锚点必须是第一拍");
        for (i, b) in map.beats.iter().enumerate() {
            assert_eq!(b.downbeat, i % 4 == 0, "第 {i} 拍 downbeat 分型错误");
        }
    }

    #[test]
    fn strength_and_intensity_ranges() {
        let pcm = click_train(120.0, 32, 300, 300 + 32 * 500 + 500, 22050);
        let map = analyze_mono(&pcm, 22050, (300 + 32 * 500 + 500) as u64).unwrap();
        for b in &map.beats {
            assert!(b.strength >= 0.0 && b.strength <= 1.0);
            assert!(b.intensity <= 3);
        }
    }

    #[test]
    fn sparse_irregular_clicks_have_null_bpm_but_keep_beats() {
        let pcm = click_train(120.0, 4, 300, 4000, 22050);
        let map = analyze_mono(&pcm, 22050, 4000).unwrap();
        assert!(map.bpm.is_none());
        assert!(!map.beats.is_empty());
    }

    #[test]
    fn long_track_is_truncated_and_tail_is_extrapolated() {
        // 725s 输入：解码侧按 11025Hz，分析只吃前 720s，尾段按 BPM 推演。
        let pcm = click_train(120.0, 1450, 300, 725_000, 11025);
        let map = analyze_mono(&pcm, 11025, 725_000).unwrap();
        assert!(map.truncated);
        assert!((118.0..=122.0).contains(&map.bpm.unwrap()));
        let tail: Vec<_> = map.beats.iter().filter(|b| b.t > 720_000).collect();
        assert!(tail.len() >= 5, "720s 之后应有推演拍，实际 {}", tail.len());
        for w in map.beats.windows(2) {
            assert!(w[1].t > w[0].t, "beats 必须严格升序");
        }
    }

    #[test]
    fn silence_is_unsupported_not_empty_map() {
        let pcm = vec![0f32; 22050 * 2];
        let err = analyze_mono(&pcm, 22050, 2000).unwrap_err();
        assert!(matches!(err, AnalyzeError::Unsupported(_)));
    }

    #[test]
    fn non_finite_samples_fail_without_panicking() {
        let mut pcm = vec![0.1f32; 22050];
        pcm[100] = f32::INFINITY;
        pcm[200] = f32::NAN;
        let err = analyze_mono(&pcm, 22050, 1000).unwrap_err();
        assert!(matches!(err, AnalyzeError::Failed(_)));
    }
}
```

跑 `cargo test -p vmusic-beats` 确认编译失败（缺 `analyze_mono`/`resample_linear`）。

- [ ] **1.3 完整实现**

用以下完整内容替换 `crates/vmusic-beats/src/lib.rs` 中测试模块以外的部分（保留 1.2 的 `mod tests`，最终文件 = 下方实现 + 1.2 测试）：

```rust
use num_complex::Complex;
use serde::{Deserialize, Serialize};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use std::path::Path;

use rustfft::FftPlanner;

/// 一拍。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Beat {
    /// 相对曲目开头的毫秒时间，全表严格升序。
    pub t: i64,
    /// 峰强度 0..=1。
    pub strength: f32,
    /// 4/4 强拍标记。
    pub downbeat: bool,
    /// 能量分档 0..=3。
    pub intensity: u8,
}

/// 节拍地图（磁盘缓存与 HTTP 响应共用结构）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BeatMap {
    pub version: u32,
    /// 置信度不足时为 None；峰点仍可用，只失去规整化。
    pub bpm: Option<f64>,
    pub offset_ms: i64,
    /// 只分析了前 720s、尾段按 BPM 推演时为 true。
    pub truncated: bool,
    pub beats: Vec<Beat>,
}

/// 解码/分析失败。[`AnalyzeError::Unsupported`] 表示文件能解但检不出拍
/// （空地图），其余一律 Failed。
#[derive(Debug)]
pub enum AnalyzeError {
    Unsupported(String),
    Failed(String),
}

impl std::fmt::Display for AnalyzeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AnalyzeError::Unsupported(s) | AnalyzeError::Failed(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for AnalyzeError {}

const WINDOW: usize = 1024;
const HOP: usize = 512;
const MEL_BANDS: usize = 26;
const ANALYZE_MS: u64 = 720_000;
const LONG_MS: u64 = 480_000;
const HIGH_RATE: u32 = 22_050;
const LOW_RATE: u32 = 11_025;
const MAP_VERSION: u32 = 1;

/// 解码文件 → 单声道 → [`analyze_mono`]。只解前 720s（推演补尾段），
/// 避免对整首长曲做无谓解码。
pub fn analyze_path(path: &Path) -> Result<BeatMap, AnalyzeError> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let file = std::fs::File::open(path).map_err(|e| AnalyzeError::Failed(e.to_string()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if !ext.is_empty() {
        hint.with_extension(&ext);
    }
    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| AnalyzeError::Failed(e.to_string()))?;
    let track = probed
        .format
        .default_track()
        .ok_or_else(|| AnalyzeError::Failed("no audio track".into()))?;
    let params = track.codec_params.clone();
    // 时长优先取容器/帧头（不必整曲解完就知道长度）；缺了再用实际解码样本兜底。
    let header_ms = params.time_base.zip(params.n_frames).map(|(tb, frames)| {
        let time = tb.calc_time(frames);
        ((time.seconds as f64 + time.frac) * 1000.0) as u64
    });
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| AnalyzeError::Failed(e.to_string()))?;

    let mut sr: u32 = 0;
    let mut channels: usize = 1;
    let mut mono: Vec<f32> = Vec::new();
    let mut capped = false;
    loop {
        match probed.format.next_packet() {
            Ok(packet) => match decoder.decode(&packet) {
                Ok(decoded) => {
                    let spec = *decoded.spec();
                    if sr == 0 {
                        sr = spec.rate;
                        channels = spec.channels.count().max(1);
                    }
                    let frames = decoded.frames();
                    let max_in = (ANALYZE_MS as usize * sr as usize) / 1000;
                    let wanted = if mono.len() >= max_in {
                        0
                    } else {
                        (max_in - mono.len()).min(frames)
                    };
                    let mut sb = SampleBuffer::<f32>::new(frames as u64, spec);
                    sb.copy_interleaved_ref(decoded);
                    let samples = sb.samples();
                    for f in 0..wanted {
                        let base = f * channels;
                        let mut acc = 0.0f32;
                        for c in 0..channels {
                            let s = samples[base + c];
                            acc += if s.is_finite() { s } else { 0.0 };
                        }
                        mono.push(acc / channels as f32);
                    }
                    if mono.len() >= max_in {
                        capped = true;
                        break;
                    }
                }
                // 坏帧跳过（与播放后端 cpal_backend 同策略），ResetRequired 复位。
                Err(SymError::DecodeError(_)) => {}
                Err(_) => break,
            },
            Err(SymError::ResetRequired) => {
                decoder.reset();
            }
            Err(_) => break,
        }
    }
    if sr == 0 || mono.is_empty() {
        return Err(AnalyzeError::Failed("decoded no audio samples".into()));
    }
    let decoded_ms = (mono.len() as u64 * 1000) / sr as u64;
    let duration_ms = header_ms.unwrap_or(if capped { ANALYZE_MS + 1 } else { decoded_ms });
    analyze_mono(&mono, sr, duration_ms)
}

/// PCM 单声道 f32（采样率 in_rate）→ 节拍地图。时长由调用方给出（用于选分析率
/// 与推演判定），可以长于实际样本（边下边播场景不会走到这里，解码路径给头时长）。
pub fn analyze_mono(mono: &[f32], in_rate: u32, duration_ms: u64) -> Result<BeatMap, AnalyzeError> {
    if mono.is_empty() || in_rate == 0 {
        return Err(AnalyzeError::Failed("empty pcm".into()));
    }
    if mono.iter().any(|s| !s.is_finite()) {
        return Err(AnalyzeError::Failed("non-finite pcm".into()));
    }
    let out_rate = if duration_ms >= LONG_MS { LOW_RATE } else { HIGH_RATE };
    let mut pcm = resample_linear(mono, in_rate, out_rate);
    let max_out = (ANALYZE_MS as usize * out_rate as usize) / 1000;
    if pcm.len() > max_out {
        pcm.truncate(max_out);
    }
    let analyzed_ms = (pcm.len() as u64 * 1000) / out_rate as u64;
    if pcm.len() < WINDOW {
        return Err(AnalyzeError::Unsupported("audio too short".into()));
    }
    let n_frames = (pcm.len() - WINDOW) / HOP + 1;

    // Hann 窗 + 26 个 mel 三角带（30Hz .. min(8kHz, 奈奎斯特 95%)），mel 均匀。
    let mut hann = vec![0f32; WINDOW];
    for (i, h) in hann.iter_mut().enumerate() {
        *h = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (WINDOW as f32 - 1.0)).cos();
    }
    let edges = mel_edges(out_rate as f32 * 0.5);
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(WINDOW);
    let mut scratch = vec![Complex::new(0f32, 0f32); WINDOW];
    let mut spectrum = vec![0f32; WINDOW / 2 + 1];
    let mut prev_band = vec![0f32; MEL_BANDS];
    let mut flux = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let start = f * HOP;
        for i in 0..WINDOW {
            scratch[i] = Complex::new(pcm[start + i] * hann[i], 0.0);
        }
        fft.process(&mut scratch);
        for i in 0..=WINDOW / 2 {
            spectrum[i] = scratch[i].norm();
        }
        let mut band = vec![0f32; MEL_BANDS];
        for (b, win) in edges.windows(3).enumerate() {
            let (l, c, r) = (win[0], win[1], win[2]);
            let i0 = ((l * WINDOW as f32) / out_rate as f32).floor() as usize;
            let i1 = (((r * WINDOW as f32) / out_rate as f32).ceil() as usize).min(WINDOW / 2);
            for i in i0..=i1 {
                let hz = i as f32 * out_rate as f32 / WINDOW as f32;
                let w = if hz <= c {
                    if c > l {
                        ((hz - l) / (c - l)).max(0.0)
                    } else {
                        0.0
                    }
                } else if r > c {
                    ((r - hz) / (r - c)).max(0.0)
                } else {
                    0.0
                };
                band[b] += spectrum[i] * w;
            }
        }
        let mut pos = 0f32;
        for b in 0..MEL_BANDS {
            let d = band[b] - prev_band[b];
            if d > 0.0 {
                pos += d;
            }
            prev_band[b] = band[b];
        }
        flux.push(pos);
    }

    // 局部均值归一（±300ms）得到 onset 包络。
    let radius = ((300u32.saturating_mul(out_rate)) / (HOP as u32 * 1000)).max(4) as usize;
    let mut env = vec![0f32; n_frames];
    for i in 0..n_frames {
        let lo = i.saturating_sub(radius);
        let hi = (i + radius + 1).min(n_frames);
        let sum: f32 = flux[lo..hi].iter().sum();
        let mean = sum / (hi - lo) as f32;
        env[i] = flux[i] / (mean + 1e-6);
    }

    // 峰值：局部极大 + 局部中值自适应阈值 + 200ms 最小间隔（按强度贪心选取）。
    let gap_frames = ((200u32 * out_rate + HOP as u32 * 1000 - 1) / (HOP as u32 * 1000))
        .max(1) as usize;
    let mut cands: Vec<(usize, f32)> = Vec::new();
    for i in 1..n_frames.saturating_sub(1) {
        if env[i] > env[i - 1] && env[i] >= env[i + 1] {
            let mlo = i.saturating_sub(radius * 2);
            let mhi = (i + radius * 2 + 1).min(n_frames);
            let mut window: Vec<f32> = env[mlo..mhi].to_vec();
            window.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let med = window[window.len() / 2];
            if env[i] >= med * 1.35 + 0.25 {
                cands.push((i, env[i]));
            }
        }
    }
    cands.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let mut chosen_idx: Vec<(usize, f32)> = Vec::new();
    for (i, v) in cands {
        if chosen_idx
            .iter()
            .all(|(j, _)| (*j as isize - i as isize).unsigned_abs() >= gap_frames)
        {
            chosen_idx.push((i, v));
        }
    }
    chosen_idx.sort_by_key(|(i, _)| *i);
    if chosen_idx.is_empty() {
        return Err(AnalyzeError::Unsupported("no beats detected".into()));
    }

    // strength 按本曲峰高的 20/98 分位归一到 0..1。
    let mut vals: Vec<f32> = chosen_idx.iter().map(|(_, v)| *v).collect();
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let lo = percentile_sorted(&vals, 0.20);
    let hi = percentile_sorted(&vals, 0.98);
    let span = (hi - lo).max(1e-3);
    let times: Vec<i64> = chosen_idx
        .iter()
        .map(|(i, _)| {
            (*i as i64 * HOP as i64 * 1000 + out_rate as i64 / 2) / out_rate as i64
        })
        .collect();
    let strengths: Vec<f32> = chosen_idx
        .iter()
        .map(|(_, v)| ((*v - lo) / span).clamp(0.0, 1.0))
        .collect();

    let bpm = estimate_bpm(&times, &env, out_rate);

    // downbeat：前 8 拍里取最强峰为第 0 拍（并列取第一拍），之后每 4 拍。
    let anchor_window = chosen_idx.len().min(8);
    let mut anchor = 0;
    let mut anchor_v = -1f32;
    for i in 0..anchor_window {
        if strengths[i] > anchor_v {
            anchor_v = strengths[i];
            anchor = i;
        }
    }

    // intensity：前后 2 拍 strength 均值的 33/66 分位四档。
    let mut means = Vec::with_capacity(chosen_idx.len());
    for i in 0..chosen_idx.len() {
        let lo_i = i.saturating_sub(2);
        let hi_i = (i + 3).min(chosen_idx.len());
        means.push(strengths[lo_i..hi_i].iter().sum::<f32>() / (hi_i - lo_i) as f32);
    }
    let mut sorted_means = means.clone();
    sorted_means.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q33 = percentile_sorted(&sorted_means, 0.33);
    let q66 = percentile_sorted(&sorted_means, 0.66);
    let q85 = percentile_sorted(&sorted_means, 0.85);

    let mut beats: Vec<Beat> = Vec::with_capacity(chosen_idx.len());
    for (i, t) in times.iter().enumerate() {
        let mean = means[i];
        let intensity = if mean >= q85 {
            3
        } else if mean >= q66 {
            2
        } else if mean >= q33 {
            1
        } else {
            0
        };
        beats.push(Beat {
            t: *t,
            strength: strengths[i],
            downbeat: (i as isize - anchor as isize).rem_euclid(4) == 0,
            intensity,
        });
    }

    // 超 720s：按 BPM 周期推演（strength=近 8 拍均值、intensity 沿用末值）。
    let mut truncated = duration_ms > analyzed_ms;
    if truncated {
        if let Some(bpm_v) = bpm {
            let period = (60_000.0 / bpm_v).round() as i64;
            if (333..=1000).contains(&period) {
                // 推演拍强度取近 8 拍（不足取全部）均值。
                let tail = &beats[beats.len().saturating_sub(8)..];
                let avg8 = tail.iter().map(|b| b.strength).sum::<f32>() / tail.len() as f32;
                let last_intensity = beats.last().map(|b| b.intensity).unwrap_or(0);
                let mut t = beats.last().map(|b| b.t).unwrap_or(0);
                while t + period <= duration_ms as i64 && beats.len() < 30_000 {
                    t += period;
                    let idx = beats.len() as isize;
                    beats.push(Beat {
                        t,
                        strength: avg8.clamp(0.0, 1.0),
                        downbeat: (idx - anchor as isize).rem_euclid(4) == 0,
                        intensity: last_intensity,
                    });
                }
            } else {
                truncated = false;
            }
        } else {
            // 无 BPM 无法推演：截断部分没有合法补点，不声称 truncated。
            truncated = false;
        }
    }

    Ok(BeatMap {
        version: MAP_VERSION,
        bpm,
        offset_ms: 0,
        truncated,
        beats,
    })
}

/// 线性重采样（比值任意）。采样率相同时原样返回，省一次拷贝。
fn resample_linear(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
    if in_rate == out_rate {
        return input.to_vec();
    }
    let n_out = (input.len() as u64 * out_rate as u64 / in_rate as u64) as usize;
    let mut out = Vec::with_capacity(n_out);
    for i in 0..n_out {
        let pos = i as f64 * in_rate as f64 / out_rate as f64;
        let i0 = pos.floor() as usize;
        let frac = pos - i0 as f64;
        let i1 = (i0 + 1).min(input.len() - 1);
        out.push((input[i0] as f64 * (1.0 - frac) + input[i1] as f64 * frac) as f32);
    }
    out
}

fn mel_edges(nyquist: f32) -> Vec<f32> {
    let f_lo = 30f32;
    let f_hi = 8000f32.min(nyquist * 0.95);
    let mel = |f: f32| 2595.0 * (1.0 + f / 700.0).log10();
    let hz = |m: f32| 700.0 * (10f32.powf(m / 2595.0) - 1.0);
    let m0 = mel(f_lo);
    let m1 = mel(f_hi);
    (0..MEL_BANDS + 2)
        .map(|i| hz(m0 + (m1 - m0) * i as f32 / (MEL_BANDS + 1) as f32))
        .collect()
}

fn percentile_sorted(sorted: &[f32], q: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f32 * q).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// BPM 粗估：峰间隔三角加权直方图（333..1000ms）+ ×1.6 显著性门；
/// 精修：在粗估 lag ±8% 内对 onset 包络做自相关，抛物线插值取连续周期
/// （hop 量化约 23/46ms，整数毫秒中位数会偏到整档，插值消除该量化误差）。
fn estimate_bpm(times: &[i64], env: &[f32], out_rate: u32) -> Option<f64> {
    if times.len() < 8 {
        return None;
    }
    let intervals: Vec<f64> = times
        .windows(2)
        .map(|w| (w[1] - w[0]) as f64)
        .filter(|d| (333.0..=1000.0).contains(d))
        .collect();
    if intervals.len() < 8 {
        return None;
    }
    let mut hist = vec![0f64; 1001];
    for d in &intervals {
        for (b, h) in hist.iter_mut().enumerate().take(1001).skip(333) {
            let w = (1.0 - (d - b as f64).abs() / 15.0).max(0.0);
            *h += w;
        }
    }
    let (best, score) = hist
        .iter()
        .enumerate()
        .skip(333)
        .take(668)
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())?;
    let mean: f64 = hist[333..=1000].iter().sum::<f64>() / 668.0;
    if *score < mean * 1.6 {
        return None;
    }

    // 自相关精修：粗周期换算成帧 lag，±8% 内找自相关最大整数 lag，
    // 再用相邻三点抛物线插值得到亚帧周期。
    let hop_ms = HOP as f64 * 1000.0 / out_rate as f64;
    let lag0 = best as f64 / hop_ms;
    let lo_lag = (lag0 * 0.92).ceil().max(1.0) as usize;
    let hi_lag = (lag0 * 1.08).floor() as usize;
    let hi_lag = hi_lag.min(env.len().saturating_sub(1));
    if hi_lag < lo_lag {
        return Some(60_000.0 / best as f64);
    }
    let acf = |lag: usize| -> f64 {
        let n = env.len() - lag;
        if n == 0 {
            return 0.0;
        }
        let mut s = 0.0f64;
        for i in 0..n {
            s += env[i] as f64 * env[i + lag] as f64;
        }
        s / n as f64
    };
    let mut peak_lag = lo_lag;
    let mut peak_v = f64::MIN;
    for lag in lo_lag..=hi_lag {
        let v = acf(lag);
        if v > peak_v {
            peak_v = v;
            peak_lag = lag;
        }
    }
    let mut refined = peak_lag as f64;
    if peak_lag > 0 && peak_lag + 1 < env.len() {
        let rm = acf(peak_lag - 1);
        let rp = acf(peak_lag + 1);
        let denom = rm - 2.0 * peak_v + rp;
        if denom < 0.0 {
            let delta = 0.5 * (rm - rp) / denom;
            if (-1.0..=1.0).contains(&delta) {
                refined += delta;
            }
        }
    }
    let period = refined * hop_ms;
    if !(333.0..=1000.0).contains(&period) {
        return Some(60_000.0 / best as f64);
    }
    Some(60_000.0 / period)
}
```

- [ ] **1.4 验证**

`cargo fmt --all; cargo test -p vmusic-beats`（8 测试全绿）；`cargo clippy --workspace --all-targets -- -D warnings`。

- [ ] **1.5 Commit**

```
git --no-pager add Cargo.toml crates/vmusic-beats/Cargo.toml crates/vmusic-beats/src/lib.rs
git --no-pager commit -m "feat(beats): 新增离线节拍分析 crate vmusic-beats"
```

---

# 任务 2：beatmap 缓存、幂等表与播放提交后调度（stage_beats.rs）

## Files

- Create: `crates/vmusicd/src/stage_beats.rs`
- Modify: `crates/vmusicd/Cargo.toml` L19 后
- Modify: `crates/vmusicd/src/main.rs` L16（mod）、L122-141（AppState 构造 + weak_self 注入，L142 后）
- Modify: `crates/vmusicd/src/state.rs` L155 后（字段）、L158 impl 内（stage_beats_dir）、L842-851（on_track_committed detach）

## Steps

- [ ] **2.1 vmusicd 依赖**

`crates/vmusicd/Cargo.toml` L19 `vmusic-lyrics = { workspace = true }` 后加：

```toml
vmusic-beats = { workspace = true }
```

- [ ] **2.2 写失败测试：缓存键/mtime/幂等状态机（临时目录，不构造 AppState）**

创建 `crates/vmusicd/src/stage_beats.rs`，先放以下骨架与测试（编译失败：缺 `read_cache`/`table_decide` 等实现）：

```rust
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 节拍地图缓存与后台调度：data/stage-beats/<sha1>.json + 进程内幂等任务表。
//!
//! 两个触发源（播放提交 detach、GET 兜底）共用同一张表，同一缓存键全局只有
//! 一个分析任务；分析跑在 spawn_blocking，不随切歌取消，失败只记进程内态，
//! 下次播放允许重试一次。

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("vmusic-beats-test-{}-{}-{}", std::process::id(), n, tag));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mtime_ms(p: &Path) -> i64 {
        std::fs::metadata(p).unwrap().modified().unwrap()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
    }

    fn sample_map() -> BeatMap {
        BeatMap {
            version: 1,
            bpm: Some(120.0),
            offset_ms: 0,
            truncated: false,
            beats: vec![Beat { t: 100, strength: 0.5, downbeat: true, intensity: 1 }],
        }
    }

    #[test]
    fn local_key_is_stable_and_absolute_only() {
        let p = PathBuf::from(r"C:\Music\a b.flac");
        let k1 = local_cache_key(&p).unwrap();
        let k2 = local_cache_key(&PathBuf::from("C:/Music/a b.flac")).unwrap();
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 40, "sha1 hex");
        assert!(local_cache_key(Path::new("relative.flac")).is_none());
        // 在线曲用虚拟 id 原文哈希。
        assert_eq!(online_cache_key("online:qq:123").len(), 40);
        assert_ne!(online_cache_key("online:qq:123"), online_cache_key("online:qq:124"));
    }

    #[tokio::test]
    async fn cache_hit_misses_on_mtime_change_and_corrupt_or_empty() {
        let dir = tmp_dir("mtime");
        let file = dir.join("a.flac");
        std::fs::write(&file, b"x").unwrap();
        let cache = dir.join("m.json");
        write_cache(&cache, &sample_map(), mtime_ms(&file), 1).await.unwrap();
        assert!(read_cache(&cache, mtime_ms(&file), 1).await.is_some());
        // 长度与 mtime 任一不符即失效（FAT 2 秒 mtime 粒度下的兜底）。
        assert!(read_cache(&cache, mtime_ms(&file), 999).await.is_none());
        assert!(read_cache(&cache, mtime_ms(&file), 1).await.is_some());
        // mtime 变化（这里模拟：改写缓存里的 source_mtime_ms）即失效。
        let mut bytes = std::fs::read(&cache).unwrap();
        let mut v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        v["source_mtime_ms"] = serde_json::json!(mtime_ms(&file) - 5000);
        bytes = serde_json::to_vec(&v).unwrap();
        std::fs::write(&cache, bytes).unwrap();
        assert!(read_cache(&cache, mtime_ms(&file), 1).await.is_none());
        // 坏 JSON。
        std::fs::write(&cache, b"{nope").unwrap();
        assert!(read_cache(&cache, mtime_ms(&file), 1).await.is_none());
    }

    #[test]
    fn idempotent_table_decisions() {
        let mut t: HashMap<String, TaskState> = HashMap::new();
        // 首次：建任务。
        assert!(matches!(table_decide(&mut t, "k", false), Action::Spawn));
        assert!(matches!(t.get("k"), Some(TaskState::Analyzing)));
        // 在途：等待。
        assert!(matches!(table_decide(&mut t, "k", false), Action::Wait));
        // 失败：GET 不重试，播放（retry）重试。
        t.insert("k".into(), TaskState::Failed(Reason::Failed));
        assert!(matches!(
            table_decide(&mut t, "k", false),
            Action::Fail(Reason::Failed)
        ));
        assert!(matches!(table_decide(&mut t, "k", true), Action::Spawn));
        // unsupported 不与 failed 混淆。
        t.insert("u".into(), TaskState::Failed(Reason::Unsupported));
        assert!(matches!(
            table_decide(&mut t, "u", false),
            Action::Fail(Reason::Unsupported)
        ));
        // Ready 但磁盘文件没了（被外部删/LRU）：重开任务。
        t.insert("r".into(), TaskState::Ready(PathBuf::from("r.json")));
        assert!(matches!(table_decide(&mut t, "r", false), Action::Spawn));
    }
}
```

- [ ] **2.3 完整实现 stage_beats.rs（测试模块保留在文件末尾）**

在 2.2 骨架的 `mod tests` 之前插入以下全部代码：

```rust
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha1::{Digest, Sha1};

use vmusic_beats::{Beat, BeatMap};

use crate::state::{AppState, WsEvent};

/// 幂等表里一格的状态。
#[derive(Debug, Clone)]
pub(crate) enum TaskState {
    Analyzing,
    Ready(PathBuf),
    Failed(Reason),
}

/// 404 reason（tier0 由客户端自行兜底，服务端保留枚举以对齐协议）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason {
    /// tier0 由客户端按性能档位自行回落，服务端保留枚举对齐 404 reason 协议。
    #[allow(dead_code)]
    Tier0,
    Failed,
    Unsupported,
    NotReady,
}

impl Reason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Reason::Tier0 => "tier0",
            Reason::Failed => "failed",
            Reason::Unsupported => "unsupported",
            Reason::NotReady => "not_ready",
        }
    }
}

/// 请求结果：Ready 携带地图与是否命中磁盘缓存。
pub(crate) enum Outcome {
    Ready { map: BeatMap, cached: bool },
    Analyzing,
    Unavailable(Reason),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Spawn,
    Wait,
    Fail(Reason),
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CachedMap {
    version: u32,
    bpm: Option<f64>,
    offset_ms: i64,
    truncated: bool,
    beats: Vec<Beat>,
    source_mtime_ms: i64,
    source_len: u64,
}

struct AudioRef {
    path: PathBuf,
    mtime_ms: i64,
    len: u64,
    key: String,
}

/// 播放提交触发（on_track_committed）：失败态允许重试一次。
pub(crate) fn spawn_after_commit(state: Arc<AppState>, track_id: String) {
    tokio::spawn(async move {
        let _ = request(&state, &track_id, true).await;
    });
}

/// GET 触发：失败态在本曲目播放期内不重试。
pub(crate) async fn request_on_demand(state: &Arc<AppState>, track_id: &str) -> Outcome {
    request(state, track_id, false).await
}

async fn request(state: &Arc<AppState>, track_id: &str, retry_failed: bool) -> Outcome {
    let Some(audio) = resolve_audio(state, track_id).await else {
        return Outcome::Unavailable(Reason::NotReady);
    };
    let cache_file = state.stage_beats_dir().join(format!("{}.json", audio.key));
    if let Some(map) = read_cache(&cache_file, audio.mtime_ms, audio.len).await {
        state
            .stage_beats
            .lock()
            .await
            .insert(audio.key.clone(), TaskState::Ready(cache_file.clone()));
        return Outcome::Ready { map, cached: true };
    }
    let action = {
        let mut table = state.stage_beats.lock().await;
        table_decide(&mut table, &audio.key, retry_failed)
    };
    match action {
        Action::Wait => Outcome::Analyzing,
        Action::Fail(r) => Outcome::Unavailable(r),
        Action::Spawn => {
            spawn_blocking_analysis(state.clone(), track_id.to_string(), audio);
            Outcome::Analyzing
        }
    }
}

/// 纯状态机：磁盘未命中后，幂等表如何决策。Ready 态在此出现只可能是
/// 缓存文件被删/mtime 变了（调用方已先查磁盘），重开任务。
pub(crate) fn table_decide(
    table: &mut HashMap<String, TaskState>,
    key: &str,
    retry_failed: bool,
) -> Action {
    match table.entry(key.to_string()) {
        Entry::Vacant(e) => {
            e.insert(TaskState::Analyzing);
            Action::Spawn
        }
        Entry::Occupied(e) => match e.get() {
            TaskState::Analyzing => Action::Wait,
            TaskState::Ready(_) => {
                *e.into_mut() = TaskState::Analyzing;
                Action::Spawn
            }
            TaskState::Failed(r) => {
                if retry_failed {
                    *e.into_mut() = TaskState::Analyzing;
                    Action::Spawn
                } else {
                    Action::Fail(*r)
                }
            }
        },
    }
}

async fn resolve_audio(state: &Arc<AppState>, track_id: &str) -> Option<AudioRef> {
    if let Some((source, id)) = crate::online::split_virtual_id(track_id) {
        // 在线曲：只认下载完成 rename 后的正式缓存（find_cached_by_key 跳过
        // .part 且要求 >1024 字节）。未完成不分析、不轮询、不挂 rename。
        let quality = {
            let prefs = state.quality.lock().await;
            crate::online::quality::get(&prefs, &source)
        };
        let path = crate::online::cache::find_cached_by_key(
            &state.online_cache_dir(),
            &source,
            &id,
            quality.as_str(),
        )
        .await?;
        let key = online_cache_key(track_id);
        audio_ref(path, key).await
    } else {
        let track = vmusic_store::get_track(&state.db, &track_id.to_string())
            .await
            .ok()
            .flatten()?;
        let path = PathBuf::from(track.path);
        let key = local_cache_key(&path)?;
        audio_ref(path, key).await
    }
}

async fn audio_ref(path: PathBuf, key: String) -> Option<AudioRef> {
    let meta = tokio::fs::metadata(&path).await.ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some(AudioRef { path, mtime_ms, len: meta.len(), key })
}

/// 本地曲键：sha1(规范化绝对路径)。walkdir 入库的路径已是绝对、无 . / ..，
/// 这里统一分隔符并去尾斜杠，保证同库同键。
pub(crate) fn local_cache_key(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let s = path.to_str()?.replace('\\', "/");
    let s = s.trim_end_matches('/').trim_end_matches('.');
    if s.is_empty() {
        None
    } else {
        Some(sha1_hex(s.as_bytes()))
    }
}

/// 在线曲键：sha1(虚拟 track_id 原文)。
pub(crate) fn online_cache_key(track_id: &str) -> String {
    sha1_hex(track_id.as_bytes())
}

fn sha1_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut s = String::with_capacity(40);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// 读缓存：mtime 或长度不一致 / 坏 JSON / 空 beats 均视为未命中。
pub(crate) async fn read_cache(
    file: &Path,
    source_mtime_ms: i64,
    source_len: u64,
) -> Option<BeatMap> {
    let bytes = tokio::fs::read(file).await.ok()?;
    let cached: CachedMap = serde_json::from_slice(&bytes).ok()?;
    if cached.source_mtime_ms != source_mtime_ms
        || cached.source_len != source_len
        || cached.beats.is_empty()
    {
        return None;
    }
    Some(BeatMap {
        version: cached.version,
        bpm: cached.bpm,
        offset_ms: cached.offset_ms,
        truncated: cached.truncated,
        beats: cached.beats,
    })
}

/// 原子落盘：同目录 .tmp + rename。
pub(crate) async fn write_cache(
    file: &Path,
    map: &BeatMap,
    source_mtime_ms: i64,
    source_len: u64,
) -> std::io::Result<()> {
    let body = CachedMap {
        version: map.version,
        bpm: map.bpm,
        offset_ms: map.offset_ms,
        truncated: map.truncated,
        beats: map.beats.clone(),
        source_mtime_ms,
        source_len,
    };
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let tmp = file.with_extension("tmp");
    // 序列化失败沿 io::Result 走调用方“落盘失败 → mark_failed(Failed)”臂，
    // 不 panic：否则任务表项会永久停在 Analyzing。
    let bytes = serde_json::to_vec(&body).map_err(std::io::Error::other)?;
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, file).await
}

fn spawn_blocking_analysis(state: Arc<AppState>, track_id: String, audio: AudioRef) {
    tokio::spawn(async move {
        let AudioRef { path, key, mtime_ms, len } = audio;
        let joined = tokio::task::spawn_blocking(move || vmusic_beats::analyze_path(&path)).await;
        match joined {
            Ok(Ok(map)) => {
                if map.beats.is_empty() {
                    mark_failed(&state, &key, Reason::Unsupported).await;
                    return;
                }
                let cache_file = state.stage_beats_dir().join(format!("{key}.json"));
                match write_cache(&cache_file, &map, mtime_ms, len).await {
                    Ok(()) => {
                        state
                            .stage_beats
                            .lock()
                            .await
                            .insert(key, TaskState::Ready(cache_file));
                        state.publish(WsEvent::BeatmapReady {
                            track_id,
                            bpm: map.bpm,
                            beats_n: map.beats.len(),
                        });
                    }
                    Err(e) => {
                        tracing::warn!("beatmap 缓存落盘失败: {e}");
                        mark_failed(&state, &key, Reason::Failed).await;
                    }
                }
            }
            Ok(Err(vmusic_beats::AnalyzeError::Unsupported(_))) => {
                mark_failed(&state, &key, Reason::Unsupported).await;
            }
            Ok(Err(vmusic_beats::AnalyzeError::Failed(e))) => {
                tracing::debug!("beatmap 分析失败 {track_id}: {e}");
                mark_failed(&state, &key, Reason::Failed).await;
            }
            Err(e) => {
                tracing::warn!("beatmap 分析任务异常: {e}");
                mark_failed(&state, &key, Reason::Failed).await;
            }
        }
    });
}

async fn mark_failed(state: &Arc<AppState>, key: &str, reason: Reason) {
    // 终态防污染：已是 Ready（迟到的成功先落表）不被失败回调反向覆盖；
    // Analyzing 或键不存在时落 Failed。
    let mut table = state.stage_beats.lock().await;
    if !matches!(table.get(key), Some(TaskState::Ready(_))) {
        table.insert(key.to_string(), TaskState::Failed(reason));
    }
}
```

- [ ] **2.4 state.rs 接线**

L9-10 `use std::sync::Arc;` 已有；在 state.rs 中：

1. L155 `quality` 字段后加两个字段：

```rust
    /// 逐源音质偏好（启动时从 settings 装载、POST 热切换即时更新）。
    pub(crate) quality: Mutex<crate::online::quality::QualityPrefs>,
    /// 节拍分析幂等表：缓存键 → 任务态。
    pub(crate) stage_beats: Mutex<HashMap<String, crate::stage_beats::TaskState>>,
    /// 启动后由 main 注入 Weak：on_track_committed 只有 &self，detach
    /// 'static 任务时凭它拿回 Arc（不改 play_index/step 的签名链）。
    pub(crate) weak_self: std::sync::OnceLock<std::sync::Weak<AppState>>,
```

2. L159-161 `cover_dir()` 后面（impl 块内）加：

```rust
    pub(crate) fn stage_beats_dir(&self) -> PathBuf {
        self.data_dir.join("stage-beats")
    }
```

3. L842-851 `on_track_committed` 末尾（`let _ = actual;` 之后、闭合括号前）加 detach：

```rust
        // 节拍分析：成功起播后后台 detach，覆盖手动点播/重播/在线播放/自动接力
        // 四条提交路径（committed 是唯一收口）。不 await、不阻塞播放链路。
        if let Some(arc) = self.weak_self.get().and_then(std::sync::Weak::upgrade) {
            crate::stage_beats::spawn_after_commit(arc, track_id.to_string());
        }
```

4. WsEvent BeatmapReady 变体（由任务 3.2 提前至本任务落地）：state.rs 中 `Buffering` 变体后、`LibraryChanged` 前插入，供 `spawn_blocking_analysis` 成功后 `state.publish` 广播：

```rust
    /// 节拍地图后台分析完成：前端仅当 track_id 仍是当前播放曲时拉取。
    /// bpm 低置信为 None，字段整体不序列化。
    BeatmapReady {
        track_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        bpm: Option<f64>,
        beats_n: usize,
    },
```

- [ ] **2.5 main.rs 接线**

1. L16 `mod scan;` 后、L17 `mod state;` 前插入：

```rust
mod stage_beats;
```

2. AppState 构造（L140 `quality: tokio::sync::Mutex::new(quality_prefs),` 后、L141 `});` 前）加：

```rust
        stage_beats: Default::default(),
        weak_self: Default::default(),
```

3. L142 `spawn_event_pump(state.clone());` 前插入 Weak 注入：

```rust
    // 供 on_track_committed detach 'static 后台任务用；set 失败只可能是
    // 重复注入，启动路径只走一次，忽略即可。
    let _ = state.weak_self.set(std::sync::Arc::downgrade(&state));
```

- [ ] **2.6 验证**

`cargo fmt --all; cargo clippy --workspace --all-targets -- -D warnings; cargo test --workspace`（新 3 测试（含 1 个 tokio 测试）全绿；workspace 全量合计 204 测试不回归）。8 个 check 脚本此时不涉及前端，应保持全绿。

- [ ] **2.7 Commit**

```
git --no-pager add crates/vmusicd/Cargo.toml crates/vmusicd/src/stage_beats.rs crates/vmusicd/src/state.rs crates/vmusicd/src/main.rs
git --no-pager commit -m "feat(stage): 节拍地图缓存与播放提交后后台调度"
```

---

# 任务 3：beatmap REST 三态 + WS beatmap_ready + 前端事件分支

## Files

- Modify: `crates/vmusicd/src/routes.rs` L119 后（路由）、handler 追加（文件末尾或 health 附近）
- Modify: `crates/vmusicd/src/state.rs` L59 `Buffering` 变体后、L60 `LibraryChanged` 前
- Modify: `crates/vmusicd/src/ws.rs` L137 后（精确 JSON 断言）
- Modify: `crates/vmusicd/web/app.js` L399 `buffering` case 后（WS 分支）

## Steps

- [ ] **3.1 写失败测试：BeatmapReady 精确序列化**

`crates/vmusicd/src/ws.rs` 的 `data_carrying_events_serialise_with_a_type_tag` 测试末尾（L147 `assert!(json.contains("\"index\":2"));` 之后、测试函数闭合 `}` 前）加：

```rust
        // beatmap_ready：bpm=None 时字段必须整体缺席（不是 null）。
        let json = serde_json::to_string(&WsEvent::BeatmapReady {
            track_id: "online:qq:42".into(),
            bpm: Some(128.4),
            beats_n: 412,
        })
        .unwrap();
        assert_eq!(
            json,
            "{\"type\":\"beatmap_ready\",\"track_id\":\"online:qq:42\",\"bpm\":128.4,\"beats_n\":412}"
        );
        let json = serde_json::to_string(&WsEvent::BeatmapReady {
            track_id: "t1".into(),
            bpm: None,
            beats_n: 0,
        })
        .unwrap();
        assert_eq!(
            json,
            "{\"type\":\"beatmap_ready\",\"track_id\":\"t1\",\"beats_n\":0}"
        );
        assert!(!json.contains("bpm"));
```

跑 `cargo test -p vmusicd --lib ws::` 确认编译失败（无该变体）。

- [ ] **3.2 WsEvent 变体**

> 注：该变体已随任务 2 提前落地（见任务 2 Step 2.4 第 4 点），执行任务 3 时跳过本步。

state.rs L59 `Buffering {...},` 与 L60 `LibraryChanged,` 之间插入：

```rust
    /// 节拍地图后台分析完成：前端仅当 track_id 仍是当前播放曲时拉取。
    /// bpm 低置信为 None，字段整体不序列化。
    BeatmapReady {
        track_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        bpm: Option<f64>,
        beats_n: usize,
    },
```

注意必须是命名 struct 变体（internal tag 表示法不允许 newtype，见 L25-28 注释）。

- [ ] **3.3 REST 路由**

routes.rs L119 `.route("/v1/online/account", get(online_account))` 之后、L120 `.layer(...)` 之前加一行：

```rust
        // 节拍地图：200 完整地图 / 202 分析中 / 404 不可用（前端静默回落 onset）。
        .route("/v1/stage/beatmap", get(beatmap))
```

在 routes.rs 中 `health` handler 附近（同文件内任选 handler 间隙，建议放在 `// -----` 分区注释后）追加：

```rust
// ---------------------------------------------------------------------------
// 舞台节拍地图
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(super) struct BeatmapQuery {
    track: String,
}

/// 三态响应手写状态码与 JSON 体：404 体是 `{status,reason}` 而不是标准
/// ApiError 的 `{error}`，前端按 err.status / body.status 分流，不弹错。
async fn beatmap(
    State(state): State<Arc<AppState>>,
    Query(q): Query<BeatmapQuery>,
) -> Response {
    match crate::stage_beats::request_on_demand(&state, &q.track).await {
        crate::stage_beats::Outcome::Ready { map, cached } => {
            let mut value = serde_json::to_value(&map).unwrap_or(serde_json::Value::Null);
            if let Some(obj) = value.as_object_mut() {
                obj.insert("cached".into(), serde_json::Value::Bool(cached));
            }
            (StatusCode::OK, Json(value)).into_response()
        }
        crate::stage_beats::Outcome::Analyzing => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "status": "analyzing" })),
        )
            .into_response(),
        crate::stage_beats::Outcome::Unavailable(reason) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "status": "unavailable",
                "reason": reason.as_str(),
            })),
        )
            .into_response(),
    }
}
```

（`Deserialize`/`Query`/`State`/`StatusCode`/`IntoResponse`/`Response`/`Json`/`Arc` 均已在 routes.rs L8-18 imports 中，无需新增 use。）

- [ ] **3.4 app.js WS 分支**

app.js `handleEvent` 的 `buffering` case（L391-399）之后、L400 `default: break;` 前加：

```js
    case 'beatmap_ready':
      // 服务端后台分析完成：是否拉取由 StageCinema 自己按当前曲目判断。
      if (window.StageCinema && StageCinema.onBeatmapReady) StageCinema.onBeatmapReady(msg);
      break;
```

- [ ] **3.5 验证**

`cargo fmt --all; cargo clippy --workspace --all-targets -- -D warnings; cargo test --workspace`。

手工烟测（可选，执行审查时做）：启动 `.\target\debug\vmusicd.exe --data-dir <tmp> --port 18901`，带 Bearer token `GET /v1/stage/beatmap?track=<库中不存在id>` 应返回 404 `{"status":"unavailable","reason":"not_ready"}`（track 查不到 → NotReady）。

- [ ] **3.6 Commit**

```
git --no-pager add crates/vmusicd/src/routes.rs crates/vmusicd/src/state.rs crates/vmusicd/src/ws.rs crates/vmusicd/web/app.js
git --no-pager commit -m "feat(stage): beatmap REST 三态与 WS beatmap_ready 事件"
```

---

# 任务 4：creative-gl roll 通道 + creative-stage camLayers 总线

## Files

- Modify: `crates/vmusicd/web/creative-gl.js`（L67-76 后新增 rollView；L1093 矩阵缓存；L1171-1182 相机段）
- Modify: `crates/vmusicd/web/creative-stage.js`（L171 模块状态；L806-835 renderOne 相机段；api2 L1448 附近）

## Steps

- [ ] **4.1 creative-gl：矩阵缓存与 rollView**

L1093：

```js
    var proj = mat4(), view = mat4(), viewProj = mat4();
```

改为：

```js
    var proj = mat4(), view = mat4(), viewProj = mat4(), rollM = mat4(), rolled = mat4();
```

在 `mul` 函数之后（L67-76 区块之后）新增顶层函数：

```js
// 相机滚转：lookAt 之后视线在视图空间指向 -Z，对视图矩阵左乘 Rz
// 等价于绕相机前向轴旋转（若在世界轴上转，机位本身会被甩偏）。
// scratch 为调用方持有的矩阵缓存，避免每帧分配。
function rollView(out, scratch, viewMat, rollRad) {
  var c = Math.cos(rollRad), s = Math.sin(rollRad);
  scratch[0] = c;  scratch[1] = s;  scratch[2] = 0;  scratch[3] = 0;
  scratch[4] = -s; scratch[5] = c;  scratch[6] = 0;  scratch[7] = 0;
  scratch[8] = 0;  scratch[9] = 0;  scratch[10] = 1; scratch[11] = 0;
  scratch[12] = 0; scratch[13] = 0; scratch[14] = 0; scratch[15] = 1;
  mul(out, scratch, viewMat);
  return out;
}
```

- [ ] **4.2 creative-gl：render 相机段消费 cam.roll**

L1180-1182：

```js
      perspective(proj, cam.fov * Math.PI / 180, w / h, 0.1, 400);
      lookAt(view, eye[0], eye[1], eye[2], cam.tx, cam.ty, cam.tz, 0, 1, 0);
      mul(viewProj, proj, view);
```

改为：

```js
      perspective(proj, cam.fov * Math.PI / 180, w / h, 0.1, 400);
      lookAt(view, eye[0], eye[1], eye[2], cam.tx, cam.ty, cam.tz, 0, 1, 0);
      // roll 缺省 0：除电影/自由相机外所有调用方不传即完全等价旧路径。
      if (cam.roll) {
        rollView(rolled, rollM, view, cam.roll);
        mul(viewProj, proj, rolled);
      } else {
        mul(viewProj, proj, view);
      }
```

- [ ] **4.3 creative-stage：模块级层总线**

L171 `var views = [];` 那一行之后插入：

```js
  // 相机层总线：每帧按 priority 升序调用（cinema=10 / focus peek=20 /
  // freecam=30）。层函数只改 ctx，基线/ shake/漂移在层外统一收口。
  var camLayers = [];
```

- [ ] **4.4 creative-stage：renderOne 构造 ctx 并收口**

L806-818（`// --- 相机 ---` 到 `var dist = ...` 那段）整体替换为：

```js
    // --- 相机：基线 → camLayers（cinema/peek/freecam）→ 漂移 → shake ---
    stepInteraction(dtMs);
    var driftBase = readPath(runtime, 'cam.drift') / 100;
    driftPhase += dtMs / 1000 * 0.12 * driftBase;
    cam.shakeYaw *= Math.exp(-dtMs / 130);
    cam.shakePitch *= Math.exp(-dtMs / 130);

    var ctx = {
      t: t,
      dtMs: dtMs,
      scene: preset.scene,
      play: document.body.classList.contains('is-playing'),
      readPath: function (p) { return readPath(runtime, p); },
      // 基线（preset/滑块/导演），层函数读它但不改它。
      baseYawDeg: readPath(runtime, 'cam.yaw'),
      basePitchDeg: readPath(runtime, 'cam.pitch'),
      baseDist: readPath(runtime, 'cam.dist'),
      baseFov: readPath(runtime, 'cam.fov'),
      baseHeight: readPath(runtime, 'cam.height'),
      // 层输出：cinema 乘 fov/dist/加 roll；peek/freecam 直接覆盖机位。
      yawDeg: readPath(runtime, 'cam.yaw'),
      pitchDeg: readPath(runtime, 'cam.pitch'),
      dist: readPath(runtime, 'cam.dist'),
      fov: readPath(runtime, 'cam.fov'),
      tx: 0,
      ty: readPath(runtime, 'cam.height'),
      tz: 0,
      rollDeg: 0,
      // 漂移倍率（cinema 在 intensity 3 时抬到 1.4；freecam 置 0）。
      driftMul: 1,
      // 自由相机全开标志（目前只作观测，不参与合成分支）。
      freecam: false
    };
    for (var li = 0; li < camLayers.length; li += 1) {
      try { camLayers[li].fn(ctx); } catch (e) { /* 单层抛错不能拖垮帧循环 */ }
    }

    var drift = driftBase * ctx.driftMul;
    var yaw = (ctx.yawDeg * Math.PI / 180)
      + Math.sin(driftPhase) * 0.22 * drift + cam.shakeYaw + interact.parYaw;
    var pitch = clamp((ctx.pitchDeg * Math.PI / 180)
      + Math.sin(driftPhase * 0.73 + 1.1) * 0.10 * drift + cam.shakePitch + interact.parPitch, -1.35, 1.35);
    // agg kick 是基线音频响应，对所有层生效；near plane 0.1，dist 不得贴到 0.3 以下。
    var dist = Math.max(0.3, ctx.dist
      * (1 - agg[0] * 0.06 * (readPath(runtime, 'cam.kick') / 100)));
```

L833-835 的 cam 对象替换为：

```js
      cam: { yaw: yaw, pitch: pitch, dist: dist,
        fov: ctx.fov,
        tx: ctx.tx, ty: ctx.ty, tz: ctx.tz,
        roll: ctx.rollDeg * Math.PI / 180 },
```

- [ ] **4.5 creative-stage：api2 暴露注册口**

api2 末尾 L1448 `onChange: onChange` 改为：

```js
    onChange: onChange,

    // 相机层注册。priority 小者先执行；同 fn 不重复注册。
    addCamLayer: function (fn, priority) {
      if (typeof fn !== 'function') return;
      if (camLayers.some(function (x) { return x.fn === fn; })) return;
      camLayers.push({ fn: fn, p: priority == null ? 100 : priority });
      camLayers.sort(function (a, b) { return a.p - b.p; });
    },
    removeCamLayer: function (fn) {
      for (var i = 0; i < camLayers.length; i += 1) {
        if (camLayers[i].fn === fn) { camLayers.splice(i, 1); return; }
      }
    },
    // 自由相机等需要完全屏蔽舞台原生拖拽/点击爆闪/滚轮/双击的场景注册；
    // fn 返回 true 时 bindInteraction 各入口早退。传 null 解除。
    setInteractionBlocker: function (fn) {
      interactionBlocker = typeof fn === 'function' ? fn : null;
    }
```

- [ ] **4.6 验证**

`node scripts\check-creative.js`（几百帧参数链全部有限值；cam 新增 roll 字段后解析链不回归）；8 个 check 全绿；cargo 门不受影响但仍全量跑一次。

- [ ] **4.7 Commit**

```
git --no-pager add crates/vmusicd/web/creative-gl.js crates/vmusicd/web/creative-stage.js
git --no-pager commit -m "feat(stage): 相机 roll 通道与 camLayers 层总线"
```

---

# 任务 5：电影相机纯时间轴模块 + Node 测试

## Files

- Create: `crates/vmusicd/web/stage-cinema.js`（本任务只放纯函数 IIFE，任务 6 追加驱动 IIFE）
- Create: `scripts/check-stage-cinema.js`

## Steps

- [ ] **5.1 创建 stage-cinema.js 纯模块**

完整内容：

```js
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 电影相机的纯时间轴：rAF 外推时钟、单调游标 / seek 重定位、一帧多拍取最强、
// 确定性节拍包络。不依赖 DOM/GL，Node 可直接 require（check-stage-cinema.js）。
// 浏览器侧的驱动 IIFE 在本文件后半段（任务 6 追加），消费这里导出的
// window.StageCinemaPure。

(function (global) {
  'use strict';

  var ROLL_LIMIT = 25;          // 度，与自由相机共享同一个物理上限
  var RELOCK_MS = 150;          // 本地外推与服务端位置漂移超过它就硬对齐
  var SEEK_TOL_MS = 60;         // seek 落点 ±60ms 内的拍不补发
  var ATTACK_MS = 28;           // 节拍起振
  var DOWN_FOV_MIN = 0.94;      // 强拍 fov 收缩底
  var DOWN_DIST_MIN = 0.975;    // 强拍 dist punch 底
  var DOWN_ROLL_MAX = 1.2;      // 强拍 roll 幅度（度）
  var DOWN_FOV_MS = 320;
  var DOWN_ROLL_MS = 420;
  var BEAT_FOV_MIN = 0.975;     // 普通拍 fov 收缩底
  var BEAT_FOV_MS = 140;
  var BEAT_ROLL_MAX = 0.5;
  var BEAT_ROLL_GATE = 0.8;     // 普通拍 strength 超过它才带 roll

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }

  function lowerBound(beats, t) {
    var lo = 0, hi = beats.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (beats[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // 高精度播放时间：服务端 position_ms（约 30Hz）锚点 + 两次 rAF 间按
  // performance.now 外推（速率恒 1.0）。暂停时冻结在锚点。
  function createClock() {
    return { seeded: false, anchorPos: 0, anchorClock: 0, playing: false };
  }

  function pt(clock, clockMs) {
    if (!clock.seeded) return 0;
    return clock.playing ? clock.anchorPos + (clockMs - clock.anchorClock) : clock.anchorPos;
  }

  // 状态帧重锚。返回 true = 硬对齐（首帧 / seek / 漂移 >150ms），
  // 调用方要把拍游标重定位到新位置（历史拍不补发）。
  function reanchor(clock, posMs, clockMs, playing) {
    var hard = !clock.seeded || Math.abs(pt(clock, clockMs) - posMs) > RELOCK_MS;
    clock.anchorPos = posMs;
    clock.anchorClock = clockMs;
    clock.playing = !!playing;
    clock.seeded = true;
    return hard;
  }

  // 拍游标：cursor 是「下一个尚未消费的拍」在 beats 里的下标。
  function createTimeline(map) { return { map: map, cursor: 0 }; }

  // 地图晚到 / 换曲 / seek：从 nowMs 之后开始，落点 ±60ms 内的拍不补放。
  function relocate(tl, nowMs) {
    tl.cursor = lowerBound(tl.map.beats, nowMs + SEEK_TOL_MS + 1);
  }

  // 消费 (prevPt, nowPt] 区间。正常推进返回区间内 strength 最大的一拍
  // （一帧多拍只取最强，长帧/seek 后不连发）；检测到倒退（>60ms）二分
  // 重定位并返回 null。
  function advance(tl, prevPt, nowPt) {
    var beats = tl.map.beats;
    if (nowPt < prevPt - SEEK_TOL_MS) {
      tl.cursor = lowerBound(beats, nowPt + SEEK_TOL_MS + 1);
      return null;
    }
    var i = tl.cursor;
    while (i < beats.length && beats[i].t <= prevPt) i += 1;
    var picked = null;
    while (i < beats.length && beats[i].t <= nowPt) {
      if (!picked || beats[i].strength > picked.strength) picked = beats[i];
      i += 1;
    }
    tl.cursor = i;
    return picked;
  }

  // 确定性包络。sign 为该拍的交替方向（调用方按下标奇偶给 ±1）；
  // params = { punch: 用户冲击强度倍率（已含 peek 压制）, tunnel: 是否近机位 }。
  // 返回 { fovMul, distMul, rollDeg }，超过 DOWN_ROLL_MS 或 dt<0 都是单位元。
  function envelope(beat, nowMs, sign, params) {
    var identity = { fovMul: 1, distMul: 1, rollDeg: 0 };
    var dt = nowMs - beat.t;
    if (dt < 0 || dt > DOWN_ROLL_MS) return identity;
    var punch = params && params.punch != null ? params.punch : 1;
    var amp = punch * (beat.intensity === 3 ? 1.5 : 1);
    var strong = !!beat.downbeat;
    var fovMin = strong ? DOWN_FOV_MIN : BEAT_FOV_MIN;
    var fovLen = strong ? DOWN_FOV_MS : BEAT_FOV_MS;

    // 0..28ms 线性起振，之后 ease-out 回收（fov/dist 用 fovLen，roll 用自己的长度）。
    var attackK = dt <= ATTACK_MS ? dt / ATTACK_MS : 1;
    var eFov = dt <= ATTACK_MS ? 0 : easeOutCubic(clamp((dt - ATTACK_MS) / fovLen, 0, 1));
    var out = {
      fovMul: 1 - (1 - fovMin) * amp * attackK * (1 - eFov),
      distMul: 1,
      rollDeg: 0
    };
    if (strong) {
      var tunnel = params && params.tunnel ? 0.5 : 1;
      out.distMul = 1 - (1 - DOWN_DIST_MIN) * amp * tunnel * attackK * (1 - eFov);
      var eRoll = easeOutCubic(clamp((dt - ATTACK_MS) / DOWN_ROLL_MS, 0, 1));
      out.rollDeg = clamp(sign * DOWN_ROLL_MAX * amp * attackK * (1 - eRoll), -ROLL_LIMIT, ROLL_LIMIT);
    } else if (beat.strength > BEAT_ROLL_GATE) {
      var eBeat = easeOutCubic(clamp((dt - ATTACK_MS) / BEAT_FOV_MS, 0, 1));
      out.rollDeg = clamp(sign * BEAT_ROLL_MAX * amp * attackK * (1 - eBeat), -ROLL_LIMIT, ROLL_LIMIT);
    }
    return out;
  }

  var api = {
    ROLL_LIMIT: ROLL_LIMIT,
    SEEK_TOL_MS: SEEK_TOL_MS,
    createClock: createClock,
    pt: pt,
    reanchor: reanchor,
    createTimeline: createTimeline,
    relocate: relocate,
    advance: advance,
    envelope: envelope,
    lowerBound: lowerBound
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.StageCinemaPure = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
```

- [ ] **5.2 创建 scripts/check-stage-cinema.js（纯函数断言 + roll 通道契约）**

```js
#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 电影相机无头检查：
//   1) 时间轴纯函数（外推时钟 / 重锚 / 单调游标 / seek 重定位 / 多拍取最强 / 包络）；
//   2) 跨文件契约（roll 通道、层总线与优先级、协议分支、互斥与降级常量）。
//
//   node scripts/check-stage-cinema.js

'use strict';

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'crates', 'vmusicd', 'web');
const P = require(path.join(WEB, 'stage-cinema.js'));

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  ✗ ' + label); }
}
function section(name) { console.log('\n' + name); }
function approx(a, b, eps) { return Math.abs(a - b) <= eps; }
function read(file) { return fs.readFileSync(path.join(WEB, file), 'utf8'); }

function makeMap(beatSpec) {
  return {
    version: 1, bpm: 120, offset_ms: 0, truncated: false,
    beats: beatSpec.map(function (b, i) {
      return { t: b[0], strength: b[1], downbeat: !!b[2], intensity: b[3] || (i % 4 === 0 ? 2 : 1) };
    })
  };
}

section('时间轴：外推时钟');
{
  const c = P.createClock();
  ok(P.pt(c, 999) === 0, '未锚定时钟恒为 0');
  const hard1 = P.reanchor(c, 1000, 500, true);
  ok(hard1 === true, '首帧锚定是硬对齐');
  ok(P.pt(c, 750) === 1250, '播放中按本地时钟外推');
  P.reanchor(c, 1300, 800, true);
  ok(P.pt(c, 800) === 1300, '状态帧到达即重锚');
  ok(P.reanchor(c, 2000, 900, false) === false, '小幅偏差不是硬对齐');
  ok(P.pt(c, 1000) === 2000, '暂停时冻结在锚点');
  ok(P.reanchor(c, 5000, 1100, true) === true, '漂移 >150ms 触发硬对齐');
}

section('时间轴：游标 / seek / 一帧多拍');
{
  const map = makeMap([[100, 0.3], [200, 0.9], [300, 0.5], [500, 0.7], [560, 0.4]]);
  const tl = P.createTimeline(map);
  const got1 = P.advance(tl, 0, 300);
  ok(got1 && got1.t === 200, '区间多拍取 strength 最大（200@0.9）');
  ok(P.advance(tl, 300, 400) === null, '已消费区间不重复发拍');
  const got2 = P.advance(tl, 400, 600);
  ok(got2 && got2.t === 500, '后续区间继续推进');

  const tl2 = P.createTimeline(makeMap([[1000, 0.5], [5000, 0.6], [5050, 0.9], [5100, 0.4]]));
  ok(P.advance(tl2, 0, 200).t === 1000, '正常区间拍点');
  ok(P.advance(tl2, 200, 30000) === null, 'seek 后硬跳不补发区间拍（由 relocate 负责）');

  const tl3 = P.createTimeline(makeMap([[1000, 0.5], [2000, 0.6]]));
  P.relocate(tl3, 5000);
  ok(P.advance(tl3, 5000, 6000) === null, '地图晚到/重定位后历史拍不补放');

  const tl4 = P.createTimeline(makeMap([[1000, 0.5], [1500, 0.6], [2000, 0.7]]));
  P.advance(tl4, 0, 1600);
  ok(P.advance(tl4, 1600, 900) === null, '倒退 seek 重定位且不补发');
  ok(P.advance(tl4, 900, 2010) && tl4.cursor >= 3, '重定位后未来拍仍可继续推进');
}

section('节拍包络');
{
  const down = { t: 1000, strength: 0.9, downbeat: true, intensity: 2 };
  const weak = { t: 1000, strength: 0.95, downbeat: false, intensity: 1 };
  const weakSoft = { t: 1000, strength: 0.5, downbeat: false, intensity: 1 };

  const e0 = P.envelope(down, 990, 1, {});
  ok(e0.fovMul === 1 && e0.distMul === 1 && e0.rollDeg === 0, '拍前是单位元');
  const attack = P.envelope(down, 1028, 1, { punch: 1 });
  ok(approx(attack.fovMul, 0.94, 0.005), '强拍起振底 fov×0.94');
  ok(approx(attack.distMul, 0.975, 0.005), '强拍 dist×0.975');
  ok(approx(attack.rollDeg, 1.2, 0.005), '强拍 roll +1.2°');
  ok(P.envelope(down, 1028, -1, {}).rollDeg < 0, '相邻方向交替取负');
  const back = P.envelope(down, 1420, 1, {});
  ok(approx(back.fovMul, 1, 0.01) && approx(back.rollDeg, 0, 0.01), '收束段回到基线');

  const w = P.envelope(weak, 1028, 1, {});
  ok(approx(w.fovMul, 0.975, 0.005), '普通拍 fov×0.975');
  ok(w.distMul === 1, '普通拍无 dist punch');
  ok(approx(w.rollDeg, 0.5, 0.005), 'strength>0.8 普通拍带 ±0.5° roll');
  const ws = P.envelope(weakSoft, 1028, 1, {});
  ok(ws.rollDeg === 0, 'strength≤0.8 普通拍无 roll');

  const hot = P.envelope({ t: 1000, strength: 0.9, downbeat: true, intensity: 3 }, 1028, 1, {});
  ok(approx(hot.fovMul, 1 - 0.06 * 1.5, 0.005), 'intensity 3 幅度 ×1.5');
  const tuned = P.envelope(down, 1028, 1, { punch: 0.5 });
  ok(approx(tuned.fovMul, 1 - 0.06 * 0.5, 0.005), 'cinePunch 等比缩放');
  const tunnel = P.envelope(down, 1028, 1, { punch: 1, tunnel: true });
  ok(approx(tunnel.distMul, 1 - 0.025 * 0.5, 0.005), 'tunnel 近机位 dist punch 折半');
  const capped = P.envelope({ t: 0, strength: 1, downbeat: true, intensity: 3 }, 14, 1, { punch: 2 });
  ok(Math.abs(capped.rollDeg) <= P.ROLL_LIMIT, 'roll 受 ±25° 钳制');
}

section('跨文件契约：roll 通道');
{
  const gl = read('creative-gl.js');
  const stage = read('creative-stage.js');
  ok(/function rollView\b/.test(gl), 'creative-gl 定义 rollView');
  ok(/cam\.roll/.test(gl), 'render 相机段消费 cam.roll');
  ok(/addCamLayer/.test(stage) && /removeCamLayer/.test(stage), 'creative-stage 暴露层总线 API');
  ok(/var camLayers = \[\]/.test(stage), 'camLayers 模块状态存在');
  ok(/roll: ctx\.rollDeg \* Math\.PI \/ 180/.test(stage), 'ctx.rollDeg 以弧度进 cam.roll');
  ok(/cam\.shakeYaw/.test(stage) && /ctx\.yawDeg[\s\S]*cam\.shakeYaw|cam\.shakeYaw[\s\S]*ctx\.yawDeg/.test(stage),
    'shake 在层结果之后最后叠加');
}

console.log(`\n${failures === 0 ? 'OK' : 'FAIL'}: ${checks - failures}/${checks} 通过`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **5.3 验证**

`node scripts\check-stage-cinema.js` 全绿；`Get-ChildItem scripts\check-*.js | ForEach-Object { node $_.FullName }` 全部通过（新脚本被 glob 自动纳入）。

- [ ] **5.4 Commit**

```
git --no-pager add crates/vmusicd/web/stage-cinema.js scripts/check-stage-cinema.js
git --no-pager commit -m "feat(stage): 电影相机纯时间轴模块与无头检查"
```

---

# 任务 6：stage-cinema 驱动（接 gate / cine 组开关 / beatmap 拉取 / 换曲）+ 资源接线

## Files

- Modify: `crates/vmusicd/web/stage-cinema.js`（追加驱动 IIFE）
- Modify: `crates/vmusicd/web/stage-control.js`（SCHEMA L132 global 组前插 cine 组；push L239 旁跳过）
- Modify: `scripts/check-stage-control.js` L169-170（cine 组事件消费白名单）
- Modify: `crates/vmusicd/src/main.rs`（L65 后 include；L185 后路由）
- Modify: `crates/vmusicd/web/index.html`（L890 后 script）
- Modify: `scripts/check-assets.js` L126 附近 REQUIRE_BEFORE
- Modify: `crates/vmusicd/web/app.js`（L702 后 onTrack；L707 后 onSnapshot；L2573 后 init）
- Modify: `scripts/check-stage-cinema.js`（追加驱动契约）

## Steps

- [ ] **6.1 stage-control：cine 组**

L132 `{ id: 'global', ... }` 对象之前插入：

```js
    {
      id: 'cine',
      title: '电影镜头',
      // 这一组不落任何 CSS 变量：由 stage-cinema.js / stage-freecam.js 监听
      // stagecontrol:change 事件直接消费（push() 对 cine 组整体跳过）。
      items: [
        { key: 'cinema', label: '电影镜头', type: 'toggle', def: true },
        { key: 'cinePunch', label: '冲击强度', min: 0, max: 200, step: 5, unit: '%', def: 100, wide: true },
        // 真正的键鼠操控在 stage-freecam.js；perfTier 0 时该模块隐藏本开关。
        { key: 'freecam', label: '自由相机', type: 'toggle', def: false }
      ]
    },
```

push() 中 L239 `if (g.id === 'global' && it.key === 'intensity') return;` 之后加：

```js
        // cine 组只走事件，不写 --fx-cine-* 脏变量。
        if (g.id === 'cine') return;
```

- [ ] **6.2 check-stage-control 白名单**

L169-170：

```js
      const viaEvent = (g.id === 'motion' ||
        (g.id === 'lyrics' && it.key === 'beatAmp')) && consumedByEvent(it.key);
```

改为：

```js
      const viaEvent = (g.id === 'motion' || g.id === 'cine' ||
        (g.id === 'lyrics' && it.key === 'beatAmp')) && consumedByEvent(it.key);
```

- [ ] **6.3 stage-cinema.js：追加驱动 IIFE**

在文件末尾（第一个 IIFE 之后）追加：

```js

// ---------------------------------------------------------------------------
// 浏览器驱动：经 CreativeStage.addCamLayer 挂进唯一 rAF；持有 beatmap 会话、
// 时钟重锚与三态（absent → waiting → active）。Node 下 window 不存在，整段跳过。
// ---------------------------------------------------------------------------
(function (global) {
  'use strict';
  if (typeof window === 'undefined' || !global.StageCinemaPure) return;
  var P = global.StageCinemaPure;
  var URL = '/v1/stage/beatmap?track=';

  var s = {
    trackId: null,
    mode: 'absent',        // absent（onset 兜底/未请求/tier0）| waiting（202）| active
    map: null,
    clock: P.createClock(),
    tl: null,
    lastPt: 0,
    beat: null,
    cinemaOn: true,
    cinePunch: 100,
    freecamOn: false,
    peek: false,
    seq: 0,
    inited: false
  };

  function now() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function tier0() { return !!(global.Stage && Stage.tier && Stage.tier() === 0); }

  function onControls(v) {
    if (!v) return;
    // detail 是 values 快照：缺键保持默认，不被 undefined 覆盖。
    if (typeof v.cinema === 'boolean') s.cinemaOn = v.cinema;
    if (typeof v.cinePunch === 'number') s.cinePunch = v.cinePunch;
    if (typeof v.freecam === 'boolean') s.freecamOn = v.freecam;
  }

  function activate(map) {
    s.map = map;
    s.tl = P.createTimeline(map);
    s.lastPt = P.pt(s.clock, now());
    // 地图就绪晚于起播：只从当前 pt 开始，已过去的拍不补放。
    P.relocate(s.tl, s.lastPt);
    s.beat = null;
    s.mode = 'active';
  }

  function requestMap(trackId) {
    var transport = global.VMusicTransport;
    if (!transport || !transport.get || tier0()) { s.mode = 'absent'; return; }
    var seq = ++s.seq;
    s.mode = 'waiting';
    transport.get(URL + encodeURIComponent(trackId)).then(function (body) {
      if (seq !== s.seq || trackId !== s.trackId) return;
      if (body && body.status === 'analyzing') { s.mode = 'waiting'; return; }
      if (body && body.beats && body.beats.length) activate(body);
      else s.mode = 'absent';
    }, function () {
      // 404（failed/unsupported/not_ready）与网络错都静默回落 onset；
      // 不轮询：分析完成有 beatmap_ready 事件，下次播放也会重新触发。
      if (seq === s.seq && trackId === s.trackId) s.mode = 'absent';
    });
  }

  function onTrack(trackId) {
    s.trackId = trackId || null;
    s.map = null;
    s.tl = null;
    s.beat = null;
    s.clock = P.createClock();
    s.lastPt = 0;
    s.mode = 'absent';
    if (trackId && !tier0()) requestMap(trackId);
  }

  function onSnapshot(snap) {
    if (!snap) return;
    var hard = P.reanchor(s.clock, snap.position_ms | 0, now(), !!snap.playing);
    if (hard && s.tl) {
      var p = P.pt(s.clock, now());
      P.relocate(s.tl, p);
      s.lastPt = p;
      s.beat = null;
    }
  }

  function onBeatmapReady(msg) {
    if (!msg || msg.track_id !== s.trackId) return;
    if (s.mode === 'active') return;
    requestMap(s.trackId);
  }

  function layer(ctx) {
    if (tier0()) { s.mode = 'absent'; return; }
    // 时间轴每帧推进（freecam 开也照常推进，只是不应用包络——关掉 freecam
    // 立刻无缝续上）。
    if (s.mode === 'active' && s.tl) {
      var p = P.pt(s.clock, ctx.t);
      if (p < s.lastPt - P.SEEK_TOL_MS) P.relocate(s.tl, p);
      var picked = P.advance(s.tl, s.lastPt, p);
      s.lastPt = p;
      if (picked) s.beat = picked;
      if (s.beat && p - s.beat.t > 420) s.beat = null;
    }
    // resolve 优先级：freecam 全覆盖（drift 也停）；peek 把包络幅度压到 30%。
    if (s.freecamOn) { ctx.driftMul = 0; return; }
    if (!s.cinemaOn || s.mode !== 'active' || !s.beat) return;
    var idx = P.lowerBound(s.map.beats, s.beat.t);
    var sign = idx % 2 === 0 ? 1 : -1;
    var env = P.envelope(s.beat, P.pt(s.clock, ctx.t), sign, {
      punch: (s.cinePunch / 100) * (s.peek ? 0.3 : 1),
      tunnel: ctx.baseDist < 5
    });
    ctx.fov *= env.fovMul;
    ctx.dist *= env.distMul;
    ctx.rollDeg += env.rollDeg;
    if (s.beat.intensity === 3) ctx.driftMul = 1.4;
  }

  function init() {
    if (s.inited) return;
    s.inited = true;
    if (global.CreativeStage && CreativeStage.addCamLayer) CreativeStage.addCamLayer(layer, 10);
    document.addEventListener('stagecontrol:change', function (e) { onControls(e.detail); });
    if (global.StageControl && StageControl.values) onControls(StageControl.values());
    document.addEventListener('stage:fps', function (e) {
      // tier 只降不升：降到 0 立即停包络（onset 现状行为保留）。
      if (e.detail && e.detail.lowfx) s.mode = 'absent';
    });
  }

  global.StageCinema = {
    init: init,
    onTrack: onTrack,
    onSnapshot: onSnapshot,
    onBeatmapReady: onBeatmapReady,
    setFreecam: function (on) { s.freecamOn = !!on; },
    setPeek: function (on) { s.peek = !!on; },
    mode: function () { return s.mode; },
    _pure: P
  };
  init();
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **6.4 app.js 钩子]**

1. applySnapshot 换曲分支 L702 `loadNowPlaying(snap.track_id);` 之后加：

```js
    // Stage 不暴露当前 track_id（私有变量），换曲由这里显式通知电影相机。
    if (window.StageCinema) StageCinema.onTrack(snap.track_id);
```

2. L707 `if (Stage) Stage.setSnapshot(snap);` 之后加：

```js
  if (window.StageCinema) StageCinema.onSnapshot(snap);
```

3. initCreative L2573 `if (window.CreativeStage) CreativeStage.init();` 之后加：

```js
  if (window.StageCinema) StageCinema.init();
```

- [ ] **6.5 资源接线（仅 cinema；freecam/focus 在各自任务接线，保证每提交可编译）**

main.rs L65 `const WORKSHOP_JS ...` 之后：

```rust
// 舞台相机三件套（电影 → 自由 → 焦点），顺序与 camLayers priority 一致。
const STAGE_CINEMA_JS: &str = include_str!("../web/stage-cinema.js");
```

main.rs L185 workshop 路由之后（L186 qrcode 之前）：

```rust
        .route("/stage-cinema.js", get(|| asset(JS, STAGE_CINEMA_JS)))
```

index.html L890 `<script src="workshop.js"></script>` 之后：

```html
<!-- 节拍电影相机：纯时间轴 + 驱动（消费 /v1/stage/beatmap） -->
<script src="stage-cinema.js"></script>
```

check-assets.js REQUIRE_BEFORE L126 `['creative-stage.js', 'workshop.js'],` 之后加：

```js
  ['creative-stage.js', 'stage-cinema.js'],   // cinema 注册 camLayers 依赖编排层 API
```

- [ ] **6.6 check-stage-cinema.js 追加驱动契约**

在最终 `console.log(...)` 之前插入：

```js
section('跨文件契约：驱动 / 协议 / 开关');
{
  const cinema = read('stage-cinema.js');
  const control = read('stage-control.js');
  const app = read('app.js');
  const main = fs.readFileSync(path.join(__dirname, '..', 'crates', 'vmusicd', 'src', 'main.rs'), 'utf8');
  const html = read('index.html');

  ok(cinema.indexOf("'absent'") >= 0 && cinema.indexOf("'waiting'") >= 0 && cinema.indexOf("'active'") >= 0,
    '三态 absent/waiting/active 存在');
  ok(/\/v1\/stage\/beatmap\?track=/.test(cinema), 'beatmap 请求 URL');
  ok(/addCamLayer\(layer, 10\)/.test(cinema), 'cinema 以 priority 10 注册');
  ok(/Stage\.tier\(\) === 0/.test(cinema), 'tier0 不请求/不驱动');
  ok(/stagecontrol:change/.test(cinema) && /detail/.test(cinema), '消费控制面板事件');
  ok(/v\.cinema|detail\.cinema/.test(cinema) && /cinePunch/.test(cinema) && /freecam/.test(cinema),
    'cine 三键被读取');
  ok(/setPeek/.test(cinema) && /0\.3/.test(cinema), 'peek 压制系数 0.3');
  ok(/baseDist < 5/.test(cinema), 'tunnel 判定基线 dist<5');

  ok(/id: 'cine'/.test(control), 'SCHEMA 含 cine 组');
  ok(/g\.id === 'cine'/.test(control), 'push 跳过 cine 组脏变量');
  ok(/case 'beatmap_ready'/.test(app), 'app.js 分发 beatmap_ready');
  ok(/StageCinema\.onTrack\(snap\.track_id\)/.test(app), '换曲钩子 onTrack');
  ok(/StageCinema\.onSnapshot\(snap\)/.test(app), '快照重锚钩子 onSnapshot');
  ok(/STAGE_CINEMA_JS/.test(main) && /stage-cinema\.js/.test(html), 'cinema 资源内嵌与页面引用');
}
```

- [ ] **6.7 验证**

全量门：`cargo fmt --all; cargo clippy --workspace --all-targets -- -D warnings; cargo test --workspace`；9 个 check 脚本全绿（check-stage-control 验证 cine 三键有真实事件消费方）。

- [ ] **6.8 Commit**

```
git --no-pager add crates/vmusicd/web/stage-cinema.js crates/vmusicd/web/stage-control.js scripts/check-stage-control.js crates/vmusicd/src/main.rs crates/vmusicd/web/index.html scripts/check-assets.js crates/vmusicd/web/app.js scripts/check-stage-cinema.js
git --no-pager commit -m "feat(stage): 电影相机驱动接入帧循环与 cine 控制面板"
```

---

# 任务 7：自由相机 stage-freecam.js（键鼠 / 指针锁定回落 / 互斥飞回 / 持久化 / tier0 隐藏）

## Files

- Create: `crates/vmusicd/web/stage-freecam.js`
- Modify: `crates/vmusicd/web/creative-stage.js`（interactionBlocker 模块变量 + 5 个入口早退；api2 setter 已在任务 4 加入）
- Modify: `crates/vmusicd/src/main.rs`（include + 路由）
- Modify: `crates/vmusicd/web/index.html`（script）
- Modify: `scripts/check-assets.js`（REQUIRE_BEFORE）
- Modify: `crates/vmusicd/web/app.js`（initCreative 加 init）
- Modify: `scripts/check-stage-cinema.js`（追加 freecam 契约）

## Steps

- [ ] **7.1 creative-stage：交互屏蔽钩子落地**

L195 `var cam = {...}` 附近（模块变量区）加：

```js
  // 外部（自由相机）可注册屏蔽判定：返回 true 时舞台原生拖拽/点击爆闪/
  // 滚轮/双击复位全部早退，避免双触发。
  var interactionBlocker = null;
  function blocked(e) { return !!(interactionBlocker && interactionBlocker(e)); }
```

bindInteraction 五个回调入口各插一行：

- pointerdown（L542 回调首行，`if (!interact.on) return;` 之前）：`if (blocked(e)) return;`
- pointermove（L554 回调首行）：`if (blocked(e)) return;`
- pointerup（L577 回调首行）：`if (blocked(e)) return;`
- wheel（L585 回调首行）：`if (blocked(e)) return;`
- dblclick（L593）：回调改为 `function (e) { if (blocked(e)) return; resetView(); }`

- [ ] **7.2 创建 stage-freecam.js**

完整内容：

```js
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 自由相机：cine.freecam 开关开启期间接管全部 5 个场景的相机——
// WASD(+Shift) 水平面平移、画布 click 指针锁定环视（拒绝则按住拖拽回落）、
// Q/E 滚转、K 回正、Esc 退出；关闭时 600ms inout 飞回导演/电影机位。
// 机位存独立 localStorage 键，仅在进入自由模式时恢复，不跨曲自动应用。

(function (global) {
  'use strict';

  var POSE_KEY = 'vmusic.stage.freecam.pose';
  var PRIORITY = 30;             // camLayers：cinema=10 < focus=20 < freecam=30
  var MOVE_SPEED = 0.35;         // ×cam.dist/秒
  var SHIFT_MUL = 2;
  var LOOK_YAW = 0.14;           // 度/px（creative-stage 拖拽 0.28 的一半）
  var LOOK_PITCH = 0.11;         // 度/px（拖拽 0.22 的一半）
  var PITCH_LIMIT = 77;          // 度，与合成端 ±1.35rad 对齐
  var ROLL_SPEED = 40;           // 度/秒
  var ROLL_LIMIT = 25;
  var RETURN_MS = 600;
  var ROLL_RETURN_MS = 260;

  var inited = false;
  var enabled = false;
  var pose = null;               // {yawDeg,pitchDeg,dist,tx,tz,rollDeg}
  var returning = null;          // {start, from}
  var rollBack = null;           // {start, from}
  var keys = {};
  // 移动键显式集合：keys 只保存按下状态。判定必须查 MOVE_CODES，
  // 不能写 hasOwnProperty(keys, code)——空表永不命中，WASD 会整体失效。
  var MOVE_CODES = {
    KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1,
    KeyQ: 1, KeyE: 1, ShiftLeft: 1, ShiftRight: 1
  };
  var locked = false;
  var dragging = false;
  var lastX = 0, lastY = 0;
  var lastT = 0;

  function now() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  function tier0() { return !!(global.Stage && Stage.tier && Stage.tier() === 0); }
  function stageEl() { return document.getElementById('stage'); }

  function loadPose() {
    try {
      var p = JSON.parse(localStorage.getItem(POSE_KEY) || 'null');
      if (p && typeof p.yawDeg === 'number') return p;
    } catch (e) { /* 隐私模式：会话内 pose 变量兜底 */ }
    return null;
  }
  function savePose() {
    if (!pose) return;
    try { localStorage.setItem(POSE_KEY, JSON.stringify(pose)); } catch (e) { /* 同上 */ }
  }

  function syncControl(on) {
    if (global.StageControl && StageControl.set) StageControl.set({ freecam: !!on });
  }
  function updateSwitchVisibility() {
    var sw = document.getElementById('sc-cine-freecam');
    if (sw) sw.style.display = tier0() ? 'none' : '';
  }

  function releaseLock() {
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch (e) { /* 老浏览器无此 API */ }
    locked = false;
  }

  function setEnabled(on, fromEvent) {
    on = !!on;
    if (on) {
      if (tier0() || enabled) return;
      enabled = true;
      returning = null;
      rollBack = null;
      keys = {};
      if (!pose) pose = loadPose();   // 首帧层回调还会用基线兜底
      if (global.StageCinema) StageCinema.setFreecam(true);
      addDomListeners();
      if (!fromEvent) syncControl(true);
      updateSwitchVisibility();
      return;
    }
    if (!enabled && !returning) { if (!fromEvent) syncControl(false); return; }
    enabled = false;
    keys = {};
    dragging = false;
    releaseLock();
    if (global.StageCinema) StageCinema.setFreecam(false);
    removeDomListeners();
    // 600ms inout 飞回；终点在层里逐帧取最新基线（飞回期间导演可能在动）。
    if (pose) returning = { start: now(), from: {
      yawDeg: pose.yawDeg, pitchDeg: pose.pitchDeg, dist: pose.dist,
      tx: pose.tx, tz: pose.tz, rollDeg: pose.rollDeg
    } };
    savePose();
    if (!fromEvent) syncControl(false);
    updateSwitchVisibility();
  }

  function typingTarget(e) {
    var t = e.target;
    return t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName || '');
  }

  function onKeyDown(e) {
    if (!enabled || typingTarget(e)) return;
    if (MOVE_CODES[e.code]) {
      keys[e.code] = true;
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyK') {
      if (pose) rollBack = { start: now(), from: pose.rollDeg };
      e.preventDefault();
    } else if (e.code === 'Escape') {
      setEnabled(false, false);
    }
  }
  function onKeyUp(e) { if (MOVE_CODES[e.code]) keys[e.code] = false; }

  function onPointerDown(e) {
    if (!enabled) return;
    if (e.target && e.target.closest && e.target.closest('button, a, input, select, textarea, .stage-lyrics, .lp-body')) return;
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    // 用户手势里申请指针锁定；被拒绝（权限策略/非安全上下文）也没关系，
    // 按住拖拽（pointermove 回落分支）始终可用。
    var el = stageEl();
    if (el && el.requestPointerLock && !document.pointerLockElement) {
      try {
        var r = el.requestPointerLock();
        if (r && r.catch) r.catch(function () { locked = false; });
      } catch (err) { locked = false; }
    }
  }
  function onPointerUp() { dragging = false; }
  function onMouseMove(e) {
    if (!enabled || !pose) return;
    if (locked && typeof e.movementX === 'number') {
      pose.yawDeg += e.movementX * LOOK_YAW;
      pose.pitchDeg = clamp(pose.pitchDeg + e.movementY * LOOK_PITCH, -PITCH_LIMIT, PITCH_LIMIT);
    } else if (dragging) {
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      pose.yawDeg += dx * LOOK_YAW;
      pose.pitchDeg = clamp(pose.pitchDeg + dy * LOOK_PITCH, -PITCH_LIMIT, PITCH_LIMIT);
    }
  }
  function onLockChange() {
    var el = stageEl();
    locked = !!(el && document.pointerLockElement === el);
  }
  function onLockError() { locked = false; }

  function addDomListeners() {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('pointerlockerror', onLockError);
    var el = stageEl();
    if (el) {
      el.addEventListener('pointerdown', onPointerDown);
      el.addEventListener('pointerup', onPointerUp);
    }
  }
  function removeDomListeners() {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('pointerlockchange', onLockChange);
    document.removeEventListener('pointerlockerror', onLockError);
    var el = stageEl();
    if (el) {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerUp);
    }
  }

  function writePoseToCtx(ctx) {
    ctx.yawDeg = pose.yawDeg;
    ctx.pitchDeg = clamp(pose.pitchDeg, -PITCH_LIMIT, PITCH_LIMIT);
    ctx.dist = Math.max(0.3, pose.dist);
    ctx.tx = pose.tx;
    ctx.tz = pose.tz;
    ctx.ty = ctx.baseHeight;
    ctx.rollDeg = clamp(pose.rollDeg, -ROLL_LIMIT, ROLL_LIMIT);
    ctx.fov = ctx.baseFov;
    ctx.freecam = true;
  }

  function layer(ctx) {
    var dt = lastT ? Math.min(100, ctx.t - lastT) : 16;
    lastT = ctx.t;

    if (returning) {
      var k = clamp((ctx.t - returning.start) / RETURN_MS, 0, 1);
      var e = easeInOut(k);
      var f = returning.from;
      ctx.yawDeg = lerp(f.yawDeg, ctx.baseYawDeg, e);
      ctx.pitchDeg = lerp(f.pitchDeg, ctx.basePitchDeg, e);
      ctx.dist = lerp(f.dist, ctx.baseDist, e);
      ctx.tx = lerp(f.tx, 0, e);
      ctx.tz = lerp(f.tz, 0, e);
      ctx.rollDeg = lerp(f.rollDeg, 0, e);
      ctx.ty = ctx.baseHeight;
      ctx.fov = ctx.baseFov;
      ctx.freecam = true;
      ctx.driftMul = 0;
      if (k >= 1) returning = null;
      return;
    }
    if (!enabled) return;

    ctx.driftMul = 0;
    ctx.freecam = true;
    if (!pose) {
      pose = {
        yawDeg: ctx.baseYawDeg, pitchDeg: ctx.basePitchDeg, dist: ctx.baseDist,
        tx: 0, tz: 0, rollDeg: 0
      };
    }

    // Q/E 滚转（K 回正进行中不叠加）。
    var rollV = (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0);
    if (rollV !== 0) {
      rollBack = null;
      pose.rollDeg = clamp(pose.rollDeg + rollV * ROLL_SPEED * dt / 1000, -ROLL_LIMIT, ROLL_LIMIT);
    } else if (rollBack) {
      var rk = clamp((ctx.t - rollBack.start) / ROLL_RETURN_MS, 0, 1);
      pose.rollDeg = lerp(rollBack.from, 0, easeInOut(rk));
      if (rk >= 1) rollBack = null;
    }

    // WASD：水平面沿 yaw 朝向（eye 向量 x=sin(yaw)、z=cos(yaw)，与 creative-gl 一致）。
    var speed = MOVE_SPEED * pose.dist * ((keys.ShiftLeft || keys.ShiftRight) ? SHIFT_MUL : 1) * dt / 1000;
    var yaw = pose.yawDeg * Math.PI / 180;
    var fx = Math.sin(yaw), fz = Math.cos(yaw);
    var rx = Math.cos(yaw), rz = -Math.sin(yaw);
    var mx = 0, mz = 0;
    if (keys.KeyW) { mx += fx; mz += fz; }
    if (keys.KeyS) { mx -= fx; mz -= fz; }
    if (keys.KeyD) { mx += rx; mz += rz; }
    if (keys.KeyA) { mx -= rx; mz -= rz; }
    if (mx !== 0 || mz !== 0) {
      var ml = Math.hypot(mx, mz);
      pose.tx += (mx / ml) * speed;
      pose.tz += (mz / ml) * speed;
    }

    writePoseToCtx(ctx);
  }

  function init() {
    if (inited) return;
    inited = true;
    if (global.CreativeStage) {
      if (CreativeStage.addCamLayer) CreativeStage.addCamLayer(layer, PRIORITY);
      if (CreativeStage.setInteractionBlocker) {
        CreativeStage.setInteractionBlocker(function () { return enabled || !!returning; });
      }
    }
    document.addEventListener('stagecontrol:change', function (e) {
      if (e.detail && typeof e.detail.freecam === 'boolean') setEnabled(e.detail.freecam, true);
    });
    document.addEventListener('stage:fps', function (e) {
      if (e.detail && e.detail.lowfx) setEnabled(false, false);
      updateSwitchVisibility();
    });
    updateSwitchVisibility();
  }

  global.StageFreecam = {
    init: init,
    isEnabled: function () { return enabled; },
    // 供 focus 等模块查询/联动。
    setEnabled: function (on) { setEnabled(!!on, false); }
  };
  init();
})(typeof window !== 'undefined' ? window : this);
```

上面正文已是最终版：移动键判定一律查顶部的显式集合 `MOVE_CODES`（不要改回 `hasOwnProperty(keys, code)`——`keys` 初始为空表，那种写法永不命中）；setEnabled 中两处 `keys = {}` 只负责清空按下状态，保持不变；layer 中读 `keys.KeyW` 等也不变。

- [ ] **7.3 app.js init**

initCreative 中 `if (window.StageCinema) StageCinema.init();` 之后加：

```js
  if (window.StageFreecam) StageFreecam.init();
```

- [ ] **7.4 资源接线**

main.rs：`STAGE_CINEMA_JS` 常量之后加：

```rust
const STAGE_FREECAM_JS: &str = include_str!("../web/stage-freecam.js");
```

`/stage-cinema.js` 路由之后加：

```rust
        .route("/stage-freecam.js", get(|| asset(JS, STAGE_FREECAM_JS)))
```

index.html：`stage-cinema.js` 的 script 之后加：

```html
<script src="stage-freecam.js"></script>
```

check-assets.js REQUIRE_BEFORE：`['creative-stage.js', 'stage-cinema.js'],` 之后加：

```js
  ['stage-cinema.js', 'stage-freecam.js'],    // freecam 与 cinema 互斥联动
```

- [ ] **7.5 check-stage-cinema.js 追加契约**

```js
section('跨文件契约：自由相机');
{
  const fc = read('stage-freecam.js');
  const stage = read('creative-stage.js');
  const app = read('app.js');
  const html = read('index.html');
  ok(/vmusic\.stage\.freecam\.pose/.test(fc), '机位 localStorage 独立键');
  ok(/addCamLayer\(layer, 30\)/.test(fc), 'freecam 以 priority 30 全覆盖');
  ok(/0\.14/.test(fc) && /0\.11/.test(fc), '指针锁定灵敏度取拖拽一半');
  ok(/requestPointerLock/.test(fc) && /dragging/.test(fc), '指针锁定 + 按住拖拽回落');
  ok(/KeyW/.test(fc) && /KeyQ/.test(fc) && /KeyE/.test(fc) && /KeyK/.test(fc), 'WASD/QE/K 操控');
  ok(/40/.test(fc) && /ROLL_LIMIT = 25/.test(fc), '滚转速度 40°/s、上限 ±25°');
  ok(/RETURN_MS = 600/.test(fc), '关闭 600ms 飞回');
  ok(/Escape/.test(fc) && /setEnabled\(false/.test(fc), 'Esc 退出');
  ok(/stage:fps/.test(fc) && /sc-cine-freecam/.test(fc), 'tier0 退出并隐藏开关');
  ok(/setInteractionBlocker/.test(fc) && /interactionBlocker/.test(stage),
    '屏蔽 creative-stage 原生拖拽/点击/滚轮，防双触发');
  ok(/StageFreecam\.init\(\)/.test(app) && /stage-freecam\.js/.test(html), '初始化与页面引用');
}
```

- [ ] **7.6 验证**

全量门（含 check-creative：blocker 早退不破坏解析链）；浏览器手工验证留到任务 13 真机清单，本任务以契约 + 代码审查为准。

- [ ] **7.7 Commit**

```
git --no-pager add crates/vmusicd/web/stage-freecam.js crates/vmusicd/web/creative-stage.js crates/vmusicd/src/main.rs crates/vmusicd/web/index.html scripts/check-assets.js crates/vmusicd/web/app.js scripts/check-stage-cinema.js
git --no-pager commit -m "feat(stage): 自由相机与指针锁定环视、机位持久化"
```

---

# 任务 8：焦点跟拍 stage-focus.js（歌单架/队列悬停 peek）

## Files

- Create: `crates/vmusicd/web/stage-focus.js`
- Modify: `crates/vmusicd/web/app.js`（L972 后 dataset.trackId；initCreative 加 init）
- Modify: `crates/vmusicd/src/main.rs`（include + 路由）
- Modify: `crates/vmusicd/web/index.html`（script）
- Modify: `scripts/check-assets.js`（REQUIRE_BEFORE）
- Modify: `scripts/check-stage-cinema.js`（追加 focus 契约）

## Steps

- [ ] **8.1 app.js：队列行 trackId（focus 目标识别用）**

L972 `row.dataset.index = String(index);` 之后加：

```js
    row.dataset.trackId = id;
```

- [ ] **8.2 创建 stage-focus.js**

完整内容：

```js
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 焦点跟拍（仅悬停 peek，不锁定）：
// 歌单架卡片 / 播放队列行 hover 120ms 确认 → 260ms out-cubic 飞到看台机位；
// 移出即取消并飞回当前模式机位。freecam 开启 / 触屏无 hover 时不响应；
// 只监听 mouseover/mouseout，不拦截点击与滚轮。

(function (global) {
  'use strict';

  var PRIORITY = 20;             // cinema=10 < focus=20 < freecam=30
  var HOVER_MS = 120;
  var FLIGHT_MS = 260;
  var SHELF_DIST_MUL = 0.55;
  var QUEUE_DIST_MUL = 0.8;
  // 歌单架固定方位（左前方 70°）+ 元素屏幕位置的小偏移；队列是左侧栏方位。
  var SHELF_YAW = 70, SHELF_YAW_SPAN = 18, SHELF_PITCH_BASE = 2, SHELF_PITCH_SPAN = 14;
  var QUEUE_YAW = -72, QUEUE_PITCH = 4;

  var inited = false;
  var hoverTimer = 0;
  var current = null;            // {el, kind:'shelf'|'queue'}
  var flight = null;             // {from, target, start, out, snapped}
  var lastBase = null;           // 最近一次非 peek 帧的基线机位

  function now() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
  function freecamOn() { return !!(global.StageFreecam && StageFreecam.isEnabled && StageFreecam.isEnabled()); }
  function tier0() { return !!(global.Stage && Stage.tier && Stage.tier() === 0); }
  function touchDevice() { return !!(global.matchMedia && matchMedia('(hover: none)').matches); }

  function targetFor(ref, kind) {
    var vw = global.innerWidth || 1, vh = global.innerHeight || 1;
    var r = ref.getBoundingClientRect();
    var nx = ((r.left + r.width / 2) - vw / 2) / (vw / 2);
    var ny = ((r.top + r.height / 2) - vh / 2) / (vh / 2);
    if (kind === 'shelf') {
      return {
        yawDeg: SHELF_YAW + nx * SHELF_YAW_SPAN,
        pitchDeg: SHELF_PITCH_BASE - ny * SHELF_PITCH_SPAN,
        distMul: SHELF_DIST_MUL
      };
    }
    return { yawDeg: QUEUE_YAW, pitchDeg: QUEUE_PITCH, distMul: QUEUE_DIST_MUL };
  }

  function beginPeek(ref) {
    if (!lastBase || freecamOn() || touchDevice()) return;
    flight = {
      from: { yawDeg: lastBase.yawDeg, pitchDeg: lastBase.pitchDeg, dist: lastBase.dist },
      target: targetFor(ref.el, ref.kind),
      start: now(),
      out: false
    };
    if (global.StageCinema) StageCinema.setPeek(true);
  }

  function cancelTimer() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
  }

  function leavePeek() {
    // 进入回程：cinema 幅度立即恢复；回程起点与计时在 layer 的 out 首帧快照
    // （这里没有 ctx，拿不到当前机位）。
    if (flight && !flight.out) {
      flight.out = true;
      flight.snapped = false;
      if (global.StageCinema) StageCinema.setPeek(false);
    }
  }

  function onOver(e) {
    if (tier0() || touchDevice() || freecamOn()) return;
    var card = e.target && e.target.closest ? e.target.closest('.shelf-card') : null;
    var row = null;
    if (!card && e.target && e.target.closest) row = e.target.closest('.q-row');
    var el = card || row;
    if (!el || el.hidden) return;
    var kind = card ? 'shelf' : 'queue';
    if (current && current.el === el) return;
    cancelTimer();
    current = { el: el, kind: kind };
    var ref = current;
    hoverTimer = setTimeout(function () {
      hoverTimer = 0;
      if (current === ref) beginPeek(ref);
    }, HOVER_MS);
  }

  function onOut(e) {
    if (!current) return;
    var to = e.relatedTarget;
    if (to && current.el.contains && current.el.contains(to)) return;
    cancelTimer();
    current = null;
    leavePeek();
  }

  function layer(ctx) {
    // perfTier 0：立即取消进行中的 peek（spec §9），cinema/freecam 各有同级处理。
    if (tier0()) {
      cancelTimer();
      current = null;
      if (flight) {
        flight = null;
        if (global.StageCinema) StageCinema.setPeek(false);
      }
      return;
    }
    if (!flight) {
      lastBase = { yawDeg: ctx.baseYawDeg, pitchDeg: ctx.basePitchDeg, dist: ctx.baseDist };
      return;
    }
    if (freecamOn()) {
      flight = null;
      if (global.StageCinema) StageCinema.setPeek(false);
      return;
    }
    // 回程起点只在 out 第一帧快照一次：时长重新计、k 基于固定 start，
    // 之后绝不再覆盖 from——否则起点每帧重置，ease 永远飞不到基线。
    if (flight.out && !flight.snapped) {
      flight.from = { yawDeg: ctx.yawDeg, pitchDeg: ctx.pitchDeg, dist: ctx.dist };
      flight.start = ctx.t;
      flight.snapped = true;
    }
    var k = clamp((ctx.t - flight.start) / FLIGHT_MS, 0, 1);
    var e = easeOutCubic(k);
    var from = flight.from;
    var toYaw = flight.out ? ctx.baseYawDeg : flight.target.yawDeg;
    var toPitch = flight.out ? ctx.basePitchDeg : flight.target.pitchDeg;
    var toDist = flight.out ? ctx.baseDist : ctx.baseDist * flight.target.distMul;
    ctx.yawDeg = lerp(from.yawDeg, toYaw, e);
    ctx.pitchDeg = lerp(from.pitchDeg, toPitch, e);
    ctx.dist = Math.max(0.3, lerp(from.dist, toDist, e));
    ctx.tx = 0;
    ctx.tz = 0;
    ctx.rollDeg = 0;
    ctx.fov = ctx.baseFov;
    if (k >= 1) flight = null;
  }

  function init() {
    if (inited) return;
    inited = true;
    if (global.CreativeStage && CreativeStage.addCamLayer) {
      CreativeStage.addCamLayer(layer, PRIORITY);
    }
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
  }

  global.StageFocus = {
    init: init,
    isPeeking: function () { return !!flight && !flight.out; }
  };
  init();
})(typeof window !== 'undefined' ? window : this);
```

上面正文已是最终版：回程起点在 layer 的 out 首帧快照一次（`flight.snapped`），`leavePeek` 只翻标志位、不改 start/from（它没有 ctx）；beginPeek 构造新 flight 时不含 snapped，天然支持「飞回途中悬停另一张卡」重新开始。

- [ ] **8.3 app.js init**

initCreative 中 `if (window.StageFreecam) StageFreecam.init();` 之后加：

```js
  if (window.StageFocus) StageFocus.init();
```

- [ ] **8.4 资源接线**

main.rs：`STAGE_FREECAM_JS` 常量之后加：

```rust
const STAGE_FOCUS_JS: &str = include_str!("../web/stage-focus.js");
```

`/stage-freecam.js` 路由之后加：

```rust
        .route("/stage-focus.js", get(|| asset(JS, STAGE_FOCUS_JS)))
```

index.html：`stage-freecam.js` 的 script 之后加：

```html
<script src="stage-focus.js"></script>
```

check-assets.js REQUIRE_BEFORE：`['stage-cinema.js', 'stage-freecam.js'],` 之后加：

```js
  ['stage-cinema.js', 'stage-focus.js'],      // peek 经 cinema setPeek 联动
```

- [ ] **8.5 check-stage-cinema.js 追加契约**

```js
section('跨文件契约：焦点跟拍');
{
  const fc = read('stage-focus.js');
  const app = read('app.js');
  const html = read('index.html');
  ok(/HOVER_MS = 120/.test(fc) && /FLIGHT_MS = 260/.test(fc), 'peek 120ms 确认 / 260ms 飞行');
  ok(/closest\('\.shelf-card'\)/.test(fc), '歌单卡片用 closest 委托识别');
  ok(/closest\('\.q-row'\)/.test(fc) && /dataset\.trackId = id/.test(app), '队列行识别 + dataset.trackId');
  ok(/addCamLayer\(layer, 20\)/.test(fc), 'focus 以 priority 20 位于 cinema/freecam 之间');
  ok(/flight\.snapped/.test(fc), '回程起点 out 首帧快照，不每帧覆盖 from');
  ok(/setPeek\(true\)/.test(fc) && /setPeek\(false\)/.test(fc), 'peek 期压制 cinema、移出恢复');
  ok(/matchMedia\('\(hover: none\)'\)/.test(fc), '触屏无 hover 不触发');
  ok(/StageFreecam\.isEnabled/.test(fc), 'freecam 开启时不响应 peek');
  ok(/Stage\.tier/.test(fc), 'perfTier0 下取消进行中的 peek 且不再触发');
  ok(!/preventDefault/.test(fc), 'peek 不拦截点击/滚轮');
  ok(/StageFocus\.init\(\)/.test(app) && /stage-focus\.js/.test(html), '初始化与页面引用');
}
```

- [ ] **8.6 验证**

全量门；9 个 check 全绿。

- [ ] **8.7 Commit**

```
git --no-pager add crates/vmusicd/web/stage-focus.js crates/vmusicd/web/app.js crates/vmusicd/src/main.rs crates/vmusicd/web/index.html scripts/check-assets.js scripts/check-stage-cinema.js
git --no-pager commit -m "feat(stage): 歌单架与队列悬停焦点跟拍"
```

---

# 任务 9：玻璃新令牌 + 播放条按压档 + 顶栏/弹层玻璃化

spec §7.1/§7.2 覆盖面 1/2。只动令牌与统一组件层，不碰布局结构。

## Files

- Modify: `crates/vmusicd/web/style.css`（:root L102-109 令牌、L136 后 @supports 回落、L1293/L1296 .ctrl 按压、L1565-1566 曲面 saturate、L1792 弹层底）
- Modify: `scripts/check-css-tokens.js`（SHARED_TOKENS L27-34 登记 3 令牌；报告前新增契约 H：令牌必须被消费）

## Steps

- [ ] **9.1 :root 新增 3 个令牌**

L109 `  --glass-blur: 22px;` 之后插入：

```css
  /* 强玻璃底：弹层/抽屉/浮起件。比常驻面更不透明，背后内容不穿透。 */
  --glass-bg-strong: rgba(18, 20, 28, 0.78);
  /* 内描边高光：只作颜色用，1px 宽度由使用处（或玻璃阴影令牌）给出。
     绝不能拼进 var(--glass-border)——那是 "1px solid <color>" 完整简写，
     拼接会产出非法值（check-css-tokens 契约 C）；内高光一律走 inset box-shadow。 */
  --glass-line: rgba(255, 255, 255, 0.10);
  /* 按压档位：图标按钮 80ms 压下、240ms 回弹（见 .ctrl/.ctrl:active）。 */
  --press-scale: 0.97;
```

- [ ] **9.2 两档玻璃阴影的顶部内高光统一引用 --glass-line**

check-css-tokens 契约 B 禁止在使用处把长度与 `var(--glass-shadow*)` 拼在同一条 box-shadow 里，因此内高光只能写进**令牌定义内部**。把 L102-108 两档阴影中的：

```css
  --glass-shadow: 0 22px 64px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    inset 0 -24px 58px rgba(0, 0, 0, 0.16);
  --glass-shadow-glow: 0 22px 64px rgba(0, 0, 0, 0.34),
    0 0 34px rgba(var(--brand-rgb, 0, 245, 212), 0.07),
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    inset 0 -24px 58px rgba(0, 0, 0, 0.16);
```

改为：

```css
  --glass-shadow: 0 22px 64px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 var(--glass-line),
    inset 0 -24px 58px rgba(0, 0, 0, 0.16);
  --glass-shadow-glow: 0 22px 64px rgba(0, 0, 0, 0.34),
    0 0 34px rgba(var(--brand-rgb, 0, 245, 212), 0.07),
    inset 0 1px 0 var(--glass-line),
    inset 0 -24px 58px rgba(0, 0, 0, 0.16);
```

（自定义属性值里的 `var()` 在使用处惰性展开，合法；契约 B 只检查 `box-shadow` 属性声明，不检查令牌定义本身。）

- [ ] **9.3 不支持 backdrop-filter 时强玻璃底退为实色**

L136 `:root` 块结束的 `}` 之后、L138 `body[data-density="compact"] {` 之前插入顶层 @supports 块：

```css
/* 不支持 backdrop-filter 的环境（旧内核/企业策略禁用）：强玻璃底退为实色，
   保证弹层/抽屉文字对比，不靠背后模糊也能读。
   契约 A 仍认得它：选择器还是 :root、文件还是 style.css。 */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  :root { --glass-bg-strong: #12141c; }
}
```

（常驻面 `--glass-bg` 渐变是本特性之前就存在的行为，本次不动。）

- [ ] **9.4 播放控制按钮按压档：80ms 压下 / 240ms 回弹**

L1293 .ctrl 的 transition：

```css
  transition: color 0.25s var(--ease), background 0.25s var(--ease), transform 0.15s var(--ease);
```

改为（基础态时长就是**松手回弹**时长）：

```css
  transition: color 0.25s var(--ease), background 0.25s var(--ease),
              transform 240ms var(--ease-out);
```

L1296：

```css
.ctrl:active { transform: scale(0.9); }
```

改为（按下期间 :active 覆盖为 80ms 快压；松手后基础态 240ms 生效形成回弹）：

```css
.ctrl:active {
  transform: scale(var(--press-scale));
  transition: transform 80ms var(--ease-out);
}
```

L1320 `.ctrl-primary:active { transform: scale(0.96); }` **保持不动**（实心主键已有自己的一档）。

- [ ] **9.5 常驻曲面饱和度 150% → 120%**

L1565-1566：

```css
  backdrop-filter: blur(var(--glass-blur)) saturate(150%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(150%);
```

两行都改为 `saturate(120%)`。顶部内高光已随 9.2 的 `--glass-shadow` 令牌生效，此规则不另拼 inset（契约 B 也不允许拼）。

- [ ] **9.6 弹层（菜单/toast/主题菜单/舞台控制）换强玻璃底**

L1791-1797 规则中的 L1792：

```css
  background: color-mix(in srgb, var(--panel-solid) 88%, transparent);
```

改为：

```css
  background: var(--glass-bg-strong);
```

其余 border/shadow/blur 不动。注意该选择器组含 `.stage-ctl`，它目前被 stage.css L1199 的实色规则覆盖——任务 11 统一。

- [ ] **9.7 check-css-tokens.js 登记令牌 + 新增消费契约**

SHARED_TOKENS（L27-34）在 `'--glass-blur',` 之后加三个：

```js
  '--glass-bg-strong',
  '--glass-line',
  '--press-scale',
```

在 L426 最终报告 `if (problems.length) {` 之前插入契约 H：

```js
// --- 契约 H：新玻璃令牌必须真正被消费 ---
// 只定义不使用的令牌一定会漂移：定义处（--x: ...）本身不含 var(--x)，
// @supports 回落声明也不含，所以这里直接全文件扫 var(名字) 即可，不会误判。
const USAGE_TOKENS = ['--glass-bg-strong', '--glass-line', '--press-scale'];
for (const name of USAGE_TOKENS) {
  const used = files.some((f) =>
    fs.readFileSync(path.join(webDir, f), 'utf8').includes(`var(${name})`)
  );
  if (!used) {
    problems.push({
      file: OWNER_FILE,
      line: 1,
      rule: `玻璃令牌 ${name} 没有任何 var() 消费处`,
      why: '只定义不使用的令牌会漂移；要么用上，要么删掉定义',
    });
  }
}
```

本任务结束时三个令牌的消费处：`--press-scale`（.ctrl:active）、`--glass-bg-strong`（L1792 弹层）、`--glass-line`（9.2 两档阴影令牌内部）。

- [ ] **9.8 验证**

```powershell
node scripts/check-css-tokens.js
```

再跑全量门（cargo 三件套 + 9 个 check）。手工快速核对：浏览器里播放条按钮按下有快压、松手慢弹；菜单/toast 背后内容呈毛玻璃而非 88% 灰幕。

- [ ] **9.9 Commit**

```
git --no-pager add crates/vmusicd/web/style.css scripts/check-css-tokens.js
git --no-pager commit -m "feat(ui): 强玻璃/内高光/按压令牌，播放条与弹层玻璃化"
```

---

# 任务 10：在线曲库面板玻璃化

spec §7.2 覆盖面 3。搜索框/chip/音质选择走「半透明玻璃底 + 小幅模糊」；登录卡片与歌单抽屉走强玻璃；**错误条保持警示橙红不动**。

## Files

- Modify: `crates/vmusicd/web/style.css`（L434-443 通用输入、L474 在线搜索框、L477-486 chips）
- Modify: `crates/vmusicd/web/online.css`（.qr-card L14-20、.op-cover L186-188、.op-drawer L200-215、.opl-filter L292-294、.op-history-item L349-350、.online-quality L369-370；.online-errorbar L372-374 **不动**）
- Modify: `scripts/check-stage-cinema.js`（追加在线面板玻璃契约段）

## Steps

- [ ] **10.1 通用输入玻璃底（曲库/设置/在线搜索框一并生效，它们都坐在玻璃面上）**

L434-443：

```css
input[type="search"], input[type="text"], select {
  padding: 8px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--text);
  outline: none;
  font-size: 13px;
  transition: border-color 0.2s var(--ease), background 0.2s var(--ease);
}
```

改为：

```css
input[type="search"], input[type="text"], select {
  padding: 8px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--glass-line);
  background: color-mix(in srgb, var(--glass-bg-strong) 42%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--text);
  outline: none;
  font-size: 13px;
  transition: border-color 0.2s var(--ease), background 0.2s var(--ease);
}
```

L446 `input:focus, select:focus` 与 L447 `select option` 保持不动（原生 option 弹层仍是实色）。

- [ ] **10.2 在线搜索框模糊再加一档**

L474：

```css
.online-search input { flex: 1; min-width: 0; }
```

改为：

```css
.online-search input {
  flex: 1; min-width: 0;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
```

（同特异性晚于通用规则，覆盖为 10px；底色/描边仍来自 10.1。）

- [ ] **10.3 音源分类 chips 玻璃底**

L477-486：

```css
.online-chips .chip {
  font: inherit; font-size: 12px;
  color: var(--muted);
  border: 1px solid var(--line);
  background: transparent;
  border-radius: 999px;
  padding: 4px 11px;
  cursor: pointer;
  transition: color 0.2s var(--ease), background 0.2s var(--ease), border-color 0.2s var(--ease);
}
```

改为：

```css
.online-chips .chip {
  font: inherit; font-size: 12px;
  color: var(--muted);
  border: 1px solid var(--glass-line);
  background: color-mix(in srgb, var(--glass-bg-strong) 32%, transparent);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border-radius: 999px;
  padding: 4px 11px;
  cursor: pointer;
  transition: color 0.2s var(--ease), background 0.2s var(--ease), border-color 0.2s var(--ease);
}
```

hover/active 两规则（L487-490）不动。

- [ ] **10.4 online.css：登录卡片 .qr-card 走强玻璃**

L14-20（含上方注释）：

```css
/* 卡片：明确的深灰渐变面板，比纯黑背景亮一档，形成「浮起」的层次感；
   顶部内高光 + 实色边框描边，避免之前一团死黑、与背景融为一体。 */
.qr-card{position:relative;width:320px;max-width:86vw;padding:26px 24px 22px;
  border-radius:20px;text-align:center;
  background:linear-gradient(180deg,#1A1D23 0%,#121419 52%,#0E1015 100%);
  border:1px solid rgba(255,255,255,.1);
  box-shadow:0 24px 60px rgba(0,0,0,.66),inset 0 1px 0 rgba(255,255,255,.06)}
```

改为：

```css
/* 卡片：强玻璃底（背后是全屏暗色遮罩，依然浮起），描边/内高光统一走令牌。 */
.qr-card{position:relative;width:320px;max-width:86vw;padding:26px 24px 22px;
  border-radius:20px;text-align:center;
  background:var(--glass-bg-strong);
  border:1px solid var(--glass-line);
  box-shadow:var(--glass-shadow-glow);
  backdrop-filter:blur(var(--glass-blur)) saturate(1.2);
  -webkit-backdrop-filter:blur(var(--glass-blur)) saturate(1.2)}
```

- [ ] **10.5 online.css：歌单封面占位底 .op-cover**

L186-188：

```css
.op-cover{width:100%;aspect-ratio:1;border-radius:12px;margin-bottom:8px;
  background-size:cover;background-position:center;
  background-color:var(--panel-2);
```

把 `background-color:var(--panel-2);` 改为 `background-color:var(--glass-bg-strong);`（渐变叠层与真实封面图都在它之上，不加 blur——网格里元素多，按像素收费）。

- [ ] **10.6 online.css：歌单抽屉 .op-drawer 走强玻璃**

L200-215（含注释）整体替换为：

```css
/* 右侧滑出抽屉：强玻璃底 + 左侧 1px 内高光 + 辉光阴影。
   z-index 压过顶栏(55)/舞台抽屉(50)；遮罩在它下面一档。
   方向阴影不能与 var(--glass-shadow-glow) 拼接（check-css-tokens 契约 B：
   令牌已是完整阴影列表），统一只用令牌；左边沿描边给分隔。 */
.op-drawer-scrim{position:fixed;inset:0;z-index:70;
  background:rgba(4,5,7,.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);
  animation:op-scrim-in .18s ease both}
.op-drawer-scrim[hidden]{display:none}
.op-drawer{position:fixed;top:0;right:0;z-index:75;width:min(500px,94vw);
  height:100dvh;display:flex;flex-direction:column;
  background:var(--glass-bg-strong);
  backdrop-filter:blur(var(--glass-blur)) saturate(1.2);
  -webkit-backdrop-filter:blur(var(--glass-blur)) saturate(1.2);
  border-left:1px solid var(--glass-line);
  box-shadow:var(--glass-shadow-glow);
  animation:op-drawer-in .22s var(--ease) both}
```

- [ ] **10.7 online.css：抽屉内过滤框 .opl-filter**

L292-294：

```css
.opl-filter{flex:none;width:190px;height:30px;padding:0 10px;
  border:1px solid var(--line);border-radius:999px;
  background:transparent;color:var(--text);font:inherit;font-size:12px;outline:none}
```

改为：

```css
.opl-filter{flex:none;width:190px;height:30px;padding:0 10px;
  border:1px solid var(--glass-line);border-radius:999px;
  background:color-mix(in srgb,var(--glass-bg-strong) 42%,transparent);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  color:var(--text);font:inherit;font-size:12px;outline:none}
```

- [ ] **10.8 online.css：最近播放条目 .op-history-item  resting 玻璃底**

L349-350：

```css
.op-history-item{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:10px;
  cursor:pointer;transition:background .15s var(--ease)}
```

改为：

```css
.op-history-item{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:10px;
  background:color-mix(in srgb,var(--glass-bg-strong) 28%,transparent);
  cursor:pointer;transition:background .15s var(--ease)}
```

L351 hover 警示不改（accent 淡底整盖 resting 底）。

- [ ] **10.9 online.css：音质档位选择器 .online-quality**

L369-370：

```css
.online-quality{height:32px;border-radius:8px;border:1px solid var(--line);
  background:var(--panel-2);color:var(--text);font:inherit;font-size:12px;padding:0 8px}
```

改为：

```css
.online-quality{height:32px;border-radius:8px;border:1px solid var(--glass-line);
  background:color-mix(in srgb,var(--glass-bg-strong) 42%,transparent);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  color:var(--text);font:inherit;font-size:12px;padding:0 8px}
```

- [ ] **10.10 明确不改：.online-errorbar**

L372-374 保持 `border:1px solid rgba(255,150,120,.4); background:rgba(255,120,80,.1)` 原样——错误条是警示角色，不进玻璃体系。.qr-cookie-fallback 内的 textarea/button（L33-38）也不动（模态卡内的二级控件）。

- [ ] **10.11 check-stage-cinema.js 追加契约**

```js
section('玻璃化契约：在线曲库面板');
{
  const css = read('online.css');
  const style = read('style.css');
  ok(!/#1A1D23|#0d0f13/.test(css), 'qr-card / 歌单抽屉不再写死实色');
  ok(/\.qr-card\{[^}]*var\(--glass-bg-strong\)/.test(css), '登录卡片走强玻璃底');
  ok(/\.op-drawer\{[^}]*var\(--glass-bg-strong\)[^}]*blur\(var\(--glass-blur\)\)/.test(css),
    '歌单抽屉强玻璃底 + 令牌模糊');
  ok(/input\[type="search"\][^}]*var\(--glass-line\)/.test(style), '通用输入描边走 --glass-line');
  ok(/\.online-chips \.chip \{[^}]*var\(--glass-bg-strong\)/.test(style), 'chip 半透明玻璃底');
  ok(/\.online-errorbar\{[^}]*rgba\(255,\s*120,\s*80,\s*\.1\)/.test(css),
    '错误条保持警示橙红，不玻璃化');
}
```

- [ ] **10.12 验证**

全量门（重点 check-css-tokens：online.css 只**使用**共享令牌、不定义；契约 B/C 对 `1px solid var(--glass-line)` 不触发——C 只盯 --glass-border）。

- [ ] **10.13 Commit**

```
git --no-pager add crates/vmusicd/web/style.css crates/vmusicd/web/online.css scripts/check-stage-cinema.js
git --no-pager commit -m "feat(ui): 在线曲库搜索、chip、登录卡与歌单抽屉玻璃化"
```

---

# 任务 11：舞台控制面板 / 工坊抽屉玻璃化 + lowfx 模糊降级

spec §7.2 覆盖面 4 与 §7.3。统一 .stage-ctl 与 style.css 弹层规则的冲突；去掉 .ws-panel 的令牌 fallback；低性能档把五个大面 blur 降到 8px。

## Files

- Modify: `crates/vmusicd/web/stage.css`（L1092-1093 后加 lowfx 降级规则；L1199-1201 .stage-ctl 实色三行换玻璃）
- Modify: `crates/vmusicd/web/creative.css`（L322-325 .ws-panel 去 fallback 走强玻璃）
- Modify: `scripts/check-stage-cinema.js`（追加契约段）

## Steps

- [ ] **11.1 stage.css：.stage-ctl 三行实色声明换玻璃**

L1199-1201：

```css
  background: var(--panel-solid);
  border-left: 1px solid var(--line);
  box-shadow: -24px 0 60px rgba(0, 0, 0, 0.45);
```

改为：

```css
  background: var(--glass-bg-strong);
  border-left: var(--glass-border);
  box-shadow: var(--glass-shadow-glow);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.2);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.2);
```

（与 style.css L1791 弹层规则同值；stage.css 晚加载，此前是它用实色把玻璃盖掉。`border-left: var(--glass-border)` 残留为空，契约 C 通过。）

- [ ] **11.2 creative.css：.ws-panel 去 fallback**

L322-325：

```css
  background: var(--panel, rgba(18, 20, 24, 0.94));
  backdrop-filter: blur(18px) saturate(1.15);
  border-left: var(--glass-border, 1px solid rgba(255, 255, 255, 0.08));
  box-shadow: var(--glass-shadow, -14px 0 44px rgba(0, 0, 0, 0.42));
```

改为：

```css
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.2);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.2);
  border-left: var(--glass-border);
  box-shadow: var(--glass-shadow-glow);
```

（带 fallback 的 `var(--x, ...)` 恰好绕过 check-css-tokens 的 B/C 正则，却让令牌约定形同虚设——浮起抽屉统一到 glow 档。）

- [ ] **11.3 stage.css：lowfx 档五个大面 blur 降到 8px**

L1092-1093 现有规则：

```css
body.stage-lowfx .stage,
body.stage-lowfx .bar { backdrop-filter: none; -webkit-backdrop-filter: none; }
```

**保持不动**（舞台/播放条背后是动态画布，最贵，直接关）。在其下方新增：

```css
/* 顶栏/导航轨/曲库列与两个大抽屉背后基本是静态底：低性能档只把模糊从 22px
   降到 8px、摘掉饱和度叠加，保留「玻璃」语义而不是退回实色板（spec §7.3）。
   舞台与播放条见上一条规则——它们盖着动态画布，直接关模糊。 */
body.stage-lowfx .topbar,
body.stage-lowfx .rail,
body.stage-lowfx .column,
body.stage-lowfx .stage-ctl,
body.stage-lowfx .ws-panel {
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
```

输入框/chip 上 6-10px 的小面模糊本就便宜，lowfx 不额外处理。

- [ ] **11.4 check-stage-cinema.js 追加契约**

```js
section('玻璃化契约：舞台控制与工坊抽屉 + lowfx 降级');
{
  const stageCss = read('stage.css');
  const creativeCss = read('creative.css');
  ok(/\.stage-ctl\s*\{[^}]*var\(--glass-bg-strong\)/.test(stageCss),
    'stage-ctl 统一到强玻璃底');
  ok(!/\.stage-ctl\s*\{[^}]*var\(--panel-solid\)/.test(stageCss),
    'stage-ctl 不再用 panel-solid 实色覆盖弹层玻璃');
  ok(/\.ws-panel\s*\{[^}]*var\(--glass-bg-strong\)/.test(creativeCss),
    '工坊抽屉强玻璃底');
  ok(!/var\(--glass-border,\s*1px/.test(creativeCss) &&
     !/var\(--glass-shadow,\s*-?\d/.test(creativeCss),
    'ws-panel 去掉玻璃令牌 fallback');
  ok(/body\.stage-lowfx \.stage-ctl[\s\S]{0,200}blur\(8px\)/.test(stageCss),
    'lowfx 下大抽屉模糊降到 8px');
  ok(/body\.stage-lowfx \.stage,[\s\S]{0,120}backdrop-filter:\s*none/.test(stageCss),
    'lowfx 下舞台/播放条仍直接关模糊');
}
```

- [ ] **11.5 验证**

全量门。手工核对：舞台控制面板与工坊抽屉打开时能透出底层内容且有左边沿高光；DevTools 给 body 挂 `stage-lowfx` 类后大面模糊明显减弱但不变成实色。

- [ ] **11.6 Commit**

```
git --no-pager add crates/vmusicd/web/stage.css crates/vmusicd/web/creative.css scripts/check-stage-cinema.js
git --no-pager commit -m "feat(ui): 舞台控制与工坊抽屉玻璃化，lowfx 模糊降级 8px"
```

---

# 任务 12：存量场景参数对照调优（只动参数/防护，不动几何与着色器）

spec §8。本任务以复核为主：任务 4/6 已落两个关键防护（renderOne `dist = max(0.3, ...)`、tunnel 场景 envelope punch 折半），这里逐项取证并把结论钉成静态契约；除非复核发现真问题，**不改应用代码**。

## Files

- Modify: `scripts/check-stage-cinema.js`（追加「存量场景防护」契约段；唯一允许的代码变更）

## Steps

- [ ] **12.1 复核清单（逐项取证，结论写进交付说明）**

1. **场景基线机位**（creative-stage.js L153-165 SCENE_CAM）：最近机位是 tunnel `dist 4.2 / fov 74 / height 0`；cinema envelope 对 `baseDist < 5` 已把 punch 折半（任务 5 纯模块 + 任务 6 layer），renderOne 收口 `dist >= 0.3`（任务 4）。结论：fov/dist 不收缩也不穿模，**不改 SCENE_CAM 常量**。
2. **近裁剪面**：creative-gl.js L1180 `perspective(proj, cam.fov * PI/180, aspect, 0.1, 400)`——near 0.1/far 400；眼点外移量 = dist·cos(pitch)，最小 0.3，最近几何（隧道环/转盘半径量级 >1）不会进入近平面内。结论：near 不动。
3. **星河/粒子封面与相机解耦**：creative-gl.js 着色器 uniform 清单（L1057 附近）只有 `uSpec/uAgg/uPulse/uEnergy/uPlay/uRes/...`，全片搜不到 `uRoll`——roll 只在 JS 视图矩阵（rollView）里，粒子/星河只消费 uPulse/uAgg/频谱。结论：不新增粒子触发，无耦合可拆。
4. **shelf peek 与 CSS 3D 不冲突**：`.shelf-card` 的 translateZ/rotateY 是纯 CSS DOM 变换（style.css L847-971），canvas 相机是另一棵 DOM；stage-focus.js 只写相机 ctx、不写任何元素 `.style.`。结论：无冲突。
5. **shake/drift 收口**：creative-stage.js renderOne 中漂移/shake 在 camLayers 之外统一合成（任务 4 改造结果），cinema 活跃时 onset shake 靠 exp(-dt/130) 自然衰减，不需要额外开关。

- [ ] **12.2 把 12.1 的结论钉成静态契约**

check-stage-cinema.js 追加：

```js
section('存量场景参数防护（spec §8：只调参数，不动几何/着色器）');
{
  const gl = read('creative-gl.js');
  const stage = read('creative-stage.js');
  const focus = read('stage-focus.js');
  ok(!/uRoll/.test(gl), 'roll 只经视图矩阵，不进着色器 uniform（粒子/星河不受 roll 影响）');
  ok(/perspective\(proj,\s*cam\.fov[^)]*0\.1,\s*400\)/.test(gl), 'near 0.1 / far 400 保持');
  ok(/tunnel:\s*\{[^}]*'cam\.dist':\s*4\.2/.test(stage), 'tunnel 基线 dist 4.2 保持（最近机位）');
  ok(/Math\.max\(0\.3,/.test(stage), 'renderOne 对 dist 有 0.3 下限防护');
  ok(!/\.style\./.test(focus), 'peek 只动相机 ctx，不碰 shelf-card 的 CSS 3D transform');
}
```

- [ ] **12.3 验证与提交**

全量门。若 12.1 复核与契约一致（预期一致），只提交契约脚本：

```
git --no-pager add scripts/check-stage-cinema.js
git --no-pager commit -m "test(stage): 钉死存量场景机位、近平面与着色器解耦契约"
```

若复核意外发现穿模/耦合：只允许改**参数或相机侧 clamp 常量**（如 SCENE_CAM 某场景 dist/fov、renderOne 的 dist 下限），禁止动几何数据/着色器/文件结构；改动随本任务一起提交并在提交信息中说明。

---

# 任务 13：契约总核 + 全量门 + 真机验收（spec §10.3）

无新功能。确认三条前端接线闭环、跑全量门、按八项清单真机验收；发现问题按对应任务的约束修复。

## Files

- 无预期新增/修改；仅当门或真机验收发现问题时，回到对应文件修复。

## Steps

- [ ] **13.1 check-assets 三闭环复核**

跑 `node scripts/check-assets.js`，并人工确认 REQUIRE_BEFORE 含任务 6/7/8 加的三条顺序：

```js
  ['creative-stage.js', 'stage-cinema.js'],
  ['stage-cinema.js', 'stage-freecam.js'],
  ['stage-cinema.js', 'stage-focus.js'],
```

以及 main.rs 三条 `include_str!` 常量 + 三条单行 `.route("/x.js", get(|| asset(JS, XXX_JS)))`、index.html 三个 script 标签、app.js 仍是最后一个脚本（check-assets L139 断言）。

- [ ] **13.2 九个契约脚本全绿**

```powershell
Get-ChildItem scripts\check-*.js | ForEach-Object { node $_.FullName }
```

预期 9 个：check-assets / check-creative / check-css-tokens / check-favorites / check-online / check-online-playlist-view / check-stage-control / check-stage-idle / check-stage-cinema。

- [ ] **13.3 Rust 全量门**

```powershell
cargo fmt --all; cargo clippy --workspace --all-targets -- -D warnings; cargo test --workspace
```

- [ ] **13.4 起真机烟测服务（临时数据目录，隔离用户库）**

```powershell
cargo build
$tmp = Join-Path $env:TEMP "vmusic-cinema-smoke"
New-Item -ItemType Directory -Force $tmp | Out-Null
.\target\debug\vmusicd.exe --data-dir $tmp --port 18931
```

启动后 stdout 打印带 token 的 URL（`http://127.0.0.1:18931/?token=...`，main.rs 启动日志），浏览器直接打开。播过至少一首后到 `$tmp\stage-beats\` 应看到 `<sha1>.json` 缓存（含 version/bpm/offset_ms/truncated/beats）。

- [ ] **13.5 spec §10.3 八项真机验收**

1. **强拍 punch**：cinema 开关开、冲击滑块 100%，鼓点处 FOV/dist 冲击同拍无半拍延迟；弱拍幅度明显更小；强度 3 段（长副歌）加强可见。
2. **首播接管**：首次播放新曲时 Network 里 beatmap 先 202 `{status:"analyzing"}`，WS 收到 `beatmap_ready` 后相机平滑接管、无跳变；落库后刷新页面重放直接 200 `{cached:true}`。
3. **自由相机**：WASD 平移（Shift 加速）、指针锁定环视（Esc 退出指针锁后按住画布拖拽回落可用）、Q/E 滚转 ±25°、K 回正、开关关闭 600ms 飞回、刷新页面后开关与机位恢复（localStorage `vmusic.stage.freecam.pose`）。
4. **焦点跟拍**：悬停歌单架卡片 120ms 后 260ms 飞到看台位、移飞出画飞回；队列行同理；飞行期点击/滚动不被拦截；freecam 开启后 peek 不响应。
5. **四个玻璃面 + 按压**：播放条/顶栏、菜单/设置弹层、在线面板（搜索框/chip/音质/抽屉/登录卡）、舞台控制/工坊抽屉均呈毛玻璃；图标按钮快压慢弹；DevTools 给 body 挂 `stage-lowfx` 后大面模糊降到 8px、舞台与播放条关模糊。
6. **场景**：切到 tunnel 近机位不穿模、不露环场边缘；星河/粒子封面/歌单架在 cinema 开关两种状态下均无异常联动。
7. **perfTier 0 全旧行为**：stage-lowfx 下 cinema 包络停（开关自动转 absent/关）、freecam 关闭且入口隐藏、进行中的 peek 取消；只剩 onset 兜底冲击。
8. **seek 与长曲**：播放中拖动进度，镜头在 60ms 内对齐到最近节拍、不补发历史冲击；>12 分钟曲目分析缓存 `truncated:true` 且尾段有推演补点（beats 覆盖到曲末附近）。

- [ ] **13.6 收尾**

- 门全绿且八项验收通过：本任务不产生 commit；在交付说明中列出证据（门输出摘要、缓存 JSON 片段、验收勾选）。
- 若发现问题：在对应任务的文件范围内修复（前端契约违例回 4-12、Rust 回 1-3），每修一处重跑 13.2/13.3 相关门，修复用 `fix(stage): ...` / `fix(ui): ...` 中文提交信息分开提交，不夹带无关改动。
- 烟测结束停掉 vmusicd 进程，临时目录 `$env:TEMP\vmusic-cinema-smoke` 可保留备查或删除。
