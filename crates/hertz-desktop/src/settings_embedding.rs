// SPDX-License-Identifier: MIT
//! Main-player presentation messages. Configuration and drafts stay in App.
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SettingsBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug)]
pub struct SettingsPlacement {
    pub parent: usize,
    pub document: String,
    pub bounds: SettingsBounds,
    pub visible: bool,
    pub light: bool,
    pub tab: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SettingsEvent {
    Navigate { tab: String },
    Ready { document: String },
    Closed { document: String },
    Failed { document: String, error: String },
}

pub type SettingsEvents = Arc<dyn Fn(SettingsEvent) + Send + Sync>;
