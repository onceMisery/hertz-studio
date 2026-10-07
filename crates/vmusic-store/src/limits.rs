// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 持久化 DTO 的数量与长度上限（方案 F6）。
//!
//! 为什么要有这一层：这些结构体是**能被外部文件喂满**的——备份 JSON 走
//! `POST /v1/backup/restore`，m3u 走 `POST` 一条文本，歌单批量入单的快照来自
//! 前端。版本闸门（`BACKUP_VERSION`）与「单事务、失败整体回滚」早就有了，缺的
//! 一直是**数量与长度**这一档：一个字段合法但体量无限的载荷能安静地把用户库撑大，
//! 而一张 4MB 的 base64 封面字符串在 SQLite 那边完全合法。
//!
//! 数字怎么来的（每条都留了「合法用法远碰不到」的余量，不做贴身裁剪）：
//!   · 曲库与歌单：本仓库既有断言按「几千首的歌单不该被截断」定标（见
//!     `state.rs` 里 ONLINE_META_CAP 的同一条理由），所以单表 20 000 首、
//!     一次备份 100 000 首都在真实上限之上一个数量级。
//!   · 字符串：标题/歌手/专辑按最长实测值放足到 1000；`cover` 只该放 URL，
//!     4096 已经容得下带签名参数的长链，再大就是有人把图塞进备份了。
//!   · `settings` 只限条数不限单值大小：单值是自由 JSON（创作预设库会成批量写
//!     进来），体积由 HTTP 层的请求体上限兜；这一层负责的是「键数量爆炸」这种
//!     不是自由度的东西。
//!
//! 一处原则：**先验完再动手**。所有检查都在任何写入之前做完，所以越界的载荷
//! 一条都进不了库——这条比「事务回滚」更强，也是本模块存在的意义（回滚只保证
//! 不留半成品，不保证你愿意为一次失败付出那么多写入与锁）。

use vmusic_core::StoreError;

pub const MAX_PLAYLISTS_PER_BACKUP: usize = 500;
pub const MAX_TRACKS_PER_PLAYLIST: usize = 20_000;
pub const MAX_TRACKS_PER_BACKUP: usize = 100_000;
pub const MAX_FAVORITES_PER_BACKUP: usize = 20_000;
pub const MAX_SCAN_ROOTS_PER_BACKUP: usize = 100;
pub const MAX_SETTINGS_KEYS: usize = 2_000;
pub const MAX_ENTRIES_PER_BATCH: usize = 20_000;

pub const MAX_ID_CHARS: usize = 256;
pub const MAX_NAME_CHARS: usize = 1_000;
pub const MAX_TEXT_CHARS: usize = 1_000;
pub const MAX_URL_CHARS: usize = 4_096;
pub const MAX_PATH_CHARS: usize = 4_096;
pub const MAX_M3U_BYTES: usize = 8 * 1024 * 1024;

fn too_long(field: &str, max: usize, what: &str) -> StoreError {
    StoreError::Database(format!("{field} 超过上限 {max} 字符（{what}）"))
}

fn too_many(field: &str, max: usize, what: &str) -> StoreError {
    StoreError::Database(format!("{field} 超过上限 {max}（{what}）"))
}

/// 长度闸门。`None`/空串直接放过：可选字段留空是合法状态，不该由长度规则管。
/// 收 `Option<impl AsRef<str>>` 是为了调用方不必在 `&String`/`&str`/`as_deref()`
/// 之间来回换算——那种样板转换正是让闸门被人嫌麻烦跳过的原因。
pub fn check_len(
    field: &str,
    value: Option<impl AsRef<str>>,
    max: usize,
    what: &str,
) -> Result<(), StoreError> {
    match value {
        Some(v) if v.as_ref().chars().count() > max => Err(too_long(field, max, what)),
        _ => Ok(()),
    }
}

/// 数量闸门。
pub fn check_count(field: &str, seen: usize, max: usize, what: &str) -> Result<(), StoreError> {
    if seen > max {
        return Err(too_many(field, max, what));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_gate_counts_characters_not_bytes() {
        // 中文标题按字节算会被放大三倍，一刀切会让合法中文先撞线。
        let cn = "歌".repeat(MAX_TEXT_CHARS);
        assert!(check_len("title", Some(&cn), MAX_TEXT_CHARS, "标题").is_ok());
        let over = "歌".repeat(MAX_TEXT_CHARS + 1);
        assert!(check_len("title", Some(&over), MAX_TEXT_CHARS, "标题").is_err());
        assert!(check_len("title", None::<&str>, MAX_TEXT_CHARS, "标题").is_ok());
        assert!(check_len("title", Some(""), MAX_TEXT_CHARS, "标题").is_ok());
    }

    #[test]
    fn count_gate_is_inclusive_at_the_limit() {
        assert!(check_count(
            "playlists",
            MAX_PLAYLISTS_PER_BACKUP,
            MAX_PLAYLISTS_PER_BACKUP,
            "备份"
        )
        .is_ok());
        assert!(check_count(
            "playlists",
            MAX_PLAYLISTS_PER_BACKUP + 1,
            MAX_PLAYLISTS_PER_BACKUP,
            "备份"
        )
        .is_err());
    }
}
