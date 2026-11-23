// SPDX-License-Identifier: MIT
//! Thin Windows handoff to the existing package transaction/NSIS installer.
use std::path::{Path, PathBuf};

use super::release::InstallKind;
use super::Failure;
#[cfg(windows)]
use super::MAX_PACKAGE_BYTES;
use crate::state::AppState;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub status: String,
    pub version: String,
    pub message: String,
    pub log: String,
    pub completed_at: u64,
}

pub(super) fn last_result(data: &Path) -> Option<InstallResult> {
    let root = data.join("cache/updates");
    safe_directory(&root, data).ok()?;
    let value = read_json(&root.join("last-install.json"), 8 * 1024).ok()?;
    let result: InstallResult = serde_json::from_value(value).ok()?;
    (matches!(result.status.as_str(), "updated" | "failed")
        && super::release::Version::parse(&result.version).is_some())
    .then_some(result)
}

#[derive(Clone, Debug)]
pub(super) struct Installation {
    pub directory: PathBuf,
    pub kind: InstallKind,
}

impl Installation {
    pub fn discover(_state: &AppState) -> Result<Self, String> {
        if !cfg!(all(
            windows,
            target_arch = "x86_64",
            feature = "native-window",
            feature = "full"
        )) {
            return Err("当前运行方式请从发布页面下载对应版本".into());
        }
        if env!("HERTZ_BUILD_PROFILE") != "release" {
            return Err("开发构建请使用发布页面；应用内安装需要正式程序包".into());
        }
        let executable = std::env::current_exe().map_err(|_| "无法确认播放器程序目录")?;
        let directory = executable.parent().ok_or("无法确认播放器程序目录")?;
        safe_directory(directory, directory).map_err(|_| "程序目录包含链接，更新请使用发布页面")?;
        let directory =
            normalized(std::fs::canonicalize(directory).map_err(|_| "无法读取程序目录")?);
        let manifest = read_json(&directory.join("standalone-build.json"), 512 * 1024)
            .map_err(|_| "当前程序缺少发布清单，请使用发布页面")?;
        if manifest["schemaVersion"] != 1
            || manifest["kind"] != "hertz-studio"
            || manifest["version"] != env!("CARGO_PKG_VERSION")
            || manifest["edition"] != "full"
            || manifest["profile"] != "release"
            || manifest["target"] != env!("HERTZ_BUILD_TARGET")
            || manifest["capabilities"]["windowsInstallGuard"] != true
            || manifest["capabilities"]["nativeWindow"] != true
        {
            return Err("当前程序与发布清单不一致，请使用发布页面更新".into());
        }
        let receipt = directory.join("hertz-setup.json");
        let kind = if receipt.try_exists().map_err(|_| "无法读取安装状态")? {
            let receipt =
                read_json(&receipt, 16 * 1024).map_err(|_| "安装登记无效，请先修复安装")?;
            if receipt["schemaVersion"] != 1
                || receipt["product"] != "hertz-studio-full"
                || !receipt["installDir"]
                    .as_str()
                    .is_some_and(|path| path.eq_ignore_ascii_case(&directory.to_string_lossy()))
            {
                return Err("安装登记与程序目录不一致，请先修复安装".into());
            }
            InstallKind::Installer
        } else {
            InstallKind::Portable
        };
        Ok(Self { directory, kind })
    }
}

#[derive(Clone, Debug)]
// Other platforms can discover releases, but do not consume a Windows package.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) struct Prepared {
    pub directory: PathBuf,
    package: PathBuf,
    checksum: String,
    version: String,
    installation: Installation,
}

#[derive(Debug)]
pub(super) struct Handoff {
    directory: PathBuf,
    /// Trusted data directory; links are only rejected from here down.
    data: PathBuf,
    token: String,
    pub exit_request: Option<String>,
    helper: std::sync::Mutex<Option<std::process::Child>>,
}

#[cfg(test)]
pub(super) fn test_handoff(directory: PathBuf, data: PathBuf, token: String) -> Handoff {
    Handoff {
        directory,
        data,
        token,
        exit_request: None,
        helper: std::sync::Mutex::new(None),
    }
}

pub(super) fn create_stage(
    data: &Path,
    installation: &Installation,
    operation: &str,
) -> Result<PathBuf, Failure> {
    let operation = uuid::Uuid::parse_str(operation)
        .map_err(|_| Failure::new("update_path_invalid", "更新操作身份无效"))?
        .to_string();
    safe_directory(data, data).map_err(io_failure)?;
    let cache = ensure_directory(data, "cache", data).map_err(io_failure)?;
    let root = ensure_directory(&cache, "updates", data).map_err(io_failure)?;
    let root = normalized(std::fs::canonicalize(root).map_err(io_failure)?);
    let install = normalized(std::fs::canonicalize(&installation.directory).map_err(io_failure)?);
    if root.starts_with(&install) || install.starts_with(&root) {
        return Err(Failure::new(
            "update_path_invalid",
            "更新缓存与程序目录重叠，请使用发布页面更新",
        ));
    }
    let directory = root.join(operation);
    std::fs::create_dir(&directory).map_err(io_failure)?;
    Ok(directory)
}

pub(super) fn prepare(
    data: &Path,
    directory: &Path,
    package: PathBuf,
    checksum: String,
    version: String,
    installation: Installation,
) -> Result<Prepared, Failure> {
    safe_directory(directory, data).map_err(io_failure)?;
    // Windows PowerShell 5.1 needs a UTF-8 BOM to read the localized messages.
    let mut helper = b"\xef\xbb\xbf".to_vec();
    helper.extend_from_slice(include_bytes!(
        "../../../../scripts/windows/Apply-Hertz-Update.ps1"
    ));
    write_new(&directory.join("Apply-Hertz-Update.ps1"), &helper).map_err(io_failure)?;
    write_new(
        &directory.join("Update-Hertz.ps1"),
        include_bytes!("../../../../scripts/windows/Update-Hertz.ps1"),
    )
    .map_err(io_failure)?;
    Ok(Prepared {
        directory: directory.to_owned(),
        package,
        checksum,
        version,
        installation,
    })
}

pub(super) fn arm(prepared: &Prepared, state: &AppState) -> Result<Handoff, Failure> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        safe_directory(&prepared.directory, &state.data_dir).map_err(io_failure)?;
        let file = ordinary_file(&prepared.package).map_err(io_failure)?;
        if file.len() == 0 || file.len() > MAX_PACKAGE_BYTES {
            return Err(Failure::new(
                "update_package_invalid",
                "更新包已改变，请重新下载",
            ));
        }
        let port = state.updates.restart_port.get().copied().ok_or_else(|| {
            Failure::new(
                "update_restart_unavailable",
                "无法确认播放器重启端口，请使用发布页面更新",
            )
        })?;
        let token = uuid::Uuid::new_v4().to_string();
        let directory = prepared.directory.join(format!("handoff-{token}"));
        std::fs::create_dir(&directory).map_err(io_failure)?;
        let plan = serde_json::json!({
            "schemaVersion": 1,
            "token": token,
            "kind": prepared.installation.kind,
            "installDir": prepared.installation.directory,
            "stageDir": prepared.directory,
            "dataDir": normalized(state.data_dir.clone()),
            "packagePath": prepared.package,
            "sha256": prepared.checksum,
            "size": file.len(),
            "version": prepared.version,
            "fromVersion": env!("CARGO_PKG_VERSION"),
            "parentPid": std::process::id(),
            "port": port,
        });
        let plan_path = directory.join("plan.json");
        write_new(
            &plan_path,
            &serde_json::to_vec(&plan)
                .map_err(|_| Failure::new("update_plan_invalid", "无法准备安装计划"))?,
        )
        .map_err(io_failure)?;
        let system = std::env::var_os("SystemRoot")
            .ok_or_else(|| Failure::new("update_helper_unavailable", "无法找到系统更新工具"))?;
        let helper = PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let helper = std::process::Command::new(helper)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(prepared.directory.join("Apply-Hertz-Update.ps1"))
            .arg("-Plan")
            .arg(&plan_path)
            .current_dir(&prepared.directory)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|_| {
                Failure::new(
                    "update_helper_unavailable",
                    "无法启动更新工具，请使用发布页面更新",
                )
            })?;
        Ok(Handoff {
            directory,
            data: state.data_dir.clone(),
            token,
            exit_request: None,
            helper: std::sync::Mutex::new(Some(helper)),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (prepared, state);
        Err(Failure::new(
            "update_install_unavailable",
            "此系统请使用发布页面更新",
        ))
    }
}

pub(super) fn disarm(handoff: &Handoff) {
    if let Err(error) = write_new(&handoff.directory.join("cancel"), b"cancelled") {
        tracing::warn!("update cancellation marker: {error}");
    }
}

pub(super) fn is_ready(handoff: &Handoff) -> bool {
    let alive = match handoff
        .helper
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_mut()
    {
        Some(helper) => matches!(helper.try_wait(), Ok(None)),
        None => cfg!(test),
    };
    if !alive || handoff.directory.join("cancel").exists() {
        return false;
    }
    read_json(&handoff.directory.join("ready.json"), 1024)
        .is_ok_and(|ready| ready["token"] == handoff.token)
}

pub(super) fn commit(handoff: &Handoff) -> Result<(), Failure> {
    safe_directory(&handoff.directory, &handoff.data).map_err(io_failure)?;
    let temporary = handoff.directory.join("apply.new");
    let bytes = serde_json::to_vec(&serde_json::json!({ "token": handoff.token }))
        .map_err(|_| Failure::new("update_plan_invalid", "无法确认安装操作"))?;
    write_new(&temporary, &bytes).map_err(io_failure)?;
    std::fs::rename(temporary, handoff.directory.join("apply.json")).map_err(io_failure)
}

pub(super) fn remove_stage(directory: &Path, data: &Path) {
    fn remove(directory: &Path, data: &Path) -> std::io::Result<()> {
        safe_directory(directory, data)?;
        let resolved = normalized(std::fs::canonicalize(directory)?);
        let root = normalized(std::fs::canonicalize(data.join("cache/updates"))?);
        if resolved.parent() != Some(root.as_path())
            || !resolved
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok())
        {
            return Err(std::io::Error::other("update cleanup escaped its cache"));
        }
        fn check_tree(directory: &Path) -> std::io::Result<()> {
            for entry in std::fs::read_dir(directory)? {
                let path = entry?.path();
                let metadata = std::fs::symlink_metadata(&path)?;
                reject_link(&metadata)?;
                if metadata.is_dir() {
                    check_tree(&path)?;
                } else if !metadata.is_file() {
                    return Err(std::io::Error::other("unexpected update cache entry"));
                }
            }
            Ok(())
        }
        check_tree(&resolved)?;
        std::fs::remove_dir_all(resolved)
    }
    if let Err(error) = remove(directory, data) {
        tracing::warn!(
            "retained update download at {}: {error}",
            directory.display()
        );
    }
}

fn ensure_directory(parent: &Path, name: &str, root: &Path) -> std::io::Result<PathBuf> {
    safe_directory(parent, root)?;
    let directory = parent.join(name);
    match std::fs::create_dir(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    safe_directory(&directory, root)?;
    Ok(directory)
}

fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn read_json(path: &Path, maximum: u64) -> std::io::Result<serde_json::Value> {
    use std::io::Read;
    let metadata = ordinary_file(path)?;
    if metadata.len() > maximum {
        return Err(std::io::Error::other("update metadata too large"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(std::io::Error::other("update metadata too large"));
    }
    serde_json::from_slice(&bytes).map_err(std::io::Error::other)
}

fn ordinary_file(path: &Path) -> std::io::Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)?;
    reject_link(&metadata)?;
    if !metadata.is_file() {
        return Err(std::io::Error::other("expected an ordinary update file"));
    }
    Ok(metadata)
}

/// Rejects links from `path` down to `root` only. The chain above `root` is the
/// user's own environment: macOS mounts temp data under symlinked `/var`, and
/// rejecting those ancestors would block every download without protecting a
/// path this process owns.
fn safe_directory(path: &Path, root: &Path) -> std::io::Result<()> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata = std::fs::symlink_metadata(ancestor)?;
        reject_link(&metadata)?;
        if !metadata.is_dir() {
            return Err(std::io::Error::other(
                "expected an ordinary update directory",
            ));
        }
        if ancestor == root || root.starts_with(ancestor) {
            break;
        }
    }
    Ok(())
}

fn reject_link(metadata: &std::fs::Metadata) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(std::io::Error::other("update reparse point"));
        }
    }
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::other("update symbolic link"));
    }
    Ok(())
}

fn normalized(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn io_failure(error: std::io::Error) -> Failure {
    Failure::new(
        "update_filesystem_failed",
        format!("无法准备更新文件，请检查目录权限和磁盘空间后重试（{error}）"),
    )
}
