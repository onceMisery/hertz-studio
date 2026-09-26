-- 自建歌单的在线曲目元数据快照。
--
-- 歌单的 track_id 承载既有身份协议：本地是曲目 uuid，在线是 `online:<source>:<id>`
-- 虚拟身份。本地曲目重开后能从 tracks 表 JOIN 出标题；在线曲目的元数据原本只
-- 存在前端内存与 /online/play 的内存暂存里，重启后歌单里只剩一串不可读的 id。
-- 这里在入单时随写一份快照，读取端在本地解析失败时回退到它——显示与顺序不丢。
--
-- 快照列对本地曲目保持 NULL：本地行永远以 tracks 表实时字段为准，编辑标签、
-- 替换封面后歌单显示跟着变，不会被旧快照钉死。
ALTER TABLE playlist_tracks ADD COLUMN source TEXT;
ALTER TABLE playlist_tracks ADD COLUMN title TEXT;
ALTER TABLE playlist_tracks ADD COLUMN artist TEXT;
ALTER TABLE playlist_tracks ADD COLUMN album TEXT;
ALTER TABLE playlist_tracks ADD COLUMN duration_ms INTEGER;
ALTER TABLE playlist_tracks ADD COLUMN cover TEXT;
