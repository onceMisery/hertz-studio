// SPDX-License-Identifier: MIT
//! Model closure identity and bounded deterministic directory placement.
use super::*;
use hertz_wallpaper::{model_structure::ModelImage, AssetKind};
type SourceKey = (String, Option<String>);
pub(super) type Plans = BTreeMap<(SourceKey, String), Plan>;
pub(super) struct ImagePlacement {
    pub path: String,
    pub relative: String,
    pub kind: AssetKind,
}
pub(super) struct Plan {
    pub namespace: String,
    pub leaf: String,
    pub images: Vec<ImagePlacement>,
    topology: String,
    model_sha256: String,
}
struct Topology {
    label_bytes: usize,
    files: BTreeMap<String, (String, String)>,
}
pub(super) struct ModelLayout {
    pub plans: Plans,
    pub assets: String,
    pub documents: String,
}

fn choose_model_leaf(model_sha256: &str, forbidden: &BTreeSet<String>) -> String {
    for index in 0..=forbidden.len() {
        let leaf = if index == 0 {
            format!("{model_sha256}.glb")
        } else {
            format!("{model_sha256}-{index}.glb")
        };
        if !forbidden.contains(&leaf) {
            return leaf;
        }
    }
    unreachable!("N forbidden names cannot cover N+1 distinct leaf candidates")
}
fn label(mut ordinal: u64, length: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789-_.";
    let mut bytes = vec![ALPHABET[0]; length];
    for byte in bytes.iter_mut().rev() {
        *byte = ALPHABET[(ordinal % ALPHABET.len() as u64) as usize];
        ordinal /= ALPHABET.len() as u64;
    }
    String::from_utf8(bytes).expect("path alphabet is ASCII")
}
fn safe_directory(base: &str, forbidden: &BTreeSet<String>) -> String {
    for index in 0..=forbidden.len() {
        let candidate = if index == 0 {
            base.into()
        } else {
            format!("{base}-{index}")
        };
        if !forbidden.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("N forbidden components cannot cover N+1 candidates")
}
fn merge_root(
    files: &mut BTreeMap<String, (String, String)>,
    incoming: &BTreeMap<String, (String, String)>,
) -> Result<()> {
    for (path, identity) in incoming {
        if files.get(path).is_some_and(|prior| prior != identity)
            || files.keys().any(|prior| {
                prior != path
                    && (path.starts_with(&format!("{prior}/"))
                        || prior.starts_with(&format!("{path}/")))
            })
        {
            return Err(JobError::new(
                "composition_resource_namespace_limit",
                "根层模型URI要求冲突字节或文件/目录，而180字节合同不允许增加最短2字节目录前缀",
            ));
        }
        files.insert(path.clone(), identity.clone());
    }
    Ok(())
}
fn allocate(
    topologies: BTreeMap<String, Topology>,
) -> Result<(BTreeMap<String, String>, BTreeSet<String>)> {
    let mut ordered: Vec<_> = topologies.into_iter().collect();
    ordered.sort_by(|a, b| (a.1.label_bytes, &a.0).cmp(&(b.1.label_bytes, &b.0)));
    let mut root_files = BTreeMap::new();
    for (_, topology) in ordered
        .iter()
        .filter(|(_, topology)| topology.label_bytes == 0)
    {
        merge_root(&mut root_files, &topology.files)?;
    }
    let mut root_components = root_files
        .keys()
        .map(|path| path.split('/').next().expect("URI is nonempty").to_owned())
        .collect::<BTreeSet<_>>();
    let mut next = BTreeMap::<usize, u64>::new();
    let mut assigned = BTreeMap::<String, String>::new();
    for (identity, topology) in ordered {
        if topology.label_bytes == 0 {
            assigned.insert(identity, String::new());
            continue;
        }
        let mut placement = None;
        for length in 1..=topology.label_bytes {
            let capacity = 39_u64.checked_pow(length as u32).unwrap_or(u64::MAX);
            let cursor = next.entry(length).or_default();
            while *cursor < capacity {
                let candidate = label(*cursor, length);
                *cursor += 1;
                if root_components.contains(&candidate)
                    || matches!(candidate.as_str(), "assets" | "documents" | "manifest.json")
                    || hertz_wallpaper::paths::validate_rel_path(&format!("{candidate}/model.glb"))
                        .is_err()
                {
                    continue;
                }
                placement = Some(format!("{candidate}/"));
                break;
            }
            if placement.is_some() {
                break;
            }
        }
        let placement = if let Some(placement) = placement {
            placement
        } else {
            let mut compatible = root_files.clone();
            merge_root(&mut compatible, &topology.files)?;
            let components = topology
                .files
                .keys()
                .map(|path| path.split('/').next().expect("URI is nonempty").to_owned())
                .collect::<BTreeSet<_>>();
            if assigned.values().any(|prefix| {
                !prefix.is_empty() && components.contains(prefix.trim_end_matches('/'))
            }) {
                return Err(JobError::new(
                    "composition_resource_namespace_capacity",
                    "路径余量内全部合法目录被固定根层资源占用",
                ));
            }
            root_files = compatible;
            root_components.extend(components);
            String::new()
        };
        assigned.insert(identity, placement);
    }
    Ok((assigned, root_components))
}
pub(super) fn resolve(
    document: &Document,
    packages: &BTreeMap<SourceKey, crate::wallpaper::assets::StagedPackage>,
    assets: &AssetStore,
    cancel: &AtomicBool,
) -> Result<ModelLayout> {
    let mut plans = Plans::new();
    let mut topologies = BTreeMap::<String, Topology>::new();
    for (source_key, package) in packages {
        let mut model_paths = BTreeSet::new();
        for selected in document.resources.iter().filter(|r| {
            r.package_hash == source_key.0
                && r.candidate_id == source_key.1
                && r.kind == AssetKind::Model
        }) {
            let asset = package
                .manifest
                .assets
                .iter()
                .find(|a| a.id == selected.source_asset_id && a.kind == AssetKind::Model)
                .ok_or_else(|| invalid("固定模型描述符缺失或kind已变化"))?;
            model_paths.insert(asset.source.clone());
            model_paths.extend(asset.variants.iter().map(|v| v.file.clone()));
        }
        for model_path in model_paths {
            let pin = assets.pin_package_entry(package, &model_path, cancel)?;
            let model = hertz_wallpaper::model_structure::inspect_glb_resource(
                crate::wallpaper::assets::open_immutable(&pin.path)?,
                pin.entry.bytes,
                &package.manifest,
                &model_path,
            )
            .map_err(invalid)?;
            let directory = model_path
                .rsplit_once('/')
                .map(|(d, _)| format!("{d}/"))
                .unwrap_or_default();
            let mut images = Vec::new();
            let mut closure = BTreeMap::new();
            let mut forbidden = BTreeSet::new();
            let mut longest = 0usize;
            for image in &model.structure.images {
                if let ModelImage::Package {
                    path,
                    mime,
                    sha256,
                    references,
                    ..
                } = image
                {
                    let relative = path
                        .strip_prefix(&directory)
                        .ok_or_else(|| invalid("模型图像相对路径无效"))?
                        .to_owned();
                    longest = longest.max(relative.len());
                    forbidden.insert(
                        relative
                            .split('/')
                            .next()
                            .expect("URI is nonempty")
                            .to_owned(),
                    );
                    let reference = references
                        .first()
                        .ok_or_else(|| invalid("模型图像未绑定资源描述符"))?;
                    let kind = package
                        .manifest
                        .assets
                        .iter()
                        .find(|a| a.id == reference.asset_id)
                        .ok_or_else(|| invalid("模型图像描述符缺失"))?
                        .kind;
                    closure.insert(relative.clone(), (mime.clone(), sha256.clone()));
                    images.push(ImagePlacement {
                        path: path.clone(),
                        relative,
                        kind,
                    });
                }
            }
            if images.is_empty() {
                continue;
            }
            let entry = package
                .manifest
                .file(&model_path)
                .ok_or_else(|| invalid("模型未被包索引"))?;
            let leaf = choose_model_leaf(&entry.sha256, &forbidden);
            let label_bytes = hertz_wallpaper::MAX_PATH_BYTES
                .saturating_sub(longest + 1)
                .min(hertz_wallpaper::MAX_PATH_BYTES.saturating_sub(leaf.len() + 1));
            let topology = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&closure).map_err(invalid)?)
            );
            topologies
                .entry(topology.clone())
                .and_modify(|p| p.label_bytes = p.label_bytes.min(label_bytes))
                .or_insert(Topology {
                    label_bytes,
                    files: closure,
                });
            plans.insert(
                (source_key.clone(), model_path),
                Plan {
                    namespace: String::new(),
                    leaf,
                    images,
                    topology,
                    model_sha256: entry.sha256.clone(),
                },
            );
        }
    }
    let (namespaces, mut root_components) = allocate(topologies)?;
    root_components.extend(namespaces.values().filter_map(|namespace| {
        namespace
            .strip_suffix('/')
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
    }));
    for plan in plans.values_mut() {
        plan.namespace = namespaces
            .get(&plan.topology)
            .expect("each model registered a topology")
            .clone();
        if plan.namespace.is_empty() {
            plan.leaf = choose_model_leaf(&plan.model_sha256, &root_components);
        }
    }
    for plan in plans.values() {
        if plan.namespace.is_empty() {
            root_components.insert(plan.leaf.clone());
        }
    }
    let assets = safe_directory("assets", &root_components);
    root_components.insert(assets.clone());
    let documents = safe_directory("documents", &root_components);
    Ok(ModelLayout {
        plans,
        assets,
        documents,
    })
}
