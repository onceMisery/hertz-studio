// SPDX-License-Identifier: MIT
//! Real SQLite migrations and management transactions in isolated fixture stores.
//! No OIDC provider, Signer service or production key is contacted by these tests.
use crate::{
    administration::RoleChangeInput,
    config::Config,
    error::Result,
    management::{ManagementReceipt, ReportStatus, Role},
    model::{now, Actor},
    reports::{ReportDecision, ReportInput, ResolveInput},
    Hub, ServerLease,
};
use axum::http::StatusCode;
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

const AUTHORIZATION: &str = include_str!("../tests/fixtures/authorization.json");
const HUB_ID: &str = "11111111-1111-4111-8111-111111111111";

#[path = "author_tests.rs"]
mod author;

struct Fixture {
    hub: Hub,
    lease: Option<ServerLease>,
    directory: PathBuf,
    parent: PathBuf,
}

impl Fixture {
    async fn new() -> Self {
        let parent = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let directory = parent.join(format!("hertz-hub-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let chain = directory.join("authorization.json");
        std::fs::write(&chain, AUTHORIZATION).unwrap();
        #[cfg(windows)]
        let (endpoint, service_identity) = (
            format!(r"\\.\pipe\hertz-wallpaper-signer-test-{}", uuid::Uuid::new_v4()),
            if hertz_wallpaper_signer::platform::current_identity().unwrap() == "S-1-5-19" {
                "S-1-5-20".to_owned()
            } else {
                "S-1-5-19".to_owned()
            },
        );
        #[cfg(unix)]
        let (endpoint, service_identity) = (
            directory.join("signer.sock").to_str().unwrap().to_owned(),
            hertz_wallpaper_signer::platform::current_identity()
                .unwrap()
                .parse::<u32>()
                .unwrap()
                .wrapping_add(1)
                .to_string(),
        );
        let config: Config = serde_json::from_value(json!({
            "hubId": HUB_ID,
            "publicOrigin": "https://community.example",
            "listen": "127.0.0.1:17635",
            "issuer": "https://identity.example",
            "desktopClientId": "fixture-desktop",
            "apiAudience": "fixture-hub-api",
            "scopes": ["openid", "profile", "wallpaper.read", "wallpaper.write"],
            "allowedSigningAlgorithms": ["RS256"],
            "databasePath": directory.join("hub.db"),
            "contentDirectory": directory.join("content"),
            "trustedProxies": ["127.0.0.1"],
            "signerEndpoint": endpoint,
            "signerServiceIdentity": service_identity,
            "signerLedgerId": "22222222-2222-4222-8222-222222222222",
            "authorizationChainFile": chain,
            "rootFingerprint": "34750f98bd59fcfc946da45aaabe933be154a4b5094e1c4abf42866505f3c97e",
            "releaseKeyId": "fixture-release",
            "revocationsKeyId": "fixture-revocations",
            "administrators": [{"issuer": "https://identity.example", "sub": "configured-admin"}]
        }))
        .unwrap();
        let (hub, lease) = Hub::open(config).await.unwrap();
        Self { hub, lease: Some(lease), directory, parent }
    }

    async fn admin(&self) -> Actor {
        let id = sqlx::query_scalar("SELECT id FROM users WHERE subject='configured-admin'")
            .fetch_one(&self.hub.pool).await.unwrap();
        Actor { id, role: "admin".into() }
    }

    async fn user(&self, role: Role) -> Actor {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO users(id,issuer,subject,role,created_at) VALUES(?,?,?,?,?)")
            .bind(&id).bind(&self.hub.config.issuer).bind(&id)
            .bind(role.as_str()).bind(now()).execute(&self.hub.pool).await.unwrap();
        Actor { id, role: role.as_str().into() }
    }

    async fn release(&self, author: &Actor) -> String {
        let work = uuid::Uuid::new_v4().to_string();
        let upload = uuid::Uuid::new_v4().to_string();
        let release = uuid::Uuid::new_v4().to_string();
        let hash = "a".repeat(64);
        let mut tx = self.hub.pool.begin().await.unwrap();
        sqlx::query("INSERT INTO works(id,owner_id,operation_id,operation_digest,title,license_json,created_at) VALUES(?,?,?,?,?,?,?)")
            .bind(&work).bind(&author.id).bind(&work).bind(&hash)
            .bind("Fixture work").bind("{}").bind(now()).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO uploads(id,owner_id,work_id,operation_id,operation_digest,package_hash,expected_bytes,min_engine_protocol,state,created_at,expires_at) VALUES(?,?,?,?,?,?,1,1,'submitted',?,?)")
            .bind(&upload).bind(&author.id).bind(&work).bind(&upload).bind(&hash).bind(&hash)
            .bind(now()).bind(now()+3600).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO releases(id,work_id,owner_id,upload_id,version,package_hash,bytes,title,description,kind,license_json,permissions_json,permissions_digest,body_json,body_digest,state,created_at) VALUES(?,?,?,?,1,?,1,'Fixture work','Fixture report target','builtin','{}','{}',?,'{}',?,'pending_review',?)")
            .bind(&release).bind(&work).bind(&author.id).bind(&upload).bind(&hash)
            .bind(&hash).bind(&hash).bind(now()).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        release
    }

    async fn count(&self, table: &str) -> i64 {
        assert!(["audit_events", "management_operations", "reports", "report_resolutions", "revocations"].contains(&table));
        sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&self.hub.pool).await.unwrap()
    }

    async fn reopen(&mut self) {
        let config = (*self.hub.config).clone();
        self.hub.pool.close().await;
        drop(self.lease.take());
        let (hub, lease) = Hub::open(config).await.unwrap();
        self.hub = hub;
        self.lease = Some(lease);
    }

    async fn close(mut self) {
        self.hub.pool.close().await;
        drop(self.lease.take());
        let resolved = std::fs::canonicalize(&self.directory).unwrap();
        assert_eq!(resolved.parent(), Some(self.parent.as_path()));
        assert!(resolved.file_name().unwrap().to_str().unwrap().starts_with("hertz-hub-test-"));
        std::fs::remove_dir_all(resolved).unwrap();
    }
}

fn value<T: Serialize>(item: &T) -> Value { serde_json::to_value(item).unwrap() }
fn rejected<T>(result: Result<T>, status: StatusCode) {
    assert_eq!(result.err().expect("operation must be rejected").status, status);
}
fn role_change(operation: &str, expected: Role, role: Role) -> RoleChangeInput {
    RoleChangeInput { operation_id: operation.into(), expected_role: expected, role, reason: "Fixture role decision".into() }
}
fn report_input(operation: &str, release: &str) -> ReportInput {
    ReportInput { operation_id: operation.into(), release_id: release.into(), reason: "other".into(), description: "Fixture report description".into() }
}
fn resolve_input(operation: &str, digest: &str, decision: ReportDecision) -> ResolveInput {
    ResolveInput { operation_id: operation.into(), report_digest: digest.into(), decision, reason: "Fixture moderation decision".into() }
}

#[tokio::test]
async fn migrations_and_configured_admin_grants_survive_restart_without_duplicate_audit() {
    let mut f = Fixture::new().await;
    let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
        .fetch_all(&f.hub.pool).await.unwrap();
    assert_eq!(versions, [1, 2, 3]);
    let admin = f.admin().await;
    let user = f.hub.management_user_detail(&admin, &admin.id).await.unwrap();
    assert!(user.configured_administrator);
    assert_eq!(value(&user)["role"], "admin");
    let events = f.hub.management_audit(&admin, 0, 50).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action, "administrator_configured");
    assert_eq!(events[0].actor_id, None);
    assert_eq!(events[0].object_id.as_deref(), Some(admin.id.as_str()));
    f.reopen().await;
    assert_eq!(f.admin().await.id, admin.id);
    assert_eq!(f.count("audit_events").await, 1);
    // An explicit configuration regrant changes the role and audit together.
    sqlx::query("UPDATE users SET role='author' WHERE id=?").bind(&admin.id)
        .execute(&f.hub.pool).await.unwrap();
    f.reopen().await;
    assert_eq!(f.count("audit_events").await, 2);
    assert_eq!(value(&f.hub.management_user_detail(&admin, &admin.id).await.unwrap())["role"], "admin");
    let violations = sqlx::query("PRAGMA foreign_key_check").fetch_all(&f.hub.pool).await.unwrap();
    assert!(violations.is_empty());
    f.close().await;
}

#[tokio::test]
async fn exact_role_receipt_replays_after_restart_and_conflicting_uuid_does_not_write() {
    let mut f = Fixture::new().await;
    let admin = f.admin().await;
    let target = f.user(Role::Author).await;
    let operation = uuid::Uuid::new_v4().to_string();
    let receipt = f.hub.change_role(&admin, &target.id, role_change(&operation, Role::Author, Role::Moderator)).await.unwrap();
    let original = value(&receipt);
    assert_eq!(original["result"]["kind"], "role_change");
    assert_eq!(original["result"]["previousRole"], "author");
    assert_eq!(original["result"]["role"], "moderator");
    f.reopen().await;
    let replay = f.hub.change_role(&admin, &target.id, role_change(&operation, Role::Author, Role::Moderator)).await.unwrap();
    assert_eq!(value(&replay), original);
    assert_eq!(value(&f.hub.management_operation(&admin, &operation).await.unwrap()), original);
    rejected(f.hub.change_role(&admin, &target.id, role_change(&operation, Role::Author, Role::Admin)).await, StatusCode::CONFLICT);
    let other = f.user(Role::Author).await;
    rejected(f.hub.change_role(&admin, &other.id, role_change(&operation, Role::Author, Role::Moderator)).await, StatusCode::CONFLICT);
    assert_eq!(f.count("management_operations").await, 1);
    let audit = f.hub.management_audit(&admin, 0, 50).await.unwrap();
    assert_eq!(audit.len(), 2);
    assert_eq!(audit[1].operation_id.as_deref(), Some(operation.as_str()));
    assert_eq!(audit[1].id, receipt.audit_event_id);
    // A moderator may recover report dispositions, never administrator receipts.
    rejected(f.hub.management_operation(&target, &operation).await, StatusCode::NOT_FOUND);
    f.close().await;
}

#[tokio::test]
async fn concurrent_role_cas_has_one_commit_and_one_conflict() {
    let f = Fixture::new().await;
    let admin = f.admin().await;
    let target = f.user(Role::Author).await;
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    let (a, b) = tokio::join!(
        f.hub.change_role(&admin, &target.id, role_change(&first, Role::Author, Role::Moderator)),
        f.hub.change_role(&admin, &target.id, role_change(&second, Role::Author, Role::Admin))
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(a.err().or_else(|| b.err()).unwrap().status, StatusCode::CONFLICT);
    assert_eq!(f.count("management_operations").await, 1);
    assert_eq!(f.count("audit_events").await, 2);
    f.close().await;
}

#[tokio::test]
async fn current_database_roles_and_administrator_protections_override_cached_actor_roles() {
    let mut f = Fixture::new().await;
    let admin = f.admin().await;
    let mut author = f.user(Role::Author).await;
    author.role = "admin".into(); // Deliberately stale/untrusted role snapshot.
    rejected(f.hub.management_users(&author, 0, 20).await, StatusCode::FORBIDDEN);
    rejected(f.hub.management_audit(&author, 0, 20).await, StatusCode::FORBIDDEN);
    rejected(f.hub.report_queue(&author, ReportStatus::Open, 0, 20).await, StatusCode::FORBIDDEN);
    let operation = uuid::Uuid::new_v4().to_string();
    rejected(f.hub.change_role(&author, &author.id, role_change(&operation, Role::Author, Role::Admin)).await, StatusCode::FORBIDDEN);
    rejected(f.hub.change_role(&admin, &admin.id, role_change(&operation, Role::Admin, Role::Author)).await, StatusCode::CONFLICT);
    // Exercise the owner-level last-admin guard independently of config protection.
    let mut config = (*f.hub.config).clone();
    config.administrators.clear();
    f.hub.config = Arc::new(config);
    let error = f.hub.change_role(&admin, &admin.id, role_change(&operation, Role::Admin, Role::Author)).await.err().unwrap();
    assert_eq!(error.message, "不能撤销最后一个数据库管理员");
    assert_eq!(f.count("management_operations").await, 0);
    f.close().await;
}

#[tokio::test]
async fn revoked_admin_cannot_replay_or_read_an_admitted_management_receipt() {
    let f = Fixture::new().await;
    let admin = f.admin().await;
    let operator = f.user(Role::Admin).await;
    let target = f.user(Role::Author).await;
    let operation = uuid::Uuid::new_v4().to_string();
    f.hub.change_role(&operator, &target.id, role_change(&operation, Role::Author, Role::Moderator)).await.unwrap();
    let revoke = uuid::Uuid::new_v4().to_string();
    f.hub.change_role(&admin, &operator.id, role_change(&revoke, Role::Admin, Role::Author)).await.unwrap();
    rejected(f.hub.change_role(&operator, &target.id, role_change(&operation, Role::Author, Role::Moderator)).await, StatusCode::FORBIDDEN);
    rejected(f.hub.management_operation(&operator, &operation).await, StatusCode::FORBIDDEN);
    assert_eq!(f.count("management_operations").await, 2);
    f.close().await;
}

#[tokio::test]
async fn receipt_write_failure_rolls_back_role_and_audit() {
    let f = Fixture::new().await;
    let admin = f.admin().await;
    let target = f.user(Role::Author).await;
    sqlx::query("CREATE TRIGGER fixture_fail_receipt BEFORE INSERT ON management_operations BEGIN SELECT RAISE(FAIL,'fixture receipt failure'); END")
        .execute(&f.hub.pool).await.unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    rejected(f.hub.change_role(&admin, &target.id, role_change(&operation, Role::Author, Role::Moderator)).await, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value(&f.hub.management_user_detail(&admin, &target.id).await.unwrap())["role"], "author");
    assert_eq!(f.count("audit_events").await, 1);
    assert_eq!(f.count("management_operations").await, 0);
    sqlx::query("DROP TRIGGER fixture_fail_receipt").execute(&f.hub.pool).await.unwrap();
    f.hub.change_role(&admin, &target.id, role_change(&operation, Role::Author, Role::Moderator)).await.unwrap();
    f.close().await;
}

#[tokio::test]
async fn report_submission_is_idempotent_and_visible_only_to_reporter_or_current_reviewer() {
    let f = Fixture::new().await;
    let reporter = f.user(Role::Author).await;
    let other = f.user(Role::Author).await;
    let moderator = f.user(Role::Moderator).await;
    let release = f.release(&reporter).await;
    let operation = uuid::Uuid::new_v4().to_string();
    rejected(f.hub.report(&other, report_input(&operation, &release)).await, StatusCode::NOT_FOUND);
    let report = f.hub.report(&reporter, report_input(&operation, &release)).await.unwrap();
    assert_eq!(f.hub.report(&reporter, report_input(&operation, &release)).await.unwrap(), report);
    let mut conflicting = report_input(&operation, &release);
    conflicting.description = "Changed submission".into();
    rejected(f.hub.report(&reporter, conflicting).await, StatusCode::CONFLICT);
    assert_eq!(f.count("reports").await, 1);
    assert_eq!(f.count("audit_events").await, 2);
    assert_eq!(value(&f.hub.report_detail(&reporter, &report).await.unwrap())["status"], "open");
    rejected(f.hub.report_detail(&other, &report).await, StatusCode::NOT_FOUND);
    assert_eq!(f.hub.report_queue(&moderator, ReportStatus::Open, 0, 20).await.unwrap().len(), 1);
    sqlx::query("UPDATE users SET role='author' WHERE id=?").bind(&moderator.id).execute(&f.hub.pool).await.unwrap();
    rejected(f.hub.report_detail(&moderator, &report).await, StatusCode::NOT_FOUND);
    rejected(f.hub.report_queue(&moderator, ReportStatus::Open, 0, 20).await, StatusCode::FORBIDDEN);
    f.close().await;
}

#[tokio::test]
async fn report_digest_and_terminal_receipt_bind_exact_disposition_without_revoking_release() {
    let f = Fixture::new().await;
    let reporter = f.user(Role::Author).await;
    let moderator = f.user(Role::Moderator).await;
    let release = f.release(&reporter).await;
    let report = f.hub.report(&reporter, report_input("legacy-submission-id", &release)).await.unwrap();
    let digest = f.hub.report_detail(&reporter, &report).await.unwrap().report_digest;
    let operation = uuid::Uuid::new_v4().to_string();
    rejected(f.hub.resolve_report(&reporter, &report, resolve_input(&operation, &digest, ReportDecision::Escalate)).await, StatusCode::FORBIDDEN);
    rejected(f.hub.resolve_report(&moderator, &report, resolve_input(&operation, &"b".repeat(64), ReportDecision::Escalate)).await, StatusCode::CONFLICT);
    let receipt = f.hub.resolve_report(&moderator, &report, resolve_input(&operation, &digest, ReportDecision::Escalate)).await.unwrap();
    let replay = f.hub.resolve_report(&moderator, &report, resolve_input(&operation, &digest, ReportDecision::Escalate)).await.unwrap();
    assert_eq!(value(&replay), value(&receipt));
    assert_eq!(value(&f.hub.management_operation(&moderator, &operation).await.unwrap()), value(&receipt));
    rejected(f.hub.resolve_report(&moderator, &report, resolve_input(&uuid::Uuid::new_v4().to_string(), &digest, ReportDecision::Dismiss)).await, StatusCode::CONFLICT);
    let detail = f.hub.report_detail(&reporter, &report).await.unwrap();
    assert_eq!(detail.report_digest, digest);
    assert_eq!(value(&detail)["status"], "escalated");
    assert_eq!(detail.resolution.unwrap().operation_id, operation);
    assert!(f.hub.report_queue(&moderator, ReportStatus::Open, 0, 20).await.unwrap().is_empty());
    assert_eq!(f.hub.report_queue(&moderator, ReportStatus::Escalated, 0, 20).await.unwrap().len(), 1);
    let state: String = sqlx::query_scalar("SELECT state FROM releases WHERE id=?").bind(&release).fetch_one(&f.hub.pool).await.unwrap();
    assert_eq!(state, "pending_review");
    assert_eq!(f.count("revocations").await, 0);
    assert_eq!(f.count("report_resolutions").await, 1);
    f.close().await;
}

#[tokio::test]
async fn resolution_failure_rolls_back_receipt_and_audit_and_same_operation_can_retry() {
    let f = Fixture::new().await;
    let reporter = f.user(Role::Author).await;
    let moderator = f.user(Role::Moderator).await;
    let release = f.release(&reporter).await;
    let report = f.hub.report(&reporter, report_input("report-for-rollback", &release)).await.unwrap();
    let digest = f.hub.report_detail(&reporter, &report).await.unwrap().report_digest;
    sqlx::query("CREATE TRIGGER fixture_fail_resolution BEFORE INSERT ON report_resolutions BEGIN SELECT RAISE(FAIL,'fixture resolution failure'); END")
        .execute(&f.hub.pool).await.unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    rejected(f.hub.resolve_report(&moderator, &report, resolve_input(&operation, &digest, ReportDecision::Dismiss)).await, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(f.count("management_operations").await, 0);
    assert_eq!(f.count("report_resolutions").await, 0);
    assert_eq!(f.count("audit_events").await, 2);
    assert_eq!(value(&f.hub.report_detail(&reporter, &report).await.unwrap())["status"], "open");
    sqlx::query("DROP TRIGGER fixture_fail_resolution").execute(&f.hub.pool).await.unwrap();
    f.hub.resolve_report(&moderator, &report, resolve_input(&operation, &digest, ReportDecision::Dismiss)).await.unwrap();
    assert_eq!(value(&f.hub.report_detail(&reporter, &report).await.unwrap())["status"], "dismissed");
    f.close().await;
}

#[tokio::test]
async fn audit_cursor_and_management_pages_are_bounded_and_reject_corrupt_records() {
    let f = Fixture::new().await;
    let admin = f.admin().await;
    let author = f.user(Role::Author).await;
    let operation = uuid::Uuid::new_v4().to_string();
    let _: ManagementReceipt = f.hub.change_role(&admin, &author.id, role_change(&operation, Role::Author, Role::Moderator)).await.unwrap();
    let first = f.hub.management_audit(&admin, 0, 1).await.unwrap();
    let second = f.hub.management_audit(&admin, first[0].id, 1).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(second.len(), 1);
    assert!(second[0].id > first[0].id);
    assert!(f.hub.management_audit(&admin, second[0].id, 1).await.unwrap().is_empty());
    for (offset, limit) in [(-1, 20), (0, 0), (0, 51), (1_000_001, 1)] {
        rejected(f.hub.management_users(&admin, offset, limit).await, StatusCode::BAD_REQUEST);
    }
    rejected(f.hub.management_audit(&admin, -1, 20).await, StatusCode::BAD_REQUEST);
    rejected(f.hub.management_audit(&admin, 0, 51).await, StatusCode::BAD_REQUEST);
    sqlx::query("UPDATE audit_events SET object_id=? WHERE id=?")
        .bind("x".repeat(129)).bind(second[0].id).execute(&f.hub.pool).await.unwrap();
    rejected(f.hub.management_audit(&admin, 0, 50).await, StatusCode::SERVICE_UNAVAILABLE);
    sqlx::query("UPDATE management_operations SET result_json='{}' WHERE operation_id=?")
        .bind(&operation).execute(&f.hub.pool).await.unwrap();
    rejected(f.hub.management_operation(&admin, &operation).await, StatusCode::SERVICE_UNAVAILABLE);
    f.close().await;
}
