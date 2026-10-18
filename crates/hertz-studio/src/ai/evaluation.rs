// SPDX-License-Identifier: MIT

//! Local-only evaluation entry point, deliberately separate from player boot.
//! It accepts one bounded synthetic case, makes at most one local model call,
//! and emits only validated intent/normalized counters and fixed diagnostics.

use super::jobs::{StageIntentProvider, RUN_DEADLINE_MS};
use super::provider::Ollama;
use super::usage::PricingSnapshot;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::time::{Duration, Instant};

const CASE_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Case {
    case_id: String,
    brief: String,
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

fn failure_kind(reason: &str) -> &'static str {
    match reason {
        "description is outside static create support" => "refused",
        "local model output was truncated" => "truncated",
        "local model intent violates the stage contract" => "invalid_intent",
        r if r.starts_with("provider JSON") => "invalid_json",
        "local model did not complete a plain structured response"
        | "local model content is missing" => "invalid_protocol",
        _ => "transport_or_configuration",
    }
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
}
