// SPDX-License-Identifier: MIT
// Shared by Cargo embedding and DBX staging; no frontend runtime is required.
use std::{fs, io, path::Path};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Block {
    Full,
    Desktop,
}

pub fn render(source: &str, full: bool, desktop: bool) -> io::Result<String> {
    let mut output = String::new();
    let mut blocks = Vec::new();
    for line in source.split_inclusive('\n') {
        let start = match line.trim() {
            "// edition:full" | "<!-- edition:full -->" | "/* edition:full */" => Some(Block::Full),
            "// form:desktop" | "<!-- form:desktop -->" | "/* form:desktop */" => {
                Some(Block::Desktop)
            }
            _ => None,
        };
        if let Some(block) = start {
            if blocks.contains(&block) {
                return Err(io::Error::other("nested block of the same kind"));
            }
            blocks.push(block);
            continue;
        }
        let end = match line.trim() {
            "// edition:end" | "<!-- edition:end -->" | "/* edition:end */" => Some(Block::Full),
            "// form:end" | "<!-- form:end -->" | "/* form:end */" => Some(Block::Desktop),
            _ => None,
        };
        if let Some(block) = end {
            if blocks.pop() != Some(block) {
                return Err(io::Error::other("unmatched or crossed block end"));
            }
            continue;
        }
        if blocks.iter().all(|block| match block {
            Block::Full => full,
            Block::Desktop => desktop,
        }) {
            output.push_str(line);
        }
    }
    if !blocks.is_empty() {
        return Err(io::Error::other("unterminated UI block"));
    }
    Ok(output)
}

fn ships(name: &str, full: bool, desktop: bool) -> bool {
    let name = name.strip_suffix(".gz").unwrap_or(name);
    if name == "desktop-settings.js" {
        return false;
    }
    if !desktop
        && matches!(
            name,
            "desktop-lyrics-settings.js"
                | "desktop-lyrics-settings.css"
                | "wallpaper-settings.js"
                | "wallpaper-settings.css"
        )
    {
        return false;
    }
    full || !matches!(name, "online-login.js" | "qrcode.js" | "platform-icons")
}

fn remove_managed(target: &Path, destination: &Path) -> io::Result<()> {
    let target = target.canonicalize()?;
    let destination = destination.canonicalize()?;
    if target == destination || !target.starts_with(&destination) {
        return Err(io::Error::other(
            "UI cleanup target escapes its destination",
        ));
    }
    if target.is_dir() {
        fs::remove_dir_all(target)
    } else {
        fs::remove_file(target)
    }
}

pub fn generate(source: &Path, dest: &Path, full: bool, desktop: bool) -> io::Result<()> {
    generate_directory(source, dest, full, desktop)?;
    // The player and DBX packages share the authored splash outside plugin/ui.
    // Copy it only at the player root, never once per recursive subdirectory.
    if source.join("startup.js").is_file() {
        let splash = source.join("../../splash/hertzstudio-splash.html");
        let splash_dest = dest.join("splash");
        fs::create_dir_all(&splash_dest)?;
        fs::write(
            splash_dest.join("hertzstudio-splash.html"),
            render(&fs::read_to_string(splash)?, full, desktop)?,
        )?;
    }
    Ok(())
}

fn generate_directory(source: &Path, dest: &Path, full: bool, desktop: bool) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    let source_root = source.canonicalize()?;
    let dest_root = dest.canonicalize()?;
    if source_root.starts_with(&dest_root) || dest_root.starts_with(&source_root) {
        return Err(io::Error::other(
            "UI source and destination must be separate",
        ));
    }
    // Reused output must not retain resources from another edition or form.
    for entry in fs::read_dir(dest)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !ships(&name, full, desktop)
            || (entry.path().extension().and_then(|s| s.to_str()) == Some("html")
                && !matches!(name.as_ref(), "index.html" | "overlay.html"))
        {
            remove_managed(&entry.path(), dest)?;
        }
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !ships(&name, full, desktop)
            || (entry.path().extension().and_then(|s| s.to_str()) == Some("html")
                && !matches!(name.as_ref(), "index.html" | "overlay.html"))
        {
            continue;
        }
        let input = entry.path();
        let output = dest.join(name.as_ref());
        if input.is_dir() {
            generate_directory(&input, &output, full, desktop)?;
        } else if matches!(
            input.extension().and_then(|s| s.to_str()),
            Some("html" | "js" | "css")
        ) {
            fs::write(output, render(&fs::read_to_string(input)?, full, desktop)?)?;
        } else {
            fs::copy(input, output)?;
        }
    }
    Ok(())
}

// Also compiled directly with rustc by the plugin packaging script.
#[allow(dead_code)]
fn main() -> io::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 5
        || !matches!(args[3].as_str(), "standard" | "full")
        || !matches!(args[4].as_str(), "dbx" | "desktop")
    {
        return Err(io::Error::other(
            "usage: edition-ui SOURCE DEST standard|full dbx|desktop",
        ));
    }
    generate(
        Path::new(&args[1]),
        Path::new(&args[2]),
        args[3] == "full",
        args[4] == "desktop",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editions_and_forms_are_independent_and_mixed_nesting_is_strict() {
        let src = "shared\n// edition:full\nplatform\n// form:desktop\nnative\n// form:end\n// edition:end\nend\n";
        assert_eq!(render(src, false, false).unwrap(), "shared\nend\n");
        assert_eq!(render(src, true, false).unwrap(), "shared\nplatform\nend\n");
        assert_eq!(
            render(src, true, true).unwrap(),
            "shared\nplatform\nnative\nend\n"
        );
        assert_eq!(
            render(
                "<!-- form:desktop -->\nnative\n<!-- form:end -->\n",
                false,
                false
            )
            .unwrap(),
            ""
        );
        for src in [
            "// edition:full\n",
            "// edition:end\n",
            "// form:desktop\n",
            "// form:end\n",
            "// form:desktop\n// form:desktop\n",
            "// form:desktop\n// edition:full\n// form:end\n",
        ] {
            assert!(render(src, true, true).is_err(), "{src}");
        }
    }

    #[test]
    fn reused_output_retires_desktop_assets_and_preserves_shared_music() {
        let temp = std::env::temp_dir().canonicalize().unwrap();
        let root = temp.join(format!("hertz-edition-test-{}", std::process::id()));
        let source = root.join("source");
        let dest = root.join("dest");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dest).unwrap();
        for file in [
            "index.html",
            "overlay.html",
            "probe.html",
            "app.js",
            "online-login.js",
            "desktop-settings.js",
            "desktop-lyrics-settings.js",
            "desktop-lyrics-settings.css",
            "wallpaper-settings.js",
            "wallpaper-settings.css",
            "stage.js",
        ] {
            fs::write(source.join(file), "music\n// form:desktop\nnative\n// form:end\n// edition:full\nfull\n// edition:end\n").unwrap();
        }
        generate(&source, &dest, true, true).unwrap();
        assert!(dest.join("desktop-lyrics-settings.js").exists());
        fs::write(dest.join("desktop-lyrics-settings.js.gz"), "old native").unwrap();
        fs::write(dest.join("stale-probe.html"), "old diagnostic").unwrap();
        generate(&source, &dest, false, false).unwrap();
        for file in ["index.html", "overlay.html", "app.js", "stage.js"] {
            assert_eq!(fs::read_to_string(dest.join(file)).unwrap(), "music\n");
        }
        for file in [
            "probe.html",
            "stale-probe.html",
            "online-login.js",
            "desktop-settings.js",
            "desktop-lyrics-settings.js",
            "desktop-lyrics-settings.js.gz",
            "desktop-lyrics-settings.css",
            "wallpaper-settings.js",
            "wallpaper-settings.css",
        ] {
            assert!(!dest.join(file).exists(), "{file}");
        }
        assert!(generate(&source, &source, true, true).is_err());
        remove_managed(&root, &temp).unwrap();
    }
}
