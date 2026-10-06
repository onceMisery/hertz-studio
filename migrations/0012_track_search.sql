-- 曲库搜索索引：FTS5 + trigram 分词器。
--
-- 0001 当初刻意选了 LIKE 而不是 FTS5（「几千首不需要虚拟表，也省掉触发器」）。
-- 这个前提在曲库规模上来后不成立：列表与计数语句都是
--     COALESCE(NULLIF(TRIM(e.title), ''), t.title) LIKE '%q%'
-- 前导通配符让任何 B-tree 索引都排不上用场，每次搜索都是「全表扫 + 排序 + 计数」。
--
-- trigram 分词器是 SQLite 里唯一能服务 `%q%` 的索引形态：它让 FTS5 表直接把
-- `column LIKE ?` 翻译成索引扫描（官方 FTS5 文档 §4.4.2「The Trigram Tokenizer」），
-- 模式里少于 3 个非通配字符时退化为对该表的小范围扫描，结果不变。
--
-- 索引内容是**覆盖后**的展示值（track_edits 优先），与查询里的 COALESCE 表达式
-- 逐字一致，因此命中集合与改造前完全相同；rowid 与 tracks.rowid 一一对应。
-- 维护方式是下面的触发器：所有写路径（扫描批量 upsert、标签编辑、重置编辑、
-- 失效整理/裁剪删除）都走 SQL，触发器是唯一能覆盖全部调用点的做法。
--
-- 注意：tracks 的 upsert 走 `ON CONFLICT(path) DO UPDATE`（不是 OR REPLACE），
-- 行不会被删除重建，rowid 稳定；`UPDATE OF title, artist, album` 让 has_cover /
-- rg_gain / added_at 这类无关写入不触发索引重建。

CREATE VIRTUAL TABLE IF NOT EXISTS track_search USING fts5(
    title,
    artist,
    album,
    tokenize = 'trigram'
);

-- 回填既有曲库（值表达式与读取端逐字一致）。
INSERT INTO track_search(rowid, title, artist, album)
SELECT t.rowid,
       COALESCE(NULLIF(TRIM(e.title), ''), t.title),
       COALESCE(NULLIF(TRIM(e.artist), ''), t.artist),
       COALESCE(NULLIF(TRIM(e.album), ''), t.album)
  FROM tracks t
  LEFT JOIN track_edits e ON e.track_id = t.id;

CREATE TRIGGER IF NOT EXISTS tracks_search_ai AFTER INSERT ON tracks BEGIN
    DELETE FROM track_search WHERE rowid = NEW.rowid;
    INSERT INTO track_search(rowid, title, artist, album)
    VALUES (
        NEW.rowid,
        COALESCE(NULLIF(TRIM((SELECT title FROM track_edits WHERE track_id = NEW.id)), ''), NEW.title),
        COALESCE(NULLIF(TRIM((SELECT artist FROM track_edits WHERE track_id = NEW.id)), ''), NEW.artist),
        COALESCE(NULLIF(TRIM((SELECT album FROM track_edits WHERE track_id = NEW.id)), ''), NEW.album)
    );
END;

CREATE TRIGGER IF NOT EXISTS tracks_search_au
AFTER UPDATE OF title, artist, album ON tracks BEGIN
    DELETE FROM track_search WHERE rowid = NEW.rowid;
    INSERT INTO track_search(rowid, title, artist, album)
    VALUES (
        NEW.rowid,
        COALESCE(NULLIF(TRIM((SELECT title FROM track_edits WHERE track_id = NEW.id)), ''), NEW.title),
        COALESCE(NULLIF(TRIM((SELECT artist FROM track_edits WHERE track_id = NEW.id)), ''), NEW.artist),
        COALESCE(NULLIF(TRIM((SELECT album FROM track_edits WHERE track_id = NEW.id)), ''), NEW.album)
    );
END;

CREATE TRIGGER IF NOT EXISTS tracks_search_ad AFTER DELETE ON tracks BEGIN
    DELETE FROM track_search WHERE rowid = OLD.rowid;
END;

-- 标签编辑覆盖层：编辑值优先于扫描值，空/纯空白编辑回退到扫描值。
CREATE TRIGGER IF NOT EXISTS track_edits_search_ai AFTER INSERT ON track_edits BEGIN
    DELETE FROM track_search WHERE rowid = (SELECT rowid FROM tracks WHERE id = NEW.track_id);
    INSERT INTO track_search(rowid, title, artist, album)
    SELECT t.rowid,
           COALESCE(NULLIF(TRIM(NEW.title), ''), t.title),
           COALESCE(NULLIF(TRIM(NEW.artist), ''), t.artist),
           COALESCE(NULLIF(TRIM(NEW.album), ''), t.album)
      FROM tracks t
     WHERE t.id = NEW.track_id;
END;

CREATE TRIGGER IF NOT EXISTS track_edits_search_au
AFTER UPDATE OF title, artist, album ON track_edits BEGIN
    DELETE FROM track_search WHERE rowid = (SELECT rowid FROM tracks WHERE id = NEW.track_id);
    INSERT INTO track_search(rowid, title, artist, album)
    SELECT t.rowid,
           COALESCE(NULLIF(TRIM(NEW.title), ''), t.title),
           COALESCE(NULLIF(TRIM(NEW.artist), ''), t.artist),
           COALESCE(NULLIF(TRIM(NEW.album), ''), t.album)
      FROM tracks t
     WHERE t.id = NEW.track_id;
END;

-- 重置编辑 = 删掉覆盖行，索引要回到扫描值。
CREATE TRIGGER IF NOT EXISTS track_edits_search_ad AFTER DELETE ON track_edits BEGIN
    DELETE FROM track_search WHERE rowid = (SELECT rowid FROM tracks WHERE id = OLD.track_id);
    INSERT INTO track_search(rowid, title, artist, album)
    SELECT t.rowid, t.title, t.artist, t.album
      FROM tracks t
     WHERE t.id = OLD.track_id;
END;
