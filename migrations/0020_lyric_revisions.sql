-- Every legacy and candidate writer advances one durable lyric revision.
-- Keep a tombstone after deletion so stale candidates cannot pass an ABA cycle.
CREATE TABLE lyric_revisions (
    track_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 0)
);
INSERT INTO lyric_revisions (track_id, revision) SELECT track_id, 1 FROM track_lyrics;
CREATE TRIGGER lyric_revision_insert AFTER INSERT ON track_lyrics BEGIN
    INSERT INTO lyric_revisions(track_id, revision) VALUES(NEW.track_id, 1)
    ON CONFLICT(track_id) DO UPDATE SET revision = CASE
        WHEN revision < 9223372036854775807 THEN revision + 1
        ELSE RAISE(ABORT, 'lyric revision exhausted') END;
END;
CREATE TRIGGER lyric_revision_update AFTER UPDATE ON track_lyrics BEGIN
    INSERT INTO lyric_revisions(track_id, revision) VALUES(NEW.track_id, 1)
    ON CONFLICT(track_id) DO UPDATE SET revision = CASE
        WHEN revision < 9223372036854775807 THEN revision + 1
        ELSE RAISE(ABORT, 'lyric revision exhausted') END;
END;
CREATE TRIGGER lyric_revision_delete AFTER DELETE ON track_lyrics BEGIN
    INSERT INTO lyric_revisions(track_id, revision) VALUES(OLD.track_id, 1)
    ON CONFLICT(track_id) DO UPDATE SET revision = CASE
        WHEN revision < 9223372036854775807 THEN revision + 1
        ELSE RAISE(ABORT, 'lyric revision exhausted') END;
END;
