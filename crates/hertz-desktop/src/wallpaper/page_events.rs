// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Native-issued identity for readiness receipts. DOM/mount notifications are not frame receipts.
use serde::{Deserialize, Serialize};

use super::session::FrameKind;

const PREFIX: &str = "wallpaper_session ";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageBinding {
    session_id: String,
    generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PageEvent {
    Handshake,
    FirstFrame(FrameKind),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    session_id: String,
    generation: u64,
    event: Event,
    frame_kind: Option<Backend>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Event {
    PageHandshake,
    FirstFrame,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Backend {
    Image,
    Video,
    Gl,
}

impl PageBinding {
    pub(crate) fn new(generation: u64) -> Result<Self, super::jobs::JobError> {
        Ok(Self {
            session_id: super::file_tokens::random_token()?,
            generation,
        })
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn initialization_script(&self) -> String {
        format!("Object.defineProperty(window,'__hertzWallpaperBinding',{{value:Object.freeze({}),writable:false,configurable:false}});", serde_json::to_string(self).expect("native binding"))
    }

    pub(crate) fn parse(&self, message: &str) -> Option<PageEvent> {
        if message.len() > 512 {
            return None;
        }
        let receipt: Receipt = serde_json::from_str(message.strip_prefix(PREFIX)?).ok()?;
        if receipt.session_id != self.session_id || receipt.generation != self.generation {
            return None;
        }
        Some(match receipt.event {
            Event::PageHandshake if receipt.frame_kind.is_none() => PageEvent::Handshake,
            Event::PageHandshake => return None,
            Event::FirstFrame => PageEvent::FirstFrame(match receipt.frame_kind? {
                Backend::Image => FrameKind::Image,
                Backend::Video => FrameKind::Video,
                Backend::Gl => FrameKind::Gl,
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(binding: &PageBinding, event: &str) -> String {
        format!(
            "wallpaper_session {{\"sessionId\":\"{}\",\"generation\":{},{} }}",
            binding.session_id, binding.generation, event
        )
    }
    #[test]
    fn readiness_requires_current_native_identity_and_typed_backend() {
        let binding = PageBinding::new(7).unwrap();
        let handshake = message(&binding, "\"event\":\"pageHandshake\"");
        assert_eq!(binding.parse(&handshake), Some(PageEvent::Handshake));
        for (backend, kind) in [
            ("image", FrameKind::Image),
            ("video", FrameKind::Video),
            ("gl", FrameKind::Gl),
        ] {
            let event = message(
                &binding,
                &format!("\"event\":\"firstFrame\",\"frameKind\":\"{backend}\""),
            );
            assert_eq!(binding.parse(&event), Some(PageEvent::FirstFrame(kind)));
        }
        assert_eq!(PageBinding::new(7).unwrap().parse(&handshake), None);
        let later = PageBinding {
            generation: 8,
            ..binding.clone()
        };
        assert_eq!(later.parse(&handshake), None);
        for invalid in [
            "wallpaper_ready",
            "wallpaper_dom_ready",
            "wallpaper_session {}",
        ] {
            assert_eq!(binding.parse(invalid), None);
        }
        for invalid in [
            "\"event\":\"firstFrame\"",
            "\"event\":\"firstFrame\",\"frameKind\":\"dom\"",
            "\"event\":\"pageHandshake\",\"extra\":true",
        ] {
            assert_eq!(binding.parse(&message(&binding, invalid)), None);
        }
    }
}
