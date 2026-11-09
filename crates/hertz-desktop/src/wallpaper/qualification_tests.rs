// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::super::{
    library::tempfileish,
    media::{Container, MediaProbe},
};
use super::*;

fn sample_key(tag: u8) -> Key {
    Key {
        digest: format!("{tag:064x}"),
        content: format!("{:064x}", 1),
        environment: format!("{:064x}", 2),
        adapter: ADAPTER,
    }
}

#[test]
fn identity_binds_actual_bytes_metadata_and_environment() {
    let mut entry = hertz_wallpaper::VerifiedEntry {
        path: "file.png".into(),
        bytes: 1,
        sha256: "a".repeat(64),
        mime: Some("image/png".into()),
    };
    let mut info = MediaProbe {
        container: Container::Image,
        codec: "png".into(),
        profile: None,
        encoded_width: 1,
        encoded_height: 1,
        display_width: 1,
        display_height: 1,
        rotation_degrees: 0,
        pixel_aspect_ratio: 1.0,
        duration_ms: None,
        source_fps: None,
        fps_upper_bound: None,
    };
    let mut environment = Environment {
        browser: "test-webview2".into(),
        fingerprint: "b".repeat(64),
    };
    let initial = key(&entry, &info, &environment).unwrap().digest;
    entry.path = "other-package/same-bytes.png".into();
    assert_eq!(initial, key(&entry, &info, &environment).unwrap().digest);
    entry.sha256 = "c".repeat(64);
    assert_ne!(initial, key(&entry, &info, &environment).unwrap().digest);
    entry.sha256 = "a".repeat(64);
    info.encoded_width = 2;
    assert_ne!(initial, key(&entry, &info, &environment).unwrap().digest);
    info.encoded_width = 1;
    environment.browser = "new-webview2".into();
    assert_ne!(initial, key(&entry, &info, &environment).unwrap().digest);
    environment.browser = "test-webview2".into();
    environment.fingerprint = "d".repeat(64);
    assert_ne!(initial, key(&entry, &info, &environment).unwrap().digest);
}

#[tokio::test]
async fn success_has_bounded_age_and_rechecks_stored_identity() {
    let root = tempfileish::temp_dir("qualification-age");
    let library = Library::open(root.path()).await.unwrap();
    let key = sample_key(1);
    record(&library, &key, 100).await.unwrap();
    assert!(hit(&library, &key, 101).await.unwrap());
    assert!(
        !hit(&library, &key, 99).await.unwrap(),
        "时钟倒退不复用未来证明"
    );
    assert!(!hit(&library, &key, 101 + TTL).await.unwrap());
    sqlx::query("UPDATE media_qualifications SET adapter_version = 'old'")
        .execute(library.pool())
        .await
        .unwrap();
    assert!(!hit(&library, &key, 101).await.unwrap());
    record(&library, &key, 102).await.unwrap();
    sqlx::query("UPDATE media_qualifications SET content_hash = ?")
        .bind("f".repeat(64))
        .execute(library.pool())
        .await
        .unwrap();
    assert!(
        !hit(&library, &key, 103).await.unwrap(),
        "不只信任主键字符串"
    );
}

#[tokio::test]
async fn records_survive_reopen_and_enforce_lru_limit() {
    let root = tempfileish::temp_dir("qualification-cap");
    let library = Library::open(root.path()).await.unwrap();
    sqlx::query("WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n < 4096) INSERT INTO media_qualifications SELECT printf('%064x', n), printf('%064x', 1), printf('%064x', 2), ?, 100, n FROM ids")
        .bind(ADAPTER).execute(library.pool()).await.unwrap();
    let newest = Key {
        digest: "f".repeat(64),
        ..sample_key(9)
    };
    // 旧行的 last_used 特意较大；新纪录仍必须在上限内，不依赖插入条数计算容量。
    record(&library, &newest, 5000).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_qualifications")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(count, CAP);
    assert!(!hit(&library, &sample_key(1), 5001).await.unwrap());
    assert!(hit(&library, &newest, 5001).await.unwrap());
    library.pool().close().await;
    let reopened = Library::open(root.path()).await.unwrap();
    assert!(hit(&reopened, &newest, 5002).await.unwrap());
    record(&reopened, &sample_key(8), 5001 + TTL).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media_qualifications")
            .fetch_one(reopened.pool())
            .await
            .unwrap(),
        1
    );
}

fn pinned_font(tag: &str) -> (FontInput, tempfileish::TempDir) {
    let (assets, root, reference, entry) = font_prepare::installed(tag);
    let probe = ProbeClient::testing_input(|_, _| Box::pin(async { Ok(()) }));
    let workspace = probe
        .image_workspace(font_prepare::prepare_workspace_bytes(entry.bytes).unwrap())
        .unwrap();
    let input = font_prepare::pin_input(
        &assets,
        &reference,
        &entry,
        &[font_prepare::RequiredText {
            node_id: "heading".into(),
            text: "Hertz Studio".into(),
        }],
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    workspace.finish();
    (input, root)
}

fn font_environment() -> Environment {
    Environment {
        browser: "test-webview2".into(),
        fingerprint: "b".repeat(64),
    }
}

#[tokio::test]
async fn font_success_cache_binds_font_facts_environment_and_survives_reopen() {
    let (input, root) = pinned_font("font-qualification-cache");
    let library = Library::open(root.path()).await.unwrap();
    let probe = ProbeClient::testing_input(|input, _| {
        assert!(matches!(
            input,
            super::super::decode_probe::ProbeInput::Font(_)
        ));
        Box::pin(async { Ok(()) })
    })
    .environment_for_test(|| Some(font_environment()));
    let cancel = Arc::new(AtomicBool::new(false));
    let proof = probe
        .qualify_font(&library, input.clone(), Arc::clone(&cancel))
        .await
        .unwrap();
    assert!(proof.matches(&input).unwrap());
    probe
        .qualify_font(&library, input.clone(), Arc::clone(&cancel))
        .await
        .unwrap();
    assert_eq!(probe.stats(), (1, 1));
    let initial = font_key(&input, &font_environment()).unwrap();
    assert_eq!(initial.adapter, FONT_ADAPTER);
    let mut changed = input.clone();
    changed.metadata.probe_text.push('H');
    assert_eq!(
        font_key(&changed, &font_environment()).err().unwrap().code,
        "font_input_changed"
    );
    assert_eq!(
        proof.matches(&changed).unwrap_err().code,
        "font_input_changed"
    );
    assert_eq!(
        probe
            .qualify_font(&library, changed, Arc::clone(&cancel))
            .await
            .err()
            .unwrap()
            .code,
        "font_input_changed"
    );
    assert_eq!(probe.stats(), (1, 1));
    let mut environment = font_environment();
    environment.browser = "other-webview2".into();
    assert_ne!(
        initial.digest,
        font_key(&input, &environment).unwrap().digest
    );
    environment = font_environment();
    environment.fingerprint = "c".repeat(64);
    assert_ne!(
        initial.digest,
        font_key(&input, &environment).unwrap().digest
    );
    library.pool().close().await;
    let library = Library::open(root.path()).await.unwrap();
    let reopened = ProbeClient::testing_input(|_, _| {
        panic!("same-environment font success must reuse the original cache")
    })
    .environment_for_test(|| Some(font_environment()));
    reopened
        .qualify_font(&library, input, cancel)
        .await
        .unwrap();
    assert_eq!(reopened.stats(), (1, 0));
}

#[tokio::test]
async fn font_metadata_refusal_precedes_probe_and_cached_success_lookup() {
    let (input, root) = pinned_font("font-qualification-metadata");
    let library = Library::open(root.path()).await.unwrap();
    let probe = ProbeClient::testing_input(|_, _| Box::pin(async { Ok(()) }))
        .environment_for_test(|| Some(font_environment()));
    probe
        .qualify_font(&library, input.clone(), Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    for case in 0..5 {
        let mut changed = input.clone();
        match case {
            0 => changed.metadata.sfnt_bytes += 1,
            1 => changed.metadata.cpu_budget_bytes += 1,
            2 => changed.metadata.glyph_count = 0,
            3 => changed.metadata.probe_text.clear(),
            _ => changed.metadata.format = font_prepare::FontFormat::Otf,
        }
        let error = probe
            .qualify_font(&library, changed, Arc::new(AtomicBool::new(false)))
            .await
            .err()
            .unwrap();
        assert!(
            matches!(error.code, "font_input_changed" | "font_invalid"),
            "case {case}: {error}"
        );
    }
    assert_eq!(probe.stats(), (0, 1));
}

#[tokio::test]
async fn failed_and_cancelled_font_probes_never_create_success_cache_entries() {
    let (input, root) = pinned_font("font-qualification-failure");
    let library = Library::open(root.path()).await.unwrap();
    for code in [
        "font_decode_failed",
        "probe_inconclusive",
        "budget_busy",
        "cancelled",
    ] {
        let probe = ProbeClient::testing_input(move |_, _| {
            Box::pin(
                async move { Err(JobError::new(code, "controlled font qualification failure")) },
            )
        })
        .environment_for_test(|| Some(font_environment()));
        for _ in 0..2 {
            assert_eq!(
                probe
                    .qualify_font(&library, input.clone(), Arc::new(AtomicBool::new(false)))
                    .await
                    .err()
                    .unwrap()
                    .code,
                code
            );
        }
        assert_eq!(probe.stats(), (0, 2));
    }
    let probe = ProbeClient::testing_input(|_, cancel| {
        Box::pin(async move {
            cancel.store(true, Ordering::Release);
            Ok(()) // A late successful callback cannot seal a cancelled qualification.
        })
    })
    .environment_for_test(|| Some(font_environment()));
    assert_eq!(
        probe
            .qualify_font(&library, input, Arc::new(AtomicBool::new(false)))
            .await
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media_qualifications")
            .fetch_one(library.pool())
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn changing_font_environment_during_probe_prevents_cache_publication() {
    let (input, root) = pinned_font("font-qualification-environment-change");
    let library = Library::open(root.path()).await.unwrap();
    let generation = Arc::new(AtomicBool::new(false));
    let callback_generation = Arc::clone(&generation);
    let environment_generation = Arc::clone(&generation);
    let probe = ProbeClient::testing_input(move |_, _| {
        callback_generation.store(true, Ordering::Release);
        Box::pin(async { Ok(()) })
    })
    .environment_for_test(move || {
        let mut environment = font_environment();
        if environment_generation.load(Ordering::Acquire) {
            environment.fingerprint = "c".repeat(64);
        }
        Some(environment)
    });
    probe
        .qualify_font(&library, input.clone(), Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media_qualifications")
            .fetch_one(library.pool())
            .await
            .unwrap(),
        0
    );
    probe
        .qualify_font(&library, input.clone(), Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    probe
        .qualify_font(&library, input, Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    assert_eq!(probe.stats(), (1, 2));
}

#[tokio::test]
async fn cancelled_font_publication_rolls_back_after_waiting_for_actual_sqlite_writer() {
    let root = tempfileish::temp_dir("font-cache-cancelled-writer");
    let library = Library::open(root.path()).await.unwrap();
    let transaction = library.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
    let cancel = AtomicBool::new(false);
    let key = Key {
        adapter: FONT_ADAPTER,
        ..sample_key(19)
    };
    let mut publishing = std::pin::pin!(record_cancellable(&library, &key, 100, Some(&cancel)));
    std::future::poll_fn(|context| {
        assert!(
            std::future::Future::poll(publishing.as_mut(), context).is_pending(),
            "the original SQLite writer must block publication"
        );
        std::task::Poll::Ready(())
    })
    .await;
    cancel.store(true, Ordering::Release);
    transaction.commit().await.unwrap();
    assert_eq!(publishing.await.unwrap_err().code, "cancelled");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media_qualifications")
            .fetch_one(library.pool())
            .await
            .unwrap(),
        0
    );
    assert!(!hit(&library, &key, 101).await.unwrap());
}
