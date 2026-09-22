-- 收藏（我的收藏）
--
-- 收藏项分两类：`track`（一首歌，本地曲目或在线曲目）与 `radio`（电台/在线
-- 歌单这类可整体播放的节目）。两者共用一张表是因为它们在界面上是同一个
-- 「我的收藏」列表，只是点下去的动作不同（单曲入队 vs 整盘载入）。
--
-- 唯一性按 (kind, source, ref_id) 而不按自增行号：收藏是一次可以重复点击的
-- 开关（红心），靠数据库约束挡住重复行，比先查后插少一次往返也少一个竞态。
CREATE TABLE IF NOT EXISTS favorites (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'local',
    ref_id       TEXT NOT NULL,
    title        TEXT NOT NULL,
    artist       TEXT,
    album        TEXT,
    duration_ms  INTEGER,
    cover        TEXT,
    added_at     INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

-- 同一首歌/同一个电台只能有一条收藏。
CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_identity
    ON favorites(kind, source, ref_id);

-- 列表默认按「最近收藏」倒序。
CREATE INDEX IF NOT EXISTS idx_favorites_added ON favorites(added_at DESC);
-- 按类型分页（歌曲 / 电台两个 tab）。
CREATE INDEX IF NOT EXISTS idx_favorites_kind ON favorites(kind, added_at DESC);
