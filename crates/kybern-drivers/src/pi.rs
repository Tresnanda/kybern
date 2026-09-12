//! pi and Oh My Pi (omp) driver: JSONL RPC over stdio (`--mode rpc`).
//!
//! omp is a fork of pi with a superset protocol, so one module drives both
//! with a `Flavor` switch. Differences that matter here: omp announces itself
//! with a `ready` frame and supports chunked frames after protocol
//! negotiation; omp has built-in approval tiers surfaced as `select` UI
//! requests, while pi uses Kybern's bundled blocking tool hook; pi signals run
//! completion with `agent_settled`, omp with `agent_end.isTerminal`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc, oneshot};
use uuid::Uuid;

use crate::binary::{at_least, resolve, version_of};
use crate::ndjson::NdjsonChild;
use crate::{AgentDriver, AgentSession, DriverError, DriverEvent, DriverRuntimeTask, ProbeContext, Result, SessionConfig, SpawnedSession};

mod extension;
#[cfg(test)]
mod lifecycle_tests;
mod models;
#[cfg(test)]
mod ui_tests;

const MODEL_DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const MAX_TOOL_PREVIEW_BYTES: usize = 128 * 1024;
const MAX_ACTIVE_TOOLS: usize = 256;
const MAX_PENDING_APPROVALS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Pi,
    Omp,
}

pub struct PiDriver {
    flavor: Flavor,
}

impl PiDriver {
    pub fn pi() -> Self {
        Self { flavor: Flavor::Pi }
    }
    pub fn omp() -> Self {
        Self { flavor: Flavor::Omp }
    }
    fn kind_of(flavor: Flavor) -> ProviderKind {
        match flavor {
            Flavor::Pi => ProviderKind::Pi,
            Flavor::Omp => ProviderKind::Omp,
        }
    }
    fn min_version(flavor: Flavor) -> (u64, u64, u64) {
        match flavor {
            Flavor::Pi => (0, 80, 5),
            Flavor::Omp => (18, 0, 0),
        }
    }

    async fn probe_inner(&self, context: &ProbeContext) -> ProviderStatus {
        let kind = self.kind();
        let mut status = ProviderStatus {
            kind,
            display_name: kind.display_name().into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: match self.flavor {
                Flavor::Pi => vec![PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::FullAccess],
                Flavor::Omp => PermissionMode::ALL.to_vec(),
            },
            supports_fork: true,
            supports_model_switch: true,
            supports_effort_switch: true,
            supported_efforts: vec![],
            models: vec![],
            instances: vec!["default".into()],
        };
        let bin = match resolve(kind, context.binary.as_ref()) {
            Ok(b) => b,
            Err(e) => {
                let hint = match self.flavor {
                    Flavor::Pi => "npm install -g @earendil-works/pi-coding-agent",
                    Flavor::Omp => "npm install -g @oh-my-pi/pi-coding-agent",
                };
                status.unavailable_reason = Some(format!("{e}. Install with: {hint}"));
                return status;
            }
        };
        status.binary_path = Some(bin.display().to_string());
        match version_of(&bin, &["--version"]).await {
            Some(v) => {
                let min = Self::min_version(self.flavor);
                let ok = at_least(&v, min);
                status.available = ok;
                if !ok {
                    status.unavailable_reason =
                        Some(format!("{} {v} is older than the required {}.{}.{}", kind.display_name(), min.0, min.1, min.2));
                }
                status.version = Some(v);
                if ok {
                    status.models = match self.flavor {
                        Flavor::Pi => match models::discover(&bin, context).await {
                            Ok(discovery) => discovery.models,
                            Err(error) => {
                                // The executable still works: an interactive session can answer
                                // startup dialogs and use Pi's own configured model.
                                status.unavailable_reason = Some(format!(
                                    "Model discovery failed: {error}. Start a thread to use Pi's configured model, or refresh models."
                                ));
                                Vec::new()
                            }
                        },
                        Flavor::Omp => omp_models(&bin, context).await,
                    };
                    for model in &status.models {
                        for effort in &model.efforts {
                            if !status.supported_efforts.contains(effort) {
                                status.supported_efforts.push(effort.clone());
                            }
                        }
                    }
                }
            }
            None => status.unavailable_reason = Some(format!("could not run `{} --version`", kind.default_binary())),
        }
        status
    }
}

async fn model_command_output(bin: &std::path::Path, args: &[&str], context: &ProbeContext) -> Option<Vec<u8>> {
    let mut command = Command::new(bin);
    command.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    if let Some(cwd) = &context.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &context.env {
        command.env(key, value);
    }
    match tokio::time::timeout(MODEL_DISCOVERY_TIMEOUT, crate::process_tree::output(&mut command)).await {
        Ok(Ok(output)) if output.status.success() => Some(output.stdout),
        _ => None,
    }
}

async fn omp_models(bin: &std::path::Path, context: &ProbeContext) -> Vec<ProviderModel> {
    let Some(output) = model_command_output(bin, &["models", "ls", "--json"], context).await else { return Vec::new() };
    let Ok(value) = serde_json::from_slice::<Value>(&output) else { return Vec::new() };
    let Some(items) = value.get("models").and_then(Value::as_array) else { return Vec::new() };
    let mut models: Vec<ProviderModel> = items
        .iter()
        .filter_map(|item| {
            let id = item.get("selector").and_then(Value::as_str)?.to_string();
            let provider = item.get("provider").and_then(Value::as_str).map(str::to_string);
            let display_name = item.get("name").and_then(Value::as_str).unwrap_or(&id).to_string();
            let efforts = item
                .get("thinking")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            Some(ProviderModel { is_default: id.ends_with("/default"), id, display_name, provider, efforts, default_effort: None })
        })
        .collect();
    models.sort_by(|a, b| a.provider.cmp(&b.provider).then_with(|| a.display_name.cmp(&b.display_name)));
    models
}

#[async_trait]
impl AgentDriver for PiDriver {
    fn kind(&self) -> ProviderKind {
        Self::kind_of(self.flavor)
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        self.probe_inner(&ProbeContext { binary: binary.cloned(), ..ProbeContext::default() }).await
    }

    async fn probe_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        self.probe_inner(context).await
    }

    async fn list_sessions(
        &self,
        context: &ProbeContext,
        cursor: Option<&str>,
        query: &str,
    ) -> Result<kybern_protocol::methods::SessionsListResult> {
        crate::sessions::list(self.kind(), context, cursor, query).await
    }

    async fn read_session(&self, context: &ProbeContext, id: &str) -> Result<crate::sessions::SessionHistory> {
        crate::sessions::read(self.kind(), context, id).await
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        let kind = self.kind();
        let bin = resolve(kind, config.binary.as_ref())?;
        if self.flavor == Flavor::Pi {
            let version = version_of(&bin, &["--version"])
                .await
                .ok_or_else(|| DriverError::Protocol("Could not read Pi's version. Verify the configured Pi executable.".into()))?;
            if !at_least(&version, Self::min_version(self.flavor)) {
                return Err(DriverError::VersionTooOld { found: version, required: "0.80.5".into() });
            }
            extension::mode_command(config.permission_mode)?;
        }
        let extension = if self.flavor == Flavor::Pi { Some(extension::StagedExtension::new(config.permission_mode)?) } else { None };
        let mut cmd = Command::new(&bin);
        cmd.current_dir(&config.cwd).args(["--mode", "rpc"]);
        let new_session_id = Uuid::new_v4().to_string();
        match self.flavor {
            Flavor::Pi => {
                match (&config.resume_session_id, config.fork) {
                    (Some(id), _) => {
                        // Rewind forks happen after spawn via the `fork {entryId}` command.
                        cmd.args(["--session", id]);
                    }
                    (None, _) => {
                        cmd.args(["--session-id", &new_session_id]);
                    }
                }
            }
            Flavor::Omp => {
                cmd.arg("--cwd").arg(&config.cwd);
                if let Some(id) = &config.resume_session_id {
                    cmd.args(["--resume", id]);
                }
                cmd.args(["--approval-mode", approval_tier(config.permission_mode)]);
            }
        }
        if let Some(model) = &config.model {
            cmd.args(["--model", model]);
        }
        if let Some(effort) = &config.effort {
            cmd.args(["--thinking", effort]);
        }
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        if let Some(extension) = &extension {
            extension.configure(&mut cmd);
        }
        tracing::info!(bin = %bin.display(), cwd = %config.cwd.display(), flavor = ?self.flavor, "spawning pi-family agent");
        let child = Arc::new(NdjsonChild::spawn(cmd)?);

        let mut lifetime = crate::ndjson::SessionLifetime::new(child.clone());
        let (tx, rx) = mpsc::channel(1024);
        let (initialized_tx, initialized) = tokio::sync::watch::channel(None);
        let session = Arc::new(PiSession {
            flavor: self.flavor,
            child,
            events: tx,
            pending: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            state: Mutex::new(State::default()),
            ready: Mutex::new(None),
            initialized,
            command_gate: Mutex::new(()),
            extension,
            pending_app_tools: Mutex::new(HashMap::new()),
        });
        let (ready_tx, ready_rx) = oneshot::channel();
        *session.ready.lock().await = Some(ready_tx);
        let reader = session.clone();
        lifetime.track(tokio::spawn(async move { reader.read_loop().await }));

        let initializing = session.clone();
        lifetime.track(tokio::spawn(async move {
            let result = initializing.initialize(config, new_session_id, ready_rx).await;
            let failed = result.as_ref().err().map(ToString::to_string);
            let _ = initialized_tx.send(Some(result.map_err(|error| error.to_string())));
            if failed.is_some() {
                initializing.child.kill().await;
            }
        }));
        Ok(SpawnedSession { session: Box::new(Handle(session, lifetime)), events: rx })
    }
}

fn approval_tier(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Supervised => "always-ask",
        PermissionMode::AcceptEdits => "write",
        PermissionMode::Auto | PermissionMode::FullAccess => "yolo",
    }
}

#[derive(Default)]
struct State {
    generation: u64,
    admission_revision: u64,
    activity_revision: u64,
    retrying: bool,
    compacting: bool,
    settling: bool,
    prompt_pending: bool,
    native_started: bool,
    manual_compacting: bool,
    closed: bool,
    model: Value,
    default_effort: Option<String>,
    tool_previews: HashMap<String, String>,
    context_window: Option<u64>,
    session_id: Option<String>,
    /// Sequence number for synthetic assistant message ids.
    message_seq: u64,
    current_message: Option<String>,
    current_text: String,
    current_thinking: String,
    turn_usage: Usage,
    turn_cost: f64,
    turn_started: Option<std::time::Instant>,
    turn_error: Option<String>,
    aborted: bool,
    active: bool,
    /// Chunk reassembly for omp protocol v2.
    chunks: HashMap<String, (usize, Vec<Option<String>>)>,
}

struct PiSession {
    flavor: Flavor,
    child: Arc<NdjsonChild>,
    events: mpsc::Sender<DriverEvent>,
    pending: Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>,
    /// UI request id -> registration, for approvals awaiting the user.
    pending_approvals: Mutex<HashMap<String, PendingApproval>>,
    state: Mutex<State>,
    ready: Mutex<Option<oneshot::Sender<()>>>,
    initialized: tokio::sync::watch::Receiver<Option<std::result::Result<(), String>>>,
    command_gate: Mutex<()>,
    extension: Option<extension::StagedExtension>,
    pending_app_tools: Mutex<HashMap<String, u64>>,
}

#[derive(Clone)]
struct PendingApproval {
    kind: String,
    /// Distinguishes a reused native dialog id from an older timeout task.
    nonce: Uuid,
}

struct Handle(Arc<PiSession>, #[allow(dead_code)] crate::ndjson::SessionLifetime);

impl PiSession {
    async fn initialize(self: &Arc<Self>, config: SessionConfig, new_session_id: String, ready_rx: oneshot::Receiver<()>) -> Result<()> {
        let session = self;
        if session.flavor == Flavor::Omp {
            // Wait for `ready`, then negotiate chunked framing so big frames survive.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(30), ready_rx).await;
            let _ = session.call("negotiate_protocol", json!({ "protocolVersion": 2 })).await;
            // OMP keeps subagents on a dedicated observability channel. Progress
            // includes lifecycle, current tool, usage, and detached state without
            // leaking child prose into the parent transcript.
            if let Err(error) = session.call("set_subagent_subscription", json!({ "level": "progress" })).await {
                tracing::debug!(%error, "OMP subagent subscription unavailable");
            }
        }

        // Rewind: fork the persisted session at the first dropped user message.
        if config.fork
            && let Some(entry) = config.rewind.as_ref().and_then(|r| r.drop_from.turn_id.clone())
        {
            let cmd_name = match session.flavor {
                Flavor::Pi => "fork",
                Flavor::Omp => "branch",
            };
            session.call(cmd_name, json!({ "entryId": entry })).await?;
        }

        let state = session.call("get_state", json!({})).await?;
        let session_id = state.get("sessionId").and_then(|s| s.as_str()).map(str::to_string).unwrap_or(new_session_id);
        let model = state.pointer("/model/id").and_then(|m| m.as_str()).map(|id| {
            let provider = state.pointer("/model/provider").and_then(|p| p.as_str()).unwrap_or("");
            if provider.is_empty() { id.to_string() } else { format!("{provider}/{id}") }
        });
        session.update_model_state(&state).await;
        session.state.lock().await.session_id = Some(session_id.clone());
        session.emit(DriverEvent::SessionBound { session_id, model }).await;

        if session.flavor == Flavor::Pi {
            let value = session.call("get_commands", json!({})).await?;
            if let Some(extension) = &session.extension {
                extension.verify(&value)?;
            }
            session.emit_commands(value).await;
        } else if let Ok(value) = session.call("get_commands", json!({})).await {
            session.emit_commands(value).await;
        }
        Ok(())
    }

    async fn emit_commands(&self, mut value: Value) {
        if let Some(commands) = value.get_mut("commands").and_then(Value::as_array_mut) {
            commands.retain(|command| {
                !matches!(command.get("name").and_then(Value::as_str), Some(extension::COMMAND_SENTINEL | extension::MODE_COMMAND))
            });
        }
        self.emit(DriverEvent::CommandsUpdated(crate::provider_commands(&value["commands"]))).await;
    }

    async fn wait_initialized(&self) -> Result<()> {
        let mut initialized = self.initialized.clone();
        loop {
            if let Some(result) = initialized.borrow_and_update().clone() {
                return result.map_err(DriverError::Protocol);
            }
            initialized
                .changed()
                .await
                .map_err(|_| DriverError::ProcessExited("Pi initialization stopped; send again to resume".into()))?;
        }
    }

    async fn update_model_state(&self, state: &Value) {
        let mut st = self.state.lock().await;
        st.context_window = state.pointer("/model/contextWindow").and_then(Value::as_u64);
        st.model = state.get("model").cloned().unwrap_or(Value::Null);
        if st.default_effort.is_none() {
            st.default_effort = state.get("thinkingLevel").and_then(Value::as_str).map(str::to_string);
        }
    }

    async fn emit(&self, ev: DriverEvent) {
        let _ = self.events.send(ev).await;
    }

    async fn call(&self, ty: &str, mut params: Value) -> Result<Value> {
        let timeout = std::time::Duration::from_secs(if matches!(ty, "compact" | "prompt") { 600 } else { 60 });
        self.call_with_timeout(ty, &mut params, timeout).await
    }

    async fn call_with_timeout(&self, ty: &str, params: &mut Value, timeout: std::time::Duration) -> Result<Value> {
        let id = Uuid::new_v4().simple().to_string();
        let (tx, mut rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        params["id"] = Value::String(id.clone());
        params["type"] = Value::String(ty.into());
        if let Err(error) = self.child.write(params).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        loop {
            match tokio::time::timeout(timeout, &mut rx).await {
                Ok(Ok(Ok(v))) => return Ok(v),
                Ok(Ok(Err(e))) => return Err(DriverError::Protocol(format!("{ty}: {e}"))),
                Ok(Err(_)) => return Err(DriverError::ProcessExited("agent exited while waiting for a response".into())),
                Err(_) if !self.pending_approvals.lock().await.is_empty() && !self.state.lock().await.closed => {
                    // User input is not a hung provider. Keep the native request alive
                    // until answered, withdrawn, or interrupted.
                }
                Err(_) => {
                    self.pending.lock().await.remove(&id);
                    if matches!(ty, "compact" | "prompt") {
                        self.child.kill().await;
                    }
                    return Err(DriverError::Protocol(format!("{ty}: timed out; send again to resume the saved conversation")));
                }
            }
        }
    }

    async fn read_loop(self: Arc<Self>) {
        loop {
            let line = {
                let mut rx = self.child.lines.lock().await;
                rx.recv().await
            };
            let Some(v) = line else { break };
            if let Some(v) = self.reassemble(v).await {
                self.handle_frame(v).await;
            }
        }
        let code = self.child.wait().await;
        self.state.lock().await.closed = true;
        self.withdraw_requests().await;
        for (_, tx) in self.pending.lock().await.drain() {
            let _ = tx.send(Err("process exited".into()));
        }
        let error = match code {
            Some(0) | None => None,
            Some(c) => Some(format!("exit code {c}")),
        };
        self.emit(DriverEvent::Exited { code, error }).await;
    }

    /// omp v2 splits frames over 1 MiB into `rpc_chunk` parts.
    async fn reassemble(&self, v: Value) -> Option<Value> {
        if v.get("type").and_then(|t| t.as_str()) != Some("rpc_chunk") {
            return Some(v);
        }
        let chunk_id = v.get("chunkId").and_then(|c| c.as_str())?.to_string();
        let index = v.get("index").and_then(|i| i.as_u64())? as usize;
        let count = v.get("count").and_then(|c| c.as_u64())? as usize;
        let data = v.get("data").and_then(|d| d.as_str())?;
        let decoded = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
        let piece = String::from_utf8(decoded).ok()?;
        let mut st = self.state.lock().await;
        let entry = st.chunks.entry(chunk_id.clone()).or_insert_with(|| (count, vec![None; count]));
        if index < entry.1.len() {
            entry.1[index] = Some(piece);
        }
        if entry.1.iter().all(Option::is_some) {
            let joined: String = entry.1.iter().flatten().cloned().collect();
            st.chunks.remove(&chunk_id);
            return serde_json::from_str(&joined).ok();
        }
        None
    }

    async fn handle_frame(self: &Arc<Self>, v: Value) {
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "ready" => {
                if let Some(tx) = self.ready.lock().await.take() {
                    let _ = tx.send(());
                }
            }
            "response" => {
                let Some(id) = v.get("id").and_then(|i| i.as_str()) else { return };
                if let Some(tx) = self.pending.lock().await.remove(id) {
                    let out = if v.get("success").and_then(|s| s.as_bool()).unwrap_or(false) {
                        Ok(v.get("data").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("error").to_string())
                    };
                    let _ = tx.send(out);
                }
            }
            "agent_start" => {
                let mut st = self.state.lock().await;
                st.native_started = true;
                st.activity_revision += 1;
                if !st.active {
                    st.active = true;
                    st.turn_started = Some(std::time::Instant::now());
                    st.turn_usage = Usage::default();
                    st.turn_cost = 0.0;
                    st.turn_error = None;
                    st.aborted = false;
                }
                let aborted = st.aborted;
                drop(st);
                if aborted {
                    // Stop may arrive during prompt preflight before Pi has a run
                    // to abort. Cancel again as soon as the run is committed.
                    let session = self.clone();
                    tokio::spawn(async move {
                        let _ = session.cancel_native_work().await;
                    });
                }
            }
            "message_start" => {
                let msg = &v["message"];
                if msg.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                    let mut st = self.state.lock().await;
                    st.message_seq += 1;
                    st.current_message = Some(format!("m{}", st.message_seq));
                    st.current_text.clear();
                    st.current_thinking.clear();
                }
            }
            "message_update" => {
                let ev = &v["assistantMessageEvent"];
                let message_id = match self.state.lock().await.current_message.clone() {
                    Some(m) => m,
                    None => return,
                };
                match ev.get("type").and_then(|t| t.as_str()) {
                    Some("text_delta") => {
                        if let Some(d) = ev.get("delta").and_then(|d| d.as_str()) {
                            self.state.lock().await.current_text.push_str(d);
                            self.emit(DriverEvent::TextDelta { message_id, origin: EventOrigin::Root, delta: d.to_string() }).await;
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(d) = ev.get("delta").and_then(|d| d.as_str()) {
                            self.state.lock().await.current_thinking.push_str(d);
                            self.emit(DriverEvent::ThinkingDelta { message_id, origin: EventOrigin::Root, delta: d.to_string() }).await;
                        }
                    }
                    _ => {}
                }
            }
            "message_end" => {
                let message = &v["message"];
                if message["role"].as_str() == Some("assistant") {
                    let window = self.state.lock().await.context_window;
                    if let (Some(window_tokens), Some(usage)) = (window, message.get("usage")) {
                        let used_tokens = ["input", "output", "cacheRead", "cacheWrite"]
                            .iter()
                            .filter_map(|key| usage.get(key).and_then(Value::as_u64))
                            .sum();
                        self.emit(DriverEvent::UsageUpdated(kybern_protocol::ProviderUsage {
                            context: Some(kybern_protocol::ContextUsage { used_tokens, window_tokens }),
                            limits: None,
                        }))
                        .await;
                    }
                }
                let msg = &v["message"];
                if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
                    return;
                }
                let (message_id, text, thinking) = {
                    let mut st = self.state.lock().await;
                    let id = st.current_message.take().unwrap_or_else(|| "m0".into());
                    let mut text = String::new();
                    let mut thinking = String::new();
                    for block in msg.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
                        match block.get("type").and_then(|t| t.as_str()) {
                            Some("text") => text.push_str(block.get("text").and_then(|t| t.as_str()).unwrap_or("")),
                            Some("thinking") => thinking.push_str(block.get("thinking").and_then(|t| t.as_str()).unwrap_or("")),
                            _ => {}
                        }
                    }
                    if let Some(u) = msg.get("usage") {
                        st.turn_usage.input_tokens += u.get("input").and_then(|x| x.as_u64()).unwrap_or(0);
                        st.turn_usage.output_tokens += u.get("output").and_then(|x| x.as_u64()).unwrap_or(0);
                        st.turn_usage.cache_read_tokens += u.get("cacheRead").and_then(|x| x.as_u64()).unwrap_or(0);
                        st.turn_usage.cache_write_tokens += u.get("cacheWrite").and_then(|x| x.as_u64()).unwrap_or(0);
                        st.turn_cost += u.pointer("/cost/total").and_then(|x| x.as_f64()).unwrap_or(0.0);
                    }
                    match msg.get("stopReason").and_then(|s| s.as_str()) {
                        Some("error") => {
                            st.turn_error = Some(msg.get("errorMessage").and_then(|e| e.as_str()).unwrap_or("model error").to_string())
                        }
                        Some("aborted") => st.aborted = true,
                        _ => {}
                    }
                    (id, text, thinking)
                };
                if !text.is_empty() || !thinking.is_empty() {
                    self.emit(DriverEvent::MessageCompleted {
                        message_id,
                        origin: EventOrigin::Root,
                        text,
                        thinking: if thinking.is_empty() { None } else { Some(thinking) },
                    })
                    .await;
                }
            }
            "tool_execution_start" => {
                if let Some(id) = v.get("toolCallId").and_then(Value::as_str) {
                    let mut st = self.state.lock().await;
                    if st.tool_previews.len() < MAX_ACTIVE_TOOLS {
                        st.tool_previews.insert(id.to_string(), String::new());
                    }
                }
                if self.flavor == Flavor::Omp
                    && let Some(task) = omp_background_process(&v)
                {
                    self.emit(DriverEvent::RuntimeTaskStarted(task)).await;
                }
                self.emit(DriverEvent::ToolStarted(ToolCall {
                    id: v.get("toolCallId").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                    name: v.get("toolName").and_then(|n| n.as_str()).unwrap_or("tool").to_string(),
                    input: v.get("args").cloned().unwrap_or(Value::Null),
                    parent_id: None,
                }))
                .await;
            }
            "tool_execution_update" => {
                if let Some(id) = v.get("toolCallId").and_then(Value::as_str) {
                    let snapshot = tool_preview(&v["partialResult"]);
                    let delta = {
                        let mut st = self.state.lock().await;
                        st.tool_previews.get_mut(id).and_then(|previous| {
                            // Pi sends cumulative snapshots. An append-only transcript
                            // can safely stream only an extending prefix; final output
                            // remains authoritative when a tool rewrites its snapshot.
                            let delta = snapshot.strip_prefix(previous.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
                            if delta.is_some() {
                                *previous = snapshot;
                            }
                            delta
                        })
                    };
                    if let Some(delta) = delta {
                        self.emit(DriverEvent::ToolOutputDelta { tool_call_id: id.to_string(), delta }).await;
                    }
                }
                if self.flavor == Flavor::Omp
                    && let Some(task) = omp_background_process(&v)
                {
                    self.emit(DriverEvent::RuntimeTaskStarted(task)).await;
                }
            }
            "tool_execution_end" => {
                if let Some(id) = v.get("toolCallId").and_then(Value::as_str) {
                    self.state.lock().await.tool_previews.remove(id);
                }
                if self.flavor == Flavor::Omp
                    && let Some(task) = omp_background_process(&v)
                {
                    self.emit(DriverEvent::RuntimeTaskStarted(task)).await;
                }
                let content = v.pointer("/result/content").cloned().unwrap_or(Value::Null);
                self.emit(DriverEvent::ToolCompleted {
                    tool_call_id: v.get("toolCallId").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                    output: json!({ "content": content, "details": v.pointer("/result/details") }),
                    is_error: v.get("isError").and_then(|e| e.as_bool()).unwrap_or(false),
                })
                .await;
            }
            "subagent_lifecycle" | "subagent_progress" if self.flavor == Flavor::Omp => {
                if let Some(task) = omp_subagent_task(&v) {
                    self.emit(DriverEvent::RuntimeTaskStarted(task)).await;
                }
            }
            "agent_end" => {
                // pi finishes with `agent_settled`; omp has no such frame and marks the last `agent_end`.
                let terminal = match self.flavor {
                    Flavor::Pi => false,
                    Flavor::Omp => v.get("isTerminal").and_then(|t| t.as_bool()) != Some(false),
                };
                if terminal {
                    self.schedule_finish().await;
                }
            }
            "agent_settled" => {
                self.schedule_finish().await;
            }
            "extension_ui_request" => self.handle_ui_request(&v).await,
            "auto_retry_start" => {
                {
                    let mut st = self.state.lock().await;
                    st.retrying = true;
                    st.activity_revision += 1;
                }
                self.emit(DriverEvent::Notice {
                    level: NoticeLevel::Warning,
                    text: format!("retrying ({})", v.get("errorMessage").and_then(|e| e.as_str()).unwrap_or("provider error")),
                    data: None,
                })
                .await;
            }
            "auto_retry_end" => {
                let mut st = self.state.lock().await;
                st.retrying = false;
                st.activity_revision += 1;
                if v.get("success").and_then(Value::as_bool) == Some(true) {
                    st.turn_error = None;
                } else if !st.aborted {
                    st.turn_error = Some(v.get("finalError").and_then(Value::as_str).unwrap_or("Pi exhausted its retries").to_string());
                }
            }
            "compaction_start" | "auto_compaction_start" => {
                {
                    let mut st = self.state.lock().await;
                    st.activity_revision += 1;
                    st.compacting = true;
                }
                self.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "compacting context".into(), data: None }).await
            }
            "compaction_end" | "auto_compaction_end" => {
                {
                    let mut st = self.state.lock().await;
                    st.activity_revision += 1;
                    st.compacting = false;
                }
                let error = v.get("errorMessage").and_then(Value::as_str);
                if v.get("willRetry").and_then(Value::as_bool) == Some(true) && error.is_none() {
                    self.state.lock().await.turn_error = None;
                }
                self.emit(DriverEvent::Notice {
                    level: if error.is_some() { NoticeLevel::Warning } else { NoticeLevel::Info },
                    text: error.map(|error| format!("Context compaction failed: {error}")).unwrap_or_else(|| {
                        if v.get("aborted").and_then(Value::as_bool) == Some(true) {
                            "Compaction interrupted".into()
                        } else {
                            "Context compacted".into()
                        }
                    }),
                    data: None,
                })
                .await;
            }
            "extension_error" => {
                if let Some(extension) = &self.extension
                    && v.get("extensionPath").and_then(Value::as_str).is_some_and(|path| std::path::Path::new(path) == extension.path())
                {
                    // A broken approval hook must never leave a live unrestricted
                    // Pi process behind. Other user extensions keep their notices.
                    self.state.lock().await.turn_error =
                        Some("Kybern's Pi permission extension failed. Fix the extension error and reconnect.".into());
                    self.child.kill().await;
                }
                self.emit(DriverEvent::Notice {
                    level: NoticeLevel::Warning,
                    text: format!("extension error: {}", v.get("error").and_then(|e| e.as_str()).unwrap_or("")),
                    data: None,
                })
                .await;
            }
            "model_changed" => {
                let session = self.clone();
                tokio::spawn(async move {
                    if let Ok(state) = session.call("get_state", json!({})).await {
                        session.update_model_state(&state).await;
                        let model = state.pointer("/model/id").and_then(Value::as_str).map(|id| {
                            let provider = state.pointer("/model/provider").and_then(Value::as_str).unwrap_or("");
                            if provider.is_empty() { id.to_string() } else { format!("{provider}/{id}") }
                        });
                        let sid = session.state.lock().await.session_id.clone().unwrap_or_default();
                        session.emit(DriverEvent::SessionBound { session_id: sid, model }).await;
                    }
                });
            }
            _ => {}
        }
    }

    async fn admission_revision(&self) -> u64 {
        self.state.lock().await.admission_revision
    }

    async fn begin_turn(&self, manual_compacting: bool, admitted_at: u64) -> Result<Option<u64>> {
        let mut st = self.state.lock().await;
        if st.admission_revision != admitted_at {
            drop(st);
            self.emit(DriverEvent::TurnCompleted {
                stop_reason: StopReason::Interrupted,
                usage: Usage::default(),
                cost_usd: Some(0.0),
                duration_ms: 0,
                anchors: crate::TurnAnchors::default(),
            })
            .await;
            return Ok(None);
        }
        if st.active || st.closed {
            return Err(DriverError::Protocol("Pi is busy or closed. Queue the message or reconnect the session.".into()));
        }
        st.generation += 1;
        st.active = true;
        st.settling = false;
        st.prompt_pending = true;
        st.native_started = false;
        st.retrying = false;
        st.compacting = false;
        st.manual_compacting = manual_compacting;
        st.turn_started = Some(std::time::Instant::now());
        st.turn_usage = Usage::default();
        st.turn_cost = 0.0;
        st.turn_error = None;
        st.aborted = false;
        st.tool_previews.clear();
        Ok(Some(st.generation))
    }

    async fn schedule_finish(self: &Arc<Self>) {
        let generation = {
            let mut st = self.state.lock().await;
            if !st.active || st.settling || st.closed || st.manual_compacting {
                return;
            }
            st.settling = true;
            st.generation
        };
        let session = self.clone();
        tokio::spawn(async move {
            session.finish_turn(generation).await;
        });
    }

    async fn finish_turn(&self, generation: u64) {
        // An admitted steer can still be in prompt preflight when the previous
        // native run settles. Wait for its acknowledgement before testing idle.
        let _gate = self.command_gate.lock().await;
        // A settled callback may start extension compaction or retries. Verify
        // the entire idle/anchor boundary, including events received while the
        // anchor request was pending, before publishing terminal state.
        let (anchor, usage, cost, duration_ms, error, aborted) = loop {
            let revision = {
                let st = self.state.lock().await;
                if !st.active || st.closed || st.generation != generation {
                    return;
                }
                st.activity_revision
            };
            if self.flavor == Flavor::Pi {
                let idle = self.call_with_timeout("get_state", &mut json!({}), std::time::Duration::from_secs(2)).await;
                let mut st = self.state.lock().await;
                if !st.active || st.closed || st.generation != generation {
                    return;
                }
                match idle {
                    Ok(state)
                        if state["isStreaming"] == false
                            && state["isCompacting"] == false
                            && state.get("pendingMessageCount").and_then(Value::as_u64).unwrap_or(0) == 0
                            && revision == st.activity_revision
                            && !st.prompt_pending
                            && !st.retrying
                            && !st.compacting => {}
                    Ok(_) => {
                        drop(st);
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        continue;
                    }
                    Err(error) => {
                        st.turn_error =
                            Some(format!("Could not verify Pi finished: {error}. Send again to resume the saved conversation."));
                        drop(st);
                        self.child.kill().await;
                        return;
                    }
                }
            }
            let list_cmd = if self.flavor == Flavor::Pi { "get_fork_messages" } else { "get_branch_messages" };
            let anchor = self.call_with_timeout(list_cmd, &mut json!({}), std::time::Duration::from_secs(2)).await.ok().and_then(|d| {
                d.get("messages")
                    .and_then(Value::as_array)
                    .and_then(|a| a.last())
                    .and_then(|m| m.get("entryId"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            let mut st = self.state.lock().await;
            if !st.active || st.closed || st.generation != generation {
                return;
            }
            if self.flavor == Flavor::Pi && (st.activity_revision != revision || st.retrying || st.compacting || st.prompt_pending) {
                continue;
            }
            st.active = false;
            st.settling = false;
            st.tool_previews.clear();
            let duration = st.turn_started.take().map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
            break (anchor, std::mem::take(&mut st.turn_usage), st.turn_cost, duration, st.turn_error.take(), st.aborted);
        };
        self.withdraw_requests().await;
        let anchors = crate::TurnAnchors { turn_id: anchor, previous_end: None };
        let ev = if aborted {
            DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, usage, cost_usd: Some(cost), duration_ms, anchors }
        } else if let Some(error) = error {
            DriverEvent::TurnFailed { error }
        } else {
            DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, usage, cost_usd: Some(cost), duration_ms, anchors }
        };
        self.emit(ev).await;
        drop(_gate);
        // Stats cannot delay completion or overwrite the next turn's context.
        if let Ok(stats) = self.call_with_timeout("get_session_stats", &mut json!({}), std::time::Duration::from_secs(2)).await
            && let (Some(used_tokens), Some(window_tokens)) = (
                stats.pointer("/contextUsage/tokens").and_then(Value::as_u64),
                stats.pointer("/contextUsage/contextWindow").and_then(Value::as_u64),
            )
        {
            let event = DriverEvent::UsageUpdated(kybern_protocol::ProviderUsage {
                context: Some(kybern_protocol::ContextUsage { used_tokens, window_tokens }),
                limits: None,
            });
            let Ok(permit) = self.events.reserve().await else { return };
            let st = self.state.lock().await;
            if st.generation != generation || st.active || st.closed {
                return;
            }
            permit.send(event);
        }
    }

    async fn withdraw_requests(&self) {
        let requests: Vec<_> = self.pending_approvals.lock().await.drain().map(|(id, _)| id).collect();
        for request_id in requests {
            let _ = self.child.write(&json!({ "type": "extension_ui_response", "id": request_id, "cancelled": true })).await;
            self.emit(DriverEvent::PermissionWithdrawn { request_id }).await;
        }
        let requests: Vec<_> = self.pending_app_tools.lock().await.drain().map(|(id, _)| id).collect();
        for id in requests {
            let _ = self.child.write(&json!({ "type": "extension_ui_response", "id": id, "cancelled": true })).await;
        }
    }

    async fn cancel_native_work(&self) -> Result<()> {
        // These messages must be sent independently: abort() may wait for work
        // whose completion requires cancelling retry backoff or a queued input.
        if self.flavor == Flavor::Pi {
            for ty in ["clear_queue", "abort_retry"] {
                self.child.write(&json!({ "type": ty, "id": Uuid::new_v4().to_string() })).await?;
            }
        }
        self.child.write(&json!({ "type": "abort", "id": Uuid::new_v4().to_string() })).await
    }

    async fn handle_ui_request(self: &Arc<Self>, v: &Value) {
        let Some(id) = v.get("id").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 128) else {
            return;
        };
        let id = id.to_string();
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
        if self.flavor == Flavor::Pi {
            if let Some(request) = extension::parse_permission_request(&title) {
                match request {
                    Ok(request) if method == "select" => {
                        let event = DriverEvent::PermissionRequest {
                            request_id: id.clone(),
                            tool_call_id: Some(request.tool_call_id),
                            summary: crate::summarize_tool_call(&request.tool_name, &request.input),
                            tool_name: request.tool_name,
                            input: request.input,
                            suggestions: vec![],
                        };
                        self.register_permission(id, "kybern_tool".into(), event, v.get("timeout").and_then(Value::as_u64)).await;
                    }
                    _ => {
                        let _ = self.child.write(&json!({"type":"extension_ui_response","id":id,"cancelled":true})).await;
                    }
                }
                return;
            }
            if let Some(request) = extension::parse_app_tool_request(&title) {
                let st = self.state.lock().await;
                let allowed = st.active && !st.closed && !st.aborted;
                let generation = st.generation;
                drop(st);
                if let Ok(request) = request
                    && method == "input"
                    && allowed
                {
                    let mut pending = self.pending_app_tools.lock().await;
                    if pending.len() < 16 && !pending.contains_key(&id) {
                        pending.insert(id.clone(), generation);
                        drop(pending);
                        self.emit(DriverEvent::AppToolRequest { request_id: id.clone(), name: request.name, arguments: request.arguments })
                            .await;
                        let weak = Arc::downgrade(self);
                        tokio::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                            if let Some(session) = weak.upgrade()
                                && session.pending_app_tools.lock().await.remove(&id).is_some()
                            {
                                let _ = session.child.write(&json!({"type":"extension_ui_response","id":id,"cancelled":true})).await;
                            }
                        });
                        return;
                    }
                }
                let _ = self.child.write(&json!({"type":"extension_ui_response","id":id,"cancelled":true})).await;
                return;
            }
        }
        match method {
            "select" if title.starts_with("Allow tool:") => {
                let mut lines = title.lines();
                let tool_name = lines.next().unwrap_or("").trim_start_matches("Allow tool:").trim().to_string();
                let mut input = serde_json::Map::new();
                for l in lines {
                    if let Some((k, val)) = l.split_once(':') {
                        input.insert(k.trim().to_lowercase(), Value::String(val.trim().to_string()));
                    }
                }
                let summary = match input.get("command").and_then(|c| c.as_str()) {
                    Some(c) => format!("run: {}", c.chars().take(120).collect::<String>()),
                    None => format!("{tool_name}: {}", input.values().filter_map(|v| v.as_str()).next().unwrap_or("")),
                };
                let event = DriverEvent::PermissionRequest {
                    request_id: id.clone(),
                    tool_call_id: None,
                    tool_name: tool_name.clone(),
                    input: Value::Object(input),
                    summary,
                    suggestions: vec![],
                };
                self.register_permission(id, tool_name, event, v.get("timeout").and_then(Value::as_u64)).await;
            }
            "select" | "confirm" | "input" | "editor" => {
                let kind = format!("ui_{method}");
                let event = DriverEvent::PermissionRequest {
                    request_id: id.clone(),
                    tool_call_id: None,
                    tool_name: kind.clone(),
                    input: v.clone(),
                    summary: title,
                    suggestions: vec![],
                };
                self.register_permission(id, kind, event, v.get("timeout").and_then(Value::as_u64)).await;
            }
            "notify" => {
                let level = match v.get("notifyType").and_then(|t| t.as_str()) {
                    Some("error") => NoticeLevel::Error,
                    Some("warning") => NoticeLevel::Warning,
                    _ => NoticeLevel::Info,
                };
                self.emit(DriverEvent::Notice {
                    level,
                    text: v.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string(),
                    data: None,
                })
                .await;
            }
            _ => {}
        }
    }

    async fn register_permission(self: &Arc<Self>, id: String, kind: String, event: DriverEvent, timeout: Option<u64>) {
        let Ok(permit) = self.events.reserve().await else {
            self.cancel_ui_request(&id).await;
            return;
        };
        let nonce = Uuid::new_v4();
        let registered = {
            // Stop takes this lock before withdrawing requests. Holding it
            // through insertion and the non-async event send makes the two
            // operations one ordered registration boundary.
            let state = self.state.lock().await;
            if !permission_state_available(&state) {
                false
            } else {
                let mut pending = self.pending_approvals.lock().await;
                if pending.len() >= MAX_PENDING_APPROVALS || pending.contains_key(&id) {
                    false
                } else {
                    pending.insert(id.clone(), PendingApproval { kind, nonce });
                    permit.send(event);
                    true
                }
            }
        };
        if registered {
            self.expire_permission(id, nonce, timeout);
        } else {
            self.cancel_ui_request(&id).await;
        }
    }

    async fn cancel_ui_request(&self, id: &str) {
        let _ = self.child.write(&json!({"type":"extension_ui_response","id":id,"cancelled":true})).await;
    }

    fn expire_permission(self: &Arc<Self>, id: String, nonce: Uuid, timeout: Option<u64>) {
        if let Some(timeout) = timeout {
            let weak = Arc::downgrade(self);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(timeout)).await;
                let Some(session) = weak.upgrade() else { return };
                let Ok(permit) = session.events.reserve().await else { return };
                let expired = {
                    let state = session.state.lock().await;
                    if !permission_state_available(&state) {
                        false
                    } else {
                        let mut pending = session.pending_approvals.lock().await;
                        if pending.get(&id).is_some_and(|approval| approval.nonce == nonce) {
                            pending.remove(&id);
                            permit.send(DriverEvent::PermissionWithdrawn { request_id: id.clone() });
                            true
                        } else {
                            false
                        }
                    }
                };
                if expired {
                    session.cancel_ui_request(&id).await;
                }
            });
        }
    }
}

fn permission_state_available(state: &State) -> bool {
    !state.aborted && !state.closed
}

fn omp_runtime_status(status: &str) -> RuntimeTaskStatus {
    match status {
        "pending" => RuntimeTaskStatus::Pending,
        "completed" => RuntimeTaskStatus::Completed,
        "failed" | "error" => RuntimeTaskStatus::Failed,
        "aborted" | "cancelled" | "canceled" | "stopped" => RuntimeTaskStatus::Stopped,
        "waiting" | "idle" | "parked" => RuntimeTaskStatus::Waiting,
        _ => RuntimeTaskStatus::Running,
    }
}

fn first_line(value: &str) -> String {
    value.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or(value).chars().take(120).collect()
}

/// Normalize OMP's dedicated RPC subagent frames. `RuntimeTaskStarted` is used
/// as an upsert carrier for both snapshots and progress; the daemon preserves
/// the original start time and emits the appropriate durable update event.
fn omp_subagent_task(frame: &Value) -> Option<DriverRuntimeTask> {
    let payload = frame.get("payload")?;
    let progress = payload.get("progress");
    let id = progress.and_then(|value| value.get("id")).or_else(|| payload.get("id")).and_then(Value::as_str)?.to_string();
    let agent =
        payload.get("agent").or_else(|| progress.and_then(|value| value.get("agent"))).and_then(Value::as_str).unwrap_or("subagent");
    let status = progress
        .and_then(|value| value.get("status"))
        .or_else(|| payload.get("status"))
        .and_then(Value::as_str)
        .map(omp_runtime_status)
        .unwrap_or(RuntimeTaskStatus::Running);
    let title = payload
        .get("task")
        .or_else(|| progress.and_then(|value| value.get("task")))
        .or_else(|| payload.get("description"))
        .or_else(|| progress.and_then(|value| value.get("description")))
        .or_else(|| payload.get("assignment"))
        .and_then(Value::as_str)
        .map(first_line)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{agent} subagent"));
    let detail = progress
        .and_then(|value| value.get("lastIntent"))
        .or_else(|| payload.get("assignment"))
        .and_then(Value::as_str)
        .map(first_line)
        .filter(|value| !value.is_empty());
    let last_tool_name = progress.and_then(|value| value.get("currentTool")).and_then(Value::as_str).map(str::to_string);
    let stats = RuntimeTaskStats {
        token_count: progress.and_then(|value| value.get("tokens")).and_then(Value::as_u64),
        tool_uses: progress.and_then(|value| value.get("toolCount")).and_then(Value::as_u64),
        duration_ms: progress.and_then(|value| value.get("durationMs")).and_then(Value::as_u64),
        cpu_percent: None,
        rss_kb: None,
    };
    let model = progress.and_then(|value| value.get("resolvedModel")).and_then(Value::as_str).map(str::to_string);

    Some(DriverRuntimeTask {
        id: format!("omp-agent:{id}"),
        kind: RuntimeTaskKind::Agent,
        status,
        title,
        detail,
        provider_type: Some(format!("subagent:{agent}")),
        parent_id: None,
        tool_call_id: payload.get("parentToolCallId").and_then(Value::as_str).map(str::to_string),
        provider_thread_id: Some(id),
        model,
        effort: None,
        backgrounded: payload.get("detached").and_then(Value::as_bool).unwrap_or(false),
        last_tool_name,
        usage: None,
        stats,
        // OMP exposes observation and transcripts over RPC, but targeted
        // cancellation/backgrounding remains a model-facing `hub` operation.
        capabilities: RuntimeTaskCapabilities::default(),
    })
}

fn omp_background_process(frame: &Value) -> Option<DriverRuntimeTask> {
    if frame.get("toolName").and_then(Value::as_str)? != "bash" {
        return None;
    }
    let args = frame.get("args").unwrap_or(&Value::Null);
    let async_details = frame
        .pointer("/partialResult/details/async")
        .or_else(|| frame.pointer("/result/details/async"))
        .or_else(|| frame.pointer("/details/async"));
    let explicitly_async = args.get("async").and_then(Value::as_bool) == Some(true);
    if async_details.is_none() && !explicitly_async {
        return None;
    }
    let tool_call_id = frame.get("toolCallId").and_then(Value::as_str)?.to_string();
    let async_state = async_details.and_then(|value| value.get("state")).and_then(Value::as_str).unwrap_or("running");
    let status = omp_runtime_status(async_state);
    let command = args.get("command").and_then(Value::as_str).map(first_line).filter(|value| !value.is_empty());
    let detail_root = frame.pointer("/partialResult/details").or_else(|| frame.pointer("/result/details")).or_else(|| frame.get("details"));
    let stats = RuntimeTaskStats {
        token_count: None,
        tool_uses: None,
        duration_ms: detail_root.and_then(|value| value.get("durationMs").or_else(|| value.get("elapsedMs"))).and_then(Value::as_u64),
        cpu_percent: None,
        rss_kb: None,
    };

    Some(DriverRuntimeTask {
        id: format!("tool:{tool_call_id}"),
        kind: RuntimeTaskKind::Process,
        status,
        title: command.unwrap_or_else(|| "Background process".into()),
        detail: None,
        provider_type: Some("bash".into()),
        parent_id: None,
        tool_call_id: Some(tool_call_id),
        provider_thread_id: async_details.and_then(|value| value.get("jobId")).and_then(Value::as_str).map(str::to_string),
        model: None,
        effort: None,
        backgrounded: true,
        last_tool_name: None,
        usage: None,
        stats,
        capabilities: RuntimeTaskCapabilities::default(),
    })
}

fn tool_preview(result: &Value) -> String {
    let mut text = String::new();
    for block in result.get("content").and_then(Value::as_array).into_iter().flatten() {
        if block["type"] != "text" {
            continue;
        }
        let value = block.get("text").and_then(Value::as_str).unwrap_or("");
        let remaining = MAX_TOOL_PREVIEW_BYTES.saturating_sub(text.len());
        let mut end = remaining.min(value.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        text.push_str(&value[..end]);
        if text.len() == MAX_TOOL_PREVIEW_BYTES {
            break;
        }
    }
    text
}

fn images(message: &UserMessage) -> Vec<Value> {
    message
        .parts
        .iter()
        .filter_map(|p| match p {
            ContentPart::Image { media_type, data } => Some(json!({ "type": "image", "data": data, "mimeType": media_type })),
            _ => None,
        })
        .collect()
}

fn prompt_text(message: &UserMessage) -> String {
    let mut out = String::new();
    let mut skills = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text } => out.push_str(text),
            ContentPart::FileMention { path } => {
                out.push('@');
                out.push_str(path);
            }
            ContentPart::Skill { name, .. } => {
                if !name.is_empty() && !name.chars().any(char::is_whitespace) && !skills.contains(name) {
                    skills.push(name.clone());
                }
            }
            ContentPart::Mention { name, .. } => {
                out.push('@');
                out.push_str(name);
            }
            ContentPart::Image { .. } => out.push_str("[image]"),
            ContentPart::Attachment { name, .. } => {
                out.push('[');
                out.push_str(name);
                out.push(']');
            }
        }
    }
    if skills.is_empty() {
        out
    } else {
        format!("{} {}", skills.into_iter().map(|name| format!("/skill:{name}")).collect::<Vec<_>>().join(" "), out)
    }
}

#[async_trait]
impl AgentSession for Handle {
    async fn compact(&self) -> Result<()> {
        let admitted_at = self.0.admission_revision().await;
        self.0.wait_initialized().await?;
        let _gate = self.0.command_gate.lock().await;
        let Some(generation) = self.0.begin_turn(true, admitted_at).await? else { return Ok(()) };
        self.0.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "Compacting context…".into(), data: None }).await;
        let result = self.0.call("compact", json!({})).await;
        {
            let mut st = self.0.state.lock().await;
            if st.generation != generation {
                return result.map(|_| ());
            }
            st.prompt_pending = false;
            st.manual_compacting = false;
            if result.is_err() && !st.aborted {
                // Delivery failures are terminalized by the orchestrator. Do not
                // also publish a completion for the same failed compact request.
                st.active = false;
                st.settling = false;
                return result.map(|_| ());
            }
        }
        // Compaction's response is authoritative even without agent lifecycle frames.
        self.0.schedule_finish().await;
        Ok(())
    }

    async fn send_message(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        let s = &self.0;
        let admitted_at = s.admission_revision().await;
        s.wait_initialized().await?;
        let _gate = s.command_gate.lock().await;
        let Some(generation) = s.begin_turn(false, admitted_at).await? else { return Ok(()) };
        let text = prompt_text(message);
        let mut params = json!({ "message": text });
        let imgs = images(message);
        if !imgs.is_empty() {
            params["images"] = Value::Array(imgs);
        }
        let result = s.call("prompt", params).await;
        let (no_run, interrupted, open) = {
            let mut st = s.state.lock().await;
            if st.generation != generation {
                return result.map(|_| ());
            }
            st.prompt_pending = false;
            if result.is_err() && !st.aborted {
                st.active = false;
                st.settling = false;
            }
            (!st.native_started, st.aborted, !st.closed)
        };
        if result.is_err() && interrupted {
            if open {
                s.schedule_finish().await;
            }
            return Ok(());
        }
        result?;
        // Extension commands and input hooks may consume ordinary text too.
        // Confirm a runless acknowledgement against native state before completion.
        if no_run {
            let state = s.call("get_state", json!({})).await?;
            if state["isStreaming"] == false && state["isCompacting"] == false {
                s.schedule_finish().await;
            }
        }
        Ok(())
    }

    async fn steer(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        self.0.wait_initialized().await?;
        let _gate = self.0.command_gate.lock().await;
        {
            let st = self.0.state.lock().await;
            if !st.active || st.aborted || st.closed || st.manual_compacting || st.settling {
                return Err(DriverError::Unsupported("Pi is finishing or stopping this turn. Queue the message instead.".into()));
            }
        }
        let mut params = json!({ "message": prompt_text(message), "streamingBehavior": "steer" });
        let imgs = images(message);
        if !imgs.is_empty() {
            params["images"] = Value::Array(imgs);
        }
        // Pi atomically runs extension commands or steers the active run. Unlike
        // a bare `steer`, an input at the idle boundary cannot be orphaned.
        self.0.call("prompt", params).await.map(|_| ())
    }

    async fn interrupt(&self) -> Result<()> {
        {
            let mut st = self.0.state.lock().await;
            st.admission_revision = st.admission_revision.wrapping_add(1);
            st.aborted = true;
        }
        self.0.withdraw_requests().await;
        self.0.cancel_native_work().await
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        self.0.wait_initialized().await?;
        let _gate = self.0.command_gate.lock().await;
        if self.0.state.lock().await.closed {
            return Err(DriverError::ProcessExited("Pi session is closed; send again to resume".into()));
        }
        if self.0.flavor == Flavor::Omp {
            return Err(DriverError::Unsupported("approval mode is fixed when the agent starts; start a new thread to change it".into()));
        }
        self.0.call("prompt", json!({ "message": extension::mode_command(mode)? })).await.map(|_| ())
    }

    async fn set_model(&self, model: &str) -> Result<()> {
        self.0.wait_initialized().await?;
        let _gate = self.0.command_gate.lock().await;
        let Some((provider, model_id)) = model.split_once('/') else {
            return Err(DriverError::Unsupported(format!("models are named provider/model, got {model}")));
        };
        self.0.call("set_model", json!({ "provider": provider, "modelId": model_id })).await?;
        let state = self.0.call("get_state", json!({})).await?;
        self.0.update_model_state(&state).await;
        Ok(())
    }

    async fn set_effort(&self, effort: &str) -> Result<()> {
        self.0.wait_initialized().await?;
        let _gate = self.0.command_gate.lock().await;
        let level = if self.0.flavor == Flavor::Pi {
            let st = self.0.state.lock().await;
            let supported = models::model_supported_efforts(&st.model);
            if supported.is_empty() && effort.is_empty() {
                return Ok(());
            }
            let requested = if effort.is_empty() { st.default_effort.as_deref() } else { Some(effort) };
            let level = models::effective_effort(requested, &supported)
                .ok_or_else(|| DriverError::Unsupported("The selected Pi model does not expose thinking levels.".into()))?;
            if !effort.is_empty() && !supported.iter().any(|item| item == effort) {
                return Err(DriverError::Unsupported(format!("Pi model does not support thinking level {effort}. Choose a listed level.")));
            }
            level
        } else {
            effort.to_string()
        };
        self.0.call("set_thinking_level", json!({ "level": level })).await.map(|_| ())
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let response = {
            // Stop takes the same state lock before withdrawing approvals. A
            // response either claims the live request first or observes the
            // stopped state; it cannot resurrect or answer a drained dialog.
            let state = self.0.state.lock().await;
            if !permission_state_available(&state) {
                return Err(DriverError::Protocol("Pi permission request belongs to a finished turn".into()));
            }
            let mut pending = self.0.pending_approvals.lock().await;
            let Some(approval) = pending.get(request_id) else {
                return Err(DriverError::Protocol(format!("no pending approval {request_id}")));
            };
            let response = if approval.kind == "kybern_tool" {
                json!({
                    "type": "extension_ui_response",
                    "id": request_id,
                    "value": extension::permission_response(decision)?,
                })
            } else if approval.kind.starts_with("ui_") {
                let mut response = match decision {
                    ApprovalDecision::Submit { response } if response.is_object() => response.clone(),
                    ApprovalDecision::Deny { .. } => json!({ "cancelled": true }),
                    _ => return Err(DriverError::Protocol("this dialog needs an answer".into())),
                };
                response["type"] = json!("extension_ui_response");
                response["id"] = json!(request_id);
                response
            } else {
                let value = match decision {
                    ApprovalDecision::Submit { .. } => return Err(DriverError::Protocol("expected permission decision".into())),
                    ApprovalDecision::AllowOnce | ApprovalDecision::AllowAlways => "Approve",
                    ApprovalDecision::Deny { .. } => "Deny",
                };
                json!({ "type": "extension_ui_response", "id": request_id, "value": value })
            };
            pending.remove(request_id);
            response
        };
        self.0.child.write(&response).await
    }

    async fn respond_app_tool(&self, request_id: &str, result: std::result::Result<Value, String>) -> Result<()> {
        let generation = self
            .0
            .pending_app_tools
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| DriverError::Protocol("Pi app tool request has expired".into()))?;
        let st = self.0.state.lock().await;
        if st.generation != generation || !st.active || st.aborted || st.closed {
            return Err(DriverError::Protocol("Pi app tool request belongs to a finished turn".into()));
        }
        drop(st);
        let value = match result {
            Ok(data) => extension::encode_app_tool_result(true, Some(&data), None),
            Err(error) => extension::encode_app_tool_result(false, None, Some(&error)),
        };
        self.0.child.write(&json!({"type":"extension_ui_response","id":request_id,"value":value})).await
    }

    async fn close(&self) -> Result<()> {
        self.0.state.lock().await.closed = true;
        self.0.withdraw_requests().await;
        let _ = self.0.cancel_native_work().await;
        self.0.child.close().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {

    #[tokio::test]
    async fn manual_compaction_waits_for_native_response_for_both_flavors() {
        use super::*;
        for flavor in [Flavor::Pi, Flavor::Omp] {
            let child = Arc::new(NdjsonChild::spawn(Command::new("cat")).unwrap());
            let (events, mut rx) = mpsc::channel(8);
            let session = Arc::new(PiSession {
                flavor,
                child: child.clone(),
                events,
                pending: Mutex::new(HashMap::new()),
                pending_approvals: Mutex::new(HashMap::new()),
                state: Mutex::new(State::default()),
                ready: Mutex::new(None),
                initialized: tokio::sync::watch::channel(Some(Ok(()))).1,
                command_gate: Mutex::new(()),
                extension: None,
                pending_app_tools: Mutex::new(HashMap::new()),
            });
            let handle = Handle(session.clone(), crate::ndjson::SessionLifetime::new(child.clone()));
            let task = tokio::spawn(async move {
                let result = handle.compact().await;
                (handle, result)
            });
            let request =
                tokio::time::timeout(Duration::from_secs(1), async { child.lines.lock().await.recv().await.unwrap() }).await.unwrap();
            assert_eq!(request["type"], "compact");
            assert!(!task.is_finished());
            assert!(matches!(rx.recv().await, Some(DriverEvent::Notice { .. })));
            assert!(rx.try_recv().is_err());
            session
                .pending
                .lock()
                .await
                .remove(request["id"].as_str().unwrap())
                .unwrap()
                .send(Ok(json!({"summary":"kept context"})))
                .unwrap();
            let (handle, result) = task.await.unwrap();
            result.unwrap();
            let answering = session.clone();
            let responder = tokio::spawn(async move {
                while let Some(request) = answering.child.lines.lock().await.recv().await {
                    if let Some(id) = request["id"].as_str()
                        && let Some(response) = answering.pending.lock().await.remove(id)
                    {
                        let data = if request["type"] == "get_state" {
                            json!({"isStreaming":false,"isCompacting":false})
                        } else {
                            json!({"messages":[]})
                        };
                        let _ = response.send(Ok(data));
                    }
                }
            });
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap(),
                Some(DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. })
            ));
            handle.close().await.unwrap();
            responder.abort();
        }
    }

    #[tokio::test]
    async fn extension_dialogs_round_trip_for_pi_and_omp() {
        use super::*;
        for flavor in [Flavor::Pi, Flavor::Omp] {
            let child = Arc::new(NdjsonChild::spawn(Command::new("cat")).unwrap());
            let (events, mut rx) = mpsc::channel(8);
            let session = Arc::new(PiSession {
                flavor,
                child: child.clone(),
                events,
                pending: Mutex::new(HashMap::new()),
                pending_approvals: Mutex::new(HashMap::new()),
                state: Mutex::new(State::default()),
                ready: Mutex::new(None),
                initialized: tokio::sync::watch::channel(Some(Ok(()))).1,
                command_gate: Mutex::new(()),
                extension: None,
                pending_app_tools: Mutex::new(HashMap::new()),
            });
            let handle = Handle(session.clone(), crate::ndjson::SessionLifetime::new(session.child.clone()));
            for (method, response) in [
                ("select", json!({"value":"Option B"})),
                ("confirm", json!({"confirmed":false})),
                ("input", json!({"value":"typed answer"})),
                ("editor", json!({"value":"line one\nline two"})),
            ] {
                session
                    .handle_ui_request(&json!({ "id": method, "method": method, "title": "Choose", "options": ["Option A", "Option B"] }))
                    .await;
                assert!(
                    matches!(rx.recv().await, Some(DriverEvent::PermissionRequest { tool_name, .. }) if tool_name == format!("ui_{method}"))
                );
                handle.respond_permission(method, &ApprovalDecision::Submit { response: response.clone() }).await.unwrap();
                let wire =
                    tokio::time::timeout(Duration::from_secs(1), async { child.lines.lock().await.recv().await.unwrap() }).await.unwrap();
                assert_eq!(wire["id"], method);
                assert_eq!(wire["type"], "extension_ui_response");
                for (key, value) in response.as_object().unwrap() {
                    assert_eq!(&wire[key], value);
                }
            }
            session.handle_ui_request(&json!({ "id":"timeout", "method":"input", "title":"Expires", "timeout": 1 })).await;
            let _ = rx.recv().await;
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.unwrap(),
                Some(DriverEvent::PermissionWithdrawn { .. })
            ));
            child.kill().await;
        }
    }
    use super::*;
    use std::time::Duration;

    #[test]
    fn omp_model_discovery_budget_covers_a_cold_registry_refresh() {
        assert!(MODEL_DISCOVERY_TIMEOUT >= Duration::from_secs(10));
    }

    #[test]
    fn maps_omp_native_subagent_lifecycle_and_progress() {
        let started = omp_subagent_task(&json!({
            "type": "subagent_lifecycle",
            "payload": {
                "id": "QuietRiver",
                "index": 0,
                "agent": "scout",
                "agentSource": "bundled",
                "description": "Inspect provider parity",
                "status": "started",
                "sessionFile": "/tmp/QuietRiver.jsonl",
                "parentToolCallId": "tool-task-1",
                "detached": true
            }
        }))
        .expect("native OMP task");
        assert_eq!(started.id, "omp-agent:QuietRiver");
        assert_eq!(started.kind, RuntimeTaskKind::Agent);
        assert_eq!(started.status, RuntimeTaskStatus::Running);
        assert_eq!(started.title, "Inspect provider parity");
        assert_eq!(started.tool_call_id.as_deref(), Some("tool-task-1"));
        assert_eq!(started.provider_thread_id.as_deref(), Some("QuietRiver"));
        assert!(started.backgrounded);
        assert!(!started.capabilities.stop);

        let progress = omp_subagent_task(&json!({
            "type": "subagent_progress",
            "payload": {
                "index": 0,
                "agent": "scout",
                "agentSource": "bundled",
                "task": "Inspect every registered provider",
                "parentToolCallId": "tool-task-1",
                "detached": true,
                "progress": {
                    "id": "QuietRiver",
                    "index": 0,
                    "agent": "scout",
                    "agentSource": "bundled",
                    "status": "running",
                    "task": "Inspect every registered provider",
                    "currentTool": "grep",
                    "toolCount": 7,
                    "tokens": 1234,
                    "durationMs": 2500,
                    "recentTools": [],
                    "recentOutput": [],
                    "cost": 0.0
                }
            }
        }))
        .expect("native OMP progress");
        assert_eq!(progress.id, started.id);
        assert_eq!(progress.title, "Inspect every registered provider");
        assert_eq!(progress.last_tool_name.as_deref(), Some("grep"));
        assert_eq!(progress.stats.tool_uses, Some(7));
        assert_eq!(progress.stats.token_count, Some(1234));
        assert_eq!(progress.stats.duration_ms, Some(2500));
    }

    #[test]
    fn maps_omp_managed_background_bash_updates() {
        let task = omp_background_process(&json!({
            "type": "tool_execution_update",
            "toolCallId": "tool-bash-1",
            "toolName": "bash",
            "args": { "command": "pnpm dev" },
            "partialResult": {
                "details": {
                    "async": { "state": "running", "jobId": "job-42", "type": "bash" }
                }
            }
        }))
        .expect("managed background process");
        assert_eq!(task.id, "tool:tool-bash-1");
        assert_eq!(task.kind, RuntimeTaskKind::Process);
        assert_eq!(task.status, RuntimeTaskStatus::Running);
        assert_eq!(task.title, "pnpm dev");
        assert_eq!(task.provider_thread_id.as_deref(), Some("job-42"));
        assert!(task.backgrounded);
    }

    #[test]
    fn pi_and_omp_use_their_native_skill_command_prefix() {
        let message = UserMessage {
            parts: vec![
                ContentPart::Text { text: "Use ".into() },
                ContentPart::Skill { name: "review".into(), path: "/skills/review/SKILL.md".into() },
                ContentPart::Text { text: " now".into() },
            ],
        };
        assert_eq!(prompt_text(&message), "/skill:review Use  now");
    }

    #[tokio::test]
    async fn omp_terminal_frame_completes_while_anchor_response_is_read() {
        let mut command = Command::new("sh");
        command.arg("-c").arg(
            r#"
printf '%s\n' '{"type":"agent_end","isTerminal":true}'
IFS= read -r line
id=${line#*\"id\":\"}
id=${id%%\"*}
printf '{"id":"%s","type":"response","command":"get_branch_messages","success":true,"data":{"messages":[{"entryId":"entry-1"}]}}\n' "$id"
cat >/dev/null
"#,
        );
        let child = Arc::new(NdjsonChild::spawn(command).expect("spawn fake omp"));
        let (events, mut rx) = mpsc::channel(8);
        let session = Arc::new(PiSession {
            flavor: Flavor::Omp,
            child,
            events,
            pending: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            state: Mutex::new(State { active: true, ..State::default() }),
            ready: Mutex::new(None),
            initialized: tokio::sync::watch::channel(Some(Ok(()))).1,
            command_gate: Mutex::new(()),
            extension: None,
            pending_app_tools: Mutex::new(HashMap::new()),
        });
        let reader = session.clone();
        tokio::spawn(async move { reader.read_loop().await });

        let completed = tokio::time::timeout(Duration::from_secs(1), async {
            while let Some(event) = rx.recv().await {
                if let DriverEvent::TurnCompleted { anchors, .. } = event {
                    return anchors.turn_id;
                }
            }
            None
        })
        .await
        .expect("OMP terminal frame should not block its own response reader");

        assert_eq!(completed.as_deref(), Some("entry-1"));
        session.child.kill().await;
    }
}
