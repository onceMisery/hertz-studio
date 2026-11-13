// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Rejection storage is inline; text is rendered by its original consumer.
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BudgetDiagnostic {
    Literal(&'static str),
    Quota {
        quota: &'static str,
        cap: u64,
        held: u64,
        requested: u64,
        hint: &'static str,
    },
}

impl BudgetDiagnostic {
    pub(super) fn quota(
        quota: &'static str,
        cap: u64,
        held: u64,
        requested: u64,
        hint: &'static str,
    ) -> Self {
        Self::Quota {
            quota,
            cap,
            held,
            requested,
            hint,
        }
    }
}

impl From<&'static str> for BudgetDiagnostic {
    fn from(text: &'static str) -> Self {
        Self::Literal(text)
    }
}

impl fmt::Display for BudgetDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Literal(text) => formatter.write_str(text),
            Self::Quota {
                quota,
                cap,
                held,
                requested,
                hint,
            } => write!(
                formatter,
                "{quota} 超限：已占 {held} + 申请 {requested} > 上限 {cap}；{hint}"
            ),
        }
    }
}
