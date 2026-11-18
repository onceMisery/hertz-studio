// SPDX-License-Identifier: MIT
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

use tokio::net::{UnixListener, UnixStream};

use crate::{
    config::Config,
    protocol::{Error, Result},
};

pub type ServerStream = UnixStream;
pub type ClientStream = UnixStream;

pub fn restrict_process_files() {
    unsafe {
        libc::umask(0o077);
    }
}

pub fn validate_identity(identity: &str) -> Result<()> {
    if !identity
        .parse::<u32>()
        .is_ok_and(|uid| uid.to_string() == identity)
    {
        return Err(Error("canonical_uid_required"));
    }
    Ok(())
}

pub fn current_identity() -> Result<String> {
    let uid = unsafe { libc::geteuid() };
    if uid != unsafe { libc::getuid() } {
        return Err(Error("setuid_execution_not_allowed"));
    }
    Ok(uid.to_string())
}

fn check_ancestors(path: &Path, uid: u32) -> Result<()> {
    for ancestor in path.ancestors().skip(1) {
        let metadata = std::fs::symlink_metadata(ancestor)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || (metadata.uid() != 0 && metadata.uid() != uid)
            || metadata.mode() & 0o022 != 0
        {
            return Err(Error("untrusted_storage_ancestor"));
        }
    }
    Ok(())
}

pub fn check_directory(path: &Path, identity: &str, private: bool) -> Result<()> {
    crate::config::absolute(path)?;
    validate_identity(identity)?;
    let uid: u32 = identity
        .parse()
        .map_err(|_| Error("canonical_uid_required"))?;
    check_ancestors(path, uid)?;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error("nonredirected_directory_required"));
    }
    if private {
        if metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
            return Err(Error("private_directory_required"));
        }
    } else if (metadata.uid() != uid && metadata.uid() != 0) || metadata.mode() & 0o022 != 0 {
        return Err(Error("untrusted_endpoint_directory"));
    }
    Ok(())
}

fn check_file(file: &File, identity: &str) -> Result<()> {
    let uid: u32 = identity
        .parse()
        .map_err(|_| Error("canonical_uid_required"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(Error("private_regular_file_required"));
    }
    Ok(())
}

pub fn private_file(path: &Path, identity: &str, append: bool) -> Result<File> {
    crate::config::absolute(path)?;
    validate_identity(identity)?;
    let uid = identity
        .parse()
        .map_err(|_| Error("canonical_uid_required"))?;
    check_ancestors(path, uid)?;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    if append {
        options.append(true);
    }
    let file = options.open(path)?;
    check_file(&file, identity)?;
    Ok(file)
}

pub fn create_private_file(path: &Path, identity: &str) -> Result<File> {
    crate::config::absolute(path)?;
    check_directory(
        path.parent().ok_or(Error("invalid_storage_path"))?,
        identity,
        true,
    )?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    check_file(&file, identity)?;
    Ok(file)
}

pub fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all().map_err(Into::into)
}

pub fn validate_endpoint(endpoint: &str, service: Option<&str>) -> Result<()> {
    let path = Path::new(endpoint);
    crate::config::absolute(path)?;
    if endpoint.len() > 100 || path.file_name().is_none() {
        return Err(Error("invalid_local_endpoint"));
    }
    if let Some(service) = service {
        check_directory(
            path.parent().ok_or(Error("invalid_local_endpoint"))?,
            service,
            false,
        )?;
    }
    Ok(())
}

pub struct Listener {
    listener: UnixListener,
    path: std::path::PathBuf,
    device: u64,
    inode: u64,
}

impl Listener {
    pub fn bind(config: &Config) -> Result<Self> {
        validate_endpoint(&config.endpoint, Some(&config.service_identity))?;
        let path = Path::new(&config.endpoint);
        // An existing socket is never removed to win a competing service bind.
        let listener = UnixListener::bind(path)?;
        let metadata = std::fs::symlink_metadata(path)?;
        let result = Self {
            listener,
            path: path.to_owned(),
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        if !metadata.file_type().is_socket()
            || metadata.uid().to_string() != config.service_identity
        {
            return Err(Error("endpoint_owner_mismatch"));
        }
        // POSIX modes cannot name several independent UIDs. Connecting is public;
        // SO_PEERCRED/getpeereid supplies the authority before any body is accepted.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
        Ok(result)
    }

    pub async fn accept(&mut self) -> Result<ServerStream> {
        Ok(self.listener.accept().await?.0)
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        if let Ok(metadata) = std::fs::symlink_metadata(&self.path) {
            if metadata.file_type().is_socket()
                && metadata.dev() == self.device
                && metadata.ino() == self.inode
            {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

pub fn peer_identity(stream: &ServerStream) -> Result<String> {
    Ok(stream.peer_cred()?.uid().to_string())
}

pub async fn connect(endpoint: &str, expected_service: &str) -> Result<ClientStream> {
    validate_identity(expected_service)?;
    validate_endpoint(endpoint, Some(expected_service))?;
    let metadata = std::fs::symlink_metadata(endpoint)?;
    if !metadata.file_type().is_socket() || metadata.uid().to_string() != expected_service {
        return Err(Error("endpoint_owner_mismatch"));
    }
    let stream = UnixStream::connect(endpoint).await?;
    if stream.peer_cred()?.uid().to_string() != expected_service {
        return Err(Error("service_identity_mismatch"));
    }
    Ok(stream)
}
