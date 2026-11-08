// SPDX-License-Identifier: MIT
//! One settings transaction owns the complete display intent. Expensive media
//! preparation runs serially; only this owner may commit and acknowledge Apply.
use super::*;
use crate::wallpaper::{api, display, jobs::JobError, selection_plan, service};
use std::collections::{BTreeMap, VecDeque};

type JobResult<T> = std::result::Result<T, JobError>;

pub(super) struct ApplyTransaction {
    request: api::Request,
    owner: u64,
    draft: crate::wallpaper::settings_drafts::Draft,
    reply: ApiReply,
    plan: display::DisplayPlan,
    queue: VecDeque<display::DisplayTarget>,
    prepared: BTreeMap<String, selection_plan::ResolvedPlan>,
    layouts: Vec<(crate::wallpaper::config::Selection, usize)>,
    properties: Vec<crate::wallpaper::public_properties::PropertySelection>,
    layout_task: Option<u64>,
    active: Option<(u64, display::DisplayTarget)>,
    cancel: Arc<AtomicBool>,
    initial_slot: Option<service::Slot>,
    started: Instant,
    preserve_failed_playback: bool,
    ai: Option<crate::wallpaper::ai::Authority>,
    ai_recheck_pending: bool,
    ai_rechecked: bool,
}

impl ApplyTransaction {
    pub(super) fn cancel_for_feature_exit(&self) {
        self.cancel.store(true, Ordering::Release);
    }

    pub(super) fn cancel_for_playlist(&self, id: &str) {
        if self.draft.wallpaper.groups.iter().any(|group| matches!(&group.selection, crate::wallpaper::config::Selection::Playlist { playlist_id } if playlist_id == id)) {
            self.cancel.store(true, Ordering::Release);
        }
    }

    pub(super) fn references_package(&self, work: Option<&str>, package: Option<&str>) -> bool {
        self.draft.wallpaper.references_package(work, package)
            || self.prepared.values().any(|plan| plan.reference.matches(work, package))
            // An unresolved playlist may still select any stored package. Keep
            // deletion blocked until its worker has returned the fixed reference.
            || self.active.is_some()
            || self.layout_task.is_some()
    }
}

fn checked_plan(configuration: &config::WallpaperConfig) -> JobResult<display::DisplayPlan> {
    validate_configured_presentation(configuration).map_err(JobError::invalid_input)?;
    let plan = display::DisplayTopology::default().reconcile(
        &configuration.groups,
        &native::wallpaper_monitors(),
        Instant::now(),
    )?;
    if plan.diagnostics.iter().any(|item| {
        matches!(
            item.reason,
            "display_claimed_twice" | "invalid_span_geometry" | "ambiguous_display"
        )
    }) {
        return Err(JobError::new(
            "invalid_display_layout",
            "显示组存在重叠、身份歧义或跨屏尺寸超限，请重新选择显示器",
        ));
    }
    Ok(plan)
}

fn mirror_layouts_to_validate(
    saved: &config::WallpaperConfig,
    draft: &config::WallpaperConfig,
) -> Vec<(crate::wallpaper::config::Selection, usize)> {
    use crate::wallpaper::config::LayoutMode;
    draft
        .groups
        .iter()
        .filter(|group| {
            group.mode == LayoutMode::Mirror
                && (draft.enabled
                    || !saved.groups.iter().any(|old| {
                        old.id == group.id
                            && old.mode == group.mode
                            && old.displays == group.displays
                            && serde_json::to_value(&old.selection).ok()
                                == serde_json::to_value(&group.selection).ok()
                    }))
        })
        .map(|group| (group.selection.clone(), group.displays.len()))
        .collect()
}

fn only_window_policy_changed(
    saved: &config::WallpaperConfig,
    draft: &config::WallpaperConfig,
) -> bool {
    wallpaper_desktop::same_render_intent(saved, draft)
        && (saved.pause_on_fullscreen != draft.pause_on_fullscreen
            || saved.pause_on_maximized != draft.pause_on_maximized
            || serde_json::to_value(&saved.application_rules).ok()
                != serde_json::to_value(&draft.application_rules).ok())
}

fn property_intents_to_validate(
    saved: &config::WallpaperConfig,
    draft: &config::WallpaperConfig,
) -> Vec<crate::wallpaper::public_properties::PropertySelection> {
    draft
        .groups
        .iter()
        .filter(|group| {
            matches!(
                group.selection,
                crate::wallpaper::config::Selection::Package { .. }
                    | crate::wallpaper::config::Selection::Playlist { .. }
            ) && ((!saved.enabled && draft.enabled)
                || !saved.groups.iter().any(|old| {
                    old.id == group.id
                        && old.properties == group.properties
                        && serde_json::to_value(&old.selection).ok()
                            == serde_json::to_value(&group.selection).ok()
                }))
        })
        .map(
            |group| crate::wallpaper::public_properties::PropertySelection {
                selection: group.selection.clone(),
                properties: group.properties.clone(),
            },
        )
        .collect()
}

impl App {
    pub(super) fn begin_ai_wallpaper_apply(&mut self, request: api::Request, authority: crate::wallpaper::ai::Authority,
        reply:ApiReply, slot:service::Slot) -> JobResult<()> {
        self.validate_ai_authority(&authority)?;
        let mut draft=crate::wallpaper::settings_drafts::Draft::from_committed(authority.binding.settings_session,&self.committed_config);
        let group=draft.wallpaper.groups.iter_mut().find(|group|group.id==authority.binding.target_group_id)
            .ok_or_else(crate::wallpaper::ai::stale)?;
        group.selection=crate::wallpaper::config::Selection::Package {work_key:authority.action.work_key.clone(),package_hash:authority.action.package_hash.clone()};
        self.begin_wallpaper_apply_snapshot(request,authority.binding.settings_session,draft,reply,slot,Some(authority))
    }

    pub(super) fn begin_wallpaper_apply(
        &mut self,
        request: api::Request,
        owner: u64,
        reply: ApiReply,
        slot: service::Slot,
    ) -> JobResult<()> {
        if self.wallpaper_apply.is_some() || self.playlist_writes > 0 {
            return Err(JobError::new(
                "budget_busy",
                "显示组或轮播列表正在保存，请等待完成",
            ));
        }
        let api::Command::Apply {
            draft_id,
            draft_revision,
        } = request.typed()?
        else {
            return Err(JobError::invalid_input("需要应用命令"));
        };
        let draft = self
            .settings_drafts
            .get(owner, &draft_id, draft_revision)?
            .clone();
        draft.check_apply(
            request.expected_revision.expect("validated revision"),
            &self.config,
        )?;
        if self.position_edit.is_some() || self.save_due.is_some() {
            return Err(JobError::new("conflict", "请先完成当前设置修改"));
        }
        if draft.lyrics.locked && self.tray.is_none() {
            return Err(JobError::new(
                "tray_unavailable",
                "托盘不可用，暂时无法锁定歌词",
            ));
        }
        self.begin_wallpaper_apply_snapshot(request,owner,draft,reply,slot,None)
    }

    fn begin_wallpaper_apply_snapshot(&mut self, request:api::Request, owner:u64, draft:crate::wallpaper::settings_drafts::Draft,
        reply:ApiReply, slot:service::Slot, ai:Option<crate::wallpaper::ai::Authority>) -> JobResult<()> {
        if self.wallpaper_apply.is_some() || self.playlist_writes>0 || self.library_delete.is_some() {
            return Err(JobError::new("budget_busy","原设置保存、作品删除或轮播事务正在进行"));
        }
        draft.check_apply(request.expected_revision.ok_or_else(||JobError::invalid_input("缺少配置修订"))?, &self.config)?;
        let plan = checked_plan(&draft.wallpaper)?;
        let preserve_failed_playback =
            only_window_policy_changed(&self.config.wallpaper, &draft.wallpaper);
        let queue =
            plan.targets
                .iter()
                .filter(|target| {
                    draft.wallpaper.enabled
                        && wallpaper_runtime::project_group(&draft.wallpaper, &target.group_id)
                            .is_some_and(|config| {
                                config.builtin().is_none()
                                    && !self.desktop.runtimes.get(&target.id).is_some_and(
                                        |runtime| {
                                            !runtime.closing
                                                && (runtime.failed_revision.is_none()
                                                    || preserve_failed_playback)
                                                && runtime.target.as_ref() == Some(*target)
                                                && wallpaper_desktop::same_render_intent(
                                                    &runtime.configuration,
                                                    &config,
                                                )
                                        },
                                    )
                            })
                })
                .cloned()
                .collect();
        self.close_preview();
        let layouts = mirror_layouts_to_validate(&self.config.wallpaper, &draft.wallpaper);
        let properties = property_intents_to_validate(&self.config.wallpaper, &draft.wallpaper);
        self.wallpaper_apply = Some(ApplyTransaction {
            request,
            owner,
            draft,
            reply,
            plan,
            queue,
            prepared: BTreeMap::new(),
            layouts,
            properties,
            layout_task: None,
            active: None,
            cancel: Arc::new(AtomicBool::new(false)),
            initial_slot: Some(slot),
            started: Instant::now(),
            preserve_failed_playback,
            ai,
            ai_recheck_pending: false,
            ai_rechecked: false,
        });
        Ok(())
    }

    pub(super) fn tick_wallpaper_apply(&mut self, target: &EventLoopWindowTarget<()>) {
        let Some(transaction) = self.wallpaper_apply.as_ref() else {
            return;
        };
        let source_valid = if let Some(authority)=transaction.ai.as_ref() {
            self.validate_ai_authority(authority).is_ok()
        } else { self
            .settings_drafts
            .get(
                transaction.owner,
                &transaction.draft.id,
                transaction.draft.revision,
            )
            .is_ok() };
        let valid = source_valid && transaction
                .draft
                .check_apply(
                    transaction
                        .request
                        .expected_revision
                        .expect("validated revision"),
                    &self.config,
                )
                .is_ok()
            && self.save_due.is_none()
            && self.position_edit.is_none();
        if !valid || transaction.started.elapsed() > Duration::from_secs(60) {
            transaction.cancel.store(true, Ordering::Release);
        }
        if transaction.active.is_some() || transaction.layout_task.is_some() {
            return;
        }
        if transaction.cancel.load(Ordering::Acquire) {
            let transaction = self.wallpaper_apply.take().expect("pending apply");
            self.finish_wallpaper_apply(
                transaction,
                Err(JobError::new(
                    "cancelled",
                    "设置已变化或准备超时，本次应用已取消",
                )),
            );
            return;
        }
        if !transaction.layouts.is_empty() || !transaction.properties.is_empty() {
            let mut transaction = self.wallpaper_apply.take().expect("pending apply");
            let slot = transaction
                .initial_slot
                .take()
                .map(Ok)
                .unwrap_or_else(|| self.wallpaper_library.reserve());
            let slot = match slot {
                Ok(slot) => slot,
                Err(_) => {
                    self.wallpaper_apply = Some(transaction);
                    return;
                }
            };
            self.wallpaper_generation += 1;
            let id = self.wallpaper_generation;
            let proxy = self.proxy.clone();
            let result = self.wallpaper_library.validate_presentation_intents(
                transaction.layouts.clone(),
                transaction.properties.clone(),
                Arc::clone(&transaction.cancel),
                slot,
                move |result| {
                    let _ = proxy.send_event(UserEvent::WallpaperApplyLayouts(id, result));
                },
            );
            if let Err(error) = result {
                self.finish_wallpaper_apply(transaction, Err(error));
                return;
            }
            transaction.layout_task = Some(id);
            self.wallpaper_apply = Some(transaction);
            return;
        }
        // The existing service has a single preparation owner. Wait for any
        // previous target's cancellation to really terminate before dispatch.
        if self
            .desktop
            .runtimes
            .values()
            .any(|runtime| runtime.selection.is_some())
        {
            return;
        }
        // Qualifying another video can require a decoder. Two live mirrors
        // already hold the global pair, so preserve affected old frames and
        // await real controller/reader exits before preparing the transaction.
        let video_count = self
            .desktop
            .runtimes
            .values()
            .filter(|runtime| {
                runtime.surface.as_ref().is_some_and(|surface| {
                    surface.media_frame_kind() == crate::wallpaper::session::FrameKind::Video
                        && !surface.static_poster
                })
            })
            .count();
        if video_count >= 2 {
            let affected: Vec<_> = self
                .desktop
                .runtimes
                .iter()
                .filter(|(key, runtime)| {
                    runtime.surface.as_ref().is_some_and(|surface| {
                        surface.media_frame_kind() == crate::wallpaper::session::FrameKind::Video
                            && !surface.static_poster
                    }) && (!transaction
                        .plan
                        .targets
                        .iter()
                        .any(|target| &target.id == *key)
                        || wallpaper_runtime::project_group(
                            &transaction.draft.wallpaper,
                            &runtime.configuration.main().id,
                        )
                        .is_none_or(|configuration| {
                            !wallpaper_desktop::same_render_intent(
                                &configuration,
                                &runtime.configuration,
                            )
                        }))
                })
                .map(|(key, _)| key.clone())
                .collect();
            if !affected.is_empty() {
                // The capture workspace also has one preparation slot.
                for key in affected.into_iter().take(1) {
                    if let Some(Err(error)) =
                        self.with_desktop(&key, |app| app.prepare_wallpaper_handoff())
                    {
                        let transaction = self.wallpaper_apply.take().expect("apply owner");
                        self.finish_wallpaper_apply(
                            transaction,
                            Err(JobError::new("handoff_failed", error.to_string())),
                        );
                        return;
                    }
                }
                return;
            }
        }
        if !self.wallpaper_retiring.is_empty() {
            return;
        }
        let mut transaction = self.wallpaper_apply.take().expect("pending apply");
        if let Some(next) = transaction.queue.pop_front() {
            let slot = transaction
                .initial_slot
                .take()
                .map(Ok)
                .unwrap_or_else(|| self.wallpaper_library.reserve());
            let slot = match slot {
                Ok(slot) => slot,
                Err(_) => {
                    transaction.queue.push_front(next);
                    self.wallpaper_apply = Some(transaction);
                    return;
                }
            };
            let configuration =
                wallpaper_runtime::project_group(&transaction.draft.wallpaper, &next.group_id)
                    .expect("planned group");
            self.wallpaper_generation += 1;
            let id = self.wallpaper_generation;
            let proxy = self.proxy.clone();
            let selection =
                if configuration.main().mode == crate::wallpaper::config::LayoutMode::Mirror {
                    transaction
                        .plan
                        .targets
                        .iter()
                        .filter(|target| target.group_id == next.group_id)
                        .find_map(|target| {
                            transaction
                                .prepared
                                .get(&target.id)
                                .map(|plan| plan.reference.selection())
                        })
                        .unwrap_or_else(|| configuration.main().selection.clone())
                } else {
                    configuration.main().selection.clone()
                };
            let resume = self.desktop.mirrors.get(&next.group_id).and_then(|group| {
                if configuration.main().mode != crate::wallpaper::config::LayoutMode::Mirror { return None; }
                let playlist = group.playback.playlist()?;
                if !matches!(&selection, crate::wallpaper::config::Selection::Playlist { playlist_id } if playlist_id == &playlist.playlist_id) { return None; }
                Some(selection_plan::PlaylistResume { revision: playlist.revision, reference: group.playback.switch()?.reference.clone() })
            });
            let result = self.wallpaper_library.resolve_desktop_selection(
                selection,
                wallpaper_desktop::target(&configuration, &next.monitor()),
                selection_plan::SelectionOptions {
                    mirror_members: (configuration.main().mode
                        == crate::wallpaper::config::LayoutMode::Mirror)
                        .then_some(configuration.main().displays.len()),
                    resume,
                    properties: configuration.main().properties.clone(),
                composition_fit: Some(configuration.presentation().fit),
                },
                Arc::clone(&transaction.cancel),
                slot,
                move |result| {
                    let _ =
                        proxy.send_event(UserEvent::WallpaperSelection(id, result.map(Box::new)));
                },
            );
            if let Err(error) = result {
                self.finish_wallpaper_apply(transaction, Err(error));
                return;
            }
            transaction.active = Some((id, next));
            self.wallpaper_apply = Some(transaction);
            return;
        }
        if let Some(authority)=transaction.ai.clone().filter(|_| !transaction.ai_rechecked) {
            let slot=match transaction.initial_slot.take().map(Ok).unwrap_or_else(||self.wallpaper_library.reserve()) {
                Ok(slot)=>slot,Err(_)=>{self.wallpaper_apply=Some(transaction);return;}
            };
            self.wallpaper_generation+=1;
            let id=self.wallpaper_generation;let proxy=self.proxy.clone();
            if let Err(error)=self.wallpaper_library.revalidate_ai(authority,Arc::clone(&transaction.cancel),slot,
                move|result|{let _=proxy.send_event(UserEvent::WallpaperApplyLayouts(id,result));}) {
                self.finish_wallpaper_apply(transaction,Err(error));return;
            }
            transaction.layout_task=Some(id);transaction.ai_recheck_pending=true;
            self.wallpaper_apply=Some(transaction);return;
        }
        let result = (|| {
            if let Some(authority)=transaction.ai.as_ref() { self.validate_ai_authority(authority)?; }
            transaction.draft.check_apply(
                transaction
                    .request
                    .expected_revision
                    .expect("validated revision"),
                &self.config,
            )?;
            let current = checked_plan(&transaction.draft.wallpaper)?;
            if current.targets != transaction.plan.targets {
                return Err(JobError::new(
                    "display_changed",
                    "准备期间显示器发生变化，请重新应用",
                ));
            }
            let intent = crate::config_journal::Intent {
                request_id: transaction.request.request_id.clone(),
                payload_digest: transaction.request.digest(),
                command: transaction.request.command.clone(),
                caller_sid: crate::config_journal::caller_sid()
                    .map_err(|error| JobError::new("identity_unavailable", error.to_string()))?,
            };
            let mut next = if transaction.ai.is_some() { self.committed_config.clone() } else { self.config.clone() };
            next.wallpaper = transaction.draft.wallpaper.clone();
            next.lyrics = transaction.draft.lyrics.clone();
            config::commit_request(&mut self.config, next, &intent).map_err(|error| {
                JobError::new(
                    crate::config_journal::error_code(&error, "config_write_failed"),
                    error.to_string(),
                )
            })
        })();
        match result {
            Ok(operation) => {
                if transaction.draft.wallpaper.enabled {
                    self.feature_stops.wallpaper = false;
                    self.feature_stops.wallpaper_save_failed = false;
                }
                if transaction.ai.is_none() && transaction.draft.lyrics.enabled {
                    self.resume_lyrics();
                }
                // Registry mutation occurs outside target scopes, after the one
                // canonical commit and before any target activation/status send.
                let reconcile_error = self
                    .reconcile_desktops(&native::wallpaper_monitors(), Instant::now())
                    .err();
                if !transaction.preserve_failed_playback {
                    self.retry_failed_mirrors_after_apply();
                }
                for (key, resolved) in std::mem::take(&mut transaction.prepared) {
                    let monitor = transaction
                        .plan
                        .targets
                        .iter()
                        .find(|descriptor| descriptor.id == key)
                        .expect("prepared target")
                        .monitor();
                    self.with_desktop(&key, |app| app.install_resolved_plan(resolved, monitor));
                }
                let preserved_drafts=transaction.ai.as_ref().map(|_|std::mem::take(&mut self.settings_drafts));
                let run_error = self
                    .apply_saved_wallpaper_settings(transaction.draft.wallpaper.clone(), target)
                    .err()
                    .or_else(|| reconcile_error.map(|error| error.to_string()));
                if let Some(drafts)=preserved_drafts { self.settings_drafts=drafts; }
                self.send_settings_status(run_error.as_deref(), Some(if transaction.ai.is_some() {"已切换壁纸（设置草稿保留）"} else {"已应用"}));
                let receipt = if operation.state == crate::config_journal::State::Pending {
                    Err(JobError::new(
                        "operation_pending",
                        "配置写入完成，正在核对提交记录，请按原请求查询",
                    ))
                } else {
                    Ok(serde_json::to_value(operation).expect("configuration receipt"))
                };
                self.finish_wallpaper_apply(transaction, receipt);
            }
            Err(error) => self.finish_wallpaper_apply(transaction, Err(error)),
        }
    }

    pub(super) fn apply_owns_selection(&self, id: u64) -> bool {
        self.wallpaper_apply
            .as_ref()
            .and_then(|transaction| transaction.active.as_ref())
            .is_some_and(|(active, _)| *active == id)
    }

    pub(super) fn finish_apply_layouts(
        &mut self,
        id: u64,
        result: JobResult<()>,
        target: &EventLoopWindowTarget<()>,
    ) {
        if !self
            .wallpaper_apply
            .as_ref()
            .is_some_and(|transaction| transaction.layout_task == Some(id))
        {
            return;
        }
        let mut transaction = self.wallpaper_apply.take().expect("apply layout owner");
        transaction.layout_task = None;
        if transaction.cancel.load(Ordering::Acquire) {
            self.finish_wallpaper_apply(
                transaction,
                Err(JobError::new("cancelled", "设置检查已取消并退出")),
            );
            return;
        }
        match result {
            Ok(()) => {
                if transaction.ai_recheck_pending { transaction.ai_recheck_pending=false;transaction.ai_rechecked=true; }
                else { transaction.layouts.clear();transaction.properties.clear(); }
            }
            Err(error) if error.code == "budget_busy" => {
                self.wallpaper_apply = Some(transaction);
                return;
            }
            Err(error) => {
                self.finish_wallpaper_apply(transaction, Err(error));
                return;
            }
        }
        self.wallpaper_apply = Some(transaction);
        self.tick_wallpaper_apply(target);
    }

    pub(super) fn finish_apply_selection(
        &mut self,
        id: u64,
        result: std::result::Result<selection_plan::ResolvedPlan, selection_plan::Failure>,
        target: &EventLoopWindowTarget<()>,
    ) {
        if !self.apply_owns_selection(id) {
            return;
        }
        let mut transaction = self.wallpaper_apply.take().expect("apply owner");
        let (_, descriptor) = transaction.active.take().expect("apply selection");
        if transaction.cancel.load(Ordering::Acquire) {
            self.finish_wallpaper_apply(
                transaction,
                Err(JobError::new("cancelled", "设置准备已取消并退出")),
            );
            return;
        }
        match result {
            Ok(plan) => {
                let configuration = wallpaper_runtime::project_group(
                    &transaction.draft.wallpaper,
                    &descriptor.group_id,
                )
                .expect("planned group");
                if let Err(error) = wallpaper_mirror::validate_plan(&configuration, &plan) {
                    self.finish_wallpaper_apply(transaction, Err(error));
                    return;
                }
                transaction.prepared.insert(descriptor.id, plan);
            }
            Err(failure) if failure.error.code == "budget_busy" => {
                transaction.queue.push_front(descriptor);
                self.wallpaper_apply = Some(transaction);
                return;
            }
            Err(failure) => {
                self.finish_wallpaper_apply(transaction, Err(failure.error));
                return;
            }
        }
        self.wallpaper_apply = Some(transaction);
        self.tick_wallpaper_apply(target);
    }

    fn finish_wallpaper_apply(
        &mut self,
        transaction: ApplyTransaction,
        result: JobResult<serde_json::Value>,
    ) {
        let progress=transaction.ai.as_ref().map(|authority|self.finish_ai_receipt(authority,&result));
        let mut receipt = api::response(Some(&transaction.request.request_id), result, None);
        if let Some(progress)=progress {
            receipt["ai"]=progress.clone();
            if let Some(settings)=self.settings.as_ref() {
                if progress["saved"]==true && progress["phase"]!="saved" {
                    let mut saved=progress.clone();saved["phase"]="saved".into();
                    settings.eval(&format!("window.hertzWallpaperAI && window.hertzWallpaperAI.applyProgress({saved});"));
                }
                settings.eval(&format!("window.hertzWallpaperAI && window.hertzWallpaperAI.applyProgress({progress});"));
            }
        }
        receipt["configRevision"] = receipt["result"]["configRevision"]
            .as_u64()
            .unwrap_or(self.config.revision)
            .into();
        self.wallpaper_library
            .finish_local(&transaction.request, &receipt);
        self.send_wallpaper_management(transaction.reply, receipt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::config::{DisplaySelection, LayoutMode, Selection};

    #[test]
    fn window_policy_changes_preserve_failed_playback_but_explicit_reapply_can_retry() {
        let saved = config::WallpaperConfig::default();
        let mut draft = saved.clone();
        assert!(!only_window_policy_changed(&saved, &draft));
        draft.pause_on_maximized = true;
        assert!(only_window_policy_changed(&saved, &draft));
        draft.main_mut().presentation.brightness = 0.5;
        assert!(!only_window_policy_changed(&saved, &draft));
    }

    #[test]
    fn offline_and_disabled_new_mirror_intents_are_qualified_but_shutdown_is_available() {
        let saved = config::WallpaperConfig::default();
        let mut draft = saved.clone();
        draft.enabled = false;
        draft.groups[0].mode = LayoutMode::Mirror;
        draft.groups[0].displays = vec![
            DisplaySelection::Fixed {
                display_id: "offline-a".into(),
            },
            DisplaySelection::Fixed {
                display_id: "offline-b".into(),
            },
        ];
        draft.groups[0].selection = Selection::Package {
            work_key: "saved-video".into(),
            package_hash: "a".repeat(64),
        };
        assert_eq!(mirror_layouts_to_validate(&saved, &draft).len(), 1);
        let saved_mirror = draft.clone();
        assert!(
            mirror_layouts_to_validate(&saved_mirror, &draft).is_empty(),
            "disabling unchanged damaged content must remain possible"
        );
        draft.enabled = true;
        assert_eq!(
            mirror_layouts_to_validate(&saved_mirror, &draft).len(),
            1,
            "enabled Apply always rechecks even an unchanged offline group"
        );
        draft.enabled = false;
        draft.groups[0].displays.push(DisplaySelection::Fixed {
            display_id: "offline-c".into(),
        });
        assert_eq!(
            mirror_layouts_to_validate(&saved_mirror, &draft).len(),
            1,
            "disabled member-count changes still need admission"
        );
    }
}
