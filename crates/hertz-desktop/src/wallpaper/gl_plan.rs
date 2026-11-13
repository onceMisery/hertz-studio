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

/// Three 0.186.0's original empty 2D/cube/3D/array textures retain 36 bytes.
/// Its six cube-face storage replacements can overlap another 60 bytes under
/// the original native GL fence discipline: 4+8+12+16+20. Reserve that real peak.
pub(crate) const THREE_BOOTSTRAP_GPU_PEAK_BYTES: u64 = 96;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    pixel_budget: u64,
    gpu_bytes: u64,
}

fn profiles() -> Result<std::collections::BTreeMap<String, Profile>, JobError> {
    serde_json::from_str(include_str!(
        "../../../hertz-wallpaper/contracts/gl-budgets.json"
    ))
    .map_err(|_| JobError::new("gl_contract", "GL 质量合同无效"))
}

fn available_output_rate(owner: OwnerKind, usage: &budget::BudgetUsage) -> u64 {
    if owner == OwnerKind::Preview {
        budget::PREVIEW_RESERVED_OUTPUT_RATE
            .min(budget::MAX_OUTPUT_PIXEL_RATE.saturating_sub(usage.output_pixel_rate))
    } else {
        (budget::MAX_OUTPUT_PIXEL_RATE - budget::PREVIEW_RESERVED_OUTPUT_RATE)
            .saturating_sub(usage.output_pixel_rate)
    }
}

/// Native facts for the composition's single raster. Source limits are applied
/// by its planner; this owner supplies only the current native ceiling/rate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompositionOutputAllowance {
    pub budget_revision: u64,
    pub pixel_ceiling: u64,
    pub output_pixel_rate: u64,
    pub effective_fps: u32,
    pub refresh_hz: u32,
    pub frame_divisor: u32,
}

pub(crate) fn composition_output_allowance(
    budget: &BudgetCoordinator,
    owner: OwnerKind,
    refresh_hz: u32,
    requested_fps: u32,
    source_fps: u32,
    actual_quality: &str,
) -> Result<CompositionOutputAllowance, JobError> {
    if !matches!(owner, OwnerKind::Desktop | OwnerKind::Preview)
        || !(5..=1000).contains(&refresh_hz)
        || !(1..=60).contains(&requested_fps)
        || !(1..=60).contains(&source_fps)
    {
        return Err(JobError::invalid_input("组合输出帧率无效"));
    }
    let profiles = profiles()?;
    let profile = profiles
        .get(actual_quality)
        .ok_or_else(|| JobError::new("gl_contract", "GL 质量合同缺少实际档位"))?;
    let (budget_revision, usage) = budget.planning_snapshot();
    if profile.gpu_bytes > budget::MAX_GPU_TRACKED_BYTES.saturating_sub(usage.gpu_bytes) {
        return Err(JobError::new("budget_busy", "GPU 额度等待旧呈现退出"));
    }
    let mut effective_fps = requested_fps.min(source_fps);
    if owner == OwnerKind::Preview {
        effective_fps = effective_fps.min(15);
    }
    Ok(CompositionOutputAllowance {
        budget_revision,
        pixel_ceiling: profile.pixel_budget,
        output_pixel_rate: available_output_rate(owner, &usage),
        effective_fps,
        refresh_hz,
        frame_divisor: refresh_hz.div_ceil(effective_fps),
    })
}

/// 通用共享资源（受信页面纹理池）的原生信封。数值来自单一合同文件；
/// 页面在逐资源记账时只消耗该信封，不能放大它。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedAssetsEnvelope {
    pub max_entries: u64,
    pub max_entry_bytes: u64,
    pub cpu_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedAssetsContract {
    max_texts: u64,
    max_text_bytes: u64,
    max_covers: u64,
    max_cover_bytes: u64,
}

impl SharedAssetsContract {
    fn parse() -> Result<Self, JobError> {
        let contract: Self = serde_json::from_str(include_str!(
            "../../../hertz-wallpaper/contracts/shared-assets.json"
        ))
        .map_err(|_| JobError::new("asset_contract", "共享资源合同无效"))?;
        // 受信桌面页面只装载歌词纹理池（封面入口在受信页面资源中显式禁用）；
        // 封面上限只作为合同真值保存，不进入桌面/预览会话计划。
        if contract.max_texts == 0
            || contract.max_text_bytes == 0
            || contract.max_covers == 0
            || contract.max_cover_bytes == 0
            || contract
                .max_texts
                .checked_mul(contract.max_text_bytes)
                .is_none_or(|total| total > budget::MAX_ASSET_CPU_BYTES)
        {
            return Err(JobError::new("asset_contract", "共享资源合同越界"));
        }
        Ok(contract)
    }

    /// The trusted builtin page plans text textures only.
    fn envelope(&self) -> Result<SharedAssetsEnvelope, JobError> {
        let cpu_bytes = self
            .max_texts
            .checked_mul(self.max_text_bytes)
            .ok_or_else(|| JobError::new("asset_contract", "共享资源合同越界"))?;
        Ok(SharedAssetsEnvelope {
            max_entries: self.max_texts,
            max_entry_bytes: self.max_text_bytes,
            cpu_bytes,
        })
    }
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
    pub shared_assets: SharedAssetsEnvelope,
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
        usage: &budget::BudgetUsage,
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
        let profiles = profiles()?;
        let assets = SharedAssetsContract::parse()?;
        let envelope = assets.envelope()?;
        let order = ["low", "medium", "high"];
        let requested = order
            .iter()
            .position(|&mode| mode == quality)
            .ok_or_else(|| JobError::invalid_input("GL 质量档位无效"))?;
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
        let rate_cap = available_output_rate(owner, usage);
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
            texture_upload_bytes_per_second: 0,
            cpu_bytes: 0,
            prepare_cpu_bytes: 0,
            asset_cpu_bytes: envelope.cpu_bytes,
            gpu_bytes: profile.gpu_bytes,
            prepare_tasks: 0,
        };
        // gl-renderer owns every dimension it planned except the shared-asset
        // residency; SessionPlan validates that the two sub-plans together stay
        // within the parent request instead of each copying the whole envelope.
        let mut renderer_maximum = ResourceAmounts::from_request(&request);
        renderer_maximum.asset_cpu_bytes = 0;
        let resource = ResourcePlan {
            id: "gl-renderer".into(),
            maximum: renderer_maximum,
        };
        let shared_assets = ResourcePlan {
            id: "shared-assets".into(),
            maximum: ResourceAmounts {
                asset_cpu_bytes: envelope.cpu_bytes,
                ..Default::default()
            },
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
                shared_assets: envelope,
            },
            session: SessionPlan::new(request, vec![resource, shared_assets])?,
        })
    }
}

#[derive(Debug)]
pub(crate) struct GlAdmission {
    budget: Arc<BudgetCoordinator>,
    request: BudgetRequest,
    allocation: Allocation,
    assets: Allocation,
    pub limits: GlLimits,
    pub published: bool,
    retired: bool,
    closed: bool,
    finished: bool,
    composition: Option<CompositionAccess>,
}

struct CompositionAccess {
    _prepared: super::composition_plan::PreparedComposition,
    grant: super::access::MediaGrant,
    drain: Option<super::access::Drain>,
    url: String,
    page_limits: serde_json::Value,
}
impl std::fmt::Debug for CompositionAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompositionAccess")
            .field("url", &self.url)
            .finish()
    }
}

impl GlAdmission {
    pub(crate) fn new(plan: GlPlan, budget: Arc<BudgetCoordinator>) -> Result<Self, JobError> {
        let parent = budget.grant_session(&plan.session)?;
        let request = plan.session.request().clone();
        let resources = plan.session.resources();
        let mut children = Vec::with_capacity(resources.len());
        let result: Result<(), JobError> = (|| {
            for resource in resources {
                children.push(budget.allocate_resource(
                    parent,
                    &request.session,
                    request.generation,
                    &resource.id,
                    resource.maximum,
                )?);
            }
            Ok(())
        })();
        if let Err(error) = result {
            // release 级联已发出的子额度；已分配子额度需先确认真实退出
            //（构造失败即未发布，页面从未拿到挂载命令）。
            let _ = budget.release(parent, &request.session, request.generation);
            for token in &children {
                let _ = budget.confirm_resource_exit(*token, &request.session, request.generation);
            }
            let _ = budget.confirm_exit(parent, &request.session, request.generation);
            let _ = budget.forget_released(parent, &request.session, request.generation);
            return Err(error);
        }
        // GlPlan 固定提交 gl-renderer + shared-assets 两个资源计划。
        assert_eq!(children.len(), 2, "GL session plan resource count");
        let assets = children.pop().expect("shared-assets allocation");
        let allocation = children.pop().expect("gl-renderer allocation");
        Ok(Self {
            budget,
            request,
            allocation,
            assets,
            limits: plan.limits,
            published: false,
            retired: false,
            closed: false,
            finished: false,
            composition: None,
        })
    }
    pub(crate) fn bind_composition(
        &mut self,
        prepared: super::composition_plan::PreparedComposition,
        access: &super::access::MediaAccess,
        session_id: &str,
    ) -> Result<(), JobError> {
        if self.published || self.composition.is_some() {
            return Err(JobError::new(
                "stale_generation",
                "组合权限只能在发布前绑定一次",
            ));
        }
        let projection = prepared.projection(
            session_id,
            self.request.generation,
            self.allocation.allocation_revision,
            &self.limits,
        )?;
        let page_limits = projection["pageLimits"].clone();
        let bytes: Arc<[u8]> = serde_json::to_vec(&projection)
            .map_err(|error| JobError::io(error.to_string()))?
            .into();
        let hash = prepared.package_hash().to_owned();
        let path = format!("session/{session_id}/{}.json", self.request.generation);
        let url = super::webresource::files_url(&hash, &path)
            .ok_or_else(|| JobError::invalid_input("组合 session URI 无效"))?;
        let grant = access
            .grant_composition(
                self.request.generation,
                prepared.pins(),
                (hash, path),
                bytes,
            )
            .ok_or_else(|| JobError::new("stale_generation", "组合闭包权限未授予"))?;
        self.composition = Some(CompositionAccess {
            _prepared: prepared,
            grant,
            drain: None,
            url,
            page_limits,
        });
        Ok(())
    }
    pub(crate) fn composition_url(&self) -> Option<&str> {
        self.composition
            .as_ref()
            .map(|composition| composition.url.as_str())
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
        if let Some(composition) = &self.composition {
            value["composition"] = true.into();
            value["pageLimits"] = composition.page_limits.clone();
            value["compositionUrl"] = composition.url.clone().into();
        }
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
            if let Some(composition) = &mut self.composition {
                composition.drain = Some(composition.grant.revoke());
            }
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
        if self.composition.as_ref().is_some_and(|composition| {
            !composition
                .drain
                .as_ref()
                .is_some_and(super::access::Drain::is_drained)
        }) {
            return false;
        }
        // The immutable plan/payload pins leave only after Close and all native
        // queued/stream readers have exited, before its parent budget returns.
        self.composition.take();
        // 两个子额度都必须在真实退出后才归还：gl-renderer 随 context 销毁，
        // shared-assets 随受信页面（纹理池）销毁；两者都由 controller Close 屏障覆盖。
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
                .confirm_resource_exit(self.assets, &self.request.session, self.request.generation)
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
