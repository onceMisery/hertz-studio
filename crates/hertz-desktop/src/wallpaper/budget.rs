// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 原生预算账本（设计 docs/desktop-wallpaper.md §12.1/§12.3，P1-04a）。
//!
//! 全局额度只能由 [`BudgetCoordinator`] 原子授予：所有配额在同一把锁内
//! 一次校验、一次入账，没有"先各自解码再上报"的窗口（C23）。JS 侧只接收
//! 分配结果，不复制第二份自适应算法（§12.1）。
//!
//! 生命周期合同（§12.3）：
//! - reservation token 绑定 ownerSession / sessionGeneration / taskId 与全部
//!   记账值；释放幂等，错误 owner 或旧代际不得改写账本。
//! - 暂停/取消是三段事实：`release` 只标记（C24：load 被取消但 decoder 尚未
//!   退出时，槽位仍占用，不提前给下一任务），`confirm_exit` 在真实 I/O/解码
//!   退出后才归还额度；未确认的占用进入 [`BudgetCoordinator::stuck`] 报告。
//! - 会话销毁由宿主在 controller/context 清理确认后 [`BudgetCoordinator::purge_session`]
//!   一次性清除，不依赖逐 token 退出回执。
//!
//! 预览语义（§12.1/§12.3）：实时预览全局 1 个，输出像素率在 120 MP/s 总额内
//! 先保留 8 MP/s——live 侧永远摸不到这 8 MP/s（"未打开时不创建资源"指资源，
//! 不是指账面额度）。导入探测与桌面/预览共用 2 个解码槽（§7.1）。

use std::sync::{Arc, Mutex, OnceLock};

#[path = "budget_allocations.rs"]
mod allocations;
pub(crate) use allocations::{
    Allocation, AllocationSnapshot, ResourceAmounts, ResourcePlan, SessionPlan,
};
use allocations::{SessionResources, SubReservation};

/// Native metadata is bounded independently of resource byte quotas.
const MAX_RESERVATIONS: usize = 64;
const MEMORY_METADATA_QUOTA: &str = "reservation_metadata";
const MEMORY_METADATA_HINT: &str = "等待退出确认并回收已结束的原生资源记录";
const MEMORY_PREPARE_QUOTA: &str = "prepare_cpu_bytes";
const MEMORY_PREPARE_HINT: &str = "图片准备工作区不足；使用更小输入或等待准备退出";
const MEMORY_ASSET_QUOTA: &str = "asset_cpu_bytes";
const MEMORY_ASSET_HINT: &str = "通用共享资源常驻额度不足；等待旧呈现退出";

/// Only valid ordinary memory grants' three possible rejection diagnostics.
/// Ledger::reject emits B bytes; Reservation::grant preserves its existing
/// quota prefix and formats M=B+quota+2. Original fmt estimated capacity <=2B,
/// String doubling has old+new <=3B. During the second format the original
/// String <=2B overlaps the new grow <=3M: 2B+3M. No external formatting runs.
pub(crate) fn ordinary_memory_grant_diagnostic_heap_bytes() -> Option<u64> {
    [
        (MEMORY_METADATA_QUOTA, MEMORY_METADATA_HINT),
        (MEMORY_PREPARE_QUOTA, MEMORY_PREPARE_HINT),
        (MEMORY_ASSET_QUOTA, MEMORY_ASSET_HINT),
    ]
    .into_iter()
    .try_fold(0, |maximum, (quota, hint)| {
        let body = quota
            .len()
            .checked_add(hint.len())?
            .checked_add(" 超限：已占  + 申请  > 上限 ；".len())?
            .checked_add(3 * "18446744073709551615".len())?;
        let mapped = body.checked_add(quota.len())?.checked_add(2)?;
        let peak = body.checked_mul(2)?.checked_add(mapped.checked_mul(3)?)?;
        Some(maximum.max(u64::try_from(peak).ok()?))
    })
}

/// Original ordinary grant (resources=None, empty children) metadata only.
/// Vec::new/push/retain has a largest 32->64 reallocation: old+new=96
/// actual private Reservation bodies. Each bounded request clone holds at most
/// 128 session + 64 task bytes. Caller-owned ticket strings are additional.
/// SessionResources, projections and process catalogs are excluded.
pub(crate) fn ordinary_grant_metadata_heap_bytes() -> Option<u64> {
    let bodies = MAX_RESERVATIONS
        .checked_add(MAX_RESERVATIONS / 2)?
        .checked_mul(std::mem::size_of::<Reservation>())?;
    let strings = MAX_RESERVATIONS.checked_mul(128 + 64)?;
    u64::try_from(bodies.checked_add(strings)?).ok()
}

/// 进程内唯一生产账本。导入准备/探测已接入；桌面与预览规划器沿用此 owner。
static BUDGET: OnceLock<Arc<BudgetCoordinator>> = OnceLock::new();

pub(crate) fn global() -> Arc<BudgetCoordinator> {
    // Preserve the original Arc even if the second catalog fails. Every return
    // crosses the same ledger lock; no consumer can observe a partial ready.
    let budget = BUDGET.get_or_init(|| Arc::new(BudgetCoordinator::new()));
    budget.initialize_catalogs();
    Arc::clone(budget)
}

/// 桌面呈现目标上限（§12.1）。
pub(crate) const MAX_PRESENTATION_TARGETS: u32 = 4;
/// 组合/三维 context 上限（§12.1；纯图片/视频轻后端不占 context）。
pub(crate) const MAX_GL_CONTEXTS: u32 = 4;
/// 视频解码槽：桌面、预览及导入探测合计（§12.1）。
pub(crate) const MAX_DECODER_SLOTS: u32 = 2;
/// 实时预览实例：全局最多 1（§12.1/§13.4）。
pub(crate) const MAX_PREVIEW_INSTANCES: u32 = 1;
/// 预览输出像素率保留额度（GL 提交 ≤15 fps、960×540 ≈ 7.8 MP/s，§12.1）。
pub(crate) const PREVIEW_RESERVED_OUTPUT_RATE: u64 = 8_000_000;
/// 视频解码像素率合计上限：编码宽×高×已验证帧率上界（§12.1/§12.2）。
pub(crate) const MAX_DECODE_PIXEL_RATE: u64 = 125_000_000;
/// 输出像素工作量合计上限：呈现像素×有效 FPS（§12.1/§12.2）。
pub(crate) const MAX_OUTPUT_PIXEL_RATE: u64 = 120_000_000;
/// Continuous VideoTexture uploads have their own global bytes/s envelope
/// (§10.3); a small drawing buffer does not reduce actual source texture traffic.
pub(crate) const MAX_TEXTURE_UPLOAD_BYTES_PER_SECOND: u64 = 256 * 1024 * 1024;
/// CPU 常驻解码资产上限（§12.1；导入工作区另计）。
pub(crate) const MAX_CPU_DECODED_BYTES: u64 = 128 * 1024 * 1024;
/// 通用共享资源（受信页面纹理池）的 CPU 常驻上限；与解码/准备工作区分开计量，
/// 避免内置 GL 会话挤占媒体解码额度。
pub(crate) const MAX_ASSET_CPU_BYTES: u64 = 128 * 1024 * 1024;
/// 原图准备的独立 CPU 工作区（§6.3；不占常驻解码额度）。
pub(crate) const MAX_PREPARE_CPU_BYTES: u64 = 320 * 1024 * 1024;
/// GPU 跟踪资源估计上限（§12.1；tracked estimate，不是实测显存）。
pub(crate) const MAX_GPU_TRACKED_BYTES: u64 = 384 * 1024 * 1024;
/// 资源准备任务槽（§12.1：一个；P1 不承诺视频转码，转码槽恒 0）。
pub(crate) const MAX_PREPARE_TASKS: u32 = 1;
/// P1 转码槽上限：转码 adapter 是后续独立工作包（§5.1/§6.2）。
pub(crate) const MAX_TRANSCODE_SLOTS: u32 = 0;

/// 预算申请方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OwnerKind {
    /// 桌面呈现会话。
    Desktop,
    /// Bounded static storage for an existing desktop target's handoff. This
    /// cannot create a renderer; all bitmap/workspace bytes remain charged.
    DesktopFrame,
    /// 实时预览（§13.4 租约；预览转应用先释放预览再为桌面申请）。
    Preview,
    /// Static storage within the existing preview owner; never another renderer.
    PreviewFrame,
    /// 导入期真实解码探测（§7.1；只解码，不呈现）。
    Probe,
}

/// 一次额度申请（§12.3 token 绑定字段的申请面）。
#[derive(Debug, Clone)]
pub(crate) struct BudgetRequest {
    pub owner: OwnerKind,
    /// ownerSession：会话/预览租约/导入任务的稳定标识。
    pub session: String,
    /// sessionGeneration：代际递增后旧代际不得再动账本。
    pub generation: u64,
    /// taskId：同一会话内区分多笔占用（如视频切换的新旧 decoder）。
    pub task_id: String,
    /// 桌面呈现目标数（Preview/Probe 必须为 0）。
    pub targets: u32,
    /// 组合/三维 GL context 数（轻后端为 0）。
    pub contexts: u32,
    /// 视频解码槽数。
    pub decoders: u32,
    /// 转码槽数（P1 必须为 0）。
    pub transcode_slots: u32,
    /// 解码像素率：编码宽×高×帧率上界。
    pub decode_pixel_rate: u64,
    /// 输出像素率：呈现像素×有效 FPS（Probe 必须为 0）。
    pub output_pixel_rate: u64,
    /// Actual RGBA source texture bytes × conservative active submit FPS.
    pub texture_upload_bytes_per_second: u64,
    /// CPU 常驻解码字节。
    pub cpu_bytes: u64,
    pub prepare_cpu_bytes: u64,
    /// 通用共享资源（受信页面纹理池等）的 CPU 常驻字节。
    pub asset_cpu_bytes: u64,
    /// GPU 跟踪字节（纹理/几何/RT/骨骼/字形/闲置池，§12.2）。
    pub gpu_bytes: u64,
    /// 资源准备任务槽数。
    pub prepare_tasks: u32,
}

impl BudgetRequest {
    fn has_valid_identity(&self) -> bool {
        !self.session.is_empty()
            && self.session.len() <= 128
            && self.generation != 0
            && hertz_wallpaper::valid_local_id(&self.task_id)
    }
}

/// 拒绝明细：哪个配额、占了多少、要多少、上限多少。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BudgetRejection {
    pub quota: &'static str,
    pub cap: u64,
    pub held: u64,
    pub requested: u64,
    pub message: String,
}

/// 释放/确认阶段的调用方身份错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LedgerError {
    /// token 不存在（已 purge 或从未授予）。
    UnknownToken,
    /// ownerSession 不匹配。
    OwnerMismatch,
    /// sessionGeneration 不匹配（旧代际不得改写新账本）。
    GenerationMismatch,
    /// A total reservation cannot exit while its allocated resources still have owners.
    ChildrenPending,
}

/// token 的三段状态：占用（计入额度）→ 释放中（仍占用，等真实退出）
/// → 已退出（只留墓碑供幂等调用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReservationState {
    Active,
    ReleasePending,
    Released,
}

#[derive(Debug)]
struct Reservation {
    token: u64,
    request: BudgetRequest,
    state: ReservationState,
    /// 授予时的 allocationRevision（§12.3）；本切片只记录，降档联动随
    /// 质量/会话工作包进入。
    allocation_revision: u64,
    resources: Option<SessionResources>,
    children: Vec<SubReservation>,
}

/// 当前占用快照（§12.4 最低诊断的账本侧字段）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BudgetUsage {
    pub targets: u32,
    pub desktop_frames: u32,
    pub contexts: u32,
    pub decoder_slots: u32,
    pub preview_instances: u32,
    pub decode_pixel_rate: u64,
    pub output_pixel_rate: u64,
    pub texture_upload_bytes_per_second: u64,
    pub cpu_bytes: u64,
    pub prepare_cpu_bytes: u64,
    pub asset_cpu_bytes: u64,
    pub gpu_bytes: u64,
    pub prepare_tasks: u32,
    /// release 后未 confirm_exit 的 token 数（"某个释放没有确认时保留占用并报告"）。
    pub release_pending: u32,
    pub session_reservations: u32,
    pub resource_allocations: u32,
    pub resource_release_pending: u32,
    pub reservation_records: u32,
    pub resource_records: u32,
}

/// Process storage belongs to this ledger, independently of session tokens.
/// The cold workspace and permanent tree are separate conservative quotas;
/// their sum is not a claim about the physical parser peak.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum SceneCatalogCharge {
    #[default]
    Uninitialized,
    Constructing {
        prepare_cpu_bytes: u64,
        asset_cpu_bytes: u64,
    },
    Initialized {
        asset_cpu_bytes: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CatalogKind {
    Scene,
    Composition,
}

/// Kept on the initializer's stack under the original ledger lock. Unwinding
/// drops partial parser resources before reaching this reservation's refund.
struct SceneCatalogReservation<'a> {
    ledger: &'a mut Ledger,
    kind: CatalogKind,
    retained: u64,
    committed: bool,
}

impl<'a> SceneCatalogReservation<'a> {
    fn reserve(
        ledger: &'a mut Ledger,
        bounds: hertz_wallpaper::manifest::ManifestHeapBounds,
    ) -> Result<Self, BudgetRejection> {
        Self::reserve_for(
            ledger,
            CatalogKind::Scene,
            bounds.catalog_cold_requested_bytes(),
            bounds.catalog_retained_requested_bytes(),
        )
    }

    fn reserve_for(
        ledger: &'a mut Ledger,
        kind: CatalogKind,
        cold: u64,
        retained: u64,
    ) -> Result<Self, BudgetRejection> {
        let usage = ledger.active_usage();
        for (quota, cap, held, requested) in [
            (
                "prepare_cpu_bytes",
                MAX_PREPARE_CPU_BYTES,
                usage.prepare_cpu_bytes,
                cold,
            ),
            (
                "asset_cpu_bytes",
                MAX_ASSET_CPU_BYTES,
                usage.asset_cpu_bytes,
                retained,
            ),
        ] {
            if requested > cap.saturating_sub(held) {
                return Err(Ledger::reject(
                    quota,
                    cap,
                    held,
                    requested,
                    "进程目录必须在冷构造前取得全部额度",
                ));
            }
        }
        assert_eq!(
            *ledger.catalog_charge_mut(kind),
            SceneCatalogCharge::Uninitialized
        );
        *ledger.catalog_charge_mut(kind) = SceneCatalogCharge::Constructing {
            prepare_cpu_bytes: cold,
            asset_cpu_bytes: retained,
        };
        Ok(Self {
            ledger,
            kind,
            retained,
            committed: false,
        })
    }

    fn commit(mut self) {
        // The original catalog has published successfully. Nothing fallible,
        // allocating or calling another owner may run before this inline commit.
        *self.ledger.catalog_charge_mut(self.kind) = SceneCatalogCharge::Initialized {
            asset_cpu_bytes: self.retained,
        };
        self.committed = true;
    }
}

impl Drop for SceneCatalogReservation<'_> {
    fn drop(&mut self) {
        if !self.committed {
            *self.ledger.catalog_charge_mut(self.kind) = SceneCatalogCharge::Uninitialized;
        }
    }
}

#[derive(Debug)]
struct Ledger {
    next_token: u64,
    revision: u64,
    scene_catalog: SceneCatalogCharge,
    composition_catalog: SceneCatalogCharge,
    reservations: Vec<Reservation>,
}

impl Ledger {
    fn catalog_charge_mut(&mut self, kind: CatalogKind) -> &mut SceneCatalogCharge {
        match kind {
            CatalogKind::Scene => &mut self.scene_catalog,
            CatalogKind::Composition => &mut self.composition_catalog,
        }
    }

    fn active_usage(&self) -> BudgetUsage {
        let mut usage = BudgetUsage::default();
        for charge in [self.scene_catalog, self.composition_catalog] {
            match charge {
                SceneCatalogCharge::Uninitialized => {}
                SceneCatalogCharge::Constructing {
                    prepare_cpu_bytes,
                    asset_cpu_bytes,
                } => {
                    usage.prepare_cpu_bytes += prepare_cpu_bytes;
                    usage.asset_cpu_bytes += asset_cpu_bytes;
                }
                SceneCatalogCharge::Initialized { asset_cpu_bytes } => {
                    usage.asset_cpu_bytes += asset_cpu_bytes;
                }
            }
        }
        for reservation in &self.reservations {
            usage.reservation_records += 1;
            usage.resource_records += reservation.children.len() as u32;
            // ReleasePending 仍占用额度（C24：真实退出前不还给下一任务）；
            // 只有确认退出的墓碑不计。
            if reservation.state == ReservationState::Released {
                continue;
            }
            let request = &reservation.request;
            usage.targets += request.targets;
            if request.owner == OwnerKind::DesktopFrame {
                usage.desktop_frames += 1;
            }
            usage.contexts += request.contexts;
            usage.decoder_slots += request.decoders;
            usage.decode_pixel_rate += request.decode_pixel_rate;
            usage.output_pixel_rate += request.output_pixel_rate;
            usage.texture_upload_bytes_per_second += request.texture_upload_bytes_per_second;
            usage.cpu_bytes += request.cpu_bytes;
            usage.prepare_cpu_bytes += request.prepare_cpu_bytes;
            usage.asset_cpu_bytes += request.asset_cpu_bytes;
            usage.gpu_bytes += request.gpu_bytes;
            usage.prepare_tasks += request.prepare_tasks;
            if request.owner == OwnerKind::Preview {
                usage.preview_instances += 1;
            }
            if reservation.resources.is_some() {
                usage.session_reservations += 1;
                for child in &reservation.children {
                    if child.state != ReservationState::Released {
                        usage.resource_allocations += 1;
                    }
                    if child.state == ReservationState::ReleasePending {
                        usage.resource_release_pending += 1;
                    }
                }
            }
        }
        usage.release_pending = self
            .reservations
            .iter()
            .filter(|reservation| reservation.state == ReservationState::ReleasePending)
            .count() as u32;
        usage
    }

    /// live（Desktop/Probe）可用的输出像素率上限：总额减去预览保留带。
    fn live_output_cap(&self) -> u64 {
        MAX_OUTPUT_PIXEL_RATE - PREVIEW_RESERVED_OUTPUT_RATE
    }

    fn reject(
        quota: &'static str,
        cap: u64,
        held: u64,
        requested: u64,
        hint: &str,
    ) -> BudgetRejection {
        BudgetRejection {
            quota,
            cap,
            held,
            requested,
            message: format!("{quota} 超限：已占 {held} + 申请 {requested} > 上限 {cap}；{hint}"),
        }
    }
}

/// 全局预算协调器：额度授予、两段释放、代际校验与会话清除的唯一真值表。
#[derive(Debug)]
pub(crate) struct BudgetCoordinator {
    ledger: Mutex<Ledger>,
}

impl Default for BudgetCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl BudgetCoordinator {
    pub(crate) fn new() -> Self {
        Self {
            ledger: Mutex::new(Ledger {
                next_token: 1,
                revision: 1,
                scene_catalog: SceneCatalogCharge::Uninitialized,
                composition_catalog: SceneCatalogCharge::Uninitialized,
                reservations: Vec::new(),
            }),
        }
    }

    fn initialize_catalogs(&self) {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if ledger.scene_catalog == SceneCatalogCharge::Uninitialized {
            // Inline source/layout queries allocate nothing and never initialize.
            let bounds = hertz_wallpaper::manifest::ManifestHeapBounds::for_bytes(0)
                .expect("scene catalog requires its verified heap source and layout");
            let reservation = SceneCatalogReservation::reserve(&mut ledger, bounds)
                .expect("scene catalog requires both original CPU quotas before construction");
            #[cfg(test)]
            composition_catalog_tests::before_construct(CatalogKind::Scene, reservation.ledger);
            let _ = hertz_wallpaper::catalog();
            reservation.commit();
        }
        if ledger.composition_catalog == SceneCatalogCharge::Uninitialized {
            let bounds = hertz_wallpaper::document::catalog::CompositionCatalogHeapBounds::for_embedded_catalog();
            #[cfg(test)]
            let bounds = composition_catalog_tests::qualify_composition(bounds);
            let bounds =
                bounds.expect("composition catalog requires its verified heap source and layout");
            let reservation = SceneCatalogReservation::reserve_for(
                &mut ledger,
                CatalogKind::Composition,
                bounds.cold_requested_bytes(),
                bounds.retained_requested_bytes(),
            )
            .expect("composition catalog requires both original CPU quotas before construction");
            #[cfg(test)]
            composition_catalog_tests::before_construct(
                CatalogKind::Composition,
                reservation.ledger,
            );
            let _ = hertz_wallpaper::document::catalog::composition_catalog();
            reservation.commit();
        }
    }

    /// 原子授予：全部配额一次校验，任一不过即整体拒绝（不部分入账）。
    pub(crate) fn grant(&self, request: &BudgetRequest) -> Result<u64, BudgetRejection> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Self::grant_locked(&mut ledger, request, None)
    }

    /// Read-only eventual replacement projection. Active desktop reservations
    /// are omitted only for native-selected generations; the real ledger keeps
    /// every byte until its original owner confirms exit. Never grants authority.
    pub(crate) fn project_desktop_replacement(&self, generations: &[u64]) -> Self {
        let ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Self {
            ledger: Mutex::new(Ledger {
                next_token: ledger.next_token,
                revision: ledger.revision,
                scene_catalog: ledger.scene_catalog,
                composition_catalog: ledger.composition_catalog,
                reservations: ledger
                    .reservations
                    .iter()
                    .filter(|entry| {
                        !(entry.state == ReservationState::Active
                            && entry.request.owner == OwnerKind::Desktop
                            && generations.contains(&entry.request.generation))
                    })
                    .map(|entry| Reservation {
                        token: entry.token,
                        request: entry.request.clone(),
                        state: entry.state,
                        allocation_revision: entry.allocation_revision,
                        resources: None,
                        children: vec![],
                    })
                    .collect(),
            }),
        }
    }

    /// Runs the same atomic shape/quota checks on a private projection, with no
    /// token/usage change in the original owner. Discovery is advisory only.
    pub(crate) fn check_requests(&self, requests: &[BudgetRequest]) -> Result<(), BudgetRejection> {
        let projection = self.project_desktop_replacement(&[]);
        let mut ledger = projection
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for request in requests {
            Self::grant_locked(&mut ledger, request, None)?;
        }
        Ok(())
    }

    fn grant_locked(
        ledger: &mut Ledger,
        request: &BudgetRequest,
        resources: Option<&[ResourcePlan]>,
    ) -> Result<u64, BudgetRejection> {
        Self::validate_shape(request)?;
        if ledger.reservations.len() >= MAX_RESERVATIONS {
            return Err(Ledger::reject(
                MEMORY_METADATA_QUOTA,
                MAX_RESERVATIONS as u64,
                ledger.reservations.len() as u64,
                1,
                MEMORY_METADATA_HINT,
            ));
        }
        let usage = ledger.active_usage();

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
            let live_held = usage
                .output_pixel_rate
                .saturating_sub(Self::preview_output_held(ledger));
            let cap = ledger.live_output_cap();
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

        let token = ledger.next_token;
        ledger.next_token += 1;
        ledger.revision += 1;
        let allocation_revision = ledger.revision;
        ledger.reservations.push(Reservation {
            token,
            request: request.clone(),
            state: ReservationState::Active,
            allocation_revision,
            resources: resources.map(SessionResources::from_plan),
            children: Vec::new(),
        });
        Ok(token)
    }

    fn preview_output_held(ledger: &Ledger) -> u64 {
        ledger
            .reservations
            .iter()
            .filter(|reservation| {
                reservation.state != ReservationState::Released
                    && reservation.request.owner == OwnerKind::Preview
            })
            .map(|reservation| reservation.request.output_pixel_rate)
            .sum()
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

    /// 释放（第一段）：标记 ReleasePending，额度仍占用，直到真实退出确认
    /// （C24）。幂等：重复 release 已释放中的 token 返回 Ok。
    pub(crate) fn release(
        &self,
        token: u64,
        session: &str,
        generation: u64,
    ) -> Result<(), LedgerError> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let reservation = Self::find_checked(&mut ledger, token, session, generation)?;
        if reservation.state == ReservationState::Active {
            reservation.state = ReservationState::ReleasePending;
            for child in &mut reservation.children {
                if child.state == ReservationState::Active {
                    child.state = ReservationState::ReleasePending;
                }
            }
            ledger.revision += 1;
        }
        Ok(())
    }

    /// 退出确认（第二段）：真实 I/O/解码/上传退出后归还额度（§12.3）。
    /// 幂等：对已 Released 的墓碑重复确认返回 Ok。
    pub(crate) fn confirm_exit(
        &self,
        token: u64,
        session: &str,
        generation: u64,
    ) -> Result<(), LedgerError> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let reservation = Self::find_checked(&mut ledger, token, session, generation)?;
        if reservation
            .children
            .iter()
            .any(|child| child.state != ReservationState::Released)
        {
            return Err(LedgerError::ChildrenPending);
        }
        if reservation.state != ReservationState::Released {
            reservation.state = ReservationState::Released;
            ledger.revision += 1;
        }
        Ok(())
    }

    /// 已确认退出的单 token 墓碑回收；不能借此清除同会话仍活动的其它代际。
    pub(crate) fn forget_released(
        &self,
        token: u64,
        session: &str,
        generation: u64,
    ) -> Result<bool, LedgerError> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if Self::find_checked(&mut ledger, token, session, generation)?.state
            != ReservationState::Released
        {
            return Ok(false);
        }
        ledger
            .reservations
            .retain(|reservation| reservation.token != token);
        ledger.revision += 1;
        Ok(true)
    }

    /// 会话销毁：宿主确认 controller/context 清理完成后一次性清除该会话的
    /// 指定代际的全部 token（含 pending 与墓碑），不影响同名会话的后继代际。
    /// 返回清除的 token 数。
    pub(crate) fn purge_session(&self, session: &str, generation: u64) -> usize {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let before = ledger.reservations.len();
        ledger.reservations.retain(|reservation| {
            reservation.request.session != session || reservation.request.generation != generation
        });
        let removed = before - ledger.reservations.len();
        if removed > 0 {
            ledger.revision += 1;
        }
        removed
    }

    /// 释放中未确认的占用清单（诊断报告用；§12.3"保留占用并报告"）。
    pub(crate) fn stuck(&self) -> Vec<(u64, String, String)> {
        let ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        ledger
            .reservations
            .iter()
            .filter(|reservation| reservation.state == ReservationState::ReleasePending)
            .map(|reservation| {
                (
                    reservation.token,
                    reservation.request.session.clone(),
                    reservation.request.task_id.clone(),
                )
            })
            .collect()
    }

    /// 当前占用快照（§12.4 账本侧最低诊断）。
    pub(crate) fn usage(&self) -> BudgetUsage {
        self.ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active_usage()
    }

    /// One read-only planning snapshot, including owners still awaiting exit.
    /// The revision and usage come from the same lock; only grant can reserve.
    pub(crate) fn planning_snapshot(&self) -> (u64, BudgetUsage) {
        let ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        (ledger.revision, ledger.active_usage())
    }

    #[cfg(test)]
    pub(crate) fn record_count_for_test(&self) -> usize {
        self.ledger
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .reservations
            .len()
    }

    fn find_checked<'ledger>(
        ledger: &'ledger mut Ledger,
        token: u64,
        session: &str,
        generation: u64,
    ) -> Result<&'ledger mut Reservation, LedgerError> {
        let reservation = ledger
            .reservations
            .iter_mut()
            .find(|reservation| reservation.token == token)
            .ok_or(LedgerError::UnknownToken)?;
        if reservation.request.session != session {
            return Err(LedgerError::OwnerMismatch);
        }
        if reservation.request.generation != generation {
            return Err(LedgerError::GenerationMismatch);
        }
        Ok(reservation)
    }
}

#[cfg(test)]
#[path = "budget_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "budget_allocations_tests.rs"]
mod allocation_tests;

#[cfg(test)]
pub(crate) use allocation_tests::measure_requested_heap;

#[cfg(test)]
#[path = "budget_catalog_tests.rs"]
mod catalog_tests;

#[cfg(test)]
#[path = "budget_composition_catalog_tests.rs"]
mod composition_catalog_tests;
