// SPDX-License-Identifier: MIT
use super::*;
use crate::author_operations::OperationKind;

pub(super) async fn me(State(hub): State<Hub>, headers: HeaderMap) -> Result<impl IntoResponse> {
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(hub.author_account(&actor).await?))
}

pub(super) async fn uploads(
    State(hub): State<Hub>,
    Query(page): Query<Page>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    page.validate()?;
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(
        hub.author_uploads(&actor, page.offset, page.limit).await?,
    ))
}

pub(super) async fn operation(
    State(hub): State<Hub>,
    Path((kind, id)): Path<(OperationKind, String)>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let actor = actor(&hub, &headers, "wallpaper.read").await?;
    Ok(Json(hub.author_operation(&actor, kind, &id).await?))
}
