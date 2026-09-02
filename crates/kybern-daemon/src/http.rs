//! Plain HTTP routes beside the WebSocket: health, pairing, and assets.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{
    Json, Router,
    routing::{get, post},
};
use chrono::Utc;
use kybern_protocol::methods::{AssetInfo, PairRequest, PairResponse};
use uuid::Uuid;

use crate::auth::authenticate;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/pair", post(pair))
        .route("/assets", post(upload_asset))
        .route("/assets/{id}", get(get_asset))
}

async fn pair(State(state): State<AppState>, Json(req): Json<PairRequest>) -> Response {
    match state.pairing.redeem(&state.store, &req.code, req.device_name) {
        Ok((token, scopes)) => Json(PairResponse { token, scopes, environment_id: state.environment_id.clone() }).into_response(),
        Err(e) => (StatusCode::UNAUTHORIZED, e.to_string()).into_response(),
    }
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ").map(str::to_string)
}

const MAX_ASSET_BYTES: usize = 50 * 1024 * 1024;

async fn upload_asset(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(raw) = bearer(&headers) else { return (StatusCode::UNAUTHORIZED, "missing token").into_response() };
    let principal = match authenticate(&state.store, &raw) {
        Ok(Some(p)) if p.has(kybern_protocol::Scope::OrchestrationOperate) => p,
        _ => return (StatusCode::FORBIDDEN, "token cannot upload").into_response(),
    };
    let _ = principal;
    if body.len() > MAX_ASSET_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "attachments are limited to 50 MB").into_response();
    }
    let name = headers.get("x-kybern-filename").and_then(|v| v.to_str().ok()).unwrap_or("attachment").to_string();
    let media_type = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
    let id = Uuid::now_v7();
    if let Err(e) = std::fs::create_dir_all(&state.paths.assets) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    if let Err(e) = tokio::fs::write(state.paths.assets.join(id.to_string()), &body).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    let info = AssetInfo { id, name, media_type, size: body.len() as u64, created_at: Utc::now() };
    if let Err(e) = state.store.asset_insert(&info) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    Json(info).into_response()
}

async fn get_asset(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>) -> Response {
    let Some(raw) = bearer(&headers).or_else(|| headers.get("x-kybern-token").and_then(|v| v.to_str().ok()).map(str::to_string)) else {
        return (StatusCode::UNAUTHORIZED, "missing token").into_response();
    };
    if !matches!(authenticate(&state.store, &raw), Ok(Some(_))) {
        return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
    }
    let Ok(Some(info)) = state.store.asset_get(id) else { return (StatusCode::NOT_FOUND, "no such asset").into_response() };
    match tokio::fs::read(state.paths.assets.join(id.to_string())).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, info.media_type),
                (header::CONTENT_DISPOSITION, format!("inline; filename=\"{}\"", info.name.replace('"', ""))),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "asset file missing").into_response(),
    }
}
