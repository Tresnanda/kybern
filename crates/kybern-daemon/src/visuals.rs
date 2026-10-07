//! Inline, durable interactive HTML replies; no daemon credentials enter a page.
mod prepare;
mod preview;
use anyhow::{Result, anyhow, ensure};
use axum::{
    body::Body,
    extract::Path,
    http::{Response, StatusCode, header},
};
use kybern_protocol::{methods::*, *};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

// Remote libraries/styles/images follow T3's document behavior. The opaque
// sandbox cannot access the host; connect-src excludes local daemon origins.
// HTTPS resources get no inherited Authorization header, cookies, or referrer.
pub(super) const POLICY: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https: http:; font-src data: https:; connect-src https:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const TTL: Duration = Duration::from_secs(60);
const MAX_TICKET_BYTES: usize = 64 * 1024 * 1024;
struct Ticket {
    created: Instant,
    thread: ThreadId,
    html: String,
}
fn tickets() -> &'static Mutex<HashMap<String, Ticket>> {
    static TICKETS: OnceLock<Mutex<HashMap<String, Ticket>>> = OnceLock::new();
    TICKETS.get_or_init(Default::default)
}

pub(crate) async fn publish(
    store: &kybern_store::Store,
    thread_id: ThreadId,
    turn_id: TurnId,
    html: &str,
    title: &str,
    height: u32,
) -> Result<ThreadEvent> {
    ensure!(!title.trim().is_empty() && title.chars().count() <= 200, "Give this page a title of 1–200 characters.");
    ensure!((80..=2000).contains(&height), "Use a frame height of 80–2000 CSS pixels.");
    let (source, _) = prepare::prepare(html, false).await?;
    let visual = HtmlVisual { id: uuid::Uuid::now_v7(), title: title.trim().to_owned(), height };
    store.visual_publish(thread_id, turn_id, &visual, &source)
}
pub(crate) fn read(store: &kybern_store::Store, params: HtmlReadParams) -> Result<HtmlReadResult> {
    Ok(HtmlReadResult {
        html: store
            .visual_read(params.thread_id, params.visual_id)?
            .ok_or_else(|| anyhow!("This visual no longer exists in this thread."))?,
    })
}
pub(crate) fn issue(store: &kybern_store::Store, params: HtmlReadParams) -> Result<ArtifactPreviewResult> {
    let html = read(store, params.clone())?.html;
    let mut entries = tickets().lock().map_err(|_| anyhow!("The visual cannot open. Try again."))?;
    entries.retain(|_, entry| entry.created.elapsed() < TTL);
    ensure!(
        entries.len() < 32 && entries.values().map(|entry| entry.html.len()).sum::<usize>() + html.len() <= MAX_TICKET_BYTES,
        "Too many visuals are opening. Wait a moment and retry."
    );
    let ticket = uuid::Uuid::new_v4().to_string();
    entries.insert(ticket.clone(), Ticket { created: Instant::now(), thread: params.thread_id, html });
    let expires = ticket.clone();
    tokio::spawn(async move {
        tokio::time::sleep(TTL).await;
        if let Ok(mut entries) = tickets().lock() {
            entries.remove(&expires);
        }
    });
    Ok(ArtifactPreviewResult { ticket })
}
pub(crate) fn revoke(params: HtmlRevokeParams) {
    if let Ok(mut entries) = tickets().lock()
        && entries.get(&params.ticket).is_some_and(|entry| entry.thread == params.thread_id)
    {
        entries.remove(&params.ticket);
    }
}
pub(crate) async fn serve(Path(ticket): Path<String>) -> Response<Body> {
    let source = tickets().lock().ok().and_then(|mut entries| entries.remove(&ticket)).filter(|entry| entry.created.elapsed() < TTL);
    match source {
        Some(entry) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, POLICY)
            .header(header::CACHE_CONTROL, "no-store")
            .header("referrer-policy", "no-referrer")
            .header("x-content-type-options", "nosniff")
            .header("cross-origin-resource-policy", "cross-origin")
            .body(Body::from(entry.html))
            .unwrap(),
        None => Response::builder().status(StatusCode::NOT_FOUND).body(Body::from("This visual expired. Reopen it from Kybern.")).unwrap(),
    }
}
pub(crate) async fn preview(paths: &crate::config::Paths, params: HtmlPreviewParams) -> Result<HtmlPreviewResult> {
    let width = params.width.unwrap_or(728);
    ensure!((240..=1600).contains(&width), "Use a preview width of 240–1600 CSS pixels.");
    let appearance = params.appearance.as_deref().unwrap_or("dark");
    ensure!(matches!(appearance, "dark" | "light"), "Preview in dark or light appearance.");
    let (html, missing_images) = prepare::prepare(&params.html, true).await?;
    let mut result = preview::capture(&paths.root, html, width, appearance).await?;
    result.missing_images = missing_images;
    Ok(result)
}

/// Only transient tool transport carries screenshot bytes. Provider tools can
/// echo them in completions: strip these known image fields before persistence.
pub(crate) fn persisted_output(mut value: serde_json::Value) -> serde_json::Value {
    fn strip(value: &mut serde_json::Value, budget: &mut usize) {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        match value {
            serde_json::Value::Object(object) => {
                if object.get("type").and_then(serde_json::Value::as_str) == Some("image") && object.contains_key("data") {
                    object.remove("data");
                    object.insert("omitted".into(), true.into());
                }
                if object.contains_key("content_height") && object.contains_key("screenshot") {
                    object.remove("screenshot");
                }
                for child in object.values_mut() {
                    strip(child, budget);
                }
            }
            serde_json::Value::Array(children) => {
                for child in children {
                    strip(child, budget);
                }
            }
            _ => {}
        }
    }
    strip(&mut value, &mut 4096);
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn frames_are_one_use_opaque_and_revoke_is_thread_scoped() {
        let thread = uuid::Uuid::new_v4();
        let ticket = uuid::Uuid::new_v4().to_string();
        tickets()
            .lock()
            .unwrap()
            .insert(ticket.clone(), Ticket { created: Instant::now(), thread, html: "<button>Interactive</button>".into() });
        revoke(HtmlRevokeParams { thread_id: uuid::Uuid::new_v4(), ticket: ticket.clone() });
        let response = serve(Path(ticket.clone())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let policy = response.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(policy.contains("sandbox allow-scripts"));
        assert!(!policy.contains("allow-same-origin"));
        assert!(policy.contains("connect-src https:"));
        assert_eq!(serve(Path(ticket)).await.status(), StatusCode::NOT_FOUND);
    }
    #[test]
    fn screenshot_bytes_do_not_enter_event_logs() {
        let value = serde_json::json!({"_kybern_content":[{"type":"image","mimeType":"image/png","data":"huge bytes"},{"type":"text","text":"checked"}]});
        let clean = persisted_output(value);
        assert!(!clean.to_string().contains("huge bytes"));
        assert!(clean.to_string().contains("checked"));
    }
}
