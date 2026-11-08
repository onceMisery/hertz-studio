// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸暂停策略：暂停原因集合是唯一的绘制许可真值表（设计 §13.2/§13.3）。
//!
//! 每个原因独立增删并带 scope：桌面呈现（desktop）与实时预览（preview）分别
//! 消费自己的原因投影。解除某一处的原因不能清空另一处的暂停——用户手动暂停
//! 不会被解锁/唤醒自动恢复，预览暂停也不会误停桌面。
//!
//! 强制原因：sessionUnavailable、displayOff、displayMissing、battery；
//! 软原因：manualPause、fullscreen、maximized、applicationRule。
//! hidden 是独立的可见性事实，不计入暂停。
//! 电池策略默认 pause；电源状态未知按「先停绘」处理（设计 §13.2）。

use std::time::{Duration, Instant};

use super::config::{normalize_executable_path, RuleAction};
use crate::config::WallpaperConfig;
use crate::native::PowerState;

/// 非对称去抖（设计 §13.2）：全屏进入 300 ms；普通最大化/应用规则进入
/// 750 ms 以容忍切换窗口；所有窗口策略退出 150 ms。
pub(crate) const FULLSCREEN_PAUSE_ENTER: Duration = Duration::from_millis(300);
pub(crate) const FULLSCREEN_RESUME: Duration = Duration::from_millis(150);
pub(crate) const WINDOW_POLICY_ENTER: Duration = Duration::from_millis(750);
/// 目标屏从非空拓扑中消失的判定宽限：连续 3 次未命中（约 750 ms @250 ms 巡检）。
pub(crate) const DISPLAY_MISSING_HITS: u8 = 3;
/// 拓扑/全屏巡检节奏。空拓扑宽限期间不销毁会话、不累计目标缺失。
pub(crate) const TOPOLOGY_INTERVAL: Duration = Duration::from_millis(250);

/// 暂停原因名单；`&'static str` 直接进诊断 JSON，改名会破坏设置页文案映射。
pub(crate) const REASON_MANUAL_PAUSE: &str = "manualPause";
pub(crate) const REASON_FULLSCREEN: &str = "fullscreen";
pub(crate) const REASON_MAXIMIZED: &str = "maximized";
pub(crate) const REASON_APPLICATION_RULE: &str = "applicationRule";
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
    pub(crate) maximized: bool,
    pub(crate) application_rule: Option<RuleAction>,
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
    if inputs.maximized && inputs.wallpaper.pause_on_maximized {
        reasons.push(REASON_MAXIMIZED);
    }
    if inputs.application_rule.is_some() {
        reasons.push(REASON_APPLICATION_RULE);
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
            || (inputs.maximized && inputs.wallpaper.pause_on_maximized)
            || inputs.application_rule.is_some()
            || inputs.session_unavailable
            || inputs.display_off
            || inputs.display_missing)
}

/// 软窗口暂停冻结已提交的画面；手动/强制原因或 stop 必须撤下画面。
/// 是否已有可保留首帧仍由 surface/handoff 的所有者决定。
pub(crate) fn retain_frame(inputs: &PolicyInputs) -> bool {
    inputs.enabled
        && !inputs.manual_pause
        && !inputs.session_unavailable
        && !inputs.display_off
        && !inputs.display_missing
        && !battery_pause(inputs)
        && inputs.application_rule != Some(RuleAction::Stop)
}

/// 仅按规范化完整路径匹配：同名应用的其它目录、标题及后台进程都不参与。
/// 查询失败为 None，配置中仍保留该规则以便应用下次进入前台时继续匹配。
pub(crate) fn application_rule(
    wallpaper: &WallpaperConfig,
    executable: Option<&str>,
) -> Option<RuleAction> {
    let executable = normalize_executable_path(executable?).ok()?;
    wallpaper
        .application_rules
        .iter()
        .find(|rule| rule.executable == executable)
        .map(|rule| rule.action)
}

fn battery_pause(inputs: &PolicyInputs) -> bool {
    // v4 只有 pause 一种电池策略；电源未知按停绘处理，宁可少画一帧。
    match (inputs.wallpaper.battery_policy, inputs.power) {
        (crate::config::BatteryPolicy::Pause, PowerState::Ac) => false,
        (crate::config::BatteryPolicy::Pause, _) => true,
    }
}

/// 预览投影（scope=previewOnly）：只继承电池、会话、息屏三类强制原因；
/// 目标屏窗口策略/缺失、手动暂停都不属于预览自己的暂停语义（设计 §13.4）。
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
        maximized: false,
        application_rule: None,
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
    enter: Duration,
}

impl Debounce {
    pub(crate) fn new(initial: bool) -> Self {
        Self {
            stable: initial,
            raw: initial,
            since: None,
            enter: FULLSCREEN_PAUSE_ENTER,
        }
    }

    pub(crate) fn window_policy(initial: bool) -> Self {
        Self {
            enter: WINDOW_POLICY_ENTER,
            ..Self::new(initial)
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
        let hold = if raw { self.enter } else { FULLSCREEN_RESUME };
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

/// 应用规则保留完整稳定动作，不把 pause→stop 拆成两个独立布尔门。
/// 新动作稳定前沿用旧动作，因此切换应用或修改规则不会中途恢复绘制。
pub(crate) struct ApplicationRuleGate {
    stable: Option<RuleAction>,
    raw: Option<RuleAction>,
    since: Option<Instant>,
}

impl ApplicationRuleGate {
    pub(crate) fn new(initial: Option<RuleAction>) -> Self {
        Self {
            stable: initial,
            raw: initial,
            since: None,
        }
    }

    pub(crate) fn stable(&self) -> Option<RuleAction> {
        self.stable
    }

    /// 外层 None 表示没有迁移；Some(None) 表示应用规则已退出。
    pub(crate) fn update(
        &mut self,
        raw: Option<RuleAction>,
        now: Instant,
    ) -> Option<Option<RuleAction>> {
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
        let hold = if raw.is_some() {
            WINDOW_POLICY_ENTER
        } else {
            FULLSCREEN_RESUME
        };
        if now.duration_since(self.since?) < hold {
            return None;
        }
        self.stable = raw;
        self.since = None;
        Some(raw)
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
            maximized: false,
            application_rule: None,
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
    fn window_pause_reasons_stack_and_clear_independently() {
        let wallpaper = WallpaperConfig {
            pause_on_maximized: true,
            ..Default::default()
        };
        let mut inputs = inputs();
        inputs.wallpaper = &wallpaper;
        inputs.manual_pause = true;
        inputs.fullscreen = true;
        inputs.maximized = true;
        inputs.application_rule = Some(RuleAction::Pause);
        assert_eq!(
            pause_reasons(&inputs),
            vec![
                REASON_MANUAL_PAUSE,
                REASON_FULLSCREEN,
                REASON_MAXIMIZED,
                REASON_APPLICATION_RULE
            ]
        );
        assert!(!renderable(&inputs));
        inputs.fullscreen = false;
        inputs.application_rule = None;
        assert_eq!(
            pause_reasons(&inputs),
            vec![REASON_MANUAL_PAUSE, REASON_MAXIMIZED]
        );
        assert!(!renderable(&inputs));
        inputs.maximized = false;
        assert_eq!(pause_reasons(&inputs), vec![REASON_MANUAL_PAUSE]);
        inputs.manual_pause = false;
        assert!(renderable(&inputs));
    }

    #[test]
    fn maximize_switch_does_not_disable_other_window_rules() {
        let wallpaper = WallpaperConfig {
            pause_on_fullscreen: false,
            pause_on_maximized: false,
            ..Default::default()
        };
        let maximize_wallpaper = WallpaperConfig {
            pause_on_maximized: true,
            ..wallpaper.clone()
        };
        let mut inputs = inputs();
        inputs.wallpaper = &wallpaper;
        inputs.fullscreen = true;
        inputs.maximized = true;
        assert!(pause_reasons(&inputs).is_empty());
        assert!(renderable(&inputs));
        for action in [RuleAction::Pause, RuleAction::Stop] {
            inputs.application_rule = Some(action);
            assert_eq!(pause_reasons(&inputs), vec![REASON_APPLICATION_RULE]);
            assert!(!renderable(&inputs));
        }
        inputs.application_rule = None;
        inputs.wallpaper = &maximize_wallpaper;
        assert_eq!(pause_reasons(&inputs), vec![REASON_MAXIMIZED]);
        assert!(!renderable(&inputs));
    }

    #[test]
    fn soft_pauses_keep_frame_but_stacked_hard_manual_and_stop_reasons_hide_it() {
        let wallpaper = WallpaperConfig {
            pause_on_maximized: true,
            ..Default::default()
        };
        let mut inputs = inputs();
        inputs.wallpaper = &wallpaper;
        inputs.fullscreen = true;
        inputs.maximized = true;
        inputs.application_rule = Some(RuleAction::Pause);
        assert!(!renderable(&inputs));
        assert!(retain_frame(&inputs));
        inputs.manual_pause = true;
        assert!(!retain_frame(&inputs));
        inputs.manual_pause = false;
        inputs.session_unavailable = true;
        assert!(!retain_frame(&inputs));
        inputs.session_unavailable = false;
        inputs.display_off = true;
        assert!(!retain_frame(&inputs));
        inputs.display_off = false;
        inputs.display_missing = true;
        assert!(!retain_frame(&inputs));
        inputs.display_missing = false;
        for power in [PowerState::Battery, PowerState::Unknown] {
            inputs.power = power;
            assert!(!retain_frame(&inputs));
        }
        inputs.power = PowerState::Ac;
        inputs.enabled = false;
        assert!(!retain_frame(&inputs));
        inputs.enabled = true;
        inputs.application_rule = Some(RuleAction::Stop);
        assert!(!retain_frame(&inputs));
        inputs.application_rule = Some(RuleAction::Pause);
        assert!(retain_frame(&inputs));
    }

    #[test]
    fn application_match_uses_full_path_not_filename_or_prefix() {
        use super::super::config::ApplicationRule;
        let mut wallpaper = WallpaperConfig {
            application_rules: vec![
                ApplicationRule {
                    executable: r"C:/Apps/Player.exe".into(),
                    action: RuleAction::Pause,
                },
                ApplicationRule {
                    executable: r"D:/Games/Player.exe".into(),
                    action: RuleAction::Stop,
                },
            ],
            ..Default::default()
        };
        wallpaper.normalize().unwrap();
        assert_eq!(
            application_rule(&wallpaper, Some(r"\\?\C:\APPS\player.exe")),
            Some(RuleAction::Pause)
        );
        assert_eq!(
            application_rule(&wallpaper, Some(r"D:\Games\Player.exe")),
            Some(RuleAction::Stop)
        );
        for path in [
            r"C:\Other\Player.exe",
            r"C:\Apps\Player.exe.old",
            r"Player.exe",
            r"C:\Apps\Player.exe --fullscreen",
        ] {
            assert_eq!(application_rule(&wallpaper, Some(path)), None);
        }
        assert_eq!(application_rule(&wallpaper, None), None);
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
        let wallpaper = WallpaperConfig {
            pause_on_fullscreen: true,
            pause_on_maximized: true,
            application_rules: vec![super::super::config::ApplicationRule {
                executable: r"c:\apps\player.exe".into(),
                action: RuleAction::Stop,
            }],
            ..Default::default()
        };
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
        assert!(!reasons.contains(&REASON_MAXIMIZED));
        assert!(!reasons.contains(&REASON_APPLICATION_RULE));
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
        assert_eq!(gate.update(true, t0 + Duration::from_millis(499)), None);
        assert_eq!(
            gate.update(true, t0 + Duration::from_millis(500)),
            Some(true)
        );
        assert!(gate.stable());
        // 恢复快：150 ms 即回落。
        assert_eq!(gate.update(false, t0 + Duration::from_millis(1000)), None);
        assert_eq!(gate.update(false, t0 + Duration::from_millis(1149)), None);
        assert_eq!(
            gate.update(false, t0 + Duration::from_millis(1150)),
            Some(false)
        );
        assert!(!gate.stable());
    }

    #[test]
    fn maximize_debounce_has_750ms_enter_and_150ms_exit_boundaries() {
        let mut gate = Debounce::window_policy(false);
        let t0 = Instant::now();
        assert_eq!(gate.update(true, t0), None);
        assert_eq!(gate.update(true, t0 + Duration::from_millis(749)), None);
        assert!(!gate.stable());
        assert_eq!(
            gate.update(true, t0 + Duration::from_millis(750)),
            Some(true)
        );
        assert_eq!(gate.update(false, t0 + Duration::from_millis(800)), None);
        assert_eq!(gate.update(false, t0 + Duration::from_millis(949)), None);
        assert_eq!(
            gate.update(false, t0 + Duration::from_millis(950)),
            Some(false)
        );
    }

    #[test]
    fn application_gate_changes_action_without_transient_resume_and_resets_jitter() {
        let t0 = Instant::now();
        let mut gate = ApplicationRuleGate::new(None);
        assert_eq!(gate.update(Some(RuleAction::Pause), t0), None);
        assert_eq!(
            gate.update(Some(RuleAction::Pause), t0 + Duration::from_millis(749)),
            None
        );
        assert_eq!(gate.stable(), None);
        assert_eq!(
            gate.update(Some(RuleAction::Pause), t0 + Duration::from_millis(750)),
            Some(Some(RuleAction::Pause))
        );
        assert_eq!(
            gate.update(Some(RuleAction::Stop), t0 + Duration::from_millis(800)),
            None
        );
        assert_eq!(
            gate.update(Some(RuleAction::Stop), t0 + Duration::from_millis(1549)),
            None
        );
        assert_eq!(gate.stable(), Some(RuleAction::Pause));
        assert_eq!(
            gate.update(Some(RuleAction::Stop), t0 + Duration::from_millis(1550)),
            Some(Some(RuleAction::Stop))
        );
        assert_eq!(gate.update(None, t0 + Duration::from_millis(1600)), None);
        assert_eq!(gate.update(None, t0 + Duration::from_millis(1749)), None);
        assert_eq!(gate.stable(), Some(RuleAction::Stop));
        // 返回旧动作取消退出计时，不因短暂无前台窗口恢复。
        assert_eq!(
            gate.update(Some(RuleAction::Stop), t0 + Duration::from_millis(1750)),
            None
        );
        assert_eq!(gate.update(None, t0 + Duration::from_millis(1800)), None);
        assert_eq!(gate.update(None, t0 + Duration::from_millis(1949)), None);
        assert_eq!(
            gate.update(None, t0 + Duration::from_millis(1950)),
            Some(None)
        );
        assert_eq!(gate.stable(), None);
    }

    #[test]
    fn application_gate_retains_stop_during_pause_replacement() {
        let t0 = Instant::now();
        let mut gate = ApplicationRuleGate::new(Some(RuleAction::Stop));
        assert_eq!(gate.update(Some(RuleAction::Pause), t0), None);
        assert_eq!(
            gate.update(Some(RuleAction::Pause), t0 + Duration::from_millis(749)),
            None
        );
        assert_eq!(gate.stable(), Some(RuleAction::Stop));
        assert_eq!(
            gate.update(Some(RuleAction::Pause), t0 + Duration::from_millis(750)),
            Some(Some(RuleAction::Pause))
        );
        assert_eq!(gate.stable(), Some(RuleAction::Pause));
    }

    #[test]
    fn debounce_constants_match_design_values() {
        assert_eq!(FULLSCREEN_PAUSE_ENTER, Duration::from_millis(300));
        assert_eq!(FULLSCREEN_RESUME, Duration::from_millis(150));
        assert_eq!(WINDOW_POLICY_ENTER, Duration::from_millis(750));
        assert_eq!(DISPLAY_MISSING_HITS, 3);
        assert_eq!(TOPOLOGY_INTERVAL, Duration::from_millis(250));
    }
}
