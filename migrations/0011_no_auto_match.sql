-- 在线补全的「不匹配」决定。
--
-- 用户在补全流程里明确说过某首本地曲目不该自动匹配（歌名撞车、翻唱、纯音乐
-- 等），后续再跑补全必须跳过它——否则每次整理都会把同一个错封面/错歌词又写
-- 回来，用户没有任何办法表达「别再动这首」。
--
-- 与 track_edits 分表而不是给它加列：覆盖层是「用户改过的字段」语义，
-- 这张表是「用户拒绝过的匹配」语义，生命周期不同——重置编辑（删覆盖行）
-- 不该顺手丢掉拒绝决定，混在一张表里两边读写都会互相干扰。
CREATE TABLE IF NOT EXISTS track_no_auto_match (
    track_id   TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

-- 扫描/补全按 id 批量取，主键已经够用；这里只补 updated 时间维度之外的
-- 查询面：按时间清理孤儿（曲目被删后留下的行）时用得上。
CREATE INDEX IF NOT EXISTS idx_no_auto_match_created ON track_no_auto_match(created_at);
