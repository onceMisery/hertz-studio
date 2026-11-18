// SPDX-License-Identifier: MIT
//! Existing desktop authorization file and calibration key for the standalone player.
//! Preserve legacy scopes when reading/writing; no DBX discovery or listener owner.
use hertz_desktop_ipc::{windows, Scope, AUTHORIZATION_LIMIT};
use serde::{Deserialize, Serialize};
use std::{io, path::Path};
use zeroize::Zeroizing;

pub(super) const AUTH_FILE: &str = "desktop-authorization.json";
pub(crate) fn key_file(scope: Scope) -> &'static str {
    match scope {
        Scope::Lyrics => "desktop-lyrics-key",
        Scope::Wallpaper => "wallpaper-key",
        Scope::LyricsCalibration => "desktop-lyrics-calibration-key",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Authorization {
    pub schema_version: u32,
    pub revision: u64,
    pub scopes: Vec<Scope>,
}
impl Authorization {
    pub fn parse(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() > AUTHORIZATION_LIMIT {
            return Err(invalid("authorization exceeds budget"));
        }
        let value: Self = serde_json::from_slice(bytes)
            .map_err(|_| invalid("invalid desktop authorization record"))?;
        if !matches!(value.schema_version, 1 | 2)
            || value.revision == 0
            || value.scopes.len() > 3
            || value.schema_version == 1 && value.scopes.contains(&Scope::LyricsCalibration)
            || value
                .scopes
                .iter()
                .enumerate()
                .any(|(i, scope)| value.scopes[..i].contains(scope))
        {
            return Err(invalid(
                "unsupported or invalid desktop authorization record",
            ));
        }
        Ok(value)
    }
    pub fn read(directory: &Path) -> io::Result<Option<Self>> {
        match windows::read_private_bounded(&directory.join(AUTH_FILE), AUTHORIZATION_LIMIT) {
            Ok(bytes) => Self::parse(&bytes).map(Some),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    #[cfg(test)]
    pub fn write(&self, directory: &Path) -> io::Result<()> {
        self.write_checked(directory, || Ok(()))
    }
    pub fn write_checked<G>(
        &self,
        directory: &Path,
        admission: impl FnOnce() -> io::Result<G>,
    ) -> io::Result<()> {
        let bytes = hertz_desktop_ipc::frame::serialize_bounded(self, AUTHORIZATION_LIMIT)?;
        windows::write_private_atomic_checked(
            &directory.join(AUTH_FILE),
            &bytes,
            AUTHORIZATION_LIMIT,
            admission,
        )
    }
    pub fn next_revision(existing: Option<&Self>) -> io::Result<u64> {
        existing
            .map_or(Some(1), |record| record.revision.checked_add(1))
            .ok_or_else(|| invalid("desktop authorization revision exhausted"))
    }
}

pub(crate) fn read_key(directory: &Path, scope: Scope) -> io::Result<Zeroizing<String>> {
    let bytes = Zeroizing::new(windows::read_private_bounded(
        &directory.join(key_file(scope)),
        128,
    )?);
    if !(32..=128).contains(&bytes.len()) || !bytes.iter().all(u8::is_ascii_hexdigit) {
        return Err(invalid("invalid desktop scope credential"));
    }
    // Every accepted byte is ASCII. No whitespace or implicit normalization is accepted.
    Ok(Zeroizing::new(
        String::from_utf8(bytes.to_vec()).map_err(|_| invalid("invalid credential encoding"))?,
    ))
}

pub(crate) fn create_key(directory: &Path, scope: Scope) -> io::Result<Zeroizing<String>> {
    let mut random = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut *random)
        .map_err(|_| io::Error::other("desktop credential generation failed"))?;
    let key = Zeroizing::new(
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    );
    windows::write_private_atomic(&directory.join(key_file(scope)), key.as_bytes(), 128)?;
    Ok(key)
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
