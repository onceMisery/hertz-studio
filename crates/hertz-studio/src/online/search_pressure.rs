// SPDX-License-Identifier: MIT
//! Explicit real-HTTP/RPC pressure probe. No real provider or credential access.
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, OnceLock,
};
use std::time::Duration;

use anyhow::{ensure, Context, Result};
use axum::middleware::{from_fn, Next};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::task::JoinSet;
use tokio::time::{sleep, timeout, Instant};

use super::search_gate::{MAX_WAITERS, PERMITS, SOURCE_DEADLINE, WAIT};
use super::{ApiError, ApiResult, SearchPage, SearchQuery};
use crate::rpc::{Call, Op, Rpc};
use crate::state::AppState;

const MAX_OBSERVATIONS: usize = 65536;
const BALANCED_SECONDS: u64 = 60;
const BALANCED_SOURCE_OPS_PER_SECOND: usize = 16;
const BALANCED_SCHEDULE_VERSION: u64 = 2;
const MAX_BALANCED_OBSERVATIONS: usize = 4096;
const ENTRY_NAMES: [&str; 4] = [
    "http-single",
    "rpc-single",
    "http-aggregate",
    "rpc-aggregate",
];

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    cycle: usize,
    wave: usize,
    client: usize,
    kind: usize,
    status: u16,
    code: &'static str,
    elapsed_ms: f64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceFailureObservation {
    source: String,
    code: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BalancedObservation {
    kind: usize,
    sequence: usize,
    sources: Vec<String>,
    successful_sources: Vec<String>,
    failed_sources: Vec<String>,
    source_failure_details: Vec<SourceFailureObservation>,
    scheduled_ms: f64,
    start_lag_ms: f64,
    elapsed_ms: f64,
    status: u16,
    code: String,
    source_calls: usize,
    source_successes: usize,
    source_failures: usize,
}

fn phase(phases: &mut Vec<Value>, clock: Instant, name: String) {
    let event = json!({"name":name,"startedMs":clock.elapsed().as_secs_f64()*1000.0});
    println!("HERTZ_SEARCH_PRESSURE_PHASE {event}");
    phases.push(event);
}

#[derive(Clone)]
pub(super) struct Target {
    address: SocketAddr,
    metrics: Arc<Metrics>,
}

tokio::task_local! { pub(super) static UPSTREAM: Target; }

pub(super) async fn search(target: Target, query: &SearchQuery) -> ApiResult<SearchPage> {
    let active = target.metrics.local_active.fetch_add(1, Ordering::SeqCst) + 1;
    target
        .metrics
        .local_peak
        .fetch_max(active, Ordering::SeqCst);
    let _executing = Executing(target.metrics.clone());
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(0)
            .build()
            .unwrap()
    });
    let mut url = reqwest::Url::parse(&format!("http://{}/search", target.address)).unwrap();
    url.query_pairs_mut()
        .append_pair("q", query.q.as_deref().unwrap_or(""))
        .append_pair("source", &query.source);
    let body = super::http::get_json(client, url.as_str(), Default::default()).await?;
    serde_json::from_value(body).map_err(|_| ApiError::upstream_rejected("invalid probe response"))
}

#[derive(Default)]
struct Metrics {
    local_active: AtomicUsize,
    local_peak: AtomicUsize,
    active: AtomicUsize,
    peak: AtomicUsize,
    started: AtomicUsize,
    disconnected: AtomicUsize,
    replied: AtomicUsize,
    closed_before_request: AtomicUsize,
}

struct Executing(Arc<Metrics>);
impl Drop for Executing {
    fn drop(&mut self) {
        self.0.local_active.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Active(Arc<Metrics>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

fn closed_read(result: std::io::Result<usize>) -> std::io::Result<usize> {
    match result {
        // Explicit client cancellation can close with FIN or reset on Windows.
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ) =>
        {
            Ok(0)
        }
        result => result,
    }
}

async fn upstream(socket: tokio::net::TcpStream, metrics: Arc<Metrics>) -> Result<()> {
    let mut socket = BufReader::new(socket);
    let mut request = String::new();
    if closed_read(socket.read_line(&mut request).await)? == 0 {
        metrics.closed_before_request.fetch_add(1, Ordering::SeqCst);
        return Ok(());
    }
    let target = request
        .split_whitespace()
        .nth(1)
        .context("request target")?;
    let url = reqwest::Url::parse(&format!("http://fixture{target}"))?;
    let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let keyword = pairs.get("q").context("query")?;
    let source = pairs.get("source").context("source")?;
    let mut header_bytes = request.len();
    loop {
        let mut line = String::new();
        if closed_read(socket.read_line(&mut line).await)? == 0 {
            metrics.closed_before_request.fetch_add(1, Ordering::SeqCst);
            return Ok(());
        }
        header_bytes += line.len();
        ensure!(header_bytes <= 8192, "fixture headers bound");
        if line == "\r\n" {
            break;
        }
    }
    metrics.started.fetch_add(1, Ordering::SeqCst);
    let active = metrics.active.fetch_add(1, Ordering::SeqCst) + 1;
    metrics.peak.fetch_max(active, Ordering::SeqCst);
    let _active = Active(metrics.clone());
    let mut byte = [0];
    if keyword.starts_with("hold") || keyword.starts_with("body-stall") {
        if keyword.starts_with("body-stall") {
            socket.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"source\":").await?;
        }
        ensure!(
            closed_read(socket.read(&mut byte).await)? == 0,
            "unexpected bytes after request"
        );
        metrics.disconnected.fetch_add(1, Ordering::SeqCst);
        return Ok(());
    }
    tokio::select! {
        _ = sleep(Duration::from_millis(80)) => {},
        read = socket.read(&mut byte) => {
            ensure!(closed_read(read)? == 0, "unexpected bytes after request");
            metrics.disconnected.fetch_add(1, Ordering::SeqCst);
            return Ok(());
        }
    }
    let rejected = keyword.starts_with("reject");
    let status = if rejected {
        "503 Service Unavailable"
    } else {
        "200 OK"
    };
    let body = if rejected {
        json!({"error":"controlled rejection"})
    } else {
        json!({"source":source,"keyword":keyword,"total":0,"tracks":[]})
    }
    .to_string();
    socket
        .get_mut()
        .write_all(
            format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    socket.get_mut().shutdown().await?;
    metrics.replied.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[derive(Clone)]
struct Caller {
    state: Arc<AppState>,
    address: SocketAddr,
    target: Target,
    client: reqwest::Client,
}

impl Caller {
    async fn call(&self, kind: usize, keyword: &str) -> Result<(u16, Value)> {
        self.call_source(kind, keyword, "ccmixter").await
    }

    async fn call_source(&self, kind: usize, keyword: &str, source: &str) -> Result<(u16, Value)> {
        let aggregate = kind >= 2;
        let path = if aggregate {
            "v1/online/search/all"
        } else {
            "v1/online/search"
        };
        let query = json!({"q":keyword,"source":source,"limit":1});
        if kind.is_multiple_of(2) {
            let response = self
                .client
                .get(format!("http://{}/{path}", self.address))
                .bearer_auth("search-pressure-fixture")
                .query(&query)
                .send()
                .await?;
            let status = response.status().as_u16();
            Ok((status, response.json().await?))
        } else {
            let rpc = Rpc::new(self.state.clone());
            let result = UPSTREAM
                .scope(
                    self.target.clone(),
                    rpc.call(Call {
                        op: Op::Get,
                        path,
                        query,
                        body: Value::Null,
                        raw: None,
                        client_operation_id: None,
                    }),
                )
                .await;
            Ok(match result {
                Ok(reply) => (reply.status, reply.body),
                Err(error) => (
                    error.status.as_u16(),
                    json!({"error":{
                        "code":error.code,"request_id":error.request_id,"source":error.source,"message":error.message,
                    }}),
                ),
            })
        }
    }
}

async fn ready_music_sources(caller: &Caller) -> Result<Vec<String>> {
    let ctx = super::Ctx::with_gate(caller.state.db.clone(), caller.state.search_gate.clone());
    let mut sources = Vec::new();
    for source in super::music_sources() {
        if super::source_ready(&ctx, source).await {
            sources.push(source.id.to_string());
        }
    }
    ensure!(
        sources.contains(&"ccmixter".to_owned()),
        "fixture source is not ready"
    );
    Ok(sources)
}

async fn balanced_call(
    caller: Caller,
    kind: usize,
    sequence: usize,
    scheduled_at: Instant,
    measurement_started: Instant,
    source_ids: Arc<Vec<String>>,
) -> Result<BalancedObservation> {
    let started = Instant::now();
    let keyword = format!("balanced-{kind}-{sequence}");
    let source_count = source_ids.len();
    let source = source_ids[sequence % source_count].clone();
    let (status, body) = caller.call_source(kind, &keyword, &source).await?;
    let (code, sources, successful_sources, failed_sources, source_failure_details) = if kind < 2 {
        if status == 200 {
            ensure!(
                body["keyword"] == keyword && body["source"] == source,
                "balanced single-source response identity"
            );
            (
                "ok".to_owned(),
                vec![source.clone()],
                vec![source.clone()],
                Vec::new(),
                Vec::new(),
            )
        } else {
            let code = body["error"]["code"]
                .as_str()
                .context("balanced single-source error code")?;
            error_from_source(status, &body, status, code, &source)?;
            ensure!(
                matches!(
                    (status, code),
                    (429, "search_busy") | (502, "upstream_rejected") | (504, "upstream_timeout")
                ),
                "unexpected balanced single-source failure: {body}"
            );
            (
                code.to_owned(),
                vec![source.clone()],
                Vec::new(),
                vec![source.clone()],
                vec![SourceFailureObservation {
                    source: source.clone(),
                    code: code.to_owned(),
                }],
            )
        }
    } else if status == 200 {
        ensure!(
            body["query"] == keyword,
            "balanced aggregate query identity"
        );
        let results = body["results"].as_array().context("aggregate results")?;
        let failures = body["failed"].as_array().context("aggregate failures")?;
        ensure!(
            results.len() + failures.len() == source_count,
            "balanced aggregate lost a source"
        );
        let mut seen = std::collections::HashSet::new();
        let mut successful_sources = Vec::new();
        let mut failed_sources = Vec::new();
        let mut source_failure_details = Vec::new();
        for result in results {
            let source = result["source"].as_str().context("result source")?;
            ensure!(
                source_ids.iter().any(|ready| ready == source),
                "unexpected aggregate result source"
            );
            ensure!(
                result["keyword"] == keyword,
                "balanced aggregate result identity"
            );
            ensure!(
                seen.insert(source.to_owned()),
                "duplicate aggregate result source"
            );
            successful_sources.push(source.to_owned());
        }
        for failure in failures {
            let source = failure["source"].as_str().context("failed source")?;
            ensure!(
                source_ids.iter().any(|ready| ready == source),
                "unexpected aggregate failure source"
            );
            ensure!(
                seen.insert(source.to_owned()),
                "duplicate aggregate failure source"
            );
            failed_sources.push(source.to_owned());
            source_failure_details.push(SourceFailureObservation {
                source: source.to_owned(),
                code: failure["code"]
                    .as_str()
                    .context("failed source code")?
                    .to_owned(),
            });
        }
        ensure!(
            source_ids.iter().all(|source| seen.contains(source)),
            "balanced aggregate omitted a ready source"
        );
        (
            "ok".to_owned(),
            source_ids.as_ref().clone(),
            successful_sources,
            failed_sources,
            source_failure_details,
        )
    } else {
        let code = body["error"]["code"]
            .as_str()
            .context("balanced aggregate error code")?;
        ensure!(
            matches!(
                (status, code),
                (429, "search_busy") | (502, "upstream_rejected") | (504, "upstream_timeout")
            ),
            "unexpected balanced aggregate failure: {body}"
        );
        (
            code.to_owned(),
            source_ids.as_ref().clone(),
            Vec::new(),
            source_ids.as_ref().clone(),
            source_ids
                .iter()
                .map(|source| SourceFailureObservation {
                    source: source.clone(),
                    code: code.to_owned(),
                })
                .collect(),
        )
    };
    let finished = Instant::now();
    Ok(BalancedObservation {
        kind,
        sequence,
        source_calls: sources.len(),
        source_successes: successful_sources.len(),
        source_failures: failed_sources.len(),
        sources,
        successful_sources,
        failed_sources,
        source_failure_details,
        scheduled_ms: scheduled_at
            .duration_since(measurement_started)
            .as_secs_f64()
            * 1000.0,
        start_lag_ms: started.duration_since(scheduled_at).as_secs_f64() * 1000.0,
        elapsed_ms: finished.duration_since(scheduled_at).as_secs_f64() * 1000.0,
        status,
        code,
    })
}

async fn balanced_throughput(
    caller: &Caller,
    metrics: &Arc<Metrics>,
    clock: Instant,
    phases: &mut Vec<Value>,
) -> Result<Value> {
    phase(phases, clock, "balanced-throughput".into());
    let ready = ready_music_sources(caller).await?;
    let source_count = ready.len();
    let target_source_calls = BALANCED_SECONDS as usize * BALANCED_SOURCE_OPS_PER_SECOND;
    let offered_source_calls = target_source_calls / source_count * source_count;
    ensure!(
        offered_source_calls > 0,
        "too many ready sources for balanced workload"
    );
    let source_ids = Arc::new(ready.clone());
    metrics.local_peak.store(0, Ordering::SeqCst);

    let mut schedule = Vec::new();
    for kind in 0..4 {
        let count = if kind < 2 {
            offered_source_calls
        } else {
            offered_source_calls / source_count
        };
        ensure!(count > 0, "balanced entry received no offered calls");
        let interval_ns = Duration::from_secs(BALANCED_SECONDS).as_nanos() / count as u128;
        for sequence in 0..count {
            // Alternate which transport starts each equal-rate pair. This keeps
            // HTTP from always receiving the earlier slot in a time window.
            let first_kind = sequence % 2;
            let phase = if kind % 2 == first_kind { 0 } else { 1 };
            let offset_ns = sequence as u128 * interval_ns + phase * (interval_ns / 2);
            schedule.push((
                u64::try_from(offset_ns).context("balanced schedule overflow")?,
                kind,
                sequence,
            ));
        }
    }
    ensure!(
        schedule.len() <= MAX_BALANCED_OBSERVATIONS,
        "balanced observation bound"
    );
    schedule.sort_unstable();

    let started = Instant::now() + Duration::from_millis(250);
    let mut calls = JoinSet::new();
    for (offset_ns, kind, sequence) in schedule {
        let scheduled_at = started + Duration::from_nanos(offset_ns);
        tokio::time::sleep_until(scheduled_at).await;
        let caller = caller.clone();
        let source_ids = source_ids.clone();
        calls.spawn(async move {
            balanced_call(caller, kind, sequence, scheduled_at, started, source_ids).await
        });
    }
    let mut observations = Vec::with_capacity(schedule_capacity(source_count));
    while let Some(result) = calls.join_next().await {
        ensure!(
            observations.len() < MAX_BALANCED_OBSERVATIONS,
            "balanced observation bound"
        );
        observations.push(result??);
    }
    let available = caller.state.search_gate.available();
    wait_for(
        || {
            caller.state.search_gate.available() == (PERMITS, MAX_WAITERS)
                && metrics.active.load(Ordering::SeqCst) == 0
                && metrics.local_active.load(Ordering::SeqCst) == 0
        },
        "balanced workload did not recover all gate slots and sockets",
    )
    .await?;
    ensure!(available.0 <= PERMITS && available.1 <= MAX_WAITERS);
    ensure!(
        metrics.local_peak.load(Ordering::SeqCst) == PERMITS,
        "balanced workload did not saturate all local execution slots"
    );

    let mut entries = Vec::with_capacity(4);
    for (kind, name) in ENTRY_NAMES.iter().enumerate() {
        let rows: Vec<_> = observations.iter().filter(|row| row.kind == kind).collect();
        let expected_outer = if kind < 2 {
            offered_source_calls
        } else {
            offered_source_calls / source_count
        };
        ensure!(
            rows.len() == expected_outer,
            "balanced offered count mismatch"
        );
        let source_calls: usize = rows.iter().map(|row| row.source_calls).sum();
        let source_successes: usize = rows.iter().map(|row| row.source_successes).sum();
        let source_failures: usize = rows.iter().map(|row| row.source_failures).sum();
        ensure!(source_calls == offered_source_calls);
        ensure!(source_successes + source_failures == source_calls);
        let mut outer_outcomes = serde_json::Map::new();
        for row in &rows {
            let key = format!("{}:{}", row.status, row.code);
            let count = outer_outcomes.entry(key).or_insert_with(|| json!(0usize));
            *count = json!(count.as_u64().unwrap_or_default() + 1);
        }
        let source_outcomes: Vec<_> = ready
            .iter()
            .map(|source| {
                let offered = rows
                    .iter()
                    .filter(|row| row.sources.contains(source))
                    .count();
                let successes = rows
                    .iter()
                    .filter(|row| row.successful_sources.contains(source))
                    .count();
                let failures = rows
                    .iter()
                    .filter(|row| row.failed_sources.contains(source))
                    .count();
                json!({"source":source,"offered":offered,"successes":successes,"failures":failures,
                    "successRate":successes as f64/offered.max(1) as f64})
            })
            .collect();
        let source_failure_codes: serde_json::Map<String, Value> = rows
            .iter()
            .flat_map(|row| &row.source_failure_details)
            .fold(serde_json::Map::new(), |mut counts, failure| {
                let key = failure.code.clone();
                let count = counts.entry(key).or_insert_with(|| json!(0usize));
                *count = json!(count.as_u64().unwrap_or_default() + 1);
                counts
            });
        ensure!(
            source_outcomes
                .iter()
                .all(|row| row["offered"].as_u64()
                    == Some((offered_source_calls / source_count) as u64)),
            "balanced source distribution differs between entries"
        );
        entries.push(json!({
            "kind":kind,"name":name,"offeredOuterCalls":rows.len(),
            "expectedSourceCalls":source_calls,"sourceSuccesses":source_successes,
            "sourceFailures":source_failures,"sourceSuccessRate":source_successes as f64/source_calls as f64,
            "sourceOutcomes":source_outcomes,"sourceFailureCodes":source_failure_codes,
            "outerOutcomes":outer_outcomes
        }));
    }
    observations.sort_unstable_by_key(|row| (row.kind, row.sequence));
    Ok(json!({
        "durationSeconds":BALANCED_SECONDS,
        "targetSourceCallsPerSecondPerEntry":BALANCED_SOURCE_OPS_PER_SECOND,
        "scheduleVersion":BALANCED_SCHEDULE_VERSION,
        "sourceCallsOfferedPerEntry":offered_source_calls,
        "readySources":ready,
        "entries":entries,
        "observations":observations,
        "peakLocalExecution":metrics.local_peak.load(Ordering::SeqCst),
        "finalLocalExecution":metrics.local_active.load(Ordering::SeqCst),
        "finalUpstreamActive":metrics.active.load(Ordering::SeqCst),
        "finalAvailable":caller.state.search_gate.available()
    }))
}

fn schedule_capacity(source_count: usize) -> usize {
    let direct = BALANCED_SECONDS as usize * BALANCED_SOURCE_OPS_PER_SECOND;
    direct.saturating_mul(2) + direct.saturating_mul(2) / source_count.max(1)
}

async fn wait_for(mut predicate: impl FnMut() -> bool, label: &str) -> Result<()> {
    timeout(Duration::from_secs(3), async {
        while !predicate() {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .with_context(|| label.to_string())?;
    Ok(())
}

fn error(status: u16, body: &Value, expected: u16, code: &str) -> Result<()> {
    error_from_source(status, body, expected, code, "ccmixter")
}

fn error_from_source(
    status: u16,
    body: &Value,
    expected: u16,
    code: &str,
    source: &str,
) -> Result<()> {
    ensure!(
        status == expected,
        "expected {expected}, got {status}: {body}"
    );
    ensure!(body["error"]["code"] == code, "unexpected error: {body}");
    ensure!(body["error"]["source"] == source, "missing source");
    ensure!(
        body["error"]["request_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "missing request ID"
    );
    Ok(())
}

fn hash(bytes: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn source_hashes() -> Result<Value> {
    // Bind the report to exactly the source bytes Cargo compiled. A concurrent
    // edit invalidates evidence rather than labelling an older test executable.
    let files: &[(&str, &[u8])] = &[
        ("Cargo.lock", include_bytes!("../../../../Cargo.lock")),
        (
            "crates/hertz-studio/Cargo.toml",
            include_bytes!("../../Cargo.toml"),
        ),
        (
            "crates/hertz-studio/src/online/search_gate.rs",
            include_bytes!("search_gate.rs"),
        ),
        (
            "crates/hertz-studio/src/online/aggregate.rs",
            include_bytes!("aggregate.rs"),
        ),
        (
            "crates/hertz-studio/src/online/provider.rs",
            include_bytes!("provider.rs"),
        ),
        (
            "crates/hertz-studio/src/online/mod.rs",
            include_bytes!("mod.rs"),
        ),
        (
            "crates/hertz-studio/src/online/search_pressure.rs",
            include_bytes!("search_pressure.rs"),
        ),
        (
            "crates/hertz-studio/build.rs",
            include_bytes!("../../build.rs"),
        ),
        ("Cargo.toml", include_bytes!("../../../../Cargo.toml")),
        (
            "crates/hertz-studio/src/online/http.rs",
            include_bytes!("http.rs"),
        ),
        (
            "scripts/run-search-pressure.js",
            include_bytes!("../../../../scripts/run-search-pressure.js"),
        ),
        (
            "scripts/sample-process-memory.ps1",
            include_bytes!("../../../../scripts/sample-process-memory.ps1"),
        ),
        (
            "crates/hertz-studio/src/routes.rs",
            include_bytes!("../routes.rs"),
        ),
        (
            "crates/hertz-studio/src/rpc/online.rs",
            include_bytes!("../rpc/online.rs"),
        ),
    ];
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut hashes = serde_json::Map::new();
    for (file, compiled) in files {
        let expected = hash(compiled);
        ensure!(
            hash(std::fs::read(root.join(file))?) == expected,
            "compiled source changed: {file}"
        );
        hashes.insert((*file).into(), json!(expected));
    }
    Ok(Value::Object(hashes))
}

async fn exercise(caller: &Caller, metrics: &Arc<Metrics>, long: bool) -> Result<Value> {
    let clock = Instant::now();
    let mut phases = Vec::new();
    // Touch the bounded compact observation storage before the memory baseline.
    // JSON serialization happens after the last idle phase. Driver/upstream
    // allocations still belong to this test process, not a production RSS gate.
    let mut observations = vec![Observation::default(); MAX_OBSERVATIONS];
    let mut observed = 0;
    phase(&mut phases, clock, "boundary-matrix".into());
    let available = || caller.state.search_gate.available();
    let mut saturation = JoinSet::new();
    for n in 0..PERMITS {
        let caller = caller.clone();
        saturation.spawn(async move { caller.call(n % 2, "hold-saturation").await });
    }
    wait_for(
        || metrics.active.load(Ordering::SeqCst) == PERMITS,
        "execution slots not occupied",
    )
    .await?;
    let before_waiters = metrics.started.load(Ordering::SeqCst);
    let mut waiters = JoinSet::new();
    for kind in 0..2 {
        let caller = caller.clone();
        waiters.spawn(async move {
            let started = Instant::now();
            let (status, body) = caller.call(kind, "normal-wait-timeout").await?;
            error(status, &body, 429, "search_busy")?;
            Ok::<_, anyhow::Error>(started.elapsed().as_secs_f64() * 1000.0)
        });
    }
    let mut admission_ms = Vec::new();
    while let Some(result) = waiters.join_next().await {
        admission_ms.push(result??);
    }
    ensure!(
        admission_ms.iter().all(|ms| *ms >= 1800.0 && *ms < 3000.0),
        "two-second admission timeout: {admission_ms:?}"
    );
    ensure!(
        metrics.started.load(Ordering::SeqCst) == before_waiters,
        "expired waiters reached upstream"
    );
    for n in 0..MAX_WAITERS {
        let caller = caller.clone();
        saturation.spawn(async move { caller.call(n % 2, "hold-queued").await });
    }
    wait_for(|| available() == (0, 0), "waiting seats not occupied").await?;
    let started = Instant::now();
    let (status, body) = caller.call(0, "normal-overflow").await?;
    error(status, &body, 429, "search_busy")?;
    let overflow_ms = started.elapsed().as_secs_f64() * 1000.0;
    ensure!(overflow_ms < 1000.0, "overflow waited instead of rejecting");
    saturation.abort_all();
    while saturation.join_next().await.is_some() {}
    wait_for(
        || {
            available() == (PERMITS, MAX_WAITERS)
                && metrics.active.load(Ordering::SeqCst) == 0
                && metrics.local_active.load(Ordering::SeqCst) == 0
        },
        "HTTP/RPC cancellation did not release all execution/waiting slots and sockets",
    )
    .await?;

    let mut deadline_cases = Vec::new();
    for mode in ["hold-header-deadline", "body-stall-deadline"] {
        let mut deadlines = JoinSet::new();
        for n in 0..PERMITS {
            let caller = caller.clone();
            deadlines.spawn(async move {
                let started = Instant::now();
                let (status, body) = caller.call(n % 2, mode).await?;
                error(status, &body, 504, "upstream_timeout")?;
                Ok::<_, anyhow::Error>(started.elapsed().as_secs_f64() * 1000.0)
            });
        }
        let mut deadline_ms = Vec::new();
        while let Some(result) = deadlines.join_next().await {
            deadline_ms.push(result??);
        }
        ensure!(
            deadline_ms.iter().all(|ms| *ms >= 5500.0 && *ms < 7500.0),
            "six-second {mode}: {deadline_ms:?}"
        );
        wait_for(
            || {
                available() == (PERMITS, MAX_WAITERS)
                    && metrics.active.load(Ordering::SeqCst) == 0
                    && metrics.local_active.load(Ordering::SeqCst) == 0
            },
            "timeout did not close sockets/recover capacity",
        )
        .await?;
        deadline_cases.push(json!({"mode":mode,"elapsedMs":deadline_ms}));
    }

    let balanced = balanced_throughput(caller, metrics, clock, &mut phases).await?;

    // Default: one minute. Explicit long mode: three two-minute cycles with
    // ten-second baseline/inter-cycle idle windows, using original gate values.
    let cycles = if long { 3 } else { 1 };
    let seconds = if long { 120 } else { 60 };
    let idle_seconds = if long { 10 } else { 0 };
    phase(&mut phases, clock, "baseline-idle".into());
    sleep(Duration::from_secs(idle_seconds)).await;
    let sustained = Instant::now();
    let mut wave = 0;
    let mut cycle_reports = Vec::new();
    for cycle in 0..cycles {
        phase(&mut phases, clock, format!("load-{cycle}"));
        let cycle_started = Instant::now();
        let first_wave = wave;
        let first_observation = observed;
        while cycle_started.elapsed() < Duration::from_secs(seconds) {
            let mut calls = JoinSet::new();
            for n in 0usize..32 {
                let caller = caller.clone();
                calls.spawn(async move {
                    let kind = n % 4;
                    let cancel = n.is_multiple_of(5);
                    let mode = if cancel {
                        "hold"
                    } else if n.is_multiple_of(3) {
                        "reject"
                    } else {
                        "normal"
                    };
                    let keyword = format!("{mode}-{wave}-{n}");
                    let started = Instant::now();
                    let call = caller.call(kind, &keyword);
                    let result = if cancel {
                        tokio::select! {
                            result = call => Some(result?),
                            _ = sleep(Duration::from_millis(100)) => None,
                        }
                    } else {
                        Some(call.await?)
                    };
                    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
                    let (status, code) = if let Some((status, body)) = result {
                        if status == 200 {
                            if kind < 2 {
                                ensure!(
                                    body["keyword"] == keyword && body["source"] == "ccmixter",
                                    "cross-request response"
                                );
                            } else {
                                ensure!(body["query"] == keyword, "aggregate query identity");
                                let results =
                                    body["results"].as_array().context("aggregate results")?;
                                let failures =
                                    body["failed"].as_array().context("aggregate failures")?;
                                ensure!(
                                    results.len() + failures.len()
                                        == super::music_sources().count(),
                                    "aggregate lost a source"
                                );
                                for result in results {
                                    ensure!(
                                        result["keyword"] == keyword,
                                        "aggregate response identity"
                                    );
                                }
                            }
                            (status, "ok")
                        } else {
                            let code = body["error"]["code"].as_str().context("error code")?;
                            ensure!(
                                matches!(
                                    (status, code),
                                    (429, "search_busy")
                                        | (502, "upstream_rejected")
                                        | (504, "upstream_timeout")
                                ),
                                "unexpected pressure failure: {body}"
                            );
                            error(status, &body, status, code)?;
                            (
                                status,
                                match code {
                                    "search_busy" => "search_busy",
                                    "upstream_rejected" => "upstream_rejected",
                                    "upstream_timeout" => "upstream_timeout",
                                    _ => unreachable!(),
                                },
                            )
                        }
                    } else {
                        (0, "cancelled")
                    };
                    Ok::<_, anyhow::Error>(Observation {
                        cycle,
                        wave,
                        client: n,
                        kind,
                        status,
                        code,
                        elapsed_ms,
                    })
                });
            }
            while let Some(result) = calls.join_next().await {
                ensure!(observed < MAX_OBSERVATIONS, "probe observation bound");
                observations[observed] = result??;
                observed += 1;
            }
            wait_for(
                || {
                    available() == (PERMITS, MAX_WAITERS)
                        && metrics.active.load(Ordering::SeqCst) == 0
                        && metrics.local_active.load(Ordering::SeqCst) == 0
                },
                "mixed workload did not recover all gate slots and sockets",
            )
            .await?;
            ensure!(
                metrics.local_peak.load(Ordering::SeqCst) <= PERMITS,
                "shared gate exceeded local execution limit: {}",
                metrics.local_peak.load(Ordering::SeqCst)
            );
            wave += 1;
        }
        ensure!(wave - first_wave >= 10, "insufficient repeated waves");
        cycle_reports.push(json!({"cycle":cycle,"requestedSeconds":seconds,
            "actualSeconds":cycle_started.elapsed().as_secs_f64(),
            "firstWave":first_wave,"waves":wave-first_wave,"requests":observed-first_observation,
            "finalAvailable":available(),"finalLocalExecution":metrics.local_active.load(Ordering::SeqCst),
            "finalUpstreamActive":metrics.active.load(Ordering::SeqCst)}));
        phase(&mut phases, clock, format!("idle-{cycle}"));
        sleep(Duration::from_secs(idle_seconds)).await;
    }
    ensure!(wave >= 10, "insufficient repeated waves: {wave}");
    let (status, body) = caller.call(0, "normal-final").await?;
    ensure!(
        status == 200 && body["keyword"] == "normal-final",
        "post-load recovery"
    );
    wait_for(
        || metrics.active.load(Ordering::SeqCst) == 0,
        "final socket cleanup",
    )
    .await?;
    ensure!(
        metrics.started.load(Ordering::SeqCst)
            == metrics.replied.load(Ordering::SeqCst) + metrics.disconnected.load(Ordering::SeqCst),
        "upstream request accounting did not reconcile"
    );
    phase(&mut phases, clock, "complete".into());
    observations.truncate(observed);
    Ok(
        json!({"overflowRejectMs":overflow_ms,"admissionTimeoutMs":admission_ms,"deadlineCases":deadline_cases,
        "sustainedSeconds":sustained.elapsed().as_secs_f64(),"cycles":cycle_reports,"idleSeconds":idle_seconds,
        "balancedThroughput":balanced,
        "phases":phases,"observationCapacity":MAX_OBSERVATIONS,"waves":wave,"requests":observations.len(),
        "observations":observations,"peakUpstream":metrics.peak.load(Ordering::SeqCst),
        "peakLocalExecution":metrics.local_peak.load(Ordering::SeqCst),"finalLocalExecution":metrics.local_active.load(Ordering::SeqCst),
        "upstreamStarted":metrics.started.load(Ordering::SeqCst),"upstreamDisconnected":metrics.disconnected.load(Ordering::SeqCst),
        "upstreamReplied":metrics.replied.load(Ordering::SeqCst),"finalAvailable":available()}),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit mixed HTTP/RPC/aggregate pressure probe; optional long mode; no external network"]
async fn sustained_shared_search_budget() -> Result<()> {
    let hashes = source_hashes()?;
    let long = match std::env::var("HERTZ_SEARCH_PRESSURE_LONG") {
        Ok(value) if value == "1" => true,
        Err(std::env::VarError::NotPresent) => false,
        _ => anyhow::bail!("HERTZ_SEARCH_PRESSURE_LONG must be absent or 1"),
    };
    // Reject an existing report before any database/server/pressure work.
    let report_file = std::env::var_os("HERTZ_SEARCH_PRESSURE_REPORT")
        .map(|path| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
        })
        .transpose()?;
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let dir = std::env::temp_dir().join(format!("hertz-search-pressure-{}", uuid::Uuid::new_v4()));
    let db = vmusic_store::open(&dir).await?;
    vmusic_store::settings::set(&db, "jamendo_client_id", &json!("fixture-not-a-credential"))
        .await?;
    let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
    state.token = "search-pressure-fixture".into();
    let state = Arc::new(state);
    let metrics = Arc::new(Metrics::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = listener.local_addr()?;
    let target = Target {
        address: upstream_address,
        metrics: metrics.clone(),
    };
    let fixture_metrics = metrics.clone();
    let fixture = tokio::spawn(async move {
        let mut tasks = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (socket, _) = accepted?;
                    let metrics = fixture_metrics.clone();
                    tasks.spawn(async move { timeout(Duration::from_secs(12), upstream(socket, metrics)).await? });
                }
                Some(result) = tasks.join_next(), if !tasks.is_empty() => { result??; }
            }
        }
        #[allow(unreachable_code)]
        Ok::<_, anyhow::Error>(())
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let http_target = target.clone();
    let app = crate::routes::router(state.clone())
        .with_state(state.clone())
        .layer(from_fn(
            move |request: axum::extract::Request, next: Next| {
                UPSTREAM.scope(http_target.clone(), next.run(request))
            },
        ));
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let caller = Caller {
        state: state.clone(),
        address,
        target,
        client: reqwest::Client::builder()
            .no_proxy()
            .pool_max_idle_per_host(0)
            .timeout(Duration::from_secs(10))
            .build()?,
    };
    let result = timeout(
        Duration::from_secs(if long { 540 } else { 180 }),
        exercise(&caller, &metrics, long),
    )
    .await
    .context("pressure probe deadline")
    .and_then(|result| result);
    drop(caller);
    server.abort();
    let _ = server.await;
    let fixture_result = if fixture.is_finished() {
        match fixture.await {
            Ok(result) => result.context("controlled upstream stopped before cleanup"),
            Err(error) => Err(anyhow::Error::new(error).context("controlled upstream task")),
        }
    } else {
        fixture.abort();
        let _ = fixture.await;
        Ok(())
    };
    state.audio.shutdown();
    audio
        .join()
        .map_err(|_| anyhow::anyhow!("audio fixture thread"))?;
    state.db.close().await;
    drop(state);
    std::fs::remove_dir_all(&dir)?;
    fixture_result?;
    let observations = result?;
    ensure!(
        source_hashes()? == hashes,
        "source changed during pressure probe"
    );
    let compiler = env!("HERTZ_BUILD_RUSTC_VERSION");
    let report = json!({"schemaVersion":7,"edition":crate::edition::NAME,"os":std::env::consts::OS,"arch":std::env::consts::ARCH,
        "startedAtUnix":started_at,"compiler":compiler,
        "logicalCpus":std::thread::available_parallelism()?.get(),"runtimeWorkers":4,"profile":"test","debugAssertions":cfg!(debug_assertions),
        "longMode":long,"processId":std::process::id(),"memoryScope":"test-process-including-driver-and-upstream",
        "sourceHashes":hashes,"testBinaryHash":hash(std::fs::read(std::env::current_exe()?)?),
        "productionGate":{"permits":PERMITS,"waiters":MAX_WAITERS,"waitSeconds":WAIT.as_secs(),"totalSeconds":SOURCE_DEADLINE.as_secs()},
        "closedBeforeRequest":metrics.closed_before_request.load(Ordering::SeqCst),
        "realProvidersVerified":false,"nativeDbxVerified":false,"weakHardwareVerified":false,"wholeProcessRssVerified":false,
        "releaseEligible":false,"results":observations});
    if let Some(mut file) = report_file {
        use std::io::Write;
        file.write_all(serde_json::to_string_pretty(&report)?.as_bytes())?;
    }
    println!(
        "{}",
        json!({"edition":report["edition"],"requests":report["results"]["requests"],"waves":report["results"]["waves"],"peakUpstream":report["results"]["peakUpstream"],"finalAvailable":report["results"]["finalAvailable"]})
    );
    Ok(())
}
