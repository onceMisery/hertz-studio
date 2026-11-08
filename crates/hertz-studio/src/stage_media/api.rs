// SPDX-License-Identifier: MIT
use super::*;
use crate::rpc::{Op, RawBody};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{header, HeaderMap, Method},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};

pub(crate) fn management_router() -> Router<Arc<crate::state::AppState>> {
    Router::new()
        .route(
            "/v1/stage/media",
            get(list).post(command).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/v1/stage/media/import/chunk",
            post(chunk).layer(DefaultBodyLimit::max(CHUNK_BYTES)),
        )
        .route(
            "/v1/stage/presets",
            get(load)
                .put(save)
                .layer(DefaultBodyLimit::max(presets::MAX_BYTES + 4096)),
        )
}
pub(crate) fn resource_router() -> Router<Arc<crate::state::AppState>> {
    Router::new().route("/v1/stage/media/resource/{lease}", get(resource))
}

#[derive(Deserialize)]
#[serde(tag = "action")]
enum Command {
    #[serde(rename = "import.begin")]
    Begin {
        #[serde(flatten)]
        request: Begin,
    },
    #[serde(rename = "import.status")]
    Status {
        #[serde(rename = "importId")]
        import: String,
    },
    #[serde(rename = "import.finish")]
    Finish {
        #[serde(rename = "importId")]
        import: String,
    },
    #[serde(rename = "import.cancel")]
    Cancel {
        #[serde(rename = "importId")]
        import: String,
    },
    #[serde(rename = "lease.acquire")]
    Acquire {
        #[serde(flatten)]
        request: Acquire,
    },
    #[serde(rename = "lease.renew")]
    Renew {
        #[serde(rename = "leaseId")]
        lease: String,
    },
    #[serde(rename = "lease.release")]
    Release {
        #[serde(rename = "leaseId")]
        lease: String,
    },
    #[serde(rename = "lease.read")]
    Read {
        #[serde(rename = "leaseId")]
        lease: String,
        offset: u64,
        count: usize,
    },
    #[serde(rename = "asset.delete")]
    Delete {
        #[serde(rename = "assetId")]
        asset: String,
    },
}
#[derive(Default, Deserialize)]
struct Page {
    #[serde(default)]
    offset: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    import_id: String,
    upload_token: String,
    offset: u64,
    hash: String,
}

pub(crate) async fn rpc(
    state: &Arc<crate::state::AppState>,
    op: Op,
    path: &str,
    query: &Value,
    body: &Value,
    raw: Option<&RawBody>,
    dbx: bool,
) -> ApiResult<Value> {
    let owner = store(state).await?;
    match (op, path) {
        (Op::Get, "v1/stage/media") => {
            owner
                .list(crate::rpc::query_as::<Page>(query)?.offset)
                .await
        }
        (Op::Get, "v1/stage/presets") => presets::load(&owner.db).await.map_err(preset_error),
        (Op::Put, "v1/stage/presets") => {
            if body.to_string().len() > presets::MAX_BYTES + 4096 {
                return Err(bad_request("预设保存请求超限"));
            }
            owner.save(crate::rpc::body_as(body)?).await
        }
        (Op::Post, "v1/stage/media/import/chunk") => {
            let chunk: Chunk = crate::rpc::query_as(query)?;
            let raw = raw.ok_or_else(|| bad_request("缺少二进制素材块"))?;
            owner
                .chunk(
                    &chunk.import_id,
                    &chunk.upload_token,
                    chunk.offset,
                    &chunk.hash,
                    &raw.bytes,
                )
                .await
        }
        (Op::Post, "v1/stage/media") => {
            if body.to_string().len() > 4096 {
                return Err(bad_request("素材操作请求超限"));
            }
            match crate::rpc::body_as::<Command>(body)? {
                Command::Begin { request } => owner.begin(request).await,
                Command::Status { import } => owner.status(&import).await,
                Command::Finish { import } => owner.finish(&import).await,
                Command::Cancel { import } => owner.cancel(&import).await,
                Command::Acquire { request } => owner.acquire(request, dbx).await,
                Command::Renew { lease } => owner.renew(&lease),
                Command::Release { lease } => Ok(owner.release(&lease)),
                Command::Read {
                    lease,
                    offset,
                    count,
                } => owner.read_image(&lease, offset, count).await,
                Command::Delete { asset } => owner.delete(&asset).await,
            }
        }
        _ => Err(bad_request("未知舞台素材操作")),
    }
}
async fn command(
    State(state): State<Arc<crate::state::AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    rpc(
        &state,
        Op::Post,
        "v1/stage/media",
        &Value::Null,
        &body,
        None,
        false,
    )
    .await
    .map(Json)
}
async fn list(
    State(state): State<Arc<crate::state::AppState>>,
    Query(page): Query<Page>,
) -> ApiResult<Json<Value>> {
    store(&state).await?.list(page.offset).await.map(Json)
}
async fn load(State(state): State<Arc<crate::state::AppState>>) -> ApiResult<Json<Value>> {
    let owner = store(&state).await?;
    presets::load(&owner.db)
        .await
        .map_err(preset_error)
        .map(Json)
}
async fn save(
    State(state): State<Arc<crate::state::AppState>>,
    Json(body): Json<presets::Save>,
) -> ApiResult<Json<Value>> {
    store(&state).await?.save(body).await.map(Json)
}
async fn chunk(
    State(state): State<Arc<crate::state::AppState>>,
    Query(c): Query<Chunk>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    store(&state)
        .await?
        .chunk(&c.import_id, &c.upload_token, c.offset, &c.hash, &body)
        .await
        .map(Json)
}

pub(super) fn range(value: Option<&str>, length: u64) -> Result<(u64, u64, bool), ()> {
    let Some(value) = value else {
        return Ok((0, length, false));
    };
    let value = value.strip_prefix("bytes=").ok_or(())?;
    if value.contains(',') || length == 0 {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = length.saturating_sub(suffix);
        return Ok((start, length - start, true));
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(length - 1)
    };
    if start >= length || end < start {
        return Err(());
    }
    Ok((start, end - start + 1, true))
}
async fn resource(
    State(state): State<Arc<crate::state::AppState>>,
    AxumPath(token): AxumPath<String>,
    method: Method,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let owner = store(&state).await?;
    let lease = owner.lease(&token)?;
    let (start, count, partial) = match range(
        headers.get(header::RANGE).and_then(|h| h.to_str().ok()),
        lease.length,
    ) {
        Ok(r) => r,
        Err(()) => {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{}", lease.length))],
            )
                .into_response())
        }
    };
    let mut builder = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, lease.mime)
        .header(header::CONTENT_LENGTH, count)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, no-store, no-transform")
        .header("X-Content-Type-Options", "nosniff");
    if partial {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, start + count - 1, lease.length),
        );
    }
    if method == Method::HEAD {
        return builder.body(Body::empty()).map_err(io);
    }
    let mut file = tokio::fs::File::open(&lease.path).await.map_err(io)?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(io)?;
    // The stream itself pins its lease. Range is read directly from disk in 64 KiB buffers.
    let stream = futures::stream::try_unfold(
        (file, count, lease),
        |(mut file, remaining, lease)| async move {
            if remaining == 0 {
                return Ok::<_, std::io::Error>(None);
            }
            let mut bytes = vec![0; remaining.min(64 * 1024) as usize];
            file.read_exact(&mut bytes).await?;
            let remaining = remaining - bytes.len() as u64;
            Ok(Some((Bytes::from(bytes), (file, remaining, lease))))
        },
    );
    builder.body(Body::from_stream(stream)).map_err(io)
}
