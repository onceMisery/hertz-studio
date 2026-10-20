CREATE TABLE podcast_episode_progress (
    episode_id TEXT PRIMARY KEY NOT NULL
        REFERENCES podcast_episodes(id) ON DELETE CASCADE,
    position_ms INTEGER NOT NULL CHECK (position_ms >= 0),
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    updated_at INTEGER NOT NULL
);

CREATE INDEX podcast_episode_progress_recent
    ON podcast_episode_progress(updated_at DESC);
