// SPDX-License-Identifier: MIT
//! Exact model topology and attribution closure publication regressions.
use super::*;
use crate::wallpaper::library::{tempfileish, InstallWork, Library, LOCAL_SOURCE};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use serde_json::json;
use std::io::Cursor;

async fn install_model_source(
    library: &Library,
    assets: &AssetStore,
    external: bool,
    index: u32,
    uri: &str,
) -> (String, String, Vec<u8>, Vec<u8>) {
    install_model_source_with_extra(library, assets, external, index, uri, false).await
}

async fn install_model_source_with_extra(
    library: &Library,
    assets: &AssetStore,
    external: bool,
    index: u32,
    uri: &str,
    extra_model: bool,
) -> (String, String, Vec<u8>, Vec<u8>) {
    let mut pixels = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(
        2,
        2,
        Rgba([255, (index * 100) as u8, 0, 255]),
    ))
    .write_to(&mut pixels, ImageFormat::Png)
    .unwrap();
    let png = pixels.into_inner();
    let model = textured_model_glb(external, index, &png, uri);
    let path = if uri.len() > hertz_wallpaper::MAX_PATH_BYTES - "assets/".len() {
        "model.glb"
    } else if uri.split('/').next() == Some("model.glb") {
        "assets/source.glb"
    } else {
        "assets/model.glb"
    };
    let mut entries = vec![(path.to_owned(), model.clone(), "model/gltf-binary")];
    let mut descriptors = vec![json!({"id":"model","kind":"model","source":path,"variants":[]})];
    if external {
        let image_path = path.rsplit_once('/').map_or_else(
            || uri.to_owned(),
            |(directory, _)| format!("{directory}/{uri}"),
        );
        entries.push((image_path.clone(), png.clone(), "image/png"));
        descriptors.push(json!({"id":"texture","kind":"image","source":image_path,"variants":[]}));
    }
    if extra_model {
        entries.push((
            "assets/other.glb".into(),
            textured_model_glb(true, 1, &png, uri),
            "model/gltf-binary",
        ));
        descriptors.push(
            json!({"id":"other-model","kind":"model","source":"assets/other.glb","variants":[]}),
        );
    }
    let work = uuid::Uuid::new_v4().to_string();
    let work_key = format!("local-{work}");
    let manifest = json!({"formatVersion":1,"workId":work,"version":1,"title":format!("Model {index}"),"description":"","content":{"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}},"assets":descriptors,"files":entries.iter().map(|(path,bytes,mime)|json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":mime})).collect::<Vec<_>>(),"properties":[],"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"CC0-1.0","attribution":format!("Model author {index}")}});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    for (path, bytes, _) in entries {
        zip.start_file(path, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    let input = assets.root().join(format!("model-{index}.hwpkg"));
    std::fs::write(&input, zip.finish().unwrap().into_inner()).unwrap();
    let job = format!("model-install-{index}");
    assets.snapshot_input(&job, &input, None).unwrap();
    let package = assets.validate_staged(&job).unwrap();
    assets.unpack_projection(&job, &package).unwrap();
    let source = assets
        .read_staging_source(&job, &package.package_hash)
        .unwrap();
    for model in source
        .manifest
        .assets
        .iter()
        .filter(|asset| asset.kind == hertz_wallpaper::AssetKind::Model)
    {
        let pinned = assets
            .pin_package_entry(&source, &model.source, &AtomicBool::new(false))
            .unwrap();
        hertz_wallpaper::model_structure::inspect_glb_resource(
            crate::wallpaper::assets::open_immutable(&pinned.path).unwrap(),
            pinned.entry.bytes,
            &package.manifest,
            &model.source,
        )
        .unwrap();
    }
    drop(source);
    let bytes = std::fs::metadata(assets.staging_dir(&job).join("original.hwpkg"))
        .unwrap()
        .len();
    assets
        .content_writer()
        .unwrap()
        .publish_staging(&job, &package.package_hash)
        .unwrap();
    library
        .install(&InstallWork {
            remote_work_id: work,
            work_key: work_key.clone(),
            title: package.manifest.title.clone(),
            description: String::new(),
            kind: "builtin".into(),
            package_hash: package.package_hash.clone(),
            manifest_json: package.manifest_json,
            package_bytes: bytes,
            version: 1,
            source_id: LOCAL_SOURCE.into(),
        })
        .await
        .unwrap();
    (work_key, package.package_hash, model, png)
}

fn model_document(sources: &[(String, String, Vec<u8>, Vec<u8>)]) -> Document {
    serde_json::from_value(json!({"title":"Two models","composition":{"documentVersion":1,"canvas":{"width":640,"height":360,"colorSpace":"srgb","background":"#000000","scene3d":{"position":[0,0,3],"target":[0,0,0],"fovDegrees":45,"near":0.1,"far":100}},"nodes":sources.iter().enumerate().map(|(index,_)|json!({"id":format!("model-{index}"),"type":"model","stateVersion":1,"assets":{"asset":format!("model-resource-{index}")},"properties":{}})).collect::<Vec<_>>(),"effects":[],"timeline":{"durationSeconds":1,"loop":true,"tracks":[]},"bindings":[]},"resources":sources.iter().enumerate().map(|(index,(work,hash,_,_))|json!({"assetId":format!("model-resource-{index}"),"kind":"model","workKey":work,"packageHash":hash,"sourceAssetId":"model"})).collect::<Vec<_>>()})).unwrap()
}

async fn publish_model_set(
    external: bool,
    shared_image: bool,
    uri: &str,
    count: u32,
) -> (String, String) {
    let root = tempfileish::temp_dir(if external {
        "two-external-model-topologies"
    } else {
        "two-embedded-models"
    });
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let mut sources = Vec::new();
    if shared_image {
        let source = install_model_source_with_extra(&library, &assets, true, 0, uri, true).await;
        let other = (
            source.0.clone(),
            source.1.clone(),
            textured_model_glb(true, 1, &source.3, uri),
            source.3.clone(),
        );
        sources.push(source);
        sources.push(other);
    } else {
        for index in 0..count {
            sources.push(install_model_source(&library, &assets, external, index, uri).await);
        }
    }
    let mut document = model_document(&sources);
    if shared_image {
        document.resources[1].source_asset_id = "other-model".into();
    }
    let drafts = WorkDrafts::new(&library);
    let draft = drafts.create_owned(document, None, None).await.unwrap();
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
    fn metadata(
        assets: &AssetStore,
        package: &crate::wallpaper::assets::StagedPackage,
    ) -> (String, String, Value) {
        let hertz_wallpaper::Content::Composition { document } = &package.manifest.content else {
            panic!("Published package must declare its composition document")
        };
        let pin = assets
            .pin_package_entry(package, document, &AtomicBool::new(false))
            .unwrap();
        let bytes = std::fs::read(&pin.path).unwrap();
        hertz_wallpaper::document::compile_document(&bytes, &package.manifest).unwrap();
        let inventory_path = package
            .manifest
            .license
            .attribution
            .strip_prefix("Attribution and asset licenses: ")
            .expect("Published attribution must name its actual inventory");
        assert!(package.manifest.file(inventory_path).is_some());
        let pin = assets
            .pin_package_entry(package, inventory_path, &AtomicBool::new(false))
            .unwrap();
        let inventory: Value = serde_json::from_slice(&std::fs::read(&pin.path).unwrap()).unwrap();
        assert_eq!(inventory["kind"], "hertzAttribution");
        assert_eq!(inventory["formatVersion"], 2);
        (document.clone(), inventory_path.into(), inventory)
    }
    let (first_document, first_inventory_path, first_inventory) = metadata(&assets, &first_package);
    let (second_document, second_inventory_path, second_inventory) =
        metadata(&assets, &second_package);
    assert_eq!(first_document, second_document);
    assert_eq!(first_inventory_path, second_inventory_path);
    assert_eq!(
        first_inventory["inventories"], second_inventory["inventories"],
        "original attribution inventory identities must survive republication"
    );
    for (_, hash, _, _) in &sources {
        let original = assets.read_installed_manifest(hash).unwrap();
        assert!(
            second_inventory["sources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|source| source["sourcePackageHash"] == *hash
                    && source["attribution"] == original.manifest.license.attribution),
            "original model author must survive the inventory pointer on republication"
        );
    }
    assert_eq!(
        first_package.manifest.assets.len(),
        second_package.manifest.assets.len(),
        "dependency descriptors must not grow each publication"
    );
    for (index, (_, _, model, png)) in sources.iter().enumerate() {
        let id = format!("model-resource-{index}");
        let first_asset = first_package
            .manifest
            .assets
            .iter()
            .find(|a| a.id == id)
            .unwrap();
        let asset = second_package
            .manifest
            .assets
            .iter()
            .find(|a| a.id == id)
            .unwrap();
        assert_eq!(first_asset.source, asset.source);
        let pin = assets
            .pin_package_entry(&second_package, &asset.source, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(std::fs::read(&pin.path).unwrap(), *model);
        let verified = hertz_wallpaper::model_structure::inspect_glb_resource(
            crate::wallpaper::assets::open_immutable(&pin.path).unwrap(),
            pin.entry.bytes,
            &second_package.manifest,
            &asset.source,
        )
        .unwrap();
        for image in &verified.structure.images {
            if let hertz_wallpaper::model_structure::ModelImage::Package { path, .. } = image {
                let image_pin = assets
                    .pin_package_entry(&second_package, path, &AtomicBool::new(false))
                    .unwrap();
                assert_eq!(std::fs::read(&image_pin.path).unwrap(), *png);
            }
        }
    }
    let exported = std::fs::read(
        assets
            .package_dir(&second.package_hash)
            .join("original.hwpkg"),
    )
    .unwrap();
    assert!(matches!(
        hertz_wallpaper::validate_package(Cursor::new(exported))
            .unwrap()
            .manifest
            .content,
        hertz_wallpaper::Content::Composition { .. }
    ));
    library.pool().close().await;
    (second_document, second_inventory_path)
}

#[tokio::test]
async fn two_external_models_with_same_relative_texture_name_keep_exact_bytes_after_two_publications(
) {
    publish_model_set(true, false, "textures/red.png", 2).await;
}
#[tokio::test]
async fn two_embedded_models_with_same_original_path_publish_as_stable_hash_resources() {
    publish_model_set(false, false, "textures/red.png", 2).await;
}

#[tokio::test]
async fn two_models_sharing_one_original_image_get_each_required_topology_copy() {
    publish_model_set(true, true, "textures/red.png", 2).await;
}

#[tokio::test]
async fn thirty_two_models_with_178_byte_relative_images_get_stable_distinct_directories() {
    let uri = format!("{}.png", "x".repeat(174));
    assert_eq!(uri.len(), 178);
    publish_model_set(true, false, &uri, 32).await;
}

#[tokio::test]
async fn an_image_named_model_glb_keeps_its_relative_uri_and_does_not_replace_the_model_file() {
    publish_model_set(true, false, "model.glb", 2).await;
}

#[tokio::test]
async fn an_image_directory_named_model_glb_does_not_conflict_with_the_new_model_leaf() {
    publish_model_set(true, false, "model.glb/texture.png", 2).await;
}

#[tokio::test]
async fn a_180_byte_root_model_uri_keeps_a_compatible_root_placement() {
    let uri = format!("{}.png", "x".repeat(176));
    assert_eq!(uri.len(), 180);
    publish_model_set(true, false, &uri, 1).await;
}

#[tokio::test]
async fn a_180_byte_root_uri_can_use_documents_main_json_as_an_image_directory() {
    let prefix = "documents/main.json/";
    let uri = format!("{prefix}{}.png", "x".repeat(180 - prefix.len() - 4));
    assert_eq!(uri.len(), 180);
    let (document, inventory) = publish_model_set(true, false, &uri, 1).await;
    assert_ne!(document, "documents/main.json");
    assert_ne!(inventory, "documents/attribution.json");
}

#[tokio::test]
async fn conflicting_180_byte_root_uris_prove_the_immutable_namespace_contract_limit() {
    let root = tempfileish::temp_dir("model-uri-namespace-limit");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let uri = format!("{}.png", "x".repeat(176));
    assert_eq!(uri.len(), hertz_wallpaper::MAX_PATH_BYTES);
    let first = install_model_source(&library, &assets, true, 0, &uri).await;
    let second = install_model_source(&library, &assets, true, 1, &uri).await;
    assert_ne!(
        first.3, second.3,
        "The same fixed URI must require two different exact image byte sets"
    );
    let document = model_document(&[first, second]);
    let error=match PackageBuild::resolve(&document,&uuid::Uuid::new_v4().to_string(),1,&assets,&AtomicBool::new(false)){Err(error)=>error,Ok(_)=>panic!("An independent directory cannot fit before a legal 180-byte root URI without rewriting immutable GLB bytes")};
    assert_eq!(error.code, "composition_resource_namespace_limit");
    assert!(error.message.contains("180"));
    library.pool().close().await;
}

#[tokio::test]
async fn identical_attribution_wrappers_keep_each_sources_distinct_inner_author() {
    let root = tempfileish::temp_dir("two-attribution-relative-contexts");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let mut sources = Vec::new();
    for author in ["Author A", "Author B"] {
        let (work, hash, png) =
            super::tests::install_source_with_attribution(&library, &assets, false, 1, author)
                .await;
        sources.push((work, hash, png, Vec::new()));
    }
    let mut document = model_document(&sources);
    document.composition.as_mut().unwrap().canvas.scene3d = None;
    for (index, node) in document
        .composition
        .as_mut()
        .unwrap()
        .nodes
        .iter_mut()
        .enumerate()
    {
        node.node_type = "image".into();
        document.resources[index].kind = hertz_wallpaper::AssetKind::Image;
        document.resources[index].source_asset_id = "pixel-0".into();
    }
    let drafts = WorkDrafts::new(&library);
    let draft = drafts.create_owned(document, None, None).await.unwrap();
    drafts.save(&draft.id, 1).await.unwrap();
    let first = drafts.publish(&draft.id, 1, &assets).await.unwrap();
    let reopened = drafts
        .create_from_version(&first.work_key, &first.package_hash, &assets)
        .await
        .unwrap();
    drafts.save(&reopened.id, 1).await.unwrap();
    let second = drafts.publish(&reopened.id, 1, &assets).await.unwrap();
    fn read_inventory(assets: &AssetStore, hash: &str) -> Value {
        let package = assets.read_installed_manifest(hash).unwrap();
        let pin = assets
            .pin_package_entry(
                &package,
                "documents/attribution.json",
                &AtomicBool::new(false),
            )
            .unwrap();
        serde_json::from_slice(&std::fs::read(&pin.path).unwrap()).unwrap()
    }
    let first_inventory = read_inventory(&assets, &first.package_hash);
    let second_inventory = read_inventory(&assets, &second.package_hash);
    assert_eq!(
        first_inventory["inventories"], second_inventory["inventories"],
        "original inventory identities must remain stable"
    );
    for (index, author) in ["Author A", "Author B"].iter().enumerate() {
        let source = second_inventory["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["sourcePackageHash"] == sources[index].1)
            .unwrap();
        let root_id = source["priorInventory"].as_str().unwrap();
        let root = second_inventory["inventories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|inventory| inventory["id"] == root_id)
            .unwrap();
        let inner_id = root["references"][0]["id"].as_str().unwrap();
        let inner = second_inventory["inventories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|inventory| inventory["id"] == inner_id)
            .unwrap();
        assert!(
            inner["raw"].as_str().unwrap().contains(author),
            "source {index} lost its own author"
        );
    }
    library.pool().close().await;
}

fn textured_model_glb(external: bool, index: u32, png: &[u8], uri: &str) -> Vec<u8> {
    let mut bin = vec![0_u8; if external { 104 } else { 104 + png.len() }];
    for (index, value) in [
        0.0_f32,
        0.0,
        0.0,
        1.0 + index as f32,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
    ]
    .iter()
    .enumerate()
    {
        bin[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    for (index, value) in [0.0_f32, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]
        .iter()
        .enumerate()
    {
        bin[36 + index * 4..36 + index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    for (index, value) in [0.0_f32, 0.0, 1.0, 0.0, 0.0, 1.0].iter().enumerate() {
        bin[72 + index * 4..72 + index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    for (index, value) in [0_u16, 1, 2].iter().enumerate() {
        bin[96 + index * 2..96 + index * 2 + 2].copy_from_slice(&value.to_le_bytes());
    }
    bin[104..].copy_from_slice(if external { &[] } else { png });
    let views = if external {
        json!([{"buffer":0,"byteOffset":0,"byteLength":36},
            {"buffer":0,"byteOffset":36,"byteLength":36},
            {"buffer":0,"byteOffset":72,"byteLength":24},
            {"buffer":0,"byteOffset":96,"byteLength":8}])
    } else {
        json!([{"buffer":0,"byteOffset":0,"byteLength":36},
            {"buffer":0,"byteOffset":36,"byteLength":36},
            {"buffer":0,"byteOffset":72,"byteLength":24},
            {"buffer":0,"byteOffset":96,"byteLength":8},
            {"buffer":0,"byteOffset":104,"byteLength":png.len()}])
    };
    let document = json!({
        "asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1,"TEXCOORD_0":3},
            "indices":2,"material":0}]}],
        "buffers":[{"byteLength":bin.len()}],
        "bufferViews":views,
        "accessors":[
            {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1+index,1,0]},
            {"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"},
            {"bufferView":3,"componentType":5123,"count":3,"type":"SCALAR"},
            {"bufferView":2,"componentType":5126,"count":3,"type":"VEC2"}],
        "images":[if external {json!({"uri":uri,"mimeType":"image/png"})}
            else {json!({"bufferView":4,"mimeType":"image/png"})}],
        "samplers":[{"magFilter":9728,"minFilter":9728,"wrapS":33071,"wrapT":33071}],
        "textures":[{"source":0,"sampler":0}],
        "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[1,1,1,1],
            "baseColorTexture":{"index":0,"texCoord":0},"metallicFactor":0,"roughnessFactor":1},
            "alphaMode":"OPAQUE"}]
    });
    let text = serde_json::to_vec(&document).unwrap();
    let json_len = text.len().div_ceil(4) * 4;
    let bin_len = bin.len().div_ceil(4) * 4;
    let total = 12 + 8 + json_len + 8 + bin_len;
    let mut bytes = vec![0_u8; total];
    bytes[0..4].copy_from_slice(b"glTF");
    bytes[4..8].copy_from_slice(&2_u32.to_le_bytes());
    bytes[8..12].copy_from_slice(&(total as u32).to_le_bytes());
    bytes[12..16].copy_from_slice(&(json_len as u32).to_le_bytes());
    bytes[16..20].copy_from_slice(b"JSON");
    bytes[20..20 + text.len()].copy_from_slice(&text);
    bytes[20 + text.len()..20 + json_len].fill(0x20);
    let head = 20 + json_len;
    bytes[head..head + 4].copy_from_slice(&(bin_len as u32).to_le_bytes());
    bytes[head + 4..head + 8].copy_from_slice(b"BIN\0");
    bytes[head + 8..head + 8 + bin.len()].copy_from_slice(&bin);
    bytes
}
