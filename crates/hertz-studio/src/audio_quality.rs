// SPDX-License-Identifier: MIT
//! Single persisted quality configuration and application operation for HTTP/RPC.
use crate::{
    error::{bad_request, internal, ApiError},
    state::{AppState, DspConfig},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};
use vmusic_core::CoreError;

pub use vmusic_store::audio_quality::{KEY, LEGACY_KEYS};

pub use vmusic_core::audio_quality::QualityConfig;
trait LegacyProjection {
    fn legacy(&self) -> DspConfig;
}
impl LegacyProjection for QualityConfig {
    fn legacy(&self) -> DspConfig {
        DspConfig {
            eq_gains_db: self.params().gains(),
            preamp_db: self.preamp_db,
            loudness_mode: if self.loudness_source
                == vmusic_core::audio_quality::LoudnessSource::R128
            {
                "off".into()
            } else {
                self.loudness_mode.clone()
            },
            crossfade_ms: self.crossfade_ms,
        }
    }
}
pub(crate) fn legacy(config: &QualityConfig) -> DspConfig {
    config.legacy()
}

pub fn revision(value: &str) -> Result<u64, ApiError> {
    let n = value
        .parse::<u64>()
        .map_err(|_| bad_request("修订必须是十进制 u64 字符串"))?;
    if n.to_string() != value {
        return Err(bad_request("修订必须使用规范十进制格式"));
    }
    Ok(n)
}

pub fn from_settings(
    settings: &BTreeMap<String, Value>,
) -> Result<(QualityConfig, &'static str), ApiError> {
    vmusic_store::audio_quality::from_settings(settings).map_err(|e| bad_request(e.to_string()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualityUpdate {
    pub expected_revision: String,
    pub patch: Value,
}

fn patch(config: QualityConfig, value: Value) -> Result<QualityConfig, ApiError> {
    let patch = value
        .as_object()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| bad_request("patch 必须是非空对象"))?;
    let mut merged = serde_json::to_value(config).map_err(|e| internal(e.to_string()))?;
    for (key, value) in patch {
        if !matches!(
            key.as_str(),
            "eq" | "preamp_db"
                | "headroom_mode"
                | "loudness_mode"
                | "crossfade_ms"
                | "limiter"
                | "loudness_source"
                | "target_lufs"
                | "tone"
                | "impulse_id"
        ) || value.is_null()
        {
            return Err(bad_request(format!("未知或空的音质字段：{key}")));
        }
        if key == "impulse_id" {
            merged["schema_version"] = json!(4);
        }
        if key == "eq" || key == "tone" {
            let members = value
                .as_object()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| bad_request("配置分组必须为非空对象"))?;
            for (member, value) in members {
                if value.is_null() {
                    return Err(bad_request("配置字段不能为 null"));
                }
                merged[key][member] = value.clone();
            }
            if key == "tone" {
                merged["schema_version"] = json!(4);
            }
        } else {
            merged[key] = if key == "impulse_id" && value.as_str() == Some("") {
                Value::Null
            } else {
                value.clone()
            };
            if matches!(key.as_str(), "limiter" | "loudness_source" | "target_lufs") {
                let version = merged["schema_version"].as_u64().unwrap_or(2).max(3);
                merged["schema_version"] = json!(version);
            }
        }
    }

    let config: QualityConfig =
        serde_json::from_value(merged).map_err(|e| bad_request(e.to_string()))?;
    config.validate().map_err(|e| bad_request(e.to_string()))?;
    Ok(config)
}

async fn load(state: &AppState) -> Result<(QualityConfig, &'static str), ApiError> {
    from_settings(
        &vmusic_store::settings::get_all(&state.db)
            .await
            .map_err(|e| ApiError::from(CoreError::Store(e)))?,
    )
}

fn correction_capability(room: bool, no_output: bool, rate: Option<u32>) -> Value {
    use vmusic_core::audio_quality::{CORRECTION_PROCESSING_RATES, CORRECTION_RATE_MESSAGE};
    let (reason, message) = if room {
        (
            Some("room_processing_unavailable"),
            Some("当前一起听暂不支持私人校正与过采样饱和"),
        )
    } else if no_output || rate.is_none() {
        (
            Some("output_format_unavailable"),
            Some("当前没有可准备音效的本机输出格式"),
        )
    } else if !rate.is_some_and(|r| CORRECTION_PROCESSING_RATES.contains(&r)) {
        (
            Some("processing_rate_outside_realtime_budget"),
            Some(CORRECTION_RATE_MESSAGE),
        )
    } else {
        (None, None)
    };
    json!({"supported":true,"available":reason.is_none(),"scope":"local",
        "qualified_rates":CORRECTION_PROCESSING_RATES,"reason":reason,"message":message})
}

pub async fn read(state: &Arc<AppState>) -> Result<Value, ApiError> {
    let (config, origin) = load(state).await?;
    response(state, &config, origin).await
}

async fn response(
    state: &AppState,
    config: &QualityConfig,
    origin: &str,
) -> Result<Value, ApiError> {
    let room = state.audio.exclusively_owned();
    let mut failure = state.dsp_application_error.lock().await.clone();
    let no_output = room || state.audio.backend_name() == "null";
    let quality = if no_output {
        None
    } else {
        match state.audio.quality_status().await {
            Ok(value) => value,
            Err(error) => {
                failure = Some(ApiError::from(CoreError::Audio(error)));
                None
            }
        }
    };
    let output = if no_output {
        None
    } else {
        match state.audio.output_status().await {
            Ok(value) => value,
            Err(error) => {
                failure = Some(ApiError::from(CoreError::Audio(error)));
                None
            }
        }
    };
    let rate = quality.as_ref().map(|s| s.eq.processing_rate);
    let qualified =
        rate.is_some_and(|r| vmusic_core::audio_quality::QUALITY_PROCESSING_RATES.contains(&r));
    let saturation = correction_capability(room, no_output, rate);
    let mut impulse = saturation.clone();
    impulse["max_prepared_taps"] = json!(257);
    impulse["phase"] = json!("symmetric_linear");
    impulse["curve_generation"] = json!(true);
    impulse["unknown_phase_preview"] = json!(false);
    let matching = quality
        .as_ref()
        .is_some_and(|s| s.requested == config.params());
    let adopted = quality.as_ref().is_some_and(|s| {
        matching
            && s.applied == Some(config.params())
            && s.eq.state == vmusic_core::EqApplicationState::Applied
    });
    let state_name = if failure.is_some() {
        "failed"
    } else if room || quality.is_none() {
        "deferred"
    } else if quality
        .as_ref()
        .is_some_and(|q| q.eq.state == vmusic_core::EqApplicationState::Deferred)
    {
        "deferred"
    } else if adopted {
        "applied"
    } else if matching && quality.as_ref().is_some_and(|s| s.eq.active) {
        "applying"
    } else {
        "deferred"
    };
    let issues=failure.map(|e|vec![json!({"code":e.code,"message":e.message,"request_id":e.request_id,"recovery":"检查输出设备后重试保存"})]).unwrap_or_default();
    let measured = state
        .measured_loudness
        .lock()
        .await
        .clone()
        .filter(|m| m.matches(&state.audio.snapshot()));
    Ok(
        json!({"loudness_application":measured,"revision":config.revision,"requested":config,"configuration_origin":origin,
        "application_state":state_name,"applied_revision":quality.as_ref().and_then(|s|s.applied.map(|p|p.configuration_revision.to_string())),
        "render_generation":quality.as_ref().map(|s|&s.eq.render_generation),"effective":quality,"output":output,"issues":issues,
        "capabilities":{"parametric_eq":{"supported":true,"available":!no_output&&qualified,"scope":"local","reason":if room {Some("当前房间只采用共同六段 EQ")}else{None::<&str>},"history_limit_ms":2000},
            "headroom":{"supported":true,"available":!no_output&&qualified,"scope":"local"},
            "true_peak":{"supported":true,"available":!no_output&&qualified,"scope":"local","qualified_rates":vmusic_core::audio_quality::QUALITY_PROCESSING_RATES,"target_db_tp":-1.0},
            "r128":{"supported":true,"available":cfg!(windows)&&!no_output,"scope":"local","reason":if cfg!(windows){None}else{Some("immutable_source_adoption_unavailable")}},
            "crossfeed":{"supported":true,"available":!no_output,"scope":"stereo_local"},
            "tone":{"supported":true,"available":!no_output,"scope":"local"},
            "saturation":saturation,"impulse":impulse}}),
    )
}

pub async fn update(state: &Arc<AppState>, request: QualityUpdate) -> Result<Value, ApiError> {
    let _update = state.quality_update.lock().await;
    let (base, _) = load(state).await?;
    revision(&request.expected_revision)?;
    if base.revision != request.expected_revision {
        return Err(conflict());
    }
    let candidate = patch(base, request.patch)?;
    commit(state, candidate, Some(request.expected_revision)).await
}

fn conflict() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::CONFLICT,
        "audio_quality_conflict",
        "音质设置已在别处修改，请重新读取后保存草稿",
    )
}

async fn commit(
    state: &Arc<AppState>,
    mut config: QualityConfig,
    expected: Option<String>,
) -> Result<Value, ApiError> {
    state.require_local_playback()?;
    let (initial, initial_origin) = load(state).await?;
    if expected.as_deref().is_some_and(|r| r != initial.revision) {
        return Err(conflict());
    }
    config.revision = initial.revision.clone();
    let changed = config != initial || initial_origin == "legacy_projection";
    if changed {
        config.revision = revision(&initial.revision)?
            .checked_add(1)
            .ok_or_else(|| bad_request("音质修订已耗尽"))?
            .to_string();
    }
    let generation = state
        .play_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    // Validate format/coefficient/history admission before storage and outside play_commit.
    let no_output = state.audio.backend_name() == "null";
    let output_generation = if no_output {
        None
    } else {
        state
            .audio
            .eq_status()
            .await
            .map_err(|e| ApiError::from(CoreError::Audio(e)))?
            .map(|s| s.render_generation)
    };
    if !no_output {
        if let Some(id) = &config.impulse_id {
            let kernel = crate::audio_impulse::prepare(state, id).await?;
            state
                .audio
                .prepare_impulse(kernel)
                .await
                .map_err(|e| bad_request(e.to_string()))?;
        }
        state
            .audio
            .validate_quality(config.params())
            .await
            .map_err(|e| bad_request(e.to_string()))?;
    }
    let prepared_generation = if no_output {
        None
    } else {
        state
            .audio
            .eq_status()
            .await
            .map_err(|e| ApiError::from(CoreError::Audio(e)))?
            .map(|s| s.render_generation)
    };
    if output_generation != prepared_generation {
        return Err(conflict());
    }
    let commit = state.play_commit.lock().await;
    state.require_local_playback()?;
    let (current, _) = load(state).await?;
    if expected.as_deref().is_some_and(|r| r != current.revision)
        || state
            .play_generation
            .load(std::sync::atomic::Ordering::SeqCst)
            != generation
    {
        return Err(conflict());
    }
    let current_generation = if no_output {
        None
    } else {
        state
            .audio
            .eq_status()
            .await
            .map_err(|e| ApiError::from(CoreError::Audio(e)))?
            .map(|s| s.render_generation)
    };
    if output_generation != current_generation {
        return Err(conflict());
    }
    if changed {
        vmusic_store::settings::replace_atomic(
            &state.db,
            KEY,
            &serde_json::to_value(&config).map_err(|e| internal(e.to_string()))?,
            &LEGACY_KEYS,
        )
        .await
        .map_err(|e| ApiError::from(CoreError::Store(e)))?;
    }
    *state.dsp.lock().await = config.legacy();
    if changed {
        state.loudness_candidates.invalidate();
    }
    let result = if state.audio.backend_name() == "null" {
        Ok(())
    } else {
        state.audio.set_quality(config.params()).await
    };
    // Track gain stays owned by the established ReplayGain path.
    let track = if config.loudness_mode == "off" {
        0.0
    } else if config.loudness_source == vmusic_core::audio_quality::LoudnessSource::R128 {
        state
            .measured_loudness
            .lock()
            .await
            .as_ref()
            .filter(|m| m.matches(&state.audio.snapshot()))
            .map_or(0.0, |m| m.gain_db)
    } else {
        state
            .current_loudness(&config.loudness_mode)
            .await
            .map_or(0.0, |(gain, _)| gain as f32)
    };
    let gains = state
        .audio
        .set_dsp(vmusic_core::DspParams {
            eq_gains_db: config.params().gains(),
            preamp_db: config.preamp_db,
            track_gain_db: track,
        })
        .await;
    let failure = result
        .err()
        .or_else(|| gains.err())
        .map(|e| ApiError::from(CoreError::Audio(e)));
    *state.dsp_application_error.lock().await = failure;
    state.cancel_prepared_playback().await;
    state.schedule_prepare_next();
    drop(commit);
    response(state, &config, "v2").await
}

/// Caller holds quality_update while restoring the canonical settings object.
pub(crate) async fn reapply_saved(state: &Arc<AppState>) -> Result<(), ApiError> {
    let (config, _) = load(state).await?;
    let expected = config.revision.clone();
    commit(state, config, Some(expected)).await?;
    Ok(())
}

pub async fn legacy_update(
    state: &Arc<AppState>,
    update: crate::player_dsp::DspUpdate,
) -> Result<Value, ApiError> {
    // Old clients lack CAS. Serialize read/prepare/write through one dedicated
    // entry guard, then still check the canonical revision under play_commit.
    let _legacy = state.quality_update.lock().await;
    let (mut config, _) = load(state).await?;
    let expected = config.revision.clone();
    if let Some(gains) = update.eq_gains_db {
        if gains.iter().any(|v| !v.is_finite()) {
            return Err(bad_request("均衡器增益必须为有限数值"));
        }
        config.eq.enabled = gains.iter().any(|v| *v != 0.0);
        for (band, gain) in config.eq.bands.iter_mut().zip(gains) {
            band.gain_db = gain.clamp(-12.0, 12.0);
        }
    }
    if let Some(preamp) = update.preamp_db {
        if !preamp.is_finite() {
            return Err(bad_request("前级必须为有限数值"));
        }
        config.preamp_db = preamp.clamp(-24.0, 12.0);
    }
    if let Some(mode) = update.loudness_mode {
        config.loudness_mode = mode;
        config.loudness_source = vmusic_core::audio_quality::LoudnessSource::FileTags;
    }
    if let Some(ms) = update.crossfade_ms {
        config.crossfade_ms = ms.min(8000);
    }
    config.validate().map_err(|e| bad_request(e.to_string()))?;
    commit(state, config, Some(expected)).await?;
    crate::player_dsp::read(state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correction_capabilities_follow_software_rate_qualification() {
        for rate in [44_100, 48_000] {
            let capability = correction_capability(false, false, Some(rate));
            assert_eq!(capability["available"], true);
            assert_eq!(capability["qualified_rates"], json!([44_100, 48_000]));
            assert!(capability["reason"].is_null());
        }
        let unsupported = correction_capability(false, false, Some(96_000));
        assert_eq!(unsupported["supported"], true);
        assert_eq!(unsupported["available"], false);
        assert_eq!(
            unsupported["reason"],
            "processing_rate_outside_realtime_budget"
        );
        assert!(unsupported["message"]
            .as_str()
            .unwrap()
            .contains("44.1/48 kHz"));
        assert_eq!(
            correction_capability(false, true, Some(48_000))["available"],
            false
        );
        assert_eq!(
            correction_capability(false, false, None)["available"],
            false
        );
        assert_eq!(
            correction_capability(true, true, Some(48_000))["reason"],
            "room_processing_unavailable"
        );
    }

    #[test]
    fn strict_patch_preserves_disabled_curve_and_rejects_unknowns() {
        let (config, origin) = from_settings(&BTreeMap::from([(
            "dsp_eq".into(),
            json!([2, 0, 0, 0, 0, 0]),
        )]))
        .unwrap();
        assert_eq!(origin, "legacy_projection");
        assert!(config.eq.enabled);
        let disabled = patch(config, json!({"eq":{"enabled":false}})).unwrap();
        assert_eq!(disabled.legacy().eq_gains_db, [0.0; 6]);
        assert_eq!(disabled.eq.bands[0].gain_db, 2.0);
        for invalid in [
            json!({}),
            json!({"eq":{"bands":[]}}),
            json!({"eq":{"extra":1}}),
            json!({"revision":"9"}),
            json!({"headroom_mode":null}),
            json!({"crossfade_ms":0.5}),
        ] {
            assert!(patch(disabled.clone(), invalid).is_err());
        }
        assert!(revision("01").is_err());
        assert!(revision("18446744073709551616").is_err());
    }

    #[tokio::test]
    async fn migration_cas_legacy_projection_and_failed_transaction() {
        let root = std::env::temp_dir().join(format!("hertz-quality-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db = vmusic_store::open(&root.join("library.sqlite"))
            .await
            .unwrap();
        vmusic_store::settings::set(&db, "dsp_eq", &json!([3, 0, 0, 0, 0, 0]))
            .await
            .unwrap();
        let (fixture, thread) = crate::state::tests::playback_state_with_db(db).await;
        let state = Arc::new(fixture);
        let first = read(&state).await.unwrap();
        assert_eq!(first["configuration_origin"], "legacy_projection");
        assert!(vmusic_store::settings::get(&state.db, KEY)
            .await
            .unwrap()
            .is_none());
        let saved = update(
            &state,
            QualityUpdate {
                expected_revision: "0".into(),
                patch: json!({"headroom_mode":"auto","eq":{"enabled":false}}),
            },
        )
        .await
        .unwrap();
        assert_eq!(saved["revision"], "1");
        assert_eq!(saved["application_state"], "deferred");
        let same = update(
            &state,
            QualityUpdate {
                expected_revision: "1".into(),
                patch: json!({"headroom_mode":"auto"}),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            same["revision"], "1",
            "same-config retries keep their stored revision"
        );
        for key in LEGACY_KEYS {
            assert!(vmusic_store::settings::get(&state.db, key)
                .await
                .unwrap()
                .is_none());
        }
        assert_eq!(
            update(
                &state,
                QualityUpdate {
                    expected_revision: "0".into(),
                    patch: json!({"preamp_db":-3})
                }
            )
            .await
            .unwrap_err()
            .code,
            "audio_quality_conflict"
        );
        let projection = crate::player_dsp::read(&state).await.unwrap();
        assert_eq!(
            projection["eq_gains_db"],
            json!([0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        );
        let gains = crate::player_dsp::DspUpdate {
            eq_gains_db: Some([4.0; 6]),
            ..Default::default()
        };
        legacy_update(&state, gains).await.unwrap();
        assert_eq!(read(&state).await.unwrap()["revision"], "2");
        sqlx::query("CREATE TRIGGER quality_reject BEFORE INSERT ON settings WHEN NEW.key='audio_quality_v2' BEGIN SELECT RAISE(ABORT,'fixture'); END").execute(&state.db).await.unwrap();
        assert!(update(
            &state,
            QualityUpdate {
                expected_revision: "2".into(),
                patch: json!({"preamp_db":-6})
            }
        )
        .await
        .is_err());
        assert_eq!(read(&state).await.unwrap()["revision"], "2");
        state.audio.shutdown();
        thread.join().unwrap();
        state.db.close().await;
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}
