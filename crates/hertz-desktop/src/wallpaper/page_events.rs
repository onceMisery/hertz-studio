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
    Revealed,
    FirstFrame(FrameKind),
    MediaPosition(u64),
    MediaPaused(u64),
    MediaClockRevealed(u64),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    session_id: String,
    generation: u64,
    event: Event,
    frame_kind: Option<Backend>,
    position_ms: Option<u64>,
    pause_token: Option<u64>,
    clock_token: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Event {
    PageHandshake,
    Revealed,
    FirstFrame,
    MediaPosition,
    MediaPaused,
    MediaClockRevealed,
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
    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
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
        if !matches!(receipt.event, Event::MediaClockRevealed) && receipt.clock_token.is_some() {
            return None;
        }
        Some(match receipt.event {
            Event::PageHandshake
                if receipt.frame_kind.is_none()
                    && receipt.position_ms.is_none()
                    && receipt.pause_token.is_none() =>
            {
                PageEvent::Handshake
            }
            Event::PageHandshake => return None,
            Event::Revealed
                if receipt.frame_kind.is_none()
                    && receipt.position_ms.is_none()
                    && receipt.pause_token.is_none() =>
            {
                PageEvent::Revealed
            }
            Event::FirstFrame if receipt.position_ms.is_none() && receipt.pause_token.is_none() => {
                PageEvent::FirstFrame(match receipt.frame_kind? {
                    Backend::Image => FrameKind::Image,
                    Backend::Video => FrameKind::Video,
                    Backend::Gl => FrameKind::Gl,
                })
            }
            Event::MediaPosition
                if receipt.frame_kind.is_none() && receipt.pause_token.is_none() =>
            {
                PageEvent::MediaPosition(receipt.position_ms?)
            }
            Event::MediaPaused if receipt.frame_kind.is_none() && receipt.position_ms.is_none() => {
                let token = receipt.pause_token?;
                if token == 0 {
                    return None;
                }
                PageEvent::MediaPaused(token)
            }
            Event::MediaClockRevealed
                if receipt.frame_kind.is_none()
                    && receipt.position_ms.is_none()
                    && receipt.pause_token.is_none() =>
            {
                let token = receipt.clock_token?;
                if token == 0 || token > 9_007_199_254_740_991 {
                    return None;
                }
                PageEvent::MediaClockRevealed(token)
            }
            _ => return None,
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
    fn mirror_reveal_requires_native_binding_and_positive_safe_clock_token() {
        let binding = PageBinding::new(42).unwrap();
        let receipt = message(
            &binding,
            "\"event\":\"mediaClockRevealed\",\"clockToken\":7",
        );
        assert_eq!(
            binding.parse(&receipt),
            Some(PageEvent::MediaClockRevealed(7))
        );
        assert_eq!(PageBinding::new(42).unwrap().parse(&receipt), None);
        for fields in [
            "\"event\":\"mediaClockRevealed\"",
            "\"event\":\"mediaClockRevealed\",\"clockToken\":0",
            "\"event\":\"mediaClockRevealed\",\"clockToken\":9007199254740992",
            "\"event\":\"mediaClockRevealed\",\"clockToken\":7,\"pauseToken\":1",
            "\"event\":\"mediaClockRevealed\",\"clockToken\":7,\"positionMs\":1",
            "\"event\":\"mediaClockRevealed\",\"clockToken\":7,\"frameKind\":\"video\"",
            "\"event\":\"revealed\",\"clockToken\":7",
        ] {
            assert_eq!(binding.parse(&message(&binding, fields)), None, "{fields}");
        }
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

    #[test]
    fn playback_positions_require_identity_and_integer_values_without_readiness_fields() {
        let binding = PageBinding::new(9).unwrap();
        let position = message(&binding, "\"event\":\"mediaPosition\",\"positionMs\":1250");
        assert_eq!(
            binding.parse(&position),
            Some(PageEvent::MediaPosition(1250))
        );
        assert_eq!(PageBinding::new(9).unwrap().parse(&position), None);
        assert_eq!(PageBinding::new(10).unwrap().parse(&position), None);
        for invalid in [
            "\"event\":\"mediaPosition\"",
            "\"event\":\"mediaPosition\",\"positionMs\":-1",
            "\"event\":\"mediaPosition\",\"positionMs\":0.5",
            "\"event\":\"mediaPosition\",\"positionMs\":5,\"frameKind\":\"video\"",
            "\"event\":\"firstFrame\",\"frameKind\":\"video\",\"positionMs\":5",
            "\"event\":\"pageHandshake\",\"positionMs\":5",
        ] {
            assert_eq!(binding.parse(&message(&binding, invalid)), None);
        }
    }

    #[test]
    fn pause_confirmation_requires_current_identity_and_positive_typed_token() {
        let binding = PageBinding::new(11).unwrap();
        let paused = message(&binding, "\"event\":\"mediaPaused\",\"pauseToken\":3");
        assert_eq!(binding.parse(&paused), Some(PageEvent::MediaPaused(3)));
        assert_eq!(PageBinding::new(11).unwrap().parse(&paused), None);
        let next = PageBinding {
            generation: 12,
            ..binding.clone()
        };
        assert_eq!(next.parse(&paused), None);
        for invalid in [
            "\"event\":\"mediaPaused\"",
            "\"event\":\"mediaPaused\",\"pauseToken\":0",
            "\"event\":\"mediaPaused\",\"pauseToken\":-1",
            "\"event\":\"mediaPaused\",\"pauseToken\":0.5",
            "\"event\":\"mediaPaused\",\"pauseToken\":\"3\"",
            "\"event\":\"mediaPaused\",\"pauseToken\":3,\"positionMs\":5",
            "\"event\":\"mediaPaused\",\"pauseToken\":3,\"frameKind\":\"video\"",
            "\"event\":\"mediaPosition\",\"positionMs\":5,\"pauseToken\":3",
            "\"event\":\"firstFrame\",\"frameKind\":\"video\",\"pauseToken\":3",
            "\"event\":\"pageHandshake\",\"pauseToken\":3",
        ] {
            assert_eq!(
                binding.parse(&message(&binding, invalid)),
                None,
                "{invalid}"
            );
        }
    }

    #[test]
    fn reveal_requires_current_identity_and_no_unrelated_payload() {
        let binding = PageBinding::new(12).unwrap();
        let reveal = message(&binding, "\"event\":\"revealed\"");
        assert_eq!(binding.parse(&reveal), Some(PageEvent::Revealed));
        assert_eq!(PageBinding::new(12).unwrap().parse(&reveal), None);
        assert_eq!(
            PageBinding {
                generation: 13,
                ..binding.clone()
            }
            .parse(&reveal),
            None
        );
        for field in [
            "\"frameKind\":\"gl\"",
            "\"positionMs\":0",
            "\"pauseToken\":1",
            "\"extra\":true",
        ] {
            assert_eq!(
                binding.parse(&message(
                    &binding,
                    &format!("\"event\":\"revealed\",{field}")
                )),
                None
            );
        }
    }
}
