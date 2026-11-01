// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;
use crate::wallpaper::library::tempfileish;

#[test]
fn counts_all_package_files_and_orphans_but_keeps_derived_separate() {
    let root = tempfileish::temp_dir("content-quota-files");
    let store = AssetStore::new(root.path())
        .unwrap()
        .with_content_capacity(16);
    let old = store.package_dir(&"a".repeat(64));
    std::fs::create_dir_all(old.join("files/nested")).unwrap();
    std::fs::write(old.join("original.hwpkg"), [0; 3]).unwrap();
    std::fs::write(old.join("files/nested/image.png"), [0; 4]).unwrap();
    std::fs::write(old.join("receipt.json"), [0; 2]).unwrap();
    // 无索引的未知文件同样占用内容库；派生图有自己的独立缓存配额。
    std::fs::write(root.path().join("packages/orphan"), [0; 1]).unwrap();
    std::fs::write(root.path().join("derived/cache"), [0; 100]).unwrap();
    let staging = store.staging_dir("new");
    std::fs::create_dir(&staging).unwrap();
    std::fs::write(staging.join("original.hwpkg"), [0; 6]).unwrap();
    let writer = store.content_writer().unwrap();
    writer.publish_staging("new", &"b".repeat(64)).unwrap();
    assert_eq!(directory_bytes(&root.path().join("packages")).unwrap(), 16);
    let next = store.staging_dir("next");
    std::fs::create_dir(&next).unwrap();
    std::fs::write(next.join("source"), [0; 1]).unwrap();
    assert_eq!(
        writer
            .publish_staging("next", &"c".repeat(64))
            .unwrap_err()
            .code,
        "library_full"
    );
    assert!(next.join("source").is_file());
    assert_eq!(
        std::fs::read(old.join("files/nested/image.png")).unwrap(),
        [0; 4]
    );
    assert!(root.path().join("packages/orphan").is_file());
    assert!(root.path().join("derived/cache").is_file());
}

#[test]
fn writer_is_shared_by_distinct_stores_and_released_by_drop() {
    let root = tempfileish::temp_dir("content-writer");
    let first = AssetStore::new(root.path()).unwrap();
    let second = AssetStore::new(root.path()).unwrap();
    let writer = first.content_writer().unwrap();
    assert_eq!(second.content_writer().err().unwrap().code, "budget_busy");
    drop(writer);
    assert!(second.content_writer().is_ok());
}

#[test]
fn publish_rejects_path_escape_without_touching_existing_content() {
    let root = tempfileish::temp_dir("content-publish-path");
    let store = AssetStore::new(root.path()).unwrap();
    let outside = root.path().join("keep");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("source"), b"keep").unwrap();
    let writer = store.content_writer().unwrap();
    for (job, hash) in [("../keep", "a".repeat(64)), ("job", "../keep".into())] {
        assert_eq!(
            writer.publish_staging(job, &hash).unwrap_err().code,
            "invalid_input"
        );
    }
    assert_eq!(std::fs::read(outside.join("source")).unwrap(), b"keep");
}

#[test]
fn junctions_cannot_escape_quota_accounting() {
    let root = tempfileish::temp_dir("content-junction");
    let store = AssetStore::new(root.path()).unwrap();
    let outside = root.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("source"), b"keep").unwrap();
    let link = root.path().join("packages/junction");
    // Windows junction 不依赖 symlink 提权，实际建立 reparse point 验证拒绝。
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:HERTZ_CONTENT_TEST_LINK -Target $env:HERTZ_CONTENT_TEST_TARGET | Out-Null"])
        .env("HERTZ_CONTENT_TEST_LINK", &link)
        .env("HERTZ_CONTENT_TEST_TARGET", &outside)
        .creation_flags(0x0800_0000)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(directory_bytes(&root.path().join("packages")).is_err());
    assert!(store.content_writer().unwrap().check_growth(1).is_err());
    std::fs::remove_dir(&link).unwrap();
    assert_eq!(std::fs::read(outside.join("source")).unwrap(), b"keep");
}
