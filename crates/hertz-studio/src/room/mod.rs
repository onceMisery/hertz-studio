// SPDX-License-Identifier: MIT
pub(crate) use manager::RoomManager;
mod collaboration;
pub(crate) mod contract;
pub(crate) mod credentials;
mod guest;
mod history_writer;
mod host;
mod host_jobs;
mod manager;
mod output_preferences;
mod presentation;
pub(crate) mod producer;
pub(crate) mod receiver;
mod recent_chat;
pub(crate) mod resources;
mod sleep_timer;

pub(crate) mod api;

pub(crate) mod chat;
