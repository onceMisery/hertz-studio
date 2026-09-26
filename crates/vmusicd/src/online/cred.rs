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

/// 写入凭据：CredPack 序列化后进钥匙串。钥匙串失败必须向上报错——绝不
/// 静默把凭据落回 SQLite 明文。
pub async fn put(db: &SqlitePool, source: &str, pack: &CredPack) -> Result<(), StoreError> {
    let mut pack = pack.clone();
    pack.saved_at = now_ms();
    let v = serde_json::to_value(&pack).map_err(|e| StoreError::Serialization(e.to_string()))?;
    let backend = crate::secrets::backend();
    let mut entry = backend.get(&cred_key(source)).map_err(StoreError::Database)?;
    entry.cred = Some(v.to_string());
    backend.put(&cred_key(source), &entry).map_err(StoreError::Database)?;
    // 迁移完成后清掉旧的裸 cookie 键，避免两处真相。
    let _ = sqlx::query("DELETE FROM settings WHERE key = ?1")
        .bind(legacy_cookie_key(source))
        .execute(db)
        .await;
    let _ = sqlx::query("DELETE FROM settings WHERE key = ?1")
        .bind(cred_key(source))
        .execute(db)
        .await;
    Ok(())
}

/// 读取凭据：钥匙串优先；SQLite 里只剩迁移失败时保留的旧数据（启动时已
/// ERROR 记录，属可观察状态，不构成静默回退）。
pub async fn get(db: &SqlitePool, source: &str) -> Result<Option<CredPack>, StoreError> {
    let backend = crate::secrets::backend();
    let entry = backend.get(&cred_key(source)).map_err(StoreError::Database)?;
    if let Some(raw) = entry.cred {
        match serde_json::from_str::<CredPack>(&raw) {
            Ok(pack) => return Ok(Some(pack)),
            // 只记是哪个源的键坏了，绝不把凭据内容写进日志。
            Err(_) => tracing::warn!(source = source, "钥匙串里的凭据 JSON 损坏，按未登录处理"),
        }
    }
    if let Some(v) = vmusic_store::settings::get(db, &cred_key(source)).await? {
        match serde_json::from_value::<CredPack>(v) {
            Ok(pack) => return Ok(Some(pack)),
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
    let backend = crate::secrets::backend();
    // 钥匙串删除失败不吞掉：登出必须真的把秘密清掉，而不是只在数据库里看起来登出。
    backend.delete(&cred_key(source)).map_err(StoreError::Database)?;
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

/// 非密设备身份（QQ guid、酷狗 mid/dfid）随凭据一起进钥匙串，SQLite 只留
/// 迁移失败时的旧值。
pub async fn get_device(db: &SqlitePool, source: &str) -> Result<Option<String>, StoreError> {
    let backend = crate::secrets::backend();
    let entry = backend.get(&cred_key(source)).map_err(StoreError::Database)?;
    if entry.device.is_some() {
        return Ok(entry.device);
    }
    Ok(vmusic_store::settings::get(db, &device_key(source))
        .await?
        .and_then(|v| v.as_str().map(str::to_string)))
}

pub async fn set_device(_db: &SqlitePool, source: &str, value: &str) -> Result<(), StoreError> {
    let backend = crate::secrets::backend();
    let mut entry = backend.get(&cred_key(source)).map_err(StoreError::Database)?;
    entry.device = Some(value.to_string());
    backend.put(&cred_key(source), &entry).map_err(StoreError::Database)?;
    Ok(())
}

/// 启动迁移：把 SQLite 里的旧凭据（online_cred_ / online_cookie_ /
/// online_device_）搬进钥匙串，成功后删除明文行。任何失败保留原数据、
/// 记 ERROR，下次启动重试——绝不为了"干净"把唯一副本删掉，也绝不静默跳过。
pub async fn migrate_secrets_to_keyring(db: &SqlitePool) {
    migrate_secrets_with(db, crate::secrets::backend().as_ref()).await;
}

/// 同上，但后端可注入（测试用 memory，不必碰真钥匙串）。
pub async fn migrate_secrets_with(db: &SqlitePool, backend: &dyn crate::secrets::SecretBackend) {
    // LIKE 的下划线通配会多匹配（onlineXcredX），但后面按真实前缀
    // strip_prefix 兜底，多匹配的键会被 continue 跳过，无害。
    let like = |prefix: &str| format!("{prefix}%");
    let mut keys: Vec<String> = sqlx::query_scalar(
        "SELECT key FROM settings WHERE key LIKE ?1 OR key LIKE ?2 OR key LIKE ?3",
    )
    .bind(like(CRED_PREFIX))
    .bind(like(super::COOKIE_PREFIX))
    .bind(like(DEVICE_PREFIX))
    .fetch_all(db)
    .await
    .unwrap_or_default();
    keys.sort();
    keys.dedup();
    if keys.is_empty() {
        return;
    }
    for key in keys {
        let (source, kind) = if let Some(rest) = key.strip_prefix(CRED_PREFIX) {
            (rest, "cred")
        } else if let Some(rest) = key.strip_prefix(super::COOKIE_PREFIX) {
            (rest, "cookie")
        } else if let Some(rest) = key.strip_prefix(DEVICE_PREFIX) {
            (rest, "device")
        } else {
            continue;
        };
        if source.is_empty() {
            continue;
        }
        let mut entry = match backend.get(&cred_key(source)) {
            Ok(e) => e,
            Err(e) => {
                tracing::error!(
                    source = source,
                    "凭据迁移到钥匙串读取失败，保留 SQLite 旧数据，下次启动重试: {e}"
                );
                continue;
            }
        };
        match kind {
            "cred" => {
                if let Ok(Some(v)) = vmusic_store::settings::get(db, &key).await {
                    entry.cred = Some(v.to_string());
                }
            }
            "device" => {
                if let Ok(Some(v)) = vmusic_store::settings::get(db, &key).await {
                    if let Some(s) = v.as_str() {
                        entry.device = Some(s.to_string());
                    }
                }
            }
            _ => {
                // legacy 裸 cookie 只在还没有结构化凭据时补位，不覆盖 cred 包。
                // 存成 CredPack JSON 对象，get 解析才有意义（裸字符串会被判损坏）。
                if entry.cred.is_none() {
                    if let Ok(Some(v)) = vmusic_store::settings::get(db, &key).await {
                        if let Some(cookie) = v.as_str() {
                            let pack = CredPack {
                                cookie: cookie.to_string(),
                                ..Default::default()
                            };
                            if let Ok(json) = serde_json::to_string(&pack) {
                                entry.cred = Some(json);
                            }
                        }
                    }
                }
            }
        }
        match backend.put(&cred_key(source), &entry) {
            Ok(()) => {
                // 只删本次处理的键：同源的其它行可能还在各自的迭代里等处理。
                let _ = sqlx::query("DELETE FROM settings WHERE key = ?1")
                    .bind(key.as_str())
                    .execute(db)
                    .await;
                tracing::info!(source = source, "平台凭据已迁入系统钥匙串");
            }
            Err(e) => {
                tracing::error!(
                    source = source,
                    "凭据写入钥匙串失败，保留 SQLite 旧数据，下次启动重试: {e}"
                );
            }
        }
    }
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

#[cfg(test)]
mod migrate_tests {
    use super::*;
    use crate::secrets::{MemoryStore, SecretBackend};

    #[tokio::test]
    async fn migration_moves_plaintext_rows_into_backend_and_deletes_them() {
        let dir = std::env::temp_dir().join(format!("vmusic-mig-test-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let pack = serde_json::json!({
            "cookie": "MUSIC_U=secret", "token": "", "userid": "", "dfid": "",
            "mid": "", "uin": "", "saved_at": 1
        });
        vmusic_store::settings::set(&db, &cred_key("netease"), &pack).await.unwrap();
        vmusic_store::settings::set(
            &db,
            &device_key("netease"),
            &serde_json::Value::String("guid-9".into()),
        )
        .await
        .unwrap();
        vmusic_store::settings::set(
            &db,
            &legacy_cookie_key("kugou"),
            &serde_json::Value::String("kgmid=old".into()),
        )
        .await
        .unwrap();

        // get()/put() 走全局单例：测试进程内把它换成 memory，不碰真钥匙串。
        // 迁移与断言用同一个实例，保证两边看到同一份数据。
        let backend = std::sync::Arc::new(MemoryStore::default());
        crate::secrets::set_backend_for_tests(backend.clone());
        migrate_secrets_with(&db, backend.as_ref()).await;

        // 钥匙串里有全部秘密，SQLite 明文行清空。
        let entry = backend.get(&cred_key("netease")).unwrap();
        assert!(entry.cred.as_deref().unwrap_or_default().contains("MUSIC_U=secret"));
        assert_eq!(entry.device.as_deref(), Some("guid-9"));
        assert!(backend.get(&cred_key("kugou")).unwrap().cred.is_some());
        for key in [cred_key("netease"), device_key("netease"), legacy_cookie_key("kugou")] {
            assert!(vmusic_store::settings::get(&db, &key).await.unwrap().is_none());
        }
        // get 走钥匙串：登录态保留。
        let got = get(&db, "netease").await.unwrap().unwrap();
        assert_eq!(got.cookie, "MUSIC_U=secret");
        assert_eq!(get_device(&db, "netease").await.unwrap().as_deref(), Some("guid-9"));
        // 幂等：再迁移一次无事发生。
        migrate_secrets_with(&db, backend.as_ref()).await;
        db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
