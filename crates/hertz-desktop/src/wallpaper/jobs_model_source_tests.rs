// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::assets::{
    installed_model_fixture, model_source_test_probe, model_source_writable, CanonicalModelSource,
};
use crate::wallpaper::library::{tempfileish, InstallWork};
use std::time::Duration;

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .unwrap()
        })
        .block_on(future)
}

struct Env {
    jobs: ImportJobs,
    reference: AssetRef,
    probe: ProbeClient,
    _root: tempfileish::TempDir,
}

fn env(tag: &str) -> Env {
    let fixture = installed_model_fixture(tag);
    let probe = model_source_test_probe();
    let library = block_on(Library::open(&fixture.root.path().join("db"))).unwrap();
    block_on(library.install(&InstallWork {
        remote_work_id: fixture.package.manifest.work_id.clone(),
        work_key: format!("local-{}", fixture.package.manifest.work_id),
        title: fixture.package.manifest.title.clone(),
        description: fixture.package.manifest.description.clone(),
        kind: "builtin".into(),
        package_hash: fixture.reference.package_hash.clone(),
        manifest_json: fixture.package.manifest_json.clone(),
        package_bytes: fixture.original.len() as u64,
        version: 1,
        source_id: LOCAL_SOURCE.into(),
    }))
    .unwrap();
    Env {
        jobs: ImportJobs::start(library, fixture.store, probe.clone()),
        reference: fixture.reference,
        probe,
        _root: fixture.root,
    }
}

fn receive(
    reply: tokio::sync::oneshot::Receiver<Result<CanonicalModelSource, JobError>>,
) -> Result<CanonicalModelSource, JobError> {
    block_on(async {
        tokio::time::timeout(Duration::from_secs(10), reply)
            .await
            .unwrap()
            .unwrap()
    })
}

fn terminal(env: &Env, id: &str) -> JobStatus {
    for _ in 0..400 {
        if let Some(status) = env.jobs.status(id) {
            if matches!(
                status.state,
                JobState::Done | JobState::Failed | JobState::Cancelled
            ) {
                return status;
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("model source job did not settle");
}

fn drained(env: &Env, id: &str, state: JobState) {
    assert_eq!(terminal(env, id).state, state);
    assert!(env.jobs.active_status().is_none());
    assert_eq!(env.probe.stats(), (0, 0));
    assert_eq!(env.probe.budget_for_test().usage().asset_cpu_bytes, 0);
    assert_eq!(env.probe.budget_for_test().usage().prepare_cpu_bytes, 0);
    assert_eq!(env.probe.budget_for_test().usage().prepare_tasks, 0);
    assert_eq!(env.probe.budget_for_test().record_count_for_test(), 0);
    assert!(env.probe.budget_for_test().stuck().is_empty());
    assert!(model_source_writable(
        env.jobs.assets(),
        &env.reference,
        "models/a/source.glb"
    ));
    drop(env.jobs.assets().content_writer().unwrap());
}

type HeldRequest = (
    JobRequest,
    tokio::sync::oneshot::Receiver<Result<CanonicalModelSource, JobError>>,
    std::sync::mpsc::Receiver<()>,
    Arc<tokio::sync::Notify>,
);

fn held_request(env: &Env, id: &str) -> HeldRequest {
    let mut request = env
        .jobs
        .reserve(
            id.into(),
            JobSource::PrepareModelSource(env.reference.clone()),
            None,
        )
        .unwrap();
    let (sender, reply) = tokio::sync::oneshot::channel();
    let (entered_tx, entered) = std::sync::mpsc::channel();
    let release = Arc::new(tokio::sync::Notify::new());
    request.font_reply = Some(FontPrepareReply::ModelSource(sender));
    request.model_source_ready = Some((entered_tx, Arc::clone(&release)));
    (request, reply, entered, release)
}

#[test]
fn original_jobs_prepare_source_exact_variant_and_actual_job_generation() {
    let env = env("model-jobs-source");
    for (index, path, variant) in [
        (0, "models/a/source.glb", None),
        (1, "models/a/low.glb", Some("low")),
    ] {
        let id = format!("model-job-{index}");
        let mut reference = env.reference.clone();
        reference.variant_id = variant.map(str::to_owned);
        let (returned, reply) = env
            .jobs
            .prepare_model_source(id.clone(), reference)
            .unwrap();
        assert_eq!(returned, id);
        let source = receive(reply).unwrap();
        let status = terminal(&env, &id);
        assert_eq!(source.entry().path, path);
        assert_eq!(status.state, JobState::Done);
        assert_eq!(
            status.package_hash.as_deref(),
            Some(env.reference.package_hash.as_str())
        );
        let (session, generation, task) = source.reservation_identity_for_test();
        assert_eq!(generation, status.generation);
        assert_eq!(task, "model-source");
        assert_eq!(session, format!("prepare-{id}-{generation}"));
        assert!(env.probe.budget_for_test().usage().asset_cpu_bytes > 0);
        assert!(!model_source_writable(
            env.jobs.assets(),
            &env.reference,
            path
        ));
        drop(source);
        drained(&env, &id, JobState::Done);
    }
    assert!(block_on(env.jobs.library().is_installed(&env.reference.package_hash)).unwrap());
}

#[test]
fn malformed_references_reject_before_slot_and_uninstalled_or_nonmodel_fail_in_original_worker() {
    let env = env("model-jobs-reject");
    let mut invalid = env.reference.clone();
    invalid.variant_id = Some("../escape".into());
    assert_eq!(
        env.jobs
            .prepare_model_source("invalid".into(), invalid)
            .err()
            .unwrap()
            .code,
        "invalid_input"
    );
    assert!(env.jobs.active_status().is_none());
    for (id, asset, variant, missing) in [
        ("unknown", "missing", None, false),
        ("nonmodel", "vector", None, false),
        ("exact", "first", Some("missing"), false),
        ("not-installed", "first", None, true),
    ] {
        let mut reference = env.reference.clone();
        reference.asset_id = asset.into();
        reference.variant_id = variant.map(str::to_owned);
        if missing {
            reference.package_hash = "0".repeat(64);
        }
        let (_, reply) = env.jobs.prepare_model_source(id.into(), reference).unwrap();
        let error = receive(reply).err().unwrap();
        assert_eq!(
            error.code,
            if missing {
                "asset_not_found"
            } else {
                "package_invalid"
            }
        );
        drained(&env, id, JobState::Failed);
    }
}

#[test]
fn cancelled_inspection_uses_original_slot_and_does_not_modify_installed_manifest_or_config() {
    let env = env("model-jobs-cancel-initial");
    let before: String = block_on(
        sqlx::query_scalar("SELECT manifest_json FROM packages WHERE package_hash=?")
            .bind(&env.reference.package_hash)
            .fetch_one(env.jobs.library().pool()),
    )
    .unwrap();
    let config = std::fs::read(env._root.path().join("config.json")).ok();
    let mut request = env
        .jobs
        .reserve(
            "cancelled-inspection".into(),
            JobSource::PrepareModelSource(env.reference.clone()),
            None,
        )
        .unwrap();
    request.inspection_checkpoint = Some(|cancel| cancel.store(true, Ordering::Release));
    let (sender, reply) = tokio::sync::oneshot::channel();
    request.font_reply = Some(FontPrepareReply::ModelSource(sender));
    env.jobs.dispatch(request).unwrap();
    assert_eq!(receive(reply).err().unwrap().code, "cancelled");
    drained(&env, "cancelled-inspection", JobState::Cancelled);
    let after: String = block_on(
        sqlx::query_scalar("SELECT manifest_json FROM packages WHERE package_hash=?")
            .bind(&env.reference.package_hash)
            .fetch_one(env.jobs.library().pool()),
    )
    .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        config,
        std::fs::read(env._root.path().join("config.json")).ok()
    );
}

#[test]
fn terminal_database_failure_drops_real_source_before_error_reply_and_reclaims_own_retained_ticket()
{
    let env = env("model-jobs-terminal-failure");
    let (request, reply, entered, release) = held_request(&env, "terminal-failure");
    env.jobs.dispatch(request).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(env.probe.budget_for_test().usage().asset_cpu_bytes > 0);
    assert!(!model_source_writable(
        env.jobs.assets(),
        &env.reference,
        "models/a/source.glb"
    ));
    block_on(env.jobs.library().pool().close());
    release.notify_one();
    assert_eq!(receive(reply).err().unwrap().code, "database");
    drained(&env, "terminal-failure", JobState::Failed);
    assert!(env
        .jobs
        .status("terminal-failure")
        .unwrap()
        .package_hash
        .is_none());
}

#[test]
fn cancel_during_real_terminal_database_wait_keeps_slot_then_drops_source_before_cancelled_reply() {
    let env = env("model-jobs-terminal-cancel");
    let (mut request, mut reply, entered, release) = held_request(&env, "terminal-cancel");
    let (pending_tx, pending) = std::sync::mpsc::channel();
    request.terminal_pending = Some(pending_tx);
    env.jobs.dispatch(request).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let transaction = block_on(env.jobs.library().pool().begin_with("BEGIN IMMEDIATE")).unwrap();
    release.notify_one();
    assert_eq!(
        pending.recv_timeout(Duration::from_secs(5)).unwrap(),
        JobState::Done
    );
    assert!(matches!(
        reply.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    assert_eq!(env.jobs.active_status().unwrap().job_id, "terminal-cancel");
    assert!(env.probe.budget_for_test().usage().asset_cpu_bytes > 0);
    assert_eq!(
        env.jobs
            .prepare_model_source("overlap".into(), env.reference.clone())
            .err()
            .unwrap()
            .code,
        "budget_busy"
    );
    env.jobs.cancel("terminal-cancel");
    block_on(transaction.commit()).unwrap();
    assert_eq!(receive(reply).err().unwrap().code, "cancelled");
    drained(&env, "terminal-cancel", JobState::Cancelled);
    let state: String = block_on(
        sqlx::query_scalar("SELECT state FROM install_jobs WHERE job_id=?")
            .bind("terminal-cancel")
            .fetch_one(env.jobs.library().pool()),
    )
    .unwrap();
    assert_eq!(state, "cancelled");
}

#[test]
fn lost_typed_receiver_during_database_wait_never_leaks_outer_source_or_asset_ticket() {
    let env = env("model-jobs-receiver-loss");
    let (mut request, reply, entered, release) = held_request(&env, "receiver-loss");
    let (pending_tx, pending) = std::sync::mpsc::channel();
    request.terminal_pending = Some(pending_tx);
    env.jobs.dispatch(request).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let transaction = block_on(env.jobs.library().pool().begin_with("BEGIN IMMEDIATE")).unwrap();
    release.notify_one();
    assert_eq!(
        pending.recv_timeout(Duration::from_secs(5)).unwrap(),
        JobState::Done
    );
    drop(reply);
    assert!(env.probe.budget_for_test().usage().asset_cpu_bytes > 0);
    block_on(transaction.commit()).unwrap();
    for _ in 0..100 {
        if env.probe.budget_for_test().usage().asset_cpu_bytes == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    drained(&env, "receiver-loss", JobState::Done);
}
