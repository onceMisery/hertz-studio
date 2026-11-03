// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 音频分析管线测试（P1-06b）：黄金向量钉住与播放器频带映射逐位一致，
//! 环形缓冲有界/丢最旧/滑窗时序，以及 §11.3 切换代际语义。

use super::{
    downmix_interleaved, AudioInputOwner, InputKind, SampleRing, SpectrumAnalyzer, BANDS, FFT_SIZE,
};

/// 黄金向量：vmusic-audio/render.rs 对同一信号（sin(0.13·i)·0.8 @2048 样本）
/// 的真实输出。两份实现必须一致，否则壁纸在 hertz 源与 system 源下观感分裂。
const GOLDEN_FIRST: [f32; BANDS] = [
    0.005254107,
    0.005254107,
    0.0052494393,
    0.005329301,
    0.005503852,
    0.0059063607,
    0.0065095234,
    0.0077441474,
    0.009635383,
    0.013650885,
    0.021908276,
    0.05375088,
    0.55,
    0.55,
    0.06320545,
    0.021232039,
    0.01057864,
    0.0065686284,
    0.004387621,
    0.0031826189,
    0.0023449361,
    0.0018532069,
    0.0018983877,
    0.0012753137,
    0.0010146529,
    0.0008802286,
    0.000734381,
    0.000689719,
    0.0009614592,
    0.0009319117,
    0.00058835116,
    0.0004919813,
    0.00051937986,
    0.00081895624,
    0.00076747366,
    0.0005072208,
    0.00044575133,
    0.00062730676,
    0.0008779786,
    0.00051102706,
    0.00043567174,
    0.0006085217,
    0.0008820046,
    0.00046301392,
    0.0003982022,
    0.000602329,
    0.00141083,
    0.00057912426,
    0.0008061544,
    0.0022665919,
    0.00061887834,
    0.0005686202,
    0.0021307329,
    0.0009878388,
    0.00062218733,
    0.001658336,
    0.00079345895,
    0.000498272,
    0.0010882106,
    0.0006654574,
    0.0004603846,
    0.001060973,
    0.00043206094,
    0.0007139505,
];
const GOLDEN_SECOND: [f32; BANDS] = [
    0.007618455,
    0.007618455,
    0.0076116873,
    0.007727487,
    0.007980585,
    0.008564223,
    0.009438809,
    0.011229014,
    0.013971305,
    0.019793782,
    0.031767,
    0.07793877,
    0.7975,
    0.7975,
    0.0916479,
    0.030786455,
    0.015339028,
    0.009524511,
    0.00636205,
    0.0046147974,
    0.0034001574,
    0.0026871501,
    0.0027526622,
    0.0018492048,
    0.0014712467,
    0.0012763315,
    0.0010648525,
    0.0010000925,
    0.0013941159,
    0.001351272,
    0.0008531092,
    0.00071337284,
    0.0007531008,
    0.0011874866,
    0.0011128369,
    0.00073547015,
    0.0006463394,
    0.0009095948,
    0.0012730688,
    0.0007409892,
    0.000631724,
    0.0008823564,
    0.0012789066,
    0.0006713702,
    0.00057739316,
    0.000873377,
    0.0020457034,
    0.00083973014,
    0.0011689239,
    0.0032865582,
    0.00089737365,
    0.0008244993,
    0.0030895625,
    0.0014323662,
    0.00090217165,
    0.0024045873,
    0.0011505155,
    0.00072249444,
    0.0015779054,
    0.00096491317,
    0.00066755764,
    0.0015384109,
    0.00062648836,
    0.0010352281,
];

fn sine_window() -> Vec<f32> {
    (0..FFT_SIZE)
        .map(|i| (i as f32 * 0.13).sin() * 0.8)
        .collect()
}

#[test]
fn band_mapping_matches_player_golden_vector() {
    let mut analyzer = SpectrumAnalyzer::new();
    let window = sine_window();
    let mut first = [0.0f32; BANDS];
    assert!(analyzer.analyze(&window, &mut first));
    let mut second = [0.0f32; BANDS];
    assert!(analyzer.analyze(&window, &mut second));

    for i in 0..BANDS {
        assert!(
            (first[i] - GOLDEN_FIRST[i]).abs() < 1e-6,
            "第 {i} 带首帧漂移：{} vs {}",
            first[i],
            GOLDEN_FIRST[i]
        );
        assert!(
            (second[i] - GOLDEN_SECOND[i]).abs() < 1e-6,
            "第 {i} 带次帧漂移：{} vs {}",
            second[i],
            GOLDEN_SECOND[i]
        );
    }
    // 0.13 rad/样本 ≈ 1655 Hz 信号落在二次方频带 12/13（低频不挤压的证词）。
    assert!((first[12] - first[13]).abs() < 1e-9);
    assert!(first[12] > first[11] * 5.0);
}

/// 静音不放大：峰值低于底时 scale=1，输出全零。
#[test]
fn silence_stays_silent() {
    let mut analyzer = SpectrumAnalyzer::new();
    let mut out = [0.0f32; BANDS];
    assert!(analyzer.analyze(&[0.0; FFT_SIZE], &mut out));
    assert!(out.iter().all(|band| *band == 0.0));
}

/// 环形缓冲：容量=250ms、过载丢最旧并计数、清零随切换归零。
#[test]
fn ring_is_bounded_and_drops_oldest() {
    let mut ring = SampleRing::new(48_000);
    assert_eq!(ring.capacity(), 12_000, "250ms @48kHz");

    ring.push(&vec![1.0; ring.capacity()]);
    assert_eq!(ring.dropped(), 0);
    ring.push(&[2.0, 3.0]);
    assert_eq!(ring.dropped(), 2, "超出容量的样本按丢最旧计数");
    assert_eq!(ring.len(), ring.capacity());

    let mut window = [0.0f32; FFT_SIZE];
    assert!(ring.take_window(&mut window));
    assert_eq!(window[FFT_SIZE - 2], 2.0, "窗尾是最新样本");
    assert_eq!(window[FFT_SIZE - 1], 3.0);
    // 只丢了 2 个最旧样本：2048 窗首仍在保留区（=1.0），窗尾已被顶替。
    assert_eq!(window[0], 1.0);

    ring.clear();
    assert_eq!(ring.len(), 0);
    assert_eq!(ring.dropped(), 0, "切换清空连带丢包计数归零");
    assert!(!ring.take_window(&mut window));
}

/// 滑窗时序：take_window 按时间序返回最新 2048 样本（旧→新）。
#[test]
fn ring_window_is_time_ordered() {
    let mut ring = SampleRing::new(48_000);
    ring.push(&(0..4_096).map(|i| i as f32).collect::<Vec<_>>());
    let mut window = [0.0f32; FFT_SIZE];
    assert!(ring.take_window(&mut window));
    assert_eq!(
        window[0], 2_048.0,
        "窗首=第 2048 个样本（最新 2048 的第一个）"
    );
    assert_eq!(window[FFT_SIZE - 1], 4_095.0);
    for pair in window.windows(2) {
        assert!((pair[1] - pair[0] - 1.0).abs() < 1e-6, "窗内必须时间有序");
    }
}

#[test]
fn consumed_history_is_not_overload_and_stalled_samples_are_not_fresh() {
    let mut ring = SampleRing::new(48_000);
    let mut window = [0.0; FFT_SIZE];
    ring.push(&vec![1.0; FFT_SIZE]);
    assert!(ring.take_window(&mut window));
    assert!(!ring.take_window(&mut window), "同一批 PCM 不得被当成新帧");
    for _ in 0..100 {
        ring.push(&vec![0.5; 1600]);
        assert!(ring.take_window(&mut window));
    }
    assert_eq!(ring.dropped(), 0, "常规 30 Hz 消费不应报告缓冲过载");
}

#[test]
fn delayed_analysis_preserves_capture_time_and_discards_expired_pcm() {
    let mut ring = SampleRing::new(96_000);
    assert_eq!(ring.capacity(), 24_000);
    let captured = std::time::Instant::now();
    let mut window = [0.0; FFT_SIZE];
    ring.push_at(&[0.5; FFT_SIZE], captured);
    let stamp = ring
        .take_window_at(
            &mut window,
            captured + std::time::Duration::from_millis(200),
        )
        .unwrap();
    assert_eq!(
        stamp.captured_at, captured,
        "analysis must not renew sample age"
    );
    ring.push_at(
        &[0.5; FFT_SIZE],
        captured + std::time::Duration::from_millis(1),
    );
    assert!(ring
        .take_window_at(
            &mut window,
            captured + std::time::Duration::from_millis(252)
        )
        .is_none());
    assert_eq!(ring.len(), 0);
    assert_eq!(ring.dropped(), FFT_SIZE as u64);
}

#[test]
fn capture_gap_requires_an_entire_new_window_and_resets_filter_history() {
    let mut ring = SampleRing::new(48_000);
    let before = std::time::Instant::now();
    let after = before + std::time::Duration::from_secs(2);
    let mut window = [0.0; FFT_SIZE];
    ring.push_at(&[1.0; FFT_SIZE], before);
    assert!(
        ring.take_window_at(&mut window, before)
            .unwrap()
            .discontinuity
    );
    ring.push_at(&[0.0; FFT_SIZE / 2], after);
    assert!(
        ring.take_window_at(&mut window, after).is_none(),
        "old signal cannot complete a new silence window"
    );
    ring.push_at(
        &[0.0; FFT_SIZE / 2],
        after + std::time::Duration::from_millis(20),
    );
    assert!(
        ring.take_window_at(&mut window, after + std::time::Duration::from_millis(20))
            .unwrap()
            .discontinuity
    );
    assert!(window.iter().all(|sample| *sample == 0.0));
    ring.push_at(&[0.0; 100], after + std::time::Duration::from_millis(30));
    assert!(
        !ring
            .take_window_at(&mut window, after + std::time::Duration::from_millis(30))
            .unwrap()
            .discontinuity
    );
}

#[test]
fn queued_older_packets_and_empty_writes_cannot_refresh_a_window() {
    let mut ring = SampleRing::new(48_000);
    let now = std::time::Instant::now();
    let mut window = [0.0; FFT_SIZE];
    ring.push_at(&[0.25; FFT_SIZE], now);
    ring.push_at(&[0.9; FFT_SIZE], now - std::time::Duration::from_millis(10));
    ring.push_at(&[], now + std::time::Duration::from_secs(2));
    assert_eq!(
        ring.take_window_at(&mut window, now).unwrap().captured_at,
        now
    );
    assert!(window.iter().all(|sample| *sample == 0.25));
    ring.discontinue();
    ring.push_at(&[0.0; 100], now + std::time::Duration::from_millis(1));
    assert!(ring
        .take_window_at(&mut window, now + std::time::Duration::from_millis(1))
        .is_none());
}

/// 交织立体声 → 单声道平均；单声道直通。
#[test]
fn downmix_averages_channels() {
    let mut mono = Vec::new();
    downmix_interleaved(&[0.2, 0.6, 0.4, 0.8], 2, &mut mono);
    assert_eq!(mono, vec![0.4, 0.6]);

    mono.clear();
    downmix_interleaved(&[0.25, 0.75, 0.1, 0.5, 0.9], 1, &mut mono);
    assert_eq!(mono, vec![0.25, 0.75, 0.1, 0.5, 0.9], "单声道必须直通");
}

/// §11.3 切换顺序：代际递增 + 清空频谱和滤波；首个合法样本才重新生效。
#[test]
fn input_switch_bumps_generation_and_clears_state() {
    let mut ring = SampleRing::new(48_000);
    ring.push(&vec![0.5; 4_096]);
    let mut analyzer = SpectrumAnalyzer::new();
    let mut out = [0.0f32; BANDS];
    assert!(analyzer.analyze(&sine_window(), &mut out));
    assert!(out.iter().any(|band| *band > 0.0), "预热出非零滤波状态");

    let mut owner = AudioInputOwner::new(InputKind::Hertz);
    assert_eq!(owner.kind(), &InputKind::Hertz);

    let generation = owner.switch(InputKind::System { device: None }, &mut ring, &mut analyzer);
    assert_eq!(generation, 1);
    assert_eq!(owner.kind(), &InputKind::System { device: None });
    assert_eq!(ring.len(), 0, "切换必须清空缓冲");
    assert_eq!(ring.dropped(), 0);

    let mut after = [0.0f32; BANDS];
    assert!(analyzer.analyze(&[0.0; FFT_SIZE], &mut after));
    assert!(after.iter().all(|band| *band == 0.0), "滤波状态必须已清");

    let again = owner.switch(InputKind::None, &mut ring, &mut analyzer);
    assert_eq!(again, 2, "每次切换代际只递增");
    assert_eq!(owner.generation(), 2);

    // 新代际样本入环后才可再取窗（旧代际数据已被清掉，不存在跨切换回放）。
    assert!(!ring.take_window(&mut [0.0; FFT_SIZE]));
    ring.push(&sine_window());
    assert!(ring.take_window(&mut [0.0; FFT_SIZE]));
}
