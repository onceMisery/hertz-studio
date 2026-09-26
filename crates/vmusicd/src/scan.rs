// SPDX-License-Identifier: MIT
//! One scan owner serves manual requests, startup recovery and OS file events.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, Mutex};

use crate::state::{AppState, ScanError, ScanProgress, WsEvent};

const MAX_ERRORS: usize = 50;

/// Keep the standard absolute Windows spelling used by existing track paths.
pub fn normalize_root(root: &Path) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    if !path.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    std::fs::read_dir(&path).map_err(|e| format!("{}: {e}", root.display()))?;
    Ok(standard_path(path))
}

fn standard_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

/// Reserve before spawning: a successful response always owns the scan.
pub async fn start(state: Arc<AppState>, root: PathBuf) -> Result<(), String> {
    start_job(ScanJob::from_state(&state), root, false).await
}

async fn start_job(job: ScanJob, root: PathBuf, saved_only: bool) -> Result<(), String> {
    let root = tokio::task::spawn_blocking(move || normalize_root(&root))
        .await
        .map_err(|e| e.to_string())??;
    if saved_only {
        job.reserve_enabled(&root, true).await?;
    } else {
        job.reserve(&root).await?;
    }
    tokio::spawn(job.run(root));
    Ok(())
}

pub async fn cancel(state: &Arc<AppState>) {
    let progress = state.scan.lock().await;
    if progress.running {
        state.scan_cancel.store(true, Ordering::Relaxed);
    }
}

/// Used by disable/remove: do not cancel a different root that acquired the
/// scanner between the settings change and this request.
pub async fn cancel_root(state: &Arc<AppState>, root: &str) {
    let progress = state.scan.lock().await;
    if progress.running && progress.root.as_deref() == Some(root) {
        state.scan_cancel.store(true, Ordering::Relaxed);
    }
}

#[derive(Clone)]
struct ScanJob {
    db: SqlitePool,
    cache_dir: PathBuf,
    progress: Arc<Mutex<ScanProgress>>,
    cancel: Arc<AtomicBool>,
    events: broadcast::Sender<WsEvent>,
}

impl ScanJob {
    fn from_state(state: &AppState) -> Self {
        Self {
            db: state.db.clone(),
            cache_dir: state.data_dir.join("cache"),
            progress: state.scan.clone(),
            cancel: state.scan_cancel.clone(),
            events: state.events.clone(),
        }
    }

    async fn reserve(&self, root: &Path) -> Result<(), String> {
        self.reserve_enabled(root, false).await
    }

    async fn reserve_enabled(&self, root: &Path, saved_only: bool) -> Result<(), String> {
        let mut progress = self.progress.lock().await;
        if progress.running {
            return Err("a library scan is already running".into());
        }
        if saved_only {
            // Hold the same lock as cancel_root across recheck + reservation.
            // A disable/remove that races this pass either prevents reservation
            // or sees it running when its cancellation request acquires the lock.
            let enabled: Option<bool> =
                sqlx::query_scalar("SELECT enabled FROM scan_roots WHERE path = ?1")
                    .bind(root.to_string_lossy().as_ref())
                    .fetch_optional(&self.db)
                    .await
                    .map_err(|e| e.to_string())?;
            if enabled != Some(true) {
                return Err("saved directory is disabled or removed".into());
            }
        }
        self.cancel.store(false, Ordering::Relaxed);
        *progress = ScanProgress {
            running: true,
            root: Some(root.to_string_lossy().into_owned()),
            phase: "walking".into(),
            ..Default::default()
        };
        self.publish(&progress);
        Ok(())
    }

    fn publish(&self, progress: &ScanProgress) {
        let _ = self.events.send(WsEvent::Scan {
            phase: progress.phase.clone(),
            done: progress.done,
            total: progress.total,
        });
    }

    async fn error(&self, path: &Path, message: impl ToString) {
        let mut progress = self.progress.lock().await;
        record_error(&mut progress, path, message.to_string());
    }

    async fn run(self, root: PathBuf) {
        if let Err(error) = self.scan_files(&root).await {
            self.error(&root, error).await;
        }
        let mut progress = self.progress.lock().await;
        progress.cancelled = self.cancel.load(Ordering::Relaxed);
        progress.phase = if progress.cancelled {
            "cancelled"
        } else if progress.failed > 0 {
            "failed"
        } else {
            "done"
        }
        .into();
        let saved_error = if progress.cancelled {
            Some("scan cancelled".to_string())
        } else {
            progress.last_error.clone()
        };
        // Persist before the terminal event, so status and root history agree.
        if let Err(error) = vmusic_store::scan_roots::record_result(
            &self.db,
            &root.to_string_lossy(),
            !progress.cancelled && progress.failed == 0,
            saved_error.as_deref(),
        )
        .await
        {
            record_error(&mut progress, &root, error.to_string());
            if !progress.cancelled {
                progress.phase = "failed".into();
            }
        }
        progress.running = false;
        self.publish(&progress);
        if progress.added + progress.updated + progress.removed > 0 {
            let _ = self.events.send(WsEvent::LibraryChanged);
        }
    }

    async fn scan_files(&self, root: &Path) -> Result<(), String> {
        let walk_root = root.to_path_buf();
        let cancel = self.cancel.clone();
        let report = tokio::task::spawn_blocking(move || {
            // Root may disappear or become unreadable after validation.
            normalize_root(&walk_root)?;
            Ok::<_, String>(vmusic_library::collect_audio_files_checked(
                &walk_root, &cancel,
            ))
        })
        .await
        .map_err(|e| e.to_string())??;
        self.scan_report(root, report).await
    }

    async fn scan_report(
        &self,
        root: &Path,
        report: vmusic_library::WalkReport,
    ) -> Result<(), String> {
        {
            let mut progress = self.progress.lock().await;
            progress.total = report.files.len();
            for (path, message) in report.errors {
                record_error(&mut progress, &path, message);
            }
            // Walking stores a bounded sample, but failure count is exact.
            progress.failed = report.error_count;
            if report.cancelled || self.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            progress.phase = "scanning".into();
            self.publish(&progress);
        }
        type Existing = (String, String, Option<i64>, Option<i64>);
        let existing: Vec<Existing> = sqlx::query_as(
            "SELECT path, id, file_mtime, file_size FROM tracks WHERE source = 'local'",
        )
        .fetch_all(&self.db)
        .await
        .map_err(|e| e.to_string())?;
        let lookup_root = root.to_path_buf();
        let cancel = self.cancel.clone();
        let existing: HashMap<_, _> = tokio::task::spawn_blocking(move || {
            let mut rows = HashMap::new();
            for (path, id, mtime, size) in existing {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                let key = vmusic_store::track_path_key(Path::new(&path));
                if key.starts_with(&lookup_root) {
                    rows.insert(key, (path, id, mtime, size));
                }
            }
            rows
        })
        .await
        .map_err(|e| e.to_string())?;
        let mut seen = Vec::with_capacity(report.files.len());
        for path in report.files {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            let previous = existing.get(&path).cloned();
            // Parse/stat/store failures retain any previously indexed row.
            seen.push(
                previous
                    .as_ref()
                    .map(|row| row.0.clone())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned()),
            );
            let file_path = path.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                let signature = file_signature(&file_path)?;
                if let Some((_, _, Some(mtime), Some(size))) = &previous {
                    if signature == (*mtime, *size) {
                        return Ok(None);
                    }
                }
                let mut metadata = vmusic_library::read_metadata(&file_path)?;
                let cover = metadata.cover.take();
                let rg_gain = metadata.rg_gain;
                let mut track = vmusic_library::build_track(&file_path, metadata);
                if file_signature(&file_path)? != signature {
                    return Err(
                        "file changed while reading; it will be retried on the next scan".into(),
                    );
                }
                track.file_mtime = Some(signature.0);
                track.file_size = Some(signature.1);
                let updated = previous.is_some();
                if let Some((stored_path, id, ..)) = previous {
                    track.path = stored_path;
                    track.id = id;
                }
                Ok(Some((track, cover, updated, rg_gain)))
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|result| result);
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            match outcome {
                Ok(None) => self.progress.lock().await.skipped += 1,
                Ok(Some((mut track, cover, updated, rg_gain))) => {
                    if let Some((data, media_type)) = cover {
                        // 用户替换过封面：跳过内嵌封面落盘，缓存里的用户封面
                        // 保持原样，has_cover 依旧成立。
                        let cover_edited = vmusic_store::track_edits::is_cover_edited(
                            &self.db, &track.id)
                            .await
                            .unwrap_or(false);
                        if cover_edited {
                            track.has_cover = true;
                        } else {
                            let cache = self.cache_dir.clone();
                            let id = track.id.clone();
                            track.has_cover = tokio::task::spawn_blocking(move || {
                                vmusic_library::save_cover(&cache, &id, &data, &media_type)
                                    .is_some()
                            })
                            .await
                            .unwrap_or(false);
                        }
                    }
                    match vmusic_store::upsert_track(&self.db, &track).await {
                        Ok(()) => {
                            // ReplayGain 增益跟文件走：upsert 不含该列，单独落库。
                            let _ = vmusic_store::set_track_rg(
                                &self.db, &track.id, rg_gain,
                            )
                            .await;
                            let mut progress = self.progress.lock().await;
                            if updated {
                                progress.updated += 1;
                            } else {
                                progress.added += 1;
                            }
                        }
                        Err(error) => self.error(&path, error).await,
                    }
                }
                Err(error) => self.error(&path, error).await,
            }
            let mut progress = self.progress.lock().await;
            progress.done += 1;
            if progress.done % 10 == 0 || progress.done == progress.total {
                self.publish(&progress);
            }
        }
        // Traversal errors invalidate deletion evidence for the whole root.
        if report.error_count == 0 && !self.cancel.load(Ordering::Relaxed) {
            // Also protect a disconnected drive disappearing mid-pass.
            let check_root = root.to_path_buf();
            tokio::task::spawn_blocking(move || normalize_root(&check_root))
                .await
                .map_err(|e| e.to_string())??;
            if let Some(removed) = vmusic_store::delete_stale_under_root_cancellable(
                &self.db,
                &root.to_string_lossy(),
                &seen,
                &self.cancel,
            )
            .await
            .map_err(|e| e.to_string())?
            {
                self.progress.lock().await.removed = removed as usize;
            }
        }
        Ok(())
    }
}

fn file_signature(path: &Path) -> Result<(i64, i64), String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    Ok((mtime, metadata.len() as i64))
}

fn record_error(progress: &mut ScanProgress, path: &Path, message: String) {
    let message: String = message.chars().take(1000).collect();
    let path: String = path.to_string_lossy().chars().take(4096).collect();
    progress.failed += 1;
    progress.last_error = Some(format!("{path}: {message}"));
    if progress.errors.len() < MAX_ERRORS {
        progress.errors.push(ScanError { path, message });
    }
}

/// Saved roots gain OS watchers and a startup recovery pass. Missing roots
/// remain saved and reattach automatically when the directory is available.
pub fn spawn_watcher(state: Arc<AppState>) {
    watch_roots(ScanJob::from_state(&state));
}

fn watch_roots(job: ScanJob) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        let overflow = Arc::new(AtomicBool::new(false));
        let mut watcher = loop {
            let sender = tx.clone();
            let overflow_callback = overflow.clone();
            match notify::recommended_watcher(move |event| {
                if sender.try_send(event).is_err() {
                    overflow_callback.store(true, Ordering::Relaxed);
                }
            }) {
                Ok(watcher) => break watcher,
                Err(error) => {
                    let message = format!("cannot create library file watcher: {error}");
                    tracing::error!("{message}");
                    if let Ok(roots) = vmusic_store::scan_roots::list(&job.db).await {
                        for root in roots.iter().filter(|root| root.enabled) {
                            let _ = vmusic_store::scan_roots::record_result(
                                &job.db,
                                &root.path,
                                false,
                                Some(&message),
                            )
                            .await;
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        };
        let mut known = HashSet::<String>::new();
        let mut watched = HashSet::<String>::new();
        let mut pending = HashMap::<String, Instant>::new();
        let mut timer = tokio::time::interval(Duration::from_millis(500));
        let mut reconcile_at = Instant::now();
        loop {
            tokio::select! {
                _ = timer.tick() => {}
                event = rx.recv() => {
                    match event {
                        Some(Ok(event)) if !matches!(event.kind, EventKind::Access(_)) => {
                            for root in &known {
                                // A deleted/replaced root invalidates the native
                                // handle even if a directory reappears immediately.
                                if matches!(event.kind, EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)))
                                    && event.paths.iter().any(|path| Path::new(root).starts_with(standard_path(path.clone())))
                                {
                                    let _ = watcher.unwatch(Path::new(root));
                                    watched.remove(root);
                                    reconcile_at = Instant::now();
                                }
                                if event.paths.is_empty() || event.paths.iter().any(|path| {
                                    let path = standard_path(path.clone());
                                    (path.starts_with(root) || Path::new(root).starts_with(&path))
                                        && (vmusic_library::is_audio_file(&path) || !path.is_file())
                                }) {
                                    pending.insert(root.clone(), Instant::now() + Duration::from_millis(750));
                                }
                            }
                        }
                        Some(Err(error)) => {
                            tracing::warn!("library watcher error: {error}");
                            for root in watched.drain() { let _ = watcher.unwatch(Path::new(&root)); }
                            reconcile_at = Instant::now();
                            overflow.store(true, Ordering::Relaxed);
                        }
                        _ => {}
                    }
                }
            }
            if Instant::now() >= reconcile_at {
                reconcile_at = Instant::now() + Duration::from_secs(2);
                match vmusic_store::scan_roots::list(&job.db).await {
                    Ok(roots) => {
                        let enabled: HashSet<_> = roots
                            .iter()
                            .filter(|r| r.enabled)
                            .map(|r| r.path.clone())
                            .collect();
                        for root in watched.clone() {
                            if !enabled.contains(&root) || !Path::new(&root).is_dir() {
                                let _ = watcher.unwatch(Path::new(&root));
                                watched.remove(&root);
                            }
                        }
                        pending.retain(|root, _| enabled.contains(root));
                        for root in &roots {
                            if !root.enabled {
                                continue;
                            }
                            if !known.contains(&root.path) {
                                pending.entry(root.path.clone()).or_insert(Instant::now());
                            }
                            if !watched.contains(&root.path) {
                                match watcher.watch(Path::new(&root.path), RecursiveMode::Recursive)
                                {
                                    Ok(()) => {
                                        watched.insert(root.path.clone());
                                        pending.entry(root.path.clone()).or_insert(Instant::now());
                                    }
                                    Err(error) => {
                                        let message = format!(
                                            "{}: cannot watch directory: {error}",
                                            root.path
                                        );
                                        if root.last_error.as_deref() != Some(&message) {
                                            let _ = vmusic_store::scan_roots::record_result(
                                                &job.db,
                                                &root.path,
                                                false,
                                                Some(&message),
                                            )
                                            .await;
                                        }
                                    }
                                }
                            }
                        }
                        known = enabled;
                    }
                    Err(error) => tracing::warn!("cannot load saved library roots: {error}"),
                }
            }
            if overflow.swap(false, Ordering::Relaxed) {
                for root in &known {
                    pending.entry(root.clone()).or_insert(Instant::now());
                }
            }
            if !job.progress.lock().await.running {
                let next = pending
                    .iter()
                    .filter(|(_, at)| **at <= Instant::now())
                    .min_by_key(|(_, at)| **at)
                    .map(|(root, _)| root.clone());
                if let Some(root) = next {
                    match start_job(job.clone(), PathBuf::from(&root), true).await {
                        Ok(()) => {
                            pending.remove(&root);
                        }
                        Err(error) if job.progress.lock().await.running => {
                            tracing::debug!("watch scan deferred: {error}");
                        }
                        Err(error) => {
                            pending.remove(&root);
                            let _ = vmusic_store::scan_roots::record_result(
                                &job.db,
                                &root,
                                false,
                                Some(&error),
                            )
                            .await;
                        }
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        job: ScanJob,
    }

    impl Fixture {
        async fn new() -> Self {
            let base = std::env::temp_dir().join(format!("vmusic-scan-{}", uuid::Uuid::new_v4()));
            let root = base.join("Music");
            std::fs::create_dir_all(&root).unwrap();
            let root = normalize_root(&root).unwrap();
            let db = vmusic_store::open(&base.join("db")).await.unwrap();
            vmusic_store::scan_roots::upsert(&db, root.to_str().unwrap(), true)
                .await
                .unwrap();
            let (events, _) = broadcast::channel(128);
            Self {
                job: ScanJob {
                    db,
                    cache_dir: base.join("cache"),
                    progress: Default::default(),
                    cancel: Default::default(),
                    events,
                },
                base,
                root,
            }
        }

        async fn scan(&self) -> ScanProgress {
            self.job.reserve(&self.root).await.unwrap();
            self.job.clone().run(self.root.clone()).await;
            self.job.progress.lock().await.clone()
        }

        async fn cleanup(self) {
            self.job.db.close().await;
            // SQLite/Windows can retain a transient file handle after shutdown.
            for attempt in 0..20 {
                match std::fs::remove_dir_all(&self.base) {
                    Ok(()) => return,
                    Err(error) if matches!(error.raw_os_error(), Some(32 | 33)) && attempt < 19 => {
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                    Err(error) => panic!(
                        "fixture cleanup failed for {}: {error}",
                        self.base.display()
                    ),
                }
            }
        }
    }

    fn wav(path: &Path, samples: u32) {
        let size = samples * 2;
        let mut data = Vec::new();
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + size).to_le_bytes());
        data.extend_from_slice(b"WAVEfmt ");
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&8000u32.to_le_bytes());
        data.extend_from_slice(&16000u32.to_le_bytes());
        data.extend_from_slice(&2u16.to_le_bytes());
        data.extend_from_slice(&16u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&size.to_le_bytes());
        data.resize(44 + size as usize, 0);
        std::fs::write(path, data).unwrap();
    }

    #[tokio::test]
    async fn incremental_scan_preserves_identity_and_skips_unchanged_files() {
        let fixture = Fixture::new().await;
        let file = fixture.root.join("song.wav");
        wav(&file, 80);
        let first = fixture.scan().await;
        assert_eq!(
            (first.added, first.failed, first.phase.as_str()),
            (1, 0, "done")
        );
        let id = vmusic_store::get_track_id_by_path(&fixture.job.db, file.to_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        let unchanged = fixture.scan().await;
        assert_eq!(
            (unchanged.added, unchanged.updated, unchanged.skipped),
            (0, 0, 1)
        );
        wav(&file, 160);
        let changed = fixture.scan().await;
        assert_eq!((changed.updated, changed.skipped), (1, 0));
        assert_eq!(
            vmusic_store::get_track_id_by_path(&fixture.job.db, file.to_str().unwrap())
                .await
                .unwrap(),
            Some(id)
        );
        let roots = vmusic_store::scan_roots::list(&fixture.job.db)
            .await
            .unwrap();
        assert!(roots[0].last_scanned_at.is_some());
        assert!(roots[0].last_error.is_none());
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn parse_failure_preserves_previous_record_and_reports_path() {
        let fixture = Fixture::new().await;
        let file = fixture.root.join("song.wav");
        let removed = fixture.root.join("removed.wav");
        wav(&file, 80);
        wav(&removed, 80);
        fixture.scan().await;
        let id = vmusic_store::get_track_id_by_path(&fixture.job.db, file.to_str().unwrap())
            .await
            .unwrap();
        std::fs::write(&file, b"broken audio").unwrap();
        std::fs::remove_file(removed).unwrap();
        let progress = fixture.scan().await;
        assert_eq!(
            (progress.failed, progress.removed, progress.phase.as_str()),
            (1, 1, "failed")
        );
        assert_eq!(progress.errors[0].path, file.to_string_lossy());
        assert!(!progress.errors[0].message.is_empty());
        assert_eq!(
            vmusic_store::get_track_id_by_path(&fixture.job.db, file.to_str().unwrap())
                .await
                .unwrap(),
            id
        );
        assert_eq!(
            vmusic_store::count_tracks(&fixture.job.db, None)
                .await
                .unwrap(),
            1
        );
        fixture.cleanup().await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn legacy_windows_path_keeps_track_playlist_and_favorite_identity() {
        let fixture = Fixture::new().await;
        let file = fixture.root.join("song.wav");
        wav(&file, 80);
        let mut old =
            vmusic_library::build_track(&file, vmusic_library::read_metadata(&file).unwrap());
        // Earlier scans accepted forward slashes and retained supplied case.
        old.path = format!(
            "{}\\song.wav",
            fixture
                .root
                .to_string_lossy()
                .replace('\\', "/")
                .replace("/Music", "/MUSIC")
        );
        vmusic_store::upsert_track(&fixture.job.db, &old)
            .await
            .unwrap();
        let playlist = vmusic_store::playlists::create(&fixture.job.db, "legacy")
            .await
            .unwrap();
        vmusic_store::playlists::add_tracks(&fixture.job.db, &playlist.id, &[old.id.clone()])
            .await
            .unwrap();
        vmusic_store::favorites::add(
            &fixture.job.db,
            vmusic_core::FavoriteKind::Track,
            "local",
            &old.id,
            &vmusic_store::favorites::FavoriteMeta {
                title: "legacy".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let skipped = fixture.scan().await;
        assert_eq!((skipped.added, skipped.removed, skipped.skipped), (0, 0, 1));
        wav(&file, 160);
        let updated = fixture.scan().await;
        assert_eq!((updated.added, updated.removed, updated.updated), (0, 0, 1));
        std::fs::write(&file, b"corrupt legacy file").unwrap();
        let failed = fixture.scan().await;
        assert_eq!((failed.failed, failed.removed), (1, 0));
        let stored = vmusic_store::get_track(&fixture.job.db, &old.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.path, old.path);
        assert_eq!(
            vmusic_store::count_tracks(&fixture.job.db, None)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            vmusic_store::get_playlist_track_ids(&fixture.job.db, &playlist.id)
                .await
                .unwrap(),
            vec![old.id.clone()]
        );
        assert_eq!(
            vmusic_store::favorites::local_track_ids(&fixture.job.db, 10)
                .await
                .unwrap(),
            vec![old.id]
        );
        std::fs::remove_file(file).unwrap();
        assert_eq!(fixture.scan().await.removed, 1);
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn partial_traversal_never_prunes_unseen_subtree() {
        let fixture = Fixture::new().await;
        wav(&fixture.root.join("unseen.wav"), 80);
        fixture.scan().await;
        fixture.job.reserve(&fixture.root).await.unwrap();
        // Feed the real processing/pruning path the walker's partial-result
        // contract; permission setup varies by OS and administrator privileges.
        fixture
            .job
            .scan_report(
                &fixture.root,
                vmusic_library::WalkReport {
                    errors: vec![(fixture.root.join("private"), "permission denied".into())],
                    error_count: 1,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(fixture.job.progress.lock().await.failed, 1);
        assert_eq!(
            vmusic_store::count_tracks(&fixture.job.db, None)
                .await
                .unwrap(),
            1
        );
        fixture.cleanup().await;
    }

    async fn wait_for_count(fixture: &Fixture, expected: i64) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if vmusic_store::count_tracks(&fixture.job.db, None)
                    .await
                    .unwrap()
                    == expected
                    && !fixture.job.progress.lock().await.running
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("watcher did not reconcile library within ten seconds");
    }

    #[tokio::test]
    async fn native_watcher_recovers_restarts_and_respects_disabled_roots() {
        let fixture = Fixture::new().await;
        wav(&fixture.root.join("startup.wav"), 80);
        let watcher = watch_roots(fixture.job.clone());
        wait_for_count(&fixture, 1).await;
        wav(&fixture.root.join("new.wav"), 80);
        wait_for_count(&fixture, 2).await;
        std::fs::remove_file(fixture.root.join("new.wav")).unwrap();
        wait_for_count(&fixture, 1).await;
        vmusic_store::scan_roots::set_enabled(
            &fixture.job.db,
            fixture.root.to_str().unwrap(),
            false,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(2500)).await;
        wav(&fixture.root.join("disabled.wav"), 80);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(
            vmusic_store::count_tracks(&fixture.job.db, None)
                .await
                .unwrap(),
            1
        );
        vmusic_store::scan_roots::set_enabled(
            &fixture.job.db,
            fixture.root.to_str().unwrap(),
            true,
        )
        .await
        .unwrap();
        wait_for_count(&fixture, 2).await;
        watcher.abort();
        let _ = watcher.await;
        wav(&fixture.root.join("offline.wav"), 80);
        let restarted = watch_roots(fixture.job.clone());
        wait_for_count(&fixture, 3).await;
        restarted.abort();
        let _ = restarted.await;
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn vanished_root_and_cancelled_traversal_never_prune() {
        let fixture = Fixture::new().await;
        wav(&fixture.root.join("song.wav"), 80);
        fixture.scan().await;
        std::fs::rename(&fixture.root, fixture.base.join("unplugged")).unwrap();
        let failed = fixture.scan().await;
        assert_eq!(failed.phase, "failed");
        assert_eq!(failed.removed, 0);
        assert_eq!(
            vmusic_store::count_tracks(&fixture.job.db, None)
                .await
                .unwrap(),
            1
        );
        std::fs::create_dir(&fixture.root).unwrap();
        fixture.job.reserve(&fixture.root).await.unwrap();
        assert!(fixture.job.reserve(&fixture.root).await.is_err());
        fixture.job.cancel.store(true, Ordering::Relaxed);
        fixture.job.clone().run(fixture.root.clone()).await;
        let cancelled = fixture.job.progress.lock().await.clone();
        assert!(cancelled.cancelled);
        assert_eq!(cancelled.phase, "cancelled");
        assert_eq!(
            vmusic_store::count_tracks(&fixture.job.db, None)
                .await
                .unwrap(),
            1
        );
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn disabled_or_removed_root_cannot_reserve_automatic_scan() {
        let fixture = Fixture::new().await;
        vmusic_store::scan_roots::set_enabled(
            &fixture.job.db,
            fixture.root.to_str().unwrap(),
            false,
        )
        .await
        .unwrap();
        assert!(start_job(fixture.job.clone(), fixture.root.clone(), true)
            .await
            .is_err());
        assert!(!fixture.job.progress.lock().await.running);
        vmusic_store::scan_roots::remove(&fixture.job.db, fixture.root.to_str().unwrap())
            .await
            .unwrap();
        assert!(start_job(fixture.job.clone(), fixture.root.clone(), true)
            .await
            .is_err());
        assert!(!fixture.job.progress.lock().await.running);
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn cancel_during_scan_retains_unseen_rows() {
        let fixture = Fixture::new().await;
        let disappeared = fixture.root.join("disappeared.wav");
        wav(&disappeared, 80);
        fixture.scan().await;
        std::fs::remove_file(disappeared).unwrap();
        for index in 0..30 {
            wav(&fixture.root.join(format!("{index}.wav")), 80);
        }
        let mut events = fixture.job.events.subscribe();
        fixture.job.reserve(&fixture.root).await.unwrap();
        let running = tokio::spawn(fixture.job.clone().run(fixture.root.clone()));
        while let Ok(event) = events.recv().await {
            if matches!(event, WsEvent::Scan { phase, .. } if phase == "scanning") {
                fixture.job.cancel.store(true, Ordering::Relaxed);
                break;
            }
        }
        running.await.unwrap();
        let progress = fixture.job.progress.lock().await.clone();
        assert!(progress.cancelled);
        assert_eq!(progress.removed, 0);
        assert!(
            vmusic_store::count_tracks(&fixture.job.db, None)
                .await
                .unwrap()
                >= 1
        );
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn failures_are_bounded_and_terminal_event_follows_pruning() {
        let fixture = Fixture::new().await;
        for index in 0..60 {
            std::fs::write(fixture.root.join(format!("bad{index}.mp3")), b"bad").unwrap();
        }
        let failed = fixture.scan().await;
        assert_eq!(failed.failed, 60);
        assert_eq!(failed.errors.len(), MAX_ERRORS);
        for index in 0..60 {
            std::fs::remove_file(fixture.root.join(format!("bad{index}.mp3"))).unwrap();
        }
        wav(&fixture.root.join("old.wav"), 80);
        fixture.scan().await;
        std::fs::remove_file(fixture.root.join("old.wav")).unwrap();
        let mut events = fixture.job.events.subscribe();
        let progress = fixture.scan().await;
        assert_eq!(progress.removed, 1);
        let mut terminal = false;
        while let Ok(event) = events.try_recv() {
            if let WsEvent::Scan { phase, .. } = event {
                if phase == "done" {
                    assert_eq!(
                        vmusic_store::count_tracks(&fixture.job.db, None)
                            .await
                            .unwrap(),
                        0
                    );
                    terminal = true;
                }
            }
        }
        assert!(terminal);
        fixture.cleanup().await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn unreadable_file_keeps_previous_record() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new().await;
        let file = fixture.root.join("locked.wav");
        wav(&file, 80);
        fixture.scan().await;
        wav(&file, 160);
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&file)
            .unwrap();
        let result = fixture.scan().await;
        assert_eq!(result.failed, 1);
        assert_eq!(result.removed, 0);
        assert_eq!(
            vmusic_store::count_tracks(&fixture.job.db, None)
                .await
                .unwrap(),
            1
        );
        drop(lock);
        fixture.cleanup().await;
    }
}
