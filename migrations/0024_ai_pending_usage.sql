-- Preserve adapter-verified usage until the task ledger can be committed.
-- Deliberately has no FK: retention must not cascade away an unsettled fact.
CREATE TABLE ai_pending_usage (
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    owner_instance_id TEXT NOT NULL,
    usage_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, attempt_id)
) WITHOUT ROWID;

CREATE INDEX idx_ai_pending_usage_created ON ai_pending_usage (created_at);
