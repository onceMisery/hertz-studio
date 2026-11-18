-- Additive external request receipts. Raw input/proof/secret never enters SQLite.
CREATE TABLE ai_requests (
    request_id TEXT PRIMARY KEY CHECK(length(request_id)=36),
    subject_digest TEXT NOT NULL CHECK(length(subject_digest)=64),
    credential_revision TEXT NOT NULL CHECK(length(credential_revision)=64),
    binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64),
    operation_id TEXT NOT NULL CHECK(length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 128),
    payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
    operation TEXT NOT NULL CHECK(operation IN ('switch','generate')),
    output_kind TEXT CHECK(output_kind IN ('builtin','composition','image')),
    state TEXT NOT NULL CHECK(state IN ('pending_confirmation','accepted','succeeded','failed','rejected','cancelled','expired','interrupted')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    terminal_at INTEGER,
    acceptance_id TEXT CHECK(acceptance_id IS NULL OR length(CAST(acceptance_id AS BLOB)) BETWEEN 1 AND 128),
    job_id TEXT CHECK(job_id IS NULL OR length(CAST(job_id AS BLOB)) BETWEEN 1 AND 128),
    native_operation_id TEXT CHECK(native_operation_id IS NULL OR length(CAST(native_operation_id AS BLOB)) BETWEEN 1 AND 128),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
    UNIQUE(subject_digest,operation_id)
);
CREATE INDEX idx_ai_requests_expiry ON ai_requests(state,expires_at);
CREATE INDEX idx_ai_requests_retention ON ai_requests(terminal_at);

-- Frequency ownership is independent of receipt retention/idempotency.
CREATE TABLE ai_request_frequency (
    admission_id TEXT PRIMARY KEY CHECK(length(admission_id)=36),
    subject_digest TEXT NOT NULL CHECK(length(subject_digest)=64),
    admitted_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_request_frequency_subject ON ai_request_frequency(subject_digest,admitted_at);
CREATE INDEX idx_ai_request_frequency_time ON ai_request_frequency(admitted_at);
