-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 hertz-studio contributors
-- 壁纸库 P1 子集（设计 docs/desktop-wallpaper.md §4.2）。
-- sources/works/packages/versions/install_jobs/derived_entries 属本地库闭环；
-- tags/playlists（P1-08）、drafts（P2）、subscriptions/grants/trust（P3）、
-- ai_*（AI 包）按各自工作包以独立迁移追加，不在本文件预建。

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'unsigned-import', 'hub')),
  canonical_origin TEXT,
  root_fingerprint TEXT
);

-- 本机新作品固定挂 local 来源（§4.2）。
INSERT INTO sources (source_id, kind) VALUES ('local', 'local');

CREATE TABLE works (
  work_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources (source_id),
  remote_work_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'builtin', 'composition', 'web')),
  favorite INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 同一来源内的作者 workId（remote_work_id）唯一；来源作品按
-- (sourceId, remoteWorkId) 映射到随机 workKey（§4.1）。
CREATE UNIQUE INDEX works_source_remote
  ON works (source_id, remote_work_id) WHERE remote_work_id IS NOT NULL;

CREATE TABLE packages (
  package_hash TEXT PRIMARY KEY CHECK (length(package_hash) = 64),
  manifest_json TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  -- installed/quarantined/unavailable（§4.2）；原包与投影不可变。
  state TEXT NOT NULL DEFAULT 'installed'
    CHECK (state IN ('installed', 'quarantined', 'unavailable'))
);

CREATE TABLE versions (
  version_key TEXT PRIMARY KEY,
  work_key TEXT NOT NULL REFERENCES works (work_key),
  version INTEGER NOT NULL CHECK (version >= 1),
  package_hash TEXT NOT NULL REFERENCES packages (package_hash),
  -- P3 社区发布才写入；本机版本为 NULL。
  release_id TEXT,
  created_at INTEGER NOT NULL
  -- (work_key, version) 唯一；同来源同版本不同 hash 在安装事务内拒绝（§4.2）。
);

CREATE UNIQUE INDEX versions_work_version ON versions (work_key, version);

CREATE TABLE install_jobs (
  job_id TEXT PRIMARY KEY,
  request_id TEXT,
  payload_digest TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'preparing', 'publishing', 'done', 'failed', 'cancelled')),
  input_identity TEXT,
  progress TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE derived_entries (
  cache_key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  pipeline_version TEXT NOT NULL,
  last_used INTEGER NOT NULL
);
