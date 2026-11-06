//! Plain HTTP routes beside the WebSocket: health, pairing, and assets.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{
    Json, Router,
    routing::{any, get, post},
};
use chrono::Utc;
use kybern_protocol::methods::{AssetInfo, PairRequest, PairResponse};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::authenticate;
use crate::state::AppState;
use crate::thread_image::ImageError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/links/icon", get(get_link_icon).options(asset_preflight))
        .route("/health", get(|| async { "ok" }))
        .route("/artifact-preview/{ticket}", get(crate::artifacts::serve))
        .route("/visual-frame/{ticket}", get(crate::visuals::serve))
        .route("/preview-files/{ticket}", get(crate::previews::files::serve_index))
        .route("/preview-files/{ticket}/", get(crate::previews::files::serve_index))
        .route("/preview-files/{ticket}/{*path}", get(crate::previews::files::serve))
        .route("/preview-proxy/{ticket}", any(crate::previews::proxy::serve))
        .route("/preview-proxy/{ticket}/", any(crate::previews::proxy::serve))
        .route("/preview-proxy/{ticket}/{*path}", any(crate::previews::proxy::serve))
        .route("/pair", post(pair).options(asset_preflight))
        .route("/session", post(session).options(asset_preflight))
        .route("/assets", post(upload_asset).options(asset_preflight))
        .route("/assets/{id}", get(get_asset).options(asset_preflight))
        .route("/threads/{id}/file", get(get_thread_file).options(asset_preflight))
        .route("/threads/{id}/image", get(get_thread_image).options(asset_preflight))
        .route("/github/image", get(get_github_image).options(asset_preflight))
        .route("/threads/{id}/snapshot", post(post_thread_snapshot).options(asset_preflight))
        .route("/threads/{id}/visuals/{visual}/snapshot/{file}", get(get_visual_snapshot).options(asset_preflight))
}

async fn pair(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<PairRequest>) -> Response {
    let origin = allowed_asset_origin(&headers);
    if headers.contains_key(header::ORIGIN) && origin.is_none() {
        return (StatusCode::FORBIDDEN, "origin cannot pair").into_response();
    }
    let response = match state.pairing.redeem(&state.store, &req.code, req.device_name) {
        Ok((token, scopes)) => Json(PairResponse { token, scopes, environment_id: state.environment_id.clone() }).into_response(),
        Err(e) if e.is::<crate::access::PairingRateLimited>() => (StatusCode::TOO_MANY_REQUESTS, e.to_string()).into_response(),
        Err(e) if e.is::<crate::access::ReservedDeviceName>() => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
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

/// Snapshots smaller than this are sent uncompressed: gzip would save little and cost a round of CPU.
const SNAPSHOT_GZIP_MIN_BYTES: usize = 16 * 1024;

/// `POST /threads/{id}/snapshot`: the `threads.get` result for the JSON body (`ThreadsGetParams` without
/// `thread_id`), gzip-compressed when the request accepts it. The daemon's WebSocket stack (axum 0.8 over
/// tungstenite 0.29) has no permessage-deflate, so a client on a slow link fetches a large first page here
/// instead: transcripts are JSON and shrink about 5-10x. Same token and scope as the `threads.get` RPC.
async fn post_thread_snapshot(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>, body: Bytes) -> Response {
    let origin = allowed_asset_origin(&headers);
    if headers.contains_key(header::ORIGIN) && origin.is_none() {
        return (StatusCode::FORBIDDEN, "origin cannot read threads").into_response();
    }
    let response = thread_snapshot_inner(&state, &headers, id, body).await;
    let mut response = with_asset_cors(response, origin);
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn thread_snapshot_inner(state: &AppState, headers: &HeaderMap, id: Uuid, body: Bytes) -> Response {
    let Some(raw) = bearer(headers) else { return (StatusCode::UNAUTHORIZED, "missing token").into_response() };
    let scope = kybern_protocol::Scope::OrchestrationRead;
    match authenticate(&state.store, &raw) {
        Ok(Some(p)) if p.has(scope) && crate::auth::effective_scopes(state, &p).contains(&scope) => {}
        Ok(Some(_)) => return (StatusCode::FORBIDDEN, "token cannot read threads").into_response(),
        _ => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
    }
    let mut params: serde_json::Value =
        if body.is_empty() { serde_json::json!({}) } else { serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null) };
    let Some(object) = params.as_object_mut() else {
        return (StatusCode::BAD_REQUEST, "send threads.get params as a JSON object").into_response();
    };
    object.insert("thread_id".into(), serde_json::Value::String(id.to_string()));
    let params: kybern_protocol::methods::ThreadsGetParams = match serde_json::from_value(params) {
        Ok(params) => params,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    let snapshot = match crate::rpc::thread_snapshot(state, params).await {
        Ok(snapshot) => snapshot,
        Err(error) if error.code == kybern_protocol::codes::NOT_FOUND => return (StatusCode::NOT_FOUND, error.message).into_response(),
        Err(error) if error.code == kybern_protocol::codes::INVALID_PARAMS => {
            return (StatusCode::BAD_REQUEST, error.message).into_response();
        }
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error.message).into_response(),
    };
    let gzip = accepts_gzip(headers);
    let encoded = tokio::task::spawn_blocking(move || -> std::io::Result<(Vec<u8>, bool)> {
        let json = serde_json::to_vec(&snapshot)?;
        if !gzip || json.len() < SNAPSHOT_GZIP_MIN_BYTES {
            return Ok((json, false));
        }
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::with_capacity(json.len() / 4), flate2::Compression::fast());
        encoder.write_all(&json)?;
        Ok((encoder.finish()?, true))
    })
    .await;
    let Ok(Ok((bytes, compressed))) = encoded else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not encode the thread").into_response();
    };
    let mut response = ([(header::CONTENT_TYPE, "application/json")], bytes).into_response();
    if compressed {
        response.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    response.headers_mut().append(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    response
}

/// Whether `Accept-Encoding` lists gzip (or `*`) without `q=0`.
fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers.get_all(header::ACCEPT_ENCODING).iter().filter_map(|value| value.to_str().ok()).flat_map(|value| value.split(',')).any(|item| {
        let mut parts = item.split(';').map(str::trim);
        let coding = parts.next().unwrap_or_default();
        let refused = parts.any(|param| param.strip_prefix("q=").and_then(|q| q.trim().parse::<f32>().ok()).is_some_and(|q| q <= 0.0));
        (coding.eq_ignore_ascii_case("gzip") || coding == "*") && !refused
    })
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
    let mut name = headers.get("x-kybern-filename").and_then(|v| v.to_str().ok()).unwrap_or("attachment").to_string();
    let mut media_type = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
    // TIFF (what macOS puts on the clipboard for an image copied from most apps)
    // and BMP are stored as PNG: transcripts and providers take PNG, not these.
    let mut body = body;
    if matches!(body.get(..4), Some(b"II*\0" | b"MM\0*")) || body.starts_with(b"BM") {
        let bytes = body.clone();
        if let Ok(Some(png)) = tokio::task::spawn_blocking(move || crate::thumbnail::portable_png(&bytes)).await {
            body = Bytes::from(png);
            media_type = "image/png".into();
            name = png_name(&name);
        }
    }
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

/// `name.tiff` → `name.png`; a name without an extension gains one.
fn png_name(name: &str) -> String {
    let stem = std::path::Path::new(name).file_stem().and_then(|stem| stem.to_str()).filter(|stem| !stem.is_empty()).unwrap_or("image");
    format!("{stem}.png")
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
    use super::{allowed_asset_origin, asset_preflight, png_name};
    use axum::http::{HeaderMap, HeaderValue, StatusCode, header};

    #[test]
    fn converted_uploads_are_named_png() {
        assert_eq!(png_name("Screenshot 2026-11-04.tiff"), "Screenshot 2026-11-04.png");
        assert_eq!(png_name("scan.bmp"), "scan.png");
        assert_eq!(png_name("attachment"), "attachment.png");
        assert_eq!(png_name(""), "image.png");
    }

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

/// A visual's transcript picture (`threads.visuals.snapshot` draws it first).
async fn get_visual_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, visual, file)): Path<(Uuid, Uuid, String)>,
) -> Response {
    let Some(raw) = bearer(&headers) else { return (StatusCode::UNAUTHORIZED, "missing token").into_response() };
    if !matches!(authenticate(&state.store, &raw), Ok(Some(p)) if p.has(kybern_protocol::Scope::OrchestrationRead)) {
        return (StatusCode::FORBIDDEN, "token cannot read visuals").into_response();
    }
    match crate::visuals::snapshot_file(&state.paths.root, id, visual, &file).await {
        Some(bytes) => {
            ([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "private, max-age=31536000, immutable")], bytes).into_response()
        }
        None => (StatusCode::NOT_FOUND, "Draw this picture with threads.visuals.snapshot first.").into_response(),
    }
}

#[derive(Deserialize)]
struct ImageQuery {
    path: String,
    #[serde(default)]
    preview: bool,
}

/// A binary-preserving download, under the same workspace and outside-folder policy as file reads.
async fn get_thread_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<ImageQuery>,
) -> Response {
    let Some(raw) = bearer(&headers) else { return StatusCode::UNAUTHORIZED.into_response() };
    if !matches!(authenticate(&state.store, &raw), Ok(Some(p)) if p.has(kybern_protocol::Scope::OrchestrationRead)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(Some(thread)) = state.store.thread_get(id) else { return StatusCode::NOT_FOUND.into_response() };
    let root = match tokio::fs::canonicalize(&thread.cwd).await {
        Ok(root) => root,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let reference = crate::files::resolve_reference(&state.file_indexes, &root, &root, &mut None, &query.path).await;
    let file = match reference {
        Ok(crate::files::Reference::Found(relative)) => crate::files::resolve(&root, &relative).ok(),
        Ok(crate::files::Reference::Outside(file)) if crate::files_outside::access(&state, id, false).allows(&file) => Some(file),
        _ => None,
    };
    let Some(file) = file else { return StatusCode::FORBIDDEN.into_response() };
    let Ok(file) = tokio::fs::File::open(file).await else { return StatusCode::NOT_FOUND.into_response() };
    let Ok(meta) = file.metadata().await else { return StatusCode::NOT_FOUND.into_response() };
    if !meta.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let modified =
        meta.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_nanos()).unwrap_or(0);
    let etag = format!("\"{}-{modified}\"", meta.len());
    if headers.get(header::IF_NONE_MATCH).is_some_and(|value| value == etag.as_str()) {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let mut response = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file)).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    response.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(meta.len()));
    response.headers_mut().insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    response
}

async fn get_thread_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<ImageQuery>,
) -> Response {
    let origin = allowed_asset_origin(&headers);
    let started = std::time::Instant::now();
    let response = async {
        let Some(raw) = bearer(&headers) else { return (StatusCode::UNAUTHORIZED, "missing token").into_response() };
        if !matches!(authenticate(&state.store, &raw), Ok(Some(p)) if p.has(kybern_protocol::Scope::OrchestrationRead)) {
            return (StatusCode::FORBIDDEN, "token cannot read images").into_response();
        }
        let Ok(Some(thread)) = state.store.thread_get(id) else { return (StatusCode::NOT_FOUND, "thread not found").into_response() };
        let home = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
        let reference = query.path.clone();
        // Finding and reading the file blocks, and a hung network mount can block it for good: it runs on the blocking
        // pool, and the request gets an answer after IMAGE_READ_TIMEOUT whatever the thread is stuck on.
        let read = tokio::task::spawn_blocking(move || {
            // Relative references resolve against the thread's folder; one that is gone (a removed worktree) still
            // serves absolute and `~/` references.
            let cwd = std::path::PathBuf::from(&thread.cwd);
            let root = std::fs::canonicalize(&cwd).unwrap_or(cwd);
            crate::thread_image::load(&root, home.as_deref(), &reference, MAX_ASSET_BYTES)
        });
        let image = match tokio::time::timeout(IMAGE_READ_TIMEOUT, read).await {
            Ok(Ok(Ok(image))) => image,
            Ok(Ok(Err(ImageError::NotFound))) => return IMAGE_NOT_FOUND.into_response(),
            Ok(Ok(Err(ImageError::TooLarge))) => return (StatusCode::PAYLOAD_TOO_LARGE, "images are limited to 50 MB").into_response(),
            Ok(Ok(Err(ImageError::NotImage))) => {
                return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "use a PNG, JPEG, GIF, WebP, or AVIF image").into_response();
            }
            Ok(Ok(Err(ImageError::Unreadable)) | Err(_)) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, "unable to read image").into_response();
            }
            Err(_) => {
                return (StatusCode::GATEWAY_TIMEOUT, "Reading the image took too long. Check that its disk is connected, then retry.")
                    .into_response();
            }
        };
        let (mime, bytes) = (image.mime, image.bytes);
        // Decodes run two at a time. The permit is taken once the bytes are in hand (a slow read holds none), and
        // owned inside spawn_blocking so a cancelled HTTP request cannot oversubscribe decodes.
        static DECODES: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
            std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)));
        let permit = if query.preview { Some(DECODES.clone().acquire_owned().await.unwrap()) } else { None };
        let (mime, bytes) = if let Some(permit) = permit {
            match tokio::task::spawn_blocking(move || {
                let _permit = permit;
                crate::thumbnail::make(&bytes)
            })
            .await
            {
                Ok(Ok(preview)) => ("image/png", preview),
                _ => {
                    return (StatusCode::UNPROCESSABLE_ENTITY, "Preview unavailable for this image. Open the original image.")
                        .into_response();
                }
            }
        } else {
            (mime, bytes)
        };
        ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "private, no-store"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], bytes)
            .into_response()
    }
    .await;
    // Clients only see "Image unavailable"; this says which answer they got and how long it took to make.
    tracing::debug!(
        target: "kybern::images",
        thread = %id,
        status = response.status().as_u16(),
        preview = query.preview,
        ms = started.elapsed().as_millis() as u64,
        "thread image"
    );
    with_asset_cors(response, origin)
}

#[derive(Deserialize)]
struct GithubImageQuery {
    project_id: Uuid,
    url: String,
    /// The issue or pull request the image is in: a private repository's upload is found in its HTML.
    #[serde(default)]
    number: Option<u64>,
    /// Group projects: the member repository.
    #[serde(default)]
    repo: Option<String>,
}

/// An image in an issue's or a pull request's Markdown on one of GitHub's hosts, fetched by the machine that owns the
/// project, with that machine's `gh` sign-in for a private repository's uploads (`github_images.rs`). The answer is the
/// image, or a status and one sentence the client shows under the image's caption.
async fn get_github_image(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<GithubImageQuery>) -> Response {
    use crate::github_images::ImageFailure;
    let origin = allowed_asset_origin(&headers);
    let started = std::time::Instant::now();
    let response = async {
        let Some(raw) = bearer(&headers) else { return (StatusCode::UNAUTHORIZED, "missing token").into_response() };
        if !matches!(authenticate(&state.store, &raw), Ok(Some(p)) if p.has(kybern_protocol::Scope::OrchestrationRead)) {
            return (StatusCode::FORBIDDEN, "token cannot read images").into_response();
        }
        let Ok(Some(project)) = state.store.project_get(query.project_id) else {
            return (StatusCode::NOT_FOUND, "Project not found. Refresh and try again.").into_response();
        };
        let Ok(dir) = crate::rpc::pr_dir(&project, query.repo.as_deref()) else {
            return (StatusCode::BAD_REQUEST, "That repository isn't part of this project.").into_response();
        };
        // Each image is up to 50 MB in memory: four at a time.
        static FETCHES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
        let Ok(_permit) = FETCHES.acquire().await else { return (StatusCode::SERVICE_UNAVAILABLE, "Try again.").into_response() };
        match crate::github_images::fetch("gh", &dir, query.number, &query.url).await {
            Ok((mime, bytes)) => (
                [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "private, no-store"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
                bytes,
            )
                .into_response(),
            Err(ImageFailure::NotGithub) => (StatusCode::BAD_REQUEST, "Not an image on GitHub.").into_response(),
            Err(ImageFailure::NotFound) => {
                (StatusCode::NOT_FOUND, "GitHub didn't share this image. Open it on GitHub, or check that gh can see the repository.")
                    .into_response()
            }
            Err(ImageFailure::TooLarge) => (StatusCode::PAYLOAD_TOO_LARGE, "images are limited to 50 MB").into_response(),
            Err(ImageFailure::NotImage) => {
                (StatusCode::UNSUPPORTED_MEDIA_TYPE, "use a PNG, JPEG, GIF, WebP, or AVIF image").into_response()
            }
            Err(ImageFailure::Unreachable) => {
                (StatusCode::BAD_GATEWAY, "GitHub didn't answer. Check the connection, then retry.").into_response()
            }
        }
    }
    .await;
    tracing::debug!(target: "kybern::images", status = response.status().as_u16(), ms = started.elapsed().as_millis() as u64, "github image");
    with_asset_cors(response, origin)
}

/// How long finding and reading a thread's image may take: a hung network mount can hold any step.
const IMAGE_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// A reference that names no regular file.
const IMAGE_NOT_FOUND: (StatusCode, &str) =
    (StatusCode::NOT_FOUND, "Image not found. Check the path, or retry once the agent has saved it.");

#[derive(Deserialize)]
struct LinkIconQuery {
    url: String,
}
async fn get_link_icon(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<LinkIconQuery>) -> Response {
    let Some(raw) = bearer(&headers) else { return StatusCode::UNAUTHORIZED.into_response() };
    if !matches!(authenticate(&state.store, &raw), Ok(Some(p)) if p.has(kybern_protocol::Scope::OrchestrationRead)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(crate::link_metadata::load(&state.paths.root.join("cache"), &query.url).await).into_response()
}
