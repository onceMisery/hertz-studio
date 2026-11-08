// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Native geometry adapter. The restart store remains owned by WindowLifecycle.

use hertz_studio::window_lifecycle::NativeWindowOwner;
use hertz_studio::window_placement::{select_monitor, Monitor, Rect, WindowPlacement};
#[cfg(not(windows))]
use tao::dpi::PhysicalPosition;
use tao::dpi::PhysicalSize;
use tao::window::Window;

#[cfg(windows)]
fn rect(value: windows_sys::Win32::Foundation::RECT) -> Option<Rect> {
    Rect::new(
        value.left,
        value.top,
        u32::try_from(i64::from(value.right) - i64::from(value.left)).ok()?,
        u32::try_from(i64::from(value.bottom) - i64::from(value.top)).ok()?,
    )
    .ok()
}

pub(super) fn monitors(window: &Window) -> Vec<Monitor> {
    let primary = window.primary_monitor();
    window
        .available_monitors()
        .filter_map(|handle| {
            #[cfg(windows)]
            let (bounds, work_area) = {
                use tao::platform::windows::MonitorHandleExtWindows;
                use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO};
                let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
                info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                if unsafe { GetMonitorInfoW(handle.hmonitor() as _, &mut info) } == 0 {
                    return None;
                }
                (rect(info.rcMonitor)?, rect(info.rcWork)?)
            };
            #[cfg(not(windows))]
            let (bounds, work_area) = {
                let position = handle.position();
                let size = handle.size();
                let bounds = Rect::new(position.x, position.y, size.width, size.height).ok()?;
                (bounds, bounds)
            };
            Some(Monitor {
                bounds,
                work_area,
                scale_factor: handle.scale_factor(),
                primary: primary.as_ref() == Some(&handle),
            })
        })
        .collect()
}

/// Hidden startup can inspect default geometry without accepting a save. Hidden
/// runtime windows and minimized frames never replace the last normal snapshot.
pub(super) fn capture(window: &Window, allow_hidden: bool) -> Option<WindowPlacement> {
    if window.is_minimized() || (!allow_hidden && !window.is_visible()) {
        return None;
    }
    let monitors = monitors(window);
    #[cfg(windows)]
    let normal = {
        use tao::platform::windows::WindowExtWindows;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;
        if window.is_maximized() {
            let native = super::native_window_placement(window)?;
            let current = window.current_monitor()?;
            let position = current.position();
            let current = monitors
                .iter()
                .find(|monitor| monitor.bounds.x == position.x && monitor.bounds.y == position.y)?;
            hertz_studio::window_placement::workspace_to_screen(
                rect(native.rcNormalPosition)?,
                current.bounds,
                current.work_area,
            )
            .ok()?
        } else {
            let mut outer = unsafe { std::mem::zeroed() };
            if unsafe { GetWindowRect(window.hwnd() as _, &mut outer) } == 0 {
                return None;
            }
            rect(outer)?
        }
    };
    #[cfg(not(windows))]
    let normal = {
        let position = window.outer_position().ok()?;
        let size = window.outer_size();
        Rect::new(position.x, position.y, size.width, size.height).ok()?
    };
    let monitor = select_monitor(normal, &monitors)?;
    WindowPlacement::new(
        normal,
        monitor.work_area,
        window.scale_factor(),
        window.is_maximized(),
    )
    .ok()
}

fn frame_size(window: &Window, scale: f64) -> (u32, u32) {
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetMenu, GetWindowLongW, GWL_EXSTYLE, GWL_STYLE,
        };
        let hwnd = window.hwnd() as _;
        let mut frame = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // Scale the actual window DPI to the selected monitor; no device/DPI constant.
        let dpi = (f64::from(unsafe { GetDpiForWindow(hwnd) }) * scale / window.scale_factor())
            .round() as u32;
        if unsafe {
            AdjustWindowRectExForDpi(
                &mut frame,
                GetWindowLongW(hwnd, GWL_STYLE) as _,
                (!GetMenu(hwnd).is_null()) as _,
                GetWindowLongW(hwnd, GWL_EXSTYLE) as _,
                dpi,
            )
        } != 0
        {
            return (
                (frame.right - frame.left).max(0) as u32,
                (frame.bottom - frame.top).max(0) as u32,
            );
        }
    }
    let outer = window.outer_size();
    let inner = window.inner_size();
    let ratio = scale / window.scale_factor();
    (
        (f64::from(outer.width.saturating_sub(inner.width)) * ratio).ceil() as u32,
        (f64::from(outer.height.saturating_sub(inner.height)) * ratio).ceil() as u32,
    )
}

pub(super) fn apply(window: &Window, saved: WindowPlacement) -> bool {
    let monitors = monitors(window);
    let Some(monitor) = select_monitor(saved.normal_bounds, &monitors) else {
        return false;
    };
    let frame = frame_size(window, monitor.scale_factor);
    let Some(fitted) = saved.recover(&monitors, (720.0, 480.0), frame) else {
        return false;
    };
    let bounds = fitted.normal_bounds;
    // Windows minimums constrain inner dimensions. Permit a smaller minimum if
    // the current work area cannot contain 720x480 DIP plus the native frame.
    window.set_min_inner_size(Some(PhysicalSize::new(
        ((720.0 * fitted.scale_factor).ceil() as u32)
            .min(fitted.work_area.width.saturating_sub(frame.0)),
        ((480.0 * fitted.scale_factor).ceil() as u32)
            .min(fitted.work_area.height.saturating_sub(frame.1)),
    )));
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPlacement, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE,
        };
        // Restore rcNormalPosition even when currently maximized. A hidden
        // normal HWND can still report SW_SHOWNORMAL, so visibility must be
        // preserved explicitly. Tao keeps desired maximization separately and
        // applies it on the later explicit set_visible(true).
        if let Some(mut native) = super::native_window_placement(window) {
            if !window.is_visible() {
                native.showCmd = SW_HIDE as u32;
            }
            native.rcNormalPosition = RECT {
                left: bounds.x - (monitor.work_area.x - monitor.bounds.x),
                top: bounds.y - (monitor.work_area.y - monitor.bounds.y),
                right: (bounds.right() - i64::from(monitor.work_area.x)
                    + i64::from(monitor.bounds.x)) as i32,
                bottom: (bounds.bottom() - i64::from(monitor.work_area.y)
                    + i64::from(monitor.bounds.y)) as i32,
            };
            if unsafe { SetWindowPlacement(window.hwnd() as _, &native) } == 0 {
                tracing::warn!("native main window normal placement could not be restored");
                return false;
            }
        }
        if !window.is_maximized()
            && unsafe {
                SetWindowPos(
                    window.hwnd() as _,
                    std::ptr::null_mut(),
                    bounds.x,
                    bounds.y,
                    bounds.width as i32,
                    bounds.height as i32,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                )
            } == 0
        {
            tracing::warn!("native main window outer frame could not be fitted");
            return false;
        }
    }
    #[cfg(not(windows))]
    {
        window.set_outer_position(PhysicalPosition::new(bounds.x, bounds.y));
        window.set_inner_size(PhysicalSize::new(
            bounds.width.saturating_sub(frame.0),
            bounds.height.saturating_sub(frame.1),
        ));
    }
    if window.is_maximized() != fitted.maximized {
        window.set_maximized(fitted.maximized);
    }
    true
}

pub(super) fn record(window: &Window, owner: Option<&NativeWindowOwner>, capsule: bool) {
    if capsule {
        return;
    }
    if let (Some(owner), Some(snapshot)) = (owner, capture(window, false)) {
        // Load/save failures are logged by the owner. Protected/sealed snapshots
        // intentionally remain unchanged, without flooding logs on every move.
        let _ = owner.record_placement(snapshot);
    }
}

pub(super) fn revalidate(window: &Window, capsule: bool) {
    if capsule || window.is_minimized() {
        return;
    }
    if let Some(snapshot) = capture(window, true) {
        apply(window, snapshot);
    }
}
