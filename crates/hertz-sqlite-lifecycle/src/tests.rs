// SPDX-License-Identifier: MIT
use super::*;
use std::borrow::Cow;

static WALLPAPER: sqlx::migrate::Migrator = sqlx::migrate!("../hertz-desktop/migrations/wallpaper");

#[cfg(windows)]
#[tokio::test]
async fn dangling_recovery_marker_is_rejected_without_opening_or_overwriting_data() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join(MARKER);
    let absent = dir.path().join("absent");
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&marker)
        .arg(&absent)
        .output()
        .unwrap();
    assert!(status.status.success());
    assert!(!marker.exists());
    let layout = wallpaper(&WALLPAPER);
    assert!(inspect(dir.path(), &layout).await.is_err());
    assert!(open(dir.path(), &layout).await.is_err());
    assert!(!dir.path().join("wallpaper.db").exists());
    assert!(std::fs::symlink_metadata(&marker).is_ok());
    std::fs::remove_dir(marker).unwrap();
}

fn wallpaper(migrator: &sqlx::migrate::Migrator) -> Layout<'_> {
    Layout {
        database: "wallpaper.db",
        kind: "hertz-wallpaper-upgrade",
        migrator,
        resources: vec![
            ResourceSpec::directory("packages"),
            ResourceSpec::file("config.json"),
            ResourceSpec::directory("operations"),
            ResourceSpec::file("absent.json"),
        ],
        max_connections: 2,
    }
}

async fn old(data: &Path, count: usize) -> SqlitePool {
    let mut prefix = sqlx::migrate!("../hertz-desktop/migrations/wallpaper");
    prefix.migrations = Cow::Owned(prefix.iter().take(count).cloned().collect());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(data.join("wallpaper.db"))
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
        )
        .await
        .unwrap();
    prefix.run(&pool).await.unwrap();
    sqlx::query("INSERT INTO works(work_key,source_id,title,kind,created_at,updated_at) VALUES('fixture','local','Before','builtin',1,1)").execute(&pool).await.unwrap();
    pool
}

fn assets(data: &Path) {
    std::fs::create_dir_all(data.join("packages/original/empty")).unwrap();
    std::fs::write(data.join("packages/original/source"), b"original package").unwrap();
    std::fs::create_dir(data.join("operations")).unwrap();
    std::fs::write(data.join("operations/op.json"), b"original receipt").unwrap();
    std::fs::write(data.join("config.json"), b"original configuration").unwrap();
}

#[tokio::test]
async fn file_and_directory_resources_upgrade_restore_and_rescue_with_real_wallpaper_schema() {
    let fixture = tempfile::tempdir().unwrap();
    let data = std::fs::canonicalize(fixture.path()).unwrap();
    old(&data, 5).await.close().await;
    assets(&data);
    let layout = wallpaper(&WALLPAPER);
    let pool = open(&data, &layout).await.unwrap();
    let initial = list(&data, &layout).await.unwrap().remove(0);
    assert_eq!(initial.current_schema, 5);
    sqlx::query("UPDATE works SET title='After' WHERE work_key='fixture'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    std::fs::write(data.join("config.json"), b"later configuration").unwrap();
    std::fs::write(data.join("operations/op.json"), b"later receipt").unwrap();
    std::fs::remove_file(data.join("packages/original/source")).unwrap();
    std::fs::write(data.join("absent.json"), b"created later").unwrap();
    let rescue = restore(&data, &initial.id, &layout, true).await.unwrap();
    assert_eq!(inspect(&data, &layout).await.unwrap().current, 5);
    assert_eq!(
        std::fs::read(data.join("config.json")).unwrap(),
        b"original configuration"
    );
    assert_eq!(
        std::fs::read(data.join("operations/op.json")).unwrap(),
        b"original receipt"
    );
    assert_eq!(
        std::fs::read(data.join("packages/original/source")).unwrap(),
        b"original package"
    );
    assert!(data.join("packages/original/empty").is_dir());
    assert!(!data.join("absent.json").exists());
    let mut connection = reader(&data.join("wallpaper.db")).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT title FROM works WHERE work_key='fixture'")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        "Before"
    );
    connection.close().await.unwrap();
    restore(&data, &rescue, &layout, true).await.unwrap();
    assert_eq!(inspect(&data, &layout).await.unwrap().current, 6);
    assert_eq!(
        std::fs::read(data.join("config.json")).unwrap(),
        b"later configuration"
    );
    assert_eq!(
        std::fs::read(data.join("operations/op.json")).unwrap(),
        b"later receipt"
    );
    assert_eq!(
        std::fs::read(data.join("absent.json")).unwrap(),
        b"created later"
    );
    assert!(!data.join("packages/original/source").exists());
}

#[tokio::test]
async fn failed_migration_restores_configuration_and_resources() {
    let fixture = tempfile::tempdir().unwrap();
    let data = std::fs::canonicalize(fixture.path()).unwrap();
    old(&data, 4).await.close().await;
    assets(&data);
    let mut failing = sqlx::migrate!("../hertz-desktop/migrations/wallpaper");
    let mut migrations = failing.iter().cloned().collect::<Vec<_>>();
    migrations.push(sqlx::migrate::Migration::new(
        7,
        "fixture failure".into(),
        sqlx::migrate::MigrationType::Simple,
        "INSERT INTO nonexistent_table VALUES (1);".into(),
        false,
    ));
    failing.migrations = Cow::Owned(migrations);
    let error = open(&data, &wallpaper(&failing)).await.err().unwrap();
    assert!(
        error.to_string().contains("database_upgrade_failed"),
        "{error:#}"
    );
    assert_eq!(
        inspect(&data, &wallpaper(&WALLPAPER))
            .await
            .unwrap()
            .current,
        4
    );
    assert_eq!(
        std::fs::read(data.join("config.json")).unwrap(),
        b"original configuration"
    );
    assert_eq!(
        std::fs::read(data.join("packages/original/source")).unwrap(),
        b"original package"
    );
    assert!(!data.join(MARKER).exists());
}

#[tokio::test]
async fn resource_kinds_store_identity_and_overlaps_reject_without_replacing_current_data() {
    let fixture = tempfile::tempdir().unwrap();
    let data = std::fs::canonicalize(fixture.path()).unwrap();
    old(&data, 5).await.close().await;
    assets(&data);
    let layout = wallpaper(&WALLPAPER);
    open(&data, &layout).await.unwrap().close().await;
    let initial = list(&data, &layout).await.unwrap().remove(0);
    let before = std::fs::read(data.join("wallpaper.db")).unwrap();
    let mut wrong = wallpaper(&WALLPAPER);
    wrong.kind = "another-store";
    assert!(restore(&data, &initial.id, &wrong, true).await.is_err());
    wrong = wallpaper(&WALLPAPER);
    wrong.resources[1].kind = ResourceKind::Directory;
    assert!(restore(&data, &initial.id, &wrong, true).await.is_err());
    for path in [
        "wallpaper.db",
        "wallpaper.db-wal",
        "upgrade-backups",
        "config.commit.lock",
        "../outside",
        "packages/original",
        "packages",
    ] {
        let mut invalid = wallpaper(&WALLPAPER);
        invalid.resources.push(ResourceSpec::directory(path));
        assert!(open(&data, &invalid).await.is_err(), "{path}");
    }
    #[cfg(windows)]
    for path in [
        "UPGRADE-BACKUPS",
        "WALLPAPER.DB",
        "Wallpaper.Db-wAl",
        "CONFIG.COMMIT.LOCK",
        "PACKAGES/ORIGINAL",
        "PaCkAgEs",
        "packages.",
        "config.json ",
        "NUL",
        "CON.txt",
    ] {
        let mut invalid = wallpaper(&WALLPAPER);
        invalid.resources.push(ResourceSpec::directory(path));
        assert!(open(&data, &invalid).await.is_err(), "Windows alias {path}");
    }
    #[cfg(windows)]
    {
        let mut invalid = wallpaper(&WALLPAPER);
        invalid.database = "wällpaper.db";
        invalid
            .resources
            .push(ResourceSpec::file("WÄLLPAPER.db-wal"));
        assert!(
            open(&data, &invalid).await.is_err(),
            "Unicode database sidecar alias"
        );
    }
    let copy = backup_path(&data, &initial.id).unwrap().join("resources/1");
    std::fs::write(copy, b"changed configuration").unwrap();
    assert!(restore(&data, &initial.id, &layout, true).await.is_err());
    assert_eq!(before, std::fs::read(data.join("wallpaper.db")).unwrap());
    assert_eq!(
        std::fs::read(data.join("config.json")).unwrap(),
        b"original configuration"
    );
    assert!(!data.join(MARKER).exists());
}
