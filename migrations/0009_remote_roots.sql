-- 远程来源（WebDAV）：服务器目录登记。
--
-- 只存「连接到哪」：名称、根 URL、用户名。密码属于秘密，走系统钥匙串
-- （secrets 抽象，键 remote_cred_<id>），绝不入 SQLite，也不进备份。
-- 文件条目不持久化——浏览实时 PROPFIND，导入的曲目进 tracks 表
-- （source='remote'，path 存 HTTP 直链 URL）。
CREATE TABLE IF NOT EXISTS remote_roots (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    base_url  TEXT NOT NULL,
    username  TEXT NOT NULL DEFAULT '',
    added_at  INTEGER NOT NULL
);
