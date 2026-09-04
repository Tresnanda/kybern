//! OpenCode driver: runs `opencode serve` per session and speaks its HTTP API,
//! consuming the server-sent event stream for progress.
//!
//! One server process per kybern thread keeps lifecycle simple: the process's
//! cwd is the project directory, and closing the session kills it. Sessions
//! are persisted by OpenCode on disk, so resuming is just prompting the same
//! `ses_*` id from a fresh server.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc};

use crate::binary::{at_least, resolve, version_of};
use crate::{
    AgentDriver, AgentSession, DriverError, DriverEvent, DriverRuntimeTask, DriverRuntimeTaskUpdate, ProbeContext, Result, SessionConfig,
    SpawnedSession, summarize_tool_call,
};

const MIN_VERSION: (u64, u64, u64) = (1, 10, 0);
const MAX_SKILL_DISCOVERY_BYTES: usize = 8 * 1024 * 1024;
const MODEL_DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Default)]
pub struct OpencodeDriver;

async fn opencode_models(bin: &std::path::Path, context: &ProbeContext) -> Vec<ProviderModel> {
    let mut command = Command::new(bin);
    command.args(["models"]).stdin(Stdio::null()).kill_on_drop(true);
    if let Some(cwd) = &context.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &context.env {
        command.env(key, value);
    }
    let output = match tokio::time::timeout(MODEL_DISCOVERY_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => output,
        _ => return Vec::new(),
    };
    let mut models: Vec<ProviderModel> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let id = line.trim();
            if id.is_empty() {
                return None;
            }
            let (provider, name) = id.split_once('/').unwrap_or(("", id));
            Some(ProviderModel {
                id: id.to_string(),
                display_name: name.to_string(),
                provider: (!provider.is_empty()).then(|| provider.to_string()),
                efforts: Vec::new(),
                default_effort: None,
                is_default: false,
            })
        })
        .collect();
    models.sort_by(|a, b| a.provider.cmp(&b.provider).then_with(|| a.display_name.cmp(&b.display_name)));
    models
}

impl OpencodeDriver {
    async fn probe_inner(&self, context: &ProbeContext) -> ProviderStatus {
        let mut status = ProviderStatus {
            kind: ProviderKind::Opencode,
            display_name: ProviderKind::Opencode.display_name().into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: PermissionMode::ALL.to_vec(),
            supports_fork: true,
            supports_model_switch: true,
            supports_effort_switch: false,
            supported_efforts: vec![],
            models: vec![],
            instances: vec!["default".into()],
        };
        let bin = match resolve(ProviderKind::Opencode, context.binary.as_ref()) {
            Ok(b) => b,
            Err(e) => {
                status.unavailable_reason = Some(format!("{e}. Install with: npm install -g opencode-ai"));
                return status;
            }
        };
        status.binary_path = Some(bin.display().to_string());
        match version_of(&bin, &["--version"]).await {
            Some(v) => {
                let ok = at_least(&v, MIN_VERSION);
                status.available = ok;
                if !ok {
                    status.unavailable_reason =
                        Some(format!("OpenCode {v} is older than the required {}.{}.{}", MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2));
                }
                status.version = Some(v);
                if ok {
                    status.models = opencode_models(&bin, context).await;
                }
            }
            None => status.unavailable_reason = Some("could not run `opencode --version`".into()),
        }
        status
    }
}

/// Ask OpenCode for the effective skill catalog in this project. The CLI
/// applies OpenCode's own config, compatibility roots, and precedence rules,
/// which a filesystem walk cannot reconstruct reliably.
pub async fn discover_skills(cwd: &Path, binary: Option<&PathBuf>, env: &BTreeMap<String, String>) -> Option<Vec<SkillInfo>> {
    let bin = resolve(ProviderKind::Opencode, binary).ok()?;
    let mut command = Command::new(bin);
    command.current_dir(cwd).args(["debug", "skill"]).stdin(Stdio::null()).stderr(Stdio::null());
    for (key, value) in env {
        command.env(key, value);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output()).await.ok()?.ok()?;
    if !output.status.success() || output.stdout.len() > MAX_SKILL_DISCOVERY_BYTES {
        return None;
    }
    parse_skills(&output.stdout, cwd)
}

fn parse_skills(bytes: &[u8], cwd: &Path) -> Option<Vec<SkillInfo>> {
    let entries = serde_json::from_slice::<Vec<Value>>(bytes).ok()?;
    let mut skills = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        let Some(name) = entry.get("name").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()) else { continue };
        let Some(location) = entry.get("location").and_then(Value::as_str).map(str::trim).filter(|path| !path.is_empty()) else { continue };
        if !seen.insert(name.to_ascii_lowercase()) {
            continue;
        }
        let description =
            entry.get("description").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
        let scope = if location == "<built-in>" {
            SkillScope::System
        } else {
            let path = Path::new(location);
            let resolved = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
            if resolved.starts_with(cwd) { SkillScope::Project } else { SkillScope::User }
        };
        skills.push(SkillInfo {
            name: name.to_string(),
            display_name: None,
            description,
            path: location.to_string(),
            scope,
            enabled: true,
        });
    }
    skills.sort_by_key(|skill| skill.name.to_ascii_lowercase());
    Some(skills)
}

#[async_trait]
impl AgentDriver for OpencodeDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Opencode
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        self.probe_inner(&ProbeContext { binary: binary.cloned(), ..ProbeContext::default() }).await
    }

    async fn probe_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        self.probe_inner(context).await
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        let bin = resolve(ProviderKind::Opencode, config.binary.as_ref())?;
        let mut cmd = Command::new(&bin);
        cmd.current_dir(&config.cwd)
            .args(["serve", "--port", "0", "--hostname", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        tracing::info!(bin = %bin.display(), cwd = %config.cwd.display(), "spawning opencode serve");
        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take().ok_or_else(|| DriverError::Protocol("no stdout".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| DriverError::Protocol("no stderr".into()))?;
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                tracing::debug!(target: "provider.stderr", "{l}");
            }
        });

        // Wait for "opencode server listening on http://127.0.0.1:PORT".
        let base = {
            let mut lines = BufReader::new(stdout).lines();
            let found = tokio::time::timeout(std::time::Duration::from_secs(60), async {
                while let Ok(Some(l)) = lines.next_line().await {
                    tracing::debug!(target: "provider.stdout", "{l}");
                    if let Some(idx) = l.find("http://") {
                        let url = l[idx..].trim().trim_end_matches('/').to_string();
                        return Some((url, lines));
                    }
                }
                None
            })
            .await;
            match found {
                Ok(Some((url, mut lines))) => {
                    tokio::spawn(async move {
                        while let Ok(Some(l)) = lines.next_line().await {
                            tracing::debug!(target: "provider.stdout", "{l}");
                        }
                    });
                    url
                }
                _ => {
                    let _ = child.kill().await;
                    return Err(DriverError::Protocol("opencode serve did not announce a listening address".into()));
                }
            }
        };

        let http = reqwest::Client::builder().build().map_err(|e| DriverError::Protocol(e.to_string()))?;
        let dir = config.cwd.to_string_lossy().to_string();
        for _ in 0..50 {
            if http.get(format!("{base}/global/health")).send().await.is_ok_and(|r| r.status().is_success()) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        let (tx, rx) = mpsc::channel(1024);
        let session = Arc::new(OpencodeSession {
            http,
            base: base.clone(),
            dir: dir.clone(),
            child: Mutex::new(child),
            events: tx,
            state: Mutex::new(State {
                session_id: None,
                model: config.model.clone(),
                mode: config.permission_mode,
                parts: HashMap::new(),
                turn_usage: Usage::default(),
                turn_cost: 0.0,
                turn_started: None,
                active: false,
                pending: HashMap::new(),
                current_message_id: None,
                children: HashMap::new(),
            }),
        });

        // Create or adopt the session.
        let session_id = match (&config.resume_session_id, config.fork) {
            (Some(id), false) => {
                // Verify it exists on this server.
                let r = session.http.get(format!("{base}/session/{id}")).query(&[("directory", &dir)]).send().await.map_err(net)?;
                if !r.status().is_success() {
                    return Err(DriverError::Protocol(format!("opencode session {id} not found in {dir}")));
                }
                id.clone()
            }
            (Some(id), true) => {
                // Fork keeps messages before `messageID`; the id of the first dropped turn's user message.
                let body = match config.rewind.as_ref().and_then(|r| r.drop_from.turn_id.clone()) {
                    Some(mid) => json!({ "messageID": mid }),
                    None => json!({}),
                };
                let r = session
                    .http
                    .post(format!("{base}/session/{id}/fork"))
                    .query(&[("directory", &dir)])
                    .json(&body)
                    .send()
                    .await
                    .map_err(net)?;
                let v: Value = r.json().await.map_err(net)?;
                v.get("id").and_then(|i| i.as_str()).ok_or_else(|| DriverError::Protocol("fork returned no id".into()))?.to_string()
            }
            (None, _) => {
                let mut body = json!({ "title": "kybern", "permission": ruleset(config.permission_mode) });
                if let Some((provider, model)) = config.model.as_deref().and_then(split_model) {
                    body["model"] = json!({ "providerID": provider, "id": model });
                }
                let r = session.http.post(format!("{base}/session")).query(&[("directory", &dir)]).json(&body).send().await.map_err(net)?;
                let v: Value = r.json().await.map_err(net)?;
                v.get("id")
                    .and_then(|i| i.as_str())
                    .ok_or_else(|| DriverError::Protocol(format!("session create failed: {v}")))?
                    .to_string()
            }
        };
        session.state.lock().await.session_id = Some(session_id.clone());
        session.emit(DriverEvent::SessionBound { session_id, model: config.model.clone() }).await;

        let reader = session.clone();
        tokio::spawn(async move { reader.event_loop().await });

        Ok(SpawnedSession { session: Box::new(Handle(session)), events: rx })
    }
}

fn net(e: reqwest::Error) -> DriverError {
    DriverError::Protocol(format!("opencode http: {e}"))
}

fn split_model(s: &str) -> Option<(String, String)> {
    let (p, m) = s.split_once('/')?;
    Some((p.to_string(), m.to_string()))
}

/// Per-session permission ruleset for a kybern mode. Last matching rule wins.
fn ruleset(mode: PermissionMode) -> Value {
    let rule = |permission: &str, action: &str| json!({ "permission": permission, "pattern": "*", "action": action });
    match mode {
        PermissionMode::Supervised => json!([
            rule("*", "ask"),
            rule("read", "allow"),
            rule("glob", "allow"),
            rule("grep", "allow"),
            rule("list", "allow"),
            rule("todowrite", "allow"),
            rule("question", "allow"),
            rule("skill", "allow"),
            rule("task", "allow"),
            rule("lsp", "allow"),
        ]),
        PermissionMode::AcceptEdits => json!([
            rule("*", "allow"),
            rule("bash", "ask"),
            rule("webfetch", "ask"),
            rule("websearch", "ask"),
            rule("external_directory", "ask"),
            rule("doom_loop", "ask"),
        ]),
        PermissionMode::Auto => json!([rule("*", "allow"), rule("external_directory", "ask"), rule("doom_loop", "ask")]),
        PermissionMode::FullAccess => json!([rule("*", "allow")]),
    }
}

struct PartInfo {
    kind: String,
    message_id: String,
    started: bool,
}

#[derive(Default)]
struct ChildRuntime {
    task_id: String,
    seen_tool_parts: HashSet<String>,
    stats: RuntimeTaskStats,
    stop_requested: bool,
    terminal: bool,
}

fn opencode_child_status(status: &str, backgrounded: bool) -> RuntimeTaskStatus {
    match status {
        "error" | "failed" => RuntimeTaskStatus::Failed,
        "cancelled" | "canceled" | "aborted" | "stopped" => RuntimeTaskStatus::Stopped,
        // A background task's parent tool returns immediately. The child
        // session's own idle/error event is the authoritative terminal edge.
        "completed" if !backgrounded => RuntimeTaskStatus::Completed,
        "pending" => RuntimeTaskStatus::Pending,
        _ => RuntimeTaskStatus::Running,
    }
}

fn opencode_model(metadata: &Value) -> Option<String> {
    let model = metadata.get("model")?;
    let provider = model.get("providerID").and_then(Value::as_str)?;
    let id = model.get("modelID").and_then(Value::as_str)?;
    Some(format!("{provider}/{id}"))
}

/// OpenCode's native `task` tool publishes the child session id in part
/// metadata. The SSE stream then carries that child's status and tool events.
fn opencode_child_task(part: &Value, parent_id: Option<String>) -> Option<(String, DriverRuntimeTask)> {
    if part.get("type").and_then(Value::as_str) != Some("tool") || part.get("tool").and_then(Value::as_str) != Some("task") {
        return None;
    }
    let state = part.get("state")?;
    let metadata = state.get("metadata")?;
    let child_id = metadata.get("sessionId").and_then(Value::as_str)?.to_string();
    let input = state.get("input").unwrap_or(&Value::Null);
    let backgrounded =
        metadata.get("background").and_then(Value::as_bool) == Some(true) || input.get("background").and_then(Value::as_bool) == Some(true);
    let raw_status = state.get("status").and_then(Value::as_str).unwrap_or("running");
    let title = state
        .get("title")
        .or_else(|| input.get("description"))
        .or_else(|| input.get("prompt"))
        .and_then(Value::as_str)
        .map(|value| value.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or(value).chars().take(120).collect())
        .filter(|value: &String| !value.is_empty())
        .unwrap_or_else(|| "Subagent".into());
    let provider_type =
        input.get("subagent_type").and_then(Value::as_str).map(|value| format!("task:{value}")).or_else(|| Some("task".into()));
    let status = opencode_child_status(raw_status, backgrounded);
    let task = DriverRuntimeTask {
        id: format!("opencode:{child_id}"),
        kind: RuntimeTaskKind::Agent,
        status,
        title,
        detail: None,
        provider_type,
        parent_id,
        tool_call_id: part.get("callID").and_then(Value::as_str).map(str::to_string),
        provider_thread_id: Some(child_id.clone()),
        model: opencode_model(metadata),
        effort: None,
        backgrounded,
        last_tool_name: None,
        usage: None,
        stats: RuntimeTaskStats::default(),
        capabilities: RuntimeTaskCapabilities { stop: status.is_active(), background: false },
    };
    Some((child_id, task))
}

fn opencode_child_session(info: &Value, parent_id: Option<String>) -> Option<(String, DriverRuntimeTask)> {
    let child_id = info.get("id").and_then(Value::as_str)?.to_string();
    let provider_type = info.get("agent").and_then(Value::as_str).map(|value| format!("task:{value}"));
    let title = info
        .get("title")
        .and_then(Value::as_str)
        .map(|value| value.rsplit_once(" (@").map_or(value, |(description, _)| description).trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Subagent".into());
    Some((
        child_id.clone(),
        DriverRuntimeTask {
            id: format!("opencode:{child_id}"),
            kind: RuntimeTaskKind::Agent,
            status: RuntimeTaskStatus::Running,
            title,
            detail: None,
            provider_type,
            parent_id,
            tool_call_id: None,
            provider_thread_id: Some(child_id),
            model: None,
            effort: None,
            backgrounded: false,
            last_tool_name: None,
            usage: None,
            stats: RuntimeTaskStats::default(),
            capabilities: RuntimeTaskCapabilities { stop: true, background: false },
        },
    ))
}

struct State {
    session_id: Option<String>,
    model: Option<String>,
    mode: PermissionMode,
    parts: HashMap<String, PartInfo>,
    turn_usage: Usage,
    turn_cost: f64,
    turn_started: Option<std::time::Instant>,
    active: bool,
    /// permission id -> session id
    pending: HashMap<String, String>,
    /// Client-chosen OpenCode message id of the current turn's user message.
    current_message_id: Option<String>,
    /// Provider child session id -> runtime bookkeeping. Child output stays out
    /// of the parent transcript; only compact lifecycle/progress is projected.
    children: HashMap<String, ChildRuntime>,
}

struct OpencodeSession {
    http: reqwest::Client,
    base: String,
    dir: String,
    child: Mutex<Child>,
    events: mpsc::Sender<DriverEvent>,
    state: Mutex<State>,
}

struct Handle(Arc<OpencodeSession>);

impl OpencodeSession {
    async fn emit(&self, ev: DriverEvent) {
        let _ = self.events.send(ev).await;
    }

    async fn observe_child(&self, child_id: String, task: DriverRuntimeTask) {
        let task_id = task.id.clone();
        let mut state = self.state.lock().await;
        state.children.entry(child_id).or_default().task_id = task_id;
        drop(state);
        self.emit(DriverEvent::RuntimeTaskStarted(task)).await;
    }

    async fn update_child(
        &self,
        child_id: &str,
        status: Option<RuntimeTaskStatus>,
        detail: Option<String>,
        last_tool_name: Option<String>,
        stats: Option<RuntimeTaskStats>,
        terminal: bool,
    ) {
        let task_id = {
            let mut state = self.state.lock().await;
            let Some(child) = state.children.get_mut(child_id) else { return };
            if child.terminal {
                return;
            }
            child.terminal = terminal;
            child.task_id.clone()
        };
        let update = DriverRuntimeTaskUpdate {
            id: task_id,
            status,
            detail,
            backgrounded: None,
            last_tool_name,
            usage: None,
            stats,
            capabilities: terminal.then(RuntimeTaskCapabilities::default),
        };
        self.emit(if terminal { DriverEvent::RuntimeTaskCompleted(update) } else { DriverEvent::RuntimeTaskUpdated(update) }).await;
    }

    async fn stop_child(&self, session_id: &str) -> Result<()> {
        {
            let mut state = self.state.lock().await;
            let child = state
                .children
                .get_mut(session_id)
                .ok_or_else(|| DriverError::Unsupported("OpenCode child session is no longer active".into()))?;
            if child.terminal {
                return Err(DriverError::Unsupported("OpenCode child session is no longer active".into()));
            }
            child.stop_requested = true;
        }
        if let Err(error) = self.post(&format!("/session/{session_id}/abort"), json!({})).await {
            if let Some(child) = self.state.lock().await.children.get_mut(session_id) {
                child.stop_requested = false;
            }
            return Err(error);
        }
        self.update_child(session_id, Some(RuntimeTaskStatus::Stopped), Some("Stopped by user".into()), None, None, true).await;
        Ok(())
    }

    async fn event_loop(self: Arc<Self>) {
        let mut backoff = 200u64;
        loop {
            let resp = self.http.get(format!("{}/event", self.base)).query(&[("directory", &self.dir)]).send().await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    backoff = 200;
                    let mut stream = r.bytes_stream();
                    let mut buf = String::new();
                    while let Some(chunk) = stream.next().await {
                        let Ok(chunk) = chunk else { break };
                        buf.push_str(&String::from_utf8_lossy(&chunk));
                        while let Some(pos) = buf.find("\n\n") {
                            let frame = buf[..pos].to_string();
                            buf.drain(..pos + 2);
                            for line in frame.lines() {
                                if let Some(data) = line.strip_prefix("data:")
                                    && let Ok(v) = serde_json::from_str::<Value>(data.trim())
                                {
                                    self.handle_event(&v).await;
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
            // Stream dropped: is the server still alive?
            if let Ok(Some(status)) = self.child.lock().await.try_wait() {
                let code = status.code();
                self.emit(DriverEvent::Exited {
                    code,
                    error: code.filter(|c| *c != 0).map(|c| format!("opencode serve exited with code {c}")),
                })
                .await;
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
            backoff = (backoff * 2).min(5000);
        }
    }

    async fn handle_event(&self, v: &Value) {
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let p = &v["properties"];
        let my_session = self.state.lock().await.session_id.clone();

        if ty == "session.created" {
            let info = &p["info"];
            let parent_session_id = info.get("parentID").and_then(Value::as_str);
            let parent_task_id = {
                let state = self.state.lock().await;
                match (my_session.as_deref(), parent_session_id) {
                    (Some(root), Some(parent)) if root == parent => Some(None),
                    (_, Some(parent)) => state.children.get(parent).map(|child| Some(child.task_id.clone())),
                    _ => None,
                }
            };
            if let Some(parent_task_id) = parent_task_id
                && let Some((child_id, task)) = opencode_child_session(info, parent_task_id)
            {
                self.observe_child(child_id, task).await;
            }
            return;
        }

        let sid =
            p.get("sessionID").or_else(|| p.pointer("/part/sessionID")).or_else(|| p.pointer("/info/sessionID")).and_then(|s| s.as_str());
        let child_task_id = match sid {
            Some(session_id) => self.state.lock().await.children.get(session_id).map(|child| child.task_id.clone()),
            None => None,
        };
        if let (Some(session_id), Some(task_id)) = (sid, child_task_id) {
            self.handle_child_event(session_id, &task_id, ty, p).await;
            return;
        }
        if let (Some(mine), Some(theirs)) = (&my_session, sid)
            && mine != theirs
        {
            return;
        }
        match ty {
            "message.part.updated" => self.handle_part(&p["part"]).await,
            "message.part.delta" => {
                let part_id = p.get("partID").and_then(|s| s.as_str()).unwrap_or("");
                let delta = p.get("delta").and_then(|s| s.as_str()).unwrap_or("");
                let info = {
                    let st = self.state.lock().await;
                    st.parts.get(part_id).map(|i| (i.kind.clone(), i.message_id.clone()))
                };
                match info.as_ref().map(|(k, m)| (k.as_str(), m.clone())) {
                    Some(("text", message_id)) => {
                        self.emit(DriverEvent::TextDelta { message_id, origin: EventOrigin::Root, delta: delta.to_string() }).await
                    }
                    Some(("reasoning", message_id)) => {
                        self.emit(DriverEvent::ThinkingDelta { message_id, origin: EventOrigin::Root, delta: delta.to_string() }).await
                    }
                    _ => {}
                }
            }
            "message.updated" => {
                let info = &p["info"];
                if info.get("role").and_then(|r| r.as_str()) == Some("assistant")
                    && let Some(err) = info.get("error")
                    && !err.is_null()
                {
                    let msg = err.pointer("/data/message").and_then(|m| m.as_str()).unwrap_or("provider error");
                    self.emit(DriverEvent::Notice { level: NoticeLevel::Error, text: msg.to_string(), data: Some(err.clone()) }).await;
                }
            }
            "permission.asked" => {
                let id = p.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string();
                let permission = p.get("permission").and_then(|s| s.as_str()).unwrap_or("tool").to_string();
                let metadata = p.get("metadata").cloned().unwrap_or(Value::Null);
                let patterns = p.get("patterns").cloned().unwrap_or(Value::Null);
                let input = json!({ "permission": permission, "patterns": patterns, "metadata": metadata });
                let summary = match metadata.get("command").and_then(|c| c.as_str()) {
                    Some(c) => format!("run: {}", c.lines().next().unwrap_or("").chars().take(120).collect::<String>()),
                    None => match patterns.as_array().and_then(|a| a.first()).and_then(|f| f.as_str()) {
                        Some(pat) => format!("{permission}: {pat}"),
                        None => summarize_tool_call(&permission, &metadata),
                    },
                };
                let suggestions = p.get("always").and_then(|a| a.as_array()).cloned().unwrap_or_default();
                let tool_call_id = p.pointer("/tool/callID").and_then(|c| c.as_str()).map(str::to_string);
                if let Some(s) = &my_session {
                    self.state.lock().await.pending.insert(id.clone(), s.clone());
                }
                self.emit(DriverEvent::PermissionRequest {
                    request_id: id,
                    tool_call_id,
                    tool_name: permission,
                    input,
                    summary,
                    suggestions,
                })
                .await;
            }
            "permission.replied" => {
                let id = p.get("requestID").and_then(|s| s.as_str()).unwrap_or("").to_string();
                if self.state.lock().await.pending.remove(&id).is_some() {
                    self.emit(DriverEvent::PermissionWithdrawn { request_id: id }).await;
                }
            }
            "question.asked" => {
                // Decline questions for now; approvals are yes/no only.
                let id = p.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string();
                let _ = self.http.post(format!("{}/question/{id}/reject", self.base)).query(&[("directory", &self.dir)]).send().await;
                self.emit(DriverEvent::Notice {
                    level: NoticeLevel::Warning,
                    text: "OpenCode asked a question kybern cannot relay yet".into(),
                    data: Some(p.clone()),
                })
                .await;
            }
            "session.status" => {
                let status = p.pointer("/status/type").and_then(|s| s.as_str()).unwrap_or("");
                let mut st = self.state.lock().await;
                match status {
                    "busy" if !st.active => {
                        st.active = true;
                        st.turn_started = Some(std::time::Instant::now());
                        st.turn_usage = Usage::default();
                        st.turn_cost = 0.0;
                    }
                    "retry" => {
                        let msg = p.pointer("/status/message").and_then(|m| m.as_str()).unwrap_or("retrying").to_string();
                        drop(st);
                        self.emit(DriverEvent::Notice { level: NoticeLevel::Warning, text: msg, data: None }).await;
                    }
                    _ => {}
                }
            }
            "session.idle" => {
                let (usage, cost, duration_ms, active, anchors) = {
                    let mut st = self.state.lock().await;
                    let active = st.active;
                    st.active = false;
                    let d = st.turn_started.take().map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
                    let anchors = crate::TurnAnchors { turn_id: st.current_message_id.take(), previous_end: None };
                    (std::mem::take(&mut st.turn_usage), st.turn_cost, d, active, anchors)
                };
                if active {
                    self.emit(DriverEvent::TurnCompleted {
                        stop_reason: StopReason::Completed,
                        usage,
                        cost_usd: Some(cost),
                        duration_ms,
                        anchors,
                    })
                    .await;
                }
            }
            "session.error" => {
                let err = &p["error"];
                let name = err.get("name").and_then(|n| n.as_str()).unwrap_or("error");
                let msg = err.pointer("/data/message").and_then(|m| m.as_str()).unwrap_or("");
                let active = {
                    let mut st = self.state.lock().await;
                    let a = st.active;
                    st.active = false;
                    st.turn_started = None;
                    a
                };
                if name == "MessageAbortedError" {
                    if active {
                        self.emit(DriverEvent::TurnCompleted {
                            stop_reason: StopReason::Interrupted,
                            usage: Usage::default(),
                            cost_usd: None,
                            duration_ms: 0,
                            anchors: crate::TurnAnchors::default(),
                        })
                        .await;
                    }
                } else if active {
                    self.emit(DriverEvent::TurnFailed { error: format!("{name}: {msg}") }).await;
                } else {
                    self.emit(DriverEvent::Notice { level: NoticeLevel::Error, text: format!("{name}: {msg}"), data: Some(err.clone()) })
                        .await;
                }
            }
            "session.compacted" => {
                self.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "context compacted".into(), data: None }).await
            }
            "todo.updated" => {
                self.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "todo list updated".into(), data: Some(p.clone()) }).await
            }
            _ => {}
        }
    }

    async fn handle_child_event(&self, session_id: &str, task_id: &str, ty: &str, properties: &Value) {
        match ty {
            "message.part.updated" => self.handle_child_part(session_id, task_id, &properties["part"]).await,
            "session.status" => {
                let status = properties.pointer("/status/type").and_then(Value::as_str).unwrap_or("");
                match status {
                    "busy" => self.update_child(session_id, Some(RuntimeTaskStatus::Running), None, None, None, false).await,
                    "retry" => {
                        let detail = properties.pointer("/status/message").and_then(Value::as_str).map(str::to_string);
                        self.update_child(session_id, Some(RuntimeTaskStatus::Waiting), detail, None, None, false).await;
                    }
                    _ => {}
                }
            }
            "session.idle" => {
                let stop_requested = self.state.lock().await.children.get(session_id).is_some_and(|child| child.stop_requested);
                let status = if stop_requested { RuntimeTaskStatus::Stopped } else { RuntimeTaskStatus::Completed };
                self.update_child(session_id, Some(status), None, None, None, true).await;
            }
            "session.error" => {
                let error = &properties["error"];
                let name = error.get("name").and_then(Value::as_str).unwrap_or("error");
                let detail = error.pointer("/data/message").and_then(Value::as_str).map(str::to_string);
                let stop_requested = self.state.lock().await.children.get(session_id).is_some_and(|child| child.stop_requested);
                let status =
                    if stop_requested || name == "MessageAbortedError" { RuntimeTaskStatus::Stopped } else { RuntimeTaskStatus::Failed };
                self.update_child(session_id, Some(status), detail, None, None, true).await;
            }
            _ => {}
        }
    }

    async fn handle_child_part(&self, session_id: &str, owner_task_id: &str, part: &Value) {
        if let Some((child_id, task)) = opencode_child_task(part, Some(owner_task_id.to_string())) {
            self.observe_child(child_id, task).await;
        }

        match part.get("type").and_then(Value::as_str).unwrap_or("") {
            "tool" => {
                let status = part.pointer("/state/status").and_then(Value::as_str).unwrap_or("");
                if !matches!(status, "running" | "completed" | "error") {
                    return;
                }
                let part_id = part.get("id").and_then(Value::as_str).unwrap_or("");
                let tool = part.get("tool").and_then(Value::as_str).unwrap_or("tool").to_string();
                let stats = {
                    let mut state = self.state.lock().await;
                    let Some(child) = state.children.get_mut(session_id) else { return };
                    if !part_id.is_empty() && child.seen_tool_parts.insert(part_id.to_string()) {
                        child.stats.tool_uses = Some(child.stats.tool_uses.unwrap_or(0) + 1);
                    }
                    child.stats.clone()
                };
                self.update_child(session_id, Some(RuntimeTaskStatus::Running), None, Some(tool), Some(stats), false).await;
            }
            "step-finish" => {
                let step_tokens = part
                    .get("tokens")
                    .map(|tokens| {
                        tokens.get("input").and_then(Value::as_u64).unwrap_or(0)
                            + tokens.get("output").and_then(Value::as_u64).unwrap_or(0)
                            + tokens.get("reasoning").and_then(Value::as_u64).unwrap_or(0)
                            + tokens.pointer("/cache/write").and_then(Value::as_u64).unwrap_or(0)
                    })
                    .unwrap_or(0);
                let stats = {
                    let mut state = self.state.lock().await;
                    let Some(child) = state.children.get_mut(session_id) else { return };
                    child.stats.token_count = Some(child.stats.token_count.unwrap_or(0) + step_tokens);
                    child.stats.clone()
                };
                self.update_child(session_id, Some(RuntimeTaskStatus::Running), None, None, Some(stats), false).await;
            }
            _ => {}
        }
    }

    async fn handle_part(&self, part: &Value) {
        if let Some((child_id, task)) = opencode_child_task(part, None) {
            self.observe_child(child_id, task).await;
        }
        let id = part.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let kind = part.get("type").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let message_id = part.get("messageID").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let mut st = self.state.lock().await;
        let info =
            st.parts.entry(id.clone()).or_insert_with(|| PartInfo { kind: kind.clone(), message_id: message_id.clone(), started: false });
        match kind.as_str() {
            "text" => {
                let text = part.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                let finished = part.pointer("/time/end").is_some_and(|e| !e.is_null());
                let synthetic = part.get("synthetic").and_then(|b| b.as_bool()).unwrap_or(false);
                drop(st);
                if finished && !synthetic && !text.is_empty() {
                    self.emit(DriverEvent::MessageCompleted { message_id, origin: EventOrigin::Root, text, thinking: None }).await;
                }
            }
            "reasoning" => {}
            "tool" => {
                let status = part.pointer("/state/status").and_then(|s| s.as_str()).unwrap_or("");
                let call_id = part.get("callID").and_then(|s| s.as_str()).unwrap_or(&id).to_string();
                let tool = part.get("tool").and_then(|s| s.as_str()).unwrap_or("tool").to_string();
                let input = part.pointer("/state/input").cloned().unwrap_or(Value::Null);
                match status {
                    "running" if !info.started => {
                        info.started = true;
                        drop(st);
                        self.emit(DriverEvent::ToolStarted(ToolCall { id: call_id, name: tool, input, parent_id: None })).await;
                    }
                    "completed" | "error" => {
                        let started = info.started;
                        info.started = true;
                        drop(st);
                        if !started {
                            self.emit(DriverEvent::ToolStarted(ToolCall { id: call_id.clone(), name: tool, input, parent_id: None })).await;
                        }
                        let output = json!({
                            "content": part.pointer("/state/output").or_else(|| part.pointer("/state/error")),
                            "title": part.pointer("/state/title"),
                            "metadata": part.pointer("/state/metadata"),
                        });
                        self.emit(DriverEvent::ToolCompleted { tool_call_id: call_id, output, is_error: status == "error" }).await;
                    }
                    _ => {}
                }
            }
            "step-finish" => {
                if let Some(t) = part.get("tokens") {
                    st.turn_usage.input_tokens += t.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
                    st.turn_usage.output_tokens +=
                        t.get("output").and_then(|v| v.as_u64()).unwrap_or(0) + t.get("reasoning").and_then(|v| v.as_u64()).unwrap_or(0);
                    st.turn_usage.cache_read_tokens += t.pointer("/cache/read").and_then(|v| v.as_u64()).unwrap_or(0);
                    st.turn_usage.cache_write_tokens += t.pointer("/cache/write").and_then(|v| v.as_u64()).unwrap_or(0);
                }
                st.turn_cost += part.get("cost").and_then(|c| c.as_f64()).unwrap_or(0.0);
            }
            _ => {}
        }
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        let r = self.http.post(format!("{}{path}", self.base)).query(&[("directory", &self.dir)]).json(&body).send().await.map_err(net)?;
        let status = r.status();
        let text = r.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(DriverError::Protocol(format!("opencode {path}: {status} {text}")));
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }
}

fn parts(message: &UserMessage) -> Vec<Value> {
    let mut out = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text } => out.push(json!({ "type": "text", "text": text })),
            ContentPart::FileMention { path } => out.push(json!({ "type": "text", "text": format!("@{path}") })),
            ContentPart::Skill { name, .. } => out.push(json!({ "type": "text", "text": format!("/{name}") })),
            ContentPart::Image { media_type, data } => out.push(
                json!({ "type": "file", "mime": media_type, "url": format!("data:{media_type};base64,{data}"), "filename": "image" }),
            ),
            ContentPart::Attachment { name, .. } => out.push(json!({ "type": "text", "text": format!("[attached file: {name}]") })),
        }
    }
    out
}

struct SkillCommand {
    name: String,
    arguments: String,
    files: Vec<Value>,
}

/// OpenCode exposes every discovered skill as a native session command. Use
/// that endpoint instead of hoping a `$name` text mention makes the model load
/// it. The last selected skill is the command; earlier skills remain explicit
/// slash references in its arguments, matching the single-command behavior of
/// the OpenCode and Claude harnesses.
fn skill_command(message: &UserMessage) -> Option<SkillCommand> {
    let command_index = message.parts.iter().rposition(|part| matches!(part, ContentPart::Skill { .. }))?;
    let ContentPart::Skill { name, .. } = &message.parts[command_index] else { unreachable!() };
    let mut arguments = String::new();
    let mut files = Vec::new();
    for (index, part) in message.parts.iter().enumerate() {
        if index == command_index {
            continue;
        }
        match part {
            ContentPart::Text { text } => arguments.push_str(text),
            ContentPart::FileMention { path } => {
                arguments.push('@');
                arguments.push_str(path);
            }
            ContentPart::Skill { name, .. } => {
                arguments.push('/');
                arguments.push_str(name);
            }
            ContentPart::Image { media_type, data } => files.push(
                json!({ "type": "file", "mime": media_type, "url": format!("data:{media_type};base64,{data}"), "filename": "image" }),
            ),
            ContentPart::Attachment { name, .. } => arguments.push_str(&format!("[attached file: {name}]")),
        }
    }
    Some(SkillCommand { name: name.clone(), arguments: arguments.trim().to_string(), files })
}

#[async_trait]
impl AgentSession for Handle {
    async fn send_message(&self, message_id: &str, message: &UserMessage) -> Result<()> {
        let s = &self.0;
        let (session_id, model) = {
            let st = s.state.lock().await;
            (st.session_id.clone().ok_or_else(|| DriverError::Protocol("no opencode session".into()))?, st.model.clone())
        };
        // OpenCode ids must start with "msg"; derive a stable one from ours.
        let oc_message_id = format!("msg_{}", message_id.replace('-', ""));
        let command = skill_command(message);
        let mut body = match &command {
            Some(command) => json!({
                "messageID": oc_message_id,
                "command": command.name,
                "arguments": command.arguments,
                "parts": command.files,
            }),
            None => json!({ "parts": parts(message), "messageID": oc_message_id }),
        };
        if let Some(model) = model.as_deref() {
            if command.is_some() {
                body["model"] = Value::String(model.to_string());
            } else if let Some((provider, model)) = split_model(model) {
                body["model"] = json!({ "providerID": provider, "modelID": model });
            }
        }
        {
            let mut st = s.state.lock().await;
            st.active = true;
            st.turn_started = Some(std::time::Instant::now());
            st.turn_usage = Usage::default();
            st.turn_cost = 0.0;
            st.current_message_id = Some(oc_message_id);
        }
        if command.is_some() {
            let session = s.clone();
            tokio::spawn(async move {
                if let Err(error) = session.post(&format!("/session/{session_id}/command"), body).await {
                    session.state.lock().await.active = false;
                    session.emit(DriverEvent::TurnFailed { error: error.to_string() }).await;
                }
            });
            Ok(())
        } else {
            s.post(&format!("/session/{session_id}/prompt_async"), body).await.map(|_| ())
        }
    }

    async fn interrupt(&self) -> Result<()> {
        let s = &self.0;
        let Some(session_id) = s.state.lock().await.session_id.clone() else { return Ok(()) };
        s.post(&format!("/session/{session_id}/abort"), json!({})).await.map(|_| ())
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        // Session rulesets are fixed at creation; the mode applies to the next session (resume creates none).
        self.0.state.lock().await.mode = mode;
        Err(DriverError::Unsupported("OpenCode permission rules are set when the session starts; start a new thread to change them".into()))
    }

    async fn set_model(&self, model: &str) -> Result<()> {
        if split_model(model).is_none() {
            return Err(DriverError::Unsupported(format!("OpenCode models are named provider/model, got {model}")));
        }
        self.0.state.lock().await.model = Some(model.to_string());
        Ok(())
    }

    async fn set_effort(&self, _effort: &str) -> Result<()> {
        Err(DriverError::Unsupported("OpenCode did not report effort controls for this model".into()))
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let s = &self.0;
        let Some(session_id) = s.state.lock().await.pending.remove(request_id) else {
            return Err(DriverError::Protocol(format!("no pending permission {request_id}")));
        };
        let response = match decision {
            ApprovalDecision::AllowOnce => "once",
            ApprovalDecision::AllowAlways => "always",
            ApprovalDecision::Deny { .. } => "reject",
        };
        s.post(&format!("/session/{session_id}/permissions/{request_id}"), json!({ "response": response })).await.map(|_| ())
    }

    async fn stop_runtime_task(&self, task: &RuntimeTask) -> Result<()> {
        let session_id = task
            .provider_thread_id
            .as_deref()
            .ok_or_else(|| DriverError::Unsupported("OpenCode did not expose the child session id needed to stop this task".into()))?;
        self.0.stop_child(session_id).await
    }

    async fn close(&self) -> Result<()> {
        let mut child = self.0.child.lock().await;
        let _ = child.kill().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{MODEL_DISCOVERY_TIMEOUT, opencode_child_session, opencode_child_task, parse_skills, skill_command};
    use kybern_protocol::{ContentPart, RuntimeTaskKind, RuntimeTaskStatus, SkillScope, UserMessage};
    use serde_json::json;
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn model_discovery_budget_covers_a_cold_provider_refresh() {
        assert!(MODEL_DISCOVERY_TIMEOUT >= Duration::from_secs(10));
    }

    #[test]
    fn parses_opencodes_effective_skill_catalog() {
        let skills = parse_skills(
            br#"[
                {"name":"built-in","description":"Bundled","location":"<built-in>"},
                {"name":"review","description":"Review code","location":"/work/repo/.opencode/skills/review/SKILL.md"},
                {"name":"global","description":null,"location":"/home/me/.config/opencode/skills/global/SKILL.md"}
            ]"#,
            Path::new("/work/repo"),
        )
        .expect("valid catalog");

        assert_eq!(skills.iter().map(|skill| skill.name.as_str()).collect::<Vec<_>>(), ["built-in", "global", "review"]);
        assert_eq!(skills[0].scope, SkillScope::System);
        assert_eq!(skills[1].scope, SkillScope::User);
        assert_eq!(skills[2].scope, SkillScope::Project);
    }

    #[test]
    fn dispatches_selected_skill_through_opencodes_command_contract() {
        let message = UserMessage {
            parts: vec![
                ContentPart::Text { text: "Review ".into() },
                ContentPart::Skill { name: "security".into(), path: "/skills/security/SKILL.md".into() },
                ContentPart::Text { text: " then ".into() },
                ContentPart::Skill { name: "fix-ci".into(), path: "/skills/fix-ci/SKILL.md".into() },
                ContentPart::Text { text: " carefully".into() },
                ContentPart::Image { media_type: "image/png".into(), data: "aW1hZ2U=".into() },
            ],
        };

        let command = skill_command(&message).expect("skill command");
        assert_eq!(command.name, "fix-ci");
        assert_eq!(command.arguments, "Review /security then  carefully");
        assert_eq!(
            command.files,
            vec![json!({ "type": "file", "mime": "image/png", "url": "data:image/png;base64,aW1hZ2U=", "filename": "image" })]
        );
    }

    #[test]
    fn maps_opencode_child_session_metadata_to_native_runtime_activity() {
        let (child_id, task) = opencode_child_task(
            &json!({
                "id": "part-task-1",
                "sessionID": "ses_parent",
                "messageID": "msg_parent",
                "type": "tool",
                "callID": "call-task-1",
                "tool": "task",
                "state": {
                    "status": "running",
                    "input": {
                        "description": "Audit the driver",
                        "prompt": "Check native lifecycle support",
                        "subagent_type": "general",
                        "background": true
                    },
                    "title": "Audit the driver",
                    "metadata": {
                        "parentSessionId": "ses_parent",
                        "sessionId": "ses_child",
                        "background": true,
                        "model": { "providerID": "openai", "modelID": "gpt-5.6-sol" }
                    }
                }
            }),
            None,
        )
        .expect("OpenCode child task");

        assert_eq!(child_id, "ses_child");
        assert_eq!(task.id, "opencode:ses_child");
        assert_eq!(task.kind, RuntimeTaskKind::Agent);
        assert_eq!(task.status, RuntimeTaskStatus::Running);
        assert_eq!(task.title, "Audit the driver");
        assert_eq!(task.provider_thread_id.as_deref(), Some("ses_child"));
        assert_eq!(task.tool_call_id.as_deref(), Some("call-task-1"));
        assert_eq!(task.model.as_deref(), Some("openai/gpt-5.6-sol"));
        assert!(task.backgrounded);
        assert!(task.capabilities.stop);
    }

    #[test]
    fn discovers_nested_children_from_session_events() {
        let (child_id, task) = opencode_child_session(
            &json!({
                "id": "ses_nested",
                "parentID": "ses_child",
                "title": "Trace lifecycle edges (@explore subagent)",
                "agent": "explore"
            }),
            Some("opencode:ses_child".into()),
        )
        .expect("OpenCode child session");

        assert_eq!(child_id, "ses_nested");
        assert_eq!(task.title, "Trace lifecycle edges");
        assert_eq!(task.parent_id.as_deref(), Some("opencode:ses_child"));
        assert_eq!(task.provider_type.as_deref(), Some("task:explore"));
    }

    #[test]
    fn keeps_promoted_opencode_children_active_after_the_parent_tool_returns() {
        let (_, task) = opencode_child_task(
            &json!({
                "id": "part-task-2",
                "type": "tool",
                "callID": "call-task-2",
                "tool": "task",
                "state": {
                    "status": "completed",
                    "input": { "description": "Run independently" },
                    "metadata": { "sessionId": "ses_background", "background": true }
                }
            }),
            Some("opencode:ses_parent_child".into()),
        )
        .expect("promoted OpenCode child");

        assert_eq!(task.status, RuntimeTaskStatus::Running);
        assert_eq!(task.parent_id.as_deref(), Some("opencode:ses_parent_child"));
    }
}
