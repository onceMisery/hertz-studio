// SPDX-License-Identifier: MIT
//! Bounded synchronous facts for GUI/runtime gates; no SQLite or networking on
//! those paths. TrustStore replaces this cache only after a durable transaction.
use super::{error, now};
use crate::wallpaper::jobs::JobError;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub(super) struct Cache {
    pub security: BTreeMap<[u8; 32], u64>,
    pub community: BTreeMap<[u8; 32], BTreeSet<String>>,
    pub activated: BTreeSet<[u8; 32]>,
    pub sources: BTreeMap<String, Freshness>,
    pub observed_at: u64,
    pub unavailable: bool,
}

#[derive(Clone, Copy, Default)]
pub(super) struct Freshness {
    pub issued: u64,
    pub expires: u64,
    pub observed: u64,
}

impl Freshness {
    pub(super) fn fresh(&self, time: u64) -> bool {
        self.issued > 0 && time >= self.issued && time >= self.observed && time < self.expires
    }
}

pub(super) fn hash(value: &str) -> Result<[u8; 32], JobError> {
    if value.len() != 64 {
        return Err(error("invalid_hash", "需要完整 SHA256 包哈希"));
    }
    let mut bytes = [0u8; 32];
    for (i, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let digit = |b: u8| match b {
            b'0'..=b'9' => Ok(b - b'0'),
            b'a'..=b'f' => Ok(b - b'a' + 10),
            _ => Err(error("invalid_hash", "包哈希必须使用小写十六进制")),
        };
        bytes[i] = digit(pair[0])? * 16 + digit(pair[1])?;
    }
    Ok(bytes)
}

impl Cache {
    pub(super) fn security_check(&self, value: &str, observed: u64) -> Result<(), JobError> {
        if self.unavailable {
            return Err(error(
                "trust_unavailable",
                "安全事实尚不可用，暂不能使用包内容",
            ));
        }
        let key = hash(value)?;
        let time = self.observed_at.max(observed);
        if self
            .security
            .get(&key)
            .is_some_and(|effective| *effective <= time)
        {
            return Err(error(
                "security_revoked",
                "此完整包哈希已被安全撤销，不能导入、预览、运行或回滚",
            ));
        }
        Ok(())
    }

    pub(super) fn activation_check(
        &self,
        value: &str,
        is_web: bool,
        observed: u64,
    ) -> Result<(), JobError> {
        self.security_check(value, observed)?;
        let key = hash(value)?;
        if is_web && self.community.contains_key(&key) && !self.activated.contains(&key) {
            let time = now();
            if time < observed
                || !self.community[&key]
                    .iter()
                    .any(|s| self.sources.get(s).is_some_and(|f| f.fresh(time)))
            {
                return Err(error(
                    "revocations_stale",
                    "新的社区 Web 包必须先同步新鲜撤销状态",
                ));
            }
        }
        Ok(())
    }
}
