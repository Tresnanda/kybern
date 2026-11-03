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

pub fn routes() -> Router<AppState> {
    Router::new()
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
        .route("/threads/{id}/image", get(get_thread_image).options(asset_preflight))
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
    fn image_references_resolve_relative_absolute_home_and_file_urls() {
        let root = std::path::Path::new("/work/ade");
        let home = std::path::Path::new("/home/me");
        let targets = |reference: &str| super::image_targets(reference, root, Some(home));
        assert_eq!(targets(".screenshots/a.png"), [root.join(".screenshots/a.png")]);
        assert_eq!(targets("./shots/../a.png"), [root.join("a.png")]);
        assert_eq!(targets("/elsewhere/b.png"), [std::path::PathBuf::from("/elsewhere/b.png")]);
        assert_eq!(targets("~/Desktop/c.png"), [home.join("Desktop/c.png")]);
        assert_eq!(targets("file:///tmp/d.png"), [std::path::PathBuf::from("/tmp/d.png")]);
        assert_eq!(targets("a%20b.png"), [root.join("a%20b.png"), root.join("a b.png")]);
        assert!(super::image_targets("~/x.png", root, None).is_empty(), "no home folder, no `~/`");
        assert_eq!(super::percent_decode("a%20b%C3%A4.png").as_deref(), Some("a bä.png"));
        assert_eq!(super::percent_decode("plain.png"), None);
    }

    #[test]
    fn only_local_disks_are_looked_at() {
        assert!(super::local_path(std::path::Path::new("/Users/me/a.png")));
        #[cfg(windows)]
        {
            assert!(super::local_path(std::path::Path::new(r"C:\Users\me\a.png")));
            assert!(super::local_path(std::path::Path::new(r"\\?\C:\Users\me\a.png")));
            for share in [r"\\host\share\a.png", r"\\?\UNC\host\share\a.png", r"\\.\pipe\x", "//host/share/a.png"] {
                assert!(!super::local_path(std::path::Path::new(share)), "{share}");
            }
        }
    }

    // ADE-122: an image is served from wherever it is; what it has to be is a regular file.
    #[tokio::test]
    async fn an_image_path_is_any_regular_file_inside_or_outside_the_thread_folder() {
        let base = std::env::temp_dir().join(format!("kybern-image-path-{}", uuid::Uuid::now_v7()));
        let (root, outside, home) = (base.join("thread"), base.join("other-checkout"), base.join("home"));
        for folder in [&root, &outside, &home.join("Pictures")] {
            std::fs::create_dir_all(folder).unwrap();
        }
        std::fs::write(root.join("in.png"), "x").unwrap();
        std::fs::write(outside.join("out.png"), "x").unwrap();
        std::fs::write(home.join("Pictures/shot.png"), "x").unwrap();
        let find = |reference: String| {
            let (root, home) = (root.clone(), home.clone());
            async move { super::thread_image_path(&root, Some(&home), &reference).await }
        };
        let canonical = |path: std::path::PathBuf| std::fs::canonicalize(path).unwrap();
        assert_eq!(find("in.png".into()).await, Some(canonical(root.join("in.png"))));
        assert_eq!(find("../other-checkout/out.png".into()).await, Some(canonical(outside.join("out.png"))));
        assert_eq!(find(outside.join("out.png").to_string_lossy().into()).await, Some(canonical(outside.join("out.png"))));
        assert_eq!(find("~/Pictures/shot.png".into()).await, Some(canonical(home.join("Pictures/shot.png"))));
        assert_eq!(find("missing.png".into()).await, None);
        assert_eq!(find(outside.to_string_lossy().into()).await, None, "a folder is no image");
        std::fs::remove_dir_all(base).unwrap();
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
        // Relative references resolve against the thread's folder; one that is gone (a removed worktree) still serves
        // absolute and `~/` references.
        let root = tokio::fs::canonicalize(&thread.cwd).await.unwrap_or_else(|_| thread.cwd.clone().into());
        let home = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
        let Some(path) = thread_image_path(&root, home.as_deref(), &query.path).await else { return IMAGE_NOT_FOUND.into_response() };
        let Ok(mut file) = tokio::fs::File::open(&path).await else { return IMAGE_NOT_FOUND.into_response() };
        use tokio::io::AsyncReadExt;
        // The header first: a file that is not an image is refused before the rest of it is read.
        let mut bytes = Vec::with_capacity(IMAGE_HEADER_BYTES);
        if (&mut file).take(IMAGE_HEADER_BYTES as u64).read_to_end(&mut bytes).await.is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "unable to read image").into_response();
        }
        let Some(mime) = image_mime(&bytes) else {
            return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "use a PNG, JPEG, GIF, WebP, or AVIF image").into_response();
        };
        // Acquire before reading compressed data, and keep ownership inside
        // spawn_blocking so a cancelled HTTP request cannot oversubscribe decodes.
        static DECODES: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
            std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)));
        let permit = if query.preview { Some(DECODES.clone().acquire_owned().await.unwrap()) } else { None };
        let rest = (MAX_ASSET_BYTES + 1).saturating_sub(bytes.len()) as u64;
        if file.take(rest).read_to_end(&mut bytes).await.is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "unable to read image").into_response();
        }
        if bytes.len() > MAX_ASSET_BYTES {
            return (StatusCode::PAYLOAD_TOO_LARGE, "images are limited to 50 MB").into_response();
        }
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

/// Enough of a file to tell an image by its content (`image_mime`).
const IMAGE_HEADER_BYTES: usize = 16;

/// A reference that names no regular file.
const IMAGE_NOT_FOUND: (StatusCode, &str) =
    (StatusCode::NOT_FOUND, "Image not found. Check the path, or retry once the agent has saved it.");

/// The file a thread's image reference names, or `None` when it names no regular file. `reference` is the path as the
/// message wrote it: relative to the thread's folder (`root`), absolute, `~/…` or `file://…` (percent-encoding is tried
/// when the literal path is missing). Any folder works: an agent in a worktree or another checkout shows its images
/// wherever it saved them (ADE-122). What makes it an image is its content, checked when it is read (`image_mime`),
/// with the size limit; the route stays behind the daemon's token and the thread it is asked for.
async fn thread_image_path(root: &std::path::Path, home: Option<&std::path::Path>, reference: &str) -> Option<std::path::PathBuf> {
    for target in image_targets(reference.trim(), root, home) {
        // Only this computer's disks: a network share (`\\host\share`) would make the daemon connect out, with the
        // user's credentials, just to look.
        if !local_path(&target) {
            continue;
        }
        if let Ok(path) = tokio::fs::canonicalize(&target).await
            && tokio::fs::metadata(&path).await.is_ok_and(|meta| meta.is_file())
        {
            return Some(path);
        }
    }
    None
}

/// A path on this computer's own disks: no UNC share and no device namespace (`\\host\x`, `\\?\UNC\…`, `\\.\…`).
/// Paths have no such prefix off Windows.
fn local_path(path: &std::path::Path) -> bool {
    use std::path::{Component, Prefix};
    match path.components().next() {
        Some(Component::Prefix(prefix)) => matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)),
        _ => true,
    }
}

/// Where a reference points, without touching the file system: `file://` stripped, `~/` expanded, relative paths
/// joined to the thread's folder, `.` and `..` resolved lexically. The literal form first, then the percent-decoded one.
fn image_targets(reference: &str, root: &std::path::Path, home: Option<&std::path::Path>) -> Vec<std::path::PathBuf> {
    let literal = reference.strip_prefix("file://localhost").or_else(|| reference.strip_prefix("file://")).unwrap_or(reference);
    let mut targets = Vec::new();
    for raw in [Some(literal.to_string()), percent_decode(literal)].into_iter().flatten() {
        if raw.is_empty() {
            continue;
        }
        let joined = match raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
            Some(rest) => match home {
                Some(home) => home.join(rest),
                None => continue,
            },
            None => root.join(&raw),
        };
        let mut target = std::path::PathBuf::new();
        for part in joined.components() {
            match part {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    target.pop();
                }
                part => target.push(part),
            }
        }
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    targets
}

fn percent_decode(text: &str) -> Option<String> {
    if !text.contains('%') {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = text.get(i + 1..i + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
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
