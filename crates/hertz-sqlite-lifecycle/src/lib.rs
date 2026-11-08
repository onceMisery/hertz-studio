// SPDX-License-Identifier: MIT
//! Offline schema lifecycle. The service's DataDir guard must cover these calls:
//! snapshot/migration/recovery happen before application writers or audio start.
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Connection, SqliteConnection, SqlitePool};

#[cfg(test)]
mod tests;

const ROOT: &str = "upgrade-backups";
const MARKER: &str = "database-upgrade-incomplete.json";
const MANIFEST: &str = "snapshot.json";

/// The caller owns its migration set and admission; this crate owns only the
/// SQLite/image/resource transaction mechanism. Distinct stores use distinct
/// data roots and `kind` identities.
pub struct Layout<'a> {
    pub database: &'static str,
    pub kind: &'static str,
    pub migrator: &'a sqlx::migrate::Migrator,
    pub resources: Vec<ResourceSpec>,
    pub max_connections: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    #[default]
    Directory,
    File,
}

impl ResourceKind {
    fn matches(self, metadata: &std::fs::Metadata) -> bool {
        match self {
            Self::Directory => metadata.is_dir(),
            Self::File => metadata.is_file(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ResourceSpec {
    pub path: String,
    pub kind: ResourceKind,
}

/// Caller-owned durable barrier, invoked after complete restore staging and
/// destination validation, immediately before displacing current data.
pub type BeforeRestore = fn(&Path) -> Result<()>;

impl ResourceSpec {
    pub fn directory(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            kind: ResourceKind::Directory,
        }
    }
    pub fn file(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            kind: ResourceKind::File,
        }
    }
}

impl Layout<'_> {
    fn validate(&self) -> Result<()> {
        ensure!(
            relative(self.database)?.components().count() == 1
                && self.database.ends_with(".db")
                && self.database != "database.db",
            "database_layout: expected one database filename"
        );
        ensure!(
            !self.kind.is_empty()
                && self.kind.len() <= 128
                && (1..=16).contains(&self.max_connections),
            "database_layout: invalid store identity or connection limit"
        );
        for (index, resource) in self.resources.iter().enumerate() {
            relative(&resource.path)?;
            let first = resource.path.split('/').next().unwrap();
            let comparison = if cfg!(windows) {
                first.to_ascii_lowercase()
            } else {
                first.to_owned()
            };
            ensure!(
                !same_component(first, ROOT)
                    && !same_component(first, MARKER)
                    && !comparison.ends_with(".lock")
                    && !same_component(first, self.database)
                    && !["-wal", "-shm", "-journal"]
                        .iter()
                        .any(|suffix| same_component(first, &format!("{}{suffix}", self.database))),
                "database_layout: resource overlaps database, locks or recovery storage"
            );
            for previous in &self.resources[..index] {
                let a: Vec<_> = previous.path.split('/').collect();
                let b: Vec<_> = resource.path.split('/').collect();
                ensure!(
                    !a.iter().zip(&b).all(|(a, b)| same_component(a, b)),
                    "database_layout: overlapping resources"
                );
            }
        }
        Ok(())
    }
}

fn same_component(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
        let a: Vec<u16> = a.encode_utf16().collect();
        let b: Vec<u16> = b.encode_utf16().collect();
        // Use Windows' ordinal case comparison for filesystem identities;
        // Unicode lowercasing does not model NTFS component aliases.
        unsafe {
            CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1)
                == CSTR_EQUAL
        }
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Applied {
    pub version: i64,
    pub checksum: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SchemaStatus {
    pub current: i64,
    pub supported: i64,
    pub fresh: bool,
    pub pending: bool,
    pub applied: Vec<Applied>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct FileIdentity {
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    original: String,
    existed: bool,
    #[serde(default)]
    kind: ResourceKind,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Snapshot {
    schema_version: u32,
    kind: String,
    id: String,
    source_dir: PathBuf,
    reason: String,
    created_at: i64,
    applied: Vec<Applied>,
    resources: Vec<Resource>,
    files: BTreeMap<String, FileIdentity>,
    directories: BTreeSet<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Journal {
    schema_version: u32,
    backup: String,
    target: i64,
    purpose: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary {
    pub id: String,
    pub current_schema: i64,
    pub created_at: i64,
    pub reason: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_error: Option<String>,
}

pub fn current_schema(migrator: &sqlx::migrate::Migrator) -> i64 {
    migrator
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn ordinary(path: &Path) -> Result<std::fs::Metadata> {
    let metadata = path_metadata(path)?;
    ordinary_metadata(&metadata)?;
    Ok(metadata)
}

fn ordinary_metadata(metadata: &std::fs::Metadata) -> Result<()> {
    ensure!(
        !metadata.file_type().is_symlink(),
        "database_backup_path: links are not supported"
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            metadata.file_attributes() & 0x400 == 0,
            "database_backup_path: reparse points are not supported"
        );
    }
    Ok(())
}

fn path_metadata(path: &Path) -> std::io::Result<std::fs::Metadata> {
    // Windows can report ACCESS_DENIED for a SQLite sidecar that is delete-
    // pending during another current reader's close. Retry only that bounded
    // filesystem transition; persistent ACL errors and every link still fail.
    for attempt in 0..16 {
        match std::fs::symlink_metadata(path) {
            Err(error) if cfg!(windows) && error.raw_os_error() == Some(5) && attempt < 15 => {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            result => return result,
        }
    }
    unreachable!()
}

fn relative(value: &str) -> Result<PathBuf> {
    ensure!(
        !value.is_empty() && !value.contains(['\\', ':']),
        "database_backup_path: invalid relative path"
    );
    #[cfg(windows)]
    for part in value.split('/') {
        ensure!(
            !part.ends_with(['.', ' ']),
            "database_backup_path: Windows path alias is not supported"
        );
        let stem = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit()
                && stem.as_bytes()[3] != b'0');
        ensure!(
            !reserved,
            "database_backup_path: reserved Windows device path"
        );
    }
    let path = PathBuf::from(value);
    ensure!(
        path.components()
            .all(|part| matches!(part, Component::Normal(_))),
        "database_backup_path: invalid relative path"
    );
    ensure!(
        value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".."),
        "database_backup_path: invalid relative path"
    );
    Ok(path)
}

fn profile_path(data: &Path, value: &str) -> Result<PathBuf> {
    ensure!(
        ordinary(data)?.is_dir(),
        "database_backup_path: invalid base directory"
    );
    let path = relative(value)?;
    let mut cursor = data.to_owned();
    for part in path.components() {
        cursor.push(part);
        match path_metadata(&cursor) {
            Ok(metadata) => {
                ordinary_metadata(&metadata)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(cursor)
}

fn valid_id(id: &str) -> bool {
    id.strip_prefix("upgrade-").is_some_and(|tail| {
        tail.len() == 32
            && tail
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn backup_path(data: &Path, id: &str) -> Result<PathBuf> {
    ensure!(valid_id(id), "database_backup_id: invalid snapshot ID");
    let root = data.join(ROOT);
    ensure!(
        ordinary(&root)?.is_dir(),
        "database_backup_path: expected backup directory"
    );
    let path = root.join(id);
    ensure!(
        ordinary(&path)?.is_dir(),
        "database_backup_path: expected snapshot directory"
    );
    Ok(path)
}

fn hash_file(path: &Path) -> Result<FileIdentity> {
    ensure!(
        ordinary(path)?.is_file(),
        "database_backup_path: expected regular file"
    );
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        digest.update(&buffer[..count]);
    }
    Ok(FileIdentity {
        bytes,
        sha256: hex(&digest.finalize()),
    })
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path, maximum: u64) -> Result<T> {
    ensure!(
        ordinary(path)?.is_file() && std::fs::metadata(path)?.len() <= maximum,
        "database_backup_manifest: invalid or oversized record"
    );
    Ok(serde_json::from_reader(std::fs::File::open(path)?)?)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    serde_json::to_writer(&mut file, value)?;
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

fn private_directory(path: &Path) -> Result<()> {
    if path.try_exists()? {
        ensure!(
            ordinary(path)?.is_dir(),
            "database_backup_path: invalid directory"
        );
    }
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    private_windows::restrict(path)?;
    Ok(())
}

async fn reader(path: &Path) -> Result<SqliteConnection> {
    ensure!(
        ordinary(path)?.is_file(),
        "database_path: expected regular database"
    );
    check_sidecars(path)?;
    Ok(SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .busy_timeout(std::time::Duration::from_secs(5)),
    )
    .await?)
}

fn check_sidecars(path: &Path) -> Result<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        match path_metadata(&sidecar) {
            Ok(metadata) => {
                ordinary_metadata(&metadata)?;
                ensure!(metadata.is_file(), "database_path: invalid SQLite sidecar");
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

async fn inspect_with(
    data: &Path,
    layout: &Layout<'_>,
    check_marker: bool,
) -> Result<SchemaStatus> {
    layout.validate()?;
    let migrator = layout.migrator;
    if check_marker && marker_present(data)? {
        bail!("database_recovery_required: 数据库升级未完成，请正常退出服务后执行 --recover-upgrade --data-dir <资料目录>");
    }
    let supported = migrator
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap_or(0);
    let path = data.join(layout.database);
    check_sidecars(&path)?;
    let missing = match path_metadata(&path) {
        Ok(metadata) => {
            ordinary_metadata(&metadata)?;
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };
    if missing {
        return Ok(SchemaStatus {
            current: 0,
            supported,
            fresh: true,
            pending: true,
            applied: vec![],
        });
    }
    let mut connection = reader(&path).await?;
    let result = async {
        let check: String = sqlx::query_scalar("PRAGMA quick_check").fetch_one(&mut connection).await?;
        ensure!(check == "ok", "database_integrity_failed: 数据库完整性检查失败，原文件保持不变");
        let ledger: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'").fetch_one(&mut connection).await?;
        if ledger == 0 {
            let tables: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetch_one(&mut connection).await?;
            ensure!(tables == 0, "database_unmanaged: 已有数据库没有可验证迁移记录，拒绝自动覆盖");
            return Ok(SchemaStatus { current: 0, supported, fresh: true, pending: true, applied: vec![] });
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations").fetch_one(&mut connection).await?;
        ensure!(count <= 4096, "database_migration_mismatch: invalid ledger size");
        let rows: Vec<(i64, bool, Vec<u8>)> = sqlx::query_as("SELECT version,success,checksum FROM _sqlx_migrations ORDER BY version").fetch_all(&mut connection).await?;
        let current = rows.last().map(|row| row.0).unwrap_or(0);
        ensure!(current <= supported, "database_version_too_new: 数据库版本 {current} 高于此程序支持的 {supported}，拒绝覆盖");
        let expected: Vec<_> = migrator.iter().collect();
        ensure!(rows.len() <= expected.len(), "database_migration_mismatch: invalid migration ledger");
        for (index, (version, success, checksum)) in rows.iter().enumerate() {
            ensure!(*success, "database_migration_incomplete: 迁移记录未完成，拒绝自动写入");
            ensure!(*version == expected[index].version && checksum.as_slice() == expected[index].checksum.as_ref(), "database_migration_mismatch: 迁移 {version} 与此程序不一致，拒绝覆盖");
        }
        Ok(SchemaStatus { current, supported, fresh: false, pending: rows.len() < expected.len(), applied: rows.into_iter().map(|(version, _, checksum)| Applied { version, checksum: hex(&checksum) }).collect() })
    }.await;
    connection.close().await?;
    result
}

fn marker_present(data: &Path) -> Result<bool> {
    match path_metadata(&data.join(MARKER)) {
        Ok(metadata) => {
            ordinary_metadata(&metadata)?;
            ensure!(
                metadata.is_file(),
                "database_recovery_path: expected regular marker"
            );
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// Read-only compatibility gate, including committed WAL. No database pragmas
/// that change journal mode and no configuration/credential migration occurs.
pub async fn inspect(data: &Path, layout: &Layout<'_>) -> Result<SchemaStatus> {
    inspect_with(data, layout, true).await
}

fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    ensure!(
        ordinary(source)?.is_dir(),
        "database_backup_path: expected resource directory"
    );
    std::fs::create_dir(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let metadata = ordinary(&entry.path())?;
        let target = destination.join(entry.file_name());
        if metadata.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            ensure!(
                metadata.is_file(),
                "database_backup_path: unsupported resource"
            );
            std::fs::copy(entry.path(), &target)?;
            std::fs::OpenOptions::new()
                .write(true)
                .open(target)?
                .sync_all()?;
        }
    }
    Ok(())
}

fn copy_resource(source: &Path, destination: &Path, kind: ResourceKind) -> Result<()> {
    ensure!(
        kind.matches(&ordinary(source)?),
        "database_backup_path: resource kind mismatch"
    );
    match kind {
        ResourceKind::Directory => copy_tree(source, destination),
        ResourceKind::File => {
            std::fs::copy(source, destination)?;
            std::fs::OpenOptions::new()
                .write(true)
                .open(destination)?
                .sync_all()?;
            Ok(())
        }
    }
}

fn inventory(
    base: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, FileIdentity>,
    directories: &mut BTreeSet<String>,
) -> Result<()> {
    ensure!(
        ordinary(directory)?.is_dir(),
        "database_backup_path: expected inventory directory"
    );
    if directory != base {
        directories.insert(
            directory
                .strip_prefix(base)?
                .to_string_lossy()
                .replace('\\', "/"),
        );
    }
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if ordinary(&path)?.is_dir() {
            inventory(base, &path, files, directories)?;
        } else {
            files.insert(
                path.strip_prefix(base)?
                    .to_string_lossy()
                    .replace('\\', "/"),
                hash_file(&path)?,
            );
        }
    }
    Ok(())
}

async fn make_snapshot(data: &Path, reason: &str, layout: &Layout<'_>) -> Result<Snapshot> {
    layout.validate()?;
    let roots = &layout.resources;
    let status = inspect_with(data, layout, false).await?;
    ensure!(
        !status.fresh,
        "database_backup_missing: there is no existing managed database to snapshot"
    );
    let root = data.join(ROOT);
    private_directory(&root)?;
    let id = format!("upgrade-{}", uuid::Uuid::new_v4().simple());
    let temporary = root.join(format!(".{id}.pending"));
    private_directory(&temporary)?;
    let mut connection = reader(&data.join(layout.database)).await?;
    let result = sqlx::query("VACUUM INTO ?")
        .bind(temporary.join("database.db").to_string_lossy().as_ref())
        .execute(&mut connection)
        .await;
    connection.close().await?;
    result.context("database_backup_failed: 无法建立 SQLite 一致性快照，未执行迁移")?;
    let source = data.to_owned();
    let temporary_copy = temporary.clone();
    let root_names = roots.clone();
    let (resources, files, directories) = tokio::task::spawn_blocking(move || -> Result<_> {
        std::fs::create_dir(temporary_copy.join("resources"))?;
        let mut resources = vec![];
        for (index, spec) in root_names.into_iter().enumerate() {
            let name = spec.path;
            let path = profile_path(&source, &name)?;
            let existed = path.try_exists()?;
            if existed {
                copy_resource(
                    &path,
                    &temporary_copy.join("resources").join(index.to_string()),
                    spec.kind,
                )?;
            }
            resources.push(Resource {
                original: name,
                existed,
                kind: spec.kind,
            });
        }
        let mut files = BTreeMap::new();
        let mut directories = BTreeSet::new();
        inventory(
            &temporary_copy,
            &temporary_copy,
            &mut files,
            &mut directories,
        )?;
        Ok((resources, files, directories))
    })
    .await??;
    let snapshot = Snapshot {
        schema_version: 1,
        kind: layout.kind.into(),
        id,
        source_dir: data.to_owned(),
        reason: reason.into(),
        created_at: now_ms(),
        applied: status.applied,
        resources,
        files,
        directories,
    };
    write_json(&temporary.join(MANIFEST), &snapshot)?;
    std::fs::rename(&temporary, root.join(&snapshot.id))?;
    validate_snapshot(data, &snapshot.id, layout).await?;
    tracing::info!(backup_id=%snapshot.id, schema=status.current, "database upgrade recovery point ready");
    Ok(snapshot)
}

async fn validate_snapshot(data: &Path, id: &str, layout: &Layout<'_>) -> Result<Snapshot> {
    layout.validate()?;
    let roots = &layout.resources;
    let migrator = layout.migrator;
    let directory = backup_path(data, id)?;
    let entries: BTreeSet<_> = std::fs::read_dir(&directory)?
        .map(|entry| -> Result<_> {
            let entry = entry?;
            ordinary(&entry.path())?;
            Ok(entry.file_name().to_string_lossy().into_owned())
        })
        .collect::<Result<_>>()?;
    ensure!(
        entries == BTreeSet::from(["database.db".into(), "resources".into(), MANIFEST.into()]),
        "database_backup_manifest: unexpected snapshot file or SQLite sidecar"
    );
    let snapshot: Snapshot = read_json(&directory.join(MANIFEST), 16 * 1024 * 1024)?;
    ensure!(
        snapshot.schema_version == 1
            && snapshot.kind == layout.kind
            && snapshot.id == id
            && snapshot.source_dir == data,
        "database_backup_profile: 快照不属于此资料目录或协议不支持"
    );
    ensure!(
        snapshot.resources.len() == roots.len()
            && snapshot
                .resources
                .iter()
                .zip(roots)
                .all(|(resource, expected)| resource.original == expected.path
                    && resource.kind == expected.kind),
        "database_backup_roots: 快照资源范围不匹配"
    );
    let expected: Vec<_> = migrator.iter().collect();
    ensure!(
        snapshot.applied.len() <= expected.len()
            && snapshot
                .applied
                .iter()
                .zip(&expected)
                .all(|(applied, expected)| applied.version == expected.version
                    && applied.checksum == hex(&expected.checksum)),
        "database_backup_version: 此程序不支持该快照的迁移版本"
    );
    ensure!(
        snapshot.files.contains_key("database.db"),
        "database_backup_manifest: missing database image"
    );
    let directory_copy = directory.clone();
    let expected_files = snapshot.files.clone();
    let expected_directories = snapshot.directories.clone();
    let expected_resources = snapshot.resources.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let resources = profile_path(&directory_copy, "resources")?;
        ensure!(
            ordinary(&resources)?.is_dir(),
            "database_backup_path: missing resources directory"
        );
        let expected_roots: BTreeSet<_> = expected_resources
            .iter()
            .enumerate()
            .filter(|(_, resource)| resource.existed)
            .map(|(index, _)| index.to_string())
            .collect();
        let actual_roots: BTreeSet<_> = std::fs::read_dir(&resources)?
            .map(|entry| -> Result<_> {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let index: usize = name
                    .parse()
                    .context("database_backup_manifest: invalid resource index")?;
                ensure!(
                    index.to_string() == name
                        && expected_resources
                            .get(index)
                            .is_some_and(|resource| resource.existed),
                    "database_backup_manifest: invalid resource root"
                );
                let metadata = ordinary(&entry.path())?;
                ensure!(
                    expected_resources[index].kind.matches(&metadata),
                    "database_backup_path: resource kind mismatch"
                );
                Ok(name)
            })
            .collect::<Result<_>>()?;
        ensure!(
            actual_roots == expected_roots,
            "database_backup_manifest: resource existence differs from manifest"
        );
        for (name, expected) in &expected_files {
            ensure!(
                name == "database.db" || name.starts_with("resources/"),
                "database_backup_path: unexpected snapshot file"
            );
            let actual = hash_file(&profile_path(&directory_copy, name)?)?;
            ensure!(
                actual.bytes == expected.bytes && actual.sha256 == expected.sha256,
                "database_backup_hash: 快照文件校验失败：{name}"
            );
        }
        let mut actual_files = BTreeMap::new();
        let mut actual_directories = BTreeSet::new();
        inventory(
            &directory_copy,
            &resources,
            &mut actual_files,
            &mut actual_directories,
        )?;
        actual_files.insert(
            "database.db".into(),
            hash_file(&directory_copy.join("database.db"))?,
        );
        ensure!(
            actual_files == expected_files && actual_directories == expected_directories,
            "database_backup_manifest: snapshot resources do not match manifest"
        );
        Ok(())
    })
    .await??;
    // Inspect the image under its real file name, without creating a parallel
    // running service. Ledger and integrity must match the immutable manifest.
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(directory.join("database.db"))
            .read_only(true)
            .immutable(true)
            .create_if_missing(false),
    )
    .await?;
    let validation = async {
        let check: String = sqlx::query_scalar("PRAGMA quick_check")
            .fetch_one(&mut connection)
            .await?;
        ensure!(
            check == "ok",
            "database_backup_integrity: invalid SQLite image"
        );
        let rows: Vec<(i64, bool, Vec<u8>)> = sqlx::query_as(
            "SELECT version,success,checksum FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&mut connection)
        .await?;
        ensure!(
            rows.len() == snapshot.applied.len()
                && rows.iter().zip(&snapshot.applied).all(
                    |((version, success, checksum), applied)| *success
                        && *version == applied.version
                        && hex(checksum) == applied.checksum
                ),
            "database_backup_version: image ledger differs from manifest"
        );
        Ok(())
    }
    .await;
    connection.close().await?;
    validation?;
    Ok(snapshot)
}

fn publish(data: &Path, journal: &Journal) -> Result<()> {
    ensure!(
        !marker_present(data)?,
        "database_recovery_required: an unfinished operation already exists"
    );
    let temporary = data
        .join(ROOT)
        .join(format!(".journal-{}", uuid::Uuid::new_v4().simple()));
    write_json(&temporary, journal)?;
    std::fs::rename(temporary, data.join(MARKER))?;
    Ok(())
}

async fn apply_snapshot(
    data: &Path,
    id: &str,
    layout: &Layout<'_>,
    before_replace: Option<BeforeRestore>,
) -> Result<()> {
    layout.validate()?;
    let snapshot = validate_snapshot(data, id, layout).await?;
    let source = backup_path(data, id)?;
    let data_copy = data.to_owned();
    let staged_snapshot = snapshot.clone();
    let database = layout.database;
    tokio::task::spawn_blocking(move || -> Result<()> {
        let snapshot = staged_snapshot;
        let work = data_copy
            .join(ROOT)
            .join(format!(".restore-{}", uuid::Uuid::new_v4().simple()));
        private_directory(&work)?;
        let image = work.join("database.db");
        std::fs::copy(source.join("database.db"), &image)?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&image)?
            .sync_all()?;
        ensure!(
            hash_file(&image)?.sha256 == snapshot.files["database.db"].sha256,
            "database_backup_hash: copied image mismatch"
        );
        std::fs::create_dir(work.join("resources"))?;
        for (index, resource) in snapshot.resources.iter().enumerate() {
            if resource.existed {
                copy_resource(
                    &source.join("resources").join(index.to_string()),
                    &work.join("resources").join(index.to_string()),
                    resource.kind,
                )?;
            }
        }
        let mut staged_files = BTreeMap::new();
        let mut staged_directories = BTreeSet::new();
        inventory(&work, &work, &mut staged_files, &mut staged_directories)?;
        ensure!(
            staged_files == snapshot.files && staged_directories == snapshot.directories,
            "database_backup_hash: staged database/resources differ from snapshot"
        );
        // Validate every destination before displacing the first current file.
        for resource in &snapshot.resources {
            let destination = profile_path(&data_copy, &resource.original)?;
            ensure!(
                !destination.try_exists()? || resource.kind.matches(&ordinary(&destination)?),
                "database_recovery_path: invalid resource destination"
            );
        }
        if let Some(before_replace) = before_replace {
            before_replace(&data_copy)?;
        }
        // Preserve the displaced state, including WAL, rather than deleting it.
        // The complete marker remains throughout every move, including retries.
        for suffix in ["-wal", "-shm", "-journal", ""] {
            let name = format!("{database}{suffix}");
            let path = data_copy.join(&name);
            if path.try_exists()? {
                ensure!(
                    ordinary(&path)?.is_file(),
                    "database_recovery_path: invalid database file"
                );
                std::fs::rename(path, work.join(format!("before-{name}")))?;
            }
        }
        for (index, resource) in snapshot.resources.iter().enumerate() {
            let destination = profile_path(&data_copy, &resource.original)?;
            if destination.try_exists()? {
                std::fs::rename(&destination, work.join(format!("before-resource-{index}")))?;
            }
            if resource.existed {
                std::fs::create_dir_all(destination.parent().context("resource parent missing")?)?;
                std::fs::rename(work.join("resources").join(index.to_string()), destination)?;
            }
        }
        std::fs::rename(image, data_copy.join(database))?;
        Ok(())
    })
    .await??;
    let restored = inspect_with(data, layout, false).await?;
    ensure!(
        restored.applied == snapshot.applied,
        "database_recovery_failed: restored ledger mismatch"
    );
    // Check the complete restored resource tree before clearing the crash gate.
    for (index, resource) in snapshot.resources.iter().enumerate() {
        let destination = profile_path(data, &resource.original)?;
        ensure!(
            destination.try_exists()? == resource.existed,
            "database_recovery_failed: restored resource existence mismatch"
        );
        if resource.existed {
            if resource.kind == ResourceKind::File {
                ensure!(
                    hash_file(&destination)? == snapshot.files[&format!("resources/{index}")],
                    "database_recovery_failed: restored resource file differs from snapshot"
                );
                continue;
            }
            let mut files = BTreeMap::new();
            let mut directories = BTreeSet::new();
            inventory(&destination, &destination, &mut files, &mut directories)?;
            let prefix = format!("resources/{index}/");
            let expected_files = snapshot
                .files
                .iter()
                .filter_map(|(name, identity)| {
                    name.strip_prefix(&prefix)
                        .map(|name| (name.to_owned(), identity.clone()))
                })
                .collect();
            let expected_directories = snapshot
                .directories
                .iter()
                .filter_map(|name| name.strip_prefix(&prefix).map(str::to_owned))
                .collect();
            ensure!(
                files == expected_files && directories == expected_directories,
                "database_recovery_failed: restored resources differ from snapshot"
            );
        }
    }
    std::fs::remove_file(data.join(MARKER))?;
    Ok(())
}

pub async fn recover(data: &Path, layout: &Layout<'_>) -> Result<String> {
    recover_with_hook(data, layout, None).await
}

pub async fn recover_with_hook(
    data: &Path,
    layout: &Layout<'_>,
    before_replace: Option<BeforeRestore>,
) -> Result<String> {
    layout.validate()?;
    let data = std::fs::canonicalize(data)?;
    let journal: Journal = read_json(&data.join(MARKER), 16 * 1024)?;
    ensure!(
        journal.schema_version == 1 && matches!(journal.purpose.as_str(), "migration" | "restore"),
        "database_recovery_manifest: invalid operation marker"
    );
    apply_snapshot(&data, &journal.backup, layout, before_replace).await?;
    Ok(journal.backup)
}

/// Historical rollback is explicit and preserves the current managed state in
/// another verified recovery point before replacing any database/resource.
pub async fn restore(
    data: &Path,
    id: &str,
    layout: &Layout<'_>,
    accept_data_loss: bool,
) -> Result<String> {
    restore_with_hook(data, id, layout, accept_data_loss, None).await
}

pub async fn restore_with_hook(
    data: &Path,
    id: &str,
    layout: &Layout<'_>,
    accept_data_loss: bool,
    before_replace: Option<BeforeRestore>,
) -> Result<String> {
    layout.validate()?;
    ensure!(
        accept_data_loss,
        "database_restore_confirmation: 历史恢复需要 --accept-data-loss；之后的逻辑修改将丢失"
    );
    let data = std::fs::canonicalize(data)?;
    ensure!(
        !marker_present(&data)?,
        "database_recovery_required: 先执行 --recover-upgrade 完成未结束的操作"
    );
    let snapshot = validate_snapshot(&data, id, layout).await?;
    let rescue = make_snapshot(&data, "before-restore", layout).await?;
    publish(
        &data,
        &Journal {
            schema_version: 1,
            backup: snapshot.id.clone(),
            target: snapshot
                .applied
                .last()
                .map(|entry| entry.version)
                .unwrap_or(0),
            purpose: "restore".into(),
        },
    )?;
    apply_snapshot(&data, id, layout, before_replace).await.context("database_recovery_required: 恢复未完成，原恢复点与救援状态已保留，请执行 --recover-upgrade")?;
    Ok(rescue.id)
}

pub async fn list(data: &Path, layout: &Layout<'_>) -> Result<Vec<SnapshotSummary>> {
    layout.validate()?;
    let data = std::fs::canonicalize(data)?;
    let root = data.join(ROOT);
    if !root.try_exists()? {
        return Ok(vec![]);
    }
    ensure!(
        ordinary(&root)?.is_dir(),
        "database_backup_path: invalid backup root"
    );
    let mut result = vec![];
    for entry in std::fs::read_dir(root)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if !valid_id(&name) {
            continue;
        }
        let snapshot = match validate_snapshot(&data, &name, layout).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                result.push(SnapshotSummary {
                    id: name,
                    current_schema: 0,
                    created_at: 0,
                    reason: "unverified".into(),
                    bytes: 0,
                    verification_error: Some(error.to_string()),
                });
                continue;
            }
        };
        result.push(SnapshotSummary {
            id: snapshot.id,
            current_schema: snapshot
                .applied
                .last()
                .map(|entry| entry.version)
                .unwrap_or(0),
            created_at: snapshot.created_at,
            reason: snapshot.reason,
            bytes: snapshot.files.values().map(|file| file.bytes).sum(),
            verification_error: None,
        });
    }
    result.sort_by_key(|snapshot| snapshot.created_at);
    Ok(result)
}

/// Create a complete offline recovery point without migrating. The same caller
/// admission requirement applies as to open/restore/recover.
pub async fn create_snapshot(
    data: &Path,
    reason: &str,
    layout: &Layout<'_>,
) -> Result<SnapshotSummary> {
    let data = std::fs::canonicalize(data)?;
    inspect_with(&data, layout, true).await?;
    let snapshot = make_snapshot(&data, reason, layout).await?;
    Ok(SnapshotSummary {
        id: snapshot.id,
        current_schema: snapshot
            .applied
            .last()
            .map(|entry| entry.version)
            .unwrap_or(0),
        created_at: snapshot.created_at,
        reason: snapshot.reason,
        bytes: snapshot.files.values().map(|file| file.bytes).sum(),
        verification_error: None,
    })
}

pub async fn open(data: &Path, layout: &Layout<'_>) -> Result<SqlitePool> {
    open_with_options(data, layout, SqlitePoolOptions::new(), None).await
}

/// Caller callbacks may retain its admission for the entire pool/connection
/// lifetime. The store's connection limit and connect pragmas remain enforced.
pub async fn open_with_options(
    data: &Path,
    layout: &Layout<'_>,
    pool_options: SqlitePoolOptions,
    before_replace: Option<BeforeRestore>,
) -> Result<SqlitePool> {
    layout.validate()?;
    let migrator = layout.migrator;
    std::fs::create_dir_all(data)?;
    let data = std::fs::canonicalize(data)?;
    let status = inspect_with(&data, layout, true).await?;
    let snapshot = if status.pending && !status.fresh {
        Some(make_snapshot(&data, "upgrade", layout).await?)
    } else {
        None
    };
    if let Some(snapshot) = &snapshot {
        publish(
            &data,
            &Journal {
                schema_version: 1,
                backup: snapshot.id.clone(),
                target: status.supported,
                purpose: "migration".into(),
            },
        )?;
    }
    let operation = async {
        let options = SqliteConnectOptions::new()
            .filename(data.join(layout.database))
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(5));
        let pool = pool_options
            .max_connections(layout.max_connections)
            .connect_with(options)
            .await?;
        if let Err(error) = migrator.run(&pool).await {
            pool.close().await;
            return Err(error.into());
        }
        Ok::<_, anyhow::Error>(pool)
    }
    .await;
    match operation {
        Ok(pool) => {
            if snapshot.is_some() {
                if let Err(error) = std::fs::remove_file(data.join(MARKER)) {
                    pool.close().await;
                    return Err(error.into());
                }
            }
            Ok(pool)
        }
        Err(error) => {
            if let Some(snapshot) = snapshot {
                apply_snapshot(&data, &snapshot.id, layout, before_replace).await.context("database_recovery_required: 迁移失败且恢复受阻，保留恢复点，请执行 --recover-upgrade")?;
                bail!(
                    "database_upgrade_failed: 升级失败，已恢复升级前资料；恢复点 {}：{error}",
                    snapshot.id
                );
            }
            Err(error)
        }
    }
}

#[cfg(windows)]
mod private_windows {
    use super::*;
    pub(super) fn restrict(path: &Path) -> Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
            SE_FILE_OBJECT,
        };
        use windows_sys::Win32::Security::{
            GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION,
        };
        let sddl: Vec<u16> = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)\0"
            .encode_utf16()
            .collect();
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        ensure!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            } != 0,
            "database_backup_permissions: {}",
            std::io::Error::last_os_error()
        );
        let result = unsafe {
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl = std::ptr::null_mut();
            let valid =
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted);
            let result = if valid != 0 && present != 0 {
                SetNamedSecurityInfoW(
                    name.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    dacl,
                    std::ptr::null_mut(),
                )
            } else {
                1338
            };
            LocalFree(descriptor);
            result
        };
        ensure!(
            result == 0,
            "database_backup_permissions: Windows error {result}"
        );
        Ok(())
    }
}
