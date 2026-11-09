// SPDX-License-Identifier: MIT
//! Planning evidence only: real licensed, immutable brand TTF pins pass the
//! original parser and required-glyph checks. The existing qualification test
//! owner supplies lifecycle proofs; these tests do not claim native pixels.

use std::sync::{atomic::AtomicBool, Arc};

use serde_json::json;

use super::*;
use crate::wallpaper::assets::AssetStore;
use crate::wallpaper::decode_probe::{ProbeClient, ProbeInput};
use crate::wallpaper::font_prepare::{pin_input, prepare_workspace_bytes};
use crate::wallpaper::image_prepare::{ImageFit, ImagePurpose};
use crate::wallpaper::library::{tempfileish::TempDir, Library};
use crate::wallpaper::target_planner::AssetRef;

struct Fixture {
    store: AssetStore,
    directory: TempDir,
    reference: AssetRef,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let (store, directory, reference, _) = crate::wallpaper::font_prepare::installed(tag);
        Self {
            store,
            directory,
            reference,
        }
    }

    fn compile(&self, nodes: Value, properties: Value, canvas: [u32; 2]) -> CompiledDocument {
        let document = json!({"documentVersion":1,
            "canvas":{"width":canvas[0],"height":canvas[1],"colorSpace":"srgb","background":"#101010"},
            "nodes":nodes,"timeline":{"durationSeconds":30,"loop":true,"tracks":[]},"bindings":[]});
        let bytes = serde_json::to_vec(&document).unwrap();
        // The semantics fixture keeps the installed licensed asset declarations;
        // this in-memory compiled document is not a production package receipt.
        let package = self
            .store
            .read_installed_manifest(&self.reference.package_hash)
            .unwrap();
        let mut manifest = serde_json::to_value(package.manifest).unwrap();
        manifest["content"] = json!({"kind":"composition","document":"document.json"});
        manifest["files"].as_array_mut().unwrap().push(json!({
            "path":"document.json","bytes":bytes.len(),
            "sha256":format!("{:x}",Sha256::digest(&bytes)),"mime":"application/json"}));
        manifest["properties"] = properties;
        let manifest =
            hertz_wallpaper::validate_manifest_bytes(&serde_json::to_vec(&manifest).unwrap())
                .unwrap();
        hertz_wallpaper::document::compile_document(&bytes, &manifest).unwrap()
    }

    async fn fonts(
        &self,
        compiled: &CompiledDocument,
        values: &FinalPublicValues,
    ) -> BTreeMap<String, PreparedFont> {
        let library = Library::open(self.directory.path()).await.unwrap();
        let probe = ProbeClient::testing_input(|input, _| {
            assert!(matches!(input, ProbeInput::Font(_)));
            Box::pin(async { Ok(()) })
        });
        let package = self
            .store
            .read_installed_manifest(&self.reference.package_hash)
            .unwrap();
        let mut fonts = BTreeMap::new();
        for (asset_id, texts) in required_texts_by_font(compiled, values).unwrap() {
            let asset = package
                .manifest
                .assets
                .iter()
                .find(|asset| asset.id == asset_id)
                .unwrap();
            let entry = package
                .entries
                .iter()
                .find(|entry| entry.path == asset.source)
                .unwrap();
            let mut reference = self.reference.clone();
            reference.asset_id = asset_id.clone();
            let workspace = probe
                .image_workspace(prepare_workspace_bytes(entry.bytes).unwrap())
                .unwrap();
            let input = pin_input(
                &self.store,
                &reference,
                entry,
                &texts,
                &workspace,
                &AtomicBool::new(false),
            )
            .unwrap();
            workspace.finish();
            let proof = probe
                .qualify_font(&library, input.clone(), Arc::new(AtomicBool::new(false)))
                .await
                .unwrap();
            fonts.insert(
                asset_id,
                PreparedFont::after_qualification(reference, input, proof).unwrap(),
            );
        }
        library.pool().close().await;
        fonts
    }
}

fn text(id: &str, font: &str, properties: Value) -> Value {
    let mut properties = properties.as_object().unwrap().clone();
    properties
        .entry("text".to_owned())
        .or_insert(json!("Hertz"));
    properties.entry("width".to_owned()).or_insert(json!(100));
    properties.entry("height".to_owned()).or_insert(json!(50));
    json!({"id":id,"type":"text","stateVersion":1,
        "assets":{"fontAsset":font},"properties":properties})
}

fn target(width: u32, height: u32) -> ImageTarget {
    ImageTarget {
        width,
        height,
        fit: ImageFit::Contain,
        purpose: ImagePurpose::High,
    }
}

fn final_values(compiled: &CompiledDocument, overrides: Value) -> FinalPublicValues {
    compiled
        .final_public_values(&overrides.as_object().unwrap().clone().into_iter().collect())
        .unwrap()
}

fn plan(
    compiled: &CompiledDocument,
    values: &FinalPublicValues,
    fonts: &BTreeMap<String, PreparedFont>,
    target: ImageTarget,
    fit: Fit,
) -> Result<TextRasterPlan> {
    plan_text_rasters(
        compiled,
        values,
        &fonts.iter().map(|(id, font)| (id.clone(), font)).collect(),
        target,
        fit,
    )
}

#[tokio::test]
async fn inspected_alias_facts_share_exact_raster_core_without_native_qualification() {
    let fixture = Fixture::new("raster-inspected-facts");
    let compiled = fixture.compile(
        json!([
            text("first", "brand-font", json!({"text":"Hertz"})),
            text(
                "second",
                "brand-font-alias",
                json!({"text":"Hertz","visible":false})
            )
        ]),
        json!([]),
        [100, 100],
    );
    let values = final_values(&compiled, json!({}));
    let package = fixture
        .store
        .read_installed_manifest(&fixture.reference.package_hash)
        .unwrap();
    let probe =
        ProbeClient::testing_input(|_, _| panic!("sealed inspection facts need no native proof"));
    let mut inputs = BTreeMap::new();
    for (id, texts) in required_texts_by_font(&compiled, &values).unwrap() {
        let asset = package
            .manifest
            .assets
            .iter()
            .find(|asset| asset.id == id)
            .unwrap();
        let entry = package
            .entries
            .iter()
            .find(|entry| entry.path == asset.source)
            .unwrap();
        let mut reference = fixture.reference.clone();
        reference.asset_id = id.clone();
        let workspace = probe
            .image_workspace(prepare_workspace_bytes(entry.bytes).unwrap())
            .unwrap();
        let input = pin_input(
            &fixture.store,
            &reference,
            entry,
            &texts,
            &workspace,
            &AtomicBool::new(false),
        )
        .unwrap();
        workspace.finish();
        inputs.insert(id, input);
    }
    let plan_inspected = |inputs: &BTreeMap<String, crate::wallpaper::font_prepare::FontInput>| {
        let facts = inputs
            .iter()
            .map(|(id, input)| (id.clone(), input.plan_facts().unwrap()))
            .collect();
        plan_text_rasters_from_facts(&compiled, &values, &facts, target(100, 100), Fit::Contain)
    };
    let inspected = plan_inspected(&inputs).unwrap();
    assert_eq!(probe.stats(), (0, 0));
    assert_eq!(inspected.unique_font_count(), 1);
    assert_eq!(inspected.unique_raster_count(), 1);
    let prepared = fixture.fonts(&compiled, &values).await;
    let qualified = plan(
        &compiled,
        &values,
        &prepared,
        target(100, 100),
        Fit::Contain,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(inspected.text_rasters()).unwrap(),
        serde_json::to_value(qualified.text_rasters()).unwrap()
    );
    assert_eq!(inspected.font_cpu_bytes(), qualified.font_cpu_bytes());
    assert_eq!(inspected.raster_pixels(), qualified.raster_pixels());
    let alias = inputs["brand-font-alias"].clone();
    inputs.insert("brand-font-alias".into(), inputs["brand-font"].clone());
    assert_eq!(
        plan_inspected(&inputs).unwrap_err().code,
        "font_not_prepared"
    );
    assert!(!alias.covers_required_texts(&[RequiredText {
        node_id: "first".into(),
        text: "Hertz".into()
    }]));
    assert!(!alias.covers_required_texts(&[RequiredText {
        node_id: "second".into(),
        text: "H".into()
    }]));
    assert_eq!(probe.stats(), (0, 0));
}

#[tokio::test]
async fn aliases_share_raster_and_font_costs_with_all_node_consumers() {
    let fixture = Fixture::new("text-raster-aliases");
    let compiled = fixture.compile(
        json!([
            text("one", "brand-font", json!({})),
            text(
                "two",
                "brand-font-alias",
                json!({"x":13,"y":-8,"opacity":0,"visible":false})
            ),
            text("three", "brand-font", json!({"anchorX":0,"anchorY":0}))
        ]),
        json!([]),
        [1000, 500],
    );
    let values = final_values(&compiled, json!({}));
    let fonts = fixture.fonts(&compiled, &values).await;
    let result = plan(&compiled, &values, &fonts, target(1000, 500), Fit::Contain).unwrap();
    assert_eq!(result.unique_raster_count(), 1);
    assert_eq!(result.unique_font_count(), 1);
    assert_eq!(result.raster_pixels(), 5000);
    assert_eq!(result.raster_rgba_bytes(), 20_000);
    assert_eq!(
        result.font_cpu_bytes(),
        fonts["brand-font"].input().metadata.cpu_budget_bytes
    );
    let raster = &result.text_rasters()[0];
    assert_eq!(raster.node_indices(), &[0, 1, 2]);
    assert_eq!(raster.font_asset_id(), "brand-font");
    assert_eq!(
        raster.font_content_key(),
        fonts["brand-font-alias"].content_key()
    );
    assert_eq!(
        (raster.logical_width(), raster.logical_height()),
        (100.0, 50.0)
    );
    assert_eq!(
        (raster.width_px(), raster.height_px(), raster.scale()),
        (100, 50, 1.0)
    );
    assert_eq!(raster.adapter_id(), ADAPTER_ID);
    assert_eq!(raster.adapter_version(), ADAPTER_VERSION);
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(wire["uniqueRasterCount"], 1);
    assert_eq!(
        wire["textRasters"][0]["fontContentKey"],
        raster.font_content_key()
    );
    assert_eq!(wire["textRasters"][0]["nodeIndices"], json!([0, 1, 2]));
    assert!(wire["textRasters"][0].get("raster_key").is_none());
    assert!(hertz_wallpaper::valid_sha256_hex(raster.raster_key()));
}

#[tokio::test]
async fn final_public_text_and_font_override_require_exact_glyph_preparation_and_change_keys() {
    let fixture = Fixture::new("text-raster-public");
    let compiled = fixture.compile(
        json!([text("label", "brand-font", json!({"text":"H"}))]),
        json!([
            {"id":"caption","label":"Caption","type":"text","default":"Hertz",
                "constraints":{"maxLength":4096},"target":{"kind":"node","nodeId":"label","property":"text","component":null}},
            {"id":"face","label":"Face","type":"asset","default":"brand-font-alias",
                "constraints":{"kind":"font","options":["brand-font","brand-font-alias","brand-font-b"]},
                "target":{"kind":"node","nodeId":"label","property":"fontAsset","component":null}}
        ]),
        [1000, 500],
    );
    let initial = final_values(&compiled, json!({}));
    let required = required_texts_by_font(&compiled, &initial).unwrap();
    assert_eq!(required.len(), 1);
    assert_eq!(required["brand-font-alias"][0].node_id, "label");
    assert_eq!(required["brand-font-alias"][0].text, "Hertz");
    let initial_fonts = fixture.fonts(&compiled, &initial).await;
    let initial_plan = plan(
        &compiled,
        &initial,
        &initial_fonts,
        target(1000, 500),
        Fit::Contain,
    )
    .unwrap();
    let first_key = initial_plan.text_rasters()[0].raster_key();
    let same = final_values(
        &compiled,
        json!({"caption":"Hertz","face":"brand-font-alias"}),
    );
    assert_eq!(
        first_key,
        plan(
            &compiled,
            &same,
            &initial_fonts,
            target(1000, 500),
            Fit::Contain
        )
        .unwrap()
        .text_rasters()[0]
            .raster_key()
    );
    for (overrides, same_key) in [
        (json!({"face":"brand-font"}), true),
        (json!({"face":"brand-font-b"}), false),
        (json!({"caption":"Hertz Studio"}), false),
    ] {
        let changed = final_values(&compiled, overrides);
        assert_eq!(
            plan(
                &compiled,
                &changed,
                &initial_fonts,
                target(1000, 500),
                Fit::Contain
            )
            .unwrap_err()
            .code,
            "font_not_prepared"
        );
        let fonts = fixture.fonts(&compiled, &changed).await;
        let changed_plan =
            plan(&compiled, &changed, &fonts, target(1000, 500), Fit::Contain).unwrap();
        assert_eq!(
            first_key == changed_plan.text_rasters()[0].raster_key(),
            same_key
        );
    }
}

#[tokio::test]
async fn final_style_overrides_change_keys_but_moves_opacity_visibility_do_not() {
    let fixture = Fixture::new("text-raster-style");
    let number_property = |id: &str, property: &str, default: f64, min: f64, max: f64| {
        json!({"id":id,"label":id,"type":"number","default":default,"constraints":{"min":min,"max":max},
            "target":{"kind":"node","nodeId":"label","property":property,"component":null}})
    };
    let compiled = fixture.compile(
        json!([text("label", "brand-font", json!({}))]),
        json!([
            number_property("size", "fontSize", 48.0, 1.0, 1024.0),
            number_property("line", "lineHeight", 1.25, 0.25, 8.0),
            number_property("box", "width", 100.0, 1.0, 16384.0),
            number_property("scale", "scaleX", 1.0, -64.0, 64.0),
            number_property("x", "x", 0.0, -65536.0, 65536.0),
            number_property("opacity", "opacity", 1.0, 0.0, 1.0),
            {"id":"visible","label":"Visible","type":"boolean","default":true,"constraints":{},
                "target":{"kind":"node","nodeId":"label","property":"visible","component":null}},
            {"id":"color","label":"Color","type":"color","default":"#ffffff","constraints":{},
                "target":{"kind":"node","nodeId":"label","property":"color","component":null}},
            {"id":"align","label":"Align","type":"select","default":"left",
                "constraints":{"options":[{"value":"left","label":"Left"},{"value":"center","label":"Center"}]},
                "target":{"kind":"node","nodeId":"label","property":"align","component":null}}
        ]),
        [1000, 500],
    );
    let initial = final_values(&compiled, json!({}));
    let fonts = fixture.fonts(&compiled, &initial).await;
    let initial_plan = plan(&compiled, &initial, &fonts, target(1000, 500), Fit::Contain).unwrap();
    let key = initial_plan.text_rasters()[0].raster_key();
    for overrides in [
        json!({"size":48,"line":1.25,"scale":1.0}),
        json!({"x":99,"opacity":0,"visible":false}),
    ] {
        let values = final_values(&compiled, overrides);
        assert_eq!(
            key,
            plan(&compiled, &values, &fonts, target(1000, 500), Fit::Contain)
                .unwrap()
                .text_rasters()[0]
                .raster_key()
        );
    }
    for overrides in [
        json!({"size":49}),
        json!({"line":1.5}),
        json!({"color":"#ff0000"}),
        json!({"align":"center"}),
        json!({"box":101}),
        json!({"scale":1.01}),
    ] {
        let values = final_values(&compiled, overrides);
        assert_ne!(
            key,
            plan(&compiled, &values, &fonts, target(1000, 500), Fit::Contain)
                .unwrap()
                .text_rasters()[0]
                .raster_key()
        );
    }
    let enlarged = plan(
        &compiled,
        &initial,
        &fonts,
        target(2000, 1000),
        Fit::Contain,
    )
    .unwrap();
    assert_ne!(key, enlarged.text_rasters()[0].raster_key());
    assert_eq!(enlarged.text_rasters()[0].scale(), 2.0);
}

#[tokio::test]
async fn complete_ancestor_rotation_and_target_fit_determine_physical_dimensions_once() {
    let fixture = Fixture::new("text-raster-fit");
    let compiled = fixture.compile(
        json!([
            text("label", "brand-font", json!({"scaleX":3,"scaleY":0.5})),
            {"id":"parent","type":"group","stateVersion":1,"children":["label"],
                "properties":{"rotation":90,"scaleX":2,"scaleY":1,"width":8000,"height":8000}}
        ]),
        json!([]),
        [1000, 500],
    );
    let values = final_values(&compiled, json!({}));
    let fonts = fixture.fonts(&compiled, &values).await;
    for (fit, scale, dimensions) in [
        (Fit::Contain, 12.0, (1200, 600)),
        (Fit::Cover, 18.0, (1800, 900)),
        (Fit::Stretch, 12.0, (1200, 600)),
    ] {
        let result = plan(&compiled, &values, &fonts, target(3000, 1000), fit).unwrap();
        let raster = &result.text_rasters()[0];
        assert_eq!(raster.scale(), scale);
        assert_eq!((raster.width_px(), raster.height_px()), dimensions);
    }
    let slots = FinalSlots::new(&compiled, &values).unwrap();
    let world = slots.text_matrix(0).unwrap();
    assert!(world.a.abs() < 1e-12);
    assert!((world.b - 6.0).abs() < 1e-12);
    assert!((world.c + 0.5).abs() < 1e-12);
    assert!(world.d.abs() < 1e-12);
    assert!(world.x.is_finite() && world.y.is_finite());

    let own_rotation = fixture.compile(
        json!([
            text("label", "brand-font", json!({"rotation":90,"scaleX":3,"scaleY":0.5})),
            {"id":"parent","type":"group","stateVersion":1,"children":["label"],
                "properties":{"rotation":90,"scaleX":2,"scaleY":1}}
        ]),
        json!([]),
        [1000, 500],
    );
    let rotated_values = final_values(&own_rotation, json!({}));
    let rotated = plan(
        &own_rotation,
        &rotated_values,
        &fonts,
        target(3000, 1000),
        Fit::Stretch,
    )
    .unwrap();
    let raster = &rotated.text_rasters()[0];
    assert_eq!(raster.scale(), 9.0);
    assert_eq!((raster.width_px(), raster.height_px()), (900, 450));
}

#[tokio::test]
async fn nested_nonuniform_scales_use_the_largest_singular_value_not_axis_lengths() {
    let fixture = Fixture::new("text-raster-nested");
    let compiled = fixture.compile(
        json!([
            {"id":"outer","type":"group","stateVersion":1,"children":["inner"],"properties":{"scaleX":2,"scaleY":1}},
            text("label", "brand-font", json!({"width":100,"height":40,"scaleX":0.5,"scaleY":0.5})),
            {"id":"inner","type":"group","stateVersion":1,"children":["label"],"properties":{"rotation":45,"scaleX":1,"scaleY":3}}
        ]),
        json!([]),
        [1000, 500],
    );
    let values = final_values(&compiled, json!({}));
    let fonts = fixture.fonts(&compiled, &values).await;
    let result = plan(&compiled, &values, &fonts, target(2000, 1000), Fit::Contain).unwrap();
    // The two column squared lengths are 2.5 and 22.5 with cross -4.5:
    // eigenvalue max = (25 + sqrt(481))/2. Own scale 0.5 and fit 2 cancel.
    let exact = ((25.0 + 481.0_f64.sqrt()) / 2.0).sqrt();
    let slots = FinalSlots::new(&compiled, &values).unwrap();
    let fitted = Affine::target_fit(&compiled, target(2000, 1000), Fit::Contain)
        .unwrap()
        .multiply(slots.text_matrix(1).unwrap())
        .unwrap();
    assert!((fitted.maximum_scale().unwrap() - exact).abs() < 1e-12);
    let raster = &result.text_rasters()[0];
    assert_eq!(raster.scale(), 311.0 / 64.0);
    assert_eq!((raster.width_px(), raster.height_px()), (486, 195));
}

#[tokio::test]
async fn hidden_and_zero_scale_text_keep_nonzero_rasters_and_preflight_costs() {
    let fixture = Fixture::new("text-raster-zero");
    let compiled = fixture.compile(
        json!([
            text(
                "one",
                "brand-font",
                json!({"scaleX":0,"scaleY":0,"visible":false})
            ),
            text(
                "two",
                "brand-font",
                json!({"scaleX":0,"scaleY":0,"opacity":0,"width":0.001,"height":0.001})
            )
        ]),
        json!([]),
        [1000, 500],
    );
    let values = final_values(&compiled, json!({}));
    let fonts = fixture.fonts(&compiled, &values).await;
    let result = plan(&compiled, &values, &fonts, target(1000, 500), Fit::Contain).unwrap();
    assert_eq!(result.unique_raster_count(), 2);
    assert_eq!(result.unique_font_count(), 1);
    assert_eq!(result.raster_pixels(), 3);
    assert_eq!(result.raster_rgba_bytes(), 12);
    assert!(result.font_cpu_bytes() > 0);
    assert_eq!(result.text_rasters()[0].scale(), 1.0 / 64.0);
    assert_eq!(
        (
            result.text_rasters()[0].width_px(),
            result.text_rasters()[0].height_px()
        ),
        (2, 1)
    );
    assert_eq!(
        (
            result.text_rasters()[1].width_px(),
            result.text_rasters()[1].height_px()
        ),
        (1, 1)
    );
    assert_eq!(
        plan(
            &compiled,
            &values,
            &BTreeMap::new(),
            target(1000, 500),
            Fit::Contain
        )
        .unwrap_err()
        .code,
        "font_not_prepared"
    );
}

#[tokio::test]
async fn duplicate_fonts_with_distinct_styles_charge_one_font_and_each_unique_raster() {
    let fixture = Fixture::new("text-raster-costs");
    let compiled = fixture.compile(
        json!([
            text("one", "brand-font", json!({})),
            text("two", "brand-font-alias", json!({"color":"#ff0000"})),
            text("three", "brand-font-b", json!({}))
        ]),
        json!([]),
        [1000, 500],
    );
    let values = final_values(&compiled, json!({}));
    let fonts = fixture.fonts(&compiled, &values).await;
    let result = plan(&compiled, &values, &fonts, target(1000, 500), Fit::Contain).unwrap();
    assert_eq!(result.unique_raster_count(), 3);
    assert_eq!(result.unique_font_count(), 2);
    assert_eq!(result.raster_pixels(), 15_000);
    assert_eq!(result.raster_rgba_bytes(), 60_000);
    assert_eq!(
        result.font_cpu_bytes(),
        fonts["brand-font"].input().metadata.cpu_budget_bytes
            + fonts["brand-font-b"].input().metadata.cpu_budget_bytes
    );
}

#[tokio::test]
async fn oversized_hidden_text_and_uncovered_font_aliases_are_explicitly_rejected() {
    let fixture = Fixture::new("text-raster-rejections");
    let compiled = fixture.compile(
        json!([text(
            "label",
            "brand-font",
            json!({"width":4096,"height":2025,"visible":false})
        )]),
        json!([]),
        [1000, 500],
    );
    let values = final_values(&compiled, json!({}));
    let fonts = fixture.fonts(&compiled, &values).await;
    let accepted = plan(&compiled, &values, &fonts, target(1000, 500), Fit::Contain).unwrap();
    assert_eq!(accepted.raster_pixels(), MAX_RASTER_PIXELS);
    assert_eq!(
        plan(&compiled, &values, &fonts, target(2000, 1000), Fit::Contain)
            .unwrap_err()
            .code,
        "text_layout_budget_exceeded"
    );
    let wrong_alias =
        BTreeMap::from([("brand-font-alias".to_owned(), fonts["brand-font"].clone())]);
    let alias_compiled = fixture.compile(
        json!([text("label", "brand-font-alias", json!({}))]),
        json!([]),
        [1000, 500],
    );
    let alias_values = final_values(&alias_compiled, json!({}));
    assert_eq!(
        plan(
            &alias_compiled,
            &alias_values,
            &wrong_alias,
            target(1000, 500),
            Fit::Contain
        )
        .unwrap_err()
        .code,
        "font_not_prepared"
    );
    assert_eq!(
        plan(
            &alias_compiled,
            &values,
            &fonts,
            target(1000, 500),
            Fit::Contain
        )
        .unwrap_err()
        .code,
        "invalid_input"
    );
}

#[test]
fn numeric_limits_reject_nonfinite_overflow_edges_and_pixels_without_clamping() {
    for (width, height, scale) in [
        (4097.0, 1.0, 1.0),
        (4096.0, 2026.0, 1.0),
        (f64::INFINITY, 1.0, 1.0),
        (1.0, f64::NAN, 1.0),
        (f64::MAX, 1.0, 64.0),
        (1.0, 1.0, f64::INFINITY),
    ] {
        assert_eq!(
            raster_dimensions(width, height, scale).unwrap_err().code,
            "text_layout_budget_exceeded"
        );
    }
    for sigma in [f64::NAN, f64::INFINITY, f64::MAX, -1.0] {
        assert_eq!(
            canonical_scale(sigma).unwrap_err().code,
            "text_layout_budget_exceeded"
        );
    }
    assert_eq!(canonical_scale(0.0).unwrap(), 1.0 / 64.0);
    assert_eq!(canonical_scale(1.0001).unwrap(), 65.0 / 64.0);
    assert_eq!(canonical_scale(65.0 / 64.0).unwrap(), 65.0 / 64.0);
    for matrix in [
        Affine {
            a: f64::MAX,
            ..Affine::IDENTITY
        },
        Affine {
            x: f64::NAN,
            ..Affine::IDENTITY
        },
    ] {
        assert_eq!(
            matrix.maximum_scale().unwrap_err().code,
            "text_layout_budget_exceeded"
        );
    }
    let large = Affine {
        a: 2.0,
        x: f64::MAX,
        ..Affine::IDENTITY
    };
    assert_eq!(
        large.multiply(large).unwrap_err().code,
        "text_layout_budget_exceeded"
    );
}

#[tokio::test]
async fn uniform_rotation_roundoff_does_not_add_a_raster_step_or_reject_4080_pixels() {
    let fixture = Fixture::new("text-raster-rotation-roundoff");
    let compiled = fixture.compile(
        json!([text(
            "label",
            "brand-font",
            json!({"width":1360,"rotation":1,"scaleX":3,"scaleY":3})
        )]),
        json!([]),
        [1000, 500],
    );
    let values = final_values(&compiled, json!({}));
    let fonts = fixture.fonts(&compiled, &values).await;
    let result = plan(&compiled, &values, &fonts, target(1000, 500), Fit::Contain).unwrap();
    let raster = &result.text_rasters()[0];
    assert_eq!(raster.scale(), 3.0);
    assert_eq!((raster.width_px(), raster.height_px()), (4080, 150));

    // A genuine increment outside the ULP window still requests a new step,
    // whose 4102-pixel width exceeds the unchanged 4096 edge limit.
    for scale in [3.000001, 193.0 / 64.0] {
        let increased = fixture.compile(
            json!([text(
                "label",
                "brand-font",
                json!({"width":1360,"rotation":1,"scaleX":scale,"scaleY":scale})
            )]),
            json!([]),
            [1000, 500],
        );
        let increased_values = final_values(&increased, json!({}));
        assert_eq!(
            plan(
                &increased,
                &increased_values,
                &fonts,
                target(1000, 500),
                Fit::Contain
            )
            .unwrap_err()
            .code,
            "text_layout_budget_exceeded"
        );
    }
}

#[tokio::test]
async fn signed_uniform_grid_scales_share_rasters_across_angles() {
    let fixture = Fixture::new("text-raster-grid-rotations");
    let initial = fixture.compile(
        json!([text("label", "brand-font", json!({"width":64,"height":31}))]),
        json!([]),
        [1000, 500],
    );
    let values = final_values(&initial, json!({}));
    let fonts = fixture.fonts(&initial, &values).await;
    for (scale, dimensions) in [
        (1.0 / 64.0, (1, 1)),
        (17.0 / 64.0, (17, 9)),
        (1.0, (64, 31)),
        (65.0 / 64.0, (65, 32)),
        (3.0, (192, 93)),
        (4095.0 / 64.0, (4095, 1984)),
    ] {
        let mut reference_key = None;
        for sign in [-1.0, 1.0] {
            for angle in [0, 1, 13, 45, 89, 179, 359] {
                let compiled = fixture.compile(
                    json!([text("label", "brand-font", json!({"width":64,"height":31,"rotation":angle,"scaleX":sign*scale,"scaleY":sign*scale}))]),
                    json!([]),
                    [1000, 500],
                );
                let values = final_values(&compiled, json!({}));
                let result =
                    plan(&compiled, &values, &fonts, target(1000, 500), Fit::Contain).unwrap();
                let raster = &result.text_rasters()[0];
                assert_eq!(
                    raster.scale(),
                    scale,
                    "angle={angle}, signed scale={}",
                    sign * scale
                );
                assert_eq!((raster.width_px(), raster.height_px()), dimensions);
                let reference = reference_key.get_or_insert_with(|| raster.raster_key().to_owned());
                assert_eq!(raster.raster_key(), reference.as_str());
            }
        }
    }
}

#[tokio::test]
async fn maximum_depth_uniform_transforms_and_canceling_rotations_keep_the_exact_grid_scale() {
    let fixture = Fixture::new("text-raster-nested-roundoff");
    let initial = fixture.compile(
        json!([text(
            "label",
            "brand-font",
            json!({"width":1360,"scaleX":3,"scaleY":3})
        )]),
        json!([]),
        [1000, 500],
    );
    let initial_values = final_values(&initial, json!({}));
    let fonts = fixture.fonts(&initial, &initial_values).await;
    let reference = plan(
        &initial,
        &initial_values,
        &fonts,
        target(1000, 500),
        Fit::Contain,
    )
    .unwrap();
    for rotations in [[1; 8], [13; 8], [1, -1, 13, -13, 45, -45, 17, -17]] {
        let mut nodes = vec![text(
            "label",
            "brand-font",
            json!({"width":1360,"rotation":rotations[0],"scaleX":3,"scaleY":3}),
        )];
        // The compiler's depth 8 includes the text node itself: seven group
        // ancestors plus its own transform exercise the full admitted chain.
        for (index, rotation) in rotations.into_iter().skip(1).enumerate() {
            let child = if index == 0 {
                "label".to_owned()
            } else {
                format!("parent-{}", index - 1)
            };
            // Two negative uniform ancestor scales cancel without changing the
            // largest singular value or the text representation.
            let scale = if index < 2 { -1.0 } else { 1.0 };
            nodes.push(json!({"id":format!("parent-{index}"),"type":"group","stateVersion":1,
                "children":[child],"properties":{"rotation":rotation,"scaleX":scale,"scaleY":scale}}));
        }
        let compiled = fixture.compile(json!(nodes), json!([]), [1000, 500]);
        let values = final_values(&compiled, json!({}));
        let result = plan(&compiled, &values, &fonts, target(1000, 500), Fit::Contain).unwrap();
        let raster = &result.text_rasters()[0];
        assert_eq!(raster.scale(), 3.0, "rotations={rotations:?}");
        assert_eq!((raster.width_px(), raster.height_px()), (4080, 150));
        assert_eq!(
            raster.raster_key(),
            reference.text_rasters()[0].raster_key()
        );
    }
}

#[test]
fn scale_rounding_window_is_bounded_and_does_not_relax_edge_or_pixel_limits() {
    let grid = 3.0_f64;
    let inside = f64::from_bits(grid.to_bits() + SCALE_ROUNDING_ULPS);
    let outside = f64::from_bits(grid.to_bits() + SCALE_ROUNDING_ULPS + 1);
    assert_eq!(canonical_scale(inside).unwrap(), grid);
    assert_eq!(canonical_scale(outside).unwrap(), 193.0 / 64.0);
    assert_eq!(canonical_scale(193.0 / 64.0).unwrap(), 193.0 / 64.0);
    let minimum = 1.0 / 64.0;
    assert_eq!(canonical_scale(minimum).unwrap(), minimum);
    assert_eq!(canonical_scale(f64::from_bits(1)).unwrap(), minimum);

    let increased =
        canonical_scale(f64::from_bits(1.0_f64.to_bits() + SCALE_ROUNDING_ULPS + 1)).unwrap();
    assert_eq!(increased, 65.0 / 64.0);
    assert_eq!(
        raster_dimensions(4096.0, 2025.0, 1.0).unwrap().2,
        MAX_RASTER_PIXELS
    );
    assert_eq!(
        raster_dimensions(4096.0, 1.0, increased).unwrap_err().code,
        "text_layout_budget_exceeded"
    );
    assert_eq!(
        raster_dimensions(2880.0, 2880.0, 1.0).unwrap().2,
        MAX_RASTER_PIXELS
    );
    assert_eq!(
        raster_dimensions(2880.0, 2880.0, increased)
            .unwrap_err()
            .code,
        "text_layout_budget_exceeded"
    );
}

#[test]
fn aggregate_raster_and_font_costs_use_checked_arithmetic() {
    for mut stats in [
        TextRasterPlan {
            unique_raster_count: u32::MAX,
            ..TextRasterPlan::default()
        },
        TextRasterPlan {
            raster_pixels: u64::MAX,
            ..TextRasterPlan::default()
        },
        TextRasterPlan {
            raster_rgba_bytes: u64::MAX,
            ..TextRasterPlan::default()
        },
    ] {
        assert_eq!(
            stats.add_raster_cost(1).unwrap_err().code,
            "text_layout_budget_exceeded"
        );
    }
    assert_eq!(
        TextRasterPlan::default()
            .add_raster_cost(u64::MAX)
            .unwrap_err()
            .code,
        "text_layout_budget_exceeded"
    );
    for mut stats in [
        TextRasterPlan {
            unique_font_count: u32::MAX,
            ..TextRasterPlan::default()
        },
        TextRasterPlan {
            font_cpu_bytes: u64::MAX,
            ..TextRasterPlan::default()
        },
    ] {
        assert_eq!(
            stats.add_font_cost(1).unwrap_err().code,
            "text_layout_budget_exceeded"
        );
    }
}
