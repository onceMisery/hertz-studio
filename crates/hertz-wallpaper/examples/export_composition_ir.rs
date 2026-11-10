// SPDX-License-Identifier: MIT
//! Browser verification uses the released Rust author compiler, not a JS IR mock.
use std::collections::BTreeMap;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if !(3..=4).contains(&args.len()) {
        return Err(
            "usage: export_composition_ir <manifest.json> <document.json> [public-values.json]"
                .into(),
        );
    }
    let manifest = hertz_wallpaper::validate_manifest_bytes(&std::fs::read(&args[1])?)?;
    let compiled =
        hertz_wallpaper::document::compile_document(&std::fs::read(&args[2])?, &manifest)?;
    let overrides = if args.len() == 4 {
        serde_json::from_slice(&std::fs::read(&args[3])?)?
    } else {
        BTreeMap::new()
    };
    let final_values = compiled.final_public_values(&overrides)?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "ir": compiled.ir(), "semanticKey": compiled.ir().semantic_key(), "finalPublicValues": final_values,
            "canvas": compiled.document().canvas,
            "timeline": {"durationSeconds": compiled.document().timeline.duration_seconds,
                "loop": compiled.document().timeline.r#loop}
        }))?
    );
    Ok(())
}
