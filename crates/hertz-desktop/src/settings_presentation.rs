// SPDX-License-Identifier: MIT
use super::*;
use crate::settings_embedding::{SettingsEvent, SettingsPlacement};

impl App {
    pub(super) fn place_settings(
        &mut self,
        placement: Option<SettingsPlacement>,
        target: &EventLoopWindowTarget<()>,
    ) {
        let Some(placement) = placement else {
            if let Some(settings) = &mut self.settings {
                settings.placement = None;
            }
            self.close_settings();
            return;
        };
        if self.settings_events.is_none() {
            return;
        }
        let bounds = &placement.bounds;
        let mut pid = 0;
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
                placement.parent as HWND,
                &mut pid,
            );
        }
        if pid != std::process::id()
            || bounds.width == 0
            || bounds.height == 0
            || bounds.width > 16384
            || bounds.height > 16384
            || bounds.x < 0
            || bounds.y < 0
        {
            self.settings_events.as_ref().unwrap()(SettingsEvent::Failed {
                document: placement.document,
                error: "壁纸编辑区尺寸或所属窗口无效，请重新打开设置".into(),
            });
            return;
        }
        let same = self
            .settings
            .as_ref()
            .and_then(|settings| settings.placement.as_ref())
            .is_some_and(|current| {
                current.document == placement.document && current.parent == placement.parent
            });
        if !same {
            let candidate = self.settings_candidate.take();
            if let Some(settings) = &mut self.settings {
                settings.placement = None;
            }
            self.close_settings();
            self.settings_candidate = candidate;
            if !placement.visible {
                return;
            }
            self.settings_generation += 1;
            match create_settings(
                target,
                self.proxy.clone(),
                self.settings_generation,
                Some(placement.clone()),
            ) {
                Ok(settings) => {
                    self.settings = Some(settings);
                    self.settings_drafts.set_owner(self.settings_generation);
                    self.wallpaper_ai.set_owner(self.settings_generation);
                    self.wallpaper_library
                        .set_settings_owner(self.settings_generation);
                    self.sync_settings_feed();
                }
                Err(error) => {
                    self.settings_events.as_ref().unwrap()(SettingsEvent::Failed {
                        document: placement.document,
                        error: format!("无法加载壁纸设置：{error}"),
                    });
                    return;
                }
            }
        }
        if !placement.visible {
            self.close_preview();
        }
        let navigated = self.settings_tab != placement.tab;
        if navigated {
            self.settings_tab = placement.tab.clone();
            self.settings_navigation = self.settings_navigation.wrapping_add(1);
        }
        if let Some(settings) = &mut self.settings {
            let moved = unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::*;
                SetWindowPos(
                    settings.window.hwnd() as HWND,
                    HWND_TOP,
                    bounds.x,
                    bounds.y,
                    bounds.width as i32,
                    bounds.height as i32,
                    SWP_NOACTIVATE,
                )
            };
            let resized = settings.webview.set_bounds(wry::Rect {
                position: PhysicalPosition::new(0, 0).into(),
                size: PhysicalSize::new(bounds.width, bounds.height).into(),
            });
            if moved == 0 || resized.is_err() {
                settings.window.set_visible(false);
                self.settings_events.as_ref().unwrap()(SettingsEvent::Failed {
                    document: placement.document,
                    error: "壁纸编辑区定位失败，请重新加载设置".into(),
                });
                return;
            }
            settings.eval(&format!(
                "document.documentElement.dataset.theme = '{}';",
                if placement.light { "light" } else { "dark" }
            ));
            settings.window.set_visible(placement.visible);
            settings.placement = Some(placement);
        }
        self.sync_embedded_preview();
        if self
            .settings
            .as_ref()
            .is_some_and(|settings| settings.ready)
        {
            self.settings_ready();
        }
        if navigated {
            self.send_settings_status(None, None);
        }
    }

    pub(super) fn settings_ready(&self) {
        if let (Some(events), Some(placement)) = (
            &self.settings_events,
            self.settings
                .as_ref()
                .and_then(|settings| settings.placement.as_ref()),
        ) {
            events(SettingsEvent::Ready {
                document: placement.document.clone(),
            });
        }
    }

    pub(super) fn preview_bounds(&mut self, body: &str) {
        let Some(settings) = self
            .settings
            .as_mut()
            .filter(|settings| settings.placement.is_some())
        else {
            return;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
            return;
        };
        let Some(bounds) = value.get("bounds").cloned().and_then(|value| {
            serde_json::from_value::<crate::settings_embedding::SettingsBounds>(value).ok()
        }) else {
            return;
        };
        let size = settings.window.inner_size();
        let visible = value.get("visible").and_then(|value| value.as_bool()) == Some(true)
            && settings
                .placement
                .as_ref()
                .is_some_and(|placement| placement.visible)
            && bounds.x >= 0
            && bounds.y >= 0
            && bounds.width > 0
            && bounds.height > 0
            && (bounds.x as u64 + bounds.width as u64) <= u64::from(size.width)
            && (bounds.y as u64 + bounds.height as u64) <= u64::from(size.height);
        // Renderer dimensions are fixed for a lease. Resizing retires it before
        // a new preview is admitted with the new dimensions.
        let resized = self.preview.as_ref().is_some_and(|preview| {
            preview.monitor.width != bounds.width as i32
                || preview.monitor.height != bounds.height as i32
        });
        settings.preview_bounds = visible.then_some(bounds.clone());
        if resized {
            self.close_preview();
            return;
        }
        if let Some(preview) = self.preview.as_mut() {
            preview.monitor.left = bounds.x;
            preview.monitor.top = bounds.y;
        }
        self.sync_embedded_preview();
    }

    // Updating Wry bounds raises its controller HWND. Restore the preview above
    // that sibling after placement, and keep a retained frame above its successor.
    pub(super) fn sync_embedded_preview(&self) {
        let Some(settings) = self
            .settings
            .as_ref()
            .filter(|settings| settings.placement.is_some())
        else {
            return;
        };
        let visible = settings
            .placement
            .as_ref()
            .is_some_and(|placement| placement.visible)
            && settings.preview_bounds.is_some();
        if let Some(preview) = &self.preview {
            if let Some(surface) = &preview.surface {
                unsafe {
                    use windows_sys::Win32::UI::WindowsAndMessaging::*;
                    SetWindowPos(
                        surface.hwnd(),
                        HWND_TOP,
                        preview.monitor.left,
                        preview.monitor.top,
                        preview.monitor.width,
                        preview.monitor.height,
                        SWP_NOACTIVATE,
                    );
                }
                surface.window.set_visible(visible);
            }
            if let Some(frame) = preview
                .frame
                .as_ref()
                .and_then(|frame| frame.window.as_ref())
            {
                frame.set_preview_visibility(&preview.monitor, visible);
            }
        }
    }
}
