// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Versioned adapter-owned pricing. Old token JSON keeps its original shape;
//! metered-v2 never serializes placeholder token rates or counters.

use serde::{Deserialize, Serialize};

use super::jobs::RESERVATION_MICRO_USD;

pub(crate) const METERED_V2: &str = "metered-v2";
pub(crate) const IMAGE_RESERVATION_MICRO_USD: i64 = 500_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Dimension {
    InputTokens,
    OutputTokens,
    ImageOutput,
}

const DIMENSIONS: [Dimension; 3] = [
    Dimension::InputTokens,
    Dimension::OutputTokens,
    Dimension::ImageOutput,
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageSku {
    pub width: u32,
    pub height: u32,
    pub quality_id: String,
}

impl ImageSku {
    fn validate(&self) -> Result<(), &'static str> {
        use hertz_wallpaper::generation::{MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS};
        if self.width == 0
            || self.height == 0
            || self.width.max(self.height) > MAX_IMAGE_EDGE
            || u64::from(self.width) * u64::from(self.height) > MAX_IMAGE_PIXELS
            || self.quality_id.is_empty()
            || self.quality_id.len() > 64
            || self.quality_id.chars().any(char::is_control)
        {
            return Err("invalid image pricing SKU");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PriceDimension {
    pub dimension: Dimension,
    pub quantity_limit: u64,
    pub unit_price_micro_usd: u64,
    pub unit_scale: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_sku: Option<ImageSku>,
}

impl PriceDimension {
    fn amount(&self, quantity: u64) -> Result<u128, &'static str> {
        let product = u128::from(quantity)
            .checked_mul(u128::from(self.unit_price_micro_usd))
            .ok_or("usage amount overflow")?;
        if self.unit_scale == 0 {
            return Err("pricing unit scale must be positive");
        }
        Ok(product.div_ceil(u128::from(self.unit_scale)))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UsageDimension {
    pub dimension: Dimension,
    pub quantity: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_sku: Option<ImageSku>,
}

/// The legacy fields remain available only to existing text adapters. They are
/// required in legacy JSON and absent from v2 JSON; validation forbids mixing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "QuoteWire", into = "QuoteWire")]
pub(crate) struct PriceQuote {
    pub pricing_version: String,
    pub reservation_micro_usd: i64,
    pub input_micro_usd_per_million: u64,
    pub output_micro_usd_per_million: u64,
    pub max_input_tokens: u64,
    pub max_output_tokens: u64,
    pub metering: Option<[PriceDimension; 3]>,
}

// This is flattened into PricingSnapshot, whose provider/model/credential are
// owned by that envelope. Dimension payloads themselves reject unknown fields.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoteWire {
    pricing_version: String,
    reservation_micro_usd: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_micro_usd_per_million: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output_micro_usd_per_million: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dimensions: Option<[PriceDimension; 3]>,
}

impl TryFrom<QuoteWire> for PriceQuote {
    type Error = &'static str;
    fn try_from(wire: QuoteWire) -> Result<Self, Self::Error> {
        let is_v2 = wire.pricing_version == METERED_V2;
        let tokens = match (
            wire.input_micro_usd_per_million,
            wire.output_micro_usd_per_million,
            wire.max_input_tokens,
            wire.max_output_tokens,
        ) {
            (None, None, None, None) if is_v2 && wire.dimensions.is_some() => [0; 4],
            (Some(input), Some(output), Some(max_input), Some(max_output))
                if !is_v2 && wire.dimensions.is_none() =>
            {
                [input, output, max_input, max_output]
            }
            _ => return Err("pricing version and dimensions do not match"),
        };
        let quote = Self {
            pricing_version: wire.pricing_version,
            reservation_micro_usd: wire.reservation_micro_usd,
            input_micro_usd_per_million: tokens[0],
            output_micro_usd_per_million: tokens[1],
            max_input_tokens: tokens[2],
            max_output_tokens: tokens[3],
            metering: wire.dimensions,
        };
        quote.validate_version()?;
        Ok(quote)
    }
}

impl From<PriceQuote> for QuoteWire {
    fn from(quote: PriceQuote) -> Self {
        let is_v2 = quote.pricing_version == METERED_V2;
        Self {
            pricing_version: quote.pricing_version,
            reservation_micro_usd: quote.reservation_micro_usd,
            input_micro_usd_per_million: (!is_v2).then_some(quote.input_micro_usd_per_million),
            output_micro_usd_per_million: (!is_v2).then_some(quote.output_micro_usd_per_million),
            max_input_tokens: (!is_v2).then_some(quote.max_input_tokens),
            max_output_tokens: (!is_v2).then_some(quote.max_output_tokens),
            dimensions: quote.metering,
        }
    }
}

impl PriceQuote {
    pub(crate) fn fake() -> Self {
        Self {
            pricing_version: "fake-free-v1".into(),
            reservation_micro_usd: RESERVATION_MICRO_USD,
            input_micro_usd_per_million: 0,
            output_micro_usd_per_million: 0,
            max_input_tokens: 0,
            max_output_tokens: 0,
            metering: None,
        }
    }

    fn validate_version(&self) -> Result<(), &'static str> {
        // Legacy pricingVersion is an opaque frozen-rate label, not a wire
        // schema version. Preserve its old accepted labels; reserve the new
        // metered family so unknown vector versions cannot fall back to tokens.
        if self.pricing_version.is_empty()
            || self.pricing_version.len() > 128
            || (self.pricing_version.starts_with("metered-")
                && !matches!(self.pricing_version.as_str(), "metered-v1" | METERED_V2))
            || (self.pricing_version == METERED_V2) != self.metering.is_some()
        {
            return Err("unsupported pricing version or dimensions");
        }
        Ok(())
    }

    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        self.validate_version()?;
        let (limit, upper) = if let Some(dimensions) = &self.metering {
            if self.input_micro_usd_per_million != 0
                || self.output_micro_usd_per_million != 0
                || self.max_input_tokens != 0
                || self.max_output_tokens != 0
            {
                return Err("image quote cannot contain legacy token pricing");
            }
            let mut total = 0u128;
            for (index, price) in dimensions.iter().enumerate() {
                if price.dimension != DIMENSIONS[index] || price.unit_scale == 0 {
                    return Err("invalid or duplicate pricing dimension");
                }
                if price.dimension == Dimension::ImageOutput {
                    price
                        .image_sku
                        .as_ref()
                        .ok_or("missing image SKU")?
                        .validate()?;
                    if price.quantity_limit != 1 || price.unit_scale != 1 {
                        return Err("image price must cover exactly one complete SKU");
                    }
                } else if price.image_sku.is_some() {
                    return Err("token pricing cannot contain image SKU");
                }
                total = total
                    .checked_add(price.amount(price.quantity_limit)?)
                    .ok_or("usage amount overflow")?;
            }
            (
                IMAGE_RESERVATION_MICRO_USD,
                i64::try_from(total).map_err(|_| "usage amount overflow")?,
            )
        } else {
            (
                RESERVATION_MICRO_USD,
                self.amount(&TrustedUsage {
                    input_tokens: self.max_input_tokens,
                    output_tokens: self.max_output_tokens,
                    metering: None,
                })?,
            )
        };
        if !(0..=limit).contains(&self.reservation_micro_usd) {
            return Err("invalid provider price quote");
        }
        if upper > self.reservation_micro_usd {
            return Err("provider quote exceeds reservation");
        }
        Ok(())
    }

    pub(crate) fn amount(&self, usage: &TrustedUsage) -> Result<i64, &'static str> {
        self.validate_usage(usage)?;
        let amount = match (&self.metering, &usage.metering) {
            (None, None) => {
                let input = u128::from(usage.input_tokens)
                    .checked_mul(u128::from(self.input_micro_usd_per_million))
                    .ok_or("usage amount overflow")?;
                let output = u128::from(usage.output_tokens)
                    .checked_mul(u128::from(self.output_micro_usd_per_million))
                    .ok_or("usage amount overflow")?;
                input
                    .div_ceil(1_000_000)
                    .checked_add(output.div_ceil(1_000_000))
                    .ok_or("usage amount overflow")?
            }
            (Some(prices), Some(used)) => {
                let mut total = 0u128;
                for (price, quantity) in prices.iter().zip(used) {
                    total = total
                        .checked_add(price.amount(quantity.quantity)?)
                        .ok_or("usage amount overflow")?;
                }
                total
            }
            _ => return Err("trusted usage version does not match accepted pricing"),
        };
        i64::try_from(amount).map_err(|_| "usage amount overflow")
    }

    pub(crate) fn validate_usage(&self, usage: &TrustedUsage) -> Result<(), &'static str> {
        usage.validate()?;
        match (&self.metering, &usage.metering) {
            (None, None) => Ok(()),
            (Some(prices), Some(used))
                if prices.iter().zip(used).all(|(price, quantity)| {
                    price.dimension == quantity.dimension && price.image_sku == quantity.image_sku
                }) =>
            {
                Ok(())
            }
            _ => Err("trusted usage version or SKU does not match accepted pricing"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "UsageWire", into = "UsageWire")]
pub(crate) struct TrustedUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub metering: Option<[UsageDimension; 3]>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageWire {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dimensions: Option<[UsageDimension; 3]>,
}

impl TryFrom<UsageWire> for TrustedUsage {
    type Error = &'static str;
    fn try_from(wire: UsageWire) -> Result<Self, Self::Error> {
        let usage = match (
            wire.usage_version.as_deref(),
            wire.input_tokens,
            wire.output_tokens,
            wire.dimensions,
        ) {
            (None, Some(input_tokens), Some(output_tokens), None) => Self {
                input_tokens,
                output_tokens,
                metering: None,
            },
            (Some(METERED_V2), None, None, Some(dimensions)) => Self {
                input_tokens: 0,
                output_tokens: 0,
                metering: Some(dimensions),
            },
            _ => return Err("unsupported or incomplete trusted usage version"),
        };
        usage.validate()?;
        Ok(usage)
    }
}

impl From<TrustedUsage> for UsageWire {
    fn from(usage: TrustedUsage) -> Self {
        let metered = usage.metering.is_some();
        Self {
            usage_version: metered.then(|| METERED_V2.into()),
            input_tokens: (!metered).then_some(usage.input_tokens),
            output_tokens: (!metered).then_some(usage.output_tokens),
            dimensions: usage.metering,
        }
    }
}

impl TrustedUsage {
    pub(crate) fn free() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            metering: None,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if let Some(dimensions) = &self.metering {
            if self.input_tokens != 0 || self.output_tokens != 0 {
                return Err("image usage cannot contain legacy token counters");
            }
            for (index, usage) in dimensions.iter().enumerate() {
                if usage.dimension != DIMENSIONS[index] {
                    return Err("invalid or duplicate usage dimension");
                }
                if usage.dimension == Dimension::ImageOutput {
                    usage
                        .image_sku
                        .as_ref()
                        .ok_or("missing image usage SKU")?
                        .validate()?;
                } else if usage.image_sku.is_some() {
                    return Err("token usage cannot contain image SKU");
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(super) mod tests;
