// SPDX-License-Identifier: MIT
use hertz_desktop_ipc::{frame, Profile, Request, Response, Scope};
use serde_json::json;

#[test]
fn profile_kind_and_plugin_id_are_explicit() {
    let standalone: Profile = serde_json::from_value(
        json!({"kind":"standalone","edition":"custom","dataDir":std::env::temp_dir()}),
    )
    .unwrap();
    standalone.validate().unwrap();
    assert!(
        serde_json::from_value::<Profile>(json!({"edition":"standard","dataDir":"unused"}))
            .is_err()
    );
    assert!(serde_json::from_value::<Profile>(
        json!({"kind":"standalone","edition":"standard","dataDir":"unused","pluginId":"wrong"})
    )
    .is_err());
    let mismatch: Profile = serde_json::from_value(json!({"kind":"dbx","edition":"full","dataDir":"unused","pluginId":"io.github.oncemisery.hertz-studio"})).unwrap();
    assert!(mismatch.validate().is_err());
}

#[test]
fn strict_read_only_envelope_and_response_identity() {
    let mut request = Request {
        bridge_protocol: 1,
        request_id: "1".into(),
        server_instance_id: "session".into(),
        scope: Scope::Lyrics,
        key: "test".into(),
        op: "snapshot".into(),
        params: json!({}),
    };
    request.validate(Scope::Lyrics, "session").unwrap();
    request.op = "play".into();
    assert!(request.validate(Scope::Lyrics, "session").is_err());
    request.op = "document".into();
    request.params = json!({"key":"document", "other":1});
    assert!(request.validate(Scope::Lyrics, "session").is_err());
    request.params = json!({"key":"document"});
    request.validate(Scope::Lyrics, "session").unwrap();
    assert!(request.validate(Scope::Wallpaper, "session").is_err());
    let response = Response {
        bridge_protocol: 1,
        request_id: "1".into(),
        server_instance_id: "stale".into(),
        status: 200,
        body: json!({}),
    };
    assert!(response.validate(&request).is_err());
    let mut value = serde_json::to_value(request).unwrap();
    value["unknown"] = json!(true);
    assert!(serde_json::from_value::<Request>(value).is_err());
}

#[test]
fn serialization_stops_at_budget() {
    let large = "a".repeat(32_768);
    assert!(frame::serialize_bounded(&large, 8192).is_err());
    assert_eq!(
        frame::serialize_bounded(&json!({"ok":true}), 11).unwrap(),
        br#"{"ok":true}"#
    );
}

#[tokio::test]
async fn length_is_rejected_before_body_and_json_must_be_complete_utf8() {
    for bytes in [
        vec![255, 255, 255, 255],
        vec![0, 0, 0, 0],
        vec![2, 0, 0, 0, b'{'],
        vec![1, 0, 0, 0, 255],
        vec![3, 0, 0, 0, b'{', b'}', b'x'],
    ] {
        let mut source = bytes.as_slice();
        assert!(frame::read_frame::<_, serde_json::Value>(&mut source, 8192)
            .await
            .is_err());
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use hertz_desktop_ipc::windows::{accept, create_server, request, Cancellation, Identity};
    use std::{
        io,
        os::windows::{io::AsRawHandle, process::CommandExt},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };
    use tokio::{io::AsyncWriteExt, net::windows::named_pipe::ClientOptions};

    fn name() -> String {
        format!(r"\\.\pipe\hertz-desktop-test-{}", uuid::Uuid::new_v4())
    }
    fn req() -> Request {
        Request {
            bridge_protocol: 1,
            request_id: "1".into(),
            server_instance_id: "session".into(),
            scope: Scope::Lyrics,
            key: "test".into(),
            op: "snapshot".into(),
            params: json!({}),
        }
    }
    fn response(request: Request) -> Response {
        Response {
            bridge_protocol: 1,
            request_id: request.request_id,
            server_instance_id: request.server_instance_id,
            status: 200,
            body: json!({"ok":true}),
        }
    }

    #[tokio::test]
    async fn real_pipe_identity_delivery_and_reclamation() {
        let pipe = name();
        let server = create_server(&pipe, true).unwrap();
        let cancel = Cancellation::new();
        let server_cancel = cancel.clone();
        let expected = Identity::current().unwrap();
        let task = tokio::spawn(async move {
            accept(server, &server_cancel)
                .await
                .unwrap()
                .serve(&server_cancel, |peer, request: Request| async move {
                    assert_eq!(peer.pid, std::process::id());
                    assert_eq!(peer.identity, expected);
                    Ok(response(request))
                })
                .await
                .unwrap()
        });
        let result = request(&pipe, std::process::id(), &req(), &cancel)
            .await
            .unwrap();
        assert_eq!(result.body, json!({"ok":true}));
        assert_eq!(task.await.unwrap().pid, std::process::id());
        drop(create_server(&pipe, true).unwrap());
    }

    #[tokio::test]
    async fn mismatched_actual_server_pid_is_rejected_before_request_write() {
        let pipe = name();
        let server = create_server(&pipe, true).unwrap();
        let task = tokio::spawn(async move {
            let cancel = Cancellation::new();
            let connection = accept(server, &cancel).await.unwrap();
            connection
                .serve(&cancel, |_, request: Request| async move {
                    Ok(response(request))
                })
                .await
        });
        let error = request(&pipe, std::process::id() + 1, &req(), &Cancellation::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(task.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn absent_listener_has_one_second_connect_deadline() {
        let started = Instant::now();
        let error = request(&name(), std::process::id(), &req(), &Cancellation::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(900));
        assert!(started.elapsed() < Duration::from_millis(1800));
    }

    #[tokio::test]
    async fn cancellation_reclaims_listener_and_pending_read() {
        for connected in [false, true] {
            let pipe = name();
            let server = create_server(&pipe, true).unwrap();
            let cancel = Cancellation::new();
            let signal = cancel.clone();
            let task = tokio::spawn(async move {
                let connection = accept(server, &signal).await?;
                connection
                    .serve(&signal, |_, request: Request| async move {
                        Ok(response(request))
                    })
                    .await
            });
            let client = connected.then(|| ClientOptions::new().open(&pipe).unwrap());
            tokio::time::sleep(Duration::from_millis(20)).await;
            let started = Instant::now();
            cancel.cancel();
            assert_eq!(
                task.await.unwrap().unwrap_err().kind(),
                io::ErrorKind::Interrupted
            );
            assert!(started.elapsed() < Duration::from_millis(300));
            drop(client);
            drop(create_server(&pipe, true).unwrap());
        }
    }

    #[tokio::test]
    async fn slow_reader_and_business_share_one_total_deadline() {
        let pipe = name();
        let server = create_server(&pipe, true).unwrap();
        let task = tokio::spawn(async move {
            let cancel = Cancellation::new();
            accept(server, &cancel)
                .await
                .unwrap()
                .serve(&cancel, |_, request: Request| async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    let mut response = response(request);
                    response.body = json!({"data":"a".repeat(3_900_000)});
                    Ok(response)
                })
                .await
        });
        let mut client = ClientOptions::new().open(&pipe).unwrap();
        let started = Instant::now();
        let bytes = frame::serialize_bounded(&req(), 8192).unwrap();
        frame::write_frame(&mut client, &bytes, 8192).await.unwrap();
        // Deliberately never read the multi-megabyte response.
        assert_eq!(
            task.await.unwrap().unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert!(started.elapsed() >= Duration::from_millis(1800));
        assert!(started.elapsed() < Duration::from_millis(2700));
        // The non-reading client stays OPEN: cleanup must come from cancellation,
        // rather than relying on that uncooperative peer eventually disconnecting.
        tokio::time::timeout(Duration::from_millis(500), async {
            loop {
                if let Ok(reclaimed) = create_server(&pipe, true) {
                    drop(reclaimed);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        drop(client);
    }

    #[tokio::test]
    async fn oversized_response_uses_complete_error_and_admission_can_revoke_send() {
        let pipe = name();
        let server = create_server(&pipe, true).unwrap();
        let task = tokio::spawn(async move {
            let cancel = Cancellation::new();
            accept(server, &cancel)
                .await
                .unwrap()
                .serve_with_admission(
                    &cancel,
                    |_, request| async move {
                        let mut result = response(request);
                        result.body = json!({"data":"a".repeat(4_194_304)});
                        Ok(result)
                    },
                    |result| {
                        assert_eq!(result.status, 500);
                        Ok(())
                    },
                )
                .await
                .unwrap()
        });
        let result = request(&pipe, std::process::id(), &req(), &Cancellation::new())
            .await
            .unwrap();
        assert_eq!(result.status, 500);
        assert_eq!(result.body["error"]["code"], "desktop_response_too_large");
        task.await.unwrap();

        let pipe = name();
        let server = create_server(&pipe, true).unwrap();
        let task = tokio::spawn(async move {
            let cancel = Cancellation::new();
            accept(server, &cancel)
                .await
                .unwrap()
                .serve_with_admission(
                    &cancel,
                    |_, request| async move { Ok(response(request)) },
                    |_| -> io::Result<()> {
                        Err(io::Error::new(io::ErrorKind::PermissionDenied, "revoked"))
                    },
                )
                .await
        });
        assert!(
            request(&pipe, std::process::id(), &req(), &Cancellation::new())
                .await
                .is_err()
        );
        assert_eq!(
            task.await.unwrap().unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[tokio::test]
    async fn send_registration_outlives_disconnect_on_timeout_and_task_abort() {
        struct Guard {
            client: usize,
            observed: Arc<AtomicBool>,
        }
        impl Drop for Guard {
            fn drop(&mut self) {
                // Observe the ACTUAL other endpoint while releasing the registration.
                // The client is deliberately still open; server teardown must disconnect it first.
                let result = unsafe {
                    windows_sys::Win32::System::Pipes::PeekNamedPipe(
                        self.client as _,
                        std::ptr::null_mut(),
                        0,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                self.observed.store(result == 0, Ordering::SeqCst);
            }
        }
        for abort in [false, true] {
            let pipe = name();
            let server = create_server(&pipe, true).unwrap();
            let mut client = ClientOptions::new().open(&pipe).unwrap();
            let client_handle = client.as_raw_handle() as usize;
            let observed = Arc::new(AtomicBool::new(false));
            let guard_observed = observed.clone();
            let task = tokio::spawn(async move {
                let cancel = Cancellation::new();
                accept(server, &cancel)
                    .await
                    .unwrap()
                    .serve_with_admission(
                        &cancel,
                        |_, request| async move { Ok(response(request)) },
                        move |_| {
                            Ok(Guard {
                                client: client_handle,
                                observed: guard_observed,
                            })
                        },
                    )
                    .await
            });
            let bytes = frame::serialize_bounded(&req(), 8192).unwrap();
            frame::write_frame(&mut client, &bytes, 8192).await.unwrap();
            let _: Response = frame::read_frame(&mut client, 4_194_304).await.unwrap();
            if abort {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            } else {
                assert_eq!(
                    task.await.unwrap().unwrap_err().kind(),
                    io::ErrorKind::TimedOut
                );
            }
            assert!(
                observed.load(Ordering::SeqCst),
                "send registration released before pipe disconnected; abort={abort}"
            );
            drop(client);
        }
    }

    #[tokio::test]
    async fn malformed_truncated_oversized_and_multiple_requests_never_enter_handler() {
        let valid = frame::serialize_bounded(&req(), 8192).unwrap();
        let mut framed = (valid.len() as u32).to_le_bytes().to_vec();
        framed.extend_from_slice(&valid);
        let mut multiple = framed.clone();
        multiple.extend_from_slice(&framed);
        for bytes in [
            vec![255, 255, 255, 255],
            vec![2, 0, 0, 0, b'{'],
            vec![1, 0, 0, 0, 255],
            multiple,
        ] {
            let pipe = name();
            let server = create_server(&pipe, true).unwrap();
            let entered = Arc::new(AtomicBool::new(false));
            let observed = entered.clone();
            let task = tokio::spawn(async move {
                let cancel = Cancellation::new();
                accept(server, &cancel)
                    .await
                    .unwrap()
                    .serve(&cancel, |_, request: Request| async move {
                        observed.store(true, Ordering::SeqCst);
                        Ok(response(request))
                    })
                    .await
            });
            let mut client = ClientOptions::new().open(&pipe).unwrap();
            client.write_all(&bytes).await.unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
            drop(client);
            assert!(task.await.unwrap().is_err());
            assert!(!entered.load(Ordering::SeqCst));
            drop(create_server(&pipe, true).unwrap());
        }
    }

    #[tokio::test]
    async fn client_rejects_oversized_truncated_and_multiple_responses() {
        let valid = frame::serialize_bounded(&response(req()), 8192).unwrap();
        let mut frame = (valid.len() as u32).to_le_bytes().to_vec();
        frame.extend_from_slice(&valid);
        let mut multiple = frame.clone();
        multiple.extend_from_slice(&frame);
        let mut large = response(req());
        large.body = json!({"data":""});
        let overhead = frame::serialize_bounded(&large, 4_194_304).unwrap().len() + 4;
        large.body = json!({"data":"a".repeat(8192-overhead)});
        let json = frame::serialize_bounded(&large, 4_194_304).unwrap();
        let mut large_multiple = (json.len() as u32).to_le_bytes().to_vec();
        large_multiple.extend_from_slice(&json);
        assert_eq!(large_multiple.len(), 8192);
        large_multiple.extend_from_slice(&frame);
        for bytes in [
            vec![1, 0, 64, 0],
            vec![5, 0, 0, 0, b'{', b'}'],
            multiple,
            large_multiple,
        ] {
            let pipe = name();
            let mut server = create_server(&pipe, true).unwrap();
            let task = tokio::spawn(async move {
                server.connect().await.unwrap();
                let _: Request = frame::read_frame(&mut server, 8192).await.unwrap();
                server.write_all(&bytes).await.unwrap();
                tokio::time::sleep(Duration::from_millis(60)).await;
            });
            assert!(
                request(&pipe, std::process::id(), &req(), &Cancellation::new())
                    .await
                    .is_err()
            );
            task.await.unwrap();
        }
    }

    #[test]
    fn private_files_are_atomic_bounded_and_reject_inherited_acl() {
        let root = std::env::temp_dir().join(format!("hertz-desktop-ipc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let file = root.join("private.json");
        hertz_desktop_ipc::windows::write_private_atomic(&file, b"one", 8192).unwrap();
        assert_eq!(
            hertz_desktop_ipc::windows::read_private_bounded(&file, 8192).unwrap(),
            b"one"
        );
        hertz_desktop_ipc::windows::write_private_atomic(&file, b"two", 8192).unwrap();
        assert_eq!(
            hertz_desktop_ipc::windows::read_private_bounded(&file, 8192).unwrap(),
            b"two"
        );
        assert!(hertz_desktop_ipc::windows::write_private_atomic(&file, b"oversize", 2).is_err());
        assert_eq!(
            hertz_desktop_ipc::windows::read_private_bounded(&file, 8192).unwrap(),
            b"two"
        );
        assert!(hertz_desktop_ipc::windows::read_private_bounded(&file, 2).is_err());
        let inherited = root.join("inherited.json");
        std::fs::write(&inherited, b"data").unwrap();
        assert!(hertz_desktop_ipc::windows::read_private_bounded(&inherited, 8192).is_err());
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_identity_matches_junction_case_and_extended_prefix() {
        let root = std::env::temp_dir().join(format!("hertz-desktop-ipc-{}", uuid::Uuid::new_v4()));
        let real = root.join("MixedCase");
        let alias = root.join("Junction");
        std::fs::create_dir_all(&real).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&alias)
            .arg(&real)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        let normalized = hertz_desktop_ipc::profile::normalize_directory(&real).unwrap();
        assert_eq!(
            normalized,
            hertz_desktop_ipc::profile::normalize_directory(&alias).unwrap()
        );
        assert_eq!(
            normalized,
            hertz_desktop_ipc::profile::normalize_directory(&std::path::PathBuf::from(
                real.to_string_lossy().to_uppercase()
            ))
            .unwrap()
        );
        let extended = std::path::PathBuf::from(format!(r"\\?\{}", real.display()));
        assert_eq!(
            normalized,
            hertz_desktop_ipc::profile::normalize_directory(&extended).unwrap()
        );
        std::fs::remove_dir(alias).unwrap();
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn pipe_dacl_contains_only_current_user_sid_and_is_protected() {
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{
                    ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo,
                    SDDL_REVISION_1, SE_FILE_OBJECT,
                },
                DACL_SECURITY_INFORMATION,
            },
        };
        let pipe = create_server(&name(), true).unwrap();
        let mut descriptor = std::ptr::null_mut();
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    pipe.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        let mut text = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let mut size = 0;
        while unsafe { *text.add(size) } != 0 {
            size += 1;
        }
        let sddl = String::from_utf16(unsafe { std::slice::from_raw_parts(text, size) }).unwrap();
        unsafe {
            LocalFree(text.cast());
            LocalFree(descriptor);
        }
        // Windows expands generic-all (GA) to the file object's full-access mask (FA).
        assert_eq!(
            sddl,
            format!("D:P(A;;FA;;;{})", Identity::current().unwrap().user_sid)
        );
    }
}
