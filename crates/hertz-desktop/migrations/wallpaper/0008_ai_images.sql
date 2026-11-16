ALTER TABLE ai_receipts ADD COLUMN kind TEXT NOT NULL DEFAULT 'builtin' CHECK(kind IN ('builtin','image'));
ALTER TABLE ai_receipts ADD COLUMN image_work_id TEXT;
ALTER TABLE ai_receipts ADD COLUMN candidate_package_hash TEXT;
ALTER TABLE ai_receipts ADD COLUMN candidate_bytes INTEGER NOT NULL DEFAULT 0 CHECK(candidate_bytes>=0 AND candidate_bytes<=268435456);
ALTER TABLE ai_receipts ADD COLUMN save_title TEXT;
ALTER TABLE ai_receipts ADD COLUMN pending_package_hash TEXT;
ALTER TABLE ai_receipts ADD COLUMN thumbnail_json TEXT CHECK(thumbnail_json IS NULL OR length(CAST(thumbnail_json AS BLOB))<=2048);
CREATE UNIQUE INDEX idx_ai_pending_package ON ai_receipts(pending_package_hash) WHERE pending_package_hash IS NOT NULL;
