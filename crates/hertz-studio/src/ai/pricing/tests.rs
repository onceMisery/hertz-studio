// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;
use crate::ai::usage::PricingSnapshot;
use serde_json::{json, Value};

pub(crate) fn image_quote() -> PriceQuote {
    PriceQuote {
        pricing_version: METERED_V2.into(),
        reservation_micro_usd: 200_002,
        input_micro_usd_per_million: 0,
        output_micro_usd_per_million: 0,
        max_input_tokens: 0,
        max_output_tokens: 0,
        metering: Some([
            PriceDimension {
                dimension: Dimension::InputTokens,
                quantity_limit: 1,
                unit_price_micro_usd: 1,
                unit_scale: 1_000_000,
                image_sku: None,
            },
            PriceDimension {
                dimension: Dimension::OutputTokens,
                quantity_limit: 1,
                unit_price_micro_usd: 1,
                unit_scale: 1_000_000,
                image_sku: None,
            },
            PriceDimension {
                dimension: Dimension::ImageOutput,
                quantity_limit: 1,
                unit_price_micro_usd: 200_000,
                unit_scale: 1,
                image_sku: Some(ImageSku {
                    width: 1024,
                    height: 1024,
                    quality_id: "test-quality".into(),
                }),
            },
        ]),
    }
}

pub(crate) fn image_usage() -> TrustedUsage {
    TrustedUsage {
        input_tokens: 0,
        output_tokens: 0,
        metering: Some(image_quote().metering.unwrap().map(|price| UsageDimension {
            dimension: price.dimension,
            quantity: 1,
            image_sku: price.image_sku,
        })),
    }
}

#[test]
fn image_quote_rounds_every_component_and_serializes_only_its_vector() {
    let quote = image_quote();
    assert_eq!(quote.validate(), Ok(()));
    assert_eq!(quote.amount(&image_usage()), Ok(200_002));
    let wire = serde_json::to_value(&quote).unwrap();
    assert!(wire.get("inputMicroUsdPerMillion").is_none());
    assert!(wire.get("maxInputTokens").is_none());
    assert_eq!(wire["dimensions"].as_array().unwrap().len(), 3);
    assert_eq!(serde_json::from_value::<PriceQuote>(wire).unwrap(), quote);
    let usage = image_usage();
    let wire = serde_json::to_value(&usage).unwrap();
    assert!(wire.get("inputTokens").is_none());
    assert_eq!(wire["usageVersion"], METERED_V2);
    assert_eq!(serde_json::from_value::<TrustedUsage>(wire).unwrap(), usage);
}

#[test]
fn legacy_token_snapshots_and_counters_keep_their_wire_shape_and_prices() {
    let wire = json!({"provider":"historical","model":"historical-model",
        "pricingVersion":"frozen-rates-2026-10-01","reservationMicroUsd":50_000,
        "inputMicroUsdPerMillion":1,"outputMicroUsdPerMillion":2,
        "maxInputTokens":1,"maxOutputTokens":1});
    let snapshot: PricingSnapshot = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(&snapshot).unwrap(), wire);
    let usage_wire = json!({"inputTokens":1,"outputTokens":1});
    let usage: TrustedUsage = serde_json::from_value(usage_wire.clone()).unwrap();
    assert_eq!(snapshot.quote.amount(&usage), Ok(2));
    assert_eq!(serde_json::to_value(&usage).unwrap(), usage_wire);
    assert!(snapshot.quote.validate_usage(&image_usage()).is_err());
    assert!(image_quote().validate_usage(&usage).is_err());
    let mut too_high = snapshot.quote;
    too_high.reservation_micro_usd = 50_001;
    assert!(too_high.validate().is_err());
}

#[test]
fn incomplete_unknown_or_mixed_versions_never_decode_as_zero_price_or_usage() {
    let quote_wire = serde_json::to_value(image_quote()).unwrap();
    for mutate in 0..6 {
        let mut wire = quote_wire.clone();
        match mutate {
            0 => {
                wire["pricingVersion"] = json!("metered-v3");
            }
            1 => {
                wire.as_object_mut().unwrap().remove("dimensions");
            }
            2 => {
                wire["inputMicroUsdPerMillion"] = json!(0);
            }
            3 => {
                wire["dimensions"].as_array_mut().unwrap().pop();
            }
            4 => {
                wire["dimensions"][2]["imageSku"]["unexpected"] = json!(true);
            }
            _ => {
                wire["dimensions"][1]["dimension"] = json!("unknownDimension");
            }
        }
        assert!(
            serde_json::from_value::<PriceQuote>(wire).is_err(),
            "quote mutation {mutate}"
        );
    }
    let usage_wire = serde_json::to_value(image_usage()).unwrap();
    for mutate in 0..6 {
        let mut wire = usage_wire.clone();
        match mutate {
            0 => {
                wire["usageVersion"] = json!("metered-v3");
            }
            1 => {
                wire.as_object_mut().unwrap().remove("usageVersion");
            }
            2 => {
                wire["inputTokens"] = json!(0);
            }
            3 => {
                wire["dimensions"].as_array_mut().unwrap().pop();
            }
            4 => {
                wire["dimensions"][2]["imageSku"] = Value::Null;
            }
            _ => {
                wire["dimensions"][1]["dimension"] = json!("inputTokens");
            }
        }
        assert!(
            serde_json::from_value::<TrustedUsage>(wire).is_err(),
            "usage mutation {mutate}"
        );
    }
    for version in ["metered-v3", "metered-v99"] {
        let wire = json!({"pricingVersion":version,"reservationMicroUsd":0,
            "inputMicroUsdPerMillion":0,"outputMicroUsdPerMillion":0,"maxInputTokens":0,"maxOutputTokens":0});
        assert!(serde_json::from_value::<PriceQuote>(wire).is_err());
    }
}

#[test]
fn quote_requires_single_sku_all_dimensions_valid_scale_and_bounded_reservation() {
    for mutation in 0..12 {
        let mut quote = image_quote();
        let dimensions = quote.metering.as_mut().unwrap();
        match mutation {
            0 => dimensions[0].dimension = Dimension::ImageOutput,
            1 => dimensions[0].unit_scale = 0,
            2 => dimensions[2].image_sku = None,
            3 => dimensions[0].image_sku = dimensions[2].image_sku.clone(),
            4 => dimensions[2].quantity_limit = 2,
            5 => dimensions[2].unit_scale = 2,
            6 => dimensions[2].image_sku.as_mut().unwrap().width = 4097,
            7 => {
                let sku = dimensions[2].image_sku.as_mut().unwrap();
                sku.width = 4096;
                sku.height = 4096;
            }
            8 => quote.reservation_micro_usd = 200_001,
            9 => quote.reservation_micro_usd = 500_001,
            10 => quote.reservation_micro_usd = -1,
            _ => quote.input_micro_usd_per_million = 1,
        }
        assert!(quote.validate().is_err(), "quote mutation {mutation}");
    }
    let mut quote = image_quote();
    quote.metering.as_mut().unwrap()[2].unit_price_micro_usd = 499_998;
    quote.reservation_micro_usd = 500_000;
    assert!(quote.validate().is_ok());
}

#[test]
fn sku_mismatch_and_numeric_overflow_are_not_free_and_over_limit_usage_is_accounted() {
    let quote = image_quote();
    for mutation in 0..3 {
        let mut usage = image_usage();
        let sku = usage.metering.as_mut().unwrap()[2]
            .image_sku
            .as_mut()
            .unwrap();
        match mutation {
            0 => sku.width = 2048,
            1 => sku.height = 2048,
            _ => sku.quality_id = "other".into(),
        }
        assert!(quote.amount(&usage).is_err());
    }
    let mut usage = image_usage();
    usage.metering.as_mut().unwrap()[2].quantity = 3;
    assert_eq!(
        quote.amount(&usage),
        Ok(600_002),
        "record all trustworthy billed output even beyond reservation"
    );
    let mut overflow = quote;
    overflow.metering.as_mut().unwrap()[0].unit_price_micro_usd = u64::MAX;
    overflow.metering.as_mut().unwrap()[0].unit_scale = 1;
    usage.metering.as_mut().unwrap()[0].quantity = u64::MAX;
    assert!(overflow.amount(&usage).is_err());
    overflow.metering.as_mut().unwrap()[0].quantity_limit = u64::MAX;
    assert!(overflow.validate().is_err());
}

#[test]
fn image_snapshot_roundtrips_through_the_original_envelope() {
    let snapshot = PricingSnapshot {
        provider: "image-fixture".into(),
        model: "test-image".into(),
        quote: image_quote(),
        credential: None,
    };
    let wire = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(wire["pricingVersion"], METERED_V2);
    assert_eq!(wire["provider"], "image-fixture");
    assert_eq!(
        serde_json::from_value::<PricingSnapshot>(wire).unwrap(),
        snapshot
    );
}
