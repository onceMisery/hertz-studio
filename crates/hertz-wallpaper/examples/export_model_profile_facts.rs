// SPDX-License-Identifier: MIT
//! Exports the prepared static-core/static-textured model facts consumed by the
//! shipped Three profiles. Verification only: this grants no native adapter.
use std::fs::File;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if !(4..=5).contains(&args.len()) {
        return Err("usage: export_model_profile_facts <model.glb> <manifest.json> <package-path> [core|textured]".into());
    }
    let manifest = hertz_wallpaper::validate_manifest_bytes(&std::fs::read(&args[2])?)?;
    let file = File::open(&args[1])?;
    let bytes = file.metadata()?.len();
    let checked = hertz_wallpaper::model_binary::inspect_glb_resource_content(
        file, bytes, &manifest, &args[3],
    )?;
    let facts = if args.get(4).is_some_and(|profile| profile == "textured") {
        hertz_wallpaper::model_profile::static_textured_profile_facts(
            checked.resource(),
            checked.bytes(),
        )?
    } else {
        hertz_wallpaper::model_profile::static_core_profile_facts(
            checked.resource(),
            checked.bytes(),
        )?
    };
    println!("{}", serde_json::to_string(&facts)?);
    Ok(())
}
