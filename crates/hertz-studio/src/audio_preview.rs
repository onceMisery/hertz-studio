// SPDX-License-Identifier: MIT
//! Temporary auditions use the original playback commit, analysis allowance and DSP mailbox.
use crate::{
    audio_loudness, audio_quality,
    audio_source_snapshot::StableFile,
    error::{bad_request, ApiError},
    state::AppState,
};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Seek,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::OwnedSemaphorePermit;
use vmusic_audio::loudness::{AnalyzeError, Control};
use vmusic_core::{
    audio_preview::{ImpulsePhase, PreviewPlan, PreviewSide},
    CoreError,
};

#[cfg(test)]
mod tests;

const PREPARATION_TIMEOUT: Duration = Duration::from_secs(120);
static CURRENT: Mutex<Option<Arc<Job>>> = Mutex::new(None);
struct Job {
    id: String,
    state_id: usize,
    cancelled: Arc<AtomicBool>,
}
impl Job {
    fn check(&self) -> Result<(), ApiError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(cancelled())
        } else {
            Ok(())
        }
    }
}
struct Observer {
    job: Arc<Job>,
    armed: bool,
}
impl Drop for Observer {
    fn drop(&mut self) {
        if self.armed {
            self.job.cancelled.store(true, Ordering::Release);
        }
    }
}
struct WorkerLease {
    job: Arc<Job>,
    _analysis: OwnedSemaphorePermit,
    _reader: OwnedSemaphorePermit,
}
impl Drop for WorkerLease {
    fn drop(&mut self) {
        let mut current = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_ref().is_some_and(|j| Arc::ptr_eq(j, &self.job)) {
            current.take();
        }
        // Both permits outlive the actual I/O, calculation and actor cleanup.
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewRequest {
    pub request_id: String,
    pub expected_revision: String,
    pub patch: Value,
    #[serde(default = "match_by_default")]
    pub match_loudness: bool,
    pub impulse_path: Option<String>,
    #[serde(default)]
    pub acknowledge_unknown_phase: bool,
}
fn match_by_default() -> bool {
    true
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RequestId {
    pub request_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SelectRequest {
    pub request_id: String,
    pub side: PreviewSide,
}
fn uuid(value: &str) -> Result<String, ApiError> {
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| bad_request("试听请求 ID 必须是 UUID"))
}
fn stale() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "audio_preview_stale",
        "试听准备期间播放、配置或输出已改变，请保留草稿并重新试听",
    )
}
fn cancelled() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "audio_preview_cancelled",
        "试听已取消，正在等待实际准备与清理退出",
    )
}
fn reference_error(error: AnalyzeError) -> ApiError {
    match error {
        AnalyzeError::Cancelled => cancelled(),
        AnalyzeError::Deadline => ApiError::new(
            StatusCode::REQUEST_TIMEOUT,
            "audio_preview_timeout",
            "试听准备超过 120 秒期限，请保留草稿后重试",
        ),
        AnalyzeError::Unsupported => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "audio_preview_unsupported",
            "试听参考仅支持可精确裁剪的 44.1/48/96 kHz 单/双声道本地音频或完整缓存",
        ),
        _ => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "audio_preview_reference_failed",
            "参考片段无法完整解码或超出预算，原播放和保存配置已保留",
        ),
    }
}
fn begin(state: &Arc<AppState>, id: String) -> Result<(Observer, WorkerLease), ApiError> {
    let busy = || {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "audio_preview_busy",
            "后台音频分析正忙或正在取消清理，请稍后再试",
        )
    };
    let analysis = state
        .beat_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| busy())?;
    let reader = audio_loudness::READER
        .clone()
        .try_acquire_owned()
        .map_err(|_| busy())?;
    let job = Arc::new(Job {
        id,
        state_id: Arc::as_ptr(state) as usize,
        cancelled: Arc::new(AtomicBool::new(false)),
    });
    let mut current = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
    if current.is_some() {
        return Err(busy());
    }
    *current = Some(job.clone());
    Ok((
        Observer {
            job: job.clone(),
            armed: true,
        },
        WorkerLease {
            job,
            _analysis: analysis,
            _reader: reader,
        },
    ))
}
pub(crate) fn cancel_preparing(state: &AppState, id: Option<&str>) -> bool {
    let current = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = current.as_ref().filter(|j| {
        j.state_id == state as *const AppState as usize && id.is_none_or(|id| id == j.id)
    }) {
        job.cancelled.store(true, Ordering::Release);
        true
    } else {
        false
    }
}
async fn cancel_actor(state: &AppState, id: Option<String>) -> Result<bool, ApiError> {
    let changed = state
        .audio
        .cancel_quality_preview(id)
        .await
        .map_err(CoreError::from)?;
    if changed {
        let _commit = state.play_commit.lock().await;
        state.transport_committed().await;
    }
    Ok(changed)
}
/// Save and source invalidation withdraw a temporary borrow before preparing their own change.
pub(crate) async fn cancel_for_change(state: &AppState) -> Result<(), ApiError> {
    cancel_preparing(state, None);
    cancel_actor(state, None).await?;
    Ok(())
}
pub(crate) async fn cancel(state: &Arc<AppState>, body: RequestId) -> Result<Value, ApiError> {
    state.require_local_playback()?;
    let id = uuid(&body.request_id)?;
    let preparing = cancel_preparing(state, Some(&id));
    let active = cancel_actor(state, Some(id)).await?;
    Ok(
        json!({"cancelled":preparing || active,"cleaning_up":preparing,"message":if preparing {
        "已请求取消试听，准备退出前保留分析额度"
    } else if active { "试听已结束，已请求恢复保存配置和进入前的位置" } else { "该试听请求已结束，未改变其他请求或保存配置" }}),
    )
}
pub(crate) async fn refresh(state: &Arc<AppState>, body: RequestId) -> Result<Value, ApiError> {
    state.require_local_playback()?;
    let id = uuid(&body.request_id)?;
    let refreshed = state
        .audio
        .refresh_quality_preview(id)
        .await
        .map_err(CoreError::from)?;
    Ok(json!({"refreshed":refreshed,"ttl_ms":vmusic_core::audio_preview::PREVIEW_TTL_MS}))
}
pub(crate) async fn select(state: &Arc<AppState>, body: SelectRequest) -> Result<Value, ApiError> {
    state.require_local_playback()?;
    let id = uuid(&body.request_id)?;
    let _update = state.quality_update.lock().await;
    state
        .audio
        .select_quality_preview(id, body.side)
        .await
        .map_err(CoreError::from)?;
    {
        let _commit = state.play_commit.lock().await;
        state.transport_committed().await;
    }
    audio_quality::read(state).await
}
pub(crate) async fn request(
    state: &Arc<AppState>,
    mut body: PreviewRequest,
) -> Result<Value, ApiError> {
    state.require_local_playback()?;
    body.request_id = uuid(&body.request_id)?;
    audio_quality::revision(&body.expected_revision)?;
    let members = body
        .patch
        .as_object()
        .filter(|m| !m.is_empty())
        .ok_or_else(|| bad_request("试听 patch 必须为非空对象"))?;
    if members.keys().any(|key| {
        !matches!(
            key.as_str(),
            "eq" | "preamp_db" | "headroom_mode" | "tone" | "impulse_id"
        )
    }) {
        return Err(bad_request("试听仅接受均衡、前级、余量、校正与音色草稿；音量、曲目响度来源、保护和交叉淡化沿保存值"));
    }
    if serde_json::to_vec(&body.patch)
        .map_err(|e| bad_request(e.to_string()))?
        .len()
        > 64 * 1024
        || body
            .impulse_path
            .as_ref()
            .is_some_and(|p| p.trim().is_empty() || p.len() > 4096 || p.contains('\0'))
    {
        return Err(bad_request("试听草稿或 WAV 路径超出范围"));
    }
    let (mut observer, lease) = begin(state, body.request_id.clone())?;
    let until = Instant::now() + PREPARATION_TIMEOUT;
    let state = state.clone();
    let job = lease.job.clone();
    let owner = tokio::spawn(async move {
        let _lease = lease;
        let control = Control {
            until,
            cancelled: job.cancelled.clone(),
        };
        let result = prepare_and_start(&state, &body, &job, &control).await;
        if result.is_err() || job.cancelled.load(Ordering::Acquire) {
            let _ = cancel_actor(&state, Some(job.id.clone())).await;
            job.check()?;
        }
        result
    });
    let result = tokio::time::timeout_at(until.into(), owner)
        .await
        .map_err(|_| reference_error(AnalyzeError::Deadline))?
        .map_err(|e| ApiError::internal(e.to_string()))?;
    observer.armed = false;
    result
}
async fn prepare_and_start(
    state: &Arc<AppState>,
    body: &PreviewRequest,
    job: &Arc<Job>,
    control: &Control,
) -> Result<Value, ApiError> {
    job.check()?;
    let (base, _) = audio_quality::load(state).await?;
    if base.revision != body.expected_revision {
        return Err(stale());
    }
    let candidate = audio_quality::patch(base.clone(), body.patch.clone())?;
    let expected = state.audio.snapshot();
    let play_generation = state.play_generation.load(Ordering::SeqCst);
    let id = expected
        .track_id
        .as_deref()
        .ok_or_else(|| bad_request("请先播放一首当前曲目"))?;
    let source = audio_loudness::resolve(state, id).await?;
    let quality = state
        .audio
        .quality_status()
        .await
        .map_err(CoreError::from)?
        .ok_or_else(|| bad_request("当前没有可准备试听的本机输出"))?;
    let output = state
        .audio
        .output_status()
        .await
        .map_err(CoreError::from)?
        .filter(|o| o.active)
        .ok_or_else(|| bad_request("请先播放当前曲目建立输出；暂停后仍可准备试听"))?;
    let channels = output
        .actual
        .as_ref()
        .map(|a| a.channels as usize)
        .ok_or_else(|| bad_request("当前输出格式尚未确定"))?;
    if quality.preview.is_some() || quality.requested != base.params() {
        return Err(stale());
    }
    let rate = quality.eq.processing_rate;
    let render_generation = quality.eq.render_generation.clone();
    let impulse = crate::audio_impulse::prepare_preview(
        state,
        body.request_id.clone(),
        body.impulse_path.clone(),
        candidate.impulse_id.clone(),
        rate,
        job.cancelled.clone(),
    )
    .await?;
    if impulse
        .as_ref()
        .is_some_and(|i| i.phase == ImpulsePhase::Unknown)
        && !body.acknowledge_unknown_phase
    {
        return Err(bad_request(
            "此 WAV 的内在相位和群延迟未知；请确认仅临时试听、不用于音画同步，再重试",
        ));
    }
    let mut enhanced = candidate.params();
    enhanced.impulse_id = impulse
        .as_ref()
        .and_then(|i| vmusic_core::audio_quality::decode_id(&i.kernel.resource_id));
    let plan = PreviewPlan {
        request_id: body.request_id.clone(),
        saved: base.params(),
        enhanced,
        impulse,
        matching: None,
        volume: expected.volume,
        track_gain_db: quality.track_gain_db,
        source_sha256: "0".repeat(64),
        reference_end_ms: 12_000,
        reference_end_frame: u64::from(rate) * 12,
    };
    let path = source.path.clone();
    let work_control = control.clone();
    let match_loudness = body.match_loudness;
    let (mut plan, file, comparison) = tokio::task::spawn_blocking(move || {
        let mut file = StableFile::open(&path, &work_control)?;
        let mut plan = plan;
        plan.source_sha256 = file.fingerprint(&work_control)?.0;
        let reference = file.try_clone().map_err(|e| bad_request(e.to_string()))?;
        let comparison = vmusic_audio::comparison::prepare_reference_file(
            reference,
            &plan,
            rate,
            channels,
            match_loudness,
            &work_control,
        )
        .map_err(reference_error)?;
        file.verify_original(&work_control)?;
        file.rewind().map_err(|e| bad_request(e.to_string()))?;
        plan.matching = comparison.matching.clone();
        plan.reference_end_ms = comparison.reference_end_ms;
        plan.reference_end_frame = comparison.reference_end_frame;
        if plan.reference_end_frame == 0 {
            return Err(bad_request("参考源没有可试听的完整音频帧"));
        }
        plan.validate(rate)
            .map_err(|e| bad_request(e.to_string()))?;
        Ok::<_, ApiError>((plan, file, comparison))
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))??;
    job.check()?;
    control.check().map_err(reference_error)?;
    audio_loudness::verify_owner(state, &source).await?;
    let ext = source
        .path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_owned);
    state
        .audio
        .prepare_quality_preview(plan.clone(), Box::new(file), ext, expected.clone())
        .await
        .map_err(CoreError::from)?;
    let _update = state.quality_update.lock().await;
    job.check()?;
    let current = audio_quality::load(state).await?.0;
    let now = state
        .audio
        .quality_status()
        .await
        .map_err(CoreError::from)?
        .ok_or_else(stale)?;
    if current != base || now.eq.render_generation != render_generation {
        return Err(stale());
    }
    audio_loudness::verify_owner(state, &source).await?;
    state
        .commit_audio_preview(
            body.request_id.clone(),
            PreviewSide::Enhanced,
            expected,
            play_generation,
            &plan.source_sha256,
        )
        .await?;
    job.check()?;
    let mut response = audio_quality::read(state).await?;
    response["comparison"] = json!({"matching":comparison.matching,"unmatched_reason":comparison.unmatched_reason,
        "reference_end_ms":comparison.reference_end_ms,"reference_end_frame":comparison.reference_end_frame,"warmup_ms":2000,"processing_rate":rate,"channels":channels,
        "source_sha256":plan.source_sha256,"source_version":"prepared_immutable_snapshot",
        "phase":plan.impulse.as_ref().map(|i|i.phase),"algorithm_buffer_frames":plan.impulse.as_ref().map_or(0, |i| if i.phase == ImpulsePhase::Unknown {i.kernel.delay_frames} else {0})});
    // Retain no temporary preference object after handing the plan to the renderer.
    plan.impulse = None;
    Ok(response)
}
