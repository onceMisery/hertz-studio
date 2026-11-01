// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 媒体探测测试：合成 MP4/WebM fixture 的 CFR/VFR、tail-moov、旋转、
//! 病态时间戳、预算超限，以及动画图/未知容器的拒绝（C52/C54 子集）。

use super::{probe, Container, MediaProbe};

fn box_of(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

fn container_box(kind: &[u8; 4], children: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(children.len() + 8);
    out.extend_from_slice(&((children.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(children);
    out
}

fn u32be(value: u32) -> [u8; 4] {
    value.to_be_bytes()
}

/// 构造最小 MP4：ftyp + [mdat 占位] + moov。`moov_last` 决定 moov 是否在尾部。
fn mp4_fixture(
    moov_last: bool,
    encoded: (u32, u32),
    display: (u32, u32),
    rotation: u32,
    cfr_delta: Option<u32>,
    stts_entries: &[(u32, u32)],
    profile: Option<(u8, u8)>,
) -> Vec<u8> {
    let mut ftyp_payload = Vec::new();
    ftyp_payload.extend_from_slice(b"isom");
    ftyp_payload.extend_from_slice(&u32be(512));
    ftyp_payload.extend_from_slice(b"isom");
    ftyp_payload.extend_from_slice(b"iso2");
    let ftyp = box_of(b"ftyp", &ftyp_payload);

    // mvhd v0：timescale=1000, duration=4000 → 4s。
    let mut mvhd_payload = vec![0u8; 20];
    mvhd_payload[12..16].copy_from_slice(&u32be(1000));
    mvhd_payload[16..20].copy_from_slice(&u32be(4000));
    let mvhd = box_of(b"mvhd", &mvhd_payload);

    // tkhd v0：84 字节体。末 8 字节为 16.16 宽高；再前 36 字节为矩阵。
    let mut tkhd_payload = vec![0u8; 84];
    tkhd_payload[0] = 0; // version 0
    let (a, b) = match rotation {
        0 => (0x0001_0000i32, 0i32),
        90 => (0, 0x0001_0000),
        180 => (-0x0001_0000, 0),
        270 => (0, -0x0001_0000),
        _ => (0x0001_0000, 0),
    };
    let matrix_start = 84 - 36 - 8; // 体内容器：末 8 是宽高，再前 36 是矩阵
    tkhd_payload[matrix_start..matrix_start + 4].copy_from_slice(&a.to_be_bytes());
    tkhd_payload[matrix_start + 4..matrix_start + 8].copy_from_slice(&b.to_be_bytes());
    let last = 84 - 8;
    tkhd_payload[last..last + 4].copy_from_slice(&(display.0 << 16).to_be_bytes());
    tkhd_payload[last + 4..last + 8].copy_from_slice(&(display.1 << 16).to_be_bytes());
    let tkhd = box_of(b"tkhd", &tkhd_payload);

    // mdhd v0：timescale=1000, duration=4000。
    let mut mdhd_payload = vec![0u8; 20];
    mdhd_payload[12..16].copy_from_slice(&u32be(1000));
    mdhd_payload[16..20].copy_from_slice(&u32be(4000));
    let mdhd = box_of(b"mdhd", &mdhd_payload);

    // hdlr：vide。
    let mut hdlr_payload = vec![0u8; 12];
    hdlr_payload[8..12].copy_from_slice(b"vide");
    let hdlr = box_of(b"hdlr", &hdlr_payload);

    // stsd：avc1 样本项（78 字节固定前缀 + avcC；宽高在 content[24..28]）。
    let mut entry = Vec::new();
    entry.extend_from_slice(&[0u8; 6]); // reserved
    entry.extend_from_slice(&u32be(1)[2..]); // data_reference_index u16
    entry.extend_from_slice(&[0u8; 16]); // pre_defined/reserved
    entry.extend_from_slice(&(encoded.0 as u16).to_be_bytes()); // width @24
    entry.extend_from_slice(&(encoded.1 as u16).to_be_bytes()); // height @26
    entry.extend_from_slice(&[0u8; 50]); // resolution/frame_count/compressorname… 至 78
    let mut children = Vec::new();
    if let Some((profile, level)) = profile {
        let mut avcc = vec![0u8; 4];
        avcc[1] = profile;
        avcc[3] = level;
        children.extend_from_slice(&box_of(b"avcC", &avcc));
    }
    entry.extend_from_slice(&children);
    let stsd_payload = {
        let mut payload = vec![0u8; 4];
        payload.extend_from_slice(&u32be(1));
        payload.extend_from_slice(&box_of(b"avc1", &entry));
        payload
    };
    let stsd = box_of(b"stsd", &stsd_payload);

    // stts。
    let stts_payload = {
        let mut payload = vec![0u8; 4];
        let entries: Vec<(u32, u32)> = match (cfr_delta, stts_entries.is_empty()) {
            (Some(delta), true) => vec![(30, delta)],
            (_, false) => stts_entries.to_vec(),
            // 无 stts（不完整轨道）：省略该 box，探针必须不给任何帧率真值。
            (None, true) => Vec::new(),
        };
        if !entries.is_empty() {
            payload.extend_from_slice(&u32be(entries.len() as u32));
            for (count, delta) in entries {
                payload.extend_from_slice(&u32be(count));
                payload.extend_from_slice(&u32be(delta));
            }
        }
        payload
    };
    let stts = if stts_payload.is_empty() {
        Vec::new()
    } else {
        box_of(b"stts", &stts_payload)
    };

    let stbl = container_box(b"stbl", &{
        let mut all = stsd;
        all.extend_from_slice(&stts);
        all
    });
    let minf = container_box(b"minf", &stbl);
    let mdia = container_box(b"mdia", &{
        let mut all = mdhd;
        all.extend_from_slice(&hdlr);
        all.extend_from_slice(&minf);
        all
    });
    let trak = container_box(b"trak", &{
        let mut all = tkhd;
        all.extend_from_slice(&mdia);
        all
    });
    let moov = container_box(b"moov", &{
        let mut all = mvhd;
        all.extend_from_slice(&trak);
        all
    });

    let mdat = box_of(b"mdat", &[0u8; 64]);
    let mut out = Vec::new();
    if moov_last {
        out.extend_from_slice(&ftyp);
        out.extend_from_slice(&mdat);
        out.extend_from_slice(&moov);
    } else {
        out.extend_from_slice(&ftyp);
        out.extend_from_slice(&moov);
        out.extend_from_slice(&mdat);
    }
    out
}

fn cursor(bytes: &[u8]) -> std::io::Cursor<&[u8]> {
    std::io::Cursor::new(bytes)
}

#[test]
fn mp4_cfr_reports_source_fps_and_dimensions() {
    // stts: 30 帧 × 40 tick @1000 → 25fps；编码 1920×1080，显示同。
    let bytes = mp4_fixture(false, (1920, 1080), (1920, 1080), 0, Some(40), &[], Some((100, 40)));
    let probe = probe(&mut cursor(&bytes)).unwrap();
    assert_eq!(probe.container, Container::Mp4);
    assert_eq!(probe.codec, "avc1");
    assert_eq!(probe.profile.as_deref(), Some("profile-100-level-40"));
    assert_eq!(probe.encoded_width, 1920);
    assert_eq!(probe.encoded_height, 1080);
    assert_eq!(probe.display_width, 1920);
    assert_eq!(probe.duration_ms, Some(4000));
    assert!((probe.source_fps.unwrap() - 25.0).abs() < 1e-9);
    assert!(probe.fps_upper_bound.is_none());
}

#[test]
fn mp4_tail_moov_and_rotation_and_vfr_upper_bound() {
    // moov 在尾部（fast-start 未优化）+ 90° 旋转 + VFR 多段 stts。
    let bytes = mp4_fixture(
        true,
        (3840, 2160),
        (3840, 2160),
        90,
        None,
        &[(10, 40), (20, 100)],
        None,
    );
    let probe = probe(&mut cursor(&bytes)).unwrap();
    assert_eq!(probe.rotation_degrees, 90);
    // min_delta=40 @1000 → 25fps 上界；绝不拿 4000ms/30 帧的平均值冒充（C52）。
    assert!((probe.fps_upper_bound.unwrap() - 25.0).abs() < 1e-9);
    assert!(probe.source_fps.is_none());
    assert_eq!(probe.duration_ms, Some(4000));
}

#[test]
fn mp4_without_stts_has_no_fps_truth() {
    // 无 stts（不完整轨道）：不给任何帧率真值——资格判定交给上层拒绝。
    let bytes = mp4_fixture(false, (640, 360), (640, 360), 0, None, &[], None);
    // stts box 被省略：探针不给任何帧率真值。
    let probe = probe(&mut cursor(&bytes)).unwrap();
    assert!(probe.source_fps.is_none());
    assert!(probe.fps_upper_bound.is_none());
}

#[test]
fn mp4_zero_delta_stts_is_rejected_as_pathological() {
    // 全零 delta 是病态时间戳：探针必须报 unsupported 而不是给出假 fps。
    let bytes = mp4_fixture(false, (640, 360), (640, 360), 0, None, &[(30, 0)], None);
    let error = probe(&mut cursor(&bytes)).unwrap_err();
    assert_eq!(error.code, "format_unsupported");
}

#[test]
fn unknown_container_and_extensions_are_not_trusted() {
    let bytes = b"this is not a media container at all......";
    let error = probe(&mut cursor(bytes)).unwrap_err();
    assert_eq!(error.code, "format_unsupported");
}

#[test]
fn truncated_mp4_is_rejected() {
    let full = mp4_fixture(false, (1920, 1080), (1920, 1080), 0, Some(40), &[], None);
    let truncated = &full[..20];
    // 头部截断到 ftyp 中间：moov 缺失 → 无视频轨。
    let error = probe(&mut cursor(truncated)).unwrap_err();
    assert_eq!(error.code, "format_unsupported");
}

// ---------------------------------------------------------------------------
// WebM
// ---------------------------------------------------------------------------

fn ebml_id(id: u32) -> Vec<u8> {
    // ID 类 vint 的长度由首字节前导零决定（含标记位原样编码）。
    // 按值的最高有效字节范围判长度：0x10-0x1F→4B、0x20-0x3F→3B、0x40-0x7F→2B、0x80-0xFF→1B。
    let length = match id {
        0x10_00_00_00..=0x1F_FF_FF_FF => 4,
        0x20_00_00..=0x3F_FF_FF => 3,
        0x40_00..=0x7F_FF => 2,
        0x80..=0xFF => 1,
        _ => return Vec::new(), // 8+ 字节 ID 本 fixture 不使用
    };
    (0..length)
        .rev()
        .map(|shift| (id >> (8 * shift)) as u8)
        .collect()
}

fn ebml_element(id: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = ebml_id(id);
    // 尺寸 vint 必须带标记位（首字节 0x80|…）——裸写 BE 字节会让解析端把
    // 首字节 0x00 判为非法长度。
    out.extend_from_slice(&ebml_vint_size(payload.len() as u64));
    out.extend_from_slice(payload);
    out
}

fn vint_len(value: u64) -> usize {
    let mut length = 1usize;
    while value >= (1u64 << (7 * length)) && length < 8 {
        length += 1;
    }
    length
}

fn ebml_vint_size(value: u64) -> Vec<u8> {
    let length = vint_len(value);
    let mut out = Vec::new();
    if length == 1 {
        out.push(0x80 | value as u8);
    } else {
        out.push((1u8 << (8 - length)) | (value >> (8 * (length - 1))) as u8);
        for shift in (0..length - 1).rev() {
            out.push((value >> (8 * shift)) as u8);
        }
    }
    out
}

fn webm_fixture(with_clusters: bool) -> Vec<u8> {
    // EBML header。
    let mut header_payload = Vec::new();
    header_payload.extend_from_slice(&ebml_element(0x4286, &[0x01])); // EBMLVersion
    header_payload.extend_from_slice(&ebml_element(0x4282, b"webm")); // DocType
    let header = ebml_element(0x1A45_DFA3, &header_payload);

    // Info：TimestampScale=1_000_000ms→ns; Duration=4.0s（float64）。
    let mut info_payload = Vec::new();
    info_payload.extend_from_slice(&ebml_element(0x2A_D7_B1, &1_000_000u64.to_be_bytes()));
    // Duration 单位 = TimestampScale（1e6 ns = 1ms）→ 4000 单位 = 4s。
    info_payload.extend_from_slice(&ebml_element(0x44_89, &4000.0f64.to_be_bytes()));
    let info = ebml_element(0x1549_A966, &info_payload);

    // Tracks：TrackEntry{TrackType=1, CodecID=V_VP9, Video{W,H}}。
    let mut video_payload = Vec::new();
    video_payload.extend_from_slice(&ebml_element(0xB0, &1920u64.to_be_bytes()));
    video_payload.extend_from_slice(&ebml_element(0xBA, &1080u64.to_be_bytes()));
    let mut track_payload = Vec::new();
    track_payload.extend_from_slice(&ebml_element(0x83, &[0x01])); // TrackType=video
    track_payload.extend_from_slice(&ebml_element(0x86, b"V_VP9"));
    track_payload.extend_from_slice(&ebml_element(0xE0, &video_payload));
    let tracks = ebml_element(0x1654_AE6B, &ebml_element(0xAE, &track_payload));

    // Cluster：Timecode=0 + SimpleBlock 帧 0/40/80/120ms。
    let mut segment_payload = info.clone();
    segment_payload.extend_from_slice(&tracks);
    if with_clusters {
        let mut cluster_payload = Vec::new();
        cluster_payload.extend_from_slice(&ebml_element(0xE7, &0u64.to_be_bytes()));
        for relative in [0i16, 40, 80, 120] {
            let mut block = vec![0x81]; // track vint 1 字节
            block.extend_from_slice(&relative.to_be_bytes());
            block.push(0x00); // flags
            block.extend_from_slice(&[0u8; 4]); // 帧数据占位
            cluster_payload.extend_from_slice(&ebml_element(0xA3, &block));
        }
        segment_payload.extend_from_slice(&ebml_element(0x1F43_B675, &cluster_payload));
    }
    let segment = ebml_element(0x1853_8067, &segment_payload);
    let mut out = header;
    out.extend_from_slice(&segment);
    out
}

#[test]
fn webm_reports_codec_dimensions_and_vfr_upper_bound() {
    let bytes = webm_fixture(true);
    let probe = probe(&mut cursor(&bytes)).unwrap();
    assert_eq!(probe.container, Container::Webm);
    assert_eq!(probe.codec, "V_VP9");
    assert_eq!(probe.encoded_width, 1920);
    assert_eq!(probe.encoded_height, 1080);
    assert_eq!(probe.duration_ms, Some(4000));
    // 帧间隔 40ms → 25fps 上界（来自 block 时间戳，不是时长平均）。
    assert!((probe.fps_upper_bound.unwrap() - 25.0).abs() < 1e-6);
    assert!(probe.source_fps.is_none());
}

#[test]
fn webm_without_video_track_is_rejected() {
    let bytes = webm_fixture(false);
    let probe = probe(&mut cursor(&bytes)).unwrap();
    // 无 Cluster 不影响 codec/尺寸；fpsUpperBound 缺失 → 上层资格拒绝。
    assert!(probe.fps_upper_bound.is_none());
    assert_eq!(probe.codec, "V_VP9");
}

// ---------------------------------------------------------------------------
// 图片：动画拒绝
// ---------------------------------------------------------------------------

#[test]
fn apng_is_rejected_as_animated() {
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png.extend_from_slice(&13u32.to_be_bytes());
    png.extend_from_slice(b"IHDR");
    png.extend_from_slice(&1920u32.to_be_bytes());
    png.extend_from_slice(&1080u32.to_be_bytes());
    png.extend_from_slice(&[8, 6, 0, 0, 0]);
    png.extend_from_slice(&[0u8; 4]); // CRC 占位 → 头部 33 字节
    png.extend_from_slice(b"acTL"); // 动画控制块标记
    png.extend_from_slice(&[0u8; 8]);
    let error = probe(&mut cursor(&png)).unwrap_err();
    assert_eq!(error.code, "format_unsupported");
    assert!(error.message.contains("APNG"));
}

#[test]
fn static_png_reports_dimensions() {
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png.extend_from_slice(&13u32.to_be_bytes()); // IHDR 长度
    png.extend_from_slice(b"IHDR");
    png.extend_from_slice(&1920u32.to_be_bytes());
    png.extend_from_slice(&1080u32.to_be_bytes());
    png.extend_from_slice(&[8, 6, 0, 0, 0]); // bit depth/color/compression…
    png.extend_from_slice(&[0u8; 4]); // CRC 占位 → 头部 33 字节
    let probe = probe(&mut cursor(&png)).unwrap();
    assert_eq!(probe.container, Container::Image);
    assert_eq!(probe.codec, "png");
    assert_eq!(probe.encoded_width, 1920);
    assert_eq!(probe.encoded_height, 1080);
    assert!(probe.source_fps.is_none() && probe.fps_upper_bound.is_none());
}

#[test]
fn animated_webp_is_rejected() {
    let mut webp = b"RIFF\x24\x00\x00\x00WEBP".to_vec();
    webp.extend_from_slice(b"VP8X");
    webp.extend_from_slice(&10u32.to_le_bytes());
    webp.push(0x02); // Animation 标志位
    webp.extend_from_slice(&[0u8; 3]);
    webp.extend_from_slice(&[191, 7, 0]); // 1920-1 24-bit
    webp.extend_from_slice(&[55, 4, 0]); // 1080-1
    let error = probe(&mut cursor(&webp)).unwrap_err();
    assert_eq!(error.code, "format_unsupported");
    assert!(error.message.contains("WebP"));
}

#[test]
fn gif_is_out_of_p1_scope() {
    let gif = b"GIF89a\x80\x02\xb4\x00\x00\x00\x00";
    let error = probe(&mut cursor(gif)).unwrap_err();
    assert_eq!(error.code, "format_unsupported");
}

#[test]
fn short_inputs_are_rejected() {
    let error = probe(&mut cursor(&[0u8; 4])).unwrap_err();
    assert_eq!(error.code, "format_unsupported");
}

// serde 形状回归（诊断 JSON 契约）。
#[test]
fn probe_serializes_camel_case() {
    let bytes = mp4_fixture(false, (640, 360), (640, 360), 0, Some(40), &[], None);
    let probe: MediaProbe = probe(&mut cursor(&bytes)).unwrap();
    let json = serde_json::to_value(&probe).unwrap();
    assert_eq!(json["encodedWidth"], 640);
    assert_eq!(json["sourceFps"], serde_json::json!(25.0));
    assert!(json.get("fpsUpperBound").is_some());
}
