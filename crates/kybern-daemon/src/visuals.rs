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
/// Widths a visual is measured at: common phones, then the 736 px standard
/// column (46rem) and the 1152 px wide column (72rem).
const MEASURE_WIDTHS: [u32; 9] = [320, 375, 430, 520, 640, 736, 860, 1000, 1152];
const MEASURE_BUDGET: Duration = Duration::from_secs(6);
/// Default dark theme with Kybern's own font stacks; the daemon usually shares the client's fonts.
fn measure_fragment() -> String {
    let theme = serde_json::json!({"appearance":"dark","variables":{
        "--font-sans":"-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif",
        "--font-mono":"\"JetBrains Mono\", \"SF Mono\", Menlo, monospace",
    }});
    let encoded: String = theme
        .to_string()
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    format!("#kybern-theme={encoded}")
}
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
    paths: &crate::config::Paths,
    thread_id: ThreadId,
    turn_id: TurnId,
    html: &str,
    title: &str,
    height: u32,
) -> Result<ThreadEvent> {
    ensure!(!title.trim().is_empty() && title.chars().count() <= 200, "Give this page a title of 1–200 characters.");
    ensure!((80..=2000).contains(&height), "Use a frame height of 80–2000 CSS pixels.");
    let (source, _) = prepare::prepare(html, false).await?;
    let heights =
        match tokio::time::timeout(MEASURE_BUDGET, preview::measure(&paths.root, &source, &MEASURE_WIDTHS, &measure_fragment())).await {
            Ok(Ok(heights)) => heights,
            Ok(Err(error)) => {
                tracing::warn!(%error, "publishing visual without measured heights");
                Vec::new()
            }
            Err(_) => {
                tracing::warn!("measuring visual exceeded 6 s; publishing without heights");
                Vec::new()
            }
        };
    let visual = HtmlVisual { id: uuid::Uuid::now_v7(), title: title.trim().to_owned(), height, heights };
    store.visual_publish(thread_id, turn_id, &visual, &source)
}
pub(crate) fn read(store: &kybern_store::Store, params: HtmlReadParams) -> Result<HtmlReadResult> {
    if let Some(max_bytes) = params.max_bytes {
        ensure!((1..=1024 * 1024).contains(&max_bytes), "Use a source preview limit of 1–1,048,576 bytes.");
    }
    let mut html =
        store.visual_read(params.thread_id, params.visual_id)?.ok_or_else(|| anyhow!("This visual no longer exists in this thread."))?;
    let truncated = params.max_bytes.is_some_and(|max| html.len() > max as usize);
    if truncated {
        let mut end = params.max_bytes.unwrap() as usize;
        while !html.is_char_boundary(end) {
            end -= 1;
        }
        html.truncate(end);
    }
    Ok(HtmlReadResult { html, truncated })
}
pub(crate) fn issue(store: &kybern_store::Store, params: HtmlReadParams) -> Result<ArtifactPreviewResult> {
    // A source-preview budget never changes the actual interactive document.
    let html = read(store, HtmlReadParams { max_bytes: None, ..params.clone() })?.html;
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
pub(crate) fn is_preview_tool(name: &str) -> bool {
    name == "kybern_html_preview"
        || ["mcp__kybern__", "mcp_kybern_", "kybern.", "kybern/"]
            .iter()
            .any(|prefix| name.strip_prefix(prefix) == Some("kybern_html_preview"))
}
pub(crate) fn persisted_output(name: Option<&str>, mut value: serde_json::Value) -> serde_json::Value {
    if !name.is_some_and(is_preview_tool) {
        return value;
    }
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
            serde_json::Value::String(text) if text.len() > 256 * 1024 => {
                // Some harnesses serialize MCP content again as one JSON string.
                if let Ok(mut nested) = serde_json::from_str::<serde_json::Value>(text) {
                    strip(&mut nested, budget);
                    *text = nested.to_string();
                } else {
                    *text = "Preview image omitted from the saved tool log; screenshot was delivered to the agent.".into();
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
    fn scratch_paths(root: std::path::PathBuf) -> crate::config::Paths {
        crate::config::Paths {
            db: root.join("state.sqlite"),
            token_file: root.join("daemon.token"),
            port_file: root.join("daemon.port"),
            worktrees: root.join("worktrees"),
            assets: root.join("assets"),
            settings: root.join("settings.json"),
            root,
        }
    }
    fn scratch_thread(store: &kybern_store::Store) -> Thread {
        let now = chrono::Utc::now();
        let project = Project {
            id: uuid::Uuid::now_v7(),
            name: "Visual publish fixture".into(),
            path: "/scratch/visual-publish".into(),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            created_at: now,
            updated_at: now,
        };
        store.project_insert(&project).unwrap();
        let thread: Thread = serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::now_v7(), "project_id": project.id, "title": "Publish",
            "provider": ProviderInstance::default_for(ProviderKind::Codex), "permission_mode": "supervised",
            "status": "idle", "cwd": project.path, "pinned": false, "created_at": now, "updated_at": now, "last_seq": 0,
        }))
        .unwrap();
        store.thread_upsert(&thread).unwrap();
        thread
    }
    #[tokio::test]
    async fn publish_without_an_installed_browser_omits_heights() {
        let store = kybern_store::Store::open_in_memory().unwrap();
        let thread = scratch_thread(&store);
        let root = std::env::temp_dir().join(format!("kybern-visual-publish-{}", uuid::Uuid::now_v7()));
        let started = Instant::now();
        let event =
            publish(&store, &scratch_paths(root.clone()), thread.id, uuid::Uuid::now_v7(), "<p>Hello</p>", "Hello", 300).await.unwrap();
        let EventPayload::HtmlPublished { visual } = event.payload else { panic!("expected a published visual") };
        assert!(visual.heights.is_empty());
        assert!(started.elapsed() < Duration::from_secs(2), "A missing browser never delays publishing");
        let json = serde_json::to_value(&visual).unwrap();
        assert!(json.get("heights").is_none(), "Empty heights stay off the wire");
        let _ = std::fs::remove_dir_all(root);
    }
    /// Needs the preview browser (`kybern html preview` installs it) under `KYBERN_VISUAL_LIVE_ROOT`.
    #[tokio::test]
    #[ignore]
    async fn measure_follows_the_frame_width() {
        let root = std::path::PathBuf::from(
            std::env::var("KYBERN_VISUAL_LIVE_ROOT").expect("set KYBERN_VISUAL_LIVE_ROOT to a data dir with the preview browser"),
        );
        let html = "<style>body{margin:0}.a{height:100px}@media(min-width:600px){.a{height:300px}}</style><div class=a></div>";
        let heights = preview::measure(&root, html, &MEASURE_WIDTHS, &measure_fragment()).await.unwrap();
        assert_eq!(heights.len(), MEASURE_WIDTHS.len());
        let narrow = heights.iter().find(|h| h.width == 375).unwrap().height;
        let wide = heights.iter().find(|h| h.width == 736).unwrap().height;
        assert!(wide > narrow, "{heights:?}");
    }
    #[tokio::test]
    async fn source_previews_bound_unicode_bytes_without_truncating_exports_or_frames() {
        let store = kybern_store::Store::open_in_memory().unwrap();
        let now = chrono::Utc::now();
        let project = Project {
            id: uuid::Uuid::now_v7(),
            name: "Visual read fixture".into(),
            path: "/scratch/visual-read".into(),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            created_at: now,
            updated_at: now,
        };
        store.project_insert(&project).unwrap();
        let thread: Thread = serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::now_v7(), "project_id": project.id, "title": "Source preview",
            "provider": ProviderInstance::default_for(ProviderKind::Codex), "permission_mode": "supervised",
            "status": "idle", "cwd": project.path, "pinned": false, "created_at": now, "updated_at": now, "last_seq": 0,
        }))
        .unwrap();
        store.thread_upsert(&thread).unwrap();
        let visual = HtmlVisual { id: uuid::Uuid::now_v7(), title: "Large embedded image".into(), height: 400, heights: vec![] };
        let html = format!("{}🧭<img src=\"data:image/png;base64,{}\">", "x".repeat(255_999), "A".repeat(1024 * 1024));
        store.visual_publish(thread.id, uuid::Uuid::now_v7(), &visual, &html).unwrap();
        let head = store.events_head_seq().unwrap();
        let legacy: HtmlReadParams = serde_json::from_value(serde_json::json!({"thread_id": thread.id, "visual_id": visual.id})).unwrap();
        assert!(legacy.max_bytes.is_none());
        let preview = read(&store, HtmlReadParams { max_bytes: Some(256_000), ..legacy.clone() }).unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.html.len(), 255_999);
        assert!(html.starts_with(&preview.html));
        assert!(serde_json::to_vec(&preview).unwrap().len() < 256_100, "Embedded-image bytes do not cross the preview wire boundary");
        let exact_unicode = read(&store, HtmlReadParams { max_bytes: Some(256_003), ..legacy.clone() }).unwrap();
        assert!(exact_unicode.html.ends_with('🧭'));
        assert_eq!(exact_unicode.html.len(), 256_003);
        assert_eq!(read(&store, legacy.clone()).unwrap().html, html, "Full export retains complete prepared source");
        assert!(!read(&store, legacy.clone()).unwrap().truncated);
        for max in [0, 1024 * 1024 + 1] {
            assert!(read(&store, HtmlReadParams { max_bytes: Some(max), ..legacy.clone() }).is_err());
        }
        let frame = issue(&store, HtmlReadParams { max_bytes: Some(1), ..legacy }).unwrap();
        assert_eq!(tickets().lock().unwrap().get(&frame.ticket).unwrap().html, html, "Interactive frames always receive the full document");
        revoke(HtmlRevokeParams { thread_id: thread.id, ticket: frame.ticket });
        assert_eq!(store.events_head_seq().unwrap(), head, "Preview and export reads never append transcript events");
    }
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
        let clean = persisted_output(Some("kybern_html_preview"), value);
        assert!(!clean.to_string().contains("huge bytes"));
        assert!(clean.to_string().contains("checked"));
    }
    #[test]
    fn only_native_preview_outputs_lose_transient_images() {
        let image = serde_json::json!({"content":[{"type":"image","mimeType":"image/png","data":"image bytes"}]});
        for name in ["kybern_computer_screenshot", "mcp__plugin__imagegen", "Image", "custom_kybern_html_preview"] {
            assert_eq!(persisted_output(Some(name), image.clone()), image);
        }
        assert_eq!(persisted_output(None, image.clone()), image);
        for name in [
            "kybern_html_preview",
            "mcp__kybern__kybern_html_preview",
            "mcp_kybern_kybern_html_preview",
            "kybern.kybern_html_preview",
            "kybern/kybern_html_preview",
        ] {
            assert!(!persisted_output(Some(name), image.clone()).to_string().contains("image bytes"));
        }
    }
}
