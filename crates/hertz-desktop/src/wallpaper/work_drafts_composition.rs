// SPDX-License-Identifier: MIT
//! Composition editing and immutable package construction belong to WorkDrafts.
use super::*;
use std::collections::BTreeSet;
#[cfg(test)]
use std::sync::atomic::AtomicBool;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Resource {
    pub asset_id: String,
    pub kind: hertz_wallpaper::AssetKind,
    pub work_key: String,
    pub package_hash: String,
    pub source_asset_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Section {
    Canvas,
    Nodes,
    Effects,
    Tracks,
    Bindings,
    Resources,
}

pub(super) fn validate(document: &Document) -> Result<()> {
    if !document.scene_id.is_empty() || document.state_version != 0 || !document.params.is_empty() {
        return Err(invalid("组合文档不能同时声明内置场景参数"));
    }
    let mut ids = BTreeSet::new();
    let metadata = document
        .resources
        .iter()
        .map(|r| {
            if !hertz_wallpaper::valid_local_id(&r.asset_id)
                || !hertz_wallpaper::valid_local_id(&r.source_asset_id)
                || !hertz_wallpaper::valid_sha256_hex(&r.package_hash)
                || !ids.insert(&r.asset_id)
                || !super::super::api::valid_id(&r.work_key)
            {
                return Err(invalid("组合资源引用无效或重复"));
            }
            Ok(hertz_wallpaper::generation::composition::AssetMetadata {
                alias: r.asset_id.clone(),
                kind: r.kind,
                width: matches!(
                    r.kind,
                    hertz_wallpaper::AssetKind::Image
                        | hertz_wallpaper::AssetKind::Video
                        | hertz_wallpaper::AssetKind::Texture
                )
                .then_some(1),
                height: matches!(
                    r.kind,
                    hertz_wallpaper::AssetKind::Image
                        | hertz_wallpaper::AssetKind::Video
                        | hertz_wallpaper::AssetKind::Texture
                )
                .then_some(1),
                duration_ms: (r.kind == hertz_wallpaper::AssetKind::Video).then_some(1),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let composition = document
        .composition
        .as_ref()
        .ok_or_else(|| invalid("缺少组合文档"))?;
    // The AI limits apply on reception. Authored edits use the full published
    // compiler contract, including larger timelines and node collections.
    if metadata.is_empty() {
        let bytes = serde_json::to_vec(composition).map_err(invalid)?;
        let manifest = metadata_manifest(document, &[], &bytes)?;
        hertz_wallpaper::document::compile_document(&bytes, &manifest).map_err(invalid)?;
    } else {
        let bytes = serde_json::to_vec(composition).map_err(invalid)?;
        let manifest = metadata_manifest(document, &metadata, &bytes)?;
        hertz_wallpaper::document::compile_document(&bytes, &manifest).map_err(invalid)?;
    }
    Ok(())
}

fn metadata_manifest(
    document: &Document,
    metadata: &[hertz_wallpaper::generation::composition::AssetMetadata],
    bytes: &[u8],
) -> Result<hertz_wallpaper::Manifest> {
    let files = std::iter::once(hertz_wallpaper::FileEntry {
        path: "documents/main.json".into(),
        bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        mime: "application/json".into(),
    })
    .chain(metadata.iter().map(|r| {
        hertz_wallpaper::FileEntry {
            path: format!("assets/{}", r.alias),
            bytes: 1,
            sha256: "0".repeat(64),
            mime: match r.kind {
                hertz_wallpaper::AssetKind::Image | hertz_wallpaper::AssetKind::Texture => {
                    "image/png"
                }
                hertz_wallpaper::AssetKind::Video => "video/mp4",
                hertz_wallpaper::AssetKind::Font => "font/ttf",
                hertz_wallpaper::AssetKind::Model => "model/gltf-binary",
                hertz_wallpaper::AssetKind::Vector => "image/svg+xml",
            }
            .into(),
        }
    }))
    .collect();
    Ok(hertz_wallpaper::Manifest {
        format_version: 1,
        work_id: "00000000-0000-4000-8000-000000000000".into(),
        version: 1,
        title: document.title.clone(),
        description: document.description.clone(),
        content: hertz_wallpaper::Content::Composition {
            document: "documents/main.json".into(),
        },
        assets: metadata
            .iter()
            .map(|r| hertz_wallpaper::AssetDescriptor {
                id: r.alias.clone(),
                kind: r.kind,
                source: format!("assets/{}", r.alias),
                variants: vec![],
            })
            .collect(),
        files,
        properties: document
            .properties
            .iter()
            .map(|p| p.to_map())
            .collect::<std::result::Result<_, _>>()
            .map_err(invalid)?,
        permissions: hertz_wallpaper::Permissions {
            audio_spectrum: true,
            pointer: true,
        },
        license: hertz_wallpaper::License {
            code: "none".into(),
            assets: "CC0-1.0".into(),
            attribution: String::new(),
        },
    })
}

pub(super) fn update(document: &mut Document, operation: Update) -> Result<()> {
    let value = document
        .composition
        .as_mut()
        .ok_or_else(|| invalid("此修改只接受组合草稿"))?;
    fn set<T>(items: &mut Vec<T>, item: T, id: impl Fn(&T) -> &str) {
        if let Some(index) = items.iter().position(|v| id(v) == id(&item)) {
            items[index] = item
        } else {
            items.push(item)
        }
    }
    fn remove<T>(items: &mut Vec<T>, key: &str, id: impl Fn(&T) -> &str) -> Result<()> {
        let index = items
            .iter()
            .position(|v| id(v) == key)
            .ok_or_else(|| invalid("条目不存在"))?;
        items.remove(index);
        Ok(())
    }
    match operation {
        Update::ReplaceCanvas { canvas } => value.canvas = canvas,
        Update::SetNode { node } => set(&mut value.nodes, node, |v| &v.id),
        Update::RemoveNode { id } => remove(&mut value.nodes, &id, |v| &v.id)?,
        Update::SetEffect { effect } => set(&mut value.effects, effect, |v| &v.id),
        Update::RemoveEffect { id } => remove(&mut value.effects, &id, |v| &v.id)?,
        Update::SetTrack { track } => set(&mut value.timeline.tracks, track, |v| &v.id),
        Update::RemoveTrack { id } => remove(&mut value.timeline.tracks, &id, |v| &v.id)?,
        Update::ReplaceTimeline {
            duration_seconds,
            r#loop,
        } => {
            value.timeline.duration_seconds = duration_seconds;
            value.timeline.r#loop = r#loop
        }
        Update::SetBinding { binding } => set(&mut value.bindings, binding, |v| &v.id),
        Update::RemoveBinding { id } => remove(&mut value.bindings, &id, |v| &v.id)?,
        Update::SetNodeProperty {
            node_id,
            property,
            value: property_value,
        } => {
            let node = value
                .nodes
                .iter_mut()
                .find(|n| n.id == node_id)
                .ok_or_else(|| invalid("节点不存在"))?;
            node.properties.insert(property, property_value);
        }
        Update::SetTrackKey {
            track_id,
            index,
            key,
        } => {
            let track = value
                .timeline
                .tracks
                .iter_mut()
                .find(|t| t.id == track_id)
                .ok_or_else(|| invalid("轨道不存在"))?;
            if index > track.keys.len() {
                return Err(invalid("关键帧索引无效"));
            }
            if index == track.keys.len() {
                track.keys.push(key)
            } else {
                track.keys[index] = key
            }
        }
        Update::InsertTrackKey {
            track_id,
            index,
            key,
        } => {
            let track = value
                .timeline
                .tracks
                .iter_mut()
                .find(|t| t.id == track_id)
                .ok_or_else(|| invalid("轨道不存在"))?;
            if index > track.keys.len() {
                return Err(invalid("关键帧索引无效"));
            }
            track.keys.insert(index, key);
        }
        Update::RemoveTrackKey { track_id, index } => {
            let track = value
                .timeline
                .tracks
                .iter_mut()
                .find(|t| t.id == track_id)
                .ok_or_else(|| invalid("轨道不存在"))?;
            if index >= track.keys.len() {
                return Err(invalid("关键帧索引无效"));
            }
            track.keys.remove(index);
        }
        Update::SetTrackTarget { track_id, target } => {
            let track = value
                .timeline
                .tracks
                .iter_mut()
                .find(|t| t.id == track_id)
                .ok_or_else(|| invalid("轨道不存在"))?;
            track.target = target;
        }
        _ => return Err(invalid("组合修改类型无效")),
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    section: Section,
    items: Vec<Value>,
    next_cursor: Option<String>,
    draft_revision: u64,
    duration_seconds: f64,
    r#loop: bool,
}
pub(super) fn page(
    draft: &Draft,
    section: Section,
    cursor: Option<&str>,
    limit: u32,
) -> Result<Page> {
    let value = draft
        .document
        .composition
        .as_ref()
        .ok_or_else(|| invalid("需要组合草稿"))?;
    let length = match section {
        Section::Canvas => 1,
        Section::Nodes => value.nodes.len(),
        Section::Effects => value.effects.len(),
        Section::Tracks => value.timeline.tracks.len(),
        Section::Bindings => value.bindings.len(),
        Section::Resources => draft.document.resources.len(),
    };
    let start = cursor
        .map(|s| s.parse::<usize>().map_err(invalid))
        .transpose()?
        .unwrap_or(0);
    if start > length {
        return Err(invalid("组合游标不属于当前修订"));
    }
    let mut result = Page {
        section,
        items: vec![],
        next_cursor: None,
        draft_revision: draft.revision,
        duration_seconds: value.timeline.duration_seconds,
        r#loop: value.timeline.r#loop,
    };
    for index in start..length {
        if result.items.len() == limit.clamp(1, 32) as usize {
            result.next_cursor = Some(index.to_string());
            break;
        }
        let item=match section{Section::Canvas=>serde_json::to_value(&value.canvas),Section::Nodes=>serde_json::to_value(&value.nodes[index]),Section::Effects=>serde_json::to_value(&value.effects[index]),Section::Bindings=>serde_json::to_value(&value.bindings[index]),Section::Tracks=>{let track=&value.timeline.tracks[index];Ok(serde_json::json!({"id":track.id,"target":track.target,"keys":[],"keyCount":track.keys.len(),"keysPaged":true}))},Section::Resources=>{let r=&draft.document.resources[index];Ok(serde_json::json!({"assetId":r.asset_id,"kind":r.kind,"label":r.asset_id}))}}.map_err(invalid)?;
        result.items.push(item);
        if serde_json::to_vec(&result).map_err(invalid)?.len() > 60 * 1024 {
            result.items.pop();
            result.next_cursor = Some(index.to_string());
            if result.items.is_empty() {
                return Err(invalid("单个组合条目超过管理响应上限"));
            }
            break;
        }
    }
    Ok(result)
}

#[path = "work_drafts_composition_package.rs"]
mod package;
pub(crate) use package::PackageBuild;
#[cfg(test)]
#[path = "work_drafts_model_tests.rs"]
mod model_tests;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::wallpaper::library::{tempfileish, InstallWork, Library, LOCAL_SOURCE};
    use base64::Engine;
    use serde_json::json;
    use std::io::Cursor;

    pub(crate) async fn install_source(
        library: &Library,
        assets: &AssetStore,
        long_path: bool,
        count: usize,
    ) -> (String, String, Vec<u8>) {
        install_source_with_attribution(
            library,
            assets,
            long_path,
            count,
            "Deep original author; exact rights text",
        )
        .await
    }

    pub(super) async fn install_source_with_attribution(
        library: &Library,
        assets: &AssetStore,
        long_path: bool,
        count: usize,
        author: &str,
    ) -> (String, String, Vec<u8>) {
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==").unwrap();
        let mut files = Vec::new();
        let mut descriptors = Vec::new();
        let mut entries = Vec::new();
        for index in 0..count {
            let path = if long_path {
                format!("{}.png", "x".repeat(176))
            } else {
                format!("assets/pixel-{index}.png")
            };
            descriptors.push(
                json!({"id":format!("pixel-{index}"),"kind":"image","source":path,"variants":[]}),
            );
            files.push(json!({"path":path,"bytes":png.len(),"sha256":format!("{:x}",Sha256::digest(&png)),"mime":"image/png"}));
            entries.push((path, png.clone()));
        }
        for (path, value) in [
            (
                "documents/attribution.json",
                json!([{"attribution":"Outer inventory","priorInventory":"licenses/inner.json"}]),
            ),
            (
                "licenses/inner.json",
                json!([{"license":"CC-BY-4.0","attribution":author}]),
            ),
        ] {
            let bytes = serde_json::to_vec(&value).unwrap();
            files.push(json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"mime":"application/json"}));
            entries.push((path.into(), bytes));
        }
        let work = uuid::Uuid::new_v4().to_string();
        let work_key = format!("local-{work}");
        let manifest = json!({"formatVersion":1,"workId":work,"version":1,"title":"Licensed source","description":"","content":{"kind":"image","asset":"pixel-0"},"assets":descriptors,"files":files,"properties":[],"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"CC-BY-4.0","attribution":"See documents/attribution.json"}});
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        for (path, bytes) in entries {
            zip.start_file(path, options).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let source = assets.root().join("source.hwpkg");
        std::fs::write(&source, bytes).unwrap();
        let job = "source-install";
        assets.snapshot_input(job, &source, None).unwrap();
        let package = assets.validate_staged(job).unwrap();
        assets.unpack_projection(job, &package).unwrap();
        let bytes = std::fs::metadata(assets.staging_dir(job).join("original.hwpkg"))
            .unwrap()
            .len();
        assets
            .content_writer()
            .unwrap()
            .publish_staging(job, &package.package_hash)
            .unwrap();
        library
            .install(&InstallWork {
                remote_work_id: work,
                work_key: work_key.clone(),
                title: package.manifest.title.clone(),
                description: String::new(),
                kind: "image".into(),
                package_hash: package.package_hash.clone(),
                manifest_json: package.manifest_json,
                package_bytes: bytes,
                version: 1,
                source_id: LOCAL_SOURCE.into(),
            })
            .await
            .unwrap();
        (work_key, package.package_hash, png)
    }

    fn composition(work: &str, hash: &str) -> Document {
        serde_json::from_value(json!({"title":"Licensed composition","composition":{"documentVersion":1,"canvas":{"width":640,"height":360,"colorSpace":"srgb","background":"#000000"},"nodes":[{"id":"picture","type":"image","stateVersion":1,"assets":{"asset":"picture-resource"},"properties":{}}],"effects":[],"timeline":{"durationSeconds":1.0,"loop":true,"tracks":[]},"bindings":[]},"resources":[{"assetId":"picture-resource","kind":"image","workKey":work,"packageHash":hash,"sourceAssetId":"pixel-0"}]})).unwrap()
    }

    fn attribution_text(
        assets: &AssetStore,
        package: &crate::wallpaper::assets::StagedPackage,
        path: &str,
        seen: &mut BTreeSet<String>,
    ) -> String {
        assert!(
            seen.insert(path.into()),
            "attribution closure must not cycle"
        );
        let pin = assets
            .pin_package_entry(package, path, &AtomicBool::new(false))
            .unwrap();
        let raw = std::fs::read_to_string(&pin.path).unwrap();
        fn paths(value: &Value, output: &mut Vec<String>) {
            match value {
                Value::Object(values) => {
                    for (key, value) in values {
                        if key == "priorInventory" {
                            if let Some(path) = value.as_str().filter(|path| path.contains('/')) {
                                output.push(path.into());
                            }
                        }
                        paths(value, output);
                    }
                }
                Value::Array(values) => {
                    for value in values {
                        paths(value, output);
                    }
                }
                _ => {}
            }
        }
        let mut children = Vec::new();
        paths(&serde_json::from_str(&raw).unwrap(), &mut children);
        let mut text = raw;
        for child in children {
            text.push_str(&attribution_text(assets, package, &child, seen));
        }
        text
    }

    #[tokio::test]
    async fn composition_two_publications_preserve_exact_resource_and_complete_attribution() {
        let root = tempfileish::temp_dir("composition-publication-closure");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let (work, hash, png) = install_source(&library, &assets, false, 1).await;
        let drafts = WorkDrafts::new(&library);
        let draft = drafts
            .create_owned(composition(&work, &hash), None, None)
            .await
            .unwrap();
        let before: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM draft_resource_references WHERE package_hash=?",
        )
        .bind(&hash)
        .fetch_one(library.pool())
        .await
        .unwrap();
        assert_eq!(before, 1);
        drafts.save(&draft.id, 1).await.unwrap();
        let first = drafts.publish(&draft.id, 1, &assets).await.unwrap();
        let after: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM draft_resource_references WHERE package_hash=?",
        )
        .bind(&hash)
        .fetch_one(library.pool())
        .await
        .unwrap();
        assert_eq!(after, 0);
        let reopened = drafts
            .create_from_version(&first.work_key, &first.package_hash, &assets)
            .await
            .unwrap();
        let edited = drafts
            .update(
                &reopened.id,
                1,
                vec![Update::ReplaceMetadata {
                    title: "Second publication".into(),
                    description: String::new(),
                }],
            )
            .await
            .unwrap();
        drafts.save(&edited.id, edited.revision).await.unwrap();
        let second = drafts
            .publish(&edited.id, edited.revision, &assets)
            .await
            .unwrap();
        let package = assets
            .read_installed_manifest(&second.package_hash)
            .unwrap();
        let asset = package
            .manifest
            .assets
            .iter()
            .find(|asset| asset.id == "picture-resource")
            .unwrap();
        let pin = assets
            .pin_package_entry(&package, &asset.source, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(std::fs::read(&pin.path).unwrap(), png);
        let text = attribution_text(
            &assets,
            &package,
            "documents/attribution.json",
            &mut BTreeSet::new(),
        );
        assert!(text.contains("Deep original author; exact rights text"));
        assert!(text.contains("CC-BY-4.0"));
        let exported = std::fs::read(
            assets
                .package_dir(&second.package_hash)
                .join("original.hwpkg"),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(
                hertz_wallpaper::validate_package(Cursor::new(exported))
                    .unwrap()
                    .manifest
                    .assets
            )
            .unwrap(),
            serde_json::to_value(&package.manifest.assets).unwrap()
        );
        library.pool().close().await;
    }

    #[tokio::test]
    async fn composition_legal_180_byte_source_path_stays_bounded_on_republication() {
        let root = tempfileish::temp_dir("composition-long-resource-path");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let (work, hash, _) = install_source(&library, &assets, true, 1).await;
        let drafts = WorkDrafts::new(&library);
        let draft = drafts
            .create_owned(composition(&work, &hash), None, None)
            .await
            .unwrap();
        drafts.save(&draft.id, 1).await.unwrap();
        let first = drafts.publish(&draft.id, 1, &assets).await.unwrap();
        let reopened = drafts
            .create_from_version(&first.work_key, &first.package_hash, &assets)
            .await
            .unwrap();
        drafts.save(&reopened.id, 1).await.unwrap();
        let second = drafts.publish(&reopened.id, 1, &assets).await.unwrap();
        let first_package = assets.read_installed_manifest(&first.package_hash).unwrap();
        let second_package = assets
            .read_installed_manifest(&second.package_hash)
            .unwrap();
        assert_eq!(
            first_package
                .manifest
                .assets
                .iter()
                .find(|asset| asset.id == "picture-resource")
                .unwrap()
                .source,
            second_package
                .manifest
                .assets
                .iter()
                .find(|asset| asset.id == "picture-resource")
                .unwrap()
                .source
        );
        assert!(second_package
            .manifest
            .files
            .iter()
            .all(|entry| entry.path.len() <= hertz_wallpaper::MAX_PATH_BYTES));
        library.pool().close().await;
    }
}
