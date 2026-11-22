//! Grok Build driver: ACP over stdio (`grok agent stdio`).
//!
//! Uses the official `agent-client-protocol` crate, same as the Cursor ACP path.
//!
//! Seen from a real `grok` 1.0.92 (`grok --help`, `grok agent --help`, and `initialize` /
//! `session/new` without a login):
//! - `--permission-mode <default|acceptEdits|auto|dontAsk|bypassPermissions|plan>` and
//!   `--no-auto-update` are top-level options; `--always-approve` belongs to `agent`.
//! - `initialize` answers `promptCapabilities.image: true`, `loadSession: true`, and
//!   `_meta.modelState` with each model's `totalContextTokens` and `reasoningEfforts`.
//! - Grok reads `GROK_HOME` (it wrote its `config.toml`, `sessions/` and `logs/` there).
//! - `session/new` while signed out fails with `-32000 Authentication required`.
//!
//! Grok's own extension methods (`x.ai/…`, `_x.ai/…`) and the shapes of their params come from
//! T3 Code's Grok provider (`packages/provider-grok`), not from a recorded `grok` session; they are
//! marked "(T3 Code)" where they are used.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, ContentBlock, HttpHeader, ImageContent, Implementation, InitializeRequest, LoadSessionRequest,
    McpServer, McpServerHttp, Meta, NewSessionRequest, PermissionOption, PermissionOptionKind, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, StopReason as AcpStop, TextContent, ToolCallUpdateFields, ToolKind,
};
use agent_client_protocol::{
    Agent, ByteStreams, Client, ConnectionTo, Handled, Responder, UntypedMessage, on_receive_notification, on_receive_request,
};
use async_trait::async_trait;
use kybern_protocol::process::NoWindow;
use kybern_protocol::rpc::{Problem, ProblemAction, ProblemKind};
use kybern_protocol::*;
use serde_json::{Map, Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::binary::{at_least, resolve, version_of};
use crate::{AgentDriver, AgentSession, DriverError, DriverEvent, NativeToolBridge, ProbeContext, Result, SessionConfig, SpawnedSession};

/// Minimum Grok Build version that ships a stable `agent stdio` ACP mode.
const MIN_VERSION: (u64, u64, u64) = (0, 2, 0);

/// Keeps every short-lived `grok` (`--version`, `models`, `--help`) from starting Grok's updater.
/// Sessions also pass `--no-auto-update`.
pub const DISABLE_AUTOUPDATER: (&str, &str) = ("GROK_DISABLE_AUTOUPDATER", "1");

/// How long a resumed session's replay may stay quiet before the load counts as done. Grok can leave
/// `session/load` unanswered after it has replayed the conversation (T3 Code, 52b04b947e).
const LOAD_REPLAY_IDLE: Duration = Duration::from_secs(2);
/// The longest Kybern waits for `session/load` (or a quiet replay) before giving up.
const LOAD_TIMEOUT: Duration = Duration::from_secs(90);

/// How long Grok has to answer a Stop or Close before the turn ends as interrupted without it.
const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// A session's waits. Tests shorten them through the session's env (`KYBERN_TEST_GROK_*_MS`), since a
/// real `grok` child runs on real time.
#[derive(Debug, Clone, Copy)]
struct Timings {
    replay_idle: Duration,
    cancel_grace: Duration,
}

#[cfg(test)]
const TEST_REPLAY_IDLE_MS: &str = "KYBERN_TEST_GROK_REPLAY_IDLE_MS";
#[cfg(test)]
const TEST_CANCEL_GRACE_MS: &str = "KYBERN_TEST_GROK_CANCEL_GRACE_MS";

impl Timings {
    fn for_session(config: &SessionConfig) -> Self {
        let timings = Self { replay_idle: LOAD_REPLAY_IDLE, cancel_grace: CANCEL_GRACE };
        #[cfg(test)]
        let timings = {
            let ms = |key: &str| config.env.get(key).and_then(|ms| ms.parse().ok()).map(Duration::from_millis);
            Self {
                replay_idle: ms(TEST_REPLAY_IDLE_MS).unwrap_or(timings.replay_idle),
                cancel_grace: ms(TEST_CANCEL_GRACE_MS).unwrap_or(timings.cancel_grace),
            }
        };
        #[cfg(not(test))]
        let _ = config;
        timings
    }
}

/// JSON-RPC error code Grok uses for a usage limit (T3 Code, `xAiRateLimitedErrorCode`).
const RATE_LIMITED: i32 = -32003;

/// Grok's only session-scoped "allow always" option; its other allow-always options save a grant
/// for the whole project (T3 Code, `grokApprovalOptions`).
const ALLOW_EDITS_SESSION: &str = "allow-edits-session";

pub struct GrokDriver;

impl GrokDriver {
    async fn probe_inner(&self, context: &ProbeContext) -> ProviderStatus {
        let kind = self.kind();
        let mut status = ProviderStatus {
            kind,
            display_name: kind.display_name().into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            // Supervised and Accept edits launch Grok with `--permission-mode default` and answer its
            // `session/request_permission` (Kybern accepts workspace edits itself in Accept edits); Auto
            // is xAI's own classifier, which asks only for what it refuses; Full access is `--always-approve`.
            supported_permission_modes: PermissionMode::ALL.to_vec(),
            supports_fork: false,
            // The model is chosen at session start (setSessionConfigOption); `set_model` is not wired, so no live switch.
            supports_model_switch: false,
            supports_effort_switch: false,
            supported_efforts: vec![],
            models: vec![],
            instances: vec!["default".into()],
        };

        let bin = match resolve(kind, context.binary.as_ref()) {
            Ok(b) => b,
            Err(e) => {
                status.unavailable_reason = Some(format!("{e}. {}", install_hint()));
                return status;
            }
        };
        status.binary_path = Some(bin.display().to_string());

        match version_of(&bin, &["--version"]).await {
            Some(v) => {
                let ok = at_least(&v, MIN_VERSION);
                status.available = ok;
                status.version = Some(v.clone());
                if !ok {
                    status.unavailable_reason =
                        Some(format!("Grok Build {v} is older than the required {}.{}.{}", MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2));
                }
                if ok {
                    status.models = discover_models(&bin, context).await;
                }
            }
            None => {
                status.unavailable_reason = Some("could not run `grok --version`".into());
            }
        }
        status
    }
}

/// Best-effort model list. Falls back to empty if the command is missing or fails.
async fn discover_models(bin: &std::path::Path, context: &ProbeContext) -> Vec<ProviderModel> {
    let mut cmd = Command::new(bin).no_window();
    cmd.args(["models"]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    if let Some(cwd) = &context.cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in &context.env {
        cmd.env(k, v);
    }
    cmd.env(DISABLE_AUTOUPDATER.0, DISABLE_AUTOUPDATER.1);
    if let Some(grok_home) = grok_home_for_child(context.env.get("GROK_HOME").map(String::as_str)) {
        cmd.env("GROK_HOME", grok_home);
    }

    let output = tokio::time::timeout(std::time::Duration::from_secs(8), crate::process_tree::output(&mut cmd))
        .await
        .ok()
        .and_then(|r| r.ok())
        .filter(|o| o.status.success());

    let Some(output) = output else { return Vec::new() };
    parse_models(&String::from_utf8_lossy(&output.stdout))
}

/// `GROK_HOME` with a leading `~` expanded, from the provider's own environment or else the daemon's,
/// when it needs expanding: `grok` does not expand it itself.
fn grok_home_for_child(configured: Option<&str>) -> Option<PathBuf> {
    let inherited = std::env::var("GROK_HOME").ok();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    crate::binary::grok_home_override(home.as_deref(), configured.or(inherited.as_deref()))
}

/// How to get Grok Build when it is not installed. The shell installer is for macOS and Linux only.
fn install_hint() -> &'static str {
    if cfg!(windows) {
        "Install Grok Build from https://x.ai/cli, then restart Kybern."
    } else {
        "Install Grok Build: https://x.ai/cli (or `curl -fsSL https://x.ai/cli/install.sh | bash`)"
    }
}

/// The models in `grok models` output: one per line, the id first and anything after it (a
/// "(default)" marker, a description) optional. Headings, blank lines and separators are skipped.
fn parse_models(text: &str) -> Vec<ProviderModel> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let starred = line.starts_with(['*', '>', '•']);
            let line = line.trim_start_matches(['*', '>', '•', '-', ' ']);
            let (id, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
            let id = id.trim_matches(['`', ',']);
            let first = id.chars().next()?;
            // Model ids look like `grok-4` or `grok-code-fast-1`; "Available models:" or "MODEL" do not.
            if !first.is_ascii_alphanumeric() || id.ends_with(':') || !id.contains(['-', '.']) && !id.chars().any(|c| c.is_ascii_digit()) {
                return None;
            }
            let rest = rest.trim();
            let marked_default = starred || rest.to_ascii_lowercase().contains("default");
            let description = rest.trim_matches(|c: char| c.is_whitespace() || matches!(c, '-' | '–' | '—' | ':')).to_string();
            Some(ProviderModel {
                id: id.to_string(),
                display_name: id.to_string(),
                resolved_id: None,
                description: (!description.is_empty()).then_some(description),
                provider: Some("xai".into()),
                efforts: vec![],
                default_effort: None,
                is_default: marked_default || id.contains("grok-build"),
                parameters: vec![],
                variants: vec![],
            })
        })
        .collect()
}

#[async_trait]
impl AgentDriver for GrokDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::GrokBuild
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        self.probe_inner(&ProbeContext { binary: binary.cloned(), ..ProbeContext::default() }).await
    }

    async fn probe_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        self.probe_inner(context).await
    }

    async fn list_sessions(
        &self,
        _context: &ProbeContext,
        _cursor: Option<&str>,
        _query: &str,
    ) -> Result<kybern_protocol::methods::SessionsListResult> {
        Ok(kybern_protocol::methods::SessionsListResult { sessions: vec![], next_cursor: None })
    }

    async fn read_session(&self, _context: &ProbeContext, _id: &str) -> Result<crate::sessions::SessionHistory> {
        Err(DriverError::Unsupported("Grok Build session history is not implemented yet".into()))
    }

    async fn open_session_reader(&self, _context: &ProbeContext) -> Result<Box<dyn crate::sessions::SessionReader>> {
        Err(DriverError::Unsupported("Grok Build session reader is not implemented yet".into()))
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        let bin = resolve(ProviderKind::GrokBuild, config.binary.as_ref())?;
        let (events_tx, events_rx) = mpsc::channel(1024);
        let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(64);
        let (bound_tx, bound_rx) = oneshot::channel::<Result<String>>();

        // Grok has no system channel: a new conversation carries Kybern's guide (and a
        // Coordinator's lead instructions) on its first ordinary prompt. A resumed one that
        // already holds it gets nothing; one that never received it gets it once.
        let guide = match (&config.resume_session_id, config.resume_lacks_instructions) {
            (None, _) | (Some(_), true) => config.native_tool_bridge.as_ref().and_then(|bridge| bridge.provider_instructions()),
            (Some(_), false) => None,
        };

        let stderr_tail = Arc::new(std::sync::Mutex::new(String::new()));
        let (stderr_closed_tx, mut stderr_closed) = tokio::sync::watch::channel(false);
        let shared = Arc::new(Shared {
            events: events_tx.clone(),
            pending: Mutex::new(HashMap::new()),
            mode: config.permission_mode,
            cwd: config.cwd.clone(),
        });
        let worker_shared = shared.clone();
        let worker_stderr = stderr_tail.clone();
        let cfg = config.clone();
        let worker = crate::process_tree::SessionTask(tokio::spawn(async move {
            let outcome = run_connection(bin, cfg, worker_shared, cmd_rx, bound_tx, worker_stderr, stderr_closed_tx).await;
            let error = outcome.err().map(|e| e.to_string());
            let _ = events_tx.send(DriverEvent::Exited { code: None, error }).await;
        }));

        match bound_rx.await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                stderr_settled(&mut stderr_closed).await;
                return Err(startup_exit_error(&stderr_tail));
            }
        }
        Ok(SpawnedSession {
            session: Box::new(Handle { commands: cmd_tx, _worker: worker, guide: Mutex::new(guide), shared }),
            events: events_rx,
        })
    }
}

/// What a card Kybern raised for Grok waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ask {
    /// `session/request_permission`.
    Permission,
    /// `x.ai/ask_user_question`, shown as a question card.
    Question,
    /// `x.ai/exit_plan_mode`, shown as a plan to start implementing.
    Plan,
}

struct Shared {
    events: mpsc::Sender<DriverEvent>,
    /// Open cards: Kybern's request id -> what it asks and where the answer goes.
    pending: Mutex<HashMap<String, (Ask, oneshot::Sender<ApprovalDecision>)>>,
    mode: PermissionMode,
    cwd: PathBuf,
}

impl Shared {
    /// Raise a card and return where its answer arrives. A dropped sender (the turn ended) reads as no answer.
    async fn ask(&self, kind: Ask, event: impl FnOnce(String) -> DriverEvent) -> oneshot::Receiver<ApprovalDecision> {
        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), (kind, tx));
        let _ = self.events.send(event(request_id)).await;
        rx
    }

    /// The turn ended: Grok no longer waits for any open card.
    async fn withdraw_all(&self) {
        let open: Vec<String> = self.pending.lock().await.drain().map(|(id, _)| id).collect();
        for request_id in open {
            let _ = self.events.send(DriverEvent::PermissionWithdrawn { request_id }).await;
        }
    }
}

enum SessionCommand {
    Prompt { blocks: Vec<ContentBlock> },
    Cancel,
    Close,
}

struct Handle {
    _worker: crate::process_tree::SessionTask,
    commands: mpsc::Sender<SessionCommand>,
    /// Kybern's guide, until the first prompt that can carry it is sent.
    guide: Mutex<Option<String>>,
    shared: Arc<Shared>,
}

/// `grok`'s arguments for a permission mode. `--permission-mode` on the command line overrides Grok's
/// own config, so Supervised never inherits an `always-approve` the user set there (T3 Code,
/// `grokAcpSpawnArgs`). A launch `acceptEdits` behaves like ask in `grok agent` (T3 Code), so Accept
/// edits launches as Supervised and Kybern accepts the workspace edits itself.
fn launch_args(mode: PermissionMode) -> Vec<&'static str> {
    let mut args = vec!["--no-auto-update"];
    match mode {
        PermissionMode::FullAccess => args.extend(["agent", "--always-approve", "stdio"]),
        PermissionMode::Auto => args.extend(["--permission-mode", "auto", "agent", "stdio"]),
        PermissionMode::Supervised | PermissionMode::AcceptEdits => args.extend(["--permission-mode", "default", "agent", "stdio"]),
    }
    args
}

/// `initialize`'s `_meta`. A `generic` client (Grok's default) has Auto's refusals denied silently;
/// an `extension` client is asked, and gets no persistent command grants (T3 Code, `GROK_ACP_INITIALIZE_META`).
fn initialize_meta() -> Meta {
    let mut meta = Meta::new();
    meta.insert("clientType".into(), json!("extension"));
    meta
}

/// The answer Kybern gives without asking, if any: everything in Full access (Grok should not ask
/// there), and an edit inside the workspace in Accept edits. Auto's requests are xAI's classifier
/// refusing something, so they always reach the user.
fn auto_decision(mode: PermissionMode, fields: &ToolCallUpdateFields, cwd: &Path) -> Option<ApprovalDecision> {
    match mode {
        PermissionMode::FullAccess => Some(ApprovalDecision::AllowOnce),
        PermissionMode::AcceptEdits if is_workspace_edit(fields, cwd) => Some(ApprovalDecision::AllowOnce),
        _ => None,
    }
}

/// An edit, delete or move whose every named path lies inside `cwd`: each of its `locations` and each
/// path its `raw_input` names. A move counts only when its destination was found and checked, since its
/// `locations` name the source alone. A request that names no path, or one outside the workspace, still asks.
fn is_workspace_edit(fields: &ToolCallUpdateFields, cwd: &Path) -> bool {
    let Some(kind) = fields.kind.filter(|kind| matches!(kind, ToolKind::Edit | ToolKind::Delete | ToolKind::Move)) else {
        return false;
    };
    let mut paths: Vec<PathBuf> = fields.locations.iter().flatten().map(|location| location.path.clone()).collect();
    let named = fields.raw_input.as_ref().map(input_paths).unwrap_or_default();
    if kind == ToolKind::Move && !named.iter().any(|named| named.destination) {
        return false;
    }
    paths.extend(named.into_iter().map(|named| PathBuf::from(named.text)));
    !paths.is_empty() && paths.iter().all(|path| inside_workspace(path, cwd))
}

/// Parts of a key that mark its value as a path: `file_path`, `targetDir`, `new_location`, `outputUri`.
/// Matched anywhere in the key, so an unlisted spelling still counts; a false match only makes a
/// relative value be checked as a path too.
const PATH_KEY_PARTS: &[&str] =
    &["path", "file", "dir", "folder", "uri", "url", "location", "dest", "target", "output", "source", "src", "name", "from"];

/// `file_path`, `filePath` and `FilePath` alike.
fn normalized_key(key: &str) -> String {
    key.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

/// A key (normalized) whose value is a path. `to` counts as a whole key or a key's end (`to`, `moveTo`),
/// since inside a word it is too common (`total`, `token`).
fn is_path_key(key: &str) -> bool {
    PATH_KEY_PARTS.iter().any(|part| key.contains(part)) || key.ends_with("to")
}

/// A path key (normalized) that names where a move puts the file.
fn is_destination_key(key: &str) -> bool {
    ["dest", "target", "output"].iter().any(|part| key.contains(part)) || key.starts_with("new") || key.ends_with("to")
}

/// A path a tool's input names.
#[derive(Debug)]
struct NamedPath {
    text: String,
    /// It sits under a key that names a move's destination.
    destination: bool,
}

/// Every path a tool's input names, at any depth. A string is a path when it sits under a path key, at
/// any depth below it (`{"file": {"value": "x"}}`, `{"paths": ["a", "b"]}`), or when it looks like an
/// absolute or home path under any key at all: an unknown key must not carry a write out of the workspace.
fn input_paths(input: &Value) -> Vec<NamedPath> {
    fn walk(value: &Value, path: bool, destination: bool, out: &mut Vec<NamedPath>) {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    let key = normalized_key(key);
                    let is_path = is_path_key(&key);
                    walk(value, path || is_path, destination || (is_path && is_destination_key(&key)), out);
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, path, destination, out)),
            Value::String(text) => {
                let text = text.trim();
                if !text.is_empty() && (path || looks_like_path(text)) {
                    out.push(NamedPath { text: text.to_owned(), destination: path && destination });
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(input, false, false, &mut out);
    out
}

/// A string under no path key that still reads as an absolute path, a home path or a `file:` URI. Text
/// over several lines is content, not a path, and so is a one-line code comment (`// x`, `/* x */`),
/// which as a path would only name a folder at the root whose name starts with a space or `*`.
fn looks_like_path(text: &str) -> bool {
    if text.contains(['\n', '\r']) {
        return false;
    }
    let comment = text.strip_prefix("//").is_some_and(|rest| rest.starts_with(char::is_whitespace)) || text.starts_with("/*");
    let bytes = text.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\');
    !comment && (text.starts_with(['/', '\\', '~']) || drive || text.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:")))
}

/// A path whose meaning Kybern can't settle without expanding or interpreting it the way some other
/// program might: `~` and environment variables (`$HOME`, `%USERPROFILE%`), URIs (`file:///etc`), Windows
/// verbatim, device and UNC prefixes (`\\?\`, `\\.\`, `\\server`), and drive-relative paths (`C:foo`).
fn needs_interpretation(text: &str) -> bool {
    if text.starts_with('~') || text.contains('$') || text.starts_with(r"\\") || has_percent_variable(text) {
        return true;
    }
    if cfg!(windows) && text.starts_with("//") {
        return true;
    }
    // `scheme:` as URIs spell it. One letter is a drive: only `C:\` and `C:/` on Windows are plain paths.
    let scheme = text.find(':').map(|colon| &text[..colon]).filter(|scheme| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    });
    match scheme {
        Some(scheme) if scheme.len() == 1 => !(cfg!(windows) && text[2..].starts_with(['/', '\\'])),
        Some(_) => true,
        None => false,
    }
}

/// `%NAME%`, as Windows expands it.
fn has_percent_variable(text: &str) -> bool {
    let parts: Vec<&str> = text.split('%').collect();
    // Only the parts with a `%` on both sides can be names.
    parts.len() >= 3
        && parts[1..parts.len() - 1]
            .iter()
            .any(|name| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '(' | ')')))
}

/// A `.git` folder or file, which holds hooks and config that run code later. Windows drops trailing dots
/// and spaces and ignores case, so `.GIT.` is the same name there.
fn is_git_dir(component: Component<'_>) -> bool {
    matches!(component, Component::Normal(name) if name.to_string_lossy().trim_end_matches(['.', ' ']).eq_ignore_ascii_case(".git"))
}

/// Whether `path` (relative to `cwd`, or absolute) is inside `cwd` once every symlink on the way is followed.
/// The workspace folder itself and anything in a `.git` folder don't count: deleting the root or writing a
/// hook is not an ordinary edit. Nor does a path that needs expanding or interpreting first.
///
/// This checks the file system as it is now. A symlink created between this check and Grok's write
/// can't be prevented here; Accept edits trusts the workspace's own contents that far.
fn inside_workspace(path: &Path, cwd: &Path) -> bool {
    if needs_interpretation(&path.to_string_lossy()) {
        return false;
    }
    let path = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return false;
    }
    let (Some(path), Ok(root)) = (canonical_existing(&path, 0), cwd.canonicalize()) else {
        return false;
    };
    match path.strip_prefix(&root) {
        Ok(rest) => rest.components().next().is_some() && !rest.components().any(is_git_dir),
        Err(_) => false,
    }
}

/// How many symlinks `canonical_existing` follows before it gives up (the usual `MAXSYMLINKS`).
const MAX_SYMLINKS: usize = 40;

/// `path` with every symlink resolved: its nearest existing ancestor made canonical, with the names that
/// don't exist yet appended. A dangling symlink counts where it points, so a write through it is checked
/// against its target. `None` when that can't be worked out safely (a link loop, an unreadable folder).
fn canonical_existing(path: &Path, links: usize) -> Option<PathBuf> {
    let mut missing = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if let Ok(found) = current.canonicalize() {
            return Some(missing.iter().rev().fold(found, |path: PathBuf, part| path.join(part)));
        }
        match std::fs::symlink_metadata(&current) {
            // A dangling link: follow it, from the folder it sits in, and resolve the rest from there.
            Ok(meta) if meta.file_type().is_symlink() => {
                if links >= MAX_SYMLINKS {
                    return None;
                }
                let target = std::fs::read_link(&current).ok()?;
                let target = if target.is_absolute() { target } else { current.parent()?.join(target) };
                let target = missing.iter().rev().fold(target, |path: PathBuf, part| path.join(part));
                return canonical_existing(&target, links + 1);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            // It exists but can't be resolved (permissions, a file used as a folder): don't guess.
            _ => return None,
        }
        let name = match current.components().next_back()? {
            Component::Normal(name) => name.to_owned(),
            // A `..` from a link's target: step back lexically, which the canonical parent then resolves.
            Component::ParentDir => return canonical_parent_dir(&current, &missing, links),
            _ => return None,
        };
        missing.push(name);
        current = current.parent()?.to_path_buf();
    }
}

/// `current` ends in `..` and doesn't exist: resolve what's before it, step up, and add the missing names.
fn canonical_parent_dir(current: &Path, missing: &[std::ffi::OsString], links: usize) -> Option<PathBuf> {
    let before = current.parent()?;
    let resolved = canonical_existing(before, links)?;
    let up = resolved.parent()?.to_path_buf();
    Some(missing.iter().rev().fold(up, |path, part| path.join(part)))
}

/// Grok's option for a Kybern decision, or `None` when it offers none that grants exactly that. Allow
/// for this thread takes `allow-edits-session` only (else allows once); Grok's other allow-always
/// options would save a project grant that outlives the thread. Allow once never widens to a session
/// grant. Deny rejects.
fn permission_option<'a>(options: &'a [PermissionOption], decision: &ApprovalDecision) -> Option<&'a PermissionOption> {
    let of_kind = |kind: PermissionOptionKind| options.iter().find(|option| option.kind == kind);
    let edits_session = || options.iter().find(|option| option.option_id.0.trim() == ALLOW_EDITS_SESSION);
    match decision {
        ApprovalDecision::AllowOnce => of_kind(PermissionOptionKind::AllowOnce),
        ApprovalDecision::AllowAlways => edits_session().or_else(|| of_kind(PermissionOptionKind::AllowOnce)),
        ApprovalDecision::Deny { .. } | ApprovalDecision::Submit { .. } => {
            of_kind(PermissionOptionKind::RejectOnce).or_else(|| of_kind(PermissionOptionKind::RejectAlways))
        }
    }
}

/// What Kybern tells Grok for a decision, and the notice to show when Grok offered nothing that matches
/// it. A decision Grok can't take is declined (rejected once, else cancelled), never widened; no answer
/// (the turn ended) cancels.
fn permission_response(options: &[PermissionOption], decision: Option<&ApprovalDecision>) -> (RequestPermissionResponse, Option<String>) {
    let selected = |option: &PermissionOption| {
        RequestPermissionResponse::new(RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option.option_id.clone())))
    };
    let cancelled = || RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
    let Some(decision) = decision else { return (cancelled(), None) };
    if let Some(option) = permission_option(options, decision) {
        return (selected(option), None);
    }
    match decision {
        ApprovalDecision::AllowOnce => {
            let decline = permission_option(options, &ApprovalDecision::Deny { reason: None });
            let notice = "Grok Build couldn't allow this just once, so Kybern declined it. To let it run, choose Allow for this thread when it asks again.";
            (decline.map_or_else(cancelled, selected), Some(notice.into()))
        }
        _ => (cancelled(), None),
    }
}

/// The answer Kybern sends without showing a card, if any. Full access takes Grok's narrowest allow
/// option; Accept edits allows a workspace edit once, and asks when Grok can't allow it just once.
fn auto_response(
    mode: PermissionMode,
    fields: &ToolCallUpdateFields,
    cwd: &Path,
    options: &[PermissionOption],
) -> Option<RequestPermissionResponse> {
    let decision = auto_decision(mode, fields, cwd)?;
    let option = permission_option(options, &decision).or_else(|| match mode {
        PermissionMode::FullAccess => permission_option(options, &ApprovalDecision::AllowAlways),
        _ => None,
    })?;
    Some(RequestPermissionResponse::new(RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option.option_id.clone()))))
}

/// Grok's extension requests Kybern answers (T3 Code, `XAiAskUserQuestionRequest`,
/// `XAiExitPlanModeRequest`). Both come plain or wrapped as `{method, params}`.
#[derive(Debug, Clone, PartialEq)]
enum XaiRequest {
    AskUserQuestion { tool_call_id: Option<String>, questions: Vec<Value> },
    ExitPlanMode { tool_call_id: Option<String>, plan: Option<String> },
}

impl XaiRequest {
    fn parse(method: &str, params: &Value) -> Option<Self> {
        let params = params.get("params").filter(|_| params.get("method").is_some()).unwrap_or(params);
        let tool_call_id = params.get("toolCallId").and_then(Value::as_str).map(str::to_owned);
        match method.trim_start_matches('_') {
            "x.ai/ask_user_question" => Some(Self::AskUserQuestion {
                tool_call_id,
                questions: params.get("questions").and_then(Value::as_array).cloned().unwrap_or_default(),
            }),
            "x.ai/exit_plan_mode" => Some(Self::ExitPlanMode {
                tool_call_id,
                plan: params.get("planContent").and_then(Value::as_str).map(str::trim).filter(|plan| !plan.is_empty()).map(str::to_owned),
            }),
            _ => None,
        }
    }

    /// The card Kybern shows: a question in the `AskUserQuestion` shape every client already reads, or
    /// the plan in the `ExitPlanMode` shape Claude's plan approvals use.
    fn card(&self, request_id: String) -> DriverEvent {
        match self {
            Self::AskUserQuestion { tool_call_id, questions } => {
                let questions: Vec<Value> = questions
                    .iter()
                    .filter_map(|question| {
                        let text = question.get("question").and_then(Value::as_str)?;
                        let options: Vec<Value> = question
                            .get("options")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|option| {
                                let label = option.get("label").and_then(Value::as_str)?;
                                let mut out = json!({ "label": label });
                                for key in ["description", "preview"] {
                                    if let Some(value) = option.get(key).and_then(Value::as_str) {
                                        out[key] = json!(value);
                                    }
                                }
                                Some(out)
                            })
                            .collect();
                        Some(json!({
                            "question": text,
                            "options": options,
                            "multiSelect": question.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                        }))
                    })
                    .collect();
                let summary =
                    questions.first().and_then(|question| question["question"].as_str()).unwrap_or("Answer Grok's question").to_string();
                DriverEvent::PermissionRequest {
                    request_id,
                    tool_call_id: tool_call_id.clone(),
                    tool_name: "AskUserQuestion".into(),
                    input: json!({ "questions": questions }),
                    summary,
                    suggestions: vec![],
                }
            }
            Self::ExitPlanMode { tool_call_id, plan } => DriverEvent::PermissionRequest {
                request_id,
                tool_call_id: tool_call_id.clone(),
                tool_name: "ExitPlanMode".into(),
                input: plan.as_ref().map(|plan| json!({ "plan": plan })).unwrap_or_else(|| json!({})),
                summary: "Start implementing this plan?".into(),
                suggestions: vec![],
            },
        }
    }

    /// Grok's response to the user's decision.
    fn response(&self, decision: Option<ApprovalDecision>) -> Value {
        match self {
            Self::AskUserQuestion { questions, .. } => match decision {
                Some(ApprovalDecision::Submit { response }) => xai_answers(questions, &response),
                _ => json!({ "outcome": "cancelled" }),
            },
            Self::ExitPlanMode { .. } => match decision {
                Some(ApprovalDecision::AllowOnce | ApprovalDecision::AllowAlways) => json!({ "outcome": "approved" }),
                Some(ApprovalDecision::Deny { reason: Some(reason) }) if !reason.trim().is_empty() => {
                    json!({ "outcome": "request_changes", "feedback": reason.trim() })
                }
                _ => json!({
                    "outcome": "abandoned",
                    "feedback": "The user chose to keep planning. Stop here and wait for their feedback in a later message.",
                }),
            },
        }
    }
}

/// An `AskUserQuestion` answer (`{answers: {question: label | [labels]}, annotations}`) in xAI's shape:
/// `{outcome: "accepted", answers: {question: [labels]}, annotations: {question: {preview, notes}}}`.
/// Text that is not one of the question's options goes under "Other", with the text as a note (T3 Code,
/// `makeXAiAskUserQuestionResponse`).
fn xai_answers(questions: &[Value], response: &Value) -> Value {
    let mut answers = Map::new();
    let mut annotations = Map::new();
    for question in questions {
        let Some(text) = question.get("question").and_then(Value::as_str) else { continue };
        let values: Vec<String> = match response.pointer("/answers").and_then(|answers| answers.get(text)) {
            Some(Value::String(value)) => vec![value.clone()],
            Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
            _ => Vec::new(),
        };
        let values: Vec<String> = values.into_iter().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty()).collect();
        if values.is_empty() {
            continue;
        }
        let labels: Vec<&str> =
            question.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(|o| o.get("label")?.as_str()).collect();
        let (chosen, custom): (Vec<String>, Vec<String>) = values.into_iter().partition(|value| labels.contains(&value.as_str()));
        let mut note =
            response.pointer("/annotations").and_then(|notes| notes.get(text)).and_then(Value::as_object).cloned().unwrap_or_default();
        if !custom.is_empty() {
            let mut notes: Vec<String> = custom;
            if let Some(existing) = note.get("notes").and_then(Value::as_str) {
                notes.push(existing.to_owned());
            }
            note.insert("notes".into(), json!(notes.join("\n")));
        }
        answers.insert(text.to_owned(), json!(if chosen.is_empty() { vec!["Other".to_owned()] } else { chosen }));
        if !note.is_empty() {
            annotations.insert(text.to_owned(), Value::Object(note));
        }
    }
    let mut out = json!({ "outcome": "accepted", "answers": answers });
    if !annotations.is_empty() {
        out["annotations"] = Value::Object(annotations);
    }
    out
}

/// Grok said a prompt finished without answering `session/prompt` (T3 Code, `xaiAcpExtension.ts`):
/// `x.ai/session/prompt_complete {sessionId, promptId, stopReason, agentResult}`, or a `turn_completed`
/// update on `x.ai/session_notification`. A background wake (`task-completed-…`) is not a prompt.
#[derive(Debug, Clone, PartialEq)]
struct PromptComplete {
    prompt_id: Option<String>,
    stop_reason: Option<String>,
    agent_result: Option<Value>,
}

fn prompt_complete(method: &str, params: &Value) -> Option<PromptComplete> {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
    match method.trim_start_matches('_') {
        "x.ai/session/prompt_complete" => Some(PromptComplete {
            prompt_id: text(params.get("promptId")),
            stop_reason: text(params.get("stopReason")),
            agent_result: params.get("agentResult").filter(|value| !value.is_null()).cloned(),
        }),
        "x.ai/session_notification" | "x.ai/session/update" => {
            let update = params.get("update")?;
            if update.get("sessionUpdate").and_then(Value::as_str) != Some("turn_completed") {
                return None;
            }
            // Only a turn that names its prompt: background completions and other turns do not settle ours.
            let prompt_id = text(update.get("prompt_id")).or_else(|| text(update.get("promptId")))?;
            if prompt_id.starts_with("task-completed-") {
                return None;
            }
            Some(PromptComplete {
                prompt_id: Some(prompt_id),
                stop_reason: text(update.get("stop_reason")).or_else(|| text(update.get("stopReason"))),
                agent_result: update.get("agent_result").filter(|value| !value.is_null()).cloned(),
            })
        }
        _ => None,
    }
}

fn stop_reason(acp: AcpStop) -> StopReason {
    match acp {
        AcpStop::EndTurn => StopReason::Completed,
        AcpStop::MaxTokens => StopReason::MaxTurns,
        AcpStop::MaxTurnRequests => StopReason::MaxTurns,
        AcpStop::Cancelled => StopReason::Interrupted,
        _ => StopReason::Completed,
    }
}

/// Grok's `agentResult` as the words for a failed turn, and all of it for details. A result that isn't
/// text is JSON: its `message` (or `error`) string is the words when it has one.
fn agent_result_text(result: Option<&Value>) -> (Option<String>, Option<String>) {
    let plain = |text: &str| Some(text.trim().to_owned()).filter(|text| !text.is_empty());
    match result {
        None => (None, None),
        Some(Value::String(text)) => (plain(text), plain(text)),
        Some(other) => {
            let message = ["/message", "/error", "/error/message", "/detail"]
                .iter()
                .find_map(|pointer| other.pointer(pointer).and_then(Value::as_str))
                .and_then(plain);
            (message, Some(other.to_string()))
        }
    }
}

/// The turn's end from Grok's own completion notice.
fn completion_event(complete: &PromptComplete, duration_ms: u64) -> DriverEvent {
    let (words, detail) = agent_result_text(complete.agent_result.as_ref());
    let stop = match complete.stop_reason.as_deref() {
        Some("rate_limit") => {
            let error = words.unwrap_or_else(|| "Grok Build reached its usage limit.".into());
            let problem = crate::failure::rate_limited_problem(ProviderKind::GrokBuild, detail.as_deref().unwrap_or(&error));
            return DriverEvent::TurnFailed { error, problem: Some(problem) };
        }
        Some("error") => {
            let error = words.unwrap_or_else(|| "Grok Build ended the turn with an error.".into());
            let detail = detail.unwrap_or_else(|| "x.ai/session/prompt_complete: stopReason \"error\" without an agentResult".into());
            let problem = crate::failure::classify(ProviderKind::GrokBuild, &detail).unwrap_or_else(|| {
                Problem::new(ProblemKind::Internal, detail)
                    .with_subject("grok")
                    .with_copy(
                        "Grok Build ended the turn with an error",
                        "Send your message again. If it keeps happening, copy the details and report them.",
                    )
                    .with_action(ProblemAction::retry("Try again"))
            });
            return DriverEvent::TurnFailed { error, problem: Some(problem) };
        }
        Some("cancelled") => StopReason::Interrupted,
        Some("max_tokens" | "max_turn_requests") => StopReason::MaxTurns,
        _ => StopReason::Completed,
    };
    DriverEvent::TurnCompleted { stop_reason: stop, usage: Usage::default(), cost_usd: None, duration_ms, anchors: Default::default() }
}

fn usage_limit_failure(error: String) -> DriverEvent {
    let problem = Some(crate::failure::rate_limited_problem(ProviderKind::GrokBuild, &error));
    DriverEvent::TurnFailed { error, problem }
}

/// A failed `session/prompt`: `-32003` is a usage limit whatever its text says.
fn prompt_failure(error: &agent_client_protocol::Error) -> DriverEvent {
    if i32::from(error.code) == RATE_LIMITED {
        return usage_limit_failure(error.to_string());
    }
    DriverEvent::turn_failed(ProviderKind::GrokBuild, error.to_string())
}

/// How much of the end of `grok`'s stderr is kept to explain a startup failure.
const STDERR_TAIL_BYTES: usize = 600;

/// How long a failed start waits for `grok`'s stderr to close, so a `grok` that quit has said why.
const STDERR_SETTLE: Duration = Duration::from_secs(1);

fn remember_stderr(tail: &std::sync::Mutex<String>, line: &str) {
    let Ok(mut tail) = tail.lock() else { return };
    if !tail.is_empty() {
        tail.push('\n');
    }
    tail.push_str(line.trim_end());
    if tail.len() > STDERR_TAIL_BYTES {
        let mut cut = tail.len() - STDERR_TAIL_BYTES;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail.drain(..cut);
    }
}

fn stderr_text(tail: &std::sync::Mutex<String>) -> String {
    tail.lock().map(|t| t.trim().to_string()).unwrap_or_default()
}

/// Wait (briefly) until `grok`'s stderr has closed, which it does once `grok` has quit.
async fn stderr_settled(closed: &mut tokio::sync::watch::Receiver<bool>) {
    let _ = tokio::time::timeout(STDERR_SETTLE, closed.wait_for(|closed| *closed)).await;
}

/// The step of a session start that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Startup {
    /// `grok` quit before it answered anything.
    Launch,
    Initialize,
    NewSession,
    Resume,
    /// `session/load` got no answer and no replay in time.
    ResumeTimedOut,
}

/// `clap`'s words for an option it doesn't know: this `grok` predates a flag Kybern passes
/// (`--permission-mode`, `--no-auto-update`).
fn rejects_arguments(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    ["unexpected argument", "unrecognized option", "unrecognized argument", "unknown argument", "unknown option"]
        .iter()
        .any(|needle| lower.contains(needle))
        || lower.contains("found argument") && lower.contains("wasn't expected")
}

/// What a failed start means: an outdated `grok`, a cause `failure::classify` names (signed out, offline,
/// a usage limit), or else the step that failed. `detail` is the technical text, kept for Show details.
/// Only `grok`'s own `stderr` while it launches or initializes can say it rejected an option: an error a
/// later request answers with (`session/new`, `session/load`) is about that request, whatever its words.
fn startup_problem(step: Startup, detail: &str, stderr: &str) -> Problem {
    let kind = ProviderKind::GrokBuild;
    if matches!(step, Startup::Launch | Startup::Initialize) && rejects_arguments(stderr) {
        return crate::failure::update_needed_problem(kind, detail);
    }
    if let Some(problem) = crate::failure::classify(kind, detail) {
        return problem;
    }
    const CHECK: &str = "Check that Grok Build is signed in (run `grok login`), then try again.";
    let (title, hint) = match step {
        Startup::Launch => ("Grok Build quit while starting", CHECK),
        Startup::Initialize => ("Grok Build didn't start", CHECK),
        Startup::NewSession => ("Grok Build couldn't start a conversation", CHECK),
        Startup::Resume => ("Grok Build couldn't reopen this conversation", "Try again, or start a new thread if it keeps happening."),
        Startup::ResumeTimedOut => (
            "Grok Build didn't reopen this conversation",
            "It didn't answer in time. Try again, or start a new thread if it keeps happening.",
        ),
    };
    Problem::new(ProblemKind::Internal, detail).with_subject("grok").with_copy(title, hint).with_action(ProblemAction::retry("Try again"))
}

/// `grok` quit before the session was bound; its stderr says why.
fn startup_exit_error(tail: &std::sync::Mutex<String>) -> DriverError {
    let stderr = stderr_text(tail);
    let detail = if stderr.is_empty() {
        "grok agent exited during startup".to_string()
    } else {
        format!("grok agent exited during startup: {stderr}")
    };
    DriverError::problem(startup_problem(Startup::Launch, &detail, &stderr))
}

/// Fail the session start: the caller of `spawn` gets `problem`, not just "exited during startup".
fn fail_startup(bound: &mut Option<oneshot::Sender<Result<String>>>, problem: Problem) -> agent_client_protocol::Error {
    let detail = problem.detail.clone().unwrap_or_default();
    if let Some(b) = bound.take() {
        let _ = b.send(Err(DriverError::problem(problem)));
    }
    agent_client_protocol::Error::from(anyhow::anyhow!(detail))
}

/// Attach Kybern MCP tools the same way Cursor does. Refuse if enforcement is required.
fn grok_mcp_servers(bridge: Option<&NativeToolBridge>) -> Result<Vec<McpServer>> {
    let Some(bridge) = bridge else { return Ok(Vec::new()) };
    bridge.validate()?;
    if bridge.restrictions.require_enforcement {
        return Err(DriverError::Unsupported(
            "Grok Build ACP can attach Kybern MCP tools but cannot enforce coordinator tool restrictions at the native boundary".into(),
        ));
    }
    let endpoint = bridge
        .endpoint
        .as_deref()
        .ok_or_else(|| DriverError::Unsupported("Grok Build Kybern tools require a daemon MCP endpoint".into()))?;
    let authorization = bridge
        .authorization
        .as_deref()
        .ok_or_else(|| DriverError::Unsupported("Grok Build Kybern tools require a scoped MCP authorization capability".into()))?;
    Ok(vec![McpServer::Http(
        McpServerHttp::new(bridge.server_name.clone(), endpoint.to_string())
            .headers(vec![HttpHeader::new("Authorization", format!("Bearer {authorization}"))]),
    )])
}

/// The tool's name: Grok's own (`_meta["x.ai/tool"].name`, e.g. `read_file`), else the ACP kind
/// (when it says something), else the call's title.
fn tool_name(kind: &ToolKind, title: &str, meta: Option<&Meta>) -> String {
    if let Some(name) = meta
        .and_then(|meta| meta.get("x.ai/tool"))
        .and_then(|tool| tool.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return name.to_string();
    }
    let kind = serde_json::to_value(kind).ok().and_then(|kind| kind.as_str().map(str::to_string));
    if let Some(kind) = kind.filter(|kind| kind != "other") {
        return kind;
    }
    let title = title.trim();
    if title.is_empty() { "other".into() } else { title.to_string() }
}

/// Grok runs every MCP tool through its `use_tool` built-in with `{tool_name: "<server>__<tool>",
/// tool_input}` (T3 Code, 3c9a54979a). Such a call is the MCP tool itself: `mcp__<server>__<tool>`,
/// with the tool's own arguments.
fn mcp_call(name: &str, raw_input: Option<&Value>) -> Option<(String, Value)> {
    if name != "use_tool" {
        return None;
    }
    let raw = raw_input?;
    let full = raw.get("tool_name").and_then(Value::as_str)?.trim();
    let (server, tool) = full.split_once("__").filter(|(server, tool)| !server.is_empty() && !tool.is_empty())?;
    let arguments = raw.get("tool_input").filter(|input| input.is_object()).cloned().unwrap_or_else(|| json!({}));
    Some((format!("mcp__{server}__{tool}"), arguments))
}

/// What a finished tool call reports. Grok wraps an MCP result as `{type: "MCP", output: {OkayOutput}
/// | {Error}}` (T3 Code); that becomes the MCP result shape other harnesses send, `{content: [{type:
/// "text", text}]}`, failed when it was an `Error`.
fn tool_output(status: Option<&str>, raw_output: Option<Value>, content: Value, title: Option<String>) -> (Value, bool) {
    let failed = status == Some("failed");
    let mcp = raw_output.as_ref().filter(|raw| raw.get("type").and_then(Value::as_str) == Some("MCP")).and_then(|raw| raw.get("output"));
    if let Some(output) = mcp {
        let (text, is_error) = match (output.get("OkayOutput").and_then(Value::as_str), output.get("Error").and_then(Value::as_str)) {
            (_, Some(error)) => (Some(error), true),
            (Some(okay), None) => (Some(okay), false),
            _ => (None, false),
        };
        if let Some(text) = text {
            let raw = json!({ "content": [{ "type": "text", "text": text }], "isError": is_error });
            return (json!({ "status": status, "raw": raw, "content": raw["content"], "title": title }), failed || is_error);
        }
    }
    (json!({ "status": status, "raw": raw_output, "content": content, "title": title }), failed)
}

/// The prompt as Grok receives it: the guide once, in front of the first ordinary request.
/// A slash command stays at the start of its prompt; the guide waits for the next ordinary one.
/// Returns the text to send and the guide it carries, if any.
fn prompt_with_guide(guide: &mut Option<String>, text: String) -> (String, Option<String>) {
    if text.trim_start().starts_with('/') {
        return (text, None);
    }
    match guide.take() {
        Some(guide) => (crate::cursor::with_guide(&guide, &text), Some(guide)),
        None => (text, None),
    }
}

/// A user message as ACP blocks. Text parts run together into one text block, as before; an image is
/// its own image block (`grok` 1.0.92 advertises `promptCapabilities.image`, and T3 Code found Grok takes
/// images even where it says otherwise). A skill is Grok's own `/name` command, which Grok expands only
/// at the start of a prompt.
fn prompt_blocks(message: &UserMessage) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let mut text = String::new();
    let flush = |text: &mut String, blocks: &mut Vec<ContentBlock>| {
        if !text.is_empty() {
            blocks.push(ContentBlock::Text(TextContent::new(std::mem::take(text))));
        }
    };
    for part in &message.parts {
        match part {
            ContentPart::Text { text: t } => text.push_str(t),
            ContentPart::FileMention { path } => text.push_str(&format!("@{path}")),
            ContentPart::ThreadReference { thread_id, title, .. } => text.push_str(&thread_reference_text(*thread_id, title)),
            ContentPart::Skill { name, .. } => text.push_str(&format!("/{name}")),
            ContentPart::Mention { name, .. } => text.push_str(&format!("@{name}")),
            ContentPart::Image { media_type, data } => {
                flush(&mut text, &mut blocks);
                blocks.push(ContentBlock::Image(ImageContent::new(data.clone(), media_type.clone())));
            }
            ContentPart::Attachment { name, .. } => text.push_str(&format!("[attached file: {name}]")),
            ContentPart::Media { .. } => text.push_str("[image]"),
            ContentPart::ThreadMessage { .. } | ContentPart::AgentResults { .. } | ContentPart::SystemRow { .. } => {
                if let Some(flat) = part.orchestration_text() {
                    text.push_str(&flat);
                }
            }
        }
    }
    flush(&mut text, &mut blocks);
    blocks
}

/// Put the guide in front of the prompt's first text (or before an image-only prompt). Returns the guide it carries.
fn blocks_with_guide(guide: &mut Option<String>, mut blocks: Vec<ContentBlock>) -> (Vec<ContentBlock>, Option<String>) {
    match blocks.first_mut() {
        Some(ContentBlock::Text(first)) => {
            let (text, carried) = prompt_with_guide(guide, std::mem::take(&mut first.text));
            first.text = text;
            (blocks, carried)
        }
        _ => match guide.take() {
            Some(text) => {
                blocks.insert(0, ContentBlock::Text(TextContent::new(crate::cursor::with_guide(&text, ""))));
                (blocks, Some(text))
            }
            None => (blocks, None),
        },
    }
}

/// How a `session/load` wait ended.
#[derive(Debug, PartialEq)]
enum LoadOutcome<T> {
    /// Grok answered.
    Answered(T),
    /// Grok replayed the conversation and then went quiet without answering.
    ReplayIdle,
    TimedOut,
}

/// Wait for `load`, but count it done once a replay has started and been quiet for `idle_gap`; give up after `timeout`.
async fn await_session_load<T>(
    load: impl std::future::Future<Output = T>,
    last_replay: &std::sync::Mutex<Option<tokio::time::Instant>>,
    idle_gap: Duration,
    timeout: Duration,
) -> LoadOutcome<T> {
    let mut load = std::pin::pin!(load);
    let mut deadline = std::pin::pin!(tokio::time::sleep(timeout));
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            answered = &mut load => return LoadOutcome::Answered(answered),
            _ = &mut deadline => return LoadOutcome::TimedOut,
            _ = tick.tick() => {
                let quiet = last_replay.lock().ok().and_then(|last| *last).is_some_and(|last| last.elapsed() >= idle_gap);
                if quiet {
                    return LoadOutcome::ReplayIdle;
                }
            }
        }
    }
}

/// How a prompt's wait ended.
struct Settled {
    event: DriverEvent,
    /// Kybern closed the session (or dropped its handle) meanwhile: stop once this turn has ended.
    close: bool,
}

/// Wait for one prompt to end. `answer` is its `session/prompt` response, already as the turn's end.
/// Grok's own completion notice settles it only when it names this `prompt_id`: a notice without one, a
/// late one for an earlier prompt or a background task's wake would end this turn early and leave its
/// real output with no turn open. Cancel cancels; Close, or a closed command channel, cancels once and
/// is not polled again. After the first cancel Grok has `grace` to answer; then the turn ends as
/// interrupted anyway, so a Grok that ignores the cancel can't hold the turn (or, after Close, its
/// process) open.
async fn settle_prompt(
    answer: impl std::future::Future<Output = DriverEvent>,
    prompt_id: &str,
    started: std::time::Instant,
    completions: &mut mpsc::UnboundedReceiver<PromptComplete>,
    commands: &mut mpsc::Receiver<SessionCommand>,
    grace: Duration,
    mut cancel: impl FnMut(),
) -> Settled {
    let mut answer = std::pin::pin!(answer);
    let mut close = false;
    let mut cancelled = false;
    let mut deadline = std::pin::pin!(tokio::time::sleep(grace));
    loop {
        tokio::select! {
            event = &mut answer => return Settled { event, close },
            Some(complete) = completions.recv() => {
                if complete.prompt_id.as_deref() == Some(prompt_id) {
                    return Settled { event: completion_event(&complete, started.elapsed().as_millis() as u64), close };
                }
            }
            () = &mut deadline, if cancelled => {
                let duration_ms = started.elapsed().as_millis() as u64;
                let event = DriverEvent::TurnCompleted {
                    stop_reason: StopReason::Interrupted,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms,
                    anchors: Default::default(),
                };
                return Settled { event, close };
            }
            command = commands.recv(), if !close => {
                match command {
                    Some(SessionCommand::Cancel) => cancel(),
                    Some(SessionCommand::Close) | None => {
                        cancel();
                        close = true;
                    }
                    Some(SessionCommand::Prompt { .. }) => continue,
                }
                if !cancelled {
                    cancelled = true;
                    deadline.as_mut().reset(tokio::time::Instant::now() + grace);
                }
            }
        }
    }
}

async fn run_connection(
    bin: PathBuf,
    config: SessionConfig,
    shared: Arc<Shared>,
    mut commands: mpsc::Receiver<SessionCommand>,
    bound: oneshot::Sender<Result<String>>,
    stderr_tail: Arc<std::sync::Mutex<String>>,
    stderr_closed_tx: tokio::sync::watch::Sender<bool>,
) -> Result<()> {
    let mut bound = Some(bound);
    let timings = Timings::for_session(&config);
    // Checked before `grok` starts, so a refused bridge costs no process.
    let native_mcp_servers = match grok_mcp_servers(config.native_tool_bridge.as_ref()) {
        Ok(servers) => servers,
        Err(error) => {
            let message = error.to_string();
            if let Some(b) = bound.take() {
                let _ = b.send(Err(error));
            }
            return Err(DriverError::Protocol(message));
        }
    };

    let mut cmd = Command::new(&bin).no_window();
    cmd.args(launch_args(config.permission_mode))
        .current_dir(&config.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in &config.env {
        cmd.env(k, v);
    }
    cmd.env(DISABLE_AUTOUPDATER.0, DISABLE_AUTOUPDATER.1);
    if let Some(grok_home) = grok_home_for_child(config.env.get("GROK_HOME").map(String::as_str)) {
        cmd.env("GROK_HOME", grok_home);
    }
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            // The caller gets the reason itself (a missing or busy binary), not "exited during startup".
            let message = error.to_string();
            if let Some(b) = bound.take() {
                let _ = b.send(Err(DriverError::Io(error)));
            }
            return Err(DriverError::Protocol(message));
        }
    };
    let _tree = crate::process_tree::ProcessTree::new(child.id().expect("spawned grok"));
    let stdin = child.stdin.take().ok_or_else(|| DriverError::Protocol("no stdin".into()))?;
    let stdout = child.stdout.take().ok_or_else(|| DriverError::Protocol("no stdout".into()))?;
    let mut stderr_closed = stderr_closed_tx.subscribe();
    if let Some(stderr) = child.stderr.take() {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                tracing::debug!(target: "provider.stderr", "{l}");
                remember_stderr(&tail, &l);
            }
            let _ = stderr_closed_tx.send(true);
        });
    }
    let agent = ByteStreams::new(stdin.compat_write(), stdout.compat());
    let _child_guard = child;

    let cwd = config.cwd.clone();
    let events = shared.events.clone();
    let shared_perm = shared.clone();
    let shared_ext = shared.clone();

    let msg_state: Arc<Mutex<(u64, bool)>> = Arc::new(Mutex::new((0, false)));
    let msg_state_notif = msg_state.clone();
    // `session/load` replays the whole conversation as updates; those are history, not new output.
    // Their arrival times tell when the replay has gone quiet.
    let loading = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let loading_notif = loading.clone();
    let last_replay: Arc<std::sync::Mutex<Option<tokio::time::Instant>>> = Arc::new(std::sync::Mutex::new(None));
    let last_replay_notif = last_replay.clone();
    // Grok's own "this prompt is done" notices, for a prompt whose RPC never answers.
    let (completions_tx, mut completions) = mpsc::unbounded_channel::<PromptComplete>();

    let result = Client
        .builder()
        .name("kybern")
        .on_receive_notification(
            async move |n: SessionNotification, _cx| {
                if loading_notif.load(std::sync::atomic::Ordering::Relaxed) {
                    if let Ok(mut last) = last_replay_notif.lock() {
                        *last = Some(tokio::time::Instant::now());
                    }
                    // Commands and context usage are the session's state, not its history.
                    if !matches!(n.update, SessionUpdate::AvailableCommandsUpdate(_) | SessionUpdate::UsageUpdate(_)) {
                        return Ok(());
                    }
                }
                let ev = &events;
                match n.update {
                    SessionUpdate::AgentMessageChunk(c) => {
                        if let ContentBlock::Text(t) = c.content {
                            let id = {
                                let mut s = msg_state_notif.lock().await;
                                if !s.1 {
                                    s.0 += 1;
                                    s.1 = true;
                                }
                                format!("m{}", s.0)
                            };
                            let _ = ev.send(DriverEvent::TextDelta { message_id: id, origin: EventOrigin::Root, delta: t.text }).await;
                        }
                    }
                    SessionUpdate::AgentThoughtChunk(c) => {
                        if let ContentBlock::Text(t) = c.content {
                            let id = {
                                let mut s = msg_state_notif.lock().await;
                                if !s.1 {
                                    s.0 += 1;
                                    s.1 = true;
                                }
                                format!("m{}", s.0)
                            };
                            let _ = ev.send(DriverEvent::ThinkingDelta { message_id: id, origin: EventOrigin::Root, delta: t.text }).await;
                        }
                    }
                    SessionUpdate::ToolCall(tc) => {
                        msg_state_notif.lock().await.1 = false;
                        let name = tool_name(&tc.kind, &tc.title, tc.meta.as_ref());
                        let (name, input) = match mcp_call(&name, tc.raw_input.as_ref()) {
                            Some(call) => call,
                            None => (name, json!({ "title": tc.title, "raw": tc.raw_input })),
                        };
                        let _ = ev.send(DriverEvent::ToolStarted(ToolCall { id: tc.tool_call_id.to_string(), name, input, parent_id: None })).await;
                    }
                    SessionUpdate::ToolCallUpdate(u) => {
                        let status = u.fields.status.map(|s| format!("{s:?}").to_lowercase());
                        if matches!(status.as_deref(), Some("completed") | Some("failed")) {
                            let content = serde_json::to_value(&u.fields.content).unwrap_or(Value::Null);
                            let (output, is_error) = tool_output(status.as_deref(), u.fields.raw_output, content, u.fields.title);
                            let _ = ev.send(DriverEvent::ToolCompleted { tool_call_id: u.tool_call_id.to_string(), output, is_error }).await;
                        }
                    }
                    SessionUpdate::AvailableCommandsUpdate(update) => {
                        let _ = ev.send(command_update(update)).await;
                    }
                    SessionUpdate::UsageUpdate(u) => {
                        let context = Some(ContextUsage { used_tokens: u.used, window_tokens: u.size });
                        let _ = ev.send(DriverEvent::UsageUpdated(ProviderUsage { context, limits: None, prompt_cache: None })).await;
                    }
                    _ => {}
                }
                Ok(())
            },
            on_receive_notification!(),
        )
        .on_receive_notification(
            async move |n: UntypedMessage, _cx| {
                if let Some(complete) = prompt_complete(&n.method, &n.params) {
                    let _ = completions_tx.send(complete);
                }
                // Grok's other extension notices (setup phases, MCP status, background tasks) are not used yet.
                Ok(())
            },
            on_receive_notification!(),
        )
        .on_receive_request(
            async move |req: RequestPermissionRequest, responder, cx: ConnectionTo<Agent>| {
                let shared = shared_perm.clone();
                if let Some(response) = auto_response(shared.mode, &req.tool_call.fields, &shared.cwd, &req.options) {
                    return responder.respond(response);
                }
                let fields = &req.tool_call.fields;
                let title = fields.title.clone().unwrap_or_default();
                let name = tool_name(&fields.kind.unwrap_or(ToolKind::Other), &title, req.tool_call.meta.as_ref());
                let (name, raw) = match mcp_call(&name, fields.raw_input.as_ref()) {
                    Some((name, arguments)) => (name, Some(arguments)),
                    None => (name, fields.raw_input.clone()),
                };
                let options: Vec<Value> = req
                    .options
                    .iter()
                    .map(|o| json!({ "id": o.option_id.to_string(), "name": o.name, "kind": serde_json::to_value(o.kind).unwrap_or(Value::Null) }))
                    .collect();
                let input = json!({ "title": title, "raw": raw, "locations": fields.locations, "options": options });
                let rx = shared
                    .ask(Ask::Permission, |request_id| DriverEvent::PermissionRequest {
                        request_id,
                        tool_call_id: Some(req.tool_call.tool_call_id.to_string()),
                        tool_name: name,
                        input,
                        summary: title.clone(),
                        suggestions: vec![],
                    })
                    .await;
                // Wait off the dispatch loop: Grok's updates and the prompt's answer keep flowing meanwhile.
                let options = req.options;
                let events = shared.events.clone();
                cx.spawn(async move {
                    let decision = rx.await.ok();
                    let (response, notice) = permission_response(&options, decision.as_ref());
                    if let Some(text) = notice {
                        let _ = events.send(DriverEvent::Notice { level: NoticeLevel::Warning, text, data: None }).await;
                    }
                    let _ = responder.respond(response);
                    Ok(())
                })
            },
            on_receive_request!(),
        )
        .on_receive_request(
            async move |req: UntypedMessage, responder: Responder<Value>, cx: ConnectionTo<Agent>| {
                let Some(ask) = XaiRequest::parse(&req.method, &req.params) else {
                    return Ok(Handled::No { message: (req, responder), retry: false });
                };
                // Questions and plans always reach the user, whatever the permission mode.
                let kind = match ask {
                    XaiRequest::AskUserQuestion { .. } => Ask::Question,
                    XaiRequest::ExitPlanMode { .. } => Ask::Plan,
                };
                let rx = shared_ext.ask(kind, |request_id| ask.card(request_id)).await;
                cx.spawn(async move {
                    let decision = rx.await.ok();
                    let _ = responder.respond(ask.response(decision));
                    Ok(())
                })?;
                Ok(Handled::Yes)
            },
            on_receive_request!(),
        )
        .connect_with(agent, async |cx: ConnectionTo<Agent>| {
            let init = cx
                .send_request(
                    InitializeRequest::new(ProtocolVersion::V1)
                        .client_capabilities(ClientCapabilities::new())
                        .client_info(Implementation::new("kybern", env!("CARGO_PKG_VERSION")))
                        .meta(initialize_meta()),
                )
                .block_task()
                .await;
            if let Err(e) = init {
                // A `grok` that quit (an option it doesn't know, a crash) has said why on stderr.
                stderr_settled(&mut stderr_closed).await;
                let stderr = stderr_text(&stderr_tail);
                let detail = if stderr.is_empty() { format!("initialize: {e}") } else { format!("initialize: {e}\n{stderr}") };
                return Err(fail_startup(&mut bound, startup_problem(Startup::Initialize, &detail, &stderr)));
            }

            // Assume already authenticated (grok login or XAI_API_KEY). Explicit auth can be added later.
            let session_id = match &config.resume_session_id {
                Some(id) => {
                    loading.store(true, std::sync::atomic::Ordering::Relaxed);
                    let request = LoadSessionRequest::new(id.clone(), cwd.clone()).mcp_servers(native_mcp_servers.clone());
                    let loaded = await_session_load(cx.send_request(request).block_task(), &last_replay, timings.replay_idle, LOAD_TIMEOUT).await;
                    match loaded {
                        LoadOutcome::Answered(Ok(_)) => {
                            loading.store(false, std::sync::atomic::Ordering::Relaxed);
                            agent_client_protocol::schema::v1::SessionId::from(id.clone())
                        }
                        // A quiet replay only ends the wait: Grok may still be replaying, so its updates stay
                        // history until the first prompt is sent.
                        LoadOutcome::ReplayIdle => agent_client_protocol::schema::v1::SessionId::from(id.clone()),
                        // A fresh session here would silently drop the conversation, so the
                        // thread is told it could not be resumed (as Cursor's is).
                        LoadOutcome::Answered(Err(e)) => {
                            return Err(fail_startup(&mut bound, startup_problem(Startup::Resume, &format!("session/load {id}: {e}"), "")));
                        }
                        LoadOutcome::TimedOut => {
                            let detail = format!("session/load {id}: no answer or replay in {} seconds", LOAD_TIMEOUT.as_secs());
                            return Err(fail_startup(&mut bound, startup_problem(Startup::ResumeTimedOut, &detail, "")));
                        }
                    }
                }
                None => {
                    let request = NewSessionRequest::new(cwd.clone()).mcp_servers(native_mcp_servers);
                    match cx.send_request(request).block_task().await {
                        Ok(created) => created.session_id,
                        Err(e) => {
                            return Err(fail_startup(&mut bound, startup_problem(Startup::NewSession, &format!("session/new: {e}"), "")));
                        }
                    }
                }
            };

            // A model that cannot be set must not pass as the one in use: say so, and report none.
            let mut model = config.model.clone();
            let mut model_notice = None;
            if let Some(wanted) = &model {
                let set =
                    cx.send_request(SetSessionConfigOptionRequest::new(session_id.clone(), "model", wanted.as_str())).block_task().await;
                if let Err(e) = set {
                    model_notice = Some(format!("Grok Build could not switch to {wanted}: {e}. It is using its default model."));
                    model = None;
                }
            }

            if let Some(b) = bound.take() {
                let _ = b.send(Ok(session_id.to_string()));
            }
            let _ = shared.events.send(DriverEvent::SessionBound { session_id: session_id.to_string(), model }).await;
            if let Some(text) = model_notice {
                let _ = shared.events.send(DriverEvent::Notice { level: NoticeLevel::Warning, text, data: None }).await;
            }

            while let Some(cmd) = commands.recv().await {
                match cmd {
                    SessionCommand::Prompt { blocks } => {
                        // Whatever a resume still replays after this is this prompt's output.
                        loading.store(false, std::sync::atomic::Ordering::Relaxed);
                        let started = std::time::Instant::now();
                        msg_state.lock().await.1 = false;
                        // Grok echoes this id in `prompt_complete` (T3 Code sends it the same way).
                        let prompt_id = format!("kybern-{}", uuid::Uuid::new_v4().simple());
                        let mut meta = Meta::new();
                        meta.insert("promptId".into(), json!(prompt_id));
                        meta.insert("requestId".into(), json!(prompt_id));
                        let prompt = cx.send_request(PromptRequest::new(session_id.clone(), blocks).meta(meta));
                        let answer = async {
                            match prompt.block_task().await {
                                Ok(r) => {
                                    let (usage, cost_usd) = turn_usage(r.meta.as_ref());
                                    let duration_ms = started.elapsed().as_millis() as u64;
                                    DriverEvent::TurnCompleted { stop_reason: stop_reason(r.stop_reason), usage, cost_usd, duration_ms, anchors: Default::default() }
                                }
                                Err(e) => prompt_failure(&e),
                            }
                        };
                        let cancel = || {
                            let _ = cx.send_notification(CancelNotification::new(session_id.clone()));
                        };
                        let settled =
                            settle_prompt(answer, &prompt_id, started, &mut completions, &mut commands, timings.cancel_grace, cancel).await;
                        shared.withdraw_all().await;
                        let _ = shared.events.send(settled.event).await;
                        if settled.close {
                            break;
                        }
                    }
                    SessionCommand::Cancel => {
                        let _ = cx.send_notification(CancelNotification::new(session_id.clone()));
                    }
                    SessionCommand::Close => break,
                }
            }
            Ok(())
        })
        .await;

    result.map_err(|e| DriverError::Protocol(e.to_string()))
}

/// One tick of `costUsdTicks` is 1e-10 USD.
const USD_PER_TICK: f64 = 1e-10;

/// A turn's tokens and cost from the prompt response's `_meta`. Grok's input already counts the
/// cached reads (as Codex's does), so `input_tokens` is taken as reported.
fn turn_usage(meta: Option<&Meta>) -> (Usage, Option<f64>) {
    let Some(meta) = meta else { return (Usage::default(), None) };
    let usage = meta.get("usage").and_then(Value::as_object);
    let tokens = |keys: &[&str]| usage.and_then(|usage| keys.iter().find_map(|key| usage.get(*key)).and_then(Value::as_u64)).unwrap_or(0);
    let ticks = usage
        .and_then(|usage| usage.get("costUsdTicks"))
        .or_else(|| meta.get("costUsdTicks"))
        .and_then(|ticks| ticks.as_f64().or_else(|| ticks.as_str().and_then(|ticks| ticks.parse().ok())));
    (
        Usage {
            input_tokens: tokens(&["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]),
            output_tokens: tokens(&["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]),
            cache_read_tokens: tokens(&["cachedReadTokens", "cachedInputTokens", "cache_read_tokens", "cachedTokens", "cached_tokens"]),
            cache_write_tokens: tokens(&["cachedWriteTokens", "cacheWriteTokens", "cache_write_tokens"]),
        },
        ticks.map(|ticks| ticks * USD_PER_TICK),
    )
}

#[async_trait]
impl AgentSession for Handle {
    async fn send_message(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        let (blocks, guide) = blocks_with_guide(&mut *self.guide.lock().await, prompt_blocks(message));
        if self.commands.send(SessionCommand::Prompt { blocks }).await.is_err() {
            // The agent never saw it; offer the guide again with the retry.
            if guide.is_some() {
                *self.guide.lock().await = guide;
            }
            return Err(DriverError::ProcessExited("session closed".into()));
        }
        Ok(())
    }

    async fn interrupt(&self) -> Result<()> {
        let _ = self.commands.send(SessionCommand::Cancel).await;
        Ok(())
    }

    async fn set_permission_mode(&self, _mode: PermissionMode) -> Result<()> {
        // The mode is a launch flag (`--permission-mode`, `--always-approve`); Grok has no runtime switch.
        Err(DriverError::Unsupported("Grok Build permission mode cannot be changed after session start".into()))
    }

    async fn set_model(&self, _model: &str) -> Result<()> {
        Err(DriverError::Unsupported("Grok Build model switch is not implemented yet".into()))
    }

    async fn set_effort(&self, _effort: &str) -> Result<()> {
        Err(DriverError::Unsupported("Grok Build does not expose effort switching over ACP".into()))
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let mut pending = self.shared.pending.lock().await;
        let Some((kind, _)) = pending.get(request_id) else {
            return Err(DriverError::Protocol(format!("no pending approval {request_id}")));
        };
        if matches!(decision, ApprovalDecision::Submit { .. }) && *kind != Ask::Question {
            return Err(DriverError::Unsupported("Grok Build only takes an answer to its own questions".into()));
        }
        let (_, tx) = pending.remove(request_id).expect("checked above");
        let _ = tx.send(decision.clone());
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        let _ = self.commands.send(SessionCommand::Close).await;
        Ok(())
    }
}

fn command_update(update: agent_client_protocol::schema::v1::AvailableCommandsUpdate) -> DriverEvent {
    DriverEvent::CommandsUpdated(
        update
            .available_commands
            .into_iter()
            .map(|c| ProviderCommand { name: c.name, description: c.description, ..Default::default() })
            .collect(),
    )
}

#[cfg(test)]
mod grok_meta_tests {
    use super::*;

    fn meta(value: Value) -> Meta {
        value.as_object().cloned().expect("an object")
    }

    #[test]
    fn tool_name_prefers_xai_meta_then_kind_then_title() {
        let named = meta(json!({ "x.ai/tool": { "name": "read_file" } }));
        assert_eq!(tool_name(&ToolKind::Other, "Read Cargo.toml", Some(&named)), "read_file");
        assert_eq!(tool_name(&ToolKind::Read, "Read Cargo.toml", Some(&named)), "read_file");
        // No usable name in the metadata: the ACP kind says what it is.
        let blank = meta(json!({ "x.ai/tool": { "name": " " } }));
        assert_eq!(tool_name(&ToolKind::Execute, "ls", Some(&blank)), "execute");
        assert_eq!(tool_name(&ToolKind::SwitchMode, "Plan", None), "switch_mode");
        // An `other` kind says nothing, so the title does.
        assert_eq!(tool_name(&ToolKind::Other, "  List crates ", None), "List crates");
        assert_eq!(tool_name(&ToolKind::Other, "", None), "other");
    }

    #[test]
    fn turn_usage_reads_meta_usage_and_cost() {
        let reported = meta(json!({
            "usage": { "inputTokens": 36893, "outputTokens": 267, "cachedReadTokens": 30000, "costUsdTicks": 155000000 }
        }));
        let (usage, cost) = turn_usage(Some(&reported));
        assert_eq!(
            usage,
            Usage { input_tokens: 36893, output_tokens: 267, cache_read_tokens: 30000, cache_write_tokens: 0 },
            "input is kept as reported: it already includes the cached reads"
        );
        assert!((cost.unwrap() - 0.0155).abs() < 1e-12, "{cost:?}");

        // The cost may sit beside the usage block.
        let beside = meta(json!({ "usage": { "inputTokens": 5, "outputTokens": 2 }, "costUsdTicks": 10_000_000_000u64 }));
        let (usage, cost) = turn_usage(Some(&beside));
        assert_eq!((usage.input_tokens, usage.output_tokens), (5, 2));
        assert!((cost.unwrap() - 1.0).abs() < 1e-9);

        // Nothing reported: zero tokens and no cost, not a made-up one.
        assert_eq!(turn_usage(None), (Usage::default(), None));
        assert_eq!(turn_usage(Some(&meta(json!({})))), (Usage::default(), None));
    }

    #[test]
    fn models_parse_with_markers_and_descriptions_and_skip_headings() {
        let models = parse_models(
            "Available models:\n\nMODEL  CONTEXT\n-----\ngrok-4  (default)  Flagship reasoning model\n* grok-code-fast-1\n  grok-build - Agentic coding\n# comment\n",
        );
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["grok-4", "grok-code-fast-1", "grok-build"]);
        assert_eq!(models[0].description.as_deref(), Some("(default)  Flagship reasoning model"));
        assert!(models[0].is_default && models[1].is_default && models[2].is_default);
        assert_eq!(models[2].description.as_deref(), Some("Agentic coding"));
        assert!(parse_models("").is_empty());
    }

    #[test]
    fn the_guide_rides_on_the_first_ordinary_prompt_only() {
        let mut guide = Some("# Working in Kybern".to_string());
        // A slash command keeps the start of its prompt and leaves the guide for later.
        assert_eq!(prompt_with_guide(&mut guide, "/compact".into()), ("/compact".into(), None));
        assert!(guide.is_some());

        let (first, carried) = prompt_with_guide(&mut guide, "Hello".into());
        assert_eq!(carried.as_deref(), Some("# Working in Kybern"));
        assert!(first.starts_with("<kybern_instructions>\n# Working in Kybern\n</kybern_instructions>\n\n"), "{first}");
        assert!(first.ends_with("Hello"));
        assert_eq!(crate::cursor::without_guide(&first), "Hello");

        // Sent once: the next prompt is the user's own text.
        assert_eq!(prompt_with_guide(&mut guide, "Again".into()), ("Again".into(), None));
    }

    #[test]
    fn a_failed_start_reaches_the_caller_and_stderr_explains_an_early_exit() {
        let (tx, mut rx) = oneshot::channel::<Result<String>>();
        let mut bound = Some(tx);
        let _ = fail_startup(&mut bound, startup_problem(Startup::NewSession, "session/new: Internal error: boom", ""));
        assert!(bound.is_none());
        let Ok(Err(error)) = rx.try_recv() else { panic!("expected the startup error") };
        assert_eq!(error.to_string(), "session/new: Internal error: boom", "the error's text is the technical detail");
        let problem = crate::failure::classify_error(ProviderKind::GrokBuild, &error).expect("a worded problem");
        assert_eq!(problem.title.as_deref(), Some("Grok Build couldn't start a conversation"));

        let tail = std::sync::Mutex::new(String::new());
        assert_eq!(startup_exit_error(&tail).to_string(), "grok agent exited during startup");
        for line in 0..100 {
            remember_stderr(&tail, &format!("error line {line}"));
        }
        let message = startup_exit_error(&tail).to_string();
        assert!(message.contains("error line 99") && !message.contains("error line 0\n"), "{message}");
        assert!(tail.lock().unwrap().len() <= STDERR_TAIL_BYTES);
    }
}

#[cfg(test)]
mod command_tests {
    use super::*;
    #[test]
    fn acp_command_update_reaches_the_composer() {
        let update = serde_json::from_value(json!({"availableCommands":[{"name":"review","description":"Review changes"}]})).unwrap();
        let DriverEvent::CommandsUpdated(commands) = command_update(update) else { panic!("wrong event") };
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "review");
        assert_eq!(commands[0].description, "Review changes");
    }
}

#[cfg(test)]
#[path = "grok_tests.rs"]
mod grok_tests;
