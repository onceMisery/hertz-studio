// SPDX-License-Identifier: MIT
//! Profile-scoped chat persistence. The bounded actor owns its connection and
//! filesystem lease; neither the library nor playback participates in a write.
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{
        SqliteAutoVacuum, SqliteConnectOptions, SqliteJournalMode, SqliteRow, SqliteSynchronous,
    },
    Connection, Row, SqliteConnection,
};
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

use super::contract::{RoomError, RoomResult};

const MIB: u64 = 1024 * 1024;
const PAGE: u64 = 4096;
// DELETE journals contain an original page plus its header/checksum. At the
// largest supported database this allowance exceeds all journal overhead.
const TRANSACTION_OVERHEAD: u64 = 2 * MIB;
const HISTORY_BYTES: usize = 48 * 1024;
const HISTORY_METADATA_BYTES: usize = 2048;
const RECENT_MESSAGES: usize = 200;
const RECENT_BYTES: usize = 512 * 1024;
const LIVE_IDENTITIES: usize = 17; // owner plus the room registry's 16 members
const RECEIPTS: usize = 256;
const RECEIPT_TTL: Duration = Duration::from_secs(600);
const MAINTENANCE_STEPS: usize = 256;
const VACUUM_PAGES: u32 = 512;
const SCHEMA: [&str; 4] = [
    "CREATE TABLE settings(singleton INTEGER PRIMARY KEY CHECK(singleton=1),config TEXT NOT NULL CHECK(length(CAST(config AS BLOB))<=1024),revision INTEGER NOT NULL CHECK(revision>0),next_id INTEGER NOT NULL CHECK(next_id>0))",
    "CREATE TABLE messages(id INTEGER PRIMARY KEY CHECK(id>0),room TEXT NOT NULL CHECK(length(room)=36),member TEXT NOT NULL CHECK(length(member)=36),name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 32 AND length(CAST(name AS BLOB))<=128),text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 200 AND length(CAST(text AS BLOB))<=800),received INTEGER NOT NULL CHECK(received>=0),track TEXT CHECK(track IS NULL OR length(track) BETWEEN 1 AND 20))",
    "CREATE INDEX room_messages ON messages(room,id)",
    "CREATE INDEX message_age ON messages(received,id)",
];
// Apply allocation bounds in SQLite before decoding untrusted stored strings.
const MESSAGE_COLUMNS: &str = "id,received, \
    CASE WHEN typeof(room)='text' AND length(CAST(room AS BLOB))=36 THEN room END AS room, \
    CASE WHEN typeof(member)='text' AND length(CAST(member AS BLOB))=36 THEN member END AS member, \
    CASE WHEN typeof(name)='text' AND length(name) BETWEEN 1 AND 32 AND length(CAST(name AS BLOB))<=128 THEN name END AS name, \
    CASE WHEN typeof(text)='text' AND length(text) BETWEEN 1 AND 200 AND length(CAST(text AS BLOB))<=800 THEN text END AS text, \
    CASE WHEN track IS NULL OR (typeof(track)='text' AND length(CAST(track AS BLOB)) BETWEEN 1 AND 20) THEN track ELSE 'invalid' END AS track";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChatConfig {
    pub enabled: bool,
    pub retained: bool,
    pub max_messages: u32,
    pub retention_days: u32,
    pub disk_quota_mib: u32,
}

impl Default for ChatConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            retained: true,
            max_messages: 10_000,
            retention_days: 7,
            disk_quota_mib: 64,
        }
    }
}

impl ChatConfig {
    fn validate(&self) -> RoomResult<()> {
        if !(100..=50_000).contains(&self.max_messages)
            || !(1..=30).contains(&self.retention_days)
            || !(16..=256).contains(&self.disk_quota_mib)
        {
            return Err(RoomError::invalid("聊天保留配置超出范围"));
        }
        Ok(())
    }

    fn quota(&self) -> u64 {
        u64::from(self.disk_quota_mib) * MIB
    }
    fn pages(&self) -> u64 {
        (self.quota() - TRANSACTION_OVERHEAD) / 2 / PAGE
    }
    fn cutoff(&self, now: i64) -> i64 {
        now.saturating_sub(i64::from(self.retention_days) * 86_400_000)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChatAdmin {
    Stats,
    Preview {
        config: ChatConfig,
    },
    Configure {
        config: ChatConfig,
        expected_revision: String,
        confirmed: bool,
    },
    Delete {
        message_id: String,
    },
    Clear {
        room_id: Uuid,
        confirmed: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMaintenance {
    pub step: usize,
    pub deleted: u64,
    pub database_pages: u64,
    pub target_pages: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatStatus {
    pub available: bool,
    pub history_revision: String,
    pub config: ChatConfig,
    pub disk_bytes: u64,
    pub messages: u64,
    pub error: Option<String>,
    pub maintenance: Option<ChatMaintenance>,
}

#[derive(Clone)]
pub struct ChatAccess {
    pub member: Uuid,
    pub name: String,
    pub read: Arc<dyn Fn() -> bool + Send + Sync>,
    pub send: Arc<dyn Fn() -> bool + Send + Sync>,
    /// True for the entire registry membership, including disconnected sessions
    /// and permission changes. Once false, this UUID must never be authorized
    /// again. A newly paired member receives a new UUID. This lifecycle bounds
    /// sequence/rate state without permitting old operations after receipt TTL.
    pub active: Arc<dyn Fn() -> bool + Send + Sync>,
}

pub enum ChatRequest {
    Send {
        operation: u64,
        text: String,
        track: Option<u64>,
    },
    History {
        before: Option<u64>,
        revision: Option<u64>,
    },
    Operation {
        operation: u64,
    },
    Admin(ChatAdmin),
}

struct Envelope {
    access: ChatAccess,
    request: ChatRequest,
    reply: oneshot::Sender<RoomResult<Value>>,
}

#[derive(Clone)]
pub struct ChatService {
    commands: mpsc::Sender<Envelope>,
    stop: watch::Sender<bool>,
    closed: watch::Receiver<bool>,
    pub status: watch::Receiver<ChatStatus>,
}

#[derive(Clone, Serialize)]
struct Message {
    message_id: String,
    chat_seq: String,
    received_at_ms: String,
    member_id: Uuid,
    name: String,
    text: String,
    track_instance_id: Option<String>,
    retained: bool,
}

impl Message {
    fn decode(row: &SqliteRow) -> RoomResult<Self> {
        let id: i64 = row.try_get("id").map_err(|_| damaged())?;
        let received: i64 = row.try_get("received").map_err(|_| damaged())?;
        let room: Option<String> = row.try_get("room").map_err(|_| damaged())?;
        let member: Option<String> = row.try_get("member").map_err(|_| damaged())?;
        let name: Option<String> = row.try_get("name").map_err(|_| damaged())?;
        let text: Option<String> = row.try_get("text").map_err(|_| damaged())?;
        let track: Option<String> = row.try_get("track").map_err(|_| damaged())?;
        let name = name.ok_or_else(damaged)?;
        let text = text.ok_or_else(damaged)?;
        Uuid::parse_str(room.as_deref().ok_or_else(damaged)?).map_err(|_| damaged())?;
        if id <= 0
            || received < 0
            || !name_valid(&name)
            || !text_valid(&text)
            || track.as_ref().is_some_and(|v| v.parse::<u64>().is_err())
        {
            return Err(damaged());
        }
        Ok(Self {
            message_id: id.to_string(),
            chat_seq: id.to_string(),
            received_at_ms: received.to_string(),
            member_id: Uuid::parse_str(member.as_deref().ok_or_else(damaged)?)
                .map_err(|_| damaged())?,
            name,
            text,
            track_instance_id: track,
            retained: true,
        })
    }

    fn id(&self) -> u64 {
        self.message_id
            .parse()
            .expect("validated internal message id")
    }
    fn received(&self) -> i64 {
        self.received_at_ms
            .parse()
            .expect("validated internal timestamp")
    }
    fn bytes(&self) -> usize {
        serde_json::to_vec(self)
            .expect("message serialization")
            .len()
    }
}

struct Bucket {
    credit: f64,
    at: Instant,
}

impl Bucket {
    fn new(credit: f64) -> Self {
        Self {
            credit,
            at: Instant::now(),
        }
    }
    fn refill(&mut self, now: Instant, rate: f64, burst: f64) {
        self.credit =
            (self.credit + now.saturating_duration_since(self.at).as_secs_f64() * rate).min(burst);
        self.at = now;
    }
}

struct Identity {
    highwater: u64,
    rate: Bucket,
    active: Arc<dyn Fn() -> bool + Send + Sync>,
}

struct Receipt {
    member: Uuid,
    operation: u64,
    hash: [u8; 32],
    id: String,
    at: Instant,
    retained: bool,
}

enum Deletion {
    Retention { config: ChatConfig, reserve: u32 },
    Oldest(u32),
    Message(u64),
    Room(Uuid),
}

struct Store {
    connection: SqliteConnection,
    path: PathBuf,
    room: Uuid,
    config: ChatConfig,
    revision: u64,
    next_id: u64,
    receipts: VecDeque<Receipt>,
    identities: HashMap<Uuid, Identity>,
    room_rate: Bucket,
    recent: VecDeque<Message>,
    recent_bytes: usize,
    notify: Arc<dyn Fn(Value) + Send + Sync>,
    status: watch::Sender<ChatStatus>,
    maintenance: Option<ChatMaintenance>,
    _lock: fslock::LockFile,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn storage() -> RoomError {
    RoomError::new(
        "chat_storage_failed",
        "聊天历史存储失败，消息未发送；音乐继续播放",
    )
}
fn damaged() -> RoomError {
    RoomError::new(
        "chat_history_damaged",
        "聊天历史损坏或字段无效；原文件已保留，请先备份并修复",
    )
}
fn format_error() -> RoomError {
    RoomError::new("chat_history_format", "聊天历史格式不受支持；原文件已保留")
}
fn recovery_error() -> RoomError {
    RoomError::new(
        "chat_history_recovery_required",
        "聊天事务文件不受支持，或无法读取配置并在原配额内安全恢复；原数据库及事务文件均未修改，请先备份并恢复",
    )
}
fn after_recovery(error: RoomError) -> RoomError {
    let reason = match error.code.as_str() {
        "chat_history_damaged" => "恢复后的历史完整性或字段校验失败",
        "chat_history_format" => "恢复后的历史格式不受支持",
        "chat_quota_exceeded" => "恢复后的文件占用超出配置配额",
        _ => "事务恢复或存储操作失败",
    };
    let code = if error.code == "chat_storage_failed" {
        "chat_history_recovery_failed"
    } else {
        &error.code
    };
    RoomError::new(
        code,
        format!("SQLite 回滚恢复已启动，但{reason}；文件可能已改变，请先备份现有文件并恢复聊天"),
    )
}
fn quota_error() -> RoomError {
    RoomError::new(
        "chat_quota_exceeded",
        "聊天文件及事务预留超出配额，消息未发送",
    )
}
fn unknown() -> RoomError {
    RoomError::new(
        "operation_unknown",
        "聊天操作结果已过期或不存在，勿自动重发旧文本",
    )
}
fn full(error: &sqlx::Error) -> bool {
    error.as_database_error().is_some_and(|e| {
        e.code()
            .is_some_and(|code| code == "13" || code == "SQLITE_FULL")
    })
}
fn text_valid(text: &str) -> bool {
    !text.trim().is_empty()
        && text.len() <= 800
        && text.chars().count() <= 200
        && !text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
}
fn name_valid(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 128
        && name.chars().count() <= 32
        && !name.chars().any(char::is_control)
}

async fn file_bytes(path: &Path) -> RoomResult<u64> {
    let mut total = 0u64;
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let file = PathBuf::from(format!("{}{suffix}", path.display()));
        match tokio::fs::metadata(file).await {
            Ok(metadata) => total = total.checked_add(metadata.len()).ok_or_else(storage)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(storage()),
        }
    }
    Ok(total)
}

fn options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(Duration::from_millis(500))
        .statement_cache_capacity(16)
        .pragma("trusted_schema", "OFF")
        .pragma("temp_store", "MEMORY")
        .pragma("mmap_size", "0")
        .pragma("cache_size", "-2048")
}

impl ChatService {
    pub async fn open(
        profile: &Path,
        room: Uuid,
        notify: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> RoomResult<Self> {
        let path = profile.join("room-chat.sqlite");
        let mut lock =
            fslock::LockFile::open(&profile.join("room-chat.lock")).map_err(|_| storage())?;
        if !lock.try_lock().map_err(|_| storage())? {
            return Err(RoomError::new(
                "chat_storage_busy",
                "此配置的聊天历史已由另一服务使用",
            ));
        }
        let fresh = !tokio::fs::try_exists(&path).await.map_err(|_| storage())?;
        let recovery_started = if fresh {
            false
        } else {
            Store::prepare_existing(&path).await?
        };
        let write_options = if fresh {
            options(&path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Delete)
                .synchronous(SqliteSynchronous::Full)
                .page_size(PAGE as u32)
                .auto_vacuum(SqliteAutoVacuum::Incremental)
        } else {
            // All persistent characteristics were checked above. Do not convert
            // an existing database as a side effect of opening chat.
            options(&path).synchronous(SqliteSynchronous::Full)
        };
        let mut connection = SqliteConnection::connect_with(&write_options)
            .await
            .map_err(|_| storage())?;
        if fresh {
            Store::create(&mut connection).await?;
        }
        let (config, revision, next_id) =
            Store::inspect(&mut connection, &path)
                .await
                .map_err(|error| {
                    if recovery_started {
                        after_recovery(error)
                    } else {
                        error
                    }
                })?;
        let (status, status_rx) = watch::channel(ChatStatus {
            available: true,
            history_revision: revision.to_string(),
            config: config.clone(),
            disk_bytes: 0,
            messages: 0,
            error: None,
            maintenance: None,
        });
        let mut store = Store {
            connection,
            path,
            room,
            config,
            revision,
            next_id,
            receipts: VecDeque::new(),
            identities: HashMap::new(),
            room_rate: Bucket::new(10.0),
            recent: VecDeque::new(),
            recent_bytes: 0,
            notify,
            status,
            maintenance: None,
            _lock: lock,
        };
        store.set_limit(store.config.pages()).await?;
        store.cleanup(0).await?;
        store.vacuum(128).await?;
        store.publish(None).await;
        let (commands, mut rx) = mpsc::channel::<Envelope>(32);
        let (stop, mut stopping) = watch::channel(false);
        let (closed_tx, closed) = watch::channel(false);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            tick.tick().await;
            loop {
                tokio::select! {
                    biased;
                    _ = stopping.changed() => break,
                    envelope = rx.recv() => {
                        let Some(envelope) = envelope else { break };
                        let result = store.execute(envelope.access, envelope.request).await;
                        let failure = result.as_ref().err().filter(|e|
                            e.code.starts_with("chat_storage") || e.code.starts_with("chat_history_")
                                || e.code == "chat_quota_exceeded").map(|e| e.message.clone());
                        store.publish(failure).await;
                        let _ = envelope.reply.send(result);
                    },
                    _ = tick.tick() => {
                        let result = async { store.cleanup(0).await?; store.vacuum(128).await }.await;
                        store.publish(result.err().map(|e| e.message)).await;
                    },
                }
            }
            rx.close();
            while let Some(envelope) = rx.recv().await {
                let _ = envelope.reply.send(Err(storage()));
            }
            let _ = store.connection.close().await;
            // Drop the filesystem lease before signaling completion to the host.
            drop(store._lock);
            closed_tx.send_replace(true);
        });
        Ok(Self {
            commands,
            stop,
            closed,
            status: status_rx,
        })
    }

    pub async fn request(&self, access: ChatAccess, request: ChatRequest) -> RoomResult<Value> {
        if *self.stop.borrow() {
            return Err(storage());
        }
        let (reply, response) = oneshot::channel();
        self.commands
            .try_send(Envelope {
                access,
                request,
                reply,
            })
            .map_err(|_| RoomError::new("chat_busy", "聊天存储队列繁忙"))?;
        tokio::time::timeout(Duration::from_secs(5), response)
            .await
            .map_err(|_| {
                RoomError::new(
                    "room_outcome_unknown",
                    "聊天操作结果尚未确定，请按原操作键查询",
                )
            })?
            .map_err(|_| storage())?
    }

    /// Finish any in-flight transaction and release the profile lease. Room
    /// teardown awaits this before another room can acquire the same profile.
    pub async fn shutdown(&self) {
        self.stop.send_replace(true);
        let mut closed = self.closed.clone();
        while !*closed.borrow_and_update() {
            if closed.changed().await.is_err() {
                break;
            }
        }
    }
}

impl Store {
    async fn prepare_existing(path: &Path) -> RoomResult<bool> {
        let metadata = tokio::fs::metadata(path).await.map_err(|_| storage())?;
        if metadata.permissions().readonly() {
            return Err(RoomError::new(
                "chat_history_readonly",
                "聊天历史为只读；原文件已保留",
            ));
        }
        if file_bytes(path).await? > 256 * MIB {
            return Err(quota_error());
        }
        let mut journal_bytes = 0;
        for suffix in ["-journal", "-wal", "-shm"] {
            match tokio::fs::metadata(PathBuf::from(format!("{}{suffix}", path.display()))).await {
                Ok(sidecar) if sidecar.len() > 0 => {
                    if suffix != "-journal" || sidecar.permissions().readonly() {
                        return Err(recovery_error());
                    }
                    journal_bytes = sidecar.len();
                }
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(storage()),
            }
        }
        if journal_bytes == 0 {
            // Ordinary damaged/unsupported databases are inspected without any
            // recovery or persistent pragma before a writable connection exists.
            let mut inspection = SqliteConnection::connect_with(&options(path).read_only(true))
                .await
                .map_err(|_| damaged())?;
            let result = Self::inspect(&mut inspection, path).await;
            inspection.close().await.map_err(|_| storage())?;
            result?;
            return Ok(false);
        }

        // Only inspect the documented fixed header, never replay journal pages.
        // SQLite remains the sole implementation of locking/checksums/rollback.
        let mut database_header = [0u8; 100];
        std::fs::File::open(path)
            .and_then(|mut file| file.read_exact(&mut database_header))
            .map_err(|_| damaged())?;
        if &database_header[..16] != b"SQLite format 3\0" {
            return Err(damaged());
        }
        if u16::from_be_bytes(database_header[16..18].try_into().unwrap()) != PAGE as u16
            || database_header[18..20] != [1, 1]
            || u32::from_be_bytes(database_header[60..64].try_into().unwrap()) != 1
            || u32::from_be_bytes(database_header[64..68].try_into().unwrap()) != 1
        {
            return Err(format_error());
        }
        let mut header = [0u8; 28];
        let journal_path = PathBuf::from(format!("{}-journal", path.display()));
        std::fs::File::open(&journal_path)
            .and_then(|mut file| file.read_exact(&mut header))
            .map_err(|_| recovery_error())?;
        let cold = header[..8] == [0; 8];
        let original_pages = if cold {
            metadata.len() / PAGE
        } else {
            if header[..8] != [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7] {
                return Err(recovery_error());
            }
            let records = u32::from_be_bytes(header[8..12].try_into().unwrap());
            let sector = u32::from_be_bytes(header[20..24].try_into().unwrap());
            let page = u32::from_be_bytes(header[24..28].try_into().unwrap());
            if page != PAGE as u32
                || !(32..=65_536).contains(&sector)
                || !sector.is_power_of_two()
                || u64::from(sector) > journal_bytes
                || (records != u32::MAX
                    && u64::from(sector) + u64::from(records) * (PAGE + 8) > journal_bytes)
            {
                return Err(recovery_error());
            }
            u64::from(u32::from_be_bytes(header[16..20].try_into().unwrap()))
        };
        // immutable suppresses SQLite recovery during this bounded preflight.
        // A hot database can be temporarily inconsistent, so quick_check runs
        // after rollback. Schema and readable settings must still identify our
        // format and budget; otherwise preserve both files for explicit recovery.
        let mut inspection =
            SqliteConnection::connect_with(&options(path).read_only(true).immutable(true))
                .await
                .map_err(|_| recovery_error())?;
        let preflight = async {
            Self::inspect_schema(&mut inspection)
                .await
                .map_err(|error| if cold { error } else { recovery_error() })?;
            let (config, _, _) = Self::read_settings(&mut inspection)
                .await
                .map_err(|error| if cold { error } else { recovery_error() })?;
            if cold {
                Self::inspect_data(&mut inspection, path, true).await?;
            }
            let peak_bytes = metadata
                .len()
                .max(original_pages.saturating_mul(PAGE))
                .saturating_add(journal_bytes);
            if original_pages == 0
                || original_pages > config.pages()
                || metadata.len() % PAGE != 0
                || metadata.len() > config.pages() * PAGE
                || peak_bytes > config.quota()
            {
                return Err(recovery_error());
            }
            Ok(())
        }
        .await;
        inspection.close().await.map_err(|_| storage())?;
        preflight?;
        // No staging files or manual repair: supported SQLite recovery uses the
        // already-budgeted rollback journal. Reassert the validated format version
        // in a normal transaction so SQLite also finalizes an unused cold journal.
        // Only after recovery do we validate all pages,
        // field limits, the physical budget and the retention window (open()).
        let mut recovery =
            SqliteConnection::connect_with(&options(path).synchronous(SqliteSynchronous::Full))
                .await
                .map_err(|_| after_recovery(storage()))?;
        let recovered = async {
            let mut tx = recovery.begin().await.map_err(|_| storage())?;
            sqlx::query("PRAGMA user_version=1")
                .execute(&mut *tx)
                .await
                .map_err(|_| storage())?;
            tx.commit().await.map_err(|_| storage())?;
            Self::inspect(&mut recovery, path).await
        }
        .await;
        recovery
            .close()
            .await
            .map_err(|_| after_recovery(storage()))?;
        recovered.map_err(after_recovery)?;
        Ok(true)
    }

    async fn create(connection: &mut SqliteConnection) -> RoomResult<()> {
        let mut tx = connection.begin().await.map_err(|_| storage())?;
        for statement in SCHEMA.into_iter().chain(["PRAGMA user_version=1"]) {
            sqlx::query(statement)
                .execute(&mut *tx)
                .await
                .map_err(|_| storage())?;
        }
        sqlx::query("INSERT INTO settings VALUES(1,?,1,1)")
            .bind(serde_json::to_string(&ChatConfig::default()).map_err(|_| storage())?)
            .execute(&mut *tx)
            .await
            .map_err(|_| storage())?;
        tx.commit().await.map_err(|_| storage())
    }

    async fn inspect(
        connection: &mut SqliteConnection,
        path: &Path,
    ) -> RoomResult<(ChatConfig, u64, u64)> {
        Self::inspect_data(connection, path, false).await
    }

    async fn inspect_schema(connection: &mut SqliteConnection) -> RoomResult<()> {
        let schema_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| format_error())?;
        let expected: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE sql IN (?,?,?,?)")
                .bind(SCHEMA[0])
                .bind(SCHEMA[1])
                .bind(SCHEMA[2])
                .bind(SCHEMA[3])
                .fetch_one(&mut *connection)
                .await
                .map_err(|_| format_error())?;
        if schema_count != SCHEMA.len() as i64 || expected != schema_count {
            return Err(format_error());
        }
        Ok(())
    }

    async fn read_settings(
        connection: &mut SqliteConnection,
    ) -> RoomResult<(ChatConfig, u64, u64)> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM settings")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| damaged())?;
        if count != 1 {
            return Err(damaged());
        }
        let row = sqlx::query(
            "SELECT CASE WHEN typeof(config)='text' AND length(CAST(config AS BLOB))<=1024 THEN config END AS config,revision,next_id FROM settings WHERE singleton=1")
            .fetch_one(&mut *connection).await.map_err(|_| damaged())?;
        let encoded: Option<String> = row.try_get("config").map_err(|_| damaged())?;
        let config: ChatConfig =
            serde_json::from_str(encoded.as_deref().ok_or_else(damaged)?).map_err(|_| damaged())?;
        config.validate().map_err(|_| damaged())?;
        let revision: i64 = row.try_get("revision").map_err(|_| damaged())?;
        let next_id: i64 = row.try_get("next_id").map_err(|_| damaged())?;
        if revision <= 0 || next_id <= 0 {
            return Err(damaged());
        }
        Ok((config, revision as u64, next_id as u64))
    }

    async fn inspect_data(
        connection: &mut SqliteConnection,
        path: &Path,
        allow_journal: bool,
    ) -> RoomResult<(ChatConfig, u64, u64)> {
        let integrity: Option<String> = sqlx::query_scalar(
            "SELECT CASE WHEN length(CAST(quick_check AS BLOB))<=128 THEN quick_check END FROM pragma_quick_check LIMIT 1")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| damaged())?;
        if integrity.as_deref() != Some("ok") {
            return Err(damaged());
        }
        let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| damaged())?;
        let vacuum: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| damaged())?;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| damaged())?;
        let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| damaged())?;
        if page_size != PAGE as i64 || vacuum != 2 || version != 1 || journal != "delete" {
            return Err(format_error());
        }
        // Inspect bounded scalar counts rather than allocating names or SQL from
        // an untrusted sqlite_schema. Views and triggers have no role in chat.
        Self::inspect_schema(connection).await?;
        let (config, revision, next_id) = Self::read_settings(connection).await?;
        let invalid: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE typeof(id)<>'integer' OR id<=0 OR id>=? \
             OR typeof(room)<>'text' OR length(CAST(room AS BLOB))<>36 \
             OR typeof(member)<>'text' OR length(CAST(member AS BLOB))<>36 \
             OR typeof(name)<>'text' OR length(name) NOT BETWEEN 1 AND 32 OR length(CAST(name AS BLOB))>128 \
             OR typeof(text)<>'text' OR length(text) NOT BETWEEN 1 AND 200 OR length(CAST(text AS BLOB))>800 \
             OR typeof(received)<>'integer' OR received<0 \
             OR (track IS NOT NULL AND (typeof(track)<>'text' OR length(CAST(track AS BLOB)) NOT BETWEEN 1 AND 20)))")
            .bind(i64::try_from(next_id).map_err(|_| damaged())?).fetch_one(&mut *connection).await.map_err(|_| damaged())?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| damaged())?;
        if invalid != 0 || count > 50_000 {
            return Err(damaged());
        }
        // Validate every row before startup cleanup, including expired rows.
        // Pagination and SQL-side field bounds keep each allocation bounded.
        let mut after = 0_i64;
        loop {
            let rows = sqlx::query(&format!(
                "SELECT {MESSAGE_COLUMNS} FROM messages WHERE id>? ORDER BY id LIMIT 128"
            ))
            .bind(after)
            .fetch_all(&mut *connection)
            .await
            .map_err(|_| damaged())?;
            if rows.is_empty() {
                break;
            }
            for row in rows {
                let message = Message::decode(&row)?;
                after = message.id() as i64;
            }
        }
        let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| damaged())?;
        let bytes = if allow_journal {
            tokio::fs::metadata(path)
                .await
                .map_err(|_| storage())?
                .len()
        } else {
            file_bytes(path).await?
        };
        if pages < 1
            || pages as u64 > config.pages()
            || bytes != pages as u64 * PAGE
            || bytes
                .saturating_add(pages as u64 * PAGE)
                .saturating_add(TRANSACTION_OVERHEAD)
                > config.quota()
        {
            return Err(quota_error());
        }
        Ok((config, revision, next_id))
    }

    async fn files(&self) -> RoomResult<u64> {
        file_bytes(&self.path).await
    }

    async fn pages(&mut self) -> RoomResult<u64> {
        let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(&mut self.connection)
            .await
            .map_err(|_| storage())?;
        u64::try_from(pages).map_err(|_| damaged())
    }

    async fn set_limit(&mut self, pages: u64) -> RoomResult<()> {
        let actual: i64 = sqlx::query_scalar(&format!("PRAGMA max_page_count={pages}"))
            .fetch_one(&mut self.connection)
            .await
            .map_err(|_| storage())?;
        if actual as u64 != pages {
            return Err(quota_error());
        }
        Ok(())
    }

    async fn reserve(&mut self) -> RoomResult<()> {
        let pages = self.pages().await?;
        if pages > self.config.pages()
            || self
                .files()
                .await?
                .saturating_add(pages * PAGE)
                .saturating_add(TRANSACTION_OVERHEAD)
                > self.config.quota()
        {
            return Err(quota_error());
        }
        Ok(())
    }

    async fn reopen_after_full(&mut self) -> RoomResult<()> {
        // SQLITE_FULL can roll back the entire transaction automatically. The
        // driver's transaction depth then remains stale after ROLLBACK reports
        // "no transaction is active". Close that worker before another write,
        // verify the committed state, and restore its exact physical page cap.
        let limit: i64 = sqlx::query_scalar("PRAGMA max_page_count")
            .fetch_one(&mut self.connection)
            .await
            .map_err(|_| storage())?;
        let replacement = SqliteConnection::connect_with(
            &options(&self.path).synchronous(SqliteSynchronous::Full),
        )
        .await
        .map_err(|_| storage())?;
        let previous = std::mem::replace(&mut self.connection, replacement);
        previous.close().await.map_err(|_| storage())?;
        let (config, revision, next_id) = Self::inspect(&mut self.connection, &self.path).await?;
        if config != self.config || revision != self.revision || next_id != self.next_id {
            return Err(damaged());
        }
        self.set_limit(u64::try_from(limit).map_err(|_| damaged())?)
            .await
    }

    async fn vacuum(&mut self, pages: u32) -> RoomResult<()> {
        self.reserve().await?;
        // Stepping every PRAGMA row matters: incremental_vacuum can yield once
        // per freed page, and stopping after its first row only frees one page.
        sqlx::query(&format!("PRAGMA incremental_vacuum({pages})"))
            .fetch_all(&mut self.connection)
            .await
            .map_err(|_| storage())?;
        Ok(())
    }

    fn next_revision(&self) -> RoomResult<u64> {
        self.revision
            .checked_add(1)
            .filter(|v| *v <= i64::MAX as u64)
            .ok_or_else(RoomError::exhausted)
    }

    fn history_changed(&self, deleted: u64) {
        (self.notify)(
            json!({"topic":"chat_history_changed", "history_revision":self.revision.to_string(), "deleted":deleted}),
        );
    }

    async fn cleanup(&mut self, reserve: u32) -> RoomResult<u64> {
        self.delete(Deletion::Retention {
            config: self.config.clone(),
            reserve,
        })
        .await
    }

    // Stage deletions on the caller's transaction; cache and revision change
    // only after that transaction (including any replacement insert) commits.
    async fn delete_rows(
        connection: &mut SqliteConnection,
        recent: &VecDeque<Message>,
        room: Uuid,
        selection: Deletion,
    ) -> Result<(u64, Vec<u64>), sqlx::Error> {
        let mut cached = Vec::new();
        let now = now_ms();
        match &selection {
            Deletion::Retention { config, .. } => {
                let cutoff = config.cutoff(now);
                for message in recent {
                    if message.received() < cutoff {
                        cached.push(message.id());
                    }
                }
            }
            Deletion::Message(id) => {
                cached.extend(recent.iter().filter(|m| m.id() == *id).map(Message::id))
            }
            Deletion::Room(selected) if *selected == room => {
                cached.extend(recent.iter().map(Message::id))
            }
            _ => (),
        }
        let retained = match selection {
            Deletion::Retention { config, reserve } => {
                let expired = sqlx::query("DELETE FROM messages WHERE received<?")
                    .bind(config.cutoff(now))
                    .execute(&mut *connection)
                    .await?
                    .rows_affected();
                let keep = config.max_messages.saturating_sub(reserve) as usize;
                let live_cached: Vec<u64> = recent
                    .iter()
                    .filter(|m| !cached.contains(&m.id()))
                    .map(Message::id)
                    .collect();
                let overflow = if keep == 0 {
                    cached.extend(live_cached);
                    sqlx::query("DELETE FROM messages")
                        .execute(&mut *connection)
                        .await?
                        .rows_affected()
                } else {
                    // The skipped durable prefix must fit even if every cached
                    // message is newer. Only the following <=201 durable IDs
                    // can compete with the <=200 cached IDs for the boundary.
                    let offset = keep.saturating_sub(live_cached.len() + 1);
                    let mut boundary: Vec<i64> = sqlx::query_scalar(
                        "SELECT id FROM messages ORDER BY id DESC LIMIT ? OFFSET ?",
                    )
                    .bind((live_cached.len() + 1) as i64)
                    .bind(offset as i64)
                    .fetch_all(&mut *connection)
                    .await?;
                    boundary.extend(live_cached.iter().map(|id| *id as i64));
                    boundary.sort_unstable_by(|a, b| b.cmp(a));
                    match boundary.get(keep - offset - 1).copied() {
                        Some(cutoff) => {
                            cached.extend(live_cached.into_iter().filter(|id| *id < cutoff as u64));
                            sqlx::query("DELETE FROM messages WHERE id<?")
                                .bind(cutoff)
                                .execute(&mut *connection)
                                .await?
                                .rows_affected()
                        }
                        None => 0,
                    }
                };
                expired + overflow
            }
            Deletion::Oldest(count) => {
                let cutoff: Option<i64> = sqlx::query_scalar(
                    "SELECT MAX(id) FROM (SELECT id FROM messages ORDER BY id LIMIT ?)",
                )
                .bind(i64::from(count))
                .fetch_one(&mut *connection)
                .await?;
                if let Some(cutoff) = cutoff {
                    cached.extend(
                        recent
                            .iter()
                            .filter(|m| m.id() <= cutoff as u64)
                            .map(Message::id),
                    );
                    sqlx::query("DELETE FROM messages WHERE id<=?")
                        .bind(cutoff)
                        .execute(&mut *connection)
                        .await?
                        .rows_affected()
                } else {
                    0
                }
            }
            Deletion::Message(id) => sqlx::query("DELETE FROM messages WHERE id=?")
                .bind(id as i64)
                .execute(&mut *connection)
                .await?
                .rows_affected(),
            Deletion::Room(room) => sqlx::query("DELETE FROM messages WHERE room=?")
                .bind(room.to_string())
                .execute(&mut *connection)
                .await?
                .rows_affected(),
        };
        Ok((retained, cached))
    }

    async fn delete(&mut self, selection: Deletion) -> RoomResult<u64> {
        self.reserve().await?;
        let revision = self.next_revision()?;
        let mut tx = self.connection.begin().await.map_err(|_| storage())?;
        let (retained, cached) = Self::delete_rows(&mut tx, &self.recent, self.room, selection)
            .await
            .map_err(|_| storage())?;
        let deleted = retained + cached.len() as u64;
        if deleted > 0 {
            sqlx::query("UPDATE settings SET revision=? WHERE singleton=1")
                .bind(revision as i64)
                .execute(&mut *tx)
                .await
                .map_err(|_| storage())?;
        }
        tx.commit().await.map_err(|_| storage())?;
        if deleted > 0 {
            self.revision = revision;
            self.recent.retain(|m| !cached.contains(&m.id()));
            self.recent_bytes = self.recent.iter().map(Message::bytes).sum();
            self.history_changed(deleted);
        }
        Ok(deleted)
    }

    fn evict_receipts(&mut self) {
        while self.receipts.len() > RECEIPTS
            || self
                .receipts
                .front()
                .is_some_and(|r| r.at.elapsed() >= RECEIPT_TTL)
        {
            self.receipts.pop_front();
        }
        self.identities.retain(|_, identity| (identity.active)());
    }

    fn next_operation(&self, member: Uuid) -> RoomResult<String> {
        self.identities
            .get(&member)
            .map_or(0, |identity| identity.highwater)
            .checked_add(1)
            .map(|v| v.to_string())
            .ok_or_else(RoomError::exhausted)
    }

    fn receipt(&self, member: Uuid, operation: u64) -> Option<&Receipt> {
        self.receipts
            .iter()
            .find(|receipt| receipt.member == member && receipt.operation == operation)
    }

    async fn execute(&mut self, access: ChatAccess, request: ChatRequest) -> RoomResult<Value> {
        self.evict_receipts();
        if !(access.active)() {
            return Err(RoomError::denied());
        }
        match request {
            ChatRequest::Send {
                operation,
                text,
                track,
            } => self.send(access, operation, text, track).await,
            ChatRequest::History { before, revision } => {
                if !(access.read)() {
                    return Err(RoomError::denied());
                }
                self.cleanup(0).await?;
                let result = self.history(access.member, before, revision).await?;
                if !(access.active)() || !(access.read)() {
                    return Err(RoomError::denied());
                }
                Ok(result)
            }
            ChatRequest::Operation { operation } => {
                if !(access.send)() {
                    return Err(RoomError::denied());
                }
                self.receipt(access.member, operation)
                    .map(|r| json!({"status":"applied", "message_id":r.id, "retained":r.retained}))
                    .ok_or_else(unknown)
            }
            ChatRequest::Admin(command) => {
                if !access.member.is_nil() {
                    return Err(RoomError::denied());
                }
                self.admin(command).await
            }
        }
    }

    async fn send(
        &mut self,
        access: ChatAccess,
        operation: u64,
        text: String,
        track: Option<u64>,
    ) -> RoomResult<Value> {
        if !(access.send)() {
            return Err(RoomError::denied());
        }
        if !self.config.enabled {
            return Err(RoomError::new("chat_disabled", "房主已关闭房间互动"));
        }
        if operation == 0
            || operation == u64::MAX
            || !text_valid(&text)
            || !name_valid(&access.name)
        {
            return Err(RoomError::invalid("聊天操作序号、正文或显示名称无效"));
        }
        let hash: [u8; 32] = Sha256::digest(text.as_bytes()).into();
        if let Some(receipt) = self.receipt(access.member, operation) {
            if receipt.hash != hash {
                return Err(RoomError::new(
                    "operation_key_conflict",
                    "同一聊天操作序号携带了不同内容",
                ));
            }
            return Ok(
                json!({"status":"applied", "message_id":receipt.id, "retained":receipt.retained}),
            );
        }
        if operation
            <= self
                .identities
                .get(&access.member)
                .map_or(0, |i| i.highwater)
        {
            return Err(unknown());
        }
        if !self.identities.contains_key(&access.member) && self.identities.len() >= LIVE_IDENTITIES
        {
            return Err(RoomError::new(
                "chat_membership_limit",
                "聊天授权成员超过房间并发上限",
            ));
        }
        let identity = self
            .identities
            .entry(access.member)
            .or_insert_with(|| Identity {
                highwater: 0,
                rate: Bucket::new(3.0),
                active: access.active.clone(),
            });
        let now = Instant::now();
        identity.rate.refill(now, 1.0, 3.0);
        self.room_rate.refill(now, 10.0, 10.0);
        if identity.rate.credit < 1.0 || self.room_rate.credit < 1.0 {
            return Err(RoomError::new(
                "chat_rate_limited",
                "发言过于频繁，请稍后再试",
            ));
        }
        identity.rate.credit -= 1.0;
        self.room_rate.credit -= 1.0;
        let id = self.next_id;
        let next = id
            .checked_add(1)
            .filter(|v| *v <= i64::MAX as u64)
            .ok_or_else(RoomError::exhausted)?;
        let message = Message {
            message_id: id.to_string(),
            chat_seq: id.to_string(),
            received_at_ms: now_ms().to_string(),
            member_id: access.member,
            name: access.name.clone(),
            text,
            track_instance_id: track.map(|t| t.to_string()),
            retained: self.config.retained,
        };
        let size = message.bytes();
        if serde_json::to_vec(&json!({"topic":"chat_message", "message":message}))
            .map_err(|_| storage())?
            .len()
            > 2048
        {
            return Err(RoomError::invalid("完整聊天消息超过2KiB"));
        }
        let cache_limit = RECENT_MESSAGES.min(self.config.max_messages as usize);
        // SQLite may reach the physical page cap before the configured row cap.
        // Retry once with a global eviction batch in the SAME insert transaction.
        // A refused send must never commit retention or physical-cap eviction.
        let mut retried = false;
        let (deleted, cached, revision) = loop {
            self.reserve().await?;
            let next_revision = self.next_revision()?;
            let mut tx = self.connection.begin().await.map_err(|_| storage())?;
            let written = async {
                let (mut deleted, mut cached) = Self::delete_rows(
                    &mut tx, &self.recent, self.room,
                    Deletion::Retention { config: self.config.clone(), reserve: 1 },
                ).await?;
                if retried {
                    let (rows, evicted) = Self::delete_rows(
                        &mut tx, &self.recent, self.room, Deletion::Oldest(256),
                    ).await?;
                    deleted += rows;
                    cached.extend(evicted);
                }
                cached.sort_unstable();
                cached.dedup();
                if !message.retained {
                    let mut remaining = self.recent.len() - cached.len();
                    let mut remaining_bytes: usize = self.recent.iter()
                        .filter(|m| !cached.contains(&m.id())).map(Message::bytes).sum();
                    for old in &self.recent {
                        if cached.contains(&old.id()) {
                            continue;
                        }
                        if remaining < cache_limit && remaining_bytes + size <= RECENT_BYTES {
                            break;
                        }
                        cached.push(old.id());
                        remaining -= 1;
                        remaining_bytes = remaining_bytes.saturating_sub(old.bytes());
                    }
                }
                deleted += cached.len() as u64;
                let revision = if deleted > 0 { next_revision } else { self.revision };
                if message.retained {
                    sqlx::query("INSERT INTO messages(id,room,member,name,text,received,track) VALUES(?,?,?,?,?,?,?)")
                        .bind(id as i64).bind(self.room.to_string()).bind(access.member.to_string())
                        .bind(&message.name).bind(&message.text).bind(message.received())
                        .bind(&message.track_instance_id).execute(&mut *tx).await?;
                }
                sqlx::query("UPDATE settings SET next_id=?,revision=? WHERE singleton=1")
                    .bind(next as i64).bind(revision as i64).execute(&mut *tx).await?;
                Ok::<_, sqlx::Error>((deleted, cached, revision))
            }.await;
            let changes = match written {
                Ok(changes) => changes,
                Err(error) => {
                    let rollback = tx.rollback().await;
                    if full(&error) {
                        self.reopen_after_full().await?;
                        if retried {
                            return Err(quota_error());
                        }
                        retried = true;
                        continue;
                    }
                    rollback.map_err(|_| storage())?;
                    return Err(storage());
                }
            };
            if !(access.active)() || !(access.send)() {
                tx.rollback().await.map_err(|_| storage())?;
                return Err(RoomError::denied());
            }
            if let Err(error) = tx.commit().await {
                if full(&error) {
                    self.reopen_after_full().await?;
                    if !retried {
                        retried = true;
                        continue;
                    }
                    return Err(quota_error());
                }
                return Err(storage());
            }
            break changes;
        };
        // No sequence, cache, receipt or notification is published before commit.
        self.next_id = next;
        self.revision = revision;
        self.recent.retain(|m| !cached.contains(&m.id()));
        self.identities
            .get_mut(&access.member)
            .expect("registered sender")
            .highwater = operation;
        if !message.retained {
            self.recent.push_back(message.clone());
        }
        self.recent_bytes = self.recent.iter().map(Message::bytes).sum();
        if deleted > 0 {
            self.history_changed(deleted);
        }
        self.receipts.push_back(Receipt {
            member: access.member,
            operation,
            hash,
            id: message.message_id.clone(),
            at: Instant::now(),
            retained: message.retained,
        });
        self.evict_receipts();
        (self.notify)(json!({"topic":"chat_message", "message":message}));
        Ok(json!({"status":"applied", "message_id":id.to_string(), "retained":message.retained}))
    }

    async fn history(
        &mut self,
        member: Uuid,
        before: Option<u64>,
        revision: Option<u64>,
    ) -> RoomResult<Value> {
        let next_operation = self.next_operation(member)?;
        if revision.is_some_and(|v| v != self.revision) {
            return Ok(
                json!({"history_revision":self.revision.to_string(), "messages":[], "cursor_invalidated":true,
                "next_operation_id":next_operation, "retained":self.config.retained}),
            );
        }
        let before = i64::try_from(before.unwrap_or(i64::MAX as u64))
            .map_err(|_| RoomError::invalid("历史游标无效"))?;
        if before <= 0 {
            return Err(RoomError::invalid("历史游标无效"));
        }
        let cutoff = self.config.cutoff(now_ms());
        let rows = sqlx::query(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages WHERE room=? AND received>=? AND id<? ORDER BY id DESC LIMIT 101"))
            .bind(self.room.to_string()).bind(cutoff).bind(before)
            .fetch_all(&mut self.connection).await.map_err(|_| storage())?;
        let mut candidates = Vec::with_capacity(rows.len() + self.recent.len());
        for row in rows {
            candidates.push(Message::decode(&row)?);
        }
        candidates.extend(
            self.recent
                .iter()
                .filter(|m| m.received() >= cutoff && m.id() < before as u64)
                .cloned(),
        );
        candidates.sort_unstable_by_key(|m| std::cmp::Reverse(m.id()));
        let mut messages = Vec::new();
        let mut bytes = HISTORY_METADATA_BYTES;
        let total = candidates.len();
        for message in candidates {
            let size = message.bytes() + 1;
            if messages.len() == 100 || bytes + size > HISTORY_BYTES {
                break;
            }
            bytes += size;
            messages.push(message);
        }
        let has_more = messages.len() < total;
        let next_before = if has_more {
            messages.last().map(|m| m.message_id.clone())
        } else {
            None
        };
        let oldest: Option<i64> =
            sqlx::query_scalar("SELECT MIN(id) FROM messages WHERE room=? AND received>=?")
                .bind(self.room.to_string())
                .bind(cutoff)
                .fetch_one(&mut self.connection)
                .await
                .map_err(|_| storage())?;
        let earliest = oldest
            .map(|v| v as u64)
            .into_iter()
            .chain(
                self.recent
                    .iter()
                    .filter(|m| m.received() >= cutoff)
                    .map(Message::id),
            )
            .min();
        messages.reverse();
        let result = json!({"history_revision":self.revision.to_string(), "messages":messages,
            "earliest_id":earliest.map(|v|v.to_string()), "earlier_cleaned":before!=i64::MAX && earliest.is_none_or(|v|v>=before as u64),
            "retained":self.config.retained, "has_more":has_more, "next_before":next_before, "next_operation_id":next_operation});
        if serde_json::to_vec(&result).map_err(|_| storage())?.len() > HISTORY_BYTES {
            return Err(storage());
        }
        Ok(result)
    }

    async fn stats(&mut self) -> RoomResult<Value> {
        let rows = sqlx::query(
            "SELECT CASE WHEN length(CAST(room AS BLOB))=36 THEN room END AS room,COUNT(*) AS count,MIN(received) AS oldest FROM messages GROUP BY room ORDER BY MAX(id) DESC LIMIT 100")
            .fetch_all(&mut self.connection).await.map_err(|_| storage())?;
        let mut rooms = Vec::with_capacity(rows.len());
        for row in rows {
            let room: Option<String> = row.try_get("room").map_err(|_| damaged())?;
            let room =
                Uuid::parse_str(room.as_deref().ok_or_else(damaged)?).map_err(|_| damaged())?;
            rooms.push(
                json!({"room_id":room, "count":row.try_get::<i64,_>("count").map_err(|_|damaged())?,
                "oldest_ms":row.try_get::<i64,_>("oldest").map_err(|_|damaged())?.to_string()}),
            );
        }
        let rooms_total: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT room) FROM messages")
            .fetch_one(&mut self.connection)
            .await
            .map_err(|_| storage())?;
        Ok(
            json!({"history_revision":self.revision.to_string(), "config":self.config, "disk_bytes":self.files().await?,
            "rooms_truncated":rooms_total as usize>rooms.len(), "rooms_total":rooms_total, "rooms":rooms,
            "recent_messages":self.recent.len(), "maintenance":self.maintenance}),
        )
    }

    async fn preview(&mut self, config: &ChatConfig) -> RoomResult<Value> {
        config.validate()?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE received<?")
            .bind(config.cutoff(now_ms()))
            .fetch_one(&mut self.connection)
            .await
            .map_err(|_| storage())?;
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&mut self.connection)
            .await
            .map_err(|_| storage())?;
        let recent_expired = self
            .recent
            .iter()
            .filter(|m| m.received() < config.cutoff(now_ms()))
            .count() as i64;
        Ok(
            json!({"history_revision":self.revision.to_string(), "expired_messages":count+recent_expired,
            "at_least_deleted":(count+recent_expired).max(total+self.recent.len() as i64-i64::from(config.max_messages)).max(0),
            "disk_shrink_required":self.pages().await?>config.pages(), "disk_eviction_may_delete_more":self.pages().await?>config.pages(), "config":config}),
        )
    }

    async fn configure(
        &mut self,
        config: ChatConfig,
        expected_revision: String,
        confirmed: bool,
    ) -> RoomResult<Value> {
        config.validate()?;
        if expected_revision != self.revision.to_string() {
            return Err(RoomError::new(
                "revision_conflict",
                "聊天保留范围已改变，请重新预览",
            ));
        }
        let shrinking = config.max_messages < self.config.max_messages
            || config.retention_days < self.config.retention_days
            || config.disk_quota_mib < self.config.disk_quota_mib;
        if shrinking && !confirmed {
            return Err(RoomError::invalid("减少保留范围前请预览并确认"));
        }
        let old = self.config.clone();
        let mut deleted = 0;
        let result = async {
            // Every deletion and vacuum uses the installed (old) budget. The
            // target is installed only after the physical shrink is feasible.
            deleted += self.delete(Deletion::Retention { config: config.clone(), reserve: 0 }).await?;
            for step in 0..MAINTENANCE_STEPS {
                let pages = self.pages().await?;
                self.maintenance = Some(ChatMaintenance { step, deleted, database_pages: pages, target_pages: config.pages() });
                self.publish(None).await;
                (self.notify)(json!({"topic":"chat_history_changed", "history_revision":self.revision.to_string(), "maintenance":self.maintenance}));
                if pages <= config.pages() {
                    if self.files().await?.saturating_add(pages * PAGE).saturating_add(TRANSACTION_OVERHEAD) > config.quota() { return Err(quota_error()); }
                    self.set_limit(config.pages()).await?;
                    let revision = self.next_revision()?;
                    let mut tx = self.connection.begin().await.map_err(|_| storage())?;
                    sqlx::query("UPDATE settings SET config=?,revision=? WHERE singleton=1")
                        .bind(serde_json::to_string(&config).map_err(|_| storage())?).bind(revision as i64)
                        .execute(&mut *tx).await.map_err(|_| storage())?;
                    tx.commit().await.map_err(|_| storage())?;
                    self.config = config.clone();
                    self.revision = revision;
                    self.history_changed(0);
                    return Ok(());
                }
                let free: i64 = sqlx::query_scalar("PRAGMA freelist_count").fetch_one(&mut self.connection).await.map_err(|_| storage())?;
                if pages.saturating_sub(free.max(0) as u64) > config.pages() {
                    let evicted = self.delete(Deletion::Oldest(256)).await?;
                    deleted += evicted;
                    if evicted == 0 && free == 0 { return Err(quota_error()); }
                }
                self.vacuum(VACUUM_PAGES).await?;
            }
            Err(RoomError::new("chat_quota_exceeded", "本次收缩已达维护步骤上限，请重新预览后继续"))
        }.await;
        self.maintenance = None;
        if let Err(error) = result {
            // Cleanup may have committed even though configuration did not. Its
            // revision and deletion count remain truthful and observable.
            let restored = self.set_limit(old.pages()).await;
            return Err(RoomError::new(
                &error.code,
                format!(
                    "{}；原配置保持；已清理{deleted}条；历史版本{}{}",
                    error.message,
                    self.revision,
                    if restored.is_err() {
                        "；恢复页上限失败"
                    } else {
                        ""
                    }
                ),
            ));
        }
        let mut result = self.stats().await?;
        result["deleted"] = json!(deleted);
        Ok(result)
    }

    async fn admin(&mut self, command: ChatAdmin) -> RoomResult<Value> {
        match command {
            ChatAdmin::Stats => self.stats().await,
            ChatAdmin::Preview { config } => self.preview(&config).await,
            ChatAdmin::Configure {
                config,
                expected_revision,
                confirmed,
            } => self.configure(config, expected_revision, confirmed).await,
            ChatAdmin::Delete { message_id } => {
                let id = message_id
                    .parse::<u64>()
                    .ok()
                    .filter(|v| *v > 0 && *v <= i64::MAX as u64)
                    .ok_or_else(|| RoomError::invalid("消息ID无效"))?;
                let deleted = self.delete(Deletion::Message(id)).await?;
                Ok(json!({"deleted":deleted, "history_revision":self.revision.to_string()}))
            }
            ChatAdmin::Clear { room_id, confirmed } => {
                if !confirmed {
                    return Err(RoomError::invalid("清空聊天历史需要确认"));
                }
                let deleted = self.delete(Deletion::Room(room_id)).await?;
                Ok(json!({"deleted":deleted, "history_revision":self.revision.to_string()}))
            }
        }
    }

    async fn publish(&mut self, error: Option<String>) {
        let measured = async {
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE received>=?")
                .bind(self.config.cutoff(now_ms()))
                .fetch_one(&mut self.connection)
                .await
                .map_err(|_| storage())?;
            Ok::<_, RoomError>((
                count.max(0) as u64 + self.recent.len() as u64,
                self.files().await?,
            ))
        }
        .await;
        let previous = self.status.borrow().clone();
        let (messages, disk_bytes, measurement_error) = match measured {
            Ok((messages, bytes)) => (messages, bytes, None),
            Err(failure) => (
                previous.messages,
                previous.disk_bytes,
                Some(failure.message),
            ),
        };
        let error = error.or(measurement_error);
        self.status.send_replace(ChatStatus {
            available: error.is_none(),
            history_revision: self.revision.to_string(),
            config: self.config.clone(),
            disk_bytes,
            messages,
            error,
            maintenance: self.maintenance.clone(),
        });
    }
}

#[cfg(test)]
#[path = "chat_tests.rs"]
mod tests;
