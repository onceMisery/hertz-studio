ALTER TABLE ai_budget_guard ADD COLUMN token_halted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_budget_guard ADD COLUMN token_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_budget_guard ADD COLUMN token_trigger_job TEXT;
