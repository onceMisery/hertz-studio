// SPDX-License-Identifier: MIT
//! Fixed-version storage and a renderable-time clock. No controller or Config writes.
use super::{jobs::JobError, library::Library};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::time::{Duration, Instant};
type Result<T> = std::result::Result<T, JobError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FixedVersion {
    pub work_key: String,
    pub package_hash: String,
}
impl FixedVersion {
    pub(crate) fn matches(&self, work: Option<&str>, hash: Option<&str>) -> bool {
        work.is_some_and(|work| work == self.work_key)
            || hash.is_some_and(|hash| hash == self.package_hash)
    }
    pub(crate) fn selection(&self) -> super::config::Selection {
        super::config::Selection::Package {
            work_key: self.work_key.clone(),
            package_hash: self.package_hash.clone(),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Mode {
    Sequential,
    Random,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Playlist {
    pub playlist_id: String,
    pub revision: u64,
    pub title: String,
    pub mode: Mode,
    pub interval_seconds: u32,
    pub items: Vec<FixedVersion>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub playlists: Vec<serde_json::Value>,
    pub next_cursor: Option<String>,
}
pub(crate) struct Repository<'a> {
    library: &'a Library,
}
impl<'a> Repository<'a> {
    pub(crate) fn new(library: &'a Library) -> Self {
        Self { library }
    }
    pub(crate) async fn get(&self, id: &str) -> Result<Playlist> {
        let mut tx = self.library.pool().begin().await.map_err(db)?;
        let row = sqlx::query("SELECT * FROM playlists WHERE playlist_id=?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or_else(|| JobError::new("playlist_not_found", "轮播列表不存在"))?;
        let items = sqlx::query("SELECT work_key,package_hash FROM playlist_items WHERE playlist_id=? ORDER BY position")
            .bind(id).fetch_all(&mut *tx).await.map_err(db)?.into_iter().map(|row| FixedVersion { work_key: row.get("work_key"), package_hash: row.get("package_hash") }).collect();
        let playlist = Playlist {
            playlist_id: id.into(),
            revision: row.get::<i64, _>("revision") as u64,
            title: row.get("title"),
            mode: if row.get::<String, _>("mode") == "random" {
                Mode::Random
            } else {
                Mode::Sequential
            },
            interval_seconds: row.get::<i64, _>("interval_seconds") as u32,
            items,
        };
        tx.commit().await.map_err(db)?;
        validate(&playlist.title, playlist.interval_seconds, &playlist.items)?;
        Ok(playlist)
    }
    // Caller holds the same content writer used by package removal.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn save(
        &self,
        id: Option<&str>,
        revision: Option<u64>,
        title: String,
        mode: Mode,
        interval: u32,
        items: Vec<FixedVersion>,
    ) -> Result<Playlist> {
        validate(&title, interval, &items)?;
        if id.is_some() != revision.is_some() || id.is_some_and(|id| !super::api::valid_id(id)) {
            return Err(JobError::invalid_input("修改列表需要原列表修订号"));
        }
        let mut tx = self
            .library
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        let next = revision
            .unwrap_or(0)
            .checked_add(1)
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or_else(conflict)?;
        let id = match id {
            Some(id) => id.to_string(),
            None => format!("playlist-{}", super::jobs::new_job_id()),
        };
        if let Some(revision) = revision {
            let result = sqlx::query("UPDATE playlists SET revision=?,title=?,mode=?,interval_seconds=?,updated_at=? WHERE playlist_id=? AND revision=?")
                .bind(next as i64).bind(&title).bind(mode_name(mode)).bind(interval).bind(super::library::now_secs()).bind(&id).bind(revision as i64).execute(&mut *tx).await.map_err(db)?;
            if result.rows_affected() != 1 {
                return Err(conflict());
            }
        } else {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM playlists")
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
            if count >= 100 {
                return Err(JobError::new("playlist_limit", "最多保存100个轮播列表"));
            }
            sqlx::query("INSERT INTO playlists VALUES(?,?,?,?,?,?)")
                .bind(&id)
                .bind(1_i64)
                .bind(&title)
                .bind(mode_name(mode))
                .bind(interval)
                .bind(super::library::now_secs())
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        sqlx::query("DELETE FROM playlist_items WHERE playlist_id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        for (position, item) in items.iter().enumerate() {
            let version: Option<String> = sqlx::query_scalar("SELECT v.version_key FROM versions v JOIN packages p USING(package_hash) WHERE v.work_key=? AND v.package_hash=? AND p.state='installed'")
                .bind(&item.work_key).bind(&item.package_hash).fetch_optional(&mut *tx).await.map_err(db)?;
            let version = version.ok_or_else(|| {
                JobError::new("version_not_found", "列表包含未安装或不匹配的固定版本")
            })?;
            sqlx::query("INSERT INTO playlist_items VALUES(?,?,?,?,?)")
                .bind(&id)
                .bind(position as i64)
                .bind(&item.work_key)
                .bind(&item.package_hash)
                .bind(version)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(Playlist {
            playlist_id: id,
            revision: next,
            title,
            mode,
            interval_seconds: interval,
            items,
        })
    }
    pub(crate) async fn list(&self, limit: u32, cursor: Option<&str>) -> Result<Page> {
        let limit = limit.clamp(1, 20) as usize;
        let rows = sqlx::query("SELECT p.*, (SELECT count(*) FROM playlist_items i WHERE i.playlist_id=p.playlist_id) AS item_count FROM playlists p WHERE (? IS NULL OR playlist_id>?) ORDER BY playlist_id LIMIT ?")
            .bind(cursor).bind(cursor).bind((limit+1) as i64).fetch_all(self.library.pool()).await.map_err(db)?;
        let more = rows.len() > limit;
        let playlists: Vec<_> = rows.into_iter().take(limit).map(|row| serde_json::json!({"playlistId":row.get::<String,_>("playlist_id"),"revision":row.get::<i64,_>("revision"),"title":row.get::<String,_>("title"),"mode":row.get::<String,_>("mode"),"intervalSeconds":row.get::<i64,_>("interval_seconds"),"itemCount":row.get::<i64,_>("item_count")})).collect();
        let next_cursor = more.then(|| {
            playlists.last().unwrap()["playlistId"]
                .as_str()
                .unwrap()
                .to_string()
        });
        Ok(Page {
            playlists,
            next_cursor,
        })
    }
    #[cfg(test)]
    pub(crate) async fn references(&self, work: Option<&str>, hash: Option<&str>) -> Result<bool> {
        let found: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM playlist_items WHERE work_key=? OR package_hash=?)",
        )
        .bind(work)
        .bind(hash)
        .fetch_one(self.library.pool())
        .await
        .map_err(db)?;
        Ok(found != 0)
    }
}
fn validate(title: &str, interval: u32, items: &[FixedVersion]) -> Result<()> {
    if title.trim().is_empty()
        || title.chars().count() > 120
        || title.chars().any(char::is_control)
        || !(10..=86400).contains(&interval)
        || items.is_empty()
        || items.len() > 32
        || items.iter().any(|item| {
            !super::api::valid_id(&item.work_key)
                || !hertz_wallpaper::valid_sha256_hex(&item.package_hash)
        })
    {
        return Err(JobError::invalid_input(
            "列表需要有效标题、1–32个固定版本和10–86400秒间隔",
        ));
    }
    Ok(())
}
fn mode_name(mode: Mode) -> &'static str {
    if mode == Mode::Random {
        "random"
    } else {
        "sequential"
    }
}
fn db(error: impl std::fmt::Display) -> JobError {
    JobError::database(error.to_string())
}
fn conflict() -> JobError {
    JobError::new("playlist_conflict", "轮播列表修订已变化，请重新读取")
}

#[derive(Debug, Clone)]
pub(crate) struct Switch {
    pub index: usize,
    pub token: u64,
    pub reference: FixedVersion,
}
pub(crate) struct Runner {
    playlist: Playlist,
    current: Option<usize>,
    pending: Option<Switch>,
    failed: Option<usize>,
    elapsed: Duration,
    last: Option<(Instant, bool)>,
    sequence: u64,
    rng: u64,
}
impl Runner {
    pub(crate) fn new(playlist: Playlist, seed: u64) -> Result<Self> {
        validate(&playlist.title, playlist.interval_seconds, &playlist.items)?;
        Ok(Self {
            playlist,
            current: None,
            pending: None,
            failed: None,
            elapsed: Duration::ZERO,
            last: None,
            sequence: 0,
            rng: seed.max(1),
        })
    }
    pub(crate) fn playlist(&self) -> &Playlist {
        &self.playlist
    }
    pub(crate) fn current(&self) -> Option<&FixedVersion> {
        self.current.map(|i| &self.playlist.items[i])
    }
    pub(crate) fn current_index(&self) -> Option<usize> {
        self.current
    }
    pub(crate) fn pending(&self) -> Option<&Switch> {
        self.pending.as_ref()
    }
    pub(crate) fn pending_fixed(&self) -> Option<&FixedVersion> {
        self.pending.as_ref().map(|v| &v.reference)
    }
    pub(crate) fn is_failed(&self) -> bool {
        self.failed.is_some()
    }
    fn start(&mut self, index: usize) -> Switch {
        self.sequence = self.sequence.wrapping_add(1);
        let switch = Switch {
            index,
            token: self.sequence,
            reference: self.playlist.items[index].clone(),
        };
        self.pending = Some(switch.clone());
        self.last = None;
        switch
    }
    pub(crate) fn initial(&mut self) -> Option<Switch> {
        if self.current.is_none() && self.pending.is_none() && self.failed.is_none() {
            Some(self.start(0))
        } else {
            None
        }
    }
    pub(crate) fn next(&mut self) -> Result<Switch> {
        if self.pending.is_some() {
            return Err(JobError::new("budget_busy", "已有轮播切换正在进行"));
        }
        if self.failed.is_some() {
            return Err(JobError::new("playlist_failed", "轮播已停止，请重试失败项"));
        }
        let count = self.playlist.items.len();
        let index = match (self.current, self.playlist.mode) {
            (None, _) => 0,
            (Some(current), Mode::Sequential) => (current + 1) % count,
            (Some(current), Mode::Random) if count > 1 => {
                self.rng ^= self.rng << 13;
                self.rng ^= self.rng >> 7;
                self.rng ^= self.rng << 17;
                (current + 1 + (self.rng as usize % (count - 1))) % count
            }
            _ => 0,
        };
        Ok(self.start(index))
    }
    pub(crate) fn retry(&mut self) -> Result<Switch> {
        if self.pending.is_some() {
            return Err(JobError::new("budget_busy", "已有轮播切换正在进行"));
        }
        let index = self
            .failed
            .take()
            .ok_or_else(|| JobError::new("playlist_not_failed", "没有失败的轮播项目"))?;
        Ok(self.start(index))
    }
    pub(crate) fn fail(&mut self, token: u64) -> bool {
        if self.pending.as_ref().is_none_or(|v| v.token != token) {
            return false;
        }
        self.failed = self.pending.take().map(|v| v.index);
        self.last = None;
        true
    }
    /// A renderer can fail after its switch was already presented. Keep that
    /// exact item as the retry target without replacing a pending switch's error.
    pub(crate) fn fail_current(&mut self) -> bool {
        if self.pending.is_some() || self.failed.is_some() {
            return false;
        }
        let Some(current) = self.current else {
            return false;
        };
        self.failed = Some(current);
        self.last = None;
        true
    }
    pub(crate) fn presented(&mut self, token: u64) -> bool {
        if self.pending.as_ref().is_none_or(|v| v.token != token) {
            return false;
        }
        self.current = self.pending.take().map(|v| v.index);
        self.elapsed = Duration::ZERO;
        self.last = None;
        self.failed = None;
        true
    }
    pub(crate) fn tick(&mut self, now: Instant, renderable: bool) -> Option<Switch> {
        let previous = self.last.replace((now, renderable));
        if self.pending.is_some() || self.failed.is_some() || self.current.is_none() {
            return None;
        }
        if let Some((at, true)) = previous.filter(|_| renderable) {
            self.elapsed = self
                .elapsed
                .saturating_add(now.saturating_duration_since(at));
        }
        if renderable
            && self.elapsed >= Duration::from_secs(u64::from(self.playlist.interval_seconds))
        {
            self.next().ok()
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::library::{tempfileish, InstallWork, LOCAL_SOURCE};
    use super::*;
    use serde_json::json;

    fn reference(work: &str, hash: u8) -> FixedVersion {
        FixedVersion {
            work_key: work.into(),
            package_hash: format!("{hash:064x}"),
        }
    }

    async fn install(library: &Library, item: &FixedVersion, version: u32) {
        library
            .install(&InstallWork {
                remote_work_id: format!("author-{}", item.work_key),
                work_key: item.work_key.clone(),
                title: "固定版本测试".into(),
                description: String::new(),
                kind: "builtin".into(),
                package_hash: item.package_hash.clone(),
                manifest_json: json!({"fixture": item.package_hash}).to_string(),
                package_bytes: 70,
                version,
                source_id: LOCAL_SOURCE.into(),
            })
            .await
            .unwrap();
    }

    fn playlist(mode: Mode, interval_seconds: u32, count: usize) -> Playlist {
        Playlist {
            playlist_id: "playlist-test".into(),
            revision: 1,
            title: "固定版本轮播".into(),
            mode,
            interval_seconds,
            items: (0..count)
                .map(|i| reference(&format!("work-{i}"), i as u8))
                .collect(),
        }
    }

    fn running(mode: Mode, interval: u32, count: usize) -> Runner {
        let mut runner = Runner::new(playlist(mode, interval, count), 37).unwrap();
        let initial = runner.initial().unwrap();
        assert_eq!(initial.index, 0);
        assert!(runner.presented(initial.token));
        runner
    }

    #[tokio::test]
    async fn storage_reopens_fixed_versions_and_keeps_order_after_new_versions_arrive() {
        let root = tempfileish::temp_dir("playlist-reopen");
        let library = Library::open(root.path()).await.unwrap();
        let first = reference("first", 1);
        let second = reference("second", 2);
        install(&library, &first, 1).await;
        install(&library, &second, 1).await;
        let repository = Repository::new(&library);
        let saved = repository
            .save(
                None,
                None,
                "顺序与版本".into(),
                Mode::Random,
                86400,
                vec![second.clone(), first.clone(), second.clone()],
            )
            .await
            .unwrap();
        let latest = reference("first", 3);
        install(&library, &latest, 2).await;
        let unchanged = repository.get(&saved.playlist_id).await.unwrap();
        assert_eq!(unchanged.items, saved.items);
        assert_eq!(unchanged.revision, 1);
        library.pool().close().await;
        let reopened = Library::open(root.path()).await.unwrap();
        let repository = Repository::new(&reopened);
        let restored = repository.get(&saved.playlist_id).await.unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap(),
            serde_json::to_value(saved).unwrap()
        );
        assert!(repository.references(Some("first"), None).await.unwrap());
        assert!(repository
            .references(None, Some(&first.package_hash))
            .await
            .unwrap());
        assert!(!repository
            .references(None, Some(&latest.package_hash))
            .await
            .unwrap());
        assert!(!repository.references(None, None).await.unwrap());
        reopened.pool().close().await;
    }

    #[tokio::test]
    async fn save_rejects_mismatched_unavailable_and_missing_versions_without_partial_changes() {
        let root = tempfileish::temp_dir("playlist-versions");
        let library = Library::open(root.path()).await.unwrap();
        let first = reference("first", 4);
        let second = reference("second", 5);
        install(&library, &first, 1).await;
        install(&library, &second, 1).await;
        let repository = Repository::new(&library);
        let saved = repository
            .save(
                None,
                None,
                "保留的列表".into(),
                Mode::Sequential,
                10,
                vec![first.clone()],
            )
            .await
            .unwrap();
        let wrong_owner = FixedVersion {
            work_key: first.work_key.clone(),
            package_hash: second.package_hash.clone(),
        };
        let unknown_hash = reference("first", 6);
        let unknown_work = FixedVersion {
            work_key: "missing".into(),
            package_hash: first.package_hash.clone(),
        };
        for invalid in [wrong_owner, unknown_hash, unknown_work] {
            let error = repository
                .save(
                    Some(&saved.playlist_id),
                    Some(1),
                    "不能留下的新标题".into(),
                    Mode::Random,
                    11,
                    vec![second.clone(), invalid],
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "version_not_found");
            assert_eq!(
                serde_json::to_value(repository.get(&saved.playlist_id).await.unwrap()).unwrap(),
                serde_json::to_value(&saved).unwrap()
            );
        }
        library
            .mark_unavailable(&second.package_hash)
            .await
            .unwrap();
        assert_eq!(
            repository
                .save(
                    None,
                    None,
                    "不可用".into(),
                    Mode::Sequential,
                    10,
                    vec![second.clone()]
                )
                .await
                .unwrap_err()
                .code,
            "version_not_found"
        );
        assert_eq!(repository.list(20, None).await.unwrap().playlists.len(), 1);
        // Becoming unavailable must not erase a saved GC root or fixed selection.
        library.mark_unavailable(&first.package_hash).await.unwrap();
        assert_eq!(
            repository.get(&saved.playlist_id).await.unwrap().items,
            vec![first.clone()]
        );
        assert!(repository
            .references(None, Some(&first.package_hash))
            .await
            .unwrap());
        library.pool().close().await;
    }

    #[tokio::test]
    async fn independent_connections_compare_and_swap_one_revision() {
        let root = tempfileish::temp_dir("playlist-cas");
        let first_library = Library::open(root.path()).await.unwrap();
        let second_library = Library::open(root.path()).await.unwrap();
        let first = reference("first", 7);
        let second = reference("second", 8);
        install(&first_library, &first, 1).await;
        install(&first_library, &second, 1).await;
        let a = Repository::new(&first_library);
        let b = Repository::new(&second_library);
        let original = a
            .save(
                None,
                None,
                "初始".into(),
                Mode::Sequential,
                10,
                vec![first.clone()],
            )
            .await
            .unwrap();
        let (left, right) = tokio::join!(
            a.save(
                Some(&original.playlist_id),
                Some(1),
                "窗口甲".into(),
                Mode::Random,
                20,
                vec![second.clone()]
            ),
            b.save(
                Some(&original.playlist_id),
                Some(1),
                "窗口乙".into(),
                Mode::Sequential,
                30,
                vec![first.clone(), second.clone()]
            )
        );
        assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
        let (winner, loser) = if let Ok(winner) = left {
            (winner, right.unwrap_err())
        } else {
            (right.unwrap(), left.unwrap_err())
        };
        assert_eq!(loser.code, "playlist_conflict");
        assert_eq!(winner.revision, 2);
        assert_eq!(
            serde_json::to_value(b.get(&original.playlist_id).await.unwrap()).unwrap(),
            serde_json::to_value(&winner).unwrap()
        );
        assert_eq!(
            a.save(
                Some(&original.playlist_id),
                Some(1),
                "过期重放".into(),
                Mode::Sequential,
                10,
                vec![first.clone()]
            )
            .await
            .unwrap_err()
            .code,
            "playlist_conflict"
        );
        assert_eq!(
            a.save(
                Some("unknown"),
                Some(1),
                "不存在".into(),
                Mode::Sequential,
                10,
                vec![first.clone()]
            )
            .await
            .unwrap_err()
            .code,
            "playlist_conflict"
        );
        for revision in [i64::MAX as u64, u64::MAX] {
            assert_eq!(
                a.save(
                    Some(&original.playlist_id),
                    Some(revision),
                    "溢出".into(),
                    Mode::Sequential,
                    10,
                    vec![first.clone()]
                )
                .await
                .unwrap_err()
                .code,
                "playlist_conflict"
            );
        }
        first_library.pool().close().await;
        second_library.pool().close().await;
    }

    #[tokio::test]
    async fn replacing_items_releases_only_old_references_and_foreign_keys_protect_current_ones() {
        let root = tempfileish::temp_dir("playlist-references");
        let library = Library::open(root.path()).await.unwrap();
        let first = reference("first", 9);
        let second = reference("second", 10);
        install(&library, &first, 1).await;
        install(&library, &second, 1).await;
        let repository = Repository::new(&library);
        let saved = repository
            .save(
                None,
                None,
                "引用保护".into(),
                Mode::Sequential,
                10,
                vec![first.clone()],
            )
            .await
            .unwrap();
        assert!(repository
            .references(Some(&first.work_key), None)
            .await
            .unwrap());
        assert!(repository
            .references(None, Some(&first.package_hash))
            .await
            .unwrap());
        let delete = sqlx::query("DELETE FROM versions WHERE work_key=? AND package_hash=?")
            .bind(&first.work_key)
            .bind(&first.package_hash)
            .execute(library.pool())
            .await;
        assert!(
            delete.is_err(),
            "a persisted item must restrict deleting its exact version"
        );
        assert!(library
            .contains_version(&first.work_key, &first.package_hash)
            .await
            .unwrap());
        repository
            .save(
                Some(&saved.playlist_id),
                Some(1),
                "引用已更换".into(),
                Mode::Sequential,
                10,
                vec![second.clone()],
            )
            .await
            .unwrap();
        assert!(!repository
            .references(Some(&first.work_key), None)
            .await
            .unwrap());
        assert!(!repository
            .references(None, Some(&first.package_hash))
            .await
            .unwrap());
        assert!(repository
            .references(Some(&second.work_key), None)
            .await
            .unwrap());
        let delete = sqlx::query("DELETE FROM versions WHERE work_key=? AND package_hash=?")
            .bind(&first.work_key)
            .bind(&first.package_hash)
            .execute(library.pool())
            .await
            .unwrap();
        assert_eq!(delete.rows_affected(), 1);
        library.pool().close().await;
    }

    #[tokio::test]
    async fn storage_enforces_interval_item_and_list_limits_and_pages_without_skips() {
        let root = tempfileish::temp_dir("playlist-limits");
        let library = Library::open(root.path()).await.unwrap();
        let item = reference("item", 11);
        install(&library, &item, 1).await;
        let repository = Repository::new(&library);
        for interval in [0, 9, 86401, u32::MAX] {
            assert_eq!(
                repository
                    .save(
                        None,
                        None,
                        "错误间隔".into(),
                        Mode::Sequential,
                        interval,
                        vec![item.clone()]
                    )
                    .await
                    .unwrap_err()
                    .code,
                "invalid_input"
            );
        }
        for items in [vec![], vec![item.clone(); 33]] {
            assert_eq!(
                repository
                    .save(None, None, "错误数量".into(), Mode::Sequential, 10, items)
                    .await
                    .unwrap_err()
                    .code,
                "invalid_input"
            );
        }
        for title in [
            String::new(),
            "  ".into(),
            "错误\n标题".into(),
            "长".repeat(121),
        ] {
            assert_eq!(
                repository
                    .save(None, None, title, Mode::Sequential, 10, vec![item.clone()])
                    .await
                    .unwrap_err()
                    .code,
                "invalid_input"
            );
        }
        for (id, revision) in [
            (Some("list"), None),
            (None, Some(1)),
            (Some("bad id"), Some(1)),
        ] {
            assert_eq!(
                repository
                    .save(
                        id,
                        revision,
                        "错误修订".into(),
                        Mode::Sequential,
                        10,
                        vec![item.clone()]
                    )
                    .await
                    .unwrap_err()
                    .code,
                "invalid_input"
            );
        }
        let first = repository
            .save(
                None,
                None,
                "下界".into(),
                Mode::Sequential,
                10,
                vec![item.clone(); 32],
            )
            .await
            .unwrap();
        repository
            .save(
                None,
                None,
                "上界".into(),
                Mode::Random,
                86400,
                vec![item.clone()],
            )
            .await
            .unwrap();
        for index in 2..100 {
            repository
                .save(
                    None,
                    None,
                    format!("列表{index}"),
                    Mode::Sequential,
                    10,
                    vec![item.clone()],
                )
                .await
                .unwrap();
        }
        assert_eq!(
            repository
                .save(
                    None,
                    None,
                    "超过总量".into(),
                    Mode::Sequential,
                    10,
                    vec![item.clone()]
                )
                .await
                .unwrap_err()
                .code,
            "playlist_limit"
        );
        let mut cursor = None;
        let mut seen = std::collections::HashSet::new();
        loop {
            let page = repository.list(999, cursor.as_deref()).await.unwrap();
            assert!(page.playlists.len() <= 20);
            assert!(serde_json::to_vec(&page).unwrap().len() < 64 * 1024);
            for row in page.playlists {
                assert!(seen.insert(row["playlistId"].as_str().unwrap().to_owned()));
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen.len(), 100);
        // Capacity forbids a new list, not an edit to an existing list.
        assert_eq!(
            repository
                .save(
                    Some(&first.playlist_id),
                    Some(1),
                    "仍可编辑".into(),
                    Mode::Sequential,
                    10,
                    vec![item]
                )
                .await
                .unwrap()
                .revision,
            2
        );
        library.pool().close().await;
    }

    #[test]
    fn bounded_lists_fit_the_management_request_even_with_maximal_json_escaping() {
        let item = FixedVersion {
            work_key: "\\\"".repeat(64),
            package_hash: "f".repeat(64),
        };
        let items = vec![item; 32];
        let title = "🗂".repeat(120);
        validate(&title, 86400, &items).unwrap();
        let request = json!({"protocol": 2, "requestId": "r".repeat(128), "command": "wallpaper.playlist.save",
            "payload": {"playlistId": "p".repeat(128), "expectedPlaylistRevision": i64::MAX,
                "title": title, "mode": "sequential", "intervalSeconds": 86400, "items": items}});
        assert!(
            serde_json::to_vec(&request).unwrap().len()
                < hertz_desktop_ipc::management::REQUEST_LIMIT
        );
    }

    #[test]
    fn clock_rejects_invalid_plans_and_accepts_both_interval_boundaries() {
        for interval in [0, 9, 86401, u32::MAX] {
            assert!(Runner::new(playlist(Mode::Sequential, interval, 2), 0).is_err());
        }
        assert!(Runner::new(playlist(Mode::Sequential, 10, 0), 0).is_err());
        assert!(Runner::new(playlist(Mode::Sequential, 10, 33), 0).is_err());
        for interval in [10, 86400] {
            let mut runner = running(Mode::Sequential, interval, 2);
            let now = Instant::now();
            assert!(runner.tick(now, true).is_none());
            assert!(runner
                .tick(
                    now + Duration::from_secs(u64::from(interval)) - Duration::from_nanos(1),
                    true
                )
                .is_none());
            let switch = runner
                .tick(now + Duration::from_secs(u64::from(interval)), true)
                .unwrap();
            assert_eq!(switch.index, 1);
        }
    }

    #[test]
    fn pauses_freeze_elapsed_time_and_resume_never_replays_the_hidden_interval() {
        let mut runner = running(Mode::Sequential, 10, 3);
        let now = Instant::now();
        assert!(runner.tick(now, true).is_none());
        assert!(runner.tick(now + Duration::from_secs(4), true).is_none());
        assert!(runner.tick(now + Duration::from_secs(4), false).is_none());
        assert!(runner
            .tick(now + Duration::from_secs(3604), false)
            .is_none());
        assert!(runner.tick(now + Duration::from_secs(7204), true).is_none());
        assert!(runner.tick(now + Duration::from_secs(7209), true).is_none());
        let switch = runner.tick(now + Duration::from_secs(7210), true).unwrap();
        assert_eq!(switch.index, 1);
        assert_eq!(
            runner.current_index(),
            Some(0),
            "a prepared switch has not yet replaced the displayed item"
        );
        assert!(runner
            .tick(now + Duration::from_secs(86400), true)
            .is_none());
        assert_eq!(runner.pending().unwrap().token, switch.token);
        assert!(runner.presented(switch.token));
        assert!(runner
            .tick(now + Duration::from_secs(86400), true)
            .is_none());
        assert!(runner
            .tick(now + Duration::from_secs(86409), true)
            .is_none());
        assert_eq!(
            runner
                .tick(now + Duration::from_secs(86410), true)
                .unwrap()
                .index,
            2
        );
    }

    #[test]
    fn every_switch_waits_for_one_matching_presentation_and_long_ticks_do_not_queue_work() {
        let mut runner = Runner::new(playlist(Mode::Sequential, 10, 2), 1).unwrap();
        let now = Instant::now();
        assert!(runner.tick(now, true).is_none());
        let first = runner.initial().unwrap();
        assert!(runner.initial().is_none());
        assert_eq!(runner.next().unwrap_err().code, "budget_busy");
        assert_eq!(runner.retry().unwrap_err().code, "budget_busy");
        assert!(!runner.presented(first.token + 1));
        assert!(!runner.fail(first.token + 1));
        assert!(!runner.fail_current());
        assert_eq!(runner.pending_fixed(), Some(&first.reference));
        assert!(runner.current().is_none());
        assert!(runner.presented(first.token));
        assert!(!runner.presented(first.token));
        runner.tick(now, true);
        let second = runner.tick(now + Duration::from_secs(10000), true).unwrap();
        assert_eq!(second.index, 1);
        for seconds in [10001, 20000, 90000] {
            assert!(runner
                .tick(now + Duration::from_secs(seconds), true)
                .is_none());
        }
        assert_eq!(runner.next().unwrap_err().code, "budget_busy");
        assert!(runner.presented(second.token));
        assert_eq!(
            runner.next().unwrap().index,
            0,
            "sequential mode wraps without editing saved order"
        );
    }

    #[test]
    fn random_order_uses_the_runtime_seed_without_reordering_or_immediate_repeat() {
        let saved = playlist(Mode::Random, 10, 5);
        let original = saved.items.clone();
        let mut left = Runner::new(saved.clone(), 834).unwrap();
        let mut right = Runner::new(saved, 834).unwrap();
        for _ in 0..100 {
            let previous = left.current_index();
            let a = left.next().unwrap();
            let b = right.next().unwrap();
            assert_eq!(a.index, b.index);
            assert_ne!(Some(a.index), previous);
            assert_eq!(a.reference, original[a.index]);
            assert!(left.presented(a.token));
            assert!(right.presented(b.token));
        }
        assert_eq!(left.playlist().items, original);
        assert_eq!(right.playlist().items, original);
        assert_eq!(left.playlist().revision, 1);
        let mut singleton = running(Mode::Random, 10, 1);
        assert_eq!(singleton.next().unwrap().index, 0);
    }

    #[test]
    fn a_failed_switch_stops_ticks_and_retries_the_same_item_with_a_new_token() {
        let mut runner = running(Mode::Random, 10, 4);
        let switch = runner.next().unwrap();
        assert!(runner.fail(switch.token));
        assert!(runner.pending().is_none());
        assert!(runner.is_failed());
        assert_eq!(runner.current_index(), Some(0));
        assert_eq!(runner.next().unwrap_err().code, "playlist_failed");
        let now = Instant::now();
        assert!(runner.tick(now, true).is_none());
        assert!(runner
            .tick(now + Duration::from_secs(86400), true)
            .is_none());
        assert!(
            !runner.fail_current(),
            "the failure of a pending item must not be overwritten by the old displayed item"
        );
        let retry = runner.retry().unwrap();
        assert_eq!(retry.index, switch.index);
        assert_eq!(retry.reference, switch.reference);
        assert_ne!(retry.token, switch.token);
        assert!(!runner.presented(switch.token));
        assert!(!runner.fail(switch.token));
        assert!(runner.fail(retry.token));
        let retry_again = runner.retry().unwrap();
        assert_eq!(retry_again.reference, switch.reference);
        assert!(runner.presented(retry_again.token));
        assert!(!runner.is_failed());
        assert_eq!(runner.current(), Some(&switch.reference));
        assert_eq!(runner.retry().unwrap_err().code, "playlist_not_failed");
    }

    #[test]
    fn a_running_renderer_failure_stops_the_clock_until_explicit_same_item_retry() {
        let mut runner = running(Mode::Sequential, 10, 3);
        let now = Instant::now();
        runner.tick(now, true);
        runner.tick(now + Duration::from_secs(9), true);
        assert!(runner.fail_current());
        assert!(runner.is_failed());
        assert!(!runner.fail_current());
        assert_eq!(runner.next().unwrap_err().code, "playlist_failed");
        assert!(runner.tick(now + Duration::from_secs(3600), true).is_none());
        let retry = runner.retry().unwrap();
        assert_eq!(retry.index, 0);
        assert_eq!(Some(&retry.reference), runner.current());
        assert!(runner.presented(retry.token));
        assert!(runner.tick(now + Duration::from_secs(3600), true).is_none());
        assert!(runner.tick(now + Duration::from_secs(3609), true).is_none());
        assert_eq!(
            runner
                .tick(now + Duration::from_secs(3610), true)
                .unwrap()
                .index,
            1
        );
    }
}
