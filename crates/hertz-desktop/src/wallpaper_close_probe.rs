// SPDX-License-Identifier: MIT
//! Explicit debug-only failure injection at the real retiring-controller Close boundary.
//! An IPC event can affect only its own still-live native binding, including during retirement.
use super::*;

const PREFIX: &str = "wallpaper_probe_close ";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeRequest {
    nonce: u64,
    session_id: String,
    generation: u64,
    blocked: bool,
}

impl ProbeRequest {
    fn parse(body: &str) -> Option<Self> {
        if body.len() > 512 {
            return None;
        }
        let request: Self = serde_json::from_str(body).ok()?;
        (request.nonce > 0 && request.nonce <= 9_007_199_254_740_991).then_some(request)
    }
    fn matches(&self, binding: &crate::wallpaper::page_events::PageBinding, source: u64) -> bool {
        self.generation == source
            && self.generation == binding.generation()
            && self.session_id == binding.session_id()
    }
}

impl App {
    pub(super) fn handle_wallpaper_close_probe(&mut self, generation: u64, event: &str) -> bool {
        let Some(body) = event.strip_prefix(PREFIX) else {
            return false;
        };
        let Some(request) = ProbeRequest::parse(body) else {
            return true;
        };
        let surface = self
            .desktop
            .runtimes
            .values_mut()
            .flat_map(|desktop| {
                desktop
                    .surface
                    .iter_mut()
                    .chain(desktop.candidate.iter_mut())
            })
            .chain(
                self.preview
                    .iter_mut()
                    .filter_map(|preview| preview.surface.as_mut()),
            )
            .chain(
                self.wallpaper_retiring
                    .iter_mut()
                    .filter_map(|retiring| retiring.surface.as_mut()),
            )
            .find(|surface| surface.binding.generation() == generation);
        if let Some(surface) = surface {
            let accepted = request.matches(&surface.binding, generation);
            if accepted {
                surface.close_probe_blocked = request.blocked;
            }
            surface.eval(&format!(
                "window.__nativeCloseProbe={};",
                serde_json::json!({
                    "nonce":request.nonce,"accepted":accepted,"blocked":surface.close_probe_blocked,
                })
            ));
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failure_injection_is_bounded_and_cannot_target_another_native_binding() {
        let binding = crate::wallpaper::page_events::PageBinding::new(7).unwrap();
        let request = serde_json::json!({"nonce":1,"sessionId":binding.session_id(),"generation":7,"blocked":true});
        let parsed = ProbeRequest::parse(&request.to_string()).unwrap();
        assert!(parsed.matches(&binding, 7));
        assert!(!parsed.matches(&binding, 8));
        assert!(!parsed.matches(
            &crate::wallpaper::page_events::PageBinding::new(7).unwrap(),
            7
        ));
        for (field, value) in [
            ("nonce", serde_json::json!(0)),
            ("nonce", serde_json::json!(9_007_199_254_740_992_u64)),
            ("unknown", serde_json::json!(true)),
        ] {
            let mut invalid = request.clone();
            invalid[field] = value;
            assert!(ProbeRequest::parse(&invalid.to_string()).is_none());
        }
        assert!(ProbeRequest::parse(&"x".repeat(513)).is_none());
    }
}
