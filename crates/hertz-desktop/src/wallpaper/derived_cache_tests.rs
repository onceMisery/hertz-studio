// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::super::library::tempfileish;
use super::*;

async fn setup(tag: &str) -> (tempfileish::TempDir, AssetStore, Library) {
    let root = tempfileish::temp_dir(tag);
    let store = AssetStore::new(root.path()).unwrap();
    let library = Library::open(root.path()).await.unwrap();
    (root, store, library)
}

fn relative(ordinal: u32) -> PathBuf {
    PathBuf::from(format!(
        "{ordinal:064x}/image-srgb-v1/{ordinal:064x}/gen-{ordinal}"
    ))
}

async fn generation(store: &AssetStore, library: &Library, ordinal: u32, used: i64) -> PathBuf {
    let relative = relative(ordinal);
    let directory = store.root().join("derived").join(&relative);
    std::fs::create_dir_all(&directory).unwrap();
    // 三个文件便于断言拒绝回收时没有删掉半个代际。索引故意少报，必须按磁盘计账。
    for name in ["render.png", "thumbnail.png", "receipt.json"] {
        std::fs::write(directory.join(name), vec![ordinal as u8; 10]).unwrap();
    }
    sqlx::query("INSERT INTO derived_entries VALUES (?, ?, 1, 'image-srgb-v1', ?)")
        .bind(format!("{ordinal:064x}"))
        .bind(relative.to_string_lossy().as_ref())
        .bind(used)
        .execute(library.pool())
        .await
        .unwrap();
    relative
}

async fn indexed(library: &Library) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM derived_entries")
        .fetch_one(library.pool())
        .await
        .unwrap()
}

#[tokio::test]
async fn lru_skips_leased_oldest_and_accounts_actual_bytes() {
    let (_root, store, library) = setup("derived-lru").await;
    let oldest = generation(&store, &library, 1, 1).await;
    let victim = generation(&store, &library, 2, 2).await;
    let newest = generation(&store, &library, 3, 3).await;
    let lease = pin(&store, &oldest).unwrap();
    let clone = Arc::clone(&lease);
    drop(lease);
    let cache = Writer::acquire(&store).unwrap();
    let sweep = cache.reclaim(&library, 10, 70).await.unwrap();
    assert_eq!((sweep.bytes, sweep.removed), (60, 1));
    assert!(!store.root().join("derived").join(victim).exists());
    for relative in [&oldest, &newest] {
        assert_eq!(
            directory_bytes(&store.root().join("derived").join(relative)).unwrap(),
            30
        );
    }
    assert_eq!(indexed(&library).await, 2);
    drop(clone);
    let sweep = cache.reclaim(&library, 10, 40).await.unwrap();
    assert_eq!(sweep.bytes, 30);
    assert!(!store.root().join("derived").join(oldest).exists());
    assert!(store.root().join("derived").join(newest).exists());
}

#[tokio::test]
async fn all_leased_is_cache_full_without_partial_deletion() {
    let (_root, store, library) = setup("derived-all-pinned").await;
    let relative = generation(&store, &library, 1, 0).await;
    let lease = pin(&store, &relative).unwrap();
    let cache = Writer::acquire(&store).unwrap();
    assert_eq!(
        cache.reclaim(&library, 1, 30).await.unwrap_err().code,
        "cache_full"
    );
    assert_eq!(
        directory_bytes(&store.root().join("derived").join(&relative)).unwrap(),
        30
    );
    assert_eq!(indexed(&library).await, 1);
    drop(lease);
    assert_eq!(cache.reclaim(&library, 1, 30).await.unwrap().bytes, 0);
    assert_eq!(indexed(&library).await, 0);
}

#[tokio::test]
async fn startup_recovers_orphans_trash_and_stale_index_idempotently() {
    let (root, store, library) = setup("derived-recovery").await;
    let current = generation(&store, &library, 1, 0).await;
    let orphan = generation(&store, &library, 2, 0).await;
    sqlx::query("DELETE FROM derived_entries WHERE cache_key = ?")
        .bind(format!("{:064x}", 2))
        .execute(library.pool())
        .await
        .unwrap();
    let missing = generation(&store, &library, 3, 0).await;
    let trash = root.path().join("derived/.trash/gc-crashed");
    std::fs::create_dir_all(trash.parent().unwrap()).unwrap();
    std::fs::rename(root.path().join("derived").join(missing), &trash).unwrap();
    let lease = pin(&store, &orphan).unwrap();
    let outside = root.path().join("packages/user-original");
    std::fs::write(&outside, b"keep-original").unwrap();
    super::super::jobs::reconcile_startup(&library, &store)
        .await
        .unwrap();
    assert!(!trash.exists());
    assert_eq!(indexed(&library).await, 1);
    assert!(root.path().join("derived").join(&orphan).exists());
    drop(lease);
    super::super::jobs::reconcile_startup(&library, &store)
        .await
        .unwrap();
    assert!(!root.path().join("derived").join(orphan).exists());
    assert!(root.path().join("derived").join(current).exists());
    assert_eq!(std::fs::read(outside).unwrap(), b"keep-original");
    assert_eq!(
        Writer::acquire(&store)
            .unwrap()
            .reclaim(&library, 0, CAP)
            .await
            .unwrap()
            .removed,
        0
    );
}

#[tokio::test]
async fn forged_database_paths_cannot_delete_outside_cache() {
    let (root, store, library) = setup("derived-paths").await;
    let outside = root.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("keep"), b"original").unwrap();
    for (ordinal, path) in ["../outside".into(), outside.to_string_lossy().to_string()]
        .into_iter()
        .enumerate()
    {
        sqlx::query("INSERT INTO derived_entries VALUES (?, ?, 123, 'old', 0)")
            .bind(ordinal.to_string())
            .bind(path)
            .execute(library.pool())
            .await
            .unwrap();
    }
    Writer::acquire(&store)
        .unwrap()
        .reclaim(&library, 0, CAP)
        .await
        .unwrap();
    assert_eq!(indexed(&library).await, 0);
    assert_eq!(std::fs::read(outside.join("keep")).unwrap(), b"original");
    for path in [
        PathBuf::from("../outside"),
        outside,
        PathBuf::from("a/b/c/gen-1"),
    ] {
        assert!(pin(&store, &path).is_err());
    }
}

#[tokio::test]
async fn write_gate_coordinates_distinct_store_instances() {
    let (root, store, _library) = setup("derived-writer").await;
    let other = AssetStore::new(root.path()).unwrap();
    let writer = Writer::acquire(&store).unwrap();
    assert_eq!(Writer::acquire(&other).err().unwrap().code, "budget_busy");
    drop(writer);
    assert!(Writer::acquire(&other).is_ok());
}

#[tokio::test]
async fn reparse_points_are_rejected_before_any_cleanup() {
    let (root, store, library) = setup("derived-reparse").await;
    let outside = root.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("keep"), b"original").unwrap();
    // Junction 不要求 symlink 权限。路径只作环境值传入，不拼进 shell 程序文本。
    use std::os::windows::process::CommandExt;
    let link = root.path().join("derived/link");
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:HERTZ_CACHE_TEST_LINK -Target $env:HERTZ_CACHE_TEST_TARGET | Out-Null"])
        .env("HERTZ_CACHE_TEST_LINK", &link).env("HERTZ_CACHE_TEST_TARGET", &outside)
        .creation_flags(0x0800_0000).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(Writer::acquire(&store)
        .unwrap()
        .reclaim(&library, 0, CAP)
        .await
        .is_err());
    assert_eq!(std::fs::read(outside.join("keep")).unwrap(), b"original");
    let prefix = root.path().join("derived").join(format!("{:064x}", 1));
    std::fs::rename(&link, &prefix).unwrap();
    assert!(
        pin(&store, &relative(1)).is_err(),
        "中间路径的 junction 同样不能绕过检查"
    );
    std::fs::remove_dir(prefix).unwrap();
}
