-- 播放历史：本地曲与在线曲统一记录。在线曲的 URL 会过期，所以这里只存
-- 元数据快照，重播时重新实时取流。
CREATE TABLE IF NOT EXISTS play_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id    TEXT NOT NULL UNIQUE,
    source      TEXT NOT NULL,
    ref_id      TEXT NOT NULL,
    title       TEXT NOT NULL,
    artist      TEXT,
    album       TEXT,
    cover_url   TEXT,
    duration_ms INTEGER,
    played_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_play_history_played ON play_history(played_at DESC);
