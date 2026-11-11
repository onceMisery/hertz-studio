// SPDX-License-Identifier: MIT
//! System allocator falsifiers on the actual full parser. The source-derived
//! equations, not these finite fixtures, establish the 4 MiB input bound.

use hertz_wallpaper::{
    model_binary::inspect_glb_resource_content, model_structure::ModelHeapBounds, Manifest,
    MAX_TEXT_BYTES,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    io::{self, Cursor, Read},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

struct Meter;
thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
    static NODE_REQUEST: Cell<bool> = const { Cell::new(false) };
    static ATTRIBUTE_LEAVES: Cell<usize> = const { Cell::new(0) };
}
fn add(bytes: usize) {
    if ENABLED.with(Cell::get) {
        LIVE.with(|live| {
            live.set(live.get().checked_add(bytes).unwrap());
            PEAK.with(|peak| peak.set(peak.get().max(live.get())));
        });
        if bytes == 5000 * 416 {
            NODE_REQUEST.with(|seen| seen.set(true));
        }
        if bytes == 368 {
            ATTRIBUTE_LEAVES.with(|count| count.set(count.get() + 1));
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
        // Count the old+new requested layout even if System can resize in place.
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

fn manifest() -> Manifest {
    serde_json::from_value(json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae",
        "version":1,"title":"Heap fixture","content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[],"files":[],"permissions":{"audioSpectrum":false,"pointer":false},
        "license":{"code":"none","assets":"CC0-1.0"}})).unwrap()
}
fn glb(text: &str, bin: &[u8], sparse: usize) -> Vec<u8> {
    let json_bytes = text.len().div_ceil(4) * 4;
    let bin_bytes = bin.len().div_ceil(4) * 4 + sparse;
    let total = 20 + json_bytes + if bin_bytes == 0 { 0 } else { 8 + bin_bytes };
    let mut bytes = Vec::with_capacity(20 + json_bytes + bin.len() + 8);
    bytes.extend_from_slice(b"glTF");
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(&(total as u32).to_le_bytes());
    bytes.extend_from_slice(&(json_bytes as u32).to_le_bytes());
    bytes.extend_from_slice(b"JSON");
    bytes.extend_from_slice(text.as_bytes());
    bytes.resize(20 + json_bytes, b' ');
    if bin_bytes != 0 {
        bytes.extend_from_slice(&(bin_bytes as u32).to_le_bytes());
        bytes.extend_from_slice(&[b'B', b'I', b'N', 0]);
        bytes.extend_from_slice(bin);
        bytes.resize(bytes.len() + bin.len().div_ceil(4) * 4 - bin.len(), 0);
    }
    bytes
}
struct Sparse<'a> {
    prefix: Cursor<&'a [u8]>,
    remaining: usize,
    largest_read: usize,
    bin_start: u64,
}
impl Read for Sparse<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.prefix.position() >= self.bin_start {
            self.largest_read = self.largest_read.max(output.len());
        }
        let count = self.prefix.read(output)?;
        if count != 0 {
            return Ok(count);
        }
        let count = output.len().min(self.remaining);
        output[..count].fill(0);
        self.remaining -= count;
        Ok(count)
    }
}
fn run(
    label: &str,
    text: &str,
    bin: &[u8],
    sparse: usize,
    manifest: &Manifest,
    expected: Option<&str>,
    nodes: Option<usize>,
) {
    let bytes = glb(text, bin, sparse);
    let mut hash = Sha256::new();
    hash.update(&bytes);
    let zeros = [0u8; 64 * 1024];
    let mut zero_bytes = sparse;
    while zero_bytes != 0 {
        let count = zero_bytes.min(zeros.len());
        hash.update(&zeros[..count]);
        zero_bytes -= count;
    }
    let input_sha256 = hash.finalize();
    let json_bytes = u64::from(u32::from_le_bytes(bytes[12..16].try_into().unwrap()));
    let bounds = ModelHeapBounds::for_json_bytes(json_bytes, manifest).unwrap();
    let mut reader = Sparse {
        prefix: Cursor::new(&bytes),
        remaining: sparse,
        largest_read: 0,
        bin_start: 28 + json_bytes,
    };
    LIVE.with(|value| value.set(0));
    PEAK.with(|value| value.set(0));
    NODE_REQUEST.with(|value| value.set(false));
    ATTRIBUTE_LEAVES.with(|value| value.set(0));
    ENABLED.with(|value| value.set(true));
    let result = inspect_glb_resource_content(
        &mut reader,
        (bytes.len() + sparse) as u64,
        manifest,
        "assets/model.glb",
    );
    let code = result.as_ref().err().map(|error| error.code);
    let retained = LIVE.with(Cell::get);
    if let (Ok(result), Some(nodes)) = (&result, nodes) {
        assert_eq!(result.resource().structure.nodes.len(), nodes);
        assert_eq!(result.resource().structure.nodes.capacity(), nodes);
    }
    drop(result);
    ENABLED.with(|value| value.set(false));
    let peak = PEAK.with(Cell::get);
    assert_eq!(
        LIVE.with(Cell::get),
        0,
        "{label}: failure/success drop leaks measured heap"
    );
    assert_eq!(code, expected, "{label}");
    assert!(
        peak as u64 <= bounds.workspace_requested_bytes(),
        "{label}: {peak} > {bounds:?}"
    );
    if code.is_none() {
        assert!(retained as u64 <= bounds.retained_requested_bytes());
    }
    if nodes == Some(5000) {
        assert!(
            NODE_REQUEST.with(Cell::get),
            "actual Schema Node cap5000 allocation"
        );
    }
    if label == "short_custom_semantic_map_moves" {
        // 4096 original target leaves plus one original base-attribute leaf.
        // A Schema->facts deep clone would double this count.
        assert_eq!(ATTRIBUTE_LEAVES.with(Cell::get), 4097);
    }
    if sparse != 0 {
        assert!(reader.largest_read <= 64 * 1024);
    }
    println!("case={label} J={json_bytes} peak={peak} retained={retained} W={} R={} code={code:?} largest_read={} drop=0",
        bounds.workspace_requested_bytes(), bounds.retained_requested_bytes(), reader.largest_read);
    println!("case={label} input_sha256={input_sha256:x}");
    println!(
        "case={label} attribute_leaf_requests={}",
        ATTRIBUTE_LEAVES.with(Cell::get)
    );
}
fn repeat_array(item: &str, count: usize) -> String {
    format!("[{}]", vec![item; count].join(","))
}

struct ExternalIoPayload {
    text: String,
    display_calls: AtomicUsize,
    debug_calls: AtomicUsize,
    source_calls: AtomicUsize,
}
struct ExternalIoError(Arc<ExternalIoPayload>);
impl std::fmt::Display for ExternalIoError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.display_calls.fetch_add(1, Ordering::Relaxed);
        output.write_str(&self.0.text)
    }
}
impl std::fmt::Debug for ExternalIoError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.debug_calls.fetch_add(1, Ordering::Relaxed);
        output.write_str("external diagnostic Debug")
    }
}
impl std::error::Error for ExternalIoError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.source_calls.fetch_add(1, Ordering::Relaxed);
        None
    }
}

#[derive(Clone, Copy)]
enum IoFault<'a> {
    External(&'a Arc<ExternalIoPayload>),
    Os(i32),
    Eof,
}
struct FaultReader<'a> {
    input: Cursor<&'a [u8]>,
    fail_at: u64,
    fault: IoFault<'a>,
    failures: usize,
}
impl Read for FaultReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.input.position() == self.fail_at {
            self.failures += 1;
            return match self.fault {
                IoFault::External(payload) => {
                    Err(io::Error::other(ExternalIoError(Arc::clone(payload))))
                }
                IoFault::Os(code) => Err(io::Error::from_raw_os_error(code)),
                IoFault::Eof => Ok(0),
            };
        }
        let count = output
            .len()
            .min((self.fail_at - self.input.position()) as usize);
        self.input.read(&mut output[..count])
    }
}

#[derive(Clone, Copy)]
enum IoContainer {
    Model,
    NumericModel,
    Texture,
}

fn run_io_failure(
    label: &str,
    bytes: &[u8],
    container: IoContainer,
    positions: (u64, u64),
    fault: IoFault<'_>,
    maximum_heap: u64,
    manifest: &Manifest,
) {
    let (fail_at, expected_offset) = positions;
    let mut input = FaultReader {
        input: Cursor::new(bytes),
        fail_at,
        fault,
        failures: 0,
    };
    let context = if fail_at == bytes.len() as u64 {
        "end-of-entry read failed"
    } else {
        "short or failed read"
    };
    let (kind, os) = match fault {
        IoFault::External(_) => (io::ErrorKind::Other, None),
        IoFault::Os(code) => (io::Error::from_raw_os_error(code).kind(), Some(code)),
        IoFault::Eof => (io::ErrorKind::UnexpectedEof, None),
    };
    let expected_message =
        format!("{context}: kind={kind:?}, raw_os_error={os:?} (byte {expected_offset})");
    let expected_code = match container {
        IoContainer::Model => "invalid_model_container",
        // Original BinaryWindow moves the reader message into this code.
        IoContainer::NumericModel => "invalid_model_binary",
        IoContainer::Texture => "invalid_texture_container",
    };
    LIVE.with(|value| value.set(0));
    PEAK.with(|value| value.set(0));
    ENABLED.with(|value| value.set(true));
    let error = match container {
        IoContainer::Model | IoContainer::NumericModel => inspect_glb_resource_content(
            &mut input,
            bytes.len() as u64,
            manifest,
            "assets/model.glb",
        )
        .unwrap_err(),
        IoContainer::Texture => {
            hertz_wallpaper::texture_container::inspect_ktx2(&mut input, bytes.len() as u64)
                .unwrap_err()
        }
    };
    let code = error.code;
    let message_bytes = error.message.len();
    let message_matches = error.message == expected_message;
    drop(error);
    ENABLED.with(|value| value.set(false));
    let peak = PEAK.with(Cell::get);
    println!("io_case={label} fail_at={fail_at} offset={expected_offset} peak={peak} bound={maximum_heap} message_bytes={message_bytes} code={code} kind={kind:?} os={os:?} diagnostic_matches={message_matches} drop={}", LIVE.with(Cell::get));
    assert_eq!(
        LIVE.with(Cell::get),
        0,
        "{label}: all model/texture/error allocations dropped"
    );
    assert_eq!(
        input.input.position(),
        fail_at,
        "{label}: physical read position"
    );
    assert_eq!(
        input.failures, 1,
        "{label}: no read after the error or footer probe"
    );
    assert_eq!(
        code, expected_code,
        "{label}: original error classification"
    );
    assert!(
        peak as u64 <= maximum_heap,
        "{label}: {peak} > {maximum_heap}"
    );
    assert!(
        message_matches,
        "{label}: fixed context/kind/OS/start offset"
    );
    assert!(
        message_bytes <= 160,
        "{label}: scalar-only diagnostic length"
    );
    if let IoFault::External(payload) = fault {
        assert_eq!(
            payload.display_calls.load(Ordering::Relaxed),
            0,
            "{label}: no external Display"
        );
        assert_eq!(
            payload.debug_calls.load(Ordering::Relaxed),
            0,
            "{label}: no external Debug"
        );
        assert_eq!(
            payload.source_calls.load(Ordering::Relaxed),
            0,
            "{label}: no external Source"
        );
        assert_eq!(
            Arc::strong_count(payload),
            1,
            "{label}: returned io error wrapper dropped"
        );
    }
}

fn io_ktx2_fixture() -> Vec<u8> {
    let mut bytes = vec![0; 196];
    bytes[..12].copy_from_slice(&[
        0xab, b'K', b'T', b'X', b' ', b'2', b'0', 0xbb, 13, 10, 26, 10,
    ]);
    for (offset, value) in [
        (12, 37u32),
        (16, 1),
        (20, 4),
        (24, 4),
        (36, 1),
        (40, 1),
        (48, 104),
        (52, 28),
        (104, 28),
    ] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    for (offset, value) in [(80, 132u64), (88, 64), (96, 64)] {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
    bytes
}

#[test]
fn original_shared_io_diagnostics_never_format_external_payloads() {
    let manifest = manifest();
    let empty = glb(r#"{"asset":{"version":"2.0"}}"#, &[], 0);
    let bounds = ModelHeapBounds::for_json_bytes(28, &manifest).unwrap();
    let numeric = glb(
        r#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":4}],"bufferViews":[{"buffer":0,"byteLength":4}],"accessors":[{"bufferView":0,"componentType":5126,"count":1,"type":"SCALAR"}]}"#,
        &[0; 4],
        0,
    );
    let numeric_j = u32::from_le_bytes(numeric[12..16].try_into().unwrap()) as u64;
    let numeric_bounds = ModelHeapBounds::for_json_bytes(numeric_j, &manifest).unwrap();
    let texture = io_ktx2_fixture();
    for payload_bytes in [64 * 1024, 128 * 1024] {
        // Caller-owned allocation predates measurement and survives it. The
        // tiny io error borrows this Arc; Display itself only writes its text.
        let payload = Arc::new(ExternalIoPayload {
            text: "x".repeat(payload_bytes),
            display_calls: AtomicUsize::new(0),
            debug_calls: AtomicUsize::new(0),
            source_calls: AtomicUsize::new(0),
        });
        let fault = IoFault::External(&payload);
        // The original SPEC falsifier first: JSON read at20 with J28.
        run_io_failure(
            "GLB_JSON_opening",
            &empty,
            IoContainer::Model,
            (20, 20),
            fault,
            bounds.opening_requested_bytes(),
            &manifest,
        );
        run_io_failure(
            "GLB_magic_header",
            &empty,
            IoContainer::Model,
            (0, 0),
            fault,
            bounds.opening_requested_bytes(),
            &manifest,
        );
        run_io_failure(
            "GLB_chunk_header",
            &empty,
            IoContainer::Model,
            (12, 12),
            fault,
            bounds.opening_requested_bytes(),
            &manifest,
        );
        run_io_failure(
            "GLB_partial_JSON",
            &empty,
            IoContainer::Model,
            (21, 20),
            fault,
            bounds.opening_requested_bytes(),
            &manifest,
        );
        run_io_failure(
            "GLB_BIN_header",
            &numeric,
            IoContainer::Model,
            (20 + numeric_j, 20 + numeric_j),
            fault,
            numeric_bounds.opening_requested_bytes(),
            &manifest,
        );
        run_io_failure(
            "GLB_numeric_BIN",
            &numeric,
            IoContainer::NumericModel,
            (28 + numeric_j, 28 + numeric_j),
            fault,
            numeric_bounds.workspace_requested_bytes(),
            &manifest,
        );
        run_io_failure(
            "GLB_footer",
            &empty,
            IoContainer::Model,
            (empty.len() as u64, empty.len() as u64),
            fault,
            bounds.workspace_requested_bytes(),
            &manifest,
        );
        // Shared KTX2 owner: these small real fixtures and their fixed scalar
        // diagnostics fit the EXISTING 64KiB fixed allowance. This is not a
        // new complete texture/GPU allocation qualification.
        for (label, at, offset) in [
            ("KTX2_header", 0, 0),
            ("KTX2_level_index", 80, 80),
            ("KTX2_body", 104, 104),
            ("KTX2_partial_body", 132, 104),
            ("KTX2_footer", 196, 196),
        ] {
            run_io_failure(
                label,
                &texture,
                IoContainer::Texture,
                (at, offset),
                fault,
                64 * 1024,
                &manifest,
            );
        }
        println!(
            "external_payload_bytes={payload_bytes} display=0 debug=0 source=0 last_wrapper_drop=0"
        );
    }
    for code in [5, i32::MIN] {
        run_io_failure(
            "GLB_OS_error",
            &empty,
            IoContainer::Model,
            (20, 20),
            IoFault::Os(code),
            bounds.opening_requested_bytes(),
            &manifest,
        );
        run_io_failure(
            "KTX2_OS_footer",
            &texture,
            IoContainer::Texture,
            (196, 196),
            IoFault::Os(code),
            64 * 1024,
            &manifest,
        );
    }
    run_io_failure(
        "GLB_physical_EOF",
        &empty,
        IoContainer::Model,
        (21, 20),
        IoFault::Eof,
        bounds.opening_requested_bytes(),
        &manifest,
    );
    run_io_failure(
        "KTX2_physical_EOF",
        &texture,
        IoContainer::Texture,
        (132, 104),
        IoFault::Eof,
        64 * 1024,
        &manifest,
    );
}

#[test]
fn actual_parser_requested_heap_and_drop() {
    let mut manifest = manifest();
    let bounds = ModelHeapBounds::for_json_bytes(MAX_TEXT_BYTES, &manifest).unwrap();
    assert!(bounds.workspace_requested_bytes() < 320 * 1024 * 1024);
    assert!(bounds.workspace_with_live_base(u64::MAX).is_err());
    assert!(ModelHeapBounds::for_json_bytes(0, &manifest).is_err());
    assert!(ModelHeapBounds::for_json_bytes(MAX_TEXT_BYTES + 1, &manifest).is_err());
    println!(
        "full_J={} opening={} schema_structure={} numeric={} W={} R={} remaining_base={}",
        MAX_TEXT_BYTES,
        bounds.opening_requested_bytes(),
        bounds.schema_structure_requested_bytes(),
        bounds.numeric_requested_bytes(),
        bounds.workspace_requested_bytes(),
        bounds.retained_requested_bytes(),
        320 * 1024 * 1024 - bounds.workspace_requested_bytes()
    );
    run(
        "empty",
        r#"{"asset":{"version":"2.0"}}"#,
        &[],
        0,
        &manifest,
        None,
        Some(0),
    );
    for n in [1, 4096] {
        let text = format!(
            r#"{{"asset":{{"version":"2.0","generator":"{}"}},"extras":{{"pivot":{{"unused":[1,2,3]}}}}}}"#,
            "\\u0061".repeat(n)
        );
        run(
            "escaped_owned_name",
            &text,
            &[],
            0,
            &manifest,
            None,
            Some(0),
        );
    }
    let text = format!(
        r#"{{"asset":{{"version":"2.0"}},"nodes":{},"{}":0}}"#,
        repeat_array("{}", 5000),
        "\\u007f".repeat(4096)
    );
    run(
        "partial_unknown_escaped_key",
        &text,
        &[],
        0,
        &manifest,
        Some("invalid_model_structure"),
        None,
    );
    let text = format!(
        r#"{{"asset":{{"version":"2.0"}},"nodes":{}}}"#,
        repeat_array("{}", 5000)
    );
    run(
        "actual_node_root_limit",
        &text,
        &[],
        0,
        &manifest,
        None,
        Some(5000),
    );
    let roots = [
        ("buffers", r#"{"byteLength":1}"#, 16384),
        ("bufferViews", r#"{"buffer":0,"byteLength":1}"#, 16384),
        (
            "accessors",
            r#"{"bufferView":0,"componentType":5121,"count":1,"type":"SCALAR"}"#,
            16384,
        ),
        ("skins", r#"{"joints":[0]}"#, 16384),
        ("meshes", r#"{"primitives":[{"attributes":{}}]}"#, 5000),
        ("nodes", "{}", 5000),
        ("scenes", "{}", 5000),
        ("cameras", r#"{"type":"perspective"}"#, 5000),
        ("images", "{}", 4096),
        ("textures", "{}", 4096),
        ("samplers", "{}", 4096),
        ("materials", "{}", 4096),
        ("extensionsUsed", r#""""#, 4096),
        ("extensionsRequired", r#""""#, 4096),
        (
            "animations",
            r#"{"samplers":[{"input":0,"output":0}],"channels":[{"sampler":0,"target":{"path":"scale"}}]}"#,
            1024,
        ),
    ];
    let text = format!(
        r#"{{"asset":{{"version":"2.0"}},{}}}"#,
        roots
            .iter()
            .map(|(field, item, count)| format!("\"{field}\":{}", repeat_array(item, *count)))
            .collect::<Vec<_>>()
            .join(",")
    );
    run(
        "all_root_capacity_limits_before_semantic_reject",
        &text,
        &[],
        0,
        &manifest,
        Some("model_resource_unavailable"),
        None,
    );
    let target_list = repeat_array(r#"{"":0}"#, 16384);
    let primitive = format!(r#"{{"attributes":{{}},"targets":{target_list}}}"#);
    let text = format!(
        r#"{{"asset":{{"version":"2.0"}},"meshes":[{{"primitives":{}}}]}}"#,
        repeat_array(&primitive, 3)
    );
    run(
        "nested_one_key_before_aggregate_reject",
        &text,
        &[],
        0,
        &manifest,
        Some("model_structure_limit"),
        None,
    );
    let text = format!(
        r#"{{"asset":{{"version":"2.0"}},"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0,"{}":0}}}}]}}]}}"#,
        "\\u0061".repeat(65)
    );
    run(
        "partial_oversize_attribute",
        &text,
        &[],
        0,
        &manifest,
        Some("model_structure_limit"),
        None,
    );
    let text = format!(
        r#"{{"asset":{{"version":"2.0"}},"extras":{{"n":0.{}1e10000}}}}"#,
        "0".repeat(10000)
    );
    run(
        "finite_decimal_overflow_scratch",
        &text,
        &[],
        0,
        &manifest,
        None,
        Some(0),
    );
    run(
        "duplicate_scanner",
        r#"{"asset":{"version":"2.0"},"extras":{"a":0,"\u0061":1}}"#,
        &[],
        0,
        &manifest,
        Some("invalid_model_container"),
        None,
    );
    let text = format!(
        r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":36}}],
        "bufferViews":[{{"buffer":0,"byteLength":36,"target":34962}}],
        "accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[0,0,0]}}],
        "meshes":[{{"primitives":[{{"attributes":{{"POSITION":0,"_":0}},"targets":{}}}]}}]}}"#,
        repeat_array(r#"{"_":0}"#, 4096)
    );
    run(
        "short_custom_semantic_map_moves",
        &text,
        &[0; 36],
        0,
        &manifest,
        None,
        Some(0),
    );
    let accessors = (0..1024).map(|i| format!(r#"{{"bufferView":0,"byteOffset":{},"componentType":5126,"count":1,"type":"SCALAR"}}"#, i*4)).collect::<Vec<_>>().join(",");
    let text = format!(
        r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":16781312}}],"bufferViews":[{{"buffer":0,"byteLength":4096}}],"accessors":[{accessors}]}}"#
    );
    run(
        "numeric_unique_layouts_and_sparse_BIN",
        &text,
        &[0; 4096],
        16 * 1024 * 1024,
        &manifest,
        None,
        Some(0),
    );

    // Real morph+skin+animation originals share numeric jobs and the fixed
    // arena. All author records are inspected, including unused metadata.
    let mut bin = vec![0u8; 36 + 12];
    for _ in 0..3 {
        for value in [1f32, 0., 0., 0.] {
            bin.extend(value.to_le_bytes());
        }
    }
    for value in [0f32, 1., 0., 0., 0., 0., 0., 0.] {
        bin.extend(value.to_le_bytes());
    }
    let text = r#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":128}],
        "bufferViews":[{"buffer":0,"byteLength":36,"target":34962},{"buffer":0,"byteOffset":36,"byteLength":12,"byteStride":4,"target":34962},{"buffer":0,"byteOffset":48,"byteLength":48,"target":34962},{"buffer":0,"byteOffset":96,"byteLength":8},{"buffer":0,"byteOffset":104,"byteLength":24}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[0,0,0]},{"bufferView":1,"componentType":5121,"count":3,"type":"VEC4"},{"bufferView":2,"componentType":5126,"count":3,"type":"VEC4"},{"bufferView":3,"componentType":5126,"count":2,"type":"SCALAR","min":[0],"max":[1]},{"bufferView":4,"componentType":5126,"count":2,"type":"VEC3"}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0,"JOINTS_0":1,"WEIGHTS_0":2},"targets":[{"POSITION":0}]}],"weights":[0]}],
        "nodes":[{"children":[1]},{},{"mesh":0,"skin":0}],"skins":[{"joints":[1]}],"scenes":[{"nodes":[0,2]}],
        "animations":[{"name":"motion","samplers":[{"input":3,"output":4}],"channels":[{"sampler":0,"target":{"node":2,"path":"translation"}}]}]}"#;
    run(
        "derived_morph_skin_animation",
        text,
        &bin,
        0,
        &manifest,
        None,
        Some(3),
    );
    let wrong_bin = vec![0u8; 128];
    run(
        "numeric_failure_drops_arena",
        text,
        &wrong_bin,
        0,
        &manifest,
        Some("invalid_model_binary"),
        None,
    );

    manifest.files = serde_json::from_value(
        json!([{"path":"assets/p.png","bytes":4,"mime":"image/png","sha256":"a".repeat(64)}]),
    )
    .unwrap();
    manifest.assets = serde_json::from_value(json!([{"id":"albedo","kind":"image","source":"assets/p.png","variants":
        (0..256).map(|i| json!({"id":format!("v{i}"),"file":"assets/p.png","purpose":"low"})).collect::<Vec<Value>>()}])).unwrap();
    let text = format!(
        r#"{{"asset":{{"version":"2.0"}},"images":{}}}"#,
        repeat_array(r#"{"uri":"p.png"}"#, 1024)
    );
    run(
        "shared_manifest_aliases_Arc_conversion",
        &text,
        &[],
        0,
        &manifest,
        None,
        Some(0),
    );
}
