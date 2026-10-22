// SPDX-License-Identifier: MIT
//! Explicit provider lookup; all writes remain in the parent candidate service.
use super::*;
use crate::online as providers;
use serde::{Deserialize, Serialize};

const RESULT_CAP: usize = 3;
const SEARCH_RESULT_CAP: usize = 10;
const SAVED_BYTES: usize = 2 * 1024 * 1024;
const NETWORK_DEADLINE: Duration = Duration::from_secs(8);
static NETWORK: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Search {
    source: String,
    query: Option<String>,
    expected_metadata_revision: String,
    expected_lyrics_revision: String,
    #[serde(default)]
    allow_automatic_apply: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Choice {
    source: String,
    source_label: String,
    ref_id: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: u64,
    evidence: Evidence,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    title_equal: bool,
    artist_equal: bool,
    album_equal: bool,
    duration_delta_ms: Option<u64>,
    version_mismatch: bool,
    strong_metadata_match: bool,
    automatic_apply_allowed: bool,
    reasons: Vec<&'static str>,
}

fn normalized(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn variants(text: &str) -> Vec<&'static str> {
    let lower = text.to_lowercase();
    let tokens: Vec<_> = lower.split(|c: char| !c.is_alphanumeric()).collect();
    [
        "live",
        "remix",
        "cover",
        "instrumental",
        "现场",
        "翻唱",
        "伴奏",
    ]
    .into_iter()
    .filter(|v| {
        if v.is_ascii() {
            tokens.contains(v)
        } else {
            lower.contains(v)
        }
    })
    .collect()
}
fn evidence(track: &Track, title: &str, artist: &str, album: &str, duration: u64) -> Evidence {
    let equal = |a: &str, b: &str| !normalized(a).is_empty() && normalized(a) == normalized(b);
    let title_equal = equal(&track.title, title);
    let artist_equal = equal(track.artist.as_deref().unwrap_or(""), artist);
    let album_equal = equal(track.album.as_deref().unwrap_or(""), album);
    let duration_delta_ms = track
        .duration_ms
        .filter(|d| *d > 0)
        .filter(|_| duration > 0)
        .map(|d| d.abs_diff(duration));
    let version_mismatch = variants(&track.title) != variants(title);
    let mut reasons = Vec::new();
    reasons.push(if title_equal {
        "title_equal"
    } else {
        "title_different"
    });
    reasons.push(if artist_equal {
        "artist_equal"
    } else if track.artist.as_deref().unwrap_or("").trim().is_empty() || artist.trim().is_empty() {
        "artist_missing"
    } else {
        "artist_different"
    });
    reasons.push(if album_equal {
        "album_equal"
    } else if track.album.as_deref().unwrap_or("").trim().is_empty() || album.trim().is_empty() {
        "album_missing"
    } else {
        "album_different"
    });
    reasons.push(match duration_delta_ms {
        Some(d) if d <= 1000 => "duration_close",
        Some(_) => "duration_different",
        None => "duration_missing",
    });
    if version_mismatch {
        reasons.push("version_different");
    }
    let strong_metadata_match = title_equal
        && artist_equal
        && album_equal
        && duration_delta_ms.is_some_and(|d| d <= 1000)
        && !version_mismatch;
    Evidence {
        title_equal,
        artist_equal,
        album_equal,
        duration_delta_ms,
        version_mismatch,
        strong_metadata_match,
        automatic_apply_allowed: false,
        reasons,
    }
}
fn rank(e: &Evidence) -> i32 {
    i32::from(e.title_equal) * 40
        + i32::from(e.artist_equal) * 30
        + i32::from(e.album_equal) * 10
        + i32::from(e.duration_delta_ms.is_some_and(|d| d <= 1000)) * 20
        - i32::from(e.version_mismatch) * 40
}
fn automatic_choice_index(choices: &[Choice], eligible_set: bool) -> Option<usize> {
    if !eligible_set
        || choices
            .iter()
            .any(|choice| choice.evidence.version_mismatch)
    {
        return None;
    }
    let mut strong = choices
        .iter()
        .enumerate()
        .filter(|(_, choice)| choice.evidence.strong_metadata_match);
    let (index, _) = strong.next()?;
    strong.next().is_none().then_some(index)
}
pub(super) async fn visible_lyrics_are_empty(track: &Track, overlay_is_empty: bool) -> bool {
    overlay_is_empty && crate::lyrics::raw_local(track, None).await.lines.is_empty()
}
fn is_complete_search_page(page: &providers::SearchPage) -> bool {
    page.total_is_exact
        && page.total == page.tracks.len()
        && page.total <= SEARCH_RESULT_CAP
        && page.warning.is_none()
        && page
            .pagination
            .as_ref()
            .is_none_or(|pagination| !pagination.has_more)
}
async fn current(
    state: &AppState,
    id: &str,
    metadata_expected: &str,
    expected: i64,
) -> ApiResult<Track> {
    let (track, saved) = snapshot(state, id).await?;
    if metadata(&track)? != metadata_expected || saved.revision != expected {
        return Err(conflict());
    }
    Ok(track)
}
async fn network<T>(
    source: &str,
    work: impl std::future::Future<Output = ApiResult<T>>,
) -> ApiResult<T> {
    let _permit = NETWORK.clone().try_acquire_owned().map_err(|_| busy())?;
    tokio::time::timeout(NETWORK_DEADLINE, work)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::REQUEST_TIMEOUT,
                "lyrics_timeout",
                "歌词来源请求超时，请显式重试",
            )
            .with_source(source)
        })?
}

pub(crate) async fn search(state: &Arc<AppState>, id: &str, body: Search) -> ApiResult<Value> {
    let info = providers::lyric_candidate_source(&body.source)?;
    let expected = revision(&body.expected_lyrics_revision)?;
    let (track, saved) = snapshot(state, id).await?;
    if metadata(&track)? != body.expected_metadata_revision || saved.revision != expected {
        return Err(conflict());
    }
    let allow_automatic_apply = body.allow_automatic_apply
        && visible_lyrics_are_empty(&track, saved.content.is_none()).await;
    let query = body.query.unwrap_or_else(|| {
        [track.title.as_str(), track.artist.as_deref().unwrap_or("")]
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    });
    let query = query.trim();
    if query.is_empty()
        || query.chars().count() > 192
        || query.len() > 768
        || query.chars().any(char::is_control)
    {
        return Err(bad_request("歌词检索词须为 1–192 个字符的单行文本"));
    }
    let ctx = crate::routes::online_ctx(state);
    let page = network(
        &body.source,
        providers::search(
            &ctx,
            providers::SearchQuery {
                q: Some(query.into()),
                cat: None,
                source: body.source.clone(),
                limit: SEARCH_RESULT_CAP,
                offset: 0,
            },
        ),
    )
    .await?;
    publish(
        state,
        id,
        &track,
        &body.expected_metadata_revision,
        expected,
        info,
        page,
        allow_automatic_apply,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn publish(
    state: &Arc<AppState>,
    id: &str,
    track: &Track,
    fingerprint: &str,
    expected: i64,
    info: providers::SourceInfo,
    page: providers::SearchPage,
    allow_automatic_apply: bool,
) -> ApiResult<Value> {
    let source = info.id;
    if page.source != source {
        return Err(ApiError::upstream_rejected("歌词搜索返回了错误的来源身份"));
    }
    let complete = is_complete_search_page(&page);
    let mut seen = std::collections::HashSet::new();
    let mut choices = Vec::new();
    let mut rejected_item = false;
    for item in page.tracks.into_iter().take(SEARCH_RESULT_CAP) {
        if item.source != source
            || item.id.is_empty()
            || item.id.len() > 256
            || item.id.chars().any(char::is_control)
            || [&item.title, &item.artist, &item.album]
                .iter()
                .any(|s| s.len() > 2048 || s.chars().any(|c| c.is_control()))
            || item.title.trim().is_empty()
            || !seen.insert(item.id.clone())
        {
            rejected_item = true;
            continue;
        }
        let evidence = evidence(
            track,
            &item.title,
            &item.artist,
            &item.album,
            item.duration_ms,
        );
        choices.push(Choice {
            source: source.into(),
            source_label: info.label.into(),
            ref_id: item.id,
            title: item.title,
            artist: item.artist,
            album: item.album,
            duration_ms: item.duration_ms,
            evidence,
        });
    }
    let auto_index = automatic_choice_index(
        &choices,
        allow_automatic_apply && complete && !rejected_item,
    );
    let auto_ref_id = auto_index.map(|index| choices[index].ref_id.clone());
    choices.sort_by_key(|c| std::cmp::Reverse(rank(&c.evidence)));
    choices.truncate(RESULT_CAP);
    current(state, id, fingerprint, expected).await?;
    let mut cache = state.lyric_candidates.lock().await;
    let now = Instant::now();
    cache.retain(|_, c| c.expires > now);
    if cache.len() + choices.len() > CAP {
        return Err(busy());
    }
    let mut results = Vec::new();
    let mut automatic_apply_allowed = false;
    for mut choice in choices {
        let is_automatic = auto_ref_id.as_deref() == Some(choice.ref_id.as_str());
        choice.evidence.automatic_apply_allowed = is_automatic;
        automatic_apply_allowed |= is_automatic;
        let candidate_id = uuid::Uuid::new_v4().to_string();
        let mut out = serde_json::to_value(&choice).map_err(|_| internal("歌词搜索投影失败"))?;
        out["candidateId"] = json!(candidate_id);
        out["licenseStatus"] = json!("not_provided");
        cache.insert(
            candidate_id,
            Candidate {
                id: id.into(),
                metadata: fingerprint.into(),
                revision: expected,
                expires: now + TTL,
                automatic_apply_allowed: is_automatic,
                payload: Payload::Online(choice),
            },
        );
        results.push(out);
    }
    Ok(
        json!({"candidates":results,"metadataRevision":fingerprint,"lyricsRevision":expected.to_string(),"expiresInMs":TTL.as_millis(),"automaticApplyAllowed":automatic_apply_allowed}),
    )
}

pub(crate) async fn prepare(state: &Arc<AppState>, id: &str, body: Apply) -> ApiResult<Value> {
    let expected = revision(&body.expected_lyrics_revision)?;
    let candidate = state
        .lyric_candidates
        .lock()
        .await
        .get(&body.candidate_id)
        .cloned()
        .ok_or_else(expired)?;
    if candidate.id != id || candidate.revision != expected {
        return Err(conflict());
    }
    if candidate.expires <= Instant::now() {
        return Err(expired());
    }
    current(state, id, &candidate.metadata, expected).await?;
    if let Payload::Ready { doc, .. } = &candidate.payload {
        if doc.origin.is_none() {
            return Err(bad_request("这不是在线歌词候选"));
        }
        return Ok(preview(
            &body.candidate_id,
            doc,
            &candidate.metadata,
            expected,
            candidate.expires.saturating_duration_since(Instant::now()),
        ));
    }
    let Payload::Online(choice) = &candidate.payload else {
        unreachable!()
    };
    providers::lyric_candidate_source(&choice.source)?;
    let ctx = crate::routes::online_ctx(state);
    let doc = network(
        &choice.source,
        providers::lyric(&ctx, &choice.source, &choice.ref_id),
    )
    .await?;
    finish_prepare(state, id, &body.candidate_id, &candidate, choice, doc).await
}

async fn finish_prepare(
    state: &Arc<AppState>,
    id: &str,
    candidate_id: &str,
    candidate: &Candidate,
    choice: &Choice,
    mut doc: LyricDocument,
) -> ApiResult<Value> {
    doc.origin = Some(vmusic_core::LyricOrigin {
        provider: choice.source.clone(),
        label: choice.source_label.clone(),
        ref_id: choice.ref_id.clone(),
        license_status: "not_provided".into(),
    });
    doc.source = LyricSource::Imported;
    let permit = PARSERS.clone().try_acquire_owned().map_err(|_| busy())?;
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        validate_provider_doc(&doc)?;
        let content = serde_json::to_string(&Saved {
            version: 1,
            kind: "hertz-provider-lyrics".into(),
            document: doc.clone(),
        })
        .map_err(|_| internal("歌词文档编码失败"))?;
        if content.len() > SAVED_BYTES {
            return Err(parse_error(vmusic_lyrics::ImportError::Limit));
        }
        Ok::<_, ApiError>((Arc::<str>::from(content), Arc::new(doc)))
    });
    let (content, doc) = tokio::time::timeout(Duration::from_secs(3), work)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::REQUEST_TIMEOUT,
                "lyrics_timeout",
                "歌词检查超时",
            )
        })?
        .map_err(|_| internal("歌词检查工作失败"))??;
    current(state, id, &candidate.metadata, candidate.revision).await?;
    let mut cache = state.lyric_candidates.lock().await;
    let stored = cache.get_mut(candidate_id).ok_or_else(expired)?;
    if stored.expires <= Instant::now() {
        return Err(expired());
    }
    // Concurrent readers may fetch the same candidate. The first checked result
    // wins; a later response cannot silently replace the preview already shown.
    if matches!(stored.payload, Payload::Online(_)) {
        stored.payload = Payload::Ready { content, doc };
    }
    let Payload::Ready { doc, .. } = &stored.payload else {
        unreachable!()
    };
    Ok(preview(
        candidate_id,
        doc,
        &stored.metadata,
        stored.revision,
        stored.expires.saturating_duration_since(Instant::now()),
    ))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    kind: String,
    document: LyricDocument,
}
fn validate_provider_doc(doc: &LyricDocument) -> ApiResult<()> {
    vmusic_lyrics::validate_document(doc).map_err(parse_error)?;
    let words = doc.lines.iter().filter(|l| !l.words.is_empty()).count();
    let precision = if words == 0 {
        "line"
    } else if words == doc.lines.len() {
        "word"
    } else {
        "mixed"
    };
    if !matches!(doc.format.as_deref(), Some("lrc" | "enhanced_lrc" | "ttml"))
        || doc.timing_precision.as_deref() != Some(precision)
    {
        return Err(parse_error(vmusic_lyrics::ImportError::Invalid));
    }
    Ok(())
}
pub(super) fn decode_saved(content: &str) -> ApiResult<LyricDocument> {
    if content.len() > SAVED_BYTES {
        return Err(parse_error(vmusic_lyrics::ImportError::Limit));
    }
    let saved: Saved = serde_json::from_str(content)
        .map_err(|_| parse_error(vmusic_lyrics::ImportError::Invalid))?;
    let doc = saved.document;
    if saved.version != 1
        || saved.kind != "hertz-provider-lyrics"
        || doc.origin.as_ref().is_none_or(|o| {
            [
                (o.provider.as_str(), 32),
                (o.label.as_str(), 256),
                (o.ref_id.as_str(), 256),
            ]
            .into_iter()
            .any(|(s, max)| s.trim().is_empty() || s.len() > max || s.chars().any(char::is_control))
                || o.license_status != "not_provided"
        })
    {
        return Err(parse_error(vmusic_lyrics::ImportError::Invalid));
    }
    validate_provider_doc(&doc)?;
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{anyhow, Result};

    fn checked<T>(result: ApiResult<T>) -> Result<T> {
        result.map_err(|e| anyhow!("{}: {}", e.code, e.message))
    }
    fn track() -> Track {
        serde_json::from_value(json!({"id":"local","path":"absent.wav","source":"local","title":"Olive","artist":"Artist","album":"Album","duration_ms":30000,"bitrate":null,"sample_rate":44100,"channels":1,"has_cover":false,"file_mtime":null,"file_size":null,"added_at":0})).unwrap()
    }
    fn source() -> providers::SourceInfo {
        // Service/storage fixtures have no callable provider, URL or credentials.
        providers::SourceInfo {
            id: "fixture",
            label: "受控来源",
            cats: &[],
            supports_cookie: false,
            login: None,
            caps: &[],
        }
    }
    fn page() -> providers::SearchPage {
        let mut page: providers::SearchPage = serde_json::from_value(json!({"source":"fixture","keyword":"Olive","total":12,"tracks":(0..12).map(|i| json!({"source":"fixture","id":i.to_string(),"title":"Olive","artist":if i==9 {"Artist"} else {"Other"},"album":"Album","duration_ms":30000,"cover":null,"playable":false,"ref":{"private":"must-not-project"}})).collect::<Vec<_>>()})).unwrap();
        page.total_is_exact = true;
        page
    }
    fn complete_page() -> providers::SearchPage {
        let mut page = page();
        page.total = 1;
        page.tracks.truncate(1);
        page.tracks[0].artist = "Artist".into();
        page
    }
    fn apply_body(id: &str, revision: i64) -> Apply {
        Apply {
            candidate_id: id.into(),
            expected_lyrics_revision: revision.to_string(),
            automatic_apply: false,
        }
    }

    fn automatic_apply_body(id: &str, revision: i64) -> Apply {
        Apply {
            automatic_apply: true,
            ..apply_body(id, revision)
        }
    }

    #[test]
    fn automatic_selection_requires_one_complete_unambiguous_strong_match() {
        let track = track();
        let choice = |id: &str, title: &str| Choice {
            source: "fixture".into(),
            source_label: "受控来源".into(),
            ref_id: id.into(),
            title: title.into(),
            artist: "Artist".into(),
            album: "Album".into(),
            duration_ms: 30_000,
            evidence: evidence(&track, title, "Artist", "Album", 30_000),
        };
        let exact = choice("one", "Olive");
        assert_eq!(
            automatic_choice_index(std::slice::from_ref(&exact), true),
            Some(0)
        );
        assert_eq!(
            automatic_choice_index(std::slice::from_ref(&exact), false),
            None
        );
        assert_eq!(
            automatic_choice_index(&[exact.clone(), exact.clone()], true),
            None
        );
        assert_eq!(
            automatic_choice_index(&[exact, choice("live", "Olive (Live)")], true),
            None
        );
    }

    #[test]
    fn automatic_selection_requires_a_provably_complete_page() {
        let complete = complete_page();
        assert!(is_complete_search_page(&complete));

        let mut page = complete.clone();
        page.total_is_exact = false;
        assert!(!is_complete_search_page(&page));

        let mut page = complete.clone();
        page.total += 1;
        assert!(!is_complete_search_page(&page));

        let mut too_many = complete.clone();
        too_many.tracks = self::page().tracks;
        too_many.tracks.truncate(SEARCH_RESULT_CAP + 1);
        too_many.total = too_many.tracks.len();
        assert!(!is_complete_search_page(&too_many));

        let mut page = complete.clone();
        page.warning = Some("partial provider response".into());
        assert!(!is_complete_search_page(&page));

        let mut page = complete;
        page.pagination = Some(providers::SearchPagination {
            next_offset: 1,
            has_more: true,
        });
        assert!(!is_complete_search_page(&page));
    }

    #[tokio::test]
    async fn visible_lyrics_gate_includes_sidecar_lrc() -> Result<()> {
        let dir =
            std::env::temp_dir().join(format!("hertz-sidecar-lyrics-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir)?;
        let mut track = track();
        track.path = dir.join("track.wav").to_string_lossy().into_owned();
        assert!(visible_lyrics_are_empty(&track, true).await);
        std::fs::write(dir.join("track.lrc"), "[00:01.00]sidecar lyric")?;
        assert!(!visible_lyrics_are_empty(&track, true).await);
        assert!(!visible_lyrics_are_empty(&track, false).await);
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[test]
    fn evidence_is_metadata_only_and_never_authorizes_apply() {
        let t = track();
        let exact = evidence(&t, "Olive", "Artist", "Album", 30500);
        assert!(exact.strong_metadata_match);
        assert_eq!(exact.duration_delta_ms, Some(500));
        assert!(!exact.automatic_apply_allowed);
        assert!(variants("Olive").is_empty());
        for (title, artist, album, duration) in [
            ("Olive", "Other", "Album", 30000),
            ("Olive (Live)", "Artist", "Album", 30000),
            ("Olive (cover)", "Artist", "Album", 30000),
            ("Olive remix", "Artist", "Album", 30000),
            ("Olive", "Artist", "", 30000),
            ("Olive", "", "Album", 30000),
            ("Olive", "Artist", "Album", 0),
            ("Olive", "Artist", "Album", 40000),
        ] {
            let e = evidence(&t, title, artist, album, duration);
            assert!(!e.strong_metadata_match);
            assert!(!e.automatic_apply_allowed);
        }
        assert!(evidence(&t, "Olive 现场版", "Artist", "Album", 30000).version_mismatch);
    }

    #[test]
    fn edition_boundary_is_the_registry() {
        let actual: Vec<_> = providers::SOURCES
            .iter()
            .filter(|s| s.caps.contains(&providers::Capability::LyricCandidates))
            .map(|s| s.id)
            .collect();
        #[cfg(feature = "full")]
        assert_eq!(actual, vec!["netease", "qq", "kugou", "kuwo", "migu"]);
        #[cfg(not(feature = "full"))]
        assert!(actual.is_empty());
        for id in actual {
            assert!(providers::lyric_candidate_source(id).is_ok());
            assert!(
                providers::unverified_caps(id).contains(&providers::Capability::LyricCandidates)
            );
        }
        assert!(providers::lyric_candidate_source("podcast").is_err());
        assert!(providers::lyric_candidate_source("fixture").is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn persistent_online_workflow_and_stale_results() -> Result<()> {
        let dir =
            std::env::temp_dir().join(format!("hertz-online-lyrics-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await?;
        let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
        state.token = "online-lyric-test".into();
        let state = Arc::new(state);
        let app = crate::routes::router(state.clone()).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let result = exercise(&state, &base).await;
        server.abort();
        let _ = server.await;
        state.audio.shutdown();
        audio.join().unwrap();
        state.db.close().await;
        drop(state);
        std::fs::remove_dir_all(dir)?;
        result
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn strict_automatic_apply_only_writes_unchanged_empty_lyrics() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("hertz-auto-lyrics-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await?;
        std::fs::create_dir_all(dir.join("media"))?;
        let (state, audio) = crate::state::tests::playback_state_with_db(db).await;
        let state = Arc::new(state);
        let result = async {
            let mut track = track();
            track.path = dir
                .join("media")
                .join("track.wav")
                .to_string_lossy()
                .into_owned();
            vmusic_store::upsert_track(&state.db, &track).await?;
            let fingerprint = checked(metadata(&track))?;
            let (_, baseline) = checked(snapshot(&state, &track.id).await)?;
            let reply = checked(
                publish(
                    &state,
                    &track.id,
                    &track,
                    &fingerprint,
                    baseline.revision,
                    source(),
                    complete_page(),
                    true,
                )
                .await,
            )?;
            assert_eq!(reply["automaticApplyAllowed"], true);
            let candidate_id = reply["candidates"][0]["candidateId"].as_str().unwrap();
            assert_eq!(
                reply["candidates"][0]["evidence"]["automaticApplyAllowed"],
                true
            );
            let pending = state.lyric_candidates.lock().await[candidate_id].clone();
            assert!(pending.automatic_apply_allowed);
            let Payload::Online(choice) = &pending.payload else {
                panic!("online candidate")
            };
            let doc = vmusic_lyrics::parse_import("[00:01.00]受控歌词", "lrc")?;
            checked(finish_prepare(&state, &track.id, candidate_id, &pending, choice, doc).await)?;
            checked(
                super::super::apply(
                    &state,
                    &track.id,
                    automatic_apply_body(candidate_id, baseline.revision),
                )
                .await,
            )?;
            assert!(checked(snapshot(&state, &track.id).await)?
                .1
                .content
                .is_some());

            checked(super::super::clear(&state, &track.id).await)?;
            let (_, baseline) = checked(snapshot(&state, &track.id).await)?;
            let reply = checked(
                publish(
                    &state,
                    &track.id,
                    &track,
                    &fingerprint,
                    baseline.revision,
                    source(),
                    complete_page(),
                    true,
                )
                .await,
            )?;
            let candidate_id = reply["candidates"][0]["candidateId"].as_str().unwrap();
            let pending = state.lyric_candidates.lock().await[candidate_id].clone();
            let Payload::Online(choice) = &pending.payload else {
                panic!("online candidate")
            };
            let doc = vmusic_lyrics::parse_import("[00:01.00]受控歌词", "lrc")?;
            checked(finish_prepare(&state, &track.id, candidate_id, &pending, choice, doc).await)?;
            let sidecar = dir.join("media").join("track.lrc");
            std::fs::write(&sidecar, "[00:01.00]sidecar lyric")?;
            assert_eq!(
                super::super::apply(
                    &state,
                    &track.id,
                    automatic_apply_body(candidate_id, baseline.revision),
                )
                .await
                .unwrap_err()
                .code,
                "lyrics_conflict"
            );
            std::fs::remove_file(sidecar)?;
            let user_content = "[00:02.00]用户修改";
            vmusic_store::lyrics::import(&state.db, &track.id, user_content).await?;
            assert_eq!(
                super::super::apply(
                    &state,
                    &track.id,
                    automatic_apply_body(candidate_id, baseline.revision),
                )
                .await
                .unwrap_err()
                .code,
                "lyrics_conflict"
            );
            assert_eq!(
                checked(snapshot(&state, &track.id).await)?
                    .1
                    .content
                    .as_deref(),
                Some(user_content)
            );
            Ok::<_, anyhow::Error>(())
        }
        .await;
        state.audio.shutdown();
        audio.join().unwrap();
        state.db.close().await;
        drop(state);
        std::fs::remove_dir_all(dir)?;
        result
    }

    async fn exercise(state: &Arc<AppState>, base: &str) -> Result<()> {
        let mut t = track();
        vmusic_store::upsert_track(&state.db, &t).await?;
        checked(super::super::set_offset(state, &t.id, 250).await)?;
        let fingerprint = checked(metadata(&t))?;
        let (_, baseline) = snapshot(state, &t.id)
            .await
            .map_err(|e| anyhow!(e.message))?;
        let initial = baseline.revision;
        let http = reqwest::Client::builder().no_proxy().build()?;
        let search_url = format!("{base}/v1/tracks/local/lyrics/candidates/search");
        let search_body = json!({"source":"podcast","expectedMetadataRevision":fingerprint,"expectedLyricsRevision":initial.to_string()});
        assert_eq!(
            http.post(&search_url)
                .json(&search_body)
                .send()
                .await?
                .status(),
            401
        );
        let unsupported = http
            .post(&search_url)
            .bearer_auth(&state.token)
            .json(&search_body)
            .send()
            .await?;
        assert!(!unsupported.status().is_success());
        let unsupported: Value = unsupported.json().await?;
        assert_eq!(unsupported["error"]["code"], "capability_unsupported");
        let mut wrong = page();
        wrong.source = "wrong".into();
        assert!(publish(
            state,
            &t.id,
            &t,
            &fingerprint,
            initial,
            source(),
            wrong,
            false
        )
        .await
        .is_err());
        let mut p = page();
        p.tracks[1].id = "0".into();
        p.tracks[2].source = "wrong".into();
        let reply =
            checked(publish(state, &t.id, &t, &fingerprint, initial, source(), p, false).await)?;
        assert_eq!(reply["candidates"].as_array().unwrap().len(), 3);
        assert_eq!(reply["candidates"][0]["refId"], "9");
        assert!(!reply.to_string().contains("must-not-project"));
        let cid = reply["candidates"][0]["candidateId"].as_str().unwrap();
        assert_eq!(
            super::super::apply(state, &t.id, apply_body(cid, initial))
                .await
                .unwrap_err()
                .code,
            "lyrics_not_prepared"
        );
        assert_eq!(
            prepare(state, "other", apply_body(cid, initial))
                .await
                .unwrap_err()
                .code,
            "lyrics_conflict"
        );
        let pending = state.lyric_candidates.lock().await[cid].clone();
        let Payload::Online(choice) = &pending.payload else {
            panic!("pending candidate")
        };
        let mut doc=vmusic_lyrics::parse_import("<tt xmlns=\"http://www.w3.org/ns/ttml\"><body><div><p begin=\"1s\" end=\"3s\"><span begin=\"0s\" end=\"1s\">原词</span></p></div></body></tt>","ttml")?;
        doc.offset_ms = 100;
        doc.translation = Some(vec!["Translation".into()]);
        doc.romanization = Some(vec!["yuán cí".into()]);
        let ready =
            checked(finish_prepare(state, &t.id, cid, &pending, choice, doc.clone()).await)?;
        let mut late = doc.clone();
        late.lines[0].text = "later response must not replace preview".into();
        assert_eq!(
            checked(finish_prepare(state, &t.id, cid, &pending, choice, late).await)?["preview"],
            ready["preview"]
        );
        assert_eq!(
            vmusic_store::lyrics::snapshot(&state.db, &t.id)
                .await?
                .revision,
            initial
        );
        // HTTP/RPC share the same ready candidate; neither read prepares a write.
        let rpc = crate::rpc::Rpc::new(state.clone());
        let rpc_path = format!("v1/tracks/{}/lyrics/candidates/prepare-online", t.id);
        let via_rpc = checked(
            rpc.call(crate::rpc::Call {
                op: crate::rpc::Op::Post,
                path: &rpc_path,
                query: json!({}),
                body: json!({"candidateId":cid,"expectedLyricsRevision":initial.to_string()}),
                raw: None,
                client_operation_id: None,
            })
            .await,
        )?;
        assert_eq!(via_rpc.body["origin"]["provider"], "fixture");
        let via_http: Value = http
            .post(format!("{base}/{rpc_path}"))
            .bearer_auth(&state.token)
            .json(&json!({"candidateId":cid,"expectedLyricsRevision":initial.to_string()}))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        assert_eq!(via_http["origin"], via_rpc.body["origin"]);
        assert_eq!(via_http["preview"], via_rpc.body["preview"]);
        checked(super::super::apply(state, &t.id, apply_body(cid, initial)).await)?;
        let saved = vmusic_store::lyrics::get(&state.db, &t.id).await?.unwrap();
        let decoded = checked(decode_saved(&saved.content))?;
        assert_eq!(decoded.lines[0].words[0].end_ms, Some(2000));
        assert_eq!(decoded.translation, doc.translation);
        assert_eq!(decoded.romanization, doc.romanization);
        assert_eq!(decoded.offset_ms, 100);
        assert_eq!(decoded.origin.as_ref().unwrap().ref_id, "9");
        let read = checked(super::super::read(state, &t.id).await)?;
        assert_eq!(read["lines"][0]["start_ms"], 1350);
        assert_eq!(read["user_offset_ms"], 250);
        let mut malformed: Value = serde_json::from_str(&saved.content)?;
        for (field, value) in [
            ("provider", ""),
            ("label", "bad\nlabel"),
            ("licenseStatus", "licensed"),
        ] {
            malformed["document"]["origin"][field] = json!(value);
            assert!(decode_saved(&malformed.to_string()).is_err());
            malformed = serde_json::from_str(&saved.content)?;
        }
        malformed["document"]["timing_precision"] = json!("line");
        assert!(decode_saved(&malformed.to_string()).is_err());
        assert!(decode_saved(&"x".repeat(SAVED_BYTES + 1)).is_err());
        let (_, baseline) = checked(snapshot(state, &t.id).await)?;
        let reply = checked(
            publish(
                state,
                &t.id,
                &t,
                &fingerprint,
                baseline.revision,
                source(),
                page(),
                false,
            )
            .await,
        )?;
        let cid = reply["candidates"][0]["candidateId"].as_str().unwrap();
        let pending = state.lyric_candidates.lock().await[cid].clone();
        let Payload::Online(choice) = &pending.payload else {
            panic!("pending candidate")
        };
        // Metadata edited during provider wait cannot become a ready preview.
        t.title = "Edited".into();
        vmusic_store::upsert_track(&state.db, &t).await?;
        assert_eq!(
            finish_prepare(state, &t.id, cid, &pending, choice, doc.clone())
                .await
                .unwrap_err()
                .code,
            "lyrics_conflict"
        );
        t.title = "Olive".into();
        vmusic_store::upsert_track(&state.db, &t).await?;
        checked(super::super::clear(state, &t.id).await)?;
        assert_eq!(
            finish_prepare(state, &t.id, cid, &pending, choice, doc.clone())
                .await
                .unwrap_err()
                .code,
            "lyrics_conflict"
        );
        let (_, baseline) = checked(snapshot(state, &t.id).await)?;
        let reply = checked(
            publish(
                state,
                &t.id,
                &t,
                &fingerprint,
                baseline.revision,
                source(),
                page(),
                false,
            )
            .await,
        )?;
        let cid = reply["candidates"][0]["candidateId"].as_str().unwrap();
        let pending = state.lyric_candidates.lock().await[cid].clone();
        let Payload::Online(choice) = &pending.payload else {
            panic!("pending candidate")
        };
        state
            .lyric_candidates
            .lock()
            .await
            .get_mut(cid)
            .unwrap()
            .expires = Instant::now();
        assert_eq!(
            finish_prepare(state, &t.id, cid, &pending, choice, doc)
                .await
                .unwrap_err()
                .code,
            "lyrics_candidate_expired"
        );
        assert_eq!(
            prepare(state, &t.id, apply_body(cid, baseline.revision))
                .await
                .unwrap_err()
                .code,
            "lyrics_candidate_expired"
        );
        assert!(!checked(super::super::read(state, &t.id).await)?
            .to_string()
            .contains("原词"));
        Ok(())
    }

    #[tokio::test]
    async fn network_slots_are_not_queued_and_release_on_cancel_and_deadline() {
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let (tx, rx) = tokio::sync::oneshot::channel();
            tasks.push(tokio::spawn(network("fixture", async move {
                let _ = tx.send(());
                std::future::pending::<ApiResult<()>>().await
            })));
            rx.await.unwrap();
        }
        assert_eq!(
            network("fixture", async { Ok(()) }).await.unwrap_err().code,
            "lyrics_busy"
        );
        for task in tasks {
            task.abort();
            let _ = task.await;
        }
        assert!(network("fixture", async { Ok(()) }).await.is_ok());
        assert_eq!(
            network("fixture", std::future::pending::<ApiResult<()>>())
                .await
                .unwrap_err()
                .code,
            "lyrics_timeout"
        );
        assert!(network("fixture", async { Ok(()) }).await.is_ok());
    }
}
