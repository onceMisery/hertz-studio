// SPDX-License-Identifier: MIT
//! One bounded offline reader inside the existing shared analysis allowance.
use crate::{
    audio_source_snapshot::{OriginalIdentity, StableFile},
    error::{bad_request, not_found, ApiError, ApiResult},
    state::AppState,
};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, VecDeque},
    io::{Read, Seek},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use vmusic_audio::loudness::{self, AnalyzeError, Control, MeasurementState};
#[cfg(test)]
use vmusic_core::Track;
use vmusic_core::{CoreError, TrackSource};
use vmusic_store::loudness::{AlbumMeasurement, Member, TrackMeasurement};

pub(crate) static READER: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));
#[cfg(test)]
pub(crate) static ANALYSIS_TEST_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const DEADLINE: Duration = Duration::from_secs(120);
const MAX_MEMBERS: usize = 128;
const CANDIDATE_TTL: Duration = Duration::from_secs(30);
const CANDIDATE_IDENTITY_BUDGET: Duration = Duration::from_millis(50);

#[derive(Default)]
pub(crate) struct Candidates {
    inner: Mutex<CandidateState>,
}
#[derive(Default)]
struct CandidateState {
    entries: VecDeque<VerifiedSource>,
    next_serial: u64,
    epoch: u64,
    preparing: bool,
    reaping: bool,
    cancel: Option<Arc<AtomicBool>>,
    next_preparing: bool,
    next_again: bool,
}

/// A complete fingerprint and the exact immutable file which may be decoded.
/// At most two pending sources (current/next) are retained per AppState. Album
/// member leases keep every fingerprint current until the selected source exits.
pub(crate) struct VerifiedSource {
    serial: u64,
    id: String,
    revision: String,
    path: PathBuf,
    prepared_at: Instant,
    source_generation: u64,
    source: StableAudioSource,
    gain: GainSelection,
    next: Option<crate::state::PreparedPlayback>,
}
struct StableAudioSource {
    file: StableFile,
    _album_guards: Vec<StableFile>,
    len: u64,
}
impl StableAudioSource {
    fn originals_match(&self) -> bool {
        self.file.original_identity_matches()
            && self
                ._album_guards
                .iter()
                .all(|guard| guard.original_identity_matches())
    }

    fn original_identities(&self) -> Vec<OriginalIdentity> {
        std::iter::once(self.file.original_identity())
            .chain(self._album_guards.iter().map(StableFile::original_identity))
            .collect()
    }
}
impl Read for StableAudioSource {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(out)
    }
}
impl Seek for StableAudioSource {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.file.seek(pos)
    }
}
impl vmusic_core::AudioSource for StableAudioSource {
    fn media_len(&self) -> Option<u64> {
        Some(self.len)
    }
}
impl VerifiedSource {
    pub(crate) fn retire(self) {
        retire_sources(VecDeque::from([self]));
    }

    pub(crate) fn next(&self) -> Option<&crate::state::PreparedPlayback> {
        self.next.as_ref()
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        Box<dyn vmusic_core::AudioSource>,
        Option<String>,
        GainSelection,
    ) {
        let ext = self
            .path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_owned);
        (Box::new(self.source), ext, self.gain)
    }
}
fn retire_sources(sources: VecDeque<VerifiedSource>) {
    if sources.is_empty() {
        return;
    }
    // Never close up to 128 album leases while a caller holds play_commit.
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn_blocking(move || drop(sources));
    } else {
        drop(sources);
    }
}
impl Candidates {
    pub(crate) fn request_next_worker(&self) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.next_preparing {
            inner.next_again = true;
            false
        } else {
            inner.next_preparing = true;
            true
        }
    }
    pub(crate) fn finish_next_worker(&self) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.next_again {
            inner.next_again = false;
            true
        } else {
            inner.next_preparing = false;
            false
        }
    }
    pub(crate) fn epoch(&self) -> Option<u64> {
        self.inner.try_lock().ok().map(|s| s.epoch)
    }
    pub(crate) async fn ready_for_load(
        &self,
        id: &str,
        revision: &str,
        path: &Path,
        source_generation: u64,
    ) -> Option<u64> {
        let (serial, identities) =
            self.identity_checks_for_load(id, revision, path, source_generation)?;
        // Playback falls back to 0 dB even if a timed-out stat remains on the blocking pool.
        let valid = tokio::time::timeout(
            CANDIDATE_IDENTITY_BUDGET,
            tokio::task::spawn_blocking(move || identities.iter().all(OriginalIdentity::matches)),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(false);
        if !valid {
            return None;
        }
        let inner = self.inner.try_lock().ok()?;
        inner
            .entries
            .iter()
            .any(|e| {
                e.serial == serial
                    && e.id == id
                    && e.revision == revision
                    && e.path == path
                    && e.source_generation == source_generation
                    && e.prepared_at.elapsed() <= CANDIDATE_TTL
            })
            .then_some(serial)
    }
    fn identity_checks_for_load(
        &self,
        id: &str,
        revision: &str,
        path: &Path,
        source_generation: u64,
    ) -> Option<(u64, Vec<OriginalIdentity>)> {
        let inner = self.inner.try_lock().ok()?;
        let source = inner.entries.iter().find(|e| {
            e.id == id
                && e.revision == revision
                && e.path == path
                && e.source_generation == source_generation
                && e.prepared_at.elapsed() <= CANDIDATE_TTL
        })?;
        Some((source.serial, source.source.original_identities()))
    }
    fn ready_for_track(&self, id: &str) -> bool {
        self.inner.try_lock().is_ok_and(|inner| {
            inner.entries.iter().any(|e| {
                e.id == id && e.source.originals_match() && e.prepared_at.elapsed() <= CANDIDATE_TTL
            })
        })
    }
    /// Call when effective library/album metadata changes. Config revisions are
    /// also part of every lookup, so an old gain cannot match a new configuration.
    pub(crate) fn invalidate(&self) {
        let retired = if let Ok(mut inner) = self.inner.lock() {
            inner.epoch = inner.epoch.wrapping_add(1);
            if let Some(cancel) = &inner.cancel {
                cancel.store(true, Ordering::Relaxed);
            }
            std::mem::take(&mut inner.entries)
        } else {
            return;
        };
        retire_sources(retired);
    }
    /// Memory-only admission for callers that validated originals before taking
    /// `play_commit`. The transferred snapshot and gain always describe the same bytes.
    pub(crate) fn take_for_load(
        &self,
        id: &str,
        revision: &str,
        path: &Path,
        source_generation: u64,
        serial: u64,
    ) -> Option<VerifiedSource> {
        let mut inner = self.inner.try_lock().ok()?;
        let position = inner.entries.iter().position(|e| {
            e.serial == serial
                && e.id == id
                && e.revision == revision
                && e.path == path
                && e.source_generation == source_generation
        })?;
        let source = inner.entries.remove(position)?;
        drop(inner);
        if source.prepared_at.elapsed() > CANDIDATE_TTL {
            source.retire();
            None
        } else {
            Some(source)
        }
    }
    fn begin(&self, id: &str, revision: &str, source_generation: u64) -> Option<u64> {
        let mut inner = self.inner.try_lock().ok()?;
        if inner.preparing
            || inner.entries.iter().any(|e| {
                e.id == id
                    && e.revision == revision
                    && e.source_generation == source_generation
                    && e.source.originals_match()
                    && e.prepared_at.elapsed() <= CANDIDATE_TTL
            })
        {
            return None;
        }
        inner.preparing = true;
        Some(inner.epoch)
    }
    fn register_cancel(&self, epoch: u64, cancelled: Arc<AtomicBool>) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.epoch != epoch {
                cancelled.store(true, Ordering::Relaxed);
            }
            inner.cancel = Some(cancelled);
        }
    }
    fn finish(&self, epoch: u64, source: Option<VerifiedSource>) {
        let mut retired = VecDeque::new();
        if let Ok(mut inner) = self.inner.lock() {
            inner.preparing = false;
            inner.cancel = None;
            if inner.epoch == epoch {
                if let Some(mut source) = source {
                    source.serial = inner.next_serial;
                    inner.next_serial = inner.next_serial.wrapping_add(1);
                    for entry in std::mem::take(&mut inner.entries) {
                        if entry.id == source.id || entry.prepared_at.elapsed() > CANDIDATE_TTL {
                            retired.push_back(entry);
                        } else {
                            inner.entries.push_back(entry);
                        }
                    }
                    while inner.entries.len() >= 2 {
                        if let Some(entry) = inner.entries.pop_front() {
                            retired.push_back(entry);
                        }
                    }
                    inner.entries.push_back(source);
                }
            } else if let Some(source) = source {
                retired.push_back(source);
            }
        }
        drop(retired);
    }
    fn start_reaper(&self) -> bool {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.reaping {
                return false;
            }
            inner.reaping = true;
            return true;
        }
        false
    }
    fn expire(&self) -> bool {
        let mut retired = VecDeque::new();
        let mut done = false;
        if let Ok(mut inner) = self.inner.lock() {
            for entry in std::mem::take(&mut inner.entries) {
                if entry.prepared_at.elapsed() > CANDIDATE_TTL {
                    retired.push_back(entry);
                } else {
                    inner.entries.push_back(entry);
                }
            }
            if inner.entries.is_empty() {
                inner.reaping = false;
                done = true;
            }
        }
        drop(retired);
        done
    }
}

/// Optional preparation: never queues behind analysis. No measurement or remote
/// fetch is started here. A missing measurement keeps playback at 0 dB.
pub(crate) fn schedule_candidate(
    state: &Arc<AppState>,
    track_id: String,
    revision: String,
    target_lufs: f64,
    album: bool,
) -> bool {
    let snapshot = state.audio.snapshot();
    if snapshot.track_id.as_deref() != Some(track_id.as_str()) {
        return false;
    }
    schedule_candidate_inner(
        state,
        track_id,
        revision,
        target_lufs,
        album,
        None,
        snapshot.source_generation,
    )
}

pub(crate) fn schedule_next_candidate(
    state: &Arc<AppState>,
    next: crate::state::PreparedPlayback,
    revision: String,
    target_lufs: f64,
    album: bool,
) -> bool {
    schedule_candidate_inner(
        state,
        next.loudness_track_id().to_owned(),
        revision,
        target_lufs,
        album,
        Some(next.clone()),
        next.loudness_source_generation(),
    )
}

fn schedule_candidate_inner(
    state: &Arc<AppState>,
    track_id: String,
    revision: String,
    target_lufs: f64,
    album: bool,
    next: Option<crate::state::PreparedPlayback>,
    source_generation: u64,
) -> bool {
    if !crate::audio_source_snapshot::available()
        || !target_lufs.is_finite()
        || !(-24.0..=-12.0).contains(&target_lufs)
        || revision.len() > 64
        || validate_ids(std::slice::from_ref(&track_id)).is_err()
    {
        return false;
    }
    let Some(epoch) = state
        .loudness_candidates
        .begin(&track_id, &revision, source_generation)
    else {
        return false;
    };
    let state = state.clone();
    tokio::spawn(async move {
        let owner = state.clone();
        let result = with_budget(state.beat_slots.clone(), move |control| async move {
            owner
                .loudness_candidates
                .register_cancel(epoch, control.cancelled.clone());
            let candidate = prepare_candidate_from(
                &owner,
                track_id,
                revision,
                target_lufs,
                album,
                &control,
                next,
                source_generation,
            )
            .await?;
            control.check().map_err(analysis_error)?;
            let ready = candidate.is_some();
            // Publication and retirement are still inside both analysis permits.
            let _commit = owner.play_commit.lock().await;
            if let Some(next) = candidate.as_ref().and_then(|source| source.next.as_ref()) {
                if !owner.loudness_next_matches_locked(next).await {
                    return Err(changed());
                }
            } else if candidate.as_ref().is_some_and(|source| {
                let snapshot = owner.audio.snapshot();
                snapshot.track_id.as_deref() != Some(source.id.as_str())
                    || snapshot.source_generation != source_generation
            }) {
                return Err(changed());
            }
            owner.loudness_candidates.finish(epoch, candidate);
            Ok(ready)
        })
        .await;
        if let Err(ref e) = result {
            tracing::debug!(code = e.code, "loudness candidate deferred");
        }
        let has_source = matches!(result, Ok(true));
        if result.is_err() {
            state.loudness_candidates.finish(epoch, None);
        }
        if has_source {
            state.schedule_prepare_next();
        }
        if has_source && state.loudness_candidates.start_reaper() {
            // Exactly one expiration task per AppState, regardless of fast skips.
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    if state.loudness_candidates.expire() {
                        break;
                    }
                }
            });
        }
    });
    true
}

#[cfg(all(test, any(windows, unix)))]
async fn prepare_candidate(
    state: &Arc<AppState>,
    id: String,
    revision: String,
    target: f64,
    album_mode: bool,
    control: &Control,
) -> ApiResult<Option<VerifiedSource>> {
    prepare_candidate_from(
        state,
        id,
        revision,
        target,
        album_mode,
        control,
        None,
        state.audio.snapshot().source_generation,
    )
    .await
}

#[allow(clippy::too_many_arguments)] // One candidate's identity, target and the handoff it must match.
async fn prepare_candidate_from(
    state: &Arc<AppState>,
    id: String,
    revision: String,
    target: f64,
    album_mode: bool,
    control: &Control,
    next: Option<crate::state::PreparedPlayback>,
    source_generation: u64,
) -> ApiResult<Option<VerifiedSource>> {
    if !crate::audio_source_snapshot::available() {
        return Err(error(
            "loudness_snapshot_unavailable",
            "当前系统尚未实现可证明不可变的播放源快照；本机测量可用，自动应用暂不可用",
        ));
    }
    control.check().map_err(analysis_error)?;
    let Some(track) = vmusic_store::loudness::get_track(&state.db, &id)
        .await
        .map_err(CoreError::from)?
        .filter(|t| t.algorithm == loudness::ALGORITHM)
    else {
        return Ok(None);
    };
    let album = if album_mode {
        vmusic_store::loudness::get_album_for_track(&state.db, &id)
            .await
            .map_err(CoreError::from)?
    } else {
        None
    };
    if album_mode
        && album
            .as_ref()
            .is_none_or(|a| a.algorithm != loudness::ALGORITHM)
    {
        return Ok(None);
    }
    let mut gain = if let Some(a) = &album {
        selection(a.integrated_lufs, a.true_peak, &a.state, target, true)
    } else {
        selection(
            track.integrated_lufs,
            track.true_peak,
            &track.state,
            target,
            false,
        )
    };
    if gain.state != "ready" {
        return Ok(None);
    }
    let members = album.map(|a| a.members).unwrap_or_else(|| {
        vec![Member {
            track_id: id.clone(),
            sha256: track.sha256,
            byte_length: track.byte_length,
        }]
    });
    let ids: Vec<String> = members.iter().map(|m| m.track_id.clone()).collect();
    validate_ids(&ids)?;
    if album_mode {
        check_complete_album(state, &ids).await?;
    }
    let mut held = Vec::with_capacity(members.len());
    for member in members {
        control.check().map_err(analysis_error)?;
        let source = if let Some(next) = next
            .as_ref()
            .filter(|next| next.loudness_track_id() == member.track_id)
        {
            if !state.loudness_next_matches(next).await {
                return Err(changed());
            }
            Source {
                id: member.track_id.clone(),
                path: next.loudness_path().to_path_buf(),
                generation: None,
                next: Some(next.clone()),
            }
        } else {
            resolve(state, &member.track_id).await?
        };
        let work_source = source.clone();
        let c = control.clone();
        let file = tokio::task::spawn_blocking(move || {
            let mut guard = StableFile::open(&work_source.path, &c)?;
            let (sha256, bytes) = fingerprint_guard(&mut guard, &c)?;
            if sha256 != member.sha256 || bytes != member.byte_length {
                return Err(changed());
            }
            guard.verify_original(&c)?;
            Ok::<_, ApiError>(guard)
        })
        .await
        .map_err(|_| analysis_error(AnalyzeError::Decode))??;
        verify_owner(state, &source).await?;
        held.push((source, file));
    }
    for (source, _) in &held {
        verify_owner(state, source).await?;
    }
    if album_mode {
        check_complete_album(state, &ids).await?;
    }
    control.check().map_err(analysis_error)?;
    let index = held
        .iter()
        .position(|(source, _)| source.id == id)
        .ok_or_else(changed)?;
    let (source, mut file) = held.swap_remove(index);
    let len = file.len();
    gain.source_sha256 = Some(file.fingerprint(control)?.0);
    Ok(Some(VerifiedSource {
        serial: 0,
        id,
        revision,
        path: source.path,
        prepared_at: Instant::now(),
        source_generation,
        source: StableAudioSource {
            file,
            _album_guards: held.into_iter().map(|(_, file)| file).collect(),
            len,
        },
        gain,
        next,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AnalyzeRequest {
    pub track_ids: Vec<String>,
    /// Multiple IDs always mean a complete album. This also permits one-track albums.
    #[serde(default)]
    pub album: bool,
}
#[derive(Debug, Clone, Serialize)]
pub(crate) struct GainSelection {
    /// Filled only after the selected immutable source passes complete fingerprint verification.
    pub source_sha256: Option<String>,
    pub state: String,
    pub gain_db: f64,
    pub requested_gain_db: Option<f64>,
    pub integrated_lufs: Option<f64>,
    pub limited_by: Option<&'static str>,
    pub album: bool,
}
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

async fn with_budget<T, F, Fut>(slots: Arc<Semaphore>, work: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce(Control) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ApiResult<T>> + Send + 'static,
{
    let permit = slots.try_acquire_owned().map_err(|_| busy())?;
    let reader = READER.clone().try_acquire_owned().map_err(|_| busy())?;
    let control = Control {
        until: Instant::now() + DEADLINE,
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    let _cancel = CancelOnDrop(control.cancelled.clone());
    let until = control.until;
    // The detached owner continues to await I/O and commit after its observer
    // disappears; cancellation does not release either allowance prematurely.
    let owner = tokio::spawn(async move {
        let (_permit, _reader) = (permit, reader);
        work(control).await
    });
    tokio::time::timeout_at(until.into(), owner)
        .await
        .map_err(|_| timeout())?
        .map_err(|_| analysis_error(AnalyzeError::Decode))?
}

fn error(code: &'static str, message: &str) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, code, message)
}
fn busy() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "loudness_busy",
        "后台音频分析正忙，请稍后再试",
    )
}
fn changed() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "loudness_media_changed",
        "媒体内容或专辑成员已改变，请重新分析",
    )
}
fn timeout() -> ApiError {
    ApiError::new(
        StatusCode::REQUEST_TIMEOUT,
        "loudness_timeout",
        "响度分析超过 120 秒期限，请稍后重试",
    )
}
pub(crate) fn analysis_error(e: AnalyzeError) -> ApiError {
    match e {
        AnalyzeError::Deadline => timeout(),
        AnalyzeError::Cancelled => error("loudness_cancelled", "响度分析已取消"),
        AnalyzeError::Unsupported => error(
            "loudness_unsupported",
            "仅支持可精确裁剪的 44.1/48/96 kHz 单声道或双声道音频",
        ),
        AnalyzeError::Decode => error(
            "loudness_decode_failed",
            "无法完整解码此音频，原测量结果已保留",
        ),
        AnalyzeError::Limit => error(
            "loudness_limit",
            "此音频超出流式分析预算（每轨 6 小时，专辑最多一百万个门限块）",
        ),
    }
}
#[cfg(test)]
fn media_error(e: ApiError) -> ApiError {
    match e.code {
        "project_media_timeout" => timeout(),
        "project_media_changed" => changed(),
        "project_media_size" => error("loudness_size", "文件超过 2 GiB 完整指纹读取上限"),
        _ if e.code.starts_with("loudness_") => e,
        _ => error(
            "loudness_unavailable",
            "无法读取稳定的完整本地文件或已完成缓存",
        ),
    }
}
fn state_name(state: MeasurementState) -> &'static str {
    match state {
        MeasurementState::Measured => "measured",
        MeasurementState::Silence => "silence",
        MeasurementState::InsufficientBlocks => "insufficient_blocks",
        MeasurementState::BelowGate => "below_gate",
    }
}
fn validate_ids(ids: &[String]) -> ApiResult<()> {
    if ids.is_empty()
        || ids.len() > MAX_MEMBERS
        || ids.iter().any(|id| id.is_empty() || id.len() > 256)
        || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
    {
        return Err(bad_request("请选择 1 至 128 首不重复的曲目"));
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct Source {
    id: String,
    pub(crate) path: PathBuf,
    generation: Option<u64>,
    next: Option<crate::state::PreparedPlayback>,
}

/// Hash the leased handle itself. Reopening its path could select a different
/// symlink/junction target even when the original target denies replacement.
fn fingerprint_guard(file: &mut StableFile, control: &Control) -> ApiResult<(String, u64)> {
    file.fingerprint(control)
}

struct Witness {
    source: Source,
    file: StableFile,
}
impl Witness {
    fn verify(&mut self, control: &Control) -> ApiResult<()> {
        self.file.verify_original(control)
    }
}
pub(crate) async fn resolve(state: &Arc<AppState>, id: &str) -> ApiResult<Source> {
    let (path, generation) = if crate::online::split_virtual_id(id).is_some() {
        let generation = state.audio.snapshot().source_generation;
        (
            state
                .project_online_media(id)
                .await
                .ok_or_else(|| error("loudness_incomplete", "当前在线曲目的完整缓存尚不可用"))?,
            Some(generation),
        )
    } else {
        let track = vmusic_store::get_track(&state.db, &id.to_owned())
            .await
            .map_err(CoreError::from)?
            .ok_or_else(|| not_found("未找到曲库曲目"))?;
        if track.source != TrackSource::Local {
            return Err(error(
                "loudness_local_only",
                "此分析只读取本地文件或播放已确认的完整缓存，不发起远程下载",
            ));
        }
        (PathBuf::from(track.path), None)
    };
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("part"))
    {
        return Err(error("loudness_incomplete", "渐进下载文件尚未完成"));
    }
    Ok(Source {
        id: id.to_owned(),
        path,
        generation,
        next: None,
    })
}
pub(crate) async fn verify_owner(state: &Arc<AppState>, source: &Source) -> ApiResult<()> {
    if let Some(next) = &source.next {
        if !state.loudness_next_matches(next).await {
            return Err(changed());
        }
    } else if let Some(generation) = source.generation {
        if state.audio.snapshot().source_generation != generation
            || state.project_online_media(&source.id).await.as_ref() != Some(&source.path)
        {
            return Err(changed());
        }
    } else {
        let track = vmusic_store::get_track(&state.db, &source.id)
            .await
            .map_err(CoreError::from)?
            .ok_or_else(changed)?;
        if track.source != TrackSource::Local || Path::new(&track.path) != source.path {
            return Err(changed());
        }
    }
    Ok(())
}

/// Matches the library's effective album view, including metadata edits.
async fn check_complete_album(state: &Arc<AppState>, ids: &[String]) -> ApiResult<()> {
    let first = vmusic_store::get_track(&state.db, &ids[0])
        .await
        .map_err(CoreError::from)?
        .ok_or_else(changed)?;
    let album = first
        .album
        .filter(|a| !a.trim().is_empty())
        .ok_or_else(|| error("loudness_album_required", "专辑分析需要完整的曲库专辑成员"))?;
    let filter = vmusic_store::TrackFilter {
        album: Some(album),
        artist: None,
    };
    let count = vmusic_store::count_tracks_filtered(&state.db, None, &filter)
        .await
        .map_err(CoreError::from)?;
    if count as usize != ids.len() {
        return Err(error(
            "loudness_album_incomplete",
            "请选择完整专辑；部分曲目不能生成专辑响度",
        ));
    }
    let members = vmusic_store::list_track_ids_filtered(
        &state.db,
        None,
        &filter,
        vmusic_store::TrackSort::Title,
    )
    .await
    .map_err(CoreError::from)?;
    if members.iter().collect::<BTreeSet<_>>() != ids.iter().collect::<BTreeSet<_>>() {
        return Err(changed());
    }
    Ok(())
}

fn scan(
    source: &Source,
    stored: Option<TrackMeasurement>,
    remeasure: bool,
    control: &Control,
) -> ApiResult<(TrackMeasurement, Vec<f64>, bool, Witness)> {
    let mut guard = StableFile::open(&source.path, control)?;
    let (sha256, bytes) = fingerprint_guard(&mut guard, control)?;
    let cached = stored.filter(|s| {
        !remeasure
            && s.sha256 == sha256
            && s.byte_length == bytes
            && s.algorithm == loudness::ALGORITHM
    });
    let (measurement, energies, was_cached) = if let Some(stored) = cached {
        (stored, Vec::new(), true)
    } else {
        let analysis = loudness::analyze_file(guard.try_clone().map_err(|_| changed())?, control)
            .map_err(analysis_error)?;
        let m = analysis.measurement;
        (
            TrackMeasurement {
                track_id: source.id.clone(),
                sha256: sha256.clone(),
                byte_length: bytes,
                algorithm: loudness::ALGORITHM.into(),
                state: state_name(m.state).into(),
                integrated_lufs: m.integrated_lufs,
                sample_peak: m.sample_peak,
                true_peak: m.true_peak,
                sample_rate: m.sample_rate,
                channels: m.channels,
                channel_mask: m.channel_mask,
                frames: m.frames,
                gated_blocks: m.gated_blocks,
            },
            analysis.block_energies,
            false,
        )
    };
    control.check().map_err(analysis_error)?;
    guard.verify_original(control)?;
    let witness = Witness {
        source: source.clone(),
        file: guard,
    };
    Ok((measurement, energies, was_cached, witness))
}

pub(crate) async fn request(state: &Arc<AppState>, request: AnalyzeRequest) -> ApiResult<Value> {
    validate_ids(&request.track_ids)?;
    let slots = state.beat_slots.clone();
    let state = state.clone();
    with_budget(slots, move |control| async move {
        let is_album = request.album || request.track_ids.len() > 1;
        if is_album {
            check_complete_album(&state, &request.track_ids).await?;
        }
        let mut results = Vec::with_capacity(request.track_ids.len());
        let mut sources = Vec::with_capacity(request.track_ids.len());
        let mut energies = if is_album {
            Vec::with_capacity(loudness::MAX_ALBUM_BLOCKS)
        } else {
            Vec::new()
        };
        let mut all_cached = true;
        for id in &request.track_ids {
            control.check().map_err(analysis_error)?;
            let source = resolve(&state, id).await?;
            let stored = vmusic_store::loudness::get_track(&state.db, id)
                .await
                .map_err(CoreError::from)?;
            let work_source = source.clone();
            let work_control = control.clone();
            let (measurement, blocks, cached, witness) = tokio::task::spawn_blocking(move || {
                scan(&work_source, stored, is_album, &work_control)
            })
            .await
            .map_err(|_| analysis_error(AnalyzeError::Decode))??;
            verify_owner(&state, &source).await?;
            if is_album {
                if blocks.len() > loudness::MAX_ALBUM_BLOCKS - energies.len() {
                    return Err(analysis_error(AnalyzeError::Limit));
                }
                energies.extend_from_slice(&blocks);
            }
            all_cached &= cached;
            results.push(measurement);
            sources.push(witness);
        }
        for witness in &sources {
            verify_owner(&state, &witness.source).await?;
        }
        let c = control.clone();
        let sources = tokio::task::spawn_blocking(move || {
            for witness in &mut sources {
                witness.verify(&c)?;
            }
            Ok::<_, ApiError>(sources)
        })
        .await
        .map_err(|_| analysis_error(AnalyzeError::Decode))??;
        if is_album {
            check_complete_album(&state, &request.track_ids).await?;
        }
        let album = if is_album {
            let mut members: Vec<Member> = results
                .iter()
                .map(|r| Member {
                    track_id: r.track_id.clone(),
                    sha256: r.sha256.clone(),
                    byte_length: r.byte_length,
                })
                .collect();
            members.sort_by(|a, b| a.track_id.cmp(&b.track_id));
            let ids: Vec<&str> = members.iter().map(|m| m.track_id.as_str()).collect();
            let album_key = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&ids).map_err(|_| bad_request("无效专辑成员"))?)
            );
            let (integrated_lufs, gated_blocks) = loudness::gated_loudness(&energies);
            let sample_peak = results.iter().map(|r| r.sample_peak).fold(0.0f64, f64::max);
            let true_peak = results.iter().map(|r| r.true_peak).fold(0.0f64, f64::max);
            let result_state = if integrated_lufs.is_some() {
                "measured"
            } else if sample_peak == 0.0 {
                "silence"
            } else if energies.is_empty() {
                "insufficient_blocks"
            } else {
                "below_gate"
            };
            Some(AlbumMeasurement {
                album_key,
                algorithm: loudness::ALGORITHM.into(),
                members,
                state: result_state.into(),
                integrated_lufs,
                sample_peak,
                true_peak,
                gated_blocks,
            })
        } else {
            None
        };
        control.check().map_err(analysis_error)?;
        vmusic_store::loudness::save_success(&state.db, &results, album.as_ref())
            .await
            .map_err(CoreError::from)?;
        drop(sources);
        Ok::<_, ApiError>(
            json!({"state":"stored", "algorithm":loudness::ALGORITHM, "cached":all_cached,
            "tracks":results, "album":album, "applied":false}),
        )
    })
    .await
}

/// Inspection never claims the stored fingerprint is still the playback source.
pub(crate) async fn status(state: &Arc<AppState>, track_id: &str) -> ApiResult<Value> {
    validate_ids(&[track_id.to_owned()])?;
    let track = vmusic_store::loudness::get_track(&state.db, track_id)
        .await
        .map_err(CoreError::from)?;
    let album = vmusic_store::loudness::get_album_for_track(&state.db, track_id)
        .await
        .map_err(CoreError::from)?;
    let state_name = if track
        .as_ref()
        .is_some_and(|r| r.algorithm == loudness::ALGORITHM)
    {
        "stored_unverified"
    } else {
        "not_analyzed"
    };
    Ok(
        json!({"state":state_name, "track":track, "album":album, "identity_verified":false,
        "busy":READER.available_permits()==0, "algorithm":loudness::ALGORITHM,
        "verified_source_available":crate::audio_source_snapshot::available(),
        "snapshot_strategy":if cfg!(windows){"read_sharing_lease"}else{"unlinked_read_only_copy"},
        "snapshot_disk_limit_bytes":crate::audio_source_snapshot::MAX_SNAPSHOT_BYTES,
        "candidate_ready":state.loudness_candidates.ready_for_track(track_id), "candidate_unavailable_reason":
        if crate::audio_source_snapshot::available() {None} else {Some("immutable_file_snapshot_unavailable")}}),
    )
}

fn selection(lufs: Option<f64>, peak: f64, state: &str, target: f64, album: bool) -> GainSelection {
    let Some(lufs) = lufs.filter(|v| v.is_finite() && state == "measured") else {
        return GainSelection {
            source_sha256: None,
            state: state.into(),
            gain_db: 0.0,
            requested_gain_db: None,
            integrated_lufs: None,
            limited_by: None,
            album,
        };
    };
    let requested = target - lufs;
    let ranged = requested.clamp(-24.0, 12.0);
    // Keep 1 dB of true-peak headroom. Parent separately gates boosts on the
    // selected final protection policy; this does not promise processed LUFS.
    let peak_gain = if peak > 0.0 {
        -1.0 - 20.0 * peak.log10()
    } else {
        0.0
    };
    let gain = ranged.min(peak_gain).max(-24.0);
    let limited_by = if gain < ranged {
        Some("true_peak")
    } else if ranged != requested {
        Some("gain_range")
    } else {
        None
    };
    GainSelection {
        source_sha256: None,
        state: "ready".into(),
        gain_db: gain,
        requested_gain_db: Some(requested),
        integrated_lufs: Some(lufs),
        limited_by,
        album,
    }
}

/// Explicit preflight/application helper. Full identity reads happen off-thread
/// under the same allowance. Never call synchronously from the audio callback.
/// The playback owner decides whether/when to adopt this fixed candidate.
#[cfg(test)]
pub(crate) async fn gain_for_track(
    state: &Arc<AppState>,
    track: &Track,
    target_lufs: f64,
    album_mode: bool,
) -> ApiResult<GainSelection> {
    gain_for_id(state, &track.id, target_lufs, album_mode).await
}
#[cfg(test)]
pub(crate) async fn gain_for_id(
    state: &Arc<AppState>,
    id: &str,
    target_lufs: f64,
    album_mode: bool,
) -> ApiResult<GainSelection> {
    if !target_lufs.is_finite() || !(-24.0..=-12.0).contains(&target_lufs) {
        return Err(bad_request("目标响度必须为 −24 至 −12 LUFS"));
    }
    validate_ids(&[id.to_owned()])?;
    let track = vmusic_store::loudness::get_track(&state.db, id)
        .await
        .map_err(CoreError::from)?;
    let album = if album_mode {
        vmusic_store::loudness::get_album_for_track(&state.db, id)
            .await
            .map_err(CoreError::from)?
    } else {
        None
    };
    let absent = || selection(None, 0.0, "not_analyzed", target_lufs, album_mode);
    let Some(track) = track.filter(|t| t.algorithm == loudness::ALGORITHM) else {
        return Ok(absent());
    };
    if album_mode
        && album
            .as_ref()
            .is_none_or(|a| a.algorithm != loudness::ALGORITHM)
    {
        return Ok(absent());
    }
    let members = album
        .as_ref()
        .map(|a| a.members.clone())
        .unwrap_or_else(|| {
            vec![Member {
                track_id: track.track_id.clone(),
                sha256: track.sha256.clone(),
                byte_length: track.byte_length,
            }]
        });
    validate_ids(
        &members
            .iter()
            .map(|m| m.track_id.clone())
            .collect::<Vec<_>>(),
    )?;
    let slots = state.beat_slots.clone();
    let state = state.clone();
    with_budget(slots, move |control| async move {
        let ids: Vec<String> = members.iter().map(|m| m.track_id.clone()).collect();
        if album_mode {
            check_complete_album(&state, &ids).await?;
        }
        for member in members {
            control.check().map_err(analysis_error)?;
            let source = resolve(&state, &member.track_id).await?;
            let path = source.path.clone();
            let c = control.clone();
            let identity = tokio::task::spawn_blocking(move || {
                crate::stage_project::fingerprinted_file(&path, c.until, || {
                    c.check().map_err(analysis_error)
                })
                .map(|(_, m)| m)
                .map_err(media_error)
            })
            .await
            .map_err(|_| analysis_error(AnalyzeError::Decode))??;
            if identity.sha256 != member.sha256
                || identity.byte_length != member.byte_length.to_string()
            {
                return Err(changed());
            }
            verify_owner(&state, &source).await?;
        }
        control.check().map_err(analysis_error)?;
        Ok::<_, ApiError>(if let Some(a) = album {
            selection(a.integrated_lufs, a.true_peak, &a.state, target_lufs, true)
        } else {
            selection(
                track.integrated_lufs,
                track.true_peak,
                &track.state,
                target_lufs,
                false,
            )
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_gain_is_peak_limited_and_silence_is_not_amplified() {
        let gain = selection(Some(-30.0), 0.8, "measured", -18.0, false);
        assert!(gain.gain_db < 1.0);
        assert_eq!(gain.limited_by, Some("true_peak"));
        assert_eq!(selection(None, 0.0, "silence", -18.0, false).gain_db, 0.0);
        assert_eq!(
            selection(Some(-80.0), 0.0, "below_gate", -18.0, false).gain_db,
            0.0
        );
        assert!(validate_ids(&["same".into(), "same".into()]).is_err());
    }

    #[test]
    fn next_preparation_coalesces_notifications_without_an_unbounded_queue() {
        let candidates = Candidates::default();
        assert!(candidates.request_next_worker());
        for _ in 0..100 {
            assert!(!candidates.request_next_worker());
        }
        assert!(candidates.finish_next_worker());
        assert!(!candidates.finish_next_worker());
        assert!(candidates.request_next_worker());
        assert!(!candidates.finish_next_worker());
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn new_source_generation_does_not_deduplicate_against_stale_candidate() {
        let path = std::env::temp_dir().join(format!(
            "hertz-candidate-generation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"source").unwrap();
        let control = Control {
            until: Instant::now() + DEADLINE,
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let file = StableFile::open(&path, &control).unwrap();
        let len = file.len();
        let candidates = Candidates::default();
        let epoch = candidates.begin("track", "17", 1).unwrap();
        candidates.finish(
            epoch,
            Some(VerifiedSource {
                serial: 0,
                id: "track".into(),
                revision: "17".into(),
                path: path.clone(),
                prepared_at: Instant::now(),
                source_generation: 1,
                source: StableAudioSource {
                    file,
                    _album_guards: Vec::new(),
                    len,
                },
                gain: selection(Some(-20.0), 0.5, "measured", -18.0, false),
                next: None,
            }),
        );
        assert!(candidates.begin("track", "17", 1).is_none());
        #[cfg(unix)]
        {
            std::fs::write(&path, b"changed source length").unwrap();
            let epoch = candidates.begin("track", "17", 1).unwrap();
            candidates.finish(epoch, None);
        }
        let epoch = candidates.begin("track", "17", 2).unwrap();
        candidates.finish(epoch, None);
        candidates.invalidate();
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(any(windows, unix))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn next_online_candidate_requires_playback_confirmed_path_and_intent() {
        let _serial = ANALYSIS_TEST_SERIAL.lock().await;
        let dir =
            std::env::temp_dir().join(format!("hertz-next-loudness-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (mut state, actor) = crate::state::tests::playback_state_with_db(db).await;
        let cache = dir.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        state.cache_index = Arc::new(crate::online::cache::CacheIndex::load(cache.clone()).await);
        state.data_dir = dir.clone();
        let state = Arc::new(state);
        let id = "online:ccmixter:future";
        let path = cache.join(format!(
            "{}.wav",
            crate::online::cache::cache_key("ccmixter", "future", "standard")
        ));
        write_wav(&path, 0.1);
        state.cache_index.note_written(&path).await;
        let control = Control {
            until: Instant::now() + DEADLINE,
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let mut file = StableFile::open(&path, &control).unwrap();
        let (sha256, byte_length) = fingerprint_guard(&mut file, &control).unwrap();
        let m = loudness::analyze_file(file.try_clone().unwrap(), &control)
            .unwrap()
            .measurement;
        drop(file);
        vmusic_store::loudness::save_success(
            &state.db,
            &[TrackMeasurement {
                track_id: id.into(),
                sha256,
                byte_length,
                algorithm: loudness::ALGORITHM.into(),
                state: state_name(m.state).into(),
                integrated_lufs: m.integrated_lufs,
                sample_peak: m.sample_peak,
                true_peak: m.true_peak,
                sample_rate: m.sample_rate,
                channels: m.channels,
                channel_mask: m.channel_mask,
                frames: m.frames,
                gated_blocks: m.gated_blocks,
            }],
            None,
        )
        .await
        .unwrap();
        let next = crate::state::tests::loudness_next_fixture(
            &state,
            id,
            path.clone(),
            Some(crate::online::quality::Quality::Standard),
        )
        .await;
        assert!(
            state.project_online_media(id).await.is_none(),
            "target is not current playback"
        );
        let verified = prepare_candidate_from(
            &state,
            id.into(),
            "7".into(),
            -18.0,
            false,
            &control,
            Some(next.clone()),
            next.loudness_source_generation(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(verified.path, path);
        assert!(verified.gain.integrated_lufs.is_some());
        drop(verified);
        state.seek_control(2000).await.unwrap();
        assert!(!state.loudness_next_matches(&next).await);
        assert_eq!(
            prepare_candidate_from(
                &state,
                id.into(),
                "7".into(),
                -18.0,
                false,
                &control,
                Some(next.clone()),
                next.loudness_source_generation(),
            )
            .await
            .err()
            .unwrap()
            .code,
            "loudness_media_changed"
        );
        state.audio.shutdown();
        actor.join().unwrap();
        state.db.close().await;
        drop(state);
        crate::state::tests::remove_dir_settled(dir).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_observer_retains_slots_until_blocking_and_async_work_exit() {
        let _serial = ANALYSIS_TEST_SERIAL.lock().await;
        let slots = Arc::new(Semaphore::new(2));
        let task_slots = slots.clone();
        let (started_tx, started) = tokio::sync::oneshot::channel();
        let (release_io, io_gate) = std::sync::mpsc::channel();
        let (persist_tx, persist) = tokio::sync::oneshot::channel();
        let (release_db, db_gate) = tokio::sync::oneshot::channel();
        let observer = tokio::spawn(with_budget(task_slots, move |control| async move {
            tokio::task::spawn_blocking(move || {
                let _ = started_tx.send(());
                let _ = io_gate.recv();
            })
            .await
            .unwrap();
            let _ = persist_tx.send(());
            let _ = db_gate.await;
            control.check().map_err(analysis_error)
        }));
        started.await.unwrap();
        observer.abort();
        let _ = observer.await;
        assert_eq!(slots.available_permits(), 1);
        assert_eq!(READER.available_permits(), 0);
        release_io.send(()).unwrap();
        persist.await.unwrap();
        assert_eq!(slots.available_permits(), 1);
        assert_eq!(READER.available_permits(), 0);
        release_db.send(()).unwrap();
        let all = tokio::time::timeout(Duration::from_secs(2), slots.clone().acquire_many_owned(2))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(READER.available_permits(), 1);
        drop(all);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn candidate_rejects_same_path_replacement_after_snapshot() {
        let _serial = ANALYSIS_TEST_SERIAL.lock().await;
        let dir =
            std::env::temp_dir().join(format!("hertz-loudness-replace-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (state, audio) = crate::state::tests::playback_state_with_db(db).await;
        let state = Arc::new(state);
        let track = Track {
            id: "replace".into(),
            path: dir.join("replace.wav").to_string_lossy().into_owned(),
            source: TrackSource::Local,
            title: "Replace".into(),
            artist: None,
            album: None,
            duration_ms: Some(2000),
            bitrate: None,
            sample_rate: Some(48_000),
            channels: Some(1),
            has_cover: false,
            file_mtime: None,
            file_size: None,
            added_at: 0,
        };
        write_wav(Path::new(&track.path), 0.1);
        vmusic_store::upsert_track(&state.db, &track).await.unwrap();
        request(
            &state,
            AnalyzeRequest {
                track_ids: vec![track.id.clone()],
                album: false,
            },
        )
        .await
        .unwrap();
        let control = Control {
            until: Instant::now() + DEADLINE,
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let candidate = prepare_candidate(
            &state,
            track.id.clone(),
            "17".into(),
            -18.0,
            false,
            &control,
        )
        .await
        .unwrap()
        .unwrap();
        let candidates = Candidates::default();
        let source_generation = state.audio.snapshot().source_generation;
        let epoch = candidates
            .begin(&track.id, "17", source_generation)
            .unwrap();
        candidates.finish(epoch, Some(candidate));
        let replacement = dir.join("replacement.wav");
        write_wav(&replacement, 0.2);
        std::fs::rename(&replacement, Path::new(&track.path)).unwrap();
        assert!(candidates
            .ready_for_load(&track.id, "17", Path::new(&track.path), source_generation)
            .await
            .is_none());
        candidates.invalidate();
        assert!(candidates
            .take_for_load(
                &track.id,
                "17",
                Path::new(&track.path),
                source_generation,
                0,
            )
            .is_none());
        state.audio.shutdown();
        audio.join().unwrap();
        state.db.close().await;
        crate::state::tests::remove_dir_settled(dir).await;
    }

    fn write_wav(path: &Path, gain: f64) {
        let pcm: Vec<u8> = (0..96_000)
            .flat_map(|i| {
                let sample = (gain
                    * 32767.0
                    * (f64::from(i) * 1000.0 * std::f64::consts::TAU / 48_000.0).sin())
                    as i16;
                sample.to_le_bytes()
            })
            .collect();
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
        bytes.extend_from_slice(&48_000u32.to_le_bytes());
        bytes.extend_from_slice(&96_000u32.to_le_bytes());
        bytes.extend_from_slice(b"\x02\0\x10\0data");
        bytes.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&pcm);
        std::fs::write(path, bytes).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn complete_sources_cache_identity_album_and_failure_preservation() {
        let _serial = ANALYSIS_TEST_SERIAL.lock().await;
        let dir = std::env::temp_dir().join(format!("hertz-loudness-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
        state.data_dir = dir.clone();
        let state = Arc::new(state);
        let track = Track {
            id: "loud".into(),
            path: dir.join("a.wav").to_string_lossy().into_owned(),
            source: TrackSource::Local,
            title: "A".into(),
            artist: None,
            album: Some("Album".into()),
            duration_ms: Some(2000),
            bitrate: None,
            sample_rate: Some(48_000),
            channels: Some(1),
            has_cover: false,
            file_mtime: None,
            file_size: None,
            added_at: 0,
        };
        write_wav(Path::new(&track.path), 0.1);
        vmusic_store::upsert_track(&state.db, &track).await.unwrap();
        let mut quiet = track.clone();
        quiet.id = "quiet".into();
        quiet.path = dir.join("b.wav").to_string_lossy().into_owned();
        write_wav(Path::new(&quiet.path), 0.01);
        vmusic_store::upsert_track(&state.db, &quiet).await.unwrap();
        let req = || AnalyzeRequest {
            track_ids: vec![track.id.clone()],
            album: false,
        };
        let occupied = state
            .beat_slots
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        assert_eq!(
            request(&state, req()).await.unwrap_err().code,
            "loudness_busy"
        );
        drop(occupied);
        let initial = request(&state, req()).await.unwrap();
        assert_eq!(initial["cached"], false);
        assert_eq!(initial["applied"], false);
        assert_eq!(request(&state, req()).await.unwrap()["cached"], true);
        assert_eq!(
            gain_for_track(&state, &track, -18.0, false)
                .await
                .unwrap()
                .state,
            "ready"
        );
        assert_eq!(
            gain_for_track(&state, &track, -18.0, true)
                .await
                .unwrap()
                .state,
            "not_analyzed"
        );
        assert_eq!(
            request(
                &state,
                AnalyzeRequest {
                    track_ids: vec![track.id.clone()],
                    album: true
                }
            )
            .await
            .unwrap_err()
            .code,
            "loudness_album_incomplete"
        );
        let album = request(
            &state,
            AnalyzeRequest {
                track_ids: vec![track.id.clone(), quiet.id.clone()],
                album: true,
            },
        )
        .await
        .unwrap();
        let album_lufs = album["album"]["integrated_lufs"].as_f64().unwrap();
        assert!((album_lufs - album["tracks"][0]["integrated_lufs"].as_f64().unwrap()).abs() < 0.2);
        let loud_gain = gain_for_track(&state, &track, -18.0, true)
            .await
            .unwrap()
            .gain_db;
        let quiet_gain = gain_for_track(&state, &quiet, -18.0, true)
            .await
            .unwrap()
            .gain_db;
        assert_eq!(loud_gain, quiet_gain);
        #[cfg(any(windows, unix))]
        {
            let c = Control {
                until: Instant::now() + DEADLINE,
                cancelled: Arc::new(AtomicBool::new(false)),
            };
            let candidate =
                prepare_candidate(&state, track.id.clone(), "17".into(), -18.0, true, &c)
                    .await
                    .unwrap()
                    .unwrap();
            // Exact bytes remain protected even when another member supplied
            // the album's loudness/true-peak limit.
            #[cfg(windows)]
            {
                assert!(std::fs::OpenOptions::new()
                    .write(true)
                    .open(&track.path)
                    .is_err());
                assert!(std::fs::OpenOptions::new()
                    .write(true)
                    .open(&quiet.path)
                    .is_err());
            }
            let candidates = Candidates::default();
            let source_generation = state.audio.snapshot().source_generation;
            let epoch = candidates
                .begin(&track.id, "17", source_generation)
                .unwrap();
            candidates.finish(epoch, Some(candidate));
            let serial = candidates
                .ready_for_load(&track.id, "17", Path::new(&track.path), source_generation)
                .await
                .unwrap();
            assert!(candidates
                .take_for_load(
                    &track.id,
                    "18",
                    Path::new(&track.path),
                    source_generation,
                    serial,
                )
                .is_none());
            assert!(candidates
                .take_for_load(
                    &track.id,
                    "17",
                    Path::new(&track.path),
                    source_generation + 1,
                    serial,
                )
                .is_none());
            assert!(candidates
                .take_for_load(
                    &track.id,
                    "17",
                    Path::new(&track.path),
                    source_generation,
                    serial + 1,
                )
                .is_none());
            let verified = candidates
                .take_for_load(
                    &track.id,
                    "17",
                    Path::new(&track.path),
                    source_generation,
                    serial,
                )
                .unwrap();
            assert!(candidates
                .take_for_load(
                    &track.id,
                    "17",
                    Path::new(&track.path),
                    source_generation,
                    serial,
                )
                .is_none());
            let (mut source, ext, gain) = verified.into_parts();
            let mut header = [0u8; 4];
            source.read_exact(&mut header).unwrap();
            assert_eq!(&header, b"RIFF");
            assert_eq!(ext.as_deref(), Some("wav"));
            assert_eq!(gain.gain_db, loud_gain);
            drop(source);
            assert!(std::fs::OpenOptions::new()
                .write(true)
                .open(&track.path)
                .is_ok());
            assert!(std::fs::OpenOptions::new()
                .write(true)
                .open(&quiet.path)
                .is_ok());
            #[cfg(unix)]
            {
                let candidate =
                    prepare_candidate(&state, track.id.clone(), "17".into(), -18.0, true, &c)
                        .await
                        .unwrap()
                        .unwrap();
                let epoch = candidates
                    .begin(&track.id, "17", source_generation)
                    .unwrap();
                candidates.finish(epoch, Some(candidate));
                let replacement = dir.join("quiet-replacement.wav");
                write_wav(&replacement, 0.02);
                std::fs::rename(&replacement, Path::new(&quiet.path)).unwrap();
                assert!(candidates
                    .ready_for_load(&track.id, "17", Path::new(&track.path), source_generation)
                    .await
                    .is_none());
                candidates.invalidate();
            }
        }
        let saved = vmusic_store::loudness::get_track(&state.db, &track.id)
            .await
            .unwrap()
            .unwrap();
        write_wav(Path::new(&track.path), 0.2);
        assert_eq!(
            gain_for_track(&state, &track, -18.0, false)
                .await
                .unwrap_err()
                .code,
            "loudness_media_changed"
        );
        std::fs::write(&track.path, b"broken audio").unwrap();
        assert!(request(&state, req()).await.is_err());
        assert_eq!(
            vmusic_store::loudness::get_track(&state.db, &track.id)
                .await
                .unwrap()
                .unwrap()
                .sha256,
            saved.sha256
        );
        assert_eq!(
            status(&state, &track.id).await.unwrap()["identity_verified"],
            false
        );
        assert_eq!(state.beat_slots.available_permits(), 2);
        assert_eq!(READER.available_permits(), 1);
        assert!(state.audio.snapshot().track_id.is_none());
        state.audio.shutdown();
        audio.join().unwrap();
        state.db.close().await;
        drop(state);
        crate::state::tests::remove_dir_settled(dir).await;
    }
}
