// SPDX-License-Identifier: MIT
//! Bounded wire projections and edits of the existing Repository; no second store.
use super::{conflict, validate, FixedVersion, Mode, Playlist, Repository, Result};
use crate::wallpaper::jobs::JobError;
use serde::{Deserialize, Serialize};

pub(crate) const MAX_ITEMS: usize = 1000;
pub(crate) const PAGE_SIZE: usize = 32;
pub(crate) const MAX_EDITS: usize = 32;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Edit {
    Insert { index: usize, item: FixedVersion },
    Remove { index: usize },
    // `to` is the final index, after removing `from`.
    Move { from: usize, to: usize },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Update {
    pub playlist_id: String,
    pub expected_playlist_revision: u64,
    pub title: String,
    pub mode: Mode,
    pub interval_seconds: u32,
    pub operations: Vec<Edit>,
}
impl Update {
    pub(crate) fn validate(&self) -> Result<()> {
        if !crate::wallpaper::api::valid_id(&self.playlist_id)
            || self.expected_playlist_revision >= i64::MAX as u64
            || self.operations.len() > MAX_EDITS
        {
            return Err(JobError::invalid_input("列表编号、修订或变更数量无效"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageRequest {
    pub playlist_id: String,
    pub expected_playlist_revision: Option<u64>,
    #[serde(default)]
    pub offset: usize,
    pub limit: usize,
}
impl PageRequest {
    pub(crate) fn validate(&self) -> Result<()> {
        if !crate::wallpaper::api::valid_id(&self.playlist_id)
            || !(1..=PAGE_SIZE).contains(&self.limit)
            || self.offset >= MAX_ITEMS
            || (self.offset > 0 && self.expected_playlist_revision.is_none())
            || self
                .expected_playlist_revision
                .is_some_and(|r| r == 0 || r > i64::MAX as u64)
        {
            return Err(JobError::invalid_input(
                "轮播条目分页需要有效范围和原修订号",
            ));
        }
        Ok(())
    }
}

impl Playlist {
    pub(crate) fn receipt(&self) -> serde_json::Value {
        serde_json::json!({"playlistId":self.playlist_id,"revision":self.revision,
            "title":self.title,"mode":self.mode,"intervalSeconds":self.interval_seconds,
            "itemCount":self.items.len()})
    }
}

impl Repository<'_> {
    pub(crate) async fn page(&self, request: &PageRequest) -> Result<serde_json::Value> {
        request.validate()?;
        // get() reads metadata and items in one SQLite snapshot, bounded at 1000.
        let playlist = self.get(&request.playlist_id).await?;
        if request
            .expected_playlist_revision
            .is_some_and(|r| r != playlist.revision)
        {
            return Err(conflict());
        }
        if request.offset >= playlist.items.len() {
            return Err(JobError::invalid_input("轮播分页位置已超出列表"));
        }
        let end = (request.offset + request.limit).min(playlist.items.len());
        let mut result = playlist.receipt();
        result["items"] = serde_json::json!(&playlist.items[request.offset..end]);
        result["offset"] = request.offset.into();
        result["nextOffset"] = if end < playlist.items.len() {
            end.into()
        } else {
            serde_json::Value::Null
        };
        Ok(result)
    }

    // Caller retains the content writer until validation and save() have finished.
    pub(crate) async fn candidate(&self, update: Update) -> Result<Playlist> {
        update.validate()?;
        let mut items = if update.expected_playlist_revision == 0 {
            Vec::new()
        } else {
            let old = self.get(&update.playlist_id).await?;
            if old.revision != update.expected_playlist_revision {
                return Err(conflict());
            }
            old.items
        };
        for operation in update.operations {
            match operation {
                Edit::Insert { index, item } if index <= items.len() && items.len() < MAX_ITEMS => {
                    items.insert(index, item);
                }
                Edit::Remove { index } if index < items.len() => {
                    items.remove(index);
                }
                Edit::Move { from, to } if from < items.len() && to < items.len() => {
                    let item = items.remove(from);
                    items.insert(to, item);
                }
                _ => return Err(JobError::invalid_input("变更位置无效或列表已达到1000项")),
            }
        }
        validate(&update.title, update.interval_seconds, &items)?;
        Ok(Playlist {
            playlist_id: update.playlist_id,
            revision: update.expected_playlist_revision,
            title: update.title,
            mode: update.mode,
            interval_seconds: update.interval_seconds,
            items,
        })
    }

    pub(crate) async fn commit_candidate(&self, candidate: Playlist) -> Result<Playlist> {
        self.save(
            Some(&candidate.playlist_id),
            Some(candidate.revision),
            candidate.title,
            candidate.mode,
            candidate.interval_seconds,
            candidate.items,
        )
        .await
    }
}
