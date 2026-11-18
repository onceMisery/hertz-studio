// SPDX-License-Identifier: MIT
use std::{
    fs::File,
    path::{Path, PathBuf},
};

use crate::protocol::{Error, Result};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_pipe;
#[cfg(windows)]
pub use windows::*;
#[cfg(windows)]
pub use windows_pipe::{connect, peer_identity, ClientStream, Listener, ServerStream};

pub struct Locks {
    _database: fslock::LockFile,
    _checkpoint: fslock::LockFile,
}

impl Locks {
    pub fn acquire(
        database: &Path,
        checkpoint: &Path,
        identity: &str,
        initialize: bool,
    ) -> Result<Self> {
        let parent = database.parent().ok_or(Error("invalid_database_path"))?;
        let database_lock = lock(&parent.join(".signer.lock"), identity, initialize)?;
        let checkpoint_lock = lock(&checkpoint.join(".signer.lock"), identity, initialize)?;
        Ok(Self {
            _database: database_lock,
            _checkpoint: checkpoint_lock,
        })
    }
}

fn lock(path: &Path, identity: &str, initialize: bool) -> Result<fslock::LockFile> {
    if initialize && !path.try_exists()? {
        create_private_file(path, identity)?.sync_all()?;
    }
    drop(private_file(path, identity, false)?);
    let mut file = fslock::LockFile::open(path)?;
    if !file.try_lock()? {
        return Err(Error("signer_already_running"));
    }
    Ok(file)
}

pub fn private_directory(path: &Path, identity: &str) -> Result<PathBuf> {
    crate::config::absolute(path)?;
    check_directory(path, identity, true)?;
    std::fs::canonicalize(path).map_err(Into::into)
}

pub fn private_bytes(path: &Path, identity: &str, limit: usize) -> Result<Vec<u8>> {
    crate::protocol::read_from(private_file(path, identity, false)?, limit)
}

pub fn new_private_bytes(path: &Path, identity: &str, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut file: File = create_private_file(path, identity)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    sync_directory(path.parent().ok_or(Error("invalid_storage_path"))?)
}
