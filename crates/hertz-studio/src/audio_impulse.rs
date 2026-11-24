// SPDX-License-Identifier: MIT
use crate::{
    error::{bad_request, ApiError},
    state::AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
};
use tokio::sync::Semaphore;
const MAX: usize = 8 * 1024 * 1024;
static IMPORT: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));
static CURRENT_JOB: Mutex<Option<Arc<Job>>> = Mutex::new(None);

#[derive(Default)]
struct Job {
    request_id: String,
    cancelled: Arc<AtomicBool>,
    /// Publication and cancellation have one linearization point. Staging and
    /// sync run outside this lock; only the final filesystem links run inside.
    committed: Mutex<bool>,
}
impl Job {
    fn check(&self) -> Result<(), ApiError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(bad_request("校正任务已取消"))
        } else {
            Ok(())
        }
    }
    fn cancel(&self) -> bool {
        let committed = self
            .committed
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *committed {
            return false;
        }
        self.cancelled.store(true, Ordering::Release);
        true
    }
    fn complete<T>(&self, action: impl FnOnce() -> Result<T, ApiError>) -> Result<T, ApiError> {
        let mut committed = self
            .committed
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.check()?;
        let result = action()?;
        *committed = true;
        Ok(result)
    }
}
struct RequestGuard {
    job: Arc<Job>,
    armed: bool,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        if self.armed {
            self.job.cancel();
        }
    }
}
struct WorkerLease {
    job: Arc<Job>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Drop for WorkerLease {
    fn drop(&mut self) {
        let mut current = CURRENT_JOB
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if current
            .as_ref()
            .is_some_and(|job| Arc::ptr_eq(job, &self.job))
        {
            current.take();
        }
        // The semaphore permit is released only after job cleanup in this Drop.
    }
}
fn begin_job(request_id: String) -> Result<(RequestGuard, WorkerLease), ApiError> {
    begin_job_with_cancel(request_id, Arc::new(AtomicBool::new(false)))
}
fn begin_job_with_cancel(
    request_id: String,
    cancelled: Arc<AtomicBool>,
) -> Result<(RequestGuard, WorkerLease), ApiError> {
    let permit = IMPORT
        .clone()
        .try_acquire_owned()
        .map_err(|_| bad_request("另一个校正任务正在进行或取消清理中，请稍后再试"))?;
    let job = Arc::new(Job {
        request_id,
        cancelled,
        ..Default::default()
    });
    let mut current = CURRENT_JOB
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if current.is_some() {
        return Err(ApiError::internal("校正任务所有权不一致"));
    }
    *current = Some(job.clone());
    Ok((
        RequestGuard {
            job: job.clone(),
            armed: true,
        },
        WorkerLease {
            job,
            _permit: permit,
        },
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelRequest {
    pub request_id: String,
}

fn validated_request_id(request_id: &str) -> Result<String, ApiError> {
    uuid::Uuid::parse_str(request_id)
        .map(|id| id.to_string())
        .map_err(|_| bad_request("校正请求 ID 必须是 UUID"))
}

fn cancel_matching(request_id: &str) -> bool {
    let job = CURRENT_JOB
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    job.as_ref()
        .is_some_and(|job| job.request_id == request_id && job.cancel())
}

pub async fn cancel(state: &Arc<AppState>, request: CancelRequest) -> Result<Value, ApiError> {
    state.require_local_playback()?;
    let request_id = validated_request_id(&request.request_id)?;
    let cancelled = cancel_matching(&request_id);
    Ok(json!({"cancelled":cancelled,"message":if cancelled {
        "已请求取消校正任务，正在清理；清理结束前不会开始另一任务"
    } else { "该校正请求已结束或不再活动，未取消其他任务" }}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRequest {
    pub request_id: String,
    pub path: String,
    pub device_model: String,
    pub source: String,
    pub target_curve: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenerateRequest {
    pub request_id: String,
    /// Absolute desired response; measurements must already be combined with
    /// the intended target by the user. No automatic headphone inversion.
    pub points: Vec<vmusic_audio::impulse::FrequencyPoint>,
    pub device_model: String,
    pub source: String,
    pub target_curve: String,
}
fn folder(state: &AppState) -> PathBuf {
    state.data_dir.join("audio").join("impulses")
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn managed_id(id: &str) -> Result<String, ApiError> {
    if vmusic_core::audio_quality::decode_id(id).is_none() {
        return Err(bad_request("校正资源 ID 无效"));
    }
    Ok(id.to_ascii_lowercase())
}

pub async fn prepare(
    state: &AppState,
    id: &str,
) -> Result<vmusic_core::impulse::ImpulseKernel, ApiError> {
    let id = managed_id(id)?;
    // Internal preparation is not identified by a previous import/generation
    // request, so a delayed UI cancellation cannot interrupt a saved adoption.
    let (mut guard, lease) = begin_job(uuid::Uuid::new_v4().to_string())?;
    let rate = processing_rate(state).await?;
    let path = folder(state).join(format!("{id}.wav"));
    let expected = id.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        let job = &_lease.job;
        let bytes = read_bounded(&path, job)?;
        if digest(&bytes) != expected {
            return Err(bad_request("校正资源内容已改变，请重新导入"));
        }
        let kernel =
            vmusic_audio::impulse::prepare_wav_cancellable(&bytes, expected, rate, &job.cancelled)
                .map_err(|e| bad_request(e.to_string()))?;
        job.complete(|| Ok(kernel))
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    guard.armed = false;
    result
}
/// Audition-only WAV preparation shares the import/generation worker and cancellation.
/// Unknown phase never becomes a managed resource and never enters formal adoption.
pub(crate) async fn prepare_preview(
    state: &AppState,
    request_id: String,
    path: Option<String>,
    resource_id: Option<String>,
    rate: u32,
    cancelled: Arc<AtomicBool>,
) -> Result<Option<vmusic_core::audio_preview::PreviewImpulse>, ApiError> {
    use vmusic_core::audio_preview::{ImpulsePhase, PreviewImpulse};
    if path.is_none() && resource_id.is_none() {
        return Ok(None);
    }
    let expected = if path.is_some() {
        None
    } else {
        resource_id.map(|id| managed_id(&id)).transpose()?
    };
    let path = path
        .map(PathBuf::from)
        .unwrap_or_else(|| folder(state).join(format!("{}.wav", expected.as_ref().unwrap())));
    let (mut guard, lease) = begin_job_with_cancel(request_id, cancelled)?;
    let result = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        let job = &_lease.job;
        let bytes = read_bounded(&path, job)?;
        let actual = digest(&bytes);
        if expected
            .as_ref()
            .is_some_and(|expected| expected != &actual)
        {
            return Err(bad_request("校正资源内容已改变，请重新导入"));
        }
        let impulse = if expected.is_some() {
            PreviewImpulse {
                kernel: vmusic_audio::impulse::prepare_wav_cancellable(
                    &bytes,
                    actual,
                    rate,
                    &job.cancelled,
                )
                .map_err(|e| bad_request(e.to_string()))?,
                phase: ImpulsePhase::SymmetricLinear,
            }
        } else {
            vmusic_audio::impulse::prepare_preview_wav_cancellable(
                &bytes,
                actual,
                rate,
                &job.cancelled,
            )
            .map_err(|e| bad_request(e.to_string()))?
        };
        job.complete(|| Ok(Some(impulse)))
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    guard.armed = false;
    result
}

fn read_bounded(path: &std::path::Path, job: &Job) -> Result<Vec<u8>, ApiError> {
    use std::io::Read;
    job.check()?;
    let mut file =
        std::fs::File::open(path).map_err(|e| bad_request(format!("无法读取校正 WAV：{e}")))?;
    if !file
        .metadata()
        .map_err(|e| bad_request(e.to_string()))?
        .is_file()
    {
        return Err(bad_request("需要普通 WAV 文件"));
    }
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 65536];
    loop {
        job.check()?;
        let count = file
            .read(&mut chunk)
            .map_err(|error| bad_request(error.to_string()))?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > MAX {
            return Err(bad_request("IR 文件超过 8 MiB"));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    job.check()?;
    Ok(bytes)
}
pub async fn import(state: &Arc<AppState>, request: ImportRequest) -> Result<Value, ApiError> {
    state.require_local_playback()?;
    validate_metadata(
        &request.device_model,
        &request.source,
        &request.target_curve,
    )?;
    if request.path.len() > 4096 {
        return Err(bad_request("文件路径过长"));
    }
    let (mut guard, lease) = begin_job(validated_request_id(&request.request_id)?)?;
    let rate = processing_rate(state).await?;
    let folder = folder(state);
    let result = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        let job = &_lease.job;
        let bytes = read_bounded(std::path::Path::new(&request.path), job)?;
        let id = digest(&bytes);
        let kernel = vmusic_audio::impulse::prepare_wav_cancellable(&bytes, id.clone(), rate, &job.cancelled)
            .map_err(|error| bad_request(error.to_string()))?;
        let metadata = json!({"resource_id":id,"device_model":request.device_model,"source":request.source,"target_curve":request.target_curve,"phase":"symmetric_linear","sample_rate":rate,"taps":kernel.channels[0].len(),"delay_frames":kernel.delay_frames,"attenuation_db":kernel.attenuation_db});
        save_resource(&folder, &id, &bytes, &metadata, job)?;
        Ok(json!({"resource":metadata,"applied":false,"message":"校正资源已导入，尚未应用；请选择后保存音效"}))
    }).await.map_err(|error| ApiError::internal(error.to_string()))?;
    guard.armed = false;
    result
}

/// Uses the same work admission and managed resource owner as WAV import.
/// Generation never applies playback settings; the ordinary prepare/adoption
/// path rechecks the live output rate when the user saves this resource ID.
pub async fn generate(state: &Arc<AppState>, request: GenerateRequest) -> Result<Value, ApiError> {
    state.require_local_playback()?;
    validate_metadata(
        &request.device_model,
        &request.source,
        &request.target_curve,
    )?;
    let (mut guard, lease) = begin_job(validated_request_id(&request.request_id)?)?;
    let rate = processing_rate(state).await?;
    vmusic_audio::impulse::validate_curve(&request.points, rate)
        .map_err(|error| bad_request(error.to_string()))?;
    let folder = folder(state);
    let result = tokio::task::spawn_blocking(move || {
        // Cancellation of the awaiting HTTP/RPC caller does not release the
        // admission slot before this bounded worker has finished its writes.
        let _lease = lease;
        generate_resource(&folder, request, rate, &_lease.job)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?;
    guard.armed = false;
    result
}

fn generate_resource(
    folder: &std::path::Path,
    request: GenerateRequest,
    rate: u32,
    job: &Job,
) -> Result<Value, ApiError> {
    let generated =
        vmusic_audio::impulse::generate_fir_cancellable(&request.points, rate, &job.cancelled)
            .map_err(|error| bad_request(error.to_string()))?;
    let id = digest(&generated.wav);
    // Both generated and imported WAVs must pass the same phase, delay, level,
    // and realtime-budget preparation before becoming managed resources.
    let kernel = vmusic_audio::impulse::prepare_wav_cancellable(
        &generated.wav,
        id.clone(),
        rate,
        &job.cancelled,
    )
    .map_err(|error| bad_request(error.to_string()))?;
    let message = format!(
        "FIR 校正已生成，尚未应用：实际频响采样最大误差 {:.2} dB（{:.1} Hz），预留衰减 {:.2} dB；请检查后保存音效",
        generated.report.max_error_db, generated.report.worst_frequency_hz, kernel.attenuation_db
    );
    let metadata = json!({
        "resource_id":id,"device_model":request.device_model,"source":request.source,
        "target_curve":request.target_curve,"phase":"symmetric_linear",
        "sample_rate":rate,"taps":kernel.channels[0].len(),"delay_frames":kernel.delay_frames,
        "attenuation_db":kernel.attenuation_db,
        "generation":{"points":request.points,"report":generated.report}
    });
    save_resource(folder, &id, &generated.wav, &metadata, job)?;
    Ok(json!({"resource":metadata,"applied":false,"message":message}))
}

fn validate_metadata(device_model: &str, source: &str, target_curve: &str) -> Result<(), ApiError> {
    for value in [device_model, source, target_curve] {
        if value.trim().is_empty() || value.len() > 1024 {
            return Err(bad_request(
                "请填写设备型号、数据来源和目标曲线，每项最多 1024 字节",
            ));
        }
    }
    Ok(())
}

async fn processing_rate(state: &AppState) -> Result<u32, ApiError> {
    let rate = state
        .audio
        .eq_status()
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Audio(e)))?
        .map(|s| s.processing_rate)
        .ok_or_else(|| bad_request("没有可准备校正的本机输出"))?;
    vmusic_core::audio_quality::validate_correction_rate(rate)
        .map_err(|error| bad_request(error.to_string()))?;
    Ok(rate)
}

fn save_resource(
    folder: &std::path::Path,
    id: &str,
    bytes: &[u8],
    metadata: &Value,
    job: &Job,
) -> Result<(), ApiError> {
    job.check()?;
    std::fs::create_dir_all(folder).map_err(|error| ApiError::internal(error.to_string()))?;
    let destination = folder.join(format!("{id}.wav"));
    let descriptor = folder.join(format!("{id}.json"));
    let metadata = serde_json::to_vec_pretty(metadata)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if existing_resource(&destination, &descriptor, id, &metadata, job)? {
        return job.complete(|| Ok(()));
    }
    let staged_wav = stage_file(folder, bytes, job)?;
    let staged_metadata = stage_file(folder, &metadata, job)?;
    publish_resource(
        &destination,
        &descriptor,
        id,
        &metadata,
        staged_wav,
        staged_metadata,
        job,
    )
}

fn existing_resource(
    wav: &std::path::Path,
    descriptor: &std::path::Path,
    id: &str,
    metadata: &[u8],
    job: &Job,
) -> Result<bool, ApiError> {
    match (wav.exists(), descriptor.exists()) {
        (false, false) => Ok(false),
        (true, true) => {
            if digest(&read_bounded(wav, job)?) != id {
                return Err(bad_request(
                    "同 ID 的托管校正资源已被修改，请移除损坏资源后重试",
                ));
            }
            // Canonical descriptor bytes are immutable. Equal content cannot
            // silently relabel an already selected device/source/target.
            if read_bounded(descriptor, job)? != metadata {
                return Err(bad_request(
                    "相同校正内容已登记不同的设备、来源或目标描述；原资源元数据已保留",
                ));
            }
            Ok(true)
        }
        _ => Err(bad_request(
            "托管校正资源不完整，请检查已有文件；不会覆盖现有描述",
        )),
    }
}

struct StagedFile(PathBuf);
impl Drop for StagedFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn stage_file(folder: &std::path::Path, bytes: &[u8], job: &Job) -> Result<StagedFile, ApiError> {
    use std::io::Write;
    job.check()?;
    let path = folder.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    // A failed create_new must never acquire cleanup ownership of that path.
    let staged = StagedFile(path);
    let written = (|| -> Result<(), ApiError> {
        for chunk in bytes.chunks(65536) {
            job.check()?;
            file.write_all(chunk)
                .map_err(|error| ApiError::internal(error.to_string()))?;
        }
        file.sync_all()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    })();
    drop(file);
    written?;
    job.check()?;
    Ok(staged)
}

fn publish_resource(
    wav: &std::path::Path,
    descriptor: &std::path::Path,
    id: &str,
    metadata: &[u8],
    staged_wav: StagedFile,
    staged_metadata: StagedFile,
    job: &Job,
) -> Result<(), ApiError> {
    job.complete(|| {
        if existing_resource(wav, descriptor, id, metadata, job)? {
            return Ok(());
        }
        // Hard links publish complete bytes without replace-existing behavior.
        // Both stages share the destination filesystem. If the second link
        // fails, remove only the just-created first link, never existing data.
        std::fs::hard_link(&staged_wav.0, wav)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        if let Err(error) = std::fs::hard_link(&staged_metadata.0, descriptor) {
            let cleanup = std::fs::remove_file(wav);
            return Err(ApiError::internal(format!(
                "校正资源发布失败：{error}; WAV 清理：{cleanup:?}"
            )));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vmusic_audio::impulse::FrequencyPoint;

    #[test]
    fn managed_ids_are_canonical_lowercase() {
        let id = "A".repeat(64);
        assert_eq!(managed_id(&id).unwrap(), "a".repeat(64));
        assert!(managed_id("not-a-digest").is_err());
    }

    fn request() -> GenerateRequest {
        GenerateRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            points: vec![
                FrequencyPoint {
                    frequency_hz: 20.0,
                    gain_db: -3.0,
                },
                FrequencyPoint {
                    frequency_hz: 20_000.0,
                    gain_db: -3.0,
                },
            ],
            device_model: "test-headphones".into(),
            source: "user measurement fixture".into(),
            target_curve: "flat minus 3 dB".into(),
        }
    }

    #[test]
    fn generated_resource_is_content_addressed_with_provenance_and_regular_preparation() {
        let folder =
            std::env::temp_dir().join(format!("hertz-generated-ir-{}", uuid::Uuid::new_v4()));
        let response = generate_resource(&folder, request(), 48000, &Job::default()).unwrap();
        assert_eq!(response["applied"], false);
        let resource = &response["resource"];
        let id = resource["resource_id"].as_str().unwrap();
        let wav = read_bounded(&folder.join(format!("{id}.wav")), &Job::default()).unwrap();
        assert_eq!(digest(&wav), id);
        let kernel = vmusic_audio::impulse::prepare_wav(&wav, id.into(), 48000).unwrap();
        assert_eq!(kernel.delay_frames, 128);
        assert_eq!(kernel.channels[0].len(), 257);
        let metadata: Value =
            serde_json::from_slice(&std::fs::read(folder.join(format!("{id}.json"))).unwrap())
                .unwrap();
        assert_eq!(&metadata, resource);
        assert_eq!(metadata["device_model"], "test-headphones");
        assert_eq!(metadata["generation"]["points"][0]["gain_db"], -3.0);
        assert_eq!(metadata["generation"]["report"]["sample_rate"], 48000);
        assert_eq!(metadata["phase"], "symmetric_linear");
        let repeated = generate_resource(&folder, request(), 48000, &Job::default()).unwrap();
        assert_eq!(repeated["resource"]["resource_id"], id);
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 2);
        std::fs::write(folder.join(format!("{id}.wav")), b"corrupted").unwrap();
        assert!(generate_resource(&folder, request(), 48000, &Job::default()).is_err());
        std::fs::remove_file(folder.join(format!("{id}.wav"))).unwrap();
        std::fs::remove_file(folder.join(format!("{id}.json"))).unwrap();
        std::fs::remove_dir(folder).unwrap();
    }

    #[test]
    fn generation_requests_are_strict_and_require_provenance() {
        assert!(serde_json::from_value::<GenerateRequest>(json!({
            "request_id":uuid::Uuid::new_v4().to_string(),
            "points":[{"frequency_hz":20,"gain_db":0},{"frequency_hz":20000,"gain_db":0}],
            "device_model":"model","source":"measurement","target_curve":"target","normalize":true
        }))
        .is_err());
        assert!(validate_metadata("model", "  ", "target").is_err());
        assert!(validate_metadata(&"a".repeat(1025), "source", "target").is_err());
        assert!(validated_request_id("not-a-uuid").is_err());
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(validated_request_id(&id.to_ascii_uppercase()).unwrap(), id);
        assert!(serde_json::from_value::<CancelRequest>(json!({})).is_err());
        assert!(
            serde_json::from_value::<CancelRequest>(json!({"request_id":id,"all":true})).is_err()
        );
    }

    #[test]
    fn identical_wav_cannot_overwrite_existing_provenance() {
        let folder =
            std::env::temp_dir().join(format!("hertz-ir-provenance-{}", uuid::Uuid::new_v4()));
        let first = generate_resource(&folder, request(), 48000, &Job::default()).unwrap();
        let id = first["resource"]["resource_id"].as_str().unwrap();
        let descriptor = folder.join(format!("{id}.json"));
        let original = std::fs::read(&descriptor).unwrap();
        for field in 0..3 {
            let mut conflicting = request();
            match field {
                0 => conflicting.device_model = "another device".into(),
                1 => conflicting.source = "another measurement".into(),
                _ => conflicting.target_curve = "another target".into(),
            };
            assert!(generate_resource(&folder, conflicting, 48000, &Job::default()).is_err());
            assert_eq!(std::fs::read(&descriptor).unwrap(), original);
        }
        assert!(generate_resource(&folder, request(), 48000, &Job::default()).is_ok());
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 2);
        std::fs::remove_file(folder.join(format!("{id}.wav"))).unwrap();
        std::fs::remove_file(descriptor).unwrap();
        std::fs::remove_dir(folder).unwrap();
    }

    #[test]
    fn cancelled_generation_and_staged_publication_leave_no_resource() {
        let folder = std::env::temp_dir().join(format!("hertz-ir-cancel-{}", uuid::Uuid::new_v4()));
        let job = Job::default();
        assert!(job.cancel());
        assert!(generate_resource(&folder, request(), 48000, &job).is_err());
        assert!(!folder.exists());
        std::fs::create_dir(&folder).unwrap();
        let job = Job::default();
        let bytes = b"staged-wave-data";
        let metadata = b"staged-descriptor-data";
        let staged_wav = stage_file(&folder, bytes, &job).unwrap();
        let staged_metadata = stage_file(&folder, metadata, &job).unwrap();
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 2);
        assert!(job.cancel());
        let wav = folder.join("test.wav");
        let descriptor = folder.join("test.json");
        assert!(publish_resource(
            &wav,
            &descriptor,
            &digest(bytes),
            metadata,
            staged_wav,
            staged_metadata,
            &job
        )
        .is_err());
        assert!(!wav.exists() && !descriptor.exists());
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);
        std::fs::remove_dir(folder).unwrap();
    }

    #[test]
    fn request_drop_keeps_worker_slot_and_stale_cancel_cannot_cancel_new_job() {
        let (guard, lease) = begin_job(uuid::Uuid::new_v4().to_string()).unwrap();
        let token = lease.job.clone();
        let old_request_id = token.request_id.clone();
        assert!(begin_job(uuid::Uuid::new_v4().to_string()).is_err());
        drop(guard);
        assert!(token.cancelled.load(Ordering::Acquire));
        assert!(cancel_matching(&old_request_id));
        assert!(begin_job(uuid::Uuid::new_v4().to_string()).is_err());
        assert!(CURRENT_JOB
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|job| Arc::ptr_eq(job, &token)));
        drop(lease);
        assert!(CURRENT_JOB.lock().unwrap().is_none());
        let (mut guard, lease) = begin_job(uuid::Uuid::new_v4().to_string()).unwrap();
        // A is retired and B is registered. An old form/callback can only
        // cancel A's identity; B or an internal saved preparation remains live.
        assert!(!cancel_matching(&old_request_id));
        assert!(!lease.job.cancelled.load(Ordering::Acquire));
        assert!(CURRENT_JOB
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|job| Arc::ptr_eq(job, &lease.job)));
        lease.job.complete(|| Ok(())).unwrap();
        assert!(!lease.job.cancel());
        assert!(!cancel_matching(&lease.job.request_id));
        guard.armed = false;
        drop(guard);
        drop(lease);
        assert!(CURRENT_JOB.lock().unwrap().is_none());
    }
}
