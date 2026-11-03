// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 小窗播放（桌面宠物）surface：状态机与几何。
//!
//! 与桌面歌词、壁纸并列的第三个 surface：共用同一份 profile、同一个只读来源
//! 和同一条事件循环，但窗口形态、输入语义与持久化字段各自独立。
//!
//! 这里只放「状态该怎么变」和「窗口该落在哪」两件事——两者都是纯数据，可以
//! 在 Windows 之外单测。真正碰 HWND 的动作在 `mini_native`，碰网络的在
//! `mini_feed`，拼装窗口的在 `app`。

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::config::Profile;
use crate::mini_native;
use crate::native;

/// 触发小窗的原因。只用于日志与「能不能自动收回去」的判断，不参与几何。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EnterReason {
    /// 用户点了主界面的小窗按钮。
    User,
    /// 主窗口隐藏（最小化 / 切走）后自动接管。
    MainHidden,
    /// 上次退出时小窗还开着，这次开机恢复。
    Restored,
}

impl EnterReason {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::MainHidden => "main-hidden",
            Self::Restored => "restored",
        }
    }
}

/// 小窗的五个相位。可见性、输入语义、几何记忆方式在每个相位都不同，
/// 所以相位就是唯一权威——不要另立一个 `visible` 布尔去描述它。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MiniPhase {
    /// 窗口不存在或已隐藏。主窗口在前台时的常态。
    Hidden,
    /// 自由悬浮：位置记进 `x` / `y`（物理像素）。
    Floating,
    /// 拖拽中。位置每帧都在变，此时不落盘，等松手再记。
    Dragging,
    /// 贴边：位置由 `dock` + `along` 推导，不再单独记坐标。
    Docked,
    /// 贴边隐藏：整窗滑出屏幕，只留 `PEEK_STRIP` 的触发条，鼠标靠近才回来。
    Peeking,
}

/// 吸附到工作区的哪条边。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DockEdge {
    #[default]
    None,
    Left,
    Right,
    Top,
    Bottom,
}

impl DockEdge {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Left => "left",
            Self::Right => "right",
            Self::Top => "top",
            Self::Bottom => "bottom",
        }
    }

    /// 沿边推进的主轴是横的还是竖的。Left/Right 沿竖直方向走，Top/Bottom 沿水平。
    fn horizontal(self) -> bool {
        matches!(self, Self::Top | Self::Bottom)
    }
}

/// 落盘的几何。物理坐标只在 `DockEdge::None` 时有效——贴边之后显示器随时可能
/// 换分辨率，记坐标会漂，只记「哪条边 + 沿边的比例」才稳。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct MiniGeometry {
    /// 目标显示器名；None 表示跟随主显示器。
    pub(crate) monitor: Option<String>,
    pub(crate) dock: DockEdge,
    /// 沿边位置：0 = 靠上/靠左，1 = 靠下/靠右。
    pub(crate) along: f64,
    /// 自由悬浮时的窗口左上角（物理像素）。
    pub(crate) x: i32,
    pub(crate) y: i32,
    /// 逻辑尺寸（DIP）。物理像素 = 逻辑 × dpi/96。
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl Default for MiniGeometry {
    fn default() -> Self {
        Self {
            monitor: None,
            dock: DockEdge::None,
            along: 0.5,
            x: 120,
            y: 120,
            width: 268.0,
            height: 56.0,
        }
    }
}

/// 吸附判定与落位的阈值（物理像素）。
pub(crate) const SNAP_THRESHOLD: i32 = 28;
/// 贴边隐藏后留在屏幕上的触发条宽度（物理像素）。
pub(crate) const PEEK_STRIP: i32 = 3;
/// 贴边隐藏的进入延迟：刚松手不要立刻缩回去，否则拖完就闪。
pub(crate) const PEEK_DELAY: Duration = Duration::from_millis(1200);
/// 宠物收起态的默认逻辑尺寸（页面上报 skin.size 之前的先验值）。
pub(crate) const PET_DEFAULT_SIZE: (f64, f64) = (56.0, 56.0);
/// 宠物素材逻辑尺寸的限幅：再小看不见、再大就成了第二块壁纸。
pub(crate) const PET_SIZE_RANGE: (f64, f64) = (48.0, 160.0);

/// 小窗的运行时状态机。窗口句柄不在这里——相位与几何可以在无窗口时推进，
/// 这样单测不需要真的开窗口。
pub(crate) struct MiniHost {
    /// 来源身份。当前接线里窗口只认一份 profile，字段留给多来源共存时区分。
    #[allow(dead_code)]
    pub(crate) profile: Profile,
    pub(crate) phase: MiniPhase,
    enter_reason: Option<EnterReason>,
    pub(crate) geometry: MiniGeometry,
    /// 桌面宠物态：透明区域不吃鼠标（区域级穿透）。
    pub(crate) pet: bool,
    /// 整体鼠标穿透（锁定）。与 `pet` 是两层：`pet` 管「透明的地方点不到」，
    /// `locked` 管「整个窗都点不到」，后者才等价于桌面歌词的锁定。
    pub(crate) locked: bool,
    pub(crate) always_on_top: bool,
    /// 主窗口隐藏后自动接管。默认关，见模块尾注。
    pub(crate) auto_on_main_hidden: bool,
    /// 上一次松手/落位的时间，用于 PEEK_DELAY。
    pub(crate) settled_at: Option<Instant>,
    /// 当前窗口矩形（物理像素）。拖拽期间由 native 侧回填。
    pub(crate) rect: Option<(i32, i32, i32, i32)>,
    /// 页面上报的命中区（逻辑像素）。宠物态判定用。
    pub(crate) hit_regions: Vec<(f64, f64, f64, f64)>,
    /// 宠物态素材的逻辑尺寸（页面按生效皮肤上报）。None = 用默认 56×56。
    /// 只影响宠物收起态的窗口形状，不落盘——素材换了下次启动自然变。
    pub(crate) pet_size: Option<(f64, f64)>,
    /// 宠物态悬停展开：窗口临时回到胶囊尺寸，露出曲名与传输键。
    /// 由页面的 hover 事件驱动，Peeking/Hidden 下不生效。
    pub(crate) pet_hover: bool,
    pub(crate) scale: f64,
}

/// 状态机的输入。每个都是「用户/系统做了什么」，不是「把状态设成什么」。
pub(crate) enum MiniEvent {
    Enter(EnterReason),
    /// 请求回到主窗口；恢复成功前保留小窗。
    Restore,
    RestoreComplete,
    /// 主窗口重新可见；只有 MainHidden 进来的小窗会自动退。
    MainVisible,
    DragBegin,
    DragEnd,
    /// 显示器拓扑变化 / 分辨率变化：贴边的窗要重新落位。
    DisplayChanged,
    /// 进程退出。
    Quit,
}

/// 状态机对外要做的动作。返回给 app 去执行，mini 自己不碰窗口——
/// 这样相位推进和副作用可以分开测。
pub(crate) enum MiniAction {
    /// 需要创建窗口并渲染。
    Show,
    /// 需要隐藏窗口。
    Hide,
    /// 几何变了，按当前相位重新落位。
    Place,
    /// 需要把 pet / locked / 置顶 应用到 HWND。
    ApplyWindowStyle,
    /// 请 app 通知服务端「用户要回主窗口」。
    NotifyRestore,
    None,
}

impl MiniHost {
    pub(crate) fn new(profile: Profile) -> Self {
        Self {
            profile,
            phase: MiniPhase::Hidden,
            enter_reason: None,
            geometry: MiniGeometry::default(),
            pet: true,
            locked: false,
            always_on_top: true,
            auto_on_main_hidden: false,
            settled_at: None,
            rect: None,
            hit_regions: Vec::new(),
            pet_size: None,
            pet_hover: false,
            scale: 1.0,
        }
    }

    /// 唯一的相位推进入口。非法迁移不 panic，只记日志并保持现状——
    /// 小窗是「主界面的逃生口」，卡住比崩掉好。
    pub(crate) fn handle(&mut self, event: MiniEvent) -> MiniAction {
        match event {
            MiniEvent::Enter(reason) => {
                if reason == EnterReason::MainHidden && !self.auto_on_main_hidden {
                    return MiniAction::None;
                }
                // 手动接管可以升级自动弹出的窗口；自动事件不能覆盖用户意图。
                if self.enter_reason.is_none() || reason != EnterReason::MainHidden {
                    self.enter_reason = Some(reason);
                }
                crate::app::log(&format!("mini enter reason={}", reason.label()));
                match self.phase {
                    MiniPhase::Hidden => {}
                    MiniPhase::Peeking => {}
                    // 已经在小窗里了：不重复创建，只把贴边隐藏的窗叫回来。
                    MiniPhase::Floating | MiniPhase::Docked | MiniPhase::Dragging => {
                        if self.phase == MiniPhase::Docked {
                            self.settled_at = Some(Instant::now());
                        }
                        return MiniAction::Place;
                    }
                }
                self.phase = if self.geometry.dock == DockEdge::None {
                    MiniPhase::Floating
                } else {
                    MiniPhase::Docked
                };
                self.settled_at = Some(Instant::now());
                MiniAction::Show
            }
            MiniEvent::Restore => {
                if self.phase == MiniPhase::Hidden {
                    return MiniAction::None;
                }
                crate::app::log("mini restore");
                MiniAction::NotifyRestore
            }
            MiniEvent::RestoreComplete => {
                self.phase = MiniPhase::Hidden;
                self.enter_reason = None;
                self.settled_at = None;
                MiniAction::Hide
            }
            MiniEvent::MainVisible => {
                // 只对「因为主窗口隐藏而接管」的那次生效；用户手动开的小窗不该
                // 被主窗口的一次 Alt-Tab 收掉。
                if self.phase == MiniPhase::Hidden
                    || self.enter_reason != Some(EnterReason::MainHidden)
                {
                    return MiniAction::None;
                }
                crate::app::log("mini auto-restore on main visible");
                self.phase = MiniPhase::Hidden;
                self.enter_reason = None;
                MiniAction::Hide
            }
            MiniEvent::DragBegin => match self.phase {
                MiniPhase::Floating | MiniPhase::Docked | MiniPhase::Peeking => {
                    self.phase = MiniPhase::Dragging;
                    // 从贴边隐藏里拖出来时先恢复成完整窗口，否则拖的是一条 3px。
                    MiniAction::Place
                }
                // 已经在拖：忽略重复按下。
                MiniPhase::Dragging => MiniAction::None,
                MiniPhase::Hidden => MiniAction::None,
            },
            MiniEvent::DragEnd => {
                if self.phase != MiniPhase::Dragging {
                    return MiniAction::None;
                }
                let Some((x, y, width, height)) = self.rect else {
                    self.phase = MiniPhase::Floating;
                    return MiniAction::Place;
                };
                let target = self.target_area();
                let snapped = target.and_then(|area| snap_target(x, y, width, height, &area));
                match snapped {
                    Some(target) => {
                        self.geometry.dock = target.edge;
                        self.geometry.along = target.along;
                        self.phase = MiniPhase::Docked;
                    }
                    None => {
                        self.geometry.dock = DockEdge::None;
                        self.geometry.x = x;
                        self.geometry.y = y;
                        self.phase = MiniPhase::Floating;
                    }
                }
                self.settled_at = Some(Instant::now());
                crate::app::log(&format!(
                    "mini drop dock={} along={:.3}",
                    self.geometry.dock.label(),
                    self.geometry.along
                ));
                MiniAction::Place
            }
            MiniEvent::DisplayChanged => {
                if self.phase == MiniPhase::Hidden {
                    return MiniAction::None;
                }
                // 显示器没了不要硬留在屏外：退回主显示器并解除贴边。
                if self.geometry.dock != DockEdge::None
                    && self.geometry.monitor.as_deref().is_some()
                    && !self.monitor_available()
                {
                    crate::app::log("mini dock monitor gone; falling back to floating");
                    self.geometry.monitor = None;
                    self.geometry.dock = DockEdge::None;
                    self.phase = MiniPhase::Floating;
                }
                MiniAction::Place
            }
            MiniEvent::Quit => {
                self.phase = MiniPhase::Hidden;
                self.enter_reason = None;
                MiniAction::Hide
            }
        }
    }

    /// 贴边隐藏的推进。由 app 的低频 tick 调用：相位是 Docked、开了自动隐藏、
    /// 且已经静止超过 PEEK_DELAY 才滑出去。
    pub(crate) fn tick_peek(&mut self, edge_hide: bool, cursor_inside: bool) -> MiniAction {
        match self.phase {
            MiniPhase::Docked => {
                if !edge_hide || cursor_inside {
                    return MiniAction::None;
                }
                let settled = self.settled_at.is_some_and(|at| at.elapsed() >= PEEK_DELAY);
                if !settled {
                    return MiniAction::None;
                }
                crate::app::log("mini peek in");
                self.phase = MiniPhase::Peeking;
                MiniAction::Place
            }
            MiniPhase::Peeking => {
                // 鼠标碰到残条就回来；关掉自动隐藏也要立刻回来。
                if cursor_inside || !edge_hide {
                    self.phase = MiniPhase::Docked;
                    self.settled_at = Some(Instant::now());
                    return MiniAction::Place;
                }
                MiniAction::None
            }
            _ => MiniAction::None,
        }
    }

    fn monitor_available(&self) -> bool {
        let Some(name) = self.geometry.monitor.as_deref() else {
            return true;
        };
        native::monitors().iter().any(|area| area.name == name)
    }

    pub(crate) fn target_area(&self) -> Option<native::WorkArea> {
        match self.geometry.monitor.as_deref() {
            Some(name) => native::work_area_by_name(name),
            None => native::primary_work_area(),
        }
    }

    /// 按当前相位算出窗口该落的物理矩形。返回 None 表示这台机器连一块工作区
    /// 都拿不到（远程桌面 / 锁屏），此时不要动窗口。
    pub(crate) fn desired_rect(&self, dpi: u32) -> Option<(i32, i32, i32, i32)> {
        let area = self.target_area()?;
        let scale = f64::from(dpi.max(1)) / 96.0 * self.scale;
        // 宠物收起态用素材尺寸：宠物就是一小块形象，不是一条压扁的胶囊。
        // 悬停展开（pet_hover）临时回到胶囊尺寸——窗口只会比收起时更大，
        // 贴边吸附下向屏幕内生长，不会跑到屏外。
        let (base_width, base_height) = match self.pet && !self.pet_hover {
            true => {
                let (w, h) = self.pet_size.unwrap_or(PET_DEFAULT_SIZE);
                (
                    w.clamp(PET_SIZE_RANGE.0, PET_SIZE_RANGE.1),
                    h.clamp(PET_SIZE_RANGE.0, PET_SIZE_RANGE.1),
                )
            }
            false => (self.geometry.width, self.geometry.height),
        };
        let width = (base_width * scale).round().max(1.0) as i32;
        let height = (base_height * scale).round().max(1.0) as i32;
        let width = width.min(area.width().max(1));
        let height = height.min(area.height().max(1));
        let (x, y) = match self.geometry.dock {
            DockEdge::None => (self.geometry.x, self.geometry.y),
            edge => dock_position(edge, self.geometry.along, width, height, &area),
        };
        // 贴边隐藏：把窗整体推出工作区，只留触发条。Docked 与 Peeking 用同一套
        // dock/along，差的就是这一步偏移，来回切换不会漂。
        let (x, y) = if self.phase == MiniPhase::Peeking {
            peek_offset(x, y, width, height, self.geometry.dock, &area)
        } else {
            (x, y)
        };
        Some((x, y, width, height))
    }

    /// 页面上报的命中区（逻辑像素）。宠物态下 WM_NCHITTEST 只认这些矩形。
    pub(crate) fn set_hit_regions(&mut self, regions: Vec<(f64, f64, f64, f64)>) {
        self.hit_regions = regions;
    }

    /// 页面上报的宠物素材尺寸（逻辑像素）。值不合法就忽略，保留现值。
    pub(crate) fn set_pet_size(&mut self, width: f64, height: f64) -> bool {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return false;
        }
        let next = (width, height);
        if self.pet_size == Some(next) {
            return false;
        }
        self.pet_size = Some(next);
        true
    }

    /// 宠物态判定：点是否落在页面上报的实心区域里（物理像素入参）。
    /// 与 mini_native 的 wndproc 判定同语义；留在状态机侧供单测与未来复用。
    #[allow(dead_code)]
    pub(crate) fn hit_solid(&self, px: i32, py: i32, dpi: u32) -> bool {
        let scale = f64::from(dpi.max(1)) / 96.0;
        let Some((left, top, _, _)) = self.rect else {
            return true;
        };
        let lx = f64::from(px - left) / scale;
        let ly = f64::from(py - top) / scale;
        // 还没收到命中区上报时按「整块可点」处理，避免首帧点不动。
        if self.hit_regions.is_empty() {
            return true;
        }
        self.hit_regions
            .iter()
            .any(|(x, y, w, h)| lx >= *x && lx <= x + w && ly >= *y && ly <= y + h)
    }

    /// 把窗口样式一次性推给 native。两处都调用同一个入口，避免出现
    /// 「置顶改了但穿透没改」这种半套状态。
    pub(crate) fn push_window_style(&self, hwnd: isize) {
        // 注册表与 Win32 调用都按 HWND（裸指针）走；app 侧为省事传 isize。
        let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
        mini_native::set_pet_mode(hwnd, self.pet && !self.locked);
        mini_native::set_locked(hwnd, self.locked);
        mini_native::set_topmost(hwnd, self.always_on_top);
    }
}

/// 吸附判定：窗口任意一条边离工作区对应边足够近就吸附。
/// 同时靠近两条边时取更近的那条——角落不单独做「贴角」，那会让沿边比例在
/// 两个轴之间跳。
pub(crate) fn snap_target(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    area: &native::WorkArea,
) -> Option<DockTarget> {
    let left = (x - area.left).abs();
    let right = (area.right - (x + width)).abs();
    let top = (y - area.top).abs();
    let bottom = (area.bottom - (y + height)).abs();
    let mut best: Option<(i32, DockEdge)> = None;
    for (distance, edge) in [
        (left, DockEdge::Left),
        (right, DockEdge::Right),
        (top, DockEdge::Top),
        (bottom, DockEdge::Bottom),
    ] {
        if distance > SNAP_THRESHOLD {
            continue;
        }
        if best.is_none() || distance < best.unwrap().0 {
            best = Some((distance, edge));
        }
    }
    let (_, edge) = best?;
    Some(DockTarget {
        edge,
        along: along_for(edge, x, y, width, height, area),
    })
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DockTarget {
    pub(crate) edge: DockEdge,
    pub(crate) along: f64,
}

/// 沿边比例：把窗口左上角在主轴上的位置折算成 0..1。与 `dock_position`
/// 互为反函数（两者都按左上角算），沿边拖动落盘再还原不会漂。
fn along_for(
    edge: DockEdge,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    area: &native::WorkArea,
) -> f64 {
    let span = if edge.horizontal() {
        area.width() - width
    } else {
        area.height() - height
    };
    if span <= 0 {
        return 0.5;
    }
    let offset = if edge.horizontal() {
        x - area.left
    } else {
        y - area.top
    };
    (f64::from(offset) / f64::from(span)).clamp(0.0, 1.0)
}

/// 由「边 + 沿边比例」反算窗口左上角。
pub(crate) fn dock_position(
    edge: DockEdge,
    along: f64,
    width: i32,
    height: i32,
    area: &native::WorkArea,
) -> (i32, i32) {
    let along = along.clamp(0.0, 1.0);
    match edge {
        DockEdge::None => (area.left, area.top),
        DockEdge::Left => (
            area.left,
            area.top + (f64::from((area.height() - height).max(0)) * along).round() as i32,
        ),
        DockEdge::Right => (
            area.right - width,
            area.top + (f64::from((area.height() - height).max(0)) * along).round() as i32,
        ),
        DockEdge::Top => (
            area.left + (f64::from((area.width() - width).max(0)) * along).round() as i32,
            area.top,
        ),
        DockEdge::Bottom => (
            area.left + (f64::from((area.width() - width).max(0)) * along).round() as i32,
            area.bottom - height,
        ),
    }
}

/// 贴边隐藏的偏移：沿吸附边把窗推出去，只留 PEEK_STRIP 像素。
fn peek_offset(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    edge: DockEdge,
    area: &native::WorkArea,
) -> (i32, i32) {
    match edge {
        DockEdge::Left => (area.left - width + PEEK_STRIP, y),
        DockEdge::Right => (area.right - PEEK_STRIP, y),
        DockEdge::Top => (x, area.top - height + PEEK_STRIP),
        DockEdge::Bottom => (x, area.bottom - PEEK_STRIP),
        DockEdge::None => (x, y),
    }
}

/// 保证窗口至少有一部分留在工作区里。显示器拔掉、分辨率调小之后，
/// 记住的位置会落在屏幕外，这里把它拽回来（歌词那边是 `bounded_lyrics_position`）。
pub(crate) fn bounded_position(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    area: &native::WorkArea,
) -> (i32, i32) {
    const MARGIN: i32 = 64;
    let max_x = (area.right - width.min(area.width())).max(area.left);
    let max_y = (area.bottom - height.min(area.height())).max(area.top);
    let mut x = x.clamp(area.left - width + MARGIN, max_x);
    let mut y = y.clamp(area.top - height + MARGIN, max_y);
    // 整个窗都跑到工作区左边/上边之外时，直接贴回左上角。
    if x + width <= area.left + MARGIN {
        x = area.left;
    }
    if y + height <= area.top + MARGIN {
        y = area.top;
    }
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> native::WorkArea {
        native::WorkArea {
            name: r"\\.\DISPLAY1".into(),
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
            dpi: 96,
            primary: true,
        }
    }

    #[test]
    fn snap_picks_the_nearest_edge() {
        let area = area();
        // 离左边 10px、离上边 300px：只可能是 Left。
        let target = snap_target(10, 300, 268, 56, &area).expect("应吸附");
        assert_eq!(target.edge, DockEdge::Left);
        // 右下角：离右边 4px、离下边 6px → 取更近的 Right。
        let target = snap_target(1920 - 268 - 4, 1040 - 56 - 6, 268, 56, &area).expect("应吸附");
        assert_eq!(target.edge, DockEdge::Right);
    }

    #[test]
    fn far_from_every_edge_stays_floating() {
        let area = area();
        assert!(snap_target(900, 500, 268, 56, &area).is_none());
    }

    #[test]
    fn dock_position_round_trips_along_the_edge() {
        let area = area();
        let target = snap_target(0, 400, 268, 56, &area).expect("应吸附");
        let (x, y) = dock_position(target.edge, target.along, 268, 56, &area);
        // 反算回来应落在原处（沿边比例是从同一个窗口算出来的）。
        assert_eq!((x, y), (0, 400));
    }

    #[test]
    fn top_edge_uses_horizontal_span() {
        let area = area();
        // 沿边比例按窗口左上角算：x=826 时 (1920-268) 的中点，along 应恰为 0.5。
        // Top 的主轴是横的，所以 along 来自 x 而不是 y。
        let target = snap_target(826, 0, 268, 56, &area).expect("应吸附");
        assert_eq!(target.edge, DockEdge::Top);
        assert!((target.along - 0.5).abs() < 0.01);
    }

    #[test]
    fn peek_leaves_only_a_strip() {
        let area = area();
        let (x, y) = peek_offset(0, 400, 268, 56, DockEdge::Left, &area);
        // 窗被推出屏外，工作区内只剩 PEEK_STRIP 像素可见。
        assert_eq!(x + 268 - area.left, PEEK_STRIP);
        assert_eq!(y, 400);
        let (_, y) = peek_offset(960, 1040 - 56, 268, 56, DockEdge::Bottom, &area);
        assert_eq!(area.bottom - y, PEEK_STRIP);
    }

    #[test]
    fn bounded_position_pulls_a_lost_window_back() {
        let area = area();
        let (x, y) = bounded_position(-4000, -4000, 268, 56, &area);
        assert!(x >= area.left && y >= area.top);
        assert!(x + 268 <= area.right);
    }

    #[test]
    fn enter_twice_does_not_recreate_and_restore_asks_for_main() {
        let mut host = MiniHost::new(crate::config::standalone(
            std::path::PathBuf::from("C:\\d"),
            "full",
        ));
        assert!(matches!(
            host.handle(MiniEvent::Enter(EnterReason::User)),
            MiniAction::Show
        ));
        // 第二次进入：已经在小窗里，只重新落位。
        assert!(matches!(
            host.handle(MiniEvent::Enter(EnterReason::User)),
            MiniAction::Place
        ));
        assert!(matches!(
            host.handle(MiniEvent::Restore),
            MiniAction::NotifyRestore
        ));
        assert_ne!(host.phase, MiniPhase::Hidden);
        assert!(matches!(
            host.handle(MiniEvent::RestoreComplete),
            MiniAction::Hide
        ));
        assert_eq!(host.phase, MiniPhase::Hidden);
    }

    #[test]
    fn manual_mini_window_survives_main_window_coming_back() {
        let mut host = MiniHost::new(crate::config::standalone(
            std::path::PathBuf::from("C:\\d"),
            "full",
        ));
        host.auto_on_main_hidden = true;
        host.handle(MiniEvent::Enter(EnterReason::User));
        host.handle(MiniEvent::Enter(EnterReason::MainHidden));
        // 即使开了自动接管，手动打开的小窗也要保留。
        assert!(matches!(
            host.handle(MiniEvent::MainVisible),
            MiniAction::None
        ));
        assert_ne!(host.phase, MiniPhase::Hidden);
    }

    #[test]
    fn auto_mini_window_retreats_when_main_returns() {
        let mut host = MiniHost::new(crate::config::standalone(
            std::path::PathBuf::from("C:\\d"),
            "full",
        ));
        host.auto_on_main_hidden = true;
        host.handle(MiniEvent::Enter(EnterReason::MainHidden));
        assert!(matches!(
            host.handle(MiniEvent::MainVisible),
            MiniAction::Hide
        ));
        assert_eq!(host.phase, MiniPhase::Hidden);
    }

    #[test]
    fn automatic_entry_requires_opt_in_and_manual_entry_takes_ownership() {
        let mut host = pet_host();
        assert!(matches!(
            host.handle(MiniEvent::Enter(EnterReason::MainHidden)),
            MiniAction::None
        ));
        assert_eq!(host.phase, MiniPhase::Hidden);
        host.auto_on_main_hidden = true;
        host.handle(MiniEvent::Enter(EnterReason::MainHidden));
        host.handle(MiniEvent::Enter(EnterReason::User));
        assert!(matches!(
            host.handle(MiniEvent::MainVisible),
            MiniAction::None
        ));
        assert_ne!(host.phase, MiniPhase::Hidden);
    }

    #[test]
    fn drag_end_persists_dock_or_free_position() {
        let mut host = MiniHost::new(crate::config::standalone(
            std::path::PathBuf::from("C:\\d"),
            "full",
        ));
        host.handle(MiniEvent::Enter(EnterReason::User));
        host.phase = MiniPhase::Dragging;
        // 松手位置贴着左边 → 记住 Left。
        host.rect = Some((6, 300, 268, 56));
        host.handle(MiniEvent::DragEnd);
        assert_eq!(host.geometry.dock, DockEdge::Left);
        assert_eq!(host.phase, MiniPhase::Docked);

        host.phase = MiniPhase::Dragging;
        host.rect = Some((900, 500, 268, 56));
        host.handle(MiniEvent::DragEnd);
        assert_eq!(host.geometry.dock, DockEdge::None);
        assert_eq!((host.geometry.x, host.geometry.y), (900, 500));
        assert_eq!(host.phase, MiniPhase::Floating);
    }

    fn pet_host() -> MiniHost {
        let mut host = MiniHost::new(crate::config::standalone(
            std::path::PathBuf::from("C:\\d"),
            "full",
        ));
        host.pet = true;
        host
    }

    #[test]
    fn pet_collapsed_uses_skin_size_and_hover_expands() {
        let mut host = pet_host();
        // 页面上报素材 80×64：收起态窗口就是 80×64。
        assert!(host.set_pet_size(80.0, 64.0));
        let (w, h) = {
            let rect = host.desired_rect(96).expect("工作区存在");
            (rect.2, rect.3)
        };
        assert_eq!((w, h), (80, 64));
        // 悬停展开 = 胶囊尺寸（268×56）。
        host.pet_hover = true;
        let rect = host.desired_rect(96).expect("工作区存在");
        assert_eq!((rect.2, rect.3), (268, 56));
        // 非 pet 态不受素材尺寸影响。
        host.pet = false;
        host.pet_hover = false;
        let rect = host.desired_rect(96).expect("工作区存在");
        assert_eq!((rect.2, rect.3), (268, 56));
    }

    #[test]
    fn pet_size_without_report_falls_back_to_default() {
        let host = pet_host();
        let rect = host.desired_rect(96).expect("工作区存在");
        assert_eq!((rect.2, rect.3), (56, 56));
    }

    #[test]
    fn native_dimensions_follow_the_configured_ui_scale() {
        let mut host = pet_host();
        host.scale = 1.2;
        let rect = host.desired_rect(96).expect("工作区存在");
        assert_eq!((rect.2, rect.3), (67, 67));
        host.pet_hover = true;
        let rect = host.desired_rect(96).expect("工作区存在");
        assert_eq!((rect.2, rect.3), (322, 67));
    }

    #[test]
    fn pet_size_is_clamped_and_invalid_values_are_ignored() {
        let mut host = pet_host();
        assert!(host.set_pet_size(9999.0, 10.0));
        let rect = host.desired_rect(96).expect("工作区存在");
        assert_eq!((rect.2, rect.3), (160, 48));
        assert!(!host.set_pet_size(0.0, 64.0));
        assert!(!host.set_pet_size(f64::NAN, 64.0));
        assert_eq!(host.pet_size, Some((9999.0, 10.0)));
    }
}
