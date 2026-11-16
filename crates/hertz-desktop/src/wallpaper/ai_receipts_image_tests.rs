// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::library::{tempfileish, InstallWork, LOCAL_SOURCE};

async fn seed(library: &Library) -> (String, String) {
    let work = uuid::Uuid::new_v4().to_string();
    let id = format!("work-ai-{work}");
    sqlx::query("INSERT INTO ai_receipts(receipt_id,service_owner,job_id,artifact_id,output_hash,state,metadata_json,provider,model,received_at,expires_at,kind,image_work_id,candidate_package_hash,candidate_bytes) VALUES(?,'owner','job','artifact',?,'previewReady','{}','fake-image','fixture-image-v1',1,?,'image',?,?,3)")
        .bind(&id).bind("a".repeat(64)).bind(now_secs()+3600).bind(&work).bind("b".repeat(64))
        .execute(library.pool()).await.unwrap();
    (id, work)
}

#[tokio::test]
async fn frozen_image_save_survives_restart_and_install_failure_rolls_back_origin() {
    let root = tempfileish::temp_dir("ai-image-frozen-save");
    let library = Library::open(root.path()).await.unwrap();
    let (id, work_id) = seed(&library).await;
    let hash = "c".repeat(64);
    AiReceipts::new(&library)
        .freeze_image_save(&id, "保留原作品名", &hash)
        .await
        .unwrap();
    library.pool().close().await;
    drop(library);
    let library = Library::open(root.path()).await.unwrap();
    let receipts = AiReceipts::new(&library);
    assert_eq!(
        receipts
            .image_identity(&id, Some("重试不重命名"))
            .await
            .unwrap()
            .title,
        "保留原作品名"
    );
    assert_eq!(
        receipts
            .freeze_image_save(&id, "其它作品名", &hash)
            .await
            .unwrap_err()
            .code,
        "candidate_changed"
    );
    let mut work = InstallWork {
        remote_work_id: work_id.clone(),
        work_key: format!("local-{work_id}"),
        title: "错误标题".into(),
        description: String::new(),
        kind: "image".into(),
        package_hash: hash.clone(),
        manifest_json: "{}".into(),
        package_bytes: 3,
        version: 1,
        source_id: LOCAL_SOURCE.into(),
    };
    assert_eq!(
        library.install(&work).await.unwrap_err().code,
        "ai_output_rejected"
    );
    let counts: (i64, i64, i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM works),(SELECT COUNT(*) FROM packages),(SELECT COUNT(*) FROM ai_origins)")
        .fetch_one(library.pool()).await.unwrap();
    assert_eq!(counts, (0, 0, 0));
    assert_eq!(receipts.get(&id).await.unwrap()["state"], "saving");
    work.title = "保留原作品名".into();
    library.install(&work).await.unwrap();
    library.install(&work).await.unwrap();
    assert_eq!(receipts.get(&id).await.unwrap()["state"], "saved");
    let origin: (String, String, String) =
        sqlx::query_as("SELECT provider,model,output_hash FROM ai_origins")
            .fetch_one(library.pool())
            .await
            .unwrap();
    assert_eq!(
        origin,
        (
            "fake-image".into(),
            "fixture-image-v1".into(),
            "a".repeat(64)
        )
    );
    library.pool().close().await;
}

#[cfg(windows)]
#[tokio::test]
async fn deleted_image_keeps_byte_charge_until_real_file_reader_exits() {
    let root = tempfileish::temp_dir("ai-image-reader-cleanup");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let (id, _) = seed(&library).await;
    let directory = assets.candidate_dir(&id).unwrap();
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("original.hwpkg");
    std::fs::write(&path, b"png").unwrap();
    let reader = crate::wallpaper::assets::open_immutable(&path).unwrap();
    let receipts = AiReceipts::new(&library);
    receipts.delete(&id).await.unwrap();
    assert!(receipts.maintenance_files(&assets).await.unwrap().is_some());
    assert!(path.exists());
    assert_eq!(receipts.get(&id).await.unwrap()["candidateBytes"], 3);
    drop(reader);
    receipts.maintenance_files(&assets).await.unwrap();
    assert!(!directory.exists());
    assert_eq!(receipts.get(&id).await.unwrap()["candidateBytes"], 0);
    library.pool().close().await;
}
