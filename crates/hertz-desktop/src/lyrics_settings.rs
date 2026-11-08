// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! The player's inline lyrics settings. Only the embedded HostAction path calls
//! this module; named-pipe and DBX management keep their existing contracts.

use super::{config, native, App};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const POSITION_LEASE: Duration = Duration::from_secs(120);

#[derive(Debug)]
struct SettingsError {
    code: &'static str,
    message: String,
}

impl SettingsError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadSettings {
    #[serde(default)]
    owner: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplySettings {
    expected_revision: u64,
    lyrics: config::LyricsConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BeginPosition {
    expected_revision: u64,
    owner: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FinishPosition {
    owner: String,
}

pub(super) struct PositionOwner {
    owner: String,
    expires: Instant,
}

impl PositionOwner {
    fn new(owner: String, now: Instant) -> Self {
        Self {
            owner,
            expires: now + POSITION_LEASE,
        }
    }

    fn owns(&self, owner: Option<&str>) -> bool {
        owner == Some(self.owner.as_str())
    }

    fn renew(&mut self, owner: Option<&str>, now: Instant) {
        if self.owns(owner) && now < self.expires {
            self.expires = now + POSITION_LEASE;
        }
    }

    fn expired(&self, now: Instant) -> bool {
        now >= self.expires
    }
}

fn parse<T: DeserializeOwned>(value: Option<&Value>) -> Result<T, SettingsError> {
    serde_json::from_value(
        value
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or(json!({})),
    )
    .map_err(|_| SettingsError::new("invalid_value", "歌词设置参数缺失或格式无效"))
}

fn validate_owner(owner: &str) -> Result<(), SettingsError> {
    if !(16..=128).contains(&owner.len())
        || !owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(SettingsError::new(
            "invalid_value",
            "位置调整需要有效的页面会话标识",
        ));
    }
    Ok(())
}

fn check_revision(
    current: &config::Config,
    expected: u64,
    pending_save: bool,
) -> Result<(), SettingsError> {
    if pending_save || expected != current.revision {
        return Err(SettingsError::new(
            "revision_conflict",
            "歌词设置已在其他位置变化，请读取最新设置后重试",
        ));
    }
    Ok(())
}

fn commit_lyrics_change(
    current: &mut config::Config,
    committed: &mut config::Config,
    request: ApplySettings,
    persist: impl FnOnce(&mut config::Config, config::Config) -> anyhow::Result<()>,
) -> Result<(), SettingsError> {
    check_revision(current, request.expected_revision, false)?;
    config::validate_settings_lyrics(&request.lyrics)
        .map_err(|error| SettingsError::new("invalid_value", error.to_string()))?;
    let mut next = current.clone();
    next.lyrics = request.lyrics;
    // config::commit swaps memory only after the durable write. No native or
    // WebView effects run until this transaction succeeds.
    persist(current, next).map_err(|error| {
        let code = match error.downcast_ref::<crate::config_journal::JournalError>() {
            Some(crate::config_journal::JournalError::Conflict) => "revision_conflict",
            Some(crate::config_journal::JournalError::Busy) => "config_busy",
            _ => "save_failed",
        };
        SettingsError::new(code, format!("保存歌词设置失败：{error:#}"))
    })?;
    *committed = current.clone();
    Ok(())
}

impl App {
    pub(super) fn can_lock_lyrics(&self) -> bool {
        self.tray.is_some() || (self.embedded && !self.host_tray)
    }

    fn inline_lyrics_snapshot(&self, owner: Option<&str>) -> Value {
        let edit = self.position_edit.as_ref();
        json!({
            "ok": true,
            "revision": self.config.revision,
            "lyricsConfig": edit.map(|edit| &edit.lyrics).unwrap_or(&self.config.lyrics),
            "pendingSave": self.save_due.is_some(),
            "canLock": self.can_lock_lyrics(),
            "positionEditing": edit.is_some(),
            "positionOwned": edit.and_then(|edit| edit.owner.as_ref()).is_some_and(|session| session.owns(owner)),
            "positionLeaseMs": POSITION_LEASE.as_millis() as u64,
            "runtime": {
                "enabled": self.lyrics_running(),
                "sessionStopped": self.feature_stops.lyrics,
                "exitPreferenceSaved": !self.feature_stops.lyrics_save_failed,
                "locked": self.policy.locked,
                "visible": self.visible,
                "userHidden": self.policy.user_hidden,
                "source": self.source_state,
                "sourceMessage": self.source_message,
                "lyricsStatus": self.last_snapshot.as_ref().map(|snapshot| snapshot.lyrics.status.as_str()),
                "vocalMode": self.vocal_document_mode(),
                "vocalCapacity": self.lyrics_vocal_geometry().capacity,
                "policy": {
                    "fullscreen": self.policy.fullscreen,
                    "sessionUnavailable": self.policy.session_unavailable,
                    "displayOff": self.policy.display_off,
                    "noContent": self.policy.no_content,
                },
            },
        })
    }

    fn apply_lyrics_settings(&mut self, request: ApplySettings) -> Result<(), SettingsError> {
        if self.position_edit.is_some() {
            return Err(SettingsError::new(
                "position_edit_active",
                "请先完成或取消位置调整",
            ));
        }
        if self.wallpaper_apply.is_some() {
            return Err(SettingsError::new(
                "config_busy",
                "桌面设置正在保存，请稍后重试",
            ));
        }
        check_revision(
            &self.config,
            request.expected_revision,
            self.save_due.is_some(),
        )?;
        if request.lyrics.locked && !self.can_lock_lyrics() {
            return Err(SettingsError::new(
                "tray_unavailable",
                "托盘不可用，暂时无法锁定歌词",
            ));
        }
        let explicitly_enabled = !self.lyrics_running() && request.lyrics.enabled;
        commit_lyrics_change(
            &mut self.config,
            &mut self.committed_config,
            request,
            config::commit,
        )?;
        if self.config.lyrics.enabled {
            self.resume_lyrics();
        } else {
            self.clear_lyrics_runtime();
            self.sync_lyrics_feed();
        }
        if explicitly_enabled {
            self.policy.user_hidden = false;
        }
        self.policy.locked = self.config.lyrics.locked;
        native::set_locked(self.hwnd(), self.policy.locked);
        self.panel_top = None;
        if self.policy.locked {
            self.panel_height = 0.0;
            self.eval("window.hertzLyrics && window.hertzLyrics.setOptions(false);");
        }
        self.send_config();
        self.place(true);
        self.recompute_visibility();
        self.mini_send_config();
        self.sync_tray();
        // Keep any native-center draft intact; its old revision must conflict.
        self.send_settings_status(None, Some("歌词设置已应用"));
        Ok(())
    }

    fn begin_inline_position(&mut self, request: BeginPosition) -> Result<(), SettingsError> {
        validate_owner(&request.owner)?;
        if let Some(edit) = self.position_edit.as_mut() {
            if let Some(owner) = edit
                .owner
                .as_mut()
                .filter(|owner| owner.owns(Some(&request.owner)))
            {
                owner.renew(Some(&request.owner), Instant::now());
                return Ok(());
            }
            return Err(SettingsError::new(
                "position_edit_active",
                "另一处设置正在调整歌词位置",
            ));
        }
        if self.wallpaper_apply.is_some() {
            return Err(SettingsError::new(
                "config_busy",
                "桌面设置正在保存，请稍后重试",
            ));
        }
        check_revision(
            &self.config,
            request.expected_revision,
            self.save_due.is_some(),
        )?;
        self.begin_position_edit()
            .map_err(|message| SettingsError::new("position_edit_active", message))?;
        self.position_edit
            .as_mut()
            .expect("position edit started")
            .owner = Some(PositionOwner::new(request.owner, Instant::now()));
        self.send_settings_status(None, Some("正在主程序中调整歌词位置"));
        Ok(())
    }

    fn finish_inline_position(&mut self, owner: &str, commit: bool) -> Result<(), SettingsError> {
        validate_owner(owner)?;
        let edit = self.position_edit.as_ref().ok_or_else(|| {
            SettingsError::new("position_edit_inactive", "位置调整已结束，请重新读取设置")
        })?;
        if !edit
            .owner
            .as_ref()
            .is_some_and(|session| session.owns(Some(owner)))
        {
            return Err(SettingsError::new(
                "position_owner_mismatch",
                "只有发起位置调整的页面可以完成或取消",
            ));
        }
        let result = self
            .finish_position_edit(commit)
            .map_err(|message| SettingsError::new("save_failed", message));
        self.send_settings_status(
            result.as_ref().err().map(|error| error.message.as_str()),
            None,
        );
        result
    }

    pub(super) fn expire_inline_position_edit(&mut self) {
        if self
            .position_edit
            .as_ref()
            .and_then(|edit| edit.owner.as_ref())
            .is_some_and(|owner| owner.expired(Instant::now()))
        {
            let _ = self.finish_position_edit(false);
            self.send_settings_status(None, Some("位置调整会话已结束，已恢复原位置"));
        }
    }

    pub(super) fn handle_embedded_lyrics_request(&mut self, request: &Value) -> Option<Value> {
        let command = request.get("command").and_then(Value::as_str)?;
        if !matches!(
            command,
            "lyrics-settings"
                | "lyrics-apply"
                | "lyrics-position-begin"
                | "lyrics-position-done"
                | "lyrics-position-cancel"
        ) {
            return None;
        }
        if !self.embedded || config::is_dbx(&self.profile) {
            return Some(super::pipe_error_detail(
                "unsupported_source",
                "歌词内联设置仅用于主程序的独立来源",
            ));
        }
        self.expire_inline_position_edit();
        let value = request.get("value");
        let mut owner = None;
        let result = (|| -> Result<(), SettingsError> {
            match command {
                "lyrics-settings" => {
                    let read: ReadSettings = parse(value)?;
                    if let Some(value) = read.owner.as_deref() {
                        validate_owner(value)?;
                    }
                    owner = read.owner;
                    if let Some(session) = self
                        .position_edit
                        .as_mut()
                        .and_then(|edit| edit.owner.as_mut())
                    {
                        session.renew(owner.as_deref(), Instant::now());
                    }
                    Ok(())
                }
                "lyrics-apply" => self.apply_lyrics_settings(parse(value)?),
                "lyrics-position-begin" => {
                    let begin: BeginPosition = parse(value)?;
                    owner = Some(begin.owner.clone());
                    self.begin_inline_position(begin)
                }
                _ => {
                    let finish: FinishPosition = parse(value)?;
                    owner = Some(finish.owner.clone());
                    self.finish_inline_position(&finish.owner, command == "lyrics-position-done")
                }
            }
        })();
        let mut response = self.inline_lyrics_snapshot(owner.as_deref());
        if let Err(error) = result {
            response["ok"] = json!(false);
            response["error"] = json!(error.code);
            response["message"] = json!(error.message);
        }
        Some(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lyric_transaction_only_replaces_lyrics_and_preserves_other_domains() {
        let mut current = config::Config::default();
        current.wallpaper.enabled = false;
        current.launch_at_login = true;
        let wallpaper = serde_json::to_value(&current.wallpaper).unwrap();
        let mini = serde_json::to_value(&current.mini).unwrap();
        let mut committed = current.clone();
        let mut lyrics = current.lyrics.clone();
        lyrics.enabled = false;
        lyrics.locked = true;
        lyrics.show_vocals = false;
        lyrics.sung_color = "#123456".into();
        let request = ApplySettings {
            expected_revision: current.revision,
            lyrics: lyrics.clone(),
        };
        commit_lyrics_change(
            &mut current,
            &mut committed,
            request,
            |current, mut next| {
                next.revision += 1;
                *current = next;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(current.lyrics, lyrics);
        assert_eq!(committed.lyrics, lyrics);
        assert_eq!(current.revision, 2);
        assert_eq!(committed.revision, 2);
        assert_eq!(serde_json::to_value(&current.wallpaper).unwrap(), wallpaper);
        assert_eq!(serde_json::to_value(&current.mini).unwrap(), mini);
        assert!(current.launch_at_login);
    }

    #[test]
    fn lyric_transaction_rejects_stale_or_invalid_input_before_persistence() {
        let mut current = config::Config::default();
        let mut committed = current.clone();
        for (expected_revision, size, code) in
            [(0, 30.0, "revision_conflict"), (1, 1000.0, "invalid_value")]
        {
            let mut lyrics = current.lyrics.clone();
            lyrics.font_size = size;
            let error = commit_lyrics_change(
                &mut current,
                &mut committed,
                ApplySettings {
                    expected_revision,
                    lyrics,
                },
                |_, _| panic!("invalid write reached persistence"),
            )
            .unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(current.revision, 1);
            assert_eq!(current.lyrics, committed.lyrics);
        }
        assert_eq!(
            check_revision(&current, 1, true).unwrap_err().code,
            "revision_conflict"
        );
    }

    #[test]
    fn failed_lyrics_write_preserves_saved_configuration_and_revision() {
        let mut current = config::Config::default();
        let mut committed = current.clone();
        let before = current.lyrics.clone();
        let mut lyrics = before.clone();
        lyrics.opacity = 0.5;
        let error = commit_lyrics_change(
            &mut current,
            &mut committed,
            ApplySettings {
                expected_revision: 1,
                lyrics,
            },
            |_, _| anyhow::bail!("disk unavailable"),
        )
        .unwrap_err();
        assert_eq!(error.code, "save_failed");
        assert_eq!(current.lyrics, before);
        assert_eq!(committed.lyrics, before);
        assert_eq!(current.revision, 1);
        assert_eq!(committed.revision, 1);
    }

    #[test]
    fn only_position_owner_can_renew_and_expired_sessions_cannot_revive() {
        let now = Instant::now();
        let mut session = PositionOwner::new("page-session-owner".into(), now);
        assert!(!session.owns(None));
        assert!(!session.owns(Some("another-session")));
        session.renew(Some("another-session"), now + Duration::from_secs(60));
        assert!(session.expired(now + POSITION_LEASE));
        session.renew(Some("page-session-owner"), now + Duration::from_secs(60));
        assert!(!session.expired(now + POSITION_LEASE));
        let expired = now + POSITION_LEASE * 2;
        session.renew(Some("page-session-owner"), expired);
        assert!(session.expired(expired));
        for invalid in ["", "short", "spaces are disallowed", "../page-session-path"] {
            assert!(validate_owner(invalid).is_err());
        }
        assert!(validate_owner("37da97a0-41ee-4d2d-8897-60418bdc052f").is_ok());
    }

    #[test]
    fn request_dtos_reject_unknown_fields_and_partial_lyrics() {
        assert!(parse::<ApplySettings>(Some(
            &json!({"expectedRevision": 1, "lyrics": {"enabled": false}})
        ))
        .is_err());
        assert!(parse::<ReadSettings>(Some(&json!({"profile": "other"}))).is_err());
        assert!(parse::<FinishPosition>(Some(
            &json!({"owner": "page-session-owner", "force": true})
        ))
        .is_err());
    }
}
