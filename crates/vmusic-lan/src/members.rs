// SPDX-License-Identifier: MIT
//! Room-scoped authorization. Callers serialize mutation under one room-owner lock.
//! Only token hashes are retained; connection cancellation is part of revocation.
use crate::protocol::StreamIdentity;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use uuid::Uuid;

pub const MAX_MEMBERS: usize = 16;
pub const MAX_INVITATIONS: usize = 16;
pub const INVITATION_TTL: Duration = Duration::from_secs(300);
const MAX_RATE_SOURCES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    pub listen: bool,
    pub queue: bool,
    pub transport: bool,
    pub volume: bool,
    pub chat_read: bool,
    pub chat_send: bool,
}
impl Default for Permissions {
    fn default() -> Self {
        Self {
            listen: true,
            queue: false,
            transport: false,
            volume: false,
            chat_read: true,
            chat_send: true,
        }
    }
}

/// Secret-bearing values deliberately have neither Debug nor Serialize.
pub struct Secret(String);
impl Secret {
    pub fn generate() -> Result<Self, AccessError> {
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes).map_err(|_| AccessError::Entropy)?;
        Ok(Self(bytes.iter().map(|b| format!("{b:02x}")).collect()))
    }
    pub fn parse(text: &str) -> Result<Self, AccessError> {
        if text.len() != 64
            || !text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(AccessError::Denied);
        }
        Ok(Self(text.to_owned()))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    fn digest(&self) -> [u8; 32] {
        Sha256::digest(self.0.as_bytes()).into()
    }
}
impl Drop for Secret {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AccessError {
    #[error("room authorization denied")]
    Denied,
    #[error("room member or invitation limit reached")]
    Capacity,
    #[error("pairing rate limited")]
    RateLimited,
    #[error("invalid member name")]
    Name,
    #[error("connection already attached")]
    AlreadyConnected,
    #[error("secure random generator unavailable")]
    Entropy,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemberView {
    pub id: Uuid,
    pub name: String,
    pub permissions: Permissions,
    pub connected: bool,
}
struct Invitation {
    hash: [u8; 32],
    expires: Instant,
    permissions: Permissions,
}
struct Session {
    id: Uuid,
    audio_attached: bool,
    invalidated: watch::Sender<bool>,
}
struct Member {
    id: Uuid,
    name: String,
    hash: [u8; 32],
    permissions: Permissions,
    session: Option<Session>,
}
struct Rate {
    credit: f64,
    updated: Instant,
}
impl Rate {
    fn new(now: Instant, burst: f64) -> Self {
        Self {
            credit: burst,
            updated: now,
        }
    }
    fn allow(&mut self, now: Instant, per_second: f64, burst: f64) -> bool {
        self.credit = (self.credit
            + now.saturating_duration_since(self.updated).as_secs_f64() * per_second)
            .min(burst);
        self.updated = now;
        if self.credit < 1.0 {
            false
        } else {
            self.credit -= 1.0;
            true
        }
    }
}

pub struct MemberRegistry {
    room_id: Uuid,
    instance_id: Uuid,
    members: HashMap<Uuid, Member>,
    invitations: Vec<Invitation>,
    sources: HashMap<IpAddr, Rate>,
    global_rate: Rate,
}
pub struct Paired {
    pub member_id: Uuid,
    pub credential: Secret,
    pub permissions: Permissions,
}
pub struct AuthorizedSession {
    pub member_id: Uuid,
    pub identity: StreamIdentity,
    /// A permission change, either stream closing, or room end invalidates both streams.
    pub invalidated: watch::Receiver<bool>,
}
impl MemberRegistry {
    pub fn new(room_id: Uuid, instance_id: Uuid, now: Instant) -> Self {
        Self {
            room_id,
            instance_id,
            members: HashMap::new(),
            invitations: Vec::new(),
            sources: HashMap::new(),
            global_rate: Rate::new(now, 10.0),
        }
    }
    pub fn invite(
        &mut self,
        now: Instant,
        permissions: Permissions,
    ) -> Result<Secret, AccessError> {
        self.invitations.retain(|i| i.expires > now);
        if self.members.len() >= MAX_MEMBERS || self.invitations.len() >= MAX_INVITATIONS {
            return Err(AccessError::Capacity);
        }
        let secret = Secret::generate()?;
        self.invitations.push(Invitation {
            hash: secret.digest(),
            expires: now + INVITATION_TTL,
            permissions,
        });
        Ok(secret)
    }
    pub fn pair(
        &mut self,
        source: IpAddr,
        secret: &Secret,
        name: &str,
        now: Instant,
    ) -> Result<Paired, AccessError> {
        self.sources
            .retain(|_, rate| now.saturating_duration_since(rate.updated) < INVITATION_TTL);
        if !self.global_rate.allow(now, 1.0, 10.0) {
            return Err(AccessError::RateLimited);
        }
        if !self.sources.contains_key(&source) && self.sources.len() >= MAX_RATE_SOURCES {
            return Err(AccessError::RateLimited);
        }
        if !self
            .sources
            .entry(source)
            .or_insert_with(|| Rate::new(now, 3.0))
            .allow(now, 0.2, 3.0)
        {
            return Err(AccessError::RateLimited);
        }
        validate_name(name)?;
        self.invitations.retain(|i| i.expires > now);
        let hash = secret.digest();
        let index = self
            .invitations
            .iter()
            .position(|i| constant_eq(&i.hash, &hash))
            .ok_or(AccessError::Denied)?;
        if self.members.len() >= MAX_MEMBERS {
            return Err(AccessError::Capacity);
        }
        // Generate before consuming: entropy failure leaves the invitation usable.
        let credential = Secret::generate()?;
        let invitation = self.invitations.swap_remove(index);
        let id = Uuid::new_v4();
        self.members.insert(
            id,
            Member {
                id,
                name: name.trim().into(),
                hash: credential.digest(),
                permissions: invitation.permissions,
                session: None,
            },
        );
        Ok(Paired {
            member_id: id,
            credential,
            permissions: invitation.permissions,
        })
    }
    pub fn control(
        &mut self,
        member_id: Uuid,
        credential: &Secret,
    ) -> Result<AuthorizedSession, AccessError> {
        let member = self.authenticate_mut(member_id, credential)?;
        if member.session.is_some() {
            return Err(AccessError::AlreadyConnected);
        }
        let (invalidated, rx) = watch::channel(false);
        let session_id = Uuid::new_v4();
        member.session = Some(Session {
            id: session_id,
            audio_attached: false,
            invalidated,
        });
        Ok(AuthorizedSession {
            member_id,
            identity: StreamIdentity {
                room_id: self.room_id,
                instance_id: self.instance_id,
                session_id,
            },
            invalidated: rx,
        })
    }
    pub fn audio(
        &mut self,
        member_id: Uuid,
        credential: &Secret,
        identity: StreamIdentity,
    ) -> Result<AuthorizedSession, AccessError> {
        if identity.room_id != self.room_id || identity.instance_id != self.instance_id {
            return Err(AccessError::Denied);
        }
        let member = self.authenticate_mut(member_id, credential)?;
        if !member.permissions.listen {
            return Err(AccessError::Denied);
        }
        let session = member.session.as_mut().ok_or(AccessError::Denied)?;
        if session.id != identity.session_id {
            return Err(AccessError::Denied);
        }
        if session.audio_attached {
            return Err(AccessError::AlreadyConnected);
        }
        session.audio_attached = true;
        Ok(AuthorizedSession {
            member_id,
            identity,
            invalidated: session.invalidated.subscribe(),
        })
    }
    pub fn permissions(
        &self,
        member_id: Uuid,
        session_id: Uuid,
    ) -> Result<Permissions, AccessError> {
        let member = self.members.get(&member_id).ok_or(AccessError::Denied)?;
        if member.session.as_ref().is_none_or(|s| s.id != session_id) {
            return Err(AccessError::Denied);
        }
        Ok(member.permissions)
    }
    pub fn disconnect(&mut self, member_id: Uuid, session_id: Uuid) {
        if let Some(member) = self.members.get_mut(&member_id) {
            if member.session.as_ref().is_some_and(|s| s.id == session_id) {
                invalidate(member);
            }
        }
    }
    pub fn set_permissions(
        &mut self,
        id: Uuid,
        permissions: Permissions,
    ) -> Result<(), AccessError> {
        let member = self.members.get_mut(&id).ok_or(AccessError::Denied)?;
        if member.permissions != permissions {
            invalidate(member);
            member.permissions = permissions;
        }
        Ok(())
    }
    pub fn revoke(&mut self, id: Uuid) -> Result<(), AccessError> {
        let mut member = self.members.remove(&id).ok_or(AccessError::Denied)?;
        invalidate(&mut member);
        Ok(())
    }
    pub fn end(&mut self) {
        for member in self.members.values_mut() {
            invalidate(member);
        }
        self.members.clear();
        self.invitations.clear();
    }
    pub fn members(&self) -> Vec<MemberView> {
        let mut members: Vec<_> = self
            .members
            .values()
            .map(|m| MemberView {
                id: m.id,
                name: m.name.clone(),
                permissions: m.permissions,
                connected: m.session.is_some(),
            })
            .collect();
        members.sort_by_key(|m| m.id);
        members
    }
    fn authenticate_mut(
        &mut self,
        id: Uuid,
        credential: &Secret,
    ) -> Result<&mut Member, AccessError> {
        self.members
            .get_mut(&id)
            .filter(|m| constant_eq(&m.hash, &credential.digest()))
            .ok_or(AccessError::Denied)
    }
}
impl Drop for MemberRegistry {
    fn drop(&mut self) {
        self.end();
    }
}
fn invalidate(member: &mut Member) {
    if let Some(session) = member.session.take() {
        session.invalidated.send_replace(true);
    }
}
fn constant_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    use subtle::ConstantTimeEq;
    bool::from(a.ct_eq(b))
}
pub fn validate_name(name: &str) -> Result<(), AccessError> {
    if name.trim().is_empty()
        || name.len() > 128
        || name.chars().count() > 32
        || name.chars().any(char::is_control)
    {
        return Err(AccessError::Name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn registry(now: Instant) -> MemberRegistry {
        MemberRegistry::new(Uuid::new_v4(), Uuid::new_v4(), now)
    }
    #[test]
    fn one_use_expiry_limits_and_revocation_close_both_streams() {
        let now = Instant::now();
        let mut registry = registry(now);
        let invite = registry.invite(now, Permissions::default()).unwrap();
        let source = "127.0.0.1".parse().unwrap();
        let paired = registry.pair(source, &invite, "电脑", now).unwrap();
        assert!(registry.pair(source, &invite, "重放", now).is_err());
        let control = registry
            .control(paired.member_id, &paired.credential)
            .unwrap();
        let audio = registry
            .audio(paired.member_id, &paired.credential, control.identity)
            .unwrap();
        assert!(registry
            .audio(paired.member_id, &paired.credential, control.identity)
            .is_err());
        registry
            .set_permissions(
                paired.member_id,
                Permissions {
                    chat_send: false,
                    ..Permissions::default()
                },
            )
            .unwrap();
        assert!(*audio.invalidated.borrow());
        assert!(*control.invalidated.borrow());
        assert!(registry
            .permissions(paired.member_id, control.identity.session_id)
            .is_err());
        let new = registry
            .control(paired.member_id, &paired.credential)
            .unwrap();
        registry.disconnect(paired.member_id, control.identity.session_id);
        assert!(!*new.invalidated.borrow());
        registry.revoke(paired.member_id).unwrap();
        assert!(*new.invalidated.borrow());
        assert!(registry
            .control(paired.member_id, &paired.credential)
            .is_err());
        let invite = registry.invite(now, Permissions::default()).unwrap();
        assert!(registry
            .pair(source, &invite, "已过期", now + INVITATION_TTL)
            .is_err());
    }
    #[test]
    fn source_memory_and_invitation_counts_are_bounded_and_names_validated() {
        let now = Instant::now();
        let mut registry = registry(now);
        for _ in 0..MAX_INVITATIONS {
            registry.invite(now, Permissions::default()).unwrap();
        }
        assert!(matches!(
            registry.invite(now, Permissions::default()),
            Err(AccessError::Capacity)
        ));
        assert!(registry
            .invite(now + INVITATION_TTL, Permissions::default())
            .is_ok());
        assert!(validate_name("  ").is_err());
        assert!(validate_name("name\n").is_err());
        assert!(validate_name(&"文".repeat(33)).is_err());
        assert!(Secret::parse(&"A".repeat(64)).is_err());
        let secret = Secret::generate().unwrap();
        for i in 0..300 {
            let source = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, (i / 256) as u8, i as u8));
            let _ = registry.pair(source, &secret, "test", now + Duration::from_secs(i));
        }
        assert!(registry.sources.len() <= MAX_RATE_SOURCES);
    }
}
