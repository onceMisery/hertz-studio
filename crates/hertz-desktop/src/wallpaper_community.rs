// SPDX-License-Identifier: MIT
//! Trusted native settings bridge. A page supplies choices, never pins, tokens,
//! approval witnesses or a claimed settings identity.
use super::*;
use crate::wallpaper::{
    api,
    community::{
        self, auth,
        model::SourceProfile,
        subscriptions::{Binding, Subscriptions},
    },
    jobs::{ImportJobs, JobError},
};
use std::collections::{BTreeMap, VecDeque};
type CommunityResult<T> = std::result::Result<T, JobError>;

pub(super) struct RootDraft {
    pub profile: SourceProfile,
    pub chain: Vec<u8>,
    pub _charge: crate::wallpaper::budget::ControlCharge,
}
struct RootTicket {
    owner: u64,
    nonce: String,
    created: Instant,
    draft: Box<RootDraft>,
}
pub(super) struct Review {
    pub authority: Authority,
    pub display: serde_json::Value,
}
struct ApplyTicket {
    owner: u64,
    nonce: String,
    created: Instant,
    review: Box<Review>,
}

#[derive(Clone)]
pub(super) struct Authority {
    pub operation_id: String,
    pub subscription_id: String,
    pub subscription_revision: i64,
    pub owner: u64,
    pub binding: Binding,
    pub candidate: crate::wallpaper::playlist::FixedVersion,
    pub rollback: bool,
    pub automatic: bool,
    pub is_web: bool,
    pub policy: String,
    pub intent_epoch: u64,
    pub playlist: Option<crate::wallpaper::playlist::Playlist>,
}

pub(super) enum Outcome {
    Value(serde_json::Value),
    Root(Box<RootDraft>),
    Review(Box<Review>),
    AuthorPrepared(Arc<community::author::PackageDraft>),
    ReportPrepared(Box<community::author::ReportDraft>),
    Apply(Authority),
    Browser(String),
    Login(auth::Account),
    Background(Background),
    Checked(String),
}
pub(crate) struct CommunityEvent {
    pub result: CommunityResult<Outcome>,
    pub _charge: crate::wallpaper::budget::ControlCharge,
}
pub(super) struct Background {
    pub status: serde_json::Value,
    pub pending: Vec<(String, String)>,
    pub automatic: Vec<Authority>,
}

pub(super) struct CommunityState {
    pub auth: Arc<auth::Auth>,
    pub author: super::wallpaper_community_author::State,
    root: Option<RootTicket>,
    review: Option<ApplyTicket>,
    pub subscriptions: BTreeMap<String, i64>,
    pub security_revision: u64,
    pub security_due: u64,
    pub security_unavailable: bool,
    pub next_sync: Instant,
    pub background: bool,
    pub startup: bool,
    pub downloads: VecDeque<(String, String)>,
    pub automatic: VecDeque<Authority>,
    pub watching_download: bool,
    pub preparing: bool,
    pub intent_epoch: u64,
    pub settings_editing: bool,
    _charge: crate::wallpaper::budget::ControlCharge,
}

impl CommunityState {
    pub(super) fn new() -> Self {
        let charge = crate::wallpaper::budget::global()
            .admit_working_bytes(4 * 1024 * 1024)
            .expect("native community control admission");
        Self {
            auth: auth::Auth::new().expect("native community authentication admission"),
            author: super::wallpaper_community_author::State::default(),
            root: None,
            review: None,
            subscriptions: BTreeMap::new(),
            security_revision: 0,
            security_due: u64::MAX,
            security_unavailable: false,
            next_sync: Instant::now(),
            background: false,
            startup: true,
            downloads: VecDeque::new(),
            automatic: VecDeque::new(),
            watching_download: false,
            preparing: false,
            intent_epoch: 0,
            settings_editing: false,
            _charge: charge,
        }
    }
    pub(super) fn close_owner(&mut self) {
        self.author.clear();
        self.root = None;
        self.review = None;
        self.settings_editing = false;
        self.auth.cancel_login();
    }
}

impl Drop for CommunityState {
    fn drop(&mut self) {
        self.auth.stop();
    }
}

pub(super) fn field(value: &serde_json::Value, name: &str) -> CommunityResult<String> {
    let text = value[name]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 2048)
        .ok_or_else(|| community::error("invalid_input", format!("缺少有界字段 {name}")))?;
    Ok(text.to_owned())
}

fn request(value: serde_json::Value) -> CommunityResult<api::Request> {
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| community::error("invalid_request", "社区请求编码无效"))?;
    if bytes.len() > 16384 {
        return Err(community::error("request_limit", "社区管理请求超过 16 KiB"));
    }
    let request: api::Request = serde_json::from_value(value)
        .map_err(|_| community::error("invalid_request", "社区管理信封无效"))?;
    community::network::canonical_uuid(&request.request_id)?;
    if request.protocol != 2 || !request.command.starts_with("wallpaper.community.") {
        return Err(community::error(
            "unsupported_protocol",
            "社区需要正式 management v2",
        ));
    }
    Ok(request)
}

impl App {
    pub(super) fn community_binding(
        &self,
        group: &str,
        subscription_revision: i64,
    ) -> CommunityResult<Binding> {
        if self.save_due.is_some()
            || self.position_edit.is_some()
            || self.library_delete.is_some()
            || self.playlist_writes > 0
            || self.config.revision != self.committed_config.revision
        {
            return Err(community::error(
                "config_conflict",
                "请先完成当前设置保存、删除或轮播事务",
            ));
        }
        let selected = self
            .committed_config
            .wallpaper
            .groups
            .iter()
            .find(|g| g.id == group)
            .ok_or_else(|| community::error("target_required", "请先选择一个已保存显示组"))?;
        let plan = crate::wallpaper::display::DisplayTopology::default().reconcile(
            &self.committed_config.wallpaper.groups,
            &native::wallpaper_monitors(),
            Instant::now(),
        )?;
        if plan.diagnostics.iter().any(|d| d.group_id == group) {
            return Err(community::error(
                "target_unavailable",
                "显示组成员缺失、重叠或身份不明确",
            ));
        }
        let runner = self
            .desktop
            .runtimes
            .values()
            .filter(|r| r.configuration.main().id == group)
            .find_map(|r| r.playlist.as_ref());
        let mirror = self.desktop.mirrors.get(group);
        let previous = match &selected.selection {
            crate::wallpaper::config::Selection::Package {
                work_key,
                package_hash,
            } => Some(crate::wallpaper::playlist::FixedVersion {
                work_key: work_key.clone(),
                package_hash: package_hash.clone(),
            }),
            crate::wallpaper::config::Selection::Playlist { .. } => runner
                .and_then(|p| p.current())
                .or_else(|| mirror.and_then(|g| g.playback.current()))
                .cloned(),
            _ => None,
        };
        let playlist_revision = match &selected.selection {
            crate::wallpaper::config::Selection::Playlist { playlist_id } => runner
                .map(|p| p.playlist())
                .or_else(|| mirror.and_then(|g| g.playback.playlist()))
                .filter(|p| &p.playlist_id == playlist_id)
                .map(|p| p.revision),
            _ => None,
        };
        Ok(Binding {
            config_revision: self.committed_config.revision,
            config_digest: crate::wallpaper::ai::digest(
                &serde_json::json!({"wallpaper":self.committed_config.wallpaper,"profile":self.committed_config.active_profile}),
            ),
            topology_digest: crate::config_journal::digest(
                format!("{:?}", native::wallpaper_monitors()).as_bytes(),
            ),
            group_id: group.to_owned(),
            selection_json: serde_json::to_string(&selected.selection)
                .map_err(|_| community::error("config_encoding", "选择编码失败"))?,
            previous,
            subscription_revision,
            playlist_revision,
        })
    }

    pub(super) fn dispatch_community<F, Fut>(
        &self,
        request: api::Request,
        owner: u64,
        operation: F,
    ) -> CommunityResult<()>
    where
        F: FnOnce(Arc<ImportJobs>, Arc<auth::Auth>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = CommunityResult<Outcome>> + Send + 'static,
    {
        let charge = crate::wallpaper::budget::global()
            .admit_working_bytes(16 * 1024 * 1024)
            .map_err(|e| community::error("budget_busy", e.message.to_string()))?;
        let proxy = self.proxy.clone();
        let auth = Arc::clone(&self.wallpaper_community.auth);
        self.wallpaper_library
            .external_request(move |jobs| async move {
                let outcome = match jobs {
                    Ok(jobs) => operation(jobs, auth).await,
                    Err(e) => Err(e),
                };
                let _ = proxy.send_event(UserEvent::WallpaperCommunity(
                    owner,
                    request,
                    Box::new(CommunityEvent {
                        result: outcome,
                        _charge: charge,
                    }),
                ));
            })
    }

    pub(super) fn handle_community_management(
        &mut self,
        value: serde_json::Value,
        reply: ApiReply,
        _target: &EventLoopWindowTarget<()>,
    ) {
        let owner = match reply {
            ApiReply::Settings(owner)
                if owner != 0 && owner == self.settings_generation && self.settings.is_some() =>
            {
                owner
            }
            _ => {
                self.send_wallpaper_management(
                    reply,
                    api::response(
                        value["requestId"].as_str(),
                        Err(community::error(
                            "settings_session_required",
                            "社区信任与更新只能由当前原生设置窗口操作",
                        )),
                        None,
                    ),
                );
                return;
            }
        };
        let request = match request(value) {
            Ok(r) => r,
            Err(e) => {
                self.send_wallpaper_management(
                    ApiReply::Settings(owner),
                    api::response(None, Err(e), None),
                );
                return;
            }
        };
        let result = self.begin_community_command(&request, owner);
        if let Err(e) = result {
            self.send_wallpaper_management(
                ApiReply::Settings(owner),
                api::response(Some(&request.request_id), Err(e), None),
            );
        }
    }

    fn begin_community_command(
        &mut self,
        request: &api::Request,
        owner: u64,
    ) -> CommunityResult<()> {
        let command = request.command.as_str();
        let payload = request.payload.clone();
        match command {
            "wallpaper.community.invalidate" => {
                self.wallpaper_community.intent_epoch =
                    self.wallpaper_community.intent_epoch.wrapping_add(1);
                self.wallpaper_community.settings_editing =
                    payload["editing"].as_bool().unwrap_or(true);
                self.wallpaper_community.review = None;
                self.wallpaper_community.automatic.clear();
                self.wallpaper_community.next_sync = Instant::now();
                self.send_wallpaper_management(
                    ApiReply::Settings(owner),
                    api::response(
                        Some(&request.request_id),
                        Ok(serde_json::json!({"invalidated":true})),
                        None,
                    ),
                );
                Ok(())
            }
            "wallpaper.community.status" => {
                self.dispatch_community(request.clone(), owner, |jobs, auth| async move {
                    Ok(Outcome::Value(status(jobs.library(), &auth).await?))
                })
            }
            "wallpaper.community.discover" => {
                let origin = field(&payload, "origin")?;
                self.dispatch_community(request.clone(), owner, move |_, _| async move {
                    let charge = crate::wallpaper::budget::global()
                        .admit_working_bytes(1024 * 1024)
                        .map_err(|e| community::error("budget_busy", e.message.to_string()))?;
                    let (profile, chain) = community::network::discover(&origin).await?;
                    Ok(Outcome::Root(Box::new(RootDraft {
                        profile,
                        chain,
                        _charge: charge,
                    })))
                })
            }
            "wallpaper.community.confirmRoot" => {
                let nonce = field(&payload, "ticket")?;
                let fingerprint = field(&payload, "fingerprint")?;
                let ticket =
                    self.wallpaper_community.root.take().ok_or_else(|| {
                        community::error("confirmation_expired", "根确认票据不存在")
                    })?;
                if ticket.owner != owner
                    || ticket.nonce != nonce
                    || ticket.created.elapsed() > Duration::from_secs(300)
                    || ticket.draft.profile.root_fingerprint != fingerprint
                {
                    return Err(community::error(
                        "confirmation_expired",
                        "根确认票据或完整指纹不匹配",
                    ));
                }
                self.dispatch_community(request.clone(), owner, move |jobs, _| async move {
                    let draft = ticket.draft;
                    jobs.library()
                        .trust()
                        .confirm_source(&draft.profile, &draft.chain, &fingerprint)
                        .await?;
                    Subscriptions::new(jobs.library())
                        .project_source(&draft.profile)
                        .await?;
                    Ok(Outcome::Value(
                        serde_json::json!({"sourceId":draft.profile.source_id,"trusted":true}),
                    ))
                })
            }
            "wallpaper.community.sync" => {
                let source = field(&payload, "sourceId")?;
                self.wallpaper_community.next_sync = Instant::now();
                self.dispatch_community(request.clone(), owner, move |jobs, auth| async move {
                    let profile = jobs.library().trust().profile(&source).await?;
                    let (chain, rev) = community::network::safety(&profile).await?;
                    jobs.library()
                        .trust()
                        .accept(&source, &chain, &rev, None)
                        .await?;
                    Ok(Outcome::Value(status(jobs.library(), &auth).await?))
                })
            }
            "wallpaper.community.login" => {
                self.wallpaper_community.author.clear();
                let source = field(&payload, "sourceId")?;
                let proxy = self.proxy.clone();
                let browser_request = request.clone();
                let allow_refresh = payload["allowRefresh"].as_bool().unwrap_or(false);
                let browser_charge = crate::wallpaper::budget::global()
                    .admit_working_bytes(65536)
                    .map_err(|e| community::error("budget_busy", e.message.to_string()))?;
                self.dispatch_community(request.clone(), owner, move |jobs, auth| async move {
                    let profile = jobs.library().trust().profile(&source).await?;
                    let account = auth
                        .login(jobs.library(), profile, allow_refresh, move |url| {
                            let _ = proxy.send_event(UserEvent::WallpaperCommunity(
                                owner,
                                browser_request,
                                Box::new(CommunityEvent {
                                    result: Ok(Outcome::Browser(url)),
                                    _charge: browser_charge,
                                }),
                            ));
                        })
                        .await?;
                    Ok(Outcome::Login(account))
                })
            }
            "wallpaper.community.cancelLogin" => {
                self.wallpaper_community.auth.cancel_login();
                self.dispatch_community(request.clone(), owner, |_, _| async move {
                    Ok(Outcome::Value(serde_json::json!({"loginCancelled":true})))
                })
            }
            "wallpaper.community.logout" => {
                self.wallpaper_community.author.clear();
                let source = field(&payload, "sourceId")?;
                self.dispatch_community(request.clone(), owner, move |jobs, auth| async move {
                    auth.logout(jobs.library(), &source).await?;
                    Ok(Outcome::Value(
                        serde_json::json!({"sourceId":source,"loggedOut":true}),
                    ))
                })
            }
            "wallpaper.community.me" => {
                let source = field(&payload, "sourceId")?;
                self.dispatch_community(request.clone(), owner, move |jobs, auth| async move {
                    let profile = jobs.library().trust().profile(&source).await?;
                    let token = auth.access(jobs.library(), &source).await?;
                    let bytes = community::network::authenticated_get(
                        &format!("{}/v1/me", profile.origin),
                        &token,
                        65536,
                    )
                    .await?;
                    Ok(Outcome::Value(serde_json::from_slice(&bytes).map_err(
                        |_| community::error("community_response", "社区账号响应无效"),
                    )?))
                })
            }
            "wallpaper.community.browse" => {
                let source = field(&payload, "sourceId")?;
                let offset = payload["offset"].as_u64().unwrap_or(0);
                if offset > 1000000 {
                    return Err(community::error("invalid_page", "社区分页超出界限"));
                }
                self.dispatch_community(request.clone(),owner,move|jobs,_|async move{let profile=jobs.library().trust().profile(&source).await?;let bytes=community::network::get(&format!("{}/v1/works?limit=30&offset={offset}",profile.origin),65536).await?;let items:Vec<serde_json::Value>=serde_json::from_slice(&bytes).map_err(|_|community::error("community_response","社区作品响应无效"))?;if items.len()>30{return Err(community::error("community_response_limit","社区作品分页超出界限"));}Ok(Outcome::Value(serde_json::json!({"nextOffset":if items.len()==30{Some(offset+30)}else{None},"offset":offset,"items":items})))})
            }
            "wallpaper.community.subscribe" => {
                let source = field(&payload, "sourceId")?;
                let work = field(&payload, "remoteWorkId")?;
                self.wallpaper_community.next_sync = Instant::now();
                self.dispatch_community(request.clone(), owner, move |jobs, _| async move {
                    let sub = Subscriptions::new(jobs.library())
                        .subscribe(&source, &work)
                        .await?;
                    Ok(Outcome::Value(serde_json::to_value(sub).map_err(|_| {
                        community::error("community_encoding", "订阅编码失败")
                    })?))
                })
            }
            "wallpaper.community.policy" => {
                let id = field(&payload, "subscriptionId")?;
                let revision = payload["subscriptionRevision"].as_i64().ok_or_else(|| {
                    community::error("subscription_conflict", "缺少订阅 revision")
                })?;
                let policy = field(&payload, "policy")?;
                let enabled = payload["enabled"]
                    .as_bool()
                    .ok_or_else(|| community::error("invalid_policy", "缺少订阅启用状态"))?;
                self.wallpaper_community
                    .subscriptions
                    .insert(id.clone(), -1);
                self.dispatch_community(request.clone(), owner, move |jobs, _| async move {
                    let sub = Subscriptions::new(jobs.library())
                        .policy(&id, revision, &policy, enabled)
                        .await?;
                    Ok(Outcome::Value(serde_json::to_value(sub).map_err(|_| {
                        community::error("community_encoding", "订阅编码失败")
                    })?))
                })
            }
            "wallpaper.community.download" => self.begin_community_download(request, owner),
            command
                if command.starts_with("wallpaper.community.author")
                    || command.starts_with("wallpaper.community.report") =>
            {
                self.handle_community_author(request.clone(), owner)
            }
            "wallpaper.community.review" => self.begin_community_review(request, owner),
            "wallpaper.community.apply" => {
                let nonce = field(&payload, "ticket")?;
                let ticket = self.wallpaper_community.review.take().ok_or_else(|| {
                    community::error("confirmation_expired", "应用确认票据不存在")
                })?;
                if ticket.owner != owner
                    || ticket.nonce != nonce
                    || ticket.created.elapsed() > Duration::from_secs(300)
                {
                    return Err(community::error(
                        "confirmation_expired",
                        "应用确认票据已过期",
                    ));
                }
                self.validate_community_authority(&ticket.review.authority)?;
                self.stage_community_apply(request.clone(), ticket.review.authority, true)
            }
            "wallpaper.community.update" => {
                let id = field(&payload, "operationId")?;
                self.dispatch_community(request.clone(), owner, move |jobs, _| async move {
                    let subs = Subscriptions::new(jobs.library());
                    subs.reconcile_apply().await?;
                    Ok(Outcome::Value(
                        serde_json::to_value(subs.update(&id).await?)
                            .map_err(|_| community::error("community_encoding", "更新编码失败"))?,
                    ))
                })
            }
            _ => Err(community::error("unknown_command", "社区命令不受支持")),
        }
    }

    pub(super) fn finish_community_event(
        &mut self,
        owner: u64,
        request: api::Request,
        event: CommunityEvent,
    ) {
        self.wallpaper_community.author.finish(&request.request_id);
        let result = event.result;
        let _charge = event._charge;
        if matches!(
            request.command.as_str(),
            "wallpaper.community.apply" | "wallpaper.community.auto"
        ) {
            self.wallpaper_community.preparing = false;
        }
        if owner > 0 && (owner != self.settings_generation || self.settings.is_none()) {
            if let Ok(Outcome::Apply(authority)) = result {
                self.abort_community_receipt(
                    &authority,
                    "settings_session_expired".into(),
                    &request,
                );
            }
            return;
        }
        let result = match result {
            Ok(Outcome::AuthorPrepared(draft)) => self.finish_author_prepare(owner, draft),
            Ok(Outcome::ReportPrepared(draft)) => self.finish_report_prepare(owner, draft),
            Ok(Outcome::Root(draft)) => {
                let nonce = crate::wallpaper::file_tokens::random_token();
                match nonce {
                    Ok(nonce) => {
                        let display = serde_json::json!({"confirmationRequired":true,"ticket":nonce,"profile":draft.profile,"fingerprint":draft.profile.root_fingerprint,"expiresInSeconds":300});
                        self.wallpaper_community.root = Some(RootTicket {
                            owner,
                            nonce,
                            created: Instant::now(),
                            draft,
                        });
                        Ok(display)
                    }
                    Err(e) => Err(e),
                }
            }
            Ok(Outcome::Review(review)) => {
                if let Err(e) = self.validate_community_authority(&review.authority) {
                    Err(e)
                } else {
                    let nonce = crate::wallpaper::file_tokens::random_token();
                    match nonce {
                        Ok(nonce) => {
                            let display = serde_json::json!({"confirmationRequired":true,"ticket":nonce,"review":review.display,"expiresInSeconds":300});
                            self.wallpaper_community.review = Some(ApplyTicket {
                                owner,
                                nonce,
                                created: Instant::now(),
                                review,
                            });
                            Ok(display)
                        }
                        Err(e) => Err(e),
                    }
                }
            }
            Ok(Outcome::Apply(authority)) => {
                if let Err(e) = self.start_community_apply(request.clone(), authority.clone()) {
                    self.abort_community_receipt(&authority, e.message.clone(), &request);
                    Err(e)
                } else {
                    return;
                }
            }
            Ok(Outcome::Browser(url)) => {
                if native::open_url(&url).is_err() {
                    self.wallpaper_community.auth.cancel_login();
                    Err(community::error(
                        "browser_unavailable",
                        "无法打开系统浏览器",
                    ))
                } else {
                    Ok(serde_json::json!({"loginPending":true,"expiresInSeconds":300}))
                }
            }
            Ok(Outcome::Login(account)) => {
                Ok(serde_json::json!({"account":account,"loggedIn":true}))
            }
            Ok(Outcome::Background(background)) => {
                self.accept_community_background(background);
                return;
            }
            Ok(Outcome::Checked(id)) => {
                self.finish_community_recheck(&id, Ok(()));
                return;
            }
            Ok(Outcome::Value(value)) => {
                if let (Some(id), Some(rev)) =
                    (value["subscriptionId"].as_str(), value["revision"].as_i64())
                {
                    self.wallpaper_community
                        .subscriptions
                        .insert(id.to_owned(), rev);
                }
                if let Some(rows) = value["subscriptions"].as_array() {
                    for row in rows {
                        if let (Some(id), Some(rev)) =
                            (row["subscriptionId"].as_str(), row["revision"].as_i64())
                        {
                            self.wallpaper_community
                                .subscriptions
                                .insert(id.to_owned(), rev);
                        }
                    }
                }
                Ok(value)
            }
            Err(e) => {
                if request.command == "wallpaper.community.background" {
                    self.wallpaper_community.background = false;
                    self.wallpaper_community.next_sync = Instant::now() + Duration::from_secs(300);
                    return;
                }
                if request.command == "wallpaper.community.recheck" {
                    self.finish_community_recheck(&request.request_id, Err(e));
                    return;
                }
                Err(e)
            }
        };
        self.send_wallpaper_management(
            ApiReply::Settings(owner),
            api::response(Some(&request.request_id), result, None),
        );
    }
}

pub(super) async fn status(
    library: &crate::wallpaper::library::Library,
    auth: &auth::Auth,
) -> CommunityResult<serde_json::Value> {
    let subs = Subscriptions::new(library);
    Ok(
        serde_json::json!({"sources":library.trust().sources().await?,"accounts":auth.accounts(library).await?,"subscriptions":subs.list().await?,"updates":subs.recent().await?,"authorWebEnabled":false}),
    )
}
