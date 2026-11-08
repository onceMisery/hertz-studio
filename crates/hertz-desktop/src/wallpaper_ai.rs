// SPDX-License-Identifier: MIT
//! Trusted settings events only; execution uses the original ApplyTransaction.
use super::*;
use crate::wallpaper::{ai, api, jobs::JobError};
type AiResult<T> = std::result::Result<T, JobError>;

impl App {
    pub(super) fn ai_context(&self, owner: u64) -> AiResult<ai::CatalogContext> {
        if self.settings.is_none() || owner == 0 || owner != self.settings_generation {
            return Err(JobError::new(
                "settings_session_required",
                "请在当前原生设置窗口操作",
            ));
        }
        if self.position_edit.is_some()
            || self.save_due.is_some()
            || self.library_delete.is_some()
            || self.playlist_writes > 0
            || self.config.revision != self.committed_config.revision
            || self.config.active_profile != self.committed_config.active_profile
        {
            return Err(JobError::new(
                "conflict",
                "请等待当前原生设置、删除或轮播事务完成",
            ));
        }
        let group = self
            .wallpaper_ai
            .selected_group()
            .ok_or_else(|| JobError::new("target_required", "请先选择一个已保存显示组"))?;
        let plan = crate::wallpaper::display::DisplayTopology::default().reconcile(
            &self.committed_config.wallpaper.groups,
            &native::wallpaper_monitors(),
            Instant::now(),
        )?;
        if plan.diagnostics.iter().any(|entry| entry.group_id == group) {
            return Err(JobError::new(
                "target_unavailable",
                "当前显示组的成员缺失、重叠或身份不明确",
            ));
        }
        let targets: Vec<_> = plan
            .targets
            .into_iter()
            .filter(|entry| entry.group_id == group)
            .collect();
        let principal = crate::config_journal::caller_sid()
            .map_err(|error| JobError::new("identity_unavailable", error.to_string()))?;
        let mut binding =
            self.wallpaper_ai
                .binding(owner, principal, &self.committed_config, &targets)?;
        // Automatic playlist transitions do not change Config revision. Bind
        // their original runner facts so a late recommendation cannot override
        // a newer current/pending fixed version under the same Playlist intent.
        let playlists:Vec<_>=self.desktop.runtimes.values().filter(|runtime| runtime.configuration.main().id==group)
            .filter_map(|runtime|runtime.playlist.as_ref().map(|runner|serde_json::json!({
                "epoch":runtime.playlist_epoch,"revision":runner.playlist().revision,"current":runner.current(),
                "pending":runner.pending().map(|pending|serde_json::json!({"token":pending.token,"reference":pending.reference}))}))).collect();
        let mirror=self.desktop.mirrors.get(group).filter(|group|group.playback.playlist().is_some()).map(|group|serde_json::json!({
            "current":group.playback.current(),"transition":group.playback.switch().map(|pending|serde_json::json!({"token":pending.token,"reference":pending.reference}))}));
        binding.context_digest = ai::digest(
            &serde_json::json!({"configuration":binding.context_digest,"playlists":playlists,"mirror":mirror}),
        );
        let replaced_generations = self
            .desktop
            .runtimes
            .values()
            .filter(|runtime| runtime.configuration.main().id == group)
            .filter_map(|runtime| {
                runtime
                    .surface
                    .as_ref()
                    .map(|surface| surface.session.generation())
            })
            .collect();
        Ok(ai::CatalogContext {
            binding,
            configuration: self.committed_config.wallpaper.clone(),
            targets,
            replaced_generations,
        })
    }

    pub(super) fn validate_ai_authority(&self, authority: &ai::Authority) -> AiResult<()> {
        ai::check_authority(
            authority,
            &self.ai_context(authority.binding.settings_session)?.binding,
        )?;
        if authority.action.target_group_id != authority.binding.target_group_id
            || authority.request_id.is_empty()
        {
            return Err(ai::stale());
        }
        Ok(())
    }

    pub(super) fn handle_ai_management(
        &mut self,
        value: serde_json::Value,
        reply: ApiReply,
        _target: &EventLoopWindowTarget<()>,
    ) {
        let owner = match &reply {
            ApiReply::Settings(owner)
                if self.settings.is_some() && *owner == self.settings_generation =>
            {
                *owner
            }
            _ => 0,
        };
        let id = value["requestId"].as_str().map(str::to_owned);
        // No ordinary management principal can self-attest with approved,
        // explicit, isTrusted or an alleged settings generation.
        if owner == 0 {
            self.send_wallpaper_management(
                reply,
                api::response(
                    id.as_deref(),
                    Err(JobError::new(
                        "settings_session_required",
                        "离线动作只能来自当前原生设置会话",
                    )),
                    None,
                ),
            );
            return;
        }
        let request = match ai::parse_request(value) {
            Ok(request) => request,
            Err(error) => {
                self.send_wallpaper_management(
                    reply,
                    api::response(id.as_deref(), Err(error), None),
                );
                return;
            }
        };
        let result: AiResult<Option<serde_json::Value>> = (|| match request.command.as_str() {
            "wallpaper.ai.target" => {
                let input: ai::TargetInput = serde_json::from_value(request.payload.clone())
                    .map_err(|error| JobError::invalid_input(error.to_string()))?;
                if input.group_id.as_ref().is_some_and(|group| {
                    !self
                        .committed_config
                        .wallpaper
                        .groups
                        .iter()
                        .any(|entry| &entry.id == group)
                }) {
                        self.wallpaper_ai.select_group(owner, None)?;
                    return Err(JobError::new(
                        "target_required",
                        "先保存这个显示组，再使用离线切换",
                    ));
                }
                self.wallpaper_ai
                    .select_group(owner, input.group_id.as_deref())?;
                let context = self.ai_context(owner)?;
                Ok(Some(
                    serde_json::json!({"available":true,"groupId":context.binding.target_group_id,"members":context.targets,
                        "configRevision":context.binding.expected_config_revision}),
                ))
            }
            "wallpaper.ai.invalidate" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Empty {}
                let _: Empty = serde_json::from_value(request.payload.clone())
                    .map_err(|error| JobError::invalid_input(error.to_string()))?;
                self.wallpaper_ai.invalidate();
                Ok(Some(serde_json::json!({"invalidated":true})))
            }
            "wallpaper.ai.recommend" | "wallpaper.ai.confirm" => {
                let context = self.ai_context(owner)?;
                if request.expected_revision != Some(context.binding.expected_config_revision) {
                    return Err(JobError::new(
                        "config_conflict",
                        "配置修订已变化，请重新读取目标",
                    ));
                }
                let replay = config::replay_request(&crate::config_journal::Intent {
                    request_id: request.request_id.clone(),
                    payload_digest: request.digest(),
                    command: request.command.clone(),
                    caller_sid: context.binding.principal.clone(),
                })
                .map_err(|error| {
                    JobError::new(
                        crate::config_journal::error_code(&error, "config_conflict"),
                        error.to_string(),
                    )
                })?;
                if let Some(operation) = replay {
                    return Ok(Some(serde_json::to_value(operation).expect("operation")));
                }
                if let Some(receipt) = self.wallpaper_library.begin_local(&request)? {
                    self.send_wallpaper_management(reply.clone(), receipt);
                    return Ok(None);
                }
                if request.command == "wallpaper.ai.recommend" {
                    let input: ai::RecommendInput = serde_json::from_value(request.payload.clone())
                        .map_err(|error| JobError::invalid_input(error.to_string()))?;
                    let proxy = self.proxy.clone();
                    let pending = request.clone();
                    self.wallpaper_library
                        .recommend_ai(input.brief, context, move |result| {
                            let _ = proxy.send_event(UserEvent::WallpaperAiResult(
                                owner,
                                pending,
                                Box::new(result),
                            ));
                        })?;
                    Ok(None)
                } else {
                    let input: ai::ConfirmInput =
                        serde_json::from_value(request.payload.clone())
                            .map_err(|error| JobError::invalid_input(error.to_string()))?;
                    self.start_ai_switch(
                        request.clone(),
                        owner,
                        &input.action_id,
                        context.binding,
                    )?;
                    Ok(None)
                }
            }
            _ => Err(JobError::new("unsupported_command", "此离线命令尚未提供")),
        })();
        match result {
            Ok(None) => {}
            other => {
                let receipt = api::response(
                    Some(&request.request_id),
                    other.and_then(|value| value.ok_or_else(ai::stale)),
                    None,
                );
                self.wallpaper_library.finish_local(&request, &receipt);
                self.send_wallpaper_management(reply, receipt);
            }
        }
    }

    pub(super) fn finish_ai_catalog(
        &mut self,
        owner: u64,
        request: api::Request,
        result: AiResult<ai::Catalog>,
    ) {
        let result = result.and_then(|catalog| {
            let context=self.ai_context(owner)?;
            self.wallpaper_ai.show(&catalog,&context.binding)?;
            if let Some(action)=catalog.explicit_action.as_ref() {
                self.start_ai_switch(request.clone(),owner,action,context.binding)?;
                return Ok(None);
            }
            Ok(Some(serde_json::json!({"mode":"offline","actions":catalog.actions,"ambiguous":catalog.ambiguous,
                "inspected":catalog.inspected,"targetGroupId":catalog.binding.target_group_id,"configRevision":catalog.binding.expected_config_revision,
                "message":if catalog.ambiguous {"有同名确切版本，请选择要切换的一项。"} else {"选择一项已展示动作即可切换；描述建议本身不会改变桌面。"}})))
        });
        match result {
            Ok(None) => {}
            result => {
                let receipt = api::response(
                    Some(&request.request_id),
                    result.and_then(|value| value.ok_or_else(ai::stale)),
                    None,
                );
                self.wallpaper_library.finish_local(&request, &receipt);
                self.send_wallpaper_management(ApiReply::Settings(owner), receipt);
            }
        }
    }

    fn start_ai_switch(
        &mut self,
        request: api::Request,
        owner: u64,
        action: &str,
        binding: ai::Binding,
    ) -> AiResult<()> {
        if self.wallpaper_apply.is_some() {
            return Err(JobError::new(
                "budget_busy",
                "原设置保存队列正在处理一项操作",
            ));
        }
        let current = self.ai_context(owner)?.binding;
        if current != binding {
            return Err(ai::stale());
        }
        let slot = self.wallpaper_library.reserve()?;
        let now = Instant::now();
        let ticket = self.wallpaper_ai.issue_displayed(action, &current, now)?;
        let mut authority = self.wallpaper_ai.consume(
            &ticket,
            &self.ai_context(owner)?.binding,
            &request.request_id,
            now,
        )?;
        authority.context = Some(self.ai_context(owner)?);
        self.begin_ai_wallpaper_apply(request.clone(), authority, ApiReply::Settings(owner), slot)?;
        if let Some(settings) = self.settings.as_ref() {
            settings.eval(&format!(
                "window.hertzWallpaperAI && window.hertzWallpaperAI.applyProgress({});",
                serde_json::json!({"requestId":request.request_id,"phase":"accepted","saved":false})
            ));
        }
        Ok(())
    }

    pub(super) fn finish_ai_receipt(
        &self,
        authority: &ai::Authority,
        result: &AiResult<serde_json::Value>,
    ) -> serde_json::Value {
        let saved = result
            .as_ref()
            .ok()
            .and_then(|value| value["saved"].as_bool())
            .unwrap_or(false);
        let runtimes: Vec<_> = self
            .desktop
            .runtimes
            .values()
            .filter(|runtime| runtime.configuration.main().id == authority.binding.target_group_id)
            .collect();
        let phase = if !saved || runtimes.iter().any(|runtime| runtime.apply_error.is_some()) {
            "failed"
        } else if !self.committed_config.wallpaper.enabled || self.feature_stops.wallpaper {
            "paused"
        } else if !runtimes.is_empty()
            && runtimes.iter().all(|runtime| {
                runtime.surface.as_ref().is_some_and(|surface| {
                    surface.first_frame_ready()
                        && surface.runtime_reference.as_ref().is_some_and(|reference| {
                            reference.work_key == authority.action.work_key
                                && reference.package_hash == authority.action.package_hash
                        })
                })
            })
        {
            if runtimes.iter().all(|runtime| runtime.visible) {
                "running"
            } else {
                "paused"
            }
        } else {
            "saved"
        };
        serde_json::json!({"requestId":authority.request_id,"phase":phase,"saved":saved,"groupId":authority.binding.target_group_id,
            "workKey":authority.action.work_key,"packageHash":authority.action.package_hash,"configRevision":self.config.revision})
    }
}
