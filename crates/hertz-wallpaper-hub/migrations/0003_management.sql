-- SPDX-License-Identifier: MIT
CREATE TABLE management_operations (
    operation_id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(operation_id AS BLOB))=36),
    actor_id TEXT NOT NULL REFERENCES users(id) CHECK(length(CAST(actor_id AS BLOB))=36),
    kind TEXT NOT NULL CHECK(kind IN ('role_change','report_resolution')),
    object_id TEXT NOT NULL CHECK(length(CAST(object_id AS BLOB))=36),
    request_digest TEXT NOT NULL CHECK(length(CAST(request_digest AS BLOB))=64),
    result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) BETWEEN 2 AND 32768),
    created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 9007199254740991),
    audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id)
        CHECK(typeof(audit_event_id)='integer' AND audit_event_id BETWEEN 1 AND 9007199254740991)
);
CREATE INDEX management_actor_created ON management_operations(actor_id,created_at,operation_id);

CREATE TABLE report_resolutions (
    report_id TEXT PRIMARY KEY NOT NULL REFERENCES reports(id)
        CHECK(length(CAST(report_id AS BLOB))=36),
    operation_id TEXT NOT NULL UNIQUE REFERENCES management_operations(operation_id),
    status TEXT NOT NULL CHECK(status IN ('dismissed','escalated')),
    reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 4000 AND length(CAST(reason AS BLOB))<=16000),
    resolved_by TEXT NOT NULL REFERENCES users(id) CHECK(length(CAST(resolved_by AS BLOB))=36),
    resolved_at INTEGER NOT NULL CHECK(typeof(resolved_at)='integer' AND resolved_at BETWEEN 1 AND 9007199254740991)
);
CREATE INDEX report_resolution_status ON report_resolutions(status,report_id);
