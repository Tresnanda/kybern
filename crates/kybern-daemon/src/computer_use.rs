//! Host-owned computer use: one compound native tool executed by Cua Driver.
//!
//! This is not a sixth `AgentDriver`. Codex keeps its bundled Computer Use
//! plugin; Claude, OpenCode, Pi, OMP, and Cursor call `computer_use` on the
//! existing native tool bridge.

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail, ensure};
use base64::Engine;
use kybern_drivers::NativeToolDefinition;
use kybern_protocol::{ApprovalDecision, ComputerUseSettings, ComputerUseStatus, PermissionMode, ProviderKind, Settings, ThreadId};
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::process::Command;
use tokio::sync::oneshot;
use uuid::Uuid;

pub(crate) const TOOL_NAME: &str = "computer_use";
pub(crate) const HOST_REQUEST_PREFIX: &str = "computer_use:";
pub(crate) const INSTALL_URL: &str = "https://cua.ai/docs/how-to-guides/driver/install";

const MAX_DESCRIPTION_CHARS: usize = 280;
const MAX_TEXT_BYTES: usize = 8 * 1024;
const MAX_SCREENSHOT_EDGE: u32 = 896;
const MAX_SCREENSHOT_BYTES: usize = 24 * 1024;
const MIN_CAPTURE_INTERVAL: Duration = Duration::from_millis(250);
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const DOCTOR_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_CACHE_THREADS: usize = 64;

const TOOL_DESCRIPTION: &str = "Drive this desktop: list apps/windows, capture one window, click, type, key, scroll, drag. One action per call. Prefer list then capture; set observe only when the UI changed. Requires cua-driver. Codex should use @Computer Use instead.";
const _: () = assert!(TOOL_DESCRIPTION.len() <= MAX_DESCRIPTION_CHARS);

/// Pending host-side GUI approvals and bounded screenshot cache.
#[derive(Clone)]
pub(crate) struct ComputerUseRuntime {
    inner: std::sync::Arc<Mutex<RuntimeState>>,
}

struct RuntimeState {
    last_hash: HashMap<ThreadId, String>,
    last_capture: HashMap<ThreadId, Instant>,
    approvals: HashMap<uuid::Uuid, (Uuid, oneshot::Sender<ApprovalDecision>)>,
    grants: HashMap<Uuid, HashSet<String>>,
}

impl ComputerUseRuntime {
    pub(crate) fn new() -> Self {
        Self {
            inner: std::sync::Arc::new(Mutex::new(RuntimeState {
                last_hash: HashMap::new(),
                last_capture: HashMap::new(),
                approvals: HashMap::new(),
                grants: HashMap::new(),
            })),
        }
    }

    pub(crate) fn register_approval(&self, session_instance_id: Uuid, id: uuid::Uuid) -> oneshot::Receiver<ApprovalDecision> {
        let (tx, rx) = oneshot::channel();
        self.lock().approvals.insert(id, (session_instance_id, tx));
        rx
    }

    pub(crate) fn take_approval(&self, id: uuid::Uuid) -> Option<oneshot::Sender<ApprovalDecision>> {
        self.lock().approvals.remove(&id).map(|(_, tx)| tx)
    }

    pub(crate) fn has_grant(&self, session_instance_id: Uuid, key: &str) -> bool {
        self.lock().grants.get(&session_instance_id).is_some_and(|grants| grants.contains(key))
    }

    pub(crate) fn remember_grant(&self, session_instance_id: Uuid, key: String) {
        let mut state = self.lock();
        let grants = state.grants.entry(session_instance_id).or_default();
        if grants.len() >= 256
            && let Some(oldest) = grants.iter().next().cloned()
        {
            grants.remove(&oldest);
        }
        grants.insert(key);
    }

    pub(crate) fn forget_session(&self, session_instance_id: Uuid) {
        let mut state = self.lock();
        state.grants.remove(&session_instance_id);
        let denied = ApprovalDecision::Deny { reason: Some("session ended".into()) };
        let pending: Vec<_> =
            state.approvals.extract_if(|_, (session, _)| *session == session_instance_id).map(|(_, (_, tx))| tx).collect();
        drop(state);
        for tx in pending {
            let _ = tx.send(denied.clone());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RuntimeState> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) async fn status(&self, settings: &Settings) -> ComputerUseStatus {
        probe_status(settings).await
    }

    pub(crate) async fn perform(&self, settings: &Settings, thread_id: ThreadId, args: &ComputerUseArgs) -> Result<Value> {
        if args.action == Action::Status {
            return Ok(serde_json::to_value(self.status(settings).await)?);
        }
        let binary = resolve_binary(&settings.computer_use).ok_or_else(|| anyhow!("{}", missing_binary_message(&settings.computer_use)))?;
        let mut args = args.clone();
        if args.action == Action::Capture {
            let target = resolve_window_target(&binary, &args).await?;
            refuse_full_desktop(&target)?;
            args.pid = Some(target.pid);
            args.window_id = Some(target.window_id.to_string());
        } else if needs_window_target(args.action)
            && let Ok(target) = resolve_window_target(&binary, &args).await
            && refuse_full_desktop(&target).is_ok()
        {
            args.pid = Some(target.pid);
            args.window_id = Some(target.window_id.to_string());
        }
        let calls = cua_calls(&args)?;
        let mut last = json!({ "ok": true, "action": args.action.as_str() });
        let want_image = args.action == Action::Capture || args.observe.unwrap_or(false);
        for (index, (tool, input)) in calls.iter().enumerate() {
            let capture = want_image && index + 1 == calls.len();
            if capture && self.rate_limited(thread_id) {
                last["skipped"] = json!("rate");
                last["unchanged"] = json!(true);
                last["ok"] = json!(true);
                continue;
            }
            let raw = call_cua(&binary, tool, input).await?;
            let mut compact = compact_cua_payload(&raw);
            if args.action == Action::ListWindows {
                compact = filter_listed_windows(compact, args.app.as_deref());
            }
            last["cua"] = compact;
            if capture {
                match bound_screenshot_from_cua(&raw)? {
                    None => {
                        last["screenshot"] = Value::Null;
                    }
                    Some(shot) => {
                        let hash = screenshot_hash(&shot.data);
                        if self.mark_screenshot(thread_id, hash.clone()) {
                            last["unchanged"] = json!(true);
                            last["skipped"] = json!("unchanged");
                        } else {
                            last["unchanged"] = json!(false);
                            last["screenshot"] = serde_json::to_value(shot)?;
                        }
                    }
                }
            }
        }
        Ok(last)
    }

    fn rate_limited(&self, thread_id: ThreadId) -> bool {
        self.lock().last_capture.get(&thread_id).is_some_and(|at| at.elapsed() < MIN_CAPTURE_INTERVAL)
    }

    /// Returns true when this frame matches the previous one.
    fn mark_screenshot(&self, thread_id: ThreadId, hash: String) -> bool {
        let mut state = self.lock();
        let unchanged = state.last_hash.get(&thread_id) == Some(&hash);
        if state.last_hash.len() >= MAX_CACHE_THREADS
            && let Some(oldest) = state.last_hash.keys().next().copied()
        {
            state.last_hash.remove(&oldest);
            state.last_capture.remove(&oldest);
        }
        state.last_hash.insert(thread_id, hash);
        state.last_capture.insert(thread_id, Instant::now());
        unchanged
    }
}

pub(crate) fn tool_definition() -> NativeToolDefinition {
    NativeToolDefinition {
        name: TOOL_NAME.into(),
        description: TOOL_DESCRIPTION.into(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["action"],
            "properties": {
                "action": { "enum": ["status", "list_apps", "list_windows", "capture", "click", "type", "key", "hotkey", "scroll", "drag"] },
                "app": { "type": "string" },
                "window_id": { "type": ["string", "number"] },
                "pid": { "type": "integer" },
                "x": { "type": "number" },
                "y": { "type": "number" },
                "x2": { "type": "number" },
                "y2": { "type": "number" },
                "text": { "type": "string" },
                "keys": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
                "amount": { "type": "number" },
                "observe": { "type": "boolean", "description": "Include a bounded window screenshot. Off after input." }
            }
        }),
    }
}

pub(crate) fn should_attach(kind: ProviderKind, settings: &Settings) -> bool {
    settings.computer_use.enabled && kind != ProviderKind::Codex && resolve_binary(&settings.computer_use).is_some()
}

pub(crate) fn native_tools_for(kind: ProviderKind, settings: &Settings) -> Vec<NativeToolDefinition> {
    let mut tools = crate::app_tools::native_tool_definitions();
    if should_attach(kind, settings) {
        tools.push(tool_definition());
    }
    tools
}

pub(crate) fn resolve_binary(settings: &ComputerUseSettings) -> Option<PathBuf> {
    if let Some(path) = settings.binary.as_deref().map(str::trim).filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    which::which("cua-driver").ok()
}

pub(crate) fn missing_binary_message(settings: &ComputerUseSettings) -> String {
    if let Some(path) = settings.binary.as_deref().map(str::trim).filter(|path| !path.is_empty()) {
        format!(
            "cua-driver was not found at {path}. Install Cua Driver from {INSTALL_URL} or fix computer_use.binary, then run `kybern computer-use`."
        )
    } else {
        format!("cua-driver is not installed. Install it from {INSTALL_URL}, then run `kybern computer-use`.")
    }
}

pub(crate) fn needs_host_approval(mode: PermissionMode, action: Action) -> bool {
    action.is_mutating() && matches!(mode, PermissionMode::Supervised | PermissionMode::AcceptEdits)
}

pub(crate) fn grant_key(args: &ComputerUseArgs) -> String {
    json!([args.action.as_str(), args.app, args.window_id, args.x, args.y, args.x2, args.y2, args.text, args.keys, args.amount]).to_string()
}

pub(crate) fn approval_summary(args: &ComputerUseArgs) -> String {
    let target = args.app.as_deref().or(args.window_id.as_deref()).unwrap_or("the desktop");
    match args.action {
        Action::Click => format!("Allow desktop click on {target}"),
        Action::Type => format!("Allow desktop typing in {target}"),
        Action::Key | Action::Hotkey => format!("Allow desktop keys on {target}"),
        Action::Scroll => format!("Allow desktop scroll on {target}"),
        Action::Drag => format!("Allow desktop drag on {target}"),
        _ => format!("Allow desktop {}", args.action.as_str()),
    }
}

pub(crate) fn parse_args(arguments: Value) -> Result<ComputerUseArgs> {
    serde_json::from_value(arguments).map_err(|error| anyhow!("invalid computer_use arguments: {error}"))
}

pub(crate) fn mcp_result(value: Value, is_error: bool) -> Value {
    let screenshot = value.get("screenshot").cloned().filter(|value| value.is_object());
    let mut text_value = value;
    if let Some(object) = text_value.as_object_mut()
        && let Some(shot) = object.get_mut("screenshot")
        && let Some(shot) = shot.as_object_mut()
    {
        shot.remove("data");
        shot.insert("attached".into(), json!(true));
    }
    let mut text = text_value.to_string();
    if text.len() > MAX_TEXT_BYTES {
        text.truncate(MAX_TEXT_BYTES);
    }
    let mut content = vec![json!({ "type": "text", "text": text })];
    if let Some(shot) = screenshot
        && let (Some(data), Some(mime)) = (shot.get("data").and_then(Value::as_str), shot.get("mime").and_then(Value::as_str))
    {
        content.push(json!({ "type": "image", "data": data, "mimeType": mime }));
    }
    json!({ "isError": is_error, "content": content })
}

pub(crate) fn screenshot_data_url(value: &Value) -> Option<String> {
    let shot = value.get("screenshot")?;
    let data = shot.get("data").and_then(Value::as_str)?;
    let mime = shot.get("mime").and_then(Value::as_str).unwrap_or("image/jpeg");
    Some(format!("data:{mime};base64,{data}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Action {
    Status,
    ListApps,
    ListWindows,
    Capture,
    Click,
    #[serde(rename = "type")]
    Type,
    Key,
    Hotkey,
    Scroll,
    Drag,
}

impl Action {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::ListApps => "list_apps",
            Self::ListWindows => "list_windows",
            Self::Capture => "capture",
            Self::Click => "click",
            Self::Type => "type",
            Self::Key => "key",
            Self::Hotkey => "hotkey",
            Self::Scroll => "scroll",
            Self::Drag => "drag",
        }
    }

    fn is_mutating(self) -> bool {
        matches!(self, Self::Click | Self::Type | Self::Key | Self::Hotkey | Self::Scroll | Self::Drag)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ComputerUseArgs {
    pub action: Action,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_id")]
    pub window_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_i64")]
    pub pid: Option<i64>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub x2: Option<f64>,
    #[serde(default)]
    pub y2: Option<f64>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub keys: Option<Vec<String>>,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub observe: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub(crate) struct BoundedScreenshot {
    pub mime: String,
    pub data: String,
    pub width: u32,
    pub height: u32,
}

fn cua_calls(args: &ComputerUseArgs) -> Result<Vec<(&'static str, Value)>> {
    let window_id = args.window_id.as_deref().filter(|value| !value.is_empty());
    match args.action {
        Action::Status => Ok(Vec::new()),
        Action::ListApps => Ok(vec![("list_apps", json!({}))]),
        Action::ListWindows => Ok(vec![("list_windows", json!({}))]),
        Action::Capture => {
            let pid =
                args.pid.ok_or_else(|| anyhow!("capture needs pid and window_id from list_windows; full-desktop dumps are disabled"))?;
            let window = parse_window_id(window_id)?;
            Ok(vec![(
                "get_window_state",
                json!({
                    "pid": pid,
                    "window_id": window,
                    "include_screenshot": true,
                    "include_accessibility_tree": false
                }),
            )])
        }
        Action::Click => {
            ensure!(args.x.is_some() && args.y.is_some(), "click needs x and y");
            Ok(vec![("click", target_point(args.pid, parse_optional_window_id(window_id)?, args.x.unwrap(), args.y.unwrap()))])
        }
        Action::Type => {
            let text = args.text.as_deref().map(str::trim).filter(|text| !text.is_empty()).ok_or_else(|| anyhow!("type needs text"))?;
            ensure!(text.len() <= 4000, "type text is too long; send a shorter string");
            let mut input = json!({ "text": text });
            assign_target(&mut input, args.pid, parse_optional_window_id(window_id)?);
            Ok(vec![("type_text", input)])
        }
        Action::Key => {
            let key = args
                .keys
                .as_ref()
                .and_then(|keys| keys.first())
                .map(String::as_str)
                .or(args.text.as_deref())
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .ok_or_else(|| anyhow!("key needs keys or text"))?;
            let mut input = json!({ "key": key });
            assign_target(&mut input, args.pid, parse_optional_window_id(window_id)?);
            Ok(vec![("press_key", input)])
        }
        Action::Hotkey => {
            let keys = args.keys.as_ref().filter(|keys| !keys.is_empty()).ok_or_else(|| anyhow!("hotkey needs keys"))?;
            let mut input = json!({ "keys": keys });
            assign_target(&mut input, args.pid, parse_optional_window_id(window_id)?);
            Ok(vec![("hotkey", input)])
        }
        Action::Scroll => {
            let mut input = json!({ "delta_y": args.amount.unwrap_or(-1.0) });
            assign_target(&mut input, args.pid, parse_optional_window_id(window_id)?);
            Ok(vec![("scroll", input)])
        }
        Action::Drag => {
            ensure!(args.x.is_some() && args.y.is_some() && args.x2.is_some() && args.y2.is_some(), "drag needs x, y, x2, and y2");
            let mut input = json!({
                "from": { "x": args.x, "y": args.y },
                "to": { "x": args.x2, "y": args.y2 }
            });
            assign_target(&mut input, args.pid, parse_optional_window_id(window_id)?);
            Ok(vec![("drag", input)])
        }
    }
}

fn needs_window_target(action: Action) -> bool {
    matches!(action, Action::Capture | Action::Click | Action::Type | Action::Key | Action::Hotkey | Action::Scroll | Action::Drag)
}

#[derive(Debug, Clone)]
struct WindowTarget {
    pid: i64,
    window_id: i64,
    app_name: String,
    title: String,
    width: i64,
    height: i64,
}

async fn resolve_window_target(binary: &Path, args: &ComputerUseArgs) -> Result<WindowTarget> {
    let listed = call_cua(binary, "list_windows", &json!({})).await?;
    let mut windows = parse_windows(&compact_cua_payload(&listed));
    if let (Some(pid), Some(window)) = (args.pid, parse_optional_window_id(args.window_id.as_deref())?) {
        if let Some(found) = windows.iter().find(|item| item.pid == pid && item.window_id == window).cloned() {
            return Ok(found);
        }
        return Ok(WindowTarget {
            pid,
            window_id: window,
            app_name: args.app.clone().unwrap_or_default(),
            title: String::new(),
            width: 0,
            height: 0,
        });
    }
    if let Some(window_id) = args.window_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        windows.retain(|window| window.window_id.to_string() == window_id);
        ensure!(!windows.is_empty(), "no window {window_id}; call list_windows and pass window_id");
    } else if let Some(app) = args.app.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        let needle = app.to_lowercase();
        windows.retain(|window| window.app_name.to_lowercase().contains(&needle) || window.title.to_lowercase().contains(&needle));
        ensure!(!windows.is_empty(), "no windows for {app}; call list_windows and pass window_id");
    } else if args.action == Action::Capture {
        bail!("capture needs window_id or app from list_windows; full-desktop dumps are disabled");
    }
    windows.retain(|window| !is_desktop_dump(window));
    windows.into_iter().next().ok_or_else(|| anyhow!("no on-screen app window; call list_windows and pass window_id"))
}

fn parse_windows(value: &Value) -> Vec<WindowTarget> {
    match value {
        Value::Array(items) => items.iter().flat_map(parse_windows).collect(),
        Value::Object(map) => {
            if let Some(windows) = map.get("windows") {
                return parse_windows(windows);
            }
            let Some(window_id) = json_i64(map.get("window_id")).or_else(|| json_i64(map.get("id"))) else {
                return Vec::new();
            };
            let Some(pid) = json_i64(map.get("pid")) else {
                return Vec::new();
            };
            let bounds = map.get("bounds").and_then(Value::as_object);
            vec![WindowTarget {
                pid,
                window_id,
                app_name: json_string(map.get("app_name")).or_else(|| json_string(map.get("app"))).unwrap_or_default(),
                title: json_string(map.get("title")).or_else(|| json_string(map.get("window_title"))).unwrap_or_default(),
                width: json_i64(map.get("width")).or_else(|| bounds.and_then(|bounds| json_i64(bounds.get("width")))).unwrap_or(0),
                height: json_i64(map.get("height")).or_else(|| bounds.and_then(|bounds| json_i64(bounds.get("height")))).unwrap_or(0),
            }]
        }
        _ => Vec::new(),
    }
}

fn is_desktop_dump(window: &WindowTarget) -> bool {
    let app = window.app_name.to_lowercase();
    let title = window.title.to_lowercase();
    if app.contains("xfdesktop") || app.contains("xfce4-panel") || app == "plank" {
        return true;
    }
    (title == "desktop" || app.contains("desktop")) && window.width >= 800 && window.height >= 600
}

fn refuse_full_desktop(window: &WindowTarget) -> Result<()> {
    if is_desktop_dump(window) || (window.width >= 1800 && window.height >= 1000 && window.title.eq_ignore_ascii_case("desktop")) {
        bail!("full-desktop dumps are disabled; pass a window_id from list_windows");
    }
    Ok(())
}

fn filter_listed_windows(value: Value, app: Option<&str>) -> Value {
    let Some(app) = app.map(str::trim).filter(|app| !app.is_empty()) else {
        return value;
    };
    let needle = app.to_lowercase();
    let mut clone = value;
    let Some(windows) = clone.get_mut("windows").and_then(Value::as_array_mut) else {
        return clone;
    };
    windows.retain(|window| {
        json_string(window.get("app_name"))
            .or_else(|| json_string(window.get("title")))
            .is_some_and(|name| name.to_lowercase().contains(&needle))
    });
    clone
}

fn parse_window_id(window_id: Option<&str>) -> Result<i64> {
    parse_optional_window_id(window_id)?
        .ok_or_else(|| anyhow!("capture needs window_id or app from list_windows; full-desktop dumps are disabled"))
}

fn parse_optional_window_id(window_id: Option<&str>) -> Result<Option<i64>> {
    let Some(window_id) = window_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    window_id.parse::<i64>().map(Some).map_err(|_| anyhow!("window_id must be the integer from list_windows"))
}

fn json_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_owned())
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64().or_else(|| number.as_u64().map(|value| value as i64)),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn json_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned)
}

fn deserialize_opt_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(json_id(Option::<Value>::deserialize(deserializer)?.as_ref()))
}

fn deserialize_opt_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(json_i64(Option::<Value>::deserialize(deserializer)?.as_ref()))
}

fn target_point(pid: Option<i64>, window_id: Option<i64>, x: f64, y: f64) -> Value {
    let mut input = json!({ "x": x, "y": y });
    assign_target(&mut input, pid, window_id);
    input
}

fn assign_target(input: &mut Value, pid: Option<i64>, window_id: Option<i64>) {
    if let Some(pid) = pid {
        input["pid"] = json!(pid);
    }
    if let Some(window_id) = window_id {
        input["window_id"] = json!(window_id);
    }
}

async fn probe_status(settings: &Settings) -> ComputerUseStatus {
    let enabled = settings.computer_use.enabled;
    let binary = resolve_binary(&settings.computer_use);
    let attached = if enabled && binary.is_some() {
        ProviderKind::ALL.into_iter().filter(|kind| *kind != ProviderKind::Codex).collect()
    } else {
        Vec::new()
    };
    let Some(path) = binary else {
        return ComputerUseStatus {
            enabled,
            installed: false,
            binary: settings.computer_use.binary.clone(),
            version: None,
            ready: false,
            attached_harnesses: attached,
            message: missing_binary_message(&settings.computer_use),
        };
    };
    let version = version_of(&path).await;
    let doctor = run_cua(&path, &["doctor", "--json"], DOCTOR_TIMEOUT).await;
    let ready = doctor.as_ref().is_ok_and(|output| output.status.success());
    let message = if !enabled {
        "Computer use is disabled in settings. Codex still uses its bundled Computer Use plugin.".into()
    } else if ready {
        format!(
            "Cua Driver is ready at {}. Claude, OpenCode, Pi, OMP, and Cursor get computer_use. Codex keeps @Computer Use.",
            path.display()
        )
    } else {
        let detail = doctor.as_ref().map(output_text).unwrap_or_else(|error| error.to_string());
        format!("Cua Driver is installed but not ready. {}. {}", bounded_text(&detail, 400), platform_next_step())
    };
    ComputerUseStatus {
        enabled,
        installed: true,
        binary: Some(path.display().to_string()),
        version,
        ready,
        attached_harnesses: attached,
        message,
    }
}

async fn version_of(binary: &Path) -> Option<String> {
    let output = run_cua(binary, &["--version"], Duration::from_secs(4)).await.ok()?;
    let line = String::from_utf8_lossy(&output.stdout).lines().next()?.trim().to_owned();
    (!line.is_empty()).then_some(line)
}

async fn call_cua(binary: &Path, tool: &str, arguments: &Value) -> Result<Value> {
    let output = run_cua(binary, &["call", tool, &arguments.to_string()], CALL_TIMEOUT).await?;
    if !output.status.success() {
        let detail = output_text(&output);
        bail!("Cua Driver could not run `{tool}`. {}. {}", bounded_text(&detail, 500), platform_next_step());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(json!({ "ok": true }));
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => Ok(value),
        Err(_) => Ok(json!({ "text": bounded_text(trimmed, MAX_TEXT_BYTES) })),
    }
}

async fn run_cua(binary: &Path, args: &[&str], timeout: Duration) -> Result<std::process::Output> {
    let mut command = Command::new(binary);
    command.args(args);
    command.env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "false");
    command.env("CUA_DRIVER_RS_UPDATE_CHECK", "false");
    command.stdin(std::process::Stdio::null());
    tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| anyhow!("cua-driver timed out. {}", platform_next_step()))?
        .map_err(|error| anyhow!("could not start cua-driver: {error}. {}", platform_next_step()))
}

fn platform_next_step() -> &'static str {
    if cfg!(target_os = "macos") {
        "Open CuaDriver.app, grant Accessibility and Screen Recording, then retry."
    } else if cfg!(target_os = "windows") {
        "Run Kybern on an interactive desktop, not Session 0 or SSH, then retry."
    } else {
        "Install libxi6 and at-spi2-core, run `cua-driver serve` in a graphical session, then retry."
    }
}

fn output_text(output: &std::process::Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stderr).into_owned();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&output.stdout).into_owned();
    }
    text
}

fn compact_cua_payload(raw: &Value) -> Value {
    if let Some(content) = raw.get("content").and_then(Value::as_array) {
        let texts: Vec<_> = content
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    return None;
                }
                block.get("text").and_then(Value::as_str).map(|text| bounded_text(text, MAX_TEXT_BYTES))
            })
            .collect();
        if texts.len() == 1 {
            if let Ok(parsed) = serde_json::from_str::<Value>(&texts[0]) {
                return parsed;
            }
            return json!(texts[0]);
        }
        if !texts.is_empty() {
            return json!(texts.join("\n"));
        }
    }
    let mut clone = raw.clone();
    if let Some(object) = clone.as_object_mut() {
        object.remove("content");
    }
    clone
}

fn bound_screenshot_from_cua(raw: &Value) -> Result<Option<BoundedScreenshot>> {
    let Some(bytes) = first_image_bytes(raw) else { return Ok(None) };
    Ok(Some(bound_screenshot(&bytes)?))
}

fn first_image_bytes(raw: &Value) -> Option<Vec<u8>> {
    if let Some(content) = raw.get("content").and_then(Value::as_array) {
        for block in content {
            if block.get("type").and_then(Value::as_str) != Some("image") {
                continue;
            }
            if let Some(data) = block.get("data").and_then(Value::as_str) {
                return decode_image_bytes(data);
            }
        }
    }
    if let Some(data) = raw.pointer("/screenshot/data").and_then(Value::as_str) {
        return decode_image_bytes(data);
    }
    if let Some(data) = raw.get("screenshot_png_b64").and_then(Value::as_str) {
        return decode_image_bytes(data);
    }
    if let Some(path) = raw.get("screenshot_file_path").and_then(Value::as_str) {
        return std::fs::read(path).ok().filter(|bytes| !bytes.is_empty());
    }
    None
}

fn decode_image_bytes(data: &str) -> Option<Vec<u8>> {
    let payload = data.strip_prefix("data:").and_then(|rest| rest.split_once(',')).map(|(_, payload)| payload).unwrap_or(data);
    base64::engine::general_purpose::STANDARD.decode(payload.trim()).ok()
}

pub(crate) fn bound_screenshot(bytes: &[u8]) -> Result<BoundedScreenshot> {
    ensure!(!bytes.is_empty(), "screenshot was empty");
    let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(32 * 1024 * 1024u64);
    reader.limits(limits);
    let image = reader.decode()?;
    let scaled = if image.width() > MAX_SCREENSHOT_EDGE || image.height() > MAX_SCREENSHOT_EDGE {
        image.thumbnail(MAX_SCREENSHOT_EDGE, MAX_SCREENSHOT_EDGE)
    } else {
        image
    };
    let mut quality = 48u8;
    let mut encoded = encode_jpeg(&scaled, quality)?;
    while encoded.len() > MAX_SCREENSHOT_BYTES && quality > 24 {
        quality = quality.saturating_sub(8);
        encoded = encode_jpeg(&scaled, quality)?;
    }
    if encoded.len() > MAX_SCREENSHOT_BYTES {
        let tighter = scaled.thumbnail(640, 640);
        encoded = encode_jpeg(&tighter, 24)?;
        ensure!(encoded.len() <= MAX_SCREENSHOT_BYTES, "screenshot is still too large after compression; capture a smaller window");
        return Ok(BoundedScreenshot {
            mime: "image/jpeg".into(),
            data: base64::engine::general_purpose::STANDARD.encode(&encoded),
            width: tighter.width(),
            height: tighter.height(),
        });
    }
    Ok(BoundedScreenshot {
        mime: "image/jpeg".into(),
        data: base64::engine::general_purpose::STANDARD.encode(&encoded),
        width: scaled.width(),
        height: scaled.height(),
    })
}

fn encode_jpeg(image: &image::DynamicImage, quality: u8) -> Result<Vec<u8>> {
    let rgb = image.to_rgb8();
    let mut out = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    encoder.encode(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)?;
    Ok(out.into_inner())
}

fn screenshot_hash(data: &str) -> String {
    let digest = Sha256::digest(data.as_bytes());
    format!("{:x}", u64::from_be_bytes(digest[..8].try_into().expect("sha256 is 32 bytes")))
}

fn bounded_text(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use kybern_protocol::ComputerUseSettings;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let source = DynamicImage::ImageRgba8(RgbaImage::from_pixel(width, height, Rgba([12, 34, 56, 255])));
        let mut out = Cursor::new(Vec::new());
        source.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn compound_tool_is_tight_and_single() {
        let tool = tool_definition();
        assert_eq!(tool.name, "computer_use");
        assert!(tool.description.len() <= MAX_DESCRIPTION_CHARS, "{}", tool.description.len());
        assert!(!tool.description.to_lowercase().contains("hermes"));
        let schema = &tool.input_schema;
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["action"]));
        let actions = schema["properties"]["action"]["enum"].as_array().unwrap();
        assert!(actions.iter().all(|value| value.as_str().unwrap().len() <= 12));
        assert_eq!(actions.len(), 10);
        assert!(schema.to_string().len() < 900);
    }

    #[test]
    fn screenshots_downscale_compress_and_skip_unchanged_payloads() {
        let huge = bound_screenshot(&png_bytes(1800, 1200)).unwrap();
        assert_eq!(huge.mime, "image/jpeg");
        assert!(huge.width <= MAX_SCREENSHOT_EDGE && huge.height <= MAX_SCREENSHOT_EDGE);
        let decoded = base64::engine::general_purpose::STANDARD.decode(&huge.data).unwrap();
        assert!(decoded.len() <= MAX_SCREENSHOT_BYTES);
        assert!(decoded.len() < png_bytes(1800, 1200).len());
        let runtime = ComputerUseRuntime::new();
        let thread = uuid::Uuid::nil();
        assert!(!runtime.mark_screenshot(thread, screenshot_hash(&huge.data)));
        assert!(runtime.mark_screenshot(thread, screenshot_hash(&huge.data)));
        let mcp = mcp_result(
            json!({
                "ok": true,
                "action": "capture",
                "screenshot": { "mime": huge.mime, "data": huge.data, "width": huge.width, "height": huge.height }
            }),
            false,
        );
        assert_eq!(mcp["content"][0]["type"], "text");
        assert!(!mcp["content"][0]["text"].as_str().unwrap().contains(&huge.data));
        assert_eq!(mcp["content"][1]["type"], "image");
        assert_eq!(mcp["content"][1]["mimeType"], "image/jpeg");
        let png = png_bytes(32, 24);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        assert_eq!(first_image_bytes(&json!({ "screenshot_png_b64": b64 })), Some(png.clone()));
        let path = std::env::temp_dir().join(format!("kybern-cua-shot-{}.png", Uuid::now_v7()));
        std::fs::write(&path, &png).unwrap();
        assert_eq!(first_image_bytes(&json!({ "screenshot_file_path": path.display().to_string() })), Some(png));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn permission_modes_do_not_silently_click_in_supervised() {
        assert!(needs_host_approval(PermissionMode::Supervised, Action::Click));
        assert!(needs_host_approval(PermissionMode::AcceptEdits, Action::Type));
        assert!(!needs_host_approval(PermissionMode::Supervised, Action::Capture));
        assert!(!needs_host_approval(PermissionMode::Auto, Action::Click));
        assert!(!needs_host_approval(PermissionMode::FullAccess, Action::Click));
    }

    #[test]
    fn codex_never_attaches_cua_even_when_the_binary_exists() {
        let mut settings = Settings {
            computer_use: ComputerUseSettings { enabled: true, binary: Some(std::env::current_exe().unwrap().display().to_string()) },
            ..Default::default()
        };
        assert!(!should_attach(ProviderKind::Codex, &settings));
        assert!(should_attach(ProviderKind::ClaudeCode, &settings));
        assert!(should_attach(ProviderKind::Opencode, &settings));
        assert!(should_attach(ProviderKind::Pi, &settings));
        assert!(should_attach(ProviderKind::Omp, &settings));
        assert!(should_attach(ProviderKind::Cursor, &settings));
        let names: Vec<_> = native_tools_for(ProviderKind::Codex, &settings).into_iter().map(|tool| tool.name).collect();
        assert!(!names.iter().any(|name| name == TOOL_NAME));
        let names: Vec<_> = native_tools_for(ProviderKind::ClaudeCode, &settings).into_iter().map(|tool| tool.name).collect();
        assert!(names.iter().any(|name| name == TOOL_NAME));
        settings.computer_use.enabled = false;
        assert!(!should_attach(ProviderKind::ClaudeCode, &settings));
    }

    #[test]
    fn capture_refuses_full_desktop_dumps() {
        let error = cua_calls(&parse_args(json!({ "action": "capture" })).unwrap()).unwrap_err();
        assert!(error.to_string().contains("window_id or app") || error.to_string().contains("pid"));
        let error = cua_calls(&parse_args(json!({ "action": "capture", "app": "Finder" })).unwrap()).unwrap_err();
        assert!(error.to_string().contains("window_id or app") || error.to_string().contains("pid"));
        let capture = cua_calls(&parse_args(json!({ "action": "capture", "pid": 99, "window_id": 27262979 })).unwrap()).unwrap();
        assert_eq!(capture[0].0, "get_window_state");
        assert_eq!(capture[0].1["window_id"], 27262979);
        assert_eq!(capture[0].1["pid"], 99);
        assert_eq!(capture[0].1["include_screenshot"], true);
        assert_eq!(capture[0].1["include_accessibility_tree"], false);
        assert_eq!(
            parse_windows(&json!({ "windows": [{ "pid": 8, "window_id": 11 }, { "pid": 9, "window_id": 12 }] }))
                .into_iter()
                .map(|window| window.window_id)
                .collect::<Vec<_>>(),
            vec![11, 12]
        );
        assert_eq!(json_id(Some(&json!("w1"))), Some("w1".into()));
        let parsed = parse_args(json!({ "action": "capture", "window_id": 27262979, "pid": 4 })).unwrap();
        assert_eq!(parsed.window_id.as_deref(), Some("27262979"));
        assert_eq!(parsed.pid, Some(4));
        let click = cua_calls(&parse_args(json!({ "action": "click", "x": 10, "y": 20, "pid": 8, "window_id": 11 })).unwrap()).unwrap();
        assert_eq!(click[0].0, "click");
        assert_eq!(click[0].1["x"], 10.0);
        assert_eq!(click[0].1["pid"], 8);
        assert_eq!(click[0].1["window_id"], 11);
        assert!(click[0].1.get("app_id").is_none());
        let listed = cua_calls(&parse_args(json!({ "action": "list_windows", "app": "Mousepad" })).unwrap()).unwrap();
        assert_eq!(listed[0].0, "list_windows");
        assert!(listed[0].1.get("app_id").is_none());
        assert!(is_desktop_dump(&WindowTarget {
            pid: 1,
            window_id: 2,
            app_name: "Xfdesktop".into(),
            title: "Desktop".into(),
            width: 1920,
            height: 1200,
        }));
    }

    #[test]
    fn missing_binary_says_what_to_do_next() {
        let message = missing_binary_message(&ComputerUseSettings { enabled: true, binary: None });
        assert!(message.contains(INSTALL_URL));
        assert!(message.contains("kybern computer-use"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cua_call_uses_one_shot_cli_without_polling() {
        let root = std::env::temp_dir().join(format!("kybern-cua-stub-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        let stub = root.join("cua-driver");
        std::fs::write(
            &stub,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "cua-driver 0.0.0-test"; exit 0; fi
if [ "$1" = "doctor" ]; then echo '{"ok":true}'; exit 0; fi
if [ "$1" = "call" ]; then
  echo '{"content":[{"type":"text","text":"{\"ok\":true,\"tool\":\"'"$2"'\"}"}]}'
  exit 0
fi
exit 1
"#,
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut settings = Settings::default();
        settings.computer_use.binary = Some(stub.display().to_string());
        let runtime = ComputerUseRuntime::new();
        let listed = runtime.perform(&settings, Uuid::nil(), &parse_args(json!({ "action": "list_apps" })).unwrap()).await.unwrap();
        assert_eq!(listed["cua"]["tool"], "list_apps");
        let status = runtime.status(&settings).await;
        assert!(status.installed);
        assert!(status.ready);
        assert!(!status.attached_harnesses.contains(&ProviderKind::Codex));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "needs DISPLAY, cua-driver serve, and a real window"]
    async fn live_cua_lists_and_captures_a_real_window() {
        let binary = which::which("cua-driver").expect("cua-driver on PATH");
        let mut settings = Settings::default();
        settings.computer_use.binary = Some(binary.display().to_string());
        let runtime = ComputerUseRuntime::new();
        let listed = runtime.perform(&settings, Uuid::nil(), &parse_args(json!({ "action": "list_windows" })).unwrap()).await.unwrap();
        assert!(listed["cua"].get("windows").and_then(Value::as_array).is_some_and(|windows| !windows.is_empty()), "{listed}");
        let captured = runtime
            .perform(&settings, Uuid::nil(), &parse_args(json!({ "action": "capture", "app": "Xfce4-terminal" })).unwrap())
            .await
            .expect("window-only capture via Kybern computer_use");
        assert_eq!(captured["ok"], true, "{captured}");
        assert_eq!(captured["screenshot"]["mime"], "image/jpeg");
        let data = captured["screenshot"]["data"].as_str().expect("bounded jpeg");
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap();
        assert!(bytes.len() > 32 && bytes.len() <= MAX_SCREENSHOT_BYTES);
        assert!(captured["cua"].get("window_id").is_some());
        assert_ne!(captured["cua"]["app_name"], "Xfdesktop");
    }
}
