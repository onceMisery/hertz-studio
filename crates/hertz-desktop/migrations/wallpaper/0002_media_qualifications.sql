-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 hertz-studio contributors
-- 只保存成功且已物理退出的有限抽样证明；不保存失败、运行租约或可播放承诺。
CREATE TABLE media_qualifications (
  cache_key TEXT PRIMARY KEY CHECK (length(cache_key) = 64),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  environment_hash TEXT NOT NULL CHECK (length(environment_hash) = 64),
  adapter_version TEXT NOT NULL CHECK (length(adapter_version) <= 64),
  qualified_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);
CREATE INDEX media_qualifications_lru ON media_qualifications (last_used, cache_key);
