// SPDX-License-Identifier: MIT
//! Untrusted applicants have no member identity or resource authorization.
//! The short code is public lookup metadata; only a 256-bit applicant secret
//! permits polling an application, and only host approval produces an invitation.
use crate::members::{validate_name, AccessError, Secret};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::IpAddr,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const MAX_APPLICATIONS: usize = 16;
pub const APPLICATION_TTL: Duration = Duration::from_secs(300);
const MAX_SOURCES: usize = 128;

pub fn room_code(room: Uuid) -> String {
    room.simple().to_string()[..8].to_ascii_uppercase()
}

#[derive(Clone, Serialize)]
pub struct ApplicationView {
    pub id: Uuid,
    pub name: String,
    pub state: &'static str,
    pub expires_in_seconds: u64,
    pub member_id: Option<Uuid>,
}
struct Application {
    id: Uuid,
    name: String,
    proof: [u8; 32],
    expires: Instant,
    decision: Decision,
}
enum Decision {
    Pending,
    Approved(Secret),
    Rejected,
    Consumed(Uuid),
}
struct Rate {
    credit: f64,
    updated: Instant,
}
impl Rate {
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
pub struct Admissions {
    code: String,
    applications: Vec<Application>,
    sources: HashMap<IpAddr, Rate>,
    polls: HashMap<IpAddr, Rate>,
    global: Rate,
}
impl Admissions {
    pub fn new(room: Uuid, now: Instant) -> Self {
        Self {
            code: room_code(room),
            applications: Vec::new(),
            sources: HashMap::new(),
            polls: HashMap::new(),
            global: Rate {
                credit: 10.0,
                updated: now,
            },
        }
    }
    pub fn code(&self) -> &str {
        &self.code
    }
    fn prune(&mut self, now: Instant) {
        self.applications.retain(|a| a.expires > now);
    }
    pub fn apply(
        &mut self,
        source: IpAddr,
        code: &str,
        name: &str,
        now: Instant,
    ) -> Result<(Uuid, Secret), AccessError> {
        rate(&mut self.sources, source, now, 0.2, 3.0)?;
        if !self.global.allow(now, 1.0, 10.0) {
            return Err(AccessError::RateLimited);
        }
        if !code.eq_ignore_ascii_case(&self.code) {
            return Err(AccessError::Denied);
        }
        validate_name(name)?;
        self.prune(now);
        if self.applications.len() >= MAX_APPLICATIONS {
            return Err(AccessError::Capacity);
        }
        let secret = Secret::generate()?;
        let id = Uuid::new_v4();
        self.applications.push(Application {
            id,
            name: name.trim().to_owned(),
            proof: digest(&secret),
            expires: now + APPLICATION_TTL,
            decision: Decision::Pending,
        });
        Ok((id, secret))
    }
    pub fn views(&mut self, now: Instant) -> Vec<ApplicationView> {
        self.prune(now);
        self.applications
            .iter()
            .map(|a| ApplicationView {
                id: a.id,
                name: a.name.clone(),
                state: match a.decision {
                    Decision::Pending => "pending",
                    Decision::Approved(_) => "approved",
                    Decision::Rejected => "rejected",
                    Decision::Consumed(_) => "consumed",
                },
                member_id: match a.decision {
                    Decision::Consumed(id) => Some(id),
                    _ => None,
                },
                expires_in_seconds: a.expires.saturating_duration_since(now).as_secs(),
            })
            .collect()
    }
    pub fn pending(&mut self, id: Uuid, now: Instant) -> Result<(), AccessError> {
        self.prune(now);
        self.applications
            .iter()
            .find(|a| a.id == id && matches!(a.decision, Decision::Pending))
            .map(|_| ())
            .ok_or(AccessError::Denied)
    }
    /// Called under the same owner lock as invitation issuance, after pending().
    pub fn approve(
        &mut self,
        id: Uuid,
        invitation: Secret,
        now: Instant,
    ) -> Result<(), AccessError> {
        self.pending(id, now)?;
        let a = self
            .applications
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or(AccessError::Denied)?;
        a.decision = Decision::Approved(invitation);
        a.expires = now + APPLICATION_TTL;
        Ok(())
    }
    /// Returns a previously issued invitation so the owner revokes it atomically.
    pub fn reject(&mut self, id: Uuid, now: Instant) -> Result<Option<Secret>, AccessError> {
        self.prune(now);
        let a = self
            .applications
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or(AccessError::Denied)?;
        if matches!(a.decision, Decision::Consumed(_)) {
            return Err(AccessError::Denied);
        }
        Ok(
            match std::mem::replace(&mut a.decision, Decision::Rejected) {
                Decision::Approved(secret) => Some(secret),
                _ => None,
            },
        )
    }
    pub fn consumed(&mut self, invitation: &Secret, member_id: Uuid) {
        use subtle::ConstantTimeEq;
        let hash = digest(invitation);
        for application in &mut self.applications {
            if matches!(&application.decision, Decision::Approved(secret) if bool::from(digest(secret).ct_eq(&hash)))
            {
                application.decision = Decision::Consumed(member_id);
                break;
            }
        }
    }
    /// The approved secret never enters the host-visible application list.
    pub fn status(
        &mut self,
        source: IpAddr,
        id: Uuid,
        proof: &Secret,
        now: Instant,
    ) -> Result<(&'static str, Option<Secret>, Option<Uuid>), AccessError> {
        rate(&mut self.polls, source, now, 2.0, 10.0)?;
        self.prune(now);
        use subtle::ConstantTimeEq;
        let hash = digest(proof);
        let a = self
            .applications
            .iter()
            .find(|a| a.id == id && bool::from(a.proof.ct_eq(&hash)))
            .ok_or(AccessError::Denied)?;
        Ok(match &a.decision {
            Decision::Pending => ("pending", None, None),
            Decision::Rejected => ("rejected", None, None),
            Decision::Approved(secret) => ("approved", Some(Secret::parse(secret.expose())?), None),
            Decision::Consumed(member) => ("consumed", None, Some(*member)),
        })
    }
    pub fn end(&mut self) {
        self.applications.clear();
    }
}
fn digest(secret: &Secret) -> [u8; 32] {
    Sha256::digest(secret.expose().as_bytes()).into()
}
fn rate(
    sources: &mut HashMap<IpAddr, Rate>,
    source: IpAddr,
    now: Instant,
    per_second: f64,
    burst: f64,
) -> Result<(), AccessError> {
    sources.retain(|_, r| now.saturating_duration_since(r.updated) < APPLICATION_TTL);
    if !sources.contains_key(&source) && sources.len() >= MAX_SOURCES {
        return Err(AccessError::RateLimited);
    }
    if !sources
        .entry(source)
        .or_insert(Rate {
            credit: burst,
            updated: now,
        })
        .allow(now, per_second, burst)
    {
        return Err(AccessError::RateLimited);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ip(i: u8) -> IpAddr {
        IpAddr::from([10, 0, 0, i])
    }
    #[test]
    fn public_code_is_not_a_poll_secret_and_approval_is_revocable() {
        let now = Instant::now();
        let room = Uuid::new_v4();
        let mut admissions = Admissions::new(room, now);
        let (id, secret) = admissions
            .apply(ip(1), &room_code(room), " Alice ", now)
            .unwrap();
        assert!(admissions
            .status(ip(1), id, &Secret::generate().unwrap(), now)
            .is_err());
        assert_eq!(
            admissions.status(ip(1), id, &secret, now).unwrap().0,
            "pending"
        );
        assert_eq!(admissions.views(now)[0].name, "Alice");
        let invitation = Secret::generate().unwrap();
        let expected = invitation.expose().to_owned();
        admissions.approve(id, invitation, now).unwrap();
        let (state, received, _) = admissions.status(ip(1), id, &secret, now).unwrap();
        assert_eq!(state, "approved");
        assert_eq!(received.unwrap().expose(), expected);
        assert!(admissions
            .approve(id, Secret::generate().unwrap(), now)
            .is_err());
        assert_eq!(
            admissions.reject(id, now).unwrap().unwrap().expose(),
            expected
        );
        assert_eq!(
            admissions.status(ip(1), id, &secret, now).unwrap().0,
            "rejected"
        );
        assert!(admissions
            .status(ip(1), id, &secret, now + APPLICATION_TTL)
            .is_err());
    }
    #[test]
    fn flood_limits_memory_and_blocked_source_cannot_spend_global_credit() {
        let now = Instant::now();
        let room = Uuid::new_v4();
        let mut a = Admissions::new(room, now);
        let code = room_code(room);
        for _ in 0..100 {
            let _ = a.apply(ip(1), "wrong", "x", now);
        }
        assert!(a.apply(ip(2), &code, "valid", now).is_ok());
        for i in 3..=16 {
            assert!(a
                .apply(
                    ip(i),
                    &code,
                    "valid",
                    now + Duration::from_secs(u64::from(i))
                )
                .is_ok());
        }
        assert!(a
            .apply(ip(17), &code, "last", now + Duration::from_secs(17))
            .is_ok());
        assert!(matches!(
            a.apply(ip(18), &code, "full", now + Duration::from_secs(18)),
            Err(AccessError::Capacity)
        ));
        for i in 19..=255 {
            let _ = a.apply(ip(i), &code, "full", now + Duration::from_secs(19));
        }
        assert!(a.sources.len() <= MAX_SOURCES);
        assert_eq!(a.applications.len(), MAX_APPLICATIONS);
        assert!(a
            .apply(
                ip(2),
                &code,
                "after expiry",
                now + APPLICATION_TTL + Duration::from_secs(20)
            )
            .is_ok());
        a.end();
        assert!(a.views(now).is_empty());
    }
}
