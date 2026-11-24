-- Successful offline measurements are distinct from file ReplayGain tags.
-- Virtual online IDs are allowed after the playback owner confirms complete bytes.
CREATE TABLE loudness_tracks (
    track_id TEXT PRIMARY KEY NOT NULL,
    sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
    algorithm TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    measured_at INTEGER NOT NULL
);
CREATE TABLE loudness_albums (
    album_key TEXT PRIMARY KEY NOT NULL,
    algorithm TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    measured_at INTEGER NOT NULL
);
CREATE TABLE loudness_album_members (
    album_key TEXT NOT NULL REFERENCES loudness_albums(album_key) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (album_key, track_id)
);
CREATE INDEX loudness_member_track ON loudness_album_members(track_id);
CREATE TRIGGER loudness_deleted_track AFTER DELETE ON tracks BEGIN
    DELETE FROM loudness_albums WHERE album_key IN
        (SELECT album_key FROM loudness_album_members WHERE track_id=OLD.id);
    DELETE FROM loudness_tracks WHERE track_id=OLD.id;
END;
