// SPDX-License-Identifier: MIT
//! Music-specific schema and resource binding; common snapshot mechanics have one owner.
use anyhow::Result;
pub use hertz_sqlite_lifecycle::{Applied, SchemaStatus, SnapshotSummary};
use sqlx::SqlitePool;
use std::path::Path;
pub(crate) static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

fn layout<'a>(
    roots: &[&str],
    migrator: &'a sqlx::migrate::Migrator,
) -> hertz_sqlite_lifecycle::Layout<'a> {
    hertz_sqlite_lifecycle::Layout {
        database: "vmusic.db",
        kind: "hertz-vmusic-upgrade",
        migrator,
        resources: roots
            .iter()
            .map(|root| hertz_sqlite_lifecycle::ResourceSpec::directory(*root))
            .collect(),
        max_connections: 4,
    }
}
pub fn current_schema() -> i64 {
    hertz_sqlite_lifecycle::current_schema(&MIGRATOR)
}
pub async fn inspect(data: &Path) -> Result<SchemaStatus> {
    hertz_sqlite_lifecycle::inspect(data, &layout(&[], &MIGRATOR)).await
}
pub async fn recover(data: &Path, roots: &[&str]) -> Result<String> {
    hertz_sqlite_lifecycle::recover(data, &layout(roots, &MIGRATOR)).await
}
pub async fn restore(
    data: &Path,
    id: &str,
    roots: &[&str],
    accept_data_loss: bool,
) -> Result<String> {
    hertz_sqlite_lifecycle::restore(data, id, &layout(roots, &MIGRATOR), accept_data_loss).await
}
pub async fn list(data: &Path, roots: &[&str]) -> Result<Vec<SnapshotSummary>> {
    hertz_sqlite_lifecycle::list(data, &layout(roots, &MIGRATOR)).await
}
pub(crate) async fn open(
    data: &Path,
    roots: &[&str],
    migrator: &sqlx::migrate::Migrator,
) -> Result<SqlitePool> {
    hertz_sqlite_lifecycle::open(data, &layout(roots, migrator)).await
}

#[cfg(test)]
async fn make_snapshot(
    data: &Path,
    roots: &[&str],
    reason: &str,
    migrator: &sqlx::migrate::Migrator,
) -> Result<SnapshotSummary> {
    hertz_sqlite_lifecycle::create_snapshot(data, reason, &layout(roots, migrator)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::{Connection, SqliteConnection};
    use std::path::PathBuf;
    const ROOT: &str = "upgrade-backups";
    const MARKER: &str = "database-upgrade-incomplete.json";
    const MANIFEST: &str = "snapshot.json";
    fn backup_path(data: &Path, id: &str) -> Result<PathBuf> {
        Ok(data.join(ROOT).join(id))
    }
    async fn reader(path: &Path) -> Result<SqliteConnection> {
        Ok(SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(path).read_only(true),
        )
        .await?)
    }

    use std::borrow::Cow;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("hertz-schema-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir(&path).unwrap();
            Self(std::fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let resolved = std::fs::canonicalize(&self.0).unwrap();
            assert_eq!(
                resolved.parent().unwrap(),
                std::fs::canonicalize(std::env::temp_dir()).unwrap()
            );
            assert!(resolved
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("hertz-schema-"));
            std::fs::remove_dir_all(resolved).unwrap();
        }
    }
    fn prefix(count: usize) -> sqlx::migrate::Migrator {
        let mut migrator = sqlx::migrate!("../../migrations");
        migrator.migrations = Cow::Owned(migrator.iter().take(count).cloned().collect());
        migrator
    }
    async fn old(data: &Path, count: usize) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(data.join("vmusic.db"))
                    .create_if_missing(true)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
            )
            .await
            .unwrap();
        prefix(count).run(&pool).await.unwrap();
        crate::settings::set(&pool, "fixture", &serde_json::json!("before"))
            .await
            .unwrap();
        pool
    }
    fn asset(data: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = data.join("stage-media/objects").join(name);
        std::fs::create_dir_all(&path).unwrap();
        let path = path.join("source");
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[tokio::test]
    async fn wal_snapshot_contains_committed_rows_and_keeps_source_main_bytes() {
        let fixture = Fixture::new();
        let pool = old(&fixture.0, 28).await;
        sqlx::query("PRAGMA wal_autocheckpoint=0")
            .execute(&pool)
            .await
            .unwrap();
        crate::settings::set(&pool, "wal_only", &serde_json::json!("committed"))
            .await
            .unwrap();
        asset(&fixture.0, "original", b"immutable media");
        let before = std::fs::read(fixture.0.join("vmusic.db")).unwrap();
        let snapshot = make_snapshot(&fixture.0, &["stage-media/objects"], "fixture", &MIGRATOR)
            .await
            .unwrap();
        assert_eq!(before, std::fs::read(fixture.0.join("vmusic.db")).unwrap());
        let mut image = reader(
            &backup_path(&fixture.0, &snapshot.id)
                .unwrap()
                .join("database.db"),
        )
        .await
        .unwrap();
        let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='wal_only'")
            .fetch_one(&mut image)
            .await
            .unwrap();
        assert_eq!(value, "\"committed\"");
        image.close().await.unwrap();
        pool.close().await;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(fixture.0.join(ROOT))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[tokio::test]
    async fn partial_migration_failure_restores_original_ledger_and_records() {
        let fixture = Fixture::new();
        old(&fixture.0, 27).await.close().await;
        asset(&fixture.0, "original", b"original data");
        let mut failing = sqlx::migrate!("../../migrations");
        let mut migrations = failing.iter().cloned().collect::<Vec<_>>();
        migrations.push(sqlx::migrate::Migration::new(
            30,
            "fixture failure".into(),
            sqlx::migrate::MigrationType::Simple,
            "INSERT INTO nonexistent_fixture_table VALUES (1);".into(),
            false,
        ));
        failing.migrations = Cow::Owned(migrations);
        let error = open(&fixture.0, &["stage-media/objects"], &failing)
            .await
            .err()
            .unwrap();
        assert!(
            error.to_string().contains("database_upgrade_failed"),
            "{error:#}"
        );
        assert_eq!(inspect(&fixture.0).await.unwrap().current, 27);
        assert!(!fixture.0.join(MARKER).exists());
        let mut connection = reader(&fixture.0.join("vmusic.db")).await.unwrap();
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sqlite_master WHERE name='stage_media_assets'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(count, 0);
        let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='fixture'")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(value, "\"before\"");
        connection.close().await.unwrap();
        assert_eq!(
            std::fs::read(fixture.0.join("stage-media/objects/original/source")).unwrap(),
            b"original data"
        );
    }

    #[tokio::test]
    async fn future_dirty_and_mismatched_ledgers_reject_without_source_changes() {
        for alteration in ["INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(999,'future',1,X'00',0)", "UPDATE _sqlx_migrations SET success=0 WHERE version=1", "UPDATE _sqlx_migrations SET checksum=X'00' WHERE version=1"] {
            let fixture = Fixture::new(); let pool = old(&fixture.0, 29).await;
            sqlx::query(alteration).execute(&pool).await.unwrap(); pool.close().await;
            let before = std::fs::read(fixture.0.join("vmusic.db")).unwrap();
            assert!(open(&fixture.0, &[], &MIGRATOR).await.is_err());
            assert_eq!(before, std::fs::read(fixture.0.join("vmusic.db")).unwrap());
            assert!(!fixture.0.join(ROOT).exists());
        }
    }

    #[tokio::test]
    async fn historical_restore_recovers_deleted_media_and_rescue_recovers_later_state() {
        let fixture = Fixture::new();
        old(&fixture.0, 28).await.close().await;
        let original = asset(&fixture.0, "original", b"before media");
        let pool = open(&fixture.0, &["stage-media/objects"], &MIGRATOR)
            .await
            .unwrap();
        let snapshot = list(&fixture.0, &["stage-media/objects"])
            .await
            .unwrap()
            .remove(0);
        // Version-1 music snapshots predate explicit resource kinds. Keep the
        // saved bytes and directory inventory, then restore that old envelope.
        let manifest_path = fixture.0.join(ROOT).join(&snapshot.id).join(MANIFEST);
        let mut legacy: serde_json::Value =
            serde_json::from_reader(std::fs::File::open(&manifest_path).unwrap()).unwrap();
        for resource in legacy["resources"].as_array_mut().unwrap() {
            resource.as_object_mut().unwrap().remove("kind");
        }
        std::fs::write(&manifest_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        crate::settings::set(&pool, "fixture", &serde_json::json!("after"))
            .await
            .unwrap();
        pool.close().await;
        std::fs::remove_file(original).unwrap();
        asset(&fixture.0, "later", b"later media");
        assert!(
            restore(&fixture.0, &snapshot.id, &["stage-media/objects"], false)
                .await
                .is_err()
        );
        let rescue = restore(&fixture.0, &snapshot.id, &["stage-media/objects"], true)
            .await
            .unwrap();
        assert_eq!(inspect(&fixture.0).await.unwrap().current, 28);
        assert_eq!(
            std::fs::read(fixture.0.join("stage-media/objects/original/source")).unwrap(),
            b"before media"
        );
        assert!(!fixture.0.join("stage-media/objects/later").exists());
        restore(&fixture.0, &rescue, &["stage-media/objects"], true)
            .await
            .unwrap();
        assert_eq!(inspect(&fixture.0).await.unwrap().current, 29);
        assert_eq!(
            std::fs::read(fixture.0.join("stage-media/objects/later/source")).unwrap(),
            b"later media"
        );
        assert!(!fixture
            .0
            .join("stage-media/objects/original/source")
            .exists());
    }

    #[tokio::test]
    async fn corrupt_cross_profile_and_traversal_snapshots_do_not_replace_database() {
        let fixture = Fixture::new();
        old(&fixture.0, 28).await.close().await;
        let pool = open(&fixture.0, &[], &MIGRATOR).await.unwrap();
        pool.close().await;
        let snapshot = list(&fixture.0, &[]).await.unwrap().remove(0);
        let before = std::fs::read(fixture.0.join("vmusic.db")).unwrap();
        assert!(restore(&fixture.0, "../escape", &[], true).await.is_err());
        let directory = backup_path(&fixture.0, &snapshot.id).unwrap();
        let manifest: serde_json::Value =
            serde_json::from_reader(std::fs::File::open(directory.join(MANIFEST)).unwrap())
                .unwrap();
        let mut changed = manifest.clone();
        changed["sourceDir"] = serde_json::json!(fixture.0.join("other"));
        std::fs::write(
            directory.join(MANIFEST),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        assert!(restore(&fixture.0, &snapshot.id, &[], true).await.is_err());
        std::fs::write(
            directory.join(MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        std::fs::write(directory.join("database.db"), b"corrupt").unwrap();
        assert!(restore(&fixture.0, &snapshot.id, &[], true).await.is_err());
        assert_eq!(before, std::fs::read(fixture.0.join("vmusic.db")).unwrap());
        assert!(!fixture.0.join(MARKER).exists());
    }

    #[tokio::test]
    async fn unregistered_sqlite_sidecars_reject_and_do_not_hide_healthy_snapshots() {
        let fixture = Fixture::new();
        old(&fixture.0, 28).await.close().await;
        open(&fixture.0, &[], &MIGRATOR)
            .await
            .unwrap()
            .close()
            .await;
        let older = list(&fixture.0, &[]).await.unwrap().remove(0);
        let healthy = make_snapshot(&fixture.0, &[], "fixture", &MIGRATOR)
            .await
            .unwrap();
        let directory = backup_path(&fixture.0, &older.id).unwrap();
        let before = std::fs::read(fixture.0.join("vmusic.db")).unwrap();
        for suffix in ["-wal", "-shm", "-journal"] {
            let sidecar = directory.join(format!("database.db{suffix}"));
            std::fs::write(&sidecar, b"unregistered SQLite data").unwrap();
            assert!(restore(&fixture.0, &older.id, &[], true).await.is_err());
            let listed = list(&fixture.0, &[]).await.unwrap();
            assert!(listed
                .iter()
                .any(|entry| entry.id == older.id && entry.verification_error.is_some()));
            assert!(listed
                .iter()
                .any(|entry| entry.id == healthy.id && entry.verification_error.is_none()));
            std::fs::remove_file(sidecar).unwrap();
        }
        assert_eq!(before, std::fs::read(fixture.0.join("vmusic.db")).unwrap());
        assert!(!fixture.0.join(MARKER).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dangling_database_and_sidecar_links_reject_before_creating_targets() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let target = fixture.0.join("must-not-exist");
        symlink(&target, fixture.0.join("vmusic.db")).unwrap();
        assert!(open(&fixture.0, &[], &MIGRATOR).await.is_err());
        assert!(!target.exists());
        std::fs::remove_file(fixture.0.join("vmusic.db")).unwrap();
        for suffix in ["-wal", "-shm", "-journal"] {
            let sidecar = fixture.0.join(format!("vmusic.db{suffix}"));
            symlink(&target, &sidecar).unwrap();
            assert!(open(&fixture.0, &[], &MIGRATOR).await.is_err());
            assert!(!target.exists());
            std::fs::remove_file(sidecar).unwrap();
        }
    }
}
