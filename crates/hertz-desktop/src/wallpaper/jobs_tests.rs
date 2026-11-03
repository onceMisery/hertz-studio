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
    package_with_image(&png)
}

fn package_with_image(png: &[u8]) -> Vec<u8> {
    package_with_image_mime(png, "image/png")
}

fn package_with_image_mime(png: &[u8], mime: &str) -> Vec<u8> {
    package_with_media(png, mime, "image")
}

fn package_with_media(png: &[u8], mime: &str, kind: &str) -> Vec<u8> {
    let length = png.len();
    let sha = format!("{:x}", Sha256::digest(png));
    let manifest = format!(
        r#"{{"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,
            "title":"静夜","description":"","content":{{"kind":"{kind}","asset":"background"}},
            "assets":[{{"id":"background","kind":"{kind}","source":"assets/background.png","variants":[]}}],
            "files":[{{"path":"assets/background.png","bytes":{length},"sha256":"{sha}","mime":"{mime}"}}],
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
            .start_file(
                "assets/background.png",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        std::io::Write::write_all(&mut writer, png).unwrap();
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
    env_with_probe(tag, ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })))
}

fn env_with_probe(tag: &str, probe: ProbeClient) -> TestEnv {
    env_with_capacity(tag, probe, super::super::content_quota::CAP)
}

fn env_with_capacity(tag: &str, probe: ProbeClient, capacity: u64) -> TestEnv {
    let root = tempfileish::temp_dir(tag);
    let library = futures_block_on(Library::open(root.path().join("db").as_path()));
    let library = futures_block_on(async { library.expect("open library") });
    let assets = AssetStore::new(root.path())
        .unwrap()
        .with_content_capacity(capacity);
    let bytes = sample_package();
    let source = root.path().join("source.hwpkg");
    std::fs::write(&source, &bytes).unwrap();
    TestEnv {
        // 文件事务测试明确注入探测器；生产 start 必须提供原生 ProbeClient。
        jobs: ImportJobs::start(library, assets, probe),
        root,
        source,
        bytes,
    }
}

/// 测试内同步驱动 async 初始化（与 worker 线程同一模式）。
fn futures_block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    // Pool 的维护任务需要持续存活的 runtime，不能每次查询后销毁。
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
fn content_quota_rejects_projection_and_receipt_before_decoding() {
    let probe = ProbeClient::testing(|_, _| Box::pin(async { Ok(()) }));
    let counts = probe.clone();
    // 原包与图片都能单独容纳，完整的不可变投影及收据不能容纳。
    let capacity = sample_package().len() as u64 + 70;
    let env = env_with_capacity("content-preflight", probe, capacity);
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let status = wait_terminal(&env.jobs, &id);
    assert_eq!(status.state, JobState::Failed);
    assert!(status.error.unwrap().starts_with("library_full:"));
    assert_eq!(counts.stats(), (0, 0));
    assert!(env.jobs.assets().package_dirs().is_empty());
    assert!(!env.root.path().join("staging").join(id).exists());
    assert_eq!(std::fs::read(&env.source).unwrap(), env.bytes);
}

#[test]
fn content_quota_allows_duplicate_at_capacity_and_preserves_existing_content() {
    let env = env("content-dedup-full");
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let status = wait_terminal(&env.jobs, &id);
    assert_eq!(status.state, JobState::Done);
    let hash = status.package_hash.unwrap();
    let package_dir = env.jobs.assets().package_dir(&hash);
    let capacity: u64 = [
        "original.hwpkg",
        "files/assets/background.png",
        "receipt.json",
    ]
    .iter()
    .map(|file| std::fs::metadata(package_dir.join(file)).unwrap().len())
    .sum();
    let library = futures_block_on(Library::open(&env.root.path().join("db"))).unwrap();
    let assets = AssetStore::new(env.root.path())
        .unwrap()
        .with_content_capacity(capacity);
    let probe = ProbeClient::testing(|_, _| Box::pin(async { Ok(()) }));
    let counts = probe.clone();
    let jobs = ImportJobs::start(library, assets, probe);
    let id = new_job_id();
    jobs.submit(id.clone(), env.source.clone()).unwrap();
    assert_eq!(wait_terminal(&jobs, &id).state, JobState::Done);
    assert_eq!(counts.stats(), (0, 1));
    assert_eq!(
        jobs.assets().package_dirs().as_slice(),
        std::slice::from_ref(&hash)
    );
    // 新字节需要新增目录，即使 packages.bytes 只记录原包也必须拒绝。
    let mut png = Vec::new();
    let mut writer = png::Encoder::new(&mut png, 2, 1);
    writer.set_color(png::ColorType::Rgba);
    let mut writer = writer.write_header().unwrap();
    writer
        .write_image_data(&[1, 2, 3, 255, 4, 5, 6, 255])
        .unwrap();
    writer.finish().unwrap();
    std::fs::write(&env.source, package_with_image(&png)).unwrap();
    let id = new_job_id();
    jobs.submit(id.clone(), env.source.clone()).unwrap();
    let status = wait_terminal(&jobs, &id);
    assert_eq!(status.state, JobState::Failed);
    assert!(status.error.unwrap().starts_with("library_full:"));
    assert_eq!(counts.stats(), (0, 1), "容量拒绝不能占解码器");
    assert_eq!(
        std::fs::read(package_dir.join("original.hwpkg")).unwrap(),
        env.bytes
    );
    assert!(jobs.assets().verify_installed(&hash).unwrap().is_some());
}

#[test]
fn content_quota_rechecks_actual_files_before_publication() {
    let root_path = Arc::new(std::sync::OnceLock::<PathBuf>::new());
    let observed = Arc::clone(&root_path);
    let capacity = 64 * 1024;
    let probe = ProbeClient::testing(move |_, _| {
        // 模拟初检之后发生的外部占用，不能用陈旧 DB/预检事实直接发布。
        std::fs::write(
            observed.get().unwrap().join("packages/manual-original"),
            vec![0; capacity as usize],
        )
        .unwrap();
        Box::pin(async { Ok(()) })
    });
    let env = env_with_capacity("content-final-check", probe, capacity);
    root_path.set(env.root.path().to_path_buf()).unwrap();
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let status = wait_terminal(&env.jobs, &id);
    assert_eq!(status.state, JobState::Failed);
    assert!(status.error.unwrap().starts_with("library_full:"));
    assert!(env.jobs.assets().package_dirs().is_empty());
    assert_eq!(
        std::fs::metadata(env.root.path().join("packages/manual-original"))
            .unwrap()
            .len(),
        capacity
    );
    assert!(!env.root.path().join("staging").join(id).exists());
}

#[test]
fn competing_content_writer_cannot_clean_another_jobs_staging() {
    let env = env("content-writer-collision");
    let other = AssetStore::new(env.root.path()).unwrap();
    let writer = other.content_writer().unwrap();
    assert_eq!(
        futures_block_on(reconcile_startup(env.jobs.library(), &other))
            .unwrap_err()
            .code,
        "budget_busy"
    );
    let id = new_job_id();
    let staging = env.root.path().join("staging").join(&id);
    std::fs::create_dir(&staging).unwrap();
    std::fs::write(staging.join("original.hwpkg"), b"in-flight").unwrap();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let status = wait_terminal(&env.jobs, &id);
    assert_eq!(status.state, JobState::Failed);
    assert!(status.error.unwrap().starts_with("budget_busy:"));
    assert_eq!(
        std::fs::read(staging.join("original.hwpkg")).unwrap(),
        b"in-flight"
    );
    drop(writer);
    // 崩溃恢复也服从同一写门；退出后才可重试。
    other.cleanup_staging(&id);
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Done);
}

#[test]
fn derived_cache_reuses_valid_generation_and_rebuilds_corruption_without_overwrite() {
    let env = env("derived-generations");
    let import = || {
        let id = new_job_id();
        env.jobs.submit(id.clone(), env.source.clone()).unwrap();
        let status = wait_terminal(&env.jobs, &id);
        assert_eq!(status.state, JobState::Done, "{:?}", status.error);
    };
    let cached = || {
        futures_block_on(async {
            let (path,): (String,) = sqlx::query_as("SELECT path FROM derived_entries")
                .fetch_one(env.jobs.library().pool())
                .await
                .unwrap();
            env.root.path().join("derived").join(path)
        })
    };
    import();
    let first = cached();
    let render = std::fs::read(first.join("render.png")).unwrap();
    import();
    assert_eq!(cached(), first, "相同输入与参数复用已核验结果");
    // 旧 render 仍被租用时损坏另一个产物；修复不得覆盖整个旧代际。
    use std::os::windows::fs::OpenOptionsExt;
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(first.join("render.png"))
        .unwrap();
    std::fs::write(first.join("thumbnail.png"), b"corrupt").unwrap();
    import();
    let repaired = cached();
    assert_ne!(repaired, first);
    assert_eq!(std::fs::read(first.join("render.png")).unwrap(), render);
    assert_eq!(std::fs::read(repaired.join("render.png")).unwrap(), render);
    assert_eq!(
        image::open(repaired.join("thumbnail.png")).unwrap().width(),
        1
    );
    drop(held);
}

#[test]
fn targeted_imports_keep_independent_variants_and_media_lifetimes() {
    use super::super::image_prepare::{self, ImageFit, ImagePurpose, ImageTarget, Receipt};
    let probe = ProbeClient::testing(|_, _| Box::pin(async { Ok(()) }))
        .environment_for_test(|| Some(qualification_environment("targeted")));
    let counts = probe.clone();
    let env = env_with_probe("targeted-import", probe.clone());
    let mut png = Vec::new();
    let mut encoder = png::Encoder::new(&mut png, 320, 160);
    encoder.set_color(png::ColorType::Rgba);
    let mut encoder = encoder.write_header().unwrap();
    encoder
        .write_image_data(&[32, 64, 128, 255].repeat(320 * 160))
        .unwrap();
    encoder.finish().unwrap();
    let package_bytes = package_with_image(&png);
    std::fs::write(&env.source, &package_bytes).unwrap();
    let cover = ImageTarget {
        width: 80,
        height: 80,
        fit: ImageFit::Cover,
        purpose: ImagePurpose::Low,
    };
    let contain = ImageTarget {
        fit: ImageFit::Contain,
        ..cover
    };
    let import = |target| {
        let id = new_job_id();
        env.jobs
            .submit_for_target(id.clone(), env.source.clone(), Some(target))
            .unwrap();
        let status = wait_terminal(&env.jobs, &id);
        assert_eq!(status.state, JobState::Done, "{:?}", status.error);
        status.package_hash.unwrap()
    };
    let hash = import(cover);
    let assets = env.jobs.assets();
    let library = env.jobs.library();
    let package = assets.read_installed_manifest(&hash).unwrap();
    let cancel = AtomicBool::new(false);
    let input = assets
        .probe_installed_media(&package, &cancel)
        .unwrap()
        .pop()
        .unwrap();
    let prepared = futures_block_on(image_prepare::prepare(
        assets,
        library,
        &probe,
        "cached-target",
        &input,
        Some(cover),
        &cancel,
    ))
    .unwrap();
    let first_key = prepared.content_key();
    let pinned = prepared.decode_input(assets, &input).unwrap();
    let first_path = pinned.media.path.clone();
    drop(prepared);
    assert_eq!(
        (
            pinned.metadata.encoded_width,
            pinned.metadata.encoded_height
        ),
        (160, 80)
    );
    assert_eq!(import(contain), hash);
    assert_eq!(import(cover), hash);
    assert_eq!(counts.stats(), (1, 2));
    let paths: Vec<String> = futures_block_on(
        sqlx::query_scalar("SELECT path FROM derived_entries").fetch_all(library.pool()),
    )
    .unwrap();
    assert_eq!(paths.len(), 2);
    let receipts: Vec<Receipt> = paths
        .iter()
        .map(|path| {
            serde_json::from_slice(
                &std::fs::read(
                    assets
                        .root()
                        .join("derived")
                        .join(path)
                        .join("receipt.json"),
                )
                .unwrap(),
            )
            .unwrap()
        })
        .collect();
    assert!(receipts
        .iter()
        .any(|r| (r.render.width, r.render.height) == (80, 40)));
    assert!(receipts
        .iter()
        .any(|r| format!("{}:{}", r.cache_key, r.render.sha256) == first_key));
    assert_eq!(
        std::fs::read(assets.package_dir(&hash).join("original.hwpkg")).unwrap(),
        package_bytes
    );
    futures_block_on(async {
        let writer = super::super::derived_cache::Writer::acquire(assets).unwrap();
        assert_eq!(
            writer.reclaim(library, 0, 0).await.unwrap_err().code,
            "cache_full"
        );
        assert!(first_path.is_file(), "更换目标不释放旧媒体的目录租约");
        drop(pinned);
        assert_eq!(writer.reclaim(library, 0, 0).await.unwrap().bytes, 0);
    });
    assert!(!first_path.exists());
}

#[test]
fn target_cache_rejects_receipt_dimensions_even_with_matching_file_hashes() {
    let env = env("target-receipt-corrupt");
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Done);
    let cached_path = || {
        futures_block_on(
            sqlx::query_scalar::<_, String>("SELECT path FROM derived_entries")
                .fetch_one(env.jobs.library().pool()),
        )
        .unwrap()
    };
    let first = cached_path();
    let receipt_path = env
        .root
        .path()
        .join("derived")
        .join(&first)
        .join("receipt.json");
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
    receipt["render"]["width"] = serde_json::json!(2);
    // render 字节/hash 未改：不能仅凭 hash 一致复用不符合目标的收据。
    std::fs::write(receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Done);
    assert_ne!(cached_path(), first);
}

#[test]
fn planner_prepares_installed_asset_without_source_and_admits_only_after_budget() {
    use super::super::image_prepare::{ImageFit, ImagePurpose, ImageTarget};
    use super::super::target_planner::{self, AssetRef, Resolution};
    let env = env("planner-installed");
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let hash = wait_terminal(&env.jobs, &id).package_hash.unwrap();
    std::fs::remove_file(&env.source).unwrap();
    let reference = AssetRef {
        package_hash: hash.clone(),
        asset_id: "background".into(),
        variant_id: None,
    };
    let target = ImageTarget {
        width: 80,
        height: 80,
        fit: ImageFit::Cover,
        purpose: ImagePurpose::Low,
    };
    let cancel = AtomicBool::new(false);
    let resolve = |target| {
        futures_block_on(target_planner::resolve(
            env.jobs.assets(),
            env.jobs.library(),
            &reference,
            target,
            &["image/png".into()],
            &cancel,
        ))
        .unwrap()
    };
    let before: i64 = futures_block_on(
        sqlx::query_scalar("SELECT COUNT(*) FROM derived_entries")
            .fetch_one(env.jobs.library().pool()),
    )
    .unwrap();
    let Resolution::PrepareRequired(request) = resolve(target) else {
        panic!("缺少目标必须请求后台准备")
    };
    let after: i64 = futures_block_on(
        sqlx::query_scalar("SELECT COUNT(*) FROM derived_entries")
            .fetch_one(env.jobs.library().pool()),
    )
    .unwrap();
    assert_eq!(before, after, "resolve 不隐式生成图片");
    let id = new_job_id();
    env.jobs.prepare_asset(id.clone(), request).unwrap();
    let status = wait_terminal(&env.jobs, &id);
    assert_eq!(status.state, JobState::Done, "{:?}", status.error);
    assert_eq!(status.staged_bytes, 0, "已安装包准备不复制原包");
    let Resolution::Ready(first) = resolve(target) else {
        panic!("准备后可解析")
    };
    let Resolution::Ready(reused) = resolve(target) else {
        panic!("同目标可复用")
    };
    assert_eq!(first.content_key(), reused.content_key());
    assert_eq!(first.input().media.path, reused.input().media.path);
    assert!(!first.url().contains(env.root.path().to_str().unwrap()));
    use super::super::session::{RecoveryLedger, SessionState, WallpaperSession};
    let budget = Arc::new(super::super::budget::BudgetCoordinator::new());
    let access = super::super::access::MediaAccess::new();
    let path = first.input().media.entry.path.clone();
    let recovery = RecoveryLedger::new();
    let mut session = WallpaperSession::new();
    let first_generation = attaching_media_session(&mut session, &recovery, 1);
    assert!(access.permit(&hash, &path).is_none());
    session
        .admit_media(
            first_generation,
            first,
            Arc::clone(&budget),
            &access,
            "live".into(),
        )
        .unwrap();
    let old_permit = access.permit(&hash, &path).unwrap();
    let held = budget.usage();
    assert_eq!(held.session_reservations, 1);
    assert_eq!(
        held.resource_allocations, 2,
        "解码与呈现只分配父计划的子额度"
    );
    let allocated = session.media_allocation().unwrap();
    assert_eq!(allocated.reserved, allocated.allocated);
    assert_eq!(
        session
            .admit_media(
                first_generation,
                resolve_ready(resolve(target)),
                Arc::clone(&budget),
                &access,
                "live".into()
            )
            .unwrap_err()
            .code,
        "stale_generation"
    );
    assert_eq!(budget.usage(), held, "重复准入不新增 token");

    let mut stale_controller = WallpaperSession::new();
    let stale_generation = attaching_media_session(&mut stale_controller, &recovery, 1);
    assert_eq!(
        stale_controller
            .admit_media(
                stale_generation,
                resolve_ready(resolve(target)),
                Arc::clone(&budget),
                &access,
                "stale-controller".into()
            )
            .unwrap_err()
            .code,
        "stale_generation"
    );
    assert_eq!(budget.usage(), held, "controller 拒绝时只回收本次 token");
    assert!(old_permit.is_active());
    let mut full = reused.budget_request("other".into(), 1).unwrap();
    full.targets = 3;
    let other = budget.grant(&full).unwrap();
    let mut candidate = WallpaperSession::new();
    let candidate_generation = attaching_media_session(&mut candidate, &recovery, 2);
    assert_eq!(
        candidate
            .admit_media(
                candidate_generation,
                resolve_ready(resolve(target)),
                Arc::clone(&budget),
                &access,
                "candidate".into()
            )
            .unwrap_err()
            .code,
        "budget_busy"
    );
    assert_eq!(candidate.state(), SessionState::Attaching);
    assert!(old_permit.is_active(), "候选预算失败不撤销当前壁纸");
    budget.confirm_exit(other, "other", 1).unwrap();
    budget.forget_released(other, "other", 1).unwrap();

    let second_generation = attaching_media_session(&mut session, &recovery, 2);
    assert!(!old_permit.is_active(), "换代先撤销旧读取");
    session
        .admit_media(
            second_generation,
            reused,
            Arc::clone(&budget),
            &access,
            "live".into(),
        )
        .unwrap();
    assert_eq!(budget.usage().targets, 2, "新旧代际按交接峰值一起计账");
    assert_eq!(budget.usage().release_pending, 1);
    assert_eq!(budget.usage().resource_allocations, 4);
    assert_eq!(budget.usage().resource_release_pending, 2);
    assert!(
        !session.controller_closed(second_generation),
        "活动代际不能被退出回执释放"
    );
    assert!(session.controller_closed(first_generation));
    assert_eq!(
        budget.usage().resource_release_pending,
        2,
        "controller Close 不能代替文件读者退出"
    );
    assert!(
        session.reap_resources().is_empty(),
        "controller 关闭仍须等待文件流"
    );
    assert!(
        access.permit(&hash, &path).unwrap().is_active(),
        "旧回收不能撤销新授权"
    );
    drop(old_permit);
    assert_eq!(session.reap_resources(), vec![first_generation]);
    assert_eq!(budget.usage().targets, 1, "只归还已退出的旧代际");
    assert_eq!(budget.usage().resource_allocations, 2);
    assert_eq!(budget.usage().resource_release_pending, 0);
    session.disable();
    assert_eq!(session.state(), SessionState::Disabled);
    assert!(session.controller_closed(second_generation));
    assert_eq!(session.reap_resources(), vec![second_generation]);
    assert_eq!(budget.usage(), Default::default());
    assert_eq!(
        std::fs::read(env.jobs.assets().package_dir(&hash).join("original.hwpkg")).unwrap(),
        env.bytes
    );
    cancel.store(true, Ordering::Release);
    assert_eq!(
        futures_block_on(target_planner::resolve(
            env.jobs.assets(),
            env.jobs.library(),
            &reference,
            target,
            &["image/png".into()],
            &cancel
        ))
        .err()
        .unwrap()
        .code,
        "cancelled"
    );
}

#[test]
fn planner_rejects_damaged_cache_and_preparation_shares_import_slot() {
    use super::super::image_prepare::{ImageFit, ImagePurpose, ImageTarget};
    use super::super::target_planner::{self, AssetRef, Resolution};
    let blocked = Arc::new(AtomicBool::new(false));
    let entered = Arc::new(AtomicBool::new(false));
    let block = Arc::clone(&blocked);
    let entry = Arc::clone(&entered);
    let probe = ProbeClient::testing(move |_, cancel| {
        let block = Arc::clone(&block);
        let entry = Arc::clone(&entry);
        Box::pin(async move {
            if block.load(Ordering::Acquire) {
                entry.store(true, Ordering::Release);
                while !cancel.load(Ordering::Acquire) {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                return Err(JobError::new("cancelled", "test cancellation"));
            }
            Ok(())
        })
    });
    let env = env_with_probe("planner-cancel", probe);
    let target = ImageTarget {
        width: 80,
        height: 80,
        fit: ImageFit::Cover,
        purpose: ImagePurpose::Low,
    };
    let id = new_job_id();
    env.jobs
        .submit_for_target(id.clone(), env.source.clone(), Some(target))
        .unwrap();
    let hash = wait_terminal(&env.jobs, &id).package_hash.unwrap();
    let reference = AssetRef {
        package_hash: hash.clone(),
        asset_id: "background".into(),
        variant_id: None,
    };
    let path: String = futures_block_on(
        sqlx::query_scalar("SELECT path FROM derived_entries").fetch_one(env.jobs.library().pool()),
    )
    .unwrap();
    std::fs::write(
        env.jobs
            .assets()
            .root()
            .join("derived")
            .join(path)
            .join("render.png"),
        b"broken",
    )
    .unwrap();
    let Resolution::PrepareRequired(request) = futures_block_on(target_planner::resolve(
        env.jobs.assets(),
        env.jobs.library(),
        &reference,
        target,
        &["image/png".into()],
        &AtomicBool::new(false),
    ))
    .unwrap() else {
        panic!("坏缓存不能标为 ready")
    };
    blocked.store(true, Ordering::Release);
    let id = new_job_id();
    env.jobs.prepare_asset(id.clone(), request).unwrap();
    for _ in 0..400 {
        if entered.load(Ordering::Acquire) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(entered.load(Ordering::Acquire));
    assert_eq!(
        env.jobs
            .submit(new_job_id(), env.source.clone())
            .unwrap_err()
            .code,
        "budget_busy"
    );
    env.jobs.cancel(&id);
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Cancelled);
    assert!(!env.jobs.assets().staging_dir(&id).exists());
    assert!(futures_block_on(env.jobs.library().is_installed(&hash)).unwrap());
    blocked.store(false, Ordering::Release);
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Done);
}

#[test]
fn cached_decode_input_keeps_generation_until_last_media_pin_exits() {
    let env = env("derived-media-lease");
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let status = wait_terminal(&env.jobs, &id);
    assert_eq!(status.state, JobState::Done, "{:?}", status.error);
    let hash = status.package_hash.unwrap();
    let assets = env.jobs.assets();
    let library = env.jobs.library();
    let package = assets.read_installed_manifest(&hash).unwrap();
    let cancel = AtomicBool::new(false);
    let source = assets
        .probe_installed_media(&package, &cancel)
        .unwrap()
        .pop()
        .unwrap();
    futures_block_on(async {
        sqlx::query("UPDATE derived_entries SET last_used = 0")
            .execute(library.pool())
            .await
            .unwrap();
        let probe = ProbeClient::testing(|_, _| Box::pin(async { Ok(()) }));
        let image = super::super::image_prepare::prepare(
            assets, library, &probe, "cached", &source, None, &cancel,
        )
        .await
        .unwrap();
        let used: i64 = sqlx::query_scalar("SELECT last_used FROM derived_entries")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert!(used > 0, "取得已复核代际时更新 LRU");
        let decoded = image.decode_input(assets, &source).unwrap();
        let held = Arc::clone(&decoded.media);
        drop(decoded);
        drop(image);
        let cache = super::super::derived_cache::Writer::acquire(assets).unwrap();
        assert_eq!(
            cache.reclaim(library, 0, 0).await.unwrap_err().code,
            "cache_full"
        );
        drop(held);
        assert_eq!(cache.reclaim(library, 0, 0).await.unwrap().bytes, 0);
        assert!(
            library.is_installed(&hash).await.unwrap(),
            "回收派生缓存不删除原包或作品"
        );
    });
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let restored = wait_terminal(&env.jobs, &id);
    assert_eq!(
        restored.state,
        JobState::Done,
        "可从原包重建：{:?}",
        restored.error
    );
}

fn qualification_environment(tag: &str) -> super::super::probe_environment::Environment {
    super::super::probe_environment::Environment {
        browser: "test-webview2".into(),
        fingerprint: format!("{:x}", Sha256::digest(tag.as_bytes())),
    }
}

#[test]
fn qualification_reuses_persisted_success_and_invalidates_changed_environment() {
    let environment = Arc::new(Mutex::new(qualification_environment("environment-a")));
    let provider = Arc::clone(&environment);
    let probe = ProbeClient::testing(|_, _| Box::pin(async { Ok(()) }))
        .environment_for_test(move || Some(provider.lock().unwrap().clone()));
    let counts = probe.clone();
    let env = env_with_probe("qualification-reuse", probe);
    let import = |jobs: &ImportJobs| {
        let id = new_job_id();
        jobs.submit(id.clone(), env.source.clone()).unwrap();
        let status = wait_terminal(jobs, &id);
        assert_eq!(status.state, JobState::Done, "{:?}", status.error);
    };
    import(&env.jobs);
    import(&env.jobs);
    assert_eq!(counts.stats(), (1, 1));
    *environment.lock().unwrap() = qualification_environment("environment-b");
    import(&env.jobs);
    assert_eq!(counts.stats(), (1, 2));
    // 新 Library/ProbeClient 模拟重启；不能依赖内存中的成功标志。
    let probe = ProbeClient::testing(|_, _| panic!("资格命中不应再创建 decoder"))
        .environment_for_test(|| Some(qualification_environment("environment-b")));
    let counts = probe.clone();
    let library = futures_block_on(Library::open(&env.root.path().join("db"))).unwrap();
    let jobs = ImportJobs::start(library, AssetStore::new(env.root.path()).unwrap(), probe);
    import(&jobs);
    assert_eq!(counts.stats(), (1, 0));
}

#[test]
fn qualification_never_remembers_decoder_failure_inconclusive_busy_or_cancel() {
    for code in [
        "decode_failed",
        "probe_inconclusive",
        "budget_busy",
        "cancelled",
    ] {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let probe = ProbeClient::testing(move |_, cancel| {
            let first = observed.fetch_add(1, Ordering::AcqRel) == 0;
            Box::pin(async move {
                if first && code == "cancelled" {
                    cancel.store(true, Ordering::Release);
                    Ok(())
                } else if first {
                    Err(JobError::new(code, "fixture failure"))
                } else {
                    Ok(())
                }
            })
        })
        .environment_for_test(|| Some(qualification_environment("stable")));
        let env = env_with_probe(&format!("qualification-{code}"), probe);
        let id = new_job_id();
        env.jobs.submit(id.clone(), env.source.clone()).unwrap();
        let failed = wait_terminal(&env.jobs, &id);
        assert_eq!(
            failed.state,
            if code == "cancelled" {
                JobState::Cancelled
            } else {
                JobState::Failed
            }
        );
        let count = futures_block_on(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media_qualifications")
                .fetch_one(env.jobs.library().pool()),
        )
        .unwrap();
        assert_eq!(count, 0, "{code} 不能形成成功资格");
        let retry = new_job_id();
        env.jobs.submit(retry.clone(), env.source.clone()).unwrap();
        assert_eq!(wait_terminal(&env.jobs, &retry).state, JobState::Done);
        assert_eq!(calls.load(Ordering::Acquire), 2);
    }
}

#[test]
fn qualification_discards_environment_changes_during_probe() {
    let environment = Arc::new(Mutex::new(qualification_environment("before")));
    let provider = Arc::clone(&environment);
    let changed = Arc::clone(&environment);
    let probe = ProbeClient::testing(move |_, _| {
        *changed.lock().unwrap() = qualification_environment("after");
        Box::pin(async { Ok(()) })
    })
    .environment_for_test(move || Some(provider.lock().unwrap().clone()));
    let counts = probe.clone();
    let env = env_with_probe("qualification-changing", probe);
    for expected in [0, 1, 1] {
        let id = new_job_id();
        env.jobs.submit(id.clone(), env.source.clone()).unwrap();
        assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Done);
        let count = futures_block_on(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media_qualifications")
                .fetch_one(env.jobs.library().pool()),
        )
        .unwrap();
        assert_eq!(count, expected);
    }
    assert_eq!(counts.stats(), (1, 2));
}

#[test]
fn qualification_does_not_cache_unknown_or_mismatched_browser_environment() {
    for browser in [None, Some("different-runtime")] {
        let probe = ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })).environment_for_test(
            move || {
                browser.map(|browser| super::super::probe_environment::Environment {
                    browser: browser.into(),
                    ..qualification_environment("unknown")
                })
            },
        );
        let counts = probe.clone();
        let env = env_with_probe("qualification-unknown", probe);
        for _ in 0..2 {
            let id = new_job_id();
            env.jobs.submit(id.clone(), env.source.clone()).unwrap();
            assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Done);
        }
        assert_eq!(counts.stats(), (0, 2));
    }
}

#[test]
fn qualification_database_failure_still_executes_real_decoder() {
    let probe = ProbeClient::testing(|_, _| Box::pin(async { Ok(()) }))
        .environment_for_test(|| Some(qualification_environment("stable")));
    let counts = probe.clone();
    let env = env_with_probe("qualification-db-failure", probe);
    futures_block_on(
        sqlx::query("DROP TABLE media_qualifications").execute(env.jobs.library().pool()),
    )
    .unwrap();
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Done);
    assert_eq!(counts.stats(), (0, 1));
}

#[test]
fn import_converts_embedded_p3_and_exif_without_changing_the_original() {
    let env = env("derived-p3-exif");
    let mut png = Vec::new();
    let mut info = png::Info::with_size(3, 2);
    info.color_type = png::ColorType::Rgba;
    info.bit_depth = png::BitDepth::Eight;
    info.icc_profile = Some(
        moxcms::ColorProfile::new_display_p3()
            .encode()
            .unwrap()
            .into(),
    );
    info.exif_metadata = Some(
        vec![
            b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ]
        .into(),
    );
    let mut writer = png::Encoder::with_info(&mut png, info)
        .unwrap()
        .write_header()
        .unwrap();
    writer
        .write_image_data(&[128, 64, 32, 127].repeat(6))
        .unwrap();
    writer.finish().unwrap();
    let package = package_with_image(&png);
    std::fs::write(&env.source, &package).unwrap();
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let status = wait_terminal(&env.jobs, &id);
    assert_eq!(status.state, JobState::Done, "{:?}", status.error);
    let (relative,): (String,) = futures_block_on(async {
        sqlx::query_as("SELECT path FROM derived_entries")
            .fetch_one(env.jobs.library().pool())
            .await
            .unwrap()
    });
    let path = env
        .root
        .path()
        .join("derived")
        .join(relative)
        .join("render.png");
    let pixels = image::open(&path).unwrap().into_rgba8();
    assert_eq!(pixels.dimensions(), (2, 3));
    let p = pixels.get_pixel(0, 0).0;
    assert!(p[0] > 135 && p[1] < 60 && p[2] < 30, "{p:?}");
    assert_eq!(p[3], 127);
    let reader = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()))
        .read_info()
        .unwrap();
    assert!(reader.info().srgb.is_some());
    assert!(reader.info().icc_profile.is_none());
    assert!(reader.info().exif_metadata.is_none());
    let installed = env.jobs.assets().package_dir(&status.package_hash.unwrap());
    assert_eq!(
        std::fs::read(installed.join("original.hwpkg")).unwrap(),
        package
    );
    assert_eq!(
        std::fs::read(installed.join("files/assets/background.png")).unwrap(),
        png
    );
}

#[test]
fn decoder_failure_prevents_publication_and_slot_is_reusable() {
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = Arc::clone(&calls);
    let env = env_with_probe(
        "import-decode-failure",
        ProbeClient::testing(move |input, _| {
            assert_eq!(input.metadata.encoded_width, 1);
            assert_eq!(input.metadata.codec, "png");
            assert!(
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&input.media.path)
                    .is_err(),
                "解码期间字节必须固定"
            );
            let call = observed.fetch_add(1, Ordering::AcqRel);
            Box::pin(async move {
                drop(input);
                if call == 0 {
                    Err(JobError::new(
                        "decode_failed",
                        "test decoder rejected pixels",
                    ))
                } else {
                    Ok(())
                }
            })
        }),
    );
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let failed = wait_terminal(&env.jobs, &id);
    assert_eq!(failed.state, JobState::Failed);
    assert!(failed.error.unwrap().starts_with("decode_failed:"));
    assert!(env.jobs.assets().package_dirs().is_empty());
    assert_eq!(
        super::super::derived_cache::directory_bytes(&env.root.path().join("derived")).unwrap(),
        0
    );
    assert!(!env.root.path().join("staging").join(&id).exists());
    let retry = new_job_id();
    env.jobs.submit(retry.clone(), env.source.clone()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &retry).state, JobState::Done);
}

#[test]
fn cancel_waits_for_decoder_exit_and_ignores_late_success() {
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (cancelled_tx, cancelled_rx) = std::sync::mpsc::channel();
    let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
    let exit_rx = Mutex::new(Some(exit_rx));
    let env = env_with_probe(
        "import-decoder-cancel",
        ProbeClient::testing(move |input, cancel| {
            let exit = exit_rx.lock().unwrap().take().unwrap();
            let cancelled_tx = cancelled_tx.clone();
            entered_tx.send(()).unwrap();
            Box::pin(async move {
                while !cancel.load(Ordering::Acquire) {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                cancelled_tx.send(()).unwrap();
                // 模拟已取消但尚未退出的 decoder，不能提前清 staging/还槽。
                exit.await.unwrap();
                drop(input);
                Ok(()) // 故意迟到的成功仍不得发布。
            })
        }),
    );
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    env.jobs.cancel(&id);
    cancelled_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert_eq!(env.jobs.status(&id).unwrap().state, JobState::Preparing);
    assert!(env.root.path().join("staging").join(&id).exists());
    let other = AssetStore::new(env.root.path()).unwrap();
    assert_eq!(other.content_writer().err().unwrap().code, "budget_busy");
    assert_eq!(
        env.jobs
            .submit(new_job_id(), env.source.clone())
            .unwrap_err()
            .code,
        "budget_busy"
    );
    exit_tx.send(()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Cancelled);
    assert!(other.content_writer().is_ok());
    assert!(!env.root.path().join("staging").join(&id).exists());
    assert!(env.jobs.assets().package_dirs().is_empty());
}

#[test]
fn strict_png_crc_failure_cannot_use_browser_tolerance_to_install() {
    use base64::Engine;
    let env = env_with_probe(
        "import-png-crc",
        ProbeClient::testing(|_, _| panic!("损坏 PNG 不应进入浏览器")),
    );
    let mut png = base64::engine::general_purpose::STANDARD
        .decode(FIXTURE_PNG_B64)
        .unwrap();
    png[55] ^= 1; // IDAT CRC；容器头/块边界/包摘要均合法。
    std::fs::write(&env.source, package_with_image(&png)).unwrap();
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let failed = wait_terminal(&env.jobs, &id);
    assert_eq!(failed.state, JobState::Failed);
    assert!(failed.error.unwrap().starts_with("decode_failed:"));
    assert!(env.jobs.assets().package_dirs().is_empty());
    assert!(!env.root.path().join("staging").join(id).exists());
}

#[test]
fn valid_package_hash_does_not_allow_invalid_or_animated_image_installation() {
    use base64::Engine;
    let env = env("import-media-admission");
    let png = base64::engine::general_purpose::STANDARD
        .decode(FIXTURE_PNG_B64)
        .unwrap();
    let mut oversized = png.clone();
    oversized[16..20].copy_from_slice(&16385u32.to_be_bytes());
    let mut apng = png[..33].to_vec();
    apng.extend_from_slice(&8u32.to_be_bytes());
    apng.extend_from_slice(b"acTL");
    apng.extend_from_slice(&[0; 12]);
    apng.extend_from_slice(&png[33..]);
    for package in [
        package_with_image(&oversized),
        package_with_image(&apng),
        package_with_image_mime(&png, "image/jpeg"),
    ] {
        // ZIP、manifest、尺寸/hash 合同本身均通过，仍不能跳过媒体资格。
        hertz_wallpaper::validate_package(std::io::Cursor::new(&package)).unwrap();
        std::fs::write(&env.source, &package).unwrap();
        let id = new_job_id();
        env.jobs.submit(id.clone(), env.source.clone()).unwrap();
        let result = wait_terminal(&env.jobs, &id);
        assert_eq!(result.state, JobState::Failed);
        assert!(result.error.unwrap().starts_with("format_unsupported:"));
        assert!(!env.root.path().join("staging").join(id).exists());
        assert!(env.jobs.assets().package_dirs().is_empty());
        assert!(futures_block_on(env.jobs.library().list_works(50, None))
            .unwrap()
            .0
            .is_empty());
    }
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
    assert_eq!(
        std::fs::read_dir(env.root.path().join("staging"))
            .unwrap()
            .count(),
        0
    );
    futures_block_on(async {
        let works = env.jobs.library().list_works(50, None).await.unwrap().0;
        assert_eq!(works.len(), 1);
    });
}

#[test]
fn idle_import_worker_keeps_driving_database_connection_returns() {
    let env = env("import-idle-pool");
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    let hash = wait_terminal(&env.jobs, &id).package_hash.unwrap();
    futures_block_on(async {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            for _ in 0..20 {
                assert!(env.jobs.library().is_installed(&hash).await.unwrap());
                assert_eq!(
                    env.jobs
                        .library()
                        .list_works(50, None)
                        .await
                        .unwrap()
                        .0
                        .len(),
                    1
                );
            }
        })
        .await
        .expect("导入 worker 空闲不能饿死连接归还任务");
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
    assert!(!env.root.path().join("staging").join(&job_id).exists());
    let next = new_job_id();
    env.jobs.submit(next.clone(), env.source.clone()).unwrap();
    let next_status = wait_terminal(&env.jobs, &next);
    assert_eq!(next_status.state, JobState::Done);
}

#[test]
fn failed_import_cleans_staging_and_oversize_is_rejected_before_copy() {
    let env = env("import-failure");
    std::fs::write(&env.source, b"invalid zip").unwrap();
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Failed);
    assert!(!env.root.path().join("staging").join(&id).exists());
    let oversized = env.root.path().join("oversized.hwpkg");
    std::fs::File::create(&oversized)
        .unwrap()
        .set_len(hertz_wallpaper::MAX_PACKAGE_BYTES + 1)
        .unwrap();
    let error = env
        .jobs
        .assets()
        .snapshot_input("oversized", &oversized, None)
        .unwrap_err();
    assert!(error.message.contains("package_too_large"));
    assert!(!env.root.path().join("staging/oversized").exists());
    assert_eq!(
        env.jobs
            .submit("../escape".into(), env.source.clone())
            .unwrap_err()
            .code,
        "invalid_input"
    );
}

#[test]
fn reimport_indexes_an_existing_orphan_and_repairs_a_missing_package() {
    let env = env("import-orphan");
    let assets = env.jobs.assets();
    assets.snapshot_input("orphan", &env.source, None).unwrap();
    let package = assets.validate_staged("orphan").unwrap();
    assets.unpack_projection("orphan", &package).unwrap();
    assets
        .content_writer()
        .unwrap()
        .publish_staging("orphan", &package.package_hash)
        .unwrap();
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Done);
    assert!(futures_block_on(env.jobs.library().is_installed(&package.package_hash)).unwrap());
    assert!(!env.root.path().join("staging").join(id).exists());

    // 索引保留、字节缺失时不能只靠 is_installed 提前返回成功。
    std::fs::remove_dir_all(assets.package_dir(&package.package_hash)).unwrap();
    futures_block_on(env.jobs.library().mark_unavailable(&package.package_hash)).unwrap();
    let id = new_job_id();
    env.jobs.submit(id.clone(), env.source.clone()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Done);
    assert!(assets
        .verify_installed(&package.package_hash)
        .unwrap()
        .is_some());
    let state: String = futures_block_on(
        sqlx::query_scalar("SELECT state FROM packages WHERE package_hash = ?1")
            .bind(&package.package_hash)
            .fetch_one(env.jobs.library().pool()),
    )
    .unwrap();
    assert_eq!(state, "installed");
}

#[tokio::test]
async fn crash_recovery_reindexes_orphans_and_marks_missing() {
    let root = tempfileish::temp_dir("recovery");
    let library = Library::open(root.path().join("db").as_path())
        .await
        .unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    // ① 孤立目录（rename 发布后 DB 提交前崩溃）→ 核验后恢复入库，不自动启用。
    let bytes = sample_package();
    let source = root.path().join("source.hwpkg");
    std::fs::write(&source, &bytes).unwrap();
    let receipt = assets.snapshot_input("job-1", &source, None).unwrap();
    let staged = assets.validate_staged("job-1").unwrap();
    assets.unpack_projection("job-1", &staged).unwrap();
    assets
        .content_writer()
        .unwrap()
        .publish_staging("job-1", &staged.package_hash)
        .unwrap();
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
    let missing: String = sqlx::query_scalar("SELECT state FROM packages WHERE package_hash = ?1")
        .bind(&fake_hash)
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(missing, "unavailable");
}

fn resolve_ready(
    resolution: super::super::target_planner::Resolution,
) -> super::super::target_planner::ResolvedMedia {
    match resolution {
        super::super::target_planner::Resolution::Ready(media) => media,
        _ => panic!("已准备的媒体应可解析"),
    }
}

fn attaching_media_session(
    session: &mut super::super::session::WallpaperSession,
    recovery: &super::super::session::RecoveryLedger,
    revision: u64,
) -> u64 {
    let generation = session.apply(revision, recovery).unwrap();
    assert!(session.resolved(generation));
    assert!(session.prepared(generation));
    generation
}

fn installed_media(
    env: &TestEnv,
    target: super::super::image_prepare::ImageTarget,
) -> super::super::target_planner::ResolvedMedia {
    use super::super::target_planner::{self, AssetRef};
    let id = new_job_id();
    env.jobs
        .submit_for_target(id.clone(), env.source.clone(), Some(target))
        .unwrap();
    let status = wait_terminal(&env.jobs, &id);
    assert_eq!(status.state, JobState::Done, "{:?}", status.error);
    resolve_ready(
        futures_block_on(target_planner::resolve(
            env.jobs.assets(),
            env.jobs.library(),
            &AssetRef {
                package_hash: status.package_hash.unwrap(),
                asset_id: "background".into(),
                variant_id: None,
            },
            target,
            &["image/png".into(), "video/webm".into()],
            &AtomicBool::new(false),
        ))
        .unwrap(),
    )
}

fn session_target() -> super::super::image_prepare::ImageTarget {
    use super::super::image_prepare::{ImageFit, ImagePurpose, ImageTarget};
    ImageTarget {
        width: 80,
        height: 80,
        fit: ImageFit::Cover,
        purpose: ImagePurpose::Low,
    }
}

#[test]
fn resolved_target_is_normalized_and_bound_to_the_cost_request() {
    use super::super::image_prepare::{ImagePurpose, ImageTarget};
    let env = env("session-target");
    let media = installed_media(
        &env,
        ImageTarget {
            width: 3840,
            height: 2160,
            purpose: ImagePurpose::Preview,
            ..session_target()
        },
    );
    assert_eq!(
        media.target(),
        ImageTarget {
            width: 960,
            height: 540,
            purpose: ImagePurpose::Preview,
            ..session_target()
        }
    );
    let request = media.budget_request("preview".into(), 1).unwrap();
    assert_eq!(request.owner, super::super::budget::OwnerKind::Preview);
    assert_eq!(request.targets, 0);
    assert_eq!(request.output_pixel_rate, 0, "静态图无连续输出");
    assert!(media.budget_request("preview".into(), 0).is_err());
}

#[test]
fn media_readiness_rejects_wrong_backend_and_frames_before_admission() {
    use super::super::session::{FrameKind, RecoveryLedger, SessionState, WallpaperSession};
    for missing in 0..3 {
        let env = env("session-ready");
        let media = installed_media(&env, session_target());
        let budget = Arc::new(super::super::budget::BudgetCoordinator::new());
        let access = super::super::access::MediaAccess::new();
        let recovery = RecoveryLedger::new();
        let mut session = WallpaperSession::new();
        let generation = attaching_media_session(&mut session, &recovery, 1);
        assert!(session.frame_submitted(generation, FrameKind::Gl));
        session
            .admit_media(
                generation,
                media,
                Arc::clone(&budget),
                &access,
                "live".into(),
            )
            .unwrap();
        assert!(!session.frame_submitted(generation, FrameKind::Gl));
        assert!(!session.frame_submitted(generation, FrameKind::Video));
        if missing != 0 {
            assert!(session.native_attached(generation));
        }
        if missing != 1 {
            assert!(session.page_handshake(generation));
        }
        if missing != 2 {
            assert!(session.frame_submitted(generation, FrameKind::Image));
        }
        assert_eq!(
            session.state(),
            SessionState::Attaching,
            "缺少事实不能 ready"
        );
        assert_eq!(session.diagnostics().applied_revision, None);
        match missing {
            0 => assert!(session.native_attached(generation)),
            1 => assert!(session.page_handshake(generation)),
            _ => assert!(session.frame_submitted(generation, FrameKind::Image)),
        }
        assert_eq!(session.state(), SessionState::Ready);
        assert_eq!(session.diagnostics().frame_kind, Some(FrameKind::Image));
        assert_eq!(
            session.request_media_pause(std::time::Instant::now()),
            None,
            "images need no video drain proof"
        );
        session.disable();
        assert!(
            session.reap_resources().is_empty(),
            "无读者也不能代替 controller 关闭"
        );
        assert!(session.controller_closed(generation));
        assert_eq!(session.reap_resources(), vec![generation]);
        assert_eq!(budget.usage(), Default::default());
    }
}

#[test]
fn restored_media_uses_new_generation_and_failure_keeps_reservation_until_exit() {
    use super::super::session::{FrameKind, RecoveryLedger, SessionState, WallpaperSession};
    let env = env("session-failure");
    let media = installed_media(&env, session_target());
    let budget = Arc::new(super::super::budget::BudgetCoordinator::new());
    let access = super::super::access::MediaAccess::new();
    let hash = media.reference().package_hash.clone();
    let path = media.input().media.entry.path.clone();
    let mut session = WallpaperSession::new();
    let recovery = RecoveryLedger::new();
    let generation = attaching_media_session(&mut session, &recovery, 1);
    session
        .admit_media(
            generation,
            media,
            Arc::clone(&budget),
            &access,
            "live".into(),
        )
        .unwrap();
    assert!(session.native_attached(generation));
    assert!(session.page_handshake(generation));
    assert!(session.frame_submitted(generation, FrameKind::Image));
    assert!(session.start_presentation(std::time::Instant::now()));
    assert!(session.display_missing(generation));
    assert!(access.permit(&hash, &path).is_none());
    assert_eq!(session.retiring_generations(), vec![generation]);
    assert!(session.reap_resources().is_empty());
    assert_eq!(budget.usage().targets, 1);
    assert!(session.controller_closed(generation));
    assert_eq!(session.reap_resources(), vec![generation]);
    assert!(session.display_restored(generation));
    assert!(
        !session.frame_submitted(generation, FrameKind::Image),
        "已回收代际的迟到首帧不能复活"
    );
    assert_eq!(
        session
            .admit_media(
                generation,
                installed_media(&env, session_target()),
                Arc::clone(&budget),
                &access,
                "live".into()
            )
            .unwrap_err()
            .code,
        "stale_generation"
    );
    assert!(
        !session.admit_resources(generation),
        "不能绕过媒体准入填写资源事实"
    );
    assert_eq!(session.state(), SessionState::Attaching);
    let next = session.generation();
    assert!(next > generation, "显示器恢复建立新 controller 代际");
    session
        .admit_media(
            next,
            installed_media(&env, session_target()),
            Arc::clone(&budget),
            &access,
            "live".into(),
        )
        .unwrap();
    assert!(!session.fail(generation, "late", "old", true));
    assert!(session.fail(next, "media_error", "failed", true));
    assert_eq!(session.state(), SessionState::Failed);
    assert_eq!(budget.usage().targets, 1);
    assert_eq!(budget.usage().release_pending, 1);
    assert!(session.controller_closed(next));
    assert_eq!(session.reap_resources(), vec![next]);
    assert_eq!(budget.usage(), Default::default());
}

#[test]
fn dropping_session_revokes_access_but_does_not_claim_physical_exit() {
    use super::super::session::{RecoveryLedger, WallpaperSession};
    let env = env("session-drop");
    let media = installed_media(&env, session_target());
    let hash = media.reference().package_hash.clone();
    let path = media.input().media.entry.path.clone();
    let budget = Arc::new(super::super::budget::BudgetCoordinator::new());
    let access = super::super::access::MediaAccess::new();
    let mut session = WallpaperSession::new();
    let generation = attaching_media_session(&mut session, &RecoveryLedger::new(), 1);
    session
        .admit_media(
            generation,
            media,
            Arc::clone(&budget),
            &access,
            "live".into(),
        )
        .unwrap();
    let reader = access.permit(&hash, &path).unwrap();
    drop(session);
    assert!(!reader.is_active());
    assert!(access.permit(&hash, &path).is_none());
    drop(reader);
    assert_eq!(
        budget.usage().targets,
        1,
        "Rust Drop 不是 controller 退出证明"
    );
    assert_eq!(budget.usage().release_pending, 1);
    assert_eq!(budget.stuck().len(), 1);
}

#[test]
fn video_session_counts_handoff_peak_and_holds_last_decoder_until_physical_exit() {
    use super::super::session::{FrameKind, RecoveryLedger, SessionState, WallpaperSession};
    use std::time::Duration;
    let mut env = env("session-video");
    env.bytes = package_with_media(
        include_bytes!("../../../../scripts/fixtures/wallpaper-vp8.webm"),
        "video/webm",
        "video",
    );
    std::fs::write(&env.source, &env.bytes).unwrap();
    let target = super::super::image_prepare::ImageTarget {
        width: 1920,
        height: 1080,
        ..session_target()
    };
    let first = installed_media(&env, target);
    let next_media = installed_media(&env, target);
    let third = next_media.budget_request("third".into(), 1).unwrap();
    let fps = next_media.input().metadata.fps_upper_bound.unwrap();
    assert_eq!(
        third.output_pixel_rate,
        (1920.0 * 1080.0 * fps).ceil() as u64
    );
    assert_eq!(third.decode_pixel_rate, (64.0 * 48.0 * fps).ceil() as u64);
    let budget = Arc::new(super::super::budget::BudgetCoordinator::new());
    let access = super::super::access::MediaAccess::new();
    let mut session = WallpaperSession::new();
    let recovery = RecoveryLedger::new();
    let old = attaching_media_session(&mut session, &recovery, 1);
    session
        .admit_media(old, first, Arc::clone(&budget), &access, "video".into())
        .unwrap();
    let duration = session
        .media()
        .unwrap()
        .input()
        .metadata
        .duration_ms
        .unwrap();
    assert_eq!(session.media_position_ms(), None);
    assert!(session.record_media_position(old, duration / 2));
    assert!(!session.record_media_position(old + 1, 5));
    assert!(!session.record_media_position(old, duration));
    assert!(!session.record_media_position(old, u64::MAX));
    assert_eq!(session.media_position_ms(), Some(duration / 2));
    let paused_at = std::time::Instant::now();
    assert_eq!(
        session.request_media_pause(paused_at),
        None,
        "first frame must precede a pause check"
    );
    assert!(!session.frame_submitted(old, FrameKind::Image));
    assert!(!session.frame_submitted(old, FrameKind::Gl));
    assert!(session.frame_submitted(old, FrameKind::Video));
    assert!(session.page_handshake(old));
    assert!(session.native_attached(old));
    assert_eq!(session.state(), SessionState::Ready);
    let pause_token = session.request_media_pause(paused_at).unwrap();
    assert_eq!(session.media_pause_confirmed(), Some(false));
    assert_eq!(
        session.request_media_pause(paused_at + Duration::from_secs(1)),
        Some(pause_token)
    );
    assert!(!session.confirm_media_pause(old + 1, pause_token, paused_at));
    assert!(!session.confirm_media_pause(old, pause_token + 1, paused_at));
    assert!(!session.media_pause_expired(paused_at + Duration::from_millis(1999)));
    assert!(session.clear_media_pause(paused_at + Duration::from_millis(1999)));
    assert_eq!(session.media_pause_confirmed(), None);
    assert!(!session.confirm_media_pause(old, pause_token, paused_at + Duration::from_secs(2)));
    let next_pause = session
        .request_media_pause(paused_at + Duration::from_secs(2))
        .unwrap();
    assert_ne!(next_pause, pause_token);
    assert!(!session.confirm_media_pause(old, pause_token, paused_at + Duration::from_secs(2)));
    assert!(session.confirm_media_pause(old, next_pause, paused_at + Duration::from_millis(2200)));
    assert_eq!(session.media_pause_confirmed(), Some(true));
    assert!(!session.media_pause_expired(paused_at + Duration::from_secs(300)));
    assert_eq!(
        budget.usage().decoder_slots,
        1,
        "confirmed soft pause keeps its decoder reservation"
    );
    assert!(session.clear_media_pause(paused_at + Duration::from_secs(301)));
    let timeout_at = paused_at + Duration::from_secs(302);
    let timeout_token = session.request_media_pause(timeout_at).unwrap();
    assert_eq!(
        session.request_media_pause(timeout_at + Duration::from_secs(1)),
        Some(timeout_token)
    );
    assert!(
        session.media_pause_expired(timeout_at + Duration::from_secs(2)),
        "repeated stop cannot extend the deadline"
    );
    assert!(
        !session.confirm_media_pause(old, timeout_token, timeout_at + Duration::from_secs(2)),
        "late proof cannot erase a missed deadline"
    );
    assert!(
        !session.clear_media_pause(timeout_at + Duration::from_secs(2)),
        "late resume cannot erase an expired native deadline"
    );
    assert_eq!(session.media_pause_confirmed(), Some(false));
    assert_eq!(
        budget.usage().decoder_slots,
        1,
        "timeout itself is not physical exit"
    );
    let next = attaching_media_session(&mut session, &recovery, 2);
    assert_eq!(
        session.media_position_ms(),
        None,
        "retired position cannot leak into a new media generation"
    );
    session
        .admit_media(
            next,
            next_media,
            Arc::clone(&budget),
            &access,
            "video".into(),
        )
        .unwrap();
    assert!(!session.record_media_position(old, 0));
    assert_eq!(session.media_pause_confirmed(), None);
    assert!(!session.confirm_media_pause(old, next_pause, paused_at));
    assert_eq!(session.media_position_ms(), None);
    assert!(session.record_media_position(next, 0));
    assert_eq!(budget.usage().decoder_slots, 2);
    assert_eq!(budget.grant(&third).unwrap_err().quota, "decoder_slots");
    assert!(
        session.reap_resources().is_empty(),
        "流已退出也须等独立 controller 关闭"
    );
    assert_eq!(budget.usage().decoder_slots, 2);
    assert!(session.controller_closed(old));
    assert_eq!(session.reap_resources(), vec![old]);
    assert!(!session.controller_closed(old), "重复关闭不命中新代际");
    assert_eq!(budget.usage().decoder_slots, 1);
    let token = budget.grant(&third).unwrap();
    budget.confirm_exit(token, "third", 1).unwrap();
    budget.forget_released(token, "third", 1).unwrap();
    session.disable();
    assert_eq!(session.media_position_ms(), None);
    assert!(!session.record_media_position(next, 10));
    assert!(session.controller_closed(next));
    assert_eq!(session.reap_resources(), vec![next]);
    assert_eq!(budget.usage(), Default::default());
}

#[test]
fn desktop_session_rejects_preview_owner_before_granting_any_resources() {
    use super::super::image_prepare::{ImagePurpose, ImageTarget};
    use super::super::session::{RecoveryLedger, WallpaperSession};
    let env = env("session-owner");
    let media = installed_media(
        &env,
        ImageTarget {
            purpose: ImagePurpose::Preview,
            ..session_target()
        },
    );
    let budget = Arc::new(super::super::budget::BudgetCoordinator::new());
    let access = super::super::access::MediaAccess::new();
    let mut session = WallpaperSession::new();
    let generation = attaching_media_session(&mut session, &RecoveryLedger::new(), 1);
    assert_eq!(
        session
            .admit_media(
                generation,
                media,
                Arc::clone(&budget),
                &access,
                "live".into()
            )
            .unwrap_err()
            .code,
        "invalid_input"
    );
    assert_eq!(budget.usage(), Default::default());
    assert!(session.media().is_none());
}

#[test]
fn accepted_import_dispatch_failure_is_durable_and_releases_the_source() {
    let mut env = env("dispatch-failure");
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    drop(rx);
    env.jobs.submit_tx = tx;
    let job_id = new_job_id();
    let identity = ImportIdentity {
        request_id: "failed-dispatch".into(),
        payload_digest: "digest".into(),
    };
    let tokens = super::super::file_tokens::FileTokens::default();
    tokens.set_owner(1);
    let now = std::time::Instant::now();
    let ticket = tokens
        .issue(
            1,
            super::super::file_tokens::SelectedFile::open(&env.source).unwrap(),
            now,
        )
        .unwrap();
    let file = tokens.consume(1, &ticket.file_token, now).unwrap();
    let error =
        futures_block_on(env.jobs.submit_authorized(job_id.clone(), file, identity)).unwrap_err();
    assert_eq!(error.code, "worker_unavailable");
    assert!(env.jobs.active_status().is_none());
    std::fs::remove_file(&env.source).unwrap();
    let status = futures_block_on(env.jobs.library.persisted_job(&job_id))
        .unwrap()
        .unwrap();
    assert_eq!(status.state, JobState::Failed);
    assert!(status.error.unwrap().starts_with("worker_unavailable:"));
    assert_eq!(
        futures_block_on(env.jobs.library.import_operation("failed-dispatch"))
            .unwrap()
            .unwrap()
            .job_id,
        job_id
    );
}

#[test]
fn restart_marks_unfinished_accepted_imports_interrupted_and_preserves_their_identity() {
    let env = env("interrupted-acceptance");
    let status = JobStatus {
        job_id: "lost-job".into(),
        state: JobState::Queued,
        error: None,
        package_hash: None,
        staged_bytes: 0,
        generation: 1,
    };
    let identity = ImportIdentity {
        request_id: "lost-request".into(),
        payload_digest: "digest".into(),
    };
    futures_block_on(env.jobs.library.accept_import(&status, &identity)).unwrap();
    futures_block_on(reconcile_startup(&env.jobs.library, &env.jobs.assets)).unwrap();
    let interrupted = futures_block_on(env.jobs.library.persisted_job("lost-job"))
        .unwrap()
        .unwrap();
    assert_eq!(interrupted.state, JobState::Failed);
    assert!(interrupted
        .error
        .as_ref()
        .unwrap()
        .starts_with("interrupted:"));
    assert_eq!(
        futures_block_on(env.jobs.library.import_operation("lost-request"))
            .unwrap()
            .unwrap()
            .job_id,
        "lost-job"
    );
    futures_block_on(env.jobs.library.interrupt_imports()).unwrap();
    assert_eq!(
        futures_block_on(env.jobs.library.persisted_job("lost-job"))
            .unwrap()
            .unwrap()
            .error,
        interrupted.error
    );
}

#[test]
fn raw_image_import_preserves_fixed_bytes_and_reimport_after_rename_is_idempotent() {
    let env = env("raw-image");
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD
        .decode(FIXTURE_PNG_B64)
        .unwrap();
    let source = env.root.path().join("我的图片.jpg"); // 魔数优先，不能信任扩展名。
    std::fs::write(&source, &png).unwrap();
    let first = env.jobs.submit(new_job_id(), source.clone()).unwrap();
    let status = wait_terminal(&env.jobs, &first);
    assert_eq!(status.state, JobState::Done, "{status:?}");
    let hash = status.package_hash.unwrap();
    let installed = env.jobs.assets.package_dir(&hash);
    assert_eq!(
        std::fs::read(installed.join("files/assets/background.png")).unwrap(),
        png
    );
    let mut package =
        zip::ZipArchive::new(std::fs::File::open(installed.join("original.hwpkg")).unwrap())
            .unwrap();
    let mut manifest = String::new();
    std::io::Read::read_to_string(
        &mut package.by_name("manifest.json").unwrap(),
        &mut manifest,
    )
    .unwrap();
    assert!(!manifest.contains(&env.root.path().to_string_lossy().replace('\\', "\\\\")));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&manifest).unwrap()["title"],
        "我的图片"
    );
    let renamed = env.root.path().join("另一个名字.webm");
    std::fs::rename(&source, &renamed).unwrap();
    let second = env.jobs.submit(new_job_id(), renamed.clone()).unwrap();
    let second = wait_terminal(&env.jobs, &second);
    assert_eq!(second.state, JobState::Done, "{second:?}");
    assert_eq!(second.package_hash.as_deref(), Some(hash.as_str()));
    std::fs::remove_file(renamed).unwrap();
    futures_block_on(reconcile_startup(&env.jobs.library, &env.jobs.assets)).unwrap();
    assert!(env.jobs.assets.verify_installed(&hash).unwrap().is_some());
    assert_eq!(
        futures_block_on(env.jobs.library.list_works(50, None))
            .unwrap()
            .0
            .len(),
        1
    );
}

#[test]
fn invalid_raw_media_never_publishes_a_package() {
    let env = env("raw-unsupported");
    let source = env.root.path().join("fake.png");
    std::fs::write(&source, b"not an image or video").unwrap();
    let id = env.jobs.submit(new_job_id(), source).unwrap();
    let status = wait_terminal(&env.jobs, &id);
    assert_eq!(status.state, JobState::Failed);
    assert!(status.error.unwrap().starts_with("format_unsupported:"));
    assert!(!env.jobs.assets.staging_dir(&id).exists());
    assert!(futures_block_on(env.jobs.library.installed_hashes())
        .unwrap()
        .is_empty());
}

#[test]
fn preview_session_admits_only_preview_targets_and_waits_for_real_exit() {
    use super::super::image_prepare::{ImagePurpose, ImageTarget};
    use super::super::session::{RecoveryLedger, WallpaperSession};
    let env = env("preview-owner");
    let budget = Arc::new(super::super::budget::BudgetCoordinator::new());
    let access = super::super::access::MediaAccess::new();
    let mut session = WallpaperSession::preview_after_generation(2);
    let generation = attaching_media_session(&mut session, &RecoveryLedger::new(), 1);
    assert_eq!(
        session
            .admit_media(
                generation,
                installed_media(&env, session_target()),
                Arc::clone(&budget),
                &access,
                "preview".into()
            )
            .unwrap_err()
            .code,
        "invalid_input"
    );
    assert_eq!(budget.usage(), Default::default());
    let media = installed_media(
        &env,
        ImageTarget {
            purpose: ImagePurpose::Preview,
            ..session_target()
        },
    );
    session
        .admit_media(
            generation,
            media,
            Arc::clone(&budget),
            &access,
            "preview".into(),
        )
        .unwrap();
    assert_eq!(budget.usage().preview_instances, 1);
    session.disable();
    assert_eq!(
        budget.usage().preview_instances,
        1,
        "requesting release is not an exit"
    );
    assert!(session.controller_closed(generation));
    assert_eq!(session.reap_resources(), vec![generation]);
    assert_eq!(budget.usage(), Default::default());
}
