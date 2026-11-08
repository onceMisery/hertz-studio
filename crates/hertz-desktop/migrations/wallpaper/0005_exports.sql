-- SPDX-License-Identifier: MIT
-- Native export receipts are independent from installation transactions.
-- Private paths and file identities only exist while publication/cleanup may
-- require recovery; IPC serializes ExportStatus instead of these rows.
CREATE TABLE export_jobs (
  job_id TEXT PRIMARY KEY,
  package_hash TEXT NOT NULL CHECK (length(package_hash) = 64),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'preparing', 'publishing', 'done', 'failed', 'cancelled')),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  error TEXT,
  target_path TEXT,
  temporary_path TEXT,
  file_identity TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE export_operations (
  request_id TEXT PRIMARY KEY,
  payload_digest TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES export_jobs(job_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
