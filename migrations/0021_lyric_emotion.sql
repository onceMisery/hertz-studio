-- P2b: server-owned lyric emotion cache and manual overrides.
-- Model cues are keyed by lyrics hash + provider/model + prompt/catalog version;
-- manual overrides are keyed only by lyrics hash so model upgrades never lose them.
CREATE TABLE lyric_emotion_cues (
    cache_key TEXT PRIMARY KEY,
    lyrics_hash TEXT NOT NULL,
    doc_json TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_lyric_emotion_cues_lru ON lyric_emotion_cues(updated_at);

CREATE TABLE lyric_emotion_locks (
    lyrics_hash TEXT NOT NULL,
    line_from INTEGER NOT NULL CHECK (line_from >= 0),
    line_to INTEGER NOT NULL CHECK (line_to >= line_from),
    emotion TEXT NOT NULL,
    intensity REAL NOT NULL,
    confidence REAL NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (lyrics_hash, line_from, line_to)
);
