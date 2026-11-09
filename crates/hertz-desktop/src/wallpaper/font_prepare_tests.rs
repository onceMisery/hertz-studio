// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
use super::*;
use base64::Engine;
use std::collections::BTreeMap;
use std::io::{Cursor, Write};

const FONT_HASH: &str = "52e207c6d3cd36d1880050598c4c31f16848575b5f419fd9a78ed486c16acbaf";
const OFL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../plugin/ui/fonts/InstrumentSerif-OFL.txt"
));

fn font() -> Vec<u8> {
    let css = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../plugin/ui/fonts/brand.css"
    ));
    let encoded = css
        .split("data:font/ttf;base64,")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    assert_eq!(bytes.len(), 8336);
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), FONT_HASH);
    assert!(OFL.contains("Copyright 2022 The Instrument Serif Project Authors"));
    assert!(OFL.contains("SIL OPEN FONT LICENSE Version 1.1"));
    bytes
}

fn entry(bytes: &[u8]) -> hertz_wallpaper::VerifiedEntry {
    hertz_wallpaper::VerifiedEntry {
        path: "assets/instrument-serif.ttf".into(),
        bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        mime: Some("font/ttf".into()),
    }
}

fn texts(text: &str) -> Vec<RequiredText> {
    vec![RequiredText {
        node_id: "title".into(),
        text: text.into(),
    }]
}

fn tables(bytes: &[u8]) -> BTreeMap<[u8; 4], Vec<u8>> {
    (0..usize::from(u16_at(bytes, 4).unwrap()))
        .map(|index| {
            let record = 12 + 16 * index;
            let tag = bytes[record..record + 4].try_into().unwrap();
            let offset = u32_at(bytes, record + 8).unwrap() as usize;
            let length = u32_at(bytes, record + 12).unwrap() as usize;
            (tag, bytes[offset..offset + length].to_vec())
        })
        .collect()
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

/// Modified OFL TTF fixtures keep real outlines and rebuild a valid SFNT table
/// directory/checksums. This is not an OTF-signature substitute.
fn rebuild(mut tables: BTreeMap<[u8; 4], Vec<u8>>) -> Vec<u8> {
    if let Some(head) = tables.get_mut(b"head") {
        head[8..12].fill(0);
    }
    let count = tables.len();
    let power = 1usize << (usize::BITS - count.leading_zeros() - 1);
    let mut bytes = vec![0; 12 + 16 * count];
    bytes[..4].copy_from_slice(b"\0\x01\0\0");
    bytes[4..6].copy_from_slice(&(count as u16).to_be_bytes());
    bytes[6..8].copy_from_slice(&((power * 16) as u16).to_be_bytes());
    bytes[8..10].copy_from_slice(&(power.trailing_zeros() as u16).to_be_bytes());
    bytes[10..12].copy_from_slice(&((count * 16 - power * 16) as u16).to_be_bytes());
    let mut head_offset = None;
    for (index, (tag, table)) in tables.into_iter().enumerate() {
        let record = 12 + 16 * index;
        let offset = bytes.len();
        bytes[record..record + 4].copy_from_slice(&tag);
        bytes[record + 4..record + 8].copy_from_slice(&checksum(&table).to_be_bytes());
        bytes[record + 8..record + 12].copy_from_slice(&(offset as u32).to_be_bytes());
        bytes[record + 12..record + 16].copy_from_slice(&(table.len() as u32).to_be_bytes());
        if tag == *b"head" {
            head_offset = Some(offset);
        }
        bytes.extend_from_slice(&table);
        while !bytes.len().is_multiple_of(4) {
            bytes.push(0);
        }
    }
    if let Some(offset) = head_offset {
        let adjustment = 0xb1b0_afbau32.wrapping_sub(checksum(&bytes));
        bytes[offset + 8..offset + 12].copy_from_slice(&adjustment.to_be_bytes());
    }
    bytes
}

/// Preserve the licensed face's actual cmap/outlines, adding legal empty glyphs
/// and a private table. The original static parser, not forged metadata, must
/// prove the exact encoded/glyph CPU boundary consumed by group regressions.
pub(crate) fn glyph_cost_font_fixture(marker: u8) -> Vec<u8> {
    let mut source = tables(&font());
    let glyphs = 30_000u16;
    source.get_mut(b"maxp").unwrap()[4..6].copy_from_slice(&glyphs.to_be_bytes());
    let long = u16_at(source.get(b"head").unwrap(), 50).unwrap() == 1;
    let loca = source.get_mut(b"loca").unwrap();
    let width = if long { 4 } else { 2 };
    let last = loca[loca.len() - width..].to_vec();
    while loca.len() < (usize::from(glyphs) + 1) * width {
        loca.extend_from_slice(&last);
    }
    let metrics = usize::from(u16_at(source.get(b"hhea").unwrap(), 34).unwrap());
    source
        .get_mut(b"hmtx")
        .unwrap()
        .resize(metrics * 4 + (usize::from(glyphs) - metrics) * 2, 0);
    source.insert(*b"HRTZ", Vec::new());
    let encoded = 13_107_200usize; // exactly 12.5 MiB
    let overhead = rebuild(source.clone()).len();
    source.insert(*b"HRTZ", vec![marker; encoded - overhead]);
    let bytes = rebuild(source);
    assert_eq!(bytes.len(), encoded);
    let metadata = validate_bytes(&entry(&bytes), &bytes, &texts("Hertz")).unwrap();
    assert_eq!(metadata.glyph_count, u32::from(glyphs));
    assert_eq!(
        metadata.cpu_budget_bytes,
        5 * bytes.len() as u64 + 64 * u64::from(glyphs) + 4096
    );
    bytes
}

#[test]
fn legal_glyph_cost_fixtures_cross_aggregate_cpu_cap_without_encoded_cost_crossing_it() {
    let first = glyph_cost_font_fixture(1);
    let second = glyph_cost_font_fixture(2);
    let a = validate_bytes(&entry(&first), &first, &texts("Hertz")).unwrap();
    let b = validate_bytes(&entry(&second), &second, &texts("Hertz")).unwrap();
    let cap = super::super::budget::MAX_CPU_DECODED_BYTES;
    assert!(5 * ((first.len() + second.len()) as u64) < cap);
    assert!(a.cpu_budget_bytes < cap && b.cpu_budget_bytes < cap);
    assert!(a.cpu_budget_bytes + b.cpu_budget_bytes > cap);
}

#[test]
fn read_only_plan_facts_preserve_original_seal_and_exact_raw_text_coverage() {
    let (store, _directory, reference, expected) = installed("font-inspected-plan-seal");
    let probe = super::super::decode_probe::ProbeClient::testing_input(|_, _| {
        panic!("facts do not qualify")
    });
    let workspace = probe
        .image_workspace(prepare_workspace_bytes(expected.bytes).unwrap())
        .unwrap();
    let required = texts("Hertz\r\n\tStudio");
    let input = pin_input(
        &store,
        &reference,
        &expected,
        &required,
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    workspace.finish();
    let facts = input.plan_facts().unwrap();
    assert_eq!(facts.reference().asset_id, reference.asset_id);
    assert_eq!(facts.content_key(), content_key(&input).unwrap());
    assert_eq!(facts.sealed_metadata(), &input.metadata);
    assert!(facts.covers_required_texts(&required));
    assert!(!facts.covers_required_texts(&texts("Hertz\n    Studio")));
    let mut changed = input.clone();
    changed.metadata.glyph_count += 1;
    assert_eq!(
        changed.plan_facts().err().unwrap().code,
        "font_input_changed"
    );
    assert!(!changed.covers_required_texts(&required));
    changed = input.clone();
    changed.package_hash = "a".repeat(64);
    assert_eq!(
        changed.plan_facts().err().unwrap().code,
        "font_input_changed"
    );
    assert_eq!(probe.stats(), (0, 0));
}

fn with_variation(default: bool, glyph: u16) -> Vec<u8> {
    let mut tables = tables(&font());
    let old = tables.get(b"cmap").unwrap();
    let count = usize::from(u16_at(old, 2).unwrap());
    let old_header = 4 + 8 * count;
    let mut cmap = Vec::new();
    cmap.extend_from_slice(&0u16.to_be_bytes());
    cmap.extend_from_slice(&((count + 1) as u16).to_be_bytes());
    for index in 0..count {
        let record = 4 + index * 8;
        cmap.extend_from_slice(&old[record..record + 4]);
        cmap.extend_from_slice(&(u32_at(old, record + 4).unwrap() + 8).to_be_bytes());
    }
    cmap.extend_from_slice(&0u16.to_be_bytes());
    cmap.extend_from_slice(&5u16.to_be_bytes());
    cmap.extend_from_slice(&((old.len() + 8) as u32).to_be_bytes());
    cmap.extend_from_slice(&old[old_header..]);
    cmap.extend_from_slice(&14u16.to_be_bytes());
    cmap.extend_from_slice(&(if default { 29u32 } else { 30u32 }).to_be_bytes());
    cmap.extend_from_slice(&1u32.to_be_bytes());
    cmap.extend_from_slice(&[0, 0xfe, 0x0f]); // VS16
    cmap.extend_from_slice(&(if default { 21u32 } else { 0u32 }).to_be_bytes());
    cmap.extend_from_slice(&(if default { 0u32 } else { 21u32 }).to_be_bytes());
    cmap.extend_from_slice(&1u32.to_be_bytes());
    cmap.extend_from_slice(&[0, 0, b'H']);
    if default {
        cmap.push(0);
    } else {
        cmap.extend_from_slice(&glyph.to_be_bytes());
    }
    tables.insert(*b"cmap", cmap);
    rebuild(tables)
}

fn only_space() -> Vec<u8> {
    let original = font();
    let space = Face::parse(&original, 0)
        .unwrap()
        .glyph_index(' ')
        .unwrap()
        .0;
    let mut tables = tables(&original);
    let mut cmap = Vec::new();
    for value in [0u16, 1, 3, 1] {
        cmap.extend_from_slice(&value.to_be_bytes());
    }
    cmap.extend_from_slice(&12u32.to_be_bytes());
    for value in [
        4u16,
        32,
        0,
        4,
        4,
        1,
        0,
        32,
        0xffff,
        0,
        32,
        0xffff,
        space.wrapping_sub(32),
        1,
        0,
        0,
    ] {
        cmap.extend_from_slice(&value.to_be_bytes());
    }
    tables.insert(*b"cmap", cmap);
    rebuild(tables)
}

#[test]
fn licensed_ttf_has_real_cmap_probe_and_checked_cost_facts() {
    let bytes = font();
    let info = validate_bytes(&entry(&bytes), &bytes, &texts("Hertz Studio")).unwrap();
    assert_eq!(info.format, FontFormat::Ttf);
    assert_eq!(info.sfnt_bytes, 8336);
    assert_eq!(info.glyph_count, 15);
    assert_eq!(info.cpu_budget_bytes, 5 * 8336 + 64 * 15 + 4096);
    assert!(!info.probe_text.is_empty());
    assert!(info.probe_text.chars().count() <= 32);
    assert!(info
        .probe_text
        .chars()
        .collect::<Vec<_>>()
        .windows(2)
        .all(|pair| pair[0] < pair[1]));
    validate_required_text(&bytes, "probe", &info.probe_text).unwrap();
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["format"], "ttf");
    assert_eq!(json["sfntBytes"], 8336);
    assert_eq!(serde_json::from_value::<FontMetadata>(json).unwrap(), info);
}

#[test]
fn exact_hash_length_mime_and_magic_are_independent_rejection_boundaries() {
    let bytes = font();
    let mut expected = entry(&bytes);
    expected.sha256 = "0".repeat(64);
    assert_eq!(
        validate_bytes(&expected, &bytes, &[]).unwrap_err().code,
        "hash_mismatch"
    );
    expected = entry(&bytes);
    expected.bytes += 1;
    assert_eq!(
        validate_bytes(&expected, &bytes, &[]).unwrap_err().code,
        "hash_mismatch"
    );
    for mime in [None, Some("font/otf".into()), Some("image/png".into())] {
        expected = entry(&bytes);
        expected.mime = mime;
        assert_eq!(
            validate_bytes(&expected, &bytes, &[]).unwrap_err().code,
            "font_mime_mismatch"
        );
    }
    let mut bad = bytes.clone();
    bad[..4].copy_from_slice(b"junk");
    assert_eq!(
        validate_bytes(&entry(&bad), &bad, &[]).unwrap_err().code,
        "font_invalid"
    );
    assert_eq!(
        validate_bytes(&entry(&bytes[..3]), &bytes[..3], &[])
            .unwrap_err()
            .code,
        "font_invalid"
    );
}

#[test]
fn ttc_and_webfont_containers_stay_explicitly_unprepared() {
    for signature in [b"ttcf", b"wOF2", b"wOFF"] {
        let bytes = signature.to_vec();
        assert_eq!(
            validate_bytes(&entry(&bytes), &bytes, &[])
                .unwrap_err()
                .code,
            "font_format_not_prepared"
        );
    }
    assert_eq!(
        ensure_native_format(FontFormat::Otf).unwrap_err().code,
        "font_format_not_prepared"
    );
    assert_eq!(serde_json::to_value(FontFormat::Otf).unwrap(), "otf");
}

#[test]
fn sixteen_mib_is_bounded_before_parser_and_cost_arithmetic_is_checked() {
    let mut bytes = font();
    bytes.resize(MAX_FONT_BYTES as usize, 0);
    assert!(validate_bytes(&entry(&bytes), &bytes, &texts("Hertz")).is_ok());
    bytes.push(0);
    assert_eq!(
        validate_bytes(&entry(&bytes), &bytes, &[])
            .unwrap_err()
            .code,
        "font_size_exceeded"
    );
    assert_eq!(
        prepare_workspace_bytes(MAX_FONT_BYTES + 1)
            .unwrap_err()
            .code,
        "font_size_exceeded"
    );
    assert_eq!(
        prepare_workspace_bytes(0).unwrap_err().code,
        "font_size_exceeded"
    );
    assert!(
        prepare_workspace_bytes(MAX_FONT_BYTES).unwrap()
            < super::super::budget::MAX_PREPARE_CPU_BYTES
    );
    assert_eq!(
        cpu_budget_bytes(u64::MAX, 1, 1).unwrap_err().code,
        "probe_budget_exceeded"
    );
    assert_eq!(
        cpu_budget_bytes(1, u64::MAX, 1).unwrap_err().code,
        "probe_budget_exceeded"
    );
}

#[test]
fn damaged_required_tables_ranges_and_optional_checksums_are_rejected() {
    let original = font();
    for tag in [
        *b"head", *b"hhea", *b"maxp", *b"hmtx", *b"cmap", *b"loca", *b"glyf", *b"GPOS",
    ] {
        let mut bytes = original.clone();
        let records = Face::parse(&bytes, 0).unwrap().raw_face().table_records;
        let record = records
            .into_iter()
            .find(|record| record.tag == Tag::from_bytes(&tag))
            .unwrap();
        bytes[record.offset as usize] ^= 0x80;
        assert_eq!(
            validate_bytes(&entry(&bytes), &bytes, &[])
                .unwrap_err()
                .code,
            "font_invalid",
            "{tag:?}"
        );
    }
    let mut bytes = original.clone();
    bytes[20..24].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(
        validate_bytes(&entry(&bytes), &bytes, &[])
            .unwrap_err()
            .code,
        "font_invalid"
    );
    let mut broken = tables(&original);
    broken.remove(b"head");
    let bytes = rebuild(broken);
    assert_eq!(
        validate_bytes(&entry(&bytes), &bytes, &[])
            .unwrap_err()
            .code,
        "font_invalid"
    );
    let mut broken = tables(&original);
    broken.get_mut(b"maxp").unwrap()[4..6].fill(0);
    let bytes = rebuild(broken);
    assert_eq!(
        validate_bytes(&entry(&bytes), &bytes, &[])
            .unwrap_err()
            .code,
        "font_invalid"
    );
    let mut broken = tables(&original);
    broken.get_mut(b"loca").unwrap()[30..32].copy_from_slice(&u16::MAX.to_be_bytes());
    let bytes = rebuild(broken);
    assert_eq!(
        validate_bytes(&entry(&bytes), &bytes, &[])
            .unwrap_err()
            .code,
        "font_invalid"
    );
}

#[test]
fn no_unicode_cmap_and_no_actual_probe_outline_cannot_become_font_facts() {
    let mut broken = tables(&font());
    let cmap = broken.get_mut(b"cmap").unwrap();
    for index in 0..usize::from(u16_at(cmap, 2).unwrap()) {
        cmap[4 + 8 * index..6 + 8 * index].copy_from_slice(&1u16.to_be_bytes());
    }
    let bytes = rebuild(broken);
    assert_eq!(
        validate_bytes(&entry(&bytes), &bytes, &[])
            .unwrap_err()
            .code,
        "font_invalid"
    );
    let bytes = only_space();
    validate_required_text(&bytes, "spaces", " \t\r\n").unwrap();
    assert_eq!(
        validate_bytes(&entry(&bytes), &bytes, &[])
            .unwrap_err()
            .code,
        "font_probe_glyph_unavailable"
    );
}

#[test]
fn display_normalization_validates_space_and_preserves_author_text() {
    let bytes = font();
    let text = "Hertz\r\nStudio\r\tHertz";
    assert_eq!(
        validate_required_text(&bytes, "title", text).unwrap(),
        "Hertz\nStudio\n    Hertz"
    );
    assert_eq!(text, "Hertz\r\nStudio\r\tHertz");
    let info = validate_bytes(&entry(&bytes), &bytes, &texts("\r\n\t")).unwrap();
    assert!(!info.probe_text.is_empty());
    let error = validate_required_text(&bytes, "heading", "Hertz 中").unwrap_err();
    assert_eq!(error.code, "font_glyph_unavailable");
    assert_eq!(error.details.unwrap()["nodeId"], "heading");
    assert_eq!(
        validate_required_text(&bytes, "emoji", "😀")
            .unwrap_err()
            .code,
        "font_glyph_unavailable"
    );
    let mut broken = tables(&font());
    let cmap = broken.get_mut(b"cmap").unwrap();
    // Fixture's shared format-4 subtable: make space map to .notdef while keeping
    // every other glyph and the directory valid. TAB must then fail too.
    let offset = u32_at(cmap, 8).unwrap() as usize;
    let segments = usize::from(u16_at(cmap, offset + 6).unwrap()) / 2;
    let deltas = offset + 16 + segments * 4;
    cmap[deltas..deltas + 2].copy_from_slice(&(-32i16).to_be_bytes());
    let bytes = rebuild(broken);
    assert_eq!(
        validate_required_text(&bytes, "tab", "\t")
            .unwrap_err()
            .code,
        "font_glyph_unavailable"
    );
}

#[test]
fn only_explicit_zero_width_controls_bypass_glyph_lookup() {
    let bytes = font();
    for codepoint in [
        0x061c, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
        0x2067, 0x2068, 0x2069,
    ] {
        validate_required_text(
            &bytes,
            "title",
            &format!("H{}ertz", char::from_u32(codepoint).unwrap()),
        )
        .unwrap();
    }
    for scalar in [
        '\0',
        '\u{7}',
        '\u{b}',
        '\u{c}',
        '\u{7f}',
        '\u{85}',
        '\u{ad}',
        '\u{200b}',
        '\u{2028}',
        '\u{2029}',
        '\u{2060}',
        '\u{206a}',
        '\u{feff}',
        '\u{e0020}',
    ] {
        let error = validate_required_text(&bytes, "controls", &format!("H{scalar}")).unwrap_err();
        assert_eq!(
            error.code, "text_control_unsupported",
            "U+{:04X}",
            scalar as u32
        );
        assert_eq!(error.details.unwrap()["nodeId"], "controls");
    }
}

#[test]
fn variation_selector_requires_actual_base_sequence_in_format_fourteen() {
    let bytes = font();
    for text in [
        "H\u{fe0f}",
        "\u{fe0f}",
        "H\n\u{fe0f}",
        "H\u{200d}\u{fe0f}",
        "H\u{e0100}",
    ] {
        assert_eq!(
            validate_required_text(&bytes, "variation", text)
                .unwrap_err()
                .code,
            "font_glyph_unavailable"
        );
    }
    let h = Face::parse(&bytes, 0).unwrap().glyph_index('H').unwrap().0;
    for bytes in [with_variation(true, h), with_variation(false, h)] {
        assert_eq!(
            validate_required_text(&bytes, "variation", "H\u{fe0f}").unwrap(),
            "H\u{fe0f}"
        );
        assert_eq!(
            validate_required_text(&bytes, "variation", "S\u{fe0f}")
                .unwrap_err()
                .code,
            "font_glyph_unavailable"
        );
        assert_eq!(
            validate_required_text(&bytes, "variation", "H\u{fe0f}\u{fe0f}")
                .unwrap_err()
                .code,
            "font_glyph_unavailable"
        );
    }
    let bytes = with_variation(false, 0);
    assert_eq!(
        validate_required_text(&bytes, "variation", "H\u{fe0f}")
            .unwrap_err()
            .code,
        "font_glyph_unavailable"
    );
}

pub(super) fn installed(
    tag: &str,
) -> (
    AssetStore,
    super::super::library::tempfileish::TempDir,
    AssetRef,
    hertz_wallpaper::VerifiedEntry,
) {
    let font = font();
    let mut other_tables = tables(&font);
    other_tables.get_mut(b"head").unwrap()[4..8].copy_from_slice(&0x0002_0000u32.to_be_bytes());
    let other_font = rebuild(other_tables);
    let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==").unwrap();
    let manifest = serde_json::json!({
        "formatVersion": 1, "workId": "c17ed10a-5c55-4a52-85dc-7509f9e88aae", "version": 1,
        "title": "Font preparation", "description": "", "content": {"kind": "image", "asset": "background"},
        "assets": [{"id": "background", "kind": "image", "source": "assets/background.png", "variants": []},
            {"id": "brand-font", "kind": "font", "source": "assets/instrument-serif.ttf", "variants": []},
            {"id": "brand-font-alias", "kind": "font", "source": "assets/instrument-serif.ttf", "variants": []},
            {"id": "brand-font-b", "kind": "font", "source": "assets/instrument-serif-b.ttf", "variants": []}],
        "files": [{"path": "assets/background.png", "bytes": png.len(), "sha256": format!("{:x}", Sha256::digest(&png)), "mime": "image/png"},
            {"path": "assets/instrument-serif.ttf", "bytes": font.len(), "sha256": FONT_HASH, "mime": "font/ttf"},
            {"path": "assets/instrument-serif-b.ttf", "bytes": other_font.len(), "sha256": format!("{:x}", Sha256::digest(&other_font)), "mime": "font/ttf"},
            {"path": "licenses/instrument-serif-ofl.txt", "bytes": OFL.len(), "sha256": format!("{:x}", Sha256::digest(OFL.as_bytes())), "mime": "text/plain"}],
        "properties": [], "permissions": {"audioSpectrum": false, "pointer": false},
        "license": {"code": "none", "assets": "OFL-1.1", "attribution": "Copyright 2022 The Instrument Serif Project Authors; licenses/instrument-serif-ofl.txt"}
    });
    let mut buffer = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut buffer);
    for (path, bytes) in [
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("assets/background.png", png),
        ("assets/instrument-serif.ttf", font.clone()),
        ("assets/instrument-serif-b.ttf", other_font),
        ("licenses/instrument-serif-ofl.txt", OFL.as_bytes().to_vec()),
    ] {
        zip.start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap();
    let dir = super::super::library::tempfileish::temp_dir(tag);
    let store = AssetStore::new(dir.path()).unwrap();
    let source = dir.path().join("source.hwpkg");
    std::fs::write(&source, buffer.into_inner()).unwrap();
    store.snapshot_input("font-job", &source, None).unwrap();
    let package = store.validate_staged("font-job").unwrap();
    store.unpack_projection("font-job", &package).unwrap();
    store
        .content_writer()
        .unwrap()
        .publish_staging("font-job", &package.package_hash)
        .unwrap();
    let reference = AssetRef {
        package_hash: package.package_hash,
        asset_id: "brand-font".into(),
        variant_id: None,
    };
    (store, dir, reference, entry(&font))
}

fn probe() -> super::super::decode_probe::ProbeClient {
    super::super::decode_probe::ProbeClient::testing(|_, _| {
        Box::pin(async {
            Err(JobError::new(
                "probe_inconclusive",
                "font byte checks do not run a native probe",
            ))
        })
    })
}

#[test]
fn verified_font_pin_blocks_mutation_and_identity_deduplicates_asset_aliases() {
    let (store, _dir, reference, expected) = installed("font-pin");
    let probe = probe();
    let workspace = probe
        .image_workspace(prepare_workspace_bytes(expected.bytes).unwrap())
        .unwrap();
    let input = pin_input(
        &store,
        &reference,
        &expected,
        &texts("Hertz Studio"),
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    let key = content_key(&input).unwrap();
    assert_eq!(key.len(), 64);
    assert!(std::fs::write(&input.media.path, b"tampered").is_err());
    assert!(std::fs::write(
        store
            .package_dir(&reference.package_hash)
            .join("original.hwpkg"),
        b"tampered"
    )
    .is_err());
    let mut alias_ref = reference.clone();
    alias_ref.asset_id = "brand-font-alias".into();
    let mut alias = pin_input(
        &store,
        &alias_ref,
        &expected,
        &texts("Hertz Studio"),
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(content_key(&alias).unwrap(), key);
    alias.metadata.probe_text.push('H');
    assert_eq!(content_key(&alias).unwrap_err().code, "font_input_changed");
    drop(alias);
    drop(input);
    workspace.finish();
}

#[test]
fn original_workspace_is_required_before_font_io_and_request_facts_are_fixed() {
    let (store, _dir, mut reference, expected) = installed("font-workspace");
    let probe = probe();
    let insufficient = probe.image_workspace(1).unwrap();
    assert_eq!(
        pin_input(
            &store,
            &reference,
            &expected,
            &[],
            &insufficient,
            &AtomicBool::new(false)
        )
        .err()
        .unwrap()
        .code,
        "budget_busy"
    );
    insufficient.finish();
    let workspace = probe
        .image_workspace(prepare_workspace_bytes(expected.bytes).unwrap())
        .unwrap();
    let mut mismatch = expected.clone();
    mismatch.sha256 = "0".repeat(64);
    assert_eq!(
        pin_input(
            &store,
            &reference,
            &mismatch,
            &[],
            &workspace,
            &AtomicBool::new(false)
        )
        .err()
        .unwrap()
        .code,
        "hash_mismatch"
    );
    assert_eq!(
        pin_input(
            &store,
            &reference,
            &expected,
            &[],
            &workspace,
            &AtomicBool::new(true)
        )
        .err()
        .unwrap()
        .code,
        "cancelled"
    );
    reference.asset_id = "background".into();
    assert_eq!(
        pin_input(
            &store,
            &reference,
            &expected,
            &[],
            &workspace,
            &AtomicBool::new(false)
        )
        .err()
        .unwrap()
        .code,
        "font_asset_kind_mismatch"
    );
    workspace.finish();
}

#[test]
fn prepare_slot_alone_cannot_bypass_the_workspace_before_any_font_read() {
    let (store, _dir, mut reference, expected) = installed("font-workspace-bypass");
    let probe = probe();
    let slot = probe.prepare("font-prepare-slot-only".into()).unwrap();
    // A valid but absent package would fail its first native file open. A slot
    // without CPU workspace must reject before that open or any SFNT parsing.
    reference.package_hash = "f".repeat(64);
    let error = pin_input(
        &store,
        &reference,
        &expected,
        &texts("Hertz"),
        &slot,
        &AtomicBool::new(false),
    )
    .err()
    .unwrap();
    assert_eq!(error.code, "budget_busy");
    let workspace = probe
        .image_workspace(prepare_workspace_bytes(expected.bytes).unwrap())
        .unwrap();
    let error = pin_input(
        &store,
        &reference,
        &expected,
        &texts("Hertz"),
        &workspace,
        &AtomicBool::new(false),
    )
    .err()
    .unwrap();
    assert_eq!(
        error.code, "io",
        "only admitted parsing reaches the fixed file open"
    );
    workspace.finish();
    slot.finish();
}

#[tokio::test]
async fn qualification_seals_only_the_exact_pinned_asset_reference() {
    use super::super::decode_probe::{ProbeClient, ProbeInput};
    use super::super::library::Library;

    let (store, dir, reference, expected) = installed("font-reference-seal");
    let library = Library::open(dir.path()).await.unwrap();
    let probe = ProbeClient::testing_input(|input, _| {
        assert!(matches!(input, ProbeInput::Font(_)));
        Box::pin(async { Ok(()) })
    });
    let workspace = probe
        .image_workspace(prepare_workspace_bytes(expected.bytes).unwrap())
        .unwrap();
    let input = pin_input(
        &store,
        &reference,
        &expected,
        &texts("Hertz"),
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    let mut alias_ref = reference.clone();
    alias_ref.asset_id = "brand-font-alias".into();
    let alias_input = pin_input(
        &store,
        &alias_ref,
        &expected,
        &texts("Hertz"),
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        content_key(&input).unwrap(),
        content_key(&alias_input).unwrap()
    );
    workspace.finish();

    for asset_id in ["background", "brand-font-alias", "missing-font"] {
        let proof = probe
            .qualify_font(&library, input.clone(), Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        let mut wrong = reference.clone();
        wrong.asset_id = asset_id.into();
        assert_eq!(
            PreparedFont::after_qualification(wrong, input.clone(), proof)
                .err()
                .unwrap()
                .code,
            "invalid_input",
            "even a genuine content proof cannot substitute asset {asset_id}",
        );
    }

    let proof = probe
        .qualify_font(&library, input.clone(), Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    let prepared = PreparedFont::after_qualification(reference.clone(), input, proof).unwrap();
    assert_eq!(prepared.reference().asset_id, "brand-font");
    let proof = probe
        .qualify_font(
            &library,
            alias_input.clone(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let alias = PreparedFont::after_qualification(alias_ref, alias_input, proof).unwrap();
    assert_eq!(alias.reference().asset_id, "brand-font-alias");
    assert_eq!(prepared.content_key(), alias.content_key());
    drop(prepared);
    drop(alias);
    library.pool().close().await;
}

#[tokio::test]
async fn prepared_font_reuses_only_its_own_exact_final_node_text_pairs() {
    use super::super::decode_probe::{ProbeClient, ProbeInput};
    use super::super::library::Library;

    let (store, dir, reference, expected) = installed("font-required-text-seal");
    let library = Library::open(dir.path()).await.unwrap();
    let probe = ProbeClient::testing_input(|input, _| {
        assert!(matches!(input, ProbeInput::Font(_)));
        Box::pin(async { Ok(()) })
    });
    let workspace = probe
        .image_workspace(prepare_workspace_bytes(expected.bytes).unwrap())
        .unwrap();
    let mut required = vec![
        RequiredText {
            node_id: "title".into(),
            text: "Hertz".into(),
        },
        RequiredText {
            node_id: "chorus".into(),
            text: "Studio\r\n\tHertz".into(),
        },
    ];
    let input = pin_input(
        &store,
        &reference,
        &expected,
        &required,
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    let no_text_input = pin_input(
        &store,
        &reference,
        &expected,
        &[],
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        content_key(&input).unwrap(),
        content_key(&no_text_input).unwrap(),
        "font representation identity stays independent of caller text"
    );
    workspace.finish();
    let proof = probe
        .qualify_font(&library, input.clone(), Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    let prepared = PreparedFont::after_qualification(reference.clone(), input, proof).unwrap();
    assert!(prepared.covers_required_texts(&required));
    required.reverse();
    assert!(prepared.covers_required_texts(&required));
    assert!(prepared.covers_required_texts(&required[..1]));
    assert!(prepared.covers_required_texts(&[required[0].clone(), required[0].clone()]));
    assert!(prepared.covers_required_texts(&[]));

    for (node_id, text) in [
        ("other-node", "Hertz"),
        ("title", "Hertz Studio"),
        ("title", "Hertz 中"),
        ("chorus", "Studio\n    Hertz"),
        ("titleH", "ertz"),
    ] {
        assert!(!prepared.covers_required_texts(&[RequiredText {
            node_id: node_id.into(),
            text: text.into()
        }]));
    }
    required[0].text = "Hertz Studio".into();
    assert!(
        !prepared.covers_required_texts(&required),
        "mutating the original request does not expand the sealed proof"
    );
    assert!(!prepared.covers_required_texts(&vec![
        texts("Hertz")[0].clone();
        hertz_wallpaper::document::MAX_NODES + 1
    ]));
    let proof = probe
        .qualify_font(
            &library,
            no_text_input.clone(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let no_text = PreparedFont::after_qualification(reference, no_text_input, proof).unwrap();
    assert!(no_text.covers_required_texts(&[]));
    assert!(
        !no_text.covers_required_texts(&texts("Hertz")),
        "same font qualification does not imply text coverage"
    );
    drop(no_text);
    drop(prepared);
    library.pool().close().await;
}

fn with_cmap(cmap: Vec<u8>) -> Vec<u8> {
    let mut source = tables(&font());
    source.insert(*b"cmap", cmap);
    rebuild(source)
}

fn repeated_encoding_records(count: u16) -> Vec<u8> {
    let space = only_space();
    let source = tables(&space);
    let table = &source[b"cmap"][12..];
    let mut cmap = Vec::new();
    cmap.extend_from_slice(&0u16.to_be_bytes());
    cmap.extend_from_slice(&count.to_be_bytes());
    for _ in 0..count {
        cmap.extend_from_slice(&3u16.to_be_bytes());
        cmap.extend_from_slice(&1u16.to_be_bytes());
        cmap.extend_from_slice(&(4u32 + u32::from(count) * 8).to_be_bytes());
    }
    cmap.extend_from_slice(table);
    with_cmap(cmap)
}

fn wide_bmp_cmap() -> Vec<u8> {
    let mut cmap = Vec::new();
    for value in [0u16, 1, 3, 1] {
        cmap.extend_from_slice(&value.to_be_bytes());
    }
    cmap.extend_from_slice(&12u32.to_be_bytes());
    for value in [
        4u16, 32, 0, 4, 4, 1, 0, 0xfffe, 0xffff, 0, 0, 0xffff, 1, 1, 0, 0,
    ] {
        cmap.extend_from_slice(&value.to_be_bytes());
    }
    with_cmap(cmap)
}

fn composite_fixture(graph: &[Vec<u16>]) -> Vec<u8> {
    let original = font();
    let face = Face::parse(&original, 0).unwrap();
    let mut source = tables(&original);
    let old_loca = source.get(b"loca").unwrap();
    let glyph = usize::from(face.glyph_index('H').unwrap().0);
    let start = usize::from(u16_at(old_loca, glyph * 2).unwrap()) * 2;
    let end = usize::from(u16_at(old_loca, glyph * 2 + 2).unwrap()) * 2;
    let leaf = source[b"glyf"][start..end].to_vec();
    assert!(u16_at(&leaf, 0).unwrap() as i16 >= 0);
    let glyphs = graph.len().max(15);
    let mut glyf = Vec::new();
    let mut loca = Vec::new();
    for index in 0..glyphs {
        loca.extend_from_slice(&((glyf.len() / 2) as u16).to_be_bytes());
        let children = graph.get(index).map(Vec::as_slice).unwrap_or(&[]);
        if children.is_empty() {
            if index == 0 {
                glyf.extend_from_slice(&leaf);
            }
        } else {
            glyf.extend_from_slice(&(-1i16).to_be_bytes());
            glyf.extend_from_slice(&[0; 8]);
            for (component, &child) in children.iter().enumerate() {
                let flags = 2u16
                    | if component + 1 < children.len() {
                        32
                    } else {
                        0
                    };
                glyf.extend_from_slice(&flags.to_be_bytes());
                glyf.extend_from_slice(&child.to_be_bytes());
                glyf.extend_from_slice(&[0, 0]);
            }
        }
        if !glyf.len().is_multiple_of(2) {
            glyf.push(0);
        }
    }
    loca.extend_from_slice(&((glyf.len() / 2) as u16).to_be_bytes());
    source.insert(*b"glyf", glyf);
    source.insert(*b"loca", loca);
    source.get_mut(b"head").unwrap()[50..52].copy_from_slice(&0u16.to_be_bytes());
    let maxp = source.get_mut(b"maxp").unwrap();
    maxp[4..6].copy_from_slice(&(glyphs as u16).to_be_bytes());
    maxp[10..14].fill(0xff);
    maxp[28..30].copy_from_slice(&64u16.to_be_bytes());
    maxp[30..32].copy_from_slice(&32u16.to_be_bytes());
    let metrics = usize::from(u16_at(source.get(b"hhea").unwrap(), 34).unwrap());
    source
        .get_mut(b"hmtx")
        .unwrap()
        .resize(metrics * 4 + (glyphs - metrics) * 2, 0);
    rebuild(source)
}

#[test]
fn excessive_and_duplicate_cmap_records_are_rejected_with_bounded_work() {
    for count in [2u16, u16::MAX] {
        let bytes = repeated_encoding_records(count);
        let cancel = AtomicBool::new(false);
        let mut work = FontWork::new(&cancel);
        let face = checked_face(&bytes, FontFormat::Ttf, &mut work).unwrap();
        let error = CanonicalCmap::parse(&face, &mut work).err().unwrap();
        assert_eq!(error.code, "font_complexity_not_prepared");
        assert!(
            work.used < 200_000,
            "encoding records cannot multiply Unicode lookup work"
        );
    }
    // The repository's two distinct encodings legitimately share one table.
    let bytes = font();
    validate_bytes(&entry(&bytes), &bytes, &texts("Hertz Studio")).unwrap();
}

#[test]
fn untrusted_u32_cmap_ranges_are_rejected_before_enumeration() {
    let mut cmap = Vec::new();
    for value in [0u16, 1, 3, 10] {
        cmap.extend_from_slice(&value.to_be_bytes());
    }
    cmap.extend_from_slice(&12u32.to_be_bytes());
    cmap.extend_from_slice(&12u16.to_be_bytes());
    cmap.extend_from_slice(&0u16.to_be_bytes());
    for value in [28u32, 0, 1, 0, u32::MAX, 1] {
        cmap.extend_from_slice(&value.to_be_bytes());
    }
    let bytes = with_cmap(cmap);
    assert_eq!(
        validate_bytes(&entry(&bytes), &bytes, &[])
            .unwrap_err()
            .code,
        "font_invalid"
    );
}

#[test]
fn cancellation_is_observed_inside_probe_and_required_text_work() {
    let bytes = wide_bmp_cmap();
    let cancel = AtomicBool::new(false);
    let mut work = FontWork::new(&cancel);
    let face = checked_face(&bytes, FontFormat::Ttf, &mut work).unwrap();
    let cmap = CanonicalCmap::parse(&face, &mut work).unwrap();
    assert!(!cancel.load(Ordering::Acquire));
    work.cancel_at = Some(work.used + 1024);
    assert_eq!(
        probe_text(&face, &cmap, &mut work).unwrap_err().code,
        "cancelled"
    );
    let bytes = font();
    let cancel = AtomicBool::new(false);
    let mut work = FontWork::new(&cancel);
    let face = checked_face(&bytes, FontFormat::Ttf, &mut work).unwrap();
    let cmap = CanonicalCmap::parse(&face, &mut work).unwrap();
    let required = vec![
        RequiredText {
            node_id: "title".into(),
            text: "H".repeat(4096)
        };
        128
    ];
    work.cancel_at = Some(work.used + 9000);
    assert_eq!(
        validate_texts(&face, &cmap, &required, &mut work)
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert_eq!(
        validate_bytes_with_cancel(&entry(&bytes), &bytes, &[], &AtomicBool::new(true))
            .unwrap_err()
            .code,
        "cancelled"
    );
}

#[test]
fn required_text_limits_preserve_the_document_boundary_before_expensive_lookup() {
    let bytes = font();
    validate_required_text(&bytes, "long-title", &"H".repeat(4096)).unwrap();
    assert_eq!(
        validate_required_text(&bytes, "long-title", &"H".repeat(4097))
            .unwrap_err()
            .code,
        "font_complexity_not_prepared"
    );
    let required = vec![
        RequiredText {
            node_id: "title".into(),
            text: "Hertz".into()
        };
        129
    ];
    assert_eq!(
        validate_bytes(&entry(&bytes), &bytes, &required)
            .unwrap_err()
            .code,
        "font_complexity_not_prepared"
    );
}

#[test]
fn compact_composite_explosion_cycles_and_depth_are_checked_before_outlining() {
    let mut doubling = vec![Vec::new()];
    for previous in 0..30 {
        doubling.push(vec![previous, previous]);
    }
    let mut fanout = vec![Vec::new()];
    for previous in 0..6 {
        fanout.push(vec![previous; 8]);
    }
    for graph in [doubling, fanout] {
        let bytes = composite_fixture(&graph);
        assert!(bytes.len() < 32 * 1024);
        let cancel = AtomicBool::new(false);
        let mut work = FontWork::new(&cancel);
        let error = checked_face(&bytes, FontFormat::Ttf, &mut work)
            .err()
            .unwrap();
        assert_eq!(error.code, "font_complexity_not_prepared");
        assert!(
            work.used < 100_000,
            "memoized expansion must reject compact hostile graphs before outline_glyph"
        );
    }
    let bytes = composite_fixture(&[vec![0]]);
    let cancel = AtomicBool::new(false);
    assert_eq!(
        checked_face(&bytes, FontFormat::Ttf, &mut FontWork::new(&cancel))
            .err()
            .unwrap()
            .code,
        "font_invalid"
    );
    let bytes = composite_fixture(&[Vec::new(), vec![0], vec![1]]);
    let cancel = AtomicBool::new(false);
    checked_face(&bytes, FontFormat::Ttf, &mut FontWork::new(&cancel)).unwrap();
    let source = tables(&bytes);
    let cancel = AtomicBool::new(false);
    let mut work = FontWork::new(&cancel);
    work.cancel_at = Some(20);
    assert_eq!(
        check_outlines(&source[b"glyf"], &source[b"loca"], false, 15, &mut work)
            .unwrap_err()
            .code,
        "cancelled"
    );
}

#[tokio::test]
async fn substituted_pinned_representation_cannot_qualify_or_seal_under_original_asset() {
    use super::super::decode_probe::{ProbeClient, ProbeInput};
    use super::super::library::Library;
    use std::sync::atomic::AtomicUsize;
    let (store, dir, reference, expected) = installed("font-representation-substitution");
    let library = Library::open(dir.path()).await.unwrap();
    let runs = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&runs);
    let probe = ProbeClient::testing_input(move |input, _| {
        assert!(matches!(input, ProbeInput::Font(_)));
        observed.fetch_add(1, Ordering::Relaxed);
        Box::pin(async { Ok(()) })
    });
    let workspace = probe
        .image_workspace(prepare_workspace_bytes(expected.bytes).unwrap())
        .unwrap();
    let mut a = pin_input(
        &store,
        &reference,
        &expected,
        &texts("Hertz"),
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    let mut b_ref = reference.clone();
    b_ref.asset_id = "brand-font-b".into();
    let b_entry = store
        .read_installed_manifest(&reference.package_hash)
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.path == "assets/instrument-serif-b.ttf")
        .unwrap();
    let b = pin_input(
        &store,
        &b_ref,
        &b_entry,
        &texts("Hertz"),
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_ne!(content_key(&a).unwrap(), content_key(&b).unwrap());
    workspace.finish();
    let proof_b = probe
        .qualify_font(&library, b.clone(), Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    a.media = Arc::clone(&b.media);
    a.metadata = b.metadata.clone();
    assert_eq!(content_key(&a).unwrap_err().code, "font_input_changed");
    assert_eq!(
        probe
            .qualify_font(&library, a.clone(), Arc::new(AtomicBool::new(false)))
            .await
            .err()
            .unwrap()
            .code,
        "font_input_changed"
    );
    assert_eq!(
        runs.load(Ordering::Relaxed),
        1,
        "substitution is rejected before invoking the typed probe"
    );
    assert_eq!(
        PreparedFont::after_qualification(reference, a, proof_b)
            .err()
            .unwrap()
            .code,
        "font_input_changed"
    );
    let proof = probe
        .qualify_font(&library, b.clone(), Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    PreparedFont::after_qualification(b_ref, b, proof).unwrap();
    library.pool().close().await;
}

fn variable_font_tables() -> BTreeMap<[u8; 4], Vec<u8>> {
    let mut source = tables(&font());
    // One real weight axis, no named instances. Variation glyph offsets are
    // all zero: the fvar/gvar tables are present even at the default outline.
    let mut fvar = Vec::new();
    for value in [1u16, 0, 16, 2, 1, 20, 0, 8] {
        fvar.extend_from_slice(&value.to_be_bytes());
    }
    fvar.extend_from_slice(b"wght");
    for value in [100i32, 400, 900] {
        fvar.extend_from_slice(&(value << 16).to_be_bytes());
    }
    fvar.extend_from_slice(&0u16.to_be_bytes());
    fvar.extend_from_slice(&256u16.to_be_bytes());
    let mut gvar = Vec::new();
    for value in [1u16, 0, 1, 0] {
        gvar.extend_from_slice(&value.to_be_bytes());
    }
    gvar.extend_from_slice(&52u32.to_be_bytes());
    gvar.extend_from_slice(&15u16.to_be_bytes());
    gvar.extend_from_slice(&0u16.to_be_bytes());
    gvar.extend_from_slice(&52u32.to_be_bytes());
    gvar.resize(52, 0);
    source.insert(*b"fvar", fvar);
    source.insert(*b"gvar", gvar);
    source
}

#[test]
fn variable_font_table_families_are_rejected_before_face_parsing() {
    let source = variable_font_tables();
    let bytes = rebuild(source.clone());
    assert_eq!(
        validate_bytes(&entry(&bytes), &bytes, &texts("Hertz"))
            .unwrap_err()
            .code,
        "font_complexity_not_prepared"
    );
    // A missing mandatory head would fail Face::parse. The raw variable-table
    // gate must classify this input first, independently of parser features.
    let mut without_head = source;
    without_head.remove(b"head");
    let bytes = rebuild(without_head);
    let cancel = AtomicBool::new(false);
    assert_eq!(
        checked_face(&bytes, FontFormat::Ttf, &mut FontWork::new(&cancel))
            .err()
            .unwrap()
            .code,
        "font_complexity_not_prepared"
    );
    for tag in [
        *b"fvar", *b"gvar", *b"avar", *b"cvar", *b"VARC", *b"CFF2", *b"HVAR", *b"MVAR", *b"VVAR",
        *b"STAT",
    ] {
        let mut source = tables(&font());
        source.insert(tag, 0x0001_0000u32.to_be_bytes().to_vec());
        let bytes = rebuild(source);
        assert_eq!(
            validate_bytes(&entry(&bytes), &bytes, &[])
                .unwrap_err()
                .code,
            "font_complexity_not_prepared",
            "{tag:?}"
        );
    }
}

#[test]
fn variable_extension_versions_are_closed_but_cmap_variation_sequences_remain_supported() {
    for (tag, version) in [
        (*b"GDEF", 0x0001_0003u32),
        (*b"BASE", 0x0001_0001),
        (*b"GPOS", 0x0001_0001),
        (*b"GSUB", 0x0001_0001),
        (*b"COLR", 0x0001_0000),
    ] {
        let mut source = tables(&font());
        source.insert(tag, version.to_be_bytes().to_vec());
        let bytes = rebuild(source);
        assert_eq!(
            validate_bytes(&entry(&bytes), &bytes, &[])
                .unwrap_err()
                .code,
            "font_complexity_not_prepared",
            "{tag:?}"
        );
    }
    let bytes = font();
    let glyph = Face::parse(&bytes, 0).unwrap().glyph_index('H').unwrap().0;
    let bytes = with_variation(true, glyph);
    validate_bytes(&entry(&bytes), &bytes, &texts("H\u{fe0f}")).unwrap();
}
