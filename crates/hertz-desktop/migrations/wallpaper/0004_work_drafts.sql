-- SPDX-License-Identifier: MIT
-- Work documents have an independent CAS revision; saving never writes config.
-- Keeping each bounded document in SQLite makes document + revision atomic.
-- Existing imports also use source_id='local'; authorship must not be inferred
-- from that source or from an untrusted manifest supplied by an imported package.
CREATE TABLE authored_versions (
  version_key TEXT PRIMARY KEY REFERENCES versions(version_key) ON DELETE CASCADE
);

CREATE TABLE drafts (
  draft_id TEXT PRIMARY KEY CHECK (length(draft_id) BETWEEN 6 AND 64),
  work_key TEXT NOT NULL,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  document_json TEXT NOT NULL CHECK (length(CAST(document_json AS BLOB)) <= 1048576),
  committed_revision INTEGER CHECK (committed_revision >= 1 AND committed_revision <= revision),
  committed_document_json TEXT CHECK (length(CAST(committed_document_json AS BLOB)) <= 1048576),
  base_package_hash TEXT REFERENCES packages(package_hash),
  published_revision INTEGER CHECK (published_revision >= 1 AND published_revision <= committed_revision),
  published_version INTEGER CHECK (published_version >= 1),
  published_package_hash TEXT REFERENCES packages(package_hash),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((committed_revision IS NULL) = (committed_document_json IS NULL)),
  CHECK ((published_revision IS NULL) = (published_version IS NULL)),
  CHECK ((published_revision IS NULL) = (published_package_hash IS NULL))
);

CREATE INDEX drafts_work ON drafts(work_key);

-- A native publish request must survive a crash after directory rename but
-- before version/authorship/receipt commit. Only this exact byte identity can
-- complete that request; matching a manifest UUID alone proves no authorship.
CREATE TABLE draft_publications (
  draft_id TEXT PRIMARY KEY REFERENCES drafts(draft_id) ON DELETE RESTRICT,
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  work_key TEXT NOT NULL,
  work_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 4294967295),
  package_hash TEXT NOT NULL CHECK (length(package_hash) = 64),
  manifest_json TEXT NOT NULL CHECK (length(CAST(manifest_json AS BLOB)) <= 262144),
  package_bytes INTEGER NOT NULL CHECK (package_bytes > 0),
  created_at INTEGER NOT NULL,
  UNIQUE(work_key),
  UNIQUE(work_key, version)
);
