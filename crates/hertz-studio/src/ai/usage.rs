// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! R4-B accounting. Only provider adapters construct trusted token counters;
//! neither model output nor an HTTP client can submit a bill. All mutations run
//! inside the caller's BEGIN IMMEDIATE transaction, separate from task state.

use serde::{Deserialize, Serialize};
use vmusic_store::ai_jobs as store;

use super::jobs::{utc_month_key, MONTHLY_LIMIT_MICRO_USD, RESERVATION_MICRO_USD};
use crate::error::{internal, ApiResult};

fn db_error(error: vmusic_core::StoreError) -> crate::error::ApiError {
    crate::error::ApiError::from(vmusic_core::CoreError::Store(error))
}

/// This two-counter pricing model supports uncached input and total billable
/// output (including reasoning). Other billing dimensions require an explicit
/// adapter/contract extension; they must never silently be omitted.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceQuote {
    pub pricing_version: String,
    pub reservation_micro_usd: i64,
    pub input_micro_usd_per_million: u64,
    pub output_micro_usd_per_million: u64,
    pub max_input_tokens: u64,
    pub max_output_tokens: u64,
}

impl PriceQuote {
    pub(crate) fn fake() -> Self {
        Self {
            pricing_version: "fake-free-v1".into(),
            reservation_micro_usd: RESERVATION_MICRO_USD,
            input_micro_usd_per_million: 0,
            output_micro_usd_per_million: 0,
            max_input_tokens: 0,
            max_output_tokens: 0,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.pricing_version.is_empty()
            || self.pricing_version.len() > 128
            || !(0..=RESERVATION_MICRO_USD).contains(&self.reservation_micro_usd)
        {
            return Err("invalid provider price quote");
        }
        let upper = self.amount(&TrustedUsage {
            input_tokens: self.max_input_tokens,
            output_tokens: self.max_output_tokens,
        })?;
        if upper > self.reservation_micro_usd {
            return Err("provider quote exceeds reservation");
        }
        Ok(())
    }

    fn amount(&self, usage: &TrustedUsage) -> Result<i64, &'static str> {
        let input = u128::from(usage.input_tokens) * u128::from(self.input_micro_usd_per_million);
        let output =
            u128::from(usage.output_tokens) * u128::from(self.output_micro_usd_per_million);
        // Round each billable component up to an integer micro-USD.
        let amount = input
            .div_ceil(1_000_000)
            .checked_add(output.div_ceil(1_000_000))
            .ok_or("usage amount overflow")?;
        i64::try_from(amount).map_err(|_| "usage amount overflow")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PricingSnapshot {
    pub provider: String,
    pub model: String,
    #[serde(flatten)]
    pub quote: PriceQuote,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<super::credential::CredentialIdentity>,
}

/// Counters parsed from a managed provider response, never from StageIntent.
/// Missing or unverifiable usage is None, even on a successful task.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustedUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl TrustedUsage {
    pub(crate) fn free() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
        }
    }
}

fn price(
    snapshot: &str,
    reservation: i64,
    usage: &TrustedUsage,
) -> Result<(i64, bool), &'static str> {
    let snapshot: PricingSnapshot =
        serde_json::from_str(snapshot).map_err(|_| "missing verified pricing snapshot")?;
    snapshot.quote.validate()?;
    if snapshot.quote.reservation_micro_usd != reservation {
        return Err("reservation does not match pricing snapshot");
    }
    let amount = snapshot.quote.amount(usage)?;
    let exceeded = amount > reservation
        || usage.input_tokens > snapshot.quote.max_input_tokens
        || usage.output_tokens > snapshot.quote.max_output_tokens;
    Ok((amount, exceeded))
}

async fn halt(
    conn: &mut sqlx::SqliteConnection,
    owner: &str,
    job: &str,
    reason: &str,
) -> ApiResult<()> {
    store::halt_budget_guard(conn, owner, reason, job)
        .await
        .map_err(db_error)?;
    Ok(())
}

async fn check_limit(
    conn: &mut sqlx::SqliteConnection,
    owner: &str,
    job: &str,
    month: &str,
) -> ApiResult<()> {
    let budget = store::get_or_create_month(conn, month)
        .await
        .map_err(db_error)?;
    if budget
        .charged_micro_usd
        .checked_add(budget.reserved_micro_usd)
        .is_none_or(|total| total > MONTHLY_LIMIT_MICRO_USD)
    {
        halt(conn, owner, job, "已计费用与在途预留越过月预算限额").await?;
    }
    Ok(())
}

/// One terminal settlement releases the admission reservation exactly once.
/// A late managed response may correct an already-settled terminal task.
pub(crate) async fn settle_terminal(
    conn: &mut sqlx::SqliteConnection,
    job: &store::JobRow,
    usage: Option<&TrustedUsage>,
    now: i64,
) -> ApiResult<()> {
    if let Some(entry) = store::find_usage_entry(&mut *conn, &job.job_id)
        .await
        .map_err(db_error)?
    {
        if let (Some(usage), Some(attempt)) = (usage, job.attempt_id.as_deref()) {
            reconcile(
                conn,
                &job.owner_instance_id,
                &job.job_id,
                attempt,
                entry.revision,
                usage,
            )
            .await?;
        }
        return Ok(());
    }
    let dispatched = job.dispatch_state == "may_have_been_sent";
    let mut charge = if dispatched {
        job.reservation_micro_usd
    } else {
        0
    };
    let mut usage_state = if dispatched { "unknown" } else { "released" };
    let mut reported_usage = None;
    if dispatched {
        if let Some(usage) = usage {
            match price(&job.pricing_snapshot, job.reservation_micro_usd, usage) {
                Ok((amount, exceeded)) => {
                    charge = amount;
                    usage_state = "reported";
                    reported_usage =
                        Some(serde_json::to_string(usage).map_err(|e| internal(e.to_string()))?);
                    if exceeded {
                        halt(
                            conn,
                            &job.owner_instance_id,
                            &job.job_id,
                            "可信 usage 超出受理时的费用或 token 上界",
                        )
                        .await?;
                    }
                }
                Err(reason) => halt(conn, &job.owner_instance_id, &job.job_id, reason).await?,
            }
        }
    }
    let month = utc_month_key(job.created_at);
    let budget = store::get_or_create_month(conn, &month)
        .await
        .map_err(db_error)?;
    let month_overflow = budget.charged_micro_usd.checked_add(charge).is_none();
    if month_overflow {
        // Keep the per-task reservation estimate and saturate the aggregate so
        // later settlements cannot repeatedly fail on an unrepresentable sum.
        charge = if dispatched {
            job.reservation_micro_usd
        } else {
            0
        };
        usage_state = if dispatched { "unknown" } else { "released" };
        reported_usage = None;
        halt(
            conn,
            &job.owner_instance_id,
            &job.job_id,
            "usage month total overflow",
        )
        .await?;
    }
    if month_overflow {
        store::saturate_month_after_overflow(conn, &month, job.reservation_micro_usd)
            .await
            .map_err(db_error)?;
    } else {
        store::settle(conn, &month, job.reservation_micro_usd, charge)
            .await
            .map_err(db_error)?;
    }
    store::insert_usage_entry(
        &mut *conn,
        &store::UsageEntryRow {
            job_id: job.job_id.clone(),
            accepted_month: month.clone(),
            attempt_id: job.attempt_id.clone(),
            reservation_micro_usd: job.reservation_micro_usd,
            accounted_micro_usd: charge,
            usage_state: usage_state.into(),
            pricing_snapshot: job.pricing_snapshot.clone(),
            reported_usage,
            revision: 1,
            created_at: now,
        },
    )
    .await
    .map_err(db_error)?;
    check_limit(conn, &job.owner_instance_id, &job.job_id, &month).await
}

/// CAS corrects only estimates. Equal callbacks are no-ops even with an old
/// revision; conflicting or wrong-attempt callbacks cannot overwrite facts.
/// This works after job retention has purged the original task and proposal.
pub(crate) async fn reconcile(
    conn: &mut sqlx::SqliteConnection,
    owner: &str,
    job_id: &str,
    attempt: &str,
    expected_revision: i64,
    usage: &TrustedUsage,
) -> ApiResult<bool> {
    let Some(entry) = store::find_usage_entry(&mut *conn, job_id)
        .await
        .map_err(db_error)?
    else {
        return Ok(false);
    };
    if entry.attempt_id.as_deref() != Some(attempt) {
        return Ok(false);
    }
    let encoded = serde_json::to_string(usage).map_err(|e| internal(e.to_string()))?;
    if entry.usage_state == "reported" {
        return Ok(entry.reported_usage.as_deref() == Some(&encoded));
    }
    if entry.revision != expected_revision
        || !matches!(entry.usage_state.as_str(), "unknown" | "estimated_final")
    {
        return Ok(false);
    }
    let (amount, exceeded) =
        match price(&entry.pricing_snapshot, entry.reservation_micro_usd, usage) {
            Ok(price) => price,
            Err(reason) => {
                halt(conn, owner, job_id, reason).await?;
                return Ok(false);
            }
        };
    let delta = amount
        .checked_sub(entry.accounted_micro_usd)
        .ok_or_else(|| internal("usage delta overflow"))?;
    let budget = store::get_or_create_month(conn, &entry.accepted_month)
        .await
        .map_err(db_error)?;
    if budget.charged_micro_usd == i64::MAX {
        halt(conn, owner, job_id, "usage month total overflow").await?;
        return Ok(false);
    }
    let Some(adjusted) = budget.charged_micro_usd.checked_add(delta) else {
        store::saturate_month_after_overflow(conn, &entry.accepted_month, 0)
            .await
            .map_err(db_error)?;
        halt(conn, owner, job_id, "usage month total overflow").await?;
        return Ok(false);
    };
    if adjusted < 0 {
        halt(conn, owner, job_id, "usage month adjustment underflow").await?;
        return Ok(false);
    }
    if !store::cas_report_usage(conn, job_id, attempt, expected_revision, amount, &encoded)
        .await
        .map_err(db_error)?
    {
        return Ok(false);
    }
    store::settle(conn, &entry.accepted_month, 0, delta)
        .await
        .map_err(db_error)?;
    if exceeded {
        halt(
            conn,
            owner,
            job_id,
            "可信 usage 超出受理时的费用或 token 上界",
        )
        .await?;
    }
    check_limit(conn, owner, job_id, &entry.accepted_month).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_round_up_and_reject_unbounded_quotes() {
        let mut quote = PriceQuote {
            pricing_version: "test-v1".into(),
            reservation_micro_usd: 2,
            input_micro_usd_per_million: 1,
            output_micro_usd_per_million: 1,
            max_input_tokens: 1,
            max_output_tokens: 1,
        };
        assert!(quote.validate().is_ok());
        assert_eq!(
            quote.amount(&TrustedUsage {
                input_tokens: 1,
                output_tokens: 1
            }),
            Ok(2)
        );
        quote.reservation_micro_usd = 1;
        assert!(quote.validate().is_err());
        quote.reservation_micro_usd = RESERVATION_MICRO_USD + 1;
        assert!(quote.validate().is_err());
        quote.reservation_micro_usd = -1;
        assert!(quote.validate().is_err());
        quote.input_micro_usd_per_million = u64::MAX;
        assert!(quote
            .amount(&TrustedUsage {
                input_tokens: u64::MAX,
                output_tokens: u64::MAX
            })
            .is_err());
    }
}
