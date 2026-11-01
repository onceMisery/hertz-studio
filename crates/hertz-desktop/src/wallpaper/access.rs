// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Broker 的原生准入集合。每个 controller 独立持有，默认拒绝全部资源。
//! 换代一次撤销旧请求、缓存和流；页面中的 hash URL 不授予访问资格。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct MediaAccess(Arc<Mutex<AccessState>>);

struct AccessState {
    generation: u64,
    scope: Arc<Scope>,
    resources: Resources,
}

type Resources = BTreeMap<(String, String), Option<Arc<super::assets::PinnedMedia>>>;

struct Scope {
    active: AtomicBool,
    readers: AtomicUsize,
}

/// 撤销后的真实文件活动屏障；不持有文件，因此保留它不会阻止 staging 发布。
pub(crate) struct Drain(Arc<Scope>);

impl Drain {
    pub(crate) fn is_drained(&self) -> bool {
        self.0.readers.load(Ordering::Acquire) == 0
    }
}

pub(crate) struct ReadPermit {
    pub(crate) generation: u64,
    scope: Arc<Scope>,
    pinned: Option<Arc<super::assets::PinnedMedia>>,
}

impl ReadPermit {
    pub(crate) fn is_active(&self) -> bool {
        self.scope.active.load(Ordering::Acquire)
    }

    pub(crate) fn pinned(&self) -> Option<&Arc<super::assets::PinnedMedia>> {
        self.pinned.as_ref()
    }
}

impl Clone for ReadPermit {
    fn clone(&self) -> Self {
        self.scope.readers.fetch_add(1, Ordering::AcqRel);
        Self {
            generation: self.generation,
            scope: Arc::clone(&self.scope),
            pinned: self.pinned.clone(),
        }
    }
}

impl Drop for ReadPermit {
    fn drop(&mut self) {
        // 先关闭所持文件，最后才把屏障计数降为零。
        self.pinned.take();
        self.scope.readers.fetch_sub(1, Ordering::AcqRel);
    }
}

impl MediaAccess {
    pub(crate) fn new() -> Self {
        Self(Arc::new(Mutex::new(AccessState {
            generation: 0,
            scope: Arc::new(Scope {
                active: AtomicBool::new(false),
                readers: AtomicUsize::new(0),
            }),
            resources: BTreeMap::new(),
        })))
    }

    /// 只由原生 TargetPlanner 在准入后调用；同代际、旧代际和畸形集合不改授权。
    /// 现阶段生产只使用内置场景，集合保持为空；媒体选择随 P1-05 接入。
    pub(crate) fn replace(&self, generation: u64, resources: &[(String, String)]) -> bool {
        if resources.len() > 512 {
            return false;
        }
        self.replace_resources(
            generation,
            resources.iter().cloned().map(|key| (key, None)).collect(),
        )
    }

    fn replace_resources(&self, generation: u64, resources: Resources) -> bool {
        if resources.len() > 512
            || resources.keys().any(|(hash, path)| {
                hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    || hertz_wallpaper::validate_rel_path(path).is_err()
            })
        {
            return false;
        }
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if generation <= state.generation {
            return false;
        }
        state.scope.active.store(false, Ordering::Release);
        state.generation = generation;
        state.scope = Arc::new(Scope {
            active: AtomicBool::new(true),
            readers: AtomicUsize::new(0),
        });
        state.resources = resources;
        true
    }

    /// 原生导入管线传入已校验且拒绝写/删除共享的单个文件，页面不能提供根路径。
    pub(crate) fn grant_probe(
        &self,
        generation: u64,
        hash: String,
        media: Arc<super::assets::PinnedMedia>,
    ) -> bool {
        let key = (hash, media.entry.path.clone());
        self.replace_resources(generation, [(key, Some(media))].into_iter().collect())
    }

    pub(crate) fn permit(&self, hash: &str, path: &str) -> Option<ReadPermit> {
        let state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if !state.scope.active.load(Ordering::Acquire) {
            return None;
        }
        let pinned = state.resources.get(&(hash.to_string(), path.to_string()))?;
        state.scope.readers.fetch_add(1, Ordering::AcqRel);
        Some(ReadPermit {
            generation: state.generation,
            scope: Arc::clone(&state.scope),
            pinned: pinned.clone(),
        })
    }

    pub(crate) fn revoke(&self) -> Drain {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.scope.active.store(false, Ordering::Release);
        state.resources.clear();
        Drain(Arc::clone(&state.scope))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_covers_queued_and_cloned_readers_without_counting_the_access_owner() {
        let access = MediaAccess::new();
        let hash = "a".repeat(64);
        assert!(access.replace(1, &[(hash.clone(), "assets/a.png".into())]));
        let queued = access.permit(&hash, "assets/a.png").unwrap();
        let response = queued.clone();
        let drain = access.revoke();
        assert!(!drain.is_drained());
        drop(queued);
        assert!(!drain.is_drained());
        assert!(access.replace(2, &[(hash.clone(), "assets/a.png".into())]));
        let next = access.permit(&hash, "assets/a.png").unwrap();
        drop(response);
        assert!(drain.is_drained(), "新代际不阻挡旧代际退出");
        assert!(next.is_active());
    }

    #[test]
    fn default_deny_exact_resources_and_controller_isolation() {
        let access = MediaAccess::new();
        let other = MediaAccess::new();
        let hash = "a".repeat(64);
        assert!(access.permit(&hash, "assets/a.png").is_none());
        assert!(access.replace(1, &[(hash.clone(), "assets/a.png".into())]));
        assert!(access.permit(&hash, "assets/a.png").is_some());
        assert!(access.permit(&hash, "assets/b.png").is_none());
        assert!(other.permit(&hash, "assets/a.png").is_none());
    }

    #[test]
    fn replacement_revokes_old_permits_and_old_generation_cannot_restore_them() {
        let access = MediaAccess::new();
        let resources = [("a".repeat(64), "assets/a.png".into())];
        assert!(access.replace(4, &resources));
        let old = access.permit(&resources[0].0, &resources[0].1).unwrap();
        assert!(access.replace(5, &resources));
        assert!(!old.is_active());
        assert!(!access.replace(4, &resources));
        assert!(!access.replace(5, &resources));
        let new = access.permit(&resources[0].0, &resources[0].1).unwrap();
        assert!(new.is_active());
        access.revoke();
        assert!(!new.is_active());
        assert!(access.permit(&resources[0].0, &resources[0].1).is_none());
        assert!(!access.replace(5, &resources));
    }

    #[test]
    fn invalid_replacement_does_not_mutate_current_grant() {
        let access = MediaAccess::new();
        let hash = "a".repeat(64);
        assert!(access.replace(1, &[(hash.clone(), "assets/a.png".into())]));
        assert!(!access.replace(2, &[(hash.clone(), "assets/../a.png".into())]));
        assert!(!access.replace(2, &[("g".repeat(64), "assets/a.png".into())]));
        assert!(access.permit(&hash, "assets/a.png").unwrap().is_active());
    }
}
