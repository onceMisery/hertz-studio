// SPDX-License-Identifier: MIT
//! One application entry point for the local HTTP and DBX transports.
use super::contract::{LocalRequest, RoomError, RoomResult};
use crate::state::AppState;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn execute(state: Arc<AppState>, request: Value) -> RoomResult<Value> {
    let request = serde_json::from_value::<LocalRequest>(request)
        .map_err(|_| RoomError::invalid("房间请求格式无效"))?;
    state.room.request(state.clone(), request).await
}

pub(crate) fn response(result: RoomResult<Value>) -> (u16, Value) {
    match result {
        Ok(value) => (200, value),
        Err(error) => {
            let status = match error.code.as_str() {
                "room_denied" => 403,
                "room_invalid" => 400,
                "room_inactive" => 409,
                "room_busy" => 409,
                "room_outcome_unknown" | "room_timeout" => 504,
                "chat_rate_limited" => 429,
                _ => 422,
            };
            (
                status,
                json!({"error":{"code":error.code,"message":error.message,"request_id":uuid::Uuid::new_v4()}}),
            )
        }
    }
}
pub(crate) async fn snapshot(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(state.room.snapshot())
}
pub(crate) async fn command(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Value>,
) -> Response {
    let (status, body) = response(execute(state, request).await);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}
