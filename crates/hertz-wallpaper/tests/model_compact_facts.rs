// SPDX-License-Identifier: MIT
//! Real full-inspector/System allocator witnesses, not a meter-slope theorem.
use hertz_wallpaper::{
    model_binary::inspect_glb_resource_content,
    model_structure::{ModelImage, ModelNodeTransform, PackageImageRef},
    Manifest,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::RefCell,
    collections::BTreeMap,
    io::Cursor,
    sync::Arc,
};

struct Meter;
#[derive(Clone, Copy)]
struct Record {
    pointer: usize,
    bytes: usize,
}
struct Sample {
    active: bool,
    records: [Record; 4096],
    live: usize,
    allocations: usize,
    overflow: bool,
    freed: usize,
    leaf: usize,
    internal: usize,
}
thread_local! {
    static HEAP: RefCell<Sample> = const { RefCell::new(Sample { active: false, records: [Record { pointer: 0, bytes: 0 }; 4096], live: 0, allocations: 0, overflow: false, freed: 0, leaf: 0, internal: 0 }) };
}
fn event(old: *mut u8, next: *mut u8, bytes: usize) {
    let _ = HEAP.try_with(|cell| {
        let Ok(mut m) = cell.try_borrow_mut() else {
            return;
        };
        if !m.active {
            return;
        }
        if let Some(index) = m
            .records
            .iter()
            .position(|r| r.pointer != 0 && r.pointer == old as usize)
        {
            let n = m.records[index].bytes;
            m.live -= n;
            m.freed += n;
            m.records[index] = Record {
                pointer: 0,
                bytes: 0,
            };
        }
        if next.is_null() {
            return;
        }
        m.allocations += 1;
        m.leaf += usize::from(bytes == 368);
        m.internal += usize::from(bytes == 464);
        let Some(index) = m.records.iter().position(|r| r.pointer == 0) else {
            m.overflow = true;
            return;
        };
        let Some(live) = m.live.checked_add(bytes) else {
            m.overflow = true;
            return;
        };
        m.live = live;
        m.records[index] = Record {
            pointer: next as usize,
            bytes,
        };
    });
}
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        event(std::ptr::null_mut(), p, layout.size());
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        event(std::ptr::null_mut(), p, layout.size());
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        event(p, std::ptr::null_mut(), 0);
        unsafe { System.dealloc(p, layout) };
    }
    unsafe fn realloc(&self, p: *mut u8, old: Layout, n: usize) -> *mut u8 {
        let next = unsafe { System.realloc(p, old, n) };
        if !next.is_null() {
            event(p, next, n);
        }
        next
    }
}
#[global_allocator]
static ALLOCATOR: Meter = Meter;
fn start() {
    HEAP.with(|cell| {
        let mut m = cell.borrow_mut();
        assert!(!m.active);
        m.records.fill(Record {
            pointer: 0,
            bytes: 0,
        });
        m.live = 0;
        m.allocations = 0;
        m.freed = 0;
        m.overflow = false;
        m.leaf = 0;
        m.internal = 0;
        m.active = true;
    });
}
fn snapshot() -> (usize, usize, usize, bool) {
    HEAP.with(|cell| {
        let m = cell.borrow();
        (m.live, m.allocations, m.freed, m.overflow)
    })
}
fn stop() {
    HEAP.with(|cell| cell.borrow_mut().active = false);
}

fn manifest() -> Manifest {
    serde_json::from_value(json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Full compact facts",
        "content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[{"id":"texture","kind":"texture","source":"models/a/tex.png","variants":[{"id":"same","file":"models/a/tex.png","purpose":"low"},{"id":"other","file":"models/a/other.png","purpose":"high"}]}],
        "files":[{"path":"models/a/tex.png","bytes":4,"mime":"image/png","sha256":"long-arbitrary-pure-sha"},{"path":"models/a/other.png","bytes":4,"mime":"image/png","sha256":"long-arbitrary-pure-sha"}],
        "permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"CC0-1.0"}})).unwrap()
}
fn rich_document(generator: &str) -> (Value, Vec<u8>) {
    let mut doc = json!({"asset":{"version":"2.0","generator":generator},"buffers":[{"byteLength":1}],"bufferViews":[],"accessors":[],
        "meshes":[],"nodes":[{"children":[1,2,3]},{},{"mesh":0,"skin":0,"weights":[-0.25],"translation":[-0.0,2.25,3.0],"extras":{"pivot":null}},
            {"mesh":1,"matrix":[1,0,0,0,0,1,0,0,0,0,1,0,4.25,0,0,1]}],
        "skins":[{"joints":[1],"skeleton":0}],"scenes":[{"nodes":[0]},{"nodes":[]}],"scene":0,
        "materials":[{}],"samplers":[{}],"textures":[{"source":0,"sampler":0}],
        "images":[{"uri":"tex.png"},{"uri":"tex.png"},{"uri":"other.png"}],
        "cameras":[{"type":"perspective","perspective":{"yfov":1.0,"znear":0.1}}]});
    // A separate authored root with facts outside the selected scene.
    doc["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"mesh":1,"camera":0,"weights":[0.75,-0.0],"translation":[-0.0,9.25,0.0]}));
    let mut bin = Vec::new();
    fn accessor(
        doc: &mut Value,
        bin: &mut Vec<u8>,
        component: u32,
        shape: &str,
        count: usize,
        bytes: &[u8],
        bounds: Option<(&[f64], &[f64])>,
    ) -> usize {
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        let view = doc["bufferViews"].as_array().unwrap().len();
        doc["bufferViews"]
            .as_array_mut()
            .unwrap()
            .push(json!({"buffer":0,"byteOffset":bin.len(),"byteLength":bytes.len()}));
        bin.extend(bytes);
        let index = doc["accessors"].as_array().unwrap().len();
        let mut a = json!({"bufferView":view,"componentType":component,"type":shape,"count":count});
        if let Some((min, max)) = bounds {
            a["min"] = json!(min);
            a["max"] = json!(max);
        }
        doc["accessors"].as_array_mut().unwrap().push(a);
        index
    }
    fn floats(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|n| n.to_le_bytes()).collect()
    }
    let position = accessor(
        &mut doc,
        &mut bin,
        5126,
        "VEC3",
        3,
        &floats(&[0., 0., 0., 1., 0., 0., 0., 1., 0.]),
        Some((&[0., 0., 0.], &[1., 1., 0.])),
    );
    let target = accessor(
        &mut doc,
        &mut bin,
        5126,
        "VEC3",
        3,
        &[0; 36],
        Some((&[0., 0., 0.], &[0., 0., 0.])),
    );
    let joints = accessor(&mut doc, &mut bin, 5121, "VEC4", 3, &[0; 12], None);
    let weights = accessor(
        &mut doc,
        &mut bin,
        5121,
        "VEC4",
        3,
        &[255, 0, 0, 0].repeat(3),
        None,
    );
    doc["accessors"][weights]["normalized"] = json!(true);
    for a in [joints, weights] {
        let v = doc["accessors"][a]["bufferView"].as_u64().unwrap() as usize;
        doc["bufferViews"][v]["byteStride"] = json!(4);
    }
    let indices = accessor(
        &mut doc,
        &mut bin,
        5123,
        "SCALAR",
        3,
        &[0, 0, 1, 0, 2, 0],
        None,
    );
    let inverse = accessor(
        &mut doc,
        &mut bin,
        5126,
        "MAT4",
        1,
        &floats(&[
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
        ]),
        None,
    );
    doc["skins"][0]["inverseBindMatrices"] = json!(inverse);
    let times = accessor(
        &mut doc,
        &mut bin,
        5126,
        "SCALAR",
        2,
        &floats(&[0., 1.]),
        Some((&[0.], &[1.])),
    );
    let translation = accessor(&mut doc, &mut bin, 5126, "VEC3", 2, &[0; 24], None);
    let scale = accessor(&mut doc, &mut bin, 5126, "VEC3", 2, &floats(&[1.; 6]), None);
    let mut rotation = vec![0.; 24];
    rotation[7] = 1.;
    rotation[19] = 1.;
    let rotation = accessor(
        &mut doc,
        &mut bin,
        5126,
        "VEC4",
        6,
        &floats(&rotation),
        None,
    );
    let morph = accessor(
        &mut doc,
        &mut bin,
        5126,
        "SCALAR",
        2,
        &floats(&[-0.5, 0.25]),
        None,
    );
    doc["meshes"] = json!([
        {"weights":[-0.5],"extras":{"pivot":false},"primitives":[{"attributes":{"POSITION":position,"JOINTS_0":joints,"WEIGHTS_0":weights},"indices":indices,"material":0,"mode":4,"targets":[{"POSITION":target}]}]},
        {"weights":[0.0,-0.5],"primitives":[{"attributes":{"POSITION":position,"_":position},"targets":[{},{"_":target}]}]}]);
    doc["animations"] = json!([{"name":"Full author animation","samplers":[
        {"input":times,"output":translation,"interpolation":"LINEAR"},{"input":times,"output":scale,"interpolation":"STEP"},
        {"input":times,"output":rotation,"interpolation":"CUBICSPLINE"},{"input":times,"output":morph}],
        "channels":[{"sampler":0,"target":{"node":2,"path":"translation"}},{"sampler":1,"target":{"node":2,"path":"scale"}},
            {"sampler":2,"target":{"node":2,"path":"rotation"}},{"sampler":3,"target":{"node":2,"path":"weights"}},{"sampler":0,"target":{"path":"translation"}}]}]);
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let view = doc["bufferViews"].as_array().unwrap().len();
    doc["bufferViews"]
        .as_array_mut()
        .unwrap()
        .push(json!({"buffer":0,"byteOffset":bin.len(),"byteLength":4}));
    bin.extend([1, 2, 3, 4]);
    doc["images"]
        .as_array_mut()
        .unwrap()
        .push(json!({"bufferView":view,"mimeType":"image/png"}));
    bin.extend([9, 8, 7, 6]); // deliberately unused bytes remain in the certificate
    doc["buffers"][0]["byteLength"] = json!(bin.len());
    (doc, bin)
}
fn glb(doc: &Value, bin: &[u8]) -> Vec<u8> {
    let mut text = serde_json::to_vec(doc).unwrap();
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let mut bytes = b"glTF".to_vec();
    bytes.extend(2u32.to_le_bytes());
    bytes.extend((28 + text.len() as u32 + bin.len() as u32).to_le_bytes());
    bytes.extend((text.len() as u32).to_le_bytes());
    bytes.extend(b"JSON");
    bytes.extend(text);
    bytes.extend((bin.len() as u32).to_le_bytes());
    bytes.extend([b'B', b'I', b'N', 0]);
    bytes.extend(bin);
    bytes
}

#[test]
fn complete_facts_move_json_release_zero_compact_query_allocation_and_final_drop() {
    let (doc, bin) = rich_document("rich");
    let bytes = glb(&doc, &bin);
    let manifest = manifest();
    let original = inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest,
        "models/a/source.glb",
    )
    .unwrap();
    let expected = original.resource().structure.clone();
    let expected_bin = original.resource().container.binary.clone();
    let facts = (
        original.checked_accessors(),
        original.unique_layouts(),
        original.checked_elements(),
        original.checked_components(),
    );
    drop(original);
    start();
    let original = inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest,
        "models/a/source.glb",
    )
    .unwrap();
    let structure = &original.resource().structure;
    let owners = (
        structure.nodes.as_ptr(),
        structure.nodes[0].children.as_ptr(),
        structure.meshes.as_ptr(),
        structure.accessors[0].min.as_ref().unwrap().as_ptr(),
    );
    let json_capacity = original.resource().container.json.capacity();
    let before = snapshot();
    let compact = original.into_compact();
    let after = snapshot();
    assert_eq!(before.1, after.1);
    assert_eq!(before.0 - after.0, json_capacity);
    assert_eq!(after.2 - before.2, json_capacity);
    let query_before = snapshot();
    let charge = compact.retained_requested_bytes().unwrap();
    assert_eq!(snapshot(), query_before);
    assert_eq!(compact.structure(), &expected);
    assert_eq!(compact.binary(), expected_bin.as_ref());
    assert_eq!(
        (
            compact.checked_accessors(),
            compact.unique_layouts(),
            compact.checked_elements(),
            compact.checked_components()
        ),
        facts
    );
    assert_eq!(compact.sha256(), &<[u8; 32]>::from(Sha256::digest(&bytes)));
    assert_eq!(compact.bytes(), bytes.len() as u64);
    assert_eq!(compact.source_path(), "models/a/source.glb");
    assert_eq!(
        compact.json_bytes(),
        u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as u64
    );
    let s = compact.structure();
    assert_eq!(
        owners,
        (
            s.nodes.as_ptr(),
            s.nodes[0].children.as_ptr(),
            s.meshes.as_ptr(),
            s.accessors[0].min.as_ref().unwrap().as_ptr()
        )
    );
    assert!(s.nodes[0].children.capacity() > s.nodes[0].children.len());
    assert!(!s.binary_content_validated);
    assert_eq!(s.nodes.len(), 5);
    assert_eq!(s.nodes[4].parent, None);
    assert_eq!(s.scenes[0].nodes, vec![0]);
    assert_eq!(
        s.node_morph_weights[4].as_ref().unwrap()[1].to_bits(),
        (-0.0f64).to_bits()
    );
    assert!(matches!(
        s.nodes[3].transform,
        ModelNodeTransform::Matrix(_)
    ));
    assert_eq!(s.meshes[0].primitives[0].authored_mode, Some(4));
    assert_eq!(s.meshes[1].primitives[0].authored_mode, None);
    assert_eq!(s.animations[0].channels.last().unwrap().target_node, None);
    let retained = snapshot().0;
    assert!(charge >= retained as u64);
    drop(compact);
    let final_sample = snapshot();
    stop();
    assert_eq!(final_sample.0, 0);
    assert!(!final_sample.3);
    println!("rich full facts retained={retained} charge={charge} json_released={json_capacity} compact/query_allocations=0 final_drop=0 overflow=false");
    let mut changed = bytes.clone();
    *changed.last_mut().unwrap() ^= 1;
    let changed = inspect_glb_resource_content(
        Cursor::new(&changed),
        changed.len() as u64,
        &manifest,
        "models/a/source.glb",
    )
    .unwrap()
    .into_compact();
    assert_ne!(changed.sha256(), &<[u8; 32]>::from(Sha256::digest(&bytes)));
}

#[test]
fn actual_shared_and_distinct_image_backings_and_unbounded_pure_strings() {
    let (doc, bin) = rich_document("aliases");
    let bytes = glb(&doc, &bin);
    let mut manifest = manifest();
    manifest.assets[0].id = "x".repeat(4097);
    manifest.files[0].sha256 = "a".repeat(5001);
    let inspected = inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest,
        "models/a/source.glb",
    )
    .unwrap();
    let cloned = inspected.clone();
    let refs = |image: &ModelImage| match image {
        ModelImage::Package { references, .. } => Arc::as_ptr(references) as *const PackageImageRef,
        _ => panic!(),
    };
    let ptr = refs(&inspected.resource().structure.images[0]);
    let compact = inspected.into_compact();
    let compact_clone = cloned.into_compact();
    assert_eq!(ptr, refs(&compact.structure().images[0]));
    assert_eq!(ptr, refs(&compact_clone.structure().images[0]));
    let images = &compact.structure().images;
    assert_eq!(refs(&images[0]), refs(&images[1]));
    assert_ne!(refs(&images[0]), refs(&images[2]));
    assert!(compact.retained_requested_bytes().unwrap() > 14000);
    // Full clone uses its own actual Vec capacities; never reuse a cached fee.
    assert!(
        compact_clone.structure().nodes[0].children.capacity()
            <= compact.structure().nodes[0].children.capacity()
    );
    start();
    let a = compact.retained_requested_bytes().unwrap();
    let b = compact_clone.retained_requested_bytes().unwrap();
    let sample = snapshot();
    stop();
    assert_eq!(sample.1, 0);
    assert_eq!(sample.0, 0);
    assert!(!sample.3);
    assert!(a >= b);
}

#[test]
fn original_btree_allocation_requests_and_arbitrary_empty_root() {
    for keys in [1, 11, 12, 32] {
        let strings = (0..keys).map(|n| format!("_{n:02}")).collect::<Vec<_>>();
        start();
        let mut map = BTreeMap::new();
        for (n, s) in strings.iter().enumerate() {
            map.insert(s.clone(), n);
        }
        let (leaves, internals) = HEAP.with(|c| {
            let m = c.borrow();
            (m.leaf, m.internal)
        });
        assert!(leaves > 0);
        assert_eq!(internals > 0, keys >= 12);
        for key in &strings {
            map.remove(key);
        }
        assert_eq!(map.len(), 0);
        assert!(snapshot().0 >= 368);
        drop(map);
        let sample = snapshot();
        stop();
        assert_eq!(sample.0, 0);
        assert!(!sample.3);
        println!(
            "original tree keys={keys} leaf368={leaves} internal464={internals} overflow=false"
        );
    }
}

#[test]
fn equal_reference_contents_distinct_arcs_are_charged_and_shared_arcs_are_not_duplicated() {
    let mut manifest = manifest();
    manifest.assets[0].id = "same".into();
    manifest.assets[0].variants.clear();
    let mut second = manifest.assets[0].clone();
    second.source = "models/a/other.png".into();
    manifest.assets.push(second);
    let base = json!({"asset":{"version":"2.0"},"images":[{"uri":"tex.png"},{"uri":"tex.png"}]});
    let inspect = |doc: &Value| {
        let mut text = serde_json::to_vec(doc).unwrap();
        while !text.len().is_multiple_of(4) {
            text.push(b' ');
        }
        let mut bytes = b"glTF".to_vec();
        bytes.extend(2u32.to_le_bytes());
        bytes.extend((20 + text.len() as u32).to_le_bytes());
        bytes.extend((text.len() as u32).to_le_bytes());
        bytes.extend(b"JSON");
        bytes.extend(text);
        inspect_glb_resource_content(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &manifest,
            "models/a/source.glb",
        )
        .unwrap()
        .into_compact()
    };
    let shared = inspect(&base);
    let mut distinct = base;
    distinct["images"][1]["uri"] = json!("other.png");
    let distinct = inspect(&distinct);
    let parts = |image: &ModelImage| match image {
        ModelImage::Package {
            path,
            mime,
            sha256,
            references,
            ..
        } => (
            path.capacity() + mime.capacity() + sha256.capacity(),
            Arc::clone(references),
        ),
        _ => panic!(),
    };
    let (old_strings, old_refs) = parts(&shared.structure().images[1]);
    let (new_strings, new_refs) = parts(&distinct.structure().images[1]);
    let (_, first_refs) = parts(&distinct.structure().images[0]);
    assert_eq!(first_refs, new_refs);
    assert!(!Arc::ptr_eq(&first_refs, &new_refs));
    let (_, shared_first) = parts(&shared.structure().images[0]);
    assert!(Arc::ptr_eq(&shared_first, &old_refs));
    let arc = 16
        + std::mem::size_of::<PackageImageRef>() * new_refs.len()
        + new_refs
            .iter()
            .map(|r| r.asset_id.capacity() + r.variant_id.as_ref().map_or(0, String::capacity))
            .sum::<usize>();
    start();
    let a = shared.retained_requested_bytes().unwrap();
    let b = distinct.retained_requested_bytes().unwrap();
    let sample = snapshot();
    stop();
    assert_eq!(b + old_strings as u64, a + new_strings as u64 + arc as u64);
    assert_eq!(sample.1, 0);
    assert!(!sample.3);
}
