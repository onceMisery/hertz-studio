// SPDX-License-Identifier: MIT
//! Ephemeral metadata, owned by the existing quote lifecycle. Never holds paths or bytes.
use hertz_wallpaper::generation::composition::AssetSet;
use serde_json::{json, Value};
use std::sync::{Arc, Weak};

use crate::error::{ApiError, ApiResult};

struct Snapshot {
    id: String,
    owner: String,
    assets: AssetSet,
    expires_at: i64,
    active_job: Weak<()>,
}

#[derive(Default)]
pub(in crate::ai) struct Store {
    snapshots: Vec<Snapshot>,
}

fn unknown() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::NOT_FOUND,
        "asset_set_unknown",
        "素材快照不存在、已到期或属于其它会话",
    )
}

impl Store {
    pub(super) fn discard(&mut self, owner: &str) {
        for snapshot in &mut self.snapshots {
            if snapshot.owner == owner {
                snapshot.expires_at = 0;
            }
        }
        self.snapshots
            .retain(|snapshot| snapshot.owner != owner || snapshot.active_job.strong_count() > 0);
    }
    pub(super) fn remove(&mut self, owner: &str, id: &str) {
        for snapshot in &mut self.snapshots {
            if snapshot.owner == owner && snapshot.id == id {
                snapshot.expires_at = 0;
            }
        }
        self.snapshots.retain(|snapshot| {
            snapshot.owner != owner || snapshot.id != id || snapshot.active_job.strong_count() > 0
        });
    }
    pub(in crate::ai) fn pin(&mut self, owner: &str, id: &str, now: i64) -> ApiResult<Arc<()>> {
        let snapshot = self
            .snapshots
            .iter_mut()
            .find(|snapshot| {
                snapshot.owner == owner && snapshot.id == id && snapshot.expires_at > now
            })
            .ok_or_else(unknown)?;
        if let Some(active) = snapshot.active_job.upgrade() {
            return Ok(active);
        }
        let active = Arc::new(());
        snapshot.active_job = Arc::downgrade(&active);
        Ok(active)
    }
    pub(in crate::ai) fn insert(
        &mut self,
        owner: &str,
        assets: AssetSet,
        now: i64,
    ) -> ApiResult<Value> {
        self.snapshots
            .retain(|snapshot| snapshot.expires_at > now || snapshot.active_job.strong_count() > 0);
        if self
            .snapshots
            .iter()
            .filter(|snapshot| snapshot.owner == owner)
            .count()
            >= 8
        {
            return Err(ApiError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                "asset_set_capacity_exceeded",
                "最多保留八组素材快照，请等待旧快照到期",
            ));
        }
        let digest = assets.digest().map_err(|error| {
            ApiError::new(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                error.code,
                error.message,
            )
        })?;
        let id = uuid::Uuid::new_v4().to_string();
        let expires_at = now + crate::ai::wallpaper_jobs::QUOTE_TTL_MS;
        let result = json!({"assetSetId":id,"digest":digest,"expiresAt":expires_at,"assetCount":assets.assets.len()});
        self.snapshots.push(Snapshot {
            id,
            owner: owner.into(),
            assets,
            expires_at,
            active_job: Weak::new(),
        });
        Ok(result)
    }
    pub(in crate::ai) fn lookup(&mut self, owner: &str, id: &str, now: i64) -> ApiResult<AssetSet> {
        self.snapshots
            .retain(|snapshot| snapshot.expires_at > now || snapshot.active_job.strong_count() > 0);
        self.snapshots
            .iter()
            .find(|snapshot| {
                snapshot.id == id && snapshot.owner == owner && snapshot.expires_at > now
            })
            .map(|snapshot| snapshot.assets.clone())
            .ok_or_else(unknown)
    }
    pub(super) fn bind_quote(
        &mut self,
        owner: &str,
        id: &str,
        assets: &AssetSet,
        now: i64,
        expires_at: i64,
    ) -> ApiResult<()> {
        let current = self.lookup(owner, id, now)?;
        if current.digest().map_err(|_| unknown())? != assets.digest().map_err(|_| unknown())? {
            return Err(unknown());
        }
        let snapshot = self
            .snapshots
            .iter_mut()
            .find(|snapshot| snapshot.owner == owner && snapshot.id == id)
            .ok_or_else(unknown)?;
        snapshot.expires_at = snapshot.expires_at.max(expires_at);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn assets() -> AssetSet {
        AssetSet::parse(
            br#"{"assets":[{"alias":"asset-1","kind":"image","width":640,"height":480}]}"#,
        )
        .unwrap()
    }
    #[test]
    fn metadata_is_owner_bound_bounded_and_not_silently_renewed() {
        let mut store = Store::default();
        let first = store.insert("first", assets(), 100).unwrap();
        let id = first["assetSetId"].as_str().unwrap();
        assert!(store.lookup("second", id, 101).is_err());
        assert!(store.lookup("first", id, 101).is_ok());
        for _ in 1..8 {
            store.insert("first", assets(), 101).unwrap();
        }
        assert_eq!(
            store.insert("first", assets(), 102).unwrap_err().code,
            "asset_set_capacity_exceeded"
        );
        assert!(store
            .lookup("first", id, 100 + crate::ai::wallpaper_jobs::QUOTE_TTL_MS)
            .is_err());
        store.discard("first");
        assert!(store.snapshots.is_empty());
    }
    #[test]
    fn quote_binding_retains_the_same_digest_until_quote_expiry() {
        let mut store = Store::default();
        let first = store.insert("owner", assets(), 100).unwrap();
        let id = first["assetSetId"].as_str().unwrap();
        store
            .bind_quote("owner", id, &assets(), 200, 300_200)
            .unwrap();
        assert!(store.lookup("owner", id, 300_100).is_ok());
        let changed = AssetSet::parse(
            br#"{"assets":[{"alias":"asset-1","kind":"image","width":641,"height":480}]}"#,
        )
        .unwrap();
        assert!(store
            .bind_quote("owner", id, &changed, 300_101, 400_000)
            .is_err());
        assert!(store.lookup("owner", id, 300_200).is_err());
    }
}
