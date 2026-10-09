-- 公开播客节目与稳定单集映射。取消订阅及 RSS 删集均保留旧单集，供队列/歌单重播。
CREATE TABLE podcast_shows (
    id TEXT PRIMARY KEY NOT NULL,
    feed_url TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    description TEXT NOT NULL,
    cover TEXT,
    episode_count INTEGER NOT NULL DEFAULT 0 CHECK (episode_count >= 0),
    subscribed INTEGER NOT NULL DEFAULT 0 CHECK (subscribed IN (0, 1)),
    subscribed_at INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL
);

CREATE TABLE podcast_episodes (
    id TEXT PRIMARY KEY NOT NULL,
    show_id TEXT NOT NULL REFERENCES podcast_shows(id) ON DELETE CASCADE,
    identity TEXT NOT NULL,
    enclosure_url TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    cover TEXT,
    published_at TEXT NOT NULL,
    description TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    UNIQUE (show_id, identity)
);

CREATE INDEX podcast_episode_page ON podcast_episodes(show_id, active, ordinal);
CREATE INDEX podcast_subscription_order ON podcast_shows(subscribed, subscribed_at);
