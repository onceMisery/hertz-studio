// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 预算账本测试（P1-04a）：§12.3 的授予原子性、两段退出与反例
//! C11（第三个视频/超预算）、C23（抢最后一个解码槽）、C24（取消后未退出）。

use super::{
    BudgetCoordinator, BudgetRequest, LedgerError, OwnerKind, MAX_CPU_DECODED_BYTES,
    MAX_DECODER_SLOTS, MAX_DECODE_PIXEL_RATE, MAX_GPU_TRACKED_BYTES, MAX_OUTPUT_PIXEL_RATE,
    MAX_PREPARE_TASKS, MAX_PRESENTATION_TARGETS, MAX_PREVIEW_INSTANCES,
    PREVIEW_RESERVED_OUTPUT_RATE,
};

#[test]
fn static_preview_storage_cannot_create_a_renderer_or_decoder() {
    let budget = BudgetCoordinator::new();
    let mut request = req(OwnerKind::PreviewFrame, "preview-frame");
    request.contexts = 1;
    assert!(budget.grant(&request).is_err());
    request.contexts = 0;
    request.decoders = 1;
    assert!(budget.grant(&request).is_err());
    request.decoders = 0;
    request.output_pixel_rate = 1;
    assert!(budget.grant(&request).is_err());
    request.output_pixel_rate = 0;
    request.decode_pixel_rate = 1;
    assert!(budget.grant(&request).is_err());
    assert_eq!(budget.usage(), Default::default());
}

fn req(owner: OwnerKind, session: &str) -> BudgetRequest {
    BudgetRequest {
        owner,
        session: session.to_string(),
        generation: 1,
        task_id: "task".to_string(),
        targets: if owner == OwnerKind::Desktop { 1 } else { 0 },
        contexts: 0,
        decoders: 0,
        transcode_slots: 0,
        decode_pixel_rate: 0,
        output_pixel_rate: 0,
        cpu_bytes: 0,
        prepare_cpu_bytes: 0,
        asset_cpu_bytes: 0,
        gpu_bytes: 0,
        prepare_tasks: 0,
    }
}

#[test]
fn four_desktops_can_keep_bounded_handoff_frames_without_creating_extra_renderers() {
    let budget = BudgetCoordinator::new();
    for index in 0..4 {
        budget
            .grant(&req(OwnerKind::Desktop, &format!("desktop-{index}")))
            .unwrap();
    }
    let mut frames = Vec::new();
    for index in 0..4 {
        let mut request = req(OwnerKind::DesktopFrame, &format!("frame-{index}"));
        request.cpu_bytes = 1024;
        request.gpu_bytes = 4096;
        frames.push(budget.grant(&request).unwrap());
    }
    let usage = budget.usage();
    assert_eq!(
        (
            usage.targets,
            usage.desktop_frames,
            usage.contexts,
            usage.decoder_slots
        ),
        (4, 4, 0, 0)
    );
    assert_eq!((usage.cpu_bytes, usage.gpu_bytes), (4096, 16384));
    assert_eq!(
        budget
            .grant(&req(OwnerKind::Desktop, "fifth-target"))
            .unwrap_err()
            .quota,
        "presentation_targets"
    );
    let frame = req(OwnerKind::DesktopFrame, "fifth-frame");
    assert_eq!(budget.grant(&frame).unwrap_err().quota, "desktop_frames");
    budget.release(frames[0], "frame-0", 1).unwrap();
    assert_eq!(budget.grant(&frame).unwrap_err().quota, "desktop_frames");
    budget.confirm_exit(frames[0], "frame-0", 1).unwrap();
    budget.grant(&frame).unwrap();
    for dimension in 0..6 {
        let mut invalid = req(OwnerKind::DesktopFrame, "invalid-frame");
        match dimension {
            0 => invalid.targets = 1,
            1 => invalid.contexts = 1,
            2 => invalid.decoders = 1,
            3 => invalid.decode_pixel_rate = 1,
            4 => invalid.output_pixel_rate = 1,
            _ => invalid.prepare_tasks = 1,
        }
        assert_eq!(budget.grant(&invalid).unwrap_err().quota, "request_shape");
    }
}

#[test]
fn image_workspace_is_separate_bounded_and_held_until_exit() {
    use super::MAX_PREPARE_CPU_BYTES;
    let budget = BudgetCoordinator::new();
    let mut resident = req(OwnerKind::Desktop, "resident");
    resident.cpu_bytes = MAX_CPU_DECODED_BYTES;
    budget.grant(&resident).unwrap();
    let mut prepare = req(OwnerKind::Probe, "image");
    prepare.prepare_cpu_bytes = MAX_PREPARE_CPU_BYTES;
    let token = budget.grant(&prepare).unwrap();
    let mut next = req(OwnerKind::Probe, "next");
    next.prepare_cpu_bytes = 1;
    assert_eq!(budget.grant(&next).unwrap_err().quota, "prepare_cpu_bytes");
    budget.release(token, "image", 1).unwrap();
    assert!(budget.grant(&next).is_err());
    budget.confirm_exit(token, "image", 1).unwrap();
    assert!(budget.grant(&next).is_ok());
    next.prepare_cpu_bytes = u64::MAX;
    assert_eq!(budget.grant(&next).unwrap_err().quota, "prepare_cpu_bytes");
    assert_eq!(budget.usage().cpu_bytes, MAX_CPU_DECODED_BYTES);
}

/// 通用共享资源信封独立计量：GL 会话不挤占媒体解码 CPU，退出前持续占用。
#[test]
fn shared_assets_are_ledgered_on_a_dedicated_cap() {
    use super::MAX_ASSET_CPU_BYTES;
    let budget = BudgetCoordinator::new();
    let mut gl_desktop = req(OwnerKind::Desktop, "gl-desktop");
    gl_desktop.asset_cpu_bytes = 7 * 2048 * 1088 * 4;
    let gl = budget.grant(&gl_desktop).unwrap();
    // 媒体解码 CPU 不受共享资源信封影响。
    let mut media = req(OwnerKind::Probe, "media");
    media.cpu_bytes = MAX_CPU_DECODED_BYTES;
    budget.grant(&media).unwrap();
    let mut preview = req(OwnerKind::Preview, "gl-preview");
    preview.asset_cpu_bytes = 7 * 2048 * 1088 * 4;
    budget.grant(&preview).unwrap();
    assert_eq!(
        budget.usage().asset_cpu_bytes,
        14 * 2048 * 1088 * 4,
        "双 GL 会话信封必须在专用上限内并存"
    );
    let mut third = req(OwnerKind::Desktop, "gl-third");
    third.asset_cpu_bytes = MAX_ASSET_CPU_BYTES;
    assert_eq!(budget.grant(&third).unwrap_err().quota, "asset_cpu_bytes");
    third.asset_cpu_bytes = u64::MAX;
    assert_eq!(budget.grant(&third).unwrap_err().quota, "asset_cpu_bytes");
    budget.release(gl, "gl-desktop", 1).unwrap();
    assert_eq!(budget.usage().asset_cpu_bytes, 14 * 2048 * 1088 * 4);
    budget.confirm_exit(gl, "gl-desktop", 1).unwrap();
    assert_eq!(budget.usage().asset_cpu_bytes, 7 * 2048 * 1088 * 4);
}

#[test]
fn extreme_requests_do_not_overflow_or_poison_the_ledger() {
    let budget = BudgetCoordinator::new();
    let mut held = req(OwnerKind::Desktop, "held");
    held.cpu_bytes = 1;
    held.gpu_bytes = 1;
    held.decode_pixel_rate = 1;
    held.output_pixel_rate = 1;
    budget.grant(&held).unwrap();
    let before = budget.usage();
    for field in 0..4 {
        let mut huge = req(OwnerKind::Desktop, "huge");
        match field {
            0 => huge.cpu_bytes = u64::MAX,
            1 => huge.gpu_bytes = u64::MAX,
            2 => huge.decode_pixel_rate = u64::MAX,
            _ => huge.output_pixel_rate = u64::MAX,
        }
        assert!(budget.grant(&huge).is_err());
        assert_eq!(budget.usage(), before);
    }
}

/// C11/C23：第三个解码申请必须明确 budget_busy，且不得影响已授予的两个。
#[test]
fn third_decoder_is_budget_busy() {
    let budget = BudgetCoordinator::new();
    let mut a = req(OwnerKind::Desktop, "session-a");
    a.decoders = 1;
    let mut b = req(OwnerKind::Desktop, "session-b");
    b.decoders = 1;
    assert!(budget.grant(&a).is_ok(), "第一个解码槽必须授予");
    assert!(budget.grant(&b).is_ok(), "第二个解码槽必须授予");

    let mut c = req(OwnerKind::Desktop, "session-c");
    c.decoders = 1;
    let rejection = budget.grant(&c).expect_err("第三个解码槽必须拒绝");
    assert_eq!(rejection.quota, "decoder_slots");
    assert_eq!(rejection.cap, u64::from(MAX_DECODER_SLOTS));
    assert!(
        rejection.message.contains("释放预览"),
        "拒绝必须给可操作选项：{rejection:?}"
    );

    let usage = budget.usage();
    assert_eq!(usage.decoder_slots, 2, "已授予的两个不得被第三个申请改写");
}

/// C24：release 只标记不归还；confirm_exit（真实退出）后才腾出槽位。
#[test]
fn release_pending_keeps_slot_until_confirm() {
    let budget = BudgetCoordinator::new();
    let mut a = req(OwnerKind::Desktop, "session-a");
    a.decoders = 1;
    let token = budget.grant(&a).expect("授予 a");
    let mut b = req(OwnerKind::Desktop, "session-b");
    b.decoders = 1;
    budget.grant(&b).expect("授予 b（占满 2 槽）");

    budget.release(token, "session-a", 1).expect("首次 release");
    budget
        .release(token, "session-a", 1)
        .expect("release 必须幂等");
    assert_eq!(budget.usage().decoder_slots, 2, "pending 仍占用");
    assert_eq!(budget.usage().release_pending, 1);
    assert_eq!(
        budget.stuck(),
        vec![(token, "session-a".to_string(), "task".to_string())]
    );

    let mut c = req(OwnerKind::Desktop, "session-c");
    c.decoders = 1;
    assert!(budget.grant(&c).is_err(), "未确认退出前不得把槽给下一任务");

    budget
        .confirm_exit(token, "session-a", 1)
        .expect("确认退出");
    budget
        .confirm_exit(token, "session-a", 1)
        .expect("confirm 幂等");
    assert_eq!(budget.usage().decoder_slots, 1, "确认后归还（只剩 b）");
    assert!(budget.stuck().is_empty());
    assert!(budget.grant(&c).is_ok(), "归还后新申请必须成功");
}

/// 错误 owner / 旧代际不得改写账本（§12.3）。
#[test]
fn stale_generation_and_wrong_owner_cannot_touch_ledger() {
    let budget = BudgetCoordinator::new();
    let mut a = req(OwnerKind::Desktop, "session-a");
    a.decoders = 1;
    let token = budget.grant(&a).expect("授予");

    assert_eq!(
        budget.release(token, "session-a", 0),
        Err(LedgerError::GenerationMismatch),
        "旧代际 release 必须拒绝"
    );
    assert_eq!(
        budget.release(token, "session-b", 1),
        Err(LedgerError::OwnerMismatch),
        "他人 release 必须拒绝"
    );
    assert_eq!(budget.usage().decoder_slots, 1, "被拒调用不得改账");
    budget.release(token, "session-a", 1).expect("本人 release");
    assert_eq!(
        budget.confirm_exit(token, "session-b", 1),
        Err(LedgerError::OwnerMismatch),
        "他人 confirm 不得替本人归还"
    );
    assert_eq!(budget.usage().decoder_slots, 1);
    assert_eq!(
        budget.release(u64::MAX, "session-a", 1),
        Err(LedgerError::UnknownToken),
    );
}

/// 会话销毁清除其全部 token（含 pending 与墓碑），他人 token 不受影响。
#[test]
fn purge_session_clears_all_states() {
    let budget = BudgetCoordinator::new();
    let mut a1 = req(OwnerKind::Desktop, "session-a");
    a1.decoders = 1;
    let mut a2 = req(OwnerKind::Desktop, "session-a");
    a2.targets = 1;
    let mut b = req(OwnerKind::Desktop, "session-b");
    b.decoders = 1;

    let token1 = budget.grant(&a1).expect("a1");
    let token2 = budget.grant(&a2).expect("a2");
    let token_b = budget.grant(&b).expect("b");
    budget.release(token1, "session-a", 1).expect("release a1");
    budget
        .confirm_exit(token2, "session-a", 1)
        .expect("a2 已退出");

    let mut later = req(OwnerKind::Desktop, "session-a");
    later.generation = 2;
    let later_token = budget.grant(&later).unwrap();
    assert_eq!(
        budget.purge_session("session-a", 1),
        2,
        "pending+墓碑都清除"
    );
    assert_eq!(budget.usage().decoder_slots, 1, "只残留 b 的槽");
    assert_eq!(budget.purge_session("session-a", 1), 0, "重复 purge 幂等");
    assert!(
        budget.release(later_token, "session-a", 2).is_ok(),
        "旧 controller 退出不能清后继代际"
    );
    assert_eq!(
        budget.release(token1, "session-a", 1),
        Err(LedgerError::UnknownToken),
        "清除后不得再操作"
    );
    budget
        .release(token_b, "session-b", 1)
        .expect("b 的 token 仍可由本人正常释放");
}

/// 预览：全局 1 个、输出率只能用 8 MP/s 保留带，live 摸不到保留带。
#[test]
fn preview_single_instance_and_reserved_band() {
    let budget = BudgetCoordinator::new();

    let mut live = req(OwnerKind::Desktop, "session-live");
    live.output_pixel_rate = MAX_OUTPUT_PIXEL_RATE - PREVIEW_RESERVED_OUTPUT_RATE;
    assert!(budget.grant(&live).is_ok(), "live 可用满 112 MP/s");

    let mut over = req(OwnerKind::Preview, "preview-over");
    over.output_pixel_rate = PREVIEW_RESERVED_OUTPUT_RATE + 1;
    let rejection = budget.grant(&over).expect_err("预览超保留带必须拒绝");
    assert_eq!(rejection.quota, "preview_output_rate");

    let mut preview = req(OwnerKind::Preview, "preview-1");
    preview.output_pixel_rate = PREVIEW_RESERVED_OUTPUT_RATE;
    let preview_token = budget.grant(&preview).expect("预览占用保留带");

    let preview2 = req(OwnerKind::Preview, "preview-2");
    let rejection = budget.grant(&preview2).expect_err("第二个预览必须拒绝");
    assert_eq!(rejection.quota, "preview_instances");

    budget
        .release(preview_token, "preview-1", 1)
        .expect("预览释放");
    budget
        .confirm_exit(preview_token, "preview-1", 1)
        .expect("预览退出");
    let mut still_over = req(OwnerKind::Desktop, "session-next");
    still_over.output_pixel_rate = MAX_OUTPUT_PIXEL_RATE - PREVIEW_RESERVED_OUTPUT_RATE + 1;
    let rejection = budget
        .grant(&still_over)
        .expect_err("预览退出后 live 上限不变");
    assert_eq!(rejection.quota, "output_pixel_rate");
}

/// 解码像素率按编码尺寸×帧率上界（§12.2）：C25 的少记反例。
#[test]
fn decode_pixel_rate_cap() {
    let budget = BudgetCoordinator::new();
    let full_hd_60 = 1_920_u64 * 1_080 * 60; // ≈124.4 MP/s
    let mut a = req(OwnerKind::Desktop, "session-a");
    a.decoders = 1;
    a.decode_pixel_rate = full_hd_60;
    assert!(budget.grant(&a).is_ok(), "1080p60 单路必须授予");

    let mut b = req(OwnerKind::Desktop, "session-b");
    b.decoders = 1;
    b.decode_pixel_rate = full_hd_60;
    let rejection = budget.grant(&b).expect_err("两路 1080p60 超过 125 MP/s");
    assert_eq!(rejection.quota, "decode_pixel_rate");
    assert_eq!(rejection.cap, MAX_DECODE_PIXEL_RATE);

    let mut oversize = req(OwnerKind::Desktop, "session-c");
    oversize.decoders = 1;
    oversize.decode_pixel_rate = 1_920 * 1_088 * 60; // 125.3 MP/s，单路即超
    let rejection = budget
        .grant(&oversize)
        .expect_err("编码尺寸×帧率超上限必须直接拒绝");
    assert_eq!(rejection.quota, "decode_pixel_rate");
}

/// CPU/GPU 字节上限与准备任务单槽。
#[test]
fn byte_caps_and_prepare_slot() {
    let budget = BudgetCoordinator::new();
    let mut a = req(OwnerKind::Desktop, "session-a");
    a.cpu_bytes = MAX_CPU_DECODED_BYTES;
    a.gpu_bytes = MAX_GPU_TRACKED_BYTES;
    a.prepare_tasks = 1;
    assert!(budget.grant(&a).is_ok(), "顶格但未超限必须授予");

    let mut b = req(OwnerKind::Desktop, "session-b");
    b.cpu_bytes = 1;
    let rejection = budget.grant(&b).expect_err("CPU 超 1 字节即拒绝");
    assert_eq!(rejection.quota, "cpu_decoded_bytes");

    let mut c = req(OwnerKind::Desktop, "session-c");
    c.gpu_bytes = 1;
    let rejection = budget.grant(&c).expect_err("GPU 超 1 字节即拒绝");
    assert_eq!(rejection.quota, "gpu_tracked_bytes");

    let mut d = req(OwnerKind::Desktop, "session-d");
    d.prepare_tasks = 1;
    let rejection = budget.grant(&d).expect_err("准备任务单槽");
    assert_eq!(rejection.quota, "prepare_tasks");
    assert!(
        rejection.message.contains("C24"),
        "拒绝话术必须提醒取消不提前归还"
    );
}

/// owner 与字段组合的申请面合同。
#[test]
fn request_shape_validates_owner_fields() {
    let budget = BudgetCoordinator::new();

    let mut desktop_empty = req(OwnerKind::Desktop, "session-a");
    desktop_empty.targets = 0;
    assert_eq!(
        budget.grant(&desktop_empty).err().map(|r| r.quota),
        Some("request_shape"),
        "Desktop 必须带呈现目标"
    );

    let mut preview_with_target = req(OwnerKind::Preview, "preview-1");
    preview_with_target.targets = 1;
    assert_eq!(
        budget.grant(&preview_with_target).err().map(|r| r.quota),
        Some("request_shape"),
        "预览不得占桌面呈现目标额度"
    );

    let mut probe_with_output = req(OwnerKind::Probe, "probe-1");
    probe_with_output.output_pixel_rate = 1_000_000;
    assert_eq!(
        budget.grant(&probe_with_output).err().map(|r| r.quota),
        Some("request_shape"),
        "探测不呈现，不得申请输出率"
    );

    let mut with_transcode = req(OwnerKind::Desktop, "session-b");
    with_transcode.transcode_slots = 1;
    assert_eq!(
        budget.grant(&with_transcode).err().map(|r| r.quota),
        Some("request_shape"),
        "P1 无转码额度"
    );
}

/// 占用快照覆盖 §12.4 账本侧字段。
#[test]
fn usage_snapshot_covers_all_quotas() {
    let budget = BudgetCoordinator::new();
    let mut desktop = req(OwnerKind::Desktop, "session-a");
    desktop.contexts = 1;
    desktop.decoders = 1;
    desktop.decode_pixel_rate = 60_000_000;
    desktop.output_pixel_rate = 30_000_000;
    desktop.cpu_bytes = 10 * 1024 * 1024;
    desktop.gpu_bytes = 100 * 1024 * 1024;
    desktop.prepare_tasks = 1;
    let token = budget.grant(&desktop).expect("desktop 授予");

    let mut preview = req(OwnerKind::Preview, "preview-1");
    preview.output_pixel_rate = 5_000_000;
    budget.grant(&preview).expect("preview 授予");

    let mut probe = req(OwnerKind::Probe, "probe-1");
    probe.decoders = 1;
    probe.decode_pixel_rate = 10_000_000;
    budget.grant(&probe).expect("probe 授予（第二个解码槽）");

    let usage = budget.usage();
    assert_eq!(usage.targets, 1);
    assert_eq!(usage.contexts, 1);
    assert_eq!(usage.decoder_slots, 2, "桌面+探测共用 2 槽");
    assert_eq!(usage.preview_instances, 1);
    assert_eq!(usage.decode_pixel_rate, 70_000_000, "探测的解码率计入总额");
    assert_eq!(usage.output_pixel_rate, 35_000_000);
    assert_eq!(usage.cpu_bytes, 10 * 1024 * 1024);
    assert_eq!(usage.gpu_bytes, 100 * 1024 * 1024);
    assert_eq!(usage.prepare_tasks, 1);
    assert_eq!(usage.release_pending, 0);

    budget.release(token, "session-a", 1).expect("release");
    assert_eq!(budget.usage().release_pending, 1);
    assert_eq!(budget.usage().decoder_slots, 2, "pending 仍占槽");
}

/// 设计常量自洽：预览带装得下 960×540@15，且是总额的真子集。
#[test]
fn constants_are_self_consistent() {
    const _: () = assert!(
        960_u64 * 540 * 15 <= PREVIEW_RESERVED_OUTPUT_RATE,
        "960×540@15 ≈ 7.8 MP/s 必须装进 8 MP/s 预览保留带"
    );
    const _: () = assert!(PREVIEW_RESERVED_OUTPUT_RATE < MAX_OUTPUT_PIXEL_RATE);
    const _: () = assert!(MAX_PRESENTATION_TARGETS >= 1);
    const _: () = assert!(MAX_PREVIEW_INSTANCES == 1);
    const _: () = assert!(MAX_PREPARE_TASKS == 1);
    const _: () = assert!(MAX_DECODER_SLOTS == 2);
}

#[test]
fn tombstone_cleanup_checks_owner_generation_and_leaves_other_allocations_intact() {
    let budget = BudgetCoordinator::new();
    let old = budget.grant(&req(OwnerKind::Desktop, "session")).unwrap();
    let mut next = req(OwnerKind::Desktop, "session");
    next.generation = 2;
    let active = budget.grant(&next).unwrap();
    assert!(!budget.forget_released(old, "session", 1).unwrap());
    budget.release(old, "session", 1).unwrap();
    assert!(!budget.forget_released(old, "session", 1).unwrap());
    assert_eq!(
        budget.forget_released(old, "other", 1),
        Err(LedgerError::OwnerMismatch)
    );
    assert_eq!(
        budget.forget_released(old, "session", 2),
        Err(LedgerError::GenerationMismatch)
    );
    budget.confirm_exit(old, "session", 1).unwrap();
    assert!(budget.forget_released(old, "session", 1).unwrap());
    assert_eq!(budget.usage().targets, 1);
    assert!(!budget.forget_released(active, "session", 2).unwrap());
    budget.confirm_exit(active, "session", 2).unwrap();
    assert!(budget.forget_released(active, "session", 2).unwrap());
    assert_eq!(budget.usage(), Default::default());
}
