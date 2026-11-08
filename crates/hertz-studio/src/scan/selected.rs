// SPDX-License-Identifier: MIT
//! Selected imports share scan admission/parsing but have no deletion scope.
use super::*;

pub const MAX_SELECTIONS: usize = 256;

/// Narrow service-thread capability carried to the native main window.
#[derive(Clone)]
pub struct FileImporter {
    job: ScanJob,
    runtime: tokio::runtime::Handle,
}

impl FileImporter {
    pub fn new(state: &AppState) -> Self {
        Self {
            job: ScanJob::from_state(state),
            runtime: tokio::runtime::Handle::current(),
        }
    }

    /// Completion means the scan was admitted; progress/results use the existing owner.
    pub fn start(
        &self,
        paths: Vec<PathBuf>,
        completion: impl FnOnce(Result<(), String>) + Send + 'static,
    ) {
        let job = self.job.clone();
        self.runtime.spawn(async move {
            completion(start_selected(job, paths).await);
        });
    }
}

pub(super) async fn start_selected(job: ScanJob, paths: Vec<PathBuf>) -> Result<(), String> {
    if paths.is_empty() || paths.len() > MAX_SELECTIONS {
        return Err("请选择 1 至 256 个文件或目录".into());
    }
    {
        let mut progress = job.progress.lock().await;
        if progress.running {
            return Err("已有扫描正在进行，请等待完成或取消后重试".into());
        }
        job.cancel.store(false, Ordering::Relaxed);
        *progress = ScanProgress {
            running: true,
            phase: "walking".into(),
            ..Default::default()
        };
        job.publish(&progress);
    }
    let db = job.db.clone();
    let progress = job.progress.clone();
    let events = job.events.clone();
    spawn_guarded(run_selected(job, paths), db, progress, events, None);
    Ok(())
}

async fn run_selected(job: ScanJob, paths: Vec<PathBuf>) {
    let cancel = job.cancel.clone();
    let result = tokio::task::spawn_blocking(move || collect_selected(paths, &cancel)).await;
    match result {
        Ok(report) => {
            if let Err(error) = job.scan_report(None, report).await {
                job.error(Path::new("本次导入"), error).await;
            }
        }
        Err(error) => job.error(Path::new("本次导入"), error).await,
    }
    job.finish(None).await;
}

fn collect_selected(paths: Vec<PathBuf>, cancel: &AtomicBool) -> vmusic_library::WalkReport {
    let mut report = vmusic_library::WalkReport::default();
    let mut inputs = HashSet::new();
    let mut files = HashSet::new();
    for input in paths {
        if cancel.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }
        let validated = (|| {
            if !input.is_absolute() {
                return Err("文件位置必须是绝对路径".into());
            }
            vmusic_library::ensure_local_root(&input)?;
            let path = std::fs::canonicalize(&input).map_err(|e| e.to_string())?;
            vmusic_library::ensure_local_root(&path)?;
            Ok::<_, String>(standard_path(path))
        })();
        let path = match validated {
            Ok(path) => path,
            Err(error) => {
                add_error(&mut report, input, error);
                continue;
            }
        };
        if !inputs.insert(path.clone()) {
            continue;
        }
        if path.is_dir() {
            let part = vmusic_library::collect_audio_files_checked(&path, cancel);
            report.cancelled |= part.cancelled;
            report.error_count += part.error_count;
            let remaining = MAX_ERRORS.saturating_sub(report.errors.len());
            report
                .errors
                .extend(part.errors.into_iter().take(remaining));
            for file in part.files {
                if cancel.load(Ordering::Relaxed) {
                    report.cancelled = true;
                    break;
                }
                files.insert(vmusic_store::track_path_key(&file));
            }
        } else if path.is_file() && vmusic_library::is_audio_file(&path) {
            files.insert(path);
        }
    }
    report.files = files.into_iter().collect();
    report.files.sort();
    report
}

fn add_error(report: &mut vmusic_library::WalkReport, path: PathBuf, error: String) {
    report.error_count += 1;
    if report.errors.len() < MAX_ERRORS {
        report.errors.push((path, error));
    }
}
