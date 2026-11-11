// SPDX-License-Identifier: MIT
//! Real parser/System requested-allocation falsifiers. Source equations prove
//! the envelope; finite fixtures witness phases, canonical retention and drops.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    io::{Cursor, Write},
    process::Command,
};

use hertz_wallpaper::{
    archive::inspect_package_identity, manifest::ManifestHeapBounds, validate_manifest_bytes,
    MAX_MANIFEST_BYTES,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

struct Meter;
thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
    static REQUESTS: Cell<usize> = const { Cell::new(0) };
    static LARGEST: Cell<usize> = const { Cell::new(0) };
    static LEAVES: Cell<usize> = const { Cell::new(0) };
    static INTERNALS: Cell<usize> = const { Cell::new(0) };
}
fn add(bytes: usize) {
    if ENABLED.with(Cell::get) {
        LIVE.with(|live| {
            live.set(live.get().checked_add(bytes).unwrap());
            PEAK.with(|peak| peak.set(peak.get().max(live.get())));
        });
        REQUESTS.with(|count| count.set(count.get() + 1));
        LARGEST.with(|largest| largest.set(largest.get().max(bytes)));
        if bytes == 632 {
            LEAVES.with(|count| count.set(count.get() + 1));
        }
        if bytes == 728 {
            INTERNALS.with(|count| count.set(count.get() + 1));
        }
    }
}
fn sub(bytes: usize) {
    if ENABLED.with(Cell::get) {
        LIVE.with(|live| live.set(live.get().checked_sub(bytes).unwrap()));
    }
}
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            add(layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            add(layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        sub(layout.size());
        unsafe { System.dealloc(pointer, layout) };
    }
    unsafe fn realloc(&self, pointer: *mut u8, old: Layout, bytes: usize) -> *mut u8 {
        // Count old+new even when the allocator grows in place.
        add(bytes);
        let result = unsafe { System.realloc(pointer, old, bytes) };
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
    largest: usize,
    leaves: usize,
    internals: usize,
}
fn start() {
    assert!(!ENABLED.with(Cell::get));
    for cell in [&LIVE, &PEAK, &REQUESTS, &LARGEST, &LEAVES, &INTERNALS] {
        cell.with(|value| value.set(0));
    }
    ENABLED.with(|enabled| enabled.set(true));
}
fn stop() -> Observation {
    ENABLED.with(|enabled| enabled.set(false));
    Observation {
        live: LIVE.with(Cell::get),
        peak: PEAK.with(Cell::get),
        requests: REQUESTS.with(Cell::get),
        largest: LARGEST.with(Cell::get),
        leaves: LEAVES.with(Cell::get),
        internals: INTERNALS.with(Cell::get),
    }
}
fn encoded(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn web() -> Value {
    json!({
        "formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae",
        "version":1,"title":"Manifest fees","description":"",
        "content":{"kind":"web","entry":"index.html","apiVersion":1},
        "assets":[],"files":[{"path":"index.html","bytes":3,
            "sha256":format!("{:x}",Sha256::digest(b"abc")),"mime":"text/html"}],
        "properties":[],"permissions":{},"license":{"code":"MIT","assets":"MIT"}
    })
}
fn builtin() -> Value {
    let mut value = web();
    value["content"] = json!({"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}});
    value["files"] = json!([]);
    value
}
fn select() -> Value {
    json!({"id":"select-probe","label":"Options","type":{"select":null},"default":0,
        "constraints":{"options":(0..64).map(|i|json!({"value":i,"label":i.to_string()})).collect::<Vec<_>>()},
        "target":["node","content","gain",null]})
}
fn measured_manifest(label: &str, bytes: &[u8], expected: Option<&str>) -> Observation {
    // Freeze caller bytes and warm process owner before measuring the job.
    hertz_wallpaper::catalog();
    let fees = ManifestHeapBounds::for_bytes(bytes.len() as u64).unwrap();
    start();
    let result = validate_manifest_bytes(bytes);
    let code = result.as_ref().err().map(|error| error.code);
    let retained = LIVE.with(Cell::get);
    drop(result);
    let observation = stop();
    assert_eq!(code, expected, "{label}");
    assert_eq!(observation.live, 0, "{label}: {observation:?}");
    assert!(
        observation.peak as u64 <= fees.workspace_requested_bytes(),
        "{label}: {observation:?}"
    );
    if code.is_none() {
        assert!(
            retained as u64 <= fees.retained_manifest_requested_bytes(),
            "{label}: {retained}"
        );
    }
    println!(
        "case={label} peak={} retained={retained} after_drop={} largest={}",
        observation.peak, observation.live, observation.largest
    );
    observation
}

#[test]
fn checked_boundaries_zero_live_base_and_maximum_retention() {
    for (m, workspace, retained) in [
        (0, 2_919_780, 3_019_145),
        (1, 2_920_540, 3_019_167),
        (2048, 3_635_420, 3_062_700),
        (MAX_MANIFEST_BYTES as u64, 141_607_208, 8_594_075),
    ] {
        let fees = ManifestHeapBounds::for_bytes(m).unwrap();
        assert_eq!(fees.manifest_bytes(), m);
        assert_eq!(fees.workspace_requested_bytes(), workspace);
        assert_eq!(fees.retained_manifest_requested_bytes(), retained);
        assert_eq!(fees.retained_identity_requested_bytes(), retained + 923_648);
        assert_eq!(fees.catalog_cold_requested_bytes(), 1_502_113);
        assert_eq!(fees.catalog_retained_requested_bytes(), 1_136_036);
        assert_eq!(fees.workspace_with_live_base(17).unwrap(), workspace + 17);
        assert_eq!(
            fees.workspace_with_live_base(u64::MAX - workspace).unwrap(),
            u64::MAX
        );
        assert_eq!(
            fees.workspace_with_live_base(u64::MAX - workspace + 1)
                .unwrap_err()
                .code,
            "manifest_heap_limit"
        );
    }
    for m in [MAX_MANIFEST_BYTES as u64 + 1, u64::MAX] {
        assert_eq!(
            ManifestHeapBounds::for_bytes(m).unwrap_err().code,
            "manifest_heap_limit"
        );
    }
    // Fee acceptance of zero must not change the parser's empty-input error.
    measured_manifest("empty", b"", Some("invalid_json"));
    measured_manifest("one-byte", b"0", Some("invalid_manifest"));
    measured_manifest(
        "max-whitespace",
        &vec![b' '; MAX_MANIFEST_BYTES],
        Some("invalid_json"),
    );
    assert_eq!(
        validate_manifest_bytes(&vec![b' '; MAX_MANIFEST_BYTES + 1])
            .unwrap_err()
            .code,
        "manifest_too_large"
    );
}

#[test]
fn real_original_map_layout_and_zero_heap_fee_queries() {
    start();
    for m in [0, 1, 2048, MAX_MANIFEST_BYTES as u64] {
        let fees = ManifestHeapBounds::for_bytes(m).unwrap();
        std::hint::black_box(fees.workspace_with_live_base(1).unwrap());
        std::hint::black_box((
            fees.manifest_bytes(),
            fees.retained_manifest_requested_bytes(),
            fees.retained_identity_requested_bytes(),
            fees.catalog_cold_requested_bytes(),
            fees.catalog_retained_requested_bytes(),
        ));
    }
    let query = stop();
    assert_eq!((query.requests, query.peak, query.live), (0, 0, 0));
    start();
    let mut map = serde_json::Map::new();
    for i in 0..12 {
        map.insert(i.to_string(), json!(i));
    }
    drop(map);
    let nodes = stop();
    assert!(nodes.leaves >= 2 && nodes.internals >= 1, "{nodes:?}");
    assert_eq!(nodes.live, 0);
}

#[test]
fn success_original_struct_enum_sequences_and_select_null_map() {
    measured_manifest("builtin", &encoded(&builtin()), None);
    let mut value = web();
    value["properties"] = json!([select()]);
    let bytes = encoded(&value);
    measured_manifest("select64-null-type-target-sequence", &bytes, None);
    let parsed = validate_manifest_bytes(&bytes).unwrap();
    assert_eq!(parsed.properties[0]["type"], json!({"select":null}));
    assert_eq!(
        parsed.properties[0]["constraints"]["options"]
            .as_array()
            .unwrap()
            .len(),
        64
    );
    let sequence = json!([
        1,
        "c17ed10a-5c55-4a52-85dc-7509f9e88aae",
        1,
        "sequence",
        "",
        ["builtin", "zodiac", 1, {}],
        [],
        [],
        [],
        [false, false],
        ["MIT", "MIT", ""]
    ]);
    measured_manifest(
        "root-struct-content-enum-sequence",
        &encoded(&sequence),
        None,
    );
    let mut object = select();
    object["type"] = json!("select");
    object["target"] = json!({"kind":"node","nodeId":"content","property":"gain","component":null});
    value["properties"] = json!([object]);
    measured_manifest("ordinary-object-target", &encoded(&value), None);
}

#[test]
fn first_partial_hints_and_arbitrary_property_serialization_are_covered() {
    let mut assets = builtin();
    assets["assets"] = json!(vec![Value::Null; 4000]);
    let observation = measured_manifest(
        "first-invalid-asset-hint",
        &encoded(&assets),
        Some("invalid_manifest"),
    );
    assert!(observation.largest >= 4000 * 80, "{observation:?}");
    let mut value = web();
    let mut property = select();
    property["type"] = json!("select");
    property["constraints"]["options"] = json!(vec![json!({}); 180]);
    value["properties"] = json!([property]);
    let observation = measured_manifest(
        "first-invalid-option-hint",
        &encoded(&value),
        Some("invalid_property"),
    );
    assert!(observation.largest >= 180 * std::mem::size_of::<hertz_wallpaper::SelectOption>());
    // Small source spelling becomes >2KiB on FIRST arbitrary serialization.
    let text = String::from_utf8(encoded(&web())).unwrap();
    let arbitrary = format!("{{\"x\":[{}1e9]}}", "1e9,".repeat(159));
    let bytes = text.replace(
        "\"properties\":[]",
        &format!("\"properties\":[{arbitrary}]"),
    );
    assert!(arbitrary.len() < 2048);
    let observation = measured_manifest(
        "first-arbitrary-serialization",
        bytes.as_bytes(),
        Some("invalid_property"),
    );
    assert!(observation.largest > 2048);
}

#[test]
fn diagnostics_escapes_long_numbers_literal_objects_and_null_errors_drop() {
    let mut value = builtin();
    value["formatVersion"] = json!(format!("{}中文🙂", "\u{1}".repeat(180)));
    measured_manifest(
        "debug-escaped-format",
        &encoded(&value),
        Some("invalid_manifest"),
    );
    let mut value = web();
    value["properties"] = json!([{"id":"n","label":"Number","type":"number","default":0,
        "constraints":{"min":"\u{1}".repeat(50),"max":1},
        "target":{"kind":"node","nodeId":"content","property":"gain","component":null}}]);
    measured_manifest(
        "constraint-error-chain",
        &encoded(&value),
        Some("invalid_property"),
    );
    let long = format!(
        "{{\"x\":1.00000000000000011102230246251565404236316680908203125{}1}}",
        "0".repeat(769)
    );
    measured_manifest(
        "long-float-roundtrip",
        long.as_bytes(),
        Some("invalid_manifest"),
    );
    for raw in ["{\"hidden\":true}", "[1,2]", "null", "not JSON"] {
        let mut value = builtin();
        value["content"]["params"] = json!({"$serde_json::private::RawValue":raw});
        measured_manifest(
            "literal-private-object",
            &encoded(&value),
            Some("invalid_manifest"),
        );
    }
    let mut value = builtin();
    value["content"]["params"] = Value::Null;
    measured_manifest("null-params", &encoded(&value), Some("invalid_manifest"));
    let mut value = web();
    value["properties"] = json!([null]);
    measured_manifest("null-property", &encoded(&value), Some("invalid_manifest"));
    measured_manifest(
        "duplicate-escaped-key",
        br#"{"a":1,"\u0061":2}"#,
        Some("duplicate_key"),
    );
    measured_manifest("scanner-missing-colon", br#"{"abcd"#, Some("invalid_json"));
}

fn stored(manifest: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    writer.start_file("manifest.json", options).unwrap();
    writer.write_all(manifest).unwrap();
    writer.start_file("index.html", options).unwrap();
    writer.write_all(payload).unwrap();
    writer.finish().unwrap().into_inner()
}

#[test]
fn stored_zip_records_actual_manifest_length_retention_and_drop() {
    hertz_wallpaper::catalog();
    let mut manifest = encoded(&web());
    // Actual accepted source spelling need not equal serde's normalized length.
    manifest.extend_from_slice(b" \n\t  ");
    let zip = stored(&manifest, b"abc");
    start();
    let identity = inspect_package_identity(Cursor::new(zip.as_slice())).unwrap();
    let retained = LIVE.with(Cell::get);
    let before_queries = REQUESTS.with(Cell::get);
    let fees = identity.manifest_heap_bounds().unwrap();
    let after_queries = REQUESTS.with(Cell::get);
    let entry_shape = (
        identity.entries().len(),
        identity.entries()[0].path.capacity(),
        identity.entries()[0].sha256.capacity(),
        identity.entries()[0].mime.as_ref().unwrap().capacity(),
    );
    drop(identity);
    let observation = stop();
    assert_eq!(before_queries, after_queries);
    assert_eq!(fees.manifest_bytes(), manifest.len() as u64);
    assert_eq!(entry_shape, (1, 10, 64, 9));
    assert!(retained as u64 <= fees.retained_identity_requested_bytes());
    assert_eq!(observation.live, 0, "{observation:?}");
    println!(
        "case=stored-identity actual_M={} retained={retained} after_drop={}",
        manifest.len(),
        observation.live
    );
    for (bytes, payload, expected) in [
        (manifest.as_slice(), b"abd".as_slice(), "hash_mismatch"),
        (b"null".as_slice(), b"abc".as_slice(), "invalid_manifest"),
    ] {
        let zip = stored(bytes, payload);
        start();
        let result = inspect_package_identity(Cursor::new(zip.as_slice()));
        let code = result.as_ref().unwrap_err().code;
        drop(result);
        let observation = stop();
        assert_eq!(code, expected);
        assert_eq!(observation.live, 0, "{observation:?}");
    }
}

#[test]
fn cold_process_child() {
    let Ok(mode) = std::env::var("HERTZ_MANIFEST_HEAP_COLD_CHILD") else {
        return;
    };
    let bytes = if mode == "failure" {
        let mut value = builtin();
        value["content"]["sceneId"] = json!("not-in-catalog");
        encoded(&value)
    } else {
        encoded(&builtin())
    };
    // Query BEFORE the first catalog use, then observe the true cold owner.
    start();
    let fees = ManifestHeapBounds::for_bytes(bytes.len() as u64).unwrap();
    let query = stop();
    assert_eq!((query.requests, query.live, query.peak), (0, 0, 0));
    start();
    let mut result_retained = 0;
    if mode == "catalog" {
        std::hint::black_box(hertz_wallpaper::catalog());
    } else {
        let result = validate_manifest_bytes(&bytes);
        let code = result.as_ref().err().map(|error| error.code);
        result_retained = LIVE.with(Cell::get);
        drop(result);
        assert_eq!(
            code,
            if mode == "failure" {
                Some("invalid_scene_id")
            } else {
                None
            }
        );
    }
    let catalog_retained = LIVE.with(Cell::get);
    let catalog_peak = PEAK.with(Cell::get);
    // Warm reuse of the exact OnceLock does not allocate a second directory.
    let requests = REQUESTS.with(Cell::get);
    std::hint::black_box(hertz_wallpaper::catalog());
    let requests_after = REQUESTS.with(Cell::get);
    let observation = stop();
    assert_eq!(requests, requests_after);
    assert!(
        catalog_retained > 0,
        "fee query initialized catalog prematurely"
    );
    assert!(catalog_retained as u64 <= fees.catalog_retained_requested_bytes());
    if mode == "catalog" {
        assert!(catalog_peak as u64 <= fees.catalog_cold_requested_bytes());
    } else {
        assert!(
            catalog_peak as u64
                <= fees
                    .workspace_with_live_base(fees.catalog_cold_requested_bytes())
                    .unwrap()
        );
    }
    assert_eq!(observation.live, catalog_retained);
    println!("cold={mode} query_requests={} peak={catalog_peak} permanent={catalog_retained} result_retained={result_retained}", query.requests);
}

#[test]
fn fresh_cold_catalog_success_and_failure_keep_only_process_owner() {
    for mode in ["catalog", "success", "failure"] {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "cold_process_child", "--nocapture"])
            .env("HERTZ_MANIFEST_HEAP_COLD_CHILD", mode)
            .output()
            .unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(output.status.success(), "mode={mode}\n{stdout}\n{stderr}");
        assert!(
            stdout.contains(&format!("cold={mode} query_requests=0")),
            "{stdout}"
        );
        print!("{stdout}");
    }
}
