// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;

fn base() -> Url {
    Url::parse("https://blog.example.com/posts/1").unwrap()
}

#[test]
fn dangerous_markup_is_stripped_and_links_kept() {
    let raw = r#"<p onclick="evil()">你好<script>alert(1)</script><a href="https://ok.example.com/x" target="_blank">链接</a><a href="javascript:alert(1)">坏链接</a><iframe src="https://evil.example.com"></iframe><style>body{}</style><span style="color:red">样式</span></p>"#;
    let mut images = ImageRegistry::new();
    let cleaned = clean(raw, &base(), &mut images);
    assert!(cleaned.html.contains("你好"));
    assert!(cleaned.html.contains("链接"));
    assert!(cleaned.html.contains("https://ok.example.com/x"));
    assert!(!cleaned.html.contains("script"));
    assert!(!cleaned.html.contains("onclick"));
    assert!(!cleaned.html.contains("javascript:"));
    assert!(!cleaned.html.contains("iframe"));
    assert!(!cleaned.html.contains("style="));
    assert!(cleaned.html.contains("noopener"));
    assert_eq!(cleaned.status, CleanStatus::Cached);
}

#[test]
fn images_register_stable_keys_and_rewrite_srcset() {
    let raw = r#"<p><img src="/a.png"><img src="https://blog.example.com/a.png"><img src="/b.png?a=1" srcset="/c.png 2x, /d.png 1x"></p>"#;
    let mut images = ImageRegistry::new();
    let cleaned = clean(raw, &base(), &mut images);
    assert_eq!(images.items.len(), 4);
    // 相对地址按 base 解析；同一条目内同 URL 只登记一次、复用同键。
    assert_eq!(images.items[0].1, "https://blog.example.com/a.png");
    assert_eq!(images.items[1].1, "https://blog.example.com/b.png?a=1");
    assert_eq!(cleaned.html.matches(&images.items[0].0).count(), 2);
    assert_eq!(
        images.items[0].0,
        image_key("https://blog.example.com/a.png")
    );
    assert!(!cleaned.html.contains("https://blog.example.com/a.png"));
    assert!(cleaned.html.contains(&images.items[0].0));
    assert!(cleaned.html.contains("2x"));
    // 数据键是 32 位小写 hex（SHA-256 前 16 字节）。
    assert!(images
        .items
        .iter()
        .all(|(key, _)| key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit())));
}

#[test]
fn non_http_schemes_and_over_cap_images_are_dropped() {
    let raw = r#"<p><img src="data:image/png;base64,AAAA"><img src="ftp://x/y.png"></p>"#;
    let mut images = ImageRegistry::new();
    let cleaned = clean(raw, &base(), &mut images);
    assert!(images.items.is_empty());
    assert!(!cleaned.html.contains("data:image"));
    assert!(!cleaned.html.contains("ftp://"));

    let mut many = String::from("<p>");
    for index in 0..40 {
        many.push_str(&format!(r#"<img src="/p{index}.png">"#));
    }
    many.push_str("</p>");
    let mut images = ImageRegistry::new();
    let _cleaned = clean(&many, &base(), &mut images);
    assert_eq!(images.items.len(), MAX_IMAGES_PER_ENTRY);
}

#[test]
fn oversize_content_truncates_at_tag_boundary_and_rebalances() {
    let mut raw = String::from("<div>");
    for _ in 0..2000 {
        raw.push_str("<p>中文正文内容，足够长以触发截断预算。</p>");
    }
    raw.push_str("</div>");
    let mut images = ImageRegistry::new();
    let cleaned = clean(&raw, &base(), &mut images);
    assert_eq!(cleaned.status, CleanStatus::Truncated);
    assert!(cleaned.html.len() <= crate::reader::MAX_CONTENT_BYTES + 64);
    assert!(cleaned.html.ends_with("</p></div>"));
    assert!(cleaned.html.contains("<p>"));
    assert!(!cleaned.html.ends_with("<"));
}
