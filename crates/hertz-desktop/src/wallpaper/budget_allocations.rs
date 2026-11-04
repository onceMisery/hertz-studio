// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Target plans reserve globally once. Resource allocations subdivide that reservation
//! under the same ledger lock, never create another target/preview or borrow unused global space.
use super::*;
use crate::wallpaper::jobs::JobError;
use serde::Serialize;

const MAX_RESOURCES: usize = 256;
const MAX_SUBTOKENS: usize = 256;

type Result<T> = std::result::Result<T, JobError>;

/// Costs only: identity, desktop targets and the single preview belong to the parent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceAmounts {
    pub contexts: u64,
    pub decoders: u64,
    pub transcode_slots: u64,
    pub decode_pixel_rate: u64,
    pub output_pixel_rate: u64,
    pub cpu_bytes: u64,
    pub prepare_cpu_bytes: u64,
    pub asset_cpu_bytes: u64,
    pub gpu_bytes: u64,
    pub prepare_tasks: u64,
}

impl ResourceAmounts {
    pub(crate) fn from_request(request: &BudgetRequest) -> Self {
        Self {
            contexts: u64::from(request.contexts),
            decoders: u64::from(request.decoders),
            transcode_slots: u64::from(request.transcode_slots),
            decode_pixel_rate: request.decode_pixel_rate,
            output_pixel_rate: request.output_pixel_rate,
            cpu_bytes: request.cpu_bytes,
            prepare_cpu_bytes: request.prepare_cpu_bytes,
            asset_cpu_bytes: request.asset_cpu_bytes,
            gpu_bytes: request.gpu_bytes,
            prepare_tasks: u64::from(request.prepare_tasks),
        }
    }

    fn checked_add(self, other: Self) -> Result<Self> {
        macro_rules! add { ($($field:ident),*) => { Self { $($field: self.$field.checked_add(other.$field)
            .ok_or_else(|| JobError::new("budget_exceeded", concat!(stringify!($field), " resource sum overflow")))?,)* } }; }
        Ok(add!(
            contexts,
            decoders,
            transcode_slots,
            decode_pixel_rate,
            output_pixel_rate,
            cpu_bytes,
            prepare_cpu_bytes,
            asset_cpu_bytes,
            gpu_bytes,
            prepare_tasks
        ))
    }

    fn check_within(self, limit: Self) -> Result<()> {
        macro_rules! check { ($($field:ident),*) => { $(if self.$field > limit.$field {
            return Err(JobError::new("budget_exceeded", format!("{}: resource allocation {} exceeds reserved {}",
                stringify!($field), self.$field, limit.$field)));
        })* }; }
        check!(
            contexts,
            decoders,
            transcode_slots,
            decode_pixel_rate,
            output_pixel_rate,
            cpu_bytes,
            prepare_cpu_bytes,
            asset_cpu_bytes,
            gpu_bytes,
            prepare_tasks
        );
        Ok(())
    }

    fn subtract_from(self, request: &mut BudgetRequest) -> Result<()> {
        self.check_within(Self::from_request(request))?;
        // The bounds check also proves these counter conversions fit in u32.
        request.contexts -= self.contexts as u32;
        request.decoders -= self.decoders as u32;
        request.transcode_slots -= self.transcode_slots as u32;
        request.prepare_tasks -= self.prepare_tasks as u32;
        macro_rules! subtract { ($($field:ident),*) => { $(request.$field -= self.$field;)* }; }
        subtract!(
            decode_pixel_rate,
            output_pixel_rate,
            cpu_bytes,
            prepare_cpu_bytes,
            asset_cpu_bytes,
            gpu_bytes
        );
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ResourcePlan {
    pub id: String,
    pub maximum: ResourceAmounts,
}

/// Constructed only from a trusted target planner. No page request can add a planned resource.
#[derive(Debug)]
pub(crate) struct SessionPlan {
    request: BudgetRequest,
    resources: Vec<ResourcePlan>,
}

impl SessionPlan {
    pub(crate) fn new(request: BudgetRequest, resources: Vec<ResourcePlan>) -> Result<Self> {
        if !matches!(
            request.owner,
            OwnerKind::Desktop | OwnerKind::Preview | OwnerKind::PreviewFrame
        ) || request.session.is_empty()
            || request.session.len() > 128
            || request.generation == 0
            || request.task_id.len() > 64
            || !hertz_wallpaper::valid_local_id(&request.task_id)
            || resources.is_empty()
            || resources.len() > MAX_RESOURCES
        {
            return Err(JobError::invalid_input(
                "会话预算计划的 owner、代际或资源数量无效",
            ));
        }
        let mut total = ResourceAmounts::default();
        let mut ids = std::collections::HashSet::new();
        for resource in &resources {
            if resource.id.len() > 64
                || !hertz_wallpaper::valid_local_id(&resource.id)
                || !ids.insert(resource.id.as_str())
            {
                return Err(JobError::invalid_input("资源计划 id 必须有效且唯一"));
            }
            total = total.checked_add(resource.maximum)?;
        }
        total.check_within(ResourceAmounts::from_request(&request))?;
        Ok(Self { request, resources })
    }

    pub(crate) fn request(&self) -> &BudgetRequest {
        &self.request
    }
    pub(crate) fn resources(&self) -> &[ResourcePlan] {
        &self.resources
    }
}

#[derive(Debug)]
pub(super) struct SessionResources {
    plan: Vec<ResourcePlan>,
    retired: std::collections::HashSet<String>,
}

#[derive(Debug)]
pub(super) struct SubReservation {
    token: u64,
    resource: String,
    amounts: ResourceAmounts,
    pub(super) state: ReservationState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Allocation {
    pub token: u64,
    pub parent_token: u64,
    pub allocation_revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AllocationSnapshot {
    pub allocation_revision: u64,
    pub reserved: ResourceAmounts,
    pub allocated: ResourceAmounts,
    pub active: usize,
    pub release_pending: usize,
}

fn identity(error: LedgerError) -> JobError {
    JobError::new(
        "allocation_identity",
        format!("资源预算身份不匹配：{error:?}"),
    )
}

impl BudgetCoordinator {
    pub(crate) fn grant_session(&self, plan: &SessionPlan) -> Result<u64> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if ledger.reservations.iter().any(|entry| {
            entry.resources.is_some()
                && entry.request.session == plan.request.session
                && entry.request.generation == plan.request.generation
        }) {
            return Err(JobError::new(
                "allocation_identity",
                "当前会话代际已有总保留额度",
            ));
        }
        Self::grant_locked(
            &mut ledger,
            &plan.request,
            Some(SessionResources {
                plan: plan.resources.clone(),
                retired: Default::default(),
            }),
        )
        .map_err(|error| {
            JobError::new("budget_busy", format!("{}: {}", error.quota, error.message))
        })
    }

    pub(crate) fn allocate_resource(
        &self,
        parent: u64,
        session: &str,
        generation: u64,
        resource: &str,
        amounts: ResourceAmounts,
    ) -> Result<Allocation> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let token = ledger.next_token;
        let reservation =
            Self::find_checked(&mut ledger, parent, session, generation).map_err(identity)?;
        if reservation.state != ReservationState::Active {
            return Err(JobError::new(
                "allocation_retiring",
                "会话正在退出，不能分配新资源",
            ));
        }
        let plan = reservation
            .resources
            .as_ref()
            .ok_or_else(|| JobError::invalid_input("需要会话总保留额度"))?;
        if plan.retired.contains(resource) {
            return Err(JobError::new(
                "resource_plan_retired",
                "资源计划已结束，必须重新准入新会话",
            ));
        }
        let maximum = plan
            .plan
            .iter()
            .find(|entry| entry.id == resource)
            .ok_or_else(|| JobError::new("resource_not_planned", "资源不属于当前原生目标计划"))?
            .maximum;
        if reservation.children.len() >= MAX_SUBTOKENS {
            return Err(JobError::new(
                "budget_busy",
                "资源子额度记录已满，请等待已退出记录回收",
            ));
        }
        let mut resource_total = amounts;
        let mut session_total = amounts;
        for child in &reservation.children {
            if child.state == ReservationState::Released {
                continue;
            }
            session_total = session_total.checked_add(child.amounts)?;
            if child.resource == resource {
                resource_total = resource_total.checked_add(child.amounts)?;
            }
        }
        resource_total.check_within(maximum)?;
        session_total.check_within(ResourceAmounts::from_request(&reservation.request))?;
        let allocation = Allocation {
            token,
            parent_token: parent,
            allocation_revision: reservation.allocation_revision,
        };
        reservation.children.push(SubReservation {
            token,
            resource: resource.to_string(),
            amounts,
            state: ReservationState::Active,
        });
        ledger.next_token += 1;
        ledger.revision += 1;
        Ok(allocation)
    }

    pub(crate) fn release_resource(
        &self,
        allocation: Allocation,
        session: &str,
        generation: u64,
    ) -> Result<()> {
        self.change_resource(
            allocation,
            session,
            generation,
            ReservationState::ReleasePending,
        )
    }

    /// The resource owner calls this only after its actual I/O/decoder/GL lifetime ends.
    /// It restores capacity within the parent, never returns that parent's global reservation.
    pub(crate) fn confirm_resource_exit(
        &self,
        allocation: Allocation,
        session: &str,
        generation: u64,
    ) -> Result<()> {
        self.change_resource(allocation, session, generation, ReservationState::Released)
    }

    /// Permanently relinquish a planned resource's global envelope after every
    /// child has physically exited. Unlike a reusable child release, this seals
    /// the resource id for the rest of the parent lifetime. Other tokens keep
    /// their original identity; the global ledger revision records the reduction.
    pub(crate) fn retire_resource_plan(
        &self,
        allocation: Allocation,
        session: &str,
        generation: u64,
    ) -> Result<()> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let reservation =
            Self::find_checked(&mut ledger, allocation.parent_token, session, generation)
                .map_err(identity)?;
        if allocation.allocation_revision != reservation.allocation_revision {
            return Err(JobError::new("allocation_identity", "资源额度修订不匹配"));
        }
        if reservation.state == ReservationState::Released {
            return Err(JobError::new("allocation_retiring", "会话已退出"));
        }
        let resource = &reservation
            .children
            .iter()
            .find(|child| child.token == allocation.token)
            .ok_or_else(|| JobError::new("allocation_identity", "资源子额度不存在"))?
            .resource;
        if reservation
            .children
            .iter()
            .any(|child| child.resource == *resource && child.state != ReservationState::Released)
        {
            return Err(JobError::new(
                "resource_exit_pending",
                "资源仍有未确认退出的子额度",
            ));
        }
        let plan = reservation
            .resources
            .as_mut()
            .ok_or_else(|| JobError::invalid_input("需要会话总保留额度"))?;
        if plan.retired.contains(resource) {
            return Ok(());
        }
        let maximum = plan
            .plan
            .iter()
            .find(|entry| entry.id == *resource)
            .ok_or_else(|| JobError::new("resource_not_planned", "资源不属于当前原生目标计划"))?
            .maximum;
        maximum.subtract_from(&mut reservation.request)?;
        plan.retired.insert(resource.clone());
        ledger.revision += 1;
        Ok(())
    }

    fn change_resource(
        &self,
        allocation: Allocation,
        session: &str,
        generation: u64,
        state: ReservationState,
    ) -> Result<()> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let reservation =
            Self::find_checked(&mut ledger, allocation.parent_token, session, generation)
                .map_err(identity)?;
        if allocation.allocation_revision != reservation.allocation_revision {
            return Err(JobError::new("allocation_identity", "资源额度修订不匹配"));
        }
        let child = reservation
            .children
            .iter_mut()
            .find(|entry| entry.token == allocation.token)
            .ok_or_else(|| JobError::new("allocation_identity", "资源子额度不存在"))?;
        if child.state != ReservationState::Released && child.state != state {
            child.state = state;
            ledger.revision += 1;
        }
        Ok(())
    }

    pub(crate) fn forget_resource(
        &self,
        allocation: Allocation,
        session: &str,
        generation: u64,
    ) -> Result<bool> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let reservation =
            Self::find_checked(&mut ledger, allocation.parent_token, session, generation)
                .map_err(identity)?;
        if allocation.allocation_revision != reservation.allocation_revision {
            return Err(JobError::new("allocation_identity", "资源额度修订不匹配"));
        }
        let child = reservation
            .children
            .iter()
            .find(|entry| entry.token == allocation.token)
            .ok_or_else(|| JobError::new("allocation_identity", "资源子额度不存在"))?;
        if child.state != ReservationState::Released {
            return Ok(false);
        }
        reservation
            .children
            .retain(|child| child.token != allocation.token);
        ledger.revision += 1;
        Ok(true)
    }

    pub(crate) fn allocation_snapshot(
        &self,
        parent: u64,
        session: &str,
        generation: u64,
    ) -> Result<AllocationSnapshot> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let reservation =
            Self::find_checked(&mut ledger, parent, session, generation).map_err(identity)?;
        let mut allocated = ResourceAmounts::default();
        let mut active = 0;
        let mut release_pending = 0;
        for child in &reservation.children {
            if child.state == ReservationState::Released {
                continue;
            }
            allocated = allocated.checked_add(child.amounts)?;
            active += 1;
            release_pending += usize::from(child.state == ReservationState::ReleasePending);
        }
        Ok(AllocationSnapshot {
            allocation_revision: reservation.allocation_revision,
            reserved: ResourceAmounts::from_request(&reservation.request),
            allocated,
            active,
            release_pending,
        })
    }
}
