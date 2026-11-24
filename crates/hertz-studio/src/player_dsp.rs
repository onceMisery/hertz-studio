// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! The existing DSP preference/application operation, shared by HTTP and RPC.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use vmusic_core::{CoreError, EqApplicationState};

use crate::{
    error::{internal, ApiError},
    state::{AppState, DspConfig},
};

#[derive(Deserialize, Default)]
pub struct DspUpdate {
    pub eq_gains_db: Option<[f32; 6]>,
    pub preamp_db: Option<f32>,
    pub loudness_mode: Option<String>,
    pub crossfade_ms: Option<u64>,
}

#[cfg(test)]
use crate::error::bad_request;

#[cfg(test)]
fn update_config(mut config: DspConfig, update: DspUpdate) -> Result<DspConfig, ApiError> {
    if let Some(eq) = update.eq_gains_db {
        if eq.iter().any(|value| !value.is_finite()) {
            return Err(bad_request("均衡器增益必须为有限数值"));
        }
        config.eq_gains_db = eq;
        config.clamp_eq();
    }
    if let Some(preamp) = update.preamp_db {
        if !preamp.is_finite() {
            return Err(bad_request("前置增益必须为有限数值"));
        }
        config.preamp_db = preamp.clamp(-24.0, 12.0);
    }
    if let Some(mode) = update.loudness_mode {
        if !matches!(mode.as_str(), "off" | "track" | "album") {
            return Err(bad_request("loudness_mode 只接受 off / track / album"));
        }
        config.loudness_mode = mode;
    }
    if let Some(ms) = update.crossfade_ms {
        config.crossfade_ms = ms.min(8000);
    }
    Ok(config)
}

async fn response(
    state: &AppState,
    config: &DspConfig,
    failure: Option<ApiError>,
) -> Result<Value, ApiError> {
    let mut value = serde_json::to_value(config).map_err(|error| internal(error.to_string()))?;
    let mut application =
        json!({"scope":"equalizer", "saved":true, "backend":state.audio.backend_name()});
    if let Some(error) = failure {
        application["state"] = json!("failed");
        application["error"] =
            json!({"code":error.code,"message":error.message,"request_id":error.request_id});
    } else if state.audio.exclusively_owned() {
        application["state"] = json!("room");
    } else {
        match state.audio.eq_status().await {
            Ok(Some(status)) => {
                // A failed or superseded application cannot pass by merely
                // acknowledging a different EQ configuration.
                let matches_saved = status.requested_gains_db == config.eq_gains_db
                    && status.requested_preamp_db == config.preamp_db;
                application["state"] = if matches_saved {
                    json!(status.state)
                } else {
                    json!("deferred")
                };
                application["eq"] =
                    serde_json::to_value(status).map_err(|error| internal(error.to_string()))?;
            }
            Ok(None) => application["state"] = json!(EqApplicationState::Unavailable),
            Err(error) => {
                let error = ApiError::from(CoreError::Audio(error));
                application["state"] = json!("failed");
                application["error"] = json!({"code":error.code,"message":error.message,"request_id":error.request_id});
            }
        }
    }
    value["application"] = application;
    Ok(value)
}

pub(crate) async fn read(state: &Arc<AppState>) -> Result<Value, ApiError> {
    let _commit = state.play_commit.lock().await;
    let settings = vmusic_store::settings::get_all(&state.db)
        .await
        .map_err(|error| ApiError::from(CoreError::Store(error)))?;
    let failure = state.dsp_application_error.lock().await.clone();
    let (config, _) = crate::audio_quality::from_settings(&settings)?;
    response(state, &crate::audio_quality::legacy(&config), failure).await
}

pub(crate) async fn update(state: &Arc<AppState>, update: DspUpdate) -> Result<Value, ApiError> {
    crate::audio_quality::legacy_update(state, update).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{Call, Op, Rpc};

    #[tokio::test]
    async fn dsp_http_rpc_saved_state_failure_and_atomicity() {
        let root = std::env::temp_dir().join(format!("hertz-dsp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db = vmusic_store::open(&root.join("library.sqlite"))
            .await
            .unwrap();
        let (mut fixture, audio_thread) = crate::state::tests::playback_state_with_db(db).await;
        fixture.token = "synthetic-dsp-test".into();
        fixture.data_dir = root.clone();
        let state = Arc::new(fixture);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = crate::routes::router(state.clone()).with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let rpc = Rpc::new(state.clone());
        let call = |op, body| Call {
            op,
            path: "v1/player/dsp",
            query: json!({}),
            body,
            raw: None,
            client_operation_id: None,
        };
        let request = json!({"eq_gains_db":[3,0,0,0,0,0],"preamp_db":-3,"loudness_mode":"track","crossfade_ms":700});
        let saved: Value = client
            .post(format!("{base}/v1/player/dsp"))
            .bearer_auth(&state.token)
            .json(&request)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            saved["application"]["state"], "unavailable",
            "null never acknowledges audio"
        );
        assert_eq!(saved["application"]["saved"], true);
        let rpc_saved = rpc.call(call(Op::Get, Value::Null)).await.unwrap().body;
        assert_eq!(saved, rpc_saved);
        assert_eq!(state.dsp.lock().await.eq_gains_db[0], 3.0);

        let before = vmusic_store::settings::get_all(&state.db).await.unwrap();
        sqlx::query("CREATE TRIGGER dsp_reject_preamp BEFORE INSERT ON settings WHEN NEW.key='audio_quality_v2' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
            .execute(&state.db).await.unwrap();
        assert!(rpc
            .call(call(
                Op::Post,
                json!({"eq_gains_db":[9,9,9,9,9,9],"preamp_db":6})
            ))
            .await
            .is_err());
        assert_eq!(
            vmusic_store::settings::get_all(&state.db).await.unwrap(),
            before
        );
        assert_eq!(state.dsp.lock().await.eq_gains_db[0], 3.0);
        sqlx::query("DROP TRIGGER dsp_reject_preamp")
            .execute(&state.db)
            .await
            .unwrap();
        assert!(rpc
            .call(call(Op::Post, json!({"loudness_mode":"invalid"})))
            .await
            .is_err());
        assert_eq!(
            vmusic_store::settings::get_all(&state.db).await.unwrap(),
            before
        );

        state.audio.shutdown();
        audio_thread.join().unwrap();
        let failed = rpc
            .call(call(Op::Post, json!({"preamp_db":-6})))
            .await
            .unwrap()
            .body;
        assert_eq!(failed["preamp_db"], -6.0);
        assert_eq!(failed["application"]["state"], "failed");
        assert_eq!(failed["application"]["saved"], true);
        assert!(failed["application"]["error"]["request_id"].is_string());
        let read_failed = rpc.call(call(Op::Get, Value::Null)).await.unwrap().body;
        assert_eq!(read_failed["application"]["state"], "failed");
        server.abort();
        let _ = server.await;
        state.db.close().await;
        drop(rpc);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dsp_validation_keeps_legacy_clamps_and_rejects_nonfinite_values() {
        let original = DspConfig::from_settings(&Default::default());
        let applied = update_config(
            original.clone(),
            DspUpdate {
                eq_gains_db: Some([99.0; 6]),
                preamp_db: Some(-50.0),
                crossfade_ms: Some(9000),
                ..DspUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(applied.eq_gains_db, [12.0; 6]);
        assert_eq!(applied.preamp_db, -24.0);
        assert_eq!(applied.crossfade_ms, 8000);
        assert!(update_config(
            original,
            DspUpdate {
                preamp_db: Some(f32::NAN),
                ..DspUpdate::default()
            }
        )
        .is_err());
    }
}
