// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Official manager-only ledger. No capability, model call or bill mutation.
use super::{
    jobs,
    usage::{PricingSnapshot, TrustedUsage},
};
use crate::{
    error::{bad_request, ApiError, ApiResult},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use vmusic_store::ai_ledger as store;

pub(crate) const PAGE_LIMIT: i64 = 50;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Query {
    pub month: Option<String>,
    pub usage_state: Option<String>,
    pub before_sort_at: Option<i64>,
    pub before_job_id: Option<String>,
    pub limit: Option<i64>,
}

impl Query {
    fn validate(&self) -> ApiResult<()> {
        if self
            .month
            .as_deref()
            .is_some_and(|month| month != "unassigned" && !valid_month(month))
        {
            return Err(bad_request("month 必须是 UTC YYYY-MM 或 unassigned"));
        }
        if self.usage_state.as_deref().is_some_and(|state| {
            !matches!(
                state,
                "reserved" | "reported" | "released" | "unknown" | "estimated_final"
            )
        }) {
            return Err(bad_request("不支持的费用状态"));
        }
        match (self.before_sort_at, self.before_job_id.as_deref()) {
            (None, None) => (),
            (Some(time), Some(id)) if time >= 0 && !id.is_empty() && id.len() <= 128 => (),
            _ => return Err(bad_request("账本游标需要成对的 sortAt 与 jobId")),
        }
        if self
            .limit
            .is_some_and(|limit| !(1..=PAGE_LIMIT).contains(&limit))
        {
            return Err(bad_request("账本每页条数必须为 1–50"));
        }
        Ok(())
    }
}

fn valid_month(month: &str) -> bool {
    let bytes = month.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().all(u8::is_ascii_digit)
        && matches!(month[5..].parse::<u8>(), Ok(1..=12))
}

fn db_error(error: vmusic_core::StoreError) -> ApiError {
    ApiError::from(vmusic_core::CoreError::Store(error))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Cursor {
    sort_at: i64,
    job_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    month: String,
    months: Vec<String>,
    budget: Option<Value>,
    guard: Option<Value>,
    entries: Vec<Value>,
    next_cursor: Option<Cursor>,
}

pub(crate) async fn read(state: &Arc<AppState>, query: Query) -> ApiResult<Page> {
    query.validate()?;
    jobs::sweep(state).await?;
    let owner = jobs::instance_owner(state).await?;
    let month = query
        .month
        .unwrap_or_else(|| jobs::utc_month_key(vmusic_store::now_ms()));
    let month_key = if month == "unassigned" { "" } else { &month };
    let limit = query.limit.unwrap_or(20);
    // One read snapshot: page and monthly totals cannot straddle a settlement.
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(vmusic_core::StoreError::Database(e.to_string())))?;
    let mut months = store::months(&mut tx, &owner).await.map_err(db_error)?;
    if !months.iter().any(|value| value == month_key) {
        months.push(month_key.into());
    }
    months.sort_by(|a, b| b.cmp(a));
    let budget = store::budget(&mut tx, month_key)
        .await
        .map_err(db_error)?
        .map(|row| {
            json!({
                "month": row.month, "chargedMicroUsd":row.charged_micro_usd.to_string(),
                "chargedTotalOverflowed": row.charged_micro_usd == i64::MAX,
                "reservedMicroUsd":row.reserved_micro_usd.to_string(), "revision":row.revision,
                "limitMicroUsd":jobs::MONTHLY_LIMIT_MICRO_USD.to_string(),
            })
        });
    let guard = vmusic_store::ai_jobs::budget_guard(&mut *tx).await.map_err(db_error)?
        .map(|guard| json!({"halted":guard.halted,"reason":guard.reason,"triggerJob":guard.trigger_job,"revision":guard.revision}));
    let mut rows = store::list(
        &mut tx,
        store::LedgerFilter {
            owner: &owner,
            month: month_key,
            usage_state: query.usage_state.as_deref(),
            before: query.before_sort_at.zip(query.before_job_id.as_deref()),
            limit: limit + 1,
        },
    )
    .await
    .map_err(db_error)?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = rows.last().filter(|_| has_more).map(|row| Cursor {
        sort_at: row.sort_at,
        job_id: row.job_id.clone(),
    });
    let entries = rows.into_iter().map(project).collect();
    tx.commit()
        .await
        .map_err(|e| db_error(vmusic_core::StoreError::Database(e.to_string())))?;
    Ok(Page {
        month,
        months,
        budget,
        guard,
        entries,
        next_cursor,
    })
}

fn project(row: store::LedgerRow) -> Value {
    let raw = serde_json::from_str::<Value>(&row.pricing_snapshot).ok();
    let identity = |key| {
        raw.as_ref()
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 256)
            .map(str::to_owned)
    };
    let snapshot = serde_json::from_str::<PricingSnapshot>(&row.pricing_snapshot)
        .ok()
        .filter(|price| {
            price.quote.validate().is_ok()
                && price.quote.reservation_micro_usd == row.reservation_micro_usd
        });
    let pricing = snapshot.as_ref().map(|price| json!({
        "provider":price.provider,"model":price.model,"pricingVersion":price.quote.pricing_version,
        "inputMicroUsdPerMillion":price.quote.input_micro_usd_per_million.to_string(),
        "outputMicroUsdPerMillion":price.quote.output_micro_usd_per_million.to_string(),
        "maxInputTokens":price.quote.max_input_tokens.to_string(),"maxOutputTokens":price.quote.max_output_tokens.to_string(),
    }));
    let reported = row.reported_usage.as_deref().and_then(|value| serde_json::from_str::<TrustedUsage>(value).ok())
        .map(|usage|json!({"inputTokens":usage.input_tokens.to_string(),"outputTokens":usage.output_tokens.to_string()}));
    json!({
        "jobId":row.job_id,"principal":row.principal,"taskState":row.task_state,
        "taskRetained":row.task_retained,"acceptedAt":row.accepted_at,"sortAt":row.sort_at,
        "recordedAt":row.recorded_at,"attemptId":row.attempt_id,
        "reservationMicroUsd":row.reservation_micro_usd.to_string(),
        "accountedMicroUsd":row.accounted_micro_usd.map(|amount| amount.to_string()),
        "usageState":row.usage_state,"revision":row.revision,
        "pricingVerified":snapshot.is_some(),"pricing":pricing,"reportedUsage":reported,
        "reportedUsageInvalid":row.reported_usage.is_some() && reported.is_none(),
        "provider":identity("provider"),"model":identity("model"),"pricingVersion":identity("pricingVersion"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_rejects_partial_cursor_invalid_month_status_and_unbounded_page() {
        for value in [
            json!({"month":"2026-00"}),
            json!({"month":"2026-13"}),
            json!({"month":"💣-01"}),
            json!({"usage_state":"free"}),
            json!({"before_sort_at":1}),
            json!({"before_job_id":"a"}),
            json!({"limit":0}),
            json!({"limit":51}),
            json!({"before_sort_at":-1,"before_job_id":"a"}),
        ] {
            assert!(serde_json::from_value::<Query>(value)
                .unwrap()
                .validate()
                .is_err());
        }
        assert!(serde_json::from_value::<Query>(
            json!({"month":"2026-10","before_sort_at":1,"before_job_id":"a","limit":50})
        )
        .unwrap()
        .validate()
        .is_ok());
    }

    #[tokio::test]
    async fn official_rpc_and_service_match_and_preserve_large_integers_without_private_payload() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../../migrations").run(&db).await.unwrap();
        let (state, handle) = crate::state::tests::playback_state_with_db(db).await;
        let state = Arc::new(state);
        let owner = jobs::instance_owner(&state).await.unwrap();
        let month = jobs::utc_month_key(vmusic_store::now_ms());
        sqlx::query("INSERT INTO ai_usage_entries (job_id,accepted_month,reservation_micro_usd,accounted_micro_usd,
            usage_state,pricing_snapshot,created_at,owner_instance_id,principal,accepted_at,task_state)
            VALUES ('retained',?1,50000,9007199254740993,'reported',?2,?3,?4,'grant-original',?3,'failed')")
            .bind(&month).bind(r#"{"provider":"historical","model":"v0","pricingVersion":"legacy-unverified","apiKey":"NEVER-RETURN"}"#)
            .bind(vmusic_store::now_ms()).bind(&owner).execute(&state.db).await.unwrap();
        let page = serde_json::to_value(read(&state, Query::default()).await.unwrap()).unwrap();
        let entry = &page["entries"][0];
        assert_eq!(entry["accountedMicroUsd"], "9007199254740993");
        assert_eq!(entry["principal"], "grant-original");
        assert_eq!(entry["taskRetained"], false);
        assert_eq!(entry["pricingVerified"], false);
        assert_eq!(entry["provider"], "historical");
        assert!(!page.to_string().contains("NEVER-RETURN"));
        let reply = crate::rpc::Rpc::new(state.clone())
            .call(crate::rpc::Call {
                op: crate::rpc::Op::Get,
                path: "v1/ai/ledger",
                query: json!({"limit":"20","month":month}),
                body: Value::Null,
                raw: None,
                client_operation_id: None,
            })
            .await;
        assert_eq!(reply.unwrap().body, page);
        state.audio.shutdown();
        handle.join().unwrap();
        state.db.close().await;
    }
}
