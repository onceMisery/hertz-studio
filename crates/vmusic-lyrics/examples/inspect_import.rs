// SPDX-License-Identifier: MIT
//! Inspect original files through the production parser without rewriting them.
fn main() {
    let results: Vec<_> = std::env::args_os().skip(1).map(|path| {
        let input = std::fs::read_to_string(&path).expect("read original input");
        let name = std::path::Path::new(&path).file_name().unwrap().to_string_lossy();
        match vmusic_lyrics::parse_import(&input, "ttml") {
            Ok(doc) => serde_json::json!({"file":name,"accepted":true,"agents":doc.agents.len(),"lines":doc.lines.len(),"vocalDocument":doc.has_vocals()}),
            Err(error) => serde_json::json!({"file":name,"accepted":false,"category":error.category().to_string(),"message":error.to_string()}),
        }
    }).collect();
    println!("{}", serde_json::to_string_pretty(&results).unwrap());
}
