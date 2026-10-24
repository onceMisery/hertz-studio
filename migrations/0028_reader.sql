-- RSS 图文阅读（reader 领域）：与播客完全独立的三类数据。
-- 订阅源、文章正文与图片引用登记、用户阅读状态互相分离，刷新只写前两类。

CREATE TABLE reader_feeds (
    id TEXT PRIMARY KEY,
    feed_url TEXT NOT NULL UNIQUE,
    final_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    site_url TEXT NOT NULL DEFAULT '',
    subscribed INTEGER NOT NULL DEFAULT 1,
    fetched_at INTEGER,
    etag TEXT,
    last_modified TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE reader_entries (
    id TEXT PRIMARY KEY,
    feed_id TEXT NOT NULL,
    identity TEXT NOT NULL,
    weak_identity INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    published_at INTEGER,
    original_url TEXT,
    summary TEXT NOT NULL DEFAULT '',
    content_html TEXT,
    content_status TEXT NOT NULL DEFAULT 'none',
    document_key TEXT NOT NULL DEFAULT '',
    image_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE (feed_id, identity)
);

CREATE INDEX idx_reader_entries_feed ON reader_entries (feed_id);

CREATE TABLE reader_entry_images (
    entry_id TEXT NOT NULL,
    image_key TEXT NOT NULL,
    source_url TEXT NOT NULL,
    PRIMARY KEY (entry_id, image_key)
);

CREATE TABLE reader_entry_state (
    entry_id TEXT PRIMARY KEY,
    is_read INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
