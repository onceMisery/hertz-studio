// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;
use crate::wallpaper::jobs::JobError;

fn request(owner: OwnerKind) -> BudgetRequest {
    BudgetRequest {
        owner,
        session: "bounded-request".into(),
        generation: 1,
        task_id: "task".into(),
        targets: u32::from(owner == OwnerKind::Desktop),
        contexts: 0,
        decoders: 0,
        transcode_slots: 0,
        decode_pixel_rate: 0,
        output_pixel_rate: 0,
        texture_upload_bytes_per_second: 0,
        cpu_bytes: 0,
        prepare_cpu_bytes: 0,
        asset_cpu_bytes: 0,
        gpu_bytes: 0,
        prepare_tasks: 0,
    }
}

fn assert_no_heap(sample: test_support::RequestedHeapSample) {
    assert!(!sample.overflow);
    assert_eq!(sample.peak, 0);
    assert_eq!(sample.retained, 0);
}

/// Independent expectations of the original consumer-facing rejection. The
/// template here is deliberately a separate literal from `BudgetDiagnostic`'s
/// `Display`, so changing the production template cannot make these tests green.
#[derive(Clone, Copy)]
enum Expected {
    Quota {
        quota: &'static str,
        cap: u64,
        held: u64,
        requested: u64,
        hint: &'static str,
    },
    Shape {
        cap: u64,
        held: u64,
        requested: u64,
        text: &'static str,
    },
}

impl Expected {
    fn quota(self) -> &'static str {
        match self {
            Self::Quota { quota, .. } => quota,
            Self::Shape { .. } => "request_shape",
        }
    }

    fn fields(self) -> (u64, u64, u64) {
        match self {
            Self::Quota {
                cap,
                held,
                requested,
                ..
            }
            | Self::Shape {
                cap,
                held,
                requested,
                ..
            } => (cap, held, requested),
        }
    }

    fn text(self) -> String {
        match self {
            Self::Quota {
                quota,
                cap,
                held,
                requested,
                hint,
            } => format!("{quota} 超限：已占 {held} + 申请 {requested} > 上限 {cap}；{hint}"),
            Self::Shape { text, .. } => text.to_owned(),
        }
    }
}

fn expect_quota(
    quota: &'static str,
    cap: u64,
    held: u64,
    requested: u64,
    hint: &'static str,
) -> Expected {
    Expected::Quota {
        quota,
        cap,
        held,
        requested,
        hint,
    }
}

fn expect_shape(cap: u64, held: u64, requested: u64, text: &'static str) -> Expected {
    Expected::Shape {
        cap,
        held,
        requested,
        text,
    }
}

#[test]
fn every_quota_shape_and_extreme_rejection_and_clone_are_allocation_free() {
    // Independent policy edges, with all earlier quotas kept available.
    // Every case carries its own expected cap/held/requested and full text.
    let mut cases: Vec<(Vec<BudgetRequest>, BudgetRequest, Expected)> = Vec::new();
    let mut held = request(OwnerKind::DesktopFrame);
    let mut candidate = held.clone();
    cases.push((
        vec![held.clone(); 4],
        candidate,
        expect_quota(
            "desktop_frames",
            u64::from(MAX_PRESENTATION_TARGETS),
            u64::from(MAX_PRESENTATION_TARGETS),
            1,
            "等待同一桌面目标的旧静态交接画面退出",
        ),
    ));
    held = request(OwnerKind::Desktop);
    held.targets = 4;
    candidate = request(OwnerKind::Desktop);
    cases.push((
        vec![held],
        candidate,
        expect_quota(
            "presentation_targets",
            u64::from(MAX_PRESENTATION_TARGETS),
            4,
            1,
            "减少同时呈现的目标（屏幕/组）或停用其中之一",
        ),
    ));
    held = request(OwnerKind::Desktop);
    held.contexts = 4;
    candidate = request(OwnerKind::Desktop);
    candidate.contexts = 1;
    cases.push((
        vec![held],
        candidate,
        expect_quota(
            "gl_contexts",
            u64::from(MAX_GL_CONTEXTS),
            4,
            1,
            "先释放闲置 context 或降低目标质量档",
        ),
    ));
    held = request(OwnerKind::Probe);
    held.decoders = 2;
    candidate = request(OwnerKind::Probe);
    candidate.decoders = 1;
    cases.push((
        vec![held],
        candidate,
        expect_quota(
            "decoder_slots",
            u64::from(MAX_DECODER_SLOTS),
            2,
            1,
            "显式释放预览或暂停并卸载指定桌面会话后再试",
        ),
    ));
    held = request(OwnerKind::Preview);
    cases.push((
        vec![held.clone()],
        held,
        expect_quota(
            "preview_instances",
            u64::from(MAX_PREVIEW_INSTANCES),
            1,
            1,
            "先关闭现有预览（切页/关闭/应用都会释放旧实例）",
        ),
    ));
    candidate = request(OwnerKind::Preview);
    candidate.contexts = 1;
    candidate.output_pixel_rate = PREVIEW_RESERVED_OUTPUT_RATE + 1;
    cases.push((
        vec![],
        candidate,
        expect_quota(
            "preview_output_rate",
            PREVIEW_RESERVED_OUTPUT_RATE,
            0,
            PREVIEW_RESERVED_OUTPUT_RATE + 1,
            "预览按 960×540 与 ≤15 fps 申请（或降低预览质量）",
        ),
    ));
    held = request(OwnerKind::Preview);
    held.decoders = 1;
    held.output_pixel_rate = MAX_OUTPUT_PIXEL_RATE;
    candidate = request(OwnerKind::Desktop);
    candidate.output_pixel_rate = 1;
    cases.push((
        vec![held],
        candidate,
        expect_quota(
            "output_pixel_rate",
            MAX_OUTPUT_PIXEL_RATE,
            MAX_OUTPUT_PIXEL_RATE,
            1,
            "全部桌面和预览共用输出像素率总额",
        ),
    ));
    held = request(OwnerKind::Probe);
    held.decoders = 1;
    held.decode_pixel_rate = MAX_DECODE_PIXEL_RATE;
    candidate = request(OwnerKind::Probe);
    candidate.decoders = 1;
    candidate.decode_pixel_rate = 1;
    cases.push((
        vec![held],
        candidate,
        expect_quota(
            "decode_pixel_rate",
            MAX_DECODE_PIXEL_RATE,
            MAX_DECODE_PIXEL_RATE,
            1,
            "选择已准备的低分辨率/低帧率变体（§12.1 按编码尺寸计）",
        ),
    ));
    held = request(OwnerKind::Desktop);
    held.contexts = 1;
    held.decoders = 1;
    held.texture_upload_bytes_per_second = MAX_TEXTURE_UPLOAD_BYTES_PER_SECOND;
    candidate = held.clone();
    candidate.texture_upload_bytes_per_second = 1;
    cases.push((
        vec![held],
        candidate,
        expect_quota(
            "texture_upload_bytes_per_second",
            MAX_TEXTURE_UPLOAD_BYTES_PER_SECOND,
            MAX_TEXTURE_UPLOAD_BYTES_PER_SECOND,
            1,
            "选择已准备的更小视频变体或减少组合提交帧率",
        ),
    ));
    held = request(OwnerKind::Desktop);
    held.output_pixel_rate = MAX_OUTPUT_PIXEL_RATE - PREVIEW_RESERVED_OUTPUT_RATE;
    candidate = request(OwnerKind::Desktop);
    candidate.output_pixel_rate = 1;
    cases.push((
        vec![held],
        candidate,
        expect_quota(
            "output_pixel_rate",
            MAX_OUTPUT_PIXEL_RATE - PREVIEW_RESERVED_OUTPUT_RATE,
            MAX_OUTPUT_PIXEL_RATE - PREVIEW_RESERVED_OUTPUT_RATE,
            1,
            "清 idle 缓存、降低预览像素或对允许降档的目标降级（§12.3）",
        ),
    ));
    for (quota, amount, hint) in [
        (
            "cpu_decoded_bytes",
            MAX_CPU_DECODED_BYTES,
            "等待闲置解码缓存被回收或降低素材尺寸",
        ),
        (
            "prepare_cpu_bytes",
            MAX_PREPARE_CPU_BYTES,
            "图片准备工作区不足；使用更小输入或等待准备退出",
        ),
        (
            "asset_cpu_bytes",
            MAX_ASSET_CPU_BYTES,
            "通用共享资源常驻额度不足；等待旧呈现退出",
        ),
        (
            "gpu_tracked_bytes",
            MAX_GPU_TRACKED_BYTES,
            "优先清闲置纹理/几何缓存，再降低允许自动降档目标的效果（§12.3）",
        ),
    ] {
        held = request(OwnerKind::Probe);
        candidate = held.clone();
        match quota {
            "cpu_decoded_bytes" => {
                held.cpu_bytes = amount;
                candidate.cpu_bytes = 1;
            }
            "prepare_cpu_bytes" => {
                held.prepare_cpu_bytes = amount;
                candidate.prepare_cpu_bytes = 1;
            }
            "asset_cpu_bytes" => {
                held.asset_cpu_bytes = amount;
                candidate.asset_cpu_bytes = 1;
            }
            _ => {
                held.gpu_bytes = amount;
                candidate.gpu_bytes = 1;
            }
        }
        cases.push((
            vec![held],
            candidate,
            expect_quota(quota, amount, amount, 1, hint),
        ));
    }
    held = request(OwnerKind::Probe);
    held.prepare_tasks = 1;
    cases.push((
        vec![held.clone()],
        held,
        expect_quota(
            "prepare_tasks",
            u64::from(MAX_PREPARE_TASKS),
            1,
            1,
            "等待在途准备任务结束（取消不提前归还，见 C24）",
        ),
    ));
    cases.push((
        vec![request(OwnerKind::Probe); MAX_RESERVATIONS],
        request(OwnerKind::Probe),
        expect_quota(
            "reservation_metadata",
            MAX_RESERVATIONS as u64,
            MAX_RESERVATIONS as u64,
            1,
            "等待退出确认并回收已结束的原生资源记录",
        ),
    ));

    // Extreme u64 requests exercise the original saturating bounds instead of
    // shape rejection, on an empty ledger and on a fully held one.
    for (quota, cap, hint, set) in [
        (
            "cpu_decoded_bytes",
            MAX_CPU_DECODED_BYTES,
            "等待闲置解码缓存被回收或降低素材尺寸",
            0_usize,
        ),
        (
            "output_pixel_rate",
            MAX_OUTPUT_PIXEL_RATE,
            "全部桌面和预览共用输出像素率总额",
            1,
        ),
        (
            "prepare_cpu_bytes",
            MAX_PREPARE_CPU_BYTES,
            "图片准备工作区不足；使用更小输入或等待准备退出",
            2,
        ),
        (
            "asset_cpu_bytes",
            MAX_ASSET_CPU_BYTES,
            "通用共享资源常驻额度不足；等待旧呈现退出",
            3,
        ),
        (
            "gpu_tracked_bytes",
            MAX_GPU_TRACKED_BYTES,
            "优先清闲置纹理/几何缓存，再降低允许自动降档目标的效果（§12.3）",
            4,
        ),
    ] {
        let mut extreme = request(if set == 1 {
            OwnerKind::Desktop
        } else {
            OwnerKind::Probe
        });
        match set {
            0 => extreme.cpu_bytes = u64::MAX,
            1 => extreme.output_pixel_rate = u64::MAX,
            2 => extreme.prepare_cpu_bytes = u64::MAX,
            3 => extreme.asset_cpu_bytes = u64::MAX,
            _ => extreme.gpu_bytes = u64::MAX,
        }
        cases.push((vec![], extreme, expect_quota(quota, cap, 0, u64::MAX, hint)));
    }
    held = request(OwnerKind::Probe);
    held.cpu_bytes = MAX_CPU_DECODED_BYTES;
    candidate = request(OwnerKind::Probe);
    candidate.cpu_bytes = u64::MAX;
    cases.push((
        vec![held],
        candidate,
        expect_quota(
            "cpu_decoded_bytes",
            MAX_CPU_DECODED_BYTES,
            MAX_CPU_DECODED_BYTES,
            u64::MAX,
            "等待闲置解码缓存被回收或降低素材尺寸",
        ),
    ));

    for (invalid, expected) in [
        (
            {
                let mut r = request(OwnerKind::Probe);
                r.session = "x".repeat(129);
                r
            },
            expect_quota(
                "request_shape",
                0,
                0,
                0,
                "预算申请必须绑定有界会话、非零代际和有效任务 id",
            ),
        ),
        (
            {
                let mut r = request(OwnerKind::Desktop);
                r.targets = 0;
                r
            },
            expect_shape(0, 0, 0, "Desktop 申请必须带至少一个呈现目标"),
        ),
        (
            {
                let mut r = request(OwnerKind::Preview);
                r.targets = 1;
                r
            },
            expect_shape(0, 0, 1, "呈现目标只允许 Desktop owner 申请"),
        ),
        (
            {
                let mut r = request(OwnerKind::Probe);
                r.output_pixel_rate = u64::MAX;
                r
            },
            expect_shape(
                0,
                0,
                u64::MAX,
                "探测不呈现：output_pixel_rate 只允许 Desktop/Preview 申请",
            ),
        ),
        (
            {
                let mut r = request(OwnerKind::Desktop);
                r.transcode_slots = 1;
                r
            },
            expect_shape(
                0,
                0,
                1,
                "P1 无视频转码额度（§5.1）；转码 adapter 落地前恒 0",
            ),
        ),
    ] {
        cases.push((vec![], invalid, expected));
    }
    for (initial, candidate, expected) in cases {
        let budget = BudgetCoordinator::new();
        for held in &initial {
            budget.grant(held).unwrap();
        }
        let before = budget.planning_snapshot();
        let requests = std::slice::from_ref(&candidate);
        let ((actual, advisory, copied), sample) = measure_requested_heap(|| {
            let projection = budget.project_desktop_replacement(&[]);
            let actual = budget.grant(&candidate).unwrap_err();
            let copied = actual.clone();
            (
                actual,
                projection.check_requests(requests).unwrap_err(),
                copied,
            )
        });
        assert_no_heap(sample);
        let (cap, held_value, requested) = expected.fields();
        assert_eq!(
            (actual.quota, actual.cap, actual.held, actual.requested),
            (expected.quota(), cap, held_value, requested)
        );
        let text = expected.text();
        assert_eq!(actual.message.to_string(), text);
        assert_eq!(advisory.message.to_string(), text);
        assert_eq!(advisory, actual);
        assert_eq!(copied, actual);
        // The original consumer boundary keeps its code/prefix/details contract.
        let job = JobError::new(
            "budget_busy",
            format!("{}: {}", actual.quota, actual.message),
        );
        assert_eq!(job.code, "budget_busy");
        assert_eq!(job.message, format!("{}: {text}", expected.quota()));
        assert!(job.details.is_none());
        assert_eq!(budget.planning_snapshot(), before);
    }
}

#[test]
fn preview_and_live_output_rate_bands_are_checked_without_copying() {
    let budget = BudgetCoordinator::new();
    let mut gl_preview = request(OwnerKind::Preview);
    gl_preview.contexts = 1;
    gl_preview.output_pixel_rate = PREVIEW_RESERVED_OUTPUT_RATE;
    let mut live = request(OwnerKind::Desktop);
    live.output_pixel_rate = MAX_OUTPUT_PIXEL_RATE - PREVIEW_RESERVED_OUTPUT_RATE;
    // 8 MP/s GL preview + 112 MP/s live = exactly the 120 MP/s global total.
    let requests = [gl_preview.clone(), live.clone()];
    let before = budget.planning_snapshot();
    let (checked, sample) = measure_requested_heap(|| budget.check_requests(&requests));
    assert_no_heap(sample);
    checked.unwrap();
    assert_eq!(budget.planning_snapshot(), before);
    budget.grant(&gl_preview).unwrap();
    budget.grant(&live).unwrap();
    assert_eq!(budget.usage().output_pixel_rate, MAX_OUTPUT_PIXEL_RATE);

    // One more pixel per second exceeds the global band, not the live band.
    let mut over_global = request(OwnerKind::Desktop);
    over_global.output_pixel_rate = 1;
    let (rejected, sample) =
        measure_requested_heap(|| budget.check_requests(std::slice::from_ref(&over_global)));
    assert_no_heap(sample);
    let rejected = rejected.unwrap_err();
    assert_eq!(
        (
            rejected.quota,
            rejected.cap,
            rejected.held,
            rejected.requested
        ),
        (
            "output_pixel_rate",
            MAX_OUTPUT_PIXEL_RATE,
            MAX_OUTPUT_PIXEL_RATE,
            1
        )
    );
    assert_eq!(
        rejected.message.to_string(),
        format!(
            "output_pixel_rate 超限：已占 {MAX_OUTPUT_PIXEL_RATE} + 申请 1 > 上限 {MAX_OUTPUT_PIXEL_RATE}；全部桌面和预览共用输出像素率总额"
        )
    );

    // Without a preview, live reaches exactly 112 MP/s and +1 hits the live band.
    let live_only = BudgetCoordinator::new();
    let mut at_live_cap = request(OwnerKind::Desktop);
    at_live_cap.output_pixel_rate = MAX_OUTPUT_PIXEL_RATE - PREVIEW_RESERVED_OUTPUT_RATE;
    let (checked, sample) =
        measure_requested_heap(|| live_only.check_requests(std::slice::from_ref(&at_live_cap)));
    assert_no_heap(sample);
    checked.unwrap();
    live_only.grant(&at_live_cap).unwrap();
    let mut over_live = request(OwnerKind::Desktop);
    over_live.output_pixel_rate = 1;
    let (rejected, sample) =
        measure_requested_heap(|| live_only.check_requests(std::slice::from_ref(&over_live)));
    assert_no_heap(sample);
    let rejected = rejected.unwrap_err();
    let live_cap = MAX_OUTPUT_PIXEL_RATE - PREVIEW_RESERVED_OUTPUT_RATE;
    assert_eq!(
        (
            rejected.quota,
            rejected.cap,
            rejected.held,
            rejected.requested
        ),
        ("output_pixel_rate", live_cap, live_cap, 1)
    );
    assert_eq!(
        rejected.message.to_string(),
        format!(
            "output_pixel_rate 超限：已占 {live_cap} + 申请 1 > 上限 {live_cap}；清 idle 缓存、降低预览像素或对允许降档的目标降级（§12.3）"
        )
    );

    // A pure video preview uses its real source rate, not the 8 MP/s GL band.
    let fresh = BudgetCoordinator::new();
    let mut video_preview = request(OwnerKind::Preview);
    video_preview.decoders = 1;
    video_preview.output_pixel_rate = PREVIEW_RESERVED_OUTPUT_RATE * 3;
    let (checked, sample) =
        measure_requested_heap(|| fresh.check_requests(std::slice::from_ref(&video_preview)));
    assert_no_heap(sample);
    checked.unwrap();
    assert_eq!(fresh.planning_snapshot(), (1, BudgetUsage::default()));

    // A GL preview above the reserved band keeps its original diagnostic.
    let over_rate = PREVIEW_RESERVED_OUTPUT_RATE + 1;
    let mut too_large = request(OwnerKind::Preview);
    too_large.contexts = 1;
    too_large.output_pixel_rate = over_rate;
    let (rejected, sample) =
        measure_requested_heap(|| fresh.check_requests(std::slice::from_ref(&too_large)));
    assert_no_heap(sample);
    let rejected = rejected.unwrap_err();
    assert_eq!(
        (
            rejected.quota,
            rejected.cap,
            rejected.held,
            rejected.requested
        ),
        (
            "preview_output_rate",
            PREVIEW_RESERVED_OUTPUT_RATE,
            0,
            PREVIEW_RESERVED_OUTPUT_RATE + 1
        )
    );
    assert_eq!(
        rejected.message.to_string(),
        format!(
            "preview_output_rate 超限：已占 0 + 申请 {over_rate} > 上限 {PREVIEW_RESERVED_OUTPUT_RATE}；预览按 960×540 与 ≤15 fps 申请（或降低预览质量）"
        )
    );
}

#[test]
fn ordered_batches_include_preview_rates_all_quotas_and_metadata_without_copying() {
    let budget = BudgetCoordinator::new();
    let mut preview = request(OwnerKind::Preview);
    preview.decoders = 1;
    preview.output_pixel_rate = 90_000_000;
    let mut desktop = request(OwnerKind::Desktop);
    desktop.output_pixel_rate = 20_000_000;
    let mut another = request(OwnerKind::Desktop);
    another.output_pixel_rate = 3_000_000;
    let requests = [preview, desktop, another];
    let before = budget.planning_snapshot();
    let (checked, sample) = measure_requested_heap(|| budget.check_requests(&requests));
    assert_no_heap(sample);
    checked.unwrap();
    assert_eq!(budget.planning_snapshot(), before);
    for request in &requests {
        budget.grant(request).unwrap();
    }
    assert_eq!(budget.usage().output_pixel_rate, 113_000_000);
    assert_eq!(budget.usage().preview_instances, 1);
    let empty = BudgetCoordinator::new();
    let requests = vec![request(OwnerKind::Probe); MAX_RESERVATIONS + 1];
    let (checked, sample) = measure_requested_heap(|| empty.check_requests(&requests));
    assert_no_heap(sample);
    let rejected = checked.unwrap_err();
    assert_eq!(
        (
            rejected.quota,
            rejected.cap,
            rejected.held,
            rejected.requested
        ),
        (MEMORY_METADATA_QUOTA, 64, 64, 1)
    );
    assert_eq!(empty.planning_snapshot(), (1, BudgetUsage::default()));
    let (_, sample) = measure_requested_heap(|| empty.check_requests(&requests[..64]).unwrap());
    assert_no_heap(sample);
}

#[test]
fn projection_is_frozen_and_preserves_pending_tombstones_and_original_generation_filter() {
    let budget = BudgetCoordinator::new();
    let mut old = request(OwnerKind::Desktop);
    old.generation = 17;
    old.cpu_bytes = 100;
    let mut pending = old.clone();
    pending.generation = 18;
    pending.cpu_bytes = 200;
    let mut tombstone = old.clone();
    tombstone.generation = 19;
    tombstone.cpu_bytes = 300;
    let mut next = old.clone();
    next.generation = 20;
    next.cpu_bytes = 400;
    budget.grant(&old).unwrap();
    let p = budget.grant(&pending).unwrap();
    budget.release(p, &pending.session, 18).unwrap();
    let t = budget.grant(&tombstone).unwrap();
    budget.confirm_exit(t, &tombstone.session, 19).unwrap();
    budget.grant(&next).unwrap();
    let before = budget.planning_snapshot();
    let (projected, sample) =
        measure_requested_heap(|| budget.project_desktop_replacement(&[17, 18, 19]));
    assert_no_heap(sample);
    assert_eq!(projected.usage().cpu_bytes, 600);
    assert_eq!(projected.usage().targets, 2);
    assert_eq!(projected.usage().reservation_records, 3);
    assert_eq!(projected.usage().release_pending, 1);
    assert_eq!(budget.planning_snapshot(), before);
    budget.confirm_exit(p, &pending.session, 18).unwrap();
    assert_eq!(budget.usage().cpu_bytes, 500);
    assert_eq!(projected.usage().cpu_bytes, 600);
}

#[test]
fn session_metadata_is_omitted_only_by_the_original_advisory_view() {
    let budget = BudgetCoordinator::new();
    let plan = SessionPlan::new(
        request(OwnerKind::Desktop),
        vec![ResourcePlan {
            id: "resource".into(),
            maximum: ResourceAmounts::default(),
        }],
    )
    .unwrap();
    let token = budget.grant_session(&plan).unwrap();
    let resource = budget
        .allocate_resource(
            token,
            "bounded-request",
            1,
            "resource",
            ResourceAmounts::default(),
        )
        .unwrap();
    budget
        .release_resource(resource, "bounded-request", 1)
        .unwrap();
    let actual = budget.usage();
    assert_eq!(actual.session_reservations, 1);
    assert_eq!(actual.resource_records, 1);
    let (projection, sample) = measure_requested_heap(|| budget.project_desktop_replacement(&[]));
    assert_no_heap(sample);
    let projected = projection.usage();
    assert_eq!(projected.session_reservations, 0);
    assert_eq!(projected.resource_records, 0);
    assert_eq!(projected.resource_release_pending, 0);
    assert_eq!(projected.reservation_records, actual.reservation_records);
    assert_eq!(projected.targets, actual.targets);
}
