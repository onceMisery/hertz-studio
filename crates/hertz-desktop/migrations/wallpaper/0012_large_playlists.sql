-- SPDX-License-Identifier: MIT
-- The migration runner owns the transaction/backup. Preserve every fixed reference.
CREATE TABLE playlist_items_expanded (
  playlist_id TEXT NOT NULL REFERENCES playlists(playlist_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 999),
  work_key TEXT NOT NULL REFERENCES works(work_key),
  package_hash TEXT NOT NULL REFERENCES packages(package_hash),
  version_key TEXT NOT NULL REFERENCES versions(version_key),
  PRIMARY KEY (playlist_id, position)
);
INSERT INTO playlist_items_expanded SELECT * FROM playlist_items;
DROP TABLE playlist_items;
ALTER TABLE playlist_items_expanded RENAME TO playlist_items;
CREATE INDEX playlist_items_package ON playlist_items(package_hash);
