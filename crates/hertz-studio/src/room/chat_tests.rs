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
    let (mut store, _) = store(&profile, room).await;
    let text = "😀".repeat(200);
    seed(&mut store, 200, room, now_ms(), &text).await;
    let cap = store.pages().await.unwrap();
    store.set_limit(cap).await.unwrap();
    let mut evicted = false;
    for seq in 1..=20 {
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
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions.clone()).unwrap();
    let result = ChatService::open(&profile.0, Uuid::new_v4(), Arc::new(|_| {})).await;
    assert_eq!(result.err().unwrap().code, "chat_history_readonly");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    permissions.set_readonly(false);
    std::fs::set_permissions(&path, permissions).unwrap();
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
