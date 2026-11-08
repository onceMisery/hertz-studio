// SPDX-License-Identifier: MIT
//! Bounded capture reservation. The exited capture workspace can be sealed and
//! returned while the independently charged native bitmap remains visible.
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};

use super::budget::{
    Allocation, BudgetCoordinator, BudgetRequest, OwnerKind, ResourceAmounts, ResourcePlan,
    SessionPlan,
};
use super::jobs::JobError;
use super::page_events::PageBinding;

pub(crate) const CAPTURE_PREFIX: &str = "wallpaper_capture ";
pub(crate) const MAX_CAPTURE_MESSAGE: usize = 3 * 1024 * 1024;
pub(crate) const CAPTURE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_TARGET_PIXELS: u64 = 16 * 1024 * 1024;

pub(crate) fn target_pixels(width: u32, height: u32) -> Result<u64, JobError> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || width > 32768 || height > 32768 || pixels > MAX_TARGET_PIXELS {
        return Err(JobError::invalid_input("静态交接目标超出位图上限"));
    }
    Ok(pixels)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureRequest {
    pub token: String,
    pub session_id: String,
    pub generation: u64,
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureReceipt {
    token: String,
    session_id: String,
    generation: u64,
    width: u32,
    height: u32,
    rgba: Option<String>,
    error: Option<String>,
}

pub(crate) struct CaptureHold {
    pub request: CaptureRequest,
    budget: Arc<BudgetCoordinator>,
    owner: String,
    parent: u64,
    allocations: Vec<Allocation>,
    workspace_released: bool,
    started: Instant,
    issued: bool,
    received: bool,
    source_closed: bool,
    retired: bool,
    finished: bool,
}

impl CaptureHold {
    pub(crate) fn reserve(
        budget: Arc<BudgetCoordinator>,
        binding: &PageBinding,
        width: u32,
        height: u32,
    ) -> Result<Self, JobError> {
        Self::reserve_for(budget, binding, width, height, false)
    }

    pub(crate) fn reserve_for(
        budget: Arc<BudgetCoordinator>,
        binding: &PageBinding,
        width: u32,
        height: u32,
        preview: bool,
    ) -> Result<Self, JobError> {
        if preview && (width > 640 || height > 360) {
            return Err(JobError::invalid_input("静态预览超出固定目标尺寸"));
        }
        let target_pixels = target_pixels(width, height)?;
        // Capture/encoding workspace plus the full physical-size staging DIB.
        // The compositor's retained copy and upload peak are also charged.
        let prepare_cpu_bytes = 64 * 1024 * 1024 + target_pixels * 4;
        let scale = (960.0 / f64::from(width))
            .min(540.0 / f64::from(height))
            .min(1.0);
        let width = (f64::from(width) * scale).floor().max(1.0) as u32;
        let height = (f64::from(height) * scale).floor().max(1.0) as u32;
        let token = super::file_tokens::random_token()?;
        let owner = format!("capture-{token}");
        let pixels = u64::from(width) * u64::from(height);
        let request = BudgetRequest {
            owner: if preview {
                OwnerKind::PreviewFrame
            } else {
                OwnerKind::DesktopFrame
            },
            session: owner.clone(),
            generation: binding.generation(),
            task_id: "static-handoff".into(),
            targets: 0,
            contexts: 0,
            decoders: 0,
            transcode_slots: 0,
            decode_pixel_rate: 0,
            output_pixel_rate: 0,
            cpu_bytes: pixels * 4,
            prepare_cpu_bytes,
            asset_cpu_bytes: 0,
            gpu_bytes: pixels * 12 + target_pixels * 8,
            prepare_tasks: 0,
        };
        let plan = SessionPlan::new(
            request,
            vec![
                ResourcePlan {
                    id: "capture-workspace".into(),
                    maximum: ResourceAmounts {
                        prepare_cpu_bytes,
                        gpu_bytes: pixels * 12,
                        ..Default::default()
                    },
                },
                ResourcePlan {
                    id: "static-bitmap".into(),
                    maximum: ResourceAmounts {
                        cpu_bytes: pixels * 4,
                        // Retain the full target upload/compositor estimate until
                        // the HWND exits; a source Close says nothing about DWM.
                        gpu_bytes: target_pixels * 8,
                        ..Default::default()
                    },
                },
            ],
        )?;
        let parent = budget.grant_session(&plan)?;
        let mut allocations = Vec::new();
        for resource in plan.resources() {
            match budget.allocate_resource(
                parent,
                &owner,
                binding.generation(),
                &resource.id,
                resource.maximum,
            ) {
                Ok(allocation) => allocations.push(allocation),
                Err(error) => {
                    let _ = budget.release(parent, &owner, binding.generation());
                    for allocation in allocations {
                        let _ =
                            budget.confirm_resource_exit(allocation, &owner, binding.generation());
                    }
                    let _ = budget.confirm_exit(parent, &owner, binding.generation());
                    let _ = budget.forget_released(parent, &owner, binding.generation());
                    return Err(error);
                }
            }
        }
        Ok(Self {
            request: CaptureRequest {
                token,
                session_id: binding.session_id().into(),
                generation: binding.generation(),
                width,
                height,
            },
            budget,
            owner,
            parent,
            allocations,
            workspace_released: false,
            started: Instant::now(),
            issued: false,
            received: false,
            source_closed: false,
            retired: false,
            finished: false,
        })
    }

    pub(crate) fn issue_script(&mut self) -> String {
        self.issued = true;
        format!(
            "window.hertzWallpaper && window.hertzWallpaper.requestCapture({});",
            serde_json::to_string(&self.request).expect("native capture")
        )
    }
    pub(crate) fn expired(&self) -> bool {
        self.issued && !self.received && self.started.elapsed() >= CAPTURE_TIMEOUT
    }
    pub(crate) fn received(&self) -> bool {
        self.received
    }
    pub(crate) fn source_closed(&mut self, generation: u64) {
        if self.request.generation == generation {
            self.source_closed = true;
        }
    }
    pub(crate) fn source_has_closed(&self) -> bool {
        self.source_closed
    }

    pub(crate) fn workspace_released(&self) -> bool {
        self.workspace_released
    }

    /// Called on a later event-loop tick, after the receipt handler and its
    /// message/decoded temporaries returned and all native staging handles exited.
    /// A timeout without a receipt cannot claim this early-release path.
    pub(crate) fn reap_workspace(&mut self, native_staging_exited: bool) -> Result<(), JobError> {
        if self.workspace_released
            || !self.received
            || !self.source_closed
            || !native_staging_exited
            || self.finished
        {
            return Ok(());
        }
        let workspace = self.allocations[0];
        self.budget
            .confirm_resource_exit(workspace, &self.owner, self.request.generation)?;
        self.budget
            .retire_resource_plan(workspace, &self.owner, self.request.generation)?;
        self.workspace_released = true;
        Ok(())
    }

    /// Bad identities and unsolicited/duplicate receipts do not alter the current
    /// request. Size/dimension validation precedes base64 allocation and conversion.
    pub(crate) fn accept(&mut self, message: &str) -> Option<Result<Vec<u8>, JobError>> {
        if !self.issued
            || self.received
            || self.retired
            || self.expired()
            || message.len() > MAX_CAPTURE_MESSAGE
        {
            return None;
        }
        let receipt: CaptureReceipt =
            serde_json::from_str(message.strip_prefix(CAPTURE_PREFIX)?).ok()?;
        if receipt.token != self.request.token
            || receipt.session_id != self.request.session_id
            || receipt.generation != self.request.generation
        {
            return None;
        }
        self.received = true;
        let failure = |text| JobError::new("capture_failed", text);
        if receipt.width != self.request.width || receipt.height != self.request.height {
            return Some(Err(failure("静态帧尺寸与原生额度不符")));
        }
        if let Some(error) = receipt.error {
            return Some(Err(failure(&format!(
                "旧画面无法保留：{}",
                error.chars().take(128).collect::<String>()
            ))));
        }
        let Some(encoded) = receipt.rgba else {
            return Some(Err(failure("静态帧缺少像素")));
        };
        let length = self.request.width as usize * self.request.height as usize * 4;
        if encoded.len() != length.div_ceil(3) * 4 {
            return Some(Err(failure("静态帧像素长度无效")));
        }
        let Ok(mut pixels) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            return Some(Err(failure("静态帧编码无效")));
        };
        if pixels.len() != length
            || pixels
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[3] != 255)
        {
            return Some(Err(failure("静态帧必须是完整不透明 RGBA")));
        }
        // GDI's top-down 32-bit DIB uses BGRA channel order.
        for pixel in pixels.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
        }
        Some(Ok(pixels))
    }
    pub(crate) fn retire(&mut self) {
        if !self.retired {
            let _ = self
                .budget
                .release(self.parent, &self.owner, self.request.generation);
            self.retired = true;
        }
    }
    pub(crate) fn finish(&mut self, bitmap_closed: bool) -> bool {
        if self.finished {
            return true;
        }
        if !self.retired || !bitmap_closed || (self.issued && !self.source_closed) {
            return false;
        }
        for &allocation in &self.allocations {
            if self
                .budget
                .confirm_resource_exit(allocation, &self.owner, self.request.generation)
                .is_err()
            {
                return false;
            }
        }
        if self
            .budget
            .confirm_exit(self.parent, &self.owner, self.request.generation)
            .is_err()
            || self
                .budget
                .forget_released(self.parent, &self.owner, self.request.generation)
                .is_err()
        {
            return false;
        }
        self.finished = true;
        true
    }
}
impl Drop for CaptureHold {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.retire();
        if !self.issued {
            self.finish(true);
        }
    }
}

#[cfg(test)]
#[path = "handoff_tests.rs"]
mod tests;
