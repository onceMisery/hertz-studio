-- Short native sessions share the original grant/revocation owner.
-- No bearer, challenge or model input is persisted here.
ALTER TABLE ai_grants ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'file';
ALTER TABLE ai_grants ADD COLUMN session_binding TEXT;
