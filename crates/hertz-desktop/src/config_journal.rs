// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! One active, flushed configuration intent. Recovery observes disk; it never replays a write.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TERMINAL: usize = 256;
const RETENTION_MS: u64 = 10 * 60 * 1000;
const MAX_RECORD_BYTES: usize = 2 * crate::config::MAX_CONFIG_BYTES + 8192;
const TEMP_FILE: &str = ".record.tmp";

#[derive(Debug, thiserror::Error)]
pub(crate) enum JournalError {
    #[error("config_busy: 另一个桌面实例正在核对或提交配置，请稍后重试")]
    Busy,
    #[error("config_conflict: 配置与提交日志均不吻合，文件已保留，请恢复配置后重试")]
    Conflict,
    #[error("request_id_conflict: 相同请求 id 对应另一份配置操作")]
    RequestIdConflict,
    #[error("journal_full: 提交记录达到保留上限，请稍后重试")]
    Full,
}

pub(crate) fn error_code(error: &anyhow::Error, fallback: &'static str) -> &'static str {
    match error.downcast_ref::<JournalError>() {
        Some(JournalError::Busy) => "config_busy",
        Some(JournalError::Conflict) => "config_conflict",
        Some(JournalError::RequestIdConflict) => "request_id_conflict",
        Some(JournalError::Full) => "journal_full",
        None => fallback,
    }
}

/// The GUI mutex serializes one process; this native gate also covers another Windows session
/// using the same per-user directory. Recovery cannot observe an actively replacing writer.
pub(crate) struct FileLock {
    _file: std::fs::File,
}
impl FileLock {
    pub(crate) fn acquire(directory: &Path) -> Result<Self> {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::create_dir_all(directory).context("创建配置提交锁目录")?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .share_mode(0)
            .open(directory.join("config.commit.lock"))
            .map_err(|error| {
                if matches!(error.raw_os_error(), Some(32 | 33)) {
                    anyhow::Error::new(JournalError::Busy)
                } else {
                    anyhow::Error::new(error).context("取得配置提交锁")
                }
            })?;
        Ok(Self { _file: file })
    }
}

#[derive(Clone)]
pub(crate) struct Intent {
    pub request_id: String,
    pub payload_digest: String,
    pub command: String,
    pub caller_sid: String,
}

impl Intent {
    pub(crate) fn internal(payload: &[u8]) -> Result<Self> {
        Ok(Self {
            request_id: format!("config-{}", crate::wallpaper::jobs::new_job_id()),
            payload_digest: digest(payload),
            command: "config.commit".into(),
            caller_sid: caller_sid()?,
        })
    }
}

pub(crate) fn caller_sid() -> Result<String> {
    Ok(hertz_desktop_ipc::windows::Identity::current()?.user_sid)
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum State {
    Pending,
    Committed,
    NotCommitted,
    ConfigConflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    format_version: u32,
    caller_sid: String,
    request_id: String,
    command: String,
    payload_digest: String,
    base_revision: u64,
    base_digest: String,
    target_revision: u64,
    target_config_digest: String,
    candidate_config: Option<String>,
    state: State,
    accepted_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Operation {
    pub request_id: String,
    pub command: String,
    pub state: State,
    pub saved: Option<bool>,
    pub config_revision: Option<u64>,
    pub base_revision: u64,
    pub target_revision: u64,
}

impl Record {
    fn operation(&self) -> Operation {
        Operation {
            request_id: self.request_id.clone(),
            command: self.command.clone(),
            state: self.state,
            saved: match self.state {
                State::Committed => Some(true),
                State::NotCommitted => Some(false),
                State::Pending | State::ConfigConflict => None,
            },
            config_revision: (self.state == State::Committed).then_some(self.target_revision),
            base_revision: self.base_revision,
            target_revision: self.target_revision,
        }
    }
    fn terminal(&self) -> bool {
        matches!(self.state, State::Committed | State::NotCommitted)
    }
    fn file_name(&self) -> String {
        file_name(&self.caller_sid, &self.request_id)
    }
    fn validate(&self) -> Result<()> {
        let bounded = |value: &str, cap| !value.is_empty() && value.len() <= cap;
        let sha256 = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if self.format_version != 1
            || !bounded(&self.caller_sid, 184)
            || !crate::wallpaper::api::valid_id(&self.request_id)
            || !bounded(&self.command, 128)
            || !sha256(&self.payload_digest)
            || !sha256(&self.base_digest)
            || !sha256(&self.target_config_digest)
            || self.base_revision.checked_add(1) != Some(self.target_revision)
        {
            bail!("配置提交记录无效（文件已保留）");
        }
        if let Some(candidate) = &self.candidate_config {
            if candidate.len() > crate::config::MAX_CONFIG_BYTES
                || digest(candidate.as_bytes()) != self.target_config_digest
                || !target_matches(self, candidate.as_bytes())
            {
                bail!("配置提交候选摘要无效（文件已保留）");
            }
        } else if !self.terminal() {
            bail!("活动配置提交缺少候选（文件已保留）");
        }
        Ok(())
    }
}

pub(crate) struct Store {
    directory: PathBuf,
    records: Vec<Record>,
    bytes: u64,
}

impl Store {
    /// Queries remain lazy: an absent operations directory is not created here.
    pub(crate) fn open(config_directory: &Path) -> Result<Self> {
        let directory = config_directory.join("operations");
        let mut store = Self {
            directory,
            records: Vec::new(),
            bytes: 0,
        };
        let entries = match std::fs::read_dir(&store.directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(store),
            Err(error) => return Err(error).context("读取配置提交日志"),
        };
        for (index, entry) in entries.enumerate() {
            if index > MAX_TERMINAL + 2 {
                bail!("配置提交目录超过文件上限（文件已保留）");
            }
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let metadata = entry.metadata()?;
            if !metadata.is_file() {
                bail!("配置提交目录包含非文件条目");
            }
            store.bytes = store.bytes.saturating_add(metadata.len());
            if name == TEMP_FILE {
                continue;
            }
            if !name.starts_with("op-") || !name.ends_with(".json") || name.len() != 72 {
                bail!("配置提交目录包含未知条目（文件已保留）");
            }
            let mut bytes = Vec::new();
            std::fs::File::open(entry.path())?
                .take((MAX_RECORD_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() > MAX_RECORD_BYTES {
                bail!("配置提交记录超过大小上限");
            }
            let record: Record =
                serde_json::from_slice(&bytes).context("解析配置提交记录（文件已保留）")?;
            record.validate()?;
            if record.file_name() != name {
                bail!("配置提交记录身份与文件名不符");
            }
            store.records.push(record);
        }
        if store
            .records
            .iter()
            .filter(|record| !record.terminal())
            .count()
            > 1
        {
            bail!(JournalError::Conflict);
        }
        Ok(store)
    }

    /// Resolve the sole interrupted operation before migration or accepting another write.
    pub(crate) fn reconcile(&mut self, config_directory: &Path) -> Result<()> {
        let Some(index) = self.records.iter().position(|record| !record.terminal()) else {
            return Ok(());
        };
        let bytes = match crate::config::read_bounded(&config_directory.join("config.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error).context("核对提交时读取配置失败"),
        };
        let record = &self.records[index];
        let state =
            if digest(&bytes) == record.target_config_digest && target_matches(record, &bytes) {
                State::Committed
            } else if digest(&bytes) == record.base_digest
                && revision(&bytes) == Some(record.base_revision)
            {
                State::NotCommitted
            } else {
                State::ConfigConflict
            };
        if state == State::ConfigConflict && record.state == State::ConfigConflict {
            return Ok(());
        }
        let mut resolved = record.clone();
        resolved.state = state;
        resolved.updated_at = now_ms();
        if resolved.terminal() {
            resolved.candidate_config = None;
        }
        self.write_record(&resolved)?;
        self.records[index] = resolved;
        Ok(())
    }

    pub(crate) fn blocked(&self) -> bool {
        self.records.iter().any(|record| !record.terminal())
    }

    pub(crate) fn lookup(&self, sid: &str, request_id: &str) -> Option<Operation> {
        self.records
            .iter()
            .find(|r| r.caller_sid == sid && r.request_id == request_id)
            .map(Record::operation)
    }

    pub(crate) fn replay(&self, intent: &Intent) -> Result<Option<Operation>> {
        let Some(record) = self
            .records
            .iter()
            .find(|r| r.caller_sid == intent.caller_sid && r.request_id == intent.request_id)
        else {
            return Ok(None);
        };
        if record.command != intent.command || record.payload_digest != intent.payload_digest {
            bail!(JournalError::RequestIdConflict);
        }
        Ok(Some(record.operation()))
    }

    pub(crate) fn prepare(&mut self, intent: &Intent, base: &[u8], target: &[u8]) -> Result<()> {
        if self.blocked() {
            bail!(JournalError::Conflict);
        }
        let base_revision = revision(base).context("缺少配置基线 revision")?;
        let record = Record {
            format_version: 1,
            caller_sid: intent.caller_sid.clone(),
            request_id: intent.request_id.clone(),
            command: intent.command.clone(),
            payload_digest: intent.payload_digest.clone(),
            base_revision,
            base_digest: digest(base),
            target_revision: revision(target).context("缺少配置候选 revision")?,
            target_config_digest: digest(target),
            candidate_config: Some(std::str::from_utf8(target)?.into()),
            state: State::Pending,
            accepted_at: now_ms(),
            updated_at: now_ms(),
        };
        record.validate()?;
        // Space for both the accepted intent and its atomic replacement; never evict protected records.
        self.prune(now_ms())?;
        let needed = serde_json::to_vec(&record)?.len() as u64;
        if self.records.len() >= MAX_TERMINAL
            || self.bytes.saturating_add(needed.saturating_mul(2)) > MAX_BYTES
        {
            bail!(JournalError::Full);
        }
        self.write_record(&record)?;
        self.records.push(record);
        Ok(())
    }

    pub(crate) fn finish(&mut self, sid: &str, request_id: &str, saved: bool) -> Result<Operation> {
        let index = self
            .records
            .iter()
            .position(|r| r.caller_sid == sid && r.request_id == request_id)
            .context("提交记录缺失")?;
        let mut record = self.records[index].clone();
        record.state = if saved {
            State::Committed
        } else {
            State::NotCommitted
        };
        record.candidate_config = None;
        record.updated_at = now_ms();
        self.write_record(&record)?;
        let operation = record.operation();
        self.records[index] = record;
        Ok(operation)
    }

    fn prune(&mut self, now: u64) -> Result<()> {
        let mut kept = Vec::with_capacity(self.records.len());
        for record in &self.records {
            if record.terminal() && now.saturating_sub(record.updated_at) >= RETENTION_MS {
                let path = self.directory.join(record.file_name());
                let len = path.metadata()?.len();
                std::fs::remove_file(path).context("清理过期配置提交记录")?;
                self.bytes = self.bytes.saturating_sub(len);
            } else {
                kept.push(record.clone());
            }
        }
        self.records = kept;
        // An unrenamed, flushed temporary record never authorized replacing config. Pending records
        // remain in their final names and have already been reconciled above.
        let temp = self.directory.join(TEMP_FILE);
        match temp.metadata() {
            Ok(meta) => {
                std::fs::remove_file(temp)?;
                self.bytes = self.bytes.saturating_sub(meta.len());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    fn write_record(&mut self, record: &Record) -> Result<()> {
        let bytes = serde_json::to_vec(record)?;
        if bytes.len() > MAX_RECORD_BYTES {
            bail!(JournalError::Full);
        }
        std::fs::create_dir_all(&self.directory).context("创建配置提交日志目录")?;
        let path = self.directory.join(record.file_name());
        let old = path.metadata().map_or(0, |meta| meta.len());
        let temp = self.directory.join(TEMP_FILE);
        // The configuration lock serializes all journal writers, including recovery and queries.
        let result = (|| -> Result<()> {
            let mut file = std::fs::File::create(&temp).context("创建提交日志临时文件")?;
            file.write_all(&bytes).context("写入配置提交意图")?;
            file.sync_all().context("刷新配置提交意图")?;
            drop(file);
            crate::native::replace_file(&temp, &path).context("原子替换配置提交记录")?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result?;
        self.bytes = self
            .bytes
            .saturating_sub(old)
            .saturating_add(bytes.len() as u64);
        Ok(())
    }
}

fn file_name(sid: &str, request_id: &str) -> String {
    format!(
        "op-{}.json",
        digest(format!("{sid}\0{request_id}").as_bytes())
    )
}
fn revision(bytes: &[u8]) -> Option<u64> {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()?
        .get("revision")?
        .as_u64()
}
fn target_matches(record: &Record, bytes: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return false;
    };
    value["revision"].as_u64() == Some(record.target_revision)
        && value["lastCommit"]["requestId"].as_str() == Some(&record.request_id)
        && value["lastCommit"]["payloadDigest"].as_str() == Some(&record.payload_digest)
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::library::tempfileish;
    use serde_json::json;

    fn intent(id: &str) -> Intent {
        Intent {
            request_id: id.into(),
            payload_digest: digest(id.as_bytes()),
            command: "wallpaper.apply".into(),
            caller_sid: "S-1-5-21-test".into(),
        }
    }
    fn candidate(intent: &Intent, revision: u64) -> Vec<u8> {
        serde_json::to_vec(&json!({"revision":revision,"lastCommit":{"requestId":intent.request_id,"payloadDigest":intent.payload_digest},"data":"new"})).unwrap()
    }
    fn base() -> Vec<u8> {
        serde_json::to_vec(&json!({"revision":4,"lastCommit":null,"data":"old"})).unwrap()
    }

    #[test]
    fn crash_before_replace_is_not_committed_and_never_replays_the_candidate() {
        let dir = tempfileish::temp_dir("journal-before");
        let base = base();
        let intent = intent("before");
        let target = candidate(&intent, 5);
        std::fs::write(dir.path().join("config.json"), &base).unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        store.prepare(&intent, &base, &target).unwrap();
        drop(store);
        let mut recovered = Store::open(dir.path()).unwrap();
        recovered.reconcile(dir.path()).unwrap();
        let operation = recovered
            .lookup(&intent.caller_sid, &intent.request_id)
            .unwrap();
        assert_eq!(operation.state, State::NotCommitted);
        assert_eq!(operation.saved, Some(false));
        assert_eq!(std::fs::read(dir.path().join("config.json")).unwrap(), base);
        assert!(!recovered.blocked());
        assert!(recovered.replay(&intent).unwrap().is_some());
        assert!(Store::open(dir.path()).unwrap().records[0]
            .candidate_config
            .is_none());
    }

    #[test]
    fn crash_after_replace_recovers_original_revision_and_preserves_later_commits() {
        let dir = tempfileish::temp_dir("journal-after");
        let base = base();
        let intent = intent("after");
        let target = candidate(&intent, 5);
        let mut store = Store::open(dir.path()).unwrap();
        store.prepare(&intent, &base, &target).unwrap();
        std::fs::write(dir.path().join("config.json"), &target).unwrap();
        drop(store);
        let mut recovered = Store::open(dir.path()).unwrap();
        recovered.reconcile(dir.path()).unwrap();
        let operation = recovered.replay(&intent).unwrap().unwrap();
        assert_eq!(operation.state, State::Committed);
        assert_eq!(operation.config_revision, Some(5));
        assert_eq!(operation.saved, Some(true));
        std::fs::write(
            dir.path().join("config.json"),
            candidate(&super::tests::intent("later"), 6),
        )
        .unwrap();
        let mut again = Store::open(dir.path()).unwrap();
        again.reconcile(dir.path()).unwrap();
        assert_eq!(
            again.replay(&intent).unwrap().unwrap().config_revision,
            Some(5)
        );
        let mut changed = intent.clone();
        changed.payload_digest = digest(b"changed");
        assert!(again.replay(&changed).unwrap_err().is::<JournalError>());
        changed = intent.clone();
        changed.command = "other".into();
        assert!(again.replay(&changed).is_err());
        assert!(again.lookup("another SID", &intent.request_id).is_none());
    }

    #[test]
    fn conflicting_config_blocks_new_writes_and_preserves_files_until_manually_restored() {
        let dir = tempfileish::temp_dir("journal-conflict");
        let intent = intent("conflict");
        let target = candidate(&intent, 5);
        let mut store = Store::open(dir.path()).unwrap();
        store.prepare(&intent, &base(), &target).unwrap();
        let foreign = b"{\"revision\":19,\"lastCommit\":null}";
        std::fs::write(dir.path().join("config.json"), foreign).unwrap();
        let mut recovered = Store::open(dir.path()).unwrap();
        recovered.reconcile(dir.path()).unwrap();
        assert!(recovered.blocked());
        assert_eq!(
            recovered
                .lookup(&intent.caller_sid, &intent.request_id)
                .unwrap()
                .state,
            State::ConfigConflict
        );
        let other = super::tests::intent("other");
        assert!(recovered
            .prepare(&other, foreign, &candidate(&other, 20))
            .is_err());
        assert_eq!(
            std::fs::read(dir.path().join("config.json")).unwrap(),
            foreign
        );
        assert_eq!(Store::open(dir.path()).unwrap().records.len(), 1);
        std::fs::write(dir.path().join("config.json"), &target).unwrap();
        recovered.reconcile(dir.path()).unwrap();
        assert!(!recovered.blocked());
        assert_eq!(
            recovered
                .lookup(&intent.caller_sid, &intent.request_id)
                .unwrap()
                .saved,
            Some(true)
        );
    }

    #[test]
    fn last_commit_and_full_digest_must_both_match() {
        let dir = tempfileish::temp_dir("journal-digest");
        let intent = intent("digest");
        let target = candidate(&intent, 5);
        let mut store = Store::open(dir.path()).unwrap();
        store.prepare(&intent, &base(), &target).unwrap();
        let mut forged: serde_json::Value = serde_json::from_slice(&target).unwrap();
        forged["data"] = json!("changed after replace");
        std::fs::write(
            dir.path().join("config.json"),
            serde_json::to_vec(&forged).unwrap(),
        )
        .unwrap();
        store.reconcile(dir.path()).unwrap();
        assert!(store.blocked());
        assert_eq!(store.records[0].state, State::ConfigConflict);
    }

    #[test]
    fn capacity_preserves_ten_minutes_and_expired_operations_become_unknown() {
        let dir = tempfileish::temp_dir("journal-retention");
        let mut store = Store::open(dir.path()).unwrap();
        let first = intent("retained");
        store
            .prepare(&first, &base(), &candidate(&first, 5))
            .unwrap();
        store
            .finish(&first.caller_sid, &first.request_id, true)
            .unwrap();
        let template = store.records[0].clone();
        for index in 1..MAX_TERMINAL {
            let mut record = template.clone();
            record.request_id = format!("op-{index}");
            store.write_record(&record).unwrap();
            store.records.push(record);
        }
        let mut full = Store::open(dir.path()).unwrap();
        let next = intent("next");
        assert!(full
            .prepare(&next, &base(), &candidate(&next, 5))
            .unwrap_err()
            .is::<JournalError>());
        assert_eq!(full.records.len(), MAX_TERMINAL);
        full.prune(template.updated_at + RETENTION_MS - 1).unwrap();
        assert_eq!(full.records.len(), MAX_TERMINAL);
        full.prune(template.updated_at + RETENTION_MS).unwrap();
        assert!(full.lookup(&first.caller_sid, &first.request_id).is_none());
        full.prepare(&next, &base(), &candidate(&next, 5)).unwrap();
    }

    #[test]
    fn failed_final_receipt_keeps_the_single_active_barrier_until_recovery() {
        let dir = tempfileish::temp_dir("journal-final-receipt");
        let intent = intent("pending-receipt");
        let target = candidate(&intent, 5);
        let mut store = Store::open(dir.path()).unwrap();
        store.prepare(&intent, &base(), &target).unwrap();
        std::fs::write(dir.path().join("config.json"), &target).unwrap();
        let blocked_temp = store.directory.join(TEMP_FILE);
        std::fs::create_dir(&blocked_temp).unwrap();
        assert!(store
            .finish(&intent.caller_sid, &intent.request_id, true)
            .is_err());
        assert!(store.blocked());
        let next = super::tests::intent("must-wait");
        assert!(store.prepare(&next, &target, &candidate(&next, 6)).is_err());
        assert_eq!(
            store
                .lookup(&intent.caller_sid, &intent.request_id)
                .unwrap()
                .state,
            State::Pending
        );
        std::fs::remove_dir(blocked_temp).unwrap();
        let mut recovered = Store::open(dir.path()).unwrap();
        recovered.reconcile(dir.path()).unwrap();
        assert_eq!(
            recovered.replay(&intent).unwrap().unwrap().config_revision,
            Some(5)
        );
        recovered
            .prepare(&next, &target, &candidate(&next, 6))
            .unwrap();
    }

    #[test]
    fn native_configuration_gate_blocks_another_open_until_the_owner_exits() {
        let dir = tempfileish::temp_dir("config-native-lock");
        let owner = FileLock::acquire(dir.path()).unwrap();
        let other = FileLock::acquire(dir.path());
        assert!(matches!(
            other.err().unwrap().downcast_ref::<JournalError>(),
            Some(JournalError::Busy)
        ));
        drop(owner);
        assert!(FileLock::acquire(dir.path()).is_ok());
    }

    #[test]
    fn corrupt_journal_is_preserved_and_absent_query_creates_nothing() {
        let dir = tempfileish::temp_dir("journal-corrupt");
        assert!(Store::open(dir.path()).unwrap().records.is_empty());
        assert!(!dir.path().join("operations").exists());
        let intent = intent("corrupt");
        let mut store = Store::open(dir.path()).unwrap();
        store
            .prepare(&intent, &base(), &candidate(&intent, 5))
            .unwrap();
        let path = store.directory.join(store.records[0].file_name());
        std::fs::write(&path, b"broken").unwrap();
        assert!(Store::open(dir.path()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"broken");
    }
}
