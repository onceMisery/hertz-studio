// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! The original quota/shape checks, shared by actual admission and advisory use.
use super::*;

impl BudgetCoordinator {
    pub(super) fn check_grant(
        request: &BudgetRequest,
        usage: &BudgetUsage,
        preview_output_held: u64,
    ) -> Result<(), BudgetRejection> {
        Self::validate_shape(request)?;
        if usage.reservation_records as usize >= MAX_RESERVATIONS {
            return Err(Ledger::reject(
                MEMORY_METADATA_QUOTA,
                MAX_RESERVATIONS as u64,
                u64::from(usage.reservation_records),
                1,
                MEMORY_METADATA_HINT,
            ));
        }

        if request.owner == OwnerKind::DesktopFrame
            && usage.desktop_frames >= MAX_PRESENTATION_TARGETS
        {
            return Err(Ledger::reject(
                "desktop_frames",
                u64::from(MAX_PRESENTATION_TARGETS),
                u64::from(usage.desktop_frames),
                1,
                "等待同一桌面目标的旧静态交接画面退出",
            ));
        }

        if request.targets > 0 {
            let cap = u64::from(MAX_PRESENTATION_TARGETS);
            if u64::from(usage.targets) + u64::from(request.targets) > cap {
                return Err(Ledger::reject(
                    "presentation_targets",
                    cap,
                    u64::from(usage.targets),
                    u64::from(request.targets),
                    "减少同时呈现的目标（屏幕/组）或停用其中之一",
                ));
            }
        }
        if request.contexts > 0 {
            let cap = u64::from(MAX_GL_CONTEXTS);
            if u64::from(usage.contexts) + u64::from(request.contexts) > cap {
                return Err(Ledger::reject(
                    "gl_contexts",
                    cap,
                    u64::from(usage.contexts),
                    u64::from(request.contexts),
                    "先释放闲置 context 或降低目标质量档",
                ));
            }
        }
        if request.decoders > 0 {
            let cap = u64::from(MAX_DECODER_SLOTS);
            if u64::from(usage.decoder_slots) + u64::from(request.decoders) > cap {
                return Err(Ledger::reject(
                    "decoder_slots",
                    cap,
                    u64::from(usage.decoder_slots),
                    u64::from(request.decoders),
                    "显式释放预览或暂停并卸载指定桌面会话后再试",
                ));
            }
        }
        if request.owner == OwnerKind::Preview {
            let cap = u64::from(MAX_PREVIEW_INSTANCES);
            if u64::from(usage.preview_instances) + 1 > cap {
                return Err(Ledger::reject(
                    "preview_instances",
                    cap,
                    u64::from(usage.preview_instances),
                    1,
                    "先关闭现有预览（切页/关闭/应用都会释放旧实例）",
                ));
            }
            // 8 MP/s 是 GL 预览的保留带。纯视频按真实源速率申请剩余总额，
            // 不能强制套 15 fps，也不能把保留带当成它的绝对上限。
            let video_preview = request.contexts == 0 && request.decoders > 0;
            if !video_preview && request.output_pixel_rate > PREVIEW_RESERVED_OUTPUT_RATE {
                return Err(Ledger::reject(
                    "preview_output_rate",
                    PREVIEW_RESERVED_OUTPUT_RATE,
                    0,
                    request.output_pixel_rate,
                    "预览按 960×540 与 ≤15 fps 申请（或降低预览质量）",
                ));
            }
        }
        if request.output_pixel_rate > MAX_OUTPUT_PIXEL_RATE.saturating_sub(usage.output_pixel_rate)
        {
            return Err(Ledger::reject(
                "output_pixel_rate",
                MAX_OUTPUT_PIXEL_RATE,
                usage.output_pixel_rate,
                request.output_pixel_rate,
                "全部桌面和预览共用输出像素率总额",
            ));
        }
        if request.decode_pixel_rate > 0
            && request.decode_pixel_rate
                > MAX_DECODE_PIXEL_RATE.saturating_sub(usage.decode_pixel_rate)
        {
            return Err(Ledger::reject(
                "decode_pixel_rate",
                MAX_DECODE_PIXEL_RATE,
                usage.decode_pixel_rate,
                request.decode_pixel_rate,
                "选择已准备的低分辨率/低帧率变体（§12.1 按编码尺寸计）",
            ));
        }
        if request.texture_upload_bytes_per_second
            > MAX_TEXTURE_UPLOAD_BYTES_PER_SECOND
                .saturating_sub(usage.texture_upload_bytes_per_second)
        {
            return Err(Ledger::reject(
                "texture_upload_bytes_per_second",
                MAX_TEXTURE_UPLOAD_BYTES_PER_SECOND,
                usage.texture_upload_bytes_per_second,
                request.texture_upload_bytes_per_second,
                "选择已准备的更小视频变体或减少组合提交帧率",
            ));
        }
        if request.output_pixel_rate > 0 && request.owner != OwnerKind::Preview {
            // live 侧不共享预览保留带：预览占用独立于 live 上限之外。
            let live_held = usage.output_pixel_rate.saturating_sub(preview_output_held);
            let cap = MAX_OUTPUT_PIXEL_RATE - PREVIEW_RESERVED_OUTPUT_RATE;
            if request.output_pixel_rate > cap.saturating_sub(live_held) {
                return Err(Ledger::reject(
                    "output_pixel_rate",
                    cap,
                    live_held,
                    request.output_pixel_rate,
                    "清 idle 缓存、降低预览像素或对允许降档的目标降级（§12.3）",
                ));
            }
        }
        if request.cpu_bytes > MAX_CPU_DECODED_BYTES.saturating_sub(usage.cpu_bytes) {
            return Err(Ledger::reject(
                "cpu_decoded_bytes",
                MAX_CPU_DECODED_BYTES,
                usage.cpu_bytes,
                request.cpu_bytes,
                "等待闲置解码缓存被回收或降低素材尺寸",
            ));
        }
        if request.prepare_cpu_bytes > MAX_PREPARE_CPU_BYTES.saturating_sub(usage.prepare_cpu_bytes)
        {
            return Err(Ledger::reject(
                MEMORY_PREPARE_QUOTA,
                MAX_PREPARE_CPU_BYTES,
                usage.prepare_cpu_bytes,
                request.prepare_cpu_bytes,
                MEMORY_PREPARE_HINT,
            ));
        }
        if request.asset_cpu_bytes > MAX_ASSET_CPU_BYTES.saturating_sub(usage.asset_cpu_bytes) {
            return Err(Ledger::reject(
                MEMORY_ASSET_QUOTA,
                MAX_ASSET_CPU_BYTES,
                usage.asset_cpu_bytes,
                request.asset_cpu_bytes,
                MEMORY_ASSET_HINT,
            ));
        }
        if request.gpu_bytes > MAX_GPU_TRACKED_BYTES.saturating_sub(usage.gpu_bytes) {
            return Err(Ledger::reject(
                "gpu_tracked_bytes",
                MAX_GPU_TRACKED_BYTES,
                usage.gpu_bytes,
                request.gpu_bytes,
                "优先清闲置纹理/几何缓存，再降低允许自动降档目标的效果（§12.3）",
            ));
        }
        if request.prepare_tasks > 0 {
            let cap = u64::from(MAX_PREPARE_TASKS);
            if u64::from(usage.prepare_tasks) + u64::from(request.prepare_tasks) > cap {
                return Err(Ledger::reject(
                    "prepare_tasks",
                    cap,
                    u64::from(usage.prepare_tasks),
                    u64::from(request.prepare_tasks),
                    "等待在途准备任务结束（取消不提前归还，见 C24）",
                ));
            }
        }

        Ok(())
    }

    /// 申请面静态校验：owner 与字段组合的合同（§12.1 表格的行内约束）。
    fn validate_shape(request: &BudgetRequest) -> Result<(), BudgetRejection> {
        if !request.has_valid_identity() {
            return Err(Ledger::reject(
                "request_shape",
                0,
                0,
                0,
                "预算申请必须绑定有界会话、非零代际和有效任务 id",
            ));
        }
        match request.owner {
            OwnerKind::Desktop => {
                if request.targets == 0 {
                    return Err(BudgetRejection {
                        quota: "request_shape",
                        cap: 0,
                        held: 0,
                        requested: 0,
                        message: "Desktop 申请必须带至少一个呈现目标".into(),
                    });
                }
            }
            OwnerKind::DesktopFrame
            | OwnerKind::Preview
            | OwnerKind::PreviewFrame
            | OwnerKind::Probe => {
                if request.targets != 0 {
                    return Err(BudgetRejection {
                        quota: "request_shape",
                        cap: 0,
                        held: 0,
                        requested: u64::from(request.targets),
                        message: "呈现目标只允许 Desktop owner 申请".into(),
                    });
                }
            }
        }
        if matches!(
            request.owner,
            OwnerKind::PreviewFrame | OwnerKind::DesktopFrame
        ) && (request.contexts != 0
            || request.decoders != 0
            || request.decode_pixel_rate != 0
            || request.output_pixel_rate != 0
            || request.texture_upload_bytes_per_second != 0
            || request.prepare_tasks != 0)
        {
            return Err(Ledger::reject(
                "request_shape",
                0,
                0,
                1,
                "静态交接帧只能持有位图和采集工作区",
            ));
        }
        if request.owner == OwnerKind::Probe && request.output_pixel_rate != 0 {
            return Err(BudgetRejection {
                quota: "request_shape",
                cap: 0,
                held: 0,
                requested: request.output_pixel_rate,
                message: "探测不呈现：output_pixel_rate 只允许 Desktop/Preview 申请".into(),
            });
        }
        if request.texture_upload_bytes_per_second != 0
            && (request.contexts == 0
                || request.decoders == 0
                || !matches!(request.owner, OwnerKind::Desktop | OwnerKind::Preview))
        {
            return Err(Ledger::reject(
                "request_shape",
                0,
                0,
                request.texture_upload_bytes_per_second,
                "持续纹理上传仅属于具有视频解码器的组合 GL 呈现",
            ));
        }
        if request.transcode_slots > MAX_TRANSCODE_SLOTS {
            return Err(BudgetRejection {
                quota: "request_shape",
                cap: u64::from(MAX_TRANSCODE_SLOTS),
                held: 0,
                requested: u64::from(request.transcode_slots),
                message: "P1 无视频转码额度（§5.1）；转码 adapter 落地前恒 0".into(),
            });
        }
        Ok(())
    }
}

impl BudgetUsage {
    pub(super) fn add_request(&mut self, request: &BudgetRequest) {
        self.targets += request.targets;
        if request.owner == OwnerKind::DesktopFrame {
            self.desktop_frames += 1;
        }
        self.contexts += request.contexts;
        self.decoder_slots += request.decoders;
        self.decode_pixel_rate += request.decode_pixel_rate;
        self.output_pixel_rate += request.output_pixel_rate;
        self.texture_upload_bytes_per_second += request.texture_upload_bytes_per_second;
        self.cpu_bytes += request.cpu_bytes;
        self.prepare_cpu_bytes += request.prepare_cpu_bytes;
        self.asset_cpu_bytes += request.asset_cpu_bytes;
        self.gpu_bytes += request.gpu_bytes;
        self.prepare_tasks += request.prepare_tasks;
        if request.owner == OwnerKind::Preview {
            self.preview_instances += 1;
        }
    }
}
