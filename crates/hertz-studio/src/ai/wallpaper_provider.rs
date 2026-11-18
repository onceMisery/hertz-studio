// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Builtin wallpaper contract and its local Ollama adapter. The selected
//! scene's request schema comes from the native catalog; jobs still owns the
//! single execution slot, cancellation, usage and artifact publication.

use super::jobs::{
    ProviderCancellation, StageIntentProvider, WallpaperOutputError, WallpaperReply,
};
use super::provider::{Ollama, LOCAL_PRICE_VERSION, REQUEST_BYTES};
use super::usage::{PriceQuote, PricingSnapshot};
use hertz_wallpaper::generation::{WallpaperGenerateRequest, WallpaperGenerationKind};
use serde_json::{json, Map, Value};

pub(super) const OUTPUT_TOKENS: u64 = 4096;
const INVALID_REQUEST: &str = "local wallpaper request violates the generation contract";

/// Contract-owned content shared by bounded provider transports.
pub(super) struct PreparedWallpaper {
    pub schema: Value,
    pub system: String,
    pub user: String,
}

fn schema(request: &WallpaperGenerateRequest) -> Result<Value, &'static str> {
    request.validate().map_err(|_| INVALID_REQUEST)?;
    if request.output.kind != WallpaperGenerationKind::Builtin {
        return Err(INVALID_REQUEST);
    }
    let scene = request
        .output
        .scene_id
        .as_deref()
        .and_then(|id| hertz_wallpaper::catalog().scene(id))
        .ok_or(INVALID_REQUEST)?;
    let definitions = scene["params"].as_object().ok_or(INVALID_REQUEST)?;
    let mut properties = Map::new();
    for (name, definition) in definitions {
        let mut property = match definition["type"].as_str() {
            Some("number") => {
                let mut property = json!({"type":"number"});
                for (source, target) in [("min", "minimum"), ("max", "maximum")] {
                    if let Some(bound) = definition.get(source) {
                        property[target] = bound.clone();
                    }
                }
                property
            }
            Some("boolean") => json!({"type":"boolean"}),
            Some("select") => {
                let options = definition["options"]
                    .as_array()
                    .ok_or(INVALID_REQUEST)?
                    .iter()
                    .map(|option| {
                        option
                            .as_str()
                            .or_else(|| option["value"].as_str())
                            .map(str::to_owned)
                            .ok_or(INVALID_REQUEST)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if options.is_empty() {
                    return Err(INVALID_REQUEST);
                }
                json!({"type":"string", "enum":options})
            }
            _ => return Err(INVALID_REQUEST),
        };
        if let Some(default) = definition.get("default") {
            property["default"] = default.clone();
        }
        if let Some(label) = definition.get("label") {
            property["description"] = label.clone();
        }
        properties.insert(name.clone(), property);
    }
    Ok(json!({"oneOf":[
        {"type":"object", "additionalProperties":false,
         "required":["kind","sceneId","stateVersion","params"],
         "properties":{
            "kind":{"const":"builtin"},
            "sceneId":{"const":scene["id"]},
            "stateVersion":{"const":scene["stateVersion"]},
            "params":{"type":"object","additionalProperties":false,"properties":properties}
         }},
        {"type":"object","additionalProperties":false,
         "required":["unsupported"],"properties":{"unsupported":{"const":true}}}
    ]}))
}

pub(super) fn prepare(input: &WallpaperGenerateRequest) -> Result<PreparedWallpaper, &'static str> {
    let schema = schema(input)?;
    let system = format!(
        "Create one new desktop wallpaper for the selected builtin scene. \
         Return only one JSON object matching this schema: {schema}. \
         Keep kind, sceneId and stateVersion exactly as specified. \
         Interpret the user description using the published parameter meanings, \
         types and ranges. Params may be sparse; omitted values keep the listed defaults. \
         Do not generate code, URLs, files, tools, timelines or changes to other scenes. \
         If the description requires unsupported behavior, return {{\"unsupported\":true}}."
    );
    Ok(PreparedWallpaper {
        schema,
        system,
        user: input.brief.clone(),
    })
}

fn request(model: &str, input: &WallpaperGenerateRequest) -> Result<Vec<u8>, &'static str> {
    let prepared = prepare(input)?;
    let body = serde_json::to_vec(&json!({
        "model":model,"stream":false,"think":false,
        "messages":[{"role":"system","content":prepared.system},
                    {"role":"user","content":prepared.user}],
        "format":prepared.schema,
        "options":{"num_predict":OUTPUT_TOKENS,"temperature":0}
    }))
    .map_err(|_| INVALID_REQUEST)?;
    if body.len() > REQUEST_BYTES {
        return Err("complete local wallpaper request exceeds byte limit");
    }
    Ok(body)
}

pub(super) fn quote(
    provider: &Ollama,
    input: &WallpaperGenerateRequest,
) -> Result<PriceQuote, String> {
    request(provider.model(), input).map_err(str::to_owned)?;
    Ok(PriceQuote {
        pricing_version: LOCAL_PRICE_VERSION.into(),
        reservation_micro_usd: 0,
        input_micro_usd_per_million: 0,
        output_micro_usd_per_million: 0,
        max_input_tokens: REQUEST_BYTES as u64,
        max_output_tokens: OUTPUT_TOKENS,
        metering: None,
    })
}

fn failed(reason: &str) -> WallpaperReply {
    WallpaperReply {
        output: Err(reason.into()),
        usage: None,
    }
}

pub(super) fn decode(
    input: &WallpaperGenerateRequest,
    text: &str,
) -> Result<Value, WallpaperOutputError> {
    let output = super::wallpaper_jobs::validate_builtin_output(input, text.as_bytes())
        .map_err(|_| WallpaperOutputError::Rejected)?;
    serde_json::to_value(output).map_err(|_| WallpaperOutputError::Rejected)
}

pub(super) async fn generate(
    provider: Ollama,
    input: WallpaperGenerateRequest,
    pricing: PricingSnapshot,
    mut cancellation: ProviderCancellation,
) -> WallpaperReply {
    if pricing.provider != provider.id()
        || pricing.model != provider.model()
        || pricing.credential.is_some()
        || pricing.quote.pricing_version != LOCAL_PRICE_VERSION
        || pricing.quote.reservation_micro_usd != 0
        || pricing.quote.input_micro_usd_per_million != 0
        || pricing.quote.output_micro_usd_per_million != 0
        || pricing.quote.max_input_tokens != REQUEST_BYTES as u64
        || pricing.quote.max_output_tokens != OUTPUT_TOKENS
    {
        return failed("local wallpaper pricing snapshot does not match configuration");
    }
    let body = match request(provider.model(), &input) {
        Ok(body) => body,
        Err(reason) => return failed(reason),
    };
    // The same owned HTTP future and envelope parser as local completion, with
    // a dedicated schema/body. No generic completion or Stage generation call.
    let reply = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return failed("local model request cancelled"),
        reply = provider.completion_execute(body) => reply,
    };
    match reply {
        Ok(reply) => WallpaperReply {
            output: reply
                .text
                .map_err(WallpaperOutputError::Provider)
                .and_then(|text| decode(&input, &text)),
            usage: reply.usage,
        },
        Err(reason) => failed(&reason),
    }
}

#[cfg(test)]
mod tests;
