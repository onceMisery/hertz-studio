CREATE TABLE ai_receipts (
    receipt_id TEXT PRIMARY KEY,
    service_owner TEXT NOT NULL,
    job_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    output_hash TEXT NOT NULL CHECK(length(output_hash)=64),
    state TEXT NOT NULL CHECK(state IN ('previewReady','saving','saved','expired','deleted')),
    metadata_json TEXT NOT NULL CHECK(length(CAST(metadata_json AS BLOB))<=12288),
    document_json TEXT CHECK(length(CAST(document_json AS BLOB))<=1048576),
    provider TEXT NOT NULL CHECK(length(provider)<=128),
    model TEXT NOT NULL CHECK(length(model)<=128),
    received_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    draft_id TEXT REFERENCES drafts(draft_id) ON DELETE SET NULL,
    work_key TEXT,
    package_hash TEXT,
    UNIQUE(service_owner,job_id,artifact_id,output_hash)
);
CREATE INDEX idx_ai_receipt_expiry ON ai_receipts(state,expires_at);
CREATE TABLE ai_origins (
    version_key TEXT PRIMARY KEY REFERENCES versions(version_key) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    output_hash TEXT NOT NULL CHECK(length(output_hash)=64),
    ai_generated INTEGER NOT NULL DEFAULT 1 CHECK(ai_generated=1)
);
