// SPDX-License-Identifier: MIT
//! Exports the prepared static-core model facts consumed by the shipped Three
//! profile. Verification only: this does not grant a native model adapter.
use std::fs::File;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 {
        return Err(
            "usage: export_model_profile_facts <model.glb> <manifest.json> <package-path>".into(),
        );
    }
    let manifest = hertz_wallpaper::validate_manifest_bytes(&std::fs::read(&args[2])?)?;
    let file = File::open(&args[1])?;
    let bytes = file.metadata()?.len();
    let checked = hertz_wallpaper::model_binary::inspect_glb_resource_content(
        file, bytes, &manifest, &args[3],
    )?;
    let facts = hertz_wallpaper::model_profile::static_core_profile_facts(
        checked.resource(),
        checked.bytes(),
    )?;
    println!("{}", serde_json::to_string(&facts)?);
    Ok(())
}
