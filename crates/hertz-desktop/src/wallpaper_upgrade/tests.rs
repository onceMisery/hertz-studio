// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::{
    assets::AssetStore,
    library::{tempfileish, Library},
};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use std::borrow::Cow;

#[tokio::test]
async fn schema_eight_receipt_rebuild_preserves_all_fields_indexes_and_foreign_keys() {
    let root = tempfileish::temp_dir("receipt-schema-eight-preservation");
    let pool = old(root.path(), 8).await;
    sqlx::query("INSERT INTO drafts(draft_id,work_key,work_id,revision,document_json,created_at,updated_at) VALUES('work-draft-fixture','fixture','fixture',1,'{}',1,1)").execute(&pool).await.unwrap();
    for (index, kind) in ["builtin", "image"].iter().enumerate() {
        sqlx::query("INSERT INTO ai_receipts(receipt_id,service_owner,job_id,artifact_id,output_hash,state,metadata_json,document_json,provider,model,received_at,expires_at,draft_id,work_key,package_hash,kind,image_work_id,candidate_package_hash,candidate_bytes,save_title,pending_package_hash,thumbnail_json) VALUES(?,'owner',?,?,?,'saving','{\"old\":true}','{\"title\":\"unchanged\"}','provider','model',123,456,'work-draft-fixture','fixture',?,?,?, ?,70,'Exact title',?,'{\"width\":96}')")
            .bind(format!("receipt-{index}")).bind(format!("job-{index}")).bind(format!("artifact-{index}")).bind("a".repeat(64)).bind("b".repeat(64)).bind(kind).bind(format!("image-{index}")).bind("c".repeat(64)).bind(format!("{index:064x}")).execute(&pool).await.unwrap();
    }
    const SNAPSHOT: &str = "SELECT json_group_array(json_object('receipt',receipt_id,'owner',service_owner,'job',job_id,'artifact',artifact_id,'output',output_hash,'state',state,'metadata',metadata_json,'document',document_json,'provider',provider,'model',model,'received',received_at,'expiry',expires_at,'draft',draft_id,'work',work_key,'package',package_hash,'kind',kind,'imageWork',image_work_id,'candidateHash',candidate_package_hash,'candidateBytes',candidate_bytes,'title',save_title,'pending',pending_package_hash,'thumbnail',thumbnail_json)) FROM (SELECT * FROM ai_receipts ORDER BY receipt_id)";
    let before: String = sqlx::query_scalar(SNAPSHOT).fetch_one(&pool).await.unwrap();
    let mut interrupted = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../migrations/wallpaper/0009_ai_composition.sql"
    ))
    .execute(&mut *interrupted)
    .await
    .unwrap();
    interrupted.rollback().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(SNAPSHOT)
            .fetch_one(&pool)
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name='ai_asset_sets'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    MIGRATOR.run(&pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(SNAPSHOT)
            .fetch_one(&pool)
            .await
            .unwrap(),
        before
    );
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='ai_receipts'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(indexes.iter().any(|name| name == "idx_ai_pending_package"));
    assert!(indexes.iter().any(|name| name == "idx_ai_receipt_expiry"));
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await
        .unwrap()
        .is_empty());
    sqlx::query("DELETE FROM drafts WHERE draft_id='work-draft-fixture'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM ai_receipts WHERE draft_id IS NOT NULL")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    pool.close().await;
}

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
        "ai-candidates/unfinished",
        "operations",
    ] {
        std::fs::create_dir_all(root.join(directory)).unwrap();
    }
    for file in [
        "packages/original/original.hwpkg",
        "staging/unfinished/original.hwpkg",
        "derived/generation/image",
        "ai-candidates/unfinished/original.hwpkg",
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
        MIGRATOR.iter().last().unwrap().version
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
    std::fs::write(
        dir.path().join("ai-candidates/unfinished/original.hwpkg"),
        b"later candidate",
    )
    .unwrap();
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
    assert_eq!(
        std::fs::read(dir.path().join("ai-candidates/unfinished/original.hwpkg")).unwrap(),
        b"ai-candidates/unfinished/original.hwpkg"
    );
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
        // The inspection above still races the previous pool's shutdown. Await
        // that physical exit before the next iteration acquires another fee.
        release(dir.path()).await;
    }
    release(dir.path()).await;
}

#[tokio::test]
async fn fresh_app_is_lazy_and_first_library_open_serializes_with_config_gate() {
    // Other fixtures can still hold global SQLx admissions in closer threads.
    // This case needs available quota to test fresh-root laziness and the config
    // lock; isolate it like the exact SQLx fee witness below.
    const NAME: &str = "wallpaper_upgrade::tests::fresh_app_is_lazy_and_first_library_open_serializes_with_config_gate";
    if std::env::var("HERTZ_SQLX_LAZY_CHILD").as_deref() != Ok(NAME) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
            .env("HERTZ_SQLX_LAZY_CHILD", NAME)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "cold child {NAME} failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

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
async fn restoring_ai_receipts_expires_candidates_and_preserves_saved_work_and_drafts() {
    use crate::wallpaper::{
        ai_receipts::AiReceipts, generation::receive::ReceivedBuiltin, library::now_secs,
        work_drafts::WorkDrafts,
    };
    use hertz_wallpaper::generation::{WallpaperArtifact, WallpaperGenerationKind};
    use sha2::{Digest, Sha256};
    let root = tempfileish::temp_dir("upgrade-ai-receipts");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let receipts = AiReceipts::new(&library);
    let input = |index| {
        let bytes = serde_json::to_vec(
            &serde_json::json!({"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}}),
        )
        .unwrap();
        ReceivedBuiltin {
            artifact: WallpaperArtifact {
                artifact_id: uuid::Uuid::new_v4().to_string(),
                job_id: format!("restore-{index}"),
                kind: WallpaperGenerationKind::Builtin,
                bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
                mime: "application/json".into(),
                registry_hash: hertz_wallpaper::catalog().registry_hash.clone(),
                generation_schema_hash: "b".repeat(64),
                expires_at: ((now_secs() + 3600) * 1000).to_string(),
            },
            service_owner: "restore-owner".into(),
            provider: "fake".into(),
            model: "fixture".into(),
            bytes,
            epoch: 0,
        }
    };
    let saved = receipts.receive(input(0), || Ok(())).await.unwrap();
    let saved_id = saved["receiptId"].as_str().unwrap().to_owned();
    let saved = receipts
        .save(&saved_id, "已保存海岸".into(), &assets)
        .await
        .unwrap();
    let candidate = receipts.receive(input(1), || Ok(())).await.unwrap();
    let candidate_id = candidate["receiptId"].as_str().unwrap().to_owned();
    let saving = receipts.receive(input(2), || Ok(())).await.unwrap();
    let saving_id = saving["receiptId"].as_str().unwrap().to_owned();
    let drafts = WorkDrafts::new(&library);
    let draft = drafts
        .create_ai(receipts.document(&saving_id, 1).await.unwrap(), &saving_id)
        .await
        .unwrap();
    drafts.save(&draft.id, 1).await.unwrap();
    library.pool().close().await;
    drop(assets);
    drop(library);
    release(root.path()).await;
    let writer = RootOwner::exclusive(root.path()).unwrap();
    let snapshot = lifecycle::create_snapshot(writer.root(), "ai-receipt-fixture", &layout())
        .await
        .unwrap();
    drop(writer);
    let current = Library::open(root.path()).await.unwrap();
    AiReceipts::new(&current)
        .delete(&candidate_id)
        .await
        .unwrap();
    current.pool().close().await;
    drop(current);
    release(root.path()).await;
    let restore_root = root.path().to_string_lossy().into_owned();
    tokio::task::spawn_blocking(move || {
        maintenance(&[
            "--wallpaper-restore-upgrade-backup".into(),
            snapshot.id,
            "--accept-data-loss".into(),
            "--desktop-root".into(),
            restore_root,
        ])
    })
    .await
    .unwrap()
    .unwrap();
    let restored = Library::open(root.path()).await.unwrap();
    let receipts = AiReceipts::new(&restored);
    assert_eq!(
        receipts.get(&candidate_id).await.unwrap()["state"],
        "expired"
    );
    assert!(receipts.document(&candidate_id, 1).await.is_err());
    let retained: Option<String> =
        sqlx::query_scalar("SELECT document_json FROM ai_receipts WHERE receipt_id=?")
            .bind(&candidate_id)
            .fetch_one(restored.pool())
            .await
            .unwrap();
    assert!(retained.is_none());
    assert_eq!(receipts.get(&saved_id).await.unwrap(), saved);
    assert_eq!(receipts.get(&saving_id).await.unwrap()["state"], "saving");
    assert_eq!(
        WorkDrafts::new(&restored)
            .get(&draft.id)
            .await
            .unwrap()
            .saved_revision,
        Some(1)
    );
    let assets = AssetStore::new(root.path()).unwrap();
    assert!(assets
        .verify_installed(saved["packageHash"].as_str().unwrap())
        .unwrap()
        .is_some());
    let origins: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_origins")
        .fetch_one(restored.pool())
        .await
        .unwrap();
    assert_eq!(origins, 1);
    restored.pool().close().await;
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
            MIGRATOR.iter().last().unwrap().version
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert_eq!(count, MIGRATOR.iter().count() as i64);
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
        MIGRATOR.iter().last().unwrap().version
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

// r37: SQLx pool initialization is admitted before the first connection and
// refunded only after SQLx awaits every connection's close. The bound's
// per-connection terms cover the default command channel (50 slots),
// statement cache (100 entries), row channel (50 slots) and worker state.
fn sqlx_connection_structures_within_prior_bound() {
    // Independent copies of SQLx 0.8 defaults and conservative entry sizes.
    let command = 50_u64 * 256;
    let statements = 100_u64 * 192;
    let rows = 50_u64 * 64;
    let worker = 4096;
    assert!(command + statements + rows + worker <= 64 * 1024);
}

#[test]
fn sqlx_pool_admission_covers_open_peak_and_refunds_only_after_close() {
    // The process ledger is shared with every other test's closer threads, so
    // run this exact-state witness in a cold child.
    const NAME: &str = "wallpaper_upgrade::tests::sqlx_pool_admission_covers_open_peak_and_refunds_only_after_close";
    if std::env::var("HERTZ_SQLX_POOL_CHILD").as_deref() != Ok(NAME) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
            .env("HERTZ_SQLX_POOL_CHILD", NAME)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "cold child {NAME} failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    use crate::wallpaper::budget::{self, measure_requested_heap};
    sqlx_connection_structures_within_prior_bound();

    let dir = tempfileish::temp_dir("sqlx-prior");
    let budget = budget::global();
    let before = budget.usage();
    let requested = sqlx_pool_requested_bytes(layout().max_connections).unwrap();
    assert_eq!(requested, 352 * 1024);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (pool, sample) =
        measure_requested_heap(|| runtime.block_on(open_library(dir.path())).unwrap());
    assert!(!sample.overflow);
    assert!(u64::try_from(sample.peak).unwrap() <= requested);
    println!("sqlx-pool prior={requested} caller_peak={}", sample.peak);
    assert_eq!(
        budget.usage().sqlx_pool_bytes,
        before.sqlx_pool_bytes + requested
    );
    assert_eq!(
        budget.usage().sqlx_pool_records,
        before.sqlx_pool_records + 1
    );

    // A checked-out connection keeps SQLx's close pending: dropping the
    // admitted handle must not refund before the physical close.
    let clone = (*pool).clone();
    let connection = runtime.block_on(clone.acquire()).unwrap();
    drop(pool);
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert_eq!(
        budget.usage().sqlx_pool_bytes,
        before.sqlx_pool_bytes + requested
    );
    runtime.block_on(connection.close()).unwrap();
    drop(clone);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while budget.usage().sqlx_pool_bytes != before.sqlx_pool_bytes {
        assert!(
            std::time::Instant::now() < deadline,
            "SQLx close receipt did not arrive"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(budget.usage(), before);
    assert!(crate::root_owner::probe_database_handles(dir.path()).is_ok());

    // Explicit close is an immediate receipt.
    let dir = tempfileish::temp_dir("sqlx-close");
    let before = budget.usage();
    let pool = runtime.block_on(open_library(dir.path())).unwrap();
    assert_eq!(
        budget.usage().sqlx_pool_bytes,
        before.sqlx_pool_bytes + requested
    );
    runtime.block_on(pool.close());
    assert_eq!(budget.usage(), before);
    assert!(crate::root_owner::probe_database_handles(dir.path()).is_ok());
}
