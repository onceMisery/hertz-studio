-- SPDX-License-Identifier: MIT
CREATE TABLE playlists (
  playlist_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  mode TEXT NOT NULL CHECK(mode IN ('sequential','random')),
  interval_seconds INTEGER NOT NULL CHECK(interval_seconds BETWEEN 10 AND 86400),
  updated_at INTEGER NOT NULL
);
CREATE TABLE playlist_items (
  playlist_id TEXT NOT NULL REFERENCES playlists(playlist_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 31),
  work_key TEXT NOT NULL REFERENCES works(work_key),
  package_hash TEXT NOT NULL REFERENCES packages(package_hash),
  version_key TEXT NOT NULL REFERENCES versions(version_key),
  PRIMARY KEY (playlist_id, position)
);
CREATE INDEX playlist_items_package ON playlist_items(package_hash);
