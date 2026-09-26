-- 用户元数据覆盖层：标签编辑与封面替换。
--
-- 扫描永远以文件标签为准写 tracks 表；用户在界面上的编辑写进这张覆盖层，
-- 读取端（列表/详情/排序/搜索）用 COALESCE 盖在扫描值上。这样：
--   - 重扫不会冲掉用户编辑（tracks 行被扫描值刷新，覆盖层不受影响）；
--   - 「重置编辑」= 删掉覆盖行，立即回到文件标签；
--   - 空串与空白表示「清成无值」，读取端用 NULLIF(TRIM(...)) 归一。
--
-- cover_edited 标记用户替换过封面：增量扫描重读该文件时跳过内嵌封面的
-- 重新落盘，用户上传的封面才不会被旧标签盖回去。
CREATE TABLE IF NOT EXISTS track_edits (
    track_id     TEXT PRIMARY KEY,
    title        TEXT,
    artist       TEXT,
    album        TEXT,
    cover_edited INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_track_edits_artist ON track_edits(artist);
CREATE INDEX IF NOT EXISTS idx_track_edits_album ON track_edits(album);
