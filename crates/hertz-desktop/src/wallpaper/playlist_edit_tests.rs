// SPDX-License-Identifier: MIT
use super::edit::{Edit, PageRequest, Update, MAX_ITEMS};
use super::tests::{install, reference};
use super::*;
use crate::wallpaper::library::tempfileish;
use serde_json::json;

fn update(id: &str, revision: u64, operations: Vec<Edit>) -> Update {
    Update {
        playlist_id: id.into(),
        expected_playlist_revision: revision,
        title: "千项轮播".into(),
        mode: Mode::Sequential,
        interval_seconds: 10,
        operations,
    }
}
async fn apply(repository: &Repository<'_>, update: Update) -> Result<Playlist> {
    let candidate = repository.candidate(update).await?;
    repository.commit_candidate(candidate).await
}
fn page(id: &str, revision: Option<u64>, offset: usize) -> PageRequest {
    PageRequest {
        playlist_id: id.into(),
        expected_playlist_revision: revision,
        offset,
        limit: 32,
    }
}

#[tokio::test]
async fn thousand_items_reopen_page_and_run_with_exact_fixed_versions() {
    let root = tempfileish::temp_dir("playlist-thousand");
    let library = Library::open(root.path()).await.unwrap();
    let first = reference("first", 1);
    let second = reference("second", 2);
    install(&library, &first, 1).await;
    install(&library, &second, 1).await;
    let expected: Vec<_> = (0..MAX_ITEMS)
        .map(|i| {
            if i % 2 == 0 {
                first.clone()
            } else {
                second.clone()
            }
        })
        .collect();
    let repo = Repository::new(&library);
    let saved = repo
        .save(
            None,
            None,
            "千项轮播".into(),
            Mode::Sequential,
            10,
            expected.clone(),
        )
        .await
        .unwrap();
    let mut all = Vec::new();
    for offset in (0..MAX_ITEMS).step_by(32) {
        let value = repo
            .page(&page(&saved.playlist_id, Some(1), offset))
            .await
            .unwrap();
        assert!(serde_json::to_vec(&value).unwrap().len() < 64 * 1024);
        assert_eq!(value["itemCount"], MAX_ITEMS);
        all.extend(serde_json::from_value::<Vec<FixedVersion>>(value["items"].clone()).unwrap());
    }
    assert_eq!(all, expected);
    assert!(repo
        .references(None, Some(&second.package_hash))
        .await
        .unwrap());
    let changed = apply(
        &repo,
        update(&saved.playlist_id, 1, vec![Edit::Move { from: 999, to: 0 }]),
    )
    .await
    .unwrap();
    assert_eq!(changed.items[0], second);
    assert_eq!(
        repo.page(&page(&saved.playlist_id, Some(1), 32))
            .await
            .unwrap_err()
            .code,
        "playlist_conflict"
    );
    let mut runner = Runner::new(changed.clone(), 1).unwrap();
    let initial = runner.initial().unwrap();
    assert_eq!(initial.reference, second);
    assert!(runner.presented(initial.token));
    assert_eq!(runner.next().unwrap().reference, first);
    library.pool().close().await;
    let reopened = Library::open(root.path()).await.unwrap();
    let restored = Repository::new(&reopened)
        .get(&saved.playlist_id)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(changed).unwrap()
    );
    reopened.pool().close().await;
}

#[tokio::test]
async fn insert_move_remove_and_metadata_are_atomic_with_cas() {
    let root = tempfileish::temp_dir("playlist-edits");
    let library = Library::open(root.path()).await.unwrap();
    let repo = Repository::new(&library);
    let a = reference("a", 3);
    let b = reference("b", 4);
    install(&library, &a, 1).await;
    install(&library, &b, 1).await;
    let created = apply(
        &repo,
        update(
            "chosen-id",
            0,
            vec![Edit::Insert {
                index: 0,
                item: a.clone(),
            }],
        ),
    )
    .await
    .unwrap();
    assert_eq!(created.revision, 1);
    let changed = apply(
        &repo,
        update(
            "chosen-id",
            1,
            vec![
                Edit::Insert {
                    index: 1,
                    item: b.clone(),
                },
                Edit::Insert {
                    index: 2,
                    item: a.clone(),
                },
                Edit::Move { from: 0, to: 2 },
                Edit::Remove { index: 1 },
            ],
        ),
    )
    .await
    .unwrap();
    assert_eq!(changed.items, vec![b.clone(), a.clone()]);
    let before = serde_json::to_value(&changed).unwrap();
    for edits in [
        vec![Edit::Remove { index: 0 }, Edit::Remove { index: 9 }],
        vec![Edit::Insert {
            index: 0,
            item: reference("missing", 5),
        }],
        vec![Edit::Remove { index: 1 }, Edit::Remove { index: 0 }],
    ] {
        assert!(apply(&repo, update("chosen-id", 2, edits)).await.is_err());
        assert_eq!(
            serde_json::to_value(repo.get("chosen-id").await.unwrap()).unwrap(),
            before
        );
    }
    let candidate1 = repo
        .candidate(update("chosen-id", 2, vec![Edit::Move { from: 0, to: 1 }]))
        .await
        .unwrap();
    let candidate2 = repo
        .candidate(update("chosen-id", 2, vec![Edit::Remove { index: 1 }]))
        .await
        .unwrap();
    repo.commit_candidate(candidate1).await.unwrap();
    assert_eq!(
        repo.commit_candidate(candidate2).await.unwrap_err().code,
        "playlist_conflict"
    );
    assert_eq!(
        apply(
            &repo,
            update("chosen-id", 0, vec![Edit::Insert { index: 0, item: b }])
        )
        .await
        .unwrap_err()
        .code,
        "playlist_conflict"
    );
    library.pool().close().await;
}

#[tokio::test]
async fn capacity_and_page_boundaries_preserve_saved_list() {
    let root = tempfileish::temp_dir("playlist-large-limits");
    let library = Library::open(root.path()).await.unwrap();
    let repo = Repository::new(&library);
    let item = reference("item", 6);
    install(&library, &item, 1).await;
    let saved = repo
        .save(
            None,
            None,
            "满列表".into(),
            Mode::Random,
            60,
            vec![item.clone(); 1000],
        )
        .await
        .unwrap();
    assert!(apply(
        &repo,
        update(
            &saved.playlist_id,
            1,
            vec![Edit::Insert {
                index: 1000,
                item: item.clone()
            }]
        )
    )
    .await
    .is_err());
    assert!(apply(
        &repo,
        update(
            &saved.playlist_id,
            1,
            vec![Edit::Move { from: 0, to: 1 }; 33]
        )
    )
    .await
    .is_err());
    assert!(repo
        .page(&page(&saved.playlist_id, None, 32))
        .await
        .is_err());
    assert!(repo
        .page(&page(&saved.playlist_id, Some(1), 1000))
        .await
        .is_err());
    assert_eq!(repo.get(&saved.playlist_id).await.unwrap().revision, 1);
    assert_eq!(
        repo.get(&saved.playlist_id).await.unwrap().items.len(),
        1000
    );
    library.pool().close().await;
}

#[test]
fn incremental_wire_stays_bounded_and_rejects_untyped_fields() {
    let item = FixedVersion {
        work_key: "\\\"".repeat(64),
        package_hash: "a".repeat(64),
    };
    let mut value = update(
        &"p".repeat(128),
        1,
        (0..32)
            .map(|index| Edit::Insert {
                index,
                item: item.clone(),
            })
            .collect(),
    );
    value.title = "🗂".repeat(120);
    let payload = json!({"playlistId":value.playlist_id,"expectedPlaylistRevision":value.expected_playlist_revision,
        "title":value.title,"mode":value.mode,"intervalSeconds":value.interval_seconds,"operations":value.operations});
    let request = json!({"protocol":2,"requestId":"r".repeat(128),"command":"wallpaper.playlist.update","payload":payload});
    let bytes = serde_json::to_vec(&request).unwrap();
    assert!(bytes.len() < hertz_desktop_ipc::management::REQUEST_LIMIT);
    let parsed: crate::wallpaper::api::Request = serde_json::from_value(request.clone()).unwrap();
    assert!(matches!(
        parsed.typed().unwrap(),
        crate::wallpaper::api::Command::PlaylistUpdate(_)
    ));
    let mut invalid = request.clone();
    invalid["payload"]["operations"][0]["path"] = "unsafe".into();
    assert!(
        serde_json::from_value::<crate::wallpaper::api::Request>(invalid)
            .unwrap()
            .typed()
            .is_err()
    );
    let mut invalid = request;
    invalid["payload"]["expectedPlaylistRevision"] = u64::MAX.into();
    assert!(
        serde_json::from_value::<crate::wallpaper::api::Request>(invalid)
            .unwrap()
            .typed()
            .is_err()
    );
}
