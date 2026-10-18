-- Keep fee attribution independent of the seven-day job/proposal lifetime.
ALTER TABLE ai_usage_entries ADD COLUMN accepted_month TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_usage_entries ADD COLUMN attempt_id TEXT;

UPDATE ai_usage_entries SET
    accepted_month = COALESCE((SELECT strftime('%Y-%m', j.created_at / 1000, 'unixepoch')
                              FROM ai_jobs j WHERE j.job_id = ai_usage_entries.job_id),
                             strftime('%Y-%m', created_at / 1000, 'unixepoch')),
    attempt_id = (SELECT j.attempt_id FROM ai_jobs j WHERE j.job_id = ai_usage_entries.job_id);

CREATE INDEX idx_ai_usage_retention ON ai_usage_entries (accepted_month, usage_state);
CREATE INDEX idx_ai_proposals_expiration ON ai_proposals (expires_at);
