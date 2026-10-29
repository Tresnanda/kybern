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
    fn protected_folders_stay_closed_for_outside_images() {
        let home = std::path::Path::new("/Users/someone");
        let data = std::path::Path::new("/Users/someone/.kybern");
        for path in [
            "/Users/someone/.ssh/id.png",
            "/Users/someone/.kybern/assets/x.png",
            "/private/etc/x.png",
            "/Users/someone/Library/Keychains/x.png",
        ] {
            assert!(super::protected_location(std::path::Path::new(path), Some(home), data, None), "{path}");
        }
        assert!(!super::protected_location(std::path::Path::new("/Users/someone/Desktop/shot.png"), Some(home), data, None));
        assert_eq!(super::percent_decode("a%20b%C3%A4.png").as_deref(), Some("a bä.png"));
        assert_eq!(super::percent_decode("plain.png"), None);
    }

    #[test]
    fn protected_folders_below_the_thread_folder_stay_closed_inside_it_too() {
        let home = std::path::Path::new("/Users/someone");
        let data = std::path::Path::new("/Users/someone/.kybern");
        let inside = |path: &str, root: &str| {
            super::protected_location(std::path::Path::new(path), Some(home), data, Some(std::path::Path::new(root)))
        };
        // A thread whose folder is the home folder.
        for path in ["/Users/someone/.ssh/id.png", "/Users/someone/.kybern/assets/x.png", "/Users/someone/Library/Messages/a.png"] {
            assert!(inside(path, "/Users/someone"), "{path}");
        }
        assert!(
            super::protected_location(std::path::Path::new("/Users/someone/library/mail/a.png"), Some(home), data, None)
                == cfg!(target_os = "macos")
        );
        assert!(super::protected_location(std::path::Path::new("/Volumes/x/Old.photoslibrary/a.png"), Some(home), data, None));
        // A worktree under the data folder serves its own files.
        assert!(!inside("/Users/someone/.kybern/worktrees/x/shots/a.png", "/Users/someone/.kybern/worktrees/x"));
        assert!(!inside("/Users/someone/Desktop/project/a.png", "/Users/someone/Desktop/project"));
        // Any folder holding a daemon token is a Kybern data folder.
        let scratch = std::env::temp_dir().join(format!("kybern-protected-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(scratch.join("assets")).unwrap();
        std::fs::write(scratch.join("daemon.token"), "t").unwrap();
        assert!(super::protected_location(&scratch.join("assets/a.png"), Some(home), data, None));
        assert!(!super::protected_location(&scratch.join("assets/a.png"), Some(home), data, Some(&scratch)));
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn opened_path_names_the_file_that_was_opened() {
        let folder = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("kybern-opened-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("real.png"), "x").unwrap();
        std::os::unix::fs::symlink(folder.join("real.png"), folder.join("link.png")).unwrap();
        let file = tokio::fs::File::open(folder.join("link.png")).await.unwrap();
        assert_eq!(super::opened_path(&file).unwrap(), folder.join("real.png"));
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_session_owns_the_images_its_harness_stored() {
        let roots = |session: Option<&str>| super::ImageRoots {
            root: "/work/ade".into(),
            cwd: "/work/ade".into(),
            home: None,
            data_dir: "/data".into(),
            session: session.map(String::from),
        };
        let session = "9aba3aec-2abd-453c-9753-0dcadbb13d74";
        let path = std::path::Path::new("/private/tmp/claude-501/-Users-me-ade/9aba3aec-2abd-453c-9753-0dcadbb13d74/images/1.png");
        assert!(roots(Some(session)).is_session_attachment(path));
        assert!(!roots(Some("another-session-id")).is_session_attachment(path), "another conversation's image");
        assert!(!roots(None).is_session_attachment(path));
        for other in [
            "/private/tmp/claude-501/p/9aba3aec-2abd-453c-9753-0dcadbb13d74/scratchpad/1.png",
            "/private/tmp/claude-501/p/9aba3aec-2abd-453c-9753-0dcadbb13d74/images/deeper/1.png",
            "/Users/me/Pictures/9aba3aec-2abd-453c-9753-0dcadbb13d74/images/1.png",
        ] {
            assert!(!roots(Some(session)).is_session_attachment(std::path::Path::new(other)), "{other}");
        }
    }

    #[test]
    fn message_references_are_targets_code_spans_and_words() {
        let text =
            "Saved ![shot](</a b/c.png> \"t\") and [x](/d/e(1).png), ![y](/j k.png \"title\") see `/f g.png` or /h.png. Also /i.png.bak";
        let found = super::message_references(text);
        for want in ["/a b/c.png", "/d/e(1).png", "/j k.png", "/f g.png", "/h.png", "/i.png.bak"] {
            assert!(found.contains(&want), "{want} in {found:?}");
        }
        assert!(!found.contains(&"/i.png"));
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
        let Ok(root) = tokio::fs::canonicalize(&thread.cwd).await else {
            return (StatusCode::NOT_FOUND, "thread folder is unavailable").into_response();
        };
        let roots = ImageRoots {
            root,
            cwd: thread.cwd.clone().into(),
            home: directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()),
            data_dir: state.paths.root.clone(),
            session: thread.provider_session_id.clone(),
        };
        let (path, outside) = match thread_image_path(&state, id, &roots, &query.path).await {
            Ok(found) => found,
            Err(refusal) => return refusal.into_response(),
        };
        // Acquire before reading compressed data, and keep ownership inside
        // spawn_blocking so a cancelled HTTP request cannot oversubscribe decodes.
        static DECODES: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
            std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)));
        let permit = if query.preview { Some(DECODES.clone().acquire_owned().await.unwrap()) } else { None };
        let Ok(file) = tokio::fs::File::open(&path).await else { return IMAGE_UNAVAILABLE.into_response() };
        // Judge the file that was opened, not the path checked before: an outside image must still be the named one.
        if let Some(opened) = opened_path(&file)
            && opened != path
            && match roots.place(&opened) {
                Ok(false) => false,
                Ok(true) => !outside || !path_under(&opened, &path),
                Err(_) => true,
            }
        {
            return IMAGE_UNAVAILABLE.into_response();
        }
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

/// What every refusal of a reference that leaves the thread's folder answers, whether the file exists or not, so the
/// route cannot be used to probe for files.
const IMAGE_UNAVAILABLE: (StatusCode, &str) =
    (StatusCode::NOT_FOUND, "Image not found. It must be in the thread's folder, or named exactly in this conversation.");

/// The file a thread's image reference names, or why it is refused. `reference` is the path as the message wrote it:
/// relative to the thread's folder, absolute, `~/…` or `file://…` (percent-encoding is tried when the literal path is
/// missing). Inside the thread's folder any folder works, hidden ones such as `.screenshots` included, except Git
/// internals and protected folders. A reference that leaves the folder (absolute, `~/`, `file://` or `..`) is looked up
/// in this thread's messages before the file system is consulted (see `thread_names`) and served only when named, unless
/// it lands inside the folder through an alias, so the route cannot read or probe arbitrary files; protected folders
/// stay closed regardless, and every refusal is the same 404. The path
/// is canonicalized, so `..` and symlinks are judged by where they land; only image files are served (by extension
/// here, by content when read). Returns the path and whether it lies outside the thread's folder.
async fn thread_image_path(
    state: &AppState,
    thread_id: Uuid,
    roots: &ImageRoots,
    reference: &str,
) -> Result<(std::path::PathBuf, bool), (StatusCode, &'static str)> {
    let reference = reference.trim();
    let targets = image_targets(reference, roots);
    let leaves = !targets.iter().any(|target| roots.lexically_inside(target));
    // Asked before the file system, so an unnamed outside path answers the same whether it exists or not.
    let named = if leaves { Some(thread_names(state, thread_id, reference, &targets, roots).await) } else { None };
    let refuse = |refusal: (StatusCode, &'static str)| if leaves { IMAGE_UNAVAILABLE } else { refusal };
    let mut found = None;
    for target in &targets {
        if let Ok(path) = tokio::fs::canonicalize(target).await {
            found = Some(path);
            break;
        }
    }
    let path = found.ok_or(IMAGE_UNAVAILABLE)?;
    if !tokio::fs::metadata(&path).await.is_ok_and(|meta| meta.is_file()) {
        return Err(IMAGE_UNAVAILABLE);
    }
    let image_extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ["png", "jpg", "jpeg", "gif", "webp", "avif"].contains(&ext.to_ascii_lowercase().as_str()));
    if !image_extension {
        return Err(refuse((StatusCode::UNSUPPORTED_MEDIA_TYPE, "use a PNG, JPEG, GIF, WebP, or AVIF image")));
    }
    let outside = roots.place(&path).map_err(refuse)?;
    // An absolute reference may still land inside through an alias of the folder (`/var` for `/private/var`). One that
    // lands outside, through a symlink too, needs a naming message.
    if outside && !roots.is_session_attachment(&path) {
        let named = match named {
            Some(named) => named,
            None => thread_names(state, thread_id, reference, &targets, roots).await,
        };
        if !named {
            return Err(IMAGE_UNAVAILABLE);
        }
    }
    Ok((path, outside))
}

/// The thread's folder and the locations that decide where an image may be read from.
struct ImageRoots {
    /// The thread's folder, canonical.
    root: std::path::PathBuf,
    /// The thread's folder as stored, which absolute references may use when it differs from `root`.
    cwd: std::path::PathBuf,
    home: Option<std::path::PathBuf>,
    data_dir: std::path::PathBuf,
    /// The thread's provider session id, which names the folder a harness keeps the session's pasted images in.
    session: Option<String>,
}

impl ImageRoots {
    /// Whether a canonical path is an image the harness stored for this very thread: `<temp dir>/…/<session id>/images/<file>`
    /// (Claude Code keeps a pasted image at `/private/tmp/claude-501/<project>/<session>/images/1.png`). The user attached
    /// it, so it opens whether or not a message spells its path out. The session id is a UUID the conversation owns, the
    /// folder must be under a temp dir, and protected locations are refused before this is asked.
    fn is_session_attachment(&self, path: &std::path::Path) -> bool {
        let Some(session) = self.session.as_deref().filter(|id| id.len() >= 8 && !id.contains(['/', '\\'])) else { return false };
        let in_temp = ["/tmp", "/private/tmp"]
            .into_iter()
            .map(std::path::PathBuf::from)
            .chain(std::fs::canonicalize(std::env::temp_dir()))
            .any(|temp| path.starts_with(temp));
        let parts: Vec<&str> = path.components().filter_map(|part| part.as_os_str().to_str()).collect();
        in_temp && parts.len() >= 3 && parts[parts.len() - 3] == session && parts[parts.len() - 2] == "images"
    }

    fn lexically_inside(&self, target: &std::path::Path) -> bool {
        target.starts_with(&self.root) || target.starts_with(&self.cwd)
    }

    /// Whether a canonical path may be served, and if so whether it lies outside the thread's folder.
    fn place(&self, path: &std::path::Path) -> Result<bool, (StatusCode, &'static str)> {
        match path.strip_prefix(&self.root) {
            Ok(inside) => {
                if inside.components().any(|part| part.as_os_str().to_str().is_some_and(|part| part.eq_ignore_ascii_case(".git"))) {
                    return Err((StatusCode::FORBIDDEN, "images inside Git internals are not served"));
                }
                if protected_location(path, self.home.as_deref(), &self.data_dir, Some(&self.root)) {
                    return Err((StatusCode::FORBIDDEN, "images in protected folders are not served"));
                }
                Ok(false)
            }
            Err(_) if protected_location(path, self.home.as_deref(), &self.data_dir, None) => {
                Err((StatusCode::FORBIDDEN, "images in protected folders are not served"))
            }
            Err(_) => Ok(true),
        }
    }
}

/// Where a reference points, without touching the file system: `file://` stripped, `~/` expanded, relative paths
/// joined to the thread's folder, `.` and `..` resolved lexically. The literal form first, then the percent-decoded one.
fn image_targets(reference: &str, roots: &ImageRoots) -> Vec<std::path::PathBuf> {
    let literal = reference.strip_prefix("file://localhost").or_else(|| reference.strip_prefix("file://")).unwrap_or(reference);
    let mut targets = Vec::new();
    for raw in [Some(literal.to_string()), percent_decode(literal)].into_iter().flatten() {
        if raw.is_empty() {
            continue;
        }
        let joined = match raw.strip_prefix("~/") {
            Some(rest) => match &roots.home {
                Some(home) => home.join(rest),
                None => continue,
            },
            None => roots.root.join(&raw),
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

/// Whether one of the thread's prompts or replies names the image: a Markdown image or link target, a code span or a
/// plain path in its text that points at the same place as `reference` (never a mere substring, reasoning or tool
/// output). Positive answers are cached for good, since history only grows; negative ones until the next message.
async fn thread_names(state: &AppState, thread_id: Uuid, reference: &str, targets: &[std::path::PathBuf], roots: &ImageRoots) -> bool {
    const CACHE_ENTRIES: usize = 512;
    /// (thread, reference) → (named, newest message seq searched, last use).
    type Cache = std::collections::HashMap<(Uuid, String), (bool, i64, u64)>;
    static CACHE: std::sync::LazyLock<std::sync::Mutex<(Cache, u64)>> = std::sync::LazyLock::new(Default::default);
    if targets.is_empty() {
        return false;
    }
    let key = (thread_id, reference.to_string());
    let store = state.store.clone();
    let Ok(Ok(newest)) = tokio::task::spawn_blocking(move || store.thread_last_message_seq(thread_id)).await else { return false };
    let searched = {
        let mut guard = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (cache, clock) = &mut *guard;
        *clock += 1;
        let now = *clock;
        match cache.get_mut(&key) {
            Some(entry) if entry.0 || entry.1 == newest => {
                entry.2 = now;
                return entry.0;
            }
            Some(entry) => entry.1,
            None => 0,
        }
    };
    let mut before = newest + 1;
    let mut named = false;
    loop {
        let store = state.store.clone();
        let needle = reference.to_string();
        let Ok(Ok((texts, next))) =
            tokio::task::spawn_blocking(move || store.thread_message_texts_containing(thread_id, &needle, searched, before)).await
        else {
            return false;
        };
        if texts.iter().any(|text| {
            message_references(text)
                .into_iter()
                .any(|candidate| candidate == reference || image_targets(candidate, roots).iter().any(|target| targets.contains(target)))
        }) {
            named = true;
            break;
        }
        match next {
            Some(seq) => before = seq,
            None => break,
        }
    }
    let mut guard = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (cache, clock) = &mut *guard;
    if cache.len() >= CACHE_ENTRIES
        && !cache.contains_key(&key)
        && let Some(oldest) = cache.iter().min_by_key(|(_, entry)| entry.2).map(|(key, _)| key.clone())
    {
        cache.remove(&oldest);
    }
    cache.insert(key, (named, newest, *clock));
    named
}

/// The path-like references in a message: Markdown link and image targets, code spans, and whitespace-separated words
/// with surrounding quotes, brackets and trailing punctuation removed.
fn message_references(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("](") {
        let target = &rest[start + 2..];
        let (destination, after) = if let Some(inner) = target.strip_prefix('<') {
            match inner.find('>') {
                Some(end) => (&inner[..end], &inner[end + 1..]),
                None => break,
            }
        } else {
            let mut depth = 0usize;
            let end = target
                .char_indices()
                .find(|&(_, c)| match c {
                    '(' => {
                        depth += 1;
                        false
                    }
                    ')' if depth == 0 => true,
                    ')' => {
                        depth -= 1;
                        false
                    }
                    '\n' => true,
                    _ => false,
                })
                .map_or(target.len(), |(end, _)| end);
            // Agents write spaces into destinations without `<…>`; a trailing `"title"` or `'title'` is not part of it.
            let mut destination = target[..end].trim();
            for quote in ['"', '\''] {
                if destination.ends_with(quote)
                    && let Some(start) = destination[..destination.len() - 1].rfind(&format!(" {quote}"))
                {
                    destination = destination[..start].trim_end();
                }
            }
            (destination, &target[end..])
        };
        found.push(destination);
        rest = after;
    }
    let mut spans = text.split('`');
    spans.next();
    found.extend(spans.step_by(2).map(str::trim));
    found.extend(text.split_whitespace().map(|word| {
        word.trim_start_matches(['`', '\'', '"', '(', '[', '<', '{', '*', '_'])
            .trim_end_matches(['`', '\'', '"', ')', ']', '>', '}', ',', ';', ':', '!', '?', '.', '*', '_'])
    }));
    found.retain(|candidate| !candidate.is_empty());
    found
}

/// Folders an image is never read from, even when a message names it: credentials, keychains, mail and messages, app
/// data, the Photos library, system configuration and Kybern's data (this daemon's, `~/.kybern`, and any folder holding
/// a daemon token). With `within` (the thread's folder, for an image inside it) only folders below it count, so a thread
/// whose folder is the home folder still cannot serve `~/.ssh`, while a worktree under `~/.kybern` serves its own files.
fn protected_location(
    path: &std::path::Path,
    home: Option<&std::path::Path>,
    data_dir: &std::path::Path,
    within: Option<&std::path::Path>,
) -> bool {
    let below = |folder: &std::path::Path| within.is_none_or(|root| path_under(folder, root) && !path_under(root, folder));
    let counts = |folder: &std::path::Path| path_under(path, folder) && below(folder);
    let canonical_data = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    if counts(&canonical_data) || counts(data_dir) {
        return true;
    }
    if ["/etc", "/private/etc", "/private/var/db", "/System", "/dev", "/proc", "/var/db"]
        .iter()
        .any(|prefix| counts(std::path::Path::new(prefix)))
    {
        return true;
    }
    const HOME_FOLDERS: [&str; 16] = [
        ".ssh",
        ".gnupg",
        ".aws",
        ".kube",
        ".docker",
        ".config/gcloud",
        ".netrc",
        ".kybern",
        "Library/Keychains",
        "Library/Cookies",
        "Library/Messages",
        "Library/Mail",
        "Library/Safari",
        "Library/Containers",
        "Library/Group Containers",
        "Library/Application Support",
    ];
    if home.is_some_and(|home| HOME_FOLDERS.iter().any(|folder| counts(&home.join(folder)))) {
        return true;
    }
    // Photos libraries wherever they live, and any other Kybern data folder (it holds a daemon token).
    path.ancestors().skip(1).filter(|folder| below(folder)).any(|folder| {
        folder.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("photoslibrary")) || folder.join("daemon.token").exists()
    })
}

/// `path` is `folder` or inside it, ignoring ASCII case on macOS, whose file systems usually do.
fn path_under(path: &std::path::Path, folder: &std::path::Path) -> bool {
    if !cfg!(target_os = "macos") {
        return path.starts_with(folder);
    }
    let mut parts = path.components();
    folder.components().all(|want| {
        parts.next().is_some_and(|part| match (part.as_os_str().to_str(), want.as_os_str().to_str()) {
            (Some(part), Some(want)) => part.eq_ignore_ascii_case(want),
            _ => part == want,
        })
    })
}

/// The path an open file actually is, to judge it again after opening: a folder on the way may have been swapped for a
/// symlink between the checks and the open.
#[cfg(target_os = "macos")]
fn opened_path(file: &tokio::fs::File) -> Option<std::path::PathBuf> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStringExt;
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes a NUL-terminated path of at most PATH_MAX bytes into the buffer.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return None;
    }
    buffer.truncate(buffer.iter().position(|&byte| byte == 0)?);
    Some(std::ffi::OsString::from_vec(buffer).into())
}

#[cfg(target_os = "linux")]
fn opened_path(file: &tokio::fs::File) -> Option<std::path::PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn opened_path(_file: &tokio::fs::File) -> Option<std::path::PathBuf> {
    None
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
