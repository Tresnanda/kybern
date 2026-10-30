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
    format!("#kybern-theme={}", encode(&default_theme("dark")))
}
fn encode(value: &serde_json::Value) -> String {
    value
        .to_string()
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}
/// The theme a picture is pre-rendered in before any client has said what it uses.
fn default_theme(appearance: &str) -> serde_json::Value {
    let (foreground, muted, border, charts) = if appearance == "light" {
        ("#0d0d0d", "#5d5d5d", "rgba(13,13,13,0.1)", ["#0169cc", "#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"])
    } else {
        ("#fcfcfc", "#afafaf", "rgba(252,252,252,0.1)", ["#339cff", "#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"])
    };
    serde_json::json!({"appearance":appearance,"variables":{
        "--background":"transparent","--foreground":foreground,"--muted-foreground":muted,"--border":border,
        "--primary":charts[0],"--accent":charts[0],"--chart-1":charts[0],"--chart-2":charts[1],"--chart-3":charts[2],
        "--chart-4":charts[3],"--chart-5":charts[4],"--chart-6":charts[5],
        "--font-sans":"-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif",
        "--font-mono":"\"JetBrains Mono\", \"SF Mono\", Menlo, monospace",
    }})
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

#[allow(clippy::too_many_arguments)]
pub(crate) async fn publish(
    store: &kybern_store::Store,
    paths: &crate::config::Paths,
    thread_id: ThreadId,
    turn_id: TurnId,
    html: &str,
    title: &str,
    height: u32,
    ask: Option<VisualAsk>,
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
    let visual = HtmlVisual { id: uuid::Uuid::now_v7(), title: title.trim().to_owned(), height, heights, ask };
    let event = store.visual_publish(thread_id, turn_id, &visual, &source)?;
    prerender(paths.root.clone(), thread_id, visual.id, source);
    Ok(event)
}

// ---- transcript pictures ----

/// Bumped when the picture's rendering changes, so cached pictures are redrawn.
const SNAPSHOT_VERSION: u32 = 1;
/// Tall pages rest at this height with a fade (`HtmlSnapshotResult::clamp`).
pub(crate) const SNAPSHOT_CLAMP: u32 = 480;
/// The reply column a picture is pre-rendered for until a client says otherwise.
const DEFAULT_SNAPSHOT_WIDTH: u32 = 736;
const SNAPSHOT_CACHE_BYTES: u64 = 256 * 1024 * 1024;

fn snapshot_root(root: &std::path::Path) -> std::path::PathBuf {
    root.join("cache/visual-snapshots")
}
fn snapshot_dir(root: &std::path::Path, thread_id: ThreadId, visual_id: uuid::Uuid) -> std::path::PathBuf {
    snapshot_root(root).join(thread_id.to_string()).join(visual_id.to_string())
}
/// The theme and width each appearance was last drawn in: new visuals are pre-rendered in them.
fn recent_themes() -> &'static Mutex<HashMap<String, (serde_json::Value, u32)>> {
    static THEMES: OnceLock<Mutex<HashMap<String, (serde_json::Value, u32)>>> = OnceLock::new();
    THEMES.get_or_init(Default::default)
}
/// One render per picture at a time; a second request waits for the first and reads its files.
fn renders() -> &'static Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>> {
    static RENDERS: OnceLock<Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    RENDERS.get_or_init(Default::default)
}
fn theme_appearance(theme: &serde_json::Value) -> Result<&str> {
    let appearance = theme.get("appearance").and_then(serde_json::Value::as_str).unwrap_or("");
    ensure!(matches!(appearance, "dark" | "light"), "Pass a theme with a dark or light appearance.");
    ensure!(theme.get("variables").is_some_and(serde_json::Value::is_object), "Pass the theme's CSS variables.");
    ensure!(theme.to_string().len() <= 32 * 1024, "The theme is larger than 32 KiB.");
    Ok(appearance)
}
fn snapshot_key(width: u32, theme: &serde_json::Value, lock: Option<&serde_json::Value>) -> String {
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(format!(
        "{SNAPSHOT_VERSION}\n{width}\n{SNAPSHOT_CLAMP}\n{theme}\n{}",
        lock.map(serde_json::Value::to_string).unwrap_or_default()
    ));
    digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect()
}
#[derive(serde::Serialize, serde::Deserialize)]
struct SnapshotMeta {
    height: u32,
    clamped: bool,
    controls: Vec<VisualControl>,
}

/// Draw (or read the cached) picture of a visual. `remember` records the theme for later pre-renders.
pub(crate) async fn snapshot(
    store: &kybern_store::Store,
    paths: &crate::config::Paths,
    params: HtmlSnapshotParams,
) -> Result<HtmlSnapshotResult> {
    ensure!((240..=1600).contains(&params.width), "Use a picture width of 240–1600 CSS pixels.");
    let appearance = theme_appearance(&params.theme)?.to_owned();
    if let Some(lock) = &params.lock {
        ensure!(lock.to_string().len() <= MAX_VISUAL_ANSWER_BYTES + 1024, "The answered state is too large to draw.");
    }
    if params.lock.is_none()
        && let Ok(mut themes) = recent_themes().lock()
    {
        themes.insert(appearance, (params.theme.clone(), params.width));
    }
    let source =
        store.visual_read(params.thread_id, params.visual_id)?.ok_or_else(|| anyhow!("This visual no longer exists in this thread."))?;
    render_cached(&paths.root, params.thread_id, params.visual_id, &source, params.width, &params.theme, params.lock.as_ref()).await
}

async fn render_cached(
    root: &std::path::Path,
    thread_id: ThreadId,
    visual_id: uuid::Uuid,
    source: &str,
    width: u32,
    theme: &serde_json::Value,
    lock: Option<&serde_json::Value>,
) -> Result<HtmlSnapshotResult> {
    let appearance = theme_appearance(theme)?;
    let key = snapshot_key(width, theme, lock);
    let dir = snapshot_dir(root, thread_id, visual_id);
    let gate =
        renders().lock().map_err(|_| anyhow!("The picture cannot render. Reload to try again."))?.entry(key.clone()).or_default().clone();
    let _render = gate.lock().await;
    let result = |meta: SnapshotMeta| HtmlSnapshotResult {
        key: key.clone(),
        width,
        height: meta.height,
        scale: preview::SNAPSHOT_SCALE,
        clamped: meta.clamped,
        clamp: SNAPSHOT_CLAMP,
        controls: meta.controls,
    };
    let meta_file = dir.join(format!("{key}.json"));
    if let Ok(bytes) = tokio::fs::read(&meta_file).await
        && let Ok(meta) = serde_json::from_slice::<SnapshotMeta>(&bytes)
        && tokio::fs::try_exists(dir.join(format!("{key}.png"))).await.unwrap_or(false)
    {
        let _ = filetime_touch(&meta_file);
        if let Ok(mut map) = renders().lock() {
            map.remove(&key);
        }
        return Ok(result(meta));
    }
    let mut fragment = format!("#kybern-theme={}", encode(theme));
    if let Some(lock) = lock {
        fragment.push_str(&format!("&kybern-lock={}", encode(lock)));
    }
    let picture = preview::snapshot(root, source.to_owned(), width, appearance, &fragment, SNAPSHOT_CLAMP).await;
    if let Ok(mut map) = renders().lock() {
        map.remove(&key);
    }
    let picture = picture?;
    tokio::fs::create_dir_all(&dir).await?;
    let meta = SnapshotMeta { height: picture.height, clamped: picture.fade.is_some(), controls: picture.controls };
    // The picture lands before its metadata, so a reader that finds the metadata finds the picture.
    write_atomic(&dir.join(format!("{key}.png")), &picture.png).await?;
    if let Some(fade) = &picture.fade {
        write_atomic(&dir.join(format!("{key}-fade.png")), fade).await?;
    }
    write_atomic(&meta_file, &serde_json::to_vec(&meta)?).await?;
    let root = root.to_owned();
    tokio::task::spawn_blocking(move || prune_snapshots(&snapshot_root(&root), SNAPSHOT_CACHE_BYTES));
    Ok(result(meta))
}
async fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp, bytes).await?;
    tokio::fs::rename(&temp, path).await?;
    Ok(())
}
fn filetime_touch(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::File::options().append(true).open(path)?.set_modified(std::time::SystemTime::now())
}
/// Oldest visual folders first, until the cache fits `budget`.
fn prune_snapshots(root: &std::path::Path, budget: u64) {
    let mut folders = Vec::new();
    for thread in std::fs::read_dir(root).into_iter().flatten().flatten() {
        for visual in std::fs::read_dir(thread.path()).into_iter().flatten().flatten() {
            let (mut size, mut newest) = (0, std::time::SystemTime::UNIX_EPOCH);
            for file in std::fs::read_dir(visual.path()).into_iter().flatten().flatten() {
                if let Ok(meta) = file.metadata() {
                    size += meta.len();
                    newest = newest.max(meta.modified().unwrap_or(newest));
                }
            }
            folders.push((newest, size, visual.path()));
        }
    }
    let mut total: u64 = folders.iter().map(|(_, size, _)| size).sum();
    folders.sort();
    for (_, size, path) in folders {
        if total <= budget {
            break;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            total -= size;
        }
    }
}
/// Light and dark pictures, drawn in the background as a visual is published, so its first paint is the picture.
fn prerender(root: std::path::PathBuf, thread_id: ThreadId, visual_id: uuid::Uuid, source: String) {
    let mut themes: Vec<(serde_json::Value, u32)> =
        recent_themes().lock().map(|themes| themes.values().cloned().collect()).unwrap_or_default();
    for appearance in ["dark", "light"] {
        if !themes.iter().any(|(theme, _)| theme.get("appearance").and_then(serde_json::Value::as_str) == Some(appearance)) {
            themes.push((default_theme(appearance), DEFAULT_SNAPSHOT_WIDTH));
        }
    }
    tokio::spawn(async move {
        for (theme, width) in themes {
            if let Err(error) = render_cached(&root, thread_id, visual_id, &source, width, &theme, None).await {
                tracing::debug!(%error, "visual picture pre-render skipped");
                return;
            }
        }
    });
}
/// `GET /threads/{thread}/visuals/{visual}/snapshot/{key}.png` (or `{key}-fade.png`).
pub(crate) async fn snapshot_file(root: &std::path::Path, thread_id: ThreadId, visual_id: uuid::Uuid, file: &str) -> Option<Vec<u8>> {
    let name = file.strip_suffix(".png")?;
    let key = name.strip_suffix("-fade").unwrap_or(name);
    if key.len() != 32 || !key.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return None;
    }
    tokio::fs::read(snapshot_dir(root, thread_id, visual_id).join(file)).await.ok()
}

// ---- answers ----

pub(crate) const DEFAULT_ANSWER_SECONDS: u64 = 900;
const MIN_ANSWER_SECONDS: u64 = 30;
const MAX_ANSWER_SECONDS: u64 = 3600;
pub(crate) fn answer_wait(timeout_seconds: Option<u64>) -> Duration {
    Duration::from_secs(timeout_seconds.map_or(DEFAULT_ANSWER_SECONDS, |seconds| seconds.clamp(MIN_ANSWER_SECONDS, MAX_ANSWER_SECONDS)))
}
/// A publish that waits for the reader runs for the wait plus slack; any other publish fits the long tool budget.
pub(crate) fn call_budget(name: &str, arguments: &serde_json::Value) -> Option<Duration> {
    let tool = name == "kybern_html_publish" || name.rsplit_once("__").is_some_and(|(_, tool)| tool == "kybern_html_publish");
    (tool && arguments.get("await_answer").and_then(serde_json::Value::as_bool) == Some(true))
        .then(|| answer_wait(arguments.get("timeout_seconds").and_then(serde_json::Value::as_u64)) + Duration::from_secs(30))
}
/// The agent's `answer_schema`, checked before the visual is published.
pub(crate) fn answer_ask(params: &HtmlPublishParams) -> Result<Option<VisualAsk>> {
    if params.await_answer != Some(true) {
        ensure!(params.answer_schema.is_none(), "answer_schema needs await_answer: true.");
        return Ok(None);
    }
    if let Some(schema) = &params.answer_schema {
        ensure!(schema.is_object(), "answer_schema must be a JSON Schema object.");
        ensure!(schema.to_string().len() <= 16 * 1024, "answer_schema is larger than 16 KiB.");
    }
    Ok(Some(VisualAsk { schema: params.answer_schema.clone() }))
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
            repo: None,
            repos: Vec::new(),
            id: uuid::Uuid::now_v7(),
            name: "Visual publish fixture".into(),
            path: "/scratch/visual-publish".into(),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
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
        let event = publish(&store, &scratch_paths(root.clone()), thread.id, uuid::Uuid::now_v7(), "<p>Hello</p>", "Hello", 300, None)
            .await
            .unwrap();
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
            repo: None,
            repos: Vec::new(),
            id: uuid::Uuid::now_v7(),
            name: "Visual read fixture".into(),
            path: "/scratch/visual-read".into(),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        };
        store.project_insert(&project).unwrap();
        let thread: Thread = serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::now_v7(), "project_id": project.id, "title": "Source preview",
            "provider": ProviderInstance::default_for(ProviderKind::Codex), "permission_mode": "supervised",
            "status": "idle", "cwd": project.path, "pinned": false, "created_at": now, "updated_at": now, "last_seq": 0,
        }))
        .unwrap();
        store.thread_upsert(&thread).unwrap();
        let visual = HtmlVisual { id: uuid::Uuid::now_v7(), title: "Large embedded image".into(), height: 400, heights: vec![], ask: None };
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
    fn picture_keys_follow_width_theme_and_answer() {
        let dark = default_theme("dark");
        let key = snapshot_key(736, &dark, None);
        assert_eq!(key.len(), 32);
        assert_eq!(key, snapshot_key(736, &dark, None), "the same picture keeps its key");
        assert_ne!(key, snapshot_key(600, &dark, None));
        assert_ne!(key, snapshot_key(736, &default_theme("light"), None));
        assert_ne!(key, snapshot_key(736, &dark, Some(&serde_json::json!({"state":"answered","answer":{"layout":"B"}}))));
        assert!(theme_appearance(&serde_json::json!({"appearance":"sepia","variables":{}})).is_err());
        assert!(theme_appearance(&serde_json::json!({"appearance":"dark"})).is_err());
    }
    #[tokio::test]
    async fn picture_files_are_named_by_key_only() {
        let root = std::env::temp_dir().join(format!("kybern-visual-snapshot-{}", uuid::Uuid::now_v7()));
        let (thread, visual) = (uuid::Uuid::now_v7(), uuid::Uuid::now_v7());
        let dir = snapshot_dir(&root, thread, visual);
        std::fs::create_dir_all(&dir).unwrap();
        let key = "0123456789abcdef0123456789abcdef";
        std::fs::write(dir.join(format!("{key}.png")), b"png").unwrap();
        std::fs::write(dir.join(format!("{key}-fade.png")), b"fade").unwrap();
        assert_eq!(snapshot_file(&root, thread, visual, &format!("{key}.png")).await.as_deref(), Some(&b"png"[..]));
        assert_eq!(snapshot_file(&root, thread, visual, &format!("{key}-fade.png")).await.as_deref(), Some(&b"fade"[..]));
        for bad in [format!("{key}.json"), "../x.png".into(), format!("{}.png", key.to_uppercase()), "abc.png".into()] {
            assert!(snapshot_file(&root, thread, visual, &bad).await.is_none(), "{bad}");
        }
        assert!(snapshot_file(&root, uuid::Uuid::now_v7(), visual, &format!("{key}.png")).await.is_none(), "pictures are per thread");
        prune_snapshots(&snapshot_root(&root), 0);
        assert!(!dir.exists(), "pruning to zero removes every picture");
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn waiting_publishes_get_the_answer_wait_and_a_checked_schema() {
        let waits = serde_json::json!({"await_answer": true, "timeout_seconds": 120});
        assert_eq!(call_budget("kybern_html_publish", &waits), Some(Duration::from_secs(150)));
        assert_eq!(
            call_budget("mcp__kybern__kybern_html_publish", &serde_json::json!({"await_answer": true})),
            Some(Duration::from_secs(930))
        );
        assert_eq!(call_budget("kybern_html_publish", &serde_json::json!({})), None);
        assert_eq!(answer_wait(Some(5)), Duration::from_secs(30));
        assert_eq!(answer_wait(Some(99_999)), Duration::from_secs(3600));
        let params = |await_answer: Option<bool>, schema: Option<serde_json::Value>| HtmlPublishParams {
            thread_id: uuid::Uuid::now_v7(),
            html: "<p>x</p>".into(),
            title: "Pick".into(),
            height: 300,
            await_answer,
            answer_schema: schema,
            timeout_seconds: None,
        };
        assert_eq!(answer_ask(&params(None, None)).unwrap(), None);
        assert!(answer_ask(&params(None, Some(serde_json::json!({"type":"string"})))).is_err(), "a schema needs await_answer");
        assert!(answer_ask(&params(Some(true), Some(serde_json::json!("string")))).is_err());
        let ask = answer_ask(&params(Some(true), Some(serde_json::json!({"enum":["A","B"]})))).unwrap().unwrap();
        assert_eq!(ask.schema, Some(serde_json::json!({"enum":["A","B"]})));
    }
    /// Needs the preview browser under `KYBERN_VISUAL_LIVE_ROOT`.
    #[tokio::test]
    #[ignore]
    async fn pictures_are_transparent_with_controls_and_a_fade() {
        let root = std::path::PathBuf::from(std::env::var("KYBERN_VISUAL_LIVE_ROOT").expect("set KYBERN_VISUAL_LIVE_ROOT"));
        let html = "<style>body{margin:0}.t{height:900px}</style><button style='width:80px;height:30px;border-radius:8px'>Raw</button><div class=t></div>";
        let (source, _) = prepare::prepare(html, false).await.unwrap();
        let fragment = format!("#kybern-theme={}", encode(&default_theme("dark")));
        let shot = preview::snapshot(&root, source, 736, "dark", &fragment, SNAPSHOT_CLAMP).await.unwrap();
        assert!(shot.height >= 930, "{}", shot.height);
        assert!(shot.fade.is_some(), "a tall page gets its clamped picture");
        let button = shot.controls.iter().find(|c| c.role == "button").expect("the button is in the hit map");
        assert_eq!((button.w, button.h, button.r), (80.0, 30.0, 8.0));
        assert_eq!(&shot.png[1..4], b"PNG");
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
