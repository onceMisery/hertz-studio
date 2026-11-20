// SPDX-License-Identifier: MIT
//! Installed updates enter the existing Config CAS and preparation transaction.
use super::wallpaper_community::{field, Authority, Outcome, Review};
use super::*;
use crate::wallpaper::{
    api,
    community::{
        self,
        subscriptions::{ApplyIdentity, ApplyPlan, DownloadIntent, DownloadPlan, Subscriptions},
    },
    jobs::ImportIdentity,
};
type CommunityResult<T> = std::result::Result<T, crate::wallpaper::jobs::JobError>;

impl App {
    pub(super) fn begin_community_download(
        &mut self,
        request: &api::Request,
        owner: u64,
    ) -> CommunityResult<()> {
        if request.expected_revision != Some(self.committed_config.revision) {
            return Err(community::error(
                "config_conflict",
                "下载应用意图需要当前配置 revision",
            ));
        }
        let id = field(&request.payload, "subscriptionId")?;
        let group = field(&request.payload, "targetGroupId")?;
        let mut binding = self.community_binding(&group, 0)?;
        let request_copy = request.clone();
        self.wallpaper_community.watching_download = true;
        self.wallpaper_community.next_sync = Instant::now() + Duration::from_secs(2);
        self.dispatch_community(request.clone(),owner,move|jobs,_|async move{
            let subscriptions=Subscriptions::new(jobs.library());let sub=subscriptions.get(&id).await?;binding.subscription_revision=sub.revision;
            let plan=DownloadPlan{operation_id:request_copy.request_id.clone(),request_id:request_copy.request_id.clone(),subscription_id:id,source_id:sub.source_id,remote_work_id:sub.remote_work_id,binding};
            let job=format!("community-{}",plan.operation_id);let digest=request_copy.digest();let row=subscriptions.register(&plan,&job,&digest).await?;
            if row.state!="queued"{return Ok(Outcome::Value(serde_json::to_value(row).map_err(|_|community::error("community_encoding","更新状态编码失败"))?));}
            let intent=DownloadIntent::new(plan)?;
            let accepted=jobs.submit_community(job,intent,ImportIdentity{request_id:request_copy.request_id,payload_digest:digest}).await;
            match accepted{Ok(job)=>Ok(Outcome::Value(serde_json::json!({"operationId":row.operation_id,"jobId":&*job,"state":"queued"}))),Err(e)=>{subscriptions.fail(&row.operation_id,&e.message).await?;Err(e)}}
        })
    }

    pub(super) fn begin_community_review(
        &mut self,
        request: &api::Request,
        owner: u64,
    ) -> CommunityResult<()> {
        if request.expected_revision != Some(self.committed_config.revision) {
            return Err(community::error(
                "config_conflict",
                "版本确认需要当前配置 revision",
            ));
        }
        let id = field(&request.payload, "operationId")?;
        let group = field(&request.payload, "targetGroupId")?;
        let rollback = request.payload["rollback"].as_bool().unwrap_or(false);
        let mut binding = self.community_binding(&group, 0)?;
        let intent_epoch = self.wallpaper_community.intent_epoch;
        self.dispatch_community(request.clone(),owner,move|jobs,_|async move{
            let subs=Subscriptions::new(jobs.library());let update=subs.update(&id).await?;let subscription=subs.get(&update.subscription_id).await?;
            binding.subscription_revision=subscription.revision;
            let candidate=update.target_version(&subscription,rollback)?;
            if !jobs.library().contains_version(&candidate.work_key,&candidate.package_hash).await?{return Err(community::error("version_unavailable","版本不可用或已被安全撤销"));}
            let package=jobs.assets().read_installed_manifest(&candidate.package_hash)?;
            let is_web=matches!(package.manifest.content,hertz_wallpaper::Content::Web{..});jobs.library().trust().activation_check(&candidate.package_hash,is_web)?;
            let selection:crate::wallpaper::config::Selection=serde_json::from_str(&binding.selection_json).map_err(|_|community::error("update_binding_invalid","当前选择无效"))?;
            let playlist=match selection{
                crate::wallpaper::config::Selection::Playlist{playlist_id}=>Some(crate::wallpaper::playlist::Repository::new(jobs.library()).get(&playlist_id).await?),
                _=>None,
            };
            if let Some(list)=&playlist{
                binding.playlist_revision=Some(list.revision);
                if binding.previous.is_none(){binding.previous=list.items.iter().find(|item|Some(item.work_key.as_str())==subscription.work_key.as_deref()).cloned();}
            }
            let work=jobs.library().get_work(&candidate.work_key).await?.ok_or_else(||community::error("work_not_found","版本作品不存在"))?;
            let receipt=if work.source_id!=crate::wallpaper::library::LOCAL_SOURCE{let receipt=jobs.library().trust().installed_receipt(&work.source_id,&candidate.package_hash).await?;receipt.validate_package(&package,jobs.assets().installed_bytes(&candidate.package_hash)?)?;Some(receipt)}else{None};
            let profile=if receipt.is_some(){Some(jobs.library().trust().profile(&work.source_id).await?)}else{None};
            let difference=subs.difference(&binding,&package,receipt.as_ref()).await?;
            let display=serde_json::json!({"operationId":id,"rollback":rollback,"title":package.manifest.title,"version":package.manifest.version,"packageHash":candidate.package_hash,"sourceOrigin":profile.as_ref().map(|p|p.origin.as_str()).unwrap_or("本机文件"),"rootFingerprint":profile.as_ref().map(|p|p.root_fingerprint.as_str()),
                "permissions":package.manifest.permissions,"kind":crate::wallpaper::jobs::manifest_kind(&package.manifest),"delta":difference,"attribution":package.manifest.license.attribution,"license":package.manifest.license,"targetGroupId":binding.group_id,"expectedConfigRevision":binding.config_revision,"playlist":playlist.as_ref().map(|p|serde_json::json!({"title":p.title,"itemCount":p.items.len()}))});
            Ok(Outcome::Review(Box::new(Review{authority:Authority{operation_id:id,subscription_id:subscription.subscription_id,subscription_revision:subscription.revision,owner,binding,candidate,rollback,automatic:false,is_web,playlist,policy:"prompt".into(),intent_epoch},display})))
        })
    }

    pub(super) fn validate_community_authority(
        &self,
        authority: &Authority,
    ) -> CommunityResult<()> {
        if authority.intent_epoch != self.wallpaper_community.intent_epoch
            || authority.automatic && self.wallpaper_community.settings_editing
        {
            return Err(community::error(
                "update_intent_stale",
                "设置选择或草稿已变化，请重新核对确切版本",
            ));
        }
        if !authority.automatic
            && (authority.owner == 0
                || authority.owner != self.settings_generation
                || self.settings.is_none())
        {
            return Err(community::error(
                "settings_session_required",
                "版本确认所属设置会话已结束",
            ));
        }
        if self.feature_stops.wallpaper && authority.automatic {
            return Err(community::error(
                "wallpaper_stopped",
                "壁纸已由用户停止，旧自动意图不能重启",
            ));
        }
        let current =
            self.community_binding(&authority.binding.group_id, authority.subscription_revision)?;
        if current.config_revision != authority.binding.config_revision
            || current.config_digest != authority.binding.config_digest
            || current.topology_digest != authority.binding.topology_digest
            || current.selection_json != authority.binding.selection_json
            || current
                .playlist_revision
                .is_some_and(|r| Some(r) != authority.binding.playlist_revision)
            || self
                .wallpaper_community
                .subscriptions
                .get(&authority.subscription_id)
                .is_some_and(|r| *r != authority.subscription_revision)
        {
            return Err(community::error(
                "update_intent_stale",
                "下载或确认期间选择、显示组或配置已变化；候选仍保留在库中",
            ));
        }
        self.wallpaper_library
            .security_check(&authority.candidate.package_hash)?;
        self.wallpaper_library
            .activation_check(&authority.candidate.package_hash, authority.is_web)?;
        if authority.automatic
            && authority.policy == "cutpoint"
            && current.previous != authority.binding.previous
        {
            return Err(community::error(
                "update_intent_stale",
                "轮播当前固定版本已变化",
            ));
        }
        Ok(())
    }

    pub(super) fn stale_community_authority(&mut self, authority: &Authority, reason: &str) {
        let id = authority.operation_id.clone();
        let reason = reason.to_owned();
        self.wallpaper_community.next_sync = Instant::now();
        let _ = self
            .wallpaper_library
            .external_request(move |jobs| async move {
                if let Ok(jobs) = jobs {
                    if let Err(e) = Subscriptions::new(jobs.library()).stale(&id, &reason).await {
                        log(&format!("community stale intent: {}", e.code));
                    }
                }
            });
    }

    pub(super) fn stage_community_apply(
        &mut self,
        request: api::Request,
        mut authority: Authority,
        confirmed: bool,
    ) -> CommunityResult<()> {
        if self.wallpaper_community.preparing || self.wallpaper_apply.is_some() {
            return Err(community::error("budget_busy", "已有版本正在准备或应用"));
        }
        self.validate_community_authority(&authority)?;
        if request.expected_revision != Some(authority.binding.config_revision) {
            return Err(community::error(
                "config_conflict",
                "应用需要本次确认的配置 revision",
            ));
        }
        let request_copy = request.clone();
        let owner = authority.owner;
        self.dispatch_community(request, owner, move |jobs, _| async move {
            let subs = Subscriptions::new(jobs.library());
            let sub = subs.get(&authority.subscription_id).await?;
            if sub.revision != authority.subscription_revision
                || sub.enabled != 1 && authority.automatic
            {
                return Err(community::error("subscription_conflict", "订阅授权已变化"));
            }
            let update = subs.update(&authority.operation_id).await?;
            if !confirmed && update.state != "ready" {
                return Err(community::error(
                    "confirmation_required",
                    "更新需要在原生设置中确认",
                ));
            }
            let _writer = jobs.assets().content_writer()?;
            jobs.library()
                .trust()
                .activation_check(&authority.candidate.package_hash, authority.is_web)?;
            if !jobs
                .library()
                .contains_version(
                    &authority.candidate.work_key,
                    &authority.candidate.package_hash,
                )
                .await?
            {
                return Err(community::error("version_unavailable", "候选版本不可用"));
            }
            if let Some(list) = authority.playlist.take() {
                let current = crate::wallpaper::playlist::Repository::new(jobs.library())
                    .get(&list.playlist_id)
                    .await?;
                if current.revision != list.revision
                    || authority.binding.playlist_revision != Some(list.revision)
                {
                    subs.stale(
                        &authority.operation_id,
                        "原轮播已变化；候选保留，请重新查看差异",
                    )
                    .await?;
                    return Err(community::error(
                        "playlist_conflict",
                        "准备期间原轮播已变化，请重新确认",
                    ));
                }
                let mut items = list.items.clone();
                let old = authority.binding.previous.as_ref().ok_or_else(|| {
                    community::error("update_intent_stale", "轮播更新缺少原固定版本")
                })?;
                let mut replaced = false;
                for item in &mut items {
                    if item == old {
                        *item = authority.candidate.clone();
                        replaced = true;
                    }
                }
                if !replaced {
                    return Err(community::error("playlist_conflict", "轮播已不包含原版本"));
                }
                // A new candidate list is selected by the original Config CAS.
                // Mutating the currently selected list here would apply bytes
                // even when that later Config commit failed.
                let saved = crate::wallpaper::playlist::Repository::new(jobs.library())
                    .save(
                        None,
                        None,
                        list.title,
                        list.mode,
                        list.interval_seconds,
                        items,
                    )
                    .await?;
                authority.playlist = Some(saved);
            }
            let digest = request_copy.digest();
            let revision = authority
                .binding
                .config_revision
                .checked_add(1)
                .ok_or_else(|| community::error("config_conflict", "配置 revision 已到上限"))?;
            subs.stage_apply(ApplyPlan {
                identity: ApplyIdentity {
                    operation_id: &authority.operation_id,
                    request_id: &request_copy.request_id,
                    revision,
                    config_digest: &digest,
                },
                subscription_id: &authority.subscription_id,
                binding: &authority.binding,
                candidate: &authority.candidate,
                rollback: authority.rollback,
                confirmed,
                automatic: authority.automatic,
            })
            .await?;
            Ok(Outcome::Apply(Box::new(authority)))
        })?;
        self.wallpaper_community.preparing = true;
        Ok(())
    }

    pub(super) fn start_community_apply(
        &mut self,
        request: api::Request,
        authority: Authority,
    ) -> CommunityResult<()> {
        self.validate_community_authority(&authority)?;
        let mut draft = crate::wallpaper::settings_drafts::Draft::from_committed(
            authority.owner,
            &self.committed_config,
        );
        let group = draft
            .wallpaper
            .groups
            .iter_mut()
            .find(|g| g.id == authority.binding.group_id)
            .ok_or_else(|| community::error("target_required", "显示组已不存在"))?;
        group.selection = match authority.playlist.as_ref() {
            Some(list) => crate::wallpaper::config::Selection::Playlist {
                playlist_id: list.playlist_id.clone(),
            },
            None => authority.candidate.selection(),
        };
        group.properties.clear();
        let slot = self.wallpaper_library.reserve()?;
        self.begin_wallpaper_apply_snapshot(
            request,
            authority.owner,
            draft,
            ApiReply::Settings(authority.owner),
            slot,
            None,
        )?;
        let transaction = self
            .wallpaper_apply
            .as_mut()
            .expect("original apply transaction");
        transaction.bind_community(authority);
        Ok(())
    }

    pub(super) fn request_community_recheck(&self, authority: Authority) -> CommunityResult<()> {
        let request = api::Request {
            protocol: 2,
            request_id: authority.operation_id.clone(),
            command: "wallpaper.community.recheck".into(),
            expected_revision: Some(authority.binding.config_revision),
            payload: serde_json::Value::Null,
        };
        let owner = authority.owner;
        self.dispatch_community(request, owner, move |jobs, _| async move {
            let sub = Subscriptions::new(jobs.library())
                .get(&authority.subscription_id)
                .await?;
            if sub.revision != authority.subscription_revision
                || authority.automatic && sub.enabled != 1
            {
                return Err(community::error(
                    "subscription_conflict",
                    "应用前订阅状态已变化",
                ));
            }
            let selection: crate::wallpaper::config::Selection =
                serde_json::from_str(&authority.binding.selection_json)
                    .map_err(|_| community::error("update_binding_invalid", "原选择无效"))?;
            if let crate::wallpaper::config::Selection::Playlist { playlist_id } = selection {
                let current = crate::wallpaper::playlist::Repository::new(jobs.library())
                    .get(&playlist_id)
                    .await?;
                if authority.binding.playlist_revision != Some(current.revision) {
                    return Err(community::error(
                        "playlist_conflict",
                        "提交前原轮播已变化，请重新确认",
                    ));
                }
            }
            jobs.library()
                .trust()
                .activation_check(&authority.candidate.package_hash, authority.is_web)?;
            if !jobs
                .library()
                .contains_version(
                    &authority.candidate.work_key,
                    &authority.candidate.package_hash,
                )
                .await?
            {
                return Err(community::error(
                    "version_unavailable",
                    "应用前版本已不可用",
                ));
            }
            Ok(Outcome::Checked(authority.operation_id))
        })
    }

    pub(super) fn finish_community_recheck(&mut self, id: &str, result: CommunityResult<()>) {
        if let Some(transaction) = self
            .wallpaper_apply
            .as_mut()
            .filter(|t| t.community.as_ref().is_some_and(|a| a.operation_id == id))
        {
            transaction.community_rechecking = false;
            transaction.community_rechecked = result.is_ok();
            if result.is_err() {
                transaction.cancel_for_feature_exit();
            }
        }
    }

    pub(super) fn finish_community_receipt(
        &self,
        authority: &Authority,
        _saved: bool,
        failure: Option<String>,
        request: &api::Request,
    ) {
        let id = authority.operation_id.clone();
        let revision = authority.binding.config_revision + 1;
        let request = request.clone();
        let _ = self
            .wallpaper_library
            .external_request(move |jobs| async move {
                if let Ok(jobs) = jobs {
                    let proof = config::operation_at(jobs.library().root(), &request.request_id);
                    let committed = match proof {
                        Ok(Some(op))
                            if op.payload_digest == request.digest()
                                && op.command == request.command
                                && op.state == crate::config_journal::State::Committed
                                && op.config_revision == Some(revision) =>
                        {
                            true
                        }
                        Ok(Some(op))
                            if op.payload_digest == request.digest()
                                && op.command == request.command
                                && op.state == crate::config_journal::State::NotCommitted =>
                        {
                            false
                        }
                        _ => return,
                    };
                    let digest = request.digest();
                    let result = Subscriptions::new(jobs.library())
                        .finish_apply(
                            ApplyIdentity {
                                operation_id: &id,
                                request_id: &request.request_id,
                                config_digest: &digest,
                                revision,
                            },
                            committed,
                            failure,
                        )
                        .await;
                    if let Err(e) = result {
                        log(&format!("community update receipt: {}", e.code));
                    }
                }
            });
    }

    pub(super) fn abort_community_receipt(
        &self,
        authority: &Authority,
        reason: String,
        request: &api::Request,
    ) {
        let id = authority.operation_id.clone();
        let revision = authority.binding.config_revision + 1;
        let request = request.clone();
        let _ = self
            .wallpaper_library
            .external_request(move |jobs| async move {
                if let Ok(jobs) = jobs {
                    // The original GUI owner knows Config was never dispatched.
                    // Confirm that the original journal has no such operation before
                    // exposing this as a terminal preparation failure.
                    if matches!(
                        config::operation_at(jobs.library().root(), &request.request_id),
                        Ok(None)
                    ) {
                        let digest = request.digest();
                        if let Err(e) = Subscriptions::new(jobs.library())
                            .finish_apply(
                                ApplyIdentity {
                                    operation_id: &id,
                                    request_id: &request.request_id,
                                    config_digest: &digest,
                                    revision,
                                },
                                false,
                                Some(reason),
                            )
                            .await
                        {
                            log(&format!("community preparation receipt: {}", e.code));
                        }
                    }
                }
            });
    }
}
