// SPDX-License-Identifier: MIT
//! Background metadata uses the existing management worker. Downloads still
//! enter its original ImportJobs single slot; no second installer or timer thread.
use super::wallpaper_community::{Authority, Background, Outcome};
use super::*;
use crate::wallpaper::{
    api,
    community::{
        self,
        subscriptions::{Binding, Subscriptions},
    },
    playlist::FixedVersion,
};

impl App {
    fn community_automatic_held(&self) -> bool {
        self.feature_stops.wallpaper
            || self.wallpaper_apply.is_some()
            || self.wallpaper_community.preparing
            || self.wallpaper_community.settings_editing
            || self.save_due.is_some()
            || self.position_edit.is_some()
            || self.library_delete.is_some()
            || self.playlist_writes > 0
            || self.config.revision != self.committed_config.revision
    }

    pub(super) fn tick_community_background(&mut self) {
        self.wallpaper_community.author.expire();
        if self.community_automatic_held() {
            return;
        }
        if let Some(authority) = self
            .wallpaper_community
            .automatic
            .iter()
            .find(|a| a.policy == "startup" && !self.wallpaper_community.settings_editing)
            .cloned()
        {
            self.wallpaper_community
                .automatic
                .retain(|a| a.operation_id != authority.operation_id);
            match self.validate_community_authority(&authority) {
                Ok(()) => {
                    let request = api::Request {
                        protocol: 2,
                        request_id: uuid::Uuid::new_v4().to_string(),
                        command: "wallpaper.community.auto".into(),
                        expected_revision: Some(authority.binding.config_revision),
                        payload: serde_json::json!({"operationId":authority.operation_id,"at":"startup"}),
                    };
                    if let Err(e) = self.stage_community_apply(request, authority.clone(), false) {
                        if e.code == "budget_busy" {
                            self.wallpaper_community.automatic.push_back(authority);
                        } else {
                            self.stale_community_authority(&authority, &e.message);
                        }
                    }
                }
                Err(e) => self.stale_community_authority(&authority, &e.message),
            }
            return;
        }
        if !self.wallpaper_community.watching_download {
            if let Some((id, group)) = self.wallpaper_community.downloads.pop_front() {
                let request = api::Request {
                    protocol: 2,
                    request_id: uuid::Uuid::new_v4().to_string(),
                    command: "wallpaper.community.download".into(),
                    expected_revision: Some(self.committed_config.revision),
                    payload: serde_json::json!({"subscriptionId":id,"targetGroupId":group}),
                };
                if self.begin_community_download(&request, 0).is_err() {
                    self.wallpaper_community.watching_download = false;
                }
                return;
            }
        }
        if self.wallpaper_community.background
            || Instant::now() < self.wallpaper_community.next_sync
        {
            return;
        }
        if self.wallpaper_community.watching_download
            && self.wallpaper_library.community_job_active()
        {
            self.wallpaper_community.next_sync = Instant::now() + Duration::from_secs(2);
            return;
        }
        self.wallpaper_community.watching_download = false;
        let configuration = self.committed_config.clone();
        let startup = self.wallpaper_community.startup;
        let intent_epoch = self.wallpaper_community.intent_epoch;
        let groups: Vec<_> = configuration
            .wallpaper
            .groups
            .iter()
            .filter_map(|g| self.community_binding(&g.id, 0).ok())
            .collect();
        let request = api::Request {
            protocol: 2,
            request_id: uuid::Uuid::new_v4().to_string(),
            command: "wallpaper.community.background".into(),
            expected_revision: Some(configuration.revision),
            payload: serde_json::Value::Null,
        };
        let dispatched=self.dispatch_community(request,0,move|jobs,auth|async move{
            let library=jobs.library();let subs=Subscriptions::new(library);
            library.trust().persist_observed_time(community::now()).await?;
            if startup{subs.reconcile(&configuration).await?;}
            let sources=library.trust().sources().await?;
            for source in &sources {
                if source.last_sync==0||community::now().saturating_sub(source.last_sync)>=6*3600||!source.revocations_fresh {
                    if let Ok((chain,rev))=community::network::safety(&source.profile).await {let _=library.trust().accept(&source.profile.source_id,&chain,&rev,None).await;}
                }
            }
            let subscriptions=subs.list().await?;let mut pending=Vec::new();let mut automatic=Vec::new();
            for sub in &subscriptions {
                if sub.enabled!=1{continue;}
                let selected=groups.iter().find(|g|g.previous.as_ref().is_some_and(|p|Some(p.work_key.as_str())==sub.work_key.as_deref()));
                let target=selected.or_else(||groups.first());
                let Some(target)=target else{continue;};
                let profile=library.trust().profile(&sub.source_id).await?;
                if let Ok(bytes)=community::network::latest(&profile,&sub.remote_work_id).await {
                    let envelope=hertz_wallpaper::release::SignedRelease::parse(&bytes).map_err(community::contract)?;
                    // Compare only to avoid unnecessary dispatch; every actual
                    // candidate still passes trust acceptance on the import worker.
                    let existing:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM community_updates WHERE subscription_id=?1 AND candidate_hash=?2)")
                        .bind(&sub.subscription_id).bind(&envelope.release.package_hash).fetch_one(library.pool()).await.map_err(|e|community::error("community_database",e.to_string()))?;
                    if !existing&&sub.current_hash.as_deref()!=Some(envelope.release.package_hash.as_str())&&pending.len()<1024{pending.push((sub.subscription_id.clone(),target.group_id.clone()));}
                }
            }
            for update in subs.recent().await? {
                if automatic.len()>=4{break;}
                if update.state!="ready"{continue;}
                let Some(sub)=subscriptions.iter().find(|s|s.subscription_id==update.subscription_id&&s.enabled==1&&s.policy!="prompt")else{continue;};
                if sub.policy=="startup"&&!startup{continue;}
                let binding:Binding=serde_json::from_str(&update.binding_json).map_err(|_|community::error("update_binding_invalid","更新意图无效"))?;
                let Some(group)=groups.iter().find(|g|g.group_id==binding.group_id&&g.config_revision==binding.config_revision&&g.config_digest==binding.config_digest&&g.topology_digest==binding.topology_digest&&g.selection_json==binding.selection_json)else{
                    subs.stale(&update.operation_id,"下载期间配置、显示组或选择已变化；候选保留，请查看差异并重新确认").await?;continue;
                };
                if binding.subscription_revision!=sub.revision||binding.previous.as_ref().is_none_or(|p|Some(p.work_key.as_str())!=sub.work_key.as_deref()){
                    subs.stale(&update.operation_id,"订阅策略或原固定版本已变化；候选保留，请重新选择显示组并确认").await?;continue;
                }
                let Some(hash)=update.candidate_hash.clone()else{continue;};let Some(work)=sub.work_key.clone()else{continue;};
                let package=jobs.assets().read_installed_manifest(&hash)?;let is_web=matches!(package.manifest.content,hertz_wallpaper::Content::Web{..});
                if library.trust().activation_check(&hash,is_web).is_err(){continue;}
                let selection:crate::wallpaper::config::Selection=serde_json::from_str(&group.selection_json).map_err(|_|community::error("update_binding_invalid","更新选择无效"))?;
                let playlist=match selection{crate::wallpaper::config::Selection::Playlist{playlist_id}=>Some(crate::wallpaper::playlist::Repository::new(library).get(&playlist_id).await?),_=>None};
                if sub.policy=="cutpoint"&&playlist.is_none(){subs.stale(&update.operation_id,"此显示组没有轮播切点；候选已安装，请显式应用或修改订阅策略").await?;continue;}
                if playlist.as_ref().is_some_and(|list|binding.playlist_revision!=Some(list.revision)){subs.stale(&update.operation_id,"原轮播版本已变化；候选保留，请重新查看差异").await?;continue;}
                if playlist.as_ref().is_some_and(|list|!list.items.iter().any(|item|Some(item)==binding.previous.as_ref())){subs.stale(&update.operation_id,"轮播已不包含下载时的固定版本；候选保留，请重新确认").await?;continue;}
                automatic.push(Authority{operation_id:update.operation_id,subscription_id:sub.subscription_id.clone(),subscription_revision:sub.revision,owner:0,binding,candidate:FixedVersion{work_key:work,package_hash:hash},rollback:false,automatic:true,is_web,playlist,policy:sub.policy.clone(),intent_epoch});
            }
            Ok(Outcome::Background(Background{status:super::wallpaper_community::status(library,&auth).await?,pending,automatic}))
        });
        if dispatched.is_ok() {
            self.wallpaper_community.background = true;
        } else {
            self.wallpaper_community.next_sync = Instant::now() + Duration::from_secs(5);
        }
    }

    pub(super) fn accept_community_background(&mut self, background: Background) {
        self.wallpaper_community.background = false;
        let held = self.community_automatic_held();
        let superseded = background
            .automatic
            .iter()
            .any(|a| a.intent_epoch != self.wallpaper_community.intent_epoch);
        if !held && !superseded {
            self.wallpaper_community.startup = false;
        }
        self.wallpaper_community.next_sync =
            Instant::now() + Duration::from_secs(if held || superseded { 2 } else { 6 * 3600 });
        if let Some(rows) = background.status["subscriptions"].as_array() {
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
        for entry in background.pending {
            if !self.wallpaper_community.downloads.contains(&entry) {
                self.wallpaper_community.downloads.push_back(entry);
            }
        }
        for authority in background.automatic {
            // Editing temporarily holds automatic application; it does not turn
            // an otherwise unchanged committed binding into a durable failure.
            if held || authority.intent_epoch != self.wallpaper_community.intent_epoch {
                continue;
            }
            match self.validate_community_authority(&authority) {
                Ok(()) => {
                    if !self
                        .wallpaper_community
                        .automatic
                        .iter()
                        .any(|a| a.operation_id == authority.operation_id)
                    {
                        self.wallpaper_community.automatic.push_back(authority);
                    }
                }
                Err(e) => self.stale_community_authority(&authority, &e.message),
            }
        }
        if let Some(settings) = self.settings.as_ref() {
            settings.eval(&format!("window.hertzWallpaperCommunity && window.hertzWallpaperCommunity.acceptStatus({});",background.status));
        }
    }

    pub(super) fn try_community_cutpoint(&mut self, reference: &FixedVersion) -> bool {
        let group = self.desktop.configuration.main().id.clone();
        self.try_community_group_cutpoint(&group, reference)
    }

    pub(super) fn try_community_group_cutpoint(
        &mut self,
        group: &str,
        reference: &FixedVersion,
    ) -> bool {
        if self.community_automatic_held() {
            return false;
        }
        let authority = self
            .wallpaper_community
            .automatic
            .iter()
            .find(|a| {
                a.policy == "cutpoint"
                    && a.binding.group_id == group
                    && a.binding.previous.as_ref() == Some(reference)
            })
            .cloned();
        let Some(authority) = authority else {
            return false;
        };
        self.wallpaper_community
            .automatic
            .retain(|a| a.operation_id != authority.operation_id);
        if let Err(e) = self.validate_community_authority(&authority) {
            self.stale_community_authority(&authority, &e.message);
            return false;
        }
        let request = api::Request {
            protocol: 2,
            request_id: uuid::Uuid::new_v4().to_string(),
            command: "wallpaper.community.auto".into(),
            expected_revision: Some(authority.binding.config_revision),
            payload: serde_json::json!({"operationId":authority.operation_id,"at":"cutpoint"}),
        };
        match self.stage_community_apply(request, authority.clone(), false) {
            Ok(()) => true,
            Err(e) => {
                if e.code == "budget_busy" {
                    self.wallpaper_community.automatic.push_back(authority);
                } else {
                    self.stale_community_authority(&authority, &e.message);
                }
                false
            }
        }
    }
}
