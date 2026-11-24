// SPDX-License-Identifier: MIT
use super::*;
use crate::rpc::{Call, Op, Rpc};
use vmusic_core::{
    audio_quality::{LoudnessSource, QualityConfig},
    PlayerSnapshot,
};

struct Fixture {
    state: Arc<AppState>,
    actor: std::thread::JoinHandle<()>,
    root: std::path::PathBuf,
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hertz-preview-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&root).await.unwrap();
        let (mut state, actor) = crate::state::tests::playback_state_with_db(db).await;
        state.token = "preview-fixture-token".into();
        state.data_dir = root.clone();
        Self {
            state: Arc::new(state),
            actor,
            root,
        }
    }
    async fn close(self) {
        self.state.audio.shutdown();
        self.actor.join().unwrap();
        self.state.db.close().await;
        drop(self.state);
        let resolved = std::fs::canonicalize(&self.root).unwrap();
        assert!(resolved
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("hertz-preview-"));
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            match std::fs::remove_dir_all(&resolved) {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) if Instant::now() < until => {
                    tokio::time::sleep(Duration::from_millis(20)).await
                }
                Err(e) => panic!("fixture cleanup: {e}"),
            }
        }
    }
}
fn request_body() -> Value {
    json!({"request_id":"a0000000-0000-4000-8000-000000000000","expected_revision":"0","patch":{"preamp_db":-3}})
}
fn call<'a>(path: &'a str, body: Value) -> Call<'a> {
    Call {
        op: Op::Post,
        path,
        query: Value::Null,
        body,
        raw: None,
        client_operation_id: None,
    }
}

#[tokio::test]
async fn http_and_dbx_preview_errors_and_stale_cancel_share_the_service_owner() {
    let _serial = audio_loudness::ANALYSIS_TEST_SERIAL.lock().await;
    let f = Fixture::new().await;
    let state = f.state.clone();
    let rpc = Rpc::new(state.clone());
    let app = crate::routes::router(state.clone()).with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let client = reqwest::Client::new();
    let unauthorized = client
        .post(format!("{base}/v1/player/audio-quality/preview/cancel"))
        .json(&json!({"request_id":"a0000000-0000-4000-8000-000000000000"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let mut invalids = Vec::new();
    let mut v = request_body();
    v["request_id"] = json!("invalid");
    invalids.push(v);
    let mut v = request_body();
    v["expected_revision"] = json!("01");
    invalids.push(v);
    let mut v = request_body();
    v["patch"] = json!({});
    invalids.push(v);
    let mut v = request_body();
    v["patch"] = json!({"volume":0.5});
    invalids.push(v);
    let mut v = request_body();
    v["patch"] = json!({"limiter":"true_peak"});
    invalids.push(v);
    let mut v = request_body();
    v["patch"] = json!({"eq":{"extra":1}});
    invalids.push(v);
    let mut v = request_body();
    v["patch"] = json!({"preamp_db":99});
    invalids.push(v);
    let mut v = request_body();
    v["impulse_path"] = json!("");
    invalids.push(v);
    for body in invalids {
        let expected = rpc
            .call(call("v1/player/audio-quality/preview", body.clone()))
            .await
            .err()
            .unwrap();
        let response = client
            .post(format!("{base}/v1/player/audio-quality/preview"))
            .bearer_auth(&state.token)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), expected.status);
        let actual: Value = response.json().await.unwrap();
        assert_eq!(actual["error"]["code"], expected.code);
        assert_eq!(actual["error"]["message"], expected.message);
    }
    let id = "b0000000-0000-4000-8000-000000000000";
    let before = state.audio.snapshot();
    for suffix in ["cancel", "refresh"] {
        let path = format!("v1/player/audio-quality/preview/{suffix}");
        let body = json!({"request_id":id});
        let expected = rpc.call(call(&path, body.clone())).await.unwrap();
        let response = client
            .post(format!("{base}/{path}"))
            .bearer_auth(&state.token)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected.status);
        assert_eq!(response.json::<Value>().await.unwrap(), expected.body);
    }
    assert_eq!(state.audio.snapshot().generation, before.generation);
    assert!(vmusic_store::settings::get(&state.db, audio_quality::KEY)
        .await
        .unwrap()
        .is_none());
    assert_eq!(audio_loudness::READER.available_permits(), 1);
    stop.send(()).unwrap();
    server.await.unwrap();
    drop(rpc);
    drop(state);
    f.close().await;
}

#[tokio::test]
async fn null_preview_never_claims_audio_or_writes_preferences_and_saved_revision_invalidates_it() {
    let _serial = audio_loudness::ANALYSIS_TEST_SERIAL.lock().await;
    let f = Fixture::new().await;
    let state = &f.state;
    vmusic_store::upsert_track(
        &state.db,
        &vmusic_core::Track {
            id: "current".into(),
            path: "current.wav".into(),
            source: vmusic_core::TrackSource::Local,
            title: "current".into(),
            artist: None,
            album: None,
            duration_ms: None,
            bitrate: None,
            sample_rate: None,
            channels: None,
            has_cover: false,
            file_mtime: None,
            file_size: None,
            added_at: 0,
        },
    )
    .await
    .unwrap();
    state
        .audio
        .load("current.wav", Some("current".into()))
        .await
        .unwrap();
    let before = state.audio.snapshot();
    let value = audio_quality::read(state).await.unwrap();
    assert_eq!(value["capabilities"]["preview"]["available"], false);
    assert!(value["effective"].is_null());
    let error = request(state, serde_json::from_value(request_body()).unwrap())
        .await
        .unwrap_err();
    assert!(error.message.contains("本机输出"));
    assert_eq!(state.audio.snapshot().generation, before.generation);
    assert!(vmusic_store::settings::get(&state.db, audio_quality::KEY)
        .await
        .unwrap()
        .is_none());
    audio_quality::update(
        state,
        audio_quality::QualityUpdate {
            expected_revision: "0".into(),
            patch: json!({"preamp_db":-4}),
        },
    )
    .await
    .unwrap();
    let error = request(state, serde_json::from_value(request_body()).unwrap())
        .await
        .unwrap_err();
    assert_eq!(error.code, "audio_preview_stale");
    assert_eq!(audio_quality::read(state).await.unwrap()["revision"], "1");
    f.close().await;
}

#[tokio::test]
async fn observer_cancellation_does_not_release_analysis_or_reader_before_worker_cleanup() {
    let _serial = audio_loudness::ANALYSIS_TEST_SERIAL.lock().await;
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let available = f.state.beat_slots.available_permits();
    let (observer, lease) = begin(&f.state, "a0000000-0000-4000-8000-000000000000".into()).unwrap();
    assert_eq!(f.state.beat_slots.available_permits(), available - 1);
    assert_eq!(audio_loudness::READER.available_permits(), 0);
    assert!(!cancel_preparing(&other.state, None));
    assert!(!cancel_preparing(&f.state, Some("older")));
    drop(observer);
    assert!(lease.job.check().is_err());
    assert_eq!(f.state.beat_slots.available_permits(), available - 1);
    assert_eq!(audio_loudness::READER.available_permits(), 0);
    assert_eq!(
        begin(&f.state, "b0000000-0000-4000-8000-000000000000".into())
            .err()
            .unwrap()
            .code,
        "audio_preview_busy"
    );
    let expired = Control {
        until: Instant::now() - Duration::from_millis(1),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    assert!(expired.check().is_err());
    assert_eq!(audio_loudness::READER.available_permits(), 0);
    drop(lease);
    assert_eq!(audio_loudness::READER.available_permits(), 1);
    assert_eq!(f.state.beat_slots.available_permits(), available);
    let (mut observer, lease) =
        begin(&f.state, "b0000000-0000-4000-8000-000000000000".into()).unwrap();
    observer.armed = false;
    drop(observer);
    assert!(lease.job.check().is_ok());
    drop(lease);
    other.close().await;
    f.close().await;
}

#[tokio::test]
async fn measured_gain_requires_identical_bytes_before_preview_source_rebinding() {
    let _serial = audio_loudness::ANALYSIS_TEST_SERIAL.lock().await;
    let f = Fixture::new().await;
    let state = &f.state;
    state
        .audio
        .load("same.wav", Some("same".into()))
        .await
        .unwrap();
    let expected = state.audio.snapshot();
    let play = state.play_generation.load(Ordering::Relaxed);
    let mut config: QualityConfig = audio_quality::load(state).await.unwrap().0;
    config.schema_version = 3;
    config.loudness_source = LoudnessSource::R128;
    config.loudness_mode = "track".into();
    let selection = audio_loudness::GainSelection {
        source_sha256: Some("a".repeat(64)),
        state: "ready".into(),
        gain_db: -3.0,
        requested_gain_db: Some(-3.0),
        integrated_lufs: Some(-15.0),
        limited_by: None,
        album: false,
    };
    let applied = crate::measured_loudness::Applied::from_selection(&expected, selection, &config);
    assert!(applied.matches_bytes(&expected, &"a".repeat(64)));
    let mut progressed: PlayerSnapshot = expected.clone();
    progressed.generation += 1;
    progressed.position_ms = 200;
    assert!(
        applied.matches_bytes(&progressed, &"a".repeat(64)),
        "same media after seek keeps its byte identity"
    );
    progressed.source_generation += 1;
    assert!(!applied.matches_bytes(&progressed, &"a".repeat(64)));
    *state.measured_loudness.lock().await = Some(applied);
    let error = state
        .commit_audio_preview(
            "a0000000-0000-4000-8000-000000000000".into(),
            PreviewSide::Enhanced,
            expected.clone(),
            play,
            &"b".repeat(64),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("audio_preview_source_changed"));
    assert_eq!(state.audio.snapshot().generation, expected.generation);
    // Identical bytes pass this guard; the null backend still rejects actual audition.
    let error = state
        .commit_audio_preview(
            "a0000000-0000-4000-8000-000000000000".into(),
            PreviewSide::Enhanced,
            expected.clone(),
            play,
            &"a".repeat(64),
        )
        .await
        .unwrap_err();
    assert!(!error.to_string().contains("audio_preview_source_changed"));
    let mut stale = expected.clone();
    stale.generation += 1;
    assert!(state
        .commit_audio_preview(
            "a0000000-0000-4000-8000-000000000000".into(),
            PreviewSide::Enhanced,
            stale,
            play,
            &"a".repeat(64)
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("audio_preview_stale"));
    assert_eq!(
        state.audio.snapshot().source_generation,
        expected.source_generation
    );
    f.close().await;
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "actual shared output; zero PCM only, no audible or device-quality qualification"]
async fn shared_zero_pcm_http_preview_dbx_selection_and_byte_rebinding() {
    let _serial = audio_loudness::ANALYSIS_TEST_SERIAL.lock().await;
    use sha2::Digest;
    let mut f = Fixture::new().await;
    f.state.audio.shutdown();
    f.actor.join().unwrap();
    let (audio, actor) = vmusic_audio::spawn(vmusic_audio::BackendKind::Cpal)
        .await
        .unwrap();
    Arc::get_mut(&mut f.state).unwrap().audio = audio;
    f.actor = actor;
    let state = f.state.clone();
    let bytes = 48_000u32 * 2 * 2 * 4;
    let mut wav = Vec::with_capacity(bytes as usize + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(bytes + 36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&48_000u32.to_le_bytes());
    wav.extend_from_slice(&192_000u32.to_le_bytes());
    wav.extend_from_slice(&4u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&bytes.to_le_bytes());
    wav.resize(bytes as usize + 44, 0);
    assert!(wav[44..].iter().all(|b| *b == 0));
    let sha = format!("{:x}", sha2::Sha256::digest(&wav));
    let path = f.root.join("zero-pcm.wav");
    std::fs::write(&path, &wav).unwrap();
    vmusic_store::upsert_track(
        &state.db,
        &vmusic_core::Track {
            id: "zero-pcm".into(),
            path: path.to_string_lossy().into_owned(),
            source: vmusic_core::TrackSource::Local,
            title: "zero PCM lifecycle fixture".into(),
            artist: None,
            album: None,
            duration_ms: Some(4000),
            bitrate: None,
            sample_rate: Some(48_000),
            channels: Some(2),
            has_cover: false,
            file_mtime: None,
            file_size: Some(wav.len() as i64),
            added_at: 0,
        },
    )
    .await
    .unwrap();
    state.audio.set_volume(0.0).await.unwrap();
    audio_quality::update(
        &state,
        audio_quality::QualityUpdate {
            expected_revision: "0".into(),
            patch: json!({"loudness_source":"r128","loudness_mode":"track","limiter":"true_peak"}),
        },
    )
    .await
    .unwrap();
    state
        .audio
        .load_with_gain(
            path.to_string_lossy().as_ref(),
            Some("zero-pcm".into()),
            -3.0,
        )
        .await
        .unwrap();
    state.audio.play().await.unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if state.audio.snapshot().position_ms > 100 {
            break;
        }
        assert!(
            Instant::now() < until,
            "actual zero-PCM output did not advance"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    state.audio.pause().await.unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let quality = state.audio.quality_status().await.unwrap().unwrap();
        if !quality.eq.active {
            break;
        }
        assert!(
            Instant::now() < until,
            "pause did not reach actual output: {quality:?}; snapshot: {:?}",
            state.audio.snapshot()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let before = state.audio.snapshot();
    let config = audio_quality::load(&state).await.unwrap().0;
    // Synthetic fixed-gain context isolates byte/owner rebinding. Silence is not an R128 reference.
    *state.measured_loudness.lock().await =
        Some(crate::measured_loudness::Applied::from_selection(
            &before,
            audio_loudness::GainSelection {
                source_sha256: Some(sha.clone()),
                state: "ready".into(),
                gain_db: -3.0,
                requested_gain_db: Some(-3.0),
                integrated_lufs: Some(-15.0),
                limited_by: None,
                album: false,
            },
            &config,
        ));
    let app = crate::routes::router(state.clone()).with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let client = reqwest::Client::new();
    let rpc = Rpc::new(state.clone());
    let request_id = "a0000000-0000-4000-8000-000000000000";
    let response=client.post(format!("{base}/v1/player/audio-quality/preview")).bearer_auth(&state.token)
        .json(&json!({"request_id":request_id,"expected_revision":"1","patch":{"preamp_db":-3},"match_loudness":false}))
        .send().await.unwrap();
    let status = response.status();
    let value: Value = response.json().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["revision"], "1");
    assert_eq!(value["comparison"]["source_sha256"], sha);
    assert_eq!(value["effective"]["preview"]["request_id"], request_id);
    assert!(
        !state.audio.snapshot().playing,
        "starting a paused audition must preserve pause intent"
    );
    let after = state.audio.snapshot();
    assert_eq!(after.source_generation, before.source_generation + 1);
    assert!(state
        .measured_loudness
        .lock()
        .await
        .as_ref()
        .unwrap()
        .matches_bytes(&after, &sha));
    state.audio.play().await.unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let quality = state.audio.quality_status().await.unwrap().unwrap();
        if quality
            .preview
            .as_ref()
            .is_some_and(|p| p.state == "active" && p.effective_params.is_some())
        {
            break;
        }
        assert!(
            Instant::now() < until,
            "preview never reached the actual callback: {quality:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let selected = rpc
        .call(call(
            "v1/player/audio-quality/preview/select",
            json!({"request_id":request_id,"side":"bypass"}),
        ))
        .await
        .unwrap();
    assert_eq!(selected.body["effective"]["preview"]["side"], "bypass");
    assert_eq!(
        state.audio.snapshot().source_generation,
        after.source_generation
    );
    let cancelled = client
        .post(format!("{base}/v1/player/audio-quality/preview/cancel"))
        .bearer_auth(&state.token)
        .json(&json!({"request_id":request_id}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(cancelled["cancelled"], true);
    assert!(state
        .audio
        .quality_status()
        .await
        .unwrap()
        .unwrap()
        .preview
        .is_none());
    assert_eq!(
        state
            .audio
            .quality_status()
            .await
            .unwrap()
            .unwrap()
            .requested,
        config.params()
    );
    assert_eq!(state.audio.snapshot().volume, 0.0);
    assert_eq!(audio_quality::read(&state).await.unwrap()["revision"], "1");
    eprintln!(
        "SHARED_PREVIEW_PROBE {}",
        json!({"source_sha256":sha,"before_source_generation":before.source_generation,
        "preview_source_generation":after.source_generation,"output":state.audio.output_status().await.unwrap(),
        "zero_pcm":true,"http_prepare":true,"dbx_select":true,"http_cancel":true,"synthetic_gain_context":true,"audible_qualification":false})
    );
    stop.send(()).unwrap();
    server.await.unwrap();
    drop(rpc);
    drop(state);
    f.close().await;
}
