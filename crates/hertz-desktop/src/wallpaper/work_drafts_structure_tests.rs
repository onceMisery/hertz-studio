// SPDX-License-Identifier: MIT
//! Real WorkDrafts/SQLite/compiler checks for authored hierarchy and order edits.
use super::super::{Document, Update, WorkDrafts};
use crate::wallpaper::library::tempfileish;
use crate::wallpaper::{assets::AssetStore, library::Library};
use serde_json::{json, Value};
use std::io::{Cursor, Read};

fn document() -> Document {
    serde_json::from_value(json!({"title":"Layer structure", "composition":{
        "documentVersion":1,"canvas":{"width":640,"height":360,"colorSpace":"srgb","background":"#101010"},
        "nodes":[
            {"id":"outer","type":"group","stateVersion":1,"children":["inner","leaf-a"],"properties":{"space":"2d","opacity":0.5}},
            {"id":"leaf-a","type":"particles","stateVersion":1,"properties":{"count":8,"opacity":0.6}},
            {"id":"inner","type":"group","stateVersion":1,"children":["leaf-b"],"properties":{"space":"2d","opacity":0.7}},
            {"id":"leaf-b","type":"particles","stateVersion":1,"properties":{"count":8}},
            {"id":"other","type":"group","stateVersion":1,"properties":{"space":"2d"}},
            {"id":"spatial","type":"group","stateVersion":1,"properties":{"space":"3d"}}
        ],"effects":[
            {"id":"adjust","type":"colorAdjust","stateVersion":1,"target":{"kind":"output"},"properties":{}},
            {"id":"glow","type":"glow","stateVersion":1,"target":{"kind":"output"},"properties":{}}
        ],"timeline":{"durationSeconds":10,"loop":true,"tracks":[]},"bindings":[]
    }})).unwrap()
}

fn operation(value: Value) -> Update {
    serde_json::from_value(value).unwrap()
}

fn node_ids(document: &Document) -> Vec<String> {
    document
        .composition
        .as_ref()
        .unwrap()
        .nodes
        .iter()
        .map(|node| node.id.clone())
        .collect()
}

#[tokio::test]
async fn hierarchy_and_order_survive_save_reopen_and_immutable_package() {
    let root = tempfileish::temp_dir("work-tree-save");
    let assets = AssetStore::new(root.path()).unwrap();
    let library = Library::open(root.path()).await.unwrap();
    let drafts = WorkDrafts::new(&library);
    let created = drafts.create(document()).await.unwrap();
    let changed = drafts
        .update(
            &created.id,
            created.revision,
            vec![
                operation(json!({"kind":"moveNode","nodeId":"leaf-a","parentId":"inner","index":0})),
                operation(json!({"kind":"reorderNodes","ids":["other","leaf-b","inner","leaf-a","outer","spatial"]})),
                operation(json!({"kind":"reorderEffects","ids":["glow","adjust"]})),
            ],
        )
        .await
        .unwrap();
    assert_eq!(changed.revision, created.revision + 1);
    assert_eq!(changed.saved_revision, None);
    assert_eq!(
        drafts
            .publish(&created.id, changed.revision, &assets)
            .await
            .unwrap_err()
            .code,
        "draft_not_saved"
    );
    let saved = drafts.save(&created.id, changed.revision).await.unwrap();
    let expected = serde_json::to_value(saved.document.composition.as_ref().unwrap()).unwrap();
    assert_eq!(
        expected["nodes"][2]["children"],
        json!(["leaf-a", "leaf-b"])
    );
    assert_eq!(expected["nodes"][4]["children"], json!(["inner"]));
    assert_eq!(expected["effects"][0]["id"], "glow");
    let published = drafts
        .publish(&created.id, saved.revision, &assets)
        .await
        .unwrap();
    assert_eq!(
        drafts
            .publish(&created.id, saved.revision, &assets)
            .await
            .unwrap(),
        published
    );
    let bytes = std::fs::read(
        assets
            .package_dir(&published.package_hash)
            .join("original.hwpkg"),
    )
    .unwrap();
    let package = hertz_wallpaper::validate_package(Cursor::new(&bytes)).unwrap();
    let hertz_wallpaper::Content::Composition { document: path } = &package.manifest.content else {
        panic!("must publish a composition");
    };
    let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
    let mut author_bytes = Vec::new();
    archive
        .by_name(path)
        .unwrap()
        .read_to_end(&mut author_bytes)
        .unwrap();
    let compiled =
        hertz_wallpaper::document::compile_document(&author_bytes, &package.manifest).unwrap();
    let order: Vec<_> = compiled
        .ir()
        .painter_order()
        .iter()
        .map(|index| compiled.ir().nodes()[*index].id.as_str())
        .collect();
    assert_eq!(
        order,
        ["other", "outer", "inner", "leaf-a", "leaf-b", "spatial"]
    );
    let author: Value = serde_json::from_slice(&author_bytes).unwrap();
    assert_eq!(
        author["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        node_ids(&saved.document)
    );
    assert_eq!(
        author["nodes"][2]["children"],
        expected["nodes"][2]["children"]
    );
    assert_eq!(author["effects"][0]["id"], "glow");
    library.pool().close().await;
    drop(drafts);
    drop(library);
    let reopened = Library::open(root.path()).await.unwrap();
    let reopened_draft = WorkDrafts::new(&reopened).get(&created.id).await.unwrap();
    assert_eq!(reopened_draft.document, saved.document);
    assert_eq!(reopened_draft.saved_revision, Some(saved.revision));
    assert_eq!(
        std::fs::read(
            assets
                .package_dir(&published.package_hash)
                .join("original.hwpkg")
        )
        .unwrap(),
        bytes
    );
    reopened.pool().close().await;
}

#[tokio::test]
async fn invalid_moves_and_incomplete_orders_do_not_write_any_part_of_the_revision() {
    let root = tempfileish::temp_dir("work-tree-invalid");
    let library = Library::open(root.path()).await.unwrap();
    let drafts = WorkDrafts::new(&library);
    let created = drafts.create(document()).await.unwrap();
    for invalid in [
        json!({"kind":"moveNode","nodeId":"outer","parentId":"inner","index":0}),
        json!({"kind":"moveNode","nodeId":"leaf-a","parentId":"spatial","index":0}),
        json!({"kind":"moveNode","nodeId":"outer","parentId":"outer","index":0}),
        json!({"kind":"moveNode","nodeId":"leaf-a","parentId":"leaf-b","index":0}),
        json!({"kind":"moveNode","nodeId":"missing","parentId":null,"index":0}),
        json!({"kind":"moveNode","nodeId":"leaf-a","parentId":"missing","index":0}),
        json!({"kind":"moveNode","nodeId":"leaf-a","parentId":"inner","index":2}),
        json!({"kind":"moveNode","nodeId":"leaf-a","parentId":null,"index":4}),
        json!({"kind":"reorderNodes","ids":["outer","leaf-a","inner","leaf-b","other","other"]}),
        json!({"kind":"reorderNodes","ids":["outer","leaf-a","inner","leaf-b","other"]}),
        json!({"kind":"reorderNodes","ids":["outer","leaf-a","inner","leaf-b","other","missing"]}),
        json!({"kind":"reorderEffects","ids":["adjust","adjust"]}),
        json!({"kind":"reorderEffects","ids":["glow"]}),
    ] {
        let error = drafts
            .update(
                &created.id,
                created.revision,
                vec![
                    operation(
                        json!({"kind":"moveNode","nodeId":"leaf-b","parentId":"other","index":0}),
                    ),
                    operation(invalid.clone()),
                ],
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid_input", "{invalid}: {error:?}");
        let observed = drafts.get(&created.id).await.unwrap();
        assert_eq!(observed.revision, created.revision);
        assert_eq!(observed.document, created.document);
    }
    library.pool().close().await;
}

#[tokio::test]
async fn moving_a_subtree_beyond_eight_levels_is_rejected() {
    let root = tempfileish::temp_dir("work-tree-depth");
    let library = Library::open(root.path()).await.unwrap();
    let drafts = WorkDrafts::new(&library);
    let mut value = document();
    let tree = value.composition.as_mut().unwrap();
    tree.effects.clear();
    tree.nodes = (0..9)
        .map(|index| {
            serde_json::from_value(json!({
        "id":format!("group-{index}"),"type":"group","stateVersion":1,"properties":{"space":"2d"},
        "children":if index < 7 {vec![format!("group-{}",index+1)]} else {vec![]}
    })).unwrap()
        })
        .collect();
    let created = drafts.create(value).await.unwrap();
    let error = drafts
        .update(
            &created.id,
            created.revision,
            vec![operation(json!({
                "kind":"moveNode","nodeId":"group-0","parentId":"group-8","index":0
            }))],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalid_input");
    assert_eq!(
        drafts.get(&created.id).await.unwrap().document,
        created.document
    );
    library.pool().close().await;
}

#[tokio::test]
async fn root_moves_preserve_child_order_and_stale_revision_cannot_overwrite_them() {
    let root = tempfileish::temp_dir("work-tree-cas");
    let library = Library::open(root.path()).await.unwrap();
    let drafts = WorkDrafts::new(&library);
    let created = drafts.create(document()).await.unwrap();
    let moved = drafts
        .update(
            &created.id,
            created.revision,
            vec![operation(json!({
                "kind":"moveNode","nodeId":"other","parentId":null,"index":0
            }))],
        )
        .await
        .unwrap();
    assert_eq!(
        node_ids(&moved.document),
        ["other", "leaf-a", "inner", "leaf-b", "outer", "spatial"]
    );
    assert_eq!(
        moved.document.composition.as_ref().unwrap().nodes[4].children,
        ["inner", "leaf-a"]
    );
    assert_eq!(
        drafts
            .update(
                &created.id,
                created.revision,
                vec![operation(json!({
                    "kind":"reorderNodes","ids":node_ids(&created.document)
                }))]
            )
            .await
            .unwrap_err()
            .code,
        "draft_conflict"
    );
    assert_eq!(
        drafts.get(&created.id).await.unwrap().document,
        moved.document
    );
    library.pool().close().await;
}

#[tokio::test]
async fn a_maximum_node_order_fits_the_existing_management_envelope() {
    let root = tempfileish::temp_dir("work-tree-maximum");
    let library = Library::open(root.path()).await.unwrap();
    let drafts = WorkDrafts::new(&library);
    let mut value = document();
    let tree = value.composition.as_mut().unwrap();
    tree.effects.clear();
    tree.nodes = (0..128).map(|index| serde_json::from_value(json!({
        "id":format!("n{index:03}-{}","a".repeat(59)),"type":"group","stateVersion":1,"properties":{}
    })).unwrap()).collect();
    let created = drafts.create(value).await.unwrap();
    let ids: Vec<_> = node_ids(&created.document).into_iter().rev().collect();
    let input = json!({"kind":"reorderNodes","ids":ids});
    assert!(serde_json::to_vec(&vec![&input]).unwrap().len() < 12 * 1024);
    let moved = drafts
        .update(&created.id, created.revision, vec![operation(input)])
        .await
        .unwrap();
    assert_eq!(node_ids(&moved.document), ids);
    library.pool().close().await;
}

#[test]
fn structural_updates_reject_unknown_fields_and_negative_indices() {
    for invalid in [
        json!({"kind":"moveNode","nodeId":"node","parentId":null,"index":-1}),
        json!({"kind":"moveNode","nodeId":"node","parentId":null,"index":0,"apply":true}),
        json!({"kind":"reorderNodes","ids":[],"revision":1}),
        json!({"kind":"reorderEffects","ids":"adjust"}),
    ] {
        assert!(serde_json::from_value::<Update>(invalid).is_err());
    }
}
