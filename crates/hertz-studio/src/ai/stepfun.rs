// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Explicit StepFun Responses adapter. Unknown pricing does not block dispatch:
//! bounded requests use the durable token-only usage ledger and never claim a
//! zero-dollar price.

use super::jobs::{CompletionReply, ProviderCancellation, ProviderReply, StageIntentProvider};
use super::usage::{PriceQuote, PricingSnapshot, TOKEN_ONLY_PRICING_VERSION};
use crate::config::AiConfig;
use reqwest::{Client, Url};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

const RESPONSE_BYTES: usize = 256 * 1024;
const REQUEST_BYTES: usize = 64 * 1024;
const COMPLETION_OUTPUT_TOKENS: u64 = 8_000;
const DISABLED: &str = "StepFun model or bounded request configuration is unsupported";

fn origin(input: &str) -> Result<(&'static str, Url), &'static str> {
    let invalid = "StepFun origin must be https://api.stepfun.com/{v1|step_plan/v1}";
    if input.len() > 2048 || input.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(invalid);
    }
    let mut url = Url::parse(input).map_err(|_| invalid)?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.stepfun.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid);
    }
    let (canonical, path) = match url.path() {
        "/v1" | "/v1/" => ("https://api.stepfun.com/v1", "/v1/responses"),
        "/step_plan/v1" | "/step_plan/v1/" => (
            "https://api.stepfun.com/step_plan/v1",
            "/step_plan/v1/responses",
        ),
        _ => return Err(invalid),
    };
    url.set_path(path);
    Ok((canonical, url))
}

pub(super) fn credential_origin(input: &str) -> Result<&'static str, &'static str> {
    origin(input).map(|(canonical, _)| canonical)
}

fn client() -> Result<Client, &'static str> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .user_agent("HertzStudio/0.1 stepfun")
        .dns_resolver(crate::public_net::public_dns_resolver())
        .build()
        .map_err(|_| "cannot create isolated StepFun HTTP client")
}

fn token_only_quote(model: &str) -> Option<PriceQuote> {
    if model != "step-5-preview" {
        return None;
    }
    Some(PriceQuote {
        pricing_version: TOKEN_ONLY_PRICING_VERSION.into(),
        reservation_micro_usd: 0,
        input_micro_usd_per_million: 0,
        output_micro_usd_per_million: 0,
        max_input_tokens: 20_000,
        max_output_tokens: COMPLETION_OUTPUT_TOKENS,
    })
}

#[derive(Clone)]
pub(crate) struct StepFun {
    endpoint: Url,
    model: String,
    client: Client,
    pricing: Option<PriceQuote>,
}

pub(crate) fn configured(config: &AiConfig) -> Arc<dyn StageIntentProvider> {
    match StepFun::new(&config.origin, &config.model) {
        Ok(provider) => Arc::new(provider),
        Err(reason) => Arc::new(Unavailable(reason)),
    }
}

#[cfg(test)]
pub(super) fn configured_for_loopback(
    config: &AiConfig,
    loopback_origin: &str,
) -> Result<Arc<dyn StageIntentProvider>, &'static str> {
    let mut provider = StepFun::new(&config.origin, &config.model)?;
    let mut endpoint = Url::parse(loopback_origin).map_err(|_| "invalid test loopback origin")?;
    let loopback = endpoint
        .host_str()
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .is_some_and(|address| address.is_loopback());
    if endpoint.scheme() != "http"
        || !loopback
        || endpoint.port().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || !matches!(endpoint.path(), "" | "/")
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("test provider endpoint must be a numeric HTTP loopback origin");
    }
    endpoint.set_path(provider.endpoint.path());
    provider.endpoint = endpoint;
    Ok(Arc::new(provider))
}

impl StepFun {
    fn new(origin: &str, model: &str) -> Result<Self, &'static str> {
        if model.is_empty()
            || model.len() > 128
            || !model
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err("select a valid StepFun model identifier");
        }
        let (_, endpoint) = self::origin(origin)?;
        Ok(Self {
            endpoint,
            model: model.into(),
            client: client()?,
            pricing: token_only_quote(model),
        })
    }

    fn request(
        &self,
        system: &str,
        user: &str,
        quote: &PriceQuote,
        stage: bool,
    ) -> Result<Vec<u8>, String> {
        quote.validate().map_err(str::to_owned)?;
        if quote.max_input_tokens == 0
            || !(1..=COMPLETION_OUTPUT_TOKENS).contains(&quote.max_output_tokens)
        {
            return Err("StepFun token bound is not supported".into());
        }
        if user.len() > REQUEST_BYTES {
            return Err("StepFun input exceeds 64 KiB".into());
        }
        let mut body = json!({
            "model": self.model,
            "instructions": system,
            "input": user,
            "store": false,
            "stream": false,
            "max_output_tokens": quote.max_output_tokens,
            "reasoning": { "effort": "low" },
        });
        if stage {
            body["text"] = json!({ "format": {
                "type": "json_schema", "name": "hertz_stage_intent", "strict": false,
                "schema": super::provider::output_schema()
            }});
        }
        let bytes = serde_json::to_vec(&body).map_err(|_| "cannot encode StepFun request")?;
        if bytes.len() > REQUEST_BYTES {
            return Err("StepFun request exceeds 64 KiB".into());
        }
        if bytes.len() as u64 > quote.max_input_tokens {
            return Err("StepFun request exceeds the quoted input-token budget".into());
        }
        Ok(bytes)
    }

    fn stage_request(&self, brief: &str, quote: &PriceQuote) -> Result<Vec<u8>, String> {
        if brief.len() > super::jobs::MAX_INPUT_BYTES {
            return Err("StepFun brief exceeds byte limit".into());
        }
        self.request(&super::provider::stage_instructions(), brief, quote, true)
    }

    async fn execute(
        &self,
        body: Vec<u8>,
        credential: super::credential::ProviderCredential,
    ) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
        let mut authorization =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", credential.as_ref()))
                .map_err(|_| "StepFun credential cannot be encoded as an HTTP header")?;
        authorization.set_sensitive(true);
        let mut response = self
            .client
            .post(self.endpoint.clone())
            .header(reqwest::header::AUTHORIZATION, authorization)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .body(body)
            .send()
            .await
            .map_err(|_| "StepFun request failed or timed out")?;
        let status = response.status();
        if response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_some_and(|value| value != "identity")
        {
            return Err("StepFun returned an unsupported content encoding".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "StepFun response read failed")?
        {
            if bytes.len().saturating_add(chunk.len()) > RESPONSE_BYTES {
                return Err("StepFun response exceeds 256 KiB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((status, bytes))
    }
}

impl StageIntentProvider for StepFun {
    fn id(&self) -> &'static str {
        "stepfun"
    }

    fn endpoint_identity(&self) -> Option<&str> {
        Some(self.endpoint.as_str())
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn ready(&self) -> bool {
        self.pricing.as_ref().is_some_and(|quote| {
            quote.max_input_tokens > 0
                && (1..=COMPLETION_OUTPUT_TOKENS).contains(&quote.max_output_tokens)
                && quote.validate().is_ok()
        })
    }

    fn diagnostic(&self) -> Option<&'static str> {
        (!self.ready()).then_some(DISABLED)
    }

    fn requires_credential(&self) -> bool {
        true
    }

    fn quote(&self, brief: &str) -> Result<PriceQuote, String> {
        let quote = self.pricing.as_ref().ok_or(DISABLED)?;
        self.stage_request(brief, quote)?;
        Ok(quote.clone())
    }

    fn generate(
        &self,
        brief: String,
        pricing: PricingSnapshot,
        credential: Option<super::credential::ProviderCredential>,
        mut cancellation: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
        let provider = self.clone();
        Box::pin(async move {
            if !provider.ready() {
                return failed(DISABLED);
            }
            let quote = provider.pricing.as_ref().expect("ready pricing");
            if pricing.provider != provider.id()
                || pricing.model != provider.model
                || !super::provider::same_quote(&pricing.quote, quote)
                || pricing.credential.is_none()
            {
                return failed(
                    "StepFun pricing or credential snapshot does not match configuration",
                );
            }
            let Some(credential) = credential else {
                return failed("StepFun credential is unavailable");
            };
            let body = match provider.stage_request(&brief, quote) {
                Ok(body) => body,
                Err(reason) => return failed(&reason),
            };
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => failed("StepFun request cancelled"),
                response = provider.execute(body, credential) => match response {
                    Ok((status, bytes)) => {
                        let mut reply = super::provider::parse_openai_reply_with_pricing(
                            &bytes,
                            &provider.model,
                            pricing.pricing_known(),
                        );
                        if !status.is_success() {
                            reply.intent = Err(format!("StepFun HTTP status {}", status.as_u16()));
                        }
                        reply
                    }
                    Err(reason) => failed(&reason),
                },
            }
        })
    }

    fn complete(
        &self,
        system: String,
        user: String,
        credential: Option<super::credential::ProviderCredential>,
        mut cancellation: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<CompletionReply, String>> + Send>>
    {
        let provider = self.clone();
        Box::pin(async move {
            if !provider.ready() {
                return Err(DISABLED.into());
            }
            let Some(credential) = credential else {
                return Err("StepFun credential is unavailable".into());
            };
            let quote = provider.pricing.as_ref().ok_or(DISABLED)?;
            let body = provider.request(&system, &user, quote, false)?;
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err("StepFun request cancelled".into()),
                response = provider.execute(body, credential) => {
                    let (status, bytes) = response?;
                    let mut reply = super::provider::parse_openai_completion_with_pricing(
                        &bytes,
                        &provider.model,
                        false,
                    )?;
                    if !status.is_success() {
                        reply.text = Err(format!("StepFun HTTP status {}", status.as_u16()));
                    }
                    Ok(reply)
                }
            }
        })
    }
}

fn failed(reason: &str) -> ProviderReply {
    ProviderReply {
        intent: Err(reason.to_owned()),
        usage: None,
    }
}

struct Unavailable(&'static str);

impl StageIntentProvider for Unavailable {
    fn id(&self) -> &'static str {
        "unavailable"
    }
    fn model(&self) -> &str {
        ""
    }
    fn diagnostic(&self) -> Option<&'static str> {
        Some(self.0)
    }
    fn ready(&self) -> bool {
        false
    }
    fn quote(&self, _: &str) -> Result<PriceQuote, String> {
        Err(self.0.into())
    }
    fn generate(
        &self,
        _: String,
        _: PricingSnapshot,
        _: Option<super::credential::ProviderCredential>,
        _: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
        Box::pin(async {
            ProviderReply {
                intent: Err("StepFun is unavailable".into()),
                usage: None,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic rates only; this fixture must never enable production pricing.
    fn quote() -> PriceQuote {
        PriceQuote {
            pricing_version: "stepfun-loopback-fixture-v1".into(),
            reservation_micro_usd: 50_000,
            input_micro_usd_per_million: 1_000,
            output_micro_usd_per_million: 2_000,
            max_input_tokens: REQUEST_BYTES as u64,
            max_output_tokens: COMPLETION_OUTPUT_TOKENS,
        }
    }

    fn snapshot(provider: &StepFun) -> PricingSnapshot {
        PricingSnapshot {
            provider: provider.id().into(),
            model: provider.model.clone(),
            quote: provider.pricing.clone().unwrap_or_else(quote),
            credential: Some(super::super::credential::test_identity()),
        }
    }

    fn credential() -> Option<super::super::credential::ProviderCredential> {
        Some(super::super::credential::test_provider_credential(
            "stepfun-fixture-key",
        ))
    }

    fn fixture(endpoint: Url) -> StepFun {
        let mut provider =
            StepFun::new("https://api.stepfun.com/step_plan/v1", "step-5-preview").unwrap();
        // Private and test-only: the production constructor accepts no URL or
        // price override capable of bypassing its destination/pricing checks.
        provider.endpoint = endpoint;
        provider.pricing = Some(quote());
        provider
    }

    fn response(content: &str) -> serde_json::Value {
        json!({
            "model": "step-5-preview", "status": "completed",
            "output": [{"type":"message", "role":"assistant", "status":"completed",
                "content":[{"type":"output_text", "text":content, "annotations":[]}]}],
            "usage": {"input_tokens":33, "input_tokens_details":{"cached_tokens":0},
                "output_tokens":3, "output_tokens_details":{"reasoning_tokens":0}, "total_tokens":36}
        })
    }

    #[test]
    fn origin_and_model_are_bounded() {
        for base in [
            "https://api.stepfun.com/step_plan/v1",
            "https://api.stepfun.com/v1",
        ] {
            for suffix in ["", "/"] {
                let provider = StepFun::new(&format!("{base}{suffix}"), "step-5-preview").unwrap();
                assert_eq!(provider.endpoint.as_str(), format!("{base}/responses"));
                assert_eq!(credential_origin(&format!("{base}{suffix}")).unwrap(), base);
            }
        }
        for origin in [
            "http://api.stepfun.com/step_plan/v1",
            "https://api.stepfun.com.evil.example/step_plan/v1",
            "https://api.stepfun.com/other/v1",
            "https://api.stepfun.com/step_plan/v1?x=1",
            "https://user:key@api.stepfun.com/step_plan/v1",
            "https://api.stepfun.com:9443/step_plan/v1",
            "https://api.stepfun.com/step_plan/v1//",
            "https://api.stepfun.com/step_plan/v1#fragment",
            "https://api.stepfun.com/step_plan/v1\n",
        ] {
            assert!(StepFun::new(origin, "step-5-preview").is_err(), "{origin}");
        }
        assert!(StepFun::new("https://api.stepfun.com/v1", "step-5-preview").is_ok());
        for model in ["", "step 5", "step-5/other", "x\nheader"] {
            assert!(StepFun::new("https://api.stepfun.com/step_plan/v1", model).is_err());
        }
    }

    #[test]
    fn production_quote_marks_cost_unknown_but_keeps_token_bounds() {
        let provider =
            StepFun::new("https://api.stepfun.com/step_plan/v1", "step-5-preview").unwrap();
        let quote = provider.quote("dark orb").unwrap();
        assert_eq!(quote.pricing_version, TOKEN_ONLY_PRICING_VERSION);
        assert_eq!(quote.reservation_micro_usd, 0);
        assert_eq!(quote.input_micro_usd_per_million, 0);
        assert_eq!(quote.output_micro_usd_per_million, 0);
        assert_eq!(quote.max_input_tokens, 20_000);
        assert_eq!(quote.max_output_tokens, COMPLETION_OUTPUT_TOKENS);
    }

    #[test]
    fn production_response_keeps_verified_tokens_without_a_price() {
        let result = super::super::provider::parse_openai_reply_with_pricing(
            &serde_json::to_vec(&response(r#"{"version":1,"scene":"orb","patch":{}}"#)).unwrap(),
            "step-5-preview",
            false,
        );
        assert!(result.intent.is_ok());
        assert_eq!(
            result.usage,
            Some(super::super::usage::TrustedUsage {
                input_tokens: 33,
                output_tokens: 3,
            })
        );
    }

    #[test]
    fn completion_request_uses_low_reasoning_and_output_budget() {
        let provider =
            StepFun::new("https://api.stepfun.com/step_plan/v1", "step-5-preview").unwrap();
        let body = provider
            .request("classify", "{\"core\":[]}", &quote(), false)
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["model"], "step-5-preview");
        assert_eq!(value["input"], "{\"core\":[]}");
        assert_eq!(value["store"], false);
        assert_eq!(value["stream"], false);
        assert_eq!(value["max_output_tokens"], 8000);
        assert_eq!(value["reasoning"]["effort"], "low");
    }

    #[test]
    fn request_checks_complete_input_and_output_bounds() {
        let provider = StepFun::new("https://api.stepfun.com/v1", "step-5-preview").unwrap();
        let mut quote = quote();
        quote.max_input_tokens = 1;
        assert!(provider
            .stage_request("dark orb", &quote)
            .unwrap_err()
            .contains("input-token budget"));
        assert!(provider
            .request("long system", "x", &quote, false)
            .unwrap_err()
            .contains("input-token budget"));
        quote.max_output_tokens = COMPLETION_OUTPUT_TOKENS + 1;
        assert!(provider.stage_request("dark orb", &quote).is_err());
    }

    #[tokio::test]
    async fn missing_pricing_mismatched_snapshot_and_closed_cancellation_never_dispatch() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let mut provider = fixture(endpoint);
        let pricing = snapshot(&provider);
        provider.pricing = None;
        assert!(!provider.ready());
        assert_eq!(provider.diagnostic(), Some(DISABLED));
        assert_eq!(provider.quote("orb").unwrap_err(), DISABLED);
        assert_eq!(
            provider
                .generate(
                    "orb".into(),
                    pricing.clone(),
                    credential(),
                    Default::default()
                )
                .await
                .intent
                .unwrap_err(),
            DISABLED
        );
        assert_eq!(
            provider
                .complete(
                    "system".into(),
                    "user".into(),
                    credential(),
                    Default::default()
                )
                .await
                .err()
                .unwrap(),
            DISABLED
        );
        provider.pricing = Some(quote());
        for mutation in 0..4 {
            let mut mismatched = snapshot(&provider);
            match mutation {
                0 => mismatched.provider = "openai".into(),
                1 => mismatched.model = "another-model".into(),
                2 => mismatched.quote.pricing_version = "different-price".into(),
                _ => mismatched.credential = None,
            }
            assert!(provider
                .generate("orb".into(), mismatched, credential(), Default::default())
                .await
                .intent
                .is_err());
        }
        let (sender, receiver) = tokio::sync::watch::channel(());
        drop(sender);
        let reply = provider
            .generate(
                "orb".into(),
                snapshot(&provider),
                credential(),
                ProviderCancellation::from_receiver(receiver),
            )
            .await;
        assert_eq!(reply.intent.unwrap_err(), "StepFun request cancelled");
        provider.pricing.as_mut().unwrap().max_input_tokens = 1;
        assert!(provider.quote("orb").is_err());
        assert!(provider
            .generate(
                "orb".into(),
                snapshot(&provider),
                credential(),
                Default::default()
            )
            .await
            .intent
            .unwrap_err()
            .contains("input-token budget"));
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn stage_http_fixture_checks_contract_usage_and_invalid_paid_output() {
        use axum::{http::HeaderMap, routing::post, Json};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let app = axum::Router::new().route(
            "/step_plan/v1/responses",
            post(
                move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                    let seen = seen.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer stepfun-fixture-key");
                        assert!(!headers.contains_key("cookie"));
                        assert_eq!(body["model"], "step-5-preview");
                        assert_eq!(body["input"], "dark orb");
                        assert_eq!(body["store"], false);
                        assert_eq!(body["stream"], false);
                        assert!(body["instructions"]
                            .as_str()
                            .unwrap()
                            .contains("basePresetHashes"));
                        assert_eq!(body["text"]["format"]["type"], "json_schema");
                        assert_eq!(body["reasoning"]["effort"], "low");
                        assert!(body.get("tools").is_none());
                        let content = if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                            r#"{"version":1,"scene":"orb","patch":{}}"#
                        } else {
                            r#"{"version":1,"scene":"untrusted","patch":{}}"#
                        };
                        Json(response(content))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/step_plan/v1/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let provider = fixture(endpoint);
        let success = provider
            .generate(
                "dark orb".into(),
                snapshot(&provider),
                credential(),
                Default::default(),
            )
            .await;
        assert_eq!(success.intent.unwrap()["scene"], "orb");
        assert_eq!(success.usage.unwrap().output_tokens, 3);
        let invalid = provider
            .generate(
                "dark orb".into(),
                snapshot(&provider),
                credential(),
                Default::default(),
            )
            .await;
        assert!(invalid.intent.is_err());
        assert_eq!(invalid.usage.unwrap().input_tokens, 33);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test]
    async fn non_success_responses_keep_only_verified_stage_usage() {
        use axum::{http::StatusCode, routing::post, Json};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let app = axum::Router::new().route(
            "/responses",
            post(move || {
                let index = seen.fetch_add(1, Ordering::SeqCst);
                async move {
                    let content = if index < 2 {
                        r#"{"version":1,"scene":"orb","patch":{}}"#
                    } else {
                        r#"{"version":1}"#
                    };
                    let mut body = response(content);
                    match index {
                        1 => body["model"] = serde_json::json!("unexpected-model"),
                        3 => body["error"] = serde_json::json!({"code":"server_error"}),
                        _ => {}
                    }
                    (StatusCode::SERVICE_UNAVAILABLE, Json(body))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let provider = fixture(endpoint);

        let trusted = provider
            .generate(
                "dark orb".into(),
                snapshot(&provider),
                credential(),
                Default::default(),
            )
            .await;
        assert!(trusted.intent.unwrap_err().contains("HTTP status 503"));
        assert_eq!(trusted.usage.unwrap().input_tokens, 33);

        let untrusted = provider
            .generate(
                "dark orb".into(),
                snapshot(&provider),
                credential(),
                Default::default(),
            )
            .await;
        assert!(untrusted.intent.unwrap_err().contains("HTTP status 503"));
        assert!(untrusted.usage.is_none());
        for index in [2, 3] {
            let reply = provider
                .complete(
                    "classify".into(),
                    "{}".into(),
                    credential(),
                    Default::default(),
                )
                .await
                .unwrap();
            assert!(reply.text.unwrap_err().contains("HTTP status 503"));
            if index == 2 {
                assert_eq!(reply.usage.unwrap().input_tokens, 33);
            } else {
                assert!(reply.usage.is_none());
            }
        }
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn configured_token_only_http_job_records_usage_without_amount_gate() {
        use super::super::{credential as credentials, jobs};
        use axum::{http::HeaderMap, routing::post, Json};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let app = axum::Router::new().route(
            "/step_plan/v1/responses",
            post(
                move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                    seen.fetch_add(1, Ordering::SeqCst);
                    async move {
                        assert_eq!(headers["authorization"], "Bearer stepfun-fixture-key");
                        assert!(!headers.contains_key("cookie"));
                        assert_eq!(body["model"], "step-5-preview");
                        assert_eq!(body["store"], false);
                        assert_eq!(body["stream"], false);
                        assert_eq!(body["max_output_tokens"], COMPLETION_OUTPUT_TOKENS);
                        Json(response(r#"{"version":1,"scene":"orb","patch":{}}"#))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let loopback_origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = std::env::temp_dir().join(format!("hertz-stepfun-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (mut state, handle) = crate::state::tests::playback_state_with_db(db).await;
        let config = AiConfig {
            provider: "stepfun".into(),
            origin: "https://api.stepfun.com/step_plan/v1".into(),
            model: "step-5-preview".into(),
        };
        state.ai_runtime = jobs::AiRuntime::from_config(&config);
        let configured_provider = state.ai_runtime.provider().await;
        assert_eq!(configured_provider.id(), "stepfun");
        assert_eq!(configured_provider.model(), "step-5-preview");
        assert!(configured_provider.ready());
        let production_quote = configured_provider.quote("dark orb").unwrap();
        assert_eq!(production_quote.pricing_version, TOKEN_ONLY_PRICING_VERSION);
        assert_eq!(production_quote.reservation_micro_usd, 0);
        assert_eq!(production_quote.max_input_tokens, 20_000);
        assert_eq!(production_quote.max_output_tokens, COMPLETION_OUTPUT_TOKENS);
        state.ai_runtime.credentials = credentials::Service::isolated_for_config(&config);
        let provider = configured_for_loopback(&config, &loopback_origin).unwrap();
        let loopback_quote = provider.quote("dark orb").unwrap();
        assert_eq!(
            serde_json::to_value(loopback_quote).unwrap(),
            serde_json::to_value(production_quote).unwrap()
        );
        state.ai_runtime.install_provider(provider).await;
        state.ai_runner_held.store(true, Ordering::Relaxed);
        state.token = "stepfun-http-fixture-token".into();
        let state = Arc::new(state);
        vmusic_store::settings::set(&state.db, jobs::CONSENT_KEY, &json!(true))
            .await
            .unwrap();
        assert_eq!(
            jobs::submit(&state, "local-owner", "dark orb", None)
                .await
                .err()
                .unwrap()
                .code,
            "ai_credential_missing"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM ai_jobs")
                .fetch_one(&state.db)
                .await
                .unwrap(),
            0
        );
        let request =
            credentials::CredentialRequest::from_value(&json!({"api_key":"stepfun-fixture-key"}))
                .unwrap();
        let stored =
            serde_json::to_value(credentials::put(&state, request).await.unwrap()).unwrap();
        assert_eq!(stored["provider"], "stepfun");
        assert_eq!(stored["origin"], config.origin);
        let owner = jobs::instance_owner(&state).await.unwrap();
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        vmusic_store::ai_jobs::halt_budget_guard(
            &mut tx,
            &owner,
            "metered provider exceeded its limit",
            "metered-task",
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let api_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_address = api_listener.local_addr().unwrap();
        let api_state = state.clone();
        let api = crate::routes::router(api_state.clone()).with_state(api_state);
        let api_server = tokio::spawn(async move {
            axum::serve(api_listener, api).await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let api_origin = format!("http://{api_address}");
        let status: serde_json::Value = client
            .get(format!("{api_origin}/v1/ai/status"))
            .bearer_auth("stepfun-http-fixture-token")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["provider"]["id"], "stepfun");
        assert_eq!(status["provider"]["pricingMode"], "token_only");
        assert_eq!(status["guard"]["halted"], true);
        let budget_before = status["budget"].clone();
        let key = format!(
            "v1.{}.{}",
            vmusic_store::now_ms(),
            uuid::Uuid::new_v4().simple()
        );
        let submit = || {
            client
                .post(format!("{api_origin}/v1/ai/jobs"))
                .bearer_auth("stepfun-http-fixture-token")
                .json(&json!({"brief":"dark orb", "idempotency_key":key}))
        };
        let first: serde_json::Value = submit()
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(first["outcome"], "accepted");
        let job_id = first["job"]["jobId"].as_str().unwrap().to_owned();
        let second: serde_json::Value = submit()
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(second["outcome"], "replayed");
        assert_eq!(second["job"]["jobId"], job_id);
        let job_url = format!("{api_origin}/v1/ai/jobs/{job_id}");
        let mut job: serde_json::Value = serde_json::Value::Null;
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                job = client
                    .get(&job_url)
                    .bearer_auth("stepfun-http-fixture-token")
                    .send()
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                if !matches!(job["state"].as_str(), Some("accepted" | "running")) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(job["state"], "succeeded");
        assert_eq!(job["provider"], "stepfun");
        assert_eq!(job["model"], "step-5-preview");
        assert_eq!(job["usage"]["usageState"], "unpriced");
        assert_eq!(job["usage"]["pricingKnown"], false);
        assert_eq!(job["usage"]["accountedMicroUsd"], serde_json::Value::Null);
        assert_eq!(job["usage"]["reportedUsage"]["inputTokens"], 33);
        assert_eq!(job["usage"]["reportedUsage"]["outputTokens"], 3);
        let month = job["usage"]["acceptedMonth"].as_str().unwrap();
        let ledger: serde_json::Value = client
            .get(format!(
                "{api_origin}/v1/ai/ledger?month={month}&usage_state=unpriced"
            ))
            .bearer_auth("stepfun-http-fixture-token")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ledger["entries"].as_array().unwrap().len(), 1);
        assert_eq!(ledger["entries"][0]["jobId"], job_id);
        assert_eq!(
            ledger["entries"][0]["accountedMicroUsd"],
            serde_json::Value::Null
        );
        assert_eq!(ledger["entries"][0]["reportedUsage"]["inputTokens"], "33");
        assert_eq!(ledger["entries"][0]["reportedUsage"]["outputTokens"], "3");
        assert_eq!(
            ledger["budget"]["chargedMicroUsd"],
            budget_before["chargedMicroUsd"]
                .as_i64()
                .unwrap()
                .to_string()
        );
        assert_eq!(
            ledger["budget"]["reservedMicroUsd"],
            budget_before["reservedMicroUsd"]
                .as_i64()
                .unwrap()
                .to_string()
        );
        assert_eq!(ledger["guard"]["halted"], true);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let final_status: serde_json::Value = client
            .get(format!("{api_origin}/v1/ai/status"))
            .bearer_auth("stepfun-http-fixture-token")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(final_status["budget"], budget_before);
        assert_eq!(final_status["guard"]["halted"], true);
        state.audio.shutdown();
        handle.join().unwrap();
        state.db.close().await;
        api_server.abort();
        let _ = api_server.await;
        server.abort();
        let _ = server.await;
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn transport_rejects_redirects_errors_and_oversized_bodies_without_retry() {
        use axum::{
            body::Body,
            http::{Response, StatusCode},
            routing::post,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (status, oversized) in [
            (StatusCode::TEMPORARY_REDIRECT, false),
            (StatusCode::SERVICE_UNAVAILABLE, false),
            (StatusCode::OK, true),
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let seen = calls.clone();
            let app = axum::Router::new().route(
                "/responses",
                post(move || {
                    seen.fetch_add(1, Ordering::SeqCst);
                    async move {
                        let chunks = futures::stream::iter(
                            (0..if oversized { 5 } else { 1 })
                                .map(|_| Ok::<_, std::io::Error>(vec![b'x'; 65_536])),
                        );
                        Response::builder()
                            .status(status)
                            .header("location", "/responses")
                            .body(Body::from_stream(chunks))
                            .unwrap()
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = Url::parse(&format!(
                "http://{}/responses",
                listener.local_addr().unwrap()
            ))
            .unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let provider = fixture(endpoint);
            let result = provider
                .generate(
                    "orb".into(),
                    snapshot(&provider),
                    credential(),
                    Default::default(),
                )
                .await;
            let error = result.intent.unwrap_err();
            assert!(if oversized {
                error.contains("256 KiB")
            } else {
                error.contains("HTTP status")
            });
            assert!(result.usage.is_none());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            server.abort();
        }
    }

    #[tokio::test]
    async fn cancellation_closes_transport_during_headers_and_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for partial_body in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = Url::parse(&format!(
                "http://{}/responses",
                listener.local_addr().unwrap()
            ))
            .unwrap();
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let peer = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buf = [0; 4096];
                loop {
                    let n = socket.read(&mut buf).await.unwrap();
                    assert_ne!(n, 0);
                    request.extend_from_slice(&buf[..n]);
                    if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                if partial_body {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"model\":").await.unwrap();
                }
                ready_tx.send(()).unwrap();
                let closed = tokio::time::timeout(Duration::from_secs(2), socket.read(&mut buf))
                    .await
                    .expect("cancelled StepFun transport is still open");
                match closed {
                    Ok(n) => assert_eq!(n, 0),
                    Err(error) => assert!(matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                    )),
                }
                assert!(
                    tokio::time::timeout(Duration::from_millis(30), listener.accept())
                        .await
                        .is_err()
                );
            });
            let provider = fixture(endpoint);
            let (sender, receiver) = tokio::sync::watch::channel(());
            let call = tokio::spawn(provider.generate(
                "orb".into(),
                snapshot(&provider),
                credential(),
                ProviderCancellation::from_receiver(receiver),
            ));
            tokio::time::timeout(Duration::from_secs(2), ready_rx)
                .await
                .unwrap()
                .unwrap();
            sender.send(()).unwrap();
            let reply = tokio::time::timeout(Duration::from_secs(2), call)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(reply.intent.unwrap_err(), "StepFun request cancelled");
            assert!(reply.usage.is_none());
            peer.await.unwrap();
        }
    }
}
