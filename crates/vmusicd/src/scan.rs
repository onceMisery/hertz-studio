// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! Background library scan.
//!
//! Metadata parsing is CPU-bound and synchronous, so it runs on the blocking
//! pool; the scan itself is a normal async task that publishes progress on the
//! event bus. Only one scan runs at a time — a second request while one is in
//! flight is rejected rather than queued, because two concurrent scans would
//! both try to prune "stale" rows and could delete each other's work.

use std::path::PathBuf;
use std::sync::Arc;

use crate::state::{AppState, WsEvent};

pub async fn run_scan(state: Arc<AppState>, root: PathBuf) {
    {
        let mut scan = state.scan.lock().await;
        if scan.running {
            return;
        }
        *scan = Default::default();
        scan.running = true;
    }

    let result = do_scan(state.clone(), root).await;

    let mut scan = state.scan.lock().await;
    scan.running = false;
    match result {
        Ok((added, failed)) => {
            scan.added = added;
            scan.failed = failed;
        }
        Err(e) => {
            scan.last_error = Some(e.to_string());
            tracing::warn!("scan failed: {e:#}");
        }
    }
    drop(scan);
    state.publish(WsEvent::LibraryChanged);
}

async fn do_scan(state: Arc<AppState>, root: PathBuf) -> anyhow::Result<(usize, usize)> {
    if !root.is_dir() {
        anyhow::bail!("{} is not a directory", root.display());
    }

    let files = vmusic_library::collect_audio_files(&root);
    let total = files.len();
    tracing::info!("scanning {} files under {}", total, root.display());

    {
        let mut scan = state.scan.lock().await;
        scan.total = total;
        scan.done = 0;
        scan.added = 0;
        scan.failed = 0;
        scan.last_error = None;
    }

    let cache_dir = state.data_dir.join("cache");
    let mut added = 0usize;
    let mut failed = 0usize;
    let mut seen: Vec<String> = Vec::with_capacity(total);

    for (index, path) in files.iter().enumerate() {
        let path_for_task = path.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            match vmusic_library::read_metadata(&path_for_task) {
                Ok(meta) => Ok((path_for_task, meta)),
                Err(e) => Err((path_for_task, e)),
            }
        })
        .await;

        match outcome {
            Ok(Ok((path, mut meta))) => {
                let cover = meta.cover.take();
                let mut track = vmusic_library::build_track(&path, meta);
                // 身份跟路径走，不跟本次新铸的 UUID 走：复用既有行 id，
                // 封面才能按 DB 中的 id 落盘，歌单引用也不会在重扫后断链。
                if let Ok(Some(existing_id)) =
                    vmusic_store::get_track_id_by_path(&state.db, &track.path).await
                {
                    track.id = existing_id;
                }
                if let Some((data, media_type)) = cover {
                    if vmusic_library::save_cover(&cache_dir, &track.id, &data, &media_type)
                        .is_some()
                    {
                        track.has_cover = true;
                    }
                }
                seen.push(track.path.clone());
                if vmusic_store::upsert_track(&state.db, &track).await.is_ok() {
                    added += 1;
                } else {
                    failed += 1;
                }
            }
            Ok(Err((path, e))) => {
                failed += 1;
                tracing::debug!("metadata failed for {}: {e}", path.display());
            }
            Err(e) => {
                failed += 1;
                tracing::debug!("scan task panicked: {e}");
            }
        }

        if index % 10 == 0 || index + 1 == total {
            let mut scan = state.scan.lock().await;
            scan.done = index + 1;
            scan.added = added;
            scan.failed = failed;
            drop(scan);
            state.publish(WsEvent::Scan {
                phase: "scanning".into(),
                done: index + 1,
                total,
            });
        }
    }

    let removed = vmusic_store::delete_stale_under_root(&state.db, &root.to_string_lossy(), &seen)
        .await
        .unwrap_or(0);
    tracing::info!("scan finished: added {added}, failed {failed}, removed {removed}");

    Ok((added, failed))
}
