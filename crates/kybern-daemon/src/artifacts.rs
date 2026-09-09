use crate::state::AppState;
use anyhow::{Result, bail};
use axum::{
    body::Body,
    extract::Path,
    http::{Response, StatusCode, header},
};
use kybern_protocol::methods::{ArtifactReadParams, FilesReadResult};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const POLICY: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
type Previews = HashMap<String, (Instant, String)>;
fn previews() -> &'static Mutex<Previews> {
    static PREVIEWS: OnceLock<Mutex<Previews>> = OnceLock::new();
    PREVIEWS.get_or_init(Default::default)
}

pub async fn read(state: &AppState, params: ArtifactReadParams) -> Result<FilesReadResult> {
    let thread = state.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow::anyhow!("Thread not found."))?;
    let root = tokio::fs::canonicalize(&thread.cwd).await?;
    let path = std::path::Path::new(&params.path);
    let absolute;
    let relative = if path.is_absolute() {
        absolute = tokio::fs::canonicalize(path).await?;
        absolute
            .strip_prefix(&root)
            .map_err(|_| anyhow::anyhow!("This source is outside the thread workspace. Open the hosted artifact instead."))?
    } else {
        path
    };
    let extension = relative.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "html" | "htm" | "md" | "markdown" | "svg") {
        bail!("Preview an HTML, Markdown, or SVG file.");
    }
    crate::files::read_file(&root, &relative.to_string_lossy(), 1024 * 1024).await
}

pub async fn issue(state: &AppState, params: ArtifactReadParams) -> Result<String> {
    let file = read(state, params).await?;
    if file.binary || file.truncated {
        bail!("This file is binary or larger than 1 MB. Open the hosted artifact instead.");
    }
    let mut entries = previews().lock().map_err(|_| anyhow::anyhow!("Preview is unavailable."))?;
    entries.retain(|_, (created, _)| created.elapsed() < Duration::from_secs(60));
    if entries.len() >= 32 {
        bail!("Too many previews are opening. Wait a moment and retry.");
    }
    let ticket = uuid::Uuid::new_v4().to_string();
    entries.insert(ticket.clone(), (Instant::now(), file.content));
    Ok(ticket)
}

pub async fn serve(Path(ticket): Path<String>) -> Response<Body> {
    let document = previews()
        .lock()
        .ok()
        .and_then(|mut entries| entries.remove(&ticket))
        .filter(|(created, _)| created.elapsed() < Duration::from_secs(60))
        .map(|(_, source)| source);
    match document {
        Some(source) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, POLICY)
            .header(header::CACHE_CONTROL, "no-store")
            .header("referrer-policy", "no-referrer")
            .header("x-content-type-options", "nosniff")
            .body(Body::from(source))
            .unwrap(),
        None => Response::builder().status(StatusCode::NOT_FOUND).body(Body::from("Preview expired. Reopen it from Kybern.")).unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn expired_preview_tickets_do_not_serve_source() {
        let ticket = uuid::Uuid::new_v4().to_string();
        previews().lock().unwrap().insert(ticket.clone(), (Instant::now() - Duration::from_secs(61), "private source".into()));
        assert_eq!(serve(Path(ticket)).await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn previews_are_single_use_isolated_documents() {
        let ticket = uuid::Uuid::new_v4().to_string();
        previews()
            .lock()
            .unwrap()
            .insert(ticket.clone(), (Instant::now(), "<script>document.body.textContent='interactive'</script>".into()));
        let response = serve(Path(ticket.clone())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let policy = response.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(policy.contains("sandbox allow-scripts"));
        assert!(!policy.contains("allow-same-origin"));
        assert!(policy.contains("connect-src 'none'"));
        assert_eq!(serve(Path(ticket)).await.status(), StatusCode::NOT_FOUND);
    }
}
