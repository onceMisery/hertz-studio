// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! R4-B accounting. Only provider adapters construct trusted token counters;
//! neither model output nor an HTTP client can submit a bill. All mutations run
//! inside the caller's BEGIN IMMEDIATE transaction, separate from task state.

use serde::{Deserialize, Serialize};
use vmusic_store::ai_jobs as store;

use super::jobs::{utc_month_key, MONTHLY_LIMIT_MICRO_USD, RESERVATION_MICRO_USD};
use crate::error::{internal, ApiResult};

pub(crate) const TOKEN_ONLY_PRICING_VERSION: &str = "token-usage-unpriced-v1";

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

impl PricingSnapshot {
    pub(crate) fn pricing_known(&self) -> bool {
        self.quote.pricing_version != TOKEN_ONLY_PRICING_VERSION
    }
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

pub(crate) async fn persist_pending_usage(
    db: &sqlx::SqlitePool,
    job: &store::JobRow,
    usage: &TrustedUsage,
) -> ApiResult<()> {
    if job.dispatch_state != "may_have_been_sent" {
        return Ok(());
    }
    let Some(attempt_id) = job.attempt_id.as_deref() else {
        return Ok(());
    };
    let usage_json = serde_json::to_string(usage).map_err(|error| internal(error.to_string()))?;
    let mut tx = vmusic_store::begin_immediate(db).await.map_err(db_error)?;
    store::insert_pending_usage(
        &mut *tx,
        &store::PendingUsageInsert {
            job_id: job.job_id.clone(),
            attempt_id: attempt_id.to_string(),
            owner_instance_id: job.owner_instance_id.clone(),
            usage_json: usage_json.clone(),
            created_at: vmusic_store::now_ms(),
        },
    )
    .await
    .map_err(db_error)?;
    let pending = store::find_pending_usage(&mut tx, &job.job_id, attempt_id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| internal("pending trusted usage was not persisted"))?;
    if pending.owner_instance_id != job.owner_instance_id || pending.usage_json != usage_json {
        return Err(internal("conflicting trusted usage for provider attempt"));
    }
    tx.commit()
        .await
        .map_err(|error| db_error(vmusic_core::StoreError::Database(error.to_string())))
}

fn price(snapshot: &str, reservation: i64, usage: &TrustedUsage) -> Result<i64, &'static str> {
    let snapshot: PricingSnapshot =
        serde_json::from_str(snapshot).map_err(|_| "missing verified pricing snapshot")?;
    snapshot.quote.validate()?;
    if snapshot.quote.reservation_micro_usd != reservation {
        return Err("reservation does not match pricing snapshot");
    }
    let amount = snapshot.quote.amount(usage)?;
    Ok(amount)
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
    settle_terminal_inner(conn, job, usage, now, true).await
}

/// Commit a terminal state from the durable dispatch marker even when trusted
/// provider usage is what caused a previous settlement transaction to fail.
/// The pending usage row stays available for `drain_pending_usage` to reconcile
/// after storage recovers.
pub(crate) async fn settle_terminal_unknown(
    conn: &mut sqlx::SqliteConnection,
    job: &store::JobRow,
    now: i64,
) -> ApiResult<()> {
    settle_terminal_inner(conn, job, None, now, false).await
}

async fn settle_terminal_inner(
    conn: &mut sqlx::SqliteConnection,
    job: &store::JobRow,
    usage: Option<&TrustedUsage>,
    now: i64,
    include_pending_usage: bool,
) -> ApiResult<()> {
    let pending = if include_pending_usage {
        if let Some(attempt_id) = job.attempt_id.as_deref() {
            store::find_pending_usage(&mut *conn, &job.job_id, attempt_id)
                .await
                .map_err(db_error)?
                .filter(|pending| pending.owner_instance_id == job.owner_instance_id)
        } else {
            None
        }
    } else {
        None
    };
    let pending_usage = pending
        .as_ref()
        .map(|pending| {
            serde_json::from_str::<TrustedUsage>(&pending.usage_json)
                .map_err(|error| internal(format!("invalid pending trusted usage: {error}")))
        })
        .transpose()?;
    let usage = pending_usage.as_ref().or(usage);
    if let Some(entry) = store::find_usage_entry(&mut *conn, &job.job_id)
        .await
        .map_err(db_error)?
    {
        let mut reconciled = false;
        if let (Some(usage), Some(attempt)) = (usage, job.attempt_id.as_deref()) {
            reconciled = reconcile(
                &mut *conn,
                &job.owner_instance_id,
                &job.job_id,
                attempt,
                entry.revision,
                usage,
            )
            .await?;
        }
        if reconciled {
            if let Some(pending) = pending.as_ref() {
                store::delete_pending_usage(&mut *conn, &pending.job_id, &pending.attempt_id)
                    .await
                    .map_err(db_error)?;
            }
        }
        return Ok(());
    }
    let dispatched = job.dispatch_state == "may_have_been_sent";
    let pricing = serde_json::from_str::<PricingSnapshot>(&job.pricing_snapshot).ok();
    let token_only = pricing
        .as_ref()
        .is_some_and(|snapshot| !snapshot.pricing_known());
    let mut charge = if dispatched && !token_only {
        job.reservation_micro_usd
    } else {
        0
    };
    let mut usage_state = if dispatched {
        if token_only {
            "unpriced"
        } else {
            "unknown"
        }
    } else {
        "released"
    };
    let mut reported_usage = None;
    if dispatched {
        if let Some(usage) = usage {
            let encoded = serde_json::to_string(usage).map_err(|e| internal(e.to_string()))?;
            reported_usage = Some(encoded.clone());
            // Provider counters are diagnostic; hard request bounds are enforced before dispatch.
            if !token_only {
                match price(&job.pricing_snapshot, job.reservation_micro_usd, usage) {
                    Ok(amount) => {
                        charge = amount;
                        usage_state = "reported";
                        if amount > job.reservation_micro_usd {
                            halt(
                                conn,
                                &job.owner_instance_id,
                                &job.job_id,
                                "trusted usage exceeded the accepted monetary reservation",
                            )
                            .await?;
                        }
                    }
                    Err(reason) => {
                        halt(conn, &job.owner_instance_id, &job.job_id, reason).await?;
                    }
                }
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
        // A trusted provider counter remains useful even when it cannot be priced.
        charge = if dispatched {
            job.reservation_micro_usd
        } else {
            0
        };
        usage_state = if dispatched {
            if token_only {
                "unpriced"
            } else {
                "unknown"
            }
        } else {
            "released"
        };
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
        &store::UsageEntryInsert {
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
    if let Some(pending) = pending.as_ref() {
        store::delete_pending_usage(&mut *conn, &pending.job_id, &pending.attempt_id)
            .await
            .map_err(db_error)?;
    }
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
    if entry.owner_instance_id.as_deref() != Some(owner) {
        return Ok(false);
    }
    if entry.attempt_id.as_deref() != Some(attempt) {
        return Ok(false);
    }
    let encoded = serde_json::to_string(usage).map_err(|e| internal(e.to_string()))?;
    if entry.reported_usage.is_some() {
        return Ok(entry.reported_usage.as_deref() == Some(&encoded));
    }
    if entry.revision != expected_revision
        || !matches!(
            entry.usage_state.as_str(),
            "unknown" | "estimated_final" | "unpriced"
        )
    {
        return Ok(false);
    }
    let snapshot = serde_json::from_str::<PricingSnapshot>(&entry.pricing_snapshot).ok();
    let token_only = snapshot
        .as_ref()
        .is_some_and(|snapshot| !snapshot.pricing_known());
    if token_only {
        let updated = store::cas_report_usage(
            conn,
            job_id,
            attempt,
            expected_revision,
            0,
            "unpriced",
            &encoded,
        )
        .await
        .map_err(db_error)?;
        return Ok(updated);
    }
    let amount = match price(&entry.pricing_snapshot, entry.reservation_micro_usd, usage) {
        Ok(amount) => amount,
        Err(reason) => {
            halt(conn, owner, job_id, reason).await?;
            let updated = store::cas_report_usage(
                conn,
                job_id,
                attempt,
                expected_revision,
                entry.accounted_micro_usd,
                &entry.usage_state,
                &encoded,
            )
            .await
            .map_err(db_error)?;
            return Ok(updated);
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
        let _ = store::cas_report_usage(
            conn,
            job_id,
            attempt,
            expected_revision,
            entry.accounted_micro_usd,
            &entry.usage_state,
            &encoded,
        )
        .await
        .map_err(db_error)?;
        return Ok(false);
    }
    let Some(adjusted) = budget.charged_micro_usd.checked_add(delta) else {
        store::saturate_month_after_overflow(conn, &entry.accepted_month, 0)
            .await
            .map_err(db_error)?;
        halt(conn, owner, job_id, "usage month total overflow").await?;
        let _ = store::cas_report_usage(
            conn,
            job_id,
            attempt,
            expected_revision,
            entry.accounted_micro_usd,
            &entry.usage_state,
            &encoded,
        )
        .await
        .map_err(db_error)?;
        return Ok(false);
    };
    if adjusted < 0 {
        halt(conn, owner, job_id, "usage month adjustment underflow").await?;
        let _ = store::cas_report_usage(
            conn,
            job_id,
            attempt,
            expected_revision,
            entry.accounted_micro_usd,
            &entry.usage_state,
            &encoded,
        )
        .await
        .map_err(db_error)?;
        return Ok(false);
    }
    if !store::cas_report_usage(
        conn,
        job_id,
        attempt,
        expected_revision,
        amount,
        "reported",
        &encoded,
    )
    .await
    .map_err(db_error)?
    {
        return Ok(false);
    }
    store::settle(conn, &entry.accepted_month, 0, delta)
        .await
        .map_err(db_error)?;
    if amount > entry.reservation_micro_usd {
        halt(
            conn,
            owner,
            job_id,
            "trusted usage exceeded the accepted monetary reservation",
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
