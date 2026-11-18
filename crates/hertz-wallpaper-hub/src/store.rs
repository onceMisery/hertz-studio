// SPDX-License-Identifier: MIT
use crate::{
    auth::{Auth, Identity},
    config::{canonical_id, Config},
    error::{HubError, Result},
    limits::Limits,
    model::{digest, encode, now, Actor, Candidate, CreateWork, Upload, Work, CANDIDATE_SELECT},
};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Row, SqlitePool,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;

const APPLICATION_ID: i64 = 0x48574842;
pub struct ServerLease {
    _database: fslock::LockFile,
    _content: fslock::LockFile,
}

#[derive(Clone)]
pub struct Hub {
    pub(crate) config: Arc<Config>,
    pub(crate) pool: SqlitePool,
    pub(crate) auth: Arc<Auth>,
    pub(crate) limits: Arc<Limits>,
    pub(crate) validator: Arc<Semaphore>,
    pub(crate) operations: Arc<Semaphore>,
    pub(crate) requests: Arc<Semaphore>,
    pub(crate) downloads: Arc<Semaphore>,
    pub(crate) maintenance: Arc<tokio::sync::Mutex<crate::maintenance::Sweep>>,
    pub(crate) authorization:
        Arc<hertz_wallpaper::release::authorization::VerifiedAuthorizationChain>,
    pub(crate) signer: hertz_wallpaper_signer::client::HubClient,
    // This original publication lock also retains the bounded recovery scan cursor.
    pub(crate) publication: Arc<tokio::sync::Mutex<Option<String>>>,
}

impl Hub {
    /// The lease must outlive the server and its owned upload/validation workers.
    pub async fn open(mut config: Config) -> Result<(Self, ServerLease)> {
        config.validate()?;
        if hertz_wallpaper_signer::platform::current_identity()
            .map_err(|_| HubError::unavailable())?
            == config.signer_service_identity
        {
            return Err(HubError::invalid("Hub与Signer必须使用独立OS服务身份"));
        }
        let parent = config
            .database_path
            .parent()
            .ok_or_else(|| HubError::invalid("数据库父目录无效"))?;
        tokio::fs::create_dir_all(parent).await?;
        tokio::fs::create_dir_all(&config.content_directory).await?;
        let content = tokio::fs::canonicalize(&config.content_directory).await?;
        let database_parent = tokio::fs::canonicalize(parent).await?;
        // Bind the DB lease to its resolved identity, including an existing
        // symlink target; aliases must not create two independently locked Hubs.
        config.database_path = if tokio::fs::try_exists(&config.database_path).await? {
            tokio::fs::canonicalize(&config.database_path).await?
        } else {
            database_parent.join(
                config
                    .database_path
                    .file_name()
                    .ok_or_else(|| HubError::invalid("数据库文件名无效"))?,
            )
        };
        if config.database_path.starts_with(&content) {
            return Err(HubError::invalid("数据库不能位于内容目录内"));
        }
        let mut database_lock =
            fslock::LockFile::open(&config.database_path.with_extension("db.lock"))?;
        if !database_lock.try_lock()? {
            return Err(HubError::conflict("Hub数据库已由另一实例使用"));
        }
        let mut content_lock = fslock::LockFile::open(&content.join(".hub.lock"))?;
        if !content_lock.try_lock()? {
            return Err(HubError::conflict("内容目录已由另一实例使用"));
        }
        for directory in ["staging", "quarantine"] {
            let path = content.join(directory);
            tokio::fs::create_dir_all(&path).await?;
            if tokio::fs::canonicalize(&path).await? != path {
                return Err(HubError::invalid("隔离子目录不能重定向到其它路径"));
            }
        }
        // Inspect existing stores read-only before enabling WAL or migrations.
        // A mistaken deployment path must not change a music/desktop database.
        if tokio::fs::try_exists(&config.database_path).await? {
            let inspect = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    SqliteConnectOptions::new()
                        .filename(&config.database_path)
                        .read_only(true),
                )
                .await?;
            let application: i64 = sqlx::query_scalar("PRAGMA application_id")
                .fetch_one(&inspect)
                .await?;
            let tables: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetch_one(&inspect).await?;
            inspect.close().await;
            if application != APPLICATION_ID && (application != 0 || tables != 0) {
                return Err(HubError::invalid("此数据库不是独立社区Hub数据库"));
            }
        }
        let options = SqliteConnectOptions::new()
            .filename(&config.database_path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(options)
            .await?;
        sqlx::query(&format!("PRAGMA application_id={APPLICATION_ID}"))
            .execute(&pool)
            .await?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|_| HubError::unavailable())?;
        // Repointing an existing store to another source/issuer must not grant
        // ownership of its authors or relabel existing candidates.
        sqlx::query("INSERT INTO hub_identity(singleton,hub_id,public_origin,issuer,client_id,api_audience) VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO NOTHING")
            .bind(&config.hub_id).bind(config.public_origin.trim_end_matches('/')).bind(&config.issuer)
            .bind(&config.desktop_client_id).bind(&config.api_audience).execute(&pool).await?;
        let same: i64 = sqlx::query_scalar("SELECT count(*) FROM hub_identity WHERE singleton=1 AND hub_id=? AND public_origin=? AND issuer=? AND client_id=? AND api_audience=?")
            .bind(&config.hub_id).bind(config.public_origin.trim_end_matches('/')).bind(&config.issuer)
            .bind(&config.desktop_client_id).bind(&config.api_audience).fetch_one(&pool).await?;
        if same != 1 {
            pool.close().await;
            return Err(HubError::conflict("已有Hub数据库的来源与身份配置不匹配"));
        }
        config.content_directory = content;
        let authorization = Arc::new(crate::authority::load(&config, &pool).await?);
        let signer = hertz_wallpaper_signer::client::HubClient::new(
            config.signer_endpoint.clone(),
            config.signer_service_identity.clone(),
        )
        .map_err(|_| HubError::invalid("Signer客户端配置无效"))?;
        let config = Arc::new(config);
        let hub = Self {
            pool,
            auth: Arc::new(Auth::new(config.clone())),
            config,
            limits: Arc::new(Limits::new()),
            validator: Arc::new(Semaphore::new(1)),
            operations: Arc::new(Semaphore::new(4)),
            requests: Arc::new(Semaphore::new(64)),
            downloads: Arc::new(Semaphore::new(32)),
            maintenance: Arc::new(tokio::sync::Mutex::new(crate::maintenance::Sweep::new())),
            authorization,
            signer,
            publication: Arc::new(tokio::sync::Mutex::new(None)),
        };
        // Explicit deployment subjects seed DB roles. Token role/email never do.
        for administrator in &hub.config.administrators {
            let mut tx = hub.pool.begin().await?;
            let time = now();
            if !(1..=crate::management::MAX_SAFE_INTEGER).contains(&time) {
                return Err(HubError::unavailable());
            }
            let already_administrator: Option<bool> = sqlx::query_scalar(
                "SELECT coalesce(role='admin',0) FROM users WHERE issuer=? AND subject=?",
            )
            .bind(&administrator.issuer)
            .bind(&administrator.sub)
            .fetch_optional(&mut *tx)
            .await?;
            sqlx::query("INSERT INTO users(id,issuer,subject,role,created_at) VALUES(?,?,?,'admin',?) ON CONFLICT(issuer,subject) DO UPDATE SET role='admin'")
                .bind(uuid::Uuid::new_v4().to_string()).bind(&administrator.issuer).bind(&administrator.sub).bind(time).execute(&mut *tx).await?;
            if already_administrator != Some(true) {
                let id: Option<String> = sqlx::query_scalar(
                    "SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id ELSE NULL END FROM users WHERE issuer=? AND subject=?",
                )
                .bind(&administrator.issuer)
                .bind(&administrator.sub)
                .fetch_one(&mut *tx)
                .await?;
                let id = id.ok_or_else(HubError::unavailable)?;
                canonical_id(&id).map_err(|_| HubError::unavailable())?;
                sqlx::query("INSERT INTO audit_events(actor_id,action,object_id,created_at) VALUES(NULL,'administrator_configured',?,?)")
                    .bind(&id).bind(time).execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        hub.recover().await?;
        Ok((
            hub,
            ServerLease {
                _database: database_lock,
                _content: content_lock,
            },
        ))
    }

    pub fn router(&self) -> axum::Router {
        crate::http::router(self.clone())
    }
    pub async fn close(&self) {
        // Keep the process lease until owned workers refund all four slots.
        let _workers = self.operations.clone().acquire_many_owned(4).await;
        self.pool.close().await;
    }
    pub(crate) fn object(&self, id: &str, staging: bool) -> Result<PathBuf> {
        canonical_id(id)?;
        Ok(self
            .config
            .content_directory
            .join(if staging { "staging" } else { "quarantine" })
            .join(format!("{id}.{}", if staging { "part" } else { "hwpk" })))
    }
    pub(crate) async fn actor(&self, identity: Identity) -> Result<Actor> {
        if identity.issuer != self.config.issuer {
            return Err(HubError::unauthorized());
        }
        sqlx::query("INSERT INTO users(id,issuer,subject,role,created_at) VALUES(?,?,?,'author',?) ON CONFLICT(issuer,subject) DO NOTHING")
            .bind(uuid::Uuid::new_v4().to_string()).bind(&identity.issuer).bind(&identity.subject).bind(now()).execute(&self.pool).await?;
        let row = sqlx::query("SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id ELSE NULL END AS id,CASE WHEN role IN ('author','moderator','admin') THEN role ELSE NULL END AS role FROM users WHERE issuer=? AND subject=?")
            .bind(identity.issuer)
            .bind(identity.subject)
            .fetch_one(&self.pool)
            .await?;
        let id = row
            .try_get::<Option<String>, _>("id")?
            .ok_or_else(HubError::unavailable)?;
        let role = row
            .try_get::<Option<String>, _>("role")?
            .ok_or_else(HubError::unavailable)?;
        canonical_id(&id).map_err(|_| HubError::unavailable())?;
        Ok(Actor { id, role })
    }
    pub(crate) async fn create_work(&self, actor: &Actor, input: CreateWork) -> Result<Work> {
        input.validate()?;
        let expected = digest(&input)?;
        let mut tx = self.pool.begin().await?;
        let existing = sqlx::query(
            "SELECT id,operation_digest FROM works WHERE owner_id=? AND operation_id=?",
        )
        .bind(&actor.id)
        .bind(&input.operation_id)
        .fetch_optional(&mut *tx)
        .await?;
        let id = if let Some(row) = existing {
            if row.try_get::<String, _>("operation_digest")? != expected {
                return Err(HubError::conflict("同一请求身份不能更换作品内容"));
            }
            row.try_get::<String, _>("id")?
        } else {
            if sqlx::query_scalar::<_, i64>("SELECT count(*) FROM works WHERE id=?")
                .bind(&input.work_id)
                .fetch_one(&mut *tx)
                .await?
                != 0
            {
                return Err(HubError::conflict("作品身份已被认领"));
            }
            sqlx::query("INSERT INTO works(id,owner_id,operation_id,operation_digest,title,license_json,created_at) VALUES(?,?,?,?,?,?,?)")
                .bind(&input.work_id).bind(&actor.id).bind(&input.operation_id).bind(expected).bind(&input.title)
                .bind(encode(&input.license)?).bind(now()).execute(&mut *tx).await?;
            input.work_id
        };
        let work = sqlx::query_as::<_, Work>(
            "SELECT id,title,license_json,created_at FROM works WHERE id=?",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(work)
    }
    pub(crate) async fn own_works(
        &self,
        actor: &Actor,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<Work>> {
        Ok(sqlx::query_as("SELECT id,title,license_json,created_at FROM works WHERE owner_id=? ORDER BY created_at,id LIMIT ? OFFSET ?")
            .bind(&actor.id).bind(limit).bind(offset).fetch_all(&self.pool).await?)
    }
    pub(crate) async fn releases_for(
        &self,
        actor: &Actor,
        queue: bool,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<Candidate>> {
        if queue && !actor.reviewer() {
            return Err(HubError::denied());
        }
        if queue {
            Ok(sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE state='pending_review' AND owner_id!=? ORDER BY releases.created_at,releases.id LIMIT ? OFFSET ?"))
                .bind(&actor.id).bind(limit).bind(offset).fetch_all(&self.pool).await?)
        } else {
            Ok(sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE owner_id=? ORDER BY releases.created_at DESC,releases.id LIMIT ? OFFSET ?"))
                .bind(&actor.id).bind(limit).bind(offset).fetch_all(&self.pool).await?)
        }
    }
    pub(crate) async fn published_release(&self, work: &str, release: &str) -> Result<Candidate> {
        canonical_id(work)?;
        canonical_id(release)?;
        let candidate: Candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE work_id=? AND id=? AND state='published' AND signed_release IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revocations v WHERE v.package_hash=releases.package_hash AND v.effective_at<=?)"))
            .bind(work).bind(release).bind(now()).fetch_optional(&self.pool).await?.ok_or_else(HubError::missing)?;
        self.verify_public_candidate(&candidate).await?;
        Ok(candidate)
    }
    pub(crate) async fn public_works(&self, after: i64, limit: i64) -> Result<Vec<Work>> {
        if !(1..=50).contains(&limit) || after < 0 {
            return Err(HubError::invalid("分页offset须非负，每页1–50项"));
        }
        let rows: Vec<(Option<String>, Option<i64>)> = sqlx::query_as("SELECT CASE WHEN length(CAST(w.id AS BLOB))=36 THEN w.id ELSE NULL END,CASE WHEN typeof(w.created_at)='integer' AND w.created_at BETWEEN 1 AND 9007199254740991 THEN w.created_at ELSE NULL END FROM works w JOIN releases r ON r.work_id=w.id WHERE r.state='published' AND r.signed_release IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revocations v WHERE v.package_hash=r.package_hash AND v.effective_at<=?) AND r.version=(SELECT max(r2.version) FROM releases r2 WHERE r2.work_id=w.id AND r2.state='published' AND r2.signed_release IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revocations v2 WHERE v2.package_hash=r2.package_hash AND v2.effective_at<=?)) ORDER BY w.created_at,w.id LIMIT ? OFFSET ?")
            .bind(now()).bind(now()).bind(limit).bind(after).fetch_all(&self.pool).await?;
        let mut works = Vec::with_capacity(rows.len());
        for (id, created_at) in rows {
            let id = id.ok_or_else(HubError::unavailable)?;
            let created_at = created_at.ok_or_else(HubError::unavailable)?;
            // Keep only this page's small identities while each bounded candidate
            // and its exact published receipt pass the original verification owner.
            let candidate = self.published(&id).await?;
            works.push(Work {
                id,
                title: candidate.title,
                license_json: candidate.license_json,
                created_at,
            });
        }
        Ok(works)
    }

    pub(crate) async fn published(&self, work: &str) -> Result<Candidate> {
        canonical_id(work)?;
        let candidate: Candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE work_id=? AND state='published' AND signed_release IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revocations v WHERE v.package_hash=releases.package_hash AND v.effective_at<=?) ORDER BY releases.version DESC LIMIT 1"))
            .bind(work).bind(now()).fetch_optional(&self.pool).await?.ok_or_else(HubError::missing)?;
        self.verify_public_candidate(&candidate).await?;
        Ok(candidate)
    }
    pub(crate) async fn candidate(&self, actor: &Actor, id: &str) -> Result<Candidate> {
        canonical_id(id)?;
        let candidate: Candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(HubError::missing)?;
        if candidate.owner_id != actor.id && !actor.reviewer() {
            return Err(HubError::missing());
        }
        Ok(candidate)
    }
    pub(crate) async fn upload(&self, actor: &Actor, id: &str) -> Result<Upload> {
        canonical_id(id)?;
        sqlx::query_as("SELECT * FROM uploads WHERE id=? AND owner_id=?")
            .bind(id)
            .bind(&actor.id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(HubError::missing)
    }
    async fn recover(&self) -> Result<()> {
        let receiving: Vec<String> =
            sqlx::query_scalar("SELECT id FROM uploads WHERE state='receiving'")
                .fetch_all(&self.pool)
                .await?;
        for id in receiving {
            remove_if_present(&self.object(&id, true)?).await?;
            remove_if_present(&self.object(&id, false)?).await?;
        }
        sqlx::query("UPDATE uploads SET state=CASE WHEN expires_at<=? THEN 'expired' ELSE 'reserved' END WHERE state='receiving'")
            .bind(now()).execute(&self.pool).await?;
        sqlx::query("UPDATE uploads SET state=CASE WHEN expires_at<=? THEN 'expired' ELSE 'ready' END WHERE state='validating'")
            .bind(now()).execute(&self.pool).await?;
        self.maintain().await
    }
}

pub(crate) async fn remove_if_present(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
