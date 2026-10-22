// SPDX-License-Identifier: MIT

//! Bounded StageIntent evaluation entry points. The standalone CLI remains
//! separate from player boot; the managed path reuses app-owned provider state
//! for one synthetic case and emits only a validated intent and fixed metadata.

use super::jobs::{ProviderCancellation, StageIntentProvider, RUN_DEADLINE_MS};
use super::provider::Ollama;
use super::usage::PricingSnapshot;
use crate::error::{bad_request, internal, ApiError, ApiResult};
use crate::state::AppState;
use axum::http::StatusCode;
use futures::FutureExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(crate) const CASE_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Case {
    pub(crate) case_id: String,
    pub(crate) brief: String,
}

fn case(bytes: &[u8]) -> anyhow::Result<Case> {
    let value = super::strict_json::parse(bytes, CASE_BYTES, 8).map_err(anyhow::Error::msg)?;
    let case: Case = serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("invalid evaluation case fields"))?;
    anyhow::ensure!(
        !case.case_id.is_empty()
            && case.case_id.len() <= 80
            && case
                .case_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)),
        "invalid caseId"
    );
    anyhow::ensure!(
        !case.brief.trim().is_empty() && case.brief.len() <= super::jobs::MAX_INPUT_BYTES,
        "evaluation brief must contain 1..16384 UTF-8 bytes"
    );
    Ok(case)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// A dropped HTTP observer must signal the detached, non-persistent provider task.
struct CancelEvaluationOnDrop(tokio::sync::watch::Sender<()>);

impl Drop for CancelEvaluationOnDrop {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

fn failure_kind(reason: &str) -> &'static str {
    match reason {
        "description is outside static create support" => "refused",
        r if r.contains("truncated") || r.contains("incomplete") => "truncated",
        r if r.contains("intent violates the stage contract") => "invalid_intent",
        r if r.contains("JSON") => "invalid_json",
        r if r.contains("plain structured") || r.contains("content is missing") => {
            "invalid_protocol"
        }
        r if r.contains("HTTP status") => "provider_error",
        _ => "transport_or_configuration",
    }
}

fn validate_case_fields(case_id: &str, brief: &str) -> ApiResult<()> {
    if case_id.is_empty()
        || case_id.len() > 80
        || !case_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err(bad_request("caseId 格式无效"));
    }
    if brief.trim().is_empty() || brief.len() > super::jobs::MAX_INPUT_BYTES {
        return Err(bad_request("brief 必须是 1..16384 UTF-8 字节"));
    }
    Ok(())
}

/// Safe provider identity and admission state for the explicit evaluator CLI.
/// It does not expose an endpoint, credential, or accounting data.
pub(crate) async fn managed_status(state: &Arc<AppState>) -> ApiResult<Value> {
    let provider = state.ai_runtime.provider().await;
    Ok(json!({
        "provider": provider.id(),
        "model": provider.model(),
        "providerReady": provider.ready(),
        "generationConsent": super::jobs::generation_consent_enabled(state).await?,
        "runnerReady": state.ai_runner_held(),
    }))
}

/// Runs one synthetic case through the app-owned provider without persisting a
/// job, prompt, proposal, token count, or price. The detached task owns cleanup
/// when its HTTP observer is dropped and is registered before reading a key.
pub(crate) async fn managed_case(state: &Arc<AppState>, case: Case) -> ApiResult<Value> {
    validate_case_fields(&case.case_id, &case.brief)?;
    if !state.ai_runner_held() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_locked",
            "本进程未持有 AI runner 锁，评测停用",
        ));
    }
    if !super::jobs::generation_consent_enabled(state).await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "generation_disabled",
            "生成功能已关闭",
        ));
    }
    let slot = state.ai_runtime.try_evaluation_slot().ok_or_else(|| {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "ai_execution_busy",
            "模型执行槽正在使用，请稍后重试",
        )
    })?;
    let provider = state.ai_runtime.provider().await;
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(());
    let evaluation_id = uuid::Uuid::new_v4().to_string();
    state
        .ai_runtime
        .register_evaluation(
            evaluation_id.clone(),
            cancel_tx.clone(),
            provider.requires_credential(),
        )
        .await;
    let _request_cancellation = CancelEvaluationOnDrop(cancel_tx);

    let state = state.clone();
    let evaluation_task = tokio::spawn(async move {
        let _slot = slot;
        let result = AssertUnwindSafe(run_managed_case(state.clone(), case, provider, cancel_rx))
            .catch_unwind()
            .await;
        state.ai_runtime.remove_evaluation(&evaluation_id).await;
        match result {
            Ok(response) => response,
            Err(_) => Err(internal("评测 provider 执行异常")),
        }
    });
    evaluation_task
        .await
        .map_err(|_| internal("评测 provider 执行中断"))?
}

async fn run_managed_case(
    state: Arc<AppState>,
    case: Case,
    provider: Arc<dyn StageIntentProvider>,
    cancel_rx: tokio::sync::watch::Receiver<()>,
) -> ApiResult<Value> {
    if !provider.ready() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider_unavailable",
            "生成 provider 当前不可用于评测",
        ));
    }
    let quote = provider.quote(&case.brief).map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "evaluation_unavailable",
            "provider 无法接受该评测输入",
        )
    })?;
    quote.validate().map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "evaluation_unavailable",
            "provider 请求边界当前不可用",
        )
    })?;
    let provider_id = provider.id();
    let model = provider.model().to_string();
    let contract = super::contract::page(0, super::contract::scenes().len());
    let schema_hash = contract["schemaHash"].clone();
    let protocol_identity = json!({
        "version": "managed-stage-intent-v1",
        "provider": provider_id,
        "model": model.clone(),
        "endpointSha256": hash(provider.endpoint_identity().unwrap_or("").as_bytes()),
        "schemaHash": schema_hash.clone(),
    });
    let protocol_bytes =
        serde_json::to_vec(&protocol_identity).map_err(|_| internal("评测协议指纹生成失败"))?;
    let protocol_fingerprint = hash(&protocol_bytes);
    let brief_hash = hash(case.brief.as_bytes());
    let case_id = case.case_id.clone();
    let request_identity = json!({
        "version": 1,
        "caseId": case_id.clone(),
        "briefSha256": brief_hash,
        "provider": provider_id,
        "model": model.clone(),
        "protocolFingerprint": protocol_fingerprint.clone(),
    });
    let request_bytes =
        serde_json::to_vec(&request_identity).map_err(|_| internal("评测请求指纹生成失败"))?;
    let request_hash = hash(&request_bytes);
    let cancellation = ProviderCancellation::from_receiver(cancel_rx);
    let cancelled_response = |elapsed_ms| {
        json!({
            "evaluationVersion": 1,
            "caseId": case_id,
            "provider": provider_id,
            "model": model,
            "schemaHash": schema_hash,
            "protocolFingerprint": protocol_fingerprint,
            "requestHash": request_hash,
            "elapsedMs": elapsed_ms,
            "kind": "cancelled",
            "intent": null,
            "accounting": "not_recorded",
        })
    };
    if cancellation.is_cancelled() {
        return Ok(cancelled_response(0));
    }
    if !super::jobs::generation_consent_enabled(&state).await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "generation_disabled",
            "生成功能已关闭",
        ));
    }
    let owner = super::jobs::instance_owner(&state).await?;
    if cancellation.is_cancelled() {
        return Ok(cancelled_response(0));
    }
    let credential = if provider.requires_credential() {
        Some(state.ai_runtime.credentials.snapshot(&owner).await?)
    } else {
        None
    };
    let pricing = PricingSnapshot {
        provider: provider_id.to_string(),
        model: model.clone(),
        quote,
        credential: credential.as_ref().map(super::credential::Lease::identity),
    };
    let credential = credential.map(super::credential::Lease::into_secret);
    if cancellation.is_cancelled() {
        return Ok(cancelled_response(0));
    }
    let started = Instant::now();
    let observed_cancellation = cancellation.clone();
    let generated = tokio::time::timeout(
        Duration::from_millis(RUN_DEADLINE_MS as u64),
        provider.generate(case.brief, pricing, credential, cancellation),
    )
    .await;
    let elapsed = started.elapsed().as_millis() as u64;
    let (kind, intent) = if observed_cancellation.is_cancelled() {
        ("cancelled", None)
    } else {
        match generated {
            Err(_) => ("timeout", None),
            Ok(reply) => match reply.intent {
                Ok(intent)
                    if super::contract::validate_intent(&intent).is_ok()
                        && super::contract::validate_artifact(&super::contract::artifact(
                            &intent,
                        ))
                        .is_ok() =>
                {
                    ("candidate", Some(intent))
                }
                Ok(_) => ("invalid_intent", None),
                Err(reason) => (failure_kind(&reason), None),
            },
        }
    };
    Ok(json!({
        "evaluationVersion": 1,
        "caseId": case_id,
        "provider": provider_id,
        "model": model,
        "schemaHash": schema_hash,
        "protocolFingerprint": protocol_fingerprint,
        "requestHash": request_hash,
        "elapsedMs": elapsed,
        "kind": kind,
        "intent": intent,
        "accounting": "not_recorded",
    }))
}

async fn evaluate(origin: &str, model: &str, case: Case) -> anyhow::Result<Value> {
    let provider = Ollama::new(origin, model).map_err(anyhow::Error::msg)?;
    let quote = provider.quote(&case.brief).map_err(anyhow::Error::msg)?;
    quote.validate().map_err(anyhow::Error::msg)?;
    let request = provider.request(&case.brief).map_err(anyhow::Error::msg)?;
    let protocol = provider.request("").map_err(anyhow::Error::msg)?;
    let pricing = PricingSnapshot {
        provider: provider.id().into(),
        model: model.into(),
        quote,
        credential: None,
    };
    let started = Instant::now();
    let outcome = tokio::time::timeout(
        Duration::from_millis(RUN_DEADLINE_MS as u64),
        provider.generate(case.brief, pricing.clone(), None, Default::default()),
    )
    .await;
    let elapsed = started.elapsed().as_millis() as u64;
    let (kind, intent, usage) = match outcome {
        Ok(reply) => match reply.intent {
            Ok(intent) => ("candidate", Some(intent), reply.usage),
            Err(reason) => (failure_kind(&reason), None, reply.usage),
        },
        Err(_) => ("timeout", None, None),
    };
    let contract = super::contract::page(0, super::contract::scenes().len());
    let usage = usage.map(|usage| {
        json!({"inputTokens":usage.input_tokens.to_string(),
        "outputTokens":usage.output_tokens.to_string(),
        "withinOutputBound":usage.output_tokens <= pricing.quote.max_output_tokens})
    });
    Ok(json!({"evaluationVersion":1, "caseId":case.case_id,
        "provider":provider.id(), "model":model, "buildVersion":env!("CARGO_PKG_VERSION"),
        "protocolFingerprint":hash(&protocol), "requestHash":hash(&request),
        "requestBytes":request.len(), "schemaHash":contract["schemaHash"],
        "basePresetHashes":contract["basePresetHashes"], "elapsedMs":elapsed,
        "kind":kind, "intent":intent, "usage":usage,
        "pricingVersion":pricing.quote.pricing_version,
        "reservationMicroUsd":"0", "localPriceMicroUsd":"0",
        "externalInvoiceVerified":false, "humanSemanticPass":null}))
}

/// CLI only: `--evaluate-stage --origin http://127.0.0.1:11434 --model NAME`.
/// Stdin is a single case JSON, bounded before parsing. No DataDir or keys.
pub async fn run_stdio() -> anyhow::Result<()> {
    let mut origin = None;
    let mut model = None;
    let mut args = std::env::args().skip(2);
    while let Some(arg) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| anyhow::anyhow!("missing evaluation option value"))?;
        match arg.as_str() {
            "--origin" if origin.is_none() => origin = Some(value),
            "--model" if model.is_none() => model = Some(value),
            _ => anyhow::bail!("unknown or duplicate evaluation option"),
        }
    }
    let origin = origin.ok_or_else(|| anyhow::anyhow!("evaluation requires explicit --origin"))?;
    let model = model.ok_or_else(|| anyhow::anyhow!("evaluation requires explicit --model"))?;
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(CASE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    let result = evaluate(&origin, &model, case(&bytes)?).await?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluation_cases_are_bounded_and_do_not_accept_configuration_or_duplicate_fields() {
        assert!(case(br#"{"caseId":"dev-1","brief":"static orb"}"#).is_ok());
        for bytes in [
            br#"{"caseId":"a","brief":"x","brief":"y"}"#.as_slice(),
            br#"{"caseId":"../a","brief":"x"}"#,
            br#"{"caseId":"a","brief":"x","apiKey":"secret"}"#,
            br#"{"caseId":"a","brief":" "}"#,
        ] {
            assert!(case(bytes).is_err());
        }
        assert!(case(&vec![b' '; CASE_BYTES + 1]).is_err());
    }

    #[test]
    fn dropping_the_request_observer_cancels_the_provider() {
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(());
        let cancellation = ProviderCancellation::from_receiver(cancel_rx);
        let observer = CancelEvaluationOnDrop(cancel_tx);

        assert!(!cancellation.is_cancelled());
        drop(observer);
        assert!(cancellation.is_cancelled());
    }
}
