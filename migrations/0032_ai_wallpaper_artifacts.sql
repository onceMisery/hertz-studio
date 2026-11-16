-- Files belong to the AI result store. These rows supplement the original job;
-- they do not grant access, run providers, or describe desktop configuration.
CREATE TABLE ai_wallpaper_artifacts (
    artifact_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES ai_jobs(job_id) ON DELETE RESTRICT,
    access_principal TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('writing','available','expired','rejected','deleted')),
    reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes BETWEEN 0 AND 33554432),
    bytes INTEGER CHECK(bytes BETWEEN 1 AND 33554432),
    sha256 TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('builtin','composition','image')),
    mime TEXT NOT NULL,
    registry_hash TEXT NOT NULL,
    generation_schema_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    claim_revision INTEGER NOT NULL DEFAULT 1,
    failure_code TEXT CHECK(failure_code IS NULL OR length(failure_code)<=64),
    CHECK(state != 'available' OR (bytes IS NOT NULL AND length(sha256)=64 AND reserved_bytes=bytes))
);
CREATE INDEX idx_ai_wallpaper_artifact_expiry ON ai_wallpaper_artifacts(state,expires_at);
