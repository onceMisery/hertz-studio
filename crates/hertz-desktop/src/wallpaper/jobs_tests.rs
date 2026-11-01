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
    let length = png.len();
    let sha = format!("{:x}", Sha256::digest(png));
    let manifest = format!(
        r#"{{"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,
            "title":"静夜","description":"","content":{{"kind":"image","asset":"background"}},
            "assets":[{{"id":"background","kind":"image","source":"assets/background.png","variants":[]}}],
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
    let root = tempfileish::temp_dir(tag);
    let library = futures_block_on(Library::open(root.path().join("db").as_path()));
    let library = futures_block_on(async { library.expect("open library") });
    let assets = AssetStore::new(root.path()).unwrap();
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
        std::fs::read_dir(env.root.path().join("derived"))
            .unwrap()
            .count(),
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
    assert_eq!(
        env.jobs
            .submit(new_job_id(), env.source.clone())
            .unwrap_err()
            .code,
        "budget_busy"
    );
    exit_tx.send(()).unwrap();
    assert_eq!(wait_terminal(&env.jobs, &id).state, JobState::Cancelled);
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
