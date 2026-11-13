// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Read-only original-ledger projection: scalar facts, no resource authority.
use super::{
    BudgetCoordinator, BudgetRejection, BudgetRequest, BudgetUsage, Ledger, OwnerKind,
    ReservationState,
};

#[derive(Debug, Clone)]
pub(crate) struct BudgetProjection {
    usage: BudgetUsage,
    preview_output_held: u64,
}

impl BudgetProjection {
    pub(super) fn from_ledger(ledger: &Ledger, generations: &[u64]) -> Self {
        let mut usage = ledger.process_usage();
        let mut preview_output_held = 0;
        for entry in &ledger.reservations {
            if entry.state == ReservationState::Active
                && entry.request.owner == OwnerKind::Desktop
                && generations.contains(&entry.request.generation)
            {
                continue;
            }
            usage.reservation_records += 1;
            if entry.state == ReservationState::ReleasePending {
                usage.release_pending += 1;
            }
            if entry.state != ReservationState::Released {
                usage.add_request(&entry.request);
                if entry.request.owner == OwnerKind::Preview {
                    preview_output_held += entry.request.output_pixel_rate;
                }
            }
        }
        // The original copied projection intentionally omitted session/child
        // plans. Preserve that metadata-only snapshot and its record counts.
        Self {
            usage,
            preview_output_held,
        }
    }

    pub(crate) fn usage(&self) -> BudgetUsage {
        self.usage.clone()
    }

    pub(crate) fn check_requests(&self, requests: &[BudgetRequest]) -> Result<(), BudgetRejection> {
        let mut usage = self.usage.clone();
        let mut preview_output_held = self.preview_output_held;
        for request in requests {
            BudgetCoordinator::check_grant(request, &usage, preview_output_held)?;
            usage.reservation_records += 1;
            usage.add_request(request);
            if request.owner == OwnerKind::Preview {
                preview_output_held += request.output_pixel_rate;
            }
        }
        Ok(())
    }
}
