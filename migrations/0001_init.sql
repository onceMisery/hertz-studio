-- mmusic-studio initial schema
-- Search uses LIKE rather than FTS5: a few thousand tracks do not need a
-- virtual table, and this keeps the schema portable and trigger-free.

CREATE TABLE IF NOT EXISTS tracks (
    id           TEXT PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    source       TEXT NOT NULL DEFAULT 'local',
    title        TEXT NOT NULL,
    artist       TEXT,
    album        TEXT,
    duration_ms  INTEGER,
    bitrate      INTEGER,
    sample_rate  INTEGER,
    channels     INTEGER,
    has_cover    INTEGER NOT NULL DEFAULT 0,
    cover_key    TEXT,
    file_mtime   INTEGER,
    file_size    INTEGER,
    added_at     INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracks_title  ON tracks(title);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks(album);

CREATE TABLE IF NOT EXISTS playlists (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL,
    track_id    TEXT NOT NULL,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks ON playlist_tracks(playlist_id, position);

CREATE TABLE IF NOT EXISTS lyrics (
    track_id   TEXT PRIMARY KEY,
    format     TEXT NOT NULL,
    content    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_roots (
    path           TEXT PRIMARY KEY,
    enabled        INTEGER NOT NULL DEFAULT 1,
    last_scanned_at INTEGER
);
