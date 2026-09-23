// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 在线音频缓存：音质/容器分键命名、旧名回退、LRU 淘汰、.part 清理。

use std::path::{Path, PathBuf};

use tokio::fs;

/// 缓存键（不含扩展名）：`{stem}-{quality}`。
///
/// 渐进式下载落盘前不知道真实容器扩展名，下载注册表与缓存查找都以无扩展
/// 名的键为身份；正式文件名是 `{key}.{ext}`（见 [`progressive::start`]）。
pub fn cache_key(source: &str, id: &str, quality: &str) -> String {
    format!("{}-{quality}", stem(source, id))
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

fn fnv1a(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

async fn is_ready(path: &Path) -> bool {
    matches!(fs::metadata(path).await, Ok(m) if m.len() > 1024)
}

/// 不知道扩展名时按缓存键前缀查正式文件：扫描任意 `{key}.*`（跳过
/// `.part` 残骸），扫描完无果再回退旧名 `{stem}.mp3`。两条路径都必须
/// 通过 [`is_ready`]（>1024 字节），版权拦截页那种几百字节的「文件」
/// 不能被当成可播缓存。
///
/// 前缀末尾带点：`qq-a1-standard.` 不能误匹配到 `qq-a1-standardhi.*`
/// 之类的相邻键。
pub async fn find_cached_by_key(
    dir: &Path,
    source: &str,
    id: &str,
    quality: &str,
) -> Option<PathBuf> {
    let prefix = format!("{}.", cache_key(source, id, quality));
    let legacy = dir.join(legacy_cache_name(source, id));
    let Ok(mut it) = fs::read_dir(dir).await else {
        return is_ready(&legacy).await.then_some(legacy);
    };
    while let Ok(Some(entry)) = it.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".part") && name.starts_with(&prefix) {
            let p = entry.path();
            if is_ready(&p).await {
                return Some(p);
            }
        }
    }
    is_ready(&legacy).await.then_some(legacy)
}

/// 删除目录内残留 `.part`（上次进程被杀的残骸）。启动时调用。
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

/// 文件名是否命中保护名单。名单项支持两种形态：
/// - 以 `.` 结尾的项按缓存名**前缀**匹配（如 `qq-a1-lossless.` 同时保护
///   `qq-a1-lossless.mp3` / `.m4a` 等任意扩展名，这是当前播放曲的主保护项）；
/// - 不以 `.` 结尾的项按**全名**精确匹配（legacy 命名缓存单独保护）。
fn is_protected(name: &str, protected: &[String]) -> bool {
    protected.iter().any(|p| {
        if p.ends_with('.') {
            name.starts_with(p.as_str())
        } else {
            name == p
        }
    })
}

/// 总量超 max_bytes 时按 mtime 从旧到新删到上限的 90%；.part 与 protected
/// （前缀/全名两种形态，见 [`is_protected`]）跳过。无论超容多严重，mtime
/// 最新的 1 个正式文件始终保留——它通常就是刚 rename 落盘的当前曲，绝不能
/// 在落盘后立刻被 LRU 删掉。
/// 启动时传空名单；每次曲目提交后的后台任务传当前播放曲的保护名单。
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
        if name.ends_with(".part") || is_protected(&name, protected) {
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
    // 最新文件（刚落盘的当前曲）无条件保留，即使总容量仍然超目标。
    let newest = files.last().map(|(p, _, _)| p.clone());
    let mut removed = 0u64;
    for (path, _, len) in files {
        if total <= target {
            break;
        }
        if newest.as_ref() == Some(&path) {
            continue;
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
    async fn find_by_prefix_matches_any_ext_then_legacy() {
        let dir = std::env::temp_dir().join(format!("vmusic-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        // 新键 m4a 存在 → 命中它，即使同目录还有别的键/别的扩展名。
        fs::write(dir.join("qq-a1-lossless.m4a"), vec![0u8; 2000])
            .await
            .unwrap();
        fs::write(dir.join("qq-a1-standard.mp3"), vec![0u8; 2000])
            .await
            .unwrap();
        fs::write(dir.join(".qq-a1-lossless.part"), vec![0u8; 4096])
            .await
            .unwrap();
        let hit = find_cached_by_key(&dir, "qq", "a1", "lossless")
            .await
            .unwrap();
        assert!(hit.to_string_lossy().ends_with("qq-a1-lossless.m4a"));

        // 前缀边界：不能被相邻音质键误命中。
        assert!(find_cached_by_key(&dir, "qq", "a1", "hires")
            .await
            .is_none());

        // 只有旧名时回退。
        let dir2 = std::env::temp_dir().join(format!("vmusic-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir2).await.unwrap();
        fs::write(dir2.join("qq-a2.mp3"), vec![0u8; 2000])
            .await
            .unwrap();
        let hit2 = find_cached_by_key(&dir2, "qq", "a2", "lossless")
            .await
            .unwrap();
        assert!(hit2.to_string_lossy().ends_with("qq-a2.mp3"));

        // 太小的「版权拦截页」不算就绪：既不命中新名也不回退旧名。
        let dir3 = std::env::temp_dir().join(format!("vmusic-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir3).await.unwrap();
        fs::write(dir3.join("qq-a3-lossless.mp3"), vec![0u8; 128])
            .await
            .unwrap();
        assert!(find_cached_by_key(&dir3, "qq", "a3", "lossless")
            .await
            .is_none());
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
        // 删最旧 1 个、剩 2 个，且 mtime 最新的文件必须在保留之列。
        assert!(!dir.join("song0.mp3").exists());
        assert!(dir.join("song1.mp3").exists());
        assert!(dir.join("song2.mp3").exists());
        let mut remaining = 0;
        let mut it = fs::read_dir(&dir).await.unwrap();
        while it.next_entry().await.unwrap().is_some() {
            remaining += 1;
        }
        assert_eq!(remaining, 2);

        // 极端超容（上限小于单文件）：最新文件依旧保留，不允许清空目录。
        let removed = enforce_limit(&dir, 1, &[]).await.unwrap();
        assert!(removed >= 10_000);
        assert!(dir.join("song2.mp3").exists());
        assert!(!dir.join("song1.mp3").exists());
    }

    #[tokio::test]
    async fn protected_supports_prefix_and_full_name() {
        let dir = std::env::temp_dir().join(format!("vmusic-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        // 5 个文件，写入顺序即 mtime 从旧到新：待删旧文件、相邻键（验证前缀
        // 边界）、legacy 全名保护、前缀保护曲、以及不保护的「最新」锚点
        // （enforce_limit 始终保留 mtime 最新的非保护文件，需要它占住这个位，
        // 相邻键才会真正进入淘汰）。
        for name in [
            "old.mp3",
            "qq-a1-losslesshi.mp3",
            "qq-a1.mp3",
            "qq-a1-lossless.m4a",
            "zzz-new.mp3",
        ] {
            fs::write(dir.join(name), vec![0u8; 10_000]).await.unwrap();
            // 拉开 mtime（50ms，跨过文件系统可能的粗时间粒度，避免同刻文件
            // 被稳定排序随机成「最新」）。
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // `qq-a1-lossless.` 前缀保护 m4a，legacy 全名保护 qq-a1.mp3；
        // 相邻键 qq-a1-losslesshi.mp3 不得被前缀误护，与最旧的 old 一起删。
        let protected = vec!["qq-a1-lossless.".to_string(), "qq-a1.mp3".to_string()];
        enforce_limit(&dir, 20_001, &protected).await.unwrap();
        assert!(dir.join("qq-a1-lossless.m4a").exists(), "前缀保护命中");
        assert!(dir.join("qq-a1.mp3").exists(), "全名保护命中");
        // 前缀带点边界：相邻音质键不在保护内，与 old 一起被淘汰。
        assert!(
            !dir.join("qq-a1-losslesshi.mp3").exists(),
            "相邻键不被前缀误护"
        );
        assert!(
            !dir.join("old.mp3").exists(),
            "最旧且不受保护的文件必须删掉"
        );
        assert!(dir.join("zzz-new.mp3").exists(), "最新文件始终保留");
    }
}
