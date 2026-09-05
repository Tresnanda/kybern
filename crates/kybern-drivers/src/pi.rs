//! pi and Oh My Pi (omp) driver: JSONL RPC over stdio (`--mode rpc`).
//!
//! omp is a fork of pi with a superset protocol, so one module drives both
//! with a `Flavor` switch. Differences that matter here: omp announces itself
//! with a `ready` frame and supports chunked frames after protocol
//! negotiation; omp has built-in approval tiers surfaced as `select` UI
//! requests, pi has none (so pi runs as Full access only); pi signals run
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

const MODEL_DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

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
            Flavor::Pi => (0, 80, 0),
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
                Flavor::Pi => vec![PermissionMode::FullAccess],
                Flavor::Omp => PermissionMode::ALL.to_vec(),
            },
            supports_fork: true,
            supports_model_switch: true,
            supports_effort_switch: self.flavor == Flavor::Omp,
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
                        Flavor::Pi => pi_models(&bin, context).await,
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
    match tokio::time::timeout(MODEL_DISCOVERY_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => Some(output.stdout),
        _ => None,
    }
}

fn parse_pi_models(output: &[u8]) -> Vec<ProviderModel> {
    let mut models = String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let columns = line.split_whitespace().collect::<Vec<_>>();
            if columns.len() < 6
                || (columns[0].eq_ignore_ascii_case("provider") && columns[1].eq_ignore_ascii_case("model"))
                || !matches!(columns[columns.len() - 2], "yes" | "no")
                || !matches!(columns[columns.len() - 1], "yes" | "no")
            {
                return None;
            }
            let provider = columns[0].to_string();
            let model = columns[1].to_string();
            Some(ProviderModel {
                id: format!("{provider}/{model}"),
                display_name: model,
                provider: Some(provider),
                efforts: Vec::new(),
                default_effort: None,
                is_default: false,
            })
        })
        .collect::<Vec<_>>();
    models.sort_by(|a, b| a.provider.cmp(&b.provider).then_with(|| a.display_name.cmp(&b.display_name)));
    models
}

async fn pi_models(bin: &std::path::Path, context: &ProbeContext) -> Vec<ProviderModel> {
    model_command_output(bin, &["--list-models"], context).await.map_or_else(Vec::new, |output| parse_pi_models(&output))
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

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        let kind = self.kind();
        let bin = resolve(kind, config.binary.as_ref())?;
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
                cmd.arg("--approve");
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
        if self.flavor == Flavor::Omp
            && let Some(effort) = &config.effort
        {
            cmd.args(["--thinking", effort]);
        }
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        tracing::info!(bin = %bin.display(), cwd = %config.cwd.display(), flavor = ?self.flavor, "spawning pi-family agent");
        let child = Arc::new(NdjsonChild::spawn(cmd)?);

        let (tx, rx) = mpsc::channel(1024);
        let session = Arc::new(PiSession {
            flavor: self.flavor,
            child,
            events: tx,
            pending: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            state: Mutex::new(State::default()),
            ready: Mutex::new(None),
        });
        let (ready_tx, ready_rx) = oneshot::channel();
        *session.ready.lock().await = Some(ready_tx);
        let reader = session.clone();
        tokio::spawn(async move { reader.read_loop().await });

        if self.flavor == Flavor::Omp {
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
            let cmd_name = match self.flavor {
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
        session.state.lock().await.session_id = Some(session_id.clone());
        session.emit(DriverEvent::SessionBound { session_id, model }).await;

        Ok(SpawnedSession { session: Box::new(Handle(session)), events: rx })
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
    /// UI request id -> tool name, for approvals awaiting the user.
    pending_approvals: Mutex<HashMap<String, String>>,
    state: Mutex<State>,
    ready: Mutex<Option<oneshot::Sender<()>>>,
}

struct Handle(Arc<PiSession>);

impl PiSession {
    async fn emit(&self, ev: DriverEvent) {
        let _ = self.events.send(ev).await;
    }

    async fn call(&self, ty: &str, mut params: Value) -> Result<Value> {
        let id = Uuid::new_v4().simple().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        params["id"] = Value::String(id.clone());
        params["type"] = Value::String(ty.into());
        self.child.write(&params).await?;
        match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(DriverError::Protocol(format!("{ty}: {e}"))),
            Ok(Err(_)) => Err(DriverError::ProcessExited("agent exited while waiting for a response".into())),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(DriverError::Protocol(format!("{ty}: timed out")))
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
                if !st.active {
                    st.active = true;
                    st.turn_started = Some(std::time::Instant::now());
                    st.turn_usage = Usage::default();
                    st.turn_cost = 0.0;
                    st.turn_error = None;
                    st.aborted = false;
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
                if self.flavor == Flavor::Omp
                    && let Some(task) = omp_background_process(&v)
                {
                    self.emit(DriverEvent::RuntimeTaskStarted(task)).await;
                }
            }
            "tool_execution_end" => {
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
                    let session = self.clone();
                    tokio::spawn(async move { session.finish_turn().await });
                }
            }
            "agent_settled" => {
                let session = self.clone();
                tokio::spawn(async move { session.finish_turn().await });
            }
            "extension_ui_request" => self.handle_ui_request(&v).await,
            "auto_retry_start" => {
                self.emit(DriverEvent::Notice {
                    level: NoticeLevel::Warning,
                    text: format!("retrying ({})", v.get("errorMessage").and_then(|e| e.as_str()).unwrap_or("provider error")),
                    data: None,
                })
                .await;
            }
            "compaction_start" | "auto_compaction_start" => {
                self.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "compacting context".into(), data: None }).await
            }
            "extension_error" => {
                self.emit(DriverEvent::Notice {
                    level: NoticeLevel::Warning,
                    text: format!("extension error: {}", v.get("error").and_then(|e| e.as_str()).unwrap_or("")),
                    data: None,
                })
                .await;
            }
            "model_changed" => {
                let model = v.get("model").and_then(|m| m.as_str()).map(str::to_string);
                let sid = self.state.lock().await.session_id.clone().unwrap_or_default();
                self.emit(DriverEvent::SessionBound { session_id: sid, model }).await;
            }
            _ => {}
        }
    }

    async fn finish_turn(&self) {
        let (usage, cost, duration_ms, error, aborted, active) = {
            let mut st = self.state.lock().await;
            let active = st.active;
            st.active = false;
            let d = st.turn_started.take().map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
            (std::mem::take(&mut st.turn_usage), st.turn_cost, d, st.turn_error.take(), st.aborted, active)
        };
        if !active {
            return;
        }
        // Rewind anchor: the entry id of this turn's user message.
        let list_cmd = match self.flavor {
            Flavor::Pi => "get_fork_messages",
            Flavor::Omp => "get_branch_messages",
        };
        let anchor = self.call(list_cmd, json!({})).await.ok().and_then(|d| {
            d.get("messages")
                .and_then(|m| m.as_array())
                .and_then(|a| a.last())
                .and_then(|m| m.get("entryId"))
                .and_then(|e| e.as_str())
                .map(str::to_string)
        });
        let anchors = crate::TurnAnchors { turn_id: anchor, previous_end: None };
        let ev = match (error, aborted) {
            (Some(e), _) => DriverEvent::TurnFailed { error: e },
            (None, true) => {
                DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, usage, cost_usd: Some(cost), duration_ms, anchors }
            }
            (None, false) => {
                DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, usage, cost_usd: Some(cost), duration_ms, anchors }
            }
        };
        self.emit(ev).await;
    }

    async fn handle_ui_request(self: &Arc<Self>, v: &Value) {
        let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
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
                self.pending_approvals.lock().await.insert(id.clone(), tool_name.clone());
                self.emit(DriverEvent::PermissionRequest {
                    request_id: id,
                    tool_call_id: None,
                    tool_name,
                    input: Value::Object(input),
                    summary,
                    suggestions: vec![],
                })
                .await;
            }
            "select" | "confirm" | "input" | "editor" => {
                self.pending_approvals.lock().await.insert(id.clone(), format!("ui_{method}"));
                self.emit(DriverEvent::PermissionRequest {
                    request_id: id.clone(),
                    tool_call_id: None,
                    tool_name: format!("ui_{method}"),
                    input: v.clone(),
                    summary: title,
                    suggestions: vec![],
                })
                .await;
                if let Some(timeout) = v.get("timeout").and_then(Value::as_u64) {
                    let weak = Arc::downgrade(self);
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(timeout)).await;
                        if let Some(session) = weak.upgrade()
                            && session.pending_approvals.lock().await.remove(&id).is_some()
                        {
                            session.emit(DriverEvent::PermissionWithdrawn { request_id: id }).await;
                        }
                    });
                }
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
    for part in &message.parts {
        match part {
            ContentPart::Text { text } => out.push_str(text),
            ContentPart::FileMention { path } => {
                out.push('@');
                out.push_str(path);
            }
            ContentPart::Skill { name, .. } => {
                out.push_str("/skill:");
                out.push_str(name);
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
    out
}

#[async_trait]
impl AgentSession for Handle {
    async fn send_message(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        let s = &self.0;
        {
            let mut st = s.state.lock().await;
            st.active = true;
            st.turn_started = Some(std::time::Instant::now());
            st.turn_usage = Usage::default();
            st.turn_cost = 0.0;
            st.turn_error = None;
            st.aborted = false;
        }
        let mut params = json!({ "message": prompt_text(message) });
        let imgs = images(message);
        if !imgs.is_empty() {
            params["images"] = Value::Array(imgs);
        }
        s.call("prompt", params).await.map(|_| ())
    }

    async fn interrupt(&self) -> Result<()> {
        self.0.call("abort", json!({})).await.map(|_| ())
    }

    async fn set_permission_mode(&self, _mode: PermissionMode) -> Result<()> {
        Err(DriverError::Unsupported("approval mode is fixed when the agent starts; start a new thread to change it".into()))
    }

    async fn set_model(&self, model: &str) -> Result<()> {
        let Some((provider, model_id)) = model.split_once('/') else {
            return Err(DriverError::Unsupported(format!("models are named provider/model, got {model}")));
        };
        self.0.call("set_model", json!({ "provider": provider, "modelId": model_id })).await.map(|_| ())
    }

    async fn set_effort(&self, effort: &str) -> Result<()> {
        if self.0.flavor != Flavor::Omp {
            return Err(DriverError::Unsupported("pi did not advertise an effort control".into()));
        }
        self.0.call("set_thinking_level", json!({ "level": effort })).await.map(|_| ())
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let Some(kind) = self.0.pending_approvals.lock().await.get(request_id).cloned() else {
            return Err(DriverError::Protocol(format!("no pending approval {request_id}")));
        };
        if kind.starts_with("ui_") {
            let mut response = match decision {
                ApprovalDecision::Submit { response } if response.is_object() => response.clone(),
                ApprovalDecision::Deny { .. } => json!({ "cancelled": true }),
                _ => return Err(DriverError::Protocol("this dialog needs an answer".into())),
            };
            response["type"] = json!("extension_ui_response");
            response["id"] = json!(request_id);
            self.0.child.write(&response).await?;
            self.0.pending_approvals.lock().await.remove(request_id);
            return Ok(());
        }
        let value = match decision {
            ApprovalDecision::Submit { .. } => return Err(DriverError::Protocol("expected permission decision".into())),
            ApprovalDecision::AllowOnce | ApprovalDecision::AllowAlways => "Approve",
            ApprovalDecision::Deny { .. } => "Deny",
        };
        self.0.child.write(&json!({ "type": "extension_ui_response", "id": request_id, "value": value })).await?;
        self.0.pending_approvals.lock().await.remove(request_id);
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        let _ = self.0.child.close_stdin().await;
        let child = self.0.child.clone();
        match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
            Ok(_) => {}
            Err(_) => child.kill().await,
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {

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
            });
            let handle = Handle(session.clone());
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
    fn parses_plain_pi_model_table() {
        let models = parse_pi_models(
            b"provider   model                 context  max-out  thinking  images\n\
              anthropic  claude-sonnet-4-5   200K     64K      yes       yes\n\
              openai     gpt-5.4              1M       128K     yes       no\n",
        );

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "anthropic/claude-sonnet-4-5");
        assert_eq!(models[0].provider.as_deref(), Some("anthropic"));
        assert_eq!(models[1].id, "openai/gpt-5.4");
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
        assert_eq!(prompt_text(&message), "Use /skill:review now");
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
    }
}
