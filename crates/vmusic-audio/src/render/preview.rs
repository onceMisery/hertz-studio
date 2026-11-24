// SPDX-License-Identifier: MIT
//! Temporary parameters borrow the saved configuration inside the existing renderer.
//! Source probing/preparation precede adoption. Only the actor touches this state.
use super::{dsp::PreparedEq, impulse::PreparedImpulse, *};
use std::time::{Duration, Instant};
use vmusic_core::audio_preview::{PreviewPlan, PreviewSide, PreviewStatus, PREVIEW_TTL_MS};
use vmusic_core::audio_quality::{HeadroomMode, QualityParams, ToneParams};

#[derive(Default)]
pub(super) struct PreviewSlot {
    ready: Option<Ready>,
    active: Option<Active>,
    restored: Option<String>,
}

#[cfg(test)]
mod tests;
struct Ready {
    plan: PreviewPlan,
    opened: OpenedReader,
    info: MediaInfo,
    enhanced: PreparedEq,
    bypass: PreparedEq,
    kernel: Option<PreparedImpulse>,
    restore: PreparedEq,
    restore_kernel: Option<PreparedImpulse>,
    output_id: u64,
    expires: Instant,
}
struct Active {
    plan: PreviewPlan,
    enhanced: PreparedEq,
    bypass: PreparedEq,
    kernel: Option<PreparedImpulse>,
    restore: PreparedEq,
    restore_kernel: Option<PreparedImpulse>,
    output_id: u64,
    expires: Instant,
    side: PreviewSide,
    pending: bool,
    resume_position_ms: u64,
}

pub(crate) fn bypass(saved: QualityParams) -> QualityParams {
    let mut p = saved;
    p.eq.enabled = false;
    p.preamp_db = 0.0;
    p.headroom_mode = HeadroomMode::Off;
    p.tone = ToneParams::default();
    p.impulse_id = None;
    p
}
pub(crate) fn alignment(plan: &PreviewPlan) -> usize {
    plan.impulse.as_ref().map_or(0, |i| i.kernel.delay_frames)
        + if plan.enhanced.tone.saturation { 8 } else { 0 }
}
fn attenuation(plan: &PreviewPlan, side: PreviewSide) -> f32 {
    plan.matching.as_ref().map_or(0.0, |m| {
        m.common_attenuation_db
            + match side {
                PreviewSide::Enhanced => m.enhanced_attenuation_db,
                PreviewSide::Bypass => m.bypass_attenuation_db,
            }
    })
}
impl RenderCore {
    pub(super) fn prepare_preview(
        &mut self,
        plan: PreviewPlan,
        source: Box<dyn AudioSource>,
        ext: Option<String>,
    ) -> Result<MediaInfo, AudioError> {
        if self.native_budget.is_some() || self.output_channels > 2 {
            return Err(AudioError::Other("临时试听仅支持本机单/双声道输出".into()));
        }
        if self.preview.active.is_some() || self.pending_load.is_some() {
            return Err(AudioError::Other(
                "试听或换曲正在进行，请先结束当前试听".into(),
            ));
        }
        plan.validate(self.output_rate)?;
        self.validate_quality_context(plan.enhanced, self.format())?;
        let restore = *self
            .shared
            .dsp
            .parameters
            .lock()
            .map_err(|_| AudioError::Other("DSP parameters unavailable".into()))?;
        if restore.params != plan.saved
            || self.track_gain_db() != plan.track_gain_db
            || f32::from_bits(self.shared.volume.load(Ordering::Relaxed)) != plan.volume
        {
            return Err(AudioError::Other(
                "保存配置、音量或曲目增益已改变，请重新准备试听".into(),
            ));
        }
        self.shared.dsp.reserve_preview_restore()?;
        let kernel = plan
            .impulse
            .clone()
            .map(PreparedImpulse::prepare_preview)
            .transpose()?;
        let restore_kernel = *self
            .shared
            .dsp
            .impulse
            .lock()
            .map_err(|_| AudioError::Other("校正准备状态不可用".into()))?;
        let enhanced = PreparedEq::preview(
            self.output_rate,
            plan.enhanced,
            attenuation(&plan, PreviewSide::Enhanced),
            0,
        )?;
        let bypass = PreparedEq::preview(
            self.output_rate,
            bypass(plan.saved),
            attenuation(&plan, PreviewSide::Bypass),
            alignment(&plan),
        )?;
        let (opened, info) = open_media(
            MediaSourceStream::new(
                Box::new(DynMediaSource { inner: source }),
                Default::default(),
            ),
            ext.as_deref(),
        )?;
        if !opened.gapless_supported || info.channels.is_some_and(|c| c == 0 || c > 2) {
            return Err(AudioError::UnsupportedFormat(
                "试听需要可精确裁剪的单/双声道音频".into(),
            ));
        }
        self.preview.ready = Some(Ready {
            plan,
            opened,
            info: info.clone(),
            enhanced,
            bypass,
            kernel,
            restore,
            restore_kernel,
            output_id: self.shared.output_gate.current(),
            expires: Instant::now() + Duration::from_millis(PREVIEW_TTL_MS),
        });
        Ok(info)
    }
    pub(super) fn start_preview(
        &mut self,
        id: &str,
        side: PreviewSide,
    ) -> Result<MediaInfo, AudioError> {
        let ready = self
            .preview
            .ready
            .as_ref()
            .filter(|r| r.plan.request_id == id)
            .ok_or_else(|| AudioError::Other("该试听请求已失效，请重新准备".into()))?;
        if ready.expires <= Instant::now()
            || ready.output_id != self.shared.output_gate.current()
            || self.shared.sleep_expired()
            || self.pending_load.is_some()
            || self.track_gain_db() != ready.plan.track_gain_db
            || f32::from_bits(self.shared.volume.load(Ordering::Relaxed)) != ready.plan.volume
            || self
                .shared
                .dsp
                .parameters
                .lock()
                .map_err(|_| AudioError::Other("DSP parameters unavailable".into()))?
                .params
                != ready.plan.saved
        {
            self.preview.ready = None;
            return Err(AudioError::Other(
                "试听准备期间播放、输出或参数已改变".into(),
            ));
        }
        // Never withdraw a successor which has already emitted an overlap or promotion.
        if !self.clear_unstarted_next() {
            return Err(AudioError::Other("当前歌曲正在转场，请稍后试听".into()));
        }
        self.shared.dsp.reserve_preview_restore()?;
        let ready = self.preview.ready.take().unwrap();
        let was_playing = self.shared.playing.load(Ordering::Relaxed)
            && !self.pending_pause
            && !self.pending_stop;
        let resume_position_ms = self.position_ms();
        let info = ready.info.clone();
        let gain = ready.plan.track_gain_db;
        self.preview.active = Some(Active {
            plan: ready.plan,
            enhanced: ready.enhanced,
            bypass: ready.bypass,
            kernel: ready.kernel,
            restore: ready.restore,
            restore_kernel: ready.restore_kernel,
            output_id: ready.output_id,
            expires: Instant::now() + Duration::from_millis(PREVIEW_TTL_MS),
            side,
            pending: true,
            resume_position_ms,
        });
        self.shared.preview_deadline.set(Some(
            crate::sleep_deadline::now_ms().saturating_add(PREVIEW_TTL_MS),
        ));
        if let Err(error) = self.install_opened(ready.opened, ready.info) {
            let _ = self.invalidate_preview(false);
            return Err(error);
        }
        if let Some(pending) = &mut self.pending_load {
            pending.track_gain_db = Some(gain);
            pending.play_after = was_playing;
        } else {
            self.shared
                .current_deck()
                .gain_db
                .store(gain.to_bits(), Ordering::Relaxed);
            self.activate_pending_preview()?;
            self.shared.playing.store(
                was_playing && !self.shared.sleep_expired(),
                Ordering::Relaxed,
            );
        }
        Ok(info)
    }
    pub(super) fn activate_pending_preview(&mut self) -> Result<(), AudioError> {
        let Some(active) = self.preview.active.as_mut().filter(|a| a.pending) else {
            return Ok(());
        };
        let (eq, kernel) = match active.side {
            PreviewSide::Enhanced => (active.enhanced, active.kernel),
            PreviewSide::Bypass => (active.bypass, None),
        };
        self.shared.dsp.publish_preview(eq, kernel)?;
        self.shared
            .preview_end_frame
            .store(active.plan.reference_end_frame, Ordering::Relaxed);
        self.shared.dsp.reset();
        active.pending = false;
        Ok(())
    }
    pub(super) fn select_preview(&mut self, id: &str, side: PreviewSide) -> Result<(), AudioError> {
        let active = self
            .preview
            .active
            .as_ref()
            .filter(|a| a.plan.request_id == id && !a.pending)
            .ok_or_else(|| AudioError::Other("试听尚未采用或已结束".into()))?;
        if active.expires <= Instant::now()
            || active.output_id != self.shared.output_gate.current()
            || self.shared.preview_deadline.expired()
            || self.shared.sleep_expired()
        {
            self.invalidate_preview(true)?;
            return Err(AudioError::Other("试听已到期或输出已改变".into()));
        }
        self.shared.dsp.reserve_preview_restore()?;
        let (eq, kernel) = match side {
            PreviewSide::Enhanced => (active.enhanced, active.kernel),
            PreviewSide::Bypass => (active.bypass, None),
        };
        let playing = self.shared.playing.swap(false, Ordering::Relaxed);
        let result = self
            .seek_timeline(0)
            .and_then(|()| self.shared.dsp.publish_preview(eq, kernel));
        if result.is_err() {
            let _ = self.invalidate_preview(false);
        } else {
            let active = self.preview.active.as_mut().unwrap();
            active.side = side;
            active.expires = Instant::now() + Duration::from_millis(PREVIEW_TTL_MS);
            self.shared.preview_deadline.set(Some(
                crate::sleep_deadline::now_ms().saturating_add(PREVIEW_TTL_MS),
            ));
            self.shared.dsp.reset();
            self.shared.reset_fade_shared();
            self.shared.arm_fade(1.0, FADE_IN_MS, self.output_rate);
        }
        self.shared
            .playing
            .store(playing && !self.shared.sleep_expired(), Ordering::Relaxed);
        result
    }
    pub(super) fn cancel_preview(&mut self, id: Option<&str>) -> Result<bool, AudioError> {
        let matches = self
            .preview
            .active
            .as_ref()
            .is_some_and(|a| id.is_none_or(|id| id == a.plan.request_id))
            || self
                .preview
                .ready
                .as_ref()
                .is_some_and(|a| id.is_none_or(|id| id == a.plan.request_id));
        if !matches {
            return Ok(false);
        }
        self.invalidate_preview(true)?;
        Ok(true)
    }
    /// Normal load/seek/save/output/ownership changes use this before their own action.
    /// The borrowed parameters are removed first, so a delayed UUID cannot restore them again.
    pub(crate) fn invalidate_preview(&mut self, restore_position: bool) -> Result<(), AudioError> {
        self.preview.ready = None;
        let Some(active) = self.preview.active.take() else {
            return Ok(());
        };
        self.shared.preview_end_frame.store(0, Ordering::Relaxed);
        self.shared.preview_deadline.set(None);
        self.shared
            .dsp
            .publish_preview(active.restore, active.restore_kernel)?;
        self.shared.dsp.reset();
        if active.pending {
            self.pending_load = None;
            if restore_position {
                self.seek_timeline(active.resume_position_ms)?;
                self.preview.restored = Some(active.plan.request_id);
            }
            if self.shared.playing.load(Ordering::Relaxed)
                && !self.pending_pause
                && !self.pending_stop
                && !self.shared.sleep_expired()
            {
                self.shared.arm_fade(1.0, FADE_IN_MS, self.output_rate);
            }
        } else if restore_position {
            self.seek_timeline(active.resume_position_ms)?;
            self.preview.restored = Some(active.plan.request_id);
            // Keep the most recent play/pause intent; expiry never grants a new Play.
            if self.shared.playing.load(Ordering::Relaxed)
                && !self.pending_pause
                && !self.pending_stop
                && !self.shared.sleep_expired()
            {
                self.shared.reset_fade_shared();
                self.shared.arm_fade(1.0, FADE_IN_MS, self.output_rate);
            }
        }
        Ok(())
    }
    pub(super) fn take_preview_restore(&mut self) -> Option<String> {
        self.preview.restored.take()
    }

    pub(super) fn refresh_preview(&mut self, id: &str) -> bool {
        let Some(active) = self
            .preview
            .active
            .as_mut()
            .filter(|a| a.plan.request_id == id)
        else {
            return false;
        };
        if active.expires <= Instant::now()
            || self.shared.preview_deadline.expired()
            || self.shared.sleep_expired()
            || active.output_id != self.shared.output_gate.current()
        {
            return false;
        }
        active.expires = Instant::now() + Duration::from_millis(PREVIEW_TTL_MS);
        self.shared.preview_deadline.set(Some(
            crate::sleep_deadline::now_ms().saturating_add(PREVIEW_TTL_MS),
        ));
        true
    }
    pub(super) fn maintain_preview(&mut self) {
        if self
            .preview
            .ready
            .as_ref()
            .is_some_and(|r| r.expires <= Instant::now())
        {
            self.preview.ready = None;
        }
        let Some(active) = self.preview.active.as_ref() else {
            return;
        };
        let ended = !active.pending
            && (self.position_frames() >= active.plan.reference_end_frame
                || (self.shared.current_deck().eof.load(Ordering::Acquire)
                    && self
                        .shared
                        .current_deck()
                        .samples
                        .lock()
                        .is_ok_and(|q| q.is_empty())
                    && self.shared.dsp.terminal_queued.load(Ordering::Acquire) == 0
                    && !self.shared.dsp.terminal_inflight.load(Ordering::Acquire)));
        if ended
            || active.expires <= Instant::now()
            || active.output_id != self.shared.output_gate.current()
            || self.shared.sleep_expired()
            || self.shared.preview_deadline.expired()
        {
            if let Err(error) = self.invalidate_preview(true) {
                self.shared.playing.store(false, Ordering::Relaxed);
                self.transport_error = Some(error);
            }
        }
    }
    pub(super) fn project_preview(&self, status: &mut vmusic_core::audio_quality::QualityStatus) {
        status.track_gain_db = self.track_gain_db();
        let Some(active) = &self.preview.active else {
            return;
        };
        let temporary_applied = status.eq.state == vmusic_core::EqApplicationState::Applied;
        let effective_params = status.applied;
        status.requested = active.plan.saved;
        status.requested_headroom = active.restore.headroom;
        status.eq.requested_gains_db = active.plan.saved.gains();
        status.eq.requested_preamp_db = active.plan.saved.preamp_db;
        status.eq.applied_revision = None;
        status.eq.state = vmusic_core::EqApplicationState::Deferred;
        status.applied = None;
        status.deferred_reason = Some("temporary_preview_active");
        status.preview = Some(PreviewStatus {
            request_id: active.plan.request_id.clone(),
            side: active.side,
            state: if active.pending {
                "starting"
            } else if temporary_applied {
                "active"
            } else {
                "applying"
            }
            .into(),
            saved_revision: active.plan.saved.configuration_revision.to_string(),
            phase: active.plan.impulse.as_ref().map(|i| i.phase),
            matching: active.plan.matching.clone(),
            source_sha256: active.plan.source_sha256.clone(),
            remaining_ms: active
                .expires
                .saturating_duration_since(Instant::now())
                .as_millis() as u64,
            reference_end_ms: active.plan.reference_end_ms,
            reference_end_frame: active.plan.reference_end_frame,
            alignment_frames: alignment(&active.plan),
            temporary_attenuation_db: attenuation(&active.plan, active.side),
            effective_params,
        });
    }
    pub(super) fn seek_timeline(&mut self, position_ms: u64) -> Result<(), AudioError> {
        if self.pending_load.is_some() {
            self.shared.playing.store(false, Ordering::Relaxed);
            self.spawn_pending();
        }
        let position_ms = position_ms.min(self.duration_ms.unwrap_or(u64::MAX));
        let (handle, ctl) = self.decoder.as_ref().ok_or(AudioError::NothingLoaded)?;
        ctl.seek(handle, position_ms, std::time::Duration::from_secs(2))?;
        self.shared.dsp.reset();
        // 尾段淡出途中 seek：增益正沿尾斜坡滑向 0，而 tail_armed 会阻止
        // 尾部逻辑重新武装——不处理就永远卡在静音。解除门闩，从当前增益
        // 起步装一条 120ms 短回淡（arm_fade 自己读当前 fade_gain 当初值）。
        // 例外：pending_stop 复位时的 seek(0) 是停止动作，不能再淡回来。
        if self.tail_armed {
            self.tail_armed = false;
            if !self.pending_stop && !self.pending_pause {
                self.shared.arm_fade(1.0, 120, self.output_rate);
            }
        }
        Ok(())
    }

    fn track_gain_db(&self) -> f32 {
        f32::from_bits(self.shared.current_deck().gain_db.load(Ordering::Relaxed))
    }
    pub(super) fn preview_blocks_successor(&self) -> bool {
        self.preview.active.is_some()
    }
}
