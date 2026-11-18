// SPDX-License-Identifier: MIT
//! Transport only; author/reviewer identity and state transitions stay in Hub.
use crate::{
    administration::RoleChangeInput,
    error::{HubError, Result},
    management::ReportStatus,
    model::{Actor, CreateWork, UploadInput},
    reports::{ReportInput, ResolveInput},
    review::ReviewInput,
    store::Hub,
};
use axum::{
    body::{to_bytes, Body},
    extract::{ConnectInfo, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::{de::DeserializeOwned, Deserialize};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

const MAX_JSON: usize = 65_536;

pub(crate) fn router(hub: Hub) -> Router {
    Router::new()
        .route("/.well-known/hertz-wallpaper-community", get(discovery))
        .route("/v1/works", get(works).post(create_work))
        .route("/v1/keys", get(authorization_chain))
        .route("/v1/auth/config", get(discovery))
        .route("/v1/admin/users", get(management_users))
        .route("/v1/admin/users/{id}", get(management_user_detail))
        .route("/v1/admin/users/{id}/role", put(change_role))
        .route("/v1/admin/audit", get(management_audit))
        .route("/v1/management/operations/{id}", get(management_operation))
        .route("/v1/revocations", get(revocations))
        .route("/v1/revocations/prepare", post(prepare_revocations))
        .route("/v1/publications/{id}", get(publication_status))
        .route("/v1/works/{work}/release", get(published))
        .route("/v1/works/{work}/package", get(public_package))
        .route("/v1/works/{work}/releases/{id}", get(public_release))
        .route(
            "/v1/works/{work}/releases/{id}/package",
            get(version_package),
        )
        .route("/v1/works/{work}/uploads", post(reserve))
        .route("/v1/me/works", get(own_works))
        .route("/v1/me/releases", get(own_releases))
        .route("/v1/uploads/{id}", get(upload))
        .route("/v1/uploads/{id}/content", put(receive))
        .route("/v1/uploads/{id}/submit", post(submit))
        .route("/v1/releases/{id}", get(candidate))
        .route("/v1/releases/{id}/package", get(private_package))
        .route("/v1/releases/{id}/review", post(review))
        .route("/v1/releases/{id}/publish", post(publish))
        .route("/v1/releases/{id}/revoke", post(revoke))
        .route("/v1/releases/{id}/withdraw", post(withdraw))
        .route("/v1/review-queue", get(review_queue))
        .route("/v1/reports", get(report_queue).post(report))
        .route("/v1/reports/{id}", get(report_detail))
        .route("/v1/reports/{id}/resolve", post(resolve_report))
        .fallback(|| async { HubError::missing() })
        .layer(middleware::from_fn_with_state(hub.clone(), boundary))
        .with_state(hub)
}

// Only the configured TLS proxy can reach the API. It must REPLACE these
// forwarding headers with one observed client IP, never append caller values.
async fn boundary(State(hub): State<Hub>, mut request: Request, next: Next) -> Response {
    let result = async {
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .ok_or_else(HubError::denied)?
            .0
            .ip();
        if !hub.config.trusted_proxies.contains(&peer) {
            return Err(HubError::denied());
        }
        let headers = request.headers();
        if headers.len() > 64
            || headers
                .iter()
                .map(|(key, value)| key.as_str().len() + value.len())
                .sum::<usize>()
                > 32_768
        {
            return Err(HubError::invalid("请求头过大"));
        }
        if one(headers, "x-forwarded-proto")? != Some("https") || headers.contains_key("forwarded")
        {
            return Err(HubError::denied());
        }
        let origin = crate::config::https_url(&hub.config.public_origin)?;
        let expected_host = origin
            .as_str()
            .strip_prefix("https://")
            .ok_or_else(HubError::unavailable)?
            .trim_end_matches('/');
        let host = one(headers, "host")?.ok_or_else(HubError::denied)?;
        if host != expected_host && host != format!("{expected_host}:443") {
            return Err(HubError::denied());
        }
        if one(headers, "origin")?
            .is_some_and(|value| value != hub.config.public_origin.trim_end_matches('/'))
        {
            return Err(HubError::denied());
        }
        let ip: IpAddr = one(headers, "x-forwarded-for")?
            .ok_or_else(HubError::denied)?
            .parse()
            .map_err(|_| HubError::denied())?;
        let ip = match ip {
            IpAddr::V6(value) => value
                .to_ipv4_mapped()
                .map(IpAddr::V4)
                .unwrap_or(IpAddr::V6(value)),
            other => other,
        };
        hub.limits.request(ip)?;
        if one(headers, "content-encoding")?.is_some_and(|value| value != "identity") {
            return Err(HubError::invalid("请求体不接受压缩编码"));
        }
        let permit = hub
            .requests
            .clone()
            .try_acquire_owned()
            .map_err(|_| HubError::limited("服务请求槽暂满"))?;
        request.extensions_mut().insert(ClientIp(ip));
        Ok(permit)
    }
    .await;
    let mut response = match result {
        Ok(_permit) => next.run(request).await,
        Err(error) => error.into_response(),
    };
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}

#[derive(Clone, Copy)]
struct ClientIp(IpAddr);

pub(crate) fn one<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .map(|value| {
            value
                .to_str()
                .map_err(|_| HubError::invalid("请求头编码无效"))
        })
        .transpose()?;
    if values.next().is_some() {
        return Err(HubError::invalid("请求头不得重复"));
    }
    Ok(value)
}
async fn actor(hub: &Hub, headers: &HeaderMap, scope: &str) -> Result<Actor> {
    let authorization = one(headers, "authorization")?.ok_or_else(HubError::unauthorized)?;
    let (scheme, token) = authorization
        .split_once(' ')
        .ok_or_else(HubError::unauthorized)?;
    if !scheme.eq_ignore_ascii_case("bearer")
        || token.is_empty()
        || token.contains(char::is_whitespace)
    {
        return Err(HubError::unauthorized());
    }
    let identity = tokio::time::timeout(Duration::from_secs(25), hub.auth.authenticate(token))
        .await
        .map_err(|_| HubError::unavailable())??;
    if !identity.scopes.contains(scope)
        || identity
            .scopes
            .iter()
            .any(|scope| !hub.config.scopes.contains(scope))
    {
        return Err(HubError::denied());
    }
    hub.actor(identity).await
}
async fn json<T: DeserializeOwned>(request: Request) -> Result<T> {
    let content_type = one(request.headers(), "content-type")?
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if !content_type.eq_ignore_ascii_case("application/json") {
        return Err(HubError::invalid("请求须使用application/json"));
    }
    let bytes = tokio::time::timeout(
        Duration::from_secs(10),
        to_bytes(request.into_body(), MAX_JSON),
    )
    .await
    .map_err(|_| HubError::invalid("请求体读取超时"))?
    .map_err(|_| HubError::invalid("请求体超过64KiB或读取失败"))?;
    hertz_wallpaper::json::check_bounded_json(&bytes, 16)
        .map_err(|_| HubError::invalid("JSON包含重复字段或超出结构限制"))?;
    serde_json::from_slice(&bytes).map_err(|_| HubError::invalid("请求字段无效"))
}
async fn empty(body: Body) -> Result<()> {
    let bytes = tokio::time::timeout(Duration::from_secs(10), to_bytes(body, 0))
        .await
        .map_err(|_| HubError::invalid("请求体读取超时"))?
        .map_err(|_| HubError::invalid("此操作不接受请求体"))?;
    if !bytes.is_empty() {
        return Err(HubError::invalid("此操作不接受请求体"));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    #[serde(default)]
    offset: i64,
    #[serde(default = "page_size")]
    limit: i64,
}
fn page_size() -> i64 {
    20
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportPage {
    #[serde(default)]
    offset: i64,
    #[serde(default = "page_size")]
    limit: i64,
    #[serde(default)]
    status: ReportStatus,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuditPage {
    #[serde(default)]
    after: i64,
    #[serde(default = "page_size")]
    limit: i64,
}
impl Page {
    fn validate(&self) -> Result<()> {
        if self.offset < 0 || self.offset > 1_000_000 || !(1..=50).contains(&self.limit) {
            Err(HubError::invalid("分页offset须为0–1000000，每页1–50项"))
        } else {
            Ok(())
        }
    }
}
async fn discovery(State(hub): State<Hub>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"hubId":hub.config.hub_id,"origin":hub.config.public_origin,
        "issuer":hub.config.issuer,"clientId":hub.config.desktop_client_id,"audience":hub.config.api_audience,
        "scopes":hub.config.scopes,"allowedSigningAlgorithms":hub.config.allowed_signing_algorithms,
        "rootFingerprint":hub.config.root_fingerprint,"protocolVersion":1,"authorWebEnabled":false}),
    )
}
async fn authorization_chain(State(hub): State<Hub>) -> Result<Response> {
    let bytes = hub
        .authorization
        .canonical_bytes()
        .map_err(|_| HubError::unavailable())?;
    Ok(([(header::CONTENT_TYPE, "application/json")], bytes).into_response())
}
async fn revocations(State(hub): State<Hub>, headers: HeaderMap) -> Result<Response> {
    let (signed, digest) = hub.signed_revocations().await?;
    let etag = format!("\"{digest}\"");
    if one(&headers, "if-none-match")? == Some(etag.as_str()) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    Ok((
        [
            (header::CONTENT_TYPE, "application/json".to_owned()),
            (header::ETAG, etag),
        ],
        signed,
    )
        .into_response())
}
async fn publish(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    request: Request,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    Ok(Json(
        hub.publish(
            actor,
            id,
            json::<crate::publication::PublishInput>(request).await?,
        )
        .await?,
    ))
}
async fn publication_status(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(hub.publication_status(&actor, &id).await?))
}
async fn revoke(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    request: Request,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    Ok(Json(
        hub.prepare_revocations(
            actor,
            Some(id),
            json::<crate::revocation::PrepareInput>(request).await?,
        )
        .await?,
    ))
}
async fn prepare_revocations(
    State(hub): State<Hub>,
    request: Request,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    Ok(Json(
        hub.prepare_revocations(
            actor,
            None,
            json::<crate::revocation::PrepareInput>(request).await?,
        )
        .await?,
    ))
}
async fn works(State(hub): State<Hub>, Query(page): Query<Page>) -> Result<impl IntoResponse> {
    page.validate()?;
    Ok(Json(hub.public_works(page.offset, page.limit).await?))
}
async fn create_work(State(hub): State<Hub>, request: Request) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    Ok((
        StatusCode::CREATED,
        Json(
            hub.create_work(&actor, json::<CreateWork>(request).await?)
                .await?,
        ),
    ))
}
async fn published(State(hub): State<Hub>, Path(work): Path<String>) -> Result<Response> {
    let candidate = hub.published(&work).await?;
    let signed = candidate.signed_release.ok_or_else(HubError::missing)?;
    Ok(([(header::CONTENT_TYPE, "application/json")], signed).into_response())
}
async fn public_package(
    State(hub): State<Hub>,
    Path(work): Path<String>,
    request: Request,
) -> Result<Response> {
    let ip = request
        .extensions()
        .get::<ClientIp>()
        .ok_or_else(HubError::unavailable)?
        .0;
    let candidate = hub.published(&work).await?;
    hub.download(candidate, ip, request.headers(), request.method())
        .await
}
async fn public_release(
    State(hub): State<Hub>,
    Path((work, id)): Path<(String, String)>,
) -> Result<Response> {
    let signed = hub
        .published_release(&work, &id)
        .await?
        .signed_release
        .ok_or_else(HubError::missing)?;
    Ok(([(header::CONTENT_TYPE, "application/json")], signed).into_response())
}
async fn version_package(
    State(hub): State<Hub>,
    Path((work, id)): Path<(String, String)>,
    request: Request,
) -> Result<Response> {
    let ip = request
        .extensions()
        .get::<ClientIp>()
        .ok_or_else(HubError::unavailable)?
        .0;
    hub.download(
        hub.published_release(&work, &id).await?,
        ip,
        request.headers(),
        request.method(),
    )
    .await
}
async fn reserve(
    State(hub): State<Hub>,
    Path(work): Path<String>,
    request: Request,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    Ok((
        StatusCode::CREATED,
        Json(
            hub.reserve_upload(&actor, &work, json::<UploadInput>(request).await?)
                .await?,
        ),
    ))
}
async fn upload(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, &headers, "wallpaper.write").await?;
    Ok(Json(hub.upload(&actor, &id).await?))
}
async fn receive(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    request: Request,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    if one(request.headers(), "content-type")? != Some("application/octet-stream")
        || request.headers().contains_key("transfer-encoding")
    {
        return Err(HubError::invalid(
            "上传须使用application/octet-stream和明确Content-Length",
        ));
    }
    let length = one(request.headers(), "content-length")?
        .ok_or_else(|| HubError::invalid("上传缺少Content-Length"))?
        .parse::<u64>()
        .map_err(|_| HubError::invalid("Content-Length无效"))?;
    Ok(Json(
        hub.receive(actor, id, length, request.into_body()).await?,
    ))
}
async fn submit(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    request: Request,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    empty(request.into_body()).await?;
    Ok(Json(hub.submit(actor, id).await?))
}
async fn candidate(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(hub.candidate(&actor, &id).await?))
}
async fn private_package(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response> {
    let actor = actor(&hub, request.headers(), "wallpaper.read").await?;
    let ip = request
        .extensions()
        .get::<ClientIp>()
        .ok_or_else(HubError::unavailable)?
        .0;
    hub.download(
        hub.candidate(&actor, &id).await?,
        ip,
        request.headers(),
        request.method(),
    )
    .await
}
async fn review(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    request: Request,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    Ok(Json(
        hub.review(&actor, &id, json::<ReviewInput>(request).await?)
            .await?,
    ))
}
async fn withdraw(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    request: Request,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    empty(request.into_body()).await?;
    Ok(Json(hub.withdraw(&actor, &id).await?))
}
async fn own_works(
    State(hub): State<Hub>,
    Query(page): Query<Page>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    page.validate()?;
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(hub.own_works(&actor, page.offset, page.limit).await?))
}
async fn own_releases(
    State(hub): State<Hub>,
    Query(page): Query<Page>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    page.validate()?;
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(
        hub.releases_for(&actor, false, page.offset, page.limit)
            .await?,
    ))
}
async fn review_queue(
    State(hub): State<Hub>,
    Query(page): Query<Page>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    page.validate()?;
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(
        hub.releases_for(&actor, true, page.offset, page.limit)
            .await?,
    ))
}
async fn report(State(hub): State<Hub>, request: Request) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    let id = hub
        .report(&actor, json::<ReportInput>(request).await?)
        .await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({"id":id}))))
}

async fn management_users(
    State(hub): State<Hub>,
    Query(page): Query<Page>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    page.validate()?;
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(
        hub.management_users(&actor, page.offset, page.limit)
            .await?,
    ))
}
async fn change_role(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    request: Request,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    Ok(Json(
        hub.change_role(&actor, &id, json::<RoleChangeInput>(request).await?)
            .await?,
    ))
}
async fn management_user_detail(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(hub.management_user_detail(&actor, &id).await?))
}
async fn management_audit(
    State(hub): State<Hub>,
    Query(page): Query<AuditPage>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(
        hub.management_audit(&actor, page.after, page.limit).await?,
    ))
}
async fn management_operation(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(hub.management_operation(&actor, &id).await?))
}
async fn report_queue(
    State(hub): State<Hub>,
    Query(page): Query<ReportPage>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    Page {
        offset: page.offset,
        limit: page.limit,
    }
    .validate()?;
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(
        hub.report_queue(&actor, page.status, page.offset, page.limit)
            .await?,
    ))
}
async fn report_detail(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(hub.report_detail(&actor, &id).await?))
}
async fn resolve_report(
    State(hub): State<Hub>,
    Path(id): Path<String>,
    request: Request,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, request.headers(), "wallpaper.write").await?;
    Ok(Json(
        hub.resolve_report(&actor, &id, json::<ResolveInput>(request).await?)
            .await?,
    ))
}
