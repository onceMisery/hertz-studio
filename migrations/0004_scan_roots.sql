-- Persist scan failures so unavailable roots remain actionable after restart.
ALTER TABLE scan_roots ADD COLUMN last_error TEXT;
