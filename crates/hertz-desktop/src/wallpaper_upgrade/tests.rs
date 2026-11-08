// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::{
    assets::AssetStore,
    library::{tempfileish, Library},
};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use std::borrow::Cow;

async fn old(root: &Path, count: usize) -> SqlitePool {
    let mut prefix = sqlx::migrate!("migrations/wallpaper");
    prefix.migrations = Cow::Owned(prefix.iter().take(count).cloned().collect());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(root.join("wallpaper.db"))
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal),
        )
        .await
        .unwrap();
    prefix.run(&pool).await.unwrap();
    sqlx::query("INSERT INTO works(work_key,source_id,title,kind,created_at,updated_at) VALUES('fixture','local','Before','builtin',1,1)")
        .execute(&pool).await.unwrap();
    pool
}

fn resources(root: &Path) {
    for directory in [
        "packages/original/empty",
        "staging/unfinished",
        "derived/generation",
        "operations",
    ] {
        std::fs::create_dir_all(root.join(directory)).unwrap();
    }
    for file in [
        "packages/original/original.hwpkg",
        "staging/unfinished/original.hwpkg",
        "derived/generation/image",
        "operations/receipt.json",
    ] {
        std::fs::write(root.join(file), file.as_bytes()).unwrap();
    }
    std::fs::write(
        root.join("config.json"),
        b"{\"schemaVersion\":5,\"revision\":1}",
    )
    .unwrap();
}

async fn release(root: &Path) {
    for _ in 0..100 {
        if RootOwner::exclusive(root).is_ok() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("pool did not release root admission after final owner exited");
}

#[tokio::test]
async fn production_upgrade_covers_resources_history_rescue_and_export_revocation() {
    let dir = tempfileish::temp_dir("upgrade-production");
    let pool = old(dir.path(), 5).await;
    sqlx::query("INSERT INTO export_jobs(job_id,package_hash,name,state,generation,target_path,temporary_path,file_identity,updated_at) VALUES('old-export',?1,'original.hwpkg','publishing',1,'C:\\external.hwpkg','C:\\old.part','stale-identity',1)")
        .bind("a".repeat(64)).execute(&pool).await.unwrap();
    pool.close().await;
    resources(dir.path());
    assert!(admit_config(dir.path())
        .err()
        .unwrap()
        .to_string()
        .contains("壁纸资料"));
    let app = prepare(dir.path()).unwrap();
    let library = Library::open(dir.path()).await.unwrap();
    assert_eq!(
        lifecycle::inspect(dir.path(), &layout())
            .await
            .unwrap()
            .current,
        6
    );
    let backup = lifecycle::list(dir.path(), &layout())
        .await
        .unwrap()
        .remove(0);
    assert_eq!(backup.current_schema, 5);
    let paths: i64 =
        sqlx::query_scalar("SELECT count(*) FROM export_jobs WHERE target_path IS NOT NULL")
            .fetch_one(library.pool())
            .await
            .unwrap();
    assert_eq!(paths, 1);
    let args = vec![
        "--wallpaper-restore-upgrade-backup".into(),
        backup.id.clone(),
        "--accept-data-loss".into(),
        "--desktop-root".into(),
        dir.path().to_string_lossy().to_string(),
    ];
    assert!(maintenance(&args).is_err());
    sqlx::query("UPDATE works SET title='After'")
        .execute(library.pool())
        .await
        .unwrap();
    library.pool().close().await;
    drop(library);
    drop(app);
    release(dir.path()).await;
    let mut invalid = args.clone();
    invalid[1] = "upgrade-invalid".into();
    assert!(maintenance(&invalid).is_err());
    assert!(!dir.path().join(EXPORT_RESET).exists());
    let unchanged = Library::open(dir.path()).await.unwrap();
    let paths: i64 =
        sqlx::query_scalar("SELECT count(*) FROM export_jobs WHERE target_path IS NOT NULL")
            .fetch_one(unchanged.pool())
            .await
            .unwrap();
    assert_eq!(paths, 1, "invalid restore must not revoke current exports");
    unchanged.pool().close().await;
    drop(unchanged);
    release(dir.path()).await;
    let initial = std::fs::read(dir.path().join("config.json")).unwrap();
    std::fs::write(dir.path().join("config.json"), b"later config").unwrap();
    std::fs::write(
        dir.path().join("derived/generation/image"),
        b"later derivative",
    )
    .unwrap();
    std::fs::remove_file(dir.path().join("staging/unfinished/original.hwpkg")).unwrap();
    let restored = maintenance(&args).unwrap();
    assert!(restored["rescueSnapshotId"].as_str().is_some());
    assert_eq!(
        std::fs::read(dir.path().join("config.json")).unwrap(),
        initial
    );
    assert_eq!(
        std::fs::read(dir.path().join("derived/generation/image")).unwrap(),
        b"derived/generation/image"
    );
    assert!(dir.path().join("packages/original/empty").is_dir());
    assert!(dir
        .path()
        .join("staging/unfinished/original.hwpkg")
        .exists());
    // Opening restored v5 upgrades again, revokes the snapshot's old export
    // identity, and preserves the restored old business state.
    let library = Library::open(dir.path()).await.unwrap();
    let title: String = sqlx::query_scalar("SELECT title FROM works WHERE work_key='fixture'")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(title, "Before");
    let paths: i64 =
        sqlx::query_scalar("SELECT count(*) FROM export_jobs WHERE target_path IS NOT NULL")
            .fetch_one(library.pool())
            .await
            .unwrap();
    assert_eq!(paths, 0);
    assert!(!dir.path().join(EXPORT_RESET).exists());
    library.pool().close().await;
    drop(library);
    release(dir.path()).await;
    let mut rescue_args = args;
    rescue_args[1] = restored["rescueSnapshotId"].as_str().unwrap().into();
    maintenance(&rescue_args).unwrap();
    assert_eq!(
        std::fs::read(dir.path().join("config.json")).unwrap(),
        b"later config"
    );
}

#[tokio::test]
async fn pool_clone_connection_and_assets_keep_admission_after_library_drop() {
    let dir = tempfileish::temp_dir("upgrade-pool-lifetime");
    let library = Library::open(dir.path()).await.unwrap();
    let pool = library.pool().clone();
    let mut connection = pool.acquire().await.unwrap();
    drop(library);
    drop(pool);
    assert!(RootOwner::exclusive(dir.path()).is_err());
    sqlx::query("INSERT INTO works(work_key,source_id,title,kind,created_at,updated_at) VALUES('still-writes','local','Alive','builtin',1,1)")
        .execute(&mut *connection).await.unwrap();
    drop(connection);
    release(dir.path()).await;
    let assets = AssetStore::new(dir.path()).unwrap();
    assert!(RootOwner::exclusive(dir.path()).is_err());
    drop(assets);
    assert!(RootOwner::exclusive(dir.path()).is_ok());
    let library = Library::open(dir.path()).await.unwrap();
    let mut raw = library.pool().acquire().await.unwrap().detach();
    library.pool().close().await;
    drop(library);
    let mut physical_barrier = false;
    for _ in 0..100 {
        let error = RootOwner::exclusive(dir.path())
            .err()
            .expect("detached SQLite must keep exclusive admission closed");
        if error.to_string().contains("desktop_legacy_busy") {
            physical_barrier = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(
        physical_barrier,
        "PoolInner must retire while the raw SQLite handle is still open"
    );
    sqlx::query("UPDATE works SET title='Detached still writes'")
        .execute(&mut raw)
        .await
        .unwrap();
    sqlx::Connection::close(raw).await.unwrap();
    release(dir.path()).await;
}

#[tokio::test]
async fn current_shared_inspection_survives_other_pool_shutdown_sidecars() {
    let dir = tempfileish::temp_dir("upgrade-reader-close-race");
    for _ in 0..25 {
        let library = Library::open(dir.path()).await.unwrap();
        sqlx::query("UPDATE works SET updated_at=updated_at+1")
            .execute(library.pool())
            .await
            .unwrap();
        // Ordinary Drop permits the next current reader while the old SQLite
        // worker is closing. WAL/SHM may disappear during readonly inspection.
        drop(library);
        let assets = AssetStore::new(dir.path()).unwrap();
        drop(assets);
    }
    release(dir.path()).await;
}

#[tokio::test]
async fn fresh_app_is_lazy_and_first_library_open_serializes_with_config_gate() {
    let dir = tempfileish::temp_dir("upgrade-lazy");
    let app = prepare(dir.path()).unwrap();
    assert!(!dir.path().join("wallpaper.db").exists());
    let lock = FileLock::acquire(dir.path()).unwrap();
    assert!(Library::open(dir.path()).await.is_err());
    assert!(!dir.path().join("wallpaper.db").exists());
    drop(lock);
    let first = Library::open(dir.path()).await.unwrap();
    let second = Library::open(dir.path()).await.unwrap();
    assert!(admit_config(dir.path()).is_ok());
    assert!(RootOwner::exclusive(dir.path()).is_err());
    first.pool().close().await;
    second.pool().close().await;
    drop(first);
    drop(second);
    drop(app);
    release(dir.path()).await;
}

#[tokio::test]
async fn simultaneous_first_library_opens_never_observe_a_partial_schema() {
    let dir = tempfileish::temp_dir("upgrade-concurrent-first");
    let (first, second) = tokio::join!(Library::open(dir.path()), Library::open(dir.path()));
    assert!(first.is_ok() || second.is_ok());
    for library in [first, second].into_iter().flatten() {
        assert_eq!(
            lifecycle::inspect(dir.path(), &layout())
                .await
                .unwrap()
                .current,
            6
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert_eq!(count, 6);
        library.pool().close().await;
    }
    release(dir.path()).await;
    let retry = Library::open(dir.path()).await.unwrap();
    assert!(!dir.path().join("database-upgrade-incomplete.json").exists());
    assert!(!dir.path().join("upgrade-backups").exists());
    retry.pool().close().await;
}

#[tokio::test]
async fn idle_legacy_sqlite_pool_and_content_writer_are_rejected_before_snapshot() {
    let dir = tempfileish::temp_dir("upgrade-legacy");
    let pool = old(dir.path(), 5).await;
    resources(dir.path());
    let error = prepare(dir.path()).err().unwrap();
    assert!(format!("{error:#}").contains("desktop_legacy_busy"));
    assert!(!dir.path().join("upgrade-backups").exists());
    let args = vec![
        "--wallpaper-list-upgrade-backups".into(),
        "--desktop-root".into(),
        dir.path().to_string_lossy().into(),
    ];
    assert!(format!("{:#}", maintenance(&args).err().unwrap()).contains("desktop_legacy_busy"));
    pool.close().await;
    drop(pool);
    let content = crate::wallpaper::content_quota::acquire_gate(dir.path()).unwrap();
    assert!(prepare(dir.path()).is_err());
    assert!(!dir.path().join("upgrade-backups").exists());
    drop(content);
    let app = prepare(dir.path()).unwrap();
    assert_eq!(
        lifecycle::inspect(dir.path(), &layout())
            .await
            .unwrap()
            .current,
        6
    );
    drop(app);
}

#[tokio::test]
async fn failed_real_migration_restores_all_previous_commits_and_resources() {
    let dir = tempfileish::temp_dir("upgrade-failure");
    let pool = old(dir.path(), 3).await;
    // v4 succeeds; the real v5 migration then fails on this existing table.
    sqlx::query("CREATE TABLE export_jobs(conflict TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    resources(dir.path());
    let before = std::fs::read(dir.path().join("config.json")).unwrap();
    let error = prepare(dir.path()).err().unwrap();
    assert!(format!("{error:#}").contains("database_upgrade_failed"));
    assert_eq!(
        lifecycle::inspect(dir.path(), &layout())
            .await
            .unwrap()
            .current,
        3
    );
    assert_eq!(
        std::fs::read(dir.path().join("config.json")).unwrap(),
        before
    );
    assert!(!dir.path().join("database-upgrade-incomplete.json").exists());
    assert_eq!(
        lifecycle::list(dir.path(), &layout()).await.unwrap().len(),
        1
    );
    assert!(RootOwner::exclusive(dir.path()).is_ok());
}

#[tokio::test]
async fn pending_and_future_and_incomplete_barriers_reject_config_before_writes() {
    let dir = tempfileish::temp_dir("upgrade-config-deny");
    let pool = old(dir.path(), 5).await;
    resources(dir.path());
    let before = std::fs::read(dir.path().join("config.json")).unwrap();
    assert!(admit_config(dir.path()).is_err());
    sqlx::query("UPDATE _sqlx_migrations SET version=99 WHERE version=5")
        .execute(&pool)
        .await
        .unwrap();
    assert!(prepare(dir.path()).is_err());
    assert!(AssetStore::new(dir.path()).is_err());
    // operation_at takes root admission before the journal may reconcile.
    assert!(crate::config::operation_at(dir.path(), "unknown").is_err());
    assert_eq!(
        std::fs::read(dir.path().join("config.json")).unwrap(),
        before
    );
    assert!(!dir.path().join("upgrade-backups").exists());
    pool.close().await;
    std::fs::write(
        dir.path().join("database-upgrade-incomplete.json"),
        b"interrupted",
    )
    .unwrap();
    assert!(admit_config(dir.path()).is_err());
    assert!(Library::open(dir.path()).await.is_err());
}

#[test]
fn offline_cli_requires_explicit_existing_root_and_loss_acceptance() {
    assert!(maintenance(&["--wallpaper-list-upgrade-backups".into()]).is_err());
    let dir = tempfileish::temp_dir("upgrade-cli");
    let missing = dir.path().join("absent");
    assert!(maintenance(&[
        "--wallpaper-list-upgrade-backups".into(),
        "--desktop-root".into(),
        missing.to_string_lossy().into()
    ])
    .is_err());
    assert!(!missing.exists());
    assert!(maintenance(&[
        "--wallpaper-restore-upgrade-backup".into(),
        "upgrade-id".into(),
        "--desktop-root".into(),
        dir.path().to_string_lossy().into()
    ])
    .is_err());
    assert!(!dir.path().join("wallpaper.db").exists());
}
