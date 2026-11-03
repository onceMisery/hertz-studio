// SPDX-License-Identifier: MIT
//! Trusted builtin GL envelopes. Costs are reserved before any host mount command;
//! a published controller keeps the entire envelope until native Close succeeds.
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::budget::{
    self, Allocation, AllocationSnapshot, BudgetCoordinator, BudgetRequest, OwnerKind,
    ResourceAmounts, ResourcePlan, SessionPlan,
};
use super::jobs::JobError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    pixel_budget: u64,
    gpu_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlLimits {
    pub quality: String,
    pub requested_quality: String,
    pub fps: u32,
    pub requested_fps: u32,
    pub refresh_hz: u32,
    pub frame_divisor: u32,
    pub pixel_budget: u64,
    pub gpu_bytes: u64,
}

#[derive(Debug)]
pub(crate) struct GlPlan {
    pub limits: GlLimits,
    pub session: SessionPlan,
}

impl GlPlan {
    /// Existing/retiring owners remain counted at the handoff peak. A stale usage
    /// snapshot can only cause grant_session to reject; it cannot overdraw the ledger.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        budget: &BudgetCoordinator,
        owner: OwnerKind,
        session: String,
        generation: u64,
        width: u32,
        height: u32,
        refresh_hz: u32,
        fps: u32,
        quality: &str,
    ) -> Result<Self, JobError> {
        if !matches!(owner, OwnerKind::Desktop | OwnerKind::Preview)
            || width == 0
            || height == 0
            || width > 32768
            || height > 32768
            || !(5..=1000).contains(&refresh_hz)
            || !(1..=60).contains(&fps)
        {
            return Err(JobError::invalid_input("GL 呈现目标无效"));
        }
        let profiles: std::collections::BTreeMap<String, Profile> = serde_json::from_str(
            include_str!("../../../hertz-wallpaper/contracts/gl-budgets.json"),
        )
        .map_err(|_| JobError::new("gl_contract", "GL 质量合同无效"))?;
        let order = ["low", "medium", "high"];
        let requested = order
            .iter()
            .position(|&mode| mode == quality)
            .ok_or_else(|| JobError::invalid_input("GL 质量档位无效"))?;
        let usage = budget.usage();
        let available_gpu = budget::MAX_GPU_TRACKED_BYTES.saturating_sub(usage.gpu_bytes);
        let chosen = (0..=requested)
            .rev()
            .find(|&index| profiles[order[index]].gpu_bytes <= available_gpu)
            .ok_or_else(|| JobError::new("budget_busy", "GPU 额度等待旧呈现退出"))?;
        let profile = &profiles[order[chosen]];
        let effective_fps = if owner == OwnerKind::Preview {
            fps.min(15)
        } else {
            fps
        };
        let divisor = refresh_hz.div_ceil(effective_fps);
        let rate_cap = if owner == OwnerKind::Preview {
            budget::PREVIEW_RESERVED_OUTPUT_RATE
                .min(budget::MAX_OUTPUT_PIXEL_RATE.saturating_sub(usage.output_pixel_rate))
        } else {
            (budget::MAX_OUTPUT_PIXEL_RATE - budget::PREVIEW_RESERVED_OUTPUT_RATE)
                .saturating_sub(usage.output_pixel_rate)
        };
        let target_pixels = u64::from(width) * u64::from(height);
        let pixels = target_pixels
            .min(profile.pixel_budget)
            .min(rate_cap * u64::from(divisor) / u64::from(refresh_hz));
        if pixels < target_pixels.min(256 * 144) {
            return Err(JobError::new("budget_busy", "输出像素额度等待旧呈现退出"));
        }
        let request = BudgetRequest {
            owner,
            session,
            generation,
            task_id: "builtin-gl".into(),
            targets: u32::from(owner == OwnerKind::Desktop),
            contexts: 1,
            decoders: 0,
            transcode_slots: 0,
            decode_pixel_rate: 0,
            output_pixel_rate: (pixels * u64::from(refresh_hz)).div_ceil(u64::from(divisor)),
            cpu_bytes: 0,
            prepare_cpu_bytes: 0,
            gpu_bytes: profile.gpu_bytes,
            prepare_tasks: 0,
        };
        let resource = ResourcePlan {
            id: "gl-renderer".into(),
            maximum: ResourceAmounts::from_request(&request),
        };
        Ok(Self {
            limits: GlLimits {
                quality: order[chosen].into(),
                requested_quality: quality.into(),
                fps: effective_fps,
                requested_fps: fps,
                refresh_hz,
                frame_divisor: divisor,
                pixel_budget: pixels,
                gpu_bytes: profile.gpu_bytes,
            },
            session: SessionPlan::new(request, vec![resource])?,
        })
    }
}

#[derive(Debug)]
pub(crate) struct GlAdmission {
    budget: Arc<BudgetCoordinator>,
    request: BudgetRequest,
    allocation: Allocation,
    pub limits: GlLimits,
    pub published: bool,
    retired: bool,
    closed: bool,
    finished: bool,
}

impl GlAdmission {
    pub(crate) fn new(plan: GlPlan, budget: Arc<BudgetCoordinator>) -> Result<Self, JobError> {
        let parent = budget.grant_session(&plan.session)?;
        let request = plan.session.request().clone();
        let resource = &plan.session.resources()[0];
        let allocation = match budget.allocate_resource(
            parent,
            &request.session,
            request.generation,
            &resource.id,
            resource.maximum,
        ) {
            Ok(allocation) => allocation,
            Err(error) => {
                let _ = budget.release(parent, &request.session, request.generation);
                let _ = budget.confirm_exit(parent, &request.session, request.generation);
                let _ = budget.forget_released(parent, &request.session, request.generation);
                return Err(error);
            }
        };
        Ok(Self {
            budget,
            request,
            allocation,
            limits: plan.limits,
            published: false,
            retired: false,
            closed: false,
            finished: false,
        })
    }
    pub(crate) fn generation(&self) -> u64 {
        self.request.generation
    }
    pub(crate) fn owner(&self) -> OwnerKind {
        self.request.owner
    }
    pub(crate) fn initialization_script(&self) -> String {
        let mut value = serde_json::to_value(&self.limits).expect("native GL limits");
        value["allocation"] = serde_json::to_value(self.allocation).expect("native GL allocation");
        value["generation"] = self.request.generation.into();
        format!("Object.defineProperty(window,'__hertzWallpaperGlAllocation',{{value:Object.freeze(Object.assign({value},{{allocation:Object.freeze({})}})),writable:false,configurable:false}});", serde_json::to_string(&self.allocation).expect("allocation"))
    }
    pub(crate) fn snapshot(&self) -> Option<AllocationSnapshot> {
        self.budget
            .allocation_snapshot(
                self.allocation.parent_token,
                &self.request.session,
                self.request.generation,
            )
            .ok()
    }
    pub(crate) fn retire(&mut self) {
        if !self.retired {
            let _ = self.budget.release(
                self.allocation.parent_token,
                &self.request.session,
                self.request.generation,
            );
            self.retired = true;
        }
    }
    pub(crate) fn controller_closed(&mut self) {
        self.closed = true;
    }
    pub(crate) fn finish(&mut self) -> bool {
        if self.finished {
            return true;
        }
        if !self.retired || !self.closed {
            return false;
        }
        if self
            .budget
            .confirm_resource_exit(
                self.allocation,
                &self.request.session,
                self.request.generation,
            )
            .is_err()
            || self
                .budget
                .confirm_exit(
                    self.allocation.parent_token,
                    &self.request.session,
                    self.request.generation,
                )
                .is_err()
            || self
                .budget
                .forget_released(
                    self.allocation.parent_token,
                    &self.request.session,
                    self.request.generation,
                )
                .is_err()
        {
            return false;
        }
        self.finished = true;
        true
    }
}
impl Drop for GlAdmission {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.retire();
        // Construction failure before publishing the surface cannot receive a host
        // mount/start command. Once published, Drop is never an exit receipt.
        if !self.published {
            self.closed = true;
            self.finish();
        }
    }
}

#[cfg(test)]
#[path = "gl_plan_tests.rs"]
mod tests;
