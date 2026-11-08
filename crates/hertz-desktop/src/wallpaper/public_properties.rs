use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::{
    config::Selection,
    jobs::{ImportJobs, JobError},
    playlist::FixedVersion,
};

type Result<T> = std::result::Result<T, JobError>;

pub(crate) fn property_error(error: hertz_wallpaper::PackageError) -> JobError {
    JobError::new(error.code, error.message)
}

#[derive(Clone)]
pub(crate) struct PropertySelection {
    pub selection: Selection,
    pub properties: Map<String, Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PropertyPage {
    pub properties: Vec<Map<String, Value>>,
    pub snapshot: String,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    snapshot: String,
    after: String,
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(JobError::new("cancelled", "公开属性核验已取消"))
    } else {
        Ok(())
    }
}

async fn references(
    jobs: &ImportJobs,
    selection: &Selection,
) -> Result<(Vec<FixedVersion>, Option<u64>)> {
    match selection {
        Selection::Package {
            work_key,
            package_hash,
        } => Ok((
            vec![FixedVersion {
                work_key: work_key.clone(),
                package_hash: package_hash.clone(),
            }],
            None,
        )),
        Selection::Playlist { playlist_id } => {
            let playlist = super::playlist::Repository::new(jobs.library())
                .get(playlist_id)
                .await?;
            Ok((playlist.items, Some(playlist.revision)))
        }
        _ => Ok((vec![], None)),
    }
}

pub(crate) async fn validate_selections(
    jobs: &ImportJobs,
    selections: &[PropertySelection],
    cancel: &AtomicBool,
) -> Result<()> {
    for selection in selections {
        cancelled(cancel)?;
        let (references, _) = references(jobs, &selection.selection).await?;
        if references.is_empty() {
            if !selection.properties.is_empty() {
                return Err(JobError::invalid_input(
                    "仅作品版本或轮播列表支持公开属性覆盖",
                ));
            }
        } else {
            validate_references(jobs, &references, &selection.properties, cancel).await?;
        }
    }
    cancelled(cancel)
}

pub(crate) async fn validate_references(
    jobs: &ImportJobs,
    references: &[FixedVersion],
    properties: &Map<String, Value>,
    cancel: &AtomicBool,
) -> Result<()> {
    if references.is_empty() || references.len() > 32 || properties.len() > 64 {
        return Err(JobError::invalid_input("公开属性核验数量超出上限"));
    }
    let mut seen = HashSet::new();
    for reference in references {
        cancelled(cancel)?;
        if !seen.insert((&reference.work_key, &reference.package_hash)) {
            continue;
        }
        jobs.library()
            .cover_manifest(&reference.work_key, &reference.package_hash)
            .await?;
        if jobs
            .assets()
            .verify_installed(&reference.package_hash)?
            .is_none()
        {
            return Err(JobError::new(
                "asset_unavailable",
                "公开属性所属作品原包缺失或损坏",
            ));
        }
        let package = jobs
            .assets()
            .read_installed_manifest(&reference.package_hash)?;
        if matches!(
            package.manifest.content,
            hertz_wallpaper::Content::Composition { .. }
        ) {
            super::composition_plan::validate_public_properties(
                jobs.assets(),
                &package,
                properties,
            )?;
        } else {
            hertz_wallpaper::properties::effective_content(&package.manifest, properties)
                .map_err(property_error)?;
        }
    }
    cancelled(cancel)
}

pub(crate) async fn inspect(
    jobs: &ImportJobs,
    selection: &Selection,
    cursor: Option<&str>,
    limit: u32,
) -> Result<PropertyPage> {
    let (references, revision) = references(jobs, selection).await?;
    let mut shared: Option<BTreeMap<String, Map<String, Value>>> = None;
    let mut identity = Sha256::new();
    identity.update(
        serde_json::to_vec(&(selection, &references, revision))
            .map_err(|error| JobError::invalid_input(error.to_string()))?,
    );
    let mut seen = HashSet::new();
    for reference in &references {
        if !seen.insert((&reference.work_key, &reference.package_hash)) {
            continue;
        }
        if !jobs
            .library()
            .contains_version(&reference.work_key, &reference.package_hash)
            .await?
        {
            return Err(JobError::new(
                "version_not_found",
                "公开属性所属版本尚未安装或不可用",
            ));
        }
        let manifest = jobs
            .library()
            .cover_manifest(&reference.work_key, &reference.package_hash)
            .await?;
        let descriptors =
            hertz_wallpaper::properties::validate_properties(&manifest).map_err(property_error)?;
        let current = descriptors
            .into_iter()
            .map(|descriptor| {
                let value = descriptor.to_map()?;
                Ok((
                    value["id"]
                        .as_str()
                        .expect("validated property id")
                        .to_owned(),
                    value,
                ))
            })
            .collect::<hertz_wallpaper::Result<BTreeMap<_, _>>>()?;
        identity.update(
            serde_json::to_vec(&current)
                .map_err(|error| JobError::invalid_input(error.to_string()))?,
        );
        match &mut shared {
            None => shared = Some(current),
            Some(shared) => shared.retain(|id, property| current.get(id) == Some(property)),
        }
    }
    let snapshot = format!("{:x}", identity.finalize());
    let shared = shared.unwrap_or_default();
    let after = cursor
        .map(|encoded| -> Result<String> {
            let cursor: Cursor = serde_json::from_str(encoded)
                .map_err(|_| JobError::invalid_input("公开属性分页游标无效"))?;
            if cursor.snapshot != snapshot {
                return Err(JobError::new(
                    "properties_changed",
                    "作品或轮播列表已变化，请重新读取公开属性",
                ));
            }
            if !shared.contains_key(&cursor.after) {
                return Err(JobError::invalid_input("公开属性游标不属于当前结果"));
            }
            Ok(cursor.after)
        })
        .transpose()?;
    let mut page = PropertyPage {
        properties: vec![],
        snapshot: snapshot.clone(),
        next_cursor: None,
    };
    for (id, property) in shared {
        if after.as_ref().is_some_and(|after| &id <= after) {
            continue;
        }
        page.properties.push(property);
        let encoded = serde_json::to_vec(&page)
            .map_err(|error| JobError::invalid_input(error.to_string()))?;
        if page.properties.len() > limit.clamp(1, 32) as usize || encoded.len() > 12 * 1024 - 512 {
            page.properties.pop();
            let previous = page
                .properties
                .last()
                .ok_or_else(|| JobError::invalid_input("单个公开属性超过分页上限"))?;
            page.next_cursor = Some(
                serde_json::to_string(&Cursor {
                    snapshot: snapshot.clone(),
                    after: previous["id"].as_str().expect("property id").to_owned(),
                })
                .expect("property cursor"),
            );
            break;
        }
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::{
        assets::AssetStore,
        decode_probe::ProbeClient,
        image_prepare::{ImageFit, ImagePurpose, ImageTarget},
        library::{tempfileish, Library},
        playlist::{Mode, Repository},
        selection_plan::{self, ResolvedSelection, SelectionOptions},
        work_drafts::{Document, WorkDrafts},
    };
    use serde_json::json;
    use std::sync::Arc;

    async fn publish(jobs: &ImportJobs, title: &str, exposed: bool) -> FixedVersion {
        let properties = if exposed {
            vec![
                hertz_wallpaper::properties::builtin_property(
                    "coast",
                    1,
                    "tod",
                    "daylight",
                    "日照",
                    json!(0.6),
                )
                .unwrap(),
                hertz_wallpaper::properties::builtin_property(
                    "coast",
                    1,
                    "discRing",
                    "disc-ring",
                    "环绕频谱",
                    json!(true),
                )
                .unwrap(),
            ]
        } else {
            vec![]
        };
        let drafts = WorkDrafts::new(jobs.library());
        let draft = drafts
            .create(Document {
                title: title.into(),
                description: String::new(),
                scene_id: "coast".into(),
                state_version: 1,
                params: Map::new(),
                properties,
            })
            .await
            .unwrap();
        drafts.save(&draft.id, draft.revision).await.unwrap();
        let published = drafts
            .publish(&draft.id, draft.revision, jobs.assets())
            .await
            .unwrap();
        FixedVersion {
            work_key: published.work_key,
            package_hash: published.package_hash,
        }
    }

    async fn jobs(root: &std::path::Path) -> Arc<ImportJobs> {
        Arc::new(ImportJobs::start(
            Library::open(root).await.unwrap(),
            AssetStore::new(root).unwrap(),
            ProbeClient::testing(|_, _| panic!("builtin properties never need a decoder")),
        ))
    }

    #[tokio::test]
    async fn inspection_pages_bind_full_playlist_snapshot_and_hide_unshared_definitions() {
        let root = tempfileish::temp_dir("public-properties-pages");
        let jobs = jobs(root.path()).await;
        let first = publish(&jobs, "已公开", true).await;
        let second = publish(&jobs, "未公开", false).await;
        let repository = Repository::new(jobs.library());
        let list = repository
            .save(
                None,
                None,
                "公开属性分页".into(),
                Mode::Sequential,
                10,
                vec![first.clone(), first.clone()],
            )
            .await
            .unwrap();
        let selection = Selection::Playlist {
            playlist_id: list.playlist_id.clone(),
        };
        let page = inspect(&jobs, &selection, None, 1).await.unwrap();
        assert_eq!(page.properties.len(), 1);
        assert!(serde_json::to_vec(&page).unwrap().len() < 12 * 1024);
        let tail = inspect(&jobs, &selection, page.next_cursor.as_deref(), 1)
            .await
            .unwrap();
        assert_eq!(tail.properties.len(), 1);
        assert_ne!(page.properties[0]["id"], tail.properties[0]["id"]);
        assert!(tail.next_cursor.is_none());
        repository
            .save(
                Some(&list.playlist_id),
                Some(1),
                list.title,
                Mode::Sequential,
                10,
                vec![first, second],
            )
            .await
            .unwrap();
        let stale = inspect(&jobs, &selection, page.next_cursor.as_deref(), 1)
            .await
            .err()
            .unwrap();
        assert_eq!(stale.code, "properties_changed");
        assert!(inspect(&jobs, &selection, None, 32)
            .await
            .unwrap()
            .properties
            .is_empty());
        jobs.library().pool().close().await;
    }

    #[tokio::test]
    async fn whole_list_validation_rejects_later_incompatible_item_and_observes_cancel() {
        let root = tempfileish::temp_dir("public-properties-preflight");
        let jobs = jobs(root.path()).await;
        let first = publish(&jobs, "支持日照", true).await;
        let second = publish(&jobs, "没有日照覆盖", false).await;
        let values = json!({"daylight":0.25}).as_object().unwrap().clone();
        validate_references(
            &jobs,
            &[first.clone(), first.clone()],
            &values,
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        assert_eq!(
            validate_references(
                &jobs,
                &[first.clone(), second],
                &values,
                &AtomicBool::new(false)
            )
            .await
            .unwrap_err()
            .code,
            "invalid_property_value"
        );
        assert_eq!(
            validate_references(&jobs, &[first], &values, &AtomicBool::new(true))
                .await
                .unwrap_err()
                .code,
            "cancelled"
        );
        let direct = PropertySelection {
            selection: crate::config::WallpaperConfig::default()
                .main()
                .selection
                .clone(),
            properties: values,
        };
        assert!(
            validate_selections(&jobs, &[direct], &AtomicBool::new(false))
                .await
                .is_err()
        );
        jobs.library().pool().close().await;
    }

    #[tokio::test]
    async fn runtime_uses_defaults_and_overrides_without_mutating_installed_bytes() {
        let root = tempfileish::temp_dir("public-properties-resolve");
        let jobs = jobs(root.path()).await;
        let reference = publish(&jobs, "独立覆盖", true).await;
        let original = root
            .path()
            .join("packages")
            .join(&reference.package_hash)
            .join("original.hwpkg");
        let before = std::fs::read(&original).unwrap();
        for (properties, expected) in [
            (Map::new(), 0.6),
            (json!({"daylight":0.25}).as_object().unwrap().clone(), 0.25),
        ] {
            let resolved = selection_plan::resolve_selection_with_options(
                Arc::clone(&jobs),
                reference.selection(),
                ImageTarget {
                    width: 320,
                    height: 180,
                    purpose: ImagePurpose::Preview,
                    fit: ImageFit::Contain,
                },
                SelectionOptions {
                    properties,
                    ..Default::default()
                },
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap();
            let ResolvedSelection::Builtin(state) = resolved.content else {
                panic!("expected builtin");
            };
            assert_eq!(state.params["tod"], json!(expected));
        }
        let invalid = selection_plan::resolve(
            Arc::clone(&jobs),
            selection_plan::Request {
                work_key: reference.work_key.clone(),
                package_hash: reference.package_hash.clone(),
                target: ImageTarget {
                    width: 320,
                    height: 180,
                    purpose: ImagePurpose::Preview,
                    fit: ImageFit::Contain,
                },
                properties: json!({"daylight": 8}).as_object().unwrap().clone(),
            },
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(invalid.error.code, "invalid_property_value");
        assert!(jobs
            .library()
            .contains_version(&reference.work_key, &reference.package_hash)
            .await
            .unwrap());
        assert_eq!(std::fs::read(original).unwrap(), before);
        jobs.library().pool().close().await;
    }
}
