// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 节拍地图缓存与后台调度：data/stage-beats/<sha1>.json + 进程内幂等任务表。
//!
//! 两个触发源（播放提交 detach、GET 兜底）共用同一张表，同一缓存键全局只有
//! 一个分析任务；分析跑在 spawn_blocking，不随切歌取消，失败只记进程内态，
//! 下次播放允许重试一次。

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha1::{Digest, Sha1};

use vmusic_beats::{Beat, BeatMap};

use crate::state::{AppState, WsEvent};

/// 幂等表里一格的状态。
#[derive(Debug, Clone)]
pub(crate) enum TaskState {
    Analyzing,
    /// 缓存命中后记录地图文件路径；当前决策只匹配状态（`Ready(_)`），
    /// 路径暂不读取，任务 3 GET 侧直出缓存时启用。
    #[allow(dead_code)]
    Ready(PathBuf),
    Failed(Reason),
}

/// 404 reason（tier0 由客户端自行兜底，服务端保留枚举以对齐协议）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason {
    /// tier0 由客户端按性能档位自行回落，服务端保留枚举对齐 404 reason 协议。
    #[allow(dead_code)]
    Tier0,
    Failed,
    Unsupported,
    NotReady,
}

impl Reason {
    /// 任务 3 `GET /v1/stage/beatmap` 的 404 体读取 reason 字符串。
    #[allow(dead_code)]
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Reason::Tier0 => "tier0",
            Reason::Failed => "failed",
            Reason::Unsupported => "unsupported",
            Reason::NotReady => "not_ready",
        }
    }
}

/// 请求结果：Ready 携带地图与是否命中磁盘缓存。
pub(crate) enum Outcome {
    /// 任务 3 `GET /v1/stage/beatmap` 200 响应读取地图与缓存命中标记。
    #[allow(dead_code)]
    Ready {
        map: BeatMap,
        cached: bool,
    },
    Analyzing,
    /// Reason 随任务 3 的 404 体读取。
    #[allow(dead_code)]
    Unavailable(Reason),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Spawn,
    Wait,
    Fail(Reason),
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CachedMap {
    version: u32,
    bpm: Option<f64>,
    offset_ms: i64,
    truncated: bool,
    beats: Vec<Beat>,
    source_mtime_ms: i64,
}

struct AudioRef {
    path: PathBuf,
    mtime_ms: i64,
    key: String,
}

/// 播放提交触发（on_track_committed）：失败态允许重试一次。
pub(crate) fn spawn_after_commit(state: Arc<AppState>, track_id: String) {
    tokio::spawn(async move {
        let _ = request(&state, &track_id, true).await;
    });
}

/// GET 触发：失败态在本曲目播放期内不重试。
///
/// 任务 3 `GET /v1/stage/beatmap` 路由接线后启用；本任务只落地播放提交路径。
#[allow(dead_code)]
pub(crate) async fn request_on_demand(state: &Arc<AppState>, track_id: &str) -> Outcome {
    request(state, track_id, false).await
}

async fn request(state: &Arc<AppState>, track_id: &str, retry_failed: bool) -> Outcome {
    let Some(audio) = resolve_audio(state, track_id).await else {
        return Outcome::Unavailable(Reason::NotReady);
    };
    let cache_file = state.stage_beats_dir().join(format!("{}.json", audio.key));
    if let Some(map) = read_cache(&cache_file, audio.mtime_ms).await {
        state
            .stage_beats
            .lock()
            .await
            .insert(audio.key.clone(), TaskState::Ready(cache_file.clone()));
        return Outcome::Ready { map, cached: true };
    }
    let action = {
        let mut table = state.stage_beats.lock().await;
        table_decide(&mut table, &audio.key, retry_failed)
    };
    match action {
        Action::Wait => Outcome::Analyzing,
        Action::Fail(r) => Outcome::Unavailable(r),
        Action::Spawn => {
            spawn_blocking_analysis(state.clone(), track_id.to_string(), audio);
            Outcome::Analyzing
        }
    }
}

/// 纯状态机：磁盘未命中后，幂等表如何决策。Ready 态在此出现只可能是
/// 缓存文件被删/mtime 变了（调用方已先查磁盘），重开任务。
pub(crate) fn table_decide(
    table: &mut HashMap<String, TaskState>,
    key: &str,
    retry_failed: bool,
) -> Action {
    match table.entry(key.to_string()) {
        Entry::Vacant(e) => {
            e.insert(TaskState::Analyzing);
            Action::Spawn
        }
        Entry::Occupied(e) => match e.get() {
            TaskState::Analyzing => Action::Wait,
            TaskState::Ready(_) => {
                *e.into_mut() = TaskState::Analyzing;
                Action::Spawn
            }
            TaskState::Failed(r) => {
                if retry_failed {
                    *e.into_mut() = TaskState::Analyzing;
                    Action::Spawn
                } else {
                    Action::Fail(*r)
                }
            }
        },
    }
}

async fn resolve_audio(state: &Arc<AppState>, track_id: &str) -> Option<AudioRef> {
    if let Some((source, id)) = crate::online::split_virtual_id(track_id) {
        // 在线曲：只认下载完成 rename 后的正式缓存（find_cached_by_key 跳过
        // .part 且要求 >1024 字节）。未完成不分析、不轮询、不挂 rename。
        let quality = {
            let prefs = state.quality.lock().await;
            crate::online::quality::get(&prefs, &source)
        };
        let path = crate::online::cache::find_cached_by_key(
            &state.online_cache_dir(),
            &source,
            &id,
            quality.as_str(),
        )
        .await?;
        let key = online_cache_key(track_id);
        audio_ref(path, key).await
    } else {
        let track = vmusic_store::get_track(&state.db, &track_id.to_string())
            .await
            .ok()
            .flatten()?;
        let path = PathBuf::from(track.path);
        let key = local_cache_key(&path)?;
        audio_ref(path, key).await
    }
}

async fn audio_ref(path: PathBuf, key: String) -> Option<AudioRef> {
    let meta = tokio::fs::metadata(&path).await.ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some(AudioRef {
        path,
        mtime_ms,
        key,
    })
}

/// 本地曲键：sha1(规范化绝对路径)。walkdir 入库的路径已是绝对、无 . / ..，
/// 这里统一分隔符并去尾斜杠，保证同库同键。
pub(crate) fn local_cache_key(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let s = path.to_str()?.replace('\\', "/");
    let s = s.trim_end_matches('/').trim_end_matches('.');
    if s.is_empty() {
        None
    } else {
        Some(sha1_hex(s.as_bytes()))
    }
}

/// 在线曲键：sha1(虚拟 track_id 原文)。
pub(crate) fn online_cache_key(track_id: &str) -> String {
    sha1_hex(track_id.as_bytes())
}

fn sha1_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut s = String::with_capacity(40);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// 读缓存：mtime 不一致 / 坏 JSON / 空 beats 均视为未命中。
pub(crate) async fn read_cache(file: &Path, source_mtime_ms: i64) -> Option<BeatMap> {
    let bytes = tokio::fs::read(file).await.ok()?;
    let cached: CachedMap = serde_json::from_slice(&bytes).ok()?;
    if cached.source_mtime_ms != source_mtime_ms || cached.beats.is_empty() {
        return None;
    }
    Some(BeatMap {
        version: cached.version,
        bpm: cached.bpm,
        offset_ms: cached.offset_ms,
        truncated: cached.truncated,
        beats: cached.beats,
    })
}

/// 原子落盘：同目录 .tmp + rename。
pub(crate) async fn write_cache(
    file: &Path,
    map: &BeatMap,
    source_mtime_ms: i64,
) -> std::io::Result<()> {
    let body = CachedMap {
        version: map.version,
        bpm: map.bpm,
        offset_ms: map.offset_ms,
        truncated: map.truncated,
        beats: map.beats.clone(),
        source_mtime_ms,
    };
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let tmp = file.with_extension("tmp");
    tokio::fs::write(&tmp, serde_json::to_vec(&body).unwrap()).await?;
    tokio::fs::rename(&tmp, file).await
}

fn spawn_blocking_analysis(state: Arc<AppState>, track_id: String, audio: AudioRef) {
    tokio::spawn(async move {
        let AudioRef {
            path,
            key,
            mtime_ms,
        } = audio;
        let joined = tokio::task::spawn_blocking(move || vmusic_beats::analyze_path(&path)).await;
        match joined {
            Ok(Ok(map)) => {
                if map.beats.is_empty() {
                    mark_failed(&state, &key, Reason::Unsupported).await;
                    return;
                }
                let cache_file = state.stage_beats_dir().join(format!("{key}.json"));
                match write_cache(&cache_file, &map, mtime_ms).await {
                    Ok(()) => {
                        state
                            .stage_beats
                            .lock()
                            .await
                            .insert(key, TaskState::Ready(cache_file));
                        state.publish(WsEvent::BeatmapReady {
                            track_id,
                            bpm: map.bpm,
                            beats_n: map.beats.len(),
                        });
                    }
                    Err(e) => {
                        tracing::warn!("beatmap 缓存落盘失败: {e}");
                        mark_failed(&state, &key, Reason::Failed).await;
                    }
                }
            }
            Ok(Err(vmusic_beats::AnalyzeError::Unsupported(_))) => {
                mark_failed(&state, &key, Reason::Unsupported).await
            }
            Ok(Err(vmusic_beats::AnalyzeError::Failed(e))) => {
                tracing::debug!("beatmap 分析失败 {track_id}: {e}");
                mark_failed(&state, &key, Reason::Failed).await;
            }
            Err(e) => {
                tracing::warn!("beatmap 分析任务异常: {e}");
                mark_failed(&state, &key, Reason::Failed).await;
            }
        }
    });
}

async fn mark_failed(state: &Arc<AppState>, key: &str, reason: Reason) {
    state
        .stage_beats
        .lock()
        .await
        .insert(key.to_string(), TaskState::Failed(reason));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vmusic-beats-test-{}-{}-{}",
            std::process::id(),
            n,
            tag
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mtime_ms(p: &Path) -> i64 {
        std::fs::metadata(p)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    fn sample_map() -> BeatMap {
        BeatMap {
            version: 1,
            bpm: Some(120.0),
            offset_ms: 0,
            truncated: false,
            beats: vec![Beat {
                t: 100,
                strength: 0.5,
                downbeat: true,
                intensity: 1,
            }],
        }
    }

    #[test]
    fn local_key_is_stable_and_absolute_only() {
        let p = PathBuf::from(r"C:\Music\a b.flac");
        let k1 = local_cache_key(&p).unwrap();
        let k2 = local_cache_key(&PathBuf::from("C:/Music/a b.flac")).unwrap();
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 40, "sha1 hex");
        assert!(local_cache_key(Path::new("relative.flac")).is_none());
        // 在线曲用虚拟 id 原文哈希。
        assert_eq!(online_cache_key("online:qq:123").len(), 40);
        assert_ne!(
            online_cache_key("online:qq:123"),
            online_cache_key("online:qq:124")
        );
    }

    #[tokio::test]
    async fn cache_hit_misses_on_mtime_change_and_corrupt_or_empty() {
        let dir = tmp_dir("mtime");
        let file = dir.join("a.flac");
        std::fs::write(&file, b"x").unwrap();
        let cache = dir.join("m.json");
        write_cache(&cache, &sample_map(), mtime_ms(&file))
            .await
            .unwrap();
        assert!(read_cache(&cache, mtime_ms(&file)).await.is_some());
        // mtime 变化（这里模拟：改写缓存里的 source_mtime_ms）即失效。
        let mut bytes = std::fs::read(&cache).unwrap();
        let mut v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        v["source_mtime_ms"] = serde_json::json!(mtime_ms(&file) - 5000);
        bytes = serde_json::to_vec(&v).unwrap();
        std::fs::write(&cache, bytes).unwrap();
        assert!(read_cache(&cache, mtime_ms(&file)).await.is_none());
        // 坏 JSON。
        std::fs::write(&cache, b"{nope").unwrap();
        assert!(read_cache(&cache, mtime_ms(&file)).await.is_none());
    }

    #[test]
    fn idempotent_table_decisions() {
        let mut t: HashMap<String, TaskState> = HashMap::new();
        // 首次：建任务。
        assert!(matches!(table_decide(&mut t, "k", false), Action::Spawn));
        assert!(matches!(t.get("k"), Some(TaskState::Analyzing)));
        // 在途：等待。
        assert!(matches!(table_decide(&mut t, "k", false), Action::Wait));
        // 失败：GET 不重试，播放（retry）重试。
        t.insert("k".into(), TaskState::Failed(Reason::Failed));
        assert!(matches!(
            table_decide(&mut t, "k", false),
            Action::Fail(Reason::Failed)
        ));
        assert!(matches!(table_decide(&mut t, "k", true), Action::Spawn));
        // unsupported 不与 failed 混淆。
        t.insert("u".into(), TaskState::Failed(Reason::Unsupported));
        assert!(matches!(
            table_decide(&mut t, "u", false),
            Action::Fail(Reason::Unsupported)
        ));
        // Ready 但磁盘文件没了（被外部删/LRU）：重开任务。
        t.insert("r".into(), TaskState::Ready(PathBuf::from("r.json")));
        assert!(matches!(table_decide(&mut t, "r", false), Action::Spawn));
    }
}
