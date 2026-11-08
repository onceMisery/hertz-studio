// SPDX-License-Identifier: MIT
use vmusic_core::{LyricDocument, LyricVocalRole};
use vmusic_lyrics::{
    apply_presentation_offset, parse_import, validate_document, validate_presentation_document,
    ImportError,
};

const HEAD: &str = r#"<head><ttm:agent xml:id="a" type="person"><ttm:name type="full">甲</ttm:name></ttm:agent><ttm:agent xml:id="b" type="group"><ttm:name type="alias">乙</ttm:name></ttm:agent></head>"#;
fn xml(head: &str, body: &str) -> String {
    format!(
        r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">{head}<body><div>{body}</div></body></tt>"#
    )
}
fn parse(body: &str) -> LyricDocument {
    parse_import(&xml(HEAD, body), "ttml").unwrap()
}
fn active(doc: &LyricDocument, t: u64) -> Vec<&str> {
    doc.lines
        .iter()
        .filter(|l| l.start_ms <= t && l.end_ms.is_some_and(|end| t < end))
        .map(|l| l.text.as_str())
        .collect()
}

#[test]
fn long_line_resumes_after_short_overlap_with_exact_half_open_boundaries() {
    let doc = parse(
        r#"<p begin="0s" end="10s" ttm:agent="a">长句</p><p begin="2s" end="4s" ttm:agent="b">短句</p>"#,
    );
    assert_eq!(doc.lines.len(), 2);
    assert!(doc.lines.iter().all(|l| l.words.is_empty()));
    for (t, want) in [
        (1999, vec!["长句"]),
        (2000, vec!["长句", "短句"]),
        (3999, vec!["长句", "短句"]),
        (4000, vec!["长句"]),
        (10000, vec![]),
    ] {
        assert_eq!(active(&doc, t), want);
    }
}

#[test]
fn partial_annotation_and_missing_finite_end_reject_entire_document_with_position() {
    for body in [
        r#"<p begin="0s" end="10s" ttm:agent="a">长</p><p begin="2s" end="4s">短</p>"#,
        r#"<p begin="0s" end="1s" ttm:agent="a">a</p><p begin="2s">无尾</p>"#,
        r#"<p begin="0s" end="10s">无身份</p><p begin="2s" end="4s" ttm:agent="a">a</p>"#,
    ] {
        let error = parse_import(&xml(HEAD, body), "ttml").unwrap_err();
        assert_eq!(error.category(), ImportError::Invalid);
        assert!(matches!(
            error,
            ImportError::At {
                row: 1,
                column: 1..,
                ..
            }
        ));
    }
    let doc =
        parse(r#"<p begin="0s" end="1s" ttm:agent="a">a</p><p begin="1s" end="2s">未标注相接</p>"#);
    assert!(doc.lines[1].vocal.is_none());
}

#[test]
fn inline_identity_changes_emit_fragments_without_parent_duplicate() {
    let doc = parse(
        r#"<p begin="0s" end="6s" ttm:agent="a"><span begin="0s" end="2s">甲段</span><span begin="2s" end="4s" ttm:agent="b">乙段</span><span begin="4s" end="6s">甲续</span></p>"#,
    );
    assert_eq!(
        doc.lines
            .iter()
            .map(|l| (
                &l.text,
                l.start_ms,
                l.end_ms,
                l.vocal.as_ref().unwrap().agent_ids[0].as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            (&"甲段".into(), 0, Some(2000), "a"),
            (&"乙段".into(), 2000, Some(4000), "b"),
            (&"甲续".into(), 4000, Some(6000), "a")
        ]
    );
    assert_eq!(
        doc.lines.iter().map(|l| l.words.len()).collect::<Vec<_>>(),
        vec![1, 1, 1]
    );
}

#[test]
fn background_text_and_subtitles_have_unique_separate_ownership() {
    let doc = parse(
        r#"<p begin="0s" end="4s" ttm:agent="a">主句<span ttm:role="x-bg" ttm:agent="b" begin="1s" end="2s">和声<span ttm:role="x-translation">背景译文</span></span><span ttm:role="x-translation">主译文</span></p>"#,
    );
    assert_eq!(
        doc.lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>(),
        vec!["主句", "和声"]
    );
    assert_eq!(doc.translation.unwrap(), vec!["主译文", "背景译文"]);
    assert_eq!(
        doc.lines[1].vocal.as_ref().unwrap().role,
        LyricVocalRole::Backing
    );
    assert!(doc.lines.iter().all(|l| l.words.is_empty()));
    let only =
        parse(r#"<p begin="0s" end="4s"><span ttm:role="x-bg" ttm:agent="b">背景独占</span></p>"#);
    assert_eq!(only.lines.len(), 1);
    assert_eq!(
        only.lines[0].vocal.as_ref().unwrap().role,
        LyricVocalRole::Backing
    );
}

#[test]
fn ambiguous_fragments_roles_and_subtitles_reject_without_partial_content() {
    for body in [
        r#"<p begin="0s" end="4s" ttm:agent="a">无时正文<span begin="1s" end="2s" ttm:agent="b">乙</span></p>"#,
        r#"<p begin="0s" end="4s" ttm:agent="a"><span begin="0s" end="1s">甲</span><span begin="1s" end="2s" ttm:agent="b">乙</span><span ttm:role="x-translation">整段歧义</span></p>"#,
        r#"<p begin="0s" end="4s" ttm:agent="a"><span ttm:role="x-bg" begin="1s" end="2s">a<span ttm:role="x-bg">嵌套</span></span></p>"#,
        r#"<p begin="0s" end="4s">无身份<span ttm:role="x-bg" begin="1s" end="2s">背景</span></p>"#,
        r#"<p begin="0s" end="4s" ttm:agent="a">a<span ttm:role="x-translation" ttm:agent="b">译</span></p>"#,
        r#"<p begin="0s" end="4s" ttm:agent="a">a<span ttm:role="x-translation"></span><span ttm:role="x-translation">重复</span></p>"#,
        r#"<p begin="0s" end="4s" ttm:agent="a">a<span ttm:role="x-other">未知</span></p>"#,
    ] {
        assert!(
            parse_import(&xml(HEAD, body), "ttml").is_err(),
            "accepted {body}"
        );
    }
}

#[test]
fn joint_identity_is_canonical_and_same_identity_overlaps_remain_distinct() {
    let doc = parse(
        r#"<p begin="0s" end="4s" ttm:agent="b a">联合</p><p begin="0s" end="2s" ttm:agent="a">另句</p>"#,
    );
    assert_eq!(
        doc.lines[0].vocal.as_ref().unwrap().agent_ids,
        vec!["a", "b"]
    );
    assert_eq!(doc.lines.len(), 2);
    let same = parse(
        r#"<p begin="0s" end="4s" ttm:agent="a">长</p><p begin="1s" end="2s" ttm:agent="a">短</p>"#,
    );
    assert_eq!(same.lines.len(), 2);
}

#[test]
fn stable_sort_carries_own_translation_and_romanization() {
    let doc = parse(
        r#"<p begin="2s" end="3s" ttm:agent="b">乙<span ttm:role="x-roman">yi</span></p><p begin="0s" end="1s" ttm:agent="a">甲<span ttm:role="x-translation">A</span></p><p begin="2s" end="4s" ttm:agent="a">甲后<span ttm:role="x-translation">later</span></p>"#,
    );
    assert_eq!(
        doc.lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>(),
        vec!["甲", "乙", "甲后"]
    );
    assert_eq!(doc.translation.unwrap(), vec!["A", "", "later"]);
    assert_eq!(doc.romanization.unwrap(), vec!["", "yi", ""]);
}

#[test]
fn metadata_names_namespace_and_inheritance_are_author_declared() {
    let head = r#"<head><metadata><ttm:agent xml:id="a" type="character"><ttm:name type="given">given</ttm:name><ttm:name type="alias">alias</ttm:name><ttm:name type="full">full</ttm:name><ttm:name type="full">second</ttm:name></ttm:agent><ttm:agent xml:id="b" type="other"><ttm:name type="full"> </ttm:name></ttm:agent></metadata></head>"#;
    let input=xml(head,r#"<div ttm:agent="a"><p begin="0s" end="1s">inherit</p><p begin="1s" end="2s" ttm:agent="b">override</p></div>"#).replace("ttm:","v:").replace("xmlns:ttm", "xmlns:v");
    let doc = parse_import(&input, "ttml").unwrap();
    assert_eq!(doc.agents[0].name.as_deref(), Some("full"));
    assert_eq!(doc.agents[1].name, None);
    assert_eq!(doc.lines[0].vocal.as_ref().unwrap().agent_ids, vec!["a"]);
    assert_eq!(doc.lines[1].vocal.as_ref().unwrap().agent_ids, vec!["b"]);
}

#[test]
fn unknown_duplicate_empty_and_lexically_invalid_ids_are_rejected() {
    for ids in ["missing", "a a", ""] {
        assert!(parse_import(
            &xml(
                HEAD,
                &format!(r#"<p begin="0s" end="1s" ttm:agent="{ids}">x</p>"#)
            ),
            "ttml"
        )
        .is_err());
    }
    for id in ["1bad", "bad:id", "bad id"] {
        assert!(parse_import(
            &xml(
                &format!(r#"<head><ttm:agent xml:id="{id}" type="person"/></head>"#),
                "<p begin=\"0s\" end=\"1s\">x</p>"
            ),
            "ttml"
        )
        .is_err());
    }
    assert!(parse_import(
        &xml(
            &HEAD.replace("xml:id=\"b\"", "xml:id=\"a\""),
            r#"<p begin="0s" end="1s" ttm:agent="a">x</p>"#
        ),
        "ttml"
    )
    .is_err());
}

#[test]
fn declaration_and_joint_budgets_accept_boundary_and_reject_excess() {
    for count in [32, 33] {
        let head = format!(
            "<head>{}</head>",
            (0..count)
                .map(|i| format!(r#"<ttm:agent xml:id="a{i}" type="person"/>"#))
                .collect::<String>()
        );
        let result = parse_import(
            &xml(&head, r#"<p begin="0s" end="1s" ttm:agent="a0">x</p>"#),
            "ttml",
        );
        assert_eq!(result.is_ok(), count == 32);
        if count == 33 {
            assert_eq!(result.unwrap_err().category(), ImportError::Limit);
        }
        for joint in [8, 9] {
            if count != 32 {
                continue;
            }
            let ids = (0..joint)
                .map(|i| format!("a{i}"))
                .collect::<Vec<_>>()
                .join(" ");
            assert_eq!(
                parse_import(
                    &xml(
                        &head,
                        &format!(r#"<p begin="0s" end="1s" ttm:agent="{ids}">x</p>"#)
                    ),
                    "ttml"
                )
                .is_ok(),
                joint == 8
            );
        }
    }
    for bytes in [128, 129] {
        let id = "a".repeat(bytes);
        let head = format!(
            r#"<head><ttm:agent xml:id="{id}" type="person"><ttm:name type="full">{}</ttm:name></ttm:agent></head>"#,
            "b".repeat(bytes)
        );
        let result = parse_import(
            &xml(
                &head,
                &format!(r#"<p begin="0s" end="1s" ttm:agent="{id}">x</p>"#),
            ),
            "ttml",
        );
        assert_eq!(result.is_ok(), bytes == 128);
    }
}

#[test]
fn word_render_budget_does_not_truncate_canonical_sixty_five_words() {
    let body = format!(
        r#"<p begin="0s" end="65s" ttm:agent="a">{}</p>"#,
        (0..65)
            .map(|i| format!(r#"<span begin="{i}s" end="{}s">字</span>"#, i + 1))
            .collect::<String>()
    );
    let doc = parse(&body);
    assert_eq!(doc.lines[0].words.len(), 65);
    assert_eq!(doc.lines[0].text.chars().count(), 65);
}

#[test]
fn ordered_offsets_preserve_identity_and_allow_only_presentation_zero_length() {
    let mut doc = parse(
        r#"<p begin="0s" end="1s" ttm:agent="a">早</p><p begin="2s" end="3s" ttm:agent="b">后</p>"#,
    );
    doc.offset_ms = -2000;
    let agents = doc.agents.clone();
    let vocal = doc.lines[0].vocal.clone();
    apply_presentation_offset(&mut doc, 500);
    assert_eq!(
        (doc.lines[0].start_ms, doc.lines[0].end_ms),
        (500, Some(500))
    );
    assert_eq!(
        (doc.lines[1].start_ms, doc.lines[1].end_ms),
        (500, Some(1500))
    );
    assert_eq!(active(&doc, 500), vec!["后"]);
    assert_eq!(doc.agents, agents);
    assert_eq!(doc.lines[0].vocal, vocal);
    assert!(validate_presentation_document(&doc).is_ok());
    assert!(validate_document(&doc).is_err());
    let mut upper = parse(r#"<p begin="86399s" end="86400s" ttm:agent="a">终</p>"#);
    upper.offset_ms = 120000;
    apply_presentation_offset(&mut upper, 2000);
    assert_eq!(upper.lines[0].end_ms, Some(86522000));
    assert!(validate_presentation_document(&upper).is_ok());
    upper.lines[0].end_ms = Some(86522001);
    assert!(validate_presentation_document(&upper).is_err());
    for t in [0, 2000, 2001] {
        let mut collapsed = parse(
            r#"<p begin="0s" end="1s" ttm:agent="a"><span begin="0s" end="1s">词</span></p>"#,
        );
        collapsed.lines[0].start_ms = t;
        collapsed.lines[0].end_ms = Some(t);
        collapsed.lines[0].words[0].start_ms = t;
        collapsed.lines[0].words[0].end_ms = Some(t);
        assert_eq!(
            validate_presentation_document(&collapsed).is_ok(),
            t <= 2000
        );
    }
}

#[test]
fn old_json_lrc_and_unreferenced_declarations_keep_original_mode() {
    let lrc = parse_import("[00:01.00]a\n[00:01.00]b", "lrc").unwrap();
    assert!(!lrc.has_vocals());
    let mut json = serde_json::to_value(&lrc).unwrap();
    assert!(json.get("agents").is_none());
    assert!(json["lines"][0].get("vocal").is_none());
    let old: LyricDocument = serde_json::from_value(json.take()).unwrap();
    assert!(old.agents.is_empty());
    let unreferenced =
        parse_import(&xml(HEAD, r#"<p begin="0s" end="1s">普通</p>"#), "ttml").unwrap();
    assert!(!unreferenced.has_vocals());
    assert_eq!(unreferenced.agents.len(), 2);
    assert!(parse_import(
        &xml(
            HEAD,
            r#"<p begin="0s" end="2s">长</p><p begin="1s" end="2s">短</p>"#
        ),
        "ttml"
    )
    .is_err());
}

#[test]
fn legacy_direct_word_timing_is_preserved_and_empty_paragraph_still_rejects() {
    let doc = parse_import(
        &xml("", r#"<p><span begin="1s" end="2s">x</span></p>"#),
        "ttml",
    )
    .unwrap();
    assert_eq!((doc.lines[0].start_ms, doc.lines[0].end_ms), (0, None));
    assert_eq!(
        (doc.lines[0].words[0].start_ms, doc.lines[0].words[0].end_ms),
        (1000, Some(2000))
    );
    let error = parse_import(
        &xml(
            "",
            r#"<p begin="0s" end="1s"/><p begin="1s" end="2s">x</p>"#,
        ),
        "ttml",
    )
    .unwrap_err();
    assert_eq!(error.category(), ImportError::Empty);
}

#[test]
fn inter_fragment_whitespace_and_breaks_have_single_source_ownership() {
    for (separator, expected) in [(" ", "A C"), ("<br/>", "A\nC")] {
        let body = format!(
            r#"<p begin="0s" end="3s" ttm:agent="a"><span begin="0s" end="1s">A</span>{separator}<span begin="1s" end="2s">C</span><span begin="2s" end="3s" ttm:agent="b">B</span></p>"#
        );
        let doc = parse(&body);
        assert_eq!(doc.lines.len(), 2);
        assert_eq!(doc.lines[0].text, expected);
        assert_eq!(
            doc.lines[0]
                .words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<String>(),
            expected
        );
        assert_eq!(doc.lines[1].text, "B");
    }
}

#[test]
fn extracted_background_is_a_source_continuity_boundary() {
    let doc = parse(
        r#"<p begin="0s" end="3s" ttm:agent="a"><span begin="0s" end="1s">A</span><span begin="0s" end="1s" ttm:agent="b" ttm:role="x-bg">X</span><span begin="1s" end="2s">C</span><span begin="2s" end="3s" ttm:agent="b">B</span></p>"#,
    );
    assert_eq!(
        doc.lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>(),
        vec!["A", "X", "C", "B"]
    );
}

#[test]
fn unused_container_timing_semantics_and_parent_bounds_are_validated() {
    for prefix in [
        r#"<div begin="1f"/>"#,
        r#"<div begin="0s" end="1s"><div begin="2s" end="3s"/></div>"#,
    ] {
        let body = format!(r#"{prefix}<p begin="0s" end="1s" ttm:agent="a">X</p>"#);
        assert!(parse_import(&xml(HEAD, &body), "ttml").is_err());
    }
}

#[test]
fn shared_subtitle_attaches_after_eligible_merge_but_fragment_subtitles_keep_boundaries() {
    let doc = parse(
        r#"<p begin="0s" end="2s"><span begin="0s" end="1s" ttm:agent="a">A</span><span begin="1s" end="2s" ttm:agent="a">B</span><span ttm:role="x-translation">AB译</span></p>"#,
    );
    assert_eq!(doc.lines.len(), 1);
    assert_eq!(doc.lines[0].text, "AB");
    assert_eq!(doc.translation.unwrap(), vec!["AB译"]);
    let separate = parse(
        r#"<p begin="0s" end="2s"><span begin="0s" end="1s" ttm:agent="a">A<span ttm:role="x-translation">A译</span></span><span begin="1s" end="2s" ttm:agent="a">B<span ttm:role="x-translation">B译</span></span></p>"#,
    );
    assert_eq!(separate.lines.len(), 2);
    assert_eq!(separate.translation.unwrap(), vec!["A译", "B译"]);
    for depth in 1..=3 {
        let mut inner = r#"<span begin="0s" end="1s">A</span><span begin="1s" end="2s">B</span><span ttm:role="x-translation">AB译</span>"#.to_string();
        for _ in 0..depth {
            inner = format!(r#"<span begin="0s" end="2s" ttm:agent="a">{inner}</span>"#);
        }
        let nested = parse(&format!(r#"<p begin="0s" end="2s">{inner}</p>"#));
        assert_eq!(nested.lines.len(), 1);
        assert_eq!(nested.lines[0].text, "AB");
        assert_eq!(nested.translation.unwrap(), vec!["AB译"]);
    }
}
#[test]
fn errors_preserve_original_source_position_before_trim() {
    let xml = "<tt xmlns=\"http://www.w3.org/ns/ttml\"><body><p invalid=\"x\">line</p></body></tt>";
    let base = vmusic_lyrics::parse_import(xml, "ttml").unwrap_err();
    let (base_row, base_column) = match base {
        vmusic_lyrics::ImportError::At { row, column, .. } => (row, column),
        other => panic!("expected positioned error: {other:?}"),
    };
    for (prefix, rows, columns) in [
        ("\n\n  ", 2, 2),
        ("\u{feff}  ", 0, 3),
        ("\u{feff}\n\n  ", 2, 2),
    ] {
        let error = vmusic_lyrics::parse_import(&format!("{prefix}{xml}"), "auto").unwrap_err();
        assert!(
            matches!(error, vmusic_lyrics::ImportError::At { row, column, .. }
            if row == base_row + rows && column == base_column + columns)
        );
    }
}
