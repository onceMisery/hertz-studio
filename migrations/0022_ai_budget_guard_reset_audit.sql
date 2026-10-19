CREATE TABLE ai_budget_guard_reset_audit (
    event_id TEXT PRIMARY KEY,
    owner_instance_id TEXT NOT NULL,
    previous_revision INTEGER NOT NULL,
    new_revision INTEGER NOT NULL,
    config_fingerprint TEXT NOT NULL CHECK (
        length(config_fingerprint) = 64
        AND config_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_ai_budget_guard_reset_audit_created
    ON ai_budget_guard_reset_audit(created_at DESC, event_id DESC);
