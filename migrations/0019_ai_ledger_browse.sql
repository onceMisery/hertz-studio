-- Preserve minimal attribution when seven-day task records are purged.
-- Missing historical facts remain NULL; never invent an owner or accepted time.
ALTER TABLE ai_usage_entries ADD COLUMN owner_instance_id TEXT;
ALTER TABLE ai_usage_entries ADD COLUMN principal TEXT;
ALTER TABLE ai_usage_entries ADD COLUMN task_state TEXT;
ALTER TABLE ai_usage_entries ADD COLUMN accepted_at INTEGER;
UPDATE ai_usage_entries SET
    owner_instance_id = (SELECT owner_instance_id FROM ai_jobs j WHERE j.job_id = ai_usage_entries.job_id),
    principal = (SELECT principal FROM ai_jobs j WHERE j.job_id = ai_usage_entries.job_id),
    task_state = (SELECT state FROM ai_jobs j WHERE j.job_id = ai_usage_entries.job_id),
    accepted_at = (SELECT created_at FROM ai_jobs j WHERE j.job_id = ai_usage_entries.job_id);
CREATE INDEX idx_ai_ledger_browse ON ai_usage_entries
    (accepted_month, COALESCE(accepted_at, created_at) DESC, job_id DESC);
