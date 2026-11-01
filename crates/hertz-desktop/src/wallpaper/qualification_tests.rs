// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::super::{
    library::tempfileish,
    media::{Container, MediaProbe},
};
use super::*;

fn sample_key(tag: u8) -> Key {
    Key {
        digest: format!("{tag:064x}"),
        content: format!("{:064x}", 1),
        environment: format!("{:064x}", 2),
    }
}

#[test]
fn identity_binds_actual_bytes_metadata_and_environment() {
    let mut entry = hertz_wallpaper::VerifiedEntry {
        path: "file.png".into(),
        bytes: 1,
        sha256: "a".repeat(64),
        mime: Some("image/png".into()),
    };
    let mut info = MediaProbe {
        container: Container::Image,
        codec: "png".into(),
        profile: None,
        encoded_width: 1,
        encoded_height: 1,
        display_width: 1,
        display_height: 1,
        rotation_degrees: 0,
        pixel_aspect_ratio: 1.0,
        duration_ms: None,
        source_fps: None,
        fps_upper_bound: None,
    };
    let mut environment = Environment {
        browser: "test-webview2".into(),
        fingerprint: "b".repeat(64),
    };
    let initial = key(&entry, &info, &environment).unwrap().digest;
    entry.path = "other-package/same-bytes.png".into();
    assert_eq!(initial, key(&entry, &info, &environment).unwrap().digest);
    entry.sha256 = "c".repeat(64);
    assert_ne!(initial, key(&entry, &info, &environment).unwrap().digest);
    entry.sha256 = "a".repeat(64);
    info.encoded_width = 2;
    assert_ne!(initial, key(&entry, &info, &environment).unwrap().digest);
    info.encoded_width = 1;
    environment.browser = "new-webview2".into();
    assert_ne!(initial, key(&entry, &info, &environment).unwrap().digest);
    environment.browser = "test-webview2".into();
    environment.fingerprint = "d".repeat(64);
    assert_ne!(initial, key(&entry, &info, &environment).unwrap().digest);
}

#[tokio::test]
async fn success_has_bounded_age_and_rechecks_stored_identity() {
    let root = tempfileish::temp_dir("qualification-age");
    let library = Library::open(root.path()).await.unwrap();
    let key = sample_key(1);
    record(&library, &key, 100).await.unwrap();
    assert!(hit(&library, &key, 101).await.unwrap());
    assert!(
        !hit(&library, &key, 99).await.unwrap(),
        "时钟倒退不复用未来证明"
    );
    assert!(!hit(&library, &key, 101 + TTL).await.unwrap());
    sqlx::query("UPDATE media_qualifications SET adapter_version = 'old'")
        .execute(library.pool())
        .await
        .unwrap();
    assert!(!hit(&library, &key, 101).await.unwrap());
    record(&library, &key, 102).await.unwrap();
    sqlx::query("UPDATE media_qualifications SET content_hash = ?")
        .bind("f".repeat(64))
        .execute(library.pool())
        .await
        .unwrap();
    assert!(
        !hit(&library, &key, 103).await.unwrap(),
        "不只信任主键字符串"
    );
}

#[tokio::test]
async fn records_survive_reopen_and_enforce_lru_limit() {
    let root = tempfileish::temp_dir("qualification-cap");
    let library = Library::open(root.path()).await.unwrap();
    sqlx::query("WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n < 4096) INSERT INTO media_qualifications SELECT printf('%064x', n), printf('%064x', 1), printf('%064x', 2), ?, 100, n FROM ids")
        .bind(ADAPTER).execute(library.pool()).await.unwrap();
    let newest = Key {
        digest: "f".repeat(64),
        ..sample_key(9)
    };
    // 旧行的 last_used 特意较大；新纪录仍必须在上限内，不依赖插入条数计算容量。
    record(&library, &newest, 5000).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_qualifications")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(count, CAP);
    assert!(!hit(&library, &sample_key(1), 5001).await.unwrap());
    assert!(hit(&library, &newest, 5001).await.unwrap());
    library.pool().close().await;
    let reopened = Library::open(root.path()).await.unwrap();
    assert!(hit(&reopened, &newest, 5002).await.unwrap());
    record(&reopened, &sample_key(8), 5001 + TTL).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media_qualifications")
            .fetch_one(reopened.pool())
            .await
            .unwrap(),
        1
    );
}
