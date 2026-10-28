// SPDX-License-Identifier: MIT
use serde::{Deserialize, Serialize};
use std::{io, path::Path};

pub const STANDARD_PLUGIN_ID: &str = "io.github.oncemisery.hertz-studio";
pub const FULL_PLUGIN_ID: &str = "io.github.oncemisery.hertz-studio.full";

/// Persistent identity. Runtime session, PID, pipe names and credentials never belong here.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Profile {
    Standalone {
        edition: String,
        #[serde(rename = "dataDir")]
        data_dir: String,
    },
    Dbx {
        edition: String,
        #[serde(rename = "dataDir")]
        data_dir: String,
        #[serde(rename = "pluginId")]
        plugin_id: String,
    },
}

impl Profile {
    pub fn data_dir(&self) -> &str {
        match self {
            Self::Standalone { data_dir, .. } | Self::Dbx { data_dir, .. } => data_dir,
        }
    }

    pub fn edition(&self) -> &str {
        match self {
            Self::Standalone { edition, .. } | Self::Dbx { edition, .. } => edition,
        }
    }

    /// Resolve the existing directory for identity only; never creates, moves or selects it.
    /// Windows uses a directory handle's final path, then invariant case folding. Junction,
    /// extended-prefix and ordinary case aliases therefore use the same pipe/lock identity.
    pub fn normalized(&self) -> io::Result<Self> {
        self.validate()?;
        let directory = normalize_directory(Path::new(self.data_dir()))?;
        Ok(match self {
            Self::Standalone { edition, .. } => Self::Standalone {
                edition: edition.clone(),
                data_dir: directory,
            },
            Self::Dbx {
                edition, plugin_id, ..
            } => Self::Dbx {
                edition: edition.clone(),
                plugin_id: plugin_id.clone(),
                data_dir: directory,
            },
        })
    }

    pub fn validate(&self) -> io::Result<()> {
        if self.data_dir().is_empty()
            || self.data_dir().contains('\0')
            || self.edition().is_empty()
            || !Path::new(self.data_dir()).is_absolute()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid desktop profile",
            ));
        }
        if !matches!(self.edition(), "standard" | "full" | "custom") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsupported desktop edition",
            ));
        }
        if let Self::Dbx {
            edition, plugin_id, ..
        } = self
        {
            let expected = match edition.as_str() {
                "standard" => STANDARD_PLUGIN_ID,
                "full" => FULL_PLUGIN_ID,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "unsupported DBX edition",
                    ))
                }
            };
            if plugin_id != expected {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "DBX plugin ID does not match edition",
                ));
            }
        }
        Ok(())
    }
}

pub fn normalize_directory(path: &Path) -> io::Result<String> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "desktop data directory must be absolute",
        ));
    }
    if !path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "desktop data directory must exist",
        ));
    }
    #[cfg(windows)]
    {
        crate::windows::normalize_directory(path)
    }
    #[cfg(not(windows))]
    {
        Ok(std::fs::canonicalize(path)?.to_string_lossy().into_owned())
    }
}
