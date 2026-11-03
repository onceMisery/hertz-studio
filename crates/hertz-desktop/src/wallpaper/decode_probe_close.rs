// SPDX-License-Identifier: MIT
//! Debug-only Close failure control from the probe's own native IPC callback.
use super::*;

const PREFIX: &str = "decode_probe_close ";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    nonce: u64,
    probe_id: u64,
    blocked: bool,
}

impl Request {
    fn parse(body: &str) -> Option<Self> {
        if body.len() > 512 {
            return None;
        }
        let request: Self = serde_json::from_str(body).ok()?;
        (request.nonce > 0 && request.nonce <= 9_007_199_254_740_991).then_some(request)
    }

    fn matches(&self, source_id: u64, hosted_id: u64) -> bool {
        self.probe_id == source_id && source_id == hosted_id
    }
}

impl ProbeHost {
    pub(super) fn handle_close_probe(&mut self, source_id: u64, body: &str) -> bool {
        let Some(body) = body.strip_prefix(PREFIX) else {
            return false;
        };
        let Some(request) = Request::parse(body) else {
            return true;
        };
        let Some(probe) = self.current.as_mut().filter(|probe| probe.id == source_id) else {
            return true;
        };
        if let Some(surface) = probe.surface.as_mut() {
            let accepted = request.matches(source_id, probe.id);
            if accepted {
                surface.close_probe_blocked = request.blocked;
            }
            let _ = surface.webview.evaluate_script(&format!(
                "window.__nativeDecodeCloseProbe={};",
                serde_json::json!({"nonce":request.nonce,"accepted":accepted,"blocked":surface.close_probe_blocked})
            ));
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_control_requires_its_own_native_probe_and_bounded_payload() {
        let valid = serde_json::json!({"nonce":1,"probeId":7,"blocked":false});
        let request = Request::parse(&valid.to_string()).unwrap();
        assert!(request.matches(7, 7));
        assert!(!request.matches(8, 8));
        assert!(!request.matches(7, 8));
        assert!(!request.matches(8, 7));
        for (field, value) in [
            ("nonce", serde_json::json!(0)),
            ("nonce", serde_json::json!(9_007_199_254_740_992_u64)),
            ("unknown", serde_json::json!(true)),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(Request::parse(&invalid.to_string()).is_none());
        }
        assert!(Request::parse(&"x".repeat(513)).is_none());
    }
}
