// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 导入任务端到端测试（P1-02 交付证据）：安装事务、重复导入幂等、单槽
//! budget_busy、取消后真实退出还槽、崩溃恢复（孤立目录入库 / 目录缺失标记）。
//! 经 `#[path]` 挂在 jobs.rs 的 `mod tests` 下（hertz-desktop 是 bin-only crate）。

use super::*;
use crate::wallpaper::library::tempfileish;
use sha2::{Digest, Sha256};

const FIXTURE_PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

fn sample_package() -> Vec<u8> {
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD
        .decode(FIXTURE_PNG_B64)
        .unwrap();
    assert_eq!(png.len(), 70);
    let sha = format!("{:x}", Sha256::digest(&png));
    let manifest = format!(
        r#"{{"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,
            "title":"静夜","description":"","content":{{"kind":"image","asset":"background"}},
            "assets":[{{"id":"background","kind":"image","source":"assets/background.png","variants":[]}}],
            "files":[{{"path":"assets/background.png","bytes":70,"sha256":"{sha}","mime":"image/png"}}],
            "properties":[],"permissions":{{"audioSpectrum":false,"pointer":false}},
            "license":{{"code":"none","assets":"CC0-1.0","attribution":""}}}}"#
    );
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        writer
            .start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut writer, manifest.as_bytes()).unwrap();
        writer
            .start_file("assets/background.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut writer, &png).unwrap();
        writer.finish().unwrap();
    }
    buffer.into_inner()
}

struct TestEnv {
    jobs: ImportJobs,
    root: tempfileish::TempDir,
    source: PathBuf,
    bytes: Vec<u8>,
}

fn env(tag: &str) -> TestEnv {
    let root = tempfileish::temp_dir(tag);
    let library = futures_block_on(Library::open(root.path().join("db").as_path()));
    let library = futures_block_on(async { library.expect("open library") });
    let assets = AssetStore::new(root.path()).unwrap();
    let bytes = sample_package();
    let source = root.path().join("source.hwpkg");
    std::fs::write(&source, &bytes).unwrap();
    TestEnv {
        jobs: ImportJobs::start(library, assets),
        root,
        source,
        bytes,
    }
}

/// 测试内同步驱动 async 初始化（与 worker 线程同一模式）。
fn futures_block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

fn wait_terminal(jobs: &ImportJobs, job_id: &str) -> JobStatus {
    for _ in 0..400 {
        if let Some(status) = jobs.status(job_id) {
            if matches!(
                status.state,
                JobState::Done | JobState::Failed | JobState::Cancelled
            ) {
                return status;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    panic!("任务 10s 内未终结");
}

#[test]
fn import_installs_package_and_library_rows() {
    let env = env("import-ok");
    let job_id = new_job_id();
    env.jobs.submit(job_id.clone(), env.source.clone()).unwrap();
    let status = wait_terminal(&env.jobs, &job_id);
    assert_eq!(status.state, JobState::Done, "{:?}", status.error);
    let hash = status.package_hash.clone().unwrap();
    assert_eq!(hash, format!("{:x}", Sha256::digest(&env.bytes)));
    assert!(env.jobs.assets().verify_installed(&hash).unwrap().is_some());
    futures_block_on(async {
        let works = env.jobs.library().list_works(50, None).await.unwrap().0;
        assert_eq!(works.len(), 1);
        assert_eq!(works[0].kind, "image");
        assert!(env.jobs.library().is_installed(&hash).await.unwrap());
    });
    // 单槽：任务终结后可再次受理。
    let again = new_job_id();
    env.jobs.submit(again.clone(), env.source.clone()).unwrap();
    let second = wait_terminal(&env.jobs, &again);
    assert_eq!(second.state, JobState::Done);
}

#[test]
fn duplicate_import_is_idempotent() {
    let env = env("import-dup");
    let first = new_job_id();
    env.jobs.submit(first.clone(), env.source.clone()).unwrap();
    let status = wait_terminal(&env.jobs, &first);
    let hash = status.package_hash.unwrap();
    let second = new_job_id();
    env.jobs.submit(second.clone(), env.source.clone()).unwrap();
    let second_status = wait_terminal(&env.jobs, &second);
    assert_eq!(second_status.state, JobState::Done);
    assert_eq!(second_status.package_hash.unwrap(), hash);
    // 物理上只有一份包目录；库里只有一份作品（§7.2/C19 前置）。
    assert_eq!(env.jobs.assets().package_dirs().len(), 1);
    futures_block_on(async {
        let works = env.jobs.library().list_works(50, None).await.unwrap().0;
        assert_eq!(works.len(), 1);
    });
}

#[test]
fn second_submit_while_busy_is_rejected() {
    // 64 MiB 稀疏源：复制+校验耗时足以观察槽占用（§12.1 资源准备任务一个）。
    let env = env("import-busy");
    let big = env.root.path().join("big.hwpkg");
    let file = std::fs::File::create(&big).unwrap();
    file.set_len(64 * 1024 * 1024).unwrap();
    drop(file);
    let first = new_job_id();
    env.jobs.submit(first.clone(), big).unwrap();
    let second = new_job_id();
    let error = env.jobs.submit(second, env.source.clone()).unwrap_err();
    assert_eq!(error.code, "budget_busy");
    let status = wait_terminal(&env.jobs, &first);
    assert!(matches!(
        status.state,
        JobState::Done | JobState::Cancelled | JobState::Failed
    ));
}

#[test]
fn cancel_eventually_frees_the_slot() {
    let env = env("import-cancel");
    let big = env.root.path().join("big.hwpkg");
    let file = std::fs::File::create(&big).unwrap();
    file.set_len(64 * 1024 * 1024).unwrap();
    drop(file);
    let job_id = new_job_id();
    env.jobs.submit(job_id.clone(), big).unwrap();
    env.jobs.cancel(&job_id);
    let status = wait_terminal(&env.jobs, &job_id);
    // 取消语义：作废代际后等真实 I/O 退出；慢任务进 Cancelled，快任务可能
    // 已完成——两者都必须归还槽（§7.1）。
    assert!(matches!(status.state, JobState::Cancelled | JobState::Done));
    let next = new_job_id();
    env.jobs.submit(next.clone(), env.source.clone()).unwrap();
    let next_status = wait_terminal(&env.jobs, &next);
    assert_eq!(next_status.state, JobState::Done);
}

#[tokio::test]
async fn crash_recovery_reindexes_orphans_and_marks_missing() {
    let root = tempfileish::temp_dir("recovery");
    let library = Library::open(root.path().join("db").as_path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    // ① 孤立目录（rename 发布后 DB 提交前崩溃）→ 核验后恢复入库，不自动启用。
    let bytes = sample_package();
    let source = root.path().join("source.hwpkg");
    std::fs::write(&source, &bytes).unwrap();
    let receipt = assets.snapshot_input("job-1", &source, None).unwrap();
    let staged = assets.validate_staged("job-1").unwrap();
    assets.unpack_projection("job-1", &staged).unwrap();
    assets.publish_staging("job-1", &staged.package_hash).unwrap();
    assert!(!library.is_installed(&staged.package_hash).await.unwrap());
    reconcile_startup(&library, &assets).await.unwrap();
    assert!(library.is_installed(&staged.package_hash).await.unwrap());
    assert_eq!(receipt.sha256, staged.package_hash);
    // ② 索引在目录缺 → unavailable（§7.2：保留引用并报告，不改默认）。
    let fake_hash = format!("{:064x}", 7);
    library
        .install(&crate::wallpaper::library::InstallWork {
            remote_work_id: "ghost".into(),
            work_key: "key-ghost".into(),
            title: "幽灵".into(),
            description: String::new(),
            kind: "image".into(),
            package_hash: fake_hash.clone(),
            manifest_json: "{}".into(),
            package_bytes: 1,
            version: 1,
            source_id: LOCAL_SOURCE.into(),
        })
        .await
        .unwrap();
    reconcile_startup(&library, &assets).await.unwrap();
    let missing: String =
        sqlx::query_scalar("SELECT state FROM packages WHERE package_hash = ?1")
            .bind(&fake_hash)
            .fetch_one(library.pool())
            .await
            .unwrap();
    assert_eq!(missing, "unavailable");
}
