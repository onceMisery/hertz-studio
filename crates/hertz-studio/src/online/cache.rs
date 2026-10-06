// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 在线音频缓存：音质/容器分键命名、旧名回退、LRU 淘汰、.part 清理。
//!
//! 目录内容由 [`CacheIndex`] 常驻内存：查找、统计、淘汰、手动清理都走索引，
//! 不再每次 `read_dir` 全量遍历 + 逐个 `stat`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::SystemTime;

use tokio::fs;

/// 缓存键（不含扩展名）：`{stem}-{quality}`。
///
/// 渐进式下载落盘前不知道真实容器扩展名，下载注册表与缓存查找都以无扩展
/// 名的键为身份；正式文件名是 `{key}.{ext}`（见 [`crate::online::progressive::start`]）。
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

/// 「就绪」门槛：版权拦截页那种几百字节的「文件」不能当成可播缓存。
const MIN_READY_BYTES: u64 = 1024;

const PART_SUFFIX: &str = ".part";

/// 正式文件名 → 无扩展名的缓存键。缓存键只由 `[A-Za-z0-9_-]` 组成，音质档里
/// 也没有点，所以按最后一个点切分是安全的。
fn split_key(name: &str) -> Option<(&str, &str)> {
    let (key, ext) = name.rsplit_once('.')?;
    (!key.is_empty() && !ext.is_empty()).then_some((key, ext))
}

fn is_part(name: &str) -> bool {
    name.ends_with(PART_SUFFIX)
}

#[derive(Clone, Copy)]
struct Entry {
    len: u64,
    /// 最后一次由本进程登记的 mtime：LRU 淘汰的排序键，也是「刚落盘的当前曲
    /// 必须保留」那条规则的依据。
    mtime: SystemTime,
}

type EntryMap = HashMap<String, Entry>;
type KeyIndex = HashMap<String, Vec<String>>;

#[derive(Default)]
struct Index {
    /// 文件名 → 大小/mtime。只收正式文件，`.part` 残骸不入索引。
    files: EntryMap,
    /// 无扩展名的缓存键 → 该键下的文件名（同一键正常只有一个扩展名，历史
    /// 残留下来的多扩展名也都在这里，查找按名字排序取第一个就绪的）。
    by_key: KeyIndex,
}

impl Index {
    fn insert(&mut self, name: &str, entry: Entry) {
        if let Some((key, _)) = split_key(name) {
            let slots = self.by_key.entry(key.to_string()).or_default();
            if !slots.iter().any(|n| n == name) {
                slots.push(name.to_string());
            }
        }
        self.files.insert(name.to_string(), entry);
    }

    fn remove(&mut self, name: &str) {
        self.files.remove(name);
        let Some((key, _)) = split_key(name) else {
            return;
        };
        let emptied = match self.by_key.get_mut(key) {
            Some(slots) => {
                slots.retain(|n| n != name);
                slots.is_empty()
            }
            None => false,
        };
        if emptied {
            self.by_key.remove(key);
        }
    }
}

/// 缓存目录的内存索引。
///
/// 为什么需要：`find` 在在线取流的快路径上（每次播放前查缓存）、`enforce_limit`
/// 每次曲目提交后跑一次、`stats` 被前端轮询——缓存目录攒到几千个文件后，这三处
/// 的「读目录 + 逐文件 stat」就是切歌时能感觉到的卡顿。
///
/// 与磁盘的一致性约定：
/// - 本进程的写入都经 [`CacheIndex::note_written`] 登记，删除经 `remove`/`enforce_limit`
///   /`clear` 同步；
/// - 目录外的变更（用户手删、外部清理工具）不主动监听：命中时会做**一次**
///   单文件 `metadata` 复核，文件没了或不足 [`MIN_READY_BYTES`] 就不算命中，
///   条目同时剔除——比「下次启动自愈」更快生效；
/// - 别的进程写进来的文件在下次 [`CacheIndex::refresh`]（下一个启动）前不可见；
///   线上没有第二个写者。
pub struct CacheIndex {
    dir: PathBuf,
    inner: RwLock<Index>,
}

impl CacheIndex {
    /// 启动扫描：整个生命周期只读一遍目录，之后所有查询都在内存里。
    pub async fn load(dir: PathBuf) -> Self {
        let index = Self {
            dir,
            inner: RwLock::new(Index::default()),
        };
        index.refresh().await;
        index
    }

    /// 全量重扫。锁是纯粹的缓存，中毒也只丢一份派生数据，所以这里恢复锁而不是
    /// 让调用方 panic（release 是 `panic = "abort"`，缓存不该有中止进程的能力）。
    fn read(&self) -> RwLockReadGuard<'_, Index> {
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> RwLockWriteGuard<'_, Index> {
        self.inner.write().unwrap_or_else(|e| e.into_inner())
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 全量重扫（启动一次；目录被外力大改后可手动调）。
    pub async fn refresh(&self) {
        let mut next = Index::default();
        if let Ok(mut it) = fs::read_dir(&self.dir).await {
            while let Ok(Some(entry)) = it.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_part(&name) {
                    continue;
                }
                if let Ok(meta) = entry.metadata().await {
                    if meta.is_file() {
                        next.insert(&name, entry_of(&meta));
                    }
                }
            }
        }
        *self.write() = next;
    }

    /// 登记刚落盘的正式文件（下载 rename 成功后调用）。
    pub async fn note_written(&self, path: &Path) {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            return;
        };
        if is_part(&name) {
            return;
        }
        if let Ok(meta) = fs::metadata(path).await {
            if meta.is_file() {
                self.write().insert(&name, entry_of(&meta));
            }
        }
    }

    /// 记下/刷新一个文件条目；文件已不在时剔除。
    fn note_known(&self, name: &str, entry: Entry) {
        self.write().insert(name, entry);
    }

    fn forget(&self, name: &str) {
        self.write().remove(name);
    }

    /// 按缓存键找已就绪的正式文件：先试新命名（任意扩展名），再回落旧命名
    /// `{stem}.mp3`。两条路径都要求超过 [`MIN_READY_BYTES`]。
    ///
    /// 前缀边界由键的精确匹配天然保证：`qq-a1-standard.` 不会误命中
    /// `qq-a1-standardhi.*`（旧实现靠 `format!("{key}.")` 前缀比对达到同一效果）。
    pub async fn find(&self, source: &str, id: &str, quality: &str) -> Option<PathBuf> {
        let key = cache_key(source, id, quality);
        let legacy = legacy_cache_name(source, id);
        let mut candidates: Vec<String> = {
            let idx = self.read();
            idx.by_key.get(&key).cloned().unwrap_or_default()
        };
        candidates.sort();
        candidates.push(legacy);
        for name in candidates {
            let path = self.dir.join(&name);
            match fs::metadata(&path).await {
                // 文件在：刷新条目（大小/mtime 可能被外部改过），就绪才算命中。
                Ok(meta) if meta.is_file() => {
                    let entry = entry_of(&meta);
                    self.note_known(&name, entry);
                    if entry.len > MIN_READY_BYTES {
                        return Some(path);
                    }
                }
                // 索引里有、磁盘上没了：剔除，下次不再走同一条死路。
                _ => self.forget(&name),
            }
        }
        None
    }

    /// 总量超 max_bytes 时按 mtime 从旧到新删到上限的 90%；`.part` 与 protected
    /// （前缀/全名两种形态，见 [`is_protected`]）跳过。无论超容多严重，mtime
    /// 最新的 1 个正式文件始终保留——它通常就是刚 rename 落盘的当前曲，绝不能
    /// 在落盘后立刻被 LRU 删掉。
    /// 启动时传空名单；每次曲目提交后的后台任务传当前播放曲的保护名单。
    pub async fn enforce_limit(
        &self,
        max_bytes: u64,
        protected: &[String],
    ) -> std::io::Result<u64> {
        let mut files: Vec<(String, SystemTime, u64)> = {
            let idx = self.read();
            idx.files
                .iter()
                .filter(|(name, _)| !is_protected(name, protected))
                .map(|(name, e)| (name.clone(), e.mtime, e.len))
                .collect()
        };
        let mut total: u64 = files.iter().map(|(_, _, len)| *len).sum();
        if total <= max_bytes {
            return Ok(0);
        }
        let target = (max_bytes as f64 * 0.9) as u64;
        files.sort_by_key(|(_, mtime, _)| *mtime);
        // 最新文件（刚落盘的当前曲）无条件保留，即使总容量仍然超目标。
        let newest = files.last().map(|(name, _, _)| name.clone());
        let mut removed = 0u64;
        for (name, _, len) in files {
            if total <= target {
                break;
            }
            if newest.as_ref() == Some(&name) {
                continue;
            }
            if fs::remove_file(self.dir.join(&name)).await.is_ok() {
                self.forget(&name);
                total -= len;
                removed += len;
            }
        }
        Ok(removed)
    }

    /// 缓存占用统计：总量、正式文件数、按音源分组（文件名首段即音源）。
    /// 纯内存读取，没有任何 I/O——前端轮询它不再产生目录遍历。
    pub fn stats(&self) -> CacheStats {
        let idx = self.read();
        let mut stats = CacheStats::default();
        let mut by_source: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        for (name, entry) in idx.files.iter() {
            stats.total_bytes += entry.len;
            stats.files += 1;
            let source = name.split('-').next().unwrap_or("other").to_string();
            *by_source.entry(source).or_insert(0) += entry.len;
        }
        stats.by_source = by_source.into_iter().collect();
        stats
    }

    /// 手动清理：删除缓存目录下（可选限定单一音源）的正式文件与 .part 残骸。
    /// protected 名单（当前播放 + 用户保留）照旧豁免。返回删除的字节数。
    ///
    /// `.part` 不在索引里，手动清理是罕见路径，这里顺带扫一遍目录把残骸删掉
    /// （与旧行为一致：残骸不受 protected 豁免，按音源前缀过滤）。
    pub async fn clear(
        &self,
        protected: &[String],
        source: Option<&str>,
    ) -> std::io::Result<u64> {
        let prefix = source.map(|s| format!("{s}-"));
        let mut removed = 0u64;
        let names: Vec<String> = {
            let idx = self.read();
            idx.files.keys().cloned().collect()
        };
        for name in names {
            if let Some(p) = &prefix {
                if !name.starts_with(p.as_str()) {
                    continue;
                }
            }
            if is_protected(&name, protected) {
                continue;
            }
            let len = {
                let idx = self.read();
                idx.files.get(&name).map(|e| e.len).unwrap_or(0)
            };
            if fs::remove_file(self.dir.join(&name)).await.is_ok() {
                self.forget(&name);
                removed += len;
            }
        }
        if let Ok(mut it) = fs::read_dir(&self.dir).await {
            while let Ok(Some(entry)) = it.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if !is_part(&name) {
                    continue;
                }
                if let Some(p) = &prefix {
                    if !name.starts_with(p.as_str()) {
                        continue;
                    }
                }
                let len = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                if fs::remove_file(entry.path()).await.is_ok() {
                    removed += len;
                }
            }
        }
        Ok(removed)
    }
}

fn entry_of(meta: &std::fs::Metadata) -> Entry {
    Entry {
        len: meta.len(),
        mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
    }
}

/// 删除目录内残留 `.part`（上次进程被杀的残骸）。启动时、建索引之前调用。
pub async fn clean_parts(dir: &Path) {
    let Ok(mut it) = fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = it.next_entry().await {
        if entry.file_name().to_string_lossy().ends_with(PART_SUFFIX) {
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
        // 以 `.` 或 `-` 结尾的条目按前缀匹配（分别覆盖单个缓存键与某曲目
        // 全部音质档），否则精确匹配完整文件名。
        if p.ends_with('.') || p.ends_with('-') {
            name.starts_with(p.as_str())
        } else {
            name == p
        }
    })
}

/// 缓存占用统计：总量、正式文件数、按音源分组（文件名首段即音源）。
#[derive(Debug, Default, serde::Serialize)]
pub struct CacheStats {
    pub total_bytes: u64,
    pub files: u64,
    pub by_source: Vec<(String, u64)>,
}

#[cfg(test)]
mod tests_clear {
    use super::*;

    async fn index(dir: &Path) -> CacheIndex {
        CacheIndex::load(dir.to_path_buf()).await
    }

    #[tokio::test]
    async fn stats_and_clear_respect_protected_and_source_filter() {
        let dir = std::env::temp_dir().join(format!("vmusic-cache-clr-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        let make = |name: &str, size: usize| fs::write(dir.join(name), vec![0u8; size]);
        make("netease-1-standard.mp3", 100).await.unwrap();
        make("netease-2-higher.mp3", 200).await.unwrap();
        make("qq-9-standard.mp3", 50).await.unwrap();
        make("qq-9-standard.mp3.part", 10).await.unwrap();

        let idx = index(&dir).await;
        let stats = idx.stats();
        assert_eq!(stats.files, 3);
        assert_eq!(stats.total_bytes, 350);
        assert!(stats.by_source.contains(&("netease".into(), 300)));
        assert!(stats.by_source.contains(&("qq".into(), 50)));

        // 保留 netease-1（豁免其全部音质档）：清理 qq 音源 → 只删 qq；
        // .part 残骸一并清掉（50+10）。
        let protected = vec!["netease-1-".to_string()];
        let removed = idx.clear(&protected, Some("qq")).await.unwrap();
        assert_eq!(removed, 60);
        assert!(dir.join("netease-1-standard.mp3").exists());
        assert!(dir.join("netease-2-higher.mp3").exists());
        assert!(!dir.join("qq-9-standard.mp3").exists());
        assert!(!dir.join("qq-9-standard.mp3.part").exists());
        // 统计跟着索引一起收敛。
        let stats = idx.stats();
        assert_eq!((stats.files, stats.total_bytes), (2, 300));

        // 全量清理：保留项豁免。
        let removed = idx.clear(&protected, None).await.unwrap();
        assert_eq!(removed, 200);
        assert!(dir.join("netease-1-standard.mp3").exists());
        assert_eq!(idx.stats().files, 1);
        let _ = fs::remove_dir_all(&dir).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vmusic-cache-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        dir
    }

    #[tokio::test]
    async fn find_by_prefix_matches_any_ext_then_legacy() {
        let dir = temp_dir("find").await;
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
        let idx = CacheIndex::load(dir.clone()).await;
        let hit = idx.find("qq", "a1", "lossless").await.unwrap();
        assert!(hit.to_string_lossy().ends_with("qq-a1-lossless.m4a"));

        // 键边界：不能被相邻音质键误命中。
        assert!(idx.find("qq", "a1", "hires").await.is_none());

        // 只有旧名时回退。
        let dir2 = temp_dir("legacy").await;
        fs::write(dir2.join("qq-a2.mp3"), vec![0u8; 2000])
            .await
            .unwrap();
        let idx2 = CacheIndex::load(dir2.clone()).await;
        let hit2 = idx2.find("qq", "a2", "lossless").await.unwrap();
        assert!(hit2.to_string_lossy().ends_with("qq-a2.mp3"));

        // 太小的「版权拦截页」不算就绪：既不命中新名也不回退旧名。
        let dir3 = temp_dir("small").await;
        fs::write(dir3.join("qq-a3-lossless.mp3"), vec![0u8; 128])
            .await
            .unwrap();
        let idx3 = CacheIndex::load(dir3.clone()).await;
        assert!(idx3.find("qq", "a3", "lossless").await.is_none());
        // 不足门槛的文件仍在账上（占用/淘汰要算它），不是被丢弃。
        assert_eq!(idx3.stats().files, 1);
    }

    /// 性能探针（不设断言，避免抖动变红）：索引 vs 旧「每次遍历目录」的量级差。
    /// 手动跑：`$env:VMUSIC_PERF=1; cargo test -p hertz-studio --lib -- --nocapture cache_perf`
    #[tokio::test]
    async fn cache_perf_probe() {
        if std::env::var("VMUSIC_PERF").is_err() {
            return;
        }
        const N: usize = 3000;
        let dir = temp_dir("perf").await;
        for i in 0..N {
            fs::write(
                dir.join(format!("qq-track{i:05}-standard.mp3")),
                vec![0u8; 2048],
            )
            .await
            .unwrap();
        }
        let index = CacheIndex::load(dir.clone()).await;
        println!("PERF indexed files: {}", index.stats().files);

        // find：索引命中（一次 metadata 复核）vs 旧实现（每次 read_dir + 逐项 stat）。
        let t = std::time::Instant::now();
        for _ in 0..200 {
            let _ = index.find("qq", "track02999", "standard").await.unwrap();
        }
        println!("PERF find (indexed): {:?}/lookup", t.elapsed() / 200);
        let t = std::time::Instant::now();
        for _ in 0..20 {
            let prefix = "qq-track02999-standard.";
            let mut it = fs::read_dir(&dir).await.unwrap();
            while let Ok(Some(entry)) = it.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".part") || !name.starts_with(prefix) {
                    continue;
                }
                if let Ok(meta) = entry.metadata().await {
                    if meta.len() > MIN_READY_BYTES {
                        break;
                    }
                }
            }
        }
        println!("PERF find (legacy scan): {:?}/lookup", t.elapsed() / 20);

        // stats：内存读 vs 旧实现（每次全目录 stat）。
        let t = std::time::Instant::now();
        for _ in 0..200 {
            let _ = index.stats();
        }
        println!("PERF stats (indexed): {:?}/call", t.elapsed() / 200);
        let t = std::time::Instant::now();
        for _ in 0..20 {
            let mut total = 0u64;
            let mut it = fs::read_dir(&dir).await.unwrap();
            while let Ok(Some(entry)) = it.next_entry().await {
                if let Ok(meta) = entry.metadata().await {
                    if meta.is_file() {
                        total += meta.len();
                    }
                }
            }
            assert!(total > 0);
        }
        println!("PERF stats (legacy scan): {:?}/call", t.elapsed() / 20);

        // 每次提交曲目后都会跑的回收：上限没超时的空转路径（最常见）。
        let max = index.stats().total_bytes + 1;
        let t = std::time::Instant::now();
        for _ in 0..20 {
            index.enforce_limit(max, &[]).await.unwrap();
        }
        println!("PERF enforce no-op (indexed): {:?}/call", t.elapsed() / 20);
        let _ = fs::remove_dir_all(&dir).await;
    }

    /// 目录外的手删：命中时复核发现文件没了，条目立刻剔除并回落到未命中。
    #[tokio::test]
    async fn external_deletion_self_heals_on_lookup() {
        let dir = temp_dir("selfheal").await;
        fs::write(dir.join("qq-a1-standard.mp3"), vec![0u8; 2000])
            .await
            .unwrap();
        let idx = CacheIndex::load(dir.clone()).await;
        assert!(idx.find("qq", "a1", "standard").await.is_some());

        fs::remove_file(dir.join("qq-a1-standard.mp3")).await.unwrap();
        assert!(idx.find("qq", "a1", "standard").await.is_none());
        assert_eq!(idx.stats().files, 0, "失效条目要跟着剔除");
    }

    /// 写时增量：落盘后必须显式登记，否则索引看不见它（这是索引与磁盘的契约）。
    #[tokio::test]
    async fn writes_are_invisible_until_noted() {
        let dir = temp_dir("write").await;
        let idx = CacheIndex::load(dir.clone()).await;
        let path = dir.join("qq-b1-standard.flac");
        fs::write(&path, vec![0u8; 2000]).await.unwrap();
        assert!(idx.find("qq", "b1", "standard").await.is_none());

        idx.note_written(&path).await;
        assert!(idx.find("qq", "b1", "standard").await.is_some());
        assert_eq!(idx.stats().files, 1);

        // 重扫也能捡回外部写入（启动路径即此）。
        let path2 = dir.join("qq-c1-standard.mp3");
        fs::write(&path2, vec![0u8; 2000]).await.unwrap();
        assert!(idx.find("qq", "c1", "standard").await.is_none());
        idx.refresh().await;
        assert!(idx.find("qq", "c1", "standard").await.is_some());
    }

    #[tokio::test]
    async fn cleans_parts_and_evicts_oldest() {
        let dir = temp_dir("evict").await;
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
        let idx = CacheIndex::load(dir.clone()).await;
        let removed = idx.enforce_limit(25_000, &[]).await.unwrap();
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
        // 索引与目录一致：统计里只剩 2 个文件。
        assert_eq!(idx.stats().files, 2);

        // 极端超容（上限小于单文件）：最新文件依旧保留，不允许清空目录。
        let removed = idx.enforce_limit(1, &[]).await.unwrap();
        assert!(removed >= 10_000);
        assert!(dir.join("song2.mp3").exists());
        assert!(!dir.join("song1.mp3").exists());
        assert_eq!(idx.stats().files, 1);
    }

    #[tokio::test]
    async fn protected_supports_prefix_and_full_name() {
        let dir = temp_dir("protect").await;
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
        let idx = CacheIndex::load(dir.clone()).await;
        // `qq-a1-lossless.` 前缀保护 m4a，legacy 全名保护 qq-a1.mp3；
        // 相邻键 qq-a1-losslesshi.mp3 不得被前缀误护，与最旧的 old 一起删。
        let protected = vec!["qq-a1-lossless.".to_string(), "qq-a1.mp3".to_string()];
        idx.enforce_limit(20_001, &protected).await.unwrap();
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
