-- 手动导入的歌词与每曲偏移。
--
-- 本地曲目的歌词有三个来源，读取端按固定优先级取用：
--   1. imported —— 用户手动导入/关联、存在本表 content 里的 LRC 原文；
--   2. embedded —— 音频容器内嵌的歌词标签（每次读取时从文件实时解析）；
--   3. sidecar  —— 音频同目录的同名 .lrc（既有行为）。
-- 手动导入优先：用户明确指定的一定赢，且不随文件移动/重扫丢失。
--
-- offset_ms 是每曲的用户偏移（毫秒），与 LRC 文件自身的 [offset:] 标签叠加：
-- 读取时 total = file_offset + user_offset，一次应用。导入与偏移相互独立——
-- 只调偏移不导入歌词时 content 为空串。
CREATE TABLE IF NOT EXISTS track_lyrics (
    track_id   TEXT PRIMARY KEY,
    content    TEXT NOT NULL DEFAULT '',
    offset_ms  INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
