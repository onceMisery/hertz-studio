// SPDX-License-Identifier: MIT
use super::*;

#[tokio::test]
async fn binding_a_job_cannot_revive_an_expired_or_missing_snapshot() {
    let root = super::super::library::tempfileish::temp_dir("asset-set-bind-expiry");
    let library = Library::open(root.path()).await.unwrap();
    sqlx::query("INSERT INTO ai_asset_sets(asset_set_id,service_identity,digest,metadata_json,selections_json,quote_id,request_id,created_at,expires_at) VALUES('set','service',?,'{}','[]','quote','request',1,0)")
        .bind("a".repeat(64)).execute(library.pool()).await.unwrap();
    assert!(AiAssetSets(&library)
        .bind_job("quote", "request", "job")
        .await
        .is_err());
    let job: Option<String> =
        sqlx::query_scalar("SELECT job_id FROM ai_asset_sets WHERE asset_set_id='set'")
            .fetch_one(library.pool())
            .await
            .unwrap();
    assert!(job.is_none());
    sqlx::query("DELETE FROM ai_asset_sets")
        .execute(library.pool())
        .await
        .unwrap();
    assert!(AiAssetSets(&library)
        .bind_job("quote", "request", "job")
        .await
        .is_err());
    library.pool().close().await;
}

#[tokio::test]
async fn submission_pins_live_versions_before_a_delayed_receipt_and_terminal_failure_releases_them()
{
    let root = super::super::library::tempfileish::temp_dir("asset-set-submit-lifecycle");
    let library = Library::open(root.path()).await.unwrap();
    library
        .install(&super::super::library::InstallWork {
            work_key: "local-source".into(),
            remote_work_id: uuid::Uuid::new_v4().to_string(),
            title: "source".into(),
            description: String::new(),
            kind: "image".into(),
            package_hash: "b".repeat(64),
            manifest_json: "{}".into(),
            package_bytes: 3,
            version: 1,
            source_id: "local".into(),
        })
        .await
        .unwrap();
    sqlx::query("INSERT INTO ai_asset_sets(asset_set_id,service_identity,digest,metadata_json,selections_json,quote_id,request_id,created_at,expires_at) VALUES('set','service',?,'{}','[]','quote','request',1,?)")
        .bind("a".repeat(64)).bind(now_secs()+1).execute(library.pool()).await.unwrap();
    sqlx::query("INSERT INTO ai_asset_references VALUES('set','local-source',?)")
        .bind("b".repeat(64))
        .execute(library.pool())
        .await
        .unwrap();
    let sets = AiAssetSets(&library);
    assert!(sets
        .begin_submission("set", "another-service", "quote", "request")
        .await
        .is_err());
    sets.begin_submission("set", "service", "quote", "request")
        .await
        .unwrap();
    let expires: i64 =
        sqlx::query_scalar("SELECT expires_at FROM ai_asset_sets WHERE asset_set_id='set'")
            .fetch_one(library.pool())
            .await
            .unwrap();
    assert!(expires >= now_secs() + 86395);
    sets.bind_job("quote", "request", "job").await.unwrap();
    sets.bind_job("quote", "request", "job").await.unwrap();
    assert!(sets
        .bind_job("quote", "request", "other-job")
        .await
        .is_err());
    sets.release_terminal("another-service", "job")
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_asset_references")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
    sets.release_terminal("service", "job").await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_asset_references")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    library.pool().close().await;
}
