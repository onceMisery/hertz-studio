// SPDX-License-Identifier: MIT
//! Fixed local artifact transport, using the already verified native connection.
use super::*;
use hertz_wallpaper::generation::{WallpaperArtifact, WallpaperGenerationKind, MAX_OUTPUT_BYTES};
use sha2::{Digest, Sha256};

pub(crate) struct ReceivedBuiltin {
    pub artifact: WallpaperArtifact,
    pub service_owner: String,
    pub provider: String,
    pub model: String,
    pub bytes: Vec<u8>,
    pub epoch: u64,
}
pub(crate) struct ReceivedImage {
    pub artifact: WallpaperArtifact,
    pub service_owner: String,
    pub provider: String,
    pub model: String,
    pub file: std::path::PathBuf,
    pub epoch: u64,
}
pub(crate) enum ReceivedArtifact {
    Builtin(ReceivedBuiltin),
    Image(ReceivedImage),
}
pub(crate) struct ReceivePermit<'a> {
    _state: std::sync::MutexGuard<'a, State>,
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl NativeGeneration {
    // The permit holds the original profile lifecycle lock through the local
    // receipt commit. A profile retirement linearizes before or after it.
    pub(crate) fn receive_permit(
        &self,
        epoch: u64,
        cancel: &AtomicBool,
    ) -> Result<ReceivePermit<'_>> {
        let state = lock(&self.state);
        check_cancel(cancel)?;
        if state.epoch != epoch
            || !state.connection.as_ref().is_some_and(|c| {
                c.bearer.is_some() && c.expires.is_some_and(|t| Instant::now() < t)
            })
        {
            return Err(error("ai_superseded", "来源已变化，旧候选接收已取消"));
        }
        Ok(ReceivePermit { _state: state })
    }
    pub(crate) fn receive_artifact(
        &self,
        job_id: &str,
        target: &std::path::Path,
        cancel: &AtomicBool,
    ) -> Result<ReceivedArtifact> {
        if !super::super::api::valid_id(job_id) {
            return Err(error("invalid_input", "任务标识无效"));
        }
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err(error("ai_busy", "上一连接操作尚未完成"));
        }
        let _busy = Busy(&self.busy);
        let (epoch, connection) = {
            let state = lock(&self.state);
            let connection = state
                .connection
                .clone()
                .filter(|c| c.bearer.is_some() && c.expires.is_some_and(|t| Instant::now() < t))
                .ok_or_else(|| error("ai_not_connected", "请先连接生成服务"))?;
            (state.epoch, connection)
        };
        check_cancel(cancel)?;
        let job = http(
            &connection,
            "GET",
            &format!("/v1/ai/wallpaper/jobs/{job_id}"),
            None,
        )?;
        let artifact = WallpaperArtifact::parse(
            &serde_json::to_vec(&job["artifact"])
                .map_err(|_| error("invalid_response", "结果回执无效"))?,
        )
        .map_err(|e| error(e.code, &e.message))?;
        if artifact.job_id != job_id
            || job["state"] != "succeeded"
            || !matches!(
                artifact.kind,
                WallpaperGenerationKind::Builtin | WallpaperGenerationKind::Image
            )
            || (artifact.kind == WallpaperGenerationKind::Builtin
                && artifact.bytes > MAX_OUTPUT_BYTES as u64)
            || uuid::Uuid::parse_str(&artifact.artifact_id).is_err()
        {
            return Err(error(
                "ai_output_rejected",
                "只接收已完成的内置场景或图片候选",
            ));
        }
        let expiry = artifact
            .expires_at
            .parse::<i64>()
            .map_err(|_| error("invalid_response", "结果期限无效"))?;
        if expiry <= now_ms() || expiry > now_ms().saturating_add(24 * 60 * 60_000) {
            return Err(error("ai_artifact_expired", "候选已到期，请查看原任务"));
        }
        let capability = http(&connection, "GET", "/v1/ai/wallpaper/capabilities", None)?;
        if artifact.registry_hash != hertz_wallpaper::catalog().registry_hash
            || capability["generationSchemaHash"] != artifact.generation_schema_hash
        {
            return Err(error("ai_contract_mismatch", "播放器与本机候选合同不一致"));
        }
        let label = |key: &str| -> Result<String> {
            job[key]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
                .map(str::to_owned)
                .ok_or_else(|| error("invalid_response", "候选来源标识无效"))
        };
        let service_owner = label("serviceOwner")?;
        let provider = label("provider")?;
        let model = label("model")?;
        let discovery = current_discovery(&connection)?;
        check_cancel(cancel)?;
        let bytes = if artifact.kind == WallpaperGenerationKind::Image {
            transport::artifact(&connection, discovery.port, &artifact, target, cancel)?;
            Vec::new()
        } else {
            let (success, bytes) = local_request(
                &connection,
                discovery.port,
                "GET",
                &format!("/v1/ai/wallpaper/artifacts/{}", artifact.artifact_id),
                None,
            )?;
            if !success {
                return Err(error(
                    "ai_artifact_unavailable",
                    "候选接收失败，可重取同一候选",
                ));
            }
            bytes
        };
        check_cancel(cancel)?;
        if artifact.kind == WallpaperGenerationKind::Builtin
            && (bytes.len() as u64 != artifact.bytes
                || format!("{:x}", Sha256::digest(&bytes)) != artifact.sha256)
        {
            return Err(error(
                "ai_output_rejected",
                "候选长度或哈希不符，可重取同一候选",
            ));
        }
        if lock(&self.state).epoch != epoch || current_discovery(&connection).is_err() {
            return Err(error("ai_superseded", "来源已变化，旧候选接收已取消"));
        }
        // Revalidate current authorization after receiving bytes. A revocation
        // at the end of the transfer cannot create an accepted local candidate.
        http(
            &connection,
            "GET",
            &format!("/v1/ai/wallpaper/jobs/{job_id}"),
            None,
        )?;
        check_cancel(cancel)?;
        let _permit = self.receive_permit(epoch, cancel)?;
        Ok(if artifact.kind == WallpaperGenerationKind::Image {
            ReceivedArtifact::Image(ReceivedImage {
                artifact,
                service_owner,
                provider,
                model,
                file: target.to_owned(),
                epoch,
            })
        } else {
            ReceivedArtifact::Builtin(ReceivedBuiltin {
                artifact,
                service_owner,
                provider,
                model,
                bytes,
                epoch,
            })
        })
    }
}
fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(error("cancelled", "候选接收已取消"))
    } else {
        Ok(())
    }
}
