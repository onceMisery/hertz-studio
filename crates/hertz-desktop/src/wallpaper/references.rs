// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Bounded, human-readable deletion blockers (desktop-wallpaper.md §14).
//! Request identities are validated by callers; truncation here only affects
//! diagnostics and never changes the predicates protecting stored references.

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::jobs::JobError;
use super::library::Library;

pub(crate) const LIMIT: usize = 32;
// Leave ample room in the 64 KiB management envelope for errors and revisions.
const REPORT_BYTES: usize = 24 * 1024;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Reference {
    kind: String,
    id: String,
    label: String,
    detail: String,
    #[serde(skip)]
    identity: [u8; 32],
    #[serde(skip)]
    shortened: bool,
}

impl Reference {
    pub(crate) fn new(kind: &str, id: &str, label: &str, detail: &str) -> Self {
        // Retain the original identity without retaining unbounded input. Two
        // IDs sharing a truncated display prefix must remain distinct blockers.
        let mut identity = Sha256::new();
        identity.update((kind.len() as u64).to_le_bytes());
        identity.update(kind.as_bytes());
        identity.update(id.as_bytes());
        let identity: [u8; 32] = identity.finalize().into();
        let mut shortened = false;
        let mut display_id = bounded(id, 256, &mut shortened);
        if shortened {
            // The displayed identity also stays stable when its prefix alone
            // would be ambiguous to a consumer using (kind, id) as a row key.
            display_id = id.chars().take(239).collect();
            display_id.push('~');
            for byte in &identity[..8] {
                display_id.push_str(&format!("{byte:02x}"));
            }
        }
        Self {
            kind: bounded(kind, 32, &mut shortened),
            id: display_id,
            label: bounded(label, 160, &mut shortened),
            detail: bounded(detail, 512, &mut shortened),
            identity,
            shortened,
        }
    }

    fn fit_bytes(&mut self, bytes: usize) -> bool {
        let mut size = json_size(self);
        // Keep identity text intact within its character bound. The diagnostic
        // detail yields space first, followed by the human-readable label.
        while size > bytes {
            let removed = self.detail.pop().or_else(|| self.label.pop());
            let Some(removed) = removed else {
                return false;
            };
            self.shortened = true;
            // A one-character string has two surrounding JSON quotes.
            size -= json_size(&removed.to_string()) - 2;
        }
        true
    }
}

fn bounded(text: &str, limit: usize, shortened: &mut bool) -> String {
    let end = text.char_indices().nth(limit).map(|(index, _)| index);
    if let Some(end) = end {
        *shortened = true;
        text[..end].to_owned()
    } else {
        text.to_owned()
    }
}

fn json_size(value: &impl Serialize) -> usize {
    // Only strings, booleans, integers and their containers reach this helper.
    serde_json::to_vec(value)
        .expect("reference diagnostics are JSON values")
        .len()
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Report {
    references: Vec<Reference>,
    limit: usize,
    truncated: bool,
}

impl Default for Report {
    fn default() -> Self {
        Self {
            references: Vec::new(),
            limit: LIMIT,
            truncated: false,
        }
    }
}

impl Report {
    pub(crate) fn push(&mut self, kind: &str, id: &str, label: &str, detail: &str) {
        self.push_reference(Reference::new(kind, id, label, detail));
    }

    fn push_reference(&mut self, mut reference: Reference) {
        if self
            .references
            .iter()
            .any(|existing| existing.identity == reference.identity)
        {
            return;
        }
        self.truncated |= reference.shortened;
        if self.references.len() == LIMIT {
            self.truncated = true;
            return;
        }
        let available = REPORT_BYTES
            .saturating_sub(json_size(self))
            .saturating_sub(usize::from(!self.references.is_empty()));
        if !reference.fit_bytes(available) {
            self.truncated = true;
            return;
        }
        self.truncated |= reference.shortened;
        self.references.push(reference);
    }

    pub(crate) fn extend(&mut self, other: Self) {
        self.truncated |= other.truncated;
        for reference in other.references {
            self.push_reference(reference);
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.references.is_empty()
    }

    pub(crate) fn in_use_error(self) -> JobError {
        JobError::new(
            "asset_in_use",
            "作品或版本仍被引用，请先解除列出的引用后重试",
        )
        .with_details(serde_json::to_value(self).expect("reference report is JSON"))
    }
}

/// Read the three persistent owners in one snapshot. The caller validates work
/// and version membership, and holds the content writer when deleting.
pub(crate) async fn stored(
    library: &Library,
    work_key: &str,
    package_hash: Option<&str>,
) -> Result<Report, JobError> {
    let mut tx = library.pool().begin().await.map_err(database)?;
    let mut report = Report::default();

    // EXISTS collapses repeated positions to one playlist. Whole-work deletion
    // checks the work; version deletion checks the hash, including shared bytes.
    let playlists: Vec<(String, String)> = sqlx::query_as(
        "SELECT p.playlist_id, p.title FROM playlists p
         WHERE EXISTS(SELECT 1 FROM playlist_items i WHERE i.playlist_id=p.playlist_id
           AND ((?2 IS NULL AND i.work_key=?1) OR (?2 IS NOT NULL AND i.package_hash=?2)))
         ORDER BY p.playlist_id LIMIT 33",
    )
    .bind(work_key)
    .bind(package_hash)
    .fetch_all(&mut *tx)
    .await
    .map_err(database)?;
    for (id, title) in playlists {
        report.push("playlist", &id, &title, "轮播列表包含此作品或固定版本");
    }

    // All native drafts count, including unsaved drafts with no package yet.
    // Extract a bounded title rather than loading a potentially 1 MiB document.
    let drafts: Vec<(String, String)> = sqlx::query_as(
        "SELECT draft_id, COALESCE(substr(CASE WHEN json_valid(document_json)
           THEN CAST(json_extract(document_json,'$.title') AS TEXT) END,1,161),'作品草稿')
         FROM drafts WHERE work_key=?1
           AND (?2 IS NULL OR base_package_hash=?2 OR published_package_hash=?2)
         ORDER BY draft_id LIMIT 33",
    )
    .bind(work_key)
    .bind(package_hash)
    .fetch_all(&mut *tx)
    .await
    .map_err(database)?;
    for (id, title) in drafts {
        report.push("workDraft", &id, &title, "作品草稿保留此作品或版本");
    }

    let publications: Vec<(String, String)> = sqlx::query_as(
        "SELECT p.draft_id, COALESCE(substr(CASE WHEN json_valid(d.document_json)
           THEN CAST(json_extract(d.document_json,'$.title') AS TEXT) END,1,161),'作品草稿')
         FROM draft_publications p JOIN drafts d ON d.draft_id=p.draft_id
         WHERE p.work_key=?1 AND (?2 IS NULL OR p.package_hash=?2)
         ORDER BY p.draft_id LIMIT 33",
    )
    .bind(work_key)
    .bind(package_hash)
    .fetch_all(&mut *tx)
    .await
    .map_err(database)?;
    for (id, title) in publications {
        report.push("publication", &id, &title, "作品版本正在生成或等待提交");
    }

    tx.commit().await.map_err(database)?;
    Ok(report)
}

fn database(error: sqlx::Error) -> JobError {
    JobError::database(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::library::{tempfileish, InstallWork, LOCAL_SOURCE};
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn report_has_frozen_shape_and_deduplicates_identity_when_merging() {
        let mut report = Report::default();
        assert!(report.is_empty());
        report.push("desktop", "group-a", "主屏", "当前运行");
        let mut other = Report::default();
        other.push("desktop", "group-a", "changed label", "same identity");
        other.push("preparing", "group-a", "主屏", "正在准备");
        report.extend(other.clone());
        report.extend(other);
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            json!({"references":[
                {"kind":"desktop","id":"group-a","label":"主屏","detail":"当前运行"},
                {"kind":"preparing","id":"group-a","label":"主屏","detail":"正在准备"}
            ],"limit":32,"truncated":false})
        );
        let receipt =
            super::super::api::response(Some("reference-test"), Err(report.in_use_error()), None);
        assert_eq!(receipt["error"]["code"], "asset_in_use");
        assert_eq!(
            receipt["error"]["details"]["references"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(JobError::invalid_input("bad request").details.is_none());
    }

    #[test]
    fn count_bound_only_marks_an_omitted_distinct_reference() {
        let mut report = Report::default();
        for index in 0..LIMIT {
            report.push("desktop", &format!("group-{index}"), "screen", "running");
        }
        report.push("desktop", "group-0", "other label", "same identity");
        assert_eq!(report.references.len(), LIMIT);
        assert!(!report.truncated);
        report.push("desktop", "group-32", "screen", "running");
        assert_eq!(report.references.len(), LIMIT);
        assert!(report.truncated);
        let mut merged = Report::default();
        merged.extend(report);
        assert!(merged.truncated);
    }

    #[test]
    fn unicode_fields_and_escaped_json_fit_the_management_response() {
        let item = Reference::new(
            &"界".repeat(33),
            &"🌊".repeat(257),
            &"海".repeat(161),
            &"潮".repeat(513),
        );
        assert_eq!(item.kind.chars().count(), 32);
        assert_eq!(item.id.chars().count(), 256);
        assert_eq!(item.label.chars().count(), 160);
        assert_eq!(item.detail.chars().count(), 512);
        assert!(item.shortened);

        for character in ['🌊', '\0', '\"', '\\'] {
            let text = character.to_string();
            let mut report = Report::default();
            for index in 0..64 {
                report.push(
                    "settingsDraft",
                    &format!("{index}{}", text.repeat(256)),
                    &text.repeat(161),
                    &text.repeat(513),
                );
            }
            assert!(!report.is_empty());
            assert!(report.references.len() <= LIMIT);
            assert!(report.truncated);
            assert!(json_size(&report) <= REPORT_BYTES);
            let receipt = super::super::api::response(
                Some("reference-test"),
                Err(report.in_use_error()),
                None,
            );
            assert!(hertz_desktop_ipc::frame::serialize_bounded(
                &receipt,
                hertz_desktop_ipc::management::RESPONSE_LIMIT,
            )
            .is_ok());
        }
    }

    #[test]
    fn displayed_id_truncation_does_not_merge_distinct_owners() {
        let prefix = "🌊".repeat(256);
        let mut first = Report::default();
        first.push("workDraft", &format!("{prefix}a"), "first", "");
        let mut second = Report::default();
        second.push("workDraft", &format!("{prefix}b"), "second", "");
        second.push("workDraft", &format!("{prefix}a"), "duplicate", "");
        first.extend(second);
        assert_eq!(first.references.len(), 2);
        assert_ne!(first.references[0].id, first.references[1].id);
        assert!(first.truncated);
    }

    async fn install(library: &Library, work_key: &str, version: u32, hash: &str) {
        library
            .install(&InstallWork {
                remote_work_id: work_key.into(),
                work_key: work_key.into(),
                title: work_key.into(),
                description: String::new(),
                kind: "builtin".into(),
                package_hash: hash.into(),
                manifest_json: "{}".into(),
                package_bytes: 1,
                version,
                source_id: LOCAL_SOURCE.into(),
            })
            .await
            .unwrap();
    }

    async fn playlist(
        library: &Library,
        id: &str,
        work: &str,
        version: u32,
        hash: &str,
        copies: u32,
    ) {
        sqlx::query("INSERT INTO playlists(playlist_id,revision,title,mode,interval_seconds,updated_at) VALUES(?1,1,?1,'sequential',10,0)")
            .bind(id).execute(library.pool()).await.unwrap();
        for position in 0..copies {
            sqlx::query("INSERT INTO playlist_items(playlist_id,position,work_key,package_hash,version_key) VALUES(?1,?2,?3,?4,?5)")
                .bind(id).bind(i64::from(position)).bind(work).bind(hash).bind(format!("{work}@{version}"))
                .execute(library.pool()).await.unwrap();
        }
    }

    async fn draft(
        library: &Library,
        id: &str,
        work: &str,
        base: Option<&str>,
        published: Option<&str>,
        saved: bool,
    ) {
        let document = json!({"title":format!("Title {id}")}).to_string();
        sqlx::query("INSERT INTO drafts(draft_id,work_key,work_id,revision,document_json,committed_revision,committed_document_json,base_package_hash,published_revision,published_version,published_package_hash,created_at,updated_at) VALUES(?1,?2,?2,1,?3,?4,?5,?6,?7,?7,?8,0,0)")
            .bind(id).bind(work).bind(&document)
            .bind(saved.then_some(1_i64)).bind(saved.then_some(document.as_str()))
            .bind(base).bind(published.map(|_| 1_i64)).bind(published)
            .execute(library.pool()).await.unwrap();
    }

    async fn publication(library: &Library, draft: &str, work: &str, hash: &str) {
        sqlx::query("INSERT INTO draft_publications(draft_id,draft_revision,work_key,work_id,version,package_hash,manifest_json,package_bytes,created_at) VALUES(?1,1,?2,?2,3,?3,'{}',1,0)")
            .bind(draft).bind(work).bind(hash).execute(library.pool()).await.unwrap();
    }

    fn identities(report: &Report) -> Vec<(&str, &str)> {
        report
            .references
            .iter()
            .map(|item| (item.kind.as_str(), item.id.as_str()))
            .collect()
    }

    #[tokio::test]
    async fn stored_preserves_work_hash_and_native_draft_protections() {
        let root = tempfileish::temp_dir("reference-protections");
        let library = Library::open(root.path()).await.unwrap();
        let base = "a".repeat(64);
        let published = "b".repeat(64);
        let pending = "c".repeat(64);
        install(&library, "work-a", 1, &base).await;
        install(&library, "work-a", 2, &published).await;
        install(&library, "work-b", 1, &base).await;
        playlist(&library, "playlist-a", "work-a", 2, &published, 2).await;
        playlist(&library, "playlist-b", "work-b", 1, &base, 2).await;
        draft(
            &library,
            "draft-a",
            "work-a",
            Some(&base),
            Some(&published),
            true,
        )
        .await;
        draft(&library, "draft-b", "work-b", Some(&base), None, true).await;
        draft(&library, "draft-unsaved", "work-a", None, None, false).await;
        draft(&library, "draft-new", "new-work", None, None, false).await;
        publication(&library, "draft-a", "work-a", &pending).await;
        publication(&library, "draft-b", "work-b", &pending).await;

        let whole = stored(&library, "work-a", None).await.unwrap();
        assert_eq!(
            identities(&whole),
            vec![
                ("playlist", "playlist-a"),
                ("workDraft", "draft-a"),
                ("workDraft", "draft-unsaved"),
                ("publication", "draft-a"),
            ]
        );
        assert_eq!(whole.references[1].label, "Title draft-a");
        assert!(!whole.truncated);
        let base_report = stored(&library, "work-a", Some(&base)).await.unwrap();
        assert_eq!(
            identities(&base_report),
            vec![("playlist", "playlist-b"), ("workDraft", "draft-a")]
        );
        let published_report = stored(&library, "work-a", Some(&published)).await.unwrap();
        assert_eq!(
            identities(&published_report),
            vec![("playlist", "playlist-a"), ("workDraft", "draft-a")]
        );
        let pending_report = stored(&library, "work-a", Some(&pending)).await.unwrap();
        assert_eq!(
            identities(&pending_report),
            vec![("publication", "draft-a")]
        );
        assert_eq!(pending_report.references[0].label, "Title draft-a");
        let new_work = stored(&library, "new-work", None).await.unwrap();
        assert_eq!(identities(&new_work), vec![("workDraft", "draft-new")]);
        let unpublished_version = stored(&library, "new-work", Some(&base)).await.unwrap();
        assert_eq!(
            identities(&unpublished_version),
            vec![("playlist", "playlist-b")]
        );
        assert!(stored(&library, "work-a", Some(&"d".repeat(64)))
            .await
            .unwrap()
            .is_empty());
        library.pool().close().await;
    }

    #[tokio::test]
    async fn stored_counts_playlist_owners_not_positions_and_bounds_rows() {
        let root = tempfileish::temp_dir("reference-pagination");
        let library = Library::open(root.path()).await.unwrap();
        let hash = "a".repeat(64);
        install(&library, "work-a", 1, &hash).await;
        playlist(&library, "playlist-00", "work-a", 1, &hash, 32).await;
        let single = stored(&library, "work-a", None).await.unwrap();
        assert_eq!(single.references.len(), 1);
        assert!(!single.truncated);
        for index in (1..32).rev() {
            playlist(
                &library,
                &format!("playlist-{index:02}"),
                "work-a",
                1,
                &hash,
                1,
            )
            .await;
        }
        let exact = stored(&library, "work-a", None).await.unwrap();
        assert_eq!(exact.references.len(), 32);
        assert!(!exact.truncated);
        playlist(&library, "playlist-32", "work-a", 1, &hash, 1).await;
        let overflow = stored(&library, "work-a", None).await.unwrap();
        assert_eq!(overflow.references.len(), 32);
        assert!(overflow.truncated);
        assert_eq!(overflow.references.first().unwrap().id, "playlist-00");
        assert_eq!(overflow.references.last().unwrap().id, "playlist-31");
        let receipt: Value =
            super::super::api::response(Some("stored-limit"), Err(overflow.in_use_error()), None);
        assert_eq!(receipt["error"]["details"]["limit"], 32);
        assert!(json_size(&receipt) < 64 * 1024);
        library.pool().close().await;
    }
}
