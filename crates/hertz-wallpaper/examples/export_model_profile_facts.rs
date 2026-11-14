// SPDX-License-Identifier: MIT
//! Exports the prepared static-core/static-textured/static-ktx2 model facts
//! consumed by the shipped Three profiles. Verification only: this grants no
//! native adapter.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if !(4..=5).contains(&args.len()) {
        return Err(
            "usage: export_model_profile_facts <model.glb> <manifest.json> <package-path> [core|textured|ktx2]"
                .into(),
        );
    }
    let bytes = std::fs::read(&args[1])?;
    let manifest = hertz_wallpaper::validate_manifest_bytes(&std::fs::read(&args[2])?)?;
    let checked = hertz_wallpaper::model_binary::inspect_glb_resource_content(
        std::io::Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest,
        &args[3],
    )?;
    let facts = match args.get(4).map(String::as_str) {
        Some("textured") => hertz_wallpaper::model_profile::static_textured_profile_facts(
            checked.resource(),
            checked.bytes(),
            &args[3],
        )?,
        Some("ktx2") => hertz_wallpaper::model_profile::static_ktx2_profile_facts(
            &bytes,
            checked.resource(),
            checked.bytes(),
            &args[3],
            &std::collections::BTreeMap::new(),
        )?,
        _ => hertz_wallpaper::model_profile::static_core_profile_facts(
            checked.resource(),
            checked.bytes(),
        )?,
    };
    println!("{}", serde_json::to_string(&facts)?);
    Ok(())
}
