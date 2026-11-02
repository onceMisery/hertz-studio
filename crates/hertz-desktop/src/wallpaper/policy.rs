// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸暂停策略：暂停原因集合是唯一的绘制许可真值表（设计 §13.2/§13.3）。
//!
//! 每个原因独立增删并带 scope：桌面呈现（desktop）与实时预览（preview）分别
//! 消费自己的原因投影。解除某一处的原因不能清空另一处的暂停——用户手动暂停
//! 不会被解锁/唤醒自动恢复，预览暂停也不会误停桌面。
//!
//! 强制原因：sessionUnavailable、displayOff、displayMissing、battery；
//! 软原因：manualPause、fullscreen。hidden 是独立的可见性事实，不计入暂停。
//! 电池策略默认 pause；电源状态未知按「先停绘」处理（设计 §13.2）。

use std::time::{Duration, Instant};

use crate::config::WallpaperConfig;
use crate::native::PowerState;

/// 非对称去抖（设计 §13.2）：进入暂停慢（约 750 ms，容忍短暂抖动），恢复快
/// （约 150 ms，退出全屏立刻看见画面）。若实测改为 400 ms 必须改同一常量。
pub(crate) const FULLSCREEN_PAUSE_ENTER: Duration = Duration::from_millis(750);
pub(crate) const FULLSCREEN_RESUME: Duration = Duration::from_millis(150);
/// 目标屏从非空拓扑中消失的判定宽限：连续 3 次未命中（约 750 ms @250 ms 巡检）。
pub(crate) const DISPLAY_MISSING_HITS: u8 = 3;
/// 拓扑/全屏巡检节奏。空拓扑宽限期间不销毁会话、不累计目标缺失。
pub(crate) const TOPOLOGY_INTERVAL: Duration = Duration::from_millis(250);

/// 暂停原因名单；`&'static str` 直接进诊断 JSON，改名会破坏设置页文案映射。
pub(crate) const REASON_MANUAL_PAUSE: &str = "manualPause";
pub(crate) const REASON_FULLSCREEN: &str = "fullscreen";
pub(crate) const REASON_SESSION_UNAVAILABLE: &str = "sessionUnavailable";
pub(crate) const REASON_DISPLAY_OFF: &str = "displayOff";
pub(crate) const REASON_DISPLAY_MISSING: &str = "displayMissing";
pub(crate) const REASON_BATTERY: &str = "battery";
pub(crate) const REASON_DISABLED: &str = "disabled";
pub(crate) const REASON_NO_SURFACE: &str = "noSurface";
pub(crate) const REASON_PAGE_NOT_READY: &str = "pageNotReady";

pub(crate) struct PolicyInputs<'a> {
    pub(crate) enabled: bool,
    pub(crate) wallpaper: &'a WallpaperConfig,
    pub(crate) manual_pause: bool,
    pub(crate) fullscreen: bool,
    pub(crate) session_unavailable: bool,
    pub(crate) display_off: bool,
    pub(crate) display_missing: bool,
    pub(crate) power: PowerState,
    pub(crate) has_surface: bool,
    pub(crate) page_ready: bool,
}

/// 桌面呈现的暂停原因 + 未就绪事实，顺序即设置页文案的拼接顺序。
pub(crate) fn pause_reasons(inputs: &PolicyInputs) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if !inputs.enabled {
        reasons.push(REASON_DISABLED);
    }
    if inputs.manual_pause {
        reasons.push(REASON_MANUAL_PAUSE);
    }
    if inputs.fullscreen && inputs.wallpaper.pause_on_fullscreen {
        reasons.push(REASON_FULLSCREEN);
    }
    if inputs.session_unavailable {
        reasons.push(REASON_SESSION_UNAVAILABLE);
    }
    if inputs.display_off {
        reasons.push(REASON_DISPLAY_OFF);
    }
    if inputs.display_missing {
        reasons.push(REASON_DISPLAY_MISSING);
    }
    if battery_pause(inputs) {
        reasons.push(REASON_BATTERY);
    }
    if inputs.enabled && !inputs.has_surface {
        reasons.push(REASON_NO_SURFACE);
    }
    if inputs.has_surface && !inputs.page_ready {
        reasons.push(REASON_PAGE_NOT_READY);
    }
    reasons
}

/// 桌面是否允许绘制：任意强制/软暂停原因存在即停绘。
/// 未就绪事实（noSurface/pageNotReady）由调用方按可见性语义另行处理。
pub(crate) fn renderable(inputs: &PolicyInputs) -> bool {
    !battery_pause(inputs)
        && !(inputs.manual_pause
            || (inputs.fullscreen && inputs.wallpaper.pause_on_fullscreen)
            || inputs.session_unavailable
            || inputs.display_off
            || inputs.display_missing)
}

fn battery_pause(inputs: &PolicyInputs) -> bool {
    // v4 只有 pause 一种电池策略；电源未知按停绘处理，宁可少画一帧。
    match (inputs.wallpaper.battery_policy, inputs.power) {
        (crate::config::BatteryPolicy::Pause, PowerState::Ac) => false,
        (crate::config::BatteryPolicy::Pause, _) => true,
    }
}

/// 预览投影（scope=previewOnly）：只继承电池、会话、息屏三类强制原因；
/// 目标屏全屏/缺失、手动暂停都不属于预览自己的暂停语义（设计 §13.4）。
pub(crate) fn preview_pause_reasons(
    wallpaper: &WallpaperConfig,
    session_unavailable: bool,
    display_off: bool,
    power: PowerState,
) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if session_unavailable {
        reasons.push(REASON_SESSION_UNAVAILABLE);
    }
    if display_off {
        reasons.push(REASON_DISPLAY_OFF);
    }
    if battery_pause(&PolicyInputs {
        enabled: true,
        wallpaper,
        manual_pause: false,
        fullscreen: false,
        session_unavailable: false,
        display_off: false,
        display_missing: false,
        power,
        has_surface: true,
        page_ready: true,
    }) {
        reasons.push(REASON_BATTERY);
    }
    reasons
}

/// 非对称去抖门。raw 抖动会重置计时；只有稳定跨越阈值才迁移并返回 Some(新稳定态)。
pub(crate) struct Debounce {
    stable: bool,
    raw: bool,
    since: Option<Instant>,
}

impl Debounce {
    pub(crate) fn new(initial: bool) -> Self {
        Self {
            stable: initial,
            raw: initial,
            since: None,
        }
    }

    pub(crate) fn stable(&self) -> bool {
        self.stable
    }

    pub(crate) fn update(&mut self, raw: bool, now: Instant) -> Option<bool> {
        if raw == self.stable {
            self.raw = raw;
            self.since = None;
            return None;
        }
        if raw != self.raw || self.since.is_none() {
            self.raw = raw;
            self.since = Some(now);
            return None;
        }
        let hold = if raw {
            FULLSCREEN_PAUSE_ENTER
        } else {
            FULLSCREEN_RESUME
        };
        let since = self.since?;
        if now.duration_since(since) >= hold {
            self.stable = raw;
            self.since = None;
            Some(raw)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::WallpaperConfig;

    fn inputs() -> PolicyInputs<'static> {
        PolicyInputs {
            enabled: true,
            wallpaper: Box::leak(Box::new(WallpaperConfig::default())),
            manual_pause: false,
            fullscreen: false,
            session_unavailable: false,
            display_off: false,
            display_missing: false,
            power: PowerState::Ac,
            has_surface: true,
            page_ready: true,
        }
    }

    #[test]
    fn healthy_desktop_has_no_reasons_and_is_renderable() {
        let inputs = inputs();
        assert!(pause_reasons(&inputs).is_empty());
        assert!(renderable(&inputs));
    }

    #[test]
    fn battery_pause_follows_power_state_and_unknown_stops_drawing() {
        let mut inputs = inputs();
        inputs.power = PowerState::Battery;
        assert!(pause_reasons(&inputs).contains(&REASON_BATTERY));
        assert!(!renderable(&inputs));
        // 启动状态未知先停绘（设计 §13.2）。
        inputs.power = PowerState::Unknown;
        assert!(pause_reasons(&inputs).contains(&REASON_BATTERY));
        assert!(!renderable(&inputs));
        inputs.power = PowerState::Ac;
        assert!(!pause_reasons(&inputs).contains(&REASON_BATTERY));
    }

    #[test]
    fn hard_and_soft_reasons_stack_and_block_rendering() {
        // C04：电池 + 锁屏叠加；接入电源只清电池原因。
        let mut inputs = inputs();
        inputs.power = PowerState::Battery;
        inputs.session_unavailable = true;
        let reasons = pause_reasons(&inputs);
        assert!(reasons.contains(&REASON_BATTERY) && reasons.contains(&REASON_SESSION_UNAVAILABLE));
        assert!(!renderable(&inputs));
        inputs.power = PowerState::Ac;
        assert!(pause_reasons(&inputs).contains(&REASON_SESSION_UNAVAILABLE));
        assert!(!renderable(&inputs));
        inputs.session_unavailable = false;
        assert!(renderable(&inputs));
    }

    #[test]
    fn manual_pause_is_not_cleared_by_environment_recovery() {
        let mut inputs = inputs();
        inputs.manual_pause = true;
        inputs.display_off = true;
        assert!(!renderable(&inputs));
        inputs.display_off = false;
        assert!(!renderable(&inputs));
        assert!(pause_reasons(&inputs) == vec![REASON_MANUAL_PAUSE]);
    }

    #[test]
    fn readiness_facts_are_reported_but_not_policy_pauses() {
        let mut inputs = inputs();
        inputs.enabled = false;
        inputs.has_surface = false;
        let reasons = pause_reasons(&inputs);
        assert_eq!(reasons, vec![REASON_DISABLED]);
        assert!(renderable(&inputs));
        inputs.enabled = true;
        let reasons = pause_reasons(&inputs);
        assert_eq!(reasons, vec![REASON_NO_SURFACE]);
        assert!(renderable(&inputs));
    }

    #[test]
    fn preview_scope_only_inherits_battery_session_and_display_off() {
        let wallpaper = WallpaperConfig::default();
        assert!(preview_pause_reasons(&wallpaper, false, false, PowerState::Ac).is_empty());
        let reasons = preview_pause_reasons(&wallpaper, true, true, PowerState::Battery);
        assert_eq!(
            reasons,
            vec![
                REASON_SESSION_UNAVAILABLE,
                REASON_DISPLAY_OFF,
                REASON_BATTERY
            ]
        );
        // 全屏与目标缺失不进入预览投影。
        let reasons = preview_pause_reasons(&wallpaper, false, false, PowerState::Ac);
        assert!(!reasons.contains(&REASON_FULLSCREEN));
        assert!(!reasons.contains(&REASON_DISPLAY_MISSING));
    }

    #[test]
    fn debounce_enters_slow_and_recovers_fast() {
        let mut gate = Debounce::new(false);
        let t0 = Instant::now();
        // 抖动重置计时。
        assert_eq!(gate.update(true, t0), None);
        assert_eq!(gate.update(false, t0 + Duration::from_millis(100)), None);
        assert_eq!(gate.update(true, t0 + Duration::from_millis(200)), None);
        assert_eq!(gate.update(true, t0 + Duration::from_millis(700)), None);
        assert_eq!(
            gate.update(true, t0 + Duration::from_millis(950)),
            Some(true)
        );
        assert!(gate.stable());
        // 恢复快：150 ms 即回落。
        assert_eq!(gate.update(false, t0 + Duration::from_millis(1000)), None);
        assert_eq!(
            gate.update(false, t0 + Duration::from_millis(1151)),
            Some(false)
        );
        assert!(!gate.stable());
    }

    #[test]
    fn debounce_constants_match_design_values() {
        assert_eq!(FULLSCREEN_PAUSE_ENTER, Duration::from_millis(750));
        assert_eq!(FULLSCREEN_RESUME, Duration::from_millis(150));
        assert_eq!(DISPLAY_MISSING_HITS, 3);
        assert_eq!(TOPOLOGY_INTERVAL, Duration::from_millis(250));
    }
}
