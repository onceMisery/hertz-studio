// SPDX-License-Identifier: MIT
use vmusic_lyrics::{apply_offset, parse_import, parse_lrc, ImportError, MAX_BYTES, MAX_LINES};

fn ttml(body: &str) -> String {
    format!(
        r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body>{body}</body></tt>"#
    )
}

#[test]
fn lrc_formats_offsets_and_legacy_malformed_input() {
    let line = parse_import("[offset:-250]\n[00:01.00]一\n[00:02.00]二", "auto").unwrap();
    assert_eq!(line.format.as_deref(), Some("lrc"));
    assert_eq!(line.timing_precision.as_deref(), Some("line"));
    assert_eq!(line.offset_ms, -250);
    let word = parse_import("[00:01.00]你[00:01.50]好\n[00:02.00]world", "lrc").unwrap();
    assert_eq!(word.format.as_deref(), Some("enhanced_lrc"));
    assert_eq!(word.timing_precision.as_deref(), Some("mixed"));
    assert_eq!(word.lines[0].words[0].end_ms, Some(1500));
    for invalid in [
        "[00:01.💥]bad",
        "[18446744073709551615:00]bad",
        "[00:60.00]bad",
        "not lyrics",
    ] {
        assert!(parse_lrc(invalid).lines.is_empty());
        assert!(parse_import(invalid, "lrc").is_err());
    }
    for offset in ["bad", "60001", "9223372036854775808", "-60001"] {
        assert_eq!(
            parse_import(&format!("[offset:{offset}]\n[00:01.00]x"), "lrc").unwrap_err(),
            ImportError::Invalid
        );
    }
    let mut edge = parse_lrc("[00:01.00]x[00:01.50]y");
    edge.offset_ms = i64::MAX;
    apply_offset(&mut edge);
    apply_offset(&mut edge);
    apply_offset(&mut edge);
    assert_eq!(edge.lines[0].start_ms, u64::MAX);
    edge.offset_ms = i64::MIN;
    apply_offset(&mut edge);
    apply_offset(&mut edge);
    assert_eq!(edge.lines[0].start_ms, 0);
    let mut early = parse_lrc("[offset:-2000]\n[00:01.00]early");
    vmusic_lyrics::apply_presentation_offset(&mut early, 500);
    assert_eq!(
        early.lines[0].start_ms, 500,
        "OBS must match Stage's ordered zero saturation"
    );
}

#[test]
fn ttml_parent_relative_words_translation_romanization_and_breaks() {
    let xml = ttml(
        r#"<div begin="1s" end="10s"><p begin="500ms" end="3s"><span begin="0s" end="1s">你</span><span begin="1s" end="2s">好</span><span ttm:role="x-translation"> hello </span><span ttm:role="x-roman">nǐ hǎo</span></p><p begin="00:00:04.250" dur="1.5s"> second<br/>line </p></div>"#,
    );
    let doc = parse_import(&xml, "auto").unwrap();
    assert_eq!(doc.lines[0].start_ms, 1500);
    assert_eq!(doc.lines[0].end_ms, Some(4000));
    assert_eq!(doc.lines[0].words[1].start_ms, 2500);
    assert_eq!(doc.lines[0].words[1].end_ms, Some(3500));
    assert_eq!(doc.lines[0].text, "你好");
    assert_eq!(doc.lines[1].start_ms, 5250);
    assert_eq!(doc.lines[1].end_ms, Some(6750));
    assert_eq!(doc.lines[1].text, "second\nline");
    assert_eq!(doc.translation.unwrap(), ["hello", ""]);
    assert_eq!(doc.romanization.unwrap(), ["nǐ hǎo", ""]);
    assert_eq!(doc.timing_precision.as_deref(), Some("mixed"));
    let preserved = parse_import(
        &ttml(r#"<p begin="1s" end="2s" xml:space="preserve"> a  b </p>"#),
        "ttml",
    )
    .unwrap();
    assert_eq!(preserved.lines[0].text, " a  b ");
}

#[test]
fn ttml_rejects_unsupported_or_partial_semantics() {
    for body in [
        r#"<head/><p begin="1s">x</p>"#,
        r#"<p>untimed text</p>"#,
        r#"<div timeContainer="seq"><p begin="1s">x</p></div>"#,
        r#"<p begin="1f">x</p>"#,
        r#"<p begin="0.1ms">x</p>"#,
        r#"<p begin="1s" end="2s"><span begin="0s" end="1s">x</span>untimed</p>"#,
        r#"<p begin="1s" end="2s"><span begin="0s" end="2s">x</span></p>"#,
        r#"<p begin="1s" end="3s">x</p><p begin="2s" end="4s">y</p>"#,
        r#"<p begin="2s">x</p><p begin="1s">y</p>"#,
        r#"outside<p begin="1s">x</p>"#,
        r#"<p begin="1s">x<br begin="1s"/></p>"#,
        r#"<p begin="1s"><span ttm:role="x-translation" begin="1s">translation</span>x</p>"#,
        r#"<p begin="1s"><span><span begin="0s" end="1s">x</span></span></p>"#,
    ] {
        assert!(
            parse_import(&ttml(body), "ttml").is_err(),
            "accepted {body}"
        );
    }
    assert!(parse_import("<tt><body><p begin=\"1s\">x</p></body></tt>", "auto").is_err());
    assert!(parse_import(
        &ttml("<p begin=\"1s\">x</p>").replace("<tt ", "<tt begin=\"1s\" "),
        "auto"
    )
    .is_err());
    let entity = format!(
        "<!DOCTYPE tt [<!ENTITY secret SYSTEM 'file:///private'>]>{}",
        ttml("<p begin=\"1s\">&secret;</p>")
    );
    assert!(parse_import(&entity, "auto").is_err());
}

#[test]
fn bounded_documents() {
    assert_eq!(
        parse_import(&"x".repeat(MAX_BYTES + 1), "auto").unwrap_err(),
        ImportError::Limit
    );
    let lines = "[00:01.00]x\n".repeat(MAX_LINES + 1);
    assert_eq!(parse_import(&lines, "lrc").unwrap_err(), ImportError::Limit);
    let deep = ttml(&format!(
        "{}<p begin=\"1s\">x</p>{}",
        "<div>".repeat(15),
        "</div>".repeat(15)
    ));
    assert_eq!(parse_import(&deep, "ttml").unwrap_err(), ImportError::Limit);
    let expanded = format!("{}{}", "[00:01.00]".repeat(2000), "x".repeat(200));
    assert!(expanded.len() < MAX_BYTES);
    assert_eq!(
        parse_import(&expanded, "lrc").unwrap_err(),
        ImportError::Limit
    );
}
