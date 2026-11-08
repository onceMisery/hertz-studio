// SPDX-License-Identifier: MIT
//! Duplicate-launch recovery through the existing authenticated service.
use serde::Deserialize;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

#[derive(Deserialize)]
struct Discovery {
    port: u16,
    token: String,
    data_dir: String,
    edition: String,
    server_instance_id: String,
}

fn read_bounded(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn discover(data_dir: &Path) -> Option<Discovery> {
    let discovery: Discovery =
        serde_json::from_slice(&read_bounded(&data_dir.join("vmusicd.json"), 16384)?).ok()?;
    let token = String::from_utf8(read_bounded(&data_dir.join("token"), 256)?).ok()?;
    if discovery.port == 0
        || discovery.edition != crate::edition::NAME
        || token.trim().is_empty()
        || token.trim() != discovery.token
        || uuid::Uuid::parse_str(&discovery.server_instance_id).is_err()
        || std::fs::canonicalize(&discovery.data_dir).ok()?
            != std::fs::canonicalize(data_dir).ok()?
    {
        return None;
    }
    Some(discovery)
}

/// Call only after losing the DataDir lock. Missing/stale discovery never
/// permits boot, redirects are refused, and no token/path enters diagnostics.
pub async fn focus_existing(data_dir: &Path) -> anyhow::Result<bool> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(750))
        .build()?;
    let recovery = async {
        loop {
            if let Some(discovery) = discover(data_dir) {
                let response = client
                    .post(format!(
                        "http://127.0.0.1:{}/v1/window/focus",
                        discovery.port
                    ))
                    .bearer_auth(&discovery.token)
                    .json(&serde_json::json!({"serverInstanceId":discovery.server_instance_id}))
                    .send()
                    .await;
                if let Ok(mut response) = response {
                    if response.status().is_success() {
                        let mut bytes = Vec::new();
                        while let Some(chunk) = response.chunk().await? {
                            if bytes.len() + chunk.len() > 4096 {
                                return Ok(false);
                            }
                            bytes.extend_from_slice(&chunk);
                        }
                        let body: serde_json::Value = serde_json::from_slice(&bytes)?;
                        return Ok(body["focused"] == true
                            && body["serverInstanceId"] == discovery.server_instance_id);
                    }
                    if response.status() == reqwest::StatusCode::NOT_FOUND
                        || response.status() == reqwest::StatusCode::UNAUTHORIZED
                    {
                        return Ok(false);
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), recovery)
        .await
        .unwrap_or(Ok(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wrong_profile_token_edition_and_oversized_discovery_are_rejected() {
        let dir = std::env::temp_dir().join(format!("hertz-focus-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("token"), "fixture-token").unwrap();
        let original = serde_json::json!({"port":1234,"token":"fixture-token","edition":crate::edition::NAME,
            "data_dir":dir,"server_instance_id":uuid::Uuid::new_v4()});
        std::fs::write(dir.join("vmusicd.json"), original.to_string()).unwrap();
        assert!(discover(&dir).is_some());
        for (field, value) in [
            ("port", serde_json::json!(0)),
            ("token", serde_json::json!("wrong")),
            ("edition", serde_json::json!("wrong")),
            ("server_instance_id", serde_json::json!("not-an-instance")),
            ("data_dir", serde_json::json!(dir.join("missing"))),
        ] {
            let mut changed = original.clone();
            changed[field] = value;
            std::fs::write(dir.join("vmusicd.json"), changed.to_string()).unwrap();
            assert!(discover(&dir).is_none(), "{field}");
        }
        std::fs::write(dir.join("vmusicd.json"), vec![b' '; 16385]).unwrap();
        assert!(discover(&dir).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
