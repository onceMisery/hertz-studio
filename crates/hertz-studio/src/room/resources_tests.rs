// SPDX-License-Identifier: MIT
use super::*;
use base64::Engine;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Semaphore;

struct Fixture {
    base: PathBuf,
    state: Arc<AppState>,
    audio: std::thread::JoinHandle<()>,
}
impl Fixture {
    async fn new() -> Self {
        Self::with_gate(None).await
    }
    async fn with_gate(gate: Option<Arc<ReadGate>>) -> Self {
        let base = std::env::temp_dir().join(format!("room-resources-{}", Uuid::new_v4()));
        let db = vmusic_store::open(&base).await.unwrap();
        let db = if let Some(gate) = gate {
            db.close().await;
            sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .before_acquire(move |_, _| {
                    let gate = gate.clone();
                    Box::pin(async move {
                        if gate.armed.load(Ordering::SeqCst)
                            && gate.acquisitions.fetch_add(1, Ordering::SeqCst) == 1
                        {
                            gate.blocked.add_permits(1);
                            gate.release.acquire().await.unwrap().forget();
                        }
                        Ok(true)
                    })
                })
                .connect_with(
                    sqlx::sqlite::SqliteConnectOptions::new().filename(base.join("vmusic.db")),
                )
                .await
                .unwrap()
        } else {
            db
        };
        let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
        state.data_dir = base.clone();
        tokio::fs::create_dir_all(state.cover_dir()).await.unwrap();
        Self {
            base,
            state: Arc::new(state),
            audio,
        }
    }
    async fn track(&self, id: &str) -> Track {
        let path = self.base.join(format!("audio-{}.mp3", Uuid::new_v4()));
        tokio::fs::write(&path, b"no embedded metadata")
            .await
            .unwrap();
        let mut track = vmusic_library::build_track(&path, Default::default());
        track.id = id.into();
        vmusic_store::upsert_track(&self.state.db, &track)
            .await
            .unwrap();
        track
    }
    async fn share(&self, library: &SharedLibrary, ids: &[&str]) -> Vec<SharedTrack> {
        let prepared = library
            .prepare_replace(&self.state, ids.iter().map(|s| (*s).into()).collect())
            .await
            .unwrap();
        library.commit_replace(prepared).await.unwrap()
    }
    async fn finish(self) {
        self.state.db.close().await;
        drop(self.state);
        self.audio.join().unwrap();
        // SQLite's worker may release its Windows file handle just after the
        // pool acknowledges close. Keep cleanup reliable without hiding errors.
        for attempt in 0..20 {
            match tokio::fs::remove_dir_all(&self.base).await {
                Ok(()) => return,
                Err(_) if attempt < 19 => tokio::time::sleep(Duration::from_millis(10)).await,
                Err(error) => panic!("resource fixture cleanup failed: {error}"),
            }
        }
    }
}
struct ReadGate {
    armed: AtomicBool,
    acquisitions: AtomicUsize,
    blocked: Semaphore,
    release: Semaphore,
}
impl ReadGate {
    fn new() -> Self {
        Self {
            armed: AtomicBool::new(false),
            acquisitions: AtomicUsize::new(0),
            blocked: Semaphore::new(0),
            release: Semaphore::new(0),
        }
    }
}
fn decoded(chunk: &ResourceChunk) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(&chunk.base64)
        .unwrap()
}
fn error<T>(result: RoomResult<T>, code: &str) {
    match result {
        Err(e) => assert_eq!(e.code, code),
        Ok(_) => panic!("expected {code}"),
    }
}

#[tokio::test]
async fn shared_library_search_matches_metadata_and_immediately_honors_revocation() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    for (id, title, artist, album) in [
        ("title-id", "Midnight Voyage", None, None),
        ("artist-id", "Another Song", Some("Voyage Ensemble"), None),
        ("album-id", "Final Song", None, Some("VOYAGE 夜航")),
        (
            "private-id",
            "Voyage Private",
            Some("Voyage"),
            Some("Voyage"),
        ),
    ] {
        let mut track = f.track(id).await;
        track.title = title.into();
        track.artist = artist.map(String::from);
        track.album = album.map(String::from);
        vmusic_store::upsert_track(&f.state.db, &track)
            .await
            .unwrap();
    }
    let shared = f
        .share(&library, &["title-id", "artist-id", "album-id"])
        .await;
    let revision = library.revision().await;
    let (found_revision, total, tracks) = library.search_page(0, 64, "  vOyAgE  ").await;
    assert_eq!((found_revision, total, tracks.len()), (revision, 3, 3));
    assert_eq!(
        tracks.iter().map(|t| t.resource_id).collect::<Vec<_>>(),
        shared.iter().map(|t| t.resource_id).collect::<Vec<_>>()
    );
    assert_eq!(library.search_page(0, 64, "夜航").await.1, 1);
    for private in ["Private", "title-id", "audio-", "unmatched"] {
        assert_eq!(library.search_page(0, 64, private).await.1, 0);
    }

    f.share(&library, &["artist-id"]).await;
    let (new_revision, total, tracks) = library.search_page(0, 64, "voyage").await;
    assert!(new_revision > revision);
    assert_eq!(total, 1);
    assert_eq!(tracks[0].title, "Another Song");
    assert_eq!(library.search_page(0, 64, "Midnight").await.1, 0);
    f.share(&library, &[]).await;
    assert_eq!(library.search_page(0, 64, "voyage").await.1, 0);
    f.finish().await;
}

#[tokio::test]
async fn shared_library_search_paginates_the_filtered_snapshot_with_a_bounded_page() {
    let library = SharedLibrary::default();
    let songs = (0..70)
        .map(|i| super::super::online_source::OnlineSong {
            source: "ccmixter".into(),
            id: format!("page-{i}"),
            title: format!("{} {i}", if i < 67 { "Match" } else { "Other" }),
            artist: None,
            album: None,
            cover: None,
            duration_ms: None,
            track_ref: serde_json::json!({}),
        })
        .collect();
    let prepared = library.prepare_add_online(songs).await.unwrap();
    library.commit_replace(prepared).await.unwrap();
    let (revision, total, all) = library.search_page(0, usize::MAX, "match").await;
    assert_eq!((total, all.len()), (67, 64));
    let (page_revision, page_total, tail) = library.search_page(64, 64, "match").await;
    assert_eq!((page_revision, page_total, tail.len()), (revision, 67, 3));
    let joined = all
        .iter()
        .chain(&tail)
        .map(|t| t.resource_id)
        .collect::<Vec<_>>();
    assert_eq!(
        joined
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        67
    );
    let (page_revision, page_total, page) = library.search_page(2, 3, "match").await;
    assert_eq!((page_revision, page_total, page.len()), (revision, 67, 3));
    assert_eq!(
        page.iter().map(|t| t.resource_id).collect::<Vec<_>>(),
        joined[2..5]
    );
    assert!(library.search_page(67, 64, "match").await.2.is_empty());
    assert!(library
        .search_page(usize::MAX, 64, "match")
        .await
        .2
        .is_empty());
    assert_eq!(library.search_page(0, 0, "match").await.2.len(), 1);
    assert_eq!(library.search_page(0, 64, "   ").await.1, 70);
    assert_eq!(
        library.revision().await,
        revision,
        "reads do not change sharing revision"
    );
}

#[tokio::test]
async fn online_shares_mix_with_local_tracks_without_fetching_and_revoke_normally() {
    let f = Fixture::new().await;
    let local = f.track("local-before-online").await;
    let library = SharedLibrary::default();
    f.share(&library, &[&local.id]).await;
    let song = super::super::online_source::OnlineSong {
        source: "ccmixter".into(),
        id: "not-a-local-file".into(),
        title: "Shared online".into(),
        artist: Some("Artist".into()),
        album: None,
        cover: None,
        duration_ms: Some(180_000),
        track_ref: serde_json::json!({}),
    };
    let prepared = library
        .prepare_add_online(vec![song.clone(), song.clone()])
        .await
        .unwrap();
    assert_eq!(
        library.views().await.len(),
        1,
        "preparation cannot publish a share"
    );
    let views = library.commit_replace(prepared).await.unwrap();
    assert_eq!(views.len(), 2);
    let online = views
        .iter()
        .find(|view| view.title == "Shared online")
        .unwrap();
    let key = online.favorite_key.clone().unwrap();
    assert_eq!(library.local_favorite_ids().await[&key], song.virtual_id());
    assert_eq!(
        library.source(&f.state, online.resource_id).await.unwrap(),
        (song.virtual_id(), PathBuf::new()),
        "queue validation does not download or treat an online ID as a local path"
    );
    let serialized = serde_json::to_string(online).unwrap();
    assert!(
        !serialized.contains("online:")
            && !serialized.contains("path")
            && !serialized.contains("ref\"")
    );
    let before = library.revision().await;
    let mut invalid = song.clone();
    invalid.source = "unregistered".into();
    error(
        library.prepare_add_online(vec![invalid]).await,
        "room_invalid",
    );
    assert_eq!(library.revision().await, before);
    let prepared = library
        .prepare_replace(&f.state, vec![local.id, song.virtual_id()])
        .await
        .unwrap();
    library.commit_replace(prepared).await.unwrap();
    assert_eq!(
        library.resource_for(&song.virtual_id()).await,
        Some(online.resource_id)
    );
    let prepared = library.prepare_replace(&f.state, vec![]).await.unwrap();
    library.commit_replace(prepared).await.unwrap();
    error(
        library.source(&f.state, online.resource_id).await,
        "room_denied",
    );
    assert!(library.resolve_favorites(&[key]).await.unwrap().is_empty());
    f.finish().await;
}

#[tokio::test]
async fn favorites_survive_room_recreation_but_never_restore_a_revoked_capability() {
    let f = Fixture::new().await;
    f.track("private-library-track").await;
    let identity = vmusic_lan::tls::HostIdentity::generate().unwrap();
    let restored = vmusic_lan::tls::HostIdentity::from_der(
        identity.certificate_der().to_vec(),
        identity.private_key_der().to_vec(),
    )
    .unwrap();
    let first = SharedLibrary::with_reference_secret(identity.private_key_der());
    let initial = f
        .share(&first, &["private-library-track", "private-library-track"])
        .await;
    let key = initial[0].favorite_key.clone().unwrap();
    assert_eq!(
        initial.len(),
        1,
        "queue occurrences share a favorite identity"
    );
    assert_eq!(
        first.local_favorite_ids().await[&key],
        "private-library-track"
    );
    let wire = serde_json::to_string(&initial[0]).unwrap();
    assert!(!wire.contains("private-library-track"));
    assert!(!wire.contains(&f.base.to_string_lossy().to_string()));
    f.share(&first, &[]).await;
    assert!(first
        .resolve_favorites(std::slice::from_ref(&key))
        .await
        .unwrap()
        .is_empty());
    error(
        first.source(&f.state, initial[0].resource_id).await,
        "room_denied",
    );
    let reshared = f.share(&first, &["private-library-track"]).await;
    assert_eq!(reshared[0].favorite_key.as_deref(), Some(key.as_str()));
    assert_ne!(reshared[0].resource_id, initial[0].resource_id);
    let recreated = SharedLibrary::with_reference_secret(restored.private_key_der());
    let next = f.share(&recreated, &["private-library-track"]).await;
    assert_eq!(next[0].favorite_key, initial[0].favorite_key);
    assert_ne!(next[0].resource_id, initial[0].resource_id);
    let other = SharedLibrary::with_reference_secret(
        vmusic_lan::tls::HostIdentity::generate()
            .unwrap()
            .private_key_der(),
    );
    let other_view = f.share(&other, &["private-library-track"]).await;
    assert_ne!(other_view[0].favorite_key, initial[0].favorite_key);
    assert!(other.resolve_favorites(&[key]).await.unwrap().is_empty());
    assert!(first
        .resolve_favorites(&vec!["a".repeat(64); 32])
        .await
        .is_ok());
    error(
        first.resolve_favorites(&vec!["a".repeat(64); 33]).await,
        "room_invalid",
    );
    f.finish().await;
}

#[tokio::test]
async fn explicit_capabilities_are_bounded_deduplicated_and_replaced_atomically() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    f.track("local-id").await;
    let view = f.share(&library, &["local-id", "local-id"]).await;
    assert_eq!(view.len(), 1);
    let id = view[0].resource_id;
    assert_ne!(id.to_string(), "local-id");
    assert_eq!(f.share(&library, &["local-id"]).await[0].resource_id, id);
    let first = library.prepare_replace(&f.state, vec![]).await.unwrap();
    let stale = library
        .prepare_replace(&f.state, vec!["local-id".into()])
        .await
        .unwrap();
    library.commit_replace(first).await.unwrap();
    error(library.commit_replace(stale).await, "revision_conflict");
    assert!(library.views().await.is_empty());
    error(
        library
            .prepare_replace(&f.state, vec!["local-id".into(); MAX_SHARED + 1])
            .await,
        "room_invalid",
    );
    error(
        library
            .prepare_replace(&f.state, vec!["missing".into()])
            .await,
        "room_denied",
    );
    assert!(library.views().await.is_empty());
    f.finish().await;
}

#[tokio::test]
async fn shared_metadata_has_a_small_wire_bound_and_no_internal_paths() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let mut track = f.track("private-track-id").await;
    track.title = format!("\0\n{}", "🎶".repeat(200));
    track.artist = Some("x".repeat(200));
    track.album = Some("汉".repeat(200));
    vmusic_store::upsert_track(&f.state.db, &track)
        .await
        .unwrap();
    let views = f.share(&library, &[&track.id]).await;
    for text in [
        &views[0].title,
        views[0].artist.as_ref().unwrap(),
        views[0].album.as_ref().unwrap(),
    ] {
        assert!(text.len() <= 128);
        assert!(text.chars().count() <= 64);
        assert!(text.chars().all(|c| !c.is_control()));
    }
    let bytes = serde_json::to_vec(&views[0]).unwrap();
    assert!(bytes.len() < 1024);
    let json = String::from_utf8(bytes).unwrap();
    assert!(!json.contains(&track.id));
    assert!(!json.contains("audio-"));
    assert!(!json.contains("path"));
    f.finish().await;
}

#[tokio::test]
async fn source_requires_explicit_local_db_source_and_current_canonical_path() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("source-track").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    assert_eq!(
        library.source(&f.state, id).await.unwrap().1,
        tokio::fs::canonicalize(&track.path).await.unwrap()
    );
    for source in ["remote", "unknown", "Local"] {
        sqlx::query("UPDATE tracks SET source=? WHERE id=?")
            .bind(source)
            .bind(&track.id)
            .execute(&f.state.db)
            .await
            .unwrap();
        error(library.source(&f.state, id).await, "room_denied");
        error(
            library
                .prepare_replace(&f.state, vec![track.id.clone()])
                .await,
            "room_denied",
        );
    }
    sqlx::query("UPDATE tracks SET source='local' WHERE id=?")
        .bind(&track.id)
        .execute(&f.state.db)
        .await
        .unwrap();
    let replacement = f.base.join("replacement.mp3");
    tokio::fs::write(&replacement, b"another local file")
        .await
        .unwrap();
    sqlx::query("UPDATE tracks SET path=? WHERE id=?")
        .bind(replacement.to_string_lossy().as_ref())
        .bind(&track.id)
        .execute(&f.state.db)
        .await
        .unwrap();
    error(library.source(&f.state, id).await, "room_denied");
    error(
        library
            .read(&f.state, id, ResourceKind::Lyrics, 0, None)
            .await,
        "room_denied",
    );
    assert!(library.source(&f.state, Uuid::new_v4()).await.is_err());
    f.finish().await;
}

#[tokio::test]
async fn online_relative_and_directory_paths_cannot_be_shared() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    for (id, path) in [
        ("online:provider:1", None),
        ("relative", Some("relative.mp3".to_string())),
        ("url", Some("https://example.invalid/song.mp3".to_string())),
        ("directory", Some(f.base.to_string_lossy().into_owned())),
    ] {
        let track = f.track(id).await;
        if let Some(path) = path {
            sqlx::query("UPDATE tracks SET path=? WHERE id=?")
                .bind(path)
                .bind(&track.id)
                .execute(&f.state.db)
                .await
                .unwrap();
        }
        error(
            library.prepare_replace(&f.state, vec![id.into()]).await,
            "room_invalid",
        );
    }
    f.finish().await;
}

#[tokio::test]
async fn cover_pages_are_immutable_revision_bound_and_cursor_checked() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("cover-track").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    let file = f.state.cover_dir().join(format!("{}.png", track.id));
    let old: Vec<u8> = (0..CHUNK_BYTES * 2 + 17).map(|i| (i % 251) as u8).collect();
    tokio::fs::write(&file, &old).await.unwrap();
    let first = library
        .read(&f.state, id, ResourceKind::Cover, 0, None)
        .await
        .unwrap();
    assert_eq!(first.mime, "image/png");
    assert_eq!(first.total, old.len());
    assert_eq!(decoded(&first), old[..CHUNK_BYTES]);
    assert_eq!(first.revision, format!("{:x}", Sha256::digest(&old)));
    tokio::fs::write(&file, vec![9; old.len()]).await.unwrap();
    let second = library
        .read(
            &f.state,
            id,
            ResourceKind::Cover,
            CHUNK_BYTES,
            Some(first.revision.clone()),
        )
        .await
        .unwrap();
    assert_eq!(decoded(&second), old[CHUNK_BYTES..CHUNK_BYTES * 2]);
    let fresh = library
        .read(&f.state, id, ResourceKind::Cover, 0, None)
        .await
        .unwrap();
    assert_ne!(fresh.revision, first.revision);
    let tail = library
        .read(
            &f.state,
            id,
            ResourceKind::Cover,
            CHUNK_BYTES * 2,
            Some(first.revision.clone()),
        )
        .await
        .unwrap();
    assert_eq!(decoded(&tail), old[CHUNK_BYTES * 2..]);
    let eof = library
        .read(
            &f.state,
            id,
            ResourceKind::Cover,
            old.len(),
            Some(first.revision.clone()),
        )
        .await
        .unwrap();
    assert!(decoded(&eof).is_empty());
    error(
        library
            .read(
                &f.state,
                id,
                ResourceKind::Cover,
                usize::MAX,
                Some(first.revision.clone()),
            )
            .await,
        "room_invalid",
    );
    error(
        library
            .read(&f.state, id, ResourceKind::Cover, 1, None)
            .await,
        "resource_expired",
    );
    error(
        library
            .read(&f.state, id, ResourceKind::Cover, 1, Some("wrong".into()))
            .await,
        "resource_expired",
    );
    error(
        library
            .read(&f.state, id, ResourceKind::Lyrics, 1, Some(first.revision))
            .await,
        "resource_expired",
    );
    f.finish().await;
}

#[tokio::test]
async fn gif_cover_cache_uses_the_same_authorized_resource_reader() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("gif-cover").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    let gif = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b";
    tokio::fs::write(f.state.cover_dir().join(format!("{}.gif", track.id)), gif)
        .await
        .unwrap();
    let cover = library
        .read(&f.state, id, ResourceKind::Cover, 0, None)
        .await
        .unwrap();
    assert_eq!(cover.mime, "image/gif");
    assert_eq!(decoded(&cover), gif);
    f.share(&library, &[]).await;
    assert!(library
        .read(&f.state, id, ResourceKind::Cover, 0, None)
        .await
        .is_err());
    f.finish().await;
}

#[tokio::test]
async fn expired_or_revoked_snapshots_are_never_served() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("expired-cover").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    tokio::fs::write(
        f.state.cover_dir().join(format!("{}.jpg", track.id)),
        vec![7; CHUNK_BYTES + 1],
    )
    .await
    .unwrap();
    let chunk = library
        .read(&f.state, id, ResourceKind::Cover, 0, None)
        .await
        .unwrap();
    library.0.write().await.resources[0].created =
        Instant::now() - CACHE_TTL - Duration::from_secs(1);
    error(
        library
            .read(&f.state, id, ResourceKind::Cover, 1, Some(chunk.revision))
            .await,
        "resource_expired",
    );
    let chunk = library
        .read(&f.state, id, ResourceKind::Cover, 0, None)
        .await
        .unwrap();
    f.share(&library, &[&track.id]).await;
    assert!(library.0.read().await.resources.is_empty());
    error(
        library
            .read(
                &f.state,
                id,
                ResourceKind::Cover,
                1,
                Some(chunk.revision.clone()),
            )
            .await,
        "resource_expired",
    );
    f.share(&library, &[]).await;
    error(
        library
            .read(&f.state, id, ResourceKind::Cover, 1, Some(chunk.revision))
            .await,
        "room_denied",
    );
    f.finish().await;
}

#[tokio::test]
async fn cached_pages_recheck_db_source_and_file_identity() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("cached-source").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    tokio::fs::write(
        f.state.cover_dir().join(format!("{}.jpg", track.id)),
        vec![7; CHUNK_BYTES + 1],
    )
    .await
    .unwrap();
    let chunk = library
        .read(&f.state, id, ResourceKind::Cover, 0, None)
        .await
        .unwrap();
    sqlx::query("UPDATE tracks SET source='remote' WHERE id=?")
        .bind(&track.id)
        .execute(&f.state.db)
        .await
        .unwrap();
    error(
        library
            .read(
                &f.state,
                id,
                ResourceKind::Cover,
                1,
                Some(chunk.revision.clone()),
            )
            .await,
        "room_denied",
    );
    sqlx::query("UPDATE tracks SET source='local' WHERE id=?")
        .bind(&track.id)
        .execute(&f.state.db)
        .await
        .unwrap();
    tokio::fs::remove_file(&track.path).await.unwrap();
    assert!(library
        .read(&f.state, id, ResourceKind::Cover, 1, Some(chunk.revision))
        .await
        .is_err());
    f.finish().await;
}

#[tokio::test]
async fn cover_cache_bounds_both_entry_count_and_total_bytes() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let mut ids = Vec::new();
    for n in 0..10 {
        let id = format!("cache-{n}");
        f.track(&id).await;
        tokio::fs::write(
            f.state.cover_dir().join(format!("{id}.jpg")),
            vec![n as u8; 64],
        )
        .await
        .unwrap();
        ids.push(id);
    }
    let refs: Vec<_> = ids.iter().map(String::as_str).collect();
    f.share(&library, &refs).await;
    for id in &ids {
        let resource = library.resource_for(id).await.unwrap();
        library
            .read(&f.state, resource, ResourceKind::Cover, 0, None)
            .await
            .unwrap();
    }
    assert_eq!(library.0.read().await.resources.len(), CACHE_ENTRIES);
    for (n, id) in ids.iter().take(5).enumerate() {
        tokio::fs::write(
            f.state.cover_dir().join(format!("{id}.jpg")),
            vec![n as u8; MAX_RESOURCE_BYTES],
        )
        .await
        .unwrap();
        let resource = library.resource_for(id).await.unwrap();
        library
            .read(&f.state, resource, ResourceKind::Cover, 0, None)
            .await
            .unwrap();
    }
    let cache = library.0.read().await;
    assert!(cache.resources.len() <= CACHE_ENTRIES);
    assert!(cache.resources.iter().map(|r| r.bytes.len()).sum::<usize>() <= CACHE_BYTES);
    assert_eq!(cache.resources.len(), 4);
    drop(cache);
    f.finish().await;
}

#[tokio::test]
async fn oversized_or_non_file_covers_and_unsafe_cache_keys_are_rejected() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("oversized-cover").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    let file = f.state.cover_dir().join(format!("{}.jpg", track.id));
    tokio::fs::write(&file, vec![0; MAX_RESOURCE_BYTES + 1])
        .await
        .unwrap();
    error(
        library
            .read(&f.state, id, ResourceKind::Cover, 0, None)
            .await,
        "room_invalid",
    );
    assert!(library.0.read().await.resources.is_empty());
    tokio::fs::remove_file(&file).await.unwrap();
    tokio::fs::create_dir(&file).await.unwrap();
    error(
        library
            .read(&f.state, id, ResourceKind::Cover, 0, None)
            .await,
        "room_denied",
    );
    f.track("../escape").await;
    let id = f.share(&library, &["../escape"]).await[0].resource_id;
    error(
        library
            .read(&f.state, id, ResourceKind::Cover, 0, None)
            .await,
        "room_denied",
    );
    f.finish().await;
}

#[tokio::test]
async fn saved_lyric_byte_limit_is_distinct_from_missing_or_empty_rows() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("lyric-track").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    tokio::fs::write(
        Path::new(&track.path).with_extension("lrc"),
        b"[00:01.00]sidecar",
    )
    .await
    .unwrap();
    let chunk = library
        .read(&f.state, id, ResourceKind::Lyrics, 0, None)
        .await
        .unwrap();
    let doc: vmusic_core::LyricDocument = serde_json::from_slice(&decoded(&chunk)).unwrap();
    assert_eq!(doc.lines[0].text, "sidecar");
    let oversized = "汉".repeat(MAX_RESOURCE_BYTES / 3 + 1);
    assert!(oversized.len() > MAX_RESOURCE_BYTES);
    assert!(oversized.chars().count() < MAX_RESOURCE_BYTES);
    vmusic_store::lyrics::import(&f.state.db, &track.id, &oversized)
        .await
        .unwrap();
    error(
        library
            .read(&f.state, id, ResourceKind::Lyrics, 0, None)
            .await,
        "room_invalid",
    );
    vmusic_store::lyrics::import(&f.state.db, &track.id, "")
        .await
        .unwrap();
    vmusic_store::lyrics::set_offset(&f.state.db, &track.id, 250)
        .await
        .unwrap();
    let chunk = library
        .read(&f.state, id, ResourceKind::Lyrics, 0, None)
        .await
        .unwrap();
    let doc: vmusic_core::LyricDocument = serde_json::from_slice(&decoded(&chunk)).unwrap();
    assert_eq!(doc.lines[0].start_ms, 1250);
    vmusic_store::lyrics::import(&f.state.db, &track.id, "[00:02.00]saved")
        .await
        .unwrap();
    let chunk = library
        .read(&f.state, id, ResourceKind::Lyrics, 0, None)
        .await
        .unwrap();
    let doc: vmusic_core::LyricDocument = serde_json::from_slice(&decoded(&chunk)).unwrap();
    assert_eq!(doc.lines[0].text, "saved");
    f.finish().await;
}

#[tokio::test]
async fn sidecar_reads_bound_bytes_and_require_utf8() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("sidecar-limit").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    let sidecar = Path::new(&track.path).with_extension("lrc");
    tokio::fs::write(&sidecar, vec![b'x'; MAX_RESOURCE_BYTES + 1])
        .await
        .unwrap();
    error(
        library
            .read(&f.state, id, ResourceKind::Lyrics, 0, None)
            .await,
        "room_invalid",
    );
    tokio::fs::write(&sidecar, [255, 254, 255]).await.unwrap();
    error(
        library
            .read(&f.state, id, ResourceKind::Lyrics, 0, None)
            .await,
        "room_invalid",
    );
    f.finish().await;
}

#[tokio::test]
async fn revoking_sharing_during_resource_io_denies_the_pending_read() {
    let gate = Arc::new(ReadGate::new());
    let f = Fixture::with_gate(Some(gate.clone())).await;
    let library = SharedLibrary::default();
    let track = f.track("revoked-in-flight").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    vmusic_store::lyrics::import(&f.state.db, &track.id, "[00:01]private")
        .await
        .unwrap();
    gate.armed.store(true, Ordering::SeqCst);
    let state = f.state.clone();
    let pending_library = library.clone();
    let pending = tokio::spawn(async move {
        pending_library
            .read(&state, id, ResourceKind::Lyrics, 0, None)
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), gate.blocked.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    // Source was authorized; the saved-lyric query is now paused in SQLx.
    f.share(&library, &[]).await;
    gate.release.add_permits(1);
    error(pending.await.unwrap(), "room_denied");
    assert!(library.0.read().await.resources.is_empty());
    f.finish().await;
}

fn saved_document() -> serde_json::Value {
    let mut doc = vmusic_lyrics::parse_import("[00:01]saved", "lrc").unwrap();
    doc.origin = Some(vmusic_core::LyricOrigin {
        provider: "fixture".into(),
        label: "Fixture".into(),
        ref_id: "one".into(),
        license_status: "not_provided".into(),
    });
    serde_json::json!({"version":1,"kind":"hertz-provider-lyrics","document":doc})
}

#[tokio::test]
async fn malformed_or_over_limit_saved_lrc_json_and_xml_return_typed_errors() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("checked-saved").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    let mut json_lines = saved_document();
    json_lines["document"]["lines"] = serde_json::json!(vec![
        json_lines["document"]["lines"][0]
            .clone();
        vmusic_lyrics::MAX_LINES + 1
    ]);
    let mut json_text = saved_document();
    json_text["document"]["lines"][0]["text"] =
        serde_json::json!("x".repeat(vmusic_lyrics::MAX_BYTES * 2 + 1));
    let mut json_invalid = saved_document();
    json_invalid["document"]["origin"]["licenseStatus"] = serde_json::json!("unverified");
    let xml_lines = format!(
        "<tt xmlns=\"http://www.w3.org/ns/ttml\"><body><div>{}</div></body></tt>",
        (0..=vmusic_lyrics::MAX_LINES)
            .map(|n| format!("<p begin=\"{n}s\" end=\"{}s\">line</p>", n + 1))
            .collect::<String>()
    );
    let cases = [
        (
            "[00:01]valid\nunparseable line".to_string(),
            "lyrics_invalid",
        ),
        (format!("[00:01]{}", "x".repeat(300 * 1024)), "lyrics_limit"),
        (
            "[00:01]line\n".repeat(vmusic_lyrics::MAX_LINES + 1),
            "lyrics_limit",
        ),
        ("{\"version\":".to_string(), "lyrics_invalid"),
        (json_invalid.to_string(), "lyrics_invalid"),
        (json_lines.to_string(), "lyrics_limit"),
        (json_text.to_string(), "lyrics_limit"),
        ("<tt><body>".to_string(), "lyrics_invalid"),
        (
            format!("<tt>{}</tt>", "x".repeat(300 * 1024)),
            "lyrics_limit",
        ),
        (xml_lines, "lyrics_limit"),
    ];
    for (index, (content, code)) in cases.into_iter().enumerate() {
        assert!(
            content.len() < MAX_RESOURCE_BYTES,
            "exercise parser bounds below the transport limit"
        );
        vmusic_store::lyrics::import(&f.state.db, &track.id, &content)
            .await
            .unwrap();
        match library
            .read(&f.state, id, ResourceKind::Lyrics, 0, None)
            .await
        {
            Err(error) => assert_eq!(error.code, code, "saved lyric fixture {index}"),
            Ok(_) => panic!("saved lyric fixture {index} must fail with {code}"),
        }
        assert!(library.0.read().await.resources.is_empty());
    }
    // Checked reads accept the existing structured envelope and TTML subset.
    for content in [format!("\u{feff}{}",saved_document()),"<tt xmlns=\"http://www.w3.org/ns/ttml\"><body><div><p begin=\"1s\" end=\"2s\">xml</p></div></body></tt>".into()]{
        vmusic_store::lyrics::import(&f.state.db,&track.id,&content).await.unwrap();
        let chunk=library.read(&f.state,id,ResourceKind::Lyrics,0,None).await.unwrap();
        let doc:vmusic_core::LyricDocument=serde_json::from_slice(&decoded(&chunk)).unwrap();assert_eq!(doc.lines.len(),1);
    }
    f.finish().await;
}

fn flac_lyric_fixture(lyrics: Option<&str>) -> Vec<u8> {
    let mut bytes = b"fLaC".to_vec();
    bytes.extend([if lyrics.is_some() { 0 } else { 0x80 }, 0, 0, 34]);
    bytes.extend([0; 34]);
    if let Some(lyrics) = lyrics {
        let entry = format!("LYRICS={lyrics}");
        let mut comments = 0u32.to_le_bytes().to_vec();
        comments.extend(1u32.to_le_bytes());
        comments.extend((entry.len() as u32).to_le_bytes());
        comments.extend(entry.as_bytes());
        bytes.push(0x84);
        bytes.extend(&(comments.len() as u32).to_be_bytes()[1..]);
        bytes.extend(comments);
    }
    bytes
}

#[tokio::test]
async fn metadata_failures_require_a_usable_sidecar_and_absence_stays_empty() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("metadata-result").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    let sidecar = Path::new(&track.path).with_extension("lrc");
    error(
        library
            .read(&f.state, id, ResourceKind::Lyrics, 0, None)
            .await,
        "resource_metadata_invalid",
    );
    tokio::fs::write(&sidecar, b" \n\t").await.unwrap();
    error(
        library
            .read(&f.state, id, ResourceKind::Lyrics, 0, None)
            .await,
        "resource_metadata_invalid",
    );
    assert!(library.0.read().await.resources.is_empty());
    tokio::fs::write(&sidecar, b"[00:01]safe fallback")
        .await
        .unwrap();
    let chunk = library
        .read(&f.state, id, ResourceKind::Lyrics, 0, None)
        .await
        .unwrap();
    let doc: vmusic_core::LyricDocument = serde_json::from_slice(&decoded(&chunk)).unwrap();
    assert_eq!(doc.lines[0].text, "safe fallback");
    tokio::fs::write(&sidecar, b"invalid sidecar")
        .await
        .unwrap();
    error(
        library
            .read(&f.state, id, ResourceKind::Lyrics, 0, None)
            .await,
        "lyrics_invalid",
    );
    tokio::fs::write(&sidecar, format!("[00:01]{}", "x".repeat(300 * 1024)))
        .await
        .unwrap();
    error(
        library
            .read(&f.state, id, ResourceKind::Lyrics, 0, None)
            .await,
        "lyrics_limit",
    );
    tokio::fs::write(&track.path, flac_lyric_fixture(None))
        .await
        .unwrap();
    tokio::fs::write(&sidecar, b" \n").await.unwrap();
    let chunk = library
        .read(&f.state, id, ResourceKind::Lyrics, 0, None)
        .await
        .unwrap();
    let doc: vmusic_core::LyricDocument = serde_json::from_slice(&decoded(&chunk)).unwrap();
    assert!(doc.lines.is_empty());
    f.finish().await;
}

#[tokio::test]
async fn malformed_or_over_limit_embedded_lyrics_can_recover_through_a_checked_sidecar() {
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    let track = f.track("checked-embedded").await;
    let id = f.share(&library, &[&track.id]).await[0].resource_id;
    let sidecar = Path::new(&track.path).with_extension("lrc");
    for (content, code) in [
        ("[00:01]valid\ninvalid line".to_string(), "lyrics_invalid"),
        (format!("[00:01]{}", "x".repeat(300 * 1024)), "lyrics_limit"),
    ] {
        tokio::fs::write(&track.path, flac_lyric_fixture(Some(&content)))
            .await
            .unwrap();
        error(
            library
                .read(&f.state, id, ResourceKind::Lyrics, 0, None)
                .await,
            code,
        );
        tokio::fs::write(&sidecar, b"[00:02]recovered")
            .await
            .unwrap();
        let chunk = library
            .read(&f.state, id, ResourceKind::Lyrics, 0, None)
            .await
            .unwrap();
        let doc: vmusic_core::LyricDocument = serde_json::from_slice(&decoded(&chunk)).unwrap();
        assert_eq!(doc.lines[0].text, "recovered");
        tokio::fs::remove_file(&sidecar).await.unwrap();
    }
    f.finish().await;
}

#[tokio::test]
async fn structured_song_chat_is_durable_deduplicated_and_scrubs_revoked_resources() {
    use crate::room::chat::{ChatAccess, ChatRequest, ChatService};
    let f = Fixture::new().await;
    let library = SharedLibrary::default();
    f.track("song-card").await;
    let resource = f.share(&library, &["song-card"]).await[0].resource_id;
    let room = Uuid::new_v4();
    let events = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
    let sink = events.clone();
    let access = || ChatAccess {
        member: Uuid::nil(),
        name: "Host".into(),
        active: Arc::new(|| true),
        read: Arc::new(|| true),
        send: Arc::new(|| true),
    };
    let chat = ChatService::open_with_library(
        &f.base,
        room,
        Arc::new(move |v| sink.lock().unwrap().push(v)),
        library.clone(),
    )
    .await
    .unwrap();
    let receipt = chat
        .request(
            access(),
            ChatRequest::Song {
                operation: 1,
                resource_id: resource,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        chat.request(
            access(),
            ChatRequest::Song {
                operation: 1,
                resource_id: resource
            }
        )
        .await
        .unwrap(),
        receipt
    );
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["topic"] == "chat_message")
            .count(),
        1
    );
    let history = chat
        .request(
            access(),
            ChatRequest::History {
                before: None,
                revision: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(history["messages"][0]["content_kind"], "song");
    assert_eq!(
        history["messages"][0]["song"]["resource_id"],
        resource.to_string()
    );
    assert!(history["messages"][0].get("song_resource_id").is_none());
    assert!(!serde_json::to_string(&history)
        .unwrap()
        .contains(&f.base.to_string_lossy().replace("\\", "\\\\")));
    let conflict = chat
        .request(
            access(),
            ChatRequest::Send {
                operation: 1,
                text: "分享歌曲".into(),
                track: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(conflict.code, "operation_key_conflict");
    let invalid = chat
        .request(
            access(),
            ChatRequest::Song {
                operation: 2,
                resource_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(invalid.code, "room_invalid");
    chat.shutdown().await;
    let restarted =
        ChatService::open_with_library(&f.base, room, Arc::new(|_| {}), library.clone())
            .await
            .unwrap();
    let history = restarted
        .request(
            access(),
            ChatRequest::History {
                before: None,
                revision: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(history["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        history["messages"][0]["song"]["resource_id"],
        resource.to_string()
    );
    f.share(&library, &[]).await;
    let scrubbed = restarted
        .request(
            access(),
            ChatRequest::History {
                before: None,
                revision: None,
            },
        )
        .await
        .unwrap();
    assert!(scrubbed["messages"][0]["song"].is_null());
    assert_eq!(scrubbed["messages"][0]["content_kind"], "song");
    assert!(!serde_json::to_string(&scrubbed)
        .unwrap()
        .contains(&resource.to_string()));
    restarted.shutdown().await;
    f.finish().await;
}

#[test]
fn netease_room_cover_requests_a_bounded_variant() {
    assert_eq!(
        room_cover_url("https://p1.music.126.net/abc.jpg"),
        "https://p1.music.126.net/abc.jpg?param=600y600"
    );
    assert_eq!(
        room_cover_url("https://p1.music.126.net/abc.jpg?imageView=1"),
        "https://p1.music.126.net/abc.jpg?imageView=1"
    );
    assert_eq!(
        room_cover_url("https://img2.kuwo.cn/star/albumcover/500/a.jpg"),
        "https://img2.kuwo.cn/star/albumcover/500/a.jpg"
    );
}
