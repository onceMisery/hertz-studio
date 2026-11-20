// SPDX-License-Identifier: MIT
//! Immutable composition package construction and attribution belong to WorkDrafts.
use super::*;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::{Read, Seek, SeekFrom},
    sync::atomic::AtomicBool,
};

/// Actual pinned entries and deterministic ZIP streaming. No full media buffers.
pub(crate) struct PackageBuild {
    pub manifest: hertz_wallpaper::Manifest,
    pub document: Vec<u8>,
    pins: BTreeMap<String, std::sync::Arc<crate::wallpaper::assets::PinnedMedia>>,
    inventory: Vec<u8>,
    inventory_path: String,
}
#[path = "work_drafts_models.rs"]
mod models;
const MAX_ATTRIBUTION_BYTES: usize = 8 * 1024 * 1024;
const MAX_ATTRIBUTION_SOURCES: usize = 4096;
const MAX_LICENSE_EDGES: usize = 16384;
const MAX_LICENSE_DEPTH: usize = 64;
const MAX_LICENSE_GRAPH_WORK: usize = MAX_ATTRIBUTION_SOURCES + 2 * MAX_LICENSE_EDGES;

fn stable_resource_path(entry: &hertz_wallpaper::FileEntry, assets_directory: &str) -> String {
    let extension = match entry.mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/ktx2" => "ktx2",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "font/ttf" => "ttf",
        "font/otf" => "otf",
        "font/woff" => "woff",
        "font/woff2" => "woff2",
        "image/svg+xml" => "svg",
        "model/gltf-binary" => "glb",
        _ => "bin",
    };
    format!("{assets_directory}/{}.{extension}", entry.sha256)
}

fn inventory_identity(package_hash: &str, path: &str, raw_sha256: &str) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&("hertz-attribution-v2", package_hash, path, raw_sha256))
                .map_err(invalid)?
        )
    ))
}

fn merge_inventory(inventories: &mut BTreeMap<String, Value>, inventory: Value) -> Result<()> {
    let id = inventory["id"]
        .as_str()
        .ok_or_else(|| invalid("署名库存缺少身份"))?
        .to_owned();
    if inventories
        .get(&id)
        .is_some_and(|prior| prior != &inventory)
    {
        return Err(invalid("同一署名库存身份的闭包事实不符"));
    }
    inventories.insert(id, inventory);
    Ok(())
}

fn source_identity(source: &Value) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(source).map_err(invalid)?)
    ))
}

fn merge_flat_attribution(
    value: &Value,
    package_hash: &str,
    sources: &mut BTreeMap<String, Value>,
    inventories: &mut BTreeMap<String, Value>,
) -> Result<Vec<String>> {
    let version = value["formatVersion"]
        .as_u64()
        .ok_or_else(|| invalid("署名库存版本无效"))?;
    let prior_sources = value["sources"]
        .as_array()
        .ok_or_else(|| invalid("已保存署名来源结构无效"))?;
    if prior_sources.len() > MAX_ATTRIBUTION_SOURCES {
        return Err(invalid("署名来源超过4096项上限"));
    }
    let mut prior_sources = prior_sources.clone();
    let mut prior_inventories = value["inventories"]
        .as_array()
        .ok_or_else(|| invalid("已保存署名库存结构无效"))?
        .clone();
    if version == 1 {
        // Explicitly normalize development v1 inventories: the old raw-only
        // ID did not bind relative references to their immutable package.
        let mut identities = BTreeMap::new();
        for inventory in &mut prior_inventories {
            let old = inventory["id"]
                .as_str()
                .filter(|id| hertz_wallpaper::valid_sha256_hex(id))
                .ok_or_else(|| invalid("旧署名库存身份无效"))?
                .to_owned();
            let raw = inventory["raw"]
                .as_str()
                .ok_or_else(|| invalid("旧署名库存缺少原文"))?;
            if format!("{:x}", Sha256::digest(raw.as_bytes())) != old {
                return Err(invalid("旧署名库存原文哈希不符"));
            }
            let path = inventory["originalPath"]
                .as_str()
                .ok_or_else(|| invalid("旧署名库存缺少原路径"))?;
            let id = inventory_identity(package_hash, path, &old)?;
            if identities.insert(old.clone(), id.clone()).is_some() {
                return Err(invalid("旧署名库存重复身份"));
            }
            inventory["id"] = serde_json::json!(id);
            inventory["rawSha256"] = serde_json::json!(old);
            inventory["sourcePackageHash"] = serde_json::json!(package_hash);
        }
        for inventory in &mut prior_inventories {
            for reference in inventory["references"]
                .as_array_mut()
                .ok_or_else(|| invalid("旧署名引用结构无效"))?
            {
                let id = reference["id"]
                    .as_str()
                    .and_then(|id| identities.get(id))
                    .ok_or_else(|| invalid("旧署名闭包缺少引用"))?
                    .clone();
                reference["id"] = serde_json::json!(id);
            }
        }
        for source in &mut prior_sources {
            if !source["priorInventory"].is_null() {
                let id = source["priorInventory"]
                    .as_str()
                    .and_then(|id| identities.get(id))
                    .ok_or_else(|| invalid("旧署名来源缺少库存"))?
                    .clone();
                source["priorInventory"] = serde_json::json!(id);
            }
        }
    } else if version != 2 {
        return Err(invalid("署名库存版本尚未支持"));
    }
    let mut ids = BTreeSet::new();
    for inventory in &prior_inventories {
        let id = inventory["id"]
            .as_str()
            .filter(|id| hertz_wallpaper::valid_sha256_hex(id))
            .ok_or_else(|| invalid("已保存署名库存身份无效"))?;
        let raw = inventory["raw"]
            .as_str()
            .ok_or_else(|| invalid("已保存署名库存缺少原文"))?;
        let raw_sha = inventory["rawSha256"]
            .as_str()
            .filter(|hash| hertz_wallpaper::valid_sha256_hex(hash))
            .ok_or_else(|| invalid("署名原文缺少独立哈希"))?;
        let source_package = inventory["sourcePackageHash"]
            .as_str()
            .filter(|hash| hertz_wallpaper::valid_sha256_hex(hash))
            .ok_or_else(|| invalid("署名库存缺少原包身份"))?;
        let path = inventory["originalPath"]
            .as_str()
            .ok_or_else(|| invalid("署名库存缺少原路径"))?;
        if format!("{:x}", Sha256::digest(raw.as_bytes())) != raw_sha
            || inventory_identity(source_package, path, raw_sha)? != id
            || !ids.insert(id)
        {
            return Err(invalid("已保存署名库存原文或上下文身份不符"));
        }
    }
    for inventory in &prior_inventories {
        for reference in inventory["references"]
            .as_array()
            .ok_or_else(|| invalid("已保存署名引用结构无效"))?
        {
            if reference["id"].as_str().is_none_or(|id| !ids.contains(id)) {
                return Err(invalid("已保存署名库存缺少闭包引用"));
            }
        }
    }
    let mut identities = Vec::new();
    for source in prior_sources {
        if !source["priorInventory"].is_null()
            && source["priorInventory"]
                .as_str()
                .is_none_or(|id| !ids.contains(id))
        {
            return Err(invalid("已保存署名来源缺少库存"));
        }
        if !source["licenseDocuments"].is_null() {
            let documents = source["licenseDocuments"]
                .as_array()
                .ok_or_else(|| invalid("许可文档引用结构无效"))?;
            if documents
                .iter()
                .any(|document| document.as_str().is_none_or(|id| !ids.contains(id)))
            {
                return Err(invalid("许可文档引用缺少原文"));
            }
        }
        let id = source_identity(&source)?;
        if !sources.contains_key(&id) && sources.len() == MAX_ATTRIBUTION_SOURCES {
            return Err(invalid("署名来源超过4096项上限"));
        }
        identities.push(id.clone());
        sources.insert(id, source);
    }
    for inventory in prior_inventories {
        merge_inventory(inventories, inventory)?;
    }
    Ok(identities)
}

#[derive(Default)]
struct AttributionClosure {
    root: Option<String>,
    sources: Vec<String>,
    documents: Vec<String>,
}

fn derivative_denied() -> JobError {
    JobError::new(
        "derivative_license_required",
        "此版本的改编许可未明确或不支持改编，无法另存为新作品；原作品仍可使用和导出",
    )
}

/// Kahn traversal: each source and edge is visited at most a fixed number of
/// times. No recursive stack and no repeated scan of the remaining sources.
fn validate_license_graph(sources: &BTreeMap<String, Value>) -> Result<usize> {
    if sources.len() > MAX_ATTRIBUTION_SOURCES {
        return Err(invalid("署名来源超过4096项上限"));
    }
    let indices: BTreeMap<_, _> = sources
        .keys()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect();
    let mut parents = vec![Vec::new(); sources.len()];
    let mut pending = vec![0usize; sources.len()];
    let mut depth = vec![0usize; sources.len()];
    let mut ready = VecDeque::new();
    let mut edges = 0usize;
    let mut work = 0usize;
    for (index, source) in sources.values().enumerate() {
        work += 1;
        if source["license"] != "LicenseRef-inventory" {
            // Only the placeholder defines this typed edge field. Ignoring an
            // extra dangling dependency on a concrete license would hide data.
            if !source["licenseSources"].is_null() {
                return Err(derivative_denied());
            }
            ready.push_back(index);
            continue;
        }
        let children = source["licenseSources"]
            .as_array()
            .ok_or_else(derivative_denied)?;
        if children.is_empty() {
            return Err(derivative_denied());
        }
        edges = edges
            .checked_add(children.len())
            .ok_or_else(derivative_denied)?;
        if edges > MAX_LICENSE_EDGES {
            return Err(invalid("许可依赖超过16384条上限"));
        }
        pending[index] = children.len();
        let mut unique = BTreeSet::new();
        for child in children {
            work += 1;
            let child = child
                .as_str()
                .and_then(|id| indices.get(id))
                .copied()
                .ok_or_else(derivative_denied)?;
            if !unique.insert(child) {
                return Err(derivative_denied());
            }
            parents[child].push(index);
        }
    }
    let mut resolved = 0usize;
    while let Some(child) = ready.pop_front() {
        resolved += 1;
        for &parent in &parents[child] {
            work += 1;
            if work > MAX_LICENSE_GRAPH_WORK {
                return Err(invalid("许可核验超过工作量上限"));
            }
            depth[parent] = depth[parent].max(depth[child] + 1);
            if depth[parent] > MAX_LICENSE_DEPTH {
                return Err(invalid("许可依赖超过64层上限"));
            }
            pending[parent] -= 1;
            if pending[parent] == 0 {
                ready.push_back(parent);
            }
        }
    }
    if resolved != sources.len() {
        return Err(derivative_denied());
    }
    Ok(work)
}

fn explicit_attribution_path(attribution: &str) -> Option<&str> {
    attribution
        .strip_prefix("Attribution and asset licenses: ")
        .or_else(|| attribution.strip_prefix("See "))
}

fn collect_attribution(
    assets: &AssetStore,
    package: &crate::wallpaper::assets::StagedPackage,
    cancel: &AtomicBool,
    sources: &mut BTreeMap<String, Value>,
    inventories: &mut BTreeMap<String, Value>,
) -> Result<AttributionClosure> {
    let named = explicit_attribution_path(&package.manifest.license.attribution);
    if named.is_some_and(|path| package.manifest.file(path).is_none()) {
        return Err(invalid("署名明确引用的许可文件未被原包索引"));
    }
    let root_path = named.or_else(|| {
        package
            .manifest
            .file("documents/attribution.json")
            .map(|_| "documents/attribution.json")
    });
    // Account for every non-media attachment, for every accepted content kind.
    // The composition document is rebuilt; declared asset bytes are copied by
    // the resource closure. All other files must be preserved legal metadata
    // or rejected, regardless of their filename or attribution prose.
    let mut content_files = BTreeSet::new();
    for asset in &package.manifest.assets {
        content_files.insert(asset.source.as_str());
        content_files.extend(asset.variants.iter().map(|variant| variant.file.as_str()));
    }
    if let hertz_wallpaper::Content::Composition { document } = &package.manifest.content {
        content_files.insert(document);
    }
    let mut pending: Vec<String> = package
        .manifest
        .files
        .iter()
        .filter(|entry| !content_files.contains(entry.path.as_str()))
        .map(|entry| entry.path.clone())
        .collect();
    if let Some(path) = root_path {
        pending.push(path.into());
    }
    let mut seen = BTreeSet::new();
    let mut closure = AttributionClosure::default();
    let mut total = 0usize;
    while let Some(path) = pending.pop() {
        if !seen.insert(path.clone()) {
            continue;
        }
        if seen.len() > 4096 {
            return Err(invalid("署名资料闭包条目超过包上限"));
        }
        let entry = package
            .manifest
            .file(&path)
            .ok_or_else(|| invalid("署名资料引用未被原包索引"))?;
        total = total
            .checked_add(usize::try_from(entry.bytes).map_err(invalid)?)
            .ok_or_else(|| invalid("署名资料长度溢出"))?;
        if total > MAX_ATTRIBUTION_BYTES {
            return Err(invalid("完整署名资料闭包超过8 MiB"));
        }
        let pin = assets.pin_package_entry(package, &path, cancel)?;
        let mut raw = String::new();
        crate::wallpaper::assets::open_immutable(&pin.path)?
            .take(entry.bytes + 1)
            .read_to_string(&mut raw)
            .map_err(io)?;
        if raw.len() as u64 != entry.bytes {
            return Err(invalid("署名资料字节长度不符"));
        }
        // Preserve text license notices verbatim inside the bounded inventory;
        // a declared text document must never disappear on re-publication.
        let value = match entry.mime.as_str() {
            "application/json" => Some(serde_json::from_str::<Value>(&raw).map_err(invalid)?),
            "text/plain" | "text/markdown" => None,
            _ => return Err(invalid("许可文件必须为有界 UTF-8 JSON 或纯文本")),
        };
        if root_path == Some(path.as_str())
            && value
                .as_ref()
                .is_some_and(|value| value["kind"] == "hertzAttribution")
        {
            closure.sources = merge_flat_attribution(
                value.as_ref().unwrap(),
                &package.package_hash,
                sources,
                inventories,
            )?;
            continue;
        }
        fn references(value: &Value, paths: &mut BTreeSet<String>) {
            match value {
                Value::Object(values) => {
                    for (key, value) in values {
                        if key == "priorInventory" {
                            if let Some(path) = value.as_str() {
                                paths.insert(path.into());
                            }
                        }
                        references(value, paths);
                    }
                }
                Value::Array(values) => {
                    for value in values {
                        references(value, paths);
                    }
                }
                _ => {}
            }
        }
        let mut referenced = BTreeSet::new();
        if let Some(value) = &value {
            references(value, &mut referenced);
        }
        let mut links = Vec::new();
        for path in referenced {
            let child = package
                .manifest
                .file(&path)
                .ok_or_else(|| invalid("署名资料闭包缺少原始引用"))?;
            links.push(serde_json::json!({"path":path,"id":inventory_identity(&package.package_hash,&path,&child.sha256)?}));
            pending.push(path);
        }
        let id = inventory_identity(&package.package_hash, &path, &entry.sha256)?;
        if root_path == Some(path.as_str()) {
            closure.root = Some(id.clone());
        }
        closure.documents.push(id.clone());
        let mut record = serde_json::json!({"id":id,"sourcePackageHash":package.package_hash,"rawSha256":entry.sha256,"originalPath":path,"raw":raw,"references":links});
        if value.is_none() {
            record["mime"] = serde_json::json!(entry.mime);
        }
        merge_inventory(inventories, record)?;
    }
    Ok(closure)
}

/// Fixed product policy, not a free-text "I own it" override. Declarative
/// builtin/composition packages contain no executable code, so code:none is
/// meaningful; assets:none does not grant rights to an imported arrangement.
pub(in crate::wallpaper::work_drafts) async fn validate_derivative_license(
    package: &crate::wallpaper::assets::StagedPackage,
    assets: &AssetStore,
    locally_authored: bool,
    library: &Library,
) -> Result<()> {
    fn known(value: &str) -> bool {
        matches!(
            value,
            "CC0-1.0"
                | "CC-BY-4.0"
                | "CC-BY-SA-4.0"
                | "MIT"
                | "Apache-2.0"
                | "BSD-2-Clause"
                | "BSD-3-Clause"
                | "ISC"
                | "Unlicense"
        )
    }
    let denied = derivative_denied;
    let mut sources = BTreeMap::new();
    let mut inventories = BTreeMap::new();
    let closure = collect_attribution(
        assets,
        package,
        &AtomicBool::new(false),
        &mut sources,
        &mut inventories,
    )?;
    validate_license_graph(&sources)?;
    let check = |value: &str, code: bool| known(value) || value == "none" && code;
    if !(check(&package.manifest.license.assets, false)
        || package.manifest.license.assets == "LicenseRef-inventory" && !closure.sources.is_empty()
        || locally_authored && package.manifest.license.assets == "none")
        || !check(&package.manifest.license.code, true)
    {
        return Err(denied());
    }
    fn inspect(
        value: &Value,
        check: &impl Fn(&str, bool) -> bool,
        skip_root_placeholder: bool,
    ) -> Result<()> {
        match value {
            Value::Object(fields) => {
                for (key, value) in fields {
                    if (key == "license" || key == "codeLicense")
                        && !(skip_root_placeholder
                            && key == "license"
                            && value == "LicenseRef-inventory")
                    {
                        if let Some(license) = value.as_str() {
                            if !check(license, key == "codeLicense") {
                                return Err(derivative_denied());
                            }
                        } else if key == "license" {
                            let license: hertz_wallpaper::License =
                                serde_json::from_value(value.clone())
                                    .map_err(|_| derivative_denied())?;
                            if !check(&license.code, true) || !check(&license.assets, false) {
                                return Err(derivative_denied());
                            }
                        } else {
                            return Err(derivative_denied());
                        }
                    }
                    inspect(value, check, false)?;
                }
            }
            Value::Array(values) => {
                for value in values {
                    inspect(value, check, false)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    for source in sources.values() {
        let source_hash = source["sourcePackageHash"]
            .as_str()
            .filter(|hash| hertz_wallpaper::valid_sha256_hex(hash))
            .ok_or_else(denied)?;
        // Ownership of the outer composition does not confer rights to its
        // dependencies. Only an independently recorded exact authored source
        // can carry assets:none; a copied title/workId is not evidence.
        let source_authored = if source["license"] == "none" {
            sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM authored_versions a JOIN versions v ON v.version_key=a.version_key JOIN works w ON w.work_key=v.work_key WHERE w.source_id='local' AND v.package_hash=?)")
                .bind(source_hash).fetch_one(library.pool()).await.map_err(database)?
        } else {
            false
        };
        let source_check =
            |value: &str, code: bool| check(value, code) || source_authored && value == "none";
        let license = source["license"].as_str().ok_or_else(denied)?;
        if license == "LicenseRef-inventory" {
            // The placeholder is not a grant. Resolve this source's explicit
            // links below; an unrelated permissive source cannot satisfy it.
            inspect(source, &source_check, true)?;
            continue;
        }
        if !source_check(license, false) {
            return Err(denied());
        }
        inspect(source, &source_check, false)?;
    }
    for inventory in inventories.values() {
        match inventory["mime"].as_str().unwrap_or("application/json") {
            "application/json" => {
                let raw: Value =
                    serde_json::from_str(inventory["raw"].as_str().ok_or_else(denied)?)
                        .map_err(|_| denied())?;
                inspect(&raw, &check, false)?;
            }
            "text/plain" | "text/markdown" => {}
            _ => return Err(denied()),
        }
    }
    Ok(())
}

impl PackageBuild {
    pub(crate) fn resolve(
        document: &Document,
        work_id: &str,
        version: u32,
        assets: &AssetStore,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let mut document = document.clone();
        document.normalize()?;
        let composition = document.composition.as_ref();
        let bytes = composition
            .map(serde_json::to_vec)
            .transpose()
            .map_err(invalid)?
            .unwrap_or_default();
        let mut manifest = if composition.is_some() {
            metadata_manifest(&document, &[], &bytes)?
        } else {
            document.manifest(work_id, version)?
        };
        manifest.work_id = work_id.into();
        manifest.version = version;
        let mut packages = BTreeMap::new();
        for r in &document.resources {
            let key = (r.package_hash.clone(), r.candidate_id.clone());
            if let std::collections::btree_map::Entry::Vacant(entry) = packages.entry(key) {
                let package = match &r.candidate_id {
                    Some(id) => assets.read_candidate(id, &r.package_hash)?,
                    None => assets.read_installed_manifest(&r.package_hash)?,
                };
                entry.insert(package);
            }
        }
        if let Some(source) = &document.provenance {
            let key = (source.package_hash.clone(), None);
            if let std::collections::btree_map::Entry::Vacant(entry) = packages.entry(key) {
                entry.insert(assets.read_installed_manifest(&source.package_hash)?);
            }
        }
        let layout = models::resolve(&document, &packages, assets, cancel)?;
        let document_path = format!("{}/main.json", layout.documents);
        let inventory_path = format!("{}/attribution.json", layout.documents);
        if composition.is_some() {
            manifest.files[0].path = document_path.clone();
            manifest.content = hertz_wallpaper::Content::Composition {
                document: document_path,
            };
        }
        let mut pins = BTreeMap::new();
        let mut sources = BTreeMap::new();
        let mut inventories = BTreeMap::new();
        let mut licenses = BTreeSet::new();
        for (number, ((hash, candidate), package)) in packages.iter().enumerate() {
            let selected: Vec<_> = document
                .resources
                .iter()
                .filter(|r| r.package_hash == *hash && r.candidate_id == *candidate)
                .collect();
            let vector = selected
                .iter()
                .any(|r| r.kind == hertz_wallpaper::AssetKind::Vector);
            let mut path_set = BTreeSet::new();
            let mut model_mappings = BTreeMap::new();
            let mut external_images: BTreeMap<String, Vec<(String, hertz_wallpaper::AssetKind)>> =
                BTreeMap::new();
            let mut descriptors = BTreeMap::new();
            for (dependency, a) in package.manifest.assets.iter().enumerate() {
                let selection = selected.iter().find(|r| r.source_asset_id == a.id);
                if selection.is_none() && !(vector && a.kind == hertz_wallpaper::AssetKind::Font) {
                    continue;
                }
                let mut mapped = a.clone();
                mapped.id = selection.map_or_else(
                    || format!("dep-{number}-{dependency}"),
                    |r| r.asset_id.clone(),
                );
                if let Some(r) = selection {
                    if r.kind != a.kind {
                        return Err(invalid("固定资源kind已变化"));
                    }
                }
                path_set.insert(a.source.clone());
                for variant in &mapped.variants {
                    path_set.insert(variant.file.clone());
                }
                if a.kind == hertz_wallpaper::AssetKind::Model {
                    for path in std::iter::once(&a.source).chain(a.variants.iter().map(|v| &v.file))
                    {
                        if let Some(plan) = layout
                            .plans
                            .get(&((hash.clone(), candidate.clone()), path.clone()))
                        {
                            model_mappings
                                .insert(path.clone(), format!("{}{}", plan.namespace, plan.leaf));
                            for image in &plan.images {
                                path_set.insert(image.path.clone());
                                external_images
                                    .entry(image.path.clone())
                                    .or_default()
                                    .push((
                                        format!("{}{}", plan.namespace, image.relative),
                                        image.kind,
                                    ));
                            }
                        }
                    }
                }
                descriptors.insert(mapped.id.clone(), mapped);
            }
            if selected.iter().any(|r| {
                !package
                    .manifest
                    .assets
                    .iter()
                    .any(|a| a.id == r.source_asset_id)
            }) {
                return Err(invalid("固定包缺少选定素材"));
            }
            for (dependency, a) in package.manifest.assets.iter().enumerate() {
                if descriptors.values().any(|v| v.source == a.source)
                    || !std::iter::once(&a.source)
                        .chain(a.variants.iter().map(|v| &v.file))
                        .any(|p| path_set.contains(p))
                {
                    continue;
                }
                let mut mapped = a.clone();
                mapped.id = format!("dep-{number}-{dependency}");
                path_set.insert(a.source.clone());
                for v in &mapped.variants {
                    path_set.insert(v.file.clone());
                }
                descriptors.insert(mapped.id.clone(), mapped);
            }
            let mut mappings = BTreeMap::new();
            for path in path_set {
                let entry = package
                    .manifest
                    .file(&path)
                    .ok_or_else(|| invalid("依赖未被包索引"))?;
                let mapped = model_mappings
                    .get(&path)
                    .cloned()
                    .or_else(|| {
                        external_images
                            .get(&path)
                            .and_then(|images| images.first().map(|image| image.0.clone()))
                    })
                    .unwrap_or_else(|| stable_resource_path(entry, &layout.assets));
                let mut placements = BTreeSet::from([mapped.clone()]);
                if let Some(images) = external_images.get(&path) {
                    placements.extend(images.iter().map(|image| image.0.clone()));
                }
                let mut source_pin = None;
                for placement in placements {
                    if let Some(prior) = manifest.file(&placement) {
                        if prior.bytes != entry.bytes
                            || prior.sha256 != entry.sha256
                            || prior.mime != entry.mime
                        {
                            return Err(JobError::new(
                                "composition_resource_conflict",
                                "模型闭包命名空间内的字节身份冲突",
                            ));
                        }
                    } else {
                        if source_pin.is_none() {
                            source_pin = Some(assets.pin_package_entry(package, &path, cancel)?);
                        }
                        let mut file = entry.clone();
                        file.path = placement.clone();
                        manifest.files.push(file);
                        pins.insert(placement, source_pin.as_ref().unwrap().clone());
                    }
                }
                mappings.insert(path, mapped);
            }
            for mut descriptor in descriptors.into_values() {
                descriptor.source = mappings
                    .get(&descriptor.source)
                    .ok_or_else(|| invalid("资源映射缺失"))?
                    .clone();
                for variant in &mut descriptor.variants {
                    variant.file = mappings
                        .get(&variant.file)
                        .ok_or_else(|| invalid("变体映射缺失"))?
                        .clone();
                }
                manifest.assets.push(descriptor);
            }
            for images in external_images.into_values() {
                for (path, kind) in images {
                    if manifest.assets.iter().any(|asset| {
                        matches!(
                            asset.kind,
                            hertz_wallpaper::AssetKind::Image | hertz_wallpaper::AssetKind::Texture
                        ) && (asset.source == path
                            || asset.variants.iter().any(|variant| variant.file == path))
                    }) {
                        continue;
                    }
                    let identity = format!("{:x}", Sha256::digest(path.as_bytes()));
                    let id = format!("dep-model-{}", &identity[..32]);
                    if manifest.assets.iter().any(|asset| asset.id == id) {
                        return Err(invalid("模型图像依赖身份冲突"));
                    }
                    manifest.assets.push(hertz_wallpaper::AssetDescriptor {
                        id,
                        kind,
                        source: path,
                        variants: vec![],
                    });
                }
            }
            licenses.insert(package.manifest.license.assets.clone());
            let prior =
                collect_attribution(assets, package, cancel, &mut sources, &mut inventories)?;
            let mut source = serde_json::json!({"sourcePackageHash":hash,"workId":package.manifest.work_id,"version":package.manifest.version,"title":package.manifest.title,"codeLicense":package.manifest.license.code,"license":package.manifest.license.assets,"attribution":package.manifest.license.attribution,"priorInventory":prior.root,"assets":selected.iter().map(|r|&r.asset_id).collect::<Vec<_>>()});
            if package.manifest.license.assets == "LicenseRef-inventory" {
                source["licenseSources"] = serde_json::json!(prior.sources);
            }
            if !prior.documents.is_empty() {
                source["licenseDocuments"] = serde_json::json!(prior.documents);
            }
            sources.insert(source_identity(&source)?, source);
            if sources.len() > MAX_ATTRIBUTION_SOURCES {
                return Err(invalid("署名来源超过4096项上限"));
            }
        }
        let inventory=serde_json::to_vec(&serde_json::json!({"kind":"hertzAttribution","formatVersion":2,"sources":sources.into_values().collect::<Vec<_>>(),"inventories":inventories.into_values().collect::<Vec<_>>()})).map_err(invalid)?;
        if inventory.len() > MAX_ATTRIBUTION_BYTES {
            return Err(invalid("完整署名与许可资料超过8 MiB包元数据预算"));
        }
        if !packages.is_empty() {
            manifest.files.push(hertz_wallpaper::FileEntry {
                path: inventory_path.clone(),
                bytes: inventory.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&inventory)),
                mime: "application/json".into(),
            });
            manifest.license.assets = if licenses.len() == 1 {
                licenses.into_iter().next().unwrap()
            } else {
                "LicenseRef-inventory".into()
            };
            manifest.license.attribution =
                format!("Attribution and asset licenses: {inventory_path}");
            if let Some(source) = &document.provenance {
                // Preserve the work's own license, including declarative
                // code:none. Resource attribution is additional, not a license
                // grant for the edited composition or builtin arrangement.
                let original = &packages[&(source.package_hash.clone(), None)]
                    .manifest
                    .license;
                manifest.license.code = original.code.clone();
                manifest.license.assets = original.assets.clone();
            }
        }
        let inputs = composition
            .into_iter()
            .flat_map(|document| &document.bindings)
            .flat_map(|v| &v.program)
            .filter_map(|v| {
                if let hertz_wallpaper::document::Operation::Input { name } = v {
                    Some(name.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        manifest.permissions.audio_spectrum = inputs
            .iter()
            .any(|v| matches!(*v, "energy" | "bass" | "mid" | "high") || v.starts_with("spectrum"));
        manifest.permissions.pointer = inputs.iter().any(|v| v.starts_with("pointer"));
        if composition.is_some() {
            hertz_wallpaper::document::compile_document(&bytes, &manifest).map_err(invalid)?;
        }
        Ok(Self {
            manifest,
            document: bytes,
            pins,
            inventory,
            inventory_path,
        })
    }
    pub(crate) fn maximum_bytes(&self) -> Result<u64> {
        let manifest_bytes = serde_json::to_vec(&self.manifest).map_err(invalid)?.len() as u64;
        let maximum = self
            .manifest
            .files
            .iter()
            .try_fold(manifest_bytes + 1024, |v, f| {
                v.checked_add(f.bytes)
                    .and_then(|v| v.checked_add(512 + 2 * f.path.len() as u64))
                    .ok_or_else(|| invalid("包大小溢出"))
            })?;
        hertz_wallpaper::archive::check_package_bytes(maximum).map_err(invalid)?;
        Ok(maximum)
    }
    pub(crate) fn write(&self, path: &std::path::Path, cancel: &AtomicBool) -> Result<u64> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .open(path)
            .map_err(io)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .last_modified_time(zip::DateTime::default());
        zip.start_file("manifest.json", options).map_err(io)?;
        zip.write_all(&serde_json::to_vec(&self.manifest).map_err(invalid)?)
            .map_err(io)?;
        let mut buffer = [0u8; 65536];
        for entry in &self.manifest.files {
            crate::wallpaper::assets::source_pin_cancelled(cancel)?;
            zip.start_file(&entry.path, options).map_err(io)?;
            if matches!(&self.manifest.content,hertz_wallpaper::Content::Composition{document}if document==&entry.path)
            {
                zip.write_all(&self.document).map_err(io)?;
                continue;
            }
            if entry.path == self.inventory_path {
                zip.write_all(&self.inventory).map_err(io)?;
                continue;
            }
            let pin = self
                .pins
                .get(&entry.path)
                .ok_or_else(|| invalid("缺少固定字节能力"))?;
            let mut reader = crate::wallpaper::assets::open_immutable(&pin.path)?;
            reader.seek(SeekFrom::Start(0)).map_err(io)?;
            let mut hash = Sha256::new();
            let mut length = 0u64;
            loop {
                crate::wallpaper::assets::source_pin_cancelled(cancel)?;
                let n = reader.read(&mut buffer).map_err(io)?;
                if n == 0 {
                    break;
                }
                length = length
                    .checked_add(n as u64)
                    .ok_or_else(|| invalid("资源长度溢出"))?;
                if length > entry.bytes {
                    return Err(invalid("资源长度已变化"));
                }
                hash.update(&buffer[..n]);
                zip.write_all(&buffer[..n]).map_err(io)?;
            }
            if length != entry.bytes || format!("{:x}", hash.finalize()) != entry.sha256 {
                return Err(invalid("固定资源字节身份已变化"));
            }
        }
        let file = zip.finish().map_err(io)?;
        file.sync_all().map_err(io)?;
        Ok(file.metadata().map_err(io)?.len())
    }
}

#[cfg(test)]
mod license_graph_tests {
    use super::*;

    fn add(sources: &mut BTreeMap<String, Value>, source: Value) -> String {
        let id = source_identity(&source).unwrap();
        sources.insert(id.clone(), source);
        id
    }

    #[test]
    fn source_edge_and_work_boundaries_are_explicit_and_linear() {
        let mut sources = BTreeMap::new();
        let leaves: Vec<_> = (0..3072).map(|index| add(&mut sources, serde_json::json!({"sourcePackageHash":format!("{index:064x}"),"license":"CC0-1.0"}))).collect();
        for index in 0..1024 {
            add(
                &mut sources,
                serde_json::json!({"sourcePackageHash":format!("{:064x}",index+3072),"license":"LicenseRef-inventory","licenseSources":(0..16).map(|offset| &leaves[(index+offset)%leaves.len()]).collect::<Vec<_>>()}),
            );
        }
        assert_eq!(sources.len(), MAX_ATTRIBUTION_SOURCES);
        assert_eq!(
            validate_license_graph(&sources).unwrap(),
            MAX_LICENSE_GRAPH_WORK
        );
        let key = sources
            .iter()
            .find(|(_, source)| source["license"] == "LicenseRef-inventory")
            .unwrap()
            .0
            .clone();
        let children = sources.get_mut(&key).unwrap()["licenseSources"]
            .as_array_mut()
            .unwrap();
        let extra = leaves
            .iter()
            .find(|id| !children.iter().any(|child| child == id.as_str()))
            .unwrap();
        children.push(serde_json::json!(extra));
        assert!(validate_license_graph(&sources)
            .unwrap_err()
            .message
            .contains("16384"));
        sources.get_mut(&key).unwrap()["licenseSources"]
            .as_array_mut()
            .unwrap()
            .pop();
        add(
            &mut sources,
            serde_json::json!({"sourcePackageHash":"f".repeat(64),"license":"CC-BY-4.0"}),
        );
        assert!(validate_license_graph(&sources)
            .unwrap_err()
            .message
            .contains("4096"));
    }

    #[test]
    fn graph_depth_boundary_and_cycles_fail_without_repeated_source_scans() {
        let mut sources = BTreeMap::new();
        let mut previous = add(
            &mut sources,
            serde_json::json!({"sourcePackageHash":"a".repeat(64),"license":"CC0-1.0"}),
        );
        for index in 0..MAX_LICENSE_DEPTH {
            previous = add(
                &mut sources,
                serde_json::json!({"sourcePackageHash":format!("{index:064x}"),"license":"LicenseRef-inventory","licenseSources":[previous]}),
            );
        }
        assert_eq!(
            validate_license_graph(&sources).unwrap(),
            1 + 3 * MAX_LICENSE_DEPTH
        );
        add(
            &mut sources,
            serde_json::json!({"sourcePackageHash":"b".repeat(64),"license":"LicenseRef-inventory","licenseSources":[previous]}),
        );
        assert!(validate_license_graph(&sources)
            .unwrap_err()
            .message
            .contains("64"));
        let id = "c".repeat(64);
        let cycle = BTreeMap::from([(
            id.clone(),
            serde_json::json!({"sourcePackageHash":"d".repeat(64),"license":"LicenseRef-inventory","licenseSources":[id]}),
        )]);
        assert_eq!(
            validate_license_graph(&cycle).unwrap_err().code,
            "derivative_license_required"
        );
    }
}
