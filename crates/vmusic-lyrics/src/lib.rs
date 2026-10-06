// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! LRC parsing, including the word-level dialects.
//!
//! Three shapes show up in the wild and all three are handled here:
//!
//! ```text
//! [00:12.00]plain line                      -> one line, no words
//! [00:12.00][00:15.00]same text twice       -> two lines sharing text
//! [00:12.00]你[00:12.40]好[00:13.10]世界     -> one line with word timings
//! ```
//!
//! The third form is what the "enhanced" LRC produced by several desktop
//! players looks like. Being able to read it is what makes word-by-word
//! highlighting possible without any online lookup.

use vmusic_core::{LyricDocument, LyricLine, LyricSource, LyricWord};

/// Metadata tags we pull out of the header; the rest are ignored.
#[derive(Debug, Default)]
pub struct LrcMeta {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Global shift in milliseconds, applied to every timestamp.
    pub offset_ms: i64,
}

/// Parses an LRC document. Never fails: malformed input degrades to fewer
/// lines rather than an error, because a half-broken lyric file is still more
/// useful to the user than no lyrics at all.
pub fn parse_lrc(input: &str) -> LyricDocument {
    let mut meta = LrcMeta::default();
    let mut lines: Vec<LyricLine> = Vec::new();

    for raw in input.lines() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        if let Some(value) = tag_value(raw, "offset") {
            meta.offset_ms = value.trim().parse::<i64>().unwrap_or(0);
            continue;
        }
        if let Some(value) = tag_value(raw, "ti") {
            meta.title = Some(value.to_string());
            continue;
        }
        if let Some(value) = tag_value(raw, "ar") {
            meta.artist = Some(value.to_string());
            continue;
        }
        if let Some(value) = tag_value(raw, "al") {
            meta.album = Some(value.to_string());
            continue;
        }

        for line in parse_lyric_line(raw) {
            lines.push(line);
        }
    }

    lines.sort_by_key(|l| l.start_ms);
    for i in 0..lines.len() {
        if i + 1 < lines.len() {
            lines[i].end_ms = Some(lines[i + 1].start_ms);
        }
    }

    LyricDocument {
        source: if lines.is_empty() {
            LyricSource::None
        } else {
            LyricSource::Sidecar
        },
        offset_ms: meta.offset_ms,
        lines,
        translation: None,
    }
}

fn tag_value<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    let rest = raw.strip_prefix('[')?;
    let (head, value) = rest.split_once(']')?;
    let (k, v) = head.split_once(':')?;
    if k.trim().eq_ignore_ascii_case(key) {
        Some(v.trim().trim_end_matches(']').trim())
    } else {
        // `value` already contains everything after the first `]`.
        let _ = value;
        None
    }
}

/// One physical line may expand to several logical lines (repeated timestamps)
/// and may carry inline word timings.
fn parse_lyric_line(raw: &str) -> Vec<LyricLine> {
    // Collect (timestamp, following text) runs.
    let mut runs: Vec<(u64, String)> = Vec::new();
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    let mut pending: Option<u64> = None;
    let mut buf = String::new();

    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some((ts, consumed)) = try_timestamp(&raw[i..]) {
                if let Some(prev) = pending {
                    runs.push((prev, std::mem::take(&mut buf)));
                } else if !buf.is_empty() {
                    // Text before the first timestamp on this line: keep it as
                    // the tail of the previous run if we have one.
                    if let Some(last) = runs.last_mut() {
                        last.1.push_str(&std::mem::take(&mut buf));
                    } else {
                        buf.clear();
                    }
                }
                pending = Some(ts);
                i += consumed;
                continue;
            }
        }
        buf.push(raw[i..].chars().next().unwrap());
        i += raw[i..].chars().next().unwrap().len_utf8();
    }
    if let Some(prev) = pending {
        runs.push((prev, buf));
    }

    if runs.is_empty() {
        return Vec::new();
    }

    // Runs that share a timestamp-free continuation form word timings of one
    // logical line: the first run starts the line, later runs start words.
    let (start_ms, first_text) = &runs[0];
    let mut words: Vec<LyricWord> = Vec::new();
    for (idx, (ts, text)) in runs.iter().enumerate() {
        let end = runs.get(idx + 1).map(|(n, _)| *n);
        words.push(LyricWord {
            start_ms: *ts,
            end_ms: end,
            text: text.clone(),
        });
    }

    // Two timestamps back to back with no text between them mean "this text
    // applies at several times", so the line expands into several lines. Word
    // timings always have text between the stamps, so an empty first run is an
    // unambiguous marker for the repeated-stamp form.
    if runs.len() > 1 && runs[0].1.is_empty() {
        let shared: String = runs.iter().map(|(_, t)| t.as_str()).collect();
        return runs
            .into_iter()
            .map(|(start_ms, _)| LyricLine {
                start_ms,
                end_ms: None,
                text: shared.clone(),
                words: Vec::new(),
            })
            .collect();
    }

    // A single run means no word-level information is present.
    let has_words = runs.len() > 1;
    let text = if has_words {
        runs.iter().map(|(_, t)| t.as_str()).collect::<String>()
    } else {
        first_text.clone()
    };

    vec![LyricLine {
        start_ms: *start_ms,
        end_ms: None,
        text,
        words: if has_words { words } else { Vec::new() },
    }]
}

/// Recognises `[mm:ss.xx]`, `[mm:ss.xxx]` and `[mm:ss:xx]`.
fn try_timestamp(s: &str) -> Option<(u64, usize)> {
    let end = s.find(']')?;
    let inner = &s[1..end];
    let parts: Vec<&str> = inner.split(':').collect();
    let (mm, ss, frac) = match parts.len() {
        // `[00:01.00]` — in the two-part form the fraction hangs off the
        // seconds, so it has to be split off before the integer parse.
        2 => match parts[1].split_once('.') {
            Some((sec, f)) => (parts[0], sec, f),
            None => (parts[0], parts[1], "0"),
        },
        // `[00:01:00]` — the third field is already the fraction.
        3 => (parts[0], parts[1], parts[2]),
        _ => return None,
    };
    let minutes: u64 = mm.trim().parse().ok()?;
    let seconds: u64 = ss.trim().parse().ok()?;
    // Fractional part may be `.25`, `25`, `.250` — normalise to milliseconds.
    let frac = frac.trim().trim_start_matches('.');
    let millis: u64 = if frac.is_empty() {
        0
    } else if frac.len() <= 3 {
        let scaled = format!("{frac:0<3}");
        scaled.parse().ok()?
    } else {
        frac[..3].parse().ok()?
    };
    Some((minutes * 60_000 + seconds * 1_000 + millis, end + 1))
}

/// Applies the document offset to every timestamp.
///
/// Kept separate from parsing so the stored document stays faithful to the
/// file and the shift is applied at read time (and can be changed by the UI).
pub fn apply_offset(doc: &mut LyricDocument) {
    if doc.offset_ms == 0 {
        return;
    }
    let shift = doc.offset_ms;
    let shift_abs = shift.unsigned_abs();
    let positive = shift > 0;

    for line in &mut doc.lines {
        line.start_ms = if positive {
            line.start_ms + shift_abs
        } else {
            line.start_ms.saturating_sub(shift_abs)
        };
        line.end_ms = line.end_ms.map(|e| {
            if positive {
                e + shift_abs
            } else {
                e.saturating_sub(shift_abs)
            }
        });
        for word in &mut line.words {
            word.start_ms = if positive {
                word.start_ms + shift_abs
            } else {
                word.start_ms.saturating_sub(shift_abs)
            };
            // 词尾同样要偏移：逐字扫色的「这个词唱完了」判定靠 end_ms，
            // 只偏起点会让扫色边界整体错开一个偏移量。
            word.end_ms = word.end_ms.map(|e| {
                if positive {
                    e + shift_abs
                } else {
                    e.saturating_sub(shift_abs)
                }
            });
        }
    }
}

/// 把翻译 LRC 对齐到已解析文档上，产出与 `doc.lines` 等长的平行数组。
///
/// 对齐键是双方**原始** start_ms（解析不施加 offset 标签，调用方应在
/// `apply_offset` 之前对齐——偏移后 translation 平行数组按下标跟随，无需
/// 再平移）。某行没有翻译就给空串；一条都对不上或翻译文本本身解析不出
/// 任何行时返回 None，调用方保持 `translation: None`，而不是挂一个全空
/// 数组让 API 白白多传字段。
pub fn align_translation(doc: &LyricDocument, translated_lrc: &str) -> Option<Vec<String>> {
    let parsed = parse_lrc(translated_lrc);
    if parsed.lines.is_empty() {
        return None;
    }
    let stamps: std::collections::HashMap<u64, &str> = parsed
        .lines
        .iter()
        .map(|l| (l.start_ms, l.text.as_str()))
        .collect();
    let out: Vec<String> = doc
        .lines
        .iter()
        .map(|l| stamps.get(&l.start_ms).copied().unwrap_or("").to_string())
        .collect();
    if out.iter().all(String::is_empty) {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_lines() {
        let doc = parse_lrc("[00:01.00]hello\n[00:05.50]world\n");
        assert_eq!(doc.lines.len(), 2);
        assert_eq!(doc.lines[0].text, "hello");
        assert_eq!(doc.lines[0].start_ms, 1000);
        assert_eq!(doc.lines[0].end_ms, Some(5500));
        assert!(doc.lines[0].words.is_empty());
    }

    #[test]
    fn parses_three_digit_fractions() {
        let doc = parse_lrc("[00:01.250]a\n");
        assert_eq!(doc.lines[0].start_ms, 1250);
    }

    #[test]
    fn parses_word_level_timings() {
        let doc = parse_lrc("[00:12.00]你[00:12.40]好[00:13.10]世界");
        let line = &doc.lines[0];
        assert_eq!(line.text, "你好世界");
        assert_eq!(line.words.len(), 3);
        assert_eq!(line.words[1].start_ms, 12_400);
        assert_eq!(line.words[1].text, "好");
    }

    #[test]
    fn reads_offset_and_metadata() {
        let doc = parse_lrc("[ti:Title]\n[ar:Artist]\n[offset:-500]\n[00:02.00]x");
        assert_eq!(doc.offset_ms, -500);
        assert_eq!(doc.lines[0].start_ms, 2000);

        apply_offset(&mut { doc });
    }

    #[test]
    fn offset_shifts_everything() {
        let mut doc = parse_lrc("[offset:-500]\n[00:02.00]x\n[00:04.00]y");
        apply_offset(&mut doc);
        assert_eq!(doc.lines[0].start_ms, 1500);
        assert_eq!(doc.lines[1].start_ms, 3500);
    }

    #[test]
    fn offset_shifts_line_and_word_ends_too() {
        // 逐字扫色靠 end_ms 判「这个词唱完了」：行尾与词尾漏偏会让扫色
        // 边界整体错开一个偏移量。
        let mut doc = parse_lrc("[offset:1000]\n[00:02.00]你[00:02.50]好\n[00:04.00]世界");
        apply_offset(&mut doc);
        let line = &doc.lines[0];
        // 行尾 = 下一行起点，同样要偏移。
        assert_eq!(line.end_ms, Some(5_000));
        assert_eq!(line.words[0].start_ms, 3_000);
        assert_eq!(line.words[0].end_ms, Some(3_500));
        assert_eq!(line.words[1].end_ms, None, "没有下界的词尾保持 None");
    }

    #[test]
    fn repeated_timestamps_expand_to_several_lines() {
        let doc = parse_lrc("[00:12.00][00:15.00]same text twice");
        assert_eq!(doc.lines.len(), 2, "one line per timestamp");
        assert_eq!(doc.lines[0].start_ms, 12_000);
        assert_eq!(doc.lines[1].start_ms, 15_000);
        assert_eq!(doc.lines[0].text, "same text twice");
        assert_eq!(doc.lines[1].text, "same text twice");
        // No text between the stamps means there is no word-level data.
        assert!(doc.lines[0].words.is_empty());
    }

    #[test]
    fn junk_input_never_panics() {
        let doc = parse_lrc("not a lyric\n[[[[]]]\n[99:99.99]\n");
        let _ = doc.lines.len();
    }

    #[test]
    fn aligns_translation_by_line_stamp() {
        let doc = parse_lrc("[00:01.00]hello\n[00:05.00]world\n");
        let tr = align_translation(&doc, "[00:01.00]你好\n[00:05.00]世界\n")
            .expect("时间戳对得上就该产出数组");
        assert_eq!(tr, vec!["你好", "世界"]);
    }

    #[test]
    fn partial_translation_pads_with_empty_strings() {
        let doc = parse_lrc("[00:01.00]a\n[00:02.00]b\n[00:03.00]c\n");
        let tr = align_translation(&doc, "[00:01.00]甲\n[00:03.00]丙\n").expect("部分对上也该产出");
        assert_eq!(tr, vec!["甲", "", "丙"]);
    }

    #[test]
    fn unmatchable_translation_returns_none() {
        let doc = parse_lrc("[00:01.00]hello\n");
        assert!(align_translation(&doc, "[00:09.00]对不上\n").is_none());
        assert!(
            align_translation(&doc, "根本不是歌词\n").is_none(),
            "解析不出任何行也是 None"
        );
    }
}
