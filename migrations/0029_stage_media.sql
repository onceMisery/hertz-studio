-- Stage originals are owned by the player DataDir, independently of wallpaper packages.
CREATE TABLE stage_media_assets (
    asset_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    media TEXT NOT NULL CHECK(media IN ('image','video')),
    bytes INTEGER NOT NULL,
    metadata TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('ready','missing','quarantined','deleting')),
    delete_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE stage_media_imports (
    import_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    digest TEXT NOT NULL,
    metadata TEXT NOT NULL,
    token TEXT NOT NULL,
    offset INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    asset_id TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    touched_at INTEGER NOT NULL
);
CREATE TABLE stage_preset_commits (
    request_id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    digest TEXT NOT NULL,
    receipt TEXT NOT NULL
);
CREATE TABLE stage_media_chunks (
    import_id TEXT NOT NULL REFERENCES stage_media_imports(import_id) ON DELETE CASCADE,
    offset INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY(import_id, offset)
);
