// SPDX-License-Identifier: MIT
//! Disposable real authenticated-pipe fixture; never starts a production sidecar/player.
use hertz_desktop_ipc::{
    windows::{self, Cancellation},
    Discovery, Pipes, Profile, Response, Scope,
};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let directory = PathBuf::from(&args[1]);
    let session = args[3].clone();
    let profile = Profile::Dbx {
        edition: "standard".into(),
        data_dir: directory.to_string_lossy().into(),
        plugin_id: hertz_desktop_ipc::profile::STANDARD_PLUGIN_ID.into(),
    }
    .normalized()?;
    let discovery = Discovery {
        discovery_protocol: 1,
        source: profile.clone(),
        server_instance_id: session.clone(),
        pid: std::process::id(),
        windows_session_id: windows::Identity::current()?.windows_session_id,
        build_id: "management-native-fixture".into(),
        desktop_build_id: args[2].clone(),
        bridge_protocol: 1,
        desktop_lyrics_protocol: 1,
        wallpaper_protocol: 1,
        pipes: Pipes {
            lyrics: Some(windows::pipe_name(&profile, &session, Scope::Lyrics)?),
            wallpaper: Some(windows::pipe_name(&profile, &session, Scope::Wallpaper)?),
        },
    };
    for key in ["desktop-lyrics-key", "wallpaper-key"] {
        windows::write_private_atomic(&directory.join(key), "a".repeat(64).as_bytes(), 128)?;
    }
    let sequence = Arc::new(AtomicU64::new(0));
    let mut tasks = tokio::task::JoinSet::new();
    for (scope, name) in [
        (Scope::Lyrics, discovery.pipes.lyrics.clone().unwrap()),
        (Scope::Wallpaper, discovery.pipes.wallpaper.clone().unwrap()),
    ] {
        let mut server = windows::create_server(&name, true)?;
        let directory = directory.clone();
        let session = session.clone();
        let sequence = sequence.clone();
        tasks.spawn(async move {
            let cancel = Cancellation::new();
            loop {
                let connection = windows::accept(server, &cancel).await?;
                server = windows::create_server(&name, false)?;
                let directory = directory.clone(); let session = session.clone(); let sequence = sequence.clone(); let cancel = cancel.clone();
                tokio::spawn(async move {
                    let _ = connection.serve(&cancel, |_, request| async move {
                        request.validate(scope, &session)?;
                        let valid = request.key == "a".repeat(64);
                        let mode = std::fs::read_to_string(directory.join("mode.txt")).unwrap_or_default();
                        if mode.trim() == "stall" { tokio::time::sleep(Duration::from_secs(10)).await; }
                        let status = if !valid || mode.trim() == "denied" { 403 } else { 200 };
                        let seq = sequence.fetch_add(1, Ordering::Relaxed);
                        let body = if scope == Scope::Lyrics {
                            // Empty music is authenticated data, and must still count as connected.
                            json!({"protocol":1,"seq":seq,"server":{"session":session,"edition":"standard","version":"fixture"},"generation":"1","positionMs":0,"durationMs":null,"playing":false,"buffering":false,"track":null,"lyrics":{"status":"empty","documentKey":null},"timing":"presentation_applied"})
                        } else {
                            json!({"protocol":1,"seq":seq,"server":{"session":session,"edition":"standard","version":"fixture"},"valid":true,"playing":false,"positionMs":0,"durationMs":null,"generation":"1","spectrum":{"bands":vec![0.0;64],"energy":0.0,"ageMs":0},"timing":"presentation_applied"})
                        };
                        Ok(Response { bridge_protocol:1, request_id:request.request_id, server_instance_id:session, status, body })
                    }).await;
                });
            }
            #[allow(unreachable_code)] Ok::<(), std::io::Error>(())
        });
    }
    windows::write_private_atomic(
        &directory.join("desktop-source.json"),
        &serde_json::to_vec(&discovery)?,
        hertz_desktop_ipc::DISCOVERY_LIMIT,
    )?;
    println!("ready");
    while let Some(result) = tasks.join_next().await {
        result??;
    }
    Ok(())
}
