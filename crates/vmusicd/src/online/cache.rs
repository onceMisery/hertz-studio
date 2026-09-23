// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 在线音频缓存：音质/容器分键命名、旧名回退、LRU 淘汰、.part 清理。

use std::path::{Path, PathBuf};

use tokio::fs;

/// 正式缓存文件名：`{stem}-{quality}.{ext}`。
///
/// 生产路径（Task 9）走 `cache_key` + 扩展名前缀扫描；此函数与 [`find_cached`]
/// 作为命名契约的直接实现保留并由单测覆盖。
#[allow(dead_code)]
pub fn cache_name(source: &str, id: &str, quality: &str, ext: &str) -> String {
    format!("{}-{quality}.{}", stem(source, id), ext_clean(ext))
}

/// 旧版命名（无音质、恒 .mp3），一次性回退命中。
pub fn legacy_cache_name(source: &str, id: &str) -> String {
    format!("{}.mp3", stem(source, id))
}

fn stem(source: &str, id: &str) -> String {
    let raw = format!("{source}-{id}");
    let safe: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.len() <= 96 {
        safe
    } else {
        format!("{}-{:08x}", &safe[..96], fnv1a(&raw))
    }
}

fn ext_clean(ext: &str) -> String {
    let e: String = ext
        .trim()
        .trim_start_matches('.')
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    if e.is_empty() {
        "mp3".into()
    } else {
        e
    }
}

fn fnv1a(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// 正式名优先；缺失时回退旧名。返回 (路径, 是否旧名)。
///
/// Task 9 的生产入口是按 key 扫描任意扩展名的 `find_cached_by_key`；本函数
/// 固定扩展名的语义由单测锁定，作为其语义参照与公开 API 保留。
#[allow(dead_code)]
pub async fn find_cached(
    dir: &Path,
    source: &str,
    id: &str,
    quality: &str,
    ext: &str,
) -> Option<(PathBuf, bool)> {
    let fresh = dir.join(cache_name(source, id, quality, ext));
    if is_ready(&fresh).await {
        return Some((fresh, false));
    }
    let legacy = dir.join(legacy_cache_name(source, id));
    if is_ready(&legacy).await {
        return Some((legacy, true));
    }
    None
}

async fn is_ready(path: &Path) -> bool {
    matches!(fs::metadata(path).await, Ok(m) if m.len() > 1024)
}

/// 删除目录内残留 `.part`（上次进程被杀的残骸）。启动时调用（Task 10 接入）。
#[allow(dead_code)]
pub async fn clean_parts(dir: &Path) {
    let Ok(mut it) = fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = it.next_entry().await {
        if entry.file_name().to_string_lossy().ends_with(".part") {
            let _ = fs::remove_file(entry.path()).await;
        }
    }
}

/// 总量超 max_bytes 时按 mtime 从旧到新删到上限的 90%；.part 与 protected 跳过。
/// Task 10 在启动与每次落盘后调用。
#[allow(dead_code)]
pub async fn enforce_limit(
    dir: &Path,
    max_bytes: u64,
    protected: &[String],
) -> std::io::Result<u64> {
    let mut files: Vec<(PathBuf, std::time::SystemTime, u64)> = Vec::new();
    let mut total = 0u64;
    let Ok(mut it) = fs::read_dir(dir).await else {
        return Ok(0);
    };
    while let Ok(Some(entry)) = it.next_entry().await {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".part") || protected.contains(&name) {
            continue;
        }
        if let Ok(meta) = fs::metadata(&path).await {
            if meta.is_file() {
                let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                files.push((path, mtime, meta.len()));
                total += meta.len();
            }
        }
    }
    if total <= max_bytes {
        return Ok(0);
    }
    let target = (max_bytes as f64 * 0.9) as u64;
    files.sort_by_key(|(_, mtime, _)| *mtime);
    let mut removed = 0u64;
    for (path, _, len) in files {
        if total <= target {
            break;
        }
        if fs::remove_file(&path).await.is_ok() {
            total -= len;
            removed += len;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn naming_and_legacy_fallback() {
        assert_eq!(
            cache_name("qq", "a1", "lossless", "m4a"),
            "qq-a1-lossless.m4a"
        );
        assert_eq!(
            cache_name("qq", "a1", "standard", ".MP3"),
            "qq-a1-standard.mp3"
        );
        assert_eq!(legacy_cache_name("qq", "a1"), "qq-a1.mp3");

        let dir = std::env::temp_dir().join(format!("vmusic-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        let legacy = dir.join(legacy_cache_name("qq", "a1"));
        fs::write(&legacy, vec![0u8; 2048]).await.unwrap();
        let hit = find_cached(&dir, "qq", "a1", "lossless", "m4a").await;
        assert!(hit.is_some());
        assert!(hit.unwrap().1);
    }

    #[tokio::test]
    async fn cleans_parts_and_evicts_oldest() {
        let dir = std::env::temp_dir().join(format!("vmusic-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        fs::write(dir.join(".x-1.part"), vec![0u8; 100])
            .await
            .unwrap();
        clean_parts(&dir).await;
        let mut count = 0;
        let mut it = fs::read_dir(&dir).await.unwrap();
        while it.next_entry().await.unwrap().is_some() {
            count += 1;
        }
        assert_eq!(count, 0);

        for n in 0..3u8 {
            fs::write(dir.join(format!("song{n}.mp3")), vec![0u8; 10_000])
                .await
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(12));
        }
        let removed = enforce_limit(&dir, 25_000, &[]).await.unwrap();
        assert!(removed >= 10_000);
        let mut remaining = 0;
        let mut it = fs::read_dir(&dir).await.unwrap();
        while it.next_entry().await.unwrap().is_some() {
            remaining += 1;
        }
        assert_eq!(remaining, 2);
    }
}
