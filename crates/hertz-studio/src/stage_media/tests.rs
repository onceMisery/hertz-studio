// SPDX-License-Identifier: MIT
use super::*;
use image::ImageEncoder;
use std::time::{Duration, Instant};

async fn fixture() -> (Arc<StageMediaStore>, PathBuf) {
    let root = std::env::temp_dir().join(format!("hertz-stage-media-test-{}", id()));
    std::fs::create_dir_all(&root).unwrap();
    let db = vmusic_store::open(&root.join("library.sqlite"))
        .await
        .unwrap();
    (
        StageMediaStore::open(db, root.join("stage-media"))
            .await
            .unwrap(),
        root,
    )
}
fn png() -> Vec<u8> {
    let mut data = vec![];
    image::codecs::png::PngEncoder::new(&mut data)
        .write_image(&[23; 32 * 16 * 4], 32, 16, image::ExtendedColorType::Rgba8)
        .unwrap();
    data
}
async fn cleanup(root: PathBuf) {
    assert_eq!(root.parent().unwrap(), std::env::temp_dir().as_path());
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("hertz-stage-media-test-"));
    // SQLx/Windows may close the last SQLite handle just after pool.close() resolves.
    for attempt in 0..10 {
        match std::fs::remove_dir_all(&root) {
            Ok(()) => return,
            Err(e) if attempt == 9 => panic!("fixture cleanup: {e}"),
            Err(_) => tokio::time::sleep(Duration::from_millis(30)).await,
        }
    }
}
fn input(bytes: &[u8]) -> Begin {
    Begin {
        request_id: id(),
        session: id(),
        name: "fixture.png".into(),
        size: bytes.len() as u64,
        media: "image".into(),
        width: 800,
        height: 600,
    }
}
async fn upload(owner: &Arc<StageMediaStore>, bytes: &[u8]) -> Value {
    let started = owner.begin(input(bytes)).await.unwrap();
    owner
        .chunk(
            started["importId"].as_str().unwrap(),
            started["uploadToken"].as_str().unwrap(),
            0,
            &format!("{:x}", Sha256::digest(bytes)),
            bytes,
        )
        .await
        .unwrap();
    started
}
async fn finish(owner: &Arc<StageMediaStore>, started: &Value) -> Value {
    let import = started["importId"].as_str().unwrap();
    let first = owner.finish(import).await.unwrap();
    assert_eq!(first["jobId"], import);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = owner.status(import).await.unwrap();
        if status["status"] != "preparing" {
            let _guard = owner.gate.lock().await;
            return status;
        }
        assert!(Instant::now() < deadline, "job did not finish");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
fn preset(ref_: Value) -> Value {
    json!({"version":1,"scene":"orb","name":"fixture","bg":{"type":"media","media":"image","assetRef":ref_}})
}
fn save(payload: Value, revision: u64) -> presets::Save {
    presets::Save {
        target: "current".into(),
        request_id: id(),
        expected_preset_revision: revision,
        payload,
    }
}

#[tokio::test]
async fn stage_media_persists_repairs_and_reconciles_journals() {
    let (owner, root) = fixture().await;
    let data = png();
    assert_eq!(
        StageMediaStore::open(owner.db.clone(), owner.root.clone())
            .await
            .err()
            .unwrap()
            .code,
        "stage_locked"
    );
    let request = input(&data);
    let started = owner.begin(request.clone()).await.unwrap();
    assert_eq!(
        owner.begin(request).await.unwrap()["importId"],
        started["importId"]
    );
    let import = started["importId"].as_str().unwrap();
    let upload = started["uploadToken"].as_str().unwrap();
    let hash = format!("{:x}", Sha256::digest(&data));
    assert_eq!(
        owner
            .chunk(import, upload, 1, &hash, &data)
            .await
            .unwrap_err()
            .code,
        "stage_chunk_order"
    );
    owner.chunk(import, upload, 0, &hash, &data).await.unwrap();
    owner.chunk(import, upload, 0, &hash, &data).await.unwrap();
    let prefix = &data[..8];
    assert_eq!(
        owner
            .chunk(
                import,
                upload,
                0,
                &format!("{:x}", Sha256::digest(prefix)),
                prefix
            )
            .await
            .unwrap_err()
            .code,
        "stage_chunk_conflict"
    );
    let mut changed = data.clone();
    changed[0] ^= 1;
    assert_eq!(
        owner
            .chunk(
                import,
                upload,
                0,
                &format!("{:x}", Sha256::digest(&changed)),
                &changed
            )
            .await
            .unwrap_err()
            .code,
        "stage_chunk_conflict"
    );
    let committed = finish(&owner, &started).await;
    assert_eq!(committed["status"], "committed", "{committed}");
    assert_eq!(
        owner.finish(import).await.unwrap()["assetRef"],
        committed["assetRef"]
    );
    assert_eq!(committed["assetRef"]["assetId"], hash);
    let request = save(preset(committed["assetRef"].clone()), 0);
    let receipt = owner.save(request).await.unwrap();
    assert_eq!(receipt["revision"], 1);
    let db = owner.db.clone();
    let store_id = owner.store_id.clone();
    let media_root = owner.root.clone();
    drop(owner);
    let owner = StageMediaStore::open(db.clone(), media_root.clone())
        .await
        .unwrap();
    assert_eq!(owner.store_id, store_id);
    assert_eq!(
        presets::load(&db).await.unwrap()["current"]["bg"]["assetRef"],
        committed["assetRef"]
    );
    assert_eq!(
        owner.status(import).await.unwrap()["assetRef"],
        committed["assetRef"]
    );
    std::fs::remove_file(owner.original(&hash)).unwrap();
    assert_eq!(
        owner.list(0).await.unwrap()["items"][0]["status"],
        "missing"
    );
    assert!(owner
        .acquire(
            Acquire {
                asset_ref: serde_json::from_value(committed["assetRef"].clone()).unwrap(),
                width: 800,
                height: 600
            },
            false
        )
        .await
        .is_err());
    let repaired = finish(&owner, &upload_file(&owner, &data).await).await;
    assert_eq!(repaired["assetRef"], committed["assetRef"]);
    assert_eq!(std::fs::read(owner.original(&hash)).unwrap(), data);
    // Dedup hashes the actual installed bytes, so a same-name/replaced object is repaired.
    std::fs::write(owner.original(&hash), b"corrupt").unwrap();
    assert_eq!(
        finish(&owner, &upload_file(&owner, &data).await).await["status"],
        "committed"
    );
    assert_eq!(std::fs::read(owner.original(&hash)).unwrap(), data);
    let pending = owner.begin(input(&data)).await.unwrap();
    drop(owner);
    let owner = StageMediaStore::open(db.clone(), media_root).await.unwrap();
    assert_eq!(
        owner
            .status(pending["importId"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "interrupted"
    );
    // Simulate a crash after the durable deletion marker, before the move.
    owner
        .save(save(
            json!({"version":1,"scene":"orb","bg":{"type":"theme"}}),
            1,
        ))
        .await
        .unwrap();
    sqlx::query("UPDATE stage_media_assets SET state='deleting',delete_id=? WHERE asset_id=?")
        .bind(id())
        .bind(&hash)
        .execute(&db)
        .await
        .unwrap();
    let media_root = owner.root.clone();
    drop(owner);
    let owner = StageMediaStore::open(db.clone(), media_root).await.unwrap();
    assert_eq!(owner.list(0).await.unwrap()["total"], 0);
    assert!(!owner.original(&hash).exists());
    assert_eq!(
        finish(&owner, &upload_file(&owner, &data).await).await["assetRef"],
        committed["assetRef"]
    );
    // No old deleteId is capable of removing the new installation after restart.
    let media_root = owner.root.clone();
    drop(owner);
    let owner = StageMediaStore::open(db.clone(), media_root).await.unwrap();
    assert!(owner.original(&hash).is_file());
    drop(owner);
    db.close().await;
    cleanup(root).await;
}
async fn upload_file(owner: &Arc<StageMediaStore>, data: &[u8]) -> Value {
    upload(owner, data).await
}

#[tokio::test]
async fn stage_media_preset_cas_backup_and_reference_protection() {
    let (owner, root) = fixture().await;
    let data = png();
    let committed = finish(&owner, &upload(&owner, &data).await).await;
    let p = preset(committed["assetRef"].clone());
    let mut unsupported = p.clone();
    unsupported["version"] = json!(2);
    assert_eq!(
        owner.save(save(unsupported, 0)).await.unwrap_err().code,
        "stage_preset_invalid"
    );
    let request = save(p.clone(), 0);
    let receipt = presets::save(&owner.db, &request).await.unwrap();
    assert_eq!(presets::save(&owner.db, &request).await.unwrap(), receipt);
    let mut changed = request;
    changed.payload["name"] = json!("different");
    assert_eq!(
        presets::save(&owner.db, &changed).await.unwrap_err().code,
        "stage_request_conflict"
    );
    assert_eq!(
        owner.save(save(p.clone(), 0)).await.unwrap_err().code,
        "stage_revision_conflict"
    );
    let asset = committed["assetRef"]["assetId"].as_str().unwrap();
    assert_eq!(
        owner.delete(asset).await.unwrap_err().code,
        "stage_asset_referenced"
    );
    let mut mixed = std::collections::BTreeMap::new();
    mixed.insert("unrelated".into(), json!(true));
    mixed.insert(presets::CURRENT.into(), p.clone());
    assert!(vmusic_store::settings::set_all(&owner.db, &mixed)
        .await
        .is_err());
    assert!(vmusic_store::settings::get(&owner.db, "unrelated")
        .await
        .unwrap()
        .is_none());
    let exported = vmusic_store::backup::export(&owner.db).await.unwrap();
    assert!(!exported.settings.contains_key(presets::STATE));
    let bad:vmusic_store::backup::BackupFile=serde_json::from_value(json!({"version":1,"settings":{"creative_current_preset":{"scene":"orb","bg":{"type":"media","assetRef":{"storeId":"bad","assetId":"bad"}}},"unrelated":true}})).unwrap();
    assert!(owner.restore_backup(&bad).await.is_err());
    assert!(vmusic_store::settings::get(&owner.db, "unrelated")
        .await
        .unwrap()
        .is_none());
    let foreign = preset(json!({"storeId":id(),"assetId":"a".repeat(64)}));
    let backup: vmusic_store::backup::BackupFile = serde_json::from_value(
        json!({"version":1,"settings":{"creative_current_preset":foreign,"creative_presets":[]}}),
    )
    .unwrap();
    owner.restore_backup(&backup).await.unwrap();
    let restored = presets::load(&owner.db).await.unwrap();
    assert_eq!(restored["state"]["current"]["revision"], 2);
    assert_eq!(restored["state"]["library"]["initialized"], true);
    let mut same = foreign.clone();
    same["name"] = json!("unrelated edit");
    owner.save(save(same, 2)).await.unwrap();
    let mut another = foreign.clone();
    another["bg"]["assetRef"]["assetId"] = json!("b".repeat(64));
    assert_eq!(
        owner.save(save(another, 3)).await.unwrap_err().code,
        "stage_asset_unavailable"
    );
    let lease = owner
        .acquire(
            Acquire {
                asset_ref: serde_json::from_value(committed["assetRef"].clone()).unwrap(),
                width: 800,
                height: 600,
            },
            true,
        )
        .await
        .unwrap();
    let token = lease["leaseId"].as_str().unwrap();
    assert!(lease["url"].is_null());
    let block = owner.read_image(token, 0, CHUNK_BYTES).await.unwrap();
    assert!(
        !crate::rpc::decode_base64(block["dataBase64"].as_str().unwrap())
            .unwrap()
            .is_empty()
    );
    assert!(owner.read_image(token, 0, CHUNK_BYTES + 1).await.is_err());
    assert_eq!(
        owner.delete(asset).await.unwrap_err().code,
        "stage_asset_in_use"
    );
    let held = owner.lease(token).unwrap();
    owner.release(token);
    assert_eq!(
        owner.delete(asset).await.unwrap_err().code,
        "stage_asset_in_use"
    );
    drop(held);
    owner.delete(asset).await.unwrap();
    assert_eq!(owner.list(0).await.unwrap()["total"], 0);
    let pending = owner.begin(input(&data)).await.unwrap();
    assert_eq!(
        owner
            .cancel(pending["importId"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "cancelled"
    );
    assert!(owner.active.lock().unwrap().is_none());
    let db = owner.db.clone();
    drop(owner);
    db.close().await;
    cleanup(root).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stage_media_http_ranges_and_dedicated_capability() {
    let (owner, root) = fixture().await;
    let data = png();
    let committed = finish(&owner, &upload(&owner, &data).await).await;
    let lease = owner
        .acquire(
            Acquire {
                asset_ref: serde_json::from_value(committed["assetRef"].clone()).unwrap(),
                width: 800,
                height: 600,
            },
            false,
        )
        .await
        .unwrap();
    let (mut state, audio) = crate::state::tests::playback_state_with_db(owner.db.clone()).await;
    state.token = "stage-fixture-only".into();
    state.data_dir = root.clone();
    state.stage_media.set(Ok(owner.clone())).ok().unwrap();
    let state = Arc::new(state);
    let rpc = crate::rpc::Rpc::new(state.clone());
    let rpc_call = crate::rpc::Call {
        op: crate::rpc::Op::Post,
        path: "v1/stage/media",
        query: Value::Null,
        body: json!({"action":"lease.acquire","assetRef":committed["assetRef"],"width":800,"height":600}),
        raw: None,
        client_operation_id: None,
    };
    let dbx_lease = rpc.call(rpc_call).await.unwrap().body;
    assert!(dbx_lease["url"].is_null());
    let rpc_call = crate::rpc::Call {
        op: crate::rpc::Op::Post,
        path: "v1/stage/media",
        query: Value::Null,
        body: json!({"action":"lease.read","leaseId":dbx_lease["leaseId"],"offset":0,"count":CHUNK_BYTES}),
        raw: None,
        client_operation_id: None,
    };
    assert_eq!(
        rpc.call(rpc_call).await.unwrap().body["length"],
        dbx_lease["length"]
    );
    owner.release(dbx_lease["leaseId"].as_str().unwrap());
    drop(rpc);
    let app = crate::routes::router(state.clone()).with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("{base}{}", lease["url"].as_str().unwrap());
    let head = client.head(&url).send().await.unwrap();
    assert_eq!(head.status(), 200);
    assert_eq!(
        head.headers()["content-length"]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap(),
        lease["length"].as_u64().unwrap()
    );
    let partial = client
        .get(&url)
        .header("Range", "bytes=0-7")
        .send()
        .await
        .unwrap();
    assert_eq!(partial.status(), 206);
    assert_eq!(partial.headers()["content-length"], "8");
    assert!(partial.headers().get("content-encoding").is_none());
    assert_eq!(&partial.bytes().await.unwrap()[..], b"\x89PNG\r\n\x1a\n");
    assert_eq!(
        client
            .get(&url)
            .header("Range", "bytes=0-1,4-7")
            .send()
            .await
            .unwrap()
            .status(),
        416
    );
    assert_eq!(
        client
            .get(format!("{base}/v1/stage/media/resource/bad"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .get(format!("{base}/v1/stage/media"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    owner.release(lease["leaseId"].as_str().unwrap());
    assert_eq!(client.get(&url).send().await.unwrap().status(), 401);
    server.abort();
    let _ = server.await;
    state.audio.shutdown();
    audio.join().unwrap();
    let db = owner.db.clone();
    drop(state);
    drop(owner);
    db.close().await;
    cleanup(root).await;
}

#[tokio::test]
async fn stage_media_video_gate_invalid_images_and_cancel() {
    let (owner, root) = fixture().await;
    let bytes = include_bytes!("../../../../scripts/fixtures/wallpaper-vp8.webm");
    let mut req = input(bytes);
    req.media = "video".into();
    req.name = "test.webm".into();
    let started = owner.begin(req).await.unwrap();
    owner
        .chunk(
            started["importId"].as_str().unwrap(),
            started["uploadToken"].as_str().unwrap(),
            0,
            &format!("{:x}", Sha256::digest(bytes)),
            bytes,
        )
        .await
        .unwrap();
    let result = finish(&owner, &started).await;
    assert_eq!(result["status"], "committed", "{result}");
    let acquire = || Acquire {
        asset_ref: serde_json::from_value(result["assetRef"].clone()).unwrap(),
        width: 1280,
        height: 720,
    };
    assert_eq!(
        owner.acquire(acquire(), true).await.unwrap_err().code,
        "stage_video_stream_unavailable"
    );
    let lease = owner.acquire(acquire(), false).await.unwrap();
    assert_eq!(lease["length"], bytes.len());
    assert_eq!(lease["mime"], "video/webm");
    assert!(owner
        .read_image(lease["leaseId"].as_str().unwrap(), 0, CHUNK_BYTES)
        .await
        .is_err());
    owner.release(lease["leaseId"].as_str().unwrap());
    let invalid = b"this is not actually an image file";
    let rejected = finish(&owner, &upload(&owner, invalid).await).await;
    assert_eq!(rejected["status"], "failed");
    let data = png();
    let started = owner.begin(input(&data)).await.unwrap();
    let import = started["importId"].as_str().unwrap();
    sqlx::query("UPDATE stage_media_imports SET touched_at=? WHERE import_id=?")
        .bind(now() - 61_000)
        .bind(import)
        .execute(&owner.db)
        .await
        .unwrap();
    let next = owner.begin(input(&data)).await.unwrap();
    assert_eq!(owner.status(import).await.unwrap()["status"], "expired");
    owner
        .cancel(next["importId"].as_str().unwrap())
        .await
        .unwrap();
    let started = upload(&owner, &data).await;
    let import = started["importId"].as_str().unwrap();
    owner.finish(import).await.unwrap();
    let cancelled = owner.cancel(import).await.unwrap();
    assert!(matches!(
        cancelled["status"].as_str(),
        Some("cancelled" | "committed")
    ));
    if cancelled["status"] != "committed" {
        assert!(cancelled["assetRef"].is_null());
    }
    assert!(owner.active.lock().unwrap().is_none());
    let db = owner.db.clone();
    drop(owner);
    db.close().await;
    cleanup(root).await;
}

#[test]
fn stage_media_single_ranges() {
    assert_eq!(api::range(Some("bytes=-3"), 10), Ok((7, 3, true)));
    assert_eq!(api::range(Some("bytes=5-"), 10), Ok((5, 5, true)));
    assert_eq!(api::range(Some("bytes=5-500"), 10), Ok((5, 5, true)));
    assert!(api::range(Some("bytes=10-"), 10).is_err());
    assert!(api::range(Some("bytes=7-5"), 10).is_err());
}
