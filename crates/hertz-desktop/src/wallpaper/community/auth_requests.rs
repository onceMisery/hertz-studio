// SPDX-License-Identifier: MIT
//! A native request borrows the existing Auth session; it cannot create an identity.
use super::*;

#[derive(Clone)]
pub(crate) struct RequestSession {
    pub account: Account,
    epoch: u64,
    access: Zeroizing<String>,
}

impl RequestSession {
    pub(crate) fn token(&self) -> &str {
        self.access.as_str()
    }

    pub(crate) fn same_identity(&self, other: &Self) -> bool {
        self.epoch == other.epoch
            && self.account.source_id == other.account.source_id
            && self.account.issuer == other.account.issuer
            && self.account.subject == other.account.subject
    }
}

impl Auth {
    #[cfg(test)]
    pub(crate) fn session_for_test(&self, account: Account, token: &str) -> RequestSession {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                account.source_id.clone(),
                Session {
                    account: account.clone(),
                    access: Zeroizing::new(token.into()),
                },
            );
        RequestSession {
            account,
            epoch: self.epoch.load(Ordering::Acquire),
            access: Zeroizing::new(token.into()),
        }
    }

    pub(crate) async fn request_session(
        &self,
        library: &Library,
        source: &str,
    ) -> Result<RequestSession, JobError> {
        let epoch = self.epoch.load(Ordering::Acquire);
        let access = self.access(library, source).await?;
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let session = sessions
            .get(source)
            .filter(|session| {
                self.epoch.load(Ordering::Acquire) == epoch
                    && session.access.as_str() == access.as_str()
            })
            .ok_or_else(|| error("account_changed", "账号已变化，请重新核对操作"))?;
        Ok(RequestSession {
            account: session.account.clone(),
            epoch,
            access,
        })
    }

    pub(crate) fn check_request(&self, request: &RequestSession) -> Result<(), JobError> {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if self.epoch.load(Ordering::Acquire) != request.epoch
            || !sessions
                .get(&request.account.source_id)
                .is_some_and(|session| {
                    session.account.issuer == request.account.issuer
                        && session.account.subject == request.account.subject
                })
        {
            return Err(error("account_changed", "账号已退出或变化，请重新核对操作"));
        }
        Ok(())
    }
}
