// SPDX-License-Identifier: MIT
use crate::{
    error::{bad_request, ApiError},
    state::AppState,
};
use serde_json::{json, Value};
use std::sync::Arc;
use vmusic_core::{output::OutputPreferences, CoreError};
pub const KEY: &str = "audio_output_v1";

pub async fn read(state: &Arc<AppState>) -> Result<Value, ApiError> {
    let stored = vmusic_store::settings::get(&state.db, KEY)
        .await
        .map_err(|e| ApiError::from(CoreError::Store(e)))?;
    let saved = stored
        .map(serde_json::from_value::<OutputPreferences>)
        .transpose()
        .map_err(|e| bad_request(format!("输出偏好无效：{e}")))?
        .unwrap_or_default();
    let actual = if state.audio.exclusively_owned() {
        None
    } else {
        state
            .audio
            .output_status()
            .await
            .map_err(|e| ApiError::from(CoreError::Audio(e)))?
    };
    Ok(json!({"saved":saved,"output":actual,"scope":"local"}))
}

pub async fn update(
    state: &Arc<AppState>,
    preferences: OutputPreferences,
) -> Result<Value, ApiError> {
    if preferences
        .device_id
        .as_ref()
        .is_some_and(|id| id.len() > 4096 || id.contains('\0'))
    {
        return Err(bad_request("输出设备标识无效"));
    }
    let _commit = state.play_commit.lock().await;
    state.require_local_playback()?;
    let old = state
        .audio
        .output_status()
        .await
        .map_err(|e| ApiError::from(CoreError::Audio(e)))?
        .map(|s| s.accepted);
    state
        .audio
        .configure_output(preferences.clone())
        .await
        .map_err(|e| ApiError::from(CoreError::Audio(e)))?;
    if let Err(error) = vmusic_store::settings::set(
        &state.db,
        KEY,
        &serde_json::to_value(preferences).map_err(|e| bad_request(e.to_string()))?,
    )
    .await
    {
        if let Some(old) = old {
            if let Err(restore) = state.audio.configure_output(old).await {
                let _ = state
                    .audio
                    .invalidate_output("输出偏好未保存且恢复失败，请重新选择输出设备".into())
                    .await;
                return Err(ApiError::internal(format!(
                    "输出偏好未保存，旧输出恢复失败；播放已暂停：{error}; {restore}"
                )));
            }
        } else {
            let _ = state
                .audio
                .invalidate_output("输出偏好未保存，请重新选择输出设备".into())
                .await;
        }
        return Err(ApiError::from(CoreError::Store(error)));
    }
    read(state).await
}

pub async fn select_legacy(state: &Arc<AppState>, id: Option<String>) -> Result<(), ApiError> {
    let mut preferences = state
        .audio
        .output_status()
        .await
        .map_err(|e| ApiError::from(CoreError::Audio(e)))?
        .map(|s| s.accepted)
        .unwrap_or_default();
    preferences.device_id = id;
    update(state, preferences).await?;
    Ok(())
}

pub async fn restore(state: &Arc<AppState>) -> Result<(), ApiError> {
    let result = async {
        if let Some(value) = vmusic_store::settings::get(&state.db, KEY)
            .await
            .map_err(|e| ApiError::from(CoreError::Store(e)))?
        {
            let preferences = serde_json::from_value::<OutputPreferences>(value)
                .map_err(|e| bad_request(format!("输出偏好无效：{e}")))?;
            state
                .audio
                .configure_output(preferences)
                .await
                .map_err(|e| ApiError::from(CoreError::Audio(e)))?;
        }
        Ok::<_, ApiError>(())
    }
    .await;
    if let Err(error) = &result {
        let _ = state.audio.invalidate_output(error.message.clone()).await;
    }
    result
}
