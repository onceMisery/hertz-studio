// SPDX-License-Identifier: MIT
//! Wallpaper Responses bodies reuse the existing OpenAI transport and runner.

use super::{ensure_input_budget, openai_token_only_quote, same_quote, OpenAi, REQUEST_BYTES};
use crate::ai::credential::ProviderCredential;
use crate::ai::jobs::{
    ProviderCancellation, StageIntentProvider, WallpaperOutputError, WallpaperReply,
};
use crate::ai::usage::{PriceQuote, PricingSnapshot};
use crate::ai::{composition_provider, wallpaper_provider};
use hertz_wallpaper::generation::composition::AssetSet;
use hertz_wallpaper::generation::{WallpaperGenerateRequest, WallpaperGenerationKind};
use serde_json::json;

fn request(
    provider: &OpenAi,
    input: &WallpaperGenerateRequest,
    assets: Option<&AssetSet>,
    quote: &PriceQuote,
) -> Result<Vec<u8>, String> {
    let (prepared, name, output_tokens) = match (input.output.kind, assets) {
        (WallpaperGenerationKind::Builtin, None) => (
            wallpaper_provider::prepare(input).map_err(str::to_owned)?,
            "hertz_wallpaper_builtin",
            wallpaper_provider::OUTPUT_TOKENS,
        ),
        (WallpaperGenerationKind::Composition, Some(assets)) => (
            composition_provider::prepare(input, assets)?,
            "hertz_wallpaper_composition",
            composition_provider::OUTPUT_TOKENS,
        ),
        _ => return Err("wallpaper output type and selected metadata do not match".into()),
    };
    if quote.max_output_tokens != output_tokens {
        return Err("wallpaper output limit does not match the selected type".into());
    }
    let body = serde_json::to_vec(&json!({
        "model": provider.model,
        "instructions": prepared.system,
        "input": prepared.user,
        "store": false,
        "stream": false,
        "reasoning": {"effort":"low"},
        "max_output_tokens": output_tokens,
        "text": {"format": {
            "type":"json_schema", "name":name, "strict":false, "schema":prepared.schema
        }}
    }))
    .map_err(|_| "cannot encode wallpaper request".to_owned())?;
    if body.len() > REQUEST_BYTES {
        return Err("complete wallpaper request exceeds byte limit".into());
    }
    ensure_input_budget(&body, quote).map_err(str::to_owned)?;
    Ok(body)
}

pub(super) fn quote(
    provider: &OpenAi,
    input: &WallpaperGenerateRequest,
    assets: Option<&AssetSet>,
) -> Result<PriceQuote, String> {
    if !provider.ready() {
        return Err("OpenAI wallpaper provider is unavailable".into());
    }
    let quote = PriceQuote {
        max_output_tokens: match input.output.kind {
            WallpaperGenerationKind::Builtin => wallpaper_provider::OUTPUT_TOKENS,
            WallpaperGenerationKind::Composition => composition_provider::OUTPUT_TOKENS,
            _ => return Err("OpenAI text provider cannot generate this wallpaper type".into()),
        },
        ..openai_token_only_quote()
    };
    request(provider, input, assets, &quote)?;
    quote.validate().map_err(str::to_owned)?;
    Ok(quote)
}

fn failed(reason: impl Into<String>) -> WallpaperReply {
    WallpaperReply {
        output: Err(WallpaperOutputError::Provider(reason.into())),
        usage: None,
    }
}

pub(super) async fn generate(
    provider: OpenAi,
    input: WallpaperGenerateRequest,
    assets: Option<AssetSet>,
    pricing: PricingSnapshot,
    credential: Option<ProviderCredential>,
    mut cancellation: ProviderCancellation,
) -> WallpaperReply {
    let expected = match quote(&provider, &input, assets.as_ref()) {
        Ok(quote) => quote,
        Err(reason) => return failed(reason),
    };
    if pricing.provider != provider.id()
        || pricing.model != provider.model()
        || pricing.credential.is_none()
        || !same_quote(&pricing.quote, &expected)
        || pricing.quote.metering.is_some()
    {
        return failed("OpenAI wallpaper pricing or credential snapshot changed");
    }
    let Some(credential) = credential else {
        return failed("OpenAI credential is unavailable");
    };
    let body = match request(&provider, &input, assets.as_ref(), &expected) {
        Ok(body) => body,
        Err(reason) => return failed(reason),
    };
    let reply = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return failed("OpenAI wallpaper request cancelled"),
        reply = provider.completion_execute(body, credential) => reply,
    };
    match reply {
        Ok(reply) => WallpaperReply {
            output: reply.text.map_err(WallpaperOutputError::Provider).and_then(
                |text| match assets.as_ref() {
                    Some(assets) => composition_provider::decode(&text, assets),
                    None => wallpaper_provider::decode(&input, &text),
                },
            ),
            usage: reply.usage,
        },
        Err(reason) => failed(reason),
    }
}

#[cfg(test)]
mod tests;
