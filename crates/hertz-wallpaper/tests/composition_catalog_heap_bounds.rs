// SPDX-License-Identifier: MIT
//! Real original-parser requested allocation witnesses. Realloc measures the
//! simultaneous old+new request even when System grows a block in place.
use hertz_wallpaper::document::catalog::{
    composition_catalog, parse_catalog, CompositionCatalogHeapBounds, Contract, Field,
};
use sha2::{Digest, Sha256};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    process::Command,
};

struct Meter;
thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
    static REQUESTS: Cell<usize> = const { Cell::new(0) };
    static FIELD_LEAVES: Cell<usize> = const { Cell::new(0) };
    static FIELD_INTERNALS: Cell<usize> = const { Cell::new(0) };
    static ASSET_LEAVES: Cell<usize> = const { Cell::new(0) };
    static QUALITY_LEAVES: Cell<usize> = const { Cell::new(0) };
    static COST_LEAVES: Cell<usize> = const { Cell::new(0) };
    static SET_LEAVES: Cell<usize> = const { Cell::new(0) };
    static SET_INTERNALS: Cell<usize> = const { Cell::new(0) };
}
fn add(bytes: usize) {
    if !ENABLED.with(Cell::get) {
        return;
    }
    LIVE.with(|live| {
        live.set(live.get().checked_add(bytes).unwrap());
        PEAK.with(|peak| peak.set(peak.get().max(live.get())));
    });
    REQUESTS.with(|count| count.set(count.get() + 1));
    let cell = match bytes {
        2744 => Some(&FIELD_LEAVES),
        2840 => Some(&FIELD_INTERNALS),
        896 => Some(&ASSET_LEAVES),
        368 => Some(&QUALITY_LEAVES),
        408 => Some(&COST_LEAVES),
        280 => Some(&SET_LEAVES),
        376 => Some(&SET_INTERNALS),
        _ => None,
    };
    if let Some(cell) = cell {
        cell.with(|count| count.set(count.get() + 1));
    }
}
fn sub(bytes: usize) {
    if ENABLED.with(Cell::get) {
        LIVE.with(|live| live.set(live.get().checked_sub(bytes).unwrap()));
    }
}
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            add(layout.size());
        }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            add(layout.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        sub(layout.size());
        unsafe { System.dealloc(p, layout) };
    }
    unsafe fn realloc(&self, p: *mut u8, old: Layout, bytes: usize) -> *mut u8 {
        add(bytes);
        let result = unsafe { System.realloc(p, old, bytes) };
        if result.is_null() {
            sub(bytes);
        } else {
            sub(old.size());
        }
        result
    }
}
#[global_allocator]
static ALLOCATOR: Meter = Meter;
#[derive(Debug)]
struct Observation {
    live: usize,
    peak: usize,
    requests: usize,
    field_leaves: usize,
    field_internals: usize,
    asset_leaves: usize,
    quality_leaves: usize,
    cost_leaves: usize,
    set_leaves: usize,
    set_internals: usize,
}
fn start() {
    assert!(!ENABLED.with(Cell::get));
    for cell in [
        &LIVE,
        &PEAK,
        &REQUESTS,
        &FIELD_LEAVES,
        &FIELD_INTERNALS,
        &ASSET_LEAVES,
        &QUALITY_LEAVES,
        &COST_LEAVES,
        &SET_LEAVES,
        &SET_INTERNALS,
    ] {
        cell.with(|value| value.set(0));
    }
    ENABLED.with(|flag| flag.set(true));
}
fn stop() -> Observation {
    ENABLED.with(|flag| flag.set(false));
    Observation {
        live: LIVE.with(Cell::get),
        peak: PEAK.with(Cell::get),
        requests: REQUESTS.with(Cell::get),
        field_leaves: FIELD_LEAVES.with(Cell::get),
        field_internals: FIELD_INTERNALS.with(Cell::get),
        asset_leaves: ASSET_LEAVES.with(Cell::get),
        quality_leaves: QUALITY_LEAVES.with(Cell::get),
        cost_leaves: COST_LEAVES.with(Cell::get),
        set_leaves: SET_LEAVES.with(Cell::get),
        set_internals: SET_INTERNALS.with(Cell::get),
    }
}
const BYTES: &[u8] = include_bytes!("../contracts/composition.json");
fn cold_child(name: &str) -> bool {
    if std::env::var("HERTZ_COMPOSITION_HEAP_COLD_CHILD").as_deref() == Ok(name) {
        return false;
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture", "--test-threads=1"])
        .env("HERTZ_COMPOSITION_HEAP_COLD_CHILD", name)
        .output()
        .unwrap();
    println!(
        "cold child {name}: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

#[test]
fn inline_query_zero_heap_and_original_parse_requested_peak_retention_drop() {
    start();
    let bounds = CompositionCatalogHeapBounds::for_embedded_catalog().unwrap();
    let query = stop();
    assert_eq!(query.requests, 0);
    assert_eq!(query.live, 0);
    assert_eq!(bounds.cold_requested_bytes(), 93_356);
    assert_eq!(bounds.retained_requested_bytes(), 91_820);
    assert_eq!(std::mem::size_of::<CompositionCatalogHeapBounds>(), 16);
    start();
    let contract = parse_catalog(BYTES).unwrap();
    let retained = LIVE.with(Cell::get);
    drop(contract);
    let observed = stop();
    assert_eq!(observed.live, 0);
    assert_eq!(
        retained, 91_820,
        "canonical original byte parser capacities"
    );
    assert!(
        observed.peak <= bounds.cold_requested_bytes() as usize,
        "{observed:?}"
    );
    assert_eq!((observed.field_leaves, observed.field_internals), (18, 5));
    assert_eq!(
        (
            observed.asset_leaves,
            observed.quality_leaves,
            observed.cost_leaves
        ),
        (6, 5, 5)
    );
    // 179 scanner objects include seven empty sets; five split once. Each
    // split reuses its old leaf and allocates one new leaf plus one internal.
    assert_eq!((observed.set_leaves, observed.set_internals), (177, 5));
    println!("original parse retained={retained}, requested={observed:?}");
}

#[test]
fn cold_original_once_lock_query_does_not_initialize_and_permanent_identity_is_same() {
    const NAME: &str =
        "cold_original_once_lock_query_does_not_initialize_and_permanent_identity_is_same";
    if cold_child(NAME) {
        return;
    }
    start();
    let bounds = CompositionCatalogHeapBounds::for_embedded_catalog().unwrap();
    let query = stop();
    assert_eq!(query.requests, 0);
    start();
    let contract = composition_catalog();
    let observed = stop();
    // A preceding query must leave the actual OnceLock truly cold.
    assert_eq!(observed.live, 91_820);
    assert!(
        observed.peak <= bounds.cold_requested_bytes() as usize,
        "{observed:?}"
    );
    assert_eq!((observed.field_leaves, observed.field_internals), (18, 5));
    start();
    let again = composition_catalog();
    let warm = stop();
    assert!(std::ptr::eq(contract, again));
    assert_eq!(warm.requests, 0);
    assert_eq!(warm.live, 0);
    assert_capacities(contract);
    println!("cold original OnceLock permanent/peak={}/{}, same_address=true, types Field/Node/Effect={}/{}/{}",observed.live,observed.peak,std::mem::size_of::<Field>(),std::mem::size_of::<hertz_wallpaper::document::catalog::NodeSchema>(),std::mem::size_of::<hertz_wallpaper::document::catalog::EffectSchema>());
}

fn assert_capacities(contract: &Contract) {
    let definitions = &contract.definitions;
    assert_eq!(
        (definitions.nodes.len(), definitions.nodes.capacity()),
        (7, 8)
    );
    assert_eq!(
        (definitions.effects.len(), definitions.effects.capacity()),
        (5, 8)
    );
    let mut string_slots = definitions.inputs.capacity();
    let mut value_slots = 0;
    let mut kinds_slots = 0;
    fn fields(
        fields: &std::collections::BTreeMap<String, Field>,
        string_slots: &mut usize,
        value_slots: &mut usize,
    ) {
        for field in fields.values() {
            *string_slots += field.affects.capacity() + field.options.capacity();
            if let Some(serde_json::Value::Array(array)) = &field.default {
                assert_eq!((array.len(), array.capacity()), (3, 4));
                *value_slots += array.capacity();
            }
            fields_walk(&field.alternatives, string_slots, value_slots);
        }
    }
    fn fields_walk(
        map: &std::collections::BTreeMap<String, Field>,
        strings: &mut usize,
        values: &mut usize,
    ) {
        fields(map, strings, values);
    }
    for node in &definitions.nodes {
        fields(&node.properties, &mut string_slots, &mut value_slots);
        for asset in node.assets.values() {
            assert_eq!(asset.kinds.capacity(), 8);
            kinds_slots += asset.kinds.capacity();
        }
    }
    for effect in &definitions.effects {
        string_slots += effect.targets.capacity();
        fields(&effect.properties, &mut string_slots, &mut value_slots);
        for asset in effect.assets.values() {
            assert_eq!(asset.kinds.capacity(), 8);
            kinds_slots += asset.kinds.capacity();
        }
    }
    assert_eq!((string_slots, value_slots, kinds_slots), (516, 24, 56));
    println!("real retained capacities String/Value/AssetKind slots={string_slots}/{value_slots}/{kinds_slots}");
}

#[test]
fn original_public_parser_preserves_literal_null_default_and_hash_error() {
    let original = parse_catalog(BYTES).unwrap();
    assert_eq!(
        original.registry_hash,
        "e9fbe594981bd83d9f9e09267f6b888cde36360bfc527d6a298e3346e6288efa"
    );
    let mut source: serde_json::Value = serde_json::from_slice(BYTES).unwrap();
    source["registryHash"] = serde_json::Value::String("0".repeat(64));
    assert_eq!(
        parse_catalog(&serde_json::to_vec(&source).unwrap())
            .err()
            .unwrap()
            .code,
        "composition_catalog_mismatch"
    );
    // Ordinary Value's object field accepts a literal null child; the public
    // parser keeps the original seed rather than a raw-value carrier.
    let fields = source["definitions"]["nodes"].as_array_mut().unwrap();
    let mut changed = false;
    for node in fields {
        for field in node["properties"].as_object_mut().unwrap().values_mut() {
            if field["type"] == "sceneParams" {
                field["default"] = serde_json::json!({"$serde_json::private::RawValue":null});
                changed = true;
            }
        }
    }
    assert!(changed);
    let definitions = serde_json::to_vec(&source["definitions"]).unwrap();
    source["registryHash"] =
        serde_json::Value::String(format!("{:x}", Sha256::digest(&definitions)));
    let accepted = parse_catalog(&serde_json::to_vec(&source).unwrap()).unwrap();
    let default = accepted
        .definitions
        .nodes
        .iter()
        .flat_map(|node| node.properties.values())
        .find(|field| field.field_type == "sceneParams")
        .unwrap()
        .default
        .as_ref()
        .unwrap();
    assert_eq!(
        default["$serde_json::private::RawValue"],
        serde_json::Value::Null
    );
    let missing: Field = serde_json::from_str(r#"{"type":"sceneParams"}"#).unwrap();
    let explicit: Field = serde_json::from_str(r#"{"type":"sceneParams","default":null}"#).unwrap();
    assert_eq!(missing.default, None);
    assert_eq!(explicit.default, None);
}
