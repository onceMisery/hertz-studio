// SPDX-License-Identifier: MIT

//! 平台凭据保险库。
//!
//! 每个平台一份结构化 CredPack，序列化成 JSON 存进 settings 表的
//! `online_cred_<source>` 键。任何 GET 接口都不回显这些键（见
//! routes.rs 的 is_credential）。兼容旧键 online_cookie_<source>。

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use vmusic_core::StoreError;

pub const CRED_PREFIX: &str = "online_cred_";
pub const DEVICE_PREFIX: &str = "online_device_";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CredPack {
    #[serde(default)]
    pub cookie: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub userid: String,
    #[serde(default)]
    pub dfid: String,
    #[serde(default)]
    pub mid: String,
    #[serde(default)]
    pub uin: String,
    #[serde(default)]
    pub saved_at: i64,
}

fn cred_key(source: &str) -> String {
    format!("{CRED_PREFIX}{source}")
}
fn legacy_cookie_key(source: &str) -> String {
    format!("{}{source}", super::COOKIE_PREFIX)
}
fn device_key(source: &str) -> String {
    format!("{DEVICE_PREFIX}{source}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub async fn put(db: &SqlitePool, source: &str, pack: &CredPack) -> Result<(), StoreError> {
    let mut pack = pack.clone();
    pack.saved_at = now_ms();
    let v = serde_json::to_value(&pack).map_err(|e| StoreError::Serialization(e.to_string()))?;
    vmusic_store::settings::set(db, &cred_key(source), &v).await?;
    // 迁移完成后清掉旧的裸 cookie 键，避免两处真相。
    let _ = sqlx::query("DELETE FROM settings WHERE key = ?1")
        .bind(legacy_cookie_key(source))
        .execute(db)
        .await;
    Ok(())
}

/// 读取凭据：优先新键，回落旧的裸 cookie 键（netease 老用户）。
pub async fn get(db: &SqlitePool, source: &str) -> Result<Option<CredPack>, StoreError> {
    if let Some(v) = vmusic_store::settings::get(db, &cred_key(source)).await? {
        match serde_json::from_value::<CredPack>(v) {
            Ok(pack) => return Ok(Some(pack)),
            // 只记是哪个源的键坏了，绝不把凭据内容写进日志。
            Err(_) => tracing::warn!(source = source, "online_cred_ 凭据 JSON 损坏，按未登录处理"),
        }
    }
    if let Some(v) = vmusic_store::settings::get(db, &legacy_cookie_key(source)).await? {
        if let Some(cookie) = v.as_str() {
            if !cookie.trim().is_empty() {
                let mut pack = CredPack {
                    cookie: cookie.trim().to_string(),
                    ..Default::default()
                };
                enrich_from_cookie(source, &mut pack);
                return Ok(Some(pack));
            }
        }
    }
    Ok(None)
}

/// 登出：结构化凭据与历史裸键一起删，避免「清了 cookie 但 cred 还在」
/// 导致 list_sources 仍判登录。
pub async fn clear(db: &SqlitePool, source: &str) -> Result<(), StoreError> {
    for k in [cred_key(source), legacy_cookie_key(source)] {
        let _ = sqlx::query("DELETE FROM settings WHERE key = ?1")
            .bind(k)
            .execute(db)
            .await;
    }
    Ok(())
}

/// 手动粘贴 cookie 的登录入口（`/v1/online/cookie`）：先按平台规则补齐
/// 判态字段再入保险库。直接 put 一个只有 cookie 的包会让酷狗的
/// userid/token 缺失、登录态被误判为未登录。
pub async fn put_cookie(db: &SqlitePool, source: &str, cookie: &str) -> Result<(), StoreError> {
    let mut pack = CredPack {
        cookie: cookie.trim().to_string(),
        ..Default::default()
    };
    enrich_from_cookie(source, &mut pack);
    put(db, source, &pack).await
}

/// 非密设备身份（QQ guid、酷狗 mid/dfid）。
pub async fn get_device(db: &SqlitePool, source: &str) -> Result<Option<String>, StoreError> {
    Ok(vmusic_store::settings::get(db, &device_key(source))
        .await?
        .and_then(|v| v.as_str().map(str::to_string)))
}

pub async fn set_device(db: &SqlitePool, source: &str, value: &str) -> Result<(), StoreError> {
    vmusic_store::settings::set(
        db,
        &device_key(source),
        &serde_json::Value::String(value.to_string()),
    )
    .await
}

/// 从 cookie 串取一个字段；用于 uin/MUSIC_U 等判态。
pub fn cookie_field<'a>(cookie: &'a str, name: &str) -> Option<&'a str> {
    cookie.split(';').find_map(|part| {
        let part = part.trim();
        let (k, v) = part.split_once('=')?;
        (k == name).then_some(v)
    })
}

/// QQ cookie 里的 uin 形如 `o0123456`；归一成纯数字串（去 `o` 前缀与
/// 前导零），脏值/零值统一回 "0"。
pub(crate) fn normalize_qq_uin(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches('o');
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    let n = digits.trim_start_matches('0');
    if n.is_empty() {
        "0".to_string()
    } else {
        n.to_string()
    }
}

/// 手动粘贴的 cookie 串兜底：按平台补出登录判态字段（不覆盖已有值）。
///
/// 酷狗 Web 历史 cookie 字段名为 KugooID/KugooPassToken（真机确认：不同年代
/// 客户端可能只给小写 userid/token 键，两组候选都保留）。
/// QQ 的 musicu 鉴权要 uin + qm_keyst；uin 从 cookie 的 `uin=o0...` 取。
fn enrich_from_cookie(source: &str, pack: &mut CredPack) {
    match source {
        "kugou" => {
            if pack.token.is_empty() {
                pack.token = cookie_field(&pack.cookie, "token")
                    .or_else(|| cookie_field(&pack.cookie, "KugooPassToken"))
                    .unwrap_or("")
                    .to_string();
            }
            if pack.userid.is_empty() {
                pack.userid = ["userid", "KugooID", "uid"]
                    .iter()
                    .find_map(|k| cookie_field(&pack.cookie, k))
                    .unwrap_or("")
                    .to_string();
            }
        }
        "qq" if pack.uin.is_empty() || pack.uin == "0" => {
            if let Some(raw) = cookie_field(&pack.cookie, "uin") {
                pack.uin = normalize_qq_uin(raw);
            }
        }
        _ => {}
    }
}

/// 平台登录态判据集中在这里，避免散落在各模块。
pub fn is_signed_in(source: &str, pack: &CredPack) -> bool {
    match source {
        // 空值（MUSIC_U=）等同缺失，与 qq 的 qm_keyst 判法对称。
        "netease" => cookie_field(&pack.cookie, "MUSIC_U").is_some_and(|v| !v.is_empty()),
        // spec §2.0：uin != 0 且 qm_keyst 存在（非空）。p_skey/wxuin 是网页态，
        // musicu.fcg 鉴权实际只认 qm_keyst，不能据此判登录，否则 vkey 失败会
        // 被误归成 vip_required。
        "qq" => {
            !pack.uin.is_empty()
                && pack.uin != "0"
                && cookie_field(&pack.cookie, "qm_keyst").is_some_and(|v| !v.is_empty())
        }
        "kugou" => !pack.userid.is_empty() && pack.userid != "0" && !pack.token.is_empty(),
        // 汽水的 PC 接口认会话 cookie：sessionid / sessionid_ss / sid_guard /
        // sid_tt 任一存在且非空即认为已登录。空值（sessionid=）等同缺失。
        "qishui" => SESSION_COOKIES
            .iter()
            .find_map(|k| cookie_field(&pack.cookie, k))
            .is_some_and(|v| !v.trim().is_empty()),
        _ => false,
    }
}

/// 汽水音乐的会话 cookie 字段名（任一存在即视为已登录）。
const SESSION_COOKIES: &[&str] = &["sessionid", "sessionid_ss", "sid_guard", "sid_tt"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_field_extracts_named_value() {
        let c = " a=1; MUSIC_U=abc; __csrf=x ";
        assert_eq!(cookie_field(c, "MUSIC_U"), Some("abc"));
        assert_eq!(cookie_field(c, "missing"), None);
    }

    #[test]
    fn signed_in_rules() {
        assert!(is_signed_in(
            "netease",
            &CredPack {
                cookie: "MUSIC_U=t;".into(),
                ..Default::default()
            }
        ));
        assert!(!is_signed_in(
            "netease",
            &CredPack {
                cookie: "x=y".into(),
                ..Default::default()
            }
        ));
        // MUSIC_U 只有空值也不算登录。
        assert!(!is_signed_in(
            "netease",
            &CredPack {
                cookie: "MUSIC_U=; __csrf=x".into(),
                ..Default::default()
            }
        ));
        assert!(is_signed_in(
            "qq",
            &CredPack {
                uin: "123".into(),
                cookie: "qm_keyst=k".into(),
                ..Default::default()
            }
        ));
        // 只有 p_skey/wxuin 不算登录（musicu 只认 qm_keyst）。
        assert!(!is_signed_in(
            "qq",
            &CredPack {
                uin: "123".into(),
                cookie: "p_skey=s; wxuin=123".into(),
                ..Default::default()
            }
        ));
        // qm_keyst 为空值也不算。
        assert!(!is_signed_in(
            "qq",
            &CredPack {
                uin: "123".into(),
                cookie: "qm_keyst=".into(),
                ..Default::default()
            }
        ));
        assert!(is_signed_in(
            "kugou",
            &CredPack {
                userid: "9".into(),
                token: "t".into(),
                ..Default::default()
            }
        ));
        assert!(!is_signed_in(
            "kugou",
            &CredPack {
                userid: "0".into(),
                token: "t".into(),
                ..Default::default()
            }
        ));
    }

    #[test]
    fn legacy_cookie_enrich_fills_kugou_identity() {
        // 手动粘贴的 cookie：按历史字段名 KugooID/KugooPassToken 补判态字段。
        let mut p = CredPack {
            cookie: " kg_mid=abc; KugooID=12345; KugooPassToken=tok9; x=y ".into(),
            ..Default::default()
        };
        enrich_from_cookie("kugou", &mut p);
        assert_eq!(p.userid, "12345");
        assert_eq!(p.token, "tok9");

        // 非酷狗源不改动。
        let mut q = CredPack {
            cookie: "KugooID=1; KugooPassToken=t;".into(),
            ..Default::default()
        };
        enrich_from_cookie("netease", &mut q);
        assert!(q.userid.is_empty());
        assert!(q.token.is_empty());

        // 已有 token/userid 不被覆盖。
        let mut r = CredPack {
            cookie: "KugooID=1; KugooPassToken=t;".into(),
            userid: "9".into(),
            token: "keep".into(),
            ..Default::default()
        };
        enrich_from_cookie("kugou", &mut r);
        assert_eq!(r.userid, "9");
        assert_eq!(r.token, "keep");
    }

    #[test]
    fn legacy_cookie_enrich_fills_qq_uin_and_gates_on_qm_keyst() {
        // cookie 的 uin=o00123 归一成 "123"，配合 qm_keyst 即判登录。
        let mut p = CredPack {
            cookie: " uin=o00123; qm_keyst=secret; ".into(),
            ..Default::default()
        };
        enrich_from_cookie("qq", &mut p);
        assert_eq!(p.uin, "123");
        assert!(is_signed_in("qq", &p));

        // 脏 uin 归一为 0；无 qm_keyst 不判登录。
        let mut q = CredPack {
            cookie: "uin=oabc; p_skey=x".into(),
            ..Default::default()
        };
        enrich_from_cookie("qq", &mut q);
        assert_eq!(q.uin, "0");
        assert!(!is_signed_in("qq", &q));

        // 已有 uin 不被覆盖。
        let mut r = CredPack {
            cookie: "uin=o00999".into(),
            uin: "42".into(),
            ..Default::default()
        };
        enrich_from_cookie("qq", &mut r);
        assert_eq!(r.uin, "42");
    }
}
