// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! One Library metadata budget for existing candidates and external requests.
//! Every new row reserves its terminal footprint in its owner's SQLite write
//! transaction. This helper never deletes candidate, saved work or receipt data.

use sqlx::SqliteConnection;

use super::jobs::JobError;

const MAX_RECORDS: i64 = 256;
const MAX_BYTES: i64 = 4 * 1024 * 1024;
// Bounded origin, operation/digests, future result IDs and row overhead.
const REQUEST_RESERVATION_BYTES: i64 = 2048;
// Metadata 12KiB + diagnostics 8KiB + thumbnail 2KiB + bounded labels/IDs,
// future saved work links and row overhead. Active document/content bytes
// retain the existing candidate 256MiB budget and clear at terminal handoff.
const CANDIDATE_RESERVATION_BYTES: i64 = 32 * 1024;

pub(crate) enum Reservation {
    ExternalRequest,
    Candidate,
}

/// Call only inside the owner's BEGIN IMMEDIATE admission transaction, after
/// its existing identity lookup. All active rows reserve future terminal space
/// so save/failure can complete without deleting or rejecting an existing row.
pub(crate) async fn ensure_room(
    connection: &mut SqliteConnection,
    reservation: Reservation,
) -> Result<(), JobError> {
    let requests: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_requests")
        .fetch_one(&mut *connection)
        .await
        .map_err(database)?;
    let (candidates, candidate_bytes): (i64,i64) = sqlx::query_as(
        "SELECT COUNT(*),COALESCE(SUM(CASE WHEN state IN ('preparing','failed','previewReady','saving') THEN MAX(?1,metadata_bytes) ELSE metadata_bytes+document_bytes END),0)
         FROM (SELECT state,
           512+length(CAST(receipt_id||service_owner||job_id||artifact_id||output_hash||metadata_json||provider||model||state||kind AS BLOB))
           +COALESCE(length(CAST(diagnostics_json AS BLOB)),0)+COALESCE(length(CAST(thumbnail_json AS BLOB)),0)
           +COALESCE(length(CAST(save_title AS BLOB)),0)+COALESCE(length(CAST(draft_id AS BLOB)),0)
           +COALESCE(length(CAST(work_key AS BLOB)),0)+COALESCE(length(CAST(package_hash AS BLOB)),0)
           +COALESCE(length(CAST(image_work_id AS BLOB)),0)+COALESCE(length(CAST(candidate_package_hash AS BLOB)),0)
           +COALESCE(length(CAST(pending_package_hash AS BLOB)),0) AS metadata_bytes,
           COALESCE(length(CAST(document_json AS BLOB)),0) AS document_bytes FROM ai_receipts)")
        .bind(CANDIDATE_RESERVATION_BYTES).fetch_one(connection).await.map_err(database)?;
    let (extra_bytes, code) = match reservation {
        Reservation::ExternalRequest => (
            REQUEST_RESERVATION_BYTES,
            "ai_request_receipt_capacity_exceeded",
        ),
        Reservation::Candidate => (CANDIDATE_RESERVATION_BYTES, "candidate_capacity_exceeded"),
    };
    if requests.saturating_add(candidates) >= MAX_RECORDS
        || requests
            .saturating_mul(REQUEST_RESERVATION_BYTES)
            .saturating_add(candidate_bytes)
            .saturating_add(extra_bytes)
            > MAX_BYTES
    {
        return Err(JobError::new(code, "AI 回执空间不足，请稍后重试"));
    }
    Ok(())
}

fn database(error: sqlx::Error) -> JobError {
    JobError::database(error.to_string())
}
