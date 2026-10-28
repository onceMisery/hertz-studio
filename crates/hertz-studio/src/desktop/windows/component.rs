// SPDX-License-Identifier: MIT
//! Fixed installation discovery only: never execute, install or search PATH.
use super::super::{error, Component};
use super::{check, io_error};
use hertz_desktop_ipc::windows::Cancellation;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
    time::Instant,
};

const MANIFEST_LIMIT: usize = 16 * 1024;
const BINARY_LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    component_protocol: u32,
    version: String,
    target: String,
    desktop_build_id: String,
    management_protocol: u32,
    bridge_protocol: Option<u32>,
    launch_mode: String,
    file: String,
    size: u64,
    sha256: String,
}
fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn version(value: &str) -> bool {
    let (base, suffix) = value
        .split_once('-')
        .map_or((value, None), |(base, suffix)| (base, Some(suffix)));
    let parts: Vec<_> = base.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Desktop component manifest or binary is incompatible",
    )
}
fn verify(directory: &Path, cancel: &Cancellation, deadline: Instant) -> io::Result<()> {
    check(cancel, deadline)?;
    let mut file = File::open(directory.join("desktop-component.json"))?;
    if file.metadata()?.len() > MANIFEST_LIMIT as u64 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MANIFEST_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    check(cancel, deadline)?;
    if bytes.len() > MANIFEST_LIMIT {
        return Err(invalid());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if manifest.component_protocol != 1
        || !version(&manifest.version)
        || manifest.target != "windows-x64"
        || manifest.file != "hertz-desktop.exe"
        || manifest.launch_mode != "manual"
        || manifest.management_protocol != 2
        || manifest.bridge_protocol != Some(1)
        || !hex(&manifest.desktop_build_id)
        || manifest.desktop_build_id != env!("HERTZ_DESKTOP_BUILD_ID")
        || !hex(&manifest.sha256)
        || manifest.size == 0
        || manifest.size > BINARY_LIMIT
    {
        return Err(invalid());
    }
    let mut binary = File::open(directory.join("hertz-desktop.exe"))?;
    let metadata = binary.metadata()?;
    if !metadata.is_file() || metadata.len() != manifest.size {
        return Err(invalid());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut read = 0u64;
    loop {
        check(cancel, deadline)?;
        let count = binary.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        read += count as u64;
        if read > manifest.size {
            return Err(invalid());
        }
        hash.update(&buffer[..count]);
    }
    check(cancel, deadline)?;
    if read != manifest.size || format!("{:x}", hash.finalize()) != manifest.sha256 {
        return Err(invalid());
    }
    Ok(())
}
pub(super) fn discover(
    directory: Option<&Path>,
    cancel: &Cancellation,
    deadline: Instant,
) -> Component {
    let result = directory
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is unavailable"))
        .and_then(|dir| verify(dir, cancel, deadline));
    match result {
        Ok(()) => Component {
            state: "ready",
            origin: Some("installed"),
            error: None,
        },
        Err(failure) => {
            let (state, failure) = match failure.kind() {
                io::ErrorKind::NotFound if directory.is_some() => ("missing", error("desktop_component_missing", "The optional desktop component is not installed at the supported location")),
                io::ErrorKind::InvalidData => ("incompatible", error("desktop_component_incompatible", "The installed desktop component is incompatible or its integrity check failed")),
                _ => ("unknown", io_error(&failure)),
            };
            Component {
                state,
                origin: Some("installed"),
                error: Some(failure),
            }
        }
    }
}
