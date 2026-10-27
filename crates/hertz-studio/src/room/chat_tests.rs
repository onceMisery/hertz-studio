// SPDX-License-Identifier: MIT
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

struct Profile(PathBuf);
impl Profile {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("hertz-chat-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn access(member: Uuid) -> ChatAccess {
    ChatAccess {
        member,
        name: "测试成员".into(),
        read: Arc::new(|| true),
        send: Arc::new(|| true),
        active: Arc::new(|| true),
    }
}
fn owner() -> ChatAccess {
    access(Uuid::nil())
}

async fn store(profile: &Profile, room: Uuid) -> (Store, Arc<Mutex<Vec<Value>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let event_sink = events.clone();
    let notify: Arc<dyn Fn(Value) + Send + Sync> =
        Arc::new(move |event| event_sink.lock().unwrap().push(event));
    let path = profile.0.join("room-chat.sqlite");
    let mut lock = fslock::LockFile::open(&profile.0.join("room-chat.lock")).unwrap();
    assert!(lock.try_lock().unwrap());
    let mut connection = SqliteConnection::connect_with(
        &options(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Delete)
            .synchronous(SqliteSynchronous::Full)
            .page_size(PAGE as u32)
            .auto_vacuum(SqliteAutoVacuum::Incremental),
    )
    .await
    .unwrap();
    Store::create(&mut connection).await.unwrap();
    let (config, revision, next_id) = Store::inspect(&mut connection, &path).await.unwrap();
    let (status, _) = watch::channel(ChatStatus {
        available: true,
        history_revision: revision.to_string(),
        config: config.clone(),
        disk_bytes: 0,
        messages: 0,
        error: None,
        maintenance: None,
    });
    let mut store = Store {
        library: Default::default(),
        connection,
        path,
        room,
        config,
        revision,
        next_id,
        receipts: VecDeque::new(),
        identities: HashMap::new(),
        room_rate: Bucket::new(10.0),
        recent: VecDeque::new(),
        recent_bytes: 0,
        notify,
        status,
        maintenance: None,
        _lock: lock,
    };
    store.set_limit(store.config.pages()).await.unwrap();
    (store, events)
}

async fn send(
    store: &mut Store,
    member: ChatAccess,
    operation: u64,
    text: &str,
) -> RoomResult<Value> {
    store
        .execute(
            member,
            ChatRequest::Send {
                operation,
                text: text.into(),
                track: Some(42),
            },
        )
        .await
}

fn refill(store: &mut Store) {
    store.room_rate.credit = 10.0;
    for identity in store.identities.values_mut() {
        identity.rate.credit = 3.0;
    }
}

fn freeze_rate_clock(store: &mut Store) {
    // Filesystem flushes can take longer than a 100 ms room token interval.
    // Isolate burst accounting from wall-clock I/O latency in this test.
    let future = Instant::now() + Duration::from_secs(60);
    store.room_rate.at = future;
    for identity in store.identities.values_mut() {
        identity.rate.at = future;
    }
}

async fn count(store: &mut Store) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM messages")
        .fetch_one(&mut store.connection)
        .await
        .unwrap()
}

async fn seed(store: &mut Store, rows: i64, room: Uuid, received: i64, text: &str) {
    let first = store.next_id;
    let mut tx = store.connection.begin().await.unwrap();
    sqlx::query("WITH RECURSIVE seq(n) AS (SELECT ? UNION ALL SELECT n+1 FROM seq WHERE n<?) \
        INSERT INTO messages(id,room,member,name,text,received,track) SELECT n,?,?,?, ?,?,NULL FROM seq")
        .bind(first as i64).bind(first as i64 + rows - 1).bind(room.to_string())
        .bind(Uuid::nil().to_string()).bind("fixture").bind(text).bind(received)
        .execute(&mut *tx).await.unwrap();
    let next = first + rows as u64;
    sqlx::query("UPDATE settings SET next_id=?")
        .bind(next as i64)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    store.next_id = next;
}

async fn fill_mixed_history(store: &mut Store, oldest_is_cached: bool) {
    store.config.max_messages = 100;
    store.config.retained = false;
    if oldest_is_cached {
        send(store, owner(), 1, "live").await.unwrap();
    }
    let room = store.room;
    seed(store, 99, room, now_ms(), "saved").await;
    if !oldest_is_cached {
        send(store, owner(), 1, "live").await.unwrap();
    }
    store.config.retained = true;
    assert_eq!(count(store).await, 99);
    assert_eq!(store.recent.len(), 1);
}

#[tokio::test]
async fn durable_profile_history_and_ids_survive_restart_clear_and_realtime() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let service = ChatService::open(
        &profile.0,
        room,
        Arc::new(move |v| sink.lock().unwrap().push(v)),
    )
    .await
    .unwrap();
    let first = service
        .request(
            owner(),
            ChatRequest::Send {
                operation: 1,
                text: "durable".into(),
                track: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(first["message_id"], "1");
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|v| v["topic"] == "chat_message"));
    let mut reader = SqliteConnection::connect_with(
        &options(&profile.0.join("room-chat.sqlite")).read_only(true),
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT text FROM messages WHERE id=1")
            .fetch_one(&mut reader)
            .await
            .unwrap(),
        "durable"
    );
    reader.close().await.unwrap();
    service.shutdown().await;
    let restarted = ChatService::open(&profile.0, room, Arc::new(|_| {}))
        .await
        .unwrap();
    let history = restarted
        .request(
            owner(),
            ChatRequest::History {
                before: None,
                revision: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(history["messages"][0]["text"], "durable");
    restarted
        .request(
            owner(),
            ChatRequest::Admin(ChatAdmin::Clear {
                room_id: room,
                confirmed: true,
            }),
        )
        .await
        .unwrap();
    let revision = restarted.status.borrow().history_revision.clone();
    let config = ChatConfig {
        retained: false,
        ..ChatConfig::default()
    };
    restarted
        .request(
            owner(),
            ChatRequest::Admin(ChatAdmin::Configure {
                config,
                expected_revision: revision,
                confirmed: true,
            }),
        )
        .await
        .unwrap();
    let second = restarted
        .request(
            owner(),
            ChatRequest::Send {
                operation: 1,
                text: "volatile".into(),
                track: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(second["message_id"], "2");
    restarted.shutdown().await;
    let final_room = ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {}))
        .await
        .unwrap();
    let third = final_room
        .request(
            owner(),
            ChatRequest::Send {
                operation: 1,
                text: "next".into(),
                track: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(third["message_id"], "3");
    final_room.shutdown().await;
}

#[tokio::test]
async fn one_profile_writer_and_explicit_shutdown_release_lease() {
    let profile = Profile::new();
    let service = ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {}))
        .await
        .unwrap();
    let failed = ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {})).await;
    assert_eq!(failed.err().unwrap().code, "chat_storage_busy");
    service.shutdown().await;
    let second = ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {}))
        .await
        .unwrap();
    second.shutdown().await;
}

#[tokio::test]
async fn count_and_age_retention_apply_globally_across_rooms() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let (mut store, _) = store(&profile, room).await;
    seed(
        &mut store,
        30,
        Uuid::new_v4(),
        now_ms() - 8 * 86_400_000,
        "expired",
    )
    .await;
    seed(&mut store, 130, Uuid::new_v4(), now_ms(), "other room").await;
    store.config.max_messages = 100;
    let initial = store.revision;
    assert_eq!(store.cleanup(0).await.unwrap(), 60);
    assert_eq!(count(&mut store).await, 100);
    assert_eq!(store.revision, initial + 1);
    send(&mut store, owner(), 1, "new current room")
        .await
        .unwrap();
    assert_eq!(count(&mut store).await, 100);
    let oldest: i64 = sqlx::query_scalar("SELECT MIN(id) FROM messages")
        .fetch_one(&mut store.connection)
        .await
        .unwrap();
    assert_eq!(oldest, 62);
}

#[tokio::test]
async fn history_pages_fit_wire_budget_without_duplicates_or_gaps() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let (mut store, _) = store(&profile, room).await;
    seed(&mut store, 160, room, now_ms(), &"😀".repeat(200)).await;
    let mut before = None;
    let mut all = Vec::new();
    let mut pages = 0;
    loop {
        let value = store
            .history(Uuid::nil(), before, Some(store.revision))
            .await
            .unwrap();
        assert!(serde_json::to_vec(&value).unwrap().len() <= HISTORY_BYTES);
        let messages = value["messages"].as_array().unwrap();
        assert!(messages.len() <= 100);
        assert_eq!(value["next_operation_id"], "1");
        all.extend(
            messages
                .iter()
                .map(|m| m["message_id"].as_str().unwrap().parse::<u64>().unwrap()),
        );
        pages += 1;
        if !value["has_more"].as_bool().unwrap() {
            break;
        }
        before = Some(value["next_before"].as_str().unwrap().parse().unwrap());
    }
    assert!(pages >= 4);
    all.sort_unstable();
    assert_eq!(all, (1..=160).collect::<Vec<_>>());
}

#[tokio::test]
async fn only_realtime_history_is_bounded_and_delete_clear_invalidate_cursors() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let (mut store, _) = store(&profile, room).await;
    store.config.retained = false;
    for seq in 1..=205 {
        refill(&mut store);
        send(&mut store, owner(), seq, "live").await.unwrap();
    }
    assert_eq!(store.recent.len(), 200);
    assert!(store.recent_bytes <= RECENT_BYTES);
    assert_eq!(count(&mut store).await, 0);
    let current = store.revision;
    let page = store.history(Uuid::nil(), None, None).await.unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 100);
    assert_eq!(page["next_operation_id"], "206");
    assert_eq!(page["messages"][99]["retained"], false);
    let deletion = store
        .admin(ChatAdmin::Delete {
            message_id: "205".into(),
        })
        .await
        .unwrap();
    assert_eq!(deletion["deleted"], 1);
    assert_eq!(
        store
            .history(Uuid::nil(), None, Some(current))
            .await
            .unwrap()["cursor_invalidated"],
        true
    );
    let clear = store
        .admin(ChatAdmin::Clear {
            room_id: room,
            confirmed: true,
        })
        .await
        .unwrap();
    assert_eq!(clear["deleted"], 199);
    assert!(store.recent.is_empty());
    assert!(
        store.history(Uuid::nil(), None, None).await.unwrap()["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn retention_evicts_globally_oldest_across_realtime_and_durable_modes() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let (mut store, _) = store(&profile, room).await;
    store.config.max_messages = 100;
    store.config.retained = false;
    for operation in 1..=100 {
        refill(&mut store);
        send(&mut store, owner(), operation, "older realtime")
            .await
            .unwrap();
    }
    store.config.retained = true;
    for operation in 101..=110 {
        refill(&mut store);
        send(&mut store, owner(), operation, "newer durable")
            .await
            .unwrap();
    }
    assert_eq!(count(&mut store).await, 10);
    assert_eq!(store.recent.len(), 90);
    let page = store.history(Uuid::nil(), None, None).await.unwrap();
    let ids: Vec<_> = page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["message_id"].as_str().unwrap().parse::<u64>().unwrap())
        .collect();
    assert_eq!(ids, (11..=110).collect::<Vec<_>>());
    // Exercise the reverse ordering too: newer realtime must evict older DB rows.
    store.config.retained = false;
    for operation in 111..=210 {
        refill(&mut store);
        send(&mut store, owner(), operation, "newest realtime")
            .await
            .unwrap();
    }
    assert_eq!(count(&mut store).await, 0);
    assert_eq!(store.recent.front().unwrap().id(), 111);
    assert_eq!(store.recent.back().unwrap().id(), 210);
    assert_eq!(store.recent.len(), 100);
}

#[tokio::test]
async fn deletion_and_revision_rollback_together_and_preserve_cache() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let (mut store, events) = store(&profile, room).await;
    send(&mut store, owner(), 1, "saved").await.unwrap();
    store.config.retained = false;
    send(&mut store, owner(), 2, "live").await.unwrap();
    let revision = store.revision;
    let before = events.lock().unwrap().len();
    sqlx::query("CREATE TRIGGER fail_revision BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'test revision failure'); END")
        .execute(&mut store.connection).await.unwrap();
    assert!(store
        .admin(ChatAdmin::Clear {
            room_id: room,
            confirmed: true
        })
        .await
        .is_err());
    assert_eq!(count(&mut store).await, 1);
    assert_eq!(store.recent.len(), 1);
    assert_eq!(store.revision, revision);
    assert_eq!(events.lock().unwrap().len(), before);
    let persisted: i64 = sqlx::query_scalar("SELECT revision FROM settings")
        .fetch_one(&mut store.connection)
        .await
        .unwrap();
    assert_eq!(persisted as u64, revision);
}

#[tokio::test]
async fn failed_insert_never_advances_sequence_or_notifies() {
    let profile = Profile::new();
    let (mut store, events) = store(&profile, Uuid::new_v4()).await;
    sqlx::query("CREATE TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'test insert failure'); END")
        .execute(&mut store.connection).await.unwrap();
    assert_eq!(
        send(&mut store, owner(), 1, "rejected")
            .await
            .unwrap_err()
            .code,
        "chat_storage_failed"
    );
    assert_eq!(store.next_id, 1);
    assert_eq!(store.identities[&Uuid::nil()].highwater, 0);
    assert!(store.receipts.is_empty());
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(count(&mut store).await, 0);
}

#[tokio::test]
async fn failed_insert_at_full_history_preserves_oldest_durable_or_cached_message() {
    for oldest_is_cached in [false, true] {
        let profile = Profile::new();
        let (mut store, events) = store(&profile, Uuid::new_v4()).await;
        fill_mixed_history(&mut store, oldest_is_cached).await;
        let before = store.history(Uuid::nil(), None, None).await.unwrap();
        let event_count = events.lock().unwrap().len();
        let revision = store.revision;
        let recent_bytes = store.recent_bytes;
        sqlx::query("CREATE TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'test insert failure'); END")
            .execute(&mut store.connection).await.unwrap();
        assert_eq!(
            send(&mut store, owner(), 2, "refused")
                .await
                .unwrap_err()
                .code,
            "chat_storage_failed"
        );
        assert_eq!(
            store.history(Uuid::nil(), None, None).await.unwrap(),
            before
        );
        assert_eq!(count(&mut store).await, 99);
        assert_eq!(store.recent.len(), 1);
        assert_eq!(store.recent_bytes, recent_bytes);
        assert_eq!(store.next_id, 101);
        assert_eq!(store.revision, revision);
        assert_eq!(store.identities[&Uuid::nil()].highwater, 1);
        assert_eq!(store.receipts.len(), 1);
        assert_eq!(events.lock().unwrap().len(), event_count);
        let persisted: (i64, i64) = sqlx::query_as("SELECT revision,next_id FROM settings")
            .fetch_one(&mut store.connection)
            .await
            .unwrap();
        assert_eq!(persisted, (revision as i64, 101));

        sqlx::query("DROP TRIGGER fail_insert")
            .execute(&mut store.connection)
            .await
            .unwrap();
        refill(&mut store);
        let sent = send(&mut store, owner(), 2, "accepted").await.unwrap();
        assert_eq!(sent["message_id"], "101");
        let page = store.history(Uuid::nil(), None, None).await.unwrap();
        assert_eq!(page["messages"].as_array().unwrap().len(), 100);
        assert_eq!(page["messages"][0]["message_id"], "2");
        assert_eq!(store.revision, revision + 1);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), event_count + 2);
        assert_eq!(events[event_count]["deleted"], 1);
        assert_eq!(
            events[event_count]["history_revision"],
            (revision + 1).to_string()
        );
        assert_eq!(events[event_count + 1]["topic"], "chat_message");
    }
}

#[tokio::test]
async fn rate_limits_member_burst_and_room_burst_without_spending_room_on_rejection() {
    let profile = Profile::new();
    let (mut store, _) = store(&profile, Uuid::new_v4()).await;
    for seq in 1..=3 {
        freeze_rate_clock(&mut store);
        send(&mut store, owner(), seq, "burst").await.unwrap();
    }
    let room_credit = store.room_rate.credit;
    freeze_rate_clock(&mut store);
    assert_eq!(
        send(&mut store, owner(), 4, "burst")
            .await
            .unwrap_err()
            .code,
        "chat_rate_limited"
    );
    assert_eq!(store.room_rate.credit, room_credit);
    for _ in 0..7 {
        freeze_rate_clock(&mut store);
        send(&mut store, access(Uuid::new_v4()), 1, "room burst")
            .await
            .unwrap();
    }
    freeze_rate_clock(&mut store);
    assert_eq!(
        send(&mut store, access(Uuid::new_v4()), 1, "over")
            .await
            .unwrap_err()
            .code,
        "chat_rate_limited"
    );
    store.room_rate.at = Instant::now() - Duration::from_secs(1);
    store.identities.get_mut(&Uuid::nil()).unwrap().rate.at =
        Instant::now() - Duration::from_secs(1);
    send(&mut store, owner(), 4, "refilled").await.unwrap();
}

#[tokio::test]
async fn receipts_expire_but_live_highwater_never_resets_and_members_can_turn_over() {
    let profile = Profile::new();
    let (mut store, _) = store(&profile, Uuid::new_v4()).await;
    let first = send(&mut store, owner(), 8, "once").await.unwrap();
    assert_eq!(send(&mut store, owner(), 8, "once").await.unwrap(), first);
    assert_eq!(
        send(&mut store, owner(), 8, "different")
            .await
            .unwrap_err()
            .code,
        "operation_key_conflict"
    );
    store.receipts.front_mut().unwrap().at = Instant::now() - RECEIPT_TTL - Duration::from_secs(1);
    assert_eq!(
        send(&mut store, owner(), 8, "once").await.unwrap_err().code,
        "operation_unknown"
    );
    assert_eq!(store.next_operation(Uuid::nil()).unwrap(), "9");
    for _ in 0..40 {
        let active = Arc::new(AtomicBool::new(true));
        let alive = active.clone();
        let mut member = access(Uuid::new_v4());
        member.active = Arc::new(move || alive.load(Ordering::Acquire));
        refill(&mut store);
        send(&mut store, member, 1, "new member").await.unwrap();
        active.store(false, Ordering::Release);
    }
    store.evict_receipts();
    assert_eq!(store.identities.len(), 1);
    assert_eq!(store.identities[&Uuid::nil()].highwater, 8);
    for seq in 9..=280 {
        refill(&mut store);
        send(&mut store, owner(), seq, "bounded receipts")
            .await
            .unwrap();
    }
    assert_eq!(store.receipts.len(), RECEIPTS);
    assert_eq!(store.next_operation(Uuid::nil()).unwrap(), "281");
}

#[tokio::test]
async fn revoked_permission_at_commit_rolls_back_message() {
    let profile = Profile::new();
    let (mut store, _) = store(&profile, Uuid::new_v4()).await;
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let check = calls.clone();
    let mut member = owner();
    member.send = Arc::new(move || check.fetch_add(1, Ordering::AcqRel) == 0);
    assert_eq!(
        send(&mut store, member, 1, "revoked")
            .await
            .unwrap_err()
            .code,
        "room_denied"
    );
    assert_eq!(count(&mut store).await, 0);
    assert_eq!(store.next_id, 1);
}

#[tokio::test]
async fn permission_denial_at_full_history_rolls_back_durable_and_cache_retention() {
    for oldest_is_cached in [false, true] {
        for retained in [false, true] {
            let profile = Profile::new();
            let (mut store, events) = store(&profile, Uuid::new_v4()).await;
            fill_mixed_history(&mut store, oldest_is_cached).await;
            store.config.retained = retained;
            let before = store.history(Uuid::nil(), None, None).await.unwrap();
            let event_count = events.lock().unwrap().len();
            let revision = store.revision;
            let recent_bytes = store.recent_bytes;
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let check = calls.clone();
            let mut member = owner();
            member.send = Arc::new(move || check.fetch_add(1, Ordering::AcqRel) == 0);
            assert_eq!(
                send(&mut store, member, 2, "revoked")
                    .await
                    .unwrap_err()
                    .code,
                "room_denied"
            );
            assert_eq!(calls.load(Ordering::Acquire), 2);
            assert_eq!(
                store.history(Uuid::nil(), None, None).await.unwrap(),
                before
            );
            assert_eq!(count(&mut store).await, 99);
            assert_eq!(store.recent.len(), 1);
            assert_eq!(store.recent_bytes, recent_bytes);
            assert_eq!(store.next_id, 101);
            assert_eq!(store.revision, revision);
            assert_eq!(store.identities[&Uuid::nil()].highwater, 1);
            assert_eq!(store.receipts.len(), 1);
            assert_eq!(events.lock().unwrap().len(), event_count);
            let persisted: (i64, i64) = sqlx::query_as("SELECT revision,next_id FROM settings")
                .fetch_one(&mut store.connection)
                .await
                .unwrap();
            assert_eq!(persisted, (revision as i64, 101));
            refill(&mut store);
            assert_eq!(
                send(&mut store, owner(), 2, "accepted").await.unwrap()["message_id"],
                "101"
            );
            assert_eq!(store.revision, revision + 1);
        }
    }
}

#[tokio::test]
async fn unicode_and_plain_text_bounds_are_enforced() {
    let profile = Profile::new();
    let (mut store, _) = store(&profile, Uuid::new_v4()).await;
    send(&mut store, owner(), 1, &"😀".repeat(200))
        .await
        .unwrap();
    for invalid in [
        "a".repeat(201),
        "😀".repeat(201),
        " \n\t".into(),
        "bad\0text".into(),
        "bad\u{7f}".into(),
    ] {
        assert_eq!(
            send(&mut store, owner(), 2, &invalid)
                .await
                .unwrap_err()
                .code,
            "room_invalid"
        );
    }
    let mut long_name = owner();
    long_name.name = "名".repeat(33);
    assert_eq!(
        send(&mut store, long_name, 2, "valid")
            .await
            .unwrap_err()
            .code,
        "room_invalid"
    );
    assert_eq!(
        send(&mut store, owner(), 0, "zero").await.unwrap_err().code,
        "room_invalid"
    );
}

#[tokio::test]
async fn disk_shrink_uses_prior_budget_evicts_and_persists_only_feasible_config() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let (mut store, events) = store(&profile, room).await;
    let expanded = ChatConfig {
        max_messages: 20_000,
        ..store.config.clone()
    };
    store
        .configure(expanded, store.revision.to_string(), false)
        .await
        .unwrap();
    seed(&mut store, 12_000, room, now_ms(), &"😀".repeat(200)).await;
    let target = ChatConfig {
        disk_quota_mib: 16,
        ..store.config.clone()
    };
    assert!(store.pages().await.unwrap() > target.pages());
    let value = store
        .configure(target.clone(), store.revision.to_string(), true)
        .await
        .unwrap();
    assert!(value["deleted"].as_u64().unwrap() > 0);
    assert_eq!(store.config, target);
    assert!(store.pages().await.unwrap() <= target.pages());
    assert!(
        store.files().await.unwrap() + store.pages().await.unwrap() * PAGE + TRANSACTION_OVERHEAD
            <= target.quota()
    );
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|v| v["maintenance"].is_object()));
    let inspected = Store::inspect(&mut store.connection, &store.path)
        .await
        .unwrap();
    assert_eq!(inspected.0, target);
    assert_eq!(inspected.1, store.revision);
}

#[tokio::test]
async fn failed_configuration_reports_committed_cleanup_and_truthful_old_config() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let (mut store, _) = store(&profile, room).await;
    seed(&mut store, 150, room, now_ms(), "fixture").await;
    let old = store.config.clone();
    sqlx::query("CREATE TRIGGER fail_config BEFORE UPDATE ON settings WHEN NEW.config<>OLD.config BEGIN SELECT RAISE(ABORT,'test config failure'); END")
        .execute(&mut store.connection).await.unwrap();
    let revision = store.revision;
    let error = store
        .configure(
            ChatConfig {
                max_messages: 100,
                ..old.clone()
            },
            revision.to_string(),
            true,
        )
        .await
        .unwrap_err();
    assert!(error.message.contains("已清理50条"));
    assert_eq!(store.config, old);
    assert_eq!(store.revision, revision + 1);
    assert_eq!(count(&mut store).await, 100);
    let persisted: i64 = sqlx::query_scalar("SELECT revision FROM settings")
        .fetch_one(&mut store.connection)
        .await
        .unwrap();
    assert_eq!(persisted as u64, store.revision);
}

#[tokio::test]
async fn physical_page_full_evicts_below_message_cap_then_retries_once() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let (mut store, events) = store(&profile, room).await;
    let text = "😀".repeat(200);
    seed(&mut store, 200, room, now_ms(), &text).await;
    let cap = store.pages().await.unwrap();
    store.set_limit(cap).await.unwrap();
    let mut evicted = false;
    for seq in 1..=20 {
        // Probe the exact same insertion with permission revoked at commit.
        // When the accepted send below needs eviction, this probe traverses
        // the physical-full retry too, and must roll all of that eviction back.
        let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM messages ORDER BY id")
            .fetch_all(&mut store.connection)
            .await
            .unwrap();
        let revision = store.revision;
        let next_id = store.next_id;
        let receipts = store.receipts.len();
        let event_count = events.lock().unwrap().len();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let check = calls.clone();
        let mut member = owner();
        member.send = Arc::new(move || check.fetch_add(1, Ordering::AcqRel) == 0);
        refill(&mut store);
        assert_eq!(
            send(&mut store, member, seq, &text).await.unwrap_err().code,
            "room_denied"
        );
        assert_eq!(calls.load(Ordering::Acquire), 2);
        let remaining: Vec<i64> = sqlx::query_scalar("SELECT id FROM messages ORDER BY id")
            .fetch_all(&mut store.connection)
            .await
            .unwrap();
        assert_eq!(remaining, ids);
        assert_eq!(store.revision, revision);
        assert_eq!(store.next_id, next_id);
        assert_eq!(store.receipts.len(), receipts);
        assert_eq!(events.lock().unwrap().len(), event_count);
        let persisted: (i64, i64) = sqlx::query_as("SELECT revision,next_id FROM settings")
            .fetch_one(&mut store.connection)
            .await
            .unwrap();
        assert_eq!(persisted, (revision as i64, next_id as i64));

        refill(&mut store);
        send(&mut store, owner(), seq, &text).await.unwrap();
        if count(&mut store).await < 200 {
            evicted = true;
            break;
        }
    }
    assert!(
        evicted,
        "page cap must force real eviction while below the row cap"
    );
    assert!(store.pages().await.unwrap() <= cap);
}

#[tokio::test]
async fn stats_explicitly_marks_room_list_truncation() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let (mut store, _) = store(&profile, room).await;
    seed(&mut store, 105, room, now_ms(), "fixture").await;
    sqlx::query("UPDATE messages SET room=printf('%08x-0000-4000-8000-000000000000',id)")
        .execute(&mut store.connection)
        .await
        .unwrap();
    let stats = store.stats().await.unwrap();
    assert_eq!(stats["rooms"].as_array().unwrap().len(), 100);
    assert_eq!(stats["rooms_total"], 105);
    assert_eq!(stats["rooms_truncated"], true);
}

#[tokio::test]
async fn damaged_readonly_and_oversized_fields_are_rejected_without_file_changes() {
    let damaged_profile = Profile::new();
    let path = damaged_profile.0.join("room-chat.sqlite");
    std::fs::write(&path, b"not a database").unwrap();
    let before = std::fs::read(&path).unwrap();
    let result = ChatService::open(&damaged_profile.0, Uuid::new_v4(), Arc::new(|_| {})).await;
    assert_eq!(result.err().unwrap().code, "chat_history_damaged");
    assert_eq!(std::fs::read(&path).unwrap(), before);

    let profile = Profile::new();
    let service = ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {}))
        .await
        .unwrap();
    service.shutdown().await;
    let path = profile.0.join("room-chat.sqlite");
    let before = std::fs::read(&path).unwrap();
    let original_permissions = std::fs::metadata(&path).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions.clone()).unwrap();
    let result = ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {})).await;
    assert_eq!(result.err().unwrap().code, "chat_history_readonly");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::set_permissions(&path, original_permissions).unwrap();
    let mut writer = SqliteConnection::connect_with(&options(&path))
        .await
        .unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=ON")
        .execute(&mut writer)
        .await
        .unwrap();
    sqlx::query("UPDATE settings SET config=?")
        .bind("x".repeat(1024 * 1024))
        .execute(&mut writer)
        .await
        .unwrap();
    writer.close().await.unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(
        ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {}))
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn semantic_damage_in_retained_or_expired_rows_is_rejected_before_any_cleanup() {
    let failures = [
        ("room", "x".repeat(36)),
        ("member", "x".repeat(36)),
        ("name", " \u{2003}".into()),
        ("name", "bad\u{1f}".into()),
        ("text", " \n\t".into()),
        ("text", "bad\u{7f}".into()),
        ("text", "bad\0text".into()),
        ("track", "not-a-number".into()),
        ("track", "18446744073709551616".into()),
    ];
    for expired in [false, true] {
        for (field, value) in &failures {
            let profile = Profile::new();
            let room = Uuid::new_v4();
            let path = {
                let (mut store, _) = store(&profile, room).await;
                let received = if expired {
                    now_ms() - 8 * 86_400_000
                } else {
                    now_ms()
                };
                // Put the invalid row beyond the first bounded preflight page.
                seed(&mut store, 130, room, received, "valid").await;
                sqlx::query(&format!("UPDATE messages SET {field}=? WHERE id=129"))
                    .bind(value)
                    .execute(&mut store.connection)
                    .await
                    .unwrap();
                let path = store.path.clone();
                store.connection.close().await.unwrap();
                path
            };
            let original = std::fs::read(&path).unwrap();
            let error = ChatService::open(&profile.0, room, Arc::new(|_| {}))
                .await
                .err()
                .unwrap();
            assert_eq!(
                error.code, "chat_history_damaged",
                "{field} expired={expired}"
            );
            assert!(error.message.contains("原文件已保留"));
            assert_eq!(
                std::fs::read(&path).unwrap(),
                original,
                "{field} expired={expired}"
            );
            assert!(!profile.0.join("room-chat.sqlite-journal").exists());
        }
    }
}

#[tokio::test]
async fn startup_rejects_sidecars_and_over_budget_database_without_repair() {
    let profile = Profile::new();
    let service = ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {}))
        .await
        .unwrap();
    service.shutdown().await;
    let path = profile.0.join("room-chat.sqlite");
    let journal = profile.0.join("room-chat.sqlite-journal");
    let before = std::fs::read(&path).unwrap();
    std::fs::write(&journal, b"interrupted transaction").unwrap();
    let result = ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {})).await;
    assert_eq!(result.err().unwrap().code, "chat_history_recovery_required");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(std::fs::read(&journal).unwrap(), b"interrupted transaction");
    std::fs::remove_file(journal).unwrap();
    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(257 * MIB).unwrap();
    let result = ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {})).await;
    assert_eq!(result.err().unwrap().code, "chat_quota_exceeded");
    assert_eq!(std::fs::metadata(&path).unwrap().len(), 257 * MIB);
}

// Launched only by the crash tests below; the parent kills this process while
// SQLite holds an uncommitted transaction and dirty pages have spilled to disk.
#[test]
#[ignore = "subprocess fixture for rollback recovery"]
fn rollback_writer_process() {
    let Some(profile) = std::env::var_os("HERTZ_CHAT_CRASH_PROFILE") else {
        return;
    };
    let profile = PathBuf::from(profile);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut connection = SqliteConnection::connect_with(
            &options(&profile.join("room-chat.sqlite")).synchronous(SqliteSynchronous::Full),
        )
        .await
        .unwrap();
        sqlx::query("PRAGMA cache_size=5")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("PRAGMA cache_spill=ON")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("UPDATE messages SET text=?")
            .bind("😀".repeat(200))
            .execute(&mut connection)
            .await
            .unwrap();
        std::fs::write(profile.join("crash-ready"), b"ready").unwrap();
        loop {
            std::thread::park();
        }
    });
}

async fn kill_during_transaction(profile: &Profile) {
    let _ = std::fs::remove_file(profile.0.join("crash-ready"));
    let test_name = format!(
        "{}::rollback_writer_process",
        module_path!().split_once("::").unwrap().1
    );
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &test_name, "--ignored", "--nocapture"])
        .env("HERTZ_CHAT_CRASH_PROFILE", &profile.0)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    // 就绪信号来自子进程：它得冷启动一份测试二进制、跑 migration、seed 500 条、BEGIN IMMEDIATE
    // 之后才写 crash-ready。本机整条路径约 0.2 秒，但套件并发时（Windows 那次整套件 166.8 秒）
    // 500×10ms 的墙钟会挤不进，所以按 30 秒 deadline 等，并把等待时长与子进程状态写进超时信息，
    // 下次再抖就分得清是「慢」还是「死」。
    let started = tokio::time::Instant::now();
    let deadline = started + Duration::from_secs(30);
    loop {
        if profile.0.join("crash-ready").exists() {
            child.kill().unwrap();
            child.wait().unwrap();
            return;
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("crash fixture exited early: {status}");
        }
        if tokio::time::Instant::now() >= deadline {
            let elapsed = started.elapsed();
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "crash fixture did not reach an active write transaction after {} ms (pid {pid:?}, profile {})",
                elapsed.as_millis(),
                profile.0.display()
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn seeded_profile_for_crash(profile: &Profile, room: Uuid) {
    let (mut store, _) = store(profile, room).await;
    seed(&mut store, 500, room, now_ms(), &"a".repeat(200)).await;
    store.connection.close().await.unwrap();
    drop(store._lock);
}

#[tokio::test]
async fn startup_recovers_hot_rollback_after_process_is_killed_and_keeps_budget_bounded() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    seeded_profile_for_crash(&profile, room).await;
    let path = profile.0.join("room-chat.sqlite");
    let original_size = std::fs::metadata(&path).unwrap().len();
    for _ in 0..3 {
        let before = std::fs::read(&path).unwrap();
        kill_during_transaction(&profile).await;
        let journal = std::fs::read(profile.0.join("room-chat.sqlite-journal")).unwrap();
        assert_eq!(
            &journal[..8],
            &[0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]
        );
        assert_ne!(
            std::fs::read(&path).unwrap(),
            before,
            "the killed transaction must have spilled DB pages"
        );
        assert!(file_bytes(&path).await.unwrap() <= ChatConfig::default().quota());
        let service = ChatService::open(&profile.0, room, Arc::new(|_| {}))
            .await
            .unwrap();
        let history = service
            .request(
                owner(),
                ChatRequest::History {
                    before: None,
                    revision: None,
                },
            )
            .await
            .unwrap();
        assert!(history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["text"] == "a".repeat(200)));
        assert_eq!(service.status.borrow().messages, 500);
        assert!(file_bytes(&path).await.unwrap() <= ChatConfig::default().quota());
        assert!(!profile.0.join("room-chat.sqlite-journal").exists());
        service.shutdown().await;
        assert_eq!(std::fs::metadata(&path).unwrap().len(), original_size);
    }
    let mut reader = SqliteConnection::connect_with(&options(&path).read_only(true))
        .await
        .unwrap();
    let unchanged: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE text=?")
        .bind("a".repeat(200))
        .fetch_one(&mut reader)
        .await
        .unwrap();
    assert_eq!(unchanged, 500);
    reader.close().await.unwrap();
}

#[tokio::test]
async fn malformed_hot_journal_and_unsupported_wal_are_preserved_without_recovery() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    seeded_profile_for_crash(&profile, room).await;
    kill_during_transaction(&profile).await;
    let path = profile.0.join("room-chat.sqlite");
    let journal_path = profile.0.join("room-chat.sqlite-journal");
    let mut journal = std::fs::read(&journal_path).unwrap();
    journal[0] ^= 0xff;
    std::fs::write(&journal_path, &journal).unwrap();
    let before = std::fs::read(&path).unwrap();
    let result = ChatService::open(&profile.0, room, Arc::new(|_| {})).await;
    assert_eq!(result.err().unwrap().code, "chat_history_recovery_required");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(std::fs::read(&journal_path).unwrap(), journal);
    let wal = profile.0.join("room-chat.sqlite-wal");
    std::fs::write(&wal, b"unsupported WAL").unwrap();
    assert!(ChatService::open(&profile.0, room, Arc::new(|_| {}))
        .await
        .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(std::fs::read(&journal_path).unwrap(), journal);
    assert_eq!(std::fs::read(&wal).unwrap(), b"unsupported WAL");
}

#[tokio::test]
async fn startup_finalizes_cold_journal_only_after_validating_original_database() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let service = ChatService::open(&profile.0, room, Arc::new(|_| {}))
        .await
        .unwrap();
    service
        .request(
            owner(),
            ChatRequest::Send {
                operation: 1,
                text: "committed".into(),
                track: None,
            },
        )
        .await
        .unwrap();
    service.shutdown().await;
    std::fs::write(profile.0.join("room-chat.sqlite-journal"), [0u8; 512]).unwrap();
    let recovered = ChatService::open(&profile.0, room, Arc::new(|_| {}))
        .await
        .unwrap();
    let history = recovered
        .request(
            owner(),
            ChatRequest::History {
                before: None,
                revision: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(history["messages"][0]["text"], "committed");
    assert!(!profile.0.join("room-chat.sqlite-journal").exists());
    recovered.shutdown().await;
}

#[tokio::test]
async fn unreadable_hot_journal_preflight_requires_recovery_and_leaves_all_bytes_untouched() {
    for failure in ["settings", "schema"] {
        let profile = Profile::new();
        let room = Uuid::new_v4();
        seeded_profile_for_crash(&profile, room).await;
        let path = profile.0.join("room-chat.sqlite");
        let mut writer = SqliteConnection::connect_with(&options(&path))
            .await
            .unwrap();
        let statement = if failure == "settings" {
            "UPDATE settings SET config='invalid JSON'"
        } else {
            "CREATE TABLE unexpected(value TEXT)"
        };
        sqlx::query(statement).execute(&mut writer).await.unwrap();
        writer.close().await.unwrap();
        kill_during_transaction(&profile).await;
        let journal_path = profile.0.join("room-chat.sqlite-journal");
        let database = std::fs::read(&path).unwrap();
        let journal = std::fs::read(&journal_path).unwrap();
        let error = ChatService::open(&profile.0, room, Arc::new(|_| {}))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "chat_history_recovery_required", "{failure}");
        assert!(error.message.contains("原数据库及事务文件均未修改"));
        assert_eq!(std::fs::read(&path).unwrap(), database);
        assert_eq!(std::fs::read(&journal_path).unwrap(), journal);
    }
}

#[tokio::test]
async fn post_recovery_validation_failure_reports_that_files_may_have_changed() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    seeded_profile_for_crash(&profile, room).await;
    let path = profile.0.join("room-chat.sqlite");
    let mut writer = SqliteConnection::connect_with(&options(&path))
        .await
        .unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=ON")
        .execute(&mut writer)
        .await
        .unwrap();
    sqlx::query("UPDATE messages SET text=? WHERE id=1")
        .bind("x".repeat(201))
        .execute(&mut writer)
        .await
        .unwrap();
    writer.close().await.unwrap();
    kill_during_transaction(&profile).await;
    let database = std::fs::read(&path).unwrap();
    let error = ChatService::open(&profile.0, room, Arc::new(|_| {}))
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "chat_history_damaged");
    assert!(error.message.contains("SQLite 回滚恢复已启动"));
    assert!(error.message.contains("文件可能已改变"));
    assert!(!error.message.contains("原文件已保留"));
    assert!(!error.message.contains("均未修改"));
    assert_ne!(std::fs::read(&path).unwrap(), database);
    assert!(
        !profile.0.join("room-chat.sqlite-journal").exists(),
        "SQLite must have performed rollback before validation failed"
    );
}

#[tokio::test]
async fn version_one_text_history_migrates_atomically_to_structured_song_schema() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let path = profile.0.join("room-chat.sqlite");
    let mut connection = SqliteConnection::connect_with(
        &options(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Delete)
            .synchronous(SqliteSynchronous::Full)
            .page_size(PAGE as u32)
            .auto_vacuum(SqliteAutoVacuum::Incremental),
    )
    .await
    .unwrap();
    for statement in SCHEMA_V1.into_iter().chain(["PRAGMA user_version=1"]) {
        sqlx::query(statement)
            .execute(&mut connection)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO settings VALUES(1,?,1,2)")
        .bind(serde_json::to_string(&ChatConfig::default()).unwrap())
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO messages VALUES(1,?,?,?,'<b>still plain text</b>',?,NULL)")
        .bind(room.to_string())
        .bind(Uuid::nil().to_string())
        .bind("Host")
        .bind(now_ms())
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let chat = ChatService::open(&profile.0, room, Arc::new(|_| {}))
        .await
        .unwrap();
    let history = chat
        .request(
            owner(),
            ChatRequest::History {
                before: None,
                revision: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(history["messages"][0]["text"], "<b>still plain text</b>");
    assert_eq!(history["messages"][0]["content_kind"], "text");
    assert!(history["messages"][0]["song"].is_null());
    let receipt = chat
        .request(
            owner(),
            ChatRequest::Send {
                operation: 1,
                text: "after migration".into(),
                track: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(receipt["message_id"], "2");
    chat.shutdown().await;
    let mut connection = SqliteConnection::connect_with(&options(&path).read_only(true))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        2
    );
    Store::inspect(&mut connection, &path).await.unwrap();
    connection.close().await.unwrap();
}

#[tokio::test]
async fn near_quota_version_one_history_upgrades_without_copying_or_losing_messages() {
    let profile = Profile::new();
    let room = Uuid::new_v4();
    let member = Uuid::new_v4();
    let path = profile.0.join("room-chat.sqlite");
    let config = ChatConfig {
        disk_quota_mib: 16,
        ..Default::default()
    };
    let text = "😀".repeat(200);
    let name = "n".repeat(32);
    let received = now_ms();
    let mut connection = SqliteConnection::connect_with(
        &options(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Delete)
            .synchronous(SqliteSynchronous::Full)
            .page_size(PAGE as u32)
            .auto_vacuum(SqliteAutoVacuum::Incremental),
    )
    .await
    .unwrap();
    sqlx::query(&format!("PRAGMA max_page_count={}", config.pages()))
        .execute(&mut connection)
        .await
        .unwrap();
    let mut tx = connection.begin().await.unwrap();
    for statement in SCHEMA_V1.into_iter().chain(["PRAGMA user_version=1"]) {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    sqlx::query("INSERT INTO settings VALUES(1,?,1,6001)")
        .bind(serde_json::to_string(&config).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<6000) INSERT INTO messages(id,room,member,name,text,received,track) SELECT n,?,?,?,?,?,'42' FROM seq")
        .bind(room.to_string()).bind(member.to_string()).bind(&name).bind(&text).bind(received)
        .execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let before_pages: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert!(
        before_pages as u64 <= config.pages(),
        "fixture must pass the actual database plus rollback-reserve budget"
    );
    assert!(
        before_pages as u64 > config.pages() * 4 / 5,
        "fixture must be close enough to the database cap that duplicating rows fails"
    );
    Store::inspect(&mut connection, &path).await.unwrap();
    connection.close().await.unwrap();

    let chat = ChatService::open(&profile.0, room, Arc::new(|_| {}))
        .await
        .unwrap();
    let history = chat
        .request(
            owner(),
            ChatRequest::History {
                before: None,
                revision: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        history["messages"].as_array().unwrap().last().unwrap()["message_id"],
        "6000"
    );
    assert_eq!(
        history["messages"].as_array().unwrap().last().unwrap()["text"],
        text
    );
    chat.shutdown().await;
    let mut connection = SqliteConnection::connect_with(&options(&path).read_only(true))
        .await
        .unwrap();
    let after_pages: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(
        after_pages, before_pages,
        "adding a nullable song reference must not copy retained data or indexes"
    );
    let preserved: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE room=? AND member=? AND name=? AND text=? AND received=? AND track='42' AND song IS NULL")
        .bind(room.to_string()).bind(member.to_string()).bind(&name).bind(&text).bind(received)
        .fetch_one(&mut connection).await.unwrap();
    assert_eq!(preserved, 6000);
    let (saved_config, revision, next_id) = Store::inspect(&mut connection, &path).await.unwrap();
    assert_eq!(saved_config, config);
    assert_eq!((revision, next_id), (1, 6001));
    let schema_sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='messages'")
            .fetch_one(&mut connection)
            .await
            .unwrap();
    assert_eq!(schema_sql, altered_messages_schema());
    connection.close().await.unwrap();
    assert!(file_bytes(&path).await.unwrap() * 2 + TRANSACTION_OVERHEAD <= config.quota());

    let restarted = ChatService::open(&profile.0, room, Arc::new(|_| {}))
        .await
        .unwrap();
    let receipt = restarted
        .request(
            owner(),
            ChatRequest::Send {
                operation: 1,
                text: "after near-quota migration".into(),
                track: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(receipt["message_id"], "6001");
    restarted.shutdown().await;
}
