// SPDX-License-Identifier: MIT
//! Explicit room resource capabilities. Internal paths never cross this module.
use super::contract::{RoomError, RoomResult};
use crate::state::AppState;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use uuid::Uuid;
use vmusic_core::{Track, TrackSource};

const MAX_SHARED: usize = 2000;
const MAX_FAVORITE_RESOLUTION: usize = 32;
const MAX_RESOURCE_BYTES: usize = 2 * 1024 * 1024;
const CHUNK_BYTES: usize = 24 * 1024;
const CACHE_ENTRIES: usize = 8;
const CACHE_BYTES: usize = 8 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(60);
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedTrack {
    pub resource_id: Uuid,
    /// Durable reference only; it never grants access to a shared resource.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite_key: Option<String>,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub has_cover: bool,
}
#[derive(Clone)]
struct Entry {
    track_id: String,
    path: PathBuf,
    view: SharedTrack,
}
#[derive(Default)]
struct Library {
    entries: BTreeMap<Uuid, Entry>,
    by_track: HashMap<String, Uuid>,
    revision: u64,
    resources: VecDeque<CachedResource>,
}
struct CachedResource {
    id: Uuid,
    kind: ResourceKind,
    revision: String,
    bytes: Arc<[u8]>,
    mime: &'static str,
    created: Instant,
}
#[derive(Clone)]
pub struct SharedLibrary(Arc<RwLock<Library>>, Arc<zeroize::Zeroizing<[u8; 32]>>);
impl Default for SharedLibrary {
    fn default() -> Self {
        Self::with_reference_secret(Uuid::new_v4().as_bytes())
    }
}
/// Immutable result of file/DB validation. Only the room owner may install it.
pub(super) struct PreparedLibrary {
    expected_revision: u64,
    entries: BTreeMap<Uuid, Entry>,
    by_track: HashMap<String, Uuid>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Lyrics,
    Cover,
}
#[derive(Serialize)]
pub struct ResourceChunk {
    pub resource_id: Uuid,
    pub revision: String,
    pub offset: usize,
    pub total: usize,
    pub mime: &'static str,
    pub base64: String,
}
fn label(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().filter(|c| !c.is_control()).take(64) {
        if out.len() + c.len_utf8() > 128 {
            break;
        }
        out.push(c);
    }
    out
}
impl SharedLibrary {
    /// The host supplies its profile-persisted identity, never a room secret.
    pub(super) fn with_reference_secret(secret: &[u8]) -> Self {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts all key lengths");
        mac.update(b"hertz/lan-favorite-reference/v1");
        let key: [u8; 32] = mac.finalize().into_bytes().into();
        Self(
            Arc::new(RwLock::new(Library::default())),
            Arc::new(zeroize::Zeroizing::new(key)),
        )
    }
    fn favorite_key(&self, track: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.1.as_ref().as_ref())
            .expect("HMAC accepts all key lengths");
        mac.update(track.as_bytes());
        format!("{:x}", mac.finalize().into_bytes())
    }
    /// Local projection only: private library IDs must never enter peer views.
    pub async fn local_favorite_ids(&self) -> BTreeMap<String, String> {
        self.0
            .read()
            .await
            .entries
            .values()
            .filter_map(|entry| {
                entry
                    .view
                    .favorite_key
                    .as_ref()
                    .map(|key| (key.clone(), entry.track_id.clone()))
            })
            .collect()
    }
    pub async fn resolve_favorites(&self, keys: &[String]) -> RoomResult<Vec<SharedTrack>> {
        if keys.is_empty()
            || keys.len() > MAX_FAVORITE_RESOLUTION
            || keys
                .iter()
                .any(|key| key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(RoomError::invalid("收藏引用无效或超过32首"));
        }
        let library = self.0.read().await;
        Ok(library
            .entries
            .values()
            .filter(|entry| {
                entry
                    .view
                    .favorite_key
                    .as_ref()
                    .is_some_and(|key| keys.contains(key))
            })
            .map(|entry| entry.view.clone())
            .collect())
    }
    pub(super) async fn prepare_replace(
        &self,
        state: &AppState,
        ids: Vec<String>,
    ) -> RoomResult<PreparedLibrary> {
        if ids.len() > MAX_SHARED {
            return Err(RoomError::invalid("最多共享2000首本地歌曲"));
        }
        let (expected_revision, previous) = {
            let library = self.0.read().await;
            (library.revision, library.by_track.clone())
        };
        let mut entries = BTreeMap::new();
        let mut by_track = HashMap::new();
        for id in ids {
            if by_track.contains_key(&id) {
                continue;
            }
            let track = local_track(state, &id).await?;
            let path = local_path(&track).await?;
            let resource_id = previous.get(&id).copied().unwrap_or_else(Uuid::new_v4);
            let view = SharedTrack {
                resource_id,
                favorite_key: Some(self.favorite_key(&id)),
                title: label(&track.title),
                artist: track.artist.as_deref().map(label),
                album: track.album.as_deref().map(label),
                duration_ms: track.duration_ms,
                sample_rate: track.sample_rate,
                channels: track.channels,
                has_cover: track.has_cover,
            };
            entries.insert(
                resource_id,
                Entry {
                    track_id: id.clone(),
                    path,
                    view,
                },
            );
            by_track.insert(id, resource_id);
        }
        Ok(PreparedLibrary {
            expected_revision,
            entries,
            by_track,
        })
    }
    pub(super) async fn commit_replace(
        &self,
        prepared: PreparedLibrary,
    ) -> RoomResult<Vec<SharedTrack>> {
        let mut library = self.0.write().await;
        if library.revision != prepared.expected_revision {
            return Err(RoomError::new(
                "revision_conflict",
                "分享范围已改变，请重新选择",
            ));
        }
        let next = library
            .revision
            .checked_add(1)
            .ok_or_else(RoomError::exhausted)?;
        library.resources.clear();
        library.entries = prepared.entries;
        library.by_track = prepared.by_track;
        library.revision = next;
        Ok(library.entries.values().map(|e| e.view.clone()).collect())
    }
    pub async fn revision(&self) -> u64 {
        self.0.read().await.revision
    }
    pub async fn local_ids(&self) -> Vec<String> {
        self.0.read().await.by_track.keys().cloned().collect()
    }
    pub async fn views(&self) -> Vec<SharedTrack> {
        self.0
            .read()
            .await
            .entries
            .values()
            .map(|e| e.view.clone())
            .collect()
    }
    pub async fn view(&self, id: Uuid) -> Option<SharedTrack> {
        self.0.read().await.entries.get(&id).map(|e| e.view.clone())
    }
    /// A card and its sharing revision come from the same authorization snapshot.
    pub(super) async fn card(&self, id: Uuid) -> (u64, Option<SharedTrack>) {
        let library = self.0.read().await;
        (
            library.revision,
            library.entries.get(&id).map(|e| e.view.clone()),
        )
    }
    pub async fn resource_for(&self, track: &str) -> Option<Uuid> {
        self.0.read().await.by_track.get(track).copied()
    }
    /// Rechecks current DB source and canonical path at every start/preparation.
    pub async fn source(&self, state: &AppState, id: Uuid) -> RoomResult<(String, PathBuf)> {
        let (entry, _) = self.authorized_source(state, id).await?;
        Ok((entry.track_id, entry.path))
    }
    async fn authorized_source(&self, state: &AppState, id: Uuid) -> RoomResult<(Entry, u64)> {
        let (entry, revision) = {
            let library = self.0.read().await;
            (
                library
                    .entries
                    .get(&id)
                    .cloned()
                    .ok_or_else(RoomError::denied)?,
                library.revision,
            )
        };
        let track = local_track(state, &entry.track_id).await?;
        let actual = local_path(&track).await?;
        let library = self.0.read().await;
        if library.revision != revision
            || actual != entry.path
            || !library
                .entries
                .get(&id)
                .is_some_and(|e| e.track_id == entry.track_id && e.path == actual)
        {
            return Err(RoomError::denied());
        }
        Ok((entry, revision))
    }
    pub async fn read(
        &self,
        state: &Arc<AppState>,
        id: Uuid,
        kind: ResourceKind,
        offset: usize,
        expected_revision: Option<String>,
    ) -> RoomResult<ResourceChunk> {
        let (entry, revision) = self.authorized_source(state, id).await?;
        let Entry { track_id, path, .. } = entry;
        if offset > 0 {
            let library = self.0.read().await;
            if library.revision != revision {
                return Err(RoomError::denied());
            }
            let resource = library
                .resources
                .iter()
                .find(|r| {
                    r.id == id
                        && r.kind == kind
                        && r.created.elapsed() < CACHE_TTL
                        && Some(r.revision.as_str()) == expected_revision.as_deref()
                })
                .ok_or_else(|| RoomError::new("resource_expired", "资源快照已失效，请从头加载"))?;
            return resource.chunk(offset);
        }
        let (bytes, mime) = match kind {
            ResourceKind::Lyrics => {
                // Use only the local lyric reader. It never invokes online
                // accounts or turns a client string into a filesystem path.
                // SQL limits the content before transferring it into Rust.
                let row:Option<(Option<String>,i64)>=sqlx::query_as("SELECT CASE WHEN length(CAST(content AS BLOB))<=? THEN content ELSE NULL END,offset_ms FROM track_lyrics WHERE track_id=?")
                    .bind(MAX_RESOURCE_BYTES as i64).bind(&track_id).fetch_optional(&state.db).await.map_err(|_|RoomError::storage())?;
                if row.as_ref().is_some_and(|r| r.0.is_none()) {
                    return Err(RoomError::invalid("导入歌词超过资源限额"));
                }
                let saved_offset = row.as_ref().map(|r| r.1).unwrap_or(0);
                let mut doc =
                    if let Some(content) = row.and_then(|r| r.0).filter(|s| !s.trim().is_empty()) {
                        crate::lyrics::parse_saved_checked(&content).map_err(lyric_error)?
                    } else {
                        let source = path.clone();
                        let embedded = tokio::task::spawn_blocking(move || {
                            vmusic_library::read_metadata_bounded(&source, MAX_RESOURCE_BYTES)
                        })
                        .await
                        .map_err(|_| RoomError::storage())?;
                        let embedded = embedded
                            .map_err(|_| {
                                RoomError::new(
                                    "resource_metadata_invalid",
                                    "歌曲内嵌元数据无效、超过读取限额或格式不受支持",
                                )
                            })
                            .and_then(|meta| {
                                meta.lyrics
                                    .filter(|s| !s.trim().is_empty())
                                    .map(|content| parse_lyrics_checked(&content))
                                    .transpose()
                            });
                        match embedded {
                            Ok(Some(doc)) => doc,
                            result => match sidecar_lyrics(&path).await? {
                                Some(doc) => doc,
                                None => result?.unwrap_or_else(vmusic_core::LyricDocument::empty),
                            },
                        }
                    };
                doc.offset_ms = doc.offset_ms.saturating_add(saved_offset);
                vmusic_lyrics::apply_offset(&mut doc);
                (
                    serde_json::to_vec(&doc).map_err(|_| RoomError::storage())?,
                    "application/json",
                )
            }
            ResourceKind::Cover => {
                if track_id.len() > 128
                    || !track_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                {
                    return Err(RoomError::denied());
                }
                let mut found = None;
                for (ext, mime) in [
                    ("jpg", "image/jpeg"),
                    ("jpeg", "image/jpeg"),
                    ("png", "image/png"),
                    ("webp", "image/webp"),
                ] {
                    let file = state.cover_dir().join(format!("{track_id}.{ext}"));
                    if tokio::fs::try_exists(&file).await.unwrap_or(false) {
                        // A cover cache symlink must not escape its cache.
                        let root = tokio::fs::canonicalize(state.cover_dir())
                            .await
                            .map_err(|_| RoomError::denied())?;
                        let file = tokio::fs::canonicalize(file)
                            .await
                            .map_err(|_| RoomError::denied())?;
                        if !file.starts_with(root) {
                            return Err(RoomError::denied());
                        }
                        let bytes = read_bounded(&file).await?;
                        found = Some((bytes, mime));
                        break;
                    }
                }
                found.ok_or_else(|| RoomError::invalid("歌曲没有可共享封面"))?
            }
        };
        if bytes.len() > MAX_RESOURCE_BYTES || offset > bytes.len() {
            return Err(RoomError::invalid("资源大小或分页游标无效"));
        }
        // DB/source changes during the read invalidate the result as well.
        if self.authorized_source(state, id).await?.1 != revision {
            return Err(RoomError::denied());
        }
        // Revocation during I/O must not grant access to an old snapshot.
        let mut library = self.0.write().await;
        if library.revision != revision || !library.entries.contains_key(&id) {
            return Err(RoomError::denied());
        }
        let resource = CachedResource {
            id,
            kind,
            revision: format!("{:x}", Sha256::digest(&bytes)),
            bytes: bytes.into(),
            mime,
            created: Instant::now(),
        };
        library.resources.retain(|r| {
            r.created.elapsed() < CACHE_TTL
                && !(r.id == id && r.kind == kind && r.revision == resource.revision)
        });
        while library.resources.len() >= CACHE_ENTRIES
            || library
                .resources
                .iter()
                .map(|r| r.bytes.len())
                .sum::<usize>()
                + resource.bytes.len()
                > CACHE_BYTES
        {
            library.resources.pop_front();
        }
        let chunk = resource.chunk(0)?;
        library.resources.push_back(resource);
        Ok(chunk)
    }
}
fn lyric_error(error: crate::error::ApiError) -> RoomError {
    RoomError::new(error.code, error.message)
}
fn parse_lyrics_checked(content: &str) -> RoomResult<vmusic_core::LyricDocument> {
    // Keep size/structure failures distinct from the absence of a lyric source.
    crate::lyrics::parse_saved_checked(content).map_err(lyric_error)
}
async fn sidecar_lyrics(path: &Path) -> RoomResult<Option<vmusic_core::LyricDocument>> {
    let Some(sidecar) = vmusic_library::find_sidecar_lyrics(path) else {
        return Ok(None);
    };
    let sidecar = tokio::fs::canonicalize(sidecar)
        .await
        .map_err(|_| RoomError::denied())?;
    if sidecar.parent() != path.parent() {
        return Err(RoomError::denied());
    }
    let bytes = read_bounded(&sidecar).await?;
    let content =
        String::from_utf8(bytes).map_err(|_| RoomError::invalid("歌词文本编码不受支持"))?;
    if content.trim().is_empty() {
        return Ok(None);
    }
    parse_lyrics_checked(&content).map(Some)
}
async fn local_track(state: &AppState, id: &str) -> RoomResult<Track> {
    // Track's compatibility decoder maps unknown source values to Local. A
    // sharing capability requires an explicit local DB value instead.
    let mut tx = state.db.begin().await.map_err(|_| RoomError::storage())?;
    let source: Option<String> = sqlx::query_scalar("SELECT source FROM tracks WHERE id=?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| RoomError::storage())?;
    if source.as_deref() != Some("local") {
        return Err(RoomError::denied());
    }
    let track = vmusic_store::get_track_on(&mut tx, id)
        .await
        .map_err(|_| RoomError::storage())?
        .ok_or_else(RoomError::denied)?;
    tx.commit().await.map_err(|_| RoomError::storage())?;
    Ok(track)
}
async fn local_path(track: &Track) -> RoomResult<PathBuf> {
    if track.source != TrackSource::Local
        || track.id.starts_with("online:")
        || track.path.contains("://")
        || !Path::new(&track.path).is_absolute()
        || vmusic_library::ensure_local_root(Path::new(&track.path)).is_err()
    {
        return Err(RoomError::invalid("房间仅允许分享本地歌曲"));
    }
    let path = tokio::fs::canonicalize(&track.path)
        .await
        .map_err(|_| RoomError::invalid("共享文件不可读"))?;
    vmusic_library::ensure_local_root(&path).map_err(|_| RoomError::denied())?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| RoomError::invalid("共享文件不可读"))?;
    if !metadata.is_file() {
        return Err(RoomError::invalid("共享对象必须是普通文件"));
    }
    Ok(path)
}

impl CachedResource {
    fn chunk(&self, offset: usize) -> RoomResult<ResourceChunk> {
        use base64::Engine;
        if offset > self.bytes.len() {
            return Err(RoomError::invalid("资源分页游标无效"));
        }
        Ok(ResourceChunk {
            resource_id: self.id,
            revision: self.revision.clone(),
            offset,
            total: self.bytes.len(),
            mime: self.mime,
            base64: base64::engine::general_purpose::STANDARD.encode(
                &self.bytes[offset..self.bytes.len().min(offset.saturating_add(CHUNK_BYTES))],
            ),
        })
    }
}
async fn read_bounded(path: &Path) -> RoomResult<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    if !tokio::fs::metadata(path)
        .await
        .map_err(|_| RoomError::storage())?
        .is_file()
    {
        return Err(RoomError::denied());
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| RoomError::storage())?;
    let metadata = file.metadata().await.map_err(|_| RoomError::storage())?;
    if !metadata.is_file() {
        return Err(RoomError::denied());
    }
    if metadata.len() > MAX_RESOURCE_BYTES as u64 {
        return Err(RoomError::invalid("资源超过2MiB"));
    }
    let mut bytes = Vec::new();
    file.take((MAX_RESOURCE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| RoomError::storage())?;
    if bytes.len() > MAX_RESOURCE_BYTES {
        return Err(RoomError::invalid("资源超过2MiB"));
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "resources_tests.rs"]
mod tests;
