// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! The native loop owns one read-only preview with a separate browser profile.

use std::path::Path;
use tao::dpi::LogicalSize;
use tao::event_loop::EventLoopWindowTarget;
use tao::window::{Window, WindowBuilder, WindowId};
use wry::{WebContext, WebView, WebViewBuilder};

pub(super) struct ObsPreview {
    // Drop the WebView before its native parent and browser context.
    webview: WebView,
    window: Window,
    _context: WebContext,
}

/// Only the current service's existing read-only credential can open a preview.
pub(super) fn admitted_url(value: &str, origin: &str, key: &str) -> Option<String> {
    if value.len() > 384 || key.is_empty() {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    if url.origin().ascii_serialization() != origin
        || url.path() != "/overlay"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut has_key = false;
    let mut has_style = false;
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "key" if !has_key && value == key => has_key = true,
            "style"
                if !has_style
                    && matches!(value.as_ref(), "full" | "line" | "karaoke" | "minimal") =>
            {
                has_style = true;
            }
            _ => return None,
        }
    }
    has_key.then(|| url.to_string())
}

impl ObsPreview {
    pub(super) fn id(&self) -> WindowId {
        self.window.id()
    }

    pub(super) fn open<T: 'static>(
        current: &mut Option<Self>,
        target: &EventLoopWindowTarget<T>,
        data_dir: &Path,
        value: &str,
        origin: &str,
        key: &str,
    ) -> Result<(), &'static str> {
        let url = admitted_url(value, origin, key).ok_or("invalid read-only OBS preview URL")?;
        if let Some(current) = current.as_ref() {
            current
                .webview
                .load_url(&url)
                .map_err(|_| "OBS preview navigation failed")?;
            current.window.set_minimized(false);
            super::placement::revalidate(&current.window, false);
            current.window.set_visible(true);
            current.window.set_focus();
            return Ok(());
        }
        let window = WindowBuilder::new()
            .with_title("Hertz Studio · OBS 歌词预览")
            .with_inner_size(LogicalSize::new(960.0, 600.0))
            .with_visible(false)
            .build(target)
            .map_err(|_| "OBS preview window creation failed")?;
        if let Some(snapshot) = super::placement::capture(&window, true) {
            super::placement::apply(&window, snapshot);
        }
        let mut context = WebContext::new(Some(data_dir.join("webview").join("obs-preview")));
        let origin = origin.to_owned();
        let key = key.to_owned();
        let builder = WebViewBuilder::new_with_web_context(&mut context)
            // The transparent OBS page needs a readable backdrop in this preview.
            .with_background_color((20, 20, 19, 255))
            .with_url(&url)
            .with_navigation_handler(move |url| admitted_url(&url, &origin, &key).is_some())
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
            .with_download_started_handler(|_, _| false)
            .with_permission_handler(|_| wry::PermissionResponse::Deny);
        #[cfg(any(windows, target_os = "macos"))]
        let webview = builder.build(&window);
        #[cfg(not(any(windows, target_os = "macos")))]
        let webview = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            builder.build_gtk(
                window
                    .default_vbox()
                    .ok_or("OBS preview container unavailable")?,
            )
        };
        let webview = webview.map_err(|_| "OBS preview browser creation failed")?;
        window.set_visible(true);
        window.set_focus();
        *current = Some(Self {
            webview,
            window,
            _context: context,
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::admitted_url;

    #[test]
    fn only_current_key_and_known_single_style_are_admitted() {
        let origin = "http://127.0.0.1:49123";
        for suffix in [
            "",
            "&style=full",
            "&style=line",
            "&style=karaoke",
            "&style=minimal",
        ] {
            let url = format!("{origin}/overlay?key=read-only{suffix}");
            assert_eq!(admitted_url(&url, origin, "read-only"), Some(url));
        }
        for suffix in [
            "?key=wrong",
            "?key=",
            "?token=read-only",
            "?ticket=read-only",
            "?key=read-only&token=full",
            "?key=read-only&key=read-only",
            "?key=read-only&style=line&style=full",
            "?key=read-only&style=unknown",
            "?key=read-only&scale=2",
            "?key=read-only#fragment",
            "?key=read-only&extra=1",
            "",
            "/extra?key=read-only",
            "%2fextra?key=read-only",
        ] {
            assert!(
                admitted_url(&format!("{origin}/overlay{suffix}"), origin, "read-only").is_none(),
                "{suffix}"
            );
        }
        for url in [
            "https://127.0.0.1:49123/overlay?key=read-only",
            "http://localhost:49123/overlay?key=read-only",
            "http://127.0.0.1:49124/overlay?key=read-only",
            "http://user@127.0.0.1:49123/overlay?key=read-only",
            "http://user:pass@127.0.0.1:49123/overlay?key=read-only",
            "about:blank",
            "javascript:alert(1)",
            "data:text/html,example",
        ] {
            assert!(admitted_url(url, origin, "read-only").is_none());
        }
        assert!(admitted_url(&format!("{origin}/overlay?key=read-only"), origin, "").is_none());
        assert!(admitted_url(
            &format!("{origin}/overlay?key={}", "a".repeat(385)),
            origin,
            "read-only"
        )
        .is_none());
    }
}
