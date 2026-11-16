-- SPDX-License-Identifier: MIT
-- Widen the original receipt kind while preserving every schema8 column/row.
CREATE TABLE ai_receipts_v9 (
 receipt_id TEXT PRIMARY KEY,service_owner TEXT NOT NULL,job_id TEXT NOT NULL,artifact_id TEXT NOT NULL,
 output_hash TEXT NOT NULL CHECK(length(output_hash)=64),state TEXT NOT NULL CHECK(state IN ('preparing','failed','previewReady','saving','saved','expired','deleted')),
 metadata_json TEXT NOT NULL CHECK(length(CAST(metadata_json AS BLOB))<=12288),document_json TEXT CHECK(length(CAST(document_json AS BLOB))<=1048576),
 provider TEXT NOT NULL CHECK(length(provider)<=128),model TEXT NOT NULL CHECK(length(model)<=128),received_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 draft_id TEXT REFERENCES drafts(draft_id) ON DELETE SET NULL,work_key TEXT,package_hash TEXT,
 kind TEXT NOT NULL DEFAULT 'builtin' CHECK(kind IN ('builtin','image','composition')),image_work_id TEXT,candidate_package_hash TEXT,
 candidate_bytes INTEGER NOT NULL DEFAULT 0 CHECK(candidate_bytes>=0 AND candidate_bytes<=268435456),save_title TEXT,pending_package_hash TEXT,
 thumbnail_json TEXT CHECK(thumbnail_json IS NULL OR length(CAST(thumbnail_json AS BLOB))<=2048),
 diagnostics_json TEXT CHECK(diagnostics_json IS NULL OR length(CAST(diagnostics_json AS BLOB))<=8192),
 UNIQUE(service_owner,job_id,artifact_id,output_hash)
);
INSERT INTO ai_receipts_v9 SELECT *,NULL FROM ai_receipts;
DROP TABLE ai_receipts;
ALTER TABLE ai_receipts_v9 RENAME TO ai_receipts;
CREATE INDEX idx_ai_receipt_expiry ON ai_receipts(state,expires_at);
CREATE UNIQUE INDEX idx_ai_pending_package ON ai_receipts(pending_package_hash) WHERE pending_package_hash IS NOT NULL;

CREATE TABLE ai_asset_sets (
 asset_set_id TEXT PRIMARY KEY,service_identity TEXT NOT NULL,digest TEXT NOT NULL CHECK(length(digest)=64),
 metadata_json TEXT NOT NULL CHECK(length(CAST(metadata_json AS BLOB))<=8192),
 selections_json TEXT NOT NULL CHECK(length(CAST(selections_json AS BLOB))<=131072),
 quote_id TEXT UNIQUE,request_id TEXT,job_id TEXT UNIQUE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_asset_sets_expiry ON ai_asset_sets(service_identity,expires_at);
CREATE TABLE ai_asset_references (
 asset_set_id TEXT NOT NULL REFERENCES ai_asset_sets(asset_set_id) ON DELETE CASCADE,
 work_key TEXT NOT NULL,package_hash TEXT NOT NULL,
 PRIMARY KEY(asset_set_id,work_key,package_hash)
);
CREATE TABLE draft_resource_references (
 draft_id TEXT NOT NULL REFERENCES drafts(draft_id) ON DELETE CASCADE,
 work_key TEXT NOT NULL,package_hash TEXT NOT NULL,candidate_id TEXT,
 PRIMARY KEY(draft_id,work_key,package_hash)
);
