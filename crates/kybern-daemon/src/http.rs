//! Plain HTTP routes beside the WebSocket: health, pairing, and assets.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{
    Json, Router,
    routing::{get, post},
};
use chrono::Utc;
use kybern_protocol::methods::{AssetInfo, PairRequest, PairResponse};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::authenticate;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/pair", post(pair).options(asset_preflight))
        .route("/session", post(session).options(asset_preflight))
        .route("/assets", post(upload_asset).options(asset_preflight))
        .route("/assets/{id}", get(get_asset).options(asset_preflight))
        .route("/threads/{id}/image", get(get_thread_image).options(asset_preflight))
}

async fn pair(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<PairRequest>) -> Response {
    let origin = allowed_asset_origin(&headers);
    if headers.contains_key(header::ORIGIN) && origin.is_none() {
        return (StatusCode::FORBIDDEN, "origin cannot pair").into_response();
    }
    let response = match state.pairing.redeem(&state.store, &req.code, req.device_name) {
        Ok((token, scopes)) => Json(PairResponse { token, scopes, environment_id: state.environment_id.clone() }).into_response(),
        Err(e) if e.is::<crate::access::PairingRateLimited>() => (StatusCode::TOO_MANY_REQUESTS, e.to_string()).into_response(),
        Err(e) => (StatusCode::UNAUTHORIZED, e.to_string()).into_response(),
    };
    let mut response = with_asset_cors(response, origin);
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn session(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let origin = allowed_asset_origin(&headers);
    if headers.contains_key(header::ORIGIN) && origin.is_none() {
        return (StatusCode::FORBIDDEN, "origin cannot connect").into_response();
    }
    let response = match bearer(&headers).and_then(|raw| authenticate(&state.store, &raw).ok().flatten()) {
        Some(principal) => match state.tickets.create(principal) {
            Ok(ticket) => Json(serde_json::json!({ "ticket": ticket })).into_response(),
            Err(_) => (StatusCode::TOO_MANY_REQUESTS, "too many pending connections").into_response(),
        },
        None => (StatusCode::UNAUTHORIZED, "invalid device credential").into_response(),
    };
    let mut response = with_asset_cors(response, origin);
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ").map(str::to_string)
}

const MAX_ASSET_BYTES: usize = 50 * 1024 * 1024;

async fn upload_asset(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let origin = allowed_asset_origin(&headers);
    if headers.contains_key(header::ORIGIN) && origin.is_none() {
        return (StatusCode::FORBIDDEN, "origin cannot upload").into_response();
    }
    let response = upload_asset_inner(&state, &headers, body).await;
    with_asset_cors(response, origin)
}

async fn upload_asset_inner(state: &AppState, headers: &HeaderMap, body: Bytes) -> Response {
    let Some(raw) = bearer(headers) else { return (StatusCode::UNAUTHORIZED, "missing token").into_response() };
    match authenticate(&state.store, &raw) {
        Ok(Some(p)) if p.has(kybern_protocol::Scope::OrchestrationOperate) => {}
        _ => return (StatusCode::FORBIDDEN, "token cannot upload").into_response(),
    }
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

/// Browser WebViews preflight uploads because they carry the daemon token and
/// original filename in request headers. Keep the allow-list deliberately
/// narrow: this daemon may be loopback-only, but its bearer token is still a
/// privileged credential that arbitrary pages must not be allowed to use.
async fn asset_preflight(headers: HeaderMap) -> Response {
    let origin = allowed_asset_origin(&headers);
    if headers.contains_key(header::ORIGIN) && origin.is_none() {
        return (StatusCode::FORBIDDEN, "origin cannot upload").into_response();
    }

    let response = StatusCode::NO_CONTENT.into_response();
    let mut response = with_asset_cors(response, origin);
    response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
    response
        .headers_mut()
        .insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("authorization, content-type, x-kybern-filename"));
    response.headers_mut().insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    response
}

pub(crate) fn allowed_asset_origin(headers: &HeaderMap) -> Option<HeaderValue> {
    let origin = headers.get(header::ORIGIN)?;
    let value = origin.to_str().ok()?;
    let is_tauri = matches!(value, "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost");
    let is_local_dev = ["http://localhost:", "http://127.0.0.1:"]
        .iter()
        .any(|prefix| value.strip_prefix(prefix).is_some_and(|port| port.parse::<u16>().is_ok()));
    (is_tauri || is_local_dev).then(|| origin.clone())
}

fn with_asset_cors(mut response: Response, origin: Option<HeaderValue>) -> Response {
    if let Some(origin) = origin {
        response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response.headers_mut().insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

async fn get_asset(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>) -> Response {
    let origin = allowed_asset_origin(&headers);
    let mut response = get_asset_inner(state, headers, id).await;
    if let Some(origin) = origin {
        response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    response.headers_mut().insert(header::VARY, HeaderValue::from_static("Origin"));
    response
}

async fn get_asset_inner(state: AppState, headers: HeaderMap, id: Uuid) -> Response {
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

#[cfg(test)]
mod tests {
    use super::{allowed_asset_origin, asset_preflight};
    use axum::http::{HeaderMap, HeaderValue, StatusCode, header};

    fn headers(origin: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        headers
    }

    #[test]
    fn accepts_tauri_and_vite_origins() {
        for origin in ["http://tauri.localhost", "tauri://localhost", "http://localhost:1420", "http://127.0.0.1:5173"] {
            assert_eq!(allowed_asset_origin(&headers(origin)).unwrap(), origin);
        }
    }

    #[test]
    fn rejects_web_pages_and_malformed_local_ports() {
        for origin in ["https://example.com", "http://localhost:evil", "null"] {
            assert!(allowed_asset_origin(&headers(origin)).is_none());
        }
    }

    #[tokio::test]
    async fn attachment_preflight_returns_the_headers_webviews_require() {
        let response = asset_preflight(headers("tauri://localhost")).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(), "tauri://localhost");
        assert_eq!(response.headers().get(header::ACCESS_CONTROL_ALLOW_METHODS).unwrap(), "GET, POST, OPTIONS");
        assert_eq!(response.headers().get(header::ACCESS_CONTROL_ALLOW_HEADERS).unwrap(), "authorization, content-type, x-kybern-filename");
    }
}

#[derive(Deserialize)]
struct ImageQuery {
    path: String,
}

async fn get_thread_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<ImageQuery>,
) -> Response {
    let origin = allowed_asset_origin(&headers);
    let response = async {
        let Some(raw) = bearer(&headers) else { return (StatusCode::UNAUTHORIZED, "missing token").into_response() };
        if !matches!(authenticate(&state.store, &raw), Ok(Some(p)) if p.has(kybern_protocol::Scope::OrchestrationRead)) {
            return (StatusCode::FORBIDDEN, "token cannot read images").into_response();
        }
        let Ok(Some(thread)) = state.store.thread_get(id) else { return (StatusCode::NOT_FOUND, "thread not found").into_response() };
        let Ok(root) = tokio::fs::canonicalize(&thread.cwd).await else {
            return (StatusCode::NOT_FOUND, "thread folder is unavailable").into_response();
        };
        let Ok(path) = tokio::fs::canonicalize(root.join(&query.path)).await else {
            return (StatusCode::NOT_FOUND, "image file is unavailable").into_response();
        };
        if !path.starts_with(&root) {
            return (StatusCode::FORBIDDEN, "image must be inside the thread folder").into_response();
        }
        if !tokio::fs::metadata(&path).await.is_ok_and(|meta| meta.is_file()) {
            return (StatusCode::NOT_FOUND, "image file is unavailable").into_response();
        }
        let Ok(file) = tokio::fs::File::open(&path).await else {
            return (StatusCode::NOT_FOUND, "image file is unavailable").into_response();
        };
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        if file.take((MAX_ASSET_BYTES + 1) as u64).read_to_end(&mut bytes).await.is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "unable to read image").into_response();
        }
        if bytes.len() > MAX_ASSET_BYTES {
            return (StatusCode::PAYLOAD_TOO_LARGE, "images are limited to 50 MB").into_response();
        }
        let Some(mime) = image_mime(&bytes) else {
            return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "use a PNG, JPEG, GIF, WebP, or AVIF image").into_response();
        };
        ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "private, no-store"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], bytes)
            .into_response()
    }
    .await;
    with_asset_cors(response, origin)
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.get(4..8) == Some(b"ftyp") && matches!(bytes.get(8..12), Some(b"avif" | b"avis")) {
        Some("image/avif")
    } else {
        None
    }
}
