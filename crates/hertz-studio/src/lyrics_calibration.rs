// SPDX-License-Identifier: MIT
//! Bounded UI handoff owned by the existing source session. No playback or offset writes.
use crate::{error::ApiError, state::AppState};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

pub(crate) const LIMIT: usize = 4096;
const TOTAL: Duration = Duration::from_secs(5);
const LEASE: Duration = Duration::from_secs(3);
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
fn error(code: &'static str) -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        code,
        match code {
            "permission-required" => "请在当前播放器中允许从桌面打开校准",
            "receiver-unavailable" => "请先打开当前播放器界面或工作台",
            "track-changed" => "当前歌曲已变化，请重新同步后重试",
            "room-active" => "请在一起听房间内校准歌词",
            "focus-unavailable" => "校准界面已打开，但未能切到前台，请在播放器中查看",
            "timeout" => "未在期限内确认校准界面，请重试",
            "revocation-incomplete" => "本次校准已停用，但持久撤销未完成；重启可能恢复，请重试撤销",
            "revocation-cleanup-incomplete" => "校准已撤销，凭据清理未完成，请重试",
            "authorization-write-failed" => "校准授权未保存，请重试",
            "authorization-invalid" => "授权记录不相容或无效，文件已保留；请恢复配套版本后重新授权",
            _ => "校准请求已失效，请重新同步后重试",
        },
    )
}

#[cfg(all(test, windows, target_arch = "x86_64"))]
mod tests {
    use super::*;
    use crate::desktop_bridge::authorization::{create_key, Authorization};
    use hertz_desktop_ipc::Scope;
    fn wire_deadline(state: &AppState) -> Value {
        // A fresh fixture acceptance really occurs after the source's last
        // generation fence; never manufacture a timestamp beyond clock now.
        let floor = {
            let o = lock(&state.lyrics_calibration.owner);
            o.binding_floor_deadline.max(
                o.binding_order
                    .as_ref()
                    .map_or(0, |p| p.deadline_monotonic_ms),
            )
        };
        let deadline = loop {
            let deadline = hertz_desktop_ipc::monotonic::now_millis().unwrap() + 5000;
            if deadline > floor {
                break deadline;
            }
            std::thread::sleep(Duration::from_millis(1));
        };
        json!({"deadlineClock":hertz_desktop_ipc::monotonic::CLOCK,"deadlineMonotonicMs":deadline,"nativeSession":uuid::Uuid::new_v4().to_string(),"requestSequence":1,"session":state.server_instance_id()})
    }
    struct Fixture {
        state: std::sync::Arc<AppState>,
        audio: Option<std::thread::JoinHandle<()>>,
        directory: std::path::PathBuf,
    }
    impl Fixture {
        async fn new() -> Self {
            let directory = std::env::temp_dir()
                .join(format!("hertz-calibration-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let db = vmusic_store::open(&directory).await.unwrap();
            let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
            state.data_dir = directory.clone();
            state
                .audio
                .load("first.wav", Some("first".into()))
                .await
                .unwrap();
            Authorization {
                schema_version: 2,
                revision: 1,
                scopes: vec![Scope::LyricsCalibration],
            }
            .write(&directory)
            .unwrap();
            create_key(&directory, Scope::LyricsCalibration).unwrap();
            let state = std::sync::Arc::new(state);
            state.lyrics_calibration.load_standalone(&state);
            Self {
                state,
                audio: Some(audio),
                directory,
            }
        }
        fn page(&self, visible: bool) -> String {
            self.state
                .lyrics_calibration
                .ui(
                    &self.state,
                    json!({"op":"register","kind":"full","visible":visible}),
                )
                .unwrap()["receiverId"]
                .as_str()
                .unwrap()
                .into()
        }
        fn intent(&self, id: &str, seq: u64) -> Value {
            let mut binding = lock(&self.state.lyrics_calibration.owner).binding.clone();
            if binding.is_empty() {
                binding = self
                    .state
                    .lyrics_calibration
                    .narrow(&self.state, "bind", wire_deadline(&self.state))
                    .unwrap()["bindingId"]
                    .as_str()
                    .unwrap()
                    .to_owned();
            }
            json!({"version":1,"requestId":id,"bindingId":binding,"requestSequence":seq,"remainingMs":5000,"deadlineClock":hertz_desktop_ipc::monotonic::CLOCK,"deadlineMonotonicMs":hertz_desktop_ipc::monotonic::now_millis().unwrap()+5000,"session":self.state.server_instance_id(),"trackId":"first","generation":self.state.audio.snapshot().generation.to_string()})
        }
        fn action(&self, receiver: &str, id: &str, op: &str) -> Result<Value, ApiError> {
            self.state.lyrics_calibration.ui(
                &self.state,
                json!({"op":op,"receiverId":receiver,"requestId":id,"visible":true}),
            )
        }
        async fn finish(mut self) {
            self.state.audio.shutdown();
            self.audio.take().unwrap().join().unwrap();
            self.state.db.close().await;
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.state.audio.shutdown();
            if let Some(a) = self.audio.take() {
                a.join().unwrap();
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    #[tokio::test]
    async fn calibration_selects_one_stable_receiver_and_rejects_false_shown() {
        let f = Fixture::new().await;
        let hidden = f.page(false);
        let visible = f.page(true);
        let second = f.page(true);
        let i = f.intent("one", 1);
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "request", i.clone())
                .unwrap()["state"],
            "accepted"
        );
        assert!(f.action(&hidden, "one", "claim").unwrap()["intent"].is_null());
        assert!(f.action(&second, "one", "claim").unwrap()["intent"].is_null());
        assert_eq!(
            f.action(&visible, "one", "claim").unwrap()["intent"]["requestId"],
            "one"
        );
        assert!(f.action(&visible, "one", "claim").unwrap()["intent"].is_null());
        let mut completion = json!({"op":"complete","receiverId":second,"requestId":"one","result":"shown","detailVisible":true,"documentVisible":true,"documentFocused":true,"offsetFocused":true});
        assert!(f
            .state
            .lyrics_calibration
            .ui(&f.state, completion.clone())
            .is_err());
        completion["receiverId"] = visible.clone().into();
        completion["offsetFocused"] = false.into();
        assert!(f
            .state
            .lyrics_calibration
            .ui(&f.state, completion.clone())
            .is_err());
        completion["offsetFocused"] = true.into();
        assert_eq!(
            f.state.lyrics_calibration.ui(&f.state, completion).unwrap()["state"],
            "shown"
        );
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "request", i.clone())
                .unwrap()["state"],
            "shown"
        );
        let mut bad = i;
        bad["trackId"] = "other".into();
        assert!(f
            .state
            .lyrics_calibration
            .narrow(&f.state, "request", bad)
            .is_err());
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_terminal_gc_keeps_sequence_high_water_and_no_revival() {
        let f = Fixture::new().await;
        let receiver = f.page(true);
        let i = f.intent("one", 1);
        f.state
            .lyrics_calibration
            .narrow(&f.state, "request", i.clone())
            .unwrap();
        let query = json!({"bindingId":i["bindingId"],"requestId":"one"});
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "cancel", query.clone())
                .unwrap()["state"],
            "cancelled"
        );
        assert!(f.action(&receiver, "one", "validate").is_err());
        lock(&f.state.lyrics_calibration.owner)
            .terminals
            .front_mut()
            .unwrap()
            .at = Instant::now() - Duration::from_secs(61);
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "request", i)
                .unwrap()["state"],
            "expired/unknown"
        );
        for seq in 2..70 {
            let id = format!("request-{seq}");
            let i = f.intent(&id, seq);
            f.state
                .lyrics_calibration
                .narrow(&f.state, "request", i.clone())
                .unwrap();
            f.state
                .lyrics_calibration
                .narrow(
                    &f.state,
                    "cancel",
                    json!({"bindingId":i["bindingId"],"requestId":id}),
                )
                .unwrap();
        }
        assert_eq!(lock(&f.state.lyrics_calibration.owner).terminals.len(), 64);
        let i = f.intent("last", 70);
        f.state
            .lyrics_calibration
            .narrow(&f.state, "request", i)
            .unwrap();
        lock(&f.state.lyrics_calibration.owner)
            .pending
            .as_mut()
            .unwrap()
            .deadline = Instant::now();
        assert!(f.action(&receiver, "last", "validate").is_err());
        assert_eq!(
            lock(&f.state.lyrics_calibration.owner)
                .terminals
                .back()
                .unwrap()
                .result,
            "timeout"
        );
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_scope_schema_bounds_track_and_revocation_are_enforced() {
        let f = Fixture::new().await;
        assert!(Authorization::parse(
            br#"{"schemaVersion":1,"revision":1,"scopes":["lyricsCalibration"]}"#
        )
        .is_err());
        assert!(Authorization::parse(
            br#"{"schemaVersion":2,"revision":1,"scopes":["lyrics","lyricsCalibration"]}"#
        )
        .is_ok());
        assert!(Authorization::parse(br#"{"schemaVersion":3,"revision":1,"scopes":[]}"#).is_err());
        for _ in 0..8 {
            f.page(true);
        }
        assert!(f
            .state
            .lyrics_calibration
            .ui(&f.state, json!({"op":"register","kind":"full"}))
            .is_err());
        assert!(f
            .state
            .lyrics_calibration
            .narrow(&f.state, "request", json!({"text":"a".repeat(4096)}))
            .is_err());
        let i = f.intent("one", 1);
        f.state
            .lyrics_calibration
            .narrow(&f.state, "request", i.clone())
            .unwrap();
        f.state
            .audio
            .load("second.wav", Some("second".into()))
            .await
            .unwrap();
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(
                    &f.state,
                    "result",
                    json!({"bindingId":i["bindingId"],"requestId":"one"})
                )
                .unwrap()["state"],
            "track-changed"
        );
        Authorization {
            schema_version: 2,
            revision: 2,
            scopes: vec![Scope::Lyrics],
        }
        .write(&f.directory)
        .unwrap();
        assert!(f
            .state
            .lyrics_calibration
            .narrow(&f.state, "bind", wire_deadline(&f.state))
            .is_err());
        assert!(
            !f.state.lyrics_calibration.capability(&f.state, true)["authorized"]
                .as_bool()
                .unwrap()
        );
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_http_credentials_cannot_cross_scope_or_forge_completion() {
        let f = Fixture::new().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = crate::routes::router(f.state.clone()).with_state(f.state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let key =
            crate::desktop_bridge::authorization::read_key(&f.directory, Scope::LyricsCalibration)
                .unwrap()
                .to_string();
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .post(format!("{base}/v1/desktop-lyrics/calibration/bind"))
                .header("Authorization", format!("LyricsCalibration {key}"))
                .json(&wire_deadline(&f.state))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        for route in [
            "/v1/desktop/calibration-ui",
            "/v1/player/play",
            "/v1/tracks/first/lyrics/offset",
        ] {
            assert_eq!(
                client
                    .post(format!("{base}{route}"))
                    .header("Authorization", format!("LyricsCalibration {key}"))
                    .json(&json!({}))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            client
                .get(format!("{base}/v1/desktop-lyrics/snapshot"))
                .header("Authorization", format!("LyricsCalibration {key}"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .post(format!("{base}/v1/desktop-lyrics/calibration/bind"))
                .header("Authorization", format!("Desktop {key}"))
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        server.abort();
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_standalone_consent_preserves_read_scopes_and_future_record() {
        let f = Fixture::new().await;
        f.state
            .lyrics_calibration
            .standalone_authorization(&f.state, Some(false))
            .unwrap();
        Authorization {
            schema_version: 1,
            revision: 3,
            scopes: vec![Scope::Lyrics, Scope::Wallpaper],
        }
        .write(&f.directory)
        .unwrap();
        assert!(!f
            .state
            .lyrics_calibration
            .standalone_authorization(&f.state, None)
            .unwrap()["authorized"]
            .as_bool()
            .unwrap());
        assert_eq!(
            f.state
                .lyrics_calibration
                .standalone_authorization(&f.state, Some(true))
                .unwrap()["authorized"],
            true
        );
        assert_eq!(
            Authorization::read(&f.directory).unwrap().unwrap().scopes,
            vec![Scope::Lyrics, Scope::Wallpaper, Scope::LyricsCalibration]
        );
        f.state
            .lyrics_calibration
            .standalone_authorization(&f.state, Some(false))
            .unwrap();
        let future = br#"{"schemaVersion":3,"revision":5,"scopes":["lyrics"]}"#;
        hertz_desktop_ipc::windows::write_private_atomic(
            &f.directory.join("desktop-authorization.json"),
            future,
            hertz_desktop_ipc::AUTHORIZATION_LIMIT,
        )
        .unwrap();
        assert_eq!(
            f.state
                .lyrics_calibration
                .standalone_authorization(&f.state, Some(true))
                .unwrap_err()
                .code,
            "authorization-invalid"
        );
        assert_eq!(
            std::fs::read(f.directory.join("desktop-authorization.json")).unwrap(),
            future
        );
        assert!(!f.state.lyrics_calibration.authenticate(&f.state, "unused"));
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_standalone_failed_persistence_cancels_and_requires_revoke_retry() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new().await;
        let receiver = f.page(true);
        let intent = f.intent("active", 1);
        f.state
            .lyrics_calibration
            .narrow(&f.state, "request", intent)
            .unwrap();
        let path = f.directory.join("desktop-authorization.json");
        let original = std::fs::read(&path).unwrap();
        let guard = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert_eq!(
            f.state
                .lyrics_calibration
                .standalone_authorization(&f.state, Some(false))
                .unwrap_err()
                .code,
            "revocation-incomplete"
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(f.action(&receiver, "active", "validate").is_err());
        let status = f
            .state
            .lyrics_calibration
            .standalone_authorization(&f.state, None)
            .unwrap();
        assert_eq!(status["authorized"], false);
        assert_eq!(status["persistentAuthorized"], true);
        drop(guard);
        assert_eq!(
            f.state
                .lyrics_calibration
                .standalone_authorization(&f.state, Some(false))
                .unwrap()["persistentAuthorized"],
            false
        );
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_standalone_failed_key_cleanup_is_reported_and_retryable() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new().await;
        let key_path = f.directory.join("desktop-lyrics-calibration-key");
        let guard = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&key_path)
            .unwrap();
        assert_eq!(
            f.state
                .lyrics_calibration
                .standalone_authorization(&f.state, Some(false))
                .unwrap_err()
                .code,
            "revocation-cleanup-incomplete"
        );
        let status = f
            .state
            .lyrics_calibration
            .standalone_authorization(&f.state, None)
            .unwrap();
        assert_eq!(status["authorized"], false);
        assert_eq!(status["persistentAuthorized"], false);
        assert_eq!(status["cleanupIncomplete"], true);
        drop(guard);
        assert_eq!(
            f.state
                .lyrics_calibration
                .standalone_authorization(&f.state, Some(false))
                .unwrap()["cleanupIncomplete"],
            false
        );
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_dbx_handoff_assigns_one_full_target_and_survives_forwarder_exit() {
        let f = Fixture::new().await;
        let bridge = crate::desktop_bridge::DesktopBridge::new(&f.state);
        crate::desktop::Desktop::for_state(&f.state).attach_bridge(bridge.clone());
        bridge.restore().await.unwrap();
        let floating = f
            .state
            .lyrics_calibration
            .ui(
                &f.state,
                json!({"op":"register","kind":"floating","visible":true,"workbench":true}),
            )
            .unwrap()["receiverId"]
            .as_str()
            .unwrap()
            .to_owned();
        let intent = f.intent("handoff", 1);
        let binding = intent["bindingId"].clone();
        f.state
            .lyrics_calibration
            .narrow(&f.state, "request", intent)
            .unwrap();
        assert!(f.action(&floating, "handoff", "claim").unwrap()["intent"].is_object());
        let marker = f.action(&floating, "handoff", "handoff").unwrap()["handoff"].clone();
        assert!(marker.is_string());
        assert!(f.action(&floating, "handoff", "handoff").is_err());
        assert!(f.state.lyrics_calibration.ui(&f.state, json!({"op":"complete","receiverId":floating,"requestId":"handoff","result":"shown","detailVisible":true,"documentVisible":true,"documentFocused":true,"offsetFocused":true})).is_err());
        let full = |token: &str| {
            f.state
                .lyrics_calibration
                .ui(
                    &f.state,
                    json!({"op":"register","kind":"full","visible":true,"workbench":true,"handoff":token}),
                )
                .unwrap()["receiverId"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let other = full("");
        assert!(f.action(&other, "handoff", "claim").unwrap()["intent"].is_null());
        assert!(f.state.lyrics_calibration.ui(&f.state,json!({"op":"register","kind":"full","visible":true,"workbench":true,"handoff":"wrong-marker"})).is_err());
        let target = full(marker.as_str().unwrap());
        assert!(f.action(&target, "handoff", "claim").unwrap()["intent"].is_null());
        let claimed = f
            .state
            .lyrics_calibration
            .ui(
                &f.state,
                json!({"op":"claim","receiverId":target,"visible":true,"handoff":marker}),
            )
            .unwrap();
        assert_eq!(claimed["handoff"], marker);
        assert!(f.action(&other, "handoff", "claim").unwrap()["intent"].is_null());
        f.action(&floating, "handoff", "unregister").unwrap();
        assert_eq!(
            f.action(&target, "handoff", "validate").unwrap()["valid"],
            true
        );
        lock(&f.state.lyrics_calibration.owner)
            .pending
            .as_mut()
            .unwrap()
            .deadline = Instant::now();
        assert!(f.action(&target, "handoff", "validate").is_err());
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(
                    &f.state,
                    "result",
                    json!({"bindingId":binding,"requestId":"handoff"})
                )
                .unwrap()["state"],
            "timeout"
        );
        bridge.shutdown().await;
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_cancel_while_snapshot_is_locked_cannot_reactivate_on_load_completion() {
        let f = Fixture::new().await;
        let receiver = f.page(true);
        let intent = f.intent("loading", 1);
        let binding = intent["bindingId"].clone();
        let guard = f.state.buffering.lock().await;
        let state = f.state.clone();
        let worker = tokio::spawn(async move {
            state
                .lyrics_calibration
                .receive(&state, "request", intent)
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !lock(&f.state.lyrics_calibration.owner)
                .pending
                .as_ref()
                .is_some_and(|p| p.loading)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(f.action(&receiver, "loading", "claim").unwrap()["intent"].is_null());
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(
                    &f.state,
                    "cancel",
                    json!({"bindingId":binding,"requestId":"loading"})
                )
                .unwrap()["state"],
            "cancelled"
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(500), worker)
                .await
                .unwrap()
                .unwrap()
                .unwrap()["state"],
            "cancelled"
        );
        drop(guard);
        assert!(f.action(&receiver, "loading", "claim").unwrap()["intent"].is_null());
        assert!(f.action(&receiver, "loading", "validate").is_err());
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_cancel_before_wire_delivery_is_bounded_and_never_admitted_later() {
        let f = Fixture::new().await;
        let receiver = f.page(true);
        let intent = f.intent("delayed", 1);
        let binding = intent["bindingId"].clone();
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(
                    &f.state,
                    "cancel",
                    json!({"bindingId":binding,"requestId":"delayed"})
                )
                .unwrap()["state"],
            "cancelled"
        );
        assert_eq!(
            f.state
                .lyrics_calibration
                .receive(&f.state, "request", intent)
                .await
                .unwrap()["state"],
            "cancelled"
        );
        assert!(f.action(&receiver, "delayed", "claim").unwrap()["intent"].is_null());
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "request", f.intent("same-sequence", 1))
                .unwrap()["state"],
            "expired/unknown"
        );
        for n in 0..70 {
            f.state
                .lyrics_calibration
                .narrow(
                    &f.state,
                    "cancel",
                    json!({"bindingId":binding,"requestId":format!("cancel-{n}")}),
                )
                .unwrap();
        }
        assert_eq!(lock(&f.state.lyrics_calibration.owner).terminals.len(), 64);
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_four_second_wire_delay_cannot_extend_five_second_deadline() {
        let f = Fixture::new().await;
        let receiver = f.page(true);
        let intent = f.intent("transport-delay", 1);
        for _ in 0..4 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            f.action(&receiver, "", "renew").unwrap();
        }
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "request", intent.clone())
                .unwrap()["state"],
            "accepted"
        );
        assert!(
            lock(&f.state.lyrics_calibration.owner)
                .pending
                .as_ref()
                .unwrap()
                .deadline
                .saturating_duration_since(Instant::now())
                < Duration::from_millis(1100)
        );
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(f.action(&receiver, "transport-delay", "validate").is_err());
        assert!(f.action(&receiver, "transport-delay", "claim").unwrap()["intent"].is_null());
        let mut late = intent;
        late["requestId"] = "arrived-after-expiry".into();
        late["requestSequence"] = 2.into();
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "request", late)
                .unwrap_err()
                .code,
            "timeout"
        );
        let mut wrong_clock = f.intent("wall-clock", 3);
        wrong_clock["deadlineClock"] = "unix-utc-ms".into();
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "request", wrong_clock)
                .unwrap_err()
                .code,
            "timeout"
        );
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_expired_bind_cannot_replace_a_newer_binding() {
        let f = Fixture::new().await;
        f.page(true);
        let intent = f.intent("current", 1);
        let original = intent["bindingId"].clone();
        let mut expired = wire_deadline(&f.state);
        expired["deadlineMonotonicMs"] = hertz_desktop_ipc::monotonic::now_millis()
            .unwrap()
            .saturating_sub(1)
            .into();
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "bind", expired)
                .unwrap_err()
                .code,
            "timeout"
        );
        assert_eq!(
            lock(&f.state.lyrics_calibration.owner).binding,
            original.as_str().unwrap()
        );
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "request", intent)
                .unwrap()["state"],
            "accepted"
        );
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_late_unexpired_http_bind_cannot_cancel_newer_loading_request() {
        let f = Fixture::new().await;
        f.page(true);
        let a = wire_deadline(&f.state);
        let a_deadline = a["deadlineMonotonicMs"].as_u64().unwrap();
        while hertz_desktop_ipc::monotonic::now_millis().unwrap() + 5000 <= a_deadline {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        let mut b = wire_deadline(&f.state);
        b["nativeSession"] = a["nativeSession"].clone();
        b["requestSequence"] = 2.into();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = crate::routes::router(f.state.clone()).with_state(f.state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let key =
            crate::desktop_bridge::authorization::read_key(&f.directory, Scope::LyricsCalibration)
                .unwrap()
                .to_string();
        let client = reqwest::Client::new();
        let bind_url = format!("{base}/v1/desktop-lyrics/calibration/bind");
        let bound: Value = client
            .post(&bind_url)
            .header("Authorization", format!("LyricsCalibration {key}"))
            .json(&b)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let mut intent = f.intent("newer-B", 2);
        intent["deadlineMonotonicMs"] = b["deadlineMonotonicMs"].clone();
        let guard = f.state.buffering.lock().await;
        let request = client
            .post(format!("{base}/v1/desktop-lyrics/calibration/request"))
            .header("Authorization", format!("LyricsCalibration {key}"))
            .json(&intent);
        let loading = tokio::spawn(async move { request.send().await.unwrap() });
        tokio::time::timeout(Duration::from_millis(500), async {
            while !lock(&f.state.lyrics_calibration.owner)
                .pending
                .as_ref()
                .is_some_and(|p| p.loading)
            {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        // A still has budget, but was accepted by native before B and arrived last.
        assert!(hertz_desktop_ipc::monotonic::remaining(
            hertz_desktop_ipc::monotonic::CLOCK,
            a_deadline
        )
        .is_some());
        let stale = client
            .post(&bind_url)
            .header("Authorization", format!("LyricsCalibration {key}"))
            .json(&a)
            .send()
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        let duplicate: Value = client
            .post(&bind_url)
            .header("Authorization", format!("LyricsCalibration {key}"))
            .json(&b)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(duplicate["bindingId"], bound["bindingId"]);
        {
            let o = lock(&f.state.lyrics_calibration.owner);
            assert_eq!(o.binding, bound["bindingId"].as_str().unwrap());
            assert_eq!(o.high_water, 2);
            assert_eq!(o.pending.as_ref().unwrap().intent.request_id, "newer-B");
        }
        drop(guard);
        let _ = loading.await.unwrap();
        server.abort();
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_same_tick_native_order_and_restart_cannot_rewind_binding() {
        let f = Fixture::new().await;
        f.page(true);
        let mut b = wire_deadline(&f.state);
        b["requestSequence"] = 2.into();
        let bound = f
            .state
            .lyrics_calibration
            .narrow(&f.state, "bind", b.clone())
            .unwrap();
        let mut intent = f.intent("B", 2);
        intent["deadlineMonotonicMs"] = b["deadlineMonotonicMs"].clone();
        f.state
            .lyrics_calibration
            .narrow(&f.state, "request", intent)
            .unwrap();
        let mut older_same_process = b.clone();
        older_same_process["requestSequence"] = 1.into();
        let mut other_process_same_tick = b.clone();
        other_process_same_tick["nativeSession"] = uuid::Uuid::new_v4().to_string().into();
        other_process_same_tick["requestSequence"] = u64::MAX.into();
        for old in [older_same_process, other_process_same_tick] {
            assert_eq!(
                f.state
                    .lyrics_calibration
                    .narrow(&f.state, "bind", old)
                    .unwrap_err()
                    .code,
                "request-conflict"
            );
        }
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "bind", b.clone())
                .unwrap()["bindingId"],
            bound["bindingId"]
        );
        // Reusing an accepted request sequence with a rewritten later deadline
        // cannot rotate a binding or reset its sequence watermark either.
        let mut same_sequence = wire_deadline(&f.state);
        same_sequence["nativeSession"] = b["nativeSession"].clone();
        same_sequence["requestSequence"] = 2.into();
        assert!(f
            .state
            .lyrics_calibration
            .narrow(&f.state, "bind", same_sequence)
            .is_err());
        let o = lock(&f.state.lyrics_calibration.owner);
        assert_eq!(o.binding, bound["bindingId"].as_str().unwrap());
        assert_eq!(o.high_water, 2);
        assert_eq!(o.pending.as_ref().unwrap().intent.request_id, "B");
        drop(o);
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_reconsent_fences_bind_authenticated_before_revocation() {
        let f = Fixture::new().await;
        f.page(true);
        let late_authenticated = wire_deadline(&f.state);
        // Entering narrow models a call whose middleware already accepted the
        // old credential. The canonical owner still checks its consent fence.
        f.state
            .lyrics_calibration
            .standalone_authorization(&f.state, Some(false))
            .unwrap();
        f.state
            .lyrics_calibration
            .standalone_authorization(&f.state, Some(true))
            .unwrap();
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "bind", late_authenticated.clone())
                .unwrap_err()
                .code,
            "request-conflict"
        );
        let current = wire_deadline(&f.state);
        let bound = f
            .state
            .lyrics_calibration
            .narrow(&f.state, "bind", current)
            .unwrap();
        f.state
            .lyrics_calibration
            .narrow(&f.state, "request", f.intent("after-reconsent", 1))
            .unwrap();
        assert!(f
            .state
            .lyrics_calibration
            .narrow(&f.state, "bind", late_authenticated)
            .is_err());
        let o = lock(&f.state.lyrics_calibration.owner);
        assert_eq!(o.binding, bound["bindingId"].as_str().unwrap());
        assert_eq!(
            o.pending.as_ref().unwrap().intent.request_id,
            "after-reconsent"
        );
        drop(o);
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_loading_request_cannot_revive_after_track_change_or_revoke() {
        for revoke in [false, true] {
            let f = Fixture::new().await;
            let receiver = f.page(true);
            let intent = f.intent("loading-invalidated", 1);
            let guard = f.state.buffering.lock().await;
            let state = f.state.clone();
            let worker = tokio::spawn(async move {
                state
                    .lyrics_calibration
                    .receive(&state, "request", intent)
                    .await
            });
            tokio::time::timeout(Duration::from_secs(1), async {
                while !lock(&f.state.lyrics_calibration.owner)
                    .pending
                    .as_ref()
                    .is_some_and(|p| p.loading)
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if revoke {
                f.state.lyrics_calibration.set_gate(false, false);
            } else {
                f.state
                    .audio
                    .load("second.wav", Some("second".into()))
                    .await
                    .unwrap();
            }
            assert!(
                f.action(&receiver, "loading-invalidated", "claim").unwrap()["intent"].is_null()
            );
            drop(guard);
            assert_ne!(worker.await.unwrap().unwrap()["state"], "accepted");
            assert!(f
                .action(&receiver, "loading-invalidated", "validate")
                .is_err());
            f.finish().await;
        }
    }
    #[tokio::test]
    async fn calibration_native_rebinding_allows_reset_sequence_and_invalidates_old_subject() {
        let f = Fixture::new().await;
        let receiver = f.page(true);
        let original = f.intent("old-process", 30);
        let old_binding = original["bindingId"].clone();
        f.state
            .lyrics_calibration
            .narrow(&f.state, "request", original.clone())
            .unwrap();
        let rebound = f
            .state
            .lyrics_calibration
            .narrow(&f.state, "bind", wire_deadline(&f.state))
            .unwrap();
        assert_ne!(rebound["bindingId"], old_binding);
        assert!(f.action(&receiver, "old-process", "validate").is_err());
        assert!(f
            .state
            .lyrics_calibration
            .narrow(&f.state, "request", original)
            .is_err());
        assert!(f
            .state
            .lyrics_calibration
            .narrow(
                &f.state,
                "result",
                json!({"bindingId":old_binding,"requestId":"old-process"})
            )
            .is_err());
        let new_intent = f.intent("new-process", 1);
        assert_eq!(
            f.state
                .lyrics_calibration
                .narrow(&f.state, "request", new_intent)
                .unwrap()["state"],
            "accepted"
        );
        f.finish().await;
    }
    #[tokio::test]
    async fn calibration_source_shutdown_rejects_late_ui_side_effects_without_revoke() {
        let f = Fixture::new().await;
        let receiver = f.page(true);
        let intent = f.intent("shutdown", 1);
        f.state
            .lyrics_calibration
            .narrow(&f.state, "request", intent)
            .unwrap();
        f.state.exiting.send_replace(true);
        assert!(f.action(&receiver, "shutdown", "validate").is_err());
        assert!(f
            .state
            .lyrics_calibration
            .ui(
                &f.state,
                json!({"op":"register","kind":"full","visible":true})
            )
            .is_err());
        assert_eq!(
            f.state.lyrics_calibration.capability(&f.state, true)["available"],
            false
        );
        assert!(Authorization::read(&f.directory)
            .unwrap()
            .unwrap()
            .scopes
            .contains(&Scope::LyricsCalibration));
        f.finish().await;
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Intent {
    pub version: u32,
    pub request_id: String,
    pub binding_id: String,
    pub request_sequence: u64,
    pub remaining_ms: u64,
    pub deadline_clock: String,
    pub deadline_monotonic_ms: u64,
    pub session: String,
    pub track_id: String,
    pub generation: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiCall {
    op: String,
    #[serde(default)]
    receiver_id: String,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    visible: bool,
    #[serde(default)]
    workbench: bool,
    #[serde(default)]
    detail_visible: bool,
    #[serde(default)]
    document_visible: bool,
    #[serde(default)]
    document_focused: bool,
    #[serde(default)]
    offset_focused: bool,
    #[serde(default)]
    result: String,
    #[serde(default)]
    handoff: String,
}
struct Receiver {
    id: String,
    kind: String,
    visible: bool,
    workbench: bool,
    expires: Instant,
}
struct Pending {
    intent: Intent,
    deadline: Instant,
    receiver: String,
    handoff: Option<String>,
    target: Option<String>,
    claimed: bool,
    loading: bool,
    cancel_loading: tokio::sync::watch::Sender<bool>,
}
struct Loading {
    intent: Intent,
    deadline: Instant,
    cancelled: tokio::sync::watch::Receiver<bool>,
}
struct Terminal {
    request_id: String,
    intent: Option<Intent>,
    result: &'static str,
    at: Instant,
}
#[derive(PartialEq, Eq)]
struct BindingOrder {
    deadline_monotonic_ms: u64,
    native_session: String,
    request_sequence: u64,
}
#[derive(Default)]
struct Owner {
    authorized: bool,
    dbx: bool,
    loaded: bool,
    key: Option<zeroize::Zeroizing<String>>,
    binding: String,
    // Retained when consent closes: an already-authenticated old bind must not
    // become fresh just because the current binding was retired.
    binding_order: Option<BindingOrder>,
    binding_floor_deadline: u64,
    high_water: u64,
    receivers: Vec<Receiver>,
    pending: Option<Pending>,
    terminals: VecDeque<Terminal>,
}
#[derive(Default)]
pub(crate) struct LyricsCalibration {
    owner: Mutex<Owner>,
    file: Mutex<()>,
}

impl Owner {
    fn fence_binding(&mut self) {
        if let Some(order) = self.binding_order.as_mut() {
            order.request_sequence = order.request_sequence.max(self.high_water);
        }
        if let Some(now) = hertz_desktop_ipc::monotonic::now_millis() {
            self.binding_floor_deadline = self.binding_floor_deadline.max(now.saturating_add(5000));
        }
    }
    fn finish(&mut self, result: &'static str) {
        if let Some(p) = self.pending.take() {
            p.cancel_loading.send_replace(true);
            self.terminals.push_back(Terminal {
                request_id: p.intent.request_id.clone(),
                intent: Some(p.intent),
                result,
                at: Instant::now(),
            });
            while self.terminals.len() > 64 {
                self.terminals.pop_front();
            }
        }
    }
    fn sweep(&mut self, state: &AppState) {
        if *state.exiting.borrow() {
            self.fence_binding();
            self.authorized = false;
            self.key = None;
            self.finish("cancelled");
            self.binding.clear();
            self.terminals.clear();
            self.receivers.clear();
            return;
        }
        if self.dbx
            && !state
                .desktop
                .get()
                .is_some_and(|d| d.calibration_authorized())
        {
            self.fence_binding();
            self.authorized = false;
            self.finish("permission-required");
            self.binding.clear();
            self.terminals.clear();
        }
        #[cfg(all(windows, target_arch = "x86_64"))]
        if self.authorized && !self.dbx {
            use crate::desktop_bridge::authorization::{read_key, Authorization};
            use hertz_desktop_ipc::Scope;
            let valid = Authorization::read(&state.data_dir)
                .ok()
                .flatten()
                .is_some_and(|r| r.scopes.contains(&Scope::LyricsCalibration))
                && read_key(&state.data_dir, Scope::LyricsCalibration)
                    .ok()
                    .is_some_and(|k| self.key.as_ref().is_some_and(|active| *active == k));
            if !valid {
                self.fence_binding();
                self.authorized = false;
                self.key = None;
                self.finish("permission-required");
                self.binding.clear();
                self.terminals.clear();
            }
        }
        let now = Instant::now();
        self.terminals
            .retain(|t| now.duration_since(t.at) < Duration::from_secs(60));
        self.receivers.retain(|r| now < r.expires);
        if let Some(p) = &self.pending {
            let reason = if !self.authorized {
                Some("permission-required")
            } else if now >= p.deadline
                || hertz_desktop_ipc::monotonic::remaining(
                    &p.intent.deadline_clock,
                    p.intent.deadline_monotonic_ms,
                )
                .is_none()
            {
                Some("timeout")
            } else if !matches_truth(state, &p.intent) {
                Some("track-changed")
            } else if state.room.is_active() {
                Some("room-active")
            } else if !self
                .receivers
                .iter()
                .any(|r| r.id == p.target.as_deref().unwrap_or(&p.receiver))
            {
                Some("receiver-unavailable")
            } else {
                None
            };
            if let Some(reason) = reason {
                self.finish(reason);
            }
        }
    }
    fn result(&self, id: &str) -> Value {
        if let Some(p) = self.pending.as_ref().filter(|p| p.intent.request_id == id) {
            json!({"requestId":id,"state":"accepted","remainingMs":p.deadline.saturating_duration_since(Instant::now()).as_millis()})
        } else if let Some(t) = self.terminals.iter().find(|t| t.request_id == id) {
            json!({"requestId":id,"state":t.result})
        } else {
            json!({"requestId":id,"state":"expired/unknown"})
        }
    }
}
fn matches_truth(state: &AppState, i: &Intent) -> bool {
    let player = state.audio.snapshot();
    state.server_instance_id() == i.session
        && player.track_id.as_deref() == Some(&i.track_id)
        && player.generation.to_string() == i.generation
}
impl LyricsCalibration {
    /// DBX authorization remains owned by the bridge; gate changes invalidate all bindings.
    pub(crate) fn set_gate(&self, authorized: bool, dbx: bool) {
        let mut owner = lock(&self.owner);
        owner.fence_binding();
        owner.finish("permission-required");
        owner.authorized = authorized;
        owner.dbx = dbx;
        owner.loaded = true;
        owner.binding.clear();
        owner.high_water = 0;
        owner.terminals.clear();
        if !authorized {
            owner.key = None;
        }
    }
    fn load_standalone(&self, state: &AppState) {
        if lock(&self.owner).loaded {
            return;
        }
        let _file = lock(&self.file);
        let mut owner = lock(&self.owner);
        if owner.loaded {
            return;
        }
        owner.loaded = true;
        #[cfg(all(windows, target_arch = "x86_64"))]
        if let Ok(Some(record)) =
            crate::desktop_bridge::authorization::Authorization::read(&state.data_dir)
        {
            if record
                .scopes
                .contains(&hertz_desktop_ipc::Scope::LyricsCalibration)
            {
                if let Ok(key) = crate::desktop_bridge::authorization::read_key(
                    &state.data_dir,
                    hertz_desktop_ipc::Scope::LyricsCalibration,
                ) {
                    owner.key = Some(key);
                    owner.authorized = true;
                }
            }
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        let _ = state;
    }
    pub(crate) fn capability(&self, state: &AppState, lyrics_ready: bool) -> Value {
        self.load_standalone(state);
        let mut o = lock(&self.owner);
        o.sweep(state);
        let reason = if hertz_desktop_ipc::monotonic::now_millis().is_none() {
            "capability-unavailable"
        } else if !o.authorized {
            "permission-required"
        } else if state.room.is_active() {
            "room-active"
        } else if state.audio.snapshot().track_id.is_none() {
            "track-changed"
        } else if !lyrics_ready {
            "lyrics-unavailable"
        } else if !o.receivers.iter().any(|r| !o.dbx || r.workbench) {
            "receiver-unavailable"
        } else {
            ""
        };
        json!({"version":1,"available":reason.is_empty(),"reason":reason,"authorized":o.authorized})
    }
    pub(crate) fn standalone_authorization(
        &self,
        state: &AppState,
        enabled: Option<bool>,
    ) -> Result<Value, ApiError> {
        self.load_standalone(state);
        if let Some(enabled) = enabled {
            let _file = lock(&self.file);
            {
                let mut o = lock(&self.owner);
                o.fence_binding();
                o.authorized = false;
                o.key = None;
                o.finish("permission-required");
                o.binding.clear();
                o.high_water = 0;
                o.terminals.clear();
            }
            #[cfg(all(windows, target_arch = "x86_64"))]
            {
                use crate::desktop_bridge::authorization::{create_key, key_file, Authorization};
                use hertz_desktop_ipc::{windows, Scope};
                let existing = Authorization::read(&state.data_dir)
                    .map_err(|_| error("authorization-invalid"))?;
                let mut scopes = existing
                    .as_ref()
                    .map_or_else(Vec::new, |r| r.scopes.clone());
                scopes.retain(|s| *s != Scope::LyricsCalibration);
                let key = if enabled {
                    scopes.push(Scope::LyricsCalibration);
                    Some(
                        create_key(&state.data_dir, Scope::LyricsCalibration)
                            .map_err(|_| error("authorization-write-failed"))?,
                    )
                } else {
                    None
                };
                let record = Authorization {
                    schema_version: 2,
                    revision: Authorization::next_revision(existing.as_ref())
                        .map_err(|_| error("authorization-invalid"))?,
                    scopes,
                };
                record
                    .write_checked(&state.data_dir, || Ok(()))
                    .map_err(|_| {
                        error(if enabled {
                            "authorization-write-failed"
                        } else {
                            "revocation-incomplete"
                        })
                    })?;
                if !enabled {
                    let path = state.data_dir.join(key_file(Scope::LyricsCalibration));
                    match windows::read_private_bounded(&path, 128) {
                        Ok(_) => std::fs::remove_file(path)
                            .map_err(|_| error("revocation-cleanup-incomplete"))?,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(_) => return Err(error("revocation-cleanup-incomplete")),
                    }
                }
                let mut o = lock(&self.owner);
                o.authorized = enabled;
                o.key = key;
            }
            #[cfg(not(all(windows, target_arch = "x86_64")))]
            return Err(error("permission-required"));
        }
        let authorized = {
            let mut o = lock(&self.owner);
            o.sweep(state);
            o.authorized
        };
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            use crate::desktop_bridge::authorization::{key_file, Authorization};
            use hertz_desktop_ipc::Scope;
            let persistent = Authorization::read(&state.data_dir)
                .map_err(|_| error("authorization-invalid"))?
                .is_some_and(|r| r.scopes.contains(&Scope::LyricsCalibration));
            let cleanup = !persistent
                && state
                    .data_dir
                    .join(key_file(Scope::LyricsCalibration))
                    .try_exists()
                    .unwrap_or(true);
            return Ok(
                json!({"authorized":authorized,"persistentAuthorized":persistent,"cleanupIncomplete":cleanup}),
            );
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        Ok(json!({"authorized":authorized}))
    }
    pub(crate) fn authenticate(&self, state: &AppState, key: &str) -> bool {
        self.load_standalone(state);
        let mut o = lock(&self.owner);
        o.sweep(state);
        o.authorized
            && !o.dbx
            && o.key.as_ref().is_some_and(|k| {
                k.len() == key.len()
                    && k.bytes().zip(key.bytes()).fold(0, |d, (a, b)| d | (a ^ b)) == 0
            })
    }
    pub(crate) async fn receive(
        &self,
        state: &std::sync::Arc<AppState>,
        op: &str,
        body: Value,
    ) -> Result<Value, ApiError> {
        if op != "request" {
            return self.narrow(state, op, body);
        }
        // Reserve the single request and its watermark before any await. A
        // cancellation can now retire it while the lyrics owner is loading.
        let (reply, started) = self.admit_request(state, body, false)?;
        let Some(Loading {
            intent,
            deadline,
            mut cancelled,
        }) = started
        else {
            return Ok(reply);
        };
        let snapshot = tokio::select! {
            biased;
            _ = cancelled.changed() => None,
            snapshot = tokio::time::timeout_at(deadline.into(), crate::desktop_lyrics::snapshot(state)) => Some(snapshot),
        };
        let mut o = lock(&self.owner);
        o.sweep(state);
        if o.pending
            .as_ref()
            .is_some_and(|p| p.intent == intent && p.loading)
        {
            match snapshot {
                Some(Ok(snapshot)) if snapshot["lyrics"]["status"] == "ready" => {
                    o.pending.as_mut().unwrap().loading = false;
                    Self::focus_receiver(state, &mut o);
                }
                Some(Ok(_)) => o.finish("lyrics-unavailable"),
                Some(Err(_)) => o.finish("timeout"),
                None => o.finish("cancelled"),
            }
        }
        Ok(o.result(&intent.request_id))
    }
    fn focus_receiver(state: &AppState, o: &mut Owner) {
        o.sweep(state);
        let Some(p) = o.pending.as_ref().filter(|p| !p.loading) else {
            return;
        };
        if !o
            .receivers
            .iter()
            .any(|r| r.id == p.receiver && r.kind == "native")
        {
            return;
        }
        if state
            .native_window
            .get()
            .is_none_or(|window| window.request_focus(&p.intent.session).is_err())
        {
            o.finish("receiver-unavailable");
        }
    }
    fn admit_request(
        &self,
        state: &AppState,
        body: Value,
        ready: bool,
    ) -> Result<(Value, Option<Loading>), ApiError> {
        if serde_json::to_vec(&body).map_or(true, |b| b.len() > LIMIT) {
            return Err(error("invalid-request"));
        }
        let i: Intent = serde_json::from_value(body).map_err(|_| error("invalid-request"))?;
        let mut o = lock(&self.owner);
        o.sweep(state);
        if !o.authorized {
            return Err(error("permission-required"));
        }
        if i.version != 1
            || i.request_id.is_empty()
            || i.request_id.len() > 128
            || i.binding_id != o.binding
            || o.binding.is_empty()
            || i.remaining_ms == 0
            || i.remaining_ms > 5000
            || i.track_id.len() > 512
        {
            return Err(error("invalid-request"));
        }
        if let Some(t) = o
            .terminals
            .iter()
            .find(|t| t.request_id == i.request_id && t.intent.is_none())
        {
            let reply = json!({"requestId":i.request_id,"state":t.result});
            o.high_water = o.high_water.max(i.request_sequence);
            return Ok((reply, None));
        }
        if let Some(old) = o
            .pending
            .as_ref()
            .filter(|p| p.intent.request_id == i.request_id)
            .map(|p| &p.intent)
            .or_else(|| {
                o.terminals
                    .iter()
                    .find(|t| t.request_id == i.request_id)
                    .and_then(|t| t.intent.as_ref())
            })
        {
            let mut comparable = i.clone();
            comparable.remaining_ms = old.remaining_ms;
            return if *old == comparable {
                Ok((o.result(&i.request_id), None))
            } else {
                Err(error("request-conflict"))
            };
        }
        if i.request_sequence <= o.high_water {
            return Ok((
                json!({"requestId":i.request_id,"state":"expired/unknown"}),
                None,
            ));
        }
        let wire_left =
            hertz_desktop_ipc::monotonic::remaining(&i.deadline_clock, i.deadline_monotonic_ms)
                .ok_or_else(|| error("timeout"))?;
        if !matches_truth(state, &i) {
            return Err(error("track-changed"));
        }
        if state.room.is_active() {
            return Err(error("room-active"));
        }
        let receiver = o
            .receivers
            .iter()
            .filter(|r| !o.dbx || r.workbench)
            .min_by_key(|r| match r.kind.as_str() {
                "native" => 0,
                "full" if r.visible => 1,
                "full" => 2,
                _ => 3,
            })
            .ok_or_else(|| error("receiver-unavailable"))?;
        let receiver_id = receiver.id.clone();
        o.finish("cancelled");
        o.high_water = i.request_sequence;
        let deadline =
            Instant::now() + TOTAL.min(Duration::from_millis(i.remaining_ms.min(wire_left)));
        let (cancel_loading, cancelled) = tokio::sync::watch::channel(false);
        o.pending = Some(Pending {
            intent: i.clone(),
            deadline,
            receiver: receiver_id,
            handoff: None,
            target: None,
            claimed: false,
            loading: !ready,
            cancel_loading,
        });
        if ready {
            Self::focus_receiver(state, &mut o);
        }
        Ok((
            o.result(&i.request_id),
            (!ready).then_some(Loading {
                intent: i,
                deadline,
                cancelled,
            }),
        ))
    }
    pub(crate) fn narrow(
        &self,
        state: &AppState,
        op: &str,
        body: Value,
    ) -> Result<Value, ApiError> {
        if op == "request" {
            return self
                .admit_request(state, body, true)
                .map(|(reply, _)| reply);
        }
        if serde_json::to_vec(&body).map_or(true, |b| b.len() > LIMIT) {
            return Err(error("invalid-request"));
        }
        let mut o = lock(&self.owner);
        o.sweep(state);
        if !o.authorized {
            return Err(error("permission-required"));
        }
        if op == "bind" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct BindDeadline {
                deadline_clock: String,
                deadline_monotonic_ms: u64,
                native_session: String,
                request_sequence: u64,
                session: String,
            }
            let deadline: BindDeadline =
                serde_json::from_value(body).map_err(|_| error("invalid-request"))?;
            hertz_desktop_ipc::monotonic::remaining(
                &deadline.deadline_clock,
                deadline.deadline_monotonic_ms,
            )
            .ok_or_else(|| error("timeout"))?;
            if deadline.session != state.server_instance_id()
                || deadline.request_sequence == 0
                || deadline.native_session.len() != 36
                || uuid::Uuid::parse_str(&deadline.native_session).is_err()
            {
                return Err(error("invalid-request"));
            }
            let order = BindingOrder {
                deadline_monotonic_ms: deadline.deadline_monotonic_ms,
                native_session: deadline.native_session,
                request_sequence: deadline.request_sequence,
            };
            if order.deadline_monotonic_ms <= o.binding_floor_deadline {
                return Err(error("request-conflict"));
            }
            if let Some(previous) = &o.binding_order {
                if *previous == order && !o.binding.is_empty() {
                    return Ok(json!({"bindingId":o.binding}));
                }
                // Within one real native lifetime, ties use acceptance sequence.
                // Across restarts equal ticks have no trustworthy strict order.
                let newer = order.deadline_monotonic_ms >= previous.deadline_monotonic_ms
                    && if order.native_session == previous.native_session {
                        order.request_sequence > previous.request_sequence.max(o.high_water)
                    } else {
                        order.deadline_monotonic_ms > previous.deadline_monotonic_ms
                    };
                if !newer {
                    return Err(error("request-conflict"));
                }
            }
            o.finish("cancelled");
            o.binding = uuid::Uuid::new_v4().to_string();
            o.binding_order = Some(order);
            o.high_water = 0;
            o.terminals.clear();
            return Ok(json!({"bindingId":o.binding}));
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Query {
            binding_id: String,
            request_id: String,
        }
        let q: Query = serde_json::from_value(body).map_err(|_| error("invalid-request"))?;
        if q.binding_id != o.binding || o.binding.is_empty() {
            return Err(error("invalid-request"));
        }
        if op == "cancel"
            && o.pending
                .as_ref()
                .is_some_and(|p| p.intent.request_id == q.request_id)
        {
            o.finish("cancelled");
        } else if op == "cancel" && !o.terminals.iter().any(|t| t.request_id == q.request_id) {
            if q.request_id.is_empty() || q.request_id.len() > 128 {
                return Err(error("invalid-request"));
            }
            o.terminals.push_back(Terminal {
                request_id: q.request_id.clone(),
                intent: None,
                result: "cancelled",
                at: Instant::now(),
            });
            while o.terminals.len() > 64 {
                o.terminals.pop_front();
            }
        }
        if !matches!(op, "cancel" | "result") {
            return Err(error("invalid-request"));
        }
        Ok(o.result(&q.request_id))
    }
    pub(crate) fn ui(&self, state: &AppState, body: Value) -> Result<Value, ApiError> {
        if serde_json::to_vec(&body).map_or(true, |b| b.len() > LIMIT) {
            return Err(error("invalid-request"));
        }
        let c: UiCall = serde_json::from_value(body).map_err(|_| error("invalid-request"))?;
        let mut o = lock(&self.owner);
        o.sweep(state);
        if *state.exiting.borrow() {
            return Err(error("cancelled"));
        }
        if c.op == "register" {
            if o.receivers.len() >= 8
                || !matches!(c.kind.as_str(), "native" | "full" | "floating")
                || c.kind == "native" && state.native_window.get().is_none()
            {
                return Err(error("receiver-unavailable"));
            }
            if !c.handoff.is_empty()
                && !(o.dbx
                    && c.kind == "full"
                    && c.workbench
                    && o.pending.as_ref().is_some_and(|p| {
                        !p.loading
                            && p.handoff.as_deref() == Some(c.handoff.as_str())
                            && p.target.is_none()
                    }))
            {
                return Err(error("receiver-unavailable"));
            }
            let id = uuid::Uuid::new_v4().to_string();
            o.receivers.push(Receiver {
                id: id.clone(),
                kind: c.kind.clone(),
                visible: c.visible,
                workbench: c.workbench,
                expires: Instant::now() + LEASE,
            });
            if !c.handoff.is_empty() {
                if let Some(p) = o.pending.as_mut().filter(|p| {
                    p.handoff.as_deref() == Some(c.handoff.as_str()) && p.target.is_none()
                }) {
                    p.target = Some(id.clone());
                    p.claimed = false;
                }
            }
            return Ok(json!({"receiverId":id,"session":state.server_instance_id()}));
        }
        let r = o
            .receivers
            .iter_mut()
            .find(|r| r.id == c.receiver_id)
            .ok_or_else(|| error("receiver-unavailable"))?;
        r.expires = Instant::now() + LEASE;
        r.visible = c.visible;
        if c.op == "unregister" {
            o.receivers.retain(|r| r.id != c.receiver_id);
            o.sweep(state);
            return Ok(json!({"released":true}));
        }
        if c.op == "renew" {
            return Ok(json!({"renewed":true}));
        }
        if c.op == "claim" {
            let Some(p) = o.pending.as_mut().filter(|p| {
                !p.loading
                    && p.target.as_deref().unwrap_or(&p.receiver) == c.receiver_id
                    && !p.claimed
                    && (p.target.is_none() || p.handoff.as_deref() == Some(c.handoff.as_str()))
            }) else {
                return Ok(json!({"intent":null}));
            };
            p.claimed = true;
            return Ok(
                json!({"intent":p.intent,"remainingMs":p.deadline.saturating_duration_since(Instant::now()).as_millis(),"handoff":p.handoff}),
            );
        }
        let p = o
            .pending
            .as_ref()
            .filter(|p| {
                p.intent.request_id == c.request_id
                    && !p.loading
                    && p.target.as_deref().unwrap_or(&p.receiver) == c.receiver_id
            })
            .ok_or_else(|| error("expired/unknown"))?;
        if c.op == "validate" {
            return Ok(
                json!({"valid":true,"remainingMs":p.deadline.saturating_duration_since(Instant::now()).as_millis()}),
            );
        }
        if c.op == "handoff" {
            if !o.dbx {
                return Err(error("invalid-request"));
            }
            let r = o.receivers.iter().find(|r| r.id == c.receiver_id).unwrap();
            if r.kind != "floating" || !r.workbench {
                return Err(error("receiver-unavailable"));
            }
            let p = o.pending.as_mut().unwrap();
            if p.handoff.is_some() {
                return Err(error("request-conflict"));
            }
            let marker = uuid::Uuid::new_v4().to_string();
            p.handoff = Some(marker.clone());
            return Ok(json!({"handoff":marker}));
        }
        if c.op == "complete" {
            let full = o
                .receivers
                .iter()
                .any(|r| r.id == c.receiver_id && r.kind != "floating");
            let result = if c.result == "shown"
                && full
                && c.detail_visible
                && c.document_visible
                && c.document_focused
                && c.offset_focused
            {
                "shown"
            } else if c.result == "focus-unavailable" && full && c.detail_visible {
                "focus-unavailable"
            } else if c.result == "lyrics-unavailable" {
                "lyrics-unavailable"
            } else if c.result == "cancelled" {
                "cancelled"
            } else if c.result == "receiver-unavailable" {
                "receiver-unavailable"
            } else {
                return Err(error("invalid-completion"));
            };
            o.finish(result);
            return Ok(o.result(&c.request_id));
        }
        Err(error("invalid-request"))
    }
}
