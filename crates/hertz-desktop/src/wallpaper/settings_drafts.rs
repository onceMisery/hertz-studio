// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Settings drafts are native session-owned memory, independent of persistent work documents.

use super::config::WallpaperConfig;
use super::jobs::JobError;
use crate::config::{Config, LyricsConfig, Profile};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Update {
    ReplaceWallpaper { wallpaper: WallpaperConfig },
    ReplaceLyrics { lyrics: LyricsConfig },
}

#[derive(Clone)]
pub(crate) struct Draft {
    pub id: String,
    pub owner: u64,
    pub revision: u64,
    pub base_revision: u64,
    profile: Option<Profile>,
    pub wallpaper: WallpaperConfig,
    pub lyrics: LyricsConfig,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt<'a> {
    pub kind: &'static str,
    pub draft_id: &'a str,
    pub draft_revision: u64,
    pub base_revision: u64,
}

impl Draft {
    /// Private apply snapshot for a native-authorized selection. It is never
    /// inserted into SettingsDrafts and cannot include an unconfirmed UI draft.
    pub(crate) fn from_committed(owner: u64, config: &Config) -> Self {
        Self {
            id: String::new(),
            owner,
            revision: 0,
            base_revision: config.revision,
            profile: config.active_profile.clone(),
            wallpaper: config.wallpaper.clone(),
            lyrics: config.lyrics.clone(),
        }
    }
    pub(crate) fn receipt(&self) -> Receipt<'_> {
        Receipt {
            kind: "settings",
            draft_id: &self.id,
            draft_revision: self.revision,
            base_revision: self.base_revision,
        }
    }
    pub(crate) fn check_apply(&self, expected: u64, current: &Config) -> Result<(), JobError> {
        if expected != self.base_revision
            || current.revision != self.base_revision
            || self.profile != current.active_profile
        {
            return Err(JobError::new(
                "conflict",
                "设置已变化，草稿已保留，请重新读取后明确提交",
            ));
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct SettingsDrafts {
    owner: u64,
    draft: Option<Draft>,
}

impl SettingsDrafts {
    pub(crate) fn set_owner(&mut self, owner: u64) {
        if self.owner != owner {
            self.draft = None;
            self.owner = owner;
        }
    }
    fn check_owner(&self, owner: u64) -> Result<(), JobError> {
        if owner == 0 || self.owner != owner {
            return Err(JobError::new(
                "settings_session_required",
                "草稿不属于当前设置会话",
            ));
        }
        Ok(())
    }
    pub(crate) fn create(&mut self, owner: u64, config: &Config) -> Result<&Draft, JobError> {
        self.check_owner(owner)?;
        if self.draft.is_some() {
            return Err(JobError::new("draft_exists", "当前设置草稿尚未释放"));
        }
        self.draft = Some(Draft {
            id: super::file_tokens::random_token()?,
            owner,
            revision: 1,
            base_revision: config.revision,
            profile: config.active_profile.clone(),
            wallpaper: config.wallpaper.clone(),
            lyrics: config.lyrics.clone(),
        });
        Ok(self.draft.as_ref().expect("new draft"))
    }
    pub(crate) fn get(&self, owner: u64, id: &str, revision: u64) -> Result<&Draft, JobError> {
        self.check_owner(owner)?;
        let draft = self
            .draft
            .as_ref()
            .filter(|draft| draft.id == id && draft.owner == owner)
            .ok_or_else(|| JobError::new("draft_not_found", "设置草稿已释放，请重新读取"))?;
        if draft.revision != revision {
            return Err(JobError::new(
                "draft_conflict",
                "草稿修订已变化，未覆盖现有修改",
            ));
        }
        Ok(draft)
    }
    pub(crate) fn update(
        &mut self,
        owner: u64,
        id: &str,
        revision: u64,
        operations: Vec<Update>,
    ) -> Result<&Draft, JobError> {
        if operations.is_empty() || operations.len() > 32 {
            return Err(JobError::invalid_input("每次需提供 1–32 个类型化修改"));
        }
        let mut next = self.get(owner, id, revision)?.clone();
        for operation in operations {
            match operation {
                Update::ReplaceWallpaper { wallpaper } => next.wallpaper = wallpaper,
                Update::ReplaceLyrics { lyrics } => next.lyrics = lyrics,
            }
        }
        next.wallpaper
            .normalize()
            .map_err(|error| JobError::invalid_input(error.to_string()))?;
        crate::config::validate_settings_lyrics(&next.lyrics)
            .map_err(|error| JobError::invalid_input(error.to_string()))?;
        let bytes = serde_json::to_vec(
            &serde_json::json!({"wallpaper":next.wallpaper,"lyrics":next.lyrics}),
        )
        .expect("settings domain");
        if bytes.len() > crate::config::MAX_CONFIG_BYTES {
            return Err(JobError::invalid_input("设置草稿超过 64 KiB"));
        }
        next.revision = next
            .revision
            .checked_add(1)
            .ok_or_else(|| JobError::new("draft_conflict", "草稿修订达到上限"))?;
        self.draft = Some(next);
        Ok(self.draft.as_ref().expect("updated draft"))
    }
    /// 删除保护只读快照：未应用的草稿同样可能引用作品版本。
    pub(crate) fn current(&self) -> Option<&Draft> {
        self.draft.as_ref()
    }
    pub(crate) fn discard(&mut self, owner: u64, id: &str, revision: u64) -> Result<(), JobError> {
        self.get(owner, id, revision)?;
        self.draft = None;
        Ok(())
    }
    pub(crate) fn clear(&mut self) {
        self.draft = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_revision_and_owner_checks_preserve_the_existing_draft() {
        let mut drafts = SettingsDrafts::default();
        let config = Config::default();
        assert_eq!(
            drafts.create(1, &config).err().unwrap().code,
            "settings_session_required"
        );
        drafts.set_owner(1);
        let draft = drafts.create(1, &config).unwrap().clone();
        let mut wallpaper = draft.wallpaper.clone();
        wallpaper.enabled = true;
        let mut invalid = draft.lyrics.clone();
        invalid.font_size = f64::NAN;
        assert!(drafts
            .update(
                1,
                &draft.id,
                1,
                vec![
                    Update::ReplaceWallpaper {
                        wallpaper: wallpaper.clone()
                    },
                    Update::ReplaceLyrics { lyrics: invalid }
                ]
            )
            .is_err());
        assert!(!drafts.get(1, &draft.id, 1).unwrap().wallpaper.enabled);
        assert!(drafts
            .update(
                2,
                &draft.id,
                1,
                vec![Update::ReplaceWallpaper {
                    wallpaper: wallpaper.clone()
                }]
            )
            .is_err());
        assert!(drafts
            .update(
                1,
                &draft.id,
                0,
                vec![Update::ReplaceWallpaper {
                    wallpaper: wallpaper.clone()
                }]
            )
            .is_err());
        assert!(drafts.update(1, &draft.id, 1, vec![]).is_err());
        assert!(drafts
            .update(
                1,
                &draft.id,
                1,
                vec![
                    Update::ReplaceWallpaper {
                        wallpaper: wallpaper.clone()
                    };
                    33
                ]
            )
            .is_err());
        let next = drafts
            .update(
                1,
                &draft.id,
                1,
                vec![Update::ReplaceWallpaper { wallpaper }],
            )
            .unwrap();
        assert_eq!(next.revision, 2);
        assert!(next.wallpaper.enabled);
        assert!(!config.wallpaper.enabled);
        assert!(drafts.discard(1, &draft.id, 1).is_err());
        drafts.set_owner(2);
        assert!(drafts.get(1, &draft.id, 2).is_err());
        assert!(drafts.get(2, &draft.id, 2).is_err());
        assert!(drafts.create(2, &config).is_ok());
    }
    #[test]
    fn profile_or_config_revision_changes_do_not_rebase_a_draft() {
        let mut drafts = SettingsDrafts::default();
        drafts.set_owner(1);
        let mut config = Config::default();
        let draft = drafts.create(1, &config).unwrap().clone();
        assert!(draft.check_apply(config.revision, &config).is_ok());
        config.revision += 1;
        assert!(draft.check_apply(config.revision, &config).is_err());
        assert_eq!(drafts.get(1, &draft.id, 1).unwrap().base_revision, 1);
        drafts.clear();
        assert!(drafts.get(1, &draft.id, 1).is_err());
    }
}
