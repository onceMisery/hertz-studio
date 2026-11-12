// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Bootstrap the original process ledger while it is still on the stack.
//! The OnceLock retains its Arc and reservation backing for the process life;
//! no session token may refund either allocation.
use super::{BudgetCoordinator, Reservation, MAX_ASSET_CPU_BYTES, MAX_RESERVATIONS};
use std::{alloc::Layout, sync::atomic::AtomicUsize, sync::Arc};

pub(super) fn retained_requested_bytes() -> Option<u64> {
    // Rust 1.88 and stable ArcInner is repr(C): two atomic counters then T.
    // Reproduce its checked extend/pad_to_align using the real private T.
    let arc = Layout::new::<[AtomicUsize; 2]>()
        .extend(Layout::new::<BudgetCoordinator>())
        .ok()?
        .0
        .pad_to_align();
    let records = Layout::array::<Reservation>(MAX_RESERVATIONS).ok()?;
    u64::try_from(arc.size().checked_add(records.size())?).ok()
}

impl BudgetCoordinator {
    pub(super) fn new_process() -> Arc<Self> {
        let retained = retained_requested_bytes()
            .expect("process ledger requires its checked Arc and reservation layout");
        assert!(retained <= MAX_ASSET_CPU_BYTES);
        let mut budget = Self::new();
        let ledger = budget.ledger.get_mut().unwrap_or_else(|e| e.into_inner());
        // Both fees are booked before the first heap allocation. The remaining
        // original grants and catalog initializers observe this same ledger.
        ledger.coordinator_asset_cpu_bytes = retained;
        #[cfg(test)]
        super::bootstrap_tests::before_allocate("records", ledger);
        ledger.reservations = Vec::with_capacity(MAX_RESERVATIONS);
        #[cfg(test)]
        super::bootstrap_tests::before_allocate("arc", ledger);
        Arc::new(budget)
    }
}
