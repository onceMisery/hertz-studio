// SPDX-License-Identifier: MIT
//! One native login/refresh owner. Tokens never enter trusted page DTOs or logs.
use super::{credentials, error, model::SourceProfile, network, now, store::db};
use crate::wallpaper::{
    budget::{self, ControlCharge},
    jobs::JobError,
    library::Library,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use zeroize::{Zeroize, Zeroizing};
#[path = "auth_callback.rs"]
mod callback;
#[path = "auth_jwt.rs"]
mod jwt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    pub source_id: String,
    pub issuer: String,
    pub subject: String,
    pub expires_at: u64,
}
struct Session {
    account: Account,
    access: Zeroizing<String>,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    token_type: String,
}
impl Drop for TokenResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(token) = self.refresh_token.as_mut() {
            token.zeroize();
        }
    }
}

pub(crate) struct Auth {
    epoch: AtomicU64,
    flight: Mutex<Option<Arc<AtomicBool>>>,
    operation: tokio::sync::Mutex<()>,
    sessions: Mutex<BTreeMap<String, Session>>,
    verifier: jwt::Verifier,
    _charge: ControlCharge,
}

impl Auth {
    pub(crate) fn new() -> Result<Arc<Self>, JobError> {
        let charge = budget::global()
            .admit_working_bytes(4 * 1024 * 1024)
            .map_err(|e| error("budget_busy", e.message.to_string()))?;
        Ok(Arc::new(Self {
            epoch: AtomicU64::new(1),
            flight: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
            sessions: Mutex::new(BTreeMap::new()),
            verifier: jwt::Verifier::default(),
            _charge: charge,
        }))
    }

    pub(crate) fn cancel_login(&self) {
        if let Some(cancel) = self
            .flight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            cancel.store(true, Ordering::Release);
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
    }
    pub(crate) fn stop(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        self.cancel_login();
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    pub(crate) async fn login(
        &self,
        library: &Library,
        profile: SourceProfile,
        allow_refresh: bool,
        open: impl FnOnce(String),
    ) -> Result<Account, JobError> {
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut flight = self.flight.lock().unwrap_or_else(|e| e.into_inner());
            if flight.is_some() {
                return Err(error("login_busy", "已有一个社区登录正在等待系统浏览器"));
            }
            *flight = Some(Arc::clone(&cancel));
        }
        let epoch = self.epoch.load(Ordering::Acquire);
        let result = async {
            let trusted = library.trust().profile(&profile.source_id).await?;
            if trusted.origin != profile.origin {
                return Err(error("source_conflict", "登录来源已经变化"));
            }
            if allow_refresh && !trusted.auth.scopes.iter().any(|s| s == "offline_access") {
                return Err(error(
                    "offline_access_unavailable",
                    "此来源没有注册续期登录范围",
                ));
            }
            let scopes = trusted
                .auth
                .scopes
                .iter()
                .filter(|s| allow_refresh || s.as_str() != "offline_access")
                .cloned()
                .collect::<Vec<_>>()
                .join(" ");
            let discovery = jwt::discovery(&trusted).await?;
            let pkce = callback::Pkce::new().await?;
            let mut url = network::https(&discovery.authorization_endpoint)?;
            url.query_pairs_mut()
                .append_pair("response_type", "code")
                .append_pair("client_id", &trusted.auth.client_id)
                .append_pair("redirect_uri", &pkce.redirect)
                .append_pair("scope", &scopes)
                .append_pair("state", &pkce.state)
                .append_pair("code_challenge", &pkce.challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("audience", &trusted.auth.audience);
            if cancel.load(Ordering::Acquire) {
                return Err(error("cancelled", "登录已取消"));
            }
            open(url.into());
            let code = pkce.wait(&cancel, &trusted.auth.issuer).await?;
            let _slot = self.operation.lock().await;
            if cancel.load(Ordering::Acquire) || epoch != self.epoch.load(Ordering::Acquire) {
                return Err(error("cancelled", "登录已取消"));
            }
            let response = self
                .tokens(
                    &discovery.token_endpoint,
                    &[
                        ("grant_type", "authorization_code"),
                        ("client_id", &trusted.auth.client_id),
                        ("code", &code),
                        ("redirect_uri", &pkce.redirect),
                        ("code_verifier", &pkce.verifier),
                    ],
                )
                .await?;
            self.accept(library, &trusted, response, None, allow_refresh, epoch)
                .await
        }
        .await;
        let mut flight = self.flight.lock().unwrap_or_else(|e| e.into_inner());
        if flight.as_ref().is_some_and(|v| Arc::ptr_eq(v, &cancel)) {
            *flight = None;
        }
        result
    }

    async fn tokens(
        &self,
        endpoint: &str,
        form: &[(&str, &str)],
    ) -> Result<TokenResponse, JobError> {
        let (client, url) = network::client(endpoint, Duration::from_secs(15)).await?;
        let response = client
            .post(url)
            .header("Accept-Encoding", "identity")
            .form(form)
            .send()
            .await
            .map_err(|_| error("login_network", "OIDC token 请求失败"))?;
        let bytes = Zeroizing::new(network::bounded(response, 65536).await?);
        let tokens: TokenResponse = serde_json::from_slice(&bytes)
            .map_err(|_| error("access_token_invalid", "OIDC token 响应无效"))?;
        if !tokens.token_type.eq_ignore_ascii_case("Bearer")
            || tokens.access_token.len() > 16384
            || tokens
                .refresh_token
                .as_ref()
                .is_some_and(|t| t.is_empty() || t.len() > 2560)
        {
            return Err(error("access_token_invalid", "OIDC token 形状或大小无效"));
        }
        Ok(tokens)
    }

    async fn saved_account(
        &self,
        library: &Library,
        source: &str,
    ) -> Result<Option<(String, String, String)>, JobError> {
        network::canonical_uuid(source)?;
        let row:Option<(Option<String>,Option<String>,Option<String>)>=sqlx::query_as("SELECT CASE WHEN length(CAST(issuer AS BLOB)) BETWEEN 1 AND 2048 THEN issuer ELSE NULL END,CASE WHEN length(CAST(client_id AS BLOB)) BETWEEN 1 AND 256 THEN client_id ELSE NULL END,CASE WHEN length(CAST(subject AS BLOB)) BETWEEN 1 AND 255 THEN subject ELSE NULL END FROM community_accounts WHERE source_id=?1").bind(source).fetch_optional(library.pool()).await.map_err(db)?;
        row.map(|(issuer, client, subject)| {
            let issuer =
                issuer.ok_or_else(|| error("account_database_invalid", "账号 issuer 超出界限"))?;
            let client = client
                .ok_or_else(|| error("account_database_invalid", "账号 clientId 超出界限"))?;
            let subject =
                subject.ok_or_else(|| error("account_database_invalid", "账号主体超出界限"))?;
            if subject.chars().any(char::is_control) {
                return Err(error("account_database_invalid", "账号主体包含控制字符"));
            }
            Ok((issuer, client, subject))
        })
        .transpose()
    }

    async fn accept(
        &self,
        library: &Library,
        profile: &SourceProfile,
        tokens: TokenResponse,
        old_refresh: Option<&str>,
        allow_refresh: bool,
        epoch: u64,
    ) -> Result<Account, JobError> {
        let identity = self.verifier.verify(profile, &tokens.access_token).await?;
        if epoch != self.epoch.load(Ordering::Acquire) {
            return Err(error("cancelled", "登录或刷新已被退出取消"));
        }
        let previous = self
            .saved_account(library, &profile.source_id)
            .await?
            .map(|(_, _, subject)| subject);
        if allow_refresh {
            if let Some(refresh) = tokens.refresh_token.as_deref().or(old_refresh) {
                credentials::write(profile, &identity.subject, refresh)?;
            }
        } else {
            credentials::delete(profile, &identity.subject)?;
        }
        let stored=sqlx::query("INSERT INTO community_accounts(source_id,issuer,client_id,subject,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(source_id) DO UPDATE SET issuer=excluded.issuer,client_id=excluded.client_id,subject=excluded.subject,updated_at=excluded.updated_at")
            .bind(&profile.source_id).bind(&profile.auth.issuer).bind(&profile.auth.client_id).bind(&identity.subject).bind(now() as i64).execute(library.pool()).await;
        if let Err(e) = stored {
            credentials::delete(profile, &identity.subject)?;
            return Err(db(e));
        }
        if epoch != self.epoch.load(Ordering::Acquire) {
            credentials::delete(profile, &identity.subject)?;
            sqlx::query("DELETE FROM community_accounts WHERE source_id=?1 AND issuer=?2 AND client_id=?3 AND subject=?4").bind(&profile.source_id).bind(&profile.auth.issuer).bind(&profile.auth.client_id).bind(&identity.subject).execute(library.pool()).await.map_err(db)?;
            return Err(error("cancelled", "登录或刷新已取消"));
        }
        if let Some(previous) = previous.filter(|s| s != &identity.subject) {
            credentials::delete(profile, &previous)?;
        }
        let account = Account {
            source_id: profile.source_id.clone(),
            issuer: profile.auth.issuer.clone(),
            subject: identity.subject,
            expires_at: identity.expires,
        };
        let accepted = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if epoch != self.epoch.load(Ordering::Acquire) {
                false
            } else {
                sessions.insert(
                    profile.source_id.clone(),
                    Session {
                        account: account.clone(),
                        access: Zeroizing::new(tokens.access_token.clone()),
                    },
                );
                true
            }
        };
        if !accepted {
            credentials::delete(profile, &account.subject)?;
            sqlx::query("DELETE FROM community_accounts WHERE source_id=?1 AND issuer=?2 AND client_id=?3 AND subject=?4").bind(&profile.source_id).bind(&profile.auth.issuer).bind(&profile.auth.client_id).bind(&account.subject).execute(library.pool()).await.map_err(db)?;
            return Err(error("cancelled", "登录或刷新已取消"));
        }
        Ok(account)
    }

    pub(crate) async fn access(
        &self,
        library: &Library,
        source: &str,
    ) -> Result<Zeroizing<String>, JobError> {
        let _slot = self.operation.lock().await;
        if let Some(session) = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(source)
            .filter(|s| s.account.expires_at > now() + 60)
        {
            return Ok(session.access.clone());
        }
        let epoch = self.epoch.load(Ordering::Acquire);
        let profile = library.trust().profile(source).await?;
        let row = self.saved_account(library, source).await?;
        let (issuer, client, subject) =
            row.ok_or_else(|| error("login_required", "请登录此社区来源"))?;
        if issuer != profile.auth.issuer || client != profile.auth.client_id {
            return Err(error("login_required", "认证配置已变化，请重新登录"));
        }
        let refresh = credentials::read(&profile, &subject)?
            .ok_or_else(|| error("login_required", "没有可用刷新凭据，请重新登录"))?;
        let result = async {
            let discovery = jwt::discovery(&profile).await?;
            let tokens = self
                .tokens(
                    &discovery.token_endpoint,
                    &[
                        ("grant_type", "refresh_token"),
                        ("client_id", &client),
                        ("refresh_token", &refresh),
                    ],
                )
                .await?;
            let identity = self.verifier.verify(&profile, &tokens.access_token).await?;
            if identity.subject != subject {
                return Err(error("refresh_identity_changed", "刷新不能更换原账号主体"));
            }
            let access = Zeroizing::new(tokens.access_token.clone());
            self.accept(library, &profile, tokens, Some(&refresh), true, epoch)
                .await?;
            Ok(access)
        }
        .await;
        if result.is_err() {
            self.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(source);
            credentials::delete(&profile, &subject)?;
            return Err(error(
                "login_required",
                "凭据续期未完成，请在系统浏览器重新登录",
            ));
        }
        result
    }

    pub(crate) async fn logout(&self, library: &Library, source: &str) -> Result<(), JobError> {
        network::canonical_uuid(source)?;
        self.epoch.fetch_add(1, Ordering::AcqRel);
        self.cancel_login();
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(source);
        let _slot = self.operation.lock().await;
        let profile = library.trust().profile(source).await?;
        let subject = self
            .saved_account(library, source)
            .await?
            .map(|(_, _, subject)| subject);
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(source);
        if let Some(subject) = subject {
            credentials::delete(&profile, &subject)?;
        }
        sqlx::query("DELETE FROM community_accounts WHERE source_id=?1")
            .bind(source)
            .execute(library.pool())
            .await
            .map_err(db)?;
        Ok(())
    }

    pub(crate) async fn accounts(&self, library: &Library) -> Result<Vec<Account>, JobError> {
        let rows:Vec<(Option<String>,Option<String>,Option<String>)>=sqlx::query_as("SELECT CASE WHEN length(CAST(source_id AS BLOB))=36 THEN source_id ELSE NULL END,CASE WHEN length(CAST(issuer AS BLOB)) BETWEEN 1 AND 2048 THEN issuer ELSE NULL END,CASE WHEN length(CAST(subject AS BLOB)) BETWEEN 1 AND 255 THEN subject ELSE NULL END FROM community_accounts ORDER BY source_id LIMIT 17").fetch_all(library.pool()).await.map_err(db)?;
        if rows.len() > super::model::MAX_SOURCES {
            return Err(error("account_limit", "账号记录超出来源上限"));
        }
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        rows.into_iter()
            .map(|(id, issuer, subject)| {
                let id =
                    id.ok_or_else(|| error("account_database_invalid", "账号来源身份超出界限"))?;
                network::canonical_uuid(&id)?;
                let issuer = issuer
                    .ok_or_else(|| error("account_database_invalid", "账号 issuer 超出界限"))?;
                let subject =
                    subject.ok_or_else(|| error("account_database_invalid", "账号主体超出界限"))?;
                if subject.chars().any(char::is_control) {
                    return Err(error("account_database_invalid", "账号主体包含控制字符"));
                }
                let expires_at = sessions
                    .get(&id)
                    .filter(|s| s.account.issuer == issuer && s.account.subject == subject)
                    .map_or(0, |s| s.account.expires_at);
                Ok(Account {
                    source_id: id,
                    issuer,
                    subject,
                    expires_at,
                })
            })
            .collect()
    }
}

impl Drop for Auth {
    fn drop(&mut self) {
        self.stop();
    }
}
