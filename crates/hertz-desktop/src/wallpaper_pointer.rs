// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Desktop-only visual input. Poll without hooks or forwarding mouse messages;
//! ordinary previews use their own DOM pointer. Each controller holds at most one dispatch.
use super::*;
use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetCursorPos, GetShellWindow, GetWindowThreadProcessId, WindowFromPoint, GA_ROOT,
};

const INTERVAL: Duration = Duration::from_micros(33_334);

#[derive(Default)]
pub(super) struct Input {
    due: Option<Instant>,
    active: bool,
    down: bool,
    serial: u64,
    click: Option<(Instant, f64, f64)>,
    pending: Arc<AtomicBool>,
}

fn normalized(point: POINT, monitor: &native::WallpaperMonitor) -> Option<(f64, f64)> {
    let x = i64::from(point.x) - i64::from(monitor.left);
    let y = i64::from(point.y) - i64::from(monitor.top);
    (x >= 0 && y >= 0 && x < i64::from(monitor.width) && y < i64::from(monitor.height)).then(|| {
        (
            x as f64 / f64::from(monitor.width),
            y as f64 / f64::from(monitor.height),
        )
    })
}

fn desktop_point(point: POINT, wallpaper: HWND) -> bool {
    let hit = unsafe { WindowFromPoint(point) };
    let root = unsafe { GetAncestor(hit, GA_ROOT) };
    if hit.is_null() || root.is_null() {
        return false;
    }
    if hit == wallpaper || root == wallpaper {
        return true;
    }
    // Explorer file lists also use SysListView32. Only the shell's desktop root qualifies.
    let class = native::class_name(root);
    if class != "Progman" && class != "WorkerW" {
        return false;
    }
    let mut shell_pid = 0;
    let mut hit_pid = 0;
    unsafe {
        GetWindowThreadProcessId(GetShellWindow(), &mut shell_pid);
        GetWindowThreadProcessId(root, &mut hit_pid);
    }
    shell_pid != 0 && hit_pid == shell_pid
}

impl Input {
    fn observe(&mut self, now: Instant, position: Option<(f64, f64)>, down: bool) {
        // Entering the desktop with an already-held button is not a desktop click.
        if self.active && !self.down && down {
            if let Some((x, y)) = position {
                self.serial += 1;
                self.click = Some((now, x, y));
            }
        }
        self.active = position.is_some();
        self.down = down;
        if !self.active {
            self.click = None;
        }
    }
}

impl App {
    pub(super) fn poll_wallpaper_pointer(&mut self) -> Option<Instant> {
        let surface = self.wallpaper.as_mut()?;
        let now = Instant::now();
        let allowed = self.wallpaper_visible
            && self.wallpaper_page_ready
            && !surface.static_poster
            && surface.configuration.presentation().pointer
            && surface.configuration.presentation().motion > 0.;
        if !allowed {
            surface.pointer.due = None;
            surface.pointer.active = false;
            surface.pointer.down = false;
            surface.pointer.click = None;
            return None;
        }
        if let Some(due) = surface.pointer.due.filter(|due| *due > now) {
            return Some(due);
        }
        let next = now + INTERVAL;
        surface.pointer.due = Some(next);
        let mut point = POINT::default();
        let position = (unsafe { GetCursorPos(&mut point) } != 0)
            .then(|| normalized(point, &surface.monitor))
            .flatten()
            .filter(|_| desktop_point(point, surface.hwnd()));
        let down = unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON)) } < 0;
        surface.pointer.observe(now, position, down);
        if surface.pointer.pending.swap(true, Ordering::AcqRel) {
            return Some(next);
        }
        let click = surface
            .pointer
            .click
            .filter(|(at, _, _)| now.duration_since(*at) < Duration::from_millis(250));
        let (x, y) = position.unwrap_or((0.5, 0.5));
        let payload = serde_json::json!({
            "active": position.is_some(), "x": x, "y": y,
            "click": click.map(|(_, x, y)| serde_json::json!({"serial":surface.pointer.serial,"x":x,"y":y})),
            "pageDispatchMs": surface.page_clock.map(|clock| clock.at(now)),
        });
        let pending = Arc::clone(&surface.pointer.pending);
        if surface
            .webview
            .evaluate_script_with_callback(
                &format!("window.hertzWallpaper && window.hertzWallpaper.applyPointer({payload});"),
                move |_| {
                    pending.store(false, Ordering::Release);
                },
            )
            .is_err()
        {
            surface.pointer.pending.store(false, Ordering::Release);
            surface.eval_failures.fetch_add(1, Ordering::Relaxed);
        }
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_clicks_require_a_fresh_press_on_the_desktop() {
        let mut input = Input::default();
        let now = Instant::now();
        input.observe(now, None, true);
        input.observe(now, Some((0.2, 0.3)), true);
        assert_eq!(
            input.serial, 0,
            "a drag from another window cannot click the wallpaper"
        );
        input.observe(now, Some((0.2, 0.3)), false);
        input.observe(now, Some((0.2, 0.3)), true);
        input.observe(now, Some((0.4, 0.5)), true);
        assert_eq!(input.serial, 1, "holding must not repeatedly click");
        assert_eq!(input.click.unwrap().1, 0.2);
        input.observe(now, None, false);
        assert!(
            input.click.is_none(),
            "leaving clears pending click effects"
        );
    }

    #[test]
    fn pointer_coordinates_follow_the_physical_target_on_negative_origin_displays() {
        let monitor = native::WallpaperMonitor {
            name: String::new(),
            left: -2560,
            top: -300,
            width: 2560,
            height: 1440,
            dpi: 144,
            primary: false,
            refresh_hz: 60,
            device_path: None,
            edid_digest: None,
        };
        assert_eq!(
            normalized(POINT { x: -1280, y: 420 }, &monitor),
            Some((0.5, 0.5))
        );
        assert_eq!(normalized(POINT { x: 0, y: 420 }, &monitor), None);
        assert_eq!(normalized(POINT { x: -2561, y: 420 }, &monitor), None);
    }
}
